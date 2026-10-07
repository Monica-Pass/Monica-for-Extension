use std::io::{Read, Write};

use rusqlite::params;
use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use mdbx_core::model::attachment::StorageMode;
use mdbx_core::model::Attachment;
use mdbx_core::tiga::{
    AuthorizationDecision, AuthorizationOutcome, DeviceContext, TigaOperation, TigaScope,
};

use crate::blob_store::{compute_blob_id, validate_blob_id, EncryptedBlobStore};
use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::repo::object_version::ObjectVersionRepo;
use crate::repo::CollectionProfileRepo;
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

/// 附件元数据的持久化仓库。
///
/// 附件属于一等结构，支持 project 级和 entry 级归属。
/// 改名只改元数据，不改变 content_hash。
pub struct AttachmentRepo;

#[derive(Clone, Copy)]
enum AttachmentContentTarget<'a> {
    Embedded { force_chunked_mode: bool },
    External(&'a dyn EncryptedBlobStore),
}

const MAX_EXTERNAL_BLOB_ENVELOPE_OVERHEAD: u64 = 128 * 1024;

/// 附件明文的使用目的。持久化导出与内存解密采用不同的 TIGA 操作语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPlaintextPurpose {
    InMemory,
    Export,
}

impl AttachmentPlaintextPurpose {
    fn operation(self) -> TigaOperation {
        match self {
            Self::InMemory => TigaOperation::DecryptAttachment,
            Self::Export => TigaOperation::ExportData,
        }
    }
}

/// 流式附件写入的资源约束。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentWriteOptions {
    /// 单个明文分块的最大字节数。
    pub chunk_size: usize,
    /// 此次操作允许读取的明文总字节数。
    pub max_plaintext_size: u64,
    /// 可选的精确明文大小，用于检测源文件在读取期间发生变化。
    pub expected_plaintext_size: Option<u64>,
}

impl AttachmentWriteOptions {
    pub fn new(chunk_size: usize, max_plaintext_size: u64) -> Self {
        Self {
            chunk_size,
            max_plaintext_size,
            expected_plaintext_size: None,
        }
    }

