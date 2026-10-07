use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, OptionalExtension};

use mdbx_sync::{CommitBatch, CommitOperationMetadata, SerializedCommit};

use crate::commit_integrity::{compute_commit_integrity_tag, CommitIntegrityInput};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{CommitContext, CommitGraphRepo, TombstoneAcknowledgementRepo, TombstoneRepo};
use crate::sync_state::SyncStateLimits;

use super::{commit_graph_apply, payload_apply, ApplyBatchResult};

pub(super) fn apply_batch_inner(
    conn: &VaultConnection,
    ctx: &CommitContext,
    batch: &CommitBatch,
    allow_key_epoch_changes: bool,
    sync_limits: SyncStateLimits,
) -> StorageResult<ApplyBatchResult> {
    let mut result = ApplyBatchResult::default();

    for serialized in &batch.commits {
        match apply_commit(conn, ctx, serialized, allow_key_epoch_changes, sync_limits)? {
            ApplyOutcome::Applied => result.applied_commits += 1,
            ApplyOutcome::Skipped => result.skipped_commits += 1,
            ApplyOutcome::Conflict => {
                result.applied_commits += 1;
                result.conflict_count += 1;
            }
            ApplyOutcome::MissingParent => result.missing_parent_count += 1,
        }
    }

    Ok(result)
}

fn apply_commit(
    conn: &VaultConnection,
    ctx: &CommitContext,
    serialized: &SerializedCommit,
    allow_key_epoch_changes: bool,
    sync_limits: SyncStateLimits,
) -> StorageResult<ApplyOutcome> {
    if CommitGraphRepo::commit_exists(conn, &serialized.commit.commit_id)? {
        return conn.with_immediate_transaction(|| {
            verify_existing_commit_metadata(conn, serialized)?;
            if let Some(operation) = &serialized.operation {
                CommitContext::verify_operation_integrity(conn, &serialized.commit, operation)?;
                insert_operation(
                    conn,
                    &serialized.commit.commit_id,
                    &serialized.commit.created_at,
                    operation,
                )?;
            }
            let payload_result = payload_apply::apply_fast_forward_payloads(
                conn,
                ctx,
                serialized,
                allow_key_epoch_changes,
                sync_limits,
            )?;
            if payload_result.received_delta {
                payload_apply::discard_received_delta_mutations(
                    conn,
                    &payload_result.delta_commit_ids,
                )?;
            }
            Ok(ApplyOutcome::Skipped)
        });
    }

    for parent in &serialized.parent_ids {
        if !CommitGraphRepo::commit_exists(conn, parent)? {
            return Ok(ApplyOutcome::MissingParent);
        }
    }

    let branch_id = serialized
        .operation
        .as_ref()
        .and_then(|operation| operation.branch_id.as_deref());
    let branch_name = serialized
        .operation
        .as_ref()
        .map(|operation| operation.branch_name.as_str())
        .unwrap_or("main");
    let local_head = commit_graph_apply::current_branch_head(conn, branch_id, branch_name)?;
    let fast_forward = local_head
        .as_deref()
        .map(|head| serialized.parent_ids.iter().any(|parent| parent == head))
        .unwrap_or(true);

    conn.with_immediate_transaction(|| {
        insert_commit(conn, serialized)?;
        acknowledge_received_tombstones(conn, ctx, serialized)?;
        if fast_forward {
            let payload_result = payload_apply::apply_fast_forward_payloads(
                conn,
                ctx,
                serialized,
                allow_key_epoch_changes,
                sync_limits,
            )?;
            let payload_conflicts = payload_result.conflicts;
            if payload_conflicts == 0 {
                commit_graph_apply::advance_branch(
                    conn,
                    branch_id,
                    branch_name,
                    &serialized.commit.commit_id,
                )?;
            }
            commit_graph_apply::sync_device_head(conn, serialized)?;
            if payload_result.received_delta {
                payload_apply::discard_received_delta_mutations(
                    conn,
                    &payload_result.delta_commit_ids,
                )?;
            }
            Ok(if payload_conflicts == 0 {
                ApplyOutcome::Applied
            } else {
                ApplyOutcome::Conflict
            })
        } else {
            let payload_result = payload_apply::apply_divergent_payloads(
                conn,
                ctx,
                serialized,
                local_head.as_deref(),
                allow_key_epoch_changes,
                sync_limits,
            )?;
            let payload_conflicts = payload_result.conflicts;
            commit_graph_apply::sync_device_head(conn, serialized)?;
            if payload_result.received_delta {
                payload_apply::discard_received_delta_mutations(
                    conn,
                    &payload_result.delta_commit_ids,
                )?;
            }
            Ok(if payload_conflicts == 0 {
                ApplyOutcome::Applied
            } else {
                ApplyOutcome::Conflict
            })
        }
    })
}

