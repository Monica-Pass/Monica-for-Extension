#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxConflictChoice {
    LocalWins,
    IncomingWins,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxConflictRecord {
    pub conflict_id: String,
    pub object_type: String,
    pub object_id: String,
    pub base_commit_id: String,
    pub local_commit_id: String,
    pub incoming_commit_id: String,
    pub conflicting_fields: Vec<String>,
    pub resolution: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

/// Bounded conflict metadata for queue navigation. This additive record does
/// not replace the complete legacy conflict record used by resolution flows.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxConflictSummary {
    pub conflict_id: String,
    pub object_type: String,
    pub object_id: String,
    pub base_commit_id: String,
    pub local_commit_id: String,
    pub incoming_commit_id: String,
    pub conflicting_fields: Vec<String>,
    pub resolution: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxConflictSummaryPage {
    pub items: Vec<MdbxConflictSummary>,
    pub next_cursor: Option<String>,
}

/// Fixed resource contract for bounded unresolved-conflict navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxConflictSummaryLimits {
    pub max_page_size: u32,
    pub max_cursor_bytes: u32,
    pub max_fields_json_bytes: u64,
    pub max_field_count: u32,
    pub max_field_path_bytes: u64,
}

/// Client-editable project fields for an explicit custom conflict merge.
///
/// The conflict ID supplies the project identity. Policy, clocks, collection
/// profile, and derived counters remain storage-owned.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxProjectConflictMerge {
    pub title: String,
    pub summary: Option<String>,
    pub group_id: Option<String>,
    pub icon_ref: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub deleted: bool,
}

/// Client-editable attachment metadata for an explicit custom conflict merge.
///
/// Content identity and chunk metadata are intentionally absent. Content must
/// be transferred and verified through the attachment/blob APIs first.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxAttachmentConflictMerge {
    pub project_id: String,
    pub entry_id: Option<String>,
    pub file_name: String,
    pub media_type: Option<String>,
    pub deleted: bool,
}

use mdbx_core::model::{
    Attachment, Conflict, ConflictObjectType, ConflictResolution, ConflictSummary,
    ConflictSummaryPage,
};
use mdbx_storage::error::StorageError;
use mdbx_storage::repo::{
    AttachmentRepo, CommitContext, ConflictRepo, ConflictSummaryRepo, ObjectLabelAssignmentRepo,
    ObjectLabelRepo, ObjectRelationRepo, ProjectRepo, MAX_CONFLICT_SUMMARY_CURSOR_BYTES,
    MAX_CONFLICT_SUMMARY_FIELDS_JSON_BYTES, MAX_CONFLICT_SUMMARY_FIELD_BYTES,
    MAX_CONFLICT_SUMMARY_FIELD_COUNT, MAX_CONFLICT_SUMMARY_PAGE_SIZE,
};

use super::{parse_payload_json, parse_relation_kind, MdbxFfiError, MdbxVault};

#[uniffi::export]
pub fn default_conflict_summary_limits() -> MdbxConflictSummaryLimits {
    MdbxConflictSummaryLimits {
        max_page_size: MAX_CONFLICT_SUMMARY_PAGE_SIZE as u32,
        max_cursor_bytes: MAX_CONFLICT_SUMMARY_CURSOR_BYTES as u32,
        max_fields_json_bytes: MAX_CONFLICT_SUMMARY_FIELDS_JSON_BYTES as u64,
        max_field_count: MAX_CONFLICT_SUMMARY_FIELD_COUNT as u32,
        max_field_path_bytes: MAX_CONFLICT_SUMMARY_FIELD_BYTES as u64,
    }
}

