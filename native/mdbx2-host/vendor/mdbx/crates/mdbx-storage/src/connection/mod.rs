use rusqlite::{Connection, OpenFlags};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use mdbx_core::model::{ExtensionCapabilityId, ExtensionId, ExtensionProfile, VaultSession};
use mdbx_crypto::keyring::Keyring;

use crate::error::{StorageError, StorageResult};
use crate::extension_registry::{ExtensionRegistration, ExtensionRegistry};
use crate::schema;

/// 打开的 vault 数据库连接。
///
/// 在打开时自动设置必要的 PRAGMA：
/// - WAL 模式（增量写入友好）
/// - foreign_keys 强制
/// - secure_delete 启用
/// - busy_timeout 5 秒
///
/// 解锁后可附加 Keyring 以启用字段级加密。
pub struct VaultConnection {
    pub(crate) conn: Connection,
    #[cfg(feature = "filesystem-blob-store")]
    path: Option<PathBuf>,
    pub(crate) keyring: Option<Keyring>,
    pub(crate) active_key_epoch_id: Option<String>,
    pub(crate) epoch_keyrings: HashMap<String, Keyring>,
    pub(crate) active_session: Option<VaultSession>,
    pub(crate) extension_capabilities: BTreeSet<ExtensionCapabilityId>,
    pub(crate) extension_registry: ExtensionRegistry,
}

/// Payload-free counts used by diagnostics clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultDiagnosticsCounts {
    pub commit_count: u64,
    pub tombstone_count: u64,
    pub branch_count: u64,
    pub device_count: u64,
    pub snapshot_count: u64,
    pub unresolved_conflict_count: u64,
    pub project_count: u64,
    pub deleted_project_count: u64,
    pub entry_count: u64,
    pub deleted_entry_count: u64,
    pub attachment_count: u64,
    pub deleted_attachment_count: u64,
    pub external_attachment_count: u64,
    pub original_attachment_bytes: u64,
    pub stored_attachment_bytes: u64,
}

/// A newly reserved vault file that is removed unless creation is committed.
///
/// Production callers keep this guard alive while initializing metadata and
/// configuring the first unlock method. Any early return drops the connection
/// before removing the database and its SQLite sidecars.
pub struct PendingVaultCreation {
    path: PathBuf,
    connection: Option<VaultConnection>,
    committed: bool,
}

impl PendingVaultCreation {
    pub fn begin(path: &Path) -> StorageResult<Self> {
        Ok(Self {
            path: path.to_path_buf(),
            connection: Some(VaultConnection::create(path)?),
            committed: false,
        })
    }

    pub fn connection(&self) -> &VaultConnection {
        self.connection
            .as_ref()
            .expect("pending vault connection must exist before commit")
    }

    pub fn connection_mut(&mut self) -> &mut VaultConnection {
        self.connection
            .as_mut()
            .expect("pending vault connection must exist before commit")
    }

    pub fn commit(mut self) -> VaultConnection {
        self.committed = true;
        self.connection
            .take()
            .expect("pending vault connection must exist before commit")
    }
}

impl Drop for PendingVaultCreation {
    fn drop(&mut self) {
        self.connection.take();
        if !self.committed {
            remove_vault_files(&self.path);
        }
    }
}

impl VaultConnection {
    /// 打开已有的 `.mdbx` 文件。
    pub fn open(path: &Path) -> StorageResult<Self> {
        crate::migration::preflight_existing_vault(path)?;
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        Self::apply_connection_pragmas(&conn)?;
        crate::migration::upgrade_to_latest(&conn)?;
        Self::apply_persistent_pragmas(&conn)?;
        Self::cleanup_legacy_persistent_fts(&conn)?;
        Ok(Self {
            conn,
            #[cfg(feature = "filesystem-blob-store")]
            path: Some(path.to_path_buf()),
            keyring: None,
            active_key_epoch_id: None,
            epoch_keyrings: HashMap::new(),
            active_session: None,
            extension_capabilities: BTreeSet::new(),
            extension_registry: ExtensionRegistry::default(),
        })
    }

