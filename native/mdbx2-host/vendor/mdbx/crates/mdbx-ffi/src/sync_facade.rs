use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use mdbx_storage::backup::BackupService;
use mdbx_storage::blob_lifecycle::{collect_external_blob_references, BlobLifecycleLimits};
use mdbx_storage::blob_store::{
    validate_blob_id, EncryptedBlobTransferStore, RecoverableEncryptedBlobTransferStore,
    MAX_BLOB_PAGE_SIZE, MAX_BLOB_TRANSFER_CHUNK_SIZE,
};
use mdbx_storage::error::StorageError;
use mdbx_storage::peer_sync::{PeerSyncSegmentOptions, PeerSyncService};
use mdbx_storage::repo::{CommitContext, CommitOperation, OperationExecution};
use mdbx_storage::sync_apply::SyncApplyRepo;
use mdbx_sync::{
    incremental_bundle_payload_sha256, read_bundle_file_with_limits_authenticated,
    write_bundle_authenticated, write_incremental_bundle_authenticated, BlobChunkRequest,
    BlobChunkResponse, BlobManifestEntry, BlobManifestEntryState, BlobManifestPageRequest,
    BlobManifestPageResponse, BlobSyncPhase, BlobSyncResume, BranchHead, BundleReadLimits,
    CommitBatch, HelloRequest, HelloResponse, IncrementalBundleCheckpoint, IncrementalBundleResume,
    IncrementalSyncBundle, SyncBundle, SyncBundleFile, SyncClient, SyncMessage, SyncNegotiator,
    SyncWireFrame, SyncWireLimits, SyncWireResume, SyncWireSession,
};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::attachment_facade::vault_blob_store;

use super::{MdbxAuthenticatedStateRootCheckpoint, MdbxBackupInfo, MdbxFfiError, MdbxVault};

pub(crate) const MAX_METADATA_BENCHMARK_OPERATIONS: u32 = 500;
const FILE_HASH_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxIncrementalSyncCheckpoint {
    pub commit_inventory: String,
    pub delta_inventory: String,
}

impl From<IncrementalBundleCheckpoint> for MdbxIncrementalSyncCheckpoint {
    fn from(value: IncrementalBundleCheckpoint) -> Self {
        Self {
            commit_inventory: value.commit_inventory.unwrap_or_default(),
            delta_inventory: value.delta_inventory.unwrap_or_default(),
        }
    }
}

