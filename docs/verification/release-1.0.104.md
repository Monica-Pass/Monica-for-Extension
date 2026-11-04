# Extension 1.0.104 release verification

Published on 2026-11-04 at 23:05:53 Asia/Shanghai (15:05:53 UTC), following the user's request to commit the extension work and publish a release. The bilingual notes include the requested explanation that Android remains the main development focus, extension maintenance may take longer, and Issues and PRs are welcome.

- Release: <https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/v1.0.104>
- Release ID: `434023317`; tag: `v1.0.104`; stable, public and latest.
- Tested source and release tag commit: `dfd4fc2f8f26cb555b6289f2ae31d78bcbaa6518`.
- Extension version: `1.0.104`; build ID: `51b5b373ac025b6f61e1`.
- Official extension ID: `lebnfedmijifofonogjdphpojihgohmc`.
- Optional Windows x64 helper version: `0.1.6`.

Code commits `b176f7e`, `4bb23f4` and `dfd4fc2` were pushed to `main`. This verification document is a later documentation-only commit; the release tag remains on the tested source above.

## CI evidence

[CI run 41845019723](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/41845019723) completed successfully on the exact release source before publication.

| Check | Result |
| --- | --- |
| Full unit suite | 357 files; 4,560 tests passed |
| Bitwarden contract suite | 2 passed |
| Security suite | 49 files; 722 passed |
| Source guardrails | 14 passed |
| Runtime command audit tests | 29 passed; 233 commands audited |
| Linux browser suite | 162 passed, 236 skipped; 14.7 minutes |
| Native Host suite | 121 passed on Linux and 121 on Windows |
| Required actual Edge acceptance | 19 passed; 3.1 minutes |
| Windows Passkey cases | 2 passed; 12.2 seconds |
| Packaging and tooling | Host Clippy, supply-chain checks, package reproducibility and native installer isolation passed |

These suites overlap; their counts are not summed into a unique-test total. Skipped cases are not counted as passed. The unsigned Firefox package was built and verified in CI but is not a public release attachment.

