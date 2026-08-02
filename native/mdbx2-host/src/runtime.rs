use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use md5::{Digest, Md5};
use mdbx_ffi::{
    MdbxAttachmentBatchCommand, MdbxAttachmentContentLimits, MdbxAttachmentCreateRequest,
    MdbxAttachmentRecord, MdbxAttachmentSummary, MdbxAttachmentWriteResult, MdbxCommitHistoryItem,
    MdbxConflictChoice, MdbxConflictSummary, MdbxDeviceAssurance, MdbxDeviceContext,
    MdbxManagedSnapshotSummary, MdbxMigrationInfo, MdbxObjectDisclosureLimits, MdbxSnapshotKind,
    MdbxSnapshotStructureNode, MdbxVault, MdbxWriteCommand,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::cloud_sync;

pub const PROTOCOL_VERSION: u32 = 2;
pub const HOST_NAME: &str = "com.monica_pass.mdbx2";
pub const MDBX_CORE_REVISION: &str = "aafa22f195c626a8d8288d712bf42bccea134847";
pub const MDBX_FORMAT_VERSION: &str = "MDBX-2";
pub const MAX_BINARY_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_INBOUND_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_ACTIVE_TRANSFERS: usize = 4;

const TRANSFER_METADATA_VERSION: u32 = 1;
const DEVICE_METADATA_VERSION: u32 = 1;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_BASE64_CHUNK_BYTES: usize = MAX_BINARY_CHUNK_BYTES.div_ceil(3) * 4;
const MAX_METADATA_BYTES: u64 = 16 * 1024;
const MAX_SUMMARY_PAGE_SIZE: u32 = 200;
const MAX_CURSOR_BYTES: usize = 4096;
const MAX_OBJECT_PAYLOAD_BYTES: usize = 512 * 1024;
const MAX_LOGICAL_OBJECT_ID_BYTES: usize = 4096;
const MAX_OBJECT_TYPE_ID_BYTES: usize = 512;
const MAX_TITLE_BYTES: usize = 64 * 1024;
pub const MAX_OBJECT_BATCH_MUTATIONS: usize = 50;
pub const MAX_OBJECT_BATCH_INTENT_BYTES: usize = 384 * 1024;
const MAX_OBJECT_BATCH_COMMANDS: usize = 256;
const OBJECT_OPERATION_STATE_VERSION: u32 = 1;
const MAX_OBJECT_OPERATION_RECEIPTS: usize = 2048;
const MAX_OBJECT_OPERATION_STATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_OPERATION_HISTORY_PAGES: usize = 16;
const MAX_HISTORY_PAGE_SIZE: u32 = 50;
pub const MAX_HISTORY_RESULT_BYTES: usize = 850 * 1024;
const MAX_HISTORY_REVERT_ITEMS: usize = 500;
const MAX_SNAPSHOT_PAGE_SIZE: u32 = 50;
const MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE: u32 = 100;
pub const MAX_SNAPSHOT_RESULT_BYTES: usize = 850 * 1024;
const SNAPSHOT_STRUCTURE_CURSOR_VERSION: u32 = 1;
const MAX_SNAPSHOT_TEXT_BYTES: usize = 4096;
const MAX_SNAPSHOT_NAME_BYTES: usize = 96;
const MONICA_ROOT_PROJECT_TITLE: &str = ".monica-root";
const SNAPSHOT_OPERATION_STATE_VERSION: u32 = 1;
const MAX_SNAPSHOT_OPERATION_RECEIPTS: usize = 2048;
const MAX_SNAPSHOT_OPERATION_STATE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SNAPSHOT_HISTORY_SCAN_PAGES: usize = 64;
const MAX_SNAPSHOT_INVENTORY_PAGES: usize = 64;
const MAX_SNAPSHOT_BRANCHES: usize = 64;
const CONFLICT_RESOLUTION_STATE_VERSION: u32 = 1;
const MAX_CONFLICT_PAGE_SIZE: u32 = 50;
pub const MAX_CONFLICT_RESULT_BYTES: usize = 850 * 1024;
const MAX_CONFLICT_SCAN_PAGES: usize = 64;
const MAX_CONFLICT_RESOLUTION_RECEIPTS: usize = 2048;
const MAX_CONFLICT_RESOLUTION_STATE_BYTES: u64 = 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ATTACHMENT_PAGE_SIZE: u32 = 50;
const MAX_ATTACHMENT_SESSIONS: usize = 4;
const MAX_ATTACHMENT_MEMORY_BYTES: usize = 128 * 1024 * 1024;
const MAX_ATTACHMENT_FILE_NAME_BYTES: usize = 4096;
const MAX_ATTACHMENT_MEDIA_TYPE_BYTES: usize = 512;
const ATTACHMENT_SESSION_TTL_SECS: u64 = 5 * 60;

#[derive(Debug)]
pub struct RpcFailure {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl RpcFailure {
    pub(crate) fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new("params-invalid", message, false)
    }

    pub(crate) fn storage(message: impl Into<String>) -> Self {
        Self::new("host-storage-error", message, true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TransferPurpose {
    VaultBootstrap,
    SyncSegment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferMetadata {
    version: u32,
    revision: u64,
    transfer_id: String,
    purpose: TransferPurpose,
    size_bytes: u64,
    sha256: Option<String>,
    received_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceMetadata {
    version: u32,
    device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObjectOperationReceipt {
    vault_handle: String,
    operation_id: String,
    #[serde(default)]
    operation_scope: Option<String>,
    semantic_sha256: String,
    plan_sha256: String,
    mutation_count: u32,
    changed_indices: Vec<u32>,
    commit_id: Option<String>,
    updated_at_unix_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ObjectOperationState {
    version: u32,
    revision: u64,
    receipts: Vec<ObjectOperationReceipt>,
}

impl Default for ObjectOperationState {
    fn default() -> Self {
        Self {
            version: OBJECT_OPERATION_STATE_VERSION,
            revision: 0,
            receipts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ConflictResolutionChoice {
    LocalWins,
    IncomingWins,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SnapshotStructureSide {
    Current,
    Snapshot,
}

impl SnapshotStructureSide {
    fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Snapshot => "snapshot",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotStructureCursor {
    version: u32,
    vault_handle: String,
    snapshot_id: String,
    side: SnapshotStructureSide,
    offset: u32,
    total_nodes: u32,
    fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum SnapshotOperationKind {
    Create,
    Delete,
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotOperationReceipt {
    vault_handle: String,
    operation_id: String,
    kind: SnapshotOperationKind,
    intent_sha256: String,
    target_snapshot_id: Option<String>,
    target_base_commit_id: Option<String>,
    pre_branch_state_sha256: String,
    pre_device_local_seq: u64,
    completed: bool,
    outcome_unknown: bool,
    result_snapshot_id: Option<String>,
    result_commit_id: Option<String>,
    affected_object_count: Option<u32>,
    updated_at_unix_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotOperationState {
    version: u32,
    revision: u64,
    receipts: Vec<SnapshotOperationReceipt>,
}

impl Default for SnapshotOperationState {
    fn default() -> Self {
        Self {
            version: SNAPSHOT_OPERATION_STATE_VERSION,
            revision: 0,
            receipts: Vec::new(),
        }
    }
}

struct SnapshotOperationBaseline {
    branch_state_sha256: String,
    device_local_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictResolutionReceipt {
    vault_handle: String,
    operation_id: String,
    conflict_id: String,
    object_type: String,
    object_id: String,
    choice: ConflictResolutionChoice,
    completed: bool,
    resolved_at: Option<String>,
    updated_at_unix_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictResolutionState {
    version: u32,
    revision: u64,
    receipts: Vec<ConflictResolutionReceipt>,
}

impl Default for ConflictResolutionState {
    fn default() -> Self {
        Self {
            version: CONFLICT_RESOLUTION_STATE_VERSION,
            revision: 0,
            receipts: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
enum ObjectMutation {
    Upsert {
        logical_object_id: String,
        requested_collection_id: Option<String>,
        object_type_id: String,
        title: String,
        payload_json: String,
    },
    Delete {
        logical_object_id: String,
    },
}

#[derive(Debug, Clone)]
struct ObjectMutationResult {
    kind: &'static str,
    changed: bool,
    logical_object_id: String,
    object_id: String,
    collection_id: Option<String>,
    object_type_id: Option<String>,
}

struct ObjectMutationPlan {
    commands: Vec<MdbxWriteCommand>,
    items: Vec<ObjectMutationResult>,
    plan_sha256: String,
    changed_indices: Vec<u32>,
}

struct ObjectMutationExecution {
    operation_id: String,
    commit_id: Option<String>,
    already_committed: Option<bool>,
    items: Vec<ObjectMutationResult>,
}

enum ObjectOperationIdentity {
    Id(String),
    Scope(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachmentUploadMode {
    Create,
    Replace,
}

struct AttachmentReadSession {
    vault_handle: String,
    attachment_id: String,
    file_name: String,
    media_type: Option<String>,
    bytes: Zeroizing<Vec<u8>>,
    updated_at_unix_secs: u64,
}

#[derive(Debug, Clone)]
struct AttachmentUploadResult {
    attachment: MdbxAttachmentRecord,
    commit_id: String,
    already_committed: bool,
}

struct AttachmentUploadSession {
    vault_handle: String,
    operation_id: String,
    attachment_id: String,
    collection_id: String,
    object_id: String,
    file_name: String,
    media_type: Option<String>,
    mode: AttachmentUploadMode,
    size_bytes: usize,
    expected_sha256: Option<String>,
    bytes: Zeroizing<Vec<u8>>,
    result: Option<AttachmentUploadResult>,
    updated_at_unix_secs: u64,
}

enum VaultCredential {
    Password(Zeroizing<String>),
    SecurityKey(Zeroizing<Vec<u8>>),
    PasswordSecurityKey(Zeroizing<String>, Zeroizing<Vec<u8>>),
}

struct VaultSource {
    kind: &'static str,
    handle: String,
    path: PathBuf,
}

pub struct HostRuntime {
    pub(crate) root: PathBuf,
    pub(crate) device_id: String,
    transfers: HashMap<String, TransferMetadata>,
    pub(crate) vaults: HashMap<String, Arc<MdbxVault>>,
    object_operations: ObjectOperationState,
    snapshot_operations: SnapshotOperationState,
    conflict_resolutions: ConflictResolutionState,
    attachment_reads: HashMap<String, AttachmentReadSession>,
    attachment_uploads: HashMap<String, AttachmentUploadSession>,
}

impl HostRuntime {
    pub fn open_default() -> std::io::Result<Self> {
        let base = env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("APPDATA"))
            .map(PathBuf::from)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "Windows application-data directory is unavailable",
                )
            })?;
        Self::new(base.join("Monica Extension").join("MDBX2"))
    }

    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        for directory in ["transfers", "imports", "vaults", "backups", "operations"] {
            fs::create_dir_all(root.join(directory))?;
        }
        for directory in ["sync/incoming", "sync/outbound", "sync/states"] {
            fs::create_dir_all(root.join(directory))?;
        }
        let device_id = load_or_create_device_id(&root)?;
        let transfers = load_transfers(&root)?;
        let object_operations = load_object_operation_state(&root)?;
        let snapshot_operations = load_snapshot_operation_state(&root)?;
        let conflict_resolutions = load_conflict_resolution_state(&root)?;
        Ok(Self {
            root,
            device_id,
            transfers,
            vaults: HashMap::new(),
            object_operations,
            snapshot_operations,
            conflict_resolutions,
            attachment_reads: HashMap::new(),
            attachment_uploads: HashMap::new(),
        })
    }

    pub fn handle(&mut self, method: &str, params: Value) -> Result<Value, RpcFailure> {
        match method {
            "host.hello" => self.host_hello(params),
            "transfer.begin" => self.transfer_begin(params),
            "transfer.chunk" => self.transfer_chunk(params),
            "transfer.finish" => self.transfer_finish(params),
            "transfer.abort" => self.transfer_abort(params),
            "vault.inspect" => self.vault_inspect(params),
            "vault.open" => self.vault_open(params),
            "vault.status" => self.vault_status(params),
            "vault.lock" => self.vault_lock(params),
            "collection.list" => self.collection_list(params),
            "object.list" => self.object_list(params),
            "object.reveal" => self.object_reveal(params),
            "object.upsert" => self.object_upsert(params),
            "object.delete" => self.object_delete(params),
            "object.batch" => self.object_batch(params),
            "object.operation.status" => self.object_operation_status(params),
            "object.operation.resolve" => self.object_operation_resolve(params),
            "history.list" => self.history_list(params),
            "history.diff" => self.history_diff(params),
            "history.revert" => self.history_revert(params),
            "snapshot.list" => self.snapshot_list(params),
            "snapshot.structure" => self.snapshot_structure(params),
            "snapshot.create" => self.snapshot_create(params),
            "snapshot.delete" => self.snapshot_delete(params),
            "snapshot.restore" => self.snapshot_restore(params),
            "conflict.list" => self.conflict_list(params),
            "conflict.resolve" => self.conflict_resolve(params),
            "attachment.list" => self.attachment_list(params),
            "attachment.read.begin" => self.attachment_read_begin(params),
            "attachment.read.chunk" => self.attachment_read_chunk(params),
            "attachment.read.release" => self.attachment_read_release(params),
            "attachment.upload.begin" => self.attachment_upload_begin(params),
            "attachment.upload.chunk" => self.attachment_upload_chunk(params),
            "attachment.upload.finish" => self.attachment_upload_finish(params),
            "attachment.upload.abort" => self.attachment_upload_abort(params),
            "attachment.delete" => self.attachment_delete(params),
            _ if cloud_sync::supports(method) => cloud_sync::handle(self, method, params),
            _ => Err(RpcFailure::new(
                "method-unsupported",
                "Native method is not supported by this Host version.",
                false,
            )),
        }
    }

    fn host_hello(&self, params: Value) -> Result<Value, RpcFailure> {
        let params = take_object(params, "host.hello params must be an object.")?;
        reject_unknown(params)?;
        let capabilities = mdbx_ffi::mdbx_build_capability_manifest();
        let mut result = json!({
            "hostName": HOST_NAME,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "protocolVersion": PROTOCOL_VERSION,
            "mdbxCoreRevision": MDBX_CORE_REVISION,
            "mdbxEngineVersion": capabilities.engine_version,
            "mdbxFormatVersion": MDBX_FORMAT_VERSION,
            "supportsMdbx1": false,
            "maxBinaryChunkBytes": MAX_BINARY_CHUNK_BYTES,
            "maxInboundFileBytes": MAX_INBOUND_FILE_BYTES,
            "maxActiveTransfers": MAX_ACTIVE_TRANSFERS,
            "maxObjectPayloadBytes": MAX_OBJECT_PAYLOAD_BYTES,
            "maxObjectBatchMutations": MAX_OBJECT_BATCH_MUTATIONS,
            "maxObjectBatchIntentBytes": MAX_OBJECT_BATCH_INTENT_BYTES,
            "maxHistoryPageSize": MAX_HISTORY_PAGE_SIZE,
            "maxHistoryResultBytes": MAX_HISTORY_RESULT_BYTES,
            "supportsHistoryDiff": true,
            "maxSnapshotPageSize": MAX_SNAPSHOT_PAGE_SIZE,
            "maxSnapshotStructurePageSize": MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE,
            "maxSnapshotResultBytes": MAX_SNAPSHOT_RESULT_BYTES,
            "maxSnapshotNameBytes": MAX_SNAPSHOT_NAME_BYTES,
            "supportsSnapshotStructure": true,
            "supportsSnapshotMutation": true,
            "maxConflictPageSize": MAX_CONFLICT_PAGE_SIZE,
            "maxConflictResultBytes": MAX_CONFLICT_RESULT_BYTES,
            "supportsConflictResolution": true,
            "maxAttachmentBytes": MAX_ATTACHMENT_BYTES,
            "maxAttachmentPageSize": MAX_ATTACHMENT_PAGE_SIZE,
            "maxAttachmentSessions": MAX_ATTACHMENT_SESSIONS,
            "maxAttachmentMemoryBytes": MAX_ATTACHMENT_MEMORY_BYTES,
            "supportsAttachmentManagement": true,
            "maxSummaryPageSize": MAX_SUMMARY_PAGE_SIZE,
            "supportsDurableCloudSync": true,
            "maxSyncSegmentPageSize": cloud_sync::SEGMENT_PAGE_SIZE,
            "maxBlobReferencePageSize": cloud_sync::MAX_BLOB_PAGE_SIZE,
            "maxRemoteBlobBytes": cloud_sync::MAX_REMOTE_BLOB_BYTES,
            "supportedUnlockMethods": ["password", "security-key", "password-security-key"],
            "storageProfile": capabilities.storage_profile,
            "syncProfile": capabilities.sync_profile,
            "syncProtocolVersion": capabilities.sync_protocol_version,
            "enabledStorageCapabilityIds": capabilities.enabled_storage_capability_ids,
            "enabledSyncCapabilityIds": capabilities.enabled_sync_capability_ids,
        });
        let result_object = result
            .as_object_mut()
            .ok_or_else(|| RpcFailure::storage("Native Host capability response is invalid."))?;
        result_object.insert(
            "maxHistoryRevertItems".to_string(),
            json!(MAX_HISTORY_REVERT_ITEMS),
        );
        result_object.insert("supportsHistoryRevert".to_string(), json!(true));
        Ok(result)
    }

    fn transfer_begin(&mut self, params: Value) -> Result<Value, RpcFailure> {
        if self.transfers.len() >= MAX_ACTIVE_TRANSFERS {
            return Err(RpcFailure::new(
                "transfer-limit-reached",
                "Native Host has too many active transfers.",
                true,
            ));
        }
        let mut params = take_object(params, "transfer.begin params must be an object.")?;
        let direction = take_string(&mut params, "direction", 64, false)?;
        if direction != "extension-to-host" {
            return Err(RpcFailure::invalid(
                "transfer.begin direction is unsupported.",
            ));
        }
        let purpose = match take_string(&mut params, "purpose", 64, false)?.as_str() {
            "vault-bootstrap" => TransferPurpose::VaultBootstrap,
            "sync-segment" => TransferPurpose::SyncSegment,
            _ => {
                return Err(RpcFailure::invalid(
                    "transfer.begin purpose is unsupported.",
                ))
            }
        };
        let size_bytes = take_u64(&mut params, "sizeBytes")?;
        if size_bytes == 0 || size_bytes > MAX_INBOUND_FILE_BYTES {
            return Err(RpcFailure::invalid(
                "transfer.begin size exceeds the reviewed limit.",
            ));
        }
        let sha256 = take_optional_string(&mut params, "sha256", 64)?;
        if sha256.as_deref().is_some_and(|value| !valid_sha256(value)) {
            return Err(RpcFailure::invalid(
                "transfer.begin sha256 must be a lowercase SHA-256 digest or null.",
            ));
        }
        reject_unknown(params)?;

        let transfer_id = fresh_uuid();
        let part_path = self.transfer_part_path(&transfer_id);
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|_| RpcFailure::storage("Native Host could not create transfer staging."))?;
        let metadata = TransferMetadata {
            version: TRANSFER_METADATA_VERSION,
            revision: 0,
            transfer_id: transfer_id.clone(),
            purpose,
            size_bytes,
            sha256,
            received_bytes: 0,
        };
        if let Err(error) = self.persist_transfer(&metadata) {
            let _ = fs::remove_file(&part_path);
            return Err(error);
        }
        self.transfers.insert(transfer_id.clone(), metadata);
        Ok(json!({
            "transferId": transfer_id,
            "nextOffset": 0,
            "maxChunkBytes": MAX_BINARY_CHUNK_BYTES
        }))
    }

    fn transfer_chunk(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "transfer.chunk params must be an object.")?;
        let transfer_id = take_uuid(&mut params, "transferId")?;
        let offset = take_u64(&mut params, "offset")?;
        let encoded = Zeroizing::new(take_string(
            &mut params,
            "dataBase64",
            MAX_BASE64_CHUNK_BYTES,
            false,
        )?);
        reject_unknown(params)?;
        let bytes = Zeroizing::new(
            BASE64
                .decode(encoded.as_bytes())
                .map_err(|_| RpcFailure::invalid("transfer.chunk dataBase64 is invalid."))?,
        );
        if bytes.is_empty() || bytes.len() > MAX_BINARY_CHUNK_BYTES {
            return Err(RpcFailure::invalid(
                "transfer.chunk exceeds the reviewed chunk limit.",
            ));
        }
        let metadata = self.transfers.get(&transfer_id).cloned().ok_or_else(|| {
            RpcFailure::new(
                "transfer-not-found",
                "Native transfer does not exist.",
                false,
            )
        })?;
        if offset > metadata.received_bytes {
            return Err(RpcFailure::new(
                "transfer-offset-mismatch",
                "Native transfer chunk does not start at the durable offset.",
                true,
            ));
        }
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| RpcFailure::invalid("transfer.chunk offset overflowed."))?;
        if end > metadata.size_bytes {
            return Err(RpcFailure::invalid(
                "transfer.chunk exceeds the declared transfer size.",
            ));
        }
        let part_path = self.transfer_part_path(&transfer_id);

        if offset < metadata.received_bytes {
            if end > metadata.received_bytes {
                return Err(RpcFailure::new(
                    "transfer-offset-mismatch",
                    "Native transfer chunk overlaps the durable offset.",
                    true,
                ));
            }
            let mut file = File::open(&part_path)
                .map_err(|_| RpcFailure::storage("Native transfer staging is unavailable."))?;
            file.seek(SeekFrom::Start(offset))
                .and_then(|_| {
                    let mut existing = vec![0_u8; bytes.len()];
                    file.read_exact(&mut existing)?;
                    if existing == bytes.as_slice() {
                        Ok(())
                    } else {
                        Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "chunk differs",
                        ))
                    }
                })
                .map_err(|_| {
                    RpcFailure::new(
                        "transfer-retry-mismatch",
                        "Retried transfer chunk differs from durable bytes.",
                        false,
                    )
                })?;
            return Ok(json!({
                "nextOffset": metadata.received_bytes,
                "acceptedBytes": 0,
                "repeated": true
            }));
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&part_path)
            .map_err(|_| RpcFailure::storage("Native transfer staging is unavailable."))?;
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.write_all(bytes.as_slice()))
            .and_then(|_| file.sync_data())
            .map_err(|_| RpcFailure::storage("Native transfer chunk could not be persisted."))?;

        let mut updated = metadata;
        updated.revision = updated.revision.saturating_add(1);
        updated.received_bytes = end;
        self.persist_transfer(&updated)?;
        self.transfers.insert(transfer_id, updated.clone());
        Ok(json!({
            "nextOffset": updated.received_bytes,
            "acceptedBytes": bytes.len(),
            "repeated": false
        }))
    }

    fn transfer_finish(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "transfer.finish params must be an object.")?;
        let transfer_id = take_uuid(&mut params, "transferId")?;
        reject_unknown(params)?;
        let metadata = self.transfers.get(&transfer_id).cloned().ok_or_else(|| {
            RpcFailure::new(
                "transfer-not-found",
                "Native transfer does not exist.",
                false,
            )
        })?;
        if metadata.received_bytes != metadata.size_bytes {
            return Err(RpcFailure::new(
                "transfer-incomplete",
                "Native transfer has not received every declared byte.",
                true,
            ));
        }
        let part_path = self.transfer_part_path(&transfer_id);
        let file = File::open(&part_path)
            .map_err(|_| RpcFailure::storage("Native transfer staging is unavailable."))?;
        if file
            .metadata()
            .map_err(|_| RpcFailure::storage("Native transfer staging metadata is unavailable."))?
            .len()
            != metadata.size_bytes
        {
            self.delete_transfer(&transfer_id);
            return Err(RpcFailure::new(
                "transfer-size-mismatch",
                "Native transfer size verification failed.",
                false,
            ));
        }
        let actual_sha256 = hash_file(file)?;
        if metadata
            .sha256
            .as_deref()
            .is_some_and(|expected| actual_sha256 != expected)
        {
            self.delete_transfer(&transfer_id);
            return Err(RpcFailure::new(
                "transfer-digest-mismatch",
                "Native transfer SHA-256 verification failed.",
                false,
            ));
        }

        let (file_handle, destination) = loop {
            let handle = fresh_uuid();
            let destination = match metadata.purpose {
                TransferPurpose::VaultBootstrap => self.import_file_path(&handle),
                TransferPurpose::SyncSegment => self.sync_inbound_segment_path(&handle),
            };
            if !destination.exists() {
                break (handle, destination);
            }
        };
        fs::rename(&part_path, &destination)
            .map_err(|_| RpcFailure::storage("Native transfer could not be published."))?;
        self.transfers.remove(&transfer_id);
        self.delete_transfer_states(&transfer_id);
        Ok(json!({
            "fileHandle": file_handle,
            "purpose": metadata.purpose,
            "sizeBytes": metadata.size_bytes,
            "sha256": actual_sha256
        }))
    }

    fn transfer_abort(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "transfer.abort params must be an object.")?;
        let transfer_id = take_uuid(&mut params, "transferId")?;
        reject_unknown(params)?;
        let existed = self.transfers.contains_key(&transfer_id)
            || self.transfer_part_path(&transfer_id).exists()
            || self.transfer_state_path(&transfer_id, 0).exists()
            || self.transfer_state_path(&transfer_id, 1).exists();
        self.delete_transfer(&transfer_id);
        Ok(json!({ "aborted": existed }))
    }

    fn vault_inspect(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "vault.inspect params must be an object.")?;
        let source = self.take_vault_source(&mut params)?;
        reject_unknown(params)?;
        let info = inspect_exact_mdbx2(&source.path)?;
        Ok(migration_json(&source, &info))
    }

    fn vault_open(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "vault.open params must be an object.")?;
        let source = self.take_vault_source(&mut params)?;
        let credential = take_credential(&mut params)?;
        reject_unknown(params)?;
        let before = inspect_exact_mdbx2(&source.path)?;

        let is_import = source.kind == "file";
        let vault_handle = if is_import {
            fresh_uuid()
        } else {
            source.handle.clone()
        };
        if self.vaults.contains_key(&vault_handle) {
            return Err(RpcFailure::new(
                "vault-already-open",
                "MDBX2 vault is already open in this Host session.",
                false,
            ));
        }
        let vault_directory = self.root.join("vaults").join(&vault_handle);
        let working_path = vault_directory.join("vault.mdbx");
        let created_working_copy = if is_import {
            fs::create_dir(&vault_directory).map_err(|_| {
                RpcFailure::storage("Native Host could not create the vault working directory.")
            })?;
            if let Err(error) = copy_create_new(&source.path, &working_path) {
                let _ = fs::remove_dir(&vault_directory);
                return Err(error);
            }
            true
        } else {
            false
        };

        let backup_created = if before.requires_upgrade {
            match self.create_pre_upgrade_backup(&vault_handle, &working_path) {
                Ok(()) => true,
                Err(error) => {
                    if created_working_copy {
                        let _ = fs::remove_file(&working_path);
                        let _ = fs::remove_dir(&vault_directory);
                    }
                    return Err(error);
                }
            }
        } else {
            false
        };

        let path = path_string(&working_path)?;
        let opened = match credential {
            VaultCredential::Password(password) => {
                mdbx_ffi::open_vault(path, password.to_string(), self.device_id.clone())
            }
            VaultCredential::SecurityKey(key_material) => mdbx_ffi::open_vault_with_security_key(
                path,
                key_material.to_vec(),
                self.device_id.clone(),
            ),
            VaultCredential::PasswordSecurityKey(password, key_material) => {
                mdbx_ffi::open_vault_with_password_security_key(
                    path,
                    password.to_string(),
                    key_material.to_vec(),
                    self.device_id.clone(),
                )
            }
        };
        let vault = match opened {
            Ok(vault) => vault,
            Err(_) => {
                if created_working_copy {
                    let _ = fs::remove_file(&working_path);
                    let _ = fs::remove_file(format!("{}-wal", working_path.display()));
                    let _ = fs::remove_file(format!("{}-shm", working_path.display()));
                    let _ = fs::remove_dir(&vault_directory);
                }
                return Err(RpcFailure::new(
                    "vault-unlock-failed",
                    "MDBX2 vault could not be unlocked with the supplied method.",
                    false,
                ));
            }
        };
        let after = inspect_exact_mdbx2(&working_path)?;
        let info = vault.info();
        let health = vault.health_check().map_err(|_| {
            RpcFailure::new(
                "vault-health-check-failed",
                "MDBX2 vault health check failed.",
                false,
            )
        })?;
        let diagnostics = vault.diagnostics_summary().map_err(|_| {
            RpcFailure::new(
                "vault-diagnostics-failed",
                "MDBX2 vault diagnostics failed.",
                false,
            )
        })?;
        self.vaults.insert(vault_handle.clone(), vault);
        if is_import {
            let _ = fs::remove_file(&source.path);
        }

        Ok(json!({
            "vaultHandle": vault_handle,
            "vaultId": info.vault_id,
            "deviceId": info.device_id,
            "formatVersion": MDBX_FORMAT_VERSION,
            "schemaVersion": after.schema_version,
            "migrated": before.requires_upgrade,
            "preUpgradeBackupCreated": backup_created,
            "health": {
                "healthy": health.healthy,
                "issueCount": health.issues.len()
            },
            "diagnostics": {
                "commitCount": diagnostics.commit_count,
                "tombstoneCount": diagnostics.tombstone_count,
                "branchCount": diagnostics.branch_count,
                "deviceCount": diagnostics.device_count,
                "snapshotCount": diagnostics.snapshot_count,
                "unresolvedConflictCount": diagnostics.unresolved_conflict_count,
                "projectCount": diagnostics.project_count,
                "deletedProjectCount": diagnostics.deleted_project_count,
                "entryCount": diagnostics.entry_count,
                "deletedEntryCount": diagnostics.deleted_entry_count,
                "attachmentCount": diagnostics.attachment_count,
                "deletedAttachmentCount": diagnostics.deleted_attachment_count,
                "externalAttachmentCount": diagnostics.external_attachment_count,
                "originalAttachmentBytes": diagnostics.original_attachment_bytes,
                "storedAttachmentBytes": diagnostics.stored_attachment_bytes
            }
        }))
    }

    fn vault_lock(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "vault.lock params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        reject_unknown(params)?;
        let locked = self.vaults.remove(&vault_handle).is_some();
        self.attachment_reads
            .retain(|_, session| session.vault_handle != vault_handle);
        self.attachment_uploads
            .retain(|_, session| session.vault_handle != vault_handle);
        Ok(json!({ "locked": locked }))
    }

    fn vault_status(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "vault.status params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        reject_unknown(params)?;
        let available = self
            .root
            .join("vaults")
            .join(&vault_handle)
            .join("vault.mdbx")
            .is_file();
        Ok(json!({
            "vaultHandle": vault_handle,
            "open": self.vaults.contains_key(&vault_handle),
            "available": available
        }))
    }

    fn collection_list(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "collection.list params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let deleted = take_optional_bool(&mut params, "deleted")?.unwrap_or(false);
        let page_size = take_page_size(&mut params)?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let page = if deleted {
            vault.list_deleted_collection_summaries(page_size, cursor)
        } else {
            vault.list_collection_summaries(page_size, cursor)
        }
        .map_err(|_| {
            RpcFailure::new(
                "collection-list-failed",
                "MDBX2 Collection summaries could not be read.",
                false,
            )
        })?;
        Ok(json!({
            "items": page.items.into_iter().map(|item| json!({
                "collectionId": item.collection_id,
                "title": item.title,
                "collectionTypeId": item.collection_type_id,
                "profileSchemaVersion": item.profile_schema_version,
                "groupId": item.group_id,
                "iconRef": item.icon_ref,
                "favorite": item.favorite,
                "archived": item.archived,
                "attachmentCount": item.attachment_count,
                "headCommitId": item.head_commit_id,
                "deleted": item.deleted,
                "updatedAt": item.updated_at
            })).collect::<Vec<_>>(),
            "nextCursor": page.next_cursor
        }))
    }

    fn object_list(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.list params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let collection_id = take_uuid(&mut params, "collectionId")?;
        let object_type_id =
            take_optional_string(&mut params, "objectTypeId", MAX_OBJECT_TYPE_ID_BYTES)?;
        let deleted = take_optional_bool(&mut params, "deleted")?.unwrap_or(false);
        let page_size = take_page_size(&mut params)?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let page = if deleted {
            vault.list_deleted_object_summaries(collection_id, object_type_id, page_size, cursor)
        } else {
            vault.list_object_summaries(collection_id, object_type_id, page_size, cursor)
        }
        .map_err(|_| {
            RpcFailure::new(
                "object-list-failed",
                "MDBX2 Object summaries could not be read.",
                false,
            )
        })?;
        Ok(json!({
            "items": page.items.into_iter().map(object_summary_json).collect::<Vec<_>>(),
            "nextCursor": page.next_cursor
        }))
    }

    fn object_reveal(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.reveal params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let object_id = take_uuid(&mut params, "objectId")?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let disclosure = vault
            .reveal_object_with_limits(
                object_id,
                MdbxObjectDisclosureLimits {
                    max_payload_bytes: MAX_OBJECT_PAYLOAD_BYTES as u64,
                },
            )
            .map_err(|_| {
                RpcFailure::new(
                    "object-reveal-failed",
                    "MDBX2 Object disclosure failed.",
                    false,
                )
            })?;
        let object = disclosure.object.ok_or_else(|| {
            RpcFailure::new(
                "object-disclosure-denied",
                "MDBX2 Tiga policy did not authorize Object disclosure for this browser context.",
                false,
            )
        })?;
        if object.payload_json.len() > MAX_OBJECT_PAYLOAD_BYTES {
            return Err(RpcFailure::new(
                "object-payload-too-large",
                "MDBX2 Object payload exceeds the browser disclosure limit.",
                false,
            ));
        }
        Ok(json!({
            "objectId": object.object_id,
            "collectionId": object.collection_id,
            "objectTypeId": object.object_type_id,
            "title": object.title,
            "payloadJson": object.payload_json,
            "payloadSchemaVersion": object.payload_schema_version,
            "deleted": object.deleted
        }))
    }

    fn history_list(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "history.list params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let page_size = take_bounded_page_size(
            &mut params,
            MAX_HISTORY_PAGE_SIZE,
            "pageSize exceeds the MDBX2 history limit.",
        )?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let page = vault.list_commit_history(page_size, cursor).map_err(|_| {
            RpcFailure::new(
                "history-list-failed",
                "MDBX2 commit history could not be read.",
                false,
            )
        })?;
        let value = json!({
            "items": page.items.into_iter().map(|item| json!({
                "commitId": item.commit_id,
                "deviceId": item.device_id,
                "localSeq": item.local_seq,
                "commitKind": item.commit_kind,
                "changeScope": item.change_scope,
                "createdAt": item.created_at,
                "operationId": item.operation_id,
                "operationKind": item.operation_kind,
                "branchName": item.branch_name,
                "message": item.message,
                "changes": item.changes.into_iter().map(|change| json!({
                    "objectType": change.object_type,
                    "objectId": change.object_id,
                    "action": change.action,
                    "fields": change.fields
                })).collect::<Vec<_>>(),
                "parentIds": item.parent_ids,
                "legacy": item.legacy
            })).collect::<Vec<_>>(),
            "nextCursor": page.next_cursor
        });
        bounded_history_result(value)
    }

    fn history_diff(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "history.diff params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let commit_id = take_uuid(&mut params, "commitId")?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let diffs = vault.list_commit_diff(commit_id).map_err(|error| {
            let diagnostic = error.to_string().to_ascii_lowercase();
            if diagnostic.contains("resource limit") || diagnostic.contains("commit diff objects") {
                RpcFailure::new(
                    "history-diff-too-large",
                    "MDBX2 commit contains too many Objects to expand in one browser view.",
                    false,
                )
            } else {
                RpcFailure::new(
                    "history-diff-failed",
                    "MDBX2 commit details could not be read.",
                    false,
                )
            }
        })?;
        let items = diffs
            .into_iter()
            .map(|diff| {
                let content_type = vault
                    .get_object_summary(diff.object_id.clone())
                    .ok()
                    .flatten()
                    .map(|summary| summary.object_type_id);
                let payload_changed = diff.previous_payload_preview != diff.current_payload_preview
                    || diff
                        .changed_fields
                        .iter()
                        .any(|field| field.eq_ignore_ascii_case("payload"));
                json!({
                    "commitId": diff.commit_id,
                    "objectType": diff.object_type,
                    "objectId": diff.object_id,
                    "collectionId": diff.collection_id,
                    "previousTitle": diff.previous_title,
                    "currentTitle": diff.current_title,
                    "previousDeleted": diff.previous_deleted,
                    "currentDeleted": diff.current_deleted,
                    "changedFields": diff.changed_fields,
                    "payloadChanged": payload_changed,
                    "contentType": content_type,
                    "createdAt": diff.created_at
                })
            })
            .collect::<Vec<_>>();
        bounded_history_result(json!({ "items": items }))
    }

    fn history_revert(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "history.revert params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let commit_id = take_uuid(&mut params, "commitId")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let history = vault
            .get_commit_history(commit_id.clone())
            .map_err(|_| {
                RpcFailure::new(
                    "history-revert-inspection-failed",
                    "MDBX2 commit eligibility could not be inspected.",
                    false,
                )
            })?
            .ok_or_else(|| {
                RpcFailure::new(
                    "history-revert-not-found",
                    "MDBX2 commit is no longer available.",
                    false,
                )
            })?;
        validate_history_revert_eligibility(&history)?;
        let result = vault
            .revert_commit(
                commit_id,
                operation_id.clone(),
                browser_management_device_context(),
            )
            .map_err(history_revert_failure)?;
        Ok(json!({
            "operationId": operation_id,
            "commitId": result.commit_id,
            "revertedObjectCount": result.reverted_object_count
        }))
    }

    fn snapshot_list(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "snapshot.list params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let page_size = take_bounded_page_size(
            &mut params,
            MAX_SNAPSHOT_PAGE_SIZE,
            "pageSize exceeds the MDBX2 snapshot limit.",
        )?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let page = vault
            .list_managed_snapshots(page_size, cursor)
            .map_err(|_| {
                RpcFailure::new(
                    "snapshot-list-failed",
                    "MDBX2 managed snapshots could not be read.",
                    false,
                )
            })?;
        let items = page
            .items
            .into_iter()
            .map(snapshot_summary_json)
            .collect::<Result<Vec<_>, _>>()?;
        bounded_snapshot_result(json!({
            "items": items,
            "nextCursor": page.next_cursor
        }))
    }

    fn snapshot_structure(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "snapshot.structure params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let snapshot_id = take_uuid(&mut params, "snapshotId")?;
        let side = take_snapshot_structure_side(&mut params)?;
        let page_size = take_bounded_page_size(
            &mut params,
            MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE,
            "pageSize exceeds the MDBX2 snapshot structure limit.",
        )?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let preview = vault
            .get_snapshot_structure_preview(snapshot_id.clone())
            .map_err(snapshot_structure_failure)?;
        let current_item_count = preview.current_item_count;
        let snapshot_item_count = preview.snapshot_item_count;
        let root_ids = preview
            .current_nodes
            .iter()
            .chain(preview.snapshot_nodes.iter())
            .filter(|node| {
                node.node_type.eq_ignore_ascii_case("folder")
                    && node.name == MONICA_ROOT_PROJECT_TITLE
            })
            .map(|node| node.id.clone())
            .collect::<HashSet<_>>();
        let nodes = normalize_snapshot_structure_nodes(
            match side {
                SnapshotStructureSide::Current => preview.current_nodes,
                SnapshotStructureSide::Snapshot => preview.snapshot_nodes,
            },
            &root_ids,
        );
        for node in &nodes {
            validate_snapshot_structure_node(node)?;
        }
        let total_nodes = u32::try_from(nodes.len()).map_err(|_| {
            RpcFailure::new(
                "snapshot-structure-too-large",
                "MDBX2 snapshot structure exceeds the browser node limit.",
                false,
            )
        })?;
        let fingerprint = snapshot_structure_fingerprint(
            &snapshot_id,
            side,
            current_item_count,
            snapshot_item_count,
            &nodes,
        );
        let offset = match cursor {
            Some(value) => {
                let decoded = decode_snapshot_structure_cursor(&value)?;
                if decoded.vault_handle != vault_handle
                    || decoded.snapshot_id != snapshot_id
                    || decoded.side != side
                {
                    return Err(RpcFailure::invalid(
                        "snapshot structure cursor does not match the request.",
                    ));
                }
                if decoded.total_nodes != total_nodes || decoded.fingerprint != fingerprint {
                    return Err(RpcFailure::new(
                        "snapshot-structure-stale",
                        "MDBX2 snapshot structure changed while it was being paged; reload the preview.",
                        true,
                    ));
                }
                if decoded.offset >= total_nodes {
                    return Err(RpcFailure::invalid(
                        "snapshot structure cursor is beyond the available nodes.",
                    ));
                }
                decoded.offset as usize
            }
            None => 0,
        };
        let end = offset.saturating_add(page_size as usize).min(nodes.len());
        let items = nodes[offset..end]
            .iter()
            .map(snapshot_structure_node_json)
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = if end < nodes.len() {
            Some(encode_snapshot_structure_cursor(
                &vault_handle,
                &snapshot_id,
                side,
                end as u32,
                total_nodes,
                &fingerprint,
            )?)
        } else {
            None
        };
        bounded_snapshot_result(json!({
            "snapshotId": snapshot_id,
            "side": side.as_str(),
            "currentItemCount": current_item_count,
            "snapshotItemCount": snapshot_item_count,
            "totalNodes": total_nodes,
            "items": items,
            "nextCursor": next_cursor
        }))
    }

    fn snapshot_create(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "snapshot.create params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let name = take_string(&mut params, "name", MAX_SNAPSHOT_TEXT_BYTES, true)?;
        reject_unknown(params)?;
        let name = name.trim().to_string();
        if name.len() > MAX_SNAPSHOT_NAME_BYTES {
            return Err(RpcFailure::invalid(
                "name exceeds the MDBX2 snapshot display-name limit.",
            ));
        }
        let intent_sha256 = snapshot_operation_intent_sha256(json!({
            "kind": "create",
            "name": name
        }))?;
        let vault = self.require_open_vault(&vault_handle)?;

        if let Some(receipt) = self
            .snapshot_operation_receipt(&vault_handle, &operation_id)
            .or_else(|| {
                self.pending_snapshot_operation_by_intent(
                    &vault_handle,
                    SnapshotOperationKind::Create,
                    &intent_sha256,
                    None,
                )
            })
        {
            validate_snapshot_operation_intent(
                &receipt,
                SnapshotOperationKind::Create,
                &intent_sha256,
                None,
            )?;
            if receipt.completed {
                return snapshot_create_result_json(&receipt, true);
            }
            if receipt.outcome_unknown {
                return Err(snapshot_operation_unknown_failure());
            }
            return self.resume_snapshot_create(&vault, &receipt, &name);
        }

        self.ensure_no_pending_snapshot_operation(&vault_handle)?;
        let baseline = snapshot_operation_baseline(&vault, &self.device_id)?;
        self.prepare_snapshot_operation(SnapshotOperationReceipt {
            vault_handle: vault_handle.clone(),
            operation_id: operation_id.clone(),
            kind: SnapshotOperationKind::Create,
            intent_sha256,
            target_snapshot_id: None,
            target_base_commit_id: None,
            pre_branch_state_sha256: baseline.branch_state_sha256,
            pre_device_local_seq: baseline.device_local_seq,
            completed: false,
            outcome_unknown: false,
            result_snapshot_id: None,
            result_commit_id: None,
            affected_object_count: None,
            updated_at_unix_secs: unix_seconds()?,
        })?;
        self.execute_snapshot_create(&vault, &vault_handle, &operation_id, &name)
    }

    fn snapshot_delete(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "snapshot.delete params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let snapshot_id = take_uuid(&mut params, "snapshotId")?;
        reject_unknown(params)?;
        let intent_sha256 = snapshot_operation_intent_sha256(json!({
            "kind": "delete",
            "snapshotId": snapshot_id
        }))?;
        let vault = self.require_open_vault(&vault_handle)?;

        if let Some(receipt) = self
            .snapshot_operation_receipt(&vault_handle, &operation_id)
            .or_else(|| {
                self.pending_snapshot_operation_by_intent(
                    &vault_handle,
                    SnapshotOperationKind::Delete,
                    &intent_sha256,
                    Some(&snapshot_id),
                )
            })
        {
            validate_snapshot_operation_intent(
                &receipt,
                SnapshotOperationKind::Delete,
                &intent_sha256,
                Some(&snapshot_id),
            )?;
            if receipt.completed {
                return snapshot_delete_result_json(&receipt, true);
            }
            if receipt.outcome_unknown {
                return Err(snapshot_operation_unknown_failure());
            }
            let current = find_managed_snapshot(&vault, &snapshot_id)?;
            if current.is_none() {
                let commit_id = find_snapshot_delete_commit(
                    &vault,
                    &self.device_id,
                    receipt.pre_device_local_seq,
                    &snapshot_id,
                )?;
                let completed = self.complete_snapshot_operation(
                    &vault_handle,
                    &receipt.operation_id,
                    None,
                    commit_id,
                    None,
                )?;
                return snapshot_delete_result_json(&completed, true);
            }
            if current.as_ref().is_some_and(|summary| {
                Some(summary.base_commit_id.as_str()) != receipt.target_base_commit_id.as_deref()
            }) {
                return self.mark_snapshot_operation_unknown(&vault_handle, &operation_id);
            }
            return self.execute_snapshot_delete(
                &vault,
                &vault_handle,
                &receipt.operation_id,
                &snapshot_id,
            );
        }

        self.ensure_no_pending_snapshot_operation(&vault_handle)?;
        let summary = find_managed_snapshot(&vault, &snapshot_id)?.ok_or_else(|| {
            RpcFailure::new(
                "snapshot-not-found",
                "MDBX2 snapshot is no longer available.",
                false,
            )
        })?;
        let baseline = snapshot_operation_baseline(&vault, &self.device_id)?;
        self.prepare_snapshot_operation(SnapshotOperationReceipt {
            vault_handle: vault_handle.clone(),
            operation_id: operation_id.clone(),
            kind: SnapshotOperationKind::Delete,
            intent_sha256,
            target_snapshot_id: Some(snapshot_id.clone()),
            target_base_commit_id: Some(summary.base_commit_id),
            pre_branch_state_sha256: baseline.branch_state_sha256,
            pre_device_local_seq: baseline.device_local_seq,
            completed: false,
            outcome_unknown: false,
            result_snapshot_id: None,
            result_commit_id: None,
            affected_object_count: None,
            updated_at_unix_secs: unix_seconds()?,
        })?;
        self.execute_snapshot_delete(&vault, &vault_handle, &operation_id, &snapshot_id)
    }

    fn snapshot_restore(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "snapshot.restore params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let snapshot_id = take_uuid(&mut params, "snapshotId")?;
        reject_unknown(params)?;
        let intent_sha256 = snapshot_operation_intent_sha256(json!({
            "kind": "restore",
            "snapshotId": snapshot_id
        }))?;
        let vault = self.require_open_vault(&vault_handle)?;

        if let Some(receipt) = self
            .snapshot_operation_receipt(&vault_handle, &operation_id)
            .or_else(|| {
                self.pending_snapshot_operation_by_intent(
                    &vault_handle,
                    SnapshotOperationKind::Restore,
                    &intent_sha256,
                    Some(&snapshot_id),
                )
            })
        {
            validate_snapshot_operation_intent(
                &receipt,
                SnapshotOperationKind::Restore,
                &intent_sha256,
                Some(&snapshot_id),
            )?;
            if receipt.completed {
                return snapshot_restore_result_json(&receipt, true);
            }
            if receipt.outcome_unknown {
                return Err(snapshot_operation_unknown_failure());
            }
            return self.resume_snapshot_restore(&vault, &receipt, &snapshot_id);
        }

        self.ensure_no_pending_snapshot_operation(&vault_handle)?;
        let summary = require_restorable_snapshot(&vault, &snapshot_id)?;
        let baseline = snapshot_operation_baseline(&vault, &self.device_id)?;
        self.prepare_snapshot_operation(SnapshotOperationReceipt {
            vault_handle: vault_handle.clone(),
            operation_id: operation_id.clone(),
            kind: SnapshotOperationKind::Restore,
            intent_sha256,
            target_snapshot_id: Some(snapshot_id.clone()),
            target_base_commit_id: Some(summary.base_commit_id),
            pre_branch_state_sha256: baseline.branch_state_sha256,
            pre_device_local_seq: baseline.device_local_seq,
            completed: false,
            outcome_unknown: false,
            result_snapshot_id: None,
            result_commit_id: None,
            affected_object_count: None,
            updated_at_unix_secs: unix_seconds()?,
        })?;
        self.execute_snapshot_restore(&vault, &vault_handle, &operation_id, &snapshot_id)
    }

    fn resume_snapshot_create(
        &mut self,
        vault: &Arc<MdbxVault>,
        receipt: &SnapshotOperationReceipt,
        requested_name: &str,
    ) -> Result<Value, RpcFailure> {
        let commits =
            match snapshot_commits_after(vault, &self.device_id, receipt.pre_device_local_seq) {
                Ok(commits) => commits,
                Err(error) if error.code == "snapshot-operation-state-unknown" => {
                    return self.mark_snapshot_operation_unknown(
                        &receipt.vault_handle,
                        &receipt.operation_id,
                    )
                }
                Err(error) => return Err(error),
            };
        let mut candidates = Vec::new();
        for commit in commits
            .iter()
            .filter(|commit| is_legacy_snapshot_commit(commit))
        {
            if commit.changes.len() != 1 {
                continue;
            }
            let snapshot_id = &commit.changes[0].object_id;
            let Some(summary) = find_managed_snapshot(vault, snapshot_id)? else {
                continue;
            };
            if summary.base_commit_id == commit.commit_id
                && summary.created_by_device_id == self.device_id
                && summary.kind == MdbxSnapshotKind::Manual
                && summary.is_full
                && !summary.auto_prune
                && snapshot_name_matches_request(&summary, requested_name)
            {
                candidates.push((summary.snapshot_id, commit.commit_id.clone()));
            }
        }
        if candidates.len() == 1 {
            let (snapshot_id, commit_id) = candidates.remove(0);
            let completed = self.complete_snapshot_operation(
                &receipt.vault_handle,
                &receipt.operation_id,
                Some(snapshot_id),
                Some(commit_id),
                None,
            )?;
            return snapshot_create_result_json(&completed, true);
        }
        if !candidates.is_empty()
            || snapshot_branch_state_sha256(vault)? != receipt.pre_branch_state_sha256
        {
            return self
                .mark_snapshot_operation_unknown(&receipt.vault_handle, &receipt.operation_id);
        }
        self.execute_snapshot_create(
            vault,
            &receipt.vault_handle,
            &receipt.operation_id,
            requested_name,
        )
    }

    fn resume_snapshot_restore(
        &mut self,
        vault: &Arc<MdbxVault>,
        receipt: &SnapshotOperationReceipt,
        snapshot_id: &str,
    ) -> Result<Value, RpcFailure> {
        let summary = require_restorable_snapshot(vault, snapshot_id)?;
        if Some(summary.base_commit_id.as_str()) != receipt.target_base_commit_id.as_deref() {
            return self
                .mark_snapshot_operation_unknown(&receipt.vault_handle, &receipt.operation_id);
        }
        let commits =
            match snapshot_commits_after(vault, &self.device_id, receipt.pre_device_local_seq) {
                Ok(commits) => commits,
                Err(error) if error.code == "snapshot-operation-state-unknown" => {
                    return self.mark_snapshot_operation_unknown(
                        &receipt.vault_handle,
                        &receipt.operation_id,
                    )
                }
                Err(error) => return Err(error),
            };
        let mut candidates = commits
            .into_iter()
            .filter(|commit| {
                is_legacy_snapshot_commit(commit)
                    && receipt
                        .target_base_commit_id
                        .as_ref()
                        .is_some_and(|base| commit.parent_ids.iter().any(|parent| parent == base))
                    && commit
                        .changes
                        .iter()
                        .any(|change| change.object_id == snapshot_id)
            })
            .collect::<Vec<_>>();
        if candidates.len() == 1 {
            let commit = candidates.remove(0);
            let affected_object_count = restore_affected_object_count(&commit, snapshot_id)?;
            let completed = self.complete_snapshot_operation(
                &receipt.vault_handle,
                &receipt.operation_id,
                None,
                Some(commit.commit_id),
                Some(affected_object_count),
            )?;
            return snapshot_restore_result_json(&completed, true);
        }
        if !candidates.is_empty()
            || snapshot_branch_state_sha256(vault)? != receipt.pre_branch_state_sha256
        {
            return self
                .mark_snapshot_operation_unknown(&receipt.vault_handle, &receipt.operation_id);
        }
        self.execute_snapshot_restore(
            vault,
            &receipt.vault_handle,
            &receipt.operation_id,
            snapshot_id,
        )
    }

    fn execute_snapshot_create(
        &mut self,
        vault: &Arc<MdbxVault>,
        vault_handle: &str,
        operation_id: &str,
        name: &str,
    ) -> Result<Value, RpcFailure> {
        let created = vault
            .create_manual_snapshot(name.to_string(), browser_snapshot_device_context())
            .map_err(|error| snapshot_mutation_failure(SnapshotOperationKind::Create, error))?;
        let completed = self.complete_snapshot_operation(
            vault_handle,
            operation_id,
            Some(created.snapshot_id),
            Some(created.base_commit_id),
            None,
        )?;
        snapshot_create_result_json(&completed, false)
    }

    fn execute_snapshot_delete(
        &mut self,
        vault: &Arc<MdbxVault>,
        vault_handle: &str,
        operation_id: &str,
        snapshot_id: &str,
    ) -> Result<Value, RpcFailure> {
        let deleted = vault
            .delete_snapshot(snapshot_id.to_string(), browser_snapshot_device_context())
            .map_err(|error| snapshot_mutation_failure(SnapshotOperationKind::Delete, error))?;
        let completed = self.complete_snapshot_operation(
            vault_handle,
            operation_id,
            None,
            Some(deleted.commit_id),
            None,
        )?;
        snapshot_delete_result_json(&completed, false)
    }

    fn execute_snapshot_restore(
        &mut self,
        vault: &Arc<MdbxVault>,
        vault_handle: &str,
        operation_id: &str,
        snapshot_id: &str,
    ) -> Result<Value, RpcFailure> {
        let restored = vault
            .restore_snapshot(snapshot_id.to_string(), browser_snapshot_device_context())
            .map_err(|error| snapshot_mutation_failure(SnapshotOperationKind::Restore, error))?;
        let completed = self.complete_snapshot_operation(
            vault_handle,
            operation_id,
            None,
            Some(restored.commit_id),
            Some(restored.affected_object_count),
        )?;
        snapshot_restore_result_json(&completed, false)
    }

    fn snapshot_operation_receipt(
        &self,
        vault_handle: &str,
        operation_id: &str,
    ) -> Option<SnapshotOperationReceipt> {
        self.snapshot_operations
            .receipts
            .iter()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .cloned()
    }

    fn pending_snapshot_operation_by_intent(
        &self,
        vault_handle: &str,
        kind: SnapshotOperationKind,
        intent_sha256: &str,
        target_snapshot_id: Option<&str>,
    ) -> Option<SnapshotOperationReceipt> {
        self.snapshot_operations
            .receipts
            .iter()
            .filter(|receipt| {
                receipt.vault_handle == vault_handle
                    && receipt.kind == kind
                    && receipt.intent_sha256 == intent_sha256
                    && receipt.target_snapshot_id.as_deref() == target_snapshot_id
                    && !receipt.completed
                    && !receipt.outcome_unknown
            })
            .max_by_key(|receipt| receipt.updated_at_unix_secs)
            .cloned()
    }

    fn ensure_no_pending_snapshot_operation(&self, vault_handle: &str) -> Result<(), RpcFailure> {
        if self.snapshot_operations.receipts.iter().any(|receipt| {
            receipt.vault_handle == vault_handle && !receipt.completed && !receipt.outcome_unknown
        }) {
            return Err(RpcFailure::new(
                "snapshot-operation-pending",
                "MDBX2 has an unfinished snapshot operation for this vault; retry that operation first.",
                false,
            ));
        }
        Ok(())
    }

    fn prepare_snapshot_operation(
        &mut self,
        receipt: SnapshotOperationReceipt,
    ) -> Result<(), RpcFailure> {
        let mut next_state = self.snapshot_operations.clone();
        prune_snapshot_operation_receipts(&mut next_state.receipts)?;
        next_state.receipts.push(receipt);
        let previous_state = std::mem::replace(&mut self.snapshot_operations, next_state);
        if let Err(cause) = self.persist_snapshot_operations() {
            self.snapshot_operations = previous_state;
            return Err(cause);
        }
        Ok(())
    }

    fn complete_snapshot_operation(
        &mut self,
        vault_handle: &str,
        operation_id: &str,
        result_snapshot_id: Option<String>,
        result_commit_id: Option<String>,
        affected_object_count: Option<u32>,
    ) -> Result<SnapshotOperationReceipt, RpcFailure> {
        let mut next_state = self.snapshot_operations.clone();
        let receipt = next_state
            .receipts
            .iter_mut()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .ok_or_else(|| RpcFailure::storage("MDBX2 snapshot operation receipt is missing."))?;
        receipt.completed = true;
        receipt.outcome_unknown = false;
        receipt.result_snapshot_id = result_snapshot_id;
        receipt.result_commit_id = result_commit_id;
        receipt.affected_object_count = affected_object_count;
        receipt.updated_at_unix_secs = unix_seconds()?;
        let result = receipt.clone();
        let previous_state = std::mem::replace(&mut self.snapshot_operations, next_state);
        if let Err(cause) = self.persist_snapshot_operations() {
            self.snapshot_operations = previous_state;
            return Err(cause);
        }
        Ok(result)
    }

    fn mark_snapshot_operation_unknown(
        &mut self,
        vault_handle: &str,
        operation_id: &str,
    ) -> Result<Value, RpcFailure> {
        let mut next_state = self.snapshot_operations.clone();
        let receipt = next_state
            .receipts
            .iter_mut()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .ok_or_else(|| RpcFailure::storage("MDBX2 snapshot operation receipt is missing."))?;
        receipt.outcome_unknown = true;
        receipt.updated_at_unix_secs = unix_seconds()?;
        let previous_state = std::mem::replace(&mut self.snapshot_operations, next_state);
        if let Err(cause) = self.persist_snapshot_operations() {
            self.snapshot_operations = previous_state;
            return Err(cause);
        }
        Err(snapshot_operation_unknown_failure())
    }

    fn persist_snapshot_operations(&mut self) -> Result<(), RpcFailure> {
        self.snapshot_operations.revision = self
            .snapshot_operations
            .revision
            .checked_add(1)
            .ok_or_else(|| RpcFailure::storage("MDBX2 snapshot operation revision overflowed."))?;
        let bytes = serde_json::to_vec(&self.snapshot_operations).map_err(|_| {
            RpcFailure::storage("MDBX2 snapshot operation state could not be encoded.")
        })?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_SNAPSHOT_OPERATION_STATE_BYTES {
            return Err(RpcFailure::new(
                "snapshot-operation-state-too-large",
                "MDBX2 snapshot operation state exceeds the reviewed limit.",
                false,
            ));
        }
        let path = snapshot_operation_state_path(&self.root, self.snapshot_operations.revision % 2);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|_| {
                RpcFailure::storage("MDBX2 snapshot operation state could not be opened.")
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                RpcFailure::storage("MDBX2 snapshot operation state could not be persisted.")
            })
    }

    fn conflict_list(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "conflict.list params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let page_size = take_bounded_page_size(
            &mut params,
            MAX_CONFLICT_PAGE_SIZE,
            "pageSize exceeds the MDBX2 conflict limit.",
        )?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let page = vault
            .list_unresolved_conflict_summaries(None, page_size, cursor)
            .map_err(|_| {
                RpcFailure::new(
                    "conflict-list-failed",
                    "MDBX2 unresolved conflicts could not be read.",
                    false,
                )
            })?;
        let mut items = Vec::with_capacity(page.items.len());
        for item in page.items {
            let local = if item.object_type.eq_ignore_ascii_case("entry") {
                vault
                    .get_object_summary(item.object_id.clone())
                    .map_err(|_| {
                        RpcFailure::new(
                            "conflict-list-failed",
                            "MDBX2 conflict display metadata could not be read.",
                            false,
                        )
                    })?
            } else {
                None
            };
            items.push(json!({
                "conflictId": item.conflict_id,
                "objectType": item.object_type,
                "objectId": item.object_id,
                "displayTitle": local.as_ref().map(|summary| summary.title.clone()),
                "contentType": local.as_ref().map(|summary| summary.object_type_id.clone()),
                "conflictingFields": item.conflicting_fields,
                "createdAt": item.created_at
            }));
        }
        bounded_conflict_result(json!({
            "items": items,
            "nextCursor": page.next_cursor
        }))
    }

    fn conflict_resolve(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "conflict.resolve params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let conflict_id = take_uuid(&mut params, "conflictId")?;
        let choice = take_conflict_resolution_choice(&mut params)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;

        if let Some(receipt) = self
            .conflict_resolutions
            .receipts
            .iter()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .cloned()
        {
            if receipt.conflict_id != conflict_id || receipt.choice != choice {
                return Err(RpcFailure::new(
                    "conflict-resolution-operation-mismatch",
                    "MDBX2 conflict resolution operation was reused with a different intent.",
                    false,
                ));
            }
            if receipt.completed {
                return Ok(conflict_resolution_json(&receipt, true));
            }
            if find_unresolved_conflict(&vault, &conflict_id)?.is_none() {
                return Err(RpcFailure::new(
                    "conflict-resolution-state-unknown",
                    "MDBX2 conflict is no longer unresolved, but the durable resolution receipt is incomplete. Refresh the vault before making another choice.",
                    false,
                ));
            }
            let resolved = vault
                .resolve_conflict(conflict_id, conflict_choice_to_ffi(choice))
                .map_err(|_| {
                    RpcFailure::new(
                        "conflict-resolution-failed",
                        "MDBX2 conflict could not be resolved.",
                        false,
                    )
                })?;
            let receipt = self.complete_conflict_resolution(
                &vault_handle,
                &operation_id,
                resolved.resolved_at,
            )?;
            return Ok(conflict_resolution_json(&receipt, false));
        }

        let summary = find_unresolved_conflict(&vault, &conflict_id)?.ok_or_else(|| {
            RpcFailure::new(
                "conflict-not-found",
                "MDBX2 conflict is no longer available for resolution.",
                false,
            )
        })?;
        self.prepare_conflict_resolution(&vault_handle, &operation_id, &summary, choice)?;
        let resolved = vault
            .resolve_conflict(conflict_id, conflict_choice_to_ffi(choice))
            .map_err(|_| {
                RpcFailure::new(
                    "conflict-resolution-failed",
                    "MDBX2 conflict could not be resolved.",
                    false,
                )
            })?;
        let receipt =
            self.complete_conflict_resolution(&vault_handle, &operation_id, resolved.resolved_at)?;
        Ok(conflict_resolution_json(&receipt, false))
    }

    fn prepare_conflict_resolution(
        &mut self,
        vault_handle: &str,
        operation_id: &str,
        summary: &MdbxConflictSummary,
        choice: ConflictResolutionChoice,
    ) -> Result<ConflictResolutionReceipt, RpcFailure> {
        let mut next_state = self.conflict_resolutions.clone();
        prune_conflict_resolution_receipts(&mut next_state.receipts)?;
        let receipt = ConflictResolutionReceipt {
            vault_handle: vault_handle.to_string(),
            operation_id: operation_id.to_string(),
            conflict_id: summary.conflict_id.clone(),
            object_type: summary.object_type.clone(),
            object_id: summary.object_id.clone(),
            choice,
            completed: false,
            resolved_at: None,
            updated_at_unix_secs: unix_seconds()?,
        };
        next_state.receipts.push(receipt.clone());
        let previous_state = std::mem::replace(&mut self.conflict_resolutions, next_state);
        if let Err(cause) = self.persist_conflict_resolutions() {
            self.conflict_resolutions = previous_state;
            return Err(cause);
        }
        Ok(receipt)
    }

    fn complete_conflict_resolution(
        &mut self,
        vault_handle: &str,
        operation_id: &str,
        resolved_at: Option<String>,
    ) -> Result<ConflictResolutionReceipt, RpcFailure> {
        let mut next_state = self.conflict_resolutions.clone();
        let receipt = next_state
            .receipts
            .iter_mut()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .ok_or_else(|| RpcFailure::storage("MDBX2 conflict resolution receipt is missing."))?;
        receipt.completed = true;
        receipt.resolved_at = resolved_at;
        receipt.updated_at_unix_secs = unix_seconds()?;
        let result = receipt.clone();
        let previous_state = std::mem::replace(&mut self.conflict_resolutions, next_state);
        if let Err(cause) = self.persist_conflict_resolutions() {
            self.conflict_resolutions = previous_state;
            return Err(cause);
        }
        Ok(result)
    }

    fn persist_conflict_resolutions(&mut self) -> Result<(), RpcFailure> {
        self.conflict_resolutions.revision = self
            .conflict_resolutions
            .revision
            .checked_add(1)
            .ok_or_else(|| RpcFailure::storage("MDBX2 conflict receipt revision overflowed."))?;
        let bytes = serde_json::to_vec(&self.conflict_resolutions)
            .map_err(|_| RpcFailure::storage("MDBX2 conflict receipts could not be encoded."))?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_CONFLICT_RESOLUTION_STATE_BYTES {
            return Err(RpcFailure::new(
                "conflict-resolution-receipt-limit",
                "MDBX2 conflict receipts exceed the reviewed storage limit.",
                false,
            ));
        }
        let path =
            conflict_resolution_state_path(&self.root, self.conflict_resolutions.revision % 2);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|_| RpcFailure::storage("MDBX2 conflict receipts could not be opened."))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| RpcFailure::storage("MDBX2 conflict receipts could not be persisted."))
    }

    fn attachment_list(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "attachment.list params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let collection_id = take_uuid(&mut params, "collectionId")?;
        let object_id = take_uuid(&mut params, "objectId")?;
        let page_size = take_bounded_page_size(
            &mut params,
            MAX_ATTACHMENT_PAGE_SIZE,
            "pageSize exceeds the MDBX2 attachment limit.",
        )?;
        let cursor = take_optional_string(&mut params, "cursor", MAX_CURSOR_BYTES)?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        require_attachment_object_target(&vault, &collection_id, &object_id)?;
        let page = vault
            .list_attachment_summaries(collection_id, Some(object_id), page_size, cursor)
            .map_err(|_| {
                RpcFailure::new(
                    "attachment-list-failed",
                    "MDBX2 attachment summaries could not be read.",
                    false,
                )
            })?;
        Ok(json!({
            "items": page.items.into_iter().map(attachment_summary_json).collect::<Vec<_>>(),
            "nextCursor": page.next_cursor
        }))
    }

    fn attachment_read_begin(&mut self, params: Value) -> Result<Value, RpcFailure> {
        self.prune_attachment_sessions()?;
        if self.attachment_session_count() >= MAX_ATTACHMENT_SESSIONS {
            return Err(RpcFailure::new(
                "attachment-session-limit",
                "MDBX2 has too many active attachment downloads.",
                true,
            ));
        }
        let mut params = take_object(params, "attachment.read.begin params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let attachment_id = take_uuid(&mut params, "attachmentId")?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let summary = require_active_attachment_summary(&vault, &attachment_id)?;
        let size_bytes = usize::try_from(summary.stored_size).map_err(|_| {
            RpcFailure::new(
                "attachment-too-large",
                "MDBX2 attachment size exceeds the browser limit.",
                false,
            )
        })?;
        if size_bytes > MAX_ATTACHMENT_BYTES
            || self
                .attachment_memory_usage()
                .checked_add(size_bytes)
                .is_none_or(|total| total > MAX_ATTACHMENT_MEMORY_BYTES)
        {
            return Err(RpcFailure::new(
                "attachment-memory-limit",
                "MDBX2 attachment exceeds the reviewed in-memory limit.",
                false,
            ));
        }
        if !vault
            .verify_attachment_integrity(attachment_id.clone())
            .map_err(|_| {
                RpcFailure::new(
                    "attachment-integrity-check-failed",
                    "MDBX2 attachment integrity could not be verified.",
                    false,
                )
            })?
        {
            return Err(RpcFailure::new(
                "attachment-integrity-failed",
                "MDBX2 attachment integrity verification failed.",
                false,
            ));
        }
        let content = vault
            .read_attachment_content(attachment_id.clone(), MAX_ATTACHMENT_BYTES as u64)
            .map_err(|_| {
                RpcFailure::new(
                    "attachment-read-failed",
                    "MDBX2 attachment content could not be read in this browser security context.",
                    false,
                )
            })?;
        if content.len() != size_bytes {
            return Err(RpcFailure::new(
                "attachment-size-mismatch",
                "MDBX2 attachment plaintext size does not match its authenticated metadata.",
                false,
            ));
        }
        let read_handle = fresh_uuid();
        let now = unix_seconds()?;
        let file_name = summary.file_name.clone();
        let media_type = summary.media_type.clone();
        self.attachment_reads.insert(
            read_handle.clone(),
            AttachmentReadSession {
                vault_handle,
                attachment_id: attachment_id.clone(),
                file_name: file_name.clone(),
                media_type: media_type.clone(),
                bytes: Zeroizing::new(content),
                updated_at_unix_secs: now,
            },
        );
        Ok(json!({
            "readHandle": read_handle,
            "attachmentId": attachment_id,
            "fileName": file_name,
            "mediaType": media_type,
            "sizeBytes": size_bytes,
            "maxChunkBytes": MAX_BINARY_CHUNK_BYTES
        }))
    }

    fn attachment_read_chunk(&mut self, params: Value) -> Result<Value, RpcFailure> {
        self.prune_attachment_sessions()?;
        let mut params = take_object(params, "attachment.read.chunk params must be an object.")?;
        let read_handle = take_uuid(&mut params, "readHandle")?;
        let offset = take_u64(&mut params, "offset")?;
        let max_bytes = take_u64(&mut params, "maxBytes")?;
        if max_bytes == 0 || max_bytes > MAX_BINARY_CHUNK_BYTES as u64 {
            return Err(RpcFailure::invalid(
                "attachment.read.chunk maxBytes exceeds the reviewed limit.",
            ));
        }
        reject_unknown(params)?;
        let now = unix_seconds()?;
        let session = self.attachment_reads.get_mut(&read_handle).ok_or_else(|| {
            RpcFailure::new(
                "attachment-read-not-found",
                "MDBX2 attachment download expired or does not exist.",
                false,
            )
        })?;
        let offset = usize::try_from(offset)
            .map_err(|_| RpcFailure::invalid("attachment.read.chunk offset is invalid."))?;
        if offset >= session.bytes.len() {
            return Err(RpcFailure::invalid(
                "attachment.read.chunk offset must be below the attachment size.",
            ));
        }
        let count = (session.bytes.len() - offset).min(max_bytes as usize);
        let next_offset = offset + count;
        session.updated_at_unix_secs = now;
        Ok(json!({
            "readHandle": read_handle,
            "attachmentId": session.attachment_id,
            "fileName": session.file_name,
            "mediaType": session.media_type,
            "sizeBytes": session.bytes.len(),
            "offset": offset,
            "dataBase64": BASE64.encode(&session.bytes[offset..next_offset]),
            "nextOffset": next_offset,
            "eof": next_offset == session.bytes.len()
        }))
    }

    fn attachment_read_release(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "attachment.read.release params must be an object.")?;
        let read_handle = take_uuid(&mut params, "readHandle")?;
        reject_unknown(params)?;
        Ok(json!({ "released": self.attachment_reads.remove(&read_handle).is_some() }))
    }

    fn attachment_upload_begin(&mut self, params: Value) -> Result<Value, RpcFailure> {
        self.prune_attachment_sessions()?;
        let mut params = take_object(params, "attachment.upload.begin params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let attachment_id = take_uuid(&mut params, "attachmentId")?;
        let collection_id = take_uuid(&mut params, "collectionId")?;
        let object_id = take_uuid(&mut params, "objectId")?;
        let file_name = take_string(
            &mut params,
            "fileName",
            MAX_ATTACHMENT_FILE_NAME_BYTES,
            false,
        )?;
        let media_type =
            take_optional_string(&mut params, "mediaType", MAX_ATTACHMENT_MEDIA_TYPE_BYTES)?;
        let mode = match take_string(&mut params, "mode", 16, false)?.as_str() {
            "create" => AttachmentUploadMode::Create,
            "replace" => AttachmentUploadMode::Replace,
            _ => {
                return Err(RpcFailure::invalid(
                    "attachment.upload.begin mode must be create or replace.",
                ))
            }
        };
        let size_bytes = take_u64(&mut params, "sizeBytes")?;
        let size_bytes = usize::try_from(size_bytes)
            .map_err(|_| RpcFailure::invalid("attachment size exceeds the browser limit."))?;
        let expected_sha256 = take_optional_string(&mut params, "sha256", 64)?;
        reject_unknown(params)?;
        validate_attachment_text(&file_name, "fileName")?;
        if media_type
            .as_deref()
            .is_some_and(|value| value.contains('\0'))
        {
            return Err(RpcFailure::invalid(
                "mediaType contains an invalid NUL byte.",
            ));
        }
        if size_bytes > MAX_ATTACHMENT_BYTES {
            return Err(RpcFailure::new(
                "attachment-too-large",
                "MDBX2 attachment exceeds the 64 MiB browser limit.",
                false,
            ));
        }
        if expected_sha256
            .as_deref()
            .is_some_and(|value| !valid_sha256(value))
        {
            return Err(RpcFailure::invalid(
                "attachment.upload.begin sha256 must be a lowercase SHA-256 digest or null.",
            ));
        }

        if let Some((transfer_id, session)) = self.attachment_uploads.iter().find(|(_, session)| {
            session.vault_handle == vault_handle && session.operation_id == operation_id
        }) {
            let matches = session.attachment_id == attachment_id
                && session.collection_id == collection_id
                && session.object_id == object_id
                && session.file_name == file_name
                && session.media_type == media_type
                && session.mode == mode
                && session.size_bytes == size_bytes
                && session.expected_sha256 == expected_sha256;
            if !matches {
                return Err(RpcFailure::new(
                    "attachment-upload-operation-mismatch",
                    "MDBX2 attachment operation ID was reused with different input.",
                    false,
                ));
            }
            return Ok(json!({
                "transferId": transfer_id,
                "operationId": operation_id,
                "attachmentId": attachment_id,
                "nextOffset": session.bytes.len(),
                "maxChunkBytes": MAX_BINARY_CHUNK_BYTES,
                "alreadyCommitted": session.result.is_some()
            }));
        }
        if self.attachment_session_count() >= MAX_ATTACHMENT_SESSIONS {
            return Err(RpcFailure::new(
                "attachment-session-limit",
                "MDBX2 has too many active attachment uploads.",
                true,
            ));
        }
        if self
            .attachment_memory_usage()
            .checked_add(size_bytes)
            .is_none_or(|total| total > MAX_ATTACHMENT_MEMORY_BYTES)
        {
            return Err(RpcFailure::new(
                "attachment-memory-limit",
                "MDBX2 attachment uploads exceed the reviewed in-memory limit.",
                false,
            ));
        }
        let vault = self.require_open_vault(&vault_handle)?;
        require_attachment_object_target(&vault, &collection_id, &object_id)?;
        if mode == AttachmentUploadMode::Replace {
            let summary = require_active_attachment_summary(&vault, &attachment_id)?;
            if summary.collection_id != collection_id
                || summary.object_id.as_deref() != Some(object_id.as_str())
                || summary.file_name != file_name
                || summary.media_type != media_type
            {
                return Err(RpcFailure::new(
                    "attachment-target-mismatch",
                    "MDBX2 replacement attachment does not match the selected Object.",
                    false,
                ));
            }
        }
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(size_bytes).map_err(|_| {
            RpcFailure::new(
                "attachment-memory-limit",
                "MDBX2 attachment memory could not be reserved.",
                true,
            )
        })?;
        if self
            .attachment_memory_usage()
            .checked_add(bytes.capacity())
            .is_none_or(|total| total > MAX_ATTACHMENT_MEMORY_BYTES)
        {
            return Err(RpcFailure::new(
                "attachment-memory-limit",
                "MDBX2 attachment memory reservation exceeds the reviewed limit.",
                false,
            ));
        }
        let transfer_id = fresh_uuid();
        self.attachment_uploads.insert(
            transfer_id.clone(),
            AttachmentUploadSession {
                vault_handle,
                operation_id: operation_id.clone(),
                attachment_id: attachment_id.clone(),
                collection_id,
                object_id,
                file_name,
                media_type,
                mode,
                size_bytes,
                expected_sha256,
                bytes: Zeroizing::new(bytes),
                result: None,
                updated_at_unix_secs: unix_seconds()?,
            },
        );
        Ok(json!({
            "transferId": transfer_id,
            "operationId": operation_id,
            "attachmentId": attachment_id,
            "nextOffset": 0,
            "maxChunkBytes": MAX_BINARY_CHUNK_BYTES,
            "alreadyCommitted": false
        }))
    }

    fn attachment_upload_chunk(&mut self, params: Value) -> Result<Value, RpcFailure> {
        self.prune_attachment_sessions()?;
        let mut params = take_object(params, "attachment.upload.chunk params must be an object.")?;
        let transfer_id = take_uuid(&mut params, "transferId")?;
        let offset = take_u64(&mut params, "offset")?;
        let encoded = Zeroizing::new(take_string(
            &mut params,
            "dataBase64",
            MAX_BASE64_CHUNK_BYTES,
            false,
        )?);
        reject_unknown(params)?;
        let bytes = Zeroizing::new(
            BASE64
                .decode(encoded.as_bytes())
                .map_err(|_| RpcFailure::invalid("attachment upload chunk is invalid Base64."))?,
        );
        if bytes.is_empty() || bytes.len() > MAX_BINARY_CHUNK_BYTES {
            return Err(RpcFailure::invalid(
                "attachment upload chunk exceeds the reviewed limit.",
            ));
        }
        let now = unix_seconds()?;
        let session = self
            .attachment_uploads
            .get_mut(&transfer_id)
            .ok_or_else(|| {
                RpcFailure::new(
                    "attachment-upload-not-found",
                    "MDBX2 attachment upload expired or does not exist.",
                    false,
                )
            })?;
        if session.result.is_some() {
            return Err(RpcFailure::new(
                "attachment-upload-already-committed",
                "MDBX2 attachment upload is already committed.",
                false,
            ));
        }
        let offset = usize::try_from(offset)
            .map_err(|_| RpcFailure::invalid("attachment upload offset is invalid."))?;
        let end = offset
            .checked_add(bytes.len())
            .ok_or_else(|| RpcFailure::invalid("attachment upload offset overflowed."))?;
        if end > session.size_bytes {
            return Err(RpcFailure::invalid(
                "attachment upload chunk exceeds the declared size.",
            ));
        }
        if offset < session.bytes.len() {
            if end > session.bytes.len() || session.bytes[offset..end] != bytes[..] {
                return Err(RpcFailure::new(
                    "attachment-upload-retry-mismatch",
                    "Retried MDBX2 attachment bytes differ from the accepted chunk.",
                    false,
                ));
            }
            session.updated_at_unix_secs = now;
            return Ok(json!({
                "transferId": transfer_id,
                "nextOffset": session.bytes.len(),
                "acceptedBytes": 0,
                "repeated": true
            }));
        }
        if offset != session.bytes.len() {
            return Err(RpcFailure::new(
                "attachment-upload-offset-mismatch",
                "MDBX2 attachment chunk does not start at the accepted offset.",
                true,
            ));
        }
        session.bytes.extend_from_slice(bytes.as_slice());
        session.updated_at_unix_secs = now;
        Ok(json!({
            "transferId": transfer_id,
            "nextOffset": session.bytes.len(),
            "acceptedBytes": bytes.len(),
            "repeated": false
        }))
    }

    fn attachment_upload_finish(&mut self, params: Value) -> Result<Value, RpcFailure> {
        self.prune_attachment_sessions()?;
        let mut params = take_object(params, "attachment.upload.finish params must be an object.")?;
        let transfer_id = take_uuid(&mut params, "transferId")?;
        reject_unknown(params)?;
        let mut session = self
            .attachment_uploads
            .remove(&transfer_id)
            .ok_or_else(|| {
                RpcFailure::new(
                    "attachment-upload-not-found",
                    "MDBX2 attachment upload expired or does not exist.",
                    false,
                )
            })?;
        if let Some(result) = session.result.clone() {
            session.updated_at_unix_secs = unix_seconds()?;
            self.attachment_uploads.insert(transfer_id.clone(), session);
            return Ok(attachment_upload_result_json(&transfer_id, &result));
        }
        if session.bytes.len() != session.size_bytes {
            let received = session.bytes.len();
            let expected = session.size_bytes;
            self.attachment_uploads.insert(transfer_id, session);
            return Err(RpcFailure::new(
                "attachment-upload-incomplete",
                format!("MDBX2 attachment upload received {received} of {expected} bytes."),
                true,
            ));
        }
        let actual_sha256 = sha256_hex(session.bytes.as_slice());
        if session
            .expected_sha256
            .as_deref()
            .is_some_and(|expected| expected != actual_sha256)
        {
            return Err(RpcFailure::new(
                "attachment-upload-digest-mismatch",
                "MDBX2 attachment SHA-256 verification failed and the upload was discarded.",
                false,
            ));
        }
        let vault = match self.require_open_vault(&session.vault_handle) {
            Ok(vault) => vault,
            Err(error) => {
                self.attachment_uploads.insert(transfer_id, session);
                return Err(error);
            }
        };
        if let Err(error) =
            require_attachment_object_target(&vault, &session.collection_id, &session.object_id)
        {
            self.attachment_uploads.insert(transfer_id, session);
            return Err(error);
        }
        let limits = MdbxAttachmentContentLimits {
            chunk_size: MAX_BINARY_CHUNK_BYTES as u64,
            max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
        };
        let write_result = match session.mode {
            AttachmentUploadMode::Create => vault.create_attachment_with_external_content(
                session.operation_id.clone(),
                MdbxAttachmentCreateRequest {
                    attachment_id: session.attachment_id.clone(),
                    project_id: session.collection_id.clone(),
                    entry_id: Some(session.object_id.clone()),
                    file_name: session.file_name.clone(),
                    media_type: session.media_type.clone(),
                },
                session.bytes.as_slice().to_vec(),
                limits,
            ),
            AttachmentUploadMode::Replace => vault.replace_attachment_external_content(
                session.operation_id.clone(),
                session.attachment_id.clone(),
                session.bytes.as_slice().to_vec(),
                limits,
            ),
        };
        let write_result = match write_result {
            Ok(result) => result,
            Err(_) => {
                self.attachment_uploads.insert(transfer_id, session);
                return Err(RpcFailure::new(
                    "attachment-write-failed",
                    "MDBX2 attachment could not be written by the pinned core.",
                    false,
                ));
            }
        };
        let result = attachment_upload_result(write_result);
        session.bytes = Zeroizing::new(Vec::new());
        session.result = Some(result.clone());
        session.updated_at_unix_secs = unix_seconds()?;
        self.attachment_uploads.insert(transfer_id.clone(), session);
        Ok(attachment_upload_result_json(&transfer_id, &result))
    }

    fn attachment_upload_abort(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "attachment.upload.abort params must be an object.")?;
        let transfer_id = take_uuid(&mut params, "transferId")?;
        reject_unknown(params)?;
        Ok(json!({ "aborted": self.attachment_uploads.remove(&transfer_id).is_some() }))
    }

    fn attachment_delete(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "attachment.delete params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let attachment_id = take_uuid(&mut params, "attachmentId")?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        if vault
            .get_attachment_summary(attachment_id.clone())
            .map_err(|_| {
                RpcFailure::new(
                    "attachment-summary-failed",
                    "MDBX2 attachment metadata could not be read.",
                    false,
                )
            })?
            .is_none()
        {
            return Err(RpcFailure::new(
                "attachment-not-found",
                "MDBX2 attachment does not exist.",
                false,
            ));
        }
        let result = vault
            .execute_attachment_batch(
                operation_id.clone(),
                vec![MdbxAttachmentBatchCommand::Delete {
                    attachment_id: attachment_id.clone(),
                }],
            )
            .map_err(|_| {
                RpcFailure::new(
                    "attachment-delete-failed",
                    "MDBX2 attachment could not be deleted by the pinned core.",
                    false,
                )
            })?;
        let attachment = result.attachments.into_iter().next().ok_or_else(|| {
            RpcFailure::new(
                "attachment-delete-failed",
                "MDBX2 attachment delete result is empty.",
                false,
            )
        })?;
        Ok(json!({
            "operationId": operation_id,
            "attachment": attachment_record_json(&attachment),
            "commitId": result.commit_id,
            "alreadyCommitted": result.already_committed,
            "changed": !result.already_committed
        }))
    }

    fn prune_attachment_sessions(&mut self) -> Result<(), RpcFailure> {
        let now = unix_seconds()?;
        self.attachment_reads.retain(|_, session| {
            now.saturating_sub(session.updated_at_unix_secs) < ATTACHMENT_SESSION_TTL_SECS
        });
        self.attachment_uploads.retain(|_, session| {
            now.saturating_sub(session.updated_at_unix_secs) < ATTACHMENT_SESSION_TTL_SECS
        });
        Ok(())
    }

    fn attachment_memory_usage(&self) -> usize {
        let reads = self
            .attachment_reads
            .values()
            .map(|session| session.bytes.capacity())
            .sum::<usize>();
        self.attachment_uploads
            .values()
            .map(|session| session.bytes.capacity())
            .sum::<usize>()
            .saturating_add(reads)
    }

    fn attachment_session_count(&self) -> usize {
        self.attachment_reads
            .len()
            .saturating_add(self.attachment_uploads.len())
    }

    fn object_upsert(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.upsert params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let logical_object_id = take_string(
            &mut params,
            "logicalObjectId",
            MAX_LOGICAL_OBJECT_ID_BYTES,
            false,
        )?;
        let requested_collection_id = take_optional_uuid(&mut params, "collectionId")?;
        let object_type_id =
            take_string(&mut params, "objectTypeId", MAX_OBJECT_TYPE_ID_BYTES, false)?;
        let title = take_string(&mut params, "title", MAX_TITLE_BYTES, true)?;
        let payload_json =
            take_string(&mut params, "payloadJson", MAX_OBJECT_PAYLOAD_BYTES, false)?;
        reject_unknown(params)?;
        validate_monica_payload(&payload_json, &logical_object_id)?;
        let result = self.execute_object_mutations(
            vault_handle,
            Some(operation_id),
            None,
            "monica-extension-upsert-object",
            vec![ObjectMutation::Upsert {
                logical_object_id,
                requested_collection_id,
                object_type_id,
                title,
                payload_json,
            }],
        )?;
        let item = result.items.into_iter().next().ok_or_else(|| {
            RpcFailure::new(
                "object-write-failed",
                "MDBX2 Object write result is empty.",
                false,
            )
        })?;
        Ok(json!({
            "commitId": result.commit_id,
            "alreadyCommitted": result.already_committed,
            "logicalObjectId": item.logical_object_id,
            "objectId": item.object_id,
            "collectionId": item.collection_id,
            "objectTypeId": item.object_type_id
        }))
    }

    fn object_delete(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.delete params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        let logical_object_id = take_string(
            &mut params,
            "logicalObjectId",
            MAX_LOGICAL_OBJECT_ID_BYTES,
            false,
        )?;
        reject_unknown(params)?;
        let result = self.execute_object_mutations(
            vault_handle,
            Some(operation_id),
            None,
            "monica-extension-delete-object",
            vec![ObjectMutation::Delete { logical_object_id }],
        )?;
        let item = result.items.into_iter().next().ok_or_else(|| {
            RpcFailure::new(
                "object-delete-failed",
                "MDBX2 Object delete result is empty.",
                false,
            )
        })?;
        Ok(json!({
            "changed": item.changed,
            "commitId": result.commit_id,
            "alreadyCommitted": result.already_committed,
            "logicalObjectId": item.logical_object_id,
            "objectId": item.object_id
        }))
    }

    fn object_batch(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.batch params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_optional_uuid(&mut params, "operationId")?;
        let operation_scope = take_optional_string(&mut params, "operationScope", 128)?;
        if operation_id.is_some() == operation_scope.is_some() {
            return Err(RpcFailure::invalid(
                "object.batch requires exactly one operationId or operationScope.",
            ));
        }
        if operation_scope
            .as_deref()
            .is_some_and(|scope| !valid_sha256(scope))
        {
            return Err(RpcFailure::invalid(
                "object.batch operationScope must be a lowercase SHA-256 value.",
            ));
        }
        let mutations = params
            .remove("mutations")
            .ok_or_else(|| RpcFailure::invalid("mutations is required."))?;
        let Value::Array(mutations) = mutations else {
            return Err(RpcFailure::invalid("mutations must be an array."));
        };
        if mutations.is_empty() || mutations.len() > MAX_OBJECT_BATCH_MUTATIONS {
            return Err(RpcFailure::invalid(
                "mutations exceeds the reviewed MDBX2 batch limit.",
            ));
        }
        reject_unknown(params)?;
        let mut parsed = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            let mut mutation = take_object(mutation, "MDBX2 batch mutation must be an object.")?;
            let kind = take_string(&mut mutation, "kind", 32, false)?;
            let logical_object_id = take_string(
                &mut mutation,
                "logicalObjectId",
                MAX_LOGICAL_OBJECT_ID_BYTES,
                false,
            )?;
            match kind.as_str() {
                "upsert" => {
                    let requested_collection_id =
                        take_optional_uuid(&mut mutation, "collectionId")?;
                    let object_type_id = take_string(
                        &mut mutation,
                        "objectTypeId",
                        MAX_OBJECT_TYPE_ID_BYTES,
                        false,
                    )?;
                    let title = take_string(&mut mutation, "title", MAX_TITLE_BYTES, true)?;
                    let payload_json = take_string(
                        &mut mutation,
                        "payloadJson",
                        MAX_OBJECT_PAYLOAD_BYTES,
                        false,
                    )?;
                    reject_unknown(mutation)?;
                    validate_monica_payload(&payload_json, &logical_object_id)?;
                    parsed.push(ObjectMutation::Upsert {
                        logical_object_id,
                        requested_collection_id,
                        object_type_id,
                        title,
                        payload_json,
                    });
                }
                "delete" => {
                    reject_unknown(mutation)?;
                    parsed.push(ObjectMutation::Delete { logical_object_id });
                }
                _ => {
                    return Err(RpcFailure::invalid(
                        "MDBX2 batch mutation kind is unsupported.",
                    ))
                }
            }
        }
        let semantic_bytes = object_mutation_semantic_bytes(&parsed)?;
        if parsed.len() > 1 && semantic_bytes.len() > MAX_OBJECT_BATCH_INTENT_BYTES {
            return Err(RpcFailure::new(
                "object-batch-too-large",
                "MDBX2 Object batch exceeds the Native Host intent limit.",
                false,
            ));
        }
        let result = self.execute_object_mutations(
            vault_handle,
            operation_id,
            operation_scope,
            "monica-extension-batch-objects",
            parsed,
        )?;
        Ok(json!({
            "changed": result.commit_id.is_some(),
            "operationId": result.operation_id,
            "commitId": result.commit_id,
            "alreadyCommitted": result.already_committed,
            "items": result.items.into_iter().map(object_mutation_result_json).collect::<Vec<_>>()
        }))
    }

    fn object_operation_status(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.operation.status params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_id = take_uuid(&mut params, "operationId")?;
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let Some(receipt) = self
            .object_operations
            .receipts
            .iter()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .cloned()
        else {
            return Ok(json!({ "known": false, "committed": false }));
        };
        if let Some(commit_id) = receipt.commit_id {
            return Ok(json!({
                "known": true,
                "committed": true,
                "commitId": commit_id
            }));
        }
        if let Some(commit_id) = find_operation_commit(&vault, &operation_id)? {
            self.record_object_operation_commit(&vault_handle, &operation_id, &commit_id)?;
            return Ok(json!({
                "known": true,
                "committed": true,
                "commitId": commit_id
            }));
        }
        Ok(json!({ "known": true, "committed": false }))
    }

    fn object_operation_resolve(&mut self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "object.operation.resolve params must be an object.")?;
        let vault_handle = take_uuid(&mut params, "vaultHandle")?;
        let operation_scope = take_string(&mut params, "operationScope", 128, false)?;
        if !valid_sha256(&operation_scope) {
            return Err(RpcFailure::invalid(
                "operationScope must be a lowercase SHA-256 value.",
            ));
        }
        reject_unknown(params)?;
        let vault = self.require_open_vault(&vault_handle)?;
        let Some(receipt) = self
            .object_operations
            .receipts
            .iter()
            .find(|receipt| {
                receipt.vault_handle == vault_handle
                    && receipt.operation_scope.as_deref() == Some(operation_scope.as_str())
            })
            .cloned()
        else {
            return Ok(json!({ "known": false, "committed": false }));
        };
        if let Some(commit_id) = receipt.commit_id {
            return Ok(json!({
                "known": true,
                "committed": true,
                "operationId": receipt.operation_id,
                "commitId": commit_id
            }));
        }
        if let Some(commit_id) = find_operation_commit(&vault, &receipt.operation_id)? {
            self.record_object_operation_commit(&vault_handle, &receipt.operation_id, &commit_id)?;
            return Ok(json!({
                "known": true,
                "committed": true,
                "operationId": receipt.operation_id,
                "commitId": commit_id
            }));
        }
        Ok(json!({
            "known": true,
            "committed": false,
            "operationId": receipt.operation_id
        }))
    }

    fn execute_object_mutations(
        &mut self,
        vault_handle: String,
        operation_id: Option<String>,
        operation_scope: Option<String>,
        operation_kind: &'static str,
        mutations: Vec<ObjectMutation>,
    ) -> Result<ObjectMutationExecution, RpcFailure> {
        let vault = self.require_open_vault(&vault_handle)?;
        let semantic_sha256 = object_mutation_semantic_sha256(&mutations)?;
        let plan = build_object_mutation_plan(&vault, &mutations)?;
        let identity = match (operation_id, operation_scope) {
            (Some(operation_id), None) => ObjectOperationIdentity::Id(operation_id),
            (None, Some(operation_scope)) => ObjectOperationIdentity::Scope(operation_scope),
            _ => {
                return Err(RpcFailure::invalid(
                    "MDBX2 Object operation identity is invalid.",
                ))
            }
        };
        let receipt = self.prepare_object_operation(
            &vault_handle,
            &identity,
            &semantic_sha256,
            u32::try_from(mutations.len()).map_err(|_| {
                RpcFailure::invalid("MDBX2 Object mutation count cannot be represented.")
            })?,
            &plan,
        )?;
        let recovered_commit = match receipt.commit_id.clone() {
            Some(commit_id) => Some(commit_id),
            None => find_operation_commit(&vault, &receipt.operation_id)?,
        };
        if let Some(commit_id) = recovered_commit {
            self.record_object_operation_commit(&vault_handle, &receipt.operation_id, &commit_id)?;
            return Ok(ObjectMutationExecution {
                operation_id: receipt.operation_id,
                commit_id: Some(commit_id),
                already_committed: Some(true),
                items: apply_changed_indices(plan.items, &receipt.changed_indices),
            });
        }
        if receipt.plan_sha256 != plan.plan_sha256 {
            return Err(RpcFailure::new(
                "object-operation-state-changed",
                "MDBX2 Object operation state changed before its durable retry completed.",
                false,
            ));
        }
        if plan.commands.is_empty() {
            return Ok(ObjectMutationExecution {
                operation_id: receipt.operation_id,
                commit_id: None,
                already_committed: None,
                items: plan.items,
            });
        }
        let result = vault
            .execute_write_operation(
                receipt.operation_id.clone(),
                operation_kind.to_string(),
                plan.commands,
            )
            .map_err(|_| {
                RpcFailure::new("object-write-failed", "MDBX2 Object write failed.", false)
            })?;
        self.record_object_operation_commit(
            &vault_handle,
            &receipt.operation_id,
            &result.commit_id,
        )?;
        Ok(ObjectMutationExecution {
            operation_id: receipt.operation_id,
            commit_id: Some(result.commit_id),
            already_committed: Some(result.already_committed),
            items: plan.items,
        })
    }

    fn prepare_object_operation(
        &mut self,
        vault_handle: &str,
        identity: &ObjectOperationIdentity,
        semantic_sha256: &str,
        mutation_count: u32,
        plan: &ObjectMutationPlan,
    ) -> Result<ObjectOperationReceipt, RpcFailure> {
        let existing = self.object_operations.receipts.iter().find(|receipt| {
            receipt.vault_handle == vault_handle
                && match identity {
                    ObjectOperationIdentity::Id(operation_id) => {
                        receipt.operation_id == *operation_id
                    }
                    ObjectOperationIdentity::Scope(operation_scope) => {
                        receipt.operation_scope.as_deref() == Some(operation_scope)
                    }
                }
        });
        if let Some(receipt) = existing {
            if receipt.semantic_sha256 != semantic_sha256 {
                return Err(RpcFailure::new(
                    "object-operation-intent-mismatch",
                    "MDBX2 operation ID was reused for different Object content.",
                    false,
                ));
            }
            if receipt.mutation_count != mutation_count {
                return Err(RpcFailure::new(
                    "object-operation-intent-mismatch",
                    "MDBX2 operation ID was reused for a different mutation count.",
                    false,
                ));
            }
            if receipt.commit_id.is_none() && receipt.plan_sha256 != plan.plan_sha256 {
                return Err(RpcFailure::new(
                    "object-operation-state-changed",
                    "MDBX2 Object operation state changed before its durable retry completed.",
                    false,
                ));
            }
            return Ok(receipt.clone());
        }
        prune_object_operation_receipts(&mut self.object_operations.receipts)?;
        let receipt = ObjectOperationReceipt {
            vault_handle: vault_handle.to_string(),
            operation_id: match identity {
                ObjectOperationIdentity::Id(operation_id) => operation_id.clone(),
                ObjectOperationIdentity::Scope(_) => fresh_uuid(),
            },
            operation_scope: match identity {
                ObjectOperationIdentity::Id(_) => None,
                ObjectOperationIdentity::Scope(operation_scope) => Some(operation_scope.clone()),
            },
            semantic_sha256: semantic_sha256.to_string(),
            plan_sha256: plan.plan_sha256.clone(),
            mutation_count,
            changed_indices: plan.changed_indices.clone(),
            commit_id: None,
            updated_at_unix_secs: unix_seconds()?,
        };
        self.object_operations.receipts.push(receipt.clone());
        self.persist_object_operations()?;
        Ok(receipt)
    }

    fn record_object_operation_commit(
        &mut self,
        vault_handle: &str,
        operation_id: &str,
        commit_id: &str,
    ) -> Result<(), RpcFailure> {
        let receipt = self
            .object_operations
            .receipts
            .iter_mut()
            .find(|receipt| {
                receipt.vault_handle == vault_handle && receipt.operation_id == operation_id
            })
            .ok_or_else(|| RpcFailure::storage("MDBX2 Object operation receipt is missing."))?;
        if let Some(existing) = receipt.commit_id.as_deref() {
            if existing != commit_id {
                return Err(RpcFailure::new(
                    "object-operation-commit-mismatch",
                    "MDBX2 Object operation resolved to a different Commit.",
                    false,
                ));
            }
            return Ok(());
        }
        receipt.commit_id = Some(commit_id.to_string());
        receipt.updated_at_unix_secs = unix_seconds()?;
        self.persist_object_operations()
    }

    fn persist_object_operations(&mut self) -> Result<(), RpcFailure> {
        self.object_operations.revision = self
            .object_operations
            .revision
            .checked_add(1)
            .ok_or_else(|| RpcFailure::storage("MDBX2 Object operation revision overflowed."))?;
        let bytes = serde_json::to_vec(&self.object_operations).map_err(|_| {
            RpcFailure::storage("MDBX2 Object operation state could not be encoded.")
        })?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_OBJECT_OPERATION_STATE_BYTES {
            return Err(RpcFailure::new(
                "object-operation-state-too-large",
                "MDBX2 Object operation state exceeds the reviewed limit.",
                false,
            ));
        }
        let path = object_operation_state_path(&self.root, self.object_operations.revision % 2);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|_| {
                RpcFailure::storage("MDBX2 Object operation state could not be opened.")
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                RpcFailure::storage("MDBX2 Object operation state could not be persisted.")
            })
    }

    pub(crate) fn require_open_vault(
        &self,
        vault_handle: &str,
    ) -> Result<Arc<MdbxVault>, RpcFailure> {
        self.vaults.get(vault_handle).cloned().ok_or_else(|| {
            RpcFailure::new(
                "vault-locked",
                "MDBX2 vault is not open in this Host session.",
                false,
            )
        })
    }

    fn take_vault_source(
        &self,
        params: &mut Map<String, Value>,
    ) -> Result<VaultSource, RpcFailure> {
        let source = params
            .remove("source")
            .ok_or_else(|| RpcFailure::invalid("Vault source is required."))?;
        let mut source = take_object(source, "Vault source must be an object.")?;
        let kind = take_string(&mut source, "kind", 32, false)?;
        let handle = take_uuid(&mut source, "handle")?;
        reject_unknown(source)?;
        let (kind, path, parent) = match kind.as_str() {
            "file" => (
                "file",
                self.import_file_path(&handle),
                self.root.join("imports"),
            ),
            "vault" => (
                "vault",
                self.root.join("vaults").join(&handle).join("vault.mdbx"),
                self.root.join("vaults").join(&handle),
            ),
            _ => return Err(RpcFailure::invalid("Vault source kind is unsupported.")),
        };
        ensure_contained_file(&path, &parent)?;
        Ok(VaultSource { kind, handle, path })
    }

    fn create_pre_upgrade_backup(
        &self,
        vault_handle: &str,
        source: &Path,
    ) -> Result<(), RpcFailure> {
        let directory = self.root.join("backups").join(vault_handle);
        fs::create_dir_all(&directory).map_err(|_| {
            RpcFailure::storage("Native Host could not create an MDBX2 upgrade backup directory.")
        })?;
        let destination = directory.join(format!("{}.mdbx", fresh_uuid()));
        mdbx_ffi::create_portable_backup(path_string(source)?, path_string(&destination)?)
            .map_err(|_| {
                RpcFailure::new(
                    "vault-backup-failed",
                    "MDBX2 pre-upgrade backup failed.",
                    false,
                )
            })?;
        Ok(())
    }

    fn persist_transfer(&self, metadata: &TransferMetadata) -> Result<(), RpcFailure> {
        let bytes = serde_json::to_vec(metadata)
            .map_err(|_| RpcFailure::storage("Native transfer state could not be encoded."))?;
        let path = self.transfer_state_path(&metadata.transfer_id, metadata.revision % 2);
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|_| RpcFailure::storage("Native transfer state could not be opened."))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| RpcFailure::storage("Native transfer state could not be persisted."))
    }

    fn delete_transfer(&mut self, transfer_id: &str) {
        self.transfers.remove(transfer_id);
        let _ = fs::remove_file(self.transfer_part_path(transfer_id));
        self.delete_transfer_states(transfer_id);
    }

    fn delete_transfer_states(&self, transfer_id: &str) {
        for slot in [0, 1] {
            let _ = fs::remove_file(self.transfer_state_path(transfer_id, slot));
        }
    }

    fn transfer_part_path(&self, transfer_id: &str) -> PathBuf {
        self.root
            .join("transfers")
            .join(format!("{transfer_id}.part"))
    }

    fn transfer_state_path(&self, transfer_id: &str, slot: u64) -> PathBuf {
        self.root
            .join("transfers")
            .join(format!("{transfer_id}.state.{slot}.json"))
    }

    fn import_file_path(&self, file_handle: &str) -> PathBuf {
        self.root
            .join("imports")
            .join(format!("{file_handle}.mdbx"))
    }

    pub(crate) fn sync_inbound_segment_path(&self, file_handle: &str) -> PathBuf {
        self.root
            .join("sync")
            .join("incoming")
            .join(format!("{file_handle}.mdbxsync"))
    }
}

