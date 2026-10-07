use mdbx_core::tiga::{TigaOperation, TigaScope};
use mdbx_crypto::aead;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;
use crate::unlock::UnlockService;

pub(crate) const RANDOM_KEY_EPOCH_PROFILE_ID: &str = "mdbx-random-data-key-epoch-v2";
const RANDOM_KEY_EPOCH_AAD_DOMAIN: &[u8] = b"mdbx-random-data-key-epoch-wrap-v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEpochRotationResult {
    pub previous_epoch_id: String,
    pub active_epoch_id: String,
    pub commit_id: String,
    pub rotated_at: String,
}

pub struct KeyEpochService;

impl KeyEpochService {
    /// Rotates the active data-key epoch after TIGA authorization.
    ///
    /// Multi-device callers must distribute the resulting key-epoch state
    /// before encrypted fields written under the new epoch are synchronized.
    pub fn rotate_authorized(
        conn: &mut VaultConnection,
        ctx: &CommitContext,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<KeyEpochRotationResult> {
        let vault_key = conn
            .keyring()
            .map(|keyring| keyring.vault_key.clone())
            .ok_or_else(|| {
                StorageError::Validation(
                    "vault must be unlocked before rotating the key epoch".to_string(),
                )
            })?;
        let vault_id: String = conn
            .inner()
            .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::Database)?;

        let (result, _) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::RotateKeyEpoch,
            context,
            || {
                let new_epoch_id = Uuid::new_v4().to_string();
                let new_epoch_key =
                    Zeroizing::new(aead::generate_key().map_err(StorageError::Crypto)?);
                let wrapped = aead::encrypt(
                    vault_key.as_slice(),
                    new_epoch_key.as_slice(),
                    &random_epoch_wrap_aad(vault_id.as_bytes(), &new_epoch_id),
                )
                .map_err(StorageError::Crypto)?;
                let rotated_at = chrono::Utc::now().to_rfc3339();
                Self::rotate_inner(conn, ctx, &new_epoch_id, &wrapped, &rotated_at)
            },
        )?;

        if let Err(error) = UnlockService::refresh_verified_keyring(conn) {
            conn.clear_session();
            return Err(error);
        }
        Ok(result)
    }

    fn rotate_inner(
        conn: &VaultConnection,
        ctx: &CommitContext,
        new_epoch_id: &str,
        wrapped_epoch_key_ct: &[u8],
        rotated_at: &str,
    ) -> StorageResult<(KeyEpochRotationResult, String)> {
        Uuid::parse_str(new_epoch_id)
            .map_err(|_| StorageError::Validation("new key epoch ID must be a UUID".to_string()))?;
        let previous_epoch_id: String = conn
            .inner()
            .query_row(
                "SELECT active_key_epoch_id FROM vault_meta LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::Database)?;
        if conn.active_key_epoch_id() != Some(previous_epoch_id.as_str()) {
            return Err(StorageError::Validation(
                "connection key epoch state is stale; unlock the vault again before rotation"
                    .to_string(),
            ));
        }

        conn.inner().execute(
            "INSERT INTO key_epochs
                (key_epoch_id, status, wrapped_epoch_key_ct, kdf_profile_id,
                 created_at, activated_at, retired_at)
             VALUES (?1, 'created', ?2, ?3, ?4, NULL, NULL)",
            rusqlite::params![
                new_epoch_id,
                wrapped_epoch_key_ct,
                RANDOM_KEY_EPOCH_PROFILE_ID,
                rotated_at
            ],
        )?;
        let retired = conn.inner().execute(
            "UPDATE key_epochs
             SET status = 'retired', retired_at = ?1
             WHERE key_epoch_id = ?2 AND status = 'active'",
            rusqlite::params![rotated_at, previous_epoch_id],
        )?;
        if retired != 1 {
            return Err(StorageError::Validation(
                "active key epoch changed during rotation".to_string(),
            ));
        }
        let activated = conn.inner().execute(
            "UPDATE key_epochs
             SET status = 'active', activated_at = ?1, retired_at = NULL
             WHERE key_epoch_id = ?2 AND status = 'created'",
            rusqlite::params![rotated_at, new_epoch_id],
        )?;
        if activated != 1 {
            return Err(StorageError::Validation(
                "new key epoch could not be activated".to_string(),
            ));
        }
        conn.inner().execute(
            "UPDATE vault_meta
             SET active_key_epoch_id = ?1, updated_at = ?2",
            rusqlite::params![new_epoch_id, rotated_at],
        )?;
        crate::vault_header_integrity::refresh_after_mutation(conn)?;
        UnlockService::validate_active_key_epoch(conn)?;

        let changed_ids = vec![previous_epoch_id.clone(), new_epoch_id.to_string()];
        let commit_id = ctx.create_commit(conn, "key-rotation", "key-epoch", &changed_ids, &[])?;
        let result = KeyEpochRotationResult {
            previous_epoch_id,
            active_epoch_id: new_epoch_id.to_string(),
            commit_id: commit_id.clone(),
            rotated_at: rotated_at.to_string(),
        };
        Ok((result, commit_id))
    }
}

