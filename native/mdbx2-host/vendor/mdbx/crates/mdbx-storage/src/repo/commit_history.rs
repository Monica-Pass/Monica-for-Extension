use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::commit_integrity::{compute_commit_integrity_tag, CommitIntegrityInput};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::{CommitChange, CommitContext};

const MAX_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitHistoryItem {
    pub commit_id: String,
    pub device_id: String,
    pub local_seq: u64,
    pub commit_kind: String,
    pub change_scope: String,
    pub created_at: String,
    pub operation_id: Option<String>,
    pub operation_kind: Option<String>,
    pub branch_id: Option<String>,
    pub branch_name: Option<String>,
    pub message: Option<String>,
    pub changes: Vec<CommitChange>,
    pub parent_ids: Vec<String>,
    pub legacy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitHistoryPage {
    pub items: Vec<CommitHistoryItem>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct HistoryCursor {
    created_at: String,
    commit_id: String,
}

pub struct CommitHistoryRepo;

impl CommitHistoryRepo {
    pub fn list(
        conn: &VaultConnection,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<CommitHistoryPage> {
        if page_size == 0 || page_size > MAX_PAGE_SIZE {
            return Err(StorageError::Validation(format!(
                "history page size must be between 1 and {MAX_PAGE_SIZE}"
            )));
        }
        let cursor = cursor.map(parse_cursor).transpose()?;
        let mut stmt = conn.inner().prepare(
            "SELECT c.commit_id, c.device_id, c.local_seq, c.commit_kind,
                    c.change_scope, c.changed_object_ids_ct, c.vector_clock,
                    c.message_ct, c.created_at, c.integrity_tag,
                    o.operation_id, o.operation_kind, o.branch_id, o.branch_name,
                    o.change_summary_ct, o.request_hash, o.integrity_tag
             FROM commits c
             LEFT JOIN commit_operations o ON o.commit_id = c.commit_id
             WHERE (?1 IS NULL OR c.created_at < ?1
                    OR (c.created_at = ?1 AND c.commit_id < ?2))
             ORDER BY c.created_at DESC, c.commit_id DESC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                cursor.as_ref().map(|c| c.created_at.as_str()),
                cursor.as_ref().map(|c| c.commit_id.as_str()),
                (page_size + 1) as i64,
            ],
            |row| {
                Ok(RawHistoryRow {
                    commit_id: row.get(0)?,
                    device_id: row.get(1)?,
                    local_seq: row.get::<_, i64>(2)? as u64,
                    commit_kind: row.get(3)?,
                    change_scope: row.get(4)?,
                    changed_object_ids_ct: row.get(5)?,
                    vector_clock: row.get(6)?,
                    message_ct: row.get(7)?,
                    created_at: row.get(8)?,
                    integrity_tag: row.get(9)?,
                    operation_id: row.get(10)?,
                    operation_kind: row.get(11)?,
                    branch_id: row.get(12)?,
                    branch_name: row.get(13)?,
                    change_summary_ct: row.get(14)?,
                    request_hash: row.get(15)?,
                    operation_integrity_tag: row.get(16)?,
                })
            },
        )?;
        let mut raw_rows = Vec::new();
        for row in rows.take(page_size + 1) {
            raw_rows.push(row?);
        }
        let has_next = raw_rows.len() > page_size;
        if has_next {
            raw_rows.pop();
        }
        let next_cursor = if has_next {
            raw_rows.last().map(encode_raw_cursor)
        } else {
            None
        };
        let items = raw_rows
            .into_iter()
            .map(|row| Self::decode(conn, row))
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(CommitHistoryPage { items, next_cursor })
    }

    pub fn get(
        conn: &VaultConnection,
        commit_id: &str,
    ) -> StorageResult<Option<CommitHistoryItem>> {
        let row = conn
            .inner()
            .query_row(
                "SELECT c.commit_id, c.device_id, c.local_seq, c.commit_kind,
                        c.change_scope, c.changed_object_ids_ct, c.vector_clock,
                        c.message_ct, c.created_at, c.integrity_tag,
                        o.operation_id, o.operation_kind, o.branch_id, o.branch_name,
                        o.change_summary_ct, o.request_hash, o.integrity_tag
                 FROM commits c
                 LEFT JOIN commit_operations o ON o.commit_id = c.commit_id
                 WHERE c.commit_id = ?1",
                rusqlite::params![commit_id],
                |row| {
                    Ok(RawHistoryRow {
                        commit_id: row.get(0)?,
                        device_id: row.get(1)?,
                        local_seq: row.get::<_, i64>(2)? as u64,
                        commit_kind: row.get(3)?,
                        change_scope: row.get(4)?,
                        changed_object_ids_ct: row.get(5)?,
                        vector_clock: row.get(6)?,
                        message_ct: row.get(7)?,
                        created_at: row.get(8)?,
                        integrity_tag: row.get(9)?,
                        operation_id: row.get(10)?,
                        operation_kind: row.get(11)?,
                        branch_id: row.get(12)?,
                        branch_name: row.get(13)?,
                        change_summary_ct: row.get(14)?,
                        request_hash: row.get(15)?,
                        operation_integrity_tag: row.get(16)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)?;
        row.map(|row| Self::decode(conn, row)).transpose()
    }

    fn decode(conn: &VaultConnection, row: RawHistoryRow) -> StorageResult<CommitHistoryItem> {
        let parent_ids = parent_ids(conn, &row.commit_id)?;
        let mut expected = compute_commit_integrity_tag(
            conn.keyring(),
            &CommitIntegrityInput {
                commit_id: &row.commit_id,
                device_id: &row.device_id,
                local_seq: row.local_seq,
                commit_kind: &row.commit_kind,
                change_scope: &row.change_scope,
                changed_object_ids_ct: &row.changed_object_ids_ct,
                vector_clock: &row.vector_clock,
                message_ct: row.message_ct.as_deref(),
                created_at: &row.created_at,
                parents: &parent_ids,
            },
        )?;
        if expected != row.integrity_tag
            && conn.keyring().is_some()
            && serde_json::from_slice::<serde_json::Value>(&row.changed_object_ids_ct).is_ok()
        {
            expected = compute_commit_integrity_tag(
                None,
                &CommitIntegrityInput {
                    commit_id: &row.commit_id,
                    device_id: &row.device_id,
                    local_seq: row.local_seq,
                    commit_kind: &row.commit_kind,
                    change_scope: &row.change_scope,
                    changed_object_ids_ct: &row.changed_object_ids_ct,
                    vector_clock: &row.vector_clock,
                    message_ct: row.message_ct.as_deref(),
                    created_at: &row.created_at,
                    parents: &parent_ids,
                },
            )?;
        }
        if expected != row.integrity_tag {
            return Err(StorageError::Validation(format!(
                "commit {} integrity mismatch",
                row.commit_id
            )));
        }

        let (changes, legacy) = if let Some(summary) = row.change_summary_ct.as_deref() {
            let metadata = mdbx_sync::CommitOperationMetadata {
                operation_id: row.operation_id.clone().ok_or_else(|| {
                    StorageError::Validation("operation summary has no operation ID".to_string())
                })?,
                operation_kind: row.operation_kind.clone().ok_or_else(|| {
                    StorageError::Validation("operation summary has no operation kind".to_string())
                })?,
                branch_id: row.branch_id.clone(),
                branch_name: row.branch_name.clone().ok_or_else(|| {
                    StorageError::Validation("operation summary has no branch".to_string())
                })?,
                change_summary_ct: summary.to_vec(),
                request_hash: row.request_hash.clone().ok_or_else(|| {
                    StorageError::Validation("operation summary has no request hash".to_string())
                })?,
                integrity_tag: row.operation_integrity_tag.clone().ok_or_else(|| {
                    StorageError::Validation("operation summary has no integrity tag".to_string())
                })?,
            };
            let commit = mdbx_core::model::Commit {
                commit_id: row.commit_id.clone(),
                device_id: row.device_id.clone(),
                local_seq: row.local_seq,
                commit_kind: parse_commit_kind(&row.commit_kind)?,
                change_scope: parse_change_scope(&row.change_scope)?,
                changed_object_ids_ct: row.changed_object_ids_ct.clone(),
                vector_clock: row.vector_clock.clone(),
                message_ct: row.message_ct.clone(),
                created_at: row.created_at.clone(),
                integrity_tag: row.integrity_tag.clone(),
            };
            CommitContext::verify_operation_integrity(conn, &commit, &metadata)?;
            let plaintext =
                decrypt_compatible_history(conn, &row.commit_id, "change-summary", summary)?;
            let changes = serde_json::from_slice(&plaintext).map_err(|error| {
                StorageError::Validation(format!("invalid change summary: {error}"))
            })?;
            (changes, false)
        } else {
            let plaintext = decrypt_compatible_history(
                conn,
                &row.commit_id,
                "changed-object-ids",
                &row.changed_object_ids_ct,
            )?;
            let ids: Vec<String> = serde_json::from_slice(&plaintext).map_err(|error| {
                StorageError::Validation(format!("invalid legacy changed object IDs: {error}"))
            })?;
            (
                ids.into_iter()
                    .map(|object_id| CommitChange {
                        object_type: row.change_scope.clone(),
                        object_id,
                        action: "change".to_string(),
                        fields: Vec::new(),
                    })
                    .collect(),
                true,
            )
        };
        let message = row
            .message_ct
            .as_deref()
            .map(|message| decrypt_compatible_history(conn, &row.commit_id, "message", message))
            .transpose()?
            .map(|message| {
                String::from_utf8(message).map_err(|error| {
                    StorageError::Validation(format!("invalid commit message: {error}"))
                })
            })
            .transpose()?;
        Ok(CommitHistoryItem {
            commit_id: row.commit_id,
            device_id: row.device_id,
            local_seq: row.local_seq,
            commit_kind: row.commit_kind,
            change_scope: row.change_scope,
            created_at: row.created_at,
            operation_id: row.operation_id,
            operation_kind: row.operation_kind,
            branch_id: row.branch_id,
            branch_name: row.branch_name,
            message,
            changes,
            parent_ids,
            legacy,
        })
    }
}

#[derive(Debug)]
struct RawHistoryRow {
    commit_id: String,
    device_id: String,
    local_seq: u64,
    commit_kind: String,
    change_scope: String,
    changed_object_ids_ct: Vec<u8>,
    vector_clock: String,
    message_ct: Option<Vec<u8>>,
    created_at: String,
    integrity_tag: Vec<u8>,
    operation_id: Option<String>,
    operation_kind: Option<String>,
    branch_id: Option<String>,
    branch_name: Option<String>,
    change_summary_ct: Option<Vec<u8>>,
    request_hash: Option<Vec<u8>>,
    operation_integrity_tag: Option<Vec<u8>>,
}

fn parent_ids(conn: &VaultConnection, commit_id: &str) -> StorageResult<Vec<String>> {
    let mut stmt = conn.inner().prepare(
        "SELECT parent_commit_id FROM commit_parents
         WHERE commit_id = ?1 ORDER BY parent_commit_id",
    )?;
    let rows = stmt.query_map(rusqlite::params![commit_id], |row| row.get(0))?;
    rows.map(|row| row.map_err(StorageError::Database))
        .collect()
}

fn encode_raw_cursor(row: &RawHistoryRow) -> String {
    serde_json::to_string(&HistoryCursor {
        created_at: row.created_at.clone(),
        commit_id: row.commit_id.clone(),
    })
    .expect("history cursor serialization cannot fail")
}

fn decrypt_compatible_history(
    conn: &VaultConnection,
    commit_id: &str,
    field: &str,
    ciphertext: &[u8],
) -> StorageResult<Vec<u8>> {
    match CommitContext::decrypt_history(conn, commit_id, field, ciphertext) {
        Ok(plaintext) => Ok(plaintext),
        Err(_error)
            if conn.keyring().is_some()
                && ((field == "message" && std::str::from_utf8(ciphertext).is_ok())
                    || (field != "message"
                        && serde_json::from_slice::<serde_json::Value>(ciphertext).is_ok())) =>
        {
            Ok(ciphertext.to_vec())
        }
        Err(error) => Err(error),
    }
}

fn parse_cursor(value: &str) -> StorageResult<HistoryCursor> {
    serde_json::from_str(value)
        .map_err(|error| StorageError::Validation(format!("invalid history cursor: {error}")))
}

fn parse_commit_kind(value: &str) -> StorageResult<mdbx_core::model::CommitKind> {
    value.parse().map_err(StorageError::Validation)
}

fn parse_change_scope(value: &str) -> StorageResult<mdbx_core::model::ChangeScope> {
    value.parse().map_err(StorageError::Validation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ProjectRepo};
    use uuid::Uuid;

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        (conn, CommitContext::new("history-device".to_string()))
    }

    #[test]
    fn paginated_history_includes_operation_and_legacy_commit() {
        let (conn, ctx) = setup();
        let operation = crate::repo::CommitOperation::new(
            "history-operation",
            "edit",
            "main",
            "change",
            "project",
            vec![CommitChange {
                object_type: "project".to_string(),
                object_id: Uuid::new_v4().to_string(),
                action: "change".to_string(),
                fields: Vec::new(),
            }],
        )
        .with_intent_hash(vec![7; 32]);
        let project = ctx
            .run_operation(&conn, operation, |scoped| {
                ProjectRepo::create_with_id(
                    &conn,
                    scoped,
                    &Uuid::new_v4().to_string(),
                    "History",
                    None,
                    None,
                )
            })
            .unwrap();
        let _ = project;
        let first = CommitHistoryRepo::list(&conn, 1, None).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(
            first.items[0].operation_id.as_deref(),
            Some("history-operation")
        );
        let second = CommitHistoryRepo::list(&conn, 1, first.next_cursor.as_deref()).unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(second.items[0].legacy);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn history_verifies_and_preserves_extended_commit_kinds() {
        let (conn, ctx) = setup();

        for kind in ["move", "copy", "restore", "multi"] {
            let operation = crate::repo::CommitOperation::new(
                format!("history-{kind}-operation"),
                "history-kind-test",
                "main",
                kind,
                "project",
                Vec::new(),
            );
            let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
            let history = CommitHistoryRepo::get(&conn, &commit_id).unwrap().unwrap();

            assert_eq!(history.commit_kind, kind);
            assert_eq!(
                history.operation_id.as_deref(),
                Some(operation.operation_id.as_str())
            );
        }

        assert!(parse_commit_kind("future-kind").is_err());
    }

    #[test]
    fn history_verifies_and_preserves_snapshot_and_branch_scopes() {
        let (conn, ctx) = setup();

        for scope in ["snapshot", "branch"] {
            let operation = crate::repo::CommitOperation::new(
                format!("history-{scope}-scope-operation"),
                "history-scope-test",
                "main",
                "change",
                scope,
                Vec::new(),
            );
            let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
            let history = CommitHistoryRepo::get(&conn, &commit_id).unwrap().unwrap();

            assert_eq!(history.change_scope, scope);
        }

        assert!(parse_change_scope("future-scope").is_err());
    }

    #[test]
    fn tampered_operation_summary_is_rejected() {
        let (conn, ctx) = setup();
        let operation = crate::repo::CommitOperation::new(
            "history-tamper-operation",
            "edit",
            "main",
            "change",
            "project",
            vec![],
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations SET change_summary_ct = X'00' WHERE commit_id = ?1",
                rusqlite::params![commit_id],
            )
            .unwrap();
        assert!(CommitHistoryRepo::get(&conn, &commit_id).is_err());
    }

    #[test]
    fn tampered_operation_branch_id_is_rejected() {
        let (conn, ctx) = setup();
        let operation = crate::repo::CommitOperation::new(
            "history-branch-tamper",
            "edit",
            "main",
            "change",
            "project",
            vec![],
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations SET branch_id = 'tampered-branch-id'
                 WHERE commit_id = ?1",
                rusqlite::params![commit_id],
            )
            .unwrap();

        let error = CommitHistoryRepo::get(&conn, &commit_id).unwrap_err();

        assert!(error.to_string().contains("integrity mismatch"));
    }
}
