use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

use super::v2;

pub const HEADER_AUTH_PENDING_PROFILE: &str = "pending";
pub const HEADER_AUTH_INVALIDATED_PROFILE: &str = "invalidated";
pub const HEADER_AUTH_HMAC_SHA256_V1_PROFILE: &str = "mdbx-vault-header-hmac-sha256-v1";

const HEADER_AUTH_INVALIDATION_TRIGGER_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS trg_vault_meta_header_auth_invalidate
AFTER UPDATE OF
    vault_id,
    format_version,
    schema_version,
    min_reader_version,
    min_writer_version,
    created_at,
    updated_at,
    default_tiga_mode,
    active_key_epoch_id,
    compat_flags,
    critical_extensions,
    tiga_policy_version,
    tiga_compliance_status
ON vault_meta
WHEN OLD.header_integrity_profile = 'mdbx-vault-header-hmac-sha256-v1'
BEGIN
    UPDATE vault_meta
    SET header_integrity_profile = 'invalidated',
        header_integrity_tag = NULL
    WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_vault_meta_header_auth_no_pending_downgrade
BEFORE UPDATE OF header_integrity_profile ON vault_meta
WHEN OLD.header_integrity_profile IN ('invalidated', 'mdbx-vault-header-hmac-sha256-v1')
     AND NEW.header_integrity_profile = 'pending'
BEGIN
    SELECT RAISE(ABORT, 'vault header authentication cannot return to pending');
END;
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    v2::add_column_if_missing(
        conn,
        "vault_meta",
        "header_integrity_profile",
        "TEXT NOT NULL DEFAULT 'pending'",
    )?;
    v2::add_column_if_missing(conn, "vault_meta", "header_integrity_tag", "BLOB")?;
    conn.execute_batch(HEADER_AUTH_INVALIDATION_TRIGGER_DDL)
        .map_err(StorageError::Database)
}

pub fn validate_header_auth_schema(conn: &Connection) -> StorageResult<()> {
    for column in ["header_integrity_profile", "header_integrity_tag"] {
        if !v2::column_exists(conn, "vault_meta", column)? {
            return Err(StorageError::Validation(format!(
                "MDBX-2 vault is missing required vault_meta column {column}"
            )));
        }
    }

    let invalid_rows: i64 = conn.query_row(
        "SELECT COUNT(*) FROM vault_meta
         WHERE header_integrity_profile NOT IN (?1, ?2, ?3)
            OR (header_integrity_profile = ?3
                AND (typeof(header_integrity_tag) <> 'blob'
                     OR length(header_integrity_tag) <> 32))
            OR (header_integrity_profile <> ?3
                AND header_integrity_tag IS NOT NULL)",
        rusqlite::params![
            HEADER_AUTH_PENDING_PROFILE,
            HEADER_AUTH_INVALIDATED_PROFILE,
            HEADER_AUTH_HMAC_SHA256_V1_PROFILE,
        ],
        |row| row.get(0),
    )?;
    if invalid_rows != 0 {
        return Err(StorageError::Validation(
            "vault_meta contains invalid header authentication state".to_string(),
        ));
    }

    let trigger_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'trigger'
           AND name IN (
               'trg_vault_meta_header_auth_invalidate',
               'trg_vault_meta_header_auth_no_pending_downgrade'
           )",
        [],
        |row| row.get(0),
    )?;
    if trigger_count != 2 {
        return Err(StorageError::Validation(
            "MDBX-2 vault is missing required header authentication triggers".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::VaultConnection;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::schema;

    #[test]
    fn new_vault_starts_with_bounded_pending_header_auth() {
        let vault = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&vault, &VaultInitParams::default()).unwrap();

        let (profile, tag): (String, Option<Vec<u8>>) = vault
            .inner()
            .query_row(
                "SELECT header_integrity_profile, header_integrity_tag FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(profile, HEADER_AUTH_PENDING_PROFILE);
        assert!(tag.is_none());
        validate_header_auth_schema(vault.inner()).unwrap();
    }

    #[test]
    fn protected_update_invalidates_an_existing_tag() {
        let conn = Connection::open_in_memory().unwrap();
        schema::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta
                (vault_id, format_version, created_at, updated_at, default_tiga_mode,
                 active_key_epoch_id, header_integrity_profile, header_integrity_tag)
             VALUES ('vault', 'MDBX-2', 'created', 'updated', 'multi', 'epoch', ?1, ?2)",
            rusqlite::params![HEADER_AUTH_HMAC_SHA256_V1_PROFILE, vec![7_u8; 32]],
        )
        .unwrap();

        conn.execute("UPDATE vault_meta SET default_tiga_mode = 'power'", [])
            .unwrap();
        let (profile, tag): (String, Option<Vec<u8>>) = conn
            .query_row(
                "SELECT header_integrity_profile, header_integrity_tag FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(profile, HEADER_AUTH_INVALIDATED_PROFILE);
        assert!(tag.is_none());
    }

    #[test]
    fn authenticated_header_cannot_downgrade_to_pending() {
        let conn = Connection::open_in_memory().unwrap();
        schema::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta
                (vault_id, format_version, created_at, updated_at, default_tiga_mode,
                 active_key_epoch_id, header_integrity_profile, header_integrity_tag)
             VALUES ('vault', 'MDBX-2', 'created', 'updated', 'multi', 'epoch', ?1, ?2)",
            rusqlite::params![HEADER_AUTH_HMAC_SHA256_V1_PROFILE, vec![7_u8; 32]],
        )
        .unwrap();

        let error = conn
            .execute(
                "UPDATE vault_meta
                 SET header_integrity_profile = 'pending', header_integrity_tag = NULL",
                [],
            )
            .unwrap_err();
        assert!(error.to_string().contains("cannot return to pending"));
    }
}