#[uniffi::export]
impl MdbxVault {
    pub fn list_unresolved_conflicts(&self) -> Result<Vec<MdbxConflictRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(ConflictRepo::list_unresolved(&conn)?
            .iter()
            .map(conflict_record)
            .collect())
    }

    /// Page unresolved conflicts without selecting an unbounded conflict
    /// payload. The optional object type is part of the opaque cursor query.
    pub fn list_unresolved_conflict_summaries(
        &self,
        object_type: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxConflictSummaryPage, MdbxFfiError> {
        let object_type = parse_optional_conflict_object_type(object_type)?;
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let page = ConflictSummaryRepo::list_unresolved_summaries(
            &conn,
            object_type.as_ref(),
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(conflict_summary_page_from_core(page))
    }

    pub fn resolve_conflict(
        &self,
        conflict_id: String,
        choice: MdbxConflictChoice,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let conflict = ConflictRepo::get_by_id(&conn, &conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.clone()))?;
        let ctx = CommitContext::new(self.device_id.clone());
        let resolution = conflict_resolution(choice);
        let resolved = match conflict.object_type {
            ConflictObjectType::Project => {
                ConflictRepo::resolve_project(&conn, &ctx, &conflict_id, resolution)?
            }
            ConflictObjectType::Entry => {
                ConflictRepo::resolve_entry(&conn, &ctx, &conflict_id, resolution)?
            }
            ConflictObjectType::Attachment => {
                ConflictRepo::resolve_attachment(&conn, &ctx, &conflict_id, resolution)?
            }
            ConflictObjectType::ObjectRelation => {
                ConflictRepo::resolve_object_relation(&conn, &ctx, &conflict_id, resolution)?
            }
            ConflictObjectType::ObjectLabel => {
                ConflictRepo::resolve_object_label(&conn, &ctx, &conflict_id, resolution)?
            }
            ConflictObjectType::ObjectLabelAssignment => {
                ConflictRepo::resolve_object_label_assignment(
                    &conn,
                    &ctx,
                    &conflict_id,
                    resolution,
                )?
            }
        };
        Ok(conflict_record(&resolved))
    }

    pub fn resolve_entry_conflict_custom_payload(
        &self,
        conflict_id: String,
        payload_json: String,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let resolved = ConflictRepo::resolve_entry_custom_payload(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &conflict_id,
            &parse_payload_json(&payload_json)?,
        )?;
        Ok(conflict_record(&resolved))
    }

    pub fn resolve_project_conflict_custom(
        &self,
        conflict_id: String,
        merged: MdbxProjectConflictMerge,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let conflict = ConflictRepo::get_by_id(&conn, &conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.clone()))?;
        if conflict.object_type != ConflictObjectType::Project {
            return Err(StorageError::ConstraintViolation(
                "project custom resolution requires a project conflict".to_string(),
            )
            .into());
        }
        let mut project = ProjectRepo::get_by_id(&conn, &conflict.object_id)?
            .ok_or_else(|| StorageError::NotFound(conflict.object_id.clone()))?;
        project.title_ct = merged.title.into_bytes();
        project.summary_ct = merged.summary.map(String::into_bytes);
        project.group_id = merged.group_id;
        project.icon_ref = merged.icon_ref;
        project.favorite = merged.favorite;
        project.archived = merged.archived;
        project.deleted = merged.deleted;
        let resolved = ConflictRepo::resolve_project_custom(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &conflict_id,
            &project,
        )?;
        Ok(conflict_record(&resolved))
    }

    pub fn resolve_attachment_conflict_custom(
        &self,
        conflict_id: String,
        merged: MdbxAttachmentConflictMerge,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let conflict = ConflictRepo::get_by_id(&conn, &conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.clone()))?;
        if conflict.object_type != ConflictObjectType::Attachment {
            return Err(StorageError::ConstraintViolation(
                "attachment custom resolution requires an attachment conflict".to_string(),
            )
            .into());
        }
        let mut attachment: Attachment = AttachmentRepo::get_by_id(&conn, &conflict.object_id)?
            .ok_or_else(|| StorageError::NotFound(conflict.object_id.clone()))?;
        attachment.project_id = merged.project_id;
        attachment.entry_id = merged.entry_id;
        attachment.file_name_ct = merged.file_name.into_bytes();
        attachment.media_type_ct = merged.media_type.map(String::into_bytes);
        attachment.deleted = merged.deleted;
        let resolved = ConflictRepo::resolve_attachment_custom(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &conflict_id,
            &attachment,
        )?;
        Ok(conflict_record(&resolved))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn resolve_object_relation_conflict_custom(
        &self,
        conflict_id: String,
        source_object_id: String,
        target_object_id: String,
        relation_kind: String,
        payload_json: String,
        payload_schema_version: u32,
        deleted: bool,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let conflict = ConflictRepo::get_by_id(&conn, &conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.clone()))?;
        let mut merged = ObjectRelationRepo::get_by_id(&conn, &conflict.object_id)?
            .ok_or_else(|| StorageError::NotFound(conflict.object_id.clone()))?;
        merged.source_object_id = source_object_id;
        merged.target_object_id = target_object_id;
        merged.relation_kind = parse_relation_kind(&relation_kind)?;
        merged.payload_ct = serde_json::to_vec(&parse_payload_json(&payload_json)?)?;
        merged.payload_schema_version = payload_schema_version;
        merged.deleted = deleted;
        let resolved = ConflictRepo::resolve_object_relation_custom(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &conflict_id,
            &merged,
        )?;
        Ok(conflict_record(&resolved))
    }

    pub fn resolve_object_label_conflict_custom(
        &self,
        conflict_id: String,
        name: String,
        payload_json: String,
        payload_schema_version: u32,
        deleted: bool,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let conflict = ConflictRepo::get_by_id(&conn, &conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.clone()))?;
        let mut merged = ObjectLabelRepo::get_by_id(&conn, &conflict.object_id)?
            .ok_or_else(|| StorageError::NotFound(conflict.object_id.clone()))?;
        merged.name_ct = name.into_bytes();
        merged.payload_ct = serde_json::to_vec(&parse_payload_json(&payload_json)?)?;
        merged.payload_schema_version = payload_schema_version;
        merged.deleted = deleted;
        let resolved = ConflictRepo::resolve_object_label_custom(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &conflict_id,
            &merged,
        )?;
        Ok(conflict_record(&resolved))
    }

    pub fn resolve_object_label_assignment_conflict_custom(
        &self,
        conflict_id: String,
        deleted: bool,
    ) -> Result<MdbxConflictRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let conflict = ConflictRepo::get_by_id(&conn, &conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.clone()))?;
        let mut merged = ObjectLabelAssignmentRepo::get_by_id(&conn, &conflict.object_id)?
            .ok_or_else(|| StorageError::NotFound(conflict.object_id.clone()))?;
        merged.deleted = deleted;
        let resolved = ConflictRepo::resolve_object_label_assignment_custom(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &conflict_id,
            &merged,
        )?;
        Ok(conflict_record(&resolved))
    }
}

