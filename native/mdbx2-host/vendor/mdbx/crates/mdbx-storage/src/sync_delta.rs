use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};

use mdbx_sync::ObjectPayload;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::sync_state::{
    load_attachment_chunk_rows, load_attachment_rows, load_branch_rows, load_entry_rows,
    load_key_epoch_state, load_object_label_assignment_rows, load_object_label_rows,
    load_object_relation_rows, load_project_rows, load_project_tag_set_rows,
    load_purge_receipt_rows, load_security_audit_event_rows, load_sync_state_extensions,
    load_tiga_policy_exception_rows, load_tiga_policy_override_rows, load_tiga_vault_state,
    load_tombstone_acknowledgement_rows, load_tombstone_rows, SyncStatePayload, SYNC_STATE_FORMAT,
};
use crate::tiga_policy::{optional_integrity_tag, verify_optional_integrity_tag};

pub const SYNC_DELTA_FORMAT: &str = "mdbx-storage-sync-delta-v1";
pub const SYNC_DELTA_OBJECT_TYPE: &str = "mdbx-storage/state-delta-v1";
pub const DEFAULT_MAX_SYNC_DELTA_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_SYNC_DELTA_ROWS: usize = 50_000;
pub const DEFAULT_MAX_SYNC_DELTA_COMMITS: usize = 512;
pub const HARD_MAX_SYNC_DELTA_PAYLOAD_BYTES: usize = 96 * 1024 * 1024;
pub const HARD_MAX_SYNC_DELTA_ROWS: usize = 250_000;
pub const HARD_MAX_SYNC_DELTA_COMMITS: usize = 4_096;
const MAX_SYNC_DELTA_ID_BYTES: usize = 256;
const SYNC_DELTA_BODY_FORMAT: &str = "mdbx-storage-sync-delta-body-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncDeltaLimits {
    max_payload_bytes: usize,
    max_rows: usize,
    max_commits: usize,
}

impl SyncDeltaLimits {
    pub fn new(
        max_payload_bytes: usize,
        max_rows: usize,
        max_commits: usize,
    ) -> StorageResult<Self> {
        validate_configured_limit(
            "sync delta payload bytes",
            max_payload_bytes,
            HARD_MAX_SYNC_DELTA_PAYLOAD_BYTES,
        )?;
        validate_configured_limit("sync delta rows", max_rows, HARD_MAX_SYNC_DELTA_ROWS)?;
        validate_configured_limit(
            "sync delta commits",
            max_commits,
            HARD_MAX_SYNC_DELTA_COMMITS,
        )?;
        Ok(Self {
            max_payload_bytes,
            max_rows,
            max_commits,
        })
    }

    pub const fn max_payload_bytes(self) -> usize {
        self.max_payload_bytes
    }

    pub const fn max_rows(self) -> usize {
        self.max_rows
    }

    pub const fn max_commits(self) -> usize {
        self.max_commits
    }
}

