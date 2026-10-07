//! Ephemeral complete backups, independent of configured synchronization state.
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use mdbx_ffi::MdbxVault;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use crate::runtime::{HostRuntime, RpcFailure, MAX_BINARY_CHUNK_BYTES};

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(300);

struct Export {
    // Close readers before releasing the lease/removing files on Windows.
    file: File,
    _directory: crate::backup_scratch::BackupScratch,
    vault: Weak<MdbxVault>,
    size: u64,
    sha256: String,
    format: &'static str,
    blob_count: usize,
    expires: Instant,
}

#[derive(Default)]
pub(crate) struct LocalExports {
    sessions: HashMap<String, Export>,
}

impl LocalExports {
    pub(crate) fn clear_vault(&mut self, vault: &Arc<MdbxVault>) {
        self.sessions.retain(|_, session| !Weak::ptr_eq(&session.vault, &Arc::downgrade(vault)));
    }
}

/// Accept only the exact complete-backup layout, never general-purpose ZIP
/// extraction. Publish the database and sidecar directory together by rename.
pub(crate) fn restore_archive(source: &Path, imports: &Path, handle: &str) -> Result<bool, RpcFailure> {
    let mut file = File::open(source).map_err(|_| failure())?;
    let mut magic = [0; 4];
    if file.read(&mut magic).map_err(|_| failure())? != 4 || magic != *b"PK\x03\x04" { return Ok(false); }
    file.rewind().map_err(|_| failure())?;
    if file.metadata().map_err(|_| failure())?.len() > MAX_BYTES { return Err(failure()); }
    let mut archive = ZipArchive::new(file).map_err(|_| failure())?;
    if archive.is_empty() || archive.len() > 65_536 { return Err(failure()); }
    let staged = tempfile::Builder::new().prefix("restore-").tempdir_in(imports).map_err(|_| failure())?;
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| failure())?;
        let name = entry.name().to_string();
        let blob_id = backup_blob_id(&name);
        if (name != "vault.mdbx" && blob_id.is_none()) || !names.insert(name.clone()) ||
            entry.is_dir() || entry.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000) ||
            entry.compression() != CompressionMethod::Stored || entry.size() == 0 {
            return Err(failure());
        }
        total = total.checked_add(entry.size()).filter(|v| *v <= MAX_BYTES).ok_or_else(failure)?;
        let destination = staged.path().join(&name);
        fs::create_dir_all(destination.parent().ok_or_else(failure)?).map_err(|_| failure())?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(|_| failure())?;
        let size = entry.size();
        if std::io::copy(&mut Read::by_ref(&mut entry).take(size + 1), &mut output).map_err(|_| failure())? != size { return Err(failure()); }
        output.flush().and_then(|_| output.sync_all()).map_err(|_| failure())?;
        drop(output);
        if let Some(id) = blob_id {
            if hash_file(&mut File::open(&destination).map_err(|_| failure())?)? != id { return Err(failure()); }
        }
    }
    if !names.contains("vault.mdbx") { return Err(failure()); }
    let info = mdbx_ffi::inspect_vault_migration(staged.path().join("vault.mdbx").to_string_lossy().into_owned()).map_err(|_| failure())?;
    if !info.initialized || info.format_version.as_deref() != Some("MDBX-2") || info.unknown_critical_extensions { return Err(failure()); }
    let destination = imports.join(handle);
    if destination.exists() { return Err(failure()); }
    fs::rename(staged.path(), &destination).map_err(|_| failure())?;
    Ok(true)
}

fn backup_blob_id(name: &str) -> Option<&str> {
    let path: Vec<_> = name.split('/').collect();
    if path.len() != 4 || path[0] != "vault.mdbx.blobs" { return None; }
    let id = path[3];
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || path[1] != &id[..2] || path[2] != &id[2..4] { return None; }
    Some(id)
}

pub(crate) fn verify_import_blobs(vault: &MdbxVault) -> Result<(), RpcFailure> {
    let mut cursor = None;
    loop {
        let page = vault.list_external_blob_references(cursor, 200).map_err(|_| failure())?;
        if page.items.iter().any(|item| item.state != mdbx_ffi::MdbxExternalBlobState::Available) { return Err(failure()); }
        cursor = page.next_cursor;
        if cursor.is_none() { return Ok(()); }
    }
}

pub(crate) fn release_import(imports: &Path, handle: &str) -> Result<bool, RpcFailure> {
    // Native handles are UUIDs validated by transfer.release, and only our
    // archive extractor creates these directories. Refuse links/reparse roots.
    let path = imports.join(handle);
    if !path.exists() { return Ok(false); }
    let metadata = fs::symlink_metadata(&path).map_err(|_| failure())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || path.canonicalize().map_err(|_| failure())?.parent() != Some(imports.canonicalize().map_err(|_| failure())?.as_path()) { return Err(failure()); }
    fs::remove_dir_all(path).map_err(|_| failure())?;
    Ok(true)
}

