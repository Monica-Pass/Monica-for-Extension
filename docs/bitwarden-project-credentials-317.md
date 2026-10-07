# Bitwarden password projects — Android 1.0.317

Android's `CipherSyncProcessor` reads `monica.content.credential` and projects
its explicit `projectId` into the password row's group identity. The extension
now follows this convention when decoding encrypted login ciphers. Missing,
duplicate, malformed or unsupported metadata does not infer a group. Provider
and database scope still isolate projects; identical titles never imply one.

Complete group saves now support Bitwarden. Every row must have valid metadata
with matching project identity and a distinct password identity. Existing
complete-membership, stale-snapshot and atomic encrypted persistence guards
apply before pending remote operations are recorded. The derived outer group
identity is excluded from durable receipt fingerprints; the actual metadata
field remains included, preserving compatibility with earlier cached rows.

Existing project editing controls support shared edits, adding passwords and
adding groups. Adding another account to an ungrouped Bitwarden password now
creates versioned metadata. No credential removal is enabled by this change.

## Verified evidence

- Unit/integration: `bitwarden-project-credentials.test.ts`; red failures
  retained in `raw/bw-project-red.log`, green in `raw/bw-project-green.log`.
  Final full suite: 195 files / 1845 tests; typecheck and production build passed.
- Actual Android seed: `.tmp/android-project-order-317`, three rows/two groups,
  app `1.0.317-26100412-18`, archive SHA-256
  `f5483be4c0ab5919746740b2ab18e82162f5fe0fbe51244011d839ca20c99417`.
- Real Vaultwarden: `.tmp/bw-project-credentials-317/run-Dn4KX1/evidence.json`.
  Encrypted update/create and fresh connection preserve identities, fields and
  the independent same-title password; durable mutation queue drains.
- Real Edge: `.tmp/interop-315-edge/run-UPSR6f/evidence.json`. Shared edits,
  appended password/group, new two-group project, sync, cancellation and browser
  restart pass. Final nine rows comprise projects of six and two rows plus one
  independent row. 320px/420px screenshots inspected; console errors empty and
  temporary native registration restored.
- Independent server authentication/readback:
  `run-UPSR6f/bw-project-independent-readback.json`; nine exact semantic rows,
  no extension cache, stable Cipher/project IDs and same-title isolation.

The logs above live under `.codex-tasks/android-interop-315/raw/`. Failed Edge
runs remain retained; the final sync check waits for changed `lastSyncAt`, an
empty durable queue, no provider error and idle UI. Synthetic account fixtures
are stored only in ignored `.tmp` files and must not be published.

Follow-up cache regression passes: an unchanged normal provider sync restores
grouping to old cached rows missing `passwordGroupId`, retains their local IDs,
and performs no remote mutation. The focused file now contains five tests.
Unlabeled group headings now use the full project's ordinal, shared with the
content-order labels. Real Edge `run-nuksiY` asserts headings 1/2/3 and passes
create/edit/cancel/order/restart; 320px rendering was inspected.

## Actual Android return and final browser verification

`.tmp/android-bitwarden-project-317/bitwarden-project-evidence.json` and
`bitwarden-project-return-evidence.json` both pass. The installed ordinary app
`1.0.317-26100412-22` downloaded all nine encrypted server records through HTTP
and the actual `CipherSyncProcessor`, restored three credential groups in the
six-row project, changed its shared username/notes/group label and reversed its
primary passwords. Android's production `uploadModifiedEntries` uploaded six
rows with zero failures. A fresh Android download after deleting only synthetic
local rows reconstructed the exact saved state. The two-row project and the
independent same-title row remained unchanged.

Independent extension authentication and HTTP readback then compared all nine
records to the Android result, checked unchanged passwords and project/group/
password/Cipher identities, and retained unknown `9007199254740993` metadata.
Android applies editor common custom fields to the resulting first row; this
fixture verifies that copied common field while retaining original row fields.
Android still stores icon transport fields as ordinary custom fields; exact
server names/values/protection are verified, not Android icon rendering.

Final real Edge `.tmp/interop-315-edge/run-0wCA7x/evidence.json` passes a fresh
source connection, actual HTTP sync, both project editors at 420px/320px, exact
password order, cancellation and browser restart. Both widths were inspected.
All nine semantic records match; native registration was restored and browser
console errors were empty. HTML textarea line endings are checked as displayed
LF; the underlying saved records retain exact CRLF through cancel/restart.

Provenance:

- App APK SHA-256: `084c7aa1f8c87416f161989402ab8ee501cd594e4a276db283d05280f8c1ddf0`.
- Test APK SHA-256: `6b2a773349713548bc3dfc6a04c492e349b5ce562336873e770b58918f259016`.
- Android revision: `63bb37b4f92f958d59a3a3aa5225a4ad20eb05d2`;
  dirty diff SHA-256: `5232891a15a2608683c1f7868566269ff7e1177e4655fdfffe501a6e6cbaa763`.
- Android returned JSON SHA-256: `64926ff7d48738e1710c07141526c467ebbc75fa57b39f680b0cc17168cd4189`.
- All build/run source, test-source, installed-package and boot checks pass.

Retained failures distinguish harness/environment errors: stale loopback proxy,
different icon-field projection, the initial new-entry upload call that uploaded
zero existing records, and a build rejected because concurrent Android work
changed its source. The final harness uses the actual modified-entry upload and
requires six successes/zero failures. Build4 passes after the Android task
released the shared AVD. Raw logs are `bw-project-android-{build-4,run-4,return}`
and `bw-project-android-edge-return-2.log`. Earlier Edge run-JKlKOr only failed
the DOM line-ending assertion and remains retained.

The public AVD and this task's two Docker containers were stopped after checking
for other active device work. AVD configuration/data and Docker volumes remain.
Replaying the original pre-Android Edge fixture requires a newly seeded synthetic
account: the final server account now correctly contains Android's edits.

## Remaining acceptance

This proves Android application storage/writer/sync and actual browser UI, not
the full Android screen workflow. Rich-field/backend lifecycle coverage,
credential removal and KeePass grouping remain separate unfinished work.

Current KeePass source trace: `KeePassKdbxService.buildEntryFields` (4552 onward)
appends credential metadata as ordinary custom fields, and `analyzePasswordEntry`
(6003 onward) extracts it again. However `KeePassEntryData` has no projected
project identity, `PasswordViewModel.upsertKeePassEntries` (1692 onward) does not
derive it, and `credentialexchange/ImportDestinationWriter.toPasswordProjection`
(169 onward) does not derive it either. `PasswordProjectIdentity.kt` only checks
the outer group/legacy replica fields, not custom metadata. Existing Room rows
can keep their old group identity; this does not prove fresh KDBX imports group
correctly. An actual Android file roundtrip is required before enabling grouped
KeePass editing or declaring this backend compatible. Android product sources
remain read-only in this work.
