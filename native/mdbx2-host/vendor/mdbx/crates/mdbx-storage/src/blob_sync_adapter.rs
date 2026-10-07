use std::collections::BTreeMap;

use mdbx_sync::{
    BlobChunkRequest, BlobChunkResponse, BlobManifestEntry, BlobManifestEntryState,
    BlobManifestPageRequest, BlobManifestPageResponse, MAX_BLOB_TOTAL_SIZE,
};
use sha2::{Digest, Sha256};

use crate::blob_lifecycle::{
    collect_external_blob_references, collect_provider_inventory, BlobLifecycleLimits,
    ExternalBlobReferenceInventory,
};
use crate::blob_store::{
    validate_blob_id, EncryptedBlobMetadata, EncryptedBlobTransferStore,
    ManageableEncryptedBlobStore, RecoverableEncryptedBlobTransferStore,
};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

/// A source Provider capable of serving both its bounded inventory and
/// ciphertext ranges. The trait stays transport-neutral and is implementable
/// by filesystem, memory, or application-owned Providers.
pub trait BlobSyncSourceStore: ManageableEncryptedBlobStore + EncryptedBlobTransferStore {}

impl<T> BlobSyncSourceStore for T where T: ManageableEncryptedBlobStore + EncryptedBlobTransferStore {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobSyncSourceLimits {
    pub lifecycle: BlobLifecycleLimits,
    pub max_blob_bytes: u64,
}

impl Default for BlobSyncSourceLimits {
    fn default() -> Self {
        Self {
            lifecycle: BlobLifecycleLimits::default(),
            max_blob_bytes: MAX_BLOB_TOTAL_SIZE,
        }
    }
}

impl BlobSyncSourceLimits {
    fn validate(self) -> StorageResult<()> {
        self.lifecycle.validate()?;
        if !(1..=MAX_BLOB_TOTAL_SIZE).contains(&self.max_blob_bytes) {
            return Err(StorageError::Validation(format!(
                "Blob sync source size limit must be between 1 and {MAX_BLOB_TOTAL_SIZE}"
            )));
        }
        Ok(())
    }
}

pub struct BlobSyncSourceAdapter;

impl BlobSyncSourceAdapter {
    /// Publish a stable page of referenced source Blobs. The checkpoint binds
    /// the vault references and Provider inventory, so a later page cannot
    /// silently mix two source states.
    pub fn manifest_page<S>(
        conn: &VaultConnection,
        source: &S,
        request: BlobManifestPageRequest,
        limits: BlobSyncSourceLimits,
    ) -> StorageResult<BlobManifestPageResponse>
    where
        S: BlobSyncSourceStore + ?Sized,
    {
        limits.validate()?;
        request
            .validate()
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        if conn.keyring().is_none() {
            return Err(StorageError::Validation(
                "Blob sync manifest requires an unlocked encrypted vault".to_string(),
            ));
        }
        let namespace_id = EncryptedBlobTransferStore::namespace_id(source)?;
        validate_namespace(&namespace_id)?;
        if namespace_id != request.namespace_id {
            return Err(StorageError::ConstraintViolation(
                "Blob sync request namespace does not match the source Provider".to_string(),
            ));
        }

        let references = collect_external_blob_references(conn, limits.lifecycle)?;
        let provider = collect_provider_inventory(source, limits.lifecycle)?;
        let checkpoint = source_checkpoint(conn, &namespace_id, &references, &provider)?;
        if request
            .checkpoint
            .as_deref()
            .is_some_and(|value| value != checkpoint)
        {
            return Err(StorageError::ConstraintViolation(
                "Blob sync source manifest changed; create a new checkpoint".to_string(),
            ));
        }
        if request.cursor.is_some() && request.checkpoint.is_none() {
            return Err(StorageError::Validation(
                "Blob sync manifest cursor requires a checkpoint".to_string(),
            ));
        }

        let cursor = request.cursor.as_deref();
        if let Some(cursor) = cursor {
            validate_blob_id(cursor).map_err(|_| {
                StorageError::Validation("Blob sync manifest cursor must be a Blob ID".to_string())
            })?;
        }

        let page_size = usize::from(request.page_size);
        let mut items = Vec::with_capacity(page_size.saturating_add(1));
        for (blob_id, declared_max_bytes) in &references.blobs {
            if cursor.is_some_and(|cursor| blob_id.as_str() <= cursor) {
                continue;
            }
            items.push(manifest_entry(
                blob_id,
                *declared_max_bytes as u64,
                provider.get(blob_id),
                limits.max_blob_bytes,
            ));
            if items.len() > page_size {
                break;
            }
        }
        let next_cursor = if items.len() > page_size {
            items.truncate(page_size);
            items.last().map(|item| item.blob_id.clone())
        } else {
            None
        };
        BlobManifestPageResponse::new(namespace_id, checkpoint, items, next_cursor)
            .map_err(|error| StorageError::Validation(error.to_string()))
    }

