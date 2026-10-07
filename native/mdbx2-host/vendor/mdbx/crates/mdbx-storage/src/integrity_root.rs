use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use mdbx_sync::AuthenticatedStateRootCheckpoint;

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::migration::AUTHENTICATED_STATE_ROOT_EXTENSION;
use crate::sync_delta::{DeviceHeadRow, PendingMutation, SyncDeltaBody, SyncDeltaEnvelope};
use crate::sync_state::{
    self, AttachmentChunkRow, AttachmentRow, ProjectTagSetRow, SyncStateLimits,
};
use crate::vault_header_integrity::{self, VaultHeaderIntegrityStatus};

pub const INTEGRITY_ROOT_PROFILE_V1: &str = mdbx_sync::AUTHENTICATED_STATE_ROOT_PROFILE_V1;
pub const AUTHENTICATED_STATE_ROOT_CAPABILITY: &str =
    mdbx_sync::CAPABILITY_AUTHENTICATED_STATE_ROOT_V1;

pub const DEFAULT_MAX_INTEGRITY_ROOT_LEAVES: usize = 250_000;
pub const HARD_MAX_INTEGRITY_ROOT_LEAVES: usize = 2_000_000;
pub const DEFAULT_MAX_INTEGRITY_ROOT_LEAF_VALUE_BYTES: usize = 96 * 1024 * 1024;
pub const HARD_MAX_INTEGRITY_ROOT_LEAF_VALUE_BYTES: usize = 512 * 1024 * 1024;

const TREE_DEPTH: u8 = 16;
const HASH_LEN: usize = 32;
const MAX_ENTITY_KIND_BYTES: usize = 128;
const MAX_ENTITY_ID_BYTES: usize = 512;
const MAX_LOGICAL_KEY_BYTES: usize = 4 + MAX_ENTITY_KIND_BYTES + 4 + MAX_ENTITY_ID_BYTES;

const KEY_HASH_DOMAIN: &[u8] = b"mdbx-integrity-root-key-v1";
const VALUE_HASH_DOMAIN: &[u8] = b"mdbx-integrity-root-value-v1";
const LEAF_HASH_DOMAIN: &[u8] = b"mdbx-integrity-root-leaf-v1";
const BUCKET_HASH_DOMAIN: &[u8] = b"mdbx-integrity-root-bucket-v1";
const NODE_HASH_DOMAIN: &[u8] = b"mdbx-integrity-root-node-v1";
const LEAF_AUTH_DOMAIN: &[u8] = b"mdbx-integrity-root-leaf-auth-v1";
const NODE_AUTH_DOMAIN: &[u8] = b"mdbx-integrity-root-node-auth-v1";
const META_AUTH_DOMAIN: &[u8] = b"mdbx-integrity-root-meta-auth-v1";
const PEER_CHECKPOINT_AUTH_DOMAIN: &[u8] = b"mdbx-integrity-root-peer-checkpoint-auth-v1";

type NodeMap = BTreeMap<(u8, u32), [u8; HASH_LEN]>;

const ROOT_SCHEMA_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS mdbx_integrity_root_meta (
    meta_id             INTEGER PRIMARY KEY CHECK (meta_id = 1),
    profile             TEXT NOT NULL,
    state               TEXT NOT NULL CHECK (state IN ('pending', 'building', 'established', 'stale')),
    vault_id            TEXT NOT NULL,
    schema_version      INTEGER NOT NULL CHECK (schema_version > 0),
    generation          INTEGER NOT NULL CHECK (generation >= 0),
    leaf_count          INTEGER NOT NULL CHECK (leaf_count >= 0),
    root_hash           BLOB NOT NULL CHECK (length(root_hash) = 32),
    latest_commit_seq   INTEGER NOT NULL CHECK (latest_commit_seq >= 0),
    latest_delta_seq    INTEGER NOT NULL CHECK (latest_delta_seq >= 0),
    updated_at          TEXT NOT NULL,
    integrity_tag       BLOB CHECK (integrity_tag IS NULL OR length(integrity_tag) = 32)
);

