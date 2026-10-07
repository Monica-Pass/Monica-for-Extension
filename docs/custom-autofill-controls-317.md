# Typed custom fields in browser autofill

Password custom fields now retain their type through the background-to-content projection. A Boolean field can set a checkbox to true or false without replacing its HTML submission value. Named multi-line textareas and single-choice selects are supported alongside ordinary inputs. The existing explicit account choice, site matching, document binding and lock checks continue to apply.

Actual Edge reproduced the old behavior: a checkbox with submission value `server-token` became `value="true"` but remained unchecked. The old DOM engine also ignored textareas/selects and could attempt to write file/action controls. Fourteen new tests initially failed; the real Edge baseline failure and trace are retained.

| Control | Behavior |
|---|---|
| Checkbox | Only an explicit `BOOLEAN`/legacy `boolean` custom field with true/false is accepted. Set `checked`, preserve `value`, emit input/change, never synthesize a click. Indeterminate and malformed Boolean values are left alone. |
| Textarea | Match the custom-field name to the actual control hints; use its native value setter. HTML normalizes CRLF/CR to LF in the textarea; the stored field remains byte-for-byte unchanged. |
| Single select | Prefer an exact option value, otherwise a unique exact label. Reject ambiguous values/labels, disabled/hidden choices and disabled option groups. Multiple selection is not inferred. |
| Ordinary inputs | Existing input support remains; new-password, hidden, file, radio and action controls are excluded. Disabled fieldsets and read-only controls are respected. |
| Scope | Use the selected login form, including its standard externally associated controls and reachable open shadow DOM. The unrelated form stays unchanged. |

The plan snapshots each control's identity, form, action/method, semantic hints and relevant attributes. Select options are checked by identity, order, value, label and disabled state. Before each write and after native input/change/focus events, stale or replaced controls stop subsequent filling and return the existing retry message. Completed fields are checked against their actual value or checked/selected state. Internal project/GPG/API carriers remain excluded in both the background projection and the DOM engine.

A partial-fill defect was also corrected: a later custom control may fail after HOTP reached its original valid field. The background now consumes that acknowledged HOTP before returning the remaining fill error. The existing encrypted, identity-bound counter mutation still verifies the current item. A failure before the OTP was filled does not acknowledge use.

## Verification

- Full unit regression: 231 files / 2381 tests passed. Focused controls/DOM/inline/signature/locked-autofill suite: 68 tests passed. Production build, both TypeScript projects, strict E2E TypeScript and the security audit of 195 runtime commands passed.
- Actual Microsoft Edge 154.0.4258.53: all 26 consolidated autofill scenarios passed in 4.2 minutes, including three new scenarios. Typed control filling in an open shadow form, unchanged unrelated form, native events without clicks, untouched file/new-password/internal fields, unchanged stored CRLF/type metadata and full browser restart. Dynamic select mutation rejects the old plan and a new explicit selection succeeds. HOTP in a partially failed fill advances 7→8; the explicit retry fills the next code and advances to 9. Regressions include iframe origins, keyboard selection, dynamic forms, site/field exclusion, settings, language/theme layouts and locked grants/restart/revocation.
- The real website fixture's final screenshot was inspected. It shows the intended checked/unchecked states, exact multi-line text and selected tenant, with the unrelated form and excluded fields empty. This is a synthetic webpage used by the actual extension, not a redesigned product screen.
- Evidence lives in `.tmp/custom-autofill-controls-317-final/`; logs use `.codex-tasks/android-interop-315/raw/custom-autofill-controls-317-*`. The initial unit and real Edge failures remain under `*-red*`. The first build found a missing test-only DOM generic; the corrected build passed.

This batch changes browser filling behavior and does not establish Android native custom-field import/export or arbitrary website-framework compatibility. Android product sources/devices, Passkey signing, real OneDrive sign-in and native password-history transport were not changed or revalidated here. The overall interoperability goal remains open.

After acceptance, 367,798,479 logical bytes of caches were removed from the current test profiles. All 5737 protected file hashes remained unchanged. Browser vault state, successful and failed evidence, the extension build and Native Host were retained. No build followed cleanup. The checked deletion script, plan and result are retained with the raw logs.
