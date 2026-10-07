use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

pub const MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE: usize = 512;
pub const MAX_SYNC_DELTA_INVENTORY_TOKEN_BYTES: usize = 4096;
const SYNC_DELTA_INVENTORY_TOKEN_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncDeltaInventoryItem {
    pub batch_seq: u64,
    pub batch_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncDeltaInventoryPage {
    pub items: Vec<SyncDeltaInventoryItem>,
    pub next_cursor: Option<String>,
    /// The opaque checkpoint for the frozen watermark represented by this page.
    pub checkpoint: String,
    /// Commits at or before this sequence require complete-state bootstrap.
    pub bootstrap_commit_inventory_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DeltaInventoryAnchor {
    sequence: u64,
    batch_id: String,
    payload_sha256: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DeltaInventoryCheckpoint {
    version: u8,
    vault_id: String,
    bootstrap_commit_inventory_seq: u64,
    anchor: Option<DeltaInventoryAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DeltaInventoryCursor {
    version: u8,
    vault_id: String,
    bootstrap_commit_inventory_seq: u64,
    start: Option<DeltaInventoryAnchor>,
    watermark: Option<DeltaInventoryAnchor>,
    after: Option<DeltaInventoryAnchor>,
}

pub struct SyncDeltaInventoryRepo;

impl SyncDeltaInventoryRepo {
    /// Lists a fixed local batch-inventory snapshot after an optional checkpoint.
    pub fn list(
        conn: &VaultConnection,
        checkpoint: Option<&str>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<SyncDeltaInventoryPage> {
        if page_size == 0 || page_size > MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "sync delta inventory page size must be between 1 and {MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE}"
            )));
        }

        let vault_id = vault_id(conn)?;
        let bootstrap_floor = bootstrap_commit_inventory_seq(conn)?;
        let start = checkpoint
            .map(|value| parse_checkpoint(value, &vault_id, bootstrap_floor))
            .transpose()?
            .and_then(|token| token.anchor);
        let cursor = cursor
            .map(|value| parse_cursor(value, &vault_id, bootstrap_floor, start.as_ref()))
            .transpose()?;

        let (start, watermark, after) = if let Some(cursor) = cursor {
            (cursor.start, cursor.watermark, cursor.after)
        } else {
            (start, latest_anchor(conn)?, None)
        };
        validate_range(conn, start.as_ref(), watermark.as_ref(), after.as_ref())?;

        let mut stmt = conn.inner().prepare(
            "SELECT batch_seq, batch_id
             FROM sync_delta_batches
             WHERE batch_seq > ?1
               AND batch_seq <= ?2
               AND batch_seq > ?3
             ORDER BY batch_seq ASC
             LIMIT ?4",
        )?;
        let start_seq = sqlite_sequence(start.as_ref());
        let watermark_seq = sqlite_sequence(watermark.as_ref());
        let after_seq = sqlite_sequence(after.as_ref());
        let rows = stmt.query_map(
            rusqlite::params![start_seq, watermark_seq, after_seq, (page_size + 1) as i64],
            |row| {
                let sequence = row.get::<_, i64>(0)?;
                Ok(SyncDeltaInventoryItem {
                    batch_seq: u64::try_from(sequence).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Integer,
                            Box::new(error),
                        )
                    })?,
                    batch_id: row.get(1)?,
                })
            },
        )?;
        let mut items = rows.take(page_size + 1).collect::<Result<Vec<_>, _>>()?;
        let has_next = items.len() > page_size;
        if has_next {
            items.pop();
        }
        let next_cursor = if has_next {
            let last = items.last().ok_or_else(|| {
                StorageError::Validation(
                    "sync delta inventory cursor has no batch position".to_string(),
                )
            })?;
            Some(encode_cursor(&DeltaInventoryCursor {
                version: SYNC_DELTA_INVENTORY_TOKEN_VERSION,
                vault_id: vault_id.clone(),
                bootstrap_commit_inventory_seq: bootstrap_floor,
                start,
                watermark: watermark.clone(),
                after: Some(anchor_for_item(conn, last)?),
            })?)
        } else {
            None
        };
        let checkpoint = encode_checkpoint(&DeltaInventoryCheckpoint {
            version: SYNC_DELTA_INVENTORY_TOKEN_VERSION,
            vault_id,
            bootstrap_commit_inventory_seq: bootstrap_floor,
            anchor: watermark,
        })?;

        Ok(SyncDeltaInventoryPage {
            items,
            next_cursor,
            checkpoint,
            bootstrap_commit_inventory_seq: bootstrap_floor,
        })
    }

    /// Returns a checkpoint for the current local batch inventory head.
    pub fn checkpoint(conn: &VaultConnection) -> StorageResult<String> {
        let vault_id = vault_id(conn)?;
        encode_checkpoint(&DeltaInventoryCheckpoint {
            version: SYNC_DELTA_INVENTORY_TOKEN_VERSION,
            vault_id,
            bootstrap_commit_inventory_seq: bootstrap_commit_inventory_seq(conn)?,
            anchor: latest_anchor(conn)?,
        })
    }

    /// Return a durable checkpoint positioned immediately after `item`.
    ///
    /// This preserves the bootstrap floor while advancing only to the last
    /// batch included in a bounded transfer segment.
    pub fn checkpoint_after(
        conn: &VaultConnection,
        item: Option<&SyncDeltaInventoryItem>,
    ) -> StorageResult<String> {
        let vault_id = vault_id(conn)?;
        let bootstrap_floor = bootstrap_commit_inventory_seq(conn)?;
        let anchor = if let Some(item) = item {
            let anchor = anchor_for_item(conn, item)?;
            validate_anchor(conn, Some(&anchor), "checkpoint")?;
            Some(anchor)
        } else {
            None
        };
        encode_checkpoint(&DeltaInventoryCheckpoint {
            version: SYNC_DELTA_INVENTORY_TOKEN_VERSION,
            vault_id,
            bootstrap_commit_inventory_seq: bootstrap_floor,
            anchor,
        })
    }

    pub fn bootstrap_commit_inventory_seq(conn: &VaultConnection) -> StorageResult<u64> {
        bootstrap_commit_inventory_seq(conn)
    }
}

