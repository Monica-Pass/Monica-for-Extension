use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use mdbx_core::model::Snapshot;

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::schema::v15::validate_sync_state_extensions;

pub const MAX_SNAPSHOT_DISPLAY_NAME_BYTES: usize = 96;

const EXTENSION_KEY_PREFIX: &str = "monica.snapshot-metadata.v1.";
const METADATA_RECORD_TYPE: &str = "snapshot-metadata";
const METADATA_FIELD_NAME: &str = "display-name-v1";
const ENVELOPE_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotDisplayMetadata {
    pub snapshot_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotMetadataEnvelope {
    version: u8,
    display_name_ct: String,
}

pub struct SnapshotMetadataRepo;

impl SnapshotMetadataRepo {
    pub(crate) fn register_from_snapshot_in_transaction(
        conn: &VaultConnection,
        snapshot: &Snapshot,
        display_name: &str,
    ) -> StorageResult<SnapshotDisplayMetadata> {
        require_unlocked(conn)?;
        let display_name = normalize_display_name(display_name)?;
        let extension_key = extension_key(&snapshot.snapshot_id);
        let encrypted = encrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            display_name.as_bytes(),
            METADATA_RECORD_TYPE,
            &snapshot.snapshot_id,
            METADATA_FIELD_NAME,
        )?;
        let envelope = SnapshotMetadataEnvelope {
            version: ENVELOPE_VERSION,
            display_name_ct: BASE64_STANDARD.encode(encrypted),
        };
        let value_json = serde_json::to_vec(&envelope)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;

        if let Some(existing) = Self::get(conn, &snapshot.snapshot_id)? {
            if existing.display_name != display_name {
                return Err(StorageError::ConstraintViolation(format!(
                    "snapshot metadata for {} already has a different display name",
                    snapshot.snapshot_id
                )));
            }
            return Ok(existing);
        }

        conn.inner().execute(
            "INSERT INTO sync_state_extensions
                (extension_key, value_json, source_commit_id, updated_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                extension_key,
                value_json,
                snapshot.base_commit_id,
                snapshot.created_at,
            ],
        )?;
        validate_sync_state_extensions(conn.inner())?;
        Ok(SnapshotDisplayMetadata {
            snapshot_id: snapshot.snapshot_id.clone(),
            display_name,
        })
    }

    pub fn get(
        conn: &VaultConnection,
        snapshot_id: &str,
    ) -> StorageResult<Option<SnapshotDisplayMetadata>> {
        let value_json = conn
            .inner()
            .query_row(
                "SELECT value_json FROM sync_state_extensions WHERE extension_key = ?1",
                params![extension_key(snapshot_id)],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        let Some(value_json) = value_json else {
            return Ok(None);
        };
        require_unlocked(conn)?;
        let envelope: SnapshotMetadataEnvelope =
            serde_json::from_slice(&value_json).map_err(|error| {
                StorageError::Validation(format!("invalid snapshot metadata envelope: {error}"))
            })?;
        if envelope.version != ENVELOPE_VERSION {
            return Err(StorageError::Validation(format!(
                "unsupported snapshot metadata version {}",
                envelope.version
            )));
        }
        let ciphertext = BASE64_STANDARD
            .decode(envelope.display_name_ct.as_bytes())
            .map_err(|error| {
                StorageError::Validation(format!("invalid snapshot metadata ciphertext: {error}"))
            })?;
        let plaintext = decrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            &ciphertext,
            METADATA_RECORD_TYPE,
            snapshot_id,
            METADATA_FIELD_NAME,
        )?;
        let display_name = String::from_utf8(plaintext).map_err(|error| {
            StorageError::Validation(format!("snapshot display name is not UTF-8: {error}"))
        })?;
        let display_name = normalize_display_name(&display_name)?;
        Ok(Some(SnapshotDisplayMetadata {
            snapshot_id: snapshot_id.to_string(),
            display_name,
        }))
    }

    pub(crate) fn delete_in_transaction(
        conn: &VaultConnection,
        snapshot_id: &str,
    ) -> StorageResult<()> {
        conn.inner().execute(
            "DELETE FROM sync_state_extensions WHERE extension_key = ?1",
            params![extension_key(snapshot_id)],
        )?;
        Ok(())
    }
}

fn extension_key(snapshot_id: &str) -> String {
    format!("{EXTENSION_KEY_PREFIX}{snapshot_id}")
}

fn normalize_display_name(value: &str) -> StorageResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(StorageError::Validation(
            "snapshot display name cannot be empty".to_string(),
        ));
    }
    if value.len() > MAX_SNAPSHOT_DISPLAY_NAME_BYTES {
        return Err(StorageError::ResourceLimit {
            resource: "snapshot display name bytes".to_string(),
            actual: value.len() as u64,
            limit: MAX_SNAPSHOT_DISPLAY_NAME_BYTES as u64,
        });
    }
    Ok(value.to_string())
}

fn require_unlocked(conn: &VaultConnection) -> StorageResult<()> {
    if conn.keyring().is_none() {
        return Err(StorageError::Validation(
            "snapshot metadata requires an unlocked keyring".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, SnapshotRepo};
    use crate::unlock::UnlockService;

    #[test]
    fn encrypted_snapshot_name_round_trips_and_deletes_with_snapshot_metadata() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, "snapshot metadata password").unwrap();
        let ctx = CommitContext::new("snapshot-metadata-device".to_string());
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        conn.with_immediate_transaction(|| {
            SnapshotMetadataRepo::register_from_snapshot_in_transaction(
                &conn,
                &snapshot,
                "Before travel",
            )
        })
        .unwrap();

        let stored = SnapshotMetadataRepo::get(&conn, &snapshot.snapshot_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.display_name, "Before travel");
        let raw: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT value_json FROM sync_state_extensions WHERE extension_key = ?1",
                params![extension_key(&snapshot.snapshot_id)],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("Before travel"));

        conn.with_immediate_transaction(|| {
            SnapshotMetadataRepo::delete_in_transaction(&conn, &snapshot.snapshot_id)
        })
        .unwrap();
        assert!(SnapshotMetadataRepo::get(&conn, &snapshot.snapshot_id)
            .unwrap()
            .is_none());
    }
}
