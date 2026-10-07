use serde::{Deserialize, Serialize};

use crate::types::*;

/// 每次本地变更或合并操作产生一条 commit 记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub commit_id: CommitId,
    /// 产生此 commit 的设备
    pub device_id: DeviceId,
    /// 设备本地单调递增序列号
    pub local_seq: u64,
    /// commit 类型
    pub commit_kind: CommitKind,
    /// 变更范围
    pub change_scope: ChangeScope,
    /// 加密的变更对象 ID 列表
    pub changed_object_ids_ct: CipherText,
    /// 向量时钟
    pub vector_clock: String,
    /// 加密的 commit message
    pub message_ct: Option<CipherText>,
    /// 创建时间 (ISO 8601)
    pub created_at: String,
    /// 完整性标签
    pub integrity_tag: CipherText,
}

/// Commit 的类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommitKind {
    /// 普通本地修改
    Change,
    /// 合并操作
    Merge,
    /// 快照创建
    Snapshot,
    /// 密钥轮换
    KeyRotation,
    /// 对象移动。追加在历史枚举之后以保持既有二进制 variant 序号。
    Move,
    /// 对象复制。
    Copy,
    /// 已删除对象恢复。
    Restore,
    /// 一个 operation 聚合了不同 repository commit kind。
    Multi,
}

impl std::fmt::Display for CommitKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommitKind::Change => write!(f, "change"),
            CommitKind::Merge => write!(f, "merge"),
            CommitKind::Snapshot => write!(f, "snapshot"),
            CommitKind::KeyRotation => write!(f, "key-rotation"),
            CommitKind::Move => write!(f, "move"),
            CommitKind::Copy => write!(f, "copy"),
            CommitKind::Restore => write!(f, "restore"),
            CommitKind::Multi => write!(f, "multi"),
        }
    }
}

impl std::str::FromStr for CommitKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "change" => Ok(Self::Change),
            "merge" => Ok(Self::Merge),
            "snapshot" => Ok(Self::Snapshot),
            "key-rotation" => Ok(Self::KeyRotation),
            "move" => Ok(Self::Move),
            "copy" => Ok(Self::Copy),
            "restore" => Ok(Self::Restore),
            "multi" => Ok(Self::Multi),
            _ => Err(format!("unknown CommitKind: {value}")),
        }
    }
}

/// 变更范围，用于快速过滤。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeScope {
    Project,
    Entry,
    Attachment,
    ObjectRelation,
    ObjectLabel,
    ObjectLabelAssignment,
    VaultMeta,
    KeyEpoch,
    /// 跨越多个对象类型
    Multi,
    /// Snapshot 生命周期或元数据变更。追加以保持既有二进制 variant 序号。
    Snapshot,
    /// 分支元数据或分支墓碑保留操作。
    Branch,
}

impl std::fmt::Display for ChangeScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChangeScope::Project => write!(f, "project"),
            ChangeScope::Entry => write!(f, "entry"),
            ChangeScope::Attachment => write!(f, "attachment"),
            ChangeScope::ObjectRelation => write!(f, "object-relation"),
            ChangeScope::ObjectLabel => write!(f, "object-label"),
            ChangeScope::ObjectLabelAssignment => write!(f, "object-label-assignment"),
            ChangeScope::VaultMeta => write!(f, "vault-meta"),
            ChangeScope::KeyEpoch => write!(f, "key-epoch"),
            ChangeScope::Multi => write!(f, "multi"),
            ChangeScope::Snapshot => write!(f, "snapshot"),
            ChangeScope::Branch => write!(f, "branch"),
        }
    }
}

impl std::str::FromStr for ChangeScope {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "project" => Ok(Self::Project),
            "entry" => Ok(Self::Entry),
            "attachment" => Ok(Self::Attachment),
            "object-relation" => Ok(Self::ObjectRelation),
            "object-label" => Ok(Self::ObjectLabel),
            "object-label-assignment" => Ok(Self::ObjectLabelAssignment),
            "vault-meta" => Ok(Self::VaultMeta),
            "key-epoch" => Ok(Self::KeyEpoch),
            "multi" => Ok(Self::Multi),
            "snapshot" => Ok(Self::Snapshot),
            "branch" => Ok(Self::Branch),
            _ => Err(format!("unknown ChangeScope: {value}")),
        }
    }
}

/// Commit DAG 的 parent 关系。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitParent {
    pub commit_id: CommitId,
    pub parent_commit_id: CommitId,
}

/// 设备 head 记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceHead {
    pub device_id: DeviceId,
    pub head_commit_id: CommitId,
    pub last_seen_at: String,
    pub revoked: bool,
}

/// 逻辑分支。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Branch {
    pub branch_id: BranchId,
    pub branch_name: String,
    pub head_commit_id: CommitId,
    pub created_at: String,
    pub updated_at: String,
}

