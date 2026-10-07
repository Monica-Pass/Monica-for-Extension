use chrono::{DateTime, Utc};
use mdbx_core::model::{
    Snapshot, SnapshotKind, SnapshotLifecycleSummary, SnapshotPruneCandidate, SnapshotPrunePlan,
    SnapshotPruneResult, SnapshotSummary,
};
use mdbx_core::tiga::{AuthorizationDecision, AuthorizationOutcome, TigaOperation, TigaScope};
use rusqlite::params;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::{CommitChange, CommitContext, CommitOperation};
use crate::repo::snapshot_summary::{SnapshotSummaryRepo, MAX_SNAPSHOT_SUMMARY_TEXT_BYTES};
use crate::repo::SnapshotMetadataRepo;
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

pub const MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES: usize = MAX_SNAPSHOT_SUMMARY_TEXT_BYTES;
pub const MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES: usize = 128;
pub const MAX_SNAPSHOT_PRUNE_CANDIDATES: usize = 200;
pub const MAX_SNAPSHOT_PRUNE_KEEP_LATEST: usize = 10_000;
pub const SNAPSHOT_LIFECYCLE_INTEGRITY_PROFILE: &str = "hmac-sha256-v1";

const SNAPSHOT_LIFECYCLE_DOMAIN: &[u8] = b"mdbx-snapshot-lifecycle-v1";
const SNAPSHOT_PRUNE_PLAN_DOMAIN: &[u8] = b"mdbx-snapshot-prune-plan-v1";
const SNAPSHOT_PRUNE_OPERATION_PREFIX: &str = "snapshot-prune-";

pub struct SnapshotLifecycleRepo;

#[derive(Debug)]
struct RawLifecycleRow {
    snapshot_id_bytes: i64,
    snapshot_id: Option<String>,
    base_commit_id_bytes: i64,
    base_commit_id: Option<String>,
    snapshot_hash_bytes: i64,
    snapshot_hash: Option<String>,
    snapshot_ciphertext_bytes: i64,
    created_at_bytes: i64,
    created_at: Option<String>,
    created_by_device_id_bytes: i64,
    created_by_device_id: Option<String>,
    snapshot_kind: Option<String>,
    retention_eligible_at_bytes: i64,
    retention_eligible_at: Option<String>,
    integrity_profile: Option<String>,
    integrity_tag: Option<Vec<u8>>,
}

impl SnapshotLifecycleRepo {
    pub fn register(
        conn: &VaultConnection,
        snapshot_id: &str,
        kind: SnapshotKind,
        retention_eligible_at: Option<&str>,
    ) -> StorageResult<SnapshotLifecycleSummary> {
        conn.with_immediate_transaction(|| {
            Self::register_in_transaction(conn, snapshot_id, kind, retention_eligible_at)
        })
    }

    pub fn register_snapshot(
        conn: &VaultConnection,
        snapshot: &Snapshot,
        kind: SnapshotKind,
        retention_eligible_at: Option<&str>,
    ) -> StorageResult<SnapshotLifecycleSummary> {
        conn.with_immediate_transaction(|| {
            Self::register_from_snapshot_in_transaction(conn, snapshot, kind, retention_eligible_at)
        })
    }

    pub(crate) fn register_from_snapshot_in_transaction(
        conn: &VaultConnection,
        snapshot: &Snapshot,
        kind: SnapshotKind,
        retention_eligible_at: Option<&str>,
    ) -> StorageResult<SnapshotLifecycleSummary> {
        let summary = SnapshotSummary {
            snapshot_id: snapshot.snapshot_id.clone(),
            base_commit_id: snapshot.base_commit_id.clone(),
            snapshot_hash: snapshot.snapshot_hash.clone(),
            snapshot_ciphertext_bytes: u64::try_from(snapshot.snapshot_ct.len()).map_err(|_| {
                StorageError::ResourceLimit {
                    resource: "snapshot ciphertext bytes".to_string(),
                    actual: usize::MAX as u64,
                    limit: u64::MAX,
                }
            })?,
            created_at: snapshot.created_at.clone(),
            created_by_device_id: snapshot.created_by_device_id.clone(),
        };
        Self::register_summary_in_transaction(conn, &summary, kind, retention_eligible_at)
    }

    pub(crate) fn register_in_transaction(
        conn: &VaultConnection,
        snapshot_id: &str,
        kind: SnapshotKind,
        retention_eligible_at: Option<&str>,
    ) -> StorageResult<SnapshotLifecycleSummary> {
        let summary = SnapshotSummaryRepo::get(conn, snapshot_id)?
            .ok_or_else(|| StorageError::NotFound(snapshot_id.to_string()))?;
        Self::register_summary_in_transaction(conn, &summary, kind, retention_eligible_at)
    }

