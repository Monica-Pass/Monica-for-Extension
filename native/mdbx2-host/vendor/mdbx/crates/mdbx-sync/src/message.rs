use serde::{Deserialize, Serialize};

use mdbx_core::model::Commit;

use crate::error::{SyncError, SyncResult};

/// 同步协议版本。
pub const PROTOCOL_VERSION: u32 = 2;

/// 单次批量传输的最大 commit 数。
pub const MAX_COMMITS_PER_BATCH: usize = 256;
pub const CAPABILITY_COMMIT_INVENTORY_PAGING_V1: &str = "commit-inventory-paging-v1";
pub const MAX_SYNC_CAPABILITIES: usize = 32;
pub const MAX_SYNC_CAPABILITY_ID_BYTES: usize = 128;
pub const MAX_COMMIT_INVENTORY_PAGE_ITEMS: usize = 512;
pub const MAX_COMMIT_INVENTORY_TOKEN_BYTES: usize = 4096;
pub const MAX_COMMIT_ID_BYTES: usize = 256;
pub const CAPABILITY_DELTA_INVENTORY_PAGING_V1: &str = "delta-inventory-paging-v1";
pub const CAPABILITY_INCREMENTAL_BUNDLE_V4: &str = "incremental-bundle-v4";
pub const CAPABILITY_INCREMENTAL_RESUME_V1: &str = "incremental-resume-v1";
pub const CAPABILITY_ZSTD_BUNDLE_V1: &str = "bundle-zstd-v1";
pub const CAPABILITY_AUTHENTICATED_BUNDLE_V1: &str = "authenticated-bundle-v1";
pub const CAPABILITY_AUTHENTICATED_STATE_ROOT_V1: &str = "authenticated-state-root-v1";
pub const AUTHENTICATED_STATE_ROOT_PROFILE_V1: &str = "mdbx-authenticated-state-root-v1";
pub const AUTHENTICATED_STATE_ROOT_HASH_BYTES: usize = 32;
pub const MAX_AUTHENTICATED_STATE_ROOT_PROFILE_BYTES: usize = 128;
pub const CAPABILITY_BLOB_MANIFEST_PAGING_V1: &str = "blob-manifest-paging-v1";
pub const CAPABILITY_BLOB_CHUNK_TRANSFER_V1: &str = "blob-chunk-transfer-v1";
pub const CAPABILITY_BLOB_TRANSFER_RESUME_V1: &str = "blob-transfer-resume-v1";
pub const MAX_BLOB_MANIFEST_PAGE_ITEMS: usize = 512;
pub const MAX_BLOB_TRANSFER_TOKEN_BYTES: usize = 4096;
pub const MAX_BLOB_ID_BYTES: usize = 64;
pub const MAX_BLOB_CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_BLOB_TOTAL_SIZE: u64 = 1 << 40;
pub const INCREMENTAL_SYNC_CAPABILITIES: [&str; 4] = [
    CAPABILITY_COMMIT_INVENTORY_PAGING_V1,
    CAPABILITY_DELTA_INVENTORY_PAGING_V1,
    CAPABILITY_INCREMENTAL_BUNDLE_V4,
    CAPABILITY_INCREMENTAL_RESUME_V1,
];
pub const BLOB_SYNC_CAPABILITIES: [&str; 3] = [
    CAPABILITY_BLOB_MANIFEST_PAGING_V1,
    CAPABILITY_BLOB_CHUNK_TRANSFER_V1,
    CAPABILITY_BLOB_TRANSFER_RESUME_V1,
];

// ---------------------------------------------------------------------------
// 顶层消息容器
// ---------------------------------------------------------------------------

/// 同步协议中的一条消息。
///
/// 所有消息都是自描述的，可以跨任意传输通道发送
/// （文件同步、本地网络、中继服务等）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SyncMessage {
    /// 初始握手：宣告设备身份和当前 head 快照。
    Hello(HelloRequest),

    /// 对 Hello 的响应。
    HelloAck(HelloResponse),

    /// 请求对方发送缺失的 commit。
    WantCommits(WantRequest),

    /// 请求一个固定 watermark 内的 commit inventory 页面。
    CommitInventoryPageRequest(CommitInventoryPageRequest),

    /// 返回一个有界、因果有序的 commit inventory 页面。
    CommitInventoryPageResponse(CommitInventoryPageResponse),

    /// Request a fixed watermark page from the state-delta inventory.
    DeltaInventoryPageRequest(DeltaInventoryPageRequest),

    /// Return a bounded, ordered state-delta inventory page.
    DeltaInventoryPageResponse(DeltaInventoryPageResponse),

    /// Request a bounded page from the source Blob manifest.
    BlobManifestPageRequest(BlobManifestPageRequest),

    /// Return a bounded, ordered source Blob manifest page.
    BlobManifestPageResponse(BlobManifestPageResponse),

    /// Request one bounded ciphertext range from a source Blob.
    BlobChunkRequest(BlobChunkRequest),

    /// Return one durable-resume-compatible ciphertext range.
    BlobChunkResponse(BlobChunkResponse),

    /// 发送一组合并 commit。
    CommitBatch(CommitBatch),

    /// 确认收到 commit 批次。
    BatchAck(BatchAck),

    /// 同步完成。
    Done(SyncDone),

    /// 错误响应。
    Error(SyncErrorMessage),
}

/// Bounded root metadata whose authentication tag is verified by the storage
/// adapter with the vault integrity subkey.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AuthenticatedStateRootCheckpoint {
    pub profile: String,
    pub generation: u64,
    pub leaf_count: u64,
    pub root_hash: Vec<u8>,
    pub latest_commit_sequence: u64,
    pub latest_delta_sequence: u64,
    pub authentication_tag: Vec<u8>,
}

