# KeePass password-project synchronization consistency

KeePass UsageCount is not an edit revision. Android and other writers can change an entry without incrementing it. The provider now compares represented native content against its saved content fingerprint as well as the existing revision before overwriting an entry.

The provider prepares every write and validates native removal/restoration before changing entries. A conflict or invalid member retains all queued mutations of the same explicitly scoped password project. Independent projects can still synchronize. Prepared patches avoid validation failing after an earlier member was already modified. This protects the known validation/conflict paths; arbitrary unexpected in-memory exceptions do not have a general rollback mechanism.

Remote whole-file rebasing also compares native project membership and full entry signatures across base, working and remote databases before mutation. Divergent changes to different members of one project, including member additions or deletions, now conflict. Identical changes and unrelated same-title entries remain mergeable. Error messages contain no secret field values.

## Validation

- Full regression: 233 files / 2,422 tests passed. Focused provider/writer/recovery/project tests: 75 passed; rebase/session tests: 19 passed.
- Production build, both TypeScript projects, strict E2E TypeScript and security audit of 195 runtime commands passed.
- Actual headed Microsoft Edge 154.0.4258.53 and isolated Apache WebDAV passed in 10.0 seconds. The extension imports a hash-bound Android KDBX fixture, queues three project changes, and encounters a synthetic peer change without a UsageCount increment. Actual source synchronization reports conflict, preserving exact remote bytes and all three pending local rows through a full browser restart. A fresh Edge session then saves all three members together from the latest source.
- Independent native readback within the scenario checks original UUIDs, parents and other original fields. Binary names were compared; attachment byte acceptance is not claimed by this test.

Accepted evidence: `.tmp/keepass-project-atomic-edge-317-second/keepass-project-conflict-r-af876-h-peer-can-save-it-together/`. The conflict screenshot was inspected. The initial Edge failure (test-side kdbxweb CJS namespace loading) and initially failing regressions remain in the raw logs. Test tooling now bundles the reader with esbuild; production behavior was not altered to accommodate the test.

This is not Android runtime acceptance, Passkey signing acceptance, real OneDrive acceptance or completion of whole-project restore UI. The peer mutation uses kdbxweb. Android product sources were not edited. The overall tracker stays 15/24 complete.

The dedicated Apache container was stopped after verifying its identity; its volume and all evidence remain. No AVD or Vaultwarden was started. Cleanup removed 51,122,588 logical bytes, with 1,720 protected hashes unchanged and an observed free-space increase of 51,253,248 bytes. Fourteen historical cleanup batches total 25,652,444,844 logical bytes, including regenerated caches; this is not current disk usage. No build followed cleanup.
