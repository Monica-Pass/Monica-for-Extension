use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Read, Write};

use crate::error::{SyncError, SyncResult};
use crate::message::{ObjectPayload, SerializedCommit, TombstoneRecord};

/// 文件格式魔数：`MDBXSYNC`
const BUNDLE_MAGIC: &[u8; 8] = b"MDBXSYNC";
/// 默认 legacy API 写出的未压缩 complete 格式版本。
const BUNDLE_VERSION: u32 = 3;
const INCREMENTAL_BUNDLE_VERSION: u32 = 4;
const COMPRESSED_BUNDLE_VERSION: u32 = 5;
const COMPRESSED_INCREMENTAL_BUNDLE_VERSION: u32 = 6;
pub const AUTHENTICATED_BUNDLE_VERSION: u32 = 7;
pub const AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION: u32 = 8;
pub const AUTHENTICATED_COMPRESSED_BUNDLE_VERSION: u32 = 9;
pub const AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION: u32 = 10;
const PREVIOUS_BUNDLE_VERSION: u32 = 2;
const LEGACY_BUNDLE_VERSION: u32 = 1;
const BUNDLE_RESERVED_BYTES: usize = 20;
const BUNDLE_HASH_BYTES: usize = 32;
const BUNDLE_AUTH_TAG_BYTES: usize = 32;
const BUNDLE_AUTH_KEY_BYTES: usize = 32;
const BUNDLE_AUTH_DOMAIN: &[u8] = b"mdbx-sync-bundle-auth-v1";
pub const DEFAULT_MAX_BUNDLE_PAYLOAD_BYTES: u64 = 128 * 1024 * 1024;
pub const DESKTOP_MAX_BUNDLE_PAYLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const HARD_MAX_BUNDLE_PAYLOAD_BYTES: u64 = DESKTOP_MAX_BUNDLE_PAYLOAD_BYTES;
const HARD_MAX_BUNDLE_PAYLOAD_BYTES_USIZE: usize = HARD_MAX_BUNDLE_PAYLOAD_BYTES as usize;
pub const INCREMENTAL_BUNDLE_FORMAT: &str = "mdbx-sync-incremental-v1";
pub const MAX_INCREMENTAL_BUNDLE_COMMITS: usize = 4096;
pub const MAX_INCREMENTAL_BUNDLE_DELTAS: usize = 4096;
pub const MAX_INCREMENTAL_BUNDLE_TOKEN_BYTES: usize = 4096;
const MAX_INCREMENTAL_BUNDLE_ID_BYTES: usize = 256;
#[cfg(feature = "zstd-compression")]
const ZSTD_COMPRESSION_LEVEL: i32 = 0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BundleCompression {
    #[default]
    None,
    Zstd,
}

struct BundleBody {
    payload: Vec<u8>,
    stored_hash: [u8; BUNDLE_HASH_BYTES],
    auth_tag: Option<[u8; BUNDLE_AUTH_TAG_BYTES]>,
}

