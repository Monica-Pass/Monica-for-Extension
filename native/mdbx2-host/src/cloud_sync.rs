use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use mdbx_ffi::{
    MdbxExternalBlobState, MdbxIncrementalSyncCheckpoint, MdbxIncrementalSyncResume,
    MdbxIncrementalSyncSegmentInfo, MdbxVault,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::runtime::{HostRuntime, RpcFailure, MAX_BINARY_CHUNK_BYTES, MAX_INBOUND_FILE_BYTES};

const SYNC_STATE_VERSION: u32 = 1;
const MAX_SYNC_STATE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CHECKPOINT_TOKEN_BYTES: usize = 4096;
const MAX_REMOTE_STREAMS: usize = 4096;
const MAX_BLOB_TRANSFERS: usize = 8;
const MAX_VERIFIED_REMOTE_BLOBS: usize = 100_000;
const MAX_COMPONENT_BYTES: usize = 256;
const MAX_REASON_BYTES: usize = 512;
pub(crate) const MAX_BLOB_PAGE_SIZE: u32 = 256;
pub(crate) const SEGMENT_PAGE_SIZE: u32 = 128;
const BLOB_LEASE_TTL_SECONDS: i64 = 15 * 60;
pub(crate) const MAX_REMOTE_BLOB_BYTES: u64 = 64 * 1024 * 1024 + 128 * 1024;
const MAX_BASE64_CHUNK_BYTES: usize = MAX_BINARY_CHUNK_BYTES.div_ceil(3) * 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncCheckpointState {
    commit_inventory: String,
    delta_inventory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncResumeState {
    transfer_id: String,
    next_segment_index: u32,
    previous_segment_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingBootstrapState {
    output_handle: String,
    checkpoint: SyncCheckpointState,
    file_size_bytes: u64,
    file_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingSegmentState {
    output_handle: String,
    vault_id: String,
    source_device_id: String,
    transfer_id: String,
    segment_index: u32,
    is_last: bool,
    base: SyncCheckpointState,
    result: SyncCheckpointState,
    next_resume: Option<SyncResumeState>,
    commit_count: u32,
    delta_count: u32,
    payload_sha256: String,
    file_size_bytes: u64,
    file_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRemoteSegmentState {
    stream_id: String,
    device_id: String,
    generation_id: String,
    sequence: u64,
    digest: String,
    expected_base: SyncCheckpointState,
    expected_resume: Option<SyncResumeState>,
    next_checkpoint: SyncCheckpointState,
    next_resume: Option<SyncResumeState>,
    applied_commits: u32,
    skipped_commits: u32,
    conflict_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteStreamState {
    stream_id: String,
    device_id: String,
    generation_id: String,
    next_sequence: u64,
    checkpoint: SyncCheckpointState,
    resume: Option<SyncResumeState>,
    last_applied_digest: Option<String>,
    blocked_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlobTransferState {
    blob_id: String,
    total_size: u64,
    owner_id: String,
    next_offset: u64,
    lease_expires_at_unix_secs: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerifiedRemoteBlobState {
    blob_id: String,
    total_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncState {
    version: u32,
    revision: u64,
    state_handle: String,
    vault_handle: String,
    remote_binding: String,
    vault_id: String,
    device_id: String,
    bootstrap_checkpoint: Option<SyncCheckpointState>,
    export_checkpoint: Option<SyncCheckpointState>,
    pending_bootstrap: Option<PendingBootstrapState>,
    pending_segment: Option<PendingSegmentState>,
    pending_remote_segment: Option<PendingRemoteSegmentState>,
    remote_streams: Vec<RemoteStreamState>,
    blob_transfers: Vec<BlobTransferState>,
    verified_remote_blobs: Vec<VerifiedRemoteBlobState>,
}

#[derive(Debug)]
struct StateAccess {
    vault_handle: String,
    state_handle: String,
    remote_binding: String,
}

pub(crate) fn supports(method: &str) -> bool {
    matches!(
        method,
        "transfer.read"
            | "transfer.release"
            | "sync.state.register"
            | "sync.state.status"
            | "sync.bootstrap.prepare"
            | "sync.bootstrap.commit"
            | "sync.segment.prepare"
            | "sync.segment.commit"
            | "sync.stream.list"
            | "sync.stream.block"
            | "sync.segment.inspect"
            | "sync.segment.apply"
            | "sync.segment.acknowledge"
            | "sync.blob.list"
            | "sync.blob.read"
            | "sync.blob.remote.verify"
            | "sync.blob.receive.begin"
            | "sync.blob.receive.chunk"
            | "sync.blob.receive.abort"
    )
}

pub(crate) fn handle(
    runtime: &mut HostRuntime,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "transfer.read" => transfer_read(runtime, params),
        "transfer.release" => transfer_release(runtime, params),
        "sync.state.register" => sync_state_register(runtime, params),
        "sync.state.status" => sync_state_status(runtime, params),
        "sync.bootstrap.prepare" => sync_bootstrap_prepare(runtime, params),
        "sync.bootstrap.commit" => sync_bootstrap_commit(runtime, params),
        "sync.segment.prepare" => sync_segment_prepare(runtime, params),
        "sync.segment.commit" => sync_segment_commit(runtime, params),
        "sync.stream.list" => sync_stream_list(runtime, params),
        "sync.stream.block" => sync_stream_block(runtime, params),
        "sync.segment.inspect" => sync_segment_inspect(runtime, params),
        "sync.segment.apply" => sync_segment_apply(runtime, params),
        "sync.segment.acknowledge" => sync_segment_acknowledge(runtime, params),
        "sync.blob.list" => sync_blob_list(runtime, params),
        "sync.blob.read" => sync_blob_read(runtime, params),
        "sync.blob.remote.verify" => sync_blob_remote_verify(runtime, params),
        "sync.blob.receive.begin" => sync_blob_receive_begin(runtime, params),
        "sync.blob.receive.chunk" => sync_blob_receive_chunk(runtime, params),
        "sync.blob.receive.abort" => sync_blob_receive_abort(runtime, params),
        _ => Err(RpcFailure::new(
            "method-unsupported",
            "Native synchronization method is not supported.",
            false,
        )),
    }
}

fn transfer_read(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "transfer.read params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let file_handle = take_uuid(&mut params, "fileHandle")?;
    let offset = take_u64(&mut params, "offset")?;
    let max_bytes = take_u32(&mut params, "maxBytes")?;
    if max_bytes == 0 || max_bytes as usize > MAX_BINARY_CHUNK_BYTES {
        return Err(RpcFailure::invalid(
            "transfer.read maxBytes exceeds the reviewed chunk limit.",
        ));
    }
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let state = load_bound_state(runtime, &access, &vault)?;
    let (purpose, size_bytes, sha256) = pending_output_descriptor(&state, &file_handle)?;
    if offset >= size_bytes {
        return Err(RpcFailure::invalid(
            "transfer.read offset must be below the file size.",
        ));
    }
    let path = output_path(runtime, &file_handle);
    ensure_regular_file(&path, &runtime.root.join("sync").join("outbound"))?;
    let actual_size = path
        .metadata()
        .map_err(|_| RpcFailure::storage("Native output metadata is unavailable."))?
        .len();
    if actual_size != size_bytes {
        return Err(RpcFailure::new(
            "sync-output-corrupt",
            "Native synchronization output size changed unexpectedly.",
            false,
        ));
    }
    let remaining = size_bytes - offset;
    let count = remaining.min(max_bytes as u64) as usize;
    let mut bytes = Zeroizing::new(vec![0_u8; count]);
    let mut file = File::open(&path)
        .map_err(|_| RpcFailure::storage("Native synchronization output is unavailable."))?;
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(bytes.as_mut_slice()))
        .map_err(|_| RpcFailure::storage("Native synchronization output could not be read."))?;
    let next_offset = offset + count as u64;
    Ok(json!({
        "fileHandle": file_handle,
        "purpose": purpose,
        "sizeBytes": size_bytes,
        "sha256": sha256,
        "offset": offset,
        "dataBase64": BASE64.encode(bytes.as_slice()),
        "nextOffset": next_offset,
        "eof": next_offset == size_bytes
    }))
}

fn transfer_release(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "transfer.release params must be an object.")?;
    let file_handle = take_uuid(&mut params, "fileHandle")?;
    reject_unknown(params)?;
    let candidates = [
        runtime
            .root
            .join("imports")
            .join(format!("{file_handle}.mdbx")),
        runtime.sync_inbound_segment_path(&file_handle),
    ];
    let mut released = false;
    for path in candidates {
        if path.exists() {
            ensure_regular_file(
                &path,
                path.parent()
                    .ok_or_else(|| RpcFailure::storage("Native file parent is unavailable."))?,
            )?;
            fs::remove_file(path)
                .map_err(|_| RpcFailure::storage("Native file handle could not be released."))?;
            released = true;
        }
    }
    Ok(json!({ "released": released }))
}

fn sync_state_register(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.state.register params must be an object.")?;
    let vault_handle = take_uuid(&mut params, "vaultHandle")?;
    let state_handle = take_optional_uuid(&mut params, "stateHandle")?;
    let remote_binding = take_sha256(&mut params, "remoteBinding")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&vault_handle)?;
    let info = vault.info();
    let checkpoint = checkpoint_from_ffi(vault.incremental_sync_checkpoint().map_err(|_| {
        sync_core_error(
            "sync-checkpoint-failed",
            "MDBX2 checkpoint could not be read.",
        )
    })?)?;
    let mut state = match state_handle {
        Some(state_handle) => {
            let access = StateAccess {
                vault_handle: vault_handle.clone(),
                state_handle,
                remote_binding: remote_binding.clone(),
            };
            load_bound_state(runtime, &access, &vault)?
        }
        None => new_state(
            &vault_handle,
            &remote_binding,
            &info.vault_id,
            &info.device_id,
        ),
    };
    if state.pending_bootstrap.is_some()
        || state.pending_segment.is_some()
        || state.pending_remote_segment.is_some()
        || !state.blob_transfers.is_empty()
    {
        return Err(RpcFailure::new(
            "sync-state-busy",
            "MDBX2 synchronization state has a pending operation.",
            true,
        ));
    }
    state.bootstrap_checkpoint = Some(checkpoint.clone());
    state.export_checkpoint = Some(checkpoint);
    persist_mutated_state(runtime, &mut state)?;
    sync_status_json(&state, &vault)
}

fn sync_state_status(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.state.status params must be an object.")?;
    let access = take_state_access(&mut params)?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let state = load_bound_state(runtime, &access, &vault)?;
    sync_status_json(&state, &vault)
}

fn sync_bootstrap_prepare(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.bootstrap.prepare params must be an object.")?;
    let vault_handle = take_uuid(&mut params, "vaultHandle")?;
    let state_handle = take_optional_uuid(&mut params, "stateHandle")?;
    let remote_binding = take_sha256(&mut params, "remoteBinding")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&vault_handle)?;
    let info = vault.info();
    let mut state = match state_handle {
        Some(state_handle) => {
            let access = StateAccess {
                vault_handle: vault_handle.clone(),
                state_handle,
                remote_binding: remote_binding.clone(),
            };
            load_bound_state(runtime, &access, &vault)?
        }
        None => new_state(
            &vault_handle,
            &remote_binding,
            &info.vault_id,
            &info.device_id,
        ),
    };
    if initialized(&state) {
        return Err(RpcFailure::new(
            "sync-bootstrap-already-registered",
            "MDBX2 bootstrap is already registered for this synchronization state.",
            false,
        ));
    }
    if let Some(pending) = state.pending_bootstrap.as_ref() {
        verify_pending_output(
            runtime,
            &pending.output_handle,
            pending.file_size_bytes,
            &pending.file_sha256,
        )?;
        return Ok(json!({
            "stateHandle": state.state_handle,
            "vaultId": state.vault_id,
            "deviceId": state.device_id,
            "file": output_descriptor_json(
                &pending.output_handle,
                "sync-bootstrap",
                pending.file_size_bytes,
                &pending.file_sha256
            )
        }));
    }
    if state.pending_segment.is_some() || state.pending_remote_segment.is_some() {
        return Err(RpcFailure::new(
            "sync-state-busy",
            "MDBX2 synchronization state has a pending operation.",
            true,
        ));
    }
    let output_handle = fresh_uuid();
    let path = output_path(runtime, &output_handle);
    let bootstrap = vault
        .create_incremental_sync_bootstrap(path_string(&path)?)
        .map_err(|_| {
            sync_core_error("sync-bootstrap-failed", "MDBX2 bootstrap creation failed.")
        })?;
    if bootstrap.backup.vault_id != state.vault_id || bootstrap.backup.file_size_bytes == 0 {
        let _ = fs::remove_file(&path);
        return Err(RpcFailure::new(
            "sync-bootstrap-invalid",
            "MDBX2 core returned an invalid bootstrap identity.",
            false,
        ));
    }
    let file_sha256 = hash_path(&path)?;
    let pending = PendingBootstrapState {
        output_handle: output_handle.clone(),
        checkpoint: checkpoint_from_ffi(bootstrap.checkpoint)?,
        file_size_bytes: bootstrap.backup.file_size_bytes,
        file_sha256: file_sha256.clone(),
    };
    state.pending_bootstrap = Some(pending.clone());
    if let Err(error) = persist_mutated_state(runtime, &mut state) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(json!({
        "stateHandle": state.state_handle,
        "vaultId": state.vault_id,
        "deviceId": state.device_id,
        "file": output_descriptor_json(
            &output_handle,
            "sync-bootstrap",
            pending.file_size_bytes,
            &file_sha256
        )
    }))
}

fn sync_bootstrap_commit(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.bootstrap.commit params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let file_handle = take_uuid(&mut params, "fileHandle")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    let pending = state.pending_bootstrap.clone().ok_or_else(|| {
        RpcFailure::new(
            "sync-bootstrap-not-pending",
            "MDBX2 bootstrap has no pending publication.",
            false,
        )
    })?;
    if pending.output_handle != file_handle {
        return Err(RpcFailure::invalid(
            "sync.bootstrap.commit fileHandle does not match the pending bootstrap.",
        ));
    }
    verify_pending_output(
        runtime,
        &file_handle,
        pending.file_size_bytes,
        &pending.file_sha256,
    )?;
    state.bootstrap_checkpoint = Some(pending.checkpoint.clone());
    state.export_checkpoint = Some(pending.checkpoint);
    state.pending_bootstrap = None;
    persist_mutated_state(runtime, &mut state)?;
    let _ = fs::remove_file(output_path(runtime, &file_handle));
    sync_status_json(&state, &vault)
}

fn sync_segment_prepare(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.segment.prepare params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let page_size = take_u32(&mut params, "pageSize")?;
    if page_size != SEGMENT_PAGE_SIZE {
        return Err(RpcFailure::invalid(
            "sync.segment.prepare pageSize must match the Android segment page size.",
        ));
    }
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    require_initialized(&state)?;
    if state.pending_remote_segment.is_some() {
        return Err(RpcFailure::new(
            "sync-remote-acknowledgement-pending",
            "MDBX2 remote segment acknowledgement is pending Blob completion.",
            true,
        ));
    }
    if let Some(pending) = state.pending_segment.as_ref() {
        verify_pending_output(
            runtime,
            &pending.output_handle,
            pending.file_size_bytes,
            &pending.file_sha256,
        )?;
        let inspected = vault
            .inspect_incremental_sync_segment(path_string(&output_path(
                runtime,
                &pending.output_handle,
            ))?)
            .map_err(|_| {
                sync_core_error(
                    "sync-segment-invalid",
                    "Pending MDBX2 segment authentication failed.",
                )
            })?;
        require_segment_matches_pending(&inspected, pending)?;
        return Ok(segment_prepare_json(&state.state_handle, pending));
    }
    let base = state.export_checkpoint.clone().ok_or_else(|| {
        RpcFailure::new(
            "sync-checkpoint-missing",
            "MDBX2 export checkpoint is unavailable.",
            false,
        )
    })?;
    let current = checkpoint_from_ffi(vault.incremental_sync_checkpoint().map_err(|_| {
        sync_core_error(
            "sync-checkpoint-failed",
            "MDBX2 checkpoint could not be read.",
        )
    })?)?;
    if current == base {
        return Ok(json!({ "hasSegment": false, "stateHandle": state.state_handle }));
    }
    let output_handle = fresh_uuid();
    let path = output_path(runtime, &output_handle);
    let segment = vault
        .export_incremental_sync_segment(
            path_string(&path)?,
            checkpoint_to_ffi(&base),
            None,
            page_size,
        )
        .map_err(|_| {
            sync_core_error("sync-segment-export-failed", "MDBX2 segment export failed.")
        })?;
    let pending = pending_segment_from_info(&segment, output_handle, hash_path(&path)?)?;
    if pending.vault_id != state.vault_id || pending.source_device_id != state.device_id {
        let _ = fs::remove_file(&path);
        return Err(RpcFailure::new(
            "sync-segment-identity-mismatch",
            "MDBX2 segment identity does not match the open vault.",
            false,
        ));
    }
    state.pending_segment = Some(pending.clone());
    if let Err(error) = persist_mutated_state(runtime, &mut state) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(segment_prepare_json(&state.state_handle, &pending))
}

fn sync_segment_commit(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.segment.commit params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let file_handle = take_uuid(&mut params, "fileHandle")?;
    let payload_sha256 = take_sha256(&mut params, "payloadSha256")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    let pending = state.pending_segment.clone().ok_or_else(|| {
        RpcFailure::new(
            "sync-segment-not-pending",
            "MDBX2 segment has no pending publication.",
            false,
        )
    })?;
    if pending.output_handle != file_handle || pending.payload_sha256 != payload_sha256 {
        return Err(RpcFailure::invalid(
            "sync.segment.commit does not match the pending segment.",
        ));
    }
    verify_pending_output(
        runtime,
        &file_handle,
        pending.file_size_bytes,
        &pending.file_sha256,
    )?;
    state.export_checkpoint = Some(pending.result);
    state.pending_segment = None;
    persist_mutated_state(runtime, &mut state)?;
    let _ = fs::remove_file(output_path(runtime, &file_handle));
    let current = checkpoint_from_ffi(vault.incremental_sync_checkpoint().map_err(|_| {
        sync_core_error(
            "sync-checkpoint-failed",
            "MDBX2 checkpoint could not be read.",
        )
    })?)?;
    Ok(json!({
        "committed": true,
        "hasMore": state.export_checkpoint.as_ref() != Some(&current)
    }))
}

fn sync_stream_list(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.stream.list params must be an object.")?;
    let access = take_state_access(&mut params)?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let state = load_bound_state(runtime, &access, &vault)?;
    let mut streams = state.remote_streams.clone();
    streams.sort_by(|left, right| left.stream_id.cmp(&right.stream_id));
    Ok(json!({
        "items": streams.iter().map(remote_stream_json).collect::<Vec<_>>()
    }))
}

fn sync_stream_block(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.stream.block params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let device_id = take_component(&mut params, "deviceId")?;
    let generation_id = take_component(&mut params, "generationId")?;
    let _sequence = take_u64(&mut params, "sequence")?;
    let _digest = take_sha256(&mut params, "digest")?;
    let reason = take_string(&mut params, "reason", MAX_REASON_BYTES, false)?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    require_initialized(&state)?;
    if state.pending_remote_segment.is_some() {
        return Err(RpcFailure::new(
            "sync-remote-acknowledgement-pending",
            "MDBX2 remote segment acknowledgement is pending Blob completion.",
            true,
        ));
    }
    let stream_id = stream_id(&device_id, &generation_id);
    let bootstrap = state.bootstrap_checkpoint.clone().ok_or_else(|| {
        RpcFailure::new(
            "sync-checkpoint-missing",
            "MDBX2 bootstrap checkpoint is unavailable.",
            false,
        )
    })?;
    let stream = upsert_blocked_stream(
        &mut state,
        &stream_id,
        &device_id,
        &generation_id,
        reason,
        bootstrap,
    )?;
    persist_mutated_state(runtime, &mut state)?;
    Ok(remote_stream_json(&stream))
}

fn sync_segment_inspect(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.segment.inspect params must be an object.")?;
    let vault_handle = take_uuid(&mut params, "vaultHandle")?;
    let file_handle = take_uuid(&mut params, "fileHandle")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&vault_handle)?;
    let path = runtime.sync_inbound_segment_path(&file_handle);
    ensure_regular_file(&path, &runtime.root.join("sync").join("incoming"))?;
    let info = vault
        .inspect_incremental_sync_segment(path_string(&path)?)
        .map_err(|_| {
            sync_core_error(
                "sync-segment-invalid",
                "MDBX2 segment authentication failed.",
            )
        })?;
    segment_info_json(&info, &file_handle, hash_path(&path)?)
}

fn sync_segment_apply(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.segment.apply params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let file_handle = take_uuid(&mut params, "fileHandle")?;
    let device_id = take_component(&mut params, "deviceId")?;
    let generation_id = take_component(&mut params, "generationId")?;
    let sequence = take_u64(&mut params, "sequence")?;
    let digest = take_sha256(&mut params, "digest")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    require_initialized(&state)?;
    let path = runtime.sync_inbound_segment_path(&file_handle);
    ensure_regular_file(&path, &runtime.root.join("sync").join("incoming"))?;
    let info = match vault.inspect_incremental_sync_segment(path_string(&path)?) {
        Ok(info) => info,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return Err(sync_core_error(
                "sync-segment-invalid",
                "MDBX2 segment authentication failed.",
            ));
        }
    };
    let info_digest = bytes_to_sha256(&info.payload_sha256)?;
    if info.vault_id != state.vault_id
        || info.source_device_id != device_id
        || info.transfer_id != generation_id
        || u64::from(info.segment_index) != sequence
        || info_digest != digest
    {
        let _ = fs::remove_file(&path);
        return Err(RpcFailure::new(
            "sync-segment-name-mismatch",
            "MDBX2 remote segment name does not match authenticated metadata.",
            false,
        ));
    }
    let stream_key = stream_id(&device_id, &generation_id);
    let existing_stream = state
        .remote_streams
        .iter()
        .find(|stream| stream.stream_id == stream_key)
        .cloned();

    if let Some(pending) = state.pending_remote_segment.as_ref() {
        if pending.stream_id != stream_key
            || pending.sequence != sequence
            || pending.digest != digest
        {
            let _ = fs::remove_file(&path);
            return Err(RpcFailure::new(
                "sync-remote-acknowledgement-pending",
                "Another MDBX2 remote segment is awaiting Blob completion.",
                true,
            ));
        }
    } else if let Some(stream) = existing_stream.as_ref() {
        if sequence < stream.next_sequence {
            let duplicate = sequence + 1 == stream.next_sequence
                && stream.last_applied_digest.as_deref() == Some(digest.as_str());
            let _ = fs::remove_file(&path);
            if duplicate {
                return Ok(segment_apply_result_json(
                    "duplicate",
                    0,
                    1,
                    0,
                    0,
                    false,
                    None,
                ));
            }
            let bootstrap = state.bootstrap_checkpoint.clone().ok_or_else(|| {
                RpcFailure::new(
                    "sync-checkpoint-missing",
                    "MDBX2 bootstrap checkpoint is unavailable.",
                    false,
                )
            })?;
            let blocked = upsert_blocked_stream(
                &mut state,
                &stream_key,
                &device_id,
                &generation_id,
                format!("conflicting digest for segment {sequence}"),
                bootstrap,
            )?;
            persist_mutated_state(runtime, &mut state)?;
            return Ok(segment_apply_result_json(
                "blocked",
                0,
                0,
                0,
                0,
                false,
                blocked.blocked_reason.as_deref(),
            ));
        }
        if sequence > stream.next_sequence {
            let _ = fs::remove_file(&path);
            let bootstrap = state.bootstrap_checkpoint.clone().ok_or_else(|| {
                RpcFailure::new(
                    "sync-checkpoint-missing",
                    "MDBX2 bootstrap checkpoint is unavailable.",
                    false,
                )
            })?;
            let blocked = upsert_blocked_stream(
                &mut state,
                &stream_key,
                &device_id,
                &generation_id,
                format!("missing segment {}", stream.next_sequence),
                bootstrap,
            )?;
            persist_mutated_state(runtime, &mut state)?;
            return Ok(segment_apply_result_json(
                "blocked",
                0,
                0,
                0,
                0,
                false,
                blocked.blocked_reason.as_deref(),
            ));
        }
    } else if sequence != 0 {
        let _ = fs::remove_file(&path);
        let bootstrap = state.bootstrap_checkpoint.clone().ok_or_else(|| {
            RpcFailure::new(
                "sync-checkpoint-missing",
                "MDBX2 bootstrap checkpoint is unavailable.",
                false,
            )
        })?;
        let blocked = upsert_blocked_stream(
            &mut state,
            &stream_key,
            &device_id,
            &generation_id,
            "missing segment 0".to_string(),
            bootstrap,
        )?;
        persist_mutated_state(runtime, &mut state)?;
        return Ok(segment_apply_result_json(
            "blocked",
            0,
            0,
            0,
            0,
            false,
            blocked.blocked_reason.as_deref(),
        ));
    }

    let (expected_base, expected_resume) =
        if let Some(pending) = state.pending_remote_segment.as_ref() {
            (
                pending.expected_base.clone(),
                pending.expected_resume.clone(),
            )
        } else if let Some(stream) = existing_stream.as_ref() {
            (stream.checkpoint.clone(), stream.resume.clone())
        } else {
            (checkpoint_from_ffi(info.base.clone())?, None)
        };
    let applied = vault
        .apply_incremental_sync_segment(
            path_string(&path)?,
            checkpoint_to_ffi(&expected_base),
            expected_resume.as_ref().map(resume_to_ffi).transpose()?,
        )
        .map_err(|_| sync_core_error("sync-segment-apply-failed", "MDBX2 segment apply failed."))?;
    let _ = fs::remove_file(&path);
    if applied.missing_parent_count > 0 {
        let bootstrap = state.bootstrap_checkpoint.clone().ok_or_else(|| {
            RpcFailure::new(
                "sync-checkpoint-missing",
                "MDBX2 bootstrap checkpoint is unavailable.",
                false,
            )
        })?;
        let reason = format!(
            "waiting for {} parent commit(s)",
            applied.missing_parent_count
        );
        let blocked = upsert_blocked_stream(
            &mut state,
            &stream_key,
            &device_id,
            &generation_id,
            reason,
            bootstrap,
        )?;
        persist_mutated_state(runtime, &mut state)?;
        return Ok(segment_apply_result_json(
            "blocked",
            applied.applied_commits,
            applied.skipped_commits,
            applied.conflict_count,
            applied.missing_parent_count,
            false,
            blocked.blocked_reason.as_deref(),
        ));
    }
    let current = checkpoint_from_ffi(vault.incremental_sync_checkpoint().map_err(|_| {
        sync_core_error(
            "sync-checkpoint-failed",
            "MDBX2 checkpoint could not be read.",
        )
    })?)?;
    state.export_checkpoint = Some(current);
    state.pending_remote_segment = Some(PendingRemoteSegmentState {
        stream_id: stream_key,
        device_id,
        generation_id,
        sequence,
        digest,
        expected_base,
        expected_resume,
        next_checkpoint: checkpoint_from_ffi(applied.result)?,
        next_resume: applied.next_resume.map(resume_from_ffi).transpose()?,
        applied_commits: applied.applied_commits,
        skipped_commits: applied.skipped_commits,
        conflict_count: applied.conflict_count,
    });
    persist_mutated_state(runtime, &mut state)?;
    Ok(segment_apply_result_json(
        "applied",
        applied.applied_commits,
        applied.skipped_commits,
        applied.conflict_count,
        0,
        true,
        None,
    ))
}

fn sync_segment_acknowledge(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.segment.acknowledge params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let device_id = take_component(&mut params, "deviceId")?;
    let generation_id = take_component(&mut params, "generationId")?;
    let sequence = take_u64(&mut params, "sequence")?;
    let digest = take_sha256(&mut params, "digest")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    let pending = state.pending_remote_segment.clone().ok_or_else(|| {
        RpcFailure::new(
            "sync-remote-acknowledgement-missing",
            "MDBX2 remote segment has no pending acknowledgement.",
            false,
        )
    })?;
    if pending.device_id != device_id
        || pending.generation_id != generation_id
        || pending.sequence != sequence
        || pending.digest != digest
    {
        return Err(RpcFailure::invalid(
            "sync.segment.acknowledge does not match the pending segment.",
        ));
    }
    let next = RemoteStreamState {
        stream_id: pending.stream_id.clone(),
        device_id: pending.device_id,
        generation_id: pending.generation_id,
        next_sequence: pending.sequence + 1,
        checkpoint: pending.next_checkpoint,
        resume: pending.next_resume,
        last_applied_digest: Some(pending.digest),
        blocked_reason: None,
    };
    replace_stream(&mut state, next.clone())?;
    state.pending_remote_segment = None;
    persist_mutated_state(runtime, &mut state)?;
    Ok(remote_stream_json(&next))
}

fn sync_blob_list(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.blob.list params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let cursor = take_optional_string(&mut params, "cursor", 64)?;
    if cursor.as_deref().is_some_and(|value| !valid_sha256(value)) {
        return Err(RpcFailure::invalid("sync.blob.list cursor is invalid."));
    }
    let page_size = take_u32(&mut params, "pageSize")?;
    if page_size == 0 || page_size > MAX_BLOB_PAGE_SIZE {
        return Err(RpcFailure::invalid(
            "sync.blob.list pageSize exceeds the reviewed limit.",
        ));
    }
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let state = load_bound_state(runtime, &access, &vault)?;
    let page = vault
        .list_external_blob_references(cursor, page_size)
        .map_err(|_| {
            sync_core_error(
                "sync-blob-list-failed",
                "MDBX2 Blob references could not be read.",
            )
        })?;
    let items =
        page.items
            .into_iter()
            .map(|item| {
                let remote_verified = item.total_size.is_some_and(|size| {
                    state.verified_remote_blobs.iter().any(|verified| {
                        verified.blob_id == item.blob_id && verified.total_size == size
                    })
                });
                json!({
                    "blobId": item.blob_id,
                    "totalSize": item.total_size,
                    "state": match item.state {
                        MdbxExternalBlobState::Available => "available",
                        MdbxExternalBlobState::Missing => "missing",
                        MdbxExternalBlobState::SizeMismatch => "size-mismatch",
                    },
                    "remoteVerified": remote_verified
                })
            })
            .collect::<Vec<_>>();
    Ok(json!({
        "rawReferenceCount": page.raw_reference_count,
        "uniqueReferenceCount": page.unique_reference_count,
        "items": items,
        "nextCursor": page.next_cursor
    }))
}

fn sync_blob_read(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.blob.read params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let blob_id = take_sha256(&mut params, "blobId")?;
    let total_size = take_remote_blob_size(&mut params)?;
    let offset = take_u64(&mut params, "offset")?;
    let max_bytes = take_u32(&mut params, "maxBytes")?;
    if max_bytes == 0 || max_bytes as usize > MAX_BINARY_CHUNK_BYTES {
        return Err(RpcFailure::invalid(
            "sync.blob.read maxBytes exceeds the Native Messaging limit.",
        ));
    }
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let _state = load_bound_state(runtime, &access, &vault)?;
    let chunk = vault
        .read_external_blob_chunk(blob_id.clone(), total_size, offset, max_bytes)
        .map_err(|_| {
            sync_core_error(
                "sync-blob-read-failed",
                "MDBX2 Blob chunk could not be read.",
            )
        })?;
    let next_offset = chunk.offset + chunk.ciphertext.len() as u64;
    Ok(json!({
        "blobId": chunk.blob_id,
        "totalSize": chunk.total_size,
        "offset": chunk.offset,
        "dataBase64": BASE64.encode(chunk.ciphertext),
        "nextOffset": next_offset,
        "isLast": chunk.is_last
    }))
}

fn sync_blob_remote_verify(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.blob.remote.verify params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let blob_id = take_sha256(&mut params, "blobId")?;
    let total_size = take_remote_blob_size(&mut params)?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    if !vault
        .has_external_blob(blob_id.clone(), total_size)
        .map_err(|_| {
            sync_core_error(
                "sync-blob-check-failed",
                "MDBX2 Blob state could not be checked.",
            )
        })?
    {
        return Err(RpcFailure::new(
            "sync-blob-unavailable",
            "MDBX2 Blob is unavailable or has an unexpected size.",
            false,
        ));
    }
    mark_remote_blob_verified(&mut state, blob_id.clone(), total_size)?;
    persist_mutated_state(runtime, &mut state)?;
    Ok(json!({ "blobId": blob_id, "totalSize": total_size, "remoteVerified": true }))
}

fn sync_blob_receive_begin(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.blob.receive.begin params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let blob_id = take_sha256(&mut params, "blobId")?;
    let total_size = take_remote_blob_size(&mut params)?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    if vault
        .has_external_blob(blob_id.clone(), total_size)
        .map_err(|_| {
            sync_core_error(
                "sync-blob-check-failed",
                "MDBX2 Blob state could not be checked.",
            )
        })?
    {
        state
            .blob_transfers
            .retain(|transfer| transfer.blob_id != blob_id);
        mark_remote_blob_verified(&mut state, blob_id.clone(), total_size)?;
        persist_mutated_state(runtime, &mut state)?;
        return Ok(blob_receive_json(&blob_id, total_size, total_size, true));
    }
    let now = unix_seconds()?;
    if let Some(existing) = state
        .blob_transfers
        .iter_mut()
        .find(|transfer| transfer.blob_id == blob_id)
    {
        if existing.total_size != total_size {
            return Err(RpcFailure::new(
                "sync-blob-transfer-mismatch",
                "MDBX2 Blob transfer size changed during resume.",
                false,
            ));
        }
        let lease = vault
            .acquire_external_blob_lease(
                blob_id.clone(),
                existing.owner_id.clone(),
                now,
                BLOB_LEASE_TTL_SECONDS,
            )
            .map_err(|_| {
                sync_core_error(
                    "sync-blob-lease-failed",
                    "MDBX2 Blob lease could not be acquired.",
                )
            })?;
        existing.lease_expires_at_unix_secs = lease.expires_at_unix_secs;
        let next_offset = existing.next_offset;
        persist_mutated_state(runtime, &mut state)?;
        return Ok(blob_receive_json(&blob_id, total_size, next_offset, false));
    }
    if state.blob_transfers.len() >= MAX_BLOB_TRANSFERS {
        return Err(RpcFailure::new(
            "sync-blob-transfer-limit",
            "MDBX2 has too many active Blob transfers.",
            true,
        ));
    }
    let owner_id = fresh_uuid();
    let lease = vault
        .acquire_external_blob_lease(
            blob_id.clone(),
            owner_id.clone(),
            now,
            BLOB_LEASE_TTL_SECONDS,
        )
        .map_err(|_| {
            sync_core_error(
                "sync-blob-lease-failed",
                "MDBX2 Blob lease could not be acquired.",
            )
        })?;
    state.blob_transfers.push(BlobTransferState {
        blob_id: blob_id.clone(),
        total_size,
        owner_id,
        next_offset: 0,
        lease_expires_at_unix_secs: lease.expires_at_unix_secs,
    });
    state
        .blob_transfers
        .sort_by(|left, right| left.blob_id.cmp(&right.blob_id));
    persist_mutated_state(runtime, &mut state)?;
    Ok(blob_receive_json(&blob_id, total_size, 0, false))
}

fn sync_blob_receive_chunk(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.blob.receive.chunk params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let blob_id = take_sha256(&mut params, "blobId")?;
    let total_size = take_remote_blob_size(&mut params)?;
    let offset = take_u64(&mut params, "offset")?;
    let encoded = Zeroizing::new(take_string(
        &mut params,
        "dataBase64",
        MAX_BASE64_CHUNK_BYTES,
        false,
    )?);
    let finalize = take_bool(&mut params, "finalize")?;
    reject_unknown(params)?;
    let bytes = Zeroizing::new(
        BASE64
            .decode(encoded.as_bytes())
            .map_err(|_| RpcFailure::invalid("sync.blob.receive.chunk dataBase64 is invalid."))?,
    );
    if bytes.is_empty() || bytes.len() > MAX_BINARY_CHUNK_BYTES {
        return Err(RpcFailure::invalid(
            "sync.blob.receive.chunk exceeds the Native Messaging limit.",
        ));
    }
    let end = offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| RpcFailure::invalid("sync.blob.receive.chunk offset overflowed."))?;
    if end > total_size || finalize != (end == total_size) {
        return Err(RpcFailure::invalid(
            "sync.blob.receive.chunk boundary is invalid.",
        ));
    }
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    let index = state
        .blob_transfers
        .iter()
        .position(|transfer| transfer.blob_id == blob_id)
        .ok_or_else(|| {
            RpcFailure::new(
                "sync-blob-transfer-missing",
                "MDBX2 Blob receive transfer is not active.",
                false,
            )
        })?;
    let transfer = state.blob_transfers[index].clone();
    if transfer.total_size != total_size || offset > transfer.next_offset {
        return Err(RpcFailure::new(
            "sync-blob-offset-mismatch",
            "MDBX2 Blob chunk does not start at the durable offset.",
            true,
        ));
    }
    if offset < transfer.next_offset && end > transfer.next_offset {
        return Err(RpcFailure::new(
            "sync-blob-offset-mismatch",
            "MDBX2 Blob chunk overlaps the durable offset.",
            true,
        ));
    }
    let now = unix_seconds()?;
    let lease = vault
        .acquire_external_blob_lease(
            blob_id.clone(),
            transfer.owner_id.clone(),
            now,
            BLOB_LEASE_TTL_SECONDS,
        )
        .map_err(|_| {
            sync_core_error(
                "sync-blob-lease-failed",
                "MDBX2 Blob lease could not be renewed.",
            )
        })?;
    vault
        .write_external_blob_chunk(
            blob_id.clone(),
            total_size,
            offset,
            bytes.to_vec(),
            finalize,
        )
        .map_err(|_| {
            sync_core_error(
                "sync-blob-write-failed",
                "MDBX2 Blob chunk could not be written.",
            )
        })?;
    let next_offset = transfer.next_offset.max(end);
    if finalize {
        if !vault
            .has_external_blob(blob_id.clone(), total_size)
            .map_err(|_| {
                sync_core_error(
                    "sync-blob-check-failed",
                    "MDBX2 Blob final state could not be checked.",
                )
            })?
        {
            return Err(RpcFailure::new(
                "sync-blob-finalize-failed",
                "MDBX2 Blob transfer did not finalize.",
                false,
            ));
        }
        vault
            .release_external_blob_lease(blob_id.clone(), transfer.owner_id)
            .map_err(|_| {
                sync_core_error(
                    "sync-blob-lease-release-failed",
                    "MDBX2 Blob lease could not be released.",
                )
            })?;
        state.blob_transfers.remove(index);
        mark_remote_blob_verified(&mut state, blob_id.clone(), total_size)?;
    } else {
        state.blob_transfers[index].next_offset = next_offset;
        state.blob_transfers[index].lease_expires_at_unix_secs = lease.expires_at_unix_secs;
    }
    persist_mutated_state(runtime, &mut state)?;
    Ok(blob_receive_json(
        &blob_id,
        total_size,
        next_offset,
        finalize,
    ))
}

fn sync_blob_receive_abort(runtime: &HostRuntime, params: Value) -> Result<Value, RpcFailure> {
    let mut params = take_object(params, "sync.blob.receive.abort params must be an object.")?;
    let access = take_state_access(&mut params)?;
    let blob_id = take_sha256(&mut params, "blobId")?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&access.vault_handle)?;
    let mut state = load_bound_state(runtime, &access, &vault)?;
    let Some(index) = state
        .blob_transfers
        .iter()
        .position(|transfer| transfer.blob_id == blob_id)
    else {
        return Ok(json!({ "aborted": false }));
    };
    let transfer = state.blob_transfers[index].clone();
    vault
        .abort_external_blob_transfer(blob_id, transfer.owner_id)
        .map_err(|_| {
            sync_core_error(
                "sync-blob-abort-failed",
                "MDBX2 Blob transfer could not be aborted.",
            )
        })?;
    state.blob_transfers.remove(index);
    persist_mutated_state(runtime, &mut state)?;
    Ok(json!({ "aborted": true }))
}