impl AuthenticatedStateRootCheckpoint {
    pub fn new(
        profile: String,
        generation: u64,
        leaf_count: u64,
        root_hash: Vec<u8>,
        latest_commit_sequence: u64,
        latest_delta_sequence: u64,
        authentication_tag: Vec<u8>,
    ) -> SyncResult<Self> {
        let checkpoint = Self {
            profile,
            generation,
            leaf_count,
            root_hash,
            latest_commit_sequence,
            latest_delta_sequence,
            authentication_tag,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    pub fn validate(&self) -> SyncResult<()> {
        if self.profile != AUTHENTICATED_STATE_ROOT_PROFILE_V1
            || self.profile.len() > MAX_AUTHENTICATED_STATE_ROOT_PROFILE_BYTES
        {
            return Err(SyncError::InvalidMessage(
                "unsupported authenticated state-root profile".to_string(),
            ));
        }
        if self.generation == 0 {
            return Err(SyncError::InvalidMessage(
                "authenticated state-root generation must be positive".to_string(),
            ));
        }
        if self.root_hash.len() != AUTHENTICATED_STATE_ROOT_HASH_BYTES {
            return Err(SyncError::InvalidMessage(format!(
                "authenticated state-root hash must be {AUTHENTICATED_STATE_ROOT_HASH_BYTES} bytes"
            )));
        }
        if self.authentication_tag.len() != AUTHENTICATED_STATE_ROOT_HASH_BYTES {
            return Err(SyncError::InvalidMessage(format!(
                "authenticated state-root tag must be {AUTHENTICATED_STATE_ROOT_HASH_BYTES} bytes"
            )));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Hello
// ---------------------------------------------------------------------------

/// Hello 请求：设备宣告自己的身份和当前已知 head。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloRequest {
    /// 发送设备 ID。
    pub device_id: String,

    /// 协议版本号。
    pub protocol_version: u32,

    /// 此设备已知的全部分支 head。
    /// New peers identify a branch by `branch_id`; legacy peers use the name.
    pub heads: Vec<BranchHead>,

    /// 此设备已知的全部 commit ID（用于 skip 已存在的 commit）。
    pub known_commit_ids: Vec<String>,

    /// 可选扩展能力。空列表不序列化，保持旧 protocol-v2 JSON 形状。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authenticated_state_root: Option<AuthenticatedStateRootCheckpoint>,
}

/// 单个分支的 head 信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchHead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    pub branch_name: String,
    pub head_commit_id: String,
}

/// Hello 响应：对方宣告其身份和 head。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloResponse {
    pub device_id: String,
    pub protocol_version: u32,
    pub heads: Vec<BranchHead>,
    pub known_commit_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authenticated_state_root: Option<AuthenticatedStateRootCheckpoint>,
}

// ---------------------------------------------------------------------------
// Commit inventory paging
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommitInventoryPageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub page_size: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommitInventoryPageResponse {
    pub items: Vec<CommitInventoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub checkpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommitInventoryEntry {
    pub inventory_seq: u64,
    pub commit_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeltaInventoryPageRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub page_size: u16,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DeltaInventoryKind {
    Commit,
    Auxiliary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeltaInventoryEntry {
    pub batch_seq: u64,
    pub batch_id: String,
    pub batch_kind: DeltaInventoryKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeltaInventoryPageResponse {
    pub items: Vec<DeltaInventoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub checkpoint: String,
}

// ---------------------------------------------------------------------------
// Blob manifest and ciphertext transfer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BlobManifestEntryState {
    Available,
    SourceMissing,
    SourceSizeInvalid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobManifestPageRequest {
    pub namespace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    pub page_size: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobManifestPageResponse {
    pub namespace_id: String,
    pub checkpoint: String,
    pub items: Vec<BlobManifestEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobManifestEntry {
    pub blob_id: String,
    pub total_size: Option<u64>,
    pub state: BlobManifestEntryState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobChunkRequest {
    pub namespace_id: String,
    pub blob_id: String,
    pub total_size: u64,
    pub offset: u64,
    pub max_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobChunkResponse {
    pub namespace_id: String,
    pub blob_id: String,
    pub total_size: u64,
    pub offset: u64,
    pub ciphertext: Vec<u8>,
    pub is_last: bool,
}

// ---------------------------------------------------------------------------
// Want
// ---------------------------------------------------------------------------

/// 请求对方发送特定的 commit。
///
/// 发送方已将自己的 known_commit_ids 发给对方，
/// 现在请求对方发送那些对方有而自己没有的 commit。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WantRequest {
    /// 请求的 commit ID 列表。
    pub want: Vec<String>,

    /// 已拥有的 commit ID 列表（避免重复发送）。
    pub have: Vec<String>,
}

// ---------------------------------------------------------------------------
// Commit 传输
// ---------------------------------------------------------------------------

/// 一批序列化的 commit。
///
/// 发送方将 commit 连同其关联的对象数据打包在此消息中。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitBatch {
    /// 本批次的 commit 列表。
    pub commits: Vec<SerializedCommit>,

    /// 是否为最后一批。
    pub is_last: bool,

    /// 批次序号（从 0 开始）。
    pub batch_index: u32,
}

/// 单个完整的 commit 及其关联对象。
///
/// 包含 commit 元数据、parent 关系、以及 commit 引用的加密对象负载。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedCommit {
    /// Commit 元数据。
    pub commit: Commit,

    /// MDBX2 operation 元数据。旧 MDBX1/MDBX2 commit 没有此字段时按空处理。
    #[serde(default)]
    pub operation: Option<CommitOperationMetadata>,

    /// 此 commit 的 parent commit ID 列表（DAG 关联）。
    pub parent_ids: Vec<String>,

    /// 此 commit 创建的所有 tombstone。
    pub tombstones: Vec<TombstoneRecord>,

    /// 此 commit 引用的对象负载（加密形式）。
    /// `(object_type, object_id, ciphertext)`。
    pub object_payloads: Vec<ObjectPayload>,
}

/// 可跨同步协议传输的 operation 元数据投影。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitOperationMetadata {
    pub operation_id: String,
    pub operation_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    pub branch_name: String,
    pub change_summary_ct: Vec<u8>,
    pub request_hash: Vec<u8>,
    pub integrity_tag: Vec<u8>,
}

/// Commit 关联的 tombstone。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TombstoneRecord {
    pub tombstone_id: String,
    pub target_object_type: String,
    pub target_object_id: String,
    pub delete_clock: String,
    pub deleted_by_device_id: String,
    pub deleted_at: String,
}

/// Commit 引用的加密对象负载。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectPayload {
    /// 对象类型: "project" | "entry" | "attachment"
    pub object_type: String,
    /// 对象 ID。
    pub object_id: String,
    /// 加密后的对象数据。
    pub ciphertext: Vec<u8>,
    /// 关联数据（用于 AEAD 验证）。
    pub associated_data: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Ack / Done / Error
// ---------------------------------------------------------------------------

/// 接收方确认收到一个 commit 批次。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchAck {
    /// 确认的批次序号。
    pub batch_index: u32,

    /// 该批次中成功应用的 commit 数。
    pub applied_count: u32,

    /// 该批次引入的冲突数。
    pub conflict_count: u32,
}

/// 同步完成通知。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncDone {
    /// 发送方身份。
    pub device_id: String,

    /// 本次同步交换的 commit 总数。
    pub total_commits: u32,

    /// 同步后的分支 head。
    pub final_heads: Vec<BranchHead>,
}

/// 错误消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncErrorMessage {
    /// 错误码。
    pub code: String,

    /// 人类可读的描述。
    pub message: String,
}

// ---------------------------------------------------------------------------
// 辅助方法
// ---------------------------------------------------------------------------

impl SyncMessage {
    /// 序列化为 JSON 字节。
    pub fn to_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }

    /// 从 JSON 字节反序列化。
    pub fn from_bytes(data: &[u8]) -> Result<Self, serde_json::Error> {
        let message: Self = serde_json::from_slice(data)?;
        message
            .validate()
            .map_err(|error| <serde_json::Error as serde::de::Error>::custom(error.to_string()))?;
        Ok(message)
    }

    pub fn validate(&self) -> SyncResult<()> {
        match self {
            Self::Hello(hello) => validate_hello_advertisement(
                &hello.capabilities,
                hello.authenticated_state_root.as_ref(),
            ),
            Self::HelloAck(hello) => validate_hello_advertisement(
                &hello.capabilities,
                hello.authenticated_state_root.as_ref(),
            ),
            Self::CommitInventoryPageRequest(request) => request.validate(),
            Self::CommitInventoryPageResponse(response) => response.validate(),
            Self::DeltaInventoryPageRequest(request) => request.validate(),
            Self::DeltaInventoryPageResponse(response) => response.validate(),
            Self::BlobManifestPageRequest(request) => request.validate(),
            Self::BlobManifestPageResponse(response) => response.validate(),
            Self::BlobChunkRequest(request) => request.validate(),
            Self::BlobChunkResponse(response) => response.validate(),
            _ => Ok(()),
        }
    }
}

impl HelloRequest {
    pub fn new(device_id: &str, heads: Vec<BranchHead>, known_commit_ids: Vec<String>) -> Self {
        Self {
            device_id: device_id.to_string(),
            protocol_version: PROTOCOL_VERSION,
            heads,
            known_commit_ids,
            capabilities: Vec::new(),
            authenticated_state_root: None,
        }
    }

