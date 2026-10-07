# Android 1.0.317 MDBX password encoding

Current Android `Mdbx2Repository` treats
`monica_password_encoding: "plaintext-v1"` as an explicit statement that
`password_plain` contains the user's password. Without this marker, it may repair
an old installation-encrypted value that the current installation can decrypt.
A real ciphertext can itself be the intended password, so guessing solely from
the value can change a user's credential.

The extension now writes the marker on new login records and explicitly changed
passwords. It applies this after the codec's unchanged-field preservation. An
unrelated edit keeps legacy missing, null or empty markers exactly as received,
so it does not disable legitimate Android repair. Existing `plaintext-v1` values
remain literal. Unknown encoding values stay in the opaque read-only path and
cannot be rewritten through a forced login codec call.

The marker belongs to the native MDBX payload; it does not imply changes to
Android ZIP, KeePass or Bitwarden wire formats. The native vault remains encrypted.

Verification includes new/changed/empty passwords, legacy aliases, unrelated
edits and unknown encodings. The actual application fixture is in
`tests/interop/android317-password-encoding.interop.ts` and the extension-owned
`ExtensionAndroid315InteropTest`. Android generates a real authenticated
ciphertext; the extension writes it as two literal passwords and deliberately
seeds one historical unmarked repair control. Android must repair only that
control, preserve both literal strings through its password editor and reopen,
then export all three for independent extension readback. It also exercises
response loss after the actual Native Host commits the changed password.

Verification passed against actual Android `1.0.317-26100512-36`:

- 202 TypeScript files / 1947 tests passed, production build and both TypeScript
  configurations passed. Final interop-only typecheck also passed after harness
  normalization assertions were added.
- Android ciphertext generation passed in 2.239 seconds. The real Native
  prepare passed creation, changed-password encoding, response-loss recovery
  through a fresh provider and exact unchanged committed snapshot.
- Android import/repair/Room projection/`PasswordViewModel` editing/reopen/export
  passed in 3.859 seconds. Exactly one legacy record was repaired and both
  literal ciphertext passwords were preserved.
- Independent extension return passed, checking all three physical identities,
  native collections, password values and remaining payload fields individually.

The new, previously ungrouped singleton receives an Android project ID on edit.
Android also omits exactly six empty/null fields (`bound_note_entry_id`,
`bound_note_room_id`, `category_id`, `sso_provider`, `sso_ref_entry_id`,
`sso_ref_logical_id`) and its redundant root `mdbx_folder_id` payload property.
The native collection is still the same `.monica-root` collection. The fixture
checks each original empty/default value and each omission; it does not discard
arbitrary differences. The source Android row and legacy control require their
own exact comparisons. This is password-encoding proof, not full field parity.

Evidence directory: `.tmp/android-password-encoding-317`. Logs are under
`.codex-tasks/android-interop-315/raw/password-encoding-*`; final application
build is `android-build-3`, application import is `import-2`, independent return
is `return-2`, full regression is `full-2`, production build is `build-2`, and
final interop check is `interop-check-final-3`.

Application APK SHA-256:
`1c731442002c4ad678786573a6980e62098dd1bbd89d794707233321259b742f`.
Final test APK SHA-256:
`911b20055bf5b99d502c4c02ff52f992b61bbb97d66ac34e7e79ce51232dc250`.
Android revision: `63bb37b4f92f958d59a3a3aa5225a4ad20eb05d2`;
dirty diff SHA-256:
`a34176997e753a5a72afa95f6f22b2c845d3abb7a179178f0842add60f3b2101`.
Source, installed app/test package and boot integrity checks passed. No Android
product source was changed. Initial fixture/query/compiler failures and the
strict return comparison that exposed the above normalization remain in logs.
