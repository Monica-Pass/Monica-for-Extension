use mdbx_core::model::EntryType;
use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::import::kdbx_model::{ImportResult, KdbxAttachment, KdbxEntry};
use crate::repo::attachment::AttachmentRepo;
use crate::repo::commit_ctx::{CommitContext, CommitOperation, OperationExecution};
use crate::repo::entry::EntryRepo;
use crate::repo::project::ProjectRepo;

const ATOMIC_IMPORT_OPERATION_KIND: &str = "kdbx-import-atomic";
const ATOMIC_IMPORT_INTENT_DOMAIN: &[u8] = b"mdbx-kdbx-import-intent-v1";

struct PreparedKdbxImport<'a> {
    entries: Vec<PreparedKdbxEntry<'a>>,
    result: ImportResult,
    intent_hash: Vec<u8>,
}

struct PreparedKdbxEntry<'a> {
    source: &'a KdbxEntry,
    group_id: Option<String>,
    login_payload: serde_json::Value,
    note_payload: Option<serde_json::Value>,
}

/// KDBX 条目导入器。
///
/// 将 KDBX 逻辑条目映射为 MDBX project 模型：
/// - 每个 KDBX entry → 一个 Project
/// - 主凭据（username/password/URL/TOTP）→ 一个 Login Entry
/// - 备注 → 一个 Note Entry（非空时）
/// - 自定义字段 → 合并入 Login Entry payload 的 `custom_fields` 字段
/// - 附件 → Attachment 对象（embedded-inline 模式）
/// - 组路径 → project 的 group_id（`/` 分隔）
pub struct KdbxImporter;

impl KdbxImporter {
    /// 将一组 KDBX 条目导入到 MDBX vault。
    ///
    /// 这是兼容用的 best-effort 接口：每个条目独立尝试，project 创建失败时跳过该条目，
    /// 后续 entry 或 attachment 失败会降级为 warning。该接口不保证单条或整批原子性；
    /// 新调用方应使用 `import_entries_atomic`。
    pub fn import_entries(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entries: &[KdbxEntry],
    ) -> ImportResult {
        let mut result = ImportResult {
            projects_created: 0,
            entries_created: 0,
            attachments_created: 0,
            entries_skipped: 0,
            warnings: Vec::new(),
        };

        for entry in entries {
            match Self::import_one(conn, ctx, entry) {
                Ok((p_count, e_count, a_count, warnings)) => {
                    result.projects_created += p_count;
                    result.entries_created += e_count;
                    result.attachments_created += a_count;
                    result.warnings.extend(warnings);
                }
                Err(e) => {
                    result.entries_skipped += 1;
                    result
                        .warnings
                        .push(format!("skipped entry '{}': {}", entry.title, e));
                }
            }
        }

        result
    }

    /// 将一组 KDBX 条目作为一个幂等、原子的用户操作导入。
    ///
    /// 完整导入计划与确定性 intent hash 会在事务开始前生成。任何 project、entry、
    /// attachment 元数据或内容写入失败都会回滚整个批次。相同 operation ID 和相同输入
    /// 的重试返回 `AlreadyCommitted`；相同 ID 对应不同输入时返回校验错误。
    ///
    /// 原有 `import_entries` 继续提供逐条容错语义，供兼容调用方使用。
    pub fn import_entries_atomic(
        conn: &VaultConnection,
        ctx: &CommitContext,
        operation_id: impl Into<String>,
        entries: &[KdbxEntry],
    ) -> StorageResult<OperationExecution<ImportResult>> {
        let plan = Self::prepare_atomic_import(entries)?;
        let operation = CommitOperation::new(
            operation_id,
            ATOMIC_IMPORT_OPERATION_KIND,
            "main",
            "change",
            "multi",
            Vec::new(),
        )
        .with_message(format!("Import {} KDBX entries", plan.entries.len()))
        .with_intent_hash(plan.intent_hash.clone());

        ctx.run_operation(conn, operation, |scoped| {
            Self::execute_atomic_import(conn, scoped, &plan)
        })
    }

