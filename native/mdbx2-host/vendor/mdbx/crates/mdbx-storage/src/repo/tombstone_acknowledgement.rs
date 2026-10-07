use rusqlite::{params, OptionalExtension};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

use super::CommitGraphRepo;

/// Causal and monotonic storage for one device's tombstone observation proof.
pub(crate) struct TombstoneAcknowledgementRepo;

impl TombstoneAcknowledgementRepo {
    pub(crate) fn merge(
        conn: &VaultConnection,
        tombstone_id: &str,
        device_id: &str,
        observed_commit_id: &str,
        acknowledged_at: &str,
    ) -> StorageResult<()> {
        let delete_commit_id = Self::delete_commit_id(conn, tombstone_id)?;
        Self::validate_incoming_proof(
            conn,
            tombstone_id,
            delete_commit_id.as_deref(),
            observed_commit_id,
        )?;

        let local: Option<(String, String)> = conn
            .inner()
            .query_row(
                "SELECT observed_commit_id, acknowledged_at
                 FROM tombstone_acknowledgements
                 WHERE tombstone_id = ?1 AND device_id = ?2",
                params![tombstone_id, device_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let (selected_commit_id, selected_at) = match local {
            None => (observed_commit_id.to_string(), acknowledged_at.to_string()),
            Some((local_commit_id, local_at)) => {
                let local_valid = Self::proof_is_causally_valid(
                    conn,
                    delete_commit_id.as_deref(),
                    &local_commit_id,
                )?;
                let use_incoming = if !local_valid {
                    true
                } else if local_commit_id == observed_commit_id {
                    false
                } else if CommitGraphRepo::is_ancestor(conn, &local_commit_id, observed_commit_id)?
                {
                    true
                } else if CommitGraphRepo::is_ancestor(conn, observed_commit_id, &local_commit_id)?
                {
                    false
                } else {
                    (acknowledged_at, observed_commit_id)
                        > (local_at.as_str(), local_commit_id.as_str())
                };
                let selected_commit_id = if use_incoming {
                    observed_commit_id.to_string()
                } else {
                    local_commit_id
                };
                let selected_at = std::cmp::max(local_at.as_str(), acknowledged_at).to_string();
                (selected_commit_id, selected_at)
            }
        };

        conn.inner().execute(
            "INSERT INTO tombstone_acknowledgements
                (tombstone_id, device_id, observed_commit_id, acknowledged_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(tombstone_id, device_id) DO UPDATE SET
                observed_commit_id = excluded.observed_commit_id,
                acknowledged_at = excluded.acknowledged_at",
            params![tombstone_id, device_id, selected_commit_id, selected_at],
        )?;
        Ok(())
    }

    pub(crate) fn validate_causal_proof(
        conn: &VaultConnection,
        tombstone_id: &str,
        observed_commit_id: &str,
    ) -> StorageResult<()> {
        let delete_commit_id = Self::delete_commit_id(conn, tombstone_id)?;
        Self::validate_incoming_proof(
            conn,
            tombstone_id,
            delete_commit_id.as_deref(),
            observed_commit_id,
        )
    }

    fn delete_commit_id(
        conn: &VaultConnection,
        tombstone_id: &str,
    ) -> StorageResult<Option<String>> {
        conn.inner()
            .query_row(
                "SELECT delete_commit_id FROM tombstones WHERE tombstone_id = ?1",
                params![tombstone_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("tombstone {tombstone_id}")))
    }

    fn validate_incoming_proof(
        conn: &VaultConnection,
        tombstone_id: &str,
        delete_commit_id: Option<&str>,
        observed_commit_id: &str,
    ) -> StorageResult<()> {
        if !CommitGraphRepo::commit_exists(conn, observed_commit_id)? {
            return Err(StorageError::ConstraintViolation(format!(
                "tombstone acknowledgement {tombstone_id} references unavailable commit {observed_commit_id}"
            )));
        }
        if let Some(delete_commit_id) = delete_commit_id {
            if !CommitGraphRepo::commit_exists(conn, delete_commit_id)? {
                return Err(StorageError::ConstraintViolation(format!(
                    "tombstone {tombstone_id} references unavailable delete commit {delete_commit_id}"
                )));
            }
            if !CommitGraphRepo::is_ancestor(conn, delete_commit_id, observed_commit_id)? {
                return Err(StorageError::Validation(format!(
                    "tombstone acknowledgement {tombstone_id} observed commit {observed_commit_id} does not causally contain delete commit {delete_commit_id}"
                )));
            }
        }
        Ok(())
    }

    fn proof_is_causally_valid(
        conn: &VaultConnection,
        delete_commit_id: Option<&str>,
        observed_commit_id: &str,
    ) -> StorageResult<bool> {
        if !CommitGraphRepo::commit_exists(conn, observed_commit_id)? {
            return Ok(false);
        }
        match delete_commit_id {
            Some(delete_commit_id) => {
                if !CommitGraphRepo::commit_exists(conn, delete_commit_id)? {
                    return Err(StorageError::ConstraintViolation(format!(
                        "tombstone references unavailable delete commit {delete_commit_id}"
                    )));
                }
                CommitGraphRepo::is_ancestor(conn, delete_commit_id, observed_commit_id)
            }
            None => Ok(true),
        }
    }
}
