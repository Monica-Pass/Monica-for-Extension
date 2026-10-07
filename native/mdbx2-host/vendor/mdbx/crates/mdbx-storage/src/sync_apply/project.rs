use rusqlite::params;

use mdbx_core::model::ConflictObjectType;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{
    CollectionProfileRepo, CommitContext, CommitGraphRepo, ConflictRepo, ObjectVersionRepo,
    TombstoneRepo,
};
use crate::sync_state::{ProjectRow, ProjectTagSetRow};

use super::{commit_graph_apply, commit_graph_apply::ObjectDecision, object_merge_apply};

pub(super) fn apply_projects(
    conn: &VaultConnection,
    ctx: &CommitContext,
    _incoming_commit_id: &str,
    projects: &[ProjectRow],
) -> StorageResult<u32> {
    let mut conflicts = 0;
    for row in projects {
        if TombstoneRepo::is_permanently_purged(conn, "project", &row.project_id)? {
            continue;
        }
        if CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            ObjectVersionRepo::record_project_row(conn, &row.head_commit_id, row)?;
        }
        match commit_graph_apply::object_apply_decision(
            conn,
            "projects",
            "project_id",
            &row.project_id,
            &row.head_commit_id,
        )? {
            ObjectDecision::Insert => {
                conn.inner().execute(
                    "INSERT INTO projects (project_id, title_ct, summary_ct, group_id, icon_ref,
                     favorite, archived, deleted, tiga_mode_override, object_clock,
                     head_commit_id, attachment_count, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![
                        row.project_id,
                        row.title_ct,
                        row.summary_ct,
                        row.group_id,
                        row.icon_ref,
                        row.favorite as i32,
                        row.archived as i32,
                        row.deleted as i32,
                        row.tiga_mode_override,
                        row.object_clock,
                        row.head_commit_id,
                        row.attachment_count as i64,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                if let Some(profile) = &row.collection_profile {
                    if profile.project_id != row.project_id {
                        return Err(StorageError::ConstraintViolation(
                            "collection profile project ID does not match project row".to_string(),
                        ));
                    }
                    CollectionProfileRepo::apply_synced_row(conn, profile)?;
                }
                ObjectVersionRepo::record_project_current(
                    conn,
                    &row.head_commit_id,
                    &row.project_id,
                )?;
            }
            ObjectDecision::FastForward => {
                conn.inner().execute(
                    "UPDATE projects SET title_ct = ?2, summary_ct = ?3, group_id = ?4,
                     icon_ref = ?5, favorite = ?6, archived = ?7, deleted = ?8,
                     tiga_mode_override = ?9, object_clock = ?10, head_commit_id = ?11,
                     attachment_count = ?12, created_at = ?13, updated_at = ?14,
                     created_by_device_id = ?15, updated_by_device_id = ?16
                     WHERE project_id = ?1",
                    params![
                        row.project_id,
                        row.title_ct,
                        row.summary_ct,
                        row.group_id,
                        row.icon_ref,
                        row.favorite as i32,
                        row.archived as i32,
                        row.deleted as i32,
                        row.tiga_mode_override,
                        row.object_clock,
                        row.head_commit_id,
                        row.attachment_count as i64,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                if let Some(profile) = &row.collection_profile {
                    if profile.project_id != row.project_id {
                        return Err(StorageError::ConstraintViolation(
                            "collection profile project ID does not match project row".to_string(),
                        ));
                    }
                    CollectionProfileRepo::apply_synced_row(conn, profile)?;
                }
                ObjectVersionRepo::record_project_current(
                    conn,
                    &row.head_commit_id,
                    &row.project_id,
                )?;
            }
            ObjectDecision::Conflict { local_head } => {
                conflicts += merge_or_record_project_conflict(conn, ctx, row, &local_head)?;
            }
            ObjectDecision::Skip => {}
        }
    }
    Ok(conflicts)
}

pub(super) fn apply_project_tags(
    conn: &VaultConnection,
    tag_sets: &[ProjectTagSetRow],
) -> StorageResult<()> {
    for row in tag_sets {
        if TombstoneRepo::is_permanently_purged(conn, "project", &row.project_id)? {
            continue;
        }
        conn.inner().execute(
            "DELETE FROM project_tags WHERE project_id = ?1",
            params![row.project_id],
        )?;
        for tag in &row.tags {
            let trimmed = tag.trim().to_lowercase();
            if trimmed.is_empty() {
                continue;
            }
            conn.inner().execute(
                "INSERT OR IGNORE INTO project_tags (project_id, tag) VALUES (?1, ?2)",
                params![row.project_id, trimmed],
            )?;
        }
    }
    Ok(())
}

fn merge_or_record_project_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    incoming: &ProjectRow,
    local_commit_id: &str,
) -> StorageResult<u32> {
    let incoming_commit_id = &incoming.head_commit_id;
    let Some(base_commit_id) =
        CommitGraphRepo::nearest_known_common_parent(conn, local_commit_id, incoming_commit_id)?
    else {
        return record_project_field_conflict(
            conn,
            ctx,
            &incoming.project_id,
            "unknown",
            local_commit_id,
            incoming_commit_id,
            &[String::from("<base>")],
        );
    };

    let Some(base_row) =
        ObjectVersionRepo::get_project(conn, &incoming.project_id, &base_commit_id)?
    else {
        return record_project_field_conflict(
            conn,
            ctx,
            &incoming.project_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &[String::from("<base>")],
        );
    };

    let local_row =
        match ObjectVersionRepo::get_project(conn, &incoming.project_id, local_commit_id)? {
            Some(row) => row,
            None => ObjectVersionRepo::current_project_row(conn, &incoming.project_id)?,
        };

    let local_profile = local_row
        .collection_profile
        .clone()
        .or_else(|| base_row.collection_profile.clone());
    let incoming_profile = incoming
        .collection_profile
        .clone()
        .or_else(|| base_row.collection_profile.clone());

    let mut structural_conflicts = Vec::new();
    if local_row.deleted != incoming.deleted {
        structural_conflicts.push("deleted".to_string());
    }
    if object_merge_apply::merge_value(&base_row.title_ct, &local_row.title_ct, &incoming.title_ct)
        .is_none()
    {
        structural_conflicts.push("title_ct".to_string());
    }
    if object_merge_apply::merge_value(
        &base_row.summary_ct,
        &local_row.summary_ct,
        &incoming.summary_ct,
    )
    .is_none()
    {
        structural_conflicts.push("summary_ct".to_string());
    }
    if object_merge_apply::merge_value(&base_row.group_id, &local_row.group_id, &incoming.group_id)
        .is_none()
    {
        structural_conflicts.push("group_id".to_string());
    }
    if object_merge_apply::merge_value(&base_row.icon_ref, &local_row.icon_ref, &incoming.icon_ref)
        .is_none()
    {
        structural_conflicts.push("icon_ref".to_string());
    }
    if object_merge_apply::merge_value(&base_row.favorite, &local_row.favorite, &incoming.favorite)
        .is_none()
    {
        structural_conflicts.push("favorite".to_string());
    }
    if object_merge_apply::merge_value(&base_row.archived, &local_row.archived, &incoming.archived)
        .is_none()
    {
        structural_conflicts.push("archived".to_string());
    }
    if object_merge_apply::merge_value(
        &base_row.tiga_mode_override,
        &local_row.tiga_mode_override,
        &incoming.tiga_mode_override,
    )
    .is_none()
    {
        structural_conflicts.push("tiga_mode_override".to_string());
    }
    if object_merge_apply::merge_value(
        &base_row.collection_profile,
        &local_profile,
        &incoming_profile,
    )
    .is_none()
    {
        structural_conflicts.push("collection_profile".to_string());
    }

    if !structural_conflicts.is_empty() {
        return record_project_field_conflict(
            conn,
            ctx,
            &incoming.project_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &structural_conflicts,
        );
    }

    apply_merged_project(
        conn,
        ctx,
        &base_row,
        &local_row,
        incoming,
        local_commit_id,
        incoming_commit_id,
    )?;
    Ok(0)
}

fn apply_merged_project(
    conn: &VaultConnection,
    ctx: &CommitContext,
    base: &ProjectRow,
    local: &ProjectRow,
    incoming: &ProjectRow,
    local_commit_id: &str,
    incoming_commit_id: &str,
) -> StorageResult<()> {
    let mut parents = vec![local_commit_id.to_string()];
    if incoming_commit_id != local_commit_id {
        parents.push(incoming_commit_id.to_string());
    }
    let commit_id = ctx.create_commit(
        conn,
        "merge",
        "project",
        &[incoming.project_id.clone()],
        &parents,
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let attachment_count = object_merge_apply::merge_value(
        &base.attachment_count,
        &local.attachment_count,
        &incoming.attachment_count,
    )
    .unwrap_or_else(|| std::cmp::max(local.attachment_count, incoming.attachment_count));
    let local_profile = local
        .collection_profile
        .clone()
        .or_else(|| base.collection_profile.clone());
    let incoming_profile = incoming
        .collection_profile
        .clone()
        .or_else(|| base.collection_profile.clone());
    let collection_profile = object_merge_apply::merge_value(
        &base.collection_profile,
        &local_profile,
        &incoming_profile,
    )
    .unwrap_or(local_profile);

    conn.inner().execute(
        "UPDATE projects SET title_ct = ?2, summary_ct = ?3, group_id = ?4,
         icon_ref = ?5, favorite = ?6, archived = ?7, deleted = ?8,
         tiga_mode_override = ?9, object_clock = ?10, head_commit_id = ?11,
         attachment_count = ?12, updated_at = ?13, updated_by_device_id = ?14
         WHERE project_id = ?1",
        params![
            incoming.project_id,
            object_merge_apply::merge_value(&base.title_ct, &local.title_ct, &incoming.title_ct)
                .unwrap_or_else(|| local.title_ct.clone()),
            object_merge_apply::merge_value(
                &base.summary_ct,
                &local.summary_ct,
                &incoming.summary_ct
            )
            .unwrap_or_else(|| local.summary_ct.clone()),
            object_merge_apply::merge_value(&base.group_id, &local.group_id, &incoming.group_id)
                .unwrap_or_else(|| local.group_id.clone()),
            object_merge_apply::merge_value(&base.icon_ref, &local.icon_ref, &incoming.icon_ref)
                .unwrap_or_else(|| local.icon_ref.clone()),
            object_merge_apply::merge_value(&base.favorite, &local.favorite, &incoming.favorite)
                .unwrap_or(local.favorite) as i32,
            object_merge_apply::merge_value(&base.archived, &local.archived, &incoming.archived)
                .unwrap_or(local.archived) as i32,
            local.deleted as i32,
            object_merge_apply::merge_value(
                &base.tiga_mode_override,
                &local.tiga_mode_override,
                &incoming.tiga_mode_override,
            )
            .unwrap_or_else(|| local.tiga_mode_override.clone()),
            object_merge_apply::bump_object_clock(&local.object_clock),
            commit_id,
            attachment_count as i64,
            now,
            ctx.device_id,
        ],
    )?;
    if let Some(profile) = &collection_profile {
        CollectionProfileRepo::apply_synced_row(conn, profile)?;
    }
    ObjectVersionRepo::record_project_current(conn, &commit_id, &incoming.project_id)?;
    Ok(())
}

fn record_project_field_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    project_id: &str,
    base_commit_id: &str,
    local_commit_id: &str,
    incoming_commit_id: &str,
    fields: &[String],
) -> StorageResult<u32> {
    if ConflictRepo::has_unresolved_conflict(conn, ConflictObjectType::Project, project_id)? {
        return Ok(0);
    }
    ConflictRepo::create(
        conn,
        ctx,
        ConflictObjectType::Project,
        project_id,
        base_commit_id,
        local_commit_id,
        incoming_commit_id,
        fields,
    )?;
    Ok(1)
}
