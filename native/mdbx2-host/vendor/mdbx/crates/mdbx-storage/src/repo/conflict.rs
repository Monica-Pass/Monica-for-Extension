use rusqlite::params;
use rusqlite::OptionalExtension;
use uuid::Uuid;

use mdbx_core::model::{
    Attachment, Conflict, ConflictObjectType, ConflictResolution, ObjectLabel,
    ObjectLabelAssignment, ObjectRelation, Project, RelationKindId,
};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::repo::entry::EntryRepo;
use crate::repo::object_version::ObjectVersionRepo;
use crate::repo::{
    AttachmentRepo, CollectionProfileRepo, ProjectRepo, TombstoneAcknowledgementRepo,
};
use crate::sync_state::{
    AttachmentRow, EntryRow, ObjectLabelAssignmentRow, ObjectLabelRow, ObjectRelationRow,
    ProjectRow,
};

/// 冲突记录的持久化仓库。
///
/// 冲突由 ConflictDetector 检测后写入此表，
/// 后续供 UI 层查询并交由用户手动解决。
pub struct ConflictRepo;

#[derive(Debug, Clone)]
pub struct ConflictCreateRequest<'a> {
    pub object_type: ConflictObjectType,
    pub object_id: &'a str,
    pub base_commit_id: &'a str,
    pub local_commit_id: &'a str,
    pub incoming_commit_id: &'a str,
    pub conflicting_fields: &'a [String],
}

