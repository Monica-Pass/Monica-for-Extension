use std::collections::HashSet;

use chrono::Utc;
use mdbx_core::model::{ChangeScope, Commit, CommitKind};
use mdbx_sync::{
    build_bundle, incremental_bundle_payload_sha256, CommitBatch, CommitOperationMetadata,
    IncrementalBundleCheckpoint, IncrementalBundleManifest, IncrementalBundleResume,
    IncrementalCommitInventoryEntry, IncrementalDeltaInventoryEntry, IncrementalDeltaKind,
    IncrementalSyncBundle, SerializedCommit, SyncBundle, TombstoneRecord,
    INCREMENTAL_BUNDLE_FORMAT, MAX_INCREMENTAL_BUNDLE_COMMITS,
};
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{
    CommitContext, CommitInventoryItem, CommitInventoryRepo, SyncDeltaInventoryItem,
    SyncDeltaInventoryRepo, MAX_COMMIT_INVENTORY_PAGE_SIZE, MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE,
};
use crate::sync_apply::{ApplyBatchResult, SyncApplyRepo};
use crate::sync_delta::{
    decode_sync_delta_object_payload, load_sync_delta_envelope, sync_delta_object_payload,
    SyncDeltaBatchKind, SyncDeltaLimits,
};
use crate::sync_state::collect_sync_state_payload;

pub const DEFAULT_PEER_SYNC_SEGMENT_PAGE_SIZE: usize = 128;
pub const MAX_PEER_SYNC_SEGMENT_PAGE_SIZE: usize =
    if MAX_COMMIT_INVENTORY_PAGE_SIZE < MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE {
        MAX_COMMIT_INVENTORY_PAGE_SIZE
    } else {
        MAX_SYNC_DELTA_INVENTORY_PAGE_SIZE
    };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerSyncSegmentOptions {
    pub page_size: usize,
}

impl Default for PeerSyncSegmentOptions {
    fn default() -> Self {
        Self {
            page_size: DEFAULT_PEER_SYNC_SEGMENT_PAGE_SIZE,
        }
    }
}

impl PeerSyncSegmentOptions {
    fn validate(self) -> StorageResult<Self> {
        if !(1..=MAX_PEER_SYNC_SEGMENT_PAGE_SIZE).contains(&self.page_size) {
            return Err(StorageError::Validation(format!(
                "peer sync page size must be between 1 and {MAX_PEER_SYNC_SEGMENT_PAGE_SIZE}"
            )));
        }
        Ok(self)
    }
}

/// Storage-owned incremental synchronization boundary.
///
/// Transport clients persist checkpoints and immutable segment bytes outside
/// the vault. This service owns inventory paging, authenticated state-delta
/// attachment, segment-chain validation, and atomic apply semantics.
pub struct PeerSyncService;

impl PeerSyncService {
    pub fn export_complete_bundle(
        conn: &VaultConnection,
        source_device_id: &str,
    ) -> StorageResult<SyncBundle> {
        validate_device_id(source_device_id)?;
        let vault_id = vault_id(conn)?;
        let mut commits = load_serialized_commits(conn)?;
        if let Some(last) = commits.last_mut() {
            last.object_payloads.push(collect_sync_state_payload(conn)?);
        }
        Ok(build_bundle(&vault_id, source_device_id, commits))
    }

    pub fn current_checkpoint(
        conn: &VaultConnection,
    ) -> StorageResult<IncrementalBundleCheckpoint> {
        ensure_unlocked(conn)?;
        Ok(IncrementalBundleCheckpoint {
            commit_inventory: Some(CommitInventoryRepo::checkpoint(conn)?),
            delta_inventory: Some(SyncDeltaInventoryRepo::checkpoint(conn)?),
        })
    }

