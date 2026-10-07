//! Optional bridge from the pure Steam mafile Adapter to MDBX generic writes.
//!
//! This crate owns only the domain-to-storage mapping. It emits the existing
//! OperationCoordinator command family and adds no Steam-specific database,
//! snapshot, synchronization, key, or Tiga structure.

use std::collections::BTreeMap;
use std::fmt;

use mdbx_adapter_steam::{
    extension_profile, SteamMaFile, SteamMaFileError, SteamMaFileLimits,
    STEAM_MAFILE_OBJECT_TYPE_ID,
};
use mdbx_storage::connection::VaultConnection;
use mdbx_storage::error::StorageError;
use mdbx_storage::extension_registry::ExtensionRegistration;
use mdbx_storage::repo::{
    CollectionProfileSpec, CommitContext, ObjectSummaryRepo, OperationCoordinator,
    OperationCoordinatorError, PreparedWriteOperation, WriteCommand, WriteOperationLimits,
    WriteOperationOutcome, WriteOperationRequest,
};
use thiserror::Error;

pub const STEAM_MAFILE_IMPORT_OPERATION_KIND: &str = "steam-mafile-import";
pub const STEAM_MAFILE_PAYLOAD_SCHEMA_VERSION: u32 = 1;

pub const DEFAULT_MAX_IMPORT_DOCUMENTS: usize = 128;
pub const HARD_MAX_IMPORT_DOCUMENTS: usize = 2_048;
pub const DEFAULT_MAX_IMPORT_SOURCE_BYTES: usize = 8 * 1024 * 1024;
pub const HARD_MAX_IMPORT_SOURCE_BYTES: usize = 64 * 1024 * 1024;

const DEFAULT_OBJECT_TITLE: &str = "Steam account";
const MAX_OBJECT_TITLE_BYTES: usize = 512;

/// Aggregate resource contract for one prepared Steam mafile import.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SteamMaFileImportLimits {
    pub max_documents: usize,
    pub max_source_bytes: usize,
    pub document_limits: SteamMaFileLimits,
    pub write_limits: WriteOperationLimits,
}

impl Default for SteamMaFileImportLimits {
    fn default() -> Self {
        Self {
            max_documents: DEFAULT_MAX_IMPORT_DOCUMENTS,
            max_source_bytes: DEFAULT_MAX_IMPORT_SOURCE_BYTES,
            document_limits: SteamMaFileLimits::default(),
            write_limits: WriteOperationLimits::default(),
        }
    }
}

impl SteamMaFileImportLimits {
    pub const fn with_max_documents(mut self, value: usize) -> Self {
        self.max_documents = value;
        self
    }

    pub const fn with_max_source_bytes(mut self, value: usize) -> Self {
        self.max_source_bytes = value;
        self
    }

    pub const fn with_document_limits(mut self, value: SteamMaFileLimits) -> Self {
        self.document_limits = value;
        self
    }

    pub const fn with_write_limits(mut self, value: WriteOperationLimits) -> Self {
        self.write_limits = value;
        self
    }

    pub fn validate(self) -> Result<(), SteamMaFileStorageError> {
        validate_limit("documents", self.max_documents, HARD_MAX_IMPORT_DOCUMENTS)?;
        validate_limit(
            "source bytes",
            self.max_source_bytes,
            HARD_MAX_IMPORT_SOURCE_BYTES,
        )?;
        self.document_limits
            .validate()
            .map_err(|source| SteamMaFileStorageError::DocumentLimits { source })?;
        self.write_limits.validate().map_err(StorageError::into)
    }
}

fn validate_limit(
    resource: &'static str,
    value: usize,
    hard_limit: usize,
) -> Result<(), SteamMaFileStorageError> {
    if value == 0 || value > hard_limit {
        return Err(SteamMaFileStorageError::InvalidLimits {
            resource,
            actual: value as u64,
            limit: hard_limit as u64,
        });
    }
    Ok(())
}