    fn register_summary_in_transaction(
        conn: &VaultConnection,
        summary: &SnapshotSummary,
        kind: SnapshotKind,
        retention_eligible_at: Option<&str>,
    ) -> StorageResult<SnapshotLifecycleSummary> {
        require_integrity_key(conn, "snapshot lifecycle registration")?;
        validate_summary_text(summary)?;
        let created_at = parse_timestamp(&summary.created_at, "snapshot created_at")?;
        let eligibility = validate_kind_and_eligibility(kind, retention_eligible_at, created_at)?;
        let tag = lifecycle_integrity_tag(conn, summary, kind, eligibility.as_deref())?;

        let existing = conn
            .inner()
            .query_row(
                "SELECT snapshot_kind, retention_eligible_at, integrity_profile, integrity_tag
                 FROM snapshot_lifecycle WHERE snapshot_id = ?1",
                params![summary.snapshot_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((stored_kind, stored_eligibility, profile, stored_tag)) = existing {
            if stored_kind != kind.to_string()
                || stored_eligibility != eligibility
                || profile != SNAPSHOT_LIFECYCLE_INTEGRITY_PROFILE
                || stored_tag != tag
            {
                return Err(StorageError::ConstraintViolation(format!(
                    "snapshot lifecycle metadata for {} differs from the authenticated registration",
                    summary.snapshot_id
                )));
            }
            return Ok(SnapshotLifecycleSummary {
                snapshot_id: summary.snapshot_id.clone(),
                kind,
                retention_eligible_at: eligibility,
            });
        }
        conn.inner().execute(
            "INSERT INTO snapshot_lifecycle
                (snapshot_id, snapshot_kind, retention_eligible_at,
                 integrity_profile, integrity_tag)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                summary.snapshot_id,
                kind.to_string(),
                eligibility,
                SNAPSHOT_LIFECYCLE_INTEGRITY_PROFILE,
                tag,
            ],
        )?;
        Ok(SnapshotLifecycleSummary {
            snapshot_id: summary.snapshot_id.clone(),
            kind,
            retention_eligible_at: eligibility,
        })
    }

    pub fn get(
        conn: &VaultConnection,
        snapshot_id: &str,
    ) -> StorageResult<Option<SnapshotLifecycleSummary>> {
        let Some(summary) = SnapshotSummaryRepo::get(conn, snapshot_id)? else {
            return Ok(None);
        };
        let row = conn
            .inner()
            .query_row(
                "SELECT snapshot_kind, retention_eligible_at, integrity_profile, integrity_tag
                 FROM snapshot_lifecycle WHERE snapshot_id = ?1",
                params![snapshot_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((kind_value, stored_eligibility, profile, tag)) = row else {
            return Ok(Some(SnapshotLifecycleSummary {
                snapshot_id: summary.snapshot_id,
                kind: SnapshotKind::Manual,
                retention_eligible_at: None,
            }));
        };
        let kind = kind_value
            .parse::<SnapshotKind>()
            .map_err(StorageError::Validation)?;
        let created_at = parse_timestamp(&summary.created_at, "snapshot created_at")?;
        let eligibility =
            validate_kind_and_eligibility(kind, stored_eligibility.as_deref(), created_at)?;
        if profile != SNAPSHOT_LIFECYCLE_INTEGRITY_PROFILE || tag.len() != 32 {
            return Err(StorageError::Validation(format!(
                "snapshot lifecycle {} has an invalid integrity record",
                snapshot_id
            )));
        }
        if conn.keyring().is_some() {
            let expected = lifecycle_integrity_tag(conn, &summary, kind, eligibility.as_deref())?;
            if expected != tag {
                return Err(StorageError::Validation(format!(
                    "snapshot lifecycle {} integrity tag mismatch",
                    snapshot_id
                )));
            }
        }
        Ok(Some(SnapshotLifecycleSummary {
            snapshot_id: summary.snapshot_id,
            kind,
            retention_eligible_at: eligibility,
        }))
    }

    pub fn plan_automatic_prune(
        conn: &VaultConnection,
        keep_latest: usize,
        now_unix_secs: i64,
    ) -> StorageResult<SnapshotPrunePlan> {
        validate_keep_latest(keep_latest)?;
        require_integrity_key(conn, "automatic snapshot prune planning")?;
        let now = timestamp_from_unix(now_unix_secs, "snapshot prune evaluation time")?;
        let vault_id = vault_id(conn)?;
        let mut stmt = conn.inner().prepare(
            "SELECT
                length(CAST(s.snapshot_id AS BLOB)),
                CASE WHEN length(CAST(s.snapshot_id AS BLOB)) <= ?1 THEN s.snapshot_id END,
                length(CAST(s.base_commit_id AS BLOB)),
                CASE WHEN length(CAST(s.base_commit_id AS BLOB)) <= ?1 THEN s.base_commit_id END,
                length(CAST(s.snapshot_hash AS BLOB)),
                CASE WHEN length(CAST(s.snapshot_hash AS BLOB)) <= ?1 THEN s.snapshot_hash END,
                length(CAST(s.snapshot_ct AS BLOB)),
                length(CAST(s.created_at AS BLOB)),
                CASE WHEN length(CAST(s.created_at AS BLOB)) <= ?1 THEN s.created_at END,
                length(CAST(s.created_by_device_id AS BLOB)),
                CASE WHEN length(CAST(s.created_by_device_id AS BLOB)) <= ?1 THEN s.created_by_device_id END,
                l.snapshot_kind,
                length(CAST(l.retention_eligible_at AS BLOB)),
                CASE WHEN length(CAST(l.retention_eligible_at AS BLOB)) <= ?2 THEN l.retention_eligible_at END,
                l.integrity_profile,
                l.integrity_tag
             FROM snapshot_lifecycle l
             JOIN snapshots s ON s.snapshot_id = l.snapshot_id
             WHERE l.snapshot_kind = 'automatic'
             ORDER BY s.created_at DESC, s.snapshot_id DESC
             LIMIT ?3 OFFSET ?4",
        )?;
        let scan_limit = keep_latest
            .saturating_add(MAX_SNAPSHOT_PRUNE_CANDIDATES)
            .saturating_add(1);
        let rows = stmt.query_map(
            params![
                MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES as i64,
                MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES as i64,
                scan_limit as i64,
                keep_latest as i64
            ],
            read_raw_lifecycle_row,
        )?;
        let key_present = conn.keyring().is_some();
        let mut candidates = Vec::with_capacity(MAX_SNAPSHOT_PRUNE_CANDIDATES + 1);
        for row in rows {
            let raw = row?;
            let summary = decode_summary(&raw)?;
            let kind = raw
                .snapshot_kind
                .as_deref()
                .ok_or_else(|| StorageError::Validation("snapshot kind is missing".to_string()))?
                .parse::<SnapshotKind>()
                .map_err(StorageError::Validation)?;
            if kind != SnapshotKind::Automatic {
                return Err(StorageError::Validation(
                    "automatic prune query returned a non-automatic row".to_string(),
                ));
            }
            let eligibility = bounded_required_text(
                "snapshot retention eligibility bytes",
                raw.retention_eligible_at_bytes,
                raw.retention_eligible_at,
                MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES,
            )?;
            let created_at = parse_timestamp(&summary.created_at, "snapshot created_at")?;
            let eligibility_time = parse_timestamp(&eligibility, "snapshot retention eligibility")?;
            if eligibility_time > now {
                continue;
            }
            validate_kind_and_eligibility(kind, Some(&eligibility), created_at)?;
            if raw.integrity_profile.as_deref() != Some(SNAPSHOT_LIFECYCLE_INTEGRITY_PROFILE) {
                return Err(StorageError::Validation(format!(
                    "snapshot {} uses unsupported lifecycle integrity profile",
                    summary.snapshot_id
                )));
            }
            let tag = raw.integrity_tag.as_deref().ok_or_else(|| {
                StorageError::Validation("snapshot lifecycle integrity tag is missing".to_string())
            })?;
            if !key_present {
                return Err(StorageError::Validation(
                    "automatic snapshot prune requires an unlocked integrity key".to_string(),
                ));
            }
            let expected = lifecycle_integrity_tag(conn, &summary, kind, Some(&eligibility))?;
            if expected != tag {
                return Err(StorageError::Validation(format!(
                    "snapshot lifecycle {} integrity tag mismatch",
                    summary.snapshot_id
                )));
            }
            candidates.push(SnapshotPruneCandidate {
                summary,
                retention_eligible_at: eligibility,
            });
        }
        let has_more = candidates.len() > MAX_SNAPSHOT_PRUNE_CANDIDATES;
        if has_more {
            candidates.truncate(MAX_SNAPSHOT_PRUNE_CANDIDATES);
        }
        let total_ciphertext_bytes = candidates.iter().try_fold(0_u64, |total, candidate| {
            total
                .checked_add(candidate.summary.snapshot_ciphertext_bytes)
                .ok_or_else(|| StorageError::ResourceLimit {
                    resource: "snapshot prune ciphertext bytes".to_string(),
                    actual: u64::MAX,
                    limit: u64::MAX,
                })
        })?;
        let plan_token = compute_plan_token(&vault_id, keep_latest, has_more, &candidates);
        Ok(SnapshotPrunePlan {
            plan_token,
            keep_latest,
            candidates,
            has_more,
            total_ciphertext_bytes,
        })
    }

    pub fn prune_automatic_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        expected_plan_token: &str,
        keep_latest: usize,
        now_unix_secs: i64,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(SnapshotPruneResult, AuthorizationDecision)> {
        validate_plan_token(expected_plan_token)?;
        validate_keep_latest(keep_latest)?;
        require_integrity_key(conn, "automatic snapshot pruning")?;
        let operation_id = prune_operation_id(expected_plan_token);
        if let Some((commit_id, deleted_snapshot_ids)) = existing_prune_result(conn, &operation_id)?
        {
            let decision = TigaService::evaluate_operation(
                conn,
                &TigaScope::Vault,
                TigaOperation::ManageSnapshotRetention,
                context,
            )?;
            if !matches!(
                decision.outcome,
                AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
            ) {
                TigaService::authorize_operation(
                    conn,
                    &TigaScope::Vault,
                    TigaOperation::ManageSnapshotRetention,
                    context,
                )?;
                return Err(StorageError::Authorization(decision));
            }
            return Ok((
                SnapshotPruneResult {
                    plan_token: expected_plan_token.to_string(),
                    commit_id,
                    deleted_snapshot_ids,
                },
                decision,
            ));
        }
        let initial_plan = Self::plan_automatic_prune(conn, keep_latest, now_unix_secs)?;
        if initial_plan.plan_token != expected_plan_token {
            return Err(StorageError::ConstraintViolation(
                "snapshot prune plan is stale; create a new plan".to_string(),
            ));
        }
        if initial_plan.candidates.is_empty() {
            return Err(StorageError::ConstraintViolation(
                "snapshot prune plan has no eligible automatic snapshots".to_string(),
            ));
        }

        let (result, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::ManageSnapshotRetention,
            context,
            || {
                if let Some((commit_id, deleted_snapshot_ids)) =
                    existing_prune_result(conn, &operation_id)?
                {
                    return Ok((
                        SnapshotPruneResult {
                            plan_token: expected_plan_token.to_string(),
                            commit_id: commit_id.clone(),
                            deleted_snapshot_ids,
                        },
                        commit_id,
                    ));
                }
                let plan = Self::plan_automatic_prune(conn, keep_latest, now_unix_secs)?;
                if plan.plan_token != expected_plan_token {
                    return Err(StorageError::ConstraintViolation(
                        "snapshot prune plan changed after authorization; create a new plan"
                            .to_string(),
                    ));
                }
                let changed_objects = plan
                    .candidates
                    .iter()
                    .map(|candidate| CommitChange {
                        object_type: "snapshot".to_string(),
                        object_id: candidate.summary.snapshot_id.clone(),
                        action: "prune".to_string(),
                        fields: vec!["snapshot".to_string(), "snapshot-lifecycle".to_string()],
                    })
                    .collect::<Vec<_>>();
                let operation = CommitOperation::new(
                    operation_id,
                    "prune-automatic-snapshots",
                    "main",
                    "change",
                    "snapshot",
                    changed_objects,
                )
                .with_intent_hash(decode_plan_token(expected_plan_token)?)
                .with_message("prune eligible automatic snapshots");
                let commit_id = ctx.create_operation_commit(conn, &operation)?;
                let mut deleted_snapshot_ids = Vec::with_capacity(plan.candidates.len());
                for candidate in &plan.candidates {
                    SnapshotMetadataRepo::delete_in_transaction(
                        conn,
                        &candidate.summary.snapshot_id,
                    )?;
                    let affected = conn.inner().execute(
                        "DELETE FROM snapshots WHERE snapshot_id = ?1",
                        params![candidate.summary.snapshot_id],
                    )?;
                    if affected != 1 {
                        return Err(StorageError::ConstraintViolation(format!(
                            "snapshot {} disappeared while pruning",
                            candidate.summary.snapshot_id
                        )));
                    }
                    deleted_snapshot_ids.push(candidate.summary.snapshot_id.clone());
                }
                Ok((
                    SnapshotPruneResult {
                        plan_token: expected_plan_token.to_string(),
                        commit_id: commit_id.clone(),
                        deleted_snapshot_ids,
                    },
                    commit_id,
                ))
            },
        )?;
        Ok((result, decision))
    }
}

fn require_integrity_key(conn: &VaultConnection, operation: &str) -> StorageResult<()> {
    if conn.keyring().is_none() {
        return Err(StorageError::Validation(format!(
            "{operation} requires an unlocked vault integrity key"
        )));
    }
    Ok(())
}

fn validate_keep_latest(keep_latest: usize) -> StorageResult<()> {
    if keep_latest > MAX_SNAPSHOT_PRUNE_KEEP_LATEST {
        return Err(StorageError::Validation(format!(
            "keep_latest must be at most {MAX_SNAPSHOT_PRUNE_KEEP_LATEST}"
        )));
    }
    Ok(())
}

fn validate_plan_token(token: &str) -> StorageResult<()> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StorageError::Validation(
            "snapshot prune plan token must be a SHA-256 hex digest".to_string(),
        ));
    }
    Ok(())
}

