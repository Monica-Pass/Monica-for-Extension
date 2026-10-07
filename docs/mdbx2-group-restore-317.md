# Atomic password-project restoration — Android 1.0.317 target

The extension now has a Native batch restoration API and an encrypted local
coordinator for cached passwords deleted together. The batch restores original
Object IDs and payloads in one engine transaction. The manager now offers a
whole-project action in the recycle bin, a confirmation listing credential
groups and counts, and a pending operation panel that survives browser restart.
Remote-only trash and deleted-folder restoration remain open parts of the
Android/browser counterpart goal.

## Contract

`object.restoreBatch` accepts 1–50 original Object IDs, each expected deleted head,
collection and type, one authenticated vault write revision, and a SHA-256
operation scope. `supportsObjectBatchRestore` is a separate capability; an older
Host is rejected before any mutation. No fallback sends sequential single-item
requests. Duplicate Objects, omitted preconditions and extra payload fields are
rejected. The result must contain every requested member in order with one
commit ID; the client rejects partial or mismatched results.

The Host reuses the existing stable restore command plan and the engine's guarded
transaction. It performs `RestoreEntry` without rewriting JSON or attachments.
The revision check runs inside the write transaction. Replaying a committed
request resolves its original commit before inspecting current tombstones, even
if a newer operation subsequently deleted a member. A missing containing
collection is rejected without restoring any member or implicitly reviving a
parent. No database schema, Android product source or vendor overlay changed.

## Local recovery

`Mdbx2RestoreBatchCoordinator.restoreProject(anchorItemId, request)` selects cached login
members with the same database-scoped project and deletion timestamp. This
keeps earlier removed members out of a later whole-project deletion. Only one
MDBX source is supported, with complete acknowledged tombstones and no pending
ordinary deletions. The group is bounded at 50 members. Before staging, a bounded
scan of all active collections rejects active native members of the same
project and verifies that every original parent still exists. An intervening
write invalidates the whole scan through the vault revision guard.

The encrypted `mdbx2RestoreBatches` journal holds complete original snapshots,
provider binding, native intents and the group receipt. Scope hashing binds the
complete member snapshots. Stage and replacement validation preserve member
identities and permit only a freshly verified vault revision. Local acknowledgement
updates all members and the terminal receipt in one encrypted save. A failed
save leaves every cached tombstone and the prepared request intact.

Recovery resolves the saved Native operation before any source reread. An
uncommitted stale request rechecks every deleted head and active project
membership before saving a replacement scope. Changed providers, members,
conflicts and overlapping single or group restores block writes while preserving
the journal. A newer explicit local deletion stays deleted and queued after the
original restoration is acknowledged; ordinary sync then applies that deletion.
Ordinary sync cannot dispatch or adopt a snapshot while a group restore is
pending, and source sync resumes saved batches first.

The manager confirms an immutable request containing the operation ID, source,
deletion timestamp and every member's local revision. A reused ID with changed
content is refused. Retries retain the original request, including after a lost
runtime response. Only a matching completed journal receipt settles that loss.
The background source queue identifies a definitely unstaged operation only
after its attempt finishes and a journal read proves it absent. Unknown results
keep the pending operation available. Start/list/resume commands are restricted
to manager pages; initial restoration also requires explicit confirmation.

See [the UI and Android acceptance record](password-project-restore-ui-317.md)
for the local Canvas source, real Edge failure/restart checks and current Android
return. The existing individual restore controls remain available.

## Verification

The foundation passed 206 files / 2006 extension tests, production build and both
TypeScript configurations passed. All 64 Host tests, Clippy with warnings denied
and vendor provenance verification passed. Logs are under
`.codex-tasks/android-interop-315/raw/group-restore-*`.

All 26 actual Native/disk-envelope cases passed in
`.tmp/group-restore-native-20261005-final/*/evidence.json`. Each records Host SHA-256
`7776601229d69c9e9e035a0aba07d639029cd0b3a235a5615c9dd0de1d8f9968`.
The 16 implementation/test source hashes are saved in
`raw/group-restore-source-hashes.json`.

Existing single-item restore UI regression also passed in actual Edge
154.0.4258.53, `run-UMcnht`: raw Native fields, 320px trash/detail, ordinary sync,
lock, popup/side panel and browser restart. Temporary Native registry state was
restored and no console errors were recorded. This does not count as acceptance
of the pending group restore UI or a new Android return.

Native tests cover raw large-number JSON and attachment bytes, one-commit
three-member restore, wrong/missing/duplicate targets, transaction rollback on
the second command, another connection advancing the revision, deleted parent
rejection, receipt loss/restart and replay after a newer deletion.

The actual process suite uses synthetic data and encrypted disk envelopes. It
checks failed staging with zero native writes, connection loss after real
commit, failed local acknowledgement, restart without source rereads, later
local deletion, durable stale-revision replacement, and a remote member restored
or added by another client. All existing deletion/restoration cases are included
in the final regression. The later manager implementation passed 208 files /
2018 tests, build, both TypeScript configurations, 26 updated actual Native
cases and actual Edge/current Android return, documented separately.

```powershell
$env:MONICA_317_REMOVAL_NATIVE_INPUT = (Resolve-Path .tmp/android-app-parity-20261001/android.mdbx).Path
$env:MONICA_317_REMOVAL_NATIVE_OUTPUT = Join-Path (Get-Location) '.tmp/group-restore-native-rerun'
npx vitest run --config vitest.mdbx2-lifecycle.config.ts
```

The first process run exposed service-lock reentry in the new coordinator.
Its transaction callback now uses the account snapshot already validated under
the lock and only checks the Native binding. The failed run and synthetic
fixtures remain available. A later new-member test accidentally reused an
original embedded logical ID; its fixture now creates a distinct native Object
and explicitly asserts that distinction before testing the recovery guard.

## Remaining work

- Unacknowledged deletion recovery when native heads or previous write outcomes
  are still unknown. [Confirmed mixed cohorts](mdbx2-mixed-project-restore-317.md)
  now restore the native deleted subset and acknowledge all cached members
  together. Entirely unsent deletions support
  [atomic local cancellation](password-project-unsent-delete-317.md).
  Individual queued re-deletions now support
  [immediate durable restoration](mdbx2-queued-redelete-restore-317.md).
- Restore remote-only deleted Objects without bypassing the engine's deleted
  payload disclosure policy; include encrypted attachment transport.
- Restore missing parent collections and their hierarchy with explicit scope
  and atomicity; currently the operation refuses that case.
- Reconcile a historical removed cohort with a currently active project. The
  current group path refuses active members instead of overwriting metadata.
- Complete user-facing MDBX plus Blob backup, other backend lifecycle gaps and
  the full field/type/backend/visual acceptance matrix.