fn vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::Database)
}

fn bootstrap_commit_inventory_seq(conn: &VaultConnection) -> StorageResult<u64> {
    let sequence = conn.inner().query_row(
        "SELECT bootstrap_commit_inventory_seq FROM sync_delta_meta WHERE meta_id = 1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    u64::try_from(sequence).map_err(|error| {
        StorageError::Validation(format!(
            "invalid sync delta bootstrap commit inventory sequence: {error}"
        ))
    })
}

fn latest_anchor(conn: &VaultConnection) -> StorageResult<Option<DeltaInventoryAnchor>> {
    conn.inner()
        .query_row(
            "SELECT batch_seq, batch_id, payload_sha256
             FROM sync_delta_batches ORDER BY batch_seq DESC LIMIT 1",
            [],
            anchor_from_row,
        )
        .optional()
        .map_err(StorageError::Database)
}

fn anchor_for_item(
    conn: &VaultConnection,
    item: &SyncDeltaInventoryItem,
) -> StorageResult<DeltaInventoryAnchor> {
    let sequence = i64::try_from(item.batch_seq).map_err(|_| {
        StorageError::Validation("sync delta inventory sequence is too large".to_string())
    })?;
    conn.inner()
        .query_row(
            "SELECT batch_seq, batch_id, payload_sha256
             FROM sync_delta_batches WHERE batch_seq = ?1 AND batch_id = ?2",
            rusqlite::params![sequence, item.batch_id],
            anchor_from_row,
        )
        .map_err(StorageError::Database)
}

