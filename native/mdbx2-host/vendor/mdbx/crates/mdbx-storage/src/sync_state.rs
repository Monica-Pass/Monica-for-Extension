use mdbx_sync::ObjectPayload;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Write};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::key_epoch::RANDOM_KEY_EPOCH_PROFILE_ID;
use crate::repo::CollectionProfileRepo;
use crate::tiga_policy::{optional_integrity_tag, verify_optional_integrity_tag};

pub const SYNC_STATE_OBJECT_TYPE: &str = "mdbx-storage/state-v1";
pub const LEGACY_CLI_SYNC_STATE_OBJECT_TYPE: &str = "mdbx-cli/state-v1";
pub const SYNC_STATE_OBJECT_ID: &str = "state";
pub const DEFAULT_MAX_SYNC_STATE_PAYLOAD_BYTES: usize = 96 * 1024 * 1024;
pub const DEFAULT_MAX_SYNC_STATE_ROWS: usize = 250_000;
pub const HARD_MAX_SYNC_STATE_PAYLOAD_BYTES: usize = 512 * 1024 * 1024;
pub const HARD_MAX_SYNC_STATE_ROWS: usize = 2_000_000;
const MAX_SYNC_STATE_EXTENSION_FIELDS: usize = 256;
const MAX_SYNC_STATE_EXTENSION_KEY_BYTES: usize = 128;
const MAX_SYNC_STATE_EXTENSION_BYTES: usize = 64 * 1024;
const MAX_SYNC_STATE_EXTENSION_DEPTH: usize = 16;
pub(crate) const SYNC_STATE_FORMAT: &str = "mdbx-storage-sync-state-v2";
const PREVIOUS_SYNC_STATE_FORMAT: &str = "mdbx-storage-sync-state-v1";
const LEGACY_CLI_SYNC_STATE_FORMAT: &str = "mdbx-cli-sync-state-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncStateLimits {
    max_payload_bytes: usize,
    max_rows: usize,
}

impl SyncStateLimits {
    pub fn new(max_payload_bytes: usize, max_rows: usize) -> StorageResult<Self> {
        if max_payload_bytes == 0 || max_payload_bytes > HARD_MAX_SYNC_STATE_PAYLOAD_BYTES {
            return Err(StorageError::Validation(format!(
                "sync state payload limit must be between 1 and {HARD_MAX_SYNC_STATE_PAYLOAD_BYTES} bytes"
            )));
        }
        if max_rows == 0 || max_rows > HARD_MAX_SYNC_STATE_ROWS {
            return Err(StorageError::Validation(format!(
                "sync state row limit must be between 1 and {HARD_MAX_SYNC_STATE_ROWS}"
            )));
        }
        Ok(Self {
            max_payload_bytes,
            max_rows,
        })
    }

    pub const fn desktop() -> Self {
        Self {
            max_payload_bytes: HARD_MAX_SYNC_STATE_PAYLOAD_BYTES,
            max_rows: HARD_MAX_SYNC_STATE_ROWS,
        }
    }

    pub const fn max_payload_bytes(self) -> usize {
        self.max_payload_bytes
    }

    pub const fn max_rows(self) -> usize {
        self.max_rows
    }
}

impl Default for SyncStateLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: DEFAULT_MAX_SYNC_STATE_PAYLOAD_BYTES,
            max_rows: DEFAULT_MAX_SYNC_STATE_ROWS,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SyncStatePayload {
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_epoch_state: Option<KeyEpochState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiga_vault_state: Option<TigaVaultStateRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiga_policy_overrides: Option<Vec<TigaPolicyOverrideRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tiga_policy_exceptions: Option<Vec<TigaPolicyExceptionRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub security_audit_events: Option<Vec<SecurityAuditEventRow>>,
    pub projects: Vec<ProjectRow>,
    pub entries: Vec<EntryRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_relations: Option<Vec<ObjectRelationRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_labels: Option<Vec<ObjectLabelRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_label_assignments: Option<Vec<ObjectLabelAssignmentRow>>,
    pub attachments: Vec<AttachmentRow>,
    pub attachment_chunks: Vec<AttachmentChunkRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_tags: Option<Vec<ProjectTagSetRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tombstones: Option<Vec<TombstoneRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tombstone_acknowledgements: Option<Vec<TombstoneAcknowledgementRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purge_receipts: Option<Vec<PurgeReceiptRow>>,
    pub branches: Vec<BranchRow>,
    /// Unknown non-critical top-level fields from a newer sync-state reader.
    ///
    /// Complete-state payloads are forwarded through older storage versions,
    /// so dropping these fields during a decode/re-encode cycle would strand
    /// newer metadata. Delta wire envelopes intentionally remain strict.
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: BTreeMap<String, serde_json::Value>,
}

// Avoid serde's flattened Value buffering: extension keys are literal JSON,
// including keys that serde uses internally for Number and RawValue.
impl<'de> Deserialize<'de> for SyncStatePayload {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{Error, MapAccess, Visitor};
        use serde_json::value::RawValue;
        struct RawFields;
        impl<'de> Visitor<'de> for RawFields {
            type Value = BTreeMap<String, Box<RawValue>>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a sync state object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut fields = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if fields.insert(key, value).is_some() {
                        return Err(A::Error::custom("duplicate sync state field"));
                    }
                }
                Ok(fields)
            }
        }
        fn take<T: serde::de::DeserializeOwned, E: serde::de::Error>(
            fields: &mut BTreeMap<String, Box<RawValue>>,
            key: &'static str,
            required: bool,
        ) -> Result<T, E> {
            match fields.remove(key) {
                Some(raw) => serde_json::from_str(raw.get()).map_err(E::custom),
                None if required => Err(E::missing_field(key)),
                None => serde_json::from_str("null").map_err(E::custom),
            }
        }
        let mut fields = deserializer.deserialize_map(RawFields)?;
        Ok(Self {
            format: take(&mut fields, "format", true)?,
            key_epoch_state: take(&mut fields, "key_epoch_state", false)?,
            tiga_vault_state: take(&mut fields, "tiga_vault_state", false)?,
            tiga_policy_overrides: take(&mut fields, "tiga_policy_overrides", false)?,
            tiga_policy_exceptions: take(&mut fields, "tiga_policy_exceptions", false)?,
            security_audit_events: take(&mut fields, "security_audit_events", false)?,
            projects: take(&mut fields, "projects", true)?,
            entries: take(&mut fields, "entries", true)?,
            object_relations: take(&mut fields, "object_relations", false)?,
            object_labels: take(&mut fields, "object_labels", false)?,
            object_label_assignments: take(&mut fields, "object_label_assignments", false)?,
            attachments: take(&mut fields, "attachments", true)?,
            attachment_chunks: take(&mut fields, "attachment_chunks", true)?,
            project_tags: take(&mut fields, "project_tags", false)?,
            tombstones: take(&mut fields, "tombstones", false)?,
            tombstone_acknowledgements: take(&mut fields, "tombstone_acknowledgements", false)?,
            purge_receipts: take(&mut fields, "purge_receipts", false)?,
            branches: take(&mut fields, "branches", true)?,
            extensions: fields.into_iter().map(|(key, raw)| {
                mdbx_core::json::from_str(raw.get()).map(|value| (key, value)).map_err(D::Error::custom)
            }).collect::<Result<_, _>>()?,
        })
    }
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyEpochState {
    pub active_key_epoch_id: String,
    pub epochs: Vec<KeyEpochRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeyEpochRow {
    pub key_epoch_id: String,
    pub status: String,
    pub wrapped_epoch_key_ct: Vec<u8>,
    pub kdf_profile_id: String,
    pub created_at: String,
    pub activated_at: Option<String>,
    pub retired_at: Option<String>,
}

#[derive(Serialize)]
struct KeyEpochIntegrityValue<'a> {
    active_key_epoch_id: &'a str,
    epochs: &'a [KeyEpochRow],
}

