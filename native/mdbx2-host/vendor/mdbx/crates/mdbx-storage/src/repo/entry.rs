use rusqlite::params;
use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use uuid::Uuid;

use mdbx_core::model::{Entry, EntryType};
use mdbx_core::tiga::TigaMode;

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::repo::object_version::ObjectVersionRepo;
use crate::repo::{AttachmentRepo, CollectionProfileRepo};
use crate::repo::TombstoneRepo;
use crate::sync_state::EntryRow;

/// Entry 的持久化仓库。
///
/// 每个 entry 必须归属于一个 project。
/// `_ct` 字段在写入时加密、读取时解密。
pub struct EntryRepo;

/// Policy resolution metadata that is safe to read before plaintext disclosure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EntryPolicyContext {
    pub project_id: String,
    pub tiga_mode_override: Option<TigaMode>,
    pub deleted: bool,
    pub object_clock: String,
}

pub struct EntryCreateRequest<'a> {
    pub entry_id: &'a str,
    pub project_id: &'a str,
    pub entry_type: EntryType,
    pub title: Option<&'a str>,
    pub payload: &'a serde_json::Value,
    pub payload_schema_version: u32,
}

impl EntryRepo {
    // -----------------------------------------------------------------------
    // CREATE
    // -----------------------------------------------------------------------

    pub fn create(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
        entry_type: EntryType,
        title: Option<&str>,
        payload: &serde_json::Value,
    ) -> StorageResult<Entry> {
        Self::create_with_payload_schema_version(
            conn, ctx, project_id, entry_type, title, payload, 1,
        )
    }

    pub fn create_with_payload_schema_version(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
        entry_type: EntryType,
        title: Option<&str>,
        payload: &serde_json::Value,
        payload_schema_version: u32,
    ) -> StorageResult<Entry> {
        let entry_id = Uuid::new_v4().to_string();
        Self::create_with_request(
            conn,
            ctx,
            EntryCreateRequest {
                entry_id: &entry_id,
                project_id,
                entry_type,
                title,
                payload,
                payload_schema_version,
            },
        )
    }

    pub fn create_with_id(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry_id: &str,
        project_id: &str,
        entry_type: EntryType,
        title: Option<&str>,
        payload: &serde_json::Value,
    ) -> StorageResult<Entry> {
        Self::create_with_request(
            conn,
            ctx,
            EntryCreateRequest {
                entry_id,
                project_id,
                entry_type,
                title,
                payload,
                payload_schema_version: 1,
            },
        )
    }