/// One untrusted mafile and the authenticated account identity supplied by the
/// client. Debug output intentionally contains only allocation sizes.
#[derive(Clone)]
pub struct SteamMaFileImportSource {
    steam_id: String,
    bytes: Vec<u8>,
}

impl SteamMaFileImportSource {
    pub fn new(steam_id: impl Into<String>, bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            steam_id: steam_id.into(),
            bytes: bytes.into(),
        }
    }

    pub fn source_bytes(&self) -> usize {
        self.bytes.len()
    }
}

impl fmt::Debug for SteamMaFileImportSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SteamMaFileImportSource")
            .field("has_steam_id", &!self.steam_id.trim().is_empty())
            .field("source_bytes", &self.bytes.len())
            .finish()
    }
}

/// One finite import request. The caller owns operation identity and must reuse
/// the prepared plan, not rebuild it, when retrying an uncertain execution.
#[derive(Clone)]
pub struct SteamMaFileImportRequest {
    operation_id: String,
    collection_id: String,
    branch_id: Option<String>,
    documents: Vec<SteamMaFileImportSource>,
    limits: SteamMaFileImportLimits,
}

impl SteamMaFileImportRequest {
    pub fn new(
        operation_id: impl Into<String>,
        collection_id: impl Into<String>,
        documents: Vec<SteamMaFileImportSource>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            collection_id: collection_id.into(),
            branch_id: None,
            documents,
            limits: SteamMaFileImportLimits::default(),
        }
    }

    pub fn with_branch_id(mut self, branch_id: impl Into<String>) -> Self {
        self.branch_id = Some(branch_id.into());
        self
    }

    pub fn with_limits(mut self, limits: SteamMaFileImportLimits) -> Self {
        self.limits = limits;
        self
    }
}

impl fmt::Debug for SteamMaFileImportRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SteamMaFileImportRequest")
            .field("operation_id", &self.operation_id)
            .field("collection_id", &self.collection_id)
            .field("has_branch_id", &self.branch_id.is_some())
            .field("document_count", &self.documents.len())
            .field(
                "source_bytes",
                &self.documents.iter().fold(0usize, |total, source| {
                    total.saturating_add(source.bytes.len())
                }),
            )
            .field("limits", &self.limits)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SteamMaFileImportAction {
    Create,
    Update,
    RestoreAndUpdate,
}

/// Non-sensitive result metadata for one source document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamMaFileImportItem {
    pub source_index: usize,
    pub object_id: String,
    pub action: SteamMaFileImportAction,
    pub source_bytes: usize,
    pub canonical_bytes: usize,
}

/// Prepared sensitive plaintext plus the exact generic operation intent.
///
/// Debug output never traverses the prepared commands because they contain
/// canonical mafile JSON.
#[derive(Clone)]
pub struct SteamMaFileImportPlan {
    prepared: PreparedWriteOperation,
    items: Vec<SteamMaFileImportItem>,
    source_bytes: usize,
    canonical_bytes: usize,
}

impl fmt::Debug for SteamMaFileImportPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SteamMaFileImportPlan")
            .field("operation_id", &self.prepared.operation_id())
            .field("branch_id", &self.prepared.branch_id())
            .field("item_count", &self.items.len())
            .field("source_bytes", &self.source_bytes)
            .field("canonical_bytes", &self.canonical_bytes)
            .field("items", &self.items)
            .finish()
    }
}

