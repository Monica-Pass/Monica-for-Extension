use mdbx_crypto::keyring::Keyring;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::migration::FIELD_KEY_EPOCHS_EXTENSION;

const FIELD_EPOCH_MAGIC: &[u8; 8] = b"MDBXFE2\0";
const FIELD_EPOCH_HEADER_LEN: usize = FIELD_EPOCH_MAGIC.len() + 2;
const FIELD_EPOCH_AAD_DOMAIN: &[u8] = b"mdbx-field-epoch-aad-v1";

#[derive(Debug, Clone, Copy)]
pub(crate) enum FieldKeyPurpose {
    Record,
    Attachment,
    Metadata,
    History,
}

impl FieldKeyPurpose {
    fn subkey(self, keyring: &Keyring) -> &[u8] {
        match self {
            Self::Record => &keyring.record_subkey,
            Self::Attachment => &keyring.attachment_subkey,
            Self::Metadata => &keyring.metadata_subkey,
            Self::History => &keyring.history_subkey,
        }
    }
}

/// 正式解锁连接使用带 epoch 身份的字段密文；手工测试 Keyring 保留 MDBXAE1。
pub(crate) fn encrypt_field(
    conn: &VaultConnection,
    purpose: FieldKeyPurpose,
    plaintext: &[u8],
    object_type: &str,
    object_id: &str,
    field_name: &str,
) -> StorageResult<Vec<u8>> {
    let Some(legacy_keyring) = conn.keyring() else {
        return Ok(plaintext.to_vec());
    };

    let Some(key_epoch_id) = conn.active_key_epoch_id() else {
        let aad = build_legacy_aad(object_type, object_id, field_name);
        return mdbx_crypto::aead::encrypt(purpose.subkey(legacy_keyring), plaintext, &aad)
            .map_err(StorageError::Crypto);
    };
    if conn.inner().is_autocommit() {
        return Err(StorageError::Validation(
            "epoch-tagged field encryption requires an active storage transaction".to_string(),
        ));
    }
    let epoch_keyring = conn.keyring_for_epoch(key_epoch_id).ok_or_else(|| {
        StorageError::Validation(format!(
            "verified active key epoch {} has no loaded key material",
            key_epoch_id
        ))
    })?;
    let aad = build_epoch_aad(key_epoch_id, object_type, object_id, field_name);
    let inner = mdbx_crypto::aead::encrypt(purpose.subkey(epoch_keyring), plaintext, &aad)
        .map_err(StorageError::Crypto)?;
    let envelope = encode_epoch_envelope(key_epoch_id, &inner)?;
    conn.ensure_critical_extension(FIELD_KEY_EPOCHS_EXTENSION)?;
    Ok(envelope)
}

/// 解密 epoch-tagged、MDBXAE1、legacy nonce 或明文测试字段。
pub(crate) fn decrypt_field(
    conn: &VaultConnection,
    purpose: FieldKeyPurpose,
    ciphertext: &[u8],
    object_type: &str,
    object_id: &str,
    field_name: &str,
) -> StorageResult<Vec<u8>> {
    let Some(legacy_keyring) = conn.keyring() else {
        return Ok(ciphertext.to_vec());
    };

    if ciphertext.starts_with(FIELD_EPOCH_MAGIC) {
        let (key_epoch_id, inner) = decode_epoch_envelope(ciphertext)?;
        let epoch_keyring = conn.keyring_for_epoch(key_epoch_id).ok_or_else(|| {
            StorageError::Validation(format!(
                "field ciphertext requires unavailable key epoch {}",
                key_epoch_id
            ))
        })?;
        let aad = build_epoch_aad(key_epoch_id, object_type, object_id, field_name);
        return mdbx_crypto::aead::decrypt(purpose.subkey(epoch_keyring), inner, &aad)
            .map_err(StorageError::Crypto);
    }

    let aad = build_legacy_aad(object_type, object_id, field_name);
    mdbx_crypto::aead::decrypt(purpose.subkey(legacy_keyring), ciphertext, &aad)
        .map_err(StorageError::Crypto)
}

fn encode_epoch_envelope(key_epoch_id: &str, inner: &[u8]) -> StorageResult<Vec<u8>> {
    if key_epoch_id.is_empty() {
        return Err(StorageError::Validation(
            "field key epoch ID must not be empty".to_string(),
        ));
    }
    let epoch_len = u16::try_from(key_epoch_id.len()).map_err(|_| {
        StorageError::Validation("field key epoch ID exceeds 65535 bytes".to_string())
    })?;
    let mut envelope =
        Vec::with_capacity(FIELD_EPOCH_HEADER_LEN + key_epoch_id.len() + inner.len());
    envelope.extend_from_slice(FIELD_EPOCH_MAGIC);
    envelope.extend_from_slice(&epoch_len.to_le_bytes());
    envelope.extend_from_slice(key_epoch_id.as_bytes());
    envelope.extend_from_slice(inner);
    Ok(envelope)
}