    pub fn exact(chunk_size: usize, plaintext_size: u64) -> Self {
        Self {
            chunk_size,
            max_plaintext_size: plaintext_size,
            expected_plaintext_size: Some(plaintext_size),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AttachmentCreateRequest<'a> {
    pub project_id: &'a str,
    pub entry_id: Option<&'a str>,
    pub file_name: &'a str,
    pub media_type: Option<&'a str>,
    pub content_hash: &'a str,
    pub original_size: u64,
}

impl AttachmentRepo {
    // -----------------------------------------------------------------------
    // CREATE
    // -----------------------------------------------------------------------

    // Kept for MDBX1 callers; new code should use AttachmentCreateRequest.
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
        entry_id: Option<&str>,
        file_name: &str,
        media_type: Option<&str>,
        content_hash: &str,
        original_size: u64,
    ) -> StorageResult<Attachment> {
        Self::add_with_request(
            conn,
            ctx,
            AttachmentCreateRequest {
                project_id,
                entry_id,
                file_name,
                media_type,
                content_hash,
                original_size,
            },
        )
    }

    pub fn add_with_request(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: AttachmentCreateRequest<'_>,
    ) -> StorageResult<Attachment> {
        let attachment_id = Uuid::new_v4().to_string();
        Self::add_with_id(conn, ctx, &attachment_id, request)
    }

    /// Add attachment metadata with a caller-supplied stable UUID.
    ///
    /// This additive MDBX2 entry point supports idempotent operation facades;
    /// MDBX1 callers can continue using `add` or `add_with_request`.
    pub fn add_with_id(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        request: AttachmentCreateRequest<'_>,
    ) -> StorageResult<Attachment> {
        Uuid::parse_str(attachment_id).map_err(|_| {
            StorageError::Validation(format!("attachment_id {attachment_id} must be a UUID"))
        })?;
        let AttachmentCreateRequest {
            project_id,
            entry_id,
            file_name,
            media_type,
            content_hash,
            original_size,
        } = request;
        conn.with_immediate_transaction(|| {
            let now = chrono::Utc::now().to_rfc3339();
            let attachment_id = attachment_id.to_string();

            // 验证 project 存在且未删除
            let (p_exists, p_deleted): (bool, bool) = conn
                .inner()
                .query_row(
                    "SELECT 1, deleted FROM projects WHERE project_id = ?1",
                    params![project_id],
                    |row| Ok((true, row.get::<_, i32>(1)? != 0)),
                )
                .optional()
                .map_err(StorageError::Database)?
                .unwrap_or((false, false));

            if !p_exists {
                return Err(StorageError::NotFound(format!(
                    "project {} not found",
                    project_id
                )));
            }
            if p_deleted {
                return Err(StorageError::ConstraintViolation(format!(
                    "project {} is deleted",
                    project_id
                )));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(conn, project_id)?;

            // 验证 entry（如果指定）存在且未删除
            if let Some(eid) = entry_id {
                let (e_exists, e_deleted, e_project): (bool, bool, String) = conn
                    .inner()
                    .query_row(
                        "SELECT 1, deleted, project_id FROM entries WHERE entry_id = ?1",
                        params![eid],
                        |row| Ok((true, row.get::<_, i32>(1)? != 0, row.get(2)?)),
                    )
                    .optional()
                    .map_err(StorageError::Database)?
                    .unwrap_or((false, false, String::new()));

                if !e_exists {
                    return Err(StorageError::NotFound(format!("entry {} not found", eid)));
                }
                if e_deleted {
                    return Err(StorageError::ConstraintViolation(format!(
                        "entry {} is deleted",
                        eid
                    )));
                }
                if e_project != project_id {
                    return Err(StorageError::ConstraintViolation(format!(
                        "entry {} does not belong to project {}",
                        eid, project_id
                    )));
                }
            }

            let commit_id =
                ctx.create_commit(conn, "change", "attachment", &[attachment_id.clone()], &[])?;

            let storage_mode = "embedded-inline";

            let file_name_ct = Self::encrypt_attachment_field(
                conn,
                &attachment_id,
                "file_name",
                file_name.as_bytes(),
            )?;
            let media_type_ct = media_type
                .map(|m| {
                    Self::encrypt_attachment_field(conn, &attachment_id, "media_type", m.as_bytes())
                })
                .transpose()?;

            conn.inner().execute(
                "INSERT INTO attachments (attachment_id, project_id, entry_id,
             file_name_ct, media_type_ct, storage_mode, content_hash,
             original_size, stored_size, chunk_count, head_commit_id,
             deleted, created_at, updated_at, created_by_device_id, updated_by_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0, ?9, 0, ?10, ?10, ?11, ?11)",
                params![
                    attachment_id,
                    project_id,
                    entry_id,
                    file_name_ct,
                    media_type_ct,
                    storage_mode,
                    content_hash,
                    original_size,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_attachment_current(conn, &commit_id, &attachment_id)?;

            AttachmentRepo::get_by_id(conn, &attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id))
        })
    }

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    /// 在调用方创建明文缓冲区、临时文件或输出流之前完成授权和审计。
    pub fn authorize_plaintext_access(
        conn: &VaultConnection,
        attachment_id: &str,
        purpose: AttachmentPlaintextPurpose,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<AuthorizationDecision> {
        Self::ensure_plaintext_target(conn, attachment_id)?;
        let scope = TigaScope::Attachment {
            attachment_id: attachment_id.to_string(),
        };
        let decision =
            TigaService::authorize_operation(conn, &scope, purpose.operation(), context)?;
        if matches!(
            decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ) {
            Ok(decision)
        } else {
            Err(StorageError::Authorization(decision))
        }
    }

    /// 使用连接中的活动解锁会话完成附件明文授权，并在成功时续期空闲活动时间。
    pub fn authorize_plaintext_access_with_active_session(
        conn: &mut VaultConnection,
        attachment_id: &str,
        purpose: AttachmentPlaintextPurpose,
        device: &DeviceContext,
        now_unix_secs: i64,
    ) -> StorageResult<AuthorizationDecision> {
        Self::ensure_plaintext_target(conn, attachment_id)?;
        let scope = TigaScope::Attachment {
            attachment_id: attachment_id.to_string(),
        };
        let decision = TigaService::authorize_operation_with_active_session(
            conn,
            &scope,
            purpose.operation(),
            device,
            now_unix_secs,
        )?;
        if matches!(
            decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ) {
            Ok(decision)
        } else {
            Err(StorageError::Authorization(decision))
        }
    }

    fn ensure_plaintext_target(conn: &VaultConnection, attachment_id: &str) -> StorageResult<()> {
        let deleted = conn
            .inner()
            .query_row(
                "SELECT deleted FROM attachments WHERE attachment_id = ?1",
                params![attachment_id],
                |row| row.get::<_, i32>(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;
        if deleted != 0 {
            return Err(StorageError::ConstraintViolation(
                "attachment is deleted".to_string(),
            ));
        }
        Ok(())
    }

    pub fn get_by_id(
        conn: &VaultConnection,
        attachment_id: &str,
    ) -> StorageResult<Option<Attachment>> {
        conn.inner()
            .query_row(
                "SELECT attachment_id, project_id, entry_id, file_name_ct,
                        media_type_ct, storage_mode, content_hash,
                        original_size, stored_size, chunk_count, head_commit_id,
                        deleted, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM attachments WHERE attachment_id = ?1",
                params![attachment_id],
                |row| {
                    let aid: String = row.get(0)?;
                    let raw_file_name: Vec<u8> = row.get(3)?;
                    let raw_media_type: Option<Vec<u8>> = row.get(4)?;
                    Ok(Attachment {
                        attachment_id: aid.clone(),
                        project_id: row.get(1)?,
                        entry_id: row.get(2)?,
                        file_name_ct: Self::decrypt_attachment_field(
                            conn,
                            &aid,
                            "file_name",
                            &raw_file_name,
                        )
                        .map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(3, Type::Blob, Box::new(e))
                        })?,
                        media_type_ct: raw_media_type
                            .map(|m| {
                                Self::decrypt_attachment_field(conn, &aid, "media_type", &m)
                                    .map_err(|e| {
                                        rusqlite::Error::FromSqlConversionFailure(
                                            4,
                                            Type::Blob,
                                            Box::new(e),
                                        )
                                    })
                            })
                            .transpose()?,
                        storage_mode: {
                            let s: String = row.get(5)?;
                            parse_storage_mode(5, &s)?
                        },
                        content_hash: row.get(6)?,
                        original_size: row.get::<_, i64>(7)? as u64,
                        stored_size: row.get::<_, i64>(8)? as u64,
                        chunk_count: row.get::<_, i32>(9)? as u32,
                        head_commit_id: row.get(10)?,
                        deleted: row.get::<_, i32>(11)? != 0,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                        created_by_device_id: row.get(14)?,
                        updated_by_device_id: row.get(15)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub fn list_by_project(
        conn: &VaultConnection,
        project_id: &str,
    ) -> StorageResult<Vec<Attachment>> {
        AttachmentRepo::list_where(conn, "deleted = 0 AND project_id = ?1", params![project_id])
    }

    pub fn list_by_entry(conn: &VaultConnection, entry_id: &str) -> StorageResult<Vec<Attachment>> {
        AttachmentRepo::list_where(conn, "deleted = 0 AND entry_id = ?1", params![entry_id])
    }

    /// Move an entry-owned attachment inside the entry's existing transaction.
    /// Content and Blob identity are independent of Collection ownership.
    pub(crate) fn move_with_entry(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment: &Attachment,
        entry_id: &str,
        target_project_id: &str,
    ) -> StorageResult<()> {
        if attachment.deleted || attachment.entry_id.as_deref() != Some(entry_id) {
            return Err(StorageError::ConstraintViolation("attachment owner mismatch".to_string()));
        }
        let owner = crate::repo::EntryRepo::get_by_id(conn, entry_id)?
            .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;
        if owner.deleted || owner.project_id != target_project_id {
            return Err(StorageError::ConstraintViolation("attachment destination owner mismatch".to_string()));
        }
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, &attachment.project_id)?;
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, target_project_id)?;
        let commit_id = ctx.commit_object_change(conn, "attachments", &attachment.attachment_id, "move", "attachment")?;
        conn.inner().execute(
            "UPDATE attachments SET project_id = ?2, head_commit_id = ?3,
             updated_at = ?4, updated_by_device_id = ?5 WHERE attachment_id = ?1",
            params![attachment.attachment_id, target_project_id, commit_id,
                chrono::Utc::now().to_rfc3339(), ctx.device_id],
        )?;
        ObjectVersionRepo::record_attachment_current(conn, &commit_id, &attachment.attachment_id)?;
        Ok(())
    }

    pub fn list_deleted(conn: &VaultConnection) -> StorageResult<Vec<Attachment>> {
        AttachmentRepo::list_where(conn, "deleted = 1", [])
    }

    fn list_where(
        conn: &VaultConnection,
        where_clause: &str,
        params: impl rusqlite::Params,
    ) -> StorageResult<Vec<Attachment>> {
        let sql = format!(
            "SELECT attachment_id, project_id, entry_id, file_name_ct,
                    media_type_ct, storage_mode, content_hash,
                    original_size, stored_size, chunk_count, head_commit_id,
                    deleted, created_at, updated_at,
                    created_by_device_id, updated_by_device_id
             FROM attachments WHERE {} ORDER BY updated_at DESC",
            where_clause
        );

        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(params, |row| {
            let aid: String = row.get(0)?;
            let raw_file_name: Vec<u8> = row.get(3)?;
            let raw_media_type: Option<Vec<u8>> = row.get(4)?;
            Ok(Attachment {
                attachment_id: aid.clone(),
                project_id: row.get(1)?,
                entry_id: row.get(2)?,
                file_name_ct: Self::decrypt_attachment_field(
                    conn,
                    &aid,
                    "file_name",
                    &raw_file_name,
                )
                .map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(3, Type::Blob, Box::new(e))
                })?,
                media_type_ct: raw_media_type
                    .map(|m| {
                        Self::decrypt_attachment_field(conn, &aid, "media_type", &m).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(4, Type::Blob, Box::new(e))
                        })
                    })
                    .transpose()?,
                storage_mode: {
                    let s: String = row.get(5)?;
                    parse_storage_mode(5, &s)?
                },
                content_hash: row.get(6)?,
                original_size: row.get::<_, i64>(7)? as u64,
                stored_size: row.get::<_, i64>(8)? as u64,
                chunk_count: row.get::<_, i32>(9)? as u32,
                head_commit_id: row.get(10)?,
                deleted: row.get::<_, i32>(11)? != 0,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
                created_by_device_id: row.get(14)?,
                updated_by_device_id: row.get(15)?,
            })
        })?;

        let mut attachments = Vec::new();
        for row in rows {
            attachments.push(row?);
        }
        Ok(attachments)
    }

    // -----------------------------------------------------------------------
    // RENAME — 只改元数据，不触碰内容
    // -----------------------------------------------------------------------

    pub fn rename(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        new_file_name: &str,
        new_media_type: Option<&str>,
    ) -> StorageResult<Attachment> {
        conn.with_immediate_transaction(|| {
            let att = AttachmentRepo::get_by_id(conn, attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;

            if att.deleted {
                return Err(StorageError::ConstraintViolation(
                    "attachment is deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(conn, &att.project_id)?;

            let now = chrono::Utc::now().to_rfc3339();

            let commit_id = ctx.commit_object_change(
                conn,
                "attachments",
                attachment_id,
                "change",
                "attachment",
            )?;

            // content_hash 不变！
            let file_name_ct = Self::encrypt_attachment_field(
                conn,
                attachment_id,
                "file_name",
                new_file_name.as_bytes(),
            )?;
            let media_type_ct = new_media_type
                .map(|m| {
                    Self::encrypt_attachment_field(conn, attachment_id, "media_type", m.as_bytes())
                })
                .transpose()?;

            conn.inner().execute(
                "UPDATE attachments SET
                file_name_ct = ?2, media_type_ct = ?3,
                head_commit_id = ?4,
                updated_at = ?5, updated_by_device_id = ?6
             WHERE attachment_id = ?1",
                params![
                    attachment_id,
                    file_name_ct,
                    media_type_ct,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_attachment_current(conn, &commit_id, attachment_id)?;

            AttachmentRepo::get_by_id(conn, attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))
        })
    }

    // -----------------------------------------------------------------------
    // SOFT DELETE
    // -----------------------------------------------------------------------

    pub fn soft_delete(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
    ) -> StorageResult<()> {
        conn.with_immediate_transaction(|| {
            let att = AttachmentRepo::get_by_id(conn, attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;

            if att.deleted {
                return Err(StorageError::ConstraintViolation(
                    "attachment is already deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(conn, &att.project_id)?;

            let now = chrono::Utc::now().to_rfc3339();

            let commit_id = ctx.commit_object_change(
                conn,
                "attachments",
                attachment_id,
                "change",
                "attachment",
            )?;
            ctx.create_tombstone_for_commit(conn, "attachment", attachment_id, &commit_id)?;

            conn.inner().execute(
                "UPDATE attachments SET deleted = 1,
             head_commit_id = ?2, updated_at = ?3, updated_by_device_id = ?4
             WHERE attachment_id = ?1",
                params![attachment_id, commit_id, now, ctx.device_id],
            )?;
            ObjectVersionRepo::record_attachment_current(conn, &commit_id, attachment_id)?;

            Ok(())
        })
    }

    // -----------------------------------------------------------------------
    // 更新 attachment_count（供 ProjectRepo 内部使用）
    // -----------------------------------------------------------------------

    pub fn count_for_project(conn: &VaultConnection, project_id: &str) -> StorageResult<u32> {
        let count: i32 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM attachments WHERE project_id = ?1 AND deleted = 0",
                params![project_id],
                |row| row.get(0),
            )
            .map_err(StorageError::Database)?;
        Ok(count as u32)
    }

    // -----------------------------------------------------------------------
    // INLINE CONTENT — 小附件内嵌模式
    // -----------------------------------------------------------------------

    /// 将二进制内容写入 attachment_chunks（chunk_index=0）。
    ///
    /// 自动计算 content_hash（SHA-256），更新 attachments 表的 stored_size 和
    /// content_hash。如果已有 chunk 数据则覆盖。
    pub fn write_inline_content(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        data: &[u8],
    ) -> StorageResult<String> {
        conn.with_immediate_transaction(|| {
            let att = AttachmentRepo::get_by_id(conn, attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;

            if att.deleted {
                return Err(StorageError::ConstraintViolation(
                    "attachment is deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(conn, &att.project_id)?;

            let content_hash = compute_sha256_hex(data);
            let now = chrono::Utc::now().to_rfc3339();

            let chunk_ct = Self::encrypt_attachment_field(conn, attachment_id, "chunk", data)?;

            let commit_id = ctx.commit_object_change(
                conn,
                "attachments",
                attachment_id,
                "change",
                "attachment",
            )?;

            // 内容替换必须先清除旧分块，避免 chunked/external 模式残留额外行。
            conn.inner().execute(
                "DELETE FROM attachment_chunks WHERE attachment_id = ?1",
                params![attachment_id],
            )?;
            conn.inner().execute(
                "INSERT INTO attachment_chunks (attachment_id, chunk_index, chunk_hash,
             chunk_ct, stored_size, created_at)
             VALUES (?1, 0, ?2, ?3, ?4, ?5)",
                params![
                    attachment_id,
                    content_hash,
                    chunk_ct,
                    data.len() as i64,
                    now,
                ],
            )?;

            // 更新 attachments 元数据
            conn.inner().execute(
                "UPDATE attachments SET
                content_hash = ?2, stored_size = ?3, chunk_count = 1,
                storage_mode = 'embedded-inline',
                head_commit_id = ?4, updated_at = ?5, updated_by_device_id = ?6
             WHERE attachment_id = ?1",
                params![
                    attachment_id,
                    content_hash,
                    data.len() as i64,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_attachment_current(conn, &commit_id, attachment_id)?;

            Ok(content_hash)
        })
    }

    /// 读取附件内容并验证完整性。
    ///
    /// 从 attachment_chunks 读取 chunk_index=0 的内容，计算 hash 并与
    /// attachments.content_hash 对比。不匹配则返回错误。
    pub fn read_content(conn: &VaultConnection, attachment_id: &str) -> StorageResult<Vec<u8>> {
        let mut data = Vec::new();
        Self::read_content_to_writer(conn, attachment_id, &mut data)?;
        Ok(data)
    }

    /// 使用调用方提供的加密 Blob Provider 读取内嵌或外部附件。
    pub fn read_content_with_blob_store(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: &dyn EncryptedBlobStore,
    ) -> StorageResult<Vec<u8>> {
        let mut data = Vec::new();
        Self::read_content_to_writer_with_blob_store(conn, attachment_id, blob_store, &mut data)?;
        Ok(data)
    }

    /// 将附件明文流式写入目标，并验证结构、分块和整体内容完整性。
    ///
    /// 内存占用与单个已加密分块大小相关，不随附件总大小增长。返回写入的明文字节数。
    pub fn read_content_to_writer(
        conn: &VaultConnection,
        attachment_id: &str,
        writer: &mut dyn Write,
    ) -> StorageResult<u64> {
        Self::read_content_to_writer_inner(conn, attachment_id, None, writer, true)
    }

    /// 将内嵌或外部附件流式写入目标，并验证完整性。
    pub fn read_content_to_writer_with_blob_store(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: &dyn EncryptedBlobStore,
        writer: &mut dyn Write,
    ) -> StorageResult<u64> {
        Self::read_content_to_writer_inner(conn, attachment_id, Some(blob_store), writer, true)
    }

    fn read_content_to_writer_inner(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: Option<&dyn EncryptedBlobStore>,
        writer: &mut dyn Write,
        reject_deleted: bool,
    ) -> StorageResult<u64> {
        let att = AttachmentRepo::get_by_id(conn, attachment_id)?
            .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;

        if reject_deleted && att.deleted {
            return Err(StorageError::ConstraintViolation(
                "attachment is deleted".to_string(),
            ));
        }
        Self::require_blob_store_for_mode(&att.storage_mode, attachment_id, blob_store)?;

        let (actual_count, declared_size, min_index, max_index): (
            i64,
            i64,
            Option<i64>,
            Option<i64>,
        ) = conn.inner().query_row(
            "SELECT COUNT(*), COALESCE(SUM(stored_size), 0),
                    MIN(chunk_index), MAX(chunk_index)
             FROM attachment_chunks WHERE attachment_id = ?1",
            params![attachment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        if actual_count != i64::from(att.chunk_count) {
            return Err(StorageError::ConstraintViolation(format!(
                "attachment chunk count mismatch: expected {}, got {}",
                att.chunk_count, actual_count
            )));
        }
        if actual_count == 0 {
            return Ok(0);
        }
        if min_index != Some(0) || max_index != Some(actual_count - 1) {
            return Err(StorageError::ConstraintViolation(
                "attachment chunk indices are not contiguous".to_string(),
            ));
        }
        if declared_size < 0 || declared_size as u64 != att.stored_size {
            return Err(StorageError::ConstraintViolation(format!(
                "attachment stored size mismatch: expected {}, got {}",
                att.stored_size, declared_size
            )));
        }

        let mut stmt = conn.inner().prepare(
            "SELECT chunk_index, chunk_hash, chunk_ct, external_uri_ct, stored_size
             FROM attachment_chunks
             WHERE attachment_id = ?1
             ORDER BY chunk_index",
        )?;
        let rows = stmt.query_map(params![attachment_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
                row.get::<_, Option<Vec<u8>>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;

        let mut overall_hasher = Sha256::new();
        let mut total_size = 0u64;
        for (expected_index, row) in rows.enumerate() {
            let (chunk_index, expected_hash, chunk_ct, external_uri_ct, stored_size) = row?;
            if chunk_index != expected_index as i64 {
                return Err(StorageError::ConstraintViolation(format!(
                    "attachment chunk index mismatch: expected {}, got {}",
                    expected_index, chunk_index
                )));
            }
            let plaintext = Self::load_chunk_plaintext(
                conn,
                attachment_id,
                &att.storage_mode,
                chunk_index,
                stored_size,
                chunk_ct,
                external_uri_ct,
                blob_store,
            )?;
            if stored_size < 0 || stored_size as usize != plaintext.len() {
                return Err(StorageError::ConstraintViolation(format!(
                    "attachment chunk {} size mismatch",
                    chunk_index
                )));
            }
            let computed_hash = compute_sha256_hex(&plaintext);
            if computed_hash != expected_hash {
                return Err(StorageError::ConstraintViolation(format!(
                    "attachment chunk {} hash mismatch",
                    chunk_index
                )));
            }

            writer.write_all(&plaintext)?;
            overall_hasher.update(&plaintext);
            total_size = total_size
                .checked_add(plaintext.len() as u64)
                .ok_or_else(|| {
                    StorageError::Validation("attachment content size overflow".to_string())
                })?;
        }

        let computed_hash = format!("{:x}", overall_hasher.finalize());
        if computed_hash != att.content_hash {
            return Err(StorageError::ConstraintViolation(format!(
                "content hash mismatch: expected {}, got {}",
                att.content_hash, computed_hash
            )));
        }
        if total_size != att.stored_size {
            return Err(StorageError::ConstraintViolation(format!(
                "attachment plaintext size mismatch: expected {}, got {}",
                att.stored_size, total_size
            )));
        }

        Ok(total_size)
    }

    /// 校验附件完整性，不返回内容。
    pub fn verify_integrity(conn: &VaultConnection, attachment_id: &str) -> StorageResult<bool> {
        Self::verify_integrity_inner(conn, attachment_id, None)
    }

    /// 使用调用方提供的加密 Blob Provider 校验内嵌或外部附件。
    pub fn verify_integrity_with_blob_store(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: &dyn EncryptedBlobStore,
    ) -> StorageResult<bool> {
        Self::verify_integrity_inner(conn, attachment_id, Some(blob_store))
    }

    fn verify_integrity_inner(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: Option<&dyn EncryptedBlobStore>,
    ) -> StorageResult<bool> {
        let att = AttachmentRepo::get_by_id(conn, attachment_id)?
            .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;
        Self::require_blob_store_for_mode(&att.storage_mode, attachment_id, blob_store)?;
        if att.chunk_count == 0 {
            return Ok(true);
        }
        let mut sink = std::io::sink();
        Ok(
            Self::read_content_to_writer_inner(conn, attachment_id, blob_store, &mut sink, false)
                .is_ok(),
        )
    }

    // -----------------------------------------------------------------------
    // CHUNKED CONTENT — 大附件分块模式
    // -----------------------------------------------------------------------

    /// 将大文件按 chunk_size 分块写入 attachment_chunks。
    ///
    /// chunk_index 从 0 开始连续递增，每个 chunk 有独立的 chunk_hash。
    /// 整体 content_hash 是所有数据拼接后的 SHA-256。
    /// storage_mode 设为 `embedded-chunked`。
    pub fn write_chunked_content(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        data: &[u8],
        chunk_size: usize,
    ) -> StorageResult<String> {
        let mut reader = std::io::Cursor::new(data);
        Self::write_content_from_reader_inner(
            conn,
            ctx,
            attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(chunk_size, data.len() as u64),
            AttachmentContentTarget::Embedded {
                force_chunked_mode: true,
            },
        )
    }

    /// 从 reader 分块读取、加密并写入附件内容。
    ///
    /// 所有分块、提交和附件元数据位于同一个事务中。reader 失败时原有内容保持不变。
    /// 当内容只有一个分块时使用内嵌模式，多个分块时使用分块模式。
    pub fn write_content_from_reader(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        reader: &mut dyn Read,
        chunk_size: usize,
    ) -> StorageResult<String> {
        Self::write_content_from_reader_with_options(
            conn,
            ctx,
            attachment_id,
            reader,
            AttachmentWriteOptions::new(chunk_size, i64::MAX as u64),
        )
    }

    /// 从 reader 写入受总量和可选精确大小约束的附件内容。
    pub fn write_content_from_reader_with_options(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        reader: &mut dyn Read,
        options: AttachmentWriteOptions,
    ) -> StorageResult<String> {
        Self::write_content_from_reader_inner(
            conn,
            ctx,
            attachment_id,
            reader,
            options,
            AttachmentContentTarget::Embedded {
                force_chunked_mode: false,
            },
        )
    }

    /// 将明文流加密为独立分块，并把密文保存到外部 Blob Provider。
    ///
    /// Provider 中只保存认证密文，数据库中只保存再次加密的密文摘要引用。
    pub fn write_external_content_from_reader_with_options(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        reader: &mut dyn Read,
        options: AttachmentWriteOptions,
        blob_store: &dyn EncryptedBlobStore,
    ) -> StorageResult<String> {
        if !conn.is_encrypted() {
            return Err(StorageError::Validation(
                "external blob storage requires an unlocked encrypted vault".to_string(),
            ));
        }
        Self::write_content_from_reader_inner(
            conn,
            ctx,
            attachment_id,
            reader,
            options,
            AttachmentContentTarget::External(blob_store),
        )
    }

    fn write_content_from_reader_inner(
        conn: &VaultConnection,
        ctx: &CommitContext,
        attachment_id: &str,
        reader: &mut dyn Read,
        options: AttachmentWriteOptions,
        target: AttachmentContentTarget<'_>,
    ) -> StorageResult<String> {
        Self::validate_write_options(options)?;
        let maximum_buffer_size = usize::try_from(options.max_plaintext_size.saturating_add(1))
            .unwrap_or(options.chunk_size);
        let buffer_size = options.chunk_size.min(maximum_buffer_size.max(1));
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(buffer_size).map_err(|error| {
            StorageError::Validation(format!("cannot allocate attachment chunk buffer: {error}"))
        })?;
        buffer.resize(buffer_size, 0);

        conn.with_immediate_transaction(|| {
            let att = AttachmentRepo::get_by_id(conn, attachment_id)?
                .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;

            if att.deleted {
                return Err(StorageError::ConstraintViolation(
                    "attachment is deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(conn, &att.project_id)?;

            let now = chrono::Utc::now().to_rfc3339();
            let commit_id = ctx.commit_object_change(
                conn,
                "attachments",
                attachment_id,
                "change",
                "attachment",
            )?;

            // 清除旧 chunk 数据
            conn.inner().execute(
                "DELETE FROM attachment_chunks WHERE attachment_id = ?1",
                params![attachment_id],
            )?;

            let mut content_hasher = Sha256::new();
            let mut chunk_count = 0u32;
            let mut total_size = 0u64;
            loop {
                let read_limit = next_attachment_read_limit(
                    buffer.len(),
                    total_size,
                    options.max_plaintext_size,
                );
                let bytes_read = read_chunk(reader, &mut buffer[..read_limit])?;
                if bytes_read == 0 {
                    break;
                }
                let next_total = total_size.checked_add(bytes_read as u64).ok_or_else(|| {
                    StorageError::Validation("attachment content size overflow".to_string())
                })?;
                if next_total > options.max_plaintext_size {
                    return Err(StorageError::Validation(format!(
                        "attachment content exceeds configured limit of {} bytes",
                        options.max_plaintext_size
                    )));
                }
                let chunk = &buffer[..bytes_read];
                let chunk_hash = compute_sha256_hex(chunk);
                match target {
                    AttachmentContentTarget::Embedded { .. } => {
                        let chunk_ct =
                            Self::encrypt_attachment_field(conn, attachment_id, "chunk", chunk)?;
                        conn.inner().execute(
                            "INSERT INTO attachment_chunks (attachment_id, chunk_index, chunk_hash,
                         chunk_ct, external_uri_ct, stored_size, created_at)
                         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)",
                            params![
                                attachment_id,
                                i64::from(chunk_count),
                                chunk_hash,
                                chunk_ct,
                                chunk.len() as i64,
                                now,
                            ],
                        )?;
                    }
                    AttachmentContentTarget::External(blob_store) => {
                        let chunk_index = i64::from(chunk_count);
                        let chunk_field = external_chunk_field(chunk_index);
                        let encrypted_blob = Self::encrypt_attachment_field(
                            conn,
                            attachment_id,
                            &chunk_field,
                            chunk,
                        )?;
                        let blob_id = compute_blob_id(&encrypted_blob);
                        blob_store.put(&blob_id, &encrypted_blob)?;
                        let reference_field = external_reference_field(chunk_index);
                        let external_uri_ct = Self::encrypt_attachment_field(
                            conn,
                            attachment_id,
                            &reference_field,
                            blob_id.as_bytes(),
                        )?;
                        conn.inner().execute(
                            "INSERT INTO attachment_chunks (attachment_id, chunk_index, chunk_hash,
                         chunk_ct, external_uri_ct, stored_size, created_at)
                         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6)",
                            params![
                                attachment_id,
                                chunk_index,
                                chunk_hash,
                                external_uri_ct,
                                chunk.len() as i64,
                                now,
                            ],
                        )?;
                    }
                }
                content_hasher.update(chunk);
                total_size = next_total;
                chunk_count = chunk_count.checked_add(1).ok_or_else(|| {
                    StorageError::Validation("attachment chunk count overflow".to_string())
                })?;
            }

            if let Some(expected_size) = options.expected_plaintext_size {
                if total_size != expected_size {
                    return Err(StorageError::Validation(format!(
                        "attachment content size changed: expected {}, read {}",
                        expected_size, total_size
                    )));
                }
            }

            let content_hash = format!("{:x}", content_hasher.finalize());
            let storage_mode = match target {
                AttachmentContentTarget::External(_) => "external-hash-ref",
                AttachmentContentTarget::Embedded {
                    force_chunked_mode: true,
                } => "embedded-chunked",
                AttachmentContentTarget::Embedded {
                    force_chunked_mode: false,
                } if chunk_count > 1 => "embedded-chunked",
                AttachmentContentTarget::Embedded {
                    force_chunked_mode: false,
                } => "embedded-inline",
            };

            // 更新 attachments 元数据
            conn.inner().execute(
                "UPDATE attachments SET
                content_hash = ?2, stored_size = ?3, chunk_count = ?4,
                storage_mode = ?5,
                head_commit_id = ?6, updated_at = ?7, updated_by_device_id = ?8
             WHERE attachment_id = ?1",
                params![
                    attachment_id,
                    content_hash,
                    total_size as i64,
                    chunk_count,
                    storage_mode,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_attachment_current(conn, &commit_id, attachment_id)?;

            Ok(content_hash)
        })
    }

    fn validate_write_options(options: AttachmentWriteOptions) -> StorageResult<()> {
        if options.chunk_size == 0 {
            return Err(StorageError::Validation(
                "chunk_size must be greater than zero".to_string(),
            ));
        }
        if options.max_plaintext_size > i64::MAX as u64 {
            return Err(StorageError::Validation(
                "max_plaintext_size exceeds SQLite integer range".to_string(),
            ));
        }
        if options
            .expected_plaintext_size
            .is_some_and(|expected| expected > options.max_plaintext_size)
        {
            return Err(StorageError::Validation(
                "expected_plaintext_size exceeds max_plaintext_size".to_string(),
            ));
        }
        Ok(())
    }

    /// 校验每个 chunk 的独立 hash。
    pub fn verify_chunks_integrity(
        conn: &VaultConnection,
        attachment_id: &str,
    ) -> StorageResult<bool> {
        Self::verify_chunks_integrity_inner(conn, attachment_id, None)
    }

    /// 使用调用方提供的 Blob Provider 校验每个外部或内嵌分块。
    pub fn verify_chunks_integrity_with_blob_store(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: &dyn EncryptedBlobStore,
    ) -> StorageResult<bool> {
        Self::verify_chunks_integrity_inner(conn, attachment_id, Some(blob_store))
    }

    fn verify_chunks_integrity_inner(
        conn: &VaultConnection,
        attachment_id: &str,
        blob_store: Option<&dyn EncryptedBlobStore>,
    ) -> StorageResult<bool> {
        let att = AttachmentRepo::get_by_id(conn, attachment_id)?
            .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))?;
        Self::require_blob_store_for_mode(&att.storage_mode, attachment_id, blob_store)?;

        if att.chunk_count == 0 {
            return Ok(true);
        }

        let mut stmt = conn.inner().prepare(
            "SELECT chunk_index, chunk_hash, chunk_ct, external_uri_ct, stored_size
             FROM attachment_chunks
             WHERE attachment_id = ?1
             ORDER BY chunk_index",
        )?;

        let rows = stmt.query_map(params![attachment_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<Vec<u8>>>(2)?,
                row.get::<_, Option<Vec<u8>>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;

        for row in rows {
            let (index, expected_hash, chunk_ct, external_uri_ct, stored_size) = row?;
            let plaintext = match Self::load_chunk_plaintext(
                conn,
                attachment_id,
                &att.storage_mode,
                index,
                stored_size,
                chunk_ct,
                external_uri_ct,
                blob_store,
            ) {
                Ok(plaintext) => plaintext,
                Err(_) => return Ok(false),
            };
            let computed = compute_sha256_hex(&plaintext);
            if computed != expected_hash {
                return Ok(false);
            }
        }

        Ok(true)
    }

    fn require_blob_store_for_mode(
        storage_mode: &StorageMode,
        attachment_id: &str,
        blob_store: Option<&dyn EncryptedBlobStore>,
    ) -> StorageResult<()> {
        if matches!(storage_mode, StorageMode::ExternalHashRef) && blob_store.is_none() {
            return Err(StorageError::EncryptedBlobStoreRequired {
                attachment_id: attachment_id.to_string(),
            });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn load_chunk_plaintext(
        conn: &VaultConnection,
        attachment_id: &str,
        storage_mode: &StorageMode,
        chunk_index: i64,
        stored_size: i64,
        chunk_ct: Option<Vec<u8>>,
        external_uri_ct: Option<Vec<u8>>,
        blob_store: Option<&dyn EncryptedBlobStore>,
    ) -> StorageResult<Vec<u8>> {
        match storage_mode {
            StorageMode::EmbeddedInline | StorageMode::EmbeddedChunked => {
                let encrypted = match (chunk_ct, external_uri_ct) {
                    (Some(encrypted), None) => encrypted,
                    _ => {
                        return Err(StorageError::ConstraintViolation(format!(
                            "embedded attachment chunk {chunk_index} has invalid storage columns"
                        )))
                    }
                };
                Self::decrypt_attachment_field(conn, attachment_id, "chunk", &encrypted)
            }
            StorageMode::ExternalHashRef => {
                let encrypted_reference = match (chunk_ct, external_uri_ct) {
                    (None, Some(reference)) => reference,
                    _ => {
                        return Err(StorageError::ConstraintViolation(format!(
                            "external attachment chunk {chunk_index} has invalid storage columns"
                        )))
                    }
                };
                let blob_id = Self::decrypt_external_blob_id(
                    conn,
                    attachment_id,
                    chunk_index,
                    &encrypted_reference,
                )?;
                let blob_store =
                    blob_store.ok_or_else(|| StorageError::EncryptedBlobStoreRequired {
                        attachment_id: attachment_id.to_string(),
                    })?;
                let max_bytes = external_blob_read_limit(stored_size)?;
                let encrypted_blob = blob_store.get(&blob_id, max_bytes)?;
                if encrypted_blob.len() > max_bytes {
                    return Err(StorageError::BlobStore(format!(
                        "blob {blob_id} exceeded the repository read limit"
                    )));
                }
                if compute_blob_id(&encrypted_blob) != blob_id {
                    return Err(StorageError::BlobStore(format!(
                        "blob {blob_id} failed repository SHA-256 verification"
                    )));
                }
                let chunk_field = external_chunk_field(chunk_index);
                Self::decrypt_attachment_field(conn, attachment_id, &chunk_field, &encrypted_blob)
            }
        }
    }

    // -----------------------------------------------------------------------
    // ENCRYPTION HELPERS
    // -----------------------------------------------------------------------

    pub(crate) fn encrypt_attachment_field(
        conn: &VaultConnection,
        id: &str,
        field: &str,
        plaintext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        encrypt_field(
            conn,
            FieldKeyPurpose::Attachment,
            plaintext,
            "attachment",
            id,
            field,
        )
    }

    pub(crate) fn decrypt_attachment_field(
        conn: &VaultConnection,
        id: &str,
        field: &str,
        ciphertext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        decrypt_field(
            conn,
            FieldKeyPurpose::Attachment,
            ciphertext,
            "attachment",
            id,
            field,
        )
    }

    pub(crate) fn decrypt_external_blob_id(
        conn: &VaultConnection,
        attachment_id: &str,
        chunk_index: i64,
        encrypted_reference: &[u8],
    ) -> StorageResult<String> {
        let reference_field = external_reference_field(chunk_index);
        let reference = Self::decrypt_attachment_field(
            conn,
            attachment_id,
            &reference_field,
            encrypted_reference,
        )?;
        let blob_id = std::str::from_utf8(&reference).map_err(|_| {
            StorageError::ConstraintViolation(format!(
                "external attachment chunk {chunk_index} has a non-UTF-8 blob ID"
            ))
        })?;
        validate_blob_id(blob_id).map_err(|error| {
            StorageError::ConstraintViolation(format!(
                "external attachment chunk {chunk_index} has an invalid blob ID: {error}"
            ))
        })?;
        Ok(blob_id.to_string())
    }
}

fn read_chunk(reader: &mut dyn Read, buffer: &mut [u8]) -> StorageResult<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(StorageError::Io(error)),
        }
    }
    Ok(filled)
}

fn next_attachment_read_limit(buffer_size: usize, total_size: u64, max_size: u64) -> usize {
    let remaining = max_size.saturating_sub(total_size);
    if remaining >= buffer_size as u64 {
        buffer_size
    } else {
        (remaining as usize).saturating_add(1).min(buffer_size)
    }
}

/// 计算 SHA-256 并返回 hex 字符串。
fn compute_sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn external_chunk_field(chunk_index: i64) -> String {
    format!("external_chunk:{chunk_index}")
}

fn external_reference_field(chunk_index: i64) -> String {
    format!("external_uri:{chunk_index}")
}

pub(crate) fn external_blob_read_limit(stored_size: i64) -> StorageResult<usize> {
    let plaintext_size = u64::try_from(stored_size).map_err(|_| {
        StorageError::ConstraintViolation("external chunk has a negative stored size".to_string())
    })?;
    let maximum = plaintext_size
        .checked_add(MAX_EXTERNAL_BLOB_ENVELOPE_OVERHEAD)
        .ok_or_else(|| StorageError::Validation("external blob size limit overflow".to_string()))?;
    usize::try_from(maximum).map_err(|_| {
        StorageError::Validation("external blob size exceeds platform limits".to_string())
    })
}

pub(crate) fn parse_storage_mode(column: usize, value: &str) -> rusqlite::Result<StorageMode> {
    value.parse().map_err(|message: String| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                message,
            )),
        )
    })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{Cursor, ErrorKind};
    use std::sync::Mutex;

    #[cfg(feature = "filesystem-blob-store")]
    use crate::blob_store::FileSystemBlobStore;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::entry::EntryRepo;
    use crate::repo::project::ProjectRepo;

    fn setup() -> (VaultConnection, CommitContext, String) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Parent Project", None, None).unwrap();
        (conn, ctx, project.project_id)
    }

    fn setup_encrypted() -> (VaultConnection, CommitContext, String) {
        let (mut conn, ctx, project_id) = setup();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring =
            mdbx_crypto::keyring::Keyring::from_vault_key(&vault_key, b"external-blob-tests")
                .unwrap();
        conn.attach_keyring(keyring);
        (conn, ctx, project_id)
    }

    fn login_payload() -> serde_json::Value {
        serde_json::json!({"username": "alice", "password": "secret"})
    }

    // -----------------------------------------------------------------------
    // CREATE
    // -----------------------------------------------------------------------

    #[test]
    fn test_add_attachment_to_project() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add_with_request(
            &conn,
            &ctx,
            AttachmentCreateRequest {
                project_id: &project_id,
                entry_id: None,
                file_name: "screenshot.png",
                media_type: Some("image/png"),
                content_hash: "abc123hash",
                original_size: 1024,
            },
        )
        .unwrap();

        assert!(!att.attachment_id.is_empty());
        assert_eq!(att.project_id, project_id);
        assert_eq!(att.entry_id, None);
        assert_eq!(att.file_name_ct, b"screenshot.png");
        assert_eq!(att.media_type_ct, Some(b"image/png".to_vec()));
        assert_eq!(att.content_hash, "abc123hash");
        assert_eq!(att.original_size, 1024);
        assert_eq!(att.stored_size, 1024);
        assert_eq!(att.storage_mode, StorageMode::EmbeddedInline);
        assert!(!att.deleted);
        assert!(!att.head_commit_id.is_empty());
    }

    #[test]
    fn stable_attachment_id_is_additive_and_duplicate_creation_rolls_back() {
        let (conn, ctx, project_id) = setup();
        let attachment_id = Uuid::new_v4().to_string();
        let request = AttachmentCreateRequest {
            project_id: &project_id,
            entry_id: None,
            file_name: "stable.bin",
            media_type: None,
            content_hash: "",
            original_size: 0,
        };
        let created = AttachmentRepo::add_with_id(&conn, &ctx, &attachment_id, request).unwrap();
        assert_eq!(created.attachment_id, attachment_id);
        let commit_count: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();

        let duplicate = AttachmentRepo::add_with_id(
            &conn,
            &ctx,
            &attachment_id,
            AttachmentCreateRequest {
                project_id: &project_id,
                entry_id: None,
                file_name: "duplicate.bin",
                media_type: None,
                content_hash: "",
                original_size: 0,
            },
        );
        assert!(duplicate.is_err());
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            commit_count
        );
        assert!(AttachmentRepo::add_with_id(
            &conn,
            &ctx,
            "not-a-uuid",
            AttachmentCreateRequest {
                project_id: &project_id,
                entry_id: None,
                file_name: "invalid.bin",
                media_type: None,
                content_hash: "",
                original_size: 0,
            },
        )
        .is_err());
    }

    #[test]
    fn test_add_attachment_to_entry() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("My Login"),
            &login_payload(),
        )
        .unwrap();

        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&entry.entry_id),
            "avatar.jpg",
            Some("image/jpeg"),
            "hash999",
            2048,
        )
        .unwrap();

        assert_eq!(att.project_id, project_id);
        assert_eq!(att.entry_id, Some(entry.entry_id));
    }

    #[test]
    fn test_add_to_nonexistent_project() {
        let (conn, ctx, _project_id) = setup();
        let result = AttachmentRepo::add(
            &conn,
            &ctx,
            "nonexistent",
            None,
            "file.txt",
            None,
            "hash",
            100,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_add_to_deleted_project() {
        let (conn, ctx, project_id) = setup();
        ProjectRepo::soft_delete(&conn, &ctx, &project_id).unwrap();
        let result = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "file.txt",
            None,
            "hash",
            100,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_add_to_nonexistent_entry() {
        let (conn, ctx, project_id) = setup();
        let result = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some("nonexistent"),
            "file.txt",
            None,
            "hash",
            100,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_add_entry_attachment_wrong_project() {
        let (conn, ctx, _project_id) = setup();
        let project2 = ProjectRepo::create(&conn, &ctx, "Project 2", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project2.project_id,
            mdbx_core::model::EntryType::Note,
            None,
            &serde_json::json!({"text":"hi"}),
        )
        .unwrap();

        // 尝试把 entry 的附件挂到错误的 project
        // 先创建另一个 project
        let project3 = ProjectRepo::create(&conn, &ctx, "Project 3", None, None).unwrap();
        let result = AttachmentRepo::add(
            &conn,
            &ctx,
            &project3.project_id,
            Some(&entry.entry_id),
            "file.txt",
            None,
            "hash",
            100,
        );
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_by_id() {
        let (conn, ctx, project_id) = setup();
        let created = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "doc.pdf",
            Some("application/pdf"),
            "hash123",
            4096,
        )
        .unwrap();

        let found = AttachmentRepo::get_by_id(&conn, &created.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(found.attachment_id, created.attachment_id);
        assert_eq!(found.content_hash, "hash123");
    }

    #[test]
    fn test_list_by_project() {
        let (conn, ctx, project_id) = setup();
        AttachmentRepo::add(&conn, &ctx, &project_id, None, "a.txt", None, "h1", 10).unwrap();
        AttachmentRepo::add(&conn, &ctx, &project_id, None, "b.txt", None, "h2", 20).unwrap();

        let all = AttachmentRepo::list_by_project(&conn, &project_id).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_list_by_entry() {
        let (conn, ctx, project_id) = setup();
        let e1 = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("E1"),
            &login_payload(),
        )
        .unwrap();
        let e2 = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Note,
            Some("E2"),
            &serde_json::json!({"text":"hi"}),
        )
        .unwrap();

        AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&e1.entry_id),
            "f1.txt",
            None,
            "h1",
            10,
        )
        .unwrap();
        AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&e2.entry_id),
            "f2.txt",
            None,
            "h2",
            10,
        )
        .unwrap();
        AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&e1.entry_id),
            "f3.txt",
            None,
            "h3",
            10,
        )
        .unwrap();

        assert_eq!(
            AttachmentRepo::list_by_entry(&conn, &e1.entry_id)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            AttachmentRepo::list_by_entry(&conn, &e2.entry_id)
                .unwrap()
                .len(),
            1
        );
    }

    // -----------------------------------------------------------------------
    // RENAME
    // -----------------------------------------------------------------------

    #[test]
    fn test_rename_preserves_content_hash() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "old_name.txt",
            Some("text/plain"),
            "original-hash",
            500,
        )
        .unwrap();

        let renamed = AttachmentRepo::rename(
            &conn,
            &ctx,
            &att.attachment_id,
            "new_name.txt",
            Some("text/plain"),
        )
        .unwrap();

        assert_eq!(renamed.file_name_ct, b"new_name.txt");
        // content_hash 不变
        assert_eq!(renamed.content_hash, "original-hash");
        // head_commit_id 变化
        assert_ne!(renamed.head_commit_id, att.head_commit_id);
    }

    #[test]
    fn test_rename_generates_commit() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "old.txt", None, "hash", 100)
            .unwrap();
        let old_commit = att.head_commit_id.clone();

        let renamed =
            AttachmentRepo::rename(&conn, &ctx, &att.attachment_id, "new.txt", None).unwrap();

        let parent: String = conn
            .inner()
            .query_row(
                "SELECT parent_commit_id FROM commit_parents WHERE commit_id = ?1",
                params![renamed.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, old_commit);
    }

    // -----------------------------------------------------------------------
    // SOFT DELETE
    // -----------------------------------------------------------------------

    #[test]
    fn test_soft_delete() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "delete_me.txt",
            None,
            "hash",
            10,
        )
        .unwrap();

        AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).unwrap();

        let deleted = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert!(deleted.deleted);

        // 被删除的不在活跃列表中
        assert!(AttachmentRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .is_empty());
        assert_eq!(AttachmentRepo::list_deleted(&conn).unwrap().len(), 1);
    }

