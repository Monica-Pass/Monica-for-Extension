use std::collections::HashMap;

use mdbx_core::model::{KdfParams, UnlockMethodType};
use mdbx_core::tiga::{TigaMode, TigaPolicyOverride, TIGA_POLICY_VERSION};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::Path;

use crate::error::{StorageError, StorageResult};
use crate::schema::{v10, v11, v12, v13, v14, v15, v16, v17, v2, v7, v8, v9};

pub const FORMAT_V1: &str = "MDBX-1";
pub const FORMAT_V1_DRAFT: &str = "MDBX-1-DRAFT";
pub const FORMAT_V2: &str = "MDBX-2";
pub const CURRENT_SCHEMA_VERSION: u32 = 17;
pub const MIGRATION_V1_TO_V2: &str = "mdbx-1-to-mdbx-2";
pub const MIGRATION_TIGA2_POLICY: &str = "mdbx-2-tiga-policy-v2";
pub const MIGRATION_COMMIT2: &str = "mdbx-2-operation-commits-v1";
pub const MIGRATION_TIGA_AUDIT_CORRELATION: &str = "mdbx-2-tiga-audit-correlation-v1";
pub const MIGRATION_STABLE_BRANCH_ID: &str = "mdbx-2-stable-branch-id-v1";
pub const MIGRATION_GENERIC_METADATA: &str = "mdbx-2-generic-metadata-v1";
pub const MIGRATION_TOMBSTONE_DELETE_PROOF: &str = "mdbx-2-tombstone-delete-proof-v1";
pub const MIGRATION_PURGE_RECEIPTS: &str = "mdbx-2-purge-receipts-v1";
pub const MIGRATION_TIGA_ATTACHMENT_SCOPE: &str = "mdbx-2-tiga-attachment-scope-v1";
pub const MIGRATION_COLLECTION_PROFILES: &str = "mdbx-2-collection-profiles-v1";
pub const MIGRATION_COMMIT_INVENTORY: &str = "mdbx-2-commit-inventory-v1";
pub const MIGRATION_SYNC_DELTA_BATCHES: &str = "mdbx-2-sync-delta-batches-v1";
pub const MIGRATION_SYNC_DELTA_CAPTURE: &str = "mdbx-2-sync-delta-capture-v1";
pub const MIGRATION_SYNC_STATE_EXTENSIONS: &str = "mdbx-2-sync-state-extensions-v1";
pub const MIGRATION_VAULT_HEADER_AUTH: &str = "mdbx-2-vault-header-auth-v1";
pub const FIELD_KEY_EPOCHS_EXTENSION: &str = "field-key-epochs-v1";
pub const SNAPSHOT_RECORD_AUTH_EXTENSION: &str = "snapshot-record-auth-v1";
pub const AUTHENTICATED_STATE_ROOT_EXTENSION: &str = "authenticated-state-root-v1";
pub const MIGRATION_SNAPSHOT_LIFECYCLE: &str = "mdbx-2-snapshot-lifecycle-v1";

const SUPPORTED_CRITICAL_EXTENSIONS: &[&str] = &[
    FIELD_KEY_EPOCHS_EXTENSION,
    SNAPSHOT_RECORD_AUTH_EXTENSION,
    AUTHENTICATED_STATE_ROOT_EXTENSION,
];
const MAX_PRE_MIGRATION_INTEGRITY_ISSUES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatInfo {
    pub format_version: String,
    pub schema_version: u32,
    pub min_reader_version: String,
    pub min_writer_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationInfo {
    pub initialized: bool,
    pub format_version: Option<String>,
    pub schema_version: Option<u32>,
    pub min_reader_version: Option<String>,
    pub min_writer_version: Option<String>,
    pub requires_upgrade: bool,
    pub unknown_critical_extensions: bool,
    pub target_format_version: String,
    pub target_schema_version: u32,
}

/// Inspect a vault without changing it. This is the client-facing planning
/// step for backup, consent, progress, and remediation UI.
pub fn inspect_migration(conn: &Connection) -> StorageResult<MigrationInfo> {
    if !table_exists(conn, "vault_meta")? {
        return Ok(MigrationInfo {
            initialized: false,
            format_version: None,
            schema_version: None,
            min_reader_version: None,
            min_writer_version: None,
            requires_upgrade: false,
            unknown_critical_extensions: false,
            target_format_version: FORMAT_V2.to_string(),
            target_schema_version: CURRENT_SCHEMA_VERSION,
        });
    }

    let meta: Option<(String, String)> = conn
        .query_row(
            "SELECT format_version, critical_extensions FROM vault_meta LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::Database)?;
    let Some((format_version, critical_extensions)) = meta else {
        return Ok(MigrationInfo {
            initialized: false,
            format_version: None,
            schema_version: None,
            min_reader_version: None,
            min_writer_version: None,
            requires_upgrade: false,
            unknown_critical_extensions: false,
            target_format_version: FORMAT_V2.to_string(),
            target_schema_version: CURRENT_SCHEMA_VERSION,
        });
    };

    let schema_version = if v2::column_exists(conn, "vault_meta", "schema_version")? {
        conn.query_row("SELECT schema_version FROM vault_meta LIMIT 1", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .map(|value| value as u32)
    } else {
        Some(1)
    };
    let min_reader_version = optional_meta_text(conn, "min_reader_version")?;
    let min_writer_version = optional_meta_text(conn, "min_writer_version")?;
    let requires_upgrade = match format_version.as_str() {
        FORMAT_V1 | FORMAT_V1_DRAFT => true,
        FORMAT_V2 => schema_version.unwrap_or(1) < CURRENT_SCHEMA_VERSION,
        other => {
            return Err(StorageError::Validation(format!(
                "unsupported MDBX format version: {other}"
            )))
        }
    };

    Ok(MigrationInfo {
        initialized: true,
        format_version: Some(format_version),
        schema_version,
        min_reader_version,
        min_writer_version,
        requires_upgrade,
        unknown_critical_extensions: has_unknown_critical_extensions(&critical_extensions),
        target_format_version: FORMAT_V2.to_string(),
        target_schema_version: CURRENT_SCHEMA_VERSION,
    })
}

/// Inspect a vault file using a read-only SQLite handle.
pub fn inspect_migration_path(path: &Path) -> StorageResult<MigrationInfo> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StorageError::Database)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(StorageError::Database)?;
    let info = inspect_migration(&conn)?;
    if info.initialized && info.requires_upgrade && !info.unknown_critical_extensions {
        verify_pre_migration_integrity(&conn)?;
    }
    Ok(info)
}

pub(crate) fn preflight_existing_vault(path: &Path) -> StorageResult<MigrationInfo> {
    let info = inspect_migration_path(path)?;
    if !info.initialized {
        return Err(StorageError::Validation(format!(
            "not an initialized MDBX vault: {}",
            path.display()
        )));
    }
    if info.unknown_critical_extensions {
        return Err(StorageError::Validation(
            "vault requires unsupported critical extensions".to_string(),
        ));
    }
    Ok(info)
}

/// Explicitly upgrade a vault file through the storage-core migration path.
/// The existing `VaultConnection::open` path remains an automatic-upgrade
/// compatibility path; clients that need consent and backup orchestration can
/// call this function after `inspect_migration_path`.
pub fn upgrade_path(path: &Path) -> StorageResult<Option<FormatInfo>> {
    preflight_existing_vault(path)?;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(StorageError::Database)?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
        .map_err(StorageError::Database)?;
    upgrade_to_latest(&conn)
}

fn optional_meta_text(conn: &Connection, column: &str) -> StorageResult<Option<String>> {
    if !v2::column_exists(conn, "vault_meta", column)? {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT {column} FROM vault_meta LIMIT 1"),
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(StorageError::Database)
}

/// Upgrade an initialized vault to the latest supported generation.
///
/// The format marker is updated last inside one SQLite transaction. An empty
/// database is left untouched so `VaultConnection::create` can initialize it.
pub fn upgrade_to_latest(conn: &Connection) -> StorageResult<Option<FormatInfo>> {
    if !table_exists(conn, "vault_meta")? {
        return Ok(None);
    }

    let meta: Option<(String, String)> = conn
        .query_row(
            "SELECT format_version, critical_extensions FROM vault_meta LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::Database)?;
    let Some((format_version, critical_extensions)) = meta else {
        return Ok(None);
    };

    reject_unknown_critical_extensions(&critical_extensions)?;
    let requires_upgrade = match format_version.as_str() {
        FORMAT_V1 | FORMAT_V1_DRAFT => true,
        FORMAT_V2 => {
            let schema_version = if v2::column_exists(conn, "vault_meta", "schema_version")? {
                conn.query_row("SELECT schema_version FROM vault_meta LIMIT 1", [], |row| {
                    row.get::<_, i64>(0)
                })
                .optional()?
                .unwrap_or(1) as u32
            } else {
                1
            };
            schema_version < CURRENT_SCHEMA_VERSION
        }
        other => {
            return Err(StorageError::Validation(format!(
                "unsupported MDBX format version: {other}"
            )))
        }
    };
    if requires_upgrade {
        verify_pre_migration_integrity(conn)?;
    }

    match format_version.as_str() {
        FORMAT_V1 | FORMAT_V1_DRAFT => migrate_v1_to_v2(conn, &format_version)?,
        FORMAT_V2 => upgrade_mdbx2_schema(conn)?,
        other => {
            return Err(StorageError::Validation(format!(
                "unsupported MDBX format version: {other}"
            )))
        }
    }

    read_format_info(conn).map(Some)
}

pub fn read_format_info(conn: &Connection) -> StorageResult<FormatInfo> {
    validate_current_schema(conn)?;
    conn.query_row(
        "SELECT format_version, schema_version, min_reader_version, min_writer_version
         FROM vault_meta LIMIT 1",
        [],
        |row| {
            Ok(FormatInfo {
                format_version: row.get(0)?,
                schema_version: row.get::<_, i64>(1)? as u32,
                min_reader_version: row.get(2)?,
                min_writer_version: row.get(3)?,
            })
        },
    )
    .map_err(StorageError::Database)
}

fn migrate_v1_to_v2(conn: &Connection, from_format: &str) -> StorageResult<()> {
    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")
        .map_err(StorageError::Database)?;

    let result = (|| -> StorageResult<()> {
        v2::add_column_if_missing(
            conn,
            "vault_meta",
            "schema_version",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        v2::add_column_if_missing(
            conn,
            "vault_meta",
            "min_reader_version",
            "TEXT NOT NULL DEFAULT 'MDBX-1'",
        )?;
        v2::add_column_if_missing(
            conn,
            "vault_meta",
            "min_writer_version",
            "TEXT NOT NULL DEFAULT 'MDBX-1'",
        )?;
        conn.execute_batch(v2::SCHEMA_MIGRATIONS_DDL)
            .map_err(StorageError::Database)?;
        v2::create_extensions(conn)?;
        v7::create_extensions(conn)?;
        v8::create_extensions(conn)?;
        v9::create_extensions(conn)?;
        v10::create_extensions(conn)?;
        v11::create_extensions(conn)?;
        v12::create_extensions(conn)?;
        v13::create_extensions(conn)?;
        v14::create_extensions(conn)?;
        v15::create_extensions(conn)?;
        v16::create_extensions(conn)?;
        v17::create_extensions(conn)?;

        let now = chrono::Utc::now().to_rfc3339();
        v13::initialize_bootstrap_floor(conn, &now)?;
        let remediation_required = migrate_tiga1_policy(conn, &now)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_V1_TO_V2, from_format, FORMAT_V2, now],
        )
        .map_err(StorageError::Database)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_SYNC_DELTA_BATCHES, from_format, FORMAT_V2, now],
        )
        .map_err(StorageError::Database)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_COMMIT_INVENTORY, from_format, FORMAT_V2, now],
        )
        .map_err(StorageError::Database)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_SYNC_DELTA_CAPTURE, from_format, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_SYNC_STATE_EXTENSIONS, from_format, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_VAULT_HEADER_AUTH, from_format, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
             (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![MIGRATION_SNAPSHOT_LIFECYCLE, from_format, FORMAT_V2, now],
        )?;
        v14::discard_bootstrap_mutations(conn)?;

        // The generation marker is deliberately the final mutation.
        conn.execute(
            "UPDATE vault_meta SET format_version = ?1, schema_version = ?2,
             min_reader_version = ?3, min_writer_version = ?4, updated_at = ?5,
             tiga_policy_version = ?6, tiga_compliance_status = ?7",
            params![
                FORMAT_V2,
                CURRENT_SCHEMA_VERSION,
                FORMAT_V1,
                FORMAT_V2,
                now,
                TIGA_POLICY_VERSION,
                if remediation_required {
                    "remediation-required"
                } else {
                    "compliant"
                }
            ],
        )
        .map_err(StorageError::Database)?;
        validate_current_schema(conn)?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(StorageError::Database),
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(err)
        }
    }
}