impl SteamMaFileImportPlan {
    /// Parse, canonicalize, sort, and classify every source before mutation.
    ///
    /// Existing object state is read through ObjectSummaryRepo, which never
    /// selects the encrypted payload. Races after planning fail through the
    /// ordinary generic command checks during execution.
    pub fn prepare(
        conn: &VaultConnection,
        request: SteamMaFileImportRequest,
    ) -> Result<Self, SteamMaFileStorageError> {
        request.limits.validate()?;
        if request.documents.is_empty() {
            return Err(SteamMaFileStorageError::EmptyBatch);
        }
        if request.documents.len() > request.limits.max_documents {
            return Err(SteamMaFileStorageError::ResourceLimit {
                resource: "documents",
                actual: request.documents.len() as u64,
                limit: request.limits.max_documents as u64,
            });
        }

        let source_bytes = request.documents.iter().try_fold(0usize, |total, source| {
            total
                .checked_add(source.bytes.len())
                .ok_or(SteamMaFileStorageError::ResourceLimit {
                    resource: "source bytes",
                    actual: u64::MAX,
                    limit: request.limits.max_source_bytes as u64,
                })
        })?;
        if source_bytes > request.limits.max_source_bytes {
            return Err(SteamMaFileStorageError::ResourceLimit {
                resource: "source bytes",
                actual: source_bytes as u64,
                limit: request.limits.max_source_bytes as u64,
            });
        }

        let mut parsed = Vec::with_capacity(request.documents.len());
        let mut identity_sources = BTreeMap::new();
        for (source_index, source) in request.documents.into_iter().enumerate() {
            let document =
                SteamMaFile::parse_with_limits(&source.bytes, request.limits.document_limits)
                    .map_err(|source| SteamMaFileStorageError::Document {
                        index: source_index,
                        source,
                    })?;
            let object_id = document
                .stable_object_uuid(&source.steam_id)
                .map_err(|source| SteamMaFileStorageError::Document {
                    index: source_index,
                    source,
                })?;
            if let Some(first_index) = identity_sources.insert(object_id.clone(), source_index) {
                return Err(SteamMaFileStorageError::DuplicateIdentity {
                    first_index,
                    duplicate_index: source_index,
                });
            }
            let payload_json = document.canonical_json_string().map_err(|source| {
                SteamMaFileStorageError::Document {
                    index: source_index,
                    source,
                }
            })?;
            let canonical_bytes = payload_json.len();
            parsed.push(ParsedDocument {
                source_index,
                object_id,
                title: display_title(&document),
                payload_json,
                source_bytes: source.bytes.len(),
                canonical_bytes,
            });
        }
        parsed.sort_unstable_by(|left, right| left.object_id.cmp(&right.object_id));

        let mut commands = Vec::with_capacity(parsed.len());
        let mut items = Vec::with_capacity(parsed.len());
        let mut canonical_bytes = 0usize;
        for document in parsed {
            canonical_bytes = canonical_bytes.saturating_add(document.canonical_bytes);
            let existing = ObjectSummaryRepo::get(conn, &document.object_id)?;
            let action = match existing {
                None => {
                    commands.push(WriteCommand::CreateEntry {
                        entry_id: document.object_id.clone(),
                        project_id: request.collection_id.clone(),
                        entry_type: STEAM_MAFILE_OBJECT_TYPE_ID.to_string(),
                        title: document.title,
                        payload_json: document.payload_json,
                    });
                    SteamMaFileImportAction::Create
                }
                Some(existing) => {
                    if existing.collection_id != request.collection_id {
                        return Err(SteamMaFileStorageError::ExistingCollectionMismatch {
                            index: document.source_index,
                            object_id: document.object_id,
                        });
                    }
                    if existing.object_type_id.as_str() != STEAM_MAFILE_OBJECT_TYPE_ID {
                        return Err(SteamMaFileStorageError::ExistingObjectTypeMismatch {
                            index: document.source_index,
                            object_id: document.object_id,
                        });
                    }
                    if existing.payload_schema_version != STEAM_MAFILE_PAYLOAD_SCHEMA_VERSION {
                        return Err(SteamMaFileStorageError::ExistingPayloadSchemaMismatch {
                            index: document.source_index,
                            object_id: document.object_id,
                            actual: existing.payload_schema_version,
                            expected: STEAM_MAFILE_PAYLOAD_SCHEMA_VERSION,
                        });
                    }
                    if existing.deleted {
                        commands.push(WriteCommand::RestoreEntry {
                            entry_id: document.object_id.clone(),
                            project_id: request.collection_id.clone(),
                        });
                    }
                    commands.push(WriteCommand::UpdateEntry {
                        entry_id: document.object_id.clone(),
                        project_id: request.collection_id.clone(),
                        entry_type: STEAM_MAFILE_OBJECT_TYPE_ID.to_string(),
                        title: document.title,
                        payload_json: document.payload_json,
                    });
                    if existing.deleted {
                        SteamMaFileImportAction::RestoreAndUpdate
                    } else {
                        SteamMaFileImportAction::Update
                    }
                }
            };
            items.push(SteamMaFileImportItem {
                source_index: document.source_index,
                object_id: document.object_id,
                action,
                source_bytes: document.source_bytes,
                canonical_bytes: document.canonical_bytes,
            });
        }

        let mut storage_request = WriteOperationRequest::new(
            request.operation_id,
            STEAM_MAFILE_IMPORT_OPERATION_KIND,
            commands,
        )
        .with_limits(request.limits.write_limits);
        if let Some(branch_id) = request.branch_id {
            storage_request = storage_request.with_branch_id(branch_id);
        }
        let prepared = OperationCoordinator::prepare(storage_request)?;

        Ok(Self {
            prepared,
            items,
            source_bytes,
            canonical_bytes,
        })
    }

