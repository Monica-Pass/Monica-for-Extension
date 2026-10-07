use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use uuid::Uuid;

use mdbx_core::model::attachment::{AttachmentChunk, StorageMode};
use mdbx_core::model::{
    Attachment, CollectionProfile, Entry, ObjectLabel, ObjectLabelAssignment, ObjectRelation,
    Project, Snapshot, SnapshotKind,
};
use mdbx_core::tiga::{AuthorizationDecision, TigaOperation, TigaScope};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::migration::SNAPSHOT_RECORD_AUTH_EXTENSION;
use crate::repo::commit_ctx::{CommitChange, CommitContext, CommitOperation};
use crate::repo::object_version::ObjectVersionRepo;
use crate::repo::snapshot_integrity::{self, SnapshotIntegrityInput};
use crate::repo::{
    CollectionProfileRepo, EntryRepo, ProjectRepo, SnapshotLifecycleRepo, SnapshotMetadataRepo,
    SnapshotSummaryRepo, TombstoneRepo,
};
use crate::sync_state::ProjectTagSetRow;
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

/// Snapshot 内部负载。
///
/// 解锁会话中会通过 metadata subkey 加密；未解锁/旧测试路径保留明文兼容。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SnapshotPayload {
    vault_id: String,
    format_version: String,
    snapshot_created_at: String,
    projects: Vec<Project>,
    #[serde(default)]
    collection_profiles: Option<Vec<CollectionProfile>>,
    entries: Vec<Entry>,
    #[serde(default)]
    object_relations: Option<Vec<ObjectRelation>>,
    #[serde(default)]
    object_labels: Option<Vec<ObjectLabel>>,
    #[serde(default)]
    object_label_assignments: Option<Vec<ObjectLabelAssignment>>,
    attachments: Vec<Attachment>,
    #[serde(default)]
    attachment_chunks: Option<Vec<AttachmentChunk>>,
    #[serde(default)]
    project_tags: Option<Vec<ProjectTagSetRow>>,
}

