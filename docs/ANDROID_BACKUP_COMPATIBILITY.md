# Monica Android Backup Compatibility

This document defines the browser extension's compatibility contract with the current Monica Android WebDAV backup format.

## Authority

- Repository: `Monica-Pass/Monica`
- Audited local commit: `3666e6eb6619f8884ca330efba57c6a2b6096242`
- Backup writer/reader: `Monica for Android/app/src/main/java/takagi/ru/monica/utils/WebDavHelper.kt`
- Wallet codecs/models: `CardWalletDataCodec.kt` and `SecureItemModels.kt`
- Encryption: `EncryptionHelper.kt`
- Attachment formats: `AttachmentBackupCodec.kt` and `PortableAttachmentBackup.kt`

The extension treats data it does not edit as opaque Android-owned data. Compatibility does not depend on the provider-neutral extension model knowing every Android field.

## Feature Parity Matrix

The status vocabulary is intentionally strict:

- **Full**: the extension can create, read, edit, delete, and test the browser equivalent.
- **Data**: the extension can inspect or manage the portable record while retaining Android-only fields.
- **Preserved**: the Android payload remains byte-identical but has no browser equivalent.
- **Planned**: the browser equivalent is part of this compatibility epic and must not be described as complete yet.

| Android feature group | Browser status | Compatibility requirement | Acceptance evidence |
| --- | --- | --- | --- |
| Login/password records | Planned | Empty username/password, multiple URIs, SSO, custom fields, app metadata, bindings, archive/trash metadata | Model migration, URI matcher, autofill and save E2E |
| TOTP/HOTP/Steam/Yandex/mOTP | Full | Preserve every algorithm/type parameter and Steam metadata | OTP vectors and Android codec round trips |
| Steam network operations | Full | Login approvals, confirmations, inventory, market, devices and maFile metadata | Mocked Steam API E2E and boundary audit |
| Bank cards | Planned | Full `BankCardData`, custom fields and billing-address link | Codec field matrix and card autofill E2E |
| Documents/identities | Planned | Full `DocumentData`, aliases and custom fields | Codec field matrix and identity autofill E2E |
| Billing addresses | Planned | Full `BillingAddressData`, defaults and custom fields | Codec field matrix and address autofill E2E |
| Payment accounts | Planned | Full `PaymentAccountData`, embedded address and custom fields | Codec field matrix and payment autofill E2E |
| Secure notes | Planned | Content, tags, Markdown and image references | Editor and Android codec tests |
| Passkeys | Full | Browser/Bitwarden keys are usable; Android aliases remain metadata-only | WebAuthn E2E and source-mode tests |
| Password generator/history | Planned | Browser generator works; Android history entries remain portable | Generator unit tests and ZIP byte checks |
| Categories/favorites/order | Planned | Shared organization fields remain stable across edits | Migration and codec tests |
| Images and attachments | Data | Opaque encrypted blobs stay intact; portable metadata is visible | Binary ZIP entry equality tests |
| Wi-Fi records | Planned | Metadata can be viewed/edited without pretending to configure an OS network | Model/editor tests |
| SSH key records | Planned | Public/private OpenSSH fields remain encrypted and editable | Model/editor and content-boundary tests |
| Barcode records | Planned | Payload and format remain portable; browser can display/copy | Model/editor tests |
| Autofill blocked fields/targets | Preserved | Android package/field policies remain byte-identical | ZIP entry equality tests |
| Bitwarden personal/organization vaults | Full | Supported cipher types, folders, collections, FIDO2, 2FA and conflict safety | Provider unit/E2E suite |
| WebDAV backup/sync | Full | Encryption, ETag, cancellation, merge conflicts and unknown-entry retention | Provider unit/E2E suite |
| KeePass databases | Preserved | Metadata and KDBX bytes remain unchanged | Binary ZIP entry equality tests |
| MDBX projects | Preserved | Android database ownership metadata remains unchanged | Raw field preservation tests |
| OneDrive configuration | Preserved | Configuration remains Android-owned and is never exposed to content scripts | Sender-policy and ZIP tests |
| Android IME/permissions/launcher settings | Preserved | No false browser equivalent; configuration survives backup rewrites | Compatibility inventory test |
| Monica Plus/payment | Preserved | No entitlement or payment behavior is inferred by the extension | Compatibility inventory test |

The matrix is re-audited whenever the Android reference commit changes. A feature may move to **Full** only after its acceptance evidence runs in the release check.

## Golden Fixtures

`tests/fixtures/android/forward-compatible-record.json` is a sanitized file-based fixture containing a recognized record with future outer and nested fields plus an unknown binary entry. The larger current-shape fixture remains generated in `android-backup-codec.test.ts` so timestamps and binary payloads are deterministic. Together they cover current, legacy, malformed, encrypted, empty-password, duplicate-ID, and forward-compatible records.

