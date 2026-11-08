//! Only leased, disposable export copies live here. Imports and vaults are never scanned.
use fs2::FileExt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::Path;
use tempfile::TempDir;

const PREFIX: &str = "complete-backup-v1-";
const LEASE: &str = ".owner.lock";
const GATE: &str = ".complete-backup-v1.lock";

pub(crate) struct BackupScratch {
    // Close the lease before TempDir removes the directory on Windows.
    _lease: File,
    directory: TempDir,
}

impl BackupScratch {
    pub(crate) fn new(root: &Path) -> io::Result<Self> {
        // Serialize publication of the lease with scavengers in other Host processes.
        let _gate = gate(root)?;
        let directory = tempfile::Builder::new()
            .prefix(PREFIX)
            .rand_bytes(16)
            .tempdir_in(root)?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join(LEASE))?;
        lease.try_lock_exclusive()?;
        Ok(Self {
            _lease: lease,
            directory,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        self.directory.path()
    }
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        } // Any reparse point, including junctions.
    }
    metadata.file_type().is_symlink()
}

fn regular_file(path: &Path) -> io::Result<File> {
    match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_file() || is_link(&metadata) {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            // Opening an alias and closing it can retire another POSIX lease.
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 { return Err(io::ErrorKind::InvalidInput.into()); }
            }
            let file = OpenOptions::new().read(true).write(true).open(path)?;
            single_link(&file)?;
            Ok(file)
        }
        Err(error) => Err(error),
    }
}

fn single_link(file: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { info.assume_init() }.nNumberOfLinks != 1 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.nlink() != 1 { return Err(io::ErrorKind::InvalidInput.into()); }
    }
    Ok(())
}

/// Cross-process publication gate for this root. Also shared by the cloud
/// sync outbound scavenge so a starting host process never reclaims a
/// publication another process has written but not yet referenced.
pub(crate) fn gate(root: &Path) -> io::Result<File> {
    let file = regular_file(&root.join(GATE))?;
    file.lock_exclusive()?;
    Ok(file)
}

fn disposable_tree(path: &Path, remaining: &mut usize, depth: u8) -> io::Result<bool> {
    if *remaining == 0 || depth > 8 {
        return Ok(false);
    }
    *remaining -= 1;
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) {
        return Ok(false);
    }
    if metadata.is_file() {
        return Ok(true);
    }
    if !metadata.is_dir() {
        return Ok(false);
    }
    for child in fs::read_dir(path)? {
        if !disposable_tree(&child?.path(), remaining, depth + 1)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// An OS-held lock proves liveness, even across processes and PID reuse. Age alone
/// never authorizes deleting a still-active export. Old unleased layouts are untouched.
pub(crate) fn scavenge(root: &Path) -> io::Result<()> {
    scavenge_with(root, false)
}

/// Nearby roots contain only recognized protocol artifacts. Unknown layouts
/// remain untouched after process death rather than becoming deletion authority.
pub(crate) fn scavenge_nearby(root: &Path) -> io::Result<()> {
    scavenge_with(root, true)
}

fn nearby_tree(path: &Path, remaining: &mut usize, depth: usize) -> io::Result<bool> {
    if *remaining == 0 || depth > 3 { return Ok(false); }
    *remaining -= 1;
    let metadata = fs::symlink_metadata(path)?;
    if is_link(&metadata) { return Ok(false); }
    if depth > 0 {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return Ok(false); };
        let hex = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        let artifact = [LEASE, "changes.mdbxsync", "assets.monica", "vault.mdbx", "changes.mdbxsync.part", "assets.monica.part", "vault.mdbx.part"].contains(&name);
        let partial = name.len() == 134 && name.is_ascii() && name.ends_with(".part")
            && name.as_bytes()[64] == b'-' && hex(&name[..64]) && hex(&name[65..129]);
        let folder = ["resume", "received"].contains(&name)
            || name.strip_prefix(".delta-").is_some_and(|s| s.len() == 64 && hex(s))
            || name.strip_prefix(".delta-staging-").is_some_and(|s| s.len() == 22
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                && matches!(s.as_bytes()[21], b'A' | b'Q' | b'g' | b'w'));
        if metadata.is_file() && !(artifact || partial) || metadata.is_dir() && !folder { return Ok(false); }
    }
    if metadata.is_file() { return Ok(true); }
    if !metadata.is_dir() { return Ok(false); }
    for entry in fs::read_dir(path)? {
        if !nearby_tree(&entry?.path(), remaining, depth + 1)? { return Ok(false); }
    }
    Ok(true)
}

