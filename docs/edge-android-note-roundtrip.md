# Real Edge note archive → Android → Edge

This opt-in continuation uses the exact encrypted ZIP produced by the
[WebDAV note UI acceptance](webdav-note-ui.md), not a newly constructed substitute.
The archive contains five passwords and three notes. Four passwords have links;
the fifth has been explicitly unlinked. Two notes share a title but have different
content. The third note and its linked password were created in actual Edge.

The Android leg executes the installed application's ZIP decoder, targeted import
coordinator, MDBX writer, Room reopen and ZIP exporter. Extension-owned
instrumentation checks fresh Room ID remapping and decrypted note JSON. It does
not modify Android application sources or clear application data. Android screen
interaction is outside this test's scope.

The final Edge leg connects to a fresh isolated Apache WebDAV directory through
the real extension UI. It opens every linked note and verifies the unlinked
password has no note action. It compares note text without trimming whitespace,
tags, Markdown state, password title, username, secret, notes, URLs, favorite state,
login type and custom fields. Checks repeat after page reload, in the actual Edge
side panel, and after a full isolated browser restart. Manager dialogs are checked
at 420 and 320 pixels separately from the actual side panel. The final independent
service readback requires the Android-return ZIP hash to remain unchanged.

## Run

Reuse the public `Monica_Issue136_API_32` AVD. Start it only if stopped; stop it
afterwards only if this run started it. Never overlap instrumentation sessions.
Use the installed ordinary application and build/install only the extension-owned
test package. All data below is synthetic; the service helper uses existing
isolated Docker volumes and loopback ports.

From the extension directory in PowerShell, stop at the first failed command:

```powershell
$env:MONICA_315_APP_FIXTURE = "$PWD/.tmp/edge-note-android-20261002"
$env:MONICA_EDGE_NOTE_UI_RUN = "$PWD/.tmp/interop-315-edge/run-KHmXvB"
$env:MONICA_MDBX2_INTEROP_SERIAL = 'emulator-5554'
npx tsc -p tsconfig.interop.json --pretty false
$env:MONICA_EDGE_NOTE_STAGE = 'prepare'
npx vitest run --config vitest.android-edge-note.config.ts
node scripts/interop-315-android-app.mjs build
node scripts/interop-315-android-app.mjs install-test
node scripts/interop-315-android-app.mjs edge-note-import
$env:MONICA_EDGE_NOTE_STAGE = 'verify'
npx vitest run --config vitest.android-edge-note.config.ts

node scripts/interop-315-docker.mjs
$env:MONICA_315_REAL_SERVICES_CONFIG = "$PWD/.tmp/interop-315-docker/services.json"
$env:MONICA_EDGE_NOTE_STAGE = 'publish'
npx vitest run --config vitest.android-edge-note.config.ts
$env:MONICA_WEBDAV_NOTE_FIXTURE = "$PWD/.tmp/edge-note-android-20261002/return-edge-fixture.json"
node scripts/interop-315-edge.mjs --webdav-note-return
# Use the actual successful directory printed by the preceding command.
$env:MONICA_EDGE_NOTE_RETURN_UI_RUN = "$PWD/.tmp/interop-315-edge/<actual-run>"
$env:MONICA_EDGE_NOTE_STAGE = 'final'
npx vitest run --config vitest.android-edge-note.config.ts
node scripts/interop-315-docker.mjs --stop
```

Use `--webdav-note-return` for the Android-return fixture. `--webdav-notes` creates
and edits records and is a different scenario. Native Messaging registration is
temporarily redirected only for the isolated Edge run and restored by its runner.

## Evidence

The preparation stage requires passing real Edge and independent remote-readback
reports and copies exact archive bytes. The Android verification checks pushed
and pulled SHA-256 values, the test APK against the completed build, unchanged
application/test sources and packages, and unchanged device boot ID. All stages
write individual evidence reports, including when they fail.

Current run: `.tmp/edge-note-android-20261002`. Preparation passed with input SHA-256
`685f7404db56d38092c7f76afea71bb089b84de6f3ae659cd94c104d83243a65`.
All four verification stages passed. The actual Android restore imported all
eight records. The first note remapped `435 → 440`, the second `434 → 439`, and the
new Edge note `1790911824867702 → 441`; the unlinked password remained null.
The returned ZIP SHA-256 is
`a6b61dc9cffd41d13d36949f193fe098ab8407ba0b6274cba1dda402dc89c986`.

Android was `1.0.316-26100212-08`, application SHA-256
`b81b51fbb7ceca50f101905621c19d50abe23721188b4ee950c3d8867dce4e3c`.
The test APK built in 7m 3s, SHA-256
`af65eafa338e13f29213808d4fbc5fc8ffe0dfaf3cdc0fd51d22846c49f3cb08`.
Application/test/source/boot invariants passed. Android revision was
`0ddbaf3d671d653ee8b0e256a75ff26745002ffc`.

Final actual Edge run `.tmp/interop-315-edge/run-WR8Z7a` passed initial 420/320
dialogs, reload, the real 382px side panel and browser restart, plus eight existing
lifecycle/Native Messaging checks. Console errors were empty; Native Messaging
registration was restored. Screenshots were visually inspected. The final
independent Apache readback confirmed the returned ZIP remained byte-identical.

The first Edge run, `run-8B6W9Y`, passed the note checks but failed when the generic
lifecycle test searched for the desktop lock button with the viewport still
narrow. The runner now restores the desktop viewport before that stage. Its failed
evidence and `raw/edge-note-return-edge.log` remain; the complete passing run is
recorded in `raw/edge-note-return-edge-2.log`.

Per-stage evidence lives beside the archives: `edge-note-prepare-evidence.json`,
`edge-note-import-evidence.json`, `edge-note-verify-evidence.json`,
`edge-note-publish-evidence.json`, and `edge-note-final-evidence.json`.
`android-edge-note-restore.json` records actual ID remapping. TypeScript and script
syntax checks passed. This continuation changed test harnesses and documentation;
no product code or full-suite rebuild was needed. The task-started public AVD and
isolated Docker services were stopped, preserving their reusable data.

Other password fields, source backends, Android screen workflows and the complete
Android counterpart objective remain separate acceptance work.
