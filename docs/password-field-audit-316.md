# Current password field audit — Android 1.0.317

2026-10-06 KeePass project update: [actual writer, fresh import and Edge acceptance](keepass-project-credentials-317.md). Explicit KDBX credential metadata now restores extension project membership and supports grouped editing/additions. Android fresh KDBX import retains every tested rich field but loses outer grouping (two projects become four); this is a recorded failure, not bidirectional completion.

Source inspection started 2026-10-02 and continued against 1.0.317 on 2026-10-04. Android main remains read-only. This table describes
the current `PasswordEntry` model and browser operation gaps; it is not an
acceptance pass list. Historical reports contain earlier baselines and must not
be used to infer current end-to-end coverage.

2026-10-06 lifecycle update: [archive consistency](archive-lifecycle-317.md)
replaces the stale unarchive snapshot with a versioned selected-record operation
and retains local KeePass password/Passkey archive state across sync and reopen.
Actual Edge candidate exclusion, explicit restoration and browser restart pass.
Fresh-client KDBX archive transfer remains unproved because the current Android
workflow keeps archive state/origin locally and moves the entry's group. This is
not a portable archive flag shared by all clients.

The 2026-10-04 browser changes now reconcile explicitly edited common project
fields across all known credential groups. Group order and password order are
editable with keyboard/pointer controls; extra groups participate in the same
content order as notes/payment/key blocks while the primary group stays first.
Row identity, private content, histories and attachment ownership are unchanged.
The application-order chain now passes with ten rows on actual Android
1.0.317-26100412-18, followed by exact returned-data inspection in Edge
run-tPegHT. Earlier attempts rejected source/package drift and remain retained.
See `project-common-fields-and-order-317.md` for precise scope and evidence.

The Bitwarden grouping gap found in Android `CipherSyncProcessor.kt:345` is now
fixed: the extension derives `passwordGroupId` from valid explicit project
metadata and permits complete group saves within one provider scope. Encrypted
codec/service tests, real Vaultwarden sync, Edge creation/edit/cancel/restart,
and independent server readback pass (nine records, project sizes 6/2/1).
Actual Android app `1.0.317-26100412-22` now downloads/edits/uploads these projects
and restores them after fresh download. Independent extension readback plus
real Edge run-0wCA7x verifies Android's changes, order, cancellation and restart.
See `bitwarden-project-credentials-317.md` for the precise scope: Android's
storage/writer/sync APIs were exercised, not its full screen workflow.
KeePass grouping needs its own actual Android importer trace; metadata retention
alone is insufficient evidence for that backend.

Explicit singleton projects now use complete membership checks on local/MDBX/
WebDAV/Bitwarden saves. Details distinguish credential groups from password rows,
retain keyboard selection, and use actual Android-return row identities and order.
See `password-project-singleton-and-detail-317.md` for verification and scope.
Partial-row removal now has an internal encrypted transaction, shared-owner
content planner and attachment copy/readback preparation. Ordinary sync blocks
unfinished deleting records until a provider can verify attachments in its
deletion transaction. Remote deletion, recovery wiring and editor remove/undo
remain open. See `password-project-removal-317.md` for the tested foundation and
remaining provider gates. The full backend/lifecycle matrix is still incomplete.
MDBX2 now has a deletion revision guard checked inside the engine transaction,
proven by actual cross-connection and Native process attachment-change/restart
tests. Its removal-coordinator journal wiring is next; see
`mdbx2-project-removal-revision-317.md`.