    pub fn export_incremental_segment(
        conn: &VaultConnection,
        source_device_id: &str,
        base: &IncrementalBundleCheckpoint,
        resume: Option<&IncrementalBundleResume>,
        options: PeerSyncSegmentOptions,
    ) -> StorageResult<IncrementalSyncBundle> {
        ensure_unlocked(conn)?;
        validate_device_id(source_device_id)?;
        validate_bootstrap_checkpoint(base, "incremental export base")?;
        if resume.is_none() && base.commit_inventory.is_none() {
            // A paired empty checkpoint is the explicit MDBX3 segmented
            // bootstrap marker. It remains wire-compatible with MDBX2,
            // whose peers negotiate complete-state fallback.
        } else if resume.is_some() && base.commit_inventory.is_none() {
            return Err(StorageError::Validation(
                "incremental resume requires a completed bootstrap checkpoint pair".to_string(),
            ));
        }
        validate_resume(resume)?;
        let options = options.validate()?;
        let vault_id = vault_id(conn)?;
        let (commit_items, commit_checkpoint, more_commits) =
            load_commit_inventory_after(conn, base.commit_inventory.as_deref(), options.page_size)?;
        let (delta_items, delta_checkpoint, more_deltas) =
            load_delta_inventory_after(conn, base.delta_inventory.as_deref(), options.page_size)?;

        let mut transported = Vec::with_capacity(commit_items.len());
        for item in commit_items {
            let commit = load_serialized_commit(conn, &item.commit_id)?;
            transported.push((item, commit));
        }
        let mut transported_ids = transported
            .iter()
            .map(|(_, commit)| commit.commit.commit_id.clone())
            .collect::<HashSet<_>>();
        let mut delta_inventory = Vec::with_capacity(delta_items.len());
        let mut auxiliary_deltas = Vec::new();

        for item in delta_items {
            let envelope =
                load_sync_delta_envelope(conn, &item.batch_id, SyncDeltaLimits::default())?
                    .ok_or_else(|| {
                        StorageError::ConstraintViolation(format!(
                            "sync delta batch {} disappeared during export",
                            item.batch_id
                        ))
                    })?;
            let payload = sync_delta_object_payload(&envelope, SyncDeltaLimits::default())?;
            let payload_digest = Sha256::digest(&payload.ciphertext).to_vec();
            match envelope.batch_kind {
                SyncDeltaBatchKind::Commit => {
                    let final_commit_id = envelope.commit_ids.last().ok_or_else(|| {
                        StorageError::ConstraintViolation(format!(
                            "commit delta batch {} has no final commit",
                            item.batch_id
                        ))
                    })?;
                    if transported_ids.insert(final_commit_id.clone()) {
                        let inventory_seq = commit_inventory_sequence(conn, final_commit_id)?;
                        transported.push((
                            CommitInventoryItem {
                                inventory_seq,
                                commit_id: final_commit_id.clone(),
                            },
                            load_serialized_commit(conn, final_commit_id)?,
                        ));
                    }
                    let final_commit = transported
                        .iter_mut()
                        .find(|(_, commit)| commit.commit.commit_id == *final_commit_id)
                        .ok_or_else(|| {
                            StorageError::ConstraintViolation(format!(
                                "commit delta batch {} final commit could not be loaded",
                                item.batch_id
                            ))
                        })?;
                    final_commit.1.object_payloads.push(payload);
                    delta_inventory.push(IncrementalDeltaInventoryEntry {
                        batch_seq: item.batch_seq,
                        batch_id: item.batch_id,
                        batch_kind: IncrementalDeltaKind::Commit,
                        commit_ids: envelope.commit_ids,
                        object_payload_sha256: payload_digest,
                    });
                }
                SyncDeltaBatchKind::Auxiliary => {
                    auxiliary_deltas.push(payload);
                    delta_inventory.push(IncrementalDeltaInventoryEntry {
                        batch_seq: item.batch_seq,
                        batch_id: item.batch_id,
                        batch_kind: IncrementalDeltaKind::Auxiliary,
                        commit_ids: Vec::new(),
                        object_payload_sha256: payload_digest,
                    });
                }
            }
        }

        transported.sort_by_key(|(inventory, _)| inventory.inventory_seq);
        if transported.len() > MAX_INCREMENTAL_BUNDLE_COMMITS {
            return Err(StorageError::ResourceLimit {
                resource: "incremental bundle commits".to_string(),
                actual: transported.len() as u64,
                limit: MAX_INCREMENTAL_BUNDLE_COMMITS as u64,
            });
        }
        let (commit_inventory, commits): (Vec<_>, Vec<_>) = transported
            .into_iter()
            .map(|(inventory, commit)| {
                (
                    IncrementalCommitInventoryEntry {
                        inventory_seq: inventory.inventory_seq,
                        commit_id: inventory.commit_id,
                    },
                    commit,
                )
            })
            .unzip();
        let (transfer_id, segment_index, previous_segment_sha256) = match resume {
            Some(resume) => (
                resume.transfer_id.clone(),
                resume.next_segment_index,
                Some(resume.previous_segment_sha256.clone()),
            ),
            None => (uuid::Uuid::new_v4().to_string(), 0, None),
        };
        let bundle = IncrementalSyncBundle {
            manifest: IncrementalBundleManifest {
                format: INCREMENTAL_BUNDLE_FORMAT.to_string(),
                vault_id,
                source_device_id: source_device_id.to_string(),
                exported_at: Utc::now().to_rfc3339(),
                transfer_id,
                segment_index,
                previous_segment_sha256,
                is_last: !more_commits && !more_deltas,
                base: base.clone(),
                result: IncrementalBundleCheckpoint {
                    commit_inventory: Some(commit_checkpoint),
                    delta_inventory: Some(delta_checkpoint),
                },
                commit_inventory,
                delta_inventory,
            },
            commits,
            auxiliary_deltas,
        };
        bundle.validate().map_err(map_sync_error)?;
        Ok(bundle)
    }

