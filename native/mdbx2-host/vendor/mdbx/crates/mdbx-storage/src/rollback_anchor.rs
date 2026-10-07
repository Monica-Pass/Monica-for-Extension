use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};

use crate::commit_integrity::{compute_commit_integrity_tag, CommitIntegrityInput};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::vault_header_integrity::{self, VaultHeaderIntegrityStatus};

const ROLLBACK_ANCHOR_MAGIC: &[u8; 8] = b"MDBXRA1\0";
const ROLLBACK_ANCHOR_DOMAIN: &[u8] = b"mdbx-external-rollback-anchor-v1";
const ROLLBACK_ANCHOR_VERSION: u8 = 1;
const FLAG_DELTA_ANCHOR: u8 = 1;
const HMAC_TAG_LEN: usize = 32;
const MAX_ID_BYTES: usize = 128;
const MAX_COMMIT_TAG_BYTES: usize = 64;
pub const MAX_ROLLBACK_ANCHOR_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RollbackAnchorVerification {
    pub advanced: bool,
    pub anchored_commit_inventory_seq: u64,
    pub current_commit_inventory_seq: u64,
    pub anchored_sync_delta_batch_seq: Option<u64>,
    pub current_sync_delta_batch_seq: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommitAnchor {
    sequence: u64,
    commit_id: String,
    integrity_tag: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DeltaAnchor {
    sequence: u64,
    batch_id: String,
    payload_sha256: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AnchorPayload {
    vault_id: String,
    schema_version: u32,
    commit: CommitAnchor,
    delta: Option<DeltaAnchor>,
}

struct CommitIntegrityRecord {
    device_id: String,
    local_seq: i64,
    commit_kind: String,
    change_scope: String,
    changed_object_ids_ct: Vec<u8>,
    vector_clock: String,
    message_ct: Option<Vec<u8>>,
    created_at: String,
}

pub struct RollbackAnchorService;

impl RollbackAnchorService {
    /// Issues an opaque token for storage outside the vault file.
    pub fn issue(conn: &VaultConnection) -> StorageResult<Vec<u8>> {
        ensure_verified_unlocked(conn)?;
        let (vault_id, schema_version) = vault_identity(conn)?;
        let payload = AnchorPayload {
            vault_id,
            schema_version,
            commit: latest_commit_anchor(conn)?.ok_or_else(|| {
                StorageError::Validation(
                    "cannot issue a rollback anchor without a commit inventory head".to_string(),
                )
            })?,
            delta: latest_delta_anchor(conn)?,
        };
        let encoded_payload = encode_payload(&payload)?;
        let keyring = conn.keyring().expect("verified unlock requires keyring");
        let tag = mdbx_crypto::integrity::hmac_sha256(
            &keyring.integrity_subkey,
            &[ROLLBACK_ANCHOR_DOMAIN, &encoded_payload],
        )
        .map_err(StorageError::Crypto)?;
        let mut token = encoded_payload;
        token.extend_from_slice(&tag);
        if token.len() > MAX_ROLLBACK_ANCHOR_BYTES {
            return Err(StorageError::Validation(format!(
                "rollback anchor exceeds {MAX_ROLLBACK_ANCHOR_BYTES} bytes"
            )));
        }
        Ok(token)
    }

    /// Verifies that the current vault is equal to or ahead of an external token.
    pub fn verify(
        conn: &VaultConnection,
        token: &[u8],
    ) -> StorageResult<RollbackAnchorVerification> {
        ensure_verified_unlocked(conn)?;
        if token.len() > MAX_ROLLBACK_ANCHOR_BYTES {
            return Err(StorageError::Validation(format!(
                "rollback anchor exceeds {MAX_ROLLBACK_ANCHOR_BYTES} bytes"
            )));
        }
        if token.len() <= HMAC_TAG_LEN {
            return Err(StorageError::Validation(
                "rollback anchor is truncated".to_string(),
            ));
        }
        let payload_end = token.len() - HMAC_TAG_LEN;
        let (encoded_payload, expected_tag) = token.split_at(payload_end);
        let keyring = conn.keyring().expect("verified unlock requires keyring");
        mdbx_crypto::integrity::verify_hmac_sha256(
            &keyring.integrity_subkey,
            &[ROLLBACK_ANCHOR_DOMAIN, encoded_payload],
            expected_tag,
        )
        .map_err(|_| {
            StorageError::Validation("rollback anchor authentication failed".to_string())
        })?;

        let payload = decode_payload(encoded_payload)?;
        let (vault_id, schema_version) = vault_identity(conn)?;
        if payload.vault_id != vault_id {
            return Err(StorageError::Validation(
                "rollback anchor belongs to another vault".to_string(),
            ));
        }
        if schema_version < payload.schema_version {
            return Err(StorageError::Validation(format!(
                "vault schema {schema_version} is behind anchored schema {}",
                payload.schema_version
            )));
        }

        verify_commit_anchor(conn, &payload.commit)?;
        let current_commit = latest_commit_anchor(conn)?.ok_or_else(|| {
            StorageError::Validation("vault commit inventory head is missing".to_string())
        })?;
        if current_commit.sequence < payload.commit.sequence {
            return Err(rollback_error("commit inventory"));
        }

        let current_delta = latest_delta_anchor(conn)?;
        if let Some(anchor) = payload.delta.as_ref() {
            verify_delta_anchor(conn, anchor)?;
            if current_delta.as_ref().map(|value| value.sequence) < Some(anchor.sequence) {
                return Err(rollback_error("sync delta inventory"));
            }
        }

        let anchored_delta_seq = payload.delta.as_ref().map(|value| value.sequence);
        let current_delta_seq = current_delta.as_ref().map(|value| value.sequence);
        Ok(RollbackAnchorVerification {
            advanced: current_commit.sequence > payload.commit.sequence
                || current_delta_seq > anchored_delta_seq,
            anchored_commit_inventory_seq: payload.commit.sequence,
            current_commit_inventory_seq: current_commit.sequence,
            anchored_sync_delta_batch_seq: anchored_delta_seq,
            current_sync_delta_batch_seq: current_delta_seq,
        })
    }
}

fn ensure_verified_unlocked(conn: &VaultConnection) -> StorageResult<()> {
    match vault_header_integrity::check(conn)? {
        VaultHeaderIntegrityStatus::Verified => Ok(()),
        VaultHeaderIntegrityStatus::Pending => Err(StorageError::Validation(
            "rollback anchors require a sealed vault header".to_string(),
        )),
        VaultHeaderIntegrityStatus::UnverifiedLocked => Err(StorageError::Validation(
            "rollback anchors require a verified-unlocked vault".to_string(),
        )),
    }
}

fn vault_identity(conn: &VaultConnection) -> StorageResult<(String, u32)> {
    let (vault_id, schema_version): (String, i64) = conn.inner().query_row(
        "SELECT vault_id, schema_version FROM vault_meta LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let schema_version = u32::try_from(schema_version).map_err(|_| {
        StorageError::Validation("vault schema version is outside the supported range".to_string())
    })?;
    validate_id(&vault_id, "vault ID")?;
    Ok((vault_id, schema_version))
}

fn latest_commit_anchor(conn: &VaultConnection) -> StorageResult<Option<CommitAnchor>> {
    conn.inner()
        .query_row(
            "SELECT i.inventory_seq, i.commit_id, c.integrity_tag
             FROM commit_inventory i
             JOIN commits c ON c.commit_id = i.commit_id
             ORDER BY i.inventory_seq DESC LIMIT 1",
            [],
            |row| {
                let sequence = row.get::<_, i64>(0)?;
                Ok((
                    sequence,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?
        .map(|(sequence, commit_id, integrity_tag)| {
            let sequence = u64::try_from(sequence).map_err(|_| {
                StorageError::Validation(
                    "commit inventory sequence is outside the supported range".to_string(),
                )
            })?;
            validate_id(&commit_id, "commit ID")?;
            validate_commit_tag(&integrity_tag)?;
            Ok(CommitAnchor {
                sequence,
                commit_id,
                integrity_tag,
            })
        })
        .transpose()
}

fn latest_delta_anchor(conn: &VaultConnection) -> StorageResult<Option<DeltaAnchor>> {
    conn.inner()
        .query_row(
            "SELECT batch_seq, batch_id, payload_sha256
             FROM sync_delta_batches ORDER BY batch_seq DESC LIMIT 1",
            [],
            |row| {
                let sequence = row.get::<_, i64>(0)?;
                Ok((
                    sequence,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?
        .map(|(sequence, batch_id, payload_sha256)| {
            let sequence = u64::try_from(sequence).map_err(|_| {
                StorageError::Validation(
                    "sync delta sequence is outside the supported range".to_string(),
                )
            })?;
            validate_id(&batch_id, "sync delta batch ID")?;
            let payload_sha256: [u8; 32] = payload_sha256.try_into().map_err(|_| {
                StorageError::Validation(
                    "sync delta payload hash must be exactly 32 bytes".to_string(),
                )
            })?;
            Ok(DeltaAnchor {
                sequence,
                batch_id,
                payload_sha256,
            })
        })
        .transpose()
}

fn verify_commit_anchor(conn: &VaultConnection, anchor: &CommitAnchor) -> StorageResult<()> {
    let sequence = sqlite_sequence(anchor.sequence, "commit inventory")?;
    let matches: bool = conn.inner().query_row(
        "SELECT EXISTS(
             SELECT 1 FROM commit_inventory i
             JOIN commits c ON c.commit_id = i.commit_id
             WHERE i.inventory_seq = ?1 AND i.commit_id = ?2 AND c.integrity_tag = ?3
         )",
        rusqlite::params![sequence, anchor.commit_id, anchor.integrity_tag],
        |row| row.get(0),
    )?;
    if matches {
        let commit = conn.inner().query_row(
            "SELECT device_id, local_seq, commit_kind, change_scope,
                        changed_object_ids_ct, vector_clock, message_ct, created_at
                 FROM commits WHERE commit_id = ?1",
            [anchor.commit_id.as_str()],
            |row| {
                Ok(CommitIntegrityRecord {
                    device_id: row.get(0)?,
                    local_seq: row.get(1)?,
                    commit_kind: row.get(2)?,
                    change_scope: row.get(3)?,
                    changed_object_ids_ct: row.get(4)?,
                    vector_clock: row.get(5)?,
                    message_ct: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )?;
        let local_seq = u64::try_from(commit.local_seq).map_err(|_| {
            StorageError::Validation("anchored commit local sequence is negative".to_string())
        })?;
        let mut parents_statement = conn
            .inner()
            .prepare("SELECT parent_commit_id FROM commit_parents WHERE commit_id = ?1")?;
        let parents = parents_statement
            .query_map([anchor.commit_id.as_str()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let input = CommitIntegrityInput {
            commit_id: &anchor.commit_id,
            device_id: &commit.device_id,
            local_seq,
            commit_kind: &commit.commit_kind,
            change_scope: &commit.change_scope,
            changed_object_ids_ct: &commit.changed_object_ids_ct,
            vector_clock: &commit.vector_clock,
            message_ct: commit.message_ct.as_deref(),
            created_at: &commit.created_at,
            parents: &parents,
        };
        let expected = compute_commit_integrity_tag(conn.keyring(), &input)?;
        if expected == anchor.integrity_tag {
            return Ok(());
        }
        if conn.keyring().is_some()
            && serde_json::from_slice::<serde_json::Value>(&commit.changed_object_ids_ct).is_ok()
            && compute_commit_integrity_tag(None, &input)? == anchor.integrity_tag
        {
            return Ok(());
        }
        Err(rollback_error("commit integrity"))
    } else {
        Err(rollback_error("commit inventory anchor"))
    }
}

fn verify_delta_anchor(conn: &VaultConnection, anchor: &DeltaAnchor) -> StorageResult<()> {
    let sequence = sqlite_sequence(anchor.sequence, "sync delta inventory")?;
    let (payload, payload_sha256): (Vec<u8>, Vec<u8>) = conn
        .inner()
        .query_row(
            "SELECT payload, payload_sha256 FROM sync_delta_batches
         WHERE batch_seq = ?1 AND batch_id = ?2",
            rusqlite::params![sequence, anchor.batch_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| rollback_error("sync delta inventory anchor"))?;
    if payload_sha256 == anchor.payload_sha256
        && Sha256::digest(&payload).as_slice() == anchor.payload_sha256.as_slice()
    {
        Ok(())
    } else {
        Err(rollback_error("sync delta integrity"))
    }
}

fn rollback_error(scope: &str) -> StorageError {
    StorageError::Validation(format!(
        "rollback detected: {scope} is behind or does not match the external anchor"
    ))
}

fn sqlite_sequence(value: u64, label: &str) -> StorageResult<i64> {
    i64::try_from(value)
        .map_err(|_| StorageError::Validation(format!("{label} sequence is too large")))
}

fn encode_payload(payload: &AnchorPayload) -> StorageResult<Vec<u8>> {
    let mut output = Vec::with_capacity(384);
    output.extend_from_slice(ROLLBACK_ANCHOR_MAGIC);
    output.push(ROLLBACK_ANCHOR_VERSION);
    output.push(if payload.delta.is_some() {
        FLAG_DELTA_ANCHOR
    } else {
        0
    });
    output.extend_from_slice(&payload.schema_version.to_le_bytes());
    write_string(&mut output, &payload.vault_id, "vault ID")?;
    output.extend_from_slice(&payload.commit.sequence.to_le_bytes());
    write_string(&mut output, &payload.commit.commit_id, "commit ID")?;
    write_bytes(
        &mut output,
        &payload.commit.integrity_tag,
        MAX_COMMIT_TAG_BYTES,
        "commit integrity tag",
    )?;
    if let Some(delta) = payload.delta.as_ref() {
        output.extend_from_slice(&delta.sequence.to_le_bytes());
        write_string(&mut output, &delta.batch_id, "sync delta batch ID")?;
        output.extend_from_slice(&delta.payload_sha256);
    }
    Ok(output)
}

fn decode_payload(bytes: &[u8]) -> StorageResult<AnchorPayload> {
    let mut reader = TokenReader::new(bytes);
    if reader.read_array::<8>("magic")? != *ROLLBACK_ANCHOR_MAGIC {
        return Err(StorageError::Validation(
            "rollback anchor magic is invalid".to_string(),
        ));
    }
    let version = reader.read_u8("version")?;
    if version != ROLLBACK_ANCHOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported rollback anchor version {version}"
        )));
    }
    let flags = reader.read_u8("flags")?;
    if flags & !FLAG_DELTA_ANCHOR != 0 {
        return Err(StorageError::Validation(
            "rollback anchor has unknown flags".to_string(),
        ));
    }
    let schema_version = u32::from_le_bytes(reader.read_array("schema version")?);
    let vault_id = reader.read_string(MAX_ID_BYTES, "vault ID")?;
    let commit = CommitAnchor {
        sequence: u64::from_le_bytes(reader.read_array("commit sequence")?),
        commit_id: reader.read_string(MAX_ID_BYTES, "commit ID")?,
        integrity_tag: reader.read_bytes(MAX_COMMIT_TAG_BYTES, "commit integrity tag")?,
    };
    validate_commit_tag(&commit.integrity_tag)?;
    let delta = if flags & FLAG_DELTA_ANCHOR != 0 {
        Some(DeltaAnchor {
            sequence: u64::from_le_bytes(reader.read_array("sync delta sequence")?),
            batch_id: reader.read_string(MAX_ID_BYTES, "sync delta batch ID")?,
            payload_sha256: reader.read_array("sync delta payload hash")?,
        })
    } else {
        None
    };
    if !reader.is_finished() {
        return Err(StorageError::Validation(
            "rollback anchor payload has trailing data".to_string(),
        ));
    }
    Ok(AnchorPayload {
        vault_id,
        schema_version,
        commit,
        delta,
    })
}

fn write_string(output: &mut Vec<u8>, value: &str, label: &str) -> StorageResult<()> {
    validate_id(value, label)?;
    write_bytes(output, value.as_bytes(), MAX_ID_BYTES, label)
}

fn write_bytes(
    output: &mut Vec<u8>,
    value: &[u8],
    maximum: usize,
    label: &str,
) -> StorageResult<()> {
    if value.is_empty() || value.len() > maximum || value.len() > usize::from(u16::MAX) {
        return Err(StorageError::Validation(format!(
            "rollback anchor {label} length is invalid"
        )));
    }
    output.extend_from_slice(&(value.len() as u16).to_le_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn validate_id(value: &str, label: &str) -> StorageResult<()> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(StorageError::Validation(format!(
            "rollback anchor {label} must contain 1 to {MAX_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_commit_tag(value: &[u8]) -> StorageResult<()> {
    if value.is_empty() || value.len() > MAX_COMMIT_TAG_BYTES {
        return Err(StorageError::Validation(format!(
            "rollback anchor commit tag must contain 1 to {MAX_COMMIT_TAG_BYTES} bytes"
        )));
    }
    Ok(())
}

struct TokenReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> TokenReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_u8(&mut self, label: &str) -> StorageResult<u8> {
        Ok(self.read_slice(1, label)?[0])
    }

    fn read_array<const N: usize>(&mut self, label: &str) -> StorageResult<[u8; N]> {
        self.read_slice(N, label)?
            .try_into()
            .map_err(|_| StorageError::Validation(format!("rollback anchor {label} is truncated")))
    }

    fn read_string(&mut self, maximum: usize, label: &str) -> StorageResult<String> {
        let bytes = self.read_bytes(maximum, label)?;
        String::from_utf8(bytes)
            .map_err(|_| StorageError::Validation(format!("rollback anchor {label} is not UTF-8")))
    }

    fn read_bytes(&mut self, maximum: usize, label: &str) -> StorageResult<Vec<u8>> {
        let length = usize::from(u16::from_le_bytes(self.read_array("length")?));
        if length == 0 || length > maximum {
            return Err(StorageError::Validation(format!(
                "rollback anchor {label} length is invalid"
            )));
        }
        Ok(self.read_slice(length, label)?.to_vec())
    }

    fn read_slice(&mut self, length: usize, label: &str) -> StorageResult<&'a [u8]> {
        let end = self.offset.checked_add(length).ok_or_else(|| {
            StorageError::Validation(format!("rollback anchor {label} length overflow"))
        })?;
        let value = self.bytes.get(self.offset..end).ok_or_else(|| {
            StorageError::Validation(format!("rollback anchor {label} is truncated"))
        })?;
        self.offset = end;
        Ok(value)
    }

    fn is_finished(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::BackupService;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ProjectRepo};
    use crate::unlock::UnlockService;

    const PASSWORD: &str = "rollback-anchor-password";

    fn setup(path: &std::path::Path) -> VaultConnection {
        let mut conn = VaultConnection::create(path).unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, PASSWORD).unwrap();
        conn
    }

    #[test]
    fn equal_and_advanced_vaults_verify() {
        let path = std::env::temp_dir().join(format!(
            "mdbx-rollback-anchor-equal-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let conn = setup(&path);
        let token = RollbackAnchorService::issue(&conn).unwrap();
        let equal = RollbackAnchorService::verify(&conn, &token).unwrap();
        assert!(!equal.advanced);

        ProjectRepo::create(
            &conn,
            &CommitContext::new("anchor-device".to_string()),
            "After anchor",
            None,
            None,
        )
        .unwrap();
        let advanced = RollbackAnchorService::verify(&conn, &token).unwrap();
        assert!(advanced.advanced);
        assert!(advanced.current_commit_inventory_seq > advanced.anchored_commit_inventory_seq);
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn newer_anchor_rejects_a_rolled_back_copy() {
        let source_path = std::env::temp_dir().join(format!(
            "mdbx-rollback-anchor-source-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let old_path = std::env::temp_dir().join(format!(
            "mdbx-rollback-anchor-old-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let source = setup(&source_path);
        BackupService::create_portable_copy(&source, &old_path).unwrap();
        ProjectRepo::create(
            &source,
            &CommitContext::new("anchor-device".to_string()),
            "New state",
            None,
            None,
        )
        .unwrap();
        let newer_token = RollbackAnchorService::issue(&source).unwrap();

        let mut old = VaultConnection::open(&old_path).unwrap();
        UnlockService::unlock_with_password(&mut old, PASSWORD).unwrap();
        let error = RollbackAnchorService::verify(&old, &newer_token).unwrap_err();
        assert!(error.to_string().contains("rollback detected"));

        drop(old);
        drop(source);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(old_path);
    }

    #[test]
    fn malformed_tampered_and_foreign_tokens_fail_closed() {
        let first_path = std::env::temp_dir().join(format!(
            "mdbx-rollback-anchor-first-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let second_path = std::env::temp_dir().join(format!(
            "mdbx-rollback-anchor-second-{}.mdbx",
            uuid::Uuid::new_v4()
        ));
        let first = setup(&first_path);
        let second = setup(&second_path);
        let token = RollbackAnchorService::issue(&first).unwrap();

        let mut tampered = token.clone();
        tampered[12] ^= 1;
        assert!(RollbackAnchorService::verify(&first, &tampered).is_err());
        assert!(RollbackAnchorService::verify(&first, &token[..20]).is_err());
        assert!(
            RollbackAnchorService::verify(&first, &vec![0_u8; MAX_ROLLBACK_ANCHOR_BYTES + 1])
                .is_err()
        );
        assert!(RollbackAnchorService::verify(&second, &token).is_err());

        drop(first);
        drop(second);
        let _ = std::fs::remove_file(first_path);
        let _ = std::fs::remove_file(second_path);
    }
}
