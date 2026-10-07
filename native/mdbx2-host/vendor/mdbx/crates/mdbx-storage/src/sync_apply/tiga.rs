use rusqlite::{params, OptionalExtension};

use mdbx_core::tiga::{
    AuthorizationConstraint, AuthorizationReason, PolicyException, TigaMode, TigaPolicyOverride,
    TigaScope,
};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::sync_state::{
    SecurityAuditEventRow, TigaPolicyExceptionRow, TigaPolicyOverrideRow, TigaVaultStateRow,
};
use crate::tiga_policy::{
    optional_integrity_tag, validate_audit_correlation, validate_audit_evidence,
    verify_optional_integrity_tag, SecurityAuditEvent,
};

pub(super) fn apply_tiga_vault_state(
    conn: &VaultConnection,
    incoming: &TigaVaultStateRow,
) -> StorageResult<()> {
    if incoming.policy_version > mdbx_core::tiga::TIGA_POLICY_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported incoming Tiga policy version {}; expected {}",
            incoming.policy_version,
            mdbx_core::tiga::TIGA_POLICY_VERSION
        )));
    }
    let local: TigaVaultStateRow = conn.inner().query_row(
        "SELECT default_tiga_mode, tiga_policy_version, tiga_compliance_status, updated_at
         FROM vault_meta",
        [],
        |row| {
            Ok(TigaVaultStateRow {
                default_tiga_mode: row.get(0)?,
                policy_version: row.get::<_, i64>(1)? as u32,
                compliance_status: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )?;
    let local_mode: TigaMode = local
        .default_tiga_mode
        .parse()
        .map_err(StorageError::Validation)?;
    let incoming_mode: TigaMode = incoming
        .default_tiga_mode
        .parse()
        .map_err(StorageError::Validation)?;
    let mode = std::cmp::max(local_mode, incoming_mode).to_string();
    let compliance =
        stricter_compliance_status(&local.compliance_status, &incoming.compliance_status)?;
    conn.inner().execute(
        "UPDATE vault_meta SET default_tiga_mode = ?1, tiga_policy_version = ?2,
         tiga_compliance_status = ?3, updated_at = ?4",
        params![
            mode,
            std::cmp::max(local.policy_version, incoming.policy_version),
            compliance,
            std::cmp::max(&local.updated_at, &incoming.updated_at),
        ],
    )?;
    crate::vault_header_integrity::refresh_after_mutation(conn)
}

pub(super) fn apply_tiga_policy_exceptions(
    conn: &VaultConnection,
    incoming_rows: &[TigaPolicyExceptionRow],
) -> StorageResult<()> {
    for incoming in incoming_rows {
        let incoming_exception = policy_exception_from_row(incoming)?;
        verify_optional_integrity_tag(
            conn,
            b"tiga-policy-exception",
            &incoming_exception,
            incoming.integrity_tag.as_deref(),
        )?;
        let local = conn
            .inner()
            .query_row(
                "SELECT exception_id, target_scope, target_id, approved_override_json,
                        reason, expires_at_unix_secs, created_at,
                        created_by_session_id, revoked_at, integrity_tag
                 FROM tiga_policy_exceptions WHERE exception_id = ?1",
                params![incoming.exception_id],
                |row| {
                    Ok(TigaPolicyExceptionRow {
                        exception_id: row.get(0)?,
                        target_scope: row.get(1)?,
                        target_id: row.get(2)?,
                        approved_override_json: row.get(3)?,
                        reason: row.get(4)?,
                        expires_at_unix_secs: row.get(5)?,
                        created_at: row.get(6)?,
                        created_by_session_id: row.get(7)?,
                        revoked_at: row.get(8)?,
                        integrity_tag: row.get(9)?,
                    })
                },
            )
            .optional()?;

        if let Some(local) = local {
            let local_exception = policy_exception_from_row(&local)?;
            verify_optional_integrity_tag(
                conn,
                b"tiga-policy-exception",
                &local_exception,
                local.integrity_tag.as_deref(),
            )?;
            if !same_exception_identity(&local, incoming) {
                return Err(StorageError::Validation(format!(
                    "Tiga exception {} was rewritten during sync",
                    incoming.exception_id
                )));
            }
            let revoked_at = earliest_present(local.revoked_at, incoming.revoked_at.clone());
            let integrity_tag = incoming
                .integrity_tag
                .as_ref()
                .or(local.integrity_tag.as_ref());
            conn.inner().execute(
                "UPDATE tiga_policy_exceptions SET revoked_at = ?1, integrity_tag = ?2
                 WHERE exception_id = ?3",
                params![revoked_at, integrity_tag, incoming.exception_id],
            )?;
        } else {
            conn.inner().execute(
                "INSERT INTO tiga_policy_exceptions
                    (exception_id, target_scope, target_id, approved_override_json,
                     reason, expires_at_unix_secs, created_at, created_by_session_id,
                     revoked_at, integrity_tag)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    incoming.exception_id,
                    incoming.target_scope,
                    incoming.target_id,
                    incoming.approved_override_json,
                    incoming.reason,
                    incoming.expires_at_unix_secs,
                    incoming.created_at,
                    incoming.created_by_session_id,
                    incoming.revoked_at,
                    incoming.integrity_tag,
                ],
            )?;
        }
    }
    Ok(())
}

pub(super) fn apply_tiga_policy_overrides(
    conn: &VaultConnection,
    incoming_rows: &[TigaPolicyOverrideRow],
) -> StorageResult<()> {
    for incoming in incoming_rows {
        let incoming_policy: TigaPolicyOverride = serde_json::from_str(&incoming.policy_json)
            .map_err(|e| StorageError::Validation(format!("invalid incoming Tiga policy: {e}")))?;
        verify_optional_integrity_tag(
            conn,
            b"tiga-policy-override",
            &incoming_policy,
            incoming.integrity_tag.as_deref(),
        )?;
        let local = conn
            .inner()
            .query_row(
                "SELECT scope_type, scope_id, policy_json, exception_id, updated_at,
                        updated_by_device_id, integrity_tag
                 FROM tiga_policy_overrides
                 WHERE scope_type = ?1 AND scope_id = ?2",
                params![incoming.scope_type, incoming.scope_id],
                |row| {
                    Ok(TigaPolicyOverrideRow {
                        scope_type: row.get(0)?,
                        scope_id: row.get(1)?,
                        policy_json: row.get(2)?,
                        exception_id: row.get(3)?,
                        updated_at: row.get(4)?,
                        updated_by_device_id: row.get(5)?,
                        integrity_tag: row.get(6)?,
                    })
                },
            )
            .optional()?;

        let merged = if let Some(local) = local {
            let local_policy: TigaPolicyOverride = serde_json::from_str(&local.policy_json)
                .map_err(|e| StorageError::Validation(format!("invalid local Tiga policy: {e}")))?;
            verify_optional_integrity_tag(
                conn,
                b"tiga-policy-override",
                &local_policy,
                local.integrity_tag.as_deref(),
            )?;
            let merged_policy = local_policy.merge_stricter(&incoming_policy);
            let exception_id = if merged_policy == local_policy && merged_policy != incoming_policy
            {
                local.exception_id.clone()
            } else if merged_policy == incoming_policy && merged_policy != local_policy {
                incoming.exception_id.clone()
            } else if local.exception_id == incoming.exception_id {
                local.exception_id.clone()
            } else {
                None
            };
            let incoming_wins_metadata = incoming.updated_at >= local.updated_at;
            TigaPolicyOverrideRow {
                scope_type: incoming.scope_type.clone(),
                scope_id: incoming.scope_id.clone(),
                policy_json: serde_json::to_string(&merged_policy)
                    .map_err(|e| StorageError::Validation(e.to_string()))?,
                exception_id,
                updated_at: std::cmp::max(local.updated_at, incoming.updated_at.clone()),
                updated_by_device_id: if incoming_wins_metadata {
                    incoming.updated_by_device_id.clone()
                } else {
                    local.updated_by_device_id
                },
                integrity_tag: if merged_policy == incoming_policy {
                    incoming.integrity_tag.clone()
                } else if merged_policy == local_policy {
                    local.integrity_tag
                } else {
                    optional_integrity_tag(conn, b"tiga-policy-override", &merged_policy)?
                },
            }
        } else {
            incoming.clone()
        };

        conn.inner().execute(
            "INSERT INTO tiga_policy_overrides
                (scope_type, scope_id, policy_json, exception_id, updated_at,
                 updated_by_device_id, integrity_tag)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(scope_type, scope_id) DO UPDATE SET
                policy_json = excluded.policy_json,
                exception_id = excluded.exception_id,
                updated_at = excluded.updated_at,
                updated_by_device_id = excluded.updated_by_device_id,
                integrity_tag = excluded.integrity_tag",
            params![
                merged.scope_type,
                merged.scope_id,
                merged.policy_json,
                merged.exception_id,
                merged.updated_at,
                merged.updated_by_device_id,
                merged.integrity_tag,
            ],
        )?;
    }
    Ok(())
}

pub(super) fn apply_security_audit_events(
    conn: &VaultConnection,
    incoming_rows: &[SecurityAuditEventRow],
) -> StorageResult<()> {
    for incoming in incoming_rows {
        let incoming_event = security_audit_event_from_row(incoming)?;
        verify_optional_integrity_tag(
            conn,
            b"tiga-security-audit",
            &incoming_event,
            incoming.integrity_tag.as_deref(),
        )?;
        validate_audit_evidence(&incoming_event)?;
        validate_audit_correlation(conn, &incoming_event)?;
        let local = conn
            .inner()
            .query_row(
                "SELECT event_id, occurred_at, operation, outcome, scope_type, scope_id,
                        session_id, device_id, reason_codes_json, constraints_json,
                        exception_id, operation_id, commit_id, policy_version,
                        policy_fingerprint, integrity_tag
                 FROM security_audit_events WHERE event_id = ?1",
                params![incoming.event_id],
                |row| {
                    Ok(SecurityAuditEventRow {
                        event_id: row.get(0)?,
                        occurred_at: row.get(1)?,
                        operation: row.get(2)?,
                        outcome: row.get(3)?,
                        scope_type: row.get(4)?,
                        scope_id: row.get(5)?,
                        session_id: row.get(6)?,
                        device_id: row.get(7)?,
                        reason_codes_json: row.get(8)?,
                        constraints_json: row.get(9)?,
                        exception_id: row.get(10)?,
                        operation_id: row.get(11)?,
                        commit_id: row.get(12)?,
                        policy_version: row.get::<_, Option<i64>>(13)?.map(|value| value as u32),
                        policy_fingerprint: row.get(14)?,
                        integrity_tag: row.get(15)?,
                    })
                },
            )
            .optional()?;
        if let Some(local) = local {
            let local_event = security_audit_event_from_row(&local)?;
            verify_optional_integrity_tag(
                conn,
                b"tiga-security-audit",
                &local_event,
                local.integrity_tag.as_deref(),
            )?;
            validate_audit_evidence(&local_event)?;
            validate_audit_correlation(conn, &local_event)?;
            if !same_audit_identity(&local, incoming) {
                return Err(StorageError::Validation(format!(
                    "security audit event {} was rewritten during sync",
                    incoming.event_id
                )));
            }
        } else {
            conn.inner().execute(
                "INSERT INTO security_audit_events
                    (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                     session_id, device_id, reason_codes_json, constraints_json,
                     exception_id, operation_id, commit_id, policy_version,
                     policy_fingerprint, integrity_tag)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                         ?13, ?14, ?15, ?16)",
                params![
                    incoming.event_id,
                    incoming.occurred_at,
                    incoming.operation,
                    incoming.outcome,
                    incoming.scope_type,
                    incoming.scope_id,
                    incoming.session_id,
                    incoming.device_id,
                    incoming.reason_codes_json,
                    incoming.constraints_json,
                    incoming.exception_id,
                    incoming.operation_id,
                    incoming.commit_id,
                    incoming.policy_version.map(i64::from),
                    incoming.policy_fingerprint,
                    incoming.integrity_tag,
                ],
            )?;
        }
    }
    Ok(())
}

