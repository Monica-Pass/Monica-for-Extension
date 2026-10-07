use rusqlite::params;
use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use uuid::Uuid;

use mdbx_core::model::{ObjectLabel, ObjectLabelAssignment};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::repo::object_version::ObjectVersionRepo;
use crate::repo::{CollectionProfileRepo, TombstoneRepo};

#[derive(Debug, Clone)]
pub struct ObjectLabelCreateRequest {
    pub label_id: String,
    pub collection_id: String,
    pub name: String,
    pub payload: serde_json::Value,
    pub payload_schema_version: u32,
}

impl ObjectLabelCreateRequest {
    pub fn new(
        collection_id: impl Into<String>,
        name: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            label_id: Uuid::new_v4().to_string(),
            collection_id: collection_id.into(),
            name: name.into(),
            payload,
            payload_schema_version: 1,
        }
    }

    pub fn with_label_id(mut self, label_id: impl Into<String>) -> Self {
        self.label_id = label_id.into();
        self
    }

    pub fn with_payload_schema_version(mut self, payload_schema_version: u32) -> Self {
        self.payload_schema_version = payload_schema_version;
        self
    }
}

#[derive(Debug, Clone)]
pub struct ObjectLabelAssignmentCreateRequest {
    pub assignment_id: String,
    pub object_id: String,
    pub label_id: String,
}

impl ObjectLabelAssignmentCreateRequest {
    pub fn new(object_id: impl Into<String>, label_id: impl Into<String>) -> Self {
        Self {
            assignment_id: Uuid::new_v4().to_string(),
            object_id: object_id.into(),
            label_id: label_id.into(),
        }
    }

    pub fn with_assignment_id(mut self, assignment_id: impl Into<String>) -> Self {
        self.assignment_id = assignment_id.into();
        self
    }
}

pub struct ObjectLabelRepo;

/// Collection identity used to resolve label disclosure policy without reading encrypted fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObjectLabelAuthorizationContext {
    pub collection_id: String,
}

