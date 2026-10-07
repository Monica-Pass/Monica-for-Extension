# KeePass remote project recovery — 2026-10-06

Remote KDBX synchronization now preserves edits made after an interrupted publication, unrelated local record IDs, and deferred queue entries. A create deleted after publication is acknowledged against its actual remote UUID and its follow-up deletion remains pending until synchronized. The same coordinator serves WebDAV and OneDrive; this batch's actual service evidence is Apache WebDAV only.

## Changes

- Recovery restores identities using all current records, while the durable receipt's original snapshots remain the baseline for merging the older published intent. New queued records and edits outside that receipt are retained.
- Acknowledgements adopt KDBX entry/group routing without replacing newer local values. Operation changes, including create followed by delete, retain their follow-up intent.
- Pending work beyond one batch remains queued. Explicit password project members are selected together; 98 independent updates followed by a three-member project publish as 98 + 3. A project with more than 100 pending mutations fails before publication and retains its local state. Warnings show the actual selected count.
- This batching rule prevents splitting a project at the numeric boundary. It does not claim that every member conflict, deletion, restoration, or interrupted legacy receipt is an atomic project transaction.

## Validation

- Full suite: **233 files, 2,398 tests passed**. Production build, both TypeScript projects, strict E2E TypeScript and security audit (195 runtime commands) passed.
- Real encrypted `SecureVaultService`, KDBX provider and durable receipt storage: newer create/update edits after crash; unrelated stable IDs; deleted unacknowledged create; 101 independent updates; post-crash unrelated update/create; in-flight create edit; receipt cleanup failure without duplicate write; 98 + 3 project boundary; oversized imported project refusal.
- Actual headed **Microsoft Edge 154.0.4258.53** and isolated Apache WebDAV: create a project with two credential groups and three passwords through the existing UI; let Apache commit PUT, then have a loopback transport proxy replace the successful response with 503 and refuse subsequent requests; edit one password and add another while offline; close the entire browser; reopen the same profile and synchronize; verify eight records, three projects, all prior local IDs and an empty queue. A separate fresh Edge profile reads the exact server file and recovers the same KDBX identities and fields.
- Independent encrypted-file inspection checks exact hashes for the original Android file, committed-before-response-loss file and recovered file. Counts are 4 → 7 → 8. The original Android records retain all tested password, account, OTP, URI, note, contact, payment, application and custom fields. All seven committed UUIDs survive, and the final new project contains exactly the four expected passwords. Empty optional editor strings correspond to absent KDBX fields; nonempty values and original-file fields are compared exactly.
- Final artifacts: `.tmp/keepass-recovery-edge-317-final/keepass-project-recovery-r-dbede--before-a-full-Edge-restart/`. `evidence.json`, `independent-review.json`, both actual server KDBX files, browser provenance and screenshots are retained. Fresh-client list rendering was inspected.
- Early failures remain recorded: obsolete UI title selector; invalid shared-account fixture; changed warning text expectation; missing error-code union entry; empty optional editor-string versus absent KDBX-field verifier comparison. The accepted runs follow these corrections.

## Scope and remaining work

No Android application build, install or device run took place in this batch. Android product sources remain read-only. The previously reproduced Android fresh-KDBX project grouping failure remains unresolved; retained credential metadata alone does not prove Android grouping. Actual OneDrive sign-in, current Android Passkey issues, native password history transport and the full lifecycle/backend matrix are still open.

The task-owned Apache container was stopped by verified ID and start timestamp; its volume and synthetic remote directories remain. Cache cleanup and exact source/build/evidence hashes are recorded in `.codex-tasks/android-interop-315/raw/keepass-recovery-317-manifest.json`. No commit, publication or APK delivery was performed. Overall progress remains 15/24 tracker rows complete.

Cleanup removed **3,291,815,731 logical bytes** from 629 cache directories, including older Edge telemetry. Observed free space increased by 3,290,959,872 bytes. All **112,759 protected file hashes** remained identical. Browser vault state, test evidence, KDBX fixtures, APKs, Native Host executable/PDB and `dist` are retained. No rebuild was performed after cleanup.
