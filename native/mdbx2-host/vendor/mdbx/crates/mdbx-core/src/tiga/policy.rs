use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::TigaMode;
use crate::model::UnlockMethodType;

pub const TIGA_POLICY_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceAssurance {
    Unknown,
    Standard,
    TrustedHardware,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuditLevel {
    SecurityChanges,
    SensitiveOperations,
    AllDecisions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnlockPolicyV2 {
    pub portable_unlock_allowed: bool,
    pub minimum_auth_factors: u8,
    pub security_key_required: bool,
    pub security_key_recommended: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPolicy {
    pub idle_timeout_secs: u32,
    pub max_lifetime_secs: u32,
    pub lock_on_background: bool,
    pub fresh_auth_window_secs: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisclosurePolicy {
    pub reveal_requires_fresh_auth: bool,
    pub clipboard_allowed: bool,
    pub clipboard_ttl_secs: u32,
    pub copy_requires_fresh_auth: bool,
    pub secure_clipboard_required: bool,
    pub screen_capture_protection_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressPolicy {
    pub export_allowed: bool,
    pub print_allowed: bool,
    pub requires_fresh_auth: bool,
    pub minimum_auth_factors: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataHandlingPolicy {
    pub persistent_plaintext_cache_allowed: bool,
    pub attachment_temp_files_allowed: bool,
    pub locked_ciphertext_sync_allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryPolicy {
    pub minimum_recovery_methods: u8,
    pub portable_recovery_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdministrationPolicy {
    pub requires_fresh_auth: bool,
    pub minimum_auth_factors: u8,
    pub audit_deletion_allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TigaPolicy {
    pub policy_version: u32,
    pub profile: TigaMode,
    pub unlock: UnlockPolicyV2,
    pub session: SessionPolicy,
    pub disclosure: DisclosurePolicy,
    pub egress: EgressPolicy,
    pub data_handling: DataHandlingPolicy,
    pub recovery: RecoveryPolicy,
    pub administration: AdministrationPolicy,
    pub minimum_device_assurance: DeviceAssurance,
    pub audit_level: AuditLevel,
}

impl TigaMode {
    pub fn policy(self) -> TigaPolicy {
        match self {
            Self::Sky => TigaPolicy {
                policy_version: TIGA_POLICY_VERSION,
                profile: self,
                unlock: UnlockPolicyV2 {
                    portable_unlock_allowed: true,
                    minimum_auth_factors: 1,
                    security_key_required: false,
                    security_key_recommended: false,
                },
                session: SessionPolicy {
                    idle_timeout_secs: 30 * 60,
                    max_lifetime_secs: 12 * 60 * 60,
                    lock_on_background: false,
                    fresh_auth_window_secs: 15 * 60,
                },
                disclosure: DisclosurePolicy {
                    reveal_requires_fresh_auth: false,
                    clipboard_allowed: true,
                    clipboard_ttl_secs: 60,
                    copy_requires_fresh_auth: false,
                    secure_clipboard_required: false,
                    screen_capture_protection_required: false,
                },
                egress: EgressPolicy {
                    export_allowed: true,
                    print_allowed: true,
                    requires_fresh_auth: true,
                    minimum_auth_factors: 1,
                },
                data_handling: DataHandlingPolicy {
                    persistent_plaintext_cache_allowed: false,
                    attachment_temp_files_allowed: true,
                    locked_ciphertext_sync_allowed: true,
                },
                recovery: RecoveryPolicy {
                    minimum_recovery_methods: 1,
                    portable_recovery_required: true,
                },
                administration: AdministrationPolicy {
                    requires_fresh_auth: true,
                    minimum_auth_factors: 1,
                    audit_deletion_allowed: true,
                },
                minimum_device_assurance: DeviceAssurance::Unknown,
                audit_level: AuditLevel::SecurityChanges,
            },
            Self::Multi => TigaPolicy {
                policy_version: TIGA_POLICY_VERSION,
                profile: self,
                unlock: UnlockPolicyV2 {
                    portable_unlock_allowed: true,
                    minimum_auth_factors: 1,
                    security_key_required: false,
                    security_key_recommended: true,
                },
                session: SessionPolicy {
                    idle_timeout_secs: 10 * 60,
                    max_lifetime_secs: 2 * 60 * 60,
                    lock_on_background: true,
                    fresh_auth_window_secs: 5 * 60,
                },
                disclosure: DisclosurePolicy {
                    reveal_requires_fresh_auth: true,
                    clipboard_allowed: true,
                    clipboard_ttl_secs: 30,
                    copy_requires_fresh_auth: true,
                    secure_clipboard_required: false,
                    screen_capture_protection_required: false,
                },
                egress: EgressPolicy {
                    export_allowed: true,
                    print_allowed: true,
                    requires_fresh_auth: true,
                    minimum_auth_factors: 1,
                },
                data_handling: DataHandlingPolicy {
                    persistent_plaintext_cache_allowed: false,
                    attachment_temp_files_allowed: false,
                    locked_ciphertext_sync_allowed: true,
                },
                recovery: RecoveryPolicy {
                    minimum_recovery_methods: 1,
                    portable_recovery_required: true,
                },
                administration: AdministrationPolicy {
                    requires_fresh_auth: true,
                    minimum_auth_factors: 1,
                    audit_deletion_allowed: true,
                },
                minimum_device_assurance: DeviceAssurance::Standard,
                audit_level: AuditLevel::SensitiveOperations,
            },
            Self::Power => TigaPolicy {
                policy_version: TIGA_POLICY_VERSION,
                profile: self,
                unlock: UnlockPolicyV2 {
                    portable_unlock_allowed: false,
                    minimum_auth_factors: 2,
                    security_key_required: true,
                    security_key_recommended: true,
                },
                session: SessionPolicy {
                    idle_timeout_secs: 2 * 60,
                    max_lifetime_secs: 15 * 60,
                    lock_on_background: true,
                    fresh_auth_window_secs: 60,
                },
                disclosure: DisclosurePolicy {
                    reveal_requires_fresh_auth: true,
                    clipboard_allowed: true,
                    clipboard_ttl_secs: 10,
                    copy_requires_fresh_auth: true,
                    secure_clipboard_required: true,
                    screen_capture_protection_required: true,
                },
                egress: EgressPolicy {
                    export_allowed: false,
                    print_allowed: false,
                    requires_fresh_auth: true,
                    minimum_auth_factors: 2,
                },
                data_handling: DataHandlingPolicy {
                    persistent_plaintext_cache_allowed: false,
                    attachment_temp_files_allowed: false,
                    locked_ciphertext_sync_allowed: true,
                },
                recovery: RecoveryPolicy {
                    minimum_recovery_methods: 2,
                    portable_recovery_required: false,
                },
                administration: AdministrationPolicy {
                    requires_fresh_auth: true,
                    minimum_auth_factors: 2,
                    audit_deletion_allowed: false,
                },
                minimum_device_assurance: DeviceAssurance::TrustedHardware,
                audit_level: AuditLevel::AllDecisions,
            },
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TigaPolicyOverride {
    pub profile: Option<TigaMode>,
    pub portable_unlock_allowed: Option<bool>,
    pub minimum_auth_factors: Option<u8>,
    pub security_key_required: Option<bool>,
    pub idle_timeout_secs: Option<u32>,
    pub max_lifetime_secs: Option<u32>,
    pub lock_on_background: Option<bool>,
    pub fresh_auth_window_secs: Option<u32>,
    pub reveal_requires_fresh_auth: Option<bool>,
    pub clipboard_allowed: Option<bool>,
    pub clipboard_ttl_secs: Option<u32>,
    pub copy_requires_fresh_auth: Option<bool>,
    pub secure_clipboard_required: Option<bool>,
    pub screen_capture_protection_required: Option<bool>,
    pub export_allowed: Option<bool>,
    pub print_allowed: Option<bool>,
    pub egress_requires_fresh_auth: Option<bool>,
    pub egress_minimum_auth_factors: Option<u8>,
    pub persistent_plaintext_cache_allowed: Option<bool>,
    pub attachment_temp_files_allowed: Option<bool>,
    pub locked_ciphertext_sync_allowed: Option<bool>,
    pub minimum_recovery_methods: Option<u8>,
    pub portable_recovery_required: Option<bool>,
    pub administration_requires_fresh_auth: Option<bool>,
    pub administration_minimum_auth_factors: Option<u8>,
    pub audit_deletion_allowed: Option<bool>,
    pub minimum_device_assurance: Option<DeviceAssurance>,
    pub audit_level: Option<AuditLevel>,
}

impl TigaPolicyOverride {
    pub fn for_vault_profile(mode: TigaMode) -> Self {
        let policy = mode.policy();
        Self {
            profile: Some(mode),
            portable_unlock_allowed: Some(policy.unlock.portable_unlock_allowed),
            minimum_auth_factors: Some(policy.unlock.minimum_auth_factors),
            security_key_required: Some(policy.unlock.security_key_required),
            idle_timeout_secs: Some(policy.session.idle_timeout_secs),
            max_lifetime_secs: Some(policy.session.max_lifetime_secs),
            lock_on_background: Some(policy.session.lock_on_background),
            fresh_auth_window_secs: Some(policy.session.fresh_auth_window_secs),
            reveal_requires_fresh_auth: Some(policy.disclosure.reveal_requires_fresh_auth),
            clipboard_allowed: Some(policy.disclosure.clipboard_allowed),
            clipboard_ttl_secs: Some(policy.disclosure.clipboard_ttl_secs),
            copy_requires_fresh_auth: Some(policy.disclosure.copy_requires_fresh_auth),
            secure_clipboard_required: Some(policy.disclosure.secure_clipboard_required),
            screen_capture_protection_required: Some(
                policy.disclosure.screen_capture_protection_required,
            ),
            export_allowed: Some(policy.egress.export_allowed),
            print_allowed: Some(policy.egress.print_allowed),
            egress_requires_fresh_auth: Some(policy.egress.requires_fresh_auth),
            egress_minimum_auth_factors: Some(policy.egress.minimum_auth_factors),
            persistent_plaintext_cache_allowed: Some(
                policy.data_handling.persistent_plaintext_cache_allowed,
            ),
            attachment_temp_files_allowed: Some(policy.data_handling.attachment_temp_files_allowed),
            locked_ciphertext_sync_allowed: Some(
                policy.data_handling.locked_ciphertext_sync_allowed,
            ),
            minimum_recovery_methods: Some(policy.recovery.minimum_recovery_methods),
            portable_recovery_required: Some(policy.recovery.portable_recovery_required),
            administration_requires_fresh_auth: Some(policy.administration.requires_fresh_auth),
            administration_minimum_auth_factors: Some(policy.administration.minimum_auth_factors),
            audit_deletion_allowed: Some(policy.administration.audit_deletion_allowed),
            minimum_device_assurance: Some(policy.minimum_device_assurance),
            audit_level: Some(policy.audit_level),
        }
    }

    /// Project and entry profiles affect access to that resource, not vault-wide
    /// unlock, recovery, administration, or locked-sync behavior.
    pub fn for_resource_profile(mode: TigaMode) -> Self {
        let policy = mode.policy();
        Self {
            profile: Some(mode),
            minimum_auth_factors: Some(policy.unlock.minimum_auth_factors),
            security_key_required: Some(policy.unlock.security_key_required),
            idle_timeout_secs: Some(policy.session.idle_timeout_secs),
            max_lifetime_secs: Some(policy.session.max_lifetime_secs),
            lock_on_background: Some(policy.session.lock_on_background),
            fresh_auth_window_secs: Some(policy.session.fresh_auth_window_secs),
            reveal_requires_fresh_auth: Some(policy.disclosure.reveal_requires_fresh_auth),
            clipboard_allowed: Some(policy.disclosure.clipboard_allowed),
            clipboard_ttl_secs: Some(policy.disclosure.clipboard_ttl_secs),
            copy_requires_fresh_auth: Some(policy.disclosure.copy_requires_fresh_auth),
            secure_clipboard_required: Some(policy.disclosure.secure_clipboard_required),
            screen_capture_protection_required: Some(
                policy.disclosure.screen_capture_protection_required,
            ),
            export_allowed: Some(policy.egress.export_allowed),
            print_allowed: Some(policy.egress.print_allowed),
            egress_requires_fresh_auth: Some(policy.egress.requires_fresh_auth),
            egress_minimum_auth_factors: Some(policy.egress.minimum_auth_factors),
            persistent_plaintext_cache_allowed: Some(
                policy.data_handling.persistent_plaintext_cache_allowed,
            ),
            attachment_temp_files_allowed: Some(policy.data_handling.attachment_temp_files_allowed),
            minimum_device_assurance: Some(policy.minimum_device_assurance),
            audit_level: Some(policy.audit_level),
            ..Default::default()
        }
    }

    /// Merge concurrent sparse overrides without silently weakening either
    /// side. Allowances use intersection; requirements use union; time windows
    /// use the shorter value; minimum assurance values use the higher value.
    pub fn merge_stricter(&self, other: &Self) -> Self {
        Self {
            profile: merge_option(self.profile, other.profile, std::cmp::max),
            portable_unlock_allowed: merge_option(
                self.portable_unlock_allowed,
                other.portable_unlock_allowed,
                |a, b| a && b,
            ),
            minimum_auth_factors: merge_option(
                self.minimum_auth_factors,
                other.minimum_auth_factors,
                std::cmp::max,
            ),
            security_key_required: merge_option(
                self.security_key_required,
                other.security_key_required,
                |a, b| a || b,
            ),
            idle_timeout_secs: merge_option(
                self.idle_timeout_secs,
                other.idle_timeout_secs,
                std::cmp::min,
            ),
            max_lifetime_secs: merge_option(
                self.max_lifetime_secs,
                other.max_lifetime_secs,
                std::cmp::min,
            ),
            lock_on_background: merge_option(
                self.lock_on_background,
                other.lock_on_background,
                |a, b| a || b,
            ),
            fresh_auth_window_secs: merge_option(
                self.fresh_auth_window_secs,
                other.fresh_auth_window_secs,
                std::cmp::min,
            ),
            reveal_requires_fresh_auth: merge_option(
                self.reveal_requires_fresh_auth,
                other.reveal_requires_fresh_auth,
                |a, b| a || b,
            ),
            clipboard_allowed: merge_option(
                self.clipboard_allowed,
                other.clipboard_allowed,
                |a, b| a && b,
            ),
            clipboard_ttl_secs: merge_option(
                self.clipboard_ttl_secs,
                other.clipboard_ttl_secs,
                std::cmp::min,
            ),
            copy_requires_fresh_auth: merge_option(
                self.copy_requires_fresh_auth,
                other.copy_requires_fresh_auth,
                |a, b| a || b,
            ),
            secure_clipboard_required: merge_option(
                self.secure_clipboard_required,
                other.secure_clipboard_required,
                |a, b| a || b,
            ),
            screen_capture_protection_required: merge_option(
                self.screen_capture_protection_required,
                other.screen_capture_protection_required,
                |a, b| a || b,
            ),
            export_allowed: merge_option(self.export_allowed, other.export_allowed, |a, b| a && b),
            print_allowed: merge_option(self.print_allowed, other.print_allowed, |a, b| a && b),
            egress_requires_fresh_auth: merge_option(
                self.egress_requires_fresh_auth,
                other.egress_requires_fresh_auth,
                |a, b| a || b,
            ),
            egress_minimum_auth_factors: merge_option(
                self.egress_minimum_auth_factors,
                other.egress_minimum_auth_factors,
                std::cmp::max,
            ),
            persistent_plaintext_cache_allowed: merge_option(
                self.persistent_plaintext_cache_allowed,
                other.persistent_plaintext_cache_allowed,
                |a, b| a && b,
            ),
            attachment_temp_files_allowed: merge_option(
                self.attachment_temp_files_allowed,
                other.attachment_temp_files_allowed,
                |a, b| a && b,
            ),
            locked_ciphertext_sync_allowed: merge_option(
                self.locked_ciphertext_sync_allowed,
                other.locked_ciphertext_sync_allowed,
                |a, b| a && b,
            ),
            minimum_recovery_methods: merge_option(
                self.minimum_recovery_methods,
                other.minimum_recovery_methods,
                std::cmp::max,
            ),
            portable_recovery_required: merge_option(
                self.portable_recovery_required,
                other.portable_recovery_required,
                |a, b| a || b,
            ),
            administration_requires_fresh_auth: merge_option(
                self.administration_requires_fresh_auth,
                other.administration_requires_fresh_auth,
                |a, b| a || b,
            ),
            administration_minimum_auth_factors: merge_option(
                self.administration_minimum_auth_factors,
                other.administration_minimum_auth_factors,
                std::cmp::max,
            ),
            audit_deletion_allowed: merge_option(
                self.audit_deletion_allowed,
                other.audit_deletion_allowed,
                |a, b| a && b,
            ),
            minimum_device_assurance: merge_option(
                self.minimum_device_assurance,
                other.minimum_device_assurance,
                std::cmp::max,
            ),
            audit_level: merge_option(self.audit_level, other.audit_level, std::cmp::max),
        }
    }
}

fn merge_option<T: Copy>(a: Option<T>, b: Option<T>, merge: impl FnOnce(T, T) -> T) -> Option<T> {
    match (a, b) {
        (Some(a), Some(b)) => Some(merge(a, b)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scope", rename_all = "kebab-case")]
pub enum TigaScope {
    Vault,
    Project { project_id: String },
    Entry { entry_id: String },
    Attachment { attachment_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyException {
    pub exception_id: String,
    pub target: TigaScope,
    pub approved_override: TigaPolicyOverride,
    pub reason: String,
    pub expires_at_unix_secs: Option<i64>,
}

impl PolicyException {
    pub fn is_valid_for(
        &self,
        scope: &TigaScope,
        policy_override: &TigaPolicyOverride,
        now_unix_secs: i64,
    ) -> bool {
        self.target == *scope
            && self.approved_override == *policy_override
            && !self.reason.trim().is_empty()
            && self
                .expires_at_unix_secs
                .map(|expires| now_unix_secs < expires)
                .unwrap_or(true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyCompliance {
    Compliant,
    Exception,
    RemediationRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedTigaPolicy {
    pub policy: TigaPolicy,
    pub compliance: PolicyCompliance,
    pub exception_id: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PolicyResolutionError {
    #[error("invalid Tiga policy override: {0}")]
    InvalidOverride(String),
    #[error("Tiga policy override weakens parent fields: {fields:?}")]
    WeakeningNotAuthorized { fields: Vec<String> },
    #[error("the supplied policy exception is invalid, expired, or targets another override")]
    InvalidException,
}

pub struct TigaPolicyResolver;

impl TigaPolicyResolver {
    pub fn resolve(
        parent: &TigaPolicy,
        scope: TigaScope,
        policy_override: &TigaPolicyOverride,
        exception: Option<&PolicyException>,
        now_unix_secs: i64,
    ) -> Result<ResolvedTigaPolicy, PolicyResolutionError> {
        let candidate = apply_override(parent, policy_override)?;
        let weakened_fields = weakened_fields(parent, &candidate);
        if weakened_fields.is_empty() {
            return Ok(ResolvedTigaPolicy {
                policy: candidate,
                compliance: PolicyCompliance::Compliant,
                exception_id: None,
                warnings: Vec::new(),
            });
        }

        let Some(exception) = exception else {
            return Err(PolicyResolutionError::WeakeningNotAuthorized {
                fields: weakened_fields,
            });
        };
        if !exception.is_valid_for(&scope, policy_override, now_unix_secs) {
            return Err(PolicyResolutionError::InvalidException);
        }

        Ok(ResolvedTigaPolicy {
            policy: candidate,
            compliance: PolicyCompliance::Exception,
            exception_id: Some(exception.exception_id.clone()),
            warnings: vec![format!(
                "policy exception {} weakens: {}",
                exception.exception_id,
                weakened_fields.join(", ")
            )],
        })
    }

    pub fn resolve_legacy(
        parent: &TigaPolicy,
        policy_override: &TigaPolicyOverride,
    ) -> Result<ResolvedTigaPolicy, PolicyResolutionError> {
        let candidate = apply_override(parent, policy_override)?;
        let weakened = weakened_fields(parent, &candidate);
        let needs_remediation = !weakened.is_empty();
        Ok(ResolvedTigaPolicy {
            policy: candidate,
            compliance: if needs_remediation {
                PolicyCompliance::RemediationRequired
            } else {
                PolicyCompliance::Compliant
            },
            exception_id: None,
            warnings: if needs_remediation {
                vec![format!(
                    "legacy policy weakens: {}; create an explicit exception or strengthen it",
                    weakened.join(", ")
                )]
            } else {
                Vec::new()
            },
        })
    }
}

fn apply_override(
    parent: &TigaPolicy,
    policy_override: &TigaPolicyOverride,
) -> Result<TigaPolicy, PolicyResolutionError> {
    let mut policy = parent.clone();
    macro_rules! set {
        ($target:expr, $value:expr) => {
            if let Some(value) = $value {
                $target = value;
            }
        };
    }

    set!(policy.profile, policy_override.profile);
    set!(
        policy.unlock.portable_unlock_allowed,
        policy_override.portable_unlock_allowed
    );
    set!(
        policy.unlock.minimum_auth_factors,
        policy_override.minimum_auth_factors
    );
    set!(
        policy.unlock.security_key_required,
        policy_override.security_key_required
    );
    set!(
        policy.session.idle_timeout_secs,
        policy_override.idle_timeout_secs
    );
    set!(
        policy.session.max_lifetime_secs,
        policy_override.max_lifetime_secs
    );
    set!(
        policy.session.lock_on_background,
        policy_override.lock_on_background
    );
    set!(
        policy.session.fresh_auth_window_secs,
        policy_override.fresh_auth_window_secs
    );
    set!(
        policy.disclosure.reveal_requires_fresh_auth,
        policy_override.reveal_requires_fresh_auth
    );
    set!(
        policy.disclosure.clipboard_allowed,
        policy_override.clipboard_allowed
    );
    set!(
        policy.disclosure.clipboard_ttl_secs,
        policy_override.clipboard_ttl_secs
    );
    set!(
        policy.disclosure.copy_requires_fresh_auth,
        policy_override.copy_requires_fresh_auth
    );
    set!(
        policy.disclosure.secure_clipboard_required,
        policy_override.secure_clipboard_required
    );
    set!(
        policy.disclosure.screen_capture_protection_required,
        policy_override.screen_capture_protection_required
    );
    set!(policy.egress.export_allowed, policy_override.export_allowed);
    set!(policy.egress.print_allowed, policy_override.print_allowed);
    set!(
        policy.egress.requires_fresh_auth,
        policy_override.egress_requires_fresh_auth
    );
    set!(
        policy.egress.minimum_auth_factors,
        policy_override.egress_minimum_auth_factors
    );
    set!(
        policy.data_handling.persistent_plaintext_cache_allowed,
        policy_override.persistent_plaintext_cache_allowed
    );
    set!(
        policy.data_handling.attachment_temp_files_allowed,
        policy_override.attachment_temp_files_allowed
    );
    set!(
        policy.data_handling.locked_ciphertext_sync_allowed,
        policy_override.locked_ciphertext_sync_allowed
    );
    set!(
        policy.recovery.minimum_recovery_methods,
        policy_override.minimum_recovery_methods
    );
    set!(
        policy.recovery.portable_recovery_required,
        policy_override.portable_recovery_required
    );
    set!(
        policy.administration.requires_fresh_auth,
        policy_override.administration_requires_fresh_auth
    );
    set!(
        policy.administration.minimum_auth_factors,
        policy_override.administration_minimum_auth_factors
    );
    set!(
        policy.administration.audit_deletion_allowed,
        policy_override.audit_deletion_allowed
    );
    set!(
        policy.minimum_device_assurance,
        policy_override.minimum_device_assurance
    );
    set!(policy.audit_level, policy_override.audit_level);

    if policy.unlock.minimum_auth_factors == 0
        || policy.egress.minimum_auth_factors == 0
        || policy.administration.minimum_auth_factors == 0
    {
        return Err(PolicyResolutionError::InvalidOverride(
            "minimum authentication factors must be at least one".to_string(),
        ));
    }
    if policy.session.idle_timeout_secs == 0
        || policy.session.max_lifetime_secs == 0
        || policy.session.idle_timeout_secs > policy.session.max_lifetime_secs
    {
        return Err(PolicyResolutionError::InvalidOverride(
            "session timeouts must be non-zero and idle timeout cannot exceed lifetime".to_string(),
        ));
    }
    if policy.disclosure.clipboard_allowed && policy.disclosure.clipboard_ttl_secs == 0 {
        return Err(PolicyResolutionError::InvalidOverride(
            "enabled clipboard requires a non-zero clear timeout".to_string(),
        ));
    }
    if policy.recovery.minimum_recovery_methods == 0 {
        return Err(PolicyResolutionError::InvalidOverride(
            "at least one recovery method is required".to_string(),
        ));
    }
    Ok(policy)
}

fn weakened_fields(parent: &TigaPolicy, candidate: &TigaPolicy) -> Vec<String> {
    let mut fields = Vec::new();
    macro_rules! weaker_if {
        ($condition:expr, $name:literal) => {
            if $condition {
                fields.push($name.to_string());
            }
        };
    }

    weaker_if!(
        candidate.unlock.portable_unlock_allowed && !parent.unlock.portable_unlock_allowed,
        "portable_unlock_allowed"
    );
    weaker_if!(
        candidate.unlock.minimum_auth_factors < parent.unlock.minimum_auth_factors,
        "minimum_auth_factors"
    );
    weaker_if!(
        !candidate.unlock.security_key_required && parent.unlock.security_key_required,
        "security_key_required"
    );
    weaker_if!(
        candidate.session.idle_timeout_secs > parent.session.idle_timeout_secs,
        "idle_timeout_secs"
    );
    weaker_if!(
        candidate.session.max_lifetime_secs > parent.session.max_lifetime_secs,
        "max_lifetime_secs"
    );
    weaker_if!(
        !candidate.session.lock_on_background && parent.session.lock_on_background,
        "lock_on_background"
    );
    weaker_if!(
        candidate.session.fresh_auth_window_secs > parent.session.fresh_auth_window_secs,
        "fresh_auth_window_secs"
    );
    weaker_if!(
        !candidate.disclosure.reveal_requires_fresh_auth
            && parent.disclosure.reveal_requires_fresh_auth,
        "reveal_requires_fresh_auth"
    );
    weaker_if!(
        candidate.disclosure.clipboard_allowed && !parent.disclosure.clipboard_allowed,
        "clipboard_allowed"
    );
    weaker_if!(
        candidate.disclosure.clipboard_allowed
            && candidate.disclosure.clipboard_ttl_secs > parent.disclosure.clipboard_ttl_secs,
        "clipboard_ttl_secs"
    );
    weaker_if!(
        !candidate.disclosure.copy_requires_fresh_auth
            && parent.disclosure.copy_requires_fresh_auth,
        "copy_requires_fresh_auth"
    );
    weaker_if!(
        !candidate.disclosure.secure_clipboard_required
            && parent.disclosure.secure_clipboard_required,
        "secure_clipboard_required"
    );
    weaker_if!(
        !candidate.disclosure.screen_capture_protection_required
            && parent.disclosure.screen_capture_protection_required,
        "screen_capture_protection_required"
    );
    weaker_if!(
        candidate.egress.export_allowed && !parent.egress.export_allowed,
        "export_allowed"
    );
    weaker_if!(
        candidate.egress.print_allowed && !parent.egress.print_allowed,
        "print_allowed"
    );
    weaker_if!(
        !candidate.egress.requires_fresh_auth && parent.egress.requires_fresh_auth,
        "egress_requires_fresh_auth"
    );
    weaker_if!(
        candidate.egress.minimum_auth_factors < parent.egress.minimum_auth_factors,
        "egress_minimum_auth_factors"
    );
    weaker_if!(
        candidate.data_handling.persistent_plaintext_cache_allowed
            && !parent.data_handling.persistent_plaintext_cache_allowed,
        "persistent_plaintext_cache_allowed"
    );
    weaker_if!(
        candidate.data_handling.attachment_temp_files_allowed
            && !parent.data_handling.attachment_temp_files_allowed,
        "attachment_temp_files_allowed"
    );
    weaker_if!(
        candidate.data_handling.locked_ciphertext_sync_allowed
            && !parent.data_handling.locked_ciphertext_sync_allowed,
        "locked_ciphertext_sync_allowed"
    );
    weaker_if!(
        candidate.recovery.minimum_recovery_methods < parent.recovery.minimum_recovery_methods,
        "minimum_recovery_methods"
    );
    weaker_if!(
        !candidate.administration.requires_fresh_auth && parent.administration.requires_fresh_auth,
        "administration_requires_fresh_auth"
    );
    weaker_if!(
        candidate.administration.minimum_auth_factors < parent.administration.minimum_auth_factors,
        "administration_minimum_auth_factors"
    );
    weaker_if!(
        candidate.administration.audit_deletion_allowed
            && !parent.administration.audit_deletion_allowed,
        "audit_deletion_allowed"
    );
    weaker_if!(
        candidate.minimum_device_assurance < parent.minimum_device_assurance,
        "minimum_device_assurance"
    );
    weaker_if!(candidate.audit_level < parent.audit_level, "audit_level");
    fields
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthenticationFactor {
    Pin,
    Password,
    SecurityKey,
    PlatformCredential,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionAssurance {
    pub authenticated_at_unix_secs: i64,
    pub last_activity_at_unix_secs: i64,
    pub factors: Vec<AuthenticationFactor>,
}

impl SessionAssurance {
    pub fn from_unlock_method(method: UnlockMethodType, now_unix_secs: i64) -> Self {
        let factors = match method {
            UnlockMethodType::Pin => vec![AuthenticationFactor::Pin],
            UnlockMethodType::Password => vec![AuthenticationFactor::Password],
            UnlockMethodType::SecurityKey => vec![AuthenticationFactor::SecurityKey],
            UnlockMethodType::PasswordSecurityKey => vec![
                AuthenticationFactor::Password,
                AuthenticationFactor::SecurityKey,
            ],
        };
        Self {
            authenticated_at_unix_secs: now_unix_secs,
            last_activity_at_unix_secs: now_unix_secs,
            factors,
        }
    }

    pub fn factor_count(&self) -> u8 {
        self.factors
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>()
            .len()
            .min(u8::MAX as usize) as u8
    }

    pub fn has_security_key(&self) -> bool {
        self.factors.contains(&AuthenticationFactor::SecurityKey)
    }

    pub fn is_expired(&self, policy: &SessionPolicy, now_unix_secs: i64) -> bool {
        if now_unix_secs < self.authenticated_at_unix_secs
            || now_unix_secs < self.last_activity_at_unix_secs
        {
            return true;
        }
        now_unix_secs - self.authenticated_at_unix_secs >= i64::from(policy.max_lifetime_secs)
            || now_unix_secs - self.last_activity_at_unix_secs
                >= i64::from(policy.idle_timeout_secs)
    }

    pub fn is_fresh(&self, window_secs: u32, now_unix_secs: i64) -> bool {
        now_unix_secs >= self.authenticated_at_unix_secs
            && now_unix_secs - self.authenticated_at_unix_secs <= i64::from(window_secs)
    }

    pub fn touched(&self, now_unix_secs: i64) -> Self {
        let mut updated = self.clone();
        updated.last_activity_at_unix_secs = now_unix_secs;
        updated
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceContext {
    pub device_id: Option<String>,
    pub assurance: DeviceAssurance,
    pub secure_clipboard_available: bool,
    pub screen_capture_protection_available: bool,
    pub secure_temp_files_available: bool,
}

impl Default for DeviceContext {
    fn default() -> Self {
        Self {
            device_id: None,
            assurance: DeviceAssurance::Unknown,
            secure_clipboard_available: false,
            screen_capture_protection_available: false,
            secure_temp_files_available: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TigaOperation {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthorizationOutcome {
    Allow,
    AllowWithConstraints,
    RequireFreshAuthentication,
    RequireAdditionalFactor,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthorizationReason {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthorizationConstraint {
    ClearClipboardAfterSeconds(u32),
    ExcludeClipboardHistory,
    PreventScreenCapture,
    NoPlaintextPersistence,
    UseSecureTemporaryFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationDecision {
    pub outcome: AuthorizationOutcome,
    pub reasons: Vec<AuthorizationReason>,
    pub constraints: Vec<AuthorizationConstraint>,
    pub audit_required: bool,
}

pub struct AuthorizationContext<'a> {
    pub session: Option<&'a SessionAssurance>,
    pub device: &'a DeviceContext,
    pub now_unix_secs: i64,
}

impl TigaPolicy {
    pub fn authorize(
        &self,
        operation: TigaOperation,
        context: AuthorizationContext<'_>,
    ) -> AuthorizationDecision {
        let audit_required = self.audit_required(operation);
        if operation == TigaOperation::SyncCiphertext {
            return self.finish_decision(
                if self.data_handling.locked_ciphertext_sync_allowed {
                    Vec::new()
                } else {
                    vec![AuthorizationReason::OperationDisabled]
                },
                Vec::new(),
                false,
                false,
                audit_required,
            );
        }

        if operation == TigaOperation::BackgroundAccess && self.session.lock_on_background {
            return AuthorizationDecision {
                outcome: AuthorizationOutcome::Deny,
                reasons: vec![AuthorizationReason::OperationDisabled],
                constraints: Vec::new(),
                audit_required,
            };
        }

        let Some(session) = context.session else {
            return AuthorizationDecision {
                outcome: AuthorizationOutcome::RequireFreshAuthentication,
                reasons: vec![AuthorizationReason::SessionMissing],
                constraints: Vec::new(),
                audit_required,
            };
        };
        if session.is_expired(&self.session, context.now_unix_secs) {
            return AuthorizationDecision {
                outcome: AuthorizationOutcome::RequireFreshAuthentication,
                reasons: vec![AuthorizationReason::SessionExpired],
                constraints: Vec::new(),
                audit_required,
            };
        }

        let mut reasons = Vec::new();
        let mut constraints = Vec::new();
        let mut needs_fresh_auth = false;
        let mut needs_additional_factor = false;

        if context.device.assurance < self.minimum_device_assurance {
            reasons.push(AuthorizationReason::DeviceAssuranceInsufficient);
        }
        if session.factor_count() < self.unlock.minimum_auth_factors {
            needs_additional_factor = true;
            reasons.push(AuthorizationReason::InsufficientAuthenticationFactors);
        }
        if self.unlock.security_key_required && !session.has_security_key() {
            needs_additional_factor = true;
            reasons.push(AuthorizationReason::SecurityKeyRequired);
        }

        match operation {
            TigaOperation::RevealSecret => {
                if self.disclosure.screen_capture_protection_required {
                    if context.device.screen_capture_protection_available {
                        constraints.push(AuthorizationConstraint::PreventScreenCapture);
                    } else {
                        reasons.push(AuthorizationReason::ScreenCaptureProtectionUnavailable);
                    }
                }
                needs_fresh_auth |= self.disclosure.reveal_requires_fresh_auth;
            }
            TigaOperation::CopySecret => {
                if !self.disclosure.clipboard_allowed {
                    reasons.push(AuthorizationReason::OperationDisabled);
                } else {
                    constraints.push(AuthorizationConstraint::ClearClipboardAfterSeconds(
                        self.disclosure.clipboard_ttl_secs,
                    ));
                }
                if self.disclosure.secure_clipboard_required {
                    if context.device.secure_clipboard_available {
                        constraints.push(AuthorizationConstraint::ExcludeClipboardHistory);
                    } else {
                        reasons.push(AuthorizationReason::SecureClipboardUnavailable);
                    }
                }
                needs_fresh_auth |= self.disclosure.copy_requires_fresh_auth;
            }
            TigaOperation::ExportData | TigaOperation::PrintData => {
                let enabled = match operation {
                    TigaOperation::ExportData => self.egress.export_allowed,
                    TigaOperation::PrintData => self.egress.print_allowed,
                    _ => unreachable!(),
                };
                if !enabled {
                    reasons.push(AuthorizationReason::OperationDisabled);
                }
                needs_fresh_auth |= self.egress.requires_fresh_auth;
                if session.factor_count() < self.egress.minimum_auth_factors {
                    needs_additional_factor = true;
                    reasons.push(AuthorizationReason::InsufficientAuthenticationFactors);
                }
            }
            TigaOperation::DecryptAttachment => {
                if self.data_handling.attachment_temp_files_allowed
                    && context.device.secure_temp_files_available
                {
                    constraints.push(AuthorizationConstraint::UseSecureTemporaryFiles);
                } else {
                    constraints.push(AuthorizationConstraint::NoPlaintextPersistence);
                }
            }
            TigaOperation::MigratePayload
            | TigaOperation::CreateSnapshot
            | TigaOperation::RestoreSnapshot
            | TigaOperation::ChangeUnlockMethods
            | TigaOperation::ChangeSecurityPolicy
            | TigaOperation::ChangeRecoveryMethods
            | TigaOperation::RotateKeyEpoch
            | TigaOperation::DeleteAuditRecords
            | TigaOperation::ManageDeletedObjectRetention
            | TigaOperation::ManageSnapshotRetention
            | TigaOperation::PurgeDeletedObject => {
                if operation == TigaOperation::DeleteAuditRecords
                    && !self.administration.audit_deletion_allowed
                {
                    reasons.push(AuthorizationReason::OperationDisabled);
                }
                needs_fresh_auth |= self.administration.requires_fresh_auth;
                if session.factor_count() < self.administration.minimum_auth_factors {
                    needs_additional_factor = true;
                    reasons.push(AuthorizationReason::InsufficientAuthenticationFactors);
                }
            }
            TigaOperation::CreatePlaintextCache => {
                if !self.data_handling.persistent_plaintext_cache_allowed {
                    reasons.push(AuthorizationReason::OperationDisabled);
                }
            }
            TigaOperation::BackgroundAccess | TigaOperation::SyncCiphertext => {}
        }

        if needs_fresh_auth
            && !session.is_fresh(self.session.fresh_auth_window_secs, context.now_unix_secs)
        {
            reasons.push(AuthorizationReason::AuthenticationStale);
        } else {
            needs_fresh_auth = false;
        }

        self.finish_decision(
            reasons,
            constraints,
            needs_fresh_auth,
            needs_additional_factor,
            audit_required,
        )
    }

    fn finish_decision(
        &self,
        reasons: Vec<AuthorizationReason>,
        constraints: Vec<AuthorizationConstraint>,
        needs_fresh_auth: bool,
        needs_additional_factor: bool,
        audit_required: bool,
    ) -> AuthorizationDecision {
        let has_denial_reason = reasons.iter().any(|reason| {
            matches!(
                reason,
                AuthorizationReason::DeviceAssuranceInsufficient
                    | AuthorizationReason::SecureClipboardUnavailable
                    | AuthorizationReason::ScreenCaptureProtectionUnavailable
                    | AuthorizationReason::OperationDisabled
                    | AuthorizationReason::PolicyWeakeningNotAuthorized
                    | AuthorizationReason::PolicyExceptionInvalid
            )
        });
        let outcome = if has_denial_reason {
            AuthorizationOutcome::Deny
        } else if needs_additional_factor {
            AuthorizationOutcome::RequireAdditionalFactor
        } else if needs_fresh_auth {
            AuthorizationOutcome::RequireFreshAuthentication
        } else if constraints.is_empty() {
            AuthorizationOutcome::Allow
        } else {
            AuthorizationOutcome::AllowWithConstraints
        };
        AuthorizationDecision {
            outcome,
            reasons,
            constraints,
            audit_required,
        }
    }

    fn audit_required(&self, operation: TigaOperation) -> bool {
        match self.audit_level {
            AuditLevel::AllDecisions => true,
            AuditLevel::SensitiveOperations => !matches!(
                operation,
                TigaOperation::BackgroundAccess | TigaOperation::SyncCiphertext
            ),
            AuditLevel::SecurityChanges => matches!(
                operation,
                TigaOperation::MigratePayload
                    | TigaOperation::CreateSnapshot
                    | TigaOperation::RestoreSnapshot
                    | TigaOperation::ChangeUnlockMethods
                    | TigaOperation::ChangeSecurityPolicy
                    | TigaOperation::ChangeRecoveryMethods
                    | TigaOperation::RotateKeyEpoch
                    | TigaOperation::DeleteAuditRecords
                    | TigaOperation::ManageDeletedObjectRetention
                    | TigaOperation::ManageSnapshotRetention
                    | TigaOperation::PurgeDeletedObject
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(method: UnlockMethodType, now: i64) -> SessionAssurance {
        SessionAssurance::from_unlock_method(method, now)
    }

    fn trusted_device() -> DeviceContext {
        DeviceContext {
            device_id: Some("trusted-device".to_string()),
            assurance: DeviceAssurance::TrustedHardware,
            secure_clipboard_available: true,
            screen_capture_protection_available: true,
            secure_temp_files_available: true,
        }
    }

    #[test]
    fn profile_presets_cover_runtime_policy_not_only_kdf() {
        let sky = TigaMode::Sky.policy();
        let multi = TigaMode::Multi.policy();
        let power = TigaMode::Power.policy();
        assert_eq!(power.policy_version, TIGA_POLICY_VERSION);
        assert!(sky.session.idle_timeout_secs > multi.session.idle_timeout_secs);
        assert!(multi.session.idle_timeout_secs > power.session.idle_timeout_secs);
        assert!(sky.egress.export_allowed);
        assert!(!power.egress.export_allowed);
        assert_eq!(power.audit_level, AuditLevel::AllDecisions);
    }

    #[test]
    fn strict_override_is_applied() {
        let policy_override = TigaPolicyOverride {
            idle_timeout_secs: Some(60),
            clipboard_allowed: Some(false),
            ..Default::default()
        };
        let resolved = TigaPolicyResolver::resolve(
            &TigaMode::Multi.policy(),
            TigaScope::Vault,
            &policy_override,
            None,
            100,
        )
        .unwrap();
        assert_eq!(resolved.policy.session.idle_timeout_secs, 60);
        assert!(!resolved.policy.disclosure.clipboard_allowed);
        assert_eq!(resolved.compliance, PolicyCompliance::Compliant);
    }

    #[test]
    fn resource_profile_does_not_change_vault_recovery_or_unlock_portability() {
        let parent = TigaMode::Sky.policy();
        let resolved = TigaPolicyResolver::resolve(
            &parent,
            TigaScope::Project {
                project_id: "p1".to_string(),
            },
            &TigaPolicyOverride::for_resource_profile(TigaMode::Power),
            None,
            0,
        )
        .unwrap();
        assert_eq!(resolved.policy.profile, TigaMode::Power);
        assert!(resolved.policy.unlock.portable_unlock_allowed);
        assert_eq!(resolved.policy.recovery, parent.recovery);
        assert!(!resolved.policy.egress.export_allowed);
    }

    #[test]
    fn concurrent_override_merge_keeps_stricter_fields() {
        let local = TigaPolicyOverride {
            clipboard_allowed: Some(true),
            clipboard_ttl_secs: Some(30),
            minimum_auth_factors: Some(2),
            ..Default::default()
        };
        let incoming = TigaPolicyOverride {
            clipboard_allowed: Some(false),
            clipboard_ttl_secs: Some(10),
            minimum_auth_factors: Some(1),
            audit_level: Some(AuditLevel::AllDecisions),
            ..Default::default()
        };
        let merged = local.merge_stricter(&incoming);
        assert_eq!(merged.clipboard_allowed, Some(false));
        assert_eq!(merged.clipboard_ttl_secs, Some(10));
        assert_eq!(merged.minimum_auth_factors, Some(2));
        assert_eq!(merged.audit_level, Some(AuditLevel::AllDecisions));
    }

    #[test]
    fn weakening_requires_exact_active_exception() {
        let policy_override = TigaPolicyOverride {
            export_allowed: Some(true),
            ..Default::default()
        };
        let scope = TigaScope::Project {
            project_id: "p1".to_string(),
        };
        let err = TigaPolicyResolver::resolve(
            &TigaMode::Power.policy(),
            scope.clone(),
            &policy_override,
            None,
            100,
        )
        .unwrap_err();
        assert!(matches!(
            err,
            PolicyResolutionError::WeakeningNotAuthorized { .. }
        ));

        let exception = PolicyException {
            exception_id: "exception-1".to_string(),
            target: scope.clone(),
            approved_override: policy_override.clone(),
            reason: "controlled export workflow".to_string(),
            expires_at_unix_secs: Some(200),
        };
        let resolved = TigaPolicyResolver::resolve(
            &TigaMode::Power.policy(),
            scope,
            &policy_override,
            Some(&exception),
            100,
        )
        .unwrap();
        assert!(resolved.policy.egress.export_allowed);
        assert_eq!(resolved.compliance, PolicyCompliance::Exception);
        assert_eq!(resolved.exception_id.as_deref(), Some("exception-1"));
    }

    #[test]
    fn legacy_weakening_preserves_behavior_but_requires_remediation() {
        let resolved = TigaPolicyResolver::resolve_legacy(
            &TigaMode::Multi.policy(),
            &TigaPolicyOverride {
                idle_timeout_secs: Some(60 * 60),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(resolved.policy.session.idle_timeout_secs, 60 * 60);
        assert_eq!(resolved.compliance, PolicyCompliance::RemediationRequired);
        assert!(!resolved.warnings.is_empty());
    }

    #[test]
    fn invalid_session_timeout_override_is_rejected() {
        let err = TigaPolicyResolver::resolve(
            &TigaMode::Sky.policy(),
            TigaScope::Vault,
            &TigaPolicyOverride {
                idle_timeout_secs: Some(100),
                max_lifetime_secs: Some(50),
                ..Default::default()
            },
            None,
            0,
        )
        .unwrap_err();
        assert!(matches!(err, PolicyResolutionError::InvalidOverride(_)));
    }

    #[test]
    fn session_expiry_uses_idle_absolute_and_clock_rollback_checks() {
        let policy = TigaMode::Multi.policy();
        let assurance = session(UnlockMethodType::Password, 1_000);
        assert!(!assurance.is_expired(&policy.session, 1_100));
        assert!(assurance.is_expired(
            &policy.session,
            1_000 + i64::from(policy.session.idle_timeout_secs)
        ));
        assert!(assurance.is_expired(&policy.session, 999));
    }

    #[test]
    fn multi_copy_returns_client_constraints() {
        let policy = TigaMode::Multi.policy();
        let assurance = session(UnlockMethodType::Password, 1_000);
        let decision = policy.authorize(
            TigaOperation::CopySecret,
            AuthorizationContext {
                session: Some(&assurance),
                device: &DeviceContext {
                    assurance: DeviceAssurance::Standard,
                    ..Default::default()
                },
                now_unix_secs: 1_100,
            },
        );
        assert_eq!(decision.outcome, AuthorizationOutcome::AllowWithConstraints);
        assert!(decision
            .constraints
            .contains(&AuthorizationConstraint::ClearClipboardAfterSeconds(30)));
        assert!(decision.audit_required);
    }

    #[test]
    fn stale_multi_session_requires_fresh_auth_for_reveal() {
        let policy = TigaMode::Multi.policy();
        let mut assurance = session(UnlockMethodType::Password, 1_000);
        assurance.last_activity_at_unix_secs = 1_400;
        let decision = policy.authorize(
            TigaOperation::RevealSecret,
            AuthorizationContext {
                session: Some(&assurance),
                device: &DeviceContext {
                    assurance: DeviceAssurance::Standard,
                    ..Default::default()
                },
                now_unix_secs: 1_400,
            },
        );
        assert_eq!(
            decision.outcome,
            AuthorizationOutcome::RequireFreshAuthentication
        );
    }

    #[test]
    fn power_requires_combined_factor_and_platform_capabilities() {
        let policy = TigaMode::Power.policy();
        let single = session(UnlockMethodType::Password, 1_000);
        let denied = policy.authorize(
            TigaOperation::CopySecret,
            AuthorizationContext {
                session: Some(&single),
                device: &DeviceContext::default(),
                now_unix_secs: 1_010,
            },
        );
        assert_eq!(denied.outcome, AuthorizationOutcome::Deny);

        let combined = session(UnlockMethodType::PasswordSecurityKey, 1_000);
        let allowed = policy.authorize(
            TigaOperation::CopySecret,
            AuthorizationContext {
                session: Some(&combined),
                device: &trusted_device(),
                now_unix_secs: 1_010,
            },
        );
        assert_eq!(allowed.outcome, AuthorizationOutcome::AllowWithConstraints);
        assert!(allowed
            .constraints
            .contains(&AuthorizationConstraint::ExcludeClipboardHistory));
    }

    #[test]
    fn power_disables_export_even_for_strong_session() {
        let policy = TigaMode::Power.policy();
        let assurance = session(UnlockMethodType::PasswordSecurityKey, 1_000);
        let decision = policy.authorize(
            TigaOperation::ExportData,
            AuthorizationContext {
                session: Some(&assurance),
                device: &trusted_device(),
                now_unix_secs: 1_010,
            },
        );
        assert_eq!(decision.outcome, AuthorizationOutcome::Deny);
        assert!(decision
            .reasons
            .contains(&AuthorizationReason::OperationDisabled));
    }

    #[test]
    fn locked_ciphertext_sync_does_not_require_plaintext_session() {
        let decision = TigaMode::Power.policy().authorize(
            TigaOperation::SyncCiphertext,
            AuthorizationContext {
                session: None,
                device: &DeviceContext::default(),
                now_unix_secs: 0,
            },
        );
        assert_eq!(decision.outcome, AuthorizationOutcome::Allow);
        assert!(decision.audit_required);
    }

    #[test]
    fn snapshot_operations_use_administration_auth_and_security_audit() {
        let policy = TigaMode::Multi.policy();
        let missing = policy.authorize(
            TigaOperation::ManageSnapshotRetention,
            AuthorizationContext {
                session: None,
                device: &DeviceContext::default(),
                now_unix_secs: 100,
            },
        );
        assert_eq!(
            missing.outcome,
            AuthorizationOutcome::RequireFreshAuthentication
        );
        let session = session(UnlockMethodType::Password, 100);
        let created = policy.authorize(
            TigaOperation::CreateSnapshot,
            AuthorizationContext {
                session: Some(&session),
                device: &DeviceContext {
                    assurance: DeviceAssurance::Standard,
                    ..Default::default()
                },
                now_unix_secs: 101,
            },
        );
        assert!(matches!(
            created.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert!(created.audit_required);
    }

    #[test]
    fn migrate_payload_uses_fresh_administration_auth_and_power_factors() {
        let missing = TigaMode::Multi.policy().authorize(
            TigaOperation::MigratePayload,
            AuthorizationContext {
                session: None,
                device: &DeviceContext {
                    assurance: DeviceAssurance::Standard,
                    ..Default::default()
                },
                now_unix_secs: 100,
            },
        );
        assert_eq!(
            missing.outcome,
            AuthorizationOutcome::RequireFreshAuthentication
        );
        assert!(missing.audit_required);

        let multi = TigaMode::Multi.policy().authorize(
            TigaOperation::MigratePayload,
            AuthorizationContext {
                session: Some(&session(UnlockMethodType::Password, 100)),
                device: &DeviceContext {
                    assurance: DeviceAssurance::Standard,
                    ..Default::default()
                },
                now_unix_secs: 101,
            },
        );
        assert_eq!(multi.outcome, AuthorizationOutcome::Allow);
        assert!(multi.audit_required);

        let power_single = TigaMode::Power.policy().authorize(
            TigaOperation::MigratePayload,
            AuthorizationContext {
                session: Some(&session(UnlockMethodType::Password, 100)),
                device: &trusted_device(),
                now_unix_secs: 101,
            },
        );
        assert_eq!(
            power_single.outcome,
            AuthorizationOutcome::RequireAdditionalFactor
        );
        assert!(power_single
            .reasons
            .contains(&AuthorizationReason::SecurityKeyRequired));

        let power_combined = TigaMode::Power.policy().authorize(
            TigaOperation::MigratePayload,
            AuthorizationContext {
                session: Some(&session(UnlockMethodType::PasswordSecurityKey, 100)),
                device: &trusted_device(),
                now_unix_secs: 101,
            },
        );
        assert_eq!(power_combined.outcome, AuthorizationOutcome::Allow);
        assert!(power_combined.audit_required);

        let sky = TigaMode::Sky.policy().authorize(
            TigaOperation::MigratePayload,
            AuthorizationContext {
                session: Some(&session(UnlockMethodType::Password, 100)),
                device: &DeviceContext::default(),
                now_unix_secs: 101,
            },
        );
        assert!(sky.audit_required);
    }

    #[test]
    fn attachment_without_secure_temp_files_forbids_plaintext_persistence() {
        let decision = TigaMode::Sky.policy().authorize(
            TigaOperation::DecryptAttachment,
            AuthorizationContext {
                session: Some(&session(UnlockMethodType::Password, 100)),
                device: &DeviceContext::default(),
                now_unix_secs: 100,
            },
        );

        assert_eq!(decision.outcome, AuthorizationOutcome::AllowWithConstraints);
        assert_eq!(
            decision.constraints,
            vec![AuthorizationConstraint::NoPlaintextPersistence]
        );
    }
}