pub(super) fn insert_commit(
    conn: &VaultConnection,
    serialized: &SerializedCommit,
) -> StorageResult<()> {
    verify_incoming_commit_integrity(conn, serialized)?;
    let local_seq = validate_new_commit_structure(conn, serialized)?;
    let commit = &serialized.commit;

    conn.inner().execute(
        "INSERT INTO commits (commit_id, device_id, local_seq, commit_kind, change_scope,
         changed_object_ids_ct, vector_clock, message_ct, created_at, integrity_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            commit.commit_id,
            commit.device_id,
            local_seq,
            commit.commit_kind.to_string(),
            commit.change_scope.to_string(),
            &commit.changed_object_ids_ct,
            commit.vector_clock,
            commit.message_ct.as_deref(),
            commit.created_at,
            &commit.integrity_tag,
        ],
    )?;

    conn.inner().execute(
        "INSERT INTO commit_device_sequences (device_id, last_local_seq)
         VALUES (?1, ?2)
         ON CONFLICT(device_id) DO UPDATE SET
            last_local_seq = MAX(last_local_seq, excluded.last_local_seq)",
        params![commit.device_id, local_seq],
    )?;

    for parent_id in &serialized.parent_ids {
        conn.inner().execute(
            "INSERT OR IGNORE INTO commit_parents (commit_id, parent_commit_id) VALUES (?1, ?2)",
            params![commit.commit_id, parent_id],
        )?;
    }

    if let Some(operation) = &serialized.operation {
        CommitContext::verify_operation_integrity(conn, &serialized.commit, operation)?;
        insert_operation(
            conn,
            &serialized.commit.commit_id,
            &serialized.commit.created_at,
            operation,
        )?;
    }

    for tombstone in &serialized.tombstones {
        if TombstoneRepo::is_permanently_purged(
            conn,
            &tombstone.target_object_type,
            &tombstone.target_object_id,
        )? {
            continue;
        }
        conn.inner().execute(
            "INSERT INTO tombstones (tombstone_id, target_object_type, target_object_id,
             delete_clock, deleted_by_device_id, deleted_at, purge_eligible_at,
             delete_commit_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)
             ON CONFLICT(tombstone_id) DO UPDATE SET
                target_object_type = excluded.target_object_type,
                target_object_id = excluded.target_object_id,
                delete_clock = excluded.delete_clock,
                deleted_by_device_id = excluded.deleted_by_device_id,
                deleted_at = excluded.deleted_at,
                delete_commit_id = excluded.delete_commit_id",
            params![
                tombstone.tombstone_id,
                tombstone.target_object_type,
                tombstone.target_object_id,
                tombstone.delete_clock,
                tombstone.deleted_by_device_id,
                tombstone.deleted_at,
                serialized.commit.commit_id,
            ],
        )?;
        TombstoneAcknowledgementRepo::merge(
            conn,
            &tombstone.tombstone_id,
            &tombstone.deleted_by_device_id,
            &serialized.commit.commit_id,
            &tombstone.deleted_at,
        )?;
    }

    Ok(())
}

fn validate_new_commit_structure(
    conn: &VaultConnection,
    serialized: &SerializedCommit,
) -> StorageResult<i64> {
    let commit = &serialized.commit;
    let local_seq = i64::try_from(commit.local_seq).map_err(|_| {
        StorageError::Validation(format!(
            "incoming commit {} local sequence {} does not fit SQLite INTEGER",
            commit.commit_id, commit.local_seq
        ))
    })?;
    serde_json::from_str::<BTreeMap<String, u64>>(&commit.vector_clock).map_err(|error| {
        StorageError::Validation(format!(
            "incoming commit {} has invalid vector clock: {error}",
            commit.commit_id
        ))
    })?;

    let mut seen = HashSet::with_capacity(serialized.parent_ids.len());
    for parent_id in &serialized.parent_ids {
        if !seen.insert(parent_id.as_str()) {
            return Err(StorageError::Validation(format!(
                "incoming commit {} has duplicate parent {}",
                commit.commit_id, parent_id
            )));
        }
    }

    let existing_commit_id: Option<String> = conn
        .inner()
        .query_row(
            "SELECT commit_id FROM commits WHERE device_id = ?1 AND local_seq = ?2",
            params![commit.device_id, local_seq],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_commit_id) = existing_commit_id {
        return Err(StorageError::Validation(format!(
            "incoming commit {} reuses device {} local sequence {} already assigned to commit {}",
            commit.commit_id, commit.device_id, commit.local_seq, existing_commit_id
        )));
    }

    Ok(local_seq)
}

fn verify_incoming_commit_integrity(
    conn: &VaultConnection,
    serialized: &SerializedCommit,
) -> StorageResult<()> {
    let commit = &serialized.commit;
    let commit_kind = commit.commit_kind.to_string();
    let change_scope = commit.change_scope.to_string();
    let commit_integrity_input = CommitIntegrityInput {
        commit_id: &commit.commit_id,
        device_id: &commit.device_id,
        local_seq: commit.local_seq,
        commit_kind: &commit_kind,
        change_scope: &change_scope,
        changed_object_ids_ct: &commit.changed_object_ids_ct,
        vector_clock: &commit.vector_clock,
        message_ct: commit.message_ct.as_deref(),
        created_at: &commit.created_at,
        parents: &serialized.parent_ids,
    };
    let expected = compute_commit_integrity_tag(conn.keyring(), &commit_integrity_input)?;
    if expected != commit.integrity_tag {
        return Err(StorageError::Validation(format!(
            "incoming commit {} integrity mismatch",
            commit.commit_id
        )));
    }

    Ok(())
}

