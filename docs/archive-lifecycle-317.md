# Archive lifecycle consistency

The extension's archive action previously called the general item-save API with the entire displayed record and no version check. Two regression tests reproduced losing a concurrent edit and resurrecting a record deleted before the request completed. `VAULT_UNARCHIVE_ITEM` now accepts only the selected ID and its expected version. The service reads current state under its mutation lock, refuses stale/deleted/missing/protected/conflicted records and pending project operations, and atomically changes availability with its sync intent. Other fields and other password rows stay intact. Repeated clicks are disabled while the request is pending, and failures are shown in the existing notice area.

This follows the selected-record scope in current Android `PasswordViewModel.unarchivePasswordsInternal`: fetch the selected current entries, exclude deleted rows, then unarchive each entry. It does not infer selection from a shared title or silently expand an action to the whole project.

## KeePass finding and boundary

Two further red tests showed that `KeePassProvider.update` dropped `archivedAt` immediately when projecting a rewritten KDBX entry. Sync or working-copy reopen could therefore reactivate an archived password or Passkey. The provider now retains this local overlay, as it already does for the browser's local favourite state. Explicit unarchive clears it.

Current Android KeePass archive handling stores local `PasswordEntry.isArchived` and `PasswordArchiveSyncMeta`, and moves the KDBX entry to an archive group. Its unarchive path uses the locally recorded origin group, falling back to root. Neither the current field writer nor the extension's KDBX field reader provides a portable archive flag/origin pair. This change protects the existing extension vault's state; **a fresh import into another client is not proven to preserve archive availability**. No archive convention is inferred from an arbitrary folder name, and no new browser-only wire format is claimed as Android parity. Cross-device archive state remains a separate Android-side compatibility gap.

## Verification

All logs below are in `.codex-tasks/android-interop-315/raw/`.

- `unarchive-317-red.log`: two pre-fix stale/deletion failures.
- `unarchive-317-keepass-red.log`: two pre-fix password/Passkey archive-loss failures.
- `unarchive-317-regression-final.log`: 3 files / 64 tests passed. Coverage includes exact selected-row scope, five provider kinds, current-field preservation, mutation intents, stale/deleted/missing/locked requests, encrypted write failure/retry, pending project removal, actual retained-item conflict, encrypted KDBX reopen and HOTP regressions.
- `unarchive-317-full-tests.log`: 227 files / 2346 tests passed.
- `unarchive-317-build.log`: both TypeScript projects and production build passed. `unarchive-317-e2e-types.log`: strict E2E types passed. `unarchive-317-security.log`: 194 runtime commands passed the release audit.
- `unarchive-317-edge.log`: two real headed Microsoft Edge scenarios passed. `.tmp/unarchive-edge-317/` retains browser provenance, per-scenario evidence JSON, a synthetic encrypted KDBX and a screenshot. The first scenario delays the actual unarchive request, edits or deletes through the real manager API, verifies rejection and explicit retry, and closes/reopens Edge. The second imports a password and real generated ES256 key through encrypted KDBX, archives both, synchronizes, confirms both are excluded from candidate queries, restarts Edge, reopens the exported encrypted file in the same source and confirms exclusion again. Explicit unarchive plus sync restores both candidate lists; the credential ID, private key and counter remain unchanged.

The Edge candidate checks concern availability, not a new RP signature or Android authentication claim. No Native Host rebuild, Android source edit, device operation, cloud login or publication occurred. Existing Passkey and OneDrive acceptance limits remain open.

Early fixture failures remain in `unarchive-317-regression.log`: the removal fixture lacked required credential metadata, and an empty incoming sync list removed the record before the conflict guard could be tested. The final fixtures retain actual records and assert their presence. The earlier HOTP conflict case was strengthened the same way; it now exercises the conflict guard rather than incidental missing-item rejection. No product assertions were weakened.

After acceptance, browser test caches totalled 19,766,574 bytes. The large compiler caches removed in earlier batches were not rebuilt. This small cache was left for the next substantial cleanup, in line with the user's preference to batch work; all vault-bearing profiles, KDBX fixtures and evidence remain intact.
