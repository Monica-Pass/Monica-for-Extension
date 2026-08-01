use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use md5::{Digest, Md5};
use mdbx_ffi::{MdbxMigrationInfo, MdbxObjectDisclosureLimits, MdbxVault, MdbxWriteCommand};
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
        Ok(Self {
            root,
            device_id,
            transfers,
            vaults: HashMap::new(),
            object_operations,
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
        Ok(json!({
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
        }))
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
    let value = take_u64(params, "pageSize")?;
    if value == 0 || value > MAX_SUMMARY_PAGE_SIZE as u64 {
        return Err(RpcFailure::invalid(
            "pageSize exceeds the MDBX2 summary limit.",
        ));
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

fn reject_unknown(params: Map<String, Value>) -> Result<(), RpcFailure> {
    if params.is_empty() {
        Ok(())
    } else {
        Err(RpcFailure::invalid(
            "Native request contains unknown parameters.",
        ))
    }
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