#[derive(Debug, Clone)]
pub(crate) struct SnapshotExternalBlobReference {
    pub attachment_id: String,
    pub chunk_index: u32,
    pub external_uri_ct: Vec<u8>,
    pub stored_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRestoreResult {
    pub commit_id: String,
    pub affected_object_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotDeleteResult {
    pub commit_id: String,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotStructureNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub node_type: String,
    pub path: String,
    pub status: String,
    pub child_count: usize,
    pub metadata: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotStructurePreview {
    pub snapshot_id: String,
    pub current_nodes: Vec<SnapshotStructureNode>,
    pub snapshot_nodes: Vec<SnapshotStructureNode>,
    pub current_item_count: usize,
    pub snapshot_item_count: usize,
}

const MAX_SNAPSHOT_STRUCTURE_NODES: usize = 10_000;

/// Snapshot 持久化仓库。
///
/// 负责创建和恢复检查点，捕获 projects / entries / attachments 元数据。
pub struct SnapshotRepo;

impl SnapshotRepo {
    // -----------------------------------------------------------------------
    // CREATE
    // -----------------------------------------------------------------------

    /// 创建 snapshot：捕获当前所有未删除对象的元数据。
    pub fn create_snapshot(conn: &VaultConnection, ctx: &CommitContext) -> StorageResult<Snapshot> {
        conn.with_immediate_transaction(|| Self::create_snapshot_inner(conn, ctx))
    }

    /// Create a snapshot and attach authenticated lifecycle metadata in the
    /// same SQLite transaction. The legacy create_snapshot API remains
    /// unchanged and creates a protected manual snapshot without a companion
    /// row.
    pub fn create_snapshot_with_lifecycle(
        conn: &VaultConnection,
        ctx: &CommitContext,
        kind: SnapshotKind,
        retention_eligible_at: Option<&str>,
    ) -> StorageResult<Snapshot> {
        conn.with_immediate_transaction(|| {
            let snapshot = Self::create_snapshot_inner(conn, ctx)?;
            SnapshotLifecycleRepo::register_from_snapshot_in_transaction(
                conn,
                &snapshot,
                kind,
                retention_eligible_at,
            )?;
            Ok(snapshot)
        })
    }

    pub fn create_automatic_snapshot(
        conn: &VaultConnection,
        ctx: &CommitContext,
        retention_eligible_at: &str,
    ) -> StorageResult<Snapshot> {
        Self::create_snapshot_with_lifecycle(
            conn,
            ctx,
            SnapshotKind::Automatic,
            Some(retention_eligible_at),
        )
    }

    pub fn create_automatic_snapshot_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        retention_eligible_at: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(Snapshot, AuthorizationDecision)> {
        let (snapshot, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::CreateSnapshot,
            context,
            || {
                let snapshot = Self::create_automatic_snapshot(conn, ctx, retention_eligible_at)?;
                let commit_id = snapshot.base_commit_id.clone();
                Ok((snapshot, commit_id))
            },
        )?;
        Ok((snapshot, decision))
    }

    pub fn create_manual_snapshot_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        display_name: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(Snapshot, AuthorizationDecision)> {
        let (snapshot, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::CreateSnapshot,
            context,
            || {
                let snapshot = conn.with_immediate_transaction(|| {
                    let snapshot = Self::create_snapshot_inner(conn, ctx)?;
                    SnapshotLifecycleRepo::register_from_snapshot_in_transaction(
                        conn,
                        &snapshot,
                        SnapshotKind::Manual,
                        None,
                    )?;
                    let fallback = format!("Snapshot {}", snapshot.created_at);
                    SnapshotMetadataRepo::register_from_snapshot_in_transaction(
                        conn,
                        &snapshot,
                        if display_name.trim().is_empty() {
                            &fallback
                        } else {
                            display_name
                        },
                    )?;
                    Ok(snapshot)
                })?;
                let commit_id = snapshot.base_commit_id.clone();
                Ok((snapshot, commit_id))
            },
        )?;
        Ok((snapshot, decision))
    }

    fn create_snapshot_inner(
        conn: &VaultConnection,
        ctx: &CommitContext,
    ) -> StorageResult<Snapshot> {
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot_id = Uuid::new_v4().to_string();

        let (vault_id, format_version): (String, String) = conn
            .inner()
            .query_row(
                "SELECT vault_id, format_version FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(StorageError::Database)?;

        let payload = SnapshotPayload {
            vault_id,
            format_version,
            snapshot_created_at: now.clone(),
            projects: read_all_active_projects(conn)?,
            collection_profiles: Some(CollectionProfileRepo::list_active(conn)?),
            entries: read_all_active_entries(conn)?,
            object_relations: Some(read_all_active_object_relations(conn)?),
            object_labels: Some(read_all_active_object_labels(conn)?),
            object_label_assignments: Some(read_all_active_object_label_assignments(conn)?),
            attachments: read_all_active_attachments(conn)?,
            attachment_chunks: Some(read_all_active_attachment_chunks(conn)?),
            project_tags: Some(read_all_active_project_tags(conn)?),
        };

        let snapshot_json = serde_json::to_vec(&payload)
            .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
        let snapshot_ct = Self::encrypt_payload(conn, &snapshot_id, &snapshot_json)?;
        let commit_id =
            ctx.create_commit(conn, "snapshot", "multi", &[snapshot_id.clone()], &[])?;
        let snapshot_hash = snapshot_integrity::issue_descriptor(
            conn,
            &SnapshotIntegrityInput {
                snapshot_id: &snapshot_id,
                base_commit_id: &commit_id,
                snapshot_ct: &snapshot_ct,
                created_at: &now,
                created_by_device_id: &ctx.device_id,
            },
        )?;
        conn.inner().execute(
            "INSERT INTO snapshots (snapshot_id, base_commit_id, snapshot_ct,
             snapshot_hash, created_at, created_by_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                snapshot_id,
                commit_id,
                snapshot_ct,
                snapshot_hash,
                now,
                ctx.device_id,
            ],
        )?;
        Ok(Snapshot {
            snapshot_id,
            base_commit_id: commit_id,
            snapshot_ct,
            snapshot_hash,
            created_at: now,
            created_by_device_id: ctx.device_id.clone(),
        })
    }

    // -----------------------------------------------------------------------
    // RESTORE
    // -----------------------------------------------------------------------

    /// 从 snapshot 恢复 projects / entries / attachments 元数据。
    ///
    /// 每个对象使用 INSERT OR REPLACE，保持原始 ID 不变。
    /// 恢复完成后创建一个 "snapshot" 类型的 commit。
    pub fn restore_snapshot_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        snapshot_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<AuthorizationDecision> {
        let (_, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::RestoreSnapshot,
            context,
            || Self::restore_snapshot(conn, ctx, snapshot_id).map(|commit_id| ((), commit_id)),
        )?;
        Ok(decision)
    }

    pub fn restore_snapshot_with_result_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        snapshot_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(SnapshotRestoreResult, AuthorizationDecision)> {
        let (result, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::RestoreSnapshot,
            context,
            || {
                let result = Self::restore_snapshot_with_result(conn, ctx, snapshot_id)?;
                let commit_id = result.commit_id.clone();
                Ok((result, commit_id))
            },
        )?;
        Ok((result, decision))
    }

    pub(crate) fn restore_snapshot(
        conn: &VaultConnection,
        ctx: &CommitContext,
        snapshot_id: &str,
    ) -> StorageResult<String> {
        Self::restore_snapshot_with_result(conn, ctx, snapshot_id).map(|result| result.commit_id)
    }

    fn restore_snapshot_with_result(
        conn: &VaultConnection,
        ctx: &CommitContext,
        snapshot_id: &str,
    ) -> StorageResult<SnapshotRestoreResult> {
        let snap = SnapshotRepo::get_by_id(conn, snapshot_id)?
            .ok_or_else(|| StorageError::NotFound(snapshot_id.to_string()))?;

        if !snapshot_integrity::verify_descriptor(
            conn,
            &SnapshotIntegrityInput {
                snapshot_id: &snap.snapshot_id,
                base_commit_id: &snap.base_commit_id,
                snapshot_ct: &snap.snapshot_ct,
                created_at: &snap.created_at,
                created_by_device_id: &snap.created_by_device_id,
            },
            &snap.snapshot_hash,
        )? {
            return Err(StorageError::ConstraintViolation(
                "snapshot integrity descriptor mismatch".to_string(),
            ));
        }

        let snapshot_json = Self::decrypt_payload(conn, snapshot_id, &snap.snapshot_ct)?;
        let payload: SnapshotPayload = serde_json::from_slice(&snapshot_json)
            .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;

        conn.with_immediate_transaction(|| {
            let now = chrono::Utc::now().to_rfc3339();
            let active_projects = active_ids(conn, "projects", "project_id")?;
            let active_entries = active_ids(conn, "entries", "entry_id")?;
            let active_attachments = active_ids(conn, "attachments", "attachment_id")?;
            let active_relations = active_ids(conn, "object_relations", "relation_id")?;
            let active_labels = active_ids(conn, "object_labels", "label_id")?;
            let active_assignments = active_ids(conn, "object_label_assignments", "assignment_id")?;

            let snapshot_projects = id_set(payload.projects.iter().map(|p| p.project_id.as_str()));
            let snapshot_entries = id_set(payload.entries.iter().map(|e| e.entry_id.as_str()));
            let snapshot_attachments =
                id_set(payload.attachments.iter().map(|a| a.attachment_id.as_str()));
            let snapshot_relations = payload
                .object_relations
                .as_deref()
                .map(|rows| id_set(rows.iter().map(|row| row.relation_id.as_str())))
                .unwrap_or_default();
            let snapshot_labels = payload
                .object_labels
                .as_deref()
                .map(|rows| id_set(rows.iter().map(|row| row.label_id.as_str())))
                .unwrap_or_default();
            let snapshot_assignments = payload
                .object_label_assignments
                .as_deref()
                .map(|rows| id_set(rows.iter().map(|row| row.assignment_id.as_str())))
                .unwrap_or_default();

            let removed_projects = difference(&active_projects, &snapshot_projects);
            let removed_entries = difference(&active_entries, &snapshot_entries);
            let removed_attachments = difference(&active_attachments, &snapshot_attachments);
            let removed_relations = payload
                .object_relations
                .as_ref()
                .map(|_| difference(&active_relations, &snapshot_relations))
                .unwrap_or_default();
            let removed_labels = payload
                .object_labels
                .as_ref()
                .map(|_| difference(&active_labels, &snapshot_labels))
                .unwrap_or_default();
            let removed_assignments = payload
                .object_label_assignments
                .as_ref()
                .map(|_| difference(&active_assignments, &snapshot_assignments))
                .unwrap_or_default();

            let mut changed_ids = vec![snapshot_id.to_string()];
            changed_ids.extend(snapshot_projects.iter().cloned());
            changed_ids.extend(snapshot_entries.iter().cloned());
            changed_ids.extend(snapshot_attachments.iter().cloned());
            changed_ids.extend(snapshot_relations.iter().cloned());
            changed_ids.extend(snapshot_labels.iter().cloned());
            changed_ids.extend(snapshot_assignments.iter().cloned());
            changed_ids.extend(removed_projects.iter().cloned());
            changed_ids.extend(removed_entries.iter().cloned());
            changed_ids.extend(removed_attachments.iter().cloned());
            changed_ids.extend(removed_relations.iter().cloned());
            changed_ids.extend(removed_labels.iter().cloned());
            changed_ids.extend(removed_assignments.iter().cloned());
            changed_ids.sort();
            changed_ids.dedup();
            let affected_object_count = changed_ids.len().saturating_sub(1);

            let restore_commit_id = ctx.create_commit(
                conn,
                "snapshot",
                "multi",
                &changed_ids,
                &[snap.base_commit_id.clone()],
            )?;

            let snapshot_profiles = payload
                .collection_profiles
                .as_ref()
                .map(|profiles| {
                    profiles
                        .iter()
                        .map(|profile| (profile.collection_id.as_str(), profile))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            if payload
                .collection_profiles
                .as_ref()
                .is_some_and(|profiles| profiles.len() != snapshot_profiles.len())
            {
                return Err(StorageError::Validation(
                    "snapshot contains duplicate collection profiles".to_string(),
                ));
            }
            if snapshot_profiles
                .keys()
                .any(|collection_id| !snapshot_projects.contains(*collection_id))
            {
                return Err(StorageError::Validation(
                    "snapshot contains a profile for an unavailable collection".to_string(),
                ));
            }

            // Restore in dependency order, but give every row a new causal head.
            for project in &payload.projects {
                if upsert_project(conn, project, &restore_commit_id, &now, &ctx.device_id)? {
                    if let Some(profile) = snapshot_profiles.get(project.project_id.as_str()) {
                        CollectionProfileRepo::restore_profile(
                            conn,
                            profile,
                            &now,
                            &ctx.device_id,
                        )?;
                    }
                    ObjectVersionRepo::record_project_current(
                        conn,
                        &restore_commit_id,
                        &project.project_id,
                    )?;
                }
            }
            for entry in &payload.entries {
                if upsert_entry(conn, entry, &restore_commit_id, &now, &ctx.device_id)? {
                    ObjectVersionRepo::record_entry_current(
                        conn,
                        &restore_commit_id,
                        &entry.entry_id,
                    )?;
                }
            }
            if let Some(labels) = &payload.object_labels {
                for label in labels {
                    if upsert_object_label(conn, label, &restore_commit_id, &now, &ctx.device_id)? {
                        ObjectVersionRepo::record_object_label_current(
                            conn,
                            &restore_commit_id,
                            &label.label_id,
                        )?;
                    }
                }
            }
            if let Some(relations) = &payload.object_relations {
                for relation in relations {
                    if upsert_object_relation(
                        conn,
                        relation,
                        &restore_commit_id,
                        &now,
                        &ctx.device_id,
                    )? {
                        ObjectVersionRepo::record_object_relation_current(
                            conn,
                            &restore_commit_id,
                            &relation.relation_id,
                        )?;
                    }
                }
            }
            if let Some(assignments) = &payload.object_label_assignments {
                for assignment in assignments {
                    if upsert_object_label_assignment(
                        conn,
                        assignment,
                        &restore_commit_id,
                        &now,
                        &ctx.device_id,
                    )? {
                        ObjectVersionRepo::record_object_label_assignment_current(
                            conn,
                            &restore_commit_id,
                            &assignment.assignment_id,
                        )?;
                    }
                }
            }
            for attachment in &payload.attachments {
                if upsert_attachment(conn, attachment, &restore_commit_id, &now, &ctx.device_id)? {
                    ObjectVersionRepo::record_attachment_current(
                        conn,
                        &restore_commit_id,
                        &attachment.attachment_id,
                    )?;
                }
            }

            if let Some(chunks) = &payload.attachment_chunks {
                restore_attachment_chunks(conn, &snapshot_attachments, chunks)?;
            }
            if let Some(tag_sets) = &payload.project_tags {
                restore_project_tags(conn, &snapshot_projects, tag_sets)?;
            }

            // Objects created after the snapshot remain in history but leave the
            // active set through a tracked soft delete.
            soft_delete_for_restore(
                conn,
                ctx,
                "object-label-assignment",
                "object_label_assignments",
                "assignment_id",
                &removed_assignments,
                &restore_commit_id,
                &now,
            )?;
            soft_delete_for_restore(
                conn,
                ctx,
                "object-relation",
                "object_relations",
                "relation_id",
                &removed_relations,
                &restore_commit_id,
                &now,
            )?;
            soft_delete_for_restore(
                conn,
                ctx,
                "object-label",
                "object_labels",
                "label_id",
                &removed_labels,
                &restore_commit_id,
                &now,
            )?;
            soft_delete_for_restore(
                conn,
                ctx,
                "attachment",
                "attachments",
                "attachment_id",
                &removed_attachments,
                &restore_commit_id,
                &now,
            )?;
            soft_delete_for_restore(
                conn,
                ctx,
                "entry",
                "entries",
                "entry_id",
                &removed_entries,
                &restore_commit_id,
                &now,
            )?;
            soft_delete_for_restore(
                conn,
                ctx,
                "project",
                "projects",
                "project_id",
                &removed_projects,
                &restore_commit_id,
                &now,
            )?;

            for id in &removed_attachments {
                ObjectVersionRepo::record_attachment_current(conn, &restore_commit_id, id)?;
            }
            for id in &removed_relations {
                ObjectVersionRepo::record_object_relation_current(conn, &restore_commit_id, id)?;
            }
            for id in &removed_labels {
                ObjectVersionRepo::record_object_label_current(conn, &restore_commit_id, id)?;
            }
            for id in &removed_assignments {
                ObjectVersionRepo::record_object_label_assignment_current(
                    conn,
                    &restore_commit_id,
                    id,
                )?;
            }
            for id in &removed_entries {
                ObjectVersionRepo::record_entry_current(conn, &restore_commit_id, id)?;
            }
            for id in &removed_projects {
                ObjectVersionRepo::record_project_current(conn, &restore_commit_id, id)?;
            }

            Ok(SnapshotRestoreResult {
                commit_id: restore_commit_id,
                affected_object_count,
            })
        })
    }

    pub fn delete_snapshot_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        snapshot_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(SnapshotDeleteResult, AuthorizationDecision)> {
        let (result, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::ManageSnapshotRetention,
            context,
            || {
                SnapshotSummaryRepo::get(conn, snapshot_id)?
                    .ok_or_else(|| StorageError::NotFound(snapshot_id.to_string()))?;
                let operation = CommitOperation::new(
                    Uuid::new_v4().to_string(),
                    "delete-snapshot",
                    "main",
                    "change",
                    "snapshot",
                    vec![CommitChange {
                        object_type: "snapshot".to_string(),
                        object_id: snapshot_id.to_string(),
                        action: "delete".to_string(),
                        fields: vec!["snapshot".to_string(), "snapshot-metadata".to_string()],
                    }],
                )
                .with_message(format!("delete snapshot {snapshot_id}"));
                let commit_id = ctx.create_operation_commit(conn, &operation)?;
                SnapshotMetadataRepo::delete_in_transaction(conn, snapshot_id)?;
                let affected = conn.inner().execute(
                    "DELETE FROM snapshots WHERE snapshot_id = ?1",
                    params![snapshot_id],
                )?;
                if affected != 1 {
                    return Err(StorageError::NotFound(snapshot_id.to_string()));
                }
                Ok((
                    SnapshotDeleteResult {
                        commit_id: commit_id.clone(),
                        snapshot_id: snapshot_id.to_string(),
                    },
                    commit_id,
                ))
            },
        )?;
        Ok((result, decision))
    }

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    pub fn get_by_id(conn: &VaultConnection, snapshot_id: &str) -> StorageResult<Option<Snapshot>> {
        conn.inner()
            .query_row(
                "SELECT snapshot_id, base_commit_id, snapshot_ct, snapshot_hash,
                        created_at, created_by_device_id
                 FROM snapshots WHERE snapshot_id = ?1",
                params![snapshot_id],
                |row| {
                    Ok(Snapshot {
                        snapshot_id: row.get(0)?,
                        base_commit_id: row.get(1)?,
                        snapshot_ct: row.get(2)?,
                        snapshot_hash: row.get(3)?,
                        created_at: row.get(4)?,
                        created_by_device_id: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub fn list_all(conn: &VaultConnection) -> StorageResult<Vec<Snapshot>> {
        let mut stmt = conn.inner().prepare(
            "SELECT snapshot_id, base_commit_id, snapshot_ct, snapshot_hash,
                    created_at, created_by_device_id
             FROM snapshots ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(Snapshot {
                snapshot_id: row.get(0)?,
                base_commit_id: row.get(1)?,
                snapshot_ct: row.get(2)?,
                snapshot_hash: row.get(3)?,
                created_at: row.get(4)?,
                created_by_device_id: row.get(5)?,
            })
        })?;

        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(row?);
        }
        Ok(snapshots)
    }

    pub fn get_structure_preview(
        conn: &VaultConnection,
        snapshot_id: &str,
    ) -> StorageResult<SnapshotStructurePreview> {
        let snapshot = Self::get_by_id(conn, snapshot_id)?
            .ok_or_else(|| StorageError::NotFound(snapshot_id.to_string()))?;
        if !snapshot_integrity::verify_descriptor(
            conn,
            &SnapshotIntegrityInput {
                snapshot_id: &snapshot.snapshot_id,
                base_commit_id: &snapshot.base_commit_id,
                snapshot_ct: &snapshot.snapshot_ct,
                created_at: &snapshot.created_at,
                created_by_device_id: &snapshot.created_by_device_id,
            },
            &snapshot.snapshot_hash,
        )? {
            return Err(StorageError::ConstraintViolation(
                "snapshot integrity descriptor mismatch".to_string(),
            ));
        }
        let payload = Self::decrypt_payload(conn, snapshot_id, &snapshot.snapshot_ct)?;
        let payload: SnapshotPayload = serde_json::from_slice(&payload).map_err(|error| {
            StorageError::Validation(format!("invalid snapshot payload: {error}"))
        })?;
        build_structure_preview(
            conn,
            snapshot_id,
            read_all_active_projects(conn)?,
            read_all_active_entries(conn)?,
            payload.projects,
            payload.entries,
        )
    }

    /// 校验 snapshot 密文摘要、记录描述和解锁后的 payload 完整性。
    pub fn verify_integrity(conn: &VaultConnection, snapshot_id: &str) -> StorageResult<bool> {
        let snap = match SnapshotRepo::get_by_id(conn, snapshot_id)? {
            Some(s) => s,
            None => return Ok(false),
        };
        if !snapshot_integrity::verify_descriptor(
            conn,
            &SnapshotIntegrityInput {
                snapshot_id: &snap.snapshot_id,
                base_commit_id: &snap.base_commit_id,
                snapshot_ct: &snap.snapshot_ct,
                created_at: &snap.created_at,
                created_by_device_id: &snap.created_by_device_id,
            },
            &snap.snapshot_hash,
        )? {
            return Ok(false);
        }

        if conn.keyring().is_none() {
            return Ok(true);
        }

        let plaintext = match Self::decrypt_payload(conn, snapshot_id, &snap.snapshot_ct) {
            Ok(plaintext) => plaintext,
            Err(_) => return Ok(false),
        };
        Ok(serde_json::from_slice::<SnapshotPayload>(&plaintext).is_ok())
    }

    pub(crate) fn collect_external_blob_references(
        conn: &VaultConnection,
        max_snapshots: usize,
        max_snapshot_ciphertext_bytes: usize,
        max_references: usize,
    ) -> StorageResult<Vec<SnapshotExternalBlobReference>> {
        let mut stmt = conn.inner().prepare(
            "SELECT snapshot_id, base_commit_id, snapshot_ct, snapshot_hash,
                    created_at, created_by_device_id
             FROM snapshots ORDER BY snapshot_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut references = Vec::new();
        let mut snapshot_count = 0usize;
        for row in rows {
            snapshot_count = snapshot_count
                .checked_add(1)
                .ok_or_else(|| StorageError::Validation("snapshot count overflow".to_string()))?;
            if snapshot_count > max_snapshots {
                return Err(StorageError::Validation(format!(
                    "snapshot count exceeds the maintenance limit of {max_snapshots}"
                )));
            }
            let (
                snapshot_id,
                base_commit_id,
                snapshot_ct,
                snapshot_hash,
                created_at,
                created_by_device_id,
            ) = row?;
            if snapshot_ct.len() > max_snapshot_ciphertext_bytes {
                return Err(StorageError::Validation(format!(
                    "snapshot {snapshot_id} exceeds the {max_snapshot_ciphertext_bytes}-byte maintenance limit"
                )));
            }
            if !snapshot_integrity::verify_descriptor(
                conn,
                &SnapshotIntegrityInput {
                    snapshot_id: &snapshot_id,
                    base_commit_id: &base_commit_id,
                    snapshot_ct: &snapshot_ct,
                    created_at: &created_at,
                    created_by_device_id: &created_by_device_id,
                },
                &snapshot_hash,
            )? {
                return Err(StorageError::ConstraintViolation(format!(
                    "snapshot {snapshot_id} failed integrity verification"
                )));
            }
            let plaintext = Self::decrypt_payload(conn, &snapshot_id, &snapshot_ct)?;
            let payload: SnapshotPayload = serde_json::from_slice(&plaintext).map_err(|error| {
                StorageError::ConstraintViolation(format!(
                    "snapshot {snapshot_id} payload is invalid: {error}"
                ))
            })?;
            let modes: BTreeMap<_, _> = payload
                .attachments
                .iter()
                .map(|attachment| (attachment.attachment_id.as_str(), &attachment.storage_mode))
                .collect();
            for chunk in payload.attachment_chunks.unwrap_or_default() {
                let mode = modes.get(chunk.attachment_id.as_str()).ok_or_else(|| {
                    StorageError::ConstraintViolation(format!(
                        "snapshot {snapshot_id} chunk references a missing attachment {}",
                        chunk.attachment_id
                    ))
                })?;
                match (*mode, chunk.chunk_ct, chunk.external_uri_ct) {
                    (StorageMode::ExternalHashRef, None, Some(external_uri_ct)) => {
                        if references.len() >= max_references {
                            return Err(StorageError::Validation(format!(
                                "snapshot external reference count exceeds the maintenance limit of {max_references}"
                            )));
                        }
                        references.push(SnapshotExternalBlobReference {
                            attachment_id: chunk.attachment_id,
                            chunk_index: chunk.chunk_index,
                            external_uri_ct,
                            stored_size: chunk.stored_size,
                        });
                    }
                    (StorageMode::ExternalHashRef, _, _) => {
                        return Err(StorageError::ConstraintViolation(format!(
                            "snapshot {snapshot_id} external chunk has invalid storage columns"
                        )))
                    }
                    (StorageMode::EmbeddedInline | StorageMode::EmbeddedChunked, Some(_), None) => {
                    }
                    (StorageMode::EmbeddedInline | StorageMode::EmbeddedChunked, _, _) => {
                        return Err(StorageError::ConstraintViolation(format!(
                            "snapshot {snapshot_id} embedded chunk has invalid storage columns"
                        )))
                    }
                }
            }
        }
        Ok(references)
    }

    // -----------------------------------------------------------------------
    // ENCRYPTION HELPERS
    // -----------------------------------------------------------------------

    fn encrypt_payload(
        conn: &VaultConnection,
        id: &str,
        plaintext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        let unlocked = conn.keyring().is_some();
        if !unlocked && snapshot_auth_extension_enabled(conn)? {
            return Err(StorageError::Validation(
                "snapshot-record-auth-v1 requires an unlocked keyring for snapshot creation"
                    .to_string(),
            ));
        }
        if unlocked {
            conn.ensure_critical_extension(SNAPSHOT_RECORD_AUTH_EXTENSION)?;
        }
        let ciphertext = encrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            plaintext,
            "snapshot",
            id,
            if unlocked { "payload-v2" } else { "payload" },
        )?;
        if unlocked {
            Ok(snapshot_integrity::wrap_authenticated_ciphertext(
                ciphertext,
            ))
        } else {
            Ok(ciphertext)
        }
    }

    fn decrypt_payload(
        conn: &VaultConnection,
        id: &str,
        ciphertext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        let (ciphertext, field_name) =
            match snapshot_integrity::authenticated_ciphertext_inner(ciphertext) {
                Some(inner) => {
                    if conn.keyring().is_none() {
                        return Err(StorageError::Validation(
                            "authenticated snapshot payload requires an unlocked keyring"
                                .to_string(),
                        ));
                    }
                    (inner, "payload-v2")
                }
                None => (ciphertext, "payload"),
            };
        decrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            ciphertext,
            "snapshot",
            id,
            field_name,
        )
    }
}

fn snapshot_auth_extension_enabled(conn: &VaultConnection) -> StorageResult<bool> {
    let value: String = conn
        .inner()
        .query_row(
            "SELECT critical_extensions FROM vault_meta LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::Database)?;
    if value.trim().is_empty() || value.trim() == "[]" {
        return Ok(false);
    }
    let extensions = serde_json::from_str::<Vec<String>>(&value).map_err(|error| {
        StorageError::Validation(format!("critical extensions are invalid: {error}"))
    })?;
    Ok(extensions
        .iter()
        .any(|extension| extension == SNAPSHOT_RECORD_AUTH_EXTENSION))
}

#[derive(Debug, Clone)]
struct RawStructureNode {
    key: String,
    id: String,
    parent_id: Option<String>,
    name: String,
    node_type: String,
    path: String,
    signature: Vec<u8>,
    child_count: usize,
    metadata: String,
}

fn build_structure_preview(
    conn: &VaultConnection,
    snapshot_id: &str,
    current_projects: Vec<Project>,
    current_entries: Vec<Entry>,
    snapshot_projects: Vec<Project>,
    snapshot_entries: Vec<Entry>,
) -> StorageResult<SnapshotStructurePreview> {
    let total_nodes = current_projects
        .len()
        .saturating_add(current_entries.len())
        .saturating_add(snapshot_projects.len())
        .saturating_add(snapshot_entries.len());
    if total_nodes > MAX_SNAPSHOT_STRUCTURE_NODES {
        return Err(StorageError::ResourceLimit {
            resource: "snapshot structure nodes".to_string(),
            actual: total_nodes as u64,
            limit: MAX_SNAPSHOT_STRUCTURE_NODES as u64,
        });
    }

    let current = raw_structure_nodes(conn, &current_projects, &current_entries)?;
    let snapshot = raw_structure_nodes(conn, &snapshot_projects, &snapshot_entries)?;
    Ok(SnapshotStructurePreview {
        snapshot_id: snapshot_id.to_string(),
        current_nodes: materialize_structure_nodes(&current, &snapshot, true),
        snapshot_nodes: materialize_structure_nodes(&snapshot, &current, false),
        current_item_count: current_entries.len(),
        snapshot_item_count: snapshot_entries.len(),
    })
}

fn raw_structure_nodes(
    conn: &VaultConnection,
    projects: &[Project],
    entries: &[Entry],
) -> StorageResult<BTreeMap<String, RawStructureNode>> {
    let mut project_names = BTreeMap::new();
    let mut child_counts = BTreeMap::<String, usize>::new();
    for entry in entries {
        *child_counts.entry(entry.project_id.clone()).or_default() += 1;
    }
    for project in projects {
        let title =
            ProjectRepo::decrypt_metadata(conn, &project.project_id, "title", &project.title_ct)?;
        project_names.insert(project.project_id.clone(), decode_snapshot_text(title)?);
    }

    let mut nodes = BTreeMap::new();
    for project in projects {
        let name = project_names
            .get(&project.project_id)
            .cloned()
            .unwrap_or_else(|| project.project_id.chars().take(8).collect());
        let child_count = child_counts.get(&project.project_id).copied().unwrap_or(0);
        let key = format!("folder:{}", project.project_id);
        nodes.insert(
            key.clone(),
            RawStructureNode {
                key,
                id: project.project_id.clone(),
                parent_id: project.group_id.clone(),
                name: name.clone(),
                node_type: "folder".to_string(),
                path: name,
                signature: structure_signature(project)?,
                child_count,
                metadata: format!("{child_count} items"),
            },
        );
    }
    for entry in entries {
        let name = entry
            .title_ct
            .as_deref()
            .map(|title| EntryRepo::decrypt_metadata(conn, &entry.entry_id, "title", title))
            .transpose()?
            .map(decode_snapshot_text)
            .transpose()?
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| entry.entry_type.to_string());
        let parent_name = project_names
            .get(&entry.project_id)
            .cloned()
            .unwrap_or_else(|| entry.project_id.chars().take(8).collect());
        let key = format!("entry:{}", entry.entry_id);
        nodes.insert(
            key.clone(),
            RawStructureNode {
                key,
                id: entry.entry_id.clone(),
                parent_id: Some(entry.project_id.clone()),
                name: name.clone(),
                node_type: "entry".to_string(),
                path: format!("{parent_name}/{name}"),
                signature: structure_signature(entry)?,
                child_count: 0,
                metadata: entry.entry_type.to_string(),
            },
        );
    }
    Ok(nodes)
}

fn materialize_structure_nodes(
    source: &BTreeMap<String, RawStructureNode>,
    compare: &BTreeMap<String, RawStructureNode>,
    current_side: bool,
) -> Vec<SnapshotStructureNode> {
    let mut nodes = source
        .values()
        .map(|node| {
            let status = match compare.get(&node.key) {
                None if current_side => "added",
                None => "removed",
                Some(other) if other.signature == node.signature => "unchanged",
                Some(_) => "modified",
            };
            SnapshotStructureNode {
                id: node.id.clone(),
                parent_id: node.parent_id.clone(),
                name: node.name.clone(),
                node_type: node.node_type.clone(),
                path: node.path.clone(),
                status: status.to_string(),
                child_count: node.child_count,
                metadata: node.metadata.clone(),
            }
        })
        .collect::<Vec<_>>();
    nodes.sort_by(|left, right| {
        left.node_type
            .cmp(&right.node_type)
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
            .then_with(|| left.id.cmp(&right.id))
    });
    nodes
}

fn structure_signature(value: &impl Serialize) -> StorageResult<Vec<u8>> {
    let serialized = serde_json::to_vec(value).map_err(|error| {
        StorageError::Validation(format!("snapshot structure serialization failed: {error}"))
    })?;
    Ok(Sha256::digest(serialized).to_vec())
}

fn decode_snapshot_text(value: Vec<u8>) -> StorageResult<String> {
    String::from_utf8(value).map_err(|error| {
        StorageError::Validation(format!("snapshot structure text is not UTF-8: {error}"))
    })
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

fn read_all_active_projects(conn: &VaultConnection) -> StorageResult<Vec<Project>> {
    let mut stmt = conn.inner().prepare(
        "SELECT project_id, title_ct, summary_ct, group_id, icon_ref,
                favorite, archived, deleted, tiga_mode_override, object_clock,
                head_commit_id, attachment_count, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM projects WHERE deleted = 0 ORDER BY updated_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Project {
            project_id: row.get(0)?,
            title_ct: row.get::<_, Vec<u8>>(1)?,
            summary_ct: row.get::<_, Option<Vec<u8>>>(2)?,
            group_id: row.get(3)?,
            icon_ref: row.get(4)?,
            favorite: row.get::<_, i32>(5)? != 0,
            archived: row.get::<_, i32>(6)? != 0,
            deleted: row.get::<_, i32>(7)? != 0,
            tiga_mode_override: row
                .get::<_, Option<String>>(8)?
                .and_then(|s| s.parse().ok()),
            object_clock: row.get(9)?,
            head_commit_id: row.get(10)?,
            attachment_count: row.get::<_, i32>(11)? as u32,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
            created_by_device_id: row.get(14)?,
            updated_by_device_id: row.get(15)?,
        })
    })?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row?);
    }
    Ok(projects)
}

fn read_all_active_entries(conn: &VaultConnection) -> StorageResult<Vec<Entry>> {
    let mut stmt = conn.inner().prepare(
        "SELECT entry_id, project_id, entry_type, title_ct, payload_ct,
                payload_schema_version, tiga_mode_override, object_clock,
                head_commit_id, deleted, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM entries WHERE deleted = 0 ORDER BY updated_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Entry {
            entry_id: row.get(0)?,
            project_id: row.get(1)?,
            entry_type: {
                let s: String = row.get(2)?;
                s.parse().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        rusqlite::types::Type::Text,
                        Box::new(StorageError::Validation(error)),
                    )
                })?
            },
            title_ct: row.get::<_, Option<Vec<u8>>>(3)?,
            payload_ct: row.get::<_, Vec<u8>>(4)?,
            payload_schema_version: {
                let value = row.get::<_, i64>(5)?;
                u32::try_from(value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?
            },
            tiga_mode_override: row
                .get::<_, Option<String>>(6)?
                .and_then(|s| s.parse().ok()),
            object_clock: row.get(7)?,
            head_commit_id: row.get(8)?,
            deleted: row.get::<_, i32>(9)? != 0,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            created_by_device_id: row.get(12)?,
            updated_by_device_id: row.get(13)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

fn read_all_active_object_relations(conn: &VaultConnection) -> StorageResult<Vec<ObjectRelation>> {
    let mut stmt = conn.inner().prepare(
        "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                payload_ct, payload_schema_version, object_clock, head_commit_id,
                deleted, created_at, updated_at, created_by_device_id,
                updated_by_device_id
         FROM object_relations WHERE deleted = 0 ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ObjectRelation {
            relation_id: row.get(0)?,
            source_object_id: row.get(1)?,
            target_object_id: row.get(2)?,
            relation_kind: row.get::<_, String>(3)?.parse().map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(StorageError::Validation(error)),
                )
            })?,
            payload_ct: row.get(4)?,
            payload_schema_version: read_u32(row, 5)?,
            object_clock: row.get(6)?,
            head_commit_id: row.get(7)?,
            deleted: row.get::<_, i32>(8)? != 0,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
            created_by_device_id: row.get(11)?,
            updated_by_device_id: row.get(12)?,
        })
    })?;
    collect_rows(rows)
}

