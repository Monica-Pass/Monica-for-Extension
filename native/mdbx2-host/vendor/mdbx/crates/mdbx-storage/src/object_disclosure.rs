use mdbx_core::model::Entry;
use mdbx_core::tiga::{AuthorizationDecision, DeviceContext, TigaOperation, TigaScope};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{
    enforce_plaintext_length, enforce_stored_ciphertext_length, max_field_ciphertext_bytes,
    MAX_PRESENTATION_TITLE_BYTES,
};
use crate::repo::EntryRepo;
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

/// Default maximum plaintext payload disclosed through the policy-aware object boundary.
pub const DEFAULT_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES: u64 = 8 * 1024 * 1024;

/// Hard ceiling for a caller-selected object disclosure limit.
pub const HARD_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// Validated resource contract for one object payload disclosure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectDisclosureLimits {
    max_payload_bytes: u64,
}

impl ObjectDisclosureLimits {
    pub fn new(max_payload_bytes: u64) -> StorageResult<Self> {
        if max_payload_bytes == 0 || max_payload_bytes > HARD_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES {
            return Err(StorageError::Validation(format!(
                "object disclosure max_payload_bytes must be between 1 and {HARD_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES}"
            )));
        }
        Ok(Self { max_payload_bytes })
    }

    pub fn max_payload_bytes(self) -> u64 {
        self.max_payload_bytes
    }

    fn max_ciphertext_bytes(self) -> u64 {
        max_field_ciphertext_bytes(self.max_payload_bytes)
    }
}

impl Default for ObjectDisclosureLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: DEFAULT_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES,
        }
    }
}

/// A generic encrypted object returned only after its disclosure policy allows plaintext access.
#[derive(Debug, Clone)]
pub struct DisclosedObject {
    pub object: Entry,
    pub authorization: AuthorizationDecision,
}

/// Central plaintext boundary for generic object payloads.
pub struct ObjectDisclosureService;

impl ObjectDisclosureService {
    /// Authorize `RevealSecret`, decrypt the object, and audit the successful decision in one
    /// storage transaction. Denied decisions are audited without reading encrypted object fields.
    pub fn reveal_authorized(
        conn: &VaultConnection,
        object_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<DisclosedObject> {
        Self::reveal_authorized_with_limits(
            conn,
            object_id,
            context,
            ObjectDisclosureLimits::default(),
        )
    }

    /// Apply an explicit validated payload limit while preserving policy-before-plaintext order.
    pub fn reveal_authorized_with_limits(
        conn: &VaultConnection,
        object_id: &str,
        context: TigaAuthorizationContext<'_>,
        limits: ObjectDisclosureLimits,
    ) -> StorageResult<DisclosedObject> {
        let scope = TigaScope::Entry {
            entry_id: object_id.to_string(),
        };
        let (object, authorization) = TigaService::execute_authorized(
            conn,
            &scope,
            TigaOperation::RevealSecret,
            context,
            || Self::read_active_object(conn, object_id, limits),
        )?;
        Ok(DisclosedObject {
            object,
            authorization,
        })
    }

    /// Use the connection's active session and renew idle activity only after plaintext was
    /// successfully disclosed.
    pub fn reveal_with_active_session(
        conn: &mut VaultConnection,
        object_id: &str,
        device: &DeviceContext,
        now_unix_secs: i64,
    ) -> StorageResult<DisclosedObject> {
        Self::reveal_with_active_session_and_limits(
            conn,
            object_id,
            device,
            now_unix_secs,
            ObjectDisclosureLimits::default(),
        )
    }

    /// Use the active session with an explicit validated payload disclosure limit.
    pub fn reveal_with_active_session_and_limits(
        conn: &mut VaultConnection,
        object_id: &str,
        device: &DeviceContext,
        now_unix_secs: i64,
        limits: ObjectDisclosureLimits,
    ) -> StorageResult<DisclosedObject> {
        let session = conn.active_session().cloned();
        let disclosed = Self::reveal_authorized_with_limits(
            conn,
            object_id,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device,
                now_unix_secs,
            },
            limits,
        )?;
        conn.touch_active_session(now_unix_secs);
        Ok(disclosed)
    }