impl ConflictRepo {
    /// 记录一个新的冲突。
    // Kept for MDBX1 callers; new code should use ConflictCreateRequest.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        conn: &VaultConnection,
        ctx: &CommitContext,
        object_type: ConflictObjectType,
        object_id: &str,
        base_commit_id: &str,
        local_commit_id: &str,
        incoming_commit_id: &str,
        conflicting_fields: &[String],
    ) -> StorageResult<Conflict> {
        Self::create_with_request(
            conn,
            ctx,
            ConflictCreateRequest {
                object_type,
                object_id,
                base_commit_id,
                local_commit_id,
                incoming_commit_id,
                conflicting_fields,
            },
        )
    }

    pub fn create_with_request(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: ConflictCreateRequest<'_>,
    ) -> StorageResult<Conflict> {
        let ConflictCreateRequest {
            object_type,
            object_id,
            base_commit_id,
            local_commit_id,
            incoming_commit_id,
            conflicting_fields,
        } = request;
        let now = chrono::Utc::now().to_rfc3339();
        let conflict_id = Uuid::new_v4().to_string();
        let fields_json = serde_json::to_string(conflicting_fields)
            .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;

        conn.inner().execute(
            "INSERT INTO conflicts (conflict_id, object_type, object_id,
             base_commit_id, local_commit_id, incoming_commit_id,
             conflicting_fields, resolution, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'unresolved', ?8)",
            params![
                conflict_id,
                object_type.to_string(),
                object_id,
                base_commit_id,
                local_commit_id,
                incoming_commit_id,
                fields_json,
                now,
            ],
        )?;

        // 也创建一个 commit 记录此冲突（无 parent，冲突是新事件）
        ctx.create_commit(conn, "change", "multi", &[conflict_id.clone()], &[])?;

        Ok(Conflict {
            conflict_id,
            object_type,
            object_id: object_id.to_string(),
            base_commit_id: base_commit_id.to_string(),
            local_commit_id: local_commit_id.to_string(),
            incoming_commit_id: incoming_commit_id.to_string(),
            conflicting_fields: conflicting_fields.to_vec(),
            resolution: ConflictResolution::Unresolved,
            created_at: now,
            resolved_at: None,
        })
    }

    /// 按 ID 查询冲突。
    pub fn get_by_id(conn: &VaultConnection, conflict_id: &str) -> StorageResult<Option<Conflict>> {
        conn.inner()
            .query_row(
                "SELECT conflict_id, object_type, object_id,
                        base_commit_id, local_commit_id, incoming_commit_id,
                        conflicting_fields, resolution, created_at, resolved_at
                 FROM conflicts WHERE conflict_id = ?1",
                params![conflict_id],
                |row| {
                    Ok(Conflict {
                        conflict_id: row.get(0)?,
                        object_type: {
                            let s: String = row.get(1)?;
                            s.parse().unwrap_or(ConflictObjectType::Entry)
                        },
                        object_id: row.get(2)?,
                        base_commit_id: row.get(3)?,
                        local_commit_id: row.get(4)?,
                        incoming_commit_id: row.get(5)?,
                        conflicting_fields: {
                            let s: String = row.get(6)?;
                            serde_json::from_str(&s).unwrap_or_default()
                        },
                        resolution: {
                            let s: String = row.get(7)?;
                            s.parse().unwrap_or(ConflictResolution::Unresolved)
                        },
                        created_at: row.get(8)?,
                        resolved_at: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)
    }

    /// 列出所有未解决的冲突。
    pub fn list_unresolved(conn: &VaultConnection) -> StorageResult<Vec<Conflict>> {
        ConflictRepo::list_where(conn, "resolution = 'unresolved'", [])
    }

    /// 列出指定对象的所有冲突。
    pub fn list_by_object(
        conn: &VaultConnection,
        object_type: ConflictObjectType,
        object_id: &str,
    ) -> StorageResult<Vec<Conflict>> {
        ConflictRepo::list_where(
            conn,
            "object_type = ?1 AND object_id = ?2",
            params![object_type.to_string(), object_id],
        )
    }

    /// Legacy MDBX1 method retained as an explicit compatibility error.
    ///
    /// A conflict cannot be resolved safely without an object-specific state
    /// write and merge commit. Call one of the typed resolution methods.
    #[deprecated(note = "use a typed conflict resolution method with CommitContext")]
    pub fn resolve(
        _conn: &VaultConnection,
        _conflict_id: &str,
        _resolution: ConflictResolution,
    ) -> StorageResult<()> {
        Err(StorageError::ConstraintViolation(
            "legacy conflict flag updates are disabled; use a typed conflict resolution method"
                .to_string(),
        ))
    }

    fn mark_resolved(
        conn: &VaultConnection,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let affected = conn.inner().execute(
            "UPDATE conflicts SET resolution = ?2, resolved_at = ?3
             WHERE conflict_id = ?1",
            params![conflict_id, resolution.to_string(), now],
        )?;

        if affected == 0 {
            return Err(StorageError::NotFound(conflict_id.to_string()));
        }
        Ok(())
    }

    /// Resolve an entry conflict and write the chosen result back into history.
    ///
    /// This is the storage-core operation Android should call eventually:
    /// resolving a conflict is itself a tracked mutation, not just a metadata
    /// flag update on the conflict row.
    pub fn resolve_entry(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Entry,
                "resolve_entry",
            )?;

            match resolution {
                ConflictResolution::LocalWins => {
                    Self::write_entry_local_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::IncomingWins => {
                    Self::write_entry_incoming_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::Custom => {
                    return Err(StorageError::ConstraintViolation(
                        "custom conflict resolution requires an explicit merged payload"
                            .to_string(),
                    ));
                }
                ConflictResolution::Unresolved => {
                    return Err(StorageError::ConstraintViolation(
                        "cannot resolve a conflict as unresolved".to_string(),
                    ));
                }
            }

            Self::mark_resolved(conn, conflict_id, resolution)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve an entry conflict with a caller-provided merged JSON payload.
    ///
    /// The current local entry keeps its structural fields (project, type,
    /// title, Tiga override, deleted state), while `merged_payload` replaces
    /// the encrypted record payload under a new merge commit.
    pub fn resolve_entry_custom_payload(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged_payload: &serde_json::Value,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Entry,
                "resolve_entry_custom_payload",
            )?;

            Self::write_entry_custom_payload_resolution(conn, ctx, &conflict, merged_payload)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a project conflict and write the chosen project snapshot back.
    pub fn resolve_project(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Project,
                "resolve_project",
            )?;

            match resolution {
                ConflictResolution::LocalWins => {
                    Self::write_project_local_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::IncomingWins => {
                    Self::write_project_incoming_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::Custom => {
                    return Err(StorageError::ConstraintViolation(
                        "custom project conflict resolution requires an explicit merged row"
                            .to_string(),
                    ));
                }
                ConflictResolution::Unresolved => {
                    return Err(StorageError::ConstraintViolation(
                        "cannot resolve a conflict as unresolved".to_string(),
                    ));
                }
            }

            Self::mark_resolved(conn, conflict_id, resolution)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a project conflict with a caller-provided merged row.
    pub fn resolve_project_custom_row(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &ProjectRow,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Project,
                "resolve_project_custom_row",
            )?;
            if merged.project_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom project resolution row does not match conflict object".to_string(),
                ));
            }

            Self::write_project_custom_row_resolution(conn, ctx, &conflict, merged)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a project conflict from a decrypted, client-facing project.
    ///
    /// Storage-owned fields and policy metadata are preserved from the current
    /// row. Only user-editable presentation and lifecycle fields are merged,
    /// and plaintext metadata is encrypted again before the row is applied.
    pub fn resolve_project_custom(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &Project,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Project,
                "resolve_project_custom",
            )?;
            if merged.project_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom project does not match conflict object".to_string(),
                ));
            }

            let current = ObjectVersionRepo::current_project_row(conn, &conflict.object_id)?;
            let merged_tiga_mode = merged.tiga_mode_override.as_ref().map(ToString::to_string);
            if merged_tiga_mode != current.tiga_mode_override
                || merged.attachment_count != current.attachment_count
            {
                return Err(StorageError::ConstraintViolation(
                    "custom project resolution cannot change policy or derived counters"
                        .to_string(),
                ));
            }
            let row = ProjectRow {
                project_id: current.project_id.clone(),
                title_ct: ProjectRepo::encrypt_metadata(
                    conn,
                    &current.project_id,
                    "title",
                    &merged.title_ct,
                )?,
                summary_ct: merged
                    .summary_ct
                    .as_ref()
                    .map(|value| {
                        ProjectRepo::encrypt_metadata(conn, &current.project_id, "summary", value)
                    })
                    .transpose()?,
                group_id: merged.group_id.clone(),
                icon_ref: merged.icon_ref.clone(),
                favorite: merged.favorite,
                archived: merged.archived,
                deleted: merged.deleted,
                tiga_mode_override: current.tiga_mode_override.clone(),
                object_clock: current.object_clock.clone(),
                head_commit_id: current.head_commit_id.clone(),
                attachment_count: current.attachment_count,
                created_at: current.created_at.clone(),
                updated_at: current.updated_at.clone(),
                created_by_device_id: current.created_by_device_id.clone(),
                updated_by_device_id: current.updated_by_device_id.clone(),
                collection_profile: current.collection_profile.clone(),
            };

            Self::write_project_custom_row_resolution(conn, ctx, &conflict, &row)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve an attachment conflict and write the chosen metadata back.
    ///
    /// Incoming-wins refuses to point metadata at attachment content that is
    /// not already present locally. This keeps conflict resolution from
    /// manufacturing a content hash without bytes behind it.
    pub fn resolve_attachment(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Attachment,
                "resolve_attachment",
            )?;

            match resolution {
                ConflictResolution::LocalWins => {
                    Self::write_attachment_local_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::IncomingWins => {
                    Self::write_attachment_incoming_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::Custom => {
                    return Err(StorageError::ConstraintViolation(
                        "custom attachment conflict resolution requires an explicit merged row"
                            .to_string(),
                    ));
                }
                ConflictResolution::Unresolved => {
                    return Err(StorageError::ConstraintViolation(
                        "cannot resolve a conflict as unresolved".to_string(),
                    ));
                }
            }

            Self::mark_resolved(conn, conflict_id, resolution)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve an attachment conflict with a caller-provided metadata row.
    pub fn resolve_attachment_custom_row(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &AttachmentRow,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Attachment,
                "resolve_attachment_custom_row",
            )?;
            if merged.attachment_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom attachment resolution row does not match conflict object".to_string(),
                ));
            }

            Self::ensure_attachment_content_material_is_local(conn, &conflict, merged)?;
            Self::write_attachment_custom_row_resolution(conn, ctx, &conflict, merged)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve attachment metadata from a decrypted, client-facing record.
    ///
    /// The current content identity remains authoritative. This method cannot
    /// manufacture a content hash or chunk set; callers must transfer content
    /// through the attachment/blob APIs before choosing a different body.
    pub fn resolve_attachment_custom(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &Attachment,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::Attachment,
                "resolve_attachment_custom",
            )?;
            if merged.attachment_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom attachment does not match conflict object".to_string(),
                ));
            }

            let current = ObjectVersionRepo::current_attachment_row(conn, &conflict.object_id)?;
            if merged.storage_mode.to_string() != current.storage_mode
                || merged.content_hash != current.content_hash
                || merged.original_size != current.original_size
                || merged.stored_size != current.stored_size
                || merged.chunk_count != current.chunk_count
            {
                return Err(StorageError::ConstraintViolation(
                    "custom attachment metadata resolution cannot change content identity"
                        .to_string(),
                ));
            }
            let row = AttachmentRow {
                attachment_id: current.attachment_id.clone(),
                project_id: merged.project_id.clone(),
                entry_id: merged.entry_id.clone(),
                file_name_ct: AttachmentRepo::encrypt_attachment_field(
                    conn,
                    &current.attachment_id,
                    "file_name",
                    &merged.file_name_ct,
                )?,
                media_type_ct: merged
                    .media_type_ct
                    .as_ref()
                    .map(|value| {
                        AttachmentRepo::encrypt_attachment_field(
                            conn,
                            &current.attachment_id,
                            "media_type",
                            value,
                        )
                    })
                    .transpose()?,
                storage_mode: current.storage_mode.clone(),
                content_hash: current.content_hash.clone(),
                original_size: current.original_size,
                stored_size: current.stored_size,
                chunk_count: current.chunk_count,
                head_commit_id: current.head_commit_id.clone(),
                deleted: merged.deleted,
                created_at: current.created_at.clone(),
                updated_at: current.updated_at.clone(),
                created_by_device_id: current.created_by_device_id.clone(),
                updated_by_device_id: current.updated_by_device_id.clone(),
            };

            Self::write_attachment_custom_row_resolution(conn, ctx, &conflict, &row)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a generic object-relation conflict and persist the selected state.
    pub fn resolve_object_relation(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::ObjectRelation,
                "resolve_object_relation",
            )?;
            match resolution {
                ConflictResolution::LocalWins => {
                    Self::write_object_relation_local_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::IncomingWins => {
                    Self::write_object_relation_incoming_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::Custom => {
                    return Err(StorageError::ConstraintViolation(
                        "custom object relation resolution requires an explicit merged relation"
                            .to_string(),
                    ));
                }
                ConflictResolution::Unresolved => {
                    return Err(StorageError::ConstraintViolation(
                        "cannot resolve a conflict as unresolved".to_string(),
                    ));
                }
            }
            Self::mark_resolved(conn, conflict_id, resolution)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a relation conflict with caller-provided plaintext metadata.
    pub fn resolve_object_relation_custom(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &ObjectRelation,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::ObjectRelation,
                "resolve_object_relation_custom",
            )?;
            if merged.relation_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom relation does not match conflict object".to_string(),
                ));
            }
            let current =
                ObjectVersionRepo::current_object_relation_row(conn, &conflict.object_id)?;
            let row = ObjectRelationRow {
                relation_id: merged.relation_id.clone(),
                source_object_id: merged.source_object_id.clone(),
                target_object_id: merged.target_object_id.clone(),
                relation_kind: merged.relation_kind.to_string(),
                payload_ct: encrypt_field(
                    conn,
                    FieldKeyPurpose::Record,
                    &merged.payload_ct,
                    "object-relation",
                    &merged.relation_id,
                    "payload",
                )?,
                payload_schema_version: merged.payload_schema_version,
                object_clock: current.object_clock.clone(),
                head_commit_id: current.head_commit_id.clone(),
                deleted: merged.deleted,
                created_at: current.created_at.clone(),
                updated_at: current.updated_at.clone(),
                created_by_device_id: current.created_by_device_id.clone(),
                updated_by_device_id: current.updated_by_device_id.clone(),
            };
            Self::write_object_relation_row_resolution(conn, ctx, &conflict, &current, &row)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a generic object-label conflict and persist the selected state.
    pub fn resolve_object_label(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::ObjectLabel,
                "resolve_object_label",
            )?;
            match resolution {
                ConflictResolution::LocalWins => {
                    Self::write_object_label_local_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::IncomingWins => {
                    Self::write_object_label_incoming_wins_resolution(conn, ctx, &conflict)?;
                }
                ConflictResolution::Custom => {
                    return Err(StorageError::ConstraintViolation(
                        "custom object label resolution requires an explicit merged label"
                            .to_string(),
                    ));
                }
                ConflictResolution::Unresolved => {
                    return Err(StorageError::ConstraintViolation(
                        "cannot resolve a conflict as unresolved".to_string(),
                    ));
                }
            }
            Self::mark_resolved(conn, conflict_id, resolution)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a label conflict with caller-provided plaintext metadata.
    pub fn resolve_object_label_custom(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &ObjectLabel,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::ObjectLabel,
                "resolve_object_label_custom",
            )?;
            if merged.label_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom label does not match conflict object".to_string(),
                ));
            }
            let current = ObjectVersionRepo::current_object_label_row(conn, &conflict.object_id)?;
            let row = ObjectLabelRow {
                label_id: merged.label_id.clone(),
                collection_id: merged.collection_id.clone(),
                name_ct: encrypt_field(
                    conn,
                    FieldKeyPurpose::Metadata,
                    &merged.name_ct,
                    "object-label",
                    &merged.label_id,
                    "name",
                )?,
                payload_ct: encrypt_field(
                    conn,
                    FieldKeyPurpose::Record,
                    &merged.payload_ct,
                    "object-label",
                    &merged.label_id,
                    "payload",
                )?,
                payload_schema_version: merged.payload_schema_version,
                object_clock: current.object_clock.clone(),
                head_commit_id: current.head_commit_id.clone(),
                deleted: merged.deleted,
                created_at: current.created_at.clone(),
                updated_at: current.updated_at.clone(),
                created_by_device_id: current.created_by_device_id.clone(),
                updated_by_device_id: current.updated_by_device_id.clone(),
            };
            Self::write_object_label_row_resolution(conn, ctx, &conflict, &current, &row)?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve a generic label-assignment conflict and persist the selected state.
    pub fn resolve_object_label_assignment(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::ObjectLabelAssignment,
                "resolve_object_label_assignment",
            )?;
            match resolution {
                ConflictResolution::LocalWins => {
                    Self::write_object_label_assignment_local_wins_resolution(
                        conn, ctx, &conflict,
                    )?;
                }
                ConflictResolution::IncomingWins => {
                    Self::write_object_label_assignment_incoming_wins_resolution(
                        conn, ctx, &conflict,
                    )?;
                }
                ConflictResolution::Custom => {
                    return Err(StorageError::ConstraintViolation(
                        "custom label assignment resolution requires an explicit merged assignment"
                            .to_string(),
                    ));
                }
                ConflictResolution::Unresolved => {
                    return Err(StorageError::ConstraintViolation(
                        "cannot resolve a conflict as unresolved".to_string(),
                    ));
                }
            }
            Self::mark_resolved(conn, conflict_id, resolution)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// Resolve an assignment conflict with a caller-provided logical state.
    pub fn resolve_object_label_assignment_custom(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict_id: &str,
        merged: &ObjectLabelAssignment,
    ) -> StorageResult<Conflict> {
        conn.with_immediate_transaction(|| {
            let conflict = Self::load_unresolved_typed_conflict(
                conn,
                conflict_id,
                ConflictObjectType::ObjectLabelAssignment,
                "resolve_object_label_assignment_custom",
            )?;
            if merged.assignment_id != conflict.object_id {
                return Err(StorageError::ConstraintViolation(
                    "custom assignment does not match conflict object".to_string(),
                ));
            }
            let current =
                ObjectVersionRepo::current_object_label_assignment_row(conn, &conflict.object_id)?;
            let row = ObjectLabelAssignmentRow {
                assignment_id: merged.assignment_id.clone(),
                object_id: merged.object_id.clone(),
                label_id: merged.label_id.clone(),
                object_clock: current.object_clock.clone(),
                head_commit_id: current.head_commit_id.clone(),
                deleted: merged.deleted,
                created_at: current.created_at.clone(),
                updated_at: current.updated_at.clone(),
                created_by_device_id: current.created_by_device_id.clone(),
                updated_by_device_id: current.updated_by_device_id.clone(),
            };
            Self::write_object_label_assignment_row_resolution(
                conn, ctx, &conflict, &current, &row,
            )?;
            Self::mark_resolved(conn, conflict_id, ConflictResolution::Custom)?;
            Self::get_by_id(conn, conflict_id)?
                .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))
        })
    }

    /// 检查指定对象是否存在未解决的冲突。
    pub fn has_unresolved_conflict(
        conn: &VaultConnection,
        object_type: ConflictObjectType,
        object_id: &str,
    ) -> StorageResult<bool> {
        let count: i32 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM conflicts
                 WHERE object_type = ?1 AND object_id = ?2 AND resolution = 'unresolved'",
                params![object_type.to_string(), object_id],
                |row| row.get(0),
            )
            .map_err(StorageError::Database)?;
        Ok(count > 0)
    }

    fn list_where(
        conn: &VaultConnection,
        where_clause: &str,
        params: impl rusqlite::Params,
    ) -> StorageResult<Vec<Conflict>> {
        let sql = format!(
            "SELECT conflict_id, object_type, object_id,
                    base_commit_id, local_commit_id, incoming_commit_id,
                    conflicting_fields, resolution, created_at, resolved_at
             FROM conflicts WHERE {} ORDER BY created_at DESC",
            where_clause
        );

        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(params, |row| {
            Ok(Conflict {
                conflict_id: row.get(0)?,
                object_type: {
                    let s: String = row.get(1)?;
                    s.parse().unwrap_or(ConflictObjectType::Entry)
                },
                object_id: row.get(2)?,
                base_commit_id: row.get(3)?,
                local_commit_id: row.get(4)?,
                incoming_commit_id: row.get(5)?,
                conflicting_fields: {
                    let s: String = row.get(6)?;
                    serde_json::from_str(&s).unwrap_or_default()
                },
                resolution: {
                    let s: String = row.get(7)?;
                    s.parse().unwrap_or(ConflictResolution::Unresolved)
                },
                created_at: row.get(8)?,
                resolved_at: row.get(9)?,
            })
        })?;

        let mut conflicts = Vec::new();
        for row in rows {
            conflicts.push(row?);
        }
        Ok(conflicts)
    }

    fn load_unresolved_typed_conflict(
        conn: &VaultConnection,
        conflict_id: &str,
        expected_type: ConflictObjectType,
        api_name: &str,
    ) -> StorageResult<Conflict> {
        let conflict = Self::get_by_id(conn, conflict_id)?
            .ok_or_else(|| StorageError::NotFound(conflict_id.to_string()))?;

        if conflict.object_type != expected_type {
            return Err(StorageError::ConstraintViolation(format!(
                "only {} conflicts can be resolved through {}",
                expected_type, api_name
            )));
        }
        if conflict.resolution != ConflictResolution::Unresolved {
            return Err(StorageError::ConstraintViolation(format!(
                "conflict {} is already resolved",
                conflict_id
            )));
        }
        Ok(conflict)
    }

    fn write_entry_local_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_entry_row(conn, &conflict.object_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE entries SET object_clock = ?2, head_commit_id = ?3,
             updated_at = ?4, updated_by_device_id = ?5
             WHERE entry_id = ?1",
            params![
                conflict.object_id,
                bump_object_clock(&current.object_clock),
                commit_id,
                now,
                ctx.device_id,
            ],
        )?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "entry",
            &conflict.object_id,
            &commit_id,
            current.deleted,
        )?;
        ObjectVersionRepo::record_entry_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_entry_incoming_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_entry_row(conn, &conflict.object_id)?;
        let incoming =
            ObjectVersionRepo::get_entry(conn, &conflict.object_id, &conflict.incoming_commit_id)?
                .ok_or_else(|| {
                    StorageError::NotFound(format!(
                        "incoming entry snapshot {}@{}",
                        conflict.object_id, conflict.incoming_commit_id
                    ))
                })?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        Self::apply_entry_row_for_resolution(
            conn,
            ctx,
            &incoming,
            &commit_id,
            &bump_object_clock(&current.object_clock),
        )?;
        ObjectVersionRepo::record_entry_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_entry_custom_payload_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        merged_payload: &serde_json::Value,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_entry_row(conn, &conflict.object_id)?;
        if current.deleted {
            return Err(StorageError::ConstraintViolation(
                "custom payload resolution cannot revive a deleted entry".to_string(),
            ));
        }
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let payload_plain = serde_json::to_vec(merged_payload)
            .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
        let payload_ct =
            EntryRepo::encrypt_payload_blob(conn, &conflict.object_id, &payload_plain)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE entries SET payload_ct = ?2, object_clock = ?3,
             head_commit_id = ?4, deleted = 0, updated_at = ?5,
             updated_by_device_id = ?6
             WHERE entry_id = ?1",
            params![
                conflict.object_id,
                payload_ct,
                bump_object_clock(&current.object_clock),
                commit_id,
                now,
                ctx.device_id,
            ],
        )?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "entry",
            &conflict.object_id,
            &commit_id,
            false,
        )?;
        ObjectVersionRepo::record_entry_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_project_local_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_project_row(conn, &conflict.object_id)?;
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, &current.project_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE projects SET object_clock = ?2, head_commit_id = ?3,
             updated_at = ?4, updated_by_device_id = ?5
             WHERE project_id = ?1",
            params![
                conflict.object_id,
                bump_object_clock(&current.object_clock),
                commit_id,
                now,
                ctx.device_id,
            ],
        )?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "project",
            &conflict.object_id,
            &commit_id,
            current.deleted,
        )?;
        ObjectVersionRepo::record_project_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_project_incoming_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_project_row(conn, &conflict.object_id)?;
        let incoming = ObjectVersionRepo::get_project(
            conn,
            &conflict.object_id,
            &conflict.incoming_commit_id,
        )?
        .ok_or_else(|| {
            StorageError::NotFound(format!(
                "incoming project snapshot {}@{}",
                conflict.object_id, conflict.incoming_commit_id
            ))
        })?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        Self::apply_project_row_for_resolution(
            conn,
            ctx,
            &incoming,
            &commit_id,
            &bump_object_clock(&current.object_clock),
        )?;
        ObjectVersionRepo::record_project_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_project_custom_row_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        merged: &ProjectRow,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_project_row(conn, &conflict.object_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        Self::apply_project_row_for_resolution(
            conn,
            ctx,
            merged,
            &commit_id,
            &bump_object_clock(&current.object_clock),
        )?;
        ObjectVersionRepo::record_project_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_attachment_local_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_attachment_row(conn, &conflict.object_id)?;
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, &current.project_id)?;
        Self::ensure_attachment_parent_is_valid(conn, &current)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE attachments SET head_commit_id = ?2,
             updated_at = ?3, updated_by_device_id = ?4
             WHERE attachment_id = ?1",
            params![conflict.object_id, commit_id, now, ctx.device_id],
        )?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "attachment",
            &conflict.object_id,
            &commit_id,
            current.deleted,
        )?;
        ObjectVersionRepo::record_attachment_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_attachment_incoming_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_attachment_row(conn, &conflict.object_id)?;
        let incoming = ObjectVersionRepo::get_attachment(
            conn,
            &conflict.object_id,
            &conflict.incoming_commit_id,
        )?
        .ok_or_else(|| {
            StorageError::NotFound(format!(
                "incoming attachment snapshot {}@{}",
                conflict.object_id, conflict.incoming_commit_id
            ))
        })?;
        Self::ensure_attachment_content_material_is_local(conn, conflict, &incoming)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        Self::apply_attachment_row_for_resolution(conn, ctx, &incoming, &commit_id)?;
        ObjectVersionRepo::record_attachment_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_attachment_custom_row_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        merged: &AttachmentRow,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_attachment_row(conn, &conflict.object_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        Self::apply_attachment_row_for_resolution(conn, ctx, merged, &commit_id)?;
        ObjectVersionRepo::record_attachment_current(conn, &commit_id, &conflict.object_id)?;
        Ok(())
    }

    fn write_object_relation_local_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_object_relation_row(conn, &conflict.object_id)?;
        Self::write_object_relation_row_resolution(conn, ctx, conflict, &current, &current)
    }

    fn write_object_relation_incoming_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_object_relation_row(conn, &conflict.object_id)?;
        let incoming = ObjectVersionRepo::get_object_relation(
            conn,
            &conflict.object_id,
            &conflict.incoming_commit_id,
        )?
        .ok_or_else(|| {
            StorageError::NotFound(format!(
                "incoming object relation snapshot {}@{}",
                conflict.object_id, conflict.incoming_commit_id
            ))
        })?;
        Self::write_object_relation_row_resolution(conn, ctx, conflict, &current, &incoming)
    }

    fn write_object_relation_row_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        current: &ObjectRelationRow,
        selected: &ObjectRelationRow,
    ) -> StorageResult<()> {
        Self::validate_object_relation_resolution_row(conn, conflict, selected)?;
        CollectionProfileRepo::ensure_entry_write_capabilities(conn, &selected.source_object_id)?;
        CollectionProfileRepo::ensure_entry_write_capabilities(conn, &selected.target_object_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let affected = conn.inner().execute(
            "UPDATE object_relations SET source_object_id = ?2, target_object_id = ?3,
                relation_kind = ?4, payload_ct = ?5, payload_schema_version = ?6,
                object_clock = ?7, head_commit_id = ?8, deleted = ?9,
                updated_at = ?10, updated_by_device_id = ?11
             WHERE relation_id = ?1",
            params![
                selected.relation_id,
                selected.source_object_id,
                selected.target_object_id,
                selected.relation_kind,
                selected.payload_ct,
                selected.payload_schema_version as i64,
                bump_object_clock(&current.object_clock),
                commit_id,
                selected.deleted as i32,
                chrono::Utc::now().to_rfc3339(),
                ctx.device_id,
            ],
        )?;
        Self::ensure_resolution_updated(affected, &conflict.object_id)?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "object-relation",
            &conflict.object_id,
            &commit_id,
            selected.deleted,
        )?;
        ObjectVersionRepo::record_object_relation_current(conn, &commit_id, &conflict.object_id)
    }

    fn write_object_label_local_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_object_label_row(conn, &conflict.object_id)?;
        Self::write_object_label_row_resolution(conn, ctx, conflict, &current, &current)
    }

    fn write_object_label_incoming_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_object_label_row(conn, &conflict.object_id)?;
        let incoming = ObjectVersionRepo::get_object_label(
            conn,
            &conflict.object_id,
            &conflict.incoming_commit_id,
        )?
        .ok_or_else(|| {
            StorageError::NotFound(format!(
                "incoming object label snapshot {}@{}",
                conflict.object_id, conflict.incoming_commit_id
            ))
        })?;
        Self::write_object_label_row_resolution(conn, ctx, conflict, &current, &incoming)
    }

    fn write_object_label_row_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        current: &ObjectLabelRow,
        selected: &ObjectLabelRow,
    ) -> StorageResult<()> {
        Self::validate_object_label_resolution_row(conn, conflict, current, selected)?;
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, &selected.collection_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let affected = conn.inner().execute(
            "UPDATE object_labels SET name_ct = ?2, payload_ct = ?3,
                payload_schema_version = ?4, object_clock = ?5, head_commit_id = ?6,
                deleted = ?7, updated_at = ?8, updated_by_device_id = ?9
             WHERE label_id = ?1",
            params![
                selected.label_id,
                selected.name_ct,
                selected.payload_ct,
                selected.payload_schema_version as i64,
                bump_object_clock(&current.object_clock),
                commit_id,
                selected.deleted as i32,
                chrono::Utc::now().to_rfc3339(),
                ctx.device_id,
            ],
        )?;
        Self::ensure_resolution_updated(affected, &conflict.object_id)?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "object-label",
            &conflict.object_id,
            &commit_id,
            selected.deleted,
        )?;
        ObjectVersionRepo::record_object_label_current(conn, &commit_id, &conflict.object_id)
    }

    fn write_object_label_assignment_local_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current =
            ObjectVersionRepo::current_object_label_assignment_row(conn, &conflict.object_id)?;
        Self::write_object_label_assignment_row_resolution(conn, ctx, conflict, &current, &current)
    }

    fn write_object_label_assignment_incoming_wins_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
    ) -> StorageResult<()> {
        let current =
            ObjectVersionRepo::current_object_label_assignment_row(conn, &conflict.object_id)?;
        let incoming = ObjectVersionRepo::get_object_label_assignment(
            conn,
            &conflict.object_id,
            &conflict.incoming_commit_id,
        )?
        .ok_or_else(|| {
            StorageError::NotFound(format!(
                "incoming object label assignment snapshot {}@{}",
                conflict.object_id, conflict.incoming_commit_id
            ))
        })?;
        Self::write_object_label_assignment_row_resolution(conn, ctx, conflict, &current, &incoming)
    }

    fn write_object_label_assignment_row_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        current: &ObjectLabelAssignmentRow,
        selected: &ObjectLabelAssignmentRow,
    ) -> StorageResult<()> {
        Self::validate_object_label_assignment_resolution_row(conn, conflict, current, selected)?;
        CollectionProfileRepo::ensure_entry_write_capabilities(conn, &selected.object_id)?;
        let commit_id =
            Self::create_resolution_commit(conn, ctx, conflict, &current.head_commit_id)?;
        let affected = conn.inner().execute(
            "UPDATE object_label_assignments SET object_clock = ?2, head_commit_id = ?3,
                deleted = ?4, updated_at = ?5, updated_by_device_id = ?6
             WHERE assignment_id = ?1",
            params![
                selected.assignment_id,
                bump_object_clock(&current.object_clock),
                commit_id,
                selected.deleted as i32,
                chrono::Utc::now().to_rfc3339(),
                ctx.device_id,
            ],
        )?;
        Self::ensure_resolution_updated(affected, &conflict.object_id)?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "object-label-assignment",
            &conflict.object_id,
            &commit_id,
            selected.deleted,
        )?;
        ObjectVersionRepo::record_object_label_assignment_current(
            conn,
            &commit_id,
            &conflict.object_id,
        )
    }

    fn validate_object_relation_resolution_row(
        conn: &VaultConnection,
        conflict: &Conflict,
        row: &ObjectRelationRow,
    ) -> StorageResult<()> {
        if row.relation_id != conflict.object_id {
            return Err(StorageError::ConstraintViolation(
                "relation resolution row does not match conflict object".to_string(),
            ));
        }
        Uuid::parse_str(&row.relation_id).map_err(|_| {
            StorageError::Validation("relation resolution ID must be a UUID".to_string())
        })?;
        RelationKindId::new(&row.relation_kind).map_err(StorageError::Validation)?;
        Self::validate_payload_schema_version(row.payload_schema_version)?;
        if row.source_object_id == row.target_object_id {
            return Err(StorageError::Validation(
                "relation resolution cannot create a self relation".to_string(),
            ));
        }
        decrypt_field(
            conn,
            FieldKeyPurpose::Record,
            &row.payload_ct,
            "object-relation",
            &row.relation_id,
            "payload",
        )?;
        if !row.deleted {
            Self::ensure_active_entry(conn, &row.source_object_id)?;
            Self::ensure_active_entry(conn, &row.target_object_id)?;
        }
        Ok(())
    }

    fn validate_object_label_resolution_row(
        conn: &VaultConnection,
        conflict: &Conflict,
        current: &ObjectLabelRow,
        row: &ObjectLabelRow,
    ) -> StorageResult<()> {
        if row.label_id != conflict.object_id {
            return Err(StorageError::ConstraintViolation(
                "label resolution row does not match conflict object".to_string(),
            ));
        }
        if row.collection_id != current.collection_id {
            return Err(StorageError::ConstraintViolation(
                "label collection cannot change during conflict resolution".to_string(),
            ));
        }
        Self::validate_payload_schema_version(row.payload_schema_version)?;
        let name = decrypt_field(
            conn,
            FieldKeyPurpose::Metadata,
            &row.name_ct,
            "object-label",
            &row.label_id,
            "name",
        )?;
        let name = std::str::from_utf8(&name)
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        if name.trim().is_empty() || name.len() > 512 {
            return Err(StorageError::Validation(
                "object label name must contain 1 to 512 UTF-8 bytes".to_string(),
            ));
        }
        decrypt_field(
            conn,
            FieldKeyPurpose::Record,
            &row.payload_ct,
            "object-label",
            &row.label_id,
            "payload",
        )?;
        if row.deleted {
            let active_assignments: i64 = conn.inner().query_row(
                "SELECT COUNT(*) FROM object_label_assignments
                 WHERE label_id = ?1 AND deleted = 0",
                params![row.label_id],
                |stored| stored.get(0),
            )?;
            if active_assignments > 0 {
                return Err(StorageError::ConstraintViolation(
                    "label conflict deletion requires its assignments to be deleted first"
                        .to_string(),
                ));
            }
        } else {
            Self::ensure_active_collection(conn, &row.collection_id)?;
        }
        Ok(())
    }

    fn validate_object_label_assignment_resolution_row(
        conn: &VaultConnection,
        conflict: &Conflict,
        current: &ObjectLabelAssignmentRow,
        row: &ObjectLabelAssignmentRow,
    ) -> StorageResult<()> {
        if row.assignment_id != conflict.object_id {
            return Err(StorageError::ConstraintViolation(
                "assignment resolution row does not match conflict object".to_string(),
            ));
        }
        if row.object_id != current.object_id || row.label_id != current.label_id {
            return Err(StorageError::ConstraintViolation(
                "assignment object and label identities cannot change during conflict resolution"
                    .to_string(),
            ));
        }
        if !row.deleted {
            let object_collection = Self::active_entry_collection(conn, &row.object_id)?;
            let label_collection = Self::active_label_collection(conn, &row.label_id)?;
            if object_collection != label_collection {
                return Err(StorageError::ConstraintViolation(
                    "assignment object and label must belong to the same collection".to_string(),
                ));
            }
            let duplicate: i64 = conn.inner().query_row(
                "SELECT COUNT(*) FROM object_label_assignments
                 WHERE object_id = ?1 AND label_id = ?2 AND deleted = 0
                   AND assignment_id <> ?3",
                params![row.object_id, row.label_id, row.assignment_id],
                |stored| stored.get(0),
            )?;
            if duplicate > 0 {
                return Err(StorageError::ConstraintViolation(
                    "assignment resolution would create a duplicate active assignment".to_string(),
                ));
            }
        }
        Ok(())
    }

    fn validate_payload_schema_version(value: u32) -> StorageResult<()> {
        if value == 0 {
            return Err(StorageError::Validation(
                "payload_schema_version must be greater than zero".to_string(),
            ));
        }
        Ok(())
    }

    fn ensure_active_entry(conn: &VaultConnection, object_id: &str) -> StorageResult<()> {
        Self::active_entry_collection(conn, object_id).map(|_| ())
    }

    fn active_entry_collection(conn: &VaultConnection, object_id: &str) -> StorageResult<String> {
        let row = conn
            .inner()
            .query_row(
                "SELECT project_id, deleted FROM entries WHERE entry_id = ?1",
                params![object_id],
                |stored| Ok((stored.get::<_, String>(0)?, stored.get::<_, i32>(1)?)),
            )
            .optional()?;
        match row {
            None => Err(StorageError::NotFound(object_id.to_string())),
            Some((collection_id, 0)) => Ok(collection_id),
            Some(_) => Err(StorageError::ConstraintViolation(format!(
                "object {object_id} is deleted"
            ))),
        }
    }

    fn ensure_active_collection(conn: &VaultConnection, collection_id: &str) -> StorageResult<()> {
        let deleted = conn
            .inner()
            .query_row(
                "SELECT deleted FROM projects WHERE project_id = ?1",
                params![collection_id],
                |stored| stored.get::<_, i32>(0),
            )
            .optional()?;
        match deleted {
            None => Err(StorageError::NotFound(collection_id.to_string())),
            Some(0) => Ok(()),
            Some(_) => Err(StorageError::ConstraintViolation(format!(
                "collection {collection_id} is deleted"
            ))),
        }
    }

    fn active_label_collection(conn: &VaultConnection, label_id: &str) -> StorageResult<String> {
        let row = conn
            .inner()
            .query_row(
                "SELECT collection_id, deleted FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |stored| Ok((stored.get::<_, String>(0)?, stored.get::<_, i32>(1)?)),
            )
            .optional()?;
        match row {
            None => Err(StorageError::NotFound(label_id.to_string())),
            Some((collection_id, 0)) => Ok(collection_id),
            Some(_) => Err(StorageError::ConstraintViolation(format!(
                "object label {label_id} is deleted"
            ))),
        }
    }

    fn reconcile_resolution_tombstone(
        conn: &VaultConnection,
        ctx: &CommitContext,
        object_type: &str,
        object_id: &str,
        delete_commit_id: &str,
        deleted: bool,
    ) -> StorageResult<()> {
        if deleted {
            let existing: i64 = conn.inner().query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE target_object_type = ?1 AND target_object_id = ?2",
                params![object_type, object_id],
                |row| row.get(0),
            )?;
            if existing == 0 {
                ctx.create_tombstone_for_commit(conn, object_type, object_id, delete_commit_id)?;
            } else {
                conn.inner().execute(
                    "UPDATE tombstones SET delete_commit_id = ?3,
                     delete_clock = (SELECT vector_clock FROM commits WHERE commit_id = ?3)
                     WHERE target_object_type = ?1 AND target_object_id = ?2",
                    params![object_type, object_id, delete_commit_id],
                )?;
                let mut stmt = conn.inner().prepare(
                    "SELECT tombstone_id FROM tombstones
                     WHERE target_object_type = ?1 AND target_object_id = ?2
                     ORDER BY tombstone_id",
                )?;
                let tombstone_ids = stmt
                    .query_map(params![object_type, object_id], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let acknowledged_at = chrono::Utc::now().to_rfc3339();
                for tombstone_id in tombstone_ids {
                    TombstoneAcknowledgementRepo::merge(
                        conn,
                        &tombstone_id,
                        &ctx.device_id,
                        delete_commit_id,
                        &acknowledged_at,
                    )?;
                }
            }
        } else {
            conn.inner().execute(
                "DELETE FROM tombstones
                 WHERE target_object_type = ?1 AND target_object_id = ?2",
                params![object_type, object_id],
            )?;
        }
        Ok(())
    }

    fn ensure_resolution_updated(affected: usize, object_id: &str) -> StorageResult<()> {
        if affected == 1 {
            Ok(())
        } else {
            Err(StorageError::NotFound(object_id.to_string()))
        }
    }

    fn ensure_attachment_content_material_is_local(
        conn: &VaultConnection,
        conflict: &Conflict,
        row: &AttachmentRow,
    ) -> StorageResult<()> {
        let current = ObjectVersionRepo::current_attachment_row(conn, &conflict.object_id)?;
        let content_changed = current.storage_mode != row.storage_mode
            || current.content_hash != row.content_hash
            || current.original_size != row.original_size
            || current.stored_size != row.stored_size
            || current.chunk_count != row.chunk_count;

        if !content_changed {
            return Ok(());
        }

        if conflict
            .conflicting_fields
            .iter()
            .any(|field| attachment_content_field(field))
        {
            return Err(StorageError::ConstraintViolation(
                "incoming attachment content is not available locally; choose local-wins or provide local content before resolving".to_string(),
            ));
        }

        Err(StorageError::ConstraintViolation(
            "attachment resolution cannot point to content that is not present locally".to_string(),
        ))
    }

    fn ensure_attachment_parent_is_valid(
        conn: &VaultConnection,
        row: &AttachmentRow,
    ) -> StorageResult<()> {
        let project_deleted = conn
            .inner()
            .query_row(
                "SELECT deleted FROM projects WHERE project_id = ?1",
                params![row.project_id],
                |db_row| db_row.get::<_, i32>(0),
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("project {}", row.project_id)))?;
        if !row.deleted && project_deleted != 0 {
            return Err(StorageError::ConstraintViolation(format!(
                "attachment cannot be restored under deleted project {}",
                row.project_id
            )));
        }

        if let Some(entry_id) = row.entry_id.as_deref() {
            let (entry_project_id, entry_deleted) = conn
                .inner()
                .query_row(
                    "SELECT project_id, deleted FROM entries WHERE entry_id = ?1",
                    params![entry_id],
                    |db_row| Ok((db_row.get::<_, String>(0)?, db_row.get::<_, i32>(1)?)),
                )
                .optional()?
                .ok_or_else(|| StorageError::NotFound(format!("entry {entry_id}")))?;
            if entry_project_id != row.project_id {
                return Err(StorageError::ConstraintViolation(format!(
                    "entry {entry_id} does not belong to project {}",
                    row.project_id
                )));
            }
            if !row.deleted && entry_deleted != 0 {
                return Err(StorageError::ConstraintViolation(format!(
                    "attachment cannot be restored under deleted entry {entry_id}"
                )));
            }
        }
        Ok(())
    }

    fn create_resolution_commit(
        conn: &VaultConnection,
        ctx: &CommitContext,
        conflict: &Conflict,
        current_head_id: &str,
    ) -> StorageResult<String> {
        let mut parents = vec![current_head_id.to_string()];
        if conflict.incoming_commit_id != current_head_id {
            parents.push(conflict.incoming_commit_id.clone());
        }
        ctx.create_commit(
            conn,
            "merge",
            &conflict.object_type.to_string(),
            std::slice::from_ref(&conflict.object_id),
            &parents,
        )
    }

    fn apply_entry_row_for_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        row: &EntryRow,
        commit_id: &str,
        object_clock: &str,
    ) -> StorageResult<()> {
        let object_type = row.entry_type.parse().map_err(StorageError::Validation)?;
        CollectionProfileRepo::ensure_object_write_allowed(conn, &row.project_id, &object_type)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE entries SET project_id = ?2, entry_type = ?3, title_ct = ?4,
             payload_ct = ?5, payload_schema_version = ?6, tiga_mode_override = ?7,
             object_clock = ?8, head_commit_id = ?9, deleted = ?10,
             updated_at = ?11, updated_by_device_id = ?12
             WHERE entry_id = ?1",
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
                row.deleted as i32,
                now,
                ctx.device_id,
            ],
        )?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "entry",
            &row.entry_id,
            commit_id,
            row.deleted,
        )?;
        Ok(())
    }

    fn apply_project_row_for_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        row: &ProjectRow,
        commit_id: &str,
        object_clock: &str,
    ) -> StorageResult<()> {
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, &row.project_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE projects SET title_ct = ?2, summary_ct = ?3, group_id = ?4,
             icon_ref = ?5, favorite = ?6, archived = ?7, deleted = ?8,
             tiga_mode_override = ?9, object_clock = ?10, head_commit_id = ?11,
             attachment_count = ?12, updated_at = ?13, updated_by_device_id = ?14
             WHERE project_id = ?1",
            params![
                row.project_id,
                row.title_ct,
                row.summary_ct,
                row.group_id,
                row.icon_ref,
                row.favorite as i32,
                row.archived as i32,
                row.deleted as i32,
                row.tiga_mode_override,
                object_clock,
                commit_id,
                row.attachment_count as i64,
                now,
                ctx.device_id,
            ],
        )?;
        if let Some(profile) = &row.collection_profile {
            if profile.project_id != row.project_id {
                return Err(StorageError::ConstraintViolation(
                    "collection profile project ID does not match project resolution row"
                        .to_string(),
                ));
            }
            CollectionProfileRepo::apply_synced_row(conn, profile)?;
        }
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "project",
            &row.project_id,
            commit_id,
            row.deleted,
        )?;
        Ok(())
    }

    fn apply_attachment_row_for_resolution(
        conn: &VaultConnection,
        ctx: &CommitContext,
        row: &AttachmentRow,
        commit_id: &str,
    ) -> StorageResult<()> {
        CollectionProfileRepo::ensure_collection_write_capabilities(conn, &row.project_id)?;
        Self::ensure_attachment_parent_is_valid(conn, row)?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner().execute(
            "UPDATE attachments SET project_id = ?2, entry_id = ?3,
             file_name_ct = ?4, media_type_ct = ?5, storage_mode = ?6,
             content_hash = ?7, original_size = ?8, stored_size = ?9,
             chunk_count = ?10, head_commit_id = ?11, deleted = ?12,
             updated_at = ?13, updated_by_device_id = ?14
             WHERE attachment_id = ?1",
            params![
                row.attachment_id,
                row.project_id,
                row.entry_id,
                row.file_name_ct,
                row.media_type_ct,
                row.storage_mode,
                row.content_hash,
                row.original_size as i64,
                row.stored_size as i64,
                row.chunk_count as i64,
                commit_id,
                row.deleted as i32,
                now,
                ctx.device_id,
            ],
        )?;
        Self::reconcile_resolution_tombstone(
            conn,
            ctx,
            "attachment",
            &row.attachment_id,
            commit_id,
            row.deleted,
        )?;
        Ok(())
    }
}