fn parse_optional_conflict_object_type(
    object_type: Option<String>,
) -> Result<Option<ConflictObjectType>, MdbxFfiError> {
    object_type
        .as_deref()
        .map(parse_conflict_object_type)
        .transpose()
}

fn parse_conflict_object_type(value: &str) -> Result<ConflictObjectType, MdbxFfiError> {
    value
        .parse()
        .map_err(|_| MdbxFfiError::InvalidConflictObjectType {
            object_type: value.to_string(),
        })
}

fn conflict_summary_page_from_core(page: ConflictSummaryPage) -> MdbxConflictSummaryPage {
    MdbxConflictSummaryPage {
        items: page
            .items
            .into_iter()
            .map(conflict_summary_from_core)
            .collect(),
        next_cursor: page.next_cursor,
    }
}

fn conflict_summary_from_core(summary: ConflictSummary) -> MdbxConflictSummary {
    MdbxConflictSummary {
        conflict_id: summary.conflict_id,
        object_type: summary.object_type.to_string(),
        object_id: summary.object_id,
        base_commit_id: summary.base_commit_id,
        local_commit_id: summary.local_commit_id,
        incoming_commit_id: summary.incoming_commit_id,
        conflicting_fields: summary.conflicting_fields,
        resolution: summary.resolution.to_string(),
        created_at: summary.created_at,
        resolved_at: summary.resolved_at,
    }
}

fn conflict_resolution(choice: MdbxConflictChoice) -> ConflictResolution {
    match choice {
        MdbxConflictChoice::LocalWins => ConflictResolution::LocalWins,
        MdbxConflictChoice::IncomingWins => ConflictResolution::IncomingWins,
    }
}

fn conflict_record(conflict: &Conflict) -> MdbxConflictRecord {
    MdbxConflictRecord {
        conflict_id: conflict.conflict_id.clone(),
        object_type: conflict.object_type.to_string(),
        object_id: conflict.object_id.clone(),
        base_commit_id: conflict.base_commit_id.clone(),
        local_commit_id: conflict.local_commit_id.clone(),
        incoming_commit_id: conflict.incoming_commit_id.clone(),
        conflicting_fields: conflict.conflicting_fields.clone(),
        resolution: conflict.resolution.to_string(),
        created_at: conflict.created_at.clone(),
        resolved_at: conflict.resolved_at.clone(),
    }
}