    fn read_active_object(
        conn: &VaultConnection,
        object_id: &str,
        limits: ObjectDisclosureLimits,
    ) -> StorageResult<Entry> {
        let policy_context = EntryRepo::get_policy_context(conn, object_id)?
            .ok_or_else(|| StorageError::NotFound(object_id.to_string()))?;
        if policy_context.deleted {
            return Err(StorageError::ConstraintViolation(
                "cannot reveal a deleted object".to_string(),
            ));
        }
        if let Some(title_ciphertext_bytes) = EntryRepo::title_ciphertext_len(conn, object_id)? {
            enforce_stored_ciphertext_length(
                "object title ciphertext bytes",
                title_ciphertext_bytes,
                MAX_PRESENTATION_TITLE_BYTES,
            )?;
        }
        let ciphertext_bytes = EntryRepo::payload_ciphertext_len(conn, object_id)?
            .ok_or_else(|| StorageError::NotFound(object_id.to_string()))?;
        let max_ciphertext_bytes = limits.max_ciphertext_bytes();
        if ciphertext_bytes > max_ciphertext_bytes {
            return Err(StorageError::ResourceLimit {
                resource: "object payload ciphertext bytes".to_string(),
                actual: ciphertext_bytes,
                limit: max_ciphertext_bytes,
            });
        }
        let object = EntryRepo::get_by_id(conn, object_id)?
            .ok_or_else(|| StorageError::NotFound(object_id.to_string()))?;
        if object.deleted {
            return Err(StorageError::ConstraintViolation(
                "cannot reveal a deleted object".to_string(),
            ));
        }
        if let Some(title) = object.title_ct.as_deref() {
            enforce_plaintext_length(
                "object title plaintext bytes",
                title.len() as u64,
                MAX_PRESENTATION_TITLE_BYTES,
            )?;
        }
        let plaintext_bytes = object.payload_ct.len() as u64;
        if plaintext_bytes > limits.max_payload_bytes() {
            return Err(StorageError::ResourceLimit {
                resource: "object plaintext payload bytes".to_string(),
                actual: plaintext_bytes,
                limit: limits.max_payload_bytes(),
            });
        }
        Ok(object)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ProjectRepo};
    use mdbx_core::model::{EntryType, UnlockMethodType, VaultSession};
    use mdbx_core::tiga::{AuthorizationOutcome, DeviceAssurance, SessionAssurance, TigaOperation};
    use mdbx_crypto::keyring::Keyring;

    const NOW: i64 = 1_000;

