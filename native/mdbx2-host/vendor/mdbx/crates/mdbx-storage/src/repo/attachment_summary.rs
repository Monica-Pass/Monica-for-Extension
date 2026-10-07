use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use mdbx_core::model::attachment::StorageMode;
use mdbx_core::model::{AttachmentSummary, AttachmentSummaryPage};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{
    bounded_optional_ciphertext, bounded_required_ciphertext, enforce_plaintext_length,
    max_field_ciphertext_bytes, MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES,
    MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES,
};
use crate::repo::attachment::{parse_storage_mode, AttachmentRepo};

/// Maximum number of payload-free attachment rows returned by one page.
pub const MAX_ATTACHMENT_SUMMARY_PAGE_SIZE: usize = 200;
pub const MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES: usize = 4096;

const ATTACHMENT_SUMMARY_CURSOR_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum AttachmentSummaryQuery {
    Project,
    Entry,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct AttachmentSummaryCursor {
    version: u8,
    query: AttachmentSummaryQuery,
    collection_id: Option<String>,
    object_id: Option<String>,
    updated_at: String,
    attachment_id: String,
}

#[derive(Debug)]
struct RawAttachmentSummary {
    attachment_id: String,
    collection_id: String,
    object_id: Option<String>,
    file_name_ciphertext_bytes: i64,
    file_name_ct: Option<Vec<u8>>,
    media_type_ciphertext_bytes: Option<i64>,
    media_type_ct: Option<Vec<u8>>,
    storage_mode: StorageMode,
    content_hash: String,
    original_size: u64,
    stored_size: u64,
    chunk_count: u32,
    head_commit_id: String,
    deleted: bool,
    updated_at: String,
}

/// Payload-free, bounded attachment metadata for Collection/Object navigation.
pub struct AttachmentSummaryRepo;

impl AttachmentSummaryRepo {
    /// Read one attachment's bounded metadata, including deleted rows.
    pub fn get(
        conn: &VaultConnection,
        attachment_id: &str,
    ) -> StorageResult<Option<AttachmentSummary>> {
        let raw = conn
            .inner()
            .query_row(
                "SELECT attachment_id, project_id, entry_id,
                        length(file_name_ct),
                        CASE WHEN length(file_name_ct) <= ?2 THEN file_name_ct END,
                        length(media_type_ct),
                        CASE WHEN media_type_ct IS NULL OR length(media_type_ct) <= ?3
                             THEN media_type_ct END,
                        storage_mode, content_hash, original_size, stored_size,
                        chunk_count, head_commit_id, deleted, updated_at
                 FROM attachments WHERE attachment_id = ?1",
                rusqlite::params![
                    attachment_id,
                    max_field_ciphertext_bytes(MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES) as i64,
                    max_field_ciphertext_bytes(MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES) as i64,
                ],
                read_raw_summary,
            )
            .optional()
            .map_err(StorageError::Database)?;
        raw.map(|row| decode_summary(conn, row)).transpose()
    }

    /// List active attachments owned by one Collection.
    pub fn list_by_collection(
        conn: &VaultConnection,
        collection_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<AttachmentSummaryPage> {
        Self::list(
            conn,
            AttachmentSummaryQuery::Project,
            Some(collection_id),
            None,
            page_size,
            cursor,
        )
    }

    /// List active attachments owned by one Object in one Collection.
    pub fn list_by_object(
        conn: &VaultConnection,
        collection_id: &str,
        object_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<AttachmentSummaryPage> {
        Self::list(
            conn,
            AttachmentSummaryQuery::Entry,
            Some(collection_id),
            Some(object_id),
            page_size,
            cursor,
        )
    }

    /// Compatibility spelling that mirrors the physical MDBX1 project table.
    pub fn list_by_project(
        conn: &VaultConnection,
        collection_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<AttachmentSummaryPage> {
        Self::list_by_collection(conn, collection_id, page_size, cursor)
    }

    /// Compatibility spelling that mirrors the physical MDBX1 entry table.
    pub fn list_by_entry(
        conn: &VaultConnection,
        collection_id: &str,
        object_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<AttachmentSummaryPage> {
        Self::list_by_object(conn, collection_id, object_id, page_size, cursor)
    }

    /// List deleted attachments using a globally scoped tombstone page.
    pub fn list_deleted(
        conn: &VaultConnection,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<AttachmentSummaryPage> {
        Self::list(
            conn,
            AttachmentSummaryQuery::Deleted,
            None,
            None,
            page_size,
            cursor,
        )
    }

    fn list(
        conn: &VaultConnection,
        query: AttachmentSummaryQuery,
        collection_id: Option<&str>,
        object_id: Option<&str>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<AttachmentSummaryPage> {
        validate_query_scope(query, collection_id, object_id)?;
        if page_size == 0 || page_size > MAX_ATTACHMENT_SUMMARY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "attachment summary page size must be between 1 and {MAX_ATTACHMENT_SUMMARY_PAGE_SIZE}"
            )));
        }
        let cursor = cursor
            .map(|value| parse_cursor(value, query, collection_id, object_id))
            .transpose()?;
        let deleted = matches!(query, AttachmentSummaryQuery::Deleted);
        let mut stmt = conn.inner().prepare(
            "SELECT attachment_id, project_id, entry_id,
                    length(file_name_ct),
                    CASE WHEN length(file_name_ct) <= ?4 THEN file_name_ct END,
                    length(media_type_ct),
                    CASE WHEN media_type_ct IS NULL OR length(media_type_ct) <= ?5
                         THEN media_type_ct END,
                    storage_mode, content_hash, original_size, stored_size,
                    chunk_count, head_commit_id, deleted, updated_at
             FROM attachments
             WHERE (?1 IS NULL OR project_id = ?1)
               AND (?2 IS NULL OR entry_id = ?2)
               AND deleted = ?3
               AND (?6 IS NULL OR updated_at < ?6
                    OR (updated_at = ?6 AND attachment_id < ?7))
             ORDER BY updated_at DESC, attachment_id DESC
             LIMIT ?8",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                collection_id,
                object_id,
                deleted as i32,
                max_field_ciphertext_bytes(MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES) as i64,
                max_field_ciphertext_bytes(MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES) as i64,
                cursor.as_ref().map(|value| value.updated_at.as_str()),
                cursor.as_ref().map(|value| value.attachment_id.as_str()),
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
                .map(|row| encode_cursor(row, query, collection_id, object_id))
                .transpose()?
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(|row| decode_summary(conn, row))
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(AttachmentSummaryPage { items, next_cursor })
    }
}

fn validate_query_scope(
    query: AttachmentSummaryQuery,
    collection_id: Option<&str>,
    object_id: Option<&str>,
) -> StorageResult<()> {
    let valid = match query {
        AttachmentSummaryQuery::Project => collection_id.is_some() && object_id.is_none(),
        AttachmentSummaryQuery::Entry => collection_id.is_some() && object_id.is_some(),
        AttachmentSummaryQuery::Deleted => collection_id.is_none() && object_id.is_none(),
    };
    if !valid || collection_id.is_some_and(str::is_empty) || object_id.is_some_and(str::is_empty) {
        return Err(StorageError::Validation(
            "attachment summary query scope is incomplete".to_string(),
        ));
    }
    Ok(())
}

fn read_raw_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawAttachmentSummary> {
    let storage_mode_value: String = row.get(7)?;
    let storage_mode = parse_storage_mode(7, &storage_mode_value)?;
    let original_size = read_u64(row, 9)?;
    let stored_size = read_u64(row, 10)?;
    let chunk_count = read_u32(row, 11)?;
    Ok(RawAttachmentSummary {
        attachment_id: row.get(0)?,
        collection_id: row.get(1)?,
        object_id: row.get(2)?,
        file_name_ciphertext_bytes: row.get(3)?,
        file_name_ct: row.get(4)?,
        media_type_ciphertext_bytes: row.get(5)?,
        media_type_ct: row.get(6)?,
        storage_mode,
        content_hash: row.get(8)?,
        original_size,
        stored_size,
        chunk_count,
        head_commit_id: row.get(12)?,
        deleted: row.get::<_, i32>(13)? != 0,
        updated_at: row.get(14)?,
    })
}

fn read_u64(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(row.get::<_, i64>(column)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, Box::new(error))
    })
}

fn read_u32(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u32> {
    u32::try_from(row.get::<_, i64>(column)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, Box::new(error))
    })
}

fn decode_summary(
    conn: &VaultConnection,
    row: RawAttachmentSummary,
) -> StorageResult<AttachmentSummary> {
    let file_name_ct = bounded_required_ciphertext(
        "attachment file name ciphertext bytes",
        row.file_name_ciphertext_bytes,
        row.file_name_ct,
        MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES,
    )?;
    let file_name = AttachmentRepo::decrypt_attachment_field(
        conn,
        &row.attachment_id,
        "file_name",
        &file_name_ct,
    )?;
    enforce_plaintext_length(
        "attachment file name plaintext bytes",
        file_name.len() as u64,
        MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES,
    )?;
    validate_utf8("attachment file name", &file_name)?;

    let media_type_ct = bounded_optional_ciphertext(
        "attachment media type ciphertext bytes",
        row.media_type_ciphertext_bytes,
        row.media_type_ct,
        MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES,
    )?;
    let media_type = media_type_ct
        .as_deref()
        .map(|ciphertext| {
            AttachmentRepo::decrypt_attachment_field(
                conn,
                &row.attachment_id,
                "media_type",
                ciphertext,
            )
        })
        .transpose()?;
    if let Some(media_type) = media_type.as_deref() {
        enforce_plaintext_length(
            "attachment media type plaintext bytes",
            media_type.len() as u64,
            MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES,
        )?;
        validate_utf8("attachment media type", media_type)?;
    }

    Ok(AttachmentSummary {
        attachment_id: row.attachment_id,
        collection_id: row.collection_id,
        object_id: row.object_id,
        file_name,
        media_type,
        storage_mode: row.storage_mode,
        content_hash: row.content_hash,
        original_size: row.original_size,
        stored_size: row.stored_size,
        chunk_count: row.chunk_count,
        head_commit_id: row.head_commit_id,
        deleted: row.deleted,
        updated_at: row.updated_at,
    })
}

fn validate_utf8(resource: &str, value: &[u8]) -> StorageResult<()> {
    std::str::from_utf8(value)
        .map(|_| ())
        .map_err(|error| StorageError::Validation(format!("{resource} is not UTF-8: {error}")))
}

fn encode_cursor(
    row: &RawAttachmentSummary,
    query: AttachmentSummaryQuery,
    collection_id: Option<&str>,
    object_id: Option<&str>,
) -> StorageResult<String> {
    let cursor = serde_json::to_string(&AttachmentSummaryCursor {
        version: ATTACHMENT_SUMMARY_CURSOR_VERSION,
        query,
        collection_id: collection_id.map(str::to_string),
        object_id: object_id.map(str::to_string),
        updated_at: row.updated_at.clone(),
        attachment_id: row.attachment_id.clone(),
    })
    .map_err(|error| StorageError::Validation(error.to_string()))?;
    if cursor.len() > MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::ResourceLimit {
            resource: "attachment summary cursor bytes".to_string(),
            actual: cursor.len() as u64,
            limit: MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES as u64,
        });
    }
    Ok(cursor)
}