fn new_state(
    vault_handle: &str,
    remote_binding: &str,
    vault_id: &str,
    device_id: &str,
) -> SyncState {
    SyncState {
        version: SYNC_STATE_VERSION,
        revision: 0,
        state_handle: fresh_uuid(),
        vault_handle: vault_handle.to_string(),
        remote_binding: remote_binding.to_string(),
        vault_id: vault_id.to_string(),
        device_id: device_id.to_string(),
        bootstrap_checkpoint: None,
        export_checkpoint: None,
        pending_bootstrap: None,
        pending_segment: None,
        pending_remote_segment: None,
        remote_streams: Vec::new(),
        blob_transfers: Vec::new(),
        verified_remote_blobs: Vec::new(),
    }
}

fn initialized(state: &SyncState) -> bool {
    state.bootstrap_checkpoint.is_some() && state.export_checkpoint.is_some()
}

fn require_initialized(state: &SyncState) -> Result<(), RpcFailure> {
    if initialized(state) {
        Ok(())
    } else {
        Err(RpcFailure::new(
            "sync-bootstrap-required",
            "MDBX2 synchronization state has no registered bootstrap.",
            false,
        ))
    }
}

fn sync_status_json(state: &SyncState, vault: &Arc<MdbxVault>) -> Result<Value, RpcFailure> {
    let current = checkpoint_from_ffi(vault.incremental_sync_checkpoint().map_err(|_| {
        sync_core_error(
            "sync-checkpoint-failed",
            "MDBX2 checkpoint could not be read.",
        )
    })?)?;
    Ok(json!({
        "stateHandle": state.state_handle,
        "vaultHandle": state.vault_handle,
        "vaultId": state.vault_id,
        "deviceId": state.device_id,
        "initialized": initialized(state),
        "hasLocalChanges": state.export_checkpoint.as_ref().is_some_and(|checkpoint| checkpoint != &current)
            || state.pending_segment.is_some(),
        "pendingBootstrap": state.pending_bootstrap.is_some(),
        "pendingSegment": state.pending_segment.is_some(),
        "pendingRemoteAcknowledgement": state.pending_remote_segment.is_some(),
        "remoteStreamCount": state.remote_streams.len(),
        "blockedStreamCount": state.remote_streams.iter().filter(|stream| stream.blocked_reason.is_some()).count(),
        "blobTransferCount": state.blob_transfers.len(),
        "verifiedRemoteBlobCount": state.verified_remote_blobs.len()
    }))
}