    pub fn create_with_request(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: EntryCreateRequest<'_>,
    ) -> StorageResult<Entry> {
        let EntryCreateRequest {
            entry_id,
            project_id,
            entry_type,
            title,
            payload,
            payload_schema_version,
        } = request;
        Uuid::parse_str(entry_id)
            .map_err(|_| StorageError::Validation(format!("entry_id {entry_id} must be a UUID")))?;
        if TombstoneRepo::is_permanently_purged(conn, "entry", entry_id)? {
            return Err(StorageError::ConstraintViolation(format!(
                "entry ID {entry_id} has a permanent purge receipt"
            )));
        }
        entry_type.validate().map_err(StorageError::Validation)?;
        if payload_schema_version == 0 {
            return Err(StorageError::Validation(
                "payload_schema_version must be greater than zero".to_string(),
            ));
        }
        conn.with_immediate_transaction(|| {
            let now = chrono::Utc::now().to_rfc3339();

            // 验证 project 存在且未删除
            let (exists, deleted): (bool, bool) = conn
                .inner()
                .query_row(
                    "SELECT 1, deleted FROM projects WHERE project_id = ?1",
                    params![project_id],
                    |row| Ok((true, row.get::<_, i32>(1)? != 0)),
                )
                .optional()
                .map_err(StorageError::Database)?
                .unwrap_or((false, false));

            if !exists {
                return Err(StorageError::NotFound(format!(
                    "project {} not found",
                    project_id
                )));
            }
            if deleted {
                return Err(StorageError::ConstraintViolation(format!(
                    "project {} is deleted",
                    project_id
                )));
            }
            CollectionProfileRepo::ensure_object_write_allowed(conn, project_id, &entry_type)?;

            let commit_id =
                ctx.create_commit(conn, "change", "entry", &[entry_id.to_string()], &[])?;

            let object_clock = r#"{"counter":1}"#.to_string();
            let payload_blob = serde_json::to_vec(payload)
                .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
            let payload_ct = Self::encrypt_record(conn, entry_id, "payload", &payload_blob)?;
            let title_ct = title
                .map(|t| Self::encrypt_metadata(conn, entry_id, "title", t.as_bytes()))
                .transpose()?;

            conn.inner().execute(
                "INSERT INTO entries (entry_id, project_id, entry_type, title_ct,
             payload_ct, payload_schema_version, tiga_mode_override, object_clock,
             head_commit_id, deleted, created_at, updated_at,
             created_by_device_id, updated_by_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, 0, ?9, ?9, ?10, ?10)",
                params![
                    entry_id,
                    project_id,
                    entry_type.to_string(),
                    title_ct,
                    payload_ct,
                    payload_schema_version as i64,
                    object_clock,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;

            ObjectVersionRepo::record_entry_current(conn, &commit_id, entry_id)?;

            EntryRepo::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))
        })
    }

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    pub fn get_by_id(conn: &VaultConnection, entry_id: &str) -> StorageResult<Option<Entry>> {
        conn.inner()
            .query_row(
                "SELECT entry_id, project_id, entry_type, title_ct, payload_ct,
                        payload_schema_version, tiga_mode_override, object_clock,
                        head_commit_id, deleted, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM entries WHERE entry_id = ?1",
                params![entry_id],
                |row| {
                    let eid: String = row.get(0)?;
                    let raw_title: Option<Vec<u8>> = row.get(3)?;
                    let raw_payload: Vec<u8> = row.get(4)?;
                    Ok(Entry {
                        entry_id: eid.clone(),
                        project_id: row.get(1)?,
                        entry_type: {
                            let s: String = row.get(2)?;
                            s.parse().map_err(|error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    2,
                                    Type::Text,
                                    Box::new(StorageError::Validation(error)),
                                )
                            })?
                        },
                        title_ct: raw_title
                            .map(|t| {
                                Self::decrypt_metadata(conn, &eid, "title", &t).map_err(|e| {
                                    rusqlite::Error::FromSqlConversionFailure(
                                        3,
                                        Type::Blob,
                                        Box::new(e),
                                    )
                                })
                            })
                            .transpose()?,
                        payload_ct: Self::decrypt_record(conn, &eid, "payload", &raw_payload)
                            .map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    4,
                                    Type::Blob,
                                    Box::new(e),
                                )
                            })?,
                        payload_schema_version: read_payload_schema_version(row, 5)?,
                        tiga_mode_override: row
                            .get::<_, Option<String>>(6)?
                            .and_then(|s| s.parse().ok()),
                        object_clock: row.get(7)?,
                        head_commit_id: row.get(8)?,
                        deleted: row.get::<_, i32>(9)? != 0,
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                        created_by_device_id: row.get(12)?,
                        updated_by_device_id: row.get(13)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn get_policy_context(
        conn: &VaultConnection,
        entry_id: &str,
    ) -> StorageResult<Option<EntryPolicyContext>> {
        let stored = conn
            .inner()
            .query_row(
                "SELECT project_id, tiga_mode_override, deleted, object_clock
                 FROM entries WHERE entry_id = ?1",
                params![entry_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, i32>(2)? != 0,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(StorageError::Database)?;

        stored
            .map(|(project_id, tiga_mode_override, deleted, object_clock)| {
                Ok(EntryPolicyContext {
                    project_id,
                    tiga_mode_override: tiga_mode_override
                        .map(|value| value.parse().map_err(StorageError::Validation))
                        .transpose()?,
                    deleted,
                    object_clock,
                })
            })
            .transpose()
    }

    /// Return the optional stored title ciphertext length without materializing the BLOB.
    pub(crate) fn title_ciphertext_len(
        conn: &VaultConnection,
        entry_id: &str,
    ) -> StorageResult<Option<u64>> {
        let stored = conn
            .inner()
            .query_row(
                "SELECT length(title_ct) FROM entries WHERE entry_id = ?1",
                params![entry_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(StorageError::Database)?
            .flatten();

        stored
            .map(|length| {
                u64::try_from(length).map_err(|_| {
                    StorageError::Validation(format!(
                        "entry {entry_id} has a negative title ciphertext length"
                    ))
                })
            })
            .transpose()
    }

    /// Return the stored payload ciphertext length without materializing the BLOB.
    ///
    /// This projection is intentionally separate from `get_by_id` so authorized
    /// disclosure can enforce an allocation boundary before loading or decrypting
    /// attacker-controlled ciphertext.
    pub(crate) fn payload_ciphertext_len(
        conn: &VaultConnection,
        entry_id: &str,
    ) -> StorageResult<Option<u64>> {
        let stored = conn
            .inner()
            .query_row(
                "SELECT length(payload_ct) FROM entries WHERE entry_id = ?1",
                params![entry_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(StorageError::Database)?;

        stored
            .map(|length| {
                u64::try_from(length).map_err(|_| {
                    StorageError::Validation(format!(
                        "entry {entry_id} has a negative payload ciphertext length"
                    ))
                })
            })
            .transpose()
    }

    pub fn list_by_project(conn: &VaultConnection, project_id: &str) -> StorageResult<Vec<Entry>> {
        EntryRepo::list_where(
            conn,
            "deleted = 0 AND project_id = ?1",
            rusqlite::params![project_id],
        )
    }

    pub fn list_by_project_and_type(
        conn: &VaultConnection,
        project_id: &str,
        entry_type: EntryType,
    ) -> StorageResult<Vec<Entry>> {
        let type_str = entry_type.to_string();
        EntryRepo::list_where(
            conn,
            "deleted = 0 AND project_id = ?1 AND entry_type = ?2",
            rusqlite::params![project_id, type_str],
        )
    }

    pub fn list_by_type(
        conn: &VaultConnection,
        entry_type: EntryType,
    ) -> StorageResult<Vec<Entry>> {
        let type_str = entry_type.to_string();
        EntryRepo::list_where(
            conn,
            "deleted = 0 AND entry_type = ?1",
            rusqlite::params![type_str],
        )
    }

    pub fn list_deleted(conn: &VaultConnection) -> StorageResult<Vec<Entry>> {
        EntryRepo::list_where(conn, "deleted = 1", [])
    }

    pub fn list_deleted_by_project(
        conn: &VaultConnection,
        project_id: &str,
    ) -> StorageResult<Vec<Entry>> {
        EntryRepo::list_where(
            conn,
            "deleted = 1 AND project_id = ?1",
            rusqlite::params![project_id],
        )
    }

    pub fn list_deleted_by_project_and_type(
        conn: &VaultConnection,
        project_id: &str,
        entry_type: EntryType,
    ) -> StorageResult<Vec<Entry>> {
        let type_str = entry_type.to_string();
        EntryRepo::list_where(
            conn,
            "deleted = 1 AND project_id = ?1 AND entry_type = ?2",
            rusqlite::params![project_id, type_str],
        )
    }

    pub(crate) fn list_for_payload_migration(
        conn: &VaultConnection,
        project_id: &str,
        entry_type: &EntryType,
        payload_schema_version: u32,
        limit: usize,
    ) -> StorageResult<Vec<Entry>> {
        query_entries(
            conn,
            "SELECT entry_id, project_id, entry_type, title_ct, payload_ct,
                    payload_schema_version, tiga_mode_override, object_clock,
                    head_commit_id, deleted, created_at, updated_at,
                    created_by_device_id, updated_by_device_id
             FROM entries
             WHERE deleted = 0 AND project_id = ?1 AND entry_type = ?2
                   AND payload_schema_version = ?3
             ORDER BY entry_id LIMIT ?4",
            params![
                project_id,
                entry_type.to_string(),
                payload_schema_version as i64,
                limit as i64
            ],
        )
    }

    pub(crate) fn count_for_payload_migration(
        conn: &VaultConnection,
        project_id: &str,
        entry_type: &EntryType,
        payload_schema_version: u32,
    ) -> StorageResult<u64> {
        conn.inner()
            .query_row(
                "SELECT COUNT(*) FROM entries
                 WHERE deleted = 0 AND project_id = ?1 AND entry_type = ?2
                       AND payload_schema_version = ?3",
                params![
                    project_id,
                    entry_type.to_string(),
                    payload_schema_version as i64
                ],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count as u64)
            .map_err(StorageError::Database)
    }

    fn list_where(
        conn: &VaultConnection,
        where_clause: &str,
        params: impl rusqlite::Params,
    ) -> StorageResult<Vec<Entry>> {
        let sql = format!(
            "SELECT entry_id, project_id, entry_type, title_ct, payload_ct,
                    payload_schema_version, tiga_mode_override, object_clock,
                    head_commit_id, deleted, created_at, updated_at,
                    created_by_device_id, updated_by_device_id
             FROM entries WHERE {} ORDER BY updated_at DESC",
            where_clause
        );

        query_entries(conn, &sql, params)
    }

    // -----------------------------------------------------------------------
    // UPDATE
    // -----------------------------------------------------------------------

    pub fn update(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry: &Entry,
    ) -> StorageResult<Entry> {
        conn.with_immediate_transaction(|| {
            Self::update_loaded_in_transaction(conn, ctx, entry)?;

            Self::get_by_id(conn, &entry.entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry.entry_id.clone()))
        })
    }

    /// Update an entry that the caller has already loaded while participating
    /// in the caller-owned transaction. OperationCoordinator uses this path to
    /// avoid materializing the same encrypted entry again after a write.
    pub(crate) fn update_loaded_in_transaction(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry: &Entry,
    ) -> StorageResult<()> {
        if conn.inner().is_autocommit() {
            return Err(StorageError::ConstraintViolation(
                "update_loaded_in_transaction requires an active transaction".to_string(),
            ));
        }
        entry
            .entry_type
            .validate()
            .map_err(StorageError::Validation)?;
        if entry.payload_schema_version == 0 {
            return Err(StorageError::Validation(
                "payload_schema_version must be greater than zero".to_string(),
            ));
        }
        CollectionProfileRepo::ensure_object_write_allowed(
            conn,
            &entry.project_id,
            &entry.entry_type,
        )?;
        let now = chrono::Utc::now().to_rfc3339();

        let commit_id =
            ctx.commit_object_change(conn, "entries", &entry.entry_id, "change", "entry")?;

        let object_clock = bump_clock(&entry.object_clock);

        let title_ct = entry
            .title_ct
            .as_ref()
            .map(|t| Self::encrypt_metadata(conn, &entry.entry_id, "title", t))
            .transpose()?;
        let payload_ct = Self::encrypt_record(conn, &entry.entry_id, "payload", &entry.payload_ct)?;

        conn.inner().execute(
            "UPDATE entries SET
                title_ct = ?2, payload_ct = ?3, payload_schema_version = ?4,
                entry_type = ?5, tiga_mode_override = ?6, object_clock = ?7,
                head_commit_id = ?8, deleted = ?9,
                updated_at = ?10, updated_by_device_id = ?11
             WHERE entry_id = ?1",
            params![
                entry.entry_id,
                title_ct,
                payload_ct,
                entry.payload_schema_version as i64,
                entry.entry_type.to_string(),
                entry.tiga_mode_override.as_ref().map(|m| m.to_string()),
                object_clock,
                commit_id,
                entry.deleted as i32,
                now,
                ctx.device_id,
            ],
        )?;

        ObjectVersionRepo::record_entry_current(conn, &commit_id, &entry.entry_id)?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // MOVE / COPY
    // -----------------------------------------------------------------------

    pub fn move_to_project(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry_id: &str,
        target_project_id: &str,
    ) -> StorageResult<Entry> {
        conn.with_immediate_transaction(|| {
            let entry = EntryRepo::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;

            if entry.deleted {
                return Err(StorageError::ConstraintViolation(
                    "entry is deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_object_write_allowed(
                conn,
                &entry.project_id,
                &entry.entry_type,
            )?;
            ensure_active_project(conn, target_project_id)?;
            CollectionProfileRepo::ensure_object_write_allowed(
                conn,
                target_project_id,
                &entry.entry_type,
            )?;

            let now = chrono::Utc::now().to_rfc3339();
            let commit_id = ctx.commit_object_change(conn, "entries", entry_id, "move", "entry")?;
            let object_clock = bump_clock(&entry.object_clock);

            conn.inner().execute(
                "UPDATE entries SET project_id = ?2, object_clock = ?3,
             head_commit_id = ?4, updated_at = ?5, updated_by_device_id = ?6
             WHERE entry_id = ?1",
                params![
                    entry_id,
                    target_project_id,
                    object_clock,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;

            ObjectVersionRepo::record_entry_current(conn, &commit_id, entry_id)?;

            // Entry and active attachments must remain in the same Collection.
            // The outer operation context coalesces attachment versions and parents
            // into this commit; any failure rolls back the entire entry move.
            for attachment in AttachmentRepo::list_by_entry(conn, entry_id)? {
                if attachment.project_id != target_project_id {
                    AttachmentRepo::move_with_entry(conn, ctx, &attachment, entry_id, target_project_id)?;
                }
            }

            EntryRepo::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))
        })
    }

    pub fn copy_to_project(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry_id: &str,
        target_project_id: &str,
    ) -> StorageResult<Entry> {
        conn.with_immediate_transaction(|| {
            let source = EntryRepo::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;

            if source.deleted {
                return Err(StorageError::ConstraintViolation(
                    "entry is deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_object_write_allowed(
                conn,
                &source.project_id,
                &source.entry_type,
            )?;
            ensure_active_project(conn, target_project_id)?;
            CollectionProfileRepo::ensure_object_write_allowed(
                conn,
                target_project_id,
                &source.entry_type,
            )?;

            let now = chrono::Utc::now().to_rfc3339();
            let new_entry_id = Uuid::new_v4().to_string();
            let commit_id = ctx.create_commit(
                conn,
                "copy",
                "entry",
                &[new_entry_id.clone()],
                std::slice::from_ref(&source.head_commit_id),
            )?;
            let title_ct = source
                .title_ct
                .as_ref()
                .map(|t| Self::encrypt_metadata(conn, &new_entry_id, "title", t))
                .transpose()?;
            let payload_ct =
                Self::encrypt_record(conn, &new_entry_id, "payload", &source.payload_ct)?;

            conn.inner().execute(
                "INSERT INTO entries (entry_id, project_id, entry_type, title_ct,
             payload_ct, payload_schema_version, tiga_mode_override, object_clock,
             head_commit_id, deleted, created_at, updated_at,
             created_by_device_id, updated_by_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10, ?11, ?11)",
                params![
                    new_entry_id,
                    target_project_id,
                    source.entry_type.to_string(),
                    title_ct,
                    payload_ct,
                    source.payload_schema_version as i64,
                    source.tiga_mode_override.as_ref().map(|m| m.to_string()),
                    r#"{"counter":1}"#,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;

            ObjectVersionRepo::record_entry_current(conn, &commit_id, &new_entry_id)?;

            EntryRepo::get_by_id(conn, &new_entry_id)?
                .ok_or_else(|| StorageError::NotFound(new_entry_id))
        })
    }

    // -----------------------------------------------------------------------
    // SOFT DELETE
    // -----------------------------------------------------------------------

    pub fn soft_delete(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry_id: &str,
    ) -> StorageResult<()> {
        conn.with_immediate_transaction(|| {
            let entry = Self::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;

            Self::soft_delete_loaded_in_transaction(conn, ctx, &entry)
        })
    }

    /// Soft-delete an entry already loaded by the caller inside the current
    /// write transaction, preserving the normal commit, tombstone and version
    /// bookkeeping without a second full entry read.
    pub(crate) fn soft_delete_loaded_in_transaction(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry: &Entry,
    ) -> StorageResult<()> {
        if conn.inner().is_autocommit() {
            return Err(StorageError::ConstraintViolation(
                "soft_delete_loaded_in_transaction requires an active transaction".to_string(),
            ));
        }

        if entry.deleted {
            return Err(StorageError::ConstraintViolation(
                "entry is already deleted".to_string(),
            ));
        }
        CollectionProfileRepo::ensure_object_write_allowed(
            conn,
            &entry.project_id,
            &entry.entry_type,
        )?;

        let now = chrono::Utc::now().to_rfc3339();

        let commit_id =
            ctx.commit_object_change(conn, "entries", &entry.entry_id, "change", "entry")?;
        ctx.create_tombstone_for_commit(conn, "entry", &entry.entry_id, &commit_id)?;

        let object_clock = bump_clock(&entry.object_clock);

        conn.inner().execute(
            "UPDATE entries SET deleted = 1, object_clock = ?2,
             head_commit_id = ?3, updated_at = ?4, updated_by_device_id = ?5
             WHERE entry_id = ?1",
            params![entry.entry_id, object_clock, commit_id, now, ctx.device_id],
        )?;

        ObjectVersionRepo::record_entry_current(conn, &commit_id, &entry.entry_id)?;

        Ok(())
    }

    pub fn restore(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry_id: &str,
    ) -> StorageResult<Entry> {
        conn.with_immediate_transaction(|| {
            let entry = EntryRepo::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;

            if !entry.deleted {
                return Err(StorageError::ConstraintViolation(
                    "entry is not deleted".to_string(),
                ));
            }
            ensure_active_project(conn, &entry.project_id)?;
            CollectionProfileRepo::ensure_object_write_allowed(
                conn,
                &entry.project_id,
                &entry.entry_type,
            )?;

            let now = chrono::Utc::now().to_rfc3339();
            let commit_id =
                ctx.commit_object_change(conn, "entries", entry_id, "restore", "entry")?;
            let object_clock = bump_clock(&entry.object_clock);

            conn.inner().execute(
                "UPDATE entries SET deleted = 0, object_clock = ?2,
             head_commit_id = ?3, updated_at = ?4, updated_by_device_id = ?5
             WHERE entry_id = ?1",
                params![entry_id, object_clock, commit_id, now, ctx.device_id],
            )?;

            ObjectVersionRepo::record_entry_current(conn, &commit_id, entry_id)?;

            EntryRepo::get_by_id(conn, entry_id)?
                .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))
        })
    }

    /// Apply a previously recorded encrypted entry row as a new commit state.
    ///
    /// This is reserved for engine-owned history and snapshot recovery. The
    /// caller must create the recovery commit first and keep the whole action
    /// inside one immediate transaction.
    pub(crate) fn apply_version_for_commit(
        conn: &VaultConnection,
        ctx: &CommitContext,
        row: &EntryRow,
        commit_id: &str,
    ) -> StorageResult<()> {
        if TombstoneRepo::is_permanently_purged(conn, "entry", &row.entry_id)? {
            return Err(StorageError::ConstraintViolation(format!(
                "entry ID {} has a permanent purge receipt",
                row.entry_id
            )));
        }
        let entry_type: EntryType = row.entry_type.parse().map_err(StorageError::Validation)?;
        if row.payload_schema_version == 0 {
            return Err(StorageError::Validation(
                "payload_schema_version must be greater than zero".to_string(),
            ));
        }
        if !row.deleted {
            ensure_active_project(conn, &row.project_id)?;
            CollectionProfileRepo::ensure_object_write_allowed(conn, &row.project_id, &entry_type)?;
        }

        let now = chrono::Utc::now().to_rfc3339();
        let current_clock = conn
            .inner()
            .query_row(
                "SELECT object_clock FROM entries WHERE entry_id = ?1",
                params![row.entry_id],
                |result| result.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| row.object_clock.clone());
        let object_clock = bump_clock(&current_clock);
        if row.deleted {
            ctx.create_tombstone_for_commit(conn, "entry", &row.entry_id, commit_id)?;
        }

        conn.inner().execute(
            "INSERT INTO entries
                (entry_id, project_id, entry_type, title_ct, payload_ct,
                 payload_schema_version, tiga_mode_override, object_clock,
                 head_commit_id, deleted, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(entry_id) DO UPDATE SET
                project_id = excluded.project_id,
                entry_type = excluded.entry_type,
                title_ct = excluded.title_ct,
                payload_ct = excluded.payload_ct,
                payload_schema_version = excluded.payload_schema_version,
                tiga_mode_override = excluded.tiga_mode_override,
                object_clock = excluded.object_clock,
                head_commit_id = excluded.head_commit_id,
                deleted = excluded.deleted,
                updated_at = excluded.updated_at,
                updated_by_device_id = excluded.updated_by_device_id",
            params![
                row.entry_id,
                row.project_id,
                row.entry_type,
                row.title_ct,
                row.payload_ct,
                row.payload_schema_version as i64,
                row.tiga_mode_override,
                object_clock,
                commit_id,
                i32::from(row.deleted),
                row.created_at,
                now,
                row.created_by_device_id,
                ctx.device_id,
            ],
        )?;
        ObjectVersionRepo::record_entry_current(conn, commit_id, &row.entry_id)
    }
    // -----------------------------------------------------------------------
    // ENCRYPTION HELPERS
    // -----------------------------------------------------------------------

    fn encrypt_metadata(
        conn: &VaultConnection,
        id: &str,
        field: &str,
        plaintext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        encrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            plaintext,
            "entry",
            id,
            field,
        )
    }

    pub(crate) fn decrypt_metadata(
        conn: &VaultConnection,
        id: &str,
        field: &str,
        ciphertext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        decrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            ciphertext,
            "entry",
            id,
            field,
        )
    }

    fn encrypt_record(
        conn: &VaultConnection,
        id: &str,
        field: &str,
        plaintext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        encrypt_field(conn, FieldKeyPurpose::Record, plaintext, "entry", id, field)
    }

    fn decrypt_record(
        conn: &VaultConnection,
        id: &str,
        field: &str,
        ciphertext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        decrypt_field(
            conn,
            FieldKeyPurpose::Record,
            ciphertext,
            "entry",
            id,
            field,
        )
    }

    pub(crate) fn encrypt_payload_blob(
        conn: &VaultConnection,
        entry_id: &str,
        plaintext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        Self::encrypt_record(conn, entry_id, "payload", plaintext)
    }

    pub(crate) fn decrypt_payload_blob(
        conn: &VaultConnection,
        entry_id: &str,
        ciphertext: &[u8],
    ) -> StorageResult<Vec<u8>> {
        Self::decrypt_record(conn, entry_id, "payload", ciphertext)
    }
}

fn query_entries(
    conn: &VaultConnection,
    sql: &str,
    params: impl rusqlite::Params,
) -> StorageResult<Vec<Entry>> {
    let mut stmt = conn.inner().prepare(sql)?;
    let rows = stmt.query_map(params, |row| {
        let eid: String = row.get(0)?;
        let raw_title: Option<Vec<u8>> = row.get(3)?;
        let raw_payload: Vec<u8> = row.get(4)?;
        Ok(Entry {
            entry_id: eid.clone(),
            project_id: row.get(1)?,
            entry_type: {
                let value: String = row.get(2)?;
                value.parse().map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        2,
                        Type::Text,
                        Box::new(StorageError::Validation(error)),
                    )
                })?
            },
            title_ct: raw_title
                .map(|title| {
                    EntryRepo::decrypt_metadata(conn, &eid, "title", &title).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(3, Type::Blob, Box::new(error))
                    })
                })
                .transpose()?,
            payload_ct: EntryRepo::decrypt_record(conn, &eid, "payload", &raw_payload).map_err(
                |error| rusqlite::Error::FromSqlConversionFailure(4, Type::Blob, Box::new(error)),
            )?,
            payload_schema_version: read_payload_schema_version(row, 5)?,
            tiga_mode_override: row
                .get::<_, Option<String>>(6)?
                .and_then(|value| value.parse().ok()),
            object_clock: row.get(7)?,
            head_commit_id: row.get(8)?,
            deleted: row.get::<_, i32>(9)? != 0,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            created_by_device_id: row.get(12)?,
            updated_by_device_id: row.get(13)?,
        })
    })?;

    rows.map(|row| row.map_err(StorageError::Database))
        .collect()
}

fn read_payload_schema_version(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u32> {
    let value = row.get::<_, i64>(column)?;
    u32::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, Box::new(error))
    })
}

