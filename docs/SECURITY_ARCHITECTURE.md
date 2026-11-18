# Security Architecture and Threat Model

## Security claim

Monica Extension mediates full-vault and private-key access through the trusted background service. Master-password mode requires unlocking; optional device-key mode can unlock automatically and relies on browser/OS profile protection. A user may grant individual password logins permission to fill while locked; only those usernames/passwords are retained in a separately encrypted, device-local cache. Web pages do not receive vault listings or provider credentials. Autofill and Passkey operations require an extension-controlled user decision and are bound to the requesting page context.

This is an engineering security claim, not a claim of formal verification. The repository has automated security gates but has not yet completed an independent third-party audit. See **Assurance status** below.

## Protected assets

- master-password-derived vault key;
- login passwords, TOTP secrets, cards, identities, addresses and payment data;
- browser-local Passkey private keys;
- WebDAV passwords and Android backup passwords;
- Bitwarden access/refresh tokens and decrypted account keys;
- Steam shared/identity secrets, SteamID64 and access/refresh tokens;
- encrypted vault backups and provider conflict snapshots;
- fill/save/Passkey request context and diagnostic metadata.

## Trust boundaries

| Component | Trust level | May receive |
| --- | --- | --- |
| Extension manager/popup | Trusted UI | User-selected vault data and management operations |
| Passkey verification window | Trusted extension page | One expiring request context and a freshly entered master password |
| Background service worker | Trusted cryptographic boundary | Unlocked vault state, provider secrets and private keys |
| Isolated-world content script | Restricted extension code | Field metadata and one explicitly selected fill payload |
| Main-world Passkey bridge | Hostile page boundary | Public WebAuthn request/result messages only |
| Web page and frames | Untrusted | No vault listing, provider credential, TOTP seed or private key |
| WebDAV/Bitwarden/Steam server | Untrusted remote peer | Protocol-required requests; encrypted backup bytes where configured |
| Browser profile/OS | Platform trust | Encrypted vault, persistent keys for device-key/locked-autofill modes, and trusted session material |
| Build dependencies/CI | Supply-chain boundary | Source and test fixtures, never production user secrets |

## Website icons

The manager and popup first read Chromium's local favicon cache using the `favicon` permission. The `_favicon` endpoint is not web-accessible. Cache misses may request only the selected website origin's `/favicon.ico`, without credentials, referrers or redirects; no third-party icon service is used. The website can observe this request and the client's IP address. Login URI userinfo, paths, queries and fragments are stripped before icon lookup. Non-web URIs and regex match rules do not become image requests. Wi-Fi, SSH and barcode records retain type icons.

Direct requests require HTTPS, a public suffix and the default port. IP literals, local/special-use names (including `.onion`), HTTP and other ports use browser cache only. This name-based restriction is not a DNS-resolution guarantee: a public domain can resolve to a private address, subject to the browser's network policy. Responses are capped at 256 KiB with a three-second timeout and validated as image data. Images are rendered through inert `<img>` elements, never as document markup. Lists load icons near the viewport with at most four lookups at once, deduplicate concurrent requests, and cancel obsolete work. The bounded in-memory cache is cleared with the vault view/session; it is not serialized into vaults, backups, sync data or extension storage.

## Security invariants

