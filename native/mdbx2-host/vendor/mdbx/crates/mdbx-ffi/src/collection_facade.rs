use mdbx_core::model::CollectionSummary;
use mdbx_storage::presentation_metadata::PresentationMetadataLimits;
use mdbx_storage::repo::{
    CollectionSummaryRepo, MAX_COLLECTION_SUMMARY_CURSOR_BYTES, MAX_COLLECTION_SUMMARY_PAGE_SIZE,
};

use super::{MdbxFfiError, MdbxVault};

/// Payload-free collection metadata used to build the top-level navigation tree.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCollectionSummary {
    pub collection_id: String,
    pub title: String,
    pub collection_type_id: Option<String>,
    pub profile_schema_version: Option<u32>,
    pub group_id: Option<String>,
    pub icon_ref: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub attachment_count: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCollectionSummaryPage {
    pub items: Vec<MdbxCollectionSummary>,
    pub next_cursor: Option<String>,
}

/// Fixed resource contract for collection, object, and label presentation fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxPresentationMetadataLimits {
    pub max_title_bytes: u64,
    pub max_label_name_bytes: u64,
    pub max_reference_bytes: u64,
    pub max_collection_summary_page_size: u32,
    pub max_cursor_bytes: u32,
}

#[uniffi::export]
pub fn default_presentation_metadata_limits() -> MdbxPresentationMetadataLimits {
    let limits = PresentationMetadataLimits::default();
    MdbxPresentationMetadataLimits {
        max_title_bytes: limits.max_title_bytes(),
        max_label_name_bytes: limits.max_label_name_bytes(),
        max_reference_bytes: limits.max_reference_bytes(),
        max_collection_summary_page_size: MAX_COLLECTION_SUMMARY_PAGE_SIZE as u32,
        max_cursor_bytes: MAX_COLLECTION_SUMMARY_CURSOR_BYTES as u32,
    }
}

fn collection_summary_from_core(summary: CollectionSummary) -> MdbxCollectionSummary {
    MdbxCollectionSummary {
        collection_id: summary.collection_id,
        title: String::from_utf8_lossy(&summary.title).to_string(),
        collection_type_id: summary.collection_type_id.map(|value| value.to_string()),
        profile_schema_version: summary.profile_schema_version,
        group_id: summary.group_id,
        icon_ref: summary.icon_ref,
        favorite: summary.favorite,
        archived: summary.archived,
        attachment_count: summary.attachment_count,
        head_commit_id: summary.head_commit_id,
        deleted: summary.deleted,
        updated_at: summary.updated_at,
    }
}

fn collection_summary_page_from_core(
    page: mdbx_core::model::CollectionSummaryPage,
) -> MdbxCollectionSummaryPage {
    MdbxCollectionSummaryPage {
        items: page
            .items
            .into_iter()
            .map(collection_summary_from_core)
            .collect(),
        next_cursor: page.next_cursor,
    }
}

#[uniffi::export]
impl MdbxVault {
    /// Read one collection's bounded presentation metadata, including a tombstone.
    pub fn get_collection_summary(
        &self,
        collection_id: String,
    ) -> Result<Option<MdbxCollectionSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(CollectionSummaryRepo::get(&conn, &collection_id)?.map(collection_summary_from_core))
    }

    /// Page active collections without selecting collection or profile payloads.
    pub fn list_collection_summaries(
        &self,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxCollectionSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(collection_summary_page_from_core(
            CollectionSummaryRepo::list_active(&conn, page_size as usize, cursor.as_deref())?,
        ))
    }

    /// Page deleted collections without selecting collection or profile payloads.
    pub fn list_deleted_collection_summaries(
        &self,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxCollectionSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(collection_summary_page_from_core(
            CollectionSummaryRepo::list_deleted(&conn, page_size as usize, cursor.as_deref())?,
        ))
    }
}
