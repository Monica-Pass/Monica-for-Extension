# Android V2 ZIP and WebDAV compatibility — 2026-11-11

Completed locally against extension version 1.0.104 with build ID `69dec44063d3b3524998`. This report records verification of the working tree before submission; the feature is recorded in the next-release changelog. Local verification created no tag, publication or installer delivery. Subsequent commits and CI results are recorded in repository history.

## Resulting behavior

- ZIP imports recognize Android V1/V2 from the envelope bytes, authenticate before preview, and import independent items only after confirmation.
- ZIP exports default to V1 and offer password-required V2. V2 uses the Android fixed PBKDF2-HMAC-SHA256/600,000 profile and authenticates the complete 68-byte header as AES-GCM AAD. Every export requires fresh vault authentication.
- WebDAV records, deletions, attachments and generator-history changes preserve an authenticated V2 source even when the saved preference is V1. Unknown versions/profiles, wrong passwords and tampering produce no preview or replacement write.
- Latest-snapshot checks, ETags, create-only PUT and exact read-back verification remain enforced. Unknown archive entries and original snapshots are retained.
- Eight interface languages cover the format options and errors. Short selection labels and a wrapping summary show the full iteration count at narrow widths and large font sizes.

The envelope contract is in [Android backup compatibility](../ANDROID_BACKUP_COMPATIBILITY.md). OneDrive remains outside this change. Manual file transfer retains its existing item-only scope; V2 does not expand attachment/configuration import support.

## Executed verification

| Check | Actual result |
| --- | --- |
| Final complete unit suite after locked dependency installation | 361 files, 4,666 tests passed; 247.31 seconds |
| Focused WebDAV, including real loopback HTTP and V2 snapshot races | 11 files, 202 tests passed |
| Focused file transfer | 25 tests passed |
| Localization and release readiness | 52 tests passed |
| Security suite portions | 723 security/runtime tests and 14 lint guardrail tests passed; final 29 runtime-command audit tests and production-output security audit passed |
| Final production build | Vue script/template and interop type checks, identity, fixed-toolchain MDBX provenance, workers and local assets passed |
| Final full ESLint | Passed |
| Installed Edge, production MV3 build | Both self-contained import/export and WebDAV cases passed; final run 16.2 seconds, single worker, no skips |
| Firefox build | Independent output and static permissions/assets/bridge verification passed; runtime acceptance not run |
| Local development package | Standard `--allow-dirty` packaging and independent verification passed; two independent packages were byte-identical |

Final Edge evidence records the exact bundled build ID. Import/export covers wrong file password, unsupported parameters, preview before insertion, passwordless V2 rejection, fresh authentication for both exports, Unicode/whitespace preservation and 320px/200% font layout. The selected label fits its control and the complete iteration summary wraps. Desktop and large-font screenshots were inspected and remain local.

Edge WebDAV uses a self-owned HTTP server and production runtime messages to read V2, edit a record and publish a new V2 snapshot. Conditional requests, exact readback, unknown entries and original source bytes are checked. Wrong-password and invalid-profile failures retain local items and issue no further PUT. Repository lifecycle cleanup removed both isolated browser profiles.

## Android interoperability

Unmodified Android production `PortableBackupCrypto.kt` and `BackupEncryptionFormat.kt` ran through a compiled launcher and `app_process` on the existing public API32/x86_64 AVD. PBKDF2 used Android BC; AES-GCM used AndroidOpenSSL.

- Ten public synthetic V1/V2 vectors passed encryption and decryption with exact envelope bytes, including ASCII, Chinese/emoji, composed/decomposed Unicode and whitespace passwords.
- Four complete ZIPs, covering ASCII/Unicode and V1/V2, passed extension-to-Android decryption. Android re-encrypted each with fresh random parameters; the current extension decrypted and parsed them with identical archive bytes, two items and unknown binary entries.
- Twelve wrong-password, truncation and modified-tag checks passed.

The task-started public AVD was stopped. Original configuration/registration hashes, disks and every existing user were retained. No Android installation, user database change or user removal occurred.

## Preserved failures and limits

The initial transfer negative test changed the wrong magic offset; it was corrected without changing production behavior. The first full unit run passed 4,665/4,666: the remaining index check counted ten ignored local notes as published documents. It now excludes only Git-confirmed ignored, untracked files; tracked legacy design notes and non-ignored documents still require coverage. Independent review and the final full suite passed.

The interrupted Android compile lacked a compiler dependency; the corrected classpath passed. A new HTTP test's lint error was repaired without disabling its rule. The initial build lacked `vue-tsc`; `npm ci --ignore-scripts` restored locked dependencies and found zero audit vulnerabilities. A subsequent build rejected the stale MDBX engine; locked missing crates were fetched and it was rebuilt with Rust 1.97.0/Emscripten 4.0.18. Provenance checks remained enforced. Security checks completed in portions across these builds; failed composite-script logs remain and are not described as passing runs.

The first Edge run passed, but screenshot review exposed a truncated selection at 200% font. Short labels, a wrapping summary and a text-width assertion repaired it; the final build and both cases passed. Local Canvas preview timeouts remain recorded; a later render used fallback fonts and only part of the state model was visually inspected.

Only synthetic data was used. Results cover Android crypto runtime/ZIP codec and installed Edge UI/WebDAV. They do not establish full Android application import/recovery UI or WebDAV, MuMu/OEM/physical-device behavior, real cloud accounts, Firefox runtime, signed release, power-loss behavior or cross-device atomic transactions.

Raw logs, frozen hashes, screenshots, Android results and package evidence remain in the local task directory. Machine-specific paths and binary artifacts are excluded from this report.