CREATE TABLE IF NOT EXISTS mdbx_integrity_root_leaves (
    key_hash            BLOB PRIMARY KEY NOT NULL CHECK (length(key_hash) = 32),
    entity_kind         TEXT NOT NULL CHECK (length(entity_kind) BETWEEN 1 AND 128),
    entity_id           TEXT NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 512),
    logical_key         BLOB NOT NULL CHECK (length(logical_key) BETWEEN 1 AND 656),
    bucket              INTEGER NOT NULL CHECK (bucket BETWEEN 0 AND 65535),
    value_hash          BLOB NOT NULL CHECK (length(value_hash) = 32),
    leaf_hash           BLOB NOT NULL CHECK (length(leaf_hash) = 32),
    integrity_tag       BLOB NOT NULL CHECK (length(integrity_tag) = 32),
    UNIQUE (entity_kind, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_mdbx_integrity_root_leaves_bucket
    ON mdbx_integrity_root_leaves (bucket, key_hash);

CREATE TABLE IF NOT EXISTS mdbx_integrity_root_nodes (
    level               INTEGER NOT NULL CHECK (level BETWEEN 0 AND 16),
    node_index          INTEGER NOT NULL CHECK (node_index BETWEEN 0 AND 65535),
    node_hash           BLOB NOT NULL CHECK (length(node_hash) = 32),
    integrity_tag       BLOB NOT NULL CHECK (length(integrity_tag) = 32),
    PRIMARY KEY (level, node_index)
);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntegrityRootLimits {
    max_leaves: usize,
    max_leaf_value_bytes: usize,
}

impl IntegrityRootLimits {
    pub fn new(max_leaves: usize, max_leaf_value_bytes: usize) -> StorageResult<Self> {
        if max_leaves == 0 || max_leaves > HARD_MAX_INTEGRITY_ROOT_LEAVES {
            return Err(StorageError::Validation(format!(
                "integrity root leaf limit must be between 1 and {HARD_MAX_INTEGRITY_ROOT_LEAVES}"
            )));
        }
        if max_leaf_value_bytes == 0
            || max_leaf_value_bytes > HARD_MAX_INTEGRITY_ROOT_LEAF_VALUE_BYTES
        {
            return Err(StorageError::Validation(format!(
                "integrity root leaf value limit must be between 1 and {HARD_MAX_INTEGRITY_ROOT_LEAF_VALUE_BYTES} bytes"
            )));
        }
        Ok(Self {
            max_leaves,
            max_leaf_value_bytes,
        })
    }

    pub const fn desktop() -> Self {
        Self {
            max_leaves: HARD_MAX_INTEGRITY_ROOT_LEAVES,
            max_leaf_value_bytes: HARD_MAX_INTEGRITY_ROOT_LEAF_VALUE_BYTES,
        }
    }

    pub const fn max_leaves(self) -> usize {
        self.max_leaves
    }

    pub const fn max_leaf_value_bytes(self) -> usize {
        self.max_leaf_value_bytes
    }
}

impl Default for IntegrityRootLimits {
    fn default() -> Self {
        Self {
            max_leaves: DEFAULT_MAX_INTEGRITY_ROOT_LEAVES,
            max_leaf_value_bytes: DEFAULT_MAX_INTEGRITY_ROOT_LEAF_VALUE_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrityRootState {
    Disabled,
    Pending,
    Building,
    Established,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IntegrityRootStatus {
    pub state: IntegrityRootState,
    pub profile: Option<String>,
    pub generation: u64,
    pub leaf_count: u64,
    pub root_hash: Option<[u8; HASH_LEN]>,
    pub latest_commit_seq: u64,
    pub latest_delta_seq: u64,
    pub authenticated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IntegrityRootVerification {
    pub profile: String,
    pub generation: u64,
    pub leaf_count: u64,
    pub root_hash: [u8; HASH_LEN],
    pub latest_commit_seq: u64,
    pub latest_delta_seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrityRootCheckpointRelation {
    Unchanged,
    Advanced,
}

#[derive(Debug, Clone)]
struct RootMeta {
    profile: String,
    state: String,
    vault_id: String,
    schema_version: u32,
    generation: u64,
    leaf_count: u64,
    root_hash: [u8; HASH_LEN],
    latest_commit_seq: u64,
    latest_delta_seq: u64,
    updated_at: String,
    integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
struct LeafInput {
    entity_kind: String,
    entity_id: String,
    value: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LeafRecord {
    key_hash: [u8; HASH_LEN],
    entity_kind: String,
    entity_id: String,
    logical_key: Vec<u8>,
    bucket: u16,
    value_hash: [u8; HASH_LEN],
    leaf_hash: [u8; HASH_LEN],
    integrity_tag: Vec<u8>,
}

#[derive(Debug, Serialize)]
struct AttachmentLeafValue<'a> {
    attachment: &'a AttachmentRow,
    chunks: Vec<&'a AttachmentChunkRow>,
}

#[derive(Debug, Serialize)]
struct VaultMetaLeafValue {
    vault_id: String,
    format_version: String,
    schema_version: u32,
    min_reader_version: String,
    min_writer_version: String,
    created_at: String,
    updated_at: String,
    default_tiga_mode: String,
    active_key_epoch_id: String,
    compat_flags: String,
    critical_extensions: String,
    tiga_policy_version: u32,
    tiga_compliance_status: String,
    header_integrity_profile: String,
    header_integrity_tag: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
struct CommitOperationLeafValue {
    operation_id: String,
    operation_kind: String,
    branch_id: Option<String>,
    branch_name: String,
    change_summary_ct: Vec<u8>,
    request_hash: Vec<u8>,
    created_at: String,
    integrity_tag: Vec<u8>,
}

#[derive(Debug, Serialize)]
struct CommitLeafValue {
    commit_id: String,
    device_id: String,
    local_seq: u64,
    commit_kind: String,
    change_scope: String,
    changed_object_ids_ct: Vec<u8>,
    vector_clock: String,
    message_ct: Option<Vec<u8>>,
    created_at: String,
    integrity_tag: Vec<u8>,
    parents: Vec<String>,
    inventory_seq: u64,
    operation: Option<CommitOperationLeafValue>,
}

pub struct IntegrityRootService;

impl IntegrityRootService {
    pub fn enable(conn: &VaultConnection) -> StorageResult<IntegrityRootStatus> {
        Self::enable_with_limits(conn, IntegrityRootLimits::default())
    }

    pub fn enable_with_limits(
        conn: &VaultConnection,
        limits: IntegrityRootLimits,
    ) -> StorageResult<IntegrityRootStatus> {
        require_verified_unlocked(conn)?;
        if critical_extension_enabled(conn)? {
            if let Some(meta) = load_meta_optional(conn)? {
                if meta.state == "established" {
                    Self::verify_with_limits(conn, limits)?;
                    return Self::status(conn);
                }
            }
        }
        Self::rebuild_with_limits(conn, limits)
    }

    pub fn rebuild(conn: &VaultConnection) -> StorageResult<IntegrityRootStatus> {
        Self::rebuild_with_limits(conn, IntegrityRootLimits::default())
    }

    pub fn rebuild_with_limits(
        conn: &VaultConnection,
        limits: IntegrityRootLimits,
    ) -> StorageResult<IntegrityRootStatus> {
        require_verified_unlocked(conn)?;
        conn.with_immediate_transaction(|| {
            create_schema(conn)?;
            initialize_meta(conn)?;
            conn.ensure_critical_extension(AUTHENTICATED_STATE_ROOT_EXTENSION)?;
            rebuild_inner(conn, limits)
        })?;
        Self::status(conn)
    }

    pub fn status(conn: &VaultConnection) -> StorageResult<IntegrityRootStatus> {
        let Some(meta) = load_meta_optional(conn)? else {
            return Ok(disabled_status());
        };
        let state = parse_state(&meta.state)?;
        let authenticated = if state == IntegrityRootState::Established && conn.keyring().is_some()
        {
            verify_meta(conn, &meta)?;
            true
        } else {
            false
        };
        Ok(status_from_meta(meta, state, authenticated))
    }

    /// Reads root metadata without unlocking, migrating, or opening the vault
    /// for writing. The returned status is intentionally unauthenticated.
    pub fn status_path(path: &Path) -> StorageResult<IntegrityRootStatus> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let inspection = crate::migration::inspect_migration(&conn)?;
        if !inspection.initialized {
            return Err(StorageError::Validation(
                "integrity root status requires an initialized MDBX vault".to_string(),
            ));
        }
        let Some(meta) = load_meta_optional_connection(&conn)? else {
            return Ok(disabled_status());
        };
        let state = parse_state(&meta.state)?;
        Ok(status_from_meta(meta, state, false))
    }

    pub fn verify(conn: &VaultConnection) -> StorageResult<IntegrityRootVerification> {
        Self::verify_with_limits(conn, IntegrityRootLimits::default())
    }

    pub fn verify_with_limits(
        conn: &VaultConnection,
        limits: IntegrityRootLimits,
    ) -> StorageResult<IntegrityRootVerification> {
        require_verified_unlocked(conn)?;
        conn.with_read_transaction(|| {
            let meta = load_meta(conn)?;
            if meta.state != "established" {
                return Err(StorageError::Validation(format!(
                    "integrity root is not established: {}",
                    meta.state
                )));
            }
            verify_meta(conn, &meta)?;
            verify_against_source(conn, &meta, limits)?;
            Ok(IntegrityRootVerification {
                profile: meta.profile,
                generation: meta.generation,
                leaf_count: meta.leaf_count,
                root_hash: meta.root_hash,
                latest_commit_seq: meta.latest_commit_seq,
                latest_delta_seq: meta.latest_delta_seq,
            })
        })
    }

    /// Issues an O(1) authenticated checkpoint for peer rollback tracking.
    /// Unlock already verifies an established tree, and every later mutation
    /// advances the authenticated metadata in the same transaction.
    pub fn issue_checkpoint(
        conn: &VaultConnection,
    ) -> StorageResult<AuthenticatedStateRootCheckpoint> {
        require_verified_unlocked(conn)?;
        let status = Self::status(conn)?;
        if status.state != IntegrityRootState::Established || !status.authenticated {
            return Err(StorageError::Validation(
                "peer checkpoint issuance requires an established authenticated integrity root"
                    .to_string(),
            ));
        }
        let root_hash = status.root_hash.ok_or_else(|| {
            StorageError::Validation(
                "established integrity root is missing its root hash".to_string(),
            )
        })?;
        let profile = status.profile.ok_or_else(|| {
            StorageError::Validation(
                "established integrity root is missing its profile".to_string(),
            )
        })?;
        let authentication_tag = compute_peer_checkpoint_tag(
            conn,
            &profile,
            status.generation,
            status.leaf_count,
            &root_hash,
            status.latest_commit_seq,
            status.latest_delta_seq,
        )?;
        AuthenticatedStateRootCheckpoint::new(
            profile,
            status.generation,
            status.leaf_count,
            root_hash.to_vec(),
            status.latest_commit_seq,
            status.latest_delta_seq,
            authentication_tag,
        )
        .map_err(|error| StorageError::Validation(error.to_string()))
    }

    /// Verifies a peer checkpoint against this vault's identity, schema, and
    /// integrity subkey. It does not compare the peer root with the local root.
    pub fn verify_checkpoint(
        conn: &VaultConnection,
        checkpoint: &AuthenticatedStateRootCheckpoint,
    ) -> StorageResult<IntegrityRootVerification> {
        require_verified_unlocked(conn)?;
        checkpoint
            .validate()
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        verify_peer_checkpoint_tag(conn, checkpoint)?;
        Ok(IntegrityRootVerification {
            profile: checkpoint.profile.clone(),
            generation: checkpoint.generation,
            leaf_count: checkpoint.leaf_count,
            root_hash: checkpoint.root_hash.clone().try_into().map_err(|_| {
                StorageError::Validation(
                    "authenticated state-root hash must be 32 bytes".to_string(),
                )
            })?,
            latest_commit_seq: checkpoint.latest_commit_sequence,
            latest_delta_seq: checkpoint.latest_delta_sequence,
        })
    }

    /// Compares two authenticated checkpoints previously associated with the
    /// same peer identity by the client.
    pub fn compare_checkpoints(
        conn: &VaultConnection,
        previous: &AuthenticatedStateRootCheckpoint,
        candidate: &AuthenticatedStateRootCheckpoint,
    ) -> StorageResult<IntegrityRootCheckpointRelation> {
        Self::verify_checkpoint(conn, previous)?;
        Self::verify_checkpoint(conn, candidate)?;
        match candidate.generation.cmp(&previous.generation) {
            std::cmp::Ordering::Less => Err(StorageError::Validation(
                "authenticated peer integrity-root checkpoint rolled back its generation"
                    .to_string(),
            )),
            std::cmp::Ordering::Equal if candidate != previous => Err(StorageError::Validation(
                "authenticated peer integrity-root checkpoint changed within one generation"
                    .to_string(),
            )),
            std::cmp::Ordering::Equal => Ok(IntegrityRootCheckpointRelation::Unchanged),
            std::cmp::Ordering::Greater
                if candidate.latest_commit_sequence < previous.latest_commit_sequence
                    || candidate.latest_delta_sequence < previous.latest_delta_sequence =>
            {
                Err(StorageError::Validation(
                    "authenticated peer integrity-root checkpoint rolled back an inventory anchor"
                        .to_string(),
                ))
            }
            std::cmp::Ordering::Greater => Ok(IntegrityRootCheckpointRelation::Advanced),
        }
    }
}

pub(crate) fn verify_if_established(conn: &VaultConnection) -> StorageResult<()> {
    if !critical_extension_enabled(conn)? {
        return Ok(());
    }
    IntegrityRootService::verify_with_limits(conn, IntegrityRootLimits::desktop()).map(|_| ())
}

pub(crate) fn validate_established_schema(conn: &Connection) -> StorageResult<()> {
    for table in [
        "mdbx_integrity_root_meta",
        "mdbx_integrity_root_leaves",
        "mdbx_integrity_root_nodes",
    ] {
        if !table_exists(conn, table)? {
            return Err(StorageError::Validation(format!(
                "authenticated state root is missing required table {table}"
            )));
        }
    }

    let meta_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM mdbx_integrity_root_meta", [], |row| {
            row.get(0)
        })?;
    if meta_count != 1 {
        return Err(StorageError::Validation(format!(
            "authenticated state root requires exactly one metadata row, found {meta_count}"
        )));
    }
    let invalid_meta: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mdbx_integrity_root_meta
         WHERE meta_id <> 1
            OR profile <> ?1
            OR state <> 'established'
            OR typeof(root_hash) <> 'blob' OR length(root_hash) <> 32
            OR typeof(integrity_tag) <> 'blob' OR length(integrity_tag) <> 32",
        [INTEGRITY_ROOT_PROFILE_V1],
        |row| row.get(0),
    )?;
    if invalid_meta != 0 {
        return Err(StorageError::Validation(
            "authenticated state root metadata is not established or has an invalid shape"
                .to_string(),
        ));
    }
    let invalid_leaves: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mdbx_integrity_root_leaves
         WHERE length(key_hash) <> 32 OR length(value_hash) <> 32
            OR length(leaf_hash) <> 32 OR length(integrity_tag) <> 32
            OR bucket < 0 OR bucket > 65535",
        [],
        |row| row.get(0),
    )?;
    if invalid_leaves != 0 {
        return Err(StorageError::Validation(
            "authenticated state root contains invalid leaf rows".to_string(),
        ));
    }
    let invalid_nodes: i64 = conn.query_row(
        "SELECT COUNT(*) FROM mdbx_integrity_root_nodes
         WHERE level < 0 OR level > 16 OR node_index < 0 OR node_index > 65535
            OR length(node_hash) <> 32 OR length(integrity_tag) <> 32",
        [],
        |row| row.get(0),
    )?;
    if invalid_nodes != 0 {
        return Err(StorageError::Validation(
            "authenticated state root contains invalid node rows".to_string(),
        ));
    }
    let extension_trigger_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'trigger'
           AND name IN (
               'trg_sync_delta_sync_extension_insert',
               'trg_sync_delta_sync_extension_update',
               'trg_sync_delta_sync_extension_delete'
           )",
        [],
        |row| row.get(0),
    )?;
    if extension_trigger_count != 3 {
        return Err(StorageError::Validation(
            "authenticated state root is missing sync extension capture triggers".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn apply_sync_delta(
    conn: &VaultConnection,
    envelope: &SyncDeltaEnvelope,
    body: &SyncDeltaBody,
    mutations: &BTreeMap<(String, String), PendingMutation>,
) -> StorageResult<()> {
    let Some(meta) = load_meta_optional(conn)? else {
        return Ok(());
    };
    match meta.state.as_str() {
        "pending" | "building" => return Ok(()),
        "stale" => {
            return Err(StorageError::Validation(
                "integrity root is stale and must be rebuilt before writes continue".to_string(),
            ))
        }
        "established" => {}
        other => {
            return Err(StorageError::Validation(format!(
                "unsupported integrity root state: {other}"
            )))
        }
    }
    require_verified_unlocked(conn)?;
    verify_meta(conn, &meta)?;

    let limits = IntegrityRootLimits::desktop();
    let mut touched_buckets = BTreeSet::new();
    for mutation in mutations.values() {
        apply_mutation(conn, body, mutation, limits, &mut touched_buckets)?;
    }
    for bucket in touched_buckets {
        recompute_bucket_path(conn, bucket)?;
    }

    let (latest_commit_seq, latest_delta_seq) = current_anchors(conn)?;
    let batch_seq: u64 = conn
        .inner()
        .query_row(
            "SELECT batch_seq FROM sync_delta_batches WHERE batch_id = ?1",
            [&envelope.batch_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(StorageError::Database)
        .and_then(nonnegative_u64)?;
    if batch_seq != latest_delta_seq {
        return Err(StorageError::Validation(
            "integrity root finalization did not observe the newest sync delta batch".to_string(),
        ));
    }
    let leaf_count = count_leaves(conn)?;
    let root_hash = load_root_hash(conn)?;
    seal_meta(
        conn,
        meta.generation.checked_add(1).ok_or_else(|| {
            StorageError::Validation("integrity root generation overflow".to_string())
        })?,
        leaf_count,
        root_hash,
        latest_commit_seq,
        latest_delta_seq,
    )
}

fn create_schema(conn: &VaultConnection) -> StorageResult<()> {
    crate::schema::v14::ensure_sync_state_extension_triggers(conn.inner())?;
    conn.inner()
        .execute_batch(ROOT_SCHEMA_DDL)
        .map_err(StorageError::Database)
}

fn initialize_meta(conn: &VaultConnection) -> StorageResult<()> {
    let (vault_id, schema_version) = vault_identity(conn)?;
    conn.inner().execute(
        "INSERT OR IGNORE INTO mdbx_integrity_root_meta
            (meta_id, profile, state, vault_id, schema_version, generation,
             leaf_count, root_hash, latest_commit_seq, latest_delta_seq,
             updated_at, integrity_tag)
         VALUES (1, ?1, 'pending', ?2, ?3, 0, 0, ?4, 0, 0, ?5, NULL)",
        params![
            INTEGRITY_ROOT_PROFILE_V1,
            vault_id,
            i64::from(schema_version),
            empty_hash(TREE_DEPTH).to_vec(),
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    let meta = load_meta(conn)?;
    if meta.profile != INTEGRITY_ROOT_PROFILE_V1
        || meta.vault_id != vault_id
        || meta.schema_version != schema_version
    {
        return Err(StorageError::Validation(
            "integrity root metadata belongs to a different vault or schema".to_string(),
        ));
    }
    Ok(())
}

fn rebuild_inner(conn: &VaultConnection, limits: IntegrityRootLimits) -> StorageResult<()> {
    let previous = load_meta(conn)?;
    conn.inner().execute(
        "UPDATE mdbx_integrity_root_meta
         SET state = 'building', integrity_tag = NULL, updated_at = ?1
         WHERE meta_id = 1",
        [chrono::Utc::now().to_rfc3339()],
    )?;
    conn.inner()
        .execute("DELETE FROM mdbx_integrity_root_nodes", [])?;
    conn.inner()
        .execute("DELETE FROM mdbx_integrity_root_leaves", [])?;

    let inputs = collect_full_leaf_inputs(conn, limits)?;
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "integrity root rebuild requires a verified-unlocked vault".to_string(),
        )
    })?;
    let mut records = Vec::with_capacity(inputs.len());
    for input in inputs {
        records.push(prepare_leaf_record(keyring, input)?);
    }
    records.sort_by_key(|record| record.key_hash);
    for pair in records.windows(2) {
        if pair[0].key_hash == pair[1].key_hash {
            return Err(StorageError::Validation(format!(
                "integrity root logical key collision between {}/{} and {}/{}",
                pair[0].entity_kind, pair[0].entity_id, pair[1].entity_kind, pair[1].entity_id
            )));
        }
    }
    for record in &records {
        insert_leaf_record(conn, record)?;
    }

    let (nodes, root_hash) = build_node_map(&records);
    for ((level, node_index), node_hash) in &nodes {
        insert_node(conn, *level, *node_index, *node_hash)?;
    }
    let (latest_commit_seq, latest_delta_seq) = current_anchors(conn)?;
    seal_meta(
        conn,
        previous.generation.checked_add(1).ok_or_else(|| {
            StorageError::Validation("integrity root generation overflow".to_string())
        })?,
        records.len() as u64,
        root_hash,
        latest_commit_seq,
        latest_delta_seq,
    )
}

fn collect_full_leaf_inputs(
    conn: &VaultConnection,
    limits: IntegrityRootLimits,
) -> StorageResult<Vec<LeafInput>> {
    let sync_limits = SyncStateLimits::new(limits.max_leaf_value_bytes, limits.max_leaves)?;
    let state = sync_state::collect_sync_state_with_limits(conn, sync_limits)?;
    let mut leaves = Vec::new();

    let vault_meta = load_vault_meta_leaf(conn)?;
    let vault_id = vault_meta.vault_id.clone();
    push_serialized_leaf(&mut leaves, "vault-meta", &vault_id, &vault_meta, limits)?;
    if let Some(value) = state.key_epoch_state.as_ref() {
        push_serialized_leaf(&mut leaves, "key-epochs", "all", value, limits)?;
    }
    if let Some(value) = state.tiga_vault_state.as_ref() {
        push_serialized_leaf(&mut leaves, "tiga-vault", "all", value, limits)?;
    }
    for row in state.tiga_policy_overrides.as_deref().unwrap_or_default() {
        push_serialized_leaf(
            &mut leaves,
            "tiga-override",
            &compound_id(&row.scope_type, &row.scope_id),
            row,
            limits,
        )?;
    }
    for row in state.tiga_policy_exceptions.as_deref().unwrap_or_default() {
        push_serialized_leaf(
            &mut leaves,
            "tiga-exception",
            &row.exception_id,
            row,
            limits,
        )?;
    }
    for row in state.security_audit_events.as_deref().unwrap_or_default() {
        push_serialized_leaf(&mut leaves, "security-audit", &row.event_id, row, limits)?;
    }
    for row in &state.projects {
        push_serialized_leaf(&mut leaves, "project", &row.project_id, row, limits)?;
    }
    for row in &state.entries {
        push_serialized_leaf(&mut leaves, "entry", &row.entry_id, row, limits)?;
    }
    for row in state.object_relations.as_deref().unwrap_or_default() {
        push_serialized_leaf(
            &mut leaves,
            "object-relation",
            &row.relation_id,
            row,
            limits,
        )?;
    }
    for row in state.object_labels.as_deref().unwrap_or_default() {
        push_serialized_leaf(&mut leaves, "object-label", &row.label_id, row, limits)?;
    }
    for row in state
        .object_label_assignments
        .as_deref()
        .unwrap_or_default()
    {
        push_serialized_leaf(
            &mut leaves,
            "object-label-assignment",
            &row.assignment_id,
            row,
            limits,
        )?;
    }

    let mut chunks = BTreeMap::<&str, Vec<&AttachmentChunkRow>>::new();
    for chunk in &state.attachment_chunks {
        chunks.entry(&chunk.attachment_id).or_default().push(chunk);
    }
    for attachment in &state.attachments {
        let value = AttachmentLeafValue {
            attachment,
            chunks: chunks
                .remove(attachment.attachment_id.as_str())
                .unwrap_or_default(),
        };
        push_serialized_leaf(
            &mut leaves,
            "attachment",
            &attachment.attachment_id,
            &value,
            limits,
        )?;
    }
    if !chunks.is_empty() {
        return Err(StorageError::Validation(
            "integrity root found attachment chunks without an attachment row".to_string(),
        ));
    }

    for row in state.project_tags.as_deref().unwrap_or_default() {
        push_serialized_leaf(&mut leaves, "project-tags", &row.project_id, row, limits)?;
    }
    for row in state.tombstones.as_deref().unwrap_or_default() {
        push_serialized_leaf(&mut leaves, "tombstone", &row.tombstone_id, row, limits)?;
    }
    for row in state
        .tombstone_acknowledgements
        .as_deref()
        .unwrap_or_default()
    {
        push_serialized_leaf(
            &mut leaves,
            "tombstone-ack",
            &compound_id(&row.tombstone_id, &row.device_id),
            row,
            limits,
        )?;
    }
    for row in state.purge_receipts.as_deref().unwrap_or_default() {
        push_serialized_leaf(&mut leaves, "purge-receipt", &row.purge_id, row, limits)?;
    }
    for row in &state.branches {
        push_serialized_leaf(&mut leaves, "branch", &row.branch_id, row, limits)?;
    }
    for (key, value) in &state.extensions {
        push_serialized_leaf(&mut leaves, "sync-extension", key, value, limits)?;
    }

    for commit_id in load_all_commit_ids(conn)? {
        let value = load_commit_leaf(conn, &commit_id)?.ok_or_else(|| {
            StorageError::Validation(format!(
                "commit inventory references missing commit {commit_id}"
            ))
        })?;
        push_serialized_leaf(&mut leaves, "commit", &commit_id, &value, limits)?;
    }
    for row in load_device_heads(conn)? {
        push_serialized_leaf(&mut leaves, "device-head", &row.device_id, &row, limits)?;
    }
    Ok(leaves)
}

fn push_serialized_leaf<T: Serialize + ?Sized>(
    leaves: &mut Vec<LeafInput>,
    entity_kind: &str,
    entity_id: &str,
    value: &T,
    limits: IntegrityRootLimits,
) -> StorageResult<()> {
    if leaves.len() >= limits.max_leaves {
        return Err(StorageError::ResourceLimit {
            resource: "integrity root leaves".to_string(),
            actual: leaves.len().saturating_add(1) as u64,
            limit: limits.max_leaves as u64,
        });
    }
    validate_logical_key_parts(entity_kind, entity_id)?;
    let value = serde_json::to_vec(value)
        .map_err(|error| StorageError::SchemaCreation(error.to_string()))?;
    if value.len() > limits.max_leaf_value_bytes {
        return Err(StorageError::ResourceLimit {
            resource: "integrity root leaf value bytes".to_string(),
            actual: value.len() as u64,
            limit: limits.max_leaf_value_bytes as u64,
        });
    }
    leaves.push(LeafInput {
        entity_kind: entity_kind.to_string(),
        entity_id: entity_id.to_string(),
        value,
    });
    Ok(())
}

fn load_vault_meta_leaf(conn: &VaultConnection) -> StorageResult<VaultMetaLeafValue> {
    conn.inner()
        .query_row(
            "SELECT vault_id, format_version, schema_version, min_reader_version,
                    min_writer_version, created_at, updated_at, default_tiga_mode,
                    active_key_epoch_id, compat_flags, critical_extensions,
                    tiga_policy_version, tiga_compliance_status,
                    header_integrity_profile, header_integrity_tag
             FROM vault_meta LIMIT 1",
            [],
            |row| {
                let schema_version = row.get::<_, i64>(2)?;
                let tiga_policy_version = row.get::<_, i64>(11)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    schema_version,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    tiga_policy_version,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, Option<Vec<u8>>>(14)?,
                ))
            },
        )
        .map_err(StorageError::Database)
        .and_then(
            |(
                vault_id,
                format_version,
                schema_version,
                min_reader_version,
                min_writer_version,
                created_at,
                updated_at,
                default_tiga_mode,
                active_key_epoch_id,
                compat_flags,
                critical_extensions,
                tiga_policy_version,
                tiga_compliance_status,
                header_integrity_profile,
                header_integrity_tag,
            )| {
                Ok(VaultMetaLeafValue {
                    vault_id,
                    format_version,
                    schema_version: u32::try_from(schema_version).map_err(|_| {
                        StorageError::Validation(
                            "vault schema version is outside the supported range".to_string(),
                        )
                    })?,
                    min_reader_version,
                    min_writer_version,
                    created_at,
                    updated_at,
                    default_tiga_mode,
                    active_key_epoch_id,
                    compat_flags,
                    critical_extensions,
                    tiga_policy_version: u32::try_from(tiga_policy_version).map_err(|_| {
                        StorageError::Validation(
                            "Tiga policy version is outside the supported range".to_string(),
                        )
                    })?,
                    tiga_compliance_status,
                    header_integrity_profile,
                    header_integrity_tag,
                })
            },
        )
}

fn load_all_commit_ids(conn: &VaultConnection) -> StorageResult<Vec<String>> {
    let mut statement = conn
        .inner()
        .prepare("SELECT commit_id FROM commit_inventory ORDER BY inventory_seq ASC")?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::Database)?;
    Ok(rows)
}

fn load_commit_leaf(
    conn: &VaultConnection,
    commit_id: &str,
) -> StorageResult<Option<CommitLeafValue>> {
    let row = conn
        .inner()
        .query_row(
            "SELECT c.commit_id, c.device_id, c.local_seq, c.commit_kind,
                    c.change_scope, c.changed_object_ids_ct, c.vector_clock,
                    c.message_ct, c.created_at, c.integrity_tag, i.inventory_seq
             FROM commits c
             JOIN commit_inventory i ON i.commit_id = c.commit_id
             WHERE c.commit_id = ?1",
            [commit_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Vec<u8>>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            },
        )
        .optional()?;
    let Some((
        commit_id,
        device_id,
        local_seq,
        commit_kind,
        change_scope,
        changed_object_ids_ct,
        vector_clock,
        message_ct,
        created_at,
        integrity_tag,
        inventory_seq,
    )) = row
    else {
        return Ok(None);
    };
    let mut parents_statement = conn.inner().prepare(
        "SELECT parent_commit_id FROM commit_parents
         WHERE commit_id = ?1 ORDER BY parent_commit_id ASC",
    )?;
    let parents = parents_statement
        .query_map([&commit_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let operation = conn
        .inner()
        .query_row(
            "SELECT operation_id, operation_kind, branch_id, branch_name,
                    change_summary_ct, request_hash, created_at, integrity_tag
             FROM commit_operations WHERE commit_id = ?1",
            [&commit_id],
            |row| {
                Ok(CommitOperationLeafValue {
                    operation_id: row.get(0)?,
                    operation_kind: row.get(1)?,
                    branch_id: row.get(2)?,
                    branch_name: row.get(3)?,
                    change_summary_ct: row.get(4)?,
                    request_hash: row.get(5)?,
                    created_at: row.get(6)?,
                    integrity_tag: row.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(Some(CommitLeafValue {
        commit_id,
        device_id,
        local_seq: nonnegative_u64(local_seq)?,
        commit_kind,
        change_scope,
        changed_object_ids_ct,
        vector_clock,
        message_ct,
        created_at,
        integrity_tag,
        parents,
        inventory_seq: nonnegative_u64(inventory_seq)?,
        operation,
    }))
}

fn load_device_heads(conn: &VaultConnection) -> StorageResult<Vec<DeviceHeadRow>> {
    let mut statement = conn.inner().prepare(
        "SELECT device_id, head_commit_id, last_seen_at, revoked
         FROM device_heads ORDER BY device_id ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(DeviceHeadRow {
                device_id: row.get(0)?,
                head_commit_id: row.get(1)?,
                last_seen_at: row.get(2)?,
                revoked: row.get::<_, i32>(3)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::Database)?;
    Ok(rows)
}

fn load_project_tag_set(
    conn: &VaultConnection,
    project_id: &str,
) -> StorageResult<Option<ProjectTagSetRow>> {
    let exists: bool = conn.inner().query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE project_id = ?1)",
        [project_id],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(None);
    }
    let mut statement = conn
        .inner()
        .prepare("SELECT tag FROM project_tags WHERE project_id = ?1 ORDER BY tag ASC")?;
    let tags = statement
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(ProjectTagSetRow {
        project_id: project_id.to_string(),
        tags,
    }))
}

fn apply_mutation(
    conn: &VaultConnection,
    body: &SyncDeltaBody,
    mutation: &PendingMutation,
    limits: IntegrityRootLimits,
    touched_buckets: &mut BTreeSet<u16>,
) -> StorageResult<()> {
    if mutation.action != "upsert" && mutation.action != "delete" {
        return Err(StorageError::Validation(format!(
            "unsupported integrity root mutation action: {}",
            mutation.action
        )));
    }
    match mutation.entity_kind.as_str() {
        "project" => {
            apply_optional_value(
                conn,
                "project",
                &mutation.entity_id,
                body.state
                    .projects
                    .iter()
                    .find(|row| row.project_id == mutation.entity_id),
                mutation,
                limits,
                touched_buckets,
            )?;
            let tags = load_project_tag_set(conn, &mutation.entity_id)?;
            apply_owned_optional_value(
                conn,
                "project-tags",
                &mutation.entity_id,
                tags.as_ref(),
                mutation,
                limits,
                touched_buckets,
            )
        }
        "collection-profile" => apply_optional_value(
            conn,
            "project",
            &mutation.entity_id,
            body.state
                .projects
                .iter()
                .find(|row| row.project_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "entry" => apply_optional_value(
            conn,
            "entry",
            &mutation.entity_id,
            body.state
                .entries
                .iter()
                .find(|row| row.entry_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "object-relation" => apply_optional_value(
            conn,
            "object-relation",
            &mutation.entity_id,
            body.state
                .object_relations
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.relation_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "object-label" => apply_optional_value(
            conn,
            "object-label",
            &mutation.entity_id,
            body.state
                .object_labels
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.label_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "object-label-assignment" => apply_optional_value(
            conn,
            "object-label-assignment",
            &mutation.entity_id,
            body.state
                .object_label_assignments
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.assignment_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "attachment" => {
            let attachment = body
                .state
                .attachments
                .iter()
                .find(|row| row.attachment_id == mutation.entity_id);
            if let Some(attachment) = attachment {
                let value = AttachmentLeafValue {
                    attachment,
                    chunks: body
                        .state
                        .attachment_chunks
                        .iter()
                        .filter(|row| row.attachment_id == mutation.entity_id)
                        .collect(),
                };
                upsert_serialized_value(
                    conn,
                    "attachment",
                    &mutation.entity_id,
                    &value,
                    limits,
                    touched_buckets,
                )
            } else {
                delete_or_reject_missing_upsert(conn, "attachment", mutation, touched_buckets)
            }
        }
        "project-tags" => apply_optional_value(
            conn,
            "project-tags",
            &mutation.entity_id,
            body.state
                .project_tags
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.project_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "tombstone" => apply_optional_value(
            conn,
            "tombstone",
            &mutation.entity_id,
            body.state
                .tombstones
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.tombstone_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "tombstone-ack" => apply_optional_value(
            conn,
            "tombstone-ack",
            &mutation.entity_id,
            body.state
                .tombstone_acknowledgements
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| compound_id(&row.tombstone_id, &row.device_id) == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "purge-receipt" => apply_optional_value(
            conn,
            "purge-receipt",
            &mutation.entity_id,
            body.state
                .purge_receipts
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.purge_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "branch" => apply_optional_value(
            conn,
            "branch",
            &mutation.entity_id,
            body.state
                .branches
                .iter()
                .find(|row| row.branch_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "device-head" => apply_optional_value(
            conn,
            "device-head",
            &mutation.entity_id,
            body.device_heads
                .iter()
                .find(|row| row.device_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "tiga-override" => apply_optional_value(
            conn,
            "tiga-override",
            &mutation.entity_id,
            body.state
                .tiga_policy_overrides
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| compound_id(&row.scope_type, &row.scope_id) == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "tiga-exception" => apply_optional_value(
            conn,
            "tiga-exception",
            &mutation.entity_id,
            body.state
                .tiga_policy_exceptions
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.exception_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "security-audit" => apply_optional_value(
            conn,
            "security-audit",
            &mutation.entity_id,
            body.state
                .security_audit_events
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|row| row.event_id == mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "key-epochs" => apply_optional_value(
            conn,
            "key-epochs",
            "all",
            body.state.key_epoch_state.as_ref(),
            mutation,
            limits,
            touched_buckets,
        ),
        "vault-meta" => {
            let vault_meta = load_vault_meta_leaf(conn)?;
            let vault_id = vault_meta.vault_id.clone();
            upsert_serialized_value(
                conn,
                "vault-meta",
                &vault_id,
                &vault_meta,
                limits,
                touched_buckets,
            )?;
            let tiga = body
                .state
                .tiga_vault_state
                .clone()
                .map(Ok)
                .unwrap_or_else(|| sync_state::load_tiga_vault_state(conn))?;
            upsert_serialized_value(conn, "tiga-vault", "all", &tiga, limits, touched_buckets)
        }
        "sync-extension" => apply_optional_value(
            conn,
            "sync-extension",
            &mutation.entity_id,
            body.state.extensions.get(&mutation.entity_id),
            mutation,
            limits,
            touched_buckets,
        ),
        "commit" => {
            let value = load_commit_leaf(conn, &mutation.entity_id)?;
            apply_owned_optional_value(
                conn,
                "commit",
                &mutation.entity_id,
                value.as_ref(),
                mutation,
                limits,
                touched_buckets,
            )
        }
        other => Err(StorageError::Validation(format!(
            "established integrity root has no mutation mapping for {other}"
        ))),
    }
}

fn apply_optional_value<T: Serialize + ?Sized>(
    conn: &VaultConnection,
    entity_kind: &str,
    entity_id: &str,
    value: Option<&T>,
    mutation: &PendingMutation,
    limits: IntegrityRootLimits,
    touched_buckets: &mut BTreeSet<u16>,
) -> StorageResult<()> {
    apply_owned_optional_value(
        conn,
        entity_kind,
        entity_id,
        value,
        mutation,
        limits,
        touched_buckets,
    )
}

fn apply_owned_optional_value<T: Serialize + ?Sized>(
    conn: &VaultConnection,
    entity_kind: &str,
    entity_id: &str,
    value: Option<&T>,
    mutation: &PendingMutation,
    limits: IntegrityRootLimits,
    touched_buckets: &mut BTreeSet<u16>,
) -> StorageResult<()> {
    match value {
        Some(value) => {
            upsert_serialized_value(conn, entity_kind, entity_id, value, limits, touched_buckets)
        }
        None => delete_or_reject_missing_upsert(conn, entity_kind, mutation, touched_buckets),
    }
}

fn delete_or_reject_missing_upsert(
    conn: &VaultConnection,
    entity_kind: &str,
    mutation: &PendingMutation,
    touched_buckets: &mut BTreeSet<u16>,
) -> StorageResult<()> {
    if source_entity_exists(conn, entity_kind, &mutation.entity_id)? {
        return Err(StorageError::Validation(format!(
            "integrity root could not materialize existing {}/{}",
            mutation.entity_kind, mutation.entity_id
        )));
    }
    if let Some(bucket) = delete_leaf_raw(conn, entity_kind, &mutation.entity_id)? {
        touched_buckets.insert(bucket);
    }
    Ok(())
}

fn source_entity_exists(
    conn: &VaultConnection,
    entity_kind: &str,
    entity_id: &str,
) -> StorageResult<bool> {
    let simple = |table: &str, column: &str| -> StorageResult<bool> {
        let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column} = ?1)");
        conn.inner()
            .query_row(&sql, [entity_id], |row| row.get(0))
            .map_err(StorageError::Database)
    };
    match entity_kind {
        "project" | "project-tags" => simple("projects", "project_id"),
        "entry" => simple("entries", "entry_id"),
        "object-relation" => simple("object_relations", "relation_id"),
        "object-label" => simple("object_labels", "label_id"),
        "object-label-assignment" => simple("object_label_assignments", "assignment_id"),
        "attachment" => simple("attachments", "attachment_id"),
        "tombstone" => simple("tombstones", "tombstone_id"),
        "purge-receipt" => simple("purge_receipts", "purge_id"),
        "branch" => simple("branches", "branch_id"),
        "device-head" => simple("device_heads", "device_id"),
        "tiga-exception" => simple("tiga_policy_exceptions", "exception_id"),
        "security-audit" => simple("security_audit_events", "event_id"),
        "sync-extension" => simple("sync_state_extensions", "extension_key"),
        "commit" => simple("commits", "commit_id"),
        "key-epochs" => conn
            .inner()
            .query_row("SELECT EXISTS(SELECT 1 FROM key_epochs)", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::Database),
        "tombstone-ack" => {
            let (tombstone_id, device_id) = split_compound_id(entity_id)?;
            conn.inner()
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM tombstone_acknowledgements
                        WHERE tombstone_id = ?1 AND device_id = ?2
                     )",
                    params![tombstone_id, device_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::Database)
        }
        "tiga-override" => {
            let (scope_type, scope_id) = split_compound_id(entity_id)?;
            conn.inner()
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM tiga_policy_overrides
                        WHERE scope_type = ?1 AND scope_id = ?2
                     )",
                    params![scope_type, scope_id],
                    |row| row.get(0),
                )
                .map_err(StorageError::Database)
        }
        other => Err(StorageError::Validation(format!(
            "cannot inspect source existence for integrity root kind {other}"
        ))),
    }
}

fn upsert_serialized_value<T: Serialize + ?Sized>(
    conn: &VaultConnection,
    entity_kind: &str,
    entity_id: &str,
    value: &T,
    limits: IntegrityRootLimits,
    touched_buckets: &mut BTreeSet<u16>,
) -> StorageResult<()> {
    let mut inputs = Vec::with_capacity(1);
    push_serialized_leaf(&mut inputs, entity_kind, entity_id, value, limits)?;
    let input = inputs.pop().expect("one integrity root input was pushed");
    let bucket = upsert_leaf_raw(conn, input)?;
    touched_buckets.insert(bucket);
    Ok(())
}

fn prepare_leaf_record(
    keyring: &mdbx_crypto::keyring::Keyring,
    input: LeafInput,
) -> StorageResult<LeafRecord> {
    let logical_key = encode_logical_key(&input.entity_kind, &input.entity_id)?;
    let key_hash = digest_parts(KEY_HASH_DOMAIN, &[&logical_key]);
    let value_hash = digest_parts(VALUE_HASH_DOMAIN, &[&input.value]);
    let leaf_hash = digest_parts(LEAF_HASH_DOMAIN, &[&key_hash, &value_hash]);
    let bucket = u16::from_be_bytes([key_hash[0], key_hash[1]]);
    let bucket_bytes = bucket.to_le_bytes();
    let integrity_tag = mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &[
            LEAF_AUTH_DOMAIN,
            &key_hash,
            &logical_key,
            &bucket_bytes,
            &value_hash,
            &leaf_hash,
        ],
    )
    .map_err(StorageError::Crypto)?;
    Ok(LeafRecord {
        key_hash,
        entity_kind: input.entity_kind,
        entity_id: input.entity_id,
        logical_key,
        bucket,
        value_hash,
        leaf_hash,
        integrity_tag,
    })
}

fn upsert_leaf_raw(conn: &VaultConnection, input: LeafInput) -> StorageResult<u16> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation("integrity root update requires a verified unlock".to_string())
    })?;
    let record = prepare_leaf_record(keyring, input)?;
    if let Some(existing) = load_leaf_by_identity(conn, &record.entity_kind, &record.entity_id)? {
        verify_leaf_record(keyring, &existing)?;
        if existing.key_hash != record.key_hash || existing.logical_key != record.logical_key {
            return Err(StorageError::Validation(
                "integrity root logical identity changed its key hash".to_string(),
            ));
        }
    }
    if let Some(existing) = load_leaf_by_key_hash(conn, record.key_hash)? {
        verify_leaf_record(keyring, &existing)?;
        if existing.entity_kind != record.entity_kind || existing.entity_id != record.entity_id {
            return Err(StorageError::Validation(
                "integrity root SHA-256 logical key collision detected".to_string(),
            ));
        }
    }
    insert_leaf_record(conn, &record)?;
    Ok(record.bucket)
}

fn delete_leaf_raw(
    conn: &VaultConnection,
    entity_kind: &str,
    entity_id: &str,
) -> StorageResult<Option<u16>> {
    let Some(existing) = load_leaf_by_identity(conn, entity_kind, entity_id)? else {
        return Ok(None);
    };
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation("integrity root update requires a verified unlock".to_string())
    })?;
    verify_leaf_record(keyring, &existing)?;
    conn.inner().execute(
        "DELETE FROM mdbx_integrity_root_leaves WHERE key_hash = ?1",
        [existing.key_hash.to_vec()],
    )?;
    Ok(Some(existing.bucket))
}

fn insert_leaf_record(conn: &VaultConnection, record: &LeafRecord) -> StorageResult<()> {
    conn.inner().execute(
        "INSERT INTO mdbx_integrity_root_leaves
            (key_hash, entity_kind, entity_id, logical_key, bucket, value_hash,
             leaf_hash, integrity_tag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(key_hash) DO UPDATE SET
            entity_kind = excluded.entity_kind,
            entity_id = excluded.entity_id,
            logical_key = excluded.logical_key,
            bucket = excluded.bucket,
            value_hash = excluded.value_hash,
            leaf_hash = excluded.leaf_hash,
            integrity_tag = excluded.integrity_tag",
        params![
            record.key_hash.to_vec(),
            record.entity_kind,
            record.entity_id,
            record.logical_key,
            i64::from(record.bucket),
            record.value_hash.to_vec(),
            record.leaf_hash.to_vec(),
            record.integrity_tag,
        ],
    )?;
    Ok(())
}

fn load_leaf_by_identity(
    conn: &VaultConnection,
    entity_kind: &str,
    entity_id: &str,
) -> StorageResult<Option<LeafRecord>> {
    load_leaf_query(
        conn,
        "SELECT key_hash, entity_kind, entity_id, logical_key, bucket,
                value_hash, leaf_hash, integrity_tag
         FROM mdbx_integrity_root_leaves
         WHERE entity_kind = ?1 AND entity_id = ?2",
        params![entity_kind, entity_id],
    )
}

fn load_leaf_by_key_hash(
    conn: &VaultConnection,
    key_hash: [u8; HASH_LEN],
) -> StorageResult<Option<LeafRecord>> {
    load_leaf_query(
        conn,
        "SELECT key_hash, entity_kind, entity_id, logical_key, bucket,
                value_hash, leaf_hash, integrity_tag
         FROM mdbx_integrity_root_leaves WHERE key_hash = ?1",
        params![key_hash.to_vec()],
    )
}

fn load_leaf_query<P: rusqlite::Params>(
    conn: &VaultConnection,
    sql: &str,
    query_params: P,
) -> StorageResult<Option<LeafRecord>> {
    conn.inner()
        .query_row(sql, query_params, |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Vec<u8>>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, Vec<u8>>(7)?,
            ))
        })
        .optional()?
        .map(
            |(
                key_hash,
                entity_kind,
                entity_id,
                logical_key,
                bucket,
                value_hash,
                leaf_hash,
                integrity_tag,
            )| {
                Ok(LeafRecord {
                    key_hash: to_hash(key_hash, "leaf key hash")?,
                    entity_kind,
                    entity_id,
                    logical_key,
                    bucket: u16::try_from(bucket).map_err(|_| {
                        StorageError::Validation(
                            "integrity root leaf bucket is outside the supported range".to_string(),
                        )
                    })?,
                    value_hash: to_hash(value_hash, "leaf value hash")?,
                    leaf_hash: to_hash(leaf_hash, "leaf hash")?,
                    integrity_tag,
                })
            },
        )
        .transpose()
}

fn verify_leaf_record(
    keyring: &mdbx_crypto::keyring::Keyring,
    record: &LeafRecord,
) -> StorageResult<()> {
    validate_logical_key_parts(&record.entity_kind, &record.entity_id)?;
    let expected_key = encode_logical_key(&record.entity_kind, &record.entity_id)?;
    if record.logical_key != expected_key
        || record.key_hash != digest_parts(KEY_HASH_DOMAIN, &[&record.logical_key])
        || record.bucket != u16::from_be_bytes([record.key_hash[0], record.key_hash[1]])
        || record.leaf_hash
            != digest_parts(LEAF_HASH_DOMAIN, &[&record.key_hash, &record.value_hash])
    {
        return Err(StorageError::Validation(
            "integrity root leaf structure mismatch".to_string(),
        ));
    }
    let bucket_bytes = record.bucket.to_le_bytes();
    mdbx_crypto::integrity::verify_hmac_sha256(
        &keyring.integrity_subkey,
        &[
            LEAF_AUTH_DOMAIN,
            &record.key_hash,
            &record.logical_key,
            &bucket_bytes,
            &record.value_hash,
            &record.leaf_hash,
        ],
        &record.integrity_tag,
    )
    .map_err(|_| StorageError::Validation("integrity root leaf authentication failed".to_string()))
}

fn build_node_map(records: &[LeafRecord]) -> (NodeMap, [u8; HASH_LEN]) {
    let mut buckets = BTreeMap::<u16, Vec<&LeafRecord>>::new();
    for record in records {
        buckets.entry(record.bucket).or_default().push(record);
    }
    let mut all_nodes = BTreeMap::new();
    let mut current = BTreeMap::<u32, [u8; HASH_LEN]>::new();
    for (bucket, mut leaves) in buckets {
        leaves.sort_by_key(|record| record.key_hash);
        let node_hash = hash_bucket(&leaves);
        if node_hash != empty_hash(0) {
            current.insert(u32::from(bucket), node_hash);
            all_nodes.insert((0, u32::from(bucket)), node_hash);
        }
    }
    for level in 1..=TREE_DEPTH {
        let parent_indexes = current
            .keys()
            .map(|node_index| node_index / 2)
            .collect::<BTreeSet<_>>();
        let mut next = BTreeMap::new();
        for parent_index in parent_indexes {
            let left = current
                .get(&(parent_index * 2))
                .copied()
                .unwrap_or_else(|| empty_hash(level - 1));
            let right = current
                .get(&(parent_index * 2 + 1))
                .copied()
                .unwrap_or_else(|| empty_hash(level - 1));
            let node_hash = hash_node(level, left, right);
            if node_hash != empty_hash(level) {
                next.insert(parent_index, node_hash);
                all_nodes.insert((level, parent_index), node_hash);
            }
        }
        current = next;
    }
    let root_hash = current
        .get(&0)
        .copied()
        .unwrap_or_else(|| empty_hash(TREE_DEPTH));
    (all_nodes, root_hash)
}

fn hash_bucket(records: &[&LeafRecord]) -> [u8; HASH_LEN] {
    let count = (records.len() as u64).to_le_bytes();
    let mut hasher = Sha256::new();
    update_length_delimited(&mut hasher, BUCKET_HASH_DOMAIN);
    update_length_delimited(&mut hasher, &count);
    for record in records {
        update_length_delimited(&mut hasher, &record.key_hash);
        update_length_delimited(&mut hasher, &record.leaf_hash);
    }
    hasher.finalize().into()
}

fn hash_node(level: u8, left: [u8; HASH_LEN], right: [u8; HASH_LEN]) -> [u8; HASH_LEN] {
    let level_bytes = [level];
    digest_parts(NODE_HASH_DOMAIN, &[&level_bytes, &left, &right])
}

fn empty_hash(level: u8) -> [u8; HASH_LEN] {
    let count = 0_u64.to_le_bytes();
    let mut value = digest_parts(BUCKET_HASH_DOMAIN, &[&count]);
    for parent_level in 1..=level {
        value = hash_node(parent_level, value, value);
    }
    value
}

fn insert_node(
    conn: &VaultConnection,
    level: u8,
    node_index: u32,
    node_hash: [u8; HASH_LEN],
) -> StorageResult<()> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation("integrity root update requires a verified unlock".to_string())
    })?;
    let level_bytes = [level];
    let index_bytes = node_index.to_le_bytes();
    let integrity_tag = mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &[NODE_AUTH_DOMAIN, &level_bytes, &index_bytes, &node_hash],
    )
    .map_err(StorageError::Crypto)?;
    conn.inner().execute(
        "INSERT INTO mdbx_integrity_root_nodes
            (level, node_index, node_hash, integrity_tag)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(level, node_index) DO UPDATE SET
            node_hash = excluded.node_hash,
            integrity_tag = excluded.integrity_tag",
        params![
            i64::from(level),
            i64::from(node_index),
            node_hash.to_vec(),
            integrity_tag,
        ],
    )?;
    Ok(())
}

fn delete_node(conn: &VaultConnection, level: u8, node_index: u32) -> StorageResult<()> {
    conn.inner().execute(
        "DELETE FROM mdbx_integrity_root_nodes WHERE level = ?1 AND node_index = ?2",
        params![i64::from(level), i64::from(node_index)],
    )?;
    Ok(())
}

fn recompute_bucket_path(conn: &VaultConnection, bucket: u16) -> StorageResult<()> {
    let records = load_bucket_records(conn, bucket)?;
    let refs = records.iter().collect::<Vec<_>>();
    let mut node_hash = hash_bucket(&refs);
    let mut node_index = u32::from(bucket);
    if node_hash == empty_hash(0) {
        delete_node(conn, 0, node_index)?;
    } else {
        insert_node(conn, 0, node_index, node_hash)?;
    }

    for level in 1..=TREE_DEPTH {
        let sibling_index = node_index ^ 1;
        let sibling_hash = load_node_hash(conn, level - 1, sibling_index)?;
        let parent_index = node_index / 2;
        node_hash = if node_index % 2 == 0 {
            hash_node(level, node_hash, sibling_hash)
        } else {
            hash_node(level, sibling_hash, node_hash)
        };
        if node_hash == empty_hash(level) {
            delete_node(conn, level, parent_index)?;
        } else {
            insert_node(conn, level, parent_index, node_hash)?;
        }
        node_index = parent_index;
    }
    Ok(())
}

fn load_bucket_records(conn: &VaultConnection, bucket: u16) -> StorageResult<Vec<LeafRecord>> {
    let mut statement = conn.inner().prepare(
        "SELECT key_hash, entity_kind, entity_id, logical_key, bucket,
                value_hash, leaf_hash, integrity_tag
         FROM mdbx_integrity_root_leaves
         WHERE bucket = ?1 ORDER BY key_hash ASC",
    )?;
    let rows = statement.query_map([i64::from(bucket)], |row| {
        Ok((
            row.get::<_, Vec<u8>>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Vec<u8>>(5)?,
            row.get::<_, Vec<u8>>(6)?,
            row.get::<_, Vec<u8>>(7)?,
        ))
    })?;
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation("integrity root update requires a verified unlock".to_string())
    })?;
    let mut records = Vec::new();
    for row in rows {
        let (
            key_hash,
            entity_kind,
            entity_id,
            logical_key,
            stored_bucket,
            value_hash,
            leaf_hash,
            integrity_tag,
        ) = row?;
        let record = LeafRecord {
            key_hash: to_hash(key_hash, "leaf key hash")?,
            entity_kind,
            entity_id,
            logical_key,
            bucket: u16::try_from(stored_bucket).map_err(|_| {
                StorageError::Validation(
                    "integrity root leaf bucket is outside the supported range".to_string(),
                )
            })?,
            value_hash: to_hash(value_hash, "leaf value hash")?,
            leaf_hash: to_hash(leaf_hash, "leaf hash")?,
            integrity_tag,
        };
        verify_leaf_record(keyring, &record)?;
        records.push(record);
    }
    Ok(records)
}

fn load_node_hash(
    conn: &VaultConnection,
    level: u8,
    node_index: u32,
) -> StorageResult<[u8; HASH_LEN]> {
    let stored = conn
        .inner()
        .query_row(
            "SELECT node_hash, integrity_tag FROM mdbx_integrity_root_nodes
             WHERE level = ?1 AND node_index = ?2",
            params![i64::from(level), i64::from(node_index)],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()?;
    let Some((node_hash, integrity_tag)) = stored else {
        return Ok(empty_hash(level));
    };
    let node_hash = to_hash(node_hash, "integrity root node hash")?;
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation("integrity root update requires a verified unlock".to_string())
    })?;
    let level_bytes = [level];
    let index_bytes = node_index.to_le_bytes();
    mdbx_crypto::integrity::verify_hmac_sha256(
        &keyring.integrity_subkey,
        &[NODE_AUTH_DOMAIN, &level_bytes, &index_bytes, &node_hash],
        &integrity_tag,
    )
    .map_err(|_| {
        StorageError::Validation("integrity root node authentication failed".to_string())
    })?;
    if node_hash == empty_hash(level) {
        return Err(StorageError::Validation(
            "integrity root stores an explicit empty node".to_string(),
        ));
    }
    Ok(node_hash)
}

fn load_root_hash(conn: &VaultConnection) -> StorageResult<[u8; HASH_LEN]> {
    load_node_hash(conn, TREE_DEPTH, 0)
}

fn verify_against_source(
    conn: &VaultConnection,
    meta: &RootMeta,
    limits: IntegrityRootLimits,
) -> StorageResult<()> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "integrity root verification requires a verified unlock".to_string(),
        )
    })?;
    let inputs = collect_full_leaf_inputs(conn, limits)?;
    let mut expected = Vec::with_capacity(inputs.len());
    for input in inputs {
        expected.push(prepare_leaf_record(keyring, input)?);
    }
    expected.sort_by_key(|record| record.key_hash);
    let stored = load_all_leaf_records(conn)?;
    if expected != stored {
        let first_difference = expected
            .iter()
            .zip(stored.iter())
            .find(|(left, right)| left != right)
            .map(|(left, right)| {
                format!(
                    "expected {}/{} but stored {}/{}",
                    left.entity_kind, left.entity_id, right.entity_kind, right.entity_id
                )
            })
            .unwrap_or_else(|| "leaf counts differ".to_string());
        return Err(StorageError::Validation(
            format!(
                "integrity root leaves do not match the current synchronized state ({first_difference}; expected {}, stored {})",
                expected.len(),
                stored.len()
            ),
        ));
    }
    if meta.leaf_count != expected.len() as u64 {
        return Err(StorageError::Validation(
            "integrity root metadata leaf count mismatch".to_string(),
        ));
    }

    let (expected_nodes, expected_root) = build_node_map(&expected);
    let stored_nodes = load_all_nodes(conn)?;
    if expected_nodes != stored_nodes || expected_root != meta.root_hash {
        return Err(StorageError::Validation(
            "integrity root tree does not match its authenticated metadata".to_string(),
        ));
    }
    let anchors = current_anchors(conn)?;
    if anchors != (meta.latest_commit_seq, meta.latest_delta_seq) {
        return Err(StorageError::Validation(
            "integrity root inventory anchors are stale".to_string(),
        ));
    }
    Ok(())
}

fn load_all_leaf_records(conn: &VaultConnection) -> StorageResult<Vec<LeafRecord>> {
    let mut statement = conn.inner().prepare(
        "SELECT key_hash, entity_kind, entity_id, logical_key, bucket,
                value_hash, leaf_hash, integrity_tag
         FROM mdbx_integrity_root_leaves ORDER BY key_hash ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, Vec<u8>>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Vec<u8>>(5)?,
            row.get::<_, Vec<u8>>(6)?,
            row.get::<_, Vec<u8>>(7)?,
        ))
    })?;
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "integrity root verification requires a verified unlock".to_string(),
        )
    })?;
    let mut records = Vec::new();
    for row in rows {
        let (
            key_hash,
            entity_kind,
            entity_id,
            logical_key,
            bucket,
            value_hash,
            leaf_hash,
            integrity_tag,
        ) = row?;
        let record = LeafRecord {
            key_hash: to_hash(key_hash, "leaf key hash")?,
            entity_kind,
            entity_id,
            logical_key,
            bucket: u16::try_from(bucket).map_err(|_| {
                StorageError::Validation(
                    "integrity root leaf bucket is outside the supported range".to_string(),
                )
            })?,
            value_hash: to_hash(value_hash, "leaf value hash")?,
            leaf_hash: to_hash(leaf_hash, "leaf hash")?,
            integrity_tag,
        };
        verify_leaf_record(keyring, &record)?;
        records.push(record);
    }
    Ok(records)
}

