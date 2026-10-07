# MDBX2 Android and browser interoperability acceptance

Run from the extension repository on Windows:

```powershell
npm run test:mdbx2-android-interop
```

The acceptance test uses the sibling `Monica-main` repository by default. Override it with `MONICA_ANDROID_REPOSITORY` when needed. It compiles an additional instrumentation source through `tests/interop/android-mdbx2/interop.init.gradle`; Android tracked and untracked source state is compared before and after the build.

The runner defaults to the global ADB server on port 5037 and reuses the running public AVD `Monica_Issue136_API_32`. It checks emulator AVD names before starting that same AVD if it is absent. It never clears application data or creates another AVD. For a reproducible run, explicitly select the serial verified on site:

```powershell
$env:MONICA_MDBX2_INTEROP_AVD = 'Monica_Issue136_API_32'
$env:MONICA_MDBX2_INTEROP_SERIAL = 'emulator-5554'
$env:MONICA_MDBX2_INTEROP_ADB_SERVER_PORT = '5037'
$env:MONICA_MDBX2_INTEROP_KEEP = '1'
npm run test:mdbx2-android-interop
```

It installs the generated `mdbx-engine` test APK and performs this engine-level exchange (not an Android application UI acceptance):

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

The injected engine test uses only `x86_64` by default and writes build outputs to `.tmp/android-mdbx2-build`, avoiding multi-ABI installation pressure on the shared AVD and the Android checkout's existing Gradle output locks. To run just this engine exchange (the broad config also discovers the other interoperability suites):

```powershell
npx vitest run --config vitest.android-interop.config.ts tests/interop/mdbx2-android-webdav.interop.ts
```

Set `MONICA_MDBX2_INTEROP_KEEP=1` to retain temporary evidence under `.tmp/mdbx2-android-interop`. Override `MONICA_MDBX2_INTEROP_AVD` only when the public AVD cannot cover a required API/ABI. `MONICA_MDBX2_INTEROP_SERIAL` selects a connected device. `MONICA_MDBX2_INTEROP_ADB_SERVER_PORT` may select an existing isolated ADB service; it must be the server that owns the selected emulator. Cleanup stops only an emulator launched by this invocation and never stops the global ADB server. Synthetic fixture cleanup removes only the runner-owned `files/mdbx2-extension-interop` tree in its instrumentation package, not app data.

## KeePass Android and browser interoperability acceptance

Run from the extension repository:

```powershell
npm run test:keepass-interop
```

The runner injects one JVM unit-test source directory into the sibling Android `:app` project without changing Android files. Android Kotpass creates KDBX 4 fixtures using AES-256, ChaCha20, and Twofish. The extension opens and edits the AES-256 and ChaCha20 fixtures, preserves native fields and metadata, exports them, and Android Kotpass reads the exported files again. The Twofish fixture must fail before decryption with the controlled conversion guidance.

The Android repository revision and complete `git status --porcelain=v1 -uall` value are checked before and after the run. Set `MONICA_ANDROID_REPOSITORY` to select another read-only Android checkout. Set `MONICA_KEEPASS_INTEROP_KEEP=1` to retain encrypted fixture evidence under `.tmp/keepass-android-interop`.

The isolated JVM option copies the current Android Kotlin/Java codec sources verbatim, including its whitespace-preserving XML parser. It does not run the Android UI or device application. This avoids rebuilding Compose for codec verification:

```powershell
$env:MONICA_KEEPASS_INTEROP_STANDALONE = '1'
$env:MONICA_ANDROID_API_JAR = 'D:/AndroidSDK/platforms/android-35/android.jar'
$env:MONICA_KEEPASS_INTEROP_KEEP = '1'
npm run test:keepass-interop
```

## Android 1.0.315 application fixtures

### Restored MDBX password project (current 1.0.317)

`android317-restored-project-return.interop.ts` pairs the closed synthetic
`--native-restore` Edge run with its original encrypted Android Blob files. Set
`MONICA_317_RESTORED_EDGE`, `MONICA_317_RESTORED_BLOBS`, and
`MONICA_315_APP_FIXTURE` to those explicit synthetic roots. Its default `prepare`
phase verifies the three restored Native objects and attachment plaintext hashes
before preparing the database plus separate encrypted Blob inputs.

