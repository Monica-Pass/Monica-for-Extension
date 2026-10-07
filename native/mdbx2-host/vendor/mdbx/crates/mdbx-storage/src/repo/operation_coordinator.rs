use std::collections::{BTreeSet, HashMap};
use std::io::{self, Write};

use mdbx_core::model::{ObjectTypeId, RelationKindId};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

use super::{
    AttachmentRepo, CommitChange, CommitContext, CommitOperation, EntryRepo,
    ObjectLabelAssignmentCreateRequest, ObjectLabelAssignmentRepo, ObjectLabelCreateRequest,
    ObjectLabelRepo, ObjectRelationCreateRequest, ObjectRelationRepo, OperationExecution,
    ProjectRepo,
};

pub const DEFAULT_MAX_WRITE_COMMANDS: usize = 256;
pub const HARD_MAX_WRITE_COMMANDS: usize = 4_096;
pub const DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND: usize = 1024 * 1024;
pub const HARD_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_WRITE_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
pub const HARD_MAX_WRITE_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub const DEFAULT_MAX_WRITE_INTENT_BYTES: usize = 16 * 1024 * 1024;
pub const HARD_MAX_WRITE_INTENT_BYTES: usize = 128 * 1024 * 1024;

/// One generic storage mutation within a finite user operation.
///
/// The serialized representation intentionally matches the MDBX2 UniFFI
/// command representation introduced before this native API. Raw payload JSON
/// remains part of the intent identity, including insignificant whitespace and
/// object-key order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WriteCommand {
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

impl WriteCommand {
    fn payload_json(&self) -> Option<&str> {
        match self {
            Self::CreateEntry { payload_json, .. }
            | Self::UpdateEntry { payload_json, .. }
            | Self::CreateObjectRelation { payload_json, .. }
            | Self::UpdateObjectRelation { payload_json, .. }
            | Self::CreateObjectLabel { payload_json, .. }
            | Self::UpdateObjectLabel { payload_json, .. } => Some(payload_json),
            Self::CreateProject { .. }
            | Self::CreateProjectWithParent { .. }
            | Self::RenameProject { .. }
            | Self::MoveProject { .. }
            | Self::DeleteProject { .. }
            | Self::RestoreProject { .. }
            | Self::DeleteEntry { .. }
            | Self::RestoreEntry { .. }
            | Self::MoveEntry { .. }
            | Self::DeleteObjectRelation { .. }
            | Self::DeleteObjectLabel { .. }
            | Self::AssignObjectLabel { .. }
            | Self::RemoveObjectLabelAssignment { .. } => None,
        }
    }
}

/// Resource contract for one native generic write operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteOperationLimits {
    pub max_commands: usize,
    pub max_payload_bytes_per_command: usize,
    pub max_payload_bytes: usize,
    pub max_intent_bytes: usize,
}

impl Default for WriteOperationLimits {
    fn default() -> Self {
        Self {
            max_commands: DEFAULT_MAX_WRITE_COMMANDS,
            max_payload_bytes_per_command: DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND,
            max_payload_bytes: DEFAULT_MAX_WRITE_PAYLOAD_BYTES,
            max_intent_bytes: DEFAULT_MAX_WRITE_INTENT_BYTES,
        }
    }
}

impl WriteOperationLimits {
    pub fn validate(self) -> StorageResult<()> {
        let checks = [
            ("max_commands", self.max_commands, HARD_MAX_WRITE_COMMANDS),
            (
                "max_payload_bytes_per_command",
                self.max_payload_bytes_per_command,
                HARD_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND,
            ),
            (
                "max_payload_bytes",
                self.max_payload_bytes,
                HARD_MAX_WRITE_PAYLOAD_BYTES,
            ),
            (
                "max_intent_bytes",
                self.max_intent_bytes,
                HARD_MAX_WRITE_INTENT_BYTES,
            ),
        ];
        for (name, value, hard_max) in checks {
            if value == 0 || value > hard_max {
                return Err(StorageError::Validation(format!(
                    "{name} must be between 1 and {hard_max}"
                )));
            }
        }
        if self.max_payload_bytes_per_command > self.max_payload_bytes {
            return Err(StorageError::Validation(
                "per-command payload limit cannot exceed total payload limit".to_string(),
            ));
        }
        Ok(())
    }
}

/// Native request representing one finite client intent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOperationRequest {
    operation_id: String,
    operation_kind: String,
    branch_id: Option<String>,
    commands: Vec<WriteCommand>,
    limits: WriteOperationLimits,
}

impl WriteOperationRequest {
    pub fn new(
        operation_id: impl Into<String>,
        operation_kind: impl Into<String>,
        commands: Vec<WriteCommand>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            operation_kind: operation_kind.into(),
            branch_id: None,
            commands,
            limits: WriteOperationLimits::default(),
        }
    }

    pub fn with_branch_id(mut self, branch_id: impl Into<String>) -> Self {
        self.branch_id = Some(branch_id.into());
        self
    }

    pub fn with_limits(mut self, limits: WriteOperationLimits) -> Self {
        self.limits = limits;
        self
    }
}

/// Validation and preparation failures that occur before the write
/// transaction, plus storage failures produced during execution.
#[derive(Debug, thiserror::Error)]
pub enum OperationCoordinatorError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("invalid object type ID: {object_type_id}")]
    InvalidObjectTypeId { object_type_id: String },
    #[error("invalid relation kind: {relation_kind}")]
    InvalidRelationKind { relation_kind: String },
}

/// Result returned to native callers after one operation execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOperationOutcome {
    pub commit_id: String,
    pub already_committed: bool,
    pub changed_objects: Vec<CommitChange>,
}

/// A fully checked write operation. Preparation is connection-independent and
/// can finish before a client acquires its vault mutex.
#[derive(Debug, Clone)]
pub struct PreparedWriteOperation {
    operation_id: String,
    operation_kind: String,
    branch_id: Option<String>,
    commands: Vec<PreparedWriteCommand>,
    intent_hash: Vec<u8>,
    changed_objects: Vec<CommitChange>,
    change_scope: String,
}

impl PreparedWriteOperation {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    pub fn operation_kind(&self) -> &str {
        &self.operation_kind
    }

    pub fn branch_id(&self) -> Option<&str> {
        self.branch_id.as_deref()
    }

    pub fn intent_hash(&self) -> &[u8] {
        &self.intent_hash
    }

    pub fn changed_objects(&self) -> &[CommitChange] {
        &self.changed_objects
    }

    pub fn change_scope(&self) -> &str {
        &self.change_scope
    }

    /// Apply the prepared mutations through an active operation context.
    /// Callers composing another command family retain ownership of the outer
    /// `CommitOperation` and transaction.
    pub fn apply(&self, conn: &VaultConnection, ctx: &CommitContext) -> StorageResult<()> {
        execute_prepared_commands(conn, ctx, &self.commands)
    }

    fn commit_operation(&self) -> CommitOperation {
        let mut operation = CommitOperation::new(
            self.operation_id.clone(),
            self.operation_kind.clone(),
            if self.branch_id.is_some() { "" } else { "main" },
            write_operation_commit_kind(&self.commands),
            self.change_scope.clone(),
            self.changed_objects.clone(),
        )
        .with_intent_hash(self.intent_hash.clone());
        if let Some(branch_id) = &self.branch_id {
            operation = operation.with_branch_id(branch_id.clone());
        }
        operation
    }
}

/// Resolve the semantic commit kind for a prepared generic write.
///
/// Most object mutations use the historical `change` kind. Entry restore and
/// move retain their dedicated repository kinds when they are the only
/// mutation in an operation. A finite operation that combines different
/// repository kinds uses the explicit aggregate `multi` kind so all commands
/// can share one commit without changing the operation identity during
/// execution.
fn write_operation_commit_kind(commands: &[PreparedWriteCommand]) -> String {
    let kinds = commands
        .iter()
        .map(PreparedWriteCommand::commit_kind)
        .collect::<BTreeSet<_>>();
    if kinds.len() == 1 {
        kinds
            .into_iter()
            .next()
            .expect("one commit kind must have one value")
            .to_string()
    } else {
        "multi".to_string()
    }
}

/// Coordinates bounded generic mutations into one idempotent commit.
pub struct OperationCoordinator;

