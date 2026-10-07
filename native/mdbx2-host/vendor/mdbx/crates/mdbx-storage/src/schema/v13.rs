use rusqlite::{params, Connection};

use crate::error::{StorageError, StorageResult};

pub const SYNC_DELTA_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS sync_delta_meta (
    meta_id                         INTEGER PRIMARY KEY CHECK (meta_id = 1),
    bootstrap_commit_inventory_seq INTEGER NOT NULL CHECK (bootstrap_commit_inventory_seq >= 0),
    created_at                      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_delta_batches (
    batch_seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          TEXT NOT NULL UNIQUE,
    vault_id          TEXT NOT NULL,
    format            TEXT NOT NULL,
    batch_kind        TEXT NOT NULL CHECK (batch_kind IN ('commit', 'auxiliary')),
    logical_row_count INTEGER NOT NULL CHECK (logical_row_count >= 0),
    payload           BLOB NOT NULL,
    payload_sha256    BLOB NOT NULL CHECK (length(payload_sha256) = 32),
    created_at        TEXT NOT NULL,
    integrity_tag     BLOB CHECK (integrity_tag IS NULL OR length(integrity_tag) = 32)
);

CREATE TABLE IF NOT EXISTS sync_delta_batch_commits (
    batch_id       TEXT NOT NULL,
    commit_ordinal INTEGER NOT NULL CHECK (commit_ordinal >= 0),
    commit_id      TEXT NOT NULL,
    PRIMARY KEY (batch_id, commit_ordinal),
    UNIQUE (batch_id, commit_id),
    FOREIGN KEY (batch_id) REFERENCES sync_delta_batches(batch_id) ON DELETE CASCADE,
    FOREIGN KEY (commit_id) REFERENCES commits(commit_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_sync_delta_batch_commit
    ON sync_delta_batch_commits (commit_id, batch_id);
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(SYNC_DELTA_DDL)
        .map_err(StorageError::Database)
}

pub fn initialize_bootstrap_floor(conn: &Connection, created_at: &str) -> StorageResult<()> {
    let watermark: i64 = conn.query_row(
        "SELECT COALESCE(MAX(inventory_seq), 0) FROM commit_inventory",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO sync_delta_meta
            (meta_id, bootstrap_commit_inventory_seq, created_at)
         VALUES (1, ?1, ?2)",
        params![watermark, created_at],
    )?;
    Ok(())
}

pub(crate) fn validate_sync_delta_schema(conn: &Connection) -> StorageResult<()> {
    let meta_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM sync_delta_meta", [], |row| row.get(0))?;
    if meta_count != 1 {
        return Err(StorageError::Validation(format!(
            "sync delta metadata must contain exactly one row; found {meta_count}"
        )));
    }
    let invalid_floor: bool = conn.query_row(
        "SELECT bootstrap_commit_inventory_seq >
                (SELECT COALESCE(MAX(inventory_seq), 0) FROM commit_inventory)
         FROM sync_delta_meta WHERE meta_id = 1",
        [],
        |row| row.get(0),
    )?;
    if invalid_floor {
        return Err(StorageError::Validation(
            "sync delta bootstrap floor exceeds the commit inventory watermark".to_string(),
        ));
    }
    let invalid_batches: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sync_delta_batches b
         WHERE (b.batch_kind = 'commit' AND NOT EXISTS (
                    SELECT 1 FROM sync_delta_batch_commits c WHERE c.batch_id = b.batch_id
                ))
            OR (b.batch_kind = 'auxiliary' AND EXISTS (
                    SELECT 1 FROM sync_delta_batch_commits c WHERE c.batch_id = b.batch_id
                ))",
        [],
        |row| row.get(0),
    )?;
    if invalid_batches != 0 {
        return Err(StorageError::Validation(format!(
            "sync delta inventory contains {invalid_batches} batches with invalid commit ownership"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn bootstrap_floor_is_fixed_at_initialization_watermark() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO commits
                (commit_id, device_id, local_seq, commit_kind, change_scope,
                 changed_object_ids_ct, vector_clock, created_at, integrity_tag)
             VALUES ('c1', 'd1', 1, 'change', 'vault', X'5B5D', '{}',
                     '2026-07-20T00:00:00Z', zeroblob(32))",
            [],
        )
        .unwrap();

        initialize_bootstrap_floor(&conn, "2026-07-20T00:00:01Z").unwrap();
        conn.execute(
            "INSERT INTO commits
                (commit_id, device_id, local_seq, commit_kind, change_scope,
                 changed_object_ids_ct, vector_clock, created_at, integrity_tag)
             VALUES ('c2', 'd1', 2, 'change', 'vault', X'5B5D', '{}',
                     '2026-07-20T00:00:02Z', zeroblob(32))",
            [],
        )
        .unwrap();

        let floor: i64 = conn
            .query_row(
                "SELECT bootstrap_commit_inventory_seq FROM sync_delta_meta",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(floor, 1);
        validate_sync_delta_schema(&conn).unwrap();
    }
}