fn verify_existing_commit_metadata(
    conn: &VaultConnection,
    serialized: &SerializedCommit,
) -> StorageResult<()> {
    let commit = &serialized.commit;
    let stored = conn
        .inner()
        .query_row(
            "SELECT device_id, local_seq, commit_kind, change_scope,
                    changed_object_ids_ct, vector_clock, message_ct, created_at,
                    integrity_tag
             FROM commits WHERE commit_id = ?1",
            params![commit.commit_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<Vec<u8>>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Vec<u8>>(8)?,
                ))
            },
        )
        .optional()?;
    let Some((
        device_id,
        local_seq,
        commit_kind,
        change_scope,
        changed_object_ids_ct,
        vector_clock,
        message_ct,
        created_at,
        integrity_tag,
    )) = stored
    else {
        return Err(StorageError::Validation(format!(
            "incoming commit {} disappeared during replay validation",
            commit.commit_id
        )));
    };
    let stored_parents = CommitGraphRepo::parent_ids(conn, &commit.commit_id)?;
    let mut incoming_parents = serialized.parent_ids.clone();
    incoming_parents.sort();

    if device_id != commit.device_id
        || local_seq < 0
        || local_seq as u64 != commit.local_seq
        || commit_kind != commit.commit_kind.to_string()
        || change_scope != commit.change_scope.to_string()
        || changed_object_ids_ct != commit.changed_object_ids_ct
        || vector_clock != commit.vector_clock
        || message_ct != commit.message_ct
        || created_at != commit.created_at
        || integrity_tag != commit.integrity_tag
        || stored_parents != incoming_parents
    {
        return Err(StorageError::Validation(format!(
            "incoming commit {} conflicts with existing metadata",
            commit.commit_id
        )));
    }

    Ok(())
}

pub(super) fn acknowledge_received_tombstones(
    conn: &VaultConnection,
    ctx: &CommitContext,
    serialized: &SerializedCommit,
) -> StorageResult<()> {
    for tombstone in &serialized.tombstones {
        if TombstoneRepo::is_permanently_purged(
            conn,
            &tombstone.target_object_type,
            &tombstone.target_object_id,
        )? {
            continue;
        }
        TombstoneAcknowledgementRepo::merge(
            conn,
            &tombstone.tombstone_id,
            &ctx.device_id,
            &serialized.commit.commit_id,
            &chrono::Utc::now().to_rfc3339(),
        )?;
    }
    Ok(())
}

fn insert_operation(
    conn: &VaultConnection,
    commit_id: &str,
    created_at: &str,
    operation: &CommitOperationMetadata,
) -> StorageResult<()> {
    let mut stmt = conn.inner().prepare(
        "SELECT operation_id, commit_id, operation_kind, branch_id, branch_name,
                change_summary_ct, request_hash, created_at, integrity_tag
         FROM commit_operations WHERE operation_id = ?1 OR commit_id = ?2",
    )?;
    let rows = stmt.query_map(params![operation.operation_id, commit_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Vec<u8>>(5)?,
            row.get::<_, Vec<u8>>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Vec<u8>>(8)?,
        ))
    })?;
    let mut found = false;
    for row in rows {
        found = true;
        let (
            operation_id,
            existing_commit_id,
            operation_kind,
            branch_id,
            branch_name,
            change_summary_ct,
            request_hash,
            existing_created_at,
            integrity_tag,
        ) = row?;
        if operation_id != operation.operation_id
            || existing_commit_id != commit_id
            || operation_kind != operation.operation_kind
            || branch_id != operation.branch_id
            || branch_name != operation.branch_name
            || change_summary_ct != operation.change_summary_ct
            || request_hash != operation.request_hash
            || existing_created_at != created_at
            || integrity_tag != operation.integrity_tag
        {
            return Err(StorageError::Validation(format!(
                "incoming operation {} conflicts with existing metadata",
                operation.operation_id
            )));
        }
    }
    if found {
        return Ok(());
    }

    conn.inner().execute(
        "INSERT INTO commit_operations
         (operation_id, commit_id, operation_kind, branch_id, branch_name,
          change_summary_ct, request_hash, created_at, integrity_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            operation.operation_id,
            commit_id,
            operation.operation_kind,
            operation.branch_id,
            operation.branch_name,
            operation.change_summary_ct,
            operation.request_hash,
            created_at,
            operation.integrity_tag,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyOutcome {
    Applied,
    Skipped,
    Conflict,
    MissingParent,
}