impl OperationCoordinator {
    pub fn prepare(
        request: WriteOperationRequest,
    ) -> Result<PreparedWriteOperation, OperationCoordinatorError> {
        request.limits.validate()?;
        validate_request_identity(&request)?;
        validate_resource_usage(&request.commands, request.limits)?;

        let prepared_commands = request
            .commands
            .iter()
            .map(PreparedWriteCommand::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let intent_hash =
            hash_write_operation_intent(&request.commands, request.limits.max_intent_bytes)?;
        let changed_objects = write_operation_changes(&request.commands);
        let change_scope = write_operation_scope(&changed_objects);

        Ok(PreparedWriteOperation {
            operation_id: request.operation_id,
            operation_kind: request.operation_kind,
            branch_id: request.branch_id,
            commands: prepared_commands,
            intent_hash,
            changed_objects,
            change_scope,
        })
    }

    pub fn execute(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: WriteOperationRequest,
    ) -> Result<WriteOperationOutcome, OperationCoordinatorError> {
        let prepared = Self::prepare(request)?;
        Self::execute_prepared(conn, ctx, &prepared).map_err(Into::into)
    }

    pub fn execute_prepared(
        conn: &VaultConnection,
        ctx: &CommitContext,
        prepared: &PreparedWriteOperation,
    ) -> StorageResult<WriteOperationOutcome> {
        let execution = ctx.run_operation(conn, prepared.commit_operation(), |scoped| {
            prepared.apply(conn, scoped)
        })?;
        let (commit_id, already_committed) = match execution {
            OperationExecution::Applied { commit_id, .. } => (commit_id, false),
            OperationExecution::AlreadyCommitted { commit_id } => (commit_id, true),
        };
        Ok(WriteOperationOutcome {
            commit_id,
            already_committed,
            changed_objects: prepared.changed_objects.clone(),
        })
    }
}

fn validate_request_identity(request: &WriteOperationRequest) -> StorageResult<()> {
    if request.operation_id.trim().is_empty() {
        return Err(StorageError::Validation(
            "operation_id must not be empty".to_string(),
        ));
    }
    if request.operation_kind.trim().is_empty() {
        return Err(StorageError::Validation(
            "operation_kind must not be empty".to_string(),
        ));
    }
    if request
        .branch_id
        .as_deref()
        .is_some_and(|branch_id| branch_id.trim().is_empty())
    {
        return Err(StorageError::Validation(
            "branch_id must not be empty".to_string(),
        ));
    }
    if request.commands.is_empty() {
        return Err(StorageError::Validation(
            "write operation requires commands".to_string(),
        ));
    }
    Ok(())
}

fn validate_resource_usage(
    commands: &[WriteCommand],
    limits: WriteOperationLimits,
) -> StorageResult<()> {
    if commands.len() > limits.max_commands {
        return Err(StorageError::ResourceLimit {
            resource: "write operation commands".to_string(),
            actual: commands.len() as u64,
            limit: limits.max_commands as u64,
        });
    }
    let mut total_payload_bytes = 0usize;
    for command in commands {
        let Some(payload_json) = command.payload_json() else {
            continue;
        };
        let payload_bytes = payload_json.len();
        if payload_bytes > limits.max_payload_bytes_per_command {
            return Err(StorageError::ResourceLimit {
                resource: "write operation command payload bytes".to_string(),
                actual: payload_bytes as u64,
                limit: limits.max_payload_bytes_per_command as u64,
            });
        }
        total_payload_bytes = total_payload_bytes
            .checked_add(payload_bytes)
            .ok_or_else(|| StorageError::ResourceLimit {
                resource: "write operation payload bytes".to_string(),
                actual: u64::MAX,
                limit: limits.max_payload_bytes as u64,
            })?;
        if total_payload_bytes > limits.max_payload_bytes {
            return Err(StorageError::ResourceLimit {
                resource: "write operation payload bytes".to_string(),
                actual: total_payload_bytes as u64,
                limit: limits.max_payload_bytes as u64,
            });
        }
    }
    Ok(())
}

pub fn hash_write_operation_intent(
    commands: &[WriteCommand],
    limit: usize,
) -> Result<Vec<u8>, OperationCoordinatorError> {
    let mut writer = LimitedIntentHashWriter::new(limit);
    if let Err(error) = serde_json::to_writer(&mut writer, commands) {
        if let Some(actual) = writer.exceeded_at {
            return Err(StorageError::ResourceLimit {
                resource: "write operation serialized intent bytes".to_string(),
                actual: actual as u64,
                limit: limit as u64,
            }
            .into());
        }
        return Err(error.into());
    }
    Ok(writer.finalize())
}

struct LimitedIntentHashWriter {
    hasher: Sha256,
    bytes_written: usize,
    limit: usize,
    exceeded_at: Option<usize>,
}

impl LimitedIntentHashWriter {
    fn new(limit: usize) -> Self {
        Self {
            hasher: Sha256::new(),
            bytes_written: 0,
            limit,
            exceeded_at: None,
        }
    }

