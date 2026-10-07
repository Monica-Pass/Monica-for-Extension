# Real Edge complete MDBX backup acceptance

The production extension now has direct evidence for an encrypted MDBX complete-backup roundtrip: real Edge export, separate browser profile and Native Host data directory, direct ZIP import, wrong-password retry, full browser/Host restart, exact data and attachment readback, then real WebAuthn authentication with the original Edge-created RSA Passkey.

## Verified fixture and path

The input is the historical, successfully verified `edge-passkeys.mdbx` from `.tmp/passkey-android-native-final/`, SHA-256 `1b0a02b31ecdfd712f695ea7bc046e005b43d8f2045fa25a51059cbb3282e255`. It contains five existing Passkeys; the original input hash remains unchanged. The fixture adds a two-password project with shared username, multiple URLs, multiline notes, protected custom data and Android manual-stack metadata, plus a 3,145,801-byte attachment.

The real UI first downloads a standalone encrypted MDBX before external attachments exist. It later exports a complete ZIP containing one database and **13 encrypted Blob files**, all checked against their filename SHA-256. The final archive is `.tmp/complete-backup-317/110153ff/complete.mdbx-backup.zip`, SHA-256 `6dd0b2dc78b1aa12b3aab3bc62dbecfc11fbe400ac90b9aba6ac1a9b16f81281`.

The restore uses a separate extension profile and separate Host `LOCALAPPDATA`. Cancel import leaves the existing local provider and vault items unchanged. A wrong database password adds no source/items; retrying with the right password imports successfully. Seven Native objects match their original complete records, including exact raw payload text, IDs, revisions and metadata. Project contents and all attachment bytes match. The same assertions pass after closing and restarting both Edge and the Native Host, unlocking the existing restored working copy without reimporting.

Finally the original Edge-created RSA credential completes `navigator.credentials.get` through Monica's real prompt and password verification window. Independent Node crypto checks verify its original public key, credential ID, user handle, challenge, RP hash, HTTPS origin, UPUV/backup flags (`29`) and zero-counter behavior. Existing `true` defaults for absent backup flags are checked separately from exact stored presence; explicitly false flags remain false.

## Evidence

- Real Microsoft Edge **154.0.4258.53**, visible isolated profiles and actual Native Messaging. Current debug Host SHA-256 `cb53e6e5e8a13df2db180135d400a35e2409fd83ae5e40563592b5ea3a88debb` was built from current sources. The prior executable was retained in `.tmp/complete-backup-edge-317-prior-host/`.
- Final E2E: `.tmp/complete-backup-edge-317-fourth/`; `raw/complete-backup-edge-fourth.log`: **1 passed**, 38-second scenario. Source/restore screenshots, browser provenance and registry restoration are retained. Original registry values were restored after every run.
- Independent review opens the actual persisted restored Native working copy in a new process after the browser exits. It rechecks all seven exact records, decrypts and checks attachment bytes, verifies all archive Blob hashes and independently validates the saved RSA assertion. `scripts/verify-complete-backup-edge-317.ts`, `raw/complete-backup-edge-independent-final.log`, and `independent-{review,native-readback}.json` in the fixture directory.
- Both project TypeScript configurations and production build passed; strict E2E and verifier types passed; Host provenance verification and security audit (192 commands) passed. No full suite repeat for the CSS-only product correction; the preceding consolidated suite and repaired language suite remain the broader regression evidence.
- [Editable local Canvas](design/complete-backup-layout-317.md) and final real screenshots were inspected. The narrow form now keeps each section's natural height instead of allowing flex compression to overlap status text with the next controls. The real 320px test checks both overflow and section separation.

## Failures retained

The first run's full-page screenshot relocated the narrow scrolled form before Cancel. A viewport screenshot and captured pointer/click targets verify the real button interaction. The second run incorrectly expected no providers after setup; it now compares the actual baseline local provider. The third run expected explicit backup flags on a historical credential whose original payload omits the default `true` values; exact before/after presence is now checked as well as its effective flags and signed authenticator data. No private key, flag value, content or signature assertion was weakened.

Actual screenshot inspection found the separate narrow form compression bug; `flex: 0 0 auto` fixes it, with real geometry checks. The first standalone verifier used an invalid source-kind literal; the current public contract uses `vault`, and strict types now cover that verifier. Failed logs and traces remain available.

## Scope still pending

This is browser/Native evidence. It does **not** establish Android SAF extraction/import of the archive, Android history/attachment UI, real cloud roundtrips, abrupt Host crash cleanup or release packaging. The original raw MDBX and complete ZIP remain separate formats; Android currently needs the archive extracted with `vault.mdbx.blobs` beside `vault.mdbx`. Known Android Passkey defects and direct OneDrive sign-in acceptance remain open.

The legacy `interop-315-edge-features.mjs`, `interop-316-edge-api-address.mjs` and `interop-317-edge-native-restore.mjs` still reference the obsolete export-button label; the last also expects the old blanket attachment refusal. Update those scenarios to the complete-backup contract before their next application-return run, including explicit file-format/sidecar handling. Their historical successful reports have not been rewritten.

After acceptance, **1,129,157,370 bytes** of regenerated Rust compilation caches were removed. All **1,196** protected current/prior executables, fixture files, build assets and final evidence retained identical hashes. The first cleanup check waited for a live compiler/Host to exit; no process was killed. No build was rerun after cleanup.
