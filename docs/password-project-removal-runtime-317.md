# Password project removal runtime — Android 1.0.317

The manager can now start, inspect, resume and cancel supported member-removal
operations through typed runtime commands. [Member-removal editor and pending
controls](password-project-removal-ui-317.md) are now implemented and Edge-tested. Current support is a local project or one MDBX2 source;
Bitwarden/WebDAV operations are rejected before staging any changes.

## Runtime behavior

- `VAULT_PASSWORD_PROJECT_REMOVE` requires the full draft, complete revision
  snapshot, explicit removed IDs, operation ID and `confirmed: true`.
- `VAULT_PASSWORD_PROJECT_REMOVALS` returns pending-operation summaries, including
  linked unfinished restorations. Summaries omit passwords, raw snapshots and
  saved provider credentials.
  An optional `operationId` also returns a matching completed/cancelled receipt
  for resolving a lost response; omission keeps the pending-only behavior.
- `VAULT_PASSWORD_PROJECT_REMOVAL_RESUME` reuses the saved operation.
- `VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL` only cancels preparation before a
  native deletion request exists. It can compete at the local mutation lock
  while attachment copying is in progress. A cancellation observed after a
  preflight error terminates the old coordinator without issuing deletion.

Every command requires the manager page. The popup cannot invoke any of them.
Unsupported sources are checked against both incoming references and actual
stored rows, so omitting references cannot bypass the source gate. Source
replacement while a request is queued is checked before staging.

`ProviderOperationQueue` serializes sync, native restoration and member-removal
execution for a source. A failed operation rejects its own caller while leaving
the queue usable for the next attempt. Cancellation deliberately uses the vault
lock directly, because waiting behind the entire operation would prevent a
preparation-stage cancellation.

Source sync recovers saved pending removals and restorations before taking its
ordinary item snapshot. This is used by manual sync and existing automatic
startup/unlock sync; automatic-sync preferences, locked sources and paused
sources retain their existing gates. Manual sync waits for an older in-flight
sync and then takes a new snapshot, so newly saved passwords are included.

## Recovery history

Completed deletion records referenced by prepared native restorations are
retained independently of the normal recent-history window. Pending records
and dependencies are never dropped to make room; capacity exhaustion rejects
new work. Once a dependent restore completes, its old deletion can age out.
Starting a new overlapping removal while restoration is pending is rejected
before any local changes, avoiding mutually blocked workflows.

## Evidence

- Final full regression: **203 files / 1970 tests**, `raw/removal-runtime-full.log`.
- Production build and both TypeScript configurations: `raw/removal-runtime-build-3.log`.
- Existing full Native/disk-envelope matrix: **21 cases**,
  `raw/removal-runtime-native-final.log`, `.tmp/removal-runtime-native-20261005-final`.
- Real Edge **154.0.4258.53**: `.tmp/interop-315-edge/run-KQJzgS/evidence.json`,
  `raw/removal-runtime-edge-final.log`.

The Edge run creates three synthetic three-password projects through manager
messages. One completes removal; one fails preparation against a locked native
source and is cancelled; one remains prepared across a real browser restart,
then finishes through source-sync recovery. It checks manager-only access,
missing-confirmation rejection, terminal cancellation retries, exact local
membership, native tombstones/identities, owner promotion, password/contact/
notes/custom fields, protection flags, metadata strings containing
`9007199254740993`, and shared attachment hashes. The Native Messaging registry
is restored and browser console errors are empty. Relevant source file hashes
are recorded, including untracked implementation files, and matched after the run.

Earlier failures remain recorded: an overly broad icon checker interpreted a
quoted TypeScript member name as a symbol (the dependency interface now uses
method signatures; no font check was weakened), manual sync returning a stale
in-flight snapshot, and a harness assertion expecting an array when the manager
sync response exposes a conflict count. The final run passes the corrected
checks, including all original local members when checking removal results.

These historical results cover the manager API and Native layer. The later
[UI acceptance](password-project-removal-ui-317.md) adds actual controls and
failure handling. The [exact current Android return](password-project-removal-android-return-317.md)
is now separately verified for all three UI fixtures.
