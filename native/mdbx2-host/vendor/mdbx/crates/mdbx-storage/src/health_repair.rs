use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::recovery::{HealthCheckResult, IssueSeverity, RecoveryVerifier};
use crate::repo::{
    AttachmentRepo, CommitChange, CommitContext, CommitOperation, EntryRepo,
    ObjectLabelAssignmentRepo, ObjectLabelRepo, ObjectRelationRepo, OperationExecution,
    ProjectRepo, SnapshotRepo, TombstoneAcknowledgementRepo,
};

const SUPPORTED_OBJECT_STATES_SQL: &str = "
    SELECT 'project', project_id, deleted, head_commit_id FROM projects
    UNION ALL SELECT 'entry', entry_id, deleted, head_commit_id FROM entries
    UNION ALL SELECT 'attachment', attachment_id, deleted, head_commit_id FROM attachments
    UNION ALL SELECT 'object-relation', relation_id, deleted, head_commit_id FROM object_relations
    UNION ALL SELECT 'object-label', label_id, deleted, head_commit_id FROM object_labels
    UNION ALL SELECT 'object-label-assignment', assignment_id, deleted, head_commit_id
              FROM object_label_assignments
";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HealthRepairItemKind {
    MissingTombstone,
    DuplicateTombstones,
    ActiveObjectTombstoneConflict,
}