impl KeyEpochState {
    fn integrity_value(&self) -> KeyEpochIntegrityValue<'_> {
        KeyEpochIntegrityValue {
            active_key_epoch_id: &self.active_key_epoch_id,
            epochs: &self.epochs,
        }
    }

    pub fn verify_integrity(&self, conn: &VaultConnection) -> StorageResult<()> {
        verify_optional_integrity_tag(
            conn,
            b"key-epoch-sync-state-v1",
            &self.integrity_value(),
            self.integrity_tag.as_deref(),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TigaVaultStateRow {
    pub default_tiga_mode: String,
    pub policy_version: u32,
    pub compliance_status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TigaPolicyOverrideRow {
    pub scope_type: String,
    pub scope_id: String,
    pub policy_json: String,
    pub exception_id: Option<String>,
    pub updated_at: String,
    pub updated_by_device_id: String,
    pub integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TigaPolicyExceptionRow {
    pub exception_id: String,
    pub target_scope: String,
    pub target_id: String,
    pub approved_override_json: String,
    pub reason: String,
    pub expires_at_unix_secs: Option<i64>,
    pub created_at: String,
    pub created_by_session_id: Option<String>,
    pub revoked_at: Option<String>,
    pub integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecurityAuditEventRow {
    pub event_id: String,
    pub occurred_at: String,
    pub operation: String,
    pub outcome: String,
    pub scope_type: String,
    pub scope_id: String,
    pub session_id: Option<String>,
    pub device_id: Option<String>,
    pub reason_codes_json: String,
    pub constraints_json: String,
    pub exception_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_fingerprint: Option<Vec<u8>>,
    pub integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_id: String,
    pub title_ct: Vec<u8>,
    pub summary_ct: Option<Vec<u8>>,
    pub group_id: Option<String>,
    pub icon_ref: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub deleted: bool,
    pub tiga_mode_override: Option<String>,
    pub object_clock: String,
    pub head_commit_id: String,
    pub attachment_count: u32,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_profile: Option<CollectionProfileRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionProfileRow {
    pub project_id: String,
    pub collection_type_id: String,
    pub payload_ct: Vec<u8>,
    pub payload_schema_version: u32,
    pub allowed_object_type_ids: Vec<String>,
    pub required_capability_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EntryRow {
    pub entry_id: String,
    pub project_id: String,
    pub entry_type: String,
    pub title_ct: Option<Vec<u8>>,
    pub payload_ct: Vec<u8>,
    pub payload_schema_version: u32,
    pub tiga_mode_override: Option<String>,
    pub object_clock: String,
    pub head_commit_id: String,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectRelationRow {
    pub relation_id: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub relation_kind: String,
    pub payload_ct: Vec<u8>,
    pub payload_schema_version: u32,
    pub object_clock: String,
    pub head_commit_id: String,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelRow {
    pub label_id: String,
    pub collection_id: String,
    pub name_ct: Vec<u8>,
    pub payload_ct: Vec<u8>,
    pub payload_schema_version: u32,
    pub object_clock: String,
    pub head_commit_id: String,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelAssignmentRow {
    pub assignment_id: String,
    pub object_id: String,
    pub label_id: String,
    pub object_clock: String,
    pub head_commit_id: String,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentRow {
    pub attachment_id: String,
    pub project_id: String,
    pub entry_id: Option<String>,
    pub file_name_ct: Vec<u8>,
    pub media_type_ct: Option<Vec<u8>>,
    pub storage_mode: String,
    pub content_hash: String,
    pub original_size: u64,
    pub stored_size: u64,
    pub chunk_count: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentChunkRow {
    pub attachment_id: String,
    pub chunk_index: u32,
    pub chunk_hash: String,
    pub chunk_ct: Option<Vec<u8>>,
    pub external_uri_ct: Option<Vec<u8>>,
    pub stored_size: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectTagSetRow {
    pub project_id: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TombstoneRow {
    pub tombstone_id: String,
    pub target_object_type: String,
    pub target_object_id: String,
    pub delete_clock: String,
    pub deleted_by_device_id: String,
    pub deleted_at: String,
    pub purge_eligible_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delete_commit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TombstoneAcknowledgementRow {
    pub tombstone_id: String,
    pub device_id: String,
    pub observed_commit_id: String,
    pub acknowledged_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PurgeReceiptRow {
    pub purge_id: String,
    pub tombstone_id: String,
    pub target_object_type: String,
    pub target_object_id: String,
    pub delete_commit_id: String,
    pub purge_commit_id: String,
    pub delete_clock: String,
    pub retention_eligible_at: String,
    pub purged_by_device_id: String,
    pub purged_at: String,
    pub integrity_tag: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BranchRow {
    pub branch_id: String,
    pub branch_name: String,
    pub head_commit_id: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn collect_sync_state(conn: &VaultConnection) -> StorageResult<SyncStatePayload> {
    collect_sync_state_with_limits(conn, SyncStateLimits::default())
}

pub fn collect_sync_state_with_limits(
    conn: &VaultConnection,
    limits: SyncStateLimits,
) -> StorageResult<SyncStatePayload> {
    validate_row_limit(count_source_rows(conn)?, limits)?;
    let state = SyncStatePayload {
        format: SYNC_STATE_FORMAT.to_string(),
        extensions: load_sync_state_extensions(conn)?,
        key_epoch_state: Some(load_key_epoch_state(conn)?),
        tiga_vault_state: Some(load_tiga_vault_state(conn)?),
        tiga_policy_overrides: Some(load_tiga_policy_override_rows(conn)?),
        tiga_policy_exceptions: Some(load_tiga_policy_exception_rows(conn)?),
        security_audit_events: Some(load_security_audit_event_rows(conn)?),
        projects: load_project_rows(conn)?,
        entries: load_entry_rows(conn)?,
        object_relations: Some(load_object_relation_rows(conn)?),
        object_labels: Some(load_object_label_rows(conn)?),
        object_label_assignments: Some(load_object_label_assignment_rows(conn)?),
        attachments: load_attachment_rows(conn)?,
        attachment_chunks: load_attachment_chunk_rows(conn)?,
        project_tags: Some(load_project_tag_set_rows(conn)?),
        tombstones: Some(load_tombstone_rows(conn)?),
        tombstone_acknowledgements: Some(load_tombstone_acknowledgement_rows(conn)?),
        purge_receipts: Some(load_purge_receipt_rows(conn)?),
        branches: load_branch_rows(conn)?,
    };
    state.validate_resource_limits(limits)?;
    Ok(state)
}

pub(crate) fn persist_sync_state_extensions(
    conn: &VaultConnection,
    extensions: &BTreeMap<String, serde_json::Value>,
    source_commit_id: &str,
) -> StorageResult<()> {
    validate_sync_state_extension_map(extensions)?;
    if extensions.is_empty() {
        return Ok(());
    }

    let updated_at = chrono::Utc::now().to_rfc3339();
    let mut statement = conn.inner().prepare_cached(
        "INSERT INTO sync_state_extensions
            (extension_key, value_json, source_commit_id, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(extension_key) DO UPDATE SET
            value_json = excluded.value_json,
            source_commit_id = excluded.source_commit_id,
            updated_at = excluded.updated_at",
    )?;
    for (key, value) in extensions {
        let value_json = serde_json::to_vec(value)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        statement.execute(params![key, value_json, source_commit_id, updated_at])?;
    }
    Ok(())
}

pub(crate) fn load_sync_state_extensions(
    conn: &VaultConnection,
) -> StorageResult<BTreeMap<String, serde_json::Value>> {
    let mut statement = conn.inner().prepare(
        "SELECT extension_key, value_json
         FROM sync_state_extensions ORDER BY extension_key ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
    })?;
    let mut extensions = BTreeMap::new();
    for row in rows {
        let (key, value_json) = row?;
        let value = mdbx_core::json::from_slice(&value_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Blob,
                Box::new(error),
            )
        })?;
        extensions.insert(key, value);
    }
    validate_sync_state_extension_map(&extensions)?;
    Ok(extensions)
}

pub(crate) fn load_key_epoch_state(conn: &VaultConnection) -> StorageResult<KeyEpochState> {
    let active_key_epoch_id: String = conn
        .inner()
        .query_row(
            "SELECT active_key_epoch_id FROM vault_meta LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map_err(StorageError::Database)?;
    let mut stmt = conn.inner().prepare(
        "SELECT key_epoch_id, status, wrapped_epoch_key_ct, kdf_profile_id,
                created_at, activated_at, retired_at
         FROM key_epochs ORDER BY key_epoch_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(KeyEpochRow {
            key_epoch_id: row.get(0)?,
            status: row.get(1)?,
            wrapped_epoch_key_ct: row.get(2)?,
            kdf_profile_id: row.get(3)?,
            created_at: row.get(4)?,
            activated_at: row.get(5)?,
            retired_at: row.get(6)?,
        })
    })?;
    let epochs = collect_rows(rows)?;
    let integrity_value = KeyEpochIntegrityValue {
        active_key_epoch_id: &active_key_epoch_id,
        epochs: &epochs,
    };
    let integrity_tag = optional_integrity_tag(conn, b"key-epoch-sync-state-v1", &integrity_value)?;
    if epochs
        .iter()
        .any(|row| row.kdf_profile_id == RANDOM_KEY_EPOCH_PROFILE_ID)
        && integrity_tag.is_none()
    {
        return Err(StorageError::Validation(
            "vault must be unlocked to synchronize random key epochs".to_string(),
        ));
    }
    Ok(KeyEpochState {
        active_key_epoch_id,
        epochs,
        integrity_tag,
    })
}

pub(crate) fn load_tiga_vault_state(conn: &VaultConnection) -> StorageResult<TigaVaultStateRow> {
    conn.inner()
        .query_row(
            "SELECT default_tiga_mode, tiga_policy_version, tiga_compliance_status, updated_at
             FROM vault_meta",
            [],
            |row| {
                Ok(TigaVaultStateRow {
                    default_tiga_mode: row.get(0)?,
                    policy_version: row.get::<_, i64>(1)? as u32,
                    compliance_status: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .map_err(StorageError::Database)
}

pub(crate) fn load_tiga_policy_override_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<TigaPolicyOverrideRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT scope_type, scope_id, policy_json, exception_id, updated_at,
                updated_by_device_id, integrity_tag
         FROM tiga_policy_overrides ORDER BY scope_type, scope_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TigaPolicyOverrideRow {
            scope_type: row.get(0)?,
            scope_id: row.get(1)?,
            policy_json: row.get(2)?,
            exception_id: row.get(3)?,
            updated_at: row.get(4)?,
            updated_by_device_id: row.get(5)?,
            integrity_tag: row.get(6)?,
        })
    })?;
    collect_rows(rows)
}

pub(crate) fn load_tiga_policy_exception_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<TigaPolicyExceptionRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT exception_id, target_scope, target_id, approved_override_json, reason,
                expires_at_unix_secs, created_at, created_by_session_id, revoked_at,
                integrity_tag
         FROM tiga_policy_exceptions ORDER BY created_at, exception_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TigaPolicyExceptionRow {
            exception_id: row.get(0)?,
            target_scope: row.get(1)?,
            target_id: row.get(2)?,
            approved_override_json: row.get(3)?,
            reason: row.get(4)?,
            expires_at_unix_secs: row.get(5)?,
            created_at: row.get(6)?,
            created_by_session_id: row.get(7)?,
            revoked_at: row.get(8)?,
            integrity_tag: row.get(9)?,
        })
    })?;
    collect_rows(rows)
}

pub(crate) fn load_security_audit_event_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<SecurityAuditEventRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT event_id, occurred_at, operation, outcome, scope_type, scope_id,
                session_id, device_id, reason_codes_json, constraints_json,
                exception_id, operation_id, commit_id, policy_version,
                policy_fingerprint, integrity_tag
         FROM security_audit_events ORDER BY occurred_at, event_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SecurityAuditEventRow {
            event_id: row.get(0)?,
            occurred_at: row.get(1)?,
            operation: row.get(2)?,
            outcome: row.get(3)?,
            scope_type: row.get(4)?,
            scope_id: row.get(5)?,
            session_id: row.get(6)?,
            device_id: row.get(7)?,
            reason_codes_json: row.get(8)?,
            constraints_json: row.get(9)?,
            exception_id: row.get(10)?,
            operation_id: row.get(11)?,
            commit_id: row.get(12)?,
            policy_version: row.get::<_, Option<i64>>(13)?.map(|value| value as u32),
            policy_fingerprint: row.get(14)?,
            integrity_tag: row.get(15)?,
        })
    })?;
    collect_rows(rows)
}

fn collect_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
) -> StorageResult<Vec<T>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub fn collect_sync_state_payload(conn: &VaultConnection) -> StorageResult<ObjectPayload> {
    collect_sync_state_payload_with_limits(conn, SyncStateLimits::default())
}

pub fn collect_sync_state_payload_with_limits(
    conn: &VaultConnection,
    limits: SyncStateLimits,
) -> StorageResult<ObjectPayload> {
    let state = collect_sync_state_with_limits(conn, limits)?;
    let ciphertext = serialize_state_bounded(&state, limits)?;
    Ok(ObjectPayload {
        object_type: SYNC_STATE_OBJECT_TYPE.to_string(),
        object_id: SYNC_STATE_OBJECT_ID.to_string(),
        ciphertext,
        associated_data: SYNC_STATE_OBJECT_TYPE.as_bytes().to_vec(),
    })
}

pub fn decode_sync_state_payload(
    payload: &ObjectPayload,
) -> StorageResult<Option<SyncStatePayload>> {
    decode_sync_state_payload_with_limits(payload, SyncStateLimits::default())
}

pub fn decode_sync_state_payload_with_limits(
    payload: &ObjectPayload,
    limits: SyncStateLimits,
) -> StorageResult<Option<SyncStatePayload>> {
    if payload.object_type != SYNC_STATE_OBJECT_TYPE
        && payload.object_type != LEGACY_CLI_SYNC_STATE_OBJECT_TYPE
    {
        return Ok(None);
    }
    if payload.object_id != SYNC_STATE_OBJECT_ID {
        return Err(StorageError::Validation(format!(
            "reserved sync state type {} requires object ID {}",
            payload.object_type, SYNC_STATE_OBJECT_ID
        )));
    }
    if payload.associated_data != payload.object_type.as_bytes() {
        return Err(StorageError::Validation(format!(
            "sync state payload {} has invalid associated data",
            payload.object_type
        )));
    }
    validate_payload_limit(payload.ciphertext.len(), limits)?;

    let state: SyncStatePayload = serde_json::from_slice(&payload.ciphertext)
        .map_err(|e| StorageError::SchemaCreation(e.to_string()))?;
    if state.format != SYNC_STATE_FORMAT
        && state.format != PREVIOUS_SYNC_STATE_FORMAT
        && state.format != LEGACY_CLI_SYNC_STATE_FORMAT
    {
        return Err(StorageError::Validation(format!(
            "unsupported sync state format: {}",
            state.format
        )));
    }
    state.validate_resource_limits(limits)?;
    Ok(Some(state))
}

impl SyncStatePayload {
    pub fn validate_resource_limits(&self, limits: SyncStateLimits) -> StorageResult<()> {
        self.validate_extensions()?;
        validate_row_limit(self.total_rows()?, limits)
    }

    fn validate_extensions(&self) -> StorageResult<()> {
        validate_sync_state_extension_map(&self.extensions)
    }
}

fn validate_sync_state_extension_map(
    extensions: &BTreeMap<String, serde_json::Value>,
) -> StorageResult<()> {
    if extensions.len() > MAX_SYNC_STATE_EXTENSION_FIELDS {
        return Err(StorageError::ResourceLimit {
            resource: "sync state extension fields".to_string(),
            actual: extensions.len() as u64,
            limit: MAX_SYNC_STATE_EXTENSION_FIELDS as u64,
        });
    }
    let mut total_bytes = 0usize;
    for (key, value) in extensions {
        if key.is_empty() || key.len() > MAX_SYNC_STATE_EXTENSION_KEY_BYTES {
            return Err(StorageError::Validation(format!(
                "sync state extension key must contain 1 to {MAX_SYNC_STATE_EXTENSION_KEY_BYTES} bytes"
            )));
        }
        if is_sync_state_known_field(key) {
            return Err(StorageError::Validation(format!(
                "sync state extension cannot shadow known field {key}"
            )));
        }
        validate_extension_value(value, 0)?;
        let encoded = serde_json::to_vec(value)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        total_bytes = total_bytes
            .checked_add(key.len())
            .and_then(|size| size.checked_add(encoded.len()))
            .ok_or_else(|| StorageError::ResourceLimit {
                resource: "sync state extension bytes".to_string(),
                actual: u64::MAX,
                limit: MAX_SYNC_STATE_EXTENSION_BYTES as u64,
            })?;
        if total_bytes > MAX_SYNC_STATE_EXTENSION_BYTES {
            return Err(StorageError::ResourceLimit {
                resource: "sync state extension bytes".to_string(),
                actual: total_bytes as u64,
                limit: MAX_SYNC_STATE_EXTENSION_BYTES as u64,
            });
        }
    }
    Ok(())
}

impl SyncStatePayload {
    pub(crate) fn total_rows(&self) -> StorageResult<usize> {
        let mut total = 0usize;
        let mut add = |count: usize| -> StorageResult<()> {
            total = total
                .checked_add(count)
                .ok_or_else(|| StorageError::ResourceLimit {
                    resource: "sync state rows".to_string(),
                    actual: u64::MAX,
                    limit: HARD_MAX_SYNC_STATE_ROWS as u64,
                })?;
            Ok(())
        };

        if let Some(key_epochs) = &self.key_epoch_state {
            add(key_epochs.epochs.len())?;
        }
        add(usize::from(self.tiga_vault_state.is_some()))?;
        add(self.tiga_policy_overrides.as_ref().map_or(0, Vec::len))?;
        add(self.tiga_policy_exceptions.as_ref().map_or(0, Vec::len))?;
        add(self.security_audit_events.as_ref().map_or(0, Vec::len))?;
        add(self.projects.len())?;
        add(self
            .projects
            .iter()
            .filter(|project| project.collection_profile.is_some())
            .count())?;
        add(self.entries.len())?;
        add(self.object_relations.as_ref().map_or(0, Vec::len))?;
        add(self.object_labels.as_ref().map_or(0, Vec::len))?;
        add(self.object_label_assignments.as_ref().map_or(0, Vec::len))?;
        add(self.attachments.len())?;
        add(self.attachment_chunks.len())?;
        if let Some(tag_sets) = &self.project_tags {
            add(tag_sets.len())?;
            for tag_set in tag_sets {
                add(tag_set.tags.len())?;
            }
        }
        add(self.tombstones.as_ref().map_or(0, Vec::len))?;
        add(self.tombstone_acknowledgements.as_ref().map_or(0, Vec::len))?;
        add(self.purge_receipts.as_ref().map_or(0, Vec::len))?;
        add(self.branches.len())?;
        Ok(total)
    }
}

fn is_sync_state_known_field(field: &str) -> bool {
    matches!(
        field,
        "format"
            | "key_epoch_state"
            | "tiga_vault_state"
            | "tiga_policy_overrides"
            | "tiga_policy_exceptions"
            | "security_audit_events"
            | "projects"
            | "entries"
            | "object_relations"
            | "object_labels"
            | "object_label_assignments"
            | "attachments"
            | "attachment_chunks"
            | "project_tags"
            | "tombstones"
            | "tombstone_acknowledgements"
            | "purge_receipts"
            | "branches"
    )
}

fn validate_extension_value(value: &serde_json::Value, depth: usize) -> StorageResult<()> {
    if depth > MAX_SYNC_STATE_EXTENSION_DEPTH {
        return Err(StorageError::ResourceLimit {
            resource: "sync state extension depth".to_string(),
            actual: depth as u64,
            limit: MAX_SYNC_STATE_EXTENSION_DEPTH as u64,
        });
    }
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                validate_extension_value(value, depth + 1)?;
            }
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                if key.len() > MAX_SYNC_STATE_EXTENSION_KEY_BYTES {
                    return Err(StorageError::Validation(format!(
                        "sync state extension object key exceeds {MAX_SYNC_STATE_EXTENSION_KEY_BYTES} bytes"
                    )));
                }
                validate_extension_value(value, depth + 1)?;
            }
        }
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => {}
    }
    Ok(())
}

fn count_source_rows(conn: &VaultConnection) -> StorageResult<usize> {
    let tables = [
        "key_epochs",
        "tiga_policy_overrides",
        "tiga_policy_exceptions",
        "security_audit_events",
        "projects",
        "collection_profiles",
        "entries",
        "object_relations",
        "object_labels",
        "object_label_assignments",
        "attachments",
        "attachment_chunks",
        "project_tags",
        "tombstones",
        "tombstone_acknowledgements",
        "purge_receipts",
        "branches",
    ];
    let mut total = 1usize;
    for table in tables {
        let count =
            conn.inner()
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get::<_, i64>(0)
                })?;
        let count = usize::try_from(count).map_err(|error| {
            StorageError::Validation(format!("invalid row count for {table}: {error}"))
        })?;
        total = total
            .checked_add(count)
            .ok_or_else(|| StorageError::ResourceLimit {
                resource: "sync state rows".to_string(),
                actual: u64::MAX,
                limit: HARD_MAX_SYNC_STATE_ROWS as u64,
            })?;
    }

    let project_count = conn
        .inner()
        .query_row("SELECT COUNT(*) FROM projects", [], |row| {
            row.get::<_, i64>(0)
        })?;
    let project_count = usize::try_from(project_count)
        .map_err(|error| StorageError::Validation(format!("invalid project row count: {error}")))?;
    total
        .checked_add(project_count)
        .ok_or_else(|| StorageError::ResourceLimit {
            resource: "sync state rows".to_string(),
            actual: u64::MAX,
            limit: HARD_MAX_SYNC_STATE_ROWS as u64,
        })
}

fn validate_payload_limit(actual: usize, limits: SyncStateLimits) -> StorageResult<()> {
    if actual > limits.max_payload_bytes {
        return Err(StorageError::ResourceLimit {
            resource: "sync state payload bytes".to_string(),
            actual: actual as u64,
            limit: limits.max_payload_bytes as u64,
        });
    }
    Ok(())
}

fn validate_row_limit(actual: usize, limits: SyncStateLimits) -> StorageResult<()> {
    if actual > limits.max_rows {
        return Err(StorageError::ResourceLimit {
            resource: "sync state rows".to_string(),
            actual: actual as u64,
            limit: limits.max_rows as u64,
        });
    }
    Ok(())
}

fn serialize_state_bounded(
    state: &SyncStatePayload,
    limits: SyncStateLimits,
) -> StorageResult<Vec<u8>> {
    let mut writer = LimitedVecWriter::new(limits.max_payload_bytes);
    if let Err(error) = serde_json::to_writer(&mut writer, state) {
        if let Some(actual) = writer.exceeded_at {
            return Err(StorageError::ResourceLimit {
                resource: "sync state payload bytes".to_string(),
                actual: actual as u64,
                limit: limits.max_payload_bytes as u64,
            });
        }
        return Err(StorageError::SchemaCreation(error.to_string()));
    }
    Ok(writer.bytes)
}

struct LimitedVecWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded_at: Option<usize>,
}