fn anchor_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeltaInventoryAnchor> {
    let sequence = row.get::<_, i64>(0)?;
    Ok(DeltaInventoryAnchor {
        sequence: u64::try_from(sequence).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        batch_id: row.get(1)?,
        payload_sha256: row.get(2)?,
    })
}

fn validate_range(
    conn: &VaultConnection,
    start: Option<&DeltaInventoryAnchor>,
    watermark: Option<&DeltaInventoryAnchor>,
    after: Option<&DeltaInventoryAnchor>,
) -> StorageResult<()> {
    validate_anchor(conn, start, "checkpoint")?;
    validate_anchor(conn, watermark, "watermark")?;
    validate_anchor(conn, after, "cursor")?;
    let start_seq = start.map_or(0, |anchor| anchor.sequence);
    let watermark_seq = watermark.map_or(0, |anchor| anchor.sequence);
    let after_seq = after.map_or(start_seq, |anchor| anchor.sequence);
    if watermark_seq < start_seq || after_seq < start_seq || after_seq > watermark_seq {
        return Err(StorageError::Validation(
            "sync delta inventory cursor range is invalid".to_string(),
        ));
    }
    Ok(())
}

fn validate_anchor(
    conn: &VaultConnection,
    anchor: Option<&DeltaInventoryAnchor>,
    label: &str,
) -> StorageResult<()> {
    let Some(anchor) = anchor else {
        return Ok(());
    };
    if anchor.payload_sha256.len() != 32 {
        return Err(StorageError::Validation(format!(
            "sync delta inventory {label} digest must be 32 bytes"
        )));
    }
    let sequence = i64::try_from(anchor.sequence).map_err(|_| {
        StorageError::Validation(format!(
            "sync delta inventory {label} sequence is too large"
        ))
    })?;
    let matches: bool = conn.inner().query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sync_delta_batches
            WHERE batch_seq = ?1 AND batch_id = ?2 AND payload_sha256 = ?3
         )",
        rusqlite::params![sequence, anchor.batch_id, anchor.payload_sha256],
        |row| row.get(0),
    )?;
    if !matches {
        return Err(StorageError::Validation(format!(
            "sync delta inventory {label} anchor is missing"
        )));
    }
    Ok(())
}

fn parse_checkpoint(
    value: &str,
    vault_id: &str,
    bootstrap_floor: u64,
) -> StorageResult<DeltaInventoryCheckpoint> {
    validate_token_length(value, "checkpoint")?;
    let token: DeltaInventoryCheckpoint = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid sync delta inventory checkpoint: {error}"))
    })?;
    validate_token_identity(
        token.version,
        &token.vault_id,
        token.bootstrap_commit_inventory_seq,
        vault_id,
        bootstrap_floor,
        "checkpoint",
    )?;
    Ok(token)
}

fn parse_cursor(
    value: &str,
    vault_id: &str,
    bootstrap_floor: u64,
    expected_start: Option<&DeltaInventoryAnchor>,
) -> StorageResult<DeltaInventoryCursor> {
    validate_token_length(value, "cursor")?;
    let token: DeltaInventoryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid sync delta inventory cursor: {error}"))
    })?;
    validate_token_identity(
        token.version,
        &token.vault_id,
        token.bootstrap_commit_inventory_seq,
        vault_id,
        bootstrap_floor,
        "cursor",
    )?;
    if token.start.as_ref() != expected_start {
        return Err(StorageError::Validation(
            "sync delta inventory cursor does not match the starting checkpoint".to_string(),
        ));
    }
    if token.watermark.is_none() || token.after.is_none() {
        return Err(StorageError::Validation(
            "sync delta inventory cursor position is incomplete".to_string(),
        ));
    }
    Ok(token)
}