    pub fn with_capabilities(mut self, capabilities: Vec<String>) -> SyncResult<Self> {
        validate_capabilities(&capabilities)?;
        self.capabilities = canonical_capabilities(capabilities);
        Ok(self)
    }

    pub fn with_authenticated_state_root(
        mut self,
        checkpoint: AuthenticatedStateRootCheckpoint,
    ) -> SyncResult<Self> {
        checkpoint.validate()?;
        if !self.supports(CAPABILITY_AUTHENTICATED_STATE_ROOT_V1) {
            return Err(SyncError::InvalidMessage(
                "authenticated state-root checkpoint requires its capability".to_string(),
            ));
        }
        self.authenticated_state_root = Some(checkpoint);
        Ok(self)
    }

    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|value| value == capability)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_hello_advertisement(&self.capabilities, self.authenticated_state_root.as_ref())
    }
}

impl HelloResponse {
    pub fn new(device_id: &str, heads: Vec<BranchHead>, known_commit_ids: Vec<String>) -> Self {
        Self {
            device_id: device_id.to_string(),
            protocol_version: PROTOCOL_VERSION,
            heads,
            known_commit_ids,
            capabilities: Vec::new(),
            authenticated_state_root: None,
        }
    }

    pub fn with_capabilities(mut self, capabilities: Vec<String>) -> SyncResult<Self> {
        validate_capabilities(&capabilities)?;
        self.capabilities = canonical_capabilities(capabilities);
        Ok(self)
    }

