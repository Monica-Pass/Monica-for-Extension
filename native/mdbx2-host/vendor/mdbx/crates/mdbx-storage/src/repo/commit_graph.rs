use std::collections::HashSet;

use rusqlite::params;

use crate::connection::VaultConnection;
use crate::error::StorageResult;

/// Read-only commit DAG queries shared by synchronization, cleanup, and health.
pub(crate) struct CommitGraphRepo;

impl CommitGraphRepo {
    pub(crate) fn commit_exists(conn: &VaultConnection, commit_id: &str) -> StorageResult<bool> {
        let count: i64 = conn.inner().query_row(
            "SELECT COUNT(*) FROM commits WHERE commit_id = ?1",
            params![commit_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub(crate) fn parent_ids(
        conn: &VaultConnection,
        commit_id: &str,
    ) -> StorageResult<Vec<String>> {
        let mut stmt = conn.inner().prepare(
            "SELECT parent_commit_id FROM commit_parents
             WHERE commit_id = ?1
             ORDER BY parent_commit_id",
        )?;
        let rows = stmt.query_map(params![commit_id], |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub(crate) fn is_ancestor(
        conn: &VaultConnection,
        ancestor: &str,
        descendant: &str,
    ) -> StorageResult<bool> {
        if ancestor == descendant {
            return Ok(true);
        }
        let mut stack = vec![descendant.to_string()];
        let mut seen = HashSet::new();
        while let Some(commit_id) = stack.pop() {
            if !seen.insert(commit_id.clone()) {
                continue;
            }
            for parent in Self::parent_ids(conn, &commit_id)? {
                if parent == ancestor {
                    return Ok(true);
                }
                stack.push(parent);
            }
        }
        Ok(false)
    }

    pub(crate) fn nearest_known_common_parent(
        conn: &VaultConnection,
        left: &str,
        right: &str,
    ) -> StorageResult<Option<String>> {
        let left_ancestors = Self::ancestor_set(conn, left)?;
        let mut stack = vec![right.to_string()];
        let mut seen = HashSet::new();
        while let Some(commit_id) = stack.pop() {
            if !seen.insert(commit_id.clone()) {
                continue;
            }
            if left_ancestors.contains(&commit_id) {
                return Ok(Some(commit_id));
            }
            stack.extend(Self::parent_ids(conn, &commit_id)?);
        }
        Ok(None)
    }

    fn ancestor_set(conn: &VaultConnection, head: &str) -> StorageResult<HashSet<String>> {
        let mut result = HashSet::new();
        let mut stack = vec![head.to_string()];
        while let Some(commit_id) = stack.pop() {
            if !result.insert(commit_id.clone()) {
                continue;
            }
            stack.extend(Self::parent_ids(conn, &commit_id)?);
        }
        Ok(result)
    }
}
