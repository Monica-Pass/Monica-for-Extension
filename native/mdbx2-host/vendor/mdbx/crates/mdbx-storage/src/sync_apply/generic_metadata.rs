use rusqlite::{params, OptionalExtension};

use mdbx_core::model::ConflictObjectType;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{CommitContext, CommitGraphRepo, ConflictRepo, ObjectVersionRepo, TombstoneRepo};
use crate::sync_state::{ObjectLabelAssignmentRow, ObjectLabelRow, ObjectRelationRow};

use super::{commit_graph_apply, commit_graph_apply::ObjectDecision, object_merge_apply};

pub(super) fn apply_object_relations(
    conn: &VaultConnection,
    ctx: &CommitContext,
    relations: &[ObjectRelationRow],
) -> StorageResult<u32> {
    let mut conflicts = 0;
    for row in relations {
        if TombstoneRepo::is_permanently_purged(conn, "object-relation", &row.relation_id)? {
            continue;
        }
        row.relation_kind
            .parse::<mdbx_core::model::RelationKindId>()
            .map_err(StorageError::Validation)?;
        object_merge_apply::validate_payload_schema_version(row.payload_schema_version)?;
        if CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            ObjectVersionRepo::record_object_relation_row(conn, &row.head_commit_id, row)?;
        }
        match commit_graph_apply::object_apply_decision(
            conn,
            "object_relations",
            "relation_id",
            &row.relation_id,
            &row.head_commit_id,
        )? {
            ObjectDecision::Insert => {
                conn.inner().execute(
                    "INSERT INTO object_relations
                        (relation_id, source_object_id, target_object_id, relation_kind,
                         payload_ct, payload_schema_version, object_clock, head_commit_id,
                         deleted, created_at, updated_at, created_by_device_id,
                         updated_by_device_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    params![
                        row.relation_id,
                        row.source_object_id,
                        row.target_object_id,
                        row.relation_kind,
                        row.payload_ct,
                        row.payload_schema_version as i64,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_object_relation_row(conn, &row.head_commit_id, row)?;
            }
            ObjectDecision::FastForward => {
                conn.inner().execute(
                    "UPDATE object_relations SET source_object_id = ?2,
                        target_object_id = ?3, relation_kind = ?4, payload_ct = ?5,
                        payload_schema_version = ?6, object_clock = ?7,
                        head_commit_id = ?8, deleted = ?9, created_at = ?10,
                        updated_at = ?11, created_by_device_id = ?12,
                        updated_by_device_id = ?13 WHERE relation_id = ?1",
                    params![
                        row.relation_id,
                        row.source_object_id,
                        row.target_object_id,
                        row.relation_kind,
                        row.payload_ct,
                        row.payload_schema_version as i64,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_object_relation_row(conn, &row.head_commit_id, row)?;
            }
            ObjectDecision::Conflict { local_head } => {
                conflicts += record_generic_metadata_conflict(
                    conn,
                    ctx,
                    ConflictObjectType::ObjectRelation,
                    &row.relation_id,
                    &local_head,
                    &row.head_commit_id,
                    &[
                        "source_object_id",
                        "target_object_id",
                        "relation_kind",
                        "payload_ct",
                        "payload_schema_version",
                        "deleted",
                    ],
                )?;
            }
            ObjectDecision::Skip => {}
        }
    }
    Ok(conflicts)
}

pub(super) fn apply_object_labels(
    conn: &VaultConnection,
    ctx: &CommitContext,
    labels: &[ObjectLabelRow],
) -> StorageResult<u32> {
    let mut conflicts = 0;
    for row in labels {
        if TombstoneRepo::is_permanently_purged(conn, "object-label", &row.label_id)? {
            continue;
        }
        object_merge_apply::validate_payload_schema_version(row.payload_schema_version)?;
        if CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            ObjectVersionRepo::record_object_label_row(conn, &row.head_commit_id, row)?;
        }
        match commit_graph_apply::object_apply_decision(
            conn,
            "object_labels",
            "label_id",
            &row.label_id,
            &row.head_commit_id,
        )? {
            ObjectDecision::Insert => {
                conn.inner().execute(
                    "INSERT INTO object_labels
                        (label_id, collection_id, name_ct, payload_ct,
                         payload_schema_version, object_clock, head_commit_id,
                         deleted, created_at, updated_at, created_by_device_id,
                         updated_by_device_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        row.label_id,
                        row.collection_id,
                        row.name_ct,
                        row.payload_ct,
                        row.payload_schema_version as i64,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_object_label_row(conn, &row.head_commit_id, row)?;
            }
            ObjectDecision::FastForward => {
                conn.inner().execute(
                    "UPDATE object_labels SET collection_id = ?2, name_ct = ?3,
                        payload_ct = ?4, payload_schema_version = ?5,
                        object_clock = ?6, head_commit_id = ?7, deleted = ?8,
                        created_at = ?9, updated_at = ?10,
                        created_by_device_id = ?11, updated_by_device_id = ?12
                     WHERE label_id = ?1",
                    params![
                        row.label_id,
                        row.collection_id,
                        row.name_ct,
                        row.payload_ct,
                        row.payload_schema_version as i64,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_object_label_row(conn, &row.head_commit_id, row)?;
            }
            ObjectDecision::Conflict { local_head } => {
                conflicts += record_generic_metadata_conflict(
                    conn,
                    ctx,
                    ConflictObjectType::ObjectLabel,
                    &row.label_id,
                    &local_head,
                    &row.head_commit_id,
                    &[
                        "collection_id",
                        "name_ct",
                        "payload_ct",
                        "payload_schema_version",
                        "deleted",
                    ],
                )?;
            }
            ObjectDecision::Skip => {}
        }
    }
    Ok(conflicts)
}

pub(super) fn apply_object_label_assignments(
    conn: &VaultConnection,
    ctx: &CommitContext,
    assignments: &[ObjectLabelAssignmentRow],
) -> StorageResult<u32> {
    let mut conflicts = 0;
    for row in assignments {
        if TombstoneRepo::is_permanently_purged(
            conn,
            "object-label-assignment",
            &row.assignment_id,
        )? {
            continue;
        }
        if CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            ObjectVersionRepo::record_object_label_assignment_row(conn, &row.head_commit_id, row)?;
        }
        match commit_graph_apply::object_apply_decision(
            conn,
            "object_label_assignments",
            "assignment_id",
            &row.assignment_id,
            &row.head_commit_id,
        )? {
            ObjectDecision::Insert => {
                if !row.deleted {
                    let duplicate: Option<(String, String)> = conn
                        .inner()
                        .query_row(
                            "SELECT assignment_id, head_commit_id
                             FROM object_label_assignments
                             WHERE object_id = ?1 AND label_id = ?2 AND deleted = 0
                             LIMIT 1",
                            params![row.object_id, row.label_id],
                            |stored| Ok((stored.get(0)?, stored.get(1)?)),
                        )
                        .optional()?;
                    if let Some((duplicate_id, local_head)) = duplicate {
                        // The conflict represents one logical membership even when
                        // two devices created different assignment UUIDs. Preserve
                        // the incoming candidate under the local logical identity so
                        // IncomingWins can resolve it without creating a duplicate.
                        let mut logical_incoming = row.clone();
                        logical_incoming.assignment_id = duplicate_id.clone();
                        ObjectVersionRepo::record_object_label_assignment_row(
                            conn,
                            &row.head_commit_id,
                            &logical_incoming,
                        )?;
                        conflicts += record_generic_metadata_conflict(
                            conn,
                            ctx,
                            ConflictObjectType::ObjectLabelAssignment,
                            &duplicate_id,
                            &local_head,
                            &row.head_commit_id,
                            &["object_id", "label_id", "duplicate-active-assignment"],
                        )?;
                        continue;
                    }
                }
                conn.inner().execute(
                    "INSERT INTO object_label_assignments
                        (assignment_id, object_id, label_id, object_clock,
                         head_commit_id, deleted, created_at, updated_at,
                         created_by_device_id, updated_by_device_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        row.assignment_id,
                        row.object_id,
                        row.label_id,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_object_label_assignment_row(
                    conn,
                    &row.head_commit_id,
                    row,
                )?;
            }
            ObjectDecision::FastForward => {
                conn.inner().execute(
                    "UPDATE object_label_assignments SET object_id = ?2,
                        label_id = ?3, object_clock = ?4, head_commit_id = ?5,
                        deleted = ?6, created_at = ?7, updated_at = ?8,
                        created_by_device_id = ?9, updated_by_device_id = ?10
                     WHERE assignment_id = ?1",
                    params![
                        row.assignment_id,
                        row.object_id,
                        row.label_id,
                        row.object_clock,
                        row.head_commit_id,
                        row.deleted as i32,
                        row.created_at,
                        row.updated_at,
                        row.created_by_device_id,
                        row.updated_by_device_id,
                    ],
                )?;
                ObjectVersionRepo::record_object_label_assignment_row(
                    conn,
                    &row.head_commit_id,
                    row,
                )?;
            }
            ObjectDecision::Conflict { local_head } => {
                conflicts += record_generic_metadata_conflict(
                    conn,
                    ctx,
                    ConflictObjectType::ObjectLabelAssignment,
                    &row.assignment_id,
                    &local_head,
                    &row.head_commit_id,
                    &["object_id", "label_id", "deleted"],
                )?;
            }
            ObjectDecision::Skip => {}
        }
    }
    Ok(conflicts)
}

fn record_generic_metadata_conflict(
    conn: &VaultConnection,
    ctx: &CommitContext,
    object_type: ConflictObjectType,
    object_id: &str,
    local_head: &str,
    incoming_head: &str,
    fields: &[&str],
) -> StorageResult<u32> {
    if ConflictRepo::has_unresolved_conflict(conn, object_type.clone(), object_id)? {
        return Ok(0);
    }
    let base_commit_id =
        CommitGraphRepo::nearest_known_common_parent(conn, local_head, incoming_head)?
            .unwrap_or_else(|| local_head.to_string());
    let fields = fields
        .iter()
        .map(|field| (*field).to_string())
        .collect::<Vec<_>>();
    ConflictRepo::create(
        conn,
        ctx,
        object_type,
        object_id,
        &base_commit_id,
        local_head,
        incoming_head,
        &fields,
    )?;
    Ok(1)
}