fn upgrade_mdbx2_schema(conn: &Connection) -> StorageResult<()> {
    let schema_version = if v2::column_exists(conn, "vault_meta", "schema_version")? {
        conn.query_row("SELECT schema_version FROM vault_meta LIMIT 1", [], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .unwrap_or(1) as u32
    } else {
        1
    };
    if schema_version >= CURRENT_SCHEMA_VERSION {
        return validate_current_schema(conn);
    }

    conn.execute_batch("BEGIN IMMEDIATE TRANSACTION;")?;
    let result = (|| -> StorageResult<()> {
        v2::create_extensions(conn)?;
        v7::create_extensions(conn)?;
        v8::create_extensions(conn)?;
        v9::create_extensions(conn)?;
        v10::create_extensions(conn)?;
        v11::create_extensions(conn)?;
        v12::create_extensions(conn)?;
        v13::create_extensions(conn)?;
        v14::create_extensions(conn)?;
        v15::create_extensions(conn)?;
        v16::create_extensions(conn)?;
        v17::create_extensions(conn)?;
        let now = chrono::Utc::now().to_rfc3339();
        v13::initialize_bootstrap_floor(conn, &now)?;
        let remediation_required = migrate_tiga1_policy(conn, &now)?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_TIGA2_POLICY, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_COMMIT2, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_TIGA_AUDIT_CORRELATION, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_STABLE_BRANCH_ID, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_GENERIC_METADATA, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_TOMBSTONE_DELETE_PROOF, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_PURGE_RECEIPTS, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_TIGA_ATTACHMENT_SCOPE, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_COLLECTION_PROFILES, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_COMMIT_INVENTORY, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_SYNC_DELTA_BATCHES, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_SYNC_DELTA_CAPTURE, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_SYNC_STATE_EXTENSIONS, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_VAULT_HEADER_AUTH, FORMAT_V2, now],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations
                (migration_id, from_format, to_format, applied_at)
             VALUES (?1, ?2, ?2, ?3)",
            params![MIGRATION_SNAPSHOT_LIFECYCLE, FORMAT_V2, now],
        )?;
        v14::discard_bootstrap_mutations(conn)?;
        conn.execute(
            "UPDATE vault_meta SET schema_version = ?1, tiga_policy_version = ?2,
             tiga_compliance_status = ?3, min_writer_version = ?4, updated_at = ?5",
            params![
                CURRENT_SCHEMA_VERSION,
                TIGA_POLICY_VERSION,
                if remediation_required {
                    "remediation-required"
                } else {
                    "compliant"
                },
                FORMAT_V2,
                now,
            ],
        )?;
        validate_current_schema(conn)?;
        Ok(())
    })();

    match result {
        Ok(()) => conn
            .execute_batch("COMMIT;")
            .map_err(StorageError::Database),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(error)
        }
    }?;
    validate_current_schema(conn)
}

fn migrate_tiga1_policy(conn: &Connection, now: &str) -> StorageResult<bool> {
    let default_mode_string: String =
        conn.query_row("SELECT default_tiga_mode FROM vault_meta", [], |row| {
            row.get(0)
        })?;
    let default_mode: TigaMode = default_mode_string
        .parse()
        .map_err(|error| StorageError::Validation(format!("invalid legacy Tiga mode: {error}")))?;
    let mut remediation_required = !legacy_unlock_configuration_complies(conn, default_mode)?;

    let mut project_modes = HashMap::<String, TigaMode>::new();
    let mut project_stmt = conn.prepare(
        "SELECT project_id, tiga_mode_override FROM projects WHERE tiga_mode_override IS NOT NULL",
    )?;
    let project_rows = project_stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in project_rows {
        let (project_id, mode_string) = row?;
        let mode: TigaMode = mode_string.parse().map_err(|error| {
            StorageError::Validation(format!(
                "invalid legacy project Tiga mode for {project_id}: {error}"
            ))
        })?;
        project_modes.insert(project_id.clone(), mode);
        if mode < default_mode {
            insert_legacy_policy_exception(
                conn,
                "project",
                &project_id,
                &TigaPolicyOverride::for_resource_profile(mode),
                now,
            )?;
            remediation_required = true;
        }
    }

    let mut entry_stmt = conn.prepare(
        "SELECT entry_id, project_id, tiga_mode_override
         FROM entries WHERE tiga_mode_override IS NOT NULL",
    )?;
    let entry_rows = entry_stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in entry_rows {
        let (entry_id, project_id, mode_string) = row?;
        let mode: TigaMode = mode_string.parse().map_err(|error| {
            StorageError::Validation(format!(
                "invalid legacy entry Tiga mode for {entry_id}: {error}"
            ))
        })?;
        let parent_mode = project_modes
            .get(&project_id)
            .copied()
            .unwrap_or(default_mode);
        if mode < parent_mode {
            insert_legacy_policy_exception(
                conn,
                "entry",
                &entry_id,
                &TigaPolicyOverride::for_resource_profile(mode),
                now,
            )?;
            remediation_required = true;
        }
    }

    Ok(remediation_required)
}

