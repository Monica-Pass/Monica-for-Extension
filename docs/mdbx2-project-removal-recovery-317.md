# MDBX2 password project deletion recovery — Android 1.0.317

The extension now has an internal coordinator that synchronizes survivors,
copies shared attachments, persists an exact guarded deletion request, and
recovers its Native commit after interruption. Manager-only runtime commands
and source-sync recovery are connected. The [remove/undo editor and pending
panel](password-project-removal-ui-317.md) now have actual Edge acceptance.
Full Android counterpart acceptance remains incomplete.

Follow-up: the existing recycle-bin restore action now uses an explicit original
Object restoration flow. Ordinary sync also retains acknowledged local tombstones.
See [the restore verification and remaining boundaries](mdbx2-trash-restore-317.md).
Member-removal controls and runtime actions currently support local projects
and one MDBX2 source.

## Durable flow

1. `stagePasswordProjectRemoval` leaves external originals live and queues
   survivor writes. More than 50 native deletions fail before saving any change;
   a project may have 100 rows, but the engine's atomic mutation limit is 50.
2. `Mdbx2PasswordProjectRemovalCoordinator` uses the actual `Mdbx2Provider` sync
   path for survivor acknowledgement and the actual Native attachment client
   for bounded copying, source ownership checks and independent byte hashing.
   A lost attachment upload response can reuse an exact existing copy. Upload
   sessions are released even if the response is lost. Failed verification
   preserves copies instead of deleting a possibly concurrent attachment edit.
3. The coordinator verifies all login members across every collection, known
   Object IDs/folders/heads, their decoded content, the complete old owner's
   attachment manifest, and both source and target hashes. It brackets these
   checks with the vault write revision. Unknown/unreadable login projections,
   malformed pagination or exceeded bounds fail closed.
4. Finalization checks the complete local snapshot again under the vault lock.
   The encrypted envelope saves provider/native identity, write revision,
   canonical operation scope, immutable delete mutations, original rows,
   local tombstone time and exact queued delete identities in one write.
   The request contains no upserts. Native deletion cannot start before this
   encrypted write succeeds.
5. The final local check and remote deletion run under the service mutation
   lock. The native engine checks the saved vault revision inside its write
   transaction. Any intervening branch change rejects the entire delete batch.
6. Restart recovery resolves the saved operation before reading any source
   Object. An already committed operation replays the identical saved request
   and checks the same operation/commit receipt, then acknowledges it locally.
   A local save failure preserves the durable request for another retry.
7. An uncommitted stale request can be replaced only after a fresh full
   membership/content/attachment verification, while local state is still
   unchanged. The replacement is persisted before submission. Incorrect target
   bytes never authorize a new request merely because the database is newer.
8. The first submission still requires the exact local snapshot and queue.
   Once the Host proves that the saved request already committed, a separate
   acknowledgement transaction preserves later survivor edits and new members.
   It clears only the saved deletion requests whose original tombstones still
   match; a later request can reuse the queue ID and must remain queued.
   Corresponding tombstone revisions advance to the confirmed native commit.
9. If a removed member is already live in the local vault, the same encrypted
   write stores a native restore request with its original tombstone snapshot,
   the local restore/edit intent and the pending update queue. Native deleted
   object identity/head/collection and authenticated vault identity are checked
   before that write. A failed local acknowledgement saves neither half.
10. Recovery restores the original native Object and attachments, then retains
    the latest still-live local row. The native provider baseline comes from the
    original restored content, so subsequent ordinary sync publishes any newer
    local password, notes or fields rather than treating them as acknowledged.
    Further live edits during restore recovery are preserved. Changed native
    identities and provider replacement remain guarded. A completed removal
    can resume its linked pending restores.
11. A newer explicit local delete during either ordinary or compensating restore
    remains a tombstone. Recovery settles the original saved restore request,
    preserves the newest local fields/timestamps and delete queue, and advances
    only the native baseline to the confirmed restore commit. Ordinary sync then
    performs the requested deletion. Unknown receipt status is not treated as a
    cancelled request: a delayed original request may still commit. Until that
    settlement finishes, the remote object may be temporarily restored; no local
    cancellation-complete state or new cancellation UI is advertised.
12. Preparation can now be cancelled internally before a deletion intent exists.
    The encrypted journal saves a detached full draft before removal-only owner
    promotion and renumbering. Cancellation restores those structural changes,
    keeps acknowledged remote references and independent later password edits,
    and queues the complete surviving project for normal sync. A field collision,
    changed membership/provider or independently deleted row leaves the journal
    and current content intact. Shared-field reconciliation is checked against
    every later edit, so it cannot silently spread an older draft value over it.
    A terminal `cancelled` record prevents old coordinator/finalization retries
    from issuing deletion. All attachment copies remain; cancellation does not
    attempt to delete a copy that may have acquired new contents. Old journals
    without the cancellation snapshot remain readable but cannot use this action.

The original Native guard is documented in
[`mdbx2-project-removal-revision-317.md`](mdbx2-project-removal-revision-317.md).
No Android product source or Native engine code changed in this recovery slice.
The ordinary provider sync deletion gate remains enabled for pending journals.

## Evidence

`tests/interop/android317-project-removal-durable.interop.ts` runs actual Native
Messaging OS processes, actual provider writes, the production coordinator and
an encrypted envelope saved to disk. Six cases passed:

- Lost attachment response without a second copy; failure to save the deletion
  intent leaves all original Objects live.