fn load_bound_state(
    runtime: &HostRuntime,
    access: &StateAccess,
    vault: &Arc<MdbxVault>,
) -> Result<SyncState, RpcFailure> {
    let state = load_state(runtime, &access.state_handle)?;
    let info = vault.info();
    if state.vault_handle != access.vault_handle
        || state.remote_binding != access.remote_binding
        || state.vault_id != info.vault_id
        || state.device_id != info.device_id
    {
        return Err(RpcFailure::new(
            "sync-state-binding-mismatch",
            "MDBX2 synchronization state does not belong to this vault and remote.",
            false,
        ));
    }
    Ok(state)
}

fn load_state(runtime: &HostRuntime, state_handle: &str) -> Result<SyncState, RpcFailure> {
    let mut candidates = Vec::new();
    for slot in [0_u64, 1_u64] {
        let path = state_path(runtime, state_handle, slot);
        if !path.exists() {
            continue;
        }
        let Ok(bytes) = read_bounded(&path, MAX_SYNC_STATE_BYTES) else {
            continue;
        };
        let Ok(state) = serde_json::from_slice::<SyncState>(&bytes) else {
            continue;
        };
        if state.state_handle != state_handle || state.revision % 2 != slot {
            continue;
        }
        if validate_state(&state).is_ok() {
            candidates.push(state);
        }
    }
    candidates
        .into_iter()
        .max_by_key(|state| state.revision)
        .ok_or_else(|| {
            RpcFailure::new(
                "sync-state-not-found",
                "MDBX2 synchronization state is unavailable or invalid.",
                false,
            )
        })
}

