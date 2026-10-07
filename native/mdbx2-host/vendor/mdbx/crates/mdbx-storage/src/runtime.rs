//! Storage-owned vault runtime boundary.
//!
//! The first MDBX3 runtime backend deliberately keeps one serialized SQLite
//! connection.  The public `read`/`write` and reader-generation contract lets
//! a future backend add true SQLite read snapshots without moving connection,
//! session, or keyring ownership back into the FFI facade.

use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

const INITIAL_READER_GENERATION: u64 = 1;

struct RuntimeState {
    connection: Mutex<VaultConnection>,
    reader_generation: AtomicU64,
}

/// Storage-owned lifecycle and concurrency boundary for one open vault.
#[derive(Clone)]
pub struct VaultRuntime {
    state: Arc<RuntimeState>,
}

/// Opaque reader generation captured by a read-side caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReaderGeneration {
    value: u64,
}

/// A generation-bound reader lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ReaderLease {
    generation: ReaderGeneration,
}

/// A lock failure at the runtime boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeLockPoisoned;

/// Compatibility guard used by existing FFI facade code while ownership moves
/// into `VaultRuntime`.
pub struct VaultRuntimeGuard<'a> {
    guard: MutexGuard<'a, VaultConnection>,
    state: &'a RuntimeState,
    advance_generation: bool,
    initial_total_changes: i64,
}

impl VaultRuntime {
    /// Take ownership of an already initialized/open connection.
    pub fn from_connection(connection: VaultConnection) -> Self {
        Self {
            state: Arc::new(RuntimeState {
                connection: Mutex::new(connection),
                reader_generation: AtomicU64::new(INITIAL_READER_GENERATION),
            }),
        }
    }

    /// Legacy serialized access for compatibility facade code. Generation is
    /// advanced only if the operation mutates SQLite or takes mutable access
    /// to connection-owned authenticated state.
    pub fn lock(&self) -> Result<VaultRuntimeGuard<'_>, RuntimeLockPoisoned> {
        self.access()
    }

    /// Read-side access. The compatibility backend serializes this access with
    /// writes; the generation contract is independent of that implementation.
    pub fn read(&self) -> Result<VaultRuntimeGuard<'_>, RuntimeLockPoisoned> {
        self.access()
    }

    fn access(&self) -> Result<VaultRuntimeGuard<'_>, RuntimeLockPoisoned> {
        let guard = self
            .state
            .connection
            .lock()
            .map_err(|_| RuntimeLockPoisoned)?;
        let initial_total_changes = sqlite_total_changes(&guard);
        Ok(VaultRuntimeGuard {
            guard,
            state: &self.state,
            advance_generation: false,
            initial_total_changes,
        })
    }

    /// Writer-side access. A guard advances the reader generation when it
    /// mutates SQLite or connection-owned authenticated state.
    pub fn write(&self) -> Result<VaultRuntimeGuard<'_>, RuntimeLockPoisoned> {
        self.access()
    }

    /// Run one read operation without exposing the connection lock to callers.
    pub fn with_read<T>(
        &self,
        f: impl FnOnce(&VaultConnection) -> StorageResult<T>,
    ) -> StorageResult<T> {
        let guard = self.read().map_err(|_| StorageError::RuntimeLockPoisoned)?;
        f(&guard)
    }

    /// Run one serialized write operation without exposing the connection lock.
    pub fn with_write<T>(
        &self,
        f: impl FnOnce(&mut VaultConnection) -> StorageResult<T>,
    ) -> StorageResult<T> {
        let mut guard = self
            .write()
            .map_err(|_| StorageError::RuntimeLockPoisoned)?;
        f(&mut guard)
    }

    /// Return the current authenticated-state reader generation.
    pub fn reader_generation(&self) -> ReaderGeneration {
        ReaderGeneration {
            value: self.state.reader_generation.load(Ordering::Acquire),
        }
    }

    /// Capture a lease that can be checked before using a cached reader.
    pub fn acquire_reader(&self) -> ReaderLease {
        ReaderLease {
            generation: self.reader_generation(),
        }
    }

    /// Validate a previously captured reader lease.
    pub fn validate_reader(&self, lease: ReaderLease) -> StorageResult<()> {
        let actual = self.reader_generation();
        if actual != lease.generation {
            return Err(StorageError::StaleReaderGeneration {
                expected: lease.generation.value,
                actual: actual.value,
            });
        }
        Ok(())
    }
}

impl ReaderGeneration {
    pub fn value(self) -> u64 {
        self.value
    }
}

