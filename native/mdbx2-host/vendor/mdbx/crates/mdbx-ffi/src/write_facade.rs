#[uniffi::export]
pub fn default_write_operation_limits() -> MdbxWriteOperationLimits {
    MdbxWriteOperationLimits::from_internal(InternalWriteOperationLimits::default())
}

#[uniffi::export]
pub fn default_composite_write_operation_limits() -> MdbxCompositeWriteOperationLimits {
    MdbxCompositeWriteOperationLimits {
        write_limits: default_write_operation_limits(),
        attachment_limits: default_attachment_batch_limits(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCompositeWriteOperationLimits {
    pub write_limits: MdbxWriteOperationLimits,
    pub attachment_limits: MdbxAttachmentBatchLimits,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct MdbxCompositeWriteOperationResult {
    pub operation: MdbxWriteOperationResult,
    pub attachments: Vec<MdbxAttachmentRecord>,
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, uniffi::Enum)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MdbxWriteCommand {
    CreateProject {
        project_id: String,
        title: String,
    },
    CreateProjectWithParent {
        project_id: String,
        title: String,
        parent_project_id: Option<String>,
    },
    RenameProject {
        project_id: String,
        title: String,
    },
    MoveProject {
        project_id: String,
        parent_project_id: Option<String>,
    },
    DeleteProject {
        project_id: String,
    },
    RestoreProject {
        project_id: String,
        parent_project_id: Option<String>,
    },
    CreateEntry {
        entry_id: String,
        project_id: String,
        entry_type: String,
        title: String,
        payload_json: String,
    },
    UpdateEntry {
        entry_id: String,
        project_id: String,
        entry_type: String,
        title: String,
        payload_json: String,
    },
    DeleteEntry {
        entry_id: String,
        project_id: String,
    },
    RestoreEntry {
        entry_id: String,
        project_id: String,
    },
    MoveEntry {
        entry_id: String,
        project_id: String,
        target_project_id: String,
    },
    CreateObjectRelation {
        relation_id: String,
        source_object_id: String,
        target_object_id: String,
        relation_kind: String,
        payload_json: String,
        payload_schema_version: u32,
    },
    UpdateObjectRelation {
        relation_id: String,
        relation_kind: String,
        payload_json: String,
        payload_schema_version: u32,
    },
    DeleteObjectRelation {
        relation_id: String,
    },
    CreateObjectLabel {
        label_id: String,
        collection_id: String,
        name: String,
        payload_json: String,
        payload_schema_version: u32,
    },
    UpdateObjectLabel {
        label_id: String,
        name: String,
        payload_json: String,
        payload_schema_version: u32,
    },
    DeleteObjectLabel {
        label_id: String,
    },
    AssignObjectLabel {
        assignment_id: String,
        object_id: String,
        label_id: String,
    },
    RemoveObjectLabelAssignment {
        assignment_id: String,
    },
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct MdbxWriteOperationResult {
    pub commit_id: String,
    pub already_committed: bool,
    pub project_ids: Vec<String>,
    pub entry_ids: Vec<String>,
    pub relation_ids: Vec<String>,
    pub label_ids: Vec<String>,
    pub label_assignment_ids: Vec<String>,
}

/// Resource contract for one generic user-level write operation.
///
/// The defaults are suitable for interactive clients. Explicit values are
/// accepted only within the hard ceilings so a caller cannot disable the
/// boundary by opting into a custom profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxWriteOperationLimits {
    pub max_commands: u64,
    pub max_payload_bytes_per_command: u64,
    pub max_payload_bytes: u64,
    pub max_intent_bytes: u64,
}

pub(crate) const DEFAULT_MAX_WRITE_COMMANDS: usize = mdbx_storage::repo::DEFAULT_MAX_WRITE_COMMANDS;
#[cfg(test)]
pub(crate) const HARD_MAX_WRITE_COMMANDS: usize = mdbx_storage::repo::HARD_MAX_WRITE_COMMANDS;
pub(crate) const DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND: usize =
    mdbx_storage::repo::DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND;
const DEFAULT_MAX_WRITE_PAYLOAD_BYTES: usize = mdbx_storage::repo::DEFAULT_MAX_WRITE_PAYLOAD_BYTES;
const DEFAULT_MAX_WRITE_INTENT_BYTES: usize = mdbx_storage::repo::DEFAULT_MAX_WRITE_INTENT_BYTES;

impl Default for MdbxWriteOperationLimits {
    fn default() -> Self {
        Self {
            max_commands: DEFAULT_MAX_WRITE_COMMANDS as u64,
            max_payload_bytes_per_command: DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND as u64,
            max_payload_bytes: DEFAULT_MAX_WRITE_PAYLOAD_BYTES as u64,
            max_intent_bytes: DEFAULT_MAX_WRITE_INTENT_BYTES as u64,
        }
    }
}

impl MdbxWriteOperationLimits {
    pub(crate) fn into_internal(self) -> Result<InternalWriteOperationLimits, MdbxFfiError> {
        let limits = InternalWriteOperationLimits {
            max_commands: usize::try_from(self.max_commands)
                .map_err(|_| StorageError::Validation("max_commands is too large".to_string()))?,
            max_payload_bytes_per_command: usize::try_from(self.max_payload_bytes_per_command)
                .map_err(|_| {
                    StorageError::Validation(
                        "max_payload_bytes_per_command is too large".to_string(),
                    )
                })?,
            max_payload_bytes: usize::try_from(self.max_payload_bytes).map_err(|_| {
                StorageError::Validation("max_payload_bytes is too large".to_string())
            })?,
            max_intent_bytes: usize::try_from(self.max_intent_bytes).map_err(|_| {
                StorageError::Validation("max_intent_bytes is too large".to_string())
            })?,
        };
        limits.validate()?;
        Ok(limits)
    }

    fn from_internal(limits: InternalWriteOperationLimits) -> Self {
        MdbxWriteOperationLimits {
            max_commands: limits.max_commands as u64,
            max_payload_bytes_per_command: limits.max_payload_bytes_per_command as u64,
            max_payload_bytes: limits.max_payload_bytes as u64,
            max_intent_bytes: limits.max_intent_bytes as u64,
        }
    }
}

pub(crate) fn validate_uuid(value: &str, field: &str) -> Result<(), MdbxFfiError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| StorageError::Validation(format!("{field} {value} must be a UUID")).into())
}

use mdbx_storage::connection::VaultConnection;
use mdbx_storage::error::{StorageError, StorageResult};
#[cfg(test)]
use mdbx_storage::repo::{
    hash_write_operation_intent as hash_storage_write_operation_intent,
    write_operation_changes as storage_write_operation_changes,
};
use mdbx_storage::repo::{
    write_operation_scope as storage_write_operation_scope, AttachmentRepo, BranchRepo,
    CommitChange, CommitContext, CommitOperation, OperationCoordinator, OperationCoordinatorError,
    OperationExecution, WriteCommand as StorageWriteCommand,
    WriteOperationLimits as InternalWriteOperationLimits, WriteOperationRequest,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::attachment_facade::{
    attachment_batch_changes, attachment_batch_ids, attachment_record_from_core,
    execute_attachment_batch_commands, hash_attachment_batch_intent, update_attachment_intent_part,
    validate_attachment_batch_operation_inputs,
};
use super::{
    default_attachment_batch_limits, MdbxAttachmentBatchCommand, MdbxAttachmentBatchLimits,
    MdbxAttachmentRecord, MdbxFfiError, MdbxVault,
};

impl From<MdbxWriteCommand> for StorageWriteCommand {
    fn from(command: MdbxWriteCommand) -> Self {
        match command {
            MdbxWriteCommand::CreateProject { project_id, title } => {
                Self::CreateProject { project_id, title }
            }
            MdbxWriteCommand::CreateProjectWithParent {
                project_id,
                title,
                parent_project_id,
            } => Self::CreateProjectWithParent {
                project_id,
                title,
                parent_project_id,
            },
            MdbxWriteCommand::RenameProject { project_id, title } => {
                Self::RenameProject { project_id, title }
            }
            MdbxWriteCommand::MoveProject {
                project_id,
                parent_project_id,
            } => Self::MoveProject {
                project_id,
                parent_project_id,
            },
            MdbxWriteCommand::DeleteProject { project_id } => Self::DeleteProject { project_id },
            MdbxWriteCommand::RestoreProject {
                project_id,
                parent_project_id,
            } => Self::RestoreProject {
                project_id,
                parent_project_id,
            },
            MdbxWriteCommand::CreateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload_json,
            } => Self::CreateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload_json,
            },
            MdbxWriteCommand::UpdateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload_json,
            } => Self::UpdateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload_json,
            },
            MdbxWriteCommand::DeleteEntry {
                entry_id,
                project_id,
            } => Self::DeleteEntry {
                entry_id,
                project_id,
            },
            MdbxWriteCommand::RestoreEntry {
                entry_id,
                project_id,
            } => Self::RestoreEntry {
                entry_id,
                project_id,
            },
            MdbxWriteCommand::MoveEntry {
                entry_id,
                project_id,
                target_project_id,
            } => Self::MoveEntry {
                entry_id,
                project_id,
                target_project_id,
            },
            MdbxWriteCommand::CreateObjectRelation {
                relation_id,
                source_object_id,
                target_object_id,
                relation_kind,
                payload_json,
                payload_schema_version,
            } => Self::CreateObjectRelation {
                relation_id,
                source_object_id,
                target_object_id,
                relation_kind,
                payload_json,
                payload_schema_version,
            },
            MdbxWriteCommand::UpdateObjectRelation {
                relation_id,
                relation_kind,
                payload_json,
                payload_schema_version,
            } => Self::UpdateObjectRelation {
                relation_id,
                relation_kind,
                payload_json,
                payload_schema_version,
            },
            MdbxWriteCommand::DeleteObjectRelation { relation_id } => {
                Self::DeleteObjectRelation { relation_id }
            }
            MdbxWriteCommand::CreateObjectLabel {
                label_id,
                collection_id,
                name,
                payload_json,
                payload_schema_version,
            } => Self::CreateObjectLabel {
                label_id,
                collection_id,
                name,
                payload_json,
                payload_schema_version,
            },
            MdbxWriteCommand::UpdateObjectLabel {
                label_id,
                name,
                payload_json,
                payload_schema_version,
            } => Self::UpdateObjectLabel {
                label_id,
                name,
                payload_json,
                payload_schema_version,
            },
            MdbxWriteCommand::DeleteObjectLabel { label_id } => {
                Self::DeleteObjectLabel { label_id }
            }
            MdbxWriteCommand::AssignObjectLabel {
                assignment_id,
                object_id,
                label_id,
            } => Self::AssignObjectLabel {
                assignment_id,
                object_id,
                label_id,
            },
            MdbxWriteCommand::RemoveObjectLabelAssignment { assignment_id } => {
                Self::RemoveObjectLabelAssignment { assignment_id }
            }
        }
    }
}

