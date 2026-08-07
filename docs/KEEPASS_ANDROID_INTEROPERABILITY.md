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

This acceptance verifies format interoperability for the exercised structures. It does not make the Android repository writable and does not expose KDBX bytes, credentials, attachment plaintext, passkey private keys, or source records to Popup or content-script contexts.