impl Default for SyncDeltaLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: DEFAULT_MAX_SYNC_DELTA_PAYLOAD_BYTES,
            max_rows: DEFAULT_MAX_SYNC_DELTA_ROWS,
            max_commits: DEFAULT_MAX_SYNC_DELTA_COMMITS,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SyncDeltaBatchKind {
    Commit,
    Auxiliary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSyncDeltaEnvelope {
    pub batch_id: String,
    pub batch_kind: SyncDeltaBatchKind,
    pub commit_ids: Vec<String>,
    pub logical_row_count: u32,
    pub payload: Vec<u8>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SyncDeltaEnvelope {
    pub format: String,
    pub batch_id: String,
    pub vault_id: String,
    pub batch_kind: SyncDeltaBatchKind,
    pub commit_ids: Vec<String>,
    pub logical_row_count: u32,
    pub payload: Vec<u8>,
    pub payload_sha256: Vec<u8>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SyncDeltaBody {
    pub format: String,
    pub state: SyncStatePayload,
    pub device_heads: Vec<DeviceHeadRow>,
    pub deletions: Vec<DeletedSyncEntity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeviceHeadRow {
    pub device_id: String,
    pub head_commit_id: String,
    pub last_seen_at: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeletedSyncEntity {
    pub entity_kind: String,
    pub entity_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingMutation {
    pub(crate) mutation_seq: i64,
    pub(crate) entity_kind: String,
    pub(crate) entity_id: String,
    pub(crate) action: String,
}

#[derive(Serialize)]
struct SyncDeltaIntegrityValue<'a> {
    format: &'a str,
    batch_id: &'a str,
    vault_id: &'a str,
    batch_kind: SyncDeltaBatchKind,
    commit_ids: &'a [String],
    logical_row_count: u32,
    payload_sha256: &'a [u8],
    payload: &'a [u8],
    created_at: &'a str,
}

impl SyncDeltaEnvelope {
    pub fn new(
        conn: &VaultConnection,
        input: NewSyncDeltaEnvelope,
        limits: SyncDeltaLimits,
    ) -> StorageResult<Self> {
        let vault_id = load_vault_id(conn)?;
        let payload_sha256 = Sha256::digest(&input.payload).to_vec();
        let mut envelope = Self {
            format: SYNC_DELTA_FORMAT.to_string(),
            batch_id: input.batch_id,
            vault_id,
            batch_kind: input.batch_kind,
            commit_ids: input.commit_ids,
            logical_row_count: input.logical_row_count,
            payload: input.payload,
            payload_sha256,
            created_at: input.created_at,
            integrity_tag: None,
        };
        envelope.validate_structure(limits)?;
        envelope.integrity_tag = optional_integrity_tag(
            conn,
            b"mdbx-sync-delta-envelope-v1",
            &envelope.integrity_value(),
        )?;
        Ok(envelope)
    }

    pub fn encode(&self, limits: SyncDeltaLimits) -> StorageResult<Vec<u8>> {
        self.validate_structure(limits)?;
        let mut writer = LimitedWriter::new(Vec::new(), limits.max_payload_bytes);
        serde_json::to_writer(&mut writer, self).map_err(|error| {
            writer
                .limit_error()
                .unwrap_or_else(|| StorageError::SchemaCreation(error.to_string()))
        })?;
        Ok(writer.inner)
    }

    // The wire envelope serializes payload bytes again as a JSON integer array.
    // Validate it before commit, without allocating another encoded copy.
    fn validate_encoded_size(&self, limits: SyncDeltaLimits) -> StorageResult<()> {
        let mut writer = LimitedWriter::new(io::sink(), limits.max_payload_bytes);
        serde_json::to_writer(&mut writer, self).map_err(|error| {
            writer
                .limit_error()
                .unwrap_or_else(|| StorageError::SchemaCreation(error.to_string()))
        })
    }

    pub fn decode(bytes: &[u8], limits: SyncDeltaLimits) -> StorageResult<Self> {
        validate_actual_limit(
            "sync delta payload bytes",
            bytes.len(),
            limits.max_payload_bytes,
        )?;
        let envelope: Self = serde_json::from_slice(bytes)
            .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
        envelope.validate_structure(limits)?;
        Ok(envelope)
    }

    pub fn verify(&self, conn: &VaultConnection, limits: SyncDeltaLimits) -> StorageResult<()> {
        self.validate_structure(limits)?;
        if self.vault_id != load_vault_id(conn)? {
            return Err(StorageError::Validation(
                "sync delta belongs to a different vault".to_string(),
            ));
        }
        verify_optional_integrity_tag(
            conn,
            b"mdbx-sync-delta-envelope-v1",
            &self.integrity_value(),
            self.integrity_tag.as_deref(),
        )
    }

    fn integrity_value(&self) -> SyncDeltaIntegrityValue<'_> {
        SyncDeltaIntegrityValue {
            format: &self.format,
            batch_id: &self.batch_id,
            vault_id: &self.vault_id,
            batch_kind: self.batch_kind,
            commit_ids: &self.commit_ids,
            logical_row_count: self.logical_row_count,
            payload_sha256: &self.payload_sha256,
            payload: &self.payload,
            created_at: &self.created_at,
        }
    }

    fn validate_structure(&self, limits: SyncDeltaLimits) -> StorageResult<()> {
        if self.format != SYNC_DELTA_FORMAT {
            return Err(StorageError::Validation(format!(
                "unsupported sync delta format: {}",
                self.format
            )));
        }
        validate_id("batch ID", &self.batch_id)?;
        validate_id("vault ID", &self.vault_id)?;
        validate_id("created_at", &self.created_at)?;
        validate_actual_limit(
            "sync delta payload bytes",
            self.payload.len(),
            limits.max_payload_bytes,
        )?;
        validate_actual_limit(
            "sync delta rows",
            self.logical_row_count as usize,
            limits.max_rows,
        )?;
        validate_actual_limit(
            "sync delta commits",
            self.commit_ids.len(),
            limits.max_commits,
        )?;
        match self.batch_kind {
            SyncDeltaBatchKind::Commit if self.commit_ids.is_empty() => {
                return Err(StorageError::Validation(
                    "commit sync delta must reference at least one commit".to_string(),
                ));
            }
            SyncDeltaBatchKind::Auxiliary if !self.commit_ids.is_empty() => {
                return Err(StorageError::Validation(
                    "auxiliary sync delta cannot reference commits".to_string(),
                ));
            }
            _ => {}
        }
        let mut unique = std::collections::HashSet::new();
        for commit_id in &self.commit_ids {
            validate_id("commit ID", commit_id)?;
            if !unique.insert(commit_id) {
                return Err(StorageError::Validation(
                    "sync delta contains duplicate commit IDs".to_string(),
                ));
            }
        }
        let expected_digest = Sha256::digest(&self.payload);
        if self.payload_sha256.as_slice() != expected_digest.as_slice() {
            return Err(StorageError::Validation(
                "sync delta payload digest mismatch".to_string(),
            ));
        }
        if self
            .integrity_tag
            .as_ref()
            .is_some_and(|tag| tag.len() != 32)
        {
            return Err(StorageError::Validation(
                "sync delta integrity tag must be 32 bytes".to_string(),
            ));
        }
        Ok(())
    }
}

pub(crate) fn materialize_pending_sync_delta(
    conn: &VaultConnection,
    limits: SyncDeltaLimits,
) -> StorageResult<Option<SyncDeltaEnvelope>> {
    let mutations = load_pending_mutations(conn)?;
    let Some(last_mutation_seq) = mutations.last().map(|row| row.mutation_seq) else {
        return Ok(None);
    };
    let latest = deduplicate_mutations(&mutations);
    let commit_ids = ordered_commit_ids(conn, selected_ids(&latest, "commit"))?;
    let body = collect_delta_body(conn, &latest)?;
    let logical_row_count = body.total_rows()?;
    validate_actual_limit("sync delta rows", logical_row_count, limits.max_rows)?;
    let payload = serialize_body_bounded(&body, limits.max_payload_bytes)?;
    let batch_kind = if commit_ids.is_empty() {
        SyncDeltaBatchKind::Auxiliary
    } else {
        SyncDeltaBatchKind::Commit
    };
    let envelope = SyncDeltaEnvelope::new(
        conn,
        NewSyncDeltaEnvelope {
            batch_id: uuid::Uuid::new_v4().to_string(),
            batch_kind,
            commit_ids,
            logical_row_count: u32::try_from(logical_row_count).map_err(|error| {
                StorageError::Validation(format!("sync delta row count overflow: {error}"))
            })?,
            payload,
            created_at: chrono::Utc::now().to_rfc3339(),
        },
        limits,
    )?;
    envelope.validate_encoded_size(limits)?;
    persist_envelope(conn, &envelope)?;
    crate::integrity_root::apply_sync_delta(conn, &envelope, &body, &latest)?;
    conn.inner().execute(
        "DELETE FROM sync_delta_mutations WHERE mutation_seq <= ?1",
        [last_mutation_seq],
    )?;
    Ok(Some(envelope))
}

pub fn decode_sync_delta_body(
    envelope: &SyncDeltaEnvelope,
    limits: SyncDeltaLimits,
) -> StorageResult<SyncDeltaBody> {
    validate_actual_limit(
        "sync delta payload bytes",
        envelope.payload.len(),
        limits.max_payload_bytes,
    )?;
    let body: SyncDeltaBody = serde_json::from_slice(&envelope.payload)
        .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
    if body.format != SYNC_DELTA_BODY_FORMAT {
        return Err(StorageError::Validation(format!(
            "unsupported sync delta body format: {}",
            body.format
        )));
    }
    let rows = body.total_rows()?;
    validate_actual_limit("sync delta rows", rows, limits.max_rows)?;
    if rows != envelope.logical_row_count as usize {
        return Err(StorageError::Validation(
            "sync delta logical row count mismatch".to_string(),
        ));
    }
    Ok(body)
}

pub fn sync_delta_object_payload(
    envelope: &SyncDeltaEnvelope,
    limits: SyncDeltaLimits,
) -> StorageResult<ObjectPayload> {
    Ok(ObjectPayload {
        object_type: SYNC_DELTA_OBJECT_TYPE.to_string(),
        object_id: envelope.batch_id.clone(),
        ciphertext: envelope.encode(limits)?,
        associated_data: delta_associated_data(&envelope.batch_id),
    })
}

pub fn decode_sync_delta_object_payload(
    conn: &VaultConnection,
    payload: &ObjectPayload,
    limits: SyncDeltaLimits,
) -> StorageResult<Option<SyncDeltaEnvelope>> {
    if payload.object_type != SYNC_DELTA_OBJECT_TYPE {
        return Ok(None);
    }
    validate_id("batch ID", &payload.object_id)?;
    if payload.associated_data != delta_associated_data(&payload.object_id) {
        return Err(StorageError::Validation(
            "sync delta object payload has invalid associated data".to_string(),
        ));
    }
    let envelope = SyncDeltaEnvelope::decode(&payload.ciphertext, limits)?;
    if envelope.batch_id != payload.object_id {
        return Err(StorageError::Validation(
            "sync delta object ID does not match its envelope".to_string(),
        ));
    }
    envelope.verify(conn, limits)?;
    Ok(Some(envelope))
}

fn delta_associated_data(batch_id: &str) -> Vec<u8> {
    let mut value = Vec::with_capacity(SYNC_DELTA_OBJECT_TYPE.len() + batch_id.len() + 1);
    value.extend_from_slice(SYNC_DELTA_OBJECT_TYPE.as_bytes());
    value.push(0);
    value.extend_from_slice(batch_id.as_bytes());
    value
}

pub fn load_sync_delta_envelope(
    conn: &VaultConnection,
    batch_id: &str,
    limits: SyncDeltaLimits,
) -> StorageResult<Option<SyncDeltaEnvelope>> {
    let stored = conn
        .inner()
        .query_row(
            "SELECT format, vault_id, batch_kind, logical_row_count, payload,
                    payload_sha256, created_at, integrity_tag
             FROM sync_delta_batches WHERE batch_id = ?1",
            [batch_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        format,
        vault_id,
        batch_kind,
        logical_row_count,
        payload,
        payload_sha256,
        created_at,
        integrity_tag,
    )) = stored
    else {
        return Ok(None);
    };
    let mut stmt = conn.inner().prepare(
        "SELECT commit_id FROM sync_delta_batch_commits
         WHERE batch_id = ?1 ORDER BY commit_ordinal",
    )?;
    let commit_ids = stmt
        .query_map([batch_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let envelope = SyncDeltaEnvelope {
        format,
        batch_id: batch_id.to_string(),
        vault_id,
        batch_kind: match batch_kind.as_str() {
            "commit" => SyncDeltaBatchKind::Commit,
            "auxiliary" => SyncDeltaBatchKind::Auxiliary,
            value => {
                return Err(StorageError::Validation(format!(
                    "invalid stored sync delta batch kind: {value}"
                )))
            }
        },
        commit_ids,
        logical_row_count: u32::try_from(logical_row_count).map_err(|error| {
            StorageError::Validation(format!("invalid stored sync delta row count: {error}"))
        })?,
        payload,
        payload_sha256,
        created_at,
        integrity_tag,
    };
    envelope.verify(conn, limits)?;
    Ok(Some(envelope))
}

impl SyncDeltaBody {
    fn total_rows(&self) -> StorageResult<usize> {
        self.state
            .total_rows()?
            .checked_add(self.device_heads.len())
            .and_then(|value| value.checked_add(self.deletions.len()))
            .ok_or_else(|| StorageError::ResourceLimit {
                resource: "sync delta rows".to_string(),
                actual: u64::MAX,
                limit: HARD_MAX_SYNC_DELTA_ROWS as u64,
            })
    }
}

fn load_pending_mutations(conn: &VaultConnection) -> StorageResult<Vec<PendingMutation>> {
    let mut stmt = conn.inner().prepare(
        "SELECT mutation_seq, entity_kind, entity_id, action
         FROM sync_delta_mutations ORDER BY mutation_seq",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PendingMutation {
            mutation_seq: row.get(0)?,
            entity_kind: row.get(1)?,
            entity_id: row.get(2)?,
            action: row.get(3)?,
        })
    })?;
    rows.map(|row| row.map_err(StorageError::Database))
        .collect()
}

pub(crate) fn deduplicate_mutations(
    mutations: &[PendingMutation],
) -> BTreeMap<(String, String), PendingMutation> {
    let mut latest = BTreeMap::new();
    for mutation in mutations {
        latest.insert(
            (mutation.entity_kind.clone(), mutation.entity_id.clone()),
            mutation.clone(),
        );
    }
    latest
}

fn selected_ids(
    mutations: &BTreeMap<(String, String), PendingMutation>,
    entity_kind: &str,
) -> BTreeSet<String> {
    mutations
        .values()
        .filter(|mutation| mutation.entity_kind == entity_kind)
        .map(|mutation| mutation.entity_id.clone())
        .collect()
}

fn ordered_commit_ids(
    conn: &VaultConnection,
    commit_ids: BTreeSet<String>,
) -> StorageResult<Vec<String>> {
    let mut ordered = Vec::with_capacity(commit_ids.len());
    for commit_id in commit_ids {
        let sequence = conn
            .inner()
            .query_row(
                "SELECT inventory_seq FROM commit_inventory WHERE commit_id = ?1",
                [&commit_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .ok_or_else(|| {
                StorageError::Validation(format!(
                    "sync delta commit {commit_id} is missing from commit inventory"
                ))
            })?;
        ordered.push((sequence, commit_id));
    }
    ordered.sort_by_key(|(sequence, _)| *sequence);
    Ok(ordered
        .into_iter()
        .map(|(_, commit_id)| commit_id)
        .collect())
}

fn collect_delta_body(
    conn: &VaultConnection,
    mutations: &BTreeMap<(String, String), PendingMutation>,
) -> StorageResult<SyncDeltaBody> {
    let project_ids = selected_ids(mutations, "project")
        .into_iter()
        .chain(selected_ids(mutations, "collection-profile"))
        .collect::<BTreeSet<_>>();
    let entry_ids = selected_ids(mutations, "entry");
    let relation_ids = selected_ids(mutations, "object-relation");
    let label_ids = selected_ids(mutations, "object-label");
    let assignment_ids = selected_ids(mutations, "object-label-assignment");
    let attachment_ids = selected_ids(mutations, "attachment");
    let tag_project_ids = selected_ids(mutations, "project-tags");
    let tombstone_ids = selected_ids(mutations, "tombstone");
    let acknowledgement_ids = selected_ids(mutations, "tombstone-ack");
    let purge_ids = selected_ids(mutations, "purge-receipt");
    let branch_ids = selected_ids(mutations, "branch");
    let device_ids = selected_ids(mutations, "device-head");
    let override_ids = selected_ids(mutations, "tiga-override");
    let exception_ids = selected_ids(mutations, "tiga-exception");
    let audit_ids = selected_ids(mutations, "security-audit");
    let extension_ids = selected_ids(mutations, "sync-extension");

    let extensions = if extension_ids.is_empty() {
        BTreeMap::new()
    } else {
        load_sync_state_extensions(conn)?
            .into_iter()
            .filter(|(key, _)| extension_ids.contains(key))
            .collect()
    };

    let state = SyncStatePayload {
        format: SYNC_STATE_FORMAT.to_string(),
        extensions,
        key_epoch_state: if selected_ids(mutations, "key-epochs").is_empty() {
            None
        } else {
            Some(load_key_epoch_state(conn)?)
        },
        tiga_vault_state: if selected_ids(mutations, "vault-meta").is_empty() {
            None
        } else {
            Some(load_tiga_vault_state(conn)?)
        },
        tiga_policy_overrides: load_selected(
            !override_ids.is_empty(),
            || load_tiga_policy_override_rows(conn),
            |row| override_ids.contains(&compound_id(&row.scope_type, &row.scope_id)),
        )?,
        tiga_policy_exceptions: load_selected(
            !exception_ids.is_empty(),
            || load_tiga_policy_exception_rows(conn),
            |row| exception_ids.contains(&row.exception_id),
        )?,
        security_audit_events: load_selected(
            !audit_ids.is_empty(),
            || load_security_audit_event_rows(conn),
            |row| audit_ids.contains(&row.event_id),
        )?,
        projects: load_selected_rows(
            !project_ids.is_empty(),
            || load_project_rows(conn),
            |row| project_ids.contains(&row.project_id),
        )?,
        entries: load_selected_rows(
            !entry_ids.is_empty(),
            || load_entry_rows(conn),
            |row| entry_ids.contains(&row.entry_id),
        )?,
        object_relations: load_selected(
            !relation_ids.is_empty(),
            || load_object_relation_rows(conn),
            |row| relation_ids.contains(&row.relation_id),
        )?,
        object_labels: load_selected(
            !label_ids.is_empty(),
            || load_object_label_rows(conn),
            |row| label_ids.contains(&row.label_id),
        )?,
        object_label_assignments: load_selected(
            !assignment_ids.is_empty(),
            || load_object_label_assignment_rows(conn),
            |row| assignment_ids.contains(&row.assignment_id),
        )?,
        attachments: load_selected_rows(
            !attachment_ids.is_empty(),
            || load_attachment_rows(conn),
            |row| attachment_ids.contains(&row.attachment_id),
        )?,
        attachment_chunks: load_selected_rows(
            !attachment_ids.is_empty(),
            || load_attachment_chunk_rows(conn),
            |row| attachment_ids.contains(&row.attachment_id),
        )?,
        project_tags: load_selected(
            !tag_project_ids.is_empty(),
            || load_project_tag_set_rows(conn),
            |row| tag_project_ids.contains(&row.project_id),
        )?,
        tombstones: load_selected(
            !tombstone_ids.is_empty(),
            || load_tombstone_rows(conn),
            |row| tombstone_ids.contains(&row.tombstone_id),
        )?,
        tombstone_acknowledgements: load_selected(
            !acknowledgement_ids.is_empty(),
            || load_tombstone_acknowledgement_rows(conn),
            |row| acknowledgement_ids.contains(&compound_id(&row.tombstone_id, &row.device_id)),
        )?,
        purge_receipts: load_selected(
            !purge_ids.is_empty(),
            || load_purge_receipt_rows(conn),
            |row| purge_ids.contains(&row.purge_id),
        )?,
        branches: load_selected_rows(
            !branch_ids.is_empty(),
            || load_branch_rows(conn),
            |row| branch_ids.contains(&row.branch_id),
        )?,
    };
    let device_heads = load_device_heads(conn, &device_ids)?;
    let deletions = mutations
        .values()
        .filter(|mutation| mutation.action == "delete")
        .map(|mutation| DeletedSyncEntity {
            entity_kind: mutation.entity_kind.clone(),
            entity_id: mutation.entity_id.clone(),
        })
        .collect();
    Ok(SyncDeltaBody {
        format: SYNC_DELTA_BODY_FORMAT.to_string(),
        state,
        device_heads,
        deletions,
    })
}

fn load_selected<T>(
    selected: bool,
    load: impl FnOnce() -> StorageResult<Vec<T>>,
    keep: impl Fn(&T) -> bool,
) -> StorageResult<Option<Vec<T>>> {
    if !selected {
        return Ok(None);
    }
    Ok(Some(load()?.into_iter().filter(keep).collect()))
}

fn load_selected_rows<T>(
    selected: bool,
    load: impl FnOnce() -> StorageResult<Vec<T>>,
    keep: impl Fn(&T) -> bool,
) -> StorageResult<Vec<T>> {
    if !selected {
        return Ok(Vec::new());
    }
    Ok(load()?.into_iter().filter(keep).collect())
}

fn compound_id(first: &str, second: &str) -> String {
    format!("{first}\u{1f}{second}")
}

fn load_device_heads(
    conn: &VaultConnection,
    device_ids: &BTreeSet<String>,
) -> StorageResult<Vec<DeviceHeadRow>> {
    let mut rows = Vec::new();
    for device_id in device_ids {
        if let Some(row) = conn
            .inner()
            .query_row(
                "SELECT device_id, head_commit_id, last_seen_at, revoked
                 FROM device_heads WHERE device_id = ?1",
                [device_id],
                |row| {
                    Ok(DeviceHeadRow {
                        device_id: row.get(0)?,
                        head_commit_id: row.get(1)?,
                        last_seen_at: row.get(2)?,
                        revoked: row.get::<_, i32>(3)? != 0,
                    })
                },
            )
            .optional()?
        {
            rows.push(row);
        }
    }
    Ok(rows)
}

fn serialize_body_bounded(body: &SyncDeltaBody, limit: usize) -> StorageResult<Vec<u8>> {
    let mut writer = LimitedWriter::new(Vec::new(), limit);
    serde_json::to_writer(&mut writer, body).map_err(|error| {
        writer
            .limit_error()
            .unwrap_or_else(|| StorageError::SchemaCreation(error.to_string()))
    })?;
    Ok(writer.inner)
}

pub(crate) fn persist_envelope(
    conn: &VaultConnection,
    envelope: &SyncDeltaEnvelope,
) -> StorageResult<()> {
    conn.inner().execute(
        "INSERT INTO sync_delta_batches
            (batch_id, vault_id, format, batch_kind, logical_row_count, payload,
             payload_sha256, created_at, integrity_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            envelope.batch_id,
            envelope.vault_id,
            envelope.format,
            match envelope.batch_kind {
                SyncDeltaBatchKind::Commit => "commit",
                SyncDeltaBatchKind::Auxiliary => "auxiliary",
            },
            i64::from(envelope.logical_row_count),
            envelope.payload,
            envelope.payload_sha256,
            envelope.created_at,
            envelope.integrity_tag,
        ],
    )?;
    for (ordinal, commit_id) in envelope.commit_ids.iter().enumerate() {
        conn.inner().execute(
            "INSERT INTO sync_delta_batch_commits (batch_id, commit_ordinal, commit_id)
             VALUES (?1, ?2, ?3)",
            params![envelope.batch_id, ordinal as i64, commit_id],
        )?;
    }
    Ok(())
}

fn load_vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::Database)
}

fn validate_id(name: &str, value: &str) -> StorageResult<()> {
    if value.trim().is_empty() || value.len() > MAX_SYNC_DELTA_ID_BYTES {
        return Err(StorageError::Validation(format!(
            "sync delta {name} must contain between 1 and {MAX_SYNC_DELTA_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_configured_limit(name: &str, actual: usize, hard: usize) -> StorageResult<()> {
    if actual == 0 || actual > hard {
        return Err(StorageError::Validation(format!(
            "{name} limit must be between 1 and {hard}"
        )));
    }
    Ok(())
}

fn validate_actual_limit(name: &str, actual: usize, limit: usize) -> StorageResult<()> {
    if actual > limit {
        return Err(StorageError::ResourceLimit {
            resource: name.to_string(),
            actual: actual as u64,
            limit: limit as u64,
        });
    }
    Ok(())
}

struct LimitedWriter<W> {
    inner: W,
    written: usize,
    limit: usize,
    exceeded_at: Option<usize>,
}

impl<W> LimitedWriter<W> {
    fn new(inner: W, limit: usize) -> Self {
        Self {
            inner,
            written: 0,
            limit,
            exceeded_at: None,
        }
    }

    fn limit_error(&self) -> Option<StorageError> {
        self.exceeded_at.map(|actual| StorageError::ResourceLimit {
            resource: "sync delta payload bytes".to_string(),
            actual: actual as u64,
            limit: self.limit as u64,
        })
    }
}

impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let actual = self.written.checked_add(buffer.len()).unwrap_or(usize::MAX);
        if actual > self.limit {
            self.exceeded_at = Some(actual);
            return Err(io::Error::other("sync delta payload limit exceeded"));
        }
        let written = self.inner.write(buffer)?;
        self.written += written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{AttachmentRepo, CommitContext, ProjectRepo};

    fn setup() -> VaultConnection {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn
    }

    fn latest_envelope(conn: &VaultConnection) -> SyncDeltaEnvelope {
        let batch_id: String = conn
            .inner()
            .query_row(
                "SELECT batch_id FROM sync_delta_batches ORDER BY batch_seq DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        load_sync_delta_envelope(conn, &batch_id, SyncDeltaLimits::default())
            .unwrap()
            .unwrap()
    }

    #[test]
    fn sync_delta_envelope_round_trips_and_detects_payload_tampering() {
        let conn = setup();
        let limits = SyncDeltaLimits::default();
        let envelope = SyncDeltaEnvelope::new(
            &conn,
            NewSyncDeltaEnvelope {
                batch_id: "batch-1".to_string(),
                batch_kind: SyncDeltaBatchKind::Commit,
                commit_ids: vec!["commit-1".to_string()],
                logical_row_count: 2,
                payload: b"bounded delta body".to_vec(),
                created_at: "2026-07-20T00:00:00Z".to_string(),
            },
            limits,
        )
        .unwrap();
        let encoded = envelope.encode(limits).unwrap();
        let exact = SyncDeltaLimits::new(encoded.len(), 50_000, 512).unwrap();
        let short = SyncDeltaLimits::new(encoded.len() - 1, 50_000, 512).unwrap();
        envelope.validate_encoded_size(exact).unwrap();
        assert!(envelope.validate_encoded_size(short).is_err());
        let decoded = SyncDeltaEnvelope::decode(&encoded, limits).unwrap();
        decoded.verify(&conn, limits).unwrap();

        let mut tampered = decoded;
        tampered.payload[0] ^= 1;
        assert!(tampered.verify(&conn, limits).is_err());
    }

    #[test]
    fn sync_delta_enforces_kind_and_resource_limits() {
        let conn = setup();
        let limits = SyncDeltaLimits::new(8, 1, 1).unwrap();
        let oversized = SyncDeltaEnvelope::new(
            &conn,
            NewSyncDeltaEnvelope {
                batch_id: "batch-2".to_string(),
                batch_kind: SyncDeltaBatchKind::Commit,
                commit_ids: vec!["commit-1".to_string()],
                logical_row_count: 1,
                payload: vec![0; 9],
                created_at: "2026-07-20T00:00:00Z".to_string(),
            },
            limits,
        )
        .unwrap_err();
        assert!(matches!(oversized, StorageError::ResourceLimit { .. }));

        let invalid = SyncDeltaEnvelope::new(
            &conn,
            NewSyncDeltaEnvelope {
                batch_id: "batch-3".to_string(),
                batch_kind: SyncDeltaBatchKind::Auxiliary,
                commit_ids: vec!["commit-1".to_string()],
                logical_row_count: 0,
                payload: Vec::new(),
                created_at: "2026-07-20T00:00:00Z".to_string(),
            },
            SyncDeltaLimits::default(),
        )
        .unwrap_err();
        assert!(invalid.to_string().contains("cannot reference commits"));
    }

    #[test]
    fn sync_delta_collect_materializes_only_changed_project_state() {
        let conn = setup();
        let ctx = CommitContext::new("delta-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Delta project", None, None).unwrap();

        let envelope = latest_envelope(&conn);
        assert_eq!(envelope.batch_kind, SyncDeltaBatchKind::Commit);
        assert_eq!(envelope.commit_ids, vec![project.head_commit_id.clone()]);
        let body = decode_sync_delta_body(&envelope, SyncDeltaLimits::default()).unwrap();
        assert_eq!(body.state.projects.len(), 1);
        assert_eq!(body.state.projects[0].project_id, project.project_id);
        assert!(body.state.entries.is_empty());
        assert!(body.state.attachments.is_empty());
        assert_eq!(body.state.branches.len(), 1);
        assert_eq!(body.device_heads.len(), 1);
        assert!(body.deletions.is_empty());
        let pending: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM sync_delta_mutations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(pending, 0);
    }

    #[test]
    fn sync_delta_collect_keeps_complete_attachment_chunk_replacement() {
        let conn = setup();
        let ctx = CommitContext::new("delta-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Delta project", None, None).unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "delta.bin",
            None,
            "",
            0,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(
            &conn,
            &ctx,
            &attachment.attachment_id,
            b"replacement",
        )
        .unwrap();

        let envelope = latest_envelope(&conn);
        let body = decode_sync_delta_body(&envelope, SyncDeltaLimits::default()).unwrap();
        assert_eq!(body.state.attachments.len(), 1);
        assert_eq!(body.state.attachment_chunks.len(), 1);
        assert_eq!(
            body.state.attachment_chunks[0].attachment_id,
            attachment.attachment_id
        );
        assert!(body.state.projects.is_empty());
        assert!(body.state.entries.is_empty());
    }

    #[test]
    fn sync_delta_collect_creates_auxiliary_batch_for_audit_only_transaction() {
        let conn = setup();
        conn.with_immediate_transaction(|| {
            conn.inner().execute(
                "INSERT INTO security_audit_events
                    (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                     reason_codes_json, constraints_json)
                 VALUES ('aux-audit', '2026-07-20T00:00:00Z', 'copy-secret', 'deny',
                         'vault', '', '[]', '[]')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        let envelope = latest_envelope(&conn);
        assert_eq!(envelope.batch_kind, SyncDeltaBatchKind::Auxiliary);
        assert!(envelope.commit_ids.is_empty());
        let body = decode_sync_delta_body(&envelope, SyncDeltaLimits::default()).unwrap();
        let events = body.state.security_audit_events.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, "aux-audit");
        assert!(body.state.projects.is_empty());
    }

    #[test]
    fn sync_delta_collect_limit_failure_rolls_back_state_and_batch() {
        let conn = setup();
        let limits = SyncDeltaLimits::new(1024 * 1024, 1, 1).unwrap();
        let error = conn
            .with_immediate_transaction_and_sync_limits(limits, || {
                for event_id in ["limited-audit-1", "limited-audit-2"] {
                    conn.inner().execute(
                        "INSERT INTO security_audit_events
                            (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                             reason_codes_json, constraints_json)
                         VALUES (?1, '2026-07-20T00:00:00Z', 'copy-secret', 'deny',
                                 'vault', '', '[]', '[]')",
                        [event_id],
                    )?;
                }
                Ok(())
            })
            .unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit { resource, .. } if resource == "sync delta rows"
        ));
        let counts: (i64, i64, i64) = conn
            .inner()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM security_audit_events),
                    (SELECT COUNT(*) FROM sync_delta_batches),
                    (SELECT COUNT(*) FROM sync_delta_mutations)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (0, 0, 0));
    }

    #[test]
    fn sync_delta_collect_covers_every_core_state_family() {
        let conn = setup();
        conn.with_immediate_transaction(|| {
            conn.inner().execute_batch(
                "INSERT INTO projects
                    (project_id, title_ct, favorite, archived, deleted, object_clock,
                     head_commit_id, attachment_count, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                 VALUES ('project-all', X'01', 0, 0, 0, '{}',
                         (SELECT commit_id FROM commits LIMIT 1), 1,
                         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO collection_profiles
                    (project_id, collection_type_id, payload_ct, payload_schema_version,
                     allowed_object_type_ids_json, required_capability_ids_json,
                     created_at, updated_at, created_by_device_id, updated_by_device_id)
                 VALUES ('project-all', 'com.monica.mail', X'02', 1,
                         '[\"com.monica.mail.message\"]', '[]',
                         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO entries
                    (entry_id, project_id, entry_type, payload_ct, payload_schema_version,
                     object_clock, head_commit_id, deleted, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                 VALUES
                    ('entry-a', 'project-all', 'com.monica.mail.message', X'03', 1, '{}',
                     (SELECT commit_id FROM commits LIMIT 1), 0,
                     '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1'),
                    ('entry-b', 'project-all', 'com.monica.mail.message', X'04', 1, '{}',
                     (SELECT commit_id FROM commits LIMIT 1), 0,
                     '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO object_relations
                    (relation_id, source_object_id, target_object_id, relation_kind,
                     payload_ct, payload_schema_version, object_clock, head_commit_id,
                     deleted, created_at, updated_at, created_by_device_id, updated_by_device_id)
                 VALUES ('relation-all', 'entry-a', 'entry-b', 'com.monica.mail.reply-to',
                         X'05', 1, '{}', (SELECT commit_id FROM commits LIMIT 1), 0,
                         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO object_labels
                    (label_id, collection_id, name_ct, payload_ct, payload_schema_version,
                     object_clock, head_commit_id, deleted, created_at, updated_at,
                     created_by_device_id, updated_by_device_id)
                 VALUES ('label-all', 'project-all', X'06', X'07', 1, '{}',
                         (SELECT commit_id FROM commits LIMIT 1), 0,
                         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO object_label_assignments
                    (assignment_id, object_id, label_id, object_clock, head_commit_id,
                     deleted, created_at, updated_at, created_by_device_id, updated_by_device_id)
                 VALUES ('assignment-all', 'entry-a', 'label-all', '{}',
                         (SELECT commit_id FROM commits LIMIT 1), 0,
                         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO attachments
                    (attachment_id, project_id, file_name_ct, storage_mode, content_hash,
                     original_size, stored_size, chunk_count, head_commit_id, deleted,
                     created_at, updated_at, created_by_device_id, updated_by_device_id)
                 VALUES ('attachment-all', 'project-all', X'08', 'embedded-inline',
                         'hash-all', 1, 1, 1, (SELECT commit_id FROM commits LIMIT 1), 0,
                         '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'd1', 'd1');
                 INSERT INTO attachment_chunks
                    (attachment_id, chunk_index, chunk_hash, chunk_ct, stored_size, created_at)
                 VALUES ('attachment-all', 0, 'chunk-all', X'09', 1,
                         '2026-07-20T00:00:00Z');
                 INSERT INTO project_tags(project_id, tag) VALUES ('project-all', 'inbox');
                 INSERT INTO tiga_policy_exceptions
                    (exception_id, target_scope, target_id, approved_override_json,
                     reason, created_at)
                 VALUES ('exception-all', 'project', 'project-all', '{}', 'test',
                         '2026-07-20T00:00:00Z');
                 INSERT INTO tiga_policy_overrides
                    (scope_type, scope_id, policy_json, exception_id, updated_at,
                     updated_by_device_id)
                 VALUES ('project', 'project-all', '{}', 'exception-all',
                         '2026-07-20T00:00:00Z', 'd1');
                 INSERT INTO security_audit_events
                    (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                     reason_codes_json, constraints_json)
                 VALUES ('audit-all', '2026-07-20T00:00:00Z', 'copy-secret', 'deny',
                         'project', 'project-all', '[]', '[]');
                 INSERT INTO tombstones
                    (tombstone_id, target_object_type, target_object_id, delete_clock,
                     deleted_by_device_id, deleted_at, delete_commit_id)
                 VALUES ('tombstone-all', 'entry', 'deleted-entry-all', '{}', 'd1',
                         '2026-07-20T00:00:00Z', (SELECT commit_id FROM commits LIMIT 1));
                 INSERT INTO tombstone_acknowledgements
                    (tombstone_id, device_id, observed_commit_id, acknowledged_at)
                 VALUES ('tombstone-all', 'd1', (SELECT commit_id FROM commits LIMIT 1),
                         '2026-07-20T00:00:00Z');
                 INSERT INTO purge_receipts
                    (purge_id, tombstone_id, target_object_type, target_object_id,
                     delete_commit_id, purge_commit_id, delete_clock, retention_eligible_at,
                     purged_by_device_id, purged_at, integrity_tag)
                 VALUES ('purge-all', 'purged-tombstone-all', 'entry', 'purged-entry-all',
                         (SELECT commit_id FROM commits LIMIT 1),
                         (SELECT commit_id FROM commits LIMIT 1), '{}',
                         '2026-07-20T00:00:00Z', 'd1', '2026-07-20T00:00:00Z', X'0A');
                 UPDATE vault_meta SET updated_at = '2026-07-20T00:00:01Z';
                 UPDATE key_epochs SET created_at = created_at;
                 UPDATE branches SET updated_at = '2026-07-20T00:00:01Z';
                 UPDATE device_heads SET last_seen_at = '2026-07-20T00:00:01Z';",
            )?;
            Ok(())
        })
        .unwrap();

        let envelope = latest_envelope(&conn);
        assert_eq!(envelope.batch_kind, SyncDeltaBatchKind::Auxiliary);
        let body = decode_sync_delta_body(&envelope, SyncDeltaLimits::default()).unwrap();
        assert!(body.state.key_epoch_state.is_some());
        assert!(body.state.tiga_vault_state.is_some());
        assert_eq!(body.state.tiga_policy_overrides.unwrap().len(), 1);
        assert_eq!(body.state.tiga_policy_exceptions.unwrap().len(), 1);
        assert_eq!(body.state.security_audit_events.unwrap().len(), 1);
        assert_eq!(body.state.projects.len(), 1);
        assert!(body.state.projects[0].collection_profile.is_some());
        assert_eq!(body.state.entries.len(), 2);
        assert_eq!(body.state.object_relations.unwrap().len(), 1);
        assert_eq!(body.state.object_labels.unwrap().len(), 1);
        assert_eq!(body.state.object_label_assignments.unwrap().len(), 1);
        assert_eq!(body.state.attachments.len(), 1);
        assert_eq!(body.state.attachment_chunks.len(), 1);
        assert_eq!(body.state.project_tags.unwrap()[0].tags, vec!["inbox"]);
        assert_eq!(body.state.tombstones.unwrap().len(), 1);
        assert_eq!(body.state.tombstone_acknowledgements.unwrap().len(), 1);
        assert_eq!(body.state.purge_receipts.unwrap().len(), 1);
        assert_eq!(body.state.branches.len(), 1);
        assert_eq!(body.device_heads.len(), 1);
    }

    #[test]
    fn sync_delta_collect_preserves_explicit_metadata_deletion() {
        let conn = setup();
        conn.with_immediate_transaction(|| {
            conn.inner().execute_batch(
                "INSERT INTO tiga_policy_overrides
                    (scope_type, scope_id, policy_json, updated_at, updated_by_device_id)
                 VALUES ('vault', '', '{}', '2026-07-20T00:00:00Z', 'd1');
                 DELETE FROM tiga_policy_overrides
                 WHERE scope_type = 'vault' AND scope_id = '';",
            )?;
            Ok(())
        })
        .unwrap();

        let envelope = latest_envelope(&conn);
        let body = decode_sync_delta_body(&envelope, SyncDeltaLimits::default()).unwrap();
        assert!(body.state.tiga_policy_overrides.unwrap().is_empty());
        assert_eq!(
            body.deletions,
            vec![DeletedSyncEntity {
                entity_kind: "tiga-override".to_string(),
                entity_id: compound_id("vault", ""),
            }]
        );
    }
}
