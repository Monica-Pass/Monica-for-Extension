# Extension 1.0.105 release verification

Published on 2026-11-19 at 05:06:05 Asia/Shanghai (2026-11-18 21:06:05 UTC), continuing the user's request to publish 1.0.105. The introductory empty-vault/trial paragraphs were removed from both release-note languages. Settings and the release title retain the requested codename, `Sengoku Nadeko`.

- Release: <https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/v1.0.105>; ID `450556648`; public, stable and latest.
- Tested source and tag: `a7ed34eb0f0665f7b2c891f3ba044fa69f492e5f`.
- Extension version: `1.0.105`; build ID: `205f67299e65cbb6af49`; extension ID: `lebnfedmijifofonogjdphpojihgohmc`.
- Optional Windows x64 helper version: `0.1.6`.

This document is a later documentation-only commit; the release tag remains on the tested source.

## CI and earlier failures

[CI run 44349312111](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/44349312111) passed both platform jobs and the Preview publisher on the release source.

| Check | Result |
| --- | --- |
| Full unit suite | 367 files; 4,711 passed |
| Bitwarden contract suite | 2 passed |
| Security suite | 54 files; 761 passed |
| Source guardrails / runtime command audit tests | 14 / 29 passed |
| Linux Chromium | 162 passed, 246 skipped; 15.0 minutes |
| Native Host | 127 passed on Linux; 127 on Windows |
| Required actual Edge core acceptance | 19 passed; 3.3 minutes |
| Windows Hello Passkey cases | 2 passed; 13.0 seconds |
| Tooling and packaging | Lint, type checks, production audit, pinned engine builds, Host Clippy, installer isolation, reproducible packaging and unsigned Firefox packaging passed |

Suites overlap; their counts are not summed. Skipped cases are not counted as passed. CodeQL, Secret Scan and OpenSSF Scorecard passed on this source. Production npm audit reported zero vulnerabilities; native ZIP advisory scope remains separate from that npm result.

Run `44335182324` on `473a032` failed at Playwright discovery because Node 22 required a `type: json` attribute on the icon catalog import. The fix restored discovery of 408 tests in 168 files. Local lint, type checks, build and 19 icon/release-readiness tests passed.

Run `44342480708` on `7d2daf4` subsequently reached the Linux browser batch: 161 passed, 246 skipped and one failure. The barcode fixture read the vault immediately after clicking Save, before its asynchronous save completed. An unchanged-source local rerun passed, which alone did not establish the cause. Injecting a two-second delay only into the synthetic page's upsert call reproduced the missing-barcode assertion; the same diagnostic with a wait for editor closure passed. The committed fixture now waits for this existing completion signal and retains every record assertion. Its normal rerun passed in 17.5 seconds. Production inputs and build ID were unchanged by the test-only follow-up.

Both failed runs, the diagnostic's expected failure and trace, and the earlier Windows archive remain local evidence. They are not counted as successful full gates. Final success logs were downloaded through the run-log ZIP API after CLI log views returned empty output.

## Package assembly and provenance

Both package inputs came from successful run `44349312111`. Checksums, clean source metadata, inventories and executable hashes were checked before assembly.

- Original CI ZIP: 10,413,854 bytes; SHA-256 `0e11fe26cb71c055f0c897c79f93ecc6f6c49c55d897426d2e47cd7ee713aa0d`.
- `gh attestation verify --repo Monica-Pass/Monica-for-Extension --deny-self-hosted-runners --format json` passed for that original ZIP.
- Windows executable SHA-256: `afff3b4b68ad6858cee84f4f0dc477934afbfa775afc0b8a9a8874a9120a2edc`.
- Assembly preserved 1,158 CI distribution files byte-for-byte, changed only `nearby-helper/availability.json` and added `nearby-helper/monica-wifi-windows-x64.zip` with that executable. The existing helper builder's capability handshake passed. The original CI attestation does not cover the assembled final ZIP.
- The standard packager generated the final ZIP from a clean source checkout. Independent verification rebuilt it twice and confirmed identical archives, checksums, inventories, sidecars and unpacked files. Final distribution security auditing passed.

## Final-package upgrade and downloads

Two actual Edge cases passed in 17.9 seconds. From checksum-verified stable 1.0.104, a same-directory overwrite and subsequent relocation retained the extension ID, original-password access, fixture items and complete saved Bitwarden provider configuration. No provider login occurred after upgrade. The old worker remained running during overwrite; the test verified the new runtime after reload. Build ID changed from `51b5b373ac025b6f61e1` to `205f67299e65cbb6af49`.

The settings page's actual communication-component download succeeded. Its ZIP SHA-256, `18b5120c34b2db7825ee3b902b2cb49eff8628c2fb8d7220232dae065f022130`, matched the packaged helper ZIP. The test simulated a missing helper in its isolated worker and did not change the user's native registration.

An isolated actual Chrome test additionally created a populated vault through GitHub stable 1.0.103, then applied the final unpacked ZIP with the staged publisher. The original encrypted primary remained intact before unlock. The original password migrated the vault; two records, saved source identity/authentication settings and an encrypted old-primary checkpoint were retained. A cold read after migration passed without an explicit backup restore or second Bitwarden login. This protocol-installed test extension required the test tool to load it again on restarts; it does not prove ordinary Chrome registration persistence under every installation method.

## Publication checks

Draft and published metadata matched the exact notes, target commit and four explicitly selected assets. The latest-release API returned `v1.0.105`; fetching the tag resolved to the tested commit.

| Public ZIP | Bytes | SHA-256 |
| --- | ---: | --- |
| `monica-extension-1.0.105.zip` | 14,149,635 | `3c5b2e51d1d380a48f87909f74e64250df7b903e794bc8e4f91934c04b828292` |
| `monica-mdbx2-host-windows-x64-0.1.6.zip` | 3,768,076 | `1ec79bd4256493fe897e70d42f6f3517f56920f33e4f514711e18b61e0021809` |

Each ZIP has a checksum attachment. All four public sizes and GitHub digests matched local files before and after publication. Both public checksum files were downloaded again and were byte-identical; the large ZIPs were not downloaded a second time. Tag-triggered duplicate CI `44397933613` on the already-tested source was cancelled and is not counted as passing.

## Scope and retained evidence

Historical performance numbers compare development implementations and synthetic data, not this release against every older release or real Bitwarden servers. Migration changes the extension's own IndexedDB representation; native KDBX/MDBX and Bitwarden server formats are unchanged. Remote KDBX edits still encode and upload the whole file. Direct use of an older client against upgraded IndexedDB is not covered by the upgrade result.

No personal browser profile, user vault or real account was used. Saved synthetic configuration does not establish validity of a real server token. There is no new Android, physical hardware, OEM or Mozilla-signing acceptance. Unsigned Firefox packages are not public attachments. Older releases and unrelated work were preserved.

Raw logs, API metadata, package inputs, attestation output, earlier failures and synthetic test evidence remain local. Screenshots and profiles are not committed. The final Edge run cleaned its two owned profiles through existing run-scoped cleanup; Chrome contexts were closed and their synthetic evidence retained.