1. Full-vault and provider commands require an extension-page sender.
2. Page-originated save and Passkey requests are bound to the sender's tab, frame and origin and expire.
3. Password, card, identity, payment and TOTP values are sent to content scripts only after explicit selection.
4. Android device-bound key aliases remain metadata. A `privateKeyAlias` value is usable only if it passes portable PKCS#8 validation and the algorithm is supported.
5. Portable Passkey keys remain behind the unlocked encrypted vault/provider boundary. Android WebDAV transfer of portable keys requires the encrypted backup mode; ordinary ZIP backup handling does not enable it.
6. Provider diagnostics contain classifications and redacted identifiers, not response bodies, credentials or tokens.
7. No remote JavaScript, source maps, fixture secrets or plaintext vault snapshots ship in the release.
8. Provider data and backup archives are untrusted inputs and must pass size, origin, path and format limits.
9. WebDAV credentials must not cross an insecure transport, redirect, origin boundary or attacker-controlled path boundary.
10. Release artifacts must be reproducible from the committed lockfile and accompanied by verifiable inventory and dependency evidence.
11. Steam confirmation/login messages accept only an item ID and selected request identifiers; secrets and session tokens are loaded from the unlocked vault by the service worker.
12. Locked autofill grants are manager-only, opt-in and limited to active ordinary password logins. They never authorize OTP, custom fields, private keys, general vault reads or secret-copy APIs.
13. Grants live in extension settings, never in provider item fields. Imports cannot grant access, and restoring a portable full-vault backup clears all grants.
14. Passkey user verification requires a fresh master-password check in `passkey-verify.html` or a verified Windows Hello result. An unlocked device-key vault alone never sets the UV flag. Verification messages are extension-only; the page/content bridge never receives the password.
15. A verification request has a random single-use ID, an exact extension page URL, a top-level-frame check, an expiry and a five-attempt limit. Closing, aborting, locking or navigating cancels the request. Before signing, the background rechecks the original document and credential material.

## Threat analysis

| Threat | Primary controls | Residual risk/status |
| --- | --- | --- |
| Website asks for entire vault | Background sender authorization; no external messaging API | Automated boundary tests required for every new message type |
| Website spoofs save/fill/Passkey response | Tab/frame/origin binding, RP-ID validation, expiration, explicit accept | Compromised browser/extension process is out of scope |
| Malicious WebDAV leaks Basic credentials | HTTPS-only URL policy, no redirects, same-origin/out-of-folder rejection | Loopback HTTP is permitted for local development only |
| Malicious WebDAV exhausts memory | Content-Length and streaming caps; ZIP central-directory preflight; entry/ratio/JSON caps | Valid very large backup may require an explicit future migration path |
| ZIP path traversal or archive confusion | Canonical safe-entry validation; ZIP64/multi-disk rejection; post-unzip size verification | Unknown safe entries remain opaque for Android compatibility |
| Offline vault cracking | Master-password mode uses Argon2id v1.3 (64 MiB, 3 iterations, parallelism 1), a 32-byte random salt and AES-256-GCM; bounded legacy PBKDF2 read/migration | Optional device-key mode stores its random key in the browser profile and therefore relies on browser/OS profile protection |
| Android backup cracking | Android-compatible PBKDF2-SHA256 100,000 and AES-256-GCM | Iteration count is format-controlled; recommend a strong independent backup password |
| Secret leakage in build/logs | Redacted provider errors, TruffleHog, fixture-token scan, no source maps, package inventory verification | Native GitHub Secret Scanning is unavailable while this private plan lacks the feature; independent audit remains required |
| Dependency compromise | Official-registry lockfile integrity, install scripts disabled by default, `npm ci`, production audit, CodeQL, dependency review, SBOM and Dependabot alerts | Registry and CI platform remain supply-chain trust anchors; npm registry signature-key availability is external |
| Malicious extension update | Action allowlist, platform SHA pinning, web commit sign-off and reproducible package evidence | Branch protection, signed commit/tag chain, store signing and maintainer account security remain external/plan-dependent controls |
| Steam token or confirmation misuse | Trusted-extension sender checks, unlocked-vault lookup by item ID, Android-compatible HMAC/protobuf signing, temporary Steam cookies restored after each request | Steam private APIs may change; requests can still fail or require re-authentication |

## Permission rationale

| Permission | Reason | Reduction strategy |
| --- | --- | --- |
| `storage` | Encrypted vault envelope and trusted session state | Never store vault plaintext in `localStorage`/`sessionStorage` |
| `alarms` | Auto-lock checks | Clear pending sensitive operations when locked |
| `webNavigation` | Cross-frame matching and safe explicit filling | Do not use browsing history for analytics |
| `cookies` | Temporarily provide Steam Mobile Confirmation cookies for an explicit user operation | Touch only three `steamcommunity.com` mobile cookies and restore their prior values immediately |
| HTTP/HTTPS host access | Password-manager field detection, explicit filling and user-configured providers | No remote code; content script receives minimum data; provider URL confinement |
| Main-world script | WebAuthn API bridge | Public WebAuthn messages only; no vault or provider access |

