use std::collections::BTreeSet;

use mdbx_core::model::{
    CollectionProfile, CollectionTypeId, ExtensionCapabilityId, ObjectTypeId,
    MAX_COLLECTION_PROFILE_CAPABILITIES, MAX_COLLECTION_PROFILE_OBJECT_TYPES,
    MAX_COLLECTION_PROFILE_PAYLOAD_BYTES,
};
use rusqlite::{params, OptionalExtension};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, encrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::commit_ctx::CommitContext;
use crate::repo::object_version::ObjectVersionRepo;
use crate::sync_state::CollectionProfileRow;

const MAX_STORED_PROFILE_PAYLOAD_BYTES: usize = MAX_COLLECTION_PROFILE_PAYLOAD_BYTES + 256;

#[derive(Debug, Clone)]
pub struct CollectionProfileSpec {
    pub collection_id: String,
    pub collection_type_id: CollectionTypeId,
    pub payload: Vec<u8>,
    pub payload_schema_version: u32,
    pub allowed_object_type_ids: Vec<ObjectTypeId>,
    pub required_capability_ids: Vec<ExtensionCapabilityId>,
}

pub struct CollectionProfileRepo;

impl CollectionProfileRepo {
    pub fn set(
        conn: &VaultConnection,
        ctx: &CommitContext,
        spec: CollectionProfileSpec,
    ) -> StorageResult<CollectionProfile> {
        conn.with_immediate_transaction(|| {
            ensure_active_collection(conn, &spec.collection_id)?;
            let existing = Self::get_by_collection_id(conn, &spec.collection_id)?;
            if let Some(existing) = &existing {
                if existing.collection_type_id != spec.collection_type_id {
                    return Err(StorageError::ConstraintViolation(format!(
                        "collection {} type is immutable",
                        spec.collection_id
                    )));
                }
            }

            let now = chrono::Utc::now().to_rfc3339();
            let profile = CollectionProfile {
                collection_id: spec.collection_id.clone(),
                collection_type_id: spec.collection_type_id,
                payload_ct: spec.payload,
                payload_schema_version: spec.payload_schema_version,
                allowed_object_type_ids: spec.allowed_object_type_ids,
                required_capability_ids: spec.required_capability_ids,
                created_at: existing
                    .as_ref()
                    .map(|profile| profile.created_at.clone())
                    .unwrap_or_else(|| now.clone()),
                updated_at: now.clone(),
                created_by_device_id: existing
                    .as_ref()
                    .map(|profile| profile.created_by_device_id.clone())
                    .unwrap_or_else(|| ctx.device_id.clone()),
                updated_by_device_id: ctx.device_id.clone(),
            }
            .normalize()
            .map_err(StorageError::Validation)?;

            Self::ensure_capabilities_available(conn, &profile)?;
            Self::validate_existing_object_types(conn, &profile)?;

            let commit_id = ctx.commit_object_change(
                conn,
                "projects",
                &profile.collection_id,
                "change",
                "project",
            )?;
            let row = Self::stored_row_from_profile(conn, &profile)?;
            Self::upsert_stored_row(conn, &row)?;
            Self::advance_collection_head(conn, ctx, &profile.collection_id, &commit_id, &now)?;
            ObjectVersionRepo::record_project_current(conn, &commit_id, &profile.collection_id)?;

            Self::get_by_collection_id(conn, &profile.collection_id)?
                .ok_or_else(|| StorageError::NotFound(profile.collection_id.clone()))
        })
    }

    pub fn get_by_collection_id(
        conn: &VaultConnection,
        collection_id: &str,
    ) -> StorageResult<Option<CollectionProfile>> {
        Self::stored_by_collection_id(conn, collection_id)?
            .map(|row| Self::profile_from_stored_row(conn, &row))
            .transpose()
    }

    pub fn list_all(conn: &VaultConnection) -> StorageResult<Vec<CollectionProfile>> {
        Self::load_all_stored(conn)?
            .iter()
            .map(|row| Self::profile_from_stored_row(conn, row))
            .collect()
    }

