# Monica Extension Architecture

## Trust boundaries

```text
Manager / Popup (trusted extension pages)
                |
          runtime commands
                v
Background service worker ---- encrypted IndexedDB envelope
                |
       one selected fill payload
                v
Isolated content script ---- current page DOM
```

The page never receives a vault list or provider credentials. The popup receives only match summaries. Password/wallet material is decrypted in the background after an explicit fill command and sent only to the selected active tab and frame.

For framed login forms, the popup enumerates frames through `webNavigation`, asks each isolated content script only for field-presence metadata, and identifies the chosen frame by ID. Before filling, the background resolves that frame again and requires the selected login to match either the verified frame URL or top-level URL. TOTP is generated in the background at click time and only the current code is sent to the selected frame.

## Vault envelope

- KDF: Argon2id v1.3, 64 MiB memory, 3 iterations, parallelism 1 and a 32-byte random salt. Legacy PBKDF2-HMAC-SHA256 envelopes remain readable and are re-encrypted with Argon2id after a successful unlock/restore.
- Cipher: AES-256-GCM, 12-byte random IV and 128-bit authentication tag.
- Additional authenticated data: `monica-extension-vault-envelope-v1`.
- Persistent store: IndexedDB `monica-extension-secure-vault`.
- Session key: `chrome.storage.session`; refreshed by trusted operations and expired by the background alarm.
- Master-password rotation verifies the current envelope, derives a new key with a fresh random salt, writes the new envelope, then replaces the session key.
- Encrypted full backups wrap the authenticated envelope with a versioned backup marker. Restore authenticates and validates the entire candidate before one atomic replacement write; replacing an existing vault also verifies its current master password.

Vault operations share a failure-tolerant exclusive queue so concurrent background requests cannot perform read-modify-write against the same old envelope. IndexedDB storage resolves writes and deletes only after `transaction.oncomplete`, not merely after the individual request succeeds. Plain item imports are normalized first and committed as one encrypted state transition.

## Provider model

`ProviderAdapter` separates the encrypted cache from external sources:

- `local`
- `monica-webdav`
- `bitwarden`

Every item may contain multiple provider references and revisions. Provider credentials, backup passwords, revisions, and cached items are all stored inside the encrypted vault envelope.

## WebDAV compatibility

The WebDAV adapter reads and losslessly writes Android backups under `Monica_Backups`:

- `monica_backup_*.zip`
- `monica_backup_*.enc.zip`
- `MONICA_ENC_V1` encrypted files using PBKDF2-SHA256 (100,000) and AES-256-GCM
- `folders/<category>/{passwords,authenticators,bank_cards,documents,billing_addresses,payment_accounts,notes,passkeys}`

Unknown ZIP entries must survive round trips.

WebDAV is treated as a timestamped snapshot source rather than a record API. The adapter records the last filename, ETag, and per-item revision; a later sync performs a three-way comparison. Browser-only changes produce a new snapshot, Android-only changes are imported, and concurrent changes are reported without uploading. A final latest-file check narrows the race window immediately before `PUT`.

## Bitwarden compatibility

- Official US/EU endpoints and same-origin `/identity` + `/api` self-hosted endpoints.
- PBKDF2-HMAC-SHA256 through Web Crypto for legacy vault/Bitwarden/Android compatibility; Argon2id v1.3 through bundled `hash-wasm` with independent Python vectors.
- Type 2 AES-256-CBC + HMAC-SHA256 CipherStrings with MAC-before-decrypt and independent vectors.
- Password login, explicit authenticator/email/YubiKey-code 2FA continuation, refresh token rotation, personal Cipher sync and CRUD.
- Revision-based concurrent edit detection and empty-vault deletion protection.
- Organization keys are unwrapped from the sync profile with the user's encrypted PKCS#8 RSA private key. RSA-OAEP SHA-1/SHA-256 CipherStrings are bounded and validated before decryption.

The Bitwarden master password is ephemeral. The derived user Vault Key, access/refresh tokens, and decrypted provider cache are persisted only as fields inside Monica's AES-GCM envelope. Personal Ciphers use the user Vault Key; shared Ciphers use their organization key, followed by an optional per-Cipher key. Updates preserve organization and collection ownership. A missing or malformed organization key fails closed for only that organization and retains any local baseline.

## Passkey boundary

The document-start MAIN-world bridge serializes WebAuthn requests, while the isolated content script owns confirmation UI. The background validates HTTPS origin/RP ID, creates ES256 `none` attestation objects, stores PKCS#8 only in the encrypted vault, and returns signed assertions. No private key crosses into a content script or page.

Browser-local and Bitwarden FIDO2 credentials with portable base64 PKCS#8 material can sign. When Bitwarden is the default save target, registration creates a personal login Cipher containing the encrypted FIDO2 credential. Counter updates and individual credential deletion are merged into that parent Cipher in one update, preserving its login fields and sibling credentials. Existing Android WebDAV backups contain only device-protected references for Android-local passkeys, so those entries remain metadata-only until Android adds an encrypted portable-key backup field.

## Mutation and conflict lifecycle

External create/update/delete operations are recorded in the encrypted `mutationQueue`. Provider sync clears its queue on success; failures retain an error and cap the attempt counter at five. The manager shows pending/failed counts and exposes explicit retry. Provider adapters still perform revision/ETag conflict checks before remote writes.