fn validate_token_identity(
    version: u8,
    token_vault_id: &str,
    token_bootstrap_floor: u64,
    vault_id: &str,
    bootstrap_floor: u64,
    kind: &str,
) -> StorageResult<()> {
    if version != SYNC_DELTA_INVENTORY_TOKEN_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported sync delta inventory {kind} version {version}"
        )));
    }
    if token_vault_id != vault_id {
        return Err(StorageError::Validation(format!(
            "sync delta inventory {kind} belongs to another vault"
        )));
    }
    if token_bootstrap_floor != bootstrap_floor {
        return Err(StorageError::Validation(format!(
            "sync delta inventory {kind} has a different bootstrap floor"
        )));
    }
    Ok(())
}

fn validate_token_length(value: &str, kind: &str) -> StorageResult<()> {
    if value.len() > MAX_SYNC_DELTA_INVENTORY_TOKEN_BYTES {
        return Err(StorageError::Validation(format!(
            "sync delta inventory {kind} exceeds {MAX_SYNC_DELTA_INVENTORY_TOKEN_BYTES} bytes"
        )));
    }
    Ok(())
}

fn encode_checkpoint(token: &DeltaInventoryCheckpoint) -> StorageResult<String> {
    encode_token(token, "checkpoint")
}

fn encode_cursor(token: &DeltaInventoryCursor) -> StorageResult<String> {
    encode_token(token, "cursor")
}

fn encode_token<T: Serialize>(token: &T, kind: &str) -> StorageResult<String> {
    let value = serde_json::to_string(token).map_err(|error| {
        StorageError::Validation(format!("invalid sync delta inventory {kind}: {error}"))
    })?;
    validate_token_length(&value, kind)?;
    Ok(value)
}