pub(crate) fn copy_import_blobs(source: &Path, destination: &Path) -> Result<(), RpcFailure> {
    // Only restore_archive produces this nested import layout. Flat legacy
    // imports must not silently pick up arbitrary neighboring directories.
    if source.file_name().and_then(|v| v.to_str()) != Some("vault.mdbx") { return Ok(()); }
    let sidecar = source.with_extension("mdbx.blobs");
    if !sidecar.exists() { return Ok(()); }
    let target = destination.with_extension("mdbx.blobs");
    let mut count = 0_usize;
    let mut total = 0_u64;
    for first in fs::read_dir(&sidecar).map_err(|_| failure())? {
        let first = first.map_err(|_| failure())?;
        if !first.file_type().map_err(|_| failure())?.is_dir() { return Err(failure()); }
        for second in fs::read_dir(first.path()).map_err(|_| failure())? {
            let second = second.map_err(|_| failure())?;
            if !second.file_type().map_err(|_| failure())?.is_dir() { return Err(failure()); }
            for blob in fs::read_dir(second.path()).map_err(|_| failure())? {
                let blob = blob.map_err(|_| failure())?;
                let name = format!("vault.mdbx.blobs/{}/{}/{}", first.file_name().to_string_lossy(), second.file_name().to_string_lossy(), blob.file_name().to_string_lossy());
                let id = backup_blob_id(&name).ok_or_else(failure)?;
                if !blob.file_type().map_err(|_| failure())?.is_file() { return Err(failure()); }
                count += 1;
                total = total.checked_add(blob.metadata().map_err(|_| failure())?.len()).filter(|v| *v <= MAX_BYTES).ok_or_else(failure)?;
                if count > 65_535 { return Err(failure()); }
                let mut input = File::open(blob.path()).map_err(|_| failure())?;
                if hash_file(&mut input)? != id { return Err(failure()); }
                let parent = target.join(&id[..2]).join(&id[2..4]);
                fs::create_dir_all(&parent).map_err(|_| failure())?;
                let mut output = fs::OpenOptions::new().write(true).create_new(true).open(parent.join(id)).map_err(|_| failure())?;
                input.rewind().map_err(|_| failure())?;
                std::io::copy(&mut input.take(MAX_BYTES + 1), &mut output).map_err(|_| failure())?;
                output.sync_all().map_err(|_| failure())?;
                if hash_file(&mut File::open(parent.join(id)).map_err(|_| failure())?)? != id { return Err(failure()); }
            }
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Begin { vault_handle: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest { vault_handle: String, file_handle: String, offset: u64, max_bytes: u32 }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Release { file_handle: String }

fn failure() -> RpcFailure {
    RpcFailure::new("complete-backup-failed", "完整备份失败：请检查附件是否完整，并确认数据库及附件合计不超过 512 MiB。", false)
}

pub(crate) fn handle(runtime: &mut HostRuntime, method: &str, params: Value) -> Result<Value, RpcFailure> {
    runtime.local_exports.sessions.retain(|_, session| {
        session.expires > Instant::now() && runtime.vaults.values().any(|vault| Weak::ptr_eq(&Arc::downgrade(vault), &session.vault))
    });
    match method {
        "vault.export.begin" => {
            let request: Begin = serde_json::from_value(params).map_err(|_| RpcFailure::invalid("Invalid backup request."))?;
            let vault = runtime.require_open_vault(&request.vault_handle)?;
            if runtime.local_exports.sessions.len() >= 4 {
                return Err(RpcFailure::invalid("Too many active backup downloads."));
            }
            let directory = crate::backup_scratch::BackupScratch::new(&runtime.root).map_err(|_| failure())?;
            let database = directory.path().join("vault.mdbx");
            // This facade returns only after copying all referenced ciphertext
            // under one SQLite snapshot. Nothing reads the live vault below.
            let inventory = vault.create_complete_backup(database.to_string_lossy().into_owned(), MAX_BYTES).map_err(|_| failure())?;
            let blob_count = inventory.items.len();
            let (path, format) = if blob_count == 0 { (database.clone(), "mdbx") } else {
                let path = directory.path().join("backup.zip");
                let output = File::create(&path).map_err(|_| failure())?;
                let mut archive = ZipWriter::new(output);
                let mut total = 22_u64;
                append_file(&mut archive, "vault.mdbx", &database, &mut total)?;
                for item in &inventory.items {
                    let id = &item.blob_id;
                    let relative = format!("vault.mdbx.blobs/{}/{}/{}", &id[..2], &id[2..4], id);
                    append_file(&mut archive, &relative, &directory.path().join(&relative), &mut total)?;
                }
                let output = archive.finish().map_err(|_| failure())?;
                output.sync_all().map_err(|_| failure())?;
                (path, "zip")
            };
            let mut file = File::open(&path).map_err(|_| failure())?;
            let size = file.metadata().map_err(|_| failure())?.len();
            if size == 0 || size > MAX_BYTES { return Err(failure()); }
            let sha256 = hash_file(&mut file)?;
            let handle = Uuid::new_v4().to_string();
            let result = json!({ "fileHandle": handle, "purpose": "vault-backup", "format": format,
                "blobCount": blob_count, "sizeBytes": size, "sha256": sha256 });
            runtime.local_exports.sessions.insert(handle, Export {
                _directory: directory, vault: Arc::downgrade(&vault), file, size, sha256, format, blob_count, expires: Instant::now() + TTL,
            });
            Ok(result)
        }
        "vault.export.read" => {
            let request: ReadRequest = serde_json::from_value(params).map_err(|_| RpcFailure::invalid("Invalid backup chunk request."))?;
            let vault = runtime.require_open_vault(&request.vault_handle)?;
            let session = runtime.local_exports.sessions.get_mut(&request.file_handle)
                .ok_or_else(|| RpcFailure::invalid("Backup download expired."))?;
            if !Weak::ptr_eq(&Arc::downgrade(&vault), &session.vault) || request.offset >= session.size || request.max_bytes == 0 || request.max_bytes as usize > MAX_BINARY_CHUNK_BYTES {
                return Err(RpcFailure::invalid("Invalid backup download binding or range."));
            }
            let count = (session.size - request.offset).min(request.max_bytes as u64) as usize;
            let mut bytes = vec![0; count];
            session.file.seek(SeekFrom::Start(request.offset)).and_then(|_| session.file.read_exact(&mut bytes)).map_err(|_| failure())?;
            let next = request.offset + count as u64;
            Ok(json!({ "fileHandle": request.file_handle, "purpose": "vault-backup", "format": session.format,
                "blobCount": session.blob_count, "sizeBytes": session.size, "sha256": session.sha256,
                "offset": request.offset, "nextOffset": next, "eof": next == session.size, "dataBase64": BASE64.encode(bytes) }))
        }
        "vault.export.release" => {
            let request: Release = serde_json::from_value(params).map_err(|_| RpcFailure::invalid("Invalid backup release request."))?;
            Ok(json!({ "released": runtime.local_exports.sessions.remove(&request.file_handle).is_some() }))
        }
        _ => Err(RpcFailure::invalid("Unsupported backup method.")),
    }
}

fn append_file(archive: &mut ZipWriter<File>, name: &str, path: &Path, total: &mut u64) -> Result<(), RpcFailure> {
    let mut file = File::open(path).map_err(|_| failure())?;
    let size = file.metadata().map_err(|_| failure())?.len();
    // Include both ZIP headers, UTF-8 name and a conservative extra-field bound.
    *total = total.checked_add(size).and_then(|v| v.checked_add(256 + 2 * name.len() as u64)).filter(|v| *v <= MAX_BYTES).ok_or_else(failure)?;
    archive.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).map_err(|_| failure())?;
    let copied = std::io::copy(&mut Read::by_ref(&mut file).take(size + 1), archive).map_err(|_| failure())?;
    if copied != size { return Err(failure()); }
    Ok(())
}

fn hash_file(file: &mut File) -> Result<String, RpcFailure> {
    file.rewind().map_err(|_| failure())?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 128 * 1024];
    loop {
        let count = file.read(&mut bytes).map_err(|_| failure())?;
        if count == 0 { break; }
        hash.update(&bytes[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_backup_import_rejects_paths_symlinks_corrupt_blobs_and_database_only_masquerades() {
        let root = tempfile::tempdir().unwrap();
        let imports = root.path().join("imports");
        fs::create_dir(&imports).unwrap();
        let id = "a".repeat(64);
        for (name, mode) in [
            ("../outside.mdbx".to_string(), 0o100600),
            ("/vault.mdbx".to_string(), 0o100600),
            ("vault.mdbx.blobs/aa/aa/../escape".to_string(), 0o100600),
            (format!("vault.mdbx.blobs/aa/aa/{id}"), 0o100600),
            ("vault.mdbx".to_string(), 0o120777),
            ("vault.mdbx".to_string(), 0o100600),
        ] {
            let source = root.path().join("bad.zip");
            let mut zip = ZipWriter::new(File::create(&source).unwrap());
            zip.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored).unix_permissions(mode)).unwrap();
            zip.write_all(b"not a database or matching ciphertext").unwrap();
            zip.finish().unwrap();
            assert!(restore_archive(&source, &imports, &Uuid::new_v4().to_string()).is_err());
            assert_eq!(fs::read_dir(&imports).unwrap().count(), 0);
            assert!(!root.path().join("outside.mdbx").exists());
        }
    }
}