impl From<OperationCoordinatorError> for MdbxFfiError {
    fn from(error: OperationCoordinatorError) -> Self {
        match error {
            OperationCoordinatorError::Storage(error) => error.into(),
            OperationCoordinatorError::Serialization(error) => error.into(),
            OperationCoordinatorError::InvalidObjectTypeId { object_type_id } => {
                Self::InvalidEntryType {
                    entry_type: object_type_id,
                }
            }
            OperationCoordinatorError::InvalidRelationKind { relation_kind } => {
                Self::InvalidRelationKind { relation_kind }
            }
        }
    }
}

#[cfg(test)]
fn storage_write_commands(commands: &[MdbxWriteCommand]) -> Vec<StorageWriteCommand> {
    commands.iter().cloned().map(Into::into).collect()
}

#[cfg(test)]
pub(crate) fn hash_write_operation_intent(
    commands: &[MdbxWriteCommand],
    limit: usize,
) -> Result<Vec<u8>, MdbxFfiError> {
    hash_storage_write_operation_intent(&storage_write_commands(commands), limit)
        .map_err(Into::into)
}

#[cfg(test)]
pub(crate) fn write_operation_changes(commands: &[MdbxWriteCommand]) -> Vec<CommitChange> {
    storage_write_operation_changes(&storage_write_commands(commands))
}

