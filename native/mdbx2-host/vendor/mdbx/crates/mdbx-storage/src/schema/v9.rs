use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

pub const PURGE_RECEIPTS_DDL: &str = "\
CREATE TABLE IF NOT EXISTS purge_receipts (
    purge_id                TEXT PRIMARY KEY NOT NULL,
    tombstone_id            TEXT NOT NULL UNIQUE,
    target_object_type      TEXT NOT NULL,
    target_object_id        TEXT NOT NULL,
    delete_commit_id        TEXT NOT NULL,
    purge_commit_id         TEXT NOT NULL UNIQUE,
    delete_clock            TEXT NOT NULL,
    retention_eligible_at   TEXT NOT NULL,
    purged_by_device_id     TEXT NOT NULL,
    purged_at               TEXT NOT NULL,
    integrity_tag           BLOB NOT NULL,
    UNIQUE (target_object_type, target_object_id),
    FOREIGN KEY (delete_commit_id) REFERENCES commits(commit_id),
    FOREIGN KEY (purge_commit_id) REFERENCES commits(commit_id)
);

CREATE INDEX IF NOT EXISTS idx_purge_receipts_target
    ON purge_receipts (target_object_type, target_object_id);
CREATE INDEX IF NOT EXISTS idx_purge_receipts_purged_at
    ON purge_receipts (purged_at, purge_id);";

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(PURGE_RECEIPTS_DDL)
        .map_err(StorageError::Database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn schema_9_creates_permanent_purge_receipts() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();
        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'purge_receipts'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1);
    }
}
