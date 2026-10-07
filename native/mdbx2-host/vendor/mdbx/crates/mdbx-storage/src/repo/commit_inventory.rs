use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

pub const MAX_COMMIT_INVENTORY_PAGE_SIZE: usize = 512;
pub const MAX_COMMIT_INVENTORY_TOKEN_BYTES: usize = 4096;
const COMMIT_INVENTORY_TOKEN_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitInventoryItem {
    pub inventory_seq: u64,
    pub commit_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitInventoryPage {
    pub items: Vec<CommitInventoryItem>,
    pub next_cursor: Option<String>,
    /// The opaque checkpoint for the frozen watermark represented by this page.
    pub checkpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct InventoryAnchor {
    sequence: u64,
    commit_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct InventoryCheckpoint {
    version: u8,
    vault_id: String,
    anchor: Option<InventoryAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct InventoryCursor {
    version: u8,
    vault_id: String,
    start: Option<InventoryAnchor>,
    watermark: Option<InventoryAnchor>,
    after: Option<InventoryAnchor>,
}

pub struct CommitInventoryRepo;

impl CommitInventoryRepo {
    /// List a fixed, causally ordered inventory snapshot.
    ///
    /// `checkpoint` is the last fully applied local watermark. On the first
    /// page it may be omitted; every later page must pass the same checkpoint
    /// together with the returned cursor. New commits after the first page are
    /// excluded by the cursor's frozen watermark.
    pub fn list(
        conn: &VaultConnection,
        checkpoint: Option<&str>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<CommitInventoryPage> {
        if page_size == 0 || page_size > MAX_COMMIT_INVENTORY_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "commit inventory page size must be between 1 and {MAX_COMMIT_INVENTORY_PAGE_SIZE}"
            )));
        }

        let vault_id = vault_id(conn)?;
        let start = checkpoint
            .map(|value| parse_checkpoint(value, &vault_id))
            .transpose()?
            .and_then(|token| token.anchor);
        let cursor = cursor
            .map(|value| parse_cursor(value, &vault_id, start.as_ref()))
            .transpose()?;

        let (start, watermark, after) = if let Some(cursor) = cursor {
            (cursor.start, cursor.watermark, cursor.after)
        } else {
            (start, latest_anchor(conn)?, None)
        };
        validate_range(conn, start.as_ref(), watermark.as_ref(), after.as_ref())?;

        let mut stmt = conn.inner().prepare(
            "SELECT inventory_seq, commit_id
             FROM commit_inventory
             WHERE inventory_seq > ?1
               AND inventory_seq <= ?2
               AND inventory_seq > ?3
             ORDER BY inventory_seq ASC
             LIMIT ?4",
        )?;
        let start_seq = start.as_ref().map_or(0_i64, |anchor| {
            i64::try_from(anchor.sequence).expect("validated inventory sequence fits SQLite")
        });
        let watermark_seq = watermark.as_ref().map_or(0_i64, |anchor| {
            i64::try_from(anchor.sequence).expect("validated inventory sequence fits SQLite")
        });
        let after_seq = after.as_ref().map_or(0_i64, |anchor| {
            i64::try_from(anchor.sequence).expect("validated inventory sequence fits SQLite")
        });
        let rows = stmt.query_map(
            rusqlite::params![start_seq, watermark_seq, after_seq, (page_size + 1) as i64],
            |row| {
                let sequence = row.get::<_, i64>(0)?;
                let inventory_seq = u64::try_from(sequence).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?;
                Ok(CommitInventoryItem {
                    inventory_seq,
                    commit_id: row.get(1)?,
                })
            },
        )?;
        let mut items = rows.take(page_size + 1).collect::<Result<Vec<_>, _>>()?;
        let has_next = items.len() > page_size;
        if has_next {
            items.pop();
        }
        let next_cursor = if has_next {
            Some(encode_cursor(&InventoryCursor {
                version: COMMIT_INVENTORY_TOKEN_VERSION,
                vault_id: vault_id.clone(),
                start,
                watermark: watermark.clone(),
                after: items.last().map(|item| InventoryAnchor {
                    sequence: item.inventory_seq,
                    commit_id: item.commit_id.clone(),
                }),
            })?)
        } else {
            None
        };
        let checkpoint = encode_checkpoint(&InventoryCheckpoint {
            version: COMMIT_INVENTORY_TOKEN_VERSION,
            vault_id,
            anchor: watermark,
        })?;

        Ok(CommitInventoryPage {
            items,
            next_cursor,
            checkpoint,
        })
    }

    /// Return a checkpoint for the current inventory head without paging.
    pub fn checkpoint(conn: &VaultConnection) -> StorageResult<String> {
        let vault_id = vault_id(conn)?;
        encode_checkpoint(&InventoryCheckpoint {
            version: COMMIT_INVENTORY_TOKEN_VERSION,
            vault_id,
            anchor: latest_anchor(conn)?,
        })
    }

    /// Return a durable checkpoint positioned immediately after `item`.
    ///
    /// Unlike [`checkpoint`], this does not advance to the current inventory
    /// head. It is used by bounded transfer segments to resume after the last
    /// item that was durably applied.
    pub fn checkpoint_after(
        conn: &VaultConnection,
        item: Option<&CommitInventoryItem>,
    ) -> StorageResult<String> {
        let vault_id = vault_id(conn)?;
        let anchor = if let Some(item) = item {
            let anchor = InventoryAnchor {
                sequence: item.inventory_seq,
                commit_id: item.commit_id.clone(),
            };
            validate_anchor(conn, Some(&anchor), "checkpoint")?;
            Some(anchor)
        } else {
            None
        };
        encode_checkpoint(&InventoryCheckpoint {
            version: COMMIT_INVENTORY_TOKEN_VERSION,
            vault_id,
            anchor,
        })
    }
}

fn vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::Database)
}