fn decode_plan_token(token: &str) -> StorageResult<Vec<u8>> {
    validate_plan_token(token)?;
    let mut bytes = Vec::with_capacity(32);
    for pair in token.as_bytes().chunks_exact(2) {
        let hi = hex_nibble(pair[0]).ok_or_else(|| {
            StorageError::Validation("snapshot prune plan token is not valid hex".to_string())
        })?;
        let lo = hex_nibble(pair[1]).ok_or_else(|| {
            StorageError::Validation("snapshot prune plan token is not valid hex".to_string())
        })?;
        bytes.push((hi << 4) | lo);
    }
    Ok(bytes)
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn prune_operation_id(plan_token: &str) -> String {
    format!("{SNAPSHOT_PRUNE_OPERATION_PREFIX}{plan_token}")
}

fn existing_prune_result(
    conn: &VaultConnection,
    operation_id: &str,
) -> StorageResult<Option<(String, Vec<String>)>> {
    let row = conn
        .inner()
        .query_row(
            "SELECT o.commit_id, o.operation_kind, c.change_scope, o.change_summary_ct
             FROM commit_operations o
             JOIN commits c ON c.commit_id = o.commit_id
             WHERE o.operation_id = ?1",
            params![operation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((commit_id, operation_kind, change_scope, change_summary_ct)) = row else {
        return Ok(None);
    };
    if operation_kind != "prune-automatic-snapshots" || change_scope != "snapshot" {
        return Err(StorageError::Validation(format!(
            "operation {operation_id} has incompatible snapshot prune metadata"
        )));
    }
    let summary =
        CommitContext::decrypt_history(conn, &commit_id, "change-summary", &change_summary_ct)?;
    let changes: Vec<CommitChange> = serde_json::from_slice(&summary).map_err(|error| {
        StorageError::Validation(format!("invalid prune commit summary: {error}"))
    })?;
    let ids = changes
        .into_iter()
        .filter(|change| change.object_type == "snapshot" && change.action == "prune")
        .map(|change| change.object_id)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Err(StorageError::Validation(format!(
            "snapshot prune operation {operation_id} has no deleted snapshot IDs"
        )));
    }
    Ok(Some((commit_id, ids)))
}

fn vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::Database)
}

