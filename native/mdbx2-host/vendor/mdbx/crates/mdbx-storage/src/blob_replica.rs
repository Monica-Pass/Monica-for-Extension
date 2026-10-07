use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::blob_lifecycle::{
    collect_external_blob_references, collect_provider_inventory, BlobLifecycleLimits,
    ExternalBlobReferenceInventory, MAX_BLOB_LIFECYCLE_ITEMS,
};
use crate::blob_store::{
    validate_blob_id, EncryptedBlobMetadata, EncryptedBlobTransferStore,
    ManageableEncryptedBlobStore, MAX_BLOB_PAGE_SIZE,
};
use crate::blob_transfer::{BlobTransferCheckpoint, BlobTransferLimits, BlobTransferService};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobReplicaPageRequest {
    pub cursor: Option<String>,
    pub checkpoint: Option<String>,
    pub page_size: usize,
    pub limits: BlobLifecycleLimits,
}

impl BlobReplicaPageRequest {
    pub fn new(
        cursor: Option<String>,
        checkpoint: Option<String>,
        page_size: usize,
        limits: BlobLifecycleLimits,
    ) -> StorageResult<Self> {
        limits.validate()?;
        if !(1..=MAX_BLOB_PAGE_SIZE).contains(&page_size) {
            return Err(StorageError::Validation(format!(
                "Blob replica page size must be between 1 and {MAX_BLOB_PAGE_SIZE}"
            )));
        }
        if let Some(cursor) = cursor.as_deref() {
            validate_blob_id(cursor)?;
            if checkpoint.is_none() {
                return Err(StorageError::Validation(
                    "Blob replica cursor requires a plan checkpoint".to_string(),
                ));
            }
        }
        if let Some(checkpoint) = checkpoint.as_deref() {
            validate_blob_id(checkpoint).map_err(|_| {
                StorageError::Validation(
                    "Blob replica checkpoint must be a SHA-256 hex digest".to_string(),
                )
            })?;
        }
        Ok(Self {
            cursor,
            checkpoint,
            page_size,
            limits,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlobReplicaState {
    TransferRequired,
    SourceMissing,
    SourceSizeInvalid,
    DestinationConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobReplicaItem {
    pub blob_id: String,
    pub declared_max_bytes: u64,
    pub source_size: Option<u64>,
    pub destination_size: Option<u64>,
    pub state: BlobReplicaState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobReplicaPage {
    pub plan_token: String,
    pub source_namespace_id: String,
    pub destination_namespace_id: String,
    pub raw_reference_count: usize,
    pub unique_reference_count: usize,
    pub items: Vec<BlobReplicaItem>,
    pub next_cursor: Option<String>,
}

pub const MAX_BLOB_REPLICA_ITEMS_PER_RUN: usize = 10_000;

pub trait ReplicableEncryptedBlobStore:
    ManageableEncryptedBlobStore + EncryptedBlobTransferStore
{
}

impl<T> ReplicableEncryptedBlobStore for T where
    T: ManageableEncryptedBlobStore + EncryptedBlobTransferStore
{
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobReplicaTransferCheckpoint {
    pub owner_id: String,
    pub plan_token: Option<String>,
    pub cursor: Option<String>,
    pub current: Option<BlobTransferCheckpoint>,
}

impl BlobReplicaTransferCheckpoint {
    pub fn new(owner_id: String) -> StorageResult<Self> {
        validate_owner_id(&owner_id)?;
        Ok(Self {
            owner_id,
            plan_token: None,
            cursor: None,
            current: None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobReplicaTransferLimits {
    pub lifecycle: BlobLifecycleLimits,
    pub page_size: usize,
    pub max_items_per_run: usize,
    pub transfer: BlobTransferLimits,
}

impl Default for BlobReplicaTransferLimits {
    fn default() -> Self {
        Self {
            lifecycle: BlobLifecycleLimits::default(),
            page_size: 100,
            max_items_per_run: 100,
            transfer: BlobTransferLimits::default(),
        }
    }
}

impl BlobReplicaTransferLimits {
    fn validate(self) -> StorageResult<()> {
        self.lifecycle.validate()?;
        self.transfer.validate()?;
        if !(1..=MAX_BLOB_PAGE_SIZE).contains(&self.page_size) {
            return Err(StorageError::Validation(format!(
                "Blob replica transfer page size must be between 1 and {MAX_BLOB_PAGE_SIZE}"
            )));
        }
        if !(1..=MAX_BLOB_REPLICA_ITEMS_PER_RUN).contains(&self.max_items_per_run) {
            return Err(StorageError::Validation(format!(
                "Blob replica transfer item count must be between 1 and {MAX_BLOB_REPLICA_ITEMS_PER_RUN}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobReplicaTransferResult {
    pub checkpoint: BlobReplicaTransferCheckpoint,
    pub completed: bool,
    pub transferred_items: usize,
    pub blocked_items: Vec<BlobReplicaItem>,
}

pub struct BlobReplicaService;

impl BlobReplicaService {
    pub fn page(
        conn: &VaultConnection,
        source: &dyn ManageableEncryptedBlobStore,
        destination: &dyn ManageableEncryptedBlobStore,
        request: BlobReplicaPageRequest,
    ) -> StorageResult<BlobReplicaPage> {
        request.limits.validate()?;
        if conn.keyring().is_none() {
            return Err(StorageError::Validation(
                "Blob replica planning requires an unlocked encrypted vault".to_string(),
            ));
        }
        let source_namespace_id = validate_namespace(source.namespace_id()?)?;
        let destination_namespace_id = validate_namespace(destination.namespace_id()?)?;
        if source_namespace_id == destination_namespace_id {
            return Err(StorageError::Validation(
                "Blob replica source and destination namespaces must differ".to_string(),
            ));
        }
        let references = collect_external_blob_references(conn, request.limits)?;
        let source_inventory = collect_provider_inventory(source, request.limits)?;
        let destination_inventory = collect_provider_inventory(destination, request.limits)?;
        let vault_id = vault_id(conn)?;
        let plan_token = compute_plan_token(
            &vault_id,
            &source_namespace_id,
            &destination_namespace_id,
            &references,
            &source_inventory,
            &destination_inventory,
        );
        if let Some(expected) = request.checkpoint.as_deref() {
            if expected != plan_token {
                return Err(StorageError::ConstraintViolation(
                    "Blob replica plan changed; create a new checkpoint".to_string(),
                ));
            }
        }

        let mut actionable = Vec::new();
        for (blob_id, maximum_bytes) in &references.blobs {
            let source_blob = source_inventory.get(blob_id);
            let destination_blob = destination_inventory.get(blob_id);
            let declared_max_bytes = u64::try_from(*maximum_bytes).map_err(|_| {
                StorageError::Validation("Blob reference size exceeds SQLite range".to_string())
            })?;
            let item = match source_blob {
                None => BlobReplicaItem {
                    blob_id: blob_id.clone(),
                    declared_max_bytes,
                    source_size: None,
                    destination_size: destination_blob.map(|blob| blob.stored_size),
                    state: BlobReplicaState::SourceMissing,
                },
                Some(source_blob)
                    if source_blob.stored_size == 0
                        || source_blob.stored_size > declared_max_bytes =>
                {
                    BlobReplicaItem {
                        blob_id: blob_id.clone(),
                        declared_max_bytes,
                        source_size: Some(source_blob.stored_size),
                        destination_size: destination_blob.map(|blob| blob.stored_size),
                        state: BlobReplicaState::SourceSizeInvalid,
                    }
                }
                Some(source_blob)
                    if destination_blob
                        .is_some_and(|blob| blob.stored_size != source_blob.stored_size) =>
                {
                    BlobReplicaItem {
                        blob_id: blob_id.clone(),
                        declared_max_bytes,
                        source_size: Some(source_blob.stored_size),
                        destination_size: destination_blob.map(|blob| blob.stored_size),
                        state: BlobReplicaState::DestinationConflict,
                    }
                }
                Some(_) if destination_blob.is_some() => continue,
                Some(source_blob) => BlobReplicaItem {
                    blob_id: blob_id.clone(),
                    declared_max_bytes,
                    source_size: Some(source_blob.stored_size),
                    destination_size: None,
                    state: BlobReplicaState::TransferRequired,
                },
            };
            if actionable.len() >= MAX_BLOB_LIFECYCLE_ITEMS {
                return Err(StorageError::Validation(format!(
                    "Blob replica action count exceeds the limit of {MAX_BLOB_LIFECYCLE_ITEMS}"
                )));
            }
            actionable.push(item);
        }

        let mut page_items = Vec::with_capacity(request.page_size.saturating_add(1));
        for item in actionable.into_iter().filter(|item| {
            request
                .cursor
                .as_deref()
                .is_none_or(|cursor| item.blob_id.as_str() > cursor)
        }) {
            page_items.push(item);
            if page_items.len() > request.page_size {
                break;
            }
        }
        let next_cursor = if page_items.len() > request.page_size {
            page_items.truncate(request.page_size);
            page_items.last().map(|item| item.blob_id.clone())
        } else {
            None
        };
        Ok(BlobReplicaPage {
            plan_token,
            source_namespace_id,
            destination_namespace_id,
            raw_reference_count: references.raw_reference_count,
            unique_reference_count: references.blobs.len(),
            items: page_items,
            next_cursor,
        })
    }

    pub fn transfer(
        conn: &VaultConnection,
        source: &dyn ReplicableEncryptedBlobStore,
        destination: &dyn ReplicableEncryptedBlobStore,
        owner_id: &str,
        checkpoint: Option<&BlobReplicaTransferCheckpoint>,
        limits: BlobReplicaTransferLimits,
    ) -> StorageResult<BlobReplicaTransferResult> {
        validate_owner_id(owner_id)?;
        limits.validate()?;
        let mut state = match checkpoint {
            Some(checkpoint) => {
                validate_owner_id(&checkpoint.owner_id)?;
                if checkpoint.owner_id != owner_id {
                    return Err(StorageError::ConstraintViolation(
                        "Blob replica checkpoint owner does not match this transfer".to_string(),
                    ));
                }
                if let Some(cursor) = checkpoint.cursor.as_deref() {
                    validate_blob_id(cursor)?;
                }
                if let Some(plan_token) = checkpoint.plan_token.as_deref() {
                    validate_blob_id(plan_token)?;
                }
                checkpoint.clone()
            }
            None => BlobReplicaTransferCheckpoint::new(owner_id.to_string())?,
        };
        let mut transferred_items = 0usize;

        if let Some(current) = state.current.clone() {
            let transfer_limits = limits_for_item(limits.transfer, current.total_size);
            let result = BlobTransferService::transfer(
                source,
                destination,
                &current.blob_id,
                current.total_size,
                owner_id,
                Some(&current),
                transfer_limits,
            )?;
            if !result.completed {
                state.current = Some(result.checkpoint);
                return Ok(BlobReplicaTransferResult {
                    checkpoint: state,
                    completed: false,
                    transferred_items,
                    blocked_items: Vec::new(),
                });
            }
            state.current = None;
            state.cursor = Some(current.blob_id);
            state.plan_token = None;
            transferred_items += 1;
        }

        loop {
            if transferred_items >= limits.max_items_per_run {
                return Ok(BlobReplicaTransferResult {
                    checkpoint: state,
                    completed: false,
                    transferred_items,
                    blocked_items: Vec::new(),
                });
            }
            let page = Self::page(
                conn,
                source,
                destination,
                BlobReplicaPageRequest::new(None, None, limits.page_size, limits.lifecycle)?,
            );
            let page = page?;
            state.plan_token = Some(page.plan_token.clone());
            if page.items.is_empty() {
                return Ok(BlobReplicaTransferResult {
                    checkpoint: state,
                    completed: page.next_cursor.is_none(),
                    transferred_items,
                    blocked_items: Vec::new(),
                });
            }
            for item in page.items {
                if transferred_items >= limits.max_items_per_run {
                    return Ok(BlobReplicaTransferResult {
                        checkpoint: state,
                        completed: false,
                        transferred_items,
                        blocked_items: Vec::new(),
                    });
                }
                if item.state != BlobReplicaState::TransferRequired {
                    return Ok(BlobReplicaTransferResult {
                        checkpoint: state,
                        completed: false,
                        transferred_items,
                        blocked_items: vec![item],
                    });
                }
                let total_size = item.source_size.ok_or_else(|| {
                    StorageError::ConstraintViolation(
                        "transfer-required Blob has no source size".to_string(),
                    )
                })?;
                let result = BlobTransferService::transfer(
                    source,
                    destination,
                    &item.blob_id,
                    total_size,
                    owner_id,
                    None,
                    limits_for_item(limits.transfer, total_size),
                )?;
                if !result.completed {
                    state.current = Some(result.checkpoint);
                    return Ok(BlobReplicaTransferResult {
                        checkpoint: state,
                        completed: false,
                        transferred_items,
                        blocked_items: Vec::new(),
                    });
                }
                state.cursor = Some(item.blob_id);
                state.current = None;
                state.plan_token = None;
                transferred_items += 1;
            }
        }
    }
}

fn validate_namespace(namespace_id: String) -> StorageResult<String> {
    if namespace_id.is_empty() || namespace_id.len() > 4096 {
        return Err(StorageError::BlobStore(
            "Blob Provider namespace ID must contain 1 to 4096 bytes".to_string(),
        ));
    }
    Ok(namespace_id)
}

fn validate_owner_id(owner_id: &str) -> StorageResult<()> {
    if owner_id.is_empty() || owner_id.len() > 512 || owner_id.contains('\n') {
        return Err(StorageError::Validation(
            "Blob replica transfer owner ID must contain 1 to 512 bytes without newlines"
                .to_string(),
        ));
    }
    Ok(())
}

fn limits_for_item(mut limits: BlobTransferLimits, total_size: u64) -> BlobTransferLimits {
    limits.max_blob_bytes = limits.max_blob_bytes.min(total_size);
    limits
}

fn vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::from)
}

fn compute_plan_token(
    vault_id: &str,
    source_namespace_id: &str,
    destination_namespace_id: &str,
    references: &ExternalBlobReferenceInventory,
    source: &BTreeMap<String, EncryptedBlobMetadata>,
    destination: &BTreeMap<String, EncryptedBlobMetadata>,
) -> String {
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, b"mdbx-blob-replica-plan-v1");
    hash_part(&mut hasher, vault_id.as_bytes());
    hash_part(&mut hasher, source_namespace_id.as_bytes());
    hash_part(&mut hasher, destination_namespace_id.as_bytes());
    hash_part(
        &mut hasher,
        &(references.raw_reference_count as u64).to_le_bytes(),
    );
    for (blob_id, maximum_bytes) in &references.blobs {
        hash_part(&mut hasher, b"reference");
        hash_part(&mut hasher, blob_id.as_bytes());
        hash_part(&mut hasher, &(*maximum_bytes as u64).to_le_bytes());
    }
    hash_inventory(&mut hasher, b"source", source);
    hash_inventory(&mut hasher, b"destination", destination);
    format!("{:x}", hasher.finalize())
}

fn hash_inventory(
    hasher: &mut Sha256,
    label: &[u8],
    inventory: &BTreeMap<String, EncryptedBlobMetadata>,
) {
    hash_part(hasher, label);
    for blob in inventory.values() {
        hash_part(hasher, blob.blob_id.as_bytes());
        hash_part(hasher, &blob.stored_size.to_le_bytes());
        hash_part(hasher, &blob.modified_at_unix_secs.to_le_bytes());
    }
}

fn hash_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

#[cfg(all(test, feature = "filesystem-blob-store"))]
mod tests {
    use super::*;
    use std::io::Cursor;

    use crate::blob_store::{compute_blob_id, EncryptedBlobStore, FileSystemBlobStore};
    use crate::connection::VaultConnection;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{
        AttachmentRepo, AttachmentWriteOptions, CommitContext, ProjectRepo, SnapshotRepo,
    };

    fn setup() -> (VaultConnection, CommitContext, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "replica-test-device".to_string(),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        conn.attach_keyring(
            mdbx_crypto::keyring::Keyring::from_vault_key(&[23_u8; 32], b"blob-replica-tests")
                .unwrap(),
        );
        let context = CommitContext::new("replica-test-device".to_string());
        let project = ProjectRepo::create(&conn, &context, "Replica", None, None).unwrap();
        (conn, context, project.project_id)
    }

    fn add_external(
        conn: &VaultConnection,
        context: &CommitContext,
        project_id: &str,
        store: &FileSystemBlobStore,
    ) -> String {
        let attachment = AttachmentRepo::add(
            conn,
            context,
            project_id,
            None,
            "replica.bin",
            None,
            "",
            100,
        )
        .unwrap();
        AttachmentRepo::write_external_content_from_reader_with_options(
            conn,
            context,
            &attachment.attachment_id,
            &mut Cursor::new(vec![5_u8; 100]),
            AttachmentWriteOptions::exact(50, 100),
            store,
        )
        .unwrap();
        attachment.attachment_id
    }

    fn request(
        page_size: usize,
        cursor: Option<String>,
        checkpoint: Option<String>,
    ) -> BlobReplicaPageRequest {
        BlobReplicaPageRequest::new(
            cursor,
            checkpoint,
            page_size,
            BlobLifecycleLimits::default(),
        )
        .unwrap()
    }

    #[test]
    fn replica_pages_report_missing_and_conflicting_reference_bodies() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let source_page = source.list(None, 10).unwrap();
        assert_eq!(source_page.blobs.len(), 2);
        let conflict_id = source_page.blobs[0].blob_id.clone();
        let missing_id = source_page.blobs[1].blob_id.clone();
        let conflict_bytes = vec![9_u8; 3];
        let conflict_path = destination.blob_path(&conflict_id).unwrap();
        std::fs::create_dir_all(conflict_path.parent().unwrap()).unwrap();
        std::fs::write(conflict_path, conflict_bytes).unwrap();

        let page = BlobReplicaService::page(&conn, &source, &destination, request(10, None, None))
            .unwrap();
        assert_eq!(page.raw_reference_count, 2);
        assert_eq!(page.unique_reference_count, 2);
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].blob_id, conflict_id);
        assert_eq!(page.items[0].state, BlobReplicaState::DestinationConflict);
        assert_eq!(page.items[1].blob_id, missing_id);
        assert_eq!(page.items[1].state, BlobReplicaState::TransferRequired);
    }

    #[test]
    fn retained_snapshot_references_report_missing_and_invalid_sources() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        let attachment_id = add_external(&conn, &context, &project_id, &source);
        SnapshotRepo::create_snapshot(&conn, &context).unwrap();
        AttachmentRepo::write_inline_content(&conn, &context, &attachment_id, b"replacement")
            .unwrap();
        let source_page = source.list(None, 10).unwrap();
        let missing_id = source_page.blobs[0].blob_id.clone();
        let invalid_id = source_page.blobs[1].blob_id.clone();
        source.delete(&missing_id).unwrap();
        std::fs::write(
            source.blob_path(&invalid_id).unwrap(),
            vec![0_u8; 1024 * 1024],
        )
        .unwrap();

        let page = BlobReplicaService::page(&conn, &source, &destination, request(10, None, None))
            .unwrap();
        assert_eq!(page.raw_reference_count, 2);
        assert_eq!(page.unique_reference_count, 2);
        assert_eq!(page.items[0].blob_id, missing_id);
        assert_eq!(page.items[0].state, BlobReplicaState::SourceMissing);
        assert_eq!(page.items[1].blob_id, invalid_id);
        assert_eq!(page.items[1].state, BlobReplicaState::SourceSizeInvalid);
    }

    #[test]
    fn replica_plan_is_stable_paginated_and_rejects_provider_changes() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let first =
            BlobReplicaService::page(&conn, &source, &destination, request(1, None, None)).unwrap();
        assert_eq!(first.items.len(), 1);
        let next = first.next_cursor.clone().unwrap();
        let second = BlobReplicaService::page(
            &conn,
            &source,
            &destination,
            request(1, Some(next.clone()), Some(first.plan_token.clone())),
        )
        .unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(second.next_cursor.is_none());
        assert_eq!(second.plan_token, first.plan_token);

        let extra = b"provider mutation";
        let extra_id = compute_blob_id(extra);
        source.put(&extra_id, extra).unwrap();
        let error = BlobReplicaService::page(
            &conn,
            &source,
            &destination,
            request(1, Some(next), Some(first.plan_token)),
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::ConstraintViolation(_)));
    }

    #[test]
    fn replica_request_rejects_unbounded_or_unanchored_pages() {
        assert!(
            BlobReplicaPageRequest::new(None, None, 0, BlobLifecycleLimits::default(),).is_err()
        );
        assert!(BlobReplicaPageRequest::new(
            Some(compute_blob_id(b"cursor")),
            None,
            1,
            BlobLifecycleLimits::default(),
        )
        .is_err());
    }

    #[test]
    fn replica_transfer_resumes_partial_blobs_and_converges_all_references() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let limits = BlobReplicaTransferLimits {
            lifecycle: BlobLifecycleLimits::default(),
            page_size: 1,
            max_items_per_run: 1,
            transfer: BlobTransferLimits {
                chunk_size: 8,
                max_blob_bytes: 1024,
                max_chunks_per_run: 1,
                lease_ttl_secs: 60,
            },
        };
        let mut checkpoint = None;
        let mut observed_partial = false;
        let mut completed = false;
        for _ in 0..100 {
            let result = BlobReplicaService::transfer(
                &conn,
                &source,
                &destination,
                "replica-owner",
                checkpoint.as_ref(),
                limits,
            )
            .unwrap();
            assert!(result.blocked_items.is_empty());
            observed_partial |= result.checkpoint.current.is_some();
            completed = result.completed;
            checkpoint = Some(result.checkpoint);
            if completed {
                break;
            }
        }
        assert!(observed_partial);
        assert!(completed);
        let stable_inventory = |store: &FileSystemBlobStore| {
            store
                .list(None, 10)
                .unwrap()
                .blobs
                .into_iter()
                .map(|blob| (blob.blob_id, blob.stored_size))
                .collect::<Vec<_>>()
        };
        assert_eq!(stable_inventory(&source), stable_inventory(&destination));

        let serialized = serde_json::to_vec(checkpoint.as_ref().unwrap()).unwrap();
        let restored: BlobReplicaTransferCheckpoint = serde_json::from_slice(&serialized).unwrap();
        assert_eq!(restored, checkpoint.unwrap());
    }

    #[test]
    fn replica_transfer_stops_on_missing_source_without_advancing() {
        let (conn, context, project_id) = setup();
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        add_external(&conn, &context, &project_id, &source);
        let missing_id = source.list(None, 10).unwrap().blobs[0].blob_id.clone();
        source.delete(&missing_id).unwrap();

        let result = BlobReplicaService::transfer(
            &conn,
            &source,
            &destination,
            "replica-owner",
            None,
            BlobReplicaTransferLimits::default(),
        )
        .unwrap();
        assert!(!result.completed);
        assert_eq!(result.transferred_items, 0);
        assert_eq!(result.blocked_items.len(), 1);
        assert_eq!(result.blocked_items[0].blob_id, missing_id);
        assert_eq!(
            result.blocked_items[0].state,
            BlobReplicaState::SourceMissing
        );
        assert!(result.checkpoint.cursor.is_none());
        assert!(destination.list(None, 10).unwrap().blobs.is_empty());
    }
}
