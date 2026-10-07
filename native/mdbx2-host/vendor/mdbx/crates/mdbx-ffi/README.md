# MDBX FFI

Language: [简体中文](README.zh-CN.md) | [English](README.md)

`mdbx-ffi` is the generic UniFFI boundary for non-Rust MDBX clients. It exposes the safe storage/repository facade for vault creation, unlock, Collections, generic Objects, and attachments, while keeping product-specific payload semantics in each client.

This crate is intentionally not a low-level SQLite API. If a client needs tags, attachments, sync, conflicts, snapshots, or diagnostics through FFI, add explicit facade methods here with tests instead of writing MDBX tables directly from the client.

## Current Scope

The exported boundary covers:

- inspect the current library's compiled storage and sync capabilities without opening a vault
- create a vault with password unlock, defaulting to `Multi` Tiga mode
- create a vault with explicit `Sky`, `Multi`, or `Power` Tiga mode
- open a vault with password unlock
- inspect migration requirements without changing the vault and explicitly invoke the storage-core upgrade
- create a read-only pre-migration portable backup from a vault path
- create a verified, no-clobber, single-file portable backup from an open vault
- configure local security-key-material unlock on an already unlocked vault
- open a vault with local security-key material
- reset the master password on an already unlocked vault
- inspect the complete effective Tiga2 runtime policy at vault, project, or entry scope
- authorize sensitive operations with typed outcomes, reasons, and client constraints
- supply real device assurance and platform-protection capabilities
- inspect active-session activity, unlock-policy compliance, and security audit events
- apply an exact audited exception when explicitly weakening a vault profile
- configure and open password + security-key combined unlock methods
- list and remove unlock methods through authorized storage APIs
- rotate the data-key epoch through Tiga authorization and return the old epoch, new active epoch, rotation commit, and timestamp
- create projects
- discover active and deleted Collections through bounded payload-free summary pages
- page bounded attachment summaries by Collection or Object, read deleted attachment summaries, and inspect one attachment's metadata without loading chunk/blob payloads
- register and discover loaded Extension Profiles, activate capabilities actually present in the client, and read or set Collection Profiles
- create, list, update, soft-delete, restore, and move generic entries
- create, query, update, and delete generic relations, labels, and label assignments
- list unresolved conflicts and resolve project, entry, attachment, relation, label, and assignment conflicts with local-wins or incoming-wins
- page bounded unresolved conflict summaries with optional object-type filtering and discover the fixed limits contract
- apply validated custom payload or generic metadata conflict resolutions
- page bounded snapshot summaries, read one snapshot's metadata, and discover the fixed navigation limits contract

The boundary does not currently expose:

- project update/delete flows
- nested folder-specific operations beyond project containers
- tags
- external Blob Provider transfer and maintenance operations beyond the attachment APIs above
- sync bundle/apply operations
- complete snapshot creation, verification, export, and restore flows
- diagnostics and maintenance data

Treat unsupported features as missing facade methods, not permission to bypass the storage layer.

## Data Model

### Records

`MdbxBuildCapabilityManifest` is returned by the top-level
`mdbx_build_capability_manifest` function before any vault is selected. It
contains versioned, canonical enabled and omitted-optional lists for storage and
sync. It describes compiled code only: it does not register a Collection
Adapter, accept a vault critical extension, grant key access, or negotiate a
peer session.

The top-level `mdbx_runtime_manifest` function also works without opening a
vault. Its independent `MdbxRuntimeManifest` reports the MDBX3 Runtime version,
the `MDBX-2` write format, current schema, readable legacy formats,
`mdbx-ffi-abi-v1`, the `mdbx_ffi` namespace, and the Android
`libmdbx_ffi.so` filename. This is an additive interface; existing MDBX2
bindings and `MdbxBuildCapabilityManifest` remain unchanged.

`abi/mdbx2-uniffi-bindings-v1.json` freezes every native symbol, the UniFFI
contract version, and 237 API checksums declared by the MDBX2 Kotlin bindings.
`scripts/verify-mdbx3-ffi-abi.py` dynamically loads the current DLL, SO, or
dylib and verifies each item. New interfaces may be added, but a missing legacy
symbol or changed checksum fails the build.

`MdbxExtensionProfile` is the canonical process-local descriptor for one
loaded Adapter. It declares the Adapter's namespaced Collection types, custom
Object types, relation kinds, write-gating capabilities, optional indexes,
import/export paths, and presentation hints. `MdbxExtensionRegistration`
distinguishes a new registration from an exact idempotent duplicate.

