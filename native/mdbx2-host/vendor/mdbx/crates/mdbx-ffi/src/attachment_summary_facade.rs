use mdbx_core::model::{AttachmentSummary, AttachmentSummaryPage};
use mdbx_storage::presentation_metadata::{
    FIELD_CIPHERTEXT_OVERHEAD_BYTES, MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES,
    MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES,
};
use mdbx_storage::repo::{
    AttachmentSummaryRepo, MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES, MAX_ATTACHMENT_SUMMARY_PAGE_SIZE,
};

use super::{MdbxFfiError, MdbxVault};

/// Bounded, payload-free attachment metadata for Collection/Object navigation.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxAttachmentSummary {
    pub attachment_id: String,
    pub collection_id: String,
    pub object_id: Option<String>,
    pub file_name: String,
    pub media_type: Option<String>,
    pub storage_mode: String,
    pub content_hash: String,
    pub original_size: u64,
    pub stored_size: u64,
    pub chunk_count: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxAttachmentSummaryPage {
    pub items: Vec<MdbxAttachmentSummary>,
    pub next_cursor: Option<String>,
}

/// Fixed resource contract for bounded attachment presentation and pagination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxAttachmentPresentationLimits {
    pub max_file_name_bytes: u64,
    pub max_media_type_bytes: u64,
    pub ciphertext_envelope_allowance_bytes: u64,
    pub max_page_size: u32,
    pub max_cursor_bytes: u32,
}

#[uniffi::export]
pub fn default_attachment_presentation_limits() -> MdbxAttachmentPresentationLimits {
    MdbxAttachmentPresentationLimits {
        max_file_name_bytes: MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES,
        max_media_type_bytes: MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES,
        ciphertext_envelope_allowance_bytes: FIELD_CIPHERTEXT_OVERHEAD_BYTES,
        max_page_size: MAX_ATTACHMENT_SUMMARY_PAGE_SIZE as u32,
        max_cursor_bytes: MAX_ATTACHMENT_SUMMARY_CURSOR_BYTES as u32,
    }
}

fn attachment_summary_from_core(
    summary: AttachmentSummary,
) -> Result<MdbxAttachmentSummary, MdbxFfiError> {
    let file_name =
        String::from_utf8(summary.file_name).map_err(|error| MdbxFfiError::Serialization {
            message: format!("attachment file name is not UTF-8: {error}"),
        })?;
    let media_type = summary
        .media_type
        .map(|value| {
            String::from_utf8(value).map_err(|error| MdbxFfiError::Serialization {
                message: format!("attachment media type is not UTF-8: {error}"),
            })
        })
        .transpose()?;
    Ok(MdbxAttachmentSummary {
        attachment_id: summary.attachment_id,
        collection_id: summary.collection_id,
        object_id: summary.object_id,
        file_name,
        media_type,
        storage_mode: summary.storage_mode.to_string(),
        content_hash: summary.content_hash,
        original_size: summary.original_size,
        stored_size: summary.stored_size,
        chunk_count: summary.chunk_count,
        head_commit_id: summary.head_commit_id,
        deleted: summary.deleted,
        updated_at: summary.updated_at,
    })
}

fn attachment_summary_page_from_core(
    page: AttachmentSummaryPage,
) -> Result<MdbxAttachmentSummaryPage, MdbxFfiError> {
    Ok(MdbxAttachmentSummaryPage {
        items: page
            .items
            .into_iter()
            .map(attachment_summary_from_core)
            .collect::<Result<Vec<_>, _>>()?,
        next_cursor: page.next_cursor,
    })
}

#[uniffi::export]
impl MdbxVault {
    /// Read one attachment's bounded display metadata, including a tombstone.
    pub fn get_attachment_summary(
        &self,
        attachment_id: String,
    ) -> Result<Option<MdbxAttachmentSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        AttachmentSummaryRepo::get(&conn, &attachment_id)?
            .map(attachment_summary_from_core)
            .transpose()
    }

    /// Page active attachment summaries for a Collection or one Object.
    ///
    /// Passing `object_id = None` selects the whole Collection. Passing an
    /// Object ID keeps the Collection/Object scope bound into the cursor.
    pub fn list_attachment_summaries(
        &self,
        collection_id: String,
        object_id: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxAttachmentSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let page = match object_id.as_deref() {
            Some(object_id) => AttachmentSummaryRepo::list_by_object(
                &conn,
                &collection_id,
                object_id,
                page_size as usize,
                cursor.as_deref(),
            )?,
            None => AttachmentSummaryRepo::list_by_collection(
                &conn,
                &collection_id,
                page_size as usize,
                cursor.as_deref(),
            )?,
        };
        attachment_summary_page_from_core(page)
    }

    /// Page deleted attachment summaries without selecting chunk/blob payloads.
    pub fn list_deleted_attachment_summaries(
        &self,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxAttachmentSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        attachment_summary_page_from_core(AttachmentSummaryRepo::list_deleted(
            &conn,
            page_size as usize,
            cursor.as_deref(),
        )?)
    }
}