    fn prepare_atomic_import(entries: &[KdbxEntry]) -> StorageResult<PreparedKdbxImport<'_>> {
        if entries.is_empty() {
            return Err(StorageError::Validation(
                "atomic KDBX import requires at least one entry".to_string(),
            ));
        }

        let mut prepared = Vec::with_capacity(entries.len());
        let mut logical_entry_count = entries.len();
        let mut attachment_count = 0usize;

        for (entry_index, entry) in entries.iter().enumerate() {
            if entry.title.trim().is_empty() {
                return Err(StorageError::ConstraintViolation(format!(
                    "KDBX entry at index {entry_index} has empty title"
                )));
            }

            let note_payload = if entry.notes.trim().is_empty() {
                None
            } else {
                logical_entry_count = logical_entry_count.checked_add(1).ok_or_else(|| {
                    StorageError::ResourceLimit {
                        resource: "KDBX logical entry count".to_string(),
                        actual: u64::MAX,
                        limit: u32::MAX as u64,
                    }
                })?;
                Some(serde_json::json!({"text": entry.notes.trim()}))
            };

            for attachment in &entry.attachments {
                let attachment_size = u64::try_from(attachment.data.len()).map_err(|_| {
                    StorageError::ResourceLimit {
                        resource: "KDBX attachment bytes".to_string(),
                        actual: u64::MAX,
                        limit: i64::MAX as u64,
                    }
                })?;
                if attachment_size > i64::MAX as u64 {
                    return Err(StorageError::ResourceLimit {
                        resource: "KDBX attachment bytes".to_string(),
                        actual: attachment_size,
                        limit: i64::MAX as u64,
                    });
                }
            }
            attachment_count = attachment_count
                .checked_add(entry.attachments.len())
                .ok_or_else(|| StorageError::ResourceLimit {
                    resource: "KDBX attachment count".to_string(),
                    actual: u64::MAX,
                    limit: u32::MAX as u64,
                })?;

            prepared.push(PreparedKdbxEntry {
                source: entry,
                group_id: if entry.group_path.is_empty() {
                    None
                } else {
                    Some(entry.group_path.join("/"))
                },
                login_payload: Self::build_login_payload(entry),
                note_payload,
            });
        }

        let projects_created =
            u32::try_from(entries.len()).map_err(|_| StorageError::ResourceLimit {
                resource: "KDBX project count".to_string(),
                actual: entries.len() as u64,
                limit: u32::MAX as u64,
            })?;
        let entries_created =
            u32::try_from(logical_entry_count).map_err(|_| StorageError::ResourceLimit {
                resource: "KDBX logical entry count".to_string(),
                actual: logical_entry_count as u64,
                limit: u32::MAX as u64,
            })?;
        let attachments_created =
            u32::try_from(attachment_count).map_err(|_| StorageError::ResourceLimit {
                resource: "KDBX attachment count".to_string(),
                actual: attachment_count as u64,
                limit: u32::MAX as u64,
            })?;

