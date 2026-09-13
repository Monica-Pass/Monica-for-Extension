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

## Modular vault home

`VaultHome.vue` composes six independently visible, ordered sections: quick-access cards, favorites, types, source-qualified folders, databases, and archive/trash. It reuses the manager's existing list, detail, editing and pagination flows. First use shows all sources; subsequent sessions default to the last explicitly selected homepage scope. Users can instead choose all sources or a fixed source for startup. Restore happens once per unlock/page session, preserving temporary in-page selections; missing sources fall back to all with an inline notice. The databases section always keeps all sources available.

The overview follows Android's section hierarchy with a bounded two-column desktop grid and sequential sections in narrow containers. Types and folders use grouped rows; archive/trash use a compact navigation group. `collapsedModules` defaults to databases and is independent of module visibility. The legacy `favoritesExpanded` preference remains authoritative for favorites. A collapsed database header still shows a sanitized attention count. Native modal dialogs isolate layout/card drafts from background controls, scroll their content and retain visible save/cancel actions. Escape and completion restore focus to the trigger.

`home-catalog.ts` makes one pass through active records, normalizes both literal and provider-UUID local references, deduplicates source references, and keys folders by source, folder system and native identifier. Archived/deleted records never enter active counts. Folder identities retain KeePass group IDs, MDBX folder IDs, remote folder IDs, or Android category IDs/names. The manager carries structured source/folder/kind filters into existing lists and clears these navigation filters when the user chooses a different sidebar section.

`settings.home` lives inside the existing AES-GCM envelope. `VAULT_HOME_GET` and `VAULT_HOME_SET` require an unlocked manager page; popup and website content worlds are denied. Normalization bounds pinned IDs to 24 and source IDs to 256 characters, validates density/startup mode and supplies missing modules for older layouts. SET accepts a partial preference object and merges it within the exclusive durable-write queue, preserving unrelated changes from other manager pages. Failed saves retain drafts and retryable scope memory. Late responses cannot repopulate an unmounted home component. Encrypted full backup/restore includes the preferences; provider record formats and Android interchange are unchanged.

Home preferences are device-specific. Android uses different module/source/pin identifiers in the JSON string `vaultOverviewConfig` inside `monica_config/page_adjustment_settings.json`. WebDAV exports preserve that ZIP entry byte for byte, including unknown settings; extension layout IDs are never substituted into it.

The home renderer mounts one front card, at most six favorite rows, six folders, six database rows, and eight picker results per page. `HomeCardManager.vue` owns a cancelable draft with at most 24 selected rows, pointer/keyboard ordering and explicit unavailable-pin cleanup. Its safe search index is computed once per data/language/scope change; type and source labels are reused across entries. Recommendations select six favorites/recent updates without sorting the full array or recording usage history. Compact/comfortable density changes spacing while maintaining 44px controls.

`HomeQuickActions.vue` reads the selected item again through the unlocked manager boundary before copying. OTP is generated only on an explicit click, with no homepage OTP clock or rendered code. Linked/standalone HOTP advances only after clipboard success through the existing consumer. Unmount/item changes cancel pending writes before clipboard dispatch. Inline status reports copy failure or a counter save failure. Summaries omit login URLs, passwords, OTP seeds, private keys and note contents.

`home-provider-status.ts` projects local/paused/pending/synced/conflict/error states from already available provider metadata, queues and conflict counts. It does not probe network connectivity or expose raw error strings. Review actions open the existing provider page, scroll to the matching source and focus its native heading. No remote image/font fetch, new dependency or native bridge was added; Rust remains in the existing MDBX2 Native Host. `scripts/home-performance-probe.mjs` measures isolated synthetic 10,000/50,000-record scenarios without changing import limits.

## Selective locked autofill

`settings.lockedAutofillItemIds` records per-login, device-local consent. `LockedAutofillCache` projects only active ordinary login usernames/passwords, summaries, URI rules and exclusion policies into a separate AES-GCM encrypted IndexedDB record with a non-exportable device key. A digest of the full current vault envelope binds the projection to the exact vault state. An interrupted write or failed refresh leaves a mismatched record unusable.

The background obtains a restricted autofill context while locked. Matching and fill commands retain HTTPS, active tab, frame/document, origin, URL and field-policy validation. The context version and lock state are rechecked at dispatch after asynchronous page inspection. General item reads, secret copy, OTP and Passkey commands still require unlocking. Grant editing is manager-only; item imports and external provider records cannot grant access, and full backup restoration clears grants.

## Interface and localization

`src/nothing.css` maps the existing accessible controls to flat monochrome surfaces. Bundled Doto, Space Grotesk and Space Mono fonts are served locally. System appearance is the default; light and dark modes can be selected explicitly.

`src/i18n/runtime.ts` owns the language preference in `chrome.storage.local`; `system` resolves the browser's ordered preferences, with English as the unsupported-language fallback. The Vue wrapper tracks the resolved locale separately, and content prompts update their labels in place. User data and protocol field names are not translated. Eight languages and their Chrome manifest metadata ship inside the extension. English remains an embedded fallback; the other six translated catalogs are loaded individually from packaged JSON files, retaining at most two additional catalogs per context. Content scripts initialize localization only when a save prompt or Passkey flow needs it. The manifest explicitly lists these static, non-executable resources with dynamic URLs for content-script access. A revision check prevents a delayed language load from overriding a newer selection.

## Rendering and resource lifetime

Manager lists mount at most 50 result rows per page; each popup section mounts at most 20. Filtering and search run against the complete snapshots before pagination. List snapshots use shallow Vue refs; state refreshes replace them. Page selection clamps after deletion and resets when filters change. A real action popup requests an intrinsic 390px document width, avoiding the circular relationship between a content-sized toolbar window and viewport-relative root width; standalone popup pages remain responsive.

Visible OTP cells share one document timer. Each display caches only its current code period (or HOTP counter), retries failed generation and recomputes when its parameters change. Hidden documents stop periodic work, HOTP does not subscribe to the timer, and copying requests the current code before writing. Unmounting removes subscribers and clears per-display cache and copy feedback timers.

Removing the session key clears manager list, editor, QR, provider and timeline snapshots and closes their dialogs. A refresh revision rejects older asynchronous item/provider responses. Registered derived arrays and maps are evaluated after clearing their inputs so Vue's lazy computed cache does not keep the previous snapshots alive. This releases application references; JavaScript does not offer guaranteed memory zeroization.

Content-script capture releases event listeners, observers and strong references for detached Shadow DOM roots, and reacquires them if their hosts are attached again. Generator, Secure Send and QR generation modules load on demand. Material Symbols uses a local static subset with 221 icons at the existing Nothing style axes; builds verify glyph inventory and font checksums. See [performance measurements and reproduction](PERFORMANCE.md).

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
