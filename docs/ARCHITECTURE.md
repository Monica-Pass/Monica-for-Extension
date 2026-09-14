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

The UI checks `RUNTIME_INFO` before its initial runtime requests and again before setup or unlock. It compares the version bundled into the UI and worker, plus a protocol version, rather than reading the installed manifest as evidence of which worker code is running. Concurrent UI reads share one check; there is no polling timer. An older worker, incompatible reply, or unsupported command produces `RUNTIME_RELOAD_REQUIRED`. The manager clears its view and hides authentication controls; the popup also clears the entered password and offers an explicit reload action. Reloading uses Chrome's extension lifecycle and preserves the existing extension identity and encrypted IndexedDB. The runtime switch is checked exhaustively by TypeScript so a newly declared command cannot silently be omitted from the handler.

## Vault envelope

- KDF: Argon2id v1.3, 64 MiB memory, 3 iterations, parallelism 1 and a 32-byte random salt. Legacy PBKDF2-HMAC-SHA256 envelopes remain readable and are re-encrypted with Argon2id after a successful unlock/restore.
- Cipher: AES-256-GCM, 12-byte random IV and 128-bit authentication tag.
- Additional authenticated data: `monica-extension-vault-envelope-v1`.
- Persistent store: IndexedDB `monica-extension-secure-vault`.
- Session key: `chrome.storage.session`; refreshed by trusted operations and expired by the background alarm.
- Master-password rotation verifies the current envelope, derives a new key with a fresh random salt, writes the new envelope, then replaces the session key.
- Encrypted full backups wrap the authenticated envelope with a versioned backup marker. Restore authenticates and validates the entire candidate before one atomic replacement write; replacing an existing vault also verifies its current master password.

Vault operations share a failure-tolerant exclusive queue so concurrent background requests cannot perform read-modify-write against the same old envelope. IndexedDB storage resolves writes and deletes only after `transaction.oncomplete`, not merely after the individual request succeeds. Plain item imports are normalized first and committed as one encrypted state transition.

## Vault navigation

The manager opens directly in the vault; the former overview renderer and its home-specific controls have been removed. Continuous result rows share source, folder, kind and favorite filters with the filter dialog. The source selector changes only the visible scope, never an item's database ownership. `home-catalog.ts` retains source-matching helpers used by these filters.

`CreateSplitButton.vue` uses native M3E split-button and menu components. Its primary action follows the current page and kind filter; its menu shares the eleven supported manual creation types with `CreateItemDialog.vue` through `manager/create-items.ts`. Passkeys are created by a website's WebAuthn flow. Menus close on navigation and restore focus before an editor opens. Browsers without Popover support use the full creation dialog.

Legacy `settings.home` values and their manager-only runtime commands remain readable inside the encrypted envelope for backup compatibility. They no longer mount a home screen. Android's `vaultOverviewConfig` in `monica_config/page_adjustment_settings.json` remains device-specific and is preserved byte for byte in WebDAV backups, including unknown fields.

## Selective locked autofill

`settings.lockedAutofillItemIds` records per-login, device-local consent. `LockedAutofillCache` projects only active ordinary login usernames/passwords, summaries, URI rules and exclusion policies into a separate AES-GCM encrypted IndexedDB record with a non-exportable device key. A digest of the full current vault envelope binds the projection to the exact vault state. An interrupted write or failed refresh leaves a mismatched record unusable.

The background obtains a restricted autofill context while locked. Matching and fill commands retain HTTPS, active tab, frame/document, origin, URL and field-policy validation. The context version and lock state are rechecked at dispatch after asynchronous page inspection. General item reads, secret copy, OTP and Passkey commands still require unlocking. Grant editing is manager-only; item imports and external provider records cannot grant access, and full backup restoration clears grants.

## Interface and localization

Material 3 Expressive defines shared typography, shapes, state layers and motion in `src/material.css`; `src/material-manager.css` loads after the manager's layout styles so shared CSS extraction cannot reverse the cascade. `src/nothing.css` supplies only an optional black/white/red palette. New installations default to Monica's teal palette; existing palette choices are preserved. Appearance follows the system by default, with explicit light and dark modes available. UI and data use system font stacks; no remote fonts are fetched.