fn validate_summary_text(summary: &SnapshotSummary) -> StorageResult<()> {
    for (name, value) in [
        ("snapshot ID", &summary.snapshot_id),
        ("snapshot base commit ID", &summary.base_commit_id),
        ("snapshot hash", &summary.snapshot_hash),
        ("snapshot created_at", &summary.created_at),
        ("snapshot creator device ID", &summary.created_by_device_id),
    ] {
        if value.is_empty() {
            return Err(StorageError::Validation(format!("{name} is empty")));
        }
        if value.len() > MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES {
            return Err(StorageError::ResourceLimit {
                resource: format!("{name} bytes"),
                actual: value.len() as u64,
                limit: MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES as u64,
            });
        }
    }
    Ok(())
}

fn parse_timestamp(value: &str, resource: &str) -> StorageResult<DateTime<Utc>> {
    if value.is_empty() || value.len() > MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES {
        return Err(StorageError::Validation(format!(
            "{resource} must contain 1 to {MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES} bytes"
        )));
    }
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| StorageError::Validation(format!("invalid {resource}: {error}")))
}

fn timestamp_from_unix(value: i64, resource: &str) -> StorageResult<DateTime<Utc>> {
    DateTime::from_timestamp(value, 0)
        .ok_or_else(|| StorageError::Validation(format!("invalid {resource}")))
}

