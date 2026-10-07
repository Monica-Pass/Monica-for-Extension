use mdbx_core::model::{SnapshotSummary, SnapshotSummaryPage};
use mdbx_storage::repo::{
    SnapshotSummaryRepo, MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES, MAX_SNAPSHOT_SUMMARY_PAGE_SIZE,
    MAX_SNAPSHOT_SUMMARY_TEXT_BYTES,
};

use super::{MdbxFfiError, MdbxVault};

/// Bounded snapshot metadata for management navigation. The encrypted
/// snapshot payload is intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotSummary {
    pub snapshot_id: String,
    pub base_commit_id: String,
    pub snapshot_hash: String,
    pub snapshot_ciphertext_bytes: u64,
    pub created_at: String,
    pub created_by_device_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotSummaryPage {
    pub items: Vec<MdbxSnapshotSummary>,
    pub next_cursor: Option<String>,
}

/// Fixed resource contract for bounded snapshot navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSnapshotSummaryLimits {
    pub max_page_size: u32,
    pub max_cursor_bytes: u32,
    pub max_text_bytes: u64,
}

#[uniffi::export]
pub fn default_snapshot_summary_limits() -> MdbxSnapshotSummaryLimits {
    MdbxSnapshotSummaryLimits {
        max_page_size: MAX_SNAPSHOT_SUMMARY_PAGE_SIZE as u32,
        max_cursor_bytes: MAX_SNAPSHOT_SUMMARY_CURSOR_BYTES as u32,
        max_text_bytes: MAX_SNAPSHOT_SUMMARY_TEXT_BYTES as u64,
    }
}

#[uniffi::export]
impl MdbxVault {
    /// Read one snapshot's bounded metadata without loading its payload.
    pub fn get_snapshot_summary(
        &self,
        snapshot_id: String,
    ) -> Result<Option<MdbxSnapshotSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(SnapshotSummaryRepo::get(&conn, &snapshot_id)?.map(snapshot_summary_from_core))
    }

    /// Page snapshot metadata without selecting or decrypting `snapshot_ct`.
    pub fn list_snapshot_summaries(
        &self,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxSnapshotSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(snapshot_summary_page_from_core(SnapshotSummaryRepo::list(
            &conn,
            page_size as usize,
            cursor.as_deref(),
        )?))
    }
}

fn snapshot_summary_page_from_core(page: SnapshotSummaryPage) -> MdbxSnapshotSummaryPage {
    MdbxSnapshotSummaryPage {
        items: page
            .items
            .into_iter()
            .map(snapshot_summary_from_core)
            .collect(),
        next_cursor: page.next_cursor,
    }
}

fn snapshot_summary_from_core(summary: SnapshotSummary) -> MdbxSnapshotSummary {
    MdbxSnapshotSummary {
        snapshot_id: summary.snapshot_id,
        base_commit_id: summary.base_commit_id,
        snapshot_hash: summary.snapshot_hash,
        snapshot_ciphertext_bytes: summary.snapshot_ciphertext_bytes,
        created_at: summary.created_at,
        created_by_device_id: summary.created_by_device_id,
    }
}
