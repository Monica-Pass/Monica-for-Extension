use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

pub const COMMIT_INVENTORY_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS commit_inventory (
    inventory_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_id     TEXT NOT NULL UNIQUE,
    FOREIGN KEY (commit_id) REFERENCES commits(commit_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_inventory_commit
    ON commit_inventory (commit_id);
"#;

pub const COMMIT_INVENTORY_TRIGGERS_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS trg_commit_inventory_after_commit_insert
AFTER INSERT ON commits
BEGIN
    INSERT INTO commit_inventory (commit_id) VALUES (NEW.commit_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_commit_inventory_parent_before_child
BEFORE INSERT ON commit_parents
WHEN NOT EXISTS (
        SELECT 1 FROM commit_inventory WHERE commit_id = NEW.commit_id
    )
    OR NOT EXISTS (
        SELECT 1 FROM commit_inventory WHERE commit_id = NEW.parent_commit_id
    )
    OR (
        SELECT inventory_seq FROM commit_inventory WHERE commit_id = NEW.parent_commit_id
    ) >= (
        SELECT inventory_seq FROM commit_inventory WHERE commit_id = NEW.commit_id
    )
BEGIN
    SELECT RAISE(ABORT, 'commit parent must precede child in inventory');
END;
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(COMMIT_INVENTORY_DDL)
        .map_err(StorageError::Database)?;
    backfill_commit_inventory(conn)?;
    conn.execute_batch(COMMIT_INVENTORY_TRIGGERS_DDL)
        .map_err(StorageError::Database)?;
    validate_commit_inventory(conn)
}

fn backfill_commit_inventory(conn: &Connection) -> StorageResult<()> {
    loop {
        let remaining: i64 = conn.query_row(
            "SELECT COUNT(*)
             FROM commits c
             LEFT JOIN commit_inventory i ON i.commit_id = c.commit_id
             WHERE i.commit_id IS NULL",
            [],
            |row| row.get(0),
        )?;
        if remaining == 0 {
            return Ok(());
        }

        let inserted = conn.execute(
            "INSERT INTO commit_inventory (commit_id)
             SELECT c.commit_id
             FROM commits c
             WHERE NOT EXISTS (
                    SELECT 1 FROM commit_inventory i WHERE i.commit_id = c.commit_id
                 )
               AND NOT EXISTS (
                    SELECT 1
                    FROM commit_parents cp
                    LEFT JOIN commit_inventory parent_inventory
                      ON parent_inventory.commit_id = cp.parent_commit_id
                    WHERE cp.commit_id = c.commit_id
                      AND parent_inventory.commit_id IS NULL
                 )
             ORDER BY c.created_at, c.commit_id",
            [],
        )?;
        if inserted == 0 {
            return Err(StorageError::Validation(format!(
                "commit inventory backfill cannot order {remaining} commits; commit DAG is cyclic or damaged"
            )));
        }
    }
}

pub(crate) fn validate_commit_inventory(conn: &Connection) -> StorageResult<()> {
    for trigger in [
        "trg_commit_inventory_after_commit_insert",
        "trg_commit_inventory_parent_before_child",
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?1
             )",
            [trigger],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::Validation(format!(
                "commit inventory is missing required trigger {trigger}"
            )));
        }
    }

    let missing_or_extra: i64 = conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM commits c
             LEFT JOIN commit_inventory i ON i.commit_id = c.commit_id
             WHERE i.commit_id IS NULL)
          + (SELECT COUNT(*) FROM commit_inventory i
             LEFT JOIN commits c ON c.commit_id = i.commit_id
             WHERE c.commit_id IS NULL)",
        [],
        |row| row.get(0),
    )?;
    if missing_or_extra != 0 {
        return Err(StorageError::Validation(format!(
            "commit inventory does not cover the commit table exactly: {missing_or_extra} mismatches"
        )));
    }

    let invalid_edges: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM commit_parents cp
         JOIN commit_inventory child ON child.commit_id = cp.commit_id
         JOIN commit_inventory parent ON parent.commit_id = cp.parent_commit_id
         WHERE parent.inventory_seq >= child.inventory_seq",
        [],
        |row| row.get(0),
    )?;
    if invalid_edges != 0 {
        return Err(StorageError::Validation(format!(
            "commit inventory violates parent-before-child order on {invalid_edges} edges"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn insert_commit(conn: &Connection, commit_id: &str, local_seq: i64, created_at: &str) {
        conn.execute(
            "INSERT INTO commits
                (commit_id, device_id, local_seq, commit_kind, change_scope,
                 changed_object_ids_ct, vector_clock, created_at, integrity_tag)
             VALUES (?1, 'device-1', ?2, 'change', 'vault', X'5B5D', '{}', ?3, X'00')",
            rusqlite::params![commit_id, local_seq, created_at],
        )
        .unwrap();
    }

    #[test]
    fn future_commits_receive_strictly_increasing_inventory_sequences() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();

        insert_commit(&conn, "parent", 1, "2026-07-20T00:00:00Z");
        insert_commit(&conn, "child", 2, "2026-07-20T00:00:01Z");
        conn.execute(
            "INSERT INTO commit_parents (commit_id, parent_commit_id) VALUES ('child', 'parent')",
            [],
        )
        .unwrap();

        let sequences: (i64, i64) = conn
            .query_row(
                "SELECT parent.inventory_seq, child.inventory_seq
                 FROM commit_inventory parent CROSS JOIN commit_inventory child
                 WHERE parent.commit_id = 'parent' AND child.commit_id = 'child'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(sequences.0 < sequences.1);
    }

    #[test]
    fn late_parent_edges_cannot_break_inventory_causality() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        schema::create_all_tables(&conn).unwrap();

        insert_commit(&conn, "child", 1, "2026-07-20T00:00:00Z");
        insert_commit(&conn, "late-parent", 2, "2026-07-20T00:00:01Z");
        let error = conn
            .execute(
                "INSERT INTO commit_parents (commit_id, parent_commit_id)
                 VALUES ('child', 'late-parent')",
                [],
            )
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("commit parent must precede child in inventory"));
    }
}