The Android runner's `restore-project` stage calls the actual app repositories
and ViewModels, checks field/protection/project identity projection, edits a
restored password, and re-exports MDBX plus Blobs. Set
`MONICA_APP_INTEROP_TEST_SET=full-fields` for this test. Optionally set
`MONICA_APP_INTEROP_BUILD_APPLICATION=1` for the `build` stage to assemble the
current debug application (including the shared AVD's x86_64 ABI) together with
the instrumentation APK; both paths and hashes are recorded. Application
installation is an explicit separate step and must use that exact verified
artifact. `install-test` still installs only instrumentation.

Finally run the TypeScript test with `MONICA_317_RESTORED_PHASE=return` to compare
the actual Android export against the original Edge data and attachment hashes.
This is app repository/Room/Native acceptance, not Android screen automation.
It does not convert the database-only export button into an attachment backup.

`android-app/interop.init.gradle` injects extension-owned instrumentation into `:app` without changing Android source. Builds use `.tmp/android-app-build-315` and an independent `.tmp/android-app-gradle-315` project cache, so concurrent Android checkout builds cannot clean this runner's task outputs. `scripts/interop-315-android-app.mjs` requires the already-running public AVD, checks its identity, uses global ADB 5037, and records installed app/test APK hashes, test-source hashes, Android HEAD, dirty-diff and status hashes before and after each operation. It never starts an emulator or clears application data. Tests reuse the existing `TransferFixture`: each creates an independent synthetic vault, and its normal cleanup deletes only records and files belonging to that fixture.

```powershell
node scripts/interop-315-android-app.mjs build
# Installs only the instrumentation APK; does not replace the installed application.
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs export
$env:MONICA_315_APP_FIXTURE = 'C:/Users/joyins/Desktop/Monica-all/monica-extension/.tmp/android-app-interop-315'
npx vitest run --config vitest.android315-native.config.ts
npx vitest run --config vitest.android-interop.config.ts tests/interop/android315-zip.interop.ts
# After the extension has produced extension.mdbx / extension.zip in the same evidence directory:
node scripts/interop-315-android-app.mjs import
$env:MONICA_315_NATIVE_PHASE = 'return'
npx vitest run --config vitest.android315-native.config.ts
node scripts/interop-315-android-app.mjs zip
node scripts/interop-315-android-app.mjs ui
# After actual Edge UI editing exported edge-ui-return.mdbx into the evidence directory:
node scripts/interop-315-android-app.mjs edge-ui
node scripts/interop-315-android-app.mjs failures
```

Evidence and synthetic files are under `.tmp/android-app-interop-315`. The regular export is an **application ViewModel/repository** test, not UI creation. The separate `ui` stage operates the actual Compose editor and detail screen. A test pass alone does not establish field compatibility: `android-writer-gaps.json` and `android-known-field-writeback.json` deliberately report observed Android writer omissions without altering Android source. ZIP, native MDBX, UI, engine/WebDAV, and isolated JVM results must be reported independently. A crashed UI test may leave its synthetic fixture for scoped recovery; never clear application data to remove it.

`edge-ui` reopens the single-record vault actually exported by Edge, renders Android's detail screen, edits its username through the real Compose editor, saves, and exports `android-edge-ui-return.mdbx` / `.json` / `.png` for a final read-only Edge reopen. Do not regenerate or overwrite the original `android-ui.mdbx` while this chain is active. The runner refuses to submit instrumentation while another session is active or ActivityManager is unavailable, records Android boot IDs before/after, and preserves timestamped incomplete client logs. An ADB exit, device restart, or UI assertion failure is not a successful UI test; coordinate access to the shared AVD instead of clearing data or restarting it.

For an independent rerun of the original UI creation test while retaining the first local fixture, use `ui-recheck`: it pulls the resulting native file, record and screenshot under `recheck-android-ui*` names. It does not overwrite the original local `android-ui.mdbx` / `android-ui-record.json` used by the Edge loop.

Application fixtures explicitly target Android user 0. UI stages refuse to proceed when another user is active; they never switch users automatically. The runner checks installed main/test APK hashes again after execution, rejecting mixed-package evidence if another task updates an APK mid-run. Coordinate before installing a test package on the shared AVD, because its package is shared with other Android test tasks.

`createBackup` does not include external Blob files: the native stages require `android-blobs.json` / `extension-blobs.json` / `android-return-blobs.json` with each `path`, `blobId`, and `sizeBytes`, plus their encrypted bytes. This explicit two-part fixture transport is not a successful standalone single-file backup. Staging uses UUID-named encrypted files in `/data/local/tmp`, checks the destination SHA-256, and removes only that exact staging file; it never stages plaintext user records.

The failure test checks wrong vault/ZIP passwords, a truncated encrypted archive, and cancellation after decryption before restore apply. It hashes existing password/vault rows and preserves source backup bytes. SQLite journal initialization may change database container bytes on first open, so wrong-password object/ID/revision checks operate on an isolated copy. These checks do not claim cancellation rollback during an already-committing restore. `recover-ui-artifacts` only pulls an existing UI-created fixture after a later assertion failure, and explicitly does not mark that UI test passed.

## Stable bound-note application return

Use a closed synthetic vault saved by the real Edge bound-note flow with
`MONICA_315_KEEP_NOTE_LINK=1`. Keep that run's vault and original encrypted Blob
directory together; never substitute user data or rebuild records from JSON.

For actual cross-vault UI copying, also set `MONICA_315_NOTE_COPY_TARGET_FIXTURE`
to an independently created synthetic vault before running the Edge features.
The test imports that destination through the UI and checks its provider both
before copying and on the resulting password/note. Export the destination's
closed file for the Android return, using the copied password's Native ID.

```powershell
$env:MONICA_315_APP_FIXTURE = '<absolute isolated evidence directory>'
$env:MONICA_315_NOTE_EDGE_FILE = '<absolute closed synthetic Edge vault.mdbx>'
$env:MONICA_315_NOTE_BLOBS = '<original Android fixture directory containing android-blobs.json>'
$env:MONICA_315_NOTE_PHASE = 'prepare'
# When original and copied links coexist, select the copy's Native object ID:
# $env:MONICA_315_NOTE_TARGET_ID = '<copied password remoteId from Edge evidence>'
npx vitest run --config vitest.android315-native.config.ts tests/interop/android315-note-return.interop.ts
# Reuse the shared AVD; build must finish before installing its instrumentation.
node scripts/interop-315-android-app.mjs build
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs import
$env:MONICA_315_NOTE_PHASE = 'return'
npx vitest run --config vitest.android315-native.config.ts tests/interop/android315-note-return.interop.ts
```

Keep the same optional target ID in both phases. The return assertion checks Android's actual Room relationship against the
password and note's stable IDs, unchanged note content, the re-exported stable
reference, and all native object IDs. This is repository/ViewModel evidence,
not proof of Android screen rendering, cross-vault transfer, or full-field
preservation. Keep failed runs and source hashes; do not rerun prepare over an
in-progress return fixture. Stop the AVD afterwards only if this task started it
and no instrumentation remains active.

## Atomic source deletion primitive

Set `MONICA_315_DELETE_FIXTURE` to a synthetic MDBX containing a stable linked
password and note, and `MONICA_315_DELETE_OUTPUT` to an isolated evidence directory.
Run `npx vitest run --config vitest.android315-native.config.ts tests/interop/android315-source-delete.interop.ts`.
The actual Host imports a copy, checks that one stale revision prevents all
deletion, drops a successful batch response, and verifies receipt recovery and
same-commit tombstones. The input file stays unchanged. Deleted payloads cannot
be disclosed; unrelated payloads/revisions are compared directly. This does not
prove end-to-end move restart recovery or Android screen behavior.

## Android literal ciphertext passwords

Use the shared AVD and a fresh synthetic evidence directory. The application
must match the current Android sources; the build below installs no application
and does not clear any data.

```powershell
$env:MONICA_315_APP_FIXTURE = Join-Path (Get-Location) '.tmp/android-password-encoding-317'
$env:MONICA_APP_INTEROP_TEST_SET = 'full-fields'
node scripts/interop-315-android-app.mjs build
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs password-encoding-export
$env:MONICA_PASSWORD_ENCODING_PHASE = 'prepare'
npx vitest run --config vitest.android-interop.config.ts tests/interop/android317-password-encoding.interop.ts
node scripts/interop-315-android-app.mjs password-encoding-import
$env:MONICA_PASSWORD_ENCODING_PHASE = 'return'
npx vitest run --config vitest.android-interop.config.ts tests/interop/android317-password-encoding.interop.ts
```

Android creates an authentic install-encrypted string. The extension writes that
literal string as a new password and as a password edit, including a simulated
lost response after the real Host commit. A deliberately unmarked third record
controls for Android's legacy repair. The return requires two exact literal
passwords, one repaired legacy password, actual Android editing/reopening and
independent Native readback. Keep the same Android installation throughout;
the probe contains only synthetic content, stored in the ignored fixture
directory and app-private storage.

## Bitwarden and Vaultwarden server-contract acceptance

Run from the extension repository:

```powershell
npm run test:bitwarden-interop
```

The runner uses two stateful, secret-free recorded server profiles. The official profile uses PascalCase sync data, complete mutation responses, `Profile.Organizations`, and Azure attachment upload. The Vaultwarden profile uses camelCase data, wrapped `OrganizationsNew`, reduced mutation acknowledgements, and Direct attachment upload.

Both profiles perform password login, personal Cipher creation and update, organization-key decryption, Collection routing, Passkey counter persistence, authenticated attachment upload, verification and deletion, plus protected and explicitly confirmed empty-vault synchronization. Signed attachment requests are checked for absent Bearer authorization. Set `MONICA_BITWARDEN_INTEROP_KEEP=1` to write the count-only evidence file to `.tmp/bitwarden-contract-interop/evidence.json`.
