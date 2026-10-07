# API address field parity

Android `ApiKeyEntryFields.encode()` stores arbitrary address text. Its
`isValidOptionalUrl()` applies only when opening a web link. The browser form
previously invoked URL validation on every save, including unchanged imported
values, preventing relative paths and service names from being renamed or edited.

`putApiKeyFields()` now stores the text as supplied. It updates an existing field
in place, retaining its protection, type, other metadata and position. An absent
optional address stays absent; explicitly clearing an existing field keeps its
carrier empty. Ambiguous duplicate carriers are still rejected. The detail view
renders this field as text, so accepting an address does not navigate to it.

The precise Edge roundtrip also exposed a backend issue: KeePass and Bitwarden
generated a fresh unprotected API type marker before custom fields. Valid
existing API/GPG markers now stay in the custom-field sequence with their
protection. The file/cipher regressions compare full field arrays and check
initial Bitwarden encoding, not only address values.

Source reference: `Monica-main/Monica for Android/app/src/main/java/takagi/ru/monica/data/model/ApiKeyEntryFields.kt`.
No Android application source was changed.

## Verification

- Eleven core cases cover relative paths, service names, non-HTTP schemes,
  credentialed URLs, script-like text, whitespace, long text, unchanged values,
  field attributes/order, clear and duplicate rejection. Ten initially failed.
- Encrypted KDBX 3/4, Bitwarden cipher and Android ZIP read/edit/clear/reopen pass.
  These are backend codec/file tests, not live Bitwarden/WebDAV service tests.
- The KDBX checks exposed a second upstream issue: kdbxweb skips constructing a
  ProtectedValue for zero-byte encrypted strings. The XML adapter now preserves
  empty `String/Value Protected=True` fields; zero bytes do not advance the inner
  stream. Native/fallback parser and encrypted file tests cover this correction.
- Full regression: 186 files / 1780 tests and production build passed.
- Actual Android application and Edge roundtrip passed on2026-10-03 in
  `.tmp/android-api-address-20261002`, using Android1.0.316-26100312-16 and
  independent synthetic vaults on the shared AVD.
- The first test APK build failed on a missing import (fixed in the extension
  test) and an unrelated Android test compilation error. Two subsequent targeted
  builds compiled, but source changes during both runs and app/test APK changes
  during the third run invalidated provenance. All failed evidence is retained.
  Once the other task finished, the fourth build passed in6m46s with unchanged
  source/APK/boot invariants. The targeted test APK was then installed and both
  actual Android application tests passed.
- The separate `--gpg-fields` Edge runner now includes synthetic KDBX API address
  flows. Its `apiAddressFile` report is explicitly separate from the pending
  application `apiAddress` report and cannot substitute for Android readback.
- Final combined Edge `run-XXq0Qa` passed all eight API records: unchanged
  arbitrary values, relative rename, service edit, protected clear, cancellation,
  new localhost address, UI export/second-source reopen and browser restart.
  The 320px create screenshot was inspected; console errors were empty and
  Native Messaging registration restored. Export SHA256:
  `76170fde39a43bc873ca0a5c705b7a5633b06d6611c90902468c3feca49ceec1`.
- Final full regression after the marker fixes:188 files /1792 tests and build
  passed. One initial5000ms Bitwarden test timeout was retained; its10tests
  passed alone, then the whole suite passed with4workers and unchanged timeouts.

Raw logs: `.codex-tasks/android-interop-315/raw/api-address-*`.

## Actual Android application chain

Android's real API draft, PasswordViewModel, native repository and Room reopen
produce7samples. Edge `run-t9DxUi` imports them, renames the relative address,
edits the service address, clears a protected address, cancels a protocol change
and creates an eighth localhost address. All8survive browser restart. Android
imports that exported database, verifies addresses/secrets/app metadata and
changes the service endpoint to `staging service: returned`. Final Edge
`run-aEvj5s` verifies the returned records,320px editor cancellation and restart.
Both Edge runs have no console errors and restore Native Messaging registration.

| Artifact | SHA256 |
| --- | --- |
| Android input MDBX | `8f9277505b524cc6a4ad49e1ee49f14b551c30935d364f789b4ed55aac8d1d48` |
| Edge export / Android import | `42f80bb06f33519a2155ce2bb8e96feb4ad8051ca231cb3615c4fa1d44e91e3b` |
| Android return / final Edge import | `2ad9288b6d8abe38db4b7bcdc8f73695005c57e34a1bb84716356a472b2f4999` |

The first actual Edge run `run-iPb3XZ` exposed an additional defect: empty email
became undefined after native reload. The shared native/ZIP password projection
now preserves empty text for11contact/address/payment fields. Four regressions
initially had2failures;53targeted cases,189files/1796full tests and the build pass.
The successful chain above uses that final build. Snapshot JSON omits only
undefined properties; explicit empty strings and null are still compared.

This is Android application repository/Room evidence, not Android screen
interaction or all-type/all-backend acceptance. Android's own API draft trims
outer whitespace and regenerates its type/address carriers on an address edit;
the return check allows that behavior only for the edited service record's API
carriers, while checking its other fields. Full parity remains incomplete.
