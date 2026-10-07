use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand, ValueEnum};
#[cfg(any(not(feature = "external-blob-store"), test))]
use mdbx_core::model::attachment::StorageMode;
#[cfg(test)]
use mdbx_core::model::{ChangeScope, CommitKind};
use mdbx_core::model::{Entry, EntryType, ObjectSummary};
use mdbx_core::tiga::{DeviceAssurance, DeviceContext, TigaMode};
use mdbx_storage::backup::BackupService;
#[cfg(feature = "benchmark")]
use mdbx_storage::benchmark::{BenchmarkMode, BenchmarkRunner};
#[cfg(feature = "external-blob-store")]
use mdbx_storage::blob_lifecycle::{BlobAuditOptions, BlobLifecycleLimits, BlobLifecycleService};
#[cfg(feature = "external-blob-store")]
use mdbx_storage::blob_replica::{
    BlobReplicaPageRequest, BlobReplicaService, BlobReplicaTransferCheckpoint,
    BlobReplicaTransferLimits,
};
#[cfg(feature = "external-blob-store")]
use mdbx_storage::blob_store::FileSystemBlobStore;
#[cfg(all(feature = "external-blob-store", test))]
use mdbx_storage::blob_store::ManageableEncryptedBlobStore;
#[cfg(feature = "external-blob-store")]
use mdbx_storage::blob_transfer::{
    BlobTransferCheckpoint, BlobTransferLimits, BlobTransferService,
};
use mdbx_storage::capability::{BuildCapabilityManifest, CapabilitySet};
use mdbx_storage::connection::{PendingVaultCreation, VaultConnection};
#[cfg(any(
    feature = "kdbx-import",
    feature = "kdbx-export",
    feature = "kdbx-binary-import",
    feature = "kdbx-binary-export"
))]
use mdbx_storage::import::KdbxEntry;
#[cfg(feature = "kdbx-export")]
use mdbx_storage::import::KdbxExporter;
#[cfg(feature = "kdbx-import")]
use mdbx_storage::import::{ImportResult, KdbxImporter};
#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
use mdbx_storage::import::{KdbxBinaryAdapter, KdbxBinaryLimits};
use mdbx_storage::init::{initialize_vault, VaultInitParams};
use mdbx_storage::integrity_root::{
    IntegrityRootService, IntegrityRootState, IntegrityRootStatus, IntegrityRootVerification,
};
use mdbx_storage::object_disclosure::ObjectDisclosureService;
use mdbx_storage::peer_sync::{PeerSyncSegmentOptions, PeerSyncService};
use mdbx_storage::recovery::{IssueSeverity, RecoveryVerifier};
#[cfg(not(test))]
use mdbx_storage::repo::MAX_COMMIT_INVENTORY_PAGE_SIZE;
use mdbx_storage::repo::{
    AttachmentPlaintextPurpose, AttachmentRepo, AttachmentSummaryRepo, AttachmentWriteOptions,
    CollectionSummaryRepo, EntryRepo, ObjectSummaryRepo, ProjectRepo, SnapshotLifecycleRepo,
    SnapshotRepo, SnapshotSummaryRepo, MAX_ATTACHMENT_SUMMARY_PAGE_SIZE,
    MAX_COLLECTION_SUMMARY_PAGE_SIZE, MAX_SNAPSHOT_PRUNE_CANDIDATES,
    MAX_SNAPSHOT_PRUNE_KEEP_LATEST, MAX_SNAPSHOT_SUMMARY_PAGE_SIZE,
};
use mdbx_storage::repo::{CommitContext, CommitOperation, OperationExecution};
use mdbx_storage::rollback_anchor::{RollbackAnchorService, MAX_ROLLBACK_ANCHOR_BYTES};
#[cfg(feature = "search")]
use mdbx_storage::search::SearchService;
use mdbx_storage::sync_apply::{ApplyBatchResult, SyncApplyRepo};
use mdbx_storage::tiga_policy::TigaAuthorizationContext;
use mdbx_storage::unlock::UnlockService;
use mdbx_storage::vault_content_manifest::{
    VaultContentManifestService, MAX_VAULT_CONTENT_MANIFEST_BYTES,
};
#[cfg(test)]
use mdbx_sync::SerializedCommit;
use mdbx_sync::{
    read_bundle_file_with_limits_authenticated, write_bundle_with_compression,
    write_bundle_with_compression_authenticated, write_incremental_bundle_with_compression,
    write_incremental_bundle_with_compression_authenticated, BundleCompression, BundleReadLimits,
    CommitBatch, IncrementalBundleCheckpoint, IncrementalBundleResume, IncrementalSyncBundle,
    SyncBundleFile,
};
use rusqlite::{params, OptionalExtension};
#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
use zeroize::Zeroizing;

fn prompt(prompt_text: &str) -> String {
    eprint!("{}", prompt_text);
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).unwrap();
    input.trim().to_string()
}

fn prompt_password(prompt_text: &str) -> String {
    rpassword::prompt_password(prompt_text).unwrap()
}

#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
const MAX_KDBX_PASSWORD_BYTES: usize = 4096;

#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
fn read_kdbx_password(password_stdin: bool, confirm: bool) -> Result<Zeroizing<String>, String> {
    if password_stdin {
        return read_kdbx_password_from(&mut std::io::stdin().lock());
    }

    let password = Zeroizing::new(
        rpassword::prompt_password("KDBX password: ")
            .map_err(|error| format!("failed to read KDBX password: {error}"))?,
    );
    validate_kdbx_password_length(&password)?;
    if confirm {
        let confirmation = Zeroizing::new(
            rpassword::prompt_password("Confirm KDBX password: ")
                .map_err(|error| format!("failed to confirm KDBX password: {error}"))?,
        );
        validate_kdbx_password_length(&confirmation)?;
        if password.as_str() != confirmation.as_str() {
            return Err("KDBX password confirmation does not match".to_string());
        }
    }
    Ok(password)
}

#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
fn read_kdbx_password_from(reader: &mut dyn Read) -> Result<Zeroizing<String>, String> {
    let mut bytes = Zeroizing::new(Vec::new());
    reader
        .take((MAX_KDBX_PASSWORD_BYTES + 3) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read KDBX password from stdin: {error}"))?;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    if bytes.contains(&b'\n') || bytes.contains(&b'\r') {
        return Err("KDBX password stdin must contain exactly one line".to_string());
    }
    if bytes.len() > MAX_KDBX_PASSWORD_BYTES {
        return Err(format!(
            "KDBX password exceeds {MAX_KDBX_PASSWORD_BYTES} bytes"
        ));
    }
    let password =
        std::str::from_utf8(&bytes).map_err(|_| "KDBX password stdin must be UTF-8".to_string())?;
    Ok(Zeroizing::new(password.to_string()))
}

#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
fn validate_kdbx_password_length(password: &str) -> Result<(), String> {
    if password.len() > MAX_KDBX_PASSWORD_BYTES {
        return Err(format!(
            "KDBX password exceeds {MAX_KDBX_PASSWORD_BYTES} bytes"
        ));
    }
    Ok(())
}

/// Monica DataBase eXchange — 离线优先密码管理器 CLI
#[derive(Parser)]
#[command(name = "mdbx", version, about)]
struct Cli {
    /// vault 文件路径（默认 ./vault.mdbx）
    #[arg(short, long, default_value = "vault.mdbx")]
    vault: PathBuf,

    /// 非交互解锁密码（用于脚本和自动化测试）
    #[arg(long, global = true)]
    unlock_password: Option<String>,

    /// 非交互解锁 PIN（用于脚本和自动化测试）
    #[arg(long, global = true)]
    unlock_pin: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 显示当前二进制实际编译的模块能力
    Capabilities {
        /// 以机器可读 JSON 输出
        #[arg(long)]
        json: bool,
    },
    /// 创建新 vault 并设置解锁凭据
    Init {
        /// Tiga 安全模式: power, multi (默认), sky
        #[arg(short, long, default_value = "multi")]
        tiga: String,
        /// 非交互设置密码
        #[arg(long)]
        password: Option<String>,
        /// 非交互设置 PIN
        #[arg(long)]
        pin: Option<String>,
    },
    /// 解锁 vault（输入凭据以启用加密）
    Unlock,
    /// 管理项目分组
    Project {
        #[command(subcommand)]
        action: ProjectAction,
    },
    /// 管理密码条目
    Entry {
        #[command(subcommand)]
        action: EntryAction,
    },
    /// 管理附件
    Attach {
        #[command(subcommand)]
        action: AttachAction,
    },
    /// 审计和维护外部加密 Blob Provider
    Blob {
        #[command(subcommand)]
        action: BlobAction,
    },
    /// 快照备份与恢复
    Snapshot {
        #[command(subcommand)]
        action: SnapshotAction,
    },
    /// 全文搜索
    #[cfg(feature = "search")]
    Search {
        /// 搜索关键词
        query: Option<String>,
        /// 按标签筛选
        #[arg(short, long)]
        tag: Option<String>,
        /// 按条目类型筛选
        #[arg(short, long)]
        entry_type: Option<String>,
    },
    /// 同步（预留）
    Sync {
        #[command(subcommand)]
        action: SyncAction,
    },
    /// 运行 vault 健康检查
    Health,
    /// 创建或验证由客户端持久化的外部回滚锚点
    Anchor {
        #[command(subcommand)]
        action: AnchorAction,
    },
    /// 创建或验证 vault 全库内容的精确认证清单
    ContentManifest {
        #[command(subcommand)]
        action: ContentManifestAction,
    },
    /// 管理增量认证状态根
    IntegrityRoot {
        #[command(subcommand)]
        action: IntegrityRootAction,
    },
    /// 创建经过验证的单文件 vault 备份
    Backup {
        /// 输出 `.mdbx` 文件路径；已有文件不会被替换
        output: PathBuf,
    },
    /// 运行本地 benchmark harness
    #[cfg(feature = "benchmark")]
    Benchmark {
        /// 每个 benchmark 的迭代次数
        #[arg(short, long, default_value_t = 20)]
        iterations: u32,
        /// 存储模式；encrypted 使用默认 Multi password 和正式字段加密
        #[arg(long, value_enum, default_value = "encrypted")]
        mode: BenchmarkCliMode,
        /// 以机器可读 JSON 输出
        #[arg(long)]
        json: bool,
        /// 将报告写入指定文件
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// 从加密 KDBX3/KDBX4 文件导入
    #[cfg(feature = "kdbx-binary-import")]
    ImportKdbx {
        /// 输入 KDBX 文件
        file: PathBuf,
        /// 从标准输入读取密码；省略时使用隐藏交互输入
        #[arg(long)]
        password_stdin: bool,
    },
    /// 导出为加密 KDBX4 文件
    #[cfg(feature = "kdbx-binary-export")]
    ExportKdbx {
        /// 输出 KDBX 文件；已有文件不会被替换
        output: PathBuf,
        /// 从标准输入读取密码；省略时使用隐藏交互输入并确认
        #[arg(long)]
        password_stdin: bool,
    },
    /// 从 KDBX JSON 互操作文件导入
    #[cfg(feature = "kdbx-import")]
    ImportKdbxJson {
        /// 输入 JSON 文件，内容为 KdbxEntry 数组
        file: PathBuf,
    },
    /// 导出为 KDBX JSON 互操作文件
    #[cfg(feature = "kdbx-export")]
    ExportKdbxJson {
        /// 输出 JSON 文件
        output: PathBuf,
    },
}

#[cfg(feature = "benchmark")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum BenchmarkCliMode {
    Encrypted,
    Compatibility,
}

#[cfg(feature = "benchmark")]
impl From<BenchmarkCliMode> for BenchmarkMode {
    fn from(value: BenchmarkCliMode) -> Self {
        match value {
            BenchmarkCliMode::Encrypted => Self::Encrypted,
            BenchmarkCliMode::Compatibility => Self::Compatibility,
        }
    }
}

#[derive(Subcommand)]
enum ProjectAction {
    /// 列出所有项目
    List,
    /// 列出已软删除项目
    Deleted,
    /// 创建新项目
    Create {
        /// 项目标题
        title: String,
        /// 分组 ID（可选）
        #[arg(short, long)]
        group: Option<String>,
    },
    /// 查看项目详情
    Get { project_id: String },
    /// 编辑项目
    Edit {
        project_id: String,
        /// 新标题
        #[arg(short, long)]
        title: Option<String>,
        /// 切换收藏
        #[arg(short, long)]
        favorite: Option<bool>,
    },
    /// 删除项目（软删除）
    Delete { project_id: String },
}

#[derive(Subcommand)]
enum EntryAction {
    /// 列出项目中的所有条目
    List {
        project_id: String,
        /// 按类型筛选
        #[arg(short, long)]
        entry_type: Option<String>,
    },
    /// 创建新条目
    Create {
        project_id: String,
        /// 条目类型（login/note/card/identity/totp/passkey/ssh_key/api_token/document_ref）
        #[arg(short, long, default_value = "login")]
        entry_type: String,
        /// 条目标题
        #[arg(short, long)]
        title: Option<String>,
        /// 用户名
        #[arg(short, long)]
        username: Option<String>,
        /// 密码（不提供则交互输入）
        #[arg(short, long)]
        password: Option<String>,
        /// URL
        #[arg(short = 'l', long)]
        url: Option<String>,
        /// 备注
        #[arg(short, long)]
        notes: Option<String>,
    },
    /// 查看条目详情（默认隐藏载荷）
    Get {
        entry_id: String,
        /// 经 Tiga 授权后显式披露秘密载荷
        #[arg(long)]
        reveal: bool,
    },
    /// 编辑条目
    Edit {
        entry_id: String,
        /// 新标题
        #[arg(short, long)]
        title: Option<String>,
        /// 用户名
        #[arg(short, long)]
        username: Option<String>,
        /// 密码
        #[arg(short, long)]
        password: Option<String>,
        /// URL
        #[arg(short = 'l', long)]
        url: Option<String>,
        /// 备注
        #[arg(short, long)]
        notes: Option<String>,
    },
    /// 列出已软删除条目
    Deleted,
    /// 移动条目到另一个项目
    Move {
        entry_id: String,
        target_project_id: String,
    },
    /// 复制条目到另一个项目
    Copy {
        entry_id: String,
        target_project_id: String,
    },
    /// 删除条目（软删除）
    Delete { entry_id: String },
}

#[derive(Subcommand)]
enum AttachAction {
    /// 列出项目的附件
    List {
        /// 按项目 ID 列出
        #[arg(short, long)]
        project_id: Option<String>,
        /// 按条目 ID 列出
        #[arg(short, long)]
        entry_id: Option<String>,
    },
    /// 添加附件（从文件导入）
    Add {
        /// 所属项目 ID
        project_id: String,
        /// 所属条目 ID（可选）
        #[arg(short, long)]
        entry_id: Option<String>,
        /// 附件文件路径
        file: PathBuf,
        /// 将加密分块保存到 `<vault>.blobs` 内容寻址目录
        #[arg(long)]
        external: bool,
    },
    /// 导出附件内容
    Get {
        attachment_id: String,
        /// 输出文件路径（默认 stdout）
        #[arg(short, long)]
        output: Option<PathBuf>,
    },
    /// 查看附件元数据
    Info { attachment_id: String },
    /// 重命名附件元数据（不重写内容）
    Rename {
        attachment_id: String,
        file_name: String,
        /// 新 media type（可选）
        #[arg(short, long)]
        media_type: Option<String>,
    },
    /// 校验附件内容完整性
    Verify { attachment_id: String },
    /// 删除附件（软删除）
    Delete { attachment_id: String },
    /// 列出已软删除附件
    Deleted,
}

#[derive(Subcommand)]
enum BlobAction {
    /// 审计引用、缺失、损坏和未引用 Blob
    Audit {
        /// 未引用 Blob 的保护时长，单位小时
        #[arg(long, default_value_t = 168)]
        grace_hours: u64,
        /// 跳过密文内容读取，仅检查引用与 Provider 清单
        #[arg(long)]
        skip_content_verification: bool,
    },
    /// 生成垃圾回收计划凭证
    GcPlan {
        /// 未引用 Blob 的保护时长，单位小时
        #[arg(long, default_value_t = 168)]
        grace_hours: u64,
    },
    /// 使用计划凭证执行垃圾回收
    GcApply {
        plan_token: String,
        /// `gc-plan` 返回的固定清理时间边界
        #[arg(long)]
        cutoff_unix_secs: i64,
    },
    /// 将当前 vault Provider 中的加密 Blob 传输到另一个 Provider
    Transfer {
        /// 内容寻址 Blob ID
        blob_id: String,
        /// Blob ciphertext 的精确字节数
        #[arg(long)]
        size: u64,
        /// 目标 filesystem Provider 根目录
        #[arg(long)]
        destination: PathBuf,
        /// 续传 checkpoint 文件
        #[arg(long)]
        checkpoint: PathBuf,
        /// 每个传输块的最大字节数
        #[arg(long, default_value_t = 1024 * 1024)]
        chunk_size: usize,
        /// 本次调用最多传输的块数
        #[arg(long, default_value_t = 10_000)]
        max_chunks: usize,
        /// Provider 租约有效期，单位秒
        #[arg(long, default_value_t = 5 * 60)]
        lease_ttl_secs: i64,
    },
    /// 生成当前 vault 引用在目标 Provider 上的差异计划
    ReplicaPlan {
        /// 目标 filesystem Provider 根目录
        #[arg(long)]
        destination: PathBuf,
        /// 上一页返回的 Blob ID
        #[arg(long)]
        cursor: Option<String>,
        /// 第一页返回的 plan token
        #[arg(long)]
        checkpoint: Option<String>,
        /// 每页最多返回的差异项
        #[arg(long, default_value_t = 100)]
        page_size: usize,
        /// 输出机器可读 JSON
        #[arg(long)]
        json: bool,
    },
    /// 自动复制当前 vault 引用的全部可传输 Blob
    Replicate {
        /// 目标 filesystem Provider 根目录
        #[arg(long)]
        destination: PathBuf,
        /// 批量续传 checkpoint 文件
        #[arg(long)]
        checkpoint: PathBuf,
        /// planner 每页最多处理的差异项
        #[arg(long, default_value_t = 100)]
        page_size: usize,
        /// 本次调用最多完成的 Blob 数
        #[arg(long, default_value_t = 100)]
        max_items: usize,
        /// 单个传输块的最大字节数
        #[arg(long, default_value_t = 1024 * 1024)]
        chunk_size: usize,
        /// 单个 Blob 本次最多传输的块数
        #[arg(long, default_value_t = 10_000)]
        max_chunks: usize,
        /// 单个 Blob 的最大 ciphertext 字节数
        #[arg(long, default_value_t = 8 * 1024 * 1024 * 1024_u64)]
        max_blob_bytes: u64,
        /// Provider 租约有效期，单位秒
        #[arg(long, default_value_t = 5 * 60)]
        lease_ttl_secs: i64,
    },
}

#[derive(Subcommand)]
enum SnapshotAction {
    /// 创建快照
    Create,
    /// 创建经 TIGA 授权的自动快照
    CreateAutomatic {
        #[arg(long)]
        retention_eligible_at: String,
    },
    /// 列出所有快照
    List,
    /// 生成自动快照裁剪计划
    PrunePlan {
        #[arg(long, default_value_t = 0)]
        keep_latest: usize,
    },
    /// 按计划裁剪自动快照
    Prune {
        plan_token: String,
        #[arg(long, default_value_t = 0)]
        keep_latest: usize,
    },
    /// 从快照恢复
    Restore { snapshot_id: String },
}

#[derive(Subcommand)]
enum AnchorAction {
    /// 创建新的外部回滚锚点文件；已有文件不会被替换
    Create { output: PathBuf },
    /// 验证 vault 未回退到锚点记录的状态之前
    Verify { input: PathBuf },
}

#[derive(Subcommand)]
enum ContentManifestAction {
    /// 创建新的全库内容清单文件；已有文件不会被替换
    Create { output: PathBuf },
    /// 验证 vault 的精确 schema 与行内容仍匹配清单
    Verify { input: PathBuf },
}

#[derive(Subcommand)]
enum IntegrityRootAction {
    /// 查看根状态；无凭据时只读且不认证元数据
    Status,
    /// 启用并建立认证状态根
    Enable,
    /// 验证根元数据、树节点与当前逻辑状态
    Verify,
    /// 从当前逻辑状态显式重建认证根
    Rebuild,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum BundleCompressionCli {
    None,
    Zstd,
}

impl From<BundleCompressionCli> for BundleCompression {
    fn from(value: BundleCompressionCli) -> Self {
        match value {
            BundleCompressionCli::None => Self::None,
            BundleCompressionCli::Zstd => Self::Zstd,
        }
    }
}

#[derive(Subcommand)]
enum SyncAction {
    /// 导出同步包
    Bundle {
        /// 输出文件路径
        #[arg(short, long, default_value = "sync-bundle.mdbx-sync")]
        output: PathBuf,
        /// 由接收端返回的上一次成功 checkpoint；存在时导出增量 bundle
        #[arg(long)]
        base_checkpoint: Option<PathBuf>,
        /// 保存本次导出的结果 checkpoint，供接收端确认后返回
        #[arg(long)]
        result_checkpoint: Option<PathBuf>,
        /// Bundle 压缩格式；默认保持兼容的未压缩 v3/v4
        #[arg(long, value_enum, default_value = "none")]
        compression: BundleCompressionCli,
        /// 使用当前 vault 完整性子密钥写入 v7-v10 认证 envelope
        #[arg(long)]
        authenticated: bool,
    },
    /// 导入同步包
    Apply {
        /// 输入文件路径
        file: PathBuf,
        /// 增量 peer checkpoint 文件；成功应用后原子更新
        #[arg(long)]
        checkpoint: Option<PathBuf>,
    },
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

fn main() {
    let cli = Cli::parse();

    match run(cli) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("error: {}", e);
            std::process::exit(1);
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let unlock = UnlockArgs {
        password: cli.unlock_password.as_deref(),
        pin: cli.unlock_pin.as_deref(),
    };

    match cli.command {
        Commands::Capabilities { json } => cmd_capabilities(json),
        Commands::Init {
            tiga,
            password,
            pin,
        } => cmd_init(&cli.vault, &tiga, password.as_deref(), pin.as_deref()),
        Commands::Unlock => cmd_unlock(&cli.vault, unlock),
        Commands::Project { action } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_project(&mut conn, action)
        }
        Commands::Entry { action } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_entry(&mut conn, action)
        }
        Commands::Attach { action } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_attach(&mut conn, &cli.vault, action)
        }
        Commands::Blob { action } => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_blob(&conn, &cli.vault, action)
        }
        Commands::Snapshot { action } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_snapshot(&mut conn, action)
        }
        #[cfg(feature = "search")]
        Commands::Search {
            query,
            tag,
            entry_type,
        } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_search(&mut conn, query, tag, entry_type)
        }
        Commands::Sync { action } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_sync(&mut conn, action)
        }
        Commands::Health => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_health(&conn)
        }
        Commands::Anchor { action } => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_anchor(&conn, action)
        }
        Commands::ContentManifest { action } => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_content_manifest(&conn, action)
        }
        Commands::IntegrityRoot {
            action: IntegrityRootAction::Status,
        } if unlock.password.is_none() && unlock.pin.is_none() => {
            let status = IntegrityRootService::status_path(&cli.vault)
                .map_err(|error| format!("failed to inspect integrity root: {error}"))?;
            print_integrity_root_status(&status);
            Ok(())
        }
        Commands::IntegrityRoot { action } => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_integrity_root(&conn, action)
        }
        Commands::Backup { output } => cmd_backup(&cli.vault, output),
        #[cfg(feature = "benchmark")]
        Commands::Benchmark {
            iterations,
            mode,
            json,
            output,
        } => cmd_benchmark(iterations, mode, json, output),
        #[cfg(feature = "kdbx-binary-import")]
        Commands::ImportKdbx {
            file,
            password_stdin,
        } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_import_kdbx(&mut conn, file, password_stdin)
        }
        #[cfg(feature = "kdbx-binary-export")]
        Commands::ExportKdbx {
            output,
            password_stdin,
        } => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_export_kdbx(&conn, output, password_stdin)
        }
        #[cfg(feature = "kdbx-import")]
        Commands::ImportKdbxJson { file } => {
            let mut conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_import_kdbx_json(&mut conn, file)
        }
        #[cfg(feature = "kdbx-export")]
        Commands::ExportKdbxJson { output } => {
            let conn = open_or_create_vault(&cli.vault, unlock)?;
            cmd_export_kdbx_json(&conn, output)
        }
    }
}

