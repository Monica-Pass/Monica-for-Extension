use mdbx_core::model::{
    SnapshotKind, SnapshotLifecycleSummary, SnapshotPruneCandidate, SnapshotPrunePlan,
    SnapshotPruneResult, SnapshotSummary,
};
use mdbx_storage::repo::{
    CommitContext, SnapshotLifecycleRepo, SnapshotRepo, SnapshotSummaryRepo,
    MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES, MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES,
    MAX_SNAPSHOT_PRUNE_CANDIDATES, MAX_SNAPSHOT_PRUNE_KEEP_LATEST,
};
use mdbx_storage::tiga_policy::TigaAuthorizationContext;

use super::{unix_now, MdbxDeviceContext, MdbxFfiError, MdbxSnapshotSummary, MdbxVault};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxSnapshotKind {
    Manual,
    Automatic,
}

impl From<MdbxSnapshotKind> for SnapshotKind {
    fn from(value: MdbxSnapshotKind) -> Self {
        match value {
            MdbxSnapshotKind::Manual => Self::Manual,
            MdbxSnapshotKind::Automatic => Self::Automatic,
        }
    }
}

impl From<SnapshotKind> for MdbxSnapshotKind {
    fn from(value: SnapshotKind) -> Self {
        match value {
            SnapshotKind::Manual => Self::Manual,
            SnapshotKind::Automatic => Self::Automatic,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotLifecycleSummary {
    pub snapshot_id: String,
    pub kind: MdbxSnapshotKind,
    pub retention_eligible_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotPruneCandidate {
    pub summary: MdbxSnapshotSummary,
    pub retention_eligible_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotPrunePlan {
    pub plan_token: String,
    pub keep_latest: u32,
    pub candidates: Vec<MdbxSnapshotPruneCandidate>,
    pub has_more: bool,
    pub total_ciphertext_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotPruneResult {
    pub plan_token: String,
    pub commit_id: String,
    pub deleted_snapshot_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotLifecycleLimits {
    pub max_metadata_text_bytes: u32,
    pub max_timestamp_bytes: u32,
    pub max_prune_candidates: u32,
    pub max_keep_latest: u32,
}

#[uniffi::export]
pub fn default_snapshot_lifecycle_limits() -> MdbxSnapshotLifecycleLimits {
    MdbxSnapshotLifecycleLimits {
        max_metadata_text_bytes: MAX_SNAPSHOT_LIFECYCLE_TEXT_BYTES as u32,
        max_timestamp_bytes: MAX_SNAPSHOT_LIFECYCLE_TIMESTAMP_BYTES as u32,
        max_prune_candidates: MAX_SNAPSHOT_PRUNE_CANDIDATES as u32,
        max_keep_latest: MAX_SNAPSHOT_PRUNE_KEEP_LATEST as u32,
    }
}

#[uniffi::export]
impl MdbxVault {
    pub fn get_snapshot_lifecycle(
        &self,
        snapshot_id: String,
    ) -> Result<Option<MdbxSnapshotLifecycleSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(SnapshotLifecycleRepo::get(&conn, &snapshot_id)?.map(Into::into))
    }

    /// Create an authenticated automatic snapshot through the TIGA
    /// CreateSnapshot operation. The ciphertext payload is not returned.
    pub fn create_automatic_snapshot(
        &self,
        retention_eligible_at: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxSnapshotSummary, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        let (snapshot, _) = SnapshotRepo::create_automatic_snapshot_authorized(
            &conn,
            &ctx,
            &retention_eligible_at,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        SnapshotSummaryRepo::get(&conn, &snapshot.snapshot_id)?
            .map(snapshot_summary_from_core)
            .ok_or_else(|| {
                MdbxFfiError::from(mdbx_storage::error::StorageError::NotFound(
                    snapshot.snapshot_id,
                ))
            })
    }

    pub fn plan_automatic_snapshot_prune(
        &self,
        keep_latest: u32,
    ) -> Result<MdbxSnapshotPrunePlan, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(snapshot_prune_plan_from_core(
            SnapshotLifecycleRepo::plan_automatic_prune(&conn, keep_latest as usize, unix_now())?,
        ))
    }

    pub fn prune_automatic_snapshots(
        &self,
        plan_token: String,
        keep_latest: u32,
        device: MdbxDeviceContext,
    ) -> Result<MdbxSnapshotPruneResult, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        let now = unix_now();
        let (result, _) = SnapshotLifecycleRepo::prune_automatic_authorized(
            &conn,
            &ctx,
            &plan_token,
            keep_latest as usize,
            now,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: now,
            },
        )?;
        Ok(result.into())
    }
}

impl From<SnapshotLifecycleSummary> for MdbxSnapshotLifecycleSummary {
    fn from(value: SnapshotLifecycleSummary) -> Self {
        Self {
            snapshot_id: value.snapshot_id,
            kind: value.kind.into(),
            retention_eligible_at: value.retention_eligible_at,
        }
    }
}

impl From<SnapshotPruneResult> for MdbxSnapshotPruneResult {
    fn from(value: SnapshotPruneResult) -> Self {
        Self {
            plan_token: value.plan_token,
            commit_id: value.commit_id,
            deleted_snapshot_ids: value.deleted_snapshot_ids,
        }
    }
}

fn snapshot_prune_plan_from_core(value: SnapshotPrunePlan) -> MdbxSnapshotPrunePlan {
    MdbxSnapshotPrunePlan {
        plan_token: value.plan_token,
        keep_latest: value.keep_latest as u32,
        candidates: value
            .candidates
            .into_iter()
            .map(snapshot_prune_candidate_from_core)
            .collect(),
        has_more: value.has_more,
        total_ciphertext_bytes: value.total_ciphertext_bytes,
    }
}

fn snapshot_prune_candidate_from_core(value: SnapshotPruneCandidate) -> MdbxSnapshotPruneCandidate {
    MdbxSnapshotPruneCandidate {
        summary: snapshot_summary_from_core(value.summary),
        retention_eligible_at: value.retention_eligible_at,
    }
}

fn snapshot_summary_from_core(value: SnapshotSummary) -> MdbxSnapshotSummary {
    MdbxSnapshotSummary {
        snapshot_id: value.snapshot_id,
        base_commit_id: value.base_commit_id,
        snapshot_hash: value.snapshot_hash,
        snapshot_ciphertext_bytes: value.snapshot_ciphertext_bytes,
        created_at: value.created_at,
        created_by_device_id: value.created_by_device_id,
    }
}
