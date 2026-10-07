use std::collections::BTreeMap;

use rusqlite::params;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::key_epoch::RANDOM_KEY_EPOCH_PROFILE_ID;
use crate::migration::FIELD_KEY_EPOCHS_EXTENSION;
use crate::sync_state::{KeyEpochRow, KeyEpochState};
use crate::unlock::UnlockService;

#[derive(Clone, Copy)]
pub(super) enum MergeMode {
    FastForward,
    Divergent,
}

pub(super) fn apply(
    conn: &VaultConnection,
    incoming: &KeyEpochState,
    merge_mode: MergeMode,
    allow_changes: bool,
) -> StorageResult<()> {
    validate(incoming)?;
    let local = load(conn)?;
    if same_state(&local, incoming) {
        return Ok(());
    }
    if !allow_changes {
        return Err(StorageError::Validation(
            "key epoch changes require mutable sync apply".to_string(),
        ));
    }
    if conn.active_key_epoch_id().is_none() {
        return Err(StorageError::Validation(
            "vault must be verified-unlocked before applying key epoch changes".to_string(),
        ));
    }
    if incoming
        .epochs
        .iter()
        .any(|row| row.kdf_profile_id == RANDOM_KEY_EPOCH_PROFILE_ID)
        && incoming.integrity_tag.is_none()
    {
        return Err(StorageError::Validation(
            "random key epoch sync state requires an integrity tag".to_string(),
        ));
    }
    incoming.verify_integrity(conn)?;

    let merged = merge(&local, incoming, merge_mode)?;
    for row in &merged.epochs {
        conn.inner().execute(
            "INSERT INTO key_epochs
                (key_epoch_id, status, wrapped_epoch_key_ct, kdf_profile_id,
                 created_at, activated_at, retired_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(key_epoch_id) DO UPDATE SET
                status = excluded.status,
                retired_at = excluded.retired_at",
            params![
                row.key_epoch_id,
                row.status,
                row.wrapped_epoch_key_ct,
                row.kdf_profile_id,
                row.created_at,
                row.activated_at,
                row.retired_at,
            ],
        )?;
    }
    conn.inner().execute(
        "UPDATE vault_meta SET active_key_epoch_id = ?1",
        params![merged.active_key_epoch_id],
    )?;
    if merged
        .epochs
        .iter()
        .any(|row| row.kdf_profile_id == RANDOM_KEY_EPOCH_PROFILE_ID)
    {
        conn.ensure_critical_extension(FIELD_KEY_EPOCHS_EXTENSION)?;
    }
    crate::vault_header_integrity::refresh_after_mutation(conn)?;
    UnlockService::verify_key_epoch_state(conn)
}

fn load(conn: &VaultConnection) -> StorageResult<KeyEpochState> {
    let active_key_epoch_id: String = conn.inner().query_row(
        "SELECT active_key_epoch_id FROM vault_meta LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    let mut stmt = conn.inner().prepare(
        "SELECT key_epoch_id, status, wrapped_epoch_key_ct, kdf_profile_id,
                created_at, activated_at, retired_at
         FROM key_epochs ORDER BY key_epoch_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(KeyEpochRow {
            key_epoch_id: row.get(0)?,
            status: row.get(1)?,
            wrapped_epoch_key_ct: row.get(2)?,
            kdf_profile_id: row.get(3)?,
            created_at: row.get(4)?,
            activated_at: row.get(5)?,
            retired_at: row.get(6)?,
        })
    })?;
    let mut epochs = Vec::new();
    for row in rows {
        epochs.push(row?);
    }
    let state = KeyEpochState {
        active_key_epoch_id,
        epochs,
        integrity_tag: None,
    };
    validate(&state)?;
    Ok(state)
}