## Container and Encryption

Android stores a ZIP directly or wraps the ZIP in this binary envelope:

| Offset | Value |
| --- | --- |
| `0..12` | UTF-8 `MONICA_ENC_V1` |
| next 32 bytes | PBKDF2 salt |
| next 12 bytes | AES-GCM IV |
| remainder | AES-256-GCM ciphertext and 128-bit tag |

The key is PBKDF2-HMAC-SHA256 with 100,000 iterations and a 256-bit output. Extension parameters match Android exactly.

## ZIP Entry Inventory

| Android entry | Meaning | Extension behavior |
| --- | --- | --- |
| `folders/<category>/passwords/password_<id>_<createdAt>.json` | Login/password record | Parsed for UI; field-scoped writes; unknown fields retained |
| `folders/<category>/authenticators/totp_<id>_<createdAt>.json` | TOTP/HOTP/Steam/Yandex/mOTP record | Common TOTP fields parsed; Android-only OTP fields retained |
| `folders/<category>/bank_cards/bank_card_<id>_<createdAt>.json` | Bank card | Common card fields parsed; richer card data retained |
| `folders/<category>/documents/document_<id>_<createdAt>.json` | Identity/document | Common identity fields parsed; richer document data retained |
| `folders/<category>/billing_addresses/billing_address_<id>_<createdAt>.json` | Billing address | Parsed for filling; extra data retained |
| `folders/<category>/payment_accounts/payment_account_<id>_<createdAt>.json` | Payment account | Parsed for filling; extra data retained |
| `folders/<category>/notes/note_<id>_<createdAt>.json` | Secure note | Content parsed; tags/Markdown metadata retained |
| `folders/<category>/passkeys/passkey_<credentialId>.json` | Android Passkey metadata and key alias | Metadata only; key alias and Android-only fields retained |
| `categories.json` | Category IDs, names, order | Opaque byte preservation |
| `Monica_<timestamp>_password.csv` | Compatibility password CSV | Opaque byte preservation |
| `password_history.json` | Prior passwords | Opaque byte preservation |
| `Monica_<timestamp>_generated_history.json` | Generator history | Opaque byte preservation |
| `steam/mafiles/*` | Steam Guard maFiles | Opaque byte preservation |
| `images/*` | Encrypted secure-item images | Opaque byte preservation |
| `password_icons/*` | Uploaded password icons | Opaque byte preservation |
| `timeline_history.json` | Operation timeline | Opaque byte preservation |
| `trash/trash_passwords.json` | Deleted passwords | Opaque byte preservation |
| `trash/trash_secure_items.json` | Deleted secure items | Opaque byte preservation |
| `monica_config/common_account.json` | Common fill identity/templates | Opaque byte preservation |
| `monica_config/webdav_connection.json` | Encrypted WebDAV settings | Opaque byte preservation; never exposed to content scripts |
| `monica_config/autofill_blocked_fields.json` | Android field denylist | Opaque byte preservation |
| `monica_config/autofill_save_blocked_targets.json` | Android save denylist | Opaque byte preservation |
| `monica_config/autofill_blacklist.json` | Android app blacklist | Opaque byte preservation |
| `monica_config/bitwarden_vaults.json` | Locked Bitwarden account metadata/tokens | Opaque byte preservation; never imported as extension credentials |
| `monica_config/page_adjustment_settings.json` | Android UI/preferences snapshot | Opaque byte preservation |
| `keepass/keepass_<id>_meta.json` and `.kdbx` | Local KeePass metadata and database | Opaque byte preservation |
| `attachments/attachments_meta.json` and `attachments/*.enc` | Same-device encrypted attachment backup | Manifest and blobs preserved byte-for-byte |
| `attachments_portable/attachments_portable.json` and `*.bin` | Cross-device attachment payloads inside an encrypted backup | Manifest and payloads preserved byte-for-byte |
| Any future or unknown entry | Forward-compatible Android data | Opaque byte preservation |

## Recognized Record Fields

All outer and nested fields not listed as editable remain in the original JSON object/string.

### Passwords

Android currently writes:

`id`, `title`, `username`, `password`, `website`, `notes`, `isFavorite`, `categoryId`, `categoryName`, `appPackageName`, `appName`, `email`, `phone`, `keepassDatabaseId`, `keepassGroupPath`, `bitwardenVaultId`, `bitwardenFolderId`, `createdAt`, `updatedAt`, `authenticatorKey`, `passkeyBindings`, `sshKeyData`, `loginType`, `ssoProvider`, `ssoRefEntryId`, `customIconType`, `customIconValue`, `customIconUpdatedAt`, `wifiMetadata`, and `customFields[]` (`title`, `value`, `isProtected`).

The extension edits the common login subset. App binding, personal fields, SSO/Wi-Fi/SSH metadata, icon metadata, ownership fields, and any future fields remain untouched.

