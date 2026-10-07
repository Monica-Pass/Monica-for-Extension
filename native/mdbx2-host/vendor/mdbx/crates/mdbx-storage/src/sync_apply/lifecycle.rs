use rusqlite::{params, OptionalExtension};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{
    CommitGraphRepo, PermanentPurgeReceipt, TombstoneAcknowledgementRepo, TombstoneRepo,
};
use crate::sync_delta::{DeletedSyncEntity, DeviceHeadRow, SyncDeltaBody};
use crate::sync_state::{PurgeReceiptRow, TombstoneAcknowledgementRow, TombstoneRow};

use super::commit_graph_apply;

pub(super) fn apply_purge_receipts(
    conn: &VaultConnection,
    rows: &[PurgeReceiptRow],
) -> StorageResult<()> {
    let mut receipts = rows
        .iter()
        .map(|row| PermanentPurgeReceipt {
            purge_id: row.purge_id.clone(),
            tombstone_id: row.tombstone_id.clone(),
            target_object_type: row.target_object_type.clone(),
            target_object_id: row.target_object_id.clone(),
            delete_commit_id: row.delete_commit_id.clone(),
            purge_commit_id: row.purge_commit_id.clone(),
            delete_clock: row.delete_clock.clone(),
            retention_eligible_at: row.retention_eligible_at.clone(),
            purged_by_device_id: row.purged_by_device_id.clone(),
            purged_at: row.purged_at.clone(),
            integrity_tag: row.integrity_tag.clone(),
        })
        .collect::<Vec<_>>();
    receipts.sort_by_key(|receipt| purge_dependency_order(&receipt.target_object_type));
    for receipt in receipts {
        if !CommitGraphRepo::commit_exists(conn, &receipt.delete_commit_id)?
            || !CommitGraphRepo::commit_exists(conn, &receipt.purge_commit_id)?
        {
            return Err(StorageError::ConstraintViolation(format!(
                "permanent purge receipt {} references unavailable commits",
                receipt.purge_id
            )));
        }
        TombstoneRepo::apply_synced_purge_receipt(conn, &receipt)?;
    }
    Ok(())
}

pub(super) fn apply_complete_tombstone_state(
    conn: &VaultConnection,
    tombstones: &[TombstoneRow],
) -> StorageResult<()> {
    conn.inner().execute("DELETE FROM tombstones", [])?;
    for row in tombstones {
        if TombstoneRepo::is_permanently_purged(
            conn,
            &row.target_object_type,
            &row.target_object_id,
        )? {
            continue;
        }
        let delete_commit_id = match row.delete_commit_id.as_deref() {
            Some(commit_id) if CommitGraphRepo::commit_exists(conn, commit_id)? => Some(commit_id),
            _ => None,
        };
        conn.inner().execute(
            "INSERT INTO tombstones (tombstone_id, target_object_type, target_object_id, delete_clock, deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![row.tombstone_id, row.target_object_type, row.target_object_id, row.delete_clock, row.deleted_by_device_id, row.deleted_at, row.purge_eligible_at, delete_commit_id],
        )?;
    }
    Ok(())
}

pub(super) fn apply_delta_tombstone_state(
    conn: &VaultConnection,
    tombstones: &[TombstoneRow],
) -> StorageResult<()> {
    for row in tombstones {
        if TombstoneRepo::is_permanently_purged(
            conn,
            &row.target_object_type,
            &row.target_object_id,
        )? {
            continue;
        }
        let delete_commit_id = match row.delete_commit_id.as_deref() {
            Some(commit_id) if CommitGraphRepo::commit_exists(conn, commit_id)? => Some(commit_id),
            Some(commit_id) => {
                return Err(StorageError::ConstraintViolation(format!(
                    "delta tombstone {} references unavailable commit {commit_id}",
                    row.tombstone_id
                )))
            }
            None => None,
        };
        let local_identity: Option<(String, String)> = conn.inner().query_row(
            "SELECT target_object_type, target_object_id FROM tombstones WHERE tombstone_id = ?1",
            [&row.tombstone_id], |sql_row| Ok((sql_row.get(0)?, sql_row.get(1)?)),
        ).optional()?;
        if local_identity.as_ref().is_some_and(|identity| {
            identity.0 != row.target_object_type || identity.1 != row.target_object_id
        }) {
            return Err(StorageError::Validation(format!(
                "delta tombstone {} rewrites its target identity",
                row.tombstone_id
            )));
        }
        conn.inner().execute(
            "INSERT INTO tombstones (tombstone_id, target_object_type, target_object_id, delete_clock, deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(tombstone_id) DO UPDATE SET delete_clock = excluded.delete_clock, deleted_by_device_id = excluded.deleted_by_device_id, deleted_at = excluded.deleted_at, purge_eligible_at = excluded.purge_eligible_at, delete_commit_id = excluded.delete_commit_id",
            params![row.tombstone_id, row.target_object_type, row.target_object_id, row.delete_clock, row.deleted_by_device_id, row.deleted_at, row.purge_eligible_at, delete_commit_id],
        )?;
    }
    Ok(())
}