    pub fn execute(
        &self,
        conn: &VaultConnection,
        ctx: &CommitContext,
    ) -> Result<WriteOperationOutcome, SteamMaFileStorageError> {
        OperationCoordinator::execute_prepared(conn, ctx, &self.prepared).map_err(Into::into)
    }

    pub fn operation_id(&self) -> &str {
        self.prepared.operation_id()
    }

    pub fn branch_id(&self) -> Option<&str> {
        self.prepared.branch_id()
    }

    pub fn intent_hash(&self) -> &[u8] {
        self.prepared.intent_hash()
    }

    pub fn items(&self) -> &[SteamMaFileImportItem] {
        &self.items
    }

    pub fn source_bytes(&self) -> usize {
        self.source_bytes
    }

    pub fn canonical_bytes(&self) -> usize {
        self.canonical_bytes
    }
}

struct ParsedDocument {
    source_index: usize,
    object_id: String,
    title: String,
    payload_json: String,
    source_bytes: usize,
    canonical_bytes: usize,
}

fn display_title(document: &SteamMaFile) -> String {
    document
        .field("account_name")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_OBJECT_TITLE_BYTES
                && !value.chars().any(char::is_control)
        })
        .unwrap_or(DEFAULT_OBJECT_TITLE)
        .to_string()
}

/// Register only the process-local Steam ExtensionProfile.
///
/// Capability activation remains an explicit, separate client action.
pub fn register_steam_extension_profile(
    conn: &mut VaultConnection,
) -> Result<ExtensionRegistration, SteamMaFileStorageError> {
    conn.register_extension_profile(extension_profile())
        .map_err(Into::into)
}

/// Build the persisted CollectionProfile contract for one Steam Collection.
///
/// The version-1 profile has an empty Adapter configuration payload, accepts
/// only mafile objects, and requires the profile's storage capability.
pub fn steam_collection_profile_spec(collection_id: impl Into<String>) -> CollectionProfileSpec {
    let profile = extension_profile();
    CollectionProfileSpec {
        collection_id: collection_id.into(),
        collection_type_id: profile.collection_type_ids[0].clone(),
        payload: Vec::new(),
        payload_schema_version: 1,
        allowed_object_type_ids: profile.object_type_ids,
        required_capability_ids: profile.capability_ids,
    }
}