/// 离线同步包。
///
/// 包含一组 commit 及其关联的对象数据，用于通过文件（USB、邮件等）进行离线同步。
///
/// 文件格式：
/// ```text
/// ┌──────────────────────────────────────┐
/// │ magic:    [u8; 8]  = b"MDBXSYNC"   │
/// │ version:  u32 (LE)  = 3             │
/// │ length:   u64 (LE) payload bytes    │
/// │ reserved: [u8; 12]  (zero)          │
/// │ payload:  <bincode 2 serde>         │
/// │ hash:     [u8; 32]  SHA-256(body)   │
/// └──────────────────────────────────────┘
/// ```
/// v7-v10 保留逻辑 payload SHA-256，并在其后追加绑定版本与有界 header 的
/// HMAC-SHA-256 trailer；v9/v10 的 payload 为 zstd 表示。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncBundle {
    /// 导出时的 UTC 时间戳 (RFC 3339)
    pub exported_at: String,
    /// 导出设备 ID
    pub source_device_id: String,
    /// 源 vault ID
    pub vault_id: String,
    /// 包含的 commits 列表
    pub commits: Vec<SerializedCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IncrementalBundleCheckpoint {
    /// Opaque source-owned commit inventory checkpoint. `None` means bootstrap.
    pub commit_inventory: Option<String>,
    /// Opaque source-owned state-delta inventory checkpoint. `None` means bootstrap.
    pub delta_inventory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IncrementalBundleResume {
    pub transfer_id: String,
    pub next_segment_index: u32,
    pub previous_segment_sha256: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncrementalCommitInventoryEntry {
    pub inventory_seq: u64,
    pub commit_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IncrementalDeltaKind {
    Commit,
    Auxiliary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncrementalDeltaInventoryEntry {
    pub batch_seq: u64,
    pub batch_id: String,
    pub batch_kind: IncrementalDeltaKind,
    pub commit_ids: Vec<String>,
    /// SHA-256 of the transported `ObjectPayload.ciphertext` bytes.
    pub object_payload_sha256: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncrementalBundleManifest {
    pub format: String,
    pub vault_id: String,
    pub source_device_id: String,
    pub exported_at: String,
    pub transfer_id: String,
    pub segment_index: u32,
    pub previous_segment_sha256: Option<Vec<u8>>,
    pub is_last: bool,
    pub base: IncrementalBundleCheckpoint,
    pub result: IncrementalBundleCheckpoint,
    pub commit_inventory: Vec<IncrementalCommitInventoryEntry>,
    pub delta_inventory: Vec<IncrementalDeltaInventoryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IncrementalSyncBundle {
    pub manifest: IncrementalBundleManifest,
    pub commits: Vec<SerializedCommit>,
    /// Commit-associated delta payloads remain attached to their final commit.
    /// This vector contains only auxiliary batches.
    pub auxiliary_deltas: Vec<ObjectPayload>,
}

#[derive(Debug, Clone)]
pub enum SyncBundleFile {
    Complete(SyncBundle),
    Incremental(Box<IncrementalSyncBundle>),
}

impl IncrementalSyncBundle {
    pub fn validate(&self) -> SyncResult<()> {
        let manifest = &self.manifest;
        if manifest.format != INCREMENTAL_BUNDLE_FORMAT {
            return Err(SyncError::BundleFormat(format!(
                "unsupported incremental bundle format: {}",
                manifest.format
            )));
        }
        validate_identifier("vault ID", &manifest.vault_id)?;
        validate_identifier("source device ID", &manifest.source_device_id)?;
        validate_identifier("export timestamp", &manifest.exported_at)?;
        validate_identifier("transfer ID", &manifest.transfer_id)?;
        validate_segment_chain(manifest)?;
        validate_checkpoint(&manifest.base, true, "base")?;
        validate_checkpoint(&manifest.result, false, "result")?;
        validate_count(
            "incremental bundle commits",
            manifest.commit_inventory.len(),
            MAX_INCREMENTAL_BUNDLE_COMMITS,
        )?;
        validate_count(
            "incremental bundle deltas",
            manifest.delta_inventory.len(),
            MAX_INCREMENTAL_BUNDLE_DELTAS,
        )?;
        if manifest.commit_inventory.len() != self.commits.len() {
            return Err(SyncError::BundleFormat(
                "incremental commit inventory does not match transported commits".to_string(),
            ));
        }

        let mut commit_ids = HashSet::with_capacity(self.commits.len());
        let mut previous_commit_seq = None;
        for (inventory, serialized) in manifest.commit_inventory.iter().zip(&self.commits) {
            validate_identifier("commit ID", &inventory.commit_id)?;
            if inventory.commit_id != serialized.commit.commit_id {
                return Err(SyncError::BundleFormat(
                    "incremental commit inventory order does not match commit payloads".to_string(),
                ));
            }
            validate_strict_sequence(
                "commit inventory",
                previous_commit_seq,
                inventory.inventory_seq,
            )?;
            previous_commit_seq = Some(inventory.inventory_seq);
            if !commit_ids.insert(inventory.commit_id.as_str()) {
                return Err(SyncError::BundleFormat(
                    "incremental bundle contains duplicate commit IDs".to_string(),
                ));
            }
        }

        let mut batch_ids = HashSet::with_capacity(manifest.delta_inventory.len());
        let mut previous_batch_seq = None;
        let mut expected_auxiliary = HashSet::new();
        for delta in &manifest.delta_inventory {
            validate_identifier("delta batch ID", &delta.batch_id)?;
            validate_strict_sequence("delta inventory", previous_batch_seq, delta.batch_seq)?;
            previous_batch_seq = Some(delta.batch_seq);
            if !batch_ids.insert(delta.batch_id.as_str()) {
                return Err(SyncError::BundleFormat(
                    "incremental bundle contains duplicate delta batch IDs".to_string(),
                ));
            }
            if delta.object_payload_sha256.len() != 32 {
                return Err(SyncError::BundleFormat(format!(
                    "delta batch {} payload digest must be 32 bytes",
                    delta.batch_id
                )));
            }
            validate_count(
                "incremental delta commit associations",
                delta.commit_ids.len(),
                MAX_INCREMENTAL_BUNDLE_COMMITS,
            )?;
            let mut associated_commits = HashSet::with_capacity(delta.commit_ids.len());
            for commit_id in &delta.commit_ids {
                validate_identifier("delta commit ID", commit_id)?;
                if !associated_commits.insert(commit_id.as_str()) {
                    return Err(SyncError::BundleFormat(format!(
                        "delta batch {} contains duplicate commit IDs",
                        delta.batch_id
                    )));
                }
            }
            match delta.batch_kind {
                IncrementalDeltaKind::Commit => {
                    let final_commit_id = delta.commit_ids.last().ok_or_else(|| {
                        SyncError::BundleFormat(format!(
                            "commit delta batch {} has no associated commits",
                            delta.batch_id
                        ))
                    })?;
                    let final_commit = self
                        .commits
                        .iter()
                        .find(|commit| &commit.commit.commit_id == final_commit_id)
                        .ok_or_else(|| {
                            SyncError::BundleFormat(format!(
                                "commit delta batch {} is missing its final commit",
                                delta.batch_id
                            ))
                        })?;
                    validate_delta_payload(
                        &delta.batch_id,
                        &delta.object_payload_sha256,
                        final_commit
                            .object_payloads
                            .iter()
                            .filter(|payload| payload.object_id == delta.batch_id),
                    )?;
                }
                IncrementalDeltaKind::Auxiliary => {
                    if !delta.commit_ids.is_empty() {
                        return Err(SyncError::BundleFormat(format!(
                            "auxiliary delta batch {} cannot reference commits",
                            delta.batch_id
                        )));
                    }
                    expected_auxiliary.insert(delta.batch_id.as_str());
                    validate_delta_payload(
                        &delta.batch_id,
                        &delta.object_payload_sha256,
                        self.auxiliary_deltas
                            .iter()
                            .filter(|payload| payload.object_id == delta.batch_id),
                    )?;
                }
            }
        }

        if self.auxiliary_deltas.len() != expected_auxiliary.len()
            || self
                .auxiliary_deltas
                .iter()
                .any(|payload| !expected_auxiliary.contains(payload.object_id.as_str()))
        {
            return Err(SyncError::BundleFormat(
                "incremental bundle has unlisted auxiliary delta payloads".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_identifier(name: &str, value: &str) -> SyncResult<()> {
    if value.trim().is_empty() || value.len() > MAX_INCREMENTAL_BUNDLE_ID_BYTES {
        return Err(SyncError::BundleFormat(format!(
            "incremental bundle {name} must contain between 1 and {MAX_INCREMENTAL_BUNDLE_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_count(name: &str, actual: usize, limit: usize) -> SyncResult<()> {
    if actual > limit {
        return Err(SyncError::ResourceLimit {
            resource: name.to_string(),
            actual: actual as u64,
            limit: limit as u64,
        });
    }
    Ok(())
}

fn validate_checkpoint(
    checkpoint: &IncrementalBundleCheckpoint,
    allow_bootstrap: bool,
    name: &str,
) -> SyncResult<()> {
    if checkpoint.commit_inventory.is_some() != checkpoint.delta_inventory.is_some() {
        return Err(SyncError::BundleFormat(format!(
            "incremental bundle {name} checkpoint is incomplete"
        )));
    }
    if !allow_bootstrap && checkpoint.commit_inventory.is_none() {
        return Err(SyncError::BundleFormat(
            "incremental bundle result checkpoint is missing".to_string(),
        ));
    }
    for token in [
        checkpoint.commit_inventory.as_deref(),
        checkpoint.delta_inventory.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if token.is_empty() || token.len() > MAX_INCREMENTAL_BUNDLE_TOKEN_BYTES {
            return Err(SyncError::BundleFormat(format!(
                "incremental bundle {name} checkpoint token must contain between 1 and {MAX_INCREMENTAL_BUNDLE_TOKEN_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

fn validate_segment_chain(manifest: &IncrementalBundleManifest) -> SyncResult<()> {
    match (manifest.segment_index, &manifest.previous_segment_sha256) {
        (0, None) => Ok(()),
        (0, Some(_)) => Err(SyncError::BundleFormat(
            "first incremental segment cannot reference a previous segment".to_string(),
        )),
        (_, Some(digest)) if digest.len() == 32 => Ok(()),
        (_, Some(_)) => Err(SyncError::BundleFormat(
            "incremental previous-segment digest must be 32 bytes".to_string(),
        )),
        (_, None) => Err(SyncError::BundleFormat(
            "resumed incremental segment is missing its previous-segment digest".to_string(),
        )),
    }
}

fn validate_strict_sequence(name: &str, previous: Option<u64>, current: u64) -> SyncResult<()> {
    if current == 0 || previous.is_some_and(|value| current <= value) {
        return Err(SyncError::BundleFormat(format!(
            "incremental {name} sequences must be positive and strictly increasing"
        )));
    }
    Ok(())
}

fn validate_delta_payload<'a>(
    batch_id: &str,
    expected_digest: &[u8],
    mut payloads: impl Iterator<Item = &'a ObjectPayload>,
) -> SyncResult<()> {
    let payload = payloads.next().ok_or_else(|| {
        SyncError::BundleFormat(format!(
            "incremental delta batch {batch_id} is missing its object payload"
        ))
    })?;
    if payloads.next().is_some() {
        return Err(SyncError::BundleFormat(format!(
            "incremental delta batch {batch_id} has multiple object payloads"
        )));
    }
    if Sha256::digest(&payload.ciphertext).as_slice() != expected_digest {
        return Err(SyncError::BundleIntegrity(format!(
            "incremental delta batch {batch_id} payload digest mismatch"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundleReadLimits {
    max_payload_bytes: u64,
}

impl BundleReadLimits {
    pub fn new(max_payload_bytes: u64) -> SyncResult<Self> {
        if max_payload_bytes == 0 || max_payload_bytes > HARD_MAX_BUNDLE_PAYLOAD_BYTES {
            return Err(SyncError::BundleFormat(format!(
                "bundle payload limit must be between 1 and {HARD_MAX_BUNDLE_PAYLOAD_BYTES} bytes"
            )));
        }
        Ok(Self { max_payload_bytes })
    }

    pub const fn desktop() -> Self {
        Self {
            max_payload_bytes: DESKTOP_MAX_BUNDLE_PAYLOAD_BYTES,
        }
    }

    pub const fn max_payload_bytes(self) -> u64 {
        self.max_payload_bytes
    }
}

impl Default for BundleReadLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: DEFAULT_MAX_BUNDLE_PAYLOAD_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacySyncBundleV1 {
    exported_at: String,
    source_device_id: String,
    vault_id: String,
    commits: Vec<LegacySerializedCommitV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacySerializedCommitV1 {
    commit: mdbx_core::model::Commit,
    parent_ids: Vec<String>,
    tombstones: Vec<TombstoneRecord>,
    object_payloads: Vec<ObjectPayload>,
}

impl From<LegacySyncBundleV1> for SyncBundle {
    fn from(legacy: LegacySyncBundleV1) -> Self {
        Self {
            exported_at: legacy.exported_at,
            source_device_id: legacy.source_device_id,
            vault_id: legacy.vault_id,
            commits: legacy
                .commits
                .into_iter()
                .map(|commit| SerializedCommit {
                    commit: commit.commit,
                    operation: None,
                    parent_ids: commit.parent_ids,
                    tombstones: commit.tombstones,
                    object_payloads: commit.object_payloads,
                })
                .collect(),
        }
    }
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

/// 从 vault 导出一组 commit 为 SyncBundle。
pub fn build_bundle(
    vault_id: &str,
    source_device_id: &str,
    commits: Vec<SerializedCommit>,
) -> SyncBundle {
    SyncBundle {
        exported_at: chrono::Utc::now().to_rfc3339(),
        source_device_id: source_device_id.to_string(),
        vault_id: vault_id.to_string(),
        commits,
    }
}

// ---------------------------------------------------------------------------
// 文件写入
// ---------------------------------------------------------------------------

/// 将 SyncBundle 写入文件。
pub fn write_bundle(bundle: &SyncBundle, writer: &mut impl Write) -> SyncResult<()> {
    write_versioned_payload(BUNDLE_VERSION, bundle, writer)
}

/// Write a complete bundle with a keyed v7 transport trailer.
pub fn write_bundle_authenticated(
    bundle: &SyncBundle,
    writer: &mut impl Write,
    integrity_key: &[u8],
) -> SyncResult<()> {
    write_authenticated_versioned_payload(
        AUTHENTICATED_BUNDLE_VERSION,
        bundle,
        writer,
        integrity_key,
    )
}

/// Write a complete bundle with an explicitly selected codec.
///
/// `None` preserves the v3 format. `Zstd` writes v5 and is available only
/// when the crate is built with `zstd-compression`.
pub fn write_bundle_with_compression(
    bundle: &SyncBundle,
    writer: &mut impl Write,
    compression: BundleCompression,
) -> SyncResult<()> {
    match compression {
        BundleCompression::None => write_bundle(bundle, writer),
        BundleCompression::Zstd => {
            write_compressed_payload(COMPRESSED_BUNDLE_VERSION, bundle, writer)
        }
    }
}

/// Write a keyed v7 or v9 complete bundle with an explicit codec.
pub fn write_bundle_with_compression_authenticated(
    bundle: &SyncBundle,
    writer: &mut impl Write,
    compression: BundleCompression,
    integrity_key: &[u8],
) -> SyncResult<()> {
    match compression {
        BundleCompression::None => write_authenticated_versioned_payload(
            AUTHENTICATED_BUNDLE_VERSION,
            bundle,
            writer,
            integrity_key,
        ),
        BundleCompression::Zstd => write_authenticated_compressed_payload(
            AUTHENTICATED_COMPRESSED_BUNDLE_VERSION,
            bundle,
            writer,
            integrity_key,
        ),
    }
}

/// 将有界、可恢复的增量 bundle v4 写入文件。
pub fn write_incremental_bundle(
    bundle: &IncrementalSyncBundle,
    writer: &mut impl Write,
) -> SyncResult<()> {
    bundle.validate()?;
    write_versioned_payload(INCREMENTAL_BUNDLE_VERSION, bundle, writer)
}

/// Write an incremental bundle with a keyed v8 transport trailer.
pub fn write_incremental_bundle_authenticated(
    bundle: &IncrementalSyncBundle,
    writer: &mut impl Write,
    integrity_key: &[u8],
) -> SyncResult<()> {
    bundle.validate()?;
    write_authenticated_versioned_payload(
        AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION,
        bundle,
        writer,
        integrity_key,
    )
}

/// Write an incremental bundle with an explicitly selected codec.
///
/// `None` preserves the v4 format. `Zstd` writes v6 while retaining the
/// SHA-256 identity of the uncompressed bincode payload.
pub fn write_incremental_bundle_with_compression(
    bundle: &IncrementalSyncBundle,
    writer: &mut impl Write,
    compression: BundleCompression,
) -> SyncResult<()> {
    bundle.validate()?;
    match compression {
        BundleCompression::None => {
            write_versioned_payload(INCREMENTAL_BUNDLE_VERSION, bundle, writer)
        }
        BundleCompression::Zstd => {
            write_compressed_payload(COMPRESSED_INCREMENTAL_BUNDLE_VERSION, bundle, writer)
        }
    }
}

/// Write a keyed v8 or v10 incremental bundle with an explicit codec.
pub fn write_incremental_bundle_with_compression_authenticated(
    bundle: &IncrementalSyncBundle,
    writer: &mut impl Write,
    compression: BundleCompression,
    integrity_key: &[u8],
) -> SyncResult<()> {
    bundle.validate()?;
    match compression {
        BundleCompression::None => write_authenticated_versioned_payload(
            AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION,
            bundle,
            writer,
            integrity_key,
        ),
        BundleCompression::Zstd => write_authenticated_compressed_payload(
            AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION,
            bundle,
            writer,
            integrity_key,
        ),
    }
}

/// Return the logical payload SHA-256 written in a v4/v6/v8/v10 bundle trailer.
///
/// Segment checkpoints use this digest to bind the next segment to the exact
/// payload that was previously exported and durably applied.
pub fn incremental_bundle_payload_sha256(bundle: &IncrementalSyncBundle) -> SyncResult<Vec<u8>> {
    bundle.validate()?;
    let mut counter = LimitedCountingWriter::new(HARD_MAX_BUNDLE_PAYLOAD_BYTES);
    let mut hashing_writer = HashingWriter::new(&mut counter);
    bincode::serde::encode_into_std_write(bundle, &mut hashing_writer, bincode::config::standard())
        .map_err(|error| {
            if let Some(actual) = hashing_writer.inner.exceeded_at() {
                SyncError::ResourceLimit {
                    resource: "sync bundle payload".to_string(),
                    actual,
                    limit: HARD_MAX_BUNDLE_PAYLOAD_BYTES,
                }
            } else {
                map_bundle_encode_error(error)
            }
        })?;
    Ok(hashing_writer.finalize().to_vec())
}

fn write_versioned_payload<T: Serialize>(
    version: u32,
    value: &T,
    writer: &mut impl Write,
) -> SyncResult<()> {
    write_versioned_payload_with_auth(version, value, writer, None)
}

fn write_authenticated_versioned_payload<T: Serialize>(
    version: u32,
    value: &T,
    writer: &mut impl Write,
    integrity_key: &[u8],
) -> SyncResult<()> {
    write_versioned_payload_with_auth(version, value, writer, Some(integrity_key))
}

fn write_versioned_payload_with_auth<T: Serialize>(
    version: u32,
    value: &T,
    writer: &mut impl Write,
    integrity_key: Option<&[u8]>,
) -> SyncResult<()> {
    if let Some(key) = integrity_key {
        validate_integrity_key(key)?;
    }
    let mut counter = LimitedCountingWriter::new(HARD_MAX_BUNDLE_PAYLOAD_BYTES);
    let encoded_len =
        bincode::serde::encode_into_std_write(value, &mut counter, bincode::config::standard())
            .map_err(|error| {
                if let Some(actual) = counter.exceeded_at() {
                    SyncError::ResourceLimit {
                        resource: "sync bundle payload".to_string(),
                        actual,
                        limit: HARD_MAX_BUNDLE_PAYLOAD_BYTES,
                    }
                } else {
                    map_bundle_encode_error(error)
                }
            })?;
    let payload_len = counter.bytes_written();
    if encoded_len as u64 != payload_len {
        return Err(SyncError::BundleFormat(
            "bundle encoder reported an inconsistent payload length".to_string(),
        ));
    }

    // 写入 header
    writer.write_all(BUNDLE_MAGIC)?;
    writer.write_all(&version.to_le_bytes())?;
    let mut reserved = [0u8; BUNDLE_RESERVED_BYTES];
    reserved[..8].copy_from_slice(&payload_len.to_le_bytes());
    writer.write_all(&reserved)?;
    let mut hashing_writer = HashingWriter::new(writer);
    let written = bincode::serde::encode_into_std_write(
        value,
        &mut hashing_writer,
        bincode::config::standard(),
    )
    .map_err(map_bundle_encode_error)?;
    if written as u64 != payload_len {
        return Err(SyncError::BundleFormat(
            "bundle changed while it was being encoded".to_string(),
        ));
    }
    let hash = hashing_writer.finalize();
    writer.write_all(&hash)?;
    if let Some(key) = integrity_key {
        writer.write_all(&compute_bundle_auth_tag(key, version, &reserved, &hash)?)?;
    }

    Ok(())
}

#[cfg(feature = "zstd-compression")]
fn write_compressed_payload<T: Serialize>(
    version: u32,
    value: &T,
    writer: &mut impl Write,
) -> SyncResult<()> {
    write_compressed_payload_with_auth(version, value, writer, None)
}

#[cfg(feature = "zstd-compression")]
fn write_authenticated_compressed_payload<T: Serialize>(
    version: u32,
    value: &T,
    writer: &mut impl Write,
    integrity_key: &[u8],
) -> SyncResult<()> {
    write_compressed_payload_with_auth(version, value, writer, Some(integrity_key))
}

#[cfg(feature = "zstd-compression")]
fn write_compressed_payload_with_auth<T: Serialize>(
    version: u32,
    value: &T,
    writer: &mut impl Write,
    integrity_key: Option<&[u8]>,
) -> SyncResult<()> {
    if let Some(key) = integrity_key {
        validate_integrity_key(key)?;
    }
    let uncompressed_len = encoded_payload_len(value)?;
    let (compressed_len, expected_hash) = measure_compressed_payload(value)?;

    writer.write_all(BUNDLE_MAGIC)?;
    writer.write_all(&version.to_le_bytes())?;
    let mut reserved = [0u8; BUNDLE_RESERVED_BYTES];
    reserved[..8].copy_from_slice(&compressed_len.to_le_bytes());
    reserved[8..16].copy_from_slice(&uncompressed_len.to_le_bytes());
    writer.write_all(&reserved)?;

    let mut forwarding_writer = LimitedForwardingWriter::new(writer, compressed_len);
    let (written, actual_hash) = encode_compressed_payload(value, &mut forwarding_writer)?;
    if forwarding_writer.exceeded_at().is_some()
        || forwarding_writer.bytes_written() != compressed_len
        || written != uncompressed_len
        || actual_hash != expected_hash
    {
        return Err(SyncError::BundleFormat(
            "bundle changed while it was being compressed".to_string(),
        ));
    }
    writer.write_all(&expected_hash)?;
    if let Some(key) = integrity_key {
        writer.write_all(&compute_bundle_auth_tag(
            key,
            version,
            &reserved,
            &expected_hash,
        )?)?;
    }
    Ok(())
}

#[cfg(not(feature = "zstd-compression"))]
fn write_compressed_payload<T: Serialize>(
    _version: u32,
    _value: &T,
    _writer: &mut impl Write,
) -> SyncResult<()> {
    Err(zstd_unsupported())
}

#[cfg(not(feature = "zstd-compression"))]
fn write_authenticated_compressed_payload<T: Serialize>(
    _version: u32,
    _value: &T,
    _writer: &mut impl Write,
    _integrity_key: &[u8],
) -> SyncResult<()> {
    Err(zstd_unsupported())
}

#[cfg(feature = "zstd-compression")]
fn encoded_payload_len<T: Serialize>(value: &T) -> SyncResult<u64> {
    let mut counter = LimitedCountingWriter::new(HARD_MAX_BUNDLE_PAYLOAD_BYTES);
    let encoded_len =
        bincode::serde::encode_into_std_write(value, &mut counter, bincode::config::standard())
            .map_err(|error| {
                if let Some(actual) = counter.exceeded_at() {
                    payload_limit_error("sync bundle payload", actual, counter.limit)
                } else {
                    map_bundle_encode_error(error)
                }
            })?;
    let payload_len = counter.bytes_written();
    if encoded_len as u64 != payload_len {
        return Err(SyncError::BundleFormat(
            "bundle encoder reported an inconsistent payload length".to_string(),
        ));
    }
    Ok(payload_len)
}

#[cfg(feature = "zstd-compression")]
fn measure_compressed_payload<T: Serialize>(value: &T) -> SyncResult<(u64, [u8; 32])> {
    let mut counter = LimitedCountingWriter::new(HARD_MAX_BUNDLE_PAYLOAD_BYTES);
    let result = encode_compressed_payload(value, &mut counter);
    if let Some(actual) = counter.exceeded_at() {
        return Err(payload_limit_error(
            "compressed sync bundle payload",
            actual,
            HARD_MAX_BUNDLE_PAYLOAD_BYTES,
        ));
    }
    let (_, hash) = result?;
    Ok((counter.bytes_written(), hash))
}

#[cfg(feature = "zstd-compression")]
fn encode_compressed_payload<T: Serialize>(
    value: &T,
    writer: &mut impl Write,
) -> SyncResult<(u64, [u8; BUNDLE_HASH_BYTES])> {
    let mut encoder = zstd::stream::write::Encoder::new(writer, ZSTD_COMPRESSION_LEVEL)?;
    let mut hashing_writer = HashingWriter::new(&mut encoder);
    let written = bincode::serde::encode_into_std_write(
        value,
        &mut hashing_writer,
        bincode::config::standard(),
    )
    .map_err(map_bundle_encode_error)?;
    let hash = hashing_writer.finalize();
    encoder.finish()?;
    Ok((written as u64, hash))
}

#[cfg(not(feature = "zstd-compression"))]
fn zstd_unsupported() -> SyncError {
    SyncError::UnsupportedFeature("zstd-compression".to_string())
}

fn payload_limit_error(resource: &str, actual: u64, limit: u64) -> SyncError {
    SyncError::ResourceLimit {
        resource: resource.to_string(),
        actual,
        limit,
    }
}

type HmacSha256 = Hmac<Sha256>;

fn validate_integrity_key(integrity_key: &[u8]) -> SyncResult<()> {
    if integrity_key.len() != BUNDLE_AUTH_KEY_BYTES {
        return Err(SyncError::BundleFormat(format!(
            "bundle integrity key must be {BUNDLE_AUTH_KEY_BYTES} bytes"
        )));
    }
    Ok(())
}

fn compute_bundle_auth_tag(
    integrity_key: &[u8],
    version: u32,
    reserved: &[u8; BUNDLE_RESERVED_BYTES],
    payload_hash: &[u8; BUNDLE_HASH_BYTES],
) -> SyncResult<[u8; BUNDLE_AUTH_TAG_BYTES]> {
    validate_integrity_key(integrity_key)?;
    let mut mac = HmacSha256::new_from_slice(integrity_key)
        .map_err(|_| SyncError::BundleFormat("invalid bundle integrity key".to_string()))?;
    let version = version.to_le_bytes();
    for part in [
        BUNDLE_AUTH_DOMAIN,
        BUNDLE_MAGIC.as_slice(),
        version.as_slice(),
        reserved.as_slice(),
        payload_hash.as_slice(),
    ] {
        mac.update(&(part.len() as u64).to_le_bytes());
        mac.update(part);
    }
    let tag = mac.finalize().into_bytes();
    let mut output = [0_u8; BUNDLE_AUTH_TAG_BYTES];
    output.copy_from_slice(&tag);
    Ok(output)
}

fn verify_bundle_auth_tag(
    integrity_key: &[u8],
    version: u32,
    reserved: &[u8; BUNDLE_RESERVED_BYTES],
    payload_hash: &[u8; BUNDLE_HASH_BYTES],
    expected_tag: &[u8; BUNDLE_AUTH_TAG_BYTES],
) -> SyncResult<()> {
    validate_integrity_key(integrity_key)?;
    let mut mac = HmacSha256::new_from_slice(integrity_key)
        .map_err(|_| SyncError::BundleFormat("invalid bundle integrity key".to_string()))?;
    let version = version.to_le_bytes();
    for part in [
        BUNDLE_AUTH_DOMAIN,
        BUNDLE_MAGIC.as_slice(),
        version.as_slice(),
        reserved.as_slice(),
        payload_hash.as_slice(),
    ] {
        mac.update(&(part.len() as u64).to_le_bytes());
        mac.update(part);
    }
    mac.verify_slice(expected_tag)
        .map_err(|_| SyncError::BundleIntegrity("HMAC-SHA-256 mismatch".to_string()))
}

fn map_bundle_encode_error(error: bincode::error::EncodeError) -> SyncError {
    match error {
        bincode::error::EncodeError::Io { inner, .. } => SyncError::IoError(inner),
        other => SyncError::Serialization(other.to_string()),
    }
}

struct LimitedCountingWriter {
    bytes_written: u64,
    limit: u64,
    exceeded_at: Option<u64>,
}

impl LimitedCountingWriter {
    fn new(limit: u64) -> Self {
        Self {
            bytes_written: 0,
            limit,
            exceeded_at: None,
        }
    }

    fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    fn exceeded_at(&self) -> Option<u64> {
        self.exceeded_at
    }
}

impl Write for LimitedCountingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let incoming = u64::try_from(buf.len()).unwrap_or(u64::MAX);
        let next = self.bytes_written.saturating_add(incoming);
        if next > self.limit {
            self.exceeded_at = Some(next);
            return Err(std::io::Error::other("sync bundle payload limit exceeded"));
        }
        self.bytes_written = next;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct HashingWriter<'a, W> {
    inner: &'a mut W,
    hasher: Sha256,
}

#[cfg(feature = "zstd-compression")]
struct LimitedForwardingWriter<'a, W> {
    inner: &'a mut W,
    bytes_written: u64,
    limit: u64,
    exceeded_at: Option<u64>,
}

#[cfg(feature = "zstd-compression")]
impl<'a, W: Write> LimitedForwardingWriter<'a, W> {
    fn new(inner: &'a mut W, limit: u64) -> Self {
        Self {
            inner,
            bytes_written: 0,
            limit,
            exceeded_at: None,
        }
    }

    fn bytes_written(&self) -> u64 {
        self.bytes_written
    }

    fn exceeded_at(&self) -> Option<u64> {
        self.exceeded_at
    }
}

#[cfg(feature = "zstd-compression")]
impl<W: Write> Write for LimitedForwardingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let incoming = u64::try_from(buf.len()).unwrap_or(u64::MAX);
        let next = self.bytes_written.saturating_add(incoming);
        if next > self.limit {
            self.exceeded_at = Some(next);
            return Err(std::io::Error::other(
                "compressed sync bundle payload length changed",
            ));
        }
        let written = self.inner.write(buf)?;
        self.bytes_written = self
            .bytes_written
            .saturating_add(u64::try_from(written).unwrap_or(u64::MAX));
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl<'a, W: Write> HashingWriter<'a, W> {
    fn new(inner: &'a mut W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
        }
    }

    fn finalize(self) -> [u8; BUNDLE_HASH_BYTES] {
        let digest = self.hasher.finalize();
        let mut hash = [0u8; BUNDLE_HASH_BYTES];
        hash.copy_from_slice(&digest);
        hash
    }
}

impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// 导出 SyncBundle 到字节数组（用于测试和传输）。
pub fn bundle_to_bytes(bundle: &SyncBundle) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_bundle(bundle, &mut buf)?;
    Ok(buf)
}

pub fn bundle_to_bytes_authenticated(
    bundle: &SyncBundle,
    integrity_key: &[u8],
) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_bundle_authenticated(bundle, &mut buf, integrity_key)?;
    Ok(buf)
}

pub fn incremental_bundle_to_bytes(bundle: &IncrementalSyncBundle) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_incremental_bundle(bundle, &mut buf)?;
    Ok(buf)
}

pub fn incremental_bundle_to_bytes_authenticated(
    bundle: &IncrementalSyncBundle,
    integrity_key: &[u8],
) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_incremental_bundle_authenticated(bundle, &mut buf, integrity_key)?;
    Ok(buf)
}

pub fn bundle_to_bytes_with_compression(
    bundle: &SyncBundle,
    compression: BundleCompression,
) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_bundle_with_compression(bundle, &mut buf, compression)?;
    Ok(buf)
}

pub fn bundle_to_bytes_with_compression_authenticated(
    bundle: &SyncBundle,
    compression: BundleCompression,
    integrity_key: &[u8],
) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_bundle_with_compression_authenticated(bundle, &mut buf, compression, integrity_key)?;
    Ok(buf)
}

pub fn incremental_bundle_to_bytes_with_compression(
    bundle: &IncrementalSyncBundle,
    compression: BundleCompression,
) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_incremental_bundle_with_compression(bundle, &mut buf, compression)?;
    Ok(buf)
}

pub fn incremental_bundle_to_bytes_with_compression_authenticated(
    bundle: &IncrementalSyncBundle,
    compression: BundleCompression,
    integrity_key: &[u8],
) -> SyncResult<Vec<u8>> {
    let mut buf = Vec::new();
    write_incremental_bundle_with_compression_authenticated(
        bundle,
        &mut buf,
        compression,
        integrity_key,
    )?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// 文件读取
// ---------------------------------------------------------------------------

/// 从 reader 读取并验证 SyncBundle。
pub fn read_bundle(reader: &mut impl Read) -> SyncResult<SyncBundle> {
    read_bundle_with_limits(reader, BundleReadLimits::default())
}

pub fn read_bundle_with_limits(
    reader: &mut impl Read,
    limits: BundleReadLimits,
) -> SyncResult<SyncBundle> {
    match read_bundle_file_with_limits(reader, limits)? {
        SyncBundleFile::Complete(bundle) => Ok(bundle),
        SyncBundleFile::Incremental(_) => Err(SyncError::BundleFormat(
            "incremental bundle requires read_bundle_file_with_limits".to_string(),
        )),
    }
}

/// Read a complete bundle with the vault integrity key when the envelope is
/// authenticated. Legacy v1-v6 bundles remain accepted by this API.
pub fn read_bundle_authenticated(
    reader: &mut impl Read,
    integrity_key: &[u8],
) -> SyncResult<SyncBundle> {
    read_bundle_with_limits_authenticated(reader, BundleReadLimits::default(), integrity_key)
}

/// Read a complete bundle with bounded allocation and a supplied envelope key.
///
/// The legacy API passes no key and therefore continues to support v1-v6. An
/// authenticated v7-v10 envelope is rejected unless a valid key is supplied.
pub fn read_bundle_with_limits_authenticated(
    reader: &mut impl Read,
    limits: BundleReadLimits,
    integrity_key: &[u8],
) -> SyncResult<SyncBundle> {
    match read_bundle_file_with_limits_authenticated(reader, limits, integrity_key)? {
        SyncBundleFile::Complete(bundle) => Ok(bundle),
        SyncBundleFile::Incremental(_) => Err(SyncError::BundleFormat(
            "incremental bundle requires read_bundle_file_with_limits_authenticated".to_string(),
        )),
    }
}

/// Reads complete v1-v3/v5/v7/v9 or incremental v4/v6/v8/v10 bundles without
/// changing the legacy API. Authenticated versions require the keyed helper.
pub fn read_bundle_file(reader: &mut impl Read) -> SyncResult<SyncBundleFile> {
    read_bundle_file_with_limits(reader, BundleReadLimits::default())
}

pub fn read_bundle_file_with_limits(
    reader: &mut impl Read,
    limits: BundleReadLimits,
) -> SyncResult<SyncBundleFile> {
    read_bundle_file_with_limits_and_key(reader, limits, None)
}

/// Read any supported bundle, supplying the vault integrity key for v7-v10.
/// Legacy v1-v6 bundles are still accepted so callers can transparently apply
/// old exports while migrating to authenticated transport.
pub fn read_bundle_file_authenticated(
    reader: &mut impl Read,
    integrity_key: &[u8],
) -> SyncResult<SyncBundleFile> {
    read_bundle_file_with_limits_authenticated(reader, BundleReadLimits::default(), integrity_key)
}

pub fn read_bundle_file_with_limits_authenticated(
    reader: &mut impl Read,
    limits: BundleReadLimits,
    integrity_key: &[u8],
) -> SyncResult<SyncBundleFile> {
    validate_integrity_key(integrity_key)?;
    read_bundle_file_with_limits_and_key(reader, limits, Some(integrity_key))
}

fn read_bundle_file_with_limits_and_key(
    reader: &mut impl Read,
    limits: BundleReadLimits,
    integrity_key: Option<&[u8]>,
) -> SyncResult<SyncBundleFile> {
    let (version, payload_data) = read_bundle_payload(reader, limits, integrity_key)?;

    let bundle = if is_incremental_bundle_version(version) {
        let (bundle, bytes_read): (IncrementalSyncBundle, usize) =
            bincode::serde::decode_from_slice(
                &payload_data,
                bincode::config::standard().with_limit::<HARD_MAX_BUNDLE_PAYLOAD_BYTES_USIZE>(),
            )
            .map_err(|e| {
                SyncError::IoError(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
            })?;
        if bytes_read != payload_data.len() {
            return Err(SyncError::BundleFormat(format!(
                "trailing payload bytes: {}",
                payload_data.len() - bytes_read
            )));
        }
        bundle.validate()?;
        return Ok(SyncBundleFile::Incremental(Box::new(bundle)));
    } else if version == LEGACY_BUNDLE_VERSION {
        let (legacy, bytes_read): (LegacySyncBundleV1, usize) = bincode::serde::decode_from_slice(
            &payload_data,
            bincode::config::standard().with_limit::<HARD_MAX_BUNDLE_PAYLOAD_BYTES_USIZE>(),
        )
        .map_err(|e| SyncError::IoError(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        if bytes_read != payload_data.len() {
            return Err(SyncError::BundleFormat(format!(
                "trailing payload bytes: {}",
                payload_data.len() - bytes_read
            )));
        }
        SyncBundleFile::Complete(legacy.into())
    } else {
        let (bundle, bytes_read): (SyncBundle, usize) = bincode::serde::decode_from_slice(
            &payload_data,
            bincode::config::standard().with_limit::<HARD_MAX_BUNDLE_PAYLOAD_BYTES_USIZE>(),
        )
        .map_err(|e| SyncError::IoError(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
        if bytes_read != payload_data.len() {
            return Err(SyncError::BundleFormat(format!(
                "trailing payload bytes: {}",
                payload_data.len() - bytes_read
            )));
        }
        SyncBundleFile::Complete(bundle)
    };
    Ok(bundle)
}

fn read_bundle_payload(
    reader: &mut impl Read,
    limits: BundleReadLimits,
    integrity_key: Option<&[u8]>,
) -> SyncResult<(u32, Vec<u8>)> {
    // 读取 magic
    let mut magic = [0u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != BUNDLE_MAGIC {
        return Err(SyncError::BundleFormat("invalid magic bytes".to_string()));
    }

    // 读取 version
    let mut version_buf = [0u8; 4];
    reader.read_exact(&mut version_buf)?;
    let version = u32::from_le_bytes(version_buf);
    if !is_supported_bundle_version(version) {
        return Err(SyncError::BundleFormat(format!(
            "unsupported version: {version}; supported versions are {LEGACY_BUNDLE_VERSION} through {AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION}"
        )));
    }

    let authenticated = is_authenticated_bundle_version(version);
    let authenticated_key = if authenticated {
        let key = integrity_key.ok_or_else(|| {
            SyncError::BundleIntegrity("authenticated bundle requires an integrity key".to_string())
        })?;
        validate_integrity_key(key)?;
        Some(key)
    } else {
        None
    };

    let mut reserved = [0u8; BUNDLE_RESERVED_BYTES];
    reader.read_exact(&mut reserved)?;

    let body = match version {
        BUNDLE_VERSION | INCREMENTAL_BUNDLE_VERSION => {
            read_length_prefixed_body(reader, &reserved, limits, false)?
        }
        COMPRESSED_BUNDLE_VERSION | COMPRESSED_INCREMENTAL_BUNDLE_VERSION => {
            read_compressed_body(reader, &reserved, limits, false)?
        }
        AUTHENTICATED_BUNDLE_VERSION | AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION => {
            read_length_prefixed_body(reader, &reserved, limits, true)?
        }
        AUTHENTICATED_COMPRESSED_BUNDLE_VERSION
        | AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION => {
            read_compressed_body(reader, &reserved, limits, true)?
        }
        _ => read_legacy_body(reader, limits)?,
    };

    if let Some(key) = authenticated_key {
        let tag = body.auth_tag.as_ref().ok_or_else(|| {
            SyncError::BundleFormat("authenticated bundle is missing its HMAC trailer".to_string())
        })?;
        verify_bundle_auth_tag(key, version, &reserved, &body.stored_hash, tag)?;
    } else if body.auth_tag.is_some() {
        return Err(SyncError::BundleFormat(
            "legacy bundle unexpectedly contains an HMAC trailer".to_string(),
        ));
    }

    // 验证 hash
    let computed = {
        let mut h = Sha256::new();
        h.update(&body.payload);
        h.finalize()
    };
    if body.stored_hash.as_slice() != computed.as_slice() {
        return Err(SyncError::BundleIntegrity(
            "SHA-256 hash mismatch".to_string(),
        ));
    }

    Ok((version, body.payload))
}

#[cfg(feature = "zstd-compression")]
fn read_compressed_body(
    reader: &mut impl Read,
    reserved: &[u8; BUNDLE_RESERVED_BYTES],
    limits: BundleReadLimits,
    authenticated: bool,
) -> SyncResult<BundleBody> {
    if reserved[16..].iter().any(|byte| *byte != 0) {
        return Err(SyncError::BundleFormat(
            "non-zero reserved compressed bundle header bytes".to_string(),
        ));
    }
    let compressed_len = header_u64(&reserved[..8]);
    let uncompressed_len = header_u64(&reserved[8..16]);
    ensure_payload_resource_within_limit(
        "compressed sync bundle payload",
        compressed_len,
        limits.max_payload_bytes(),
    )?;
    ensure_payload_resource_within_limit(
        "uncompressed sync bundle payload",
        uncompressed_len,
        limits.max_payload_bytes(),
    )?;

    let BundleBody {
        payload: compressed,
        stored_hash,
        auth_tag,
    } = read_exact_body(reader, compressed_len, limits, authenticated)?;
    let output_read_limit = uncompressed_len
        .checked_add(1)
        .ok_or_else(|| SyncError::BundleFormat("bundle size limit overflow".to_string()))?;
    let mut decoder = zstd::stream::read::Decoder::new(std::io::Cursor::new(compressed))?;
    let mut payload = Vec::new();
    decoder
        .by_ref()
        .take(output_read_limit)
        .read_to_end(&mut payload)?;
    let actual_len = payload.len() as u64;
    if actual_len != uncompressed_len {
        if actual_len > limits.max_payload_bytes() {
            return Err(payload_limit_error(
                "uncompressed sync bundle payload",
                actual_len,
                limits.max_payload_bytes(),
            ));
        }
        return Err(SyncError::BundleFormat(format!(
            "compressed bundle expanded to {actual_len} bytes; header declares {uncompressed_len} bytes"
        )));
    }
    Ok(BundleBody {
        payload,
        stored_hash,
        auth_tag,
    })
}

#[cfg(not(feature = "zstd-compression"))]
fn read_compressed_body(
    _reader: &mut impl Read,
    _reserved: &[u8; BUNDLE_RESERVED_BYTES],
    _limits: BundleReadLimits,
    _authenticated: bool,
) -> SyncResult<BundleBody> {
    Err(zstd_unsupported())
}

fn header_u64(bytes: &[u8]) -> u64 {
    let mut value = [0u8; 8];
    value.copy_from_slice(bytes);
    u64::from_le_bytes(value)
}

fn read_exact_body(
    reader: &mut impl Read,
    payload_len: u64,
    limits: BundleReadLimits,
    authenticated: bool,
) -> SyncResult<BundleBody> {
    let payload_len_usize = usize::try_from(payload_len).map_err(|_| {
        payload_limit_error(
            "sync bundle payload",
            payload_len,
            limits.max_payload_bytes(),
        )
    })?;
    let mut payload = Vec::new();
    payload
        .try_reserve_exact(payload_len_usize)
        .map_err(|error| {
            SyncError::IoError(std::io::Error::new(
                std::io::ErrorKind::OutOfMemory,
                format!("unable to reserve sync bundle payload: {error}"),
            ))
        })?;
    payload.resize(payload_len_usize, 0);
    reader.read_exact(&mut payload)?;
    let mut stored_hash = [0u8; BUNDLE_HASH_BYTES];
    reader.read_exact(&mut stored_hash)?;
    let auth_tag = if authenticated {
        let mut tag = [0u8; BUNDLE_AUTH_TAG_BYTES];
        reader.read_exact(&mut tag)?;
        Some(tag)
    } else {
        None
    };
    let mut trailing = [0u8; 1];
    if reader.read(&mut trailing)? != 0 {
        return Err(SyncError::BundleFormat(
            "trailing bytes after bundle trailer".to_string(),
        ));
    }
    Ok(BundleBody {
        payload,
        stored_hash,
        auth_tag,
    })
}

fn read_length_prefixed_body(
    reader: &mut impl Read,
    reserved: &[u8; BUNDLE_RESERVED_BYTES],
    limits: BundleReadLimits,
    authenticated: bool,
) -> SyncResult<BundleBody> {
    if reserved[8..].iter().any(|byte| *byte != 0) {
        return Err(SyncError::BundleFormat(
            "non-zero reserved bundle header bytes".to_string(),
        ));
    }
    let payload_len = header_u64(&reserved[..8]);
    ensure_payload_within_limit(payload_len, limits.max_payload_bytes())?;
    read_exact_body(reader, payload_len, limits, authenticated)
}

fn read_legacy_body(reader: &mut impl Read, limits: BundleReadLimits) -> SyncResult<BundleBody> {
    let body_limit = limits
        .max_payload_bytes()
        .checked_add(BUNDLE_HASH_BYTES as u64)
        .ok_or_else(|| SyncError::BundleFormat("bundle size limit overflow".to_string()))?;
    let read_limit = body_limit
        .checked_add(1)
        .ok_or_else(|| SyncError::BundleFormat("bundle size limit overflow".to_string()))?;
    let mut body = Vec::new();
    reader.take(read_limit).read_to_end(&mut body)?;
    if body.len() as u64 > body_limit {
        return Err(SyncError::ResourceLimit {
            resource: "legacy sync bundle payload".to_string(),
            actual: limits.max_payload_bytes().saturating_add(1),
            limit: limits.max_payload_bytes(),
        });
    }
    if body.len() < BUNDLE_HASH_BYTES {
        return Err(SyncError::BundleFormat(
            "payload too short (missing hash)".to_string(),
        ));
    }
    let hash_offset = body.len() - BUNDLE_HASH_BYTES;
    let mut stored_hash = [0u8; BUNDLE_HASH_BYTES];
    stored_hash.copy_from_slice(&body[hash_offset..]);
    body.truncate(hash_offset);
    ensure_payload_within_limit(body.len() as u64, limits.max_payload_bytes())?;
    Ok(BundleBody {
        payload: body,
        stored_hash,
        auth_tag: None,
    })
}

fn is_supported_bundle_version(version: u32) -> bool {
    matches!(
        version,
        LEGACY_BUNDLE_VERSION
            | PREVIOUS_BUNDLE_VERSION
            | BUNDLE_VERSION
            | INCREMENTAL_BUNDLE_VERSION
            | COMPRESSED_BUNDLE_VERSION
            | COMPRESSED_INCREMENTAL_BUNDLE_VERSION
            | AUTHENTICATED_BUNDLE_VERSION
            | AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION
            | AUTHENTICATED_COMPRESSED_BUNDLE_VERSION
            | AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION
    )
}

fn is_authenticated_bundle_version(version: u32) -> bool {
    matches!(
        version,
        AUTHENTICATED_BUNDLE_VERSION
            | AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION
            | AUTHENTICATED_COMPRESSED_BUNDLE_VERSION
            | AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION
    )
}

fn is_incremental_bundle_version(version: u32) -> bool {
    matches!(
        version,
        INCREMENTAL_BUNDLE_VERSION
            | COMPRESSED_INCREMENTAL_BUNDLE_VERSION
            | AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION
            | AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION
    )
}

fn ensure_payload_within_limit(actual: u64, limit: u64) -> SyncResult<()> {
    ensure_payload_resource_within_limit("sync bundle payload", actual, limit)
}

fn ensure_payload_resource_within_limit(resource: &str, actual: u64, limit: u64) -> SyncResult<()> {
    if actual > limit {
        return Err(payload_limit_error(resource, actual, limit));
    }
    Ok(())
}

/// 从字节数组读取 SyncBundle。
pub fn bundle_from_bytes(data: &[u8]) -> SyncResult<SyncBundle> {
    let mut cursor = std::io::Cursor::new(data);
    read_bundle(&mut cursor)
}

pub fn bundle_from_bytes_authenticated(
    data: &[u8],
    integrity_key: &[u8],
) -> SyncResult<SyncBundle> {
    let mut cursor = std::io::Cursor::new(data);
    read_bundle_authenticated(&mut cursor, integrity_key)
}

pub fn bundle_file_from_bytes(data: &[u8]) -> SyncResult<SyncBundleFile> {
    let mut cursor = std::io::Cursor::new(data);
    read_bundle_file(&mut cursor)
}

pub fn bundle_file_from_bytes_authenticated(
    data: &[u8],
    integrity_key: &[u8],
) -> SyncResult<SyncBundleFile> {
    let mut cursor = std::io::Cursor::new(data);
    read_bundle_file_authenticated(&mut cursor, integrity_key)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{CommitOperationMetadata, ObjectPayload};
    use mdbx_core::model::Commit;

    struct FailingWriter {
        written: usize,
        fail_after: usize,
    }

    impl Write for FailingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.written >= self.fail_after {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "simulated destination failure",
                ));
            }
            let allowed = (self.fail_after - self.written).min(buf.len());
            self.written += allowed;
            Ok(allowed)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn sample_bundle() -> SyncBundle {
        SyncBundle {
            exported_at: "2026-05-21T00:00:00Z".to_string(),
            source_device_id: "test-device".to_string(),
            vault_id: "test-vault".to_string(),
            commits: vec![SerializedCommit {
                commit: Commit {
                    commit_id: "commit-1".to_string(),
                    commit_kind: mdbx_core::model::CommitKind::Change,
                    change_scope: mdbx_core::model::ChangeScope::Entry,
                    device_id: "test-device".to_string(),
                    local_seq: 1,
                    changed_object_ids_ct: vec![],
                    vector_clock: r#"{"counter":1}"#.to_string(),
                    message_ct: None,
                    created_at: "2026-05-21T00:00:00Z".to_string(),
                    integrity_tag: vec![],
                },
                operation: None,
                parent_ids: vec!["genesis".to_string()],
                tombstones: vec![],
                object_payloads: vec![ObjectPayload {
                    object_type: "entry".to_string(),
                    object_id: "entry-1".to_string(),
                    ciphertext: b"encrypted-bytes".to_vec(),
                    associated_data: b"entry:entry-1:payload".to_vec(),
                }],
            }],
        }
    }

    fn sample_incremental_bundle() -> IncrementalSyncBundle {
        let mut commit = sample_bundle().commits.remove(0);
        let commit_delta = ObjectPayload {
            object_type: "mdbx-storage/state-delta-v1".to_string(),
            object_id: "delta-commit-1".to_string(),
            ciphertext: b"commit-delta-envelope".to_vec(),
            associated_data: b"delta-commit-1".to_vec(),
        };
        let auxiliary_delta = ObjectPayload {
            object_type: "mdbx-storage/state-delta-v1".to_string(),
            object_id: "delta-aux-1".to_string(),
            ciphertext: b"auxiliary-delta-envelope".to_vec(),
            associated_data: b"delta-aux-1".to_vec(),
        };
        let commit_digest = Sha256::digest(&commit_delta.ciphertext).to_vec();
        let auxiliary_digest = Sha256::digest(&auxiliary_delta.ciphertext).to_vec();
        commit.object_payloads.push(commit_delta);

        IncrementalSyncBundle {
            manifest: IncrementalBundleManifest {
                format: INCREMENTAL_BUNDLE_FORMAT.to_string(),
                vault_id: "test-vault".to_string(),
                source_device_id: "test-device".to_string(),
                exported_at: "2026-07-21T00:00:00Z".to_string(),
                transfer_id: "transfer-1".to_string(),
                segment_index: 0,
                previous_segment_sha256: None,
                is_last: true,
                base: IncrementalBundleCheckpoint {
                    commit_inventory: None,
                    delta_inventory: None,
                },
                result: IncrementalBundleCheckpoint {
                    commit_inventory: Some("commit-checkpoint-result".to_string()),
                    delta_inventory: Some("delta-checkpoint-result".to_string()),
                },
                commit_inventory: vec![IncrementalCommitInventoryEntry {
                    inventory_seq: 2,
                    commit_id: "commit-1".to_string(),
                }],
                delta_inventory: vec![
                    IncrementalDeltaInventoryEntry {
                        batch_seq: 1,
                        batch_id: "delta-commit-1".to_string(),
                        batch_kind: IncrementalDeltaKind::Commit,
                        commit_ids: vec!["commit-1".to_string()],
                        object_payload_sha256: commit_digest,
                    },
                    IncrementalDeltaInventoryEntry {
                        batch_seq: 2,
                        batch_id: "delta-aux-1".to_string(),
                        batch_kind: IncrementalDeltaKind::Auxiliary,
                        commit_ids: vec![],
                        object_payload_sha256: auxiliary_digest,
                    },
                ],
            },
            commits: vec![commit],
            auxiliary_deltas: vec![auxiliary_delta],
        }
    }

    fn legacy_bundle_bytes() -> Vec<u8> {
        let current = sample_bundle();
        let legacy = LegacySyncBundleV1 {
            exported_at: current.exported_at,
            source_device_id: current.source_device_id,
            vault_id: current.vault_id,
            commits: current
                .commits
                .into_iter()
                .map(|commit| LegacySerializedCommitV1 {
                    commit: commit.commit,
                    parent_ids: commit.parent_ids,
                    tombstones: commit.tombstones,
                    object_payloads: commit.object_payloads,
                })
                .collect(),
        };
        let payload = bincode::serde::encode_to_vec(legacy, bincode::config::standard()).unwrap();
        let hash = Sha256::digest(&payload);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(BUNDLE_MAGIC);
        bytes.extend_from_slice(&LEGACY_BUNDLE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&[0_u8; 20]);
        bytes.extend_from_slice(&payload);
        bytes.extend_from_slice(&hash);
        bytes
    }

    fn previous_v2_bundle_bytes() -> Vec<u8> {
        let payload =
            bincode::serde::encode_to_vec(sample_bundle(), bincode::config::standard()).unwrap();
        let hash = Sha256::digest(&payload);
        let mut bytes = Vec::new();
        bytes.extend_from_slice(BUNDLE_MAGIC);
        bytes.extend_from_slice(&PREVIOUS_BUNDLE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&[0_u8; BUNDLE_RESERVED_BYTES]);
        bytes.extend_from_slice(&payload);
        bytes.extend_from_slice(&hash);
        bytes
    }

    fn declared_payload_len(bytes: &[u8]) -> u64 {
        let mut value = [0u8; 8];
        value.copy_from_slice(&bytes[12..20]);
        u64::from_le_bytes(value)
    }

    fn auth_test_key() -> [u8; BUNDLE_AUTH_KEY_BYTES] {
        [0x42; BUNDLE_AUTH_KEY_BYTES]
    }

    #[cfg(feature = "zstd-compression")]
    fn declared_uncompressed_len(bytes: &[u8]) -> u64 {
        let mut value = [0u8; 8];
        value.copy_from_slice(&bytes[20..28]);
        u64::from_le_bytes(value)
    }

    #[test]
    fn test_bundle_roundtrip() {
        let bundle = sample_bundle();
        let bytes = bundle_to_bytes(&bundle).unwrap();
        assert!(bytes.len() > 64);
        assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 3);
        assert_eq!(declared_payload_len(&bytes) as usize, bytes.len() - 64);

        let restored = bundle_from_bytes(&bytes).unwrap();
        assert_eq!(restored.vault_id, bundle.vault_id);
        assert_eq!(restored.source_device_id, bundle.source_device_id);
        assert_eq!(restored.commits.len(), 1);
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");
    }

    #[test]
    fn bundle_roundtrip_preserves_extended_commit_kinds() {
        for kind in [
            mdbx_core::model::CommitKind::Move,
            mdbx_core::model::CommitKind::Copy,
            mdbx_core::model::CommitKind::Restore,
            mdbx_core::model::CommitKind::Multi,
        ] {
            let mut bundle = sample_bundle();
            bundle.commits[0].commit.commit_kind = kind.clone();

            let bytes = bundle_to_bytes(&bundle).unwrap();
            let restored = bundle_from_bytes(&bytes).unwrap();

            assert_eq!(restored.commits[0].commit.commit_kind, kind);
        }
    }

    #[test]
    fn bundle_roundtrip_preserves_all_change_scopes() {
        for scope in [
            mdbx_core::model::ChangeScope::Project,
            mdbx_core::model::ChangeScope::Entry,
            mdbx_core::model::ChangeScope::Attachment,
            mdbx_core::model::ChangeScope::ObjectRelation,
            mdbx_core::model::ChangeScope::ObjectLabel,
            mdbx_core::model::ChangeScope::ObjectLabelAssignment,
            mdbx_core::model::ChangeScope::VaultMeta,
            mdbx_core::model::ChangeScope::KeyEpoch,
            mdbx_core::model::ChangeScope::Multi,
            mdbx_core::model::ChangeScope::Snapshot,
            mdbx_core::model::ChangeScope::Branch,
        ] {
            let mut bundle = sample_bundle();
            bundle.commits[0].commit.change_scope = scope.clone();

            let bytes = bundle_to_bytes(&bundle).unwrap();
            let restored = bundle_from_bytes(&bytes).unwrap();

            assert_eq!(restored.commits[0].commit.change_scope, scope);
        }
    }

    #[test]
    fn bundle_roundtrip_preserves_versioned_operation_request_identity() {
        let mut bundle = sample_bundle();
        let mut request_identity = b"MDBXORI1".to_vec();
        request_identity.extend(0_u8..32);
        bundle.commits[0].operation = Some(CommitOperationMetadata {
            operation_id: "operation-1".to_string(),
            operation_kind: "edit-session".to_string(),
            branch_id: Some("branch-1".to_string()),
            branch_name: "main".to_string(),
            change_summary_ct: vec![1, 2, 3],
            request_hash: request_identity.clone(),
            integrity_tag: vec![4, 5, 6],
        });

        let bytes = bundle_to_bytes(&bundle).unwrap();
        let restored = bundle_from_bytes(&bytes).unwrap();

        assert_eq!(
            restored.commits[0].operation.as_ref().unwrap().request_hash,
            request_identity
        );
    }

    #[test]
    fn commit_kind_binary_discriminants_keep_legacy_order() {
        let cases = [
            (mdbx_core::model::CommitKind::Change, 0_u8),
            (mdbx_core::model::CommitKind::Merge, 1),
            (mdbx_core::model::CommitKind::Snapshot, 2),
            (mdbx_core::model::CommitKind::KeyRotation, 3),
            (mdbx_core::model::CommitKind::Move, 4),
            (mdbx_core::model::CommitKind::Copy, 5),
            (mdbx_core::model::CommitKind::Restore, 6),
            (mdbx_core::model::CommitKind::Multi, 7),
        ];

        for (kind, discriminant) in cases {
            assert_eq!(
                bincode::serde::encode_to_vec(&kind, bincode::config::standard()).unwrap(),
                vec![discriminant]
            );
        }
    }

    #[test]
    fn change_scope_binary_discriminants_keep_legacy_order() {
        let cases = [
            (mdbx_core::model::ChangeScope::Project, 0_u8),
            (mdbx_core::model::ChangeScope::Entry, 1),
            (mdbx_core::model::ChangeScope::Attachment, 2),
            (mdbx_core::model::ChangeScope::ObjectRelation, 3),
            (mdbx_core::model::ChangeScope::ObjectLabel, 4),
            (mdbx_core::model::ChangeScope::ObjectLabelAssignment, 5),
            (mdbx_core::model::ChangeScope::VaultMeta, 6),
            (mdbx_core::model::ChangeScope::KeyEpoch, 7),
            (mdbx_core::model::ChangeScope::Multi, 8),
            (mdbx_core::model::ChangeScope::Snapshot, 9),
            (mdbx_core::model::ChangeScope::Branch, 10),
        ];

        for (scope, discriminant) in cases {
            assert_eq!(
                bincode::serde::encode_to_vec(&scope, bincode::config::standard()).unwrap(),
                vec![discriminant]
            );
        }
    }

    #[test]
    fn authenticated_v7_complete_round_trip_and_tamper_detection() {
        let bundle = sample_bundle();
        let key = auth_test_key();
        let bytes = bundle_to_bytes_authenticated(&bundle, &key).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            AUTHENTICATED_BUNDLE_VERSION
        );
        assert_eq!(declared_payload_len(&bytes) as usize, bytes.len() - 96);

        let restored = bundle_from_bytes_authenticated(&bytes, &key).unwrap();
        assert_eq!(restored.vault_id, bundle.vault_id);
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");

        let missing_key = bundle_from_bytes(&bytes).unwrap_err();
        assert!(missing_key.to_string().contains("integrity key"));
        assert!(matches!(
            bundle_from_bytes_authenticated(&bytes, &[0_u8; BUNDLE_AUTH_KEY_BYTES]),
            Err(SyncError::BundleIntegrity(_))
        ));

        let mut tampered_tag = bytes.clone();
        *tampered_tag.last_mut().unwrap() ^= 1;
        assert!(matches!(
            bundle_from_bytes_authenticated(&tampered_tag, &key),
            Err(SyncError::BundleIntegrity(_))
        ));

        let mut tampered_payload = bytes.clone();
        tampered_payload[32] ^= 1;
        assert!(matches!(
            bundle_from_bytes_authenticated(&tampered_payload, &key),
            Err(SyncError::BundleIntegrity(_))
        ));

        let mut tampered_version = bytes;
        tampered_version[8..12]
            .copy_from_slice(&AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION.to_le_bytes());
        assert!(matches!(
            bundle_from_bytes_authenticated(&tampered_version, &key),
            Err(SyncError::BundleIntegrity(_))
        ));

        let mut tampered_header = bundle_to_bytes_authenticated(&bundle, &key).unwrap();
        tampered_header[20] = 1;
        assert!(matches!(
            bundle_from_bytes_authenticated(&tampered_header, &key),
            Err(SyncError::BundleFormat(_))
        ));

        let mut trailing = bundle_to_bytes_authenticated(&bundle, &key).unwrap();
        trailing.push(0);
        assert!(bundle_from_bytes_authenticated(&trailing, &key)
            .unwrap_err()
            .to_string()
            .contains("trailing bytes"));
    }

    #[test]
    fn authenticated_v8_incremental_round_trip_and_legacy_fallback() {
        let bundle = sample_incremental_bundle();
        let key = auth_test_key();
        let bytes = incremental_bundle_to_bytes_authenticated(&bundle, &key).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION
        );
        assert_eq!(declared_payload_len(&bytes) as usize, bytes.len() - 96);

        match bundle_file_from_bytes_authenticated(&bytes, &key).unwrap() {
            SyncBundleFile::Incremental(restored) => {
                assert_eq!(restored.manifest.transfer_id, "transfer-1");
                assert_eq!(restored.commits.len(), 1);
            }
            SyncBundleFile::Complete(_) => panic!("v8 decoded as complete"),
        }

        for legacy in [
            legacy_bundle_bytes(),
            previous_v2_bundle_bytes(),
            bundle_to_bytes(&sample_bundle()).unwrap(),
        ] {
            match bundle_file_from_bytes_authenticated(&legacy, &key).unwrap() {
                SyncBundleFile::Complete(restored) => assert_eq!(restored.commits.len(), 1),
                SyncBundleFile::Incremental(_) => panic!("legacy complete decoded as incremental"),
            }
        }
        let legacy_incremental = incremental_bundle_to_bytes(&bundle).unwrap();
        match bundle_file_from_bytes_authenticated(&legacy_incremental, &key).unwrap() {
            SyncBundleFile::Incremental(restored) => {
                assert_eq!(restored.manifest.transfer_id, "transfer-1");
            }
            SyncBundleFile::Complete(_) => panic!("v4 decoded as complete"),
        }
    }

    #[test]
    fn bundle_v4_round_trips_with_manifest_and_keeps_legacy_reader_explicit() {
        let bundle = sample_incremental_bundle();
        let bytes = incremental_bundle_to_bytes(&bundle).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            INCREMENTAL_BUNDLE_VERSION
        );
        assert_eq!(declared_payload_len(&bytes) as usize, bytes.len() - 64);
        assert_eq!(
            incremental_bundle_payload_sha256(&bundle).unwrap(),
            bytes[bytes.len() - BUNDLE_HASH_BYTES..]
        );

        let restored = bundle_file_from_bytes(&bytes).unwrap();
        match restored {
            SyncBundleFile::Incremental(restored) => {
                assert_eq!(restored.manifest.transfer_id, "transfer-1");
                assert_eq!(restored.manifest.commit_inventory.len(), 1);
                assert_eq!(restored.manifest.delta_inventory.len(), 2);
                assert_eq!(restored.auxiliary_deltas.len(), 1);
            }
            SyncBundleFile::Complete(_) => panic!("v4 decoded as a complete bundle"),
        }
        assert!(bundle_from_bytes(&bytes)
            .unwrap_err()
            .to_string()
            .contains("read_bundle_file_with_limits"));

        match bundle_file_from_bytes(&bundle_to_bytes(&sample_bundle()).unwrap()).unwrap() {
            SyncBundleFile::Complete(restored) => assert_eq!(restored.commits.len(), 1),
            SyncBundleFile::Incremental(_) => panic!("v3 decoded as incremental"),
        }
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn compressed_v5_complete_bundle_round_trips() {
        let bundle = sample_bundle();
        let bytes = bundle_to_bytes_with_compression(&bundle, BundleCompression::Zstd).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            COMPRESSED_BUNDLE_VERSION
        );
        assert_eq!(declared_payload_len(&bytes) as usize, bytes.len() - 64);
        assert!(declared_uncompressed_len(&bytes) > 0);

        let restored = bundle_from_bytes(&bytes).unwrap();
        assert_eq!(restored.vault_id, bundle.vault_id);
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn compressed_v6_incremental_bundle_round_trips_with_logical_hash() {
        let bundle = sample_incremental_bundle();
        let bytes =
            incremental_bundle_to_bytes_with_compression(&bundle, BundleCompression::Zstd).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            COMPRESSED_INCREMENTAL_BUNDLE_VERSION
        );
        assert_eq!(
            incremental_bundle_payload_sha256(&bundle).unwrap(),
            bytes[bytes.len() - BUNDLE_HASH_BYTES..]
        );

        match bundle_file_from_bytes(&bytes).unwrap() {
            SyncBundleFile::Incremental(restored) => {
                assert_eq!(restored.manifest.transfer_id, "transfer-1");
                assert_eq!(restored.manifest.commit_inventory.len(), 1);
            }
            SyncBundleFile::Complete(_) => panic!("v6 decoded as a complete bundle"),
        }
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn authenticated_v9_and_v10_zstd_bundles_round_trip() {
        let key = auth_test_key();
        let complete = sample_bundle();
        let complete_bytes = bundle_to_bytes_with_compression_authenticated(
            &complete,
            BundleCompression::Zstd,
            &key,
        )
        .unwrap();
        assert_eq!(
            u32::from_le_bytes(complete_bytes[8..12].try_into().unwrap()),
            AUTHENTICATED_COMPRESSED_BUNDLE_VERSION
        );
        assert_eq!(
            declared_payload_len(&complete_bytes) as usize,
            complete_bytes.len() - 96
        );
        let restored = bundle_from_bytes_authenticated(&complete_bytes, &key).unwrap();
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");

        let incremental = sample_incremental_bundle();
        let incremental_bytes = incremental_bundle_to_bytes_with_compression_authenticated(
            &incremental,
            BundleCompression::Zstd,
            &key,
        )
        .unwrap();
        assert_eq!(
            u32::from_le_bytes(incremental_bytes[8..12].try_into().unwrap()),
            AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION
        );
        assert_eq!(
            incremental_bundle_payload_sha256(&incremental).unwrap(),
            incremental_bytes[incremental_bytes.len() - 64..incremental_bytes.len() - 32]
        );
        match bundle_file_from_bytes_authenticated(&incremental_bytes, &key).unwrap() {
            SyncBundleFile::Incremental(restored) => {
                assert_eq!(restored.manifest.transfer_id, "transfer-1");
            }
            SyncBundleFile::Complete(_) => panic!("v10 decoded as complete"),
        }

        let legacy_complete =
            bundle_to_bytes_with_compression(&complete, BundleCompression::Zstd).unwrap();
        assert!(matches!(
            bundle_file_from_bytes_authenticated(&legacy_complete, &key).unwrap(),
            SyncBundleFile::Complete(_)
        ));
        let legacy_incremental =
            incremental_bundle_to_bytes_with_compression(&incremental, BundleCompression::Zstd)
                .unwrap();
        assert!(matches!(
            bundle_file_from_bytes_authenticated(&legacy_incremental, &key).unwrap(),
            SyncBundleFile::Incremental(_)
        ));
    }

    #[test]
    fn authenticated_bundle_rejects_invalid_key_lengths() {
        let bundle = sample_bundle();
        assert!(matches!(
            bundle_to_bytes_authenticated(&bundle, &[1, 2, 3]),
            Err(SyncError::BundleFormat(message)) if message.contains("32 bytes")
        ));
        let bytes = bundle_to_bytes_authenticated(&bundle, &auth_test_key()).unwrap();
        assert!(matches!(
            bundle_from_bytes_authenticated(&bytes, &[1, 2, 3]),
            Err(SyncError::BundleFormat(message)) if message.contains("32 bytes")
        ));
    }

    #[test]
    fn legacy_writer_versions_remain_v3_and_v4() {
        let complete = bundle_to_bytes(&sample_bundle()).unwrap();
        let incremental = incremental_bundle_to_bytes(&sample_incremental_bundle()).unwrap();
        assert_eq!(
            u32::from_le_bytes(complete[8..12].try_into().unwrap()),
            BUNDLE_VERSION
        );
        assert_eq!(
            u32::from_le_bytes(incremental[8..12].try_into().unwrap()),
            INCREMENTAL_BUNDLE_VERSION
        );
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn compressed_bundle_enforces_both_declared_lengths_before_allocation() {
        let bytes =
            bundle_to_bytes_with_compression(&sample_bundle(), BundleCompression::Zstd).unwrap();
        let compressed_len = declared_payload_len(&bytes);
        let uncompressed_len = declared_uncompressed_len(&bytes);

        let compressed_limit = BundleReadLimits::new(compressed_len - 1).unwrap();
        assert!(matches!(
            read_bundle_with_limits(&mut std::io::Cursor::new(&bytes), compressed_limit),
            Err(SyncError::ResourceLimit { ref resource, .. })
                if resource == "compressed sync bundle payload"
        ));

        let uncompressed_limit = BundleReadLimits::new(uncompressed_len - 1).unwrap();
        assert!(matches!(
            read_bundle_with_limits(&mut std::io::Cursor::new(&bytes), uncompressed_limit),
            Err(SyncError::ResourceLimit { ref resource, .. })
                if resource == "uncompressed sync bundle payload"
        ));
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn compressed_bundle_rejects_tampered_uncompressed_length() {
        let mut bytes =
            bundle_to_bytes_with_compression(&sample_bundle(), BundleCompression::Zstd).unwrap();
        let tampered = declared_uncompressed_len(&bytes) + 1;
        bytes[20..28].copy_from_slice(&tampered.to_le_bytes());

        let error = bundle_from_bytes(&bytes).unwrap_err();
        assert!(error.to_string().contains("header declares"));
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn compressed_bundle_caps_decompression_expansion() {
        let compressed = zstd::stream::encode_all(std::io::Cursor::new(vec![0u8; 256]), 0).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(BUNDLE_MAGIC);
        bytes.extend_from_slice(&COMPRESSED_BUNDLE_VERSION.to_le_bytes());
        let mut reserved = [0u8; BUNDLE_RESERVED_BYTES];
        reserved[..8].copy_from_slice(&(compressed.len() as u64).to_le_bytes());
        reserved[8..16].copy_from_slice(&64_u64.to_le_bytes());
        bytes.extend_from_slice(&reserved);
        bytes.extend_from_slice(&compressed);
        bytes.extend_from_slice(&[0u8; BUNDLE_HASH_BYTES]);

        let limits = BundleReadLimits::new(64).unwrap();
        let error = read_bundle_with_limits(&mut std::io::Cursor::new(bytes), limits).unwrap_err();
        assert!(matches!(
            error,
            SyncError::ResourceLimit {
                ref resource,
                actual: 65,
                limit: 64
            } if resource == "uncompressed sync bundle payload"
        ));
    }

    #[cfg(feature = "zstd-compression")]
    #[test]
    fn compressed_bundle_rejects_corrupted_stream() {
        let mut bytes =
            bundle_to_bytes_with_compression(&sample_bundle(), BundleCompression::Zstd).unwrap();
        bytes[32] ^= 0xff;
        assert!(bundle_from_bytes(&bytes).is_err());
    }

    #[cfg(not(feature = "zstd-compression"))]
    #[test]
    fn compressed_bundle_requires_optional_feature() {
        assert!(matches!(
            bundle_to_bytes_with_compression(&sample_bundle(), BundleCompression::Zstd),
            Err(SyncError::UnsupportedFeature(ref feature)) if feature == "zstd-compression"
        ));
        assert!(matches!(
            bundle_to_bytes_with_compression_authenticated(
                &sample_bundle(),
                BundleCompression::Zstd,
                &auth_test_key(),
            ),
            Err(SyncError::UnsupportedFeature(ref feature)) if feature == "zstd-compression"
        ));

        let mut bytes = Vec::new();
        bytes.extend_from_slice(BUNDLE_MAGIC);
        bytes.extend_from_slice(&COMPRESSED_BUNDLE_VERSION.to_le_bytes());
        bytes.extend_from_slice(&[0u8; BUNDLE_RESERVED_BYTES]);
        assert!(matches!(
            bundle_from_bytes(&bytes),
            Err(SyncError::UnsupportedFeature(ref feature)) if feature == "zstd-compression"
        ));

        bytes[8..12].copy_from_slice(&AUTHENTICATED_COMPRESSED_BUNDLE_VERSION.to_le_bytes());
        assert!(matches!(
            bundle_from_bytes_authenticated(&bytes, &auth_test_key()),
            Err(SyncError::UnsupportedFeature(ref feature)) if feature == "zstd-compression"
        ));
    }

    #[test]
    fn bundle_v4_rejects_inventory_reordering_and_delta_tampering() {
        let mut bundle = sample_incremental_bundle();
        bundle.manifest.delta_inventory.swap(0, 1);
        assert!(bundle
            .validate()
            .unwrap_err()
            .to_string()
            .contains("strictly increasing"));

        let mut bundle = sample_incremental_bundle();
        bundle.commits[0]
            .object_payloads
            .iter_mut()
            .find(|payload| payload.object_id == "delta-commit-1")
            .unwrap()
            .ciphertext[0] ^= 1;
        assert!(matches!(
            bundle.validate(),
            Err(SyncError::BundleIntegrity(_))
        ));

        let mut bundle = sample_incremental_bundle();
        bundle.auxiliary_deltas.clear();
        assert!(bundle
            .validate()
            .unwrap_err()
            .to_string()
            .contains("missing its object payload"));
    }

    #[test]
    fn bundle_v4_validates_checkpoint_pairs_resume_chain_and_counts() {
        let mut bundle = sample_incremental_bundle();
        bundle.manifest.base.commit_inventory = Some("commit-base".to_string());
        assert!(bundle
            .validate()
            .unwrap_err()
            .to_string()
            .contains("base checkpoint is incomplete"));

        let mut bundle = sample_incremental_bundle();
        bundle.manifest.segment_index = 1;
        assert!(bundle
            .validate()
            .unwrap_err()
            .to_string()
            .contains("previous-segment digest"));
        bundle.manifest.previous_segment_sha256 = Some(vec![7; 32]);
        bundle.validate().unwrap();

        let mut bundle = sample_incremental_bundle();
        bundle.manifest.commit_inventory = (1..=MAX_INCREMENTAL_BUNDLE_COMMITS + 1)
            .map(|index| IncrementalCommitInventoryEntry {
                inventory_seq: index as u64,
                commit_id: format!("commit-{index}"),
            })
            .collect();
        assert!(matches!(
            bundle.validate(),
            Err(SyncError::ResourceLimit { ref resource, .. })
                if resource == "incremental bundle commits"
        ));

        let mut bundle = sample_incremental_bundle();
        bundle.manifest.delta_inventory[0].commit_ids = (0..=MAX_INCREMENTAL_BUNDLE_COMMITS)
            .map(|index| format!("associated-{index}"))
            .collect();
        assert!(matches!(
            bundle.validate(),
            Err(SyncError::ResourceLimit { ref resource, .. })
                if resource == "incremental delta commit associations"
        ));
    }

    #[test]
    fn test_legacy_v1_bundle_is_upgraded_without_operation_metadata() {
        let restored = bundle_from_bytes(&legacy_bundle_bytes()).unwrap();
        assert_eq!(restored.commits.len(), 1);
        assert!(restored.commits[0].operation.is_none());
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");
    }

    #[test]
    fn test_previous_v2_bundle_remains_readable() {
        let restored = bundle_from_bytes(&previous_v2_bundle_bytes()).unwrap();
        assert_eq!(restored.commits.len(), 1);
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");
    }

    #[test]
    fn bounded_bundle_v3_rejects_declared_length_before_allocation() {
        let limits = BundleReadLimits::new(64).unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(BUNDLE_MAGIC);
        bytes.extend_from_slice(&BUNDLE_VERSION.to_le_bytes());
        let mut reserved = [0u8; BUNDLE_RESERVED_BYTES];
        reserved[..8].copy_from_slice(&65_u64.to_le_bytes());
        bytes.extend_from_slice(&reserved);

        let error = read_bundle_with_limits(&mut std::io::Cursor::new(bytes), limits).unwrap_err();

        assert!(matches!(
            error,
            SyncError::ResourceLimit {
                actual: 65,
                limit: 64,
                ..
            }
        ));
    }

    #[test]
    fn bounded_bundle_v3_enforces_custom_limit_and_accepts_exact_size() {
        let bytes = bundle_to_bytes(&sample_bundle()).unwrap();
        let payload_len = declared_payload_len(&bytes);
        let too_small = BundleReadLimits::new(payload_len - 1).unwrap();
        assert!(matches!(
            read_bundle_with_limits(&mut std::io::Cursor::new(&bytes), too_small),
            Err(SyncError::ResourceLimit { .. })
        ));

        let exact = BundleReadLimits::new(payload_len).unwrap();
        let restored = read_bundle_with_limits(&mut std::io::Cursor::new(bytes), exact).unwrap();
        assert_eq!(restored.commits[0].commit.commit_id, "commit-1");
    }

    #[test]
    fn bounded_bundle_legacy_reader_stops_at_configured_limit() {
        let bytes = previous_v2_bundle_bytes();
        let limits = BundleReadLimits::new(16).unwrap();

        let error = read_bundle_with_limits(&mut std::io::Cursor::new(bytes), limits).unwrap_err();

        assert!(matches!(
            error,
            SyncError::ResourceLimit {
                actual: 17,
                limit: 16,
                ..
            }
        ));
    }

    #[test]
    fn bounded_bundle_v3_rejects_reserved_and_trailing_bytes() {
        let bytes = bundle_to_bytes(&sample_bundle()).unwrap();
        let mut reserved = bytes.clone();
        reserved[20] = 1;
        assert!(bundle_from_bytes(&reserved)
            .unwrap_err()
            .to_string()
            .contains("reserved"));

        let mut trailing = bytes;
        trailing.push(0);
        assert!(bundle_from_bytes(&trailing)
            .unwrap_err()
            .to_string()
            .contains("trailing bytes"));
    }

    #[test]
    fn bounded_bundle_limits_reject_invalid_configuration() {
        assert!(BundleReadLimits::new(0).is_err());
        assert!(BundleReadLimits::new(HARD_MAX_BUNDLE_PAYLOAD_BYTES + 1).is_err());
        assert_eq!(
            BundleReadLimits::desktop().max_payload_bytes(),
            DESKTOP_MAX_BUNDLE_PAYLOAD_BYTES
        );
    }

    #[test]
    fn bounded_bundle_streaming_write_preserves_destination_errors() {
        let mut writer = FailingWriter {
            written: 0,
            fail_after: 32,
        };

        let error = write_bundle(&sample_bundle(), &mut writer).unwrap_err();

        assert!(matches!(
            error,
            SyncError::IoError(ref inner)
                if inner.kind() == std::io::ErrorKind::PermissionDenied
        ));
    }

    #[test]
    fn bounded_bundle_counting_writer_stops_before_exceeding_limit() {
        let mut writer = LimitedCountingWriter::new(4);
        assert_eq!(writer.write(b"1234").unwrap(), 4);
        assert!(writer.write(b"5").is_err());
        assert_eq!(writer.bytes_written(), 4);
        assert_eq!(writer.exceeded_at(), Some(5));
    }

    #[test]
    fn test_magic_validation() {
        let mut bytes = bundle_to_bytes(&sample_bundle()).unwrap();
        bytes[0] = b'X';
        let result = bundle_from_bytes(&bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_version_validation() {
        let mut bytes = bundle_to_bytes(&sample_bundle()).unwrap();
        bytes[8] = 99;
        let result = bundle_from_bytes(&bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_tamper_detection() {
        let mut bytes = bundle_to_bytes(&sample_bundle()).unwrap();
        let tamper_idx = 40;
        bytes[tamper_idx] ^= 0xFF;
        let result = bundle_from_bytes(&bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_commits() {
        let bundle = SyncBundle {
            exported_at: "2026-05-21T00:00:00Z".to_string(),
            source_device_id: "device".to_string(),
            vault_id: "vault".to_string(),
            commits: vec![],
        };

        let bytes = bundle_to_bytes(&bundle).unwrap();
        let restored = bundle_from_bytes(&bytes).unwrap();
        assert!(restored.commits.is_empty());
    }

    #[test]
    fn test_multiple_commits() {
        let commits: Vec<SerializedCommit> = (0..100)
            .map(|i| SerializedCommit {
                commit: Commit {
                    commit_id: format!("commit-{}", i),
                    commit_kind: mdbx_core::model::CommitKind::Change,
                    change_scope: mdbx_core::model::ChangeScope::Entry,
                    device_id: "device".to_string(),
                    local_seq: i,
                    changed_object_ids_ct: vec![],
                    vector_clock: r#"{"counter":1}"#.to_string(),
                    message_ct: None,
                    created_at: "2026-05-21T00:00:00Z".to_string(),
                    integrity_tag: vec![],
                },
                operation: None,
                parent_ids: vec![],
                tombstones: vec![],
                object_payloads: vec![],
            })
            .collect();

        let bundle = SyncBundle {
            exported_at: "2026-05-21T00:00:00Z".to_string(),
            source_device_id: "device".to_string(),
            vault_id: "vault".to_string(),
            commits,
        };

        let bytes = bundle_to_bytes(&bundle).unwrap();
        let restored = bundle_from_bytes(&bytes).unwrap();
        assert_eq!(restored.commits.len(), 100);
    }
}
