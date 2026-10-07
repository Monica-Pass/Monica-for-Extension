use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

pub const SCHEMA_MIGRATIONS_DDL: &str = "\
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY NOT NULL,
    from_format  TEXT NOT NULL,
    to_format    TEXT NOT NULL,
    applied_at   TEXT NOT NULL
);";

/// MDBX2 commit operation state. These tables are additive: MDBX1 readers
/// continue to read the legacy `commits` projection and never write these
/// unknown tables.
pub const COMMIT2_DDL: &str = "\
CREATE TABLE IF NOT EXISTS commit_operations (
    operation_id       TEXT PRIMARY KEY NOT NULL,
    commit_id          TEXT NOT NULL UNIQUE,
    operation_kind     TEXT NOT NULL,
    branch_id          TEXT,
    branch_name        TEXT NOT NULL,
    change_summary_ct  BLOB NOT NULL,
    request_hash       BLOB NOT NULL,
    created_at         TEXT NOT NULL,
    integrity_tag      BLOB NOT NULL,
    FOREIGN KEY (commit_id) REFERENCES commits(commit_id)
);

CREATE TABLE IF NOT EXISTS commit_device_sequences (
    device_id          TEXT PRIMARY KEY NOT NULL,
    last_local_seq     INTEGER NOT NULL CHECK (last_local_seq >= 0)
);

CREATE INDEX IF NOT EXISTS idx_commit_operations_commit
    ON commit_operations (commit_id);
CREATE INDEX IF NOT EXISTS idx_commit_operations_kind
    ON commit_operations (operation_kind, created_at);";

pub const COMMIT2_BRANCH_ID_INDEX_DDL: &str = "\
CREATE INDEX IF NOT EXISTS idx_commit_operations_branch
    ON commit_operations (branch_id, created_at)
    WHERE branch_id IS NOT NULL;";

pub const TIGA_POLICY_DDL: &str = "\
CREATE TABLE IF NOT EXISTS tiga_policy_exceptions (
    exception_id         TEXT PRIMARY KEY NOT NULL,
    target_scope         TEXT NOT NULL CHECK (target_scope IN ('vault', 'project', 'entry', 'attachment')),
    target_id            TEXT NOT NULL,
    approved_override_json TEXT NOT NULL,
    reason               TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    expires_at_unix_secs INTEGER,
    created_at           TEXT NOT NULL,
    created_by_session_id TEXT,
    revoked_at           TEXT,
    integrity_tag        BLOB
);

CREATE TABLE IF NOT EXISTS tiga_policy_overrides (
    scope_type           TEXT NOT NULL CHECK (scope_type IN ('vault', 'project', 'entry', 'attachment')),
    scope_id             TEXT NOT NULL,
    policy_json          TEXT NOT NULL,
    exception_id         TEXT,
    updated_at           TEXT NOT NULL,
    updated_by_device_id TEXT NOT NULL,
    integrity_tag        BLOB,
    PRIMARY KEY (scope_type, scope_id),
    FOREIGN KEY (exception_id) REFERENCES tiga_policy_exceptions(exception_id)
);

CREATE TABLE IF NOT EXISTS security_audit_events (
    event_id             TEXT PRIMARY KEY NOT NULL,
    occurred_at          TEXT NOT NULL,
    operation            TEXT NOT NULL,
    outcome              TEXT NOT NULL,
    scope_type           TEXT NOT NULL,
    scope_id             TEXT NOT NULL,
    session_id           TEXT,
    device_id            TEXT,
    reason_codes_json    TEXT NOT NULL,
    constraints_json     TEXT NOT NULL,
    exception_id         TEXT,
    operation_id         TEXT,
    commit_id            TEXT,
    policy_version       INTEGER CHECK (policy_version IS NULL OR policy_version > 0),
    policy_fingerprint   BLOB,
    integrity_tag        BLOB
);

CREATE INDEX IF NOT EXISTS idx_security_audit_occurred
    ON security_audit_events (occurred_at, event_id);
CREATE INDEX IF NOT EXISTS idx_tiga_exceptions_target
    ON tiga_policy_exceptions (target_scope, target_id, revoked_at);";

pub const TIGA_AUDIT_CORRELATION_INDEX_DDL: &str = "\
CREATE INDEX IF NOT EXISTS idx_security_audit_operation
    ON security_audit_events (operation_id)
    WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_security_audit_commit
    ON security_audit_events (commit_id)
    WHERE commit_id IS NOT NULL;";

/// Add MDBX2-only schema objects to a newly created database.
///
/// Existing MDBX-1 databases use `migration::upgrade_to_latest`, which adds
/// the same columns defensively before recording the migration.
pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    add_column_if_missing(
        conn,
        "vault_meta",
        "schema_version",
        "INTEGER NOT NULL DEFAULT 2",
    )?;
    add_column_if_missing(
        conn,
        "vault_meta",
        "min_reader_version",
        "TEXT NOT NULL DEFAULT 'MDBX-1'",
    )?;
    add_column_if_missing(
        conn,
        "vault_meta",
        "min_writer_version",
        "TEXT NOT NULL DEFAULT 'MDBX-2'",
    )?;
    add_column_if_missing(
        conn,
        "vault_meta",
        "tiga_policy_version",
        "INTEGER NOT NULL DEFAULT 2",
    )?;
    add_column_if_missing(
        conn,
        "vault_meta",
        "tiga_compliance_status",
        "TEXT NOT NULL DEFAULT 'compliant'",
    )?;
    conn.execute_batch(&format!(
        "{SCHEMA_MIGRATIONS_DDL}{COMMIT2_DDL}{TIGA_POLICY_DDL}"
    ))?;
    add_column_if_missing(conn, "commit_operations", "branch_id", "TEXT")?;
    conn.execute_batch(COMMIT2_BRANCH_ID_INDEX_DDL)?;
    add_column_if_missing(conn, "security_audit_events", "operation_id", "TEXT")?;
    add_column_if_missing(conn, "security_audit_events", "commit_id", "TEXT")?;
    add_column_if_missing(
        conn,
        "security_audit_events",
        "policy_version",
        "INTEGER CHECK (policy_version IS NULL OR policy_version > 0)",
    )?;
    add_column_if_missing(conn, "security_audit_events", "policy_fingerprint", "BLOB")?;
    conn.execute_batch(TIGA_AUDIT_CORRELATION_INDEX_DDL)
        .map_err(StorageError::Database)
}

pub(crate) fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> StorageResult<()> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }

    // All identifiers and definitions are internal constants, never user input.
    conn.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition};"
    ))
    .map_err(StorageError::Database)
}

pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> StorageResult<bool> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(StorageError::Database)?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(StorageError::Database)?;
    for row in rows {
        if row.map_err(StorageError::Database)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