/// Storage-bridge failures contain source indexes and opaque object IDs but no
/// mafile bytes, parsed values, SteamIDs, serials, or tokens.
#[derive(Debug, Error)]
pub enum SteamMaFileStorageError {
    #[error("steam mafile import limits are invalid for {resource}")]
    InvalidLimits {
        resource: &'static str,
        actual: u64,
        limit: u64,
    },
    #[error("steam mafile import requires at least one document")]
    EmptyBatch,
    #[error("steam mafile import exceeds the configured {resource} limit")]
    ResourceLimit {
        resource: &'static str,
        actual: u64,
        limit: u64,
    },
    #[error("steam mafile parser limits are invalid")]
    DocumentLimits {
        #[source]
        source: SteamMaFileError,
    },
    #[error("steam mafile document {index} is invalid")]
    Document {
        index: usize,
        #[source]
        source: SteamMaFileError,
    },
    #[error(
        "steam mafile documents {first_index} and {duplicate_index} resolve to one object identity"
    )]
    DuplicateIdentity {
        first_index: usize,
        duplicate_index: usize,
    },
    #[error("steam mafile document {index} resolves to an object in another Collection")]
    ExistingCollectionMismatch { index: usize, object_id: String },
    #[error("steam mafile document {index} resolves to an object with another ObjectTypeId")]
    ExistingObjectTypeMismatch { index: usize, object_id: String },
    #[error("steam mafile document {index} resolves to another payload schema version")]
    ExistingPayloadSchemaMismatch {
        index: usize,
        object_id: String,
        actual: u32,
        expected: u32,
    },
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Operation(#[from] OperationCoordinatorError),
}

#[cfg(test)]
mod tests {
    use mdbx_adapter_steam::extension_profile;
    use mdbx_storage::init::{initialize_vault, VaultInitParams};
    use mdbx_storage::repo::{
        CollectionProfileRepo, CommitContext, EntryRepo, ObjectSummaryRepo, ProjectRepo,
    };

    use super::*;

    const SYNTHETIC_STEAM_ID_A: &str = "76561198000000001";
    const SYNTHETIC_STEAM_ID_B: &str = "76561198000000002";
    const SYNTHETIC_SECRET: &str = "synthetic-steam-secret-never-log";
    const SYNTHETIC_SERIAL_A: &str = "SYNTHETIC-SERIAL-A";
    const SYNTHETIC_SERIAL_B: &str = "SYNTHETIC-SERIAL-B";

    fn synthetic_source(
        steam_id: &str,
        serial_number: &str,
        account_name: &str,
    ) -> SteamMaFileImportSource {
        let document = serde_json::json!({
            "account_name": account_name,
            "identity_secret": format!("{SYNTHETIC_SECRET}-{serial_number}"),
            "serial_number": serial_number,
            "shared_secret": SYNTHETIC_SECRET,
            "steamid": steam_id,
            "unknown_future": {
                "enabled": true,
                "version": 2
            }
        });
        SteamMaFileImportSource::new(steam_id, serde_json::to_vec(&document).unwrap())
    }

    fn commit_count(conn: &VaultConnection) -> i64 {
        conn.inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap()
    }

    fn entry_count(conn: &VaultConnection) -> i64 {
        conn.inner()
            .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
            .unwrap()
    }

    fn create_steam_collection(conn: &VaultConnection, ctx: &CommitContext, title: &str) -> String {
        let collection = ProjectRepo::create(conn, ctx, title, None, None).unwrap();
        CollectionProfileRepo::set(
            conn,
            ctx,
            steam_collection_profile_spec(collection.project_id.clone()),
        )
        .unwrap();
        collection.project_id
    }

    fn setup() -> (VaultConnection, CommitContext, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        let initialized = initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "synthetic-steam-storage-device".to_string(),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        assert_eq!(
            register_steam_extension_profile(&mut conn).unwrap(),
            ExtensionRegistration::Registered
        );
        conn.set_extension_capabilities(extension_profile().capability_ids);
        let ctx = CommitContext::new(initialized.device_id);
        let collection_id = create_steam_collection(&conn, &ctx, "Synthetic Steam accounts");
        (conn, ctx, collection_id)
    }

    fn request(
        operation_id: &str,
        collection_id: &str,
        documents: Vec<SteamMaFileImportSource>,
    ) -> SteamMaFileImportRequest {
        SteamMaFileImportRequest::new(operation_id, collection_id, documents)
    }

