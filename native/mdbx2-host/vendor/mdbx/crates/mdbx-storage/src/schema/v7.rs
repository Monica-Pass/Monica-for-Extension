use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

/// Generic encrypted metadata introduced by MDBX2 schema 7.
///
/// Physical `entries` and `projects` remain the MDBX1 compatibility storage.
/// These additive tables carry domain-neutral edges and classifications.
pub const GENERIC_METADATA_DDL: &str = "\
CREATE TABLE IF NOT EXISTS object_relations (
    relation_id             TEXT PRIMARY KEY NOT NULL,
    source_object_id        TEXT NOT NULL,
    target_object_id        TEXT NOT NULL,
    relation_kind           TEXT NOT NULL,
    payload_ct              BLOB NOT NULL,
    payload_schema_version  INTEGER NOT NULL DEFAULT 1
                                CHECK (payload_schema_version > 0),
    object_clock            TEXT NOT NULL,
    head_commit_id          TEXT NOT NULL,
    deleted                 INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    created_by_device_id    TEXT NOT NULL,
    updated_by_device_id    TEXT NOT NULL,
    FOREIGN KEY (source_object_id) REFERENCES entries(entry_id),
    FOREIGN KEY (target_object_id) REFERENCES entries(entry_id),
    FOREIGN KEY (head_commit_id) REFERENCES commits(commit_id)
);

CREATE TABLE IF NOT EXISTS object_labels (
    label_id                TEXT PRIMARY KEY NOT NULL,
    collection_id           TEXT NOT NULL,
    name_ct                 BLOB NOT NULL,
    payload_ct              BLOB NOT NULL,
    payload_schema_version  INTEGER NOT NULL DEFAULT 1
                                CHECK (payload_schema_version > 0),
    object_clock            TEXT NOT NULL,
    head_commit_id          TEXT NOT NULL,
    deleted                 INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    created_by_device_id    TEXT NOT NULL,
    updated_by_device_id    TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES projects(project_id),
    FOREIGN KEY (head_commit_id) REFERENCES commits(commit_id)
);

CREATE TABLE IF NOT EXISTS object_label_assignments (
    assignment_id           TEXT PRIMARY KEY NOT NULL,
    object_id               TEXT NOT NULL,
    label_id                TEXT NOT NULL,
    object_clock            TEXT NOT NULL,
    head_commit_id          TEXT NOT NULL,
    deleted                 INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    created_by_device_id    TEXT NOT NULL,
    updated_by_device_id    TEXT NOT NULL,
    FOREIGN KEY (object_id) REFERENCES entries(entry_id),
    FOREIGN KEY (label_id) REFERENCES object_labels(label_id),
    FOREIGN KEY (head_commit_id) REFERENCES commits(commit_id)
);

CREATE INDEX IF NOT EXISTS idx_object_relations_source
    ON object_relations (source_object_id, relation_kind, deleted);
CREATE INDEX IF NOT EXISTS idx_object_relations_target
    ON object_relations (target_object_id, relation_kind, deleted);
CREATE INDEX IF NOT EXISTS idx_object_labels_collection
    ON object_labels (collection_id, deleted, updated_at);
CREATE INDEX IF NOT EXISTS idx_object_label_assignments_object
    ON object_label_assignments (object_id, deleted);
CREATE INDEX IF NOT EXISTS idx_object_label_assignments_label
    ON object_label_assignments (label_id, deleted);
CREATE UNIQUE INDEX IF NOT EXISTS idx_object_label_assignments_active_unique
    ON object_label_assignments (object_id, label_id)
    WHERE deleted = 0;";

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(GENERIC_METADATA_DDL)
        .map_err(StorageError::Database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn schema_7_creates_generic_metadata_tables_and_indexes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();

        for table in [
            "object_relations",
            "object_labels",
            "object_label_assignments",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "missing table {table}");
        }

        let partial_index_sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_object_label_assignments_active_unique'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(partial_index_sql.contains("WHERE deleted = 0"));
    }
}