impl HealthRepairItemKind {
    fn code(self) -> &'static str {
        match self {
            Self::MissingTombstone => "missing-tombstone",
            Self::DuplicateTombstones => "duplicate-tombstones",
            Self::ActiveObjectTombstoneConflict => "active-object-tombstone-conflict",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthRepairItem {
    pub repair_id: String,
    pub kind: HealthRepairItemKind,
    pub object_type: String,
    pub object_id: String,
    pub tombstone_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthRepairBlocker {
    pub category: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthRepairPlan {
    pub token: String,
    pub automatic_items: Vec<HealthRepairItem>,
    pub conflict_items: Vec<HealthRepairItem>,
    pub blockers: Vec<HealthRepairBlocker>,
}

impl HealthRepairPlan {
    pub fn is_empty(&self) -> bool {
        self.automatic_items.is_empty() && self.conflict_items.is_empty()
    }

    pub fn can_apply(&self) -> bool {
        !self.is_empty() && self.blockers.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HealthRepairChoice {
    KeepContent,
    DeleteObject,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthRepairDecision {
    pub repair_id: String,
    pub choice: HealthRepairChoice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthRepairStatus {
    Applied,
    Cancelled,
    NoChanges,
}

#[derive(Debug, Clone)]
pub struct HealthRepairApplyResult {
    pub status: HealthRepairStatus,
    pub snapshot_id: Option<String>,
    pub commit_id: Option<String>,
    pub repaired_count: u32,
    pub already_committed: bool,
    pub health: HealthCheckResult,
}

#[derive(Debug, Clone, Serialize)]
struct CandidateState {
    item: HealthRepairItem,
    deleted: bool,
    head_commit_id: String,
    tombstones: Vec<TombstoneState>,
}

#[derive(Debug, Clone, Serialize)]
struct TombstoneState {
    tombstone_id: String,
    delete_clock: String,
    deleted_by_device_id: String,
    deleted_at: String,
    purge_eligible_at: Option<String>,
    delete_commit_id: Option<String>,
}

#[derive(Serialize)]
struct PlanFingerprint<'a> {
    candidates: &'a [CandidateState],
    blockers: &'a [(String, String)],
}

pub struct HealthRepairService;

impl HealthRepairService {
    pub fn plan(conn: &VaultConnection) -> StorageResult<HealthRepairPlan> {
        let candidates = scan_candidates(conn)?;
        let health = RecoveryVerifier::full_health_check(conn)?;
        let mut blockers = health
            .issues
            .into_iter()
            .filter(|issue| {
                issue.severity >= IssueSeverity::Error && issue.category != "tombstones"
            })
            .map(|issue| HealthRepairBlocker {
                category: issue.category,
                description: issue.description,
            })
            .collect::<Vec<_>>();
        blockers.sort_by(|left, right| {
            (&left.category, &left.description).cmp(&(&right.category, &right.description))
        });
        let blocker_fingerprint = blockers
            .iter()
            .map(|blocker| (blocker.category.clone(), blocker.description.clone()))
            .collect::<Vec<_>>();
        let token = digest_json(&PlanFingerprint {
            candidates: &candidates,
            blockers: &blocker_fingerprint,
        })?;
        let automatic_items = candidates
            .iter()
            .filter(|candidate| {
                candidate.item.kind != HealthRepairItemKind::ActiveObjectTombstoneConflict
            })
            .map(|candidate| candidate.item.clone())
            .collect();
        let conflict_items = candidates
            .iter()
            .filter(|candidate| {
                candidate.item.kind == HealthRepairItemKind::ActiveObjectTombstoneConflict
            })
            .map(|candidate| candidate.item.clone())
            .collect();
        Ok(HealthRepairPlan {
            token,
            automatic_items,
            conflict_items,
            blockers,
        })
    }

    pub fn apply(
        conn: &VaultConnection,
        ctx: &CommitContext,
        plan_token: &str,
        operation_id: &str,
        decisions: &[HealthRepairDecision],
    ) -> StorageResult<HealthRepairApplyResult> {
        if decisions
            .iter()
            .any(|decision| decision.choice == HealthRepairChoice::Cancel)
        {
            return Ok(HealthRepairApplyResult {
                status: HealthRepairStatus::Cancelled,
                snapshot_id: None,
                commit_id: None,
                repaired_count: 0,
                already_committed: false,
                health: RecoveryVerifier::full_health_check(conn)?,
            });
        }

        let plan = Self::plan(conn)?;
        if plan.token != plan_token {
            return Err(StorageError::Validation(
                "health repair plan is stale; run health repair planning again".to_string(),
            ));
        }
        if plan.is_empty() {
            return Ok(HealthRepairApplyResult {
                status: HealthRepairStatus::NoChanges,
                snapshot_id: None,
                commit_id: None,
                repaired_count: 0,
                already_committed: false,
                health: RecoveryVerifier::full_health_check(conn)?,
            });
        }
        if !plan.blockers.is_empty() {
            return Err(StorageError::ConstraintViolation(format!(
                "health repair is blocked by {} non-tombstone integrity issue(s)",
                plan.blockers.len()
            )));
        }

        let decisions = validate_decisions(&plan, decisions)?;
        let current_candidates = scan_candidates(conn)?;
        let changed_objects = changed_objects(&current_candidates, &decisions);
        let operation = CommitOperation::new(
            operation_id,
            "health-repair",
            "main",
            "change",
            "multi",
            changed_objects,
        )
        .with_message("Repair MDBX health metadata")
        .with_intent_hash(repair_intent_hash(plan_token, &decisions)?);

        if operation_already_exists(conn, operation_id)? {
            let execution: OperationExecution<()> = ctx.run_operation(conn, operation, |_| {
                Err(StorageError::Validation(
                    "existing health repair operation unexpectedly requested execution".to_string(),
                ))
            })?;
            let commit_id = match execution {
                OperationExecution::AlreadyCommitted { commit_id } => commit_id,
                OperationExecution::Applied { .. } => {
                    return Err(StorageError::Validation(
                        "existing health repair operation was not recognized".to_string(),
                    ));
                }
            };
            return Ok(HealthRepairApplyResult {
                status: HealthRepairStatus::Applied,
                snapshot_id: None,
                commit_id: Some(commit_id),
                repaired_count: (plan.automatic_items.len() + plan.conflict_items.len()) as u32,
                already_committed: true,
                health: RecoveryVerifier::full_health_check(conn)?,
            });
        }

        let snapshot = SnapshotRepo::create_snapshot(conn, ctx)?;
        let execution = ctx.run_operation(conn, operation, |scoped| {
            let current_plan = Self::plan(conn)?;
            if current_plan.token != plan_token {
                return Err(StorageError::Validation(
                    "health repair plan changed before execution".to_string(),
                ));
            }
            let candidates = scan_candidates(conn)?;
            let object_ids = candidates
                .iter()
                .map(|candidate| candidate.item.object_id.clone())
                .collect::<Vec<_>>();
            scoped.create_commit(conn, "change", "multi", &object_ids, &[])?;
            for candidate in &candidates {
                apply_candidate(
                    conn,
                    scoped,
                    candidate,
                    decisions.get(&candidate.item.repair_id),
                )?;
            }
            Ok(candidates.len() as u32)
        })?;
        let (commit_id, repaired_count, already_committed) = match execution {
            OperationExecution::Applied { value, commit_id } => (commit_id, value, false),
            OperationExecution::AlreadyCommitted { commit_id } => (
                commit_id,
                (plan.automatic_items.len() + plan.conflict_items.len()) as u32,
                true,
            ),
        };
        Ok(HealthRepairApplyResult {
            status: HealthRepairStatus::Applied,
            snapshot_id: Some(snapshot.snapshot_id),
            commit_id: Some(commit_id),
            repaired_count,
            already_committed,
            health: RecoveryVerifier::full_health_check(conn)?,
        })
    }
}

fn scan_candidates(conn: &VaultConnection) -> StorageResult<Vec<CandidateState>> {
    let mut tombstones = BTreeMap::<(String, String), Vec<TombstoneState>>::new();
    let mut tombstone_stmt = conn.inner().prepare(
        "SELECT tombstone_id, target_object_type, target_object_id, delete_clock,
                deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id
         FROM tombstones
         WHERE target_object_type IN
            ('project', 'entry', 'attachment', 'object-relation',
             'object-label', 'object-label-assignment')
         ORDER BY target_object_type, target_object_id, deleted_at DESC, tombstone_id DESC",
    )?;
    let tombstone_rows = tombstone_stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            TombstoneState {
                tombstone_id: row.get(0)?,
                delete_clock: row.get(3)?,
                deleted_by_device_id: row.get(4)?,
                deleted_at: row.get(5)?,
                purge_eligible_at: row.get(6)?,
                delete_commit_id: row.get(7)?,
            },
        ))
    })?;
    for row in tombstone_rows {
        let (object_type, object_id, tombstone) = row?;
        tombstones
            .entry((object_type, object_id))
            .or_default()
            .push(tombstone);
    }

    let mut object_stmt = conn.inner().prepare(SUPPORTED_OBJECT_STATES_SQL)?;
    let object_rows = object_stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i32>(2)? != 0,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut candidates = Vec::new();
    for row in object_rows {
        let (object_type, object_id, deleted, head_commit_id) = row?;
        let object_tombstones = tombstones
            .remove(&(object_type.clone(), object_id.clone()))
            .unwrap_or_default();
        let kind = if deleted && object_tombstones.is_empty() {
            Some(HealthRepairItemKind::MissingTombstone)
        } else if deleted && object_tombstones.len() > 1 {
            Some(HealthRepairItemKind::DuplicateTombstones)
        } else if !deleted
            && !object_tombstones.is_empty()
            && !has_unresolved_deletion_conflict(conn, &object_type, &object_id)?
        {
            Some(HealthRepairItemKind::ActiveObjectTombstoneConflict)
        } else {
            None
        };
        if let Some(kind) = kind {
            let tombstone_count = u32::try_from(object_tombstones.len()).map_err(|_| {
                StorageError::Validation("tombstone count exceeds supported range".to_string())
            })?;
            candidates.push(CandidateState {
                item: HealthRepairItem {
                    repair_id: repair_id(kind, &object_type, &object_id),
                    kind,
                    object_type,
                    object_id,
                    tombstone_count,
                },
                deleted,
                head_commit_id,
                tombstones: object_tombstones,
            });
        }
    }
    candidates.sort_by(|left, right| left.item.repair_id.cmp(&right.item.repair_id));
    Ok(candidates)
}

fn validate_decisions(
    plan: &HealthRepairPlan,
    decisions: &[HealthRepairDecision],
) -> StorageResult<BTreeMap<String, HealthRepairChoice>> {
    let conflict_ids = plan
        .conflict_items
        .iter()
        .map(|item| item.repair_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut resolved = BTreeMap::new();
    for decision in decisions {
        if !conflict_ids.contains(decision.repair_id.as_str()) {
            return Err(StorageError::Validation(format!(
                "unknown health repair conflict {}",
                decision.repair_id
            )));
        }
        if decision.choice == HealthRepairChoice::Cancel {
            return Err(StorageError::Validation(
                "cancel decisions must be handled before validation".to_string(),
            ));
        }
        if resolved
            .insert(decision.repair_id.clone(), decision.choice)
            .is_some()
        {
            return Err(StorageError::Validation(format!(
                "duplicate health repair decision {}",
                decision.repair_id
            )));
        }
    }
    for conflict_id in conflict_ids {
        if !resolved.contains_key(conflict_id) {
            return Err(StorageError::Validation(format!(
                "health repair conflict {conflict_id} requires a decision"
            )));
        }
    }
    Ok(resolved)
}

fn changed_objects(
    candidates: &[CandidateState],
    decisions: &BTreeMap<String, HealthRepairChoice>,
) -> Vec<CommitChange> {
    candidates
        .iter()
        .map(|candidate| CommitChange {
            object_type: candidate.item.object_type.clone(),
            object_id: candidate.item.object_id.clone(),
            action: match decisions.get(&candidate.item.repair_id) {
                Some(HealthRepairChoice::DeleteObject) => "delete",
                _ => "repair",
            }
            .to_string(),
            fields: vec!["tombstone".to_string()],
        })
        .collect()
}

fn apply_candidate(
    conn: &VaultConnection,
    ctx: &CommitContext,
    candidate: &CandidateState,
    decision: Option<&HealthRepairChoice>,
) -> StorageResult<()> {
    match candidate.item.kind {
        HealthRepairItemKind::MissingTombstone => ctx
            .create_tombstone_for_commit(
                conn,
                &candidate.item.object_type,
                &candidate.item.object_id,
                &candidate.head_commit_id,
            )
            .map(|_| ()),
        HealthRepairItemKind::DuplicateTombstones => normalize_tombstones(
            conn,
            ctx,
            &candidate.item.object_type,
            &candidate.item.object_id,
            &candidate.head_commit_id,
        ),
        HealthRepairItemKind::ActiveObjectTombstoneConflict => match decision {
            Some(HealthRepairChoice::KeepContent) => {
                clear_tombstones(conn, &candidate.item.object_type, &candidate.item.object_id)
            }
            Some(HealthRepairChoice::DeleteObject) => {
                soft_delete_object(
                    conn,
                    ctx,
                    &candidate.item.object_type,
                    &candidate.item.object_id,
                )?;
                let head_commit_id = object_head_commit(
                    conn,
                    &candidate.item.object_type,
                    &candidate.item.object_id,
                )?;
                normalize_tombstones(
                    conn,
                    ctx,
                    &candidate.item.object_type,
                    &candidate.item.object_id,
                    &head_commit_id,
                )
            }
            Some(HealthRepairChoice::Cancel) => Err(StorageError::Validation(
                "cancelled health repair reached mutation stage".to_string(),
            )),
            None => Err(StorageError::Validation(format!(
                "missing decision for health repair conflict {}",
                candidate.item.repair_id
            ))),
        },
    }
}

fn normalize_tombstones(
    conn: &VaultConnection,
    ctx: &CommitContext,
    object_type: &str,
    object_id: &str,
    delete_commit_id: &str,
) -> StorageResult<()> {
    let canonical_id = conn
        .inner()
        .query_row(
            "SELECT tombstone_id FROM tombstones
             WHERE target_object_type = ?1 AND target_object_id = ?2
             ORDER BY CASE WHEN delete_commit_id = ?3 THEN 0 ELSE 1 END,
                      deleted_at DESC, tombstone_id DESC
             LIMIT 1",
            params![object_type, object_id, delete_commit_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StorageError::NotFound(format!("{object_type}:{object_id}")))?;
    let delete_clock = conn
        .inner()
        .query_row(
            "SELECT vector_clock FROM commits WHERE commit_id = ?1",
            params![delete_commit_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| StorageError::NotFound(delete_commit_id.to_string()))?;
    conn.inner().execute(
        "UPDATE tombstones SET delete_commit_id = ?2, delete_clock = ?3
         WHERE tombstone_id = ?1",
        params![canonical_id, delete_commit_id, delete_clock],
    )?;
    conn.inner().execute(
        "DELETE FROM tombstones
         WHERE target_object_type = ?1 AND target_object_id = ?2 AND tombstone_id <> ?3",
        params![object_type, object_id, canonical_id],
    )?;
    TombstoneAcknowledgementRepo::merge(
        conn,
        &canonical_id,
        &ctx.device_id,
        delete_commit_id,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    Ok(())
}

fn clear_tombstones(
    conn: &VaultConnection,
    object_type: &str,
    object_id: &str,
) -> StorageResult<()> {
    conn.inner().execute(
        "DELETE FROM tombstones WHERE target_object_type = ?1 AND target_object_id = ?2",
        params![object_type, object_id],
    )?;
    Ok(())
}

fn soft_delete_object(
    conn: &VaultConnection,
    ctx: &CommitContext,
    object_type: &str,
    object_id: &str,
) -> StorageResult<()> {
    match object_type {
        "project" => ProjectRepo::soft_delete(conn, ctx, object_id),
        "entry" => EntryRepo::soft_delete(conn, ctx, object_id),
        "attachment" => AttachmentRepo::soft_delete(conn, ctx, object_id),
        "object-relation" => ObjectRelationRepo::soft_delete(conn, ctx, object_id),
        "object-label" => ObjectLabelRepo::soft_delete(conn, ctx, object_id),
        "object-label-assignment" => ObjectLabelAssignmentRepo::soft_delete(conn, ctx, object_id),
        unsupported => Err(StorageError::Validation(format!(
            "unsupported health repair object type {unsupported}"
        ))),
    }
}

fn object_head_commit(
    conn: &VaultConnection,
    object_type: &str,
    object_id: &str,
) -> StorageResult<String> {
    let (table, id_column) = match object_type {
        "project" => ("projects", "project_id"),
        "entry" => ("entries", "entry_id"),
        "attachment" => ("attachments", "attachment_id"),
        "object-relation" => ("object_relations", "relation_id"),
        "object-label" => ("object_labels", "label_id"),
        "object-label-assignment" => ("object_label_assignments", "assignment_id"),
        unsupported => {
            return Err(StorageError::Validation(format!(
                "unsupported health repair object type {unsupported}"
            )))
        }
    };
    conn.inner()
        .query_row(
            &format!("SELECT head_commit_id FROM {table} WHERE {id_column} = ?1"),
            params![object_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StorageError::NotFound(object_id.to_string()))
}

fn has_unresolved_deletion_conflict(
    conn: &VaultConnection,
    object_type: &str,
    object_id: &str,
) -> StorageResult<bool> {
    let mut stmt = conn.inner().prepare(
        "SELECT conflicting_fields FROM conflicts
         WHERE object_type = ?1 AND object_id = ?2 AND resolution = 'unresolved'",
    )?;
    let fields = stmt
        .query_map(params![object_type, object_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(fields.iter().any(|encoded| {
        serde_json::from_str::<Vec<String>>(encoded)
            .map(|values| values.iter().any(|value| value == "deleted"))
            .unwrap_or(false)
    }))
}

fn repair_id(kind: HealthRepairItemKind, object_type: &str, object_id: &str) -> String {
    format!("{}:{object_type}:{object_id}", kind.code())
}

fn repair_intent_hash(
    plan_token: &str,
    decisions: &BTreeMap<String, HealthRepairChoice>,
) -> StorageResult<Vec<u8>> {
    let encoded = serde_json::to_vec(&(plan_token, decisions))
        .map_err(|error| StorageError::Validation(error.to_string()))?;
    Ok(Sha256::digest(encoded).to_vec())
}

fn digest_json(value: &impl Serialize) -> StorageResult<String> {
    let encoded =
        serde_json::to_vec(value).map_err(|error| StorageError::Validation(error.to_string()))?;
    Ok(Sha256::digest(encoded)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn operation_already_exists(conn: &VaultConnection, operation_id: &str) -> StorageResult<bool> {
    conn.inner()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM commit_operations WHERE operation_id = ?1)",
            params![operation_id],
            |row| row.get(0),
        )
        .map_err(StorageError::Database)
}