fn read_all_active_object_labels(conn: &VaultConnection) -> StorageResult<Vec<ObjectLabel>> {
    let mut stmt = conn.inner().prepare(
        "SELECT label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                object_clock, head_commit_id, deleted, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM object_labels WHERE deleted = 0 ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ObjectLabel {
            label_id: row.get(0)?,
            collection_id: row.get(1)?,
            name_ct: row.get(2)?,
            payload_ct: row.get(3)?,
            payload_schema_version: read_u32(row, 4)?,
            object_clock: row.get(5)?,
            head_commit_id: row.get(6)?,
            deleted: row.get::<_, i32>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            created_by_device_id: row.get(10)?,
            updated_by_device_id: row.get(11)?,
        })
    })?;
    collect_rows(rows)
}

fn read_all_active_object_label_assignments(
    conn: &VaultConnection,
) -> StorageResult<Vec<ObjectLabelAssignment>> {
    let mut stmt = conn.inner().prepare(
        "SELECT assignment_id, object_id, label_id, object_clock, head_commit_id,
                deleted, created_at, updated_at, created_by_device_id,
                updated_by_device_id
         FROM object_label_assignments WHERE deleted = 0 ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ObjectLabelAssignment {
            assignment_id: row.get(0)?,
            object_id: row.get(1)?,
            label_id: row.get(2)?,
            object_clock: row.get(3)?,
            head_commit_id: row.get(4)?,
            deleted: row.get::<_, i32>(5)? != 0,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            created_by_device_id: row.get(8)?,
            updated_by_device_id: row.get(9)?,
        })
    })?;
    collect_rows(rows)
}

