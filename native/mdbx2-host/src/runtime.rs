use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use mdbx_ffi::{MdbxMigrationInfo, MdbxVault};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const PROTOCOL_VERSION: u32 = 1;
pub const HOST_NAME: &str = "com.monica_pass.mdbx2";
pub const MDBX_CORE_REVISION: &str = "aafa22f195c626a8d8288d712bf42bccea134847";
pub const MDBX_FORMAT_VERSION: &str = "MDBX-2";
pub const MAX_BINARY_CHUNK_BYTES: usize = 256 * 1024;
pub const MAX_INBOUND_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const MAX_ACTIVE_TRANSFERS: usize = 4;

const TRANSFER_METADATA_VERSION: u32 = 1;
const DEVICE_METADATA_VERSION: u32 = 1;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_BASE64_CHUNK_BYTES: usize = ((MAX_BINARY_CHUNK_BYTES + 2) / 3) * 4;
const MAX_METADATA_BYTES: u64 = 16 * 1024;

#[derive(Debug)]
pub struct RpcFailure {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl RpcFailure {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("params-invalid", message, false)
    }

    fn storage(message: impl Into<String>) -> Self {
        Self::new("host-storage-error", message, true)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TransferPurpose {
    VaultBootstrap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferMetadata {
    version: u32,
    revision: u64,
    transfer_id: String,
    purpose: TransferPurpose,
    size_bytes: u64,
    sha256: String,
    received_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceMetadata {
    version: u32,
    device_id: String,
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
    root: PathBuf,
    device_id: String,
    transfers: HashMap<String, TransferMetadata>,
    vaults: HashMap<String, Arc<MdbxVault>>,
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
        for directory in ["transfers", "imports", "vaults", "backups"] {
            fs::create_dir_all(root.join(directory))?;
        }
        let device_id = load_or_create_device_id(&root)?;
        let transfers = load_transfers(&root)?;
        Ok(Self {
            root,
            device_id,
            transfers,
            vaults: HashMap::new(),
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
        let sha256 = take_sha256(&mut params, "sha256")?;
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
        if actual_sha256 != metadata.sha256 {
            self.delete_transfer(&transfer_id);
            return Err(RpcFailure::new(
                "transfer-digest-mismatch",
                "Native transfer SHA-256 verification failed.",
                false,
            ));
        }

        let (file_handle, destination) = loop {
            let handle = fresh_uuid();
            let destination = self.import_file_path(&handle);
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
        && valid_sha256(&metadata.sha256)
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
        ((MAX_SECRET_BYTES + 2) / 3) * 4,
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

fn take_uuid(params: &mut Map<String, Value>, key: &'static str) -> Result<String, RpcFailure> {
    let value = take_string(params, key, 64, false)?;
    canonical_uuid(&value)
        .filter(|canonical| canonical == &value)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is not a canonical opaque handle.")))
}

fn take_sha256(params: &mut Map<String, Value>, key: &'static str) -> Result<String, RpcFailure> {
    let value = take_string(params, key, 64, false)?;
    if !valid_sha256(&value) {
        return Err(RpcFailure::invalid(format!(
            "{key} must be a lowercase SHA-256 digest."
        )));
    }
    Ok(value)
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
        let (_root, mut runtime) = runtime();
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
}
