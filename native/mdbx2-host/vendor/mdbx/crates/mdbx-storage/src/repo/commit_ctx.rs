use std::cell::RefCell;
use std::collections::{BTreeMap, HashSet};

use rusqlite::params;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use mdbx_core::model::{ChangeScope, Commit, CommitKind};

use crate::commit_integrity::{compute_commit_integrity_tag, CommitIntegrityInput};
use crate::connection::VaultConnection;
use crate::crypto_layer::FieldKeyPurpose;
use crate::error::{StorageError, StorageResult};
use crate::repo::branch::BranchRepo;
use crate::repo::TombstoneAcknowledgementRepo;

const OPERATION_REQUEST_IDENTITY_V1_PREFIX: &[u8] = b"MDBXORI1";
const LEGACY_OPERATION_REQUEST_HASH_BYTES: usize = 32;

/// 一个用户级变更中的对象摘要。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct CommitChange {
    pub object_type: String,
    pub object_id: String,
    pub action: String,
    #[serde(default)]
    pub fields: Vec<String>,
}

/// MDBX2 的 operation-level commit 请求。
///
/// `operation_id` 由客户端在用户动作开始时生成，并在重试时复用。
/// `create_commit` 仍然提供 MDBX1 兼容入口，它会构造一个兼容 operation。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct CommitOperation {
    pub operation_id: String,
    pub operation_kind: String,
    pub branch_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    pub commit_kind: String,
    pub change_scope: String,
    pub changed_objects: Vec<CommitChange>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub parents: Vec<String>,
    #[serde(default)]
    pub intent_hash: Option<Vec<u8>>,
}

impl CommitOperation {
    pub fn new(
        operation_id: impl Into<String>,
        operation_kind: impl Into<String>,
        branch_name: impl Into<String>,
        commit_kind: impl Into<String>,
        change_scope: impl Into<String>,
        changed_objects: Vec<CommitChange>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            operation_kind: operation_kind.into(),
            branch_name: branch_name.into(),
            branch_id: None,
            commit_kind: commit_kind.into(),
            change_scope: change_scope.into(),
            changed_objects,
            message: None,
            parents: Vec::new(),
            intent_hash: None,
        }
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn with_parents(mut self, parents: Vec<String>) -> Self {
        self.parents = parents;
        self
    }

    pub fn with_intent_hash(mut self, intent_hash: Vec<u8>) -> Self {
        self.intent_hash = Some(intent_hash);
        self
    }

    pub fn with_branch_id(mut self, branch_id: impl Into<String>) -> Self {
        self.branch_id = Some(branch_id.into());
        self
    }
}

/// 一个用户操作的执行结果。重试已完成的 operation 时不会再次运行写入闭包。
#[derive(Debug, PartialEq, Eq)]
pub enum OperationExecution<T> {
    Applied { value: T, commit_id: String },
    AlreadyCommitted { commit_id: String },
}

struct ActiveOperation {
    operation: CommitOperation,
    request_identity: Vec<u8>,
    commit_id: Option<String>,
}

/// 执行 mutation 所需的上下文：设备身份 + commit 生成。
pub struct CommitContext {
    pub device_id: String,
    active_operation: RefCell<Option<ActiveOperation>>,
}

impl CommitContext {
    pub fn new(device_id: String) -> Self {
        Self {
            device_id,
            active_operation: RefCell::new(None),
        }
    }