    fn finalize(self) -> Vec<u8> {
        self.hasher.finalize().to_vec()
    }
}

impl Write for LimitedIntentHashWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let actual = self
            .bytes_written
            .checked_add(buffer.len())
            .unwrap_or(usize::MAX);
        if actual > self.limit {
            self.exceeded_at = Some(actual);
            return Err(io::Error::other(
                "write operation serialized intent limit exceeded",
            ));
        }
        self.hasher.update(buffer);
        self.bytes_written = actual;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub fn write_operation_changes(commands: &[WriteCommand]) -> Vec<CommitChange> {
    let mut changes: Vec<CommitChange> = Vec::new();
    let mut change_indexes: HashMap<(&str, &str), usize> = HashMap::new();
    for command in commands {
        let (object_type, object_id, action, fields): (&str, &String, &str, &[&str]) = match command
        {
            WriteCommand::CreateProject { project_id, .. } => {
                ("project", project_id, "create", &["title"])
            }
            WriteCommand::CreateProjectWithParent { project_id, .. } => {
                ("project", project_id, "create", &["title", "group_id"])
            }
            WriteCommand::RenameProject { project_id, .. } => {
                ("project", project_id, "update", &["title"])
            }
            WriteCommand::MoveProject { project_id, .. } => {
                ("project", project_id, "move", &["group_id"])
            }
            WriteCommand::DeleteProject { project_id } => {
                ("project", project_id, "delete", &["deleted"])
            }
            WriteCommand::RestoreProject { project_id, .. } => {
                ("project", project_id, "restore", &["deleted", "group_id"])
            }
            WriteCommand::CreateEntry { entry_id, .. } => (
                "entry",
                entry_id,
                "create",
                &["project_id", "entry_type", "title", "payload"],
            ),
            WriteCommand::UpdateEntry { entry_id, .. } => {
                ("entry", entry_id, "update", &["title", "payload"])
            }
            WriteCommand::DeleteEntry { entry_id, .. } => {
                ("entry", entry_id, "delete", &["deleted"])
            }
            WriteCommand::RestoreEntry { entry_id, .. } => {
                ("entry", entry_id, "restore", &["deleted"])
            }
            WriteCommand::MoveEntry { entry_id, .. } => {
                ("entry", entry_id, "move", &["project_id"])
            }
            WriteCommand::CreateObjectRelation { relation_id, .. } => (
                "object-relation",
                relation_id,
                "create",
                &[
                    "source_object_id",
                    "target_object_id",
                    "relation_kind",
                    "payload",
                    "payload_schema_version",
                ],
            ),
            WriteCommand::UpdateObjectRelation { relation_id, .. } => (
                "object-relation",
                relation_id,
                "update",
                &["relation_kind", "payload", "payload_schema_version"],
            ),
            WriteCommand::DeleteObjectRelation { relation_id } => {
                ("object-relation", relation_id, "delete", &["deleted"])
            }
            WriteCommand::CreateObjectLabel { label_id, .. } => (
                "object-label",
                label_id,
                "create",
                &["collection_id", "name", "payload", "payload_schema_version"],
            ),
            WriteCommand::UpdateObjectLabel { label_id, .. } => (
                "object-label",
                label_id,
                "update",
                &["name", "payload", "payload_schema_version"],
            ),
            WriteCommand::DeleteObjectLabel { label_id } => {
                ("object-label", label_id, "delete", &["deleted"])
            }
            WriteCommand::AssignObjectLabel { assignment_id, .. } => (
                "object-label-assignment",
                assignment_id,
                "create",
                &["object_id", "label_id"],
            ),
            WriteCommand::RemoveObjectLabelAssignment { assignment_id } => (
                "object-label-assignment",
                assignment_id,
                "delete",
                &["deleted"],
            ),
        };
        let incoming = CommitChange {
            object_type: object_type.to_string(),
            object_id: object_id.clone(),
            action: action.to_string(),
            fields: fields.iter().map(|field| (*field).to_string()).collect(),
        };
        let key = (object_type, object_id.as_str());
        if let Some(existing_index) = change_indexes.get(&key).copied() {
            let existing = &mut changes[existing_index];
            if existing.action != incoming.action {
                existing.action = "change".to_string();
            }
            for field in incoming.fields {
                if !existing.fields.contains(&field) {
                    existing.fields.push(field);
                }
            }
        } else {
            change_indexes.insert(key, changes.len());
            changes.push(incoming);
        }
    }
    changes
}

pub fn write_operation_scope(changes: &[CommitChange]) -> String {
    let Some(first) = changes.first() else {
        return "multi".to_string();
    };
    if changes
        .iter()
        .all(|change| change.object_type == first.object_type)
    {
        first.object_type.clone()
    } else {
        "multi".to_string()
    }
}

#[derive(Debug, Clone)]
enum PreparedWriteCommand {
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
        entry_type: ObjectTypeId,
        title: String,
        payload: serde_json::Value,
    },
    UpdateEntry {
        entry_id: String,
        project_id: String,
        entry_type: ObjectTypeId,
        title: String,
        payload: serde_json::Value,
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
        relation_kind: RelationKindId,
        payload: serde_json::Value,
        payload_schema_version: u32,
    },
    UpdateObjectRelation {
        relation_id: String,
        relation_kind: RelationKindId,
        payload: serde_json::Value,
        payload_schema_version: u32,
    },
    DeleteObjectRelation {
        relation_id: String,
    },
    CreateObjectLabel {
        label_id: String,
        collection_id: String,
        name: String,
        payload: serde_json::Value,
        payload_schema_version: u32,
    },
    UpdateObjectLabel {
        label_id: String,
        name: String,
        payload: serde_json::Value,
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

impl PreparedWriteCommand {
    fn commit_kind(&self) -> &'static str {
        match self {
            Self::RestoreProject { .. } | Self::RestoreEntry { .. } => "restore",
            Self::MoveProject { .. } | Self::MoveEntry { .. } => "move",
            Self::CreateProject { .. }
            | Self::CreateProjectWithParent { .. }
            | Self::RenameProject { .. }
            | Self::DeleteProject { .. }
            | Self::CreateEntry { .. }
            | Self::UpdateEntry { .. }
            | Self::DeleteEntry { .. }
            | Self::CreateObjectRelation { .. }
            | Self::UpdateObjectRelation { .. }
            | Self::DeleteObjectRelation { .. }
            | Self::CreateObjectLabel { .. }
            | Self::UpdateObjectLabel { .. }
            | Self::DeleteObjectLabel { .. }
            | Self::AssignObjectLabel { .. }
            | Self::RemoveObjectLabelAssignment { .. } => "change",
        }
    }
}

impl TryFrom<&WriteCommand> for PreparedWriteCommand {
    type Error = OperationCoordinatorError;

    fn try_from(command: &WriteCommand) -> Result<Self, Self::Error> {
        match command {
            WriteCommand::CreateProject { project_id, title } => {
                validate_uuid(project_id, "project_id")?;
                Ok(Self::CreateProject {
                    project_id: project_id.clone(),
                    title: title.clone(),
                })
            }
            WriteCommand::CreateProjectWithParent {
                project_id,
                title,
                parent_project_id,
            } => {
                validate_uuid(project_id, "project_id")?;
                validate_project_title(title)?;
                validate_optional_uuid(parent_project_id.as_deref(), "parent_project_id")?;
                Ok(Self::CreateProjectWithParent {
                    project_id: project_id.clone(),
                    title: title.trim().to_string(),
                    parent_project_id: parent_project_id.clone(),
                })
            }
            WriteCommand::RenameProject { project_id, title } => {
                validate_uuid(project_id, "project_id")?;
                validate_project_title(title)?;
                Ok(Self::RenameProject {
                    project_id: project_id.clone(),
                    title: title.trim().to_string(),
                })
            }
            WriteCommand::MoveProject {
                project_id,
                parent_project_id,
            } => {
                validate_uuid(project_id, "project_id")?;
                validate_optional_uuid(parent_project_id.as_deref(), "parent_project_id")?;
                Ok(Self::MoveProject {
                    project_id: project_id.clone(),
                    parent_project_id: parent_project_id.clone(),
                })
            }
            WriteCommand::DeleteProject { project_id } => {
                validate_uuid(project_id, "project_id")?;
                Ok(Self::DeleteProject {
                    project_id: project_id.clone(),
                })
            }
            WriteCommand::RestoreProject {
                project_id,
                parent_project_id,
            } => {
                validate_uuid(project_id, "project_id")?;
                validate_optional_uuid(parent_project_id.as_deref(), "parent_project_id")?;
                Ok(Self::RestoreProject {
                    project_id: project_id.clone(),
                    parent_project_id: parent_project_id.clone(),
                })
            }
            WriteCommand::CreateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload_json,
            } => {
                validate_uuid(entry_id, "entry_id")?;
                validate_uuid(project_id, "project_id")?;
                Ok(Self::CreateEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                    entry_type: parse_object_type_id(entry_type)?,
                    title: title.clone(),
                    payload: mdbx_core::json::from_str(payload_json)?,
                })
            }
            WriteCommand::UpdateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload_json,
            } => {
                validate_uuid(entry_id, "entry_id")?;
                validate_uuid(project_id, "project_id")?;
                Ok(Self::UpdateEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                    entry_type: parse_object_type_id(entry_type)?,
                    title: title.clone(),
                    payload: mdbx_core::json::from_str(payload_json)?,
                })
            }
            WriteCommand::DeleteEntry {
                entry_id,
                project_id,
            } => {
                validate_uuid(entry_id, "entry_id")?;
                validate_uuid(project_id, "project_id")?;
                Ok(Self::DeleteEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                })
            }
            WriteCommand::RestoreEntry {
                entry_id,
                project_id,
            } => {
                validate_uuid(entry_id, "entry_id")?;
                validate_uuid(project_id, "project_id")?;
                Ok(Self::RestoreEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                })
            }
            WriteCommand::MoveEntry {
                entry_id,
                project_id,
                target_project_id,
            } => {
                validate_uuid(entry_id, "entry_id")?;
                validate_uuid(project_id, "project_id")?;
                validate_uuid(target_project_id, "target_project_id")?;
                Ok(Self::MoveEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                    target_project_id: target_project_id.clone(),
                })
            }
            WriteCommand::CreateObjectRelation {
                relation_id,
                source_object_id,
                target_object_id,
                relation_kind,
                payload_json,
                payload_schema_version,
            } => {
                validate_uuid(relation_id, "relation_id")?;
                validate_uuid(source_object_id, "source_object_id")?;
                validate_uuid(target_object_id, "target_object_id")?;
                if source_object_id == target_object_id {
                    return Err(StorageError::Validation(
                        "self relations require an explicit adapter object instead of an identity edge"
                            .to_string(),
                    )
                    .into());
                }
                let relation_kind = parse_relation_kind(relation_kind)?;
                validate_payload_schema_version(*payload_schema_version)?;
                Ok(Self::CreateObjectRelation {
                    relation_id: relation_id.clone(),
                    source_object_id: source_object_id.clone(),
                    target_object_id: target_object_id.clone(),
                    relation_kind,
                    payload: mdbx_core::json::from_str(payload_json)?,
                    payload_schema_version: *payload_schema_version,
                })
            }
            WriteCommand::UpdateObjectRelation {
                relation_id,
                relation_kind,
                payload_json,
                payload_schema_version,
            } => {
                validate_uuid(relation_id, "relation_id")?;
                let relation_kind = parse_relation_kind(relation_kind)?;
                validate_payload_schema_version(*payload_schema_version)?;
                Ok(Self::UpdateObjectRelation {
                    relation_id: relation_id.clone(),
                    relation_kind,
                    payload: mdbx_core::json::from_str(payload_json)?,
                    payload_schema_version: *payload_schema_version,
                })
            }
            WriteCommand::DeleteObjectRelation { relation_id } => {
                validate_uuid(relation_id, "relation_id")?;
                Ok(Self::DeleteObjectRelation {
                    relation_id: relation_id.clone(),
                })
            }
            WriteCommand::CreateObjectLabel {
                label_id,
                collection_id,
                name,
                payload_json,
                payload_schema_version,
            } => {
                validate_uuid(label_id, "label_id")?;
                validate_uuid(collection_id, "collection_id")?;
                validate_label_name(name)?;
                validate_payload_schema_version(*payload_schema_version)?;
                Ok(Self::CreateObjectLabel {
                    label_id: label_id.clone(),
                    collection_id: collection_id.clone(),
                    name: name.clone(),
                    payload: mdbx_core::json::from_str(payload_json)?,
                    payload_schema_version: *payload_schema_version,
                })
            }
            WriteCommand::UpdateObjectLabel {
                label_id,
                name,
                payload_json,
                payload_schema_version,
            } => {
                validate_uuid(label_id, "label_id")?;
                validate_label_name(name)?;
                validate_payload_schema_version(*payload_schema_version)?;
                Ok(Self::UpdateObjectLabel {
                    label_id: label_id.clone(),
                    name: name.clone(),
                    payload: mdbx_core::json::from_str(payload_json)?,
                    payload_schema_version: *payload_schema_version,
                })
            }
            WriteCommand::DeleteObjectLabel { label_id } => {
                validate_uuid(label_id, "label_id")?;
                Ok(Self::DeleteObjectLabel {
                    label_id: label_id.clone(),
                })
            }
            WriteCommand::AssignObjectLabel {
                assignment_id,
                object_id,
                label_id,
            } => {
                validate_uuid(assignment_id, "assignment_id")?;
                validate_uuid(object_id, "object_id")?;
                validate_uuid(label_id, "label_id")?;
                Ok(Self::AssignObjectLabel {
                    assignment_id: assignment_id.clone(),
                    object_id: object_id.clone(),
                    label_id: label_id.clone(),
                })
            }
            WriteCommand::RemoveObjectLabelAssignment { assignment_id } => {
                validate_uuid(assignment_id, "assignment_id")?;
                Ok(Self::RemoveObjectLabelAssignment {
                    assignment_id: assignment_id.clone(),
                })
            }
        }
    }
}

