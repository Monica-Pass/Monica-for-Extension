# Undo an unsynchronized password-project deletion

The existing whole-project restore confirmation now also cancels a deletion
before it reaches MDBX. All confirmed members become active together in one
encrypted local write. Unpublished members retain their pending create; dirty
existing members retain their pending update. Original identities, rich fields
and attachment references remain unchanged.

For existing native objects, cancellation verifies the authenticated vault,
active original parents, exact active object heads, type/schema and a stable
vault revision. It sends no native mutation. Entirely unpublished projects can
be restored offline. Conflicts, uncertain mutation receipts, changed membership
and overlapping restores/removals/moves retain the deletion without writing.

A completed receipt is saved in the same encrypted write. Lost responses and
browser restart resolve the original immutable request. Replaying a completed
receipt returns current members and cannot undo a later edit or deletion.

Validation on 2026-10-05:

- 209 test files / 2031 tests passed, plus production build and both TypeScript
  configurations. Logs: `raw/group-cancel-full-final.log` and
  `raw/group-cancel-build-final.log` under the task directory.
- All 29 actual Native-process/encrypted-envelope cases passed. Three new cases
  cover failed-save/restart cancellation with exact native heads, payloads and
  attachment SHA; remote deletion refusal; and a changing vault revision.
- Actual Edge runs `run-3zOhh1` and `run-LRGTtx` passed cancellation, lost
  response, synchronized group restore, stale confirmation and restart replay.
  Automatic sync is disabled through the real preference in the isolated test
  profile, so unchanged native heads prove cancellation occurred before sync.
  Both restored the temporary registry and reported no console errors.
- `run-3zOhh1` was transferred with three encrypted Blobs to the current Android
  1.0.317 app and independently reopened after an Android note edit. Three rich
  members, credential metadata, protection/unknown values, identities and
  attachment hashes passed. Untouched native JSON stayed exact. See
  `.tmp/android-group-cancel-317/` and `raw/group-cancel-android-*.log`.
  This uses fixture transport and actual app repositories/viewmodels; it does
  not complete the user-facing MDBX+Blob backup flow or Android screen coverage.
- Inspection found a squeezed desktop restore button. The local editable Canvas
  now includes `projecttrashdesktop317`; the native manager puts the button on
  a separate row. `run-LRGTtx` verified and captured 1280/420/320px layouts,
  minimum 48px action height and no tile overflow. Build and security audit on
  that final layout passed (`group-cancel-build-layout.log`,
  `group-cancel-security-layout-final.log`). Android proof predates this CSS-only
  correction. [Editable design](design/project-restore-ui-317.md).

The Host is unchanged (SHA-256
`7776601229d69c9e9e035a0aba07d639029cd0b3a235a5615c9dd0de1d8f9968`).
Android product sources were not changed. The public AVD was stopped after
same-boot verification; its configuration and disks remain available.

[Mixed acknowledged/unsent deletions](mdbx2-mixed-project-restore-317.md) now have
a durable subset-restoration path with actual Edge acceptance. Unknown previous
write outcomes, remote-only tombstones, deleted parent hierarchies and historical
cohorts with active members still need work. The
complete Android/browser counterpart goal remains incomplete.
