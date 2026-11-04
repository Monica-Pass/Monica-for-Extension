# Frequent unlock prompts: investigation

Date: 2026-11-04 (Asia/Shanghai). Scope: investigate only, as requested; no production changes or new timeout choices.

The supplied screenshot reports that the extension asks for a password after a few minutes. It does not identify the installed build, browser, configured duration, exact elapsed time, or whether the prompt is Monica's main unlock or an individual provider/database authentication. The original report is therefore **not confirmed reproduced or fixed**.

## Findings

- GitHub's latest stable release at the time of this investigation is `v1.0.103`, released on 2026-10-31. Its default encrypted vault setting is 15 minutes. The custom 1–1440 minute settings UI was added afterward in `8dfeb03`; it is absent from that stable release. The development checkout still also displays version 1.0.103, so the version number alone does not distinguish these builds.
- The timeout tracks vault activity, not general computer or webpage activity. Ordinary website interaction, status/list queries, background synchronization, and simply opening an extension view do not extend the deadline. Trusted pointer/keyboard interaction inside the popup or manager does. The runtime also records successful explicit autofill and other approved credential actions; this investigation did not add an end-to-end autofill case.
- In both the stable package and current development build, stopping and restarting the MV3 worker preserves the existing session identity and deadline. Reopening the popup page then returns `unlocked`. A genuine key event inside that page extends the deadline; opening the manager alone does not, while clicking its settings button does.
- A complete browser restart ends the master-password session. The development-build existing settings test confirms reauthentication is required afterward and the saved duration remains intact.
- One plausible explanation for “a few minutes after opening it” is that opening a view does not reset an already-running timer. For example, opening it 12 minutes after the last vault activity leaves about 3 minutes of the default timeout. This is an explanation of verified behavior, not a confirmed account of the screenshot user's experience.

## Verification

Development baseline: `f027c0f`, source build `61771f1e358be95424e5`. Installed Microsoft Edge: `156.0.4314.58`. Tests use isolated synthetic vaults and per-run profiles; session observations return only identity/timestamps, never session keys.

- `npm run build` passed, including TypeScript/interop checks, bundle/source checks and all four emitted-page asset checks. Existing large-chunk and browser-externalized `crypto` warnings remain. `npm run check` also passed after the diagnostic test was added.
- `vault-auto-lock.test.ts` (security and background): 25 passed. `automatic-sync-safety.test.ts`: 4 passed. The existing service expiry case: 1 passed, with the other 54 cases unselected. Total executed: 30 unit cases passed.
- Development build: 4 Edge cases passed in 1.4 minutes. The new lifecycle diagnostic passed in 4.6 seconds; the existing settings tests cover persistence, invalid input, 320px layout, browser restart, English keyboard save and a real one-minute timeout. That timeout waits on real elapsed time without editing the clock or session deadline.
- Stable release: the same lifecycle diagnostic passed in 4.8 seconds. The tested ZIP is the existing local final release archive, verified against the checksum freshly downloaded from the GitHub release: `47ddf7b090a9c06c634c0e9cceb873383c13ba15d485d63797e57b88547bc7d8`. The fresh ZIP download stalled at zero bytes and was cancelled; the matching local archive was used instead.
- The diagnostic opens the real `popup.html` as an extension page; it does not exercise the browser toolbar's transient popup container. MV3 restart is forced with the browser's worker-stop command. The default 15-minute duration is checked through session metadata, not a real 15-minute wall-clock wait. The one-minute wall-clock case and full browser restart case run on the development build only.
- Development run cleanup removed exactly its four owned profiles; stable-run cleanup removed its one owned profile. Raw browser results remain locally in `test-results/lock-diagnosis-20261104/` and `test-results/lock-diagnosis-stable-20261104/` (ignored).

To diagnose an actual early-expiry report, obtain the browser, stable/preview installation source and build, the relevant lock setting, the prompt being shown, and elapsed time measured from **successfully entering the unlock password**. If it happens while actively clicking/typing in the extension, record that distinction. Do not treat the normal inactivity behavior above as proof that every reported early lock is expected.

No authentication, encryption, timeout policy, production UI, version or release notes changed. No commit, push or publication was performed.