fn validate_kind_and_eligibility(
    kind: SnapshotKind,
    retention_eligible_at: Option<&str>,
    created_at: DateTime<Utc>,
) -> StorageResult<Option<String>> {
    match (kind, retention_eligible_at) {
        (SnapshotKind::Manual, None) => Ok(None),
        (SnapshotKind::Manual, Some(_)) => Err(StorageError::Validation(
            "manual snapshots cannot have a retention eligibility time".to_string(),
        )),
        (SnapshotKind::Automatic, None) => Err(StorageError::Validation(
            "automatic snapshots require a retention eligibility time".to_string(),
        )),
        (SnapshotKind::Automatic, Some(value)) => {
            let eligibility = parse_timestamp(value, "snapshot retention eligibility")?;
            if eligibility < created_at {
                return Err(StorageError::Validation(
                    "automatic snapshot retention eligibility cannot precede creation".to_string(),
                ));
            }
            Ok(Some(eligibility.to_rfc3339()))
        }
    }
}

fn lifecycle_integrity_tag(
    conn: &VaultConnection,
    summary: &SnapshotSummary,
    kind: SnapshotKind,
    eligibility: Option<&str>,
) -> StorageResult<Vec<u8>> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "snapshot lifecycle authentication requires an unlocked integrity key".to_string(),
        )
    })?;
    let vault_id = vault_id(conn)?;
    let kind_value = kind.to_string();
    let byte_count = summary.snapshot_ciphertext_bytes.to_le_bytes();
    let parts: [&[u8]; 10] = [
        SNAPSHOT_LIFECYCLE_DOMAIN,
        vault_id.as_bytes(),
        summary.snapshot_id.as_bytes(),
        summary.base_commit_id.as_bytes(),
        summary.snapshot_hash.as_bytes(),
        kind_value.as_bytes(),
        eligibility.unwrap_or("").as_bytes(),
        summary.created_at.as_bytes(),
        summary.created_by_device_id.as_bytes(),
        &byte_count,
    ];
    let mut encoded = Vec::new();
    for part in parts {
        encoded.extend_from_slice(&(part.len() as u64).to_le_bytes());
        encoded.extend_from_slice(part);
    }
    mdbx_crypto::integrity::hmac_sha256(&keyring.integrity_subkey, &[&encoded])
        .map_err(StorageError::Crypto)
}

