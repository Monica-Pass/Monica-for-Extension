use mdbx_crypto::keyring::Keyring;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::schema::v16::{
    HEADER_AUTH_HMAC_SHA256_V1_PROFILE, HEADER_AUTH_INVALIDATED_PROFILE,
    HEADER_AUTH_PENDING_PROFILE,
};

const VAULT_HEADER_INTEGRITY_DOMAIN: &[u8] = b"mdbx-vault-header-integrity-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VaultHeaderIntegrityStatus {
    Pending,
    Verified,
    UnverifiedLocked,
}

struct VaultHeaderRow {
    vault_id: String,
    format_version: String,
    schema_version: u32,
    min_reader_version: String,
    min_writer_version: String,
    created_at: String,
    updated_at: String,
    default_tiga_mode: String,
    active_key_epoch_id: String,
    compat_flags: String,
    critical_extensions: String,
    tiga_policy_version: u32,
    tiga_compliance_status: String,
    integrity_profile: String,
    integrity_tag: Option<Vec<u8>>,
}

pub(crate) fn verify_or_initialize(conn: &VaultConnection, keyring: &Keyring) -> StorageResult<()> {
    let row = load(conn)?;
    match row.integrity_profile.as_str() {
        HEADER_AUTH_PENDING_PROFILE if row.integrity_tag.is_none() => {
            refresh_with_keyring(conn, keyring)
        }
        HEADER_AUTH_HMAC_SHA256_V1_PROFILE => verify_row(keyring, &row),
        HEADER_AUTH_INVALIDATED_PROFILE => Err(StorageError::Validation(
            "vault header authentication was invalidated by an unsealed metadata change"
                .to_string(),
        )),
        HEADER_AUTH_PENDING_PROFILE => Err(StorageError::Validation(
            "pending vault header authentication must not contain a tag".to_string(),
        )),
        other => Err(StorageError::Validation(format!(
            "unsupported vault header authentication profile: {other}"
        ))),
    }
}

pub(crate) fn refresh(conn: &VaultConnection) -> StorageResult<()> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "vault must be verified-unlocked before sealing header metadata".to_string(),
        )
    })?;
    refresh_with_keyring(conn, keyring)
}

pub(crate) fn refresh_after_mutation(conn: &VaultConnection) -> StorageResult<()> {
    let row = load(conn)?;
    match row.integrity_profile.as_str() {
        HEADER_AUTH_PENDING_PROFILE if row.integrity_tag.is_none() => Ok(()),
        HEADER_AUTH_INVALIDATED_PROFILE => refresh(conn),
        HEADER_AUTH_HMAC_SHA256_V1_PROFILE => verify_row(
            conn.keyring().ok_or_else(|| {
                StorageError::Validation(
                    "vault must be verified-unlocked before changing authenticated header metadata"
                        .to_string(),
                )
            })?,
            &row,
        ),
        other => Err(StorageError::Validation(format!(
            "invalid vault header authentication state after mutation: {other}"
        ))),
    }
}

pub(crate) fn check(conn: &VaultConnection) -> StorageResult<VaultHeaderIntegrityStatus> {
    let row = load(conn)?;
    match row.integrity_profile.as_str() {
        HEADER_AUTH_PENDING_PROFILE if row.integrity_tag.is_none() => {
            Ok(VaultHeaderIntegrityStatus::Pending)
        }
        HEADER_AUTH_HMAC_SHA256_V1_PROFILE => {
            ensure_tag_shape(&row)?;
            match conn.keyring() {
                Some(keyring) => {
                    verify_row(keyring, &row)?;
                    Ok(VaultHeaderIntegrityStatus::Verified)
                }
                None => Ok(VaultHeaderIntegrityStatus::UnverifiedLocked),
            }
        }
        HEADER_AUTH_INVALIDATED_PROFILE => Err(StorageError::Validation(
            "vault header authentication is invalidated".to_string(),
        )),
        other => Err(StorageError::Validation(format!(
            "invalid vault header authentication state: {other}"
        ))),
    }
}

fn refresh_with_keyring(conn: &VaultConnection, keyring: &Keyring) -> StorageResult<()> {
    let row = load(conn)?;
    let tag = compute_tag(keyring, &row)?;
    let affected = conn.inner().execute(
        "UPDATE vault_meta
         SET header_integrity_profile = ?1, header_integrity_tag = ?2",
        rusqlite::params![HEADER_AUTH_HMAC_SHA256_V1_PROFILE, tag],
    )?;
    if affected != 1 {
        return Err(StorageError::Validation(format!(
            "expected one vault_meta row while sealing header, found {affected}"
        )));
    }
    Ok(())
}

fn verify_row(keyring: &Keyring, row: &VaultHeaderRow) -> StorageResult<()> {
    ensure_tag_shape(row)?;
    let tag = row.integrity_tag.as_deref().ok_or_else(|| {
        StorageError::Validation("authenticated vault header is missing its tag".to_string())
    })?;
    let schema_version = row.schema_version.to_le_bytes();
    let tiga_policy_version = row.tiga_policy_version.to_le_bytes();
    mdbx_crypto::integrity::verify_hmac_sha256(
        &keyring.integrity_subkey,
        &parts(row, &schema_version, &tiga_policy_version),
        tag,
    )
    .map_err(|_| StorageError::Validation("vault header integrity tag mismatch".to_string()))
}

