# GPG field preservation

Changing only a GPG fingerprint or user ID previously regenerated every public
key carrier, moved them after unrelated custom fields and set their protection
to false. This also converted old unencoded public keys to base64 on an unrelated
edit.

`putGpgFields()` now updates only the changed fields in place. Public key chunks
and encoding stay exact when the key is unchanged. Existing field attributes and
order survive edits and explicit clears; absent optional metadata stays absent.
When the public key changes, obsolete chunks are removed, existing chunk
attributes are retained and new chunks inherit protection if an old chunk was
protected. Duplicate carriers are rejected before any source mutation.

KeePass and Bitwarden also used to replace the GPG/API type marker with a new
unprotected field at the front. They now let an existing valid marker pass
through the ordinary custom-field writer. Regression fixtures use protected
markers between other fields to catch both protection and order changes.

The format follows Android `GpgEntryFields`: public data uses ordered custom
fields; the private key remains in the password property. Android application
sources were not changed. This is data preservation, not GPG signing validation.

## Evidence

- Eight new core regressions initially produced six failures. All now pass.
- Four file/cipher tests cover KDBX 3/4, Bitwarden and Android ZIP metadata edits,
  protected empty values and reopen. They compare all custom fields, including
  position and protection, and the private key.
- Real Edge 154.0.4258.48 `run-kOzE5M` passed 320px fingerprint edit, user-ID clear,
  cancelled public-key replacement, UI export, second-source reopen and browser
  restart. Legacy public-key CRLF, tabs and chunk boundaries remain exact.
  Screenshots were inspected; Native Messaging registration was restored and
  console errors were empty.
- Full regression: 188 files / 1792 tests and production build passed.
- Final combined GPG/API Edge `run-XXq0Qa` passes against the marker fixes,
  including export/reopen and restart. Earlier `run-IQvZ7O` exposed a harness
  close/search timing issue; `run-jlp7JO` exposed the real marker reordering.
  Both failures are retained. Five strengthened backend cases initially failed;
  all eight backend cases now pass, comparing complete field arrays.

Reproduce the real Edge flow with `node scripts/interop-315-edge.mjs --gpg-fields`.
It generates independent synthetic KDBX inputs in its evidence directory. The
runner also covers eight API address records, separately reported under
`apiAddressFile`; these are file/browser tests, not Android application results.

Raw logs: `.codex-tasks/android-interop-315/raw/gpg-preservation-*` and
`credential-fields-edge.log`. Full Android application/backend/lifecycle parity
is still incomplete.