    /// 将多个 repo mutation 作为一个用户级操作执行。
    ///
    /// 闭包中的旧 repo API 会共享同一个事务和 commit ID。闭包返回错误时，
    /// 所有对象、历史和 head 更新一起回滚；已完成 operation 的重试不会再次执行闭包。
    pub fn run_operation<T>(
        &self,
        conn: &VaultConnection,
        operation: CommitOperation,
        action: impl FnOnce(&CommitContext) -> StorageResult<T>,
    ) -> StorageResult<OperationExecution<T>> {
        Self::validate_operation(&operation)?;
        if !conn.inner().is_autocommit() {
            return Err(StorageError::ConstraintViolation(
                "run_operation requires an autocommit connection".to_string(),
            ));
        }

        conn.inner().execute_batch("BEGIN IMMEDIATE TRANSACTION;")?;
        let result = self.run_operation_in_transaction(conn, operation, action);
        match result {
            Ok(OperationExecution::AlreadyCommitted { commit_id }) => {
                conn.inner().execute_batch("ROLLBACK;")?;
                Ok(OperationExecution::AlreadyCommitted { commit_id })
            }
            Ok(OperationExecution::Applied { value, commit_id }) => {
                if let Err(error) = crate::sync_delta::materialize_pending_sync_delta(
                    conn,
                    crate::sync_delta::SyncDeltaLimits::default(),
                ) {
                    let _ = conn.inner().execute_batch("ROLLBACK;");
                    return Err(error);
                }
                if let Err(error) = conn.inner().execute_batch("COMMIT;") {
                    let _ = conn.inner().execute_batch("ROLLBACK;");
                    return Err(StorageError::Database(error));
                }
                Ok(OperationExecution::Applied { value, commit_id })
            }
            Err(error) => {
                let _ = conn.inner().execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    /// Execute an operation inside a transaction owned by another Module.
    ///
    /// The caller retains commit, audit, and rollback ownership. This Seam lets
    /// Tiga authorization and one operation commit share one outer transaction.
    pub(crate) fn run_operation_in_transaction<T>(
        &self,
        conn: &VaultConnection,
        operation: CommitOperation,
        action: impl FnOnce(&CommitContext) -> StorageResult<T>,
    ) -> StorageResult<OperationExecution<T>> {
        Self::validate_operation(&operation)?;
        if conn.inner().is_autocommit() {
            return Err(StorageError::ConstraintViolation(
                "run_operation_in_transaction requires an active transaction".to_string(),
            ));
        }

        let existing = conn
            .inner()
            .query_row(
                "SELECT o.commit_id, o.operation_kind, o.branch_id, o.branch_name,
                        c.commit_kind, c.change_scope, o.change_summary_ct,
                        o.request_hash, c.created_at, o.integrity_tag
                 FROM commit_operations o
                 JOIN commits c ON c.commit_id = o.commit_id
                 WHERE o.operation_id = ?1",
                params![operation.operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                        row.get::<_, Vec<u8>>(7)?,
                        row.get::<_, String>(8)?,
                        row.get::<_, Vec<u8>>(9)?,
                    ))
                },
            )
            .optional()?;
        if let Some((
            commit_id,
            operation_kind,
            branch_id,
            branch_name,
            commit_kind,
            change_scope,
            change_summary_ct,
            request_hash,
            created_at,
            operation_integrity_tag,
        )) = existing
        {
            Self::verify_operation_integrity_values(
                conn,
                &operation.operation_id,
                &commit_id,
                &operation_kind,
                branch_id.as_deref(),
                &branch_name,
                &change_summary_ct,
                &request_hash,
                &created_at,
                &operation_integrity_tag,
            )?;
            let compatible_scope =
                change_scope == operation.change_scope || change_scope == "multi";
            let compatible_branch = Self::branch_request_matches_existing(
                &operation,
                branch_id.as_deref(),
                &branch_name,
            );
            let request_digest = Self::operation_request_hash_for_existing(
                &operation,
                branch_id.as_deref(),
                &branch_name,
            )?;
            let compatible_intent = Self::stored_request_identity_matches(
                &request_hash,
                &request_digest,
                operation.intent_hash.is_some(),
            )?;
            if operation_kind != operation.operation_kind
                || !compatible_branch
                || commit_kind != operation.commit_kind
                || !compatible_scope
                || !compatible_intent
            {
                return Err(StorageError::Validation(format!(
                    "operation {} was reused for a different operation",
                    operation.operation_id
                )));
            }
            return Ok(OperationExecution::AlreadyCommitted { commit_id });
        }

        let operation = Self::resolve_new_operation_branch(conn, operation)?;
        let request_identity = Self::operation_request_identity(&operation)?;

        let scoped = CommitContext {
            device_id: self.device_id.clone(),
            active_operation: RefCell::new(Some(ActiveOperation {
                operation,
                request_identity,
                commit_id: None,
            })),
        };
        let value = action(&scoped)?;
        let commit_id = scoped
            .active_operation
            .borrow()
            .as_ref()
            .and_then(|active| active.commit_id.clone())
            .ok_or_else(|| StorageError::Validation("operation produced no commit".to_string()))?;
        Ok(OperationExecution::Applied { value, commit_id })
    }

    /// 在当前 SQLite 写事务中原子分配设备序列号。
    fn next_local_seq(&self, conn: &VaultConnection) -> StorageResult<u64> {
        conn.inner()
            .query_row(
                "INSERT INTO commit_device_sequences (device_id, last_local_seq)
                 VALUES (?1, COALESCE((SELECT MAX(local_seq) + 1 FROM commits WHERE device_id = ?1), 1))
                 ON CONFLICT(device_id) DO UPDATE SET last_local_seq = MAX(
                     last_local_seq + 1,
                     COALESCE((SELECT MAX(local_seq) + 1 FROM commits WHERE device_id = ?1), 1)
                 )
                 RETURNING last_local_seq",
                params![self.device_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .map_err(StorageError::Database)
    }

    fn current_head(
        &self,
        conn: &VaultConnection,
        table: &str,
        id_column: &str,
        object_id: &str,
    ) -> StorageResult<Option<String>> {
        let sql = format!(
            "SELECT head_commit_id FROM {} WHERE {} = ?1",
            table, id_column
        );
        conn.inner()
            .query_row(&sql, params![object_id], |row| row.get(0))
            .optional()
            .map_err(StorageError::Database)
            .map(|r| r.flatten())
    }

    fn current_branch_head(conn: &VaultConnection, branch_id: &str) -> StorageResult<String> {
        Ok(BranchRepo::require_by_id(conn, branch_id)?.head_commit_id)
    }

    /// 创建一个 operation-level commit，并在重试时按 operation_id 幂等返回。
    pub fn create_operation_commit(
        &self,
        conn: &VaultConnection,
        operation: &CommitOperation,
    ) -> StorageResult<String> {
        Self::validate_operation(operation)?;
        conn.with_immediate_transaction(|| self.create_operation_commit_inner(conn, operation))
    }

    fn create_operation_commit_inner(
        &self,
        conn: &VaultConnection,
        operation: &CommitOperation,
    ) -> StorageResult<String> {
        Self::validate_operation(operation)?;

        if let Some((
            commit_id,
            operation_kind,
            branch_id,
            branch_name,
            change_summary_ct,
            stored_hash,
            created_at,
            operation_integrity_tag,
        )) = conn
            .inner()
            .query_row(
                "SELECT commit_id, operation_kind, branch_id, branch_name,
                        change_summary_ct, request_hash, created_at, integrity_tag
                 FROM commit_operations WHERE operation_id = ?1",
                params![operation.operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Vec<u8>>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(StorageError::Database)?
        {
            Self::verify_operation_integrity_values(
                conn,
                &operation.operation_id,
                &commit_id,
                &operation_kind,
                branch_id.as_deref(),
                &branch_name,
                &change_summary_ct,
                &stored_hash,
                &created_at,
                &operation_integrity_tag,
            )?;
            let request_digest = Self::operation_request_hash_for_existing(
                operation,
                branch_id.as_deref(),
                &branch_name,
            )?;
            if !Self::branch_request_matches_existing(operation, branch_id.as_deref(), &branch_name)
                || !Self::stored_request_identity_matches(&stored_hash, &request_digest, true)?
            {
                return Err(StorageError::Validation(format!(
                    "operation {} was reused with different content",
                    operation.operation_id
                )));
            }
            return Ok(commit_id);
        }

        let operation = Self::resolve_new_operation_branch(conn, operation.clone())?;
        let request_hash = Self::operation_request_identity(&operation)?;
        self.insert_operation_commit_inner(conn, &operation, &request_hash)
    }

    fn insert_operation_commit_inner(
        &self,
        conn: &VaultConnection,
        operation: &CommitOperation,
        request_hash: &[u8],
    ) -> StorageResult<String> {
        let branch_id = operation.branch_id.as_deref().ok_or_else(|| {
            StorageError::Validation("resolved operation has no branch ID".to_string())
        })?;

        let now = chrono::Utc::now().to_rfc3339();
        let local_seq = self.next_local_seq(conn)?;
        let commit_id = Uuid::new_v4().to_string();
        let resolved_parents = if operation.parents.is_empty() {
            vec![Self::current_branch_head(conn, branch_id)?]
        } else {
            operation.parents.clone()
        };
        Self::validate_parents(conn, &resolved_parents)?;

        let vector_clock =
            Self::merge_vector_clocks(conn, &resolved_parents, &self.device_id, local_seq)?;
        let changed_ids = operation
            .changed_objects
            .iter()
            .map(|change| change.object_id.clone())
            .collect::<Vec<_>>();
        let changed_json = serde_json::to_vec(&deduplicate(changed_ids))
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        let changed_object_ids_ct =
            Self::encrypt_history(conn, &commit_id, "changed-object-ids", &changed_json)?;
        let summary_json = serde_json::to_vec(&operation.changed_objects)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        let change_summary_ct =
            Self::encrypt_history(conn, &commit_id, "change-summary", &summary_json)?;
        let message_ct = operation
            .message
            .as_deref()
            .map(|message| Self::encrypt_history(conn, &commit_id, "message", message.as_bytes()))
            .transpose()?;
        let integrity_tag = compute_commit_integrity_tag(
            conn.keyring(),
            &CommitIntegrityInput {
                commit_id: &commit_id,
                device_id: &self.device_id,
                local_seq,
                commit_kind: &operation.commit_kind,
                change_scope: &operation.change_scope,
                changed_object_ids_ct: &changed_object_ids_ct,
                vector_clock: &vector_clock,
                message_ct: message_ct.as_deref(),
                created_at: &now,
                parents: &resolved_parents,
            },
        )?;
        let operation_integrity = Self::operation_integrity(
            conn,
            operation,
            &commit_id,
            &change_summary_ct,
            request_hash,
            &now,
        )?;

        conn.inner().execute(
            "INSERT INTO commits (commit_id, device_id, local_seq, commit_kind,
             change_scope, changed_object_ids_ct, vector_clock, message_ct,
             created_at, integrity_tag)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                commit_id,
                self.device_id,
                local_seq as i64,
                operation.commit_kind,
                operation.change_scope,
                changed_object_ids_ct,
                vector_clock,
                message_ct,
                now,
                integrity_tag,
            ],
        )?;

        for parent_id in &resolved_parents {
            conn.inner().execute(
                "INSERT INTO commit_parents (commit_id, parent_commit_id) VALUES (?1, ?2)",
                params![commit_id, parent_id],
            )?;
        }

        conn.inner().execute(
            "INSERT INTO commit_operations
             (operation_id, commit_id, operation_kind, branch_id, branch_name,
              change_summary_ct, request_hash, created_at, integrity_tag)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                operation.operation_id,
                commit_id,
                operation.operation_kind,
                branch_id,
                operation.branch_name,
                change_summary_ct,
                request_hash,
                now,
                operation_integrity,
            ],
        )?;

        conn.inner().execute(
            "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at, revoked)
             VALUES (?1, ?2, ?3, 0)
             ON CONFLICT(device_id) DO UPDATE SET
                head_commit_id = excluded.head_commit_id,
                last_seen_at = excluded.last_seen_at",
            params![self.device_id, commit_id, now],
        )?;

        let branch_updated = conn.inner().execute(
            "UPDATE branches SET head_commit_id = ?1, updated_at = ?2 WHERE branch_id = ?3",
            params![commit_id, now, branch_id],
        )?;
        if branch_updated != 1 {
            return Err(StorageError::NotFound(format!(
                "branch ID {branch_id} not found"
            )));
        }

        Ok(commit_id)
    }

    /// 旧调用方的兼容入口：仍生成一条 legacy commit，但同时具备幂等元数据。
    pub fn create_commit(
        &self,
        conn: &VaultConnection,
        commit_kind: &str,
        change_scope: &str,
        changed_object_ids: &[String],
        parents: &[String],
    ) -> StorageResult<String> {
        if self.active_operation.borrow().is_some() {
            return self.create_coalesced_commit(
                conn,
                commit_kind,
                change_scope,
                changed_object_ids,
                parents,
            );
        }
        let changed_objects = changed_object_ids
            .iter()
            .map(|object_id| CommitChange {
                object_type: change_scope.to_string(),
                object_id: object_id.clone(),
                action: "change".to_string(),
                fields: Vec::new(),
            })
            .collect();
        let operation = CommitOperation::new(
            Uuid::new_v4().to_string(),
            format!("legacy-{commit_kind}"),
            "main",
            commit_kind,
            change_scope,
            changed_objects,
        )
        .with_parents(parents.to_vec());
        self.create_operation_commit(conn, &operation)
    }

    fn create_coalesced_commit(
        &self,
        conn: &VaultConnection,
        commit_kind: &str,
        change_scope: &str,
        changed_object_ids: &[String],
        parents: &[String],
    ) -> StorageResult<String> {
        Self::validate_commit_taxonomy(commit_kind, change_scope)?;
        let mut active = self
            .active_operation
            .borrow_mut()
            .take()
            .ok_or_else(|| StorageError::Validation("missing active operation".to_string()))?;
        let result = (|| -> StorageResult<String> {
            if active.operation.commit_kind != commit_kind
                && active.operation.commit_kind != "multi"
            {
                return Err(StorageError::Validation(format!(
                    "operation commit kind {} cannot contain {}",
                    active.operation.commit_kind, commit_kind
                )));
            }
            if active.operation.change_scope != change_scope {
                active.operation.change_scope = "multi".to_string();
            }
            for parent in parents {
                if !active.operation.parents.contains(parent) {
                    active.operation.parents.push(parent.clone());
                }
            }
            for object_id in changed_object_ids {
                merge_change(
                    &mut active.operation.changed_objects,
                    CommitChange {
                        object_type: change_scope.to_string(),
                        object_id: object_id.clone(),
                        action: "change".to_string(),
                        fields: Vec::new(),
                    },
                );
            }

            if let Some(commit_id) = active.commit_id.clone() {
                self.rewrite_active_commit(conn, &mut active)?;
                Ok(commit_id)
            } else {
                let commit_id = self.insert_operation_commit_inner(
                    conn,
                    &active.operation,
                    &active.request_identity,
                )?;
                active.commit_id = Some(commit_id.clone());
                active.operation.parents = self.parents_for_commit(conn, &commit_id)?;
                Ok(commit_id)
            }
        })();
        self.active_operation.replace(Some(active));
        result
    }

    fn parents_for_commit(
        &self,
        conn: &VaultConnection,
        commit_id: &str,
    ) -> StorageResult<Vec<String>> {
        let mut stmt = conn.inner().prepare(
            "SELECT parent_commit_id FROM commit_parents
             WHERE commit_id = ?1 ORDER BY parent_commit_id",
        )?;
        let rows = stmt.query_map(params![commit_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| row.map_err(StorageError::Database))
            .collect()
    }

    fn rewrite_active_commit(
        &self,
        conn: &VaultConnection,
        active: &mut ActiveOperation,
    ) -> StorageResult<()> {
        let commit_id = active.commit_id.as_deref().ok_or_else(|| {
            StorageError::Validation("active operation has no commit".to_string())
        })?;
        let (local_seq, created_at): (i64, String) = conn.inner().query_row(
            "SELECT local_seq, created_at FROM commits WHERE commit_id = ?1",
            params![commit_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut parents = self.parents_for_commit(conn, commit_id)?;
        for parent in &active.operation.parents {
            if parent != commit_id && !parents.contains(parent) {
                parents.push(parent.clone());
            }
        }
        Self::validate_parents(conn, &parents)?;
        active.operation.parents = parents.clone();

        let vector_clock =
            Self::merge_vector_clocks(conn, &parents, &self.device_id, local_seq as u64)?;
        let changed_ids = active
            .operation
            .changed_objects
            .iter()
            .map(|change| change.object_id.clone())
            .collect::<Vec<_>>();
        let changed_json = serde_json::to_vec(&deduplicate(changed_ids))
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        let changed_object_ids_ct =
            Self::encrypt_history(conn, commit_id, "changed-object-ids", &changed_json)?;
        let summary_json = serde_json::to_vec(&active.operation.changed_objects)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        let change_summary_ct =
            Self::encrypt_history(conn, commit_id, "change-summary", &summary_json)?;
        let message_ct = active
            .operation
            .message
            .as_deref()
            .map(|message| Self::encrypt_history(conn, commit_id, "message", message.as_bytes()))
            .transpose()?;
        let request_hash = active.request_identity.clone();
        let integrity_tag = compute_commit_integrity_tag(
            conn.keyring(),
            &CommitIntegrityInput {
                commit_id,
                device_id: &self.device_id,
                local_seq: local_seq as u64,
                commit_kind: &active.operation.commit_kind,
                change_scope: &active.operation.change_scope,
                changed_object_ids_ct: &changed_object_ids_ct,
                vector_clock: &vector_clock,
                message_ct: message_ct.as_deref(),
                created_at: &created_at,
                parents: &parents,
            },
        )?;
        let operation_integrity = Self::operation_integrity(
            conn,
            &active.operation,
            commit_id,
            &change_summary_ct,
            &request_hash,
            &created_at,
        )?;

        conn.inner().execute(
            "UPDATE commits SET commit_kind = ?1, change_scope = ?2,
             changed_object_ids_ct = ?3, vector_clock = ?4, message_ct = ?5,
             integrity_tag = ?6 WHERE commit_id = ?7",
            params![
                active.operation.commit_kind,
                active.operation.change_scope,
                changed_object_ids_ct,
                vector_clock,
                message_ct,
                integrity_tag,
                commit_id,
            ],
        )?;
        for parent in &parents {
            conn.inner().execute(
                "INSERT OR IGNORE INTO commit_parents (commit_id, parent_commit_id)
                 VALUES (?1, ?2)",
                params![commit_id, parent],
            )?;
        }
        conn.inner().execute(
            "UPDATE commit_operations SET operation_kind = ?1, branch_id = ?2,
             branch_name = ?3, change_summary_ct = ?4, request_hash = ?5,
             integrity_tag = ?6 WHERE operation_id = ?7",
            params![
                active.operation.operation_kind,
                active.operation.branch_id,
                active.operation.branch_name,
                change_summary_ct,
                request_hash,
                operation_integrity,
                active.operation.operation_id,
            ],
        )?;
        Ok(())
    }

    pub(crate) fn encrypt_history(
        conn: &VaultConnection,
        commit_id: &str,
        field: &str,
        plaintext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        crate::crypto_layer::encrypt_field(
            conn,
            FieldKeyPurpose::History,
            plaintext,
            "commit",
            commit_id,
            field,
        )
    }

    pub(crate) fn decrypt_history(
        conn: &VaultConnection,
        commit_id: &str,
        field: &str,
        ciphertext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        crate::crypto_layer::decrypt_field(
            conn,
            FieldKeyPurpose::History,
            ciphertext,
            "commit",
            commit_id,
            field,
        )
    }

    /// 写入 tombstone 记录。
    pub fn create_tombstone(
        &self,
        conn: &VaultConnection,
        target_object_type: &str,
        target_object_id: &str,
    ) -> StorageResult<String> {
        let tombstone_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let delete_clock = format!(r#"{{"tombstone":"{}"}}"#, tombstone_id);

        conn.inner().execute(
            "INSERT INTO tombstones (tombstone_id, target_object_type, target_object_id,
             delete_clock, deleted_by_device_id, deleted_at, purge_eligible_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            params![
                tombstone_id,
                target_object_type,
                target_object_id,
                delete_clock,
                self.device_id,
                now,
            ],
        )?;
        Ok(tombstone_id)
    }

    /// 写入带有因果 commit 证明的 MDBX2 tombstone。
    pub fn create_tombstone_for_commit(
        &self,
        conn: &VaultConnection,
        target_object_type: &str,
        target_object_id: &str,
        delete_commit_id: &str,
    ) -> StorageResult<String> {
        let delete_clock: String = conn
            .inner()
            .query_row(
                "SELECT vector_clock FROM commits WHERE commit_id = ?1",
                params![delete_commit_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(delete_commit_id.to_string()))?;
        let tombstone_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        conn.inner().execute(
            "INSERT INTO tombstones (tombstone_id, target_object_type, target_object_id,
             delete_clock, deleted_by_device_id, deleted_at, purge_eligible_at,
             delete_commit_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)",
            params![
                tombstone_id,
                target_object_type,
                target_object_id,
                delete_clock,
                self.device_id,
                now,
                delete_commit_id,
            ],
        )?;
        TombstoneAcknowledgementRepo::merge(
            conn,
            &tombstone_id,
            &self.device_id,
            delete_commit_id,
            &now,
        )?;

        Ok(tombstone_id)
    }

    /// 便捷方法：为单个对象的变更创建 commit。
    pub fn commit_object_change(
        &self,
        conn: &VaultConnection,
        object_table: &str,
        object_id: &str,
        commit_kind: &str,
        change_scope: &str,
    ) -> StorageResult<String> {
        self.commit_object_change_with_id_column(
            conn,
            object_table,
            &format!("{}_id", change_scope),
            object_id,
            commit_kind,
            change_scope,
        )
    }

    /// 为物理主键名称与逻辑变更范围不同的对象创建 commit。
    pub fn commit_object_change_with_id_column(
        &self,
        conn: &VaultConnection,
        object_table: &str,
        object_id_column: &str,
        object_id: &str,
        commit_kind: &str,
        change_scope: &str,
    ) -> StorageResult<String> {
        let parent_head = self.current_head(conn, object_table, object_id_column, object_id)?;
        let parents: Vec<String> = parent_head.into_iter().collect();

        self.create_commit(
            conn,
            commit_kind,
            change_scope,
            &[object_id.to_string()],
            &parents,
        )
    }

    fn resolve_new_operation_branch(
        conn: &VaultConnection,
        mut operation: CommitOperation,
    ) -> StorageResult<CommitOperation> {
        let branch = match operation.branch_id.as_deref() {
            Some(branch_id) => BranchRepo::require_by_id(conn, branch_id)?,
            None => BranchRepo::resolve_unique_name(conn, &operation.branch_name)?,
        };
        operation.branch_id = Some(branch.branch_id);
        operation.branch_name = branch.branch_name;
        Ok(operation)
    }

    fn branch_request_matches_existing(
        operation: &CommitOperation,
        stored_branch_id: Option<&str>,
        stored_branch_name: &str,
    ) -> bool {
        match stored_branch_id {
            Some(stored_branch_id) => operation
                .branch_id
                .as_deref()
                .map(|branch_id| branch_id == stored_branch_id)
                .unwrap_or_else(|| operation.branch_name == stored_branch_name),
            None => operation.branch_id.is_none() && operation.branch_name == stored_branch_name,
        }
    }

    fn operation_request_hash_for_existing(
        operation: &CommitOperation,
        stored_branch_id: Option<&str>,
        stored_branch_name: &str,
    ) -> StorageResult<Vec<u8>> {
        let mut canonical = operation.clone();
        canonical.branch_id = stored_branch_id.map(str::to_string);
        canonical.branch_name = stored_branch_name.to_string();
        Self::operation_request_hash(&canonical)
    }

    fn operation_request_identity(operation: &CommitOperation) -> StorageResult<Vec<u8>> {
        let digest = Self::operation_request_hash(operation)?;
        let mut identity =
            Vec::with_capacity(OPERATION_REQUEST_IDENTITY_V1_PREFIX.len() + digest.len());
        identity.extend_from_slice(OPERATION_REQUEST_IDENTITY_V1_PREFIX);
        identity.extend_from_slice(&digest);
        Ok(identity)
    }

    fn stored_request_identity_matches(
        stored: &[u8],
        requested_digest: &[u8],
        require_legacy_exact_match: bool,
    ) -> StorageResult<bool> {
        if stored.len()
            == OPERATION_REQUEST_IDENTITY_V1_PREFIX.len() + LEGACY_OPERATION_REQUEST_HASH_BYTES
            && stored.starts_with(OPERATION_REQUEST_IDENTITY_V1_PREFIX)
        {
            return Ok(&stored[OPERATION_REQUEST_IDENTITY_V1_PREFIX.len()..] == requested_digest);
        }
        if stored.len() == LEGACY_OPERATION_REQUEST_HASH_BYTES {
            return Ok(!require_legacy_exact_match || stored == requested_digest);
        }
        Err(StorageError::Validation(
            "unsupported operation request identity encoding".to_string(),
        ))
    }

    fn validate_operation(operation: &CommitOperation) -> StorageResult<()> {
        for (name, value) in [
            ("operation_id", operation.operation_id.as_str()),
            ("operation_kind", operation.operation_kind.as_str()),
            ("commit_kind", operation.commit_kind.as_str()),
            ("change_scope", operation.change_scope.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(StorageError::Validation(format!(
                    "{name} must not be empty"
                )));
            }
        }
        if operation
            .branch_id
            .as_deref()
            .is_some_and(|branch_id| branch_id.trim().is_empty())
        {
            return Err(StorageError::Validation(
                "branch_id must not be empty".to_string(),
            ));
        }
        if operation.branch_id.is_none() && operation.branch_name.trim().is_empty() {
            return Err(StorageError::Validation(
                "branch_name must not be empty when branch_id is absent".to_string(),
            ));
        }
        Self::validate_commit_taxonomy(&operation.commit_kind, &operation.change_scope)?;
        Ok(())
    }

    fn validate_commit_taxonomy(commit_kind: &str, change_scope: &str) -> StorageResult<()> {
        commit_kind
            .parse::<CommitKind>()
            .map_err(StorageError::Validation)?;
        change_scope
            .parse::<ChangeScope>()
            .map_err(StorageError::Validation)?;
        Ok(())
    }

    fn validate_parents(conn: &VaultConnection, parents: &[String]) -> StorageResult<()> {
        for parent in parents {
            let exists: bool = conn.inner().query_row(
                "SELECT EXISTS(SELECT 1 FROM commits WHERE commit_id = ?1)",
                params![parent],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StorageError::NotFound(format!("parent commit {parent}")));
            }
        }
        Ok(())
    }

    fn merge_vector_clocks(
        conn: &VaultConnection,
        parents: &[String],
        device_id: &str,
        local_seq: u64,
    ) -> StorageResult<String> {
        let mut merged = BTreeMap::<String, u64>::new();
        for parent in parents {
            let encoded: String = conn.inner().query_row(
                "SELECT vector_clock FROM commits WHERE commit_id = ?1",
                params![parent],
                |row| row.get(0),
            )?;
            let clock =
                serde_json::from_str::<BTreeMap<String, u64>>(&encoded).map_err(|error| {
                    StorageError::Validation(format!(
                        "invalid vector clock on parent {parent}: {error}"
                    ))
                })?;
            for (device, sequence) in clock {
                merged
                    .entry(device)
                    .and_modify(|current| *current = (*current).max(sequence))
                    .or_insert(sequence);
            }
        }
        merged.insert(device_id.to_string(), local_seq);
        serde_json::to_string(&merged)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))
    }

    fn operation_request_hash(operation: &CommitOperation) -> StorageResult<Vec<u8>> {
        if let Some(intent_hash) = &operation.intent_hash {
            let mut hasher = Sha256::new();
            let parts = if let Some(branch_id) = operation.branch_id.as_deref() {
                vec![
                    b"mdbx-operation-intent-v2".as_slice(),
                    operation.operation_id.as_bytes(),
                    operation.operation_kind.as_bytes(),
                    branch_id.as_bytes(),
                    operation.commit_kind.as_bytes(),
                    operation.change_scope.as_bytes(),
                    intent_hash.as_slice(),
                ]
            } else {
                vec![
                    b"mdbx-operation-intent-v1".as_slice(),
                    operation.operation_id.as_bytes(),
                    operation.operation_kind.as_bytes(),
                    operation.branch_name.as_bytes(),
                    operation.commit_kind.as_bytes(),
                    operation.change_scope.as_bytes(),
                    intent_hash.as_slice(),
                ]
            };
            for part in parts {
                hasher.update((part.len() as u64).to_le_bytes());
                hasher.update(part);
            }
            return Ok(hasher.finalize().to_vec());
        }
        let mut canonical = operation.clone();
        if canonical.branch_id.is_some() {
            canonical.branch_name.clear();
        }
        let encoded = serde_json::to_vec(&canonical)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        if canonical.branch_id.is_some() {
            let mut hasher = Sha256::new();
            for part in [b"mdbx-operation-request-v2".as_slice(), encoded.as_slice()] {
                hasher.update((part.len() as u64).to_le_bytes());
                hasher.update(part);
            }
            return Ok(hasher.finalize().to_vec());
        }
        Ok(Sha256::digest(encoded).to_vec())
    }

    fn operation_integrity(
        conn: &VaultConnection,
        operation: &CommitOperation,
        commit_id: &str,
        change_summary_ct: &[u8],
        request_hash: &[u8],
        created_at: &str,
    ) -> StorageResult<Vec<u8>> {
        let parts = if let Some(branch_id) = operation.branch_id.as_deref() {
            vec![
                b"mdbx-operation-integrity-v2".as_slice(),
                operation.operation_id.as_bytes(),
                commit_id.as_bytes(),
                operation.operation_kind.as_bytes(),
                branch_id.as_bytes(),
                operation.branch_name.as_bytes(),
                change_summary_ct,
                request_hash,
                created_at.as_bytes(),
            ]
        } else {
            vec![
                b"mdbx-operation-integrity-v1".as_slice(),
                operation.operation_id.as_bytes(),
                commit_id.as_bytes(),
                operation.operation_kind.as_bytes(),
                operation.branch_name.as_bytes(),
                change_summary_ct,
                request_hash,
                created_at.as_bytes(),
            ]
        };
        Self::authenticate_operation_parts(conn, &parts)
    }

    pub(crate) fn verify_operation_integrity(
        conn: &VaultConnection,
        commit: &Commit,
        operation: &mdbx_sync::CommitOperationMetadata,
    ) -> StorageResult<()> {
        Self::verify_operation_integrity_values(
            conn,
            &operation.operation_id,
            &commit.commit_id,
            &operation.operation_kind,
            operation.branch_id.as_deref(),
            &operation.branch_name,
            &operation.change_summary_ct,
            &operation.request_hash,
            &commit.created_at,
            &operation.integrity_tag,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_operation_integrity_values(
        conn: &VaultConnection,
        operation_id: &str,
        commit_id: &str,
        operation_kind: &str,
        branch_id: Option<&str>,
        branch_name: &str,
        change_summary_ct: &[u8],
        request_hash: &[u8],
        created_at: &str,
        integrity_tag: &[u8],
    ) -> StorageResult<()> {
        let parts = if let Some(branch_id) = branch_id {
            vec![
                b"mdbx-operation-integrity-v2".as_slice(),
                operation_id.as_bytes(),
                commit_id.as_bytes(),
                operation_kind.as_bytes(),
                branch_id.as_bytes(),
                branch_name.as_bytes(),
                change_summary_ct,
                request_hash,
                created_at.as_bytes(),
            ]
        } else {
            vec![
                b"mdbx-operation-integrity-v1".as_slice(),
                operation_id.as_bytes(),
                commit_id.as_bytes(),
                operation_kind.as_bytes(),
                branch_name.as_bytes(),
                change_summary_ct,
                request_hash,
                created_at.as_bytes(),
            ]
        };
        let expected = Self::authenticate_operation_parts(conn, &parts)?;
        let mut valid = expected.as_slice() == integrity_tag;
        if !valid
            && conn.keyring().is_some()
            && serde_json::from_slice::<serde_json::Value>(change_summary_ct).is_ok()
        {
            valid = Self::plain_operation_parts_hash(&parts).as_slice() == integrity_tag;
        }
        if !valid {
            return Err(StorageError::Validation(format!(
                "incoming operation {} integrity mismatch",
                operation_id
            )));
        }
        Ok(())
    }

    fn authenticate_operation_parts(
        conn: &VaultConnection,
        parts: &[&[u8]],
    ) -> StorageResult<Vec<u8>> {
        match conn.keyring() {
            Some(keyring) => mdbx_crypto::integrity::hmac_sha256(&keyring.integrity_subkey, parts)
                .map_err(StorageError::Crypto),
            None => Ok(Self::plain_operation_parts_hash(parts)),
        }
    }

    fn plain_operation_parts_hash(parts: &[&[u8]]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        for part in parts {
            hasher.update((part.len() as u64).to_le_bytes());
            hasher.update(part);
        }
        hasher.finalize().to_vec()
    }
}

fn deduplicate(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn merge_change(changes: &mut Vec<CommitChange>, incoming: CommitChange) {
    if let Some(existing) = changes.iter_mut().find(|change| {
        change.object_type == incoming.object_type && change.object_id == incoming.object_id
    }) {
        let incoming_is_placeholder = incoming.action == "change" && incoming.fields.is_empty();
        if incoming_is_placeholder {
            return;
        }
        let existing_is_placeholder = existing.action == "change" && existing.fields.is_empty();
        if existing_is_placeholder {
            *existing = incoming;
            return;
        }
        if existing.action != incoming.action {
            existing.action = "change".to_string();
        }
        for field in incoming.fields {
            if !existing.fields.contains(&field) {
                existing.fields.push(field);
            }
        }
        return;
    }
    changes.push(incoming);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitHistoryRepo, ProjectRepo};
    use std::sync::{Arc, Barrier};

    fn initialized() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "device-a".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        (conn, CommitContext::new("device-a".to_string()))
    }

    fn operation(id: &str) -> CommitOperation {
        CommitOperation::new(
            id,
            "batch-move",
            "main",
            "change",
            "entry",
            vec![
                CommitChange {
                    object_type: "entry".to_string(),
                    object_id: "entry-1".to_string(),
                    action: "move".to_string(),
                    fields: vec!["project_id".to_string()],
                },
                CommitChange {
                    object_type: "entry".to_string(),
                    object_id: "entry-2".to_string(),
                    action: "move".to_string(),
                    fields: vec!["project_id".to_string()],
                },
            ],
        )
        .with_message("Move two entries")
    }

    #[test]
    fn commit_write_seam_rejects_unknown_kind_and_scope_without_persisting() {
        let (conn, ctx) = initialized();
        let before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();

        let unknown_kind = CommitOperation::new(
            "unknown-kind-operation",
            "test",
            "main",
            "future-kind",
            "project",
            Vec::new(),
        );
        assert!(ctx.create_operation_commit(&conn, &unknown_kind).is_err());

        let unknown_scope = CommitOperation::new(
            "unknown-scope-operation",
            "test",
            "main",
            "change",
            "future-scope",
            Vec::new(),
        );
        assert!(ctx.create_operation_commit(&conn, &unknown_scope).is_err());

        assert!(conn.inner().is_autocommit());
        assert_eq!(
            conn.inner()
                .query_row("SELECT COUNT(*) FROM commits", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            before
        );
    }

    #[test]
    fn operation_retry_is_idempotent() {
        let (conn, ctx) = initialized();
        let request = operation("operation-1");

        let first = ctx.create_operation_commit(&conn, &request).unwrap();
        let second = ctx.create_operation_commit(&conn, &request).unwrap();

        assert_eq!(first, second);
        let commit_count: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(commit_count, 2);
    }

    #[test]
    fn operation_id_reuse_with_different_content_is_rejected() {
        let (conn, ctx) = initialized();
        ctx.create_operation_commit(&conn, &operation("operation-1"))
            .unwrap();
        let changed = operation("operation-1").with_message("different");

        let error = ctx.create_operation_commit(&conn, &changed).unwrap_err();

        assert!(error.to_string().contains("reused with different content"));
    }

    #[test]
    fn operation_targets_the_requested_branch() {
        let (conn, ctx) = initialized();
        let main_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.inner()
            .execute(
                "INSERT INTO branches
                 (branch_id, branch_name, head_commit_id, created_at, updated_at)
                 VALUES ('branch-review', 'review', ?1, '2026-07-19T00:00:00Z',
                         '2026-07-19T00:00:00Z')",
                params![main_head],
            )
            .unwrap();
        let mut request = operation("operation-review");
        request.branch_name = "review".to_string();
        request.branch_id = Some("branch-review".to_string());

        let commit_id = ctx.create_operation_commit(&conn, &request).unwrap();

        let heads: (String, String) = conn
            .inner()
            .query_row(
                "SELECT
                    MAX(CASE WHEN branch_name = 'main' THEN head_commit_id END),
                    MAX(CASE WHEN branch_name = 'review' THEN head_commit_id END)
                 FROM branches",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(heads.0, main_head);
        assert_eq!(heads.1, commit_id);
        let stored_branch_id: String = conn
            .inner()
            .query_row(
                "SELECT branch_id FROM commit_operations WHERE operation_id = 'operation-review'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_branch_id, "branch-review");
    }

    #[test]
    fn branch_id_targets_exactly_one_duplicate_name() {
        let (conn, ctx) = initialized();
        let main_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for branch_id in ["duplicate-a", "duplicate-b"] {
            conn.inner()
                .execute(
                    "INSERT INTO branches
                     (branch_id, branch_name, head_commit_id, created_at, updated_at)
                     VALUES (?1, 'duplicate', ?2, '2026-07-19T00:00:00Z',
                             '2026-07-19T00:00:00Z')",
                    params![branch_id, main_head],
                )
                .unwrap();
        }
        let request = operation("operation-duplicate-b").with_branch_id("duplicate-b");

        let commit_id = ctx.create_operation_commit(&conn, &request).unwrap();

        let heads: (String, String) = conn
            .inner()
            .query_row(
                "SELECT
                    MAX(CASE WHEN branch_id = 'duplicate-a' THEN head_commit_id END),
                    MAX(CASE WHEN branch_id = 'duplicate-b' THEN head_commit_id END)
                 FROM branches",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(heads.0, main_head);
        assert_eq!(heads.1, commit_id);
        let stored_name: String = conn
            .inner()
            .query_row(
                "SELECT branch_name FROM commit_operations WHERE operation_id = ?1",
                params![request.operation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_name, "duplicate");
    }

    #[test]
    fn name_only_operation_rejects_ambiguous_branch_name() {
        let (conn, ctx) = initialized();
        let main_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        for branch_id in ["duplicate-a", "duplicate-b"] {
            conn.inner()
                .execute(
                    "INSERT INTO branches
                     (branch_id, branch_name, head_commit_id, created_at, updated_at)
                     VALUES (?1, 'duplicate', ?2, '2026-07-19T00:00:00Z',
                             '2026-07-19T00:00:00Z')",
                    params![branch_id, main_head],
                )
                .unwrap();
        }
        let mut request = operation("ambiguous-operation");
        request.branch_name = "duplicate".to_string();

        let error = ctx.create_operation_commit(&conn, &request).unwrap_err();

        assert!(error.to_string().contains("ambiguous"));
        let next = ctx
            .create_operation_commit(&conn, &operation("valid-after-ambiguous"))
            .unwrap();
        let local_seq: i64 = conn
            .inner()
            .query_row(
                "SELECT local_seq FROM commits WHERE commit_id = ?1",
                params![next],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(local_seq, 1);
    }

    #[test]
    fn id_based_retry_ignores_later_display_name_change() {
        let (conn, ctx) = initialized();
        let main_branch_id: String = conn
            .inner()
            .query_row(
                "SELECT branch_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let request = operation("rename-safe-operation").with_branch_id(main_branch_id.clone());
        let first = ctx.create_operation_commit(&conn, &request).unwrap();
        conn.inner()
            .execute(
                "UPDATE branches SET branch_name = 'renamed-main' WHERE branch_id = ?1",
                params![main_branch_id],
            )
            .unwrap();

        let retry = ctx.create_operation_commit(&conn, &request).unwrap();

        assert_eq!(retry, first);
    }

    #[test]
    fn legacy_name_only_operation_remains_verifiable_and_retryable() {
        let (conn, ctx) = initialized();
        let request = operation("legacy-name-only-operation");
        let commit_id = ctx.create_operation_commit(&conn, &request).unwrap();
        let (change_summary_ct, created_at): (Vec<u8>, String) = conn
            .inner()
            .query_row(
                "SELECT o.change_summary_ct, o.created_at
                 FROM commit_operations o WHERE o.commit_id = ?1",
                params![commit_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let request_hash = CommitContext::operation_request_hash(&request).unwrap();
        let integrity_tag = CommitContext::operation_integrity(
            &conn,
            &request,
            &commit_id,
            &change_summary_ct,
            &request_hash,
            &created_at,
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations
                 SET branch_id = NULL, request_hash = ?1, integrity_tag = ?2
                 WHERE commit_id = ?3",
                params![request_hash, integrity_tag, commit_id],
            )
            .unwrap();

        let history = CommitHistoryRepo::get(&conn, &commit_id).unwrap().unwrap();
        let retry = ctx.create_operation_commit(&conn, &request).unwrap();

        assert_eq!(history.branch_id, None);
        assert_eq!(history.branch_name.as_deref(), Some("main"));
        assert_eq!(retry, commit_id);
    }

    #[test]
    fn vector_clock_merges_parent_causality() {
        let (conn, ctx) = initialized();
        let parent = ctx
            .create_operation_commit(&conn, &operation("operation-parent"))
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE commits SET vector_clock = '{\"device-a\":1,\"device-b\":9}'
                 WHERE commit_id = ?1",
                params![parent],
            )
            .unwrap();

        let child = ctx
            .create_operation_commit(&conn, &operation("operation-child"))
            .unwrap();
        let encoded: String = conn
            .inner()
            .query_row(
                "SELECT vector_clock FROM commits WHERE commit_id = ?1",
                params![child],
                |row| row.get(0),
            )
            .unwrap();
        let clock: BTreeMap<String, u64> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(clock.get("device-a"), Some(&2));
        assert_eq!(clock.get("device-b"), Some(&9));
    }

    #[test]
    fn failed_branch_does_not_consume_a_sequence() {
        let (conn, ctx) = initialized();
        let mut invalid = operation("operation-invalid");
        invalid.branch_name = "missing".to_string();
        assert!(ctx.create_operation_commit(&conn, &invalid).is_err());

        let commit_id = ctx
            .create_operation_commit(&conn, &operation("operation-valid"))
            .unwrap();
        let local_seq: i64 = conn
            .inner()
            .query_row(
                "SELECT local_seq FROM commits WHERE commit_id = ?1",
                params![commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(local_seq, 1);
    }

    #[test]
    fn several_repo_mutations_share_one_commit() {
        let (conn, ctx) = initialized();
        let before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let operation = CommitOperation::new(
            "edit-session-1",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );

        let execution = ctx
            .run_operation(&conn, operation, |scoped| {
                let first = ProjectRepo::create(&conn, scoped, "First", None, None)?;
                let second = ProjectRepo::create(&conn, scoped, "Second", None, None)?;
                Ok((first, second))
            })
            .unwrap();

        let (first, second, commit_id) = match execution {
            OperationExecution::Applied {
                value: (first, second),
                commit_id,
            } => (first, second, commit_id),
            OperationExecution::AlreadyCommitted { .. } => panic!("first call must execute"),
        };
        assert_eq!(first.head_commit_id, commit_id);
        assert_eq!(second.head_commit_id, commit_id);
        let after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before + 1);

        let changed: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT changed_object_ids_ct FROM commits WHERE commit_id = ?1",
                params![commit_id],
                |row| row.get(0),
            )
            .unwrap();
        let ids: Vec<String> = serde_json::from_slice(&changed).unwrap();
        assert_eq!(ids, vec![first.project_id, second.project_id]);
    }

    #[test]
    fn transaction_owned_operation_seam_defers_commit_and_sync_ownership() {
        let (conn, ctx) = initialized();
        let before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let operation = CommitOperation::new(
            "transaction-owned-operation",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );

        let execution = conn
            .with_immediate_transaction(|| {
                let execution = ctx.run_operation_in_transaction(&conn, operation, |scoped| {
                    let first = ProjectRepo::create(&conn, scoped, "First", None, None)?;
                    let second = ProjectRepo::create(&conn, scoped, "Second", None, None)?;
                    Ok((first, second))
                })?;
                assert!(!conn.inner().is_autocommit());
                Ok(execution)
            })
            .unwrap();

        let (first, second, commit_id) = match execution {
            OperationExecution::Applied {
                value: (first, second),
                commit_id,
            } => (first, second, commit_id),
            OperationExecution::AlreadyCommitted { .. } => panic!("first call must execute"),
        };
        assert_eq!(first.head_commit_id, commit_id);
        assert_eq!(second.head_commit_id, commit_id);
        let after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before + 1);

        let rollback_operation = CommitOperation::new(
            "transaction-owned-rollback",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let result = conn.with_immediate_transaction(|| {
            ctx.run_operation_in_transaction(
                &conn,
                rollback_operation,
                |scoped| -> StorageResult<()> {
                    ProjectRepo::create(&conn, scoped, "Rolled back", None, None)?;
                    Err(StorageError::Validation("cancelled".to_string()))
                },
            )
        });
        assert!(result.is_err());
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 2);
        let rollback_commit_exists: bool = conn
            .inner()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM commit_operations WHERE operation_id = ?1)",
                params!["transaction-owned-rollback"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!rollback_commit_exists);
    }

    #[test]
    fn failed_operation_rolls_back_mutations_and_commit() {
        let (conn, ctx) = initialized();
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let operation = CommitOperation::new(
            "edit-session-failed",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );

        let result = ctx.run_operation(&conn, operation, |scoped| -> StorageResult<()> {
            ProjectRepo::create(&conn, scoped, "Rolled back", None, None)?;
            Err(StorageError::Validation("cancelled".to_string()))
        });

        assert!(result.is_err());
        let projects: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        let commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(projects, 0);
        assert_eq!(commits, before_commits);
    }

    #[test]
    fn completed_operation_retry_does_not_run_mutations_again() {
        let (conn, ctx) = initialized();
        let operation = CommitOperation::new(
            "edit-session-retry",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        ctx.run_operation(&conn, operation.clone(), |scoped| {
            ProjectRepo::create(&conn, scoped, "Only once", None, None)
        })
        .unwrap();

        let retried = ctx
            .run_operation(&conn, operation, |_| -> StorageResult<()> {
                panic!("retry closure must not execute")
            })
            .unwrap();

        assert!(matches!(
            retried,
            OperationExecution::AlreadyCommitted { .. }
        ));
        let projects: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(projects, 1);
    }

    #[test]
    fn operation_retry_without_explicit_intent_rejects_changed_request_metadata() {
        let (conn, ctx) = initialized();
        let original = CommitOperation::new(
            "no-intent-changed-request",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        )
        .with_message("first request");
        ctx.run_operation(&conn, original, |scoped| {
            ProjectRepo::create(&conn, scoped, "First", None, None)
        })
        .unwrap();

        let changed = CommitOperation::new(
            "no-intent-changed-request",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        )
        .with_message("different request");
        let error = ctx
            .run_operation(&conn, changed, |_| -> StorageResult<()> {
                panic!("changed retry closure must not execute")
            })
            .unwrap_err();

        assert!(error.to_string().contains("different operation"));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn operation_retry_rejects_tampered_stored_request_identity() {
        let (conn, ctx) = initialized();
        let operation = CommitOperation::new(
            "tampered-request-identity",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        ctx.run_operation(&conn, operation.clone(), |scoped| {
            ProjectRepo::create(&conn, scoped, "First", None, None)
        })
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations SET request_hash = X'00' WHERE operation_id = ?1",
                params![operation.operation_id],
            )
            .unwrap();

        let error = ctx
            .run_operation(&conn, operation, |_| -> StorageResult<()> {
                panic!("tampered retry closure must not execute")
            })
            .unwrap_err();

        assert!(error.to_string().contains("integrity mismatch"));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn operation_retry_rejects_authenticated_unknown_request_identity_encoding() {
        let (conn, ctx) = initialized();
        let operation = CommitOperation::new(
            "unknown-request-identity-encoding",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let resolved =
            CommitContext::resolve_new_operation_branch(&conn, operation.clone()).unwrap();
        let execution = ctx
            .run_operation(&conn, operation.clone(), |scoped| {
                ProjectRepo::create(&conn, scoped, "First", None, None)
            })
            .unwrap();
        let commit_id = match execution {
            OperationExecution::Applied { commit_id, .. } => commit_id,
            OperationExecution::AlreadyCommitted { .. } => panic!("first call must execute"),
        };
        let (change_summary_ct, created_at): (Vec<u8>, String) = conn
            .inner()
            .query_row(
                "SELECT change_summary_ct, created_at FROM commit_operations
                 WHERE operation_id = ?1",
                params![operation.operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let mut unknown_identity = b"MDBXORI2".to_vec();
        unknown_identity.extend([0_u8; LEGACY_OPERATION_REQUEST_HASH_BYTES]);
        let integrity_tag = CommitContext::operation_integrity(
            &conn,
            &resolved,
            &commit_id,
            &change_summary_ct,
            &unknown_identity,
            &created_at,
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations SET request_hash = ?1, integrity_tag = ?2
                 WHERE operation_id = ?3",
                params![unknown_identity, integrity_tag, operation.operation_id],
            )
            .unwrap();

        let error = ctx
            .run_operation(&conn, operation, |_| -> StorageResult<()> {
                panic!("unknown identity retry closure must not execute")
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("unsupported operation request identity encoding"));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn coalesced_operation_keeps_the_versioned_initial_request_identity() {
        let (conn, ctx) = initialized();
        let operation = CommitOperation::new(
            "stable-initial-request-identity",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        )
        .with_message("create two projects");
        let resolved =
            CommitContext::resolve_new_operation_branch(&conn, operation.clone()).unwrap();
        let expected = CommitContext::operation_request_identity(&resolved).unwrap();

        ctx.run_operation(&conn, operation, |scoped| {
            ProjectRepo::create(&conn, scoped, "First", None, None)?;
            ProjectRepo::create(&conn, scoped, "Second", None, None)
        })
        .unwrap();

        let stored: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT request_hash FROM commit_operations WHERE operation_id = ?1",
                params!["stable-initial-request-identity"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, expected);
        assert!(stored.starts_with(OPERATION_REQUEST_IDENTITY_V1_PREFIX));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 2);
    }

    #[test]
    fn legacy_untagged_coalesced_operation_remains_retryable() {
        let (conn, ctx) = initialized();
        let operation = CommitOperation::new(
            "legacy-untagged-coalesced-operation",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let resolved =
            CommitContext::resolve_new_operation_branch(&conn, operation.clone()).unwrap();
        let legacy_request_hash = CommitContext::operation_request_hash(&resolved).unwrap();
        let execution = ctx
            .run_operation(&conn, operation.clone(), |scoped| {
                ProjectRepo::create(&conn, scoped, "Legacy", None, None)
            })
            .unwrap();
        let commit_id = match execution {
            OperationExecution::Applied { commit_id, .. } => commit_id,
            OperationExecution::AlreadyCommitted { .. } => panic!("first call must execute"),
        };
        let (change_summary_ct, created_at): (Vec<u8>, String) = conn
            .inner()
            .query_row(
                "SELECT change_summary_ct, created_at FROM commit_operations
                 WHERE operation_id = ?1",
                params![operation.operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let integrity_tag = CommitContext::operation_integrity(
            &conn,
            &resolved,
            &commit_id,
            &change_summary_ct,
            &legacy_request_hash,
            &created_at,
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations SET request_hash = ?1, integrity_tag = ?2
                 WHERE operation_id = ?3",
                params![legacy_request_hash, integrity_tag, operation.operation_id],
            )
            .unwrap();

        let retried = ctx
            .run_operation(&conn, operation, |_| -> StorageResult<()> {
                panic!("legacy retry closure must not execute")
            })
            .unwrap();

        assert!(matches!(
            retried,
            OperationExecution::AlreadyCommitted { .. }
        ));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn repeated_edits_keep_only_the_final_object_version_in_one_commit() {
        let (conn, ctx) = initialized();
        let project = ProjectRepo::create(&conn, &ctx, "Original", None, None).unwrap();
        let before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let operation = CommitOperation::new(
            "edit-session-repeated",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );

        let execution = ctx
            .run_operation(&conn, operation, |scoped| {
                let mut editing = ProjectRepo::get_by_id(&conn, &project.project_id)?
                    .ok_or_else(|| StorageError::NotFound(project.project_id.clone()))?;
                editing.title_ct = b"First edit".to_vec();
                editing = ProjectRepo::update(&conn, scoped, &editing)?;
                editing.title_ct = b"Final edit".to_vec();
                ProjectRepo::update(&conn, scoped, &editing)
            })
            .unwrap();
        let (updated, commit_id) = match execution {
            OperationExecution::Applied { value, commit_id } => (value, commit_id),
            OperationExecution::AlreadyCommitted { .. } => panic!("first call must execute"),
        };

        assert_eq!(updated.title_ct, b"Final edit");
        assert_eq!(updated.head_commit_id, commit_id);
        let after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before + 1);
        let version_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM object_versions
                 WHERE object_type = 'project' AND object_id = ?1 AND commit_id = ?2",
                params![project.project_id, commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version_count, 1);
    }

    #[test]
    fn concurrent_retry_executes_one_operation_only_once() {
        let path =
            std::env::temp_dir().join(format!("mdbx-operation-race-{}.mdbx", Uuid::new_v4()));
        {
            let conn = VaultConnection::create(&path).unwrap();
            initialize_vault(
                &conn,
                &VaultInitParams {
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let barrier = Arc::new(Barrier::new(2));
        let operation = CommitOperation::new(
            "operation-race",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let handles = (0..2)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let path = path.clone();
                let operation = operation.clone();
                std::thread::spawn(move || {
                    let conn = VaultConnection::open(&path).unwrap();
                    let ctx = CommitContext::new("device-a".to_string());
                    barrier.wait();
                    ctx.run_operation(&conn, operation, |scoped| {
                        ProjectRepo::create(&conn, scoped, "once", None, None)
                    })
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();

        let conn = VaultConnection::open(&path).unwrap();
        let project_count: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
            .unwrap();
        assert_eq!(project_count, 1);
        assert!(results
            .iter()
            .any(|result| matches!(result, OperationExecution::Applied { .. })));
        assert!(results
            .iter()
            .any(|result| matches!(result, OperationExecution::AlreadyCommitted { .. })));

        drop(conn);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }

    #[test]
    fn caught_nested_error_does_not_disable_coalescing() {
        let (conn, ctx) = initialized();
        let before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let operation = CommitOperation::new(
            "operation-after-error",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );

        let result = ctx
            .run_operation(&conn, operation, |scoped| {
                let error = scoped
                    .create_commit(&conn, "merge", "project", &["invalid".to_string()], &[])
                    .unwrap_err();
                assert!(error.to_string().contains("cannot contain merge"));
                ProjectRepo::create(&conn, scoped, "Still coalesced", None, None)
            })
            .unwrap();
        let commit_id = match result {
            OperationExecution::Applied { commit_id, .. } => commit_id,
            OperationExecution::AlreadyCommitted { .. } => panic!("first call must execute"),
        };

        let after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after, before + 1);
        let operation_commit: String = conn
            .inner()
            .query_row(
                "SELECT commit_id FROM commit_operations WHERE operation_id = ?1",
                params!["operation-after-error"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(operation_commit, commit_id);
    }

    #[test]
    fn operation_retry_rejects_a_different_immutable_intent() {
        let (conn, ctx) = initialized();
        let operation = CommitOperation::new(
            "stable-intent-operation",
            "client-edit",
            "main",
            "change",
            "project",
            Vec::new(),
        )
        .with_intent_hash(vec![1; 32]);
        ctx.run_operation(&conn, operation, |scoped| {
            ProjectRepo::create(&conn, scoped, "First", None, None)
        })
        .unwrap();

        let changed_intent = CommitOperation::new(
            "stable-intent-operation",
            "client-edit",
            "main",
            "change",
            "project",
            Vec::new(),
        )
        .with_intent_hash(vec![2; 32]);
        let error = ctx
            .run_operation(&conn, changed_intent, |scoped| {
                ProjectRepo::create(&conn, scoped, "Second", None, None)
            })
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("reused for a different operation"));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn generic_change_does_not_erase_a_specific_summary() {
        let mut changes = vec![CommitChange {
            object_type: "entry".to_string(),
            object_id: "entry-1".to_string(),
            action: "move".to_string(),
            fields: vec!["project_id".to_string()],
        }];

        merge_change(
            &mut changes,
            CommitChange {
                object_type: "entry".to_string(),
                object_id: "entry-1".to_string(),
                action: "change".to_string(),
                fields: Vec::new(),
            },
        );

        assert_eq!(changes[0].action, "move");
        assert_eq!(changes[0].fields, vec!["project_id"]);
    }

    #[test]
    fn specific_summary_replaces_a_generic_placeholder() {
        let mut changes = vec![CommitChange {
            object_type: "entry".to_string(),
            object_id: "entry-1".to_string(),
            action: "change".to_string(),
            fields: Vec::new(),
        }];

        merge_change(
            &mut changes,
            CommitChange {
                object_type: "entry".to_string(),
                object_id: "entry-1".to_string(),
                action: "delete".to_string(),
                fields: vec!["deleted".to_string()],
            },
        );

        assert_eq!(changes[0].action, "delete");
        assert_eq!(changes[0].fields, vec!["deleted"]);
    }
}
