use std::collections::HashSet;

use rusqlite::params;

use mdbx_core::model::ConflictObjectType;
use mdbx_sync::{ObjectPayload, SerializedCommit};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{CommitContext, CommitGraphRepo, ConflictRepo};
use crate::sync_delta::{
    decode_sync_delta_body, decode_sync_delta_object_payload, load_sync_delta_envelope,
    persist_envelope, SyncDeltaBatchKind, SyncDeltaEnvelope, SyncDeltaLimits,
};
use crate::sync_state::{decode_sync_state_payload_with_limits, SyncStateLimits};

use super::{key_epoch_apply, lifecycle_apply, state_apply};

#[derive(Debug, Clone, Default)]
pub(super) struct PayloadApplyResult {
    pub(super) conflicts: u32,
    pub(super) received_delta: bool,
    pub(super) received_complete_state: bool,
    pub(super) delta_commit_ids: Vec<String>,
}

pub(super) fn apply_fast_forward_payloads(
    conn: &VaultConnection,
    ctx: &CommitContext,
    serialized: &SerializedCommit,
    allow_key_epoch_changes: bool,
    sync_limits: SyncStateLimits,
) -> StorageResult<PayloadApplyResult> {
    let mut result = PayloadApplyResult::default();
    for payload in &serialized.object_payloads {
        if let Some(envelope) =
            decode_sync_delta_object_payload(conn, payload, SyncDeltaLimits::default())?
        {
            if result.received_delta || result.received_complete_state {
                return Err(StorageError::Validation(
                    "a commit cannot carry multiple sync delta envelopes".to_string(),
                ));
            }
            result.conflicts += apply_commit_sync_delta(
                conn,
                ctx,
                serialized,
                &envelope,
                key_epoch_apply::MergeMode::FastForward,
                allow_key_epoch_changes,
            )?;
            result.received_delta = true;
            result.delta_commit_ids = envelope.commit_ids.clone();
        } else if let Some(state) = decode_sync_state_payload_with_limits(payload, sync_limits)? {
            if result.received_delta || result.received_complete_state {
                return Err(StorageError::Validation(
                    "a commit cannot mix complete sync state and a state delta".to_string(),
                ));
            }
            result.conflicts += state_apply::apply_sync_state(
                conn,
                ctx,
                &serialized.commit.commit_id,
                &state,
                key_epoch_apply::MergeMode::FastForward,
                allow_key_epoch_changes,
                true,
            )?;
            result.received_complete_state = true;
        }
    }
    Ok(result)
}

pub(super) fn apply_divergent_payloads(
    conn: &VaultConnection,
    ctx: &CommitContext,
    serialized: &SerializedCommit,
    local_head: Option<&str>,
    allow_key_epoch_changes: bool,
    sync_limits: SyncStateLimits,
) -> StorageResult<PayloadApplyResult> {
    let mut result = PayloadApplyResult::default();
    for payload in &serialized.object_payloads {
        if let Some(envelope) =
            decode_sync_delta_object_payload(conn, payload, SyncDeltaLimits::default())?
        {
            if result.received_delta || result.received_complete_state {
                return Err(StorageError::Validation(
                    "a commit cannot carry multiple sync delta envelopes".to_string(),
                ));
            }
            result.conflicts += apply_commit_sync_delta(
                conn,
                ctx,
                serialized,
                &envelope,
                key_epoch_apply::MergeMode::Divergent,
                allow_key_epoch_changes,
            )?;
            result.received_delta = true;
            result.delta_commit_ids = envelope.commit_ids.clone();
        } else if let Some(state) = decode_sync_state_payload_with_limits(payload, sync_limits)? {
            if result.received_delta || result.received_complete_state {
                return Err(StorageError::Validation(
                    "a commit cannot mix complete sync state and a state delta".to_string(),
                ));
            }
            result.conflicts += state_apply::apply_sync_state(
                conn,
                ctx,
                &serialized.commit.commit_id,
                &state,
                key_epoch_apply::MergeMode::Divergent,
                allow_key_epoch_changes,
                true,
            )?;
            result.received_complete_state = true;
        } else {
            result.conflicts +=
                record_payload_conflict(conn, ctx, serialized, payload, local_head)?;
        }
    }
    Ok(result)
}

