use mdbx_sync::CommitBatch;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::CommitContext;
use crate::sync_delta::{
    decode_sync_delta_body, load_sync_delta_envelope, persist_envelope, SyncDeltaBatchKind,
    SyncDeltaEnvelope, SyncDeltaLimits,
};
use crate::sync_state::SyncStateLimits;
use crate::unlock::UnlockService;

use super::{
    commit_ingest_apply, key_epoch_apply, lifecycle_apply, payload_apply, state_apply,
    ApplyBatchResult, SyncApplyRepo,
};

impl SyncApplyRepo {
    pub fn apply_auxiliary_delta(
        conn: &VaultConnection,
        ctx: &CommitContext,
        envelope: &SyncDeltaEnvelope,
    ) -> StorageResult<u32> {
        Self::apply_auxiliary_delta_with_limits(conn, ctx, envelope, SyncDeltaLimits::default())
    }

    pub fn apply_auxiliary_delta_with_limits(
        conn: &VaultConnection,
        ctx: &CommitContext,
        envelope: &SyncDeltaEnvelope,
        limits: SyncDeltaLimits,
    ) -> StorageResult<u32> {
        envelope.verify(conn, limits)?;
        if envelope.batch_kind != SyncDeltaBatchKind::Auxiliary {
            return Err(StorageError::Validation(
                "auxiliary sync apply requires an auxiliary delta".to_string(),
            ));
        }
        if let Some(existing) = load_sync_delta_envelope(conn, &envelope.batch_id, limits)? {
            if existing == *envelope {
                return Ok(0);
            }
            return Err(StorageError::Validation(format!(
                "sync delta batch {} conflicts with stored content",
                envelope.batch_id
            )));
        }
        conn.with_immediate_transaction_and_sync_limits(limits, || {
            let body = decode_sync_delta_body(envelope, limits)?;
            let conflicts = state_apply::apply_sync_state(
                conn,
                ctx,
                "",
                &body.state,
                key_epoch_apply::MergeMode::FastForward,
                false,
                false,
            )?;
            lifecycle_apply::apply_delta_device_heads(conn, &body.device_heads)?;
            lifecycle_apply::apply_delta_deletions(conn, &body)?;
            persist_envelope(conn, envelope)?;
            payload_apply::discard_received_delta_mutations(conn, &[])?;
            Ok(conflicts)
        })
    }

    /// Applies legacy-compatible sync batches through an immutable connection.
    /// Key epoch state may be inspected but cannot change through this entry.
    pub fn apply_batch(
        conn: &VaultConnection,
        ctx: &CommitContext,
        batch: &CommitBatch,
    ) -> StorageResult<ApplyBatchResult> {
        Self::apply_batch_with_limits(conn, ctx, batch, SyncStateLimits::default())
    }

    /// Applies a sync batch with an explicit bounded complete-state contract.
    pub fn apply_batch_with_limits(
        conn: &VaultConnection,
        ctx: &CommitContext,
        batch: &CommitBatch,
        sync_limits: SyncStateLimits,
    ) -> StorageResult<ApplyBatchResult> {
        commit_ingest_apply::apply_batch_inner(conn, ctx, batch, false, sync_limits)
    }

    /// Applies sync batches through a mutable connection. Epoch changes require
    /// verified unlock state and refresh all epoch keyrings before returning.
    pub fn apply_batch_mut(
        conn: &mut VaultConnection,
        ctx: &CommitContext,
        batch: &CommitBatch,
    ) -> StorageResult<ApplyBatchResult> {
        Self::apply_batch_mut_with_limits(conn, ctx, batch, SyncStateLimits::default())
    }

    /// Mutable sync apply with an explicit bounded complete-state contract.
    pub fn apply_batch_mut_with_limits(
        conn: &mut VaultConnection,
        ctx: &CommitContext,
        batch: &CommitBatch,
        sync_limits: SyncStateLimits,
    ) -> StorageResult<ApplyBatchResult> {
        let result = commit_ingest_apply::apply_batch_inner(conn, ctx, batch, true, sync_limits)?;
        if conn.active_key_epoch_id().is_some() {
            if let Err(error) = UnlockService::refresh_verified_keyring(conn) {
                conn.clear_session();
                return Err(error);
            }
        }
        Ok(result)
    }

    /// Atomically apply one incremental transfer segment.
    ///
    /// Commit-associated deltas are carried by `batch`; audit-only and other
    /// auxiliary deltas are applied in the same SQLite transaction. A failure
    /// anywhere in the segment leaves no partially applied domain state.
    pub fn apply_incremental_batch_mut(
        conn: &mut VaultConnection,
        ctx: &CommitContext,
        batch: &CommitBatch,
        auxiliary_deltas: &[SyncDeltaEnvelope],
    ) -> StorageResult<ApplyBatchResult> {
        let delta_limits = SyncDeltaLimits::default();
        for envelope in auxiliary_deltas {
            envelope.verify(conn, delta_limits)?;
            if envelope.batch_kind != SyncDeltaBatchKind::Auxiliary {
                return Err(StorageError::Validation(
                    "incremental auxiliary payload contains a commit delta".to_string(),
                ));
            }
        }

        let mut result = conn.with_immediate_transaction_mut(|conn| {
            let mut result = commit_ingest_apply::apply_batch_inner(
                conn,
                ctx,
                batch,
                true,
                SyncStateLimits::default(),
            )?;
            if result.missing_parent_count != 0 {
                return Err(StorageError::Validation(format!(
                    "incremental segment is missing {} commit parent(s)",
                    result.missing_parent_count
                )));
            }
            for envelope in auxiliary_deltas {
                result.conflict_count = result
                    .conflict_count
                    .checked_add(Self::apply_auxiliary_delta_with_limits(
                        conn,
                        ctx,
                        envelope,
                        delta_limits,
                    )?)
                    .ok_or_else(|| {
                        StorageError::Validation("incremental conflict count overflow".to_string())
                    })?;
            }
            Ok(result)
        })?;

        if conn.active_key_epoch_id().is_some() {
            if let Err(error) = UnlockService::refresh_verified_keyring(conn) {
                conn.clear_session();
                return Err(error);
            }
        }
        result.missing_parent_count = 0;
        Ok(result)
    }
}
