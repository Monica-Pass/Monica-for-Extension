use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

/// Additive metadata for classifying and safely retaining snapshots.
///
/// Legacy snapshot rows deliberately have no companion row and therefore
/// remain protected manual recovery points. The lifecycle table is local
/// recovery metadata; it is not part of the object sync state.
pub const SNAPSHOT_LIFECYCLE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS snapshot_lifecycle (
    snapshot_id             TEXT PRIMARY KEY NOT NULL,
    snapshot_kind           TEXT NOT NULL CHECK (snapshot_kind IN ('manual', 'automatic')),
    retention_eligible_at   TEXT,
    integrity_profile       TEXT NOT NULL CHECK (length(CAST(integrity_profile AS BLOB)) BETWEEN 1 AND 64),
    integrity_tag           BLOB NOT NULL CHECK (length(integrity_tag) = 32),
    FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE,
    CHECK (
        (snapshot_kind = 'manual' AND retention_eligible_at IS NULL)
        OR (snapshot_kind = 'automatic' AND retention_eligible_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_snapshot_lifecycle_retention
    ON snapshot_lifecycle(snapshot_kind, retention_eligible_at, snapshot_id);
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(SNAPSHOT_LIFECYCLE_DDL)
        .map_err(StorageError::Database)
}

pub fn validate_snapshot_lifecycle_schema(conn: &Connection) -> StorageResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'snapshot_lifecycle'
        )",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing required table snapshot_lifecycle".to_string(),
        ));
    }

    let invalid_rows: i64 = conn.query_row(
        "SELECT COUNT(*) FROM snapshot_lifecycle l
         LEFT JOIN snapshots s ON s.snapshot_id = l.snapshot_id
         WHERE s.snapshot_id IS NULL
            OR l.snapshot_kind NOT IN ('manual', 'automatic')
            OR l.integrity_profile <> 'hmac-sha256-v1'
            OR typeof(l.integrity_tag) <> 'blob'
            OR length(l.integrity_tag) <> 32
            OR length(CAST(l.snapshot_id AS BLOB)) NOT BETWEEN 1 AND 512
            OR (l.snapshot_kind = 'manual' AND l.retention_eligible_at IS NOT NULL)
            OR (l.snapshot_kind = 'automatic' AND l.retention_eligible_at IS NULL)",
        [],
        |row| row.get(0),
    )?;
    if invalid_rows != 0 {
        return Err(StorageError::Validation(
            "snapshot_lifecycle contains invalid or orphaned metadata".to_string(),
        ));
    }

    let index_exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_snapshot_lifecycle_retention'
        )",
        [],
        |row| row.get(0),
    )?;
    if !index_exists {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing snapshot lifecycle retention index".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::VaultConnection;
    use crate::init::{initialize_vault, VaultInitParams};

    #[test]
    fn new_vault_creates_snapshot_lifecycle_schema() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        validate_snapshot_lifecycle_schema(conn.inner()).unwrap();
    }
}
