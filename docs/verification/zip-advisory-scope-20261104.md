# ZIP dependency advisory scope

Reviewed on 2026-11-04 for extension 1.0.104 and optional Windows helper 0.1.6.

GitHub reports the same three `zip` 2.4.2 advisories against both the Host and browser Cargo lockfiles: a critical dual-header parser differential, a high-severity symlink-target extraction issue, and a medium-severity AES entry authentication issue. These are real dependency advisories; they have not been dismissed or reported as resolved by this release. A separate medium development-only `minimatch` advisory also remains in the npm lockfile.

## Compiled features and callers

Both root Cargo manifests pin `zip = { version = "=2.4.2", default-features = false }`. `cargo tree --locked -i zip -e features` was run for each manifest and shows only its root application dependency, with no ZIP AES or compression feature enabled. The browser includes the same `native/mdbx2-host/src/local_export.rs` implementation through a source-path module in `native/mdbx2-browser/src/main.rs`.

The only production ZIP reader is `restore_archive` in `local_export.rs`. It uses `ZipArchive` and `by_index` for both name inspection and entry reads. A source search found no `ZipStreamReader`, `read_zipfile_from_stream`, `by_index_decrypt` or general-purpose ZIP `extract` caller in either application.

Before writing an entry, the importer requires either the literal `vault.mdbx` name or the exact `vault.mdbx.blobs/<first-two-hash-characters>/<next-two>/<64-lowercase-hex-hash>` layout. It rejects duplicate names, directories, non-regular Unix modes (including symlinks), compressed entries and empty entries. It limits input and accumulated entry sizes to 512 MiB, bounds copied bytes, uses `create_new` under an independent temporary import directory and validates blob hashes. The database must pass the existing format inspection before the complete directory is published. It does not write arbitrary archive paths or execute archive contents.

## Advisory applicability

- [GHSA-m665-v7pm-7grj](https://github.com/advisories/GHSA-m665-v7pm-7grj), dual-header parser differential: the described chain depends on validating central-directory names with one reader and later extracting local-header names with a streaming reader. This application reads names and data through the same indexed reader and enforces its own output-name whitelist. No streaming extraction stage was found. This review does not assert that zip 2.4.2 itself enforces equal names in both headers.
- [GHSA-q7v9-x93c-xqv3](https://github.com/advisories/GHSA-q7v9-x93c-xqv3), symlink-target extraction: the application does not call the library's filesystem extraction API, and rejects symlink entries before reading their contents or creating their output file.
- AES HMAC on premature EOF: the ZIP AES feature is disabled and no decryption API is called. ZIP content is restricted to the application's stored complete-backup format; vault authentication continues through the existing MDBX implementation.

The reported exploit paths were not found in the current compiled application usage. This is an applicability assessment, not a universal guarantee about all malformed ZIPs or future callers, and not an exploit test against a user's files. Existing import regression coverage includes path and symlink rejection, corrupt blobs and invalid database-only archives.

The patched zip 9.0.5 release declares Rust 1.88 as its minimum, while the Host deliberately pins Rust 1.86.0. This release does not change that toolchain, migrate ZIP APIs or regenerate the browser engine solely to remove advisory labels. A future ZIP dependency/toolchain update still requires both native and browser build/backup interoperability validation. Any new ZIP reader, extraction API, archive layout or feature must revisit this assessment.