fn latest_anchor(conn: &VaultConnection) -> StorageResult<Option<InventoryAnchor>> {
    conn.inner()
        .query_row(
            "SELECT inventory_seq, commit_id
             FROM commit_inventory ORDER BY inventory_seq DESC LIMIT 1",
            [],
            |row| {
                let sequence = row.get::<_, i64>(0)?;
                Ok(InventoryAnchor {
                    sequence: u64::try_from(sequence).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Integer,
                            Box::new(error),
                        )
                    })?,
                    commit_id: row.get(1)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::Database)
}

fn validate_range(
    conn: &VaultConnection,
    start: Option<&InventoryAnchor>,
    watermark: Option<&InventoryAnchor>,
    after: Option<&InventoryAnchor>,
) -> StorageResult<()> {
    validate_anchor(conn, start, "checkpoint")?;
    validate_anchor(conn, watermark, "watermark")?;
    validate_anchor(conn, after, "cursor")?;
    let start_seq = start.map_or(0, |anchor| anchor.sequence);
    let watermark_seq = watermark.map_or(0, |anchor| anchor.sequence);
    let after_seq = after.map_or(start_seq, |anchor| anchor.sequence);
    if watermark_seq < start_seq || after_seq < start_seq || after_seq > watermark_seq {
        return Err(StorageError::Validation(
            "commit inventory cursor range is invalid".to_string(),
        ));
    }
    Ok(())
}

fn validate_anchor(
    conn: &VaultConnection,
    anchor: Option<&InventoryAnchor>,
    label: &str,
) -> StorageResult<()> {
    let Some(anchor) = anchor else {
        return Ok(());
    };
    let sequence = i64::try_from(anchor.sequence).map_err(|_| {
        StorageError::Validation(format!("commit inventory {label} sequence is too large"))
    })?;
    let matches: bool = conn.inner().query_row(
        "SELECT EXISTS(
            SELECT 1 FROM commit_inventory
            WHERE inventory_seq = ?1 AND commit_id = ?2
         )",
        rusqlite::params![sequence, anchor.commit_id],
        |row| row.get(0),
    )?;
    if !matches {
        return Err(StorageError::Validation(format!(
            "commit inventory {label} anchor is missing"
        )));
    }
    Ok(())
}

fn parse_checkpoint(value: &str, vault_id: &str) -> StorageResult<InventoryCheckpoint> {
    if value.len() > MAX_COMMIT_INVENTORY_TOKEN_BYTES {
        return Err(StorageError::Validation(format!(
            "commit inventory checkpoint exceeds {MAX_COMMIT_INVENTORY_TOKEN_BYTES} bytes"
        )));
    }
    let token: InventoryCheckpoint = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid commit inventory checkpoint: {error}"))
    })?;
    if token.version != COMMIT_INVENTORY_TOKEN_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported commit inventory checkpoint version {}",
            token.version
        )));
    }
    if token.vault_id != vault_id {
        return Err(StorageError::Validation(
            "commit inventory checkpoint belongs to another vault".to_string(),
        ));
    }
    Ok(token)
}

