use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::blob_store::{
    validate_blob_id, EncryptedBlobTransferStore, MAX_BLOB_LEASE_TTL_SECS,
    MAX_BLOB_TRANSFER_CHUNK_SIZE,
};
use crate::error::{StorageError, StorageResult};

pub const MAX_BLOB_TRANSFER_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
pub const MAX_BLOB_TRANSFER_CHUNKS_PER_RUN: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobTransferLimits {
    pub chunk_size: usize,
    pub max_blob_bytes: u64,
    pub max_chunks_per_run: usize,
    pub lease_ttl_secs: i64,
}

impl Default for BlobTransferLimits {
    fn default() -> Self {
        Self {
            chunk_size: 1024 * 1024,
            max_blob_bytes: 8 * 1024 * 1024 * 1024,
            max_chunks_per_run: 10_000,
            lease_ttl_secs: 5 * 60,
        }
    }
}

impl BlobTransferLimits {
    pub(crate) fn validate(self) -> StorageResult<()> {
        if !(1..=MAX_BLOB_TRANSFER_CHUNK_SIZE).contains(&self.chunk_size) {
            return Err(StorageError::Validation(format!(
                "Blob transfer chunk size must be between 1 and {MAX_BLOB_TRANSFER_CHUNK_SIZE}"
            )));
        }
        if !(1..=MAX_BLOB_TRANSFER_BYTES).contains(&self.max_blob_bytes) {
            return Err(StorageError::Validation(format!(
                "Blob transfer byte limit must be between 1 and {MAX_BLOB_TRANSFER_BYTES}"
            )));
        }
        if !(1..=MAX_BLOB_TRANSFER_CHUNKS_PER_RUN).contains(&self.max_chunks_per_run) {
            return Err(StorageError::Validation(format!(
                "Blob transfer chunk count must be between 1 and {MAX_BLOB_TRANSFER_CHUNKS_PER_RUN}"
            )));
        }
        if !(1..=MAX_BLOB_LEASE_TTL_SECS).contains(&self.lease_ttl_secs) {
            return Err(StorageError::Validation(format!(
                "Blob transfer lease TTL must be between 1 and {MAX_BLOB_LEASE_TTL_SECS} seconds"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobTransferCheckpoint {
    pub source_namespace_id: String,
    pub destination_namespace_id: String,
    pub blob_id: String,
    pub total_size: u64,
    pub transferred_bytes: u64,
    pub checkpoint_token: String,
}

impl BlobTransferCheckpoint {
    fn new(
        source_namespace_id: String,
        destination_namespace_id: String,
        blob_id: String,
        total_size: u64,
        transferred_bytes: u64,
    ) -> Self {
        let checkpoint_token = checkpoint_token(
            &source_namespace_id,
            &destination_namespace_id,
            &blob_id,
            total_size,
            transferred_bytes,
        );
        Self {
            source_namespace_id,
            destination_namespace_id,
            blob_id,
            total_size,
            transferred_bytes,
            checkpoint_token,
        }
    }

    fn validate(
        &self,
        source_namespace_id: &str,
        destination_namespace_id: &str,
        blob_id: &str,
        total_size: u64,
    ) -> StorageResult<()> {
        let expected = checkpoint_token(
            &self.source_namespace_id,
            &self.destination_namespace_id,
            &self.blob_id,
            self.total_size,
            self.transferred_bytes,
        );
        if self.checkpoint_token != expected
            || self.source_namespace_id != source_namespace_id
            || self.destination_namespace_id != destination_namespace_id
            || self.blob_id != blob_id
            || self.total_size != total_size
            || self.transferred_bytes > total_size
        {
            return Err(StorageError::ConstraintViolation(
                "Blob transfer checkpoint does not match this transfer".to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobTransferResult {
    pub checkpoint: BlobTransferCheckpoint,
    pub completed: bool,
    pub chunks_transferred: usize,
}

pub struct BlobTransferService;

impl BlobTransferService {
    #[allow(clippy::too_many_arguments)]
    pub fn transfer(
        source: &dyn EncryptedBlobTransferStore,
        destination: &dyn EncryptedBlobTransferStore,
        blob_id: &str,
        total_size: u64,
        owner_id: &str,
        checkpoint: Option<&BlobTransferCheckpoint>,
        limits: BlobTransferLimits,
    ) -> StorageResult<BlobTransferResult> {
        validate_blob_id(blob_id)?;
        limits.validate()?;
        if total_size == 0 || total_size > limits.max_blob_bytes {
            return Err(StorageError::Validation(format!(
                "Blob transfer size must be between 1 and {} bytes",
                limits.max_blob_bytes
            )));
        }
        let source_namespace = source.namespace_id()?;
        let destination_namespace = destination.namespace_id()?;
        validate_namespace_id(&source_namespace)?;
        validate_namespace_id(&destination_namespace)?;
        if source_namespace == destination_namespace {
            return Err(StorageError::Validation(
                "Blob transfer source and destination namespaces must differ".to_string(),
            ));
        }

        let mut current = match checkpoint {
            Some(checkpoint) => {
                checkpoint.validate(
                    &source_namespace,
                    &destination_namespace,
                    blob_id,
                    total_size,
                )?;
                checkpoint.clone()
            }
            None => BlobTransferCheckpoint::new(
                source_namespace,
                destination_namespace,
                blob_id.to_string(),
                total_size,
                0,
            ),
        };

        let now = now_unix_secs();
        source.acquire_lease(blob_id, owner_id, now, limits.lease_ttl_secs)?;
        if let Err(error) = destination.acquire_lease(blob_id, owner_id, now, limits.lease_ttl_secs)
        {
            let _ = source.release_lease(blob_id, owner_id);
            return Err(error);
        }

        let transfer_result = (|| {
            if current.transferred_bytes == total_size {
                destination.write_chunk(blob_id, total_size, total_size, &[], true)?;
                return Ok(BlobTransferResult {
                    checkpoint: current,
                    completed: true,
                    chunks_transferred: 0,
                });
            }

            let mut chunks_transferred = 0usize;
            while current.transferred_bytes < total_size
                && chunks_transferred < limits.max_chunks_per_run
            {
                let renew_now = now_unix_secs();
                source.renew_lease(blob_id, owner_id, renew_now, limits.lease_ttl_secs)?;
                destination.renew_lease(blob_id, owner_id, renew_now, limits.lease_ttl_secs)?;
                let remaining = total_size - current.transferred_bytes;
                let requested = remaining.min(limits.chunk_size as u64) as usize;
                let chunk = source.read_chunk(blob_id, current.transferred_bytes, requested)?;
                if chunk.is_empty() || chunk.len() > requested {
                    return Err(StorageError::BlobStore(
                        "Blob Provider returned an invalid transfer chunk".to_string(),
                    ));
                }
                let end = current
                    .transferred_bytes
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| {
                        StorageError::Validation("Blob transfer offset overflow".to_string())
                    })?;
                if end > total_size {
                    return Err(StorageError::BlobStore(
                        "Blob Provider returned more bytes than the declared object size"
                            .to_string(),
                    ));
                }
                destination.write_chunk(
                    blob_id,
                    total_size,
                    current.transferred_bytes,
                    &chunk,
                    end == total_size,
                )?;
                current = BlobTransferCheckpoint::new(
                    current.source_namespace_id,
                    current.destination_namespace_id,
                    current.blob_id,
                    total_size,
                    end,
                );
                chunks_transferred += 1;
            }

            Ok(BlobTransferResult {
                completed: current.transferred_bytes == total_size,
                checkpoint: current,
                chunks_transferred,
            })
        })();

        let destination_release = destination.release_lease(blob_id, owner_id);
        let source_release = source.release_lease(blob_id, owner_id);
        match transfer_result {
            Err(error) => Err(error),
            Ok(_) if destination_release.is_err() => destination_release.map(|_| unreachable!()),
            Ok(_) if source_release.is_err() => source_release.map(|_| unreachable!()),
            Ok(result) => Ok(result),
        }
    }
}

fn validate_namespace_id(namespace_id: &str) -> StorageResult<()> {
    if namespace_id.is_empty() || namespace_id.len() > 4096 {
        return Err(StorageError::BlobStore(
            "Blob Provider namespace ID must contain 1 to 4096 bytes".to_string(),
        ));
    }
    Ok(())
}

fn checkpoint_token(
    source_namespace_id: &str,
    destination_namespace_id: &str,
    blob_id: &str,
    total_size: u64,
    transferred_bytes: u64,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        b"mdbx-blob-transfer-checkpoint-v1".as_slice(),
        source_namespace_id.as_bytes(),
        destination_namespace_id.as_bytes(),
        blob_id.as_bytes(),
        &total_size.to_le_bytes(),
        &transferred_bytes.to_le_bytes(),
    ] {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value);
    }
    format!("{:x}", hasher.finalize())
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(all(test, feature = "filesystem-blob-store"))]
mod tests {
    use super::*;
    use crate::blob_store::{compute_blob_id, EncryptedBlobStore, FileSystemBlobStore};

    #[test]
    fn filesystem_transfer_is_bounded_resumable_and_idempotent() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        let ciphertext = vec![0x5a; 37];
        let blob_id = compute_blob_id(&ciphertext);
        source.put(&blob_id, &ciphertext).unwrap();
        let limits = BlobTransferLimits {
            chunk_size: 8,
            max_blob_bytes: 100,
            max_chunks_per_run: 2,
            lease_ttl_secs: 60,
        };

        let first = BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "transfer-test",
            None,
            limits,
        )
        .unwrap();
        assert!(!first.completed);
        assert_eq!(first.checkpoint.transferred_bytes, 16);

        let advanced_but_not_saved = BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "transfer-test",
            Some(&first.checkpoint),
            limits,
        )
        .unwrap();
        assert_eq!(advanced_but_not_saved.checkpoint.transferred_bytes, 32);
        let replayed = BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "transfer-test",
            Some(&first.checkpoint),
            limits,
        )
        .unwrap();
        assert_eq!(replayed.checkpoint.transferred_bytes, 32);

        let mut checkpoint = replayed.checkpoint;
        let before_completion = checkpoint.clone();
        loop {
            let result = BlobTransferService::transfer(
                &source,
                &destination,
                &blob_id,
                ciphertext.len() as u64,
                "transfer-test",
                Some(&checkpoint),
                limits,
            )
            .unwrap();
            checkpoint = result.checkpoint;
            if result.completed {
                break;
            }
        }
        assert_eq!(destination.get(&blob_id, 100).unwrap(), ciphertext);

        let recovered_after_publish = BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "transfer-test",
            Some(&before_completion),
            limits,
        )
        .unwrap();
        assert!(recovered_after_publish.completed);

        let repeated = BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            37,
            "transfer-test",
            Some(&checkpoint),
            limits,
        )
        .unwrap();
        assert!(repeated.completed);
        assert_eq!(repeated.chunks_transferred, 0);
    }

    #[test]
    fn checkpoint_tampering_and_active_foreign_leases_fail_closed() {
        let source_dir = tempfile::tempdir().unwrap();
        let destination_dir = tempfile::tempdir().unwrap();
        let source = FileSystemBlobStore::new(source_dir.path().join("source.blobs"));
        let destination =
            FileSystemBlobStore::new(destination_dir.path().join("destination.blobs"));
        let ciphertext = b"transfer ciphertext";
        let blob_id = compute_blob_id(ciphertext);
        source.put(&blob_id, ciphertext).unwrap();
        let limits = BlobTransferLimits {
            chunk_size: 4,
            max_blob_bytes: 100,
            max_chunks_per_run: 1,
            lease_ttl_secs: 60,
        };
        let mut checkpoint = BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "owner-a",
            None,
            limits,
        )
        .unwrap()
        .checkpoint;
        checkpoint.transferred_bytes += 1;
        assert!(BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "owner-a",
            Some(&checkpoint),
            limits,
        )
        .is_err());

        source
            .acquire_lease(&blob_id, "owner-b", now_unix_secs(), 60)
            .unwrap();
        assert!(BlobTransferService::transfer(
            &source,
            &destination,
            &blob_id,
            ciphertext.len() as u64,
            "owner-a",
            None,
            limits,
        )
        .is_err());
    }
}
