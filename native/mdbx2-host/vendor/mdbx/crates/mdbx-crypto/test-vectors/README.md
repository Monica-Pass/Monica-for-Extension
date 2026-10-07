# MDBX Crypto Test Vectors

This directory contains stable crypto vectors for compatibility checks across
implementations and future refactors.

## Files

- `crypto-v1.json`: version 1 vector set used by
  `crates/mdbx-crypto/tests/crypto_vectors.rs`.

Run the vector tests with:

```sh
cargo test -p mdbx-crypto --test crypto_vectors
```

## `crypto-v1.json`

Top-level fields:

- `version`: vector file format version.
- `kdf_vectors`: Argon2id key derivation vectors.
- `keyring_vectors`: vault key and domain-separated subkey vectors.
- `aead_vectors`: deterministic XChaCha20-Poly1305 known-answer vectors.

### KDF Vectors

Each KDF vector contains:

- `password_utf8`: password bytes encoded as UTF-8.
- `salt_hex`: Argon2 salt bytes.
- `profile`: Argon2id parameters.
- `expected_key_hex`: expected derived key.

The current v1 profile uses a small test profile:

- `memory_kib`: 8192
- `iterations`: 1
- `parallelism`: 1
- `output_len`: 32

These values are for deterministic, fast test coverage. Production unlock code
may use stronger profiles.

### Keyring Vectors

Each keyring vector derives the root key through the KDF profile, then derives
the vault key and named subkeys with MDBX domain separation.

Covered fields:

- `expected_vault_key_hex`
- `expected_record_subkey_hex`
- `expected_attachment_subkey_hex`
- `expected_metadata_subkey_hex`
- `expected_history_subkey_hex`
- `expected_integrity_subkey_hex`

These vectors are intended to catch accidental changes to key derivation labels,
vault context handling, or subkey ordering.

### AEAD Vectors

The AEAD vector is a raw deterministic XChaCha20-Poly1305 known-answer vector.
It fixes:

- `key_hex`: 32-byte AEAD key.
- `nonce_hex`: 24-byte XChaCha20-Poly1305 nonce.
- `aad_utf8`: associated data.
- `plaintext_hex`: plaintext.
- `ciphertext_hex`: raw encrypted payload including the Poly1305 tag.

This vector intentionally tests the underlying cipher directly through the
`chacha20poly1305` crate so that the nonce can be fixed.

Normal `mdbx_crypto::aead::encrypt` output is not this raw format. Current
application ciphertexts use a committed envelope:

```text
MDBXAE1\0 || commitment || nonce || ciphertext
```

where `commitment` is HMAC-SHA256 over length-delimited
`domain || aad || nonce || ciphertext`.

`mdbx_crypto::aead::decrypt` remains backward-compatible with the older legacy
format:

```text
nonce || ciphertext
```

Use the AEAD unit tests in `src/aead.rs` for envelope behavior, commitment
tamper rejection, wrong-key rejection, and legacy ciphertext compatibility.
