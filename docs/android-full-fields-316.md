# Current Android full-field ZIP verification

Scope: actual Android application export, current browser ZIP codec edit, Android
targeted restore into an independent native vault, and returned ZIP readback.
This is not Android/Edge screen acceptance or the entire field/backend matrix.

The fixture contains10passwords and10SecureItems: an explicit three-password
group, two same-title independent logins, Wi-Fi/SSO/SSH/GPG/API logins, five OTP
types, card, note, document, billing address and payment account. Embedded card
and note copies, future content metadata, large HOTP counters and3attachments
are included. No user vault is used or cleared.

## Current evidence

- Fresh installed application `1.0.316-26100312-23` was verified against the
  existing x86_64 APK (SHA-256
  `405bd864bb76fea9cb3ee17a3b2bdc7b4099bb215f8d1bc56960a0e1f40dcee6`). In
  `.tmp/android-full-fields-316-23`, targeted test build, installation, actual
  export and the forward browser codec test passed. Android/test sources,
  installed APKs and device boot remained unchanged.
- This fresh Android restore failed full raw JSON comparison: the first
  unbound OTP received `boundPasswordId`, `categoryId`, `keepassDatabaseId`, all
  `null`. This is explained by `BackupRestoreApplier.kt:462` calling
  `PortableTotpBackupCodec.withBindings`. The latter writes those three routing
  properties explicitly. The observed failure contains no changed original
  value; it does not establish that all subsequent records pass.
- The revised assertion checks the complete original payload plus exactly those
  missing null properties for OTPs. It never removes keys from comparison,
  ignores arbitrary nulls, converts numbers, or changes original values. Other
  secure types still require full JSON equality. Its report records the explicit
  defaults. The fresh chain in `.tmp/android-full-fields-316-23-bindings`
  completed build/install/export/forward/Android restore and re-export, with all
  provenance checks passed. Earlier failed evidence remains untouched.
- Return verification now checks the membership relationship of every pair of
  login records, including same-title independent records, in addition to all
  content properties and owner-matched attachment bytes. Interop TypeScript
  validation passed. The new credential-group metadata is not in this corpus.

### Returned archive result — incomplete

The final browser readback is **failed**, with four differing records. It checked
all 20 decoded items before reporting the differences, and independently passed
all login membership pairs, distinct same-title identities, and three attachment
owners/sizes/SHA-256 values. Every other decoded content property compared equal.

- Three grouped logins lose `passkeyBindings`. The fixture contains
  metadata-only references, not actual private keys or Passkey records.
  `credentialexchange/ImportDestination.kt:33` explicitly clears this field on
  target import. This proves metadata does not survive this route; it does not
  prove loss of an actual Passkey key pair. A real-key relationship scenario and
  an explicit destination reconstruction policy remain required.
- The Steam sample changes algorithm/period from SHA256/45 to SHA1/30.
  `utils/WebDavHelper.kt` calls `normalizeRestoredTotpItemData`, which explicitly
  sets Steam to five characters, 30 seconds and SHA1. This is Android's intended
  Steam normalization, rather than unexplained corruption. The strict content
  preservation test retains the difference and is not counted as passing.

Artifacts: `zip-evidence.json` (passed Android application stage),
`extension-zip-readback.json` (including the five explicit null-binding additions),
and `zip-return-codec-evidence.json` (failed final content check with all four
records listed) in the fresh directory. Logs are
`raw/full-fields-23-bindings-{build,install,export,forward,zip,return-diagnostics}.log`.
The test APK SHA-256 is
`53acc2575bcccb3901db73239d187bcdea06ce77d9070756b0efd24d80f965fe`.
Android sources were not edited. No all-backend, new credential-group or screen
acceptance is implied by these results.

## Earlier attempts

- Android1.0.316-26100312-16 created/exported the20records. The browser decoded
  them, authenticated attachments and changed titles. It verified that every
  other raw record property and all non-record ZIP members remained unchanged;
  wrong-password rejection and output encryption checks also passed.
- First targeted Android restore attempt failed in a newly added test assertion:
  the expected type was a string and the actual type was an enum. Both were NOTE.
  The assertion now compares the enum name. This does not establish a restore
  pass. The corrected test rebuilt successfully and was installed.
- The test now compares every restored SecureItem type and full JSON payload,
  preserving array order, and exports `extension-zip-return.zip` for browser
  readback. Returned content/group/attachment assertions are not yet passed.
- The second export's instrumentation passed, but its runner rejected acceptance:
  Android source state changed during the run. The Android `main` task was
  confirmed active and editing sources. Application/test APK and device boot
  stayed unchanged. The failed provenance result is retained; downstream
  Android restore has not been retried with this export.
- Forward codec acceptance now requires a passed export, unchanged source/APK/
  boot checks, and matching archive hash. Return acceptance additionally links
  the export evidence hash and all build/export/restore provenance. The failed
  second export is correctly rejected (`full-fields-provenance-rejection.log`).
  A separate copy of the valid first export passed the strengthened forward
  test (`full-fields-provenance-positive.log`, 20 records). This only verifies
  forward acceptance; it is not a successful four-leg chain. Interop TypeScript
  and runner syntax checks passed.
- Fresh outputs: `.tmp/android-full-fields-20261003`. First-attempt artifacts
  are retained in its `attempt-1` directory; raw logs are under
  `.codex-tasks/android-interop-315/raw/full-fields-*`.

## Independently reproduced Android writer gaps

Both tested applications (`1.0.316-26100312-16` and
`1.0.316-26100312-23`) report `customIconPresent=false`,
`ssoProviderPresent=false`, `ssoReferencePresent=false` after writing the fixture
through its PasswordViewModel and native repository. Wi-Fi metadata is present.
An ordinary Android title edit removes the injected `future_315` payload field
while preserving the entry identity. Exact evidence is in
`android-writer-gaps.json` and `android-known-field-writeback.json`.

Android sources remain read-only. These gaps remain explicit even if the ZIP
chain succeeds: preservation of what Android exported does not prove that its
writer exported every value supplied to it.

## Reproduction

Set `MONICA_315_APP_FIXTURE` to an independent output directory,
`MONICA_MDBX2_INTEROP_SERIAL=emulator-5554` and
`MONICA_APP_INTEROP_TEST_SET=full-fields`. Reuse the public AVD. Run each stage
separately and inspect its evidence before dependent steps:

1. `node scripts/interop-315-android-app.mjs build`
2. `node scripts/interop-315-android-app.mjs install-test`
3. `node scripts/interop-315-android-app.mjs export`
4. `npx vitest run --config vitest.android315-zip.config.ts tests/interop/android315-zip.interop.ts`
5. `node scripts/interop-315-android-app.mjs zip`
6. `npx vitest run --config vitest.android315-zip.config.ts tests/interop/android316-zip-return.interop.ts`