        Ok(PreparedKdbxImport {
            entries: prepared,
            result: ImportResult {
                projects_created,
                entries_created,
                attachments_created,
                entries_skipped: 0,
                warnings: Vec::new(),
            },
            intent_hash: Self::atomic_import_intent_hash(entries),
        })
    }

    fn execute_atomic_import(
        conn: &VaultConnection,
        ctx: &CommitContext,
        plan: &PreparedKdbxImport<'_>,
    ) -> StorageResult<ImportResult> {
        for entry in &plan.entries {
            let project = ProjectRepo::create(
                conn,
                ctx,
                &entry.source.title,
                entry.group_id.as_deref(),
                None,
            )?;

            EntryRepo::create(
                conn,
                ctx,
                &project.project_id,
                EntryType::Login,
                Some(&entry.source.title),
                &entry.login_payload,
            )?;

            if let Some(note_payload) = &entry.note_payload {
                EntryRepo::create(
                    conn,
                    ctx,
                    &project.project_id,
                    EntryType::Note,
                    Some("Notes"),
                    note_payload,
                )?;
            }

            for attachment in &entry.source.attachments {
                Self::import_attachment(conn, ctx, &project.project_id, attachment)?;
            }
        }

        Ok(plan.result.clone())
    }

    fn atomic_import_intent_hash(entries: &[KdbxEntry]) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(ATOMIC_IMPORT_INTENT_DOMAIN);
        Self::hash_count(&mut hasher, entries.len());

        for entry in entries {
            for value in [
                &entry.uuid,
                &entry.title,
                &entry.username,
                &entry.password,
                &entry.url,
                &entry.notes,
            ] {
                Self::hash_bytes(&mut hasher, value.as_bytes());
            }

            match &entry.totp_seed {
                Some(value) => {
                    hasher.update([1]);
                    Self::hash_bytes(&mut hasher, value.as_bytes());
                }
                None => hasher.update([0]),
            }

            Self::hash_count(&mut hasher, entry.custom_fields.len());
            for (key, value) in &entry.custom_fields {
                Self::hash_bytes(&mut hasher, key.as_bytes());
                Self::hash_bytes(&mut hasher, value.as_bytes());
            }

            Self::hash_count(&mut hasher, entry.attachments.len());
            for attachment in &entry.attachments {
                Self::hash_bytes(&mut hasher, attachment.name.as_bytes());
                Self::hash_bytes(&mut hasher, &attachment.data);
            }

            Self::hash_count(&mut hasher, entry.group_path.len());
            for group in &entry.group_path {
                Self::hash_bytes(&mut hasher, group.as_bytes());
            }

            match entry.icon_id {
                Some(icon_id) => {
                    hasher.update([1]);
                    hasher.update(icon_id.to_le_bytes());
                }
                None => hasher.update([0]),
            }
            Self::hash_bytes(&mut hasher, entry.created_at.as_bytes());
            Self::hash_bytes(&mut hasher, entry.updated_at.as_bytes());
        }

        hasher.finalize().to_vec()
    }

    fn hash_count(hasher: &mut Sha256, count: usize) {
        hasher.update((count as u64).to_le_bytes());
    }

    fn hash_bytes(hasher: &mut Sha256, value: &[u8]) {
        Self::hash_count(hasher, value.len());
        hasher.update(value);
    }

    /// 导入单个 KDBX 条目。
    ///
    /// 返回 (projects, entries, attachments, warnings)。
    fn import_one(
        conn: &VaultConnection,
        ctx: &CommitContext,
        kdbx_entry: &KdbxEntry,
    ) -> StorageResult<(u32, u32, u32, Vec<String>)> {
        let mut warnings: Vec<String> = Vec::new();
        let mut project_count: u32 = 0;
        let mut entry_count: u32 = 0;
        let mut attachment_count: u32 = 0;

        // 标题为空的条目跳过
        if kdbx_entry.title.trim().is_empty() {
            return Err(StorageError::ConstraintViolation(
                "KDBX entry has empty title".to_string(),
            ));
        }

        // 1. 创建 project
        let group_id = if kdbx_entry.group_path.is_empty() {
            None
        } else {
            Some(kdbx_entry.group_path.join("/"))
        };

        let project = ProjectRepo::create(
            conn,
            ctx,
            &kdbx_entry.title,
            group_id.as_deref(),
            None, // icon_ref — KDBX icon_id 可后续映射
        )
        .map_err(|e| {
            StorageError::ConstraintViolation(format!(
                "failed to create project for '{}': {}",
                kdbx_entry.title, e
            ))
        })?;
        project_count += 1;

        // 2. 创建 Login entry（主凭据载荷）
        let login_payload = Self::build_login_payload(kdbx_entry);
        match EntryRepo::create(
            conn,
            ctx,
            &project.project_id,
            EntryType::Login,
            Some(&kdbx_entry.title),
            &login_payload,
        ) {
            Ok(_) => entry_count += 1,
            Err(e) => warnings.push(format!(
                "failed to create login entry for '{}': {}",
                kdbx_entry.title, e
            )),
        }

        // 3. 如果 notes 非空，创建 Note entry
        if !kdbx_entry.notes.trim().is_empty() {
            let note_payload = serde_json::json!({"text": kdbx_entry.notes.trim()});
            match EntryRepo::create(
                conn,
                ctx,
                &project.project_id,
                EntryType::Note,
                Some("Notes"),
                &note_payload,
            ) {
                Ok(_) => entry_count += 1,
                Err(e) => warnings.push(format!(
                    "failed to create note entry for '{}': {}",
                    kdbx_entry.title, e
                )),
            }
        }

        // 4. 导入附件
        for att in &kdbx_entry.attachments {
            match Self::import_attachment(conn, ctx, &project.project_id, att) {
                Ok(_) => attachment_count += 1,
                Err(e) => warnings.push(format!(
                    "failed to import attachment '{}' for '{}': {}",
                    att.name, kdbx_entry.title, e
                )),
            }
        }

        Ok((project_count, entry_count, attachment_count, warnings))
    }

    /// 构建 Login entry 的 payload JSON。
    fn build_login_payload(kdbx_entry: &KdbxEntry) -> serde_json::Value {
        let mut payload = serde_json::json!({
            "username": kdbx_entry.username,
            "password": kdbx_entry.password,
            "url": kdbx_entry.url,
        });

        if let Some(ref totp) = kdbx_entry.totp_seed {
            if !totp.is_empty() {
                payload["totp_seed"] = serde_json::Value::String(totp.clone());
            }
        }

        if !kdbx_entry.custom_fields.is_empty() {
            let custom: serde_json::Map<String, serde_json::Value> = kdbx_entry
                .custom_fields
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect();
            payload["custom_fields"] = serde_json::Value::Object(custom);
        }

        payload
    }

    /// 导入单个 KDBX 附件到 MDBX。
    fn import_attachment(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
        att: &KdbxAttachment,
    ) -> StorageResult<()> {
        // 创建附件元数据（content_hash 和 size 由 write_inline_content 更新）
        let mdbx_att = AttachmentRepo::add(
            conn,
            ctx,
            project_id,
            None, // entry 级附件暂不绑定
            &att.name,
            None, // media_type 可从扩展名推断，MVP 暂空
            "",   // 占位 hash
            att.data.len() as u64,
        )?;

        // 写入内联内容
        AttachmentRepo::write_inline_content(conn, ctx, &mdbx_att.attachment_id, &att.data)?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::kdbx_model::KdbxAttachment;
    use crate::init::{initialize_vault, VaultInitParams};

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        (conn, ctx)
    }

    fn make_entry(title: &str, user: &str, pass: &str) -> KdbxEntry {
        KdbxEntry {
            uuid: uuid::Uuid::new_v4().to_string(),
            title: title.to_string(),
            username: user.to_string(),
            password: pass.to_string(),
            url: String::new(),
            notes: String::new(),
            totp_seed: None,
            custom_fields: vec![],
            attachments: vec![],
            group_path: vec![],
            icon_id: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // BASIC IMPORT
    // -----------------------------------------------------------------------

    #[test]
    fn test_import_single_entry() {
        let (conn, ctx) = setup();
        let entries = vec![make_entry("GitHub", "alice", "s3cret")];

        let result = KdbxImporter::import_entries(&conn, &ctx, &entries);

        assert_eq!(result.projects_created, 1);
        assert_eq!(result.entries_created, 1); // Login entry
        assert_eq!(result.attachments_created, 0);
        assert_eq!(result.entries_skipped, 0);
        assert!(result.warnings.is_empty());

        // 验证 project 存在
        let projects = ProjectRepo::list_all(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].title_ct, b"GitHub");

        // 验证 entry 存在
        let entries_in_db = EntryRepo::list_by_project(&conn, &projects[0].project_id).unwrap();
        assert_eq!(entries_in_db.len(), 1);
        assert_eq!(entries_in_db[0].entry_type, EntryType::Login);
    }

    #[test]
    fn test_import_entry_with_notes() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("Server", "root", "pass123");
        entry.notes = "Production server - handle with care".to_string();

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.entries_created, 2); // Login + Note
        assert_eq!(result.projects_created, 1);
    }

    #[test]
    fn test_import_entry_with_totp() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("2FA Site", "bob", "pass456");
        entry.totp_seed = Some("JBSWY3DPEHPK3PXP".to_string());

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.projects_created, 1);

        // 验证 payload 中包含 totp_seed
        let projects = ProjectRepo::list_all(&conn).unwrap();
        let entries = EntryRepo::list_by_project(&conn, &projects[0].project_id).unwrap();
        let login = &entries[0];
        let payload: serde_json::Value = serde_json::from_slice(&login.payload_ct).unwrap();
        assert_eq!(payload["totp_seed"], "JBSWY3DPEHPK3PXP");
    }

    #[test]
    fn test_import_multiple_entries() {
        let (conn, ctx) = setup();
        let entries = vec![
            make_entry("Site A", "a", "p1"),
            make_entry("Site B", "b", "p2"),
            make_entry("Site C", "c", "p3"),
        ];

        let result = KdbxImporter::import_entries(&conn, &ctx, &entries);

        assert_eq!(result.projects_created, 3);
        assert_eq!(result.entries_created, 3);
        assert_eq!(result.entries_skipped, 0);
    }

    // -----------------------------------------------------------------------
    // EMPTY TITLE
    // -----------------------------------------------------------------------

    #[test]
    fn test_empty_title_skipped() {
        let (conn, ctx) = setup();
        let entries = vec![make_entry("", "user", "pass")];

        let result = KdbxImporter::import_entries(&conn, &ctx, &entries);

        assert_eq!(result.projects_created, 0);
        assert_eq!(result.entries_skipped, 1);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn test_whitespace_only_title_skipped() {
        let (conn, ctx) = setup();
        let entries = vec![make_entry("   ", "user", "pass")];

        let result = KdbxImporter::import_entries(&conn, &ctx, &entries);
        assert_eq!(result.entries_skipped, 1);
    }

    // -----------------------------------------------------------------------
    // GROUP PATH
    // -----------------------------------------------------------------------

    #[test]
    fn test_group_path_becomes_group_id() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("Work Mail", "alice", "s3cret");
        entry.group_path = vec!["Work".to_string(), "Email".to_string()];

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.projects_created, 1);

        let projects = ProjectRepo::list_all(&conn).unwrap();
        assert_eq!(projects[0].group_id.as_deref(), Some("Work/Email"));
    }

    // -----------------------------------------------------------------------
    // CUSTOM FIELDS
    // -----------------------------------------------------------------------

    #[test]
    fn test_custom_fields_in_payload() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("Bank", "alice", "s3cret");
        entry.custom_fields = vec![
            ("Account Number".to_string(), "12345678".to_string()),
            ("PIN".to_string(), "9999".to_string()),
        ];

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.projects_created, 1);

        let projects = ProjectRepo::list_all(&conn).unwrap();
        let entries = EntryRepo::list_by_project(&conn, &projects[0].project_id).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&entries[0].payload_ct).unwrap();

        let custom = payload["custom_fields"].as_object().unwrap();
        assert_eq!(custom["Account Number"], "12345678");
        assert_eq!(custom["PIN"], "9999");
    }

    // -----------------------------------------------------------------------
    // ATTACHMENTS
    // -----------------------------------------------------------------------

    #[test]
    fn test_import_entry_with_attachment() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("Docs", "alice", "s3cret");
        entry.attachments = vec![KdbxAttachment {
            name: "readme.txt".to_string(),
            data: b"Hello, MDBX import!".to_vec(),
        }];

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);

        assert_eq!(result.projects_created, 1);
        assert_eq!(result.attachments_created, 1);

        // 验证附件存在
        let projects = ProjectRepo::list_all(&conn).unwrap();
        let attachments = AttachmentRepo::list_by_project(&conn, &projects[0].project_id).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].file_name_ct, b"readme.txt");

        // 验证附件内容可读
        let data = AttachmentRepo::read_content(&conn, &attachments[0].attachment_id).unwrap();
        assert_eq!(data, b"Hello, MDBX import!");
    }

    #[test]
    fn test_import_entry_with_multiple_attachments() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("MultiAtt", "alice", "s3cret");
        entry.attachments = vec![
            KdbxAttachment {
                name: "a.txt".to_string(),
                data: vec![1, 2, 3],
            },
            KdbxAttachment {
                name: "b.txt".to_string(),
                data: vec![4, 5, 6],
            },
        ];

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.attachments_created, 2);
    }

    // -----------------------------------------------------------------------
    // NOTES EDGE CASES
    // -----------------------------------------------------------------------

    #[test]
    fn test_empty_notes_no_note_entry() {
        let (conn, ctx) = setup();
        let entry = make_entry("NoNotes", "alice", "s3cret");
        // notes is empty by default

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.entries_created, 1); // only Login
    }

    #[test]
    fn test_whitespace_only_notes_no_note_entry() {
        let (conn, ctx) = setup();
        let mut entry = make_entry("Spaces", "alice", "s3cret");
        entry.notes = "   \n  \t  ".to_string();

        let result = KdbxImporter::import_entries(&conn, &ctx, &[entry]);
        assert_eq!(result.entries_created, 1); // only Login
    }

    // -----------------------------------------------------------------------
    // PARTIAL FAILURE RESILIENCE
    // -----------------------------------------------------------------------

    #[test]
    fn test_mixed_valid_and_invalid() {
        let (conn, ctx) = setup();
        let entries = vec![
            make_entry("Valid", "a", "p1"),
            make_entry("", "b", "p2"), // bad — empty title
            make_entry("Also Valid", "c", "p3"),
        ];

        let result = KdbxImporter::import_entries(&conn, &ctx, &entries);

        assert_eq!(result.projects_created, 2);
        assert_eq!(result.entries_skipped, 1);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("empty title"));
    }

    // -----------------------------------------------------------------------
    // ATOMIC IMPORT
    // -----------------------------------------------------------------------

    fn commit_count(conn: &VaultConnection) -> i64 {
        conn.inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn atomic_import_coalesces_entire_batch_into_one_commit() {
        let (conn, ctx) = setup();
        let before = commit_count(&conn);
        let mut first = make_entry("Mail", "alice", "secret");
        first.notes = "Primary mailbox".to_string();
        first.attachments.push(KdbxAttachment {
            name: "message.eml".to_string(),
            data: b"Subject: atomic import".to_vec(),
        });
        let second = make_entry("Forum", "bob", "password");

        let execution =
            KdbxImporter::import_entries_atomic(&conn, &ctx, "atomic-kdbx-batch", &[first, second])
                .unwrap();
        let (result, commit_id) = match execution {
            OperationExecution::Applied { value, commit_id } => (value, commit_id),
            OperationExecution::AlreadyCommitted { .. } => panic!("first import must execute"),
        };

        assert_eq!(result.projects_created, 2);
        assert_eq!(result.entries_created, 3);
        assert_eq!(result.attachments_created, 1);
        assert_eq!(commit_count(&conn), before + 1);
        for table in ["projects", "entries", "attachments"] {
            let sql = format!("SELECT COUNT(*) FROM {table} WHERE head_commit_id <> ?1");
            let mismatched: i64 = conn
                .inner()
                .query_row(&sql, [&commit_id], |row| row.get(0))
                .unwrap();
            assert_eq!(mismatched, 0, "{table} must share the import commit");
        }
    }

    #[test]
    fn atomic_import_prevalidation_rejects_entire_batch() {
        let (conn, ctx) = setup();
        let before = commit_count(&conn);
        let entries = vec![
            make_entry("Valid", "alice", "secret"),
            make_entry("   ", "bob", "password"),
        ];

        let error =
            KdbxImporter::import_entries_atomic(&conn, &ctx, "atomic-kdbx-invalid", &entries)
                .unwrap_err();

        assert!(matches!(error, StorageError::ConstraintViolation(_)));
        assert!(ProjectRepo::list_all(&conn).unwrap().is_empty());
        assert_eq!(commit_count(&conn), before);
    }

    #[test]
    fn atomic_import_rolls_back_mid_attachment_failure() {
        let (conn, ctx) = setup();
        conn.inner()
            .execute_batch(
                "CREATE TRIGGER fail_second_kdbx_attachment_chunk
                 BEFORE INSERT ON attachment_chunks
                 WHEN (SELECT COUNT(*) FROM attachments) >= 2
                 BEGIN
                   SELECT RAISE(ABORT, 'injected attachment failure');
                 END;",
            )
            .unwrap();
        let before = commit_count(&conn);
        let mut entry = make_entry("Attachments", "alice", "secret");
        entry.attachments = vec![
            KdbxAttachment {
                name: "first.bin".to_string(),
                data: vec![1, 2, 3],
            },
            KdbxAttachment {
                name: "second.bin".to_string(),
                data: vec![4, 5, 6],
            },
        ];

        let error =
            KdbxImporter::import_entries_atomic(&conn, &ctx, "atomic-kdbx-rollback", &[entry])
                .unwrap_err();

        assert!(matches!(error, StorageError::Database(_)));
        for table in ["projects", "entries", "attachments", "attachment_chunks"] {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count: i64 = conn.inner().query_row(&sql, [], |row| row.get(0)).unwrap();
            assert_eq!(count, 0, "{table} must roll back");
        }
        let operation_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_operations WHERE operation_id = ?1",
                ["atomic-kdbx-rollback"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(operation_count, 0);
        assert_eq!(commit_count(&conn), before);
    }

    #[test]
    fn atomic_import_retry_is_idempotent() {
        let (conn, ctx) = setup();
        let entry = make_entry("Retry", "alice", "secret");
        let first = KdbxImporter::import_entries_atomic(
            &conn,
            &ctx,
            "atomic-kdbx-retry",
            std::slice::from_ref(&entry),
        )
        .unwrap();
        let first_commit_id = match first {
            OperationExecution::Applied { commit_id, .. } => commit_id,
            OperationExecution::AlreadyCommitted { .. } => panic!("first import must execute"),
        };
        let after_first = commit_count(&conn);

        let retry = KdbxImporter::import_entries_atomic(
            &conn,
            &ctx,
            "atomic-kdbx-retry",
            std::slice::from_ref(&entry),
        )
        .unwrap();

        assert!(matches!(
            retry,
            OperationExecution::AlreadyCommitted { commit_id }
                if commit_id == first_commit_id
        ));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
        assert_eq!(commit_count(&conn), after_first);
    }

    #[test]
    fn atomic_import_rejects_changed_input_for_operation_id() {
        let (conn, ctx) = setup();
        let entry = make_entry("Intent", "alice", "secret");
        KdbxImporter::import_entries_atomic(
            &conn,
            &ctx,
            "atomic-kdbx-intent",
            std::slice::from_ref(&entry),
        )
        .unwrap();
        let after_first = commit_count(&conn);
        let mut changed = entry;
        changed.updated_at = "2026-07-23T02:00:00Z".to_string();

        let error =
            KdbxImporter::import_entries_atomic(&conn, &ctx, "atomic-kdbx-intent", &[changed])
                .unwrap_err();

        assert!(error
            .to_string()
            .contains("reused for a different operation"));
        assert_eq!(ProjectRepo::list_all(&conn).unwrap().len(), 1);
        assert_eq!(commit_count(&conn), after_first);
    }
}
