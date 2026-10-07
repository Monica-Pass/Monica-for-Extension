use mdbx_core::model::{ObjectLabel, ObjectRelation};
use mdbx_core::tiga::{DeviceContext, TigaOperation, TigaScope};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{
    enforce_plaintext_length, enforce_stored_ciphertext_length, max_field_ciphertext_bytes,
    MAX_PRESENTATION_LABEL_NAME_BYTES,
};
use crate::repo::{ObjectLabelRepo, ObjectRelationRepo};
use crate::tiga::TigaService;
use crate::tiga_policy::{
    CompositeAuthorizationExecution, ScopedAuthorizationDecision, TigaAuthorizationContext,
};

/// Default maximum plaintext payload disclosed through relation or label boundaries.
pub const DEFAULT_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES: u64 = 8 * 1024 * 1024;

/// Hard ceiling for a caller-selected relation or label disclosure limit.
pub const HARD_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;

/// Validated resource contract shared by relation and label payload disclosure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectMetadataDisclosureLimits {
    max_payload_bytes: u64,
}

impl ObjectMetadataDisclosureLimits {
    pub fn new(max_payload_bytes: u64) -> StorageResult<Self> {
        if max_payload_bytes == 0
            || max_payload_bytes > HARD_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES
        {
            return Err(StorageError::Validation(format!(
                "object metadata disclosure max_payload_bytes must be between 1 and {HARD_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES}"
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

impl Default for ObjectMetadataDisclosureLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: DEFAULT_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES,
        }
    }
}

/// Typed result of a dual-entry relation authorization boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectRelationDisclosureResult {
    pub relation: Option<ObjectRelation>,
    pub source_authorization: ScopedAuthorizationDecision,
    pub target_authorization: ScopedAuthorizationDecision,
}

/// Typed result of a collection-project label authorization boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectLabelDisclosureResult {
    pub label: Option<ObjectLabel>,
    pub project_authorization: ScopedAuthorizationDecision,
}

/// Central Tiga and resource boundary for encrypted generic metadata payloads.
pub struct ObjectMetadataDisclosureService;

impl ObjectMetadataDisclosureService {
    pub fn reveal_relation_authorized(
        conn: &VaultConnection,
        relation_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<ObjectRelationDisclosureResult> {
        Self::reveal_relation_authorized_with_limits(
            conn,
            relation_id,
            context,
            ObjectMetadataDisclosureLimits::default(),
        )
    }

    pub fn reveal_relation_authorized_with_limits(
        conn: &VaultConnection,
        relation_id: &str,
        context: TigaAuthorizationContext<'_>,
        limits: ObjectMetadataDisclosureLimits,
    ) -> StorageResult<ObjectRelationDisclosureResult> {
        conn.with_immediate_transaction(|| {
            let authorization_context =
                ObjectRelationRepo::get_authorization_context(conn, relation_id)?
                    .ok_or_else(|| StorageError::NotFound(relation_id.to_string()))?;
            let scopes = [
                TigaScope::Entry {
                    entry_id: authorization_context.source_object_id,
                },
                TigaScope::Entry {
                    entry_id: authorization_context.target_object_id,
                },
            ];
            let execution = TigaService::execute_authorized_scopes(
                conn,
                &scopes,
                TigaOperation::RevealSecret,
                context,
                || Self::read_active_relation(conn, relation_id, limits),
            )?;
            relation_result(execution, scopes)
        })
    }

    pub fn reveal_relation_with_active_session(
        conn: &mut VaultConnection,
        relation_id: &str,
        device: &DeviceContext,
        now_unix_secs: i64,
    ) -> StorageResult<ObjectRelationDisclosureResult> {
        Self::reveal_relation_with_active_session_and_limits(
            conn,
            relation_id,
            device,
            now_unix_secs,
            ObjectMetadataDisclosureLimits::default(),
        )
    }

    pub fn reveal_relation_with_active_session_and_limits(
        conn: &mut VaultConnection,
        relation_id: &str,
        device: &DeviceContext,
        now_unix_secs: i64,
        limits: ObjectMetadataDisclosureLimits,
    ) -> StorageResult<ObjectRelationDisclosureResult> {
        let session = conn.active_session().cloned();
        let result = Self::reveal_relation_authorized_with_limits(
            conn,
            relation_id,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device,
                now_unix_secs,
            },
            limits,
        )?;
        if result.relation.is_some() {
            conn.touch_active_session(now_unix_secs);
        }
        Ok(result)
    }