fn validate_uuid(value: &str, field: &str) -> StorageResult<()> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| StorageError::Validation(format!("{field} {value} must be a UUID")))
}

fn validate_optional_uuid(value: Option<&str>, field: &str) -> StorageResult<()> {
    if let Some(value) = value {
        validate_uuid(value, field)?;
    }
    Ok(())
}

fn validate_project_title(value: &str) -> StorageResult<()> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4_096 {
        return Err(StorageError::Validation(
            "project title must contain 1 to 4096 UTF-8 bytes".to_string(),
        ));
    }
    Ok(())
}

fn parse_object_type_id(value: &str) -> Result<ObjectTypeId, OperationCoordinatorError> {
    value
        .parse()
        .map_err(|_| OperationCoordinatorError::InvalidObjectTypeId {
            object_type_id: value.to_string(),
        })
}

fn parse_relation_kind(value: &str) -> Result<RelationKindId, OperationCoordinatorError> {
    value
        .parse()
        .map_err(|_| OperationCoordinatorError::InvalidRelationKind {
            relation_kind: value.to_string(),
        })
}

fn validate_payload_schema_version(value: u32) -> StorageResult<()> {
    if value == 0 {
        return Err(StorageError::Validation(
            "payload_schema_version must be greater than zero".to_string(),
        ));
    }
    Ok(())
}

fn validate_label_name(value: &str) -> StorageResult<()> {
    if value.trim().is_empty() || value.len() > 512 {
        return Err(StorageError::Validation(
            "object label name must contain 1 to 512 UTF-8 bytes".to_string(),
        ));
    }
    Ok(())
}

fn execute_prepared_commands(
    conn: &VaultConnection,
    ctx: &CommitContext,
    commands: &[PreparedWriteCommand],
) -> StorageResult<()> {
    for command in commands {
        match command {
            PreparedWriteCommand::CreateProject { project_id, title } => {
                ProjectRepo::create_with_id(conn, ctx, project_id, title, None, None)?;
            }
            PreparedWriteCommand::CreateProjectWithParent {
                project_id,
                title,
                parent_project_id,
            } => {
                validate_project_parent(conn, project_id, parent_project_id.as_deref())?;
                ensure_unique_project_title(conn, None, parent_project_id.as_deref(), title)?;
                ProjectRepo::create_with_id(
                    conn,
                    ctx,
                    project_id,
                    title,
                    parent_project_id.as_deref(),
                    None,
                )?;
            }
            PreparedWriteCommand::RenameProject { project_id, title } => {
                let mut project = active_project(conn, project_id)?;
                ensure_unique_project_title(
                    conn,
                    Some(project_id),
                    project.group_id.as_deref(),
                    title,
                )?;
                project.title_ct = title.as_bytes().to_vec();
                ProjectRepo::update(conn, ctx, &project)?;
            }
            PreparedWriteCommand::MoveProject {
                project_id,
                parent_project_id,
            } => {
                let project = active_project(conn, project_id)?;
                validate_project_parent(conn, project_id, parent_project_id.as_deref())?;
                ensure_unique_project_title(
                    conn,
                    Some(project_id),
                    parent_project_id.as_deref(),
                    &String::from_utf8_lossy(&project.title_ct),
                )?;
                ProjectRepo::move_to_group(conn, ctx, project_id, parent_project_id.as_deref())?;
            }
            PreparedWriteCommand::DeleteProject { project_id } => {
                active_project(conn, project_id)?;
                ensure_project_empty(conn, project_id)?;
                ProjectRepo::soft_delete(conn, ctx, project_id)?;
            }
            PreparedWriteCommand::RestoreProject {
                project_id,
                parent_project_id,
            } => {
                let project = ProjectRepo::get_by_id(conn, project_id)?
                    .ok_or_else(|| StorageError::NotFound(project_id.clone()))?;
                if !project.deleted {
                    return Err(StorageError::ConstraintViolation(format!(
                        "project {project_id} is not deleted"
                    )));
                }
                validate_project_parent(conn, project_id, parent_project_id.as_deref())?;
                ensure_unique_project_title(
                    conn,
                    Some(project_id),
                    parent_project_id.as_deref(),
                    &String::from_utf8_lossy(&project.title_ct),
                )?;
                ProjectRepo::restore(conn, ctx, project_id, parent_project_id.as_deref())?;
            }
            PreparedWriteCommand::CreateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload,
            } => {
                EntryRepo::create_with_id(
                    conn,
                    ctx,
                    entry_id,
                    project_id,
                    entry_type.clone(),
                    Some(title),
                    payload,
                )?;
            }
            PreparedWriteCommand::UpdateEntry {
                entry_id,
                project_id,
                entry_type,
                title,
                payload,
            } => {
                let mut entry = entry_for_project(conn, project_id, entry_id)?;
                if entry.deleted || entry.entry_type != *entry_type {
                    return Err(StorageError::ConstraintViolation(format!(
                        "entry {entry_id} cannot be updated"
                    )));
                }
                entry.title_ct = Some(title.as_bytes().to_vec());
                entry.payload_ct = serde_json::to_vec(payload)
                    .map_err(|error| StorageError::Validation(error.to_string()))?;
                EntryRepo::update_loaded_in_transaction(conn, ctx, &entry)?;
            }
            PreparedWriteCommand::DeleteEntry {
                entry_id,
                project_id,
            } => {
                let entry = entry_for_project(conn, project_id, entry_id)?;
                EntryRepo::soft_delete_loaded_in_transaction(conn, ctx, &entry)?;
            }
            PreparedWriteCommand::RestoreEntry {
                entry_id,
                project_id,
            } => {
                entry_for_project(conn, project_id, entry_id)?;
                EntryRepo::restore(conn, ctx, entry_id)?;
            }
            PreparedWriteCommand::MoveEntry {
                entry_id,
                project_id,
                target_project_id,
            } => {
                entry_for_project(conn, project_id, entry_id)?;
                EntryRepo::move_to_project(conn, ctx, entry_id, target_project_id)?;
            }
            PreparedWriteCommand::CreateObjectRelation {
                relation_id,
                source_object_id,
                target_object_id,
                relation_kind,
                payload,
                payload_schema_version,
            } => {
                ObjectRelationRepo::create(
                    conn,
                    ctx,
                    ObjectRelationCreateRequest::new(
                        source_object_id,
                        target_object_id,
                        relation_kind.clone(),
                        payload.clone(),
                    )
                    .with_relation_id(relation_id)
                    .with_payload_schema_version(*payload_schema_version),
                )?;
            }
            PreparedWriteCommand::UpdateObjectRelation {
                relation_id,
                relation_kind,
                payload,
                payload_schema_version,
            } => {
                let mut relation = ObjectRelationRepo::get_by_id(conn, relation_id)?
                    .ok_or_else(|| StorageError::NotFound(relation_id.clone()))?;
                relation.relation_kind = relation_kind.clone();
                relation.payload_ct = serde_json::to_vec(payload)
                    .map_err(|error| StorageError::Validation(error.to_string()))?;
                relation.payload_schema_version = *payload_schema_version;
                ObjectRelationRepo::update(conn, ctx, &relation)?;
            }
            PreparedWriteCommand::DeleteObjectRelation { relation_id } => {
                ObjectRelationRepo::soft_delete(conn, ctx, relation_id)?;
            }
            PreparedWriteCommand::CreateObjectLabel {
                label_id,
                collection_id,
                name,
                payload,
                payload_schema_version,
            } => {
                ObjectLabelRepo::create(
                    conn,
                    ctx,
                    ObjectLabelCreateRequest::new(collection_id, name, payload.clone())
                        .with_label_id(label_id)
                        .with_payload_schema_version(*payload_schema_version),
                )?;
            }
            PreparedWriteCommand::UpdateObjectLabel {
                label_id,
                name,
                payload,
                payload_schema_version,
            } => {
                let mut label = ObjectLabelRepo::get_by_id(conn, label_id)?
                    .ok_or_else(|| StorageError::NotFound(label_id.clone()))?;
                label.name_ct = name.as_bytes().to_vec();
                label.payload_ct = serde_json::to_vec(payload)
                    .map_err(|error| StorageError::Validation(error.to_string()))?;
                label.payload_schema_version = *payload_schema_version;
                ObjectLabelRepo::update(conn, ctx, &label)?;
            }
            PreparedWriteCommand::DeleteObjectLabel { label_id } => {
                ObjectLabelRepo::soft_delete(conn, ctx, label_id)?;
            }
            PreparedWriteCommand::AssignObjectLabel {
                assignment_id,
                object_id,
                label_id,
            } => {
                ObjectLabelAssignmentRepo::create(
                    conn,
                    ctx,
                    ObjectLabelAssignmentCreateRequest::new(object_id, label_id)
                        .with_assignment_id(assignment_id),
                )?;
            }
            PreparedWriteCommand::RemoveObjectLabelAssignment { assignment_id } => {
                ObjectLabelAssignmentRepo::soft_delete(conn, ctx, assignment_id)?;
            }
        }
    }
    Ok(())
}

