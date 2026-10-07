# Password history: real Bitwarden, Edge and Android acceptance

This batch extends [the password-history implementation](password-history-317.md) with a live isolated Vaultwarden server, actual Microsoft Edge and Android application ZIP roundtrips. The Android product source is unchanged by this task.

## Product corrections found by live testing

- An unreadable native history row previously set the fatal cipher warning, causing synchronization to hide an otherwise usable login. History warnings are now separate: the login and readable history remain available, the incomplete-history notice is shown, and original unreadable ciphertext remains at its source. An incomplete projection is not reused from the decoded cache.
- Creating a new Bitwarden record with incomplete history now fails before destination-folder routing, so rejection cannot leave a newly created folder behind.
- Background synchronization can acknowledge an item revision without changing its history. The detail page now keeps a pending delete confirmation across that refresh. Changing the item or actual history cancels the selection; the delete request still validates the current version and row index.

## Completed evidence

The live test uses a new synthetic account on local Vaultwarden 1.37.3. Two logins use a cipher key distinct from the account key and native encrypted history, with repeated passwords, Unicode, CRLF and epoch zero. One also contains an unreadable future-format row. Independent raw-server decryption verifies two password changes before synchronization, ciphertext preservation, unrelated edits, single history deletion, fresh-client synchronization and rejection of incomplete transfers.

Actual Edge 154.0.4258.53 logs in through the source UI, displays the partial login, changes a password and deletes one history row, then synchronizes using the source button. A separate fresh browser profile logs into the same server and reads the exact resulting password/history. The 420px screenshot was inspected: history values are masked and actions remain reachable. Two local Edge regressions also pass, including metadata-only refresh during confirmation, stale request rejection and a full browser restart.

| Check | Result / retained evidence |
|---|---|
| Full regression | 230 files, 2364 tests passed; `raw/password-history-live-317-full.log` |
| Focused provider/history regression | 41 tests passed; `raw/password-history-live-317-targeted.log` |
| Both TypeScript projects and production build | Passed; `raw/password-history-live-317-build-final.log` and `raw/password-history-live-317-check-final.log` |
| Strict E2E TypeScript | Passed; `raw/password-history-live-317-e2e-types-final.log` |
| Security audit | 195 runtime commands; `raw/password-history-live-317-security.log` |
| Live server | Passed; `raw/password-history-live-317-final.log` |
| Actual Edge and fresh browser profile | Passed; `.tmp/password-history-live-edge-317-final/password-history-bitwarden-6e2c6-arate-fresh-browser-profile/evidence.json` |
| Final local Edge regressions | Two passed; `.tmp/password-history-live-edge-317-local-final/` |
| Actual Android targeted restore/update/export | MDBX and KeePass both passed; `raw/password-history-live-317-android-import-final.log` |
| Independent Android return verification | Both archives passed exact history/password/owner/control and provenance checks; `raw/password-history-live-317-android-return.log` |

`raw/` above is `.codex-tasks/android-interop-315/raw/`. Failed attempts are retained. Early failures exposed the missing login and disappearing confirmation. Test-oracle corrections normalize Vaultwarden's six-digit fractional timestamps and await receipt of the metadata-only version before clicking; ciphertext and history contents remain exact comparisons. A PowerShell CLI typecheck attempt failed on unquoted comma-separated flags; the quoted rerun passed.

## Android handoff validated

`.tmp/android-password-history-317/extension-history.zip` comes from the successful real Edge/server result. Its expected-data file binds the input archive and exact Edge evidence with SHA256. A second, explicitly synthetic control login tests that history remains attached to the correct owner after Android assigns new Room IDs.

The extension-owned instrumentation imports through Android's actual ZIP reader and targeted restore coordinator into isolated MDBX and KeePass destinations. It checks history values and timestamps, updates the primary password through `PasswordViewModel`, checks the unchanged control, then exports encrypted return ZIPs for independent extension verification. The instrumentation repository explicitly receives its optional history DAO. In both destinations the primary row's four histories become five, and the control retains its exact two histories, including epoch zero. New Room IDs remain attached to the correct histories.

The initial Android run passed MDBX but timed out updating KeePass: the shared AVD's saved MDBX list filter added an incompatible owner when the test invoked the save method outside the matching screen context. The repaired instrumentation selects each actual destination through the public ViewModel filter method, verifies the imported rows have unambiguous ownership, and restores all five saved filter fields in `finally`. The old failure and MDBX return archive remain in `attempt1/`. No Android product guard was bypassed or changed. The final instrumentation passed in 7.6 seconds; independent return verification also passed.

Android 1.0.317-26100612-36 was built from the current dirty Android tree rooted at commit `8334e6bff9d08529f5d88b911b57a9d0a2579997`, tracked-diff SHA256 `c9c10efcedb0d5d40064fb2e897c7637445ec6caea896eb0b627006b471179f5`. Full application/test build passed in 10m55s; the test-only repair build passed in 36s using the same hash-verified application and compile API. Final application SHA256 `983baf36a376e198cd441ca2fe17fdb731b338df617e4e1ef3f0ad8e75bf8a22`; final test APK SHA256 `d9ccb850b3442dbe1a9177cae985ec50642e67803546190eec5e7d820a63af9c`. Source, test, installed APK and boot invariants passed and the return checker binds them to the exact build.

The existing public API32 AVD was started by this task, updated without clearing data, and stopped afterward. Its original application APK/version/hash are retained in the isolated evidence directory; no APK was delivered or published. Fixture-owned databases and rows were cleaned by the fixture. The isolated Vaultwarden/WebDAV containers were stopped with their volumes preserved.

This validates ZIP history transport into each Android destination, not native KDBX/MDBX file-history interoperability. No real Microsoft account or OneDrive file is involved. Previous Android Passkey issues and native history transport remain separate open work.

After acceptance, cleanup removed 1,055,175,142 logical bytes of rebuildable Android intermediates, project Gradle caches and browser caches. All 62,659 protected file hashes remained unchanged, including APKs, the reusable compile API, Native Host executable/PDB, extension build, vault-bearing browser profile storage and acceptance evidence. The observed C: free-space increase was 1,145,065,472 bytes; concurrent filesystem activity means this is not an exact cache-size measurement. No build was run after cleanup. The plan, checked PowerShell deletion script and result are retained in `raw/password-history-live-317-cache-*` and `raw/clean-password-history-live-cache-317.ps1`.
