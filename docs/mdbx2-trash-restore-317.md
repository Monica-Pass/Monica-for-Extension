# MDBX2 recycle-bin restoration — Android 1.0.317 target

The existing manager restore button now restores the original MDBX Object through
Native Messaging before it removes the encrypted local tombstone. It preserves
the Object ID, exact payload JSON and original attachments. This is one completed
lifecycle slice of the ongoing Android/browser parity task.

The subsequent [atomic group restoration](mdbx2-group-restore-317.md) adds
one-transaction Native restoration, an encrypted group receipt, manager UI and
current Android acceptance. The verification below records the earlier
single-item slice. [Queued re-deletion recovery](mdbx2-queued-redelete-restore-317.md)
also supports immediate individual restoration without an intervening sync.

## Changes

- `object.restore` requires an authenticated vault identity, a vault write
  revision, a canonical operation scope and the expected deleted Object head,
  collection and type. It executes `RestoreEntry`; it never rebuilds a password
  payload from the browser projection. The parent collection must still be
  active. Generic upsert still cannot resurrect a deleted native Object.
- The extension-only FFI write-revision overlay now chooses the engine's
  semantic commit kind (`restore`, `move`, `change`, or `multi`). The previous
  hardcoded `change` kind rejected restore commands. Android product sources and
  the database schema are unchanged; the existing second overlay was updated.
- An encrypted restore journal is saved before a native restore. Native receipt
  recovery and exact replay precede any reread of an already restored source.
  Lost native responses, Host restart and failed local acknowledgement retain
  the same request. A stale uncommitted vault revision requires a fresh deleted
  Object check and a durably saved replacement request.
- Deleted Object preflight uses paginated tombstone summaries. The engine does
  not disclose deleted payloads through ordinary `object.reveal`.
- Ordinary MDBX sync now retains local encrypted tombstones after successful
  deletion, including successful deletion recovered after response loss. It
  advances their provider revision to the confirmed commit. Previously this
  path dropped the local record, making the restore button disappear.
- Unsent deletion can be cancelled after verifying the native Object remains
  active at the expected head. This clears only that item's queued deletion.
  A failed local write keeps the original queue. A locally created item that has
  never acquired a native identity is queued for creation again when restored.
  Unsynchronized rich-field edits retain their update queue. An exact already
  deleted native object instead enters durable restoration, atomically replacing
  the reviewed queued deletion; newer deletions during recovery remain queued.
- Manager restore and ordinary sync serialize per MDBX provider. Normal sync
  resumes saved prepared restores before taking its snapshot; stale sync
  acknowledgement is refused while a prepared restore exists. Changed local
  content, replacement providers and pending project-removal journals remain
  protected. Errors appear through the existing manager notice.

## Verification

- 201 TypeScript files / 1929 tests passed:
  `.codex-tasks/android-interop-315/raw/native-restore-full-final-2.log`.
- Production build and both TypeScript configurations passed:
  `raw/native-restore-build-final-2.log`.
- All 61 Host tests, Clippy with warnings denied, and engine provenance
  verification passed. Updated overlay reconstruction matched the vendored
  source exactly in
  `.tmp/restore-overlay-proof-cae50487-8a55-4802-9854-400391a68e6c`.
- The actual Native process / encrypted disk-envelope suite passed 11 cases:
  `raw/native-restore-integration-final-2.log` and
  `.tmp/project-removal-restore-native-20261005-final-2/*/evidence.json`.
  This includes the prior six removal cases, original-content/attachment restore
  across response loss and multiple restarts, ordinary three-row group deletion
  with and without response loss, unsent deletion cancellation, and durable
  replacement of a stale restore revision. Original/native/local identities,
  exact JSON, attachment hashes and subsequent sync are checked separately.
- Actual Edge 154.0.4258.53 run `run-hr4cVh` passed three-row project deletion,
  native tombstone readback, all three existing restore buttons, exact original
  projected fields/native payloads, subsequent sync and browser restart.
  Both 320px screenshots were inspected. Temporary Native Messaging registry
  state was restored and browser console errors were empty. Final expanded run
  `run-JoV8XH` passed the same checks on the final build and also verified that
  attachment-bearing vaults are refused by database-only export. Its readback
  is saved as `edge-restored-project-expected.json`; no return MDBX was exported.

Native Host executable SHA-256:
`58848c72c5b0db09e6b03bda5043a419c4ba05d5c462080420d76b112203b826`.
Updated overlay SHA-256:
`8024c7825cb2bb903ff7ce93cf3ee827ebc0b5d39dd4178af6c87ef7231a270e`.
Normalized overlaid FFI SHA-256:
`3ebd59cf298a72bd6423a621b4f944c1f9ef55057d9b8bffe321920ccf9e3153`.

## Remaining acceptance

The historical synthetic Android fixture `android-app-parity-20261001` now also
has a fresh Android return proof. The closed Native working copy from actual Edge
`run-JoV8XH` was paired with its three original encrypted Blob files and independently
opened through the Host. Android `1.0.317-26100512-36` imported it into an isolated
test database, rebuilt its Room projection, checked all three password members,
app/contact/address/payment fields and custom-field protection flags, read the
card and note attachments, edited one member's notes through `PasswordViewModel`,
reopened and exported it. The independent extension return passed in
`.tmp/android-restored-project-317/restored-project-return-evidence.json`.

All native identities and untouched raw payloads remained exact. The edited
payload changed only the requested notes, its Room projection ID and Android's
new `monica_password_encoding: "plaintext-v1"` field. The card image (68 bytes,
SHA-256 `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`)
and note file (48 bytes, SHA-256
`67b83d22c8cffd6f9651ad3ef01a01a9ec1a93d0ad0e86b3d993d1d8831310de`)
match before and after Android editing. Build, application, test package, source
and device provenance are retained alongside the return evidence.

This was a complete database plus separate encrypted Blob fixture transfer.
The user-facing database-only export still correctly refuses attachment-bearing
vaults; a complete UI export workflow remains open. Keep this guard until that
workflow exists.

Individual project-member removal/undo and its retry UI are now available;
see [the member-removal UI record](password-project-removal-ui-317.md). The
coordinator preserves newer local edits after a committed member removal and
settles pending restorations while retaining newer delete requests. Preparation
cancellation is also durable; see [recovery evidence](mdbx2-project-removal-recovery-317.md).
Whole-project atomic restore now has a [manager confirmation and pending UI](password-project-restore-ui-317.md),
with actual Edge/current Android return. Remote tombstones without a cached local
payload and deleted parent collections still need further work. Unsynchronized
whole-project deletion now supports [atomic cancellation](password-project-unsent-delete-317.md),
including actual Edge and current Android return evidence. Confirmed mixed
deletions now have [Native and Edge acceptance](mdbx2-mixed-project-restore-317.md);
their four-member Android return remains separate. This does not complete
the full backend, field or lifecycle matrix.

Earlier failures are retained in raw logs: deleted-payload disclosure, missing
translation catalogs, the dropped ordinary-sync tombstones, incorrect test
fixture/compact navigation assumptions, a synthetic note without its required
logical ID, and the attempted database-only export of an attachment-bearing
fixture. Final checks preserve the data guards and do not count that export as a
successful Android transfer.
