use serde::{Deserialize, Serialize};

use mdbx_core::model::{
    ConflictObjectType, ConflictResolution, ConflictSummary, ConflictSummaryPage,
};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{bounded_optional_text, enforce_plaintext_length};

/// Maximum number of unresolved conflict summaries returned by one page.
pub const MAX_CONFLICT_SUMMARY_PAGE_SIZE: usize = 200;
/// Maximum serialized size of an opaque conflict-summary cursor.
pub const MAX_CONFLICT_SUMMARY_CURSOR_BYTES: usize = 4096;
/// Maximum UTF-8 bytes of the stored conflicting-fields JSON projected to Rust.
pub const MAX_CONFLICT_SUMMARY_FIELDS_JSON_BYTES: usize = 64 * 1024;
/// Maximum number of field paths returned by one bounded summary.
pub const MAX_CONFLICT_SUMMARY_FIELD_COUNT: usize = 256;
/// Maximum UTF-8 bytes of one field path returned by a bounded summary.
pub const MAX_CONFLICT_SUMMARY_FIELD_BYTES: usize = 4096;

const CONFLICT_SUMMARY_CURSOR_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ConflictSummaryQuery {
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ConflictSummaryCursor {
    version: u8,
    query: ConflictSummaryQuery,
    object_type: Option<String>,
    created_at: String,
    conflict_id: String,
}

#[derive(Debug)]
struct RawConflictSummary {
    conflict_id: String,
    object_type: String,
    object_id: String,
    base_commit_id: String,
    local_commit_id: String,
    incoming_commit_id: String,
    conflicting_fields_bytes: i64,
    conflicting_fields_json: Option<String>,
    resolution: String,
    created_at: String,
    resolved_at: Option<String>,
}

/// Payload-free, bounded metadata for unresolved conflict navigation.
pub struct ConflictSummaryRepo;

impl ConflictSummaryRepo {
    /// List unresolved conflicts using an optional object-type filter and a
    /// query-bound descending keyset cursor.
    pub fn list_unresolved_summaries(
        conn: &VaultConnection,
        object_type: Option<&ConflictObjectType>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ConflictSummaryPage> {
        if page_size == 0 || page_size > MAX_CONFLICT_SUMMARY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "conflict summary page size must be between 1 and {MAX_CONFLICT_SUMMARY_PAGE_SIZE}"
            )));
        }

        let object_type_value = object_type.map(ToString::to_string);
        let cursor = cursor
            .map(|value| parse_cursor(value, object_type_value.as_deref()))
            .transpose()?;
        let object_type_filter = if object_type.is_some() {
            "AND object_type = ?1"
        } else {
            "AND ?1 IS NULL"
        };
        let sql = format!(
            "SELECT conflict_id, object_type, object_id,
                    base_commit_id, local_commit_id, incoming_commit_id,
                    length(CAST(conflicting_fields AS BLOB)),
                    CASE WHEN length(CAST(conflicting_fields AS BLOB)) <= ?4
                         THEN conflicting_fields END,
                    resolution, created_at, resolved_at
             FROM conflicts
             WHERE resolution = 'unresolved'
               {object_type_filter}
               AND (?2 IS NULL OR created_at < ?2
                    OR (created_at = ?2 AND conflict_id < ?3))
             ORDER BY created_at DESC, conflict_id DESC
             LIMIT ?5"
        );
        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![
                object_type_value.as_deref(),
                cursor.as_ref().map(|value| value.created_at.as_str()),
                cursor.as_ref().map(|value| value.conflict_id.as_str()),
                MAX_CONFLICT_SUMMARY_FIELDS_JSON_BYTES as i64,
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
                .map(|row| encode_cursor(row, object_type_value.as_deref()))
                .transpose()?
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(decode_summary)
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(ConflictSummaryPage { items, next_cursor })
    }
}

fn read_raw_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawConflictSummary> {
    Ok(RawConflictSummary {
        conflict_id: row.get(0)?,
        object_type: row.get(1)?,
        object_id: row.get(2)?,
        base_commit_id: row.get(3)?,
        local_commit_id: row.get(4)?,
        incoming_commit_id: row.get(5)?,
        conflicting_fields_bytes: row.get(6)?,
        conflicting_fields_json: row.get(7)?,
        resolution: row.get(8)?,
        created_at: row.get(9)?,
        resolved_at: row.get(10)?,
    })
}

