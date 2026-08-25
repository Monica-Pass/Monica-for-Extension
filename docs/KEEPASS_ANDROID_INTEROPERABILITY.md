# KeePass Android interoperability

Monica Extension treats Monica Android's current Kotpass implementation as the KDBX compatibility authority. The automated acceptance command is:

```powershell
npm run test:keepass-interop
```

The test injects an external JVM test source directory into the read-only Android `:app` unit-test build. Android creates KDBX 4 fixtures containing protected fields, OTP parameters, unknown plugin fields, entry and group `CustomData`, timestamps, history, an attachment and binary-pool reference, nested groups, a future item type, and Monica plus KeePassDX passkey fields.

AES-256 and ChaCha20 fixtures follow this exchange:

```text
Android Kotpass creates KDBX
  -> extension preflight and unlock
  -> provider projection, history and attachment checks
  -> extension edits one shared login field
  -> extension exports the original KDBX version and cipher
  -> Android Kotpass decodes and verifies native structures
```

The Android repository revision and complete working-tree status are compared before and after compilation and execution. Generated encrypted files stay under the extension's ignored `.tmp` directory and are removed unless `MONICA_KEEPASS_INTEROP_KEEP=1` is set.

KDBX `Meta/Generator` identifies the application that last serialized the file. Android creates the input with `Monica Android interop`; `kdbxweb` intentionally serializes the edited output as `KdbxWeb`. The acceptance treats this one writer marker as an expected edit and requires the remaining database, group, entry, history, attachment, passkey, custom-data, and time metadata to survive.

## Cipher support

| Android KDBX cipher | Extension behavior |
|---|---|
| AES-256 | Open, edit, export, Android reread |
| ChaCha20 | Open, edit, export, Android reread |
| Twofish | Refuse before decryption with a controlled request to convert the database to AES-256 |

Twofish remains outside the browser implementation because `kdbxweb` has no audited Twofish engine. Reclassifying a Twofish failure as an incorrect password would be unsafe and misleading, so the outer KDBX header is inspected before password derivation.

## Browser Passkey support in KDBX

The extension treats passkey entries as first-class KDBX citizens, using the same dual format as Monica Android:

- **Read**: an entry carrying `MonicaPasskeyCredentialId`/`MonicaPasskeyData` (Monica payload wins) or the five `KPEX_PASSKEY_*` fields written by KeePassDX is projected into a usable browser credential when it contains an ES256 private key. Entries whose private key is an Android key alias stay metadata-only.
- **Create**: the WebAuthn bridge can save a newly registered passkey into a connected KDBX through the normal sync queue. The written entry carries both the Monica payload and the KeePassDX fields (`KPEX_PASSKEY_USERNAME`, `KPEX_PASSKEY_PRIVATE_KEY_PEM`, `KPEX_PASSKEY_CREDENTIAL_ID`, `KPEX_PASSKEY_USER_HANDLE`, `KPEX_PASSKEY_RELYING_PARTY`, backup flags), so KeePassDX and Monica Android read it natively.
- **Assert**: every browser assertion updates the stored `signCount`/`useCount` and syncs them back into the KDBX through the same field-patch path, preserving entry history and unknown fields.
- **Delete**: removing the vault item removes the KDBX entry through the sync queue.

The E2E acceptance is `tests/e2e/keepass-webdav.spec.ts` ("KeePass passkey saves into the KDBX and signs a later assertion"); codec-level round trips live in `src/providers/keepass/keepass-passkey-codec.test.ts`.

This acceptance verifies format interoperability for the exercised structures. It does not make the Android repository writable and does not expose KDBX bytes, credentials, attachment plaintext, passkey private keys, or source records to Popup or content-script contexts.
