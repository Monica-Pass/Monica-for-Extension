use std::cmp::Ordering;

use rusqlite::{params, OptionalExtension};

use mdbx_sync::SerializedCommit;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::{BranchRepo, CommitGraphRepo};
use crate::sync_state::BranchRow;

pub(super) fn apply_branches(conn: &VaultConnection, branches: &[BranchRow]) -> StorageResult<()> {
    for row in branches {
        if !CommitGraphRepo::commit_exists(conn, &row.head_commit_id)? {
            continue;
        }
        let local_head: Option<String> = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_id = ?1",
                params![row.branch_id],
                |row| row.get(0),
            )
            .optional()?;

        let should_upsert = match local_head {
            None => true,
            Some(local_head) if local_head == row.head_commit_id => false,
            Some(local_head) => {
                CommitGraphRepo::is_ancestor(conn, &local_head, &row.head_commit_id)?
            }
        };
        if should_upsert {
            conn.inner().execute(
                "INSERT INTO branches (branch_id, branch_name, head_commit_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(branch_id) DO UPDATE SET
                    branch_name = excluded.branch_name,
                    head_commit_id = excluded.head_commit_id,
                    updated_at = excluded.updated_at",
                params![
                    row.branch_id,
                    row.branch_name,
                    row.head_commit_id,
                    row.created_at,
                    row.updated_at,
                ],
            )?;
        }
    }
    Ok(())
}

pub(super) fn object_apply_decision(
    conn: &VaultConnection,
    table: &str,
    id_column: &str,
    object_id: &str,
    incoming_head: &str,
) -> StorageResult<ObjectDecision> {
    let sql = format!(
        "SELECT head_commit_id FROM {} WHERE {} = ?1",
        table, id_column
    );
    let local_head: Option<String> = conn
        .inner()
        .query_row(&sql, params![object_id], |row| row.get(0))
        .optional()?;

    let Some(local_head) = local_head else {
        return Ok(ObjectDecision::Insert);
    };
    if local_head == incoming_head {
        return Ok(ObjectDecision::Skip);
    }
    if CommitGraphRepo::is_ancestor(conn, &local_head, incoming_head)? {
        return Ok(ObjectDecision::FastForward);
    }
    if CommitGraphRepo::is_ancestor(conn, incoming_head, &local_head)? {
        return Ok(ObjectDecision::Skip);
    }
    Ok(ObjectDecision::Conflict { local_head })
}

pub(super) fn sync_device_head(
    conn: &VaultConnection,
    serialized: &SerializedCommit,
) -> StorageResult<()> {
    merge_device_head(
        conn,
        &serialized.commit.device_id,
        &serialized.commit.commit_id,
        &serialized.commit.created_at,
        false,
    )
}

pub(super) fn merge_device_head(
    conn: &VaultConnection,
    device_id: &str,
    incoming_head_commit_id: &str,
    incoming_last_seen_at: &str,
    incoming_revoked: bool,
) -> StorageResult<()> {
    let incoming_sequence =
        require_device_commit_sequence(conn, device_id, incoming_head_commit_id)?;
    let local: Option<(String, String, bool)> = conn
        .inner()
        .query_row(
            "SELECT head_commit_id, last_seen_at, revoked FROM device_heads
             WHERE device_id = ?1",
            params![device_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i32>(2)? != 0)),
        )
        .optional()?;

    let (head_commit_id, last_seen_at, revoked) = match local {
        None => (
            incoming_head_commit_id.to_string(),
            incoming_last_seen_at.to_string(),
            incoming_revoked,
        ),
        Some((local_head_commit_id, local_last_seen_at, local_revoked)) => {
            let local_sequence =
                require_device_commit_sequence(conn, device_id, &local_head_commit_id)?;
            let head_commit_id = match incoming_sequence.cmp(&local_sequence) {
                Ordering::Greater => incoming_head_commit_id.to_string(),
                Ordering::Less => local_head_commit_id,
                Ordering::Equal if local_head_commit_id == incoming_head_commit_id => {
                    local_head_commit_id
                }
                Ordering::Equal => {
                    return Err(StorageError::Validation(format!(
                        "device {} has conflicting commits {} and {} at local sequence {}",
                        device_id, local_head_commit_id, incoming_head_commit_id, incoming_sequence
                    )))
                }
            };
            let last_seen_at = if local_last_seen_at.as_str() >= incoming_last_seen_at {
                local_last_seen_at
            } else {
                incoming_last_seen_at.to_string()
            };
            (
                head_commit_id,
                last_seen_at,
                local_revoked || incoming_revoked,
            )
        }
    };

    conn.inner().execute(
        "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at, revoked)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(device_id) DO UPDATE SET
            head_commit_id = excluded.head_commit_id,
            last_seen_at = excluded.last_seen_at,
            revoked = excluded.revoked",
        params![device_id, head_commit_id, last_seen_at, revoked as i32],
    )?;
    Ok(())
}

fn require_device_commit_sequence(
    conn: &VaultConnection,
    device_id: &str,
    commit_id: &str,
) -> StorageResult<i64> {
    let commit: Option<(String, i64)> = conn
        .inner()
        .query_row(
            "SELECT device_id, local_seq FROM commits WHERE commit_id = ?1",
            params![commit_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((commit_device_id, local_sequence)) = commit else {
        return Err(StorageError::ConstraintViolation(format!(
            "device head {} references unavailable commit {}",
            device_id, commit_id
        )));
    };
    if commit_device_id != device_id {
        return Err(StorageError::Validation(format!(
            "device head {} references commit {} authored by {}",
            device_id, commit_id, commit_device_id
        )));
    }
    if local_sequence < 0 {
        return Err(StorageError::Validation(format!(
            "device head {} references commit {} with negative local sequence {}",
            device_id, commit_id, local_sequence
        )));
    }
    Ok(local_sequence)
}

pub(super) fn current_branch_head(
    conn: &VaultConnection,
    branch_id: Option<&str>,
    branch_name: &str,
) -> StorageResult<Option<String>> {
    if let Some(branch_id) = branch_id {
        return Ok(BranchRepo::get_by_id(conn, branch_id)?.map(|branch| branch.head_commit_id));
    }
    match BranchRepo::resolve_unique_name(conn, branch_name) {
        Ok(branch) => Ok(Some(branch.head_commit_id)),
        Err(StorageError::NotFound(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn advance_branch(
    conn: &VaultConnection,
    branch_id: Option<&str>,
    branch_name: &str,
    commit_id: &str,
) -> StorageResult<()> {
    let branch = match branch_id {
        Some(branch_id) => BranchRepo::require_by_id(conn, branch_id)?,
        None => BranchRepo::resolve_unique_name(conn, branch_name)?,
    };
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn.inner().execute(
        "UPDATE branches SET head_commit_id = ?1, updated_at = ?2 WHERE branch_id = ?3",
        params![commit_id, now, branch.branch_id],
    )?;
    if updated != 1 {
        return Err(StorageError::NotFound(format!(
            "branch ID {} not found",
            branch.branch_id
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ObjectDecision {
    Insert,
    FastForward,
    Conflict { local_head: String },
    Skip,
}