    pub fn apply_incremental_segment(
        conn: &mut VaultConnection,
        receiver_device_id: &str,
        bundle: &IncrementalSyncBundle,
        expected_base: &IncrementalBundleCheckpoint,
        expected_resume: Option<&IncrementalBundleResume>,
    ) -> StorageResult<ApplyBatchResult> {
        ensure_unlocked(conn)?;
        validate_device_id(receiver_device_id)?;
        validate_bootstrap_checkpoint(expected_base, "incremental apply base")?;
        if expected_resume.is_some() && expected_base.commit_inventory.is_none() {
            return Err(StorageError::Validation(
                "incremental resume requires a completed bootstrap checkpoint pair".to_string(),
            ));
        }
        validate_resume(expected_resume)?;
        bundle.validate().map_err(map_sync_error)?;
        let local_vault_id = vault_id(conn)?;
        if bundle.manifest.vault_id != local_vault_id {
            return Err(StorageError::ConstraintViolation(format!(
                "bundle vault_id {} does not match local vault_id {}",
                bundle.manifest.vault_id, local_vault_id
            )));
        }
        if &bundle.manifest.base != expected_base {
            return Err(StorageError::ConstraintViolation(
                "incremental bundle base checkpoint does not match saved peer state".to_string(),
            ));
        }
        validate_segment_chain(bundle, expected_resume)?;

        let mut auxiliary_envelopes = Vec::with_capacity(bundle.auxiliary_deltas.len());
        for delta in &bundle.manifest.delta_inventory {
            if delta.batch_kind != IncrementalDeltaKind::Auxiliary {
                continue;
            }
            let payload = bundle
                .auxiliary_deltas
                .iter()
                .find(|payload| payload.object_id == delta.batch_id)
                .ok_or_else(|| {
                    StorageError::ConstraintViolation(format!(
                        "missing auxiliary delta payload {}",
                        delta.batch_id
                    ))
                })?;
            let envelope =
                decode_sync_delta_object_payload(conn, payload, SyncDeltaLimits::default())?
                    .ok_or_else(|| {
                        StorageError::Validation(format!(
                            "unrecognized auxiliary delta payload {}",
                            delta.batch_id
                        ))
                    })?;
            auxiliary_envelopes.push(envelope);
        }
        SyncApplyRepo::apply_incremental_batch_mut(
            conn,
            &CommitContext::new(receiver_device_id.to_string()),
            &CommitBatch::new(bundle.commits.clone(), 0, true),
            &auxiliary_envelopes,
        )
    }

