use std::collections::{BTreeMap, BTreeSet};

use mdbx_core::model::attachment::StorageMode;
use mdbx_core::tiga::{AuthorizationDecision, AuthorizationOutcome, TigaOperation, TigaScope};
use sha2::{Digest, Sha256};

use crate::blob_store::{
    validate_blob_id, EncryptedBlobMetadata, ManageableEncryptedBlobStore, MAX_BLOB_PAGE_SIZE,
};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::repo::attachment::{external_blob_read_limit, AttachmentRepo};
use crate::repo::snapshot::SnapshotRepo;
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

pub const MAX_BLOB_LIFECYCLE_ITEMS: usize = 1_000_000;
pub const MAX_BLOB_LIFECYCLE_SNAPSHOTS: usize = 100_000;
pub const MAX_BLOB_LIFECYCLE_SNAPSHOT_BYTES: usize = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobLifecycleLimits {
    pub provider_page_size: usize,
    pub max_provider_blobs: usize,
    pub max_references: usize,
    pub max_snapshots: usize,
    pub max_snapshot_ciphertext_bytes: usize,
    pub max_gc_candidates: usize,
}

impl Default for BlobLifecycleLimits {
    fn default() -> Self {
        Self {
            provider_page_size: 500,
            max_provider_blobs: 100_000,
            max_references: 250_000,
            max_snapshots: 10_000,
            max_snapshot_ciphertext_bytes: 256 * 1024 * 1024,
            max_gc_candidates: 10_000,
        }
    }
}