fn persist_mutated_state(runtime: &HostRuntime, state: &mut SyncState) -> Result<(), RpcFailure> {
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| RpcFailure::storage("MDBX2 synchronization state revision overflowed."))?;
    persist_state(runtime, state)
}

fn persist_state(runtime: &HostRuntime, state: &SyncState) -> Result<(), RpcFailure> {
    validate_state(state)?;
    let bytes = serde_json::to_vec(state)
        .map_err(|_| RpcFailure::storage("MDBX2 synchronization state could not be encoded."))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_SYNC_STATE_BYTES {
        return Err(RpcFailure::new(
            "sync-state-too-large",
            "MDBX2 synchronization state exceeds the reviewed limit.",
            false,
        ));
    }
    let path = state_path(runtime, &state.state_handle, state.revision % 2);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|_| RpcFailure::storage("MDBX2 synchronization state could not be opened."))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| RpcFailure::storage("MDBX2 synchronization state could not be persisted."))
}

fn validate_state(state: &SyncState) -> Result<(), RpcFailure> {
    if state.version != SYNC_STATE_VERSION
        || canonical_uuid(&state.state_handle).as_deref() != Some(state.state_handle.as_str())
        || canonical_uuid(&state.vault_handle).as_deref() != Some(state.vault_handle.as_str())
        || !valid_sha256(&state.remote_binding)
        || state.vault_id.is_empty()
        || state.vault_id.len() > 128
        || state.device_id.is_empty()
        || state.device_id.len() > 128
        || state.bootstrap_checkpoint.is_some() != state.export_checkpoint.is_some()
        || state.remote_streams.len() > MAX_REMOTE_STREAMS
        || state.blob_transfers.len() > MAX_BLOB_TRANSFERS
        || state.verified_remote_blobs.len() > MAX_VERIFIED_REMOTE_BLOBS
    {
        return Err(RpcFailure::new(
            "sync-state-invalid",
            "MDBX2 synchronization state failed validation.",
            false,
        ));
    }
    if let Some(checkpoint) = state.bootstrap_checkpoint.as_ref() {
        validate_checkpoint(checkpoint)?;
    }
    if let Some(checkpoint) = state.export_checkpoint.as_ref() {
        validate_checkpoint(checkpoint)?;
    }
    if state.pending_bootstrap.is_some() && initialized(state) {
        return Err(RpcFailure::new(
            "sync-state-invalid",
            "MDBX2 synchronization state has an invalid bootstrap transition.",
            false,
        ));
    }
    if (state.pending_segment.is_some()
        || state.pending_remote_segment.is_some()
        || !state.remote_streams.is_empty()
        || !state.blob_transfers.is_empty())
        && !initialized(state)
    {
        return Err(RpcFailure::new(
            "sync-state-invalid",
            "MDBX2 synchronization state requires a registered bootstrap.",
            false,
        ));
    }
    let mut stream_ids = HashSet::new();
    for stream in &state.remote_streams {
        validate_stream(stream)?;
        if !stream_ids.insert(stream.stream_id.as_str()) {
            return Err(RpcFailure::new(
                "sync-state-invalid",
                "MDBX2 synchronization state contains duplicate streams.",
                false,
            ));
        }
    }
    let mut transfer_ids = HashSet::new();
    for transfer in &state.blob_transfers {
        if !valid_sha256(&transfer.blob_id)
            || transfer.total_size == 0
            || transfer.total_size > MAX_REMOTE_BLOB_BYTES
            || transfer.next_offset > transfer.total_size
            || canonical_uuid(&transfer.owner_id).as_deref() != Some(transfer.owner_id.as_str())
            || !transfer_ids.insert(transfer.blob_id.as_str())
        {
            return Err(RpcFailure::new(
                "sync-state-invalid",
                "MDBX2 Blob transfer state is invalid.",
                false,
            ));
        }
    }
    let mut blob_ids = HashSet::new();
    for blob in &state.verified_remote_blobs {
        if !valid_sha256(&blob.blob_id)
            || blob.total_size == 0
            || blob.total_size > MAX_REMOTE_BLOB_BYTES
            || !blob_ids.insert(blob.blob_id.as_str())
        {
            return Err(RpcFailure::new(
                "sync-state-invalid",
                "MDBX2 verified Blob state is invalid.",
                false,
            ));
        }
    }
    if let Some(pending) = state.pending_bootstrap.as_ref() {
        validate_output(
            &pending.output_handle,
            pending.file_size_bytes,
            &pending.file_sha256,
        )?;
        validate_checkpoint(&pending.checkpoint)?;
    }
    if let Some(pending) = state.pending_segment.as_ref() {
        validate_pending_segment(pending)?;
    }
    if let Some(pending) = state.pending_remote_segment.as_ref() {
        validate_pending_remote(pending)?;
    }
    Ok(())
}

