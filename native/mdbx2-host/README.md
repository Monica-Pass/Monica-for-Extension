# Monica MDBX2 Native Host

This process is the trusted MDBX2 runtime for Monica Extension. It uses the exact Monica MDBX2 core instead of reproducing format, cryptography, Commit2 or synchronization rules in TypeScript.

## Core pin

`mdbx-ffi` is fetched from `https://github.com/Monica-Pass/Mdbx.git` at revision:

```text
aafa22f195c626a8d8288d712bf42bccea134847
```

The Rust toolchain is pinned to `1.86.0` to match the MDBX2 release build.

## Current protocol

Host name: `com.monica_pass.mdbx2`

Protocol version 1 exposes the pinned capability handshake, durable inbound file staging and the first MDBX2 vault lifecycle methods:

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
```

The handshake reports the Host version, exact core revision, MDBX2 format generation, build capability manifest, 256 KiB chunk limit, 2 GiB file limit and supported unlock methods. It explicitly reports `supportsMdbx1: false`.

Native Messaging messages are framed as four native-endian length bytes followed by UTF-8 JSON. Input control frames are limited to 1 MiB and Host output frames to 900 KiB. Binary transfers use at most 256 KiB of raw bytes per Base64 chunk.

Inbound transfer state uses two alternating durable metadata slots. Chunks require the exact durable offset; a byte-identical retry is idempotent. `transfer.finish` verifies declared size and SHA-256 before publishing an opaque file handle.

`vault.inspect` calls the core's read-only migration inspection and accepts exact `MDBX-2` only. `MDBX-1` and `MDBX-1-DRAFT` are rejected before `open_vault*` can invoke automatic migration. Older MDBX2 schemas receive a local portable backup before the pinned core upgrades the app-private working copy.

## Build

```powershell
cargo test --manifest-path native/mdbx2-host/Cargo.toml
cargo build --release --manifest-path native/mdbx2-host/Cargo.toml
```

## Installation security

The native-host manifest must contain the absolute executable path and exact `chrome-extension://<id>/` origins. Wildcards are forbidden. A later release step will generate the final Chrome and Edge manifests from reviewed extension IDs and register them per user.

The Host writes protocol frames only to stdout. Diagnostics go to stderr and must never contain credentials, decrypted payloads, epoch keys, integrity keys, transfer ciphertext or user field values.

## Planned API groups

1. Bounded Collection and Object summaries plus Tiga disclosure.
2. Typed write operations.
3. Incremental bootstrap, authenticated segment and encrypted Blob operations.
4. Conflict, snapshot and history summaries.

Raw SQL will not be exposed.