fn read_all_active_attachments(conn: &VaultConnection) -> StorageResult<Vec<Attachment>> {
    let mut stmt = conn.inner().prepare(
        "SELECT attachment_id, project_id, entry_id, file_name_ct,
                media_type_ct, storage_mode, content_hash,
                original_size, stored_size, chunk_count, head_commit_id,
                deleted, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM attachments WHERE deleted = 0 ORDER BY updated_at DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(Attachment {
            attachment_id: row.get(0)?,
            project_id: row.get(1)?,
            entry_id: row.get(2)?,
            file_name_ct: row.get::<_, Vec<u8>>(3)?,
            media_type_ct: row.get::<_, Option<Vec<u8>>>(4)?,
            storage_mode: {
                let s: String = row.get(5)?;
                s.parse().unwrap_or(StorageMode::EmbeddedInline)
            },
            content_hash: row.get(6)?,
            original_size: row.get::<_, i64>(7)? as u64,
            stored_size: row.get::<_, i64>(8)? as u64,
            chunk_count: row.get::<_, i32>(9)? as u32,
            head_commit_id: row.get(10)?,
            deleted: row.get::<_, i32>(11)? != 0,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
            created_by_device_id: row.get(14)?,
            updated_by_device_id: row.get(15)?,
        })
    })?;

    let mut attachments = Vec::new();
    for row in rows {
        attachments.push(row?);
    }
    Ok(attachments)
}

fn read_all_active_attachment_chunks(
    conn: &VaultConnection,
) -> StorageResult<Vec<AttachmentChunk>> {
    let mut stmt = conn.inner().prepare(
        "SELECT c.attachment_id, c.chunk_index, c.chunk_hash, c.chunk_ct,
                c.external_uri_ct, c.stored_size, c.created_at
         FROM attachment_chunks c
         JOIN attachments a ON a.attachment_id = c.attachment_id
         WHERE a.deleted = 0
         ORDER BY c.attachment_id ASC, c.chunk_index ASC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(AttachmentChunk {
            attachment_id: row.get(0)?,
            chunk_index: row.get::<_, i64>(1)? as u32,
            chunk_hash: row.get(2)?,
            chunk_ct: row.get(3)?,
            external_uri_ct: row.get(4)?,
            stored_size: row.get::<_, i64>(5)? as u64,
            created_at: row.get(6)?,
        })
    })?;

    let mut chunks = Vec::new();
    for row in rows {
        chunks.push(row?);
    }
    Ok(chunks)
}