fn load_all_nodes(conn: &VaultConnection) -> StorageResult<NodeMap> {
    let mut statement = conn.inner().prepare(
        "SELECT level, node_index, node_hash, integrity_tag
         FROM mdbx_integrity_root_nodes ORDER BY level ASC, node_index ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, Vec<u8>>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "integrity root verification requires a verified unlock".to_string(),
        )
    })?;
    let mut nodes = BTreeMap::new();
    for row in rows {
        let (level, node_index, node_hash, integrity_tag) = row?;
        let level = u8::try_from(level).map_err(|_| {
            StorageError::Validation("integrity root node level is invalid".to_string())
        })?;
        let node_index = u32::try_from(node_index).map_err(|_| {
            StorageError::Validation("integrity root node index is invalid".to_string())
        })?;
        let node_hash = to_hash(node_hash, "integrity root node hash")?;
        let level_bytes = [level];
        let index_bytes = node_index.to_le_bytes();
        mdbx_crypto::integrity::verify_hmac_sha256(
            &keyring.integrity_subkey,
            &[NODE_AUTH_DOMAIN, &level_bytes, &index_bytes, &node_hash],
            &integrity_tag,
        )
        .map_err(|_| {
            StorageError::Validation("integrity root node authentication failed".to_string())
        })?;
        if level > TREE_DEPTH || node_hash == empty_hash(level) {
            return Err(StorageError::Validation(
                "integrity root contains an invalid sparse node".to_string(),
            ));
        }
        nodes.insert((level, node_index), node_hash);
    }
    Ok(nodes)
}