fn cmd_capabilities(json: bool) -> Result<(), String> {
    let manifest = CapabilitySet::current().build_manifest();
    println!("{}", render_capability_manifest(&manifest, json)?);
    Ok(())
}

fn render_capability_manifest(
    manifest: &BuildCapabilityManifest,
    json: bool,
) -> Result<String, String> {
    if json {
        return serde_json::to_string_pretty(manifest)
            .map_err(|error| format!("failed to encode build capability manifest: {error}"));
    }

    let mut lines = vec![
        format!("MDBX {} ({})", manifest.engine_version, manifest.profile),
        format!("Storage profile: {}", manifest.storage.profile),
        "Enabled storage capabilities:".to_string(),
    ];
    lines.extend(
        manifest
            .storage
            .enabled_capability_ids
            .iter()
            .map(|capability| format!("  {capability}")),
    );
    lines.push("Disabled optional storage capabilities:".to_string());
    lines.extend(
        manifest
            .storage
            .disabled_optional_capability_ids
            .iter()
            .map(|capability| format!("  {capability}")),
    );
    lines.push(format!(
        "Sync profile: {} (protocol {})",
        manifest.synchronization.profile, manifest.synchronization.protocol_version
    ));
    lines.push("Enabled sync capabilities:".to_string());
    lines.extend(
        manifest
            .synchronization
            .enabled_capability_ids
            .iter()
            .map(|capability| format!("  {capability}")),
    );
    lines.push("Disabled optional sync capabilities:".to_string());
    lines.extend(
        manifest
            .synchronization
            .disabled_optional_capability_ids
            .iter()
            .map(|capability| format!("  {capability}")),
    );
    Ok(lines.join("\n"))
}

#[derive(Clone, Copy)]
struct UnlockArgs<'a> {
    password: Option<&'a str>,
    pin: Option<&'a str>,
}

fn open_or_create_vault(
    path: &std::path::Path,
    unlock: UnlockArgs<'_>,
) -> Result<VaultConnection, String> {
    if path.exists() {
        let mut conn =
            VaultConnection::open(path).map_err(|e| format!("failed to open vault: {}", e))?;
        apply_unlock_args(&mut conn, unlock)?;
        require_unlock_if_configured(&conn)?;
        Ok(conn)
    } else {
        Err(format!(
            "vault not found at '{}'. Run 'mdbx init' to create one.",
            path.display()
        ))
    }
}

fn ctx() -> CommitContext {
    CommitContext::new("cli-device".to_string())
}

const ATTACHMENT_STREAM_CHUNK_SIZE: usize = 1024 * 1024;

fn export_attachment_to_path(
    conn: &mut VaultConnection,
    attachment_id: &str,
    vault_path: &Path,
    output: &Path,
) -> Result<u64, String> {
    let device = cli_device_context();
    AttachmentRepo::authorize_plaintext_access_with_active_session(
        conn,
        attachment_id,
        AttachmentPlaintextPurpose::Export,
        &device,
        chrono::Utc::now().timestamp(),
    )
    .map_err(|error| error.to_string())?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".mdbx-attachment-")
        .tempfile_in(parent)
        .map_err(|error| format!("cannot create temporary output file: {error}"))?;
    let written =
        read_attachment_to_writer(conn, attachment_id, vault_path, temporary.as_file_mut())?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("cannot synchronize temporary output file: {error}"))?;
    temporary
        .persist(output)
        .map_err(|error| format!("cannot replace output file: {}", error.error))?;
    Ok(written)
}

fn default_blob_store_path(vault_path: &Path) -> PathBuf {
    let mut path = vault_path.as_os_str().to_os_string();
    path.push(".blobs");
    PathBuf::from(path)
}

fn read_attachment_to_writer(
    conn: &VaultConnection,
    attachment_id: &str,
    _vault_path: &Path,
    writer: &mut dyn std::io::Write,
) -> Result<u64, String> {
    #[cfg(feature = "external-blob-store")]
    {
        let store = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
        AttachmentRepo::read_content_to_writer_with_blob_store(conn, attachment_id, &store, writer)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "external-blob-store"))]
    {
        let attachment = AttachmentRepo::get_by_id(conn, attachment_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("attachment {attachment_id} not found"))?;
        if attachment.storage_mode == StorageMode::ExternalHashRef {
            return Err(
                "this MDBX build does not include the filesystem encrypted Blob Provider"
                    .to_string(),
            );
        }
        AttachmentRepo::read_content_to_writer(conn, attachment_id, writer)
            .map_err(|error| error.to_string())
    }
}

fn read_attachment_content(
    conn: &VaultConnection,
    attachment_id: &str,
    _vault_path: &Path,
) -> Result<Vec<u8>, String> {
    #[cfg(feature = "external-blob-store")]
    {
        let store = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
        AttachmentRepo::read_content_with_blob_store(conn, attachment_id, &store)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "external-blob-store"))]
    {
        let attachment = AttachmentRepo::get_by_id(conn, attachment_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("attachment {attachment_id} not found"))?;
        if attachment.storage_mode == StorageMode::ExternalHashRef {
            return Err(
                "this MDBX build does not include the filesystem encrypted Blob Provider"
                    .to_string(),
            );
        }
        AttachmentRepo::read_content(conn, attachment_id).map_err(|error| error.to_string())
    }
}

fn verify_attachment_content(
    conn: &VaultConnection,
    attachment_id: &str,
    _vault_path: &Path,
) -> Result<bool, String> {
    #[cfg(feature = "external-blob-store")]
    {
        let store = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
        AttachmentRepo::verify_integrity_with_blob_store(conn, attachment_id, &store)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(feature = "external-blob-store"))]
    {
        let attachment = AttachmentRepo::get_by_id(conn, attachment_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("attachment {attachment_id} not found"))?;
        if attachment.storage_mode == StorageMode::ExternalHashRef {
            return Err(
                "this MDBX build does not include the filesystem encrypted Blob Provider"
                    .to_string(),
            );
        }
        AttachmentRepo::verify_integrity(conn, attachment_id).map_err(|error| error.to_string())
    }
}

fn cli_device_context() -> DeviceContext {
    DeviceContext {
        device_id: Some("cli-device".to_string()),
        assurance: DeviceAssurance::Standard,
        secure_clipboard_available: false,
        screen_capture_protection_available: false,
        secure_temp_files_available: true,
    }
}

fn apply_unlock_args(conn: &mut VaultConnection, unlock: UnlockArgs<'_>) -> Result<(), String> {
    match (unlock.password, unlock.pin) {
        (Some(_), Some(_)) => Err("use only one of --unlock-password or --unlock-pin".to_string()),
        (Some(password), None) => {
            UnlockService::unlock_with_password(conn, password)
                .map_err(|e| format!("unlock failed: {}", e))?;
            Ok(())
        }
        (None, Some(pin)) => {
            UnlockService::unlock_with_pin(conn, pin)
                .map_err(|e| format!("unlock failed: {}", e))?;
            Ok(())
        }
        (None, None) => Ok(()),
    }
}