    pub fn next_resume(
        bundle: &IncrementalSyncBundle,
    ) -> StorageResult<Option<IncrementalBundleResume>> {
        bundle.validate().map_err(map_sync_error)?;
        if bundle.manifest.is_last {
            return Ok(None);
        }
        let next_segment_index = bundle
            .manifest
            .segment_index
            .checked_add(1)
            .ok_or_else(|| {
                StorageError::Validation("incremental segment index overflow".to_string())
            })?;
        Ok(Some(IncrementalBundleResume {
            transfer_id: bundle.manifest.transfer_id.clone(),
            next_segment_index,
            previous_segment_sha256: incremental_bundle_payload_sha256(bundle)
                .map_err(map_sync_error)?,
        }))
    }
}

fn ensure_unlocked(conn: &VaultConnection) -> StorageResult<()> {
    if conn.keyring().is_none() {
        return Err(StorageError::Validation(
            "peer synchronization requires an unlocked vault".to_string(),
        ));
    }
    Ok(())
}

fn validate_device_id(device_id: &str) -> StorageResult<()> {
    if device_id.trim().is_empty() || device_id.len() > 256 {
        return Err(StorageError::Validation(
            "peer sync device ID must contain 1 to 256 bytes".to_string(),
        ));
    }
    Ok(())
}

fn validate_bootstrap_checkpoint(
    checkpoint: &IncrementalBundleCheckpoint,
    label: &str,
) -> StorageResult<()> {
    if checkpoint.commit_inventory.is_some() != checkpoint.delta_inventory.is_some() {
        return Err(StorageError::Validation(format!(
            "{label} must contain a paired checkpoint or a paired empty bootstrap marker"
        )));
    }
    Ok(())
}