fn scavenge_with(root: &Path, nearby: bool) -> io::Result<()> {
    let _gate = gate(root)?;
    for (index, entry) in fs::read_dir(root)?.enumerate() {
        if nearby && index >= 4096 { return Err(io::ErrorKind::InvalidInput.into()); }
        let entry = entry?;
        let name = entry.file_name();
        let Some(suffix) = name.to_str().and_then(|name| name.strip_prefix(PREFIX)) else {
            continue;
        };
        if suffix.len() != 16 || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_dir() || is_link(&metadata) {
            continue;
        }
        let lease_path = path.join(LEASE);
        // A directory without our lease may belong to a user or older helper.
        let Ok(metadata) = fs::symlink_metadata(&lease_path) else {
            continue;
        };
        if !metadata.is_file() || is_link(&metadata) {
            continue;
        }
        let Ok(lease) = regular_file(&lease_path) else {
            continue;
        };
        if lease.try_lock_exclusive().is_err() {
            continue;
        }
        let disposable = if nearby { nearby_tree(&path, &mut 4096, 0) } else { disposable_tree(&path, &mut 100_000, 0) };
        if !disposable.unwrap_or(false) {
            continue;
        }
        // Keep the global gate while releasing the lease and deleting on Windows.
        // No new owner can acquire this uniquely named directory in that interval.
        drop(lease);
        let _ = fs::remove_dir_all(path); // An antivirus/file-indexer may temporarily hold a file; retry next start.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearby_scavenger_reclaims_only_recognized_unleased_protocol_layouts() {
        let root = tempfile::tempdir().unwrap();
        let active = BackupScratch::new(root.path()).unwrap();
        fs::write(active.path().join("changes.mdbxsync"), b"active encrypted").unwrap();
        let known = root.path().join("complete-backup-v1-1234567890abcdef");
        let unknown = root.path().join("complete-backup-v1-abcdef1234567890");
        for directory in [&known, &unknown] {
            fs::create_dir(directory).unwrap(); fs::write(directory.join(LEASE), []).unwrap();
        }
        fs::create_dir(known.join("resume")).unwrap();
        fs::write(known.join("resume").join(format!("{}-{}.part", "a".repeat(64), "b".repeat(64))), b"orphan ciphertext").unwrap();
        fs::write(unknown.join("unrecognized-layout"), b"retain").unwrap();
        scavenge_nearby(root.path()).unwrap();
        assert!(!known.exists()); assert!(unknown.exists()); assert!(active.path().exists());
    }

    #[test]
    fn owner_hard_link_alias_never_becomes_cleanup_authority() {
        let root = tempfile::tempdir().unwrap();
        let active = BackupScratch::new(root.path()).unwrap();
        let alias = root.path().join("complete-backup-v1-1234567890abcdef");
        fs::create_dir(&alias).unwrap();
        fs::hard_link(active.path().join(LEASE), alias.join(LEASE)).unwrap();
        fs::write(alias.join("changes.mdbxsync"), b"retain").unwrap();
        assert!(regular_file(&alias.join(LEASE)).is_err());
        scavenge_nearby(root.path()).unwrap();
        assert!(alias.exists()); assert!(active.path().exists());
    }

    #[test]
    fn scavenger_preserves_active_exports_and_all_persistent_or_unowned_paths() {
        let root = tempfile::tempdir().unwrap();
        let active = BackupScratch::new(root.path()).unwrap();
        fs::write(active.path().join("vault.mdbx"), b"encrypted snapshot").unwrap();
        for name in [
            "vaults",
            "imports",
            "backups",
            "complete-backup-old123",
            "complete-backup-v1-abcdefghijklmnop",
        ] {
            fs::create_dir(root.path().join(name)).unwrap();
            fs::write(root.path().join(name).join("keep"), name).unwrap();
        }
        scavenge(root.path()).unwrap();
        assert_eq!(
            fs::read(active.path().join("vault.mdbx")).unwrap(),
            b"encrypted snapshot"
        );
        for name in [
            "vaults",
            "imports",
            "backups",
            "complete-backup-old123",
            "complete-backup-v1-abcdefghijklmnop",
        ] {
            assert_eq!(
                fs::read_to_string(root.path().join(name).join("keep")).unwrap(),
                name
            );
        }
        let path = active.path().to_path_buf();
        drop(active);
        assert!(!path.exists());
    }

    #[test]
    fn scavenger_reclaims_unlocked_leased_exports_and_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let scratch = BackupScratch::new(root.path()).unwrap();
        fs::create_dir(scratch.path().join("vault.mdbx.blobs")).unwrap();
        fs::write(
            scratch.path().join("vault.mdbx.blobs/ciphertext"),
            b"synthetic ciphertext",
        )
        .unwrap();
        let BackupScratch {
            _lease: lease,
            directory,
        } = scratch;
        let abandoned = directory.keep();
        drop(lease);
        scavenge(root.path()).unwrap();
        assert!(!abandoned.exists());
        scavenge(root.path()).unwrap();
    }

    #[test]
    fn scavenger_preserves_linked_children() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("precious"), b"keep exact bytes").unwrap();
        let scratch = BackupScratch::new(root.path()).unwrap();
        let linked = scratch.path().join("linked");
        #[cfg(windows)]
        {
            // Directory junctions do not require Windows developer-mode symlink permission.
            let status = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&linked)
                .arg(outside.path())
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
        let BackupScratch {
            _lease: lease,
            directory,
        } = scratch;
        let abandoned = directory.keep();
        drop(lease);
        scavenge(root.path()).unwrap();
        assert!(abandoned.exists());
        assert_eq!(
            fs::read(outside.path().join("precious")).unwrap(),
            b"keep exact bytes"
        );
        #[cfg(windows)]
        fs::remove_dir(&linked).unwrap();
        #[cfg(unix)]
        fs::remove_file(&linked).unwrap();
        // Removing the link makes this owned directory eligible on the next start.
        scavenge(root.path()).unwrap();
        assert!(!abandoned.exists());
    }

    #[test]
    fn scavenger_never_follows_a_linked_workspace_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join(LEASE), b"").unwrap();
        fs::write(outside.path().join("precious"), b"unchanged").unwrap();
        let linked = root.path().join(format!("{PREFIX}abcdefghijklmnop"));
        #[cfg(windows)]
        {
            let result = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&linked)
                .arg(outside.path())
                .output()
                .unwrap();
            assert!(result.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
        scavenge(root.path()).unwrap();
        assert_eq!(
            fs::read(outside.path().join("precious")).unwrap(),
            b"unchanged"
        );
        assert!(linked.exists());
        #[cfg(windows)]
        fs::remove_dir(linked).unwrap();
        #[cfg(unix)]
        fs::remove_file(linked).unwrap();
    }
}