pub(crate) fn random_epoch_wrap_aad(vault_id: &[u8], key_epoch_id: &str) -> Vec<u8> {
    let mut aad = Vec::new();
    for part in [
        RANDOM_KEY_EPOCH_AAD_DOMAIN,
        vault_id,
        key_epoch_id.as_bytes(),
    ] {
        aad.extend_from_slice(&(part.len() as u64).to_le_bytes());
        aad.extend_from_slice(part);
    }
    aad
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbx_core::tiga::{DeviceAssurance, DeviceContext, TigaOperation};

    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::project::ProjectRepo;

    fn device() -> DeviceContext {
        DeviceContext {
            device_id: Some("rotation-device".to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: true,
            screen_capture_protection_available: true,
            secure_temp_files_available: true,
        }
    }

    fn rotate(
        conn: &mut VaultConnection,
        ctx: &CommitContext,
    ) -> StorageResult<KeyEpochRotationResult> {
        let session = conn.active_session().cloned().unwrap();
        let device = device();
        KeyEpochService::rotate_authorized(
            conn,
            ctx,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: session.assurance.authenticated_at_unix_secs + 1,
            },
        )
    }

    #[test]
    fn authorized_rotation_uses_random_material_and_preserves_old_fields() {
        let path = std::env::temp_dir().join(format!("mdbx-random-epoch-{}.mdbx", Uuid::new_v4()));
        let before_id;
        let after_id;
        let result;
        {
            let mut conn = VaultConnection::create(&path).unwrap();
            initialize_vault(&conn, &VaultInitParams::default()).unwrap();
            UnlockService::setup_password(&mut conn, "rotation password").unwrap();
            let ctx = CommitContext::new("rotation-device".to_string());
            let root_key = conn.keyring().unwrap().vault_key.clone();
            let before = ProjectRepo::create(&conn, &ctx, "Before", None, None).unwrap();
            before_id = before.project_id;

            result = rotate(&mut conn, &ctx).unwrap();
            assert_eq!(
                conn.active_key_epoch_id(),
                Some(result.active_epoch_id.as_str())
            );
            assert!(conn.keyring_for_epoch(&result.previous_epoch_id).is_some());
            assert!(conn.keyring_for_epoch(&result.active_epoch_id).is_some());

            let after = ProjectRepo::create(&conn, &ctx, "After", None, None).unwrap();
            after_id = after.project_id;
            assert_eq!(
                ProjectRepo::get_by_id(&conn, &before_id)
                    .unwrap()
                    .unwrap()
                    .title_ct,
                b"Before"
            );
            assert_eq!(
                ProjectRepo::get_by_id(&conn, &after_id)
                    .unwrap()
                    .unwrap()
                    .title_ct,
                b"After"
            );

            let (profile, wrapped): (String, Vec<u8>) = conn
                .inner()
                .query_row(
                    "SELECT kdf_profile_id, wrapped_epoch_key_ct
                     FROM key_epochs WHERE key_epoch_id = ?1",
                    rusqlite::params![result.active_epoch_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(profile, RANDOM_KEY_EPOCH_PROFILE_ID);
            let vault_id: String = conn
                .inner()
                .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
                .unwrap();
            let epoch_key = aead::decrypt(
                &root_key,
                &wrapped,
                &random_epoch_wrap_aad(vault_id.as_bytes(), &result.active_epoch_id),
            )
            .unwrap();
            assert_eq!(epoch_key.len(), 32);
            assert_ne!(epoch_key.as_slice(), root_key.as_slice());

            let old_state: (String, Option<String>) = conn
                .inner()
                .query_row(
                    "SELECT status, retired_at FROM key_epochs WHERE key_epoch_id = ?1",
                    rusqlite::params![result.previous_epoch_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(old_state.0, "retired");
            assert!(old_state.1.is_some());

            let commit: (String, String) = conn
                .inner()
                .query_row(
                    "SELECT commit_kind, change_scope FROM commits WHERE commit_id = ?1",
                    rusqlite::params![result.commit_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!(
                commit,
                ("key-rotation".to_string(), "key-epoch".to_string())
            );
            let events = TigaService::list_security_audit_events(&conn, 10).unwrap();
            let event = events
                .iter()
                .find(|event| event.operation == TigaOperation::RotateKeyEpoch)
                .unwrap();
            assert_eq!(event.commit_id.as_deref(), Some(result.commit_id.as_str()));
        }

        let mut reopened = VaultConnection::open(&path).unwrap();
        UnlockService::unlock_with_password(&mut reopened, "rotation password").unwrap();
        assert_eq!(
            ProjectRepo::get_by_id(&reopened, &before_id)
                .unwrap()
                .unwrap()
                .title_ct,
            b"Before"
        );
        assert_eq!(
            ProjectRepo::get_by_id(&reopened, &after_id)
                .unwrap()
                .unwrap()
                .title_ct,
            b"After"
        );
        assert_eq!(
            reopened.active_key_epoch_id(),
            Some(result.active_epoch_id.as_str())
        );
        drop(reopened);
        for suffix in ["", "-wal", "-shm"] {
            let mut candidate = path.as_os_str().to_os_string();
            candidate.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(candidate));
        }
    }

    #[test]
    fn denied_rotation_keeps_epoch_and_commit_state() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, "rotation password").unwrap();
        let ctx = CommitContext::new("rotation-device".to_string());
        let before_epoch = conn.active_key_epoch_id().unwrap().to_string();
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let device = device();

        let error = KeyEpochService::rotate_authorized(
            &mut conn,
            &ctx,
            TigaAuthorizationContext {
                session: None,
                device: &device,
                now_unix_secs: 1,
            },
        )
        .unwrap_err();

        assert!(matches!(error, StorageError::Authorization(_)));
        assert_eq!(conn.active_key_epoch_id(), Some(before_epoch.as_str()));
        let active_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM key_epochs WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_count, 1);
        let after_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before_commits, after_commits);
    }

    #[test]
    fn failed_inner_rotation_rolls_back_retirement() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, "rotation password").unwrap();
        let ctx = CommitContext::new("rotation-device".to_string());
        let active_id = conn.active_key_epoch_id().unwrap().to_string();
        let vault_key = conn.keyring().unwrap().vault_key.clone();
        let vault_id: String = conn
            .inner()
            .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
            .unwrap();
        let replacement = aead::generate_key().unwrap();
        let wrapped = aead::encrypt(
            &vault_key,
            &replacement,
            &random_epoch_wrap_aad(vault_id.as_bytes(), &active_id),
        )
        .unwrap();

        let result = conn.with_immediate_transaction(|| {
            KeyEpochService::rotate_inner(&conn, &ctx, &active_id, &wrapped, "2026-07-20T00:00:00Z")
        });

        assert!(result.is_err());
        let state: (String, Option<String>) = conn
            .inner()
            .query_row(
                "SELECT status, retired_at FROM key_epochs WHERE key_epoch_id = ?1",
                rusqlite::params![active_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state.0, "active");
        assert!(state.1.is_none());
    }

    #[test]
    fn rotate_operation_serializes_with_a_stable_name() {
        assert_eq!(
            serde_json::to_string(&TigaOperation::RotateKeyEpoch).unwrap(),
            "\"rotate-key-epoch\""
        );
        assert_eq!(
            serde_json::from_str::<TigaOperation>("\"rotate-key-epoch\"").unwrap(),
            TigaOperation::RotateKeyEpoch
        );
    }
}
