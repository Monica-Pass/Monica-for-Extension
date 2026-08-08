# MDBX2 Android and browser interoperability acceptance

Run from the extension repository on Windows:

```powershell
npm run test:mdbx2-android-interop
```

The acceptance test uses the sibling `Monica-main` repository by default. Override it with `MONICA_ANDROID_REPOSITORY` when needed. It compiles an additional instrumentation source through `tests/interop/android-mdbx2/interop.init.gradle`; Android tracked and untracked source state is compared before and after the build.

The runner creates a dedicated loopback ADB server so Android Studio's global port 5037 cannot interrupt acceptance. It starts `Pixel_Fold_API_35` in read-only headless mode when no Android device is connected, installs the generated `mdbx-engine` test APK, and performs this exchange:

```text
Android UniFFI vault
  -> portable MDBX2 bootstrap + authenticated segment + encrypted Blob
  -> live local WebDAV
  -> browser Native Host
  -> browser object + external attachment segment
  -> Android apply and return segment
  -> restarted browser Native Host
```

It verifies MDBX2-only opening, the Android remote object names, Basic authentication, WebDAV Multi-Status parsing, `If-None-Match: *`, immutable-byte preservation, Host restart recovery, Object payloads, attachment plaintext and encrypted Blob transfer in both directions.

Set `MONICA_MDBX2_INTEROP_KEEP=1` to retain temporary evidence under `.tmp/mdbx2-android-interop`. Set `MONICA_MDBX2_INTEROP_AVD` to select another installed AVD. By default the runner starts a dedicated read-only emulator and leaves other connected devices untouched; set `MONICA_MDBX2_INTEROP_SERIAL` to authorize a specific connected device. `MONICA_MDBX2_INTEROP_ADB_SERVER_PORT` can select an existing isolated ADB service or a fixed free port; services created by the runner are closed during cleanup.

## KeePass Android and browser interoperability acceptance

Run from the extension repository:

```powershell
npm run test:keepass-interop
```

The runner injects one JVM unit-test source directory into the sibling Android `:app` project without changing Android files. Android Kotpass creates KDBX 4 fixtures using AES-256, ChaCha20, and Twofish. The extension opens and edits the AES-256 and ChaCha20 fixtures, preserves native fields and metadata, exports them, and Android Kotpass reads the exported files again. The Twofish fixture must fail before decryption with the controlled conversion guidance.

The Android repository revision and complete `git status --porcelain=v1 -uall` value are checked before and after the run. Set `MONICA_ANDROID_REPOSITORY` to select another read-only Android checkout. Set `MONICA_KEEPASS_INTEROP_KEEP=1` to retain encrypted fixture evidence under `.tmp/keepass-android-interop`.

## Bitwarden and Vaultwarden server-contract acceptance

Run from the extension repository:

```powershell
npm run test:bitwarden-interop
```

The runner uses two stateful, secret-free recorded server profiles. The official profile uses PascalCase sync data, complete mutation responses, `Profile.Organizations`, and Azure attachment upload. The Vaultwarden profile uses camelCase data, wrapped `OrganizationsNew`, reduced mutation acknowledgements, and Direct attachment upload.

Both profiles perform password login, personal Cipher creation and update, organization-key decryption, Collection routing, Passkey counter persistence, authenticated attachment upload, verification and deletion, plus protected and explicitly confirmed empty-vault synchronization. Signed attachment requests are checked for absent Bearer authorization. Set `MONICA_BITWARDEN_INTEROP_KEEP=1` to write the count-only evidence file to `.tmp/bitwarden-contract-interop/evidence.json`.
