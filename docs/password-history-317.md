# Password history: extension implementation and acceptance

Each password row now captures its previous nonblank password in the same encrypted transaction as the edited password and provider mutation. The history timestamp is the change time. Consecutive saves before synchronization retain the intermediate values; reused passwords can appear again. Only the latest equal historical password suppresses a duplicate, matching Android's snapshot rule. Histories remain private to their password row, including project edits.

The subsequent [native transport audit](password-history-native-317.md) adds MDBX2 transfer guards: a fresh native destination cannot preserve this history, so copy/cross-vault move is blocked before writes instead of relying on the local overlay. Same-object folder moves retain local history.

An older editor snapshot cannot replace current history. Imported histories longer than Android's local ten-record retention are preserved instead of silently truncated. History is separate from KeePass/MDBX whole-entry version history. It is also separate from the password generator's history.

The detail page starts with history collapsed and values masked. It supports independent reveal/hide, exact-text copy and confirmed deletion of one row. Deletion checks the current item version and index under the mutation lock; later edits, deletion, conflicts and pending project operations refuse the request. A failed encrypted write changes neither password nor history. Only the manager may invoke the new command. Dates order the displayed rows while deletion uses the original array index. Closing the section or changing records masks revealed values again.

[Editable local Canvas](design/password-history-317.md) and its JSON are retained. The actual 320px Edge rendering was inspected; long passwords wrap, user text does not become HTML, and all actions remain reachable. The six additional locale catalogs currently use English fallback for the new strings.

| Source | Implemented behavior | Acceptance boundary |
|---|---|---|
| Local encrypted vault | Capture, show/copy/delete, encrypted restart | Real Edge editor and full browser restart passed |
| Android ZIP / Monica WebDAV codec | Reads and writes `password_history.json`; saves change time; avoids double capture; preserves exact Long owner IDs, zero timestamps, casing, unknown fields, malformed rows and rows beyond the projection limit | Codec checks and subsequent actual Android targeted MDBX/KeePass ZIP import/update/export/independent return passed; live WebDAV history remains separate |
| Bitwarden native history | Decrypts `PasswordHistory` using the actual per-cipher key; encrypts imported/new histories; reuses unchanged ciphertext and unknown properties; retains unreadable records on same-source edits | Subsequent live Vaultwarden, actual Edge UI and fresh browser profile passed; Android native Bitwarden history sync remains unverified |
| KeePass and MDBX | Keep the local password-history overlay during provider refresh/reopen | Actual Edge KDBX same-source restart passed; MDBX provider test passed; fresh-client/Android password-history transfer is not implemented by these local overlays |

If a history is partly unreadable or exceeds the ZIP projection limit, the model records that the projection is incomplete. The original source retains unprojected rows. A fresh destination must not accept a partial projection as a complete transfer; these writes fail before changing the destination. An unreadable ZIP history container can survive unrelated edits, but a password/history change refuses to overwrite it.

Android source trace: `PasswordViewModel.savePasswordHistorySnapshot` stores the old nonblank value at change time, skips only a matching latest record and trims local Room history to ten. `PasswordHistoryDao` orders newest first. ZIP backup/restore explicitly carries history. This source inspection does not establish current Android runtime behavior or a native KDBX/MDBX/Bitwarden history mapping.

Validation:

- Full regression: 230 files / 2362 tests passed. Both TypeScript projects and production build passed; strict E2E TypeScript passed. Security audit: 195 runtime commands.
- Actual Microsoft Edge 154.0.4258.53: two scenarios passed, each including a complete browser restart. Editor saves, masking, exact copy, safe text rendering, 320px layout, accessibility scan, cancel, single delete, disabled repeated deletion, delayed deletion versus later edit, stale-version rejection and popup denial. The second scenario checks local history across encrypted KDBX export/reopen/sync.
- Accepted evidence: `.tmp/password-history-edge-317-accepted/`; logs and SHA256 manifest: `.codex-tasks/android-interop-315/raw/password-history-317-*`.
- Initial red tests: five service cases and eight codec cases. An intermediate assertion incorrectly searched for `old` anywhere in JSON (matching `folderId`); corrected to check the exact plaintext value. Initial Edge timeout used the obsolete editor title `编辑登录项`; trace showed the actual `编辑密码` dialog. Failures remain recorded.

This initial extension history batch did not change Android sources, builds or devices. [The subsequent live/Android batch](password-history-live-317.md) records actual Vaultwarden/Edge and Android ZIP acceptance, its product fixes, exact APK/source provenance and remaining limits. The overall Android interoperability objective remains incomplete: native history transport, previous Android Passkey defects, full attachment/field acceptance and actual OneDrive sign-in remain open.

Cache cleanup after acceptance removed 91,890,062 logical bytes; all 2603 protected file hashes stayed unchanged. Native compiler caches were not rebuilt. The cleanup report and script are retained with the batch logs.