fn read_all_active_project_tags(conn: &VaultConnection) -> StorageResult<Vec<ProjectTagSetRow>> {
    let mut by_project: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut stmt = conn.inner().prepare(
        "SELECT p.project_id, t.tag
         FROM projects p
         LEFT JOIN project_tags t ON t.project_id = p.project_id
         WHERE p.deleted = 0
         ORDER BY p.project_id, t.tag",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;
    for row in rows {
        let (project_id, tag) = row?;
        let tags = by_project.entry(project_id).or_default();
        if let Some(tag) = tag {
            tags.push(tag);
        }
    }
    Ok(by_project
        .into_iter()
        .map(|(project_id, tags)| ProjectTagSetRow { project_id, tags })
        .collect())
}

fn upsert_project(
    conn: &VaultConnection,
    p: &Project,
    restore_commit_id: &str,
    now: &str,
    device_id: &str,
) -> StorageResult<bool> {
    if TombstoneRepo::is_permanently_purged(conn, "project", &p.project_id)? {
        return Ok(false);
    }
    conn.inner().execute(
        "INSERT INTO projects (project_id, title_ct, summary_ct, group_id,
         icon_ref, favorite, archived, deleted, tiga_mode_override, object_clock,
         head_commit_id, attachment_count, created_at, updated_at,
         created_by_device_id, updated_by_device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(project_id) DO UPDATE SET
            title_ct = excluded.title_ct,
            summary_ct = excluded.summary_ct,
            group_id = excluded.group_id,
            icon_ref = excluded.icon_ref,
            favorite = excluded.favorite,
            archived = excluded.archived,
            deleted = 0,
            tiga_mode_override = excluded.tiga_mode_override,
            object_clock = excluded.object_clock,
            head_commit_id = excluded.head_commit_id,
            attachment_count = excluded.attachment_count,
            updated_at = excluded.updated_at,
            updated_by_device_id = excluded.updated_by_device_id",
        params![
            p.project_id,
            p.title_ct,
            p.summary_ct,
            p.group_id,
            p.icon_ref,
            p.favorite as i32,
            p.archived as i32,
            p.tiga_mode_override.as_ref().map(|m| m.to_string()),
            bump_clock(&p.object_clock),
            restore_commit_id,
            p.attachment_count as i32,
            p.created_at,
            now,
            p.created_by_device_id,
            device_id,
        ],
    )?;
    Ok(true)
}

fn upsert_entry(
    conn: &VaultConnection,
    e: &Entry,
    restore_commit_id: &str,
    now: &str,
    device_id: &str,
) -> StorageResult<bool> {
    if TombstoneRepo::is_permanently_purged(conn, "entry", &e.entry_id)? {
        return Ok(false);
    }
    CollectionProfileRepo::ensure_object_sync_allowed(conn, &e.project_id, &e.entry_type)?;
    conn.inner().execute(
        "INSERT INTO entries (entry_id, project_id, entry_type, title_ct,
         payload_ct, payload_schema_version, tiga_mode_override, object_clock,
         head_commit_id, deleted, created_at, updated_at,
         created_by_device_id, updated_by_device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)
         ON CONFLICT(entry_id) DO UPDATE SET
            project_id = excluded.project_id,
            entry_type = excluded.entry_type,
            title_ct = excluded.title_ct,
            payload_ct = excluded.payload_ct,
            payload_schema_version = excluded.payload_schema_version,
            tiga_mode_override = excluded.tiga_mode_override,
            object_clock = excluded.object_clock,
            head_commit_id = excluded.head_commit_id,
            deleted = 0,
            updated_at = excluded.updated_at,
            updated_by_device_id = excluded.updated_by_device_id",
        params![
            e.entry_id,
            e.project_id,
            e.entry_type.to_string(),
            e.title_ct,
            e.payload_ct,
            e.payload_schema_version as i64,
            e.tiga_mode_override.as_ref().map(|m| m.to_string()),
            bump_clock(&e.object_clock),
            restore_commit_id,
            e.created_at,
            now,
            e.created_by_device_id,
            device_id,
        ],
    )?;
    Ok(true)
}

fn upsert_object_relation(
    conn: &VaultConnection,
    relation: &ObjectRelation,
    restore_commit_id: &str,
    now: &str,
    device_id: &str,
) -> StorageResult<bool> {
    if TombstoneRepo::is_permanently_purged(conn, "object-relation", &relation.relation_id)? {
        return Ok(false);
    }
    conn.inner().execute(
        "INSERT INTO object_relations
            (relation_id, source_object_id, target_object_id, relation_kind,
             payload_ct, payload_schema_version, object_clock, head_commit_id,
             deleted, created_at, updated_at, created_by_device_id,
             updated_by_device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12)
         ON CONFLICT(relation_id) DO UPDATE SET
            source_object_id = excluded.source_object_id,
            target_object_id = excluded.target_object_id,
            relation_kind = excluded.relation_kind,
            payload_ct = excluded.payload_ct,
            payload_schema_version = excluded.payload_schema_version,
            object_clock = excluded.object_clock,
            head_commit_id = excluded.head_commit_id,
            deleted = 0,
            updated_at = excluded.updated_at,
            updated_by_device_id = excluded.updated_by_device_id",
        params![
            relation.relation_id,
            relation.source_object_id,
            relation.target_object_id,
            relation.relation_kind.to_string(),
            relation.payload_ct,
            relation.payload_schema_version as i64,
            bump_clock(&relation.object_clock),
            restore_commit_id,
            relation.created_at,
            now,
            relation.created_by_device_id,
            device_id,
        ],
    )?;
    Ok(true)
}

fn upsert_object_label(
    conn: &VaultConnection,
    label: &ObjectLabel,
    restore_commit_id: &str,
    now: &str,
    device_id: &str,
) -> StorageResult<bool> {
    if TombstoneRepo::is_permanently_purged(conn, "object-label", &label.label_id)? {
        return Ok(false);
    }
    conn.inner().execute(
        "INSERT INTO object_labels
            (label_id, collection_id, name_ct, payload_ct, payload_schema_version,
             object_clock, head_commit_id, deleted, created_at, updated_at,
             created_by_device_id, updated_by_device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11)
         ON CONFLICT(label_id) DO UPDATE SET
            collection_id = excluded.collection_id,
            name_ct = excluded.name_ct,
            payload_ct = excluded.payload_ct,
            payload_schema_version = excluded.payload_schema_version,
            object_clock = excluded.object_clock,
            head_commit_id = excluded.head_commit_id,
            deleted = 0,
            updated_at = excluded.updated_at,
            updated_by_device_id = excluded.updated_by_device_id",
        params![
            label.label_id,
            label.collection_id,
            label.name_ct,
            label.payload_ct,
            label.payload_schema_version as i64,
            bump_clock(&label.object_clock),
            restore_commit_id,
            label.created_at,
            now,
            label.created_by_device_id,
            device_id,
        ],
    )?;
    Ok(true)
}

fn upsert_object_label_assignment(
    conn: &VaultConnection,
    assignment: &ObjectLabelAssignment,
    restore_commit_id: &str,
    now: &str,
    device_id: &str,
) -> StorageResult<bool> {
    if TombstoneRepo::is_permanently_purged(
        conn,
        "object-label-assignment",
        &assignment.assignment_id,
    )? {
        return Ok(false);
    }
    conn.inner().execute(
        "UPDATE object_label_assignments SET deleted = 1
         WHERE object_id = ?1 AND label_id = ?2 AND assignment_id <> ?3 AND deleted = 0",
        params![
            assignment.object_id,
            assignment.label_id,
            assignment.assignment_id
        ],
    )?;
    conn.inner().execute(
        "INSERT INTO object_label_assignments
            (assignment_id, object_id, label_id, object_clock, head_commit_id,
             deleted, created_at, updated_at, created_by_device_id,
             updated_by_device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9)
         ON CONFLICT(assignment_id) DO UPDATE SET
            object_id = excluded.object_id,
            label_id = excluded.label_id,
            object_clock = excluded.object_clock,
            head_commit_id = excluded.head_commit_id,
            deleted = 0,
            updated_at = excluded.updated_at,
            updated_by_device_id = excluded.updated_by_device_id",
        params![
            assignment.assignment_id,
            assignment.object_id,
            assignment.label_id,
            bump_clock(&assignment.object_clock),
            restore_commit_id,
            assignment.created_at,
            now,
            assignment.created_by_device_id,
            device_id,
        ],
    )?;
    Ok(true)
}

fn upsert_attachment(
    conn: &VaultConnection,
    a: &Attachment,
    restore_commit_id: &str,
    now: &str,
    device_id: &str,
) -> StorageResult<bool> {
    if TombstoneRepo::is_permanently_purged(conn, "attachment", &a.attachment_id)? {
        return Ok(false);
    }
    conn.inner().execute(
        "INSERT INTO attachments (attachment_id, project_id, entry_id,
         file_name_ct, media_type_ct, storage_mode, content_hash,
         original_size, stored_size, chunk_count, head_commit_id,
         deleted, created_at, updated_at, created_by_device_id, updated_by_device_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?14, ?15)
         ON CONFLICT(attachment_id) DO UPDATE SET
            project_id = excluded.project_id,
            entry_id = excluded.entry_id,
            file_name_ct = excluded.file_name_ct,
            media_type_ct = excluded.media_type_ct,
            storage_mode = excluded.storage_mode,
            content_hash = excluded.content_hash,
            original_size = excluded.original_size,
            stored_size = excluded.stored_size,
            chunk_count = excluded.chunk_count,
            head_commit_id = excluded.head_commit_id,
            deleted = 0,
            updated_at = excluded.updated_at,
            updated_by_device_id = excluded.updated_by_device_id",
        params![
            a.attachment_id,
            a.project_id,
            a.entry_id,
            a.file_name_ct,
            a.media_type_ct,
            a.storage_mode.to_string(),
            a.content_hash,
            a.original_size as i64,
            a.stored_size as i64,
            a.chunk_count as i32,
            restore_commit_id,
            a.created_at,
            now,
            a.created_by_device_id,
            device_id,
        ],
    )?;
    Ok(true)
}