    pub fn list_active(conn: &VaultConnection) -> StorageResult<Vec<CollectionProfile>> {
        let mut stmt = conn.inner().prepare(
            "SELECT cp.project_id, cp.collection_type_id, cp.payload_ct,
                    cp.payload_schema_version, cp.allowed_object_type_ids_json,
                    cp.required_capability_ids_json, cp.created_at, cp.updated_at,
                    cp.created_by_device_id, cp.updated_by_device_id
             FROM collection_profiles cp
             JOIN projects p ON p.project_id = cp.project_id
             WHERE p.deleted = 0 ORDER BY cp.project_id",
        )?;
        let rows = stmt.query_map([], stored_row_from_sql)?;
        let mut profiles = Vec::new();
        for row in rows {
            profiles.push(Self::profile_from_stored_row(conn, &row?)?);
        }
        Ok(profiles)
    }

    pub fn ensure_object_write_allowed(
        conn: &VaultConnection,
        collection_id: &str,
        object_type: &ObjectTypeId,
    ) -> StorageResult<()> {
        let Some(row) = Self::stored_by_collection_id(conn, collection_id)? else {
            return Ok(());
        };
        let metadata = parse_stored_metadata(&row)?;
        if metadata
            .allowed_object_type_ids
            .binary_search(object_type)
            .is_err()
        {
            return Err(StorageError::ConstraintViolation(format!(
                "object type {} is not allowed in collection {}",
                object_type, collection_id
            )));
        }
        ensure_metadata_capabilities(conn, collection_id, &metadata)
    }

    pub(crate) fn ensure_collection_write_capabilities(
        conn: &VaultConnection,
        collection_id: &str,
    ) -> StorageResult<()> {
        let Some(row) = Self::stored_by_collection_id(conn, collection_id)? else {
            return Ok(());
        };
        let metadata = parse_stored_metadata(&row)?;
        ensure_metadata_capabilities(conn, collection_id, &metadata)
    }