    pub fn reveal_label_authorized(
        conn: &VaultConnection,
        label_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<ObjectLabelDisclosureResult> {
        Self::reveal_label_authorized_with_limits(
            conn,
            label_id,
            context,
            ObjectMetadataDisclosureLimits::default(),
        )
    }

    pub fn reveal_label_authorized_with_limits(
        conn: &VaultConnection,
        label_id: &str,
        context: TigaAuthorizationContext<'_>,
        limits: ObjectMetadataDisclosureLimits,
    ) -> StorageResult<ObjectLabelDisclosureResult> {
        conn.with_immediate_transaction(|| {
            let authorization_context = ObjectLabelRepo::get_authorization_context(conn, label_id)?
                .ok_or_else(|| StorageError::NotFound(label_id.to_string()))?;
            let scopes = [TigaScope::Project {
                project_id: authorization_context.collection_id,
            }];
            let execution = TigaService::execute_authorized_scopes(
                conn,
                &scopes,
                TigaOperation::RevealSecret,
                context,
                || Self::read_active_label(conn, label_id, limits),
            )?;
            label_result(execution, scopes)
        })
    }

    pub fn reveal_label_with_active_session(
        conn: &mut VaultConnection,
        label_id: &str,
        device: &DeviceContext,
        now_unix_secs: i64,
    ) -> StorageResult<ObjectLabelDisclosureResult> {
        Self::reveal_label_with_active_session_and_limits(
            conn,
            label_id,
            device,
            now_unix_secs,
            ObjectMetadataDisclosureLimits::default(),
        )
    }

    pub fn reveal_label_with_active_session_and_limits(
        conn: &mut VaultConnection,
        label_id: &str,
        device: &DeviceContext,
        now_unix_secs: i64,
        limits: ObjectMetadataDisclosureLimits,
    ) -> StorageResult<ObjectLabelDisclosureResult> {
        let session = conn.active_session().cloned();
        let result = Self::reveal_label_authorized_with_limits(
            conn,
            label_id,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device,
                now_unix_secs,
            },
            limits,
        )?;
        if result.label.is_some() {
            conn.touch_active_session(now_unix_secs);
        }
        Ok(result)
    }

    fn read_active_relation(
        conn: &VaultConnection,
        relation_id: &str,
        limits: ObjectMetadataDisclosureLimits,
    ) -> StorageResult<ObjectRelation> {
        match ObjectRelationRepo::is_deleted(conn, relation_id)? {
            None => return Err(StorageError::NotFound(relation_id.to_string())),
            Some(true) => {
                return Err(StorageError::ConstraintViolation(
                    "cannot reveal a deleted object relation".to_string(),
                ));
            }
            Some(false) => {}
        }
        let ciphertext_bytes = ObjectRelationRepo::payload_ciphertext_len(conn, relation_id)?
            .ok_or_else(|| StorageError::NotFound(relation_id.to_string()))?;
        enforce_ciphertext_limit(
            "object relation payload ciphertext bytes",
            ciphertext_bytes,
            limits,
        )?;
        let relation = ObjectRelationRepo::get_by_id(conn, relation_id)?
            .ok_or_else(|| StorageError::NotFound(relation_id.to_string()))?;
        if relation.deleted {
            return Err(StorageError::ConstraintViolation(
                "cannot reveal a deleted object relation".to_string(),
            ));
        }
        enforce_plaintext_limit(
            "object relation plaintext payload bytes",
            relation.payload_ct.len() as u64,
            limits,
        )?;
        Ok(relation)
    }