fn seal_meta(
    conn: &VaultConnection,
    generation: u64,
    leaf_count: u64,
    root_hash: [u8; HASH_LEN],
    latest_commit_seq: u64,
    latest_delta_seq: u64,
) -> StorageResult<()> {
    let meta = load_meta(conn)?;
    let updated_at = chrono::Utc::now().to_rfc3339();
    let next = RootMeta {
        profile: INTEGRITY_ROOT_PROFILE_V1.to_string(),
        state: "established".to_string(),
        vault_id: meta.vault_id,
        schema_version: meta.schema_version,
        generation,
        leaf_count,
        root_hash,
        latest_commit_seq,
        latest_delta_seq,
        updated_at,
        integrity_tag: None,
    };
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation("integrity root metadata requires a verified unlock".to_string())
    })?;
    let tag = compute_meta_tag(keyring, &next)?;
    let generation = i64::try_from(next.generation).map_err(|_| {
        StorageError::Validation("integrity root generation exceeds SQLite range".to_string())
    })?;
    let leaf_count = i64::try_from(next.leaf_count).map_err(|_| {
        StorageError::Validation("integrity root leaf count exceeds SQLite range".to_string())
    })?;
    let latest_commit_seq = i64::try_from(next.latest_commit_seq).map_err(|_| {
        StorageError::Validation("integrity root commit anchor exceeds SQLite range".to_string())
    })?;
    let latest_delta_seq = i64::try_from(next.latest_delta_seq).map_err(|_| {
        StorageError::Validation("integrity root delta anchor exceeds SQLite range".to_string())
    })?;
    conn.inner().execute(
        "UPDATE mdbx_integrity_root_meta
         SET profile = ?1, state = ?2, vault_id = ?3, schema_version = ?4,
             generation = ?5, leaf_count = ?6, root_hash = ?7,
             latest_commit_seq = ?8, latest_delta_seq = ?9, updated_at = ?10,
             integrity_tag = ?11
         WHERE meta_id = 1",
        params![
            next.profile,
            next.state,
            next.vault_id,
            i64::from(next.schema_version),
            generation,
            leaf_count,
            next.root_hash.to_vec(),
            latest_commit_seq,
            latest_delta_seq,
            next.updated_at,
            tag,
        ],
    )?;
    Ok(())
}