fn decode_epoch_envelope(ciphertext: &[u8]) -> StorageResult<(&str, &[u8])> {
    if ciphertext.len() < FIELD_EPOCH_HEADER_LEN {
        return Err(StorageError::Validation(
            "epoch-tagged field ciphertext has a truncated header".to_string(),
        ));
    }
    let epoch_len = u16::from_le_bytes([
        ciphertext[FIELD_EPOCH_MAGIC.len()],
        ciphertext[FIELD_EPOCH_MAGIC.len() + 1],
    ]) as usize;
    if epoch_len == 0 {
        return Err(StorageError::Validation(
            "epoch-tagged field ciphertext has an empty epoch ID".to_string(),
        ));
    }
    let epoch_end = FIELD_EPOCH_HEADER_LEN
        .checked_add(epoch_len)
        .filter(|end| *end < ciphertext.len())
        .ok_or_else(|| {
            StorageError::Validation(
                "epoch-tagged field ciphertext has a truncated epoch ID or payload".to_string(),
            )
        })?;
    let key_epoch_id = std::str::from_utf8(&ciphertext[FIELD_EPOCH_HEADER_LEN..epoch_end])
        .map_err(|_| {
            StorageError::Validation(
                "epoch-tagged field ciphertext has a non-UTF-8 epoch ID".to_string(),
            )
        })?;
    Ok((key_epoch_id, &ciphertext[epoch_end..]))
}

fn build_legacy_aad(object_type: &str, object_id: &str, field_name: &str) -> Vec<u8> {
    format!("{}:{}:{}", object_type, object_id, field_name).into_bytes()
}