    #[test]
    fn test_double_delete_rejected() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "once.txt", None, "hash", 10)
            .unwrap();

        AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).unwrap();
        assert!(AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).is_err());
    }

    #[test]
    fn test_rename_deleted_rejected() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "gone.txt", None, "hash", 10)
            .unwrap();

        AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).unwrap();
        assert!(AttachmentRepo::rename(&conn, &ctx, &att.attachment_id, "nope.txt", None).is_err());
    }

    // -----------------------------------------------------------------------
    // COUNT
    // -----------------------------------------------------------------------

    #[test]
    fn test_count_for_project() {
        let (conn, ctx, project_id) = setup();
        assert_eq!(
            AttachmentRepo::count_for_project(&conn, &project_id).unwrap(),
            0
        );

        AttachmentRepo::add(&conn, &ctx, &project_id, None, "a.txt", None, "h1", 10).unwrap();
        AttachmentRepo::add(&conn, &ctx, &project_id, None, "b.txt", None, "h2", 20).unwrap();
        assert_eq!(
            AttachmentRepo::count_for_project(&conn, &project_id).unwrap(),
            2
        );

        // 删除一个
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "c.txt", None, "h3", 30).unwrap();
        AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).unwrap();
        assert_eq!(
            AttachmentRepo::count_for_project(&conn, &project_id).unwrap(),
            2
        );
    }

    // -----------------------------------------------------------------------
    // INLINE CONTENT
    // -----------------------------------------------------------------------

    #[test]
    fn test_write_and_read_inline_content() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "data.bin",
            Some("application/octet-stream"),
            "",
            0, // hash 和 size 由 write_inline_content 更新
        )
        .unwrap();

        let content = b"Hello, MDBX inline attachment!";
        let hash =
            AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, content).unwrap();

        // hash 应该是 SHA-256 hex
        assert_eq!(hash.len(), 64);

        // 读回内容
        let data = AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap();
        assert_eq!(data, content);

        // metadata 已更新
        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.content_hash, hash);
        assert_eq!(refreshed.stored_size, content.len() as u64);
        assert_eq!(refreshed.chunk_count, 1);
        assert_eq!(refreshed.storage_mode, StorageMode::EmbeddedInline);
    }

    #[test]
    fn test_write_inline_updates_content_hash() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "file.bin", None, "", 0).unwrap();

        let content_v1 = b"version 1";
        let hash_v1 =
            AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, content_v1)
                .unwrap();

        let content_v2 = b"version 2 - different content";
        let hash_v2 =
            AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, content_v2)
                .unwrap();

        assert_ne!(hash_v1, hash_v2);
        assert_eq!(
            AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap(),
            content_v2
        );
    }

    #[test]
    fn test_integrity_verification_passes() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "ok.bin", None, "", 0).unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"clean data")
            .unwrap();

        assert!(AttachmentRepo::verify_integrity(&conn, &att.attachment_id).unwrap());
    }

    #[test]
    fn test_integrity_verification_preserves_legacy_deleted_and_missing_behavior() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "deleted.bin", None, "", 4)
            .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"data").unwrap();
        AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).unwrap();

        assert!(AttachmentRepo::verify_integrity(&conn, &att.attachment_id).unwrap());
        assert!(matches!(
            AttachmentRepo::verify_integrity(&conn, "missing-attachment"),
            Err(StorageError::NotFound(_))
        ));
    }

    #[test]
    fn test_integrity_verification_fails_on_tamper() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "tamper.bin", None, "", 0).unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"original data")
            .unwrap();

        // 直接在数据库层面篡改 chunk 内容
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = ?1
             WHERE attachment_id = ?2 AND chunk_index = 0",
                params![b"tampered!!", att.attachment_id],
            )
            .unwrap();

        // 验证应失败
        assert!(!AttachmentRepo::verify_integrity(&conn, &att.attachment_id).unwrap());

        // 读取应报错
        assert!(AttachmentRepo::read_content(&conn, &att.attachment_id).is_err());
    }

    #[test]
    fn test_hash_mismatch_on_content_hash_tamper() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "hash-tamper.bin",
            None,
            "",
            0,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"real data")
            .unwrap();

        // 篡改 attachments 表中的 content_hash
        conn.inner().execute(
            "UPDATE attachments SET content_hash = '0000000000000000000000000000000000000000000000000000000000000000'
             WHERE attachment_id = ?1",
            params![att.attachment_id],
        ).unwrap();

        assert!(!AttachmentRepo::verify_integrity(&conn, &att.attachment_id).unwrap());
        assert!(AttachmentRepo::read_content(&conn, &att.attachment_id).is_err());
    }

    #[test]
    fn test_read_empty_attachment() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "empty.bin",
            None,
            "unused",
            0,
        )
        .unwrap();

        // 没有写入内容的附件返回空
        let data = AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap();
        assert!(data.is_empty());
    }

    #[test]
    fn test_write_to_deleted_attachment_rejected() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "del.bin", None, "", 0).unwrap();
        AttachmentRepo::soft_delete(&conn, &ctx, &att.attachment_id).unwrap();

        assert!(
            AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"data",)
                .is_err()
        );
    }

    #[test]
    fn test_compute_sha256_hex() {
        let hash = compute_sha256_hex(b"hello");
        // SHA-256("hello") = 2cf24dba...
        assert_eq!(
            hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    // -----------------------------------------------------------------------
    // CHUNKED CONTENT
    // -----------------------------------------------------------------------

    #[test]
    fn test_write_and_read_chunked_content() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "bigfile.bin",
            Some("application/octet-stream"),
            "",
            0,
        )
        .unwrap();

        // 写入 1KB 分块（每块 256 字节）
        let data: Vec<u8> = (0..1024).map(|i| (i % 256) as u8).collect();
        let hash =
            AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &data, 256)
                .unwrap();

        assert_eq!(hash.len(), 64);

        let read = AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap();
        assert_eq!(read, data);

        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.content_hash, hash);
        assert_eq!(refreshed.stored_size, 1024);
        assert_eq!(refreshed.chunk_count, 4);
        assert_eq!(refreshed.storage_mode, StorageMode::EmbeddedChunked);
    }

    #[test]
    fn test_streaming_content_roundtrip_uses_bounded_reads() {
        struct TrackingReader {
            inner: Cursor<Vec<u8>>,
            max_requested: usize,
        }

        impl Read for TrackingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.max_requested = self.max_requested.max(buffer.len());
                self.inner.read(buffer)
            }
        }

        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "stream.bin",
            Some("application/octet-stream"),
            "",
            1025,
        )
        .unwrap();
        let data: Vec<u8> = (0..1025).map(|index| (index % 251) as u8).collect();
        let mut reader = TrackingReader {
            inner: Cursor::new(data.clone()),
            max_requested: 0,
        };

        let hash = AttachmentRepo::write_content_from_reader(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            128,
        )
        .unwrap();
        assert!(reader.max_requested <= 128);

        let mut output = Vec::new();
        let written =
            AttachmentRepo::read_content_to_writer(&conn, &att.attachment_id, &mut output).unwrap();
        assert_eq!(written, data.len() as u64);
        assert_eq!(output, data);
        assert_eq!(hash, compute_sha256_hex(&output));

        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.chunk_count, 9);
        assert_eq!(refreshed.storage_mode, StorageMode::EmbeddedChunked);
    }

    #[test]
    fn test_streaming_single_chunk_uses_inline_mode() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "small.bin", None, "", 5).unwrap();
        let mut reader = Cursor::new(b"small".to_vec());

        AttachmentRepo::write_content_from_reader(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            128,
        )
        .unwrap();

        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.chunk_count, 1);
        assert_eq!(refreshed.storage_mode, StorageMode::EmbeddedInline);
    }

    #[test]
    fn test_streaming_empty_content_roundtrip() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "empty.bin", None, "", 0).unwrap();
        let mut reader = Cursor::new(Vec::<u8>::new());

        let hash = AttachmentRepo::write_content_from_reader(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            128,
        )
        .unwrap();

        assert_eq!(hash, compute_sha256_hex(&[]));
        assert!(AttachmentRepo::read_content(&conn, &att.attachment_id)
            .unwrap()
            .is_empty());
        assert!(AttachmentRepo::verify_integrity(&conn, &att.attachment_id).unwrap());
    }

    #[test]
    fn test_streaming_zero_chunk_size_is_validation_error() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "zero.bin", None, "", 0).unwrap();
        let mut reader = Cursor::new(b"data".to_vec());

        let error = AttachmentRepo::write_content_from_reader(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            0,
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Validation(_)));
    }

    #[test]
    fn test_bounded_streaming_reads_only_one_byte_beyond_limit_and_rolls_back() {
        struct CountingReader {
            inner: Cursor<Vec<u8>>,
            total_read: usize,
        }

        impl Read for CountingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let read = self.inner.read(buffer)?;
                self.total_read += read;
                Ok(read)
            }
        }

        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "bounded.bin", None, "", 8)
            .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"original").unwrap();
        let before = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut reader = CountingReader {
            inner: Cursor::new(vec![5; 100]),
            total_read: 0,
        };

        let error = AttachmentRepo::write_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::new(16, 50),
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Validation(_)));
        assert_eq!(reader.total_read, 51);

        let after = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let commit_count_after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(after.head_commit_id, before.head_commit_id);
        assert_eq!(commit_count_after, commit_count_before);
        assert_eq!(
            AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap(),
            b"original"
        );
    }

    #[test]
    fn test_exact_streaming_size_rejects_short_source_and_rolls_back() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "exact.bin", None, "", 8).unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"original").unwrap();
        let before = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let mut reader = Cursor::new(vec![1; 49]);

        let error = AttachmentRepo::write_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(16, 50),
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Validation(_)));

        let after = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(after.head_commit_id, before.head_commit_id);
        assert_eq!(
            AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap(),
            b"original"
        );
    }

    #[test]
    fn test_invalid_streaming_limits_are_rejected_before_reading() {
        struct PanicReader;

        impl Read for PanicReader {
            fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
                panic!("invalid options must be rejected before reading")
            }
        }

        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "invalid.bin", None, "", 0)
            .unwrap();
        let mut reader = PanicReader;

        let error = AttachmentRepo::write_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions {
                chunk_size: 16,
                max_plaintext_size: 10,
                expected_plaintext_size: Some(11),
            },
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Validation(_)));
    }

    #[test]
    fn test_small_total_limit_caps_chunk_buffer_allocation() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "empty-limit.bin",
            None,
            "",
            0,
        )
        .unwrap();
        let mut reader = Cursor::new(Vec::<u8>::new());

        let hash = AttachmentRepo::write_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(usize::MAX, 0),
        )
        .unwrap();

        assert_eq!(hash, compute_sha256_hex(&[]));
    }

    #[test]
    fn test_streaming_reader_failure_rolls_back_content_and_commit() {
        struct FailingReader {
            data: Vec<u8>,
            position: usize,
            fail_after: usize,
        }

        impl Read for FailingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.position >= self.fail_after {
                    return Err(std::io::Error::new(ErrorKind::Other, "reader failed"));
                }
                let available = self
                    .data
                    .len()
                    .min(self.fail_after)
                    .saturating_sub(self.position);
                if available == 0 {
                    return Ok(0);
                }
                let read = available.min(buffer.len());
                buffer[..read].copy_from_slice(&self.data[self.position..self.position + read]);
                self.position += read;
                Ok(read)
            }
        }

        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "rollback.bin", None, "", 8)
            .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"original").unwrap();
        let before = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut reader = FailingReader {
            data: vec![7; 512],
            position: 0,
            fail_after: 150,
        };

        let error = AttachmentRepo::write_content_from_reader(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            64,
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Io(ref io) if io.kind() == ErrorKind::Other));

        let after = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let commit_count_after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(after.chunk_count, before.chunk_count);
        assert_eq!(after.head_commit_id, before.head_commit_id);
        assert_eq!(commit_count_after, commit_count_before);
        assert_eq!(
            AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap(),
            b"original"
        );
    }

    #[test]
    fn test_streaming_writer_failure_preserves_io_error_kind() {
        struct FailingWriter {
            written: usize,
            fail_after: usize,
        }

        impl Write for FailingWriter {
            fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
                if self.written >= self.fail_after {
                    return Err(std::io::Error::new(ErrorKind::BrokenPipe, "writer failed"));
                }
                let written = buffer.len().min(self.fail_after - self.written);
                self.written += written;
                Ok(written)
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "writer.bin", None, "", 256)
            .unwrap();
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &[9; 256], 64)
            .unwrap();
        let mut writer = FailingWriter {
            written: 0,
            fail_after: 100,
        };

        let error = AttachmentRepo::read_content_to_writer(&conn, &att.attachment_id, &mut writer)
            .unwrap_err();
        assert!(matches!(error, StorageError::Io(ref io) if io.kind() == ErrorKind::BrokenPipe));
    }

    #[test]
    fn test_streaming_read_detects_chunk_hash_tamper() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "hash.bin", None, "", 128).unwrap();
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &[3; 128], 32)
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_hash = ?1
                 WHERE attachment_id = ?2 AND chunk_index = 1",
                params!["0".repeat(64), att.attachment_id],
            )
            .unwrap();

        let mut output = Vec::new();
        let error = AttachmentRepo::read_content_to_writer(&conn, &att.attachment_id, &mut output)
            .unwrap_err();
        assert!(matches!(error, StorageError::ConstraintViolation(_)));
    }

    #[test]
    fn test_chunks_have_sequential_indices() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "seq.bin", None, "", 0).unwrap();

        let data = b"0123456789".repeat(10); // 100 bytes
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &data, 30).unwrap();

        // 验证 chunk_index 0,1,2,3 连续
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT chunk_index FROM attachment_chunks
             WHERE attachment_id = ?1 ORDER BY chunk_index",
            )
            .unwrap();
        let indices: Vec<i64> = stmt
            .query_map(params![att.attachment_id], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(indices, vec![0, 1, 2, 3]);
    }

    #[test]
    fn test_per_chunk_hash_verification() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "perchunk.bin", None, "", 0)
            .unwrap();

        let data = b"AAAA".repeat(25); // 100 bytes
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &data, 25).unwrap();

        assert!(AttachmentRepo::verify_chunks_integrity(&conn, &att.attachment_id).unwrap());
    }

    #[test]
    fn test_chunk_integrity_detects_corruption() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "corrupt.bin", None, "", 0)
            .unwrap();

        let data = b"clean data for chunking test".repeat(10);
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &data, 50).unwrap();

        // 篡改第二个 chunk
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = ?1
             WHERE attachment_id = ?2 AND chunk_index = 1",
                params![b"TAMPERED_DATA_HERE!!!!!!!!!!!!!!!!!!!!", att.attachment_id],
            )
            .unwrap();

        assert!(!AttachmentRepo::verify_chunks_integrity(&conn, &att.attachment_id).unwrap());
        assert!(AttachmentRepo::read_content(&conn, &att.attachment_id).is_err());
    }

    #[test]
    fn test_metadata_update_does_not_rewrite_chunks() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "oldname.bin", None, "", 0)
            .unwrap();

        let data = b"chunked content for rename test".repeat(20);
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &data, 100).unwrap();

        let fresh = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let original_chunk_count = fresh.chunk_count;
        let original_stored_size = fresh.stored_size;

        // 改名不应影响 chunk 数据
        let renamed =
            AttachmentRepo::rename(&conn, &ctx, &att.attachment_id, "newname.bin", None).unwrap();

        assert_eq!(renamed.file_name_ct, b"newname.bin");
        assert_eq!(renamed.chunk_count, original_chunk_count);
        assert_eq!(renamed.stored_size, original_stored_size);
        assert_eq!(renamed.storage_mode, StorageMode::EmbeddedChunked);
    }

    #[test]
    fn test_read_content_concatenates_chunks_correctly() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "concat.bin", None, "", 0).unwrap();

        // 创建内容：每 chunk 不同内容，确保拼接顺序正确
        let chunk0 = [0u8; 50];
        let chunk1 = [1u8; 50];
        let chunk2 = [2u8; 50];
        let all_data: Vec<u8> = [&chunk0[..], &chunk1[..], &chunk2[..]].concat();

        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &all_data, 50)
            .unwrap();

        let read = AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap();
        assert_eq!(read, all_data);
        assert_eq!(&read[0..50], &chunk0[..]);
        assert_eq!(&read[50..100], &chunk1[..]);
        assert_eq!(&read[100..150], &chunk2[..]);
    }

    #[test]
    fn test_chunked_storage_mode_set() {
        let (conn, ctx, project_id) = setup();
        let att =
            AttachmentRepo::add(&conn, &ctx, &project_id, None, "mode.bin", None, "", 0).unwrap();

        let data = b"test data for mode verification".repeat(100);
        AttachmentRepo::write_chunked_content(&conn, &ctx, &att.attachment_id, &data, 256).unwrap();

        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.storage_mode, StorageMode::EmbeddedChunked);
        assert_eq!(
            refreshed.chunk_count,
            (data.len() as f64 / 256.0).ceil() as u32
        );
    }

    // -----------------------------------------------------------------------
    // ENCRYPTION INTEGRATION
    // -----------------------------------------------------------------------

    #[test]
    fn test_attachment_encrypted_with_keyring() {
        use crate::init::{initialize_vault, VaultInitParams};
        use crate::repo::commit_ctx::CommitContext;
        use mdbx_crypto::keyring::Keyring;

        let mut conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();

        let vault_ctx = b"test-vault-ctx";
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring = Keyring::from_vault_key(&vault_key, vault_ctx).unwrap();
        conn.attach_keyring(keyring);

        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();

        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "secret-doc.pdf",
            Some("application/pdf"),
            "abc123",
            4096,
        )
        .unwrap();

        // 通过 API 读回是明文
        let found = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(found.file_name_ct, b"secret-doc.pdf");
        assert_eq!(found.media_type_ct, Some(b"application/pdf".to_vec()));

        // 数据库中存的是密文
        let raw_name: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT file_name_ct FROM attachments WHERE attachment_id = ?1",
                params![att.attachment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(raw_name, b"secret-doc.pdf");

        // inline content 也应加密
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"top secret data")
            .unwrap();
        let raw_chunk: Vec<u8> = conn.inner().query_row(
            "SELECT chunk_ct FROM attachment_chunks WHERE attachment_id = ?1 AND chunk_index = 0",
            params![att.attachment_id],
            |row| row.get(0),
        ).unwrap();
        assert_ne!(raw_chunk, b"top secret data");

        // 读回明文
        let plaintext = AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap();
        assert_eq!(plaintext, b"top secret data");
    }

    #[test]
    fn test_encrypted_attachment_tamper_is_rejected() {
        use crate::init::{initialize_vault, VaultInitParams};
        use crate::repo::commit_ctx::CommitContext;
        use mdbx_crypto::keyring::Keyring;

        let mut conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();

        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring = Keyring::from_vault_key(&vault_key, b"attachment-tamper-test").unwrap();
        conn.attach_keyring(keyring);

        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "secret.bin",
            None,
            "",
            0,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"secret").unwrap();

        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = ?1 WHERE attachment_id = ?2 AND chunk_index = 0",
                params![b"not-valid-ciphertext".as_slice(), att.attachment_id],
            )
            .unwrap();

        assert!(AttachmentRepo::read_content(&conn, &att.attachment_id).is_err());
        assert!(!AttachmentRepo::verify_chunks_integrity(&conn, &att.attachment_id).unwrap());
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn external_content_roundtrip_keeps_only_encrypted_references_in_database() {
        let (conn, ctx, project_id) = setup_encrypted();
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let data = b"external secret payload ".repeat(20);
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "mail.eml",
            Some("message/rfc822"),
            "",
            data.len() as u64,
        )
        .unwrap();
        let mut reader = Cursor::new(&data);

        let hash = AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(64, data.len() as u64),
            &store,
        )
        .unwrap();

        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.storage_mode, StorageMode::ExternalHashRef);
        assert_eq!(refreshed.chunk_count, data.len().div_ceil(64) as u32);
        assert_eq!(hash, compute_sha256_hex(&data));
        let (embedded_count, external_count): (i64, i64) = conn
            .inner()
            .query_row(
                "SELECT COUNT(chunk_ct), COUNT(external_uri_ct)
                 FROM attachment_chunks WHERE attachment_id = ?1",
                params![att.attachment_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(embedded_count, 0);
        assert_eq!(external_count, i64::from(refreshed.chunk_count));

        let encrypted_reference: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT external_uri_ct FROM attachment_chunks
                 WHERE attachment_id = ?1 AND chunk_index = 0",
                params![att.attachment_id],
                |row| row.get(0),
            )
            .unwrap();
        let reference = AttachmentRepo::decrypt_attachment_field(
            &conn,
            &att.attachment_id,
            &external_reference_field(0),
            &encrypted_reference,
        )
        .unwrap();
        assert_ne!(encrypted_reference, reference);
        let blob_id = std::str::from_utf8(&reference).unwrap();
        let encrypted_blob = store
            .get(blob_id, 64 + MAX_EXTERNAL_BLOB_ENVELOPE_OVERHEAD as usize)
            .unwrap();
        assert_ne!(encrypted_blob, data[..64]);

        assert_eq!(
            AttachmentRepo::read_content_with_blob_store(&conn, &att.attachment_id, &store)
                .unwrap(),
            data
        );
        assert!(AttachmentRepo::verify_integrity_with_blob_store(
            &conn,
            &att.attachment_id,
            &store
        )
        .unwrap());
        assert!(AttachmentRepo::verify_chunks_integrity_with_blob_store(
            &conn,
            &att.attachment_id,
            &store
        )
        .unwrap());
        assert!(matches!(
            AttachmentRepo::read_content(&conn, &att.attachment_id),
            Err(StorageError::EncryptedBlobStoreRequired { .. })
        ));
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn external_content_rejects_missing_corrupt_and_mixed_blob_material() {
        let (conn, ctx, project_id) = setup_encrypted();
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let data = b"encrypted external data".repeat(8);
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "external.bin",
            None,
            "",
            data.len() as u64,
        )
        .unwrap();
        let mut reader = Cursor::new(&data);
        AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(64, data.len() as u64),
            &store,
        )
        .unwrap();

        let encrypted_reference: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT external_uri_ct FROM attachment_chunks
                 WHERE attachment_id = ?1 AND chunk_index = 0",
                params![att.attachment_id],
                |row| row.get(0),
            )
            .unwrap();
        let reference = AttachmentRepo::decrypt_attachment_field(
            &conn,
            &att.attachment_id,
            &external_reference_field(0),
            &encrypted_reference,
        )
        .unwrap();
        let blob_id = std::str::from_utf8(&reference).unwrap();
        let path = store.blob_path(blob_id).unwrap();

        std::fs::remove_file(&path).unwrap();
        assert!(matches!(
            AttachmentRepo::read_content_with_blob_store(&conn, &att.attachment_id, &store),
            Err(StorageError::BlobStore(_))
        ));
        std::fs::write(&path, b"corrupt ciphertext").unwrap();
        assert!(matches!(
            AttachmentRepo::read_content_with_blob_store(&conn, &att.attachment_id, &store),
            Err(StorageError::BlobStore(_))
        ));

        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = ?1
                 WHERE attachment_id = ?2 AND chunk_index = 0",
                params![b"unexpected".as_slice(), att.attachment_id],
            )
            .unwrap();
        assert!(matches!(
            AttachmentRepo::read_content_with_blob_store(&conn, &att.attachment_id, &store),
            Err(StorageError::ConstraintViolation(_))
        ));
    }

    #[test]
    fn external_content_requires_encryption_before_provider_access() {
        struct PanicStore;

        impl EncryptedBlobStore for PanicStore {
            fn put(&self, _blob_id: &str, _encrypted_blob: &[u8]) -> StorageResult<()> {
                panic!("unencrypted vault must be rejected before provider access")
            }

            fn get(&self, _blob_id: &str, _max_bytes: usize) -> StorageResult<Vec<u8>> {
                panic!("get must not be called")
            }
        }

        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(&conn, &ctx, &project_id, None, "plaintext.bin", None, "", 3)
            .unwrap();
        let mut reader = Cursor::new(b"raw");
        let error = AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(3, 3),
            &PanicStore,
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::Validation(_)));
    }

    #[test]
    fn external_reader_failure_rolls_back_database_and_may_leave_encrypted_orphans() {
        #[derive(Default)]
        struct RecordingStore {
            blobs: Mutex<HashMap<String, Vec<u8>>>,
        }

        impl EncryptedBlobStore for RecordingStore {
            fn put(&self, blob_id: &str, encrypted_blob: &[u8]) -> StorageResult<()> {
                self.blobs
                    .lock()
                    .unwrap()
                    .insert(blob_id.to_string(), encrypted_blob.to_vec());
                Ok(())
            }

            fn get(&self, blob_id: &str, max_bytes: usize) -> StorageResult<Vec<u8>> {
                let blob = self
                    .blobs
                    .lock()
                    .unwrap()
                    .get(blob_id)
                    .cloned()
                    .ok_or_else(|| StorageError::BlobStore("missing test blob".to_string()))?;
                if blob.len() > max_bytes {
                    return Err(StorageError::BlobStore("oversized test blob".to_string()));
                }
                Ok(blob)
            }
        }

        struct FailingReader {
            data: Vec<u8>,
            position: usize,
            fail_after: usize,
        }

        impl Read for FailingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.position >= self.fail_after {
                    return Err(std::io::Error::new(ErrorKind::Other, "reader failed"));
                }
                let available = self.fail_after.min(self.data.len()) - self.position;
                let read = available.min(buffer.len());
                buffer[..read].copy_from_slice(&self.data[self.position..self.position + read]);
                self.position += read;
                Ok(read)
            }
        }

        let (conn, ctx, project_id) = setup_encrypted();
        let store = RecordingStore::default();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "rollback-external.bin",
            None,
            "",
            8,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"original").unwrap();
        let before = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut reader = FailingReader {
            data: vec![7; 256],
            position: 0,
            fail_after: 100,
        };

        let error = AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::new(64, 256),
            &store,
        )
        .unwrap_err();

        assert!(matches!(error, StorageError::Io(ref io) if io.kind() == ErrorKind::Other));
        let after = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let commit_count_after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(after.storage_mode, StorageMode::EmbeddedInline);
        assert_eq!(after.content_hash, before.content_hash);
        assert_eq!(after.head_commit_id, before.head_commit_id);
        assert_eq!(commit_count_after, commit_count_before);
        assert_eq!(
            AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap(),
            b"original"
        );
        let orphaned_blobs = store.blobs.lock().unwrap();
        assert_eq!(orphaned_blobs.len(), 1);
        assert_ne!(orphaned_blobs.values().next().unwrap(), &vec![7; 64]);
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn external_repository_rejects_provider_output_beyond_declared_limit() {
        struct OversizedStore;

        impl EncryptedBlobStore for OversizedStore {
            fn put(&self, _blob_id: &str, _encrypted_blob: &[u8]) -> StorageResult<()> {
                Ok(())
            }

            fn get(&self, _blob_id: &str, max_bytes: usize) -> StorageResult<Vec<u8>> {
                Ok(vec![0; max_bytes + 1])
            }
        }

        let (conn, ctx, project_id) = setup_encrypted();
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let data = b"bounded blob".repeat(8);
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "bounded-external.bin",
            None,
            "",
            data.len() as u64,
        )
        .unwrap();
        let mut reader = Cursor::new(&data);
        AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(32, data.len() as u64),
            &store,
        )
        .unwrap();

        assert!(matches!(
            AttachmentRepo::read_content_with_blob_store(
                &conn,
                &att.attachment_id,
                &OversizedStore
            ),
            Err(StorageError::BlobStore(_))
        ));
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn external_references_survive_snapshot_and_sync_state_serialization() {
        let (conn, ctx, project_id) = setup_encrypted();
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let data = b"snapshot and synchronization keep encrypted references".repeat(4);
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "portable-external.bin",
            None,
            "",
            data.len() as u64,
        )
        .unwrap();
        let mut reader = Cursor::new(&data);
        AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(48, data.len() as u64),
            &store,
        )
        .unwrap();

        let payload = crate::sync_state::collect_sync_state_payload(&conn).unwrap();
        let state = crate::sync_state::decode_sync_state_payload(&payload)
            .unwrap()
            .unwrap();
        let synced_attachment = state
            .attachments
            .iter()
            .find(|row| row.attachment_id == att.attachment_id)
            .unwrap();
        assert_eq!(synced_attachment.storage_mode, "external-hash-ref");
        let synced_chunks: Vec<_> = state
            .attachment_chunks
            .iter()
            .filter(|row| row.attachment_id == att.attachment_id)
            .collect();
        assert!(!synced_chunks.is_empty());
        assert!(synced_chunks
            .iter()
            .all(|row| row.chunk_ct.is_none() && row.external_uri_ct.is_some()));

        let snapshot = crate::repo::snapshot::SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"replacement")
            .unwrap();
        crate::repo::snapshot::SnapshotRepo::restore_snapshot(&conn, &ctx, &snapshot.snapshot_id)
            .unwrap();

        let restored = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(restored.storage_mode, StorageMode::ExternalHashRef);
        assert_eq!(
            AttachmentRepo::read_content_with_blob_store(&conn, &att.attachment_id, &store)
                .unwrap(),
            data
        );
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn inline_replacement_removes_all_external_chunk_references() {
        let (conn, ctx, project_id) = setup_encrypted();
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let data = vec![8; 160];
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "replace-external.bin",
            None,
            "",
            data.len() as u64,
        )
        .unwrap();
        let mut reader = Cursor::new(&data);
        AttachmentRepo::write_external_content_from_reader_with_options(
            &conn,
            &ctx,
            &att.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(32, data.len() as u64),
            &store,
        )
        .unwrap();

        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"inline").unwrap();

        let refreshed = AttachmentRepo::get_by_id(&conn, &att.attachment_id)
            .unwrap()
            .unwrap();
        let row_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM attachment_chunks WHERE attachment_id = ?1",
                params![att.attachment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(refreshed.storage_mode, StorageMode::EmbeddedInline);
        assert_eq!(refreshed.chunk_count, 1);
        assert_eq!(row_count, 1);
        assert_eq!(
            AttachmentRepo::read_content(&conn, &att.attachment_id).unwrap(),
            b"inline"
        );
    }

    #[test]
    fn unknown_attachment_storage_mode_is_rejected() {
        let (conn, ctx, project_id) = setup();
        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            None,
            "unknown-mode.bin",
            None,
            "",
            0,
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE attachments SET storage_mode = 'future-mode' WHERE attachment_id = ?1",
                params![att.attachment_id],
            )
            .unwrap();

        assert!(matches!(
            AttachmentRepo::get_by_id(&conn, &att.attachment_id),
            Err(StorageError::Database(
                rusqlite::Error::FromSqlConversionFailure(..)
            ))
        ));
    }
}
