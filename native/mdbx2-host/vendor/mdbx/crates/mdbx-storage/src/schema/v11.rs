use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

pub const COLLECTION_PROFILES_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS collection_profiles (
    project_id                    TEXT PRIMARY KEY NOT NULL,
    collection_type_id            TEXT NOT NULL CHECK (
        length(collection_type_id) BETWEEN 1 AND 128
    ),
    payload_ct                    BLOB NOT NULL,
    payload_schema_version        INTEGER NOT NULL CHECK (
        payload_schema_version BETWEEN 1 AND 4294967295
    ),
    allowed_object_type_ids_json  TEXT NOT NULL,
    required_capability_ids_json  TEXT NOT NULL,
    created_at                    TEXT NOT NULL,
    updated_at                    TEXT NOT NULL,
    created_by_device_id          TEXT NOT NULL,
    updated_by_device_id          TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_profiles_type
    ON collection_profiles (collection_type_id, project_id);
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(COLLECTION_PROFILES_DDL)
        .map_err(StorageError::Database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    #[test]
    fn schema_11_creates_collection_profiles_with_project_ownership() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();

        let profile_table: String = conn
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collection_profiles'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(profile_table, "collection_profiles");

        let foreign_key_target: String = conn
            .query_row("PRAGMA foreign_key_list(collection_profiles)", [], |row| {
                row.get(2)
            })
            .unwrap();
        assert_eq!(foreign_key_target, "projects");
    }
}
