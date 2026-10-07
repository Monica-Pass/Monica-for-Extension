# Restore a partially acknowledged password-project deletion

Whole-project restoration now supports a cached cohort containing acknowledged
native tombstones, native objects whose deletion was not sent, and unpublished
passwords. The same manager confirmation covers all members. It restores the
deleted native subset in one transaction and publishes the complete local cohort
in one encrypted save. Active native objects keep their original heads/payloads;
unpublished members retain creation intent; prior dirty fields retain update
intent for ordinary synchronization.

`Mdbx2RestoreBatchRecord.cancellation` holds the full original snapshots and exact
queued deletions. The native `members` array contains only objects needing
restoration. The operation scope binds both sets and the immutable user request.
Staging consumes the reviewed deletion queue and matching prepared receipts in
the same encrypted write as the recovery journal. Until acknowledgement, every
local tombstone remains available. Runtime summaries, overlap guards and terminal
replay include all members, including unpublished ones.

Preflight verifies exact native identities/heads, active original directories,
the absence of other active project members and a stable vault write revision.
The existing native batch operation checks that revision atomically. Revision
replacement rechecks both the deleted and retained active members, then durably
replaces the request before dispatch. Response loss resolves the native receipt
before rereading already-restored objects. Later local deletion remains queued
for any member category; completed replay cannot revive it.

Changed snapshots/queues, unresolved mutation receipts, failed deletion attempts
against retained members, conflicting membership, duplicate logical identities,
pending removals/moves and overlapping restores are refused without consuming
the deletion. This does not claim recovery of an unacknowledged native deletion
whose new head is still unknown locally. Remote-only tombstones, deleted parent
hierarchies and historical cohorts with active local members also remain open.

Validation on 2026-10-05:

- 209 files / 2053 tests passed, with production build, both TypeScript
  configurations and the runtime security audit. Logs under
  `.codex-tasks/android-interop-315/raw/`:
  `mixed-restore-full-final-2.log`, `mixed-restore-build-final-2.log` and
  `mixed-restore-security-final-2.log`.
- All 40 Native suite tests passed in `mixed-restore-native-final-2.log` and
  `.tmp/mixed-restore-native-20261005-final-2/`. This includes six new mixed
  recovery scenarios and one encrypted Edge-fixture preparation test, alongside
  the previous 33 cases. New scenarios verify failed staging/acknowledgement,
  response loss and actual process restart, later deletion of native-deleted,
  retained-active and unpublished members, changed retained remote content, and
  stale revision replacement. Raw payloads, rich fields, protected credential
  metadata, original identities and attachment SHA are checked.
- Actual Edge `run-cf76I6` and final `run-QHJDws` passed backup import, source unlock, four-member
  confirmation at 1280/420/320px, cancel, lost successful response, complete
  terminal receipt, real browser/Host restart and subsequent creation of the
  unpublished password. Exact original payloads and the two retained active
  heads stayed unchanged. Registry restoration succeeded; no console errors.
  Desktop and 320px screenshots were inspected. UI layout and the existing
  [local Canvas design](design/project-restore-ui-317.md) were unchanged.
  The final run also saves `edge-restored-project-expected.json` with four
  independently identified native objects for the next Android return check.

The partial acknowledgement fixture comes from an actual Native deletion and
the service's explicit acknowledgement/deferred-mutation interface. Its encrypted
backup is imported using the real manager. This verifies mixed restoration UI,
not a natural browser-originated partial-sync failure. The four-member Android
return is now verified separately below; preceding three-member results were
not used as proof of that return.

The first Edge run (`run-ss35R2`) is retained as a failure: the synthetic new
password incorrectly reused another member's `replicaGroupId`. Post-sync exact
payload comparison detected an overwrite. The fixture now uses an independent
logical identity, the mixed journal rejects duplicate nonempty logical IDs, and
the successful run proves a separate native object is created. This is not a
claim that every general creation/import collision path has been audited.

Earlier test failures were fixture issues: ordinary edits preserve native
identity, so unpublished test members now start in a fresh vault state; the old
directory mock needed deleted-summary responses; the acknowledgement type does
not contain a `revision` field (revision is in the returned provider reference).
All failure logs remain available. No data guard was relaxed.

Host SHA-256 remains
`7776601229d69c9e9e035a0aba07d639029cd0b3a235a5615c9dd0de1d8f9968`.
No Android product sources, publication state or APK deliverables were changed.
The complete Android/browser counterpart goal remains active and incomplete.

## Four-member Android return preparation (2026-10-05)