fn parse_cursor(
    value: &str,
    vault_id: &str,
    expected_start: Option<&InventoryAnchor>,
) -> StorageResult<InventoryCursor> {
    if value.len() > MAX_COMMIT_INVENTORY_TOKEN_BYTES {
        return Err(StorageError::Validation(format!(
            "commit inventory cursor exceeds {MAX_COMMIT_INVENTORY_TOKEN_BYTES} bytes"
        )));
    }
    let token: InventoryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid commit inventory cursor: {error}"))
    })?;
    if token.version != COMMIT_INVENTORY_TOKEN_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported commit inventory cursor version {}",
            token.version
        )));
    }
    if token.vault_id != vault_id {
        return Err(StorageError::Validation(
            "commit inventory cursor belongs to another vault".to_string(),
        ));
    }
    if token.start.as_ref() != expected_start {
        return Err(StorageError::Validation(
            "commit inventory cursor does not match the starting checkpoint".to_string(),
        ));
    }
    if token.watermark.is_none() || token.after.is_none() {
        return Err(StorageError::Validation(
            "commit inventory cursor position is incomplete".to_string(),
        ));
    }
    Ok(token)
}

fn encode_checkpoint(token: &InventoryCheckpoint) -> StorageResult<String> {
    encode_token(token, "checkpoint")
}

fn encode_cursor(token: &InventoryCursor) -> StorageResult<String> {
    encode_token(token, "cursor")
}

