use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use mdbx_core::model::{CollectionSummary, CollectionSummaryPage, CollectionTypeId};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{
    bounded_optional_text, bounded_required_ciphertext, enforce_plaintext_length,
    max_field_ciphertext_bytes, MAX_PRESENTATION_REFERENCE_BYTES, MAX_PRESENTATION_TITLE_BYTES,
};
use crate::repo::project::ProjectRepo;

/// Maximum number of payload-free collection rows returned by one page.
pub const MAX_COLLECTION_SUMMARY_PAGE_SIZE: usize = 200;

const COLLECTION_SUMMARY_CURSOR_VERSION: u8 = 1;
pub const MAX_COLLECTION_SUMMARY_CURSOR_BYTES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CollectionSummaryCursor {
    version: u8,
    deleted: bool,
    updated_at: String,
    collection_id: String,
}

#[derive(Debug)]
struct RawCollectionSummary {
    collection_id: String,
    title_ciphertext_bytes: i64,
    title_ct: Option<Vec<u8>>,
    collection_type_id: Option<String>,
    profile_schema_version: Option<u32>,
    group_bytes: Option<i64>,
    group_id: Option<String>,
    icon_bytes: Option<i64>,
    icon_ref: Option<String>,
    favorite: bool,
    archived: bool,
    attachment_count: u32,
    head_commit_id: String,
    deleted: bool,
    updated_at: String,
}

/// Payload-free, bounded collection metadata for navigation and adapter discovery.
pub struct CollectionSummaryRepo;

impl CollectionSummaryRepo {
    /// Read one collection's bounded presentation metadata, including tombstones.
    pub fn get(
        conn: &VaultConnection,
        collection_id: &str,
    ) -> StorageResult<Option<CollectionSummary>> {
        let raw = conn
            .inner()
            .query_row(
                &summary_select("WHERE p.project_id = ?1", ""),
                rusqlite::params![
                    collection_id,
                    max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) as i64,
                    MAX_PRESENTATION_REFERENCE_BYTES as i64,
                    MAX_PRESENTATION_REFERENCE_BYTES as i64,
                ],
                read_raw_summary,
            )
            .optional()
            .map_err(StorageError::Database)?;
        raw.map(|row| decode_summary(conn, row)).transpose()
    }

    /// List active (non-deleted) collections using a query-bound keyset cursor.
    pub fn list_active(
        conn: &VaultConnection,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<CollectionSummaryPage> {
        Self::list(conn, false, page_size, cursor)
    }

    /// List deleted collections using a query-bound keyset cursor.
    pub fn list_deleted(
        conn: &VaultConnection,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<CollectionSummaryPage> {
        Self::list(conn, true, page_size, cursor)
    }

    fn list(
        conn: &VaultConnection,
        deleted: bool,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<CollectionSummaryPage> {
        if page_size == 0 || page_size > MAX_COLLECTION_SUMMARY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "collection summary page size must be between 1 and {MAX_COLLECTION_SUMMARY_PAGE_SIZE}"
            )));
        }
        let cursor = cursor
            .map(|value| parse_cursor(value, deleted))
            .transpose()?;
        let sql = summary_select(
            "WHERE p.deleted = ?1
               AND (?5 IS NULL OR p.updated_at < ?5
                    OR (p.updated_at = ?5 AND p.project_id < ?6))",
            "ORDER BY p.updated_at DESC, p.project_id DESC
             LIMIT ?7",
        );
        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![
                deleted as i32,
                max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) as i64,
                MAX_PRESENTATION_REFERENCE_BYTES as i64,
                MAX_PRESENTATION_REFERENCE_BYTES as i64,
                cursor.as_ref().map(|value| value.updated_at.as_str()),
                cursor.as_ref().map(|value| value.collection_id.as_str()),
                (page_size + 1) as i64,
            ],
            read_raw_summary,
        )?;
        let mut raw_items = Vec::with_capacity(page_size + 1);
        for row in rows.take(page_size + 1) {
            raw_items.push(row?);
        }
        let has_next = raw_items.len() > page_size;
        if has_next {
            raw_items.pop();
        }
        let next_cursor = if has_next {
            raw_items.last().map(|row| {
                encode_cursor(row).expect("collection summary cursor serialization cannot fail")
            })
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(|row| decode_summary(conn, row))
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(CollectionSummaryPage { items, next_cursor })
    }
}