fn insert_legacy_policy_exception(
    conn: &Connection,
    scope: &str,
    scope_id: &str,
    policy_override: &TigaPolicyOverride,
    now: &str,
) -> StorageResult<()> {
    let json = serde_json::to_string(policy_override)
        .map_err(|error| StorageError::Validation(error.to_string()))?;
    conn.execute(
        "INSERT OR IGNORE INTO tiga_policy_exceptions
            (exception_id, target_scope, target_id, approved_override_json, reason,
             expires_at_unix_secs, created_at, created_by_session_id, revoked_at,
             integrity_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL, NULL, NULL)",
        params![
            format!("mdbx1-tiga-{scope}-{scope_id}"),
            scope,
            scope_id,
            json,
            "preserved automatically from a weaker MDBX1 Tiga override",
            now,
        ],
    )?;
    Ok(())
}

fn legacy_unlock_configuration_complies(conn: &Connection, mode: TigaMode) -> StorageResult<bool> {
    let mut stmt = conn.prepare("SELECT method_type, kdf_params_ct FROM unlock_methods")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    let mut method_count = 0_u32;
    let mut has_portable = false;
    let mut has_strong_combined = false;
    for row in rows {
        method_count += 1;
        let (method_type, kdf_params) = row?;
        let Ok(method_type) = UnlockMethodType::parse(&method_type) else {
            return Ok(false);
        };
        has_portable |= method_type.is_portable();
        if method_type.is_combined_password_security_key() {
            has_strong_combined |= KdfParams::from_json_bytes(&kdf_params)
                .map(|params| params.infer_tiga_mode() >= mode)
                .unwrap_or(false);
        }
    }
    if method_count == 0 {
        return Ok(false);
    }
    Ok(match mode {
        TigaMode::Power => has_strong_combined && !has_portable,
        TigaMode::Multi | TigaMode::Sky => has_portable,
    })
}

fn validate_current_schema(conn: &Connection) -> StorageResult<()> {
    for column in [
        "schema_version",
        "min_reader_version",
        "min_writer_version",
        "tiga_policy_version",
        "tiga_compliance_status",
    ] {
        if !v2::column_exists(conn, "vault_meta", column)? {
            return Err(StorageError::Validation(format!(
                "MDBX-2 vault is missing required vault_meta column {column}"
            )));
        }
    }
    if !v2::column_exists(conn, "commit_operations", "branch_id")? {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing required commit_operations column branch_id".to_string(),
        ));
    }
    if !v2::column_exists(conn, "tombstones", "delete_commit_id")? {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing required tombstones column delete_commit_id".to_string(),
        ));
    }
    if !table_exists(conn, "schema_migrations")? {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing schema_migrations".to_string(),
        ));
    }
    for table in [
        "tiga_policy_overrides",
        "tiga_policy_exceptions",
        "security_audit_events",
        "commit_operations",
        "commit_device_sequences",
        "object_relations",
        "object_labels",
        "object_label_assignments",
        "tombstone_acknowledgements",
        "purge_receipts",
        "collection_profiles",
        "commit_inventory",
        "sync_delta_meta",
        "sync_delta_batches",
        "sync_delta_batch_commits",
        "sync_delta_mutations",
        "sync_state_extensions",
    ] {
        if !table_exists(conn, table)? {
            return Err(StorageError::Validation(format!(
                "MDBX-2 vault is missing required table {table}"
            )));
        }
    }
    v12::validate_commit_inventory(conn)?;
    v13::validate_sync_delta_schema(conn)?;
    v14::validate_sync_delta_capture(conn)?;
    v15::validate_sync_state_extensions(conn)?;
    v16::validate_header_auth_schema(conn)?;
    v17::validate_snapshot_lifecycle_schema(conn)?;
    let critical_extensions: String = conn.query_row(
        "SELECT critical_extensions FROM vault_meta LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    if has_critical_extension(&critical_extensions, AUTHENTICATED_STATE_ROOT_EXTENSION)? {
        crate::integrity_root::validate_established_schema(conn)?;
    }
    for column in [
        "operation_id",
        "commit_id",
        "policy_version",
        "policy_fingerprint",
    ] {
        if !v2::column_exists(conn, "security_audit_events", column)? {
            return Err(StorageError::Validation(format!(
                "MDBX-2 vault is missing required security_audit_events column {column}"
            )));
        }
    }
    let (schema_version, policy_version): (i64, i64) = conn.query_row(
        "SELECT schema_version, tiga_policy_version FROM vault_meta",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if schema_version != i64::from(CURRENT_SCHEMA_VERSION) {
        return Err(StorageError::Validation(format!(
            "unsupported MDBX-2 schema version {schema_version}; expected {CURRENT_SCHEMA_VERSION}"
        )));
    }
    if policy_version != i64::from(TIGA_POLICY_VERSION) {
        return Err(StorageError::Validation(format!(
            "unsupported Tiga policy version {policy_version}; expected {TIGA_POLICY_VERSION}"
        )));
    }
    Ok(())
}

fn reject_unknown_critical_extensions(value: &str) -> StorageResult<()> {
    if !has_unknown_critical_extensions(value) {
        return Ok(());
    }

    Err(StorageError::Validation(format!(
        "vault requires unsupported critical extensions: {}",
        value.trim()
    )))
}

fn has_unknown_critical_extensions(value: &str) -> bool {
    parse_critical_extensions(value)
        .map(|extensions| {
            extensions
                .iter()
                .any(|extension| !SUPPORTED_CRITICAL_EXTENSIONS.contains(&extension.as_str()))
        })
        .unwrap_or(true)
}

pub(crate) fn merge_critical_extension(value: &str, extension: &str) -> StorageResult<String> {
    if !SUPPORTED_CRITICAL_EXTENSIONS.contains(&extension) {
        return Err(StorageError::Validation(format!(
            "cannot register unsupported critical extension: {}",
            extension
        )));
    }
    let mut extensions = parse_critical_extensions(value)?;
    if !extensions.iter().any(|current| current == extension) {
        extensions.push(extension.to_string());
    }
    extensions.sort();
    extensions.dedup();
    serde_json::to_string(&extensions).map_err(|error| {
        StorageError::Validation(format!("cannot serialize critical extensions: {}", error))
    })
}

pub(crate) fn has_critical_extension(value: &str, extension: &str) -> StorageResult<bool> {
    Ok(parse_critical_extensions(value)?
        .iter()
        .any(|current| current == extension))
}

fn parse_critical_extensions(value: &str) -> StorageResult<Vec<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return Ok(Vec::new());
    }

    let raw = if trimmed.starts_with('[') {
        serde_json::from_str::<Vec<String>>(trimmed).map_err(|error| {
            StorageError::Validation(format!("invalid critical_extensions JSON: {}", error))
        })?
    } else {
        trimmed.split(',').map(str::to_string).collect()
    };

    let mut extensions = Vec::with_capacity(raw.len());
    for extension in raw {
        let extension = extension.trim();
        if extension.is_empty() {
            return Err(StorageError::Validation(
                "critical extension identifiers must not be empty".to_string(),
            ));
        }
        extensions.push(extension.to_string());
    }
    Ok(extensions)
}

fn table_exists(conn: &Connection, table: &str) -> StorageResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![table],
        |row| row.get(0),
    )
    .map_err(StorageError::Database)
}

fn verify_pre_migration_integrity(conn: &Connection) -> StorageResult<()> {
    let has_legacy_fts = table_exists(conn, "project_titles_fts")?;
    let sqlite_check = "integrity_check";
    let mut integrity_check = conn
        .prepare(&format!("PRAGMA {sqlite_check}"))
        .map_err(|error| pre_migration_check_error(sqlite_check, error))?;
    let integrity_check_rows = integrity_check
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| pre_migration_check_error(sqlite_check, error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| pre_migration_check_error(sqlite_check, error))?;
    if integrity_check_rows.is_empty() {
        return Err(StorageError::Validation(format!(
            "pre-migration SQLite {sqlite_check} failed: no result returned"
        )));
    }
    let integrity_issues = integrity_check_rows
        .into_iter()
        .filter(|result| result != "ok")
        .filter(|result| !(has_legacy_fts && is_legacy_fts_readonly_integrity_issue(result)))
        .take(MAX_PRE_MIGRATION_INTEGRITY_ISSUES)
        .collect::<Vec<_>>();
    if !integrity_issues.is_empty() {
        return Err(StorageError::Validation(format!(
            "pre-migration SQLite {sqlite_check} failed: {}",
            integrity_issues.join("; ")
        )));
    }

    let mut foreign_key_check = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| pre_migration_check_error("foreign_key_check", error))?;
    let rows = foreign_key_check
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| pre_migration_check_error("foreign_key_check", error))?;
    let mut violations = Vec::new();
    for violation in rows.take(MAX_PRE_MIGRATION_INTEGRITY_ISSUES) {
        let (table, row_id, parent, foreign_key_id) =
            violation.map_err(|error| pre_migration_check_error("foreign_key_check", error))?;
        violations.push(format!(
            "table={table}, rowid={}, parent={parent}, fk={foreign_key_id}",
            row_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        ));
    }
    if !violations.is_empty() {
        return Err(StorageError::Validation(format!(
            "pre-migration foreign_key_check failed: {}",
            violations.join("; ")
        )));
    }
    Ok(())
}

