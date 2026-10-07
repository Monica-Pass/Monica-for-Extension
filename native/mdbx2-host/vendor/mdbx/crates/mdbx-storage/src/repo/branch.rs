use rusqlite::{params, OptionalExtension};

use mdbx_core::model::commit::Branch;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

/// Read-only branch identity access. Branch mutation remains internal to
/// commit and synchronization transactions.
pub struct BranchRepo;

impl BranchRepo {
    pub fn get_by_id(conn: &VaultConnection, branch_id: &str) -> StorageResult<Option<Branch>> {
        conn.inner()
            .query_row(
                "SELECT branch_id, branch_name, head_commit_id, created_at, updated_at
                 FROM branches WHERE branch_id = ?1",
                params![branch_id],
                branch_from_row,
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub fn require_by_id(conn: &VaultConnection, branch_id: &str) -> StorageResult<Branch> {
        Self::get_by_id(conn, branch_id)?
            .ok_or_else(|| StorageError::NotFound(format!("branch ID {branch_id}")))
    }

    pub fn resolve_unique_name(conn: &VaultConnection, branch_name: &str) -> StorageResult<Branch> {
        let mut stmt = conn.inner().prepare(
            "SELECT branch_id, branch_name, head_commit_id, created_at, updated_at
             FROM branches WHERE branch_name = ?1 ORDER BY branch_id LIMIT 2",
        )?;
        let rows = stmt.query_map(params![branch_name], branch_from_row)?;
        let branches = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        match branches.as_slice() {
            [] => Err(StorageError::NotFound(format!("branch name {branch_name}"))),
            [branch] => Ok(branch.clone()),
            _ => Err(StorageError::ConstraintViolation(format!(
                "branch name {branch_name} is ambiguous; use branch_id"
            ))),
        }
    }

    pub fn list(conn: &VaultConnection) -> StorageResult<Vec<Branch>> {
        let mut stmt = conn.inner().prepare(
            "SELECT branch_id, branch_name, head_commit_id, created_at, updated_at
             FROM branches ORDER BY branch_name, branch_id",
        )?;
        let rows = stmt.query_map([], branch_from_row)?;
        rows.map(|row| row.map_err(StorageError::Database))
            .collect()
    }
}

fn branch_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Branch> {
    Ok(Branch {
        branch_id: row.get(0)?,
        branch_name: row.get(1)?,
        head_commit_id: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};

    #[test]
    fn list_returns_stable_branch_identity() {
        let conn = VaultConnection::open_in_memory().unwrap();
        let initialized = initialize_vault(&conn, &VaultInitParams::default()).unwrap();

        let branches = BranchRepo::list(&conn).unwrap();

        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].branch_id, initialized.branch_id);
        assert_eq!(branches[0].branch_name, "main");
    }
}