Use `register_extension_profile`, `replace_extension_profiles`,
`get_extension_profile`, `list_extension_profiles`, and
`unregister_extension_profile` to manage the registry. Registration and bulk
replacement are atomic, at most 256 profiles may be present, and reopening a
vault starts with an empty registry. Profiles are discovery and validation
metadata only: they are not written to the vault, snapshot, or sync state and
grant no SQL, key, critical-extension, or Tiga authority.

`VaultInfo` contains:

- `vault_id`: stable vault identifier read from `vault_meta`
- `device_id`: caller-supplied device identifier used for commit context

`MdbxBackupInfo` contains:

- `vault_id`: source and backup identity
- `format_version`: verified MDBX format generation
- `schema_version`: verified schema version
- `file_size_bytes`: published backup size

`ProjectRecord` contains:

- `project_id`
- `title`

`MdbxCollectionProfile` contains the Collection's namespaced type, versioned binary encrypted configuration, allowed ObjectTypeIds, required ExtensionCapabilityIds, and creation/update device metadata.

`MdbxCollectionSummary` is the default top-level navigation record. It contains the Collection ID, bounded title, optional Profile type/version, group/icon references, favorite/archive state, attachment count, head commit, deletion state, and update time; it never contains `summary_ct` or Profile payload. Use `list_collection_summaries` and `list_deleted_collection_summaries` with a page size from 1 through 200 and pass the returned cursor only to the same query. `get_collection_summary` includes a tombstone by ID.

Call `default_presentation_metadata_limits` to discover the fixed contract: 64 KiB title plaintext, 512-byte label-name plaintext, 4096 UTF-8-byte references, 200 summary rows per page, and 4096-byte cursors. A legacy row outside a presentation limit fails closed on the bounded summary path; complete compatibility reads remain available for explicit repair/export.

`MdbxAttachmentSummary` is the bounded attachment navigation record. Use `list_attachment_summaries` with `object_id = None` for a Collection or an Object ID for an Object, `list_deleted_attachment_summaries` for tombstones, and `get_attachment_summary` for by-ID metadata. The record contains authenticated file name/media type, ownership, storage mode, content hash, sizes, chunk count, head commit, deletion state, and update time, but never chunk bodies or external blob references. `default_attachment_presentation_limits` reports a 4096-byte file-name limit, 512-byte media-type limit, shared 128 KiB ciphertext-envelope allowance, a 200-row page ceiling, and a 4096-byte cursor ceiling. Existing complete attachment methods remain the compatibility and explicit content/repair path.

`MdbxConflictSummary` is the bounded unresolved-conflict queue record. Call
`list_unresolved_conflict_summaries(object_type, page_size, cursor)` with an
optional core object type and reuse the returned cursor only for that exact
query. `default_conflict_summary_limits` reports the 200-row page ceiling,
4096-byte cursor ceiling, 64 KiB stored field-JSON ceiling, 256-path ceiling,
and 4096-byte per-path ceiling. The summary contains stable object/commit
identities and bounded field paths, but is not a plaintext disclosure or
resolution operation. Existing complete conflict reads and typed resolution
methods remain the explicit compatibility, repair, and mutation paths.

`MdbxSnapshotSummary` is the bounded snapshot-management record. Use
`list_snapshot_summaries(page_size, cursor)` for a queue and
`get_snapshot_summary(snapshot_id)` for metadata-only detail; call
`default_snapshot_summary_limits` to discover the 1–200 row, 4096-byte cursor,
and 4096-byte metadata-text limits. The record includes stable snapshot/base
commit identities, descriptor hash, creation metadata, and
`snapshot_ciphertext_bytes`, but never `snapshot_ct`. The byte count is a
storage-size projection rather than an integrity result. Summary SQL does not
select, decrypt, deserialize, or verify the encrypted payload, so corrupt or
large snapshots remain navigable. Existing complete snapshot operations are
outside this facade and must be reached through their authorized storage/API
boundary when payload-dependent work is required.

Call `set_extension_capabilities` before mutating a profiled Collection and declare only Adapter capabilities actually present in the current process. Capability activation is separate from Extension Profile registration: registering a descriptor never activates its capabilities. Neither declaration is persisted or grants key access. `set_collection_profile` establishes or advances a Profile; its CollectionTypeId is immutable. When a registered descriptor owns that type, the Collection Profile's allowed ObjectTypeIds and required capabilities must be subsets of the descriptor. When the descriptor contract or required capabilities are not satisfied, user-visible Project, ObjectRecord, Relation, Label, Assignment, Attachment, and conflict-resolution mutations return a storage error. Opaque reads, synchronization, backup, restore, and recovery remain available.