| Android fields | Browser representation / operations | Remaining evidence or gap |
| --- | --- | --- |
| title, website, username, password, notes | LoginItem, URI rules, shared create/detail/edit form; source-aware unrelated edits | Full lifecycle/backend matrix with all other fields present together |
| email, phone, addressLine, city, state, zipCode, country | Supplemental contact/address fields in model, editor and detail | Actual Android application return from every backend; arbitrary text must survive |
| creditCardNumber, creditCardHolder, creditCardExpiry, creditCardCVV | Supplemental payment fields, hidden number/CVV, native/ZIP/KDBX/BW adapters | Full actual application matrix; distinguish these fields from embedded wallet snapshots |
| appPackageName, appName | Application binding editor/detail, native and backend text metadata | Native Edge checks exist; all backends and Android screen return are not complete |
| authenticatorKey | Embedded `totpSecret` plus linked standalone authenticator | Exact HOTP Long, parameters and coexistence tests exist; full application lifecycle matrix incomplete |
| passkeyBindings | Ordered binding metadata editor, preserving unknown JSON; separate signing credentials | Android KDBX password-binding carrier missing; metadata does not prove signing or private-key portability |
| sshKeyData | Full SSH editor, exact known/unknown JSON handling; native/ZIP/KDBX/BW adapters | Actual Android service/screen matrix; metadata-only and future SSH JSON lack complete Android KDBX transport |
| loginType | PASSWORD, SSO, WIFI, SSH_KEY, GPG_KEY, API_KEY, BARCODE and Steam handling | All subtype/backend operation combinations still need direct evidence |
| wifiMetadata | Structured security/EAP/proxy/IP/MAC form, raw future-data preservation | Native current-app fields and Edge edits verified separately; full bidirectional screen coverage remains |
| ssoProvider, ssoRefEntryId | Provider label and stable relationship selection; Room ID kept as a projection | Current native Android writer still omits old SSO metadata; stable cross-vault operations have separate evidence |
| customIconType, customIconValue, customIconUpdatedAt | Icon picker, attachment ownership and native/remote icon carriers | Android native writer omissions; all image/backend/lifecycle variants not proved |
| passwordGroupId | Explicit same-vault membership, multi-account editor, group operations and detach | No inference from shared titles; all backend/group lifecycle combinations incomplete |
| isGroupCover | Explicit model field and versioned website-group cover selection; automatic/manual/never display grouping implemented | See password-display-stacks-317.md and password-manual-stacks-317.md for Edge and carrier evidence. Android native writer/aggregate-table limits remain; no complete wire parity claim |
| isFavorite, sortOrder, isDeleted/deletedAt, isArchived/archivedAt | Favorites, order metadata, trash and archive operations | Whole-project lifecycle/failure matrix still incomplete; order metadata alone does not prove matching drag behavior |
| boundNoteId | Stable `boundNoteEntryId` plus optional Room projection; picker/detail and transfer dependencies | Native and ZIP note return evidence exists; full backend coverage remains |
| id, replicaGroupId | Local item ID, source references, stable logical identity | Ordinary Android edits can remap Room IDs; compare stable native identities separately |
| categoryId | Category model/source paths | Full hierarchy and move/conflict matrix incomplete |
| keepassDatabaseId, keepassGroupPath, keepassEntryUuid, keepassGroupUuid | KeePass provider identity and grouping | Provider-local IDs are routing metadata, not shared global database identities |
| mdbxDatabaseId, mdbxFolderId | Native provider binding and collection | Authentication-bound vault identity verified; complete folder/lifecycle matrix remains |
| bitwardenVaultId, bitwardenCipherId, bitwardenFolderId, bitwardenRevisionDate, bitwardenCipherType, bitwardenLocalModified | ProviderRef/account routing, cipher identity/type/revision and pending mutations | Do not transplant Android-local numeric account IDs; explicit pending-sync and conflict semantics need full real-service coverage |
| createdAt, updatedAt | Browser timestamps and original backend source metadata | Native summary creation-time availability and all conversion paths need explicit evidence |

Associated password content lives outside `PasswordEntry` in ordered custom
fields: GPG public-key chunks/fingerprint/user ID; API address/type; arbitrary
custom fields; repeatable credential blocks; embedded wallet/note snapshots and
their attachments; content ordering. These must be covered as password data,
not counted as complete merely because the base entity maps.

The current API address correction is documented in `api-address-parity.md`.
`ApiKeyEntryFields` explicitly distinguishes recorded addresses from navigable
URLs; the browser had conflated them and also rewrote field protection/order.
The API application chain now passes for8records through Android repository/Room,
Edge edits/export/restart, Android import/edit/export and final Edge reopen.
It exposed empty supplemental strings becoming undefined after native reload;
the shared native/ZIP password projection now retains explicit empty content.
Full Android screen and backend matrices remain separate.

GPG fingerprint/user-ID edits previously changed chunk order, encoding and
protection. `gpg-field-preservation.md` records the correction and core,
file/cipher and actual Edge evidence. Android application GPG readback and full
backend/lifecycle coverage remain separate.

The active work remains in `.codex-tasks/android-interop-315/TODO.csv`, rows 16,
18–21 and 23. Full parity remains unproved.

## 2026-10-03 project credential groups

Current Android `ProjectCredentialGroup.kt` introduces a separate
`monica.content.credential` field: version, optional projectId, groupId,
passwordId, label, primary, groupOrder and passwordOrder. This represents
multiple credential groups within one explicitly grouped project, with multiple
password records and a shared username/OTP in each credential group. It is not
the older repeatable `monica.content.block.*` format.

The extension now reads current canonical metadata without rewriting its raw
JSON, and orders explicitly grouped list/detail members by groupOrder then
passwordOrder. Unknown/mixed metadata or duplicate password identities retain
legacy ordering. Neither metadata nor matching titles establish membership;
the existing explicit project and provider/database boundaries still apply.