fn bump_clock(clock: &str) -> String {
    let counter: u64 = serde_json::from_str::<serde_json::Value>(clock)
        .ok()
        .and_then(|v| v.get("counter")?.as_u64())
        .unwrap_or(0);
    format!(r#"{{"counter":{}}}"#, counter + 1)
}

fn ensure_active_project(conn: &VaultConnection, project_id: &str) -> StorageResult<()> {
    let deleted: Option<bool> = conn
        .inner()
        .query_row(
            "SELECT deleted FROM projects WHERE project_id = ?1",
            params![project_id],
            |row| Ok(row.get::<_, i32>(0)? != 0),
        )
        .optional()
        .map_err(StorageError::Database)?;

    match deleted {
        Some(false) => Ok(()),
        Some(true) => Err(StorageError::ConstraintViolation(format!(
            "project {} is deleted",
            project_id
        ))),
        None => Err(StorageError::NotFound(format!(
            "project {} not found",
            project_id
        ))),
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::project::ProjectRepo;

    fn setup() -> (VaultConnection, CommitContext, String) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Parent Project", None, None).unwrap();
        (conn, ctx, project.project_id)
    }

    fn login_payload() -> serde_json::Value {
        serde_json::json!({
            "username": "alice@example.com",
            "password": "s3cret!",
            "url": "https://example.com/login",
            "totp_seed": null
        })
    }

    // -----------------------------------------------------------------------
    // CREATE
    // -----------------------------------------------------------------------

    #[test]
    fn test_create_entry() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("My Login"),
            &login_payload(),
        )
        .unwrap();

        assert!(!entry.entry_id.is_empty());
        assert_eq!(entry.project_id, project_id);
        assert_eq!(entry.entry_type, EntryType::Login);
        assert_eq!(entry.title_ct, Some(b"My Login".to_vec()));
        assert!(!entry.payload_ct.is_empty());
        assert!(!entry.head_commit_id.is_empty());
        assert!(!entry.deleted);
    }

    #[test]
    fn test_create_entry_with_stable_id() {
        let (conn, ctx, project_id) = setup();
        let entry_id = Uuid::new_v4().to_string();
        let entry = EntryRepo::create_with_id(
            &conn,
            &ctx,
            &entry_id,
            &project_id,
            EntryType::Login,
            Some("Stable"),
            &login_payload(),
        )
        .unwrap();

        assert_eq!(entry.entry_id, entry_id);
    }

    #[test]
    fn test_create_entry_nonexistent_project() {
        let (conn, ctx, _project_id) = setup();
        let result = EntryRepo::create(
            &conn,
            &ctx,
            "nonexistent",
            EntryType::Note,
            None,
            &serde_json::json!({"text": "hello"}),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_entry_on_deleted_project() {
        let (conn, ctx, project_id) = setup();
        ProjectRepo::soft_delete(&conn, &ctx, &project_id).unwrap();

        let result = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            None,
            &serde_json::json!({"text": "should fail"}),
        );
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // READ
    // -----------------------------------------------------------------------

    #[test]
    fn test_get_by_id() {
        let (conn, ctx, project_id) = setup();
        let created = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("Test"),
            &login_payload(),
        )
        .unwrap();

        let found = EntryRepo::get_by_id(&conn, &created.entry_id)
            .unwrap()
            .unwrap();

        assert_eq!(found.entry_id, created.entry_id);
        assert_eq!(found.payload_ct, created.payload_ct);
    }

    #[test]
    fn test_get_nonexistent() {
        let (conn, _ctx, _project_id) = setup();
        assert!(EntryRepo::get_by_id(&conn, "nonexistent")
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_list_by_project() {
        let (conn, ctx, project_id) = setup();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("A"),
            &serde_json::json!({"user": "a"}),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("B"),
            &serde_json::json!({"text": "b"}),
        )
        .unwrap();

        let entries = EntryRepo::list_by_project(&conn, &project_id).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_list_by_type() {
        let (conn, ctx, project_id) = setup();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("L1"),
            &login_payload(),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("N1"),
            &serde_json::json!({"text": "note"}),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("L2"),
            &login_payload(),
        )
        .unwrap();

        let logins = EntryRepo::list_by_type(&conn, EntryType::Login).unwrap();
        assert_eq!(logins.len(), 2);
        let notes = EntryRepo::list_by_type(&conn, EntryType::Note).unwrap();
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn test_list_by_project_and_type() {
        let (conn, ctx, project_id) = setup();
        let other = ProjectRepo::create(&conn, &ctx, "Other", None, None).unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("Project Login"),
            &login_payload(),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("Project Note"),
            &serde_json::json!({"text": "note"}),
        )
        .unwrap();
        EntryRepo::create(
            &conn,
            &ctx,
            &other.project_id,
            EntryType::Login,
            Some("Other Login"),
            &login_payload(),
        )
        .unwrap();

        let logins =
            EntryRepo::list_by_project_and_type(&conn, &project_id, EntryType::Login).unwrap();
        assert_eq!(logins.len(), 1);
        assert_eq!(logins[0].project_id, project_id);
        assert_eq!(logins[0].entry_type, EntryType::Login);
    }

    #[test]
    fn test_list_excludes_deleted() {
        let (conn, ctx, project_id) = setup();
        let e = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("Del"),
            &serde_json::json!({"text": "x"}),
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &e.entry_id).unwrap();

        let active = EntryRepo::list_by_project(&conn, &project_id).unwrap();
        assert!(active.is_empty());

        let deleted = EntryRepo::list_deleted(&conn).unwrap();
        assert_eq!(deleted.len(), 1);
    }

    // -----------------------------------------------------------------------
    // UPDATE
    // -----------------------------------------------------------------------

    #[test]
    fn test_update_entry() {
        let (conn, ctx, project_id) = setup();
        let mut entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("Original"),
            &login_payload(),
        )
        .unwrap();

        entry.title_ct = Some(b"Updated Title".to_vec());
        let new_payload = serde_json::json!({"username": "bob", "password": "newpass"});
        entry.payload_ct = serde_json::to_vec(&new_payload).unwrap();

        let updated = EntryRepo::update(&conn, &ctx, &entry).unwrap();

        assert_eq!(updated.title_ct, Some(b"Updated Title".to_vec()));
        assert_ne!(updated.head_commit_id, entry.head_commit_id);
    }

    // -----------------------------------------------------------------------
    // MOVE / COPY
    // -----------------------------------------------------------------------

    #[test]
    fn test_move_to_project_generates_commit_with_parent() {
        let (conn, ctx, project_id) = setup();
        let target = ProjectRepo::create(&conn, &ctx, "Target Project", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("Movable"),
            &login_payload(),
        )
        .unwrap();

        let moved =
            EntryRepo::move_to_project(&conn, &ctx, &entry.entry_id, &target.project_id).unwrap();

        assert_eq!(moved.entry_id, entry.entry_id);
        assert_eq!(moved.project_id, target.project_id);
        assert_eq!(moved.title_ct, entry.title_ct);
        assert_eq!(moved.payload_ct, entry.payload_ct);
        assert_ne!(moved.head_commit_id, entry.head_commit_id);

        let (commit_kind, parent): (String, String) = conn
            .inner()
            .query_row(
                "SELECT c.commit_kind, cp.parent_commit_id
                 FROM commits c
                 JOIN commit_parents cp ON cp.commit_id = c.commit_id
                 WHERE c.commit_id = ?1",
                params![moved.head_commit_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(commit_kind, "move");
        assert_eq!(parent, entry.head_commit_id);

        assert!(EntryRepo::list_by_project(&conn, &project_id)
            .unwrap()
            .is_empty());
        assert_eq!(
            EntryRepo::list_by_project(&conn, &target.project_id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_copy_to_project_generates_new_entry_with_source_parent() {
        let (conn, ctx, project_id) = setup();
        let target = ProjectRepo::create(&conn, &ctx, "Copy Target", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("Copyable"),
            &login_payload(),
        )
        .unwrap();

        let copied =
            EntryRepo::copy_to_project(&conn, &ctx, &entry.entry_id, &target.project_id).unwrap();

        assert_ne!(copied.entry_id, entry.entry_id);
        assert_eq!(copied.project_id, target.project_id);
        assert_eq!(copied.entry_type, entry.entry_type);
        assert_eq!(copied.title_ct, entry.title_ct);
        assert_eq!(copied.payload_ct, entry.payload_ct);
        assert!(!copied.deleted);

        let (commit_kind, parent): (String, String) = conn
            .inner()
            .query_row(
                "SELECT c.commit_kind, cp.parent_commit_id
                 FROM commits c
                 JOIN commit_parents cp ON cp.commit_id = c.commit_id
                 WHERE c.commit_id = ?1",
                params![copied.head_commit_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(commit_kind, "copy");
        assert_eq!(parent, entry.head_commit_id);

        assert_eq!(
            EntryRepo::list_by_project(&conn, &project_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            EntryRepo::list_by_project(&conn, &target.project_id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_move_and_copy_reject_deleted_entry() {
        let (conn, ctx, project_id) = setup();
        let target = ProjectRepo::create(&conn, &ctx, "Target", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("Deleted"),
            &serde_json::json!({"text": "gone"}),
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &entry.entry_id).unwrap();

        assert!(
            EntryRepo::move_to_project(&conn, &ctx, &entry.entry_id, &target.project_id).is_err()
        );
        assert!(
            EntryRepo::copy_to_project(&conn, &ctx, &entry.entry_id, &target.project_id).is_err()
        );
    }

    // -----------------------------------------------------------------------
    // SOFT DELETE
    // -----------------------------------------------------------------------

    #[test]
    fn test_soft_delete() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("Gone"),
            &serde_json::json!({"text": "bye"}),
        )
        .unwrap();

        EntryRepo::soft_delete(&conn, &ctx, &entry.entry_id).unwrap();

        let deleted = EntryRepo::get_by_id(&conn, &entry.entry_id)
            .unwrap()
            .unwrap();
        assert!(deleted.deleted);

        // tombstone 已生成
        let count: i32 = conn.inner().query_row(
            "SELECT COUNT(*) FROM tombstones WHERE target_object_type = 'entry' AND target_object_id = ?1",
            params![entry.entry_id],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_double_delete_rejected() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("Once"),
            &serde_json::json!({"text": "hi"}),
        )
        .unwrap();

        EntryRepo::soft_delete(&conn, &ctx, &entry.entry_id).unwrap();
        assert!(EntryRepo::soft_delete(&conn, &ctx, &entry.entry_id).is_err());
    }

    #[test]
    fn test_list_deleted_by_project_and_type() {
        let (conn, ctx, project_id) = setup();
        let other = ProjectRepo::create(&conn, &ctx, "Other", None, None).unwrap();
        let deleted_login = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            Some("Deleted Login"),
            &login_payload(),
        )
        .unwrap();
        let deleted_note = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Note,
            Some("Deleted Note"),
            &serde_json::json!({"text": "gone"}),
        )
        .unwrap();
        let other_deleted_login = EntryRepo::create(
            &conn,
            &ctx,
            &other.project_id,
            EntryType::Login,
            Some("Other Deleted Login"),
            &login_payload(),
        )
        .unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &deleted_login.entry_id).unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &deleted_note.entry_id).unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &other_deleted_login.entry_id).unwrap();

        let project_deleted = EntryRepo::list_deleted_by_project(&conn, &project_id).unwrap();
        assert_eq!(project_deleted.len(), 2);

        let project_deleted_logins =
            EntryRepo::list_deleted_by_project_and_type(&conn, &project_id, EntryType::Login)
                .unwrap();
        assert_eq!(project_deleted_logins.len(), 1);
        assert_eq!(project_deleted_logins[0].entry_id, deleted_login.entry_id);
    }

    // -----------------------------------------------------------------------
    // COMMIT INTEGRITY
    // -----------------------------------------------------------------------

    #[test]
    fn test_create_generates_commit() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            None,
            &login_payload(),
        )
        .unwrap();

        let commit_count: i32 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commits WHERE commit_id = ?1",
                params![entry.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(commit_count, 1);
    }

    #[test]
    fn test_update_commit_has_parent() {
        let (conn, ctx, project_id) = setup();
        let mut entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            None,
            &login_payload(),
        )
        .unwrap();
        let first_commit = entry.head_commit_id.clone();

        entry.title_ct = Some(b"v2".to_vec());
        let updated = EntryRepo::update(&conn, &ctx, &entry).unwrap();

        let parent: String = conn
            .inner()
            .query_row(
                "SELECT parent_commit_id FROM commit_parents WHERE commit_id = ?1",
                params![updated.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, first_commit);
    }

    #[test]
    fn test_entry_types() {
        let (conn, ctx, project_id) = setup();

        for etype in [
            EntryType::Login,
            EntryType::Note,
            EntryType::Card,
            EntryType::Identity,
            EntryType::Totp,
            EntryType::Passkey,
            EntryType::SshKey,
            EntryType::ApiToken,
            EntryType::DocumentRef,
        ] {
            let e = EntryRepo::create(
                &conn,
                &ctx,
                &project_id,
                etype.clone(),
                None,
                &serde_json::json!({"data": "test"}),
            )
            .unwrap();
            assert_eq!(e.entry_type, etype);
        }

        // 9 entries total
        assert_eq!(
            EntryRepo::list_by_project(&conn, &project_id)
                .unwrap()
                .len(),
            9
        );
    }

    #[test]
    fn custom_object_type_and_payload_schema_version_roundtrip() {
        let (conn, ctx, project_id) = setup();
        let object_type = EntryType::custom("com.monica.mail.message").unwrap();
        let created = EntryRepo::create_with_payload_schema_version(
            &conn,
            &ctx,
            &project_id,
            object_type.clone(),
            Some("Encrypted message"),
            &serde_json::json!({"subject": "MDBX2", "body": "ciphertext at rest"}),
            7,
        )
        .unwrap();

        assert_eq!(created.entry_type, object_type);
        assert_eq!(created.payload_schema_version, 7);

        let by_type = EntryRepo::list_by_project_and_type(
            &conn,
            &project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
        )
        .unwrap();
        assert_eq!(by_type.len(), 1);
        assert_eq!(by_type[0].entry_id, created.entry_id);

        let mut updated = created;
        updated.payload_schema_version = 8;
        updated.payload_ct = serde_json::to_vec(&serde_json::json!({
            "subject": "MDBX2 updated",
            "body": "opaque to the database core"
        }))
        .unwrap();
        let updated = EntryRepo::update(&conn, &ctx, &updated).unwrap();
        assert_eq!(updated.entry_type.as_str(), "com.monica.mail.message");
        assert_eq!(updated.payload_schema_version, 8);
    }

    #[test]
    fn invalid_object_type_and_zero_payload_schema_version_are_rejected() {
        let (conn, ctx, project_id) = setup();
        assert!(EntryRepo::create_with_payload_schema_version(
            &conn,
            &ctx,
            &project_id,
            EntryType::Custom("Mail".to_string()),
            None,
            &serde_json::json!({}),
            1,
        )
        .is_err());
        assert!(EntryRepo::create_with_payload_schema_version(
            &conn,
            &ctx,
            &project_id,
            EntryType::custom("com.monica.bookmark").unwrap(),
            None,
            &serde_json::json!({}),
            0,
        )
        .is_err());
    }

    #[test]
    fn invalid_stored_object_type_returns_an_explicit_error() {
        let (conn, ctx, project_id) = setup();
        let created = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            EntryType::Login,
            None,
            &login_payload(),
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET entry_type = 'Mail' WHERE entry_id = ?1",
                params![created.entry_id],
            )
            .unwrap();

        assert!(EntryRepo::get_by_id(&conn, &created.entry_id).is_err());
        assert!(EntryRepo::list_by_project(&conn, &project_id).is_err());
    }

    // -----------------------------------------------------------------------
    // ENCRYPTION INTEGRATION
    // -----------------------------------------------------------------------

    #[test]
    fn test_entry_encrypted_with_keyring() {
        use crate::init::{initialize_vault, VaultInitParams};
        use crate::repo::commit_ctx::CommitContext;
        use mdbx_crypto::keyring::Keyring;

        let mut conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();

        // attach a real keyring
        let vault_ctx = b"test-vault-context";
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring = Keyring::from_vault_key(&vault_key, vault_ctx).unwrap();
        conn.attach_keyring(keyring);

        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Parent", None, None).unwrap();

        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("My Login"),
            &serde_json::json!({"username": "alice", "password": "secret"}),
        )
        .unwrap();

        // 通过 API 读回应该是明文
        let found = EntryRepo::get_by_id(&conn, &entry.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(found.title_ct, Some(b"My Login".to_vec()));

        // 但数据库中的原始字节应该是密文（不同于明文）
        let raw_title: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT title_ct FROM entries WHERE entry_id = ?1",
                params![entry.entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(raw_title, b"My Login");
        assert!(!raw_title.is_empty());

        let raw_payload: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT payload_ct FROM entries WHERE entry_id = ?1",
                params![entry.entry_id],
                |row| row.get(0),
            )
            .unwrap();
        let expected_plain =
            serde_json::to_vec(&serde_json::json!({"username": "alice", "password": "secret"}))
                .unwrap();
        assert_ne!(raw_payload, expected_plain);

        let changed_object_ids_ct: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT changed_object_ids_ct FROM commits WHERE commit_id = ?1",
                params![entry.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        let changed_plain = serde_json::to_vec(&vec![entry.entry_id.clone()]).unwrap();
        assert_ne!(changed_object_ids_ct, changed_plain);

        let integrity_tag: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT integrity_tag FROM commits WHERE commit_id = ?1",
                params![entry.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(integrity_tag.len(), 32);
        assert_ne!(integrity_tag, vec![0]);
    }

    #[test]
    fn test_encrypted_entry_tamper_is_rejected() {
        use mdbx_crypto::keyring::Keyring;

        let mut conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring = Keyring::from_vault_key(&vault_key, b"entry-tamper-test").unwrap();
        conn.attach_keyring(keyring);

        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Parent", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Tamper Me"),
            &login_payload(),
        )
        .unwrap();

        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = ?1 WHERE entry_id = ?2",
                params![b"not-valid-ciphertext".as_slice(), entry.entry_id],
            )
            .unwrap();

        assert!(EntryRepo::get_by_id(&conn, &entry.entry_id).is_err());
    }
}