impl LimitedVecWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            exceeded_at: None,
        }
    }
}

impl Write for LimitedVecWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let actual = self
            .bytes
            .len()
            .checked_add(buffer.len())
            .unwrap_or(usize::MAX);
        if actual > self.limit {
            self.exceeded_at = Some(actual);
            return Err(io::Error::other("sync state payload limit exceeded"));
        }
        self.bytes
            .try_reserve(buffer.len())
            .map_err(|error| io::Error::other(error.to_string()))?;
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn load_project_rows(conn: &VaultConnection) -> StorageResult<Vec<ProjectRow>> {
    let mut profiles = CollectionProfileRepo::load_all_stored(conn)?
        .into_iter()
        .map(|profile| (profile.project_id.clone(), profile))
        .collect::<HashMap<_, _>>();
    let mut stmt = conn.inner().prepare(
        "SELECT project_id, title_ct, summary_ct, group_id, icon_ref,
                favorite, archived, deleted, tiga_mode_override, object_clock,
                head_commit_id, attachment_count, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM projects
         ORDER BY updated_at ASC, project_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        let project_id: String = row.get(0)?;
        let collection_profile = profiles.remove(&project_id);
        Ok(ProjectRow {
            project_id,
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
            collection_profile,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn load_entry_rows(conn: &VaultConnection) -> StorageResult<Vec<EntryRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT entry_id, project_id, entry_type, title_ct, payload_ct,
                payload_schema_version, tiga_mode_override, object_clock,
                head_commit_id, deleted, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM entries
         ORDER BY updated_at ASC, entry_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(EntryRow {
            entry_id: row.get(0)?,
            project_id: row.get(1)?,
            entry_type: row.get(2)?,
            title_ct: row.get(3)?,
            payload_ct: row.get(4)?,
            payload_schema_version: {
                let value = row.get::<_, i64>(5)?;
                u32::try_from(value).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        5,
                        rusqlite::types::Type::Integer,
                        Box::new(error),
                    )
                })?
            },
            tiga_mode_override: row.get(6)?,
            object_clock: row.get(7)?,
            head_commit_id: row.get(8)?,
            deleted: row.get::<_, i32>(9)? != 0,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            created_by_device_id: row.get(12)?,
            updated_by_device_id: row.get(13)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn load_object_relation_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<ObjectRelationRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                payload_ct, payload_schema_version, object_clock, head_commit_id,
                deleted, created_at, updated_at, created_by_device_id,
                updated_by_device_id
         FROM object_relations ORDER BY updated_at ASC, relation_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
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
    })?;
    collect_rows(rows)
}