fn build_object_mutation_plan(
    vault: &Arc<MdbxVault>,
    mutations: &[ObjectMutation],
) -> Result<ObjectMutationPlan, RpcFailure> {
    let info = vault.info();
    let root_collection_id = java_name_uuid(format!("monica-root:{}", info.vault_id).as_bytes());
    let mut commands = Vec::new();
    let mut plan_actions = Vec::new();
    let mut items = Vec::with_capacity(mutations.len());
    let mut changed_indices = Vec::new();
    let mut logical_ids = HashSet::new();
    if mutations
        .iter()
        .any(|mutation| matches!(mutation, ObjectMutation::Upsert { .. }))
    {
        let root = vault
            .get_collection_summary(root_collection_id.clone())
            .map_err(|_| {
                RpcFailure::new(
                    "collection-read-failed",
                    "MDBX2 root Collection could not be read.",
                    false,
                )
            })?;
        match root {
            None => {
                commands.push(MdbxWriteCommand::CreateProject {
                    project_id: root_collection_id.clone(),
                    title: ".monica-root".to_string(),
                });
                plan_actions.push(json!({
                    "kind": "create-project",
                    "projectId": root_collection_id,
                    "title": ".monica-root"
                }));
            }
            Some(summary) if summary.deleted => {
                commands.push(MdbxWriteCommand::RestoreProject {
                    project_id: root_collection_id.clone(),
                    parent_project_id: None,
                });
                plan_actions.push(json!({
                    "kind": "restore-project",
                    "projectId": root_collection_id,
                    "parentProjectId": null
                }));
            }
            Some(_) => {}
        }
    }
    for (index, mutation) in mutations.iter().enumerate() {
        let logical_object_id = match mutation {
            ObjectMutation::Upsert {
                logical_object_id, ..
            }
            | ObjectMutation::Delete { logical_object_id } => logical_object_id,
        };
        if !logical_ids.insert(logical_object_id.clone()) {
            return Err(RpcFailure::invalid(
                "MDBX2 Object batch contains a duplicate logical Object ID.",
            ));
        }
        let object_id = java_name_uuid(
            format!("monica-entry:{}:{}", info.vault_id, logical_object_id).as_bytes(),
        );
        match mutation {
            ObjectMutation::Upsert {
                requested_collection_id,
                object_type_id,
                title,
                payload_json,
                ..
            } => {
                let collection_id = match requested_collection_id {
                    Some(collection_id) => match vault
                        .get_collection_summary(collection_id.clone())
                        .map_err(|_| {
                            RpcFailure::new(
                                "collection-read-failed",
                                "MDBX2 target Collection could not be read.",
                                false,
                            )
                        })? {
                        Some(summary) if !summary.deleted => collection_id.clone(),
                        _ => root_collection_id.clone(),
                    },
                    None => root_collection_id.clone(),
                };
                let current = vault.get_object_summary(object_id.clone()).map_err(|_| {
                    RpcFailure::new(
                        "object-read-failed",
                        "MDBX2 Object summary could not be read.",
                        false,
                    )
                })?;
                match current {
                    None => {
                        commands.push(MdbxWriteCommand::CreateEntry {
                            entry_id: object_id.clone(),
                            project_id: collection_id.clone(),
                            entry_type: object_type_id.clone(),
                            title: title.clone(),
                            payload_json: payload_json.clone(),
                        });
                        plan_actions.push(json!({
                            "kind": "create-entry",
                            "entryId": object_id,
                            "projectId": collection_id,
                            "entryType": object_type_id,
                            "title": title,
                            "payloadJson": payload_json
                        }));
                    }
                    Some(summary) => {
                        if summary.deleted {
                            commands.push(MdbxWriteCommand::RestoreEntry {
                                entry_id: object_id.clone(),
                                project_id: summary.collection_id.clone(),
                            });
                            plan_actions.push(json!({
                                "kind": "restore-entry",
                                "entryId": object_id,
                                "projectId": summary.collection_id
                            }));
                        }
                        if summary.collection_id != collection_id {
                            commands.push(MdbxWriteCommand::MoveEntry {
                                entry_id: object_id.clone(),
                                project_id: summary.collection_id.clone(),
                                target_project_id: collection_id.clone(),
                            });
                            plan_actions.push(json!({
                                "kind": "move-entry",
                                "entryId": object_id,
                                "projectId": summary.collection_id,
                                "targetProjectId": collection_id
                            }));
                        }
                        commands.push(MdbxWriteCommand::UpdateEntry {
                            entry_id: object_id.clone(),
                            project_id: collection_id.clone(),
                            entry_type: object_type_id.clone(),
                            title: title.clone(),
                            payload_json: payload_json.clone(),
                        });
                        plan_actions.push(json!({
                            "kind": "update-entry",
                            "entryId": object_id,
                            "projectId": collection_id,
                            "entryType": object_type_id,
                            "title": title,
                            "payloadJson": payload_json
                        }));
                    }
                }
                changed_indices.push(index as u32);
                items.push(ObjectMutationResult {
                    kind: "upsert",
                    changed: true,
                    logical_object_id: logical_object_id.clone(),
                    object_id,
                    collection_id: Some(collection_id),
                    object_type_id: Some(object_type_id.clone()),
                });
            }
            ObjectMutation::Delete { .. } => {
                let current = vault.get_object_summary(object_id.clone()).map_err(|_| {
                    RpcFailure::new(
                        "object-read-failed",
                        "MDBX2 Object summary could not be read.",
                        false,
                    )
                })?;
                let changed = matches!(current, Some(ref summary) if !summary.deleted);
                if let Some(summary) = current.filter(|summary| !summary.deleted) {
                    commands.push(MdbxWriteCommand::DeleteEntry {
                        entry_id: object_id.clone(),
                        project_id: summary.collection_id.clone(),
                    });
                    plan_actions.push(json!({
                        "kind": "delete-entry",
                        "entryId": object_id,
                        "projectId": summary.collection_id
                    }));
                    changed_indices.push(index as u32);
                }
                items.push(ObjectMutationResult {
                    kind: "delete",
                    changed,
                    logical_object_id: logical_object_id.clone(),
                    object_id,
                    collection_id: None,
                    object_type_id: None,
                });
            }
        }
    }
    if commands.len() > MAX_OBJECT_BATCH_COMMANDS {
        return Err(RpcFailure::new(
            "object-batch-too-large",
            "MDBX2 Object batch expands beyond the core write-command limit.",
            false,
        ));
    }
    let plan_bytes = serde_json::to_vec(&plan_actions)
        .map_err(|_| RpcFailure::storage("MDBX2 Object operation plan could not be encoded."))?;
    Ok(ObjectMutationPlan {
        commands,
        items,
        plan_sha256: sha256_hex(&plan_bytes),
        changed_indices,
    })
}