/// Tombstone — 删除标记，防止并发同步时误复活。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tombstone {
    pub tombstone_id: TombstoneId,
    pub target_object_type: TombstoneTargetType,
    pub target_object_id: String,
    pub delete_clock: ObjectClock,
    pub deleted_by_device_id: DeviceId,
    pub deleted_at: String,
    /// 证明目标对象处于删除状态的 commit。旧墓碑可能缺失此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_commit_id: Option<CommitId>,
    /// 可安全物理清理的时间
    pub purge_eligible_at: Option<String>,
}

/// Tombstone 目标对象类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TombstoneTargetType {
    Project,
    Entry,
    Attachment,
    Branch,
    ObjectRelation,
    ObjectLabel,
    ObjectLabelAssignment,
}

impl std::fmt::Display for TombstoneTargetType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TombstoneTargetType::Project => write!(f, "project"),
            TombstoneTargetType::Entry => write!(f, "entry"),
            TombstoneTargetType::Attachment => write!(f, "attachment"),
            TombstoneTargetType::Branch => write!(f, "branch"),
            TombstoneTargetType::ObjectRelation => write!(f, "object-relation"),
            TombstoneTargetType::ObjectLabel => write!(f, "object-label"),
            TombstoneTargetType::ObjectLabelAssignment => {
                write!(f, "object-label-assignment")
            }
        }
    }
}

impl std::str::FromStr for TombstoneTargetType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "project" => Ok(TombstoneTargetType::Project),
            "entry" => Ok(TombstoneTargetType::Entry),
            "attachment" => Ok(TombstoneTargetType::Attachment),
            "branch" => Ok(TombstoneTargetType::Branch),
            "object-relation" => Ok(TombstoneTargetType::ObjectRelation),
            "object-label" => Ok(TombstoneTargetType::ObjectLabel),
            "object-label-assignment" => Ok(TombstoneTargetType::ObjectLabelAssignment),
            _ => Err(format!("unknown TombstoneTargetType: {}", s)),
        }
    }
}

/// Vault 级元信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMeta {
    pub vault_id: VaultId,
    pub format_version: String,
    pub created_at: String,
    pub updated_at: String,
    pub default_tiga_mode: String,
    pub active_key_epoch_id: KeyEpochId,
    /// 兼容性标志（逗号分隔或 JSON 数组）
    pub compat_flags: String,
    /// 关键扩展标识
    pub critical_extensions: String,
    /// 内部 schema 序号。旧序列化数据缺失时按 MDBX-1 处理。
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// 最低可读取格式代际。
    #[serde(default = "default_mdbx1_version")]
    pub min_reader_version: String,
    /// 最低可安全写入格式代际。
    #[serde(default = "default_mdbx1_version")]
    pub min_writer_version: String,
}

fn default_schema_version() -> u32 {
    1
}

fn default_mdbx1_version() -> String {
    "MDBX-1".to_string()
}

/// 密钥轮换时期的记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEpoch {
    pub key_epoch_id: KeyEpochId,
    pub status: KeyEpochStatus,
    pub wrapped_epoch_key_ct: CipherText,
    pub kdf_profile_id: String,
    pub created_at: String,
    pub activated_at: Option<String>,
    pub retired_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyEpochStatus {
    Created,
    Active,
    Retired,
}

impl std::fmt::Display for KeyEpochStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KeyEpochStatus::Created => write!(f, "created"),
            KeyEpochStatus::Active => write!(f, "active"),
            KeyEpochStatus::Retired => write!(f, "retired"),
        }
    }
}

/// Snapshot 恢复检查点。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub snapshot_id: SnapshotId,
    pub base_commit_id: CommitId,
    pub snapshot_ct: CipherText,
    pub snapshot_hash: String,
    pub created_at: String,
    pub created_by_device_id: DeviceId,
}

/// 有界快照导航摘要。
///
/// 摘要只包含快照记录元数据和密文长度，不包含 `snapshot_ct` 内容，也不
/// 表示已经完成密文或 payload 完整性校验。完整 [`Snapshot`] 仍用于显式
/// 恢复、校验和兼容读取。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotSummary {
    pub snapshot_id: SnapshotId,
    pub base_commit_id: CommitId,
    pub snapshot_hash: String,
    pub snapshot_ciphertext_bytes: u64,
    pub created_at: String,
    pub created_by_device_id: DeviceId,
}

/// 有界快照摘要页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotSummaryPage {
    pub items: Vec<SnapshotSummary>,
    pub next_cursor: Option<String>,
}

/// Snapshot recovery-point classification. Legacy rows without lifecycle
/// metadata are treated as protected `Manual` points by storage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotKind {
    Manual,
    Automatic,
}

