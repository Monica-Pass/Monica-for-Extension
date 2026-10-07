use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use mdbx_core::model::{SnapshotSummary, SnapshotSummaryPage};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::bounded_optional_text;

/// Maximum number of payload-free snapshot summaries returned by one page.
pub const MAX_SNAPSHOT_SUMMARY_PAGE_SIZE: usize = 200;
/// Maximum serialized size of an opaque snapshot-summary cursor.
pub const MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES: usize = 4096;
/// Maximum UTF-8 bytes of each required snapshot metadata text field.
pub const MAX_SNAPSHOT_SUMMARY_TEXT_BYTES: usize = 4096;

const SNAPSHOT_SUMMARY_CURSOR_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum SnapshotSummaryQuery {
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SnapshotSummaryCursor {
    version: u8,
    query: SnapshotSummaryQuery,
    created_at: String,
    snapshot_id: String,
}

#[derive(Debug)]
struct RawSnapshotSummary {
    snapshot_id_bytes: i64,
    snapshot_id: Option<String>,
    base_commit_id_bytes: i64,
    base_commit_id: Option<String>,
    snapshot_hash_bytes: i64,
    snapshot_hash: Option<String>,
    snapshot_ciphertext_bytes: i64,
    created_at_bytes: i64,
    created_at: Option<String>,
    created_by_device_id_bytes: i64,
    created_by_device_id: Option<String>,
}

/// Payload-free, bounded snapshot metadata for management navigation.
pub struct SnapshotSummaryRepo;

impl SnapshotSummaryRepo {
    /// Read one snapshot's metadata without selecting or verifying its payload.
    pub fn get(
        conn: &VaultConnection,
        snapshot_id: &str,
    ) -> StorageResult<Option<SnapshotSummary>> {
        let raw = conn
            .inner()
            .query_row(
                "SELECT length(CAST(snapshot_id AS BLOB)),
                        CASE WHEN length(CAST(snapshot_id AS BLOB)) <= ?2
                             THEN snapshot_id END,
                        length(CAST(base_commit_id AS BLOB)),
                        CASE WHEN length(CAST(base_commit_id AS BLOB)) <= ?2
                             THEN base_commit_id END,
                        length(CAST(snapshot_hash AS BLOB)),
                        CASE WHEN length(CAST(snapshot_hash AS BLOB)) <= ?2
                             THEN snapshot_hash END,
                        length(CAST(snapshot_ct AS BLOB)),
                        length(CAST(created_at AS BLOB)),
                        CASE WHEN length(CAST(created_at AS BLOB)) <= ?2
                             THEN created_at END,
                        length(CAST(created_by_device_id AS BLOB)),
                        CASE WHEN length(CAST(created_by_device_id AS BLOB)) <= ?2
                             THEN created_by_device_id END
                 FROM snapshots WHERE snapshot_id = ?1",
                rusqlite::params![snapshot_id, MAX_SNAPSHOT_SUMMARY_TEXT_BYTES as i64],
                read_raw_summary,
            )
            .optional()
            .map_err(StorageError::Database)?;
        raw.map(decode_summary).transpose()
    }

    /// List snapshots using a descending keyset cursor without selecting
    /// `snapshot_ct` or attempting payload decryption/deserialization.
    pub fn list(
        conn: &VaultConnection,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<SnapshotSummaryPage> {
        if page_size == 0 || page_size > MAX_SNAPSHOT_SUMMARY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "snapshot summary page size must be between 1 and {MAX_SNAPSHOT_SUMMARY_PAGE_SIZE}"
            )));
        }
        let cursor = cursor.map(parse_cursor).transpose()?;
        let mut stmt = conn.inner().prepare(
            "SELECT length(CAST(snapshot_id AS BLOB)),
                    CASE WHEN length(CAST(snapshot_id AS BLOB)) <= ?1
                         THEN snapshot_id END,
                    length(CAST(base_commit_id AS BLOB)),
                    CASE WHEN length(CAST(base_commit_id AS BLOB)) <= ?1
                         THEN base_commit_id END,
                    length(CAST(snapshot_hash AS BLOB)),
                    CASE WHEN length(CAST(snapshot_hash AS BLOB)) <= ?1
                         THEN snapshot_hash END,
                    length(CAST(snapshot_ct AS BLOB)),
                    length(CAST(created_at AS BLOB)),
                    CASE WHEN length(CAST(created_at AS BLOB)) <= ?1
                         THEN created_at END,
                    length(CAST(created_by_device_id AS BLOB)),
                    CASE WHEN length(CAST(created_by_device_id AS BLOB)) <= ?1
                         THEN created_by_device_id END
             FROM snapshots
             WHERE (?2 IS NULL OR created_at < ?2
                    OR (created_at = ?2 AND snapshot_id < ?3))
             ORDER BY created_at DESC, snapshot_id DESC
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                MAX_SNAPSHOT_SUMMARY_TEXT_BYTES as i64,
                cursor.as_ref().map(|value| value.created_at.as_str()),
                cursor.as_ref().map(|value| value.snapshot_id.as_str()),
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
            raw_items.last().map(encode_cursor).transpose()?
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(decode_summary)
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(SnapshotSummaryPage { items, next_cursor })
    }
}