Broad site access is intrinsic to cross-site autofill. Removing it would materially remove the password-manager function, so the compensating control is strict background authorization and minimal page payloads.

For private repositories without GitHub Advanced Security, CodeQL still runs the `security-extended` suite and retains its SARIF as a workflow artifact for review. GitHub blocks publication to the Security tab in that configuration; publication switches on automatically when the repository is public or Advanced Security is enabled. OpenSSF Scorecard likewise runs only after the repository is public.

Repository Actions are restricted to GitHub-owned actions plus the explicitly used TruffleHog and OpenSSF repositories. GitHub and the repository workflow verifier both require immutable commit SHAs. Dependabot vulnerability alerts and web commit sign-off are enabled. Current private-plan limits prevent Ruleset/main-branch protection and native Secret Scanning; current commits are also unsigned. These remain visible operational risks rather than being represented as completed controls.

## Cryptography

- Vault: AES-256-GCM with 128-bit tag and fixed versioned AAD.
- Vault protection: master-password mode uses Argon2id v1.3 with 64 MiB memory, 3 iterations, parallelism 1 and a 32-byte salt. Optional device-key mode uses a random 256-bit key stored in extension-origin IndexedDB (`monica-extension-device-keys`), inaccessible to page/content-script origins but still within the browser profile. It provides lower offline protection. Imported KDF parameters are bounded; legacy PBKDF2 envelopes migrate after successful unlock/restore.
- Android backup: AES-256-GCM with Android's `MONICA_ENC_V1` envelope and PBKDF2-HMAC-SHA256 at 100,000 iterations.
- Randomness: Web Crypto random values.
- Passkeys: independent and file-backed ES256 credentials sign with zero; live Bitwarden bindings follow its official zero/positive branches. Positive counters require a fresh sync, optimistic server revision check and confirmed durable write before signing. Usage statistics neither enqueue writes nor change file-provider fingerprints; interrupted prepared assertions cannot be returned as committed. Android device-bound aliases remain non-exportable metadata. Explicit backup flags are preserved. Neither zeroing nor freezing a historical positive counter resets the relying party's state; such independent copies may require re-registration.
- Steam Guard: HMAC-SHA1 30-second codes; confirmation hashes use HMAC-SHA1 and mobile login approval signatures use HMAC-SHA256, matching Monica Android.

AES-GCM, legacy PBKDF2 and ECDSA use platform Web Crypto. Argon2id uses the bundled `hash-wasm` implementation under the extension CSP; no cryptographic code is downloaded at runtime. Argon2id output is covered by an independent Python vector.

## Data lifecycle

- At rest: an authenticated encrypted vault envelope in IndexedDB. Device-key mode stores its random key in a separate extension-origin IndexedDB; master-password mode stores no derived key there. Opted-in logins have a separate authenticated encrypted projection described below.
- Legacy device-key storage: startup migrates all legacy `chrome.storage.local` key entries, including orphaned entries, and removes each legacy copy only after the IndexedDB transaction commits. Retry never overwrites an existing private copy from legacy storage. Key bytes and vault ciphertext remain unchanged. Old builds cannot read the new key location; direct downgrade of a migrated device-key profile is unsupported.
- Unlocked: plaintext exists in the trusted background process memory.
- Legacy unlock/restore: authentication completes with the bounded legacy KDF, then a fresh Argon2id envelope is committed before the new session key is used; a failed best-effort migration leaves the authenticated legacy envelope usable for retry.
- Session continuity: only trusted extension contexts may access session key material.
- Lock: full-vault session access, pending captures, pending Passkey requests and provider synchronization are cleared/cancelled. Explicitly granted username/password projections remain available for selected fills.
- Export: vault exports are authenticated encrypted envelopes; Android WebDAV backups preserve the source encryption mode/configuration.
- Diagnostics: response bodies are excluded; structured credentials, quoted secret fields and identifiers are redacted before export. Invalid decrypted JSON reports a generic parse error without source snippets. Text redaction is defense in depth, not permission to log arbitrary decrypted input.
- Plaintext buffers: vault encryption clears encoded plaintext bytes on success/failure; decryption clears plaintext bytes after parsing. JavaScript strings/objects and browser-managed copies cannot be guaranteed erased.