    /// 创建新的 `.mdbx` 文件。
    ///
    /// 文件路径必须尚不存在。生产入口应通过 `PendingVaultCreation`
    /// 完成初始化与首个解锁方法配置，使后续步骤失败时可以清理新文件。
    pub fn create(path: &Path) -> StorageResult<Self> {
        ensure_sidecars_absent(path)?;
        OpenOptions::new().write(true).create_new(true).open(path)?;

        let result = (|| {
            let conn = Connection::open(path)?;
            Self::apply_connection_pragmas(&conn)?;
            Self::apply_persistent_pragmas(&conn)?;
            schema::create_all_tables(&conn)?;
            Self::cleanup_legacy_persistent_fts(&conn)?;
            Ok(Self {
                conn,
                #[cfg(feature = "filesystem-blob-store")]
                path: Some(path.to_path_buf()),
                keyring: None,
                active_key_epoch_id: None,
                epoch_keyrings: HashMap::new(),
                active_session: None,
                extension_capabilities: BTreeSet::new(),
                extension_registry: ExtensionRegistry::default(),
            })
        })();
        if result.is_err() {
            remove_vault_files(path);
        }
        result
    }

    /// 打开内存数据库（用于测试）。
    pub fn open_in_memory() -> StorageResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::apply_connection_pragmas(&conn)?;
        Self::apply_persistent_pragmas(&conn)?;
        schema::create_all_tables(&conn)?;
        Self::cleanup_legacy_persistent_fts(&conn)?;
        Ok(Self {
            conn,
            #[cfg(feature = "filesystem-blob-store")]
            path: None,
            keyring: None,
            active_key_epoch_id: None,
            epoch_keyrings: HashMap::new(),
            active_session: None,
            extension_capabilities: BTreeSet::new(),
            extension_registry: ExtensionRegistry::default(),
        })
    }

    fn apply_connection_pragmas(conn: &Connection) -> StorageResult<()> {
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(StorageError::Database)
    }

    fn apply_persistent_pragmas(conn: &Connection) -> StorageResult<()> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA secure_delete=ON;",
        )
        .map_err(StorageError::Database)
    }

    fn cleanup_legacy_persistent_fts(conn: &Connection) -> StorageResult<()> {
        conn.execute_batch("DROP TABLE IF EXISTS main.project_titles_fts;")
            .map_err(StorageError::Database)
    }

    /// 获取内部 rusqlite 连接的引用。
    pub fn inner(&self) -> &Connection {
        &self.conn
    }

    /// Return the stable vault identity owned by the storage layer.
    pub fn vault_id(&self) -> StorageResult<String> {
        self.conn
            .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .map_err(StorageError::Database)
    }

    /// Resolve the external encrypted Blob store without exposing SQLite
    /// `PRAGMA database_list` to a facade.
    #[cfg(feature = "filesystem-blob-store")]
    pub fn external_blob_store(&self) -> StorageResult<crate::blob_store::FileSystemBlobStore> {
        let path = self.path.as_ref().ok_or_else(|| {
            StorageError::Validation(
                "external attachment storage requires a file-backed vault".to_string(),
            )
        })?;
        Ok(crate::blob_store::FileSystemBlobStore::new(format!(
            "{}.blobs",
            path.display()
        )))
    }

    /// Read payload-free aggregate counts through the storage-owned query
    /// boundary. No ciphertext or attachment body is selected.
    pub fn diagnostics_summary(&self) -> StorageResult<VaultDiagnosticsCounts> {
        let values = self
            .conn
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM commits),
                    (SELECT COUNT(*) FROM tombstones),
                    (SELECT COUNT(*) FROM branches),
                    (SELECT COUNT(*) FROM device_heads),
                    (SELECT COUNT(*) FROM snapshots),
                    (SELECT COUNT(*) FROM conflicts WHERE resolution = 'unresolved'),
                    (SELECT COUNT(*) FROM projects WHERE deleted = 0),
                    (SELECT COUNT(*) FROM projects WHERE deleted <> 0),
                    (SELECT COUNT(*) FROM entries WHERE deleted = 0),
                    (SELECT COUNT(*) FROM entries WHERE deleted <> 0),
                    (SELECT COUNT(*) FROM attachments WHERE deleted = 0),
                    (SELECT COUNT(*) FROM attachments WHERE deleted <> 0),
                    (SELECT COUNT(*) FROM attachments
                        WHERE deleted = 0 AND storage_mode = 'external-hash-ref'),
                    (SELECT COALESCE(SUM(original_size), 0) FROM attachments WHERE deleted = 0),
                    (SELECT COALESCE(SUM(stored_size), 0) FROM attachments WHERE deleted = 0)",
                [],
                |row| {
                    Ok([
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, i64>(11)?,
                        row.get::<_, i64>(12)?,
                        row.get::<_, i64>(13)?,
                        row.get::<_, i64>(14)?,
                    ])
                },
            )
            .map_err(StorageError::Database)?;
        let mut values = values.into_iter().map(|value| {
            u64::try_from(value).map_err(|_| {
                StorageError::Validation("diagnostic count cannot be negative".to_string())
            })
        });
        Ok(VaultDiagnosticsCounts {
            commit_count: values.next().unwrap()?,
            tombstone_count: values.next().unwrap()?,
            branch_count: values.next().unwrap()?,
            device_count: values.next().unwrap()?,
            snapshot_count: values.next().unwrap()?,
            unresolved_conflict_count: values.next().unwrap()?,
            project_count: values.next().unwrap()?,
            deleted_project_count: values.next().unwrap()?,
            entry_count: values.next().unwrap()?,
            deleted_entry_count: values.next().unwrap()?,
            attachment_count: values.next().unwrap()?,
            deleted_attachment_count: values.next().unwrap()?,
            external_attachment_count: values.next().unwrap()?,
            original_attachment_bytes: values.next().unwrap()?,
            stored_attachment_bytes: values.next().unwrap()?,
        })
    }

    /// Run a storage mutation atomically.
    ///
    /// This uses a manual transaction because repositories share an immutable
    /// connection handle. If the caller is already inside a transaction, the
    /// closure is executed in that existing transaction.
    pub(crate) fn with_immediate_transaction<T>(
        &self,
        f: impl FnOnce() -> StorageResult<T>,
    ) -> StorageResult<T> {
        self.with_immediate_transaction_and_sync_limits(
            crate::sync_delta::SyncDeltaLimits::default(),
            f,
        )
    }

    pub(crate) fn with_immediate_transaction_and_sync_limits<T>(
        &self,
        sync_limits: crate::sync_delta::SyncDeltaLimits,
        f: impl FnOnce() -> StorageResult<T>,
    ) -> StorageResult<T> {
        if !self.conn.is_autocommit() {
            return f();
        }

        self.conn
            .execute_batch("BEGIN IMMEDIATE TRANSACTION;")
            .map_err(StorageError::Database)?;

        match f() {
            Ok(value) => {
                if let Err(error) =
                    crate::sync_delta::materialize_pending_sync_delta(self, sync_limits)
                {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    return Err(error);
                }
                if let Err(e) = self.conn.execute_batch("COMMIT;") {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    Err(StorageError::Database(e))
                } else {
                    Ok(value)
                }
            }
            Err(err) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    }

    /// Run a group of reads against one SQLite snapshot.
    pub(crate) fn with_read_transaction<T>(
        &self,
        f: impl FnOnce() -> StorageResult<T>,
    ) -> StorageResult<T> {
        if !self.conn.is_autocommit() {
            return f();
        }

        self.conn
            .execute_batch("BEGIN DEFERRED TRANSACTION;")
            .map_err(StorageError::Database)?;
        match f() {
            Ok(value) => {
                if let Err(error) = self.conn.execute_batch("COMMIT;") {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    Err(StorageError::Database(error))
                } else {
                    Ok(value)
                }
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    pub(crate) fn with_immediate_transaction_mut<T>(
        &mut self,
        f: impl FnOnce(&mut Self) -> StorageResult<T>,
    ) -> StorageResult<T> {
        if !self.conn.is_autocommit() {
            return f(self);
        }

        self.conn
            .execute_batch("BEGIN IMMEDIATE TRANSACTION;")
            .map_err(StorageError::Database)?;
        match f(self) {
            Ok(value) => {
                if let Err(error) = crate::sync_delta::materialize_pending_sync_delta(
                    self,
                    crate::sync_delta::SyncDeltaLimits::default(),
                ) {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    return Err(error);
                }
                if let Err(error) = self.conn.execute_batch("COMMIT;") {
                    let _ = self.conn.execute_batch("ROLLBACK;");
                    Err(StorageError::Database(error))
                } else {
                    Ok(value)
                }
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(error)
            }
        }
    }

    /// 附加密钥环，启用字段级加密。
    ///
    /// 在解锁成功后调用。此后所有 `_ct` 字段在写入时加密、读取时解密。
    pub fn attach_keyring(&mut self, keyring: Keyring) {
        self.keyring = Some(keyring);
        self.active_key_epoch_id = None;
        self.epoch_keyrings.clear();
    }

    pub(crate) fn attach_verified_keyring(
        &mut self,
        keyring: Keyring,
        active_key_epoch_id: String,
        epoch_keyrings: HashMap<String, Keyring>,
    ) {
        self.keyring = Some(keyring);
        self.active_key_epoch_id = Some(active_key_epoch_id);
        self.epoch_keyrings = epoch_keyrings;
    }

    pub fn attach_session(&mut self, session: VaultSession) {
        self.active_session = Some(session);
    }

    pub fn active_session(&self) -> Option<&VaultSession> {
        self.active_session.as_ref()
    }

    /// Replaces the domain Adapter capabilities available to this connection.
    ///
    /// Capabilities describe code present in the current client. They are not
    /// persisted in the vault and do not grant access to encryption keys.
    pub fn set_extension_capabilities<I>(&mut self, capabilities: I)
    where
        I: IntoIterator<Item = ExtensionCapabilityId>,
    {
        self.extension_capabilities = capabilities.into_iter().collect();
    }

    pub fn extension_capabilities(&self) -> &BTreeSet<ExtensionCapabilityId> {
        &self.extension_capabilities
    }

    pub fn register_extension_profile(
        &mut self,
        profile: ExtensionProfile,
    ) -> StorageResult<ExtensionRegistration> {
        self.extension_registry.register(profile)
    }

    pub fn replace_extension_profiles<I>(&mut self, profiles: I) -> StorageResult<()>
    where
        I: IntoIterator<Item = ExtensionProfile>,
    {
        self.extension_registry.replace_all(profiles)
    }

    pub fn unregister_extension_profile(
        &mut self,
        extension_id: &ExtensionId,
    ) -> Option<ExtensionProfile> {
        self.extension_registry.unregister(extension_id)
    }

    pub fn extension_profile(&self, extension_id: &ExtensionId) -> Option<&ExtensionProfile> {
        self.extension_registry.get(extension_id)
    }

    pub fn extension_profiles(&self) -> Vec<ExtensionProfile> {
        self.extension_registry.list()
    }

    pub fn extension_registry(&self) -> &ExtensionRegistry {
        &self.extension_registry
    }

    pub(crate) fn touch_active_session(&mut self, now_unix_secs: i64) {
        if let Some(session) = self.active_session.as_mut() {
            session.assurance = session.assurance.touched(now_unix_secs);
        }
    }

    pub fn clear_session(&mut self) {
        self.active_session = None;
        self.keyring = None;
        self.active_key_epoch_id = None;
        self.epoch_keyrings.clear();
    }

    /// 获取密钥环的引用（存在时）。
    pub fn keyring(&self) -> Option<&Keyring> {
        self.keyring.as_ref()
    }

    /// 返回经过解锁流程认证的 active key epoch 身份。
    pub fn active_key_epoch_id(&self) -> Option<&str> {
        self.active_key_epoch_id.as_deref()
    }

    pub(crate) fn keyring_for_epoch(&self, key_epoch_id: &str) -> Option<&Keyring> {
        self.epoch_keyrings.get(key_epoch_id)
    }

    pub(crate) fn ensure_critical_extension(&self, extension: &str) -> StorageResult<()> {
        let current: String = self
            .conn
            .query_row(
                "SELECT critical_extensions FROM vault_meta LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::Database)?;
        let merged = crate::migration::merge_critical_extension(&current, extension)?;
        if merged != current {
            self.conn
                .execute(
                    "UPDATE vault_meta SET critical_extensions = ?1, updated_at = ?2",
                    rusqlite::params![merged, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(StorageError::Database)?;
            crate::vault_header_integrity::refresh_after_mutation(self)?;
        }
        Ok(())
    }

    /// 当前连接是否已启用加密。
    pub fn is_encrypted(&self) -> bool {
        self.keyring.is_some()
    }
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn ensure_sidecars_absent(path: &Path) -> StorageResult<()> {
    for suffix in ["-wal", "-shm"] {
        let sidecar = sqlite_sidecar_path(path, suffix);
        match fs::symlink_metadata(&sidecar) {
            Ok(_) => {
                return Err(StorageError::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("SQLite sidecar already exists: {}", sidecar.display()),
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(StorageError::Io(error)),
        }
    }
    Ok(())
}

fn remove_vault_files(path: &Path) {
    let _ = fs::remove_file(sqlite_sidecar_path(path, "-wal"));
    let _ = fs::remove_file(sqlite_sidecar_path(path, "-shm"));
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use mdbx_core::model::{CollectionTypeId, ExtensionFeatureId, ObjectTypeId, RelationKindId};
    use uuid::Uuid;

    fn temp_db_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("mdbx-{label}-{}.db", Uuid::new_v4()))
    }

    fn create_legacy_fts_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        crate::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO vault_meta
                (vault_id, format_version, created_at, updated_at,
                 default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('legacy-fts-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '');
             CREATE VIRTUAL TABLE main.project_titles_fts USING fts5(
                project_id UNINDEXED,
                title,
                tokenize='unicode61 remove_diacritics 2'
             );
             INSERT INTO main.project_titles_fts (project_id, title)
             VALUES ('project-1', 'plaintext legacy title');",
        )
        .unwrap();
    }

    fn persistent_fts_exists(conn: &Connection) -> bool {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'project_titles_fts'
             )",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap()
    }

    fn test_extension_profile() -> ExtensionProfile {
        ExtensionProfile {
            extension_id: ExtensionId::new("com.monica.mail").unwrap(),
            profile_version: 1,
            collection_type_ids: vec![CollectionTypeId::new("com.monica.mail").unwrap()],
            object_type_ids: vec![ObjectTypeId::custom("com.monica.mail.message").unwrap()],
            relation_kind_ids: vec![RelationKindId::new("com.monica.mail.reply-to").unwrap()],
            capability_ids: vec![ExtensionCapabilityId::new("com.monica.mail.store").unwrap()],
            optional_index_ids: vec![
                ExtensionFeatureId::new("com.monica.mail.index.messages").unwrap()
            ],
            import_adapter_ids: Vec::new(),
            export_adapter_ids: Vec::new(),
            presentation_hint_ids: Vec::new(),
        }
    }

    #[test]
    fn open_removes_legacy_persistent_fts() {
        let path = temp_db_path("open-legacy-fts");
        create_legacy_fts_db(&path);

        let conn = VaultConnection::open(&path).unwrap();
        assert!(!persistent_fts_exists(conn.inner()));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn create_rejects_existing_legacy_fts_database_without_modifying_it() {
        let path = temp_db_path("create-legacy-fts");
        create_legacy_fts_db(&path);

        let error = VaultConnection::create(&path).err().unwrap();
        let existing = Connection::open(&path).unwrap();

        assert!(matches!(error, StorageError::Io(_)));
        assert!(persistent_fts_exists(&existing));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn open_in_memory_does_not_create_persistent_fts() {
        let conn = VaultConnection::open_in_memory().unwrap();
        assert!(!persistent_fts_exists(conn.inner()));
    }

    #[test]
    fn create_rejects_existing_file_without_modifying_it() {
        let path = temp_db_path("existing-file");
        let original = b"existing non-mdbx data";
        fs::write(&path, original).unwrap();

        let error = VaultConnection::create(&path).err().unwrap();

        assert!(matches!(error, StorageError::Io(_)));
        assert_eq!(fs::read(&path).unwrap(), original);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn create_rejects_preexisting_sidecars_without_modifying_them() {
        let path = temp_db_path("existing-sidecars");
        let wal = sqlite_sidecar_path(&path, "-wal");
        let shm = sqlite_sidecar_path(&path, "-shm");
        fs::write(&wal, b"existing wal data").unwrap();
        fs::write(&shm, b"existing shm data").unwrap();

        let error = VaultConnection::create(&path).err().unwrap();

        assert!(matches!(error, StorageError::Io(_)));
        assert!(!path.exists());
        assert_eq!(fs::read(&wal).unwrap(), b"existing wal data");
        assert_eq!(fs::read(&shm).unwrap(), b"existing shm data");
        let _ = fs::remove_file(wal);
        let _ = fs::remove_file(shm);
    }

    #[test]
    fn open_missing_path_does_not_create_a_file() {
        let path = temp_db_path("missing-open");

        let result = VaultConnection::open(&path);

        assert!(result.is_err());
        assert!(!path.exists());
    }

    #[test]
    fn open_rejects_non_mdbx_sqlite_without_modifying_it() {
        let path = temp_db_path("non-mdbx-open");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE unrelated_data (value TEXT NOT NULL);
                 INSERT INTO unrelated_data VALUES ('preserve-me');",
            )
            .unwrap();
        }
        let before = fs::read(&path).unwrap();

        let result = VaultConnection::open(&path);

        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn open_rejects_unknown_critical_extensions_before_writable_open() {
        let path = temp_db_path("unknown-critical-open");
        let creation = PendingVaultCreation::begin(&path).unwrap();
        initialize_vault(creation.connection(), &VaultInitParams::default()).unwrap();
        let connection = creation.commit();
        connection
            .inner()
            .execute(
                "UPDATE vault_meta SET critical_extensions = 'future-critical'",
                [],
            )
            .unwrap();
        connection
            .inner()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();

        let error = VaultConnection::open(&path).err().unwrap();

        assert!(error.to_string().contains("critical extensions"));
        assert_eq!(fs::read(&path).unwrap(), before);
        remove_vault_files(&path);
    }

    #[test]
    fn abandoned_pending_creation_removes_database_and_sidecars() {
        let path = temp_db_path("abandoned-creation");
        {
            let creation = PendingVaultCreation::begin(&path).unwrap();
            initialize_vault(creation.connection(), &VaultInitParams::default()).unwrap();
            assert!(path.exists());
        }

        assert!(!path.exists());
        assert!(!sqlite_sidecar_path(&path, "-wal").exists());
        assert!(!sqlite_sidecar_path(&path, "-shm").exists());
    }

    #[test]
    fn committed_pending_creation_remains_reopenable() {
        let path = temp_db_path("committed-creation");
        let mut creation = PendingVaultCreation::begin(&path).unwrap();
        let initialized =
            initialize_vault(creation.connection(), &VaultInitParams::default()).unwrap();
        creation
            .connection_mut()
            .inner()
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
            .unwrap();
        let connection = creation.commit();
        drop(connection);

        let reopened = VaultConnection::open(&path).unwrap();
        let vault_id: String = reopened
            .inner()
            .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
            .unwrap();

        assert_eq!(vault_id, initialized.vault_id);
        drop(reopened);
        remove_vault_files(&path);
    }

    #[test]
    fn extension_profiles_are_process_local_and_absent_after_reopen() {
        let path = temp_db_path("process-local-extension-profile");
        let creation = PendingVaultCreation::begin(&path).unwrap();
        initialize_vault(creation.connection(), &VaultInitParams::default()).unwrap();
        let mut connection = creation.commit();
        connection
            .register_extension_profile(test_extension_profile())
            .unwrap();
        assert_eq!(connection.extension_profiles().len(), 1);
        drop(connection);

        let reopened = VaultConnection::open(&path).unwrap();
        assert!(reopened.extension_profiles().is_empty());
        drop(reopened);
        remove_vault_files(&path);
    }
}