fn read_raw_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawSnapshotSummary> {
    Ok(RawSnapshotSummary {
        snapshot_id_bytes: row.get(0)?,
        snapshot_id: row.get(1)?,
        base_commit_id_bytes: row.get(2)?,
        base_commit_id: row.get(3)?,
        snapshot_hash_bytes: row.get(4)?,
        snapshot_hash: row.get(5)?,
        snapshot_ciphertext_bytes: row.get(6)?,
        created_at_bytes: row.get(7)?,
        created_at: row.get(8)?,
        created_by_device_id_bytes: row.get(9)?,
        created_by_device_id: row.get(10)?,
    })
}

fn decode_summary(row: RawSnapshotSummary) -> StorageResult<SnapshotSummary> {
    let snapshot_id = required_text("snapshot ID bytes", row.snapshot_id_bytes, row.snapshot_id)?;
    let base_commit_id = required_text(
        "snapshot base commit ID bytes",
        row.base_commit_id_bytes,
        row.base_commit_id,
    )?;
    let snapshot_hash = required_text(
        "snapshot hash bytes",
        row.snapshot_hash_bytes,
        row.snapshot_hash,
    )?;
    let created_at = required_text(
        "snapshot created-at bytes",
        row.created_at_bytes,
        row.created_at,
    )?;
    let created_by_device_id = required_text(
        "snapshot creator device ID bytes",
        row.created_by_device_id_bytes,
        row.created_by_device_id,
    )?;
    let snapshot_ciphertext_bytes = u64::try_from(row.snapshot_ciphertext_bytes).map_err(|_| {
        StorageError::Validation("snapshot ciphertext byte length is negative".to_string())
    })?;
    Ok(SnapshotSummary {
        snapshot_id,
        base_commit_id,
        snapshot_hash,
        snapshot_ciphertext_bytes,
        created_at,
        created_by_device_id,
    })
}

fn required_text(
    resource: &str,
    stored_length: i64,
    value: Option<String>,
) -> StorageResult<String> {
    let value = bounded_optional_text(
        resource,
        Some(stored_length),
        value,
        MAX_SNAPSHOT_SUMMARY_TEXT_BYTES as u64,
    )?
    .ok_or_else(|| StorageError::Validation(format!("{resource} is required")))?;
    if value.is_empty() {
        return Err(StorageError::Validation(format!("{resource} is empty")));
    }
    Ok(value)
}

fn encode_cursor(row: &RawSnapshotSummary) -> StorageResult<String> {
    let created_at = required_text(
        "snapshot created-at bytes",
        row.created_at_bytes,
        row.created_at.clone(),
    )?;
    let snapshot_id = required_text(
        "snapshot ID bytes",
        row.snapshot_id_bytes,
        row.snapshot_id.clone(),
    )?;
    let cursor = serde_json::to_string(&SnapshotSummaryCursor {
        version: SNAPSHOT_SUMMARY_CURSOR_VERSION,
        query: SnapshotSummaryQuery::All,
        created_at,
        snapshot_id,
    })
    .map_err(|error| StorageError::Validation(error.to_string()))?;
    if cursor.len() > MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::ResourceLimit {
            resource: "snapshot summary cursor bytes".to_string(),
            actual: cursor.len() as u64,
            limit: MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES as u64,
        });
    }
    Ok(cursor)
}