pub(crate) fn execute_write_operation_for_branch(
    vault: &MdbxVault,
    branch_id: Option<String>,
    operation_id: String,
    operation_kind: String,
    commands: Vec<MdbxWriteCommand>,
    limits: InternalWriteOperationLimits,
) -> Result<MdbxWriteOperationResult, MdbxFfiError> {
    let storage_commands = commands.into_iter().map(Into::into).collect();
    let mut request = WriteOperationRequest::new(operation_id, operation_kind, storage_commands)
        .with_limits(limits);
    if let Some(branch_id) = branch_id {
        request = request.with_branch_id(branch_id);
    }
    let prepared = OperationCoordinator::prepare(request)?;

    let conn = vault.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
    let ctx = CommitContext::new(vault.device_id.clone());
    let outcome = OperationCoordinator::execute_prepared(&conn, &ctx, &prepared)?;
    Ok(write_operation_result(
        &outcome.changed_objects,
        outcome.commit_id,
        outcome.already_committed,
    ))
}

pub(crate) struct CompositeWriteOperation {
    pub(crate) branch_id: Option<String>,
    pub(crate) operation_id: String,
    pub(crate) operation_kind: String,
    pub(crate) commands: Vec<MdbxWriteCommand>,
    pub(crate) attachment_commands: Vec<MdbxAttachmentBatchCommand>,
    pub(crate) write_limits: InternalWriteOperationLimits,
    pub(crate) attachment_limits: MdbxAttachmentBatchLimits,
}

