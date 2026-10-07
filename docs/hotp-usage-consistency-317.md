# HOTP copy and autofill consistency

The old successful-use path saved an entire item snapshot after an asynchronous clipboard or webpage operation. Three failing regression tests reproduced lost concurrent edits, counter rollback, and resurrection of a deleted item. Both production callers now acknowledge the used source and counter through `SecureVaultService.consumeHotp`.

The acknowledgement carries the item ID, normalized 64-bit counter, and SHA-256 identity of the source binding and OTP signing parameters. It does not carry a replacement item or the secret. Webpage fills additionally bind the originating login and recheck its current authenticator selection. Changed key, algorithm, digits, source/group/database, missing/deleted/archived records, unresolved conflicts and pending project operations refuse the update.

Under the existing vault mutation lock, the service reads current records and advances only the consumed counter. Later fields and metadata remain intact. Equal acknowledgements are idempotent; a higher current counter is retained without a second write. The service never holds the vault lock while waiting for the webpage. A failed clipboard write does not advance HOTP; a successful password fill without an OTP field does not advance it either.

For an explicitly scoped Android password project, all passwords in the same recognized credential group receive the shared counter update in one encrypted write with their provider mutation intents. Other credential groups and databases remain unchanged. An inconsistent shared OTP baseline is refused. Local, MDBX, Monica WebDAV, Bitwarden and imported KeePass references are covered at the service layer. Successful manager copies and webpage fills use the normal vault-change and automatic-sync notification path. Only the manager can call the new runtime command directly.

## Verification, 2026-10-06

- Original failures: `.codex-tasks/android-interop-315/raw/hotp-usage-red.log` (3 reproduced defects).
- Focused final regression: `hotp-usage-regression-final.log`, 4 files / 52 tests, including independent edits, concurrent/repeated acknowledgement, restart, linked authenticators, large counters, five provider kinds, encrypted write failure/retry, pending removal and provider conflicts.
- Consolidated full suite: `hotp-usage-full-tests.log`, 226 files / 2333 tests passed.
- Both TypeScript configurations and production build: `hotp-usage-build-final.log`, passed. Strict E2E typecheck: `hotp-usage-e2e-types-complete.log`, passed.
- Release security audit: `hotp-usage-security.log`, 193 runtime commands, passed.
- Actual headed Microsoft Edge: `hotp-usage-edge.log`, 5 scenarios passed. Exact browser executable/version/profile are in `.tmp/hotp-usage-edge-317/**/p-browser.json`.
- Extended real Edge fill/restart: `hotp-usage-edge-restart.log`, passed. Actual content-script OTP values were checked against RFC 4226 vectors; the response was deliberately delayed after the real page write while a separate manager edit completed. Both affected project passwords advanced, the other credential group and independent item stayed unchanged, and a later password-only fill did not consume HOTP. A complete Edge process close/reopen and vault unlock retained both counters and the new password/notes. Evidence: `.tmp/hotp-usage-edge-317-restart/`.

All fixtures are synthetic. Delays alter delivery timing only; the real content script, clipboard, encrypted service and browser persistence still execute. Early fixture errors remain recorded: a local removal completed immediately rather than remaining pending; test database IDs were strings rather than the model's numbers; an unquoted PowerShell comma list caused the first standalone E2E typecheck invocation to fail. The fixture was corrected to a pending WebDAV removal and numeric IDs; final checks passed without weakening product assertions.

## Boundaries

This batch verifies extension HOTP behaviour and its local mutation queue. It does not establish actual Android or cloud HOTP roundtrips, nor global unique issuance across windows/devices. Two clients can disclose the same code before either acknowledgement arrives; the local transaction prevents rollback and duplicate advancement, not distributed reservations.

No Android product source, APK, emulator, Native Host, cloud account or publication was changed. Existing Android Passkey counter/allow-list/metadata/backup-flag defects, the full-archive Android SAF restore gap, and the real OneDrive SPA registration/sign-in dependency remain open. Overall Android counterpart acceptance stays incomplete.