impl ObjectLabelRepo {
    pub fn create(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: ObjectLabelCreateRequest,
    ) -> StorageResult<ObjectLabel> {
        validate_uuid(&request.label_id, "label_id")?;
        validate_name(&request.name)?;
        validate_schema_version(request.payload_schema_version)?;
        if TombstoneRepo::is_permanently_purged(conn, "object-label", &request.label_id)? {
            return Err(StorageError::ConstraintViolation(format!(
                "label ID {} has a permanent purge receipt",
                request.label_id
            )));
        }
        conn.with_immediate_transaction(|| {
            ensure_active_collection(conn, &request.collection_id)?;
            CollectionProfileRepo::ensure_collection_write_capabilities(
                conn,
                &request.collection_id,
            )?;
            let now = chrono::Utc::now().to_rfc3339();
            let commit_id = ctx.create_commit(
                conn,
                "change",
                "object-label",
                &[request.label_id.clone()],
                &[],
            )?;
            let name_ct = encrypt_field(
                conn,
                FieldKeyPurpose::Metadata,
                request.name.as_bytes(),
                "object-label",
                &request.label_id,
                "name",
            )?;
            let payload = serde_json::to_vec(&request.payload)
                .map_err(|error| StorageError::Validation(error.to_string()))?;
            let payload_ct = encrypt_field(
                conn,
                FieldKeyPurpose::Record,
                &payload,
                "object-label",
                &request.label_id,
                "payload",
            )?;
            conn.inner().execute(
                "INSERT INTO object_labels
                    (label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                     object_clock, head_commit_id, deleted, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8, ?9, ?9)",
                params![
                    request.label_id,
                    request.collection_id,
                    name_ct,
                    payload_ct,
                    request.payload_schema_version as i64,
                    r#"{"counter":1}"#,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_object_label_current(conn, &commit_id, &request.label_id)?;
            Self::get_by_id(conn, &request.label_id)?
                .ok_or_else(|| StorageError::NotFound(request.label_id.clone()))
        })
    }

    pub fn get_by_id(conn: &VaultConnection, label_id: &str) -> StorageResult<Option<ObjectLabel>> {
        conn.inner()
            .query_row(
                "SELECT label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                        object_clock, head_commit_id, deleted, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |row| label_from_row(conn, row),
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn get_authorization_context(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<Option<ObjectLabelAuthorizationContext>> {
        conn.inner()
            .query_row(
                "SELECT collection_id FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |row| {
                    Ok(ObjectLabelAuthorizationContext {
                        collection_id: row.get(0)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn is_deleted(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<Option<bool>> {
        conn.inner()
            .query_row(
                "SELECT deleted FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |row| Ok(row.get::<_, i32>(0)? != 0),
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn name_ciphertext_len(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<Option<u64>> {
        let stored = conn
            .inner()
            .query_row(
                "SELECT length(name_ct) FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(StorageError::Database)?;

        stored
            .map(|length| {
                u64::try_from(length).map_err(|_| {
                    StorageError::Validation(format!(
                        "object label {label_id} has a negative name ciphertext length"
                    ))
                })
            })
            .transpose()
    }

    /// Return stored payload ciphertext length without materializing the BLOB.
    pub(crate) fn payload_ciphertext_len(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<Option<u64>> {
        let stored = conn
            .inner()
            .query_row(
                "SELECT length(payload_ct) FROM object_labels WHERE label_id = ?1",
                params![label_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(StorageError::Database)?;

        stored
            .map(|length| {
                u64::try_from(length).map_err(|_| {
                    StorageError::Validation(format!(
                        "object label {label_id} has a negative payload ciphertext length"
                    ))
                })
            })
            .transpose()
    }

    pub fn list_by_collection(
        conn: &VaultConnection,
        collection_id: &str,
    ) -> StorageResult<Vec<ObjectLabel>> {
        let mut stmt = conn.inner().prepare(
            "SELECT label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                    object_clock, head_commit_id, deleted, created_at, updated_at,
                    created_by_device_id, updated_by_device_id
             FROM object_labels
             WHERE collection_id = ?1 AND deleted = 0
             ORDER BY updated_at DESC, label_id ASC",
        )?;
        let rows = stmt.query_map(params![collection_id], |row| label_from_row(conn, row))?;
        collect_rows(rows)
    }

    pub fn update(
        conn: &VaultConnection,
        ctx: &CommitContext,
        label: &ObjectLabel,
    ) -> StorageResult<ObjectLabel> {
        validate_uuid(&label.label_id, "label_id")?;
        validate_name_bytes(&label.name_ct)?;
        validate_schema_version(label.payload_schema_version)?;
        conn.with_immediate_transaction(|| {
            let stored = Self::get_by_id(conn, &label.label_id)?
                .ok_or_else(|| StorageError::NotFound(label.label_id.clone()))?;
            if stored.deleted {
                return Err(StorageError::ConstraintViolation(
                    "object label is deleted".to_string(),
                ));
            }
            if stored.collection_id != label.collection_id {
                return Err(StorageError::ConstraintViolation(
                    "object label collection cannot change".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(
                conn,
                &label.collection_id,
            )?;
            let commit_id = ctx.commit_object_change_with_id_column(
                conn,
                "object_labels",
                "label_id",
                &label.label_id,
                "change",
                "object-label",
            )?;
            let name_ct = encrypt_field(
                conn,
                FieldKeyPurpose::Metadata,
                &label.name_ct,
                "object-label",
                &label.label_id,
                "name",
            )?;
            let payload_ct = encrypt_field(
                conn,
                FieldKeyPurpose::Record,
                &label.payload_ct,
                "object-label",
                &label.label_id,
                "payload",
            )?;
            conn.inner().execute(
                "UPDATE object_labels SET name_ct = ?2, payload_ct = ?3,
                    payload_schema_version = ?4, object_clock = ?5, head_commit_id = ?6,
                    updated_at = ?7, updated_by_device_id = ?8
                 WHERE label_id = ?1",
                params![
                    label.label_id,
                    name_ct,
                    payload_ct,
                    label.payload_schema_version as i64,
                    bump_clock(&stored.object_clock),
                    commit_id,
                    chrono::Utc::now().to_rfc3339(),
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_object_label_current(conn, &commit_id, &label.label_id)?;
            Self::get_by_id(conn, &label.label_id)?
                .ok_or_else(|| StorageError::NotFound(label.label_id.clone()))
        })
    }

    pub fn soft_delete(
        conn: &VaultConnection,
        ctx: &CommitContext,
        label_id: &str,
    ) -> StorageResult<()> {
        conn.with_immediate_transaction(|| {
            let label = Self::get_by_id(conn, label_id)?
                .ok_or_else(|| StorageError::NotFound(label_id.to_string()))?;
            if label.deleted {
                return Err(StorageError::ConstraintViolation(
                    "object label is already deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_collection_write_capabilities(
                conn,
                &label.collection_id,
            )?;
            let active_assignments: i64 = conn.inner().query_row(
                "SELECT COUNT(*) FROM object_label_assignments
                 WHERE label_id = ?1 AND deleted = 0",
                params![label_id],
                |row| row.get(0),
            )?;
            if active_assignments > 0 {
                return Err(StorageError::ConstraintViolation(
                    "object label still has active assignments".to_string(),
                ));
            }
            let commit_id = ctx.commit_object_change_with_id_column(
                conn,
                "object_labels",
                "label_id",
                label_id,
                "change",
                "object-label",
            )?;
            conn.inner().execute(
                "UPDATE object_labels SET deleted = 1, object_clock = ?2,
                    head_commit_id = ?3, updated_at = ?4, updated_by_device_id = ?5
                 WHERE label_id = ?1",
                params![
                    label_id,
                    bump_clock(&label.object_clock),
                    commit_id,
                    chrono::Utc::now().to_rfc3339(),
                    ctx.device_id,
                ],
            )?;
            ctx.create_tombstone_for_commit(conn, "object-label", label_id, &commit_id)?;
            ObjectVersionRepo::record_object_label_current(conn, &commit_id, label_id)?;
            Ok(())
        })
    }
}

pub struct ObjectLabelAssignmentRepo;

impl ObjectLabelAssignmentRepo {
    pub fn create(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: ObjectLabelAssignmentCreateRequest,
    ) -> StorageResult<ObjectLabelAssignment> {
        validate_uuid(&request.assignment_id, "assignment_id")?;
        if TombstoneRepo::is_permanently_purged(
            conn,
            "object-label-assignment",
            &request.assignment_id,
        )? {
            return Err(StorageError::ConstraintViolation(format!(
                "assignment ID {} has a permanent purge receipt",
                request.assignment_id
            )));
        }
        conn.with_immediate_transaction(|| {
            let object_collection = active_object_collection(conn, &request.object_id)?;
            CollectionProfileRepo::ensure_entry_write_capabilities(conn, &request.object_id)?;
            let label = ObjectLabelRepo::get_by_id(conn, &request.label_id)?
                .ok_or_else(|| StorageError::NotFound(request.label_id.clone()))?;
            if label.deleted {
                return Err(StorageError::ConstraintViolation(
                    "object label is deleted".to_string(),
                ));
            }
            if object_collection != label.collection_id {
                return Err(StorageError::ConstraintViolation(
                    "object and label must belong to the same collection".to_string(),
                ));
            }
            let now = chrono::Utc::now().to_rfc3339();
            let commit_id = ctx.create_commit(
                conn,
                "change",
                "object-label-assignment",
                &[request.assignment_id.clone()],
                &[],
            )?;
            conn.inner().execute(
                "INSERT INTO object_label_assignments
                    (assignment_id, object_id, label_id, object_clock, head_commit_id,
                     deleted, created_at, updated_at, created_by_device_id,
                     updated_by_device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6, ?7, ?7)",
                params![
                    request.assignment_id,
                    request.object_id,
                    request.label_id,
                    r#"{"counter":1}"#,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_object_label_assignment_current(
                conn,
                &commit_id,
                &request.assignment_id,
            )?;
            Self::get_by_id(conn, &request.assignment_id)?
                .ok_or_else(|| StorageError::NotFound(request.assignment_id.clone()))
        })
    }

    pub fn get_by_id(
        conn: &VaultConnection,
        assignment_id: &str,
    ) -> StorageResult<Option<ObjectLabelAssignment>> {
        conn.inner()
            .query_row(
                "SELECT assignment_id, object_id, label_id, object_clock, head_commit_id,
                        deleted, created_at, updated_at, created_by_device_id,
                        updated_by_device_id
                 FROM object_label_assignments WHERE assignment_id = ?1",
                params![assignment_id],
                assignment_from_row,
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub fn list_by_object(
        conn: &VaultConnection,
        object_id: &str,
    ) -> StorageResult<Vec<ObjectLabelAssignment>> {
        let mut stmt = conn.inner().prepare(
            "SELECT assignment_id, object_id, label_id, object_clock, head_commit_id,
                    deleted, created_at, updated_at, created_by_device_id,
                    updated_by_device_id
             FROM object_label_assignments
             WHERE object_id = ?1 AND deleted = 0
             ORDER BY created_at ASC, assignment_id ASC",
        )?;
        let rows = stmt.query_map(params![object_id], assignment_from_row)?;
        collect_rows(rows)
    }

    pub fn list_by_label(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<Vec<ObjectLabelAssignment>> {
        let mut stmt = conn.inner().prepare(
            "SELECT assignment_id, object_id, label_id, object_clock, head_commit_id,
                    deleted, created_at, updated_at, created_by_device_id,
                    updated_by_device_id
             FROM object_label_assignments
             WHERE label_id = ?1 AND deleted = 0
             ORDER BY created_at ASC, assignment_id ASC",
        )?;
        let rows = stmt.query_map(params![label_id], assignment_from_row)?;
        collect_rows(rows)
    }

    pub fn soft_delete(
        conn: &VaultConnection,
        ctx: &CommitContext,
        assignment_id: &str,
    ) -> StorageResult<()> {
        conn.with_immediate_transaction(|| {
            let assignment = Self::get_by_id(conn, assignment_id)?
                .ok_or_else(|| StorageError::NotFound(assignment_id.to_string()))?;
            if assignment.deleted {
                return Err(StorageError::ConstraintViolation(
                    "object label assignment is already deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_entry_write_capabilities(conn, &assignment.object_id)?;
            let commit_id = ctx.commit_object_change_with_id_column(
                conn,
                "object_label_assignments",
                "assignment_id",
                assignment_id,
                "change",
                "object-label-assignment",
            )?;
            conn.inner().execute(
                "UPDATE object_label_assignments SET deleted = 1, object_clock = ?2,
                    head_commit_id = ?3, updated_at = ?4, updated_by_device_id = ?5
                 WHERE assignment_id = ?1",
                params![
                    assignment_id,
                    bump_clock(&assignment.object_clock),
                    commit_id,
                    chrono::Utc::now().to_rfc3339(),
                    ctx.device_id,
                ],
            )?;
            ctx.create_tombstone_for_commit(
                conn,
                "object-label-assignment",
                assignment_id,
                &commit_id,
            )?;
            ObjectVersionRepo::record_object_label_assignment_current(
                conn,
                &commit_id,
                assignment_id,
            )?;
            Ok(())
        })
    }
}

fn label_from_row(
    conn: &VaultConnection,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ObjectLabel> {
    let label_id: String = row.get(0)?;
    let raw_name: Vec<u8> = row.get(2)?;
    let raw_payload: Vec<u8> = row.get(3)?;
    let name_ct = decrypt_field(
        conn,
        FieldKeyPurpose::Metadata,
        &raw_name,
        "object-label",
        &label_id,
        "name",
    )
    .map_err(|error| conversion_error(2, Type::Blob, error))?;
    let payload_ct = decrypt_field(
        conn,
        FieldKeyPurpose::Record,
        &raw_payload,
        "object-label",
        &label_id,
        "payload",
    )
    .map_err(|error| conversion_error(3, Type::Blob, error))?;
    let schema = u32::try_from(row.get::<_, i64>(4)?)
        .map_err(|error| conversion_error(4, Type::Integer, error))?;
    Ok(ObjectLabel {
        label_id,
        collection_id: row.get(1)?,
        name_ct,
        payload_ct,
        payload_schema_version: schema,
        object_clock: row.get(5)?,
        head_commit_id: row.get(6)?,
        deleted: row.get::<_, i32>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        created_by_device_id: row.get(10)?,
        updated_by_device_id: row.get(11)?,
    })
}

fn assignment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ObjectLabelAssignment> {
    Ok(ObjectLabelAssignment {
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
}

fn ensure_active_collection(conn: &VaultConnection, collection_id: &str) -> StorageResult<()> {
    let deleted = conn
        .inner()
        .query_row(
            "SELECT deleted FROM projects WHERE project_id = ?1",
            params![collection_id],
            |row| row.get::<_, i32>(0),
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

fn active_object_collection(conn: &VaultConnection, object_id: &str) -> StorageResult<String> {
    let row = conn
        .inner()
        .query_row(
            "SELECT project_id, deleted FROM entries WHERE entry_id = ?1",
            params![object_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
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

fn validate_uuid(value: &str, field: &str) -> StorageResult<()> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| StorageError::Validation(format!("{field} {value} must be a UUID")))
}

fn validate_name(value: &str) -> StorageResult<()> {
    validate_name_bytes(value.as_bytes())
}

pub(crate) fn validate_name_bytes(value: &[u8]) -> StorageResult<()> {
    let name =
        std::str::from_utf8(value).map_err(|error| StorageError::Validation(error.to_string()))?;
    if name.trim().is_empty()
        || name.len() > crate::presentation_metadata::MAX_PRESENTATION_LABEL_NAME_BYTES as usize
    {
        return Err(StorageError::Validation(
            "object label name must contain 1 to 512 UTF-8 bytes".to_string(),
        ));
    }
    Ok(())
}

fn validate_schema_version(value: u32) -> StorageResult<()> {
    if value == 0 {
        return Err(StorageError::Validation(
            "payload_schema_version must be greater than zero".to_string(),
        ));
    }
    Ok(())
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> StorageResult<Vec<T>> {
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

fn conversion_error(
    column: usize,
    field_type: Type,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, field_type, Box::new(error))
}

fn bump_clock(clock: &str) -> String {
    let counter = serde_json::from_str::<serde_json::Value>(clock)
        .ok()
        .and_then(|value| value.get("counter")?.as_u64())
        .unwrap_or(0)
        + 1;
    format!(r#"{{"counter":{counter}}}"#)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{EntryRepo, ProjectRepo, TombstoneRepo};
    use mdbx_core::model::{EntryType, TombstoneTargetType};
    use mdbx_crypto::keyring::Keyring;

    fn setup() -> (VaultConnection, CommitContext, String, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        conn.attach_keyring(Keyring::from_vault_key(&vault_key, b"label-test").unwrap());
        let ctx = CommitContext::new("label-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        let object = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Message"),
            &serde_json::json!({"body": "hello"}),
        )
        .unwrap();
        (conn, ctx, project.project_id, object.entry_id)
    }

    #[test]
    fn object_label_and_assignment_lifecycle_is_encrypted_and_causal() {
        let (conn, ctx, collection_id, object_id) = setup();
        let label = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(
                &collection_id,
                "Important",
                serde_json::json!({"color": "red"}),
            )
            .with_payload_schema_version(2),
        )
        .unwrap();
        assert_eq!(label.name_ct, b"Important");
        assert_eq!(label.payload_schema_version, 2);
        let raw: (Vec<u8>, Vec<u8>) = conn
            .inner()
            .query_row(
                "SELECT name_ct, payload_ct FROM object_labels WHERE label_id = ?1",
                params![label.label_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_ne!(raw.0, label.name_ct);
        assert_ne!(raw.1, label.payload_ct);

        let assignment = ObjectLabelAssignmentRepo::create(
            &conn,
            &ctx,
            ObjectLabelAssignmentCreateRequest::new(&object_id, &label.label_id),
        )
        .unwrap();
        assert_eq!(
            ObjectLabelAssignmentRepo::list_by_object(&conn, &object_id)
                .unwrap()
                .len(),
            1
        );
        assert!(ObjectLabelAssignmentRepo::create(
            &conn,
            &ctx,
            ObjectLabelAssignmentCreateRequest::new(&object_id, &label.label_id),
        )
        .is_err());
        assert!(ObjectLabelRepo::soft_delete(&conn, &ctx, &label.label_id).is_err());

        let mut updated = label.clone();
        updated.name_ct = b"Priority".to_vec();
        updated.payload_ct = serde_json::to_vec(&serde_json::json!({"color": "orange"})).unwrap();
        updated.payload_schema_version = 3;
        let updated = ObjectLabelRepo::update(&conn, &ctx, &updated).unwrap();
        assert_eq!(updated.name_ct, b"Priority");
        assert_eq!(updated.payload_schema_version, 3);

        ObjectLabelAssignmentRepo::soft_delete(&conn, &ctx, &assignment.assignment_id).unwrap();
        ObjectLabelRepo::soft_delete(&conn, &ctx, &label.label_id).unwrap();
        assert_eq!(
            TombstoneRepo::list_by_type(&conn, TombstoneTargetType::ObjectLabelAssignment)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            TombstoneRepo::list_by_type(&conn, TombstoneTargetType::ObjectLabel)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn assignment_requires_the_same_collection() {
        let (conn, ctx, collection_id, object_id) = setup();
        let other = ProjectRepo::create(&conn, &ctx, "Other", None, None).unwrap();
        let label = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(&other.project_id, "Other", serde_json::json!({})),
        )
        .unwrap();
        assert_ne!(collection_id, other.project_id);
        assert!(ObjectLabelAssignmentRepo::create(
            &conn,
            &ctx,
            ObjectLabelAssignmentCreateRequest::new(object_id, label.label_id),
        )
        .is_err());
    }
}
