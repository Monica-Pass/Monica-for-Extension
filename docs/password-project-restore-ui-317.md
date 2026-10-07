# Password-project restore UI and Android return

The recycle bin now offers **整组恢复** for cached MDBX password projects deleted
together. The confirmation names the source, credential groups and password
counts without displaying secrets. It restores original native identities,
payloads and attachments in one transaction. A pending panel in the recycle bin
and source page allows source unlock and continuation after browser restart.

[Editable local M3E Canvas](design/project-restore-ui-317.md) contains
`projecttrash317`, `projectrestoreconfirm317` and `projectrestorepending317` in
`docs/design/android-interop-315.m3e.json`. All three frames were rendered locally;
the final confirmation was checked after correcting clipped content. Real Edge
screenshots at 320, 420 and 1280 pixels were also inspected. Controls have at
least 48px targets and credential rows use 24px outer / 4px joined corners.

## Verified behavior

Actual Edge 154.0.4258.53 run `run-2KLcbk` uses the historical synthetic Android
fixture enriched through real extension commands with current credential
metadata: two primary passwords, one recovery password, protected fields and
an unknown `9007199254740993` metadata value. Existing payment, contact, address,
application, wallet and note content remains in the fixture.

- Whole-project deletion, synchronization and restoration preserve every
  original native payload and object ID; the three restored heads share one commit.
- Cancel and Escape leave exact cached tombstones unchanged and restore focus.
  Credential names/counts display correctly and passwords are absent from confirmation.
- An explicit concurrent deletion invalidates the reviewed cohort. Initial
  attempt and retry preserve the same request, stage nothing and keep the newer
  tombstone. The runtime propagates the `password-project-restore-not-staged` code.
- A successful response discarded after the real backend commit is resolved
  from its completed encrypted receipt with only one submitted restore request.
- A filesystem obstruction limited to the two receipt slots in the isolated
  test Host forces a real write failure after local staging. All local and
  native tombstones remain intact. A locked-source retry retains the exact
  request. The original receipt files are restored in a `finally` block.
- Real browser/Host restart retains the prepared journal. Source unlock and
  **核对并继续** restore all three members together and focus the refresh control.
- Popup callers cannot invoke start/list/resume. Unconfirmed start is rejected.
  Registry restoration succeeded and the run recorded no browser console errors.

Logs: `.codex-tasks/android-interop-315/raw/group-restore-ui-edge-final-3.log`.
Evidence and inspected screenshots: `.tmp/interop-315-edge/run-2KLcbk/`.

## Exact return to Android

The closed Edge Native working copy was combined with its original three
encrypted Blob files, independently reopened and staged for current Android.
This is a test fixture transfer; it does not implement complete backup UI.

Android `1.0.317-26100512-36` imported the database into an isolated test database,
rebuilt Room projections and verified all three members, current credential
metadata, field values and protection flags. It checked raw native JSON and
read the real card/note attachments, edited one member's notes through
`PasswordViewModel`, then reopened and exported. Independent extension Native
readback verified the returned identities, exact unedited JSON, passwords and
all custom fields. Only the edited notes, Room projection ID and Android's
`monica_password_encoding: "plaintext-v1"` marker changed on the edited object.

Both attachments match before and after Android editing:

| Attachment | Bytes | SHA-256 |
| --- | ---: | --- |
| wallet-cardface-315 | 68 | `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15` |
| wallet-note-315 | 48 | `67b83d22c8cffd6f9651ad3ef01a01a9ec1a93d0ad0e86b3d993d1d8831310de` |

Evidence: `.tmp/android-group-restore-ui-317/` contains
`restored-project-prepare-evidence.json`, `restore-project-evidence.json`,
`restored-project-android-readback.json` and `restored-project-return-evidence.json`.
This exercises Android repositories/viewmodels/Room/attachment services, not
Android screen interaction or whole-project `saveProjectCredentials` editing.

Android main revision `63bb37b4f92f958d59a3a3aa5225a4ad20eb05d2` and dirty diff
SHA `a34176997e753a5a72afa95f6f22b2c845d3abb7a179178f0842add60f3b2101` match the
previous verified build. Installed app SHA is
`1c731442002c4ad678786573a6980e62098dd1bbd89d794707233321259b742f`; test APK SHA is
`02bab91b8027c213feae397570d5f11c7a3c191af5345bd5784b87cfbe5c5d11`.
Both source sets, installed packages and device boot remained unchanged.
The task started and stopped the shared `Monica_Issue136_API_32` without
discarding its configuration or data disks. No Android product source changed.

## Regression and limits

208 files / 2018 tests, production build and both TypeScript configurations pass.
All 26 actual Native process/disk-envelope cases pass in
`.tmp/group-restore-ui-native-20261005-final-2/`, including explicit request
identity, altered-request rejection and completed replay without new native writes.
Host SHA remains `7776601229d69c9e9e035a0aba07d639029cd0b3a235a5615c9dd0de1d8f9968`.
The earlier 64 Host tests, Clippy and provenance results apply to this unchanged Host.

The native group path currently needs 1–50 cached synchronized tombstones, active
original parent collections and no active native member of the same project.
Earlier deletions are intentionally excluded from this deletion cohort. Atomic
unsynchronized whole-project cancellation now has a separate verified
[local cancellation branch](password-project-unsent-delete-317.md).
Confirmed mixed cohorts now use [subset restoration](mdbx2-mixed-project-restore-317.md)
with a full-cohort receipt and unpublished-member creation retained.
Historical-cohort reconciliation, unknown prior write outcomes, remote-only
trash and parent hierarchy restoration remain open. Re-deleting an
already synchronized tombstone now supports [immediate individual restoration](mdbx2-queued-redelete-restore-317.md)
through the existing button, including durable failure/restart recovery.
Database-only export continues to refuse attachment-bearing vaults until a
complete user-facing MDBX plus Blob workflow exists. The full Android/browser
counterpart goal is incomplete.

Failed runs remain available: the source-dialog title changed during import
and fooled a title-based test locator; a global style reduced a close target to
44px; the new unstaged error code was missing from runtime serialization;
the expanded test reset attempted single restore before re-delete sync; and a
desktop navigation selector was used at 320px. The stable dialog locator,
48px styles and runtime serialization were corrected. The fixture reset now
originally synchronized before restoration and used the desktop viewport for
desktop navigation. Assertions were retained.