- A two-row atomic delete commits, its successful response is discarded, the
  Host restarts, local acknowledgement fails, and a second restart replays the
  exact original commit without reading source Objects. Rich custom fields and
  the shared attachment survive. Ordinary sync subsequently has no conflict.
- Same-size target attachment replacement after final verification rejects
  the native transaction. Restart refuses the bad proof without replacing the
  saved request. Restored correct bytes are reverified; failure to save the new
  request still performs no deletion; restart completes the new request.
- Independent source Object edit, survivor Object edit, new remote project
  member and replacement local provider each prevent recovery from deleting
  any original Object or changing the saved local envelope.

Latest process matrix evidence:
`.tmp/project-removal-durable-native-20261005-matrix/*/evidence.json`.
Raw log: `.codex-tasks/android-interop-315/raw/project-removal-durable-native-matrix.log`.
Full regression passed **200 files / 1916 tests** in
`raw/project-removal-durable-full.log`; production build and both TypeScript
configurations passed in `raw/project-removal-durable-build.log`.
The earlier interrupted run preserved its first successful receipt case but
was stopped after a test hook re-entered the local mutation lock. The harness
now captures the snapshot before entering that lock; the product lock was not
weakened.

Host SHA-256:
`08f7715fc62636998b26014b35b7af4180f81ecfa31f7f0f79391023277e97fb`.
The historical synthetic Android MDBX archive is only a bootstrap; these are
new synthetic password records, not a fresh Android application run.

Replay in the extension directory:

```powershell
$env:MONICA_317_REMOVAL_NATIVE_INPUT = (Resolve-Path .tmp/android-app-parity-20261001/android.mdbx).Path
$env:MONICA_317_REMOVAL_NATIVE_OUTPUT = Join-Path (Get-Location) '.tmp/project-removal-durable-rerun'
npx vitest run --config vitest.android-interop.config.ts tests/interop/android317-project-removal-durable.interop.ts
```

## Remaining work

- Manager-only commands, manual retry/cancel and source-sync startup recovery
  are connected and verified in Edge. Build pending-operation presentation and
  inspect the local Canvas removal/undo design before enabling editor actions.
  Run actual UI and current Android roundtrips.
- Already committed deletion now reconciles later edits, new members and a
  locally restored member through the durable native restore flow described
  above. A newer delete during pending restoration now settles the original
  restore before syncing the latest delete. Preparation cancellation is now an
  transaction exposed to the manager runtime; the user-facing cancellation flow
  remains open. Cancelling an already prepared remote deletion is still guarded.
  Remote changes to the deleted Object, replaced bindings
  and restoration of deleted parent collections also remain guarded.
- Verify trash restore semantics, grouped membership and native undelete. The
  current evidence covers deletion, restart and subsequent ordinary sync.
- Other backends and multiple external targets still need dedicated deletion
  transactions. WebDAV latest-backup CAS and Bitwarden deletion/attachment
  semantics are independent gates; this coordinator does not bypass them.

## Committed deletion reconciliation evidence

The current actual Host matrix passed 13 cases, including two new cases:

- Native deletion commits and saving its local acknowledgement fails. The
  user edits a survivor and adds a member. After Host/service restart, another
  acknowledgement save failure preserves the entire encrypted file. Retry
  records the original commit, keeps the new queue, and ordinary sync publishes
  both latest rows.
- After the same committed-deletion failure, a removed attachment owner is
  restored and edited locally. The native restore commits, but its local
  acknowledgement also fails. The user edits the password and notes again;
  another restart replays the exact restore, preserves the latest values and
  queue, then syncs them to the original Object ID. The original attachment
  plaintext hash matches and the other removed member stays deleted.

The standalone tests also check invalid/uncommitted receipts, source replacement
guards, reused queue IDs, invalid restore journals and the requirement that a
compensating restore has its linked, confirmed deletion record. Pre-commit
strict-snapshot rejection remains covered. No manager action, browser rendering
or fresh Android application acceptance is claimed by these process tests.

Final run paths and regression counts are recorded in the current
`.codex-tasks/android-interop-315/PROGRESS.md` checkpoint. The earlier failed
Native assertion selected a removed member by array position instead of the
attachment owner; it is retained as a harness failure. Another rejected test
assumed `upsertItem` could replace a native reference, but the existing service
correctly preserves that reference; provider replacement protection remains
covered separately.

## Restore/re-deletion and preparation cancellation evidence

The actual Native/disk-envelope matrix now has **21 passing cases** at
`.tmp/removal-cancellation-native-20261005-final/*/evidence.json`;
`raw/removal-cancellation-native-final.log` records the full run.
Six new cases cross ordinary/compensating restore with an unsent request, a
committed request whose response is lost, and the old request arriving after
the newer local deletion. They include a stale vault revision, failed request
replacement, failed local acknowledgement, multiple Host/service restarts,
and a second deletion reusing the queue ID. Native readback verifies the exact
original JSON and attachment bytes before the latest delete syncs. Replaying
the original restore after that final deletion returns its old commit and
leaves the object deleted.

Two additional cases cancel after the actual shared attachment copy, covering
encrypted cancellation save failure/restart and cancellation racing with final
deletion preparation. All original Object IDs, credential metadata including
`9007199254740993`, original/copy attachment hashes and later password edits
survive. Old coordinator retries make no native writes, and ordinary sync has
no conflicts. These tests do not exercise browser UI or current Android screens.