fn validate_checkpoint(checkpoint: &SyncCheckpointState) -> Result<(), RpcFailure> {
    if checkpoint.commit_inventory.is_empty()
        || checkpoint.commit_inventory.len() > MAX_CHECKPOINT_TOKEN_BYTES
        || checkpoint.delta_inventory.is_empty()
        || checkpoint.delta_inventory.len() > MAX_CHECKPOINT_TOKEN_BYTES
    {
        return Err(RpcFailure::new(
            "sync-checkpoint-invalid",
            "MDBX2 synchronization checkpoint is invalid.",
            false,
        ));
    }
    Ok(())
}

fn validate_resume(resume: &SyncResumeState) -> Result<(), RpcFailure> {
    if resume.transfer_id.is_empty()
        || resume.transfer_id.len() > MAX_COMPONENT_BYTES
        || resume.next_segment_index == 0
        || !valid_sha256(&resume.previous_segment_sha256)
    {
        return Err(RpcFailure::new(
            "sync-resume-invalid",
            "MDBX2 synchronization resume state is invalid.",
            false,
        ));
    }
    Ok(())
}

fn validate_output(handle: &str, size: u64, sha256: &str) -> Result<(), RpcFailure> {
    if canonical_uuid(handle).as_deref() != Some(handle)
        || size == 0
        || size > MAX_INBOUND_FILE_BYTES
        || !valid_sha256(sha256)
    {
        return Err(RpcFailure::new(
            "sync-output-invalid",
            "MDBX2 synchronization output metadata is invalid.",
            false,
        ));
    }
    Ok(())
}