fn build_epoch_aad(
    key_epoch_id: &str,
    object_type: &str,
    object_id: &str,
    field_name: &str,
) -> Vec<u8> {
    let mut aad = Vec::new();
    for part in [
        FIELD_EPOCH_AAD_DOMAIN,
        key_epoch_id.as_bytes(),
        object_type.as_bytes(),
        object_id.as_bytes(),
        field_name.as_bytes(),
    ] {
        aad.extend_from_slice(&(part.len() as u64).to_le_bytes());
        aad.extend_from_slice(part);
    }
    aad
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::commit_ctx::CommitContext;
    use crate::repo::project::ProjectRepo;
    use crate::unlock::UnlockService;

    fn setup_unlocked() -> VaultConnection {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, "correct horse battery staple").unwrap();
        conn
    }

    fn encrypt_epoch_field(
        conn: &VaultConnection,
        purpose: FieldKeyPurpose,
        plaintext: &[u8],
        object_type: &str,
        object_id: &str,
        field_name: &str,
    ) -> Vec<u8> {
        conn.with_immediate_transaction(|| {
            encrypt_field(conn, purpose, plaintext, object_type, object_id, field_name)
        })
        .unwrap()
    }

    #[test]
    fn official_unlock_writes_epoch_tagged_fields() {
        let conn = setup_unlocked();
        let ciphertext = encrypt_epoch_field(
            &conn,
            FieldKeyPurpose::Metadata,
            b"secret",
            "project",
            "project-1",
            "title",
        );

        assert!(ciphertext.starts_with(FIELD_EPOCH_MAGIC));
        let (epoch_id, _) = decode_epoch_envelope(&ciphertext).unwrap();
        assert_eq!(Some(epoch_id), conn.active_key_epoch_id());
        let extensions: String = conn
            .inner()
            .query_row("SELECT critical_extensions FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&extensions).unwrap(),
            vec![FIELD_KEY_EPOCHS_EXTENSION.to_string()]
        );
        assert_eq!(
            decrypt_field(
                &conn,
                FieldKeyPurpose::Metadata,
                &ciphertext,
                "project",
                "project-1",
                "title",
            )
            .unwrap(),
            b"secret"
        );
    }

    #[test]
    fn legacy_committed_field_ciphertext_still_decrypts() {
        let conn = setup_unlocked();
        let aad = build_legacy_aad("entry", "entry-1", "payload");
        let legacy = mdbx_crypto::aead::encrypt(
            &conn.keyring().unwrap().record_subkey,
            b"legacy secret",
            &aad,
        )
        .unwrap();

        assert_eq!(
            decrypt_field(
                &conn,
                FieldKeyPurpose::Record,
                &legacy,
                "entry",
                "entry-1",
                "payload",
            )
            .unwrap(),
            b"legacy secret"
        );
    }

    #[test]
    fn manually_attached_keyring_keeps_the_legacy_envelope() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams {
            vault_id: Some("manual-keyring-vault".to_string()),
            ..VaultInitParams::default()
        };
        initialize_vault(&conn, &params).unwrap();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring =
            mdbx_crypto::keyring::Keyring::from_vault_key(&vault_key, b"manual-keyring-vault")
                .unwrap();
        conn.attach_keyring(keyring);

        let ciphertext = encrypt_field(
            &conn,
            FieldKeyPurpose::Record,
            b"legacy mode",
            "entry",
            "entry-1",
            "payload",
        )
        .unwrap();

        assert!(ciphertext.starts_with(b"MDBXAE1\0"));
        assert_eq!(
            decrypt_field(
                &conn,
                FieldKeyPurpose::Record,
                &ciphertext,
                "entry",
                "entry-1",
                "payload",
            )
            .unwrap(),
            b"legacy mode"
        );
    }

    #[test]
    fn epoch_header_and_payload_tampering_are_rejected() {
        let conn = setup_unlocked();
        let ciphertext = encrypt_epoch_field(
            &conn,
            FieldKeyPurpose::History,
            b"history",
            "commit",
            "commit-1",
            "message",
        );

        let mut unknown_epoch = ciphertext.clone();
        unknown_epoch[FIELD_EPOCH_HEADER_LEN] = b'x';
        assert!(decrypt_field(
            &conn,
            FieldKeyPurpose::History,
            &unknown_epoch,
            "commit",
            "commit-1",
            "message",
        )
        .is_err());

        let mut tampered_payload = ciphertext;
        *tampered_payload.last_mut().unwrap() ^= 0x01;
        assert!(decrypt_field(
            &conn,
            FieldKeyPurpose::History,
            &tampered_payload,
            "commit",
            "commit-1",
            "message",
        )
        .is_err());
    }

    #[test]
    fn epoch_aad_binds_the_field_location() {
        let conn = setup_unlocked();
        let ciphertext = encrypt_epoch_field(
            &conn,
            FieldKeyPurpose::Attachment,
            b"content",
            "attachment",
            "attachment-1",
            "chunk",
        );

        assert!(decrypt_field(
            &conn,
            FieldKeyPurpose::Attachment,
            &ciphertext,
            "attachment",
            "attachment-2",
            "chunk",
        )
        .is_err());
    }

    #[test]
    fn epoch_tagged_encryption_requires_a_transaction() {
        let conn = setup_unlocked();

        let error = encrypt_field(
            &conn,
            FieldKeyPurpose::Record,
            b"secret",
            "entry",
            "entry-1",
            "payload",
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("requires an active storage transaction"));
    }

    #[test]
    fn extension_marker_rolls_back_with_failed_write() {
        let conn = setup_unlocked();

        let result: StorageResult<()> = conn.with_immediate_transaction(|| {
            let _ = encrypt_field(
                &conn,
                FieldKeyPurpose::Metadata,
                b"secret",
                "project",
                "project-1",
                "title",
            )?;
            Err(StorageError::Validation("abort test write".to_string()))
        });

        assert!(result.is_err());
        let extensions: String = conn
            .inner()
            .query_row("SELECT critical_extensions FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(extensions.is_empty());
    }

    #[test]
    fn epoch_tagged_vault_reopens_and_unlocks() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-epoch-field-reopen-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let project_id;
        {
            let mut conn = VaultConnection::create(&path).unwrap();
            initialize_vault(&conn, &VaultInitParams::default()).unwrap();
            UnlockService::setup_password(&mut conn, "correct horse battery staple").unwrap();
            let project = ProjectRepo::create(
                &conn,
                &CommitContext::new("epoch-device".to_string()),
                "Encrypted Project",
                None,
                None,
            )
            .unwrap();
            project_id = project.project_id;
        }

        let mut reopened = VaultConnection::open(&path).unwrap();
        UnlockService::unlock_with_password(&mut reopened, "correct horse battery staple").unwrap();
        let project = ProjectRepo::get_by_id(&reopened, &project_id)
            .unwrap()
            .unwrap();
        assert_eq!(project.title_ct, b"Encrypted Project");

        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let mut candidate = path.as_os_str().to_os_string();
            candidate.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(candidate));
        }
    }
}