fn parse_cursor(
    value: &str,
    query: AttachmentSummaryQuery,
    collection_id: Option<&str>,
    object_id: Option<&str>,
) -> StorageResult<AttachmentSummaryCursor> {
    if value.len() > MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::Validation(format!(
            "attachment summary cursor exceeds {MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES} bytes"
        )));
    }
    let cursor: AttachmentSummaryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid attachment summary cursor: {error}"))
    })?;
    if cursor.version != ATTACHMENT_SUMMARY_CURSOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported attachment summary cursor version {}",
            cursor.version
        )));
    }
    if cursor.query != query
        || cursor.collection_id.as_deref() != collection_id
        || cursor.object_id.as_deref() != object_id
    {
        return Err(StorageError::Validation(
            "attachment summary cursor does not match the requested query".to_string(),
        ));
    }
    if cursor.updated_at.is_empty() || cursor.attachment_id.is_empty() {
        return Err(StorageError::Validation(
            "attachment summary cursor position is incomplete".to_string(),
        ));
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{AttachmentRepo, CommitContext, EntryRepo, ProjectRepo};
    use mdbx_core::model::ObjectTypeId;

    fn setup() -> (VaultConnection, CommitContext, String, String) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("attachment-summary-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        let object = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            Some("Message"),
            &serde_json::json!({"body":"small"}),
        )
        .unwrap();
        (conn, ctx, project.project_id, object.entry_id)
    }

    fn add_attachment(
        conn: &VaultConnection,
        ctx: &CommitContext,
        collection_id: &str,
        object_id: Option<&str>,
        name: &str,
    ) -> String {
        AttachmentRepo::add(
            conn,
            ctx,
            collection_id,
            object_id,
            name,
            Some("application/octet-stream"),
            &"a".repeat(64),
            3,
        )
        .unwrap()
        .attachment_id
    }

    #[test]
    fn attachment_summary_pages_are_stable_scoped_and_chunk_free() {
        let (conn, ctx, collection_id, object_id) = setup();
        let mut expected = Vec::new();
        for index in 0..5 {
            expected.push(add_attachment(
                &conn,
                &ctx,
                &collection_id,
                Some(&object_id),
                &format!("message-{index}.eml"),
            ));
        }
        expected.sort_by(|left, right| right.cmp(left));
        conn.inner()
            .execute(
                "UPDATE attachments SET updated_at = '2026-07-25T00:00:00Z'",
                [],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = X'00' WHERE attachment_id = ?1",
                [&expected[0]],
            )
            .unwrap();

        let mut cursor = None;
        let mut actual = Vec::new();
        loop {
            let page =
                AttachmentSummaryRepo::list_by_project(&conn, &collection_id, 2, cursor.as_deref())
                    .unwrap();
            actual.extend(page.items.iter().map(|item| item.attachment_id.clone()));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual, expected);
        let object_page =
            AttachmentSummaryRepo::list_by_entry(&conn, &collection_id, &object_id, 10, None)
                .unwrap();
        assert_eq!(object_page.items.len(), 5);
        assert!(object_page
            .items
            .iter()
            .all(|item| item.object_id.as_deref() == Some(&object_id)));
    }

    #[test]
    fn attachment_summary_deleted_and_by_id_are_payload_free() {
        let (conn, ctx, collection_id, object_id) = setup();
        let active_id = add_attachment(&conn, &ctx, &collection_id, Some(&object_id), "active.bin");
        let deleted_id = add_attachment(&conn, &ctx, &collection_id, None, "deleted.bin");
        AttachmentRepo::soft_delete(&conn, &ctx, &deleted_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = X'00' WHERE attachment_id = ?1",
                [&deleted_id],
            )
            .unwrap();
        assert!(
            AttachmentSummaryRepo::list_by_project(&conn, &collection_id, 10, None)
                .unwrap()
                .items
                .iter()
                .all(|item| item.attachment_id == active_id)
        );
        let deleted = AttachmentSummaryRepo::list_deleted(&conn, 10, None).unwrap();
        assert_eq!(deleted.items.len(), 1);
        assert_eq!(deleted.items[0].attachment_id, deleted_id);
        assert!(deleted.items[0].deleted);
        assert_eq!(
            AttachmentSummaryRepo::get(&conn, &deleted_id)
                .unwrap()
                .unwrap()
                .file_name,
            b"deleted.bin"
        );
    }

    #[test]
    fn attachment_summary_bounds_ciphertext_plaintext_and_media_type() {
        let (conn, ctx, collection_id, object_id) = setup();
        let attachment_id =
            add_attachment(&conn, &ctx, &collection_id, Some(&object_id), "bounded.bin");
        let file_limit = max_field_ciphertext_bytes(MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES);
        conn.inner()
            .execute(
                "UPDATE attachments SET file_name_ct = zeroblob(?2) WHERE attachment_id = ?1",
                rusqlite::params![&attachment_id, (file_limit + 1) as i64],
            )
            .unwrap();
        let error = AttachmentSummaryRepo::get(&conn, &attachment_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit { ref resource, actual, limit }
                if resource == "attachment file name ciphertext bytes"
                    && actual == file_limit + 1
                    && limit == file_limit
        ));

        let file_name = vec![b'x'; MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES as usize + 1];
        let file_name_ct = AttachmentRepo::encrypt_attachment_field(
            &conn,
            &attachment_id,
            "file_name",
            &file_name,
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE attachments SET file_name_ct = ?2 WHERE attachment_id = ?1",
                rusqlite::params![&attachment_id, file_name_ct],
            )
            .unwrap();
        let error = AttachmentSummaryRepo::get(&conn, &attachment_id).unwrap_err();
        assert!(
            matches!(error, StorageError::ResourceLimit { ref resource, .. } if resource == "attachment file name plaintext bytes")
        );

        let media_limit = max_field_ciphertext_bytes(MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES);
        conn.inner()
            .execute(
                "UPDATE attachments SET file_name_ct = X'626f756e6465642e62696e', media_type_ct = zeroblob(?2) WHERE attachment_id = ?1",
                rusqlite::params![&attachment_id, (media_limit + 1) as i64],
            )
            .unwrap();
        let error = AttachmentSummaryRepo::get(&conn, &attachment_id).unwrap_err();
        assert!(
            matches!(error, StorageError::ResourceLimit { ref resource, .. } if resource == "attachment media type ciphertext bytes")
        );
    }

    #[test]
    fn attachment_summary_cursors_are_bounded_and_query_bound() {
        let (conn, ctx, collection_id, object_id) = setup();
        let other_collection = ProjectRepo::create(&conn, &ctx, "Other", None, None).unwrap();
        add_attachment(&conn, &ctx, &collection_id, Some(&object_id), "one.bin");
        add_attachment(&conn, &ctx, &collection_id, Some(&object_id), "two.bin");
        assert!(AttachmentSummaryRepo::list_by_project(&conn, &collection_id, 0, None).is_err());
        assert!(AttachmentSummaryRepo::list_by_project(
            &conn,
            &collection_id,
            MAX_ATTACHMENT_SUMMARY_PAGE_SIZE + 1,
            None,
        )
        .is_err());
        assert!(AttachmentSummaryRepo::list_by_project(
            &conn,
            &collection_id,
            1,
            Some(&"x".repeat(MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES + 1)),
        )
        .is_err());
        conn.inner()
            .execute(
                "UPDATE attachments SET updated_at = ?1",
                [&"t".repeat(MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES)],
            )
            .unwrap();
        assert!(matches!(
            AttachmentSummaryRepo::list_by_project(&conn, &collection_id, 1, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "attachment summary cursor bytes"
        ));
        conn.inner()
            .execute(
                "UPDATE attachments SET updated_at = '2026-07-25T00:00:00Z'",
                [],
            )
            .unwrap();
        let first = AttachmentSummaryRepo::list_by_project(&conn, &collection_id, 1, None).unwrap();
        let cursor = first.next_cursor.unwrap();
        assert!(AttachmentSummaryRepo::list_by_project(
            &conn,
            &other_collection.project_id,
            1,
            Some(&cursor),
        )
        .is_err());
        assert!(AttachmentSummaryRepo::list_by_entry(
            &conn,
            &collection_id,
            &object_id,
            1,
            Some(&cursor),
        )
        .is_err());
        assert!(AttachmentSummaryRepo::list_deleted(&conn, 1, Some(&cursor)).is_err());
    }
}