pub(crate) fn load_object_label_rows(conn: &VaultConnection) -> StorageResult<Vec<ObjectLabelRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                object_clock, head_commit_id, deleted, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM object_labels ORDER BY updated_at ASC, label_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
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
    })?;
    collect_rows(rows)
}

pub(crate) fn load_object_label_assignment_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<ObjectLabelAssignmentRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT assignment_id, object_id, label_id, object_clock, head_commit_id,
                deleted, created_at, updated_at, created_by_device_id,
                updated_by_device_id
         FROM object_label_assignments ORDER BY updated_at ASC, assignment_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
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
    })?;
    collect_rows(rows)
}

pub(crate) fn load_attachment_rows(conn: &VaultConnection) -> StorageResult<Vec<AttachmentRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT attachment_id, project_id, entry_id, file_name_ct,
                media_type_ct, storage_mode, content_hash,
                original_size, stored_size, chunk_count, head_commit_id,
                deleted, created_at, updated_at,
                created_by_device_id, updated_by_device_id
         FROM attachments
         ORDER BY updated_at ASC, attachment_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
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
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
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

pub(crate) fn load_attachment_chunk_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<AttachmentChunkRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT attachment_id, chunk_index, chunk_hash, chunk_ct,
                external_uri_ct, stored_size, created_at
         FROM attachment_chunks
         ORDER BY attachment_id ASC, chunk_index ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AttachmentChunkRow {
            attachment_id: row.get(0)?,
            chunk_index: row.get::<_, i64>(1)? as u32,
            chunk_hash: row.get(2)?,
            chunk_ct: row.get(3)?,
            external_uri_ct: row.get(4)?,
            stored_size: row.get::<_, i64>(5)? as u64,
            created_at: row.get(6)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn load_project_tag_set_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<ProjectTagSetRow>> {
    let mut out = BTreeMap::<String, Vec<String>>::new();
    let mut project_stmt = conn
        .inner()
        .prepare("SELECT project_id FROM projects ORDER BY project_id ASC")?;
    let project_ids = project_stmt.query_map([], |row| row.get::<_, String>(0))?;
    for project_id in project_ids {
        out.insert(project_id?, Vec::new());
    }

    let mut stmt = conn.inner().prepare(
        "SELECT project_id, tag
         FROM project_tags
         ORDER BY project_id ASC, tag ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (project_id, tag) = row?;
        out.entry(project_id).or_default().push(tag);
    }
    Ok(out
        .into_iter()
        .map(|(project_id, tags)| ProjectTagSetRow { project_id, tags })
        .collect())
}

pub(crate) fn load_tombstone_rows(conn: &VaultConnection) -> StorageResult<Vec<TombstoneRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT tombstone_id, target_object_type, target_object_id, delete_clock,
                deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id
         FROM tombstones
         ORDER BY target_object_type ASC, target_object_id ASC, tombstone_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TombstoneRow {
            tombstone_id: row.get(0)?,
            target_object_type: row.get(1)?,
            target_object_id: row.get(2)?,
            delete_clock: row.get(3)?,
            deleted_by_device_id: row.get(4)?,
            deleted_at: row.get(5)?,
            purge_eligible_at: row.get(6)?,
            delete_commit_id: row.get(7)?,
        })
    })?;
    collect_rows(rows)
}