impl ReaderLease {
    pub fn generation(self) -> ReaderGeneration {
        self.generation
    }
}

impl Deref for VaultRuntimeGuard<'_> {
    type Target = VaultConnection;

    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl DerefMut for VaultRuntimeGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.advance_generation = true;
        &mut self.guard
    }
}

impl Drop for VaultRuntimeGuard<'_> {
    fn drop(&mut self) {
        if self.advance_generation
            || sqlite_total_changes(&self.guard) != self.initial_total_changes
        {
            self.state.reader_generation.fetch_add(1, Ordering::AcqRel);
        }
    }
}

fn sqlite_total_changes(connection: &VaultConnection) -> i64 {
    connection
        .inner()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::VaultConnection;
    use mdbx_core::model::{UnlockMethodType, VaultSession};
    use mdbx_core::tiga::SessionAssurance;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Barrier;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn runtime_generation_is_stable_for_reads_and_advances_after_writes() {
        let runtime = VaultRuntime::from_connection(VaultConnection::open_in_memory().unwrap());
        let before = runtime.reader_generation();
        runtime
            .with_read(|connection| {
                assert!(connection.inner().is_autocommit());
                Ok(())
            })
            .unwrap();
        assert_eq!(runtime.reader_generation(), before);

        runtime
            .with_write(|connection| {
                connection
                    .inner()
                    .execute_batch("CREATE TABLE runtime_probe(value INTEGER);")?;
                Ok(())
            })
            .unwrap();
        assert!(runtime.reader_generation().value() > before.value());
    }

    #[test]
    fn stale_reader_lease_is_rejected_after_a_write() {
        let runtime = VaultRuntime::from_connection(VaultConnection::open_in_memory().unwrap());
        let lease = runtime.acquire_reader();
        runtime
            .with_write(|connection| {
                connection
                    .inner()
                    .execute_batch("CREATE TABLE runtime_probe(value INTEGER);")?;
                Ok(())
            })
            .unwrap();

        let error = runtime.validate_reader(lease).unwrap_err();
        assert!(matches!(error, StorageError::StaleReaderGeneration { .. }));
    }

    #[test]
    fn no_op_writer_and_legacy_read_keep_generation_stable() {
        let runtime = VaultRuntime::from_connection(VaultConnection::open_in_memory().unwrap());
        let before = runtime.reader_generation();

        drop(runtime.write().unwrap());
        assert_eq!(runtime.reader_generation(), before);

        let guard = runtime.lock().unwrap();
        assert!(guard.inner().is_autocommit());
        drop(guard);
        assert_eq!(runtime.reader_generation(), before);
    }

    #[test]
    fn clearing_authenticated_state_invalidates_reader_lease_without_sql_changes() {
        let mut connection = VaultConnection::open_in_memory().unwrap();
        connection.attach_session(VaultSession {
            session_id: "runtime-session".to_string(),
            unlock_method: UnlockMethodType::Password,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            assurance: SessionAssurance::from_unlock_method(UnlockMethodType::Password, 1),
        });
        let runtime = VaultRuntime::from_connection(connection);
        let lease = runtime.acquire_reader();

        runtime
            .with_write(|connection| {
                connection.clear_session();
                Ok(())
            })
            .unwrap();

        assert!(matches!(
            runtime.validate_reader(lease),
            Err(StorageError::StaleReaderGeneration { .. })
        ));
    }

    #[test]
    fn concurrent_write_operations_never_overlap() {
        let runtime = VaultRuntime::from_connection(VaultConnection::open_in_memory().unwrap());
        let start = Arc::new(Barrier::new(3));
        let active_writers = Arc::new(AtomicUsize::new(0));
        let peak_writers = Arc::new(AtomicUsize::new(0));

        let threads = (0..2)
            .map(|_| {
                let runtime = runtime.clone();
                let start = Arc::clone(&start);
                let active_writers = Arc::clone(&active_writers);
                let peak_writers = Arc::clone(&peak_writers);
                thread::spawn(move || {
                    start.wait();
                    runtime
                        .with_write(|_| {
                            let current = active_writers.fetch_add(1, Ordering::AcqRel) + 1;
                            peak_writers.fetch_max(current, Ordering::AcqRel);
                            thread::sleep(Duration::from_millis(25));
                            active_writers.fetch_sub(1, Ordering::AcqRel);
                            Ok(())
                        })
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();

        start.wait();
        for thread in threads {
            thread.join().unwrap();
        }

        assert_eq!(peak_writers.load(Ordering::Acquire), 1);
        assert_eq!(runtime.reader_generation().value(), 3);
    }
}
