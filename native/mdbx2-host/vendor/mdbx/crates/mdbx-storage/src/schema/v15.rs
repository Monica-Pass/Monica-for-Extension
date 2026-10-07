use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

pub const SYNC_STATE_EXTENSIONS_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS sync_state_extensions (
    extension_key TEXT PRIMARY KEY NOT NULL,
    value_json BLOB NOT NULL,
    source_commit_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (length(CAST(extension_key AS BLOB)) BETWEEN 1 AND 128),
    CHECK (length(value_json) BETWEEN 1 AND 65536)
);
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(SYNC_STATE_EXTENSIONS_DDL)
        .map_err(StorageError::Database)
}

pub fn validate_sync_state_extensions(conn: &Connection) -> StorageResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'sync_state_extensions'
        )",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing required table sync_state_extensions".to_string(),
        ));
    }

    let invalid_shape: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_state_extensions
         WHERE length(CAST(extension_key AS BLOB)) NOT BETWEEN 1 AND 128
            OR typeof(value_json) <> 'blob'
            OR length(value_json) NOT BETWEEN 1 AND 65536",
        [],
        |row| row.get(0),
    )?;
    if invalid_shape != 0 {
        return Err(StorageError::Validation(
            "sync_state_extensions contains invalid key or value bounds".to_string(),
        ));
    }

    let (field_count, total_bytes): (i64, i64) = conn.query_row(
        "SELECT COUNT(*), COALESCE(
             SUM(length(CAST(extension_key AS BLOB)) + length(value_json)), 0
         ) FROM sync_state_extensions",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if field_count > 256 || total_bytes > 64 * 1024 {
        return Err(StorageError::Validation(
            "sync_state_extensions exceeds bounded resource limits".to_string(),
        ));
    }
    Ok(())
}
