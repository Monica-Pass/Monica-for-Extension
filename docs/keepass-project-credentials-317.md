# KeePass password projects — Android 1.0.317

The extension now restores explicit projects from the Android `monica.content.credential` KDBX field. It can edit the existing grouped project and add passwords or credential groups while preserving per-password identity, shared fields, protected custom values and unknown metadata. A same-title independent login remains separate. Database/provider scopes prevent unrelated files from merging.

Only one valid version-1 carrier with a valid project UUID establishes membership. Missing, malformed, future or legacy metadata stays unchanged and does not invent a project. KDBX group saves require a complete member snapshot and matching unique credential identities before encrypted storage or sync intents change. Existing member removal retains its separate unsupported-backend guard.

Cache migration does not dirty a KDBX merely because its project ID is newly projected. Creation acknowledgements now attach native KeePass entry/group UUIDs while retaining edits made during the request. Empty OTP and absent OTP have the same file fingerprint, preventing redundant writes immediately after creation. Original metadata text remains authoritative; it is not replaced by a lossy parsed projection.

## Actual Android writer and fresh import

Extension-owned instrumentation invokes the production `PasswordViewModel.savePasswordsAcrossTargets` with two credential groups and three passwords, plus an independent same-title login. It exports the actual KDBX, registers another empty fixture-owned database, copies the file and invokes the production KeePass import. No Room grouping IDs are seeded in the destination.

The application is `1.0.317-26100612-36`, SHA256 `983baf36a376e198cd441ca2fe17fdb731b338df617e4e1ef3f0ad8e75bf8a22`. Its APK and saved compile API were reused after exact Android HEAD/status/diff checks; only instrumentation was compiled. Final test APK: `e4f10287f62056a0bb32548c2c473f0d926623abd6d9e7beea305d51c94f69fb`. Android product sources were not edited.

**Android fresh import fails project grouping:** two projects become four independent rows. The three version-1 credential carriers retain the original project/group/password IDs and `9007199254740993`, but `PasswordViewModel.upsertKeePassEntries` does not project their `projectId` into `passwordGroupId` on new Room rows. Existing-row update also omits that mapping. `ProjectCredentialGroup.restore` expects callers to have already selected the explicit project, so merely retaining its carrier cannot repair the outer grouping.

Contacts, address, payment, application, password, OTP, notes and custom-field data remain exact between the Android before/after snapshots. The independent singleton has a Room-only legacy group ID, absent from its KDBX; the extension correctly keeps it independent without inventing portable membership.

Evidence: `.tmp/android-keepass-project-317/`. The instrumentation deliberately retains its failing grouping assertion. `keepass-project-export-evidence.json` binds the actual APK, unchanged sources and file hashes. All five saved filter settings are restored and synthetic databases removed. The public API32 AVD was started only after checking devices/processes and stopped afterward.

Minimal Android follow-up: derive the outer project identity from exactly one supported carrier in both new-row and existing-row KeePass projection, with tests for removal, malformed/future carriers, separate databases and legacy singleton fallback. That product change remains outside this task's read-only Android scope.

## Edge and independent file acceptance

Actual Microsoft Edge `154.0.4258.53` opens the Android-produced KDBX, verifies rich fields, displays the three-password project, changes its shared username/title, adds a password and another credential group, cancels a later edit, exports the file, restarts completely and imports the file in a separate fresh browser profile. Final state is one five-password project plus the untouched independent login. Per-password UUIDs, exact original custom fields and large integer metadata survive. KDBX4 time comparisons account for its native whole-second precision; no extra rewrite is accepted.

The existing credential editor design is reused without a new layout: [editable local Canvas and design](design/project-credentials-316.md). Actual 320px editor and fresh-browser list screenshots were inspected. Existing passwords remain independently protected and the save/cancel actions remain visible.

Final Edge evidence: `.tmp/keepass-project-edge-317-sixth/keepass-project-android-An-73a29-el---file-and-fresh-browser/`. Independent Vitest verification opens both exact encrypted files in a separate process and checks the returned fields/identities against browser readback; `.tmp/android-keepass-project-317/independent-review.json` passes while explicitly retaining Android's failed grouping result.

- Source KDBX: `b580fa742caed7b875aff74f3027777fa293c4ee2b6ad9edef04c718dc3bacbe`.
- Edge return: `f1ec7fc51b475c5c8be8be97dd740ff5872ab9529fbd52d626718db72e726abf`.
- Final full regression: **232 files / 2389 tests pass**; both TypeScript projects, production build, strict E2E/interop types and 195-command security audit pass.
- Final real Edge scenario passes in 9.7 seconds; independent encrypted-file verification passes.

Failed attempts are preserved: missing test-only `groupPath`, stale Settings flow emission masking the first parity error, Playwright's Node/CJS KDBX import, legacy singleton identity assumption, table/shadow-button selectors, and actual missing creation UUID/empty-OTP rewrite. The diagnostic runner now verifies a device SHA256 before accepting pulled artifact bytes; an adb error string cannot masquerade as a fixture.

## Remaining limits and cleanup

This establishes Android file → extension rich project operation and extension file → fresh extension. **It does not pass Android fresh-import grouping**, WebDAV/OneDrive account acceptance or system Passkey acceptance. New-project UI creation, project member removal/restore and full backend/lifecycle matrices remain separate acceptance work. Previous Android Passkey counter/allow-list/cancel/backup-state issues and direct OneDrive SPA registration remain open.

After all checks, cleanup removed **459,087,653 logical bytes** of newly generated Android compiler/Gradle and Edge caches. All **2296** protected files have unchanged hashes, including current dist, APKs, compile API, vault-bearing profiles, KDBX fixtures and evidence. No build followed cleanup. Ten recorded cleanup batches total **22,150,124,907 logical bytes**, including caches regenerated between batches.