`create_payload_migration_plan` creates a bounded migration plan for one ObjectTypeId and now requires an active authenticated session. It uses the conservative Standard device profile; clients with real device evidence can call `create_payload_migration_plan_with_device_context`. Plan creation authorizes `MigratePayload` against the Collection Project scope before loading or decrypting source bytes. `MdbxPayloadMigrationPlan.items` carries the source payload bytes, source digest, and object head that the Adapter needs to interpret, while the security audit is correlated by `plan_id` without a commit.

After producing one `MdbxPayloadMigrationOutput` per item, call `execute_payload_migration` or `execute_payload_migration_with_device_context`. Execution reauthorizes, rechecks the Profile, capabilities, branch head, object heads, type, versions, and digests, then updates the complete batch with one idempotent commit and one commit-correlated audit in the same transaction. Exact retries return the original commit without another successful audit. A plan contains at most 256 items, each item is at most 1 MiB, and source and target batches are each limited to 8 MiB. `remaining_count` reports objects for later batches. Plans contain decrypted sensitive data and must not be logged, cached, persisted, or synchronized by the client.

`EntryRecord` contains:

- `entry_id`
- `project_id`
- `entry_type`
- `title`
- `payload_json`
- `deleted`

`MdbxKeyEpochRotationResult` contains:

- `previous_epoch_id`: the active epoch before rotation
- `active_epoch_id`: the epoch used for subsequent field writes
- `commit_id`: the `key-rotation` / `key-epoch` commit
- `rotated_at`: the UTC rotation time

### Tiga2 Runtime Boundary

`MdbxDeviceContext` carries the device evidence used for each authorization decision. Clients must report actual platform capabilities and must not claim `TrustedHardware`, secure clipboard, screen-capture protection, or secure temporary files unless those protections are active for the operation.

Call `resolve_tiga_policy` to obtain the complete effective policy for a vault, project, or entry. Call `authorize_tiga_operation` immediately before a client-owned sensitive action. Only `Allow` and `AllowWithConstraints` permit the action. Every returned constraint must be enforced by the client; a confirmation dialog does not override `RequireFreshAuthentication`, `RequireAdditionalFactor`, or `Deny`.

Successful connection-backed authorization renews the session idle timestamp without changing the original authentication timestamp or absolute lifetime. `active_session_info`, `assess_tiga_unlock_policy`, and `list_security_audit_events` expose the state needed for client security UI without exposing credential or key material.

`set_tiga_profile` requires a non-empty reason when weakening the current baseline. The storage core creates and persists an exact scope-bound policy exception. Strengthening the profile clears an active vault-level weakening override.

Power remediation is available through `setup_password_security_key_unlock`, `list_unlock_methods`, and `remove_unlock_method`. After removing weaker standalone fallbacks, reopen with `open_vault_with_password_security_key` so the active session carries both factors.

Use `inspect_vault_migration` before opening when the client needs upgrade consent, backup, or progress UI. After consent, call `upgrade_vault`; the deterministic field conversion remains entirely inside `mdbx-storage`. The ordinary `open_vault` functions retain automatic upgrade for compatibility-oriented callers.

For client-controlled migration, call top-level `create_portable_backup(source_path, destination)` after `inspect_vault_migration` and before `upgrade_vault`. It opens the source read-only, requires no unlock credentials, retains MDBX1 or MDBX2 metadata, includes committed WAL pages, and leaves the persistent source database and WAL bytes unchanged.

Call `MdbxVault.create_backup(destination)` for an already open vault. Both interfaces verify integrity and MDBX identity and publish one file without replacing an existing destination, `-wal`, or `-shm` artifact. The backup retains the source unlock methods and reopens with the same credentials. It is separate from a vault-internal snapshot and a sync bundle; clients must not copy only the SQLite main file while WAL is active.

The Rust storage core applies `SyncStateLimits` independently to complete sync state bytes and logical rows. UniFFI currently uses the default limits of 96 MiB and 250,000 rows; native Rust callers that use an explicit apply facade should select the same limits for collection, decoding, and apply. Reserved state types require the `state` object ID and matching associated data; an identity or resource violation rolls back the complete sync transaction.

### Key Epoch Rotation

Call `MdbxVault.rotate_key_epoch(device)` with an active unlock session and truthful device capabilities. In one transaction, storage generates a random 32-byte epoch key, wraps it, retires the previous active epoch, activates the new epoch, creates the rotation commit, and correlates the Tiga audit event with that commit. Authorization denial or transaction failure leaves the active epoch and rotation-commit count unchanged.

