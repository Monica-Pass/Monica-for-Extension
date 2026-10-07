# Monica MDBX2 Native Host

This process is the trusted MDBX2 runtime for Monica Extension. It uses the exact Monica MDBX2 core instead of reproducing format, cryptography, Commit2 or synchronization rules in TypeScript.

Version 0.1.2 vendors the Android 1.0.315 runtime source and its four reviewed overlays, followed by an explicitly recorded extension overlay for atomic object/attachment moves. `ENGINE-PROVENANCE.json` retains the Android baseline hashes and separately records the extension patch, base hashes and final hashes; `node scripts/verify-mdbx2-host.mjs` verifies the chain before a build is accepted. The patched Host is not byte-identical to Android source or binaries.

Existing native records can be addressed as `native:<UUID>` (or a canonical UUID), with `expectedHeadCommitId` from `object.reveal` / `object.list`. Native edits require this revision and preserve the original `monica_entry_id`. Upsert accepts `payloadSchemaVersion: 1`; existing higher versions and unknown types remain available through bounded, policy-authorized disclosure but are read-only. The Host advertises `supportsNativeObjectIdentity`, `supportsObjectRevisionPreconditions` and `supportsLosslessJson`. Lossless payload JSON and API-token metadata use the same shared parser as Android, including integer/decimal lexemes and literal serde marker keys.

The attachment-move overlay adds `supportsAtomicObjectAttachmentMove`. The extension requires it for native-object writes with an explicit destination Collection, including batch writes. Older helpers must be updated before these writes; ordinary reads remain available.

Version 0.1.1 adds the `supportsApiTokenMetadata` capability for native Android API keys. API objects retain their native UUID and `monica.api-token.v1` / `monica.gateway.credential.v1` payload. Notes, stable custom-field IDs and favorites use Android's collection-scoped `monica:api-token:fields:v1` and `monica:api-token:favorite:v1` labels. Object and label changes share one idempotent transaction; ambiguous field labels fail closed. Existing vaults require no format migration.

Install the updated helper before editing API keys through MDBX2. Extension 0.1.37 blocks API writes through older helpers so partial metadata cannot overwrite Android records. Extension-only archive state uses the additive `monica:extension:archived_at` field in the fields label; Android preserves it but does not currently display this archive state.

## Core pin

`mdbx-ffi`, storage and the shared JSON parser are vendored from `https://github.com/Monica-Pass/Mdbx.git` at revision:

```text
90005c8c608c952093a4522ffa507a562e2e39a4
```

The four Android patches in `runtime-patches/` add policy-bounded read sessions, bounded synchronization writes, exact JSON numbers and literal marker-key preservation. The extension patch `extension-entry-attachment-move.patch` then moves active entry-owned attachments within the same transaction, retaining UUIDs, content and Blob references, recording attachment versions and merging commit parents. Failure rolls back the whole operation; project-level attachments stay in place. There is no storage schema change. Android main is not modified by this patch.

The source inventory includes upstream synthetic golden fixtures and the upstream license; `.gitignore` allows its public synthetic golden vaults to be tracked. To reconstruct, export `Cargo.toml`, `Cargo.lock`, `LICENSE` and `crates/` from the exact commit, apply the four Android patches in provenance order, then the separately listed extension overlays, and run the verifier. Run `git apply` from the export root outside any parent Git checkout, or pass an explicit repository-relative `--directory`; Git otherwise may skip paths from a nested directory.

The Rust toolchain is pinned to `1.86.0` and UniFFI to `0.31.1`. Android packages the runtime as MDBX3 `3.0.0-alpha.1`; the Rust crate/FFI engine version remains `0.2.0`, and the writable format remains `MDBX-2`.

## Current protocol

Host name: `com.monica_pass.mdbx2`

Protocol version 2 exposes the pinned capability handshake, durable file staging, MDBX2 vault access and Android-compatible incremental synchronization:

```text
host.hello
transfer.begin
transfer.chunk
transfer.finish
transfer.abort
vault.inspect
vault.open
vault.status
vault.lock
collection.list
object.list
object.reveal
object.upsert
object.delete
object.batch
object.operation.status
object.operation.resolve
history.list
history.diff
conflict.list
conflict.resolve
transfer.read
transfer.release
sync.state.register
sync.state.status
sync.bootstrap.prepare
sync.bootstrap.commit
sync.segment.prepare
sync.segment.commit
sync.stream.list
sync.stream.block
sync.segment.inspect
sync.segment.apply
sync.segment.acknowledge
sync.blob.list
sync.blob.read
sync.blob.remote.verify
sync.blob.receive.begin
sync.blob.receive.chunk
sync.blob.receive.abort
```

The handshake reports the Host version, exact core revision, MDBX2 format generation, build capability manifest, 256 KiB chunk limit, 2 GiB file limit, 50-item history/conflict page limits, 850 KiB history/conflict response limits and supported unlock methods. It explicitly reports `supportsMdbx1: false`.

Native Messaging messages are framed as four native-endian length bytes followed by UTF-8 JSON. Input control frames are limited to 1 MiB and Host output frames to 900 KiB. Binary transfers use at most 256 KiB of raw bytes per Base64 chunk.