fn validate_resume(resume: Option<&IncrementalBundleResume>) -> StorageResult<()> {
    if let Some(resume) = resume {
        if resume.transfer_id.is_empty()
            || resume.next_segment_index == 0
            || resume.previous_segment_sha256.len() != 32
        {
            return Err(StorageError::Validation(
                "invalid incremental transfer resume state".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_segment_chain(
    bundle: &IncrementalSyncBundle,
    expected_resume: Option<&IncrementalBundleResume>,
) -> StorageResult<()> {
    match expected_resume {
        Some(resume)
            if resume.transfer_id == bundle.manifest.transfer_id
                && resume.next_segment_index == bundle.manifest.segment_index
                && bundle.manifest.previous_segment_sha256.as_deref()
                    == Some(resume.previous_segment_sha256.as_slice()) =>
        {
            Ok(())
        }
        Some(_) => Err(StorageError::ConstraintViolation(
            "incremental bundle does not match the saved transfer resume state".to_string(),
        )),
        None if bundle.manifest.segment_index == 0
            && bundle.manifest.previous_segment_sha256.is_none() =>
        {
            Ok(())
        }
        None => Err(StorageError::ConstraintViolation(
            "resumed incremental bundle requires matching transfer state".to_string(),
        )),
    }
}

fn load_commit_inventory_after(
    conn: &VaultConnection,
    checkpoint: Option<&str>,
    page_size: usize,
) -> StorageResult<(Vec<CommitInventoryItem>, String, bool)> {
    let page = CommitInventoryRepo::list(conn, checkpoint, page_size, None)?;
    let has_more = page.next_cursor.is_some();
    let result_checkpoint = if has_more {
        CommitInventoryRepo::checkpoint_after(conn, page.items.last())?
    } else {
        page.checkpoint
    };
    Ok((page.items, result_checkpoint, has_more))
}

fn load_delta_inventory_after(
    conn: &VaultConnection,
    checkpoint: Option<&str>,
    page_size: usize,
) -> StorageResult<(Vec<SyncDeltaInventoryItem>, String, bool)> {
    let page = SyncDeltaInventoryRepo::list(conn, checkpoint, page_size, None)?;
    let has_more = page.next_cursor.is_some();
    let result_checkpoint = if has_more {
        SyncDeltaInventoryRepo::checkpoint_after(conn, page.items.last())?
    } else {
        page.checkpoint
    };
    Ok((page.items, result_checkpoint, has_more))
}

fn commit_inventory_sequence(conn: &VaultConnection, commit_id: &str) -> StorageResult<u64> {
    let sequence = conn.inner().query_row(
        "SELECT inventory_seq FROM commit_inventory WHERE commit_id = ?1",
        [commit_id],
        |row| row.get::<_, i64>(0),
    )?;
    u64::try_from(sequence).map_err(|error| {
        StorageError::Validation(format!(
            "invalid inventory sequence for commit {commit_id}: {error}"
        ))
    })
}

fn vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::from)
}

fn load_serialized_commits(conn: &VaultConnection) -> StorageResult<Vec<SerializedCommit>> {
    let mut statement = conn.inner().prepare(
        "SELECT commit_id, device_id, local_seq, commit_kind, change_scope,
                changed_object_ids_ct, vector_clock, message_ct, created_at, integrity_tag
         FROM commits
         ORDER BY created_at ASC, device_id ASC, local_seq ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let commit_id: String = row.get(0)?;
        Ok(SerializedCommit {
            parent_ids: parent_ids_for_commit(conn, &commit_id)?,
            tombstones: Vec::new(),
            object_payloads: Vec::new(),
            commit: Commit {
                commit_id: commit_id.clone(),
                device_id: row.get(1)?,
                local_seq: sqlite_u64(row, 2)?,
                commit_kind: parse_commit_kind(row.get(3)?, 3)?,
                change_scope: parse_change_scope(row.get(4)?, 4)?,
                changed_object_ids_ct: row.get(5)?,
                vector_clock: row.get(6)?,
                message_ct: row.get(7)?,
                created_at: row.get(8)?,
                integrity_tag: row.get(9)?,
            },
            operation: operation_for_commit(conn, &commit_id)?,
        })
    })?;
    let mut commits = rows.collect::<Result<Vec<_>, _>>()?;
    let tombstones = load_tombstones(conn)?;
    if let Some(first) = commits.first_mut() {
        first.tombstones = tombstones;
    }
    Ok(commits)
}

fn load_serialized_commit(
    conn: &VaultConnection,
    commit_id: &str,
) -> StorageResult<SerializedCommit> {
    let commit = conn.inner().query_row(
        "SELECT commit_id, device_id, local_seq, commit_kind, change_scope,
                changed_object_ids_ct, vector_clock, message_ct, created_at, integrity_tag
         FROM commits WHERE commit_id = ?1",
        [commit_id],
        |row| {
            Ok(Commit {
                commit_id: row.get(0)?,
                device_id: row.get(1)?,
                local_seq: sqlite_u64(row, 2)?,
                commit_kind: parse_commit_kind(row.get(3)?, 3)?,
                change_scope: parse_change_scope(row.get(4)?, 4)?,
                changed_object_ids_ct: row.get(5)?,
                vector_clock: row.get(6)?,
                message_ct: row.get(7)?,
                created_at: row.get(8)?,
                integrity_tag: row.get(9)?,
            })
        },
    )?;
    Ok(SerializedCommit {
        operation: operation_for_commit(conn, commit_id)?,
        parent_ids: parent_ids_for_commit(conn, commit_id)?,
        tombstones: Vec::new(),
        object_payloads: Vec::new(),
        commit,
    })
}

fn operation_for_commit(
    conn: &VaultConnection,
    commit_id: &str,
) -> rusqlite::Result<Option<CommitOperationMetadata>> {
    conn.inner()
        .query_row(
            "SELECT operation_id, operation_kind, branch_id, branch_name,
                    change_summary_ct, request_hash, integrity_tag
             FROM commit_operations WHERE commit_id = ?1",
            params![commit_id],
            |row| {
                Ok(CommitOperationMetadata {
                    operation_id: row.get(0)?,
                    operation_kind: row.get(1)?,
                    branch_id: row.get(2)?,
                    branch_name: row.get(3)?,
                    change_summary_ct: row.get(4)?,
                    request_hash: row.get(5)?,
                    integrity_tag: row.get(6)?,
                })
            },
        )
        .optional()
}

fn parent_ids_for_commit(conn: &VaultConnection, commit_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.inner().prepare(
        "SELECT parent_commit_id FROM commit_parents
         WHERE commit_id = ?1
         ORDER BY parent_commit_id",
    )?;
    let rows = statement.query_map(params![commit_id], |row| row.get(0))?;
    let parents = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(parents)
}

fn load_tombstones(conn: &VaultConnection) -> StorageResult<Vec<TombstoneRecord>> {
    let mut statement = conn.inner().prepare(
        "SELECT tombstone_id, target_object_type, target_object_id,
                delete_clock, deleted_by_device_id, deleted_at
         FROM tombstones
         ORDER BY deleted_at ASC, tombstone_id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(TombstoneRecord {
            tombstone_id: row.get(0)?,
            target_object_type: row.get(1)?,
            target_object_id: row.get(2)?,
            delete_clock: row.get(3)?,
            deleted_by_device_id: row.get(4)?,
            deleted_at: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn sqlite_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn parse_commit_kind(value: String, index: usize) -> rusqlite::Result<CommitKind> {
    value.parse().map_err(|error: String| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })
}

fn parse_change_scope(value: String, index: usize) -> rusqlite::Result<ChangeScope> {
    value.parse().map_err(|error: String| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })
}

fn map_sync_error(error: mdbx_sync::SyncError) -> StorageError {
    match error {
        mdbx_sync::SyncError::IoError(error) => StorageError::Io(error),
        mdbx_sync::SyncError::ResourceLimit {
            resource,
            actual,
            limit,
        } => StorageError::ResourceLimit {
            resource,
            actual,
            limit,
        },
        error => StorageError::Validation(format!("sync protocol error: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use crate::backup::BackupService;
    use crate::connection::PendingVaultCreation;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ProjectRepo};
    use crate::unlock::UnlockService;

    use super::*;

    const PASSWORD: &str = "peer-sync-test-password";

    struct TestVault {
        path: PathBuf,
    }

    impl TestVault {
        fn new() -> Self {
            Self {
                path: std::env::temp_dir()
                    .join(format!("mdbx-peer-sync-{}.mdbx", uuid::Uuid::new_v4())),
            }
        }
    }

    impl Drop for TestVault {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(PathBuf::from(format!(
                    "{}{}",
                    self.path.display(),
                    suffix
                )));
            }
            let _ = std::fs::remove_dir_all(format!("{}.blobs", self.path.display()));
        }
    }

    fn create(path: &Path, device_id: &str) -> VaultConnection {
        let mut creation = PendingVaultCreation::begin(path).unwrap();
        initialize_vault(
            creation.connection(),
            &VaultInitParams {
                device_id: device_id.to_string(),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        UnlockService::setup_password(creation.connection_mut(), PASSWORD).unwrap();
        creation.commit()
    }

    fn open(path: &Path) -> VaultConnection {
        let mut connection = VaultConnection::open(path).unwrap();
        UnlockService::unlock_with_password(&mut connection, PASSWORD).unwrap();
        connection
    }

    fn copy(source: &Path, destination: &Path) {
        BackupService::create_portable_copy_path(source, destination).unwrap();
    }

    fn title_exists(conn: &VaultConnection, title: &str) -> bool {
        ProjectRepo::list_all(conn)
            .unwrap()
            .iter()
            .any(|project| String::from_utf8(project.title_ct.clone()).unwrap() == title)
    }

    #[test]
    fn peer_sync_round_trip_is_bounded_resumable_and_idempotent() {
        let source = TestVault::new();
        let target = TestVault::new();
        let source_conn = create(&source.path, "source-device");
        let base = PeerSyncService::current_checkpoint(&source_conn).unwrap();
        drop(source_conn);
        copy(&source.path, &target.path);

        let source_conn = open(&source.path);
        for title in ["One", "Two", "Three"] {
            ProjectRepo::create(
                &source_conn,
                &CommitContext::new("source-device".to_string()),
                title,
                None,
                None,
            )
            .unwrap();
        }
        let first = PeerSyncService::export_incremental_segment(
            &source_conn,
            "source-device",
            &base,
            None,
            PeerSyncSegmentOptions { page_size: 2 },
        )
        .unwrap();
        assert!(!first.manifest.is_last);
        let resume = PeerSyncService::next_resume(&first).unwrap().unwrap();

        let mut target_conn = open(&target.path);
        let applied = PeerSyncService::apply_incremental_segment(
            &mut target_conn,
            "target-device",
            &first,
            &base,
            None,
        )
        .unwrap();
        assert!(applied.applied_commits > 0);
        let replay = PeerSyncService::apply_incremental_segment(
            &mut target_conn,
            "target-device",
            &first,
            &base,
            None,
        )
        .unwrap();
        assert_eq!(replay.applied_commits, 0);
        assert!(replay.skipped_commits > 0);

        let second = PeerSyncService::export_incremental_segment(
            &source_conn,
            "source-device",
            &first.manifest.result,
            Some(&resume),
            PeerSyncSegmentOptions { page_size: 2 },
        )
        .unwrap();
        assert_eq!(second.manifest.segment_index, 1);
        PeerSyncService::apply_incremental_segment(
            &mut target_conn,
            "target-device",
            &second,
            &first.manifest.result,
            Some(&resume),
        )
        .unwrap();
        assert!(PeerSyncService::next_resume(&second).unwrap().is_none());
        for title in ["One", "Two", "Three"] {
            assert!(title_exists(&target_conn, title));
        }
    }

    #[test]
    fn divergent_peer_streams_converge_without_full_vault_replacement() {
        let left = TestVault::new();
        let right = TestVault::new();
        let left_conn = create(&left.path, "left-device");
        let base = PeerSyncService::current_checkpoint(&left_conn).unwrap();
        drop(left_conn);
        copy(&left.path, &right.path);

        let mut left_conn = open(&left.path);
        let mut right_conn = open(&right.path);
        ProjectRepo::create(
            &left_conn,
            &CommitContext::new("left-device".to_string()),
            "Left only",
            None,
            None,
        )
        .unwrap();
        ProjectRepo::create(
            &right_conn,
            &CommitContext::new("right-device".to_string()),
            "Right only",
            None,
            None,
        )
        .unwrap();

        let left_segment = PeerSyncService::export_incremental_segment(
            &left_conn,
            "left-device",
            &base,
            None,
            PeerSyncSegmentOptions::default(),
        )
        .unwrap();
        let right_segment = PeerSyncService::export_incremental_segment(
            &right_conn,
            "right-device",
            &base,
            None,
            PeerSyncSegmentOptions::default(),
        )
        .unwrap();

        PeerSyncService::apply_incremental_segment(
            &mut left_conn,
            "left-device",
            &right_segment,
            &base,
            None,
        )
        .unwrap();
        PeerSyncService::apply_incremental_segment(
            &mut right_conn,
            "right-device",
            &left_segment,
            &base,
            None,
        )
        .unwrap();
        for connection in [&left_conn, &right_conn] {
            assert!(title_exists(connection, "Left only"));
            assert!(title_exists(connection, "Right only"));
        }
    }

    #[test]
    fn peer_sync_rejects_stale_resume_and_wrong_vault_before_mutation() {
        let source = TestVault::new();
        let target = TestVault::new();
        let unrelated = TestVault::new();
        let source_conn = create(&source.path, "source-device");
        let base = PeerSyncService::current_checkpoint(&source_conn).unwrap();
        drop(source_conn);
        copy(&source.path, &target.path);
        let mut unrelated_conn = create(&unrelated.path, "unrelated-device");

        let source_conn = open(&source.path);
        ProjectRepo::create(
            &source_conn,
            &CommitContext::new("source-device".to_string()),
            "Protected",
            None,
            None,
        )
        .unwrap();
        let segment = PeerSyncService::export_incremental_segment(
            &source_conn,
            "source-device",
            &base,
            None,
            PeerSyncSegmentOptions::default(),
        )
        .unwrap();

        let wrong_vault = PeerSyncService::apply_incremental_segment(
            &mut unrelated_conn,
            "unrelated-device",
            &segment,
            &base,
            None,
        )
        .unwrap_err();
        assert!(wrong_vault.to_string().contains("vault_id"));
        assert!(!title_exists(&unrelated_conn, "Protected"));

        let mut target_conn = open(&target.path);
        let stale_resume = IncrementalBundleResume {
            transfer_id: uuid::Uuid::new_v4().to_string(),
            next_segment_index: 1,
            previous_segment_sha256: vec![0; 32],
        };
        let chain_error = PeerSyncService::apply_incremental_segment(
            &mut target_conn,
            "target-device",
            &segment,
            &base,
            Some(&stale_resume),
        )
        .unwrap_err();
        assert!(chain_error.to_string().contains("resume state"));
        assert!(!title_exists(&target_conn, "Protected"));
    }

    #[test]
    fn empty_checkpoint_bootstraps_in_bounded_segments_and_then_resumes() {
        let source = TestVault::new();
        let target = TestVault::new();
        let source_conn = create(&source.path, "source-device");
        drop(source_conn);
        copy(&source.path, &target.path);

        let source_conn = open(&source.path);
        for title in ["Bootstrap one", "Bootstrap two", "Bootstrap three"] {
            ProjectRepo::create(
                &source_conn,
                &CommitContext::new("source-device".to_string()),
                title,
                None,
                None,
            )
            .unwrap();
        }
        let empty = IncrementalBundleCheckpoint {
            commit_inventory: None,
            delta_inventory: None,
        };
        let first = PeerSyncService::export_incremental_segment(
            &source_conn,
            "source-device",
            &empty,
            None,
            PeerSyncSegmentOptions { page_size: 2 },
        )
        .unwrap();
        assert_eq!(first.manifest.segment_index, 0);
        assert!(!first.manifest.is_last);
        let resume = PeerSyncService::next_resume(&first).unwrap();

        let mut target_conn = open(&target.path);
        PeerSyncService::apply_incremental_segment(
            &mut target_conn,
            "target-device",
            &first,
            &empty,
            None,
        )
        .unwrap();
        let second = PeerSyncService::export_incremental_segment(
            &source_conn,
            "source-device",
            &first.manifest.result,
            resume.as_ref(),
            PeerSyncSegmentOptions { page_size: 2 },
        )
        .unwrap();
        PeerSyncService::apply_incremental_segment(
            &mut target_conn,
            "target-device",
            &second,
            &first.manifest.result,
            resume.as_ref(),
        )
        .unwrap();
        for title in ["Bootstrap one", "Bootstrap two", "Bootstrap three"] {
            assert!(title_exists(&target_conn, title));
        }
    }
}