fn parse_cursor(value: &str) -> StorageResult<SnapshotSummaryCursor> {
    if value.len() > MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::Validation(format!(
            "snapshot summary cursor exceeds {MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES} bytes"
        )));
    }
    let cursor: SnapshotSummaryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid snapshot summary cursor: {error}"))
    })?;
    if cursor.version != SNAPSHOT_SUMMARY_CURSOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported snapshot summary cursor version {}",
            cursor.version
        )));
    }
    if cursor.query != SnapshotSummaryQuery::All {
        return Err(StorageError::Validation(
            "snapshot summary cursor query does not match the requested list".to_string(),
        ));
    }
    if cursor.created_at.is_empty() || cursor.snapshot_id.is_empty() {
        return Err(StorageError::Validation(
            "snapshot summary cursor position is incomplete".to_string(),
        ));
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, SnapshotRepo};

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        (
            conn,
            CommitContext::new("snapshot-summary-device".to_string()),
        )
    }

    #[test]
    fn snapshot_summary_pages_are_bounded_stable_and_legacy_safe() {
        let (conn, ctx) = setup();
        let mut expected_ids = Vec::new();
        for _ in 0..5 {
            expected_ids.push(
                SnapshotRepo::create_snapshot(&conn, &ctx)
                    .unwrap()
                    .snapshot_id,
            );
        }
        conn.inner()
            .execute(
                "UPDATE snapshots SET created_at = '2026-07-25T00:00:00Z'",
                [],
            )
            .unwrap();
        expected_ids.sort_by(|left, right| right.cmp(left));

        let mut cursor = None;
        let mut actual_ids = Vec::new();
        loop {
            let page = SnapshotSummaryRepo::list(&conn, 2, cursor.as_deref()).unwrap();
            assert!(page.items.len() <= 2);
            actual_ids.extend(page.items.iter().map(|item| item.snapshot_id.clone()));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual_ids, expected_ids);
        assert!(SnapshotRepo::list_all(&conn).is_ok());
    }

    #[test]
    fn snapshot_summary_does_not_read_or_parse_corrupt_payloads() {
        let (conn, ctx) = setup();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1 WHERE snapshot_id = ?2",
                rusqlite::params![vec![0x7f_u8; 1024 * 1024], &snapshot.snapshot_id],
            )
            .unwrap();

        let summary = SnapshotSummaryRepo::get(&conn, &snapshot.snapshot_id)
            .unwrap()
            .unwrap();
        assert_eq!(summary.snapshot_ciphertext_bytes, 1024 * 1024);
        let page = SnapshotSummaryRepo::list(&conn, 1, None).unwrap();
        assert_eq!(page.items[0].snapshot_id, snapshot.snapshot_id);
        assert_eq!(page.items[0].snapshot_ciphertext_bytes, 1024 * 1024);
        assert!(!SnapshotRepo::verify_integrity(&conn, &snapshot.snapshot_id).unwrap());
    }

    #[test]
    fn snapshot_summary_enforces_page_cursor_and_position_limits() {
        let (conn, ctx) = setup();
        let first = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let second = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        assert!(matches!(
            SnapshotSummaryRepo::list(&conn, 0, None),
            Err(StorageError::Validation(message)) if message.contains("page size")
        ));
        assert!(matches!(
            SnapshotSummaryRepo::list(&conn, MAX_SNAPSHOT_SUMMARY_PAGE_SIZE + 1, None),
            Err(StorageError::Validation(message)) if message.contains("page size")
        ));
        assert!(SnapshotSummaryRepo::list(
            &conn,
            1,
            Some(&"x".repeat(MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES + 1)),
        )
        .is_err());

        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_hash = ?1 WHERE snapshot_id = ?2",
                rusqlite::params![
                    "h".repeat(MAX_SNAPSHOT_SUMMARY_TEXT_BYTES + 1),
                    &first.snapshot_id
                ],
            )
            .unwrap();
        assert!(matches!(
            SnapshotSummaryRepo::get(&conn, &first.snapshot_id),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "snapshot hash bytes"
        ));
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_hash = ?1 WHERE snapshot_id = ?2",
                rusqlite::params![&first.snapshot_hash, &first.snapshot_id],
            )
            .unwrap();

        conn.inner()
            .execute(
                "UPDATE snapshots SET created_at = ?1 WHERE snapshot_id IN (?2, ?3)",
                rusqlite::params![
                    "t".repeat(MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES),
                    &first.snapshot_id,
                    &second.snapshot_id
                ],
            )
            .unwrap();
        assert!(matches!(
            SnapshotSummaryRepo::list(&conn, 1, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "snapshot summary cursor bytes"
        ));
    }
}