fn object_mutation_semantic_values(mutations: &[ObjectMutation]) -> Vec<Value> {
    mutations
        .iter()
        .map(|mutation| match mutation {
            ObjectMutation::Upsert {
                logical_object_id,
                requested_collection_id,
                object_type_id,
                title,
                payload_json,
            } => json!({
                "kind": "upsert",
                "logicalObjectId": logical_object_id,
                "collectionId": requested_collection_id,
                "objectTypeId": object_type_id,
                "title": title,
                "payloadJson": payload_json
            }),
            ObjectMutation::Delete { logical_object_id } => json!({
                "kind": "delete",
                "logicalObjectId": logical_object_id
            }),
        })
        .collect()
}

fn object_mutation_semantic_bytes(mutations: &[ObjectMutation]) -> Result<Vec<u8>, RpcFailure> {
    serde_json::to_vec(&object_mutation_semantic_values(mutations))
        .map_err(|_| RpcFailure::storage("MDBX2 Object operation intent could not be encoded."))
}

fn object_mutation_semantic_sha256(mutations: &[ObjectMutation]) -> Result<String, RpcFailure> {
    Ok(sha256_hex(&object_mutation_semantic_bytes(mutations)?))
}

fn object_mutation_result_json(item: ObjectMutationResult) -> Value {
    json!({
        "kind": item.kind,
        "changed": item.changed,
        "logicalObjectId": item.logical_object_id,
        "objectId": item.object_id,
        "collectionId": item.collection_id,
        "objectTypeId": item.object_type_id
    })
}