pub(crate) fn load_tombstone_acknowledgement_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<TombstoneAcknowledgementRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT tombstone_id, device_id, observed_commit_id, acknowledged_at
         FROM tombstone_acknowledgements
         ORDER BY tombstone_id ASC, device_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TombstoneAcknowledgementRow {
            tombstone_id: row.get(0)?,
            device_id: row.get(1)?,
            observed_commit_id: row.get(2)?,
            acknowledged_at: row.get(3)?,
        })
    })?;
    collect_rows(rows)
}

pub(crate) fn load_purge_receipt_rows(
    conn: &VaultConnection,
) -> StorageResult<Vec<PurgeReceiptRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT purge_id, tombstone_id, target_object_type, target_object_id,
                delete_commit_id, purge_commit_id, delete_clock,
                retention_eligible_at, purged_by_device_id, purged_at, integrity_tag
         FROM purge_receipts
         ORDER BY purged_at ASC, purge_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PurgeReceiptRow {
            purge_id: row.get(0)?,
            tombstone_id: row.get(1)?,
            target_object_type: row.get(2)?,
            target_object_id: row.get(3)?,
            delete_commit_id: row.get(4)?,
            purge_commit_id: row.get(5)?,
            delete_clock: row.get(6)?,
            retention_eligible_at: row.get(7)?,
            purged_by_device_id: row.get(8)?,
            purged_at: row.get(9)?,
            integrity_tag: row.get(10)?,
        })
    })?;
    collect_rows(rows)
}