    /// Serve one ciphertext range after rechecking the source inventory size.
    /// This prevents a source Provider mutation between manifest and chunk
    /// requests from being mistaken for a valid range.
    pub fn chunk<S>(
        source: &S,
        request: BlobChunkRequest,
        limits: BlobSyncSourceLimits,
    ) -> StorageResult<BlobChunkResponse>
    where
        S: BlobSyncSourceStore + ?Sized,
    {
        limits.validate()?;
        request
            .validate()
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        let namespace_id = EncryptedBlobTransferStore::namespace_id(source)?;
        validate_namespace(&namespace_id)?;
        if namespace_id != request.namespace_id {
            return Err(StorageError::ConstraintViolation(
                "Blob chunk request namespace does not match the source Provider".to_string(),
            ));
        }
        let inventory = collect_provider_inventory(source, limits.lifecycle)?;
        let metadata = inventory.get(&request.blob_id).ok_or_else(|| {
            StorageError::NotFound(format!("source Blob {} is missing", request.blob_id))
        })?;
        if metadata.stored_size != request.total_size
            || metadata.stored_size > limits.max_blob_bytes
        {
            return Err(StorageError::ConstraintViolation(
                "source Blob size no longer matches the manifest".to_string(),
            ));
        }
        let max_bytes = usize::try_from(request.max_bytes).map_err(|_| {
            StorageError::Validation("Blob chunk size cannot be represented locally".to_string())
        })?;
        let ciphertext = EncryptedBlobTransferStore::read_chunk(
            source,
            &request.blob_id,
            request.offset,
            max_bytes,
        )?;
        if ciphertext.is_empty() {
            return Err(StorageError::ConstraintViolation(
                "source Provider returned an empty Blob chunk before completion".to_string(),
            ));
        }
        let end = request
            .offset
            .checked_add(ciphertext.len() as u64)
            .ok_or_else(|| StorageError::Validation("Blob chunk offset overflow".to_string()))?;
        if end > request.total_size {
            return Err(StorageError::ConstraintViolation(
                "source Provider returned bytes beyond the manifest size".to_string(),
            ));
        }
        BlobChunkResponse::new(
            namespace_id,
            request.blob_id,
            request.total_size,
            request.offset,
            ciphertext,
            end == request.total_size,
        )
        .map_err(|error| StorageError::Validation(error.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobSyncDestinationState {
    AlreadyPresent,
    TransferRequired,
    SourceMissing,
    SourceSizeInvalid,
    DestinationConflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobSyncDestinationItem {
    pub blob_id: String,
    pub total_size: Option<u64>,
    pub destination_size: Option<u64>,
    pub state: BlobSyncDestinationState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobSyncManifestInspection {
    pub source_namespace_id: String,
    pub destination_namespace_id: String,
    pub checkpoint: String,
    pub items: Vec<BlobSyncDestinationItem>,
}

impl BlobSyncManifestInspection {
    pub fn is_converged(&self) -> bool {
        self.items
            .iter()
            .all(|item| item.state == BlobSyncDestinationState::AlreadyPresent)
    }

    pub fn transfer_required(&self) -> impl Iterator<Item = &BlobSyncDestinationItem> {
        self.items
            .iter()
            .filter(|item| item.state == BlobSyncDestinationState::TransferRequired)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobSyncDestinationLimits {
    pub lifecycle: BlobLifecycleLimits,
    pub lease_ttl_secs: i64,
}

impl Default for BlobSyncDestinationLimits {
    fn default() -> Self {
        Self {
            lifecycle: BlobLifecycleLimits::default(),
            lease_ttl_secs: 5 * 60,
        }
    }
}

impl BlobSyncDestinationLimits {
    fn validate(self) -> StorageResult<()> {
        self.lifecycle.validate()?;
        if !(1..=crate::blob_store::MAX_BLOB_LEASE_TTL_SECS).contains(&self.lease_ttl_secs) {
            return Err(StorageError::Validation(format!(
                "Blob sync destination lease TTL must be between 1 and {} seconds",
                crate::blob_store::MAX_BLOB_LEASE_TTL_SECS
            )));
        }
        Ok(())
    }
}

pub struct BlobSyncDestinationAdapter;

impl BlobSyncDestinationAdapter {
    pub fn inspect_manifest<S>(
        destination: &S,
        response: &BlobManifestPageResponse,
        limits: BlobSyncDestinationLimits,
    ) -> StorageResult<BlobSyncManifestInspection>
    where
        S: BlobSyncDestinationStore + ?Sized,
    {
        limits.validate()?;
        response
            .validate()
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        let destination_namespace_id = EncryptedBlobTransferStore::namespace_id(destination)?;
        validate_namespace(&destination_namespace_id)?;
        if destination_namespace_id == response.namespace_id {
            return Err(StorageError::ConstraintViolation(
                "Blob sync source and destination namespaces must differ".to_string(),
            ));
        }
        let inventory = collect_provider_inventory(destination, limits.lifecycle)?;
        let items = response
            .items
            .iter()
            .map(|item| inspect_item(item, inventory.get(&item.blob_id)))
            .collect();
        Ok(BlobSyncManifestInspection {
            source_namespace_id: response.namespace_id.clone(),
            destination_namespace_id,
            checkpoint: response.checkpoint.clone(),
            items,
        })
    }

    /// A manifest page is acknowledged only after every available item is
    /// already present with the declared size. Missing/invalid source entries
    /// and destination conflicts remain visible to the caller as blockers.
    pub fn acknowledge_manifest_page<S>(
        destination: &S,
        client: &mut mdbx_sync::SyncClient,
        response: &BlobManifestPageResponse,
        limits: BlobSyncDestinationLimits,
    ) -> StorageResult<BlobSyncManifestInspection>
    where
        S: BlobSyncDestinationStore + ?Sized,
    {
        let inspection = Self::inspect_manifest(destination, response, limits)?;
        if !inspection.is_converged() {
            return Err(StorageError::ConstraintViolation(
                "Blob sync manifest page still has transfer or blocked items".to_string(),
            ));
        }
        client
            .acknowledge_blob_manifest_page(response)
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        Ok(inspection)
    }

    /// Durably write one validated chunk before advancing the SyncClient
    /// offset. Failed final verification abandons the staged bytes and resets
    /// the client so a retry cannot remain poisoned by bad ciphertext.
    pub fn apply_chunk<S>(
        destination: &S,
        client: &mut mdbx_sync::SyncClient,
        response: &BlobChunkResponse,
        owner_id: &str,
        limits: BlobSyncDestinationLimits,
    ) -> StorageResult<()>
    where
        S: RecoverableEncryptedBlobTransferStore + ManageableEncryptedBlobStore + ?Sized,
    {
        limits.validate()?;
        validate_owner_id(owner_id)?;
        client
            .validate_blob_chunk_response(response)
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        let destination_namespace_id = EncryptedBlobTransferStore::namespace_id(destination)?;
        validate_namespace(&destination_namespace_id)?;
        if destination_namespace_id == response.namespace_id {
            return Err(StorageError::ConstraintViolation(
                "Blob chunk source and destination namespaces must differ".to_string(),
            ));
        }
        let now = now_unix_secs()?;
        EncryptedBlobTransferStore::acquire_lease(
            destination,
            &response.blob_id,
            owner_id,
            now,
            limits.lease_ttl_secs,
        )?;
        let write_result = EncryptedBlobTransferStore::write_chunk(
            destination,
            &response.blob_id,
            response.total_size,
            response.offset,
            &response.ciphertext,
            response.is_last,
        );
        if let Err(error) = write_result {
            let reset_result = RecoverableEncryptedBlobTransferStore::abort_transfer(
                destination,
                &response.blob_id,
                owner_id,
            );
            let _ =
                EncryptedBlobTransferStore::release_lease(destination, &response.blob_id, owner_id);
            if reset_result.is_ok() {
                client
                    .restart_blob_transfer_after_abort(&response.blob_id, response.total_size)
                    .map_err(|reset_error| StorageError::Validation(reset_error.to_string()))?;
            }
            return Err(error);
        }
        let acknowledge_result = client.acknowledge_blob_chunk(response).map_err(|error| {
            StorageError::Validation(format!(
                "Blob chunk was durable but client acknowledgement failed: {error}"
            ))
        });
        let release_result =
            EncryptedBlobTransferStore::release_lease(destination, &response.blob_id, owner_id);
        acknowledge_result?;
        release_result
    }
}

pub trait BlobSyncDestinationStore:
    RecoverableEncryptedBlobTransferStore + ManageableEncryptedBlobStore
{
}

impl<T> BlobSyncDestinationStore for T where
    T: RecoverableEncryptedBlobTransferStore + ManageableEncryptedBlobStore
{
}

fn inspect_item(
    item: &BlobManifestEntry,
    destination: Option<&EncryptedBlobMetadata>,
) -> BlobSyncDestinationItem {
    let destination_size = destination.map(|metadata| metadata.stored_size);
    let state = match item.state {
        BlobManifestEntryState::SourceMissing => BlobSyncDestinationState::SourceMissing,
        BlobManifestEntryState::SourceSizeInvalid => BlobSyncDestinationState::SourceSizeInvalid,
        BlobManifestEntryState::Available => match (item.total_size, destination) {
            (Some(_total_size), None) => BlobSyncDestinationState::TransferRequired,
            (Some(total_size), Some(metadata)) if metadata.stored_size == total_size => {
                BlobSyncDestinationState::AlreadyPresent
            }
            (Some(_), Some(_)) => BlobSyncDestinationState::DestinationConflict,
            (None, _) => BlobSyncDestinationState::SourceSizeInvalid,
        },
    };
    BlobSyncDestinationItem {
        blob_id: item.blob_id.clone(),
        total_size: item.total_size,
        destination_size,
        state,
    }
}

fn validate_owner_id(owner_id: &str) -> StorageResult<()> {
    if owner_id.is_empty() || owner_id.len() > 512 || owner_id.contains('\n') {
        return Err(StorageError::Validation(
            "Blob sync owner ID must contain 1 to 512 bytes without newlines".to_string(),
        ));
    }
    Ok(())
}

fn now_unix_secs() -> StorageResult<i64> {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::Validation("system clock is before Unix epoch".to_string()))?
        .as_secs()
        .try_into()
        .map_err(|_| StorageError::Validation("system clock exceeds SQLite range".to_string()))
}

/// Transport-neutral request/response boundary. A network client can
/// implement this trait without exposing Provider internals to mdbx-sync.
pub trait BlobSyncRemote {
    fn manifest_page(
        &mut self,
        request: BlobManifestPageRequest,
    ) -> StorageResult<BlobManifestPageResponse>;

    fn blob_chunk(&mut self, request: BlobChunkRequest) -> StorageResult<BlobChunkResponse>;
}

pub struct LocalBlobSyncRemote<'a, S: BlobSyncSourceStore + ?Sized> {
    conn: &'a VaultConnection,
    source: &'a S,
    limits: BlobSyncSourceLimits,
}

impl<'a, S: BlobSyncSourceStore + ?Sized> LocalBlobSyncRemote<'a, S> {
    pub fn new(conn: &'a VaultConnection, source: &'a S, limits: BlobSyncSourceLimits) -> Self {
        Self {
            conn,
            source,
            limits,
        }
    }
}

impl<S: BlobSyncSourceStore + ?Sized> BlobSyncRemote for LocalBlobSyncRemote<'_, S> {
    fn manifest_page(
        &mut self,
        request: BlobManifestPageRequest,
    ) -> StorageResult<BlobManifestPageResponse> {
        BlobSyncSourceAdapter::manifest_page(self.conn, self.source, request, self.limits)
    }

    fn blob_chunk(&mut self, request: BlobChunkRequest) -> StorageResult<BlobChunkResponse> {
        BlobSyncSourceAdapter::chunk(self.source, request, self.limits)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobSyncRunLimits {
    pub page_size: usize,
    pub max_items_per_run: usize,
    pub max_chunks_per_run: usize,
    pub chunk_size: usize,
    pub destination: BlobSyncDestinationLimits,
}

impl Default for BlobSyncRunLimits {
    fn default() -> Self {
        Self {
            page_size: 64,
            max_items_per_run: 64,
            max_chunks_per_run: 256,
            chunk_size: 1024 * 1024,
            destination: BlobSyncDestinationLimits::default(),
        }
    }
}

impl BlobSyncRunLimits {
    fn validate(self) -> StorageResult<()> {
        if !(1..=mdbx_sync::MAX_BLOB_MANIFEST_PAGE_ITEMS).contains(&self.page_size) {
            return Err(StorageError::Validation(format!(
                "Blob sync run page size must be between 1 and {}",
                mdbx_sync::MAX_BLOB_MANIFEST_PAGE_ITEMS
            )));
        }
        if self.max_items_per_run == 0 || self.max_chunks_per_run == 0 {
            return Err(StorageError::Validation(
                "Blob sync run item and chunk limits must be positive".to_string(),
            ));
        }
        if !(1..=mdbx_sync::MAX_BLOB_CHUNK_BYTES).contains(&self.chunk_size) {
            return Err(StorageError::Validation(format!(
                "Blob sync run chunk size must be between 1 and {}",
                mdbx_sync::MAX_BLOB_CHUNK_BYTES
            )));
        }
        self.destination.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobSyncRunResult {
    pub completed: bool,
    pub transferred_items: usize,
    pub chunks_applied: usize,
    pub blocked_items: Vec<BlobSyncDestinationItem>,
}

pub struct BlobSyncDriver;

impl BlobSyncDriver {
    /// Execute one bounded run. The caller may persist the client's
    /// BlobSyncResume after every return and invoke this method again after
    /// interruption or process restart.
    pub fn run<S, R>(
        client: &mut mdbx_sync::SyncClient,
        remote: &mut R,
        destination: &S,
        owner_id: &str,
        limits: BlobSyncRunLimits,
    ) -> StorageResult<BlobSyncRunResult>
    where
        S: BlobSyncDestinationStore + ?Sized,
        R: BlobSyncRemote,
    {
        limits.validate()?;
        if !client.blob_replication_is_negotiated() {
            return Err(StorageError::ConstraintViolation(
                "Blob sync driver requires the complete negotiated Blob contract".to_string(),
            ));
        }
        validate_owner_id(owner_id)?;
        let mut result = BlobSyncRunResult {
            completed: false,
            transferred_items: 0,
            chunks_applied: 0,
            blocked_items: Vec::new(),
        };

        while result.chunks_applied < limits.max_chunks_per_run {
            if let Some(resume) = client.blob_resume().cloned() {
                if let Some(blob_id) = resume.current_blob_id {
                    let request = client
                        .blob_chunk_request(blob_id, resume.total_size, limits.chunk_size)
                        .map_err(|error| StorageError::Validation(error.to_string()))?;
                    let response = remote.blob_chunk(request)?;
                    BlobSyncDestinationAdapter::apply_chunk(
                        destination,
                        client,
                        &response,
                        owner_id,
                        limits.destination,
                    )?;
                    result.chunks_applied += 1;
                    if client
                        .blob_resume()
                        .and_then(|resume| resume.current_blob_id.as_ref())
                        .is_none()
                    {
                        result.transferred_items += 1;
                    }
                    continue;
                }
                if resume.manifest_complete {
                    result.completed = true;
                    return Ok(result);
                }
            } else {
                return Err(StorageError::ConstraintViolation(
                    "Blob sync driver has no configured durable resume state".to_string(),
                ));
            }

            let request = client
                .blob_manifest_request(limits.page_size)
                .map_err(|error| StorageError::Validation(error.to_string()))?;
            let response = remote.manifest_page(request)?;
            client
                .validate_blob_manifest_response(&response)
                .map_err(|error| StorageError::Validation(error.to_string()))?;
            let inspection = BlobSyncDestinationAdapter::inspect_manifest(
                destination,
                &response,
                limits.destination,
            )?;
            if !inspection.items.iter().all(|item| {
                matches!(
                    item.state,
                    BlobSyncDestinationState::AlreadyPresent
                        | BlobSyncDestinationState::TransferRequired
                )
            }) {
                result.blocked_items = inspection
                    .items
                    .iter()
                    .filter(|item| {
                        !matches!(
                            item.state,
                            BlobSyncDestinationState::AlreadyPresent
                                | BlobSyncDestinationState::TransferRequired
                        )
                    })
                    .cloned()
                    .collect();
                return Ok(result);
            }

            if result.transferred_items >= limits.max_items_per_run {
                return Ok(result);
            }

            for item in inspection.transfer_required() {
                if result.transferred_items >= limits.max_items_per_run {
                    return Ok(result);
                }
                let total_size = item.total_size.ok_or_else(|| {
                    StorageError::ConstraintViolation(
                        "transfer-required Blob has no declared total size".to_string(),
                    )
                })?;
                loop {
                    if result.chunks_applied >= limits.max_chunks_per_run {
                        return Ok(result);
                    }
                    let request = client
                        .blob_chunk_request(item.blob_id.clone(), total_size, limits.chunk_size)
                        .map_err(|error| StorageError::Validation(error.to_string()))?;
                    let response = remote.blob_chunk(request)?;
                    BlobSyncDestinationAdapter::apply_chunk(
                        destination,
                        client,
                        &response,
                        owner_id,
                        limits.destination,
                    )?;
                    result.chunks_applied += 1;
                    let still_active = client
                        .blob_resume()
                        .and_then(|resume| resume.current_blob_id.as_deref())
                        .is_some_and(|active| active == item.blob_id);
                    if !still_active {
                        break;
                    }
                }
                result.transferred_items += 1;
            }

            BlobSyncDestinationAdapter::acknowledge_manifest_page(
                destination,
                client,
                &response,
                limits.destination,
            )?;
            if client.blob_sync_phase() == mdbx_sync::BlobSyncPhase::Complete {
                result.completed = true;
                return Ok(result);
            }
            if result.chunks_applied >= limits.max_chunks_per_run {
                return Ok(result);
            }
        }
        Ok(result)
    }
}

fn manifest_entry(
    blob_id: &str,
    declared_max_bytes: u64,
    metadata: Option<&EncryptedBlobMetadata>,
    max_blob_bytes: u64,
) -> BlobManifestEntry {
    match metadata {
        None => BlobManifestEntry {
            blob_id: blob_id.to_string(),
            total_size: None,
            state: BlobManifestEntryState::SourceMissing,
        },
        Some(metadata)
            if metadata.stored_size == 0
                || metadata.stored_size > declared_max_bytes
                || metadata.stored_size > max_blob_bytes
                || metadata.stored_size > MAX_BLOB_TOTAL_SIZE =>
        {
            BlobManifestEntry {
                blob_id: blob_id.to_string(),
                total_size: (metadata.stored_size <= MAX_BLOB_TOTAL_SIZE)
                    .then_some(metadata.stored_size),
                state: BlobManifestEntryState::SourceSizeInvalid,
            }
        }
        Some(metadata) => BlobManifestEntry {
            blob_id: blob_id.to_string(),
            total_size: Some(metadata.stored_size),
            state: BlobManifestEntryState::Available,
        },
    }
}

fn source_checkpoint(
    conn: &VaultConnection,
    namespace_id: &str,
    references: &ExternalBlobReferenceInventory,
    provider: &BTreeMap<String, EncryptedBlobMetadata>,
) -> StorageResult<String> {
    let vault_id =
        conn.inner()
            .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })?;
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, b"mdbx-blob-sync-source-manifest-v1");
    hash_part(&mut hasher, vault_id.as_bytes());
    hash_part(&mut hasher, namespace_id.as_bytes());
    hash_part(
        &mut hasher,
        &(references.raw_reference_count as u64).to_le_bytes(),
    );
    for (blob_id, declared_size) in &references.blobs {
        hash_part(&mut hasher, blob_id.as_bytes());
        hash_part(&mut hasher, &(*declared_size as u64).to_le_bytes());
    }
    for metadata in provider.values() {
        hash_part(&mut hasher, metadata.blob_id.as_bytes());
        hash_part(&mut hasher, &metadata.stored_size.to_le_bytes());
        hash_part(&mut hasher, &metadata.modified_at_unix_secs.to_le_bytes());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn hash_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn validate_namespace(namespace_id: &str) -> StorageResult<()> {
    if namespace_id.is_empty() || namespace_id.len() > 4096 {
        return Err(StorageError::Validation(
            "Blob sync Provider namespace must contain 1 to 4096 bytes".to_string(),
        ));
    }
    Ok(())
}

#[cfg(all(test, feature = "filesystem-blob-store"))]
mod tests {
    use super::*;
    use std::io::Cursor;

    use mdbx_crypto::keyring::Keyring;
    use mdbx_sync::{
        BlobChunkResponse, BlobManifestEntry, BlobManifestEntryState, BlobManifestPageResponse,
        BlobSyncPhase, SyncClient, SyncNegotiator, MAX_BLOB_ID_BYTES,
    };

    use crate::blob_store::{compute_blob_id, EncryptedBlobStore, FileSystemBlobStore};
    use crate::connection::VaultConnection;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{AttachmentRepo, AttachmentWriteOptions, CommitContext, ProjectRepo};

    fn setup() -> (VaultConnection, CommitContext, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "blob-sync-source-test".to_string(),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        conn.attach_keyring(
            Keyring::from_vault_key(&[71_u8; 32], b"blob-sync-source-tests").unwrap(),
        );
        let context = CommitContext::new("blob-sync-source-test".to_string());
        let project = ProjectRepo::create(&conn, &context, "Sync", None, None).unwrap();
        (conn, context, project.project_id)
    }

    fn add_external(
        conn: &VaultConnection,
        context: &CommitContext,
        project_id: &str,
        store: &FileSystemBlobStore,
    ) -> Vec<u8> {
        let attachment =
            AttachmentRepo::add(conn, context, project_id, None, "sync.bin", None, "", 12).unwrap();
        let bytes = b"source bytes".to_vec();
        AttachmentRepo::write_external_content_from_reader_with_options(
            conn,
            context,
            &attachment.attachment_id,
            &mut Cursor::new(bytes.clone()),
            AttachmentWriteOptions::exact(4, bytes.len() as u64),
            store,
        )
        .unwrap();
        bytes
    }

    fn negotiated_client(namespace_id: &str) -> SyncClient {
        let mut local = SyncNegotiator::new("destination", Vec::new(), Vec::new());
        local.enable_blob_replication_capabilities().unwrap();
        let mut client = SyncClient::new(local, None, None);
        client.begin_blob_sync(namespace_id.to_string()).unwrap();
        let hello = client.hello().unwrap();
        let mut peer = SyncNegotiator::new("source", Vec::new(), Vec::new());
        peer.enable_blob_replication_capabilities().unwrap();
        let ack = peer.on_hello(&hello).unwrap();
        client.on_hello_ack(&ack).unwrap();
        client
    }

    fn response_for(
        blob_id: &str,
        total_size: u64,
        offset: u64,
        ciphertext: Vec<u8>,
    ) -> BlobChunkResponse {
        let is_last = offset + ciphertext.len() as u64 == total_size;
        BlobChunkResponse::new(
            "source-namespace".to_string(),
            blob_id.to_string(),
            total_size,
            offset,
            ciphertext,
            is_last,
        )
        .unwrap()
    }

    #[test]
    fn source_manifest_pages_are_stable_and_source_chunks_are_bounded() {
        let (conn, context, project_id) = setup();
        let dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(dir.path().join("source.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let provider = collect_provider_inventory(&source, BlobLifecycleLimits::default()).unwrap();
        assert_eq!(provider.len(), 3);
        let namespace = EncryptedBlobTransferStore::namespace_id(&source).unwrap();
        let first_request = BlobManifestPageRequest::new(namespace.clone(), None, None, 1).unwrap();
        let first = BlobSyncSourceAdapter::manifest_page(
            &conn,
            &source,
            first_request,
            BlobSyncSourceLimits::default(),
        )
        .unwrap();
        assert_eq!(first.items.len(), 1);
        assert!(first.next_cursor.is_some());
        assert_eq!(first.items[0].blob_id.len(), MAX_BLOB_ID_BYTES);
        assert_eq!(first.items[0].state, BlobManifestEntryState::Available);
        let second_request = BlobManifestPageRequest::new(
            namespace.clone(),
            Some(first.checkpoint.clone()),
            first.next_cursor.clone(),
            1,
        )
        .unwrap();
        let second = BlobSyncSourceAdapter::manifest_page(
            &conn,
            &source,
            second_request,
            BlobSyncSourceLimits::default(),
        )
        .unwrap();
        assert_eq!(second.items.len(), 1);
        assert_ne!(first.items[0].blob_id, second.items[0].blob_id);

        let item = &first.items[0];
        let total_size = item.total_size.unwrap();
        let expected =
            EncryptedBlobTransferStore::read_chunk(&source, &item.blob_id, 0, 4).unwrap();
        let chunk_request =
            BlobChunkRequest::new(namespace, item.blob_id.clone(), total_size, 0, 4).unwrap();
        let chunk =
            BlobSyncSourceAdapter::chunk(&source, chunk_request, BlobSyncSourceLimits::default())
                .unwrap();
        assert_eq!(chunk.ciphertext, expected);
        assert_eq!(chunk.is_last, total_size <= 4);
    }

    #[test]
    fn source_rejects_stale_manifests_and_changed_sizes() {
        let (conn, context, project_id) = setup();
        let dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(dir.path().join("source.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let namespace = EncryptedBlobTransferStore::namespace_id(&source).unwrap();
        let first = BlobSyncSourceAdapter::manifest_page(
            &conn,
            &source,
            BlobManifestPageRequest::new(namespace.clone(), None, None, 1).unwrap(),
            BlobSyncSourceLimits::default(),
        )
        .unwrap();
        source.put(&"f".repeat(64), b"different").unwrap_err();
        let extra = b"unreferenced";
        source
            .put(&crate::blob_store::compute_blob_id(extra), extra)
            .unwrap();
        let stale =
            BlobManifestPageRequest::new(namespace, Some(first.checkpoint), first.next_cursor, 1)
                .unwrap();
        assert!(BlobSyncSourceAdapter::manifest_page(
            &conn,
            &source,
            stale,
            BlobSyncSourceLimits::default()
        )
        .is_err());
    }

    #[test]
    fn destination_writes_chunks_before_advancing_and_acknowledges_convergence() {
        let directory = tempfile::tempdir().unwrap();
        let destination = FileSystemBlobStore::new(directory.path().join("destination.blobs"));
        let payload = b"destination payload".to_vec();
        let blob_id = compute_blob_id(&payload);
        let manifest = BlobManifestPageResponse::new(
            "source-namespace".to_string(),
            "checkpoint".to_string(),
            vec![BlobManifestEntry {
                blob_id: blob_id.clone(),
                total_size: Some(payload.len() as u64),
                state: BlobManifestEntryState::Available,
            }],
            None,
        )
        .unwrap();
        let mut client = negotiated_client("source-namespace");
        client.blob_manifest_request(8).unwrap();
        client.validate_blob_manifest_response(&manifest).unwrap();
        let inspection = BlobSyncDestinationAdapter::inspect_manifest(
            &destination,
            &manifest,
            BlobSyncDestinationLimits::default(),
        )
        .unwrap();
        assert_eq!(
            inspection.items[0].state,
            BlobSyncDestinationState::TransferRequired
        );

        let first_request = client
            .blob_chunk_request(blob_id.clone(), payload.len() as u64, 5)
            .unwrap();
        let first = response_for(
            &blob_id,
            payload.len() as u64,
            first_request.offset,
            payload[..5].to_vec(),
        );
        BlobSyncDestinationAdapter::apply_chunk(
            &destination,
            &mut client,
            &first,
            "destination-owner",
            BlobSyncDestinationLimits::default(),
        )
        .unwrap();
        assert_eq!(client.blob_resume().unwrap().next_durable_offset, 5);

        let second_request = client
            .blob_chunk_request(blob_id.clone(), payload.len() as u64, 64)
            .unwrap();
        let second = response_for(
            &blob_id,
            payload.len() as u64,
            second_request.offset,
            payload[5..].to_vec(),
        );
        BlobSyncDestinationAdapter::apply_chunk(
            &destination,
            &mut client,
            &second,
            "destination-owner",
            BlobSyncDestinationLimits::default(),
        )
        .unwrap();
        assert_eq!(destination.get(&blob_id, payload.len()).unwrap(), payload);
        let final_inspection = BlobSyncDestinationAdapter::acknowledge_manifest_page(
            &destination,
            &mut client,
            &manifest,
            BlobSyncDestinationLimits::default(),
        )
        .unwrap();
        assert!(final_inspection.is_converged());
        assert_eq!(client.blob_sync_phase(), BlobSyncPhase::Complete);
    }

    #[test]
    fn destination_aborts_bad_final_verification_and_restarts_from_zero() {
        let directory = tempfile::tempdir().unwrap();
        let destination = FileSystemBlobStore::new(directory.path().join("destination.blobs"));
        let payload = b"0123456789".to_vec();
        let blob_id = compute_blob_id(&payload);
        let manifest = BlobManifestPageResponse::new(
            "source-namespace".to_string(),
            "checkpoint".to_string(),
            vec![BlobManifestEntry {
                blob_id: blob_id.clone(),
                total_size: Some(payload.len() as u64),
                state: BlobManifestEntryState::Available,
            }],
            None,
        )
        .unwrap();
        let mut client = negotiated_client("source-namespace");
        client.blob_manifest_request(8).unwrap();
        client.validate_blob_manifest_response(&manifest).unwrap();
        let first_request = client
            .blob_chunk_request(blob_id.clone(), payload.len() as u64, 5)
            .unwrap();
        let bad_first = response_for(
            &blob_id,
            payload.len() as u64,
            first_request.offset,
            b"xxxxx".to_vec(),
        );
        BlobSyncDestinationAdapter::apply_chunk(
            &destination,
            &mut client,
            &bad_first,
            "destination-owner",
            BlobSyncDestinationLimits::default(),
        )
        .unwrap();
        assert_eq!(client.blob_resume().unwrap().next_durable_offset, 5);

        let final_request = client
            .blob_chunk_request(blob_id.clone(), payload.len() as u64, 64)
            .unwrap();
        let bad_final = response_for(
            &blob_id,
            payload.len() as u64,
            final_request.offset,
            payload[5..].to_vec(),
        );
        assert!(BlobSyncDestinationAdapter::apply_chunk(
            &destination,
            &mut client,
            &bad_final,
            "destination-owner",
            BlobSyncDestinationLimits::default()
        )
        .is_err());
        assert_eq!(client.blob_resume().unwrap().next_durable_offset, 0);

        let retry_request = client
            .blob_chunk_request(blob_id.clone(), payload.len() as u64, 64)
            .unwrap();
        let retry = response_for(
            &blob_id,
            payload.len() as u64,
            retry_request.offset,
            payload.clone(),
        );
        BlobSyncDestinationAdapter::apply_chunk(
            &destination,
            &mut client,
            &retry,
            "destination-owner",
            BlobSyncDestinationLimits::default(),
        )
        .unwrap();
        assert_eq!(destination.get(&blob_id, payload.len()).unwrap(), payload);
    }

    #[test]
    fn driver_resumes_from_serialized_state_and_converges_with_bounded_runs() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let namespace = EncryptedBlobTransferStore::namespace_id(&source).unwrap();
        let mut client = negotiated_client(&namespace);
        let mut remote = LocalBlobSyncRemote::new(&conn, &source, BlobSyncSourceLimits::default());
        let limits = BlobSyncRunLimits {
            page_size: 1,
            max_items_per_run: 1,
            max_chunks_per_run: 1,
            chunk_size: 4,
            destination: BlobSyncDestinationLimits::default(),
        };

        let first = BlobSyncDriver::run(
            &mut client,
            &mut remote,
            &destination,
            "driver-owner",
            limits,
        )
        .unwrap();
        assert!(!first.completed);
        assert_eq!(first.chunks_applied, 1);
        let serialized = serde_json::to_vec(client.blob_resume().unwrap()).unwrap();
        let saved: mdbx_sync::BlobSyncResume = serde_json::from_slice(&serialized).unwrap();
        let mut resumed = negotiated_client(&namespace);
        resumed.restore_blob_sync(saved).unwrap();

        let mut completed = false;
        for _ in 0..256 {
            let run = BlobSyncDriver::run(
                &mut resumed,
                &mut remote,
                &destination,
                "driver-owner",
                limits,
            )
            .unwrap();
            if run.completed {
                completed = true;
                break;
            }
        }
        assert!(completed);
        assert_eq!(resumed.blob_sync_phase(), BlobSyncPhase::Complete);
        let source_inventory =
            collect_provider_inventory(&source, BlobLifecycleLimits::default()).unwrap();
        let destination_inventory =
            collect_provider_inventory(&destination, BlobLifecycleLimits::default()).unwrap();
        assert_eq!(
            source_inventory.keys().collect::<Vec<_>>(),
            destination_inventory.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn driver_reports_source_blockers_without_advancing_manifest() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let page = ManageableEncryptedBlobStore::list(&source, None, 1).unwrap();
        ManageableEncryptedBlobStore::delete(&source, &page.blobs[0].blob_id).unwrap();
        let namespace = EncryptedBlobTransferStore::namespace_id(&source).unwrap();
        let mut client = negotiated_client(&namespace);
        let mut remote = LocalBlobSyncRemote::new(&conn, &source, BlobSyncSourceLimits::default());
        let run = BlobSyncDriver::run(
            &mut client,
            &mut remote,
            &destination,
            "driver-owner",
            BlobSyncRunLimits::default(),
        )
        .unwrap();
        assert!(!run.completed);
        assert_eq!(run.blocked_items.len(), 1);
        assert_eq!(
            run.blocked_items[0].state,
            BlobSyncDestinationState::SourceMissing
        );
        assert!(client.blob_resume().unwrap().manifest_checkpoint.is_none());
    }
}
