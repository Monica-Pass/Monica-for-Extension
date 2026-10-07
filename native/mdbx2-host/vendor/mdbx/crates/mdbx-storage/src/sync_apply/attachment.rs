use std::collections::HashSet;

use rusqlite::params;

use mdbx_core::model::ConflictObjectType;

use crate::connection::VaultConnection;
use crate::error::StorageResult;
use crate::repo::{CommitContext, CommitGraphRepo, ConflictRepo, ObjectVersionRepo, TombstoneRepo};
use crate::sync_state::{AttachmentChunkRow, AttachmentRow};

use super::{commit_graph_apply, commit_graph_apply::ObjectDecision, object_merge_apply};

pub(super) fn apply_attachments(
    conn: &VaultConnection,
    ctx: &CommitContext,
    _incoming_commit_id: &str,
    attachments: &[AttachmentRow],
) -> StorageResult<AttachmentApplyResult> {
    let mut result = AttachmentApplyResult::default();
    for row in attachments {
        if TombstoneRepo::is_permanently_purged(conn, "attachment", &row.attachment_id)? {
            continue;
        }
        if CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            ObjectVersionRepo::record_attachment_row(conn, &row.head_commit_id, row)?;
        }
        match commit_graph_apply::object_apply_decision(
            conn,
            "attachments",
            "attachment_id",
            &row.attachment_id,
            &row.head_commit_id,
        )? {
            ObjectDecision::Insert => {
                conn.inner().execute(
                    "INSERT INTO attachments (attachment_id, project_id, entry_id,
                     file_name_ct, media_type_ct, storage_mode, content_hash,
                     original_size, stored_size, chunk_count, head_commit_id,
                     deleted, created_at, updated_at, created_by_device_id, updated_by_device_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![
                        row.attachment_id,
                        row.project_id,
                        row.entry_id,
                        row.file_name_ct,
                        row.media_type_ct,
                        row.storage_mode,
                        row.content_hash,
                        row.original_size as i64,
                        row.stored_size as i64,
                        row.chunk_count as i64,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_attachment_row(conn, &row.head_commit_id, row)?;
                result.ids.insert(row.attachment_id.clone());
            }
            ObjectDecision::FastForward => {
                conn.inner().execute(
                    "UPDATE attachments SET project_id = ?2, entry_id = ?3,
                     file_name_ct = ?4, media_type_ct = ?5, storage_mode = ?6,
                     content_hash = ?7, original_size = ?8, stored_size = ?9,
                     chunk_count = ?10, head_commit_id = ?11, deleted = ?12,
                     created_at = ?13, updated_at = ?14,
                     created_by_device_id = ?15, updated_by_device_id = ?16
                     WHERE attachment_id = ?1",
                    params![
                        row.attachment_id,
                        row.project_id,
                        row.entry_id,
                        row.file_name_ct,
                        row.media_type_ct,
                        row.storage_mode,
                        row.content_hash,
                        row.original_size as i64,
                        row.stored_size as i64,
                        row.chunk_count as i64,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                conn.inner().execute(
                    "DELETE FROM attachment_chunks WHERE attachment_id = ?1",
                    params![row.attachment_id],
                )?;
                ObjectVersionRepo::record_attachment_row(conn, &row.head_commit_id, row)?;
                result.ids.insert(row.attachment_id.clone());
            }
            ObjectDecision::Conflict { local_head } => {
                let merge = merge_or_record_attachment_conflict(conn, ctx, row, &local_head)?;
                result.conflict_count += merge.conflict_count;
                if merge.replace_incoming_chunks {
                    result.ids.insert(row.attachment_id.clone());
                }
            }
            ObjectDecision::Skip => {}
        }
    }
    Ok(result)
}

pub(super) fn apply_attachment_chunks(
    conn: &VaultConnection,
    chunks: &[AttachmentChunkRow],
    replace_attachment_ids: &HashSet<String>,
) -> StorageResult<()> {
    for row in chunks {
        if !replace_attachment_ids.contains(&row.attachment_id) {
            continue;
        }
        conn.inner().execute(
            "INSERT OR REPLACE INTO attachment_chunks (attachment_id, chunk_index,
             chunk_hash, chunk_ct, external_uri_ct, stored_size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.attachment_id,
                row.chunk_index as i64,
                row.chunk_hash,
                row.chunk_ct,
                row.external_uri_ct,
                row.stored_size as i64,
                row.created_at,
            ],
        )?;
    }
    Ok(())
}

fn merge_or_record_attachment_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    incoming: &AttachmentRow,
    local_commit_id: &str,
) -> StorageResult<AttachmentMergeResult> {
    let incoming_commit_id = &incoming.head_commit_id;
    let Some(base_commit_id) =
        CommitGraphRepo::nearest_known_common_parent(conn, local_commit_id, incoming_commit_id)?
    else {
        let conflict_count = record_attachment_field_conflict(
            conn,
            ctx,
            &incoming.attachment_id,
            "unknown",
            local_commit_id,
            incoming_commit_id,
            &[String::from("<base>")],
        )?;
        return Ok(AttachmentMergeResult {
            conflict_count,
            replace_incoming_chunks: false,
        });
    };

    let Some(base_row) =
        ObjectVersionRepo::get_attachment(conn, &incoming.attachment_id, &base_commit_id)?
    else {
        let conflict_count = record_attachment_field_conflict(
            conn,
            ctx,
            &incoming.attachment_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &[String::from("<base>")],
        )?;
        return Ok(AttachmentMergeResult {
            conflict_count,
            replace_incoming_chunks: false,
        });
    };

    let local_row =
        match ObjectVersionRepo::get_attachment(conn, &incoming.attachment_id, local_commit_id)? {
            Some(row) => row,
            None => ObjectVersionRepo::current_attachment_row(conn, &incoming.attachment_id)?,
        };

    let mut structural_conflicts = Vec::new();
    if local_row.deleted != incoming.deleted {
        structural_conflicts.push("deleted".to_string());
    }
    if object_merge_apply::merge_value(
        &base_row.project_id,
        &local_row.project_id,
        &incoming.project_id,
    )
    .is_none()
    {
        structural_conflicts.push("project_id".to_string());
    }
    if object_merge_apply::merge_value(&base_row.entry_id, &local_row.entry_id, &incoming.entry_id)
        .is_none()
    {
        structural_conflicts.push("entry_id".to_string());
    }
    if object_merge_apply::merge_value(
        &base_row.file_name_ct,
        &local_row.file_name_ct,
        &incoming.file_name_ct,
    )
    .is_none()
    {
        structural_conflicts.push("file_name_ct".to_string());
    }
    if object_merge_apply::merge_value(
        &base_row.media_type_ct,
        &local_row.media_type_ct,
        &incoming.media_type_ct,
    )
    .is_none()
    {
        structural_conflicts.push("media_type_ct".to_string());
    }

    let local_content_changed = attachment_content_changed(&base_row, &local_row);
    let incoming_content_changed = attachment_content_changed(&base_row, incoming);
    let content_matches = attachment_content_matches(&local_row, incoming);
    let replace_incoming_chunks = if content_matches {
        false
    } else if local_content_changed && incoming_content_changed {
        structural_conflicts.push("content_hash".to_string());
        false
    } else {
        !local_content_changed && incoming_content_changed
    };

    if !structural_conflicts.is_empty() {
        let conflict_count = record_attachment_field_conflict(
            conn,
            ctx,
            &incoming.attachment_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &structural_conflicts,
        )?;
        return Ok(AttachmentMergeResult {
            conflict_count,
            replace_incoming_chunks: false,
        });
    }

    apply_merged_attachment(
        conn,
        ctx,
        AttachmentMergeInput {
            base: &base_row,
            local: &local_row,
            incoming,
            local_commit_id,
            incoming_commit_id,
            use_incoming_content: replace_incoming_chunks,
        },
    )?;
    Ok(AttachmentMergeResult {
        conflict_count: 0,
        replace_incoming_chunks,
    })
}

fn apply_merged_attachment(
    conn: &VaultConnection,
    ctx: &CommitContext,
    input: AttachmentMergeInput<'_>,
) -> StorageResult<()> {
    let AttachmentMergeInput {
        base,
        local,
        incoming,
        local_commit_id,
        incoming_commit_id,
        use_incoming_content,
    } = input;
    let mut parents = vec![local_commit_id.to_string()];
    if incoming_commit_id != local_commit_id {
        parents.push(incoming_commit_id.to_string());
    }
    let commit_id = ctx.create_commit(
        conn,
        "merge",
        "attachment",
        &[incoming.attachment_id.clone()],
        &parents,
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let content_source = if use_incoming_content {
        incoming
    } else {
        local
    };

    if use_incoming_content {
        conn.inner().execute(
            "DELETE FROM attachment_chunks WHERE attachment_id = ?1",
            params![incoming.attachment_id],
        )?;
    }

    conn.inner().execute(
        "UPDATE attachments SET project_id = ?2, entry_id = ?3,
         file_name_ct = ?4, media_type_ct = ?5, storage_mode = ?6,
         content_hash = ?7, original_size = ?8, stored_size = ?9,
         chunk_count = ?10, head_commit_id = ?11, deleted = ?12,
         updated_at = ?13, updated_by_device_id = ?14
         WHERE attachment_id = ?1",
        params![
            incoming.attachment_id,
            object_merge_apply::merge_value(
                &base.project_id,
                &local.project_id,
                &incoming.project_id
            )
            .unwrap_or_else(|| local.project_id.clone()),
            object_merge_apply::merge_value(&base.entry_id, &local.entry_id, &incoming.entry_id)
                .unwrap_or_else(|| local.entry_id.clone()),
            object_merge_apply::merge_value(
                &base.file_name_ct,
                &local.file_name_ct,
                &incoming.file_name_ct,
            )
            .unwrap_or_else(|| local.file_name_ct.clone()),
            object_merge_apply::merge_value(
                &base.media_type_ct,
                &local.media_type_ct,
                &incoming.media_type_ct,
            )
            .unwrap_or_else(|| local.media_type_ct.clone()),
            content_source.storage_mode,
            content_source.content_hash,
            content_source.original_size as i64,
            content_source.stored_size as i64,
            content_source.chunk_count as i64,
            commit_id,
            local.deleted as i32,
            now,
            ctx.device_id,
        ],
    )?;
    ObjectVersionRepo::record_attachment_current(conn, &commit_id, &incoming.attachment_id)?;
    Ok(())
}

fn record_attachment_field_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    attachment_id: &str,
    base_commit_id: &str,
    local_commit_id: &str,
    incoming_commit_id: &str,
    fields: &[String],
) -> StorageResult<u32> {
    if ConflictRepo::has_unresolved_conflict(conn, ConflictObjectType::Attachment, attachment_id)? {
        return Ok(0);
    }
    ConflictRepo::create(
        conn,
        ctx,
        ConflictObjectType::Attachment,
        attachment_id,
        base_commit_id,
        local_commit_id,
        incoming_commit_id,
        fields,
    )?;
    Ok(1)
}

#[derive(Debug, Clone, Default)]
pub(super) struct AttachmentApplyResult {
    pub(super) ids: HashSet<String>,
    pub(super) conflict_count: u32,
}

#[derive(Debug, Clone, Copy, Default)]
struct AttachmentMergeResult {
    conflict_count: u32,
    replace_incoming_chunks: bool,
}

struct AttachmentMergeInput<'a> {
    base: &'a AttachmentRow,
    local: &'a AttachmentRow,
    incoming: &'a AttachmentRow,
    local_commit_id: &'a str,
    incoming_commit_id: &'a str,
    use_incoming_content: bool,
}

fn attachment_content_changed(base: &AttachmentRow, candidate: &AttachmentRow) -> bool {
    base.storage_mode != candidate.storage_mode
        || base.content_hash != candidate.content_hash
        || base.original_size != candidate.original_size
        || base.stored_size != candidate.stored_size
        || base.chunk_count != candidate.chunk_count
}

fn attachment_content_matches(left: &AttachmentRow, right: &AttachmentRow) -> bool {
    left.storage_mode == right.storage_mode
        && left.content_hash == right.content_hash
        && left.original_size == right.original_size
        && left.stored_size == right.stored_size
        && left.chunk_count == right.chunk_count
}
