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

The page never receives a vault list or provider credentials. The popup receives only match summaries. Password material is decrypted in the background after an explicit fill command and sent only to the selected tab.

## Vault envelope

- KDF: PBKDF2-HMAC-SHA256, 600,000 iterations, 32-byte random salt.
- Cipher: AES-256-GCM, 12-byte random IV and 128-bit authentication tag.
- Additional authenticated data: `monica-extension-vault-envelope-v1`.
- Persistent store: IndexedDB `monica-extension-secure-vault`.
- Session key: `chrome.storage.session`; refreshed by trusted operations and expired by the background alarm.

## Provider model

`ProviderAdapter` separates the encrypted cache from external sources:

- `local`
- `monica-webdav`
- `bitwarden`

Every item may contain multiple provider references and revisions. Mutations are queued per provider so WebDAV snapshots and Bitwarden ciphers can be retried independently.

## Planned WebDAV compatibility

The WebDAV adapter will read and losslessly write Android backups under `Monica_Backups`:

- `monica_backup_*.zip`
- `monica_backup_*.enc.zip`
- `MONICA_ENC_V1` encrypted files using PBKDF2-SHA256 (100,000) and AES-256-GCM
- `folders/<category>/{passwords,authenticators,bank_cards,documents,billing_addresses,payment_accounts,notes,passkeys}`

Unknown ZIP entries must survive round trips.

## Passkey boundary

Browser-local and Bitwarden FIDO2 credentials may contain encrypted portable private-key material. Existing Android WebDAV backups contain only device-protected references for Android-local passkeys, so those entries remain metadata-only until Android adds an encrypted portable-key backup field.
