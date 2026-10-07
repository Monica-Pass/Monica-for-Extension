# KeePass password member removal acceptance

2026-10-06: actual Microsoft Edge and isolated Apache WebDAV passed normal owner removal and lost-acknowledgement recovery. This is a partial acceptance within the full Android parity task, not completion of that task.

`tests/e2e/keepass-member-removal.spec.ts` creates an encrypted synthetic KDBX with three grouped passwords and an owner attachment, opens it through the production WebDAV source, and operates the actual manager editor. Remove/undo, review/back/cancel preserve the original item snapshots and exact remote file bytes. The 320px review has no horizontal overflow and its rendered screenshot was inspected.

Confirming removal leaves two active passwords and one trash entry. Independent HTTP download and native KDBX reopening verify original entry UUIDs, password IDs, password strings and notes. The remaining owner receives the exact shared attachment bytes. Full Edge restart and another production sync preserve two active identities and one native trash entry. This checks against stale-session resurrection.

The final test discards only the actual removal response after the background operation runs. The editor closes successfully via receipt lookup, with exactly one removal command; native file readback and restart checks still pass. Signing, native persistence and remote responses are not replaced.

Evidence under `.codex-tasks/android-interop-315/raw/`:

- `keepass-member-removal-edge-1.log` and matching directory: initial test failed on an incorrect assumption that the manager-only trash-list API redacts passwords. Source inspection confirmed its existing complete-item contract; the test now verifies the original trash password. Product code was not changed to accommodate the test.
- `keepass-member-removal-edge-2.log` and matching directory: normal workflow passed, including independent publication and restart readback.
- `keepass-member-removal-edge-3.log` and matching directory: response-loss workflow passed, with evidence JSON, published KDBX, profile identity and screenshots. Final screenshot shows the UI's pre-refresh unlock screen because restart unlock was via runtime; do not treat it as proof of rendered post-restart project contents.
- `keepass-member-removal-e2e-check.log`: existing application and interop TypeScript checks passed. These configurations do not typecheck Playwright files; the actual Playwright run validates test execution.
- `keepass-member-removal-services-stop.log`: test-owned isolated services stopped. Edge contexts closed in test cleanup. No Android/AVD/native build, publication or APK delivery.

## Concurrent edits and rejected staging

The additional `remote-edit` scenario independently changes the removed owner's notes in the real Apache file with an ETag-conditional PUT. Production sync rejects the project conflict, preserves exact peer bytes and local retained snapshots, and repeats those guarantees after full Edge restart. The source card renders the conflict state. This proves conflict preservation, not a completed conflict-resolution workflow.

The `stale-draft` scenario changes another member locally while the editor has an older snapshot. Added explicit not-staged error classification in `KeePassProjectRemovalWorkflow.stageFromManager`, only after successfully reading the encrypted journal and proving the operation absent while both operation queues remain held. The existing manager then returns to editing with its removal selection intact. Later local changes and original remote bytes remain unchanged. Lost write acknowledgements with an existing journal and unavailable journal reads never receive this classification.

Final actual Edge run passed all three scenarios (`ack-loss`, `remote-edit`, `stale-draft`) in `raw/keepass-removal-final-edge.log`, with artifacts under the matching directory. Rejected-editor and conflict-source screenshots were inspected.35targeted tests/3files, production build/both existing TypeScript checks and security audit passed (`raw/keepass-removal-not-staged-{tests,build}.log`). Test services were stopped (`raw/keepass-removal-conflict-services-stop.log`).

## Interrupted storage and recovery panel

Two additional actual Edge scenarios passed in `raw/keepass-removal-pending-edge-1.log` (52.5seconds). The test temporarily faults IndexedDB methods only in the isolated extension worker and only for `monica-extension-keepass-working-copies`; it does not forge successful writes or seed synthetic journal states.

- `staged-cancel`: working-copy read throws before capture. The production operation remains staged, with original local snapshots and exact remote bytes. Open the pending panel, fully restart Edge, unlock and cancel through the rendered panel. The terminal receipt is cancelled and originals remain exact.
- `writing-resume`: abort the real IndexedDB transaction when inserting its encrypted operation receipt. The working-file transaction is rolled back and the production intent remains writing. After full Edge restart removes the temporary fault, the panel has Continue and no Cancel. Continue completes the operation; pending rows disappear. Independent HTTP/native KDBX readback validates passwords, native identities, notes and shared attachment bytes, followed by another full restart and sync.

Both320px pending-panel screenshots were inspected and geometry checks passed. Browser contexts closed; isolated services stopped, with evidence in `raw/keepass-removal-pending-services-stop.log`. No production changes or Android execution in this batch. The earlier3scenarios were not rerun because this batch adds separate fault paths; their preceding accepted evidence remains identified above.

Remaining: source replacement UI during editing, actual remote conflict resolution/rebase publication, local-file durable recovery, actual Microsoft account acceptance, and Android's full field/backend lifecycle matrix. The fixture here is synthetic; this is not another Android runtime roundtrip. Design source remains [the local Canvas document](design/keepass-removal-317.md).