fn validate_pending_segment(pending: &PendingSegmentState) -> Result<(), RpcFailure> {
    validate_output(
        &pending.output_handle,
        pending.file_size_bytes,
        &pending.file_sha256,
    )?;
    validate_checkpoint(&pending.base)?;
    validate_checkpoint(&pending.result)?;
    if let Some(resume) = pending.next_resume.as_ref() {
        validate_resume(resume)?;
    }
    if pending.vault_id.is_empty()
        || pending.vault_id.len() > 128
        || pending.source_device_id.is_empty()
        || pending.source_device_id.len() > 128
        || pending.transfer_id.is_empty()
        || pending.transfer_id.len() > MAX_COMPONENT_BYTES
        || !valid_sha256(&pending.payload_sha256)
    {
        return Err(RpcFailure::new(
            "sync-segment-invalid",
            "MDBX2 pending segment metadata is invalid.",
            false,
        ));
    }
    Ok(())
}

fn validate_pending_remote(pending: &PendingRemoteSegmentState) -> Result<(), RpcFailure> {
    validate_checkpoint(&pending.expected_base)?;
    validate_checkpoint(&pending.next_checkpoint)?;
    if let Some(resume) = pending.expected_resume.as_ref() {
        validate_resume(resume)?;
    }
    if let Some(resume) = pending.next_resume.as_ref() {
        validate_resume(resume)?;
    }
    if pending.stream_id != stream_id(&pending.device_id, &pending.generation_id)
        || !valid_component(&pending.device_id)
        || !valid_component(&pending.generation_id)
        || !valid_sha256(&pending.digest)
    {
        return Err(RpcFailure::new(
            "sync-segment-invalid",
            "MDBX2 pending remote segment state is invalid.",
            false,
        ));
    }
    Ok(())
}

fn validate_stream(stream: &RemoteStreamState) -> Result<(), RpcFailure> {
    validate_checkpoint(&stream.checkpoint)?;
    if let Some(resume) = stream.resume.as_ref() {
        validate_resume(resume)?;
    }
    if stream.stream_id != stream_id(&stream.device_id, &stream.generation_id)
        || !valid_component(&stream.device_id)
        || !valid_component(&stream.generation_id)
        || stream
            .last_applied_digest
            .as_deref()
            .is_some_and(|digest| !valid_sha256(digest))
        || stream
            .blocked_reason
            .as_deref()
            .is_some_and(|reason| reason.is_empty() || reason.len() > MAX_REASON_BYTES)
    {
        return Err(RpcFailure::new(
            "sync-stream-invalid",
            "MDBX2 remote stream state is invalid.",
            false,
        ));
    }
    Ok(())
}

fn state_path(runtime: &HostRuntime, state_handle: &str, slot: u64) -> PathBuf {
    runtime
        .root
        .join("sync")
        .join("states")
        .join(format!("{state_handle}.state.{slot}.json"))
}

fn output_path(runtime: &HostRuntime, file_handle: &str) -> PathBuf {
    runtime
        .root
        .join("sync")
        .join("outbound")
        .join(format!("{file_handle}.bin"))
}

fn pending_output_descriptor<'a>(
    state: &'a SyncState,
    file_handle: &str,
) -> Result<(&'static str, u64, &'a str), RpcFailure> {
    if let Some(pending) = state
        .pending_bootstrap
        .as_ref()
        .filter(|pending| pending.output_handle == file_handle)
    {
        return Ok((
            "sync-bootstrap",
            pending.file_size_bytes,
            pending.file_sha256.as_str(),
        ));
    }
    if let Some(pending) = state
        .pending_segment
        .as_ref()
        .filter(|pending| pending.output_handle == file_handle)
    {
        return Ok((
            "sync-segment",
            pending.file_size_bytes,
            pending.file_sha256.as_str(),
        ));
    }
    Err(RpcFailure::new(
        "sync-output-not-found",
        "Native synchronization output handle is not pending.",
        false,
    ))
}

fn verify_pending_output(
    runtime: &HostRuntime,
    handle: &str,
    size: u64,
    sha256: &str,
) -> Result<(), RpcFailure> {
    validate_output(handle, size, sha256)?;
    let path = output_path(runtime, handle);
    ensure_regular_file(&path, &runtime.root.join("sync").join("outbound"))?;
    if path
        .metadata()
        .map_err(|_| RpcFailure::storage("Native synchronization output metadata is unavailable."))?
        .len()
        != size
        || hash_path(&path)? != sha256
    {
        return Err(RpcFailure::new(
            "sync-output-corrupt",
            "Native synchronization output failed integrity verification.",
            false,
        ));
    }
    Ok(())
}

fn pending_segment_from_info(
    info: &MdbxIncrementalSyncSegmentInfo,
    output_handle: String,
    file_sha256: String,
) -> Result<PendingSegmentState, RpcFailure> {
    Ok(PendingSegmentState {
        output_handle,
        vault_id: info.vault_id.clone(),
        source_device_id: info.source_device_id.clone(),
        transfer_id: info.transfer_id.clone(),
        segment_index: info.segment_index,
        is_last: info.is_last,
        base: checkpoint_from_ffi(info.base.clone())?,
        result: checkpoint_from_ffi(info.result.clone())?,
        next_resume: info.next_resume.clone().map(resume_from_ffi).transpose()?,
        commit_count: info.commit_count,
        delta_count: info.delta_count,
        payload_sha256: bytes_to_sha256(&info.payload_sha256)?,
        file_size_bytes: info.file_size_bytes,
        file_sha256,
    })
}

fn require_segment_matches_pending(
    info: &MdbxIncrementalSyncSegmentInfo,
    pending: &PendingSegmentState,
) -> Result<(), RpcFailure> {
    let actual = pending_segment_from_info(
        info,
        pending.output_handle.clone(),
        pending.file_sha256.clone(),
    )?;
    if &actual == pending {
        Ok(())
    } else {
        Err(RpcFailure::new(
            "sync-segment-invalid",
            "Pending MDBX2 segment metadata changed unexpectedly.",
            false,
        ))
    }
}

fn segment_prepare_json(state_handle: &str, pending: &PendingSegmentState) -> Value {
    json!({
        "hasSegment": true,
        "stateHandle": state_handle,
        "file": output_descriptor_json(
            &pending.output_handle,
            "sync-segment",
            pending.file_size_bytes,
            &pending.file_sha256
        ),
        "vaultId": pending.vault_id,
        "sourceDeviceId": pending.source_device_id,
        "transferId": pending.transfer_id,
        "segmentIndex": pending.segment_index,
        "isLast": pending.is_last,
        "commitCount": pending.commit_count,
        "deltaCount": pending.delta_count,
        "payloadSha256": pending.payload_sha256
    })
}

fn segment_info_json(
    info: &MdbxIncrementalSyncSegmentInfo,
    file_handle: &str,
    file_sha256: String,
) -> Result<Value, RpcFailure> {
    Ok(json!({
        "file": output_descriptor_json(file_handle, "sync-segment", info.file_size_bytes, &file_sha256),
        "vaultId": info.vault_id,
        "sourceDeviceId": info.source_device_id,
        "transferId": info.transfer_id,
        "segmentIndex": info.segment_index,
        "isLast": info.is_last,
        "commitCount": info.commit_count,
        "deltaCount": info.delta_count,
        "payloadSha256": bytes_to_sha256(&info.payload_sha256)?
    }))
}

fn output_descriptor_json(
    file_handle: &str,
    purpose: &'static str,
    size_bytes: u64,
    sha256: &str,
) -> Value {
    json!({
        "fileHandle": file_handle,
        "purpose": purpose,
        "sizeBytes": size_bytes,
        "sha256": sha256
    })
}

fn segment_apply_result_json(
    status: &'static str,
    applied_commits: u32,
    skipped_commits: u32,
    conflict_count: u32,
    missing_parent_count: u32,
    pending_acknowledgement: bool,
    blocked_reason: Option<&str>,
) -> Value {
    json!({
        "status": status,
        "appliedCommits": applied_commits,
        "skippedCommits": skipped_commits,
        "conflictCount": conflict_count,
        "missingParentCount": missing_parent_count,
        "pendingAcknowledgement": pending_acknowledgement,
        "blockedReason": blocked_reason
    })
}

fn remote_stream_json(stream: &RemoteStreamState) -> Value {
    json!({
        "streamId": stream.stream_id,
        "deviceId": stream.device_id,
        "generationId": stream.generation_id,
        "nextSequence": stream.next_sequence,
        "lastAppliedDigest": stream.last_applied_digest,
        "blockedReason": stream.blocked_reason
    })
}

fn blob_receive_json(blob_id: &str, total_size: u64, next_offset: u64, complete: bool) -> Value {
    json!({
        "blobId": blob_id,
        "totalSize": total_size,
        "nextOffset": next_offset,
        "complete": complete
    })
}

fn upsert_blocked_stream(
    state: &mut SyncState,
    stream_key: &str,
    device_id: &str,
    generation_id: &str,
    reason: String,
    bootstrap: SyncCheckpointState,
) -> Result<RemoteStreamState, RpcFailure> {
    let mut stream = state
        .remote_streams
        .iter()
        .find(|stream| stream.stream_id == stream_key)
        .cloned()
        .unwrap_or(RemoteStreamState {
            stream_id: stream_key.to_string(),
            device_id: device_id.to_string(),
            generation_id: generation_id.to_string(),
            next_sequence: 0,
            checkpoint: bootstrap,
            resume: None,
            last_applied_digest: None,
            blocked_reason: None,
        });
    stream.blocked_reason = Some(reason);
    replace_stream(state, stream.clone())?;
    Ok(stream)
}

fn replace_stream(state: &mut SyncState, stream: RemoteStreamState) -> Result<(), RpcFailure> {
    validate_stream(&stream)?;
    if !state
        .remote_streams
        .iter()
        .any(|candidate| candidate.stream_id == stream.stream_id)
        && state.remote_streams.len() >= MAX_REMOTE_STREAMS
    {
        return Err(RpcFailure::new(
            "sync-stream-limit",
            "MDBX2 remote stream count exceeds the reviewed limit.",
            false,
        ));
    }
    state
        .remote_streams
        .retain(|candidate| candidate.stream_id != stream.stream_id);
    state.remote_streams.push(stream);
    state
        .remote_streams
        .sort_by(|left, right| left.stream_id.cmp(&right.stream_id));
    Ok(())
}

