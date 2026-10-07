use mdbx_core::model::{SnapshotKind, SnapshotSummary};
use mdbx_storage::repo::{
    CommitContext, SnapshotDeleteResult, SnapshotMetadataRepo, SnapshotRepo, SnapshotRestoreResult,
    SnapshotStructureNode, SnapshotStructurePreview, SnapshotSummaryRepo,
    MAX_SNAPSHOT_DISPLAY_NAME_BYTES,
};
use mdbx_storage::tiga_policy::TigaAuthorizationContext;

use super::{unix_now, MdbxDeviceContext, MdbxFfiError, MdbxSnapshotKind, MdbxVault};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxManagedSnapshotSummary {
    pub snapshot_id: String,
    pub base_commit_id: String,
    pub name: String,
    pub kind: MdbxSnapshotKind,
    pub is_full: bool,
    pub payload_bytes: u64,
    pub created_at: String,
    pub created_by_device_id: String,
    pub auto_prune: bool,
    pub integrity_ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxManagedSnapshotPage {
    pub items: Vec<MdbxManagedSnapshotSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotRestoreResult {
    pub commit_id: String,
    pub affected_object_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotDeleteResult {
    pub commit_id: String,
    pub snapshot_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotStructureNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub node_type: String,
    pub path: String,
    pub status: String,
    pub child_count: u32,
    pub metadata: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotStructurePreview {
    pub snapshot_id: String,
    pub current_nodes: Vec<MdbxSnapshotStructureNode>,
    pub snapshot_nodes: Vec<MdbxSnapshotStructureNode>,
    pub current_item_count: u32,
    pub snapshot_item_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotManagementLimits {
    pub max_display_name_bytes: u32,
}

#[uniffi::export]
pub fn default_snapshot_management_limits() -> MdbxSnapshotManagementLimits {
    MdbxSnapshotManagementLimits {
        max_display_name_bytes: MAX_SNAPSHOT_DISPLAY_NAME_BYTES as u32,
    }
}

#[uniffi::export]
impl MdbxVault {
    pub fn list_managed_snapshots(
        &self,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxManagedSnapshotPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let page = SnapshotSummaryRepo::list(&conn, page_size as usize, cursor.as_deref())?;
        let items = page
            .items
            .into_iter()
            .map(|summary| managed_summary(&conn, summary))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MdbxManagedSnapshotPage {
            items,
            next_cursor: page.next_cursor,
        })
    }

    pub fn create_manual_snapshot(
        &self,
        display_name: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxManagedSnapshotSummary, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        let (snapshot, _) = SnapshotRepo::create_manual_snapshot_authorized(
            &conn,
            &ctx,
            &display_name,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        let summary = SnapshotSummaryRepo::get(&conn, &snapshot.snapshot_id)?
            .ok_or_else(|| mdbx_storage::error::StorageError::NotFound(snapshot.snapshot_id))?;
        managed_summary(&conn, summary)
    }

    pub fn delete_snapshot(
        &self,
        snapshot_id: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxSnapshotDeleteResult, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        let (result, _) = SnapshotRepo::delete_snapshot_authorized(
            &conn,
            &ctx,
            &snapshot_id,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(result.into())
    }

    pub fn restore_snapshot(
        &self,
        snapshot_id: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxSnapshotRestoreResult, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let ctx = CommitContext::new(self.device_id.clone());
        let (result, _) = SnapshotRepo::restore_snapshot_with_result_authorized(
            &conn,
            &ctx,
            &snapshot_id,
            TigaAuthorizationContext {
                session: session.as_ref(),
                device: &device,
                now_unix_secs: unix_now(),
            },
        )?;
        Ok(result.into())
    }

    pub fn get_snapshot_structure_preview(
        &self,
        snapshot_id: String,
    ) -> Result<MdbxSnapshotStructurePreview, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(SnapshotRepo::get_structure_preview(&conn, &snapshot_id)?.into())
    }
}

fn managed_summary(
    conn: &mdbx_storage::connection::VaultConnection,
    summary: SnapshotSummary,
) -> Result<MdbxManagedSnapshotSummary, MdbxFfiError> {
    let lifecycle = mdbx_storage::repo::SnapshotLifecycleRepo::get(conn, &summary.snapshot_id)?
        .ok_or_else(|| mdbx_storage::error::StorageError::NotFound(summary.snapshot_id.clone()))?;
    let name = SnapshotMetadataRepo::get(conn, &summary.snapshot_id)?
        .map(|metadata| metadata.display_name)
        .unwrap_or_else(|| fallback_name(lifecycle.kind, &summary.created_at));
    let integrity_ok = SnapshotRepo::verify_integrity(conn, &summary.snapshot_id)?;
    Ok(MdbxManagedSnapshotSummary {
        snapshot_id: summary.snapshot_id,
        base_commit_id: summary.base_commit_id,
        name,
        kind: lifecycle.kind.into(),
        is_full: true,
        payload_bytes: summary.snapshot_ciphertext_bytes,
        created_at: summary.created_at,
        created_by_device_id: summary.created_by_device_id,
        auto_prune: lifecycle.kind == SnapshotKind::Automatic,
        integrity_ok,
    })
}

fn fallback_name(kind: SnapshotKind, created_at: &str) -> String {
    match kind {
        SnapshotKind::Manual => format!("Snapshot {created_at}"),
        SnapshotKind::Automatic => format!("Automatic {created_at}"),
    }
}

impl From<SnapshotRestoreResult> for MdbxSnapshotRestoreResult {
    fn from(value: SnapshotRestoreResult) -> Self {
        Self {
            commit_id: value.commit_id,
            affected_object_count: value.affected_object_count as u32,
        }
    }
}

impl From<SnapshotDeleteResult> for MdbxSnapshotDeleteResult {
    fn from(value: SnapshotDeleteResult) -> Self {
        Self {
            commit_id: value.commit_id,
            snapshot_id: value.snapshot_id,
        }
    }
}

impl From<SnapshotStructurePreview> for MdbxSnapshotStructurePreview {
    fn from(value: SnapshotStructurePreview) -> Self {
        Self {
            snapshot_id: value.snapshot_id,
            current_nodes: value.current_nodes.into_iter().map(Into::into).collect(),
            snapshot_nodes: value.snapshot_nodes.into_iter().map(Into::into).collect(),
            current_item_count: value.current_item_count as u32,
            snapshot_item_count: value.snapshot_item_count as u32,
        }
    }
}

impl From<SnapshotStructureNode> for MdbxSnapshotStructureNode {
    fn from(value: SnapshotStructureNode) -> Self {
        Self {
            id: value.id,
            parent_id: value.parent_id,
            name: value.name,
            node_type: value.node_type,
            path: value.path,
            status: value.status,
            child_count: value.child_count as u32,
            metadata: value.metadata,
        }
    }
}
