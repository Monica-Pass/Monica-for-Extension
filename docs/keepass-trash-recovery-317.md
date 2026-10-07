# KeePass native trash and restore — 2026-10-06

The extension now retains KDBX recycle-bin entries and restores the existing native objects. This fixes two encrypted-service failures: a successful delete disappeared from the extension's trash, and restoring before a lost deletion acknowledgement left an unresolved conflict.

Actual Apache/Edge acceptance exposed a third defect: the Android-generated KDBX used here is version **4.1 with its recycle bin disabled**. Calling `Kdbx.remove` directly permanently removed four entries. The extension now follows Android's current `KeePassRecycleBinPolicy.ensure` behavior: repair disabled or missing recycle-bin metadata before soft deletion. A malformed bin pointing at the database root is rejected. Existing entry UUIDs, protected/unknown fields, history and binary attachments remain in the file.

## Implementation

- `KeePassProvider.sync` and `refreshFromSession` project native deleted records instead of discarding them. Repeated synchronization does not move an already-trashed entry again or lose its previous-parent metadata.
- An encrypted queue entry records `keepassRestore: true` only for an explicit restore of an existing KDBX object. Later edits retain the intent; a later delete clears it. Durable receipts bind this flag, and recovery distinguishes a previously committed delete from a newer restore.
- Restoration moves the original `KdbxEntry`. Its available, active `PreviousParentGroup` is used; otherwise the root is used, following the Android resolver. KDBX 4.1 supports that standard field. Older files are not silently upgraded.
- Changed represented contents in native trash produce a conflict before restoring or overwriting them. Ordinary edits do not imply restoration. The queued intent remains available after failure.
- The existing trash/archived Passkey status now reflects its lifecycle state instead of saying it is ready for browser authentication. Candidate queries already exclude deleted/archived records. This is an existing UI state correction; no layout or Canvas redesign was needed.

## Evidence

- Full regression: **233 files / 2,405 tests passed**; production build, both TypeScript projects, strict E2E/verifier types, and security audit (195 runtime commands) passed. Seven additional real encrypted-service scenarios cover interrupted delete acknowledgement/receipt cleanup, repeated sync, history/binary/original-folder preservation, edits/redelete during restore, changed native trash, cancellation of an unsent delete, and disabled-bin repair.
- Actual headed **Edge 154.0.4258.53** with isolated Apache WebDAV: delete the Android fixture's three-password project and a synthetic Passkey; let Apache commit, then replace the successful response with 503 and reject subsequent proxy requests. A separate fresh browser confirms four native trash records and no Passkey candidate. Restore all four using the rendered trash actions while offline, fully restart Edge, recover and synchronize. All five original records survive, including the independent same-title login.
- The restored Passkey completes actual `navigator.credentials.get`, the extension prompt, and master-password user verification. Its ES256 signature verifies independently; credential ID, user handle, keys, backup flags and RP binding are preserved, and the persisted counter advances **41 → 42**. A fresh browser connection reads counter 42 from the actual server file.
- This Passkey is a synthetic key created by the shared core in the test runner and then stored through the actual extension. This is restoration/signing evidence, **not a new browser-registration or Android Credential Manager acceptance claim**.
- Independent file verification reads `before-delete.kdbx`, `committed-delete.kdbx` and `restored.kdbx`. All five UUIDs/parents, exact password/unknown fields, relevant history and binaries are preserved. The repaired bin contains four entries after deletion; none remain deleted after restoration. KDBX metadata and the actual assertion are verified separately from the UI.
- Accepted evidence: `.tmp/keepass-trash-edge-317-final/keepass-trash-recovery-rea-41fb9-art-and-actual-Edge-signing/`. The earlier real permanent-deletion failure and native metadata diagnosis remain in `.tmp/keepass-trash-edge-317/`. The second run passed data/signing checks but its final screenshot captured the loading state; the accepted run waits for rendered records, and both accepted screenshots were inspected.

## Scope and cleanup

The remote coordinator also serves OneDrive, but this batch used actual WebDAV only. Android source was read to match recycle-bin policy and restore targeting; no Android product file, build, installation or device state was changed. The earlier Android fresh-KDBX project-grouping defect and other Android Passkey differences remain open. Individual restore actions for all project members were tested; this does not prove a single atomic whole-project restore UI or every conflict/lifecycle case.

Owned Apache was stopped by verified ID/name/start time; volumes and synthetic directories remain. Cleanup removed **136,717,890 logical bytes** (about 137 MB), with **2,685 protected hashes unchanged**. Profiles' vault data, KDBX files, screenshots, traces, APKs, Native Host executable/PDB and `dist` remain. No build followed cleanup. Source/build/evidence bindings are in `.codex-tasks/android-interop-315/raw/keepass-trash-317-manifest.json`. Overall goal remains active, 15/24 tracker rows complete; no commit or publication.
