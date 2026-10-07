use crate::connection::VaultConnection;
use crate::error::StorageResult;
use crate::repo::CommitContext;
use crate::sync_state::{persist_sync_state_extensions, SyncStatePayload};

use super::{
    attachment_apply, commit_graph_apply, entry_apply, generic_metadata_apply, key_epoch_apply,
    lifecycle_apply, project_apply, tiga_apply,
};

pub(super) fn apply_sync_state(
    conn: &VaultConnection,
    ctx: &CommitContext,
    incoming_commit_id: &str,
    state: &SyncStatePayload,
    key_epoch_merge_mode: key_epoch_apply::MergeMode,
    allow_key_epoch_changes: bool,
    complete_tombstone_state: bool,
) -> StorageResult<u32> {
    let mut conflicts = 0;
    if let Some(key_epoch_state) = &state.key_epoch_state {
        key_epoch_apply::apply(
            conn,
            key_epoch_state,
            key_epoch_merge_mode,
            allow_key_epoch_changes,
        )?;
    }
    if let Some(receipts) = &state.purge_receipts {
        lifecycle_apply::apply_purge_receipts(conn, receipts)?;
    }
    conflicts += project_apply::apply_projects(conn, ctx, incoming_commit_id, &state.projects)?;
    conflicts += entry_apply::apply_entries(conn, ctx, incoming_commit_id, &state.entries)?;
    if let Some(labels) = &state.object_labels {
        conflicts += generic_metadata_apply::apply_object_labels(conn, ctx, labels)?;
    }
    if let Some(relations) = &state.object_relations {
        conflicts += generic_metadata_apply::apply_object_relations(conn, ctx, relations)?;
    }
    if let Some(assignments) = &state.object_label_assignments {
        conflicts +=
            generic_metadata_apply::apply_object_label_assignments(conn, ctx, assignments)?;
    }
    let replace_attachment_chunks =
        attachment_apply::apply_attachments(conn, ctx, incoming_commit_id, &state.attachments)?;
    conflicts += replace_attachment_chunks.conflict_count;
    attachment_apply::apply_attachment_chunks(
        conn,
        &state.attachment_chunks,
        &replace_attachment_chunks.ids,
    )?;
    if let Some(project_tags) = &state.project_tags {
        project_apply::apply_project_tags(conn, project_tags)?;
    }
    if let Some(vault_state) = &state.tiga_vault_state {
        tiga_apply::apply_tiga_vault_state(conn, vault_state)?;
    }
    if let Some(exceptions) = &state.tiga_policy_exceptions {
        tiga_apply::apply_tiga_policy_exceptions(conn, exceptions)?;
    }
    if let Some(overrides) = &state.tiga_policy_overrides {
        tiga_apply::apply_tiga_policy_overrides(conn, overrides)?;
    }
    if let Some(audit_events) = &state.security_audit_events {
        tiga_apply::apply_security_audit_events(conn, audit_events)?;
    }
    commit_graph_apply::apply_branches(conn, &state.branches)?;
    if let Some(tombstones) = &state.tombstones {
        if complete_tombstone_state
            && matches!(
                key_epoch_merge_mode,
                key_epoch_apply::MergeMode::FastForward
            )
            && conflicts == 0
        {
            lifecycle_apply::apply_complete_tombstone_state(conn, tombstones)?;
        } else if !complete_tombstone_state {
            lifecycle_apply::apply_delta_tombstone_state(conn, tombstones)?;
        }
    }
    if let Some(acknowledgements) = &state.tombstone_acknowledgements {
        lifecycle_apply::apply_tombstone_acknowledgements(conn, acknowledgements)?;
    }
    persist_sync_state_extensions(conn, &state.extensions, incoming_commit_id)?;
    Ok(conflicts)
}
