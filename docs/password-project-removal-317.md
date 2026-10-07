# Password project member removal — Android 1.0.317

The removal transaction, attachment preparation and dedicated MDBX2 deletion
coordinator now have manager-only runtime commands and source-sync recovery.
Actual removal controls, other backend deletion and the remove/undo editor
remain unfinished; this document does not claim complete
password-project interoperability. The exact Native deletion intent and
restart verification are documented in
[`mdbx2-project-removal-recovery-317.md`](mdbx2-project-removal-recovery-317.md).
Manager commands, serialization and actual Edge restart evidence are documented
in [`password-project-removal-runtime-317.md`](password-project-removal-runtime-317.md).

Preparation cancellation is available through the manager runtime. It restores the saved
full draft before member promotion/renumbering, preserves acknowledged provider
references and independent later edits, and records a terminal cancellation so
old retries cannot delete. Conflicting later edits remain intact with an error.
Copies made during preparation are retained. Once a deletion request is saved,
cancellation must use confirmed remote recovery instead; it cannot discard the
request. The linked document records the 21 actual Native recovery cases.

## Android contract and current implementation

Android's `PasswordViewModel.saveProjectCredentials` saves surviving rows,
applies shared custom fields to the resulting first password, copies the old
owner's attachments, then deletes omitted originals. The browser transaction
requires explicit removed IDs plus a complete original snapshot instead of
interpreting an incomplete form as a deletion request.

- The planner preserves password identities and unknown JSON values, promotes
  the surviving primary group, and normalizes group/password order. It moves
  shared owner custom fields, content ordering, image references and compatible
  Passkey binding metadata. Conflicting reserved manifests fail without writes.
  Passwords/history remain on their original rows. Discarded new draft rows do
  not create tombstones.
- Local-only removal commits survivors and original tombstones in one encrypted
  write. External originals remain live in the `preparing` phase while survivor
  updates synchronize. The encrypted journal saves all involved snapshots,
  provider bindings and an operation hash. Repeated requests are idempotent.
- `inspectPasswordProjectRemoval` rejects changed membership/content/bindings,
  pending mutations, conflicts and missing external IDs before attachment work.
  Finalization repeats these checks under the write lock and requires exact
  observed timestamps/provider references. Acknowledged remote identities are
  retained in the deleting journal.
- Attachment preparation enumerates all pages, validates count/size/identity,
  copies each source file, and independently hashes source and target bytes.
  Existing same-name files are reused only after exact size/media/hash checks;
  differing same-name files are never overwritten. A fresh invocation can
  discover a committed upload after its response or worker state was lost.
  It then re-enumerates the source manifest, hashes both sides again and repeats
  project readiness inspection. An empty proof requires a successful empty
  listing. These proofs are provisional, not remote deletion authorization.
- Ordinary MDBX2, WebDAV and Bitwarden sync refuses a pending deleting journal,
  including after service restart. Preparing records also block an independent
  queued deletion or missing/tombstoned member. The background and Bitwarden
  durable coordinator supply journal state from their local snapshot; Bitwarden
  rejects before writing any durable mutation receipt. Existing completed
  records and unrelated provider accounts do not trigger this guard.

## Verification

Final regression passed **200 test files / 1904 tests**. Production build and
both TypeScript configurations passed. Targeted planner/service/attachment/durable-sync tests passed. The new attachment
suite covers all three provider labels with a protocol fake, paged files, empty
files, response loss, exact existing copies, name conflicts, concurrent source
additions, same-size byte replacement on either side, stale project inspection,
and malformed pagination/duplicates/oversized files.

A separate test uses the actual `MonicaWebDavProvider`, Android ZIP codec and
backup encryption through a simulated HTTP transport. It confirms that portable
ZIP assigns its own attachment IDs, recovers a committed upload with no second
PUT, independently decrypts both copies, and preserves both raw password
records and unrelated unknown ZIP bytes. This is not a live WebDAV service or
an Android application test.

Raw evidence is under `.codex-tasks/android-interop-315/raw/`:

- `project-removal-first-tests.log`: initial 48 tests.
- `project-removal-tests-2.log`: updated planner/service 50 tests.
- `project-removal-attachments-tests-2.log`: 57 targeted tests.
- `project-removal-zip-tests.log`: 14 attachment tests including actual codec.
- `project-removal-check-2.log`, `project-removal-check-3.log`: type checks.
- `project-removal-check-final.log`: final type checks after the durable-sync guard assertion.
- `project-removal-build-2.log`: successful production build and type checks.
- `project-removal-full.log`: initial full run, 1902 passed and two existing KDF
  tests exceeded their unchanged five-second deadline during concurrent build.
- `project-removal-timeout-recheck.log`: all 55 security-service tests passed
  alone, retaining their original deadlines.
- `project-removal-full-2.log`: final 200 files / 1904 tests passed with two workers.

The first attachment test run also caught an incorrectly placed test assertion;
the first build caught a fixture typed-array inference mismatch. Both were
fixed. Failure logs are retained; no assertion or timeout was weakened.

## Remaining acceptance gates

1. Add a provider transaction that freshly verifies source manifests and target
   copies in the same remote state used for deletion. Never enable ordinary sync
   deletion merely by passing a previously stored proof.
2. MDBX2 now has a vault revision guard checked inside the engine's write
   transaction, with actual engine and Native process stale-attachment,
   cross-connection and restart/response-loss tests. See
   `mdbx2-project-removal-revision-317.md`. The internal browser coordinator now
   saves the exact deletion intent in the encrypted journal and acknowledges
   its Native commit; six actual Native process recovery/failure cases passed.
   Runtime and editor/pending controls now have actual Edge acceptance; see
   [member-removal UI verification](password-project-removal-ui-317.md).
   Fresh Android return remains separately tracked.
3. WebDAV ZIP currently checks the latest filename/ETag then writes a new backup
   with `If-None-Match: *`. This is not atomic CAS on the directory's latest
   backup. Resolve the concurrent-new-backup window before claiming safe deletion.
4. Trace Bitwarden attachment/revision and deletion behavior with the actual
   service, then implement guarded deletion/recovery without bypassing durable
   mutation receipts.
5. Background preparation, guarded deletion acknowledgements and restart
   recovery are wired and tested for MDBX2. WebDAV and Bitwarden coordination
   remains pending.
6. Enable the existing local Canvas `credentialremove317` design as remove/undo
   UI only after supported destinations have safe semantics. Then verify actual
   Edge/Native/services and fresh Android return, including shared content,
   attachments, one-row transitions and failure paths.

Android product sources were not changed. This slice starts no AVD or Docker
service, publishes nothing and delivers no APK.