The current master-password policy accepts four characters for compatibility. This minimum is not a security recommendation: offline protection still depends on password entropy. Prefer a long, unique, randomly generated master password or a random multiword passphrase; Argon2id cannot compensate for a guessable password.

## Filling selected passwords while locked

`monica-extension-locked-autofill` contains a minimal encrypted projection of selected login identifiers, display summaries, username/password pairs, URI matching rules and autofill exclusions. A non-exportable AES-256-GCM CryptoKey is stored in the same extension-only IndexedDB. It cannot unlock the main vault. Notes, OTP seeds, custom fields, provider tokens and Passkey keys are excluded.

The record is bound to a SHA-256 digest of the complete current encrypted vault envelope. Mutations prepare a replacement projection before committing the vault. A failed preparation cannot enable a grant; ordinary vault writes can still succeed, but the old projection then fails its envelope binding. Deletion, archival, grant revocation, password changes, provider disabling and backup replacement cannot silently reuse a stale copy.

After asynchronous page inspection and OTP generation, the service rechecks the vault version and lock state immediately before dispatch. This rejects fills authorized before a lock or revocation. The exclusive queue is released after starting message delivery, so a stalled webpage cannot prevent the user from locking the vault.

This feature deliberately changes the protection of selected passwords: anyone using the browser profile can fill them while Monica is locked. The key being non-exportable does not protect against a compromised browser process or malicious extension update capable of asking Web Crypto to decrypt. The editor explains this tradeoff before opt-in. Disabling a grant is logical revocation, not a guarantee of forensic erasure from storage hardware or historical filesystem backups.

## Assurance status

Local unpacked builds use a staging directory and validate the browser engine provenance and all extension pages before replacing `dist` files. Manifest paths outside the staged output, missing declared resources and symbolic links are rejected before publication. File replacement failures attempt rollback and retain recovery copies if rollback also fails. This protects build output availability; it does not change browser permissions, installation records, vault encryption or storage. It is not a cross-file transaction or a power-loss guarantee. Regression coverage lives in `scripts/build-extension.test.mjs`.

Firefox 153+ preserves native document identity: sensitive operations query the current tab/frame first, compare its native `documentId`, and target delivery to that document. Firefox omits Chromium's `documentLifecycle`; explicit non-active values remain rejected, while Chromium still requires `active`. Origin, active-tab and secure-context checks remain enforced.

Firefox's private MDBX iframe lives only in the generated background page. Authorization binds the exact owned random-fragment URL, native document ID, runtime ID, absence of a tab, connected owned frame and official BACKGROUND context. The Firefox-only CSP allows same-extension framing; privileged pages remain absent from web-accessible resources. Normal visible tabs and forged ports are rejected. Chromium retains its offscreen path and stricter no-framing CSP. See [Firefox acceptance](verification/firefox-20261021.md).

Automated evidence currently includes unit tests, security-boundary tests, Chromium MV3 end-to-end tests, production dependency audit, release secret/source-map scan and deterministic package verification.

The [2026-10-10 extension security review](security-review-2026-10-10.md) records reproduced findings, fixes, actual Edge isolation/migration evidence, dependency results and the scope of this review. Historical CI/release controls above are not proof that every external repository setting was rechecked in that review.

Not yet complete:

- independent third-party source review and penetration test;
- public SBOM publication and a signed provenance/attestation chain;
- Ruleset/main-branch protection, signed commits/tags and maintainer account-security evidence;
- formal verification of the cryptographic state machine.

These limitations must remain visible until evidence exists. Security issues should be reported according to [SECURITY.md](../SECURITY.md).