pub(super) fn apply_tombstone_acknowledgements(
    conn: &VaultConnection,
    acknowledgements: &[TombstoneAcknowledgementRow],
) -> StorageResult<()> {
    for row in acknowledgements {
        let references_exist: bool = conn.inner().query_row(
            "SELECT EXISTS(SELECT 1 FROM tombstones t, commits c WHERE t.tombstone_id = ?1 AND c.commit_id = ?2)",
            params![row.tombstone_id, row.observed_commit_id], |sql_row| sql_row.get(0),
        )?;
        if !references_exist {
            continue;
        }
        TombstoneAcknowledgementRepo::merge(
            conn,
            &row.tombstone_id,
            &row.device_id,
            &row.observed_commit_id,
            &row.acknowledged_at,
        )?;
    }
    Ok(())
}

pub(super) fn apply_delta_device_heads(
    conn: &VaultConnection,
    device_heads: &[DeviceHeadRow],
) -> StorageResult<()> {
    for incoming in device_heads {
        commit_graph_apply::merge_device_head(
            conn,
            &incoming.device_id,
            &incoming.head_commit_id,
            &incoming.last_seen_at,
            incoming.revoked,
        )?;
    }
    Ok(())
}

pub(super) fn apply_delta_deletions(
    conn: &VaultConnection,
    body: &SyncDeltaBody,
) -> StorageResult<()> {
    for deletion in &body.deletions {
        match deletion.entity_kind.as_str() {
            "tiga-override" => {
                let (scope_type, scope_id) = split_compound_delta_id(deletion)?;
                conn.inner().execute(
                    "DELETE FROM tiga_policy_overrides WHERE scope_type = ?1 AND scope_id = ?2",
                    params![scope_type, scope_id],
                )?;
            }
            "collection-profile" => {
                conn.inner().execute(
                    "DELETE FROM collection_profiles WHERE project_id = ?1",
                    [&deletion.entity_id],
                )?;
            }
            "project"
            | "entry"
            | "attachment"
            | "object-relation"
            | "object-label"
            | "object-label-assignment" => {
                if !body.state.purge_receipts.as_ref().is_some_and(|receipts| {
                    receipts.iter().any(|receipt| {
                        receipt.target_object_type == deletion.entity_kind
                            && receipt.target_object_id == deletion.entity_id
                    })
                }) {
                    return Err(StorageError::Validation(format!(
                        "physical {} deletion lacks a matching purge receipt",
                        deletion.entity_kind
                    )));
                }
            }
            "tombstone" => {
                if !body.state.purge_receipts.as_ref().is_some_and(|receipts| {
                    receipts
                        .iter()
                        .any(|receipt| receipt.tombstone_id == deletion.entity_id)
                }) {
                    return Err(StorageError::Validation(
                        "tombstone deletion lacks a matching purge receipt".to_string(),
                    ));
                }
            }
            "tombstone-ack" => {
                let (tombstone_id, _) = split_compound_delta_id(deletion)?;
                if !body.state.purge_receipts.as_ref().is_some_and(|receipts| {
                    receipts
                        .iter()
                        .any(|receipt| receipt.tombstone_id == tombstone_id)
                }) {
                    return Err(StorageError::Validation(
                        "tombstone acknowledgement deletion lacks a matching purge receipt"
                            .to_string(),
                    ));
                }
            }
            other => {
                return Err(StorageError::Validation(format!(
                    "unsupported sync delta deletion kind: {other}"
                )))
            }
        }
    }
    Ok(())
}

fn purge_dependency_order(object_type: &str) -> u8 {
    match object_type {
        "object-label-assignment" => 0,
        "object-relation" => 1,
        "attachment" => 2,
        "object-label" => 3,
        "entry" => 4,
        "project" => 5,
        _ => u8::MAX,
    }
}

fn split_compound_delta_id(deletion: &DeletedSyncEntity) -> StorageResult<(&str, &str)> {
    deletion.entity_id.split_once('\u{1f}').ok_or_else(|| {
        StorageError::Validation(format!(
            "invalid compound sync delta deletion ID for {}",
            deletion.entity_kind
        ))
    })
}
