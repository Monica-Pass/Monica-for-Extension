use rusqlite::{params, Connection};

use crate::error::{StorageError, StorageResult};
use crate::schema::v2;

pub const TOMBSTONE_ACKNOWLEDGEMENTS_DDL: &str = "\
CREATE TABLE IF NOT EXISTS tombstone_acknowledgements (
    tombstone_id       TEXT NOT NULL,
    device_id          TEXT NOT NULL,
    observed_commit_id TEXT NOT NULL,
    acknowledged_at    TEXT NOT NULL,
    PRIMARY KEY (tombstone_id, device_id),
    FOREIGN KEY (tombstone_id) REFERENCES tombstones(tombstone_id) ON DELETE CASCADE,
    FOREIGN KEY (observed_commit_id) REFERENCES commits(commit_id)
);

CREATE INDEX IF NOT EXISTS idx_tombstone_ack_device
    ON tombstone_acknowledgements (device_id, tombstone_id);

CREATE INDEX IF NOT EXISTS idx_tombstones_delete_commit
    ON tombstones (delete_commit_id)
    WHERE delete_commit_id IS NOT NULL;";

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    v2::add_column_if_missing(
        conn,
        "tombstones",
        "delete_commit_id",
        "TEXT REFERENCES commits(commit_id)",
    )?;
    backfill_delete_commit_ids(conn)?;
    conn.execute_batch(TOMBSTONE_ACKNOWLEDGEMENTS_DDL)
        .map_err(StorageError::Database)?;
    backfill_deleting_device_acknowledgements(conn)
}

fn backfill_deleting_device_acknowledgements(conn: &Connection) -> StorageResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO tombstone_acknowledgements
            (tombstone_id, device_id, observed_commit_id, acknowledged_at)
         SELECT tombstone_id, deleted_by_device_id, delete_commit_id, deleted_at
         FROM tombstones
         WHERE delete_commit_id IS NOT NULL",
        [],
    )
    .map(|_| ())
    .map_err(StorageError::Database)
}

fn backfill_delete_commit_ids(conn: &Connection) -> StorageResult<()> {
    for (target_type, table, id_column) in [
        ("project", "projects", "project_id"),
        ("entry", "entries", "entry_id"),
        ("attachment", "attachments", "attachment_id"),
        ("object-relation", "object_relations", "relation_id"),
        ("object-label", "object_labels", "label_id"),
        (
            "object-label-assignment",
            "object_label_assignments",
            "assignment_id",
        ),
    ] {
        let sql = format!(
            "UPDATE tombstones
             SET delete_commit_id = (
                 SELECT head_commit_id FROM {table}
                 WHERE {id_column} = tombstones.target_object_id AND deleted = 1
             )
             WHERE delete_commit_id IS NULL AND target_object_type = ?1"
        );
        conn.execute(&sql, params![target_type])
            .map_err(StorageError::Database)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn schema_8_adds_delete_commit_proof_column_and_index() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();

        assert!(v2::column_exists(&conn, "tombstones", "delete_commit_id").unwrap());
        let ack_table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'tombstone_acknowledgements'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ack_table_count, 1);
        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_tombstones_delete_commit'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 1);
    }
}
