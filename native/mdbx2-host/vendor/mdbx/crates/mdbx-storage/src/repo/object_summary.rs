use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use mdbx_core::model::{ObjectSummary, ObjectSummaryPage, ObjectTypeId};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{
    bounded_optional_ciphertext, enforce_plaintext_length, max_field_ciphertext_bytes,
    MAX_PRESENTATION_TITLE_BYTES,
};
use crate::repo::entry::EntryRepo;

pub const MAX_OBJECT_SUMMARY_PAGE_SIZE: usize = 200;
pub const MAX_OBJECT_SUMMARY_CURSOR_BYTES: usize = 4096;

const OBJECT_SUMMARY_CURSOR_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ObjectSummaryQuery {
    CollectionActive,
    CollectionDeleted,
    AllDeleted,
}

impl Default for ObjectSummaryQuery {
    fn default() -> Self {
        Self::CollectionActive
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ObjectSummaryCursor {
    version: u8,
    /// Omitted by cursors produced by the first object-summary release. Those
    /// cursors are interpreted as collection-scoped active queries.
    #[serde(default)]
    query: ObjectSummaryQuery,
    collection_id: Option<String>,
    object_type_id: Option<String>,
    updated_at: String,
    object_id: String,
}

#[derive(Debug)]
struct RawObjectSummary {
    object_id: String,
    collection_id: String,
    object_type_id: String,
    title_ciphertext_bytes: Option<i64>,
    title_ct: Option<Vec<u8>>,
    payload_schema_version: u32,
    head_commit_id: String,
    deleted: bool,
    updated_at: String,
}

/// 通用对象的有界元数据分页查询。
pub struct ObjectSummaryRepo;

impl ObjectSummaryRepo {
    /// Read one object's display metadata without touching its encrypted payload.
    ///
    /// Deleted objects remain visible so callers can render tombstone state without
    /// falling back to the plaintext-bearing legacy entry read API.
    pub fn get(conn: &VaultConnection, object_id: &str) -> StorageResult<Option<ObjectSummary>> {
        let raw = conn
            .inner()
            .query_row(
                "SELECT entry_id, project_id, entry_type, length(title_ct),
                        CASE WHEN title_ct IS NULL OR length(title_ct) <= ?2
                             THEN title_ct END,
                        payload_schema_version, head_commit_id, deleted, updated_at
                 FROM entries WHERE entry_id = ?1",
                rusqlite::params![
                    object_id,
                    max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) as i64,
                ],
                read_raw_summary,
            )
            .optional()
            .map_err(StorageError::Database)?;
        raw.map(|row| decode_summary(conn, row)).transpose()
    }

    pub fn list(
        conn: &VaultConnection,
        collection_id: &str,
        object_type_id: Option<&ObjectTypeId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectSummaryPage> {
        Self::list_scoped(
            conn,
            ObjectSummaryQuery::CollectionActive,
            Some(collection_id),
            object_type_id,
            page_size,
            cursor,
        )
    }

    /// List deleted objects owned by one Collection without reading payloads.
    pub fn list_deleted_by_collection(
        conn: &VaultConnection,
        collection_id: &str,
        object_type_id: Option<&ObjectTypeId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectSummaryPage> {
        Self::list_scoped(
            conn,
            ObjectSummaryQuery::CollectionDeleted,
            Some(collection_id),
            object_type_id,
            page_size,
            cursor,
        )
    }

    /// List all deleted objects using a globally scoped tombstone cursor.
    pub fn list_deleted_all(
        conn: &VaultConnection,
        object_type_id: Option<&ObjectTypeId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectSummaryPage> {
        Self::list_scoped(
            conn,
            ObjectSummaryQuery::AllDeleted,
            None,
            object_type_id,
            page_size,
            cursor,
        )
    }

    fn list_scoped(
        conn: &VaultConnection,
        query: ObjectSummaryQuery,
        collection_id: Option<&str>,
        object_type_id: Option<&ObjectTypeId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectSummaryPage> {
        if page_size == 0 || page_size > MAX_OBJECT_SUMMARY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "object summary page size must be between 1 and {MAX_OBJECT_SUMMARY_PAGE_SIZE}"
            )));
        }
        let object_type_value = object_type_id.map(ObjectTypeId::as_str);
        let cursor = cursor
            .map(|value| parse_cursor(value, query, collection_id, object_type_value))
            .transpose()?;
        let deleted = !matches!(query, ObjectSummaryQuery::CollectionActive);
        let collection_filter = if collection_id.is_some() {
            "AND project_id = ?2"
        } else {
            "AND ?2 IS NULL"
        };
        let sql = format!(
            "SELECT entry_id, project_id, entry_type, length(title_ct),
                    CASE WHEN title_ct IS NULL OR length(title_ct) <= ?6
                         THEN title_ct END,
                    payload_schema_version, head_commit_id, deleted, updated_at
             FROM entries
             WHERE deleted = ?1
               {collection_filter}
               AND (?3 IS NULL OR entry_type = ?3)
               AND (?4 IS NULL OR updated_at < ?4
                    OR (updated_at = ?4 AND entry_id < ?5))
             ORDER BY updated_at DESC, entry_id DESC
             LIMIT ?7"
        );
        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![
                deleted as i32,
                collection_id,
                object_type_value,
                cursor.as_ref().map(|cursor| cursor.updated_at.as_str()),
                cursor.as_ref().map(|cursor| cursor.object_id.as_str()),
                max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) as i64,
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
            raw_items
                .last()
                .map(|row| encode_cursor(row, query, collection_id, object_type_value))
                .transpose()?
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(|row| decode_summary(conn, row))
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(ObjectSummaryPage { items, next_cursor })
    }
}

fn read_raw_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawObjectSummary> {
    let payload_schema_version = row.get::<_, i64>(5)?;
    Ok(RawObjectSummary {
        object_id: row.get(0)?,
        collection_id: row.get(1)?,
        object_type_id: row.get(2)?,
        title_ciphertext_bytes: row.get(3)?,
        title_ct: row.get(4)?,
        payload_schema_version: u32::try_from(payload_schema_version).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(5, Type::Integer, Box::new(error))
        })?,
        head_commit_id: row.get(6)?,
        deleted: row.get::<_, i32>(7)? != 0,
        updated_at: row.get(8)?,
    })
}