fn require_unlock_if_configured(conn: &VaultConnection) -> Result<(), String> {
    let methods = UnlockService::list_methods(conn)
        .map_err(|e| format!("failed to inspect unlock methods: {}", e))?;
    if !methods.is_empty() && !conn.is_encrypted() {
        return Err(
            "vault has unlock methods configured; pass --unlock-password or --unlock-pin"
                .to_string(),
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

fn cmd_init(
    path: &std::path::Path,
    tiga: &str,
    password: Option<&str>,
    pin: Option<&str>,
) -> Result<(), String> {
    if path.exists() {
        return Err(format!(
            "vault already exists at '{}'. Delete it first if you want to start fresh.",
            path.display()
        ));
    }
    if password.is_some() && pin.is_some() {
        return Err("use only one of --password or --pin".to_string());
    }

    let tiga_mode: TigaMode = tiga
        .parse()
        .map_err(|e: String| format!("invalid tiga mode: {}", e))?;
    println!(
        "Creating new vault at '{}' (Tiga: {})",
        path.display(),
        tiga_mode
    );

    let mut creation =
        PendingVaultCreation::begin(path).map_err(|e| format!("failed to create vault: {}", e))?;

    let device_id = format!(
        "cli-{}",
        uuid::Uuid::new_v4()
            .to_string()
            .split('-')
            .next()
            .unwrap_or("unknown")
    );
    let params = VaultInitParams {
        default_tiga_mode: tiga_mode.to_string(),
        device_id,
        ..VaultInitParams::default()
    };
    initialize_vault(creation.connection(), &params).map_err(|e| format!("init failed: {}", e))?;

    if let Some(pw) = password {
        UnlockService::setup_password_with_mode(creation.connection_mut(), pw, tiga_mode)
            .map_err(|e| format!("setup failed: {}", e))?;
        drop(creation.commit());
        println!("Vault initialized successfully at '{}'", path.display());
        return Ok(());
    }

    if let Some(pin) = pin {
        UnlockService::setup_pin(creation.connection_mut(), pin)
            .map_err(|e| format!("setup failed: {}", e))?;
        drop(creation.commit());
        println!("Vault initialized successfully at '{}'", path.display());
        return Ok(());
    }

    // 设置解锁凭据
    println!("Choose unlock method:");
    println!("  1. Password");
    println!("  2. PIN (4+ digits)");
    let choice = prompt("Choice [1]: ");
    let choice = if choice.is_empty() { "1" } else { &choice };

    match choice {
        "1" => {
            let pw = prompt_password("Enter password: ");
            let confirm = prompt_password("Confirm password: ");
            if pw != confirm {
                return Err("passwords do not match".to_string());
            }
            UnlockService::setup_password_with_mode(creation.connection_mut(), &pw, tiga_mode)
                .map_err(|e| format!("setup failed: {}", e))?;
        }
        "2" => {
            let pin = prompt_password("Enter PIN (4+ digits): ");
            let confirm = prompt_password("Confirm PIN: ");
            if pin != confirm {
                return Err("PINs do not match".to_string());
            }
            UnlockService::setup_pin(creation.connection_mut(), &pin)
                .map_err(|e| format!("setup failed: {}", e))?;
        }
        _ => return Err("invalid choice".to_string()),
    }

    drop(creation.commit());
    println!("Vault initialized successfully at '{}'", path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// UNLOCK
// ---------------------------------------------------------------------------

fn cmd_unlock(path: &std::path::Path, unlock: UnlockArgs<'_>) -> Result<(), String> {
    let mut conn =
        VaultConnection::open(path).map_err(|e| format!("failed to open vault: {}", e))?;

    if unlock.password.is_some() || unlock.pin.is_some() {
        apply_unlock_args(&mut conn, unlock)?;
        println!("Vault unlocked successfully.");
        return Ok(());
    }

    let methods =
        UnlockService::list_methods(&conn).map_err(|e| format!("failed to list methods: {}", e))?;
    if methods.is_empty() {
        return Err("no unlock methods configured. Run 'mdbx init' first.".to_string());
    }

    println!("Available unlock methods:");
    for (i, m) in methods.iter().enumerate() {
        println!("  {}. {:?}", i + 1, m.method_type);
    }

    let choice = prompt(&format!("Choose method [1-{}]: ", methods.len()));
    let idx: usize = choice
        .parse::<usize>()
        .map_err(|_| "invalid choice".to_string())?
        .checked_sub(1)
        .ok_or("invalid choice")?;

    if idx >= methods.len() {
        return Err("invalid choice".to_string());
    }

    match methods[idx].method_type {
        mdbx_core::model::UnlockMethodType::Password => {
            let pw = prompt_password("Password: ");
            UnlockService::unlock_with_password(&mut conn, &pw)
                .map_err(|e| format!("unlock failed: {}", e))?;
        }
        mdbx_core::model::UnlockMethodType::Pin => {
            let pin = prompt_password("PIN: ");
            UnlockService::unlock_with_pin(&mut conn, &pin)
                .map_err(|e| format!("unlock failed: {}", e))?;
        }
        mdbx_core::model::UnlockMethodType::SecurityKey => {
            return Err("security key unlock not yet supported in CLI".to_string());
        }
        mdbx_core::model::UnlockMethodType::PasswordSecurityKey => {
            return Err("password + security key unlock not yet supported in CLI".to_string());
        }
    }

    println!("Vault unlocked successfully.");
    Ok(())
}

// ---------------------------------------------------------------------------
// PROJECT
// ---------------------------------------------------------------------------

fn cmd_project(conn: &mut VaultConnection, action: ProjectAction) -> Result<(), String> {
    let ctx = ctx();
    match action {
        ProjectAction::List => {
            let mut cursor = None;
            let mut found = false;
            loop {
                let page = CollectionSummaryRepo::list_active(
                    conn,
                    MAX_COLLECTION_SUMMARY_PAGE_SIZE,
                    cursor.as_deref(),
                )
                .map_err(|e| format!("{}", e))?;
                for p in &page.items {
                    found = true;
                    let title = String::from_utf8_lossy(&p.title);
                    let fav = if p.favorite { " ★" } else { "" };
                    println!("{}  {}{}", p.collection_id, title, fav);
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !found {
                println!("(no projects)");
            }
        }
        ProjectAction::Deleted => {
            let mut cursor = None;
            let mut found = false;
            loop {
                let page = CollectionSummaryRepo::list_deleted(
                    conn,
                    MAX_COLLECTION_SUMMARY_PAGE_SIZE,
                    cursor.as_deref(),
                )
                .map_err(|e| format!("{}", e))?;
                for p in &page.items {
                    found = true;
                    let title = String::from_utf8_lossy(&p.title);
                    println!("{}  {}", p.collection_id, title);
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !found {
                println!("(no deleted projects)");
            }
        }
        ProjectAction::Create { title, group } => {
            let p = ProjectRepo::create(conn, &ctx, &title, group.as_deref(), None)
                .map_err(|e| format!("{}", e))?;
            println!("Created project {}", p.project_id);
        }
        ProjectAction::Get { project_id } => {
            let p = ProjectRepo::get_by_id(conn, &project_id)
                .map_err(|e| format!("{}", e))?
                .ok_or("project not found")?;
            let title = String::from_utf8_lossy(&p.title_ct);
            println!("ID:        {}", p.project_id);
            println!("Title:     {}", title);
            println!("Group:     {}", p.group_id.as_deref().unwrap_or("-"));
            println!("Favorite:  {}", p.favorite);
            println!("Archived:  {}", p.archived);
            println!("Attach:    {}", p.attachment_count);
            println!("Updated:   {}", p.updated_at);
        }
        ProjectAction::Edit {
            project_id,
            title,
            favorite,
        } => {
            let mut p = ProjectRepo::get_by_id(conn, &project_id)
                .map_err(|e| format!("{}", e))?
                .ok_or("project not found")?;
            if let Some(t) = title {
                p.title_ct = t.into_bytes();
            }
            if let Some(f) = favorite {
                p.favorite = f;
            }
            ProjectRepo::update(conn, &ctx, &p).map_err(|e| format!("{}", e))?;
            println!("Updated project {}", project_id);
        }
        ProjectAction::Delete { project_id } => {
            ProjectRepo::soft_delete(conn, &ctx, &project_id).map_err(|e| format!("{}", e))?;
            println!("Deleted project {}", project_id);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ENTRY
// ---------------------------------------------------------------------------

fn render_entry_header(
    object_id: &str,
    collection_id: &str,
    object_type: &EntryType,
    title: Option<&[u8]>,
    deleted: bool,
    updated_at: &str,
) -> Vec<String> {
    let title = title
        .map(|value| String::from_utf8_lossy(value).to_string())
        .unwrap_or_else(|| "(untitled)".to_string());
    vec![
        format!("ID:         {object_id}"),
        format!("Project:    {collection_id}"),
        format!("Type:       {object_type:?}"),
        format!("Title:      {title}"),
        format!("Deleted:    {deleted}"),
        format!("Updated:    {updated_at}"),
    ]
}

fn render_redacted_entry_summary(summary: &ObjectSummary) -> String {
    let mut lines = render_entry_header(
        &summary.object_id,
        &summary.collection_id,
        &summary.object_type_id,
        summary.title.as_deref(),
        summary.deleted,
        &summary.updated_at,
    );
    lines.push("Payload:    [redacted; use --reveal]".to_string());
    lines.join("\n")
}

fn render_disclosed_entry(entry: &Entry) -> Result<String, String> {
    let mut lines = render_entry_header(
        &entry.entry_id,
        &entry.project_id,
        &entry.entry_type,
        entry.title_ct.as_deref(),
        entry.deleted,
        &entry.updated_at,
    );
    let payload: serde_json::Value = serde_json::from_slice(&entry.payload_ct)
        .map_err(|error| format!("object payload is not valid JSON: {error}"))?;
    lines.push("Payload:".to_string());
    if let Some(fields) = payload.as_object() {
        if fields.is_empty() {
            lines.push("  {}".to_string());
        } else {
            for (key, value) in fields {
                let value = value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string());
                lines.push(format!("  {key}: {value}"));
            }
        }
    } else {
        lines.push(format!("  {payload}"));
    }
    Ok(lines.join("\n"))
}

fn cmd_entry(conn: &mut VaultConnection, action: EntryAction) -> Result<(), String> {
    let ctx = ctx();
    match action {
        EntryAction::List {
            project_id,
            entry_type,
        } => {
            let entry_type = entry_type
                .map(|value| {
                    value
                        .parse::<EntryType>()
                        .map_err(|_| format!("unknown entry type: {value}"))
                })
                .transpose()?;
            let mut cursor = None;
            let mut found = false;
            loop {
                let page = ObjectSummaryRepo::list(
                    conn,
                    &project_id,
                    entry_type.as_ref(),
                    100,
                    cursor.as_deref(),
                )
                .map_err(|error| error.to_string())?;
                for object in page.items {
                    found = true;
                    let title = object
                        .title
                        .as_ref()
                        .map(|title| String::from_utf8_lossy(title).to_string())
                        .unwrap_or_else(|| "(untitled)".to_string());
                    println!(
                        "{}  {:?}  {}",
                        object.object_id, object.object_type_id, title
                    );
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !found {
                println!("(no entries)");
            }
        }
        EntryAction::Create {
            project_id,
            entry_type,
            title,
            username,
            password,
            url,
            notes,
        } => {
            let et: EntryType = entry_type
                .parse()
                .map_err(|_| format!("unknown entry type: {}", entry_type))?;
            let mut payload = serde_json::Map::new();
            if let Some(u) = username {
                payload.insert("username".into(), u.into());
            }
            if let Some(p) = password {
                payload.insert("password".into(), p.into());
            }
            if let Some(u) = url {
                payload.insert("url".into(), u.into());
            }
            if let Some(n) = notes {
                payload.insert("notes".into(), n.into());
            }
            let payload = serde_json::Value::Object(payload);

            let e = EntryRepo::create(conn, &ctx, &project_id, et, title.as_deref(), &payload)
                .map_err(|e| format!("{}", e))?;
            println!("Created entry {}", e.entry_id);
        }
        EntryAction::Get { entry_id, reveal } => {
            if reveal {
                let disclosed = ObjectDisclosureService::reveal_with_active_session(
                    conn,
                    &entry_id,
                    &cli_device_context(),
                    chrono::Utc::now().timestamp(),
                )
                .map_err(|error| error.to_string())?;
                println!("{}", render_disclosed_entry(&disclosed.object)?);
            } else {
                let summary = ObjectSummaryRepo::get(conn, &entry_id)
                    .map_err(|error| error.to_string())?
                    .ok_or("entry not found")?;
                println!("{}", render_redacted_entry_summary(&summary));
            }
        }
        EntryAction::Edit {
            entry_id,
            title,
            username,
            password,
            url,
            notes,
        } => {
            let mut e = EntryRepo::get_by_id(conn, &entry_id)
                .map_err(|e| format!("{}", e))?
                .ok_or("entry not found")?;
            if let Some(t) = title {
                e.title_ct = Some(t.into_bytes());
            }

            let mut payload: serde_json::Map<String, serde_json::Value> =
                serde_json::from_slice(&e.payload_ct).unwrap_or_default();
            if let Some(u) = username {
                payload.insert("username".into(), u.into());
            }
            if let Some(p) = password {
                payload.insert("password".into(), p.into());
            }
            if let Some(u) = url {
                payload.insert("url".into(), u.into());
            }
            if let Some(n) = notes {
                payload.insert("notes".into(), n.into());
            }
            e.payload_ct = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;

            EntryRepo::update(conn, &ctx, &e).map_err(|e| format!("{}", e))?;
            println!("Updated entry {}", entry_id);
        }
        EntryAction::Deleted => {
            let mut cursor = None;
            let mut found = false;
            loop {
                let page = ObjectSummaryRepo::list_deleted_all(conn, None, 100, cursor.as_deref())
                    .map_err(|error| error.to_string())?;
                for object in page.items {
                    found = true;
                    let title = object
                        .title
                        .as_ref()
                        .map(|title| String::from_utf8_lossy(title).to_string())
                        .unwrap_or_else(|| "(untitled)".to_string());
                    println!(
                        "{}  {:?}  {}",
                        object.object_id, object.object_type_id, title
                    );
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !found {
                println!("(no deleted entries)");
            }
        }
        EntryAction::Move {
            entry_id,
            target_project_id,
        } => {
            let moved = EntryRepo::move_to_project(conn, &ctx, &entry_id, &target_project_id)
                .map_err(|e| format!("{}", e))?;
            println!("Moved entry {} to {}", moved.entry_id, moved.project_id);
        }
        EntryAction::Copy {
            entry_id,
            target_project_id,
        } => {
            let copied = EntryRepo::copy_to_project(conn, &ctx, &entry_id, &target_project_id)
                .map_err(|e| format!("{}", e))?;
            println!("Copied entry {} to {}", copied.entry_id, copied.project_id);
        }
        EntryAction::Delete { entry_id } => {
            EntryRepo::soft_delete(conn, &ctx, &entry_id).map_err(|e| format!("{}", e))?;
            println!("Deleted entry {}", entry_id);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// ATTACH
// ---------------------------------------------------------------------------

fn cmd_attach(
    conn: &mut VaultConnection,
    vault_path: &Path,
    action: AttachAction,
) -> Result<(), String> {
    let ctx = ctx();
    match action {
        AttachAction::List {
            project_id,
            entry_id,
        } => {
            let (collection_id, object_id) = if let Some(object_id) = entry_id {
                let collection_id = match project_id {
                    Some(collection_id) => collection_id,
                    None => conn
                        .inner()
                        .query_row(
                            "SELECT project_id FROM entries WHERE entry_id = ?1",
                            params![&object_id],
                            |row| row.get::<_, String>(0),
                        )
                        .optional()
                        .map_err(|error| error.to_string())?
                        .ok_or_else(|| format!("entry {object_id} not found"))?,
                };
                (collection_id, Some(object_id))
            } else if let Some(collection_id) = project_id {
                (collection_id, None)
            } else {
                return Err("specify --project-id or --entry-id".to_string());
            };
            let mut cursor = None;
            let mut found = false;
            loop {
                let page = match object_id.as_deref() {
                    Some(object_id) => AttachmentSummaryRepo::list_by_object(
                        conn,
                        &collection_id,
                        object_id,
                        MAX_ATTACHMENT_SUMMARY_PAGE_SIZE,
                        cursor.as_deref(),
                    ),
                    None => AttachmentSummaryRepo::list_by_collection(
                        conn,
                        &collection_id,
                        MAX_ATTACHMENT_SUMMARY_PAGE_SIZE,
                        cursor.as_deref(),
                    ),
                }
                .map_err(|error| error.to_string())?;
                for attachment in page.items {
                    found = true;
                    let name = String::from_utf8_lossy(&attachment.file_name);
                    println!(
                        "{}  {}  {} bytes  {}",
                        attachment.attachment_id,
                        name,
                        attachment.original_size,
                        attachment.content_hash
                    );
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !found {
                println!("(no attachments)");
            }
        }
        AttachAction::Add {
            project_id,
            entry_id,
            file,
            external,
        } => {
            #[cfg(not(feature = "external-blob-store"))]
            if external {
                return Err(
                    "this MDBX build does not include the filesystem encrypted Blob Provider"
                        .to_string(),
                );
            }
            let mut input =
                std::fs::File::open(&file).map_err(|e| format!("cannot open file: {}", e))?;
            let original_size = input
                .metadata()
                .map_err(|e| format!("cannot read file metadata: {}", e))?
                .len();
            let file_name = file
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unnamed")
                .to_string();
            let media_type = mime_guess_for_path(&file);

            let operation = CommitOperation::new(
                uuid::Uuid::new_v4().to_string(),
                "attachment-add",
                "main",
                "change",
                "attachment",
                Vec::new(),
            );
            let result = ctx
                .run_operation(conn, operation, |scoped| {
                    let att = AttachmentRepo::add(
                        conn,
                        scoped,
                        &project_id,
                        entry_id.as_deref(),
                        &file_name,
                        media_type.as_deref(),
                        "",
                        original_size,
                    )?;
                    #[cfg(feature = "external-blob-store")]
                    if external {
                        let store = FileSystemBlobStore::new(default_blob_store_path(vault_path));
                        AttachmentRepo::write_external_content_from_reader_with_options(
                            conn,
                            scoped,
                            &att.attachment_id,
                            &mut input,
                            AttachmentWriteOptions::exact(
                                ATTACHMENT_STREAM_CHUNK_SIZE,
                                original_size,
                            ),
                            &store,
                        )?;
                    } else {
                        AttachmentRepo::write_content_from_reader_with_options(
                            conn,
                            scoped,
                            &att.attachment_id,
                            &mut input,
                            AttachmentWriteOptions::exact(
                                ATTACHMENT_STREAM_CHUNK_SIZE,
                                original_size,
                            ),
                        )?;
                    }
                    #[cfg(not(feature = "external-blob-store"))]
                    AttachmentRepo::write_content_from_reader_with_options(
                        conn,
                        scoped,
                        &att.attachment_id,
                        &mut input,
                        AttachmentWriteOptions::exact(ATTACHMENT_STREAM_CHUNK_SIZE, original_size),
                    )?;
                    Ok(att)
                })
                .map_err(|e| format!("{}", e))?;
            let att = match result {
                OperationExecution::Applied { value, .. } => value,
                OperationExecution::AlreadyCommitted { commit_id } => {
                    return Err(format!(
                        "attachment add operation was already committed as {}",
                        commit_id
                    ));
                }
            };

            println!(
                "Added attachment {} ({} bytes)",
                att.attachment_id, original_size
            );
            if external {
                println!(
                    "Encrypted blobs: {}",
                    default_blob_store_path(vault_path).display()
                );
            }
        }
        AttachAction::Get {
            attachment_id,
            output,
        } => {
            if let Some(path) = output {
                let written = export_attachment_to_path(conn, &attachment_id, vault_path, &path)?;
                println!("Wrote {} bytes to {}", written, path.display());
            } else {
                let device = cli_device_context();
                AttachmentRepo::authorize_plaintext_access_with_active_session(
                    conn,
                    &attachment_id,
                    AttachmentPlaintextPurpose::InMemory,
                    &device,
                    chrono::Utc::now().timestamp(),
                )
                .map_err(|error| error.to_string())?;
                let data = read_attachment_content(conn, &attachment_id, vault_path)?;
                // stdout — only if looks like text
                match std::str::from_utf8(&data) {
                    Ok(s) => println!("{}", s),
                    Err(_) => println!("{:?}", &data[..data.len().min(256)]),
                }
            }
        }
        AttachAction::Info { attachment_id } => {
            let att = AttachmentRepo::get_by_id(conn, &attachment_id)
                .map_err(|e| format!("{}", e))?
                .ok_or("attachment not found")?;
            let name = String::from_utf8_lossy(&att.file_name_ct);
            let media_type = att
                .media_type_ct
                .as_ref()
                .map(|m| String::from_utf8_lossy(m).to_string())
                .unwrap_or_else(|| "-".to_string());
            println!("ID:        {}", att.attachment_id);
            println!("Project:   {}", att.project_id);
            println!("Entry:     {}", att.entry_id.as_deref().unwrap_or("-"));
            println!("Name:      {}", name);
            println!("Media:     {}", media_type);
            println!("Mode:      {}", att.storage_mode);
            println!("Size:      {}", att.original_size);
            println!("Stored:    {}", att.stored_size);
            println!("Chunks:    {}", att.chunk_count);
            println!("Hash:      {}", att.content_hash);
            println!("Deleted:   {}", att.deleted);
            println!("Updated:   {}", att.updated_at);
        }
        AttachAction::Rename {
            attachment_id,
            file_name,
            media_type,
        } => {
            let renamed = AttachmentRepo::rename(
                conn,
                &ctx,
                &attachment_id,
                &file_name,
                media_type.as_deref(),
            )
            .map_err(|e| format!("{}", e))?;
            println!("Renamed attachment {}", renamed.attachment_id);
        }
        AttachAction::Verify { attachment_id } => {
            let ok = verify_attachment_content(conn, &attachment_id, vault_path)?;
            if ok {
                println!("Attachment {} integrity OK", attachment_id);
            } else {
                return Err(format!(
                    "attachment {} integrity check failed",
                    attachment_id
                ));
            }
        }
        AttachAction::Delete { attachment_id } => {
            AttachmentRepo::soft_delete(conn, &ctx, &attachment_id)
                .map_err(|e| format!("{}", e))?;
            println!("Deleted attachment {}", attachment_id);
        }
        AttachAction::Deleted => {
            let mut cursor = None;
            let mut found = false;
            loop {
                let page = AttachmentSummaryRepo::list_deleted(
                    conn,
                    MAX_ATTACHMENT_SUMMARY_PAGE_SIZE,
                    cursor.as_deref(),
                )
                .map_err(|error| error.to_string())?;
                for attachment in page.items {
                    found = true;
                    let name = String::from_utf8_lossy(&attachment.file_name);
                    println!(
                        "{}  {}  {} bytes  {}",
                        attachment.attachment_id,
                        name,
                        attachment.original_size,
                        attachment.content_hash
                    );
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !found {
                println!("(no deleted attachments)");
            }
        }
    }
    Ok(())
}

#[cfg(feature = "external-blob-store")]
fn blob_cutoff_unix_secs(grace_hours: u64) -> Result<i64, String> {
    let grace_seconds = grace_hours
        .checked_mul(60 * 60)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| "Blob grace period exceeds supported time range".to_string())?;
    chrono::Utc::now()
        .timestamp()
        .checked_sub(grace_seconds)
        .ok_or_else(|| "Blob grace period underflowed the supported time range".to_string())
}

#[cfg(feature = "external-blob-store")]
const CLI_BLOB_TRANSFER_CHECKPOINT_FORMAT: &str = "mdbx-cli-blob-transfer-checkpoint-v1";

#[cfg(feature = "external-blob-store")]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct CliBlobTransferCheckpointFile {
    format: String,
    owner_id: String,
    checkpoint: BlobTransferCheckpoint,
}

#[cfg(feature = "external-blob-store")]
fn read_blob_transfer_checkpoint(path: &Path) -> Result<CliBlobTransferCheckpointFile, String> {
    let bytes = std::fs::read(path).map_err(|error| {
        format!(
            "failed to read Blob transfer checkpoint '{}': {error}",
            path.display()
        )
    })?;
    let value: CliBlobTransferCheckpointFile = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "invalid Blob transfer checkpoint '{}': {error}",
            path.display()
        )
    })?;
    if value.format != CLI_BLOB_TRANSFER_CHECKPOINT_FORMAT {
        return Err(format!(
            "unsupported Blob transfer checkpoint format: {}",
            value.format
        ));
    }
    if value.owner_id.is_empty() || value.owner_id.len() > 512 || value.owner_id.contains('\n') {
        return Err("Blob transfer checkpoint contains an invalid owner ID".to_string());
    }
    Ok(value)
}

#[cfg(feature = "external-blob-store")]
fn write_blob_transfer_checkpoint(
    path: &Path,
    owner_id: &str,
    checkpoint: &BlobTransferCheckpoint,
) -> Result<(), String> {
    let value = CliBlobTransferCheckpointFile {
        format: CLI_BLOB_TRANSFER_CHECKPOINT_FORMAT.to_string(),
        owner_id: owner_id.to_string(),
        checkpoint: checkpoint.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("failed to serialize Blob transfer checkpoint: {error}"))?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".mdbx-blob-transfer-checkpoint-")
        .tempfile_in(parent)
        .map_err(|error| format!("failed to create temporary Blob transfer checkpoint: {error}"))?;
    temporary
        .write_all(&bytes)
        .map_err(|error| format!("failed to write temporary Blob transfer checkpoint: {error}"))?;
    temporary.as_file_mut().sync_all().map_err(|error| {
        format!("failed to synchronize temporary Blob transfer checkpoint: {error}")
    })?;
    temporary.persist(path).map_err(|error| {
        format!(
            "failed to publish Blob transfer checkpoint: {}",
            error.error
        )
    })?;
    Ok(())
}

#[cfg(feature = "external-blob-store")]
const CLI_BLOB_REPLICA_CHECKPOINT_FORMAT: &str = "mdbx-cli-blob-replica-checkpoint-v1";

#[cfg(feature = "external-blob-store")]
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct CliBlobReplicaCheckpointFile {
    format: String,
    checkpoint: BlobReplicaTransferCheckpoint,
}

#[cfg(feature = "external-blob-store")]
fn read_blob_replica_checkpoint(path: &Path) -> Result<BlobReplicaTransferCheckpoint, String> {
    let bytes = std::fs::read(path).map_err(|error| {
        format!(
            "failed to read Blob replica checkpoint '{}': {error}",
            path.display()
        )
    })?;
    let value: CliBlobReplicaCheckpointFile = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "invalid Blob replica checkpoint '{}': {error}",
            path.display()
        )
    })?;
    if value.format != CLI_BLOB_REPLICA_CHECKPOINT_FORMAT {
        return Err(format!(
            "unsupported Blob replica checkpoint format: {}",
            value.format
        ));
    }
    Ok(value.checkpoint)
}

#[cfg(feature = "external-blob-store")]
fn write_blob_replica_checkpoint(
    path: &Path,
    checkpoint: &BlobReplicaTransferCheckpoint,
) -> Result<(), String> {
    let value = CliBlobReplicaCheckpointFile {
        format: CLI_BLOB_REPLICA_CHECKPOINT_FORMAT.to_string(),
        checkpoint: checkpoint.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("failed to serialize Blob replica checkpoint: {error}"))?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".mdbx-blob-replica-checkpoint-")
        .tempfile_in(parent)
        .map_err(|error| format!("failed to create temporary Blob replica checkpoint: {error}"))?;
    temporary
        .write_all(&bytes)
        .map_err(|error| format!("failed to write temporary Blob replica checkpoint: {error}"))?;
    temporary.as_file_mut().sync_all().map_err(|error| {
        format!("failed to synchronize temporary Blob replica checkpoint: {error}")
    })?;
    temporary
        .persist(path)
        .map_err(|error| format!("failed to publish Blob replica checkpoint: {}", error.error))?;
    Ok(())
}

fn cmd_blob(_conn: &VaultConnection, _vault_path: &Path, action: BlobAction) -> Result<(), String> {
    #[cfg(not(feature = "external-blob-store"))]
    {
        let _ = action;
        Err("this MDBX build does not include filesystem Blob lifecycle management".to_string())
    }
    #[cfg(feature = "external-blob-store")]
    {
        let store = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
        match action {
            BlobAction::Audit {
                grace_hours,
                skip_content_verification,
            } => {
                let cutoff = blob_cutoff_unix_secs(grace_hours)?;
                let report = BlobLifecycleService::audit(
                    _conn,
                    &store,
                    BlobAuditOptions {
                        limits: BlobLifecycleLimits::default(),
                        orphan_cutoff_unix_secs: cutoff,
                        verify_provider_contents: !skip_content_verification,
                    },
                )
                .map_err(|error| error.to_string())?;
                println!("Provider:            {}", report.namespace_id);
                println!("References:          {}", report.raw_reference_count);
                println!("Unique references:   {}", report.unique_reference_count);
                println!("Provider blobs:       {}", report.provider_blob_count);
                println!("Healthy references:  {}", report.healthy_reference_count);
                println!("Missing references:  {}", report.missing_references.len());
                println!("Corrupt blobs:       {}", report.corrupt_blobs.len());
                println!("Eligible orphans:    {}", report.eligible_orphans.len());
                println!("Recent orphans:      {}", report.recent_orphan_count);
                for issue in &report.missing_references {
                    println!("MISSING {}  {}", issue.blob_id, issue.detail);
                }
                for issue in &report.corrupt_blobs {
                    println!("CORRUPT {}  {}", issue.blob_id, issue.detail);
                }
                for blob in &report.eligible_orphans {
                    println!("ORPHAN {}  {} bytes", blob.blob_id, blob.stored_size);
                }
            }
            BlobAction::GcPlan { grace_hours } => {
                let cutoff = blob_cutoff_unix_secs(grace_hours)?;
                let plan = BlobLifecycleService::plan_gc(
                    _conn,
                    &store,
                    cutoff,
                    BlobLifecycleLimits::default(),
                )
                .map_err(|error| error.to_string())?;
                println!("Plan token:       {}", plan.plan_token);
                println!("Cutoff Unix secs: {}", plan.orphan_cutoff_unix_secs);
                println!("Eligible orphans: {}", plan.eligible_orphans.len());
                println!("Recent orphans:   {}", plan.recent_orphan_count);
                println!(
                    "Apply with: mdbx --vault {} blob gc-apply {} --cutoff-unix-secs {}",
                    _vault_path.display(),
                    plan.plan_token,
                    plan.orphan_cutoff_unix_secs
                );
            }
            BlobAction::GcApply {
                plan_token,
                cutoff_unix_secs,
            } => {
                let session = _conn.active_session().ok_or_else(|| {
                    "Blob garbage collection requires an active unlock session".to_string()
                })?;
                let device = cli_device_context();
                let (result, _decision) = BlobLifecycleService::apply_gc_authorized(
                    _conn,
                    &store,
                    &plan_token,
                    cutoff_unix_secs,
                    BlobLifecycleLimits::default(),
                    TigaAuthorizationContext {
                        session: Some(session),
                        device: &device,
                        now_unix_secs: chrono::Utc::now().timestamp(),
                    },
                )
                .map_err(|error| error.to_string())?;
                println!("Planned:        {}", result.planned_count);
                println!("Deleted:        {}", result.deleted_blob_ids.len());
                println!("Already absent: {}", result.already_absent_blob_ids.len());
                println!("Failures:       {}", result.failures.len());
                for failure in &result.failures {
                    println!("FAILED {}  {}", failure.blob_id, failure.detail);
                }
                if !result.completed() {
                    return Err(
                        "Blob garbage collection completed with failures; create a new plan before retrying"
                            .to_string(),
                    );
                }
            }
            BlobAction::Transfer {
                blob_id,
                size,
                destination,
                checkpoint,
                chunk_size,
                max_chunks,
                lease_ttl_secs,
            } => {
                let source = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
                let destination_store = FileSystemBlobStore::new(destination);
                let saved = if checkpoint.exists() {
                    Some(read_blob_transfer_checkpoint(&checkpoint)?)
                } else {
                    None
                };
                let owner_id = saved
                    .as_ref()
                    .map(|value| value.owner_id.clone())
                    .unwrap_or_else(|| format!("mdbx-cli-blob-transfer-{}", uuid::Uuid::new_v4()));
                let saved_checkpoint = saved.as_ref().map(|value| &value.checkpoint);
                let result = BlobTransferService::transfer(
                    &source,
                    &destination_store,
                    &blob_id,
                    size,
                    &owner_id,
                    saved_checkpoint,
                    BlobTransferLimits {
                        chunk_size,
                        max_blob_bytes: size,
                        max_chunks_per_run: max_chunks,
                        lease_ttl_secs,
                    },
                )
                .map_err(|error| error.to_string())?;
                println!("Blob:             {}", result.checkpoint.blob_id);
                println!(
                    "Transferred bytes: {} / {}",
                    result.checkpoint.transferred_bytes, size
                );
                println!("Chunks:            {}", result.chunks_transferred);
                println!("Completed:         {}", result.completed);
                if result.completed {
                    match std::fs::remove_file(&checkpoint) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            return Err(format!(
                                "Blob transfer completed but checkpoint cleanup failed: {error}"
                            ));
                        }
                    }
                } else {
                    write_blob_transfer_checkpoint(&checkpoint, &owner_id, &result.checkpoint)?;
                    println!("Checkpoint:        {}", checkpoint.display());
                }
            }
            BlobAction::ReplicaPlan {
                destination,
                cursor,
                checkpoint,
                page_size,
                json,
            } => {
                let source = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
                let destination_store = FileSystemBlobStore::new(destination);
                let page = BlobReplicaService::page(
                    _conn,
                    &source,
                    &destination_store,
                    BlobReplicaPageRequest::new(
                        cursor,
                        checkpoint,
                        page_size,
                        BlobLifecycleLimits::default(),
                    )
                    .map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?;
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&page).map_err(|error| format!(
                            "failed to serialize replica plan: {error}"
                        ))?
                    );
                } else {
                    println!("Plan token:       {}", page.plan_token);
                    println!("Source Provider:  {}", page.source_namespace_id);
                    println!("Target Provider:  {}", page.destination_namespace_id);
                    println!("References:       {}", page.raw_reference_count);
                    println!("Unique references: {}", page.unique_reference_count);
                    for item in &page.items {
                        println!(
                            "{:?} {} source={:?} target={:?} max={}",
                            item.state,
                            item.blob_id,
                            item.source_size,
                            item.destination_size,
                            item.declared_max_bytes
                        );
                    }
                    if let Some(next_cursor) = page.next_cursor {
                        println!("Next cursor:      {next_cursor}");
                    }
                }
            }
            BlobAction::Replicate {
                destination,
                checkpoint,
                page_size,
                max_items,
                chunk_size,
                max_chunks,
                max_blob_bytes,
                lease_ttl_secs,
            } => {
                let source = FileSystemBlobStore::new(default_blob_store_path(_vault_path));
                let destination_store = FileSystemBlobStore::new(destination);
                let saved = if checkpoint.exists() {
                    Some(read_blob_replica_checkpoint(&checkpoint)?)
                } else {
                    None
                };
                let owner_id = saved
                    .as_ref()
                    .map(|value| value.owner_id.clone())
                    .unwrap_or_else(|| format!("mdbx-cli-blob-replica-{}", uuid::Uuid::new_v4()));
                let result = BlobReplicaService::transfer(
                    _conn,
                    &source,
                    &destination_store,
                    &owner_id,
                    saved.as_ref(),
                    BlobReplicaTransferLimits {
                        lifecycle: BlobLifecycleLimits::default(),
                        page_size,
                        max_items_per_run: max_items,
                        transfer: BlobTransferLimits {
                            chunk_size,
                            max_blob_bytes,
                            max_chunks_per_run: max_chunks,
                            lease_ttl_secs,
                        },
                    },
                )
                .map_err(|error| error.to_string())?;
                println!("Transferred items: {}", result.transferred_items);
                println!("Completed:         {}", result.completed);
                if result.completed {
                    match std::fs::remove_file(&checkpoint) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            return Err(format!(
                                "Blob replica completed but checkpoint cleanup failed: {error}"
                            ));
                        }
                    }
                } else {
                    write_blob_replica_checkpoint(&checkpoint, &result.checkpoint)?;
                    println!("Checkpoint:        {}", checkpoint.display());
                }
                if !result.blocked_items.is_empty() {
                    for item in result.blocked_items {
                        println!("BLOCKED {:?} {}", item.state, item.blob_id);
                    }
                    return Err(
                        "Blob replica is blocked; repair the reported Provider state before retrying"
                            .to_string(),
                    );
                }
            }
        }
        Ok(())
    }
}

fn mime_guess_for_path(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    let mime = match ext {
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "bin" => "application/octet-stream",
        _ => "application/octet-stream",
    };
    Some(mime.to_string())
}

// ---------------------------------------------------------------------------
// SNAPSHOT
// ---------------------------------------------------------------------------

fn cmd_snapshot(conn: &mut VaultConnection, action: SnapshotAction) -> Result<(), String> {
    let ctx = ctx();
    match action {
        SnapshotAction::Create => {
            let snap = SnapshotRepo::create_snapshot(conn, &ctx).map_err(|e| format!("{}", e))?;
            println!("Created snapshot {}", snap.snapshot_id);
            println!("  hash: {}", snap.snapshot_hash);
            println!("  time: {}", snap.created_at);
        }
        SnapshotAction::CreateAutomatic {
            retention_eligible_at,
        } => {
            let device = cli_device_context();
            let session = conn.active_session().ok_or_else(|| {
                "automatic snapshot creation requires an active unlock session".to_string()
            })?;
            let (snap, _) = SnapshotRepo::create_automatic_snapshot_authorized(
                conn,
                &ctx,
                &retention_eligible_at,
                TigaAuthorizationContext {
                    session: Some(session),
                    device: &device,
                    now_unix_secs: chrono::Utc::now().timestamp(),
                },
            )
            .map_err(|e| format!("{}", e))?;
            println!("Created automatic snapshot {}", snap.snapshot_id);
            println!("  eligible: {}", retention_eligible_at);
            println!("  commit: {}", snap.base_commit_id);
        }
        SnapshotAction::List => {
            let mut cursor = None;
            let mut has_snapshots = false;
            loop {
                let page = SnapshotSummaryRepo::list(
                    conn,
                    MAX_SNAPSHOT_SUMMARY_PAGE_SIZE,
                    cursor.as_deref(),
                )
                .map_err(|e| format!("{}", e))?;
                for snapshot in &page.items {
                    has_snapshots = true;
                    println!(
                        "{}  {}  {}",
                        snapshot.snapshot_id, snapshot.created_at, snapshot.snapshot_hash
                    );
                }
                match page.next_cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            if !has_snapshots {
                println!("(no snapshots)");
            }
        }
        SnapshotAction::PrunePlan { keep_latest } => {
            if keep_latest > MAX_SNAPSHOT_PRUNE_KEEP_LATEST {
                return Err(format!(
                    "keep_latest must be at most {}",
                    MAX_SNAPSHOT_PRUNE_KEEP_LATEST
                ));
            }
            let plan = SnapshotLifecycleRepo::plan_automatic_prune(
                conn,
                keep_latest,
                chrono::Utc::now().timestamp(),
            )
            .map_err(|e| format!("{}", e))?;
            println!("Plan token: {}", plan.plan_token);
            println!("Keep latest: {}", plan.keep_latest);
            println!("Candidates: {}", plan.candidates.len());
            println!("Has more: {}", plan.has_more);
            println!("Ciphertext bytes: {}", plan.total_ciphertext_bytes);
            if plan.candidates.len() > MAX_SNAPSHOT_PRUNE_CANDIDATES {
                return Err("snapshot prune plan exceeded its bounded candidate limit".to_string());
            }
            for candidate in plan.candidates {
                println!(
                    "  {}  {}",
                    candidate.summary.snapshot_id, candidate.retention_eligible_at
                );
            }
        }
        SnapshotAction::Prune {
            plan_token,
            keep_latest,
        } => {
            let device = cli_device_context();
            let session = conn
                .active_session()
                .ok_or_else(|| "snapshot pruning requires an active unlock session".to_string())?;
            let (result, _) = SnapshotLifecycleRepo::prune_automatic_authorized(
                conn,
                &ctx,
                &plan_token,
                keep_latest,
                chrono::Utc::now().timestamp(),
                TigaAuthorizationContext {
                    session: Some(session),
                    device: &device,
                    now_unix_secs: chrono::Utc::now().timestamp(),
                },
            )
            .map_err(|e| format!("{}", e))?;
            println!(
                "Pruned {} automatic snapshots",
                result.deleted_snapshot_ids.len()
            );
            println!("  commit: {}", result.commit_id);
            println!("  plan: {}", result.plan_token);
        }
        SnapshotAction::Restore { snapshot_id } => {
            let device = cli_device_context();
            let session = conn
                .active_session()
                .ok_or_else(|| "snapshot restore requires an active unlock session".to_string())?;
            SnapshotRepo::restore_snapshot_authorized(
                conn,
                &ctx,
                &snapshot_id,
                TigaAuthorizationContext {
                    session: Some(session),
                    device: &device,
                    now_unix_secs: chrono::Utc::now().timestamp(),
                },
            )
            .map_err(|e| format!("{}", e))?;
            println!("Restored from snapshot {}", snapshot_id);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

#[cfg(feature = "search")]
fn cmd_search(
    conn: &mut VaultConnection,
    query: Option<String>,
    tag: Option<String>,
    entry_type: Option<String>,
) -> Result<(), String> {
    let et = entry_type
        .as_deref()
        .map(|s| s.parse::<EntryType>())
        .transpose()
        .map_err(|_| "unknown entry type".to_string())?;

    let results = SearchService::search(conn, query.as_deref(), tag.as_deref(), et, None, None)
        .map_err(|e| format!("{}", e))?;

    if results.is_empty() {
        println!("(no results)");
    }
    for r in &results {
        let types = r.entry_types.join(",");
        let tags = if r.tags.is_empty() {
            String::new()
        } else {
            format!(" [{}]", r.tags.join(", "))
        };
        println!("{}  {}  {}{}", r.project_id, r.title, types, tags);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SYNC
// ---------------------------------------------------------------------------

const CLI_SYNC_CHECKPOINT_FORMAT: &str = "mdbx-cli-sync-checkpoint-v1";
#[cfg(not(test))]
const CLI_INCREMENTAL_SEGMENT_PAGE_SIZE: usize = MAX_COMMIT_INVENTORY_PAGE_SIZE;
#[cfg(test)]
const CLI_INCREMENTAL_SEGMENT_PAGE_SIZE: usize = 2;

type CliSyncResume = IncrementalBundleResume;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct CliSyncCheckpointFile {
    format: String,
    vault_id: String,
    checkpoint: IncrementalBundleCheckpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resume: Option<CliSyncResume>,
}

fn cmd_sync(conn: &mut VaultConnection, action: SyncAction) -> Result<(), String> {
    match action {
        SyncAction::Bundle {
            output,
            base_checkpoint,
            result_checkpoint,
            compression,
            authenticated,
        } => {
            let compression = resolve_bundle_compression(compression)?;
            let integrity_key = if authenticated {
                Some(sync_bundle_integrity_key(conn)?)
            } else {
                None
            };
            let mut file = std::fs::File::create(&output)
                .map_err(|e| format!("failed to create bundle '{}': {}", output.display(), e))?;
            if let Some(base_path) = base_checkpoint {
                let base = read_cli_sync_checkpoint(&base_path, &vault_id(conn)?)?;
                let bundle =
                    export_incremental_sync_segment(conn, &base.checkpoint, base.resume.as_ref())?;
                match integrity_key {
                    Some(key) => write_incremental_bundle_with_compression_authenticated(
                        &bundle,
                        &mut file,
                        compression,
                        key,
                    ),
                    None => {
                        write_incremental_bundle_with_compression(&bundle, &mut file, compression)
                    }
                }
                .map_err(|e| format!("incremental bundle write failed: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("failed to synchronize bundle: {e}"))?;
                if let Some(path) = result_checkpoint {
                    let resume = next_cli_sync_resume(&bundle)?;
                    write_cli_sync_checkpoint(
                        &path,
                        &bundle.manifest.vault_id,
                        &bundle.manifest.result,
                        resume,
                    )?;
                }
                println!(
                    "Exported incremental bundle segment {}: commits={} deltas={} complete={} -> {}",
                    bundle.manifest.segment_index,
                    bundle.commits.len(),
                    bundle.manifest.delta_inventory.len(),
                    bundle.manifest.is_last,
                    output.display()
                );
            } else {
                let bundle = export_sync_bundle(conn)?;
                match integrity_key {
                    Some(key) => write_bundle_with_compression_authenticated(
                        &bundle,
                        &mut file,
                        compression,
                        key,
                    ),
                    None => write_bundle_with_compression(&bundle, &mut file, compression),
                }
                .map_err(|e| format!("bundle write failed: {e}"))?;
                file.sync_all()
                    .map_err(|e| format!("failed to synchronize bundle: {e}"))?;
                if let Some(path) = result_checkpoint {
                    let checkpoint = current_incremental_checkpoint(conn)?;
                    write_cli_sync_checkpoint(&path, &bundle.vault_id, &checkpoint, None)?;
                }
                println!(
                    "Exported complete bootstrap bundle: commits={} -> {}",
                    bundle.commits.len(),
                    output.display()
                );
            }
            Ok(())
        }
        SyncAction::Apply { file, checkpoint } => {
            let mut input = std::fs::File::open(&file)
                .map_err(|e| format!("failed to open bundle '{}': {}", file.display(), e))?;
            let integrity_key = sync_bundle_integrity_key(conn)?;
            let bundle = read_bundle_file_with_limits_authenticated(
                &mut input,
                BundleReadLimits::desktop(),
                integrity_key,
            )
            .map_err(|e| format!("bundle read failed: {}", e))?;
            let summary = match bundle {
                SyncBundleFile::Complete(bundle) => apply_sync_bundle(conn, &bundle)?,
                SyncBundleFile::Incremental(bundle) => {
                    let checkpoint_path = checkpoint.ok_or_else(|| {
                        "incremental bundle apply requires --checkpoint with the peer base"
                            .to_string()
                    })?;
                    let expected =
                        read_cli_sync_checkpoint(&checkpoint_path, &bundle.manifest.vault_id)?;
                    let summary = apply_incremental_sync_segment(
                        conn,
                        &bundle,
                        &expected.checkpoint,
                        expected.resume.as_ref(),
                    )?;
                    let resume = next_cli_sync_resume(&bundle)?;
                    write_cli_sync_checkpoint(
                        &checkpoint_path,
                        &bundle.manifest.vault_id,
                        &bundle.manifest.result,
                        resume,
                    )?;
                    summary
                }
            };
            println!(
                "Applied bundle: applied={} skipped={} conflicts={} missing-parents={}",
                summary.applied_commits,
                summary.skipped_commits,
                summary.conflict_count,
                summary.missing_parent_count
            );
            Ok(())
        }
    }
}

fn resolve_bundle_compression(
    compression: BundleCompressionCli,
) -> Result<BundleCompression, String> {
    let compression = BundleCompression::from(compression);
    if compression == BundleCompression::Zstd && !cfg!(feature = "sync-compression") {
        return Err(
            "zstd bundle compression is unavailable in this build; enable sync-compression"
                .to_string(),
        );
    }
    Ok(compression)
}

fn sync_bundle_integrity_key(conn: &VaultConnection) -> Result<&[u8], String> {
    conn.keyring()
        .map(|keyring| keyring.integrity_subkey.as_slice())
        .ok_or_else(|| "sync bundle authentication requires an unlocked vault keyring".to_string())
}

fn cmd_health(conn: &VaultConnection) -> Result<(), String> {
    let result = RecoveryVerifier::full_health_check(conn)
        .map_err(|e| format!("health check failed: {}", e))?;

    if result.issues.is_empty() {
        println!("Vault health: OK");
        return Ok(());
    }

    println!("Vault health: {} issue(s)", result.issues.len());
    for issue in &result.issues {
        println!(
            "  [{}] {}: {}",
            severity_label(issue.severity),
            issue.category,
            issue.description
        );
    }

    if result.issues.iter().any(|issue| {
        matches!(
            issue.severity,
            IssueSeverity::Error | IssueSeverity::Critical
        )
    }) {
        Err("vault health check reported errors".to_string())
    } else {
        Ok(())
    }
}

fn cmd_anchor(conn: &VaultConnection, action: AnchorAction) -> Result<(), String> {
    match action {
        AnchorAction::Create { output } => {
            let token = RollbackAnchorService::issue(conn)
                .map_err(|error| format!("failed to create rollback anchor: {error}"))?;
            write_new_synced_file(&output, &token, "rollback anchor")?;
            println!(
                "Created rollback anchor: bytes={} -> {}",
                token.len(),
                output.display()
            );
            Ok(())
        }
        AnchorAction::Verify { input } => {
            let token = read_bounded_file(&input, MAX_ROLLBACK_ANCHOR_BYTES, "rollback anchor")?;
            let verification = RollbackAnchorService::verify(conn, &token)
                .map_err(|error| format!("rollback anchor verification failed: {error}"))?;
            println!(
                "Rollback anchor verified: state={} commit-sequence={}->{} delta-sequence={:?}->{:?}",
                if verification.advanced {
                    "advanced"
                } else {
                    "equal"
                },
                verification.anchored_commit_inventory_seq,
                verification.current_commit_inventory_seq,
                verification.anchored_sync_delta_batch_seq,
                verification.current_sync_delta_batch_seq
            );
            Ok(())
        }
    }
}

fn cmd_content_manifest(
    conn: &VaultConnection,
    action: ContentManifestAction,
) -> Result<(), String> {
    match action {
        ContentManifestAction::Create { output } => {
            let token = VaultContentManifestService::issue(conn)
                .map_err(|error| format!("failed to create vault content manifest: {error}"))?;
            write_new_synced_file(&output, &token, "vault content manifest")?;
            println!(
                "Created vault content manifest: bytes={} -> {}",
                token.len(),
                output.display()
            );
            Ok(())
        }
        ContentManifestAction::Verify { input } => {
            let token = read_bounded_file(
                &input,
                MAX_VAULT_CONTENT_MANIFEST_BYTES,
                "vault content manifest",
            )?;
            let verification = VaultContentManifestService::verify(conn, &token)
                .map_err(|error| format!("vault content manifest verification failed: {error}"))?;
            println!(
                "Vault content manifest verified: tables={} rows={} hashed-bytes={}",
                verification.table_count, verification.row_count, verification.hashed_bytes
            );
            Ok(())
        }
    }
}

fn cmd_integrity_root(conn: &VaultConnection, action: IntegrityRootAction) -> Result<(), String> {
    match action {
        IntegrityRootAction::Status => {
            let status = IntegrityRootService::status(conn)
                .map_err(|error| format!("failed to inspect integrity root: {error}"))?;
            print_integrity_root_status(&status);
        }
        IntegrityRootAction::Enable => {
            let status = IntegrityRootService::enable(conn)
                .map_err(|error| format!("failed to enable integrity root: {error}"))?;
            print_integrity_root_status(&status);
        }
        IntegrityRootAction::Verify => {
            let verification = IntegrityRootService::verify(conn)
                .map_err(|error| format!("integrity root verification failed: {error}"))?;
            print_integrity_root_verification(&verification);
        }
        IntegrityRootAction::Rebuild => {
            let status = IntegrityRootService::rebuild(conn)
                .map_err(|error| format!("failed to rebuild integrity root: {error}"))?;
            print_integrity_root_status(&status);
        }
    }
    Ok(())
}

fn print_integrity_root_status(status: &IntegrityRootStatus) {
    let profile = status.profile.as_deref().unwrap_or("none");
    let root_hash = status
        .root_hash
        .as_ref()
        .map(|hash| encode_hex(hash))
        .unwrap_or_else(|| "none".to_string());
    println!(
        "Integrity root: profile={} state={} authenticated={} generation={} leaves={} root={} commit-sequence={} delta-sequence={}",
        profile,
        integrity_root_state_label(status.state),
        status.authenticated,
        status.generation,
        status.leaf_count,
        root_hash,
        status.latest_commit_seq,
        status.latest_delta_seq
    );
}

fn print_integrity_root_verification(verification: &IntegrityRootVerification) {
    println!(
        "Integrity root verified: profile={} generation={} leaves={} root={} commit-sequence={} delta-sequence={}",
        verification.profile,
        verification.generation,
        verification.leaf_count,
        encode_hex(&verification.root_hash),
        verification.latest_commit_seq,
        verification.latest_delta_seq
    );
}

fn integrity_root_state_label(state: IntegrityRootState) -> &'static str {
    match state {
        IntegrityRootState::Disabled => "disabled",
        IntegrityRootState::Pending => "pending",
        IntegrityRootState::Building => "building",
        IntegrityRootState::Established => "established",
        IntegrityRootState::Stale => "stale",
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn write_new_synced_file(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("failed to create {label} '{}': {error}", path.display()))?;
    let write_result = file
        .write_all(bytes)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all());
    if let Err(error) = write_result {
        drop(file);
        let cleanup = std::fs::remove_file(path)
            .err()
            .map(|cleanup_error| format!("; partial file cleanup failed: {cleanup_error}"))
            .unwrap_or_default();
        return Err(format!(
            "failed to persist {label} '{}': {error}{cleanup}",
            path.display()
        ));
    }
    Ok(())
}

fn read_bounded_file(path: &Path, maximum: usize, label: &str) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("failed to open {label} '{}': {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {label} '{}': {error}", path.display()))?;
    if bytes.len() > maximum {
        return Err(format!(
            "{label} '{}' exceeds {maximum} bytes",
            path.display()
        ));
    }
    Ok(bytes)
}

fn cmd_backup(source: &std::path::Path, output: PathBuf) -> Result<(), String> {
    let info = BackupService::create_portable_copy_path(source, &output)
        .map_err(|error| format!("failed to create portable backup: {error}"))?;
    println!(
        "Created portable backup: vault={} format={} schema={} bytes={} -> {}",
        info.vault_id,
        info.format_version,
        info.schema_version,
        info.file_size_bytes,
        output.display()
    );
    Ok(())
}

fn severity_label(severity: IssueSeverity) -> &'static str {
    match severity {
        IssueSeverity::Info => "info",
        IssueSeverity::Warning => "warning",
        IssueSeverity::Error => "error",
        IssueSeverity::Critical => "critical",
    }
}

#[cfg(feature = "benchmark")]
fn cmd_benchmark(
    iterations: u32,
    mode: BenchmarkCliMode,
    json: bool,
    output: Option<PathBuf>,
) -> Result<(), String> {
    if iterations == 0 {
        return Err("iterations must be greater than zero".to_string());
    }
    let mode = BenchmarkMode::from(mode);
    let suite = BenchmarkRunner::run_full_suite_with_mode(iterations, mode);
    if json || output.is_some() {
        let report = suite.json_report_with_mode(iterations, mode);
        let encoded = serde_json::to_string_pretty(&report)
            .map_err(|error| format!("failed to encode benchmark report: {error}"))?;
        if let Some(path) = output {
            std::fs::write(&path, format!("{encoded}\n"))
                .map_err(|error| format!("failed to write '{}': {error}", path.display()))?;
        }
        if json {
            println!("{encoded}");
        }
    } else {
        suite.print();
    }
    Ok(())
}

#[cfg(feature = "kdbx-binary-import")]
fn cmd_import_kdbx(
    conn: &mut VaultConnection,
    file: PathBuf,
    password_stdin: bool,
) -> Result<(), String> {
    let password = read_kdbx_password(password_stdin, false)?;
    import_kdbx_with_password(conn, file, password.as_str())
}

#[cfg(feature = "kdbx-binary-import")]
fn import_kdbx_with_password(
    conn: &mut VaultConnection,
    file: PathBuf,
    password: &str,
) -> Result<(), String> {
    let source = std::fs::File::open(&file)
        .map_err(|error| format!("failed to open KDBX '{}': {error}", file.display()))?;
    let document = KdbxBinaryAdapter::decode(
        &mut std::io::BufReader::new(source),
        password,
        KdbxBinaryLimits::default(),
    )
    .map_err(|error| format!("failed to decode KDBX '{}': {error}", file.display()))?;
    let execution = import_kdbx_entries_atomic(conn, &document.entries)?;
    report_kdbx_import(&document.format_version, execution);
    Ok(())
}

#[cfg(feature = "kdbx-binary-export")]
fn cmd_export_kdbx(
    conn: &VaultConnection,
    output: PathBuf,
    password_stdin: bool,
) -> Result<(), String> {
    let password = read_kdbx_password(password_stdin, true)?;
    export_kdbx_with_password(conn, output, password.as_str())
}

#[cfg(feature = "kdbx-binary-export")]
fn export_kdbx_with_password(
    conn: &VaultConnection,
    output: PathBuf,
    password: &str,
) -> Result<(), String> {
    if output
        .try_exists()
        .map_err(|error| format!("failed to inspect KDBX '{}': {error}", output.display()))?
    {
        return Err(format!(
            "failed to publish KDBX '{}' without replacing an existing file",
            output.display()
        ));
    }
    let (entries, attachments_exported, projects_skipped, warnings) = collect_kdbx_entries(conn)?;
    let bytes = KdbxBinaryAdapter::encode(&entries, password, KdbxBinaryLimits::default())
        .map_err(|error| format!("failed to encode KDBX4: {error}"))?;
    publish_kdbx_noclobber(&output, &bytes)?;

    println!(
        "Exported KDBX4: entries={} attachments={} skipped={} -> {}",
        entries.len(),
        attachments_exported,
        projects_skipped,
        output.display()
    );
    for warning in warnings {
        println!("  warning: {warning}");
    }
    Ok(())
}

#[cfg(feature = "kdbx-export")]
fn collect_kdbx_entries(
    conn: &VaultConnection,
) -> Result<(Vec<KdbxEntry>, u32, u32, Vec<String>), String> {
    let mut entries: Vec<KdbxEntry> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut attachments_exported = 0u32;
    let mut projects_skipped = 0u32;

    let device = cli_device_context();
    let session = conn
        .active_session()
        .ok_or_else(|| "KDBX export requires an active unlock session".to_string())?;
    let authorization = TigaAuthorizationContext {
        session: Some(session),
        device: &device,
        now_unix_secs: chrono::Utc::now().timestamp(),
    };
    for project in ProjectRepo::list_all(conn).map_err(|error| error.to_string())? {
        match KdbxExporter::export_one_authorized(conn, &project, authorization) {
            Ok(((entry, attachment_count, project_warnings), _decision)) => {
                entries.push(entry);
                attachments_exported += attachment_count;
                warnings.extend(project_warnings);
            }
            Err(error) => {
                projects_skipped += 1;
                warnings.push(format!("skipped project '{}': {error}", project.project_id));
            }
        }
    }
    Ok((entries, attachments_exported, projects_skipped, warnings))
}

#[cfg(feature = "kdbx-binary-export")]
fn publish_kdbx_noclobber(output: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".mdbx-kdbx-")
        .tempfile_in(parent)
        .map_err(|error| format!("failed to create temporary KDBX output: {error}"))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file_mut().flush())
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| format!("failed to synchronize temporary KDBX output: {error}"))?;
    temporary
        .persist_noclobber(output)
        .map(|_| ())
        .map_err(|error| {
            format!(
                "failed to publish KDBX '{}' without replacing an existing file: {}",
                output.display(),
                error.error
            )
        })
}

#[cfg(feature = "kdbx-import")]
fn cmd_import_kdbx_json(conn: &mut VaultConnection, file: PathBuf) -> Result<(), String> {
    let bytes =
        std::fs::read(&file).map_err(|e| format!("failed to read '{}': {}", file.display(), e))?;
    let entries: Vec<KdbxEntry> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("failed to parse KDBX JSON '{}': {}", file.display(), e))?;
    let execution = import_kdbx_entries_atomic(conn, &entries)?;
    report_kdbx_import("KDBX JSON", execution);
    Ok(())
}

#[cfg(feature = "kdbx-import")]
fn import_kdbx_entries_atomic(
    conn: &VaultConnection,
    entries: &[KdbxEntry],
) -> Result<OperationExecution<ImportResult>, String> {
    KdbxImporter::import_entries_atomic(conn, &ctx(), uuid::Uuid::new_v4().to_string(), entries)
        .map_err(|error| format!("failed to import KDBX atomically: {error}"))
}

#[cfg(feature = "kdbx-import")]
fn report_kdbx_import(label: &str, execution: OperationExecution<ImportResult>) {
    match execution {
        OperationExecution::Applied { value, commit_id } => {
            println!(
                "Imported {label}: projects={} entries={} attachments={} skipped={} commit={commit_id}",
                value.projects_created,
                value.entries_created,
                value.attachments_created,
                value.entries_skipped
            );
            for warning in value.warnings {
                println!("  warning: {warning}");
            }
        }
        OperationExecution::AlreadyCommitted { commit_id } => {
            println!("KDBX import already committed: source={label} commit={commit_id}");
        }
    }
}

#[cfg(feature = "kdbx-export")]
fn cmd_export_kdbx_json(conn: &VaultConnection, output: PathBuf) -> Result<(), String> {
    let (entries, attachments_exported, projects_skipped, warnings) = collect_kdbx_entries(conn)?;

    let json = serde_json::to_vec_pretty(&entries)
        .map_err(|e| format!("failed to serialize KDBX JSON: {}", e))?;
    std::fs::write(&output, json)
        .map_err(|e| format!("failed to write '{}': {}", output.display(), e))?;

    println!(
        "Exported KDBX JSON: entries={} attachments={} skipped={} -> {}",
        entries.len(),
        attachments_exported,
        projects_skipped,
        output.display()
    );
    for warning in warnings {
        println!("  warning: {}", warning);
    }
    Ok(())
}

fn export_sync_bundle(conn: &VaultConnection) -> Result<mdbx_sync::SyncBundle, String> {
    let source_device_id = latest_device_id(conn)?.unwrap_or_else(|| "cli-device".to_string());
    PeerSyncService::export_complete_bundle(conn, &source_device_id)
        .map_err(|error| format!("complete sync export failed: {error}"))
}

#[cfg(test)]
fn export_incremental_sync_bundle(
    conn: &VaultConnection,
    base: &IncrementalBundleCheckpoint,
) -> Result<IncrementalSyncBundle, String> {
    export_incremental_sync_segment(conn, base, None)
}

fn export_incremental_sync_segment(
    conn: &VaultConnection,
    base: &IncrementalBundleCheckpoint,
    resume: Option<&CliSyncResume>,
) -> Result<IncrementalSyncBundle, String> {
    let source_device_id = latest_device_id(conn)?.unwrap_or_else(|| "cli-device".to_string());
    PeerSyncService::export_incremental_segment(
        conn,
        &source_device_id,
        base,
        resume,
        PeerSyncSegmentOptions {
            page_size: CLI_INCREMENTAL_SEGMENT_PAGE_SIZE,
        },
    )
    .map_err(|error| format!("incremental sync export failed: {error}"))
}

fn current_incremental_checkpoint(
    conn: &VaultConnection,
) -> Result<IncrementalBundleCheckpoint, String> {
    PeerSyncService::current_checkpoint(conn)
        .map_err(|error| format!("failed to create incremental checkpoint: {error}"))
}

#[cfg(test)]
fn apply_incremental_sync_bundle(
    conn: &mut VaultConnection,
    bundle: &IncrementalSyncBundle,
    expected_base: &IncrementalBundleCheckpoint,
) -> Result<ApplyBatchResult, String> {
    apply_incremental_sync_segment(conn, bundle, expected_base, None)
}

fn apply_incremental_sync_segment(
    conn: &mut VaultConnection,
    bundle: &IncrementalSyncBundle,
    expected_base: &IncrementalBundleCheckpoint,
    expected_resume: Option<&CliSyncResume>,
) -> Result<ApplyBatchResult, String> {
    let device_id = latest_device_id(conn)?.unwrap_or_else(|| "mdbx-cli-sync".to_string());
    PeerSyncService::apply_incremental_segment(
        conn,
        &device_id,
        bundle,
        expected_base,
        expected_resume,
    )
    .map_err(|error| format!("storage-core incremental segment apply failed: {error}"))
}

fn next_cli_sync_resume(bundle: &IncrementalSyncBundle) -> Result<Option<CliSyncResume>, String> {
    PeerSyncService::next_resume(bundle)
        .map_err(|error| format!("failed to calculate incremental resume state: {error}"))
}

fn read_cli_sync_checkpoint(
    path: &Path,
    expected_vault_id: &str,
) -> Result<CliSyncCheckpointFile, String> {
    let bytes = std::fs::read(path)
        .map_err(|error| format!("failed to read checkpoint '{}': {error}", path.display()))?;
    let checkpoint: CliSyncCheckpointFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid checkpoint '{}': {error}", path.display()))?;
    if checkpoint.format != CLI_SYNC_CHECKPOINT_FORMAT {
        return Err(format!(
            "unsupported checkpoint format: {}",
            checkpoint.format
        ));
    }
    if checkpoint.vault_id != expected_vault_id {
        return Err(format!(
            "checkpoint vault_id {} does not match {}",
            checkpoint.vault_id, expected_vault_id
        ));
    }
    if checkpoint.checkpoint.commit_inventory.is_none()
        || checkpoint.checkpoint.delta_inventory.is_none()
    {
        return Err("checkpoint does not represent a completed bootstrap".to_string());
    }
    if let Some(resume) = &checkpoint.resume {
        if resume.transfer_id.is_empty()
            || resume.next_segment_index == 0
            || resume.previous_segment_sha256.len() != 32
        {
            return Err("checkpoint contains invalid transfer resume state".to_string());
        }
    }
    Ok(checkpoint)
}

fn write_cli_sync_checkpoint(
    path: &Path,
    vault_id: &str,
    checkpoint: &IncrementalBundleCheckpoint,
    resume: Option<CliSyncResume>,
) -> Result<(), String> {
    let value = CliSyncCheckpointFile {
        format: CLI_SYNC_CHECKPOINT_FORMAT.to_string(),
        vault_id: vault_id.to_string(),
        checkpoint: checkpoint.clone(),
        resume,
    };
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("failed to serialize sync checkpoint: {error}"))?;
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::Builder::new()
        .prefix(".mdbx-sync-checkpoint-")
        .tempfile_in(parent)
        .map_err(|error| format!("failed to create temporary checkpoint: {error}"))?;
    temporary
        .write_all(&bytes)
        .map_err(|error| format!("failed to write temporary checkpoint: {error}"))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| format!("failed to synchronize temporary checkpoint: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("failed to publish checkpoint: {}", error.error))?;
    Ok(())
}

fn apply_sync_bundle(
    conn: &mut VaultConnection,
    bundle: &mdbx_sync::SyncBundle,
) -> Result<ApplyBatchResult, String> {
    let local_vault_id = vault_id(conn)?;
    if bundle.vault_id != local_vault_id {
        return Err(format!(
            "bundle vault_id {} does not match local vault_id {}",
            bundle.vault_id, local_vault_id
        ));
    }

    let device_id = latest_device_id(conn)?.unwrap_or_else(|| "mdbx-cli-sync".to_string());
    SyncApplyRepo::apply_batch_mut(
        conn,
        &CommitContext::new(device_id),
        &CommitBatch::new(bundle.commits.clone(), 0, true),
    )
    .map_err(|e| format!("storage-core sync apply failed: {e}"))
}

fn vault_id(conn: &VaultConnection) -> Result<String, String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("failed to read vault_id: {}", e))
}

fn latest_device_id(conn: &VaultConnection) -> Result<Option<String>, String> {
    conn.inner()
        .query_row(
            "SELECT device_id FROM device_heads ORDER BY last_seen_at DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("failed to read device head: {}", e))
}

#[cfg(test)]
fn load_serialized_commits(conn: &VaultConnection) -> Result<Vec<SerializedCommit>, String> {
    PeerSyncService::export_complete_bundle(conn, "cli-test-device")
        .map(|bundle| bundle.commits)
        .map_err(|error| format!("failed to load serialized commits: {error}"))
}

#[cfg(test)]
fn parse_commit_kind_from_sql(value: String) -> rusqlite::Result<CommitKind> {
    value.parse().map_err(|error: String| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })
}

#[cfg(test)]
fn parse_change_scope_from_sql(value: String) -> rusqlite::Result<ChangeScope> {
    value.parse().map_err(|error: String| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    use mdbx_storage::sync_apply::SyncApplyRepo;
    use mdbx_storage::sync_state::SYNC_STATE_OBJECT_TYPE;
    use mdbx_storage::tiga::TigaService;
    use mdbx_sync::{CommitBatch, IncrementalDeltaKind};
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};

    #[test]
    fn commit_kind_sql_parser_preserves_all_known_values_and_rejects_unknown() {
        let cases = [
            ("change", CommitKind::Change),
            ("merge", CommitKind::Merge),
            ("snapshot", CommitKind::Snapshot),
            ("key-rotation", CommitKind::KeyRotation),
            ("move", CommitKind::Move),
            ("copy", CommitKind::Copy),
            ("restore", CommitKind::Restore),
            ("multi", CommitKind::Multi),
        ];
        for (encoded, expected) in cases {
            assert_eq!(
                parse_commit_kind_from_sql(encoded.to_string()).unwrap(),
                expected
            );
        }
        assert!(parse_commit_kind_from_sql("future-kind".to_string()).is_err());
    }

    #[test]
    fn change_scope_sql_parser_preserves_all_known_values_and_rejects_unknown() {
        let cases = [
            ("project", ChangeScope::Project),
            ("entry", ChangeScope::Entry),
            ("attachment", ChangeScope::Attachment),
            ("object-relation", ChangeScope::ObjectRelation),
            ("object-label", ChangeScope::ObjectLabel),
            (
                "object-label-assignment",
                ChangeScope::ObjectLabelAssignment,
            ),
            ("vault-meta", ChangeScope::VaultMeta),
            ("key-epoch", ChangeScope::KeyEpoch),
            ("multi", ChangeScope::Multi),
            ("snapshot", ChangeScope::Snapshot),
            ("branch", ChangeScope::Branch),
        ];
        for (encoded, expected) in cases {
            assert_eq!(
                parse_change_scope_from_sql(encoded.to_string()).unwrap(),
                expected
            );
        }
        assert!(parse_change_scope_from_sql("future-scope".to_string()).is_err());
    }

    #[test]
    fn serialized_commit_loader_preserves_extended_database_kinds() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("commit-kind-loader-device".to_string());

        for kind in ["move", "copy", "restore", "multi"] {
            ctx.create_operation_commit(
                &conn,
                &CommitOperation::new(
                    format!("loader-{kind}-operation"),
                    "loader-kind-test",
                    "main",
                    kind,
                    "project",
                    Vec::new(),
                ),
            )
            .unwrap();
        }

        let loaded = load_serialized_commits(&conn).unwrap();
        let kinds = loaded
            .iter()
            .map(|commit| commit.commit.commit_kind.clone())
            .collect::<Vec<_>>();
        assert!(kinds.contains(&CommitKind::Move));
        assert!(kinds.contains(&CommitKind::Copy));
        assert!(kinds.contains(&CommitKind::Restore));
        assert!(kinds.contains(&CommitKind::Multi));
    }

    #[test]
    fn serialized_commit_loader_preserves_snapshot_and_branch_scopes() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("change-scope-loader-device".to_string());

        for scope in ["snapshot", "branch"] {
            ctx.create_operation_commit(
                &conn,
                &CommitOperation::new(
                    format!("loader-{scope}-scope-operation"),
                    "loader-scope-test",
                    "main",
                    "change",
                    scope,
                    Vec::new(),
                ),
            )
            .unwrap();
        }

        let scopes = load_serialized_commits(&conn)
            .unwrap()
            .into_iter()
            .map(|commit| commit.commit.change_scope.to_string())
            .collect::<Vec<_>>();
        assert!(scopes.iter().any(|scope| scope == "snapshot"));
        assert!(scopes.iter().any(|scope| scope == "branch"));
    }

    #[test]
    fn serialized_commit_loader_preserves_versioned_request_identity() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("request-identity-loader-device".to_string());
        let operation_id = "loader-versioned-request-identity";
        ctx.create_operation_commit(
            &conn,
            &CommitOperation::new(
                operation_id,
                "loader-request-identity-test",
                "main",
                "change",
                "project",
                Vec::new(),
            ),
        )
        .unwrap();
        let stored: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT request_hash FROM commit_operations WHERE operation_id = ?1",
                params![operation_id],
                |row| row.get(0),
            )
            .unwrap();

        let loaded = load_serialized_commits(&conn).unwrap();
        let serialized = loaded
            .iter()
            .filter_map(|commit| commit.operation.as_ref())
            .find(|operation| operation.operation_id == operation_id)
            .unwrap();
        assert_eq!(serialized.request_hash, stored);
        assert!(serialized.request_hash.starts_with(b"MDBXORI1"));
        assert_eq!(serialized.request_hash.len(), 40);
    }

    const TEST_PASSWORD: &str = "test-password";

    struct TempVault {
        path: PathBuf,
    }

    impl TempVault {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("mdbx-cli-{}.mdbx", uuid::Uuid::new_v4()));
            Self { path }
        }

        fn path(&self) -> PathBuf {
            self.path.clone()
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let candidate = PathBuf::from(format!("{}{}", self.path.display(), suffix));
                let _ = std::fs::remove_file(candidate);
            }
        }
    }

    fn cli(vault: &Path, command: Commands) -> Cli {
        Cli {
            vault: vault.to_path_buf(),
            unlock_password: Some(TEST_PASSWORD.to_string()),
            unlock_pin: None,
            command,
        }
    }

    fn locked_cli(vault: &Path, command: Commands) -> Cli {
        Cli {
            vault: vault.to_path_buf(),
            unlock_password: None,
            unlock_pin: None,
            command,
        }
    }

    fn sync_bundle_path() -> PathBuf {
        std::env::temp_dir().join(format!("mdbx-cli-sync-{}.mdbx-sync", uuid::Uuid::new_v4()))
    }

    fn backup_vault(source: &Path, target: &Path) {
        BackupService::create_portable_copy_path(source, target).unwrap();
    }

    fn init_cli(vault: &Path) -> Cli {
        Cli {
            vault: vault.to_path_buf(),
            unlock_password: None,
            unlock_pin: None,
            command: Commands::Init {
                tiga: "sky".to_string(),
                password: Some(TEST_PASSWORD.to_string()),
                pin: None,
            },
        }
    }

    fn open_unlocked(vault: &Path) -> VaultConnection {
        let mut conn = VaultConnection::open(vault).unwrap();
        UnlockService::unlock_with_password(&mut conn, TEST_PASSWORD).unwrap();
        conn
    }

    fn project_title(project: &mdbx_core::model::Project) -> String {
        String::from_utf8(project.title_ct.clone()).unwrap()
    }

    fn entry_title(entry: &mdbx_core::model::Entry) -> String {
        String::from_utf8(entry.title_ct.clone().unwrap()).unwrap()
    }

    #[test]
    fn clap_command_tree_has_no_definition_conflicts() {
        Cli::command().debug_assert();
    }

    #[test]
    fn clap_entry_create_routes_username_and_url_options() {
        for (username_option, url_option) in [("-u", "-l"), ("--username", "--url")] {
            let parsed = Cli::try_parse_from([
                "mdbx",
                "entry",
                "create",
                "project-1",
                username_option,
                "alice",
                url_option,
                "https://example.com",
            ])
            .unwrap();
            let Commands::Entry {
                action:
                    EntryAction::Create {
                        project_id,
                        username,
                        url,
                        ..
                    },
            } = parsed.command
            else {
                panic!("entry create command was not parsed");
            };

            assert_eq!(project_id, "project-1");
            assert_eq!(username.as_deref(), Some("alice"));
            assert_eq!(url.as_deref(), Some("https://example.com"));
        }
    }

    #[test]
    fn clap_entry_edit_routes_username_and_url_options() {
        for (username_option, url_option) in [("-u", "-l"), ("--username", "--url")] {
            let parsed = Cli::try_parse_from([
                "mdbx",
                "entry",
                "edit",
                "entry-1",
                username_option,
                "bob",
                url_option,
                "https://edited.example",
            ])
            .unwrap();
            let Commands::Entry {
                action:
                    EntryAction::Edit {
                        entry_id,
                        username,
                        url,
                        ..
                    },
            } = parsed.command
            else {
                panic!("entry edit command was not parsed");
            };

            assert_eq!(entry_id, "entry-1");
            assert_eq!(username.as_deref(), Some("bob"));
            assert_eq!(url.as_deref(), Some("https://edited.example"));
        }
    }

    #[test]
    fn clap_entry_get_routes_explicit_reveal_flag() {
        let redacted = Cli::try_parse_from(["mdbx", "entry", "get", "entry-1"]).unwrap();
        let Commands::Entry {
            action: EntryAction::Get { entry_id, reveal },
        } = redacted.command
        else {
            panic!("entry get command was not parsed");
        };
        assert_eq!(entry_id, "entry-1");
        assert!(!reveal);

        let disclosed =
            Cli::try_parse_from(["mdbx", "entry", "get", "entry-1", "--reveal"]).unwrap();
        let Commands::Entry {
            action: EntryAction::Get { entry_id, reveal },
        } = disclosed.command
        else {
            panic!("entry get --reveal command was not parsed");
        };
        assert_eq!(entry_id, "entry-1");
        assert!(reveal);
    }

    #[test]
    fn entry_get_default_render_is_explicitly_redacted() {
        let rendered = render_redacted_entry_summary(&ObjectSummary {
            object_id: "entry-1".to_string(),
            collection_id: "project-1".to_string(),
            object_type_id: EntryType::Login,
            title: Some(b"Example".to_vec()),
            payload_schema_version: 1,
            head_commit_id: "commit-1".to_string(),
            deleted: false,
            updated_at: "2026-07-23T00:00:00Z".to_string(),
        });
        assert!(rendered.contains("Payload:    [redacted; use --reveal]"));
        assert!(!rendered.contains("password"));
        assert!(!rendered.contains("secret"));
    }

    #[test]
    fn clap_entry_help_paths_render_without_panics() {
        for args in [
            ["mdbx", "entry", "create", "--help"],
            ["mdbx", "entry", "edit", "--help"],
            ["mdbx", "entry", "get", "--help"],
        ] {
            match Cli::try_parse_from(args) {
                Err(error) => assert_eq!(error.kind(), clap::error::ErrorKind::DisplayHelp),
                Ok(_) => panic!("help request unexpectedly parsed as an executable command"),
            }
        }
    }

    #[test]
    fn build_capability_manifest_is_vault_independent_and_matches_features() {
        let parsed = Cli::try_parse_from(["mdbx", "capabilities", "--json"]).unwrap();
        assert!(matches!(
            parsed.command,
            Commands::Capabilities { json: true }
        ));

        let vault = TempVault::new();
        let path = vault.path();
        run(locked_cli(&path, Commands::Capabilities { json: false })).unwrap();
        assert!(!path.exists());

        let manifest = CapabilitySet::current().build_manifest();
        let encoded = render_capability_manifest(&manifest, true).unwrap();
        let decoded: BuildCapabilityManifest = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, manifest);
        assert_eq!(
            manifest
                .storage
                .enabled_capability_ids
                .contains(&"mdbx.storage.filesystem-blob-store".to_string()),
            cfg!(feature = "external-blob-store")
        );
        assert_eq!(
            manifest
                .storage
                .enabled_capability_ids
                .contains(&"mdbx.storage.kdbx-binary-import".to_string()),
            cfg!(feature = "kdbx-binary-import")
        );
        assert_eq!(
            manifest
                .storage
                .enabled_capability_ids
                .contains(&"mdbx.storage.kdbx-binary-export".to_string()),
            cfg!(feature = "kdbx-binary-export")
        );
        assert_eq!(
            manifest
                .synchronization
                .enabled_capability_ids
                .contains(&mdbx_sync::CAPABILITY_ZSTD_BUNDLE_V1.to_string()),
            cfg!(feature = "sync-compression")
        );
    }

    #[test]
    fn rollback_anchor_cli_creates_verifies_and_preserves_files() {
        let vault = TempVault::new();
        let path = vault.path();
        let files = tempfile::tempdir().unwrap();
        let anchor = files.path().join("vault.anchor");
        let locked_anchor = files.path().join("locked.anchor");

        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Anchor {
                action: AnchorAction::Create {
                    output: anchor.clone(),
                },
            },
        ))
        .unwrap();
        let original = std::fs::read(&anchor).unwrap();
        assert!(!original.is_empty());
        assert!(original.len() <= MAX_ROLLBACK_ANCHOR_BYTES);

        run(cli(
            &path,
            Commands::Anchor {
                action: AnchorAction::Verify {
                    input: anchor.clone(),
                },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Advanced past anchor".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Anchor {
                action: AnchorAction::Verify {
                    input: anchor.clone(),
                },
            },
        ))
        .unwrap();

        let existing_error = run(cli(
            &path,
            Commands::Anchor {
                action: AnchorAction::Create {
                    output: anchor.clone(),
                },
            },
        ))
        .unwrap_err();
        assert!(existing_error.contains("failed to create rollback anchor"));
        assert_eq!(std::fs::read(&anchor).unwrap(), original);

        let locked_error = run(locked_cli(
            &path,
            Commands::Anchor {
                action: AnchorAction::Create {
                    output: locked_anchor.clone(),
                },
            },
        ))
        .unwrap_err();
        assert!(locked_error.contains("unlock"));
        assert!(!locked_anchor.exists());
    }

    #[test]
    fn rollback_anchor_cli_rejects_an_older_vault_copy() {
        let source = TempVault::new();
        let old = TempVault::new();
        let source_path = source.path();
        let old_path = old.path();
        let files = tempfile::tempdir().unwrap();
        let anchor = files.path().join("newer.anchor");

        run(init_cli(&source_path)).unwrap();
        backup_vault(&source_path, &old_path);
        run(cli(
            &source_path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Newer state".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        run(cli(
            &source_path,
            Commands::Anchor {
                action: AnchorAction::Create {
                    output: anchor.clone(),
                },
            },
        ))
        .unwrap();

        let error = run(cli(
            &old_path,
            Commands::Anchor {
                action: AnchorAction::Verify { input: anchor },
            },
        ))
        .unwrap_err();
        assert!(error.contains("rollback detected"));
    }

    #[test]
    fn content_manifest_cli_roundtrips_and_rejects_stale_state() {
        let vault = TempVault::new();
        let path = vault.path();
        let files = tempfile::tempdir().unwrap();
        let manifest = files.path().join("vault.manifest");
        let oversized = files.path().join("oversized.manifest");

        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::ContentManifest {
                action: ContentManifestAction::Create {
                    output: manifest.clone(),
                },
            },
        ))
        .unwrap();
        let original = std::fs::read(&manifest).unwrap();
        assert!(!original.is_empty());
        assert!(original.len() <= MAX_VAULT_CONTENT_MANIFEST_BYTES);

        run(cli(
            &path,
            Commands::ContentManifest {
                action: ContentManifestAction::Verify {
                    input: manifest.clone(),
                },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "After content manifest".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let stale = run(cli(
            &path,
            Commands::ContentManifest {
                action: ContentManifestAction::Verify {
                    input: manifest.clone(),
                },
            },
        ))
        .unwrap_err();
        assert!(stale.contains("does not match"));

        let existing = run(cli(
            &path,
            Commands::ContentManifest {
                action: ContentManifestAction::Create {
                    output: manifest.clone(),
                },
            },
        ))
        .unwrap_err();
        assert!(existing.contains("failed to create vault content manifest"));
        assert_eq!(std::fs::read(&manifest).unwrap(), original);

        std::fs::write(&oversized, vec![0_u8; MAX_VAULT_CONTENT_MANIFEST_BYTES + 1]).unwrap();
        let oversized_error = run(cli(
            &path,
            Commands::ContentManifest {
                action: ContentManifestAction::Verify { input: oversized },
            },
        ))
        .unwrap_err();
        assert!(oversized_error.contains("exceeds"));
    }

    #[test]
    fn integrity_root_cli_keeps_status_readable_while_locked() {
        let vault = TempVault::new();
        let path = vault.path();

        run(init_cli(&path)).unwrap();
        run(locked_cli(
            &path,
            Commands::IntegrityRoot {
                action: IntegrityRootAction::Status,
            },
        ))
        .unwrap();

        let locked_enable = run(locked_cli(
            &path,
            Commands::IntegrityRoot {
                action: IntegrityRootAction::Enable,
            },
        ))
        .unwrap_err();
        assert!(locked_enable.contains("unlock"));

        run(cli(
            &path,
            Commands::IntegrityRoot {
                action: IntegrityRootAction::Enable,
            },
        ))
        .unwrap();
        run(locked_cli(
            &path,
            Commands::IntegrityRoot {
                action: IntegrityRootAction::Status,
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::IntegrityRoot {
                action: IntegrityRootAction::Verify,
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::IntegrityRoot {
                action: IntegrityRootAction::Rebuild,
            },
        ))
        .unwrap();
    }

    #[test]
    fn integrity_root_cli_parses_all_operations() {
        for operation in ["status", "enable", "verify", "rebuild"] {
            let cli = Cli::try_parse_from(["mdbx", "integrity-root", operation]).unwrap();
            assert!(matches!(cli.command, Commands::IntegrityRoot { .. }));
        }
    }

    #[test]
    fn cli_can_init_unlock_and_project_crud() {
        let vault = TempVault::new();
        let path = vault.path();

        run(init_cli(&path)).unwrap();
        run(cli(&path, Commands::Unlock)).unwrap();

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "CLI Project".to_string(),
                    group: Some("work".to_string()),
                },
            },
        ))
        .unwrap();

        let mut conn = open_unlocked(&path);
        let project = ProjectRepo::list_all(&conn).unwrap().remove(0);
        assert_eq!(project_title(&project), "CLI Project");
        assert_eq!(project.group_id.as_deref(), Some("work"));

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Get {
                    project_id: project.project_id.clone(),
                },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Edit {
                    project_id: project.project_id.clone(),
                    title: Some("CLI Project Renamed".to_string()),
                    favorite: Some(true),
                },
            },
        ))
        .unwrap();

        conn = open_unlocked(&path);
        let updated = ProjectRepo::get_by_id(&conn, &project.project_id)
            .unwrap()
            .unwrap();
        assert_eq!(project_title(&updated), "CLI Project Renamed");
        assert!(updated.favorite);

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::List,
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Delete {
                    project_id: project.project_id.clone(),
                },
            },
        ))
        .unwrap();

        conn = open_unlocked(&path);
        assert!(ProjectRepo::list_all(&conn).unwrap().is_empty());
        assert_eq!(ProjectRepo::list_deleted(&conn).unwrap().len(), 1);

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Deleted,
            },
        ))
        .unwrap();
    }

    #[test]
    fn init_failure_removes_new_vault_and_sidecars() {
        let vault = TempVault::new();
        let path = vault.path();
        let command = Commands::Init {
            tiga: "sky".to_string(),
            password: None,
            pin: Some("12".to_string()),
        };

        let result = run(Cli {
            vault: path.clone(),
            unlock_password: None,
            unlock_pin: None,
            command,
        });

        assert!(result.is_err());
        assert!(!path.exists());
        assert!(!PathBuf::from(format!("{}-wal", path.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", path.display())).exists());
    }

    #[test]
    fn non_mdbx_sqlite_is_rejected_without_modification() {
        let vault = TempVault::new();
        let path = vault.path();
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE unrelated_data (value TEXT NOT NULL);
                 INSERT INTO unrelated_data VALUES ('preserve-me');",
            )
            .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let result = run(locked_cli(&path, Commands::Unlock));

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn cli_can_entry_crud_move_and_copy() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();

        for title in ["Source", "Target"] {
            run(cli(
                &path,
                Commands::Project {
                    action: ProjectAction::Create {
                        title: title.to_string(),
                        group: None,
                    },
                },
            ))
            .unwrap();
        }

        let conn = open_unlocked(&path);
        let projects = ProjectRepo::list_all(&conn).unwrap();
        let source_id = projects
            .iter()
            .find(|p| project_title(p) == "Source")
            .unwrap()
            .project_id
            .clone();
        let target_id = projects
            .iter()
            .find(|p| project_title(p) == "Target")
            .unwrap()
            .project_id
            .clone();
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Create {
                    project_id: source_id.clone(),
                    entry_type: "login".to_string(),
                    title: Some("Example Login".to_string()),
                    username: Some("alice".to_string()),
                    password: Some("secret".to_string()),
                    url: Some("https://example.com".to_string()),
                    notes: Some("created from CLI".to_string()),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let mut entries = EntryRepo::list_by_project(&conn, &source_id).unwrap();
        assert_eq!(entries.len(), 1);
        let entry_id = entries.remove(0).entry_id;
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Get {
                    entry_id: entry_id.clone(),
                    reveal: false,
                },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Get {
                    entry_id: entry_id.clone(),
                    reveal: true,
                },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Edit {
                    entry_id: entry_id.clone(),
                    title: Some("Example Login v2".to_string()),
                    username: Some("bob".to_string()),
                    password: None,
                    url: None,
                    notes: Some("updated from CLI".to_string()),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let updated = EntryRepo::get_by_id(&conn, &entry_id).unwrap().unwrap();
        assert_eq!(entry_title(&updated), "Example Login v2");
        let payload: serde_json::Value = serde_json::from_slice(&updated.payload_ct).unwrap();
        assert_eq!(payload["username"], "bob");
        assert_eq!(payload["password"], "secret");
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Copy {
                    entry_id: entry_id.clone(),
                    target_project_id: target_id.clone(),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        assert_eq!(
            EntryRepo::list_by_project(&conn, &source_id).unwrap().len(),
            1
        );
        assert_eq!(
            EntryRepo::list_by_project(&conn, &target_id).unwrap().len(),
            1
        );
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Move {
                    entry_id: entry_id.clone(),
                    target_project_id: target_id.clone(),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        assert!(EntryRepo::list_by_project(&conn, &source_id)
            .unwrap()
            .is_empty());
        let target_entries = EntryRepo::list_by_project(&conn, &target_id).unwrap();
        assert_eq!(target_entries.len(), 2);
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::List {
                    project_id: target_id,
                    entry_type: Some("login".to_string()),
                },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Delete {
                    entry_id: entry_id.clone(),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let deleted = EntryRepo::get_by_id(&conn, &entry_id).unwrap().unwrap();
        assert!(deleted.deleted);
        assert_eq!(EntryRepo::list_deleted(&conn).unwrap().len(), 1);
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Deleted,
            },
        ))
        .unwrap();
    }

    #[test]
    fn cli_entry_get_and_list_do_not_decrypt_object_payloads() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Summary Collection".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        let entry = EntryRepo::create(
            &conn,
            &ctx(),
            &project_id,
            EntryType::Login,
            Some("Visible title"),
            &serde_json::json!({"password": "secret"}),
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                params![entry.entry_id],
            )
            .unwrap();
        drop(conn);

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::List {
                    project_id,
                    entry_type: Some("login".to_string()),
                },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Get {
                    entry_id: entry.entry_id.clone(),
                    reveal: false,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let deleted_entry = EntryRepo::create(
            &conn,
            &ctx(),
            &entry.project_id,
            EntryType::Login,
            Some("Deleted visible title"),
            &serde_json::json!({"password": "deleted secret"}),
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx(), &deleted_entry.entry_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                params![deleted_entry.entry_id],
            )
            .unwrap();
        drop(conn);
        run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Deleted,
            },
        ))
        .unwrap();
    }

    #[test]
    fn cli_entry_get_reveal_denies_before_corrupt_payload_decryption() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Power Collection".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        let entry = EntryRepo::create(
            &conn,
            &ctx(),
            &project_id,
            EntryType::Login,
            Some("Denied secret"),
            &serde_json::json!({"password": "secret"}),
        )
        .unwrap();
        let session = conn.active_session().unwrap().clone();
        let device = cli_device_context();
        TigaService::set_vault_profile_authorized(
            &conn,
            &ctx(),
            TigaMode::Power,
            None,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: chrono::Utc::now().timestamp(),
            },
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                [&entry.entry_id],
            )
            .unwrap();
        drop(conn);

        let error = run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Get {
                    entry_id: entry.entry_id,
                    reveal: true,
                },
            },
        ))
        .unwrap_err();
        assert!(
            error.contains("Tiga authorization did not allow"),
            "unexpected error: {error}"
        );
        assert!(!error.contains("crypto error"));
    }

    #[test]
    fn cli_entry_get_reveal_enforces_default_payload_limit_before_decryption() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Oversized Collection".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        let entry = EntryRepo::create(
            &conn,
            &ctx(),
            &project_id,
            EntryType::Login,
            Some("Oversized secret"),
            &serde_json::json!({"password": "secret"}),
        )
        .unwrap();
        let oversized = mdbx_storage::object_disclosure::DEFAULT_MAX_OBJECT_DISCLOSURE_PAYLOAD_BYTES
            + 1024 * 1024;
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = zeroblob(?2) WHERE entry_id = ?1",
                params![&entry.entry_id, oversized as i64],
            )
            .unwrap();
        drop(conn);

        let error = run(cli(
            &path,
            Commands::Entry {
                action: EntryAction::Get {
                    entry_id: entry.entry_id,
                    reveal: true,
                },
            },
        ))
        .unwrap_err();
        assert!(
            error.contains("object payload ciphertext bytes"),
            "unexpected error: {error}"
        );
        assert!(!error.contains("crypto error"));
    }

    #[test]
    fn cli_can_attachment_crud_and_snapshot_roundtrip() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();

        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Attachments".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        let commit_count_before_attachment: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        let input =
            std::env::temp_dir().join(format!("mdbx-cli-input-{}.txt", uuid::Uuid::new_v4()));
        let output =
            std::env::temp_dir().join(format!("mdbx-cli-output-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&input, b"hello from attachment").unwrap();

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id: project_id.clone(),
                    entry_id: None,
                    file: input.clone(),
                    external: false,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let attachment = AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .remove(0);
        let commit_count_after_attachment: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            commit_count_after_attachment,
            commit_count_before_attachment + 1
        );
        assert_eq!(
            String::from_utf8(attachment.file_name_ct.clone()).unwrap(),
            input.file_name().unwrap().to_string_lossy()
        );
        drop(conn);

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Info {
                    attachment_id: attachment.attachment_id.clone(),
                },
            },
        ))
        .unwrap();
        std::fs::write(&output, b"stale output").unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Verify {
                    attachment_id: attachment.attachment_id.clone(),
                },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Get {
                    attachment_id: attachment.attachment_id.clone(),
                    output: Some(output.clone()),
                },
            },
        ))
        .unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), b"hello from attachment");

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Rename {
                    attachment_id: attachment.attachment_id.clone(),
                    file_name: "renamed.txt".to_string(),
                    media_type: Some("text/plain".to_string()),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let renamed = AttachmentRepo::get_by_id(&conn, &attachment.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            String::from_utf8(renamed.file_name_ct).unwrap(),
            "renamed.txt"
        );
        drop(conn);

        // Attachment navigation must remain metadata-only even when content is corrupt.
        let conn = open_unlocked(&path);
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = X'00' WHERE attachment_id = ?1",
                params![&attachment.attachment_id],
            )
            .unwrap();
        drop(conn);
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::List {
                    project_id: Some(project_id.clone()),
                    entry_id: None,
                },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Snapshot {
                action: SnapshotAction::Create,
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let snapshot_id = SnapshotRepo::list_all(&conn).unwrap()[0]
            .snapshot_id
            .clone();
        drop(conn);
        run(cli(
            &path,
            Commands::Snapshot {
                action: SnapshotAction::List,
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Snapshot {
                action: SnapshotAction::Restore { snapshot_id },
            },
        ))
        .unwrap();

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Delete {
                    attachment_id: attachment.attachment_id.clone(),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let deleted = AttachmentRepo::get_by_id(&conn, &attachment.attachment_id)
            .unwrap()
            .unwrap();
        assert!(deleted.deleted);
        assert_eq!(AttachmentRepo::list_deleted(&conn).unwrap().len(), 1);
        drop(conn);

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Deleted,
            },
        ))
        .unwrap();

        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(output);
    }

    #[test]
    fn cli_snapshot_list_is_payload_free_for_corrupt_large_ciphertext() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        let conn = open_unlocked(&path);
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx()).unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = zeroblob(?2) WHERE snapshot_id = ?1",
                params![&snapshot.snapshot_id, 2 * 1024 * 1024_i64],
            )
            .unwrap();
        assert_eq!(
            SnapshotSummaryRepo::get(&conn, &snapshot.snapshot_id)
                .unwrap()
                .unwrap()
                .snapshot_ciphertext_bytes,
            2 * 1024 * 1024
        );
        drop(conn);

        run(cli(
            &path,
            Commands::Snapshot {
                action: SnapshotAction::List,
            },
        ))
        .unwrap();
    }

    #[test]
    fn cli_snapshot_lifecycle_commands_parse_and_prune_only_automatic_rows() {
        let parsed = Cli::try_parse_from([
            "mdbx",
            "snapshot",
            "create-automatic",
            "--retention-eligible-at",
            "2099-01-01T00:00:00Z",
        ])
        .unwrap();
        assert!(matches!(
            parsed.command,
            Commands::Snapshot {
                action: SnapshotAction::CreateAutomatic { .. }
            }
        ));
        let parsed =
            Cli::try_parse_from(["mdbx", "snapshot", "prune-plan", "--keep-latest", "3"]).unwrap();
        assert!(matches!(
            parsed.command,
            Commands::Snapshot {
                action: SnapshotAction::PrunePlan { keep_latest: 3 }
            }
        ));

        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        let conn = open_unlocked(&path);
        let context = ctx();
        let legacy = SnapshotRepo::create_snapshot(&conn, &context).unwrap();
        let automatic = SnapshotRepo::create_snapshot(&conn, &context).unwrap();
        SnapshotLifecycleRepo::register(
            &conn,
            &automatic.snapshot_id,
            mdbx_core::model::SnapshotKind::Automatic,
            Some(&automatic.created_at),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let plan =
            SnapshotLifecycleRepo::plan_automatic_prune(&conn, 0, chrono::Utc::now().timestamp())
                .unwrap();
        assert_eq!(plan.candidates.len(), 1);
        let before_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        run(cli(
            &path,
            Commands::Snapshot {
                action: SnapshotAction::Prune {
                    plan_token: plan.plan_token,
                    keep_latest: 0,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        assert!(SnapshotRepo::get_by_id(&conn, &legacy.snapshot_id)
            .unwrap()
            .is_some());
        assert!(SnapshotRepo::get_by_id(&conn, &automatic.snapshot_id)
            .unwrap()
            .is_none());
        let after_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_commits, before_commits + 1);
    }

    #[test]
    fn cli_attachment_export_failure_preserves_existing_target() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Protected Export".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        drop(conn);
        let input =
            std::env::temp_dir().join(format!("mdbx-cli-corrupt-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&input, b"authenticated attachment content").unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id: project_id.clone(),
                    entry_id: None,
                    file: input.clone(),
                    external: false,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let attachment = AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .remove(0);
        conn.inner()
            .execute(
                "UPDATE attachments SET content_hash = ?1 WHERE attachment_id = ?2",
                params!["0".repeat(64), attachment.attachment_id],
            )
            .unwrap();
        drop(conn);

        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("existing.bin");
        std::fs::write(&output, b"keep this target").unwrap();
        let error = run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Get {
                    attachment_id: attachment.attachment_id,
                    output: Some(output.clone()),
                },
            },
        ))
        .unwrap_err();

        assert!(error.contains("content hash mismatch"));
        assert_eq!(std::fs::read(&output).unwrap(), b"keep this target");
        let remaining_files: Vec<_> = std::fs::read_dir(output_dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(remaining_files, vec![output.file_name().unwrap()]);

        let _ = std::fs::remove_file(input);
    }

    #[test]
    fn cli_attachment_export_is_denied_before_temporary_file_creation() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Power Export".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        let session = conn.active_session().cloned().unwrap();
        let device = cli_device_context();
        TigaService::set_project_profile_authorized(
            &conn,
            &ctx(),
            &project_id,
            Some(TigaMode::Power),
            None,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: chrono::Utc::now().timestamp(),
            },
        )
        .unwrap();
        drop(conn);

        let input =
            std::env::temp_dir().join(format!("mdbx-cli-denied-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&input, b"protected content").unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id: project_id.clone(),
                    entry_id: None,
                    file: input.clone(),
                    external: false,
                },
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let attachment = AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .remove(0);
        drop(conn);

        let output_dir = tempfile::tempdir().unwrap();
        let output = output_dir.path().join("existing.bin");
        std::fs::write(&output, b"keep existing content").unwrap();
        let error = run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Get {
                    attachment_id: attachment.attachment_id.clone(),
                    output: Some(output.clone()),
                },
            },
        ))
        .unwrap_err();
        assert!(error.contains("authorization"));
        assert_eq!(std::fs::read(&output).unwrap(), b"keep existing content");
        let remaining_files: Vec<_> = std::fs::read_dir(output_dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(remaining_files, vec![output.file_name().unwrap()]);

        let conn = open_unlocked(&path);
        let event = TigaService::list_security_audit_events(&conn, 10)
            .unwrap()
            .into_iter()
            .find(|event| event.operation == mdbx_core::tiga::TigaOperation::ExportData)
            .unwrap();
        assert_eq!(
            event.scope,
            mdbx_core::tiga::TigaScope::Attachment {
                attachment_id: attachment.attachment_id
            }
        );
        assert!(event.policy_fingerprint.is_some());

        let _ = std::fs::remove_file(input);
    }

    #[test]
    fn cli_streams_large_attachment_in_single_commit() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Large Attachments".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        drop(conn);

        let input =
            std::env::temp_dir().join(format!("mdbx-cli-large-{}.bin", uuid::Uuid::new_v4()));
        let output =
            std::env::temp_dir().join(format!("mdbx-cli-large-out-{}.bin", uuid::Uuid::new_v4()));
        let data: Vec<u8> = (0..ATTACHMENT_STREAM_CHUNK_SIZE + 17)
            .map(|index| (index % 251) as u8)
            .collect();
        std::fs::write(&input, &data).unwrap();

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id: project_id.clone(),
                    entry_id: None,
                    file: input.clone(),
                    external: false,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let attachment = AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .remove(0);
        let commit_count_after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(commit_count_after, commit_count_before + 1);
        assert_eq!(attachment.chunk_count, 2);
        assert_eq!(
            attachment.storage_mode,
            mdbx_core::model::attachment::StorageMode::EmbeddedChunked
        );
        drop(conn);

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Get {
                    attachment_id: attachment.attachment_id,
                    output: Some(output.clone()),
                },
            },
        ))
        .unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), data);

        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(output);
    }

    #[cfg(feature = "external-blob-store")]
    #[test]
    fn cli_roundtrips_external_encrypted_attachment() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "External Attachments".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        drop(conn);
        let input =
            std::env::temp_dir().join(format!("mdbx-cli-external-{}.bin", uuid::Uuid::new_v4()));
        let output = std::env::temp_dir().join(format!(
            "mdbx-cli-external-out-{}.bin",
            uuid::Uuid::new_v4()
        ));
        let data: Vec<u8> = (0..ATTACHMENT_STREAM_CHUNK_SIZE + 31)
            .map(|index| (index % 241) as u8)
            .collect();
        std::fs::write(&input, &data).unwrap();

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id: project_id.clone(),
                    entry_id: None,
                    file: input.clone(),
                    external: true,
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let attachment = AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .remove(0);
        assert_eq!(attachment.storage_mode, StorageMode::ExternalHashRef);
        assert_eq!(attachment.chunk_count, 2);
        let (embedded_count, external_count): (i64, i64) = conn
            .inner()
            .query_row(
                "SELECT COUNT(chunk_ct), COUNT(external_uri_ct)
                 FROM attachment_chunks WHERE attachment_id = ?1",
                params![attachment.attachment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(embedded_count, 0);
        assert_eq!(external_count, 2);
        drop(conn);
        assert!(default_blob_store_path(&path).is_dir());

        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Verify {
                    attachment_id: attachment.attachment_id.clone(),
                },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Get {
                    attachment_id: attachment.attachment_id,
                    output: Some(output.clone()),
                },
            },
        ))
        .unwrap();
        assert_eq!(std::fs::read(&output).unwrap(), data);

        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(output);
        let _ = std::fs::remove_dir_all(default_blob_store_path(&path));
    }

    #[cfg(feature = "external-blob-store")]
    #[test]
    fn cli_audits_plans_and_applies_blob_garbage_collection() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Blob maintenance".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        drop(conn);
        let input =
            std::env::temp_dir().join(format!("mdbx-cli-blob-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&input, b"referenced external content").unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id,
                    entry_id: None,
                    file: input.clone(),
                    external: true,
                },
            },
        ))
        .unwrap();

        let store = FileSystemBlobStore::new(default_blob_store_path(&path));
        let orphan = b"opaque orphan ciphertext";
        let orphan_id = mdbx_storage::blob_store::compute_blob_id(orphan);
        mdbx_storage::blob_store::EncryptedBlobStore::put(&store, &orphan_id, orphan).unwrap();
        let conn = open_unlocked(&path);
        let cutoff = chrono::Utc::now().timestamp().saturating_add(1);
        let plan =
            BlobLifecycleService::plan_gc(&conn, &store, cutoff, BlobLifecycleLimits::default())
                .unwrap();
        assert_eq!(plan.eligible_orphans.len(), 1);
        drop(conn);

        run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::Audit {
                    grace_hours: 0,
                    skip_content_verification: false,
                },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::GcPlan { grace_hours: 0 },
            },
        ))
        .unwrap();
        run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::GcApply {
                    plan_token: plan.plan_token,
                    cutoff_unix_secs: cutoff,
                },
            },
        ))
        .unwrap();

        assert!(!store.blob_path(&orphan_id).unwrap().exists());
        let conn = open_unlocked(&path);
        let audit_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
                 WHERE operation = 'purge-deleted-object'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);

        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_dir_all(default_blob_store_path(&path));
    }

    #[cfg(feature = "external-blob-store")]
    #[test]
    fn cli_blob_transfer_persists_owner_resumes_and_removes_checkpoint() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        let source = FileSystemBlobStore::new(default_blob_store_path(&path));
        let ciphertext = vec![0x7b; 37];
        let blob_id = mdbx_storage::blob_store::compute_blob_id(&ciphertext);
        mdbx_storage::blob_store::EncryptedBlobStore::put(&source, &blob_id, &ciphertext).unwrap();
        let destination_directory = tempfile::tempdir().unwrap();
        let destination_path = destination_directory.path().join("replica.blobs");
        let checkpoint = destination_directory.path().join("transfer.json");

        let transfer = || {
            cli(
                &path,
                Commands::Blob {
                    action: BlobAction::Transfer {
                        blob_id: blob_id.clone(),
                        size: ciphertext.len() as u64,
                        destination: destination_path.clone(),
                        checkpoint: checkpoint.clone(),
                        chunk_size: 8,
                        max_chunks: 2,
                        lease_ttl_secs: 60,
                    },
                },
            )
        };

        run(transfer()).unwrap();
        let first = read_blob_transfer_checkpoint(&checkpoint).unwrap();
        assert_eq!(first.checkpoint.transferred_bytes, 16);
        run(transfer()).unwrap();
        let second = read_blob_transfer_checkpoint(&checkpoint).unwrap();
        assert_eq!(second.owner_id, first.owner_id);
        assert_eq!(second.checkpoint.transferred_bytes, 32);
        run(transfer()).unwrap();
        assert!(!checkpoint.exists());

        let destination = FileSystemBlobStore::new(&destination_path);
        assert_eq!(
            mdbx_storage::blob_store::EncryptedBlobStore::get(&destination, &blob_id, 100).unwrap(),
            ciphertext
        );
        let _ = std::fs::remove_dir_all(default_blob_store_path(&path));
    }

    #[cfg(feature = "external-blob-store")]
    #[test]
    fn cli_blob_transfer_rejects_tampered_checkpoint_without_publishing() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        let source = FileSystemBlobStore::new(default_blob_store_path(&path));
        let ciphertext = vec![0x41; 24];
        let blob_id = mdbx_storage::blob_store::compute_blob_id(&ciphertext);
        mdbx_storage::blob_store::EncryptedBlobStore::put(&source, &blob_id, &ciphertext).unwrap();
        let destination_directory = tempfile::tempdir().unwrap();
        let destination_path = destination_directory.path().join("replica.blobs");
        let checkpoint = destination_directory.path().join("transfer.json");
        let command = || {
            cli(
                &path,
                Commands::Blob {
                    action: BlobAction::Transfer {
                        blob_id: blob_id.clone(),
                        size: ciphertext.len() as u64,
                        destination: destination_path.clone(),
                        checkpoint: checkpoint.clone(),
                        chunk_size: 8,
                        max_chunks: 1,
                        lease_ttl_secs: 60,
                    },
                },
            )
        };
        run(command()).unwrap();
        let mut saved = read_blob_transfer_checkpoint(&checkpoint).unwrap();
        saved.checkpoint.transferred_bytes += 1;
        write_blob_transfer_checkpoint(&checkpoint, &saved.owner_id, &saved.checkpoint).unwrap();

        let error = run(command()).unwrap_err();
        assert!(error.contains("checkpoint does not match this transfer"));
        let destination = FileSystemBlobStore::new(&destination_path);
        assert!(!destination.blob_path(&blob_id).unwrap().exists());
        assert!(checkpoint.exists());
        let _ = std::fs::remove_dir_all(default_blob_store_path(&path));
    }

    #[cfg(feature = "external-blob-store")]
    #[test]
    fn cli_blob_replica_plan_and_replicate_converge_with_atomic_checkpoint() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Replica CLI".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let project_id = ProjectRepo::list_all(&open_unlocked(&path)).unwrap()[0]
            .project_id
            .clone();
        let input =
            std::env::temp_dir().join(format!("mdbx-cli-replica-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&input, vec![0x37_u8; 100]).unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id,
                    entry_id: None,
                    file: input.clone(),
                    external: true,
                },
            },
        ))
        .unwrap();
        let destination_directory = tempfile::tempdir().unwrap();
        let destination = destination_directory.path().join("replica.blobs");
        let checkpoint = destination_directory.path().join("replica.json");
        run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::ReplicaPlan {
                    destination: destination.clone(),
                    cursor: None,
                    checkpoint: None,
                    page_size: 10,
                    json: true,
                },
            },
        ))
        .unwrap();

        let mut completed = false;
        for _ in 0..10 {
            run(cli(
                &path,
                Commands::Blob {
                    action: BlobAction::Replicate {
                        destination: destination.clone(),
                        checkpoint: checkpoint.clone(),
                        page_size: 2,
                        max_items: 1,
                        chunk_size: 8,
                        max_chunks: 100,
                        max_blob_bytes: 1024 * 1024,
                        lease_ttl_secs: 60,
                    },
                },
            ))
            .unwrap();
            if !checkpoint.exists() {
                completed = true;
                break;
            }
        }
        assert!(completed);
        let conn = open_unlocked(&path);
        let source = FileSystemBlobStore::new(default_blob_store_path(&path));
        let destination_store = FileSystemBlobStore::new(&destination);
        let plan = BlobReplicaService::page(
            &conn,
            &source,
            &destination_store,
            BlobReplicaPageRequest::new(None, None, 10, BlobLifecycleLimits::default()).unwrap(),
        )
        .unwrap();
        assert!(plan.items.is_empty());
        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_dir_all(default_blob_store_path(&path));
    }

    #[cfg(feature = "external-blob-store")]
    #[test]
    fn cli_blob_replicate_preserves_checkpoint_when_source_is_missing() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Replica blocked".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let project_id = ProjectRepo::list_all(&open_unlocked(&path)).unwrap()[0]
            .project_id
            .clone();
        let input = std::env::temp_dir().join(format!(
            "mdbx-cli-replica-blocked-{}.bin",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&input, vec![0x48_u8; 100]).unwrap();
        run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id,
                    entry_id: None,
                    file: input.clone(),
                    external: true,
                },
            },
        ))
        .unwrap();
        let source = FileSystemBlobStore::new(default_blob_store_path(&path));
        let missing_id = source.list(None, 10).unwrap().blobs[0].blob_id.clone();
        source.delete(&missing_id).unwrap();
        let destination_directory = tempfile::tempdir().unwrap();
        let destination = destination_directory.path().join("replica.blobs");
        let checkpoint = destination_directory.path().join("replica.json");
        let error = run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::Replicate {
                    destination,
                    checkpoint: checkpoint.clone(),
                    page_size: 2,
                    max_items: 1,
                    chunk_size: 8,
                    max_chunks: 1,
                    max_blob_bytes: 1024 * 1024,
                    lease_ttl_secs: 60,
                },
            },
        ))
        .unwrap_err();
        assert!(error.contains("Blob replica is blocked"));
        assert!(checkpoint.exists());
        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(checkpoint);
        let _ = std::fs::remove_dir_all(default_blob_store_path(&path));
    }

    #[cfg(not(feature = "external-blob-store"))]
    #[test]
    fn core_cli_reports_missing_external_blob_provider_before_mutation() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();
        run(cli(
            &path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Core Attachments".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();
        let conn = open_unlocked(&path);
        let project_id = ProjectRepo::list_all(&conn).unwrap()[0].project_id.clone();
        drop(conn);
        let input =
            std::env::temp_dir().join(format!("mdbx-cli-core-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&input, b"external").unwrap();

        let error = run(cli(
            &path,
            Commands::Attach {
                action: AttachAction::Add {
                    project_id: project_id.clone(),
                    entry_id: None,
                    file: input.clone(),
                    external: true,
                },
            },
        ))
        .unwrap_err();

        assert!(error.contains("does not include the filesystem encrypted Blob Provider"));
        let conn = open_unlocked(&path);
        assert!(AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_file(input);
    }

    #[cfg(not(feature = "external-blob-store"))]
    #[test]
    fn core_cli_reports_missing_blob_lifecycle_capability() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();

        let error = run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::Audit {
                    grace_hours: 168,
                    skip_content_verification: false,
                },
            },
        ))
        .unwrap_err();

        assert!(error.contains("does not include filesystem Blob lifecycle management"));

        let destination = std::env::temp_dir().join(format!(
            "mdbx-cli-core-blob-transfer-{}",
            uuid::Uuid::new_v4()
        ));
        let checkpoint = destination.with_extension("checkpoint.json");
        let error = run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::Transfer {
                    blob_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_string(),
                    size: 1,
                    destination: destination.clone(),
                    checkpoint: checkpoint.clone(),
                    chunk_size: 1,
                    max_chunks: 1,
                    lease_ttl_secs: 60,
                },
            },
        ))
        .unwrap_err();
        assert!(error.contains("does not include filesystem Blob lifecycle management"));
        assert!(!destination.exists());
        assert!(!checkpoint.exists());

        let replica_destination =
            std::env::temp_dir().join(format!("mdbx-cli-core-replica-{}", uuid::Uuid::new_v4()));
        let replica_checkpoint = replica_destination.with_extension("json");
        let error = run(cli(
            &path,
            Commands::Blob {
                action: BlobAction::Replicate {
                    destination: replica_destination.clone(),
                    checkpoint: replica_checkpoint.clone(),
                    page_size: 1,
                    max_items: 1,
                    chunk_size: 1,
                    max_chunks: 1,
                    max_blob_bytes: 1,
                    lease_ttl_secs: 60,
                },
            },
        ))
        .unwrap_err();
        assert!(error.contains("does not include filesystem Blob lifecycle management"));
        assert!(!replica_destination.exists());
        assert!(!replica_checkpoint.exists());
    }

    #[test]
    fn cli_backup_reopens_with_latest_project_and_has_no_sidecars() {
        let source = TempVault::new();
        let backup = TempVault::new();
        let source_path = source.path();
        let backup_path = backup.path();
        run(init_cli(&source_path)).unwrap();
        run(cli(
            &source_path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Portable backup project".to_string(),
                    group: None,
                },
            },
        ))
        .unwrap();

        run(locked_cli(
            &source_path,
            Commands::Backup {
                output: backup_path.clone(),
            },
        ))
        .unwrap();

        assert!(!PathBuf::from(format!("{}-wal", backup_path.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", backup_path.display())).exists());
        let reopened = open_unlocked(&backup_path);
        let projects = ProjectRepo::list_all(&reopened).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(project_title(&projects[0]), "Portable backup project");
    }

    #[test]
    fn cli_backup_preserves_existing_output() {
        let source = TempVault::new();
        let backup = TempVault::new();
        let source_path = source.path();
        let backup_path = backup.path();
        run(init_cli(&source_path)).unwrap();
        std::fs::write(&backup_path, b"preserve CLI output").unwrap();

        let result = run(cli(
            &source_path,
            Commands::Backup {
                output: backup_path.clone(),
            },
        ));

        assert!(result.is_err());
        assert_eq!(std::fs::read(backup_path).unwrap(), b"preserve CLI output");
    }

    #[test]
    fn cli_backup_preserves_legacy_format_before_automatic_open() {
        let source = TempVault::new();
        let backup = TempVault::new();
        let source_path = source.path();
        let backup_path = backup.path();
        {
            let conn = rusqlite::Connection::open(&source_path).unwrap();
            mdbx_storage::schema::v1::create_all_tables(&conn).unwrap();
            conn.execute(
                "INSERT INTO vault_meta
                    (vault_id, format_version, created_at, updated_at,
                     default_tiga_mode, active_key_epoch_id, compat_flags,
                     critical_extensions)
                 VALUES ('cli-legacy-backup-vault', 'MDBX-1',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
                         'multi', 'epoch-1', '', '')",
                [],
            )
            .unwrap();
        }

        run(locked_cli(
            &source_path,
            Commands::Backup {
                output: backup_path.clone(),
            },
        ))
        .unwrap();

        let source_plan = mdbx_storage::migration::inspect_migration_path(&source_path).unwrap();
        let backup_plan = mdbx_storage::migration::inspect_migration_path(&backup_path).unwrap();
        assert_eq!(source_plan, backup_plan);
        assert_eq!(source_plan.format_version.as_deref(), Some("MDBX-1"));
        assert!(source_plan.requires_upgrade);
    }

    #[test]
    fn cli_can_export_and_apply_sync_bundle_to_same_vault_copy() {
        let source = TempVault::new();
        let target = TempVault::new();
        let core_target = TempVault::new();
        let source_path = source.path();
        let target_path = target.path();
        let core_target_path = core_target.path();
        let bundle_path = sync_bundle_path();

        run(init_cli(&source_path)).unwrap();
        backup_vault(&source_path, &target_path);
        backup_vault(&source_path, &core_target_path);

        run(cli(
            &source_path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Synced Project".to_string(),
                    group: Some("sync".to_string()),
                },
            },
        ))
        .unwrap();

        let conn = open_unlocked(&source_path);
        let project = ProjectRepo::list_all(&conn).unwrap().remove(0);
        let project_id = project.project_id.clone();
        drop(conn);

        run(cli(
            &source_path,
            Commands::Entry {
                action: EntryAction::Create {
                    project_id: project_id.clone(),
                    entry_type: "login".to_string(),
                    title: Some("Synced Login".to_string()),
                    username: Some("alice".to_string()),
                    password: Some("synced-secret".to_string()),
                    url: Some("https://sync.example".to_string()),
                    notes: Some("created before bundle".to_string()),
                },
            },
        ))
        .unwrap();

        run(cli(
            &source_path,
            Commands::Sync {
                action: SyncAction::Bundle {
                    output: bundle_path.clone(),
                    base_checkpoint: None,
                    result_checkpoint: None,
                    compression: BundleCompressionCli::None,
                    authenticated: false,
                },
            },
        ))
        .unwrap();

        let bundle = {
            let bytes = std::fs::read(&bundle_path).unwrap();
            assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 3);
            let mut file = std::fs::File::open(&bundle_path).unwrap();
            mdbx_sync::read_bundle(&mut file).unwrap()
        };
        assert!(bundle.commits.iter().any(|commit| {
            commit
                .object_payloads
                .iter()
                .any(|payload| payload.object_type == SYNC_STATE_OBJECT_TYPE)
        }));

        let core_target_conn = open_unlocked(&core_target_path);
        let core_result = SyncApplyRepo::apply_batch(
            &core_target_conn,
            &CommitContext::new("core-target-device".to_string()),
            &CommitBatch::new(bundle.commits.clone(), 0, true),
        )
        .unwrap();
        assert_eq!(core_result.conflict_count, 0);

        run(cli(
            &target_path,
            Commands::Sync {
                action: SyncAction::Apply {
                    file: bundle_path.clone(),
                    checkpoint: None,
                },
            },
        ))
        .unwrap();

        let target_conn = open_unlocked(&target_path);
        let mut versioned_operation_count = 0;
        for operation in bundle
            .commits
            .iter()
            .filter_map(|commit| commit.operation.as_ref())
        {
            let applied_request_hash: Vec<u8> = target_conn
                .inner()
                .query_row(
                    "SELECT request_hash FROM commit_operations WHERE operation_id = ?1",
                    params![operation.operation_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(applied_request_hash, operation.request_hash);
            if operation.request_hash.starts_with(b"MDBXORI1") {
                versioned_operation_count += 1;
            }
        }
        assert!(versioned_operation_count > 0);
        let target_projects = ProjectRepo::list_all(&target_conn).unwrap();
        let synced_project = target_projects
            .iter()
            .find(|project| project_title(project) == "Synced Project")
            .unwrap();
        assert_eq!(synced_project.group_id.as_deref(), Some("sync"));

        let target_entries =
            EntryRepo::list_by_project(&target_conn, &synced_project.project_id).unwrap();
        assert_eq!(target_entries.len(), 1);
        assert_eq!(entry_title(&target_entries[0]), "Synced Login");
        let payload: serde_json::Value =
            serde_json::from_slice(&target_entries[0].payload_ct).unwrap();
        assert_eq!(payload["username"], "alice");
        assert_eq!(payload["password"], "synced-secret");

        let core_projects = ProjectRepo::list_all(&core_target_conn).unwrap();
        let core_project = core_projects
            .iter()
            .find(|project| project_title(project) == "Synced Project")
            .unwrap();
        let core_entries =
            EntryRepo::list_by_project(&core_target_conn, &core_project.project_id).unwrap();
        assert_eq!(core_entries.len(), 1);
        assert_eq!(entry_title(&core_entries[0]), "Synced Login");

        let _ = std::fs::remove_file(bundle_path);
    }

    #[test]
    fn cli_authenticated_bundle_requires_matching_vault_integrity_key() {
        let source = TempVault::new();
        let matching_target = TempVault::new();
        let unrelated_target = TempVault::new();
        let source_path = source.path();
        let matching_target_path = matching_target.path();
        let unrelated_target_path = unrelated_target.path();
        let bundle_path = sync_bundle_path();

        run(init_cli(&source_path)).unwrap();
        backup_vault(&source_path, &matching_target_path);
        run(init_cli(&unrelated_target_path)).unwrap();
        run(cli(
            &source_path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Authenticated Sync Project".to_string(),
                    group: Some("authenticated".to_string()),
                },
            },
        ))
        .unwrap();

        run(cli(
            &source_path,
            Commands::Sync {
                action: SyncAction::Bundle {
                    output: bundle_path.clone(),
                    base_checkpoint: None,
                    result_checkpoint: None,
                    compression: BundleCompressionCli::None,
                    authenticated: true,
                },
            },
        ))
        .unwrap();
        let bytes = std::fs::read(&bundle_path).unwrap();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            mdbx_sync::AUTHENTICATED_BUNDLE_VERSION
        );

        run(cli(
            &matching_target_path,
            Commands::Sync {
                action: SyncAction::Apply {
                    file: bundle_path.clone(),
                    checkpoint: None,
                },
            },
        ))
        .unwrap();
        assert_eq!(
            ProjectRepo::list_all(&open_unlocked(&matching_target_path))
                .unwrap()
                .len(),
            1
        );

        let error = run(cli(
            &unrelated_target_path,
            Commands::Sync {
                action: SyncAction::Apply {
                    file: bundle_path.clone(),
                    checkpoint: None,
                },
            },
        ))
        .unwrap_err();
        assert!(error.contains("HMAC-SHA-256 mismatch"));
        assert!(
            ProjectRepo::list_all(&open_unlocked(&unrelated_target_path))
                .unwrap()
                .is_empty()
        );

        let _ = std::fs::remove_file(bundle_path);
    }

    #[test]
    fn incremental_sync_bootstraps_once_then_transfers_only_new_state() {
        let source = TempVault::new();
        let target = TempVault::new();
        let source_path = source.path();
        let target_path = target.path();

        run(init_cli(&source_path)).unwrap();
        let source_conn = open_unlocked(&source_path);
        let base = current_incremental_checkpoint(&source_conn).unwrap();
        drop(source_conn);
        backup_vault(&source_path, &target_path);

        run(cli(
            &source_path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Incremental One".to_string(),
                    group: Some("round-one".to_string()),
                },
            },
        ))
        .unwrap();
        let source_conn = open_unlocked(&source_path);
        let device = cli_device_context();
        TigaService::authorize_operation(
            &source_conn,
            &mdbx_core::tiga::TigaScope::Vault,
            mdbx_core::tiga::TigaOperation::ChangeSecurityPolicy,
            TigaAuthorizationContext {
                session: None,
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap();
        let auxiliary_audit_id = TigaService::list_security_audit_events(&source_conn, 10)
            .unwrap()
            .into_iter()
            .find(|event| event.operation == mdbx_core::tiga::TigaOperation::ChangeSecurityPolicy)
            .unwrap()
            .event_id;
        let first = export_incremental_sync_bundle(&source_conn, &base).unwrap();
        assert!(!first.commits.is_empty());
        assert!(first
            .commits
            .iter()
            .flat_map(|commit| &commit.object_payloads)
            .all(|payload| payload.object_type != SYNC_STATE_OBJECT_TYPE));
        assert!(first
            .manifest
            .delta_inventory
            .iter()
            .any(|delta| delta.batch_kind == IncrementalDeltaKind::Commit));
        assert!(first
            .manifest
            .delta_inventory
            .iter()
            .any(|delta| delta.batch_kind == IncrementalDeltaKind::Auxiliary));
        let first_commit_ids = first
            .commits
            .iter()
            .map(|commit| commit.commit.commit_id.clone())
            .collect::<HashSet<_>>();
        let first_result = first.manifest.result.clone();
        drop(source_conn);

        let mut target_conn = open_unlocked(&target_path);
        let first_apply = apply_incremental_sync_bundle(&mut target_conn, &first, &base).unwrap();
        assert_eq!(first_apply.missing_parent_count, 0);
        assert!(ProjectRepo::list_all(&target_conn)
            .unwrap()
            .iter()
            .any(|project| project_title(project) == "Incremental One"));
        let target_audits = TigaService::list_security_audit_events(&target_conn, 10).unwrap();
        assert!(target_audits
            .iter()
            .any(|event| event.event_id == auxiliary_audit_id));

        run(cli(
            &source_path,
            Commands::Project {
                action: ProjectAction::Create {
                    title: "Incremental Two".to_string(),
                    group: Some("round-two".to_string()),
                },
            },
        ))
        .unwrap();
        let source_conn = open_unlocked(&source_path);
        let second = export_incremental_sync_bundle(&source_conn, &first_result).unwrap();
        assert!(!second.commits.is_empty());
        assert!(second
            .commits
            .iter()
            .all(|commit| !first_commit_ids.contains(&commit.commit.commit_id)));
        drop(source_conn);

        let stale_error =
            apply_incremental_sync_bundle(&mut target_conn, &second, &base).unwrap_err();
        assert!(stale_error.contains("base checkpoint does not match"));
        assert!(!ProjectRepo::list_all(&target_conn)
            .unwrap()
            .iter()
            .any(|project| project_title(project) == "Incremental Two"));

        apply_incremental_sync_bundle(&mut target_conn, &second, &first_result).unwrap();
        assert!(ProjectRepo::list_all(&target_conn)
            .unwrap()
            .iter()
            .any(|project| project_title(project) == "Incremental Two"));
    }

    #[test]
    fn incremental_sync_resumes_bounded_segments_and_retries_invalid_tail_atomically() {
        let source = TempVault::new();
        let target = TempVault::new();
        let source_path = source.path();
        let target_path = target.path();

        run(init_cli(&source_path)).unwrap();
        let source_conn = open_unlocked(&source_path);
        let base = current_incremental_checkpoint(&source_conn).unwrap();
        drop(source_conn);
        backup_vault(&source_path, &target_path);

        for title in ["Segment One", "Segment Two", "Segment Three"] {
            run(cli(
                &source_path,
                Commands::Project {
                    action: ProjectAction::Create {
                        title: title.to_string(),
                        group: Some("segmented".to_string()),
                    },
                },
            ))
            .unwrap();
        }
        let source_conn = open_unlocked(&source_path);
        let device = cli_device_context();
        TigaService::authorize_operation(
            &source_conn,
            &mdbx_core::tiga::TigaScope::Vault,
            mdbx_core::tiga::TigaOperation::ChangeSecurityPolicy,
            TigaAuthorizationContext {
                session: None,
                device: &device,
                now_unix_secs: 2_000,
            },
        )
        .unwrap();
        let audit_id = TigaService::list_security_audit_events(&source_conn, 10).unwrap()[0]
            .event_id
            .clone();

        let first = export_incremental_sync_segment(&source_conn, &base, None).unwrap();
        assert!(!first.manifest.is_last);
        assert_eq!(first.manifest.segment_index, 0);
        let resume = next_cli_sync_resume(&first).unwrap().unwrap();

        let mut target_conn = open_unlocked(&target_path);
        apply_incremental_sync_segment(&mut target_conn, &first, &base, None).unwrap();
        assert_eq!(ProjectRepo::list_all(&target_conn).unwrap().len(), 2);

        let second =
            export_incremental_sync_segment(&source_conn, &first.manifest.result, Some(&resume))
                .unwrap();
        assert!(second.manifest.is_last);
        assert_eq!(second.manifest.segment_index, 1);
        assert_eq!(second.manifest.transfer_id, first.manifest.transfer_id);
        assert_eq!(
            second.manifest.previous_segment_sha256.as_deref(),
            Some(resume.previous_segment_sha256.as_slice())
        );
        drop(source_conn);

        let mut wrong_resume = resume.clone();
        wrong_resume.previous_segment_sha256 = vec![0; 32];
        let chain_error = apply_incremental_sync_segment(
            &mut target_conn,
            &second,
            &first.manifest.result,
            Some(&wrong_resume),
        )
        .unwrap_err();
        assert!(chain_error.contains("does not match the saved transfer resume state"));

        let mut invalid = second.clone();
        invalid.auxiliary_deltas[0].object_type = "unsupported-auxiliary".to_string();
        let invalid_error = apply_incremental_sync_segment(
            &mut target_conn,
            &invalid,
            &first.manifest.result,
            Some(&resume),
        )
        .unwrap_err();
        assert!(invalid_error.contains("unrecognized auxiliary delta payload"));
        assert_eq!(ProjectRepo::list_all(&target_conn).unwrap().len(), 2);

        apply_incremental_sync_segment(
            &mut target_conn,
            &second,
            &first.manifest.result,
            Some(&resume),
        )
        .unwrap();
        assert_eq!(ProjectRepo::list_all(&target_conn).unwrap().len(), 3);
        assert!(TigaService::list_security_audit_events(&target_conn, 10)
            .unwrap()
            .iter()
            .any(|event| event.event_id == audit_id));
        assert!(next_cli_sync_resume(&second).unwrap().is_none());
    }

    #[test]
    fn cli_incremental_checkpoint_advances_only_after_durable_segment_apply() {
        let source = TempVault::new();
        let target = TempVault::new();
        let source_path = source.path();
        let target_path = target.path();
        let first_bundle = sync_bundle_path();
        let tampered_bundle = sync_bundle_path();
        let second_bundle = sync_bundle_path();
        let sender_base =
            std::env::temp_dir().join(format!("mdbx-cli-sync-base-{}.json", uuid::Uuid::new_v4()));
        let sender_first =
            std::env::temp_dir().join(format!("mdbx-cli-sync-first-{}.json", uuid::Uuid::new_v4()));
        let sender_second = std::env::temp_dir().join(format!(
            "mdbx-cli-sync-second-{}.json",
            uuid::Uuid::new_v4()
        ));
        let receiver_checkpoint = std::env::temp_dir().join(format!(
            "mdbx-cli-sync-receiver-{}.json",
            uuid::Uuid::new_v4()
        ));

        run(init_cli(&source_path)).unwrap();
        let source_conn = open_unlocked(&source_path);
        let vault_id = vault_id(&source_conn).unwrap();
        let base = current_incremental_checkpoint(&source_conn).unwrap();
        drop(source_conn);
        backup_vault(&source_path, &target_path);
        write_cli_sync_checkpoint(&sender_base, &vault_id, &base, None).unwrap();
        write_cli_sync_checkpoint(&receiver_checkpoint, &vault_id, &base, None).unwrap();
        let first_compression = if cfg!(feature = "sync-compression") {
            BundleCompressionCli::Zstd
        } else {
            BundleCompressionCli::None
        };

        for title in ["Checkpoint One", "Checkpoint Two", "Checkpoint Three"] {
            run(cli(
                &source_path,
                Commands::Project {
                    action: ProjectAction::Create {
                        title: title.to_string(),
                        group: Some("checkpoint".to_string()),
                    },
                },
            ))
            .unwrap();
        }
        run(cli(
            &source_path,
            Commands::Sync {
                action: SyncAction::Bundle {
                    output: first_bundle.clone(),
                    base_checkpoint: Some(sender_base.clone()),
                    result_checkpoint: Some(sender_first.clone()),
                    compression: first_compression,
                    authenticated: true,
                },
            },
        ))
        .unwrap();
        let first_bundle_bytes = std::fs::read(&first_bundle).unwrap();
        assert_eq!(
            u32::from_le_bytes(first_bundle_bytes[8..12].try_into().unwrap()),
            if cfg!(feature = "sync-compression") {
                mdbx_sync::AUTHENTICATED_COMPRESSED_INCREMENTAL_BUNDLE_VERSION
            } else {
                mdbx_sync::AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION
            }
        );
        let first_result = read_cli_sync_checkpoint(&sender_first, &vault_id).unwrap();
        assert!(first_result.resume.is_some());

        let mut tampered_bytes = std::fs::read(&first_bundle).unwrap();
        let last = tampered_bytes.len() - 1;
        tampered_bytes[last] ^= 1;
        std::fs::write(&tampered_bundle, tampered_bytes).unwrap();
        let error = run(cli(
            &target_path,
            Commands::Sync {
                action: SyncAction::Apply {
                    file: tampered_bundle.clone(),
                    checkpoint: Some(receiver_checkpoint.clone()),
                },
            },
        ))
        .unwrap_err();
        assert!(error.contains("bundle read failed"));
        let unchanged = read_cli_sync_checkpoint(&receiver_checkpoint, &vault_id).unwrap();
        assert_eq!(unchanged.checkpoint, base);
        assert!(unchanged.resume.is_none());
        let target_conn = open_unlocked(&target_path);
        assert!(ProjectRepo::list_all(&target_conn).unwrap().is_empty());
        drop(target_conn);

        run(cli(
            &target_path,
            Commands::Sync {
                action: SyncAction::Apply {
                    file: first_bundle.clone(),
                    checkpoint: Some(receiver_checkpoint.clone()),
                },
            },
        ))
        .unwrap();
        let receiver_first = read_cli_sync_checkpoint(&receiver_checkpoint, &vault_id).unwrap();
        assert_eq!(receiver_first.checkpoint, first_result.checkpoint);
        assert_eq!(receiver_first.resume, first_result.resume);

        run(cli(
            &source_path,
            Commands::Sync {
                action: SyncAction::Bundle {
                    output: second_bundle.clone(),
                    base_checkpoint: Some(sender_first.clone()),
                    result_checkpoint: Some(sender_second.clone()),
                    compression: BundleCompressionCli::None,
                    authenticated: true,
                },
            },
        ))
        .unwrap();
        let second_bundle_bytes = std::fs::read(&second_bundle).unwrap();
        assert_eq!(
            u32::from_le_bytes(second_bundle_bytes[8..12].try_into().unwrap()),
            mdbx_sync::AUTHENTICATED_INCREMENTAL_BUNDLE_VERSION
        );
        run(cli(
            &target_path,
            Commands::Sync {
                action: SyncAction::Apply {
                    file: second_bundle.clone(),
                    checkpoint: Some(receiver_checkpoint.clone()),
                },
            },
        ))
        .unwrap();
        let sender_done = read_cli_sync_checkpoint(&sender_second, &vault_id).unwrap();
        let receiver_done = read_cli_sync_checkpoint(&receiver_checkpoint, &vault_id).unwrap();
        assert_eq!(receiver_done.checkpoint, sender_done.checkpoint);
        assert!(receiver_done.resume.is_none());
        assert_eq!(
            ProjectRepo::list_all(&open_unlocked(&target_path))
                .unwrap()
                .len(),
            3
        );

        for path in [
            first_bundle,
            tampered_bundle,
            second_bundle,
            sender_base,
            sender_first,
            sender_second,
            receiver_checkpoint,
        ] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn cli_rejects_configured_vault_without_unlock() {
        let vault = TempVault::new();
        let path = vault.path();
        run(init_cli(&path)).unwrap();

        let result = run(locked_cli(
            &path,
            Commands::Project {
                action: ProjectAction::List,
            },
        ));

        assert!(result
            .unwrap_err()
            .contains("pass --unlock-password or --unlock-pin"));
    }

    #[test]
    fn sync_bundle_cli_defaults_to_legacy_and_accepts_authenticated_zstd() {
        let default = Cli::try_parse_from(["mdbx", "sync", "bundle"]).unwrap();
        let Commands::Sync {
            action:
                SyncAction::Bundle {
                    compression,
                    authenticated,
                    ..
                },
        } = default.command
        else {
            panic!("sync bundle command was not parsed");
        };
        assert_eq!(compression, BundleCompressionCli::None);
        assert!(!authenticated);

        let compressed = Cli::try_parse_from([
            "mdbx",
            "sync",
            "bundle",
            "--compression",
            "zstd",
            "--authenticated",
        ])
        .unwrap();
        let Commands::Sync {
            action:
                SyncAction::Bundle {
                    compression,
                    authenticated,
                    ..
                },
        } = compressed.command
        else {
            panic!("compressed sync bundle command was not parsed");
        };
        assert_eq!(compression, BundleCompressionCli::Zstd);
        assert!(authenticated);
    }

    #[cfg(not(feature = "sync-compression"))]
    #[test]
    fn trimmed_cli_reports_zstd_as_unavailable() {
        let error = resolve_bundle_compression(BundleCompressionCli::Zstd).unwrap_err();
        assert!(error.contains("unavailable in this build"));
    }

    #[cfg(feature = "benchmark")]
    #[test]
    fn benchmark_cli_defaults_to_encrypted_and_accepts_compatibility() {
        let default = Cli::try_parse_from(["mdbx", "benchmark", "--iterations", "1"]).unwrap();
        let Commands::Benchmark { mode, .. } = default.command else {
            panic!("benchmark command was not parsed");
        };
        assert_eq!(mode, BenchmarkCliMode::Encrypted);

        let compatibility = Cli::try_parse_from([
            "mdbx",
            "benchmark",
            "--iterations",
            "1",
            "--mode",
            "compatibility",
        ])
        .unwrap();
        let Commands::Benchmark { mode, .. } = compatibility.command else {
            panic!("benchmark command was not parsed");
        };
        assert_eq!(mode, BenchmarkCliMode::Compatibility);
    }

    #[cfg(feature = "benchmark")]
    #[test]
    fn cli_exposes_health_and_benchmark() {
        let vault = TempVault::new();
        let path = vault.path();
        let report_path = path.with_extension("benchmark.json");
        run(init_cli(&path)).unwrap();

        run(cli(&path, Commands::Health)).unwrap();
        run(cli(
            &path,
            Commands::Benchmark {
                iterations: 1,
                mode: BenchmarkCliMode::Encrypted,
                json: false,
                output: Some(report_path.clone()),
            },
        ))
        .unwrap();
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&report_path).unwrap()).unwrap();
        assert_eq!(report["format"], "mdbx-benchmark-report-v1");
        assert_eq!(report["metadata"]["iterations"], 1);
        assert_eq!(report["metadata"]["storage_mode"], "encrypted");
        assert_eq!(report["metadata"]["field_encryption"], true);
        assert_eq!(report["results"].as_array().unwrap().len(), 11);
        std::fs::remove_file(report_path).unwrap();
    }

    #[cfg(all(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
    #[test]
    fn kdbx_binary_cli_roundtrips_and_fails_before_mutation_or_replacement() {
        let parsed =
            Cli::try_parse_from(["mdbx", "import-kdbx", "input.kdbx", "--password-stdin"]).unwrap();
        assert!(matches!(
            parsed.command,
            Commands::ImportKdbx {
                password_stdin: true,
                ..
            }
        ));

        let files = tempfile::tempdir().unwrap();
        let kdbx = files.path().join("vault.kdbx");
        let malformed = files.path().join("malformed.kdbx");
        std::fs::write(&malformed, b"not a KDBX database").unwrap();

        let source = TempVault::new();
        let source_path = source.path();
        run(init_cli(&source_path)).unwrap();
        let source_conn = open_unlocked(&source_path);
        let imported = KdbxImporter::import_entries(
            &source_conn,
            &ctx(),
            &[KdbxEntry {
                uuid: "64bf8267-f3df-40c2-b895-8408e59fd9c2".to_string(),
                title: "Binary Mail".to_string(),
                username: "alice@example.com".to_string(),
                password: "mail-secret".to_string(),
                url: "https://mail.example.com".to_string(),
                notes: "binary note".to_string(),
                totp_seed: Some("JBSWY3DPEHPK3PXP".to_string()),
                custom_fields: vec![("account-id".to_string(), "42".to_string())],
                attachments: vec![mdbx_storage::import::KdbxAttachment {
                    name: "message.eml".to_string(),
                    data: b"From: alice@example.com\r\n\r\nHello".to_vec(),
                }],
                group_path: vec!["Mail".to_string(), "Archive".to_string()],
                icon_id: Some(19),
                created_at: "2026-07-23T00:00:00Z".to_string(),
                updated_at: "2026-07-23T00:01:00Z".to_string(),
            }],
        );
        assert_eq!(imported.projects_created, 1);
        assert_eq!(imported.attachments_created, 1);

        export_kdbx_with_password(&source_conn, kdbx.clone(), "binary-password").unwrap();
        let encrypted = std::fs::read(&kdbx).unwrap();
        assert_eq!(&encrypted[..4], &[0x03, 0xd9, 0xa2, 0x9a]);

        let no_clobber_error =
            export_kdbx_with_password(&source_conn, kdbx.clone(), "binary-password").unwrap_err();
        assert!(no_clobber_error.contains("without replacing"));
        assert_eq!(std::fs::read(&kdbx).unwrap(), encrypted);

        let destination = TempVault::new();
        let destination_path = destination.path();
        run(init_cli(&destination_path)).unwrap();
        let mut destination_conn = open_unlocked(&destination_path);
        let before_import_commits: i64 = destination_conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let wrong_password =
            import_kdbx_with_password(&mut destination_conn, kdbx.clone(), "wrong-password")
                .unwrap_err();
        assert!(wrong_password.contains("failed to decode KDBX"));
        assert!(ProjectRepo::list_all(&destination_conn).unwrap().is_empty());
        let after_wrong_password: i64 = destination_conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_wrong_password, before_import_commits);

        let malformed_error =
            import_kdbx_with_password(&mut destination_conn, malformed, "binary-password")
                .unwrap_err();
        assert!(malformed_error.contains("failed to decode KDBX"));
        assert!(ProjectRepo::list_all(&destination_conn).unwrap().is_empty());
        let after_malformed: i64 = destination_conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_malformed, before_import_commits);

        import_kdbx_with_password(&mut destination_conn, kdbx, "binary-password").unwrap();
        let after_import_commits: i64 = destination_conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_import_commits, before_import_commits + 1);
        let projects = ProjectRepo::list_all(&destination_conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(project_title(&projects[0]), "Binary Mail");
        assert_eq!(projects[0].group_id.as_deref(), Some("Mail/Archive"));
        let attachments =
            AttachmentRepo::list_by_project(&destination_conn, &projects[0].project_id).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(
            AttachmentRepo::read_content(&destination_conn, &attachments[0].attachment_id).unwrap(),
            b"From: alice@example.com\r\n\r\nHello"
        );
    }

    #[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
    #[test]
    fn kdbx_binary_password_stdin_is_single_line_and_bounded() {
        let password = read_kdbx_password_from(&mut b"correct horse\r\n".as_slice()).unwrap();
        assert_eq!(password.as_str(), "correct horse");

        let multiple = read_kdbx_password_from(&mut b"first\nsecond\n".as_slice()).unwrap_err();
        assert!(multiple.contains("exactly one line"));

        let oversized = vec![b'x'; MAX_KDBX_PASSWORD_BYTES + 1];
        let error = read_kdbx_password_from(&mut oversized.as_slice()).unwrap_err();
        assert!(error.contains("exceeds"));
    }

    #[cfg(all(feature = "kdbx-import", feature = "kdbx-export"))]
    #[test]
    fn cli_can_import_and_export_kdbx_json() {
        let vault = TempVault::new();
        let path = vault.path();
        let import_path =
            std::env::temp_dir().join(format!("mdbx-cli-import-{}.json", uuid::Uuid::new_v4()));
        let export_path =
            std::env::temp_dir().join(format!("mdbx-cli-export-{}.json", uuid::Uuid::new_v4()));

        run(init_cli(&path)).unwrap();

        let entries = vec![KdbxEntry {
            uuid: "kdbx-entry-1".to_string(),
            title: "Imported Login".to_string(),
            username: "alice".to_string(),
            password: "secret".to_string(),
            url: "https://example.com".to_string(),
            notes: "imported note".to_string(),
            totp_seed: Some("totp-seed".to_string()),
            custom_fields: vec![("env".to_string(), "prod".to_string())],
            attachments: vec![],
            group_path: vec!["Work".to_string(), "Infra".to_string()],
            icon_id: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }];
        std::fs::write(&import_path, serde_json::to_vec(&entries).unwrap()).unwrap();

        let before_import_commits = {
            let conn = open_unlocked(&path);
            conn.inner()
                .query_row("SELECT COUNT(*) FROM commits", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };

        run(cli(
            &path,
            Commands::ImportKdbxJson {
                file: import_path.clone(),
            },
        ))
        .unwrap();

        let conn = open_unlocked(&path);
        let after_import_commits: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after_import_commits, before_import_commits + 1);
        let projects = ProjectRepo::list_all(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(project_title(&projects[0]), "Imported Login");
        drop(conn);

        run(cli(
            &path,
            Commands::ExportKdbxJson {
                output: export_path.clone(),
            },
        ))
        .unwrap();

        let exported: Vec<KdbxEntry> =
            serde_json::from_slice(&std::fs::read(&export_path).unwrap()).unwrap();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].title, "Imported Login");
        assert_eq!(exported[0].username, "alice");
        assert_eq!(exported[0].password, "secret");
        assert_eq!(exported[0].group_path, vec!["Work", "Infra"]);

        let _ = std::fs::remove_file(import_path);
        let _ = std::fs::remove_file(export_path);
    }
}
