# Monica Extension MDBX2 Architecture

## Status

Accepted for the first functional MDBX2 extension release.

MDBX2 core authority is `Monica-Pass/Mdbx` revision `974c517465e7b6cac0947d2d59875aa4211fa16b`. Monica Android behavior authority is the current `main` integration built on that release line.

## Product boundary

The extension supports MDBX beginning with `MDBX-2`. `MDBX-1` and `MDBX-1-DRAFT` are rejected during read-only preflight. The extension does not invoke the core's MDBX1 automatic migration path.

The first implementation uses a Native Messaging Host. A self-contained WebAssembly implementation remains a separate future project because the current core has no browser build, OPFS VFS or WebAssembly SQLite integration and is coupled to `rusqlite` file-path APIs.

## Components

```text
WebDAV object store
  ├─ vaults/<opaque>.mdbx
  └─ vaults/<opaque>.mdbx.sync/
      ├─ streams/<device>/<generation>/segments/<sequence>-<sha256>.mdbxsync
      └─ blobs/<aa>/<bb>/<sha256>
                ↕
Extension WebDAV object transport
                ↕ bounded ciphertext chunks
Native Messaging RPC
                ↕
Monica MDBX2 Host
  ├─ pinned mdbx-ffi core
  ├─ app-private working copies
  ├─ durable checkpoints, transfer state and Object operation receipts
  └─ encrypted Blob store
```

The remote object tree exactly matches current Monica Android `MdbxRemoteSyncPaths`. A new bootstrap directory convention is not introduced.

## Native host responsibilities

The Host owns every MDBX2 invariant:

- format inspection and MDBX2-only acceptance;
- vault creation, open, unlock and lock;
- stable device identity;
- bounded Collection, Object, attachment, conflict, history and snapshot summaries;
- identifier-free health categories and semantic issue kinds for controlled recovery guidance;
- Tiga authorization and explicit secret disclosure;
- typed multi-object write operations;
- bounded batch mutation receipts and unknown-result recovery;
- Commit2, object versions, tombstones, heads, snapshots and conflicts;
- portable bootstrap creation;
- authenticated incremental segment export, inspection and apply;
- encrypted Blob inventory, chunk I/O and leases;
- rollback anchors, health checks and diagnostics;
- durable local working copy and transfer state.

The Host never logs credentials, decrypted payloads, epoch keys, integrity keys or raw secret fields.

## Extension responsibilities

The extension owns:

- encrypted Provider configuration;
- WebDAV authentication and HTTPS policy;
- bounded stat, listing, directory creation, download and conditional upload;
- Android-compatible immutable object naming;
- synchronization scheduling, cancellation and progress display;
- chunked transfer between WebDAV and the Host;
- M3E management UI and explicit Tiga prompts;
- Popup candidate summaries and single-item disclosure requests;
- install and health status for the Native Host.

Content scripts and the Popup cannot call the Native Host directly. All native requests pass through the privileged background Service Worker and the existing extension-page sender allowlist.

## Native Messaging protocol

Host name: `com.monica_pass.mdbx2`.

Protocol messages use versioned JSON control frames. Binary data is Base64 encoded only inside bounded transfer chunks. Chrome limits a Host-to-extension message to 1 MiB and an extension-to-Host message to 64 MiB, so the protocol uses at most 256 KiB of raw binary per chunk in either direction.

Every request contains:

```json
{
  "protocol": 2,
  "requestId": "uuid",
  "method": "host.hello",
  "params": {}
}
```

Every response contains the same request ID and either a result or a stable error category. Error text is bounded and excludes user data.

Large transfers use explicit begin, chunk, finish and abort methods. A transfer ID binds direction, vault, declared size, expected SHA-256 and durable offset. Chunks must arrive at the next exact offset. Completion verifies size and digest before publication. Retry of an accepted chunk is idempotent.

The background uses `chrome.runtime.connectNative()`. The port keeps an MV3 Service Worker alive on supported Chrome versions; disconnect handlers reopen the port only when an active native task still exists.

Manager commands for WebDAV configuration, bootstrap download, publication, registration, staged-file release, synchronization status, bounded health guidance, commit history/diff and conflict list/resolution are accepted only from `index.html`. Popup and content-script senders are rejected before Provider lookup or network access. Public status responses contain controlled enums, booleans and counts; WebDAV passwords and the opaque synchronization state handle remain in the encrypted Provider record.