    fn setup() -> (VaultConnection, CommitContext, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn.attach_keyring(
            Keyring::from_vault_key(&[9_u8; 32], b"object-disclosure-test").unwrap(),
        );
        conn.attach_session(VaultSession {
            session_id: "disclosure-session".to_string(),
            unlock_method: UnlockMethodType::Password,
            created_at: chrono::DateTime::from_timestamp(NOW, 0)
                .unwrap()
                .to_rfc3339(),
            assurance: SessionAssurance::from_unlock_method(UnlockMethodType::Password, NOW),
        });
        let ctx = CommitContext::new("disclosure-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Secrets", None, None).unwrap();
        let object = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Example"),
            &serde_json::json!({"username": "alice", "password": "secret"}),
        )
        .unwrap();
        (conn, ctx, object.entry_id)
    }

    fn standard_device() -> DeviceContext {
        DeviceContext {
            device_id: Some("disclosure-device".to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: false,
            screen_capture_protection_available: false,
            secure_temp_files_available: true,
        }
    }

    fn authorization_context<'a>(
        session: &'a VaultSession,
        device: &'a DeviceContext,
    ) -> TigaAuthorizationContext<'a> {
        TigaAuthorizationContext {
            session: Some(session),
            device,
            now_unix_secs: NOW + 1,
        }
    }

    #[test]
    fn object_disclosure_allows_audits_and_renews_active_session() {
        let (mut conn, _, object_id) = setup();
        let disclosed = ObjectDisclosureService::reveal_with_active_session(
            &mut conn,
            &object_id,
            &standard_device(),
            NOW + 1,
        )
        .unwrap();

        let payload: serde_json::Value =
            serde_json::from_slice(&disclosed.object.payload_ct).unwrap();
        assert_eq!(payload["password"], "secret");
        assert_eq!(disclosed.authorization.outcome, AuthorizationOutcome::Allow);
        assert_eq!(
            conn.active_session()
                .unwrap()
                .assurance
                .last_activity_at_unix_secs,
            NOW + 1
        );
        let events = TigaService::list_security_audit_events(&conn, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].operation, TigaOperation::RevealSecret);
        assert_eq!(events[0].outcome, AuthorizationOutcome::Allow);
    }

    #[test]
    fn object_disclosure_denies_before_corrupted_payload_is_decrypted() {
        let (conn, _, object_id) = setup();
        conn.inner()
            .execute("UPDATE vault_meta SET default_tiga_mode = 'power'", [])
            .unwrap();
        let limits = ObjectDisclosureLimits::new(1).unwrap();
        let oversized = limits.max_ciphertext_bytes() + 1;
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = zeroblob(?2) WHERE entry_id = ?1",
                rusqlite::params![&object_id, oversized as i64],
            )
            .unwrap();
        let session = conn.active_session().unwrap().clone();
        let error = ObjectDisclosureService::reveal_authorized_with_limits(
            &conn,
            &object_id,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &standard_device(),
                now_unix_secs: NOW + 1,
            },
            limits,
        )
        .unwrap_err();

        assert!(matches!(error, StorageError::Authorization(_)));
        assert!(EntryRepo::get_by_id(&conn, &object_id).is_err());
        let events = TigaService::list_security_audit_events(&conn, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].operation, TigaOperation::RevealSecret);
        assert_ne!(events[0].outcome, AuthorizationOutcome::Allow);
    }

    #[test]
    fn object_disclosure_rejects_oversized_ciphertext_before_loading_or_decryption() {
        let (conn, _, object_id) = setup();
        let limits = ObjectDisclosureLimits::new(16).unwrap();
        let oversized = limits.max_ciphertext_bytes() + 1;
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = zeroblob(?2) WHERE entry_id = ?1",
                rusqlite::params![&object_id, oversized as i64],
            )
            .unwrap();
        let session = conn.active_session().unwrap().clone();
        let device = standard_device();

        let error = ObjectDisclosureService::reveal_authorized_with_limits(
            &conn,
            &object_id,
            authorization_context(&session, &device),
            limits,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object payload ciphertext bytes"
                && actual == oversized
                && limit == limits.max_ciphertext_bytes()
        ));
    }

    #[test]
    fn presentation_object_disclosure_rejects_oversized_title_before_record_loading() {
        let (conn, _, object_id) = setup();
        let oversized = max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES) + 1;
        conn.inner()
            .execute(
                "UPDATE entries SET title_ct = zeroblob(?2), payload_ct = X'00'
                 WHERE entry_id = ?1",
                rusqlite::params![&object_id, oversized as i64],
            )
            .unwrap();
        let session = conn.active_session().unwrap().clone();
        let device = standard_device();

        let error = ObjectDisclosureService::reveal_authorized(
            &conn,
            &object_id,
            authorization_context(&session, &device),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object title ciphertext bytes"
                && actual == oversized
                && limit == max_field_ciphertext_bytes(MAX_PRESENTATION_TITLE_BYTES)
        ));
    }

    #[test]
    fn object_disclosure_checks_authenticated_plaintext_against_custom_limit() {
        let (conn, _, object_id) = setup();
        let limits = ObjectDisclosureLimits::new(8).unwrap();
        let session = conn.active_session().unwrap().clone();
        let device = standard_device();

        let error = ObjectDisclosureService::reveal_authorized_with_limits(
            &conn,
            &object_id,
            authorization_context(&session, &device),
            limits,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object plaintext payload bytes"
                && actual > limit
                && limit == 8
        ));
    }

    #[test]
    fn object_disclosure_limits_enforce_default_and_hard_ceiling() {
        assert_eq!(
            ObjectDisclosureLimits::default().max_payload_bytes(),
            DEFAULT_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES
        );
        assert!(ObjectDisclosureLimits::new(0).is_err());
        assert!(ObjectDisclosureLimits::new(HARD_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES).is_ok());
        assert!(ObjectDisclosureLimits::new(HARD_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES + 1).is_err());
    }

    #[test]
    fn object_disclosure_rejects_deleted_object_before_payload_decryption() {
        let (conn, ctx, object_id) = setup();
        EntryRepo::soft_delete(&conn, &ctx, &object_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                [&object_id],
            )
            .unwrap();
        let session = conn.active_session().unwrap().clone();
        let error = ObjectDisclosureService::reveal_authorized(
            &conn,
            &object_id,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &standard_device(),
                now_unix_secs: NOW + 1,
            },
        )
        .unwrap_err();

        assert!(matches!(error, StorageError::ConstraintViolation(_)));
        assert!(EntryRepo::get_by_id(&conn, &object_id).is_err());
    }
}