fn decode_summary(row: RawConflictSummary) -> StorageResult<ConflictSummary> {
    let object_type = row
        .object_type
        .parse::<ConflictObjectType>()
        .map_err(StorageError::Validation)?;
    let resolution = row
        .resolution
        .parse::<ConflictResolution>()
        .map_err(StorageError::Validation)?;
    if resolution != ConflictResolution::Unresolved {
        return Err(StorageError::Validation(
            "bounded conflict query returned a resolved row".to_string(),
        ));
    }
    for (resource, value) in [
        ("conflict ID", row.conflict_id.as_str()),
        ("conflict object ID", row.object_id.as_str()),
        ("conflict base commit ID", row.base_commit_id.as_str()),
        ("conflict local commit ID", row.local_commit_id.as_str()),
        (
            "conflict incoming commit ID",
            row.incoming_commit_id.as_str(),
        ),
        ("conflict created-at position", row.created_at.as_str()),
    ] {
        if value.is_empty() {
            return Err(StorageError::Validation(format!("{resource} is empty")));
        }
    }

    let fields_json = bounded_optional_text(
        "conflicting fields JSON bytes",
        Some(row.conflicting_fields_bytes),
        row.conflicting_fields_json,
        MAX_CONFLICT_SUMMARY_FIELDS_JSON_BYTES as u64,
    )?
    .ok_or_else(|| StorageError::Validation("conflicting fields JSON is required".to_string()))?;
    let conflicting_fields: Vec<String> = serde_json::from_str(&fields_json).map_err(|error| {
        StorageError::Validation(format!("invalid conflicting fields JSON: {error}"))
    })?;
    if conflicting_fields.len() > MAX_CONFLICT_SUMMARY_FIELD_COUNT {
        return Err(StorageError::ResourceLimit {
            resource: "conflict field count".to_string(),
            actual: conflicting_fields.len() as u64,
            limit: MAX_CONFLICT_SUMMARY_FIELD_COUNT as u64,
        });
    }
    for field in &conflicting_fields {
        enforce_plaintext_length(
            "conflict field path bytes",
            field.len() as u64,
            MAX_CONFLICT_SUMMARY_FIELD_BYTES as u64,
        )?;
    }

    Ok(ConflictSummary {
        conflict_id: row.conflict_id,
        object_type,
        object_id: row.object_id,
        base_commit_id: row.base_commit_id,
        local_commit_id: row.local_commit_id,
        incoming_commit_id: row.incoming_commit_id,
        conflicting_fields,
        resolution,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
    })
}

fn encode_cursor(row: &RawConflictSummary, object_type: Option<&str>) -> StorageResult<String> {
    let cursor = serde_json::to_string(&ConflictSummaryCursor {
        version: CONFLICT_SUMMARY_CURSOR_VERSION,
        query: ConflictSummaryQuery::Unresolved,
        object_type: object_type.map(str::to_string),
        created_at: row.created_at.clone(),
        conflict_id: row.conflict_id.clone(),
    })
    .map_err(|error| StorageError::Validation(error.to_string()))?;
    if cursor.len() > MAX_CONFLICT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::ResourceLimit {
            resource: "conflict summary cursor bytes".to_string(),
            actual: cursor.len() as u64,
            limit: MAX_CONFLICT_SUMMARY_CURSOR_BYTES as u64,
        });
    }
    Ok(cursor)
}