fn entry_for_project(
    conn: &VaultConnection,
    project_id: &str,
    entry_id: &str,
) -> StorageResult<mdbx_core::model::Entry> {
    let entry = EntryRepo::get_by_id(conn, entry_id)?
        .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;
    if entry.project_id != project_id {
        return Err(StorageError::ConstraintViolation(format!(
            "entry {entry_id} does not belong to project {project_id}"
        )));
    }
    Ok(entry)
}

fn active_project(
    conn: &VaultConnection,
    project_id: &str,
) -> StorageResult<mdbx_core::model::Project> {
    let project = ProjectRepo::get_by_id(conn, project_id)?
        .ok_or_else(|| StorageError::NotFound(project_id.to_string()))?;
    if project.deleted {
        return Err(StorageError::ConstraintViolation(format!(
            "project {project_id} is deleted"
        )));
    }
    Ok(project)
}

fn validate_project_parent(
    conn: &VaultConnection,
    project_id: &str,
    parent_project_id: Option<&str>,
) -> StorageResult<()> {
    let Some(parent_project_id) = parent_project_id else {
        return Ok(());
    };
    if parent_project_id == project_id {
        return Err(StorageError::ConstraintViolation(
            "a project cannot be its own parent".to_string(),
        ));
    }

    let mut current = Some(parent_project_id.to_string());
    let mut visited = BTreeSet::new();
    while let Some(current_id) = current {
        if current_id == project_id {
            return Err(StorageError::ConstraintViolation(
                "moving the project would create a hierarchy cycle".to_string(),
            ));
        }
        if !visited.insert(current_id.clone()) {
            return Err(StorageError::ConstraintViolation(
                "the existing project hierarchy contains a cycle".to_string(),
            ));
        }
        let parent = ProjectRepo::get_by_id(conn, &current_id)?
            .ok_or_else(|| StorageError::NotFound(format!("parent project {current_id}")))?;
        if parent.deleted {
            return Err(StorageError::ConstraintViolation(format!(
                "parent project {current_id} is deleted"
            )));
        }
        current = parent.group_id;
    }
    Ok(())
}

fn ensure_unique_project_title(
    conn: &VaultConnection,
    excluded_project_id: Option<&str>,
    parent_project_id: Option<&str>,
    title: &str,
) -> StorageResult<()> {
    let normalized = title.trim();
    let duplicate = ProjectRepo::list_all(conn)?.into_iter().any(|project| {
        project.group_id.as_deref() == parent_project_id
            && excluded_project_id != Some(project.project_id.as_str())
            && String::from_utf8_lossy(&project.title_ct).eq_ignore_ascii_case(normalized)
    });
    if duplicate {
        return Err(StorageError::ConstraintViolation(format!(
            "a project named {normalized} already exists under the selected parent"
        )));
    }
    Ok(())
}