fn stricter_compliance_status<'a>(a: &'a str, b: &'a str) -> StorageResult<&'a str> {
    fn rank(value: &str) -> Option<u8> {
        match value {
            "compliant" => Some(0),
            "exception" => Some(1),
            "remediation-required" => Some(2),
            _ => None,
        }
    }
    let a_rank =
        rank(a).ok_or_else(|| StorageError::Validation(format!("invalid Tiga status: {a}")))?;
    let b_rank =
        rank(b).ok_or_else(|| StorageError::Validation(format!("invalid Tiga status: {b}")))?;
    Ok(if a_rank >= b_rank { a } else { b })
}

fn earliest_present(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(std::cmp::min(a, b)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn same_exception_identity(a: &TigaPolicyExceptionRow, b: &TigaPolicyExceptionRow) -> bool {
    a.exception_id == b.exception_id
        && a.target_scope == b.target_scope
        && a.target_id == b.target_id
        && a.approved_override_json == b.approved_override_json
        && a.reason == b.reason
        && a.expires_at_unix_secs == b.expires_at_unix_secs
        && a.created_at == b.created_at
        && a.created_by_session_id == b.created_by_session_id
}

fn same_audit_identity(a: &SecurityAuditEventRow, b: &SecurityAuditEventRow) -> bool {
    a.event_id == b.event_id
        && a.occurred_at == b.occurred_at
        && a.operation == b.operation
        && a.outcome == b.outcome
        && a.scope_type == b.scope_type
        && a.scope_id == b.scope_id
        && a.session_id == b.session_id
        && a.device_id == b.device_id
        && a.reason_codes_json == b.reason_codes_json
        && a.constraints_json == b.constraints_json
        && a.exception_id == b.exception_id
        && a.operation_id == b.operation_id
        && a.commit_id == b.commit_id
        && a.policy_version == b.policy_version
        && a.policy_fingerprint == b.policy_fingerprint
}

fn policy_exception_from_row(row: &TigaPolicyExceptionRow) -> StorageResult<PolicyException> {
    Ok(PolicyException {
        exception_id: row.exception_id.clone(),
        target: tiga_scope_from_parts(&row.target_scope, &row.target_id)?,
        approved_override: serde_json::from_str(&row.approved_override_json).map_err(|error| {
            StorageError::Validation(format!("invalid synced Tiga exception: {error}"))
        })?,
        reason: row.reason.clone(),
        expires_at_unix_secs: row.expires_at_unix_secs,
    })
}

fn security_audit_event_from_row(row: &SecurityAuditEventRow) -> StorageResult<SecurityAuditEvent> {
    Ok(SecurityAuditEvent {
        event_id: row.event_id.clone(),
        occurred_at: row.occurred_at.clone(),
        operation: parse_storage_enum(&row.operation)?,
        outcome: parse_storage_enum(&row.outcome)?,
        scope: tiga_scope_from_parts(&row.scope_type, &row.scope_id)?,
        session_id: row.session_id.clone(),
        device_id: row.device_id.clone(),
        reasons: serde_json::from_str::<Vec<AuthorizationReason>>(&row.reason_codes_json)
            .map_err(|error| StorageError::Validation(error.to_string()))?,
        constraints: serde_json::from_str::<Vec<AuthorizationConstraint>>(&row.constraints_json)
            .map_err(|error| StorageError::Validation(error.to_string()))?,
        exception_id: row.exception_id.clone(),
        operation_id: row.operation_id.clone(),
        commit_id: row.commit_id.clone(),
        policy_version: row.policy_version,
        policy_fingerprint: row.policy_fingerprint.clone(),
    })
}

fn parse_storage_enum<T: serde::de::DeserializeOwned>(value: &str) -> StorageResult<T> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(|error| StorageError::Validation(error.to_string()))
}

pub(super) fn tiga_scope_from_parts(scope_type: &str, scope_id: &str) -> StorageResult<TigaScope> {
    match scope_type {
        "vault" => Ok(TigaScope::Vault),
        "project" => Ok(TigaScope::Project {
            project_id: scope_id.to_string(),
        }),
        "entry" => Ok(TigaScope::Entry {
            entry_id: scope_id.to_string(),
        }),
        "attachment" => Ok(TigaScope::Attachment {
            attachment_id: scope_id.to_string(),
        }),
        other => Err(StorageError::Validation(format!(
            "invalid synced Tiga scope: {other}"
        ))),
    }
}
