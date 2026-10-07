# WebDAV password-to-note UI

The password editor now supports note associations for Monica Android WebDAV
archives. It uses the same source-scoped identity validation as local/MDBX notes;
the final save validates the selected target again. Existing unresolved numeric
references remain identifiable and are preserved unless explicitly replaced or
removed.

The picker uses two-line M3E options with a title and a plain-text excerpt. This
keeps same-title notes distinguishable at narrow widths. The selected note has an
Android-style summary and an unlink action. Excerpts are bounded to 160 characters;
the underlying note is not changed. Detail view opens the actual linked note.

[Editable local Canvas design](design/webdav-note-picker.md) contains the main
editor and expanded option designs. Both were rendered with local M3E Canvas
before implementation. No hosted Canvas site was used.

## Verified

Actual Edge run `.tmp/interop-315-edge/run-KHmXvB/evidence.json` passed:

- WebDAV connection, creation and cloud synchronization of an association.
- Same-title note replacement, cancel preserving the previous link, and explicit
  unlink.
- Creating a new note and associating another new password with it.
- Opening the linked note, nested Escape behavior, and picker Escape.
- Reloading and synchronizing again without losing links.
- Filtering out WebDAV notes when the draft destination changes to the local vault.
- 420px and 320px rendering without section overflow; option excerpts occupy a
  separate visible line. Final screenshots were inspected.

The normal eight Edge setup/lifecycle/native-handshake checks also passed. Native
Messaging registration was restored. The Apache and Vaultwarden test containers
were stopped afterwards. No AVD was started for this UI turn.

An independent fresh provider connection read the actual Apache ZIP after Edge
closed. All eight records were present; the created/replaced/new-note links,
explicit unlink, original link and note content passed verification. Evidence:
`.tmp/webdav-note-ui/run-JgkBzk/remote-readback.json`. The encrypted archive is
`edge-note-return.zip` in that directory, SHA-256
`685f7404db56d38092c7f76afea71bb089b84de6f3ae659cd94c104d83243a65`.

The seed was the unchanged actual Android archive from
`.tmp/android-zip-note-20261002-final/android-note.zip`, checked against its Android
export manifest. The prior [Android ZIP roundtrip](android-zip-note-interop.md) and
this UI/provider roundtrip are separate evidence. The exact new eight-record Edge
output subsequently passed its own [Android restore and final Edge reopen](edge-android-note-roundtrip.md),
including ID remapping, the real side panel and an unchanged remote archive hash.
Other restore destinations and backends remain outside this completed UI case.

Validation: `npm run build`; 9 relevant test files / 133 tests; actual Edge and
independent remote readback. No full-suite rerun was needed for the UI-only changes.
Initial failures from an ambiguous dialog selector and an assertion using an
unreflected option attribute remain in the raw logs. The first passing UI run's
single-line options were rejected on visual inspection and replaced by two lines.

## Reproduce

Use the extension directory, the existing synthetic Docker setup and a fresh
generated fixture. The seed test prints/saves its fixture under
`.tmp/webdav-note-ui/run-*/fixture.json`; use that exact newly created file.

```powershell
node scripts/interop-315-docker.mjs
$env:MONICA_315_REAL_SERVICES_CONFIG = "$PWD/.tmp/interop-315-docker/services.json"
Remove-Item Env:MONICA_WEBDAV_NOTE_FIXTURE -ErrorAction SilentlyContinue
npx vitest run --config vitest.webdav-note-ui.config.ts
# Set to the fixture.json created by the preceding seed step.
$env:MONICA_WEBDAV_NOTE_FIXTURE = 'ABSOLUTE_PATH_TO_GENERATED_FIXTURE_JSON'
npm run build
node scripts/interop-315-edge.mjs --webdav-notes
npx vitest run --config vitest.webdav-note-ui.config.ts
node scripts/interop-315-docker.mjs --stop
```

Stop on the first failure and retain its evidence. Regenerate a fresh seed before
repeating the complete UI case; previous runs intentionally leave independent
remote archives for inspection.