/// Build the shared projection used by `get` and both paginated list paths.
///
/// The encrypted title and plaintext references are guarded by `CASE` so an
/// oversized value is never materialized into Rust. Their unbounded SQLite
/// lengths remain available for the subsequent resource-limit decision.
fn summary_select(where_clause: &str, tail: &str) -> String {
    format!(
        "SELECT p.project_id, length(p.title_ct),
                CASE WHEN length(p.title_ct) <= ?2 THEN p.title_ct END,
                cp.collection_type_id, cp.payload_schema_version,
                length(CAST(p.group_id AS BLOB)),
                CASE WHEN p.group_id IS NULL OR length(CAST(p.group_id AS BLOB)) <= ?3
                     THEN p.group_id END,
                length(CAST(p.icon_ref AS BLOB)),
                CASE WHEN p.icon_ref IS NULL OR length(CAST(p.icon_ref AS BLOB)) <= ?4
                     THEN p.icon_ref END,
                p.favorite, p.archived, p.attachment_count,
                p.head_commit_id, p.deleted, p.updated_at
         FROM projects p
         LEFT JOIN collection_profiles cp ON cp.project_id = p.project_id
         {where_clause}
         {tail}",
    )
}

fn read_raw_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawCollectionSummary> {
    let profile_schema_version = row
        .get::<_, Option<i64>>(4)?
        .map(|value| {
            u32::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(4, Type::Integer, Box::new(error))
            })
        })
        .transpose()?;
    let attachment_count = u32::try_from(row.get::<_, i64>(11)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(11, Type::Integer, Box::new(error))
    })?;
    Ok(RawCollectionSummary {
        collection_id: row.get(0)?,
        title_ciphertext_bytes: row.get(1)?,
        title_ct: row.get(2)?,
        collection_type_id: row.get(3)?,
        profile_schema_version,
        group_bytes: row.get(5)?,
        group_id: row.get(6)?,
        icon_bytes: row.get(7)?,
        icon_ref: row.get(8)?,
        favorite: row.get::<_, i32>(9)? != 0,
        archived: row.get::<_, i32>(10)? != 0,
        attachment_count,
        head_commit_id: row.get(12)?,
        deleted: row.get::<_, i32>(13)? != 0,
        updated_at: row.get(14)?,
    })
}

fn decode_summary(
    conn: &VaultConnection,
    row: RawCollectionSummary,
) -> StorageResult<CollectionSummary> {
    let title_ct = bounded_required_ciphertext(
        "collection title ciphertext bytes",
        row.title_ciphertext_bytes,
        row.title_ct,
        MAX_PRESENTATION_TITLE_BYTES,
    )?;
    let title = ProjectRepo::decrypt_metadata(conn, &row.collection_id, "title", &title_ct)?;
    enforce_plaintext_length(
        "collection title plaintext bytes",
        title.len() as u64,
        MAX_PRESENTATION_TITLE_BYTES,
    )?;
    let group_id = bounded_optional_text(
        "collection group reference bytes",
        row.group_bytes,
        row.group_id,
        MAX_PRESENTATION_REFERENCE_BYTES,
    )?;
    let icon_ref = bounded_optional_text(
        "collection icon reference bytes",
        row.icon_bytes,
        row.icon_ref,
        MAX_PRESENTATION_REFERENCE_BYTES,
    )?;
    let collection_type_id = row
        .collection_type_id
        .map(|value| {
            value
                .parse::<CollectionTypeId>()
                .map_err(StorageError::Validation)
        })
        .transpose()?;
    Ok(CollectionSummary {
        collection_id: row.collection_id,
        title,
        collection_type_id,
        profile_schema_version: row.profile_schema_version,
        group_id,
        icon_ref,
        favorite: row.favorite,
        archived: row.archived,
        attachment_count: row.attachment_count,
        head_commit_id: row.head_commit_id,
        deleted: row.deleted,
        updated_at: row.updated_at,
    })
}