fn validate(state: &KeyEpochState) -> StorageResult<()> {
    if state.active_key_epoch_id.is_empty() || state.epochs.is_empty() {
        return Err(StorageError::Validation(
            "key epoch sync state is empty".to_string(),
        ));
    }
    let mut previous_id: Option<&str> = None;
    let mut active_count = 0_u32;
    for row in &state.epochs {
        if row.key_epoch_id.is_empty() {
            return Err(StorageError::Validation(
                "key epoch sync state contains an empty ID".to_string(),
            ));
        }
        if previous_id.is_some_and(|previous| previous >= row.key_epoch_id.as_str()) {
            return Err(StorageError::Validation(
                "key epoch sync rows must be uniquely sorted by ID".to_string(),
            ));
        }
        previous_id = Some(&row.key_epoch_id);
        match row.status.as_str() {
            "active" => {
                active_count += 1;
                if row.key_epoch_id != state.active_key_epoch_id {
                    return Err(StorageError::Validation(
                        "active key epoch row does not match the sync state marker".to_string(),
                    ));
                }
            }
            "retired" => {}
            other => {
                return Err(StorageError::Validation(format!(
                    "unsupported synchronized key epoch status: {other}"
                )));
            }
        }
    }
    if active_count != 1 {
        return Err(StorageError::Validation(format!(
            "key epoch sync state contains {active_count} active rows"
        )));
    }
    Ok(())
}

fn same_state(local: &KeyEpochState, incoming: &KeyEpochState) -> bool {
    local.active_key_epoch_id == incoming.active_key_epoch_id && local.epochs == incoming.epochs
}

fn merge(
    local: &KeyEpochState,
    incoming: &KeyEpochState,
    mode: MergeMode,
) -> StorageResult<KeyEpochState> {
    validate(local)?;
    validate(incoming)?;
    let mut epochs = local
        .epochs
        .iter()
        .cloned()
        .map(|row| (row.key_epoch_id.clone(), row))
        .collect::<BTreeMap<_, _>>();

    for incoming_row in &incoming.epochs {
        if let Some(local_row) = epochs.get_mut(&incoming_row.key_epoch_id) {
            if local_row.wrapped_epoch_key_ct != incoming_row.wrapped_epoch_key_ct
                || local_row.kdf_profile_id != incoming_row.kdf_profile_id
                || local_row.created_at != incoming_row.created_at
                || local_row.activated_at != incoming_row.activated_at
            {
                return Err(StorageError::Validation(format!(
                    "key epoch {} immutable material was rewritten during sync",
                    incoming_row.key_epoch_id
                )));
            }
            local_row.retired_at = earliest_present(
                local_row.retired_at.clone(),
                incoming_row.retired_at.clone(),
            );
        } else {
            epochs.insert(incoming_row.key_epoch_id.clone(), incoming_row.clone());
        }
    }

    let active_key_epoch_id = match mode {
        MergeMode::FastForward => incoming.active_key_epoch_id.clone(),
        MergeMode::Divergent => {
            let local_active = epochs.get(&local.active_key_epoch_id).ok_or_else(|| {
                StorageError::Validation("local active key epoch row is missing".to_string())
            })?;
            let incoming_active = epochs.get(&incoming.active_key_epoch_id).ok_or_else(|| {
                StorageError::Validation("incoming active key epoch row is missing".to_string())
            })?;
            if activation_rank(incoming_active) > activation_rank(local_active) {
                incoming.active_key_epoch_id.clone()
            } else {
                local.active_key_epoch_id.clone()
            }
        }
    };
    let retirement_marker = epochs
        .get(&active_key_epoch_id)
        .and_then(|row| row.activated_at.clone())
        .or_else(|| {
            epochs
                .get(&active_key_epoch_id)
                .map(|row| row.created_at.clone())
        })
        .ok_or_else(|| StorageError::Validation("chosen key epoch row is missing".to_string()))?;

    for row in epochs.values_mut() {
        if row.key_epoch_id == active_key_epoch_id {
            row.status = "active".to_string();
            row.retired_at = None;
        } else {
            row.status = "retired".to_string();
            if row.retired_at.is_none() {
                row.retired_at = Some(retirement_marker.clone());
            }
        }
    }
    Ok(KeyEpochState {
        active_key_epoch_id,
        epochs: epochs.into_values().collect(),
        integrity_tag: None,
    })
}

fn activation_rank(row: &KeyEpochRow) -> (&str, &str) {
    (
        row.activated_at.as_deref().unwrap_or(&row.created_at),
        &row.key_epoch_id,
    )
}

fn earliest_present(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}
