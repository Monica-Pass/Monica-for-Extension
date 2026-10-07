# KeePass login text preservation

KeePass login projection now retains the original nonblank text instead of
trimming it. This covers SSH strings, contact/card metadata, SSO provider names,
SSID/Wi-Fi JSON and legacy aliases for the standard login fields. Marker and
numeric parsing remains normalized. Explicitly removing surrounding whitespace
is treated as an edit; an unrelated rename retains the original fields.

The encrypted-file tests also reproduced a separate loss: XML normalizes carriage
returns, and kdbxweb 2.1.1 removes valid tabs from plain XML. The writer stores
values containing tabs, CR or XML-sensitive controls as native KeePass protected
strings, retaining their UTF-8 content. Ordinary strings retain their existing
representation. This adds no extension-specific field carrier.

Incoming plain XML is now fixed too. `keepass-xml.ts` installs a parser through
the pinned runtime's writable `XmlUtils.parse` during crypto initialization.
It uses the browser DOMParser, or the existing xmldom parser in Node, without
the lossy tab sanitizer. Valid tabs, CDATA and character references survive;
literal CR follows standard XML newline normalization. Malformed XML, DOCTYPE
and invalid literal controls are rejected with generic errors. Failed replacement
files leave the already unlocked vault intact.

`@xmldom/xmldom` 0.8.15 is now a direct dependency, matching the existing override.
No node_modules patch or lifecycle-script enabling is involved.

## Validation

- 29 new regression cases cover raw projection, rename, explicit trimming, copying
  into a separate KDBX 3/4 database, editing, and encrypted file reopen.
- A further 16 parser cases cover literal tabs, CDATA, references, XML newline
  semantics, browser/fallback paths, malformed/DOCTYPE rejection, KDBX 3/4
  import/rename/export/reconnect and rejected replacement rollback.
- All 31 KeePass test files / 459 tests passed.
- Final full suite: 184 files / 1765 tests passed. TypeScript and production build
  passed. Lockfile verification passed for all 245 registry packages.
- Android core/Kotpass AES-256 and ChaCha20 roundtrip passed in
  `.tmp/keepass-android-interop/run-hFTDx3`. The test uses verbatim
  `KeePassFieldReferenceResolver.kt` and `SshKeyModels.kt`, checks exact private-key
  newlines, spaces, tabs and CRLF comments, new-entry copy, explicit edits/clear,
  then Android core re-export and extension reimport.
- Actual Edge `.tmp/interop-315-edge/run-f0Pd7Y` imported that Android core fixture,
  renamed the SSH record, edited its comment, cancelled a private-key draft,
  exported through the UI and reopened the file as a second source. Original
  private-key CRLF text remained exact. Encrypted local state survived browser
  restart. Eight ordinary lifecycle/Native Messaging checks passed, console errors
  were empty, and Native Messaging registration was restored. The 320px screenshot
  exposed excessive advanced-section padding; the later Canvas/UI refinement below
  fixes that inset.

The additional current Android core run `.tmp/keepass-android-interop/run-hzkwJG`
checks AES-256 and ChaCha20 fixtures with genuinely plain SSH public key/comment,
Email, Notes, and custom field names/values containing tabs. Kotlin asserts the
input values are `EntryValue.Plain`; extension import/edit/export, Kotlin readback
and plain-text return, then extension reimport all passed. The helper now uses
`KeePassCodecSupport.contentParser` for both encode/decode, matching Android's
actual service. The initial failure in `run-etdQhG` used Kotpass's default parser
and was a harness mismatch, not an Android application defect.

Actual Edge `.tmp/interop-315-edge/run-DRXdCB` imported that plain AES fixture,
renamed and edited the record, cancelled a private-key draft, exported via UI,
reopened as a second source, and restarted the browser. SSH/email/notes/custom
text remained exact. All eight lifecycle/native checks passed, console errors
were empty and the temporary Native Messaging registration was restored. This
closes the previously open incoming plain-XML tab boundary. Later UI refinement
and repeat evidence are recorded in `docs/design/ssh-editor-316.md`.

Android revision: `0ddbaf3d671d653ee8b0e256a75ff26745002ffc`.
Resolver SHA-256:
`2cc29d34ec4844035d5fdff4adef973c65f946b3fd0ec99356c1728abab73e95`.
SSH model SHA-256:
`50c3b7d5705b2968615386a0089a3da4c4ed5c92824f7f403ee3632721366d80`.
Actual Edge input SHA-256:
`18e8fccd1d0d8151118643253731189d7b9d5a32aee91f2f8b1be3729c660a38`.
Actual Edge export SHA-256:
`cfca8b2571b1400dacce216ca19976a2e8ab2fd3ca205b3e836dba66929a7cd2`.

Current Android XML parser SHA-256:
`9216913778f1c3f11fd7c151c32ec35bb3f9f04e4ff31a77e82a452af0a4718c`.
Plain AES input SHA-256:
`860e9525794f9a9f4ad3bae8334bbc2eb43f65985463bfcefbae0a55046755d2`.
Edge `run-DRXdCB` export SHA-256:
`d3e78cfe4a8761fb2fe0d20188270b98b9a97a3e573f0b42573474994a2148b1`.
Extension XML parser source SHA-256:
`97b84a41d1dc9d37a969e7585a24dab9cb1f156a293ec9818e46c60564688b34`.

Raw logs are under `.codex-tasks/android-interop-315/raw/kp-text-*`. The original
27 failures and the two subsequent XML-loss failures are retained. A test fixture
initially normalized its own title via `createLoginItem`; it now supplies the
original imported title explicitly. The first core run lacked the required SDK
path and did not execute. The first Edge run omitted expanding the advanced
section; the corrected run uses the visible disclosure before editing.
Additional `raw/kp-xml-*` logs retain the initial 11 parser failures, the first
Android helper mismatch, corrected Android core run, final tests/build/lockfile
checks and real Edge acceptance.

## Reproduce

From the extension directory in PowerShell:

```powershell
npx vitest run src/providers/keepass
npm test -- --maxWorkers=4
npm run build
$env:MONICA_KEEPASS_INTEROP_STANDALONE = '1'
$env:MONICA_KEEPASS_INTEROP_KEEP = '1'
$env:MONICA_ANDROID_API_JAR = 'D:/AndroidSDK/platforms/android-35/android.jar'
npx vitest run --config vitest.keepass-interop.config.ts
# Use the successful retained run printed by the preceding command.
$env:MONICA_KEEPASS_TEXT_FIXTURE_ROOT = "$PWD/.tmp/keepass-android-interop/<actual-run>"
$env:MONICA_KEEPASS_TEXT_PLAIN = '1'
node scripts/interop-315-edge.mjs --keepass-text
```

No Android application sources, user profiles or databases were changed. This
run did not start an AVD or Docker services. Core-code acceptance is separate from
Android application/screen acceptance. The original Android fixture deliberately
uses protected SSH strings; the additional plain fixtures verify incoming XML.
Unknown SSH JSON properties still lack a current Android KeePass transport,
and Android still discards metadata-only SSH. Full field/backend parity remains
incomplete.
