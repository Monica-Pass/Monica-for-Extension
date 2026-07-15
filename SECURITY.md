# Security Policy

## Supported versions

Security fixes are applied to the latest commit on the `main` branch and the latest published extension release. Older development snapshots are not supported.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/Monica-Pass/Monica-for-Extension/security/advisories/new). Do not open a public issue containing passwords, tokens, private keys, proof-of-concept secrets or unpatched vulnerability details.

Include, when possible:

- affected commit or extension version;
- Chrome/Edge version and operating system;
- reproduction steps and expected security boundary;
- impact, affected data and whether user interaction is required;
- a minimal proof of concept with all real secrets removed.

Maintainers target acknowledgement within 72 hours, an initial severity assessment within seven days, and coordinated disclosure after a fix is available. Critical issues that expose vault plaintext, provider tokens or private keys receive release priority. These are best-effort open-source targets, not a paid service-level agreement.

Please allow up to 90 days for coordinated remediation before public disclosure unless active exploitation or an immediate user-safety need requires a shorter timeline. Maintainers will credit reporters who request attribution.

## Research safe harbor

Good-faith research that follows this policy, avoids privacy violations and service disruption, uses only accounts/data the researcher controls, and provides reasonable time to remediate is considered authorized by the project maintainers. The project will not recommend legal action solely for accidental, good-faith violations that are promptly reported and stopped.

This safe harbor cannot authorize testing against third-party WebDAV/Bitwarden services, browser stores, GitHub, or infrastructure the Monica project does not own.

## Security boundaries

- Full vault reads, Provider credentials, tokens and Passkey private keys are restricted to trusted extension pages/background code.
- Content Scripts can scan fields and receive only a user-selected fill payload; they cannot list the vault.
- WebDAV and Bitwarden are user-selected external services. Reports about those services themselves should be sent to their operators unless Monica mishandles the protocol or data.
- Plain JSON exports contain secrets by design and require an explicit user export action. Newly saved WebDAV providers require an Android backup encryption password.

## In scope

- vault encryption, lock/session lifecycle and backup/restore integrity;
- extension-page, content-script, main-world and background message boundaries;
- autofill, password-save and Passkey origin/RP validation;
- WebDAV and Bitwarden credential handling, parsing and synchronization;
- release packages, SBOM/license inventory, build workflows and secret leakage;
- denial of service caused by provider responses or backup archives within realistic browser limits.

Reports about social engineering without a Monica control bypass, unavailable third-party services, theoretical attacks requiring an already-compromised OS/browser profile, and automated scanner output without a reproducible impact may be closed as out of scope.

## Release verification

Official source builds use the exact Node/npm versions in `package.json`, a locked dependency install, immutable GitHub Action SHAs, security tests and deterministic packaging. Release ZIPs include:

- `RELEASE-METADATA.json` with per-file SHA-256 inventory;
- `SBOM.cdx.json`;
- `THIRD-PARTY-LICENSES.json`;
- `SECURITY-EVIDENCE.json`;
- an external `.sha256` checksum and GitHub build-provenance attestation for push builds.

Run `npm run release:check` from a clean tracked worktree to reproduce and verify the package.

The full engineering threat model is in [`docs/SECURITY_ARCHITECTURE.md`](docs/SECURITY_ARCHITECTURE.md). Independent third-party audit completion will be reported there only after an actual report exists.

General support and non-sensitive bugs belong in [GitHub Issues](https://github.com/Monica-Pass/Monica-for-Extension/issues).
