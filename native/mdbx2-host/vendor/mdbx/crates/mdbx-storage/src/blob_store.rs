use sha2::{Digest, Sha256};

use crate::error::{StorageError, StorageResult};

pub const MAX_BLOB_PAGE_SIZE: usize = 1_000;
pub const MAX_BLOB_TRANSFER_CHUNK_SIZE: usize = 4 * 1024 * 1024;
pub const MAX_BLOB_LEASE_TTL_SECS: i64 = 24 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedBlobMetadata {
    pub blob_id: String,
    pub stored_size: u64,
    pub modified_at_unix_secs: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedBlobPage {
    pub blobs: Vec<EncryptedBlobMetadata>,
    pub next_cursor: Option<String>,
}

/// Stores opaque, authenticated ciphertext outside the MDBX database file.
///
/// Implementations receive encrypted bytes only. Blob identifiers are the
/// lowercase SHA-256 digest of those exact bytes, making every object
/// immutable and independently verifiable.
pub trait EncryptedBlobStore: Send + Sync {
    fn put(&self, blob_id: &str, encrypted_blob: &[u8]) -> StorageResult<()>;

    /// Reads at most `max_bytes` bytes and verifies the returned object.
    fn get(&self, blob_id: &str, max_bytes: usize) -> StorageResult<Vec<u8>>;
}

/// Adds bounded inventory and deletion operations for maintenance clients.
///
/// This is an additive extension so write/read-only custom Providers remain
/// source-compatible. Deletion must be idempotent and return `false` when the
/// object is already absent.
pub trait ManageableEncryptedBlobStore: EncryptedBlobStore {
    fn namespace_id(&self) -> StorageResult<String>;

    fn list(&self, cursor: Option<&str>, limit: usize) -> StorageResult<EncryptedBlobPage>;

    fn delete(&self, blob_id: &str) -> StorageResult<bool>;

    /// Returns whether a transfer or other Provider operation currently owns
    /// an unexpired lease for this object. Existing Providers remain source
    /// compatible because the default is an unleased object.
    fn is_leased(&self, _blob_id: &str) -> StorageResult<bool> {
        Ok(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobLease {
    pub blob_id: String,
    pub owner_id: String,
    pub expires_at_unix_secs: i64,
}

/// Optional bounded transfer capability layered above the stable Blob store
/// contract. Implementations must make writes idempotent for an already
/// completed content-addressed object and persist incomplete chunks until the
/// caller resumes or abandons the transfer.
pub trait EncryptedBlobTransferStore: EncryptedBlobStore {
    fn namespace_id(&self) -> StorageResult<String>;

    fn read_chunk(&self, blob_id: &str, offset: u64, max_bytes: usize) -> StorageResult<Vec<u8>>;

    fn write_chunk(
        &self,
        blob_id: &str,
        total_size: u64,
        offset: u64,
        chunk: &[u8],
        finalize: bool,
    ) -> StorageResult<()>;

    fn acquire_lease(
        &self,
        blob_id: &str,
        owner_id: &str,
        now_unix_secs: i64,
        ttl_secs: i64,
    ) -> StorageResult<BlobLease>;

    fn renew_lease(
        &self,
        blob_id: &str,
        owner_id: &str,
        now_unix_secs: i64,
        ttl_secs: i64,
    ) -> StorageResult<BlobLease>;

    fn release_lease(&self, blob_id: &str, owner_id: &str) -> StorageResult<()>;
}

/// Optional recovery capability for untrusted or interrupted remote
/// transfers. Implementations remove only incomplete staged bytes and must
/// never delete an already published content-addressed object.
pub trait RecoverableEncryptedBlobTransferStore: EncryptedBlobTransferStore {
    fn abort_transfer(&self, blob_id: &str, owner_id: &str) -> StorageResult<()>;
}

pub fn validate_blob_id(blob_id: &str) -> StorageResult<()> {
    if blob_id.len() != 64
        || !blob_id
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(StorageError::BlobStore(
            "blob ID must be a 64-character lowercase SHA-256 hex digest".to_string(),
        ));
    }
    Ok(())
}

pub fn compute_blob_id(encrypted_blob: &[u8]) -> String {
    format!("{:x}", Sha256::digest(encrypted_blob))
}

#[cfg(feature = "filesystem-blob-store")]
mod filesystem {
    use std::ffi::OsStr;
    use std::fs::{self, File, OpenOptions};
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tempfile::NamedTempFile;

    use super::{
        compute_blob_id, validate_blob_id, BlobLease, EncryptedBlobMetadata, EncryptedBlobPage,
        EncryptedBlobStore, EncryptedBlobTransferStore, ManageableEncryptedBlobStore,
        RecoverableEncryptedBlobTransferStore, MAX_BLOB_LEASE_TTL_SECS, MAX_BLOB_PAGE_SIZE,
        MAX_BLOB_TRANSFER_CHUNK_SIZE,
    };
    use crate::error::{StorageError, StorageResult};

    /// Content-addressed encrypted blob store rooted at a caller-owned directory.
    ///
    /// Objects are placed under two digest-prefix directories. Callers cannot
    /// supply path components because only validated SHA-256 identifiers are
    /// accepted.
    #[derive(Debug, Clone)]
    pub struct FileSystemBlobStore {
        root: PathBuf,
    }

    impl FileSystemBlobStore {
        const MAX_PREFIX_DIRECTORY_ENTRIES: usize = 65_536;

        pub fn new(root: impl Into<PathBuf>) -> Self {
            Self { root: root.into() }
        }

        pub fn root(&self) -> &Path {
            &self.root
        }

        pub fn blob_path(&self, blob_id: &str) -> StorageResult<PathBuf> {
            validate_blob_id(blob_id)?;
            Ok(self
                .root
                .join(&blob_id[..2])
                .join(&blob_id[2..4])
                .join(blob_id))
        }

        fn prepare_parent(&self, blob_id: &str) -> StorageResult<PathBuf> {
            let path = self.blob_path(blob_id)?;
            let parent = path.parent().ok_or_else(|| {
                StorageError::BlobStore("blob path has no parent directory".to_string())
            })?;
            fs::create_dir_all(parent)?;
            for directory in [
                self.root.as_path(),
                parent.parent().unwrap_or(parent),
                parent,
            ] {
                let metadata = fs::symlink_metadata(directory)?;
                if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                    return Err(StorageError::BlobStore(format!(
                        "blob directory is not a regular directory: {}",
                        directory.display()
                    )));
                }
            }
            Ok(path)
        }

        fn sidecar_root(&self, suffix: &str) -> PathBuf {
            let mut path = self.root.clone();
            path.set_extension(suffix);
            path
        }

        fn sidecar_path(
            &self,
            suffix: &str,
            blob_id: &str,
            extension: &str,
        ) -> StorageResult<PathBuf> {
            validate_blob_id(blob_id)?;
            let directory = self.sidecar_root(suffix);
            fs::create_dir_all(&directory)?;
            let metadata = fs::symlink_metadata(&directory)?;
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(StorageError::BlobStore(format!(
                    "Blob Provider sidecar is not a regular directory: {}",
                    directory.display()
                )));
            }
            Ok(directory.join(format!("{blob_id}.{extension}")))
        }

        fn lease_path(&self, blob_id: &str) -> StorageResult<PathBuf> {
            self.sidecar_path("leases", blob_id, "lease")
        }

        fn transfer_path(&self, blob_id: &str) -> StorageResult<PathBuf> {
            self.sidecar_path("transfers", blob_id, "part")
        }

        fn read_lease(path: &Path) -> StorageResult<Option<(String, i64)>> {
            let bytes = match fs::read(path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(StorageError::Io(error)),
            };
            let text = String::from_utf8(bytes).map_err(|_| {
                StorageError::BlobStore("Blob lease record is not UTF-8".to_string())
            })?;
            let mut lines = text.lines();
            let owner = lines.next().unwrap_or_default().to_string();
            let expiry = lines
                .next()
                .ok_or_else(|| {
                    StorageError::BlobStore("Blob lease record is truncated".to_string())
                })?
                .parse::<i64>()
                .map_err(|_| StorageError::BlobStore("Blob lease expiry is invalid".to_string()))?;
            if owner.is_empty() || lines.next().is_some() {
                return Err(StorageError::BlobStore(
                    "Blob lease record is malformed".to_string(),
                ));
            }
            Ok(Some((owner, expiry)))
        }

        fn validate_lease_inputs(
            owner_id: &str,
            now_unix_secs: i64,
            ttl_secs: i64,
        ) -> StorageResult<()> {
            if owner_id.is_empty() || owner_id.len() > 512 || owner_id.contains('\n') {
                return Err(StorageError::Validation(
                    "Blob lease owner ID must contain 1 to 512 bytes without newlines".to_string(),
                ));
            }
            if now_unix_secs < 0 || !(1..=MAX_BLOB_LEASE_TTL_SECS).contains(&ttl_secs) {
                return Err(StorageError::Validation(format!(
                    "Blob lease time must be non-negative and TTL must be between 1 and {MAX_BLOB_LEASE_TTL_SECS} seconds"
                )));
            }
            Ok(())
        }

        fn read_verified(&self, blob_id: &str, max_bytes: usize) -> StorageResult<Vec<u8>> {
            let path = self.blob_path(blob_id)?;
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    StorageError::BlobStore(format!("blob {blob_id} is missing"))
                } else {
                    StorageError::Io(error)
                }
            })?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} is not a regular file"
                )));
            }
            if metadata.len() > max_bytes as u64 {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} exceeds the {max_bytes}-byte read limit"
                )));
            }

            let file = File::open(&path)?;
            let read_limit = max_bytes.checked_add(1).unwrap_or(max_bytes) as u64;
            let mut limited = file.take(read_limit);
            let mut encrypted_blob = Vec::new();
            encrypted_blob
                .try_reserve_exact(metadata.len() as usize)
                .map_err(|error| {
                    StorageError::BlobStore(format!("cannot allocate blob read buffer: {error}"))
                })?;
            limited.read_to_end(&mut encrypted_blob)?;
            if encrypted_blob.len() > max_bytes {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} grew beyond the {max_bytes}-byte read limit"
                )));
            }
            if compute_blob_id(&encrypted_blob) != blob_id {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} failed SHA-256 verification"
                )));
            }
            Ok(encrypted_blob)
        }

        fn validate_root_for_listing(&self) -> StorageResult<bool> {
            match fs::symlink_metadata(&self.root) {
                Ok(metadata) => {
                    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                        return Err(StorageError::BlobStore(format!(
                            "blob root is not a regular directory: {}",
                            self.root.display()
                        )));
                    }
                    Ok(true)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(StorageError::Io(error)),
            }
        }

        fn sorted_directory_entries(
            directory: &Path,
            maximum_entries: usize,
        ) -> StorageResult<Vec<fs::DirEntry>> {
            let mut entries = Vec::new();
            for entry in fs::read_dir(directory)? {
                if entries.len() >= maximum_entries {
                    return Err(StorageError::BlobStore(format!(
                        "blob directory exceeds the {maximum_entries}-entry maintenance limit: {}",
                        directory.display()
                    )));
                }
                entries.push(entry?);
            }
            entries.sort_by_key(|entry| entry.file_name());
            Ok(entries)
        }

        fn validate_prefix_directory(entry: &fs::DirEntry) -> StorageResult<String> {
            let name = entry.file_name().into_string().map_err(|_| {
                StorageError::BlobStore("blob prefix directory name is not UTF-8".to_string())
            })?;
            if name.len() != 2
                || !name
                    .as_bytes()
                    .iter()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            {
                return Err(StorageError::BlobStore(format!(
                    "invalid blob prefix directory: {name}"
                )));
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(StorageError::BlobStore(format!(
                    "blob prefix is not a regular directory: {}",
                    entry.path().display()
                )));
            }
            Ok(name)
        }

        fn metadata_for_inventory(
            first_prefix: &str,
            second_prefix: &str,
            entry: &fs::DirEntry,
        ) -> StorageResult<EncryptedBlobMetadata> {
            let blob_id = entry
                .file_name()
                .into_string()
                .map_err(|_| StorageError::BlobStore("blob file name is not UTF-8".to_string()))?;
            validate_blob_id(&blob_id)?;
            if !blob_id.starts_with(first_prefix) || blob_id.get(2..4) != Some(second_prefix) {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} is stored below the wrong prefix directory"
                )));
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(StorageError::BlobStore(format!(
                    "blob inventory entry is not a regular file: {}",
                    entry.path().display()
                )));
            }
            let modified_at_unix_secs = metadata
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .try_into()
                .unwrap_or(i64::MAX);
            Ok(EncryptedBlobMetadata {
                blob_id,
                stored_size: metadata.len(),
                modified_at_unix_secs,
            })
        }
    }

    impl EncryptedBlobStore for FileSystemBlobStore {
        fn put(&self, blob_id: &str, encrypted_blob: &[u8]) -> StorageResult<()> {
            validate_blob_id(blob_id)?;
            if compute_blob_id(encrypted_blob) != blob_id {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} does not match supplied ciphertext"
                )));
            }
            let path = self.prepare_parent(blob_id)?;
            if path.exists() {
                self.read_verified(blob_id, encrypted_blob.len())?;
                return Ok(());
            }

            let parent = path.parent().ok_or_else(|| {
                StorageError::BlobStore("blob path has no parent directory".to_string())
            })?;
            let mut temporary = NamedTempFile::new_in(parent)?;
            temporary.as_file_mut().write_all(encrypted_blob)?;
            temporary.as_file_mut().sync_all()?;
            match temporary.persist_noclobber(&path) {
                Ok(_) => Ok(()),
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    self.read_verified(blob_id, encrypted_blob.len())?;
                    Ok(())
                }
                Err(error) => Err(StorageError::Io(error.error)),
            }
        }

        fn get(&self, blob_id: &str, max_bytes: usize) -> StorageResult<Vec<u8>> {
            self.read_verified(blob_id, max_bytes)
        }
    }

    impl ManageableEncryptedBlobStore for FileSystemBlobStore {
        fn namespace_id(&self) -> StorageResult<String> {
            let root = if self.root.is_absolute() {
                self.root.clone()
            } else {
                std::env::current_dir()?.join(&self.root)
            };
            Ok(format!("filesystem:{}", root.to_string_lossy()))
        }

        fn list(&self, cursor: Option<&str>, limit: usize) -> StorageResult<EncryptedBlobPage> {
            if !(1..=MAX_BLOB_PAGE_SIZE).contains(&limit) {
                return Err(StorageError::Validation(format!(
                    "blob page size must be between 1 and {MAX_BLOB_PAGE_SIZE}"
                )));
            }
            if let Some(cursor) = cursor {
                validate_blob_id(cursor)?;
            }
            if !self.validate_root_for_listing()? {
                return Ok(EncryptedBlobPage {
                    blobs: Vec::new(),
                    next_cursor: None,
                });
            }

            let mut blobs = Vec::with_capacity(limit.saturating_add(1));
            let cursor_first = cursor.map(|cursor| &cursor[..2]);
            let cursor_second = cursor.map(|cursor| &cursor[2..4]);
            'inventory: for first in Self::sorted_directory_entries(&self.root, 256)? {
                let first_prefix = Self::validate_prefix_directory(&first)?;
                if cursor_first.is_some_and(|cursor| first_prefix.as_str() < cursor) {
                    continue;
                }
                for second in Self::sorted_directory_entries(&first.path(), 256)? {
                    let second_prefix = Self::validate_prefix_directory(&second)?;
                    if cursor_first == Some(first_prefix.as_str())
                        && cursor_second.is_some_and(|cursor| second_prefix.as_str() < cursor)
                    {
                        continue;
                    }
                    for entry in Self::sorted_directory_entries(
                        &second.path(),
                        Self::MAX_PREFIX_DIRECTORY_ENTRIES,
                    )? {
                        let metadata =
                            Self::metadata_for_inventory(&first_prefix, &second_prefix, &entry)?;
                        if cursor.is_some_and(|cursor| metadata.blob_id.as_str() <= cursor) {
                            continue;
                        }
                        blobs.push(metadata);
                        if blobs.len() > limit {
                            break 'inventory;
                        }
                    }
                }
            }

            let next_cursor = if blobs.len() > limit {
                blobs.truncate(limit);
                blobs.last().map(|blob| blob.blob_id.clone())
            } else {
                None
            };
            Ok(EncryptedBlobPage { blobs, next_cursor })
        }

        fn delete(&self, blob_id: &str) -> StorageResult<bool> {
            if self.is_leased(blob_id)? {
                return Err(StorageError::ConstraintViolation(format!(
                    "Blob {blob_id} is protected by an active Provider lease"
                )));
            }
            let path = self.blob_path(blob_id)?;
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
                Err(error) => return Err(StorageError::Io(error)),
            };
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} is not a regular file"
                )));
            }
            fs::remove_file(&path)?;
            if let Some(second) = path.parent() {
                let _ = fs::remove_dir(second);
                if let Some(first) = second.parent() {
                    if first.as_os_str() != OsStr::new("") && first != self.root {
                        let _ = fs::remove_dir(first);
                    }
                }
            }
            Ok(true)
        }

        fn is_leased(&self, blob_id: &str) -> StorageResult<bool> {
            let path = self.lease_path(blob_id)?;
            let Some((_owner, expiry)) = Self::read_lease(&path)? else {
                return Ok(false);
            };
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .try_into()
                .unwrap_or(i64::MAX);
            if expiry <= now {
                let _ = fs::remove_file(path);
                return Ok(false);
            }
            Ok(true)
        }
    }

    impl EncryptedBlobTransferStore for FileSystemBlobStore {
        fn namespace_id(&self) -> StorageResult<String> {
            <Self as ManageableEncryptedBlobStore>::namespace_id(self)
        }

        fn read_chunk(
            &self,
            blob_id: &str,
            offset: u64,
            max_bytes: usize,
        ) -> StorageResult<Vec<u8>> {
            validate_blob_id(blob_id)?;
            if !(1..=MAX_BLOB_TRANSFER_CHUNK_SIZE).contains(&max_bytes) {
                return Err(StorageError::Validation(format!(
                    "Blob transfer chunk size must be between 1 and {MAX_BLOB_TRANSFER_CHUNK_SIZE}"
                )));
            }
            let path = self.blob_path(blob_id)?;
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    StorageError::BlobStore(format!("blob {blob_id} is missing"))
                } else {
                    StorageError::Io(error)
                }
            })?;
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(StorageError::BlobStore(format!(
                    "blob {blob_id} is not a regular file"
                )));
            }
            if offset > metadata.len() {
                return Err(StorageError::Validation(format!(
                    "Blob transfer offset {offset} exceeds blob size {}",
                    metadata.len()
                )));
            }
            let mut file = File::open(path)?;
            file.seek(SeekFrom::Start(offset))?;
            let remaining = metadata.len() - offset;
            let amount = remaining.min(max_bytes as u64) as usize;
            let mut chunk = vec![0; amount];
            file.read_exact(&mut chunk)?;
            Ok(chunk)
        }

        fn write_chunk(
            &self,
            blob_id: &str,
            total_size: u64,
            offset: u64,
            chunk: &[u8],
            finalize: bool,
        ) -> StorageResult<()> {
            validate_blob_id(blob_id)?;
            if total_size == 0
                || total_size > usize::MAX as u64
                || chunk.len() > MAX_BLOB_TRANSFER_CHUNK_SIZE
            {
                return Err(StorageError::Validation(
                    "Blob transfer size is outside supported bounds".to_string(),
                ));
            }
            let end = offset.checked_add(chunk.len() as u64).ok_or_else(|| {
                StorageError::Validation("Blob transfer offset overflow".to_string())
            })?;
            if end > total_size || finalize != (end == total_size) {
                return Err(StorageError::Validation(
                    "Blob transfer chunk boundary is invalid".to_string(),
                ));
            }
            let destination = self.blob_path(blob_id)?;
            if destination.exists() {
                let completed = self.read_verified(blob_id, total_size as usize)?;
                if completed.len() as u64 == total_size {
                    return Ok(());
                }
                return Err(StorageError::ConstraintViolation(format!(
                    "Blob {blob_id} exists with a different declared size"
                )));
            }
            let partial = self.transfer_path(blob_id)?;
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(&partial)?;
            let current = file.metadata()?.len();
            if current < offset {
                return Err(StorageError::ConstraintViolation(format!(
                    "Blob transfer checkpoint offset {offset} is ahead of staged size {current}"
                )));
            }
            if current > offset {
                if end > current {
                    return Err(StorageError::ConstraintViolation(format!(
                        "Blob transfer replay from {offset} overlaps staged size {current}"
                    )));
                }
                file.seek(SeekFrom::Start(offset))?;
                let mut staged = vec![0; chunk.len()];
                file.read_exact(&mut staged)?;
                if staged != chunk {
                    return Err(StorageError::ConstraintViolation(format!(
                        "Blob transfer replay at offset {offset} does not match staged ciphertext"
                    )));
                }
                if !finalize {
                    return Ok(());
                }
            } else {
                file.seek(SeekFrom::Start(offset))?;
                file.write_all(chunk)?;
                file.sync_all()?;
            }
            if finalize {
                drop(file);
                let bytes = fs::read(&partial)?;
                if bytes.len() as u64 != total_size || compute_blob_id(&bytes) != blob_id {
                    return Err(StorageError::BlobStore(format!(
                        "Blob {blob_id} failed final transfer verification"
                    )));
                }
                let destination = self.prepare_parent(blob_id)?;
                match fs::rename(&partial, &destination) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        self.read_verified(blob_id, total_size as usize)?;
                        let _ = fs::remove_file(&partial);
                        Ok(())
                    }
                    Err(error) => Err(StorageError::Io(error)),
                }
            } else {
                Ok(())
            }
        }

        fn acquire_lease(
            &self,
            blob_id: &str,
            owner_id: &str,
            now_unix_secs: i64,
            ttl_secs: i64,
        ) -> StorageResult<BlobLease> {
            Self::validate_lease_inputs(owner_id, now_unix_secs, ttl_secs)?;
            let path = self.lease_path(blob_id)?;
            if let Some((existing_owner, expiry)) = Self::read_lease(&path)? {
                if expiry > now_unix_secs && existing_owner != owner_id {
                    return Err(StorageError::ConstraintViolation(format!(
                        "Blob {blob_id} is leased by another owner"
                    )));
                }
                if expiry > now_unix_secs {
                    return self.renew_lease(blob_id, owner_id, now_unix_secs, ttl_secs);
                }
                if expiry <= now_unix_secs {
                    let _ = fs::remove_file(&path);
                }
            }
            let expires = now_unix_secs.checked_add(ttl_secs).ok_or_else(|| {
                StorageError::Validation("Blob lease expiry overflow".to_string())
            })?;
            let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return Err(StorageError::ConstraintViolation(format!(
                        "Blob {blob_id} is leased by another owner"
                    )));
                }
                Err(error) => return Err(StorageError::Io(error)),
            };
            writeln!(file, "{owner_id}\n{expires}")?;
            file.sync_all()?;
            Ok(BlobLease {
                blob_id: blob_id.to_string(),
                owner_id: owner_id.to_string(),
                expires_at_unix_secs: expires,
            })
        }

        fn renew_lease(
            &self,
            blob_id: &str,
            owner_id: &str,
            now_unix_secs: i64,
            ttl_secs: i64,
        ) -> StorageResult<BlobLease> {
            Self::validate_lease_inputs(owner_id, now_unix_secs, ttl_secs)?;
            let path = self.lease_path(blob_id)?;
            let Some((existing_owner, expiry)) = Self::read_lease(&path)? else {
                return Err(StorageError::ConstraintViolation(format!(
                    "Blob {blob_id} has no active lease"
                )));
            };
            if existing_owner != owner_id || expiry <= now_unix_secs {
                return Err(StorageError::ConstraintViolation(format!(
                    "Blob {blob_id} lease is not owned by this transfer"
                )));
            }
            let expires = now_unix_secs.checked_add(ttl_secs).ok_or_else(|| {
                StorageError::Validation("Blob lease expiry overflow".to_string())
            })?;
            let temporary = NamedTempFile::new_in(path.parent().unwrap())?;
            let mut file = temporary.as_file();
            writeln!(file, "{owner_id}\n{expires}")?;
            file.sync_all()?;
            temporary
                .persist(&path)
                .map_err(|error| StorageError::Io(error.error))?;
            Ok(BlobLease {
                blob_id: blob_id.to_string(),
                owner_id: owner_id.to_string(),
                expires_at_unix_secs: expires,
            })
        }

        fn release_lease(&self, blob_id: &str, owner_id: &str) -> StorageResult<()> {
            let path = self.lease_path(blob_id)?;
            if let Some((existing_owner, _)) = Self::read_lease(&path)? {
                if existing_owner != owner_id {
                    return Err(StorageError::ConstraintViolation(format!(
                        "Blob {blob_id} lease is owned by another transfer"
                    )));
                }
                let _ = fs::remove_file(path);
            }
            Ok(())
        }
    }

    impl RecoverableEncryptedBlobTransferStore for FileSystemBlobStore {
        fn abort_transfer(&self, blob_id: &str, owner_id: &str) -> StorageResult<()> {
            validate_blob_id(blob_id)?;
            Self::validate_lease_inputs(owner_id, 0, 1)?;
            let lease_path = self.lease_path(blob_id)?;
            if let Some((lease_owner, _)) = Self::read_lease(&lease_path)? {
                if lease_owner != owner_id {
                    return Err(StorageError::ConstraintViolation(format!(
                        "Blob {blob_id} transfer is leased by another owner"
                    )));
                }
            } else {
                return Err(StorageError::ConstraintViolation(format!(
                    "Blob {blob_id} transfer has no owner lease"
                )));
            }
            let partial = self.transfer_path(blob_id)?;
            match fs::remove_file(partial) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(StorageError::Io(error)),
            }
        }
    }
}