After success, distribute the returned `commit_id` and its authenticated sync state to other replicas before allowing fields written under the new epoch to leave the device. Receivers should use the mutable verified-unlocked storage apply entry so active and retired wrappers are authenticated and the connection keyring is refreshed before return. Concurrent rotations retain both epochs and deterministically converge on one active epoch.

Rotation is not an ordinary idempotent operation API. If a network response is unknown, query commit history or security audit correlation before requesting another rotation. A deliberate second call is a new security-administration action and creates another epoch and commit.

### Entry Types

The legacy single-entry methods parse `entry_type` through the MDBX1 adapter. Current accepted values are:

- `login`
- `note`
- `totp`
- `card`
- `identity`
- `passkey`
- `ssh-key`
- `api-token`
- `document-ref`

Invalid values return `MdbxFfiError::InvalidEntryType`.

### Bounded Generic Write Operations

Use `execute_write_operation` or `execute_write_operation_on_branch` when one user action changes several Collections or Objects. One call is atomic, creates one commit, and uses the complete command list as its idempotent intent. These operation commands additionally accept namespaced ObjectTypeIds such as `com.monica.mail.message`; the legacy single-entry methods retain their published MDBX1 type boundary.

The compatibility methods default to 256 commands, 1 MiB per JSON payload, 8 MiB total JSON payload, and 16 MiB serialized intent. `default_write_operation_limits` returns this profile. New clients may call the `*_with_limits` methods with an explicit profile, subject to hard ceilings of 4,096 commands, 16 MiB per payload, 64 MiB total payload, and 128 MiB intent. The FFI facade converts DTOs to `mdbx-storage::repo::WriteCommand` and delegates preparation, validation, intent hashing, change summaries, and repository execution to `OperationCoordinator`. These checks happen before the vault write lock and transaction. Split larger imports into new operation IDs; retry a batch with its original operation ID and exact commands.

### Paginated Object Summaries

Use `list_object_summaries` for collection and search-result screens. It returns a bounded page containing object identity, type, title, payload schema version, head commit, and update time without reading or decrypting `payload_json`.

Use `get_object_summary(object_id)` for a metadata-only detail screen. It also avoids `payload_json` and can return the metadata of a soft-deleted object, which lets a client identify a damaged or deleted record without first decrypting its payload.

Use `list_deleted_object_summaries(collection_id, object_type_id, page_size,
cursor)` for deleted objects in one Collection, or
`list_all_deleted_object_summaries(object_type_id, page_size, cursor)` for a
global tombstone view. These additive methods use the same payload-free record,
1–200 page bound, and 4096-byte cursor ceiling. The opaque `next_cursor` is
bound to active/deleted state, Collection scope, and optional object type;
reusing it with different filters returns an error. The SQL projection never
selects `payload_ct`, so corrupt object payloads do not block deleted
navigation. Existing complete list methods remain available for explicit
restore/export/repair workflows.

### Authorized Object Disclosure

Use `reveal_object(object_id)` only after an explicit user disclosure action. It uses the active vault session, a conservative Standard device profile, and storage `TigaOperation::RevealSecret`. Clients with real platform protection can call `reveal_object_with_device_context` and report those capabilities explicitly.

Both methods return `MdbxObjectDisclosureResult`. `object` is present only for `Allow` or `AllowWithConstraints`; `authorization` always contains the typed outcome, reasons, constraints, and audit requirement. A missing/stale session or policy denial is therefore not flattened into an error and never carries `payload_json`. The client must satisfy or execute the returned constraints.

Existing `get_object`, `list_objects`, `list_entries`, and their complete-payload behavior remain unchanged for MDBX1 and already generated clients. They are compatibility APIs, not the default read path for new user interfaces.

### Payload JSON

`payload_json` must be a valid JSON string. The FFI layer validates that it parses as JSON and stores the parsed value through the storage repository APIs.

MDBX deliberately keeps the FFI entry payload generic. Clients own their product payload schema and should use explicit version/kind fields when they need stable interpretation. A typical login payload can look like:

```json
{
  "kind": "password",
  "schemaVersion": 1,
  "username": "alice@example.com",
  "password": "secret",
  "url": "https://example.com",
  "favorite": false
}
```

When an entry is returned, `payload_json` is serialized back from the stored JSON value. Do not depend on original whitespace or object key ordering being preserved.

## Error Behavior

All exported functions return `Result<_, MdbxFfiError>`.