fn decode_summary(conn: &VaultConnection, row: RawObjectSummary) -> StorageResult<ObjectSummary> {
    let object_type_id = row
        .object_type_id
        .parse::<ObjectTypeId>()
        .map_err(StorageError::Validation)?;
    let title_ct = bounded_optional_ciphertext(
        "object title ciphertext bytes",
        row.title_ciphertext_bytes,
        row.title_ct,
        MAX_PRESENTATION_TITLE_BYTES,
    )?;
    let title = title_ct
        .as_deref()
        .map(|ciphertext| EntryRepo::decrypt_metadata(conn, &row.object_id, "title", ciphertext))
        .transpose()?;
    if let Some(title) = title.as_deref() {
        enforce_plaintext_length(
            "object title plaintext bytes",
            title.len() as u64,
            MAX_PRESENTATION_TITLE_BYTES,
        )?;
    }
    Ok(ObjectSummary {
        object_id: row.object_id,
        collection_id: row.collection_id,
        object_type_id,
        title,
        payload_schema_version: row.payload_schema_version,
        head_commit_id: row.head_commit_id,
        deleted: row.deleted,
        updated_at: row.updated_at,
    })
}

fn encode_cursor(
    row: &RawObjectSummary,
    query: ObjectSummaryQuery,
    collection_id: Option<&str>,
    object_type_id: Option<&str>,
) -> StorageResult<String> {
    let cursor = serde_json::to_string(&ObjectSummaryCursor {
        version: OBJECT_SUMMARY_CURSOR_VERSION,
        query,
        collection_id: collection_id.map(str::to_string),
        object_type_id: object_type_id.map(str::to_string),
        updated_at: row.updated_at.clone(),
        object_id: row.object_id.clone(),
    })
    .map_err(|error| StorageError::Validation(error.to_string()))?;
    if cursor.len() > MAX_OBJECT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::ResourceLimit {
            resource: "object summary cursor bytes".to_string(),
            actual: cursor.len() as u64,
            limit: MAX_OBJECT_SUMMARY_CURSOR_BYTES as u64,
        });
    }
    Ok(cursor)
}