Verification: 14 core cases and 5 adapter cases added; all 191 files / 1815
tests and production build passed. Adapter tests cover native, ZIP, KDBX 3/4
and encrypted Bitwarden cipher ordinary title/password edits, preserving the
raw metadata, future large integer and field protection. These are codec/file
tests, not Android application or Edge acceptance. Logs:
`raw/project-credentials-tests.log`, `raw/project-credentials-build.log` under
the active task directory. Android source SHA256:
`cdb54cd805ba008fc74b650176ba8234f1ed0c07c609079f069ffb3262c136dc`.

Still required: Canvas and native browser UI for grouped credential labels,
shared username/OTP and multiple passwords; create/edit/add/remove/reorder and
detach semantics; Android application and actual Edge bidirectional tests.
The existing UI still describes every password record as an account. Shared
username/OTP edits need group-aware handling to avoid creating conflicting
Android credential groups. Plain metadata transport is not feature parity.

### Shared account/OTP edit correction

Ordinary browser group saves previously changed only the selected row's OTP or
username, leaving siblings in the same Android credential group inconsistent.
The encrypted group-save transaction now reconciles changed username and
`totpSecret` values across existing members of that credential group. Passwords,
raw metadata and other credential groups remain unchanged. A secondary password
row can initiate the shared edit. Conflicting drafts or conflicting pre-existing
shared values reject the write; unrelated edits do not discard existing values.
Legacy projects without credential metadata retain their previous behavior.

Core and encrypted-storage tests verify clearing OTP, secondary-row edits,
conflict/no-write behavior, scope isolation, independent password retention and
lock/reopen persistence. All 192 files / 1820 tests and production build passed;
logs `raw/project-credential-edits-tests.log` and `raw/project-credential-edits-build.log`.
Actual Edge and Android application coverage for this change remains pending.

The component-based 320px editor draft is saved in
[project-credentials-316.md](design/project-credentials-316.md), with a local
editable Canvas link. Real Edge Canvas rendering was inspected in
`raw/canvas-projectcredentials316.png`; `raw/canvas-project-credentials.log`
records the run. The new grouped native browser form remains to be implemented.

### Existing project credential editor — 2026-10-03

The browser now renders recognized Android credential groups with one shared
username and embedded OTP, and separate password controls ordered by Android
metadata. It retains the established form for legacy, duplicate, unsupported
or conflicting metadata. The draft edits only intended fields and never mutates
its original snapshots. Save/Cancel use the existing encrypted transaction.
Group labels are displayed; label editing, adding/removing/reordering groups or
passwords, and creating these groups from scratch are still outstanding.

Actual Edge run `run-U00ozc` passed at 1280/420/320px: three synthetic records
were explicitly imported through the runtime as fixture setup, followed by
rendered UI edits, clearing the first group's OTP, changing the second group's
OTP, changing one password, cancellation and browser restart. Exact metadata
was retained, console errors were empty and Native Messaging registration was
restored. This is browser UI evidence, not Android application import/export.
The final 320px screenshot was inspected: 12px outer gutters, joined fields,
24px outer corners/4px inner corners, visible Save/Cancel and no horizontal
content overflow. The local Canvas remains linked in the design document.

The first Edge run used an incorrect navigation locator. The second exposed a
real empty-OTP bug: the main form converted clearing to undefined while sibling
rows retained an empty string. The form now submits the explicit empty string;
unedited absent source values are still restored by preserveLoginFormSource.
The third Edge run passed. All failed artifacts are retained.

The first full suite caught missing offline translations for the two new
labels. All six offline catalogs are now updated; 42 localization tests pass.
A subsequent full run had five 5-second crypto timeouts with no assertion
failures. The reduced-concurrency full rerun retains original timeouts and
assertions; all 193 files / 1822 tests passed in 65.08s. Final production build also passed.

### Add a password to an existing credential group

The grouped editor now exposes the Canvas `Add password` action for supported
local/native/ZIP-backed projects. It appends a draft password with a fresh item
ID and Android passwordId, the same group identity, and the next passwordOrder.
Username and OTP follow the shared group draft. Existing source fields and
snapshots are unchanged; unknown metadata is not transplanted to a new identity.
The existing 100-record project limit is respected.

On save, the new row receives common project text/contact/address/payment and
folder/database scope from the edited project. Its remote IDs, source envelope,
replica identity, password history and old image references are not copied.
The whole project still saves through the existing optimistic concurrency and
single encrypted-write path. Cancelling the editor discards additions.

Five focused form/new-record tests passed. Full suite: 194 files / 1825 tests
passed with two workers and original timeouts. Actual Edge `run-6sIEv3` verified
adding password 3, unchanged old metadata, distinct password identity/order,
shared account/OTP, save/reopen, cancelled further addition, and full browser
restart with four records. Synthetic initial setup used runtime import; edits
used the real UI. Native registry restored, no console errors. Button shape was
subsequently adjusted to match Canvas; final Edge run-dw00k5 passed and its 320px screenshot was inspected. Final build passed; registry restored and console errors empty.