## Export, clipboard and recovery hardening (2026-10-21)

The manager-only authenticated export operation verifies the current master password or bound Windows Hello identity on every plaintext/full-backup export. It captures the envelope, session and verifier binding before authentication and checks them again before producing data. Authentication and backup key derivation run outside the mutation queue so lock can cancel a pending request. The legacy runtime encrypted-export command is denied. The four-character minimum remains unchanged by user decision. An accessible manager can still reveal and copy individual fields; this is fresh authentication for export, not a new boundary against a compromised trusted extension page.

Clipboard expiry is optional and off by default. Only enabling it requests optional clipboardRead/clipboardWrite. Foreground copy passes a SHA-256 digest to the background, never clipboard plaintext. A session-storage deadline and alarm survive worker suspension and copying-page closure. The authenticated shared offscreen document compares current text, hashes it, reads again synchronously and clears only matching text. Revoked permission, browser exit, OS sleep and clipboard contention may prevent cleanup. Windows clipboard history, cloud clipboard and copies on other devices remain outside this guarantee. No permission is requested on installation solely for this feature.

IndexedDB stores the primary encrypted envelope and encrypted recovery history atomically. At most three modification-before checkpoints are retained, no more frequently than every 15 minutes, with total ciphertext capped at 64 MiB. Protection/KDF changes remove incompatible history. Quota failure retries without history to prioritize primary data. History can contain deleted data and previous passwords; it shares the browser profile and protection key, and is not an independent backup. Recovery export requires current authentication and reencrypts under a backup password. It does not automatically restore a damaged primary while locked or revert remote changes. Users can explicitly clear history.

The runtime build identifier hashes source, public assets, package/lock metadata and bundling configuration. Both UI and worker bundle the same generated identifier; startup and credential-bearing export/unlock checks reject a mismatch even if both versions are 0.1.48. This detects stale installation state and is not a signature or tamper-proof attestation. Runtime diagnostic reports use explicit fields, excluding raw errors, provider URLs, local paths, item content and device/binding identifiers.

## Incremental UI loading and sync telemetry (2026-11-12)

Authenticated login-summary queries can return a fixed 20-item page after filtering inside the existing vault read projection. Search includes only displayed title, username, URI and public credential labels, never passwords, notes or protected fields. Full-vault credential identities are computed before filtering. No additional plaintext index or persistent cache is created; the existing session/envelope validation and operation queue apply. Returned rows are isolated copies. Query strings, display labels, URL lengths and page numbers are bounded; optional exclusions accept at most 100 IDs of at most 512 characters and copy the input array. Legacy calls without query parameters retain their array response. Popup search responses additionally check query generation, refresh generation and unlocked state, including after rapid typing, locking and a replaced refresh. A blocked autofill website can still be searched; final fill authorization remains independent.

Popup current-site candidates can appear before Passkey, wallet and full-login summaries finish. Every publication checks its refresh generation and lock state; locking, reinitializing, switching frames or a failed refresh invalidates pending results. Final fill authorization still checks the target document/origin and vault authorization in the background. No new message or permission bypass is introduced. Explicit password copying reads only the selected item and rejects archived/deleted or non-login items; an empty wallet-kind selection returns no item data.

Ordinary Bitwarden sync diagnostics are redacted, bounded to the existing 100 entries and committed within the same encrypted transaction as the sync projection. They are not stored in plaintext or deferred to an unreliable worker timer. A failed projection commit cannot leave a success diagnostic behind. Reported duration covers preparation through adoption, excluding the containing encryption/storage commit. Failure diagnostics retain their separate persistence path. Prepared/attempted/committed mutation receipts and their crash-recovery barriers, source/lock checks, encrypted format and KDF parameters are unchanged.

## Bitwarden clean revision probes and operation keys (2026-11-18)