fn load_meta_optional(conn: &VaultConnection) -> StorageResult<Option<RootMeta>> {
    load_meta_optional_connection(conn.inner())
}

fn load_meta_optional_connection(conn: &Connection) -> StorageResult<Option<RootMeta>> {
    if !table_exists(conn, "mdbx_integrity_root_meta")? {
        return Ok(None);
    }
    Ok(Some(load_meta_connection(conn)?))
}

fn load_meta(conn: &VaultConnection) -> StorageResult<RootMeta> {
    load_meta_connection(conn.inner())
}

fn load_meta_connection(conn: &Connection) -> StorageResult<RootMeta> {
    conn.query_row(
        "SELECT profile, state, vault_id, schema_version, generation,
                    leaf_count, root_hash, latest_commit_seq, latest_delta_seq,
                    updated_at, integrity_tag
             FROM mdbx_integrity_root_meta WHERE meta_id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<Vec<u8>>>(10)?,
            ))
        },
    )
    .map_err(StorageError::Database)
    .and_then(
        |(
            profile,
            state,
            vault_id,
            schema_version,
            generation,
            leaf_count,
            root_hash,
            latest_commit_seq,
            latest_delta_seq,
            updated_at,
            integrity_tag,
        )| {
            Ok(RootMeta {
                profile,
                state,
                vault_id,
                schema_version: u32::try_from(schema_version).map_err(|_| {
                    StorageError::Validation("integrity root schema version is invalid".to_string())
                })?,
                generation: nonnegative_u64(generation)?,
                leaf_count: nonnegative_u64(leaf_count)?,
                root_hash: to_hash(root_hash, "integrity root metadata hash")?,
                latest_commit_seq: nonnegative_u64(latest_commit_seq)?,
                latest_delta_seq: nonnegative_u64(latest_delta_seq)?,
                updated_at,
                integrity_tag,
            })
        },
    )
}