Health checks inspect Core descriptions only inside the Native Host. Before crossing Native Messaging, issues are reduced to allowlisted category and semantic issue-kind enums with count and highest severity. Raw descriptions, local paths, Vault/Device/Object/Commit identifiers and future unknown category strings never enter the manager page.

History pages contain at most 50 commits and are additionally capped at 850 KiB before framing. Commit diffs inherit the core's 500-Object limit. The Host removes decrypted previous/current payload previews and returns only a `payloadChanged` flag, titles, deletion state and changed-field names. The M3E list presents human operation labels and times without showing technical Object or Commit IDs in the primary view.

Conflict pages contain at most 50 unresolved summaries and are capped at 850 KiB. The Host removes base/local/incoming Commit IDs and never returns payload previews; it exposes only an opaque conflict handle, Object kind, current local display metadata, conflicting field names and time. Resolution accepts only the core-equivalent `local-wins` and `incoming-wins` choices. Each mutation uses a random durable operation receipt, rejects changed retry intent and fails closed with an unknown-outcome error if the core transaction completed but the receipt could not be persisted.

## Local files

The Host stores data below the current user's application-data directory:

```text
Monica Extension/MDBX2/
  device.json
  vaults/<opaque-vault-handle>/vault.mdbx
  vaults/<opaque-vault-handle>/blobs/<aa>/<bb>/<sha256>
  transfers/<opaque-transfer-id>.part
  transfers/<opaque-transfer-id>.state.<slot>.json
  sync/states/<opaque-state-handle>.state.<slot>.json
  operations/object-operations.state.<slot>.json
  operations/conflict-resolutions.state.<slot>.json
```

User-controlled titles, domains and account names never appear in file names. Object-operation receipts contain random IDs, bounded hashes, changed indexes and Commit IDs. Conflict receipts contain only opaque IDs, Object type, the selected winner and timestamps. Neither receipt format stores decrypted titles or Object payloads. Local sync state also contains no decrypted payload. Windows ACLs and user scope provide the outer filesystem boundary; MDBX2 remains encrypted at rest.

## WebDAV rules

- HTTPS is mandatory except loopback development servers.
- Redirects are rejected.
- Provider requests cannot cross the configured origin.
- Segment and Blob uploads use create-only semantics.
- Existing immutable objects are accepted only after exact size and SHA-256 verification.
- Provider collisions stop the affected stream.
- ETag is the only accepted WebDAV conditional-replacement token.
- Bootstrap download and every segment/Blob transfer use declared and streamed size limits.

## Synchronization order

Upload:

1. Reuse or create a durable authenticated pending segment.
2. Upload referenced encrypted Blobs.
3. Upload the immutable segment.
4. Persist the new export checkpoint.

Download:

1. Enumerate remote streams other than the local device.
2. Download only the next expected segment for each stream.
3. Let the Host authenticate and atomically apply it.
4. Persist the local export checkpoint immediately.
5. Download and verify referenced missing Blobs.
6. Advance the remote stream cursor.

Missing parents, sequence gaps and digest collisions block only their stream and remain visible in diagnostics.

## Provider migration

The old extension `mdbx` provider is retired. Existing persisted accounts are kept as disabled legacy records and never opened by the MDBX2 Host. New accounts use an explicit MDBX2 generation marker. sql.js and the historical MDBX1 browser crypto/writer are removed after the Host-backed provider is active.

## Security review requirements

Adding `nativeMessaging` changes the extension permission surface and requires updates to the manifest audit. The Host manifest uses exact `allowed_origins`; installers never use a wildcard. Release checks build and test the Host from a pinned core revision and verify the executable hash included in the installer metadata.

The Native Host is part of the trusted computing base. Release packaging therefore includes Cargo dependency locking, license review, source revision verification, unit tests, protocol fuzz-style boundary tests and a Windows installer verification step.

The Windows x64 release is a separate reproducible ZIP containing the exact tested executable, per-user Chrome and Edge installer, uninstaller, manifest template, lockfile, license and executable metadata. Installation requires one or two explicit 32-character extension IDs and writes exact Native Messaging origins under `HKCU`.

## Compatibility claim

Automated tests can prove protocol, fixture and simulated WebDAV behavior. Full Android compatibility requires a real Android-created MDBX2 vault, real WebDAV segment exchange in both directions, edits on both clients, conflict handling, Blob transfer and Android reopen verification.
