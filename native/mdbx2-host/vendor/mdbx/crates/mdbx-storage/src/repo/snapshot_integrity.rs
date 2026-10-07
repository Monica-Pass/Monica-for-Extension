use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};

pub(super) const AUTHENTICATED_CIPHERTEXT_MAGIC: &[u8; 8] = b"MDBXSN2\0";

const SNAPSHOT_INTEGRITY_DOMAIN: &[u8] = b"mdbx-snapshot-record-integrity-v1";
const SNAPSHOT_INTEGRITY_PROFILE: &str = "hmac-sha256-v1";
const SHA256_BYTES: usize = 32;
const SHA256_HEX_BYTES: usize = SHA256_BYTES * 2;
const MAX_DESCRIPTOR_BYTES: usize = 256;

pub(super) struct SnapshotIntegrityInput<'a> {
    pub snapshot_id: &'a str,
    pub base_commit_id: &'a str,
    pub snapshot_ct: &'a [u8],
    pub created_at: &'a str,
    pub created_by_device_id: &'a str,
}

pub(super) fn wrap_authenticated_ciphertext(ciphertext: Vec<u8>) -> Vec<u8> {
    let mut wrapped = Vec::with_capacity(AUTHENTICATED_CIPHERTEXT_MAGIC.len() + ciphertext.len());
    wrapped.extend_from_slice(AUTHENTICATED_CIPHERTEXT_MAGIC);
    wrapped.extend_from_slice(&ciphertext);
    wrapped
}

pub(super) fn authenticated_ciphertext_inner(ciphertext: &[u8]) -> Option<&[u8]> {
    ciphertext.strip_prefix(AUTHENTICATED_CIPHERTEXT_MAGIC)
}

pub(super) fn issue_descriptor(
    conn: &VaultConnection,
    input: &SnapshotIntegrityInput<'_>,
) -> StorageResult<String> {
    let digest = ciphertext_sha256(input.snapshot_ct);
    if authenticated_ciphertext_inner(input.snapshot_ct).is_none() {
        return Ok(encode_hex(&digest));
    }

    let keyring = conn.keyring().ok_or_else(|| {
        StorageError::Validation(
            "authenticated snapshot ciphertext requires an unlocked keyring".to_string(),
        )
    })?;
    let vault_id = vault_id(conn)?;
    let tag = mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &integrity_parts(input, &vault_id, &digest),
    )
    .map_err(StorageError::Crypto)?;
    Ok(format!(
        "{SNAPSHOT_INTEGRITY_PROFILE}:{}:{}",
        encode_hex(&digest),
        encode_hex(&tag)
    ))
}

pub(super) fn verify_descriptor(
    conn: &VaultConnection,
    input: &SnapshotIntegrityInput<'_>,
    descriptor: &str,
) -> StorageResult<bool> {
    if descriptor.len() > MAX_DESCRIPTOR_BYTES {
        return Ok(false);
    }
    let digest = ciphertext_sha256(input.snapshot_ct);
    let Some(_) = authenticated_ciphertext_inner(input.snapshot_ct) else {
        return Ok(descriptor == encode_hex(&digest));
    };

    let Some((encoded_digest, encoded_tag)) = parse_authenticated_descriptor(descriptor) else {
        return Ok(false);
    };
    if encoded_digest != encode_hex(&digest) {
        return Ok(false);
    }
    let Some(tag) = decode_hex_32(encoded_tag) else {
        return Ok(false);
    };
    let Some(keyring) = conn.keyring() else {
        return Ok(true);
    };
    let vault_id = vault_id(conn)?;
    Ok(mdbx_crypto::integrity::verify_hmac_sha256(
        &keyring.integrity_subkey,
        &integrity_parts(input, &vault_id, &digest),
        &tag,
    )
    .is_ok())
}

#[cfg(test)]
pub(super) fn ciphertext_sha256_hex(ciphertext: &[u8]) -> String {
    encode_hex(&ciphertext_sha256(ciphertext))
}

fn ciphertext_sha256(ciphertext: &[u8]) -> [u8; SHA256_BYTES] {
    Sha256::digest(ciphertext).into()
}

fn integrity_parts<'a>(
    input: &'a SnapshotIntegrityInput<'a>,
    vault_id: &'a str,
    digest: &'a [u8; SHA256_BYTES],
) -> [&'a [u8]; 8] {
    [
        SNAPSHOT_INTEGRITY_DOMAIN,
        SNAPSHOT_INTEGRITY_PROFILE.as_bytes(),
        vault_id.as_bytes(),
        input.snapshot_id.as_bytes(),
        input.base_commit_id.as_bytes(),
        digest,
        input.created_at.as_bytes(),
        input.created_by_device_id.as_bytes(),
    ]
}

fn vault_id(conn: &VaultConnection) -> StorageResult<String> {
    conn.inner()
        .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::Database)
}

fn parse_authenticated_descriptor(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.split(':');
    if parts.next()? != SNAPSHOT_INTEGRITY_PROFILE {
        return None;
    }
    let digest = parts.next()?;
    let tag = parts.next()?;
    if parts.next().is_some() || digest.len() != SHA256_HEX_BYTES || tag.len() != SHA256_HEX_BYTES {
        return None;
    }
    Some((digest, tag))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn decode_hex_32(value: &str) -> Option<[u8; SHA256_BYTES]> {
    if value.len() != SHA256_HEX_BYTES {
        return None;
    }
    let mut decoded = [0_u8; SHA256_BYTES];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        decoded[index] = (decode_nibble(pair[0])? << 4) | decode_nibble(pair[1])?;
    }
    Some(decoded)
}

fn decode_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}