fn disabled_status() -> IntegrityRootStatus {
    IntegrityRootStatus {
        state: IntegrityRootState::Disabled,
        profile: None,
        generation: 0,
        leaf_count: 0,
        root_hash: None,
        latest_commit_seq: 0,
        latest_delta_seq: 0,
        authenticated: false,
    }
}

fn status_from_meta(
    meta: RootMeta,
    state: IntegrityRootState,
    authenticated: bool,
) -> IntegrityRootStatus {
    IntegrityRootStatus {
        state,
        profile: Some(meta.profile),
        generation: meta.generation,
        leaf_count: meta.leaf_count,
        root_hash: Some(meta.root_hash),
        latest_commit_seq: meta.latest_commit_seq,
        latest_delta_seq: meta.latest_delta_seq,
        authenticated,
    }
}

fn verify_meta(conn: &VaultConnection, meta: &RootMeta) -> StorageResult<()> {
    if meta.profile != INTEGRITY_ROOT_PROFILE_V1 {
        return Err(StorageError::Validation(format!(
            "unsupported integrity root profile: {}",
            meta.profile
        )));
    }
    if meta.state != "established" {
        return Err(StorageError::Validation(format!(
            "integrity root is not established: {}",
            meta.state
        )));
    }
    let (vault_id, schema_version) = vault_identity(conn)?;
    if meta.vault_id != vault_id || meta.schema_version != schema_version {
        return Err(StorageError::Validation(
            "integrity root metadata belongs to a different vault or schema".to_string(),
        ));
    }
    let tag = meta.integrity_tag.as_deref().ok_or_else(|| {
        StorageError::Validation("established integrity root is missing its HMAC tag".to_string())
    })?;
    if tag.len() != HASH_LEN {
        return Err(StorageError::Validation(
            "integrity root metadata HMAC tag must be 32 bytes".to_string(),
        ));
    }
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "integrity root verification requires a verified unlock".to_string(),
        )
    })?;
    let schema_version = meta.schema_version.to_le_bytes();
    let generation = meta.generation.to_le_bytes();
    let leaf_count = meta.leaf_count.to_le_bytes();
    let latest_commit_seq = meta.latest_commit_seq.to_le_bytes();
    let latest_delta_seq = meta.latest_delta_seq.to_le_bytes();
    mdbx_crypto::integrity::verify_hmac_sha256(
        &keyring.integrity_subkey,
        &[
            META_AUTH_DOMAIN,
            meta.profile.as_bytes(),
            meta.state.as_bytes(),
            meta.vault_id.as_bytes(),
            &schema_version,
            &generation,
            &leaf_count,
            &meta.root_hash,
            &latest_commit_seq,
            &latest_delta_seq,
            meta.updated_at.as_bytes(),
        ],
        tag,
    )
    .map_err(|_| {
        StorageError::Validation("integrity root metadata authentication failed".to_string())
    })
}