pub(crate) fn execute_composite_write_operation(
    vault: &MdbxVault,
    request: CompositeWriteOperation,
) -> Result<MdbxCompositeWriteOperationResult, MdbxFfiError> {
    let CompositeWriteOperation {
        branch_id,
        operation_id,
        operation_kind,
        commands,
        attachment_commands,
        write_limits,
        attachment_limits,
    } = request;
    if commands.is_empty() || attachment_commands.is_empty() {
        return Err(StorageError::Validation(
            "composite write operation requires generic and attachment commands".to_string(),
        )
        .into());
    }
    let storage_commands = commands.into_iter().map(Into::into).collect();
    let mut generic_request = WriteOperationRequest::new(
        operation_id.clone(),
        operation_kind.clone(),
        storage_commands,
    )
    .with_limits(write_limits);
    if let Some(branch_id) = &branch_id {
        generic_request = generic_request.with_branch_id(branch_id.clone());
    }
    let prepared = OperationCoordinator::prepare(generic_request)?;
    let chunk_size = validate_attachment_batch_operation_inputs(
        &operation_id,
        &attachment_commands,
        attachment_limits,
    )?;
    let attachment_intent_hash =
        hash_attachment_batch_intent(&operation_id, &attachment_commands, attachment_limits);
    let intent_hash = hash_composite_write_intent(
        &operation_id,
        &operation_kind,
        prepared.intent_hash(),
        &attachment_intent_hash,
    );
    let attachment_ids = attachment_batch_ids(&attachment_commands);
    let mut changed_objects = prepared.changed_objects().to_vec();
    changed_objects.extend(attachment_batch_changes(&attachment_commands));
    let mut operation = CommitOperation::new(
        prepared.operation_id(),
        prepared.operation_kind(),
        prepared.branch_id().map(|_| "").unwrap_or("main"),
        "change",
        storage_write_operation_scope(&changed_objects),
        changed_objects,
    )
    .with_intent_hash(intent_hash);
    if let Some(branch_id) = prepared.branch_id() {
        operation = operation.with_branch_id(branch_id);
    }

    let conn = vault.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
    let ctx = CommitContext::new(vault.device_id.clone());
    let ids_for_action = attachment_ids.clone();
    let execution = ctx.run_operation(&conn, operation, |scoped| {
        prepared.apply(&conn, scoped)?;
        execute_attachment_batch_commands(
            &conn,
            scoped,
            attachment_commands,
            chunk_size,
            &ids_for_action,
        )
    })?;
    let (commit_id, already_committed) = match execution {
        OperationExecution::Applied { commit_id, .. } => (commit_id, false),
        OperationExecution::AlreadyCommitted { commit_id } => (commit_id, true),
    };
    let attachments = attachment_ids
        .iter()
        .map(|attachment_id| {
            AttachmentRepo::get_by_id(&conn, attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id.clone()))
        })
        .collect::<StorageResult<Vec<_>>>()?
        .iter()
        .map(attachment_record_from_core)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(MdbxCompositeWriteOperationResult {
        operation: write_operation_result(prepared.changed_objects(), commit_id, already_committed),
        attachments,
    })
}

fn hash_composite_write_intent(
    operation_id: &str,
    operation_kind: &str,
    generic_intent_hash: &[u8],
    attachment_intent_hash: &[u8],
) -> Vec<u8> {
    let mut hasher = Sha256::new();
    update_attachment_intent_part(&mut hasher, b"mdbx-ffi-composite-write-v1");
    update_attachment_intent_part(&mut hasher, operation_id.as_bytes());
    update_attachment_intent_part(&mut hasher, operation_kind.as_bytes());
    update_attachment_intent_part(&mut hasher, generic_intent_hash);
    update_attachment_intent_part(&mut hasher, attachment_intent_hash);
    hasher.finalize().to_vec()
}