    pub fn with_authenticated_state_root(
        mut self,
        checkpoint: AuthenticatedStateRootCheckpoint,
    ) -> SyncResult<Self> {
        checkpoint.validate()?;
        if !self.supports(CAPABILITY_AUTHENTICATED_STATE_ROOT_V1) {
            return Err(SyncError::InvalidMessage(
                "authenticated state-root checkpoint requires its capability".to_string(),
            ));
        }
        self.authenticated_state_root = Some(checkpoint);
        Ok(self)
    }

    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|value| value == capability)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_hello_advertisement(&self.capabilities, self.authenticated_state_root.as_ref())
    }
}

impl CommitInventoryPageRequest {
    pub fn new(
        checkpoint: Option<String>,
        cursor: Option<String>,
        page_size: usize,
    ) -> SyncResult<Self> {
        let page_size = u16::try_from(page_size).map_err(|_| {
            SyncError::InvalidMessage(format!(
                "commit inventory page size must be between 1 and {MAX_COMMIT_INVENTORY_PAGE_ITEMS}"
            ))
        })?;
        let request = Self {
            checkpoint,
            cursor,
            page_size,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> SyncResult<()> {
        let page_size = usize::from(self.page_size);
        if page_size == 0 || page_size > MAX_COMMIT_INVENTORY_PAGE_ITEMS {
            return Err(SyncError::InvalidMessage(format!(
                "commit inventory page size must be between 1 and {MAX_COMMIT_INVENTORY_PAGE_ITEMS}"
            )));
        }
        validate_optional_inventory_token(self.checkpoint.as_deref(), "checkpoint")?;
        validate_optional_inventory_token(self.cursor.as_deref(), "cursor")
    }
}

impl CommitInventoryPageResponse {
    pub fn new(
        items: Vec<CommitInventoryEntry>,
        next_cursor: Option<String>,
        checkpoint: String,
    ) -> SyncResult<Self> {
        let response = Self {
            items,
            next_cursor,
            checkpoint,
        };
        response.validate()?;
        Ok(response)
    }

    pub fn validate(&self) -> SyncResult<()> {
        if self.items.len() > MAX_COMMIT_INVENTORY_PAGE_ITEMS {
            return Err(SyncError::InvalidMessage(format!(
                "commit inventory page exceeds {MAX_COMMIT_INVENTORY_PAGE_ITEMS} items"
            )));
        }
        validate_inventory_token(&self.checkpoint, "checkpoint")?;
        validate_optional_inventory_token(self.next_cursor.as_deref(), "cursor")?;
        if self.items.is_empty() && self.next_cursor.is_some() {
            return Err(SyncError::InvalidMessage(
                "commit inventory page cannot continue without a position".to_string(),
            ));
        }
        let mut previous = 0_u64;
        for item in &self.items {
            if item.inventory_seq == 0 || item.inventory_seq <= previous {
                return Err(SyncError::InvalidMessage(
                    "commit inventory sequences must be strictly increasing".to_string(),
                ));
            }
            validate_commit_id(&item.commit_id)?;
            previous = item.inventory_seq;
        }
        Ok(())
    }
}

impl DeltaInventoryPageRequest {
    pub fn new(
        checkpoint: Option<String>,
        cursor: Option<String>,
        page_size: usize,
    ) -> SyncResult<Self> {
        let page_size = u16::try_from(page_size).map_err(|_| {
            SyncError::InvalidMessage(format!(
                "delta inventory page size must be between 1 and {MAX_COMMIT_INVENTORY_PAGE_ITEMS}"
            ))
        })?;
        let request = Self {
            checkpoint,
            cursor,
            page_size,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> SyncResult<()> {
        let page_size = usize::from(self.page_size);
        if page_size == 0 || page_size > MAX_COMMIT_INVENTORY_PAGE_ITEMS {
            return Err(SyncError::InvalidMessage(format!(
                "delta inventory page size must be between 1 and {MAX_COMMIT_INVENTORY_PAGE_ITEMS}"
            )));
        }
        validate_optional_inventory_token(self.checkpoint.as_deref(), "delta checkpoint")?;
        validate_optional_inventory_token(self.cursor.as_deref(), "delta cursor")
    }
}

impl DeltaInventoryPageResponse {
    pub fn new(
        items: Vec<DeltaInventoryEntry>,
        next_cursor: Option<String>,
        checkpoint: String,
    ) -> SyncResult<Self> {
        let response = Self {
            items,
            next_cursor,
            checkpoint,
        };
        response.validate()?;
        Ok(response)
    }

    pub fn validate(&self) -> SyncResult<()> {
        if self.items.len() > MAX_COMMIT_INVENTORY_PAGE_ITEMS {
            return Err(SyncError::InvalidMessage(format!(
                "delta inventory page exceeds {MAX_COMMIT_INVENTORY_PAGE_ITEMS} items"
            )));
        }
        validate_inventory_token(&self.checkpoint, "delta checkpoint")?;
        validate_optional_inventory_token(self.next_cursor.as_deref(), "delta cursor")?;
        if self.items.is_empty() && self.next_cursor.is_some() {
            return Err(SyncError::InvalidMessage(
                "delta inventory page cannot continue without a position".to_string(),
            ));
        }
        let mut previous = 0_u64;
        for item in &self.items {
            if item.batch_seq == 0 || item.batch_seq <= previous {
                return Err(SyncError::InvalidMessage(
                    "delta inventory sequences must be strictly increasing".to_string(),
                ));
            }
            validate_commit_id(&item.batch_id)?;
            previous = item.batch_seq;
        }
        Ok(())
    }
}

impl BlobManifestPageRequest {
    pub fn new(
        namespace_id: String,
        checkpoint: Option<String>,
        cursor: Option<String>,
        page_size: usize,
    ) -> SyncResult<Self> {
        let page_size = u16::try_from(page_size).map_err(|_| {
            SyncError::InvalidMessage(format!(
                "Blob manifest page size must be between 1 and {MAX_BLOB_MANIFEST_PAGE_ITEMS}"
            ))
        })?;
        let request = Self {
            namespace_id,
            checkpoint,
            cursor,
            page_size,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_blob_namespace(&self.namespace_id)?;
        let page_size = usize::from(self.page_size);
        if page_size == 0 || page_size > MAX_BLOB_MANIFEST_PAGE_ITEMS {
            return Err(SyncError::InvalidMessage(format!(
                "Blob manifest page size must be between 1 and {MAX_BLOB_MANIFEST_PAGE_ITEMS}"
            )));
        }
        validate_optional_blob_token(self.checkpoint.as_deref(), "checkpoint")?;
        validate_optional_blob_token(self.cursor.as_deref(), "cursor")
    }
}

impl BlobManifestPageResponse {
    pub fn new(
        namespace_id: String,
        checkpoint: String,
        items: Vec<BlobManifestEntry>,
        next_cursor: Option<String>,
    ) -> SyncResult<Self> {
        let response = Self {
            namespace_id,
            checkpoint,
            items,
            next_cursor,
        };
        response.validate()?;
        Ok(response)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_blob_namespace(&self.namespace_id)?;
        validate_blob_token(&self.checkpoint, "checkpoint")?;
        validate_optional_blob_token(self.next_cursor.as_deref(), "cursor")?;
        if self.items.len() > MAX_BLOB_MANIFEST_PAGE_ITEMS {
            return Err(SyncError::InvalidMessage(format!(
                "Blob manifest page exceeds {MAX_BLOB_MANIFEST_PAGE_ITEMS} items"
            )));
        }
        if self.items.is_empty() && self.next_cursor.is_some() {
            return Err(SyncError::InvalidMessage(
                "Blob manifest page cannot continue without a position".to_string(),
            ));
        }
        let mut previous = None;
        for item in &self.items {
            item.validate()?;
            if previous.is_some_and(|value: &str| value >= item.blob_id.as_str()) {
                return Err(SyncError::InvalidMessage(
                    "Blob manifest IDs must be strictly increasing".to_string(),
                ));
            }
            previous = Some(item.blob_id.as_str());
        }
        Ok(())
    }
}

impl BlobManifestEntry {
    pub fn validate(&self) -> SyncResult<()> {
        validate_blob_id(&self.blob_id)?;
        match self.state {
            BlobManifestEntryState::Available => {
                let total_size = self.total_size.ok_or_else(|| {
                    SyncError::InvalidMessage(
                        "available Blob manifest entries require a total size".to_string(),
                    )
                })?;
                validate_blob_total_size(total_size)?;
            }
            BlobManifestEntryState::SourceMissing => {
                if self.total_size.is_some() {
                    return Err(SyncError::InvalidMessage(
                        "missing Blob manifest entries cannot declare a total size".to_string(),
                    ));
                }
            }
            BlobManifestEntryState::SourceSizeInvalid => {
                if let Some(total_size) = self.total_size {
                    if total_size > MAX_BLOB_TOTAL_SIZE {
                        return Err(SyncError::InvalidMessage(format!(
                            "Blob total size exceeds {MAX_BLOB_TOTAL_SIZE} bytes"
                        )));
                    }
                }
            }
        }
        Ok(())
    }
}

impl BlobChunkRequest {
    pub fn new(
        namespace_id: String,
        blob_id: String,
        total_size: u64,
        offset: u64,
        max_bytes: usize,
    ) -> SyncResult<Self> {
        let max_bytes = u32::try_from(max_bytes).map_err(|_| {
            SyncError::InvalidMessage(format!(
                "Blob chunk size must be between 1 and {MAX_BLOB_CHUNK_BYTES} bytes"
            ))
        })?;
        let request = Self {
            namespace_id,
            blob_id,
            total_size,
            offset,
            max_bytes,
        };
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_blob_namespace(&self.namespace_id)?;
        validate_blob_id(&self.blob_id)?;
        validate_blob_total_size(self.total_size)?;
        if self.offset >= self.total_size {
            return Err(SyncError::InvalidMessage(
                "Blob chunk offset must be below the total size".to_string(),
            ));
        }
        let max_bytes = usize::try_from(self.max_bytes).map_err(|_| {
            SyncError::InvalidMessage("Blob chunk size cannot be represented locally".to_string())
        })?;
        if max_bytes == 0 || max_bytes > MAX_BLOB_CHUNK_BYTES {
            return Err(SyncError::InvalidMessage(format!(
                "Blob chunk size must be between 1 and {MAX_BLOB_CHUNK_BYTES} bytes"
            )));
        }
        Ok(())
    }
}

impl BlobChunkResponse {
    pub fn new(
        namespace_id: String,
        blob_id: String,
        total_size: u64,
        offset: u64,
        ciphertext: Vec<u8>,
        is_last: bool,
    ) -> SyncResult<Self> {
        let response = Self {
            namespace_id,
            blob_id,
            total_size,
            offset,
            ciphertext,
            is_last,
        };
        response.validate()?;
        Ok(response)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_blob_namespace(&self.namespace_id)?;
        validate_blob_id(&self.blob_id)?;
        validate_blob_total_size(self.total_size)?;
        if self.ciphertext.is_empty() || self.ciphertext.len() > MAX_BLOB_CHUNK_BYTES {
            return Err(SyncError::InvalidMessage(format!(
                "Blob chunk payload must be between 1 and {MAX_BLOB_CHUNK_BYTES} bytes"
            )));
        }
        let chunk_len = u64::try_from(self.ciphertext.len()).map_err(|_| {
            SyncError::InvalidMessage("Blob chunk length cannot be represented".to_string())
        })?;
        let end = self.offset.checked_add(chunk_len).ok_or_else(|| {
            SyncError::InvalidMessage("Blob chunk offset overflows total size".to_string())
        })?;
        if self.offset >= self.total_size || end > self.total_size {
            return Err(SyncError::InvalidMessage(
                "Blob chunk range exceeds the total size".to_string(),
            ));
        }
        if self.is_last != (end == self.total_size) {
            return Err(SyncError::InvalidMessage(
                "Blob chunk is_last flag does not match its range".to_string(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn validate_capabilities(capabilities: &[String]) -> SyncResult<()> {
    if capabilities.len() > MAX_SYNC_CAPABILITIES {
        return Err(SyncError::InvalidMessage(format!(
            "sync capability list exceeds {MAX_SYNC_CAPABILITIES} items"
        )));
    }
    let mut seen = std::collections::HashSet::with_capacity(capabilities.len());
    for capability in capabilities {
        if capability.is_empty()
            || capability.len() > MAX_SYNC_CAPABILITY_ID_BYTES
            || !capability
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_'))
        {
            return Err(SyncError::InvalidMessage(format!(
                "invalid sync capability identifier: {capability}"
            )));
        }
        if !seen.insert(capability.as_str()) {
            return Err(SyncError::InvalidMessage(format!(
                "duplicate sync capability identifier: {capability}"
            )));
        }
    }
    Ok(())
}

fn validate_hello_advertisement(
    capabilities: &[String],
    checkpoint: Option<&AuthenticatedStateRootCheckpoint>,
) -> SyncResult<()> {
    validate_capabilities(capabilities)?;
    if let Some(checkpoint) = checkpoint {
        if !capabilities
            .iter()
            .any(|value| value == CAPABILITY_AUTHENTICATED_STATE_ROOT_V1)
        {
            return Err(SyncError::InvalidMessage(
                "authenticated state-root checkpoint requires its capability".to_string(),
            ));
        }
        checkpoint.validate()?;
    }
    Ok(())
}

fn canonical_capabilities(mut capabilities: Vec<String>) -> Vec<String> {
    capabilities.sort_unstable();
    capabilities
}

fn validate_optional_inventory_token(value: Option<&str>, kind: &str) -> SyncResult<()> {
    if let Some(value) = value {
        validate_inventory_token(value, kind)?;
    }
    Ok(())
}

fn validate_inventory_token(value: &str, kind: &str) -> SyncResult<()> {
    if value.is_empty() || value.len() > MAX_COMMIT_INVENTORY_TOKEN_BYTES {
        return Err(SyncError::InvalidMessage(format!(
            "commit inventory {kind} must be between 1 and {MAX_COMMIT_INVENTORY_TOKEN_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_commit_id(commit_id: &str) -> SyncResult<()> {
    if commit_id.is_empty() || commit_id.len() > MAX_COMMIT_ID_BYTES {
        return Err(SyncError::InvalidMessage(format!(
            "commit ID must be between 1 and {MAX_COMMIT_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_blob_namespace(namespace_id: &str) -> SyncResult<()> {
    if namespace_id.is_empty() || namespace_id.len() > MAX_BLOB_TRANSFER_TOKEN_BYTES {
        return Err(SyncError::InvalidMessage(format!(
            "Blob namespace ID must be between 1 and {MAX_BLOB_TRANSFER_TOKEN_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_optional_blob_token(value: Option<&str>, kind: &str) -> SyncResult<()> {
    if let Some(value) = value {
        validate_blob_token(value, kind)?;
    }
    Ok(())
}

fn validate_blob_token(value: &str, kind: &str) -> SyncResult<()> {
    if value.is_empty() || value.len() > MAX_BLOB_TRANSFER_TOKEN_BYTES {
        return Err(SyncError::InvalidMessage(format!(
            "Blob {kind} must be between 1 and {MAX_BLOB_TRANSFER_TOKEN_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_blob_id(blob_id: &str) -> SyncResult<()> {
    if blob_id.len() != MAX_BLOB_ID_BYTES
        || !blob_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SyncError::InvalidMessage(
            "Blob ID must be exactly 64 lowercase SHA-256 hex characters".to_string(),
        ));
    }
    Ok(())
}

fn validate_blob_total_size(total_size: u64) -> SyncResult<()> {
    if total_size == 0 || total_size > MAX_BLOB_TOTAL_SIZE {
        return Err(SyncError::InvalidMessage(format!(
            "Blob total size must be between 1 and {MAX_BLOB_TOTAL_SIZE} bytes"
        )));
    }
    Ok(())
}

impl CommitBatch {
    pub fn new(commits: Vec<SerializedCommit>, batch_index: u32, is_last: bool) -> Self {
        Self {
            commits,
            is_last,
            batch_index,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_json_without_branch_ids_deserializes() {
        let head: BranchHead =
            serde_json::from_str(r#"{"branch_name":"main","head_commit_id":"commit-1"}"#).unwrap();
        let operation: CommitOperationMetadata = serde_json::from_str(
            r#"{
                "operation_id":"operation-1",
                "operation_kind":"edit",
                "branch_name":"main",
                "change_summary_ct":[1,2],
                "request_hash":[3,4],
                "integrity_tag":[5,6]
            }"#,
        )
        .unwrap();

        assert_eq!(head.branch_id, None);
        assert_eq!(operation.branch_id, None);
        assert_eq!(operation.branch_name, "main");
    }

    #[test]
    fn legacy_protocol_v2_hello_json_and_constructors_remain_unchanged() {
        let request_json = r#"{
            "device_id":"legacy-request",
            "protocol_version":2,
            "heads":[],
            "known_commit_ids":["commit-1"]
        }"#;
        let response_json = r#"{
            "device_id":"legacy-response",
            "protocol_version":2,
            "heads":[],
            "known_commit_ids":["commit-1"]
        }"#;
        let request: HelloRequest = serde_json::from_str(request_json).unwrap();
        let response: HelloResponse = serde_json::from_str(response_json).unwrap();
        assert!(request.capabilities.is_empty());
        assert!(response.capabilities.is_empty());
        assert!(request.authenticated_state_root.is_none());
        assert!(response.authenticated_state_root.is_none());

        let request_value = serde_json::to_value(HelloRequest::new(
            "legacy-request",
            Vec::new(),
            vec!["commit-1".to_string()],
        ))
        .unwrap();
        let response_value = serde_json::to_value(HelloResponse::new(
            "legacy-response",
            Vec::new(),
            vec!["commit-1".to_string()],
        ))
        .unwrap();
        assert!(request_value.get("capabilities").is_none());
        assert!(response_value.get("capabilities").is_none());
        assert!(request_value.get("authenticated_state_root").is_none());
        assert!(response_value.get("authenticated_state_root").is_none());
    }

    #[test]
    fn authenticated_state_root_checkpoint_roundtrips_additively() {
        let checkpoint = AuthenticatedStateRootCheckpoint::new(
            AUTHENTICATED_STATE_ROOT_PROFILE_V1.to_string(),
            7,
            42,
            vec![3; AUTHENTICATED_STATE_ROOT_HASH_BYTES],
            11,
            13,
            vec![5; AUTHENTICATED_STATE_ROOT_HASH_BYTES],
        )
        .unwrap();
        let hello = HelloRequest::new("root-device", Vec::new(), Vec::new())
            .with_capabilities(vec![CAPABILITY_AUTHENTICATED_STATE_ROOT_V1.to_string()])
            .unwrap()
            .with_authenticated_state_root(checkpoint.clone())
            .unwrap();
        let message = SyncMessage::Hello(hello);
        let restored = SyncMessage::from_bytes(&message.to_bytes().unwrap()).unwrap();
        let SyncMessage::Hello(restored) = restored else {
            panic!("expected Hello");
        };
        assert_eq!(restored.authenticated_state_root, Some(checkpoint.clone()));

        assert!(HelloRequest::new("invalid", Vec::new(), Vec::new())
            .with_authenticated_state_root(checkpoint.clone())
            .is_err());
        let mut malformed = checkpoint;
        malformed.root_hash.pop();
        assert!(malformed.validate().is_err());
    }

    #[test]
    fn paged_inventory_capability_and_messages_roundtrip_additively() {
        let hello = HelloRequest::new("device-1", Vec::new(), Vec::new())
            .with_capabilities(vec![
                "future-extension-v1".to_string(),
                CAPABILITY_COMMIT_INVENTORY_PAGING_V1.to_string(),
            ])
            .unwrap();
        assert!(hello.supports(CAPABILITY_COMMIT_INVENTORY_PAGING_V1));
        assert_eq!(
            hello.capabilities,
            [CAPABILITY_COMMIT_INVENTORY_PAGING_V1, "future-extension-v1"]
        );

        let request = CommitInventoryPageRequest::new(
            Some("base-checkpoint".to_string()),
            Some("page-cursor".to_string()),
            128,
        )
        .unwrap();
        let message = SyncMessage::CommitInventoryPageRequest(request.clone());
        let restored = SyncMessage::from_bytes(&message.to_bytes().unwrap()).unwrap();
        match restored {
            SyncMessage::CommitInventoryPageRequest(restored) => assert_eq!(restored, request),
            _ => panic!("expected commit inventory page request"),
        }

        let response = CommitInventoryPageResponse::new(
            vec![
                CommitInventoryEntry {
                    inventory_seq: 10,
                    commit_id: "commit-10".to_string(),
                },
                CommitInventoryEntry {
                    inventory_seq: 11,
                    commit_id: "commit-11".to_string(),
                },
            ],
            None,
            "watermark-checkpoint".to_string(),
        )
        .unwrap();
        let message = SyncMessage::CommitInventoryPageResponse(response.clone());
        let restored = SyncMessage::from_bytes(&message.to_bytes().unwrap()).unwrap();
        match restored {
            SyncMessage::CommitInventoryPageResponse(restored) => assert_eq!(restored, response),
            _ => panic!("expected commit inventory page response"),
        }
    }

    #[test]
    fn paged_inventory_dtos_enforce_hard_bounds_and_causal_order() {
        assert!(CommitInventoryPageRequest::new(None, None, 0).is_err());
        assert!(
            CommitInventoryPageRequest::new(None, None, MAX_COMMIT_INVENTORY_PAGE_ITEMS + 1,)
                .is_err()
        );
        assert!(CommitInventoryPageRequest::new(
            Some("x".repeat(MAX_COMMIT_INVENTORY_TOKEN_BYTES + 1)),
            None,
            1,
        )
        .is_err());

        let too_many = (1..=MAX_COMMIT_INVENTORY_PAGE_ITEMS + 1)
            .map(|sequence| CommitInventoryEntry {
                inventory_seq: sequence as u64,
                commit_id: format!("commit-{sequence}"),
            })
            .collect();
        assert!(
            CommitInventoryPageResponse::new(too_many, None, "checkpoint".to_string(),).is_err()
        );
        assert!(CommitInventoryPageResponse::new(
            vec![
                CommitInventoryEntry {
                    inventory_seq: 2,
                    commit_id: "commit-2".to_string(),
                },
                CommitInventoryEntry {
                    inventory_seq: 1,
                    commit_id: "commit-1".to_string(),
                },
            ],
            None,
            "checkpoint".to_string(),
        )
        .is_err());
        assert!(CommitInventoryPageResponse::new(
            vec![CommitInventoryEntry {
                inventory_seq: 1,
                commit_id: String::new(),
            }],
            None,
            "checkpoint".to_string(),
        )
        .is_err());
        assert!(serde_json::from_str::<CommitInventoryPageRequest>(
            r#"{"page_size":1,"unknown":true}"#
        )
        .is_err());
        let invalid_wire_message = format!(
            r#"{{"type":"commit-inventory-page-request","page_size":1,"cursor":"{}"}}"#,
            "x".repeat(MAX_COMMIT_INVENTORY_TOKEN_BYTES + 1)
        );
        assert!(SyncMessage::from_bytes(invalid_wire_message.as_bytes()).is_err());
    }

    #[test]
    fn blob_manifest_and_chunks_roundtrip_with_strict_bounds() {
        let first_id = "0".repeat(MAX_BLOB_ID_BYTES);
        let second_id = "1".repeat(MAX_BLOB_ID_BYTES);
        let request = BlobManifestPageRequest::new(
            "attachments".to_string(),
            Some("manifest-checkpoint".to_string()),
            None,
            128,
        )
        .unwrap();
        let message = SyncMessage::BlobManifestPageRequest(request.clone());
        let restored = SyncMessage::from_bytes(&message.to_bytes().unwrap()).unwrap();
        assert!(matches!(
            restored,
            SyncMessage::BlobManifestPageRequest(value) if value == request
        ));

        let response = BlobManifestPageResponse::new(
            "attachments".to_string(),
            "manifest-checkpoint".to_string(),
            vec![
                BlobManifestEntry {
                    blob_id: first_id,
                    total_size: Some(8),
                    state: BlobManifestEntryState::Available,
                },
                BlobManifestEntry {
                    blob_id: second_id,
                    total_size: Some(9),
                    state: BlobManifestEntryState::Available,
                },
            ],
            None,
        )
        .unwrap();
        let message = SyncMessage::BlobManifestPageResponse(response.clone());
        let restored = SyncMessage::from_bytes(&message.to_bytes().unwrap()).unwrap();
        assert!(matches!(
            restored,
            SyncMessage::BlobManifestPageResponse(value) if value == response
        ));

        let request = BlobChunkRequest::new(
            "attachments".to_string(),
            "a".repeat(MAX_BLOB_ID_BYTES),
            8,
            4,
            4,
        )
        .unwrap();
        assert!(request.validate().is_ok());
        let response = BlobChunkResponse::new(
            "attachments".to_string(),
            "a".repeat(MAX_BLOB_ID_BYTES),
            8,
            4,
            vec![1, 2, 3, 4],
            true,
        )
        .unwrap();
        assert!(response.validate().is_ok());
    }

    #[test]
    fn blob_messages_reject_invalid_ids_ranges_and_order() {
        assert!(BlobManifestPageRequest::new("ns".to_string(), None, None, 0).is_err());
        assert!(BlobManifestPageRequest::new(
            "ns".to_string(),
            Some("x".repeat(MAX_BLOB_TRANSFER_TOKEN_BYTES + 1)),
            None,
            1,
        )
        .is_err());
        assert!(BlobManifestPageResponse::new(
            "ns".to_string(),
            "checkpoint".to_string(),
            vec![BlobManifestEntry {
                blob_id: "A".repeat(MAX_BLOB_ID_BYTES),
                total_size: Some(1),
                state: BlobManifestEntryState::Available,
            }],
            None,
        )
        .is_err());
        assert!(BlobManifestPageResponse::new(
            "ns".to_string(),
            "checkpoint".to_string(),
            vec![BlobManifestEntry {
                blob_id: "a".repeat(MAX_BLOB_ID_BYTES),
                total_size: None,
                state: BlobManifestEntryState::Available,
            }],
            Some("cursor".to_string()),
        )
        .is_err());
        assert!(
            BlobChunkRequest::new("ns".to_string(), "a".repeat(MAX_BLOB_ID_BYTES), 8, 8, 1,)
                .is_err()
        );
        assert!(BlobChunkResponse::new(
            "ns".to_string(),
            "a".repeat(MAX_BLOB_ID_BYTES),
            8,
            0,
            vec![1, 2],
            true,
        )
        .is_err());
        assert!(BlobManifestPageResponse::new(
            "ns".to_string(),
            "checkpoint".to_string(),
            vec![
                BlobManifestEntry {
                    blob_id: "b".repeat(MAX_BLOB_ID_BYTES),
                    total_size: Some(1),
                    state: BlobManifestEntryState::Available,
                },
                BlobManifestEntry {
                    blob_id: "a".repeat(MAX_BLOB_ID_BYTES),
                    total_size: Some(1),
                    state: BlobManifestEntryState::Available,
                },
            ],
            None,
        )
        .is_err());
    }
}