fn compute_meta_tag(
    keyring: &mdbx_crypto::keyring::Keyring,
    meta: &RootMeta,
) -> StorageResult<Vec<u8>> {
    let schema_version = meta.schema_version.to_le_bytes();
    let generation = meta.generation.to_le_bytes();
    let leaf_count = meta.leaf_count.to_le_bytes();
    let latest_commit_seq = meta.latest_commit_seq.to_le_bytes();
    let latest_delta_seq = meta.latest_delta_seq.to_le_bytes();
    mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &[
            META_AUTH_DOMAIN,
            meta.profile.as_bytes(),
            meta.state.as_bytes(),
            meta.vault_id.as_bytes(),
            &schema_version,
            &generation,
            &leaf_count,
            &meta.root_hash,
            &latest_commit_seq,
            &latest_delta_seq,
            meta.updated_at.as_bytes(),
        ],
    )
    .map_err(StorageError::Crypto)
}

fn compute_peer_checkpoint_tag(
    conn: &VaultConnection,
    profile: &str,
    generation: u64,
    leaf_count: u64,
    root_hash: &[u8],
    latest_commit_sequence: u64,
    latest_delta_sequence: u64,
) -> StorageResult<Vec<u8>> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "peer integrity-root checkpoint requires a verified unlock".to_string(),
        )
    })?;
    let (vault_id, schema_version) = vault_identity(conn)?;
    let schema_version = schema_version.to_le_bytes();
    let generation = generation.to_le_bytes();
    let leaf_count = leaf_count.to_le_bytes();
    let latest_commit_sequence = latest_commit_sequence.to_le_bytes();
    let latest_delta_sequence = latest_delta_sequence.to_le_bytes();
    mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &[
            PEER_CHECKPOINT_AUTH_DOMAIN,
            vault_id.as_bytes(),
            &schema_version,
            profile.as_bytes(),
            &generation,
            &leaf_count,
            root_hash,
            &latest_commit_sequence,
            &latest_delta_sequence,
        ],
    )
    .map_err(StorageError::Crypto)
}

fn verify_peer_checkpoint_tag(
    conn: &VaultConnection,
    checkpoint: &AuthenticatedStateRootCheckpoint,
) -> StorageResult<()> {
    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "peer integrity-root checkpoint requires a verified unlock".to_string(),
        )
    })?;
    let (vault_id, schema_version) = vault_identity(conn)?;
    let schema_version = schema_version.to_le_bytes();
    let generation = checkpoint.generation.to_le_bytes();
    let leaf_count = checkpoint.leaf_count.to_le_bytes();
    let latest_commit_sequence = checkpoint.latest_commit_sequence.to_le_bytes();
    let latest_delta_sequence = checkpoint.latest_delta_sequence.to_le_bytes();
    mdbx_crypto::integrity::verify_hmac_sha256(
        &keyring.integrity_subkey,
        &[
            PEER_CHECKPOINT_AUTH_DOMAIN,
            vault_id.as_bytes(),
            &schema_version,
            checkpoint.profile.as_bytes(),
            &generation,
            &leaf_count,
            &checkpoint.root_hash,
            &latest_commit_sequence,
            &latest_delta_sequence,
        ],
        &checkpoint.authentication_tag,
    )
    .map_err(|_| {
        StorageError::Validation(
            "authenticated peer integrity-root checkpoint verification failed".to_string(),
        )
    })
}

fn current_anchors(conn: &VaultConnection) -> StorageResult<(u64, u64)> {
    let commit_seq: i64 = conn.inner().query_row(
        "SELECT COALESCE(MAX(inventory_seq), 0) FROM commit_inventory",
        [],
        |row| row.get(0),
    )?;
    let delta_seq: i64 = conn.inner().query_row(
        "SELECT COALESCE(MAX(batch_seq), 0) FROM sync_delta_batches",
        [],
        |row| row.get(0),
    )?;
    Ok((nonnegative_u64(commit_seq)?, nonnegative_u64(delta_seq)?))
}

fn count_leaves(conn: &VaultConnection) -> StorageResult<u64> {
    let count: i64 = conn.inner().query_row(
        "SELECT COUNT(*) FROM mdbx_integrity_root_leaves",
        [],
        |row| row.get(0),
    )?;
    nonnegative_u64(count)
}

fn vault_identity(conn: &VaultConnection) -> StorageResult<(String, u32)> {
    let (vault_id, schema_version): (String, i64) = conn.inner().query_row(
        "SELECT vault_id, schema_version FROM vault_meta LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((
        vault_id,
        u32::try_from(schema_version)
            .map_err(|_| StorageError::Validation("vault schema version is invalid".to_string()))?,
    ))
}

fn critical_extension_enabled(conn: &VaultConnection) -> StorageResult<bool> {
    let value: String = conn.inner().query_row(
        "SELECT critical_extensions FROM vault_meta LIMIT 1",
        [],
        |row| row.get(0),
    )?;
    crate::migration::has_critical_extension(&value, AUTHENTICATED_STATE_ROOT_EXTENSION)
}

fn require_verified_unlocked(conn: &VaultConnection) -> StorageResult<()> {
    if conn.keyring().is_none() {
        return Err(StorageError::Validation(
            "integrity root operations require a verified-unlocked vault".to_string(),
        ));
    }
    match vault_header_integrity::check(conn)? {
        VaultHeaderIntegrityStatus::Verified => Ok(()),
        VaultHeaderIntegrityStatus::Pending => Err(StorageError::Validation(
            "integrity root operations require a sealed vault header".to_string(),
        )),
        VaultHeaderIntegrityStatus::UnverifiedLocked => Err(StorageError::Validation(
            "integrity root operations require a verified-unlocked vault".to_string(),
        )),
    }
}

fn parse_state(value: &str) -> StorageResult<IntegrityRootState> {
    match value {
        "pending" => Ok(IntegrityRootState::Pending),
        "building" => Ok(IntegrityRootState::Building),
        "established" => Ok(IntegrityRootState::Established),
        "stale" => Ok(IntegrityRootState::Stale),
        other => Err(StorageError::Validation(format!(
            "unsupported integrity root state: {other}"
        ))),
    }
}

