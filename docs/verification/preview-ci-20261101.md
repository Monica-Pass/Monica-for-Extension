# Automatic Preview publishing gate repair

The rolling Preview job already exists in `.github/workflows/ci.yml`. It runs for canonical `main` only after both Linux release validation and Windows native/Edge validation succeed. It checks the current main commit before publishing and verifies both package hashes and embedded source evidence. These gates remain required.

Run `41276856358` failed Linux validation on three browser cases, so Preview was skipped although Windows passed. Run `41294363748` also finished with Linux failure, Windows success and skipped Preview. The first run's downloaded log identifies two stale upgrade fixtures and a KeePass worker-stop assertion:

- Background modularization lets the minifier emit command-table keys without quotes. The upgrade fixture searched for a quoted string and failed before exercising the browser. The new AST fixture renames exactly one real handler key for each unsupported legacy command, leaving transport/policy strings and all other handlers intact. Missing or ambiguous keys reject the fixture. Both omitted commands are also verified to fail against the actual running older worker.
- The KeePass test waited for all worker targets to disappear after a generic stop command. It now closes the exact extension worker target and marks the original worker's JavaScript global with a random, test-only nonce. Browser target IDs can be reused after restart, so they cannot establish fresh in-memory identity. The old nonce must disappear and a live, evaluable fresh global must appear. A specific `Service worker restarted` evaluation transition is tolerated while waiting; actual encrypted restoration, unchanged download counts, provider lock denial and group/attachment/history replay assertions remain required.

Local validation:

- Four upgrade-fixture tests pass for quoted/unquoted keys, missing handlers and ambiguous definitions. Combined with three cleanup protection cases, all seven script tests pass without skips.
- All four affected cases pass in bundled Chromium: KeePass restart/restore, durable group/attachment/history replay, manager upgrade recovery and popup upgrade recovery.
- The same four distinct cases have accepted results in installed Edge. The final two KeePass cases pass in 11.7 seconds; both upgrade cases passed in the preceding combined run. Original vault records, wrong-password rejection and post-upgrade correct-password access remain asserted.
- Production and interop TypeScript checks pass; all five workflow files pass the existing immutable-action/permissions/workflow-policy verification. The production source build remains `61771f1e358be95424e5`.

Exploration failures remain recorded locally: comparing new worker target IDs failed because the browser reused the original ID; querying an execution context during teardown failed with `Service worker restarted` before the bounded transition handling was added. No production timeout, cryptography, restore policy or publication gate was relaxed. Synthetic profiles and temporary copied extensions were removed by their existing ownership/path checks.

CI now runs the script fixture checks and requires the new auto-lock UI cases in the existing Windows Edge acceptance step. Remote validation/publication of this commit is pending at commit time; check the CI run for this exact source commit before treating Preview as published. No stable release or version change was made.
