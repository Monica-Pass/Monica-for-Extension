# Android ZIP password-to-note roundtrip

This opt-in test uses the installed Monica Android application on the shared
`Monica_Issue136_API_32` AVD. It executes the actual application ZIP exporter,
decoder, targeted import coordinator, MDBX writer and Room reopen. It is separate
from Android screen interaction and the browser UI.

The extension-owned instrumentation source is
`tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionAndroid315InteropTest.kt`.
Android application sources are not modified. `TransferFixture` creates and
removes only its own synthetic databases and restores the previous session state.
Do not clear application data or run a second instrumentation session concurrently.

The seed contains three passwords sharing one note and a second note with the
same title but different content. The extension edits the archive to cover:

- Rename a password while retaining its original association.
- Replace the association with the other same-title note.
- Explicitly remove the association.
- Create a note and password and associate them using the exported note ID.

Android imports these seven records into a fresh temporary MDBX database. The test
checks that the backup note IDs are remapped to actual Room IDs, the linked note
data and password fields are retained, and unlink remains empty. Android then
exports another encrypted ZIP; the extension verifies every association again
after reconnecting with a different source ID.

## Run

Check whether the public AVD is already running; start it only when needed. Stop
it afterwards only if this run started it. The runner requires the existing app
and test packages and records their SHA-256 fingerprints, Android Git state,
extension test source hashes and device boot ID. It rejects changes during a run.

From the extension directory in PowerShell, choose a fresh evidence directory:

```powershell
$env:MONICA_315_APP_FIXTURE = "$PWD/.tmp/android-zip-note-20261002-final"
$env:MONICA_MDBX2_INTEROP_SERIAL = 'emulator-5554'
node scripts/interop-315-android-app.mjs build
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs zip-note-export
$env:MONICA_ZIP_NOTE_STAGE = 'forward'
npx vitest run --config vitest.android-zip-note.config.ts
node scripts/interop-315-android-app.mjs zip-note-import
$env:MONICA_ZIP_NOTE_STAGE = 'return'
npx vitest run --config vitest.android-zip-note.config.ts
```

Stop at the first failure. Do not substitute hand-built fixtures for the Android
export. The forward stage requires passing device evidence; the return stage also
requires a successful actual Android restore. Each codec stage writes a separate
evidence file, including on failure. Android restore diagnostics are pulled when
available even if an assertion fails.

## Acceptance record

Run `.tmp/android-zip-note-20261002-final` passed all four legs using installed
Android `1.0.316-26100212-08`. Four passwords and three notes survived restore into
a fresh MDBX database and Android ZIP re-export. Keep remapped `435 → 437`, replace
remapped `434 → 436`, the newly created note remapped `1790909874942755 → 438`, and
unlink remained null. The extension independently verified exact note content,
tags, Markdown state, password fields and a second source reconnect.

Evidence in that directory:

- `zip-note-export-evidence.json` and `zip-note-import-evidence.json`: actual
  application execution, package/source/boot invariants and output file hashes.
- `zip-note-forward-codec-evidence.json` and `zip-note-return-codec-evidence.json`:
  extension verification, matching Android output hashes and consistent app hash.
- `android-note-restore.json`: actual remapped Room IDs and all seven imports.

The application SHA-256 was
`b81b51fbb7ceca50f101905621c19d50abe23721188b4ee950c3d8867dce4e3c`;
the final test APK SHA-256 was
`876ced5ca3bc2766624f6d95ab716f46df56c5390a415e45549eb98492e5f920`.
Android source revision was `0ddbaf3d671d653ee8b0e256a75ff26745002ffc`.
The public AVD was started for this run and stopped afterwards without clearing
its data. Android application sources and installed application were unchanged.

The initial `.tmp/android-zip-note-20261002` restore failed because the harness
compared encrypted decoded note data with decrypted target JSON. The corrected
test decrypts both sides; `raw/zip-note-import-red.log` preserves the failure.
The final run uses fresh artifacts and the same final test APK for both device
legs. TypeScript checks and 12 existing note regressions also passed.

This proves the ZIP codec and Android targeted MDBX restore path. Subsequent
[WebDAV note UI work](webdav-note-ui.md) enabled and verified real browser editing.
The newer eight-record Edge output now has its own
[actual Android import and final Edge reopen evidence](edge-android-note-roundtrip.md),
including a real Edge side panel check. Android screen workflows, other restore
destinations and other backends remain separate acceptance work.