fn encode_logical_key(entity_kind: &str, entity_id: &str) -> StorageResult<Vec<u8>> {
    validate_logical_key_parts(entity_kind, entity_id)?;
    let kind_len = u32::try_from(entity_kind.len()).map_err(|_| {
        StorageError::Validation("integrity root entity kind is too large".to_string())
    })?;
    let id_len = u32::try_from(entity_id.len()).map_err(|_| {
        StorageError::Validation("integrity root entity ID is too large".to_string())
    })?;
    let mut value = Vec::with_capacity(8 + entity_kind.len() + entity_id.len());
    value.extend_from_slice(&kind_len.to_le_bytes());
    value.extend_from_slice(entity_kind.as_bytes());
    value.extend_from_slice(&id_len.to_le_bytes());
    value.extend_from_slice(entity_id.as_bytes());
    Ok(value)
}

fn validate_logical_key_parts(entity_kind: &str, entity_id: &str) -> StorageResult<()> {
    if entity_kind.is_empty() || entity_kind.len() > MAX_ENTITY_KIND_BYTES {
        return Err(StorageError::Validation(format!(
            "integrity root entity kind must contain 1 to {MAX_ENTITY_KIND_BYTES} bytes"
        )));
    }
    if entity_id.is_empty() || entity_id.len() > MAX_ENTITY_ID_BYTES {
        return Err(StorageError::Validation(format!(
            "integrity root entity ID must contain 1 to {MAX_ENTITY_ID_BYTES} bytes"
        )));
    }
    if 8 + entity_kind.len() + entity_id.len() > MAX_LOGICAL_KEY_BYTES {
        return Err(StorageError::Validation(
            "integrity root logical key exceeds its bounded size".to_string(),
        ));
    }
    Ok(())
}

fn compound_id(first: &str, second: &str) -> String {
    format!("{first}\u{1f}{second}")
}

fn split_compound_id(value: &str) -> StorageResult<(&str, &str)> {
    value.split_once('\u{1f}').ok_or_else(|| {
        StorageError::Validation("integrity root compound entity ID is invalid".to_string())
    })
}

fn digest_parts(domain: &[u8], parts: &[&[u8]]) -> [u8; HASH_LEN] {
    let mut hasher = Sha256::new();
    update_length_delimited(&mut hasher, domain);
    for part in parts {
        update_length_delimited(&mut hasher, part);
    }
    hasher.finalize().into()
}

fn update_length_delimited(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn to_hash(value: Vec<u8>, label: &str) -> StorageResult<[u8; HASH_LEN]> {
    value
        .try_into()
        .map_err(|_| StorageError::Validation(format!("{label} must be exactly {HASH_LEN} bytes")))
}

fn nonnegative_u64(value: i64) -> StorageResult<u64> {
    u64::try_from(value).map_err(|_| {
        StorageError::Validation("integrity root stored integer is negative".to_string())
    })
}

fn table_exists(conn: &Connection, table: &str) -> StorageResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get(0),
    )
    .map_err(StorageError::Database)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ProjectRepo};
    use crate::unlock::UnlockService;

    fn setup_unlocked() -> VaultConnection {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, "root-password").unwrap();
        conn
    }

    fn resign_checkpoint(
        conn: &VaultConnection,
        checkpoint: &mut AuthenticatedStateRootCheckpoint,
    ) {
        checkpoint.authentication_tag = compute_peer_checkpoint_tag(
            conn,
            &checkpoint.profile,
            checkpoint.generation,
            checkpoint.leaf_count,
            &checkpoint.root_hash,
            checkpoint.latest_commit_sequence,
            checkpoint.latest_delta_sequence,
        )
        .unwrap();
    }

    #[test]
    fn root_is_disabled_until_explicitly_enabled() {
        let conn = setup_unlocked();
        let status = IntegrityRootService::status(&conn).unwrap();
        assert_eq!(status.state, IntegrityRootState::Disabled);
        assert!(!status.authenticated);
    }

    #[test]
    fn integrity_root_checkpoint_authenticates_and_rejects_peer_rollback() {
        let conn = setup_unlocked();
        IntegrityRootService::enable(&conn).unwrap();
        let first = IntegrityRootService::issue_checkpoint(&conn).unwrap();
        let verified = IntegrityRootService::verify_checkpoint(&conn, &first).unwrap();
        assert_eq!(verified.root_hash.as_slice(), first.root_hash);
        assert_eq!(
            IntegrityRootService::compare_checkpoints(&conn, &first, &first).unwrap(),
            IntegrityRootCheckpointRelation::Unchanged
        );

        ProjectRepo::create(
            &conn,
            &CommitContext::new("checkpoint-device".to_string()),
            "checkpoint advance",
            None,
            None,
        )
        .unwrap();
        let advanced = IntegrityRootService::issue_checkpoint(&conn).unwrap();
        assert_eq!(
            IntegrityRootService::compare_checkpoints(&conn, &first, &advanced).unwrap(),
            IntegrityRootCheckpointRelation::Advanced
        );
        assert!(
            IntegrityRootService::compare_checkpoints(&conn, &advanced, &first)
                .unwrap_err()
                .to_string()
                .contains("rolled back its generation")
        );

        let mut tampered = advanced.clone();
        tampered.root_hash[0] ^= 1;
        assert!(IntegrityRootService::verify_checkpoint(&conn, &tampered)
            .unwrap_err()
            .to_string()
            .contains("verification failed"));

        let mut equivocated = first.clone();
        equivocated.root_hash[0] ^= 1;
        resign_checkpoint(&conn, &mut equivocated);
        assert!(
            IntegrityRootService::compare_checkpoints(&conn, &first, &equivocated)
                .unwrap_err()
                .to_string()
                .contains("changed within one generation")
        );

        let mut anchor_rollback = advanced.clone();
        anchor_rollback.generation += 1;
        anchor_rollback.latest_commit_sequence = 0;
        resign_checkpoint(&conn, &mut anchor_rollback);
        assert!(
            IntegrityRootService::compare_checkpoints(&conn, &advanced, &anchor_rollback)
                .unwrap_err()
                .to_string()
                .contains("rolled back an inventory anchor")
        );

        let foreign = setup_unlocked();
        assert!(IntegrityRootService::verify_checkpoint(&foreign, &advanced).is_err());
    }

    #[test]
    fn root_rebuilds_verifies_and_updates_with_one_project_mutation() {
        let conn = setup_unlocked();
        IntegrityRootService::enable(&conn).unwrap();
        let before = IntegrityRootService::verify(&conn).unwrap();

        let context = CommitContext::new("root-device".to_string());
        let project = ProjectRepo::create(&conn, &context, "root project", None, None).unwrap();
        let after = IntegrityRootService::verify(&conn).unwrap();
        assert!(after.generation > before.generation);
        assert_ne!(after.root_hash, before.root_hash);
        assert!(after.leaf_count > before.leaf_count);
        assert!(!project.project_id.is_empty());
    }

    #[test]
    fn enabling_root_registers_an_opt_in_critical_extension_without_schema_bump() {
        let conn = setup_unlocked();
        IntegrityRootService::enable(&conn).unwrap();

        let (schema_version, critical_extensions): (i64, String) = conn
            .inner()
            .query_row(
                "SELECT schema_version, critical_extensions FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(schema_version, i64::from(crate::schema::SCHEMA_VERSION));
        assert!(crate::migration::has_critical_extension(
            &critical_extensions,
            AUTHENTICATED_STATE_ROOT_EXTENSION
        )
        .unwrap());
        validate_established_schema(conn.inner()).unwrap();
    }

    #[test]
    fn metadata_authentication_failure_rolls_back_the_enclosing_mutation() {
        let conn = setup_unlocked();
        IntegrityRootService::enable(&conn).unwrap();
        let before: (i64, i64, i64) = conn
            .inner()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM projects),
                    (SELECT COUNT(*) FROM commits),
                    (SELECT COUNT(*) FROM sync_delta_batches)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE mdbx_integrity_root_meta SET integrity_tag = zeroblob(32)",
                [],
            )
            .unwrap();

        let context = CommitContext::new("rollback-device".to_string());
        let error = ProjectRepo::create(&conn, &context, "must roll back", None, None).unwrap_err();
        assert!(error.to_string().contains("metadata authentication"));
        let after: (i64, i64, i64) = conn
            .inner()
            .query_row(
                "SELECT
                    (SELECT COUNT(*) FROM projects),
                    (SELECT COUNT(*) FROM commits),
                    (SELECT COUNT(*) FROM sync_delta_batches)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn sync_state_extensions_are_added_and_removed_from_the_root() {
        let conn = setup_unlocked();
        IntegrityRootService::enable(&conn).unwrap();
        let source_commit_id: String = conn
            .inner()
            .query_row(
                "SELECT commit_id FROM commit_inventory ORDER BY inventory_seq LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let extension_key = "com.monica.test-root";
        let mut extensions = BTreeMap::new();
        extensions.insert(
            extension_key.to_string(),
            serde_json::json!({"opaque": [1, 2, 3]}),
        );
        conn.with_immediate_transaction(|| {
            sync_state::persist_sync_state_extensions(&conn, &extensions, &source_commit_id)
        })
        .unwrap();
        IntegrityRootService::verify(&conn).unwrap();
        let present: bool = conn
            .inner()
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM mdbx_integrity_root_leaves
                    WHERE entity_kind = 'sync-extension' AND entity_id = ?1
                 )",
                [extension_key],
                |row| row.get(0),
            )
            .unwrap();
        assert!(present);

        conn.with_immediate_transaction(|| {
            conn.inner().execute(
                "DELETE FROM sync_state_extensions WHERE extension_key = ?1",
                [extension_key],
            )?;
            Ok(())
        })
        .unwrap();
        IntegrityRootService::verify(&conn).unwrap();
        let present: bool = conn
            .inner()
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM mdbx_integrity_root_leaves
                    WHERE entity_kind = 'sync-extension' AND entity_id = ?1
                 )",
                [extension_key],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!present);
    }

    #[test]
    fn root_verification_detects_source_tampering() {
        let conn = setup_unlocked();
        IntegrityRootService::enable(&conn).unwrap();
        conn.inner()
            .execute(
                "UPDATE mdbx_integrity_root_leaves SET value_hash = zeroblob(32)",
                [],
            )
            .unwrap();
        let error = IntegrityRootService::verify(&conn).unwrap_err();
        assert!(error.to_string().contains("leaf") || error.to_string().contains("authentication"));
    }

    #[test]
    fn root_enabled_vault_reopens_and_rejects_offline_tree_tampering() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-integrity-root-reopen-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        {
            let mut conn = VaultConnection::create(&path).unwrap();
            initialize_vault(&conn, &VaultInitParams::default()).unwrap();
            UnlockService::setup_password(&mut conn, "reopen-root-password").unwrap();
            IntegrityRootService::enable(&conn).unwrap();
        }
        {
            let mut reopened = VaultConnection::open(&path).unwrap();
            UnlockService::unlock_with_password(&mut reopened, "reopen-root-password").unwrap();
            IntegrityRootService::verify(&reopened).unwrap();
        }
        {
            let raw = Connection::open(&path).unwrap();
            raw.execute(
                "UPDATE mdbx_integrity_root_nodes SET node_hash = zeroblob(32)
                 WHERE level = 16 AND node_index = 0",
                [],
            )
            .unwrap();
        }
        {
            let mut reopened = VaultConnection::open(&path).unwrap();
            let error = UnlockService::unlock_with_password(&mut reopened, "reopen-root-password")
                .unwrap_err();
            assert!(error.to_string().contains("node authentication"));
            assert!(reopened.keyring().is_none());
        }
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn old_schema_without_root_remains_additive() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        assert!(!critical_extension_enabled(&conn).unwrap());
        assert!(!table_exists(conn.inner(), "mdbx_integrity_root_meta").unwrap());
    }
}