The exact `run-QHJDws` output now passes an independent Native preparation
check using the current extension code. All four logical and native identities
are distinct, original payloads and collections match, and the original Edge
vault remains unchanged. The fixture clones the closed Host data before opening
it and exports every authenticated external Blob, including the attachment
created during restoration. Four encrypted Blobs and one readable project
attachment are staged under `.tmp/android-mixed-restored-project-317/`.

The Android test and independent return verifier now accept the explicitly
identified mixed mode with exactly four members; ordinary restoration still
requires three. They reject duplicate identities. The device runner records
every imported file hash, and the mixed return check requires the exact built
app/test APKs and source snapshot. Current product hashes (1651 files) and nine
unchanged restoration implementation files have been checked against their
recorded baselines. TypeScript and runner syntax checks passed.

Actual Android execution is pending. The first build failed allocating about
1.5 GB of JVM memory; a second, bounded build failed while system commit space
was nearly exhausted. Both failures and original installed package hashes are
retained; no test APK was installed. The runner supports an explicit 3 GB,
single-worker build and an optional device-independent build mode. This mode
does not weaken installation/instrumentation identity checks: its report only
claims source/APK build provenance, and subsequent device runs must verify
their own boot, installed packages, source hashes and input/output hashes.

Preparation: `raw/mixed-restore-android-prepare.log` and fixture
`input-source-proof.json`. Failure logs:
`raw/mixed-restore-android-build.log`,
`raw/mixed-restore-android-bounded-build.log`; diagnostic excerpts are kept in
the corresponding `*memory-diagnostic.txt` files. These files do not prove a
four-member Android application return.

A third build was deliberately interrupted when the operating system reported
only about 18 MB of remaining commit space. Its runner and Gradle process were
confirmed stopped. `raw/mixed-restore-android-offline-build.log` is incomplete
and is not successful-build evidence. The shared AVD belongs to another task
and remains running; no application/test package was replaced during this work.

## Four-member Android return verified (2026-10-05)

The current Android application imported the exact historical Edge output,
projected all four independently identified passwords into one Room project,
read rich fields and protected custom fields, verified attachment bytes, edited
one member through the actual password ViewModel, reopened and exported it.
The device test passed. An independent extension Native reader verified all
four original object identities and physical collections, all four encrypted
Blobs, and the shared attachment's exact 23 bytes and SHA-256. Three unedited
payloads remain byte-for-byte identical; the edited member retains all values.

The first strict return assertion detected seven Android JSON encoding
omissions. Its failure log and JSON report are retained. The final verifier
permits omitted category/note/SSO bindings only when the original is null,
omitted SSO provider only when originally empty, and omitted `mdbx_folder_id`
only when it equals the separately verified native collection. Every other
field remains strictly compared, with only the requested notes edit, local Room
ID and explicit plaintext marker accounted for. This is not an allowance for
populated fields to disappear.

After repeated full-build memory failures, the runner reused the previously
verified unchanged application APK and rebuilt only instrumentation. The first
reuse attempt failed because excluded Gradle producers prevented Kotlin output
provider resolution. Keeping those tasks in the graph while skipping their
actions fixed the harness; the build completed in 65 seconds. The application
APK and compile API jar hashes were identical before and after. Android product
sources were not modified.

- Android HEAD: `8334e6bff9d08529f5d88b911b57a9d0a2579997`.
- Application APK SHA-256: `61c8c0c0955e31146957105f19c55e8a6a669f8670485960cda0d0eca13c576d`.
- New test APK SHA-256: `98841a092d473c578a0a167fbc6530629c0c6143ac1853c39e7fc322547ee6d8`.
- Returned MDBX SHA-256: `f9fd0137730860386fd286876ac489622a2fd2a4cc71f648e09c1009b842e454`.
- Both TypeScript configurations passed. The 1651 product files and nine
  restoration implementations match their prior verified manifests; no full
  unit-test or fresh Edge run is claimed for this harness-only phase.

The public AVD had been stopped by its previous owner. This phase started it,
verified original packages before installing, restored and reverified both
original APK hashes after instrumentation, then stopped its own emulator.
Configuration and data disk are preserved. No APK was delivered.

Evidence: `.tmp/android-mixed-restored-project-317/`; logs
`raw/mixed-restore-android-instrumentation-build-2.log`,
`raw/mixed-restore-android-return-final.log` and
`raw/mixed-restore-android-check-final.log`. The final source/APK/input/return
manifest is `raw/mixed-restore-return-manifest.json`. This closes the specific
mixed restoration Android return gap; broader lifecycle and Passkey parity
remain incomplete.