Inbound transfer state uses two alternating durable metadata slots. Chunks require the exact durable offset; a byte-identical retry is idempotent. `transfer.finish` verifies declared size and SHA-256 before publishing an opaque file handle.

`vault.inspect` calls the core's read-only migration inspection and accepts exact `MDBX-2` only. `MDBX-1` and `MDBX-1-DRAFT` are rejected before `open_vault*` can invoke automatic migration. Older MDBX2 schemas receive a local portable backup before the pinned core upgrades the app-private working copy.

Collection and Object summaries are paged at no more than 200 records. Object disclosure is capped at 512 KiB and remains subject to the core Tiga policy. Writes use only the pinned core's typed `MdbxWriteCommand` operations and one idempotent operation UUID; no SQL surface is exported. Monica logical IDs are stored in `payload.monica_entry_id`, while physical IDs use the same `UUID.nameUUIDFromBytes` algorithm as Android.

Provider reconciliation groups up to 50 Object mutations into one bounded user-level operation instead of creating one Commit per item. Multi-item intent is capped at 384 KiB by the Native Messaging boundary; a larger single Object retains the existing 512 KiB payload limit. The Host generates a random operation UUID, stores only bounded local receipt hashes and Commit metadata in alternating durable slots, and can resolve a lost Service Worker response after restart without placing secret-derived deterministic IDs into the synchronized Commit DAG. Reusing one operation ID or operation scope with different semantic content fails closed.

Commit history is exposed read-only in pages of at most 50 records. Commit diffs use the core's 500-Object bound. The Host returns titles, deletion state, changed-field names and a `payloadChanged` boolean, but deliberately removes decrypted payload previews before crossing into the manager page. Oversized results fail before the 900 KiB Native Messaging frame boundary.

Vault health checks expose aggregate severity, allowlisted categories and semantic issue-kind enums only. The Host may inspect a Core description to classify pending verification, authentication failure, Tombstone variants or inactive devices, but the description itself and any embedded paths or identifiers never cross Native Messaging. Unknown/future checks collapse to one generic issue kind.

Unresolved conflicts are exposed in pages of at most 50 records. Summary responses omit base/local/incoming Commit IDs and payload previews. Resolution supports explicit local-wins or incoming-wins only. Random operation IDs are persisted in alternating bounded receipt files; reuse with another conflict or choice fails, completed retries are idempotent, and an incomplete receipt after the conflict disappears returns an unknown-outcome error instead of applying another winner.

Synchronization state uses two alternating durable slots. A portable `.mdbx` file initializes a device; normal multi-device operation exchanges authenticated bundle v8 segments, state deltas and encrypted external Blobs. Export checkpoints advance only after immutable publication, and remote stream cursors advance only after atomic apply and Blob completion.

The extension registers the MDBX2 provider only in the privileged background. Windows Hello uses the separate `com.monica_pass.windows_hello` Native Messaging registration; it shares the reviewed executable package but has an independent manifest, registry entry and extension client connection. Raw Collection, Object, history and conflict commands are accepted from `index.html` and rejected from Popup, content scripts and web pages. Locking the Monica vault, locking an MDBX2 source or removing the source clears the background compatibility cache.

## Build

```powershell
cargo test --manifest-path native/mdbx2-host/Cargo.toml
cargo build --release --manifest-path native/mdbx2-host/Cargo.toml
```

## Windows installation

Complete local backups use `vault.export.begin`, `vault.export.read` and `vault.export.release` with the `supportsCompleteBackup` capability. External Blobs are frozen with the database in one SQLite read transaction and exported in a ZIP with the Android sidecar layout. The existing `vault-bootstrap` upload path accepts this exact archive and restores its database plus Blobs. Download sessions are opaque, vault-session-bound, limited to four/512 MiB/five minutes, and discarded on lock. These operations do not touch cloud synchronization checkpoints. See `docs/mdbx-complete-backup-317.md` for the implementation and pending application acceptance boundaries.

Build and package the reviewed Windows x64 Host:

```powershell
npm run package:mdbx2-host
npm run package:verify:mdbx2-host
```

Extract `release/monica-mdbx2-host-windows-x64-<version>.zip`, copy the extension ID from `chrome://extensions` or `edge://extensions`, then run one of:

```powershell
.\install-host.ps1 -ChromeExtensionId <32-character-id>
.\install-host.ps1 -EdgeExtensionId <32-character-id>
.\install-host.ps1 -ChromeExtensionId <chrome-id> -EdgeExtensionId <edge-id>
```

The installer writes only under the current user's `%LOCALAPPDATA%` and `HKCU`. It creates exact `chrome-extension://<id>/` origins for both `com.monica_pass.mdbx2` and `com.monica_pass.windows_hello`, and never uses a wildcard. Fully exit and reopen the browser after installation. `uninstall-host.ps1` removes both per-user registry entries and the verified Host directory.

## Installation security

The native-host manifest contains the absolute executable path and only installer-supplied exact extension origins. The installer rejects malformed IDs. Chrome and Edge registration stays per user and does not require administrator privileges.

The Host writes protocol frames only to stdout. Diagnostics go to stderr and must never contain credentials, decrypted payloads, epoch keys, integrity keys, transfer ciphertext or user field values. Raw SQL is not exposed.
