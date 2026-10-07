use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use mdbx_crypto::{
    kdf::{self, Argon2Params},
    keyring::Keyring,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct VectorFile {
    kdf_vectors: Vec<KdfVector>,
    keyring_vectors: Vec<KeyringVector>,
    aead_vectors: Vec<AeadVector>,
}

#[derive(Debug, Deserialize)]
struct KdfProfile {
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    output_len: usize,
}

#[derive(Debug, Deserialize)]
struct KdfVector {
    password_utf8: String,
    salt_hex: String,
    profile: KdfProfile,
    expected_key_hex: String,
}

#[derive(Debug, Deserialize)]
struct KeyringVector {
    password_utf8: String,
    salt_hex: String,
    vault_context_utf8: String,
    profile: KdfProfile,
    expected_vault_key_hex: String,
    expected_record_subkey_hex: String,
    expected_attachment_subkey_hex: String,
    expected_metadata_subkey_hex: String,
    expected_history_subkey_hex: String,
    expected_integrity_subkey_hex: String,
}

#[derive(Debug, Deserialize)]
struct AeadVector {
    key_hex: String,
    nonce_hex: String,
    aad_utf8: String,
    plaintext_hex: String,
    ciphertext_hex: String,
}

fn load_vectors() -> VectorFile {
    serde_json::from_str(include_str!("../test-vectors/crypto-v1.json")).unwrap()
}

fn params(profile: &KdfProfile) -> Argon2Params {
    Argon2Params {
        memory_kib: profile.memory_kib,
        iterations: profile.iterations,
        parallelism: profile.parallelism,
        output_len: profile.output_len,
    }
}

fn decode_hex(input: &str) -> Vec<u8> {
    assert_eq!(input.len() % 2, 0);
    (0..input.len())
        .step_by(2)
        .map(|idx| u8::from_str_radix(&input[idx..idx + 2], 16).unwrap())
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}

#[test]
fn kdf_vectors_match() {
    for vector in load_vectors().kdf_vectors {
        let salt = decode_hex(&vector.salt_hex);
        let key = kdf::derive_key(
            vector.password_utf8.as_bytes(),
            &salt,
            &params(&vector.profile),
        )
        .unwrap();
        assert_eq!(encode_hex(&key), vector.expected_key_hex);
    }
}

#[test]
fn keyring_vectors_match() {
    for vector in load_vectors().keyring_vectors {
        let salt = decode_hex(&vector.salt_hex);
        let keyring = Keyring::derive(
            vector.password_utf8.as_bytes(),
            &salt,
            &params(&vector.profile),
            vector.vault_context_utf8.as_bytes(),
        )
        .unwrap();
        assert_eq!(
            encode_hex(&keyring.vault_key),
            vector.expected_vault_key_hex
        );
        assert_eq!(
            encode_hex(&keyring.record_subkey),
            vector.expected_record_subkey_hex
        );
        assert_eq!(
            encode_hex(&keyring.attachment_subkey),
            vector.expected_attachment_subkey_hex
        );
        assert_eq!(
            encode_hex(&keyring.metadata_subkey),
            vector.expected_metadata_subkey_hex
        );
        assert_eq!(
            encode_hex(&keyring.history_subkey),
            vector.expected_history_subkey_hex
        );
        assert_eq!(
            encode_hex(&keyring.integrity_subkey),
            vector.expected_integrity_subkey_hex
        );
    }
}

#[test]
fn aead_vectors_match() {
    for vector in load_vectors().aead_vectors {
        let key = decode_hex(&vector.key_hex);
        let nonce = decode_hex(&vector.nonce_hex);
        let plaintext = decode_hex(&vector.plaintext_hex);
        let ciphertext = decode_hex(&vector.ciphertext_hex);
        let cipher = XChaCha20Poly1305::new_from_slice(&key).unwrap();

        let decrypted = cipher
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: vector.aad_utf8.as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(decrypted, plaintext);

        let encrypted = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: vector.aad_utf8.as_bytes(),
                },
            )
            .unwrap();
        assert_eq!(encrypted, ciphertext);
    }
}