fn apply_changed_indices(
    mut items: Vec<ObjectMutationResult>,
    changed_indices: &[u32],
) -> Vec<ObjectMutationResult> {
    let changed = changed_indices.iter().copied().collect::<HashSet<_>>();
    for (index, item) in items.iter_mut().enumerate() {
        item.changed = changed.contains(&(index as u32));
    }
    items
}

fn find_operation_commit(
    vault: &Arc<MdbxVault>,
    operation_id: &str,
) -> Result<Option<String>, RpcFailure> {
    let mut cursor = None;
    for _ in 0..MAX_OPERATION_HISTORY_PAGES {
        let page = vault.list_commit_history(100, cursor).map_err(|_| {
            RpcFailure::new(
                "object-operation-history-failed",
                "MDBX2 operation history could not be inspected.",
                false,
            )
        })?;
        if let Some(item) = page
            .items
            .iter()
            .find(|item| item.operation_id.as_deref() == Some(operation_id))
        {
            return Ok(Some(item.commit_id.clone()));
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(None);
        };
        cursor = Some(next_cursor);
    }
    Ok(None)
}

fn prune_object_operation_receipts(
    receipts: &mut Vec<ObjectOperationReceipt>,
) -> Result<(), RpcFailure> {
    if receipts.len() < MAX_OBJECT_OPERATION_RECEIPTS {
        return Ok(());
    }
    receipts.sort_by_key(|receipt| (receipt.commit_id.is_none(), receipt.updated_at_unix_secs));
    while receipts.len() >= MAX_OBJECT_OPERATION_RECEIPTS {
        if receipts
            .first()
            .is_some_and(|receipt| receipt.commit_id.is_some())
        {
            receipts.remove(0);
        } else {
            return Err(RpcFailure::new(
                "object-operation-receipt-limit",
                "MDBX2 has too many unfinished Object operations.",
                false,
            ));
        }
    }
    Ok(())
}