fn parse_cursor(
    value: &str,
    query: ObjectSummaryQuery,
    collection_id: Option<&str>,
    object_type_id: Option<&str>,
) -> StorageResult<ObjectSummaryCursor> {
    if value.len() > MAX_OBJECT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::Validation(format!(
            "object summary cursor exceeds {MAX_OBJECT_SUMMARY_CURSOR_BYTES} bytes"
        )));
    }
    let cursor: ObjectSummaryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid object summary cursor: {error}"))
    })?;
    if cursor.version != OBJECT_SUMMARY_CURSOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported object summary cursor version {}",
            cursor.version
        )));
    }
    if cursor.query != query
        || cursor.collection_id.as_deref() != collection_id
        || cursor.object_type_id.as_deref() != object_type_id
    {
        return Err(StorageError::Validation(
            "object summary cursor does not match the requested query, collection, and type"
                .to_string(),
        ));
    }
    if cursor.updated_at.is_empty() || cursor.object_id.is_empty() {
        return Err(StorageError::Validation(
            "object summary cursor position is incomplete".to_string(),
        ));
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, EntryRepo, ProjectRepo};
    use crate::unlock::UnlockService;

    fn setup() -> (VaultConnection, CommitContext, String, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, "object summary password").unwrap();
        let ctx = CommitContext::new("summary-device".to_string());
        let first = ProjectRepo::create(&conn, &ctx, "First", None, None).unwrap();
        let second = ProjectRepo::create(&conn, &ctx, "Second", None, None).unwrap();
        (conn, ctx, first.project_id, second.project_id)
    }

    #[test]
    fn object_summary_pages_are_stable_filtered_and_payload_free() {
        let (conn, ctx, collection_id, other_collection_id) = setup();
        let custom_type = ObjectTypeId::custom("com.monica.mail.message").unwrap();
        let mut expected_ids = Vec::new();
        for index in 0..5 {
            let object = EntryRepo::create_with_payload_schema_version(
                &conn,
                &ctx,
                &collection_id,
                custom_type.clone(),
                Some(&format!("Message {index}")),
                &serde_json::json!({"body": format!("secret body {index}")}),
                3,
            )
            .unwrap();
            expected_ids.push(object.entry_id);
        }
        EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some("Login"),
            &serde_json::json!({"password": "secret"}),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &other_collection_id,
            custom_type.clone(),
            Some("Other"),
            &serde_json::json!({"body": "other"}),
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET updated_at = '2026-07-20T00:00:00Z'
                 WHERE project_id = ?1 AND entry_type = ?2",
                rusqlite::params![collection_id, custom_type.as_str()],
            )
            .unwrap();
        expected_ids.sort_by(|left, right| right.cmp(left));

        let mut cursor = None;
        let mut actual_ids = Vec::new();
        loop {
            let page = ObjectSummaryRepo::list(
                &conn,
                &collection_id,
                Some(&custom_type),
                2,
                cursor.as_deref(),
            )
            .unwrap();
            for item in &page.items {
                assert_eq!(item.collection_id, collection_id);
                assert_eq!(item.object_type_id, custom_type);
                assert_eq!(item.payload_schema_version, 3);
                assert!(!item.deleted);
                actual_ids.push(item.object_id.clone());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual_ids, expected_ids);
    }

    #[test]
    fn deleted_object_summary_pages_are_scoped_stable_and_payload_free() {
        let (conn, ctx, collection_id, other_collection_id) = setup();
        let custom_type = ObjectTypeId::custom("com.monica.mail.message").unwrap();
        let mut expected_collection_ids = Vec::new();
        for index in 0..5 {
            let object = EntryRepo::create_with_payload_schema_version(
                &conn,
                &ctx,
                &collection_id,
                custom_type.clone(),
                Some(&format!("Deleted {index}")),
                &serde_json::json!({"body": format!("secret {index}")}),
                7,
            )
            .unwrap();
            EntryRepo::soft_delete(&conn, &ctx, &object.entry_id).unwrap();
            conn.inner()
                .execute(
                    "UPDATE entries SET payload_ct = X'00', updated_at = '2026-07-25T00:00:00Z'
                     WHERE entry_id = ?1",
                    [&object.entry_id],
                )
                .unwrap();
            expected_collection_ids.push(object.entry_id);
        }
        let other = EntryRepo::create_with_payload_schema_version(
            &conn,
            &ctx,
            &other_collection_id,
            custom_type.clone(),
            Some("Other deleted"),
            &serde_json::json!({"body": "other secret"}),
            8,
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &other.entry_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00', updated_at = '2026-07-25T00:00:00Z'
                 WHERE entry_id = ?1",
                [&other.entry_id],
            )
            .unwrap();
        expected_collection_ids.sort_by(|left, right| right.cmp(left));

        let mut cursor = None;
        let mut actual_collection_ids = Vec::new();
        loop {
            let page = ObjectSummaryRepo::list_deleted_by_collection(
                &conn,
                &collection_id,
                Some(&custom_type),
                2,
                cursor.as_deref(),
            )
            .unwrap();
            for item in &page.items {
                assert_eq!(item.collection_id, collection_id);
                assert_eq!(item.object_type_id, custom_type);
                assert_eq!(item.payload_schema_version, 7);
                assert!(item.deleted);
                actual_collection_ids.push(item.object_id.clone());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual_collection_ids, expected_collection_ids);

        let mut global_cursor = None;
        let mut global_count = 0;
        loop {
            let page = ObjectSummaryRepo::list_deleted_all(
                &conn,
                Some(&custom_type),
                2,
                global_cursor.as_deref(),
            )
            .unwrap();
            for item in &page.items {
                assert!(item.deleted);
                assert_eq!(item.object_type_id, custom_type);
                assert!(item.title.is_some());
                global_count += 1;
            }
            match page.next_cursor {
                Some(next) => global_cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(global_count, 6);

        let deleted_cursor =
            ObjectSummaryRepo::list_deleted_all(&conn, Some(&custom_type), 1, None)
                .unwrap()
                .next_cursor
                .unwrap();
        assert!(ObjectSummaryRepo::list(
            &conn,
            &collection_id,
            Some(&custom_type),
            1,
            Some(&deleted_cursor),
        )
        .is_err());
        assert!(ObjectSummaryRepo::list_deleted_by_collection(
            &conn,
            &other_collection_id,
            Some(&custom_type),
            1,
            Some(&deleted_cursor),
        )
        .is_err());
        let login = ObjectTypeId::Login;
        assert!(
            ObjectSummaryRepo::list_deleted_all(&conn, Some(&login), 1, Some(&deleted_cursor),)
                .is_err()
        );
    }

    #[test]
    fn object_summary_does_not_read_corrupted_payload_ciphertext() {
        let (conn, ctx, collection_id, _) = setup();
        let object = EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some("Visible title"),
            &serde_json::json!({"password": "secret"}),
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                [&object.entry_id],
            )
            .unwrap();

        let page = ObjectSummaryRepo::list(&conn, &collection_id, None, 10, None).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(
            page.items[0].title.as_deref(),
            Some(b"Visible title".as_slice())
        );
        assert!(EntryRepo::get_by_id(&conn, &object.entry_id).is_err());
    }

    #[test]
    fn object_summary_get_is_metadata_only_and_includes_deleted_objects() {
        let (conn, ctx, collection_id, _) = setup();
        let object = EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some("Deleted title"),
            &serde_json::json!({"password": "secret"}),
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &object.entry_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                [&object.entry_id],
            )
            .unwrap();

        let summary = ObjectSummaryRepo::get(&conn, &object.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(summary.object_id, object.entry_id);
        assert_eq!(summary.collection_id, collection_id);
        assert_eq!(summary.title.as_deref(), Some(b"Deleted title".as_slice()));
        assert!(summary.deleted);
        assert!(EntryRepo::get_by_id(&conn, &summary.object_id).is_err());
    }

    #[test]
    fn presentation_object_summary_bounds_title_ciphertext_and_plaintext() {
        let (conn, ctx, collection_id, _) = setup();
        let oversized_ciphertext = EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some("Oversized ciphertext"),
            &serde_json::json!({"password":"secret"}),
        )
        .unwrap();
        let ciphertext_bytes = max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) + 1;
        conn.inner()
            .execute(
                "UPDATE entries SET title_ct = zeroblob(?2) WHERE entry_id = ?1",
                rusqlite::params![&oversized_ciphertext.entry_id, ciphertext_bytes as i64],
            )
            .unwrap();

        let error = ObjectSummaryRepo::get(&conn, &oversized_ciphertext.entry_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object title ciphertext bytes"
                && actual == ciphertext_bytes
                && limit == max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES)
        ));
        assert!(matches!(
            ObjectSummaryRepo::list(&conn, &collection_id, None, 10, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "object title ciphertext bytes"
        ));

        let long_title = "x".repeat(MAX_PRESENTATION_TITLE_BYTES as usize + 1);
        let oversized_plaintext = EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some(&long_title),
            &serde_json::json!({"password":"secret"}),
        )
        .unwrap();
        let error = ObjectSummaryRepo::get(&conn, &oversized_plaintext.entry_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object title plaintext bytes"
                && actual == MAX_PRESENTATION_TITLE_BYTES + 1
                && limit == MAX_PRESENTATION_TITLE_BYTES
        ));
    }

    #[test]
    fn object_summary_cursor_is_bounded_and_query_bound() {
        let (conn, ctx, collection_id, other_collection_id) = setup();
        for title in ["A", "B"] {
            EntryRepo::create(
                &conn,
                &ctx,
                &collection_id,
                ObjectTypeId::Login,
                Some(title),
                &serde_json::json!({}),
            )
            .unwrap();
        }
        assert!(ObjectSummaryRepo::list(&conn, &collection_id, None, 0, None).is_err());
        assert!(ObjectSummaryRepo::list(
            &conn,
            &collection_id,
            None,
            MAX_OBJECT_SUMMARY_PAGE_SIZE + 1,
            None,
        )
        .is_err());
        assert!(ObjectSummaryRepo::list(
            &conn,
            &collection_id,
            None,
            1,
            Some(&"x".repeat(MAX_OBJECT_SUMMARY_CURSOR_BYTES + 1)),
        )
        .is_err());
        let first = ObjectSummaryRepo::list(&conn, &collection_id, None, 1, None).unwrap();
        let cursor = first.next_cursor.unwrap();
        let error = ObjectSummaryRepo::list(&conn, &other_collection_id, None, 1, Some(&cursor))
            .unwrap_err();
        assert!(error.to_string().contains("does not match"));
        let login = ObjectTypeId::Login;
        let error = ObjectSummaryRepo::list(&conn, &collection_id, Some(&login), 1, Some(&cursor))
            .unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn object_summary_generated_cursor_overflow_is_an_error_not_a_panic() {
        let (conn, ctx, collection_id, _) = setup();
        for title in ["A", "B"] {
            EntryRepo::create(
                &conn,
                &ctx,
                &collection_id,
                ObjectTypeId::Login,
                Some(title),
                &serde_json::json!({}),
            )
            .unwrap();
        }
        conn.inner()
            .execute(
                "UPDATE entries SET updated_at = ?1 WHERE project_id = ?2",
                rusqlite::params!["t".repeat(MAX_OBJECT_SUMMARY_CURSOR_BYTES), &collection_id],
            )
            .unwrap();
        assert!(matches!(
            ObjectSummaryRepo::list(&conn, &collection_id, None, 1, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "object summary cursor bytes"
        ));
    }

    #[test]
    fn object_summary_accepts_legacy_active_cursor_shape() {
        let (conn, ctx, collection_id, _) = setup();
        for title in ["A", "B"] {
            EntryRepo::create(
                &conn,
                &ctx,
                &collection_id,
                ObjectTypeId::Login,
                Some(title),
                &serde_json::json!({}),
            )
            .unwrap();
        }
        let first = ObjectSummaryRepo::list(&conn, &collection_id, None, 1, None).unwrap();
        let item = &first.items[0];
        let legacy_cursor = serde_json::json!({
            "version": OBJECT_SUMMARY_CURSOR_VERSION,
            "collection_id": collection_id,
            "object_type_id": null,
            "updated_at": item.updated_at,
            "object_id": item.object_id,
        })
        .to_string();
        let page = ObjectSummaryRepo::list(&conn, &collection_id, None, 1, Some(&legacy_cursor));
        assert!(page.is_ok());
    }
}