fn sqlite_sequence(anchor: Option<&DeltaInventoryAnchor>) -> i64 {
    anchor.map_or(0, |anchor| {
        i64::try_from(anchor.sequence).expect("validated sync delta sequence fits SQLite")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use sha2::Digest;

    fn setup(vault_id: &str) -> VaultConnection {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                vault_id: Some(vault_id.to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        conn
    }

    fn insert_batch(conn: &VaultConnection, batch_id: &str) {
        let digest = sha2::Sha256::digest([]).to_vec();
        conn.inner()
            .execute(
                "INSERT INTO sync_delta_batches
                    (batch_id, vault_id, format, batch_kind, logical_row_count,
                     payload, payload_sha256, created_at, integrity_tag)
                 SELECT ?1, vault_id, 'test-delta-v1', 'auxiliary', 0,
                        X'', ?2, '2026-07-21T00:00:00Z', NULL
                 FROM vault_meta",
                rusqlite::params![batch_id, digest],
            )
            .unwrap();
    }

    #[test]
    fn sync_delta_inventory_pages_are_bounded_and_freeze_the_watermark() {
        let conn = setup("delta-inventory-pages");
        for index in 1..=4 {
            insert_batch(&conn, &format!("batch-{index}"));
        }

        let first = SyncDeltaInventoryRepo::list(&conn, None, 2, None).unwrap();
        assert_eq!(first.items.len(), 2);
        let checkpoint = first.checkpoint.clone();
        let mut cursor = first.next_cursor.unwrap();
        insert_batch(&conn, "after-watermark");
        let mut seen = first
            .items
            .iter()
            .map(|item| item.batch_id.clone())
            .collect::<Vec<_>>();

        loop {
            let page = SyncDeltaInventoryRepo::list(&conn, None, 2, Some(&cursor)).unwrap();
            assert_eq!(page.checkpoint, checkpoint);
            seen.extend(page.items.iter().map(|item| item.batch_id.clone()));
            match page.next_cursor {
                Some(next) => cursor = next,
                None => break,
            }
        }
        assert_eq!(seen, ["batch-1", "batch-2", "batch-3", "batch-4"]);
    }

    #[test]
    fn sync_delta_inventory_checkpoint_resumes_only_new_batches() {
        let conn = setup("delta-inventory-resume");
        insert_batch(&conn, "before-checkpoint");
        let checkpoint = SyncDeltaInventoryRepo::checkpoint(&conn).unwrap();
        insert_batch(&conn, "after-checkpoint");

        let resumed = SyncDeltaInventoryRepo::list(&conn, Some(&checkpoint), 10, None).unwrap();
        assert_eq!(
            resumed
                .items
                .iter()
                .map(|item| item.batch_id.as_str())
                .collect::<Vec<_>>(),
            ["after-checkpoint"]
        );
    }

    #[test]
    fn partial_checkpoint_resumes_after_the_last_transferred_batch() {
        let conn = setup("delta-inventory-partial-resume");
        let base = SyncDeltaInventoryRepo::checkpoint(&conn).unwrap();
        insert_batch(&conn, "segment-batch-1");
        insert_batch(&conn, "segment-batch-2");

        let first = SyncDeltaInventoryRepo::list(&conn, Some(&base), 1, None).unwrap();
        assert!(first.next_cursor.is_some());
        let partial = SyncDeltaInventoryRepo::checkpoint_after(&conn, first.items.last()).unwrap();
        let resumed = SyncDeltaInventoryRepo::list(&conn, Some(&partial), 10, None).unwrap();
        assert_eq!(
            resumed
                .items
                .iter()
                .map(|item| item.batch_id.as_str())
                .collect::<Vec<_>>(),
            ["segment-batch-2"]
        );
    }

    #[test]
    fn sync_delta_inventory_tokens_are_bounded_bound_and_anchor_validated() {
        let conn = setup("delta-inventory-validation");
        insert_batch(&conn, "batch-a");
        insert_batch(&conn, "batch-b");
        assert!(SyncDeltaInventoryRepo::list(&conn, None, 0, None).is_err());
        assert!(SyncDeltaInventoryRepo::list(
            &conn,
            None,
            MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE + 1,
            None,
        )
        .is_err());
        assert!(SyncDeltaInventoryRepo::list(
            &conn,
            Some(&"x".repeat(MAX_SYNC_DELTA_INVENTORY_TOKEN_BYTES + 1)),
            1,
            None,
        )
        .is_err());

        let first = SyncDeltaInventoryRepo::list(&conn, None, 1, None).unwrap();
        let cursor = first.next_cursor.unwrap();
        let unknown = cursor.trim_end_matches('}').to_string() + ",\"unknown\":1}";
        assert!(SyncDeltaInventoryRepo::list(&conn, None, 1, Some(&unknown)).is_err());
        let checkpoint = SyncDeltaInventoryRepo::checkpoint(&conn).unwrap();
        assert!(SyncDeltaInventoryRepo::list(&conn, Some(&checkpoint), 1, Some(&cursor),).is_err());

        conn.inner()
            .execute(
                "UPDATE sync_delta_batches SET payload_sha256 = zeroblob(32)
                 WHERE batch_id = 'batch-b'",
                [],
            )
            .unwrap();
        assert!(SyncDeltaInventoryRepo::list(&conn, Some(&checkpoint), 1, None).is_err());

        let other = setup("delta-inventory-other-vault");
        let foreign = SyncDeltaInventoryRepo::checkpoint(&other).unwrap();
        assert!(SyncDeltaInventoryRepo::list(&conn, Some(&foreign), 1, None).is_err());
        assert!(SyncDeltaInventoryRepo::list(&other, None, 1, Some(&cursor)).is_err());
    }

    #[test]
    fn sync_delta_inventory_exposes_the_fixed_bootstrap_floor() {
        let conn = setup("delta-inventory-floor");
        let expected: u64 = conn
            .inner()
            .query_row(
                "SELECT bootstrap_commit_inventory_seq FROM sync_delta_meta",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let page = SyncDeltaInventoryRepo::list(&conn, None, 1, None).unwrap();
        assert_eq!(page.bootstrap_commit_inventory_seq, expected);
        assert_eq!(
            SyncDeltaInventoryRepo::bootstrap_commit_inventory_seq(&conn).unwrap(),
            expected
        );
    }
}