pub(crate) fn load_branch_rows(conn: &VaultConnection) -> StorageResult<Vec<BranchRow>> {
    let mut stmt = conn.inner().prepare(
        "SELECT branch_id, branch_name, head_commit_id, created_at, updated_at
         FROM branches
         ORDER BY branch_name ASC, branch_id ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(BranchRow {
            branch_id: row.get(0)?,
            branch_name: row.get(1)?,
            head_commit_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    #[cfg(feature = "derived-search-index")]
    use crate::repo::ProjectRepo;
    use crate::repo::{CommitContext, SnapshotRepo};
    #[cfg(feature = "derived-search-index")]
    use crate::search::SearchService;
    use crate::unlock::UnlockService;

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        (conn, ctx)
    }

    #[test]
    fn sync_state_limits_enforce_positive_hard_bounded_values() {
        assert!(SyncStateLimits::new(0, 1).is_err());
        assert!(SyncStateLimits::new(1, 0).is_err());
        assert!(SyncStateLimits::new(HARD_MAX_SYNC_STATE_PAYLOAD_BYTES + 1, 1).is_err());
        assert!(SyncStateLimits::new(1, HARD_MAX_SYNC_STATE_ROWS + 1).is_err());

        let defaults = SyncStateLimits::default();
        assert_eq!(
            defaults.max_payload_bytes(),
            DEFAULT_MAX_SYNC_STATE_PAYLOAD_BYTES
        );
        assert_eq!(defaults.max_rows(), DEFAULT_MAX_SYNC_STATE_ROWS);
    }

    #[test]
    fn reserved_sync_state_identity_and_associated_data_are_strict() {
        let (conn, _) = setup();
        let payload = collect_sync_state_payload(&conn).unwrap();

        let mut wrong_id = payload.clone();
        wrong_id.object_id = "other".to_string();
        assert!(decode_sync_state_payload(&wrong_id)
            .unwrap_err()
            .to_string()
            .contains("requires object ID"));

        let mut wrong_aad = payload;
        wrong_aad.associated_data = b"other".to_vec();
        assert!(decode_sync_state_payload(&wrong_aad)
            .unwrap_err()
            .to_string()
            .contains("invalid associated data"));

        let unknown = ObjectPayload {
            object_type: "com.example.opaque".to_string(),
            object_id: "other".to_string(),
            ciphertext: vec![0; 64],
            associated_data: Vec::new(),
        };
        assert!(decode_sync_state_payload(&unknown).unwrap().is_none());
    }

    #[test]
    fn sync_state_input_bytes_and_rows_are_rejected_before_apply() {
        let (conn, _) = setup();
        let payload = collect_sync_state_payload(&conn).unwrap();
        let byte_limits = SyncStateLimits::new(payload.ciphertext.len() - 1, 100).unwrap();
        assert!(matches!(
            decode_sync_state_payload_with_limits(&payload, byte_limits),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state payload bytes"
        ));

        let row_limits = SyncStateLimits::new(payload.ciphertext.len(), 2).unwrap();
        assert!(matches!(
            decode_sync_state_payload_with_limits(&payload, row_limits),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state rows"
        ));
    }

    #[test]
    fn outbound_collection_and_serialization_remain_bounded() {
        let (conn, _) = setup();
        let row_limits = SyncStateLimits::new(1024 * 1024, 2).unwrap();
        assert!(matches!(
            collect_sync_state_with_limits(&conn, row_limits),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state rows"
        ));

        let byte_limits = SyncStateLimits::new(32, 100).unwrap();
        assert!(matches!(
            collect_sync_state_payload_with_limits(&conn, byte_limits),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state payload bytes"
        ));

        let mut writer = LimitedVecWriter::new(4);
        writer.write_all(b"1234").unwrap();
        assert!(writer.write_all(b"5").is_err());
        assert_eq!(writer.bytes, b"1234");
    }

    #[test]
    fn literal_extension_keys_and_precise_numbers_survive_state_roundtrip() {
        let (conn, _) = setup();
        let mut state = collect_sync_state(&conn).unwrap();
        let literal = mdbx_core::json::from_str(r#"{"$serde_json::private::Number":"123","nested":{"$serde_json::private::RawValue":"null"},"n":123456789012345678901234567890,"f":1.2345678901234567890123456789}"#).unwrap();
        state.extensions.insert("com.example.future".into(), literal.clone());
        let encoded = serialize_state_bounded(&state, SyncStateLimits::default()).unwrap();
        let decoded: SyncStatePayload = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.extensions["com.example.future"], literal);
        let reencoded = serialize_state_bounded(&decoded, SyncStateLimits::default()).unwrap();
        assert_eq!(encoded, reencoded);
        let duplicate = String::from_utf8(encoded.clone()).unwrap().replacen("{", "{\"format\":\"duplicate\",", 1);
        assert!(serde_json::from_str::<SyncStatePayload>(&duplicate).is_err());
    }

    #[test]
    fn unknown_top_level_fields_survive_sync_state_reencoding() {
        let (conn, _) = setup();
        let mut payload = collect_sync_state_payload(&conn).unwrap();
        let mut encoded: serde_json::Value = serde_json::from_slice(&payload.ciphertext).unwrap();
        encoded.as_object_mut().unwrap().insert(
            "com.example.future-metadata".to_string(),
            serde_json::json!({"revision": 3, "flags": ["a", "b"]}),
        );
        payload.ciphertext = serde_json::to_vec(&encoded).unwrap();

        let decoded = decode_sync_state_payload(&payload).unwrap().unwrap();
        assert_eq!(
            decoded.extensions.get("com.example.future-metadata"),
            Some(&serde_json::json!({"revision": 3, "flags": ["a", "b"]}))
        );

        let reencoded = serialize_state_bounded(&decoded, SyncStateLimits::default()).unwrap();
        let reencoded: serde_json::Value = serde_json::from_slice(&reencoded).unwrap();
        assert_eq!(
            reencoded.get("com.example.future-metadata"),
            encoded.get("com.example.future-metadata")
        );
    }

    #[test]
    fn sync_state_extensions_are_bounded_and_cannot_shadow_known_fields() {
        let (conn, _) = setup();
        let mut state = collect_sync_state(&conn).unwrap();
        state
            .extensions
            .insert("projects".to_string(), serde_json::json!([]));
        assert!(state
            .validate_resource_limits(SyncStateLimits::default())
            .unwrap_err()
            .to_string()
            .contains("cannot shadow known field"));

        state.extensions.clear();
        for index in 0..=MAX_SYNC_STATE_EXTENSION_FIELDS {
            state
                .extensions
                .insert(format!("future-{index}"), serde_json::Value::Null);
        }
        assert!(matches!(
            state.validate_resource_limits(SyncStateLimits::default()),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state extension fields"
        ));

        state.extensions.clear();
        state.extensions.insert(
            "future-large".to_string(),
            serde_json::Value::String("x".repeat(MAX_SYNC_STATE_EXTENSION_BYTES)),
        );
        assert!(matches!(
            state.validate_resource_limits(SyncStateLimits::default()),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state extension bytes"
        ));

        state.extensions.clear();
        let mut nested = serde_json::Value::Null;
        for _ in 0..=MAX_SYNC_STATE_EXTENSION_DEPTH {
            nested = serde_json::Value::Array(vec![nested]);
        }
        state.extensions.insert("future-deep".to_string(), nested);
        assert!(matches!(
            state.validate_resource_limits(SyncStateLimits::default()),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state extension depth"
        ));
    }

    #[cfg(feature = "derived-search-index")]
    #[test]
    fn collect_sync_state_includes_empty_project_tag_sets() {
        let (conn, ctx) = setup();
        let tagged = ProjectRepo::create(&conn, &ctx, "Tagged", None, None).unwrap();
        let empty = ProjectRepo::create(&conn, &ctx, "Empty", None, None).unwrap();
        SearchService::add_tag(&conn, &tagged.project_id, "work").unwrap();

        let state = collect_sync_state(&conn).unwrap();
        let tag_sets = state.project_tags.unwrap();
        let tagged_tags = tag_sets
            .iter()
            .find(|row| row.project_id == tagged.project_id)
            .unwrap();
        let empty_tags = tag_sets
            .iter()
            .find(|row| row.project_id == empty.project_id)
            .unwrap();

        assert_eq!(tagged_tags.tags, vec!["work".to_string()]);
        assert!(empty_tags.tags.is_empty());
    }

    #[test]
    fn collect_sync_state_includes_authenticated_key_epoch_state_when_unlocked() {
        let (mut conn, _) = setup();
        UnlockService::setup_password(&mut conn, "sync epoch password").unwrap();

        let state = collect_sync_state(&conn).unwrap().key_epoch_state.unwrap();
        assert_eq!(state.epochs.len(), 1);
        assert_eq!(state.epochs[0].key_epoch_id, state.active_key_epoch_id);
        assert_eq!(state.epochs[0].status, "active");
        assert!(state.integrity_tag.is_some());
        state.verify_integrity(&conn).unwrap();
    }

    #[test]
    fn sync_state_excludes_local_snapshot_lifecycle_metadata() {
        let (mut conn, ctx) = setup();
        UnlockService::setup_password(&mut conn, "sync snapshot lifecycle password").unwrap();
        let eligible_at = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        let snapshot = SnapshotRepo::create_automatic_snapshot(&conn, &ctx, &eligible_at).unwrap();

        let lifecycle_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM snapshot_lifecycle WHERE snapshot_id = ?1",
                [&snapshot.snapshot_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lifecycle_count, 1);

        let state = collect_sync_state(&conn).unwrap();
        let encoded = serde_json::to_value(&state).unwrap();
        let object = encoded.as_object().unwrap();
        assert!(!object.contains_key("snapshot_lifecycle"));
        assert!(!object.contains_key("snapshots"));
    }

    #[test]
    fn legacy_sync_state_without_key_epochs_still_deserializes() {
        let payload = ObjectPayload {
            object_type: SYNC_STATE_OBJECT_TYPE.to_string(),
            object_id: SYNC_STATE_OBJECT_ID.to_string(),
            ciphertext: serde_json::to_vec(&serde_json::json!({
                "format": SYNC_STATE_FORMAT,
                "projects": [],
                "entries": [],
                "attachments": [],
                "attachment_chunks": [],
                "branches": []
            }))
            .unwrap(),
            associated_data: SYNC_STATE_OBJECT_TYPE.as_bytes().to_vec(),
        };

        let decoded = decode_sync_state_payload(&payload).unwrap().unwrap();
        assert!(decoded.key_epoch_state.is_none());
        assert!(decoded.tombstones.is_none());
        assert!(decoded.tombstone_acknowledgements.is_none());
        assert!(decoded.purge_receipts.is_none());
    }

    #[test]
    fn previous_v1_sync_state_without_collection_profiles_still_deserializes() {
        let payload = ObjectPayload {
            object_type: SYNC_STATE_OBJECT_TYPE.to_string(),
            object_id: SYNC_STATE_OBJECT_ID.to_string(),
            ciphertext: serde_json::to_vec(&serde_json::json!({
                "format": PREVIOUS_SYNC_STATE_FORMAT,
                "projects": [{
                    "project_id": "project-1",
                    "title_ct": [1],
                    "summary_ct": null,
                    "group_id": null,
                    "icon_ref": null,
                    "favorite": false,
                    "archived": false,
                    "deleted": false,
                    "tiga_mode_override": null,
                    "object_clock": "{}",
                    "head_commit_id": "head-1",
                    "attachment_count": 0,
                    "created_at": "2026-07-20T00:00:00Z",
                    "updated_at": "2026-07-20T00:00:00Z",
                    "created_by_device_id": "device-1",
                    "updated_by_device_id": "device-1"
                }],
                "entries": [],
                "attachments": [],
                "attachment_chunks": [],
                "branches": []
            }))
            .unwrap(),
            associated_data: SYNC_STATE_OBJECT_TYPE.as_bytes().to_vec(),
        };

        let decoded = decode_sync_state_payload(&payload).unwrap().unwrap();
        assert_eq!(decoded.projects.len(), 1);
        assert!(decoded.projects[0].collection_profile.is_none());
    }
}