Detail and edit views follow the information hierarchy of Monica Android. Main credentials, linked OTP and common actions precede optional parameters and custom fields. Headers and footer actions stay visible while content scrolls. Source metadata uses a side column on wide screens and moves below main content on narrow screens. Secret visibility and copy actions keep their existing service boundaries.

`src/i18n/runtime.ts` owns the language preference in `chrome.storage.local`; `system` resolves the browser's ordered preferences, with English as the unsupported-language fallback. The Vue wrapper tracks the resolved locale separately, and content prompts update their labels in place. User data and protocol field names are not translated. Eight languages and their Chrome manifest metadata ship inside the extension. English remains an embedded fallback; the other six translated catalogs are loaded individually from packaged JSON files, retaining at most two additional catalogs per context. Content scripts initialize localization only when a save prompt or Passkey flow needs it. The manifest explicitly lists these static, non-executable resources with dynamic URLs for content-script access. A revision check prevents a delayed language load from overriding a newer selection.

## Rendering and resource lifetime

Manager lists mount at most 50 result rows per page; each popup section mounts at most 20. Filtering and search run against the complete snapshots before pagination. List snapshots use shallow Vue refs; state refreshes replace them. Page selection clamps after deletion and resets when filters change. A real action popup requests an intrinsic 390px document width, avoiding the circular relationship between a content-sized toolbar window and viewport-relative root width; standalone popup pages remain responsive.

Visible OTP cells share one document timer. Each display caches only its current code period (or HOTP counter), retries failed generation and recomputes when its parameters change. Hidden documents stop periodic work, HOTP does not subscribe to the timer, and copying requests the current code before writing. Unmounting removes subscribers and clears per-display cache and copy feedback timers.

Removing the session key clears manager list, editor, QR, provider and timeline snapshots and closes their dialogs. A refresh revision rejects older asynchronous item/provider responses. Registered derived arrays and maps are evaluated after clearing their inputs so Vue's lazy computed cache does not keep the previous snapshots alive. This releases application references; JavaScript does not offer guaranteed memory zeroization.

Content-script capture releases event listeners, observers and strong references for detached Shadow DOM roots, and reacquires them if their hosts are attached again. Generator, Secure Send and QR generation modules load on demand. Material Symbols uses a 23,948-byte local subset covering 225 glyph names, with weight 400, optical size 24 and the fill axis retained for selected states. Builds verify glyph inventory and font checksums. See [performance measurements and reproduction](PERFORMANCE.md).

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

Android authenticator relationships are reverse references (`TotpItem.boundPasswordId`); the extension edits `LoginItem.boundTotpItemId`. Before serialization, explicit link edits update the matching companion authenticators and their timestamps. A missing forward field retains legacy lookup; an empty string records an explicit unlink and survives extension JSON import and encrypted persistence. New links, replacements and unlinks are validated before companion records are modified. Missing targets, duplicate numeric login IDs and multiple login owners of one authenticator are rejected rather than silently flattened. Encrypted snapshot tests cover repeated synchronization, counter preservation, caller immutability and byte-preserved Android display settings.

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

Browser-local and Bitwarden FIDO2 credentials with portable base64 PKCS#8 material can sign. When Bitwarden is the default save target, registration creates a personal login Cipher containing the encrypted FIDO2 credential. Counter updates and individual credential deletion are merged into that parent Cipher in one update, preserving its login fields and sibling credentials. Android WebDAV entries containing only device-protected references remain metadata-only; supported portable PKCS#8 material is imported and written only through an encrypted backup boundary.

## Mutation and conflict lifecycle

External create/update/delete operations are recorded in the encrypted `mutationQueue`. Provider sync clears its queue on success; failures retain an error and cap the attempt counter at five. The manager shows pending/failed counts and exposes explicit retry. Provider adapters still perform revision/ETag conflict checks before remote writes.