Only a normal `check-remote` operation can bypass full-state copies. The vault reads its authenticated snapshot under the existing exclusive gate and verifies the enabled account binding, session ID, queue/receipt/conflict/batch/removal barriers and clean provider revisions. An incomplete Steam attachment projection forces the original path. After the network read, the coordinator rechecks the session and snapshot epoch against the current authenticated envelope, and checks cancellation again. An unchanged result has an empty `items` array and `unchanged: true`; it is a no-op marker and must never be adopted as an empty remote vault. Cold/expired/unsupported remote baselines, changed revisions, rotating tokens or invalid proofs fall back to the normal durable flow. Prefetching does not commit a remote revision; any coordinator failure invalidates that account's remote baseline, including failure of local encrypted adoption after provider preparation. Scheduling uses copied account configuration and mutation routing instead of copied item bodies, without renewing inactivity or unlocking a vault.

Explicitly prepared Bitwarden key objects reuse non-exportable WebCrypto keys through weak ownership for their operation. AES encryption/decryption usages remain separate and HMAC verification still precedes AES decryption. Raw key bytes are checked against 32-byte snapshots before reuse; mutations/zeroing invalidate the cached imports and clear those snapshots. Imported keys are not put in a persistent store or remote snapshot, and weak ownership does not retain an otherwise unreachable operation key. This is not a promise of immediate JavaScript garbage collection or revocation of an already-running WebCrypto operation. Existing cancellation, account and lock checks govern publication.

Typed-array Base64 APIs are detected at runtime. Unsupported browsers use the original encoding and decoding path. Native decoding errors fall back to `atob` to preserve its validation and error behavior. The separate record storage and migration layer below governs local persistence and recovery.

## Record storage and migration

Portable backups and checkpoints retain the v1 format. In IndexedDB v2, the primary header authenticates KDF parameters, timestamp, size and a random vault ID. Its encrypted directory names fields and references encrypted pages of at most 64 random row handles. Each page or row replacement gets a fresh handle and random 96-bit AES-GCM IV. Associated data binds the role, vault and handle; values larger than 256 KiB use independently sealed parts bound to count and position. No titles, URLs, provider IDs or plaintext hashes are database keys. Record sizes, counts and access patterns are observable. Restoring an entire consistent snapshot is not detectable without a separate trusted counter.

After authentication, the service stages the unprojected legacy JSON, reads it from IndexedDB, and compares every field before activating it in a transaction fenced by the original primary and staged header. Failures before activation leave the old primary usable. After activation an invalid primary or missing referenced row never selects a checkpoint automatically. The prior envelope is a bounded encrypted checkpoint. A protection change drops old rows, staging and recovery data in the same transaction. This is logical removal, not a guarantee of physical disk erasure. IndexedDB schema version 2 prevents older version-1 clients from overwriting the migrated database. Backups retain separate password protection and can be imported without sharing a browser profile.

Every normal record write compares its original primary revision and commits the new boxes, directory and retirement of old handles together. Checkpoints periodically re-encode the previous state, so those writes can still cost a full-vault operation. Cold reads authenticate the entire directory. A live session can reuse an authenticated in-memory snapshot while its header matches and its session remains valid; offline changes to subordinate boxes will be detected at the next full verified read. Locking and expiry discard the cached index and decoded snapshot. See the [Edge measurements and migration checks](verification/record-vault-20261118.md).

## Provider merge snapshots

Bitwarden takes a copy of the merge inputs from the authenticated vault snapshot under the existing lock gate. The copy includes item data and the queue, receipts, conflicts and transfer or removal guards used by the coordinator. It leaves out stored source payloads, local attachment data and unrelated journals. The provider receives a separate mutable copy so its work cannot change the merge baseline or the cached vault. The merge compares that baseline with the current state to preserve edits made while the sync was in flight. Receipts and remote cache invalidation continue to guard commits and retries.

KeePass copies items and the mutation queue for reconciliation. It still reads the native entries and checks revisions. An exact content fingerprint match avoids normalization, while differing fingerprints follow the existing compatibility and conflict rules. Field references use the same resolver with an index built on demand. Writes that introduce or update a Passkey still check credential ownership. KDBX export and remote publication use the complete file and retain the existing authentication, encryption and write checks.
