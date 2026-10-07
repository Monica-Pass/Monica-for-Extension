use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

use crate::error::{CryptoError, CryptoResult};

type HmacSha256 = Hmac<Sha256>;

const COMMITTED_MAGIC: &[u8; 8] = b"MDBXAE1\0";
const COMMITMENT_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const COMMITMENT_DOMAIN: &[u8] = b"mdbx-aead-key-commitment-v1";

/// 使用 XChaCha20-Poly1305 加密。
///
/// # Arguments
/// - `key`: 32 字节密钥
/// - `plaintext`: 明文数据
/// - `associated_data`: 关联数据（不加密但参与认证）
///
/// # Returns
/// `(magic || commitment || nonce || ciphertext)` — committed AEAD envelope.
///
/// `decrypt` remains backward-compatible with legacy `(nonce || ciphertext)`
/// values written before the commitment envelope was introduced.
pub fn encrypt(key: &[u8], plaintext: &[u8], associated_data: &[u8]) -> CryptoResult<Vec<u8>> {
    validate_key(key)?;

    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| CryptoError::Encryption(format!("invalid key: {}", e)))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = XNonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: associated_data,
            },
        )
        .map_err(|e| CryptoError::Encryption(format!("encrypt failed: {}", e)))?;

    let commitment = compute_commitment(key, associated_data, &nonce_bytes, &ciphertext)?;

    let mut output =
        Vec::with_capacity(COMMITTED_MAGIC.len() + COMMITMENT_LEN + NONCE_LEN + ciphertext.len());
    output.extend_from_slice(COMMITTED_MAGIC);
    output.extend_from_slice(&commitment);
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// 使用 XChaCha20-Poly1305 解密。
pub fn decrypt(key: &[u8], ciphertext: &[u8], associated_data: &[u8]) -> CryptoResult<Vec<u8>> {
    validate_key(key)?;

    if ciphertext.starts_with(COMMITTED_MAGIC) {
        return decrypt_committed(key, ciphertext, associated_data);
    }

    decrypt_legacy(key, ciphertext, associated_data)
}

fn decrypt_committed(
    key: &[u8],
    ciphertext: &[u8],
    associated_data: &[u8],
) -> CryptoResult<Vec<u8>> {
    let header_len = COMMITTED_MAGIC.len() + COMMITMENT_LEN + NONCE_LEN;
    if ciphertext.len() < header_len + TAG_LEN {
        return Err(CryptoError::Decryption(
            "committed ciphertext too short".to_string(),
        ));
    }

    let commitment_start = COMMITTED_MAGIC.len();
    let nonce_start = commitment_start + COMMITMENT_LEN;
    let payload_start = nonce_start + NONCE_LEN;
    let commitment = &ciphertext[commitment_start..nonce_start];
    let nonce_bytes = &ciphertext[nonce_start..payload_start];
    let encrypted_payload = &ciphertext[payload_start..];

    verify_commitment(
        key,
        associated_data,
        nonce_bytes,
        encrypted_payload,
        commitment,
    )?;

    decrypt_raw(key, nonce_bytes, encrypted_payload, associated_data)
}

fn decrypt_legacy(key: &[u8], ciphertext: &[u8], associated_data: &[u8]) -> CryptoResult<Vec<u8>> {
    if ciphertext.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::Decryption(
            "ciphertext too short (need at least 40 bytes: 24 nonce + 16 tag)".to_string(),
        ));
    }

    decrypt_raw(
        key,
        &ciphertext[..NONCE_LEN],
        &ciphertext[NONCE_LEN..],
        associated_data,
    )
}

fn decrypt_raw(
    key: &[u8],
    nonce_bytes: &[u8],
    encrypted_payload: &[u8],
    associated_data: &[u8],
) -> CryptoResult<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| CryptoError::Decryption(format!("invalid key: {}", e)))?;

    let nonce = XNonce::from_slice(nonce_bytes);

    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: encrypted_payload,
                aad: associated_data,
            },
        )
        .map_err(|_| CryptoError::AuthenticationFailed)?;

    Ok(plaintext)
}

fn validate_key(key: &[u8]) -> CryptoResult<()> {
    if key.len() != 32 {
        return Err(CryptoError::InvalidParameter(
            "key must be 32 bytes for XChaCha20-Poly1305".to_string(),
        ));
    }
    Ok(())
}

fn compute_commitment(
    key: &[u8],
    associated_data: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> CryptoResult<Vec<u8>> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|e| CryptoError::InvalidParameter(format!("invalid HMAC key: {}", e)))?;
    for part in [COMMITMENT_DOMAIN, associated_data, nonce, ciphertext] {
        mac.update(&(part.len() as u64).to_le_bytes());
        mac.update(part);
    }
    Ok(mac.finalize().into_bytes().to_vec())
}