impl MdbxIncrementalSyncCheckpoint {
    fn into_core(self) -> Result<IncrementalBundleCheckpoint, MdbxFfiError> {
        let commit_empty = self.commit_inventory.is_empty();
        let delta_empty = self.delta_inventory.is_empty();
        if commit_empty != delta_empty {
            return Err(MdbxFfiError::SyncProtocol {
                message: "incremental checkpoint tokens must be paired".to_string(),
            });
        }
        Ok(IncrementalBundleCheckpoint {
            commit_inventory: (!commit_empty).then_some(self.commit_inventory),
            delta_inventory: (!delta_empty).then_some(self.delta_inventory),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxIncrementalSyncResume {
    pub transfer_id: String,
    pub next_segment_index: u32,
    pub previous_segment_sha256: Vec<u8>,
}

impl From<IncrementalBundleResume> for MdbxIncrementalSyncResume {
    fn from(value: IncrementalBundleResume) -> Self {
        Self {
            transfer_id: value.transfer_id,
            next_segment_index: value.next_segment_index,
            previous_segment_sha256: value.previous_segment_sha256,
        }
    }
}

impl MdbxIncrementalSyncResume {
    fn into_core(self) -> Result<IncrementalBundleResume, MdbxFfiError> {
        if self.transfer_id.is_empty()
            || self.next_segment_index == 0
            || self.previous_segment_sha256.len() != 32
        {
            return Err(MdbxFfiError::SyncProtocol {
                message: "invalid incremental transfer resume state".to_string(),
            });
        }
        Ok(IncrementalBundleResume {
            transfer_id: self.transfer_id,
            next_segment_index: self.next_segment_index,
            previous_segment_sha256: self.previous_segment_sha256,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxIncrementalSyncBootstrapInfo {
    pub backup: MdbxBackupInfo,
    pub checkpoint: MdbxIncrementalSyncCheckpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxIncrementalSyncSegmentInfo {
    pub vault_id: String,
    pub source_device_id: String,
    pub transfer_id: String,
    pub segment_index: u32,
    pub is_last: bool,
    pub base: MdbxIncrementalSyncCheckpoint,
    pub result: MdbxIncrementalSyncCheckpoint,
    pub next_resume: Option<MdbxIncrementalSyncResume>,
    pub commit_count: u32,
    pub delta_count: u32,
    pub payload_sha256: Vec<u8>,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxIncrementalSyncApplyResult {
    pub result: MdbxIncrementalSyncCheckpoint,
    pub next_resume: Option<MdbxIncrementalSyncResume>,
    pub applied_commits: u32,
    pub skipped_commits: u32,
    pub conflict_count: u32,
    pub missing_parent_count: u32,
}

/// Metadata for one authenticated complete bundle intended for explicit,
/// user-mediated transfer. The binary payload remains in the caller-owned
/// file so UniFFI never needs to allocate an unbounded byte vector.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxManualSyncBundleInfo {
    pub vault_id: String,
    pub source_device_id: String,
    pub head_commit_id: String,
    pub commit_count: u32,
    pub exported_at: String,
    pub payload_sha256: Vec<u8>,
    pub file_size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxManualSyncApplyResult {
    pub bundle: MdbxManualSyncBundleInfo,
    pub applied_commits: u32,
    pub skipped_commits: u32,
    pub conflict_count: u32,
    pub missing_parent_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxMetadataBenchmarkResult {
    pub operation_count: u32,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxExternalBlobState {
    Available,
    Missing,
    SizeMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxExternalBlobReference {
    pub blob_id: String,
    pub total_size: Option<u64>,
    pub state: MdbxExternalBlobState,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxExternalBlobReferencePage {
    pub raw_reference_count: u64,
    pub unique_reference_count: u64,
    pub items: Vec<MdbxExternalBlobReference>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxExternalBlobChunk {
    pub blob_id: String,
    pub total_size: u64,
    pub offset: u64,
    pub ciphertext: Vec<u8>,
    pub is_last: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxExternalBlobLease {
    pub blob_id: String,
    pub owner_id: String,
    pub expires_at_unix_secs: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncBranchHead {
    pub branch_id: Option<String>,
    pub branch_name: String,
    pub head_commit_id: String,
}

impl From<BranchHead> for MdbxSyncBranchHead {
    fn from(value: BranchHead) -> Self {
        Self {
            branch_id: value.branch_id,
            branch_name: value.branch_name,
            head_commit_id: value.head_commit_id,
        }
    }
}

impl From<MdbxSyncBranchHead> for BranchHead {
    fn from(value: MdbxSyncBranchHead) -> Self {
        Self {
            branch_id: value.branch_id,
            branch_name: value.branch_name,
            head_commit_id: value.head_commit_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncHello {
    pub device_id: String,
    pub protocol_version: u32,
    pub heads: Vec<MdbxSyncBranchHead>,
    pub known_commit_ids: Vec<String>,
    pub capabilities: Vec<String>,
}

impl From<HelloRequest> for MdbxSyncHello {
    fn from(value: HelloRequest) -> Self {
        Self {
            device_id: value.device_id,
            protocol_version: value.protocol_version,
            heads: value.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: value.known_commit_ids,
            capabilities: value.capabilities,
        }
    }
}

impl From<HelloResponse> for MdbxSyncHello {
    fn from(value: HelloResponse) -> Self {
        Self {
            device_id: value.device_id,
            protocol_version: value.protocol_version,
            heads: value.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: value.known_commit_ids,
            capabilities: value.capabilities,
        }
    }
}

impl MdbxSyncHello {
    fn into_request(self) -> HelloRequest {
        HelloRequest {
            device_id: self.device_id,
            protocol_version: self.protocol_version,
            heads: self.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: self.known_commit_ids,
            capabilities: self.capabilities,
            authenticated_state_root: None,
        }
    }

    fn into_response(self) -> HelloResponse {
        HelloResponse {
            device_id: self.device_id,
            protocol_version: self.protocol_version,
            heads: self.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: self.known_commit_ids,
            capabilities: self.capabilities,
            authenticated_state_root: None,
        }
    }
}

/// Additive Hello shape for authenticated root exchange. Existing
/// `MdbxSyncHello` callers keep their original constructor unchanged.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxIntegrityRootSyncHello {
    pub device_id: String,
    pub protocol_version: u32,
    pub heads: Vec<MdbxSyncBranchHead>,
    pub known_commit_ids: Vec<String>,
    pub capabilities: Vec<String>,
    pub authenticated_state_root: Option<MdbxAuthenticatedStateRootCheckpoint>,
}

impl From<HelloRequest> for MdbxIntegrityRootSyncHello {
    fn from(value: HelloRequest) -> Self {
        Self {
            device_id: value.device_id,
            protocol_version: value.protocol_version,
            heads: value.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: value.known_commit_ids,
            capabilities: value.capabilities,
            authenticated_state_root: value.authenticated_state_root.map(Into::into),
        }
    }
}

impl From<HelloResponse> for MdbxIntegrityRootSyncHello {
    fn from(value: HelloResponse) -> Self {
        Self {
            device_id: value.device_id,
            protocol_version: value.protocol_version,
            heads: value.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: value.known_commit_ids,
            capabilities: value.capabilities,
            authenticated_state_root: value.authenticated_state_root.map(Into::into),
        }
    }
}

impl MdbxIntegrityRootSyncHello {
    fn into_request(self) -> Result<HelloRequest, MdbxFfiError> {
        let hello = HelloRequest {
            device_id: self.device_id,
            protocol_version: self.protocol_version,
            heads: self.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: self.known_commit_ids,
            capabilities: self.capabilities,
            authenticated_state_root: self
                .authenticated_state_root
                .map(MdbxAuthenticatedStateRootCheckpoint::into_core)
                .transpose()?,
        };
        hello.validate()?;
        Ok(hello)
    }

    fn into_response(self) -> Result<HelloResponse, MdbxFfiError> {
        let hello = HelloResponse {
            device_id: self.device_id,
            protocol_version: self.protocol_version,
            heads: self.heads.into_iter().map(Into::into).collect(),
            known_commit_ids: self.known_commit_ids,
            capabilities: self.capabilities,
            authenticated_state_root: self
                .authenticated_state_root
                .map(MdbxAuthenticatedStateRootCheckpoint::into_core)
                .transpose()?,
        };
        hello.validate()?;
        Ok(hello)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxBlobManifestEntryState {
    Available,
    SourceMissing,
    SourceSizeInvalid,
}

impl From<BlobManifestEntryState> for MdbxBlobManifestEntryState {
    fn from(value: BlobManifestEntryState) -> Self {
        match value {
            BlobManifestEntryState::Available => Self::Available,
            BlobManifestEntryState::SourceMissing => Self::SourceMissing,
            BlobManifestEntryState::SourceSizeInvalid => Self::SourceSizeInvalid,
        }
    }
}

impl From<MdbxBlobManifestEntryState> for BlobManifestEntryState {
    fn from(value: MdbxBlobManifestEntryState) -> Self {
        match value {
            MdbxBlobManifestEntryState::Available => Self::Available,
            MdbxBlobManifestEntryState::SourceMissing => Self::SourceMissing,
            MdbxBlobManifestEntryState::SourceSizeInvalid => Self::SourceSizeInvalid,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBlobManifestEntry {
    pub blob_id: String,
    pub total_size: Option<u64>,
    pub state: MdbxBlobManifestEntryState,
}

impl From<BlobManifestEntry> for MdbxBlobManifestEntry {
    fn from(value: BlobManifestEntry) -> Self {
        Self {
            blob_id: value.blob_id,
            total_size: value.total_size,
            state: value.state.into(),
        }
    }
}

impl From<MdbxBlobManifestEntry> for BlobManifestEntry {
    fn from(value: MdbxBlobManifestEntry) -> Self {
        Self {
            blob_id: value.blob_id,
            total_size: value.total_size,
            state: value.state.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBlobManifestPageRequest {
    pub namespace_id: String,
    pub checkpoint: Option<String>,
    pub cursor: Option<String>,
    pub page_size: u32,
}

impl From<BlobManifestPageRequest> for MdbxBlobManifestPageRequest {
    fn from(value: BlobManifestPageRequest) -> Self {
        Self {
            namespace_id: value.namespace_id,
            checkpoint: value.checkpoint,
            cursor: value.cursor,
            page_size: u32::from(value.page_size),
        }
    }
}

impl MdbxBlobManifestPageRequest {
    fn into_core(self) -> Result<BlobManifestPageRequest, MdbxFfiError> {
        BlobManifestPageRequest::new(
            self.namespace_id,
            self.checkpoint,
            self.cursor,
            usize::try_from(self.page_size).map_err(|_| MdbxFfiError::SyncProtocol {
                message: "Blob manifest page size cannot be represented locally".to_string(),
            })?,
        )
        .map_err(Into::into)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBlobManifestPageResponse {
    pub namespace_id: String,
    pub checkpoint: String,
    pub items: Vec<MdbxBlobManifestEntry>,
    pub next_cursor: Option<String>,
}

impl From<BlobManifestPageResponse> for MdbxBlobManifestPageResponse {
    fn from(value: BlobManifestPageResponse) -> Self {
        Self {
            namespace_id: value.namespace_id,
            checkpoint: value.checkpoint,
            items: value.items.into_iter().map(Into::into).collect(),
            next_cursor: value.next_cursor,
        }
    }
}

impl From<MdbxBlobManifestPageResponse> for BlobManifestPageResponse {
    fn from(value: MdbxBlobManifestPageResponse) -> Self {
        Self {
            namespace_id: value.namespace_id,
            checkpoint: value.checkpoint,
            items: value.items.into_iter().map(Into::into).collect(),
            next_cursor: value.next_cursor,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBlobChunkRequest {
    pub namespace_id: String,
    pub blob_id: String,
    pub total_size: u64,
    pub offset: u64,
    pub max_bytes: u32,
}

impl From<BlobChunkRequest> for MdbxBlobChunkRequest {
    fn from(value: BlobChunkRequest) -> Self {
        Self {
            namespace_id: value.namespace_id,
            blob_id: value.blob_id,
            total_size: value.total_size,
            offset: value.offset,
            max_bytes: value.max_bytes,
        }
    }
}

impl MdbxBlobChunkRequest {
    fn into_core(self) -> Result<BlobChunkRequest, MdbxFfiError> {
        BlobChunkRequest::new(
            self.namespace_id,
            self.blob_id,
            self.total_size,
            self.offset,
            usize::try_from(self.max_bytes).map_err(|_| MdbxFfiError::SyncProtocol {
                message: "Blob chunk size cannot be represented locally".to_string(),
            })?,
        )
        .map_err(Into::into)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBlobChunkResponse {
    pub namespace_id: String,
    pub blob_id: String,
    pub total_size: u64,
    pub offset: u64,
    pub ciphertext: Vec<u8>,
    pub is_last: bool,
}

impl From<BlobChunkResponse> for MdbxBlobChunkResponse {
    fn from(value: BlobChunkResponse) -> Self {
        Self {
            namespace_id: value.namespace_id,
            blob_id: value.blob_id,
            total_size: value.total_size,
            offset: value.offset,
            ciphertext: value.ciphertext,
            is_last: value.is_last,
        }
    }
}

impl From<MdbxBlobChunkResponse> for BlobChunkResponse {
    fn from(value: MdbxBlobChunkResponse) -> Self {
        Self {
            namespace_id: value.namespace_id,
            blob_id: value.blob_id,
            total_size: value.total_size,
            offset: value.offset,
            ciphertext: value.ciphertext,
            is_last: value.is_last,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBlobSyncResume {
    pub namespace_id: String,
    pub manifest_checkpoint: Option<String>,
    pub manifest_cursor: Option<String>,
    pub current_blob_id: Option<String>,
    pub total_size: u64,
    pub next_durable_offset: u64,
    pub manifest_complete: bool,
}

impl From<BlobSyncResume> for MdbxBlobSyncResume {
    fn from(value: BlobSyncResume) -> Self {
        Self {
            namespace_id: value.namespace_id,
            manifest_checkpoint: value.manifest_checkpoint,
            manifest_cursor: value.manifest_cursor,
            current_blob_id: value.current_blob_id,
            total_size: value.total_size,
            next_durable_offset: value.next_durable_offset,
            manifest_complete: value.manifest_complete,
        }
    }
}

impl From<MdbxBlobSyncResume> for BlobSyncResume {
    fn from(value: MdbxBlobSyncResume) -> Self {
        Self {
            namespace_id: value.namespace_id,
            manifest_checkpoint: value.manifest_checkpoint,
            manifest_cursor: value.manifest_cursor,
            current_blob_id: value.current_blob_id,
            total_size: value.total_size,
            next_durable_offset: value.next_durable_offset,
            manifest_complete: value.manifest_complete,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxBlobSyncPhase {
    Disabled,
    Idle,
    Manifest,
    AwaitingManifestAcknowledgement,
    Chunk,
    AwaitingChunkAcknowledgement,
    Complete,
}

impl From<BlobSyncPhase> for MdbxBlobSyncPhase {
    fn from(value: BlobSyncPhase) -> Self {
        match value {
            BlobSyncPhase::Disabled => Self::Disabled,
            BlobSyncPhase::Idle => Self::Idle,
            BlobSyncPhase::Manifest => Self::Manifest,
            BlobSyncPhase::AwaitingManifestAcknowledgement => Self::AwaitingManifestAcknowledgement,
            BlobSyncPhase::Chunk => Self::Chunk,
            BlobSyncPhase::AwaitingChunkAcknowledgement => Self::AwaitingChunkAcknowledgement,
            BlobSyncPhase::Complete => Self::Complete,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, uniffi::Record)]
pub struct MdbxSyncWireResume {
    pub session_id: String,
    pub next_outbound_sequence: u64,
    pub next_inbound_sequence: u64,
}

impl From<SyncWireResume> for MdbxSyncWireResume {
    fn from(value: SyncWireResume) -> Self {
        Self {
            session_id: value.session_id,
            next_outbound_sequence: value.next_outbound_sequence,
            next_inbound_sequence: value.next_inbound_sequence,
        }
    }
}

impl MdbxSyncWireResume {
    fn into_core(self) -> SyncWireResume {
        SyncWireResume {
            session_id: self.session_id,
            next_outbound_sequence: self.next_outbound_sequence,
            next_inbound_sequence: self.next_inbound_sequence,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncWireHello {
    pub sequence: u64,
    pub in_reply_to: Option<u64>,
    pub hello: MdbxSyncHello,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncWireIntegrityRootHello {
    pub sequence: u64,
    pub in_reply_to: Option<u64>,
    pub hello: MdbxIntegrityRootSyncHello,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncWireManifestPageRequest {
    pub sequence: u64,
    pub in_reply_to: Option<u64>,
    pub request: MdbxBlobManifestPageRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncWireManifestPageResponse {
    pub sequence: u64,
    pub in_reply_to: Option<u64>,
    pub response: MdbxBlobManifestPageResponse,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncWireChunkRequest {
    pub sequence: u64,
    pub in_reply_to: Option<u64>,
    pub request: MdbxBlobChunkRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxSyncWireChunkResponse {
    pub sequence: u64,
    pub in_reply_to: Option<u64>,
    pub response: MdbxBlobChunkResponse,
}

#[derive(uniffi::Object)]
pub struct MdbxSyncWireSession {
    wire: Mutex<SyncWireSession>,
    limits: SyncWireLimits,
}

/// Protocol-only Blob synchronization state for generated clients. The
/// application owns transport and Provider I/O, then calls acknowledgement
/// methods only after durable storage succeeds.
#[derive(uniffi::Object)]
pub struct MdbxBlobSyncSession {
    client: Mutex<SyncClient>,
}

/// Protocol-only authenticated root negotiation. The application persists the
/// last verified remote checkpoint outside the vault and owns transport.
#[derive(uniffi::Object)]
pub struct MdbxIntegrityRootSyncSession {
    negotiator: Mutex<SyncNegotiator>,
}

#[uniffi::export]
impl MdbxSyncWireSession {
    pub fn resume(&self) -> Result<MdbxSyncWireResume, MdbxFfiError> {
        let wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(wire.resume().clone().into())
    }

    pub fn restore_resume(&self, resume: MdbxSyncWireResume) -> Result<(), MdbxFfiError> {
        let mut wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        *wire = SyncWireSession::restore(resume.into_core())?;
        Ok(())
    }

    pub fn pending_inbound_sequence(&self) -> Result<Option<u64>, MdbxFfiError> {
        let wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(wire.pending_inbound_sequence())
    }

    pub fn acknowledge_inbound(&self, sequence: u64) -> Result<(), MdbxFfiError> {
        let mut wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        wire.acknowledge_inbound(sequence)?;
        Ok(())
    }

    pub fn discard_inbound(&self, sequence: u64) -> Result<(), MdbxFfiError> {
        let mut wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        wire.discard_inbound(sequence)?;
        Ok(())
    }

    pub fn encode_hello(
        &self,
        hello: MdbxSyncHello,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(SyncMessage::Hello(hello.into_request()), in_reply_to)
    }

    pub fn encode_hello_ack(
        &self,
        hello: MdbxSyncHello,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(SyncMessage::HelloAck(hello.into_response()), in_reply_to)
    }

    pub fn encode_integrity_root_hello(
        &self,
        hello: MdbxIntegrityRootSyncHello,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(SyncMessage::Hello(hello.into_request()?), in_reply_to)
    }

    pub fn encode_integrity_root_hello_ack(
        &self,
        hello: MdbxIntegrityRootSyncHello,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(SyncMessage::HelloAck(hello.into_response()?), in_reply_to)
    }

    pub fn encode_blob_manifest_page_request(
        &self,
        request: MdbxBlobManifestPageRequest,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(
            SyncMessage::BlobManifestPageRequest(request.into_core()?),
            in_reply_to,
        )
    }

    pub fn encode_blob_manifest_page_response(
        &self,
        response: MdbxBlobManifestPageResponse,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(
            SyncMessage::BlobManifestPageResponse(response.into()),
            in_reply_to,
        )
    }

    pub fn encode_blob_chunk_request(
        &self,
        request: MdbxBlobChunkRequest,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(
            SyncMessage::BlobChunkRequest(request.into_core()?),
            in_reply_to,
        )
    }

    pub fn encode_blob_chunk_response(
        &self,
        response: MdbxBlobChunkResponse,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        self.encode(SyncMessage::BlobChunkResponse(response.into()), in_reply_to)
    }

    pub fn accept_hello(&self, bytes: Vec<u8>) -> Result<MdbxSyncWireHello, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::Hello(hello) if hello.authenticated_state_root.is_none() => {
                Ok(MdbxSyncWireHello {
                    sequence: frame.sequence,
                    in_reply_to: frame.in_reply_to,
                    hello: hello.into(),
                })
            }
            SyncMessage::Hello(_) => {
                self.reject_wrong_message(frame.sequence, "Hello without integrity root")
            }
            _ => self.reject_wrong_message(frame.sequence, "Hello"),
        }
    }

    pub fn accept_integrity_root_hello(
        &self,
        bytes: Vec<u8>,
    ) -> Result<MdbxSyncWireIntegrityRootHello, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::Hello(hello) => Ok(MdbxSyncWireIntegrityRootHello {
                sequence: frame.sequence,
                in_reply_to: frame.in_reply_to,
                hello: hello.into(),
            }),
            _ => self.reject_wrong_message(frame.sequence, "Hello"),
        }
    }

    pub fn accept_hello_ack(&self, bytes: Vec<u8>) -> Result<MdbxSyncWireHello, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::HelloAck(hello) if hello.authenticated_state_root.is_none() => {
                Ok(MdbxSyncWireHello {
                    sequence: frame.sequence,
                    in_reply_to: frame.in_reply_to,
                    hello: hello.into(),
                })
            }
            SyncMessage::HelloAck(_) => {
                self.reject_wrong_message(frame.sequence, "HelloAck without integrity root")
            }
            _ => self.reject_wrong_message(frame.sequence, "HelloAck"),
        }
    }

    pub fn accept_integrity_root_hello_ack(
        &self,
        bytes: Vec<u8>,
    ) -> Result<MdbxSyncWireIntegrityRootHello, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::HelloAck(hello) => Ok(MdbxSyncWireIntegrityRootHello {
                sequence: frame.sequence,
                in_reply_to: frame.in_reply_to,
                hello: hello.into(),
            }),
            _ => self.reject_wrong_message(frame.sequence, "HelloAck"),
        }
    }

    pub fn accept_blob_manifest_page_request(
        &self,
        bytes: Vec<u8>,
    ) -> Result<MdbxSyncWireManifestPageRequest, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::BlobManifestPageRequest(request) => Ok(MdbxSyncWireManifestPageRequest {
                sequence: frame.sequence,
                in_reply_to: frame.in_reply_to,
                request: request.into(),
            }),
            _ => self.reject_wrong_message(frame.sequence, "BlobManifestPageRequest"),
        }
    }

    pub fn accept_blob_manifest_page_response(
        &self,
        bytes: Vec<u8>,
    ) -> Result<MdbxSyncWireManifestPageResponse, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::BlobManifestPageResponse(response) => {
                Ok(MdbxSyncWireManifestPageResponse {
                    sequence: frame.sequence,
                    in_reply_to: frame.in_reply_to,
                    response: response.into(),
                })
            }
            _ => self.reject_wrong_message(frame.sequence, "BlobManifestPageResponse"),
        }
    }

    pub fn accept_blob_chunk_request(
        &self,
        bytes: Vec<u8>,
    ) -> Result<MdbxSyncWireChunkRequest, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::BlobChunkRequest(request) => Ok(MdbxSyncWireChunkRequest {
                sequence: frame.sequence,
                in_reply_to: frame.in_reply_to,
                request: request.into(),
            }),
            _ => self.reject_wrong_message(frame.sequence, "BlobChunkRequest"),
        }
    }

    pub fn accept_blob_chunk_response(
        &self,
        bytes: Vec<u8>,
    ) -> Result<MdbxSyncWireChunkResponse, MdbxFfiError> {
        let frame = self.accept(bytes)?;
        match frame.message {
            SyncMessage::BlobChunkResponse(response) => Ok(MdbxSyncWireChunkResponse {
                sequence: frame.sequence,
                in_reply_to: frame.in_reply_to,
                response: response.into(),
            }),
            _ => self.reject_wrong_message(frame.sequence, "BlobChunkResponse"),
        }
    }
}

impl MdbxSyncWireSession {
    fn encode(
        &self,
        message: SyncMessage,
        in_reply_to: Option<u64>,
    ) -> Result<Vec<u8>, MdbxFfiError> {
        let mut wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(wire.encode_outbound(message, in_reply_to, self.limits)?)
    }

    fn accept(&self, bytes: Vec<u8>) -> Result<SyncWireFrame, MdbxFfiError> {
        let mut wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(wire.accept_inbound_bytes(&bytes, self.limits)?)
    }

    fn reject_wrong_message<T>(&self, sequence: u64, expected: &str) -> Result<T, MdbxFfiError> {
        let mut wire = self.wire.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        wire.discard_inbound(sequence)?;
        Err(MdbxFfiError::SyncProtocol {
            message: format!("expected {expected} message in sync wire frame"),
        })
    }
}

#[uniffi::export]
impl MdbxIntegrityRootSyncSession {
    pub fn hello(&self) -> Result<MdbxIntegrityRootSyncHello, MdbxFfiError> {
        let negotiator = self
            .negotiator
            .lock()
            .map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(negotiator.local_hello()?.into())
    }

    pub fn accept_hello(
        &self,
        hello: MdbxIntegrityRootSyncHello,
    ) -> Result<MdbxIntegrityRootSyncHello, MdbxFfiError> {
        let hello = hello.into_request()?;
        let mut negotiator = self
            .negotiator
            .lock()
            .map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(negotiator.on_hello(&hello)?.into())
    }

    pub fn accept_hello_ack(&self, hello: MdbxIntegrityRootSyncHello) -> Result<(), MdbxFfiError> {
        let hello = hello.into_response()?;
        let mut negotiator = self
            .negotiator
            .lock()
            .map_err(|_| MdbxFfiError::LockPoisoned)?;
        negotiator.on_hello_ack(&hello)?;
        Ok(())
    }

    pub fn integrity_root_is_negotiated(&self) -> Result<bool, MdbxFfiError> {
        let negotiator = self
            .negotiator
            .lock()
            .map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(negotiator.authenticated_state_root_is_negotiated())
    }

    pub fn remote_integrity_root_checkpoint(
        &self,
    ) -> Result<Option<MdbxAuthenticatedStateRootCheckpoint>, MdbxFfiError> {
        let negotiator = self
            .negotiator
            .lock()
            .map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(negotiator
            .remote_authenticated_state_root()
            .cloned()
            .map(Into::into))
    }
}

#[uniffi::export]
impl MdbxBlobSyncSession {
    pub fn hello(&self) -> Result<MdbxSyncHello, MdbxFfiError> {
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client.hello()?.into())
    }

    pub fn accept_hello(&self, hello: MdbxSyncHello) -> Result<MdbxSyncHello, MdbxFfiError> {
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client.on_hello(&hello.into_request())?.into())
    }

    pub fn accept_hello_ack(&self, hello: MdbxSyncHello) -> Result<(), MdbxFfiError> {
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.on_hello_ack(&hello.into_response())?;
        Ok(())
    }

    pub fn blob_replication_is_negotiated(&self) -> Result<bool, MdbxFfiError> {
        let client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client.blob_replication_is_negotiated())
    }

    pub fn begin_blob_sync(&self, namespace_id: String) -> Result<(), MdbxFfiError> {
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.begin_blob_sync(namespace_id)?;
        Ok(())
    }

    pub fn restore_blob_sync(&self, resume: MdbxBlobSyncResume) -> Result<(), MdbxFfiError> {
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.restore_blob_sync(resume.into())?;
        Ok(())
    }

    pub fn blob_resume(&self) -> Result<Option<MdbxBlobSyncResume>, MdbxFfiError> {
        let client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client.blob_resume().cloned().map(Into::into))
    }

    pub fn blob_sync_phase(&self) -> Result<MdbxBlobSyncPhase, MdbxFfiError> {
        let client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client.blob_sync_phase().into())
    }

    pub fn blob_manifest_request(
        &self,
        page_size: u32,
    ) -> Result<MdbxBlobManifestPageRequest, MdbxFfiError> {
        let page_size = usize::try_from(page_size).map_err(|_| MdbxFfiError::SyncProtocol {
            message: "Blob manifest page size cannot be represented locally".to_string(),
        })?;
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client.blob_manifest_request(page_size)?.into())
    }

    pub fn validate_blob_manifest_response(
        &self,
        response: MdbxBlobManifestPageResponse,
    ) -> Result<(), MdbxFfiError> {
        let response: BlobManifestPageResponse = response.into();
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.validate_blob_manifest_response(&response)?;
        Ok(())
    }

    pub fn acknowledge_blob_manifest_page(
        &self,
        response: MdbxBlobManifestPageResponse,
    ) -> Result<(), MdbxFfiError> {
        let response: BlobManifestPageResponse = response.into();
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.acknowledge_blob_manifest_page(&response)?;
        Ok(())
    }

    pub fn blob_chunk_request(
        &self,
        blob_id: String,
        total_size: u64,
        max_bytes: u32,
    ) -> Result<MdbxBlobChunkRequest, MdbxFfiError> {
        let max_bytes = usize::try_from(max_bytes).map_err(|_| MdbxFfiError::SyncProtocol {
            message: "Blob chunk size cannot be represented locally".to_string(),
        })?;
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(client
            .blob_chunk_request(blob_id, total_size, max_bytes)?
            .into())
    }

    pub fn validate_blob_chunk_response(
        &self,
        response: MdbxBlobChunkResponse,
    ) -> Result<(), MdbxFfiError> {
        let response: BlobChunkResponse = response.into();
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.validate_blob_chunk_response(&response)?;
        Ok(())
    }

    pub fn acknowledge_blob_chunk(
        &self,
        response: MdbxBlobChunkResponse,
    ) -> Result<(), MdbxFfiError> {
        let response: BlobChunkResponse = response.into();
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.acknowledge_blob_chunk(&response)?;
        Ok(())
    }

    pub fn restart_blob_transfer_after_abort(
        &self,
        blob_id: String,
        total_size: u64,
    ) -> Result<(), MdbxFfiError> {
        let mut client = self.client.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        client.restart_blob_transfer_after_abort(&blob_id, total_size)?;
        Ok(())
    }
}

#[uniffi::export]
impl MdbxVault {
    /// Extension-only export: retain one SQLite read transaction for both the
    /// database and every current/deleted/snapshot Blob reference. The caller
    /// owns a fresh destination directory and removes it on failure.
    pub fn create_complete_backup(
        &self,
        destination: String,
        max_bytes: u64,
    ) -> Result<MdbxExternalBlobReferencePage, MdbxFfiError> {
        let conn = self.conn.read().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let transaction = conn.inner().unchecked_transaction().map_err(StorageError::from)?;
        let references = collect_external_blob_references(&conn, BlobLifecycleLimits::default())?;
        let source = vault_blob_store(&conn)?;
        let destination = Path::new(&destination);
        let backup = BackupService::create_portable_copy(&conn, destination)?;
        let mut total = backup.file_size_bytes;
        if total > max_bytes {
            return Err(StorageError::Validation("complete backup exceeds size limit".into()).into());
        }
        let target = mdbx_storage::blob_store::FileSystemBlobStore::new(
            destination.with_extension("mdbx.blobs"),
        );
        let mut items = Vec::with_capacity(references.blobs.len());
        for (blob_id, maximum_bytes) in &references.blobs {
            let (state, size) = external_blob_reference_state(&source, blob_id, *maximum_bytes as u64)?;
            if state != MdbxExternalBlobState::Available {
                return Err(StorageError::BlobStore("complete backup requires every referenced Blob".into()).into());
            }
            let size = size.ok_or_else(|| StorageError::BlobStore("missing Blob size".into()))?;
            total = total.checked_add(size).filter(|total| *total <= max_bytes)
                .ok_or_else(|| StorageError::Validation("complete backup exceeds size limit".into()))?;
            let mut offset = 0;
            let mut hash = Sha256::new();
            while offset < size {
                let count = (size - offset).min(FILE_HASH_BUFFER_BYTES as u64) as usize;
                let bytes = source.read_chunk(blob_id, offset, count)?;
                if bytes.len() != count {
                    return Err(StorageError::BlobStore("Blob changed during complete backup".into()).into());
                }
                hash.update(&bytes);
                target.write_chunk(blob_id, size, offset, &bytes, offset + bytes.len() as u64 == size)?;
                offset += bytes.len() as u64;
            }
            if format!("{:x}", hash.finalize()) != *blob_id {
                return Err(StorageError::BlobStore("complete backup Blob digest mismatch".into()).into());
            }
            items.push(MdbxExternalBlobReference { blob_id: blob_id.clone(), total_size: Some(size), state });
        }
        // Dropping the read transaction releases the SQLite snapshot, without
        // changing the source or advancing its write revision.
        drop(transaction);
        Ok(MdbxExternalBlobReferencePage {
            raw_reference_count: references.raw_reference_count as u64,
            unique_reference_count: items.len() as u64,
            items,
            next_cursor: None,
        })
    }

    /// Create the complete bootstrap and its exact incremental starting point
    /// while holding the vault session lock. Ordinary synchronization uses
    /// immutable incremental segments after this one-time operation.
    pub fn create_incremental_sync_bootstrap(
        &self,
        destination: String,
    ) -> Result<MdbxIncrementalSyncBootstrapInfo, MdbxFfiError> {
        let conn = self.conn.read().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let backup = BackupService::create_portable_copy(&conn, Path::new(&destination))?;
        let checkpoint = PeerSyncService::current_checkpoint(&conn)?;
        Ok(MdbxIncrementalSyncBootstrapInfo {
            backup: backup.into(),
            checkpoint: checkpoint.into(),
        })
    }

    pub fn incremental_sync_checkpoint(
        &self,
    ) -> Result<MdbxIncrementalSyncCheckpoint, MdbxFfiError> {
        let conn = self.conn.read().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(PeerSyncService::current_checkpoint(&conn)?.into())
    }

    /// Export an authenticated complete bundle for explicit user-mediated
    /// transfer. The destination is written through a sibling temporary file,
    /// fsynced, and published without overwriting an existing file.
    pub fn export_manual_sync_bundle(
        &self,
        destination: String,
    ) -> Result<MdbxManualSyncBundleInfo, MdbxFfiError> {
        let destination = Path::new(&destination);
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let conn = self.conn.read().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let bundle = PeerSyncService::export_complete_bundle(&conn, &self.device_id)?;
        let integrity_key = sync_integrity_key(&conn)?;
        let mut temporary = NamedTempFile::new_in(parent).map_err(StorageError::from)?;
        write_bundle_authenticated(&bundle, &mut temporary, integrity_key.as_slice())?;
        temporary
            .as_file_mut()
            .sync_all()
            .map_err(StorageError::from)?;
        let info = manual_bundle_info(&bundle, temporary.path())?;
        match temporary.persist_noclobber(destination) {
            Ok(_) => Ok(info),
            Err(error) => Err(StorageError::Io(error.error).into()),
        }
    }

    /// Authenticate and atomically apply one complete manual bundle. Complete
    /// bundles are deliberately distinct from incremental transport segments:
    /// callers do not construct or persist peer checkpoints for this path.
    pub fn apply_manual_sync_bundle(
        &self,
        source: String,
    ) -> Result<MdbxManualSyncApplyResult, MdbxFfiError> {
        let mut conn = self.conn.write().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let (bundle, info) = read_manual_bundle(&conn, Path::new(&source))?;
        if bundle.vault_id != self.vault_id {
            return Err(StorageError::ConstraintViolation(format!(
                "bundle vault_id {} does not match local vault_id {}",
                bundle.vault_id, self.vault_id
            ))
            .into());
        }
        let applied = SyncApplyRepo::apply_incremental_batch_mut(
            &mut conn,
            &CommitContext::new(self.device_id.clone()),
            &CommitBatch::new(bundle.commits, 0, true),
            &[],
        )?;
        Ok(MdbxManualSyncApplyResult {
            bundle: info,
            applied_commits: applied.applied_commits,
            skipped_commits: applied.skipped_commits,
            conflict_count: applied.conflict_count,
            missing_parent_count: applied.missing_parent_count,
        })
    }

    /// Append a bounded number of metadata-only commits to measure the real
    /// unlocked engine path without creating user-visible objects.
    pub fn run_metadata_benchmark(
        &self,
        operation_count: u32,
    ) -> Result<MdbxMetadataBenchmarkResult, MdbxFfiError> {
        if !(1..=MAX_METADATA_BENCHMARK_OPERATIONS).contains(&operation_count) {
            return Err(StorageError::Validation(format!(
                "metadata benchmark operation count must be between 1 and {MAX_METADATA_BENCHMARK_OPERATIONS}"
            ))
            .into());
        }
        let conn = self.conn.write().map_err(|_| MdbxFfiError::LockPoisoned)?;
        if conn.keyring().is_none() {
            return Err(StorageError::Validation(
                "metadata benchmark requires an unlocked vault".to_string(),
            )
            .into());
        }
        let context = CommitContext::new(self.device_id.clone());
        let started = Instant::now();
        let mut completed = 0_u32;
        for index in 0..operation_count {
            let operation = CommitOperation::new(
                Uuid::new_v4().to_string(),
                "monica-metadata-benchmark",
                "main",
                "change",
                "vault-meta",
                Vec::new(),
            )
            .with_message(format!("metadata benchmark operation {}", index + 1));
            let execution = context.run_operation(&conn, operation, |scoped| {
                scoped
                    .create_commit(&conn, "change", "vault-meta", &[], &[])
                    .map(|_| ())
            })?;
            if matches!(execution, OperationExecution::Applied { .. }) {
                completed = completed.checked_add(1).ok_or_else(|| {
                    StorageError::Validation("metadata benchmark count overflow".to_string())
                })?;
            }
        }
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(MdbxMetadataBenchmarkResult {
            operation_count: completed,
            elapsed_ms,
        })
    }

    /// Write one authenticated v8 segment to a new app-private file. The
    /// destination is published atomically and is never overwritten.
    pub fn export_incremental_sync_segment(
        &self,
        destination: String,
        base: MdbxIncrementalSyncCheckpoint,
        resume: Option<MdbxIncrementalSyncResume>,
        page_size: u32,
    ) -> Result<MdbxIncrementalSyncSegmentInfo, MdbxFfiError> {
        let base = base.into_core()?;
        let resume = resume
            .map(MdbxIncrementalSyncResume::into_core)
            .transpose()?;
        let page_size = usize::try_from(page_size).map_err(|_| MdbxFfiError::SyncProtocol {
            message: "incremental page size cannot be represented locally".to_string(),
        })?;
        let destination = Path::new(&destination);
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let conn = self.conn.read().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let bundle = PeerSyncService::export_incremental_segment(
            &conn,
            &self.device_id,
            &base,
            resume.as_ref(),
            PeerSyncSegmentOptions { page_size },
        )?;
        let integrity_key = sync_integrity_key(&conn)?;
        let mut temporary = NamedTempFile::new_in(parent).map_err(StorageError::from)?;
        {
            // Bincode emits many small writes for byte arrays. Bound memory while
            // coalescing them, and surface flush errors before publishing the file.
            let mut writer = BufWriter::with_capacity(64 * 1024, &mut temporary);
            write_incremental_bundle_authenticated(&bundle, &mut writer, integrity_key.as_slice())?;
            writer.flush().map_err(StorageError::from)?;
        }
        temporary
            .as_file_mut()
            .sync_all()
            .map_err(StorageError::from)?;
        let file_size_bytes = temporary
            .as_file()
            .metadata()
            .map_err(StorageError::from)?
            .len();
        match temporary.persist_noclobber(destination) {
            Ok(_) => segment_info(&bundle, file_size_bytes),
            Err(error) => Err(StorageError::Io(error.error).into()),
        }
    }

    /// Authenticate and inspect a pending segment without changing vault
    /// state. This lets Android recover a durably written pending file after a
    /// process restart instead of regenerating different bytes.
    pub fn inspect_incremental_sync_segment(
        &self,
        source: String,
    ) -> Result<MdbxIncrementalSyncSegmentInfo, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let (bundle, file_size_bytes) = read_incremental_segment(&conn, Path::new(&source))?;
        segment_info(&bundle, file_size_bytes)
    }

    /// Authenticate and atomically apply one immutable segment. The caller
    /// advances its durable per-stream cursor only after this method returns.
    pub fn apply_incremental_sync_segment(
        &self,
        source: String,
        expected_base: MdbxIncrementalSyncCheckpoint,
        expected_resume: Option<MdbxIncrementalSyncResume>,
    ) -> Result<MdbxIncrementalSyncApplyResult, MdbxFfiError> {
        let expected_base = expected_base.into_core()?;
        let expected_resume = expected_resume
            .map(MdbxIncrementalSyncResume::into_core)
            .transpose()?;
        let mut conn = self.conn.write().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let (bundle, _) = read_incremental_segment(&conn, Path::new(&source))?;
        let applied = PeerSyncService::apply_incremental_segment(
            &mut conn,
            &self.device_id,
            &bundle,
            &expected_base,
            expected_resume.as_ref(),
        )?;
        let next_resume = PeerSyncService::next_resume(&bundle)?;
        Ok(MdbxIncrementalSyncApplyResult {
            result: bundle.manifest.result.into(),
            next_resume: next_resume.map(Into::into),
            applied_commits: applied.applied_commits,
            skipped_commits: applied.skipped_commits,
            conflict_count: applied.conflict_count,
            missing_parent_count: applied.missing_parent_count,
        })
    }

    /// Page only Blob IDs that are referenced by current objects or retained
    /// snapshots. Orphans are intentionally excluded from remote publication.
    pub fn list_external_blob_references(
        &self,
        cursor: Option<String>,
        page_size: u32,
    ) -> Result<MdbxExternalBlobReferencePage, MdbxFfiError> {
        if let Some(cursor) = cursor.as_deref() {
            validate_blob_id(cursor)?;
        }
        let page_size = usize::try_from(page_size).map_err(|_| MdbxFfiError::SyncProtocol {
            message: "Blob page size cannot be represented locally".to_string(),
        })?;
        if !(1..=MAX_BLOB_PAGE_SIZE).contains(&page_size) {
            return Err(StorageError::Validation(format!(
                "Blob page size must be between 1 and {MAX_BLOB_PAGE_SIZE}"
            ))
            .into());
        }
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let references = collect_external_blob_references(&conn, BlobLifecycleLimits::default())?;
        let blob_store = vault_blob_store(&conn)?;
        let mut items = Vec::with_capacity(page_size.saturating_add(1));
        for (blob_id, maximum_bytes) in references.blobs.iter().filter(|(blob_id, _)| {
            cursor
                .as_deref()
                .is_none_or(|cursor| blob_id.as_str() > cursor)
        }) {
            let maximum_bytes = u64::try_from(*maximum_bytes).map_err(|_| {
                StorageError::Validation("Blob reference size cannot be represented".to_string())
            })?;
            let (state, total_size) =
                external_blob_reference_state(&blob_store, blob_id, maximum_bytes)?;
            items.push(MdbxExternalBlobReference {
                blob_id: blob_id.clone(),
                total_size,
                state,
            });
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
        Ok(MdbxExternalBlobReferencePage {
            raw_reference_count: references.raw_reference_count as u64,
            unique_reference_count: references.blobs.len() as u64,
            items,
            next_cursor,
        })
    }

    pub fn has_external_blob(
        &self,
        blob_id: String,
        total_size: u64,
    ) -> Result<bool, MdbxFfiError> {
        validate_blob_id(&blob_id)?;
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        Ok(matches!(
            external_blob_state(&blob_store, &blob_id, total_size)?,
            MdbxExternalBlobState::Available
        ))
    }

    pub fn read_external_blob_chunk(
        &self,
        blob_id: String,
        total_size: u64,
        offset: u64,
        max_bytes: u32,
    ) -> Result<MdbxExternalBlobChunk, MdbxFfiError> {
        validate_blob_id(&blob_id)?;
        let max_bytes = usize::try_from(max_bytes).map_err(|_| MdbxFfiError::SyncProtocol {
            message: "Blob chunk size cannot be represented locally".to_string(),
        })?;
        if !(1..=MAX_BLOB_TRANSFER_CHUNK_SIZE).contains(&max_bytes) {
            return Err(StorageError::Validation(format!(
                "Blob chunk size must be between 1 and {MAX_BLOB_TRANSFER_CHUNK_SIZE}"
            ))
            .into());
        }
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        if external_blob_state(&blob_store, &blob_id, total_size)?
            != MdbxExternalBlobState::Available
        {
            return Err(StorageError::BlobStore(format!(
                "Blob {blob_id} is unavailable or has an unexpected size"
            ))
            .into());
        }
        let ciphertext = blob_store.read_chunk(&blob_id, offset, max_bytes)?;
        if ciphertext.is_empty() {
            return Err(StorageError::Validation(
                "Blob chunk offset must be below the total size".to_string(),
            )
            .into());
        }
        let end = offset
            .checked_add(ciphertext.len() as u64)
            .ok_or_else(|| StorageError::Validation("Blob chunk offset overflow".to_string()))?;
        Ok(MdbxExternalBlobChunk {
            blob_id,
            total_size,
            offset,
            ciphertext,
            is_last: end == total_size,
        })
    }

    pub fn write_external_blob_chunk(
        &self,
        blob_id: String,
        total_size: u64,
        offset: u64,
        ciphertext: Vec<u8>,
        finalize: bool,
    ) -> Result<(), MdbxFfiError> {
        validate_blob_id(&blob_id)?;
        if ciphertext.is_empty() || ciphertext.len() > MAX_BLOB_TRANSFER_CHUNK_SIZE {
            return Err(StorageError::Validation(format!(
                "Blob chunk must contain 1 to {MAX_BLOB_TRANSFER_CHUNK_SIZE} bytes"
            ))
            .into());
        }
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        blob_store.write_chunk(&blob_id, total_size, offset, &ciphertext, finalize)?;
        Ok(())
    }

    pub fn acquire_external_blob_lease(
        &self,
        blob_id: String,
        owner_id: String,
        now_unix_secs: i64,
        ttl_secs: i64,
    ) -> Result<MdbxExternalBlobLease, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        let lease = blob_store.acquire_lease(&blob_id, &owner_id, now_unix_secs, ttl_secs)?;
        Ok(MdbxExternalBlobLease {
            blob_id: lease.blob_id,
            owner_id: lease.owner_id,
            expires_at_unix_secs: lease.expires_at_unix_secs,
        })
    }

    pub fn renew_external_blob_lease(
        &self,
        blob_id: String,
        owner_id: String,
        now_unix_secs: i64,
        ttl_secs: i64,
    ) -> Result<MdbxExternalBlobLease, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        let lease = blob_store.renew_lease(&blob_id, &owner_id, now_unix_secs, ttl_secs)?;
        Ok(MdbxExternalBlobLease {
            blob_id: lease.blob_id,
            owner_id: lease.owner_id,
            expires_at_unix_secs: lease.expires_at_unix_secs,
        })
    }

    pub fn release_external_blob_lease(
        &self,
        blob_id: String,
        owner_id: String,
    ) -> Result<(), MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        blob_store.release_lease(&blob_id, &owner_id)?;
        Ok(())
    }

    pub fn abort_external_blob_transfer(
        &self,
        blob_id: String,
        owner_id: String,
    ) -> Result<(), MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let blob_store = vault_blob_store(&conn)?;
        blob_store.abort_transfer(&blob_id, &owner_id)?;
        blob_store.release_lease(&blob_id, &owner_id)?;
        Ok(())
    }
}

fn external_blob_state(
    blob_store: &mdbx_storage::blob_store::FileSystemBlobStore,
    blob_id: &str,
    total_size: u64,
) -> Result<MdbxExternalBlobState, MdbxFfiError> {
    let path = blob_store.blob_path(blob_id)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MdbxExternalBlobState::Missing)
        }
        Err(error) => return Err(StorageError::Io(error).into()),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(
            StorageError::BlobStore(format!("Blob {blob_id} is not a regular file")).into(),
        );
    }
    if metadata.len() == total_size {
        Ok(MdbxExternalBlobState::Available)
    } else {
        Ok(MdbxExternalBlobState::SizeMismatch)
    }
}

fn external_blob_reference_state(
    blob_store: &mdbx_storage::blob_store::FileSystemBlobStore,
    blob_id: &str,
    maximum_bytes: u64,
) -> Result<(MdbxExternalBlobState, Option<u64>), MdbxFfiError> {
    let path = blob_store.blob_path(blob_id)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((MdbxExternalBlobState::Missing, None))
        }
        Err(error) => return Err(StorageError::Io(error).into()),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(
            StorageError::BlobStore(format!("Blob {blob_id} is not a regular file")).into(),
        );
    }
    let total_size = metadata.len();
    let state = if total_size == 0 || total_size > maximum_bytes {
        MdbxExternalBlobState::SizeMismatch
    } else {
        MdbxExternalBlobState::Available
    };
    Ok((state, Some(total_size)))
}

fn sync_integrity_key(
    conn: &mdbx_storage::connection::VaultConnection,
) -> Result<Zeroizing<Vec<u8>>, MdbxFfiError> {
    conn.keyring()
        .map(|keyring| keyring.integrity_subkey.clone())
        .ok_or_else(|| MdbxFfiError::SyncProtocol {
            message: "authenticated synchronization requires an unlocked vault".to_string(),
        })
}

fn read_manual_bundle(
    conn: &mdbx_storage::connection::VaultConnection,
    source: &Path,
) -> Result<(SyncBundle, MdbxManualSyncBundleInfo), MdbxFfiError> {
    let metadata = std::fs::symlink_metadata(source).map_err(StorageError::from)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(StorageError::Validation(
            "manual sync bundle must be a regular file".to_string(),
        )
        .into());
    }
    let file = File::open(source).map_err(StorageError::from)?;
    let integrity_key = sync_integrity_key(conn)?;
    let mut reader = BufReader::new(file);
    let bundle = match read_bundle_file_with_limits_authenticated(
        &mut reader,
        BundleReadLimits::default(),
        integrity_key.as_slice(),
    )? {
        SyncBundleFile::Complete(bundle) => bundle,
        SyncBundleFile::Incremental(_) => {
            return Err(MdbxFfiError::SyncProtocol {
                message: "incremental segment cannot be applied as a complete manual bundle"
                    .to_string(),
            })
        }
    };
    let info = manual_bundle_info(&bundle, source)?;
    Ok((bundle, info))
}

fn manual_bundle_info(
    bundle: &SyncBundle,
    path: &Path,
) -> Result<MdbxManualSyncBundleInfo, MdbxFfiError> {
    let head_commit_id = bundle
        .commits
        .last()
        .map(|commit| commit.commit.commit_id.clone())
        .ok_or_else(|| {
            StorageError::Validation("complete manual bundle contains no commits".to_string())
        })?;
    let commit_count =
        u32::try_from(bundle.commits.len()).map_err(|_| StorageError::ResourceLimit {
            resource: "manual sync bundle commits".to_string(),
            actual: bundle.commits.len() as u64,
            limit: u32::MAX as u64,
        })?;
    let file_size_bytes = std::fs::metadata(path).map_err(StorageError::from)?.len();
    if file_size_bytes == 0 {
        return Err(StorageError::Validation("manual sync bundle is empty".to_string()).into());
    }
    Ok(MdbxManualSyncBundleInfo {
        vault_id: bundle.vault_id.clone(),
        source_device_id: bundle.source_device_id.clone(),
        head_commit_id,
        commit_count,
        exported_at: bundle.exported_at.clone(),
        payload_sha256: sha256_file(path)?,
        file_size_bytes,
    })
}

fn sha256_file(path: &Path) -> Result<Vec<u8>, MdbxFfiError> {
    let mut reader = BufReader::new(File::open(path).map_err(StorageError::from)?);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; FILE_HASH_BUFFER_BYTES];
    loop {
        let count = reader.read(&mut buffer).map_err(StorageError::from)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher.finalize().to_vec())
}

fn read_incremental_segment(
    conn: &mdbx_storage::connection::VaultConnection,
    source: &Path,
) -> Result<(IncrementalSyncBundle, u64), MdbxFfiError> {
    let file = File::open(source).map_err(StorageError::from)?;
    let file_size_bytes = file.metadata().map_err(StorageError::from)?.len();
    let integrity_key = sync_integrity_key(conn)?;
    let mut reader = BufReader::new(file);
    match read_bundle_file_with_limits_authenticated(
        &mut reader,
        BundleReadLimits::default(),
        integrity_key.as_slice(),
    )? {
        SyncBundleFile::Incremental(bundle) => Ok((*bundle, file_size_bytes)),
        SyncBundleFile::Complete(_) => Err(MdbxFfiError::SyncProtocol {
            message: "complete bootstrap cannot be applied as an incremental segment".to_string(),
        }),
    }
}

fn segment_info(
    bundle: &IncrementalSyncBundle,
    file_size_bytes: u64,
) -> Result<MdbxIncrementalSyncSegmentInfo, MdbxFfiError> {
    let commit_count =
        u32::try_from(bundle.commits.len()).map_err(|_| MdbxFfiError::SyncProtocol {
            message: "incremental commit count cannot be represented".to_string(),
        })?;
    let delta_count = u32::try_from(bundle.manifest.delta_inventory.len()).map_err(|_| {
        MdbxFfiError::SyncProtocol {
            message: "incremental delta count cannot be represented".to_string(),
        }
    })?;
    Ok(MdbxIncrementalSyncSegmentInfo {
        vault_id: bundle.manifest.vault_id.clone(),
        source_device_id: bundle.manifest.source_device_id.clone(),
        transfer_id: bundle.manifest.transfer_id.clone(),
        segment_index: bundle.manifest.segment_index,
        is_last: bundle.manifest.is_last,
        base: bundle.manifest.base.clone().into(),
        result: bundle.manifest.result.clone().into(),
        next_resume: PeerSyncService::next_resume(bundle)?.map(Into::into),
        commit_count,
        delta_count,
        payload_sha256: incremental_bundle_payload_sha256(bundle)?,
        file_size_bytes,
    })
}

#[uniffi::export]
pub fn create_integrity_root_sync_session(
    device_id: String,
    checkpoint: MdbxAuthenticatedStateRootCheckpoint,
) -> Result<Arc<MdbxIntegrityRootSyncSession>, MdbxFfiError> {
    let mut negotiator = SyncNegotiator::new(&device_id, Vec::new(), Vec::new());
    negotiator.enable_authenticated_state_root_checkpoint(checkpoint.into_core()?)?;
    Ok(Arc::new(MdbxIntegrityRootSyncSession {
        negotiator: Mutex::new(negotiator),
    }))
}

#[uniffi::export]
pub fn create_blob_sync_session(
    device_id: String,
) -> Result<Arc<MdbxBlobSyncSession>, MdbxFfiError> {
    let mut negotiator = SyncNegotiator::new(&device_id, Vec::new(), Vec::new());
    negotiator.enable_blob_replication_capabilities()?;
    Ok(Arc::new(MdbxBlobSyncSession {
        client: Mutex::new(SyncClient::new(negotiator, None, None)),
    }))
}

#[uniffi::export]
pub fn default_sync_wire_payload_bytes() -> u64 {
    mdbx_sync::MAX_SYNC_WIRE_PAYLOAD_BYTES
}

#[uniffi::export]
pub fn create_sync_wire_session(
    session_id: String,
    max_payload_bytes: u64,
) -> Result<Arc<MdbxSyncWireSession>, MdbxFfiError> {
    let limits = SyncWireLimits::new(max_payload_bytes)?;
    Ok(Arc::new(MdbxSyncWireSession {
        wire: Mutex::new(SyncWireSession::new(session_id)?),
        limits,
    }))
}