fn ensure_tag_shape(row: &VaultHeaderRow) -> StorageResult<()> {
    if row
        .integrity_tag
        .as_ref()
        .is_some_and(|tag| tag.len() == 32)
    {
        Ok(())
    } else {
        Err(StorageError::Validation(
            "authenticated vault header requires a 32-byte tag".to_string(),
        ))
    }
}

fn compute_tag(keyring: &Keyring, row: &VaultHeaderRow) -> StorageResult<Vec<u8>> {
    let schema_version = row.schema_version.to_le_bytes();
    let tiga_policy_version = row.tiga_policy_version.to_le_bytes();
    mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &parts(row, &schema_version, &tiga_policy_version),
    )
    .map_err(StorageError::Crypto)
}

fn parts<'a>(
    row: &'a VaultHeaderRow,
    schema_version: &'a [u8; 4],
    tiga_policy_version: &'a [u8; 4],
) -> [&'a [u8]; 15] {
    [
        VAULT_HEADER_INTEGRITY_DOMAIN,
        HEADER_AUTH_HMAC_SHA256_V1_PROFILE.as_bytes(),
        row.vault_id.as_bytes(),
        row.format_version.as_bytes(),
        schema_version,
        row.min_reader_version.as_bytes(),
        row.min_writer_version.as_bytes(),
        row.created_at.as_bytes(),
        row.updated_at.as_bytes(),
        row.default_tiga_mode.as_bytes(),
        row.active_key_epoch_id.as_bytes(),
        row.compat_flags.as_bytes(),
        row.critical_extensions.as_bytes(),
        tiga_policy_version,
        row.tiga_compliance_status.as_bytes(),
    ]
}

fn load(conn: &VaultConnection) -> StorageResult<VaultHeaderRow> {
    conn.inner()
        .query_row(
            "SELECT vault_id, format_version, schema_version,
                    min_reader_version, min_writer_version, created_at, updated_at,
                    default_tiga_mode, active_key_epoch_id, compat_flags,
                    critical_extensions, tiga_policy_version, tiga_compliance_status,
                    header_integrity_profile, header_integrity_tag
             FROM vault_meta LIMIT 1",
            [],
            |row| {
                let schema_version = row.get::<_, i64>(2)?;
                let tiga_policy_version = row.get::<_, i64>(11)?;
                if !(0..=i64::from(u32::MAX)).contains(&schema_version)
                    || !(0..=i64::from(u32::MAX)).contains(&tiga_policy_version)
                {
                    return Err(rusqlite::Error::IntegralValueOutOfRange(2, schema_version));
                }
                Ok(VaultHeaderRow {
                    vault_id: row.get(0)?,
                    format_version: row.get(1)?,
                    schema_version: schema_version as u32,
                    min_reader_version: row.get(3)?,
                    min_writer_version: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    default_tiga_mode: row.get(7)?,
                    active_key_epoch_id: row.get(8)?,
                    compat_flags: row.get(9)?,
                    critical_extensions: row.get(10)?,
                    tiga_policy_version: tiga_policy_version as u32,
                    tiga_compliance_status: row.get(12)?,
                    integrity_profile: row.get(13)?,
                    integrity_tag: row.get(14)?,
                })
            },
        )
        .map_err(StorageError::Database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};

    fn fixture() -> (VaultConnection, Keyring) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let vault_id: String = conn
            .inner()
            .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
            .unwrap();
        let keyring = Keyring::from_vault_key(&vault_key, vault_id.as_bytes()).unwrap();
        (conn, keyring)
    }

    #[test]
    fn pending_header_is_sealed_and_verified() {
        let (conn, keyring) = fixture();
        verify_or_initialize(&conn, &keyring).unwrap();
        assert_eq!(
            check(&conn).unwrap(),
            VaultHeaderIntegrityStatus::UnverifiedLocked
        );
        verify_or_initialize(&conn, &keyring).unwrap();
    }

    #[test]
    fn protected_metadata_tampering_fails_closed() {
        let (conn, keyring) = fixture();
        verify_or_initialize(&conn, &keyring).unwrap();
        conn.inner()
            .execute("UPDATE vault_meta SET default_tiga_mode = 'power'", [])
            .unwrap();

        let error = verify_or_initialize(&conn, &keyring).unwrap_err();
        assert!(error.to_string().contains("invalidated"));
    }

    #[test]
    fn tag_tampering_fails_constant_time_verification() {
        let (conn, keyring) = fixture();
        verify_or_initialize(&conn, &keyring).unwrap();
        conn.inner()
            .execute(
                "UPDATE vault_meta SET header_integrity_tag = zeroblob(32)",
                [],
            )
            .unwrap();

        let error = verify_or_initialize(&conn, &keyring).unwrap_err();
        assert!(error.to_string().contains("tag mismatch"));
    }
}