fn parse_cursor(value: &str, object_type: Option<&str>) -> StorageResult<ConflictSummaryCursor> {
    if value.len() > MAX_CONFLICT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::Validation(format!(
            "conflict summary cursor exceeds {MAX_CONFLICT_SUMMARY_CURSOR_BYTES} bytes"
        )));
    }
    let cursor: ConflictSummaryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid conflict summary cursor: {error}"))
    })?;
    if cursor.version != CONFLICT_SUMMARY_CURSOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported conflict summary cursor version {}",
            cursor.version
        )));
    }
    if cursor.query != ConflictSummaryQuery::Unresolved
        || cursor.object_type.as_deref() != object_type
    {
        return Err(StorageError::Validation(
            "conflict summary cursor does not match the requested query and type".to_string(),
        ));
    }
    if cursor.created_at.is_empty() || cursor.conflict_id.is_empty() {
        return Err(StorageError::Validation(
            "conflict summary cursor position is incomplete".to_string(),
        ));
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ConflictRepo};

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        (
            conn,
            CommitContext::new("conflict-summary-device".to_string()),
        )
    }

    fn create_conflict(
        conn: &VaultConnection,
        ctx: &CommitContext,
        object_type: ConflictObjectType,
        index: usize,
    ) -> String {
        ConflictRepo::create(
            conn,
            ctx,
            object_type,
            &format!("object-{index}"),
            &format!("base-{index}"),
            &format!("local-{index}"),
            &format!("incoming-{index}"),
            &[format!("payload.field{index}")],
        )
        .unwrap()
        .conflict_id
    }

    #[test]
    fn conflict_summary_pages_are_bounded_stable_filtered_and_legacy_safe() {
        let (conn, ctx) = setup();
        let mut expected_ids = Vec::new();
        for index in 0..5 {
            expected_ids.push(create_conflict(
                &conn,
                &ctx,
                ConflictObjectType::Entry,
                index,
            ));
        }
        let resolved_id = create_conflict(&conn, &ctx, ConflictObjectType::Project, 99);
        conn.inner()
            .execute(
                "UPDATE conflicts SET resolution = 'local-wins', resolved_at = created_at
                 WHERE conflict_id = ?1",
                [&resolved_id],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE conflicts SET created_at = '2026-07-25T00:00:00Z'",
                [],
            )
            .unwrap();
        expected_ids.sort_by(|left, right| right.cmp(left));

        let entry_type = ConflictObjectType::Entry;
        let mut cursor = None;
        let mut actual_ids = Vec::new();
        loop {
            let page = ConflictSummaryRepo::list_unresolved_summaries(
                &conn,
                Some(&entry_type),
                2,
                cursor.as_deref(),
            )
            .unwrap();
            for item in &page.items {
                assert_eq!(item.object_type, ConflictObjectType::Entry);
                assert_eq!(item.resolution, ConflictResolution::Unresolved);
                assert_eq!(item.conflicting_fields.len(), 1);
                actual_ids.push(item.conflict_id.clone());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual_ids, expected_ids);
        let first_entry_page =
            ConflictSummaryRepo::list_unresolved_summaries(&conn, Some(&entry_type), 1, None)
                .unwrap();
        let entry_cursor = first_entry_page.next_cursor.unwrap();
        assert_eq!(
            ConflictSummaryRepo::list_unresolved_summaries(&conn, None, 10, None)
                .unwrap()
                .items
                .len(),
            5
        );

        assert!(ConflictRepo::list_unresolved(&conn).is_ok());
        assert!(ConflictSummaryRepo::list_unresolved_summaries(
            &conn,
            Some(&ConflictObjectType::Project),
            2,
            Some(&entry_cursor),
        )
        .is_err());
    }

    #[test]
    fn conflict_summary_rejects_malformed_and_oversized_fields_before_materialization() {
        let (conn, ctx) = setup();
        let conflict_id = create_conflict(&conn, &ctx, ConflictObjectType::Entry, 1);
        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = ?2 WHERE conflict_id = ?1",
                rusqlite::params![
                    &conflict_id,
                    "x".repeat(MAX_CONFLICT_SUMMARY_FIELDS_JSON_BYTES + 1)
                ],
            )
            .unwrap();
        assert!(matches!(
            ConflictSummaryRepo::list_unresolved_summaries(&conn, None, 10, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "conflicting fields JSON bytes"
        ));

        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = ?2 WHERE conflict_id = ?1",
                rusqlite::params![&conflict_id, "not-json"],
            )
            .unwrap();
        assert!(matches!(
            ConflictSummaryRepo::list_unresolved_summaries(&conn, None, 10, None),
            Err(StorageError::Validation(ref message))
                if message.contains("invalid conflicting fields JSON")
        ));
    }

    #[test]
    fn conflict_summary_enforces_field_count_path_and_cursor_limits() {
        let (conn, ctx) = setup();
        let conflict_id = create_conflict(&conn, &ctx, ConflictObjectType::Entry, 2);
        let second_conflict_id = create_conflict(&conn, &ctx, ConflictObjectType::Entry, 3);
        let too_many = serde_json::to_string(
            &(0..=MAX_CONFLICT_SUMMARY_FIELD_COUNT)
                .map(|index| format!("field-{index}"))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = ?2 WHERE conflict_id = ?1",
                rusqlite::params![&conflict_id, too_many],
            )
            .unwrap();
        assert!(matches!(
            ConflictSummaryRepo::list_unresolved_summaries(&conn, None, 10, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "conflict field count"
        ));

        let too_long =
            serde_json::to_string(&vec!["x".repeat(MAX_CONFLICT_SUMMARY_FIELD_BYTES + 1)]).unwrap();
        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = ?2 WHERE conflict_id = ?1",
                rusqlite::params![&conflict_id, too_long],
            )
            .unwrap();
        assert!(matches!(
            ConflictSummaryRepo::list_unresolved_summaries(&conn, None, 10, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "conflict field path bytes"
        ));

        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = '[\"field\"]', created_at = ?1
                 WHERE conflict_id IN (?2, ?3)",
                rusqlite::params![
                    "t".repeat(MAX_CONFLICT_SUMMARY_CURSOR_BYTES),
                    &conflict_id,
                    &second_conflict_id
                ],
            )
            .unwrap();
        assert!(matches!(
            ConflictSummaryRepo::list_unresolved_summaries(&conn, None, 1, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "conflict summary cursor bytes"
        ));
        assert!(ConflictSummaryRepo::list_unresolved_summaries(
            &conn,
            None,
            1,
            Some(&"x".repeat(MAX_CONFLICT_SUMMARY_CURSOR_BYTES + 1)),
        )
        .is_err());
    }
}
