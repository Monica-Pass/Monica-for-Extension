#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxTigaMode {
    Sky,
    Multi,
    Power,
}

impl From<MdbxTigaMode> for TigaMode {
    fn from(value: MdbxTigaMode) -> Self {
        match value {
            MdbxTigaMode::Sky => TigaMode::Sky,
            MdbxTigaMode::Multi => TigaMode::Multi,
            MdbxTigaMode::Power => TigaMode::Power,
        }
    }
}

impl From<TigaMode> for MdbxTigaMode {
    fn from(value: TigaMode) -> Self {
        match value {
            TigaMode::Sky => Self::Sky,
            TigaMode::Multi => Self::Multi,
            TigaMode::Power => Self::Power,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxDeviceAssurance {
    Unknown,
    Standard,
    TrustedHardware,
}

impl From<MdbxDeviceAssurance> for DeviceAssurance {
    fn from(value: MdbxDeviceAssurance) -> Self {
        match value {
            MdbxDeviceAssurance::Unknown => Self::Unknown,
            MdbxDeviceAssurance::Standard => Self::Standard,
            MdbxDeviceAssurance::TrustedHardware => Self::TrustedHardware,
        }
    }
}

impl From<DeviceAssurance> for MdbxDeviceAssurance {
    fn from(value: DeviceAssurance) -> Self {
        match value {
            DeviceAssurance::Unknown => Self::Unknown,
            DeviceAssurance::Standard => Self::Standard,
            DeviceAssurance::TrustedHardware => Self::TrustedHardware,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxDeviceContext {
    pub assurance: MdbxDeviceAssurance,
    pub secure_clipboard_available: bool,
    pub screen_capture_protection_available: bool,
    pub secure_temp_files_available: bool,
}

impl MdbxDeviceContext {
    pub(crate) fn into_core(self, device_id: &str) -> DeviceContext {
        DeviceContext {
            device_id: Some(device_id.to_string()),
            assurance: self.assurance.into(),
            secure_clipboard_available: self.secure_clipboard_available,
            screen_capture_protection_available: self.screen_capture_protection_available,
            secure_temp_files_available: self.secure_temp_files_available,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxTigaScopeType {
    Vault,
    Project,
    Entry,
    Attachment,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxTigaScope {
    pub scope_type: MdbxTigaScopeType,
    pub scope_id: Option<String>,
}

impl MdbxTigaScope {
    pub(crate) fn into_core(self) -> Result<TigaScope, MdbxFfiError> {
        match self.scope_type {
            MdbxTigaScopeType::Vault => Ok(TigaScope::Vault),
            MdbxTigaScopeType::Project => Ok(TigaScope::Project {
                project_id: required_scope_id(self.scope_id, "project")?,
            }),
            MdbxTigaScopeType::Entry => Ok(TigaScope::Entry {
                entry_id: required_scope_id(self.scope_id, "entry")?,
            }),
            MdbxTigaScopeType::Attachment => Ok(TigaScope::Attachment {
                attachment_id: required_scope_id(self.scope_id, "attachment")?,
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxTigaOperation {
    RevealSecret,
    CopySecret,
    ExportData,
    PrintData,
    DecryptAttachment,
    CreateSnapshot,
    RestoreSnapshot,
    ChangeUnlockMethods,
    ChangeSecurityPolicy,
    ChangeRecoveryMethods,
    RotateKeyEpoch,
    DeleteAuditRecords,
    ManageDeletedObjectRetention,
    ManageSnapshotRetention,
    PurgeDeletedObject,
    BackgroundAccess,
    SyncCiphertext,
    CreatePlaintextCache,
    MigratePayload,
}

impl From<MdbxTigaOperation> for TigaOperation {
    fn from(value: MdbxTigaOperation) -> Self {
        match value {
            MdbxTigaOperation::RevealSecret => Self::RevealSecret,
            MdbxTigaOperation::CopySecret => Self::CopySecret,
            MdbxTigaOperation::ExportData => Self::ExportData,
            MdbxTigaOperation::PrintData => Self::PrintData,
            MdbxTigaOperation::DecryptAttachment => Self::DecryptAttachment,
            MdbxTigaOperation::MigratePayload => Self::MigratePayload,
            MdbxTigaOperation::CreateSnapshot => Self::CreateSnapshot,
            MdbxTigaOperation::RestoreSnapshot => Self::RestoreSnapshot,
            MdbxTigaOperation::ChangeUnlockMethods => Self::ChangeUnlockMethods,
            MdbxTigaOperation::ChangeSecurityPolicy => Self::ChangeSecurityPolicy,
            MdbxTigaOperation::ChangeRecoveryMethods => Self::ChangeRecoveryMethods,
            MdbxTigaOperation::RotateKeyEpoch => Self::RotateKeyEpoch,
            MdbxTigaOperation::DeleteAuditRecords => Self::DeleteAuditRecords,
            MdbxTigaOperation::ManageDeletedObjectRetention => Self::ManageDeletedObjectRetention,
            MdbxTigaOperation::ManageSnapshotRetention => Self::ManageSnapshotRetention,
            MdbxTigaOperation::PurgeDeletedObject => Self::PurgeDeletedObject,
            MdbxTigaOperation::BackgroundAccess => Self::BackgroundAccess,
            MdbxTigaOperation::SyncCiphertext => Self::SyncCiphertext,
            MdbxTigaOperation::CreatePlaintextCache => Self::CreatePlaintextCache,
        }
    }
}

impl From<TigaOperation> for MdbxTigaOperation {
    fn from(value: TigaOperation) -> Self {
        match value {
            TigaOperation::RevealSecret => Self::RevealSecret,
            TigaOperation::CopySecret => Self::CopySecret,
            TigaOperation::ExportData => Self::ExportData,
            TigaOperation::PrintData => Self::PrintData,
            TigaOperation::DecryptAttachment => Self::DecryptAttachment,
            TigaOperation::MigratePayload => Self::MigratePayload,
            TigaOperation::CreateSnapshot => Self::CreateSnapshot,
            TigaOperation::RestoreSnapshot => Self::RestoreSnapshot,
            TigaOperation::ChangeUnlockMethods => Self::ChangeUnlockMethods,
            TigaOperation::ChangeSecurityPolicy => Self::ChangeSecurityPolicy,
            TigaOperation::ChangeRecoveryMethods => Self::ChangeRecoveryMethods,
            TigaOperation::RotateKeyEpoch => Self::RotateKeyEpoch,
            TigaOperation::DeleteAuditRecords => Self::DeleteAuditRecords,
            TigaOperation::ManageDeletedObjectRetention => Self::ManageDeletedObjectRetention,
            TigaOperation::ManageSnapshotRetention => Self::ManageSnapshotRetention,
            TigaOperation::PurgeDeletedObject => Self::PurgeDeletedObject,
            TigaOperation::BackgroundAccess => Self::BackgroundAccess,
            TigaOperation::SyncCiphertext => Self::SyncCiphertext,
            TigaOperation::CreatePlaintextCache => Self::CreatePlaintextCache,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxAuthorizationOutcome {
    Allow,
    AllowWithConstraints,
    RequireFreshAuthentication,
    RequireAdditionalFactor,
    Deny,
}

impl From<AuthorizationOutcome> for MdbxAuthorizationOutcome {
    fn from(value: AuthorizationOutcome) -> Self {
        match value {
            AuthorizationOutcome::Allow => Self::Allow,
            AuthorizationOutcome::AllowWithConstraints => Self::AllowWithConstraints,
            AuthorizationOutcome::RequireFreshAuthentication => Self::RequireFreshAuthentication,
            AuthorizationOutcome::RequireAdditionalFactor => Self::RequireAdditionalFactor,
            AuthorizationOutcome::Deny => Self::Deny,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxAuthorizationReason {
    SessionMissing,
    SessionExpired,
    AuthenticationStale,
    InsufficientAuthenticationFactors,
    SecurityKeyRequired,
    DeviceAssuranceInsufficient,
    SecureClipboardUnavailable,
    ScreenCaptureProtectionUnavailable,
    OperationDisabled,
    PolicyWeakeningNotAuthorized,
    PolicyExceptionInvalid,
}

impl From<AuthorizationReason> for MdbxAuthorizationReason {
    fn from(value: AuthorizationReason) -> Self {
        match value {
            AuthorizationReason::SessionMissing => Self::SessionMissing,
            AuthorizationReason::SessionExpired => Self::SessionExpired,
            AuthorizationReason::AuthenticationStale => Self::AuthenticationStale,
            AuthorizationReason::InsufficientAuthenticationFactors => {
                Self::InsufficientAuthenticationFactors
            }
            AuthorizationReason::SecurityKeyRequired => Self::SecurityKeyRequired,
            AuthorizationReason::DeviceAssuranceInsufficient => Self::DeviceAssuranceInsufficient,
            AuthorizationReason::SecureClipboardUnavailable => Self::SecureClipboardUnavailable,
            AuthorizationReason::ScreenCaptureProtectionUnavailable => {
                Self::ScreenCaptureProtectionUnavailable
            }
            AuthorizationReason::OperationDisabled => Self::OperationDisabled,
            AuthorizationReason::PolicyWeakeningNotAuthorized => Self::PolicyWeakeningNotAuthorized,
            AuthorizationReason::PolicyExceptionInvalid => Self::PolicyExceptionInvalid,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxAuthorizationConstraintKind {
    ClearClipboardAfterSeconds,
    ExcludeClipboardHistory,
    PreventScreenCapture,
    NoPlaintextPersistence,
    UseSecureTemporaryFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxAuthorizationConstraint {
    pub kind: MdbxAuthorizationConstraintKind,
    pub seconds: Option<u32>,
}

impl From<AuthorizationConstraint> for MdbxAuthorizationConstraint {
    fn from(value: AuthorizationConstraint) -> Self {
        match value {
            AuthorizationConstraint::ClearClipboardAfterSeconds(seconds) => Self {
                kind: MdbxAuthorizationConstraintKind::ClearClipboardAfterSeconds,
                seconds: Some(seconds),
            },
            AuthorizationConstraint::ExcludeClipboardHistory => Self {
                kind: MdbxAuthorizationConstraintKind::ExcludeClipboardHistory,
                seconds: None,
            },
            AuthorizationConstraint::PreventScreenCapture => Self {
                kind: MdbxAuthorizationConstraintKind::PreventScreenCapture,
                seconds: None,
            },
            AuthorizationConstraint::NoPlaintextPersistence => Self {
                kind: MdbxAuthorizationConstraintKind::NoPlaintextPersistence,
                seconds: None,
            },
            AuthorizationConstraint::UseSecureTemporaryFiles => Self {
                kind: MdbxAuthorizationConstraintKind::UseSecureTemporaryFiles,
                seconds: None,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxAuthorizationDecision {
    pub outcome: MdbxAuthorizationOutcome,
    pub reasons: Vec<MdbxAuthorizationReason>,
    pub constraints: Vec<MdbxAuthorizationConstraint>,
    pub audit_required: bool,
}

impl From<AuthorizationDecision> for MdbxAuthorizationDecision {
    fn from(value: AuthorizationDecision) -> Self {
        Self {
            outcome: value.outcome.into(),
            reasons: value.reasons.into_iter().map(Into::into).collect(),
            constraints: value.constraints.into_iter().map(Into::into).collect(),
            audit_required: value.audit_required,
        }
    }
}

/// One authorization decision together with the exact existing Tiga scope that produced it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxScopedAuthorizationDecision {
    pub scope: MdbxTigaScope,
    pub decision: MdbxAuthorizationDecision,
}

impl From<ScopedAuthorizationDecision> for MdbxScopedAuthorizationDecision {
    fn from(value: ScopedAuthorizationDecision) -> Self {
        Self {
            scope: scope_from_core(value.scope),
            decision: value.decision.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxPolicyCompliance {
    Compliant,
    Exception,
    RemediationRequired,
}

impl From<PolicyCompliance> for MdbxPolicyCompliance {
    fn from(value: PolicyCompliance) -> Self {
        match value {
            PolicyCompliance::Compliant => Self::Compliant,
            PolicyCompliance::Exception => Self::Exception,
            PolicyCompliance::RemediationRequired => Self::RemediationRequired,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxAuditLevel {
    SecurityChanges,
    SensitiveOperations,
    AllDecisions,
}

impl From<AuditLevel> for MdbxAuditLevel {
    fn from(value: AuditLevel) -> Self {
        match value {
            AuditLevel::SecurityChanges => Self::SecurityChanges,
            AuditLevel::SensitiveOperations => Self::SensitiveOperations,
            AuditLevel::AllDecisions => Self::AllDecisions,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxResolvedTigaPolicy {
    pub policy_version: u32,
    pub profile: MdbxTigaMode,
    pub compliance: MdbxPolicyCompliance,
    pub exception_id: Option<String>,
    pub warnings: Vec<String>,
    pub portable_unlock_allowed: bool,
    pub minimum_auth_factors: u32,
    pub security_key_required: bool,
    pub security_key_recommended: bool,
    pub idle_timeout_secs: u32,
    pub max_lifetime_secs: u32,
    pub lock_on_background: bool,
    pub fresh_auth_window_secs: u32,
    pub reveal_requires_fresh_auth: bool,
    pub clipboard_allowed: bool,
    pub clipboard_ttl_secs: u32,
    pub copy_requires_fresh_auth: bool,
    pub secure_clipboard_required: bool,
    pub screen_capture_protection_required: bool,
    pub export_allowed: bool,
    pub print_allowed: bool,
    pub egress_requires_fresh_auth: bool,
    pub egress_minimum_auth_factors: u32,
    pub persistent_plaintext_cache_allowed: bool,
    pub attachment_temp_files_allowed: bool,
    pub locked_ciphertext_sync_allowed: bool,
    pub minimum_recovery_methods: u32,
    pub portable_recovery_required: bool,
    pub administration_requires_fresh_auth: bool,
    pub administration_minimum_auth_factors: u32,
    pub audit_deletion_allowed: bool,
    pub minimum_device_assurance: MdbxDeviceAssurance,
    pub audit_level: MdbxAuditLevel,
}

impl From<ResolvedTigaPolicy> for MdbxResolvedTigaPolicy {
    fn from(value: ResolvedTigaPolicy) -> Self {
        let policy = value.policy;
        Self {
            policy_version: policy.policy_version,
            profile: policy.profile.into(),
            compliance: value.compliance.into(),
            exception_id: value.exception_id,
            warnings: value.warnings,
            portable_unlock_allowed: policy.unlock.portable_unlock_allowed,
            minimum_auth_factors: u32::from(policy.unlock.minimum_auth_factors),
            security_key_required: policy.unlock.security_key_required,
            security_key_recommended: policy.unlock.security_key_recommended,
            idle_timeout_secs: policy.session.idle_timeout_secs,
            max_lifetime_secs: policy.session.max_lifetime_secs,
            lock_on_background: policy.session.lock_on_background,
            fresh_auth_window_secs: policy.session.fresh_auth_window_secs,
            reveal_requires_fresh_auth: policy.disclosure.reveal_requires_fresh_auth,
            clipboard_allowed: policy.disclosure.clipboard_allowed,
            clipboard_ttl_secs: policy.disclosure.clipboard_ttl_secs,
            copy_requires_fresh_auth: policy.disclosure.copy_requires_fresh_auth,
            secure_clipboard_required: policy.disclosure.secure_clipboard_required,
            screen_capture_protection_required: policy
                .disclosure
                .screen_capture_protection_required,
            export_allowed: policy.egress.export_allowed,
            print_allowed: policy.egress.print_allowed,
            egress_requires_fresh_auth: policy.egress.requires_fresh_auth,
            egress_minimum_auth_factors: u32::from(policy.egress.minimum_auth_factors),
            persistent_plaintext_cache_allowed: policy
                .data_handling
                .persistent_plaintext_cache_allowed,
            attachment_temp_files_allowed: policy.data_handling.attachment_temp_files_allowed,
            locked_ciphertext_sync_allowed: policy.data_handling.locked_ciphertext_sync_allowed,
            minimum_recovery_methods: u32::from(policy.recovery.minimum_recovery_methods),
            portable_recovery_required: policy.recovery.portable_recovery_required,
            administration_requires_fresh_auth: policy.administration.requires_fresh_auth,
            administration_minimum_auth_factors: u32::from(
                policy.administration.minimum_auth_factors,
            ),
            audit_deletion_allowed: policy.administration.audit_deletion_allowed,
            minimum_device_assurance: policy.minimum_device_assurance.into(),
            audit_level: policy.audit_level.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxUnlockMethodType {
    Pin,
    Password,
    SecurityKey,
    PasswordSecurityKey,
}

impl From<UnlockMethodType> for MdbxUnlockMethodType {
    fn from(value: UnlockMethodType) -> Self {
        match value {
            UnlockMethodType::Pin => Self::Pin,
            UnlockMethodType::Password => Self::Password,
            UnlockMethodType::SecurityKey => Self::SecurityKey,
            UnlockMethodType::PasswordSecurityKey => Self::PasswordSecurityKey,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxUnlockMethod {
    pub method_id: String,
    pub method_type: MdbxUnlockMethodType,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSessionInfo {
    pub session_id: String,
    pub unlock_method: MdbxUnlockMethodType,
    pub authenticated_at_unix_secs: i64,
    pub last_activity_at_unix_secs: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxKeyEpochRotationResult {
    pub previous_epoch_id: String,
    pub active_epoch_id: String,
    pub commit_id: String,
    pub rotated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxRollbackAnchorVerification {
    pub advanced: bool,
    pub anchored_commit_inventory_seq: u64,
    pub current_commit_inventory_seq: u64,
    pub anchored_sync_delta_batch_seq: Option<u64>,
    pub current_sync_delta_batch_seq: Option<u64>,
}

impl From<mdbx_storage::rollback_anchor::RollbackAnchorVerification>
    for MdbxRollbackAnchorVerification
{
    fn from(value: mdbx_storage::rollback_anchor::RollbackAnchorVerification) -> Self {
        Self {
            advanced: value.advanced,
            anchored_commit_inventory_seq: value.anchored_commit_inventory_seq,
            current_commit_inventory_seq: value.current_commit_inventory_seq,
            anchored_sync_delta_batch_seq: value.anchored_sync_delta_batch_seq,
            current_sync_delta_batch_seq: value.current_sync_delta_batch_seq,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxVaultContentManifestVerification {
    pub table_count: u64,
    pub row_count: u64,
    pub hashed_bytes: u64,
}

impl From<mdbx_storage::vault_content_manifest::VaultContentManifestVerification>
    for MdbxVaultContentManifestVerification
{
    fn from(value: mdbx_storage::vault_content_manifest::VaultContentManifestVerification) -> Self {
        Self {
            table_count: value.table_count,
            row_count: value.row_count,
            hashed_bytes: value.hashed_bytes,
        }
    }
}

impl From<KeyEpochRotationResult> for MdbxKeyEpochRotationResult {
    fn from(value: KeyEpochRotationResult) -> Self {
        Self {
            previous_epoch_id: value.previous_epoch_id,
            active_epoch_id: value.active_epoch_id,
            commit_id: value.commit_id,
            rotated_at: value.rotated_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxTigaUnlockAssessment {
    pub mode: MdbxTigaMode,
    pub configured_methods: Vec<MdbxUnlockMethodType>,
    pub has_portable_unlock: bool,
    pub has_security_key_unlock: bool,
    pub has_combined_password_security_key: bool,
    pub has_required_combined_strength: bool,
    pub satisfies_policy: bool,
    pub warnings: Vec<String>,
}

impl From<TigaUnlockAssessment> for MdbxTigaUnlockAssessment {
    fn from(value: TigaUnlockAssessment) -> Self {
        Self {
            mode: value.mode.into(),
            configured_methods: value
                .configured_methods
                .into_iter()
                .map(Into::into)
                .collect(),
            has_portable_unlock: value.has_portable_unlock,
            has_security_key_unlock: value.has_security_key_unlock,
            has_combined_password_security_key: value.has_combined_password_security_key,
            has_required_combined_strength: value.has_required_combined_strength,
            satisfies_policy: value.satisfies_policy,
            warnings: value.warnings,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSecurityAuditEvent {
    pub event_id: String,
    pub occurred_at: String,
    pub operation: MdbxTigaOperation,
    pub outcome: MdbxAuthorizationOutcome,
    pub scope: MdbxTigaScope,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub reasons: Vec<MdbxAuthorizationReason>,
    pub constraints: Vec<MdbxAuthorizationConstraint>,
    pub exception_id: Option<String>,
}

/// MDBX2 audit projection. The original record and list method remain stable
/// for existing generated clients; this version adds commit correlation and
/// the exact policy evidence used for authorization.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSecurityAuditEventV2 {
    pub event_id: String,
    pub occurred_at: String,
    pub operation: MdbxTigaOperation,
    pub outcome: MdbxAuthorizationOutcome,
    pub scope: MdbxTigaScope,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub reasons: Vec<MdbxAuthorizationReason>,
    pub constraints: Vec<MdbxAuthorizationConstraint>,
    pub exception_id: Option<String>,
    pub operation_id: Option<String>,
    pub commit_id: Option<String>,
    pub policy_version: Option<u32>,
    pub policy_fingerprint: Option<Vec<u8>>,
}

impl From<SecurityAuditEvent> for MdbxSecurityAuditEvent {
    fn from(value: SecurityAuditEvent) -> Self {
        Self {
            event_id: value.event_id,
            occurred_at: value.occurred_at,
            operation: value.operation.into(),
            outcome: value.outcome.into(),
            scope: scope_from_core(value.scope),
            session_id: value.session_id,
            device_id: value.device_id,
            reasons: value.reasons.into_iter().map(Into::into).collect(),
            constraints: value.constraints.into_iter().map(Into::into).collect(),
            exception_id: value.exception_id,
        }
    }
}

impl From<SecurityAuditEvent> for MdbxSecurityAuditEventV2 {
    fn from(value: SecurityAuditEvent) -> Self {
        Self {
            event_id: value.event_id,
            occurred_at: value.occurred_at,
            operation: value.operation.into(),
            outcome: value.outcome.into(),
            scope: scope_from_core(value.scope),
            session_id: value.session_id,
            device_id: value.device_id,
            reasons: value.reasons.into_iter().map(Into::into).collect(),
            constraints: value.constraints.into_iter().map(Into::into).collect(),
            exception_id: value.exception_id,
            operation_id: value.operation_id,
            commit_id: value.commit_id,
            policy_version: value.policy_version,
            policy_fingerprint: value.policy_fingerprint,
        }
    }
}

use mdbx_core::model::UnlockMethodType;
use mdbx_core::tiga::{
    AuditLevel, AuthorizationConstraint, AuthorizationDecision, AuthorizationOutcome,
    AuthorizationReason, DeviceAssurance, DeviceContext, PolicyCompliance, PolicyException,
    ResolvedTigaPolicy, TigaMode, TigaOperation, TigaPolicyOverride, TigaScope,
};
use mdbx_storage::error::StorageError;
use mdbx_storage::key_epoch::{KeyEpochRotationResult, KeyEpochService};
use mdbx_storage::repo::CommitContext;
use mdbx_storage::rollback_anchor::RollbackAnchorService;
use mdbx_storage::tiga::TigaService;
use mdbx_storage::tiga_policy::{
    ScopedAuthorizationDecision, SecurityAuditEvent, TigaAuthorizationContext,
};
use mdbx_storage::unlock::{TigaUnlockAssessment, UnlockService};
use mdbx_storage::vault_content_manifest::VaultContentManifestService;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::{MdbxFfiError, MdbxVault};

pub(crate) fn conservative_ffi_device_context() -> MdbxDeviceContext {
    MdbxDeviceContext {
        assurance: MdbxDeviceAssurance::Standard,
        secure_clipboard_available: false,
        screen_capture_protection_available: false,
        secure_temp_files_available: true,
    }
}

fn required_scope_id(value: Option<String>, scope_type: &str) -> Result<String, MdbxFfiError> {
    value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            MdbxFfiError::from(StorageError::Validation(format!(
                "{scope_type} Tiga scope requires a non-empty scope_id"
            )))
        })
}

pub(crate) fn scope_from_core(value: TigaScope) -> MdbxTigaScope {
    match value {
        TigaScope::Vault => MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Vault,
            scope_id: None,
        },
        TigaScope::Project { project_id } => MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Project,
            scope_id: Some(project_id),
        },
        TigaScope::Entry { entry_id } => MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Entry,
            scope_id: Some(entry_id),
        },
        TigaScope::Attachment { attachment_id } => MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Attachment,
            scope_id: Some(attachment_id),
        },
    }
}

pub(crate) fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

#[uniffi::export]
impl MdbxVault {
    /// Returns an opaque token for the client to persist outside the vault.
    pub fn create_rollback_anchor(&self) -> Result<Vec<u8>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(RollbackAnchorService::issue(&conn)?)
    }

    /// Verifies a previously persisted token before the client trusts the vault.
    pub fn verify_rollback_anchor(
        &self,
        token: Vec<u8>,
    ) -> Result<MdbxRollbackAnchorVerification, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(RollbackAnchorService::verify(&conn, &token)?.into())
    }

    /// Returns an opaque exact-state manifest for client-side persistence.
    pub fn create_content_manifest(&self) -> Result<Vec<u8>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(VaultContentManifestService::issue(&conn)?)
    }

    /// Verifies an exact-state manifest before the client trusts the vault.
    pub fn verify_content_manifest(
        &self,
        token: Vec<u8>,
    ) -> Result<MdbxVaultContentManifestVerification, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(VaultContentManifestService::verify(&conn, &token)?.into())
    }

    pub fn resolve_tiga_policy(
        &self,
        scope: MdbxTigaScope,
    ) -> Result<MdbxResolvedTigaPolicy, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let resolved = match scope.into_core()? {
            TigaScope::Vault => TigaService::resolve_vault_policy(&conn)?,
            TigaScope::Project { project_id } => {
                TigaService::resolve_policy_for_project(&conn, &project_id)?
            }
            TigaScope::Entry { entry_id } => {
                TigaService::resolve_policy_for_entry(&conn, &entry_id)?
            }
            TigaScope::Attachment { attachment_id } => {
                TigaService::resolve_policy_for_attachment(&conn, &attachment_id)?
            }
        };
        Ok(resolved.into())
    }

    pub fn authorize_tiga_operation(
        &self,
        scope: MdbxTigaScope,
        operation: MdbxTigaOperation,
        device: MdbxDeviceContext,
    ) -> Result<MdbxAuthorizationDecision, MdbxFfiError> {
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let scope = scope.into_core()?;
        let device = device.into_core(&self.device_id);
        let decision = TigaService::authorize_operation_with_active_session(
            &mut conn,
            &scope,
            operation.into(),
            &device,
            unix_now(),
        )?;
        Ok(decision.into())
    }

    pub fn active_session_info(&self) -> Result<Option<MdbxSessionInfo>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(conn.active_session().map(|session| MdbxSessionInfo {
            session_id: session.session_id.clone(),
            unlock_method: session.unlock_method.into(),
            authenticated_at_unix_secs: session.assurance.authenticated_at_unix_secs,
            last_activity_at_unix_secs: session.assurance.last_activity_at_unix_secs,
        }))
    }

    /// Remaining reuse window for a disclosure reader. This never authorizes
    /// disclosure or renews the session; normal reveal APIs remain mandatory.
    pub fn read_session_remaining_secs(&self, scope: MdbxTigaScope) -> Result<u64, MdbxFfiError> {
        let conn = self.conn.read().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(TigaService::read_session_remaining_secs(
            &conn,
            &scope.into_core()?,
            unix_now(),
        )?)
    }

    pub fn list_unlock_methods(&self) -> Result<Vec<MdbxUnlockMethod>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(UnlockService::list_methods(&conn)?
            .into_iter()
            .map(|method| MdbxUnlockMethod {
                method_id: method.method_id,
                method_type: method.method_type.into(),
                created_at: method.created_at,
                updated_at: method.updated_at,
            })
            .collect())
    }

    pub fn rotate_key_epoch(
        &self,
        device: MdbxDeviceContext,
    ) -> Result<MdbxKeyEpochRotationResult, MdbxFfiError> {
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        Ok(KeyEpochService::rotate_authorized(
            &mut conn,
            &ctx,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?
        .into())
    }

    pub fn assess_tiga_unlock_policy(&self) -> Result<MdbxTigaUnlockAssessment, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let mode = TigaService::get_global_default(&conn)?;
        Ok(UnlockService::assess_tiga_unlock_policy(&conn, mode)?.into())
    }

    pub fn list_security_audit_events(
        &self,
        limit: u32,
    ) -> Result<Vec<MdbxSecurityAuditEvent>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(
            TigaService::list_security_audit_events(&conn, limit as usize)?
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }

    pub fn list_security_audit_events_v2(
        &self,
        limit: u32,
    ) -> Result<Vec<MdbxSecurityAuditEventV2>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(
            TigaService::list_security_audit_events(&conn, limit as usize)?
                .into_iter()
                .map(Into::into)
                .collect(),
        )
    }

    pub fn set_tiga_profile(
        &self,
        mode: MdbxTigaMode,
        weakening_reason: Option<String>,
        exception_expires_at_unix_secs: Option<i64>,
        device: MdbxDeviceContext,
    ) -> Result<MdbxResolvedTigaPolicy, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let target_mode: TigaMode = mode.into();
        let current_mode = TigaService::get_global_default(&conn)?;
        let exception = if target_mode < current_mode {
            let reason = weakening_reason
                .filter(|reason| !reason.trim().is_empty())
                .ok_or_else(|| {
                    MdbxFfiError::from(StorageError::Validation(
                        "a non-empty reason is required when weakening the Tiga profile"
                            .to_string(),
                    ))
                })?;
            Some(PolicyException {
                exception_id: Uuid::new_v4().to_string(),
                target: TigaScope::Vault,
                approved_override: TigaPolicyOverride::for_vault_profile(target_mode),
                reason,
                expires_at_unix_secs: exception_expires_at_unix_secs,
            })
        } else {
            None
        };
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let now = unix_now();
        let ctx = CommitContext::new(self.device_id.clone());
        TigaService::set_vault_profile_authorized(
            &conn,
            &ctx,
            target_mode,
            exception.as_ref(),
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: now,
            },
        )?;
        Ok(TigaService::resolve_vault_policy(&conn)?.into())
    }

    pub fn setup_local_security_key_unlock(
        &self,
        key_material: Vec<u8>,
    ) -> Result<(), MdbxFfiError> {
        self.setup_local_security_key_unlock_with_device_context(
            key_material,
            conservative_ffi_device_context(),
        )
    }

    pub fn setup_local_security_key_unlock_with_device_context(
        &self,
        key_material: Vec<u8>,
        device: MdbxDeviceContext,
    ) -> Result<(), MdbxFfiError> {
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let key_material = Zeroizing::new(key_material);
        let session = conn.active_session().cloned().ok_or_else(|| {
            MdbxFfiError::from(StorageError::Validation(
                "adding a security key requires an active unlock session".to_string(),
            ))
        })?;
        let device = device.into_core(&self.device_id);
        UnlockService::setup_security_key_authorized(
            &mut conn,
            key_material.as_slice(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(())
    }

    pub fn setup_password_security_key_unlock(
        &self,
        password: String,
        key_material: Vec<u8>,
        device: MdbxDeviceContext,
    ) -> Result<(), MdbxFfiError> {
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let password = Zeroizing::new(password);
        let key_material = Zeroizing::new(key_material);
        let session = conn.active_session().cloned().ok_or_else(|| {
            MdbxFfiError::from(StorageError::Validation(
                "adding a combined unlock method requires an active unlock session".to_string(),
            ))
        })?;
        let mode = TigaService::get_global_default(&conn)?;
        let device = device.into_core(&self.device_id);
        UnlockService::setup_password_security_key_authorized(
            &mut conn,
            password.as_str(),
            key_material.as_slice(),
            mode,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(())
    }

    pub fn remove_unlock_method(
        &self,
        method_id: String,
        device: MdbxDeviceContext,
    ) -> Result<(), MdbxFfiError> {
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned().ok_or_else(|| {
            MdbxFfiError::from(StorageError::Validation(
                "removing an unlock method requires an active unlock session".to_string(),
            ))
        })?;
        let device = device.into_core(&self.device_id);
        UnlockService::remove_method_authorized(
            &mut conn,
            &method_id,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(())
    }

    pub fn reset_master_password(&self, new_password: String) -> Result<(), MdbxFfiError> {
        self.reset_master_password_with_tiga_mode(new_password, MdbxTigaMode::Multi)
    }

    pub fn reset_master_password_with_tiga_mode(
        &self,
        new_password: String,
        mode: MdbxTigaMode,
    ) -> Result<(), MdbxFfiError> {
        self.reset_master_password_with_tiga_mode_and_device_context(
            new_password,
            mode,
            conservative_ffi_device_context(),
        )
    }

    pub fn reset_master_password_with_tiga_mode_and_device_context(
        &self,
        new_password: String,
        mode: MdbxTigaMode,
        device: MdbxDeviceContext,
    ) -> Result<(), MdbxFfiError> {
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let new_password = Zeroizing::new(new_password);
        let session = conn.active_session().cloned().ok_or_else(|| {
            MdbxFfiError::from(StorageError::Validation(
                "resetting the password requires an active unlock session".to_string(),
            ))
        })?;
        let device = device.into_core(&self.device_id);
        UnlockService::reset_password_authorized(
            &mut conn,
            new_password.as_str(),
            mode.into(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(())
    }
}