Still pending: adding credential groups, creating grouped projects from scratch,
label editing, password/group reorder, explicit removal and remaining-record
transitions, and actual Android/backend bidirectional acceptance. Current tests
do not establish those behaviors.

### Create and extend credential groups

New unsaved PASSWORD drafts can now use `Add credential group` to create a
primary and a secondary group with a shared projectId and distinct group/password
UUIDs. Existing recognized groups can append another group. Each group can add
passwords and edit its label, username and embedded OTP. Label writes use lossless
JSON and retain unknown fields, numeric lexemes and custom-field attributes.
An unchanged label leaves the original value intact. Original snapshots remain
unchanged; existing secondary-row label changes are included in the group save.

Actual Edge `run-YUIDjs` passed the existing import/edit/add/cancel scenario plus
pure UI creation of a new two-group/three-password project, reopening, renaming
the primary group and appending a third group. The final two synthetic projects
contain eight records and survive browser restart. Initial imported fixture setup
uses runtime import; the second project is created entirely through the rendered
UI. The 320px creation screenshot was inspected. No console errors; temporary
Native Messaging registration restored. Build and 34 focused form/localization
tests passed. Full regression: all 194 files / 1827 tests passed with two workers and unchanged timeouts.

Remaining: explicit password/group removal, sorting, correct one-record
transitions, metadata identity rebasing during detach/copy/move, and actual
Android application/backend bidirectional proof. These are not implied by the
browser creation checks.

### Credential project identity during native batch copy

Android PasswordViewModel.saveProjectCredentials writes each row with
`row.metadata.forProject(targetProjectId)`. The browser batch planner previously
allocated a new outer passwordGroupId but left the nested credential projectId
pointing at the source project. It now rebases that one field on the destination
copy. Credential group/password IDs remain scoped to the copied project, matching
Android's forProject behavior; movement retains its existing project identity.
This is an identity-consistency correction, not proof that Android previously
merged copied entries automatically.

Lossless JSON retains unknown fields and large numeric lexemes; custom-field
attributes and order remain intact. No-op rebases preserve the raw value. Unknown
or duplicate credential metadata cannot be safely rewritten and causes planning
to fail before any external write. Ungrouped legacy fields are unaffected.

Core/planner tests and the complete batch coordinator test pass, including
select-one/expand-all, destination codec readback and unchanged source rows.
The coordinator test uses FakeNative, not a real application or Native Host.
Real Android/native/Edge copy and detach return evidence remains outstanding.
Full suite: all 194 files / 1831 tests passed with two workers; production build passed. Logs are raw/project-copy-identity-tests.log and raw/project-copy-identity-build.log.

### Shared fields when creating or extending credential groups — 2026-10-04

The save layer previously reconciled existing rows only. A newly created project,
or a password appended to an existing credential group, could therefore persist
conflicting usernames or embedded OTP values. Android creates these rows from a
single account/OTP and rejects conflicting values when restoring a group.

After reconciling existing edits, the browser now checks every credential group
whose membership was added or changed. New rows must agree with the resulting
shared values. It does not silently overwrite a new row's credentials. Existing
legacy metadata and unrelated edits to pre-existing conflicting data retain their
previous behavior. Scope remains the explicit project and database; titles do not
establish membership.

Two regressions failed before the fix and passed afterward. Seventeen focused
tests pass, including rejected new/extended groups, adding to a simultaneously
edited account, unchanged encrypted storage and mutation queue on rejection, and
successful addition followed by lock/unlock. Full regression passed all 194 files /
1833 tests with two workers; production build and interop typechecking passed.

Real Edge `run-so4aL7` passed existing-group edits/additions/cancel and entirely
UI-created two-group/three-password projects, group rename and third-group
addition, with eight final records retained through browser restart. Native
Messaging registration was restored and console errors were empty. The 320px
creation screenshot was inspected. This establishes the ordinary UI flows after
the save-layer fix; rejected conflicting payloads are covered by storage tests.
The current Android 1.0.317 grouped-credential application chain now passes:
three Android-created rows become two independent four-row projects in the
extension, then Android imports, reopens and edits the original while preserving
the copy. The extension verifies the returned identities, shared values, unknown
integer metadata and protection flags; actual Edge checks both returned projects
at 420/320px and through browser restart. See
[the version-pinned application evidence](project-credentials-317-interop.md).
Removal, reordering, single-row transitions and the full backend/screen matrix
remain outside this completed chain.

## Password history follow-up (1.0.317)

The extension now records per-password history atomically on ordinary and complete-project saves, exposes masked history with reveal/copy/single-delete, and preserves native Bitwarden and Android ZIP history on supported codec paths. KeePass/MDBX retain only the local overlay; Android/fresh-client history transfer on these backends is still open. See [implementation and exact acceptance boundaries](password-history-317.md).