fn mark_remote_blob_verified(
    state: &mut SyncState,
    blob_id: String,
    total_size: u64,
) -> Result<(), RpcFailure> {
    state
        .verified_remote_blobs
        .retain(|blob| blob.blob_id != blob_id);
    if state.verified_remote_blobs.len() >= MAX_VERIFIED_REMOTE_BLOBS {
        return Err(RpcFailure::new(
            "sync-blob-cache-limit",
            "MDBX2 verified remote Blob cache exceeds the reviewed limit.",
            false,
        ));
    }
    state.verified_remote_blobs.push(VerifiedRemoteBlobState {
        blob_id,
        total_size,
    });
    state
        .verified_remote_blobs
        .sort_by(|left, right| left.blob_id.cmp(&right.blob_id));
    Ok(())
}

fn checkpoint_from_ffi(
    checkpoint: MdbxIncrementalSyncCheckpoint,
) -> Result<SyncCheckpointState, RpcFailure> {
    let state = SyncCheckpointState {
        commit_inventory: checkpoint.commit_inventory,
        delta_inventory: checkpoint.delta_inventory,
    };
    validate_checkpoint(&state)?;
    Ok(state)
}

fn checkpoint_to_ffi(checkpoint: &SyncCheckpointState) -> MdbxIncrementalSyncCheckpoint {
    MdbxIncrementalSyncCheckpoint {
        commit_inventory: checkpoint.commit_inventory.clone(),
        delta_inventory: checkpoint.delta_inventory.clone(),
    }
}

fn resume_from_ffi(resume: MdbxIncrementalSyncResume) -> Result<SyncResumeState, RpcFailure> {
    let state = SyncResumeState {
        transfer_id: resume.transfer_id,
        next_segment_index: resume.next_segment_index,
        previous_segment_sha256: bytes_to_sha256(&resume.previous_segment_sha256)?,
    };
    validate_resume(&state)?;
    Ok(state)
}

fn resume_to_ffi(resume: &SyncResumeState) -> Result<MdbxIncrementalSyncResume, RpcFailure> {
    validate_resume(resume)?;
    Ok(MdbxIncrementalSyncResume {
        transfer_id: resume.transfer_id.clone(),
        next_segment_index: resume.next_segment_index,
        previous_segment_sha256: sha256_to_bytes(&resume.previous_segment_sha256)?,
    })
}