    pub(crate) fn ensure_entry_write_capabilities(
        conn: &VaultConnection,
        entry_id: &str,
    ) -> StorageResult<()> {
        let entry = conn
            .inner()
            .query_row(
                "SELECT project_id, entry_type FROM entries WHERE entry_id = ?1",
                params![entry_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let Some((collection_id, object_type)) = entry else {
            return Err(StorageError::NotFound(entry_id.to_string()));
        };
        let object_type = object_type.parse().map_err(StorageError::Validation)?;
        Self::ensure_object_write_allowed(conn, &collection_id, &object_type)
    }

    pub(crate) fn ensure_object_sync_allowed(
        conn: &VaultConnection,
        collection_id: &str,
        object_type: &ObjectTypeId,
    ) -> StorageResult<()> {
        let Some(row) = Self::stored_by_collection_id(conn, collection_id)? else {
            return Ok(());
        };
        let metadata = parse_stored_metadata(&row)?;
        if metadata
            .allowed_object_type_ids
            .binary_search(object_type)
            .is_err()
        {
            return Err(StorageError::ConstraintViolation(format!(
                "incoming object type {} is not allowed in collection {}",
                object_type, collection_id
            )));
        }
        Ok(())
    }

    pub(crate) fn stored_by_collection_id(
        conn: &VaultConnection,
        collection_id: &str,
    ) -> StorageResult<Option<CollectionProfileRow>> {
        conn.inner()
            .query_row(
                "SELECT project_id, collection_type_id, payload_ct,
                        payload_schema_version, allowed_object_type_ids_json,
                        required_capability_ids_json, created_at, updated_at,
                        created_by_device_id, updated_by_device_id
                 FROM collection_profiles WHERE project_id = ?1",
                params![collection_id],
                stored_row_from_sql,
            )
            .optional()
            .map_err(StorageError::Database)
    }

    pub(crate) fn load_all_stored(
        conn: &VaultConnection,
    ) -> StorageResult<Vec<CollectionProfileRow>> {
        let mut stmt = conn.inner().prepare(
            "SELECT project_id, collection_type_id, payload_ct,
                    payload_schema_version, allowed_object_type_ids_json,
                    required_capability_ids_json, created_at, updated_at,
                    created_by_device_id, updated_by_device_id
             FROM collection_profiles ORDER BY project_id",
        )?;
        let rows = stmt.query_map([], stored_row_from_sql)?;
        let mut profiles = Vec::new();
        for row in rows {
            let row = row?;
            validate_stored_row(&row)?;
            profiles.push(row);
        }
        Ok(profiles)
    }

    pub(crate) fn apply_synced_row(
        conn: &VaultConnection,
        row: &CollectionProfileRow,
    ) -> StorageResult<()> {
        validate_stored_row(row)?;
        ensure_collection_exists(conn, &row.project_id)?;
        let metadata = parse_stored_metadata(row)?;
        let mut normalized = row.clone();
        normalized.collection_type_id = metadata.collection_type_id.to_string();
        normalized.allowed_object_type_ids = metadata
            .allowed_object_type_ids
            .iter()
            .map(ToString::to_string)
            .collect();
        normalized.required_capability_ids = metadata
            .required_capability_ids
            .iter()
            .map(ToString::to_string)
            .collect();
        if let Some(existing) = Self::stored_by_collection_id(conn, &row.project_id)? {
            if existing.collection_type_id != normalized.collection_type_id {
                return Err(StorageError::ConstraintViolation(format!(
                    "collection {} type is immutable",
                    row.project_id
                )));
            }
        }
        validate_active_entry_types(conn, &row.project_id, &metadata.allowed_object_type_ids)?;
        Self::upsert_stored_row(conn, &normalized)
    }

    pub(crate) fn restore_profile(
        conn: &VaultConnection,
        profile: &CollectionProfile,
        now: &str,
        device_id: &str,
    ) -> StorageResult<()> {
        let mut profile = profile
            .clone()
            .normalize()
            .map_err(StorageError::Validation)?;
        ensure_collection_exists(conn, &profile.collection_id)?;
        if let Some(existing) = Self::get_by_collection_id(conn, &profile.collection_id)? {
            if existing.collection_type_id != profile.collection_type_id {
                return Err(StorageError::ConstraintViolation(format!(
                    "collection {} type is immutable",
                    profile.collection_id
                )));
            }
            profile.created_at = existing.created_at;
            profile.created_by_device_id = existing.created_by_device_id;
        }
        profile.updated_at = now.to_string();
        profile.updated_by_device_id = device_id.to_string();
        Self::validate_existing_object_types(conn, &profile)?;
        let row = Self::stored_row_from_profile(conn, &profile)?;
        Self::upsert_stored_row(conn, &row)
    }

    fn ensure_capabilities_available(
        conn: &VaultConnection,
        profile: &CollectionProfile,
    ) -> StorageResult<()> {
        conn.extension_registry()
            .validate_collection_profile(profile)?;
        let missing = profile
            .missing_capabilities(conn.extension_capabilities())
            .into_iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(StorageError::MissingExtensionCapabilities {
                collection_id: profile.collection_id.clone(),
                capabilities: missing,
            });
        }
        Ok(())
    }

    fn validate_existing_object_types(
        conn: &VaultConnection,
        profile: &CollectionProfile,
    ) -> StorageResult<()> {
        validate_active_entry_types(
            conn,
            &profile.collection_id,
            &profile.allowed_object_type_ids,
        )
    }

    fn stored_row_from_profile(
        conn: &VaultConnection,
        profile: &CollectionProfile,
    ) -> StorageResult<CollectionProfileRow> {
        let payload_ct = encrypt_field(
            conn,
            FieldKeyPurpose::Record,
            &profile.payload_ct,
            "collection-profile",
            &profile.collection_id,
            "payload",
        )?;
        Ok(CollectionProfileRow {
            project_id: profile.collection_id.clone(),
            collection_type_id: profile.collection_type_id.to_string(),
            payload_ct,
            payload_schema_version: profile.payload_schema_version,
            allowed_object_type_ids: profile
                .allowed_object_type_ids
                .iter()
                .map(ToString::to_string)
                .collect(),
            required_capability_ids: profile
                .required_capability_ids
                .iter()
                .map(ToString::to_string)
                .collect(),
            created_at: profile.created_at.clone(),
            updated_at: profile.updated_at.clone(),
            created_by_device_id: profile.created_by_device_id.clone(),
            updated_by_device_id: profile.updated_by_device_id.clone(),
        })
    }

    fn profile_from_stored_row(
        conn: &VaultConnection,
        row: &CollectionProfileRow,
    ) -> StorageResult<CollectionProfile> {
        let metadata = parse_stored_metadata(row)?;
        let payload = decrypt_field(
            conn,
            FieldKeyPurpose::Record,
            &row.payload_ct,
            "collection-profile",
            &row.project_id,
            "payload",
        )?;
        CollectionProfile {
            collection_id: row.project_id.clone(),
            collection_type_id: metadata.collection_type_id,
            payload_ct: payload,
            payload_schema_version: row.payload_schema_version,
            allowed_object_type_ids: metadata.allowed_object_type_ids,
            required_capability_ids: metadata.required_capability_ids,
            created_at: row.created_at.clone(),
            updated_at: row.updated_at.clone(),
            created_by_device_id: row.created_by_device_id.clone(),
            updated_by_device_id: row.updated_by_device_id.clone(),
        }
        .normalize()
        .map_err(StorageError::Validation)
    }

    fn upsert_stored_row(conn: &VaultConnection, row: &CollectionProfileRow) -> StorageResult<()> {
        validate_stored_row(row)?;
        let allowed = serde_json::to_string(&row.allowed_object_type_ids)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        let required = serde_json::to_string(&row.required_capability_ids)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        conn.inner().execute(
            "INSERT INTO collection_profiles
                (project_id, collection_type_id, payload_ct, payload_schema_version,
                 allowed_object_type_ids_json, required_capability_ids_json,
                 created_at, updated_at, created_by_device_id, updated_by_device_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(project_id) DO UPDATE SET
                collection_type_id = excluded.collection_type_id,
                payload_ct = excluded.payload_ct,
                payload_schema_version = excluded.payload_schema_version,
                allowed_object_type_ids_json = excluded.allowed_object_type_ids_json,
                required_capability_ids_json = excluded.required_capability_ids_json,
                updated_at = excluded.updated_at,
                updated_by_device_id = excluded.updated_by_device_id",
            params![
                row.project_id,
                row.collection_type_id,
                row.payload_ct,
                i64::from(row.payload_schema_version),
                allowed,
                required,
                row.created_at,
                row.updated_at,
                row.created_by_device_id,
                row.updated_by_device_id,
            ],
        )?;
        Ok(())
    }

    fn advance_collection_head(
        conn: &VaultConnection,
        ctx: &CommitContext,
        collection_id: &str,
        commit_id: &str,
        now: &str,
    ) -> StorageResult<()> {
        let current_clock: String = conn.inner().query_row(
            "SELECT object_clock FROM projects WHERE project_id = ?1",
            params![collection_id],
            |row| row.get(0),
        )?;
        conn.inner().execute(
            "UPDATE projects SET object_clock = ?2, head_commit_id = ?3,
                updated_at = ?4, updated_by_device_id = ?5
             WHERE project_id = ?1",
            params![
                collection_id,
                bump_clock(&current_clock),
                commit_id,
                now,
                ctx.device_id,
            ],
        )?;
        Ok(())
    }
}

struct StoredProfileMetadata {
    collection_type_id: CollectionTypeId,
    allowed_object_type_ids: Vec<ObjectTypeId>,
    required_capability_ids: Vec<ExtensionCapabilityId>,
}

fn ensure_metadata_capabilities(
    conn: &VaultConnection,
    collection_id: &str,
    metadata: &StoredProfileMetadata,
) -> StorageResult<()> {
    conn.extension_registry().validate_collection_contract(
        &metadata.collection_type_id,
        &metadata.allowed_object_type_ids,
        &metadata.required_capability_ids,
    )?;
    let missing = metadata
        .required_capability_ids
        .iter()
        .filter(|capability| !conn.extension_capabilities().contains(*capability))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(StorageError::MissingExtensionCapabilities {
            collection_id: collection_id.to_string(),
            capabilities: missing,
        });
    }
    Ok(())
}

fn parse_stored_metadata(row: &CollectionProfileRow) -> StorageResult<StoredProfileMetadata> {
    validate_stored_row(row)?;
    let collection_type_id = row
        .collection_type_id
        .parse()
        .map_err(StorageError::Validation)?;
    let mut allowed_object_type_ids = row
        .allowed_object_type_ids
        .iter()
        .map(|value| value.parse().map_err(StorageError::Validation))
        .collect::<StorageResult<Vec<ObjectTypeId>>>()?;
    let mut required_capability_ids = row
        .required_capability_ids
        .iter()
        .map(|value| value.parse().map_err(StorageError::Validation))
        .collect::<StorageResult<Vec<ExtensionCapabilityId>>>()?;
    allowed_object_type_ids.sort();
    allowed_object_type_ids.dedup();
    required_capability_ids.sort();
    required_capability_ids.dedup();
    Ok(StoredProfileMetadata {
        collection_type_id,
        allowed_object_type_ids,
        required_capability_ids,
    })
}

fn validate_stored_row(row: &CollectionProfileRow) -> StorageResult<()> {
    if row.project_id.is_empty() {
        return Err(StorageError::Validation(
            "collection profile requires a project ID".to_string(),
        ));
    }
    CollectionTypeId::new(&row.collection_type_id).map_err(StorageError::Validation)?;
    if row.payload_schema_version == 0 {
        return Err(StorageError::Validation(
            "collection profile payload schema version must be greater than zero".to_string(),
        ));
    }
    if row.payload_ct.len() > MAX_STORED_PROFILE_PAYLOAD_BYTES {
        return Err(StorageError::Validation(format!(
            "stored collection profile payload exceeds {} bytes",
            MAX_STORED_PROFILE_PAYLOAD_BYTES
        )));
    }
    if row.allowed_object_type_ids.len() > MAX_COLLECTION_PROFILE_OBJECT_TYPES
        || row.required_capability_ids.len() > MAX_COLLECTION_PROFILE_CAPABILITIES
    {
        return Err(StorageError::Validation(
            "collection profile declaration exceeds its resource limit".to_string(),
        ));
    }
    if row.created_at.is_empty()
        || row.updated_at.is_empty()
        || row.created_by_device_id.is_empty()
        || row.updated_by_device_id.is_empty()
    {
        return Err(StorageError::Validation(
            "collection profile requires timestamps and device identities".to_string(),
        ));
    }
    Ok(())
}

fn stored_row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<CollectionProfileRow> {
    let allowed_json: String = row.get(4)?;
    let required_json: String = row.get(5)?;
    let allowed_object_type_ids = serde_json::from_str(&allowed_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let required_capability_ids = serde_json::from_str(&required_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let payload_schema_version = read_u32(row, 3)?;
    Ok(CollectionProfileRow {
        project_id: row.get(0)?,
        collection_type_id: row.get(1)?,
        payload_ct: row.get(2)?,
        payload_schema_version,
        allowed_object_type_ids,
        required_capability_ids,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        created_by_device_id: row.get(8)?,
        updated_by_device_id: row.get(9)?,
    })
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

fn ensure_collection_exists(conn: &VaultConnection, collection_id: &str) -> StorageResult<()> {
    let exists = conn
        .inner()
        .query_row(
            "SELECT 1 FROM projects WHERE project_id = ?1",
            params![collection_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Err(StorageError::NotFound(collection_id.to_string()));
    }
    Ok(())
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
        Some(value) if value != 0 => Err(StorageError::ConstraintViolation(format!(
            "collection {} is deleted",
            collection_id
        ))),
        Some(_) => Ok(()),
    }
}

fn validate_active_entry_types(
    conn: &VaultConnection,
    collection_id: &str,
    allowed: &[ObjectTypeId],
) -> StorageResult<()> {
    let allowed = allowed.iter().collect::<BTreeSet<_>>();
    let mut stmt = conn.inner().prepare(
        "SELECT entry_id, entry_type FROM entries
         WHERE project_id = ?1 AND deleted = 0 ORDER BY entry_id",
    )?;
    let rows = stmt.query_map(params![collection_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (entry_id, object_type) = row?;
        let object_type: ObjectTypeId = object_type.parse().map_err(StorageError::Validation)?;
        if !allowed.contains(&object_type) {
            return Err(StorageError::ConstraintViolation(format!(
                "active object {} has type {} outside collection {} profile",
                entry_id, object_type, collection_id
            )));
        }
    }
    Ok(())
}

fn bump_clock(clock: &str) -> String {
    let counter = serde_json::from_str::<serde_json::Value>(clock)
        .ok()
        .and_then(|value| value.get("counter")?.as_u64())
        .unwrap_or(0);
    format!(r#"{{"counter":{}}}"#, counter + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::recovery::RecoveryVerifier;
    use crate::repo::{
        AttachmentRepo, EntryRepo, ObjectLabelCreateRequest, ObjectLabelRepo,
        ObjectRelationCreateRequest, ObjectRelationRepo, ProjectRepo,
    };
    use mdbx_core::model::{ExtensionFeatureId, ExtensionId, ExtensionProfile, RelationKindId};

    fn setup() -> (VaultConnection, CommitContext, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn.set_extension_capabilities([
            ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
        ]);
        let ctx = CommitContext::new("device-1".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        (conn, ctx, project.project_id)
    }

    fn spec(collection_id: &str) -> CollectionProfileSpec {
        CollectionProfileSpec {
            collection_id: collection_id.to_string(),
            collection_type_id: CollectionTypeId::new("com.monica.mail").unwrap(),
            payload: br#"{"account":"primary"}"#.to_vec(),
            payload_schema_version: 1,
            allowed_object_type_ids: vec![ObjectTypeId::custom("com.monica.mail.message").unwrap()],
            required_capability_ids: vec![
                ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
            ],
        }
    }

    fn extension_profile() -> ExtensionProfile {
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
    fn legacy_collection_has_no_profile_and_keeps_legacy_writes() {
        let (conn, ctx, collection_id) = setup();
        assert!(
            CollectionProfileRepo::get_by_collection_id(&conn, &collection_id)
                .unwrap()
                .is_none()
        );
        EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some("Login"),
            &serde_json::json!({"username":"alice"}),
        )
        .unwrap();
    }

    #[test]
    fn set_profile_is_atomic_and_advances_project_history() {
        let (conn, ctx, collection_id) = setup();
        let before = ProjectRepo::get_by_id(&conn, &collection_id)
            .unwrap()
            .unwrap();
        let profile = CollectionProfileRepo::set(&conn, &ctx, spec(&collection_id)).unwrap();
        let after = ProjectRepo::get_by_id(&conn, &collection_id)
            .unwrap()
            .unwrap();
        assert_eq!(profile.payload_ct, br#"{"account":"primary"}"#);
        assert_ne!(after.head_commit_id, before.head_commit_id);
        assert!(
            ObjectVersionRepo::get_project(&conn, &collection_id, &after.head_commit_id)
                .unwrap()
                .unwrap()
                .collection_profile
                .is_some()
        );
    }

    #[test]
    fn registered_extension_constrains_new_collection_profiles_atomically() {
        let (mut conn, ctx, collection_id) = setup();
        conn.register_extension_profile(extension_profile())
            .unwrap();
        let commits_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let mut foreign_object = spec(&collection_id);
        foreign_object.allowed_object_type_ids =
            vec![ObjectTypeId::custom("com.monica.mail.folder").unwrap()];

        assert!(CollectionProfileRepo::set(&conn, &ctx, foreign_object).is_err());
        assert!(
            CollectionProfileRepo::get_by_collection_id(&conn, &collection_id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            conn.inner()
                .query_row("SELECT COUNT(*) FROM commits", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            commits_before
        );

        let mut foreign_capability = spec(&collection_id);
        foreign_capability.required_capability_ids =
            vec![ExtensionCapabilityId::new("com.monica.mail.export").unwrap()];
        assert!(CollectionProfileRepo::set(&conn, &ctx, foreign_capability).is_err());

        CollectionProfileRepo::set(&conn, &ctx, spec(&collection_id)).unwrap();
    }

    #[test]
    fn registering_an_adapter_rechecks_existing_profiles_only_for_writes() {
        let (mut conn, ctx, collection_id) = setup();
        let mut broader = spec(&collection_id);
        broader.allowed_object_type_ids =
            vec![ObjectTypeId::custom("com.monica.mail.folder").unwrap()];
        CollectionProfileRepo::set(&conn, &ctx, broader).unwrap();
        conn.register_extension_profile(extension_profile())
            .unwrap();

        assert!(
            CollectionProfileRepo::get_by_collection_id(&conn, &collection_id)
                .unwrap()
                .is_some()
        );
        assert!(CollectionProfileRepo::ensure_object_write_allowed(
            &conn,
            &collection_id,
            &ObjectTypeId::custom("com.monica.mail.folder").unwrap(),
        )
        .is_err());
    }

    #[test]
    fn profile_type_is_immutable_and_capabilities_are_required() {
        let (mut conn, ctx, collection_id) = setup();
        CollectionProfileRepo::set(&conn, &ctx, spec(&collection_id)).unwrap();

        let mut changed = spec(&collection_id);
        changed.collection_type_id = CollectionTypeId::new("com.monica.bookmark").unwrap();
        assert!(CollectionProfileRepo::set(&conn, &ctx, changed).is_err());

        conn.set_extension_capabilities([]);
        let error = CollectionProfileRepo::ensure_object_write_allowed(
            &conn,
            &collection_id,
            &ObjectTypeId::custom("com.monica.mail.message").unwrap(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            StorageError::MissingExtensionCapabilities { .. }
        ));
    }

    #[test]
    fn profile_rejects_existing_objects_outside_declared_types() {
        let (conn, ctx, collection_id) = setup();
        EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::Login,
            Some("Login"),
            &serde_json::json!({}),
        )
        .unwrap();
        assert!(CollectionProfileRepo::set(&conn, &ctx, spec(&collection_id)).is_err());
    }

    #[test]
    fn health_check_reports_invalid_collection_profile_metadata() {
        let (conn, ctx, collection_id) = setup();
        CollectionProfileRepo::set(&conn, &ctx, spec(&collection_id)).unwrap();
        conn.inner()
            .execute(
                "UPDATE collection_profiles SET collection_type_id = 'Mail' WHERE project_id = ?1",
                params![collection_id],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_collection_profiles(&conn).unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].category, "collection-profiles");
    }

    #[test]
    fn encrypted_profile_tampering_is_rejected_and_reported() {
        use mdbx_crypto::keyring::Keyring;

        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn.attach_keyring(
            Keyring::from_vault_key(&[7_u8; 32], b"collection-profile-test").unwrap(),
        );
        conn.set_extension_capabilities([
            ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
        ]);
        let ctx = CommitContext::new("device-1".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        CollectionProfileRepo::set(&conn, &ctx, spec(&project.project_id)).unwrap();
        conn.inner()
            .execute(
                "UPDATE collection_profiles SET payload_ct = ?2 WHERE project_id = ?1",
                params![&project.project_id, b"invalid-ciphertext".as_slice()],
            )
            .unwrap();

        assert!(CollectionProfileRepo::get_by_collection_id(&conn, &project.project_id).is_err());
        let issues = RecoveryVerifier::check_collection_profiles(&conn).unwrap();
        assert_eq!(issues.len(), 1);
        assert!(issues[0].description.contains("invalid"));
    }

    #[test]
    fn missing_adapter_blocks_collection_metadata_relations_and_attachments() {
        let (mut conn, ctx, collection_id) = setup();
        CollectionProfileRepo::set(&conn, &ctx, spec(&collection_id)).unwrap();
        let first = EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            Some("First"),
            &serde_json::json!({}),
        )
        .unwrap();
        let second = EntryRepo::create(
            &conn,
            &ctx,
            &collection_id,
            ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            Some("Second"),
            &serde_json::json!({}),
        )
        .unwrap();
        conn.set_extension_capabilities([]);

        assert!(ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &first.entry_id,
                &second.entry_id,
                RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                serde_json::json!({}),
            ),
        )
        .is_err());
        assert!(ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(&collection_id, "Inbox", serde_json::json!({})),
        )
        .is_err());
        assert!(AttachmentRepo::add(
            &conn,
            &ctx,
            &collection_id,
            Some(&first.entry_id),
            "message.eml",
            Some("message/rfc822"),
            "hash",
            0,
        )
        .is_err());
        assert!(ProjectRepo::soft_delete(&conn, &ctx, &collection_id).is_err());
    }
}
