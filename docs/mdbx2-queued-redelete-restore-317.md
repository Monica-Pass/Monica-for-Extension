# Restore an acknowledged tombstone after a queued re-deletion

The manager's individual restore button now works immediately when a cached
MDBX tombstone is deleted again before source synchronization. Previously the
queued deletion selected an active-object cancellation path; the engine correctly
refused to reveal the deleted payload and restoration stopped.

The coordinator now checks paginated deleted-object summaries. An exact native
tombstone uses the original-object restoration protocol. The encrypted journal
records `supersededDeletion`, binding the complete queued request into the
operation scope. Staging removes that exact deletion and its matching prepared
receipt in the same encrypted save. The local tombstone remains until Native
restoration and local acknowledgement complete.

A save failure consumes nothing. An attempted/uncertain receipt, changed local
snapshot or queue, conflicting provider, pending move/removal or overlapping
restoration is refused. Recovery reuses the staged request. A subsequent deletion
gets a new queue entry and survives acknowledgement of the older restoration.
Completed replay returns current data without reviving a later deletion.
Batch restoration does not accept this single-item journal extension.

Single-item cancellation of a deletion against an active native object now
retains pending updates when rich local fields differ from the native baseline.
The same update retention applies after superseding a deletion against an
acknowledged tombstone. Native restoration itself never rebuilds payload JSON;
any previously unsynchronized local edit is written by subsequent ordinary sync.

Validation on 2026-10-05:

- 209 files / 2041 tests, both TypeScript configurations, production build and
  security audit passed. See `raw/single-redelete-{full-final,build-final,
  security-final}.log` under `.codex-tasks/android-interop-315/`.
- All 33 actual Native-process/encrypted-disk cases passed. Four new cases cover
  clean and dirty queued re-deletion, a later deletion during recovery, and dirty
  active-object cancellation. They verify failed staging, failed acknowledgement,
  actual Host/envelope restart, exact native payloads, original IDs, protected
  credential metadata, attachment hashes and ordinary synchronization. A delayed
  delete at the old tombstone head is rejected after restoration. Evidence:
  `.tmp/single-redelete-native-20261005-final/` and
  `raw/single-redelete-native-final.log`.
- Actual Edge `run-kD4n7P` passed individual restore button clicks immediately
  after queued re-deletion, without an intervening source sync. It also passed
  unsent group cancellation, synchronized group restore, stale confirmation,
  lost response and restart recovery. Every rich native payload remained exact;
  temporary Native registration was restored and no console errors occurred.
  Evidence: `raw/single-redelete-edge-final.log` and that run's `evidence.json`.
- That exact Edge database plus three encrypted Blobs passed current Android
  1.0.317 import, repository/viewmodel read and note edit, then independent Native
  return verification. Three rich members, current credential metadata, protected
  and unknown values, original identities and attachment hashes were preserved.
  Untouched JSON stayed exact; the edited member changed only notes, its Room
  projection ID and the plaintext-v1 marker. Evidence:
  `.tmp/android-single-redelete-317/` and `raw/single-redelete-android-*.log`.
  Source and installed app/test APK hashes matched the preceding current build.
  This is fixture MDBX+Blob transport and actual app data-path verification;
  complete user-facing backup and Android screen coverage remain open.
- The initial targeted run retained two test-fixture failures: a same-millisecond
  second delete did not guarantee a changed snapshot, and a receipt API name was
  incorrect. The fixture now changes actual content and calls the existing API.
  No data guards were relaxed.

The Host remains unchanged at SHA-256
`7776601229d69c9e9e035a0aba07d639029cd0b3a235a5615c9dd0de1d8f9968`.
This slice changes no UI layout or Android product source. Confirmed partially
acknowledged group deletion now has [a mixed recovery path](mdbx2-mixed-project-restore-317.md).
Unknown previous write outcomes, remote-only tombstones, deleted parents, historical
cohort reconciliation and complete MDBX+Blob backup remain separate open work.
