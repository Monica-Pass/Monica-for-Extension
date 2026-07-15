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

Maintainers should acknowledge a valid report within seven days, coordinate a remediation and release timeline with the reporter, and credit the reporter if requested. This is a best-effort open-source response target, not a paid bug bounty or service-level agreement.

## Security boundaries

- Full vault reads, Provider credentials, tokens and Passkey private keys are restricted to trusted extension pages/background code.
- Content Scripts can scan fields and receive only a user-selected fill payload; they cannot list the vault.
- WebDAV and Bitwarden are user-selected external services. Reports about those services themselves should be sent to their operators unless Monica mishandles the protocol or data.
- Plain JSON exports and unencrypted WebDAV ZIP snapshots contain secrets by design and must be protected by the user.

General support and non-sensitive bugs belong in [GitHub Issues](https://github.com/Monica-Pass/Monica-for-Extension/issues).