impl std::fmt::Display for SnapshotKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnapshotKind::Manual => write!(f, "manual"),
            SnapshotKind::Automatic => write!(f, "automatic"),
        }
    }
}

impl std::str::FromStr for SnapshotKind {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "manual" => Ok(Self::Manual),
            "automatic" => Ok(Self::Automatic),
            _ => Err(format!("unknown snapshot kind: {value}")),
        }
    }
}

/// Authenticated lifecycle metadata exposed independently from the legacy
/// snapshot payload and summary record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotLifecycleSummary {
    pub snapshot_id: SnapshotId,
    pub kind: SnapshotKind,
    pub retention_eligible_at: Option<String>,
}

/// One bounded candidate in an automatic snapshot prune plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotPruneCandidate {
    pub summary: SnapshotSummary,
    pub retention_eligible_at: String,
}

/// Read-only, bounded snapshot prune plan. The token is opaque to clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotPrunePlan {
    pub plan_token: String,
    pub keep_latest: usize,
    pub candidates: Vec<SnapshotPruneCandidate>,
    pub has_more: bool,
    pub total_ciphertext_bytes: u64,
}

/// Result of one authorized, atomic automatic-snapshot prune operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotPruneResult {
    pub plan_token: String,
    pub commit_id: String,
    pub deleted_snapshot_ids: Vec<SnapshotId>,
}

/// 冲突记录 — 并发修改无法自动合并时产生。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conflict {
    pub conflict_id: String,
    /// 冲突对象类型
    pub object_type: ConflictObjectType,
    /// 冲突对象 ID
    pub object_id: String,
    /// 共同祖先 commit
    pub base_commit_id: CommitId,
    /// 本地版本 commit
    pub local_commit_id: CommitId,
    /// 传入版本 commit
    pub incoming_commit_id: CommitId,
    /// 冲突字段列表（JSON 路径）
    pub conflicting_fields: Vec<String>,
    /// 解决状态
    pub resolution: ConflictResolution,
    /// 创建时间
    pub created_at: String,
    /// 解决时间
    pub resolved_at: Option<String>,
}

/// 有界冲突导航摘要。
///
/// 与完整 [`Conflict`] 相比，摘要只允许 storage 层合同范围内的冲突字段
/// 路径，供列表/选择界面使用；它不改变冲突解决所需的完整读取 API。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSummary {
    pub conflict_id: String,
    pub object_type: ConflictObjectType,
    pub object_id: String,
    pub base_commit_id: CommitId,
    pub local_commit_id: CommitId,
    pub incoming_commit_id: CommitId,
    pub conflicting_fields: Vec<String>,
    pub resolution: ConflictResolution,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

/// 有界 unresolved conflict 摘要页。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictSummaryPage {
    pub items: Vec<ConflictSummary>,
    pub next_cursor: Option<String>,
}

/// 冲突涉及的对象类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictObjectType {
    Project,
    Entry,
    Attachment,
    ObjectRelation,
    ObjectLabel,
    ObjectLabelAssignment,
}

impl std::fmt::Display for ConflictObjectType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConflictObjectType::Project => write!(f, "project"),
            ConflictObjectType::Entry => write!(f, "entry"),
            ConflictObjectType::Attachment => write!(f, "attachment"),
            ConflictObjectType::ObjectRelation => write!(f, "object-relation"),
            ConflictObjectType::ObjectLabel => write!(f, "object-label"),
            ConflictObjectType::ObjectLabelAssignment => write!(f, "object-label-assignment"),
        }
    }
}

impl std::str::FromStr for ConflictObjectType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "project" => Ok(ConflictObjectType::Project),
            "entry" => Ok(ConflictObjectType::Entry),
            "attachment" => Ok(ConflictObjectType::Attachment),
            "object-relation" => Ok(ConflictObjectType::ObjectRelation),
            "object-label" => Ok(ConflictObjectType::ObjectLabel),
            "object-label-assignment" => Ok(ConflictObjectType::ObjectLabelAssignment),
            _ => Err(format!("unknown ConflictObjectType: {}", s)),
        }
    }
}

/// 冲突解决状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictResolution {
    /// 尚未解决
    Unresolved,
    /// 采用本地版本
    LocalWins,
    /// 采用传入版本
    IncomingWins,
    /// 用户自定义合并
    Custom,
}

impl ConflictResolution {
    pub fn is_resolved(&self) -> bool {
        !matches!(self, ConflictResolution::Unresolved)
    }
}

impl std::fmt::Display for ConflictResolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConflictResolution::Unresolved => write!(f, "unresolved"),
            ConflictResolution::LocalWins => write!(f, "local-wins"),
            ConflictResolution::IncomingWins => write!(f, "incoming-wins"),
            ConflictResolution::Custom => write!(f, "custom"),
        }
    }
}

