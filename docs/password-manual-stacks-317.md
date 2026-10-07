# Manual password display stacks

The password list supports **Manage stacks → Create a manual stack / Never stack / Restore automatic stacking**, with an optional **Manual stacks only** display mode. Selection operates on complete password projects, including all passwords within an explicit `passwordGroupId`. It preserves password values, ordinary custom fields, project membership, content, attachments and credential ordering.

The dialog captures project members and revisions when opened. Search keeps selected projects selected, cancel/Escape writes nothing, and stale or changed membership requires reopening. Manual stacks stay within one password source/database; never/automatic settings can apply to projects from different sources. The service validates the entire selection before one encrypted commit containing both updated fields and provider sync intents. Popup senders cannot invoke the new command.

## Android field contract and limits

- `__monica_manual_stack_group` stores the exact nonblank manual stack ID.
- `__monica_no_stack` enables never-stack for any value except `"0"`, including an empty string, matching Android's current custom-field reader.
- Never-stack takes precedence. Display grouping keeps whole explicit password projects. Conflicting manual IDs within one project, duplicate carrier fields, protected carriers and unsupported field types display as unsupported; the UI disables these projects instead of silently repairing their data.
- Changing a setting edits only these reserved fields. Existing carrier attributes and unrelated internal fields survive. Ordinary editors hide the reserved fields using the existing internal-data presentation.

These portable custom fields are distinct from Android's local aggregate-stack table, its ordering and explicit password project membership. This batch does not synchronize that table or Android display preferences. Browser display preferences remain encrypted local state.

## Validation

| Layer | Result and evidence |
| --- | --- |
| Focused model/service/codec regression | 5 files, 37 tests passed; `raw/password-manual-stacks-regression.log`. Includes precedence, exact IDs, unknown/protected preservation, all-member atomic changes, stale/new members, no-op, failed-save preservation, provider queue and encrypted restart. |
| Format transport | Actual encrypted KDBX and Bitwarden cipher codec roundtrips, Native payload and Android ZIP retain and clear existing markers. These are codec tests, not Android application or live cloud acceptance. |
| Consolidated extension suite | 224 files passed; the language suite initially failed one completeness assertion (2310/2311 tests passed). Two missing translation keys were added, and the complete language suite reran successfully (28/28). Only catalogs changed after that full run. Both original failure and successful rerun remain in `raw/password-manual-stacks-full-tests.log` and `raw/password-manual-stacks-i18n-final.log`. |
| Type/build/security | Both project TypeScript configurations, separate strict E2E types and production build passed. Final audit checks 192 runtime commands; `raw/password-manual-stacks-build-final.log`, `raw/password-manual-stacks-edge-types.log`, `raw/password-manual-stacks-security-final.log`. |
| Real Edge extension | Two scenarios passed: previous automatic-display/cover regression and new manual-stack acceptance. Exact all-member contents, search selection, cancel/Escape, unsupported metadata, manual/never/auto, stale snapshot rejection, popup denial, encrypted restart and real 1180/420/320 interactions. `.tmp/password-manual-stacks-edge-317-final`, `raw/password-manual-stacks-edge-final.log`. |
| Design/rendering | [Editable local Canvas](design/password-manual-stacks-317.md); source JSON and rendered frames retained. Final real Edge wide/narrow dialog and result screenshots inspected separately. |

The first Edge run reached the complete narrow-screen operations and stale rejection, then attempted to click a hidden desktop navigation item after reloading at 320px. The fixture now restores the desktop viewport for that navigation step. It did not bypass or weaken the narrow-screen interaction assertions. Its failure trace and screenshots remain preserved. The initial build's duplicate translation key was also removed before the final build.

Android product sources were not edited or rebuilt. No emulator or cloud service was started. Actual Android consumption of these new fixtures remains pending. Known Android system Passkey defects and real direct OneDrive login acceptance remain open; this feature does not establish complete interoperability.

## Cache maintenance

After testing, 2,041 nonempty rebuildable browser cache directories were removed: 3,321,968,152 logical bytes, with 3,199,934,464 bytes of observed free-space gain. SHA-256 comparison confirmed that all 97,737 non-cache files in the affected profiles and current build/final acceptance files were unchanged. Vault-bearing browser storage remains available for reproduction. Empty GPU cache directories were left alone. Two initial attempts rejected unfamiliar cache paths during validation, before deletion; their diagnostics are retained.

The three recorded cleanup batches have removed about 16.4 GB of rebuildable data in total. No build was rerun to validate deletion. See `raw/password-manual-stacks-cache-cleanup.json` and the new `raw/password-manual-stacks-manifest.json` under the task directory; older manifests retain their original source/build provenance.