    #[test]
    fn source_order_does_not_change_the_generic_write_intent() {
        let (conn, _, collection_id) = setup();
        let first = synthetic_source(
            SYNTHETIC_STEAM_ID_A,
            SYNTHETIC_SERIAL_A,
            "Synthetic account A",
        );
        let second = synthetic_source(
            SYNTHETIC_STEAM_ID_B,
            SYNTHETIC_SERIAL_B,
            "Synthetic account B",
        );

        let forward = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-order-forward",
                &collection_id,
                vec![first.clone(), second.clone()],
            ),
        )
        .unwrap();
        let reverse = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-order-reverse",
                &collection_id,
                vec![second, first],
            ),
        )
        .unwrap();

        assert_eq!(forward.intent_hash(), reverse.intent_hash());
        assert_eq!(
            forward
                .items()
                .iter()
                .map(|item| item.object_id.as_str())
                .collect::<Vec<_>>(),
            reverse
                .items()
                .iter()
                .map(|item| item.object_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn create_batch_uses_one_commit_and_prepared_retry_is_idempotent() {
        let (conn, ctx, collection_id) = setup();
        let before = commit_count(&conn);
        let plan = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-create-batch",
                &collection_id,
                vec![
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_A,
                        SYNTHETIC_SERIAL_A,
                        "Synthetic account A",
                    ),
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_B,
                        SYNTHETIC_SERIAL_B,
                        "Synthetic account B",
                    ),
                ],
            ),
        )
        .unwrap();
        assert!(plan
            .items()
            .iter()
            .all(|item| item.action == SteamMaFileImportAction::Create));

        let first = plan.execute(&conn, &ctx).unwrap();
        assert!(!first.already_committed);
        assert_eq!(first.changed_objects.len(), 2);
        assert_eq!(commit_count(&conn), before + 1);
        assert_eq!(entry_count(&conn), 2);
        for item in plan.items() {
            let summary = ObjectSummaryRepo::get(&conn, &item.object_id)
                .unwrap()
                .unwrap();
            assert_eq!(summary.head_commit_id, first.commit_id);
            assert!(!summary.deleted);
        }

        let retry = plan.execute(&conn, &ctx).unwrap();
        assert!(retry.already_committed);
        assert_eq!(retry.commit_id, first.commit_id);
        assert_eq!(commit_count(&conn), before + 1);
        assert_eq!(entry_count(&conn), 2);
    }

    #[test]
    fn existing_object_is_updated_in_one_new_commit() {
        let (conn, ctx, collection_id) = setup();
        let original = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-create-before-update",
                &collection_id,
                vec![synthetic_source(
                    SYNTHETIC_STEAM_ID_A,
                    SYNTHETIC_SERIAL_A,
                    "Synthetic original account",
                )],
            ),
        )
        .unwrap();
        original.execute(&conn, &ctx).unwrap();

        let before = commit_count(&conn);
        let update = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-update-existing",
                &collection_id,
                vec![synthetic_source(
                    SYNTHETIC_STEAM_ID_A,
                    SYNTHETIC_SERIAL_A,
                    "Synthetic updated account",
                )],
            ),
        )
        .unwrap();
        assert_eq!(update.items()[0].action, SteamMaFileImportAction::Update);

        let outcome = update.execute(&conn, &ctx).unwrap();
        assert_eq!(commit_count(&conn), before + 1);
        let summary = ObjectSummaryRepo::get(&conn, &update.items()[0].object_id)
            .unwrap()
            .unwrap();
        assert_eq!(summary.head_commit_id, outcome.commit_id);
        assert_eq!(summary.title, Some(b"Synthetic updated account".to_vec()));
    }

    #[test]
    fn deleted_object_is_restored_and_updated_in_one_commit() {
        let (conn, ctx, collection_id) = setup();
        let original = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-create-before-restore",
                &collection_id,
                vec![synthetic_source(
                    SYNTHETIC_STEAM_ID_A,
                    SYNTHETIC_SERIAL_A,
                    "Synthetic account before delete",
                )],
            ),
        )
        .unwrap();
        original.execute(&conn, &ctx).unwrap();
        let object_id = original.items()[0].object_id.clone();
        EntryRepo::soft_delete(&conn, &ctx, &object_id).unwrap();
        assert!(
            ObjectSummaryRepo::get(&conn, &object_id)
                .unwrap()
                .unwrap()
                .deleted
        );

        let before = commit_count(&conn);
        let restore = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-restore-existing",
                &collection_id,
                vec![synthetic_source(
                    SYNTHETIC_STEAM_ID_A,
                    SYNTHETIC_SERIAL_A,
                    "Synthetic restored account",
                )],
            ),
        )
        .unwrap();
        assert_eq!(
            restore.items()[0].action,
            SteamMaFileImportAction::RestoreAndUpdate
        );

        let outcome = restore.execute(&conn, &ctx).unwrap();
        assert_eq!(outcome.changed_objects.len(), 1);
        assert_eq!(commit_count(&conn), before + 1);
        let summary = ObjectSummaryRepo::get(&conn, &object_id).unwrap().unwrap();
        assert!(!summary.deleted);
        assert_eq!(summary.head_commit_id, outcome.commit_id);
        assert_eq!(summary.title, Some(b"Synthetic restored account".to_vec()));
    }

    #[test]
    fn missing_collection_capability_rolls_back_the_entire_batch() {
        let (mut conn, ctx, collection_id) = setup();
        conn.set_extension_capabilities(Vec::new());
        let before_commits = commit_count(&conn);
        let before_entries = entry_count(&conn);
        let plan = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-missing-capability",
                &collection_id,
                vec![
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_A,
                        SYNTHETIC_SERIAL_A,
                        "Synthetic account A",
                    ),
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_B,
                        SYNTHETIC_SERIAL_B,
                        "Synthetic account B",
                    ),
                ],
            ),
        )
        .unwrap();

        let error = plan.execute(&conn, &ctx).unwrap_err();
        assert!(matches!(error, SteamMaFileStorageError::Storage(_)));
        assert_eq!(commit_count(&conn), before_commits);
        assert_eq!(entry_count(&conn), before_entries);
        assert!(plan
            .items()
            .iter()
            .all(|item| ObjectSummaryRepo::get(&conn, &item.object_id)
                .unwrap()
                .is_none()));
    }

    #[test]
    fn duplicate_identity_resource_limits_and_invalid_json_are_rejected_before_write() {
        let (conn, _, collection_id) = setup();
        let before_commits = commit_count(&conn);
        let before_entries = entry_count(&conn);

        let duplicate = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-duplicate-identity",
                &collection_id,
                vec![
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_A,
                        SYNTHETIC_SERIAL_A,
                        "Synthetic duplicate first",
                    ),
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_A,
                        SYNTHETIC_SERIAL_A,
                        "Synthetic duplicate second",
                    ),
                ],
            ),
        )
        .unwrap_err();
        assert!(matches!(
            duplicate,
            SteamMaFileStorageError::DuplicateIdentity {
                first_index: 0,
                duplicate_index: 1
            }
        ));

        let document_limit = SteamMaFileImportLimits::default().with_max_documents(1);
        let too_many = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-document-limit",
                &collection_id,
                vec![
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_A,
                        SYNTHETIC_SERIAL_A,
                        "Synthetic account A",
                    ),
                    synthetic_source(
                        SYNTHETIC_STEAM_ID_B,
                        SYNTHETIC_SERIAL_B,
                        "Synthetic account B",
                    ),
                ],
            )
            .with_limits(document_limit),
        )
        .unwrap_err();
        assert!(matches!(
            too_many,
            SteamMaFileStorageError::ResourceLimit {
                resource: "documents",
                actual: 2,
                limit: 1
            }
        ));

        let source = synthetic_source(
            SYNTHETIC_STEAM_ID_A,
            SYNTHETIC_SERIAL_A,
            "Synthetic oversized aggregate",
        );
        let source_limit =
            SteamMaFileImportLimits::default().with_max_source_bytes(source.source_bytes() - 1);
        let too_large = SteamMaFileImportPlan::prepare(
            &conn,
            request("synthetic-source-byte-limit", &collection_id, vec![source])
                .with_limits(source_limit),
        )
        .unwrap_err();
        assert!(matches!(
            too_large,
            SteamMaFileStorageError::ResourceLimit {
                resource: "source bytes",
                ..
            }
        ));

        let invalid_json = SteamMaFileImportSource::new(
            SYNTHETIC_STEAM_ID_A,
            format!(r#"{{"shared_secret":"{SYNTHETIC_SECRET}",}}"#).into_bytes(),
        );
        let invalid = SteamMaFileImportPlan::prepare(
            &conn,
            request("synthetic-invalid-json", &collection_id, vec![invalid_json]),
        )
        .unwrap_err();
        assert!(matches!(
            invalid,
            SteamMaFileStorageError::Document { index: 0, .. }
        ));

        let invalid_limits = SteamMaFileImportLimits::default().with_max_documents(0);
        assert!(matches!(
            invalid_limits.validate(),
            Err(SteamMaFileStorageError::InvalidLimits {
                resource: "documents",
                ..
            })
        ));
        assert_eq!(commit_count(&conn), before_commits);
        assert_eq!(entry_count(&conn), before_entries);
    }

    #[test]
    fn existing_object_in_another_collection_is_rejected() {
        let (conn, ctx, target_collection_id) = setup();
        let other_collection_id =
            create_steam_collection(&conn, &ctx, "Synthetic other Steam accounts");
        let source = synthetic_source(
            SYNTHETIC_STEAM_ID_A,
            SYNTHETIC_SERIAL_A,
            "Synthetic account in other Collection",
        );
        let existing = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-create-in-other-collection",
                &other_collection_id,
                vec![source.clone()],
            ),
        )
        .unwrap();
        existing.execute(&conn, &ctx).unwrap();
        let before = commit_count(&conn);

        let error = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-cross-collection-import",
                &target_collection_id,
                vec![source],
            ),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            SteamMaFileStorageError::ExistingCollectionMismatch { index: 0, .. }
        ));
        assert_eq!(commit_count(&conn), before);
        assert_eq!(entry_count(&conn), 1);
    }

    #[test]
    fn debug_and_errors_do_not_disclose_mafile_identity_or_secrets() {
        let (conn, _, collection_id) = setup();
        let source = synthetic_source(
            SYNTHETIC_STEAM_ID_A,
            SYNTHETIC_SERIAL_A,
            "Synthetic private account name",
        );
        let import_request = request(
            "synthetic-debug-redaction",
            &collection_id,
            vec![source.clone()],
        );
        let plan = SteamMaFileImportPlan::prepare(&conn, import_request.clone()).unwrap();
        let invalid_source = SteamMaFileImportSource::new(
            SYNTHETIC_STEAM_ID_A,
            format!(r#"{{"shared_secret":"{SYNTHETIC_SECRET}",}}"#).into_bytes(),
        );
        let error = SteamMaFileImportPlan::prepare(
            &conn,
            request(
                "synthetic-debug-error",
                &collection_id,
                vec![invalid_source],
            ),
        )
        .unwrap_err();

        for rendered in [
            format!("{source:?}"),
            format!("{import_request:?}"),
            format!("{plan:?}"),
            format!("{error:?}"),
            error.to_string(),
        ] {
            assert!(!rendered.contains(SYNTHETIC_SECRET));
            assert!(!rendered.contains(SYNTHETIC_STEAM_ID_A));
            assert!(!rendered.contains(SYNTHETIC_SERIAL_A));
            assert!(!rendered.contains("Synthetic private account name"));
        }
    }
}