fn verify_commitment(
    key: &[u8],
    associated_data: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
    expected_commitment: &[u8],
) -> CryptoResult<()> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|e| CryptoError::InvalidParameter(format!("invalid HMAC key: {}", e)))?;
    for part in [COMMITMENT_DOMAIN, associated_data, nonce, ciphertext] {
        mac.update(&(part.len() as u64).to_le_bytes());
        mac.update(part);
    }
    mac.verify_slice(expected_commitment)
        .map_err(|_| CryptoError::AuthenticationFailed)
}

/// 生成随机 32 字节密钥。
pub fn generate_key() -> CryptoResult<Vec<u8>> {
    let mut key = vec![0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    Ok(key)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = generate_key().unwrap();
        let plaintext = b"Hello, MDBX! This is secret data.";
        let aad = b"project-id-12345";

        let ct = encrypt(&key, plaintext, aad).unwrap();
        assert!(ct.starts_with(COMMITTED_MAGIC));
        let pt = decrypt(&key, &ct, aad).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn test_decrypt_with_wrong_key_fails() {
        let key1 = generate_key().unwrap();
        let key2 = generate_key().unwrap();
        let plaintext = b"secret message";
        let aad = b"context";

        let ct = encrypt(&key1, plaintext, aad).unwrap();
        let result = decrypt(&key2, &ct, aad);
        assert!(matches!(result, Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn test_decrypt_with_wrong_aad_fails() {
        let key = generate_key().unwrap();
        let plaintext = b"secret message";

        let ct = encrypt(&key, plaintext, b"correct-aad").unwrap();
        let result = decrypt(&key, &ct, b"wrong-aad");
        assert!(matches!(result, Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn test_decrypt_with_tampered_data_fails() {
        let key = generate_key().unwrap();
        let plaintext = b"secret message";
        let aad = b"context";

        let mut ct = encrypt(&key, plaintext, aad).unwrap();
        // 篡改密文（跳过 nonce 部分）
        let payload_offset = COMMITTED_MAGIC.len() + COMMITMENT_LEN + NONCE_LEN;
        ct[payload_offset] ^= 0x01;
        let result = decrypt(&key, &ct, aad);
        assert!(matches!(result, Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn test_decrypt_with_tampered_commitment_fails() {
        let key = generate_key().unwrap();
        let plaintext = b"secret message";
        let aad = b"context";

        let mut ct = encrypt(&key, plaintext, aad).unwrap();
        ct[COMMITTED_MAGIC.len()] ^= 0x01;

        let result = decrypt(&key, &ct, aad);
        assert!(matches!(result, Err(CryptoError::AuthenticationFailed)));
    }

    #[test]
    fn test_legacy_ciphertext_still_decrypts() {
        let key = generate_key().unwrap();
        let plaintext = b"legacy secret";
        let aad = b"legacy-context";
        let nonce_bytes = [3u8; NONCE_LEN];
        let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();
        let encrypted_payload = cipher
            .encrypt(
                XNonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .unwrap();
        let mut legacy = Vec::with_capacity(NONCE_LEN + encrypted_payload.len());
        legacy.extend_from_slice(&nonce_bytes);
        legacy.extend_from_slice(&encrypted_payload);

        let pt = decrypt(&key, &legacy, aad).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn test_encrypt_produces_different_ciphertexts() {
        let key = generate_key().unwrap();
        let plaintext = b"same plaintext";
        let aad = b"same context";

        let ct1 = encrypt(&key, plaintext, aad).unwrap();
        let ct2 = encrypt(&key, plaintext, aad).unwrap();
        // 不同 nonce，密文不同
        assert_ne!(ct1, ct2);
    }

    #[test]
    fn test_invalid_key_length() {
        let result = encrypt(b"short-key", b"data", b"");
        assert!(result.is_err());
    }

    #[test]
    fn test_ciphertext_too_short() {
        let key = generate_key().unwrap();
        let result = decrypt(&key, b"too-short", b"");
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_plaintext() {
        let key = generate_key().unwrap();
        let ct = encrypt(&key, b"", b"context").unwrap();
        let pt = decrypt(&key, &ct, b"context").unwrap();
        assert!(pt.is_empty());
    }

    #[test]
    fn test_large_plaintext() {
        let key = generate_key().unwrap();
        let plaintext = vec![0xAB; 1024 * 1024]; // 1 MiB
        let aad = b"large-data-test";

        let ct = encrypt(&key, &plaintext, aad).unwrap();
        let pt = decrypt(&key, &ct, aad).unwrap();
        assert_eq!(pt, plaintext);
    }
}
