# MDBX2 project removal: transactional revision guard

The Native Host now supports guarding a deletion batch against the database
state used to verify retained passwords and attachment copies. This closes the
attachment-only mutation gap in the deletion primitive. The browser removal
coordinator, encrypted deletion-intent recovery and remove/undo UI still need
to call it; ordinary sync remains blocked for pending removal tombstones.

## Contract

`vault.writeRevision` returns an authenticated vault ID and a SHA-256 digest of
all branch IDs, names and head commits in stable order. Attachment writes are
commits even when their owning password's Object head is unchanged. Readers
capture this revision before validating records/manifests/bytes and verify it
again afterwards.

`object.batch` accepts an optional `writeRevision` for deletion-only batches.
The engine checks the expected vault/revision inside the same `BEGIN IMMEDIATE`
transaction as the complete batch. A change from another database connection
therefore invalidates the whole deletion. The guard is included in both the
Host's semantic receipt and the engine's authenticated operation intent.
An identical already-committed request returns the original commit after
restart; changing the guard under the same operation identity is rejected.

The TypeScript client exposes `readWriteRevision` and an optional fifth
`mutateObjects` argument. It validates the digest/UUID and checks the explicit
`supportsVaultWriteRevision` capability. Older Hosts receive no unsupported
mutation. Existing calls without a guard retain their previous contract.

The revision covers committed database changes. It is not an attachment proof
by itself: callers must still check exact project membership, provider/native
identity, retained and removed content, source manifest and target bytes inside
the revision interval. Any sync/import that changes the working copy between
verification and deletion causes the guarded transaction to fail. Subsequent
cloud conflict behavior still requires the original full interoperability
matrix; this primitive does not establish it.

## Engine provenance

Android product sources are unchanged. The vendored extension runtime has a
second explicitly recorded overlay, `write-revision-precondition`, in
`native/mdbx2-host/ENGINE-PROVENANCE.json`. It changes only FFI
`crates/mdbx-ffi/src/write_facade.rs`; there is no storage schema change.
`runtime-patches/extension-write-revision.patch` contains the reproducible diff.
The existing Android base hashes and earlier entry/attachment move overlay
remain intact. `scripts/verify-mdbx2-host.mjs` verifies all hashes and the new
Host capability.

## Evidence

- Two actual engine tests cover same-size attachment replacement with unchanged
  password Object content/revision, stale deletion rejection, a second database
  connection's attachment write, whole-batch rollback, committed replay after
  HostRuntime restart, and changed guard/vault identity rejection. They also
  exercise the core's own authenticated receipt without relying on Host state.
- The Native client suite passes 32 tests, including guard forwarding, malformed
  guard rejection and old-Host refusal.
- Actual OS process test:
  `tests/interop/android317-project-removal-revision.interop.ts`.
  Final evidence: `.tmp/project-removal-revision-native-20261005-final/evidence.json`.
  An isolated Host working copy uses an existing synthetic Android archive only
  as bootstrap, then creates three new synthetic records and two identical
  attachment copies. It rejects stale deletion after target byte replacement,
  commits two deletions together after fresh validation, discards the success
  response, restarts the Native process, resolves/replays the original commit,
  and verifies the retained record's exact payload/revision and attachment hash.
  This is not a fresh Android application run or Edge UI acceptance.
- Tested Host executable SHA-256:
  `08f7715fc62636998b26014b35b7af4180f81ecfa31f7f0f79391023277e97fb`.
- All 60 Host tests passed in `raw/project-removal-native-full.log`. Additional
  final direct-core replay assertions run in `project-removal-native-revision-final.log`.
- Full browser regression passes 200 files / 1905 tests; production build, both
  TypeScript configurations and `cargo clippy --all-targets -- -D warnings` pass.
  The overlay reproduces the final source exactly from its recorded baseline,
  and all 180 vendored source hashes pass the provenance verifier.
- The first actual process attempt reached the upload-session limit because
  its new harness retained finished sessions. The harness now releases each
  session with `abortAttachmentUpload` after completion. Both attempt logs and
  evidence are retained; no production limit was relaxed.

Reproduce against the preserved synthetic bootstrap after building the Host:

```powershell
$env:MONICA_317_REMOVAL_NATIVE_INPUT = (Resolve-Path .tmp/android-app-parity-20261001/android.mdbx).Path
$env:MONICA_317_REMOVAL_NATIVE_OUTPUT = Join-Path (Get-Location) '.tmp/project-removal-revision-rerun'
npx vitest run --config vitest.android-interop.config.ts tests/interop/android317-project-removal-revision.interop.ts
```

Next, persist the exact native deletion intent and revision in the encrypted
removal journal before tombstones are finalized. On restart, resolve the saved
Native operation before attempting source reads; a committed delete must be
acknowledged locally without being repeated under a new operation identity.
If nothing committed and the revision is stale, revalidate the original source
and destination, then durably replace the uncommitted intent. Complete the
actual Native coordinator failure/restart tests before exposing UI removal.