#[cfg(feature = "filesystem-blob-store")]
pub use filesystem::FileSystemBlobStore;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_ids_reject_path_syntax_and_noncanonical_hex() {
        for invalid in [
            "../secret",
            "A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3A3",
            "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
            "abcd",
        ] {
            assert!(validate_blob_id(invalid).is_err());
        }
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn filesystem_blob_store_roundtrips_and_verifies_ciphertext() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let encrypted = b"opaque authenticated ciphertext";
        let blob_id = compute_blob_id(encrypted);

        store.put(&blob_id, encrypted).unwrap();
        store.put(&blob_id, encrypted).unwrap();

        assert_eq!(store.get(&blob_id, encrypted.len()).unwrap(), encrypted);
        assert_eq!(
            store.blob_path(&blob_id).unwrap().components().count(),
            directory.path().components().count() + 3
        );
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn filesystem_blob_store_rejects_wrong_id_corruption_and_oversize() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let encrypted = b"ciphertext";
        let blob_id = compute_blob_id(encrypted);
        let wrong_id = compute_blob_id(b"different");

        assert!(store.put(&wrong_id, encrypted).is_err());
        store.put(&blob_id, encrypted).unwrap();
        assert!(store.get(&blob_id, encrypted.len() - 1).is_err());
        std::fs::write(store.blob_path(&blob_id).unwrap(), b"corrupt").unwrap();
        assert!(store.get(&blob_id, encrypted.len()).is_err());
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn filesystem_blob_inventory_is_bounded_paginated_and_deletable() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        let mut expected = Vec::new();
        for encrypted in [b"third".as_slice(), b"first", b"second"] {
            let blob_id = compute_blob_id(encrypted);
            store.put(&blob_id, encrypted).unwrap();
            expected.push(blob_id);
        }
        expected.sort();

        let first = store.list(None, 2).unwrap();
        assert_eq!(
            first
                .blobs
                .iter()
                .map(|blob| blob.blob_id.clone())
                .collect::<Vec<_>>(),
            expected[..2]
        );
        assert_eq!(first.next_cursor.as_deref(), Some(expected[1].as_str()));
        let second = store.list(first.next_cursor.as_deref(), 2).unwrap();
        assert_eq!(second.blobs.len(), 1);
        assert_eq!(second.blobs[0].blob_id, expected[2]);
        assert!(second.next_cursor.is_none());

        assert!(store.delete(&expected[1]).unwrap());
        assert!(!store.delete(&expected[1]).unwrap());
        let remaining = store.list(None, 10).unwrap();
        assert_eq!(remaining.blobs.len(), 2);
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn filesystem_blob_inventory_rejects_invalid_limits_cursors_and_entries() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path());
        assert!(store.list(None, 0).is_err());
        assert!(store.list(Some("../cursor"), 1).is_err());

        std::fs::create_dir_all(directory.path()).unwrap();
        std::fs::write(directory.path().join("unexpected"), b"data").unwrap();
        assert!(store.list(None, 10).is_err());
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn filesystem_blob_leases_are_reentrant_and_stale_owner_is_recoverable() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileSystemBlobStore::new(directory.path().join("lease-test.blobs"));
        let blob_id = compute_blob_id(b"leased ciphertext");

        store.acquire_lease(&blob_id, "first", 10, 10).unwrap();
        let renewed = store.acquire_lease(&blob_id, "first", 11, 20).unwrap();
        assert_eq!(renewed.expires_at_unix_secs, 31);
        assert!(store.acquire_lease(&blob_id, "second", 12, 10).is_err());

        let recovered = store.acquire_lease(&blob_id, "second", 32, 10).unwrap();
        assert_eq!(recovered.owner_id, "second");
        store.release_lease(&blob_id, "second").unwrap();
    }

    #[cfg(feature = "filesystem-blob-store")]
    #[test]
    fn filesystem_delete_observes_a_lease_from_another_instance() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("shared.blobs");
        let writer = FileSystemBlobStore::new(&root);
        let maintenance = FileSystemBlobStore::new(&root);
        let ciphertext = b"cross-process lease";
        let blob_id = compute_blob_id(ciphertext);
        writer.put(&blob_id, ciphertext).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        writer.acquire_lease(&blob_id, "copy", now, 60).unwrap();

        assert!(maintenance.delete(&blob_id).is_err());
        writer.release_lease(&blob_id, "copy").unwrap();
        assert!(maintenance.delete(&blob_id).unwrap());
    }
}