- `Storage { message }`: storage, unlock, constraint, or repository failure
- `Serialization { message }`: invalid JSON input or invalid stored JSON
- `InvalidEntryType { entry_type }`: unknown entry type string
- `InvalidConflictObjectType { object_type }`: unknown conflict object type filter
- `InvalidCollectionTypeId { collection_type_id }`: invalid or non-namespaced Collection type
- `InvalidExtensionCapabilityId { capability_id }`: invalid extension capability identifier
- `InvalidExtensionId { extension_id }`: invalid or non-namespaced extension identifier
- `InvalidExtensionFeatureId { feature_id }`: invalid optional extension feature identifier
- `LockPoisoned`: the internal vault mutex was poisoned

Common constraint errors include updating a deleted entry, deleting an already deleted entry, restoring an active entry, moving a deleted entry, or using an entry ID that does not belong to the supplied project ID.

`reveal_object*` treats a Tiga non-allow decision as a typed `MdbxObjectDisclosureResult` with `object = None`. Missing objects, deleted-object disclosure, invalid stored JSON, crypto failure after an allowed decision, and other storage failures still return `MdbxFfiError`.

## Rust Usage Example

The Rust tests exercise the same facade that UniFFI exports:

```rust
use mdbx_ffi::{create_vault, open_vault, MdbxFfiError};

fn main() -> Result<(), MdbxFfiError> {
    let path = "/tmp/example.mdbx".to_string();
    let password = "correct horse battery staple".to_string();
    let device_id = "desktop-1".to_string();

    let vault = create_vault(path.clone(), password.clone(), device_id.clone())?;
    let project = vault.create_project("Personal".to_string())?;

    let entry = vault.create_entry(
        project.project_id.clone(),
        "login".to_string(),
        "Example".to_string(),
        r#"{"kind":"password","schemaVersion":1,"username":"alice"}"#.to_string(),
    )?;

    let summary = vault.get_object_summary(entry.entry_id.clone())?.unwrap();
    assert_eq!(summary.title, "Example");

    let disclosed = vault.reveal_object(entry.entry_id.clone())?;
    assert!(disclosed.object.is_some());

    drop(vault);
    let reopened = open_vault(path, password, device_id)?;
    assert!(!reopened.info().vault_id.is_empty());
    Ok(())
}
```

## Generating Bindings

Install the UniFFI CLI that matches the crate dependency:

```sh
cargo install uniffi --version 0.31.1 --locked --features cli
```

Build the dynamic library:

```sh
cargo build -p mdbx-ffi
```

Generate Swift bindings from the dynamic library:

```sh
uniffi-bindgen-swift --swift-sources target/debug/libmdbx_ffi.dylib ./generated
uniffi-bindgen-swift --headers target/debug/libmdbx_ffi.dylib ./generated
```

On Linux the dynamic library is `target/debug/libmdbx_ffi.so`; on Windows it is `target/debug/mdbx_ffi.dll`. Platform packaging still needs the matching static or dynamic library to be shipped with the generated bindings.

## iOS Notes

The Monica iOS workspace keeps helper scripts outside this repository. The expected packaging flow is:

- build `mdbx-ffi` for device and simulator targets
- generate Swift, header, and modulemap files with `uniffi-bindgen-swift`
- package the static libraries and generated header as an XCFramework
- include the generated Swift source and XCFramework from the Swift package or app target

Generated bindings should be treated as build artifacts. Regenerate them from this crate instead of editing generated Swift or headers by hand.

## Extending The FFI Boundary

When adding a new cross-language capability:

1. Add typed UniFFI records/enums that match client needs without leaking raw storage rows.
2. Implement the method by calling `mdbx-storage` repository/service APIs.
3. Preserve commit, object-version, tombstone, branch-head, device-head, key-epoch, conflict, snapshot, and sync-state invariants.
4. Add or update `crates/mdbx-ffi/tests/ffi_smoke.rs` to cover the exported behavior.
5. Run at least `cargo test -p mdbx-ffi`; run full `cargo test` when touching shared storage behavior.

Do not expose methods that let clients write `commits`, `commit_parents`, `object_versions`, `tombstones`, `snapshots`, `key_epochs`, `conflicts`, `device_heads`, `branches`, or `project_tags` directly.

## Verification

Run the FFI test suite from the repository root:

```sh
cargo test -p mdbx-ffi
```

The smoke tests verify vault create/open, entry round trips, update/delete/restore/move flows, security-key-material unlock, master-password reset, full Tiga2 policy and authorization mapping, exact exceptions, and Power combined-factor remediation.
