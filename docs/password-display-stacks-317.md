# Password display stacks and cover transport

The password list now offers no grouping, website, title, app, first nonempty note line, folder, and smart grouping. Each display stack contains complete explicit password projects. Opening a row uses the existing project detail/editor, history, and attachment workflows. A display stack never creates membership, detaches passwords, or changes credential ordering.

Display groups are scoped to the provider/database. Same-named folders use their identities. Website display supports full hostnames and Android's primary-domain heuristic. This presentation logic is separate from autofill URL authorization and the public-suffix rules used there. A subsequent batch adds [manual stacks, never-stack and restore-automatic settings](password-manual-stacks-317.md), preserving this batch's historical evidence below.

The local encrypted preference stores grouping and website-match modes. It does not synchronize Android application display preferences. Existing installations default to no display grouping.

## Cover changes

Selecting a cover clears other active cover flags only in the same source with the **exact same website string**, as distinct from the normalized website label used for display. Archived/deleted records and other sources are untouched. Removing a cover changes only the selected item. The presentation chooses the marked representative without rewriting project member order or `sortOrder`.

`VAULT_SET_PASSWORD_COVER` is manager-only. The service requires the complete peer revision snapshot, validates it under the vault mutation lock, and writes all changed flags plus provider sync intents in one encrypted commit. Missing/new/stale peers fail before storage. A no-op does not write. Ordinary automatic synchronization receives this mutation like other item changes.

## Format boundaries

| Path | Representation | Current evidence / Android limit |
| --- | --- | --- |
| Extension encrypted state / JSON | optional boolean `isGroupCover` | True, false and absence survive; malformed snapshot values remain read-only opaque records. |
| Android JSON/ZIP | `isGroupCover` | Existing Android property; codec ZIP roundtrip verified. Current Android application restore of this new fixture is pending. |
| MDBX | `is_group_cover` | Extension transport metadata; current Android native mapper does not consume it as a cover flag. |
| KDBX, including WebDAV/OneDrive file contents | `MonicaGroupCover` | Extension transport field. Real encrypted KDBX3/4 read/write/history verified; current Android cover projection and cloud acceptance are pending. |
| Bitwarden | encrypted custom field `monica_group_cover` | Extension transport field. Encrypted cipher codec and durable fingerprint verified; current Android mapper does not consume it as a cover flag. |

Only exact `true`/`false` transport values in recognized text fields are managed. Unrelated edits preserve duplicate Bitwarden values, hidden protection, unreadable/linked/future fields and unsupported native/ZIP values. Conflicting unknown KeePass/native/ZIP cover formats are not overwritten by a cover edit. Older cached models that have no cover projection retain existing remote cover metadata.

## Validation

- Thirteen affected format/editor regression files: **317 tests passed** (`raw/password-cover-regression.log`).
- Five focused stack/service/preference/sender/transport files: **60 tests passed** (`raw/password-stacks-regression.log`); overlaps the transport file above, so these counts are not additive.
- Both TypeScript configurations and production build passed (`raw/password-stacks-build-final.log`); separate strict E2E TypeScript check passed. Security audit: **191 runtime commands**, including the new manager-only command.
- Real installed Edge extension in an isolated profile: grouping, search, explicit project-member retention, cover selection/unpin, exact before/after contents, strict/relaxed display, 1180/420/320 widths, narrow-width actual button clicks, popup-sender rejection and encrypted browser restart passed. Final run: `.tmp/password-stacks-edge-317-complete/`; raw log: `raw/password-stacks-edge-complete.log`.
- Local editable Canvas was rendered and inspected before application UI implementation: [design source and local link](design/password-stacks-317.md). Real Edge screenshots are separate evidence from Canvas.

Initial failures were test fixture/assertion issues: Bitwarden encrypted field object identity versus content equality, setup-normalized URI rules versus pre-setup fixture data, first displayed stack versus the intended website stack, and PowerShell splitting the E2E type-list argument. Initial narrow screenshots exposed clipped group counts; supporting text now wraps. The first icon generation attempt found missing global Python Brotli; the existing pinned `.tmp/icon-font-tools` environment successfully regenerated the subset. Failure logs remain available.

This batch did not rebuild Android, start an emulator/Docker service, alter Android sources, or claim real OneDrive/Bitwarden/Android backend acceptance. The main interoperability goal remains active, including the known Android system Passkey failures and pending direct OneDrive sign-in acceptance.