impl std::str::FromStr for ConflictResolution {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "unresolved" => Ok(ConflictResolution::Unresolved),
            "local-wins" => Ok(ConflictResolution::LocalWins),
            "incoming-wins" => Ok(ConflictResolution::IncomingWins),
            "custom" => Ok(ConflictResolution::Custom),
            _ => Err(format!("unknown ConflictResolution: {}", s)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_kinds_roundtrip_exact_strings_and_reject_unknown_values() {
        let cases = [
            (CommitKind::Change, "change"),
            (CommitKind::Merge, "merge"),
            (CommitKind::Snapshot, "snapshot"),
            (CommitKind::KeyRotation, "key-rotation"),
            (CommitKind::Move, "move"),
            (CommitKind::Copy, "copy"),
            (CommitKind::Restore, "restore"),
            (CommitKind::Multi, "multi"),
        ];

        for (kind, encoded) in cases {
            assert_eq!(kind.to_string(), encoded);
            assert_eq!(encoded.parse::<CommitKind>().unwrap(), kind);
            assert_eq!(
                serde_json::to_string(&kind).unwrap(),
                format!(r#""{encoded}""#)
            );
            assert_eq!(
                serde_json::from_str::<CommitKind>(&format!(r#""{encoded}""#)).unwrap(),
                kind
            );
        }
        assert!("unknown".parse::<CommitKind>().is_err());
    }

    #[test]
    fn change_scopes_roundtrip_exact_strings_and_reject_unknown_values() {
        let cases = [
            (ChangeScope::Project, "project"),
            (ChangeScope::Entry, "entry"),
            (ChangeScope::Attachment, "attachment"),
            (ChangeScope::ObjectRelation, "object-relation"),
            (ChangeScope::ObjectLabel, "object-label"),
            (
                ChangeScope::ObjectLabelAssignment,
                "object-label-assignment",
            ),
            (ChangeScope::VaultMeta, "vault-meta"),
            (ChangeScope::KeyEpoch, "key-epoch"),
            (ChangeScope::Multi, "multi"),
            (ChangeScope::Snapshot, "snapshot"),
            (ChangeScope::Branch, "branch"),
        ];

        for (scope, encoded) in cases {
            assert_eq!(scope.to_string(), encoded);
            assert_eq!(encoded.parse::<ChangeScope>().unwrap(), scope);
            assert_eq!(
                serde_json::to_string(&scope).unwrap(),
                format!(r#""{encoded}""#)
            );
            assert_eq!(
                serde_json::from_str::<ChangeScope>(&format!(r#""{encoded}""#)).unwrap(),
                scope
            );
        }
        assert!("future-scope".parse::<ChangeScope>().is_err());
    }

    #[test]
    fn snapshot_summary_roundtrips_without_snapshot_ciphertext() {
        let summary = SnapshotSummary {
            snapshot_id: "snapshot-1".to_string(),
            base_commit_id: "commit-1".to_string(),
            snapshot_hash: "a".repeat(64),
            snapshot_ciphertext_bytes: 4096,
            created_at: "2026-07-25T00:00:00Z".to_string(),
            created_by_device_id: "device-1".to_string(),
        };
        let encoded = serde_json::to_vec(&summary).unwrap();
        let decoded: SnapshotSummary = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, summary);
        assert!(!encoded.windows(11).any(|window| window == b"snapshot_ct"));
    }

    #[test]
    fn conflict_summary_roundtrips_without_changing_complete_conflict_shape() {
        let summary = ConflictSummary {
            conflict_id: "conflict-1".to_string(),
            object_type: ConflictObjectType::Entry,
            object_id: "entry-1".to_string(),
            base_commit_id: "base-1".to_string(),
            local_commit_id: "local-1".to_string(),
            incoming_commit_id: "incoming-1".to_string(),
            conflicting_fields: vec!["payload.password".to_string()],
            resolution: ConflictResolution::Unresolved,
            created_at: "2026-07-25T00:00:00Z".to_string(),
            resolved_at: None,
        };
        let encoded = serde_json::to_vec(&summary).unwrap();
        let decoded: ConflictSummary = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, summary);
    }

    #[test]
    fn legacy_vault_meta_defaults_to_mdbx1_compatibility() {
        let meta: VaultMeta = serde_json::from_value(serde_json::json!({
            "vault_id": "vault-1",
            "format_version": "MDBX-1",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
            "default_tiga_mode": "multi",
            "active_key_epoch_id": "epoch-1",
            "compat_flags": "",
            "critical_extensions": ""
        }))
        .unwrap();

        assert_eq!(meta.schema_version, 1);
        assert_eq!(meta.min_reader_version, "MDBX-1");
        assert_eq!(meta.min_writer_version, "MDBX-1");
    }
}