fn compute_plan_token(
    vault_id: &str,
    keep_latest: usize,
    has_more: bool,
    candidates: &[SnapshotPruneCandidate],
) -> String {
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, SNAPSHOT_PRUNE_PLAN_DOMAIN);
    hash_part(&mut hasher, vault_id.as_bytes());
    hash_part(&mut hasher, &(keep_latest as u64).to_le_bytes());
    hash_part(&mut hasher, &[u8::from(has_more)]);
    for candidate in candidates {
        hash_part(&mut hasher, b"candidate");
        hash_part(&mut hasher, candidate.summary.snapshot_id.as_bytes());
        hash_part(&mut hasher, candidate.summary.base_commit_id.as_bytes());
        hash_part(&mut hasher, candidate.summary.snapshot_hash.as_bytes());
        hash_part(
            &mut hasher,
            &candidate.summary.snapshot_ciphertext_bytes.to_le_bytes(),
        );
        hash_part(&mut hasher, candidate.summary.created_at.as_bytes());
        hash_part(
            &mut hasher,
            candidate.summary.created_by_device_id.as_bytes(),
        );
        hash_part(&mut hasher, candidate.retention_eligible_at.as_bytes());
    }
    encode_hex(&hasher.finalize())
}

fn hash_part(hasher: &mut Sha256, part: &[u8]) {
    hasher.update((part.len() as u64).to_le_bytes());
    hasher.update(part);
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn read_raw_lifecycle_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawLifecycleRow> {
    Ok(RawLifecycleRow {
        snapshot_id_bytes: row.get(0)?,
        snapshot_id: row.get(1)?,
        base_commit_id_bytes: row.get(2)?,
        base_commit_id: row.get(3)?,
        snapshot_hash_bytes: row.get(4)?,
        snapshot_hash: row.get(5)?,
        snapshot_ciphertext_bytes: row.get(6)?,
        created_at_bytes: row.get(7)?,
        created_at: row.get(8)?,
        created_by_device_id_bytes: row.get(9)?,
        created_by_device_id: row.get(10)?,
        snapshot_kind: row.get(11)?,
        retention_eligible_at_bytes: row.get(12)?,
        retention_eligible_at: row.get(13)?,
        integrity_profile: row.get(14)?,
        integrity_tag: row.get(15)?,
    })
}

fn decode_summary(raw: &RawLifecycleRow) -> StorageResult<SnapshotSummary> {
    let snapshot_id = bounded_required_text(
        "snapshot ID bytes",
        raw.snapshot_id_bytes,
        raw.snapshot_id.clone(),
        MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES,
    )?;
    let base_commit_id = bounded_required_text(
        "snapshot base commit ID bytes",
        raw.base_commit_id_bytes,
        raw.base_commit_id.clone(),
        MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES,
    )?;
    let snapshot_hash = bounded_required_text(
        "snapshot hash bytes",
        raw.snapshot_hash_bytes,
        raw.snapshot_hash.clone(),
        MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES,
    )?;
    let created_at = bounded_required_text(
        "snapshot created-at bytes",
        raw.created_at_bytes,
        raw.created_at.clone(),
        MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES,
    )?;
    let created_by_device_id = bounded_required_text(
        "snapshot creator device ID bytes",
        raw.created_by_device_id_bytes,
        raw.created_by_device_id.clone(),
        MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES,
    )?;
    let snapshot_ciphertext_bytes = u64::try_from(raw.snapshot_ciphertext_bytes).map_err(|_| {
        StorageError::Validation("snapshot ciphertext byte length is negative".to_string())
    })?;
    Ok(SnapshotSummary {
        snapshot_id,
        base_commit_id,
        snapshot_hash,
        snapshot_ciphertext_bytes,
        created_at,
        created_by_device_id,
    })
}

fn bounded_required_text(
    resource: &str,
    stored_length: i64,
    value: Option<String>,
    limit: usize,
) -> StorageResult<String> {
    if stored_length < 0 {
        return Err(StorageError::Validation(format!(
            "{resource} is missing a length"
        )));
    }
    let stored_length = usize::try_from(stored_length)
        .map_err(|_| StorageError::Validation(format!("{resource} length is outside limits")))?;
    if stored_length == 0 {
        return Err(StorageError::Validation(format!("{resource} is empty")));
    }
    if stored_length > limit {
        return Err(StorageError::ResourceLimit {
            resource: resource.to_string(),
            actual: stored_length as u64,
            limit: limit as u64,
        });
    }
    let value = value
        .ok_or_else(|| StorageError::Validation(format!("{resource} is not valid bounded text")))?;
    if value.is_empty() || value.len() != stored_length {
        return Err(StorageError::Validation(format!(
            "{resource} length does not match its value"
        )));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::SnapshotRepo;
    use crate::unlock::UnlockService;
    use mdbx_core::tiga::{DeviceAssurance, DeviceContext};

    fn setup() -> (VaultConnection, CommitContext) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "snapshot-lifecycle-device".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        UnlockService::setup_password(&mut conn, "snapshot lifecycle password").unwrap();
        (
            conn,
            CommitContext::new("snapshot-lifecycle-device".to_string()),
        )
    }

    fn auth_context<'a>(
        conn: &'a VaultConnection,
        device: &'a DeviceContext,
        now: i64,
    ) -> TigaAuthorizationContext<'a> {
        TigaAuthorizationContext {
            session: conn.active_session(),
            device,
            now_unix_secs: now,
        }
    }

    #[test]
    fn legacy_snapshot_is_manual_and_never_a_prune_candidate() {
        let (conn, ctx) = setup();
        let legacy = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let lifecycle = SnapshotLifecycleRepo::get(&conn, &legacy.snapshot_id)
            .unwrap()
            .unwrap();
        assert_eq!(lifecycle.kind, SnapshotKind::Manual);
        assert!(lifecycle.retention_eligible_at.is_none());
        let plan =
            SnapshotLifecycleRepo::plan_automatic_prune(&conn, 0, Utc::now().timestamp() + 3600)
                .unwrap();
        assert!(plan.candidates.is_empty());
    }

    #[test]
    fn automatic_plan_is_bounded_and_hmac_tampering_fails_closed() {
        let (conn, ctx) = setup();
        let eligible_at = (Utc::now() + chrono::Duration::seconds(1)).to_rfc3339();
        for _ in 0..3 {
            SnapshotRepo::create_automatic_snapshot(&conn, &ctx, &eligible_at).unwrap();
        }
        let plan =
            SnapshotLifecycleRepo::plan_automatic_prune(&conn, 1, Utc::now().timestamp() + 3600)
                .unwrap();
        assert_eq!(plan.candidates.len(), 2);
        assert!(!plan.has_more);
        assert_eq!(
            plan.total_ciphertext_bytes,
            plan.candidates
                .iter()
                .map(|c| c.summary.snapshot_ciphertext_bytes)
                .sum::<u64>()
        );

        let id = plan.candidates[0].summary.snapshot_id.clone();
        conn.inner()
            .execute(
                "UPDATE snapshot_lifecycle SET integrity_tag = zeroblob(32)
                 WHERE snapshot_id = ?1",
                params![id],
            )
            .unwrap();
        assert!(matches!(
            SnapshotLifecycleRepo::plan_automatic_prune(&conn, 1, Utc::now().timestamp() + 3600),
            Err(StorageError::Validation(message)) if message.contains("integrity tag mismatch")
        ));
    }

    #[test]
    fn authorized_prune_deletes_only_eligible_automatic_rows_with_one_commit() {
        let (conn, ctx) = setup();
        let eligible_at = (Utc::now() + chrono::Duration::seconds(1)).to_rfc3339();
        let mut ids = Vec::new();
        for _ in 0..3 {
            ids.push(
                SnapshotRepo::create_automatic_snapshot(&conn, &ctx, &eligible_at)
                    .unwrap()
                    .snapshot_id,
            );
        }
        let legacy = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        let now = Utc::now().timestamp();
        let plan = SnapshotLifecycleRepo::plan_automatic_prune(&conn, 1, now).unwrap();
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let device = DeviceContext {
            device_id: Some("snapshot-lifecycle-device".to_string()),
            assurance: DeviceAssurance::Standard,
            ..Default::default()
        };
        let (result, decision) = SnapshotLifecycleRepo::prune_automatic_authorized(
            &conn,
            &ctx,
            &plan.plan_token,
            1,
            now,
            auth_context(&conn, &device, now),
        )
        .unwrap();
        assert!(matches!(
            decision.outcome,
            mdbx_core::tiga::AuthorizationOutcome::Allow
                | mdbx_core::tiga::AuthorizationOutcome::AllowWithConstraints
        ));
        assert_eq!(result.deleted_snapshot_ids.len(), 2);
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            before_commits + 1
        );
        assert!(SnapshotRepo::get_by_id(&conn, &legacy.snapshot_id)
            .unwrap()
            .is_some());
        assert!(
            ids.iter()
                .filter(|id| result.deleted_snapshot_ids.contains(id))
                .count()
                == 2
        );
        let events = TigaService::list_security_audit_events(&conn, 20).unwrap();
        assert!(events.iter().any(|event| {
            event.operation == TigaOperation::ManageSnapshotRetention
                && event.commit_id.as_deref() == Some(result.commit_id.as_str())
        }));
        let commit_count = conn
            .inner()
            .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let (retry, _) = SnapshotLifecycleRepo::prune_automatic_authorized(
            &conn,
            &ctx,
            &plan.plan_token,
            1,
            now,
            auth_context(&conn, &device, now),
        )
        .unwrap();
        assert_eq!(retry.commit_id, result.commit_id);
        assert_eq!(retry.deleted_snapshot_ids, result.deleted_snapshot_ids);
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            commit_count
        );
        let audit_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
             WHERE operation = 'manage-snapshot-retention'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
    }

    #[test]
    fn stale_prune_plan_leaves_snapshots_and_commits_unchanged() {
        let (conn, ctx) = setup();
        let eligible_at = (Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
        SnapshotRepo::create_automatic_snapshot(&conn, &ctx, &eligible_at).unwrap();
        let evaluation_time = Utc::now().timestamp() + 3600;
        let plan = SnapshotLifecycleRepo::plan_automatic_prune(&conn, 0, evaluation_time).unwrap();
        assert_eq!(plan.candidates.len(), 1);

        SnapshotRepo::create_automatic_snapshot(&conn, &ctx, &eligible_at).unwrap();
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let device = DeviceContext {
            device_id: Some("snapshot-lifecycle-device".to_string()),
            assurance: DeviceAssurance::Standard,
            ..Default::default()
        };
        let error = SnapshotLifecycleRepo::prune_automatic_authorized(
            &conn,
            &ctx,
            &plan.plan_token,
            0,
            evaluation_time,
            auth_context(&conn, &device, evaluation_time),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            StorageError::ConstraintViolation(message) if message.contains("stale")
        ));
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))
                .unwrap(),
            2
        );
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            before_commits
        );
    }

    #[test]
    fn prune_denial_preserves_automatic_snapshot_rows_and_commit_history() {
        let (conn, ctx) = setup();
        let eligible_at = (Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
        let snapshot = SnapshotRepo::create_automatic_snapshot(&conn, &ctx, &eligible_at).unwrap();
        let evaluation_time = Utc::now().timestamp() + 3600;
        let plan = SnapshotLifecycleRepo::plan_automatic_prune(&conn, 0, evaluation_time).unwrap();
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let device = DeviceContext {
            device_id: Some("snapshot-lifecycle-device".to_string()),
            assurance: DeviceAssurance::Standard,
            ..Default::default()
        };
        let error = SnapshotLifecycleRepo::prune_automatic_authorized(
            &conn,
            &ctx,
            &plan.plan_token,
            0,
            evaluation_time,
            TigaAuthorizationContext {
                session: None,
                device: &device,
                now_unix_secs: evaluation_time,
            },
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Authorization(_)));
        assert!(SnapshotRepo::get_by_id(&conn, &snapshot.snapshot_id)
            .unwrap()
            .is_some());
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            before_commits
        );
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>(
                    "SELECT COUNT(*) FROM snapshot_lifecycle WHERE snapshot_id = ?1",
                    params![snapshot.snapshot_id],
                    |row| row.get(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn automatic_creation_requires_tiga_and_records_create_snapshot_audit() {
        let (conn, ctx) = setup();
        let device = DeviceContext {
            device_id: Some("snapshot-lifecycle-device".to_string()),
            assurance: DeviceAssurance::Standard,
            ..Default::default()
        };
        let eligible_at = (Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
        let (snapshot, decision) = SnapshotRepo::create_automatic_snapshot_authorized(
            &conn,
            &ctx,
            &eligible_at,
            auth_context(&conn, &device, Utc::now().timestamp()),
        )
        .unwrap();
        assert!(matches!(
            decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert_eq!(
            SnapshotLifecycleRepo::get(&conn, &snapshot.snapshot_id)
                .unwrap()
                .unwrap()
                .kind,
            SnapshotKind::Automatic
        );
        let events = TigaService::list_security_audit_events(&conn, 20).unwrap();
        assert!(events.iter().any(|event| {
            event.operation == TigaOperation::CreateSnapshot
                && event.commit_id.as_deref() == Some(snapshot.base_commit_id.as_str())
        }));
    }
}
