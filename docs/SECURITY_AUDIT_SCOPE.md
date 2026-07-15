# Independent Security Audit Scope

## Status

Audit packet prepared. An independent third-party audit has not yet been commissioned or completed.

## Target

- Repository: `Monica-Pass/Monica-for-Extension`
- Branch: `main`
- Runtime: Chromium Manifest V3 extension
- Primary languages: TypeScript, Vue, JavaScript
- Cryptographic platform: Web Crypto
- External protocols: Monica Android WebDAV backup format and Bitwarden API

The auditor must record the exact commit SHA reviewed. Findings against another commit do not prove the current release is audited.

## Required review areas

1. Vault KDF/envelope construction, authenticated decryption, restore and password rotation.
2. Session-key persistence, auto-lock behavior, service-worker restart behavior and renderer exposure.
3. Runtime message authorization across extension pages, content scripts, frames and the main-world Passkey bridge.
4. Credential capture, explicit fill, origin matching, iframe handling and navigation/race behavior.
5. WebAuthn RP-ID validation, request/result binding, counter updates and private-key storage/export boundaries.
6. WebDAV Basic Auth transport, URL confinement, redirects, XML parsing, encrypted envelope handling and ZIP safety.
7. Bitwarden authentication/KDF bounds, token refresh, URL policy, response limits, cipher mappings and Passkey handling.
8. Untrusted import/provider data validation, prototype pollution, parser confusion, memory exhaustion and persistence abuse.
9. Manifest permissions, CSP, web-accessible resources, remote-code prohibition and extension fingerprinting.
10. Build/CI dependency integrity, immutable actions, release reproducibility, SBOM/license accuracy and secret leakage.

## Required attack testing

- malicious/cross-origin frames and same-tab navigation races;
- spoofed runtime and `window.postMessage` payloads;
- insecure HTTP targets, redirect chains, DNS/origin confusion and hostile WebDAV hrefs;
- oversized/streaming responses, ZIP bombs, duplicate/confusable entries, unsafe paths and malformed encryption envelopes;
- corrupted vault envelopes, KDF parameter abuse and atomicity failures;
- malicious Bitwarden cipher fields and attachment/Passkey edge cases;
- release artifact tampering and dependency/action substitution.

## Deliverables

- executive summary suitable for public release;
- methodology, reviewed commit and tool versions;
- finding list with severity, CWE where applicable, reproduction, impact and remediation;
- explicit statement of untested/out-of-scope surfaces;
- retest letter confirming resolution of critical/high findings;
- permission to publish at least the executive summary and retest status.

## Acceptance criteria

The project may claim an independently audited release only when:

- the report identifies a commit at or before the release commit;
- every critical/high finding is fixed and independently retested;
- unresolved medium/low findings are documented with rationale and timeline;
- the public security architecture links the report or public summary;
- release provenance and package hash correspond to the audited lineage.

## Auditor independence

The reviewer must not be the author of the implementation under review. Automated scanners and AI-only review can supplement but cannot replace the independent human audit required by this scope.