fn encode_cursor(row: &RawCollectionSummary) -> StorageResult<String> {
    serde_json::to_string(&CollectionSummaryCursor {
        version: COLLECTION_SUMMARY_CURSOR_VERSION,
        deleted: row.deleted,
        updated_at: row.updated_at.clone(),
        collection_id: row.collection_id.clone(),
    })
    .map_err(|error| StorageError::Validation(error.to_string()))
}

fn parse_cursor(value: &str, deleted: bool) -> StorageResult<CollectionSummaryCursor> {
    if value.len() > MAX_COLLECTION_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::Validation(format!(
            "collection summary cursor exceeds {MAX_COLLECTION_SUMMARY_CURSOR_BYTES} bytes"
        )));
    }
    let cursor: CollectionSummaryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid collection summary cursor: {error}"))
    })?;
    if cursor.version != COLLECTION_SUMMARY_CURSOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported collection summary cursor version {}",
            cursor.version
        )));
    }
    if cursor.deleted != deleted {
        return Err(StorageError::Validation(
            "collection summary cursor does not match the requested deleted state".to_string(),
        ));
    }
    if cursor.updated_at.is_empty() || cursor.collection_id.is_empty() {
        return Err(StorageError::Validation(
            "collection summary cursor position is incomplete".to_string(),
        ));
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CollectionProfileRepo, CollectionProfileSpec, CommitContext, ProjectRepo};
    use mdbx_core::model::{CollectionTypeId, ExtensionCapabilityId};

    fn setup() -> (VaultConnection, CommitContext, String, String) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("collection-summary-device".to_string());
        let first =
            ProjectRepo::create(&conn, &ctx, "First", Some("mail"), Some("mail-icon")).unwrap();
        let second = ProjectRepo::create(&conn, &ctx, "Second", None, None).unwrap();
        (conn, ctx, first.project_id, second.project_id)
    }

    #[test]
    fn collection_summary_pages_are_payload_free_stable_and_profile_aware() {
        let (mut conn, ctx, first_id, second_id) = setup();
        conn.set_extension_capabilities([
            ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
        ]);
        CollectionProfileRepo::set(
            &conn,
            &ctx,
            CollectionProfileSpec {
                collection_id: first_id.clone(),
                collection_type_id: CollectionTypeId::new("com.monica.mail").unwrap(),
                payload: b"secret profile payload".to_vec(),
                payload_schema_version: 4,
                allowed_object_type_ids: Vec::new(),
                required_capability_ids: vec![
                    ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
                ],
            },
        )
        .unwrap();
        let page = CollectionSummaryRepo::list_active(&conn, 1, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].collection_id, first_id);
        assert_eq!(page.items[0].title, b"First");
        assert_eq!(
            page.items[0].collection_type_id.as_ref().unwrap().as_str(),
            "com.monica.mail"
        );
        assert_eq!(page.items[0].profile_schema_version, Some(4));
        assert_eq!(page.items[0].group_id.as_deref(), Some("mail"));
        assert_eq!(page.items[0].icon_ref.as_deref(), Some("mail-icon"));
        let cursor = page.next_cursor;
        let next = CollectionSummaryRepo::list_active(&conn, 1, cursor.as_deref()).unwrap();
        assert_eq!(next.items.len(), 1);
        assert_eq!(next.items[0].collection_id, second_id);
        assert!(next.items[0].collection_type_id.is_none());
        assert!(next.items[0].profile_schema_version.is_none());
        conn.inner()
            .execute(
                "UPDATE collection_profiles SET payload_ct = X'00' WHERE project_id = ?1",
                [&first_id],
            )
            .unwrap();
        assert_eq!(
            CollectionSummaryRepo::get(&conn, &first_id)
                .unwrap()
                .unwrap()
                .title,
            b"First"
        );
    }

    #[test]
    fn collection_summary_deleted_and_cursor_state_are_separate() {
        let (conn, ctx, first_id, second_id) = setup();
        ProjectRepo::soft_delete(&conn, &ctx, &first_id).unwrap();
        assert!(CollectionSummaryRepo::list_active(&conn, 10, None)
            .unwrap()
            .items
            .iter()
            .all(|item| item.collection_id != first_id));
        let deleted = CollectionSummaryRepo::list_deleted(&conn, 10, None).unwrap();
        assert_eq!(deleted.items.len(), 1);
        assert!(deleted.items[0].deleted);
        let active = CollectionSummaryRepo::list_active(&conn, 1, None).unwrap();
        let cursor = active.next_cursor.unwrap_or_else(|| {
            serde_json::to_string(&CollectionSummaryCursor {
                version: COLLECTION_SUMMARY_CURSOR_VERSION,
                deleted: false,
                updated_at: active.items[0].updated_at.clone(),
                collection_id: second_id.clone(),
            })
            .unwrap()
        });
        assert!(CollectionSummaryRepo::list_deleted(&conn, 1, Some(&cursor)).is_err());
    }

    #[test]
    fn collection_summary_bounds_ciphertext_plaintext_and_references() {
        let (conn, _ctx, first_id, _) = setup();
        let original_title_ct: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT title_ct FROM projects WHERE project_id = ?1",
                [&first_id],
                |row| row.get(0),
            )
            .unwrap();
        let ciphertext_bytes = max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) + 1;
        conn.inner()
            .execute(
                "UPDATE projects SET title_ct = zeroblob(?2) WHERE project_id = ?1",
                rusqlite::params![&first_id, ciphertext_bytes as i64],
            )
            .unwrap();
        let error = CollectionSummaryRepo::get(&conn, &first_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit { ref resource, actual, limit }
                if resource == "collection title ciphertext bytes"
                    && actual == ciphertext_bytes
                    && limit == max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES)
        ));

        conn.inner()
            .execute(
                "UPDATE projects SET title_ct = ?2, group_id = ?3 WHERE project_id = ?1",
                rusqlite::params![
                    &first_id,
                    b"short-title".as_slice(),
                    "x".repeat(MAX_PRESENTATION_REFERENCE_BYTES as usize + 1)
                ],
            )
            .unwrap();
        let error = CollectionSummaryRepo::get(&conn, &first_id).unwrap_err();
        assert!(
            matches!(error, StorageError::ResourceLimit { ref resource, .. } if resource == "collection group reference bytes")
        );

        conn.inner()
            .execute(
                "UPDATE projects SET group_id = NULL, title_ct = ?2 WHERE project_id = ?1",
                rusqlite::params![&first_id, original_title_ct],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE projects SET group_id = ?2 WHERE project_id = ?1",
                rusqlite::params![&first_id, "\u{00e9}".repeat(2049)],
            )
            .unwrap();
        let error = CollectionSummaryRepo::get(&conn, &first_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit { ref resource, .. }
                if resource == "collection group reference bytes"
        ));
        conn.inner()
            .execute(
                "UPDATE projects SET group_id = NULL WHERE project_id = ?1",
                [&first_id],
            )
            .unwrap();
        let long_title = vec![b'x'; MAX_PRESENTATION_TITLE_BYTES as usize + 1];
        let title_ct = crate::crypto_layer::encrypt_field(
            &conn,
            crate::crypto_layer::FieldKeyPurpose::Metadata,
            &long_title,
            "project",
            &first_id,
            "title",
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE projects SET title_ct = ?2 WHERE project_id = ?1",
                rusqlite::params![&first_id, title_ct],
            )
            .unwrap();
        let error = CollectionSummaryRepo::get(&conn, &first_id).unwrap_err();
        assert!(
            matches!(error, StorageError::ResourceLimit { ref resource, .. } if resource == "collection title plaintext bytes")
        );
    }

    #[test]
    fn collection_summary_rejects_invalid_page_and_cursor() {
        let (conn, _ctx, _first_id, _second_id) = setup();
        assert!(CollectionSummaryRepo::list_active(&conn, 0, None).is_err());
        assert!(CollectionSummaryRepo::list_active(
            &conn,
            MAX_COLLECTION_SUMMARY_PAGE_SIZE + 1,
            None,
        )
        .is_err());
        assert!(CollectionSummaryRepo::list_active(
            &conn,
            1,
            Some(&"x".repeat(MAX_COLLECTION_SUMMARY_CURSOR_BYTES + 1)),
        )
        .is_err());
    }
}
