use rusqlite::params;
use rusqlite::OptionalExtension;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::CollectionProfileRepo;
use crate::sync_state::{
    AttachmentRow, EntryRow, ObjectLabelAssignmentRow, ObjectLabelRow, ObjectRelationRow,
    ProjectRow,
};

pub struct ObjectVersionRepo;

impl ObjectVersionRepo {
    fn record_serialized<T: serde::Serialize>(
        conn: &VaultConnection,
        object_type: &str,
        object_id: &str,
        commit_id: &str,
        row: &T,
    ) -> StorageResult<()> {
        let snapshot_ct =
            serde_json::to_vec(row).map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
        conn.inner().execute(
            "INSERT OR REPLACE INTO object_versions
                (object_type, object_id, commit_id, snapshot_ct, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                object_type,
                object_id,
                commit_id,
                snapshot_ct,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    fn get_serialized<T: serde::de::DeserializeOwned>(
        conn: &VaultConnection,
        object_type: &str,
        object_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<T>> {
        let snapshot: Option<Vec<u8>> = conn
            .inner()
            .query_row(
                "SELECT snapshot_ct FROM object_versions
                 WHERE object_type = ?1 AND object_id = ?2 AND commit_id = ?3",
                params![object_type, object_id, commit_id],
                |row| row.get(0),
            )
            .optional()?;
        snapshot
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|e| StorageError::SchemaCreation(e.to_string()))
            })
            .transpose()
    }

    pub fn record_entry_current(
        conn: &VaultConnection,
        commit_id: &str,
        entry_id: &str,
    ) -> StorageResult<()> {
        let row = Self::current_entry_row(conn, entry_id)?;
        Self::record_entry_row(conn, commit_id, &row)
    }

    pub fn record_entry_row(
        conn: &VaultConnection,
        commit_id: &str,
        row: &EntryRow,
    ) -> StorageResult<()> {
        let snapshot_ct =
            serde_json::to_vec(row).map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
        let now = chrono::Utc::now().to_rfc3339();

        conn.inner().execute(
            "INSERT OR REPLACE INTO object_versions
                (object_type, object_id, commit_id, snapshot_ct, created_at)
             VALUES ('entry', ?1, ?2, ?3, ?4)",
            params![row.entry_id, commit_id, snapshot_ct, now],
        )?;
        Ok(())
    }

    pub fn record_project_current(
        conn: &VaultConnection,
        commit_id: &str,
        project_id: &str,
    ) -> StorageResult<()> {
        let row = Self::current_project_row(conn, project_id)?;
        Self::record_project_row(conn, commit_id, &row)
    }

    pub fn record_project_row(
        conn: &VaultConnection,
        commit_id: &str,
        row: &ProjectRow,
    ) -> StorageResult<()> {
        let snapshot_ct =
            serde_json::to_vec(row).map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
        let now = chrono::Utc::now().to_rfc3339();

        conn.inner().execute(
            "INSERT OR REPLACE INTO object_versions
                (object_type, object_id, commit_id, snapshot_ct, created_at)
             VALUES ('project', ?1, ?2, ?3, ?4)",
            params![row.project_id, commit_id, snapshot_ct, now],
        )?;
        Ok(())
    }

    pub fn record_attachment_current(
        conn: &VaultConnection,
        commit_id: &str,
        attachment_id: &str,
    ) -> StorageResult<()> {
        let row = Self::current_attachment_row(conn, attachment_id)?;
        Self::record_attachment_row(conn, commit_id, &row)
    }

    pub fn record_attachment_row(
        conn: &VaultConnection,
        commit_id: &str,
        row: &AttachmentRow,
    ) -> StorageResult<()> {
        let snapshot_ct =
            serde_json::to_vec(row).map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
        let now = chrono::Utc::now().to_rfc3339();

        conn.inner().execute(
            "INSERT OR REPLACE INTO object_versions
                (object_type, object_id, commit_id, snapshot_ct, created_at)
             VALUES ('attachment', ?1, ?2, ?3, ?4)",
            params![row.attachment_id, commit_id, snapshot_ct, now],
        )?;
        Ok(())
    }

    pub fn record_object_relation_current(
        conn: &VaultConnection,
        commit_id: &str,
        relation_id: &str,
    ) -> StorageResult<()> {
        let row = Self::current_object_relation_row(conn, relation_id)?;
        Self::record_object_relation_row(conn, commit_id, &row)
    }

    pub fn record_object_relation_row(
        conn: &VaultConnection,
        commit_id: &str,
        row: &ObjectRelationRow,
    ) -> StorageResult<()> {
        Self::record_serialized(conn, "object-relation", &row.relation_id, commit_id, row)
    }

    pub fn record_object_label_current(
        conn: &VaultConnection,
        commit_id: &str,
        label_id: &str,
    ) -> StorageResult<()> {
        let row = Self::current_object_label_row(conn, label_id)?;
        Self::record_object_label_row(conn, commit_id, &row)
    }

    pub fn record_object_label_row(
        conn: &VaultConnection,
        commit_id: &str,
        row: &ObjectLabelRow,
    ) -> StorageResult<()> {
        Self::record_serialized(conn, "object-label", &row.label_id, commit_id, row)
    }

    pub fn record_object_label_assignment_current(
        conn: &VaultConnection,
        commit_id: &str,
        assignment_id: &str,
    ) -> StorageResult<()> {
        let row = Self::current_object_label_assignment_row(conn, assignment_id)?;
        Self::record_object_label_assignment_row(conn, commit_id, &row)
    }

    pub fn record_object_label_assignment_row(
        conn: &VaultConnection,
        commit_id: &str,
        row: &ObjectLabelAssignmentRow,
    ) -> StorageResult<()> {
        Self::record_serialized(
            conn,
            "object-label-assignment",
            &row.assignment_id,
            commit_id,
            row,
        )
    }

    pub fn get_entry(
        conn: &VaultConnection,
        entry_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<EntryRow>> {
        let snapshot: Option<Vec<u8>> = conn
            .inner()
            .query_row(
                "SELECT snapshot_ct FROM object_versions
                 WHERE object_type = 'entry' AND object_id = ?1 AND commit_id = ?2",
                params![entry_id, commit_id],
                |row| row.get(0),
            )
            .optional()?;

        snapshot
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|e| StorageError::SchemaCreation(e.to_string()))
            })
            .transpose()
    }

    pub fn get_project(
        conn: &VaultConnection,
        project_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<ProjectRow>> {
        let snapshot: Option<Vec<u8>> = conn
            .inner()
            .query_row(
                "SELECT snapshot_ct FROM object_versions
                 WHERE object_type = 'project' AND object_id = ?1 AND commit_id = ?2",
                params![project_id, commit_id],
                |row| row.get(0),
            )
            .optional()?;

        snapshot
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|e| StorageError::SchemaCreation(e.to_string()))
            })
            .transpose()
    }

    pub fn get_attachment(
        conn: &VaultConnection,
        attachment_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<AttachmentRow>> {
        let snapshot: Option<Vec<u8>> = conn
            .inner()
            .query_row(
                "SELECT snapshot_ct FROM object_versions
                 WHERE object_type = 'attachment' AND object_id = ?1 AND commit_id = ?2",
                params![attachment_id, commit_id],
                |row| row.get(0),
            )
            .optional()?;

        snapshot
            .map(|bytes| {
                serde_json::from_slice(&bytes)
                    .map_err(|e| StorageError::SchemaCreation(e.to_string()))
            })
            .transpose()
    }

    pub fn get_object_relation(
        conn: &VaultConnection,
        relation_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<ObjectRelationRow>> {
        Self::get_serialized(conn, "object-relation", relation_id, commit_id)
    }

    pub fn get_object_label(
        conn: &VaultConnection,
        label_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<ObjectLabelRow>> {
        Self::get_serialized(conn, "object-label", label_id, commit_id)
    }

    pub fn get_object_label_assignment(
        conn: &VaultConnection,
        assignment_id: &str,
        commit_id: &str,
    ) -> StorageResult<Option<ObjectLabelAssignmentRow>> {
        Self::get_serialized(conn, "object-label-assignment", assignment_id, commit_id)
    }

    pub fn current_entry_row(conn: &VaultConnection, entry_id: &str) -> StorageResult<EntryRow> {
        conn.inner()
            .query_row(
                "SELECT entry_id, project_id, entry_type, title_ct, payload_ct,
                        payload_schema_version, tiga_mode_override, object_clock,
                        head_commit_id, deleted, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM entries WHERE entry_id = ?1",
                params![entry_id],
                |row| {
                    Ok(EntryRow {
                        entry_id: row.get(0)?,
                        project_id: row.get(1)?,
                        entry_type: row.get(2)?,
                        title_ct: row.get(3)?,
                        payload_ct: row.get(4)?,
                        payload_schema_version: row.get::<_, i64>(5)? as u32,
                        tiga_mode_override: row.get(6)?,
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
            .optional()?
            .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))
    }

    pub fn current_project_row(
        conn: &VaultConnection,
        project_id: &str,
    ) -> StorageResult<ProjectRow> {
        let mut project = conn
            .inner()
            .query_row(
                "SELECT project_id, title_ct, summary_ct, group_id, icon_ref,
                        favorite, archived, deleted, tiga_mode_override, object_clock,
                        head_commit_id, attachment_count, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM projects WHERE project_id = ?1",
                params![project_id],
                |row| {
                    Ok(ProjectRow {
                        project_id: row.get(0)?,
                        title_ct: row.get(1)?,
                        summary_ct: row.get(2)?,
                        group_id: row.get(3)?,
                        icon_ref: row.get(4)?,
                        favorite: row.get::<_, i32>(5)? != 0,
                        archived: row.get::<_, i32>(6)? != 0,
                        deleted: row.get::<_, i32>(7)? != 0,
                        tiga_mode_override: row.get(8)?,
                        object_clock: row.get(9)?,
                        head_commit_id: row.get(10)?,
                        attachment_count: row.get::<_, i64>(11)? as u32,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                        created_by_device_id: row.get(14)?,
                        updated_by_device_id: row.get(15)?,
                        collection_profile: None,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(project_id.to_string()))?;
        project.collection_profile =
            CollectionProfileRepo::stored_by_collection_id(conn, project_id)?;
        Ok(project)
    }

    pub fn current_attachment_row(
        conn: &VaultConnection,
        attachment_id: &str,
    ) -> StorageResult<AttachmentRow> {
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
                    Ok(AttachmentRow {
                        attachment_id: row.get(0)?,
                        project_id: row.get(1)?,
                        entry_id: row.get(2)?,
                        file_name_ct: row.get(3)?,
                        media_type_ct: row.get(4)?,
                        storage_mode: row.get(5)?,
                        content_hash: row.get(6)?,
                        original_size: row.get::<_, i64>(7)? as u64,
                        stored_size: row.get::<_, i64>(8)? as u64,
                        chunk_count: row.get::<_, i64>(9)? as u32,
                        head_commit_id: row.get(10)?,
                        deleted: row.get::<_, i32>(11)? != 0,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                        created_by_device_id: row.get(14)?,
                        updated_by_device_id: row.get(15)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(attachment_id.to_string()))
    }

    pub fn current_object_relation_row(
        conn: &VaultConnection,
        relation_id: &str,
    ) -> StorageResult<ObjectRelationRow> {
        conn.inner()
            .query_row(
                "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                        payload_ct, payload_schema_version, object_clock, head_commit_id,
                        deleted, created_at, updated_at, created_by_device_id,
                        updated_by_device_id
                 FROM object_relations WHERE relation_id = ?1",
                params![relation_id],
                |row| {
                    Ok(ObjectRelationRow {
                        relation_id: row.get(0)?,
                        source_object_id: row.get(1)?,
                        target_object_id: row.get(2)?,
                        relation_kind: row.get(3)?,
                        payload_ct: row.get(4)?,
                        payload_schema_version: read_u32(row, 5)?,
                        object_clock: row.get(6)?,
                        head_commit_id: row.get(7)?,
                        deleted: row.get::<_, i32>(8)? != 0,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
                        created_by_device_id: row.get(11)?,
                        updated_by_device_id: row.get(12)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(relation_id.to_string()))
    }

    pub fn current_object_label_row(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<ObjectLabelRow> {
        conn.inner()
            .query_row(
                "SELECT label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                        object_clock, head_commit_id, deleted, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |row| {
                    Ok(ObjectLabelRow {
                        label_id: row.get(0)?,
                        collection_id: row.get(1)?,
                        name_ct: row.get(2)?,
                        payload_ct: row.get(3)?,
                        payload_schema_version: read_u32(row, 4)?,
                        object_clock: row.get(5)?,
                        head_commit_id: row.get(6)?,
                        deleted: row.get::<_, i32>(7)? != 0,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        created_by_device_id: row.get(10)?,
                        updated_by_device_id: row.get(11)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(label_id.to_string()))
    }

    pub fn current_object_label_assignment_row(
        conn: &VaultConnection,
        assignment_id: &str,
    ) -> StorageResult<ObjectLabelAssignmentRow> {
        conn.inner()
            .query_row(
                "SELECT assignment_id, object_id, label_id, object_clock, head_commit_id,
                        deleted, created_at, updated_at, created_by_device_id,
                        updated_by_device_id
                 FROM object_label_assignments WHERE assignment_id = ?1",
                params![assignment_id],
                |row| {
                    Ok(ObjectLabelAssignmentRow {
                        assignment_id: row.get(0)?,
                        object_id: row.get(1)?,
                        label_id: row.get(2)?,
                        object_clock: row.get(3)?,
                        head_commit_id: row.get(4)?,
                        deleted: row.get::<_, i32>(5)? != 0,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        created_by_device_id: row.get(8)?,
                        updated_by_device_id: row.get(9)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(assignment_id.to_string()))
    }
}

fn read_u32(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u32> {
    let value = row.get::<_, i64>(column)?;
    u32::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}