CodeQL [41845019830](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/41845019830), Secret Scan [41845019824](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/41845019824) and Scorecard [41845019936](https://github.com/Monica-Pass/Monica-for-Extension/actions/runs/41845019936) also completed successfully on this source. These results do not mean every dependency advisory has been resolved; see the scope below.

The earlier run `41843732410` on `4bb23f4` was cancelled after correcting the browser download test. Creating the release tag automatically triggered duplicate CI run `41854194671` on the already-tested `dfd4fc2` source; it was deliberately cancelled to avoid repeating the full build. Neither cancelled run is counted as passing. The workflow only publishes Preview from `main`, so the tag run does not replace stable release attachments.

## Package assembly and provenance

The original Linux CI ZIP was retrieved through the rolling Preview asset `monica-extension-1.0.104-preview-dfd4fc2f8f26-41845019723-1.zip`. The Preview publisher renames the CI package without changing its bytes. Its checksum, clean source metadata, manifest and exact source commit were checked before assembly.

- Original CI ZIP: 10,352,350 bytes; SHA-256 `de6961c2f219fe593ae2fa31c9c98ce649c684c63afb2771eacc3c3fade901fd`.
- `gh attestation verify --repo Monica-Pass/Monica-for-Extension --deny-self-hosted-runners --format json` succeeded for that original CI ZIP. The verified subject digest matched, with GitHub-hosted `.github/workflows/ci.yml` provenance from `dfd4fc2` and run `41845019723`.
- The final public extension ZIP retains 1,146 CI distribution files unchanged. Assembly changes `nearby-helper/availability.json`, adds `nearby-helper/monica-wifi-windows-x64.zip`, and regenerates the standard package evidence.
- The embedded Wi-Fi helper contains the same executable as the Windows CI helper package. Its isolated capability handshake returned version `0.1.6`; executable SHA-256: `9e0031ebf1c95109ba01d9ce08068b4a07dfc7b73318952a6b9ec06e14826d5f`.
- All four emitted extension pages, the 233-command security audit, package inventory and file hashes passed. Two independent repackagings were byte-identical to the final public extension ZIP.

The GitHub attestation covers the **original CI ZIP**, not the locally assembled public extension ZIP containing the Windows helper. The final ZIP is supported by the explicit file comparison, packaging checks, final Edge acceptance and published asset digests below.

## Final installed Edge acceptance

The actual final assembled `dist/` was exercised in isolated, headed Microsoft Edge `156.0.4314.58`. The four-case command exited successfully: **4 passed in 57.9 seconds**. All four owned browser profiles were deleted by the normal cleanup path.

| Case | Result |
| --- | --- |
| Bitwarden login plus OTP projection | One authenticator tile while retaining underlying login and OTP data; 7.5 seconds |
| GitHub update settings | Synthetic ZIP download, release navigation, management page, reload confirmation, status/failure cases and translated narrow layouts; 13.3 seconds |
| Missing native helper | Pairing remains usable, setup guidance and embedded Windows helper download work; 5.5 seconds |
| Actual stable-file replacement and relocation | Old background detection, reload, original encrypted vault and Bitwarden connection configuration retained; 20.9 seconds |

The setup ZIP downloaded through the real settings link exactly matched the shipped embedded ZIP: SHA-256 `7831d0b8c9f5fcc0821a1ee11f11156249fac475a102e6740b7f608c76c4c418`.

The preservation case loaded the prior official 1.0.103 build `14ab010da0d35b85e20e`, then replaced its files with build `51b5b373ac025b6f61e1`. The extension ID stayed unchanged after both original-directory replacement and relocation within the same isolated browser profile. The serialized primary encrypted vault envelope matched, and the original Monica master password recovered the synthetic records and Bitwarden configuration.

Local preparation also passed ESLint, the complete 1.0.104 build, 102 targeted unit tests and one existing native ZIP import-boundary regression (120 native tests unselected). The initial release update test timed out waiting for a download while its TOTP and preservation companions passed. The corrected test uses a valid synthetic ZIP and captures download events from existing and newly opened pages; the standalone rerun passed in 16.8 seconds before the final four-case run above. No authentication or production download behavior was weakened to pass the test.

## Public release verification

The draft was checked before publication for the exact source commit, maintenance note, full notes-file equality and exactly four uploaded assets. After publication, the public release and latest-release APIs confirmed `draft=false`, `prerelease=false` and `v1.0.104` as latest. Fetching the specific tag and resolving it to a commit confirmed `dfd4fc2f8f26cb555b6289f2ae31d78bcbaa6518`.

| Public ZIP | Bytes | SHA-256 |
| --- | ---: | --- |
| `monica-extension-1.0.104.zip` | 14,080,759 | `88f762f7e1468e6228df6615a9a141f38d3eae5bf34c85e122307cb0d66d9f98` |
| `monica-mdbx2-host-windows-x64-0.1.6.zip` | 3,760,992 | `2b973c5c631b84c2fda5d7e9f68d7dae7765e486a7d76833bf6a868bf47c0537` |

Each ZIP has a `.zip.sha256` attachment. Their file sizes are 95 and 106 bytes respectively, with SHA-256 digests `af75cc33742c280b3e54181b3825cff5b68735d36772e9367eb41d266f38ec28` and `bb0dca25f571f82052ffeb57aeae8d0eaaa3a860784c0015325fe015a6078763`. All four GitHub asset digests and sizes matched local files before and after publication. Both published checksum files were downloaded again and were byte-identical to local files. The large public ZIPs were not downloaded a second time; their post-publication verification uses GitHub's asset digests and the local package checks.

The release-event documentation notification `41854196258` succeeded. The earlier Preview workflow-completion notification `41851525433` failed; it is not included in the successful CI evidence or described as repaired by this release.

## Scope, advisories and retained evidence

- Updates remain guided manual file replacement. No filesystem auto-updater was added. Reload requires the original Monica master-password unlock; that is separate from Bitwarden account authentication.
- The disabled Bitwarden test provider uses synthetic credentials. Configuration retention does not establish continued validity of a real server token. The reporter's repeated Bitwarden sign-in and exact extraction/overwrite failure remain unconfirmed.
- Frequent password prompts were investigated without changing authentication policy. Default locking follows 15 minutes of valid vault activity; ordinary browsing does not renew it. Unexpected early locking was not reproduced.
- The ZIP dependency and toolchain were not upgraded. Six Rust ZIP alerts across two lockfiles and one development-only npm minimatch alert remain open. Production npm audit reported zero vulnerabilities. The compiled callers do not use the reported AES, streaming or generic filesystem extraction paths; this is an applicability assessment, not a universal malformed-archive guarantee. Both release-note languages link [the ZIP advisory review](zip-advisory-scope-20261104.md).
- No real account, personal browser profile, Android APK, physical Android device or new browser/Android interoperability acceptance was used for this release task. Earlier nearby feature verification is separate from these release checks. Old releases and unrelated work were preserved.
- Downloads were slow; redundant task-owned download processes were stopped after the verified Preview ZIP completed. No personal browser was killed and no global network configuration was changed.

Raw logs and artifact metadata remain in ignored `.tmp/release-104-*`, `.artifacts/release-1.0.104-*` and `test-results/release-104-final-packaged/` paths. Screenshots and synthetic data remain local and are not included in this commit. Earlier diagnostic evidence and its cleanup failures are retained in [auto-lock diagnosis](auto-lock-diagnosis-20261104.md), [TOTP deduplication](bitwarden-totp-duplicates-20261104.md) and [update-flow verification](unpacked-update-flow-20261104.md).