### Secure-item outer object

TOTP, cards, documents, billing addresses, payment accounts, and notes share:

`id`, `itemType`, `title`, `itemData`, `notes`, `isFavorite`, `imagePaths`, `keepassDatabaseId`, `keepassGroupPath`, `bitwardenVaultId`, `bitwardenFolderId`, `createdAt`, `updatedAt`, and `categoryName`.

`itemData` is a JSON string. It must not be parsed and re-encoded unless a nested field actually changes.

### TOTP `itemData`

Current fields are `secret`, `issuer`, `accountName`, `period`, `digits`, `algorithm`, `otpType`, `counter`, `pin`, `link`, `associatedApp`, `customIconType`, `customIconValue`, `customIconUpdatedAt`, `boundPasswordId`, `categoryId`, `keepassDatabaseId`, and Steam metadata (`steamFingerprint`, `steamDeviceId`, `steamSerialNumber`, `steamSharedSecretBase64`, `steamRevocationCode`, `steamIdentitySecret`, `steamTokenGid`, `steamRawJson`).

Legacy `authenticatorKey` is accepted as the secret. The extension edits only the common TOTP subset and preserves OTP type, counter, PIN, binding, icon, and Steam fields.

### Bank-card `itemData`

Current fields are `cardNumber`, `cardholderName`, `expiryMonth`, `expiryYear`, `cvv`, `bankName`, `cardType`, `billingAddress`, `brand`, `nickname`, `validFromMonth`, `validFromYear`, `pin`, `iban`, `swiftBic`, `routingNumber`, `accountNumber`, `branchCode`, `currency`, `customerServicePhone`, and `customFields`.

Accepted legacy aliases include `number`, `expMonth`, `expYear`, `code`, `fromMonth`, and `fromYear`.

### Document `itemData`

Current fields are `documentType`, `documentNumber`, `fullName`, `issuedDate`, `expiryDate`, `issuedBy`, `nationality`, `additionalInfo`, `title`, `firstName`, `middleName`, `lastName`, `address1`, `address2`, `address3`, `city`, `stateProvince`, `postalCode`, `country`, `company`, `email`, `phone`, `ssn`, `username`, `passportNumber`, `licenseNumber`, and `customFields`.

Accepted legacy aliases include `type`, `number`, `issueDate`, `issuingAuthority`, `name`, `state`, and `driverLicense`.

### Billing-address `itemData`

Current fields are `fullName`, `company`, `streetAddress`, `apartment`, `city`, `stateProvince`, `postalCode`, `country`, `phone`, `email`, `isDefault`, and `customFields`.

Legacy aliases include `name`, `organization`, `address1`, `addressLine1`, `address2`, `addressLine2`, `state`, `province`, `region`, `zip`, `zipCode`, and `phoneNumber`.

### Payment-account `itemData`

Current fields are `paymentType`, `provider`, `accountName`, `accountHolderName`, `email`, `phone`, `username`, `accountId`, `maskedAccountNumber`, `linkedCardLast4`, `routingNumber`, `iban`, `swiftBic`, `billingAddress`, `website`, `currency`, `notes`, `isDefault`, and `customFields`.

Legacy aliases include `type`, `accountType`, `service`, `brand`, `network`, `name`, `nickname`, `title`, `holderName`, `fullName`, `nameOnAccount`, `phoneNumber`, `userName`, `login`, `accountIdentifier`, `id`, `maskedNumber`, `accountNumber`, `cardLast4`, `last4`, `swift`, `bic`, `url`, `uri`, and `memo`.

### Notes

Current `itemData` fields are `content`, `tags`, and `isMarkdown`. Only `content` is mapped into the extension model; tags and Markdown state remain untouched.

### Passkeys

Android currently writes `credentialId`, `rpId`, `rpName`, `userId`, `userName`, `userDisplayName`, `publicKeyAlgorithm`, `publicKey`, `privateKeyAlias`, `createdAt`, `lastUsedAt`, `useCount`, `iconUrl`, `isDiscoverable`, `isUserVerificationRequired`, `transports`, `aaguid`, `signCount`, `notes`, `boundPasswordId`, `passkeyMode`, and `categoryName`.

`privateKeyAlias` is an Android key reference, not PKCS#8 key material. The extension must preserve it but cannot use it for browser WebAuthn signing.

## Write Rules

1. If the provider-neutral item is unchanged, do not replace its ZIP entry bytes.
2. If an item changes, update only changed mapped fields.
3. Do not normalize, default, or change the JSON type of unrelated fields.
4. Preserve existing path, category directory, ID, and filename.
5. Keep unknown JSON members, nested members, arrays, `null` values, and legacy aliases.
6. Keep every unknown/binary ZIP entry intact.
7. New extension records use current canonical Android field names under `folders/_root/`.
8. Never claim an Android `privateKeyAlias` is a browser-usable Passkey private key.