fn apply_commit_sync_delta(
    conn: &VaultConnection,
    ctx: &CommitContext,
    serialized: &SerializedCommit,
    envelope: &SyncDeltaEnvelope,
    merge_mode: key_epoch_apply::MergeMode,
    allow_key_epoch_changes: bool,
) -> StorageResult<u32> {
    if envelope.batch_kind != SyncDeltaBatchKind::Commit {
        return Err(StorageError::Validation(
            "a serialized commit requires a commit-associated sync delta".to_string(),
        ));
    }
    if envelope.commit_ids.last() != Some(&serialized.commit.commit_id) {
        return Err(StorageError::Validation(
            "sync delta must be attached to its final associated commit".to_string(),
        ));
    }
    for commit_id in &envelope.commit_ids {
        if !CommitGraphRepo::commit_exists(conn, commit_id)? {
            return Err(StorageError::ConstraintViolation(format!(
                "sync delta references unavailable commit {commit_id}"
            )));
        }
    }
    if let Some(existing) =
        load_sync_delta_envelope(conn, &envelope.batch_id, SyncDeltaLimits::default())?
    {
        if existing == *envelope {
            return Ok(0);
        }
        return Err(StorageError::Validation(format!(
            "sync delta batch {} conflicts with stored content",
            envelope.batch_id
        )));
    }
    let body = decode_sync_delta_body(envelope, SyncDeltaLimits::default())?;
    let conflicts = state_apply::apply_sync_state(
        conn,
        ctx,
        &serialized.commit.commit_id,
        &body.state,
        merge_mode,
        allow_key_epoch_changes,
        false,
    )?;
    lifecycle_apply::apply_delta_device_heads(conn, &body.device_heads)?;
    lifecycle_apply::apply_delta_deletions(conn, &body)?;
    persist_envelope(conn, envelope)?;
    Ok(conflicts)
}

pub(super) fn discard_received_delta_mutations(
    conn: &VaultConnection,
    incoming_commit_ids: &[String],
) -> StorageResult<()> {
    let incoming = incoming_commit_ids.iter().collect::<HashSet<_>>();
    let mut stmt = conn.inner().prepare(
        "SELECT mutation_seq, entity_id FROM sync_delta_mutations
         WHERE entity_kind = 'commit' ORDER BY mutation_seq",
    )?;
    let commits = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut first_local_sequence = None;
    for row in commits {
        let (sequence, commit_id) = row?;
        if !incoming.contains(&commit_id) {
            first_local_sequence = Some(sequence);
            break;
        }
    }
    match first_local_sequence {
        Some(sequence) => {
            conn.inner().execute(
                "DELETE FROM sync_delta_mutations WHERE mutation_seq < ?1",
                [sequence],
            )?;
        }
        None => crate::schema::v14::discard_captured_mutations(conn.inner())?,
    }
    Ok(())
}

fn record_payload_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    serialized: &SerializedCommit,
    payload: &ObjectPayload,
    local_head: Option<&str>,
) -> StorageResult<u32> {
    let local_head = local_head.ok_or_else(|| {
        StorageError::Validation("missing local branch head for conflict detection".into())
    })?;

    let object_type = conflict_object_type(&payload.object_type);
    let Some(object_type) = object_type else {
        return Ok(0);
    };
    let local_exists = match payload.object_type.as_str() {
        "project" => exists(conn, "projects", "project_id", &payload.object_id)?,
        "entry" => exists(conn, "entries", "entry_id", &payload.object_id)?,
        "attachment" => exists(conn, "attachments", "attachment_id", &payload.object_id)?,
        _ => false,
    };
    if !local_exists || local_head == serialized.commit.commit_id {
        return Ok(0);
    }
    if ConflictRepo::has_unresolved_conflict(conn, object_type.clone(), &payload.object_id)? {
        return Ok(0);
    }

    let base_commit_id = CommitGraphRepo::nearest_known_common_parent(
        conn,
        local_head,
        &serialized.commit.commit_id,
    )?
    .unwrap_or_else(|| local_head.to_string());
    ConflictRepo::create(
        conn,
        ctx,
        object_type,
        &payload.object_id,
        &base_commit_id,
        local_head,
        &serialized.commit.commit_id,
        &[String::from("payload_ct")],
    )?;
    Ok(1)
}

fn conflict_object_type(value: &str) -> Option<ConflictObjectType> {
    match value {
        "project" => Some(ConflictObjectType::Project),
        "entry" => Some(ConflictObjectType::Entry),
        "attachment" => Some(ConflictObjectType::Attachment),
        _ => None,
    }
}

fn exists(
    conn: &VaultConnection,
    table: &str,
    id_column: &str,
    object_id: &str,
) -> StorageResult<bool> {
    let sql = format!("SELECT COUNT(*) FROM {} WHERE {} = ?1", table, id_column);
    let count: i64 = conn
        .inner()
        .query_row(&sql, params![object_id], |row| row.get(0))?;
    Ok(count > 0)
}