fn bump_object_clock(clock: &str) -> String {
    let counter: u64 = serde_json::from_str::<serde_json::Value>(clock)
        .ok()
        .and_then(|v| v.get("counter")?.as_u64())
        .unwrap_or(0);
    format!(r#"{{"counter":{}}}"#, counter + 1)
}

fn attachment_content_field(field: &str) -> bool {
    matches!(
        field,
        "storage_mode" | "content_hash" | "original_size" | "stored_size" | "chunk_count"
    )
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::attachment::AttachmentRepo;
    use crate::repo::entry::EntryRepo;
    use crate::repo::object_label::{
        ObjectLabelAssignmentCreateRequest, ObjectLabelAssignmentRepo, ObjectLabelCreateRequest,
        ObjectLabelRepo,
    };
    use crate::repo::object_relation::{ObjectRelationCreateRequest, ObjectRelationRepo};
    use crate::repo::project::ProjectRepo;
    use crate::repo::tombstone::TombstoneRepo;
    use mdbx_core::model::{EntryType, TombstoneTargetType};

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        (conn, ctx)
    }

    fn generic_metadata_fixture(
        conn: &VaultConnection,
        ctx: &CommitContext,
    ) -> (ObjectRelation, ObjectLabel, ObjectLabelAssignment) {
        let project = ProjectRepo::create(conn, ctx, "Mail", None, None).unwrap();
        let first = EntryRepo::create(
            conn,
            ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("First"),
            &serde_json::json!({"body":"first"}),
        )
        .unwrap();
        let second = EntryRepo::create(
            conn,
            ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Second"),
            &serde_json::json!({"body":"second"}),
        )
        .unwrap();
        let relation = ObjectRelationRepo::create(
            conn,
            ctx,
            ObjectRelationCreateRequest::new(
                &first.entry_id,
                &second.entry_id,
                RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                serde_json::json!({"position":1}),
            ),
        )
        .unwrap();
        let label = ObjectLabelRepo::create(
            conn,
            ctx,
            ObjectLabelCreateRequest::new(
                &project.project_id,
                "Important",
                serde_json::json!({"color":"red"}),
            ),
        )
        .unwrap();
        let assignment = ObjectLabelAssignmentRepo::create(
            conn,
            ctx,
            ObjectLabelAssignmentCreateRequest::new(&first.entry_id, &label.label_id),
        )
        .unwrap();
        (relation, label, assignment)
    }

    fn create_incoming_commit(
        conn: &VaultConnection,
        ctx: &CommitContext,
        object_type: &str,
        object_id: &str,
        parent: &str,
    ) -> String {
        ctx.create_commit(
            conn,
            "change",
            object_type,
            &[object_id.to_string()],
            &[parent.to_string()],
        )
        .unwrap()
    }

    fn typed_tombstone_count(conn: &VaultConnection, object_type: &str, object_id: &str) -> i64 {
        conn.inner()
            .query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE target_object_type = ?1 AND target_object_id = ?2",
                params![object_type, object_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn test_create_conflict() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"user":"a"}),
        )
        .unwrap();

        let fields = ["pass".to_string(), "user".to_string()];
        let conflict = ConflictRepo::create_with_request(
            &conn,
            &ctx,
            ConflictCreateRequest {
                object_type: ConflictObjectType::Entry,
                object_id: &entry.entry_id,
                base_commit_id: "base-commit-1",
                local_commit_id: "local-commit-1",
                incoming_commit_id: "incoming-commit-1",
                conflicting_fields: &fields,
            },
        )
        .unwrap();

        assert!(!conflict.conflict_id.is_empty());
        assert_eq!(conflict.object_type, ConflictObjectType::Entry);
        assert_eq!(conflict.object_id, entry.entry_id);
        assert_eq!(conflict.conflicting_fields.len(), 2);
        assert_eq!(conflict.resolution, ConflictResolution::Unresolved);
        assert!(conflict.resolved_at.is_none());
    }

    #[test]
    fn test_get_by_id() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();

        let created = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            "base",
            "local",
            "incoming",
            &["title_ct".to_string()],
        )
        .unwrap();

        let found = ConflictRepo::get_by_id(&conn, &created.conflict_id)
            .unwrap()
            .unwrap();
        assert_eq!(found.conflict_id, created.conflict_id);
        assert_eq!(found.conflicting_fields, vec!["title_ct"]);
    }

    #[test]
    fn test_get_nonexistent() {
        let (conn, _ctx) = setup();
        assert!(ConflictRepo::get_by_id(&conn, "nonexistent")
            .unwrap()
            .is_none());
    }

    #[test]
    fn test_list_unresolved() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();

        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            "b1",
            "l1",
            "i1",
            &["title_ct".to_string()],
        )
        .unwrap();

        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            "b2",
            "l2",
            "i2",
            &["icon_ref".to_string()],
        )
        .unwrap();

        let unresolved = ConflictRepo::list_unresolved(&conn).unwrap();
        assert_eq!(unresolved.len(), 2);

        ConflictRepo::mark_resolved(
            &conn,
            &unresolved[1].conflict_id,
            ConflictResolution::LocalWins,
        )
        .unwrap();

        let still_unresolved = ConflictRepo::list_unresolved(&conn).unwrap();
        assert_eq!(still_unresolved.len(), 1);
    }

    #[test]
    fn test_list_by_object() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let e1 = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            mdbx_core::model::EntryType::Login,
            Some("E1"),
            &serde_json::json!({"a":1}),
        )
        .unwrap();
        let e2 = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            mdbx_core::model::EntryType::Note,
            Some("E2"),
            &serde_json::json!({"b":2}),
        )
        .unwrap();

        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &e1.entry_id,
            "b1",
            "l1",
            "i1",
            &["x".to_string()],
        )
        .unwrap();
        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &e2.entry_id,
            "b2",
            "l2",
            "i2",
            &["y".to_string()],
        )
        .unwrap();
        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &e2.entry_id,
            "b3",
            "l3",
            "i3",
            &["z".to_string()],
        )
        .unwrap();

        assert_eq!(
            ConflictRepo::list_by_object(&conn, ConflictObjectType::Entry, &e1.entry_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            ConflictRepo::list_by_object(&conn, ConflictObjectType::Entry, &e2.entry_id)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    #[allow(deprecated)]
    fn legacy_resolve_rejects_flag_only_updates() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();

        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            "base",
            "local",
            "incoming",
            &["title_ct".to_string()],
        )
        .unwrap();

        assert!(
            ConflictRepo::resolve(&conn, &conflict.conflict_id, ConflictResolution::LocalWins)
                .is_err()
        );

        let resolved = ConflictRepo::get_by_id(&conn, &conflict.conflict_id)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.resolution, ConflictResolution::Unresolved);
        assert!(resolved.resolved_at.is_none());
    }

    #[test]
    #[allow(deprecated)]
    fn test_resolve_nonexistent() {
        let (conn, _ctx) = setup();
        assert!(ConflictRepo::resolve(&conn, "nonexistent", ConflictResolution::Custom).is_err());
    }

    #[test]
    fn test_has_unresolved_conflict() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"c":3}),
        )
        .unwrap();

        assert!(!ConflictRepo::has_unresolved_conflict(
            &conn,
            ConflictObjectType::Entry,
            &entry.entry_id
        )
        .unwrap());

        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &entry.entry_id,
            "b",
            "l",
            "i",
            &["d".to_string()],
        )
        .unwrap();

        assert!(ConflictRepo::has_unresolved_conflict(
            &conn,
            ConflictObjectType::Entry,
            &entry.entry_id
        )
        .unwrap());
    }

    #[test]
    fn test_conflict_resolution_enum() {
        assert!(!ConflictResolution::Unresolved.is_resolved());
        assert!(ConflictResolution::LocalWins.is_resolved());
        assert!(ConflictResolution::IncomingWins.is_resolved());
        assert!(ConflictResolution::Custom.is_resolved());

        // Display + FromStr roundtrip
        for (res, s) in [
            (ConflictResolution::Unresolved, "unresolved"),
            (ConflictResolution::LocalWins, "local-wins"),
            (ConflictResolution::IncomingWins, "incoming-wins"),
            (ConflictResolution::Custom, "custom"),
        ] {
            assert_eq!(res.to_string(), s);
            assert_eq!(s.parse::<ConflictResolution>().unwrap(), res);
        }
    }

    #[test]
    fn test_conflict_object_type_roundtrip() {
        assert_eq!(ConflictObjectType::Project.to_string(), "project");
        assert_eq!(
            "entry".parse::<ConflictObjectType>().unwrap(),
            ConflictObjectType::Entry
        );
    }

    #[test]
    fn test_resolve_project_incoming_wins_writes_back_row() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "Local", None, None).unwrap();
        let local = ObjectVersionRepo::current_project_row(&conn, &project.project_id).unwrap();
        let incoming_commit = ctx
            .create_commit(
                &conn,
                "change",
                "project",
                std::slice::from_ref(&project.project_id),
                std::slice::from_ref(&project.head_commit_id),
            )
            .unwrap();
        let mut incoming = local.clone();
        incoming.title_ct = b"Incoming".to_vec();
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_project_row(&conn, &incoming_commit, &incoming).unwrap();

        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            &project.head_commit_id,
            &project.head_commit_id,
            &incoming_commit,
            &["title_ct".to_string()],
        )
        .unwrap();

        let resolved = ConflictRepo::resolve_project(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        let updated = ProjectRepo::get_by_id(&conn, &project.project_id)
            .unwrap()
            .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::IncomingWins);
        assert_eq!(updated.title_ct, b"Incoming");
        assert!(ObjectVersionRepo::get_project(
            &conn,
            &project.project_id,
            &updated.head_commit_id
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn test_resolve_attachment_incoming_metadata_writes_back_row() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "local.txt",
            Some("text/plain"),
            "",
            0,
        )
        .unwrap();
        let local =
            ObjectVersionRepo::current_attachment_row(&conn, &attachment.attachment_id).unwrap();
        let incoming_commit = ctx
            .create_commit(
                &conn,
                "change",
                "attachment",
                std::slice::from_ref(&attachment.attachment_id),
                std::slice::from_ref(&attachment.head_commit_id),
            )
            .unwrap();
        let mut incoming = local.clone();
        incoming.file_name_ct = b"incoming.txt".to_vec();
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_attachment_row(&conn, &incoming_commit, &incoming).unwrap();

        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Attachment,
            &attachment.attachment_id,
            &attachment.head_commit_id,
            &attachment.head_commit_id,
            &incoming_commit,
            &["file_name_ct".to_string()],
        )
        .unwrap();

        let resolved = ConflictRepo::resolve_attachment(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        let updated = AttachmentRepo::get_by_id(&conn, &attachment.attachment_id)
            .unwrap()
            .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::IncomingWins);
        assert_eq!(updated.file_name_ct, b"incoming.txt");
        assert_eq!(updated.content_hash, attachment.content_hash);
    }

    #[test]
    fn test_resolve_attachment_incoming_content_without_material_is_rejected() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "local.txt",
            Some("text/plain"),
            "local-hash",
            10,
        )
        .unwrap();
        let local =
            ObjectVersionRepo::current_attachment_row(&conn, &attachment.attachment_id).unwrap();
        let incoming_commit = ctx
            .create_commit(
                &conn,
                "change",
                "attachment",
                std::slice::from_ref(&attachment.attachment_id),
                std::slice::from_ref(&attachment.head_commit_id),
            )
            .unwrap();
        let mut incoming = local.clone();
        incoming.content_hash = "remote-hash".to_string();
        incoming.original_size = 20;
        incoming.stored_size = 20;
        incoming.chunk_count = 1;
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_attachment_row(&conn, &incoming_commit, &incoming).unwrap();

        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Attachment,
            &attachment.attachment_id,
            &attachment.head_commit_id,
            &attachment.head_commit_id,
            &incoming_commit,
            &["content_hash".to_string()],
        )
        .unwrap();

        let result = ConflictRepo::resolve_attachment(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        );
        let still_unresolved = ConflictRepo::get_by_id(&conn, &conflict.conflict_id)
            .unwrap()
            .unwrap();
        let updated = AttachmentRepo::get_by_id(&conn, &attachment.attachment_id)
            .unwrap()
            .unwrap();

        assert!(result.is_err());
        assert_eq!(still_unresolved.resolution, ConflictResolution::Unresolved);
        assert_eq!(updated.content_hash, attachment.content_hash);
    }

    #[test]
    fn conflict_resolution_tombstone_tracks_project_entry_and_attachment_state() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("E"),
            &serde_json::json!({"password":"secret"}),
        )
        .unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            Some(&entry.entry_id),
            "a.txt",
            Some("text/plain"),
            "hash",
            4,
        )
        .unwrap();

        let project_current =
            ObjectVersionRepo::current_project_row(&conn, &project.project_id).unwrap();
        let project_delete_commit = create_incoming_commit(
            &conn,
            &ctx,
            "project",
            &project.project_id,
            &project_current.head_commit_id,
        );
        let mut project_deleted = project_current.clone();
        project_deleted.deleted = true;
        project_deleted.head_commit_id = project_delete_commit.clone();
        ObjectVersionRepo::record_project_row(&conn, &project_delete_commit, &project_deleted)
            .unwrap();
        let project_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            &project_current.head_commit_id,
            &project_current.head_commit_id,
            &project_delete_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_project(
            &conn,
            &ctx,
            &project_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert_eq!(
            typed_tombstone_count(&conn, "project", &project.project_id),
            1
        );

        let entry_current = ObjectVersionRepo::current_entry_row(&conn, &entry.entry_id).unwrap();
        let entry_delete_commit = create_incoming_commit(
            &conn,
            &ctx,
            "entry",
            &entry.entry_id,
            &entry_current.head_commit_id,
        );
        let mut entry_deleted = entry_current.clone();
        entry_deleted.deleted = true;
        entry_deleted.head_commit_id = entry_delete_commit.clone();
        ObjectVersionRepo::record_entry_row(&conn, &entry_delete_commit, &entry_deleted).unwrap();
        let entry_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &entry.entry_id,
            &entry_current.head_commit_id,
            &entry_current.head_commit_id,
            &entry_delete_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_entry(
            &conn,
            &ctx,
            &entry_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert_eq!(typed_tombstone_count(&conn, "entry", &entry.entry_id), 1);

        let attachment_current =
            ObjectVersionRepo::current_attachment_row(&conn, &attachment.attachment_id).unwrap();
        let attachment_delete_commit = create_incoming_commit(
            &conn,
            &ctx,
            "attachment",
            &attachment.attachment_id,
            &attachment_current.head_commit_id,
        );
        let mut attachment_deleted = attachment_current.clone();
        attachment_deleted.deleted = true;
        attachment_deleted.head_commit_id = attachment_delete_commit.clone();
        ObjectVersionRepo::record_attachment_row(
            &conn,
            &attachment_delete_commit,
            &attachment_deleted,
        )
        .unwrap();
        let attachment_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Attachment,
            &attachment.attachment_id,
            &attachment_current.head_commit_id,
            &attachment_current.head_commit_id,
            &attachment_delete_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_attachment(
            &conn,
            &ctx,
            &attachment_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert_eq!(
            typed_tombstone_count(&conn, "attachment", &attachment.attachment_id),
            1
        );

        let project_deleted_current =
            ObjectVersionRepo::current_project_row(&conn, &project.project_id).unwrap();
        let project_revive_commit = create_incoming_commit(
            &conn,
            &ctx,
            "project",
            &project.project_id,
            &project_deleted_current.head_commit_id,
        );
        let mut project_active = project_deleted_current.clone();
        project_active.deleted = false;
        project_active.head_commit_id = project_revive_commit.clone();
        ObjectVersionRepo::record_project_row(&conn, &project_revive_commit, &project_active)
            .unwrap();
        let project_revive_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            &project_deleted_current.head_commit_id,
            &project_deleted_current.head_commit_id,
            &project_revive_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_project(
            &conn,
            &ctx,
            &project_revive_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert_eq!(
            typed_tombstone_count(&conn, "project", &project.project_id),
            0
        );

        let entry_deleted_current =
            ObjectVersionRepo::current_entry_row(&conn, &entry.entry_id).unwrap();
        let entry_revive_commit = create_incoming_commit(
            &conn,
            &ctx,
            "entry",
            &entry.entry_id,
            &entry_deleted_current.head_commit_id,
        );
        let mut entry_active = entry_deleted_current.clone();
        entry_active.deleted = false;
        entry_active.head_commit_id = entry_revive_commit.clone();
        ObjectVersionRepo::record_entry_row(&conn, &entry_revive_commit, &entry_active).unwrap();
        let entry_revive_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &entry.entry_id,
            &entry_deleted_current.head_commit_id,
            &entry_deleted_current.head_commit_id,
            &entry_revive_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_entry(
            &conn,
            &ctx,
            &entry_revive_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert_eq!(typed_tombstone_count(&conn, "entry", &entry.entry_id), 0);

        let attachment_deleted_current =
            ObjectVersionRepo::current_attachment_row(&conn, &attachment.attachment_id).unwrap();
        let attachment_revive_commit = create_incoming_commit(
            &conn,
            &ctx,
            "attachment",
            &attachment.attachment_id,
            &attachment_deleted_current.head_commit_id,
        );
        let mut attachment_active = attachment_deleted_current.clone();
        attachment_active.deleted = false;
        attachment_active.head_commit_id = attachment_revive_commit.clone();
        ObjectVersionRepo::record_attachment_row(
            &conn,
            &attachment_revive_commit,
            &attachment_active,
        )
        .unwrap();
        let attachment_revive_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Attachment,
            &attachment.attachment_id,
            &attachment_deleted_current.head_commit_id,
            &attachment_deleted_current.head_commit_id,
            &attachment_revive_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_attachment(
            &conn,
            &ctx,
            &attachment_revive_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert_eq!(
            typed_tombstone_count(&conn, "attachment", &attachment.attachment_id),
            0
        );
    }

    #[test]
    fn conflict_resolution_tombstone_local_wins_removes_remote_delete_marker() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let current = ObjectVersionRepo::current_project_row(&conn, &project.project_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "project",
            &project.project_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.deleted = true;
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_project_row(&conn, &incoming_commit, &incoming).unwrap();
        ctx.create_tombstone(&conn, "project", &project.project_id)
            .unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["deleted".to_string()],
        )
        .unwrap();

        ConflictRepo::resolve_project(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::LocalWins,
        )
        .unwrap();

        assert_eq!(
            typed_tombstone_count(&conn, "project", &project.project_id),
            0
        );
        assert!(
            !ProjectRepo::get_by_id(&conn, &project.project_id)
                .unwrap()
                .unwrap()
                .deleted
        );
    }

    #[test]
    fn client_project_custom_resolution_reencrypts_fields_and_rejects_policy_changes() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring =
            mdbx_crypto::keyring::Keyring::from_vault_key(&vault_key, b"project-custom-resolution")
                .unwrap();
        conn.attach_keyring(keyring);
        let ctx = CommitContext::new("project-custom-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Local", None, None).unwrap();
        let current = ObjectVersionRepo::current_project_row(&conn, &project.project_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "project",
            &project.project_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_project_row(&conn, &incoming_commit, &incoming).unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Project,
            &project.project_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["title_ct".to_string()],
        )
        .unwrap();

        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut invalid = project.clone();
        invalid.tiga_mode_override = Some(mdbx_core::tiga::TigaMode::Power);
        assert!(
            ConflictRepo::resolve_project_custom(&conn, &ctx, &conflict.conflict_id, &invalid)
                .is_err()
        );
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            commit_count_before
        );
        assert_eq!(
            ConflictRepo::get_by_id(&conn, &conflict.conflict_id)
                .unwrap()
                .unwrap()
                .resolution,
            ConflictResolution::Unresolved
        );

        let mut merged = project;
        merged.title_ct = b"Merged".to_vec();
        merged.summary_ct = Some(b"Client-selected summary".to_vec());
        merged.favorite = true;
        let resolved =
            ConflictRepo::resolve_project_custom(&conn, &ctx, &conflict.conflict_id, &merged)
                .unwrap();
        let stored = ProjectRepo::get_by_id(&conn, &merged.project_id)
            .unwrap()
            .unwrap();
        let raw_title: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT title_ct FROM projects WHERE project_id = ?1",
                params![merged.project_id],
                |row| row.get(0),
            )
            .unwrap();
        let parent_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_parents WHERE commit_id = ?1",
                params![stored.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::Custom);
        assert_eq!(stored.title_ct, b"Merged");
        assert_eq!(
            stored.summary_ct.as_deref(),
            Some(b"Client-selected summary".as_slice())
        );
        assert!(stored.favorite);
        assert_ne!(raw_title, b"Merged");
        assert_eq!(parent_count, 2);
    }

    #[test]
    fn client_attachment_custom_resolution_preserves_content_identity_and_reencrypts_metadata() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring = mdbx_crypto::keyring::Keyring::from_vault_key(
            &vault_key,
            b"attachment-custom-resolution",
        )
        .unwrap();
        conn.attach_keyring(keyring);
        let ctx = CommitContext::new("attachment-custom-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Steam", None, None).unwrap();
        let content_hash = "a".repeat(64);
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "local.mafile",
            Some("application/json"),
            &content_hash,
            128,
        )
        .unwrap();
        let current =
            ObjectVersionRepo::current_attachment_row(&conn, &attachment.attachment_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "attachment",
            &attachment.attachment_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_attachment_row(&conn, &incoming_commit, &incoming).unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Attachment,
            &attachment.attachment_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["file_name_ct".to_string()],
        )
        .unwrap();

        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut forged = attachment.clone();
        forged.content_hash = "b".repeat(64);
        assert!(ConflictRepo::resolve_attachment_custom(
            &conn,
            &ctx,
            &conflict.conflict_id,
            &forged
        )
        .is_err());
        assert_eq!(
            conn.inner()
                .query_row::<i64, _, _>("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
                .unwrap(),
            commit_count_before
        );

        let mut merged = attachment;
        merged.file_name_ct = b"merged.mafile".to_vec();
        merged.media_type_ct = Some(b"application/vnd.monica.mafile+json".to_vec());
        let resolved =
            ConflictRepo::resolve_attachment_custom(&conn, &ctx, &conflict.conflict_id, &merged)
                .unwrap();
        let stored = AttachmentRepo::get_by_id(&conn, &merged.attachment_id)
            .unwrap()
            .unwrap();
        let raw_file_name: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT file_name_ct FROM attachments WHERE attachment_id = ?1",
                params![merged.attachment_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::Custom);
        assert_eq!(stored.file_name_ct, b"merged.mafile");
        assert_eq!(stored.content_hash, content_hash);
        assert_eq!(stored.original_size, 128);
        assert_ne!(raw_file_name, b"merged.mafile");
    }

    #[test]
    fn generic_metadata_conflict_incoming_wins_applies_relation_and_records_merge_version() {
        let (conn, ctx) = setup();
        let (relation, _, _) = generic_metadata_fixture(&conn, &ctx);
        let current =
            ObjectVersionRepo::current_object_relation_row(&conn, &relation.relation_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-relation",
            &relation.relation_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.payload_ct = serde_json::to_vec(&serde_json::json!({"position":2})).unwrap();
        incoming.payload_schema_version = 2;
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_object_relation_row(&conn, &incoming_commit, &incoming).unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectRelation,
            &relation.relation_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["payload_ct".to_string()],
        )
        .unwrap();

        let resolved = ConflictRepo::resolve_object_relation(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        let stored = ObjectRelationRepo::get_by_id(&conn, &relation.relation_id)
            .unwrap()
            .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::IncomingWins);
        assert_eq!(stored.payload_schema_version, 2);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stored.payload_ct).unwrap(),
            serde_json::json!({"position":2})
        );
        assert!(ObjectVersionRepo::get_object_relation(
            &conn,
            &relation.relation_id,
            &stored.head_commit_id
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn generic_metadata_conflict_local_wins_preserves_relation_and_label_state() {
        let (conn, ctx) = setup();
        let (relation, label, _) = generic_metadata_fixture(&conn, &ctx);

        let relation_current =
            ObjectVersionRepo::current_object_relation_row(&conn, &relation.relation_id).unwrap();
        let relation_incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-relation",
            &relation.relation_id,
            &relation_current.head_commit_id,
        );
        let mut relation_incoming = relation_current.clone();
        relation_incoming.payload_ct =
            serde_json::to_vec(&serde_json::json!({"position":99})).unwrap();
        relation_incoming.head_commit_id = relation_incoming_commit.clone();
        ObjectVersionRepo::record_object_relation_row(
            &conn,
            &relation_incoming_commit,
            &relation_incoming,
        )
        .unwrap();
        let relation_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectRelation,
            &relation.relation_id,
            &relation_current.head_commit_id,
            &relation_current.head_commit_id,
            &relation_incoming_commit,
            &["payload_ct".to_string()],
        )
        .unwrap();

        let label_current =
            ObjectVersionRepo::current_object_label_row(&conn, &label.label_id).unwrap();
        let label_incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-label",
            &label.label_id,
            &label_current.head_commit_id,
        );
        let mut label_incoming = label_current.clone();
        label_incoming.name_ct = b"Incoming".to_vec();
        label_incoming.head_commit_id = label_incoming_commit.clone();
        ObjectVersionRepo::record_object_label_row(&conn, &label_incoming_commit, &label_incoming)
            .unwrap();
        let label_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectLabel,
            &label.label_id,
            &label_current.head_commit_id,
            &label_current.head_commit_id,
            &label_incoming_commit,
            &["name_ct".to_string()],
        )
        .unwrap();

        ConflictRepo::resolve_object_relation(
            &conn,
            &ctx,
            &relation_conflict.conflict_id,
            ConflictResolution::LocalWins,
        )
        .unwrap();
        ConflictRepo::resolve_object_label(
            &conn,
            &ctx,
            &label_conflict.conflict_id,
            ConflictResolution::LocalWins,
        )
        .unwrap();

        let stored_relation = ObjectRelationRepo::get_by_id(&conn, &relation.relation_id)
            .unwrap()
            .unwrap();
        let stored_label = ObjectLabelRepo::get_by_id(&conn, &label.label_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored_relation.payload_ct, relation.payload_ct);
        assert_ne!(stored_relation.head_commit_id, relation.head_commit_id);
        assert_eq!(stored_label.name_ct, label.name_ct);
        assert_ne!(stored_label.head_commit_id, label.head_commit_id);
    }

    #[test]
    fn generic_metadata_conflict_custom_relation_validates_and_applies_atomically() {
        let (conn, ctx) = setup();
        let (relation, _, _) = generic_metadata_fixture(&conn, &ctx);
        let current =
            ObjectVersionRepo::current_object_relation_row(&conn, &relation.relation_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-relation",
            &relation.relation_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_object_relation_row(&conn, &incoming_commit, &incoming).unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectRelation,
            &relation.relation_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["relation_kind".to_string()],
        )
        .unwrap();
        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut invalid = relation.clone();
        invalid.source_object_id = invalid.target_object_id.clone();

        let result = ConflictRepo::resolve_object_relation_custom(
            &conn,
            &ctx,
            &conflict.conflict_id,
            &invalid,
        );
        let unresolved = ConflictRepo::get_by_id(&conn, &conflict.conflict_id)
            .unwrap()
            .unwrap();
        let commit_count_after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();

        assert!(result.is_err());
        assert_eq!(unresolved.resolution, ConflictResolution::Unresolved);
        assert_eq!(commit_count_after, commit_count_before);
        assert_eq!(
            ObjectRelationRepo::get_by_id(&conn, &relation.relation_id)
                .unwrap()
                .unwrap(),
            relation
        );

        let mut merged = relation.clone();
        merged.relation_kind = RelationKindId::new("com.monica.mail.thread-member").unwrap();
        merged.payload_ct = serde_json::to_vec(&serde_json::json!({"position":9})).unwrap();
        merged.payload_schema_version = 4;
        let resolved = ConflictRepo::resolve_object_relation_custom(
            &conn,
            &ctx,
            &conflict.conflict_id,
            &merged,
        )
        .unwrap();
        let stored = ObjectRelationRepo::get_by_id(&conn, &relation.relation_id)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.resolution, ConflictResolution::Custom);
        assert_eq!(stored.relation_kind, merged.relation_kind);
        assert_eq!(stored.payload_schema_version, 4);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stored.payload_ct).unwrap(),
            serde_json::json!({"position":9})
        );
    }

    #[test]
    fn generic_metadata_conflict_custom_label_updates_plaintext_under_merge_commit() {
        let (conn, ctx) = setup();
        let (_, label, assignment) = generic_metadata_fixture(&conn, &ctx);
        ObjectLabelAssignmentRepo::soft_delete(&conn, &ctx, &assignment.assignment_id).unwrap();
        let current = ObjectVersionRepo::current_object_label_row(&conn, &label.label_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-label",
            &label.label_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_object_label_row(&conn, &incoming_commit, &incoming).unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectLabel,
            &label.label_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["name_ct".to_string(), "payload_ct".to_string()],
        )
        .unwrap();
        let mut merged = label.clone();
        merged.name_ct = b"Priority".to_vec();
        merged.payload_ct = serde_json::to_vec(&serde_json::json!({"color":"orange"})).unwrap();
        merged.payload_schema_version = 3;

        let resolved =
            ConflictRepo::resolve_object_label_custom(&conn, &ctx, &conflict.conflict_id, &merged)
                .unwrap();
        let stored = ObjectLabelRepo::get_by_id(&conn, &label.label_id)
            .unwrap()
            .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::Custom);
        assert_eq!(stored.name_ct, b"Priority");
        assert_eq!(stored.payload_schema_version, 3);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&stored.payload_ct).unwrap(),
            serde_json::json!({"color":"orange"})
        );
    }

    #[test]
    fn generic_metadata_conflict_incoming_label_deletion_requires_assignment_cleanup() {
        let (conn, ctx) = setup();
        let (_, label, assignment) = generic_metadata_fixture(&conn, &ctx);
        let current = ObjectVersionRepo::current_object_label_row(&conn, &label.label_id).unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-label",
            &label.label_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.deleted = true;
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_object_label_row(&conn, &incoming_commit, &incoming).unwrap();
        let conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectLabel,
            &label.label_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["deleted".to_string()],
        )
        .unwrap();

        assert!(ConflictRepo::resolve_object_label(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .is_err());
        ObjectLabelAssignmentRepo::soft_delete(&conn, &ctx, &assignment.assignment_id).unwrap();
        ConflictRepo::resolve_object_label(
            &conn,
            &ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();

        assert!(
            ObjectLabelRepo::get_by_id(&conn, &label.label_id)
                .unwrap()
                .unwrap()
                .deleted
        );
        assert_eq!(
            TombstoneRepo::count_by_type(&conn, TombstoneTargetType::ObjectLabel).unwrap(),
            1
        );
    }

    #[test]
    fn generic_metadata_conflict_assignment_supports_all_resolution_modes() {
        let (conn, ctx) = setup();
        let (_, _, assignment) = generic_metadata_fixture(&conn, &ctx);
        let current = ObjectVersionRepo::current_object_label_assignment_row(
            &conn,
            &assignment.assignment_id,
        )
        .unwrap();
        let incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-label-assignment",
            &assignment.assignment_id,
            &current.head_commit_id,
        );
        let mut incoming = current.clone();
        incoming.deleted = true;
        incoming.head_commit_id = incoming_commit.clone();
        ObjectVersionRepo::record_object_label_assignment_row(&conn, &incoming_commit, &incoming)
            .unwrap();
        let local_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectLabelAssignment,
            &assignment.assignment_id,
            &current.head_commit_id,
            &current.head_commit_id,
            &incoming_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_object_label_assignment(
            &conn,
            &ctx,
            &local_conflict.conflict_id,
            ConflictResolution::LocalWins,
        )
        .unwrap();
        assert!(
            !ObjectLabelAssignmentRepo::get_by_id(&conn, &assignment.assignment_id)
                .unwrap()
                .unwrap()
                .deleted
        );

        let local = ObjectVersionRepo::current_object_label_assignment_row(
            &conn,
            &assignment.assignment_id,
        )
        .unwrap();
        let second_incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-label-assignment",
            &assignment.assignment_id,
            &local.head_commit_id,
        );
        let mut second_incoming = local.clone();
        second_incoming.deleted = true;
        second_incoming.head_commit_id = second_incoming_commit.clone();
        ObjectVersionRepo::record_object_label_assignment_row(
            &conn,
            &second_incoming_commit,
            &second_incoming,
        )
        .unwrap();
        let incoming_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectLabelAssignment,
            &assignment.assignment_id,
            &local.head_commit_id,
            &local.head_commit_id,
            &second_incoming_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        ConflictRepo::resolve_object_label_assignment(
            &conn,
            &ctx,
            &incoming_conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert!(
            ObjectLabelAssignmentRepo::get_by_id(&conn, &assignment.assignment_id)
                .unwrap()
                .unwrap()
                .deleted
        );
        assert_eq!(
            TombstoneRepo::count_by_type(&conn, TombstoneTargetType::ObjectLabelAssignment)
                .unwrap(),
            1
        );

        let deleted = ObjectVersionRepo::current_object_label_assignment_row(
            &conn,
            &assignment.assignment_id,
        )
        .unwrap();
        let third_incoming_commit = create_incoming_commit(
            &conn,
            &ctx,
            "object-label-assignment",
            &assignment.assignment_id,
            &deleted.head_commit_id,
        );
        let mut third_incoming = deleted.clone();
        third_incoming.head_commit_id = third_incoming_commit.clone();
        ObjectVersionRepo::record_object_label_assignment_row(
            &conn,
            &third_incoming_commit,
            &third_incoming,
        )
        .unwrap();
        let custom_conflict = ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::ObjectLabelAssignment,
            &assignment.assignment_id,
            &deleted.head_commit_id,
            &deleted.head_commit_id,
            &third_incoming_commit,
            &["deleted".to_string()],
        )
        .unwrap();
        let mut custom = assignment.clone();
        custom.deleted = false;
        ConflictRepo::resolve_object_label_assignment_custom(
            &conn,
            &ctx,
            &custom_conflict.conflict_id,
            &custom,
        )
        .unwrap();
        assert!(
            !ObjectLabelAssignmentRepo::get_by_id(&conn, &assignment.assignment_id)
                .unwrap()
                .unwrap()
                .deleted
        );
        assert_eq!(
            TombstoneRepo::count_by_type(&conn, TombstoneTargetType::ObjectLabelAssignment)
                .unwrap(),
            0
        );
    }
}