fn encode_token<T: Serialize>(token: &T, kind: &str) -> StorageResult<String> {
    let value = serde_json::to_string(token).map_err(|error| {
        StorageError::Validation(format!("invalid commit inventory {kind}: {error}"))
    })?;
    if value.len() > MAX_COMMIT_INVENTORY_TOKEN_BYTES {
        return Err(StorageError::Validation(format!(
            "commit inventory {kind} exceeds {MAX_COMMIT_INVENTORY_TOKEN_BYTES} bytes"
        )));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};

    fn setup() -> VaultConnection {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn
    }

    fn insert_commit(conn: &VaultConnection, id: &str, seq: i64, parent: Option<&str>) {
        conn.inner()
            .execute(
                "INSERT INTO commits
                    (commit_id, device_id, local_seq, commit_kind, change_scope,
                     changed_object_ids_ct, vector_clock, created_at, integrity_tag)
                 VALUES (?1, ?2, ?3, 'change', 'vault', X'5B5D', '{}', ?4, X'00')",
                rusqlite::params![
                    id,
                    format!("device-{seq}"),
                    seq,
                    format!("2026-07-20T00:00:{seq:02}Z")
                ],
            )
            .unwrap();
        if let Some(parent) = parent {
            conn.inner()
                .execute(
                    "INSERT INTO commit_parents (commit_id, parent_commit_id)
                     VALUES (?1, ?2)",
                    rusqlite::params![id, parent],
                )
                .unwrap();
        }
    }

    #[test]
    fn pages_are_bounded_and_exclude_commits_after_the_watermark() {
        let conn = setup();
        let genesis: String = conn
            .inner()
            .query_row(
                "SELECT commit_id FROM commit_inventory ORDER BY inventory_seq LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        insert_commit(&conn, "inventory-1", 1, Some(&genesis));
        insert_commit(&conn, "inventory-2", 2, Some("inventory-1"));
        insert_commit(&conn, "inventory-3", 3, Some("inventory-2"));
        insert_commit(&conn, "inventory-4", 4, Some("inventory-3"));

        let first = CommitInventoryRepo::list(&conn, None, 2, None).unwrap();
        assert_eq!(first.items.len(), 2);
        let frozen_checkpoint = first.checkpoint.clone();
        let cursor = first.next_cursor.clone().unwrap();
        insert_commit(&conn, "after-watermark", 5, Some("inventory-4"));

        let mut seen = first
            .items
            .iter()
            .map(|item| item.commit_id.clone())
            .collect::<Vec<_>>();
        let mut page = CommitInventoryRepo::list(&conn, None, 2, Some(&cursor)).unwrap();
        assert_eq!(page.checkpoint, frozen_checkpoint);
        seen.extend(page.items.iter().map(|item| item.commit_id.clone()));
        while let Some(cursor) = page.next_cursor {
            page = CommitInventoryRepo::list(&conn, None, 2, Some(&cursor)).unwrap();
            seen.extend(page.items.iter().map(|item| item.commit_id.clone()));
        }
        assert!(!seen.iter().any(|id| id == "after-watermark"));
        assert_eq!(seen.len(), 5);
    }

    #[test]
    fn completed_checkpoint_resumes_only_new_commits() {
        let conn = setup();
        let first =
            CommitInventoryRepo::list(&conn, None, MAX_COMMIT_INVENTORY_PAGE_SIZE, None).unwrap();
        let checkpoint = first.checkpoint;
        insert_commit(&conn, "new-commit", 1, None);
        let resumed = CommitInventoryRepo::list(&conn, Some(&checkpoint), 10, None).unwrap();
        assert_eq!(
            resumed
                .items
                .iter()
                .map(|item| item.commit_id.as_str())
                .collect::<Vec<_>>(),
            ["new-commit"]
        );
    }

    #[test]
    fn partial_checkpoint_resumes_after_the_last_transferred_commit() {
        let conn = setup();
        let base = CommitInventoryRepo::checkpoint(&conn).unwrap();
        insert_commit(&conn, "segment-commit-1", 1, None);
        insert_commit(&conn, "segment-commit-2", 2, Some("segment-commit-1"));

        let first = CommitInventoryRepo::list(&conn, Some(&base), 1, None).unwrap();
        assert!(first.next_cursor.is_some());
        let partial = CommitInventoryRepo::checkpoint_after(&conn, first.items.last()).unwrap();
        let resumed = CommitInventoryRepo::list(&conn, Some(&partial), 10, None).unwrap();
        assert_eq!(
            resumed
                .items
                .iter()
                .map(|item| item.commit_id.as_str())
                .collect::<Vec<_>>(),
            ["segment-commit-2"]
        );
    }

    #[test]
    fn tokens_are_bounded_query_bound_and_anchor_validated() {
        let conn = setup();
        insert_commit(&conn, "cursor-commit", 1, None);
        assert!(CommitInventoryRepo::list(&conn, None, 0, None).is_err());
        assert!(
            CommitInventoryRepo::list(&conn, None, MAX_COMMIT_INVENTORY_PAGE_SIZE + 1, None,)
                .is_err()
        );
        assert!(CommitInventoryRepo::list(
            &conn,
            Some(&"x".repeat(MAX_COMMIT_INVENTORY_TOKEN_BYTES + 1)),
            1,
            None,
        )
        .is_err());
        let page = CommitInventoryRepo::list(&conn, None, 1, None).unwrap();
        let cursor = page.next_cursor.unwrap();
        let unknown = cursor.trim_end_matches('}').to_string() + ",\"unknown\":1}";
        assert!(CommitInventoryRepo::list(&conn, None, 1, Some(&unknown)).is_err());
        assert!(CommitInventoryRepo::list(
            &conn,
            None,
            1,
            Some(&"x".repeat(MAX_COMMIT_INVENTORY_TOKEN_BYTES + 1)),
        )
        .is_err());
        let missing_checkpoint = serde_json::to_string(&InventoryCheckpoint {
            version: COMMIT_INVENTORY_TOKEN_VERSION,
            vault_id: vault_id(&conn).unwrap(),
            anchor: Some(InventoryAnchor {
                sequence: 1,
                commit_id: "missing".to_string(),
            }),
        })
        .unwrap();
        assert!(CommitInventoryRepo::list(&conn, Some(&missing_checkpoint), 1, None).is_err());

        let base_checkpoint = CommitInventoryRepo::checkpoint(&conn).unwrap();
        assert!(
            CommitInventoryRepo::list(&conn, Some(&base_checkpoint), 1, Some(&cursor),).is_err()
        );

        let other = setup();
        let foreign_checkpoint = CommitInventoryRepo::checkpoint(&other).unwrap();
        assert!(CommitInventoryRepo::list(&conn, Some(&foreign_checkpoint), 1, None).is_err());
        assert!(CommitInventoryRepo::list(&other, None, 1, Some(&cursor)).is_err());
    }
}