fn bytes_to_sha256(bytes: &[u8]) -> Result<String, RpcFailure> {
    if bytes.len() != 32 {
        return Err(RpcFailure::new(
            "sync-digest-invalid",
            "MDBX2 core returned an invalid SHA-256 digest.",
            false,
        ));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sha256_to_bytes(value: &str) -> Result<Vec<u8>, RpcFailure> {
    if !valid_sha256(value) {
        return Err(RpcFailure::invalid("SHA-256 digest is invalid."));
    }
    (0..32)
        .map(|index| {
            u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
                .map_err(|_| RpcFailure::invalid("SHA-256 digest is invalid."))
        })
        .collect()
}

fn take_state_access(params: &mut Map<String, Value>) -> Result<StateAccess, RpcFailure> {
    Ok(StateAccess {
        vault_handle: take_uuid(params, "vaultHandle")?,
        state_handle: take_uuid(params, "stateHandle")?,
        remote_binding: take_sha256(params, "remoteBinding")?,
    })
}

fn take_object(value: Value, message: &'static str) -> Result<Map<String, Value>, RpcFailure> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| RpcFailure::invalid(message))
}

fn take_string(
    params: &mut Map<String, Value>,
    key: &'static str,
    max_bytes: usize,
    allow_empty: bool,
) -> Result<String, RpcFailure> {
    let Value::String(value) = params
        .remove(key)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is required.")))?
    else {
        return Err(RpcFailure::invalid(format!("{key} must be a string.")));
    };
    if (!allow_empty && value.is_empty()) || value.len() > max_bytes {
        return Err(RpcFailure::invalid(format!(
            "{key} exceeds the reviewed limit."
        )));
    }
    Ok(value)
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

fn take_u64(params: &mut Map<String, Value>, key: &'static str) -> Result<u64, RpcFailure> {
    params
        .remove(key)
        .and_then(|value| value.as_u64())
        .ok_or_else(|| RpcFailure::invalid(format!("{key} must be an unsigned integer.")))
}

fn take_u32(params: &mut Map<String, Value>, key: &'static str) -> Result<u32, RpcFailure> {
    u32::try_from(take_u64(params, key)?)
        .map_err(|_| RpcFailure::invalid(format!("{key} exceeds the reviewed limit.")))
}

fn take_bool(params: &mut Map<String, Value>, key: &'static str) -> Result<bool, RpcFailure> {
    params
        .remove(key)
        .and_then(|value| value.as_bool())
        .ok_or_else(|| RpcFailure::invalid(format!("{key} must be a boolean.")))
}

fn take_uuid(params: &mut Map<String, Value>, key: &'static str) -> Result<String, RpcFailure> {
    let value = take_string(params, key, 64, false)?;
    canonical_uuid(&value)
        .filter(|canonical| canonical == &value)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is not a canonical opaque handle.")))
}

fn take_optional_uuid(
    params: &mut Map<String, Value>,
    key: &'static str,
) -> Result<Option<String>, RpcFailure> {
    let Some(value) = take_optional_string(params, key, 64)? else {
        return Ok(None);
    };
    canonical_uuid(&value)
        .filter(|canonical| canonical == &value)
        .map(Some)
        .ok_or_else(|| RpcFailure::invalid(format!("{key} is not a canonical opaque handle.")))
}

fn take_sha256(params: &mut Map<String, Value>, key: &'static str) -> Result<String, RpcFailure> {
    let value = take_string(params, key, 64, false)?;
    if valid_sha256(&value) {
        Ok(value)
    } else {
        Err(RpcFailure::invalid(format!(
            "{key} must be a lowercase SHA-256 digest."
        )))
    }
}

fn take_component(
    params: &mut Map<String, Value>,
    key: &'static str,
) -> Result<String, RpcFailure> {
    let value = take_string(params, key, MAX_COMPONENT_BYTES, false)?;
    let normalized = value.trim().to_string();
    if valid_component(&normalized) {
        Ok(normalized)
    } else {
        Err(RpcFailure::invalid(format!(
            "{key} contains an unsafe remote identifier."
        )))
    }
}

fn take_remote_blob_size(params: &mut Map<String, Value>) -> Result<u64, RpcFailure> {
    let total_size = take_u64(params, "totalSize")?;
    if total_size == 0 || total_size > MAX_REMOTE_BLOB_BYTES {
        return Err(RpcFailure::invalid(
            "totalSize exceeds the reviewed MDBX2 remote Blob limit.",
        ));
    }
    Ok(total_size)
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

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_COMPONENT_BYTES
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('\0')
}

fn stream_id(device_id: &str, generation_id: &str) -> String {
    format!("{device_id}/{generation_id}")
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

fn unix_seconds() -> Result<i64, RpcFailure> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RpcFailure::storage("System clock is unavailable."))?
        .as_secs();
    i64::try_from(seconds).map_err(|_| RpcFailure::storage("System clock exceeds supported range."))
}

fn read_bounded(path: &Path, maximum: u64) -> std::io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    if length == 0 || length > maximum || length > usize::MAX as u64 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bounded file length is invalid",
        ));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn hash_path(path: &Path) -> Result<String, RpcFailure> {
    let mut file = File::open(path)
        .map_err(|_| RpcFailure::storage("Native synchronization file is unavailable."))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| RpcFailure::storage("Native synchronization file could not be hashed."))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn ensure_regular_file(path: &Path, parent: &Path) -> Result<(), RpcFailure> {
    let parent = fs::canonicalize(parent)
        .map_err(|_| RpcFailure::storage("Native file directory is unavailable."))?;
    let path = fs::canonicalize(path).map_err(|_| {
        RpcFailure::new(
            "native-file-not-found",
            "Native file handle is unavailable.",
            false,
        )
    })?;
    let metadata = fs::symlink_metadata(&path).map_err(|_| {
        RpcFailure::new(
            "native-file-not-found",
            "Native file handle is unavailable.",
            false,
        )
    })?;
    if !path.starts_with(parent)
        || !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
    {
        return Err(RpcFailure::new(
            "native-file-invalid",
            "Native file handle is outside the Host storage boundary.",
            false,
        ));
    }
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

fn sync_core_error(code: &'static str, message: &'static str) -> RpcFailure {
    RpcFailure::new(code, message, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{prefix}-{}", fresh_uuid()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn call(runtime: &mut HostRuntime, method: &str, params: Value) -> Value {
        runtime.handle(method, params).unwrap()
    }

    fn open_new_vault(root: &TestRoot, password: &str) -> (HostRuntime, String) {
        let mut runtime = HostRuntime::new(root.0.clone()).unwrap();
        let source_path = runtime.root.join("source.mdbx");
        let source = mdbx_ffi::create_vault(
            path_string(&source_path).unwrap(),
            password.to_string(),
            "fixture-device".to_string(),
        )
        .unwrap();
        let file_handle = fresh_uuid();
        source
            .create_backup(
                path_string(
                    &runtime
                        .root
                        .join("imports")
                        .join(format!("{file_handle}.mdbx")),
                )
                .unwrap(),
            )
            .unwrap();
        drop(source);
        let opened = call(
            &mut runtime,
            "vault.open",
            json!({
                "source": { "kind": "file", "handle": file_handle },
                "credential": { "method": "password", "password": password }
            }),
        );
        (runtime, opened["vaultHandle"].as_str().unwrap().to_string())
    }

    fn open_existing_vault(root: &TestRoot, vault_handle: &str, password: &str) -> HostRuntime {
        let mut runtime = HostRuntime::new(root.0.clone()).unwrap();
        call(
            &mut runtime,
            "vault.open",
            json!({
                "source": { "kind": "vault", "handle": vault_handle },
                "credential": { "method": "password", "password": password }
            }),
        );
        runtime
    }

    #[test]
    fn two_slot_state_falls_back_from_a_truncated_newer_revision() {
        let root = std::env::temp_dir().join(format!("monica-cloud-state-{}", fresh_uuid()));
        fs::create_dir_all(root.join("sync/states")).unwrap();
        fs::create_dir_all(root.join("sync/incoming")).unwrap();
        fs::create_dir_all(root.join("sync/outbound")).unwrap();
        fs::create_dir_all(root.join("transfers")).unwrap();
        fs::create_dir_all(root.join("imports")).unwrap();
        fs::create_dir_all(root.join("vaults")).unwrap();
        fs::create_dir_all(root.join("backups")).unwrap();
        let runtime = HostRuntime::new(root.clone()).unwrap();
        let mut state = new_state(
            "11111111-1111-4111-8111-111111111111",
            &"a".repeat(64),
            "vault-a",
            "device-a",
        );
        persist_state(&runtime, &state).unwrap();
        state.revision = 1;
        persist_state(&runtime, &state).unwrap();
        fs::write(state_path(&runtime, &state.state_handle, 1), b"{").unwrap();
        let loaded = load_state(&runtime, &state.state_handle).unwrap();
        assert_eq!(loaded.revision, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn android_remote_components_and_digest_shapes_are_enforced() {
        assert!(valid_component("device-a"));
        assert!(!valid_component("device/a"));
        assert!(!valid_component(".."));
        assert!(valid_sha256(&"ab".repeat(32)));
        assert!(!valid_sha256("AB"));
    }

    #[test]
    fn bootstrap_pending_segment_restart_and_remote_apply_use_the_core() {
        let source_root = TestRoot::new("monica-cloud-source");
        let target_root = TestRoot::new("monica-cloud-target");
        let password = "test-password";
        let remote_binding = "ab".repeat(32);
        let (mut source, source_vault_handle) = open_new_vault(&source_root, password);

        let bootstrap = call(
            &mut source,
            "sync.bootstrap.prepare",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": null,
                "remoteBinding": remote_binding
            }),
        );
        let source_state_handle = bootstrap["stateHandle"].as_str().unwrap().to_string();
        let bootstrap_handle = bootstrap["file"]["fileHandle"]
            .as_str()
            .unwrap()
            .to_string();
        let bootstrap_bytes = fs::read(output_path(&source, &bootstrap_handle)).unwrap();
        call(
            &mut source,
            "sync.bootstrap.commit",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": source_state_handle,
                "remoteBinding": remote_binding,
                "fileHandle": bootstrap_handle
            }),
        );

        let mut target = HostRuntime::new(target_root.0.clone()).unwrap();
        let target_import_handle = fresh_uuid();
        fs::write(
            target
                .root
                .join("imports")
                .join(format!("{target_import_handle}.mdbx")),
            bootstrap_bytes,
        )
        .unwrap();
        let target_opened = call(
            &mut target,
            "vault.open",
            json!({
                "source": { "kind": "file", "handle": target_import_handle },
                "credential": { "method": "password", "password": password }
            }),
        );
        let target_vault_handle = target_opened["vaultHandle"].as_str().unwrap().to_string();
        let target_registered = call(
            &mut target,
            "sync.state.register",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": null,
                "remoteBinding": remote_binding
            }),
        );
        let target_state_handle = target_registered["stateHandle"]
            .as_str()
            .unwrap()
            .to_string();

        let logical_object_id = "password:sync-fixture";
        call(
            &mut source,
            "object.upsert",
            json!({
                "vaultHandle": source_vault_handle,
                "operationId": fresh_uuid(),
                "logicalObjectId": logical_object_id,
                "collectionId": null,
                "objectTypeId": "login",
                "title": "Synced example",
                "payloadJson": json!({
                    "kind": "password",
                    "monica_entry_id": logical_object_id,
                    "website": "https://example.test",
                    "username": "demo",
                    "password_plain": "secret"
                }).to_string()
            }),
        );
        let first_pending = call(
            &mut source,
            "sync.segment.prepare",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": source_state_handle,
                "remoteBinding": remote_binding,
                "pageSize": SEGMENT_PAGE_SIZE
            }),
        );
        assert_eq!(first_pending["hasSegment"], true);
        let segment_handle = first_pending["file"]["fileHandle"]
            .as_str()
            .unwrap()
            .to_string();
        drop(source);

        let mut source = open_existing_vault(&source_root, &source_vault_handle, password);
        let resumed_pending = call(
            &mut source,
            "sync.segment.prepare",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": source_state_handle,
                "remoteBinding": remote_binding,
                "pageSize": SEGMENT_PAGE_SIZE
            }),
        );
        assert_eq!(resumed_pending["file"]["fileHandle"], segment_handle);

        let target_segment_handle = fresh_uuid();
        fs::copy(
            output_path(&source, &segment_handle),
            target.sync_inbound_segment_path(&target_segment_handle),
        )
        .unwrap();
        call(
            &mut source,
            "sync.segment.commit",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": source_state_handle,
                "remoteBinding": remote_binding,
                "fileHandle": segment_handle,
                "payloadSha256": resumed_pending["payloadSha256"]
            }),
        );

        let applied = call(
            &mut target,
            "sync.segment.apply",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": target_state_handle,
                "remoteBinding": remote_binding,
                "fileHandle": target_segment_handle,
                "deviceId": resumed_pending["sourceDeviceId"],
                "generationId": resumed_pending["transferId"],
                "sequence": resumed_pending["segmentIndex"],
                "digest": resumed_pending["payloadSha256"]
            }),
        );
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["pendingAcknowledgement"], true);
        call(
            &mut target,
            "sync.segment.acknowledge",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": target_state_handle,
                "remoteBinding": remote_binding,
                "deviceId": resumed_pending["sourceDeviceId"],
                "generationId": resumed_pending["transferId"],
                "sequence": resumed_pending["segmentIndex"],
                "digest": resumed_pending["payloadSha256"]
            }),
        );
        let collections = call(
            &mut target,
            "collection.list",
            json!({
                "vaultHandle": target_vault_handle,
                "deleted": false,
                "pageSize": 200,
                "cursor": null
            }),
        );
        let collection_id = collections["items"][0]["collectionId"]
            .as_str()
            .unwrap()
            .to_string();
        let objects = call(
            &mut target,
            "object.list",
            json!({
                "vaultHandle": target_vault_handle,
                "collectionId": collection_id,
                "objectTypeId": null,
                "deleted": false,
                "pageSize": 200,
                "cursor": null
            }),
        );
        assert!(objects["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["title"] == "Synced example"));

        call(
            &mut source,
            "object.delete",
            json!({
                "vaultHandle": source_vault_handle,
                "operationId": fresh_uuid(),
                "logicalObjectId": logical_object_id
            }),
        );
        let tombstone_segment = call(
            &mut source,
            "sync.segment.prepare",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": source_state_handle,
                "remoteBinding": remote_binding,
                "pageSize": SEGMENT_PAGE_SIZE
            }),
        );
        let tombstone_source_handle = tombstone_segment["file"]["fileHandle"]
            .as_str()
            .unwrap()
            .to_string();
        let tombstone_target_handle = fresh_uuid();
        fs::copy(
            output_path(&source, &tombstone_source_handle),
            target.sync_inbound_segment_path(&tombstone_target_handle),
        )
        .unwrap();
        call(
            &mut source,
            "sync.segment.commit",
            json!({
                "vaultHandle": source_vault_handle,
                "stateHandle": source_state_handle,
                "remoteBinding": remote_binding,
                "fileHandle": tombstone_source_handle,
                "payloadSha256": tombstone_segment["payloadSha256"]
            }),
        );
        let tombstone_descriptor = json!({
            "vaultHandle": target_vault_handle,
            "stateHandle": target_state_handle,
            "remoteBinding": remote_binding,
            "fileHandle": tombstone_target_handle,
            "deviceId": tombstone_segment["sourceDeviceId"],
            "generationId": tombstone_segment["transferId"],
            "sequence": tombstone_segment["segmentIndex"],
            "digest": tombstone_segment["payloadSha256"]
        });
        assert_eq!(
            call(
                &mut target,
                "sync.segment.apply",
                tombstone_descriptor.clone()
            )["status"],
            "applied"
        );
        call(
            &mut target,
            "sync.segment.acknowledge",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": target_state_handle,
                "remoteBinding": remote_binding,
                "deviceId": tombstone_segment["sourceDeviceId"],
                "generationId": tombstone_segment["transferId"],
                "sequence": tombstone_segment["segmentIndex"],
                "digest": tombstone_segment["payloadSha256"]
            }),
        );
        let deleted = call(
            &mut target,
            "object.list",
            json!({
                "vaultHandle": target_vault_handle,
                "collectionId": collection_id,
                "objectTypeId": null,
                "deleted": true,
                "pageSize": 200,
                "cursor": null
            }),
        );
        assert!(deleted["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["title"] == "Synced example"));

        let blob_bytes = b"encrypted-blob-fixture";
        let blob_id = format!("{:x}", Sha256::digest(blob_bytes));
        let receive = call(
            &mut target,
            "sync.blob.receive.begin",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": target_state_handle,
                "remoteBinding": remote_binding,
                "blobId": blob_id,
                "totalSize": blob_bytes.len()
            }),
        );
        assert_eq!(receive["nextOffset"], 0);
        let completed = call(
            &mut target,
            "sync.blob.receive.chunk",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": target_state_handle,
                "remoteBinding": remote_binding,
                "blobId": blob_id,
                "totalSize": blob_bytes.len(),
                "offset": 0,
                "dataBase64": BASE64.encode(blob_bytes),
                "finalize": true
            }),
        );
        assert_eq!(completed["complete"], true);
        let read = call(
            &mut target,
            "sync.blob.read",
            json!({
                "vaultHandle": target_vault_handle,
                "stateHandle": target_state_handle,
                "remoteBinding": remote_binding,
                "blobId": blob_id,
                "totalSize": blob_bytes.len(),
                "offset": 0,
                "maxBytes": MAX_BINARY_CHUNK_BYTES
            }),
        );
        assert_eq!(
            BASE64.decode(read["dataBase64"].as_str().unwrap()).unwrap(),
            blob_bytes
        );
    }
}
