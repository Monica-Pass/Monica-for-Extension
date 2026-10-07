use rusqlite::params;
use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use uuid::Uuid;

use mdbx_core::model::{ObjectRelation, RelationKindId};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::repo::object_version::ObjectVersionRepo;
use crate::repo::{CollectionProfileRepo, TombstoneRepo};

#[derive(Debug, Clone)]
pub struct ObjectRelationCreateRequest {
    pub relation_id: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub relation_kind: RelationKindId,
    pub payload: serde_json::Value,
    pub payload_schema_version: u32,
}

impl ObjectRelationCreateRequest {
    pub fn new(
        source_object_id: impl Into<String>,
        target_object_id: impl Into<String>,
        relation_kind: RelationKindId,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            relation_id: Uuid::new_v4().to_string(),
            source_object_id: source_object_id.into(),
            target_object_id: target_object_id.into(),
            relation_kind,
            payload,
            payload_schema_version: 1,
        }
    }

    pub fn with_relation_id(mut self, relation_id: impl Into<String>) -> Self {
        self.relation_id = relation_id.into();
        self
    }

    pub fn with_payload_schema_version(mut self, payload_schema_version: u32) -> Self {
        self.payload_schema_version = payload_schema_version;
        self
    }
}

pub struct ObjectRelationRepo;

/// Stable endpoint IDs used to resolve relation disclosure policies without reading payloads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ObjectRelationAuthorizationContext {
    pub source_object_id: String,
    pub target_object_id: String,
}