fn pre_migration_check_error(check: &str, error: rusqlite::Error) -> StorageError {
    StorageError::Validation(format!(
        "pre-migration SQLite {check} could not complete: {error}"
    ))
}

fn is_legacy_fts_readonly_integrity_issue(result: &str) -> bool {
    result.contains("unable to validate the inverted index for FTS5 table")
        && result.contains("main.project_titles_fts")
        && result.contains("attempt to write a readonly database")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::VaultConnection;
    use crate::schema;

    fn v1_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('vault-1', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
            [],
        )
        .unwrap();
        conn
    }

    fn create_v1_file(path: &Path) {
        let conn = Connection::open(path).unwrap();
        crate::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('disk-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn schema_10_upgrades_add_collection_profiles_without_rewriting_projects() {
        let conn = v1_database();
        upgrade_to_latest(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO projects
                (project_id, title_ct, object_clock, head_commit_id,
                 created_at, updated_at, created_by_device_id, updated_by_device_id)
             VALUES ('project-1', X'01', '{}', 'head-1',
                     '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z',
                     'device-1', 'device-1');
             DROP TABLE collection_profiles;
             UPDATE vault_meta SET schema_version = 10;",
        )
        .unwrap();

        let info = upgrade_to_latest(&conn).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(table_exists(&conn, "collection_profiles").unwrap());
        let project_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_count, 1);
        let migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_COLLECTION_PROFILES],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
    }

    fn insert_legacy_password(conn: &Connection) -> Vec<u8> {
        let params = KdfParams::for_password().to_json_bytes();
        conn.execute(
            "INSERT INTO unlock_methods
                (method_id, method_type, kdf_profile_id, kdf_params_ct,
                 wrapped_vault_key_ct, created_at, updated_at)
             VALUES ('password-1', 'password', 'legacy', ?1, X'01020304',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            params![params],
        )
        .unwrap();
        params
    }

    #[test]
    fn upgrades_v1_to_mdbx2_and_preserves_identity() {
        let conn = v1_database();
        let info = upgrade_to_latest(&conn).unwrap().unwrap();
        assert_eq!(info.format_version, FORMAT_V2);
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(info.min_reader_version, FORMAT_V1);
        assert_eq!(info.min_writer_version, FORMAT_V2);

        let vault_id: String = conn
            .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
            .unwrap();
        assert_eq!(vault_id, "vault-1");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 7);
        let inventory_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_COMMIT_INVENTORY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(inventory_migration_count, 1);
        let header_auth_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_VAULT_HEADER_AUTH],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(header_auth_migration_count, 1);
        let lifecycle_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SNAPSHOT_LIFECYCLE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lifecycle_migration_count, 1);
        let lifecycle_table_exists: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'snapshot_lifecycle'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(lifecycle_table_exists);
        let delta_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SYNC_DELTA_BATCHES],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(delta_migration_count, 1);
        let capture_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SYNC_DELTA_CAPTURE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(capture_migration_count, 1);
        let policy_state: (i64, String) = conn
            .query_row(
                "SELECT tiga_policy_version, tiga_compliance_status FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(policy_state.0, i64::from(TIGA_POLICY_VERSION));
        assert_eq!(policy_state.1, "remediation-required");
    }

    #[test]
    fn mdbx1_upgrade_preserves_unknown_additive_columns_and_values() {
        let conn = v1_database();
        conn.execute_batch(
            "ALTER TABLE vault_meta ADD COLUMN future_vault_state TEXT;
             ALTER TABLE projects ADD COLUMN future_project_state BLOB;
             ALTER TABLE entries ADD COLUMN future_entry_state TEXT DEFAULT 'future-default';
             UPDATE vault_meta SET future_vault_state = 'keep-vault';
             INSERT INTO projects
                (project_id, title_ct, object_clock, head_commit_id,
                 created_at, updated_at, created_by_device_id,
                 updated_by_device_id, future_project_state)
             VALUES ('future-project', X'01', '{}', 'legacy-head',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                     'legacy-device', 'legacy-device', X'A1B2');
             INSERT INTO entries
                (entry_id, project_id, entry_type, payload_ct, object_clock,
                 head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id,
                 future_entry_state)
             VALUES ('future-entry', 'future-project', 'note', X'02', '{}',
                     'legacy-head', '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', 'legacy-device',
                     'legacy-device', 'keep-entry');",
        )
        .unwrap();

        upgrade_to_latest(&conn).unwrap().unwrap();

        for (table, column) in [
            ("vault_meta", "future_vault_state"),
            ("projects", "future_project_state"),
            ("entries", "future_entry_state"),
        ] {
            assert!(
                v2::column_exists(&conn, table, column).unwrap(),
                "missing {table}.{column} after upgrade"
            );
        }
        let vault_value: String = conn
            .query_row("SELECT future_vault_state FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        let project_value: Vec<u8> = conn
            .query_row(
                "SELECT future_project_state FROM projects
                 WHERE project_id = 'future-project'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let entry_value: String = conn
            .query_row(
                "SELECT future_entry_state FROM entries
                 WHERE entry_id = 'future-entry'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(vault_value, "keep-vault");
        assert_eq!(project_value, vec![0xA1, 0xB2]);
        assert_eq!(entry_value, "keep-entry");
    }

    #[test]
    fn v1_upgrade_backfills_tombstone_delete_proof_and_deleting_device_ack() {
        let conn = v1_database();
        conn.execute(
            "INSERT INTO commits
                (commit_id, device_id, local_seq, commit_kind, change_scope,
                 changed_object_ids_ct, vector_clock, message_ct, created_at, integrity_tag)
             VALUES ('delete-commit', 'legacy-device', 1, 'change', 'project',
                     X'01', '{\"legacy-device\":1}', NULL,
                     '2026-01-02T00:00:00Z', X'02')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects
                (project_id, title_ct, summary_ct, group_id, icon_ref, favorite,
                 archived, deleted, tiga_mode_override, object_clock, head_commit_id,
                 attachment_count, created_at, updated_at, created_by_device_id,
                 updated_by_device_id)
             VALUES ('deleted-project', X'01', NULL, NULL, NULL, 0, 0, 1, NULL,
                     '{\"counter\":2}', 'delete-commit', 0,
                     '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
                     'legacy-device', 'legacy-device')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tombstones
                (tombstone_id, target_object_type, target_object_id, delete_clock,
                 deleted_by_device_id, deleted_at, purge_eligible_at)
             VALUES ('legacy-tombstone', 'project', 'deleted-project', '{}',
                     'legacy-device', '2026-01-02T00:00:00Z', NULL)",
            [],
        )
        .unwrap();

        upgrade_to_latest(&conn).unwrap();

        let proof: Option<String> = conn
            .query_row(
                "SELECT delete_commit_id FROM tombstones WHERE tombstone_id = 'legacy-tombstone'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(proof.as_deref(), Some("delete-commit"));
        let acknowledgement: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tombstone_acknowledgements
                 WHERE tombstone_id = 'legacy-tombstone'
                   AND device_id = 'legacy-device'
                   AND observed_commit_id = 'delete-commit'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(acknowledgement, 1);
    }

    #[test]
    fn upgrade_is_idempotent() {
        let conn = v1_database();
        upgrade_to_latest(&conn).unwrap();
        let first = read_format_info(&conn).unwrap();
        upgrade_to_latest(&conn).unwrap();
        let second = read_format_info(&conn).unwrap();
        assert_eq!(first, second);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 7);
    }

    #[test]
    fn draft_v1_is_supported() {
        let conn = v1_database();
        conn.execute(
            "UPDATE vault_meta SET format_version = ?1",
            params![FORMAT_V1_DRAFT],
        )
        .unwrap();
        assert_eq!(
            upgrade_to_latest(&conn).unwrap().unwrap().format_version,
            FORMAT_V2
        );
    }

    #[test]
    fn unknown_critical_extensions_are_rejected_before_upgrade() {
        let conn = v1_database();
        conn.execute(
            "UPDATE vault_meta SET critical_extensions = 'future-secret-index'",
            [],
        )
        .unwrap();
        let err = upgrade_to_latest(&conn).unwrap_err();
        assert!(err.to_string().contains("unsupported critical extensions"));
        let version: String = conn
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, FORMAT_V1);
        assert!(!v2::column_exists(&conn, "vault_meta", "schema_version").unwrap());
    }

    #[test]
    fn field_key_epoch_extension_is_supported_during_upgrade() {
        let conn = v1_database();
        conn.execute(
            "UPDATE vault_meta SET critical_extensions = ?1",
            params![serde_json::to_string(&[FIELD_KEY_EPOCHS_EXTENSION]).unwrap()],
        )
        .unwrap();

        let inspection = inspect_migration(&conn).unwrap();
        assert!(!inspection.unknown_critical_extensions);
        assert_eq!(
            upgrade_to_latest(&conn).unwrap().unwrap().format_version,
            FORMAT_V2
        );
    }

    #[test]
    fn known_and_unknown_critical_extensions_still_reject() {
        let conn = v1_database();
        conn.execute(
            "UPDATE vault_meta SET critical_extensions = ?1",
            params![
                serde_json::to_string(&[FIELD_KEY_EPOCHS_EXTENSION, "future-secret-index"])
                    .unwrap()
            ],
        )
        .unwrap();

        let inspection = inspect_migration(&conn).unwrap();
        assert!(inspection.unknown_critical_extensions);
        assert!(upgrade_to_latest(&conn).is_err());
    }

    #[test]
    fn merge_critical_extension_is_canonical_and_idempotent() {
        let merged = merge_critical_extension("", FIELD_KEY_EPOCHS_EXTENSION).unwrap();
        let merged = merge_critical_extension(&merged, SNAPSHOT_RECORD_AUTH_EXTENSION).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&merged).unwrap(),
            vec![
                FIELD_KEY_EPOCHS_EXTENSION.to_string(),
                SNAPSHOT_RECORD_AUTH_EXTENSION.to_string()
            ]
        );
        assert_eq!(
            merge_critical_extension(&merged, SNAPSHOT_RECORD_AUTH_EXTENSION).unwrap(),
            merged
        );
    }

    #[test]
    fn migration_inspection_is_read_only_and_reports_legacy_upgrade() {
        let conn = v1_database();
        let info = inspect_migration(&conn).unwrap();
        assert!(info.initialized);
        assert_eq!(info.format_version.as_deref(), Some(FORMAT_V1));
        assert_eq!(info.schema_version, Some(1));
        assert!(info.requires_upgrade);
        assert!(!info.unknown_critical_extensions);

        let format: String = conn
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, FORMAT_V1);
    }

    #[test]
    fn current_migration_inspection_reports_no_upgrade() {
        let conn = VaultConnection::open_in_memory().unwrap();
        crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
        let info = inspect_migration(conn.inner()).unwrap();
        assert!(info.initialized);
        assert_eq!(info.format_version.as_deref(), Some(FORMAT_V2));
        assert_eq!(info.schema_version, Some(CURRENT_SCHEMA_VERSION));
        assert!(!info.requires_upgrade);
    }

    #[test]
    fn schema6_vault_gains_generic_metadata_tables() {
        let conn = VaultConnection::open_in_memory().unwrap();
        crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
        conn.inner()
            .execute_batch(
                "DROP TABLE object_label_assignments;
                 DROP TABLE object_labels;
                 DROP TABLE object_relations;
                 DELETE FROM schema_migrations WHERE migration_id = 'mdbx-2-generic-metadata-v1';
                 UPDATE vault_meta SET schema_version = 6;",
            )
            .unwrap();

        let inspection = inspect_migration(conn.inner()).unwrap();
        assert!(inspection.requires_upgrade);
        let info = upgrade_to_latest(conn.inner()).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        for table in [
            "object_relations",
            "object_labels",
            "object_label_assignments",
        ] {
            assert!(table_exists(conn.inner(), table).unwrap());
        }
        let migration_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_GENERIC_METADATA],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn schema8_vault_gains_permanent_purge_receipts() {
        let conn = VaultConnection::open_in_memory().unwrap();
        crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
        conn.inner()
            .execute_batch(
                "DROP TABLE purge_receipts;
                 DELETE FROM schema_migrations
                 WHERE migration_id = 'mdbx-2-purge-receipts-v1';
                 UPDATE vault_meta SET schema_version = 8;",
            )
            .unwrap();

        let inspection = inspect_migration(conn.inner()).unwrap();
        assert!(inspection.requires_upgrade);
        let info = upgrade_to_latest(conn.inner()).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(table_exists(conn.inner(), "purge_receipts").unwrap());
        let migration_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_PURGE_RECEIPTS],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn schema9_vault_preserves_policies_and_gains_attachment_tiga_scope() {
        let conn = VaultConnection::open_in_memory().unwrap();
        crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
        conn.inner()
            .execute_batch(
                "DROP TABLE tiga_policy_overrides;
                 DROP TABLE tiga_policy_exceptions;
                 CREATE TABLE tiga_policy_exceptions (
                    exception_id TEXT PRIMARY KEY NOT NULL,
                    target_scope TEXT NOT NULL CHECK (target_scope IN ('vault', 'project', 'entry')),
                    target_id TEXT NOT NULL,
                    approved_override_json TEXT NOT NULL,
                    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
                    expires_at_unix_secs INTEGER,
                    created_at TEXT NOT NULL,
                    created_by_session_id TEXT,
                    revoked_at TEXT,
                    integrity_tag BLOB
                 );
                 CREATE TABLE tiga_policy_overrides (
                    scope_type TEXT NOT NULL CHECK (scope_type IN ('vault', 'project', 'entry')),
                    scope_id TEXT NOT NULL,
                    policy_json TEXT NOT NULL,
                    exception_id TEXT,
                    updated_at TEXT NOT NULL,
                    updated_by_device_id TEXT NOT NULL,
                    integrity_tag BLOB,
                    PRIMARY KEY (scope_type, scope_id),
                    FOREIGN KEY (exception_id) REFERENCES tiga_policy_exceptions(exception_id)
                 );
                 CREATE INDEX idx_tiga_exceptions_target
                    ON tiga_policy_exceptions (target_scope, target_id, revoked_at);
                 INSERT INTO tiga_policy_overrides
                    (scope_type, scope_id, policy_json, updated_at, updated_by_device_id)
                 VALUES ('project', 'legacy-project', '{}', '2026-07-19T00:00:00Z', 'd1');
                 DELETE FROM schema_migrations
                 WHERE migration_id = 'mdbx-2-tiga-attachment-scope-v1';
                 UPDATE vault_meta SET schema_version = 9;",
            )
            .unwrap();

        let inspection = inspect_migration(conn.inner()).unwrap();
        assert!(inspection.requires_upgrade);
        let info = upgrade_to_latest(conn.inner()).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        let preserved: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM tiga_policy_overrides
                 WHERE scope_type = 'project' AND scope_id = 'legacy-project'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved, 1);
        conn.inner()
            .execute(
                "INSERT INTO tiga_policy_overrides
                    (scope_type, scope_id, policy_json, updated_at, updated_by_device_id)
                 VALUES ('attachment', 'attachment-1', '{}', '2026-07-20T00:00:00Z', 'd1')",
                [],
            )
            .unwrap();
        let migration_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_TIGA_ATTACHMENT_SCOPE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn explicit_upgrade_missing_path_does_not_create_a_file() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-missing-upgrade-{}.mdbx",
            uuid::Uuid::new_v4()
        ));

        let result = upgrade_path(&path);

        assert!(result.is_err());
        assert!(!path.exists());
    }

    #[test]
    fn explicit_upgrade_rejects_non_mdbx_sqlite_without_modifying_it() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-non-vault-upgrade-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE unrelated_data (value TEXT NOT NULL);
                 INSERT INTO unrelated_data VALUES ('preserve-me');",
            )
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let result = upgrade_path(&path);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pre_migration_integrity_rejects_foreign_key_damage_without_writing() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-fk-damaged-upgrade-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        create_v1_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
            conn.execute(
                "INSERT INTO entries
                    (entry_id, project_id, entry_type, payload_ct, object_clock,
                     head_commit_id, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                 VALUES ('orphan-entry', 'missing-project', 'note', X'01', '{}',
                         'missing-commit', '2026-01-01T00:00:00Z',
                         '2026-01-01T00:00:00Z', 'device-1', 'device-1')",
                [],
            )
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let error = upgrade_path(&path).unwrap_err();

        assert!(error.to_string().contains("foreign_key_check failed"));
        assert!(error.to_string().contains("table=entries"));
        assert!(error.to_string().contains("parent=projects"));
        let open_error = VaultConnection::open(&path).err().unwrap();
        assert!(open_error.to_string().contains("foreign_key_check failed"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let inspection_error = inspect_migration_path(&path).unwrap_err();
        assert!(inspection_error
            .to_string()
            .contains("foreign_key_check failed"));
        let format: String = Connection::open(&path)
            .unwrap()
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, FORMAT_V1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pre_migration_integrity_rejects_btree_damage_without_writing() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-btree-damaged-upgrade-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        create_v1_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "PRAGMA writable_schema=ON;
                 UPDATE sqlite_schema
                 SET rootpage = (SELECT rootpage FROM sqlite_schema WHERE name = 'projects')
                 WHERE name = 'idx_entries_project_id';
                 PRAGMA writable_schema=OFF;",
            )
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let error = upgrade_path(&path).unwrap_err();

        assert!(error.to_string().contains("integrity_check"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pre_migration_integrity_is_enforced_on_existing_connection() {
        let conn = v1_database();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute(
            "INSERT INTO entries
                (entry_id, project_id, entry_type, payload_ct, object_clock,
                 head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
             VALUES ('orphan-entry', 'missing-project', 'note', X'01', '{}',
                     'missing-commit', '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', 'device-1', 'device-1')",
            [],
        )
        .unwrap();

        let error = upgrade_to_latest(&conn).unwrap_err();

        assert!(error.to_string().contains("foreign_key_check failed"));
        let format: String = conn
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, FORMAT_V1);
        assert!(!v2::column_exists(&conn, "vault_meta", "schema_version").unwrap());
    }

    #[test]
    fn pre_migration_integrity_accepts_legacy_wal_state() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-wal-integrity-upgrade-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        crate::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('wal-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
            [],
        )
        .unwrap();
        let wal_path = std::path::PathBuf::from(format!("{}-wal", path.display()));
        let shm_path = std::path::PathBuf::from(format!("{}-shm", path.display()));
        assert!(wal_path.exists());

        let plan = inspect_migration_path(&path).unwrap();
        assert!(plan.requires_upgrade);
        let upgraded = upgrade_path(&path).unwrap().unwrap();
        assert_eq!(upgraded.format_version, FORMAT_V2);
        assert_eq!(upgraded.schema_version, CURRENT_SCHEMA_VERSION);

        drop(conn);
        let _ = std::fs::remove_file(wal_path);
        let _ = std::fs::remove_file(shm_path);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn migration_inspection_flags_unknown_critical_extensions_without_writing() {
        let conn = v1_database();
        conn.execute(
            "UPDATE vault_meta SET critical_extensions = 'future-extension'",
            [],
        )
        .unwrap();
        let info = inspect_migration(&conn).unwrap();
        assert!(info.unknown_critical_extensions);
        assert!(info.requires_upgrade);
        let error = upgrade_to_latest(&conn).unwrap_err();
        assert!(error.to_string().contains("critical extensions"));
        let format: String = conn
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, FORMAT_V1);
    }

    #[test]
    fn new_schema_is_mdbx2_ready() {
        let conn = Connection::open_in_memory().unwrap();
        schema::create_all_tables(&conn).unwrap();
        assert!(v2::column_exists(&conn, "vault_meta", "schema_version").unwrap());
        assert!(table_exists(&conn, "schema_migrations").unwrap());
        assert!(v2::column_exists(&conn, "vault_meta", "tiga_policy_version").unwrap());
        assert!(table_exists(&conn, "tiga_policy_overrides").unwrap());
        assert!(table_exists(&conn, "tiga_policy_exceptions").unwrap());
        assert!(table_exists(&conn, "security_audit_events").unwrap());
        assert!(v2::column_exists(&conn, "security_audit_events", "operation_id").unwrap());
        assert!(v2::column_exists(&conn, "security_audit_events", "commit_id").unwrap());
        assert!(v2::column_exists(&conn, "security_audit_events", "policy_version").unwrap());
        assert!(v2::column_exists(&conn, "security_audit_events", "policy_fingerprint").unwrap());
        assert!(table_exists(&conn, "commit_operations").unwrap());
        assert!(v2::column_exists(&conn, "commit_operations", "branch_id").unwrap());
        assert!(table_exists(&conn, "commit_device_sequences").unwrap());
        assert!(table_exists(&conn, "object_relations").unwrap());
        assert!(table_exists(&conn, "object_labels").unwrap());
        assert!(table_exists(&conn, "object_label_assignments").unwrap());
        assert!(table_exists(&conn, "commit_inventory").unwrap());
        assert!(table_exists(&conn, "sync_state_extensions").unwrap());
    }

    fn assert_real_mdbx1_fixture_upgrades_and_preserves_all_record_families(
        fixture: &[u8],
        manifest_json: &str,
    ) {
        use crate::repo::{
            AttachmentRepo, EntryRepo, ProjectRepo, SnapshotLifecycleRepo, SnapshotRepo,
        };
        use crate::unlock::UnlockService;
        use rusqlite::OpenFlags;
        use sha2::{Digest, Sha256};

        let manifest: serde_json::Value = serde_json::from_str(manifest_json).unwrap();
        let mut digest = Sha256::new();
        digest.update(fixture);
        assert_eq!(
            format!("{:X}", digest.finalize()),
            manifest["fixture_sha256"].as_str().unwrap()
        );
        assert_eq!(
            fixture.len(),
            manifest["fixture_bytes"].as_u64().unwrap() as usize
        );

        let path = std::env::temp_dir().join(format!(
            "mdbx1-release-golden-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, fixture).unwrap();

        let before = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let format: String = before
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, manifest["format"].as_str().unwrap());
        let before_counts: (i64, i64, i64, i64, i64) = before
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM projects),
                    (SELECT COUNT(*) FROM entries),
                    (SELECT COUNT(*) FROM attachments),
                    (SELECT COUNT(*) FROM snapshots),
                    (SELECT COUNT(*) FROM commits)",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(before_counts, (1, 1, 1, 1, 6));
        let before_commit_ids: Vec<String> = {
            let mut statement = before
                .prepare("SELECT commit_id FROM commits ORDER BY commit_id")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let before_object_version_ids: Vec<(String, String, String)> = {
            let mut statement = before
                .prepare(
                    "SELECT object_type, object_id, commit_id
                     FROM object_versions
                     ORDER BY object_type, object_id, commit_id",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        drop(before);

        let plan = inspect_migration_path(&path).unwrap();
        assert!(plan.requires_upgrade);
        assert_eq!(plan.format_version.as_deref(), manifest["format"].as_str());
        assert_eq!(plan.schema_version, Some(1));
        let inspected_bytes = std::fs::read(&path).unwrap();
        let mut inspected_digest = Sha256::new();
        inspected_digest.update(&inspected_bytes);
        assert_eq!(
            format!("{:X}", inspected_digest.finalize()),
            manifest["fixture_sha256"].as_str().unwrap()
        );

        let info = upgrade_path(&path).unwrap().unwrap();
        assert_eq!(info.format_version, FORMAT_V2);
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);

        let mut conn = VaultConnection::open(&path).unwrap();
        UnlockService::unlock_with_password(
            &mut conn,
            manifest["test_unlock_password"].as_str().unwrap(),
        )
        .unwrap();
        let (header_profile, header_tag): (String, Option<Vec<u8>>) = conn
            .inner()
            .query_row(
                "SELECT header_integrity_profile, header_integrity_tag FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            header_profile,
            crate::schema::v16::HEADER_AUTH_HMAC_SHA256_V1_PROFILE
        );
        assert_eq!(header_tag.unwrap().len(), 32);
        let project_id = manifest["project_id"].as_str().unwrap();
        let project = ProjectRepo::get_by_id(&conn, project_id).unwrap().unwrap();
        assert_eq!(
            String::from_utf8(project.title_ct).unwrap(),
            manifest["project_title"].as_str().unwrap()
        );
        assert_eq!(project.group_id.as_deref(), Some("golden"));

        let entry_id = manifest["entry_id"].as_str().unwrap();
        let entry = EntryRepo::get_by_id(&conn, entry_id).unwrap().unwrap();
        assert_eq!(entry.project_id, project_id);
        assert_eq!(
            String::from_utf8(entry.title_ct.unwrap()).unwrap(),
            manifest["entry_title"].as_str().unwrap()
        );
        let payload: serde_json::Value = serde_json::from_slice(&entry.payload_ct).unwrap();
        assert_eq!(payload["username"], "golden-user");
        assert_eq!(payload["password"], "golden-secret");
        assert_eq!(payload["url"], "https://mdbx1.example");

        let tag_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM project_tags
                 WHERE project_id = ?1 AND tag = 'golden'",
                [project_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tag_count, 1);

        let attachment_id = manifest["attachment_id"].as_str().unwrap();
        let attachment = AttachmentRepo::get_by_id(&conn, attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            String::from_utf8(attachment.file_name_ct).unwrap(),
            manifest["attachment_file_name"].as_str().unwrap()
        );
        assert_eq!(
            AttachmentRepo::read_content(&conn, attachment_id).unwrap(),
            manifest["attachment_bytes"].as_str().unwrap().as_bytes()
        );
        assert!(SnapshotRepo::list_all(&conn)
            .unwrap()
            .iter()
            .any(|snapshot| snapshot.snapshot_id == manifest["snapshot_id"]));
        let legacy_lifecycle =
            SnapshotLifecycleRepo::get(&conn, manifest["snapshot_id"].as_str().unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(
            legacy_lifecycle.kind,
            mdbx_core::model::SnapshotKind::Manual
        );
        assert!(legacy_lifecycle.retention_eligible_at.is_none());
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM snapshot_lifecycle", [], |row| row
                    .get(0),)
                .unwrap(),
            0
        );

        let after_counts: (i64, i64, i64, i64, i64) = conn
            .inner()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM projects),
                    (SELECT COUNT(*) FROM entries),
                    (SELECT COUNT(*) FROM attachments),
                    (SELECT COUNT(*) FROM snapshots),
                    (SELECT COUNT(*) FROM commits)",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(after_counts, before_counts);
        let after_commit_ids: Vec<String> = {
            let mut statement = conn
                .inner()
                .prepare("SELECT commit_id FROM commits ORDER BY commit_id")
                .unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(after_commit_ids, before_commit_ids);
        let after_object_version_ids: Vec<(String, String, String)> = {
            let mut statement = conn
                .inner()
                .prepare(
                    "SELECT object_type, object_id, commit_id
                     FROM object_versions
                     ORDER BY object_type, object_id, commit_id",
                )
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        assert_eq!(after_object_version_ids, before_object_version_ids);

        let first_info = read_format_info(conn.inner()).unwrap();
        upgrade_to_latest(conn.inner()).unwrap();
        assert_eq!(read_format_info(conn.inner()).unwrap(), first_info);
        let migration_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SYNC_STATE_EXTENSIONS],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
        let lifecycle_migration_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SNAPSHOT_LIFECYCLE],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lifecycle_migration_count, 1);

        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("mdbx-wal"));
        let _ = std::fs::remove_file(path.with_extension("mdbx-shm"));
    }

    #[test]
    fn real_mdbx1_release_fixture_upgrades_and_preserves_all_record_families() {
        assert_real_mdbx1_fixture_upgrades_and_preserves_all_record_families(
            include_bytes!("../test-data/mdbx1-release-1.0.mdbx"),
            include_str!("../test-data/mdbx1-release-1.0.manifest.json"),
        );
    }

    #[test]
    fn real_mdbx1_draft_fixture_upgrades_and_preserves_all_record_families() {
        assert_real_mdbx1_fixture_upgrades_and_preserves_all_record_families(
            include_bytes!("../test-data/mdbx1-draft-golden.mdbx"),
            include_str!("../test-data/mdbx1-draft-golden.manifest.json"),
        );
    }

    #[test]
    fn schema17_validation_failure_rolls_back_marker_and_migration_rows() {
        use crate::init::{initialize_vault, VaultInitParams};
        use crate::repo::SnapshotRepo;

        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "migration-rollback-device".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        let snapshot = SnapshotRepo::create_snapshot(
            &conn,
            &crate::repo::CommitContext::new("migration-rollback-device".to_string()),
        )
        .unwrap();
        conn.inner()
            .execute(
                "INSERT INTO snapshot_lifecycle
                    (snapshot_id, snapshot_kind, retention_eligible_at,
                     integrity_profile, integrity_tag)
                 VALUES (?1, 'manual', NULL, 'hmac-sha256-v1', ?2)",
                params![snapshot.snapshot_id, vec![0_u8; 32]],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshot_lifecycle
                 SET integrity_profile = 'tampered-profile'",
                [],
            )
            .unwrap();
        conn.inner()
            .execute("UPDATE vault_meta SET schema_version = 16", [])
            .unwrap();
        let before_migrations: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();

        let error = upgrade_to_latest(conn.inner()).unwrap_err();
        assert!(error
            .to_string()
            .contains("snapshot_lifecycle contains invalid"));
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT schema_version FROM vault_meta", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            16
        );
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            before_migrations
        );
        let profile: String = conn
            .inner()
            .query_row(
                "SELECT integrity_profile FROM snapshot_lifecycle LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(profile, "tampered-profile");
    }

    #[test]
    fn mdbx1_upgrade_creates_sync_state_extension_store() {
        let conn = v1_database();

        let info = upgrade_to_latest(&conn).unwrap().unwrap();

        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(table_exists(&conn, "sync_state_extensions").unwrap());
        let migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SYNC_STATE_EXTENSIONS],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn schema14_upgrade_creates_sync_state_extension_store_idempotently() {
        let conn = VaultConnection::open_in_memory().unwrap();
        crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
        conn.inner()
            .execute_batch(
                "DROP TABLE sync_state_extensions;
                 DELETE FROM schema_migrations
                 WHERE migration_id = 'mdbx-2-sync-state-extensions-v1';
                 UPDATE vault_meta SET schema_version = 14;",
            )
            .unwrap();

        let inspection = inspect_migration(conn.inner()).unwrap();
        assert!(inspection.requires_upgrade);
        let info = upgrade_to_latest(conn.inner()).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(table_exists(conn.inner(), "sync_state_extensions").unwrap());

        upgrade_to_latest(conn.inner()).unwrap();
        let migration_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_SYNC_STATE_EXTENSIONS],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
    }

    #[test]
    fn schema12_migration_backfills_causally_and_remains_idempotent() {
        let conn = v1_database();
        for (commit_id, local_seq, created_at) in [
            ("child", 1_i64, "2026-07-20T00:00:00Z"),
            ("parent", 2_i64, "2026-07-20T00:00:01Z"),
        ] {
            conn.execute(
                "INSERT INTO commits
                    (commit_id, device_id, local_seq, commit_kind, change_scope,
                     changed_object_ids_ct, vector_clock, created_at, integrity_tag)
                 VALUES (?1, 'device-1', ?2, 'change', 'vault', X'5B5D', '{}', ?3, X'00')",
                params![commit_id, local_seq, created_at],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO commit_parents (commit_id, parent_commit_id)
             VALUES ('child', 'parent')",
            [],
        )
        .unwrap();

        let before: Vec<(String, String, i64, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT commit_id, device_id, local_seq, created_at
                     FROM commits ORDER BY commit_id",
                )
                .unwrap();
            stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };

        let info = upgrade_to_latest(&conn).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
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
        let bootstrap_floor: i64 = conn
            .query_row(
                "SELECT bootstrap_commit_inventory_seq FROM sync_delta_meta",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(bootstrap_floor, sequences.1);

        let after: Vec<(String, String, i64, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT commit_id, device_id, local_seq, created_at
                     FROM commits ORDER BY commit_id",
                )
                .unwrap();
            stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        assert_eq!(after, before);
        let edge_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM commit_parents
                 WHERE commit_id = 'child' AND parent_commit_id = 'parent'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(edge_count, 1);

        upgrade_to_latest(&conn).unwrap();
        let migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_COMMIT_INVENTORY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
        let sequences_after: (i64, i64) = conn
            .query_row(
                "SELECT parent.inventory_seq, child.inventory_seq
                 FROM commit_inventory parent CROSS JOIN commit_inventory child
                 WHERE parent.commit_id = 'parent' AND child.commit_id = 'child'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(sequences_after, sequences);

        conn.execute(
            "INSERT INTO commits
                (commit_id, device_id, local_seq, commit_kind, change_scope,
                 changed_object_ids_ct, vector_clock, created_at, integrity_tag)
             VALUES ('future', 'device-1', 3, 'change', 'vault', X'5B5D', '{}',
                     '2026-07-20T00:00:02Z', X'00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO commit_parents (commit_id, parent_commit_id)
             VALUES ('future', 'child')",
            [],
        )
        .unwrap();
        let future_seq: i64 = conn
            .query_row(
                "SELECT inventory_seq FROM commit_inventory WHERE commit_id = 'future'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(future_seq > sequences.1);
    }

    #[test]
    fn schema12_migration_rejects_a_cycle_and_rolls_back() {
        let conn = v1_database();
        for (commit_id, local_seq) in [("cycle-a", 1_i64), ("cycle-b", 2_i64)] {
            conn.execute(
                "INSERT INTO commits
                    (commit_id, device_id, local_seq, commit_kind, change_scope,
                     changed_object_ids_ct, vector_clock, created_at, integrity_tag)
                 VALUES (?1, 'device-1', ?2, 'change', 'vault', X'5B5D', '{}',
                         '2026-07-20T00:00:00Z', X'00')",
                params![commit_id, local_seq],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO commit_parents (commit_id, parent_commit_id)
             VALUES ('cycle-a', 'cycle-b');
             INSERT INTO commit_parents (commit_id, parent_commit_id)
             VALUES ('cycle-b', 'cycle-a');",
        )
        .unwrap();

        let error = upgrade_to_latest(&conn).unwrap_err();

        assert!(error
            .to_string()
            .contains("commit DAG is cyclic or damaged"));
        assert!(!table_exists(&conn, "commit_inventory").unwrap());
        assert!(!v2::column_exists(&conn, "vault_meta", "schema_version").unwrap());
        let format: String = conn
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, FORMAT_V1);
    }

    #[test]
    fn early_mdbx2_schema_is_upgraded_in_place_to_tiga2() {
        let conn = v1_database();
        v2::add_column_if_missing(
            &conn,
            "vault_meta",
            "schema_version",
            "INTEGER NOT NULL DEFAULT 2",
        )
        .unwrap();
        v2::add_column_if_missing(
            &conn,
            "vault_meta",
            "min_reader_version",
            "TEXT NOT NULL DEFAULT 'MDBX-1'",
        )
        .unwrap();
        v2::add_column_if_missing(
            &conn,
            "vault_meta",
            "min_writer_version",
            "TEXT NOT NULL DEFAULT 'MDBX-2'",
        )
        .unwrap();
        conn.execute_batch(v2::SCHEMA_MIGRATIONS_DDL).unwrap();
        conn.execute(
            "UPDATE vault_meta SET format_version = 'MDBX-2', schema_version = 2",
            [],
        )
        .unwrap();

        let info = upgrade_to_latest(&conn).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(table_exists(&conn, "tiga_policy_overrides").unwrap());
        assert!(table_exists(&conn, "commit_operations").unwrap());
        assert!(table_exists(&conn, "commit_device_sequences").unwrap());
        let migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_TIGA2_POLICY],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(migration_count, 1);
        let commit2_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_COMMIT2],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(commit2_migration_count, 1);
        let audit_correlation_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_TIGA_AUDIT_CORRELATION],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_correlation_migration_count, 1);
        let stable_branch_migration_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE migration_id = ?1",
                params![MIGRATION_STABLE_BRANCH_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stable_branch_migration_count, 1);
    }

    #[test]
    fn schema4_audit_rows_gain_nullable_correlation_fields() {
        let conn = v1_database();
        v2::add_column_if_missing(
            &conn,
            "vault_meta",
            "schema_version",
            "INTEGER NOT NULL DEFAULT 4",
        )
        .unwrap();
        v2::add_column_if_missing(
            &conn,
            "vault_meta",
            "min_reader_version",
            "TEXT NOT NULL DEFAULT 'MDBX-1'",
        )
        .unwrap();
        v2::add_column_if_missing(
            &conn,
            "vault_meta",
            "min_writer_version",
            "TEXT NOT NULL DEFAULT 'MDBX-2'",
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TABLE security_audit_events (
                event_id TEXT PRIMARY KEY NOT NULL,
                occurred_at TEXT NOT NULL,
                operation TEXT NOT NULL,
                outcome TEXT NOT NULL,
                scope_type TEXT NOT NULL,
                scope_id TEXT NOT NULL,
                session_id TEXT,
                device_id TEXT,
                reason_codes_json TEXT NOT NULL,
                constraints_json TEXT NOT NULL,
                exception_id TEXT,
                integrity_tag BLOB
             );
             INSERT INTO security_audit_events
                (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                 reason_codes_json, constraints_json)
             VALUES ('legacy-event', '2026-01-01T00:00:00Z', 'copy-secret', 'allow',
                     'vault', '', '[]', '[]');",
        )
        .unwrap();
        conn.execute(
            "UPDATE vault_meta SET format_version = 'MDBX-2', schema_version = 4",
            [],
        )
        .unwrap();

        let info = upgrade_to_latest(&conn).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        let correlation: (Option<String>, Option<String>, Option<i64>, Option<Vec<u8>>) = conn
            .query_row(
                "SELECT operation_id, commit_id, policy_version, policy_fingerprint
                 FROM security_audit_events WHERE event_id = 'legacy-event'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(correlation, (None, None, None, None));
    }

    #[test]
    fn schema5_operation_rows_gain_nullable_branch_ids() {
        let conn = v1_database();
        for (column, definition) in [
            ("schema_version", "INTEGER NOT NULL DEFAULT 5"),
            ("min_reader_version", "TEXT NOT NULL DEFAULT 'MDBX-1'"),
            ("min_writer_version", "TEXT NOT NULL DEFAULT 'MDBX-2'"),
        ] {
            v2::add_column_if_missing(&conn, "vault_meta", column, definition).unwrap();
        }
        conn.execute_batch(v2::SCHEMA_MIGRATIONS_DDL).unwrap();
        conn.execute_batch(
            "CREATE TABLE commit_operations (
                operation_id TEXT PRIMARY KEY NOT NULL,
                commit_id TEXT NOT NULL UNIQUE,
                operation_kind TEXT NOT NULL,
                branch_name TEXT NOT NULL,
                change_summary_ct BLOB NOT NULL,
                request_hash BLOB NOT NULL,
                created_at TEXT NOT NULL,
                integrity_tag BLOB NOT NULL,
                FOREIGN KEY (commit_id) REFERENCES commits(commit_id)
             );
             INSERT INTO commits
                (commit_id, device_id, local_seq, commit_kind, change_scope,
                 changed_object_ids_ct, vector_clock, created_at, integrity_tag)
             VALUES ('legacy-commit', 'device-1', 1, 'change', 'project', X'5B5D',
                     '{}', '2026-01-01T00:00:00Z', X'00');
             INSERT INTO commit_operations
                (operation_id, commit_id, operation_kind, branch_name, change_summary_ct,
                 request_hash, created_at, integrity_tag)
             VALUES ('legacy-operation', 'legacy-commit', 'change', 'main', X'5B5D',
                     X'01', '2026-01-01T00:00:00Z', X'02');
             UPDATE vault_meta SET format_version = 'MDBX-2', schema_version = 5;",
        )
        .unwrap();

        let info = upgrade_to_latest(&conn).unwrap().unwrap();
        assert_eq!(info.schema_version, CURRENT_SCHEMA_VERSION);
        let branch_id: Option<String> = conn
            .query_row(
                "SELECT branch_id FROM commit_operations WHERE operation_id = 'legacy-operation'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(branch_id.is_none());
    }

    #[test]
    fn legacy_weaker_overrides_are_preserved_as_remediation_exceptions() {
        let conn = v1_database();
        conn.execute(
            "INSERT INTO projects
                (project_id, title_ct, tiga_mode_override, object_clock, head_commit_id,
                 created_at, updated_at, created_by_device_id, updated_by_device_id)
             VALUES ('project-1', X'70', 'sky', '{}', 'commit-1',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'd1', 'd1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries
                (entry_id, project_id, entry_type, payload_ct, tiga_mode_override,
                 object_clock, head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
             VALUES ('entry-1', 'project-1', 'login', X'7B7D', 'power', '{}',
                     'commit-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                     'd1', 'd1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects
                (project_id, title_ct, tiga_mode_override, object_clock, head_commit_id,
                 created_at, updated_at, created_by_device_id, updated_by_device_id)
             VALUES ('project-2', X'70', 'power', '{}', 'commit-2',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'd1', 'd1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries
                (entry_id, project_id, entry_type, payload_ct, tiga_mode_override,
                 object_clock, head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
             VALUES ('entry-2', 'project-2', 'login', X'7B7D', 'sky', '{}',
                     'commit-2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                     'd1', 'd1')",
            [],
        )
        .unwrap();

        upgrade_to_latest(&conn).unwrap();
        let project_mode: String = conn
            .query_row(
                "SELECT tiga_mode_override FROM projects WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_mode, "sky");
        let exception_json: String = conn
            .query_row(
                "SELECT approved_override_json FROM tiga_policy_exceptions
                 WHERE target_scope = 'project' AND target_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let policy_override: TigaPolicyOverride = serde_json::from_str(&exception_json).unwrap();
        assert_eq!(policy_override.profile, Some(TigaMode::Sky));
        let entry_exception_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tiga_policy_exceptions
                 WHERE target_scope = 'entry' AND target_id = 'entry-2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(entry_exception_count, 1);
        let status: String = conn
            .query_row("SELECT tiga_compliance_status FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(status, "remediation-required");
    }

    #[test]
    fn migration_preserves_unlock_wrappers_and_marks_compliant_legacy_multi() {
        let conn = v1_database();
        let original_params = insert_legacy_password(&conn);
        upgrade_to_latest(&conn).unwrap();
        let (params_after, wrapped_after, status): (Vec<u8>, Vec<u8>, String) = conn
            .query_row(
                "SELECT u.kdf_params_ct, u.wrapped_vault_key_ct, v.tiga_compliance_status
                 FROM unlock_methods u CROSS JOIN vault_meta v
                 WHERE u.method_id = 'password-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(params_after, original_params);
        assert_eq!(wrapped_after, vec![1, 2, 3, 4]);
        assert_eq!(status, "compliant");
    }

    #[test]
    fn invalid_legacy_tiga_mode_rolls_back_the_entire_upgrade() {
        let conn = v1_database();
        conn.execute(
            "UPDATE vault_meta SET default_tiga_mode = 'unknown-mode'",
            [],
        )
        .unwrap();
        assert!(upgrade_to_latest(&conn).is_err());
        let format: String = conn
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, FORMAT_V1);
        assert!(!v2::column_exists(&conn, "vault_meta", "tiga_policy_version").unwrap());
        assert!(!table_exists(&conn, "tiga_policy_exceptions").unwrap());
    }

    #[test]
    fn opening_a_v1_file_automatically_upgrades_it() {
        let path =
            std::env::temp_dir().join(format!("mdbx-v1-upgrade-{}.mdbx", uuid::Uuid::new_v4()));
        {
            let conn = Connection::open(&path).unwrap();
            crate::schema::v1::create_all_tables(&conn).unwrap();
            conn.execute(
                "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
                 default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
                 VALUES ('disk-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
                 '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO projects (project_id, title_ct, object_clock, head_commit_id,
                 created_at, updated_at, created_by_device_id, updated_by_device_id)
                 VALUES ('project-1', X'7469746C65', '{}', 'commit-1',
                 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'device-1', 'device-1')",
                [],
            )
            .unwrap();
        }

        let vault = VaultConnection::open(&path).unwrap();
        assert_eq!(
            read_format_info(vault.inner()).unwrap().format_version,
            FORMAT_V2
        );
        let title: Vec<u8> = vault
            .inner()
            .query_row(
                "SELECT title_ct FROM projects WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, b"title");
        drop(vault);

        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }
}
