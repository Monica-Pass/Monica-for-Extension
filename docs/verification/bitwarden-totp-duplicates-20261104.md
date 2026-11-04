# Bitwarden authenticator duplicate display

Date: 2026-11-04 (Asia/Shanghai). Baseline: `f027c0f`; extension version remains 1.0.103. Fixed source build: `c6305e06b82f804a4eec`.

## Reproduction and cause

The report shows each Bitwarden account twice on the authenticator page: a password-icon tile and a timer-icon tile, with the same current and next codes. Two synthetic encrypted Bitwarden ciphers, decoded through the production encoder/decoder and restored as an encrypted test vault, reproduce this exact structure. Before the fix the real Edge manager displays four tiles instead of two; the regression fails with `Expected: 2, Received: 4`.

Bitwarden's decoder intentionally retains `Login.Totp` on its parent login and produces a standalone authenticator projection with the same provider and `<cipherId>#totp` reference. Both are needed by existing editing, autofill and provider write-back flows. Commit `aed9fdb` added login-attached authenticators to the manager (including KeePass), but the generic authenticator predicate also admitted the Bitwarden parent alongside its existing projection. The sidebar used the same per-item predicate, doubling its count too. This reproducer establishes duplicate presentation, not a duplicated remote cipher or incorrect OTP calculation.

## Change

The manager now selects authenticator display rows after applying its normal view filters. An inline login is omitted only when an active standalone projection from the same known Bitwarden provider and exact cipher reference exists in the matching rows, with identical generation parameters. The sidebar uses the same selection rule. The existing layout and user-visible strings are unchanged.

Source identity is required; labels or matching current codes never establish a duplicate. Independent ciphers/accounts remain visible even with identical labels and secrets. Unknown or ambiguous source references, different parameters (including HOTP counters), missing/archived/deleted projections and unsupported inline values retain the appropriate fallback. Filtering by a URL present only on the parent still finds its inline code. No item is removed, rewritten, merged or reassigned. Password lists, persisted vault records, provider synchronization and OTP algorithms are unchanged.

## Verification

- Five related Vitest files, 108 cases passed: the new selector plus manager metadata, login OTP resolution, OTP algorithms and the Bitwarden cipher codec. These cover separate providers/ciphers, retained local item IDs, local/KeePass inline OTPs, missing/filtered/inactive projections, ambiguous references, changed parameters, Steam, mOTP, Yandex and a HOTP counter above JavaScript's safe integer range. The selector leaves its input unchanged.
- Full production build passed, including TypeScript/interop, bundled-source and emitted-page checks. A subsequent `npm run check` passed after the browser test was completed. Existing large-chunk and browser-externalized `crypto` warnings remain.
- Actual Microsoft Edge 156.0.4314.58: three cases passed (6.3s, 6.6s and 3.0s). The new case verifies two tiles and sidebar count 2 for two ciphers, distinct ciphers with the same key remaining separate, clipboard use, URL-search fallback, multi-selection count 2, reload persistence, no page errors and exact preservation of all four internal records. Existing cases verify linked authenticator priority, narrow translated details, hiding while backgrounded and removal from the UI when locked. The new page screenshot was visually inspected and shows one timer tile per account with two results.
- Git whitespace checks passed for tracked edits. Screenshots, traces, synthetic test vaults and browser metadata remain in ignored local output directories, not source documentation.

The first fixture mistakenly supplied `totpSecret` to `createLoginItem`, whose input does not accept it; it failed before starting a browser and did not reproduce the product bug. The fixture now adds the property to the returned login before encoding. That initial run also hit a Windows CIM teardown failure. The corrected pre-fix browser run produced the four-versus-two failure and cleaned its one profile normally.

All three post-fix browser cases passed, but the overall command exited nonzero because Windows CIM process enumeration failed in the cleanup hook (`0x80041032`). A direct retry and a filtered CIM query failed too. A local cleanup helper then used installed psutil's native process command-line API: it verified the exact run markers, stopped runner, resolved workspace containment, absence of reparse points and absence of each profile in live browser arguments before deleting only the three profiles owned by run `0851a21b-9fd5-411c-9b71-29e363e04132`. No browser was killed and the shared cleanup script was not changed. The teardown failure is retained, not reported as a wholly successful command.

Local evidence: `test-results/totp-duplicate-before-20261104/` (fixture failure), `test-results/totp-duplicate-red-20261104/` (product reproduction), and `test-results/totp-duplicate-after-20261104/` (three passing cases and screenshots). The native cleanup helper is `.tmp/totp-cleanup-20261104.py`.

The test vault uses real production Bitwarden decoding and encrypted restore, without contacting the reporter's account. No live Bitwarden network synchronization, Firefox acceptance or reporter-device test was performed in this run. The fix is local and described in the unreleased bilingual changelog; no commit, push, tag or publication was performed. The earlier automatic-lock diagnostic files remain separate and unchanged.