    fn read_active_label(
        conn: &VaultConnection,
        label_id: &str,
        limits: ObjectMetadataDisclosureLimits,
    ) -> StorageResult<ObjectLabel> {
        match ObjectLabelRepo::is_deleted(conn, label_id)? {
            None => return Err(StorageError::NotFound(label_id.to_string())),
            Some(true) => {
                return Err(StorageError::ConstraintViolation(
                    "cannot reveal a deleted object label".to_string(),
                ));
            }
            Some(false) => {}
        }
        let name_ciphertext_bytes = ObjectLabelRepo::name_ciphertext_len(conn, label_id)?
            .ok_or_else(|| StorageError::NotFound(label_id.to_string()))?;
        enforce_stored_ciphertext_length(
            "object label name ciphertext bytes",
            name_ciphertext_bytes,
            MAX_PRESENTATION_LABEL_NAME_BYTES,
        )?;
        let ciphertext_bytes = ObjectLabelRepo::payload_ciphertext_len(conn, label_id)?
            .ok_or_else(|| StorageError::NotFound(label_id.to_string()))?;
        enforce_ciphertext_limit(
            "object label payload ciphertext bytes",
            ciphertext_bytes,
            limits,
        )?;
        let label = ObjectLabelRepo::get_by_id(conn, label_id)?
            .ok_or_else(|| StorageError::NotFound(label_id.to_string()))?;
        if label.deleted {
            return Err(StorageError::ConstraintViolation(
                "cannot reveal a deleted object label".to_string(),
            ));
        }
        enforce_plaintext_length(
            "object label name plaintext bytes",
            label.name_ct.len() as u64,
            MAX_PRESENTATION_LABEL_NAME_BYTES,
        )?;
        crate::repo::object_label::validate_name_bytes(&label.name_ct)?;
        enforce_plaintext_limit(
            "object label plaintext payload bytes",
            label.payload_ct.len() as u64,
            limits,
        )?;
        Ok(label)
    }
}

fn relation_result(
    execution: CompositeAuthorizationExecution<ObjectRelation>,
    scopes: [TigaScope; 2],
) -> StorageResult<ObjectRelationDisclosureResult> {
    let decisions: [ScopedAuthorizationDecision; 2] = execution
        .decisions
        .try_into()
        .map_err(|_| StorageError::Validation("relation authorization lost a scope".to_string()))?;
    let [source_authorization, target_authorization] = decisions;
    if source_authorization.scope != scopes[0] || target_authorization.scope != scopes[1] {
        return Err(StorageError::Validation(
            "relation authorization scope order changed".to_string(),
        ));
    }
    Ok(ObjectRelationDisclosureResult {
        relation: execution.value,
        source_authorization,
        target_authorization,
    })
}

fn label_result(
    execution: CompositeAuthorizationExecution<ObjectLabel>,
    scopes: [TigaScope; 1],
) -> StorageResult<ObjectLabelDisclosureResult> {
    let decisions: [ScopedAuthorizationDecision; 1] = execution
        .decisions
        .try_into()
        .map_err(|_| StorageError::Validation("label authorization lost its scope".to_string()))?;
    let [project_authorization] = decisions;
    if project_authorization.scope != scopes[0] {
        return Err(StorageError::Validation(
            "label authorization scope changed".to_string(),
        ));
    }
    Ok(ObjectLabelDisclosureResult {
        label: execution.value,
        project_authorization,
    })
}

fn enforce_ciphertext_limit(
    resource: &str,
    actual: u64,
    limits: ObjectMetadataDisclosureLimits,
) -> StorageResult<()> {
    let limit = limits.max_ciphertext_bytes();
    if actual > limit {
        return Err(StorageError::ResourceLimit {
            resource: resource.to_string(),
            actual,
            limit,
        });
    }
    Ok(())
}

fn enforce_plaintext_limit(
    resource: &str,
    actual: u64,
    limits: ObjectMetadataDisclosureLimits,
) -> StorageResult<()> {
    let limit = limits.max_payload_bytes();
    if actual > limit {
        return Err(StorageError::ResourceLimit {
            resource: resource.to_string(),
            actual,
            limit,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{
        CommitContext, EntryRepo, ObjectLabelCreateRequest, ObjectRelationCreateRequest,
        ProjectRepo,
    };
    use mdbx_core::model::{EntryType, RelationKindId, UnlockMethodType, VaultSession};
    use mdbx_core::tiga::{AuthorizationOutcome, DeviceAssurance, SessionAssurance, TigaMode};
    use mdbx_crypto::keyring::Keyring;

    const NOW: i64 = 2_000;

    struct Fixture {
        conn: VaultConnection,
        ctx: CommitContext,
        project_id: String,
        source_id: String,
        target_id: String,
        relation_id: String,
        label_id: String,
    }

    fn setup() -> Fixture {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn.attach_keyring(
            Keyring::from_vault_key(&[7_u8; 32], b"object-metadata-disclosure-test").unwrap(),
        );
        conn.attach_session(VaultSession {
            session_id: "metadata-disclosure-session".to_string(),
            unlock_method: UnlockMethodType::Password,
            created_at: chrono::DateTime::from_timestamp(NOW, 0)
                .unwrap()
                .to_rfc3339(),
            assurance: SessionAssurance::from_unlock_method(UnlockMethodType::Password, NOW),
        });
        let ctx = CommitContext::new("metadata-disclosure-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        let source = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Source"),
            &serde_json::json!({"body":"source"}),
        )
        .unwrap();
        let target = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Target"),
            &serde_json::json!({"body":"target"}),
        )
        .unwrap();
        let relation = ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &source.entry_id,
                &target.entry_id,
                RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                serde_json::json!({"position":1}),
            ),
        )
        .unwrap();
        let label = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(
                &project.project_id,
                "Important",
                serde_json::json!({"color":"red"}),
            ),
        )
        .unwrap();
        Fixture {
            conn,
            ctx,
            project_id: project.project_id,
            source_id: source.entry_id,
            target_id: target.entry_id,
            relation_id: relation.relation_id,
            label_id: label.label_id,
        }
    }

    fn standard_device() -> DeviceContext {
        DeviceContext {
            device_id: Some("metadata-disclosure-device".to_string()),
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
    fn relation_disclosure_returns_ordered_decisions_and_correlated_audits() {
        let mut fixture = setup();
        let result = ObjectMetadataDisclosureService::reveal_relation_with_active_session(
            &mut fixture.conn,
            &fixture.relation_id,
            &standard_device(),
            NOW + 1,
        )
        .unwrap();

        let relation = result.relation.unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&relation.payload_ct).unwrap();
        assert_eq!(payload["position"], 1);
        assert_eq!(
            result.source_authorization.scope,
            TigaScope::Entry {
                entry_id: fixture.source_id.clone()
            }
        );
        assert_eq!(
            result.target_authorization.scope,
            TigaScope::Entry {
                entry_id: fixture.target_id.clone()
            }
        );
        assert!(matches!(
            result.source_authorization.decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert!(matches!(
            result.target_authorization.decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert_eq!(
            fixture
                .conn
                .active_session()
                .unwrap()
                .assurance
                .last_activity_at_unix_secs,
            NOW + 1
        );

        let events = TigaService::list_security_audit_events(&fixture.conn, 10).unwrap();
        let reveal_events = events
            .into_iter()
            .filter(|event| event.operation == TigaOperation::RevealSecret)
            .collect::<Vec<_>>();
        assert_eq!(reveal_events.len(), 2);
        assert!(reveal_events.iter().all(|event| event.commit_id.is_none()));
        let operation_id = reveal_events[0].operation_id.as_ref().unwrap();
        assert!(reveal_events
            .iter()
            .all(|event| event.operation_id.as_ref() == Some(operation_id)));
    }

    #[test]
    fn relation_denial_precedes_payload_size_and_decryption_and_does_not_renew_session() {
        let mut fixture = setup();
        TigaService::set_entry_override(
            &fixture.conn,
            &fixture.ctx,
            &fixture.target_id,
            Some(TigaMode::Power),
        )
        .unwrap();
        let limits = ObjectMetadataDisclosureLimits::new(1).unwrap();
        let oversized = limits.max_ciphertext_bytes() + 1;
        fixture
            .conn
            .inner()
            .execute(
                "UPDATE object_relations SET payload_ct = zeroblob(?2) WHERE relation_id = ?1",
                rusqlite::params![&fixture.relation_id, oversized as i64],
            )
            .unwrap();

        let result =
            ObjectMetadataDisclosureService::reveal_relation_with_active_session_and_limits(
                &mut fixture.conn,
                &fixture.relation_id,
                &standard_device(),
                NOW + 1,
                limits,
            )
            .unwrap();

        assert!(result.relation.is_none());
        assert!(matches!(
            result.source_authorization.decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert!(!matches!(
            result.target_authorization.decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert_eq!(
            fixture
                .conn
                .active_session()
                .unwrap()
                .assurance
                .last_activity_at_unix_secs,
            NOW
        );
        assert!(ObjectRelationRepo::get_by_id(&fixture.conn, &fixture.relation_id).is_err());

        let events = TigaService::list_security_audit_events(&fixture.conn, 10).unwrap();
        let reveal_events = events
            .into_iter()
            .filter(|event| event.operation == TigaOperation::RevealSecret)
            .collect::<Vec<_>>();
        assert_eq!(reveal_events.len(), 2);
        let operation_id = reveal_events[0].operation_id.as_ref().unwrap();
        assert!(reveal_events
            .iter()
            .all(|event| event.operation_id.as_ref() == Some(operation_id)));
    }

    #[test]
    fn relation_disclosure_rejects_oversized_ciphertext_before_loading() {
        let fixture = setup();
        let limits = ObjectMetadataDisclosureLimits::new(16).unwrap();
        let oversized = limits.max_ciphertext_bytes() + 1;
        fixture
            .conn
            .inner()
            .execute(
                "UPDATE object_relations SET payload_ct = zeroblob(?2) WHERE relation_id = ?1",
                rusqlite::params![&fixture.relation_id, oversized as i64],
            )
            .unwrap();
        let session = fixture.conn.active_session().unwrap().clone();
        let device = standard_device();

        let error = ObjectMetadataDisclosureService::reveal_relation_authorized_with_limits(
            &fixture.conn,
            &fixture.relation_id,
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
            } if resource == "object relation payload ciphertext bytes"
                && actual == oversized
                && limit == limits.max_ciphertext_bytes()
        ));
    }

    #[test]
    fn label_disclosure_inherits_project_policy_before_decryption() {
        let mut fixture = setup();
        TigaService::set_project_override(
            &fixture.conn,
            &fixture.ctx,
            &fixture.project_id,
            Some(TigaMode::Power),
        )
        .unwrap();
        fixture
            .conn
            .inner()
            .execute(
                "UPDATE object_labels SET name_ct = zeroblob(?2), payload_ct = X'00'
                 WHERE label_id = ?1",
                rusqlite::params![
                    &fixture.label_id,
                    (max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES) + 1) as i64,
                ],
            )
            .unwrap();

        let result = ObjectMetadataDisclosureService::reveal_label_with_active_session(
            &mut fixture.conn,
            &fixture.label_id,
            &standard_device(),
            NOW + 1,
        )
        .unwrap();

        assert!(result.label.is_none());
        assert_eq!(
            result.project_authorization.scope,
            TigaScope::Project {
                project_id: fixture.project_id.clone()
            }
        );
        assert!(!matches!(
            result.project_authorization.decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert_eq!(
            fixture
                .conn
                .active_session()
                .unwrap()
                .assurance
                .last_activity_at_unix_secs,
            NOW
        );
        assert!(ObjectLabelRepo::get_by_id(&fixture.conn, &fixture.label_id).is_err());
    }

    #[test]
    fn presentation_label_disclosure_rejects_oversized_name_before_record_loading() {
        let fixture = setup();
        let oversized = max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES) + 1;
        fixture
            .conn
            .inner()
            .execute(
                "UPDATE object_labels SET name_ct = zeroblob(?2), payload_ct = X'00'
                 WHERE label_id = ?1",
                rusqlite::params![&fixture.label_id, oversized as i64],
            )
            .unwrap();
        let session = fixture.conn.active_session().unwrap().clone();
        let device = standard_device();

        let error = ObjectMetadataDisclosureService::reveal_label_authorized(
            &fixture.conn,
            &fixture.label_id,
            authorization_context(&session, &device),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object label name ciphertext bytes"
                && actual == oversized
                && limit == max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES)
        ));
    }

    #[test]
    fn label_disclosure_checks_authenticated_plaintext_and_renews_only_on_success() {
        let mut fixture = setup();
        let session = fixture.conn.active_session().unwrap().clone();
        let device = standard_device();
        let error = ObjectMetadataDisclosureService::reveal_label_authorized_with_limits(
            &fixture.conn,
            &fixture.label_id,
            authorization_context(&session, &device),
            ObjectMetadataDisclosureLimits::new(4).unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit: 4,
            } if resource == "object label plaintext payload bytes" && actual > 4
        ));
        assert_eq!(
            fixture
                .conn
                .active_session()
                .unwrap()
                .assurance
                .last_activity_at_unix_secs,
            NOW
        );

        let result = ObjectMetadataDisclosureService::reveal_label_with_active_session(
            &mut fixture.conn,
            &fixture.label_id,
            &device,
            NOW + 1,
        )
        .unwrap();
        assert!(result.label.is_some());
        assert_eq!(
            fixture
                .conn
                .active_session()
                .unwrap()
                .assurance
                .last_activity_at_unix_secs,
            NOW + 1
        );
    }

    #[test]
    fn deleted_metadata_is_rejected_before_corrupted_payload_decryption() {
        let fixture = setup();
        ObjectRelationRepo::soft_delete(&fixture.conn, &fixture.ctx, &fixture.relation_id).unwrap();
        ObjectLabelRepo::soft_delete(&fixture.conn, &fixture.ctx, &fixture.label_id).unwrap();
        fixture
            .conn
            .inner()
            .execute(
                "UPDATE object_relations SET payload_ct = X'00' WHERE relation_id = ?1",
                [&fixture.relation_id],
            )
            .unwrap();
        fixture
            .conn
            .inner()
            .execute(
                "UPDATE object_labels SET payload_ct = X'00' WHERE label_id = ?1",
                [&fixture.label_id],
            )
            .unwrap();
        let session = fixture.conn.active_session().unwrap().clone();
        let device = standard_device();

        let relation_error = ObjectMetadataDisclosureService::reveal_relation_authorized(
            &fixture.conn,
            &fixture.relation_id,
            authorization_context(&session, &device),
        )
        .unwrap_err();
        let label_error = ObjectMetadataDisclosureService::reveal_label_authorized(
            &fixture.conn,
            &fixture.label_id,
            authorization_context(&session, &device),
        )
        .unwrap_err();

        assert!(matches!(
            relation_error,
            StorageError::ConstraintViolation(_)
        ));
        assert!(matches!(label_error, StorageError::ConstraintViolation(_)));
    }

    #[test]
    fn metadata_disclosure_limits_enforce_default_and_hard_ceiling() {
        assert_eq!(
            ObjectMetadataDisclosureLimits::default().max_payload_bytes(),
            DEFAULT_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES
        );
        assert!(ObjectMetadataDisclosureLimits::new(0).is_err());
        assert!(ObjectMetadataDisclosureLimits::new(
            HARD_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES
        )
        .is_ok());
        assert!(ObjectMetadataDisclosureLimits::new(
            HARD_MAX_OBJECT_METADATA_DISCLOSURE_PAYLOAD_BYTES + 1
        )
        .is_err());
    }
}