fn load_object_operation_state(root: &Path) -> std::io::Result<ObjectOperationState> {
    let mut candidates = Vec::new();
    for slot in [0_u64, 1_u64] {
        let path = object_operation_state_path(root, slot);
        if !path.exists() {
            continue;
        }
        let Ok(bytes) = read_bounded(&path, MAX_OBJECT_OPERATION_STATE_BYTES) else {
            continue;
        };
        let Ok(state) = serde_json::from_slice::<ObjectOperationState>(&bytes) else {
            continue;
        };
        if state.version != OBJECT_OPERATION_STATE_VERSION || state.revision % 2 != slot {
            continue;
        }
        if validate_object_operation_state(&state) {
            candidates.push(state);
        }
    }
    Ok(candidates
        .into_iter()
        .max_by_key(|state| state.revision)
        .unwrap_or_default())
}

fn validate_object_operation_state(state: &ObjectOperationState) -> bool {
    if state.receipts.len() > MAX_OBJECT_OPERATION_RECEIPTS {
        return false;
    }
    let mut identities = HashSet::new();
    state.receipts.iter().all(|receipt| {
        canonical_uuid(&receipt.vault_handle).is_some()
            && canonical_uuid(&receipt.operation_id).is_some()
            && valid_sha256(&receipt.semantic_sha256)
            && valid_sha256(&receipt.plan_sha256)
            && receipt.operation_scope.as_deref().is_none_or(valid_sha256)
            && receipt.mutation_count > 0
            && receipt.mutation_count as usize <= MAX_OBJECT_BATCH_MUTATIONS
            && receipt
                .changed_indices
                .iter()
                .all(|index| *index < receipt.mutation_count)
            && receipt
                .commit_id
                .as_deref()
                .is_none_or(|commit_id| !commit_id.is_empty() && commit_id.len() <= 128)
            && identities.insert((receipt.vault_handle.clone(), receipt.operation_id.clone()))
    })
}

fn object_operation_state_path(root: &Path, slot: u64) -> PathBuf {
    root.join("operations")
        .join(format!("object-operations.state.{slot}.json"))
}

fn prune_conflict_resolution_receipts(
    receipts: &mut Vec<ConflictResolutionReceipt>,
) -> Result<(), RpcFailure> {
    if receipts.len() < MAX_CONFLICT_RESOLUTION_RECEIPTS {
        return Ok(());
    }
    receipts.sort_by_key(|receipt| (!receipt.completed, receipt.updated_at_unix_secs));
    while receipts.len() >= MAX_CONFLICT_RESOLUTION_RECEIPTS {
        if receipts.first().is_some_and(|receipt| receipt.completed) {
            receipts.remove(0);
        } else {
            return Err(RpcFailure::new(
                "conflict-resolution-receipt-limit",
                "MDBX2 has too many unfinished conflict resolutions.",
                false,
            ));
        }
    }
    Ok(())
}

fn load_conflict_resolution_state(root: &Path) -> std::io::Result<ConflictResolutionState> {
    let mut candidates = Vec::new();
    for slot in [0_u64, 1_u64] {
        let path = conflict_resolution_state_path(root, slot);
        if !path.exists() {
            continue;
        }
        let Ok(bytes) = read_bounded(&path, MAX_CONFLICT_RESOLUTION_STATE_BYTES) else {
            continue;
        };
        let Ok(state) = serde_json::from_slice::<ConflictResolutionState>(&bytes) else {
            continue;
        };
        if state.version != CONFLICT_RESOLUTION_STATE_VERSION || state.revision % 2 != slot {
            continue;
        }
        if validate_conflict_resolution_state(&state) {
            candidates.push(state);
        }
    }
    Ok(candidates
        .into_iter()
        .max_by_key(|state| state.revision)
        .unwrap_or_default())
}

fn validate_conflict_resolution_state(state: &ConflictResolutionState) -> bool {
    if state.receipts.len() > MAX_CONFLICT_RESOLUTION_RECEIPTS {
        return false;
    }
    let mut identities = HashSet::new();
    state.receipts.iter().all(|receipt| {
        canonical_uuid(&receipt.vault_handle).as_deref() == Some(receipt.vault_handle.as_str())
            && canonical_uuid(&receipt.operation_id).as_deref()
                == Some(receipt.operation_id.as_str())
            && canonical_uuid(&receipt.conflict_id).as_deref() == Some(receipt.conflict_id.as_str())
            && canonical_uuid(&receipt.object_id).as_deref() == Some(receipt.object_id.as_str())
            && !receipt.object_type.is_empty()
            && receipt.object_type.len() <= 128
            && (receipt.completed || receipt.resolved_at.is_none())
            && receipt
                .resolved_at
                .as_deref()
                .is_none_or(|value| !value.is_empty() && value.len() <= 128)
            && identities.insert((receipt.vault_handle.clone(), receipt.operation_id.clone()))
    })
}

fn conflict_resolution_state_path(root: &Path, slot: u64) -> PathBuf {
    root.join("operations")
        .join(format!("conflict-resolutions.state.{slot}.json"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unix_seconds() -> Result<u64, RpcFailure> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| RpcFailure::storage("System clock is before the Unix epoch."))
}

fn load_or_create_device_id(root: &Path) -> std::io::Result<String> {
    let path = root.join("device.json");
    if path.exists() {
        return read_device_id(&path);
    }
    let device_id = fresh_uuid();
    let metadata = DeviceMetadata {
        version: DEVICE_METADATA_VERSION,
        device_id: device_id.clone(),
    };
    let bytes = serde_json::to_vec(&metadata)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(device_id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_device_id(&path),
        Err(error) => Err(error),
    }
}

fn read_device_id(path: &Path) -> std::io::Result<String> {
    let bytes = read_bounded(path, MAX_METADATA_BYTES)?;
    let metadata: DeviceMetadata = serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    if metadata.version != DEVICE_METADATA_VERSION || canonical_uuid(&metadata.device_id).is_none()
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "MDBX2 Host device metadata is invalid",
        ));
    }
    Ok(metadata.device_id)
}

fn load_transfers(root: &Path) -> std::io::Result<HashMap<String, TransferMetadata>> {
    let directory = root.join("transfers");
    let mut selected = HashMap::<String, TransferMetadata>::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !name.ends_with(".json") {
            continue;
        }
        let Ok(bytes) = read_bounded(&path, MAX_METADATA_BYTES) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_slice::<TransferMetadata>(&bytes) else {
            continue;
        };
        if !valid_transfer_metadata(&metadata) {
            continue;
        }
        let expected_name = format!(
            "{}.state.{}.json",
            metadata.transfer_id,
            metadata.revision % 2
        );
        if name != expected_name {
            continue;
        }
        let replace = selected
            .get(&metadata.transfer_id)
            .map(|current| metadata.revision > current.revision)
            .unwrap_or(true);
        if replace {
            selected.insert(metadata.transfer_id.clone(), metadata);
        }
    }
    selected.retain(|transfer_id, metadata| {
        let part_path = directory.join(format!("{transfer_id}.part"));
        let Ok(file) = OpenOptions::new().read(true).write(true).open(&part_path) else {
            return false;
        };
        let Ok(length) = file.metadata().map(|value| value.len()) else {
            return false;
        };
        if length < metadata.received_bytes {
            return false;
        }
        if length > metadata.received_bytes && file.set_len(metadata.received_bytes).is_err() {
            return false;
        }
        true
    });
    if selected.len() > MAX_ACTIVE_TRANSFERS {
        let mut values = selected.into_values().collect::<Vec<_>>();
        values.sort_by_key(|metadata| std::cmp::Reverse(metadata.revision));
        values.truncate(MAX_ACTIVE_TRANSFERS);
        return Ok(values
            .into_iter()
            .map(|metadata| (metadata.transfer_id.clone(), metadata))
            .collect());
    }
    Ok(selected)
}

fn valid_transfer_metadata(metadata: &TransferMetadata) -> bool {
    metadata.version == TRANSFER_METADATA_VERSION
        && canonical_uuid(&metadata.transfer_id).as_deref() == Some(metadata.transfer_id.as_str())
        && metadata.size_bytes > 0
        && metadata.size_bytes <= MAX_INBOUND_FILE_BYTES
        && metadata.received_bytes <= metadata.size_bytes
        && metadata.sha256.as_deref().is_none_or(valid_sha256)
}

fn inspect_exact_mdbx2(path: &Path) -> Result<MdbxMigrationInfo, RpcFailure> {
    let info = mdbx_ffi::inspect_vault_migration(path_string(path)?).map_err(|_| {
        RpcFailure::new(
            "vault-invalid",
            "File is not a readable MDBX2 vault.",
            false,
        )
    })?;
    if !info.initialized {
        return Err(RpcFailure::new(
            "vault-uninitialized",
            "File is not an initialized MDBX2 vault.",
            false,
        ));
    }
    if info.format_version.as_deref() != Some(MDBX_FORMAT_VERSION) {
        return Err(RpcFailure::new(
            "mdbx-format-unsupported",
            "Monica Extension supports MDBX beginning with MDBX-2.",
            false,
        ));
    }
    if info.unknown_critical_extensions {
        return Err(RpcFailure::new(
            "mdbx-critical-extension-unsupported",
            "MDBX2 vault requires an unsupported critical extension.",
            false,
        ));
    }
    Ok(info)
}

fn migration_json(source: &VaultSource, info: &MdbxMigrationInfo) -> Value {
    json!({
        "source": { "kind": source.kind, "handle": source.handle },
        "initialized": info.initialized,
        "formatVersion": info.format_version,
        "schemaVersion": info.schema_version,
        "minReaderVersion": info.min_reader_version,
        "minWriterVersion": info.min_writer_version,
        "requiresUpgrade": info.requires_upgrade,
        "unknownCriticalExtensions": info.unknown_critical_extensions,
        "targetFormatVersion": info.target_format_version,
        "targetSchemaVersion": info.target_schema_version
    })
}

fn object_summary_json(item: mdbx_ffi::MdbxObjectSummary) -> Value {
    json!({
        "objectId": item.object_id,
        "collectionId": item.collection_id,
        "objectTypeId": item.object_type_id,
        "title": item.title,
        "payloadSchemaVersion": item.payload_schema_version,
        "headCommitId": item.head_commit_id,
        "deleted": item.deleted,
        "updatedAt": item.updated_at
    })
}

fn require_attachment_object_target(
    vault: &Arc<MdbxVault>,
    collection_id: &str,
    object_id: &str,
) -> Result<(), RpcFailure> {
    let summary = vault
        .get_object_summary(object_id.to_string())
        .map_err(|_| {
            RpcFailure::new(
                "attachment-target-read-failed",
                "MDBX2 attachment target could not be inspected.",
                false,
            )
        })?
        .ok_or_else(|| {
            RpcFailure::new(
                "attachment-target-not-found",
                "MDBX2 attachment target Object does not exist.",
                false,
            )
        })?;
    if summary.deleted || summary.collection_id != collection_id {
        return Err(RpcFailure::new(
            "attachment-target-mismatch",
            "MDBX2 attachment target does not belong to the selected Collection.",
            false,
        ));
    }
    Ok(())
}

fn require_active_attachment_summary(
    vault: &Arc<MdbxVault>,
    attachment_id: &str,
) -> Result<MdbxAttachmentSummary, RpcFailure> {
    let summary = vault
        .get_attachment_summary(attachment_id.to_string())
        .map_err(|_| {
            RpcFailure::new(
                "attachment-summary-failed",
                "MDBX2 attachment metadata could not be read.",
                false,
            )
        })?
        .ok_or_else(|| {
            RpcFailure::new(
                "attachment-not-found",
                "MDBX2 attachment does not exist.",
                false,
            )
        })?;
    if summary.deleted {
        return Err(RpcFailure::new(
            "attachment-deleted",
            "MDBX2 attachment is in the deleted state.",
            false,
        ));
    }
    Ok(summary)
}

fn validate_attachment_text(value: &str, field: &'static str) -> Result<(), RpcFailure> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(RpcFailure::invalid(format!(
            "{field} is empty or contains an invalid NUL byte."
        )));
    }
    Ok(())
}

fn attachment_summary_json(item: MdbxAttachmentSummary) -> Value {
    json!({
        "attachmentId": item.attachment_id,
        "fileName": item.file_name,
        "mediaType": item.media_type,
        "sizeBytes": item.stored_size,
        "storageMode": item.storage_mode,
        "protected": true,
        "deleted": item.deleted,
        "updatedAt": item.updated_at
    })
}

fn attachment_record_json(item: &MdbxAttachmentRecord) -> Value {
    json!({
        "attachmentId": item.attachment_id,
        "fileName": item.file_name,
        "mediaType": item.media_type,
        "sizeBytes": item.stored_size,
        "storageMode": item.storage_mode,
        "protected": true,
        "deleted": item.deleted
    })
}

fn attachment_upload_result(result: MdbxAttachmentWriteResult) -> AttachmentUploadResult {
    AttachmentUploadResult {
        attachment: result.attachment,
        commit_id: result.commit_id,
        already_committed: result.already_committed,
    }
}

fn attachment_upload_result_json(transfer_id: &str, result: &AttachmentUploadResult) -> Value {
    json!({
        "transferId": transfer_id,
        "attachment": attachment_record_json(&result.attachment),
        "commitId": result.commit_id,
        "alreadyCommitted": result.already_committed,
        "changed": !result.already_committed
    })
}

fn validate_monica_payload(payload_json: &str, logical_object_id: &str) -> Result<(), RpcFailure> {
    let payload: Value = serde_json::from_str(payload_json)
        .map_err(|_| RpcFailure::invalid("MDBX2 Object payload is not valid JSON."))?;
    let payload = payload
        .as_object()
        .ok_or_else(|| RpcFailure::invalid("MDBX2 Object payload must be a JSON object."))?;
    if payload.get("monica_entry_id").and_then(Value::as_str) != Some(logical_object_id) {
        return Err(RpcFailure::invalid(
            "MDBX2 Object payload monica_entry_id does not match the logical Object ID.",
        ));
    }
    Ok(())
}

fn java_name_uuid(value: &[u8]) -> String {
    let mut bytes: [u8; 16] = Md5::digest(value).into();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).hyphenated().to_string()
}

fn take_credential(params: &mut Map<String, Value>) -> Result<VaultCredential, RpcFailure> {
    let credential = params
        .remove("credential")
        .ok_or_else(|| RpcFailure::invalid("Vault credential is required."))?;
    let mut credential = take_object(credential, "Vault credential must be an object.")?;
    let method = take_string(&mut credential, "method", 64, false)?;
    let result = match method.as_str() {
        "password" => VaultCredential::Password(Zeroizing::new(take_string(
            &mut credential,
            "password",
            MAX_SECRET_BYTES,
            true,
        )?)),
        "security-key" => VaultCredential::SecurityKey(take_key_material(&mut credential)?),
        "password-security-key" => VaultCredential::PasswordSecurityKey(
            Zeroizing::new(take_string(
                &mut credential,
                "password",
                MAX_SECRET_BYTES,
                true,
            )?),
            take_key_material(&mut credential)?,
        ),
        _ => return Err(RpcFailure::invalid("Vault unlock method is unsupported.")),
    };
    reject_unknown(credential)?;
    Ok(result)
}

fn take_key_material(params: &mut Map<String, Value>) -> Result<Zeroizing<Vec<u8>>, RpcFailure> {
    let encoded = Zeroizing::new(take_string(
        params,
        "keyMaterialBase64",
        MAX_SECRET_BYTES.div_ceil(3) * 4,
        false,
    )?);
    let decoded = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| RpcFailure::invalid("Vault security-key material is invalid Base64."))?;
    if decoded.is_empty() || decoded.len() > MAX_SECRET_BYTES {
        return Err(RpcFailure::invalid(
            "Vault security-key material exceeds the reviewed limit.",
        ));
    }
    Ok(Zeroizing::new(decoded))
}

fn take_object(value: Value, message: &'static str) -> Result<Map<String, Value>, RpcFailure> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(RpcFailure::invalid(message)),
    }
}

fn take_string(
    params: &mut Map<String, Value>,
    key: &'static str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<String, RpcFailure> {
    let value = params
        .remove(key)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is required.")))?;
    let Value::String(value) = value else {
        return Err(RpcFailure::invalid(format!("{key} must be a string.")));
    };
    if (!allow_empty && value.is_empty()) || value.len() > max_bytes {
        return Err(RpcFailure::invalid(format!(
            "{key} exceeds the reviewed limit."
        )));
    }
    Ok(value)
}

fn take_u64(params: &mut Map<String, Value>, key: &'static str) -> Result<u64, RpcFailure> {
    params
        .remove(key)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| RpcFailure::invalid(format!("{key} must be an unsigned integer.")))
}

fn take_page_size(params: &mut Map<String, Value>) -> Result<u32, RpcFailure> {
    take_bounded_page_size(
        params,
        MAX_SUMMARY_PAGE_SIZE,
        "pageSize exceeds the MDBX2 summary limit.",
    )
}

fn take_bounded_page_size(
    params: &mut Map<String, Value>,
    maximum: u32,
    message: &'static str,
) -> Result<u32, RpcFailure> {
    let value = take_u64(params, "pageSize")?;
    if value == 0 || value > maximum as u64 {
        return Err(RpcFailure::invalid(message));
    }
    Ok(value as u32)
}