fn write_operation_result(
    changes: &[CommitChange],
    commit_id: String,
    already_committed: bool,
) -> MdbxWriteOperationResult {
    let mut project_ids = Vec::new();
    let mut entry_ids = Vec::new();
    let mut relation_ids = Vec::new();
    let mut label_ids = Vec::new();
    let mut label_assignment_ids = Vec::new();
    for change in changes {
        match change.object_type.as_str() {
            "project" => project_ids.push(change.object_id.clone()),
            "entry" => entry_ids.push(change.object_id.clone()),
            "object-relation" => relation_ids.push(change.object_id.clone()),
            "object-label" => label_ids.push(change.object_id.clone()),
            "object-label-assignment" => label_assignment_ids.push(change.object_id.clone()),
            _ => {}
        }
    }
    MdbxWriteOperationResult {
        commit_id,
        already_committed,
        project_ids,
        entry_ids,
        relation_ids,
        label_ids,
        label_assignment_ids,
    }
}

/// Extension-only precondition for a write verified against all branch heads.
/// This includes attachment-only commits which do not advance an Object head.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxWriteRevision {
    pub vault_id: String,
    pub revision_sha256: String,
}

fn write_revision_hash(conn: &VaultConnection, vault_id: &str) -> StorageResult<String> {
    let mut branches = BranchRepo::list(conn)?;
    branches.sort_by(|left, right| left.branch_id.cmp(&right.branch_id));
    let mut hash = Sha256::new();
    update_attachment_intent_part(&mut hash, b"monica-extension-write-revision-v1");
    update_attachment_intent_part(&mut hash, vault_id.as_bytes());
    for branch in branches {
        for value in [branch.branch_id, branch.branch_name, branch.head_commit_id] {
            update_attachment_intent_part(&mut hash, value.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[uniffi::export]
impl MdbxVault {
    pub fn read_write_revision(&self) -> Result<MdbxWriteRevision, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(MdbxWriteRevision {
            vault_id: self.vault_id.clone(),
            revision_sha256: write_revision_hash(&conn, &self.vault_id)?,
        })
    }

    /// Check and write within BEGIN IMMEDIATE, covering other connections too.
    /// The guard is part of the durable intent; only an identical committed
    /// request may replay after its original revision no longer exists.
    pub fn execute_write_operation_at_revision(
        &self,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        expected: MdbxWriteRevision,
    ) -> Result<MdbxWriteOperationResult, MdbxFfiError> {
        validate_uuid(&expected.vault_id, "expected vault ID")?;
        if expected.revision_sha256.len() != 64
            || !expected
                .revision_sha256
                .bytes()
                .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
        {
            return Err(StorageError::Validation("write revision is invalid".to_string()).into());
        }
        // Match OperationCoordinator's repository kinds; restore/move may not
        // execute inside a context declared as an ordinary change.
        let kinds = commands.iter().map(|command| match command {
            MdbxWriteCommand::RestoreProject { .. } | MdbxWriteCommand::RestoreEntry { .. } => "restore",
            MdbxWriteCommand::MoveProject { .. } | MdbxWriteCommand::MoveEntry { .. } => "move",
            _ => "change",
        }).collect::<std::collections::BTreeSet<_>>();
        let commit_kind = if kinds.len() == 1 { *kinds.iter().next().unwrap() } else { "multi" };
        let prepared = OperationCoordinator::prepare(WriteOperationRequest::new(
            operation_id,
            operation_kind,
            commands.into_iter().map(Into::into).collect(),
        ))?;
        let mut intent = Sha256::new();
        for part in [
            b"monica-extension-guarded-write-v1".as_slice(),
            prepared.intent_hash(),
            expected.vault_id.as_bytes(),
            expected.revision_sha256.as_bytes(),
        ] {
            update_attachment_intent_part(&mut intent, part);
        }
        let operation = CommitOperation::new(
            prepared.operation_id(),
            prepared.operation_kind(),
            "main",
            commit_kind,
            prepared.change_scope(),
            prepared.changed_objects().to_vec(),
        )
        .with_intent_hash(intent.finalize().to_vec());
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let ctx = CommitContext::new(self.device_id.clone());
        let execution = ctx.run_operation(&conn, operation, |scoped| {
            if expected.vault_id != self.vault_id
                || write_revision_hash(&conn, &self.vault_id)? != expected.revision_sha256
            {
                return Err(StorageError::Validation(
                    "write revision changed".to_string(),
                ));
            }
            prepared.apply(&conn, scoped)
        })?;
        let (commit_id, already_committed) = match execution {
            OperationExecution::Applied { commit_id, .. } => (commit_id, false),
            OperationExecution::AlreadyCommitted { commit_id } => (commit_id, true),
        };
        Ok(write_operation_result(
            prepared.changed_objects(),
            commit_id,
            already_committed,
        ))
    }

    pub fn execute_write_operation(
        &self,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
    ) -> Result<MdbxWriteOperationResult, MdbxFfiError> {
        execute_write_operation_for_branch(
            self,
            None,
            operation_id,
            operation_kind,
            commands,
            InternalWriteOperationLimits::default(),
        )
    }

    pub fn execute_write_operation_with_limits(
        &self,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        limits: MdbxWriteOperationLimits,
    ) -> Result<MdbxWriteOperationResult, MdbxFfiError> {
        execute_write_operation_for_branch(
            self,
            None,
            operation_id,
            operation_kind,
            commands,
            limits.into_internal()?,
        )
    }

    pub fn execute_write_operation_on_branch(
        &self,
        branch_id: String,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
    ) -> Result<MdbxWriteOperationResult, MdbxFfiError> {
        execute_write_operation_for_branch(
            self,
            Some(branch_id),
            operation_id,
            operation_kind,
            commands,
            InternalWriteOperationLimits::default(),
        )
    }

    pub fn execute_write_operation_on_branch_with_limits(
        &self,
        branch_id: String,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        limits: MdbxWriteOperationLimits,
    ) -> Result<MdbxWriteOperationResult, MdbxFfiError> {
        execute_write_operation_for_branch(
            self,
            Some(branch_id),
            operation_id,
            operation_kind,
            commands,
            limits.into_internal()?,
        )
    }

    pub fn execute_composite_write_operation(
        &self,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        attachment_commands: Vec<MdbxAttachmentBatchCommand>,
    ) -> Result<MdbxCompositeWriteOperationResult, MdbxFfiError> {
        execute_composite_write_operation(
            self,
            CompositeWriteOperation {
                branch_id: None,
                operation_id,
                operation_kind,
                commands,
                attachment_commands,
                write_limits: InternalWriteOperationLimits::default(),
                attachment_limits: default_attachment_batch_limits(),
            },
        )
    }

    pub fn execute_composite_write_operation_with_limits(
        &self,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        attachment_commands: Vec<MdbxAttachmentBatchCommand>,
        limits: MdbxCompositeWriteOperationLimits,
    ) -> Result<MdbxCompositeWriteOperationResult, MdbxFfiError> {
        execute_composite_write_operation(
            self,
            CompositeWriteOperation {
                branch_id: None,
                operation_id,
                operation_kind,
                commands,
                attachment_commands,
                write_limits: limits.write_limits.into_internal()?,
                attachment_limits: limits.attachment_limits,
            },
        )
    }

    pub fn execute_composite_write_operation_on_branch(
        &self,
        branch_id: String,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        attachment_commands: Vec<MdbxAttachmentBatchCommand>,
    ) -> Result<MdbxCompositeWriteOperationResult, MdbxFfiError> {
        execute_composite_write_operation(
            self,
            CompositeWriteOperation {
                branch_id: Some(branch_id),
                operation_id,
                operation_kind,
                commands,
                attachment_commands,
                write_limits: InternalWriteOperationLimits::default(),
                attachment_limits: default_attachment_batch_limits(),
            },
        )
    }

    pub fn execute_composite_write_operation_on_branch_with_limits(
        &self,
        branch_id: String,
        operation_id: String,
        operation_kind: String,
        commands: Vec<MdbxWriteCommand>,
        attachment_commands: Vec<MdbxAttachmentBatchCommand>,
        limits: MdbxCompositeWriteOperationLimits,
    ) -> Result<MdbxCompositeWriteOperationResult, MdbxFfiError> {
        execute_composite_write_operation(
            self,
            CompositeWriteOperation {
                branch_id: Some(branch_id),
                operation_id,
                operation_kind,
                commands,
                attachment_commands,
                write_limits: limits.write_limits.into_internal()?,
                attachment_limits: limits.attachment_limits,
            },
        )
    }
}
