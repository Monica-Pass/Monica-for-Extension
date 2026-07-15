# Security Architecture and Threat Model

## Security claim

Monica Extension is designed so that vault plaintext and private keys are available only while the user has explicitly unlocked the extension. Web pages do not receive vault listings or provider credentials. Autofill and Passkey operations require an extension-controlled user decision and are bound to the requesting page context.

This is an engineering security claim, not a claim of formal verification. The repository has automated security gates but has not yet completed an independent third-party audit. See **Assurance status** below.

## Protected assets

- master-password-derived vault key;
- login passwords, TOTP secrets, cards, identities, addresses and payment data;
- browser-local Passkey private keys;
- WebDAV passwords and Android backup passwords;
- Bitwarden access/refresh tokens and decrypted account keys;
- encrypted vault backups and provider conflict snapshots;
- fill/save/Passkey request context and diagnostic metadata.

## Trust boundaries

| Component | Trust level | May receive |
| --- | --- | --- |
| Extension manager/popup | Trusted UI | User-selected vault data and management operations |
| Background service worker | Trusted cryptographic boundary | Unlocked vault state, provider secrets and private keys |
| Isolated-world content script | Restricted extension code | Field metadata and one explicitly selected fill payload |
| Main-world Passkey bridge | Hostile page boundary | Public WebAuthn request/result messages only |
| Web page and frames | Untrusted | No vault listing, provider credential, TOTP seed or private key |
| WebDAV/Bitwarden server | Untrusted remote peer | Protocol-required requests; encrypted backup bytes where configured |
| Browser profile/OS | Platform trust | Encrypted vault and short-lived trusted session material |
| Build dependencies/CI | Supply-chain boundary | Source and test fixtures, never production user secrets |

## Security invariants

1. Full-vault and provider commands require an extension-page sender.
2. Page-originated save and Passkey requests are bound to the sender's tab, frame and origin and expire.
3. Password, card, identity, payment and TOTP values are sent to content scripts only after explicit selection.
4. Android `privateKeyAlias` is metadata, never treated as browser signing material.
5. Browser PKCS#8 Passkey keys remain inside the encrypted vault and are never serialized into Android backups.
6. Provider diagnostics contain classifications and redacted identifiers, not response bodies, credentials or tokens.
7. No remote JavaScript, source maps, fixture secrets or plaintext vault snapshots ship in the release.
8. Provider data and backup archives are untrusted inputs and must pass size, origin, path and format limits.
9. WebDAV credentials must not cross an insecure transport, redirect, origin boundary or attacker-controlled path boundary.
10. Release artifacts must be reproducible from the committed lockfile and accompanied by verifiable inventory and dependency evidence.

## Threat analysis

| Threat | Primary controls | Residual risk/status |
| --- | --- | --- |
| Website asks for entire vault | Background sender authorization; no external messaging API | Automated boundary tests required for every new message type |
| Website spoofs save/fill/Passkey response | Tab/frame/origin binding, RP-ID validation, expiration, explicit accept | Compromised browser/extension process is out of scope |
| Malicious WebDAV leaks Basic credentials | HTTPS-only URL policy, no redirects, same-origin/out-of-folder rejection | Loopback HTTP is permitted for local development only |
| Malicious WebDAV exhausts memory | Content-Length and streaming caps; ZIP central-directory preflight; entry/ratio/JSON caps | Valid very large backup may require an explicit future migration path |
| ZIP path traversal or archive confusion | Canonical safe-entry validation; ZIP64/multi-disk rejection; post-unzip size verification | Unknown safe entries remain opaque for Android compatibility |
| Offline vault cracking | PBKDF2-SHA256 600,000 iterations, 32-byte random salt, AES-256-GCM | Master-password strength remains user-dependent; memory-hard KDF migration is desirable |
| Android backup cracking | Android-compatible PBKDF2-SHA256 100,000 and AES-256-GCM | Iteration count is format-controlled; recommend a strong independent backup password |
| Secret leakage in build/logs | Redacted provider errors, fixture-token scan, no source maps, package inventory verification | Independent secret scanning and audit are still required |
| Dependency compromise | Lockfile, `npm ci`, production audit, CodeQL, dependency review, SBOM and Dependabot | Registry and CI platform remain supply-chain trust anchors |
| Malicious extension update | Store/repository release governance and reproducible package evidence | Store signing/account security are external operational controls |

## Permission rationale

| Permission | Reason | Reduction strategy |
| --- | --- | --- |
| `storage` | Encrypted vault envelope and trusted session state | Never store vault plaintext in `localStorage`/`sessionStorage` |
| `alarms` | Auto-lock checks | Clear pending sensitive operations when locked |
| `webNavigation` | Cross-frame matching and safe explicit filling | Do not use browsing history for analytics |
| HTTP/HTTPS host access | Password-manager field detection, explicit filling and user-configured providers | No remote code; content script receives minimum data; provider URL confinement |
| Main-world script | WebAuthn API bridge | Public WebAuthn messages only; no vault or provider access |

Broad site access is intrinsic to cross-site autofill. Removing it would materially remove the password-manager function, so the compensating control is strict background authorization and minimal page payloads.

For private repositories without GitHub Advanced Security, CodeQL still runs the `security-extended` suite and retains its SARIF as a workflow artifact for review. GitHub blocks publication to the Security tab in that configuration; publication switches on automatically when the repository is public or Advanced Security is enabled. OpenSSF Scorecard likewise runs only after the repository is public.

## Cryptography

- Vault: AES-256-GCM with 128-bit tag and fixed versioned AAD.
- Vault KDF: PBKDF2-HMAC-SHA256, 600,000 iterations by default, 32-byte salt.
- Android backup: AES-256-GCM with Android's `MONICA_ENC_V1` envelope and PBKDF2-HMAC-SHA256 at 100,000 iterations.
- Randomness: Web Crypto random values.
- Passkeys: ES256 browser-local credentials; Android aliases are non-exportable metadata.

Cryptographic primitives use platform Web Crypto. Monica does not implement AES, GCM, PBKDF2 or ECDSA primitives itself.

## Data lifecycle

- At rest: one authenticated encrypted vault envelope in extension storage.
- Unlocked: plaintext exists in the trusted background process memory.
- Session continuity: only trusted extension contexts may access session key material.
- Lock: cached vault state, pending captures, pending Passkey requests and provider synchronization are cleared/cancelled.
- Export: vault exports are authenticated encrypted envelopes; Android WebDAV backups preserve the source encryption mode/configuration.
- Diagnostics: response bodies and credentials are excluded; identifiers are redacted before export.

## Assurance status

Automated evidence currently includes unit tests, security-boundary tests, Chromium MV3 end-to-end tests, production dependency audit, release secret/source-map scan and deterministic package verification.

Not yet complete:

- independent third-party source review and penetration test;
- published SBOM and signed provenance/attestation;
- formal browser-store operational controls and maintainer account-security evidence;
- formal verification of the cryptographic state machine.

These limitations must remain visible until evidence exists. Security issues should be reported according to [SECURITY.md](../SECURITY.md).