fn restore_attachment_chunks(
    conn: &VaultConnection,
    attachment_ids: &HashSet<String>,
    chunks: &[AttachmentChunk],
) -> StorageResult<()> {
    for attachment_id in attachment_ids {
        if TombstoneRepo::is_permanently_purged(conn, "attachment", attachment_id)? {
            continue;
        }
        conn.inner().execute(
            "DELETE FROM attachment_chunks WHERE attachment_id = ?1",
            params![attachment_id],
        )?;
    }

    for chunk in chunks {
        if TombstoneRepo::is_permanently_purged(conn, "attachment", &chunk.attachment_id)? {
            continue;
        }
        conn.inner().execute(
            "INSERT OR REPLACE INTO attachment_chunks (attachment_id, chunk_index,
             chunk_hash, chunk_ct, external_uri_ct, stored_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                chunk.attachment_id,
                chunk.chunk_index as i64,
                chunk.chunk_hash,
                chunk.chunk_ct,
                chunk.external_uri_ct,
                chunk.stored_size as i64,
                chunk.created_at,
            ],
        )?;
    }

    Ok(())
}

fn restore_project_tags(
    conn: &VaultConnection,
    project_ids: &HashSet<String>,
    tag_sets: &[ProjectTagSetRow],
) -> StorageResult<()> {
    for project_id in project_ids {
        if TombstoneRepo::is_permanently_purged(conn, "project", project_id)? {
            continue;
        }
        conn.inner().execute(
            "DELETE FROM project_tags WHERE project_id = ?1",
            params![project_id],
        )?;
    }
    for row in tag_sets {
        if TombstoneRepo::is_permanently_purged(conn, "project", &row.project_id)? {
            continue;
        }
        for tag in &row.tags {
            conn.inner().execute(
                "INSERT OR IGNORE INTO project_tags (project_id, tag) VALUES (?1, ?2)",
                params![row.project_id, tag],
            )?;
        }
    }
    Ok(())
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> StorageResult<Vec<T>> {
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

fn read_u32(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u32> {
    let value = row.get::<_, i64>(column)?;
    u32::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn active_ids(
    conn: &VaultConnection,
    table: &str,
    id_column: &str,
) -> StorageResult<HashSet<String>> {
    let mut stmt = conn.inner().prepare(&format!(
        "SELECT {id_column} FROM {table} WHERE deleted = 0"
    ))?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    let mut ids = HashSet::new();
    for row in rows {
        ids.insert(row?);
    }
    Ok(ids)
}

fn id_set<'a>(ids: impl Iterator<Item = &'a str>) -> HashSet<String> {
    ids.map(str::to_string).collect()
}

fn difference(left: &HashSet<String>, right: &HashSet<String>) -> Vec<String> {
    let mut ids: Vec<String> = left.difference(right).cloned().collect();
    ids.sort();
    ids
}

#[allow(clippy::too_many_arguments)]
fn soft_delete_for_restore(
    conn: &VaultConnection,
    ctx: &CommitContext,
    object_type: &str,
    table: &str,
    id_column: &str,
    object_ids: &[String],
    restore_commit_id: &str,
    now: &str,
) -> StorageResult<()> {
    for object_id in object_ids {
        ctx.create_tombstone_for_commit(conn, object_type, object_id, restore_commit_id)?;
        if table == "attachments" {
            conn.inner().execute(
                &format!(
                    "UPDATE {table} SET deleted = 1, head_commit_id = ?2,
                     updated_at = ?3, updated_by_device_id = ?4 WHERE {id_column} = ?1"
                ),
                params![object_id, restore_commit_id, now, ctx.device_id],
            )?;
        } else {
            let clock: String = conn.inner().query_row(
                &format!("SELECT object_clock FROM {table} WHERE {id_column} = ?1"),
                params![object_id],
                |row| row.get(0),
            )?;
            conn.inner().execute(
                &format!(
                    "UPDATE {table} SET deleted = 1, object_clock = ?2,
                     head_commit_id = ?3, updated_at = ?4,
                     updated_by_device_id = ?5 WHERE {id_column} = ?1"
                ),
                params![
                    object_id,
                    bump_clock(&clock),
                    restore_commit_id,
                    now,
                    ctx.device_id
                ],
            )?;
        }
    }
    Ok(())
}

fn bump_clock(clock: &str) -> String {
    let counter = serde_json::from_str::<serde_json::Value>(clock)
        .ok()
        .and_then(|value| value.get("counter")?.as_u64())
        .unwrap_or(0);
    format!(r#"{{"counter":{}}}"#, counter + 1)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::attachment::AttachmentRepo;
    use crate::repo::entry::EntryRepo;
    use crate::repo::object_label::{
        ObjectLabelAssignmentCreateRequest, ObjectLabelAssignmentRepo, ObjectLabelCreateRequest,
        ObjectLabelRepo,
    };
    use crate::repo::object_relation::{ObjectRelationCreateRequest, ObjectRelationRepo};
    use crate::repo::project::ProjectRepo;
    use crate::repo::{CollectionProfileRepo, CollectionProfileSpec};
    #[cfg(feature = "derived-search-index")]
    use crate::search::SearchService;
    use crate::tiga::TigaService;
    use crate::unlock::UnlockService;
    use mdbx_core::model::{
        CollectionTypeId, EntryType, ExtensionCapabilityId, ObjectTypeId, RelationKindId,
        UnlockMethodType, VaultSession,
    };
    use mdbx_core::tiga::{AuthorizationOutcome, DeviceAssurance, DeviceContext, SessionAssurance};

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        (conn, ctx)
    }

    fn setup_unlocked() -> (VaultConnection, CommitContext) {
        let (mut conn, ctx) = setup();
        UnlockService::setup_password(&mut conn, "snapshot-auth-password").unwrap();
        (conn, ctx)
    }

    fn login_payload() -> serde_json::Value {
        serde_json::json!({"username": "alice", "password": "s3cret"})
    }

    fn restore_session(now: i64) -> VaultSession {
        VaultSession {
            session_id: "restore-session".to_string(),
            unlock_method: UnlockMethodType::Password,
            created_at: chrono::DateTime::from_timestamp(now, 0)
                .unwrap()
                .to_rfc3339(),
            assurance: SessionAssurance::from_unlock_method(UnlockMethodType::Password, now),
        }
    }

    fn restore_device() -> DeviceContext {
        DeviceContext {
            device_id: Some("test-device".to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: false,
            screen_capture_protection_available: false,
            secure_temp_files_available: true,
        }
    }

    // -----------------------------------------------------------------------
    // CREATE SNAPSHOT
    // -----------------------------------------------------------------------

    #[test]
    fn test_create_empty_snapshot() {
        let (conn, ctx) = setup();
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        assert!(!snap.snapshot_id.is_empty());
        assert!(!snap.base_commit_id.is_empty());
        assert!(!snap.snapshot_ct.is_empty());
        assert_eq!(snap.snapshot_hash.len(), 64);
        assert_eq!(snap.created_by_device_id, "test-device");

        // 验证 payload 可反序列化
        let payload: SnapshotPayload = serde_json::from_slice(&snap.snapshot_ct).unwrap();
        assert_eq!(payload.format_version, crate::migration::FORMAT_V2);
        assert!(payload.projects.is_empty());
        assert!(payload.entries.is_empty());
        assert!(payload.attachments.is_empty());
        assert!(payload.attachment_chunks.unwrap().is_empty());
    }

    #[test]
    fn authenticated_snapshot_binds_metadata_and_rejects_downgrade() {
        let (conn, ctx) = setup_unlocked();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        assert!(snapshot
            .snapshot_ct
            .starts_with(snapshot_integrity::AUTHENTICATED_CIPHERTEXT_MAGIC));
        assert!(snapshot.snapshot_hash.starts_with("hmac-sha256-v1:"));
        let critical_extensions: String = conn
            .inner()
            .query_row("SELECT critical_extensions FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(serde_json::from_str::<Vec<String>>(&critical_extensions)
            .unwrap()
            .iter()
            .any(|extension| extension == SNAPSHOT_RECORD_AUTH_EXTENSION));
        assert!(SnapshotRepo::verify_integrity(&conn, &snapshot.snapshot_id).unwrap());

        conn.inner()
            .execute(
                "UPDATE snapshots SET created_at = 'tampered-at' WHERE snapshot_id = ?1",
                params![snapshot.snapshot_id],
            )
            .unwrap();
        assert!(!SnapshotRepo::verify_integrity(&conn, &snapshot.snapshot_id).unwrap());

        conn.inner()
            .execute(
                "UPDATE snapshots SET created_at = ?1, snapshot_hash = ?2
                 WHERE snapshot_id = ?3",
                params![
                    snapshot.created_at,
                    snapshot_integrity::ciphertext_sha256_hex(&snapshot.snapshot_ct),
                    snapshot.snapshot_id
                ],
            )
            .unwrap();
        assert!(!SnapshotRepo::verify_integrity(&conn, &snapshot.snapshot_id).unwrap());

        let stripped = snapshot.snapshot_ct
            [snapshot_integrity::AUTHENTICATED_CIPHERTEXT_MAGIC.len()..]
            .to_vec();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1, snapshot_hash = ?2
                 WHERE snapshot_id = ?3",
                params![
                    stripped.clone(),
                    snapshot_integrity::ciphertext_sha256_hex(&stripped),
                    snapshot.snapshot_id
                ],
            )
            .unwrap();
        assert!(!SnapshotRepo::verify_integrity(&conn, &snapshot.snapshot_id).unwrap());
    }

    #[test]
    fn legacy_encrypted_snapshot_profile_remains_readable() {
        let (conn, ctx) = setup_unlocked();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let plaintext =
            SnapshotRepo::decrypt_payload(&conn, &snapshot.snapshot_id, &snapshot.snapshot_ct)
                .unwrap();
        let legacy_ciphertext = conn
            .with_immediate_transaction(|| {
                encrypt_field(
                    &conn,
                    FieldKeyPurpose::Metadata,
                    &plaintext,
                    "snapshot",
                    &snapshot.snapshot_id,
                    "payload",
                )
            })
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1, snapshot_hash = ?2
                 WHERE snapshot_id = ?3",
                params![
                    legacy_ciphertext.clone(),
                    snapshot_integrity::ciphertext_sha256_hex(&legacy_ciphertext),
                    snapshot.snapshot_id
                ],
            )
            .unwrap();

        assert!(SnapshotRepo::verify_integrity(&conn, &snapshot.snapshot_id).unwrap());
        assert!(SnapshotRepo::restore_snapshot(&conn, &ctx, &snapshot.snapshot_id).is_ok());
    }

    #[test]
    fn authenticated_snapshot_extension_blocks_locked_legacy_creation() {
        let (mut conn, ctx) = setup_unlocked();
        SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        conn.clear_session();

        let error = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap_err();
        assert!(error.to_string().contains("requires an unlocked keyring"));
    }

    #[test]
    fn snapshot_restore_preserves_versioned_collection_profile() {
        let (mut conn, ctx) = setup();
        conn.set_extension_capabilities([
            ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
        ]);
        let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        let profile_spec = |payload: &[u8], version| CollectionProfileSpec {
            collection_id: project.project_id.clone(),
            collection_type_id: CollectionTypeId::new("com.monica.mail").unwrap(),
            payload: payload.to_vec(),
            payload_schema_version: version,
            allowed_object_type_ids: vec![ObjectTypeId::custom("com.monica.mail.message").unwrap()],
            required_capability_ids: vec![
                ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
            ],
        };
        CollectionProfileRepo::set(&conn, &ctx, profile_spec(b"profile-v1", 1)).unwrap();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        CollectionProfileRepo::set(&conn, &ctx, profile_spec(b"profile-v2", 2)).unwrap();

        let session = restore_session(1_000);
        let device = restore_device();
        SnapshotRepo::restore_snapshot_authorized(
            &conn,
            &ctx,
            &snapshot.snapshot_id,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_010,
            },
        )
        .unwrap();

        let restored = CollectionProfileRepo::get_by_collection_id(&conn, &project.project_id)
            .unwrap()
            .unwrap();
        assert_eq!(restored.payload_ct, b"profile-v1");
        assert_eq!(restored.payload_schema_version, 1);
    }

    #[test]
    fn authorized_restore_is_atomic_with_security_audit() {
        let (conn, ctx) = setup();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let session = restore_session(1_000);
        let device = restore_device();
        let decision = SnapshotRepo::restore_snapshot_authorized(
            &conn,
            &ctx,
            &snapshot.snapshot_id,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_010,
            },
        )
        .unwrap();
        assert_eq!(decision.outcome, AuthorizationOutcome::Allow);
        let events = TigaService::list_security_audit_events(&conn, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].operation, TigaOperation::RestoreSnapshot);
        let commit_id = events[0]
            .commit_id
            .as_deref()
            .expect("authorized restore must reference its commit");
        let operation_id = events[0]
            .operation_id
            .as_deref()
            .expect("authorized restore must reference its operation");
        let stored_operation: String = conn
            .inner()
            .query_row(
                "SELECT operation_id FROM commit_operations WHERE commit_id = ?1",
                params![commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_operation, operation_id);
        assert_eq!(
            events[0].policy_version,
            Some(mdbx_core::tiga::TIGA_POLICY_VERSION)
        );
        assert_eq!(
            events[0].policy_fingerprint.as_deref().map(<[u8]>::len),
            Some(32)
        );
    }

    #[test]
    fn restore_without_session_is_denied_before_snapshot_changes() {
        let (conn, ctx) = setup();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let device = restore_device();
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let error = SnapshotRepo::restore_snapshot_authorized(
            &conn,
            &ctx,
            &snapshot.snapshot_id,
            TigaAuthorizationContext {
                session: None,
                device: &device,
                now_unix_secs: 1_010,
            },
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Authorization(_)));
        let after_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before_commits, after_commits);
        assert_eq!(
            TigaService::list_security_audit_events(&conn, 10)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_snapshot_captures_projects() {
        let (conn, ctx) = setup();
        ProjectRepo::create(&conn, &ctx, "Alpha", None, None).unwrap();
        ProjectRepo::create(&conn, &ctx, "Beta", None, None).unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let payload: SnapshotPayload = serde_json::from_slice(&snap.snapshot_ct).unwrap();

        assert_eq!(payload.projects.len(), 2);
        let titles: Vec<&str> = payload
            .projects
            .iter()
            .map(|p| std::str::from_utf8(&p.title_ct).unwrap())
            .collect();
        assert!(titles.contains(&"Alpha"));
        assert!(titles.contains(&"Beta"));
    }

    #[test]
    fn test_snapshot_excludes_deleted() {
        let (conn, ctx) = setup();
        let p1 = ProjectRepo::create(&conn, &ctx, "Keep", None, None).unwrap();
        let p2 = ProjectRepo::create(&conn, &ctx, "Delete", None, None).unwrap();
        ProjectRepo::soft_delete(&conn, &ctx, &p2.project_id).unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let payload: SnapshotPayload = serde_json::from_slice(&snap.snapshot_ct).unwrap();

        assert_eq!(payload.projects.len(), 1);
        assert_eq!(payload.projects[0].project_id, p1.project_id);
    }

    #[test]
    fn test_snapshot_captures_entries() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("E1"),
            &login_payload(),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Note,
            Some("E2"),
            &serde_json::json!({"text":"hi"}),
        )
        .unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let payload: SnapshotPayload = serde_json::from_slice(&snap.snapshot_ct).unwrap();

        assert_eq!(payload.entries.len(), 2);
        for e in &payload.entries {
            assert_eq!(e.project_id, project.project_id);
        }
    }

    #[test]
    fn snapshot_restores_custom_object_type_and_payload_schema_version() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "Generic", None, None).unwrap();
        let object = EntryRepo::create_with_payload_schema_version(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.steam.mafile").unwrap(),
            Some("Steam Guard"),
            &serde_json::json!({"account_name": "alice", "device_id": "android:test"}),
            5,
        )
        .unwrap();

        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        conn.inner()
            .execute(
                "DELETE FROM entries WHERE entry_id = ?1",
                params![object.entry_id],
            )
            .unwrap();
        SnapshotRepo::restore_snapshot(&conn, &ctx, &snapshot.snapshot_id).unwrap();

        let restored = EntryRepo::get_by_id(&conn, &object.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(restored.entry_type.as_str(), "com.monica.steam.mafile");
        assert_eq!(restored.payload_schema_version, 5);
    }

    #[test]
    fn relation_snapshot_restores_exact_generic_metadata_set() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "Generic", None, None).unwrap();
        let first = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("First"),
            &serde_json::json!({"body": "first"}),
        )
        .unwrap();
        let second = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Second"),
            &serde_json::json!({"body": "second"}),
        )
        .unwrap();
        let relation = ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &first.entry_id,
                &second.entry_id,
                RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                serde_json::json!({"position": 1}),
            ),
        )
        .unwrap();
        let label = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(
                &project.project_id,
                "Important",
                serde_json::json!({"color": "red"}),
            ),
        )
        .unwrap();
        let assignment = ObjectLabelAssignmentRepo::create(
            &conn,
            &ctx,
            ObjectLabelAssignmentCreateRequest::new(&first.entry_id, &label.label_id),
        )
        .unwrap();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        ObjectLabelAssignmentRepo::soft_delete(&conn, &ctx, &assignment.assignment_id).unwrap();
        ObjectLabelRepo::soft_delete(&conn, &ctx, &label.label_id).unwrap();
        ObjectRelationRepo::soft_delete(&conn, &ctx, &relation.relation_id).unwrap();
        let extra_relation = ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &second.entry_id,
                &first.entry_id,
                RelationKindId::new("com.monica.mail.thread-member").unwrap(),
                serde_json::json!({}),
            ),
        )
        .unwrap();

        SnapshotRepo::restore_snapshot(&conn, &ctx, &snapshot.snapshot_id).unwrap();

        let restored_relation = ObjectRelationRepo::get_by_id(&conn, &relation.relation_id)
            .unwrap()
            .unwrap();
        let restored_label = ObjectLabelRepo::get_by_id(&conn, &label.label_id)
            .unwrap()
            .unwrap();
        let restored_assignment =
            ObjectLabelAssignmentRepo::get_by_id(&conn, &assignment.assignment_id)
                .unwrap()
                .unwrap();
        assert!(!restored_relation.deleted);
        assert!(!restored_label.deleted);
        assert!(!restored_assignment.deleted);
        assert!(
            ObjectRelationRepo::get_by_id(&conn, &extra_relation.relation_id)
                .unwrap()
                .unwrap()
                .deleted
        );
        assert_eq!(
            restored_relation.head_commit_id,
            restored_label.head_commit_id
        );
        assert_eq!(
            restored_label.head_commit_id,
            restored_assignment.head_commit_id
        );
        assert!(ObjectVersionRepo::get_object_relation(
            &conn,
            &relation.relation_id,
            &restored_relation.head_commit_id,
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn test_snapshot_captures_attachments() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "a.txt",
            None,
            "h1",
            100,
        )
        .unwrap();
        AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "b.txt",
            None,
            "h2",
            200,
        )
        .unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let payload: SnapshotPayload = serde_json::from_slice(&snap.snapshot_ct).unwrap();

        assert_eq!(payload.attachments.len(), 2);
    }

    #[test]
    fn test_snapshot_captures_attachment_chunks() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "chunked.bin",
            Some("application/octet-stream"),
            "",
            13,
        )
        .unwrap();
        AttachmentRepo::write_chunked_content(
            &conn,
            &ctx,
            &att.attachment_id,
            b"hello snapshot",
            5,
        )
        .unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let payload: SnapshotPayload = serde_json::from_slice(&snap.snapshot_ct).unwrap();

        assert_eq!(payload.attachments.len(), 1);
        let chunks = payload.attachment_chunks.unwrap();
        assert_eq!(chunks.len(), 3);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.attachment_id == att.attachment_id));
    }

    #[test]
    fn test_snapshot_commit_created() {
        let (conn, ctx) = setup();
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        let (commit_kind, change_scope): (String, String) = conn
            .inner()
            .query_row(
                "SELECT commit_kind, change_scope FROM commits WHERE commit_id = ?1",
                params![snap.base_commit_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(commit_kind, "snapshot");
        assert_eq!(change_scope, "multi");
    }

    // -----------------------------------------------------------------------
    // RESTORE SNAPSHOT
    // -----------------------------------------------------------------------

    #[test]
    fn test_restore_rebuilds_projects() {
        let (conn, ctx) = setup();

        // 创建一些数据并拍快照
        ProjectRepo::create(&conn, &ctx, "Original", None, None).unwrap();
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        // 清空 projects（模拟数据丢失）
        conn.inner().execute("DELETE FROM entries", []).unwrap();
        conn.inner().execute("DELETE FROM attachments", []).unwrap();
        conn.inner().execute("DELETE FROM projects", []).unwrap();

        // 恢复
        SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id).unwrap();

        let restored = ProjectRepo::list_all(&conn).unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].title_ct, b"Original");
    }

    #[test]
    fn test_restore_rebuilds_entries() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("MyLogin"),
            &login_payload(),
        )
        .unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        // 清空
        conn.inner().execute("DELETE FROM entries", []).unwrap();
        conn.inner().execute("DELETE FROM attachments", []).unwrap();
        conn.inner().execute("DELETE FROM projects", []).unwrap();

        // 恢复
        SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id).unwrap();

        let entries = read_all_active_entries(&conn).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].entry_type, EntryType::Login);
        assert_eq!(entries[0].title_ct, Some(b"MyLogin".to_vec()));
    }

    #[test]
    fn test_restore_rebuilds_attachments() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "photo.png",
            Some("image/png"),
            "abc123",
            512,
        )
        .unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        // 清空
        conn.inner().execute("DELETE FROM attachments", []).unwrap();
        conn.inner().execute("DELETE FROM entries", []).unwrap();
        conn.inner().execute("DELETE FROM projects", []).unwrap();

        // 恢复
        SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id).unwrap();

        let attachments = read_all_active_attachments(&conn).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].file_name_ct, b"photo.png");
        assert_eq!(attachments[0].media_type_ct, Some(b"image/png".to_vec()));
        assert_eq!(attachments[0].content_hash, "abc123");
        assert_eq!(attachments[0].original_size, 512);
    }

    #[test]
    fn test_restore_rebuilds_attachment_chunks_and_content() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "video.bin",
            Some("application/octet-stream"),
            "",
            17,
        )
        .unwrap();
        let content = b"restorable content";
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, content, 4).unwrap();

        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        conn.inner()
            .execute("DELETE FROM attachment_chunks", [])
            .unwrap();
        conn.inner().execute("DELETE FROM attachments", []).unwrap();
        conn.inner().execute("DELETE FROM entries", []).unwrap();
        conn.inner().execute("DELETE FROM projects", []).unwrap();

        SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id).unwrap();

        let restored = AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap();
        assert_eq!(restored, content);
        assert!(AttachmentRepo::verify_chunks_integrity(&conn, &att.attachment_id).unwrap());
    }

    #[test]
    fn test_restore_creates_commit() {
        let (conn, ctx) = setup();
        ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        // 清空并恢复
        conn.inner().execute("DELETE FROM entries", []).unwrap();
        conn.inner().execute("DELETE FROM attachments", []).unwrap();
        conn.inner().execute("DELETE FROM projects", []).unwrap();
        SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id).unwrap();

        // 恢复后应有新的 snapshot commit
        let count: i32 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commits WHERE commit_kind = 'snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            count >= 2,
            "expected at least 2 snapshot commits, got {}",
            count
        );
    }

    #[test]
    fn test_restore_hash_mismatch_rejected() {
        let (conn, ctx) = setup();
        let mut snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        // 篡改 snapshot_ct 但不改 hash
        snap.snapshot_ct = b"corrupted".to_vec();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1 WHERE snapshot_id = ?2",
                params![snap.snapshot_ct, snap.snapshot_id],
            )
            .unwrap();

        let result = SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_restore_nonexistent() {
        let (conn, ctx) = setup();
        let result = SnapshotRepo::restore_snapshot(&conn, &ctx, "nonexistent");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_by_id() {
        let (conn, ctx) = setup();
        let created = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        let found = SnapshotRepo::get_by_id(&conn, &created.snapshot_id)
            .unwrap()
            .unwrap();
        assert_eq!(found.snapshot_id, created.snapshot_id);
        assert_eq!(found.snapshot_hash, created.snapshot_hash);
    }

    #[test]
    fn test_get_nonexistent() {
        let (conn, _ctx) = setup();
        let result = SnapshotRepo::get_by_id(&conn, "nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_list_all() {
        let (conn, ctx) = setup();
        SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        let all = SnapshotRepo::list_all(&conn).unwrap();
        assert_eq!(all.len(), 2);
        // 按时间降序排列
        assert!(all[0].created_at >= all[1].created_at);
    }

    // -----------------------------------------------------------------------
    // VERIFY INTEGRITY
    // -----------------------------------------------------------------------

    #[test]
    fn test_verify_integrity_passes() {
        let (conn, ctx) = setup();
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        assert!(SnapshotRepo::verify_integrity(&conn, &snap.snapshot_id).unwrap());
    }

    #[test]
    fn test_verify_integrity_fails_on_tamper() {
        let (conn, ctx) = setup();
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1 WHERE snapshot_id = ?2",
                params![b"tampered payload", snap.snapshot_id],
            )
            .unwrap();

        assert!(!SnapshotRepo::verify_integrity(&conn, &snap.snapshot_id).unwrap());
    }

    #[test]
    fn test_verify_integrity_nonexistent() {
        let (conn, _ctx) = setup();
        assert!(!SnapshotRepo::verify_integrity(&conn, "nonexistent").unwrap());
    }

    // -----------------------------------------------------------------------
    // ROUNDTRIP
    // -----------------------------------------------------------------------

    #[test]
    fn test_full_roundtrip() {
        let (conn, ctx) = setup();

        // 创建完整数据集
        let p1 =
            ProjectRepo::create(&conn, &ctx, "Work", Some("group-1"), Some("icon-work")).unwrap();
        let p2 = ProjectRepo::create(&conn, &ctx, "Personal", None, None).unwrap();

        let e1 = EntryRepo::create(
            &conn,
            &ctx,
            &p1.project_id,
            EntryType::Login,
            Some("GitHub"),
            &serde_json::json!({"username": "gh", "password": "pass1"}),
        )
        .unwrap();
        let _e2 = EntryRepo::create(
            &conn,
            &ctx,
            &p2.project_id,
            EntryType::Note,
            Some("Ideas"),
            &serde_json::json!({"text": "build something"}),
        )
        .unwrap();

        let a1 = AttachmentRepo::add(
            &conn,
            &ctx,
            &p1.project_id,
            Some(&e1.entry_id),
            "screenshot.png",
            Some("image/png"),
            "hash1",
            1024,
        )
        .unwrap();
        let _a2 = AttachmentRepo::add(
            &conn,
            &ctx,
            &p2.project_id,
            None,
            "notes.txt",
            Some("text/plain"),
            "hash2",
            2048,
        )
        .unwrap();

        // 拍快照
        let snap = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        // 清空
        conn.inner()
            .execute("DELETE FROM attachment_chunks", [])
            .unwrap();
        conn.inner().execute("DELETE FROM attachments", []).unwrap();
        conn.inner().execute("DELETE FROM entries", []).unwrap();
        conn.inner().execute("DELETE FROM projects", []).unwrap();

        // 恢复
        SnapshotRepo::restore_snapshot(&conn, &ctx, &snap.snapshot_id).unwrap();

        // 验证完整恢复
        let projects = ProjectRepo::list_all(&conn).unwrap();
        assert_eq!(projects.len(), 2);

        let entries = read_all_active_entries(&conn).unwrap();
        assert_eq!(entries.len(), 2);

        let attachments = read_all_active_attachments(&conn).unwrap();
        assert_eq!(attachments.len(), 2);

        // 验证字段完整性
        let p1_restored = projects
            .iter()
            .find(|p| p.project_id == p1.project_id)
            .unwrap();
        assert_eq!(p1_restored.title_ct, b"Work");
        assert_eq!(p1_restored.group_id.as_deref(), Some("group-1"));
        assert_eq!(p1_restored.icon_ref.as_deref(), Some("icon-work"));

        let e1_restored = entries.iter().find(|e| e.entry_id == e1.entry_id).unwrap();
        assert_eq!(e1_restored.project_id, p1.project_id);
        assert_eq!(e1_restored.entry_type, EntryType::Login);
        assert_eq!(e1_restored.title_ct, Some(b"GitHub".to_vec()));

        let a1_restored = attachments
            .iter()
            .find(|a| a.attachment_id == a1.attachment_id)
            .unwrap();
        assert_eq!(a1_restored.entry_id, Some(e1.entry_id));
        assert_eq!(a1_restored.storage_mode, StorageMode::EmbeddedInline);
    }

    #[cfg(feature = "derived-search-index")]
    #[test]
    fn restore_reinstates_exact_active_set_tags_and_causal_heads() {
        let (conn, ctx) = setup();
        let original = ProjectRepo::create(&conn, &ctx, "Original", None, None).unwrap();
        SearchService::set_tags_tracked(
            &conn,
            &ctx,
            &original.project_id,
            &["snapshot-tag".to_string()],
        )
        .unwrap();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        SearchService::set_tags_tracked(
            &conn,
            &ctx,
            &original.project_id,
            &["later-tag".to_string()],
        )
        .unwrap();
        let later_project = ProjectRepo::create(&conn, &ctx, "Later", None, None).unwrap();
        let later_entry = EntryRepo::create(
            &conn,
            &ctx,
            &later_project.project_id,
            EntryType::Login,
            Some("Later login"),
            &login_payload(),
        )
        .unwrap();
        let later_attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &later_project.project_id,
            Some(&later_entry.entry_id),
            "later.bin",
            None,
            "",
            0,
        )
        .unwrap();

        SnapshotRepo::restore_snapshot(&conn, &ctx, &snapshot.snapshot_id).unwrap();

        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
        assert_eq!(ProjectRepo::list_deleted(&conn).unwrap().len(), 1);
        assert!(
            EntryRepo::get_by_id(&conn, &later_entry.entry_id)
                .unwrap()
                .unwrap()
                .deleted
        );
        assert!(
            AttachmentRepo::get_by_id(&conn, &later_attachment.attachment_id)
                .unwrap()
                .unwrap()
                .deleted
        );
        assert_eq!(
            SearchService::list_tags(&conn, &original.project_id).unwrap(),
            vec!["snapshot-tag".to_string()]
        );

        let restore_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for (object_type, object_id) in [
            ("project", original.project_id.as_str()),
            ("project", later_project.project_id.as_str()),
            ("entry", later_entry.entry_id.as_str()),
            ("attachment", later_attachment.attachment_id.as_str()),
        ] {
            let count: i64 = conn
                .inner()
                .query_row(
                    "SELECT COUNT(*) FROM object_versions
                     WHERE object_type = ?1 AND object_id = ?2 AND commit_id = ?3",
                    params![object_type, object_id, restore_head],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                count, 1,
                "missing restore version for {object_type}:{object_id}"
            );
        }
    }

    #[test]
    fn restore_failure_rolls_back_commit_heads_and_rows() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Login"),
            &login_payload(),
        )
        .unwrap();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();

        let mut payload: SnapshotPayload = serde_json::from_slice(&snapshot.snapshot_ct).unwrap();
        payload.entries[0].project_id = "missing-project".to_string();
        let invalid_payload = serde_json::to_vec(&payload).unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1, snapshot_hash = ?2
                 WHERE snapshot_id = ?3",
                params![
                    invalid_payload,
                    snapshot_integrity::ciphertext_sha256_hex(&invalid_payload),
                    snapshot.snapshot_id
                ],
            )
            .unwrap();

        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let before_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let session = restore_session(1_000);
        let device = restore_device();
        assert!(SnapshotRepo::restore_snapshot_authorized(
            &conn,
            &ctx,
            &snapshot.snapshot_id,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_010,
            },
        )
        .is_err());

        let after_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let after_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after_commits, before_commits);
        assert_eq!(after_head, before_head);
        assert!(TigaService::list_security_audit_events(&conn, 10)
            .unwrap()
            .is_empty());
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
        assert_eq!(
            EntryRepo::list_by_project(&conn, &project.project_id)
                .unwrap()
                .len(),
            1
        );
    }
}
