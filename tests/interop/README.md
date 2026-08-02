# MDBX2 Android and browser interoperability acceptance

Run from the extension repository on Windows:

```powershell
npm run test:mdbx2-android-interop
```

The acceptance test uses the sibling `Monica-main` repository by default. Override it with `MONICA_ANDROID_REPOSITORY` when needed. It compiles an additional instrumentation source through `tests/interop/android-mdbx2/interop.init.gradle`; Android tracked and untracked source state is compared before and after the build.

The runner starts `Pixel_Fold_API_35` in read-only headless mode when no Android device is connected, installs the generated `mdbx-engine` test APK, and performs this exchange:

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

Set `MONICA_MDBX2_INTEROP_KEEP=1` to retain temporary evidence under `.tmp/mdbx2-android-interop`. Set `MONICA_MDBX2_INTEROP_AVD` to select another installed AVD. By default the runner starts a dedicated read-only emulator and leaves other connected devices untouched; set `MONICA_MDBX2_INTEROP_SERIAL` to authorize a specific connected device.
