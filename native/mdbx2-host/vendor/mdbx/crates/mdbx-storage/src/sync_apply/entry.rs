use rusqlite::params;

use mdbx_core::model::{ConflictObjectType, ObjectTypeId};

use crate::conflict::ConflictDetector;
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{
    CollectionProfileRepo, CommitContext, CommitGraphRepo, ConflictRepo, EntryRepo,
    ObjectVersionRepo, TombstoneRepo,
};
use crate::sync_state::EntryRow;

use super::{commit_graph_apply, commit_graph_apply::ObjectDecision, object_merge_apply};

pub(super) fn apply_entries(
    conn: &VaultConnection,
    ctx: &CommitContext,
    _incoming_commit_id: &str,
    entries: &[EntryRow],
) -> StorageResult<u32> {
    let mut conflicts = 0;
    for row in entries {
        if TombstoneRepo::is_permanently_purged(conn, "entry", &row.entry_id)? {
            continue;
        }
        let object_type: ObjectTypeId = row.entry_type.parse().map_err(StorageError::Validation)?;
        CollectionProfileRepo::ensure_object_sync_allowed(conn, &row.project_id, &object_type)?;
        if CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            ObjectVersionRepo::record_entry_row(conn, &row.head_commit_id, row)?;
        }
        match commit_graph_apply::object_apply_decision(
            conn,
            "entries",
            "entry_id",
            &row.entry_id,
            &row.head_commit_id,
        )? {
            ObjectDecision::Insert => {
                conn.inner().execute(
                    "INSERT INTO entries (entry_id, project_id, entry_type, title_ct,
                     payload_ct, payload_schema_version, tiga_mode_override, object_clock,
                     head_commit_id, deleted, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    params![
                        row.entry_id,
                        row.project_id,
                        row.entry_type,
                        row.title_ct,
                        row.payload_ct,
                        row.payload_schema_version as i64,
                        row.tiga_mode_override,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_entry_row(conn, &row.head_commit_id, row)?;
            }
            ObjectDecision::FastForward => {
                conn.inner().execute(
                    "UPDATE entries SET project_id = ?2, entry_type = ?3, title_ct = ?4,
                     payload_ct = ?5, payload_schema_version = ?6, tiga_mode_override = ?7,
                     object_clock = ?8, head_commit_id = ?9, deleted = ?10,
                     created_at = ?11, updated_at = ?12,
                     created_by_device_id = ?13, updated_by_device_id = ?14
                     WHERE entry_id = ?1",
                    params![
                        row.entry_id,
                        row.project_id,
                        row.entry_type,
                        row.title_ct,
                        row.payload_ct,
                        row.payload_schema_version as i64,
                        row.tiga_mode_override,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_entry_row(conn, &row.head_commit_id, row)?;
            }
            ObjectDecision::Conflict { local_head } => {
                conflicts += merge_or_record_entry_conflict(conn, ctx, row, &local_head)?;
            }
            ObjectDecision::Skip => {}
        }
    }
    Ok(conflicts)
}

fn merge_or_record_entry_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    incoming: &EntryRow,
    local_commit_id: &str,
) -> StorageResult<u32> {
    let incoming_commit_id = &incoming.head_commit_id;
    let Some(base_commit_id) =
        CommitGraphRepo::nearest_known_common_parent(conn, local_commit_id, incoming_commit_id)?
    else {
        return record_entry_field_conflict(
            conn,
            ctx,
            &incoming.entry_id,
            "unknown",
            local_commit_id,
            incoming_commit_id,
            &[String::from("<base>")],
        );
    };

    let Some(base_row) = ObjectVersionRepo::get_entry(conn, &incoming.entry_id, &base_commit_id)?
    else {
        return record_entry_field_conflict(
            conn,
            ctx,
            &incoming.entry_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &[String::from("<base>")],
        );
    };

    let local_row = match ObjectVersionRepo::get_entry(conn, &incoming.entry_id, local_commit_id)? {
        Some(row) => row,
        None => ObjectVersionRepo::current_entry_row(conn, &incoming.entry_id)?,
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
    if object_merge_apply::merge_value(
        &base_row.entry_type,
        &local_row.entry_type,
        &incoming.entry_type,
    )
    .is_none()
    {
        structural_conflicts.push("entry_type".to_string());
    }
    if object_merge_apply::merge_value(&base_row.title_ct, &local_row.title_ct, &incoming.title_ct)
        .is_none()
    {
        structural_conflicts.push("title_ct".to_string());
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
    if !structural_conflicts.is_empty() {
        return record_entry_field_conflict(
            conn,
            ctx,
            &incoming.entry_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &structural_conflicts,
        );
    }

    let base_payload = entry_payload_json(conn, &base_row.entry_id, &base_row.payload_ct)?;
    let local_payload = entry_payload_json(conn, &local_row.entry_id, &local_row.payload_ct)?;
    let incoming_payload = entry_payload_json(conn, &incoming.entry_id, &incoming.payload_ct)?;
    let payload_conflicts =
        ConflictDetector::detect_entry_conflict(&base_payload, &local_payload, &incoming_payload);

    if !ConflictDetector::is_safe_to_auto_merge(&payload_conflicts) {
        return record_entry_field_conflict(
            conn,
            ctx,
            &incoming.entry_id,
            &base_commit_id,
            local_commit_id,
            incoming_commit_id,
            &payload_conflicts,
        );
    }

    let merged_payload =
        ConflictDetector::build_merged_payload(&base_payload, &local_payload, &incoming_payload);
    apply_merged_entry(
        conn,
        ctx,
        EntryMergeInput {
            base: &base_row,
            local: &local_row,
            incoming,
            local_commit_id,
            incoming_commit_id,
            merged_payload: &merged_payload,
        },
    )?;
    Ok(0)
}

fn apply_merged_entry(
    conn: &VaultConnection,
    ctx: &CommitContext,
    input: EntryMergeInput<'_>,
) -> StorageResult<()> {
    let EntryMergeInput {
        base,
        local,
        incoming,
        local_commit_id,
        incoming_commit_id,
        merged_payload,
    } = input;
    let mut parents = vec![local_commit_id.to_string()];
    if incoming_commit_id != local_commit_id {
        parents.push(incoming_commit_id.to_string());
    }
    let commit_id = ctx.create_commit(
        conn,
        "merge",
        "entry",
        &[incoming.entry_id.clone()],
        &parents,
    )?;
    let payload_plain = serde_json::to_vec(merged_payload)
        .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
    let payload_ct = EntryRepo::encrypt_payload_blob(conn, &incoming.entry_id, &payload_plain)?;
    let now = chrono::Utc::now().to_rfc3339();
    let project_id =
        object_merge_apply::merge_value(&base.project_id, &local.project_id, &incoming.project_id)
            .unwrap_or_else(|| local.project_id.clone());
    let entry_type =
        object_merge_apply::merge_value(&base.entry_type, &local.entry_type, &incoming.entry_type)
            .unwrap_or_else(|| local.entry_type.clone());
    let title_ct =
        object_merge_apply::merge_value(&base.title_ct, &local.title_ct, &incoming.title_ct)
            .unwrap_or_else(|| local.title_ct.clone());
    let tiga_mode_override = object_merge_apply::merge_value(
        &base.tiga_mode_override,
        &local.tiga_mode_override,
        &incoming.tiga_mode_override,
    )
    .unwrap_or_else(|| local.tiga_mode_override.clone());

    conn.inner().execute(
        "UPDATE entries SET project_id = ?2, entry_type = ?3, title_ct = ?4,
         payload_ct = ?5, payload_schema_version = ?6, tiga_mode_override = ?7,
         object_clock = ?8, head_commit_id = ?9, deleted = 0,
         updated_at = ?10, updated_by_device_id = ?11
         WHERE entry_id = ?1",
        params![
            incoming.entry_id,
            project_id,
            entry_type,
            title_ct,
            payload_ct,
            std::cmp::max(
                local.payload_schema_version,
                incoming.payload_schema_version
            ) as i64,
            tiga_mode_override,
            object_merge_apply::bump_object_clock(&local.object_clock),
            commit_id,
            now,
            ctx.device_id,
        ],
    )?;
    ObjectVersionRepo::record_entry_current(conn, &commit_id, &incoming.entry_id)?;
    Ok(())
}

fn entry_payload_json(
    conn: &VaultConnection,
    entry_id: &str,
    payload_ct: &[u8],
) -> StorageResult<serde_json::Value> {
    let plaintext = EntryRepo::decrypt_payload_blob(conn, entry_id, payload_ct)?;
    mdbx_core::json::from_slice(&plaintext).map_err(|e| {
        StorageError::Validation(format!(
            "entry {} payload is not valid JSON: {}",
            entry_id, e
        ))
    })
}

fn record_entry_field_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    entry_id: &str,
    base_commit_id: &str,
    local_commit_id: &str,
    incoming_commit_id: &str,
    fields: &[String],
) -> StorageResult<u32> {
    if ConflictRepo::has_unresolved_conflict(conn, ConflictObjectType::Entry, entry_id)? {
        return Ok(0);
    }
    ConflictRepo::create(
        conn,
        ctx,
        ConflictObjectType::Entry,
        entry_id,
        base_commit_id,
        local_commit_id,
        incoming_commit_id,
        fields,
    )?;
    Ok(1)
}

struct EntryMergeInput<'a> {
    base: &'a EntryRow,
    local: &'a EntryRow,
    incoming: &'a EntryRow,
    local_commit_id: &'a str,
    incoming_commit_id: &'a str,
    merged_payload: &'a serde_json::Value,
}
