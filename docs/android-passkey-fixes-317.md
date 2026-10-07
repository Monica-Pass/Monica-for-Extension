# Android Passkey compatibility repairs — 1.0.317

Status: the limited credential-ID, allow-list, cancellation and notes repair batch passed its acceptance on 2026-10-06. Android changes were explicitly authorized by the user. The always-zero signing policy is unchanged. This does not mark the broader extension/Android interoperability goal complete.

## Compatibility boundary

The repair does not replace registered private keys or credential IDs, infer a replacement for already corrupted IDs, or migrate the Room schema. The original 18 source files are preserved in `.tmp/android-passkey-fixes-317/source-baseline.json` and `original/`. Additional changed sources are preserved alongside them. Existing Android/F-Droid differences and unrelated working changes are retained.

## Implemented for both variants

- Decode UUID, canonical Base64/Base64URL and Bitwarden `b64.` without losing any credential bytes. Malformed legacy text survives unchanged and cannot authorize a request. Export retains UUID for 16-byte IDs and emits `b64.` for other valid sizes.
- Reject malformed allow-lists. A nonmatching list remains restrictive during database warm-up retries. The authentication activity checks the selected record, RP and allow-list against the actual platform request and its challenge before verification and again before signing. A positive record ID cannot silently select another row.
- Return genuine cancellation from the visible Cancel button and biometric cancellation; ignore stale verification callbacks and repeated signing attempts. Explicit master-password selection and unavailable/error fallback remain available.
- Authentication surfaces display account identity without exposing notes. Management screens retain their remark-first title.
- Write native Bitwarden notes verbatim, including whitespace, literal `---` and explicit empty clearing. Only the complete historical Monica footer is recognized on legacy reads; non-exportable reference-only items retain that recoverable metadata. A failed decryption cannot clear existing notes. Export no longer clamps valid unsigned 32-bit counters to `Int.MAX_VALUE`.

## Still open

User clarification on 2026-10-06: Android's always-zero signing counter is an intentional multi-device/offline-backup design and must remain unchanged in this repair batch. No counter increment/reservation or migration is authorized by the earlier general repair proposal. The first batch has not changed the signing counter. Imported credentials with previously accepted positive counters have a separate RP-compatibility risk: some relying parties may reject a transition to zero, while local increments cannot guarantee ordering across offline copies. Keep that limitation explicit and investigate before proposing a different policy. Backup-flag preservation, direct Microsoft/OneDrive account acceptance and the broader password project matrix remain unfinished requirements.

## Acceptance

Both frozen-source normal and F-Droid application/instrumentation builds passed. Each variant passed 24 focused tests, including UUID/Base64/Base64URL/Bitwarden ID byte preservation, malformed/unknown allow-lists, final platform request selection, authentication titles, exact notes and legacy footer handling. Mapper tests also roundtrip real RSA/EC keys and verify original-public-key signatures. The initial larger main selection retained one unrelated navigation-source assertion failure (27/28); this is not a claim that the full Android test suite passed.

Actual normal-app system evidence in `.tmp/android-passkey-fixes-317/system/` passed original RSA and ES256 signatures with count0 and genuine visible Cancel/system picker cancellation. Cancellation left credential rows/counts/usage unchanged. The original positive43 fixture was not authenticated in this repair batch and retained43/useCount0.

Additional acceptance in `.tmp/android-passkey-fixes-317/acceptance/` recovered the exact original 32-byte credential from a copy of the historical synthetic Edge registration profile. Its ID and private-key digest match the original failure evidence. A new isolated Vaultwarden account received the same credential through the extension provider. Android performed three production repository/update/upload/fresh-vault import cycles, preserving whitespace, CRLF, ordinary separators, incomplete marker text, explicit empty clearing and final Chinese notes. Every fresh record retained the same ID/key and zero counter. Instrumentation completed with `OK (1 test)` before the independent RP authentication.

The original32 credential then passed actual Android Credential Manager → system picker → real master-password field → native RP signature verification. The original registration public key verifies the signature, challenge, RP, native certificate origin, user handle and count0. A fresh Edge profile downloaded the Android-updated server record and performed two real WebAuthn logins, including a complete Edge restart; both signatures verify against the same original public key. No signing helpers/reflection or injected verification results were used in this batch.

For the unknown-ID request, a known usable credential existed at the same RP. Actual provider and platform logs report count0, EMPTY_RESPONSE and no Monica UI data. The picker offers only another device; dismissing this system sheet returns USER_CANCELED rather than NO_CREDENTIAL. `scripts/passkey-repair-evidence-317.mjs` requires the same-RP positive control, provider/platform evidence, both UI states, no signature and unchanged storage. It rejects the historical wrong-ID response, a canceled matching picker, nonempty provider results and changed storage. The old strict verifier/failing evidence is not relabeled as a pass.

Picker and authentication screenshots were inspected: they show account identity without the final private-note sentinel. Management remark-first titles remain unchanged. Current patched source files in both variants match the tested snapshots (16/16 files; `patch-source-current.json`).

The normal app was reused by exact SHA256 `8b781c3039e0c863cd56c6080ba65874889e1f941f49fe0cc95274616f174734`; only new instrumentation was built (77 seconds, SHA256 `9a1e419e2b196ac2628d5a4375aee07d88f89f05ef616e7e0115740f01648e8a`). New Edge prepare/return tests, strict TypeScript and the evidence reviewer passed. Actual device/browser acceptance uses the normal app; F-Droid evidence here is its build and focused tests.

The task-owned API35 AVD and isolated Vaultwarden were stopped after restoring package/provider/IME baselines. The physical device was untouched. Original profiles, synthetic databases, Docker volume, APKs/API jars, screenshots and failure evidence are retained. Cache cleanup is recorded separately in `acceptance/cache-cleanup.json`.

The earlier live-source build failed on an unrelated concurrently introduced test; a frozen retry hit path-sensitive KSP caches. Those failures remain recorded. Earlier platform recovery also exposed a provider cold-start timeout after a system_server crash. This acceptance's cold provider returned its valid candidate within approximately1.45seconds; this single success does not establish general performance or resolve the earlier finding. A Google Play Services startup exception was logged before this run's test; it did not abort this successful instrumentation/system flow. No biometric hardware, all-site/browser-origin, real Microsoft account or complete sync-conflict claim is made.
