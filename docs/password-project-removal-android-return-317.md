# Removed password projects: Edge → current Android → extension

All three exact projects from the final member-removal UI run returned through
the current Android application and an independent extension Native reader.

| Actual Edge operation | Android live passwords | Native tombstones | Shared attachment |
| --- | ---: | ---: | --- |
| Completed removal | 1 | 2 | Same 33 bytes / SHA-256 |
| Restart, unlock and resume | 1 | 2 | Same 33 bytes / SHA-256 |
| Cancel preparation | 3 | 0 | Same 33 bytes / SHA-256 |

Source: `.tmp/interop-315-edge/run-Ib0NrL/evidence.json`. Each closed synthetic
Native working copy was cloned before reading. Historical bootstrap Blobs were
restored from the original synthetic Android fixture; newly uploaded/copied
Blobs came from the actual Edge run. Eight authenticated encrypted Blobs and
the exact closed MDBX file were staged separately. This is an acceptance
fixture, not a user-facing complete backup/export implementation.

Android `ExtensionAndroid315InteropTest.reopenRemovedPasswordProject` imports
the database into an isolated `TransferFixture`, installs authenticated Blobs,
projects through the actual `MdbxViewModel` and Room repositories, checks the
exact live membership and rich fields/protection flags, verifies Native
tombstones, reads attachments through `AttachmentFacade`, edits a surviving
password's note through `PasswordViewModel.savePasswordsAcrossTargets`, reopens,
and exports the database plus Blobs. The fixture cleans up its own records.
These are application repository/ViewModel tests, not Android screen automation.

The independent Native return checks every surviving password/custom field,
raw metadata containing `9007199254740993`, actual collection IDs, unchanged
unedited payloads, exact deleted-object summaries including commit IDs, and
attachment names/sizes/hashes before and after the Android edit. The shared
attachment hash is `d847fea0506871001539becb84276b190bf36d2b28a357f45edb540cf65d299d`.

Android's `Mdbx2Repository.passwordMutation` rebuilds `JSONObject`: null category
and note/SSO bindings are omitted, empty SSO provider is absent for PASSWORD,
and the default collection is represented by the native Object's collection
ID rather than a redundant payload field. The return test asserts each exact
previous empty/redundant value and unchanged physical collection before
accepting these omissions. It also allows the intended note change, Android
Room projection ID and plaintext encoding marker. Every other payload field
must match. The original strict raw comparison failure is retained; this is
not a claim of byte-identical rewritten Android JSON.

Verified application provenance:

- Android `1.0.317-26100512-36` on shared `Monica_Issue136_API_32`, API32/x86_64.
- Main HEAD: `63bb37b4f92f958d59a3a3aa5225a4ad20eb05d2`.
- Android dirty diff SHA: `a34176997e753a5a72afa95f6f22b2c845d3abb7a179178f0842add60f3b2101`.
- Installed app SHA: `1c731442002c4ad678786573a6980e62098dd1bbd89d794707233321259b742f`.
- Built/installed test APK SHA: `02bab91b8027c213feae397570d5f11c7a3c191af5345bd5784b87cfbe5c5d11`.
- Native Host SHA: `58848c72c5b0db09e6b03bda5043a419c4ba05d5c462080420d76b112203b826`.

The main HEAD, dirty source diff and installed app matched the prior current
Android acceptance baseline. Every new run independently checked unchanged
Android/test sources, installed app/test APK, and device boot identity. Android
product sources were untouched. The task started the stopped public AVD and
stopped it after all tests; its configuration and disks remain available.

Evidence per mode is under `.tmp/android-removal-ui-317/{complete,restart,cancel}`:
`removed-project-prepare-evidence.json`, `removal-project-evidence.json`,
`removed-project-android-readback.json`, `removed-project-return-evidence.json`.
Logs are under `.codex-tasks/android-interop-315/raw/removal-ui-android-*`.
Three preparation checks, three Android instrumentation cases, and three
independent return checks passed. The first preparation tried to disclose a
deleted object (correctly rejected by Native); tombstones are instead verified
through the supported summary API, including their exact commit/identity.

Full counterpart completion still requires the remaining backend/lifecycle
matrix, including atomic group restore, remote-only tombstones, deleted parent
collections, user-facing complete MDBX+Blob transfer, WebDAV concurrency,
Bitwarden member deletion/attachments, KeePass grouping and portable Passkeys.
