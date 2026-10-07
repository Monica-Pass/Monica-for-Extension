# Native password history: transport boundary and safe MDBX2 transfer

Current Android password-only history is stored separately from password entries. `PasswordViewModel.savePasswordHistorySnapshot` records the previous nonblank password at change time. `PasswordRepository` delegates history operations to `PasswordHistoryDao`; Room keys each row by its local password ID. The detail screen observes that DAO. ZIP export/restore explicitly carries `password_history.json` and remaps its owner IDs. Those ZIP paths have already passed [actual Android acceptance](password-history-live-317.md).

The current native MDBX2 password payload and KeePass entry mapping do not read or write that Room history. MDBX commit history and KeePass whole-entry history are different features: neither is automatically projected into the password-only history section. The extension's `preserveLocalPasswordHistory` retains an encrypted local overlay through refresh, but a newly connected client cannot obtain it from those native files. No new extension-only field was introduced or described as Android interoperability.

## Corrected transfer behavior

The MDBX2 batch-transfer planner previously accepted password histories even though the native target omitted them. An incomplete history could also reach destination-folder creation before the codec rejected it. Four initial regressions failed against that behavior; the failed log is retained.

- Copying or moving a login with password history into another MDBX2 destination is now blocked in the preview, before creating folders, writing objects, transferring attachments or deleting a source. The existing preview names the missing capability and points to Monica ZIP backup for transferring history.
- If one member is blocked, the existing dependency planner retains the entire password project or linked component. History-free independent items remain eligible.
- An existing native object can still move between folders in the same provider while retaining its complete local history. A pending reference with no native object ID does not qualify. A copy within that provider is still a new object and is blocked when it contains history.
- Recovering an old unfinished move rechecks history before replaying writes. Final encrypted-vault adoption also checks before any source deletion. A folder move must keep the native object ID and exact local history. Already adopted, identical receipts retain their existing idempotent behavior.
- Incomplete histories remain blocked. No history is silently removed to make a transfer succeed.

This is data-loss prevention, not implementation of native password-history synchronization. Normal provider edits, native whole-entry history and source-file export are unchanged by this batch. A KDBX export can therefore still omit the separate local password-history overlay; use the existing ZIP path when that history must be transferred. Cross-client native history needs an agreed Android reader/writer and owner/deletion/conflict contract. Android product sources remain read-only for this task.

## Verification

| Check | Result |
|---|---|
| Planner, coordinator and encrypted final-adoption regression | 55 tests passed; whole-project rejection, incomplete projection, pending identity, same-vault folder move and response-loss/restart included |
| Full regression | 233 files / 2,414 tests passed |
| Both TypeScript projects and production build | Passed |
| Strict TypeScript for the new Edge test | Passed |
| Security audit | 195 runtime commands passed |
| Actual headed Microsoft Edge / real Native Host | Passed in 8.4 seconds; Edge 154.0.4258.53, existing host SHA256 `781fa5b077ff2f3b5d8ecdb392d26b42dfe865c480bc82c8e00b55f17eee6df5` |

The real-browser scenario imports an existing hash-bound synthetic MDBX2 fixture into an isolated Native Host store, changes a local password through the actual editor, then opens the actual transfer preview. The preview displays the history limitation and disables execution. Direct manager requests for both copy and move also return blocked, proving the UI is not the only guard. All target collections and decrypted object records compare exactly before/after; the source record and its CRLF/Unicode password history remain exact after a full browser restart. The screenshot was inspected. Native Messaging registration was restored. The test did not run Android or revalidate Passkey signing.

Evidence: `.tmp/password-history-native-edge-317/password-history-native-tr-79f8e-d-preserve-it-after-restart/`. The isolated Native Host data is retained at `.tmp/history-native-3a004193-b8d/`. Logs, cleanup and source/build manifest are under `.codex-tasks/android-interop-315/raw/password-history-native-317-*`. The new scenario is `tests/e2e/password-history-native-transfer.spec.ts`; it uses actual Edge and Native Messaging without a browser fallback or transport mock.

After verification, idle compiler/browser caches totaling **22,663,728 logical bytes** were removed. All **1,347 protected file hashes** remained unchanged, including browser vault state, native data, application outputs and evidence. The observed free-space increase was 22,716,416 bytes. No build followed cleanup. Across thirteen historical cleanup batches, 25,601,322,256 logical bytes have been removed, including caches regenerated between batches; this is not a claim about current disk usage.

The overall tracker remains 15/24 complete. Native password-history sync, Android fresh KDBX grouping, Android Passkey issues, remaining backend/lifecycle coverage and actual OneDrive account acceptance remain open.