fn ensure_project_empty(conn: &VaultConnection, project_id: &str) -> StorageResult<()> {
    if ProjectRepo::list_all(conn)?
        .iter()
        .any(|project| project.group_id.as_deref() == Some(project_id))
    {
        return Err(StorageError::ConstraintViolation(
            "a project with active child projects cannot be deleted".to_string(),
        ));
    }
    if !EntryRepo::list_by_project(conn, project_id)?.is_empty() {
        return Err(StorageError::ConstraintViolation(
            "a project with active entries cannot be deleted".to_string(),
        ));
    }
    if !AttachmentRepo::list_by_project(conn, project_id)?.is_empty() {
        return Err(StorageError::ConstraintViolation(
            "a project with active attachments cannot be deleted".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use rusqlite::params;

    use crate::init::{initialize_vault, VaultInitParams};

    use super::*;

    fn setup() -> (VaultConnection, CommitContext, String) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let initialized = initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        (
            conn,
            CommitContext::new("native-operation-device".to_string()),
            initialized.branch_id,
        )
    }

    fn count(conn: &VaultConnection, table: &str) -> i64 {
        conn.inner()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    #[test]
    fn command_serialization_and_hash_preserve_the_historical_ffi_intent() {
        let commands = vec![WriteCommand::CreateEntry {
            entry_id: "00000000-0000-4000-8000-000000000001".to_string(),
            project_id: "00000000-0000-4000-8000-000000000002".to_string(),
            entry_type: "com.monica.mail.message".to_string(),
            title: "Message".to_string(),
            payload_json: "{ \"body\" : \"kept verbatim\" }".to_string(),
        }];
        let encoded = serde_json::to_vec(&commands).unwrap();
        assert_eq!(
            String::from_utf8(encoded.clone()).unwrap(),
            r#"[{"kind":"create-entry","entry_id":"00000000-0000-4000-8000-000000000001","project_id":"00000000-0000-4000-8000-000000000002","entry_type":"com.monica.mail.message","title":"Message","payload_json":"{ \"body\" : \"kept verbatim\" }"}]"#
        );
        assert_eq!(
            hash_write_operation_intent(&commands, encoded.len()).unwrap(),
            Sha256::digest(&encoded).to_vec()
        );
        assert!(hash_write_operation_intent(&commands, encoded.len() - 1)
            .unwrap_err()
            .to_string()
            .contains("serialized intent bytes"));
    }

    #[test]
    fn change_summary_coalesces_fields_in_first_seen_object_order() {
        let first_entry = "00000000-0000-4000-8000-000000000060".to_string();
        let second_entry = "00000000-0000-4000-8000-000000000061".to_string();
        let project_id = "00000000-0000-4000-8000-000000000062".to_string();
        let changes = write_operation_changes(&[
            WriteCommand::CreateEntry {
                entry_id: first_entry.clone(),
                project_id: project_id.clone(),
                entry_type: "login".to_string(),
                title: "First".to_string(),
                payload_json: "{}".to_string(),
            },
            WriteCommand::CreateProject {
                project_id: project_id.clone(),
                title: "Project".to_string(),
            },
            WriteCommand::UpdateEntry {
                entry_id: first_entry.clone(),
                project_id: project_id.clone(),
                entry_type: "login".to_string(),
                title: "Updated".to_string(),
                payload_json: "{}".to_string(),
            },
            WriteCommand::DeleteEntry {
                entry_id: first_entry.clone(),
                project_id: project_id.clone(),
            },
            WriteCommand::UpdateEntry {
                entry_id: second_entry.clone(),
                project_id: project_id.clone(),
                entry_type: "login".to_string(),
                title: "Second".to_string(),
                payload_json: "{}".to_string(),
            },
        ]);

        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].object_type, "entry");
        assert_eq!(changes[0].object_id, first_entry);
        assert_eq!(changes[0].action, "change");
        assert_eq!(
            changes[0].fields,
            vec!["project_id", "entry_type", "title", "payload", "deleted"]
        );
        assert_eq!(changes[1].object_type, "project");
        assert_eq!(changes[1].object_id, project_id);
        assert_eq!(changes[2].object_type, "entry");
        assert_eq!(changes[2].object_id, second_entry);
    }

    #[test]
    fn batch_update_delete_preserves_versions_tombstone_and_exact_retry() {
        let (conn, ctx, _) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "Batch semantics", None, None).unwrap();
        let updated_entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            ObjectTypeId::Login,
            Some("Before update"),
            &serde_json::json!({"revision": 0}),
        )
        .unwrap();
        let deleted_entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            ObjectTypeId::Login,
            Some("Before delete"),
            &serde_json::json!({"revision": 0}),
        )
        .unwrap();
        let commits_before = count(&conn, "commits");
        let request = WriteOperationRequest::new(
            "native-batch-update-delete-semantics",
            "batch-update-delete",
            vec![
                WriteCommand::UpdateEntry {
                    entry_id: updated_entry.entry_id.clone(),
                    project_id: project.project_id.clone(),
                    entry_type: "login".to_string(),
                    title: "After update".to_string(),
                    payload_json: r#"{"revision":1}"#.to_string(),
                },
                WriteCommand::DeleteEntry {
                    entry_id: deleted_entry.entry_id.clone(),
                    project_id: project.project_id.clone(),
                },
            ],
        );

        let first = OperationCoordinator::execute(&conn, &ctx, request.clone()).unwrap();
        assert!(!first.already_committed);
        assert_eq!(count(&conn, "commits"), commits_before + 1);
        let updated = EntryRepo::get_by_id(&conn, &updated_entry.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(updated.title_ct, Some(b"After update".to_vec()));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&updated.payload_ct).unwrap(),
            serde_json::json!({"revision": 1})
        );
        assert_eq!(updated.head_commit_id, first.commit_id);
        let deleted = EntryRepo::get_by_id(&conn, &deleted_entry.entry_id)
            .unwrap()
            .unwrap();
        assert!(deleted.deleted);
        assert_eq!(deleted.head_commit_id, first.commit_id);
        assert_eq!(
            conn.inner()
                .query_row(
                    "SELECT COUNT(*) FROM tombstones
                     WHERE target_object_type = 'entry' AND target_object_id = ?1
                           AND delete_commit_id = ?2",
                    params![deleted_entry.entry_id, first.commit_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            conn.inner()
                .query_row(
                    "SELECT COUNT(*) FROM object_versions WHERE commit_id = ?1",
                    params![first.commit_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );

        let retry = OperationCoordinator::execute(&conn, &ctx, request).unwrap();
        assert!(retry.already_committed);
        assert_eq!(retry.commit_id, first.commit_id);
        assert_eq!(count(&conn, "commits"), commits_before + 1);
    }

    #[test]
    fn preparation_enforces_resource_limits_before_parsing_commands() {
        let request = WriteOperationRequest::new(
            "bounded-native-operation",
            "mail-import",
            vec![WriteCommand::CreateEntry {
                entry_id: "not-a-uuid".to_string(),
                project_id: "also-not-a-uuid".to_string(),
                entry_type: "invalid type".to_string(),
                title: "Oversized".to_string(),
                payload_json: "12345".to_string(),
            }],
        )
        .with_limits(WriteOperationLimits {
            max_commands: 1,
            max_payload_bytes_per_command: 4,
            max_payload_bytes: 4,
            max_intent_bytes: 4096,
        });

        let error = OperationCoordinator::prepare(request).unwrap_err();
        assert!(matches!(
            error,
            OperationCoordinatorError::Storage(StorageError::ResourceLimit { ref resource, .. })
                if resource == "write operation command payload bytes"
        ));
    }

    #[test]
    fn native_operation_is_atomic_single_commit_and_idempotent() {
        let (conn, ctx, _) = setup();
        let commits_before = count(&conn, "commits");
        let project_id = "00000000-0000-4000-8000-000000000010".to_string();
        let entry_id = "00000000-0000-4000-8000-000000000011".to_string();
        let operation_id = "native-mail-import".to_string();
        let commands = vec![
            WriteCommand::CreateProject {
                project_id: project_id.clone(),
                title: "Mail".to_string(),
            },
            WriteCommand::CreateEntry {
                entry_id: entry_id.clone(),
                project_id: project_id.clone(),
                entry_type: "com.monica.mail.message".to_string(),
                title: "Message".to_string(),
                payload_json: r#"{"body":"native"}"#.to_string(),
            },
        ];
        let request =
            WriteOperationRequest::new(operation_id.clone(), "mail-import", commands.clone());

        let first = OperationCoordinator::execute(&conn, &ctx, request.clone()).unwrap();
        assert!(!first.already_committed);
        assert_eq!(count(&conn, "commits"), commits_before + 1);
        assert_eq!(
            EntryRepo::get_by_id(&conn, &entry_id)
                .unwrap()
                .unwrap()
                .head_commit_id,
            first.commit_id
        );

        let retry = OperationCoordinator::execute(&conn, &ctx, request).unwrap();
        assert!(retry.already_committed);
        assert_eq!(retry.commit_id, first.commit_id);
        assert_eq!(count(&conn, "commits"), commits_before + 1);

        let changed = WriteOperationRequest::new(
            operation_id,
            "mail-import",
            vec![WriteCommand::CreateProject {
                project_id,
                title: "Changed".to_string(),
            }],
        );
        assert!(OperationCoordinator::execute(&conn, &ctx, changed)
            .unwrap_err()
            .to_string()
            .contains("reused for a different operation"));
    }

    #[test]
    fn restore_then_update_uses_one_stable_multi_kind_commit() {
        let (conn, ctx, _) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "Restore target", None, None).unwrap();
        let object_type = ObjectTypeId::custom("com.monica.test.restorable").unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            object_type.clone(),
            Some("Before restore"),
            &serde_json::json!({"state": "before"}),
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &entry.entry_id).unwrap();
        let commits_before = count(&conn, "commits");
        let request = WriteOperationRequest::new(
            "native-restore-update",
            "restore-update",
            vec![
                WriteCommand::RestoreEntry {
                    entry_id: entry.entry_id.clone(),
                    project_id: project.project_id.clone(),
                },
                WriteCommand::UpdateEntry {
                    entry_id: entry.entry_id.clone(),
                    project_id: project.project_id.clone(),
                    entry_type: object_type.to_string(),
                    title: "After restore".to_string(),
                    payload_json: r#"{"state":"after"}"#.to_string(),
                },
            ],
        );

        let first = OperationCoordinator::execute(&conn, &ctx, request.clone()).unwrap();
        assert!(!first.already_committed);
        assert_eq!(count(&conn, "commits"), commits_before + 1);
        let stored_kind: String = conn
            .inner()
            .query_row(
                "SELECT commit_kind FROM commits WHERE commit_id = ?1",
                params![first.commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_kind, "multi");
        let restored = EntryRepo::get_by_id(&conn, &entry.entry_id)
            .unwrap()
            .unwrap();
        assert!(!restored.deleted);
        assert_eq!(restored.title_ct, Some(b"After restore".to_vec()));

        let retry = OperationCoordinator::execute(&conn, &ctx, request).unwrap();
        assert!(retry.already_committed);
        assert_eq!(retry.commit_id, first.commit_id);
        assert_eq!(count(&conn, "commits"), commits_before + 1);
    }

    #[test]
    fn entry_move_relocates_attachments_in_one_replayable_commit_and_rolls_back_failures() {
        let (conn, ctx, _) = setup();
        let source = ProjectRepo::create(&conn, &ctx, "Source", None, None).unwrap();
        let target = ProjectRepo::create(&conn, &ctx, "Target", None, None).unwrap();
        let entry = EntryRepo::create(&conn, &ctx, &source.project_id,
            ObjectTypeId::custom("com.monica.test.movable").unwrap(), Some("Move"), &serde_json::json!({})).unwrap();
        let mut attachments = Vec::new();
        for name in ["first.bin", "second.bin"] {
            attachments.push(AttachmentRepo::add(&conn, &ctx, &source.project_id, Some(&entry.entry_id),
                name, Some("application/octet-stream"), &"ab".repeat(32), 3).unwrap());
        }
        let unrelated = AttachmentRepo::add(&conn, &ctx, &source.project_id, None,
            "project.bin", None, &"cd".repeat(32), 4).unwrap();
        let request = WriteOperationRequest::new("move-with-attachments", "move-entry", vec![WriteCommand::MoveEntry {
            entry_id: entry.entry_id.clone(), project_id: source.project_id.clone(), target_project_id: target.project_id.clone(),
        }]);
        let commits_before = count(&conn, "commits");
        let versions_before = count(&conn, "object_versions");
        // Fail after the entry mutation has begun; the entire transaction must roll back.
        conn.inner().execute_batch("CREATE TEMP TRIGGER fail_attachment_move BEFORE UPDATE OF project_id ON attachments BEGIN SELECT RAISE(ABORT, 'synthetic move failure'); END;").unwrap();
        assert!(OperationCoordinator::execute(&conn, &ctx, request.clone()).is_err());
        assert_eq!(count(&conn, "commits"), commits_before);
        assert_eq!(count(&conn, "object_versions"), versions_before);
        assert_eq!(EntryRepo::get_by_id(&conn, &entry.entry_id).unwrap().unwrap().project_id, source.project_id);
        for before in &attachments {
            let after = AttachmentRepo::get_by_id(&conn, &before.attachment_id).unwrap().unwrap();
            assert_eq!(after.project_id, source.project_id);
            assert_eq!(after.head_commit_id, before.head_commit_id);
        }
        conn.inner().execute_batch("DROP TRIGGER fail_attachment_move;").unwrap();
        let moved = OperationCoordinator::execute(&conn, &ctx, request.clone()).unwrap();
        assert_eq!(count(&conn, "commits"), commits_before + 1);
        assert_eq!(count(&conn, "object_versions"), versions_before + 3);
        assert_eq!(EntryRepo::get_by_id(&conn, &entry.entry_id).unwrap().unwrap().head_commit_id, moved.commit_id);
        for before in &attachments {
            let after = AttachmentRepo::get_by_id(&conn, &before.attachment_id).unwrap().unwrap();
            assert_eq!(after.project_id, target.project_id);
            assert_eq!(after.entry_id, before.entry_id);
            assert_eq!(after.head_commit_id, moved.commit_id);
            assert_eq!(after.content_hash, before.content_hash);
            assert_eq!(after.file_name_ct, before.file_name_ct);
            assert_eq!(after.storage_mode, before.storage_mode);
            let parents: i64 = conn.inner().query_row("SELECT COUNT(*) FROM commit_parents WHERE commit_id = ?1 AND parent_commit_id = ?2",
                params![moved.commit_id, before.head_commit_id], |row| row.get(0)).unwrap();
            assert_eq!(parents, 1);
        }
        assert_eq!(AttachmentRepo::get_by_id(&conn, &unrelated.attachment_id).unwrap().unwrap().project_id, source.project_id);
        let retry = OperationCoordinator::execute(&conn, &ctx, request).unwrap();
        assert!(retry.already_committed);
        assert_eq!(retry.commit_id, moved.commit_id);
        assert_eq!(count(&conn, "commits"), commits_before + 1);
        assert_eq!(count(&conn, "object_versions"), versions_before + 3);
    }

    #[test]
    fn move_command_retains_the_repository_move_commit_kind() {
        let (conn, ctx, _) = setup();
        let source = ProjectRepo::create(&conn, &ctx, "Move source", None, None).unwrap();
        let target = ProjectRepo::create(&conn, &ctx, "Move target", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &source.project_id,
            ObjectTypeId::custom("com.monica.test.movable").unwrap(),
            Some("Movable"),
            &serde_json::json!({}),
        )
        .unwrap();
        let commits_before = count(&conn, "commits");

        let outcome = OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-move-entry",
                "move-entry",
                vec![WriteCommand::MoveEntry {
                    entry_id: entry.entry_id.clone(),
                    project_id: source.project_id,
                    target_project_id: target.project_id.clone(),
                }],
            ),
        )
        .unwrap();

        assert_eq!(count(&conn, "commits"), commits_before + 1);
        let stored_kind: String = conn
            .inner()
            .query_row(
                "SELECT commit_kind FROM commits WHERE commit_id = ?1",
                params![outcome.commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_kind, "move");
        assert_eq!(
            EntryRepo::get_by_id(&conn, &entry.entry_id)
                .unwrap()
                .unwrap()
                .project_id,
            target.project_id
        );
    }

    #[test]
    fn project_hierarchy_commands_round_trip_parent_rename_delete_and_restore() {
        let (conn, ctx, _) = setup();
        let parent_id = "00000000-0000-4000-8000-000000000040".to_string();
        let child_id = "00000000-0000-4000-8000-000000000041".to_string();
        let other_id = "00000000-0000-4000-8000-000000000042".to_string();

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-create",
                "project-hierarchy",
                vec![
                    WriteCommand::CreateProjectWithParent {
                        project_id: parent_id.clone(),
                        title: "Parent".to_string(),
                        parent_project_id: None,
                    },
                    WriteCommand::CreateProjectWithParent {
                        project_id: child_id.clone(),
                        title: "Child".to_string(),
                        parent_project_id: Some(parent_id.clone()),
                    },
                    WriteCommand::CreateProjectWithParent {
                        project_id: other_id.clone(),
                        title: "Other".to_string(),
                        parent_project_id: None,
                    },
                ],
            ),
        )
        .unwrap();
        assert_eq!(
            ProjectRepo::get_by_id(&conn, &child_id)
                .unwrap()
                .unwrap()
                .group_id
                .as_deref(),
            Some(parent_id.as_str())
        );

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-rename",
                "project-hierarchy",
                vec![WriteCommand::RenameProject {
                    project_id: child_id.clone(),
                    title: "Renamed child".to_string(),
                }],
            ),
        )
        .unwrap();
        assert_eq!(
            ProjectRepo::get_by_id(&conn, &child_id)
                .unwrap()
                .unwrap()
                .title_ct,
            b"Renamed child"
        );

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-move",
                "project-hierarchy",
                vec![WriteCommand::MoveProject {
                    project_id: child_id.clone(),
                    parent_project_id: Some(other_id),
                }],
            ),
        )
        .unwrap();

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-delete",
                "project-hierarchy",
                vec![WriteCommand::DeleteProject {
                    project_id: child_id.clone(),
                }],
            ),
        )
        .unwrap();
        assert!(
            ProjectRepo::get_by_id(&conn, &child_id)
                .unwrap()
                .unwrap()
                .deleted
        );

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-restore",
                "project-hierarchy",
                vec![WriteCommand::RestoreProject {
                    project_id: child_id.clone(),
                    parent_project_id: Some(parent_id.clone()),
                }],
            ),
        )
        .unwrap();
        let restored = ProjectRepo::get_by_id(&conn, &child_id).unwrap().unwrap();
        assert!(!restored.deleted);
        assert_eq!(restored.group_id.as_deref(), Some(parent_id.as_str()));
    }

    #[test]
    fn project_hierarchy_rejects_missing_deleted_and_cyclic_parents() {
        let (conn, ctx, _) = setup();
        let parent_id = "00000000-0000-4000-8000-000000000050".to_string();
        let child_id = "00000000-0000-4000-8000-000000000051".to_string();
        let missing_id = "00000000-0000-4000-8000-000000000052".to_string();

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-constraints-create",
                "project-hierarchy",
                vec![
                    WriteCommand::CreateProjectWithParent {
                        project_id: parent_id.clone(),
                        title: "Parent".to_string(),
                        parent_project_id: None,
                    },
                    WriteCommand::CreateProjectWithParent {
                        project_id: child_id.clone(),
                        title: "Child".to_string(),
                        parent_project_id: Some(parent_id.clone()),
                    },
                ],
            ),
        )
        .unwrap();

        let cycle = OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-cycle",
                "project-hierarchy",
                vec![WriteCommand::MoveProject {
                    project_id: parent_id.clone(),
                    parent_project_id: Some(child_id.clone()),
                }],
            ),
        )
        .unwrap_err();
        assert!(cycle.to_string().contains("cycle"));

        let missing = OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-missing-parent",
                "project-hierarchy",
                vec![WriteCommand::CreateProjectWithParent {
                    project_id: missing_id.clone(),
                    title: "Missing parent".to_string(),
                    parent_project_id: Some("00000000-0000-4000-8000-000000000053".to_string()),
                }],
            ),
        )
        .unwrap_err();
        assert!(missing.to_string().contains("parent project"));

        let non_empty = OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-delete-non-empty",
                "project-hierarchy",
                vec![WriteCommand::DeleteProject {
                    project_id: parent_id.clone(),
                }],
            ),
        )
        .unwrap_err();
        assert!(non_empty.to_string().contains("child projects"));

        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-delete-child",
                "project-hierarchy",
                vec![WriteCommand::DeleteProject {
                    project_id: child_id.clone(),
                }],
            ),
        )
        .unwrap();
        OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-delete-parent",
                "project-hierarchy",
                vec![WriteCommand::DeleteProject {
                    project_id: parent_id.clone(),
                }],
            ),
        )
        .unwrap();

        let deleted_parent = OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new(
                "native-project-hierarchy-restore-under-deleted-parent",
                "project-hierarchy",
                vec![WriteCommand::RestoreProject {
                    project_id: child_id,
                    parent_project_id: Some(parent_id),
                }],
            ),
        )
        .unwrap_err();
        assert!(deleted_parent.to_string().contains("deleted"));
        assert!(ProjectRepo::get_by_id(&conn, &missing_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn oversized_sync_envelope_rolls_back_and_split_operations_remain_exportable() {
        use crate::sync_delta::{load_sync_delta_envelope, SyncDeltaLimits};

        let (conn, ctx, _) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "Large import", None, None).unwrap();
        let commits_before = count(&conn, "commits");
        let operations_before = count(&conn, "commit_operations");
        let deltas_before = count(&conn, "sync_delta_batches");
        let payload_json = serde_json::json!({ "notes": "x".repeat(700_000) }).to_string();
        let commands = (1..=3)
            .map(|index| WriteCommand::CreateEntry {
                entry_id: format!("00000000-0000-4000-8000-{index:012}"),
                project_id: project.project_id.clone(),
                entry_type: "login".to_string(),
                title: format!("Large {index}"),
                payload_json: payload_json.clone(),
            })
            .collect::<Vec<_>>();
        let error = OperationCoordinator::execute(
            &conn,
            &ctx,
            WriteOperationRequest::new("large-import", "import", commands.clone()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("sync delta payload bytes"));
        assert!(conn.inner().is_autocommit());
        assert_eq!(count(&conn, "entries"), 0);
        assert_eq!(count(&conn, "commits"), commits_before);
        assert_eq!(count(&conn, "commit_operations"), operations_before);
        assert_eq!(count(&conn, "sync_delta_batches"), deltas_before);
        assert_eq!(count(&conn, "sync_delta_mutations"), 0);

        for (index, command) in commands.into_iter().enumerate() {
            let request = WriteOperationRequest::new(
                format!("large-import-{index}"),
                "import",
                vec![command],
            );
            let prepared = OperationCoordinator::prepare(request).unwrap();
            let first = OperationCoordinator::execute_prepared(&conn, &ctx, &prepared).unwrap();
            let retry = OperationCoordinator::execute_prepared(&conn, &ctx, &prepared).unwrap();
            assert!(!first.already_committed);
            assert!(retry.already_committed);
            assert_eq!(first.commit_id, retry.commit_id);
            let batch_id: String = conn
                .inner()
                .query_row(
                    "SELECT batch_id FROM sync_delta_batches ORDER BY batch_seq DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            let envelope = load_sync_delta_envelope(&conn, &batch_id, SyncDeltaLimits::default())
                .unwrap()
                .unwrap();
            envelope.encode(SyncDeltaLimits::default()).unwrap();
        }
        assert_eq!(count(&conn, "entries"), 3);
        assert_eq!(count(&conn, "commits"), commits_before + 3);
        assert_eq!(count(&conn, "sync_delta_batches"), deltas_before + 3);
    }

    #[test]
    fn native_operation_rolls_back_every_command_on_failure() {
        let (conn, ctx, _) = setup();
        let commits_before = count(&conn, "commits");
        let project_id = "00000000-0000-4000-8000-000000000020".to_string();
        let missing_project_id = "00000000-0000-4000-8000-000000000021".to_string();
        let request = WriteOperationRequest::new(
            "native-rollback",
            "mail-import",
            vec![
                WriteCommand::CreateProject {
                    project_id: project_id.clone(),
                    title: "Rolled back".to_string(),
                },
                WriteCommand::CreateEntry {
                    entry_id: "00000000-0000-4000-8000-000000000022".to_string(),
                    project_id: missing_project_id,
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Failure".to_string(),
                    payload_json: "{}".to_string(),
                },
            ],
        );

        assert!(OperationCoordinator::execute(&conn, &ctx, request).is_err());
        assert_eq!(count(&conn, "commits"), commits_before);
        assert_eq!(
            conn.inner()
                .query_row(
                    "SELECT COUNT(*) FROM projects WHERE project_id = ?1",
                    params![project_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn native_operation_accepts_an_explicit_stable_branch_id() {
        let (conn, ctx, branch_id) = setup();
        let operation_id = "native-explicit-branch";
        let request = WriteOperationRequest::new(
            operation_id,
            "bookmark-import",
            vec![WriteCommand::CreateProject {
                project_id: "00000000-0000-4000-8000-000000000030".to_string(),
                title: "Bookmarks".to_string(),
            }],
        )
        .with_branch_id(branch_id.clone());

        let outcome = OperationCoordinator::execute(&conn, &ctx, request).unwrap();
        let stored_branch_id: String = conn
            .inner()
            .query_row(
                "SELECT branch_id FROM commit_operations WHERE operation_id = ?1",
                params![operation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_branch_id, branch_id);
        assert_eq!(
            conn.inner()
                .query_row(
                    "SELECT head_commit_id FROM branches WHERE branch_id = ?1",
                    params![stored_branch_id],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            outcome.commit_id
        );
    }

    #[test]
    fn legacy_single_repo_writes_remain_available() {
        let (conn, ctx, _) = setup();
        let commits_before = count(&conn, "commits");
        let project = ProjectRepo::create(&conn, &ctx, "Legacy", None, None).unwrap();

        assert_eq!(count(&conn, "commits"), commits_before + 1);
        assert_eq!(
            ProjectRepo::get_by_id(&conn, &project.project_id)
                .unwrap()
                .unwrap()
                .title_ct,
            b"Legacy"
        );
    }
}