impl ObjectRelationRepo {
    pub fn create(
        conn: &VaultConnection,
        ctx: &CommitContext,
        request: ObjectRelationCreateRequest,
    ) -> StorageResult<ObjectRelation> {
        validate_create_request(&request)?;
        if TombstoneRepo::is_permanently_purged(conn, "object-relation", &request.relation_id)? {
            return Err(StorageError::ConstraintViolation(format!(
                "relation ID {} has a permanent purge receipt",
                request.relation_id
            )));
        }
        conn.with_immediate_transaction(|| {
            ensure_active_object(conn, &request.source_object_id)?;
            ensure_active_object(conn, &request.target_object_id)?;
            CollectionProfileRepo::ensure_entry_write_capabilities(
                conn,
                &request.source_object_id,
            )?;
            CollectionProfileRepo::ensure_entry_write_capabilities(
                conn,
                &request.target_object_id,
            )?;

            let now = chrono::Utc::now().to_rfc3339();
            let commit_id = ctx.create_commit(
                conn,
                "change",
                "object-relation",
                &[request.relation_id.clone()],
                &[],
            )?;
            let payload = serde_json::to_vec(&request.payload)
                .map_err(|error| StorageError::Validation(error.to_string()))?;
            let payload_ct = encrypt_field(
                conn,
                FieldKeyPurpose::Record,
                &payload,
                "object-relation",
                &request.relation_id,
                "payload",
            )?;
            conn.inner().execute(
                "INSERT INTO object_relations
                    (relation_id, source_object_id, target_object_id, relation_kind,
                     payload_ct, payload_schema_version, object_clock, head_commit_id,
                     deleted, created_at, updated_at, created_by_device_id,
                     updated_by_device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9, ?10, ?10)",
                params![
                    request.relation_id,
                    request.source_object_id,
                    request.target_object_id,
                    request.relation_kind.to_string(),
                    payload_ct,
                    request.payload_schema_version as i64,
                    r#"{"counter":1}"#,
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_object_relation_current(
                conn,
                &commit_id,
                &request.relation_id,
            )?;
            Self::get_by_id(conn, &request.relation_id)?
                .ok_or_else(|| StorageError::NotFound(request.relation_id.clone()))
        })
    }

    pub fn get_by_id(
        conn: &VaultConnection,
        relation_id: &str,
    ) -> StorageResult<Option<ObjectRelation>> {
        conn.inner()
            .query_row(
                "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                        payload_ct, payload_schema_version, object_clock, head_commit_id,
                        deleted, created_at, updated_at, created_by_device_id,
                        updated_by_device_id
                 FROM object_relations WHERE relation_id = ?1",
                params![relation_id],
                |row| relation_from_row(conn, row),
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn get_authorization_context(
        conn: &VaultConnection,
        relation_id: &str,
    ) -> StorageResult<Option<ObjectRelationAuthorizationContext>> {
        conn.inner()
            .query_row(
                "SELECT source_object_id, target_object_id
                 FROM object_relations WHERE relation_id = ?1",
                params![relation_id],
                |row| {
                    Ok(ObjectRelationAuthorizationContext {
                        source_object_id: row.get(0)?,
                        target_object_id: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn is_deleted(
        conn: &VaultConnection,
        relation_id: &str,
    ) -> StorageResult<Option<bool>> {
        conn.inner()
            .query_row(
                "SELECT deleted FROM object_relations WHERE relation_id = ?1",
                params![relation_id],
                |row| Ok(row.get::<_, i32>(0)? != 0),
            )
            .optional()
            .map_err(StorageError::Database)
    }

    /// Return stored payload ciphertext length without materializing the BLOB.
    pub(crate) fn payload_ciphertext_len(
        conn: &VaultConnection,
        relation_id: &str,
    ) -> StorageResult<Option<u64>> {
        let stored = conn
            .inner()
            .query_row(
                "SELECT length(payload_ct) FROM object_relations WHERE relation_id = ?1",
                params![relation_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(StorageError::Database)?;

        stored
            .map(|length| {
                u64::try_from(length).map_err(|_| {
                    StorageError::Validation(format!(
                        "object relation {relation_id} has a negative payload ciphertext length"
                    ))
                })
            })
            .transpose()
    }

    pub fn list_from_object(
        conn: &VaultConnection,
        source_object_id: &str,
        relation_kind: Option<&RelationKindId>,
    ) -> StorageResult<Vec<ObjectRelation>> {
        match relation_kind {
            Some(kind) => Self::list_where(
                conn,
                "deleted = 0 AND source_object_id = ?1 AND relation_kind = ?2",
                params![source_object_id, kind.to_string()],
            ),
            None => Self::list_where(
                conn,
                "deleted = 0 AND source_object_id = ?1",
                params![source_object_id],
            ),
        }
    }

    pub fn list_to_object(
        conn: &VaultConnection,
        target_object_id: &str,
        relation_kind: Option<&RelationKindId>,
    ) -> StorageResult<Vec<ObjectRelation>> {
        match relation_kind {
            Some(kind) => Self::list_where(
                conn,
                "deleted = 0 AND target_object_id = ?1 AND relation_kind = ?2",
                params![target_object_id, kind.to_string()],
            ),
            None => Self::list_where(
                conn,
                "deleted = 0 AND target_object_id = ?1",
                params![target_object_id],
            ),
        }
    }

    pub fn update(
        conn: &VaultConnection,
        ctx: &CommitContext,
        relation: &ObjectRelation,
    ) -> StorageResult<ObjectRelation> {
        validate_relation(relation)?;
        conn.with_immediate_transaction(|| {
            ensure_active_object(conn, &relation.source_object_id)?;
            ensure_active_object(conn, &relation.target_object_id)?;
            CollectionProfileRepo::ensure_entry_write_capabilities(
                conn,
                &relation.source_object_id,
            )?;
            CollectionProfileRepo::ensure_entry_write_capabilities(
                conn,
                &relation.target_object_id,
            )?;
            let stored = Self::get_by_id(conn, &relation.relation_id)?
                .ok_or_else(|| StorageError::NotFound(relation.relation_id.clone()))?;
            if stored.deleted {
                return Err(StorageError::ConstraintViolation(
                    "object relation is deleted".to_string(),
                ));
            }

            let commit_id = ctx.commit_object_change_with_id_column(
                conn,
                "object_relations",
                "relation_id",
                &relation.relation_id,
                "change",
                "object-relation",
            )?;
            let payload_ct = encrypt_field(
                conn,
                FieldKeyPurpose::Record,
                &relation.payload_ct,
                "object-relation",
                &relation.relation_id,
                "payload",
            )?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.inner().execute(
                "UPDATE object_relations SET
                    source_object_id = ?2, target_object_id = ?3, relation_kind = ?4,
                    payload_ct = ?5, payload_schema_version = ?6, object_clock = ?7,
                    head_commit_id = ?8, updated_at = ?9, updated_by_device_id = ?10
                 WHERE relation_id = ?1",
                params![
                    relation.relation_id,
                    relation.source_object_id,
                    relation.target_object_id,
                    relation.relation_kind.to_string(),
                    payload_ct,
                    relation.payload_schema_version as i64,
                    bump_clock(&stored.object_clock),
                    commit_id,
                    now,
                    ctx.device_id,
                ],
            )?;
            ObjectVersionRepo::record_object_relation_current(
                conn,
                &commit_id,
                &relation.relation_id,
            )?;
            Self::get_by_id(conn, &relation.relation_id)?
                .ok_or_else(|| StorageError::NotFound(relation.relation_id.clone()))
        })
    }

    pub fn soft_delete(
        conn: &VaultConnection,
        ctx: &CommitContext,
        relation_id: &str,
    ) -> StorageResult<()> {
        conn.with_immediate_transaction(|| {
            let relation = Self::get_by_id(conn, relation_id)?
                .ok_or_else(|| StorageError::NotFound(relation_id.to_string()))?;
            if relation.deleted {
                return Err(StorageError::ConstraintViolation(
                    "object relation is already deleted".to_string(),
                ));
            }
            CollectionProfileRepo::ensure_entry_write_capabilities(
                conn,
                &relation.source_object_id,
            )?;
            CollectionProfileRepo::ensure_entry_write_capabilities(
                conn,
                &relation.target_object_id,
            )?;
            let commit_id = ctx.commit_object_change_with_id_column(
                conn,
                "object_relations",
                "relation_id",
                relation_id,
                "change",
                "object-relation",
            )?;
            conn.inner().execute(
                "UPDATE object_relations SET deleted = 1, object_clock = ?2,
                    head_commit_id = ?3, updated_at = ?4, updated_by_device_id = ?5
                 WHERE relation_id = ?1",
                params![
                    relation_id,
                    bump_clock(&relation.object_clock),
                    commit_id,
                    chrono::Utc::now().to_rfc3339(),
                    ctx.device_id,
                ],
            )?;
            ctx.create_tombstone_for_commit(conn, "object-relation", relation_id, &commit_id)?;
            ObjectVersionRepo::record_object_relation_current(conn, &commit_id, relation_id)?;
            Ok(())
        })
    }

    fn list_where(
        conn: &VaultConnection,
        where_clause: &str,
        query_params: impl rusqlite::Params,
    ) -> StorageResult<Vec<ObjectRelation>> {
        let sql = format!(
            "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                    payload_ct, payload_schema_version, object_clock, head_commit_id,
                    deleted, created_at, updated_at, created_by_device_id,
                    updated_by_device_id
             FROM object_relations WHERE {where_clause}
             ORDER BY updated_at DESC, relation_id ASC"
        );
        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(query_params, |row| relation_from_row(conn, row))?;
        let mut relations = Vec::new();
        for row in rows {
            relations.push(row?);
        }
        Ok(relations)
    }
}

fn validate_create_request(request: &ObjectRelationCreateRequest) -> StorageResult<()> {
    Uuid::parse_str(&request.relation_id).map_err(|_| {
        StorageError::Validation(format!(
            "relation_id {} must be a UUID",
            request.relation_id
        ))
    })?;
    if request.source_object_id == request.target_object_id {
        return Err(StorageError::Validation(
            "self relations require an explicit adapter object instead of an identity edge"
                .to_string(),
        ));
    }
    if request.payload_schema_version == 0 {
        return Err(StorageError::Validation(
            "payload_schema_version must be greater than zero".to_string(),
        ));
    }
    Ok(())
}

fn validate_relation(relation: &ObjectRelation) -> StorageResult<()> {
    Uuid::parse_str(&relation.relation_id).map_err(|_| {
        StorageError::Validation(format!(
            "relation_id {} must be a UUID",
            relation.relation_id
        ))
    })?;
    if relation.source_object_id == relation.target_object_id {
        return Err(StorageError::Validation(
            "self relations require an explicit adapter object instead of an identity edge"
                .to_string(),
        ));
    }
    if relation.payload_schema_version == 0 {
        return Err(StorageError::Validation(
            "payload_schema_version must be greater than zero".to_string(),
        ));
    }
    Ok(())
}

fn ensure_active_object(conn: &VaultConnection, object_id: &str) -> StorageResult<()> {
    let deleted = conn
        .inner()
        .query_row(
            "SELECT deleted FROM entries WHERE entry_id = ?1",
            params![object_id],
            |row| row.get::<_, i32>(0),
        )
        .optional()?;
    match deleted {
        None => Err(StorageError::NotFound(object_id.to_string())),
        Some(0) => Ok(()),
        Some(_) => Err(StorageError::ConstraintViolation(format!(
            "object {object_id} is deleted"
        ))),
    }
}

fn relation_from_row(
    conn: &VaultConnection,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ObjectRelation> {
    let relation_id: String = row.get(0)?;
    let relation_kind = row
        .get::<_, String>(3)?
        .parse()
        .map_err(|error| conversion_error(3, Type::Text, StorageError::Validation(error)))?;
    let raw_payload: Vec<u8> = row.get(4)?;
    let payload_ct = decrypt_field(
        conn,
        FieldKeyPurpose::Record,
        &raw_payload,
        "object-relation",
        &relation_id,
        "payload",
    )
    .map_err(|error| conversion_error(4, Type::Blob, error))?;
    let schema_value = row.get::<_, i64>(5)?;
    let payload_schema_version =
        u32::try_from(schema_value).map_err(|error| conversion_error(5, Type::Integer, error))?;
    Ok(ObjectRelation {
        relation_id,
        source_object_id: row.get(1)?,
        target_object_id: row.get(2)?,
        relation_kind,
        payload_ct,
        payload_schema_version,
        object_clock: row.get(6)?,
        head_commit_id: row.get(7)?,
        deleted: row.get::<_, i32>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        created_by_device_id: row.get(11)?,
        updated_by_device_id: row.get(12)?,
    })
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
        conn.attach_keyring(Keyring::from_vault_key(&vault_key, b"relation-test").unwrap());
        let ctx = CommitContext::new("relation-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Objects", None, None).unwrap();
        let first = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("First"),
            &serde_json::json!({"body": "first"}),
        )
        .unwrap();
        let second = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Second"),
            &serde_json::json!({"body": "second"}),
        )
        .unwrap();
        (conn, ctx, first.entry_id, second.entry_id)
    }

    #[test]
    fn object_relation_create_query_update_and_delete() {
        let (conn, ctx, first, second) = setup();
        let kind = RelationKindId::new("com.monica.mail.reply-to").unwrap();
        let created = ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &first,
                &second,
                kind.clone(),
                serde_json::json!({"position": 1}),
            )
            .with_payload_schema_version(2),
        )
        .unwrap();
        assert_eq!(created.relation_kind, kind);
        assert_eq!(created.payload_schema_version, 2);

        let raw_payload: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT payload_ct FROM object_relations WHERE relation_id = ?1",
                params![created.relation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(raw_payload, created.payload_ct);

        assert_eq!(
            ObjectRelationRepo::list_from_object(&conn, &first, Some(&kind))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            ObjectRelationRepo::list_to_object(&conn, &second, None)
                .unwrap()
                .len(),
            1
        );

        let first_commit = created.head_commit_id.clone();
        let mut changed = created.clone();
        changed.payload_ct = serde_json::to_vec(&serde_json::json!({"position": 2})).unwrap();
        changed.payload_schema_version = 3;
        let updated = ObjectRelationRepo::update(&conn, &ctx, &changed).unwrap();
        assert_eq!(updated.payload_schema_version, 3);
        let parent: String = conn
            .inner()
            .query_row(
                "SELECT parent_commit_id FROM commit_parents WHERE commit_id = ?1",
                params![updated.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent, first_commit);

        ObjectRelationRepo::soft_delete(&conn, &ctx, &updated.relation_id).unwrap();
        assert!(ObjectRelationRepo::list_from_object(&conn, &first, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            TombstoneRepo::list_by_type(&conn, TombstoneTargetType::ObjectRelation)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn object_relation_rejects_invalid_endpoints_and_versions() {
        let (conn, ctx, first, second) = setup();
        let kind = RelationKindId::new("com.monica.mail.reply-to").unwrap();
        assert!(ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &first,
                "missing-object",
                kind.clone(),
                serde_json::json!({}),
            ),
        )
        .is_err());
        assert!(ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(&first, &second, kind, serde_json::json!({}),)
                .with_payload_schema_version(0),
        )
        .is_err());
    }
}