fn take_optional_string(
    params: &mut Map<String, Value>,
    key: &'static str,
    max_bytes: usize,
) -> Result<Option<String>, RpcFailure> {
    let Some(value) = params.remove(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Value::String(value) = value else {
        return Err(RpcFailure::invalid(format!(
            "{key} must be a string or null."
        )));
    };
    if value.is_empty() || value.len() > max_bytes {
        return Err(RpcFailure::invalid(format!(
            "{key} exceeds the reviewed limit."
        )));
    }
    Ok(Some(value))
}

fn take_optional_bool(
    params: &mut Map<String, Value>,
    key: &'static str,
) -> Result<Option<bool>, RpcFailure> {
    let Some(value) = params.remove(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_bool()
        .map(Some)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} must be a boolean or null.")))
}

fn take_optional_uuid(
    params: &mut Map<String, Value>,
    key: &'static str,
) -> Result<Option<String>, RpcFailure> {
    let Some(value) = params.remove(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Value::String(value) = value else {
        return Err(RpcFailure::invalid(format!(
            "{key} must be an opaque handle or null."
        )));
    };
    canonical_uuid(&value)
        .filter(|canonical| canonical == &value)
        .map(Some)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is not a canonical opaque handle.")))
}

fn take_uuid(params: &mut Map<String, Value>, key: &'static str) -> Result<String, RpcFailure> {
    let value = take_string(params, key, 64, false)?;
    canonical_uuid(&value)
        .filter(|canonical| canonical == &value)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is not a canonical opaque handle.")))
}

fn take_snapshot_structure_side(
    params: &mut Map<String, Value>,
) -> Result<SnapshotStructureSide, RpcFailure> {
    match take_string(params, "side", 16, false)?.as_str() {
        "current" => Ok(SnapshotStructureSide::Current),
        "snapshot" => Ok(SnapshotStructureSide::Snapshot),
        _ => Err(RpcFailure::invalid("side must be current or snapshot.")),
    }
}

fn reject_unknown(params: Map<String, Value>) -> Result<(), RpcFailure> {
    if params.is_empty() {
        Ok(())
    } else {
        Err(RpcFailure::invalid(
            "Native request contains unknown parameters.",
        ))
    }
}

fn bounded_history_result(value: Value) -> Result<Value, RpcFailure> {
    let size = serde_json::to_vec(&value)
        .map_err(|_| RpcFailure::storage("MDBX2 history response could not be encoded."))?
        .len();
    if size > MAX_HISTORY_RESULT_BYTES {
        return Err(RpcFailure::new(
            "history-result-too-large",
            "MDBX2 history response exceeds the Native Messaging safety limit; request a smaller page.",
            false,
        ));
    }
    Ok(value)
}

fn bounded_snapshot_result(value: Value) -> Result<Value, RpcFailure> {
    let size = serde_json::to_vec(&value)
        .map_err(|_| RpcFailure::storage("MDBX2 snapshot response could not be encoded."))?
        .len();
    if size > MAX_SNAPSHOT_RESULT_BYTES {
        return Err(RpcFailure::new(
            "snapshot-result-too-large",
            "MDBX2 snapshot response exceeds the Native Messaging safety limit; request a smaller page.",
            false,
        ));
    }
    Ok(value)
}

fn bounded_conflict_result(value: Value) -> Result<Value, RpcFailure> {
    let size = serde_json::to_vec(&value)
        .map_err(|_| RpcFailure::storage("MDBX2 conflict response could not be encoded."))?
        .len();
    if size > MAX_CONFLICT_RESULT_BYTES {
        return Err(RpcFailure::new(
            "conflict-result-too-large",
            "MDBX2 conflict response exceeds the Native Messaging safety limit; request a smaller page.",
            false,
        ));
    }
    Ok(value)
}

fn snapshot_summary_json(summary: MdbxManagedSnapshotSummary) -> Result<Value, RpcFailure> {
    for (label, value) in [
        ("snapshot ID", summary.snapshot_id.as_str()),
        ("snapshot base commit ID", summary.base_commit_id.as_str()),
        ("snapshot name", summary.name.as_str()),
        ("snapshot created-at", summary.created_at.as_str()),
        (
            "snapshot creator device ID",
            summary.created_by_device_id.as_str(),
        ),
    ] {
        validate_snapshot_text(label, value)?;
    }
    let kind = match summary.kind {
        MdbxSnapshotKind::Manual => "manual",
        MdbxSnapshotKind::Automatic => "automatic",
    };
    Ok(json!({
        "snapshotId": summary.snapshot_id,
        "baseCommitId": summary.base_commit_id,
        "name": summary.name,
        "kind": kind,
        "isFull": summary.is_full,
        "payloadBytes": summary.payload_bytes,
        "createdAt": summary.created_at,
        "createdByDeviceId": summary.created_by_device_id,
        "autoPrune": summary.auto_prune,
        "integrityOk": summary.integrity_ok
    }))
}

fn validate_snapshot_structure_node(node: &MdbxSnapshotStructureNode) -> Result<(), RpcFailure> {
    validate_snapshot_text("snapshot structure node ID", &node.id)?;
    if let Some(parent_id) = &node.parent_id {
        validate_snapshot_text("snapshot structure parent ID", parent_id)?;
    }
    for (label, value) in [
        ("snapshot structure name", node.name.as_str()),
        ("snapshot structure type", node.node_type.as_str()),
        ("snapshot structure path", node.path.as_str()),
        ("snapshot structure status", node.status.as_str()),
    ] {
        validate_snapshot_text(label, value)?;
    }
    Ok(())
}

fn validate_snapshot_text(label: &str, value: &str) -> Result<(), RpcFailure> {
    if value.len() > MAX_SNAPSHOT_TEXT_BYTES {
        return Err(RpcFailure::new(
            "snapshot-metadata-too-large",
            format!("{label} exceeds the reviewed browser disclosure limit."),
            false,
        ));
    }
    Ok(())
}

fn snapshot_structure_node_json(node: &MdbxSnapshotStructureNode) -> Result<Value, RpcFailure> {
    validate_snapshot_structure_node(node)?;
    Ok(json!({
        "nodeId": node.id,
        "parentNodeId": node.parent_id,
        "name": node.name,
        "nodeType": node.node_type,
        "path": node.path,
        "status": node.status,
        "childCount": node.child_count
    }))
}

fn normalize_snapshot_structure_nodes(
    nodes: Vec<MdbxSnapshotStructureNode>,
    root_ids: &HashSet<String>,
) -> Vec<MdbxSnapshotStructureNode> {
    nodes
        .into_iter()
        .filter_map(|mut node| {
            if node.node_type.eq_ignore_ascii_case("folder") && root_ids.contains(&node.id) {
                return None;
            }
            if node
                .parent_id
                .as_ref()
                .is_some_and(|parent_id| root_ids.contains(parent_id))
            {
                node.parent_id = None;
                node.path = node
                    .path
                    .split_once('/')
                    .map(|(_, path)| {
                        if path.is_empty() {
                            node.name.clone()
                        } else {
                            path.to_string()
                        }
                    })
                    .unwrap_or_else(|| node.name.clone());
            }
            Some(node)
        })
        .collect()
}

fn snapshot_structure_fingerprint(
    snapshot_id: &str,
    side: SnapshotStructureSide,
    current_item_count: u32,
    snapshot_item_count: u32,
    nodes: &[MdbxSnapshotStructureNode],
) -> String {
    let mut hasher = Sha256::new();
    update_snapshot_fingerprint_part(&mut hasher, snapshot_id.as_bytes());
    update_snapshot_fingerprint_part(&mut hasher, side.as_str().as_bytes());
    update_snapshot_fingerprint_part(&mut hasher, &current_item_count.to_le_bytes());
    update_snapshot_fingerprint_part(&mut hasher, &snapshot_item_count.to_le_bytes());
    update_snapshot_fingerprint_part(&mut hasher, &(nodes.len() as u64).to_le_bytes());
    for node in nodes {
        update_snapshot_fingerprint_part(&mut hasher, node.id.as_bytes());
        update_snapshot_fingerprint_part(
            &mut hasher,
            node.parent_id.as_deref().unwrap_or_default().as_bytes(),
        );
        update_snapshot_fingerprint_part(&mut hasher, node.name.as_bytes());
        update_snapshot_fingerprint_part(&mut hasher, node.node_type.as_bytes());
        update_snapshot_fingerprint_part(&mut hasher, node.path.as_bytes());
        update_snapshot_fingerprint_part(&mut hasher, node.status.as_bytes());
        update_snapshot_fingerprint_part(&mut hasher, &node.child_count.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn update_snapshot_fingerprint_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn encode_snapshot_structure_cursor(
    vault_handle: &str,
    snapshot_id: &str,
    side: SnapshotStructureSide,
    offset: u32,
    total_nodes: u32,
    fingerprint: &str,
) -> Result<String, RpcFailure> {
    let bytes = serde_json::to_vec(&SnapshotStructureCursor {
        version: SNAPSHOT_STRUCTURE_CURSOR_VERSION,
        vault_handle: vault_handle.to_string(),
        snapshot_id: snapshot_id.to_string(),
        side,
        offset,
        total_nodes,
        fingerprint: fingerprint.to_string(),
    })
    .map_err(|_| RpcFailure::storage("MDBX2 snapshot cursor could not be encoded."))?;
    let encoded = BASE64.encode(bytes);
    if encoded.len() > MAX_CURSOR_BYTES {
        return Err(RpcFailure::new(
            "snapshot-cursor-too-large",
            "MDBX2 snapshot cursor exceeds the reviewed browser limit.",
            false,
        ));
    }
    Ok(encoded)
}

fn decode_snapshot_structure_cursor(value: &str) -> Result<SnapshotStructureCursor, RpcFailure> {
    let bytes = BASE64
        .decode(value.as_bytes())
        .map_err(|_| RpcFailure::invalid("snapshot structure cursor is not valid base64."))?;
    let cursor: SnapshotStructureCursor = serde_json::from_slice(&bytes)
        .map_err(|_| RpcFailure::invalid("snapshot structure cursor is malformed."))?;
    if cursor.version != SNAPSHOT_STRUCTURE_CURSOR_VERSION {
        return Err(RpcFailure::invalid(
            "snapshot structure cursor version is unsupported.",
        ));
    }
    if canonical_uuid(&cursor.vault_handle).as_deref() != Some(cursor.vault_handle.as_str())
        || canonical_uuid(&cursor.snapshot_id).as_deref() != Some(cursor.snapshot_id.as_str())
        || cursor.fingerprint.len() != 64
        || !cursor
            .fingerprint
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(RpcFailure::invalid(
            "snapshot structure cursor contains invalid identity data.",
        ));
    }
    Ok(cursor)
}

fn snapshot_structure_failure(error: mdbx_ffi::MdbxFfiError) -> RpcFailure {
    let diagnostic = error.to_string().to_ascii_lowercase();
    if diagnostic.contains("integrity descriptor mismatch")
        || diagnostic.contains("failed integrity verification")
    {
        RpcFailure::new(
            "snapshot-integrity-failed",
            "MDBX2 snapshot failed integrity verification and cannot be previewed.",
            false,
        )
    } else if diagnostic.contains("snapshot structure nodes")
        || diagnostic.contains("resource limit")
    {
        RpcFailure::new(
            "snapshot-structure-too-large",
            "MDBX2 snapshot structure exceeds the Core preview limit.",
            false,
        )
    } else if diagnostic.contains("not found") {
        RpcFailure::new(
            "snapshot-not-found",
            "MDBX2 snapshot is no longer available.",
            false,
        )
    } else {
        RpcFailure::new(
            "snapshot-structure-failed",
            "MDBX2 snapshot structure could not be read.",
            false,
        )
    }
}

fn snapshot_operation_intent_sha256(value: Value) -> Result<String, RpcFailure> {
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| RpcFailure::storage("MDBX2 snapshot intent could not be encoded."))?;
    Ok(sha256_hex(&bytes))
}

fn validate_snapshot_operation_intent(
    receipt: &SnapshotOperationReceipt,
    kind: SnapshotOperationKind,
    intent_sha256: &str,
    target_snapshot_id: Option<&str>,
) -> Result<(), RpcFailure> {
    if receipt.kind != kind
        || receipt.intent_sha256 != intent_sha256
        || receipt.target_snapshot_id.as_deref() != target_snapshot_id
    {
        return Err(RpcFailure::new(
            "snapshot-operation-mismatch",
            "MDBX2 snapshot operation was reused with a different intent.",
            false,
        ));
    }
    Ok(())
}

fn snapshot_create_result_json(
    receipt: &SnapshotOperationReceipt,
    already_completed: bool,
) -> Result<Value, RpcFailure> {
    let snapshot_id = receipt.result_snapshot_id.as_deref().ok_or_else(|| {
        RpcFailure::storage("MDBX2 completed snapshot creation has no Snapshot ID.")
    })?;
    let commit_id = receipt.result_commit_id.as_deref().ok_or_else(|| {
        RpcFailure::storage("MDBX2 completed snapshot creation has no Commit ID.")
    })?;
    Ok(json!({
        "operationId": receipt.operation_id,
        "snapshotId": snapshot_id,
        "commitId": commit_id,
        "alreadyCompleted": already_completed
    }))
}

fn snapshot_delete_result_json(
    receipt: &SnapshotOperationReceipt,
    already_completed: bool,
) -> Result<Value, RpcFailure> {
    let snapshot_id = receipt.target_snapshot_id.as_deref().ok_or_else(|| {
        RpcFailure::storage("MDBX2 completed snapshot deletion has no target Snapshot ID.")
    })?;
    Ok(json!({
        "operationId": receipt.operation_id,
        "snapshotId": snapshot_id,
        "commitId": receipt.result_commit_id,
        "alreadyCompleted": already_completed
    }))
}

fn snapshot_restore_result_json(
    receipt: &SnapshotOperationReceipt,
    already_completed: bool,
) -> Result<Value, RpcFailure> {
    let snapshot_id = receipt.target_snapshot_id.as_deref().ok_or_else(|| {
        RpcFailure::storage("MDBX2 completed snapshot restoration has no target Snapshot ID.")
    })?;
    let commit_id = receipt.result_commit_id.as_deref().ok_or_else(|| {
        RpcFailure::storage("MDBX2 completed snapshot restoration has no Commit ID.")
    })?;
    let affected_object_count = receipt.affected_object_count.ok_or_else(|| {
        RpcFailure::storage("MDBX2 completed snapshot restoration has no affected Object count.")
    })?;
    Ok(json!({
        "operationId": receipt.operation_id,
        "snapshotId": snapshot_id,
        "commitId": commit_id,
        "affectedObjectCount": affected_object_count,
        "alreadyCompleted": already_completed
    }))
}

fn snapshot_operation_unknown_failure() -> RpcFailure {
    RpcFailure::new(
        "snapshot-operation-state-unknown",
        "MDBX2 snapshot operation outcome cannot be proven safely. Refresh the vault before taking another snapshot action.",
        false,
    )
}

fn snapshot_mutation_failure(
    kind: SnapshotOperationKind,
    error: mdbx_ffi::MdbxFfiError,
) -> RpcFailure {
    let diagnostic = error.to_string().to_ascii_lowercase();
    if diagnostic.contains("integrity descriptor mismatch")
        || diagnostic.contains("failed integrity verification")
    {
        return RpcFailure::new(
            "snapshot-integrity-failed",
            "MDBX2 snapshot failed integrity verification.",
            false,
        );
    }
    if diagnostic.contains("authorization")
        || diagnostic.contains("fresh authentication")
        || diagnostic.contains("authentication")
    {
        return RpcFailure::new(
            "snapshot-authorization-required",
            "MDBX2 security policy requires the vault to be freshly unlocked for this snapshot action.",
            true,
        );
    }
    if diagnostic.contains("not found") {
        return RpcFailure::new(
            "snapshot-not-found",
            "MDBX2 snapshot is no longer available.",
            false,
        );
    }
    let (code, message) = match kind {
        SnapshotOperationKind::Create => (
            "snapshot-create-failed",
            "MDBX2 manual snapshot could not be created.",
        ),
        SnapshotOperationKind::Delete => (
            "snapshot-delete-failed",
            "MDBX2 snapshot could not be deleted.",
        ),
        SnapshotOperationKind::Restore => (
            "snapshot-restore-failed",
            "MDBX2 snapshot could not be restored.",
        ),
    };
    RpcFailure::new(code, message, false)
}

fn browser_snapshot_device_context() -> MdbxDeviceContext {
    browser_management_device_context()
}

fn browser_management_device_context() -> MdbxDeviceContext {
    MdbxDeviceContext {
        assurance: MdbxDeviceAssurance::Standard,
        secure_clipboard_available: false,
        screen_capture_protection_available: false,
        secure_temp_files_available: true,
    }
}

fn validate_history_revert_eligibility(item: &MdbxCommitHistoryItem) -> Result<(), RpcFailure> {
    if history_item_is_system_commit(item) {
        return Err(RpcFailure::new(
            "history-revert-not-allowed",
            "MDBX2 database-level system commits cannot be reverted from the browser manager.",
            false,
        ));
    }
    let distinct_changes = item
        .changes
        .iter()
        .map(|change| (change.object_type.as_str(), change.object_id.as_str()))
        .collect::<HashSet<_>>();
    if distinct_changes.is_empty()
        || distinct_changes.len() > MAX_HISTORY_REVERT_ITEMS
        || distinct_changes
            .iter()
            .any(|(object_type, _)| !object_type.eq_ignore_ascii_case("entry"))
    {
        return Err(RpcFailure::new(
            "history-revert-not-allowed",
            "MDBX2 commit is not an eligible bounded entry-only history action.",
            false,
        ));
    }
    Ok(())
}

fn history_item_is_system_commit(item: &MdbxCommitHistoryItem) -> bool {
    let operation = item
        .operation_kind
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let scope = item.change_scope.trim().to_ascii_lowercase();
    let kind = item.commit_kind.trim().to_ascii_lowercase();
    operation == "monica-initialize"
        || operation.starts_with("snapshot-")
        || operation.starts_with("branch-")
        || operation.contains("key-rotation")
        || operation.contains("security-policy")
        || matches!(
            scope.as_str(),
            "vault-meta" | "key-epoch" | "snapshot" | "branch"
        )
        || matches!(kind.as_str(), "snapshot" | "key-rotation")
}

fn history_revert_failure(error: mdbx_ffi::MdbxFfiError) -> RpcFailure {
    let diagnostic = error.to_string().to_ascii_lowercase();
    if diagnostic.contains("reused with different content") {
        return RpcFailure::new(
            "history-revert-operation-mismatch",
            "MDBX2 history operation ID was already used for another recovery action.",
            false,
        );
    }
    if diagnostic.contains("authorization")
        || diagnostic.contains("fresh authentication")
        || diagnostic.contains("authentication")
    {
        return RpcFailure::new(
            "history-revert-authorization-required",
            "MDBX2 security policy requires the vault to be freshly unlocked for history recovery.",
            true,
        );
    }
    if diagnostic.contains("resource limit") || diagnostic.contains("commit diff objects") {
        return RpcFailure::new(
            "history-revert-too-large",
            "MDBX2 commit contains too many Objects to recover from the browser manager.",
            false,
        );
    }
    if diagnostic.contains("not found") {
        return RpcFailure::new(
            "history-revert-not-found",
            "MDBX2 commit is no longer available.",
            false,
        );
    }
    if diagnostic.contains("no restorable entry versions") {
        return RpcFailure::new(
            "history-revert-not-allowed",
            "MDBX2 commit has no restorable entry versions.",
            false,
        );
    }
    RpcFailure::new(
        "history-revert-failed",
        "MDBX2 commit could not be recovered.",
        false,
    )
}

fn snapshot_operation_baseline(
    vault: &Arc<MdbxVault>,
    device_id: &str,
) -> Result<SnapshotOperationBaseline, RpcFailure> {
    Ok(SnapshotOperationBaseline {
        branch_state_sha256: snapshot_branch_state_sha256(vault)?,
        device_local_seq: snapshot_latest_device_sequence(vault, device_id)?,
    })
}

fn snapshot_branch_state_sha256(vault: &Arc<MdbxVault>) -> Result<String, RpcFailure> {
    let mut branches = vault.list_branches().map_err(|_| {
        RpcFailure::new(
            "snapshot-operation-history-failed",
            "MDBX2 branch state could not be inspected for snapshot recovery.",
            false,
        )
    })?;
    if branches.len() > MAX_SNAPSHOT_BRANCHES {
        return Err(RpcFailure::new(
            "snapshot-operation-inventory-too-large",
            "MDBX2 has too many branches for bounded snapshot recovery.",
            false,
        ));
    }
    branches.sort_by(|left, right| {
        left.branch_id
            .cmp(&right.branch_id)
            .then_with(|| left.head_commit_id.cmp(&right.head_commit_id))
    });
    let values = branches
        .into_iter()
        .map(|branch| {
            if branch.branch_id.is_empty()
                || branch.branch_id.len() > MAX_SNAPSHOT_TEXT_BYTES
                || branch.head_commit_id.is_empty()
                || branch.head_commit_id.len() > MAX_SNAPSHOT_TEXT_BYTES
            {
                return Err(RpcFailure::new(
                    "snapshot-operation-history-invalid",
                    "MDBX2 branch state contains oversized recovery metadata.",
                    false,
                ));
            }
            Ok(json!({
                "branchId": branch.branch_id,
                "headCommitId": branch.head_commit_id
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let bytes = serde_json::to_vec(&values)
        .map_err(|_| RpcFailure::storage("MDBX2 branch state could not be encoded."))?;
    Ok(sha256_hex(&bytes))
}

fn snapshot_latest_device_sequence(
    vault: &Arc<MdbxVault>,
    device_id: &str,
) -> Result<u64, RpcFailure> {
    let mut cursor = None;
    for _ in 0..MAX_SNAPSHOT_HISTORY_SCAN_PAGES {
        let page = vault.list_commit_history(100, cursor).map_err(|_| {
            RpcFailure::new(
                "snapshot-operation-history-failed",
                "MDBX2 commit history could not be inspected for snapshot recovery.",
                false,
            )
        })?;
        if let Some(sequence) = page
            .items
            .iter()
            .filter(|item| item.device_id == device_id)
            .map(|item| item.local_seq)
            .max()
        {
            return Ok(sequence);
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(0);
        };
        cursor = Some(next_cursor);
    }
    Err(RpcFailure::new(
        "snapshot-operation-inventory-too-large",
        "MDBX2 history is too large to establish a bounded snapshot recovery baseline.",
        false,
    ))
}

fn snapshot_commits_after(
    vault: &Arc<MdbxVault>,
    device_id: &str,
    baseline_local_seq: u64,
) -> Result<Vec<MdbxCommitHistoryItem>, RpcFailure> {
    let mut cursor = None;
    let mut commits = Vec::new();
    for _ in 0..MAX_SNAPSHOT_HISTORY_SCAN_PAGES {
        let page = vault.list_commit_history(100, cursor).map_err(|_| {
            RpcFailure::new(
                "snapshot-operation-history-failed",
                "MDBX2 commit history could not be inspected for snapshot recovery.",
                false,
            )
        })?;
        for item in page.items {
            if item.device_id != device_id {
                continue;
            }
            if item.local_seq <= baseline_local_seq {
                return Ok(commits);
            }
            commits.push(item);
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(commits);
        };
        cursor = Some(next_cursor);
    }
    Err(snapshot_operation_unknown_failure())
}

fn find_managed_snapshot(
    vault: &Arc<MdbxVault>,
    snapshot_id: &str,
) -> Result<Option<MdbxManagedSnapshotSummary>, RpcFailure> {
    let mut cursor = None;
    for _ in 0..MAX_SNAPSHOT_INVENTORY_PAGES {
        let page = vault
            .list_managed_snapshots(MAX_SNAPSHOT_PAGE_SIZE, cursor)
            .map_err(|_| {
                RpcFailure::new(
                    "snapshot-list-failed",
                    "MDBX2 managed snapshots could not be inspected.",
                    false,
                )
            })?;
        if let Some(summary) = page
            .items
            .into_iter()
            .find(|summary| summary.snapshot_id == snapshot_id)
        {
            return Ok(Some(summary));
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(None);
        };
        cursor = Some(next_cursor);
    }
    Err(RpcFailure::new(
        "snapshot-operation-inventory-too-large",
        "MDBX2 snapshot inventory is too large for bounded mutation recovery.",
        false,
    ))
}

fn require_restorable_snapshot(
    vault: &Arc<MdbxVault>,
    snapshot_id: &str,
) -> Result<MdbxManagedSnapshotSummary, RpcFailure> {
    let summary = find_managed_snapshot(vault, snapshot_id)?.ok_or_else(|| {
        RpcFailure::new(
            "snapshot-not-found",
            "MDBX2 snapshot is no longer available.",
            false,
        )
    })?;
    if !summary.integrity_ok {
        return Err(RpcFailure::new(
            "snapshot-integrity-failed",
            "MDBX2 snapshot failed integrity verification and cannot be restored.",
            false,
        ));
    }
    Ok(summary)
}

fn snapshot_name_matches_request(
    summary: &MdbxManagedSnapshotSummary,
    requested_name: &str,
) -> bool {
    if requested_name.is_empty() {
        summary.name == format!("Snapshot {}", summary.created_at)
    } else {
        summary.name == requested_name
    }
}

fn is_legacy_snapshot_commit(commit: &MdbxCommitHistoryItem) -> bool {
    commit.commit_kind == "snapshot"
        && commit.change_scope == "multi"
        && commit.operation_kind.as_deref() == Some("legacy-snapshot")
}

fn restore_affected_object_count(
    commit: &MdbxCommitHistoryItem,
    snapshot_id: &str,
) -> Result<u32, RpcFailure> {
    let count = commit
        .changes
        .iter()
        .filter(|change| change.object_id != snapshot_id)
        .map(|change| change.object_id.as_str())
        .collect::<HashSet<_>>()
        .len();
    u32::try_from(count).map_err(|_| {
        RpcFailure::new(
            "snapshot-operation-state-unknown",
            "MDBX2 restored Object count exceeds the browser recovery limit.",
            false,
        )
    })
}

fn find_snapshot_delete_commit(
    vault: &Arc<MdbxVault>,
    device_id: &str,
    baseline_local_seq: u64,
    snapshot_id: &str,
) -> Result<Option<String>, RpcFailure> {
    let commits = match snapshot_commits_after(vault, device_id, baseline_local_seq) {
        Ok(commits) => commits,
        Err(error) if error.code == "snapshot-operation-state-unknown" => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut matches = commits.into_iter().filter(|commit| {
        commit.operation_kind.as_deref() == Some("delete-snapshot")
            && commit.changes.iter().any(|change| {
                change.object_id == snapshot_id
                    && change.object_type == "snapshot"
                    && change.action == "delete"
            })
    });
    let first = matches.next().map(|commit| commit.commit_id);
    if matches.next().is_some() {
        Ok(None)
    } else {
        Ok(first)
    }
}

fn prune_snapshot_operation_receipts(
    receipts: &mut Vec<SnapshotOperationReceipt>,
) -> Result<(), RpcFailure> {
    if receipts.len() < MAX_SNAPSHOT_OPERATION_RECEIPTS {
        return Ok(());
    }
    receipts.sort_by_key(|receipt| {
        (
            !(receipt.completed || receipt.outcome_unknown),
            receipt.updated_at_unix_secs,
        )
    });
    while receipts.len() >= MAX_SNAPSHOT_OPERATION_RECEIPTS {
        if receipts
            .first()
            .is_some_and(|receipt| receipt.completed || receipt.outcome_unknown)
        {
            receipts.remove(0);
        } else {
            return Err(RpcFailure::new(
                "snapshot-operation-receipt-limit",
                "MDBX2 has too many unfinished snapshot operations.",
                false,
            ));
        }
    }
    Ok(())
}

fn load_snapshot_operation_state(root: &Path) -> std::io::Result<SnapshotOperationState> {
    let mut candidates = Vec::new();
    for slot in [0_u64, 1_u64] {
        let path = snapshot_operation_state_path(root, slot);
        if !path.exists() {
            continue;
        }
        let Ok(bytes) = read_bounded(&path, MAX_SNAPSHOT_OPERATION_STATE_BYTES) else {
            continue;
        };
        let Ok(state) = serde_json::from_slice::<SnapshotOperationState>(&bytes) else {
            continue;
        };
        if state.version != SNAPSHOT_OPERATION_STATE_VERSION || state.revision % 2 != slot {
            continue;
        }
        if validate_snapshot_operation_state(&state) {
            candidates.push(state);
        }
    }
    Ok(candidates
        .into_iter()
        .max_by_key(|state| state.revision)
        .unwrap_or_default())
}

fn validate_snapshot_operation_state(state: &SnapshotOperationState) -> bool {
    if state.receipts.len() > MAX_SNAPSHOT_OPERATION_RECEIPTS {
        return false;
    }
    let mut identities = HashSet::new();
    state.receipts.iter().all(|receipt| {
        let target_valid = receipt
            .target_snapshot_id
            .as_deref()
            .is_none_or(|value| canonical_uuid(value).as_deref() == Some(value));
        let target_base_valid = receipt
            .target_base_commit_id
            .as_deref()
            .is_none_or(|value| canonical_uuid(value).as_deref() == Some(value));
        let result_snapshot_valid = receipt
            .result_snapshot_id
            .as_deref()
            .is_none_or(|value| canonical_uuid(value).as_deref() == Some(value));
        let result_commit_valid = receipt
            .result_commit_id
            .as_deref()
            .is_none_or(|value| canonical_uuid(value).as_deref() == Some(value));
        let shape_valid = match receipt.kind {
            SnapshotOperationKind::Create => {
                receipt.target_snapshot_id.is_none()
                    && receipt.target_base_commit_id.is_none()
                    && receipt.affected_object_count.is_none()
                    && (!receipt.completed
                        || (receipt.result_snapshot_id.is_some()
                            && receipt.result_commit_id.is_some()))
            }
            SnapshotOperationKind::Delete => {
                receipt.target_snapshot_id.is_some()
                    && receipt.target_base_commit_id.is_some()
                    && receipt.result_snapshot_id.is_none()
                    && receipt.affected_object_count.is_none()
            }
            SnapshotOperationKind::Restore => {
                receipt.target_snapshot_id.is_some()
                    && receipt.target_base_commit_id.is_some()
                    && receipt.result_snapshot_id.is_none()
                    && (!receipt.completed
                        || (receipt.result_commit_id.is_some()
                            && receipt.affected_object_count.is_some()))
            }
        };
        canonical_uuid(&receipt.vault_handle).as_deref() == Some(receipt.vault_handle.as_str())
            && canonical_uuid(&receipt.operation_id).as_deref()
                == Some(receipt.operation_id.as_str())
            && valid_sha256(&receipt.intent_sha256)
            && valid_sha256(&receipt.pre_branch_state_sha256)
            && target_valid
            && target_base_valid
            && result_snapshot_valid
            && result_commit_valid
            && shape_valid
            && !(receipt.completed && receipt.outcome_unknown)
            && (receipt.completed
                || (receipt.result_snapshot_id.is_none()
                    && receipt.result_commit_id.is_none()
                    && receipt.affected_object_count.is_none()))
            && identities.insert((receipt.vault_handle.clone(), receipt.operation_id.clone()))
    })
}

fn snapshot_operation_state_path(root: &Path, slot: u64) -> PathBuf {
    root.join("operations")
        .join(format!("snapshot-operations.state.{slot}.json"))
}

fn find_unresolved_conflict(
    vault: &Arc<MdbxVault>,
    conflict_id: &str,
) -> Result<Option<MdbxConflictSummary>, RpcFailure> {
    let mut cursor = None;
    for _ in 0..MAX_CONFLICT_SCAN_PAGES {
        let page = vault
            .list_unresolved_conflict_summaries(None, MAX_CONFLICT_PAGE_SIZE, cursor)
            .map_err(|_| {
                RpcFailure::new(
                    "conflict-list-failed",
                    "MDBX2 unresolved conflicts could not be inspected.",
                    false,
                )
            })?;
        if let Some(summary) = page
            .items
            .into_iter()
            .find(|summary| summary.conflict_id == conflict_id)
        {
            return Ok(Some(summary));
        }
        let Some(next_cursor) = page.next_cursor else {
            return Ok(None);
        };
        cursor = Some(next_cursor);
    }
    Err(RpcFailure::new(
        "conflict-queue-scan-limit",
        "MDBX2 conflict queue is too large to safely locate this item in one operation.",
        false,
    ))
}

fn take_conflict_resolution_choice(
    params: &mut Map<String, Value>,
) -> Result<ConflictResolutionChoice, RpcFailure> {
    match take_string(params, "choice", 32, false)?.as_str() {
        "local-wins" => Ok(ConflictResolutionChoice::LocalWins),
        "incoming-wins" => Ok(ConflictResolutionChoice::IncomingWins),
        _ => Err(RpcFailure::invalid(
            "MDBX2 conflict resolution choice is unsupported.",
        )),
    }
}

fn conflict_choice_to_ffi(choice: ConflictResolutionChoice) -> MdbxConflictChoice {
    match choice {
        ConflictResolutionChoice::LocalWins => MdbxConflictChoice::LocalWins,
        ConflictResolutionChoice::IncomingWins => MdbxConflictChoice::IncomingWins,
    }
}

fn conflict_choice_value(choice: ConflictResolutionChoice) -> &'static str {
    match choice {
        ConflictResolutionChoice::LocalWins => "local-wins",
        ConflictResolutionChoice::IncomingWins => "incoming-wins",
    }
}

fn conflict_resolution_json(receipt: &ConflictResolutionReceipt, already_resolved: bool) -> Value {
    json!({
        "resolved": true,
        "alreadyResolved": already_resolved,
        "conflictId": receipt.conflict_id,
        "objectType": receipt.object_type,
        "objectId": receipt.object_id,
        "choice": conflict_choice_value(receipt.choice),
        "resolvedAt": receipt.resolved_at
    })
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn canonical_uuid(value: &str) -> Option<String> {
    Uuid::parse_str(value)
        .ok()
        .map(|uuid| uuid.hyphenated().to_string())
}

fn fresh_uuid() -> String {
    Uuid::new_v4().hyphenated().to_string()
}

fn read_bounded(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    if length == 0 || length > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded file length is invalid",
        ));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn hash_file(mut file: File) -> Result<String, RpcFailure> {
    file.seek(SeekFrom::Start(0))
        .map_err(|_| RpcFailure::storage("Native transfer could not be verified."))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| RpcFailure::storage("Native transfer could not be verified."))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn ensure_contained_file(path: &Path, parent: &Path) -> Result<(), RpcFailure> {
    let parent = fs::canonicalize(parent).map_err(|_| {
        RpcFailure::new(
            "vault-source-not-found",
            "MDBX2 vault source does not exist.",
            false,
        )
    })?;
    let path = fs::canonicalize(path).map_err(|_| {
        RpcFailure::new(
            "vault-source-not-found",
            "MDBX2 vault source does not exist.",
            false,
        )
    })?;
    let metadata = fs::metadata(&path).map_err(|_| {
        RpcFailure::new(
            "vault-source-not-found",
            "MDBX2 vault source does not exist.",
            false,
        )
    })?;
    if !path.starts_with(parent) || !metadata.is_file() {
        return Err(RpcFailure::new(
            "vault-source-invalid",
            "MDBX2 vault source is outside the Host storage boundary.",
            false,
        ));
    }
    Ok(())
}

fn copy_create_new(source: &Path, destination: &Path) -> Result<(), RpcFailure> {
    let mut source = File::open(source)
        .map_err(|_| RpcFailure::storage("Native Host could not read the transferred vault."))?;
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| RpcFailure::storage("Native Host could not create the vault working copy."))?;
    std::io::copy(&mut source, &mut destination)
        .and_then(|_| destination.sync_all())
        .map_err(|_| {
            RpcFailure::storage("Native Host could not persist the vault working copy.")
        })?;
    Ok(())
}

fn path_string(path: &Path) -> Result<String, RpcFailure> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        RpcFailure::new(
            "host-path-unsupported",
            "Native Host storage path is unsupported.",
            false,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = env::temp_dir().join(format!("monica-mdbx2-host-test-{}", fresh_uuid()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn runtime() -> (TestRoot, HostRuntime) {
        let root = TestRoot::new();
        let runtime = HostRuntime::new(root.0.clone()).unwrap();
        (root, runtime)
    }

    fn open_test_vault(runtime: &mut HostRuntime, password: &str) -> String {
        let source_path = runtime.root.join(format!("source-{}.mdbx", fresh_uuid()));
        let source = mdbx_ffi::create_vault(
            path_string(&source_path).unwrap(),
            password.to_string(),
            "snapshot-fixture-device".to_string(),
        )
        .unwrap();
        let file_handle = fresh_uuid();
        source
            .create_backup(path_string(&runtime.import_file_path(&file_handle)).unwrap())
            .unwrap();
        drop(source);
        call(
            runtime,
            "vault.open",
            json!({
                "source": { "kind": "file", "handle": file_handle },
                "credential": { "method": "password", "password": password }
            }),
        )["vaultHandle"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn reopen_test_vault(runtime: &mut HostRuntime, vault_handle: &str, password: &str) {
        call(
            runtime,
            "vault.open",
            json!({
                "source": { "kind": "vault", "handle": vault_handle },
                "credential": { "method": "password", "password": password }
            }),
        );
    }

    fn upsert_test_login(
        runtime: &mut HostRuntime,
        vault_handle: &str,
        logical_object_id: &str,
        title: &str,
    ) -> Value {
        call(
            runtime,
            "object.upsert",
            json!({
                "vaultHandle": vault_handle,
                "operationId": fresh_uuid(),
                "logicalObjectId": logical_object_id,
                "collectionId": null,
                "objectTypeId": "login",
                "title": title,
                "payloadJson": json!({
                    "kind": "password",
                    "monica_entry_id": logical_object_id,
                    "password_plain": "snapshot-test-secret"
                }).to_string()
            }),
        )
    }

    fn call(runtime: &mut HostRuntime, method: &str, params: Value) -> Value {
        runtime.handle(method, params).unwrap()
    }

    fn begin(runtime: &mut HostRuntime, bytes: &[u8], digest: Option<String>) -> String {
        call(
            runtime,
            "transfer.begin",
            json!({
                "direction": "extension-to-host",
                "purpose": "vault-bootstrap",
                "sizeBytes": bytes.len(),
                "sha256": digest.unwrap_or_else(|| sha256_bytes(bytes))
            }),
        )["transferId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn send_chunk(
        runtime: &mut HostRuntime,
        transfer_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Value {
        call(
            runtime,
            "transfer.chunk",
            json!({
                "transferId": transfer_id,
                "offset": offset,
                "dataBase64": BASE64.encode(bytes)
            }),
        )
    }

    fn sha256_bytes(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    struct TestAttachmentUpload<'a> {
        vault_handle: &'a str,
        operation_id: &'a str,
        attachment_id: &'a str,
        collection_id: &'a str,
        object_id: &'a str,
        file_name: &'a str,
        media_type: Option<&'a str>,
        mode: &'a str,
    }

    fn begin_attachment_upload(
        runtime: &mut HostRuntime,
        input: TestAttachmentUpload<'_>,
        bytes: &[u8],
    ) -> String {
        call(
            runtime,
            "attachment.upload.begin",
            json!({
                "vaultHandle": input.vault_handle,
                "operationId": input.operation_id,
                "attachmentId": input.attachment_id,
                "collectionId": input.collection_id,
                "objectId": input.object_id,
                "fileName": input.file_name,
                "mediaType": input.media_type,
                "mode": input.mode,
                "sizeBytes": bytes.len(),
                "sha256": sha256_bytes(bytes)
            }),
        )["transferId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn send_attachment_chunk(
        runtime: &mut HostRuntime,
        transfer_id: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Value {
        call(
            runtime,
            "attachment.upload.chunk",
            json!({
                "transferId": transfer_id,
                "offset": offset,
                "dataBase64": BASE64.encode(bytes)
            }),
        )
    }

    fn read_attachment_bytes(
        runtime: &mut HostRuntime,
        vault_handle: &str,
        attachment_id: &str,
    ) -> Vec<u8> {
        let begun = call(
            runtime,
            "attachment.read.begin",
            json!({
                "vaultHandle": vault_handle,
                "attachmentId": attachment_id
            }),
        );
        let read_handle = begun["readHandle"].as_str().unwrap().to_string();
        let size = begun["sizeBytes"].as_u64().unwrap() as usize;
        let mut bytes = Vec::with_capacity(size);
        while bytes.len() < size {
            let chunk = call(
                runtime,
                "attachment.read.chunk",
                json!({
                    "readHandle": read_handle,
                    "offset": bytes.len(),
                    "maxBytes": 64 * 1024
                }),
            );
            bytes.extend_from_slice(
                &BASE64
                    .decode(chunk["dataBase64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert!(call(
            runtime,
            "attachment.read.release",
            json!({ "readHandle": read_handle })
        )["released"]
            .as_bool()
            .unwrap());
        bytes
    }

    #[test]
    fn attachment_sessions_round_trip_external_content_and_delete_idempotently() {
        let (_root, mut runtime) = runtime();
        let vault_handle = open_test_vault(&mut runtime, "attachment-round-trip-password");
        let object = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:attachment-round-trip",
            "Attachment target",
        );
        let collection_id = object["collectionId"].as_str().unwrap().to_string();
        let object_id = object["objectId"].as_str().unwrap().to_string();
        let attachment_id = fresh_uuid();
        let operation_id = fresh_uuid();
        let content = (0..(MAX_BINARY_CHUNK_BYTES + 19_337))
            .map(|index| ((index * 31 + 7) % 251) as u8)
            .collect::<Vec<_>>();
        let transfer_id = begin_attachment_upload(
            &mut runtime,
            TestAttachmentUpload {
                vault_handle: &vault_handle,
                operation_id: &operation_id,
                attachment_id: &attachment_id,
                collection_id: &collection_id,
                object_id: &object_id,
                file_name: "private-evidence.bin",
                media_type: Some("application/octet-stream"),
                mode: "create",
            },
            &content,
        );
        let first = &content[..MAX_BINARY_CHUNK_BYTES];
        let accepted = send_attachment_chunk(&mut runtime, &transfer_id, 0, first);
        assert_eq!(accepted["acceptedBytes"], MAX_BINARY_CHUNK_BYTES);
        let repeated = send_attachment_chunk(&mut runtime, &transfer_id, 0, first);
        assert_eq!(repeated["acceptedBytes"], 0);
        assert_eq!(repeated["repeated"], true);
        send_attachment_chunk(
            &mut runtime,
            &transfer_id,
            MAX_BINARY_CHUNK_BYTES,
            &content[MAX_BINARY_CHUNK_BYTES..],
        );
        let created = call(
            &mut runtime,
            "attachment.upload.finish",
            json!({ "transferId": transfer_id }),
        );
        assert_eq!(created["attachment"]["attachmentId"], attachment_id);
        assert_eq!(created["attachment"]["storageMode"], "external-hash-ref");
        assert_eq!(created["attachment"]["sizeBytes"], content.len());
        assert_eq!(created["alreadyCommitted"], false);
        let cached = call(
            &mut runtime,
            "attachment.upload.finish",
            json!({ "transferId": transfer_id }),
        );
        assert_eq!(cached["commitId"], created["commitId"]);

        let page = call(
            &mut runtime,
            "attachment.list",
            json!({
                "vaultHandle": vault_handle,
                "collectionId": collection_id,
                "objectId": object_id,
                "pageSize": 20,
                "cursor": null
            }),
        );
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert!(page["items"][0].get("contentHash").is_none());
        assert!(page["items"][0].get("commitId").is_none());
        assert_eq!(
            read_attachment_bytes(&mut runtime, &vault_handle, &attachment_id),
            content
        );
        assert!(call(
            &mut runtime,
            "attachment.upload.abort",
            json!({ "transferId": transfer_id })
        )["aborted"]
            .as_bool()
            .unwrap());

        let replacement = b"replacement attachment bytes with a different authenticated digest";
        let replace_operation = fresh_uuid();
        let replace_transfer = begin_attachment_upload(
            &mut runtime,
            TestAttachmentUpload {
                vault_handle: &vault_handle,
                operation_id: &replace_operation,
                attachment_id: &attachment_id,
                collection_id: &collection_id,
                object_id: &object_id,
                file_name: "private-evidence.bin",
                media_type: Some("application/octet-stream"),
                mode: "replace",
            },
            replacement,
        );
        send_attachment_chunk(&mut runtime, &replace_transfer, 0, replacement);
        let replaced = call(
            &mut runtime,
            "attachment.upload.finish",
            json!({ "transferId": replace_transfer }),
        );
        assert_eq!(replaced["attachment"]["sizeBytes"], replacement.len());
        assert_eq!(
            read_attachment_bytes(&mut runtime, &vault_handle, &attachment_id),
            replacement
        );
        call(
            &mut runtime,
            "attachment.upload.abort",
            json!({ "transferId": replace_transfer }),
        );

        let delete_operation = fresh_uuid();
        let deleted = call(
            &mut runtime,
            "attachment.delete",
            json!({
                "vaultHandle": vault_handle,
                "operationId": delete_operation,
                "attachmentId": attachment_id
            }),
        );
        assert_eq!(deleted["attachment"]["deleted"], true);
        assert_eq!(deleted["alreadyCommitted"], false);
        let repeated_delete = call(
            &mut runtime,
            "attachment.delete",
            json!({
                "vaultHandle": vault_handle,
                "operationId": delete_operation,
                "attachmentId": attachment_id
            }),
        );
        assert_eq!(repeated_delete["alreadyCommitted"], true);
        assert_eq!(repeated_delete["commitId"], deleted["commitId"]);
        let empty = call(
            &mut runtime,
            "attachment.list",
            json!({
                "vaultHandle": vault_handle,
                "collectionId": collection_id,
                "objectId": object_id,
                "pageSize": 20,
                "cursor": null
            }),
        );
        assert!(empty["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn attachment_upload_limits_and_retry_intent_fail_closed() {
        let (_root, mut runtime) = runtime();
        let vault_handle = open_test_vault(&mut runtime, "attachment-limits-password");
        let object = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:attachment-limits",
            "Attachment limits target",
        );
        let collection_id = object["collectionId"].as_str().unwrap();
        let object_id = object["objectId"].as_str().unwrap();
        let operation_id = fresh_uuid();
        let attachment_id = fresh_uuid();
        let content = b"bounded bytes";
        let transfer_id = begin_attachment_upload(
            &mut runtime,
            TestAttachmentUpload {
                vault_handle: &vault_handle,
                operation_id: &operation_id,
                attachment_id: &attachment_id,
                collection_id,
                object_id,
                file_name: "bounded.bin",
                media_type: None,
                mode: "create",
            },
            content,
        );
        let mismatch = runtime
            .handle(
                "attachment.upload.begin",
                json!({
                    "vaultHandle": vault_handle,
                    "operationId": operation_id,
                    "attachmentId": attachment_id,
                    "collectionId": collection_id,
                    "objectId": object_id,
                    "fileName": "changed.bin",
                    "mediaType": null,
                    "mode": "create",
                    "sizeBytes": content.len(),
                    "sha256": sha256_bytes(content)
                }),
            )
            .unwrap_err();
        assert_eq!(mismatch.code, "attachment-upload-operation-mismatch");
        let gap = runtime
            .handle(
                "attachment.upload.chunk",
                json!({
                    "transferId": transfer_id,
                    "offset": 1,
                    "dataBase64": BASE64.encode(&content[..1])
                }),
            )
            .unwrap_err();
        assert_eq!(gap.code, "attachment-upload-offset-mismatch");
        send_attachment_chunk(&mut runtime, &transfer_id, 0, content);
        let changed_retry = runtime
            .handle(
                "attachment.upload.chunk",
                json!({
                    "transferId": transfer_id,
                    "offset": 0,
                    "dataBase64": BASE64.encode(b"changed byte!")
                }),
            )
            .unwrap_err();
        assert_eq!(changed_retry.code, "attachment-upload-retry-mismatch");
        call(
            &mut runtime,
            "attachment.upload.abort",
            json!({ "transferId": transfer_id }),
        );

        let oversized = runtime
            .handle(
                "attachment.upload.begin",
                json!({
                    "vaultHandle": vault_handle,
                    "operationId": fresh_uuid(),
                    "attachmentId": fresh_uuid(),
                    "collectionId": collection_id,
                    "objectId": object_id,
                    "fileName": "oversized.bin",
                    "mediaType": null,
                    "mode": "create",
                    "sizeBytes": MAX_ATTACHMENT_BYTES as u64 + 1,
                    "sha256": null
                }),
            )
            .unwrap_err();
        assert_eq!(oversized.code, "attachment-too-large");
    }

    #[test]
    fn snapshot_structure_hides_android_synthetic_root_and_promotes_children() {
        let root_id = fresh_uuid();
        let child_id = fresh_uuid();
        let root_ids = HashSet::from([root_id.clone()]);
        let normalized = normalize_snapshot_structure_nodes(
            vec![
                MdbxSnapshotStructureNode {
                    id: root_id.clone(),
                    parent_id: None,
                    name: MONICA_ROOT_PROJECT_TITLE.to_string(),
                    node_type: "folder".to_string(),
                    path: MONICA_ROOT_PROJECT_TITLE.to_string(),
                    status: "unchanged".to_string(),
                    child_count: 1,
                    metadata: "internal root".to_string(),
                },
                MdbxSnapshotStructureNode {
                    id: child_id.clone(),
                    parent_id: Some(root_id),
                    name: "工作账号".to_string(),
                    node_type: "entry".to_string(),
                    path: ".monica-root/工作账号".to_string(),
                    status: "modified".to_string(),
                    child_count: 0,
                    metadata: "login".to_string(),
                },
            ],
            &root_ids,
        );

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].id, child_id);
        assert_eq!(normalized[0].parent_id, None);
        assert_eq!(normalized[0].path, "工作账号");
    }

    #[test]
    fn transfer_is_exact_offset_idempotent_and_publishes_only_after_digest_verification() {
        let (_root, mut runtime) = runtime();
        let bytes = b"opaque encrypted MDBX2 bootstrap bytes";
        let transfer_id = begin(&mut runtime, bytes, None);
        let split = 13;
        assert_eq!(
            send_chunk(&mut runtime, &transfer_id, 0, &bytes[..split])["nextOffset"],
            split
        );
        let repeated = send_chunk(&mut runtime, &transfer_id, 0, &bytes[..split]);
        assert_eq!(repeated["repeated"], true);
        assert_eq!(repeated["acceptedBytes"], 0);
        send_chunk(&mut runtime, &transfer_id, split as u64, &bytes[split..]);
        let finished = call(
            &mut runtime,
            "transfer.finish",
            json!({ "transferId": transfer_id }),
        );
        let file_handle = finished["fileHandle"].as_str().unwrap();
        assert_eq!(
            fs::read(runtime.import_file_path(file_handle)).unwrap(),
            bytes
        );
        assert_eq!(finished["sha256"], sha256_bytes(bytes));
    }

    #[test]
    fn transfer_rejects_gaps_and_deletes_digest_mismatches() {
        let (_root, mut runtime) = runtime();
        let bytes = b"ciphertext";
        let transfer_id = begin(&mut runtime, bytes, Some("0".repeat(64)));
        let gap = runtime
            .handle(
                "transfer.chunk",
                json!({ "transferId": transfer_id, "offset": 1, "dataBase64": BASE64.encode(bytes) }),
            )
            .unwrap_err();
        assert_eq!(gap.code, "transfer-offset-mismatch");
        send_chunk(&mut runtime, &transfer_id, 0, bytes);
        let mismatch = runtime
            .handle("transfer.finish", json!({ "transferId": transfer_id }))
            .unwrap_err();
        assert_eq!(mismatch.code, "transfer-digest-mismatch");
        assert!(runtime.transfers.is_empty());
    }

    #[test]
    fn transfer_resumes_from_the_last_two_slot_durable_offset() {
        let root = TestRoot::new();
        let bytes = b"durable transfer bytes";
        let transfer_id;
        {
            let mut first = HostRuntime::new(root.0.clone()).unwrap();
            transfer_id = begin(&mut first, bytes, None);
            send_chunk(&mut first, &transfer_id, 0, &bytes[..8]);
        }
        let mut resumed = HostRuntime::new(root.0.clone()).unwrap();
        assert_eq!(resumed.transfers[&transfer_id].received_bytes, 8);
        send_chunk(&mut resumed, &transfer_id, 8, &bytes[8..]);
        let finished = call(
            &mut resumed,
            "transfer.finish",
            json!({ "transferId": transfer_id }),
        );
        assert_eq!(
            fs::read(resumed.import_file_path(finished["fileHandle"].as_str().unwrap())).unwrap(),
            bytes
        );
    }

    #[test]
    fn vault_inspection_rejects_mdbx1_before_open_can_upgrade_it() {
        let (_root, mut runtime) = runtime();
        let file_handle = fresh_uuid();
        let path = runtime.import_file_path(&file_handle);
        let connection = Connection::open(&path).unwrap();
        mdbx_storage::schema::v1::create_all_tables(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('legacy-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
                [],
            )
            .unwrap();
        drop(connection);

        let error = runtime
            .handle(
                "vault.inspect",
                json!({ "source": { "kind": "file", "handle": file_handle } }),
            )
            .unwrap_err();
        assert_eq!(error.code, "mdbx-format-unsupported");
        let connection = Connection::open(&path).unwrap();
        let format: String = connection
            .query_row("SELECT format_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(format, "MDBX-1");
    }

    #[test]
    fn opens_and_locks_a_real_mdbx2_vault_with_an_opaque_working_copy() {
        let (root, mut runtime) = runtime();
        let source_path = runtime.root.join("source.mdbx");
        let source = mdbx_ffi::create_vault(
            path_string(&source_path).unwrap(),
            "test-password".to_string(),
            "fixture-device".to_string(),
        )
        .unwrap();
        let file_handle = fresh_uuid();
        source
            .create_backup(path_string(&runtime.import_file_path(&file_handle)).unwrap())
            .unwrap();
        drop(source);

        let inspection = call(
            &mut runtime,
            "vault.inspect",
            json!({ "source": { "kind": "file", "handle": file_handle } }),
        );
        assert_eq!(inspection["formatVersion"], "MDBX-2");
        let opened = call(
            &mut runtime,
            "vault.open",
            json!({
                "source": { "kind": "file", "handle": file_handle },
                "credential": { "method": "password", "password": "test-password" }
            }),
        );
        assert_eq!(opened["formatVersion"], "MDBX-2");
        assert_eq!(opened["health"]["healthy"], true);
        let vault_handle = opened["vaultHandle"].as_str().unwrap().to_string();
        assert!(runtime
            .root
            .join("vaults")
            .join(&vault_handle)
            .join("vault.mdbx")
            .exists());
        assert_eq!(
            call(
                &mut runtime,
                "vault.status",
                json!({ "vaultHandle": vault_handle.clone() })
            )["open"],
            true
        );
        let logical_object_id = "password:42";
        let written = call(
            &mut runtime,
            "object.upsert",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": fresh_uuid(),
                "logicalObjectId": logical_object_id,
                "collectionId": null,
                "objectTypeId": "login",
                "title": "Example",
                "payloadJson": json!({
                    "kind": "password",
                    "monica_entry_id": logical_object_id,
                    "website": "https://example.test",
                    "username": "demo",
                    "password_plain": "secret"
                }).to_string()
            }),
        );
        assert_eq!(written["logicalObjectId"], logical_object_id);
        let collection_id = written["collectionId"].as_str().unwrap().to_string();
        let object_id = written["objectId"].as_str().unwrap().to_string();
        let collections = call(
            &mut runtime,
            "collection.list",
            json!({ "vaultHandle": vault_handle.clone(), "deleted": false, "pageSize": 200, "cursor": null }),
        );
        assert_eq!(collections["items"].as_array().unwrap().len(), 1);
        let objects = call(
            &mut runtime,
            "object.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "collectionId": collection_id.clone(),
                "objectTypeId": null,
                "deleted": false,
                "pageSize": 200,
                "cursor": null
            }),
        );
        assert_eq!(objects["items"][0]["objectId"], object_id);
        let revealed = call(
            &mut runtime,
            "object.reveal",
            json!({ "vaultHandle": vault_handle.clone(), "objectId": object_id }),
        );
        assert_eq!(
            serde_json::from_str::<Value>(revealed["payloadJson"].as_str().unwrap()).unwrap()
                ["monica_entry_id"],
            logical_object_id
        );
        let batch_params = json!({
            "vaultHandle": vault_handle.clone(),
            "operationId": null,
            "operationScope": "ab".repeat(32),
            "mutations": [
                {
                    "kind": "upsert",
                    "logicalObjectId": logical_object_id,
                    "collectionId": collection_id.clone(),
                    "objectTypeId": "login",
                    "title": "Example changed",
                    "payloadJson": json!({
                        "kind": "password",
                        "monica_entry_id": logical_object_id,
                        "website": "https://example.test",
                        "username": "demo",
                        "password_plain": "changed"
                    }).to_string()
                },
                {
                    "kind": "upsert",
                    "logicalObjectId": "note:batch",
                    "collectionId": collection_id.clone(),
                    "objectTypeId": "note",
                    "title": "Batch note",
                    "payloadJson": json!({
                        "kind": "note",
                        "monica_entry_id": "note:batch",
                        "item_data": "{}"
                    }).to_string()
                }
            ]
        });
        let batched = call(&mut runtime, "object.batch", batch_params.clone());
        assert_eq!(batched["changed"], true);
        assert_eq!(batched["alreadyCommitted"], false);
        assert_eq!(batched["items"].as_array().unwrap().len(), 2);
        let batch_operation_id = batched["operationId"].as_str().unwrap().to_string();
        let batch_commit_id = batched["commitId"].as_str().unwrap().to_string();
        let receipt_text = fs::read_dir(root.0.join("operations"))
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| fs::read_to_string(entry.path()).ok())
            .collect::<String>();
        for secret in [
            "password_plain",
            "Example changed",
            "Batch note",
            "https://example.test",
        ] {
            assert!(!receipt_text.contains(secret));
        }
        let history = runtime
            .require_open_vault(&vault_handle)
            .unwrap()
            .list_commit_history(100, None)
            .unwrap();
        let operation = history
            .items
            .iter()
            .find(|item| item.operation_id.as_deref() == Some(batch_operation_id.as_str()))
            .unwrap();
        assert_eq!(operation.commit_id, batch_commit_id);
        assert!(operation.changes.len() >= 2);
        let exposed_history = call(
            &mut runtime,
            "history.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "pageSize": 20,
                "cursor": null
            }),
        );
        let exposed_operation = exposed_history["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["commitId"] == batch_commit_id)
            .unwrap();
        assert_eq!(
            exposed_operation["operationKind"],
            "monica-extension-batch-objects"
        );
        assert!(exposed_operation["changes"].as_array().unwrap().len() >= 2);
        let exposed_diff = call(
            &mut runtime,
            "history.diff",
            json!({
                "vaultHandle": vault_handle.clone(),
                "commitId": batch_commit_id.clone()
            }),
        );
        assert!(exposed_diff["items"].as_array().unwrap().len() >= 2);
        assert!(exposed_diff["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["payloadChanged"] == true));
        let exposed_diff_text = serde_json::to_string(&exposed_diff).unwrap();
        assert!(!exposed_diff_text.contains("password_plain"));
        assert!(!exposed_diff_text.contains("https://example.test"));
        drop(runtime);
        let mut runtime = HostRuntime::new(root.0.clone()).unwrap();
        call(
            &mut runtime,
            "vault.open",
            json!({
                "source": { "kind": "vault", "handle": vault_handle.clone() },
                "credential": { "method": "password", "password": "test-password" }
            }),
        );
        let retried_batch = call(&mut runtime, "object.batch", batch_params);
        assert_eq!(retried_batch["commitId"], batch_commit_id);
        assert_eq!(retried_batch["alreadyCommitted"], true);
        let resolved = call(
            &mut runtime,
            "object.operation.resolve",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationScope": "ab".repeat(32)
            }),
        );
        assert_eq!(resolved["committed"], true);
        assert_eq!(resolved["commitId"], batch_commit_id);
        assert_eq!(
            call(
                &mut runtime,
                "object.delete",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": fresh_uuid(),
                    "logicalObjectId": logical_object_id
                })
            )["changed"],
            true
        );
        let deleted = call(
            &mut runtime,
            "object.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "collectionId": collection_id,
                "objectTypeId": null,
                "deleted": true,
                "pageSize": 200,
                "cursor": null
            }),
        );
        assert_eq!(deleted["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            call(
                &mut runtime,
                "vault.lock",
                json!({ "vaultHandle": vault_handle.clone() })
            )["locked"],
            true
        );
        assert_eq!(
            call(
                &mut runtime,
                "vault.status",
                json!({ "vaultHandle": vault_handle })
            )["open"],
            false
        );
    }

    #[test]
    fn history_methods_reject_unbounded_or_noncanonical_requests() {
        let (_root, mut runtime) = runtime();
        let error = runtime
            .handle(
                "history.list",
                json!({
                    "vaultHandle": fresh_uuid(),
                    "pageSize": MAX_HISTORY_PAGE_SIZE + 1,
                    "cursor": null
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "params-invalid");

        let error = runtime
            .handle(
                "history.diff",
                json!({
                    "vaultHandle": fresh_uuid(),
                    "commitId": "not-a-commit"
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "params-invalid");

        let error = runtime
            .handle(
                "history.revert",
                json!({
                    "vaultHandle": fresh_uuid(),
                    "commitId": fresh_uuid(),
                    "operationId": "not-an-operation"
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "params-invalid");
    }

    #[test]
    fn history_revert_is_entry_only_retry_safe_and_preserves_the_source_history() {
        let (root, mut runtime) = runtime();
        let vault_handle = open_test_vault(&mut runtime, "history-revert-password");
        let first = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:history-revert",
            "Before recovery",
        );
        let source_object_id = first["objectId"].as_str().unwrap().to_string();
        let changed = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:history-revert",
            "After recovery",
        );
        let source_commit_id = changed["commitId"].as_str().unwrap().to_string();
        let operation_id = fresh_uuid();
        let request = json!({
            "vaultHandle": vault_handle.clone(),
            "commitId": source_commit_id.clone(),
            "operationId": operation_id.clone()
        });

        let reverted = call(&mut runtime, "history.revert", request.clone());
        assert_eq!(reverted["operationId"], operation_id);
        assert_eq!(reverted["revertedObjectCount"], 1);
        let recovery_commit_id = reverted["commitId"].as_str().unwrap().to_string();
        let revealed = call(
            &mut runtime,
            "object.reveal",
            json!({
                "vaultHandle": vault_handle.clone(),
                "objectId": source_object_id
            }),
        );
        assert_eq!(revealed["title"], "Before recovery");
        assert!(!serde_json::to_string(&reverted)
            .unwrap()
            .contains("Before recovery"));

        let source_history = runtime
            .require_open_vault(&vault_handle)
            .unwrap()
            .get_commit_history(source_commit_id.clone())
            .unwrap()
            .unwrap();
        assert_eq!(source_history.commit_id, source_commit_id);
        for operation_kind in [
            "monica-initialize",
            "snapshot-create",
            "branch-create",
            "master-key-rotation",
            "security-policy-update",
        ] {
            let mut system_history = source_history.clone();
            system_history.operation_kind = Some(operation_kind.to_string());
            assert_eq!(
                validate_history_revert_eligibility(&system_history)
                    .unwrap_err()
                    .code,
                "history-revert-not-allowed"
            );
        }
        for change_scope in ["vault-meta", "key-epoch", "snapshot", "branch"] {
            let mut system_history = source_history.clone();
            system_history.change_scope = change_scope.to_string();
            assert_eq!(
                validate_history_revert_eligibility(&system_history)
                    .unwrap_err()
                    .code,
                "history-revert-not-allowed"
            );
        }
        for commit_kind in ["snapshot", "key-rotation"] {
            let mut system_history = source_history.clone();
            system_history.commit_kind = commit_kind.to_string();
            assert_eq!(
                validate_history_revert_eligibility(&system_history)
                    .unwrap_err()
                    .code,
                "history-revert-not-allowed"
            );
        }
        let mut empty_history = source_history.clone();
        empty_history.changes.clear();
        assert_eq!(
            validate_history_revert_eligibility(&empty_history)
                .unwrap_err()
                .code,
            "history-revert-not-allowed"
        );
        let mut mixed_history = source_history.clone();
        mixed_history.changes[0].object_type = "attachment".to_string();
        assert_eq!(
            validate_history_revert_eligibility(&mixed_history)
                .unwrap_err()
                .code,
            "history-revert-not-allowed"
        );
        let change_template = source_history.changes[0].clone();
        let mut oversized_history = source_history.clone();
        oversized_history.changes = (0..=MAX_HISTORY_REVERT_ITEMS)
            .map(|index| {
                let mut change = change_template.clone();
                change.object_id = format!("entry-{index}");
                change
            })
            .collect();
        assert_eq!(
            validate_history_revert_eligibility(&oversized_history)
                .unwrap_err()
                .code,
            "history-revert-not-allowed"
        );

        drop(runtime);
        let mut runtime = HostRuntime::new(root.0.clone()).unwrap();
        reopen_test_vault(&mut runtime, &vault_handle, "history-revert-password");
        let retried = call(&mut runtime, "history.revert", request);
        assert_eq!(retried["commitId"], recovery_commit_id);
        assert_eq!(retried["revertedObjectCount"], 1);

        let history = call(
            &mut runtime,
            "history.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "pageSize": MAX_HISTORY_PAGE_SIZE,
                "cursor": null
            }),
        );
        assert_eq!(
            history["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["operationId"] == operation_id)
                .count(),
            1
        );
        assert!(history["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["commitId"] == source_commit_id));

        let another_change = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:history-revert",
            "Another change",
        );
        let another_commit_id = another_change["commitId"].as_str().unwrap().to_string();
        let mismatch = runtime
            .handle(
                "history.revert",
                json!({
                    "vaultHandle": vault_handle,
                    "commitId": another_commit_id,
                    "operationId": operation_id
                }),
            )
            .unwrap_err();
        assert_eq!(mismatch.code, "history-revert-operation-mismatch");
    }

    #[test]
    fn snapshot_methods_page_payload_free_metadata_and_bounded_structure() {
        let (_root, mut runtime) = runtime();
        let source_path = runtime.root.join("snapshot-source.mdbx");
        let source = mdbx_ffi::create_vault(
            path_string(&source_path).unwrap(),
            "snapshot-password".to_string(),
            "snapshot-fixture-device".to_string(),
        )
        .unwrap();
        let file_handle = fresh_uuid();
        source
            .create_backup(path_string(&runtime.import_file_path(&file_handle)).unwrap())
            .unwrap();
        drop(source);
        let opened = call(
            &mut runtime,
            "vault.open",
            json!({
                "source": { "kind": "file", "handle": file_handle },
                "credential": { "method": "password", "password": "snapshot-password" }
            }),
        );
        let vault_handle = opened["vaultHandle"].as_str().unwrap().to_string();
        for (logical_id, title) in [
            ("password:snapshot-a", "Snapshot A"),
            ("password:snapshot-b", "Snapshot B"),
        ] {
            call(
                &mut runtime,
                "object.upsert",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": fresh_uuid(),
                    "logicalObjectId": logical_id,
                    "collectionId": null,
                    "objectTypeId": "login",
                    "title": title,
                    "payloadJson": json!({
                        "kind": "password",
                        "monica_entry_id": logical_id,
                        "password_plain": "must-not-cross-snapshot-rpc"
                    }).to_string()
                }),
            );
        }
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        let first_snapshot = vault
            .create_manual_snapshot(
                "Before browser update".to_string(),
                browser_snapshot_device_context(),
            )
            .unwrap();
        let first_snapshot_id = first_snapshot.snapshot_id.clone();
        vault
            .create_manual_snapshot(
                "Second browser snapshot".to_string(),
                browser_snapshot_device_context(),
            )
            .unwrap();
        drop(vault);

        let first_page = call(
            &mut runtime,
            "snapshot.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "pageSize": 1,
                "cursor": null
            }),
        );
        assert_eq!(first_page["items"].as_array().unwrap().len(), 1);
        assert!(first_page["nextCursor"].is_string());
        let second_page = call(
            &mut runtime,
            "snapshot.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "pageSize": 1,
                "cursor": first_page["nextCursor"].clone()
            }),
        );
        assert_eq!(second_page["items"].as_array().unwrap().len(), 1);
        let listed_text = serde_json::to_string(&json!([first_page, second_page])).unwrap();
        assert!(!listed_text.contains("snapshotHash"));
        assert!(!listed_text.contains("snapshotCiphertext"));
        assert!(!listed_text.contains("must-not-cross-snapshot-rpc"));

        let structure = call(
            &mut runtime,
            "snapshot.structure",
            json!({
                "vaultHandle": vault_handle.clone(),
                "snapshotId": first_snapshot_id.clone(),
                "side": "snapshot",
                "pageSize": 1,
                "cursor": null
            }),
        );
        assert_eq!(structure["side"], "snapshot");
        assert_eq!(structure["items"].as_array().unwrap().len(), 1);
        assert!(structure["totalNodes"].as_u64().unwrap() >= 2);
        assert!(structure["nextCursor"].is_string());
        let structure_text = serde_json::to_string(&structure).unwrap();
        assert!(!structure_text.contains("metadata"));
        assert!(!structure_text.contains("must-not-cross-snapshot-rpc"));

        call(
            &mut runtime,
            "object.upsert",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": fresh_uuid(),
                "logicalObjectId": "password:snapshot-a",
                "collectionId": null,
                "objectTypeId": "login",
                "title": "Snapshot A changed",
                "payloadJson": json!({
                    "kind": "password",
                    "monica_entry_id": "password:snapshot-a",
                    "password_plain": "changed-after-preview"
                }).to_string()
            }),
        );
        let stale = runtime
            .handle(
                "snapshot.structure",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "snapshotId": first_snapshot_id.clone(),
                    "side": "snapshot",
                    "pageSize": 1,
                    "cursor": structure["nextCursor"].clone()
                }),
            )
            .unwrap_err();
        assert_eq!(stale.code, "snapshot-structure-stale");

        let connection = Connection::open(
            runtime
                .root
                .join("vaults")
                .join(&vault_handle)
                .join("vault.mdbx"),
        )
        .unwrap();
        let mut corrupted_ciphertext: Vec<u8> = connection
            .query_row(
                "SELECT snapshot_ct FROM snapshots WHERE snapshot_id = ?1",
                rusqlite::params![&first_snapshot_id],
                |row| row.get(0),
            )
            .unwrap();
        corrupted_ciphertext[0] ^= 0x01;
        connection
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1 WHERE snapshot_id = ?2",
                rusqlite::params![corrupted_ciphertext, &first_snapshot_id],
            )
            .unwrap();
        drop(connection);
        let corrupted_list = call(
            &mut runtime,
            "snapshot.list",
            json!({
                "vaultHandle": vault_handle.clone(),
                "pageSize": MAX_SNAPSHOT_PAGE_SIZE,
                "cursor": null
            }),
        );
        let corrupted = corrupted_list["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["snapshotId"] == first_snapshot_id)
            .unwrap();
        assert_eq!(corrupted["integrityOk"], false);
        let integrity_error = runtime
            .handle(
                "snapshot.structure",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "snapshotId": first_snapshot_id.clone(),
                    "side": "snapshot",
                    "pageSize": 1,
                    "cursor": null
                }),
            )
            .unwrap_err();
        assert_eq!(integrity_error.code, "snapshot-integrity-failed");
        let restore_operation_id = fresh_uuid();
        let restore_error = runtime
            .handle(
                "snapshot.restore",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": restore_operation_id.clone(),
                    "snapshotId": first_snapshot_id
                }),
            )
            .unwrap_err();
        assert_eq!(restore_error.code, "snapshot-integrity-failed");
        assert!(runtime
            .snapshot_operation_receipt(&vault_handle, &restore_operation_id)
            .is_none());
    }

    #[test]
    fn snapshot_methods_reject_unbounded_requests_and_invalid_structure_sides() {
        let (_root, mut runtime) = runtime();
        let error = runtime
            .handle(
                "snapshot.list",
                json!({
                    "vaultHandle": fresh_uuid(),
                    "pageSize": MAX_SNAPSHOT_PAGE_SIZE + 1,
                    "cursor": null
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "params-invalid");

        let error = runtime
            .handle(
                "snapshot.structure",
                json!({
                    "vaultHandle": fresh_uuid(),
                    "snapshotId": fresh_uuid(),
                    "side": "both",
                    "pageSize": 1,
                    "cursor": null
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "params-invalid");

        let oversized = json!({ "items": ["x".repeat(MAX_SNAPSHOT_RESULT_BYTES)] });
        let error = bounded_snapshot_result(oversized).unwrap_err();
        assert_eq!(error.code, "snapshot-result-too-large");
    }

    #[test]
    fn snapshot_mutations_round_trip_and_reject_operation_reuse() {
        let (_root, mut runtime) = runtime();
        let vault_handle = open_test_vault(&mut runtime, "snapshot-round-trip-password");
        let written = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:snapshot-round-trip",
            "Before snapshot",
        );
        let object_id = written["objectId"].as_str().unwrap().to_string();

        let create_operation_id = fresh_uuid();
        let created = call(
            &mut runtime,
            "snapshot.create",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": create_operation_id.clone(),
                "name": ""
            }),
        );
        assert_eq!(created["alreadyCompleted"], false);
        let snapshot_id = created["snapshotId"].as_str().unwrap().to_string();
        let create_commit_id = created["commitId"].as_str().unwrap().to_string();
        let repeated_create = call(
            &mut runtime,
            "snapshot.create",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": create_operation_id.clone(),
                "name": ""
            }),
        );
        assert_eq!(repeated_create["alreadyCompleted"], true);
        assert_eq!(repeated_create["snapshotId"], snapshot_id);
        assert_eq!(repeated_create["commitId"], create_commit_id);
        let mismatch = runtime
            .handle(
                "snapshot.create",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": create_operation_id,
                    "name": "different intent"
                }),
            )
            .unwrap_err();
        assert_eq!(mismatch.code, "snapshot-operation-mismatch");

        upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:snapshot-round-trip",
            "After snapshot",
        );
        let restore_operation_id = fresh_uuid();
        let restored = call(
            &mut runtime,
            "snapshot.restore",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": restore_operation_id.clone(),
                "snapshotId": snapshot_id.clone()
            }),
        );
        assert_eq!(restored["alreadyCompleted"], false);
        assert!(restored["affectedObjectCount"].as_u64().unwrap() >= 1);
        let restore_commit_id = restored["commitId"].as_str().unwrap().to_string();
        let revealed = call(
            &mut runtime,
            "object.reveal",
            json!({ "vaultHandle": vault_handle.clone(), "objectId": object_id }),
        );
        assert_eq!(revealed["title"], "Before snapshot");
        let repeated_restore = call(
            &mut runtime,
            "snapshot.restore",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": restore_operation_id,
                "snapshotId": snapshot_id.clone()
            }),
        );
        assert_eq!(repeated_restore["alreadyCompleted"], true);
        assert_eq!(repeated_restore["commitId"], restore_commit_id);

        let delete_operation_id = fresh_uuid();
        let deleted = call(
            &mut runtime,
            "snapshot.delete",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": delete_operation_id.clone(),
                "snapshotId": snapshot_id.clone()
            }),
        );
        assert_eq!(deleted["alreadyCompleted"], false);
        assert!(deleted["commitId"].is_string());
        let repeated_delete = call(
            &mut runtime,
            "snapshot.delete",
            json!({
                "vaultHandle": vault_handle,
                "operationId": delete_operation_id,
                "snapshotId": snapshot_id
            }),
        );
        assert_eq!(repeated_delete["alreadyCompleted"], true);
        assert_eq!(repeated_delete["commitId"], deleted["commitId"]);
    }

    #[test]
    fn snapshot_create_recovers_without_duplication_after_receipt_completion_loss() {
        let (root, mut runtime) = runtime();
        let password = "snapshot-create-recovery-password";
        let vault_handle = open_test_vault(&mut runtime, password);
        let operation_id = fresh_uuid();
        let private_name = "Private recovery snapshot";
        let blocked_slot = snapshot_operation_state_path(&root.0, 0);
        fs::create_dir(&blocked_slot).unwrap();
        let error = runtime
            .handle(
                "snapshot.create",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": operation_id.clone(),
                    "name": private_name
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "host-storage-error");
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        let page = vault.list_managed_snapshots(50, None).unwrap();
        assert_eq!(page.items.len(), 1);
        let created_snapshot_id = page.items[0].snapshot_id.clone();
        let operation_text = fs::read_to_string(snapshot_operation_state_path(&root.0, 1)).unwrap();
        assert!(!operation_text.contains(private_name));
        drop(vault);
        fs::remove_dir(&blocked_slot).unwrap();
        drop(runtime);

        let mut resumed = HostRuntime::new(root.0.clone()).unwrap();
        reopen_test_vault(&mut resumed, &vault_handle, password);
        let recovered = call(
            &mut resumed,
            "snapshot.create",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": fresh_uuid(),
                "name": private_name
            }),
        );
        assert_eq!(recovered["alreadyCompleted"], true);
        assert_eq!(recovered["operationId"], operation_id);
        assert_eq!(recovered["snapshotId"], created_snapshot_id);
        let vault = resumed.require_open_vault(&vault_handle).unwrap();
        assert_eq!(
            vault.list_managed_snapshots(50, None).unwrap().items.len(),
            1
        );
    }

    #[test]
    fn snapshot_delete_recovers_from_target_absence_after_receipt_completion_loss() {
        let (root, mut runtime) = runtime();
        let password = "snapshot-delete-recovery-password";
        let vault_handle = open_test_vault(&mut runtime, password);
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        let snapshot = vault
            .create_manual_snapshot(
                "Delete recovery".to_string(),
                browser_snapshot_device_context(),
            )
            .unwrap();
        drop(vault);
        let operation_id = fresh_uuid();
        let blocked_slot = snapshot_operation_state_path(&root.0, 0);
        fs::create_dir(&blocked_slot).unwrap();
        let error = runtime
            .handle(
                "snapshot.delete",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": operation_id.clone(),
                    "snapshotId": snapshot.snapshot_id.clone()
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "host-storage-error");
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        assert!(find_managed_snapshot(&vault, &snapshot.snapshot_id)
            .unwrap()
            .is_none());
        drop(vault);
        fs::remove_dir(&blocked_slot).unwrap();
        drop(runtime);

        let mut resumed = HostRuntime::new(root.0.clone()).unwrap();
        reopen_test_vault(&mut resumed, &vault_handle, password);
        let recovered = call(
            &mut resumed,
            "snapshot.delete",
            json!({
                "vaultHandle": vault_handle,
                "operationId": fresh_uuid(),
                "snapshotId": snapshot.snapshot_id
            }),
        );
        assert_eq!(recovered["alreadyCompleted"], true);
        assert_eq!(recovered["operationId"], operation_id);
    }

    #[test]
    fn snapshot_restore_recovers_the_original_commit_after_receipt_completion_loss() {
        let (root, mut runtime) = runtime();
        let password = "snapshot-restore-recovery-password";
        let vault_handle = open_test_vault(&mut runtime, password);
        let written = upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:snapshot-restore-recovery",
            "Restore original",
        );
        let object_id = written["objectId"].as_str().unwrap().to_string();
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        let snapshot = vault
            .create_manual_snapshot(
                "Restore recovery".to_string(),
                browser_snapshot_device_context(),
            )
            .unwrap();
        drop(vault);
        upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:snapshot-restore-recovery",
            "Restore changed",
        );

        let operation_id = fresh_uuid();
        let blocked_slot = snapshot_operation_state_path(&root.0, 0);
        fs::create_dir(&blocked_slot).unwrap();
        let error = runtime
            .handle(
                "snapshot.restore",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": operation_id.clone(),
                    "snapshotId": snapshot.snapshot_id.clone()
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "host-storage-error");
        let revealed = call(
            &mut runtime,
            "object.reveal",
            json!({ "vaultHandle": vault_handle.clone(), "objectId": object_id }),
        );
        assert_eq!(revealed["title"], "Restore original");
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        let matching_before = vault
            .list_commit_history(100, None)
            .unwrap()
            .items
            .into_iter()
            .filter(|commit| {
                is_legacy_snapshot_commit(commit)
                    && commit
                        .parent_ids
                        .iter()
                        .any(|parent| parent == &snapshot.base_commit_id)
                    && commit
                        .changes
                        .iter()
                        .any(|change| change.object_id == snapshot.snapshot_id)
            })
            .collect::<Vec<_>>();
        assert_eq!(matching_before.len(), 1);
        let restore_commit_id = matching_before[0].commit_id.clone();
        drop(vault);
        fs::remove_dir(&blocked_slot).unwrap();
        drop(runtime);

        let mut resumed = HostRuntime::new(root.0.clone()).unwrap();
        reopen_test_vault(&mut resumed, &vault_handle, password);
        let recovered = call(
            &mut resumed,
            "snapshot.restore",
            json!({
                "vaultHandle": vault_handle.clone(),
                "operationId": fresh_uuid(),
                "snapshotId": snapshot.snapshot_id.clone()
            }),
        );
        assert_eq!(recovered["alreadyCompleted"], true);
        assert_eq!(recovered["operationId"], operation_id);
        assert_eq!(recovered["commitId"], restore_commit_id);
        let vault = resumed.require_open_vault(&vault_handle).unwrap();
        let matching_after = vault
            .list_commit_history(100, None)
            .unwrap()
            .items
            .into_iter()
            .filter(|commit| {
                is_legacy_snapshot_commit(commit)
                    && commit
                        .parent_ids
                        .iter()
                        .any(|parent| parent == &snapshot.base_commit_id)
                    && commit
                        .changes
                        .iter()
                        .any(|change| change.object_id == snapshot.snapshot_id)
            })
            .count();
        assert_eq!(matching_after, 1);
    }

    #[test]
    fn snapshot_create_marks_ambiguous_changed_baselines_unknown_without_replay() {
        let (_root, mut runtime) = runtime();
        let vault_handle = open_test_vault(&mut runtime, "snapshot-unknown-password");
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        let baseline = snapshot_operation_baseline(&vault, &runtime.device_id).unwrap();
        drop(vault);
        let operation_id = fresh_uuid();
        let name = "Ambiguous snapshot";
        let intent_sha256 = snapshot_operation_intent_sha256(json!({
            "kind": "create",
            "name": name
        }))
        .unwrap();
        runtime
            .prepare_snapshot_operation(SnapshotOperationReceipt {
                vault_handle: vault_handle.clone(),
                operation_id: operation_id.clone(),
                kind: SnapshotOperationKind::Create,
                intent_sha256,
                target_snapshot_id: None,
                target_base_commit_id: None,
                pre_branch_state_sha256: baseline.branch_state_sha256,
                pre_device_local_seq: baseline.device_local_seq,
                completed: false,
                outcome_unknown: false,
                result_snapshot_id: None,
                result_commit_id: None,
                affected_object_count: None,
                updated_at_unix_secs: unix_seconds().unwrap(),
            })
            .unwrap();
        let pending = runtime
            .handle(
                "snapshot.create",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": fresh_uuid(),
                    "name": "A different pending snapshot"
                }),
            )
            .unwrap_err();
        assert_eq!(pending.code, "snapshot-operation-pending");
        upsert_test_login(
            &mut runtime,
            &vault_handle,
            "password:snapshot-unknown",
            "Unrelated later edit",
        );
        let error = runtime
            .handle(
                "snapshot.create",
                json!({
                    "vaultHandle": vault_handle.clone(),
                    "operationId": operation_id.clone(),
                    "name": name
                }),
            )
            .unwrap_err();
        assert_eq!(error.code, "snapshot-operation-state-unknown");
        assert!(
            runtime
                .snapshot_operation_receipt(&vault_handle, &operation_id)
                .unwrap()
                .outcome_unknown
        );
        let vault = runtime.require_open_vault(&vault_handle).unwrap();
        assert!(vault
            .list_managed_snapshots(50, None)
            .unwrap()
            .items
            .is_empty());
        drop(vault);
        let new_operation = call(
            &mut runtime,
            "snapshot.create",
            json!({
                "vaultHandle": vault_handle,
                "operationId": fresh_uuid(),
                "name": "Fresh explicit snapshot"
            }),
        );
        assert_eq!(new_operation["alreadyCompleted"], false);
    }

    #[test]
    fn browser_snapshot_context_does_not_claim_clipboard_or_capture_protection() {
        let context = browser_snapshot_device_context();
        assert_eq!(context.assurance, MdbxDeviceAssurance::Standard);
        assert!(!context.secure_clipboard_available);
        assert!(!context.screen_capture_protection_available);
        assert!(context.secure_temp_files_available);
    }

    #[test]
    fn conflict_resolution_receipts_rollback_when_persistence_fails() {
        let (root, mut runtime) = runtime();
        let vault_handle = fresh_uuid();
        let operation_id = fresh_uuid();
        let summary = MdbxConflictSummary {
            conflict_id: fresh_uuid(),
            object_type: "entry".to_string(),
            object_id: fresh_uuid(),
            base_commit_id: fresh_uuid(),
            local_commit_id: fresh_uuid(),
            incoming_commit_id: fresh_uuid(),
            conflicting_fields: vec!["payload".to_string()],
            resolution: "unresolved".to_string(),
            created_at: "2026-08-02T00:00:00Z".to_string(),
            resolved_at: None,
        };

        let first_slot = conflict_resolution_state_path(&root.0, 1);
        fs::create_dir(&first_slot).unwrap();
        let prepare_error = runtime
            .prepare_conflict_resolution(
                &vault_handle,
                &operation_id,
                &summary,
                ConflictResolutionChoice::IncomingWins,
            )
            .unwrap_err();
        assert_eq!(prepare_error.code, "host-storage-error");
        assert_eq!(runtime.conflict_resolutions.revision, 0);
        assert!(runtime.conflict_resolutions.receipts.is_empty());

        fs::remove_dir(&first_slot).unwrap();
        runtime
            .prepare_conflict_resolution(
                &vault_handle,
                &operation_id,
                &summary,
                ConflictResolutionChoice::IncomingWins,
            )
            .unwrap();
        assert_eq!(runtime.conflict_resolutions.revision, 1);
        assert!(!runtime.conflict_resolutions.receipts[0].completed);

        let second_slot = conflict_resolution_state_path(&root.0, 0);
        fs::create_dir(&second_slot).unwrap();
        let complete_error = runtime
            .complete_conflict_resolution(
                &vault_handle,
                &operation_id,
                Some("2026-08-02T00:01:00Z".to_string()),
            )
            .unwrap_err();
        assert_eq!(complete_error.code, "host-storage-error");
        assert_eq!(runtime.conflict_resolutions.revision, 1);
        assert!(!runtime.conflict_resolutions.receipts[0].completed);
        assert!(runtime.conflict_resolutions.receipts[0]
            .resolved_at
            .is_none());

        fs::remove_dir(&second_slot).unwrap();
        let completed = runtime
            .complete_conflict_resolution(
                &vault_handle,
                &operation_id,
                Some("2026-08-02T00:01:00Z".to_string()),
            )
            .unwrap();
        assert!(completed.completed);
        assert_eq!(runtime.conflict_resolutions.revision, 2);
    }

    #[test]
    fn java_name_uuid_matches_android_uuid_name_uuid_from_bytes() {
        assert_eq!(
            java_name_uuid(b"monica-root:test-vault"),
            "cb508e7b-24ba-31d8-8bfc-42e17c67bc07"
        );
        assert_eq!(
            java_name_uuid(b"monica-entry:test-vault:password:42"),
            "d98d22d3-805a-3b75-8b45-45a8857afdc7"
        );
    }
}