impl BlobLifecycleLimits {
    pub(crate) fn validate(self) -> StorageResult<()> {
        if !(1..=MAX_BLOB_PAGE_SIZE).contains(&self.provider_page_size) {
            return Err(StorageError::Validation(format!(
                "provider_page_size must be between 1 and {MAX_BLOB_PAGE_SIZE}"
            )));
        }
        for (name, value) in [
            ("max_provider_blobs", self.max_provider_blobs),
            ("max_references", self.max_references),
            ("max_gc_candidates", self.max_gc_candidates),
        ] {
            if !(1..=MAX_BLOB_LIFECYCLE_ITEMS).contains(&value) {
                return Err(StorageError::Validation(format!(
                    "{name} must be between 1 and {MAX_BLOB_LIFECYCLE_ITEMS}"
                )));
            }
        }
        if !(1..=MAX_BLOB_LIFECYCLE_SNAPSHOTS).contains(&self.max_snapshots) {
            return Err(StorageError::Validation(format!(
                "max_snapshots must be between 1 and {MAX_BLOB_LIFECYCLE_SNAPSHOTS}"
            )));
        }
        if !(1..=MAX_BLOB_LIFECYCLE_SNAPSHOT_BYTES).contains(&self.max_snapshot_ciphertext_bytes) {
            return Err(StorageError::Validation(format!(
                "max_snapshot_ciphertext_bytes must be between 1 and {MAX_BLOB_LIFECYCLE_SNAPSHOT_BYTES}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobAuditOptions {
    pub limits: BlobLifecycleLimits,
    pub orphan_cutoff_unix_secs: i64,
    pub verify_provider_contents: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobAuditIssue {
    pub blob_id: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobAuditReport {
    pub namespace_id: String,
    pub raw_reference_count: usize,
    pub unique_reference_count: usize,
    pub provider_blob_count: usize,
    pub healthy_reference_count: usize,
    pub missing_references: Vec<BlobAuditIssue>,
    pub corrupt_blobs: Vec<BlobAuditIssue>,
    pub eligible_orphans: Vec<EncryptedBlobMetadata>,
    pub recent_orphan_count: usize,
    pub orphan_cutoff_unix_secs: i64,
    pub plan_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobGcFailure {
    pub blob_id: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobGcResult {
    pub plan_token: String,
    pub planned_count: usize,
    pub deleted_blob_ids: Vec<String>,
    pub already_absent_blob_ids: Vec<String>,
    pub failures: Vec<BlobGcFailure>,
}

impl BlobGcResult {
    pub fn completed(&self) -> bool {
        self.failures.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalBlobReferenceInventory {
    pub raw_reference_count: usize,
    pub blobs: BTreeMap<String, usize>,
}

pub struct BlobLifecycleService;

impl BlobLifecycleService {
    pub fn audit(
        conn: &VaultConnection,
        blob_store: &dyn ManageableEncryptedBlobStore,
        options: BlobAuditOptions,
    ) -> StorageResult<BlobAuditReport> {
        options.limits.validate()?;
        if conn.keyring().is_none() {
            return Err(StorageError::Validation(
                "external Blob maintenance requires an unlocked encrypted vault".to_string(),
            ));
        }
        let namespace_id = blob_store.namespace_id()?;
        if namespace_id.is_empty() || namespace_id.len() > 4096 {
            return Err(StorageError::BlobStore(
                "Blob Provider namespace ID must contain 1 to 4096 bytes".to_string(),
            ));
        }
        let references = collect_external_blob_references(conn, options.limits)?;
        let provider = collect_provider_inventory(blob_store, options.limits)?;
        build_report(
            conn,
            blob_store,
            namespace_id,
            references,
            provider,
            options,
        )
    }

    pub fn plan_gc(
        conn: &VaultConnection,
        blob_store: &dyn ManageableEncryptedBlobStore,
        orphan_cutoff_unix_secs: i64,
        limits: BlobLifecycleLimits,
    ) -> StorageResult<BlobAuditReport> {
        Self::audit(
            conn,
            blob_store,
            BlobAuditOptions {
                limits,
                orphan_cutoff_unix_secs,
                verify_provider_contents: false,
            },
        )
    }

    pub fn apply_gc_authorized(
        conn: &VaultConnection,
        blob_store: &dyn ManageableEncryptedBlobStore,
        expected_plan_token: &str,
        orphan_cutoff_unix_secs: i64,
        limits: BlobLifecycleLimits,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(BlobGcResult, AuthorizationDecision)> {
        validate_blob_id(expected_plan_token).map_err(|_| {
            StorageError::Validation(
                "Blob garbage-collection plan token must be a SHA-256 hex digest".to_string(),
            )
        })?;
        let initial_plan = Self::plan_gc(conn, blob_store, orphan_cutoff_unix_secs, limits)?;
        if initial_plan.plan_token != expected_plan_token {
            return Err(StorageError::ConstraintViolation(
                "Blob garbage-collection plan is stale; create a new plan".to_string(),
            ));
        }
        let decision = TigaService::authorize_operation(
            conn,
            &TigaScope::Vault,
            TigaOperation::PurgeDeletedObject,
            context,
        )?;
        if !matches!(
            decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ) {
            return Err(StorageError::Authorization(decision));
        }

        let result = conn.with_immediate_transaction(|| {
            let plan = Self::plan_gc(conn, blob_store, orphan_cutoff_unix_secs, limits)?;
            if plan.plan_token != expected_plan_token {
                return Err(StorageError::ConstraintViolation(
                    "Blob garbage-collection plan changed after authorization; create a new plan"
                        .to_string(),
                ));
            }
            let mut result = BlobGcResult {
                plan_token: plan.plan_token,
                planned_count: plan.eligible_orphans.len(),
                deleted_blob_ids: Vec::new(),
                already_absent_blob_ids: Vec::new(),
                failures: Vec::new(),
            };
            for blob in plan.eligible_orphans {
                if blob_store.is_leased(&blob.blob_id)? {
                    result.failures.push(BlobGcFailure {
                        blob_id: blob.blob_id,
                        detail: "Blob is protected by an active Provider lease".to_string(),
                    });
                    continue;
                }
                match blob_store.delete(&blob.blob_id) {
                    Ok(true) => result.deleted_blob_ids.push(blob.blob_id),
                    Ok(false) => result.already_absent_blob_ids.push(blob.blob_id),
                    Err(error) => result.failures.push(BlobGcFailure {
                        blob_id: blob.blob_id,
                        detail: error.to_string(),
                    }),
                }
            }
            Ok(result)
        })?;
        Ok((result, decision))
    }
}

pub fn collect_external_blob_references(
    conn: &VaultConnection,
    limits: BlobLifecycleLimits,
) -> StorageResult<ExternalBlobReferenceInventory> {
    limits.validate()?;
    if conn.keyring().is_none() {
        return Err(StorageError::Validation(
            "external Blob reference inventory requires an unlocked encrypted vault".to_string(),
        ));
    }
    let mut blobs = BTreeMap::<String, usize>::new();
    let mut raw_count = 0usize;
    let mut stmt = conn.inner().prepare(
        "SELECT a.attachment_id, a.storage_mode, c.chunk_index, c.chunk_ct,
                c.external_uri_ct, c.stored_size
         FROM attachment_chunks c
         JOIN attachments a ON a.attachment_id = c.attachment_id
         ORDER BY a.attachment_id, c.chunk_index",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<Vec<u8>>>(3)?,
            row.get::<_, Option<Vec<u8>>>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    for row in rows {
        let (attachment_id, storage_mode, chunk_index, chunk_ct, external_uri_ct, stored_size) =
            row?;
        let storage_mode: StorageMode = storage_mode.parse().map_err(StorageError::Validation)?;
        match (storage_mode, chunk_ct, external_uri_ct) {
            (StorageMode::ExternalHashRef, None, Some(reference)) => {
                add_reference(
                    conn,
                    &mut blobs,
                    &mut raw_count,
                    limits.max_references,
                    &attachment_id,
                    chunk_index,
                    &reference,
                    stored_size,
                )?;
            }
            (StorageMode::ExternalHashRef, _, _) => {
                return Err(StorageError::ConstraintViolation(format!(
                    "external attachment {attachment_id} chunk {chunk_index} has invalid storage columns"
                )))
            }
            (StorageMode::EmbeddedInline | StorageMode::EmbeddedChunked, Some(_), None) => {}
            (StorageMode::EmbeddedInline | StorageMode::EmbeddedChunked, _, _) => {
                return Err(StorageError::ConstraintViolation(format!(
                    "embedded attachment {attachment_id} chunk {chunk_index} has invalid storage columns"
                )))
            }
        }
    }

    let remaining = limits.max_references.saturating_sub(raw_count);
    let snapshot_references = SnapshotRepo::collect_external_blob_references(
        conn,
        limits.max_snapshots,
        limits.max_snapshot_ciphertext_bytes,
        remaining,
    )?;
    for reference in snapshot_references {
        let stored_size = i64::try_from(reference.stored_size).map_err(|_| {
            StorageError::Validation("snapshot chunk size exceeds SQLite range".to_string())
        })?;
        add_reference(
            conn,
            &mut blobs,
            &mut raw_count,
            limits.max_references,
            &reference.attachment_id,
            i64::from(reference.chunk_index),
            &reference.external_uri_ct,
            stored_size,
        )?;
    }
    Ok(ExternalBlobReferenceInventory {
        raw_reference_count: raw_count,
        blobs,
    })
}

#[allow(clippy::too_many_arguments)]
fn add_reference(
    conn: &VaultConnection,
    blobs: &mut BTreeMap<String, usize>,
    raw_count: &mut usize,
    max_references: usize,
    attachment_id: &str,
    chunk_index: i64,
    encrypted_reference: &[u8],
    stored_size: i64,
) -> StorageResult<()> {
    if *raw_count >= max_references {
        return Err(StorageError::Validation(format!(
            "external Blob reference count exceeds the maintenance limit of {max_references}"
        )));
    }
    *raw_count += 1;
    let blob_id = AttachmentRepo::decrypt_external_blob_id(
        conn,
        attachment_id,
        chunk_index,
        encrypted_reference,
    )?;
    let maximum_bytes = external_blob_read_limit(stored_size)?;
    match blobs.entry(blob_id.clone()) {
        std::collections::btree_map::Entry::Vacant(entry) => {
            entry.insert(maximum_bytes);
        }
        std::collections::btree_map::Entry::Occupied(entry) if *entry.get() != maximum_bytes => {
            return Err(StorageError::ConstraintViolation(format!(
                "Blob {blob_id} has inconsistent declared chunk sizes"
            )))
        }
        std::collections::btree_map::Entry::Occupied(_) => {}
    }
    Ok(())
}

pub(crate) fn collect_provider_inventory<S>(
    blob_store: &S,
    limits: BlobLifecycleLimits,
) -> StorageResult<BTreeMap<String, EncryptedBlobMetadata>>
where
    S: ManageableEncryptedBlobStore + ?Sized,
{
    let mut inventory = BTreeMap::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = blob_store.list(cursor.as_deref(), limits.provider_page_size)?;
        if page.blobs.len() > limits.provider_page_size {
            return Err(StorageError::BlobStore(
                "Blob Provider returned more items than requested".to_string(),
            ));
        }
        let mut previous = cursor.clone();
        for blob in page.blobs {
            validate_blob_id(&blob.blob_id)?;
            if previous
                .as_deref()
                .is_some_and(|previous| blob.blob_id.as_str() <= previous)
            {
                return Err(StorageError::BlobStore(
                    "Blob Provider inventory is not strictly ordered".to_string(),
                ));
            }
            previous = Some(blob.blob_id.clone());
            if inventory.len() >= limits.max_provider_blobs {
                return Err(StorageError::Validation(format!(
                    "Provider Blob count exceeds the maintenance limit of {}",
                    limits.max_provider_blobs
                )));
            }
            if inventory.insert(blob.blob_id.clone(), blob).is_some() {
                return Err(StorageError::BlobStore(
                    "Blob Provider inventory contains duplicate IDs".to_string(),
                ));
            }
        }
        match page.next_cursor {
            Some(next_cursor) => {
                validate_blob_id(&next_cursor)?;
                let last = inventory.keys().next_back().ok_or_else(|| {
                    StorageError::BlobStore(
                        "Blob Provider returned a cursor without page items".to_string(),
                    )
                })?;
                if &next_cursor != last || cursor.as_deref() == Some(next_cursor.as_str()) {
                    return Err(StorageError::BlobStore(
                        "Blob Provider returned an invalid pagination cursor".to_string(),
                    ));
                }
                cursor = Some(next_cursor);
            }
            None => break,
        }
    }
    Ok(inventory)
}

fn build_report(
    conn: &VaultConnection,
    blob_store: &dyn ManageableEncryptedBlobStore,
    namespace_id: String,
    references: ExternalBlobReferenceInventory,
    provider: BTreeMap<String, EncryptedBlobMetadata>,
    options: BlobAuditOptions,
) -> StorageResult<BlobAuditReport> {
    let mut missing_references = Vec::new();
    let mut corrupt_blobs = Vec::new();
    let mut corrupt_blob_ids = BTreeSet::new();
    let mut healthy_reference_count = 0usize;
    if options.verify_provider_contents {
        for blob in provider.values() {
            let max_bytes = usize::try_from(blob.stored_size).map_err(|_| {
                StorageError::Validation(format!(
                    "blob {} exceeds platform size limits",
                    blob.blob_id
                ))
            })?;
            if let Err(error) = blob_store.get(&blob.blob_id, max_bytes) {
                corrupt_blob_ids.insert(blob.blob_id.clone());
                corrupt_blobs.push(BlobAuditIssue {
                    blob_id: blob.blob_id.clone(),
                    detail: error.to_string(),
                });
            }
        }
    }
    for (blob_id, max_bytes) in &references.blobs {
        if !provider.contains_key(blob_id) {
            missing_references.push(BlobAuditIssue {
                blob_id: blob_id.clone(),
                detail: "referenced Blob is missing from the Provider".to_string(),
            });
        } else if options.verify_provider_contents {
            if corrupt_blob_ids.contains(blob_id) {
                continue;
            }
            if let Err(error) = blob_store.get(blob_id, *max_bytes) {
                corrupt_blob_ids.insert(blob_id.clone());
                corrupt_blobs.push(BlobAuditIssue {
                    blob_id: blob_id.clone(),
                    detail: error.to_string(),
                });
            } else {
                healthy_reference_count += 1;
            }
        } else {
            healthy_reference_count += 1;
        }
    }

    let mut eligible_orphans = Vec::new();
    let mut recent_orphan_count = 0usize;
    for blob in provider.values() {
        if references.blobs.contains_key(&blob.blob_id) {
            continue;
        }
        if blob.modified_at_unix_secs <= options.orphan_cutoff_unix_secs {
            if blob_store.is_leased(&blob.blob_id)? {
                continue;
            }
            if eligible_orphans.len() >= options.limits.max_gc_candidates {
                return Err(StorageError::Validation(format!(
                    "eligible orphan count exceeds the maintenance limit of {}",
                    options.limits.max_gc_candidates
                )));
            }
            eligible_orphans.push(blob.clone());
        } else {
            recent_orphan_count += 1;
        }
    }

    let vault_id: String =
        conn.inner()
            .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
                row.get(0)
            })?;
    let plan_token = compute_plan_token(
        &vault_id,
        &namespace_id,
        options.orphan_cutoff_unix_secs,
        &references.blobs,
        &provider,
    );
    Ok(BlobAuditReport {
        namespace_id,
        raw_reference_count: references.raw_reference_count,
        unique_reference_count: references.blobs.len(),
        provider_blob_count: provider.len(),
        healthy_reference_count,
        missing_references,
        corrupt_blobs,
        eligible_orphans,
        recent_orphan_count,
        orphan_cutoff_unix_secs: options.orphan_cutoff_unix_secs,
        plan_token,
    })
}

fn compute_plan_token(
    vault_id: &str,
    namespace_id: &str,
    orphan_cutoff_unix_secs: i64,
    references: &BTreeMap<String, usize>,
    provider: &BTreeMap<String, EncryptedBlobMetadata>,
) -> String {
    let mut hasher = Sha256::new();
    hash_part(&mut hasher, b"mdbx-blob-gc-plan-v1");
    hash_part(&mut hasher, vault_id.as_bytes());
    hash_part(&mut hasher, namespace_id.as_bytes());
    hash_part(&mut hasher, &orphan_cutoff_unix_secs.to_le_bytes());
    for (blob_id, max_bytes) in references {
        hash_part(&mut hasher, b"reference");
        hash_part(&mut hasher, blob_id.as_bytes());
        hash_part(&mut hasher, &(*max_bytes as u64).to_le_bytes());
    }
    for blob in provider.values() {
        hash_part(&mut hasher, b"provider");
        hash_part(&mut hasher, blob.blob_id.as_bytes());
        hash_part(&mut hasher, &blob.stored_size.to_le_bytes());
        hash_part(&mut hasher, &blob.modified_at_unix_secs.to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn hash_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::Cursor;
    use std::sync::Mutex;

    use mdbx_core::model::{UnlockMethodType, VaultSession};
    use mdbx_core::tiga::{DeviceAssurance, DeviceContext, SessionAssurance};
    use rusqlite::params;

    use crate::blob_store::{compute_blob_id, EncryptedBlobPage, EncryptedBlobStore};
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::snapshot::SnapshotRepo;
    use crate::repo::{AttachmentRepo, AttachmentWriteOptions, CommitContext, ProjectRepo};

    #[derive(Default)]
    struct MemoryBlobStore {
        blobs: Mutex<BTreeMap<String, (Vec<u8>, i64)>>,
        failed_deletes: Mutex<BTreeSet<String>>,
        leased: Mutex<BTreeSet<String>>,
        put_modified_at: Mutex<i64>,
    }

    impl MemoryBlobStore {
        fn set_put_modified_at(&self, value: i64) {
            *self.put_modified_at.lock().unwrap() = value;
        }

        fn insert_at(&self, encrypted: &[u8], modified_at: i64) -> String {
            let blob_id = compute_blob_id(encrypted);
            self.blobs
                .lock()
                .unwrap()
                .insert(blob_id.clone(), (encrypted.to_vec(), modified_at));
            blob_id
        }

        fn blob_ids(&self) -> Vec<String> {
            self.blobs.lock().unwrap().keys().cloned().collect()
        }

        fn remove(&self, blob_id: &str) {
            self.blobs.lock().unwrap().remove(blob_id);
        }

        fn corrupt(&self, blob_id: &str) {
            if let Some((bytes, _)) = self.blobs.lock().unwrap().get_mut(blob_id) {
                bytes[0] ^= 0x01;
            }
        }

        fn fail_delete(&self, blob_id: &str) {
            self.failed_deletes
                .lock()
                .unwrap()
                .insert(blob_id.to_string());
        }

        fn allow_delete(&self, blob_id: &str) {
            self.failed_deletes.lock().unwrap().remove(blob_id);
        }

        fn lease(&self, blob_id: &str) {
            self.leased.lock().unwrap().insert(blob_id.to_string());
        }

        fn release_lease(&self, blob_id: &str) {
            self.leased.lock().unwrap().remove(blob_id);
        }
    }

    impl EncryptedBlobStore for MemoryBlobStore {
        fn put(&self, blob_id: &str, encrypted_blob: &[u8]) -> StorageResult<()> {
            if compute_blob_id(encrypted_blob) != blob_id {
                return Err(StorageError::BlobStore("test Blob ID mismatch".to_string()));
            }
            let modified = *self.put_modified_at.lock().unwrap();
            self.blobs
                .lock()
                .unwrap()
                .insert(blob_id.to_string(), (encrypted_blob.to_vec(), modified));
            Ok(())
        }

        fn get(&self, blob_id: &str, max_bytes: usize) -> StorageResult<Vec<u8>> {
            let bytes = self
                .blobs
                .lock()
                .unwrap()
                .get(blob_id)
                .map(|(bytes, _)| bytes.clone())
                .ok_or_else(|| StorageError::BlobStore(format!("blob {blob_id} is missing")))?;
            if bytes.len() > max_bytes {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} exceeds test read limit"
                )));
            }
            if compute_blob_id(&bytes) != blob_id {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} failed test verification"
                )));
            }
            Ok(bytes)
        }
    }

    impl ManageableEncryptedBlobStore for MemoryBlobStore {
        fn namespace_id(&self) -> StorageResult<String> {
            Ok("memory:test-provider".to_string())
        }

        fn list(&self, cursor: Option<&str>, limit: usize) -> StorageResult<EncryptedBlobPage> {
            let blobs = self.blobs.lock().unwrap();
            let mut page: Vec<_> = blobs
                .iter()
                .filter(|(blob_id, _)| cursor.is_none_or(|cursor| blob_id.as_str() > cursor))
                .take(limit.saturating_add(1))
                .map(|(blob_id, (bytes, modified_at))| EncryptedBlobMetadata {
                    blob_id: blob_id.clone(),
                    stored_size: bytes.len() as u64,
                    modified_at_unix_secs: *modified_at,
                })
                .collect();
            let next_cursor = if page.len() > limit {
                page.truncate(limit);
                page.last().map(|blob| blob.blob_id.clone())
            } else {
                None
            };
            Ok(EncryptedBlobPage {
                blobs: page,
                next_cursor,
            })
        }

        fn delete(&self, blob_id: &str) -> StorageResult<bool> {
            if self.leased.lock().unwrap().contains(blob_id) {
                return Err(StorageError::ConstraintViolation(format!(
                    "test Blob {blob_id} is leased"
                )));
            }
            if self.failed_deletes.lock().unwrap().contains(blob_id) {
                return Err(StorageError::BlobStore(format!(
                    "test deletion failed for {blob_id}"
                )));
            }
            Ok(self.blobs.lock().unwrap().remove(blob_id).is_some())
        }

        fn is_leased(&self, blob_id: &str) -> StorageResult<bool> {
            Ok(self.leased.lock().unwrap().contains(blob_id))
        }
    }

    fn setup() -> (VaultConnection, CommitContext, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "blob-test-device".to_string(),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        conn.attach_keyring(
            mdbx_crypto::keyring::Keyring::from_vault_key(&[19_u8; 32], b"blob-lifecycle-tests")
                .unwrap(),
        );
        let ctx = CommitContext::new("blob-test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Blob lifecycle", None, None).unwrap();
        (conn, ctx, project.project_id)
    }

    fn session(now: i64) -> VaultSession {
        VaultSession {
            session_id: "blob-admin-session".to_string(),
            unlock_method: UnlockMethodType::Password,
            created_at: chrono::DateTime::from_timestamp(now, 0)
                .unwrap()
                .to_rfc3339(),
            assurance: SessionAssurance::from_unlock_method(UnlockMethodType::Password, now),
        }
    }

    fn device() -> DeviceContext {
        DeviceContext {
            device_id: Some("blob-test-device".to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: false,
            screen_capture_protection_available: false,
            secure_temp_files_available: true,
        }
    }

    fn add_external_attachment(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
        store: &MemoryBlobStore,
        data: &[u8],
        chunk_size: usize,
    ) -> String {
        let attachment = AttachmentRepo::add(
            conn,
            ctx,
            project_id,
            None,
            "external.bin",
            None,
            "",
            data.len() as u64,
        )
        .unwrap();
        let mut reader = Cursor::new(data);
        AttachmentRepo::write_external_content_from_reader_with_options(
            conn,
            ctx,
            &attachment.attachment_id,
            &mut reader,
            AttachmentWriteOptions::exact(chunk_size, data.len() as u64),
            store,
        )
        .unwrap();
        attachment.attachment_id
    }

    #[test]
    fn audit_includes_snapshot_references_and_classifies_provider_state() {
        let (conn, ctx, project_id) = setup();
        let store = MemoryBlobStore::default();
        store.set_put_modified_at(10);
        let attachment_id =
            add_external_attachment(&conn, &ctx, &project_id, &store, &[7; 100], 50);
        let referenced_ids = store.blob_ids();
        assert_eq!(referenced_ids.len(), 2);
        SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &attachment_id, b"replacement").unwrap();

        store.remove(&referenced_ids[0]);
        store.corrupt(&referenced_ids[1]);
        let old_orphan = store.insert_at(b"old orphan ciphertext", 20);
        let recent_orphan = store.insert_at(b"recent orphan ciphertext", 1_000);

        let report = BlobLifecycleService::audit(
            &conn,
            &store,
            BlobAuditOptions {
                limits: BlobLifecycleLimits::default(),
                orphan_cutoff_unix_secs: 100,
                verify_provider_contents: true,
            },
        )
        .unwrap();

        assert_eq!(report.raw_reference_count, 2);
        assert_eq!(report.unique_reference_count, 2);
        assert_eq!(report.provider_blob_count, 3);
        assert_eq!(report.healthy_reference_count, 0);
        assert_eq!(report.missing_references[0].blob_id, referenced_ids[0]);
        assert!(report
            .corrupt_blobs
            .iter()
            .any(|issue| issue.blob_id == referenced_ids[1]));
        assert_eq!(report.eligible_orphans.len(), 1);
        assert_eq!(report.eligible_orphans[0].blob_id, old_orphan);
        assert_eq!(report.recent_orphan_count, 1);
        assert!(store.blob_ids().contains(&recent_orphan));
    }

    #[test]
    fn stale_plan_is_rejected_before_authorization_or_deletion() {
        let (conn, _ctx, _project_id) = setup();
        let store = MemoryBlobStore::default();
        let first = store.insert_at(b"first orphan", 1);
        let plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        let second = store.insert_at(b"second orphan", 1);
        let session = session(1_000);
        let device = device();

        let error = BlobLifecycleService::apply_gc_authorized(
            &conn,
            &store,
            &plan.plan_token,
            100,
            BlobLifecycleLimits::default(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap_err();

        assert!(matches!(error, StorageError::ConstraintViolation(_)));
        assert!(store.blob_ids().contains(&first));
        assert!(store.blob_ids().contains(&second));
        let audit_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
                 WHERE operation = 'purge-deleted-object'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 0);
    }

    #[test]
    fn authorized_gc_records_one_audit_without_commit_spam_and_is_retryable() {
        let (conn, _ctx, _project_id) = setup();
        let store = MemoryBlobStore::default();
        let first = store.insert_at(b"gc first", 1);
        let second = store.insert_at(b"gc second", 1);
        let recent = store.insert_at(b"gc recent", 500);
        store.fail_delete(&second);
        let plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        let commit_count_before: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        let session = session(1_000);
        let device = device();

        let (result, decision) = BlobLifecycleService::apply_gc_authorized(
            &conn,
            &store,
            &plan.plan_token,
            100,
            BlobLifecycleLimits::default(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap();

        assert!(matches!(
            decision.outcome,
            AuthorizationOutcome::Allow | AuthorizationOutcome::AllowWithConstraints
        ));
        assert_eq!(result.planned_count, 2);
        assert_eq!(result.deleted_blob_ids, vec![first]);
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].blob_id, second);
        assert!(!result.completed());
        assert!(store.blob_ids().contains(&recent));
        let commit_count_after: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
            .unwrap();
        assert_eq!(commit_count_after, commit_count_before);
        let audit_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
                 WHERE operation = 'purge-deleted-object'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);

        store.allow_delete(&second);
        let retry_plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        let (retry, _) = BlobLifecycleService::apply_gc_authorized(
            &conn,
            &store,
            &retry_plan.plan_token,
            100,
            BlobLifecycleLimits::default(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap();
        assert!(retry.completed());
        assert_eq!(retry.deleted_blob_ids, vec![second]);
    }

    #[test]
    fn gc_excludes_active_leases_and_rejects_a_lease_added_after_planning() {
        let (conn, _ctx, _project_id) = setup();
        let store = MemoryBlobStore::default();
        let leased = store.insert_at(b"leased orphan", 1);
        store.lease(&leased);
        let protected_plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        assert!(protected_plan.eligible_orphans.is_empty());

        store.release_lease(&leased);
        let plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        assert_eq!(plan.eligible_orphans.len(), 1);
        store.lease(&leased);
        let session = session(1_000);
        let device = device();
        let (result, _) = BlobLifecycleService::apply_gc_authorized(
            &conn,
            &store,
            &plan.plan_token,
            100,
            BlobLifecycleLimits::default(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap();
        assert_eq!(result.planned_count, 0);
        assert!(result.deleted_blob_ids.is_empty());
        assert!(store.blob_ids().contains(&leased));
    }

    #[test]
    fn database_reference_change_invalidates_plan_without_provider_change() {
        let (conn, ctx, project_id) = setup();
        let store = MemoryBlobStore::default();
        store.set_put_modified_at(1);
        let attachment_id = add_external_attachment(
            &conn,
            &ctx,
            &project_id,
            &store,
            b"snapshot protected blob",
            64,
        );
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &attachment_id, b"replacement").unwrap();
        let plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        assert!(plan.eligible_orphans.is_empty());
        conn.inner()
            .execute(
                "DELETE FROM snapshots WHERE snapshot_id = ?1",
                params![snapshot.snapshot_id],
            )
            .unwrap();
        let session = session(1_000);
        let device = device();

        let error = BlobLifecycleService::apply_gc_authorized(
            &conn,
            &store,
            &plan.plan_token,
            100,
            BlobLifecycleLimits::default(),
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap_err();
        assert!(matches!(error, StorageError::ConstraintViolation(_)));
        assert_eq!(store.blob_ids().len(), 1);
    }

    #[test]
    fn denied_gc_keeps_blob_and_persists_denial_audit() {
        let (conn, _ctx, _project_id) = setup();
        let store = MemoryBlobStore::default();
        let orphan = store.insert_at(b"denied orphan", 1);
        let plan =
            BlobLifecycleService::plan_gc(&conn, &store, 100, BlobLifecycleLimits::default())
                .unwrap();
        let device = device();

        let error = BlobLifecycleService::apply_gc_authorized(
            &conn,
            &store,
            &plan.plan_token,
            100,
            BlobLifecycleLimits::default(),
            TigaAuthorizationContext {
                session: None,
                device: &device,
                now_unix_secs: 1_000,
            },
        )
        .unwrap_err();

        assert!(matches!(error, StorageError::Authorization(_)));
        assert!(store.blob_ids().contains(&orphan));
        let audit_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
                 WHERE operation = 'purge-deleted-object'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
    }
}
