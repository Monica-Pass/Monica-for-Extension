use mdbx_storage::repo::{
    CommitContext, CommitDiffItem, CommitRevertResult, HistoryActionRepo, MAX_COMMIT_DIFF_ITEMS,
    MAX_COMMIT_DIFF_PREVIEW_CHARS,
};
use mdbx_storage::tiga_policy::TigaAuthorizationContext;

use super::{unix_now, MdbxDeviceContext, MdbxFfiError, MdbxVault};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCommitDiffItem {
    pub commit_id: String,
    pub object_type: String,
    pub object_id: String,
    pub collection_id: Option<String>,
    pub previous_title: Option<String>,
    pub current_title: Option<String>,
    pub previous_payload_preview: Option<String>,
    pub current_payload_preview: Option<String>,
    pub previous_deleted: Option<bool>,
    pub current_deleted: bool,
    pub changed_fields: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCommitRevertResult {
    pub commit_id: String,
    pub reverted_object_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCommitActionLimits {
    pub max_diff_items: u32,
    pub max_preview_chars: u32,
}

#[uniffi::export]
pub fn default_commit_action_limits() -> MdbxCommitActionLimits {
    MdbxCommitActionLimits {
        max_diff_items: MAX_COMMIT_DIFF_ITEMS as u32,
        max_preview_chars: MAX_COMMIT_DIFF_PREVIEW_CHARS as u32,
    }
}

#[uniffi::export]
impl MdbxVault {
    pub fn list_commit_diff(
        &self,
        commit_id: String,
    ) -> Result<Vec<MdbxCommitDiffItem>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(HistoryActionRepo::list_commit_diff(&conn, &commit_id)?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub fn revert_commit(
        &self,
        commit_id: String,
        operation_id: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxCommitRevertResult, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        let (result, _) = HistoryActionRepo::revert_commit_authorized(
            &conn,
            &ctx,
            &commit_id,
            &operation_id,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(result.into())
    }
}

impl From<CommitDiffItem> for MdbxCommitDiffItem {
    fn from(value: CommitDiffItem) -> Self {
        Self {
            commit_id: value.commit_id,
            object_type: value.object_type,
            object_id: value.object_id,
            collection_id: value.collection_id,
            previous_title: value.previous_title,
            current_title: value.current_title,
            previous_payload_preview: value.previous_payload_preview,
            current_payload_preview: value.current_payload_preview,
            previous_deleted: value.previous_deleted,
            current_deleted: value.current_deleted,
            changed_fields: value.changed_fields,
            created_at: value.created_at,
        }
    }
}

impl From<CommitRevertResult> for MdbxCommitRevertResult {
    fn from(value: CommitRevertResult) -> Self {
        Self {
            commit_id: value.commit_id,
            reverted_object_count: value.reverted_object_count as u32,
        }
    }
}
