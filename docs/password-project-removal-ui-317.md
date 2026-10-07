# Password member removal UI — Android 1.0.317

The project editor now supports removing a password or an entire credential
group, including the original owner. Draft selections use stable password IDs;
the original rows and their rich fields remain intact until save. Undo and
cancel preserve the complete draft/original project. At least one password must
remain. Saving shows the exact selected group/password labels and requires a
second explicit confirmation. Local projects and single-source MDBX2 projects
support persisted member removal. Other sources currently allow discarding
unsaved rows only.

The source page lists unfinished removals with unlock, resume and preparation
cancellation controls. Live vault changes refresh that list. Pending summaries
exclude secrets. Errors leave the operation available. A failed save retains
the exact submitted request for retry; a lost successful response is resolved
from its durable receipt. Only a rejected stage with no receipt, confirmed
while holding the source queue, allows the original draft to become editable
again. Missing receipts or failed readback alone do not establish cancellation.

The review stays inside the existing editor dialog. Focus returns to the
same password's remove/undo action, or its group action after group collapse.
The local M3E design and actual Edge screens preserve joined 4px corners,
24px outer corners, 12px page gutters and 48px removal targets.

- Design: [editable local Canvas](design/project-removal-ui-317.md), frames
  `credentialremove317`, `credentialremoveconfirm317`, `credentialremovepending317`.
- Full regression: **205 files / 1985 tests passed**,
  `.codex-tasks/android-interop-315/raw/removal-ui-full-final.log`.
- Production build / both TS configurations passed:
  `raw/removal-ui-build-4.log`.
- Actual Edge **154.0.4258.53**, final evidence:
  `.tmp/interop-315-edge/run-Ib0NrL/evidence.json`,
  `raw/removal-ui-edge-final.log`. All 18 recorded source hashes matched after
  the run; Native registry restored; no browser console errors.

Actual UI checks include remove/undo, whole-group selection, final-password
protection, exact cancellation, keyboard focus, 320/420/1280px rendering,
concurrent-edit rejection with an editable retained draft, injected loss of a
real successful backend response, exact-request retry, locked-source
preparation cancellation, a real browser restart, source unlock through the
dialog, and resume through the pending panel. Native readback checks all
original member identities/tombstones, owner promotion, passwords, notes,
email/phone, protected custom fields, the raw metadata integer
`9007199254740993`, and shared attachment hashes.

Earlier failures remain in evidence: the initial harness used a nonexistent
edit label; real layout exposed a global 44px override (fixed); the harness
mutated its expected removed-ID order while sorting (fixed); source-dialog
lookup assumed MDBX2 in a custom title (fixed); a table-driven test supplied an
object instead of an array (fixed). No checks were weakened.

The [exact three-project current Android return](password-project-removal-android-return-317.md)
also passed. This slice does not complete the full Android counterpart goal:
post-delete group undo, other backend deletion transactions and the wider
lifecycle/field matrix remain separate.
