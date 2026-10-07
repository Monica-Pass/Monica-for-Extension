use rusqlite::types::ValueRef;
use sha2::{Digest, Sha256};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::vault_header_integrity::{self, VaultHeaderIntegrityStatus};

const MANIFEST_MAGIC: &[u8; 8] = b"MDBXVM1\0";
const MANIFEST_DOMAIN_V1: &[u8] = b"mdbx-vault-content-manifest-v1";
const MANIFEST_DOMAIN_V2: &[u8] = b"mdbx-vault-content-manifest-v2";
const MANIFEST_VERSION_V1: u8 = 1;
const MANIFEST_VERSION_V2: u8 = 2;
const HMAC_TAG_LEN: usize = 32;
const ROOT_LEN: usize = 32;
const MAX_ID_BYTES: usize = 128;
const MAX_SCHEMA_TEXT_BYTES: usize = 4_096;
const MAX_SCHEMA_OBJECTS: usize = 4_096;
const MAX_TABLES: usize = 1_024;
const MAX_COLUMNS_PER_TABLE: usize = 512;
const MAX_ROWS: u64 = 10_000_000;
const MAX_CELL_BYTES: usize = 256 * 1024 * 1024;
const MAX_SCHEMA_SQL_BYTES: usize = 1024 * 1024;

pub const MAX_VAULT_CONTENT_MANIFEST_BYTES: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultContentManifestVerification {
    pub table_count: u64,
    pub row_count: u64,
    pub hashed_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestProfile {
    V1,
    V2,
}

impl ManifestProfile {
    fn current() -> Self {
        Self::V2
    }

    fn version(self) -> u8 {
        match self {
            Self::V1 => MANIFEST_VERSION_V1,
            Self::V2 => MANIFEST_VERSION_V2,
        }
    }

    fn domain(self) -> &'static [u8] {
        match self {
            Self::V1 => MANIFEST_DOMAIN_V1,
            Self::V2 => MANIFEST_DOMAIN_V2,
        }
    }

    fn from_version(version: u8) -> StorageResult<Self> {
        match version {
            MANIFEST_VERSION_V1 => Ok(Self::V1),
            MANIFEST_VERSION_V2 => Ok(Self::V2),
            _ => Err(StorageError::Validation(format!(
                "unsupported vault content manifest version {version}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestPayload {
    vault_id: String,
    schema_version: u32,
    table_count: u64,
    row_count: u64,
    hashed_bytes: u64,
    root: [u8; ROOT_LEN],
}

#[derive(Debug, Clone)]
struct SchemaObject {
    object_type: String,
    name: String,
    table_name: String,
    sql: Option<String>,
}

#[derive(Debug, Clone)]
struct TableColumn {
    cid: i64,
    name: String,
    declared_type: String,
    not_null: i64,
    default_value: Option<String>,
    primary_key_order: i64,
    hidden_kind: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestSnapshot {
    table_count: u64,
    row_count: u64,
    hashed_bytes: u64,
    root: [u8; ROOT_LEN],
}

pub struct VaultContentManifestService;

impl VaultContentManifestService {
    /// Issues an opaque exact-state checkpoint for storage outside the vault.
    ///
    /// This is deliberately an explicit O(vault-size) operation. Routine
    /// mutations remain incremental and do not recompute the whole vault.
    pub fn issue(conn: &VaultConnection) -> StorageResult<Vec<u8>> {
        issue_with_profile(conn, ManifestProfile::current())
    }

    /// Verifies an exact-state checkpoint against the currently opened vault.
    pub fn verify(
        conn: &VaultConnection,
        token: &[u8],
    ) -> StorageResult<VaultContentManifestVerification> {
        if token.len() > MAX_VAULT_CONTENT_MANIFEST_BYTES {
            return Err(StorageError::Validation(format!(
                "vault content manifest exceeds {MAX_VAULT_CONTENT_MANIFEST_BYTES} bytes"
            )));
        }
        if token.len() <= HMAC_TAG_LEN {
            return Err(StorageError::Validation(
                "vault content manifest is truncated".to_string(),
            ));
        }
        let payload_end = token.len() - HMAC_TAG_LEN;
        let (encoded_payload, expected_tag) = token.split_at(payload_end);
        let profile = peek_profile(encoded_payload)?;

        conn.with_read_transaction(|| {
            ensure_verified_unlocked(conn)?;
            let keyring = conn.keyring().expect("verified unlock requires keyring");
            mdbx_crypto::integrity::verify_hmac_sha256(
                &keyring.integrity_subkey,
                &[profile.domain(), encoded_payload],
                expected_tag,
            )
            .map_err(|_| {
                StorageError::Validation("vault content manifest authentication failed".to_string())
            })?;

            let (decoded_profile, payload) = decode_payload(encoded_payload)?;
            if decoded_profile != profile {
                return Err(StorageError::Validation(
                    "vault content manifest profile mismatch".to_string(),
                ));
            }
            let (vault_id, schema_version) = vault_identity(conn)?;
            if payload.vault_id != vault_id {
                return Err(StorageError::Validation(
                    "vault content manifest belongs to another vault".to_string(),
                ));
            }
            if payload.schema_version != schema_version {
                return Err(StorageError::Validation(format!(
                    "vault schema {schema_version} does not match manifest schema {}",
                    payload.schema_version
                )));
            }

            let snapshot = compute_snapshot(conn, profile)?;
            if snapshot.table_count != payload.table_count
                || snapshot.row_count != payload.row_count
                || snapshot.hashed_bytes != payload.hashed_bytes
                || snapshot.root != payload.root
            {
                return Err(StorageError::Validation(
                    "vault content manifest does not match the current vault".to_string(),
                ));
            }
            Ok(VaultContentManifestVerification {
                table_count: snapshot.table_count,
                row_count: snapshot.row_count,
                hashed_bytes: snapshot.hashed_bytes,
            })
        })
    }
}

fn issue_with_profile(conn: &VaultConnection, profile: ManifestProfile) -> StorageResult<Vec<u8>> {
    conn.with_read_transaction(|| {
        ensure_verified_unlocked(conn)?;
        let (vault_id, schema_version) = vault_identity(conn)?;
        let snapshot = compute_snapshot(conn, profile)?;
        let payload = ManifestPayload {
            vault_id,
            schema_version,
            table_count: snapshot.table_count,
            row_count: snapshot.row_count,
            hashed_bytes: snapshot.hashed_bytes,
            root: snapshot.root,
        };
        encode_token(conn, profile, &payload)
    })
}

fn ensure_verified_unlocked(conn: &VaultConnection) -> StorageResult<()> {
    match vault_header_integrity::check(conn)? {
        VaultHeaderIntegrityStatus::Verified => Ok(()),
        VaultHeaderIntegrityStatus::Pending => Err(StorageError::Validation(
            "vault content manifests require a sealed vault header".to_string(),
        )),
        VaultHeaderIntegrityStatus::UnverifiedLocked => Err(StorageError::Validation(
            "vault content manifests require a verified-unlocked vault".to_string(),
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
    validate_text(&vault_id, MAX_ID_BYTES, "vault ID")?;
    Ok((vault_id, schema_version))
}

fn encode_token(
    conn: &VaultConnection,
    profile: ManifestProfile,
    payload: &ManifestPayload,
) -> StorageResult<Vec<u8>> {
    let mut encoded = Vec::with_capacity(128);
    encoded.extend_from_slice(MANIFEST_MAGIC);
    encoded.push(profile.version());
    encoded.extend_from_slice(&payload.schema_version.to_le_bytes());
    write_text(&mut encoded, &payload.vault_id, MAX_ID_BYTES, "vault ID")?;
    encoded.extend_from_slice(&payload.table_count.to_le_bytes());
    encoded.extend_from_slice(&payload.row_count.to_le_bytes());
    encoded.extend_from_slice(&payload.hashed_bytes.to_le_bytes());
    encoded.extend_from_slice(&payload.root);

    let keyring = conn.keyring().expect("verified unlock requires keyring");
    let tag = mdbx_crypto::integrity::hmac_sha256(
        &keyring.integrity_subkey,
        &[profile.domain(), &encoded],
    )
    .map_err(StorageError::Crypto)?;
    encoded.extend_from_slice(&tag);
    if encoded.len() > MAX_VAULT_CONTENT_MANIFEST_BYTES {
        return Err(StorageError::Validation(format!(
            "vault content manifest exceeds {MAX_VAULT_CONTENT_MANIFEST_BYTES} bytes"
        )));
    }
    Ok(encoded)
}

fn peek_profile(bytes: &[u8]) -> StorageResult<ManifestProfile> {
    let mut reader = ManifestReader::new(bytes);
    if reader.read_array::<8>("magic")? != *MANIFEST_MAGIC {
        return Err(StorageError::Validation(
            "vault content manifest magic is invalid".to_string(),
        ));
    }
    ManifestProfile::from_version(reader.read_u8("version")?)
}

fn decode_payload(bytes: &[u8]) -> StorageResult<(ManifestProfile, ManifestPayload)> {
    let mut reader = ManifestReader::new(bytes);
    if reader.read_array::<8>("magic")? != *MANIFEST_MAGIC {
        return Err(StorageError::Validation(
            "vault content manifest magic is invalid".to_string(),
        ));
    }
    let profile = ManifestProfile::from_version(reader.read_u8("version")?)?;
    let schema_version = u32::from_le_bytes(reader.read_array("schema version")?);
    let vault_id = reader.read_text(MAX_ID_BYTES, "vault ID")?;
    let table_count = u64::from_le_bytes(reader.read_array("table count")?);
    let row_count = u64::from_le_bytes(reader.read_array("row count")?);
    let hashed_bytes = u64::from_le_bytes(reader.read_array("hashed bytes")?);
    let root = reader.read_array("root")?;
    if !reader.is_finished() {
        return Err(StorageError::Validation(
            "vault content manifest has trailing data".to_string(),
        ));
    }
    Ok((
        profile,
        ManifestPayload {
            vault_id,
            schema_version,
            table_count,
            row_count,
            hashed_bytes,
            root,
        },
    ))
}

fn compute_snapshot(
    conn: &VaultConnection,
    profile: ManifestProfile,
) -> StorageResult<ManifestSnapshot> {
    let objects = load_schema_objects(conn)?;
    let tables = objects
        .iter()
        .filter(|object| object.object_type == "table")
        .collect::<Vec<_>>();
    if tables.len() > MAX_TABLES {
        return Err(StorageError::Validation(format!(
            "vault content manifest exceeds {MAX_TABLES} tables"
        )));
    }

    let mut hasher = Sha256::new();
    let mut hashed_bytes = 0_u64;
    hash_bytes(
        &mut hasher,
        &mut hashed_bytes,
        0x01,
        profile.domain(),
        MAX_SCHEMA_SQL_BYTES,
        "manifest domain",
    )?;
    for object in &objects {
        hash_text(&mut hasher, &mut hashed_bytes, 0x02, &object.object_type)?;
        hash_text(&mut hasher, &mut hashed_bytes, 0x03, &object.name)?;
        hash_text(&mut hasher, &mut hashed_bytes, 0x04, &object.table_name)?;
        match object.sql.as_deref() {
            Some(sql) => hash_text_bounded(
                &mut hasher,
                &mut hashed_bytes,
                0x05,
                sql,
                MAX_SCHEMA_SQL_BYTES,
                "schema SQL",
            )?,
            None => hash_bytes(
                &mut hasher,
                &mut hashed_bytes,
                0x06,
                &[],
                0,
                "missing schema SQL",
            )?,
        }
    }

    let mut row_count = 0_u64;
    for table in &tables {
        hash_text(&mut hasher, &mut hashed_bytes, 0x10, &table.name)?;
        let columns = load_columns(conn, &table.name, profile)?;
        if columns.is_empty() || columns.len() > MAX_COLUMNS_PER_TABLE {
            return Err(StorageError::Validation(format!(
                "table {} has an unsupported column count",
                table.name
            )));
        }
        hash_u64(&mut hasher, &mut hashed_bytes, 0x11, columns.len() as u64);
        for column in &columns {
            hash_i64(&mut hasher, &mut hashed_bytes, 0x12, column.cid);
            hash_text(&mut hasher, &mut hashed_bytes, 0x13, &column.name)?;
            hash_text(&mut hasher, &mut hashed_bytes, 0x14, &column.declared_type)?;
            hash_i64(&mut hasher, &mut hashed_bytes, 0x15, column.not_null);
            match column.default_value.as_deref() {
                Some(value) => hash_text_bounded(
                    &mut hasher,
                    &mut hashed_bytes,
                    0x16,
                    value,
                    MAX_SCHEMA_SQL_BYTES,
                    "column default",
                )?,
                None => hash_bytes(
                    &mut hasher,
                    &mut hashed_bytes,
                    0x17,
                    &[],
                    0,
                    "missing column default",
                )?,
            }
            hash_i64(
                &mut hasher,
                &mut hashed_bytes,
                0x18,
                column.primary_key_order,
            );
            if profile == ManifestProfile::V2 {
                hash_i64(&mut hasher, &mut hashed_bytes, 0x19, column.hidden_kind);
            }
        }

        let quoted_table = quote_identifier(&table.name);
        let selected_columns = columns
            .iter()
            .map(|column| quote_identifier(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
        let order_clause = build_order_clause(conn, &table.name, &columns, profile);
        let query =
            format!("SELECT {selected_columns} FROM {quoted_table} ORDER BY {order_clause}");
        let mut statement = conn.inner().prepare(&query)?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            row_count = row_count.checked_add(1).ok_or_else(|| {
                StorageError::Validation("vault content manifest row count overflow".to_string())
            })?;
            if row_count > MAX_ROWS {
                return Err(StorageError::Validation(format!(
                    "vault content manifest exceeds {MAX_ROWS} rows"
                )));
            }
            hash_u64(&mut hasher, &mut hashed_bytes, 0x20, row_count);
            for index in 0..columns.len() {
                hash_value(&mut hasher, &mut hashed_bytes, row.get_ref(index)?)?;
            }
        }
    }

    Ok(ManifestSnapshot {
        table_count: tables.len() as u64,
        row_count,
        hashed_bytes,
        root: hasher.finalize().into(),
    })
}

fn load_schema_objects(conn: &VaultConnection) -> StorageResult<Vec<SchemaObject>> {
    let mut statement = conn.inner().prepare(
        "SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%'
           AND type IN ('table', 'index', 'trigger', 'view')
         ORDER BY type, name, tbl_name",
    )?;
    let objects = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                object_type: row.get(0)?,
                name: row.get(1)?,
                table_name: row.get(2)?,
                sql: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if objects.len() > MAX_SCHEMA_OBJECTS {
        return Err(StorageError::Validation(format!(
            "vault content manifest exceeds {MAX_SCHEMA_OBJECTS} schema objects"
        )));
    }
    Ok(objects)
}

fn load_columns(
    conn: &VaultConnection,
    table: &str,
    profile: ManifestProfile,
) -> StorageResult<Vec<TableColumn>> {
    let pragma = match profile {
        ManifestProfile::V1 => "table_info",
        ManifestProfile::V2 => "table_xinfo",
    };
    let query = format!("PRAGMA {pragma}({})", quote_identifier(table));
    let mut statement = conn.inner().prepare(&query)?;
    let mut columns = statement
        .query_map([], |row| {
            Ok(TableColumn {
                cid: row.get(0)?,
                name: row.get(1)?,
                declared_type: row.get(2)?,
                not_null: row.get(3)?,
                default_value: row.get(4)?,
                primary_key_order: row.get(5)?,
                hidden_kind: if profile == ManifestProfile::V2 {
                    row.get(6)?
                } else {
                    0
                },
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    columns.sort_by_key(|column| column.cid);
    Ok(columns)
}

fn build_order_clause(
    conn: &VaultConnection,
    table: &str,
    columns: &[TableColumn],
    profile: ManifestProfile,
) -> String {
    if profile == ManifestProfile::V1 {
        let primary_key = columns
            .iter()
            .filter(|column| column.primary_key_order > 0)
            .collect::<Vec<_>>();
        let ordered = if primary_key.is_empty() {
            columns.iter().collect::<Vec<_>>()
        } else {
            let mut ordered = primary_key;
            ordered.sort_by_key(|column| column.primary_key_order);
            ordered
        };
        return ordered
            .iter()
            .map(|column| quote_identifier(&column.name))
            .collect::<Vec<_>>()
            .join(", ");
    }

    let mut primary_key = columns
        .iter()
        .filter(|column| column.primary_key_order > 0)
        .collect::<Vec<_>>();
    primary_key.sort_by_key(|column| column.primary_key_order);

    let mut terms = primary_key
        .iter()
        .map(|column| quote_identifier(&column.name))
        .collect::<Vec<_>>();
    for column in columns {
        let identifier = quote_identifier(&column.name);
        terms.push(format!("typeof({identifier}) COLLATE BINARY"));
        terms.push(format!("{identifier} COLLATE BINARY"));
    }
    if let Some(alias) = accessible_rowid_alias(conn, table, columns) {
        terms.push(alias.to_string());
    }
    terms.join(", ")
}

fn accessible_rowid_alias(
    conn: &VaultConnection,
    table: &str,
    columns: &[TableColumn],
) -> Option<&'static str> {
    for alias in ["rowid", "_rowid_", "oid"] {
        if columns
            .iter()
            .any(|column| column.name.eq_ignore_ascii_case(alias))
        {
            continue;
        }
        let query = format!("SELECT {alias} FROM {} LIMIT 0", quote_identifier(table));
        if conn.inner().prepare(&query).is_ok() {
            return Some(alias);
        }
    }
    None
}

fn hash_value(
    hasher: &mut Sha256,
    hashed_bytes: &mut u64,
    value: ValueRef<'_>,
) -> StorageResult<()> {
    match value {
        ValueRef::Null => hash_bytes(hasher, hashed_bytes, 0x30, &[], 0, "NULL value"),
        ValueRef::Integer(value) => {
            hash_i64(hasher, hashed_bytes, 0x31, value);
            Ok(())
        }
        ValueRef::Real(value) => {
            hash_u64(hasher, hashed_bytes, 0x32, value.to_bits());
            Ok(())
        }
        ValueRef::Text(value) => hash_bytes(
            hasher,
            hashed_bytes,
            0x33,
            value,
            MAX_CELL_BYTES,
            "text value",
        ),
        ValueRef::Blob(value) => hash_bytes(
            hasher,
            hashed_bytes,
            0x34,
            value,
            MAX_CELL_BYTES,
            "blob value",
        ),
    }
}

fn hash_text(
    hasher: &mut Sha256,
    hashed_bytes: &mut u64,
    tag: u8,
    value: &str,
) -> StorageResult<()> {
    hash_text_bounded(
        hasher,
        hashed_bytes,
        tag,
        value,
        MAX_SCHEMA_TEXT_BYTES,
        "manifest text",
    )
}

fn hash_text_bounded(
    hasher: &mut Sha256,
    hashed_bytes: &mut u64,
    tag: u8,
    value: &str,
    maximum: usize,
    label: &str,
) -> StorageResult<()> {
    hash_bytes(hasher, hashed_bytes, tag, value.as_bytes(), maximum, label)
}

fn hash_i64(hasher: &mut Sha256, hashed_bytes: &mut u64, tag: u8, value: i64) {
    hash_framed(hasher, hashed_bytes, tag, &value.to_le_bytes());
}

fn hash_u64(hasher: &mut Sha256, hashed_bytes: &mut u64, tag: u8, value: u64) {
    hash_framed(hasher, hashed_bytes, tag, &value.to_le_bytes());
}

fn hash_bytes(
    hasher: &mut Sha256,
    hashed_bytes: &mut u64,
    tag: u8,
    value: &[u8],
    maximum: usize,
    label: &str,
) -> StorageResult<()> {
    if value.len() > maximum {
        return Err(StorageError::Validation(format!(
            "vault content manifest {label} exceeds {maximum} bytes"
        )));
    }
    hash_framed(hasher, hashed_bytes, tag, value);
    Ok(())
}

fn hash_framed(hasher: &mut Sha256, hashed_bytes: &mut u64, tag: u8, value: &[u8]) {
    hasher.update([tag]);
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
    *hashed_bytes = hashed_bytes.saturating_add(value.len() as u64);
}

fn write_text(output: &mut Vec<u8>, value: &str, maximum: usize, label: &str) -> StorageResult<()> {
    if value.is_empty() || value.len() > maximum || value.len() > usize::from(u16::MAX) {
        return Err(StorageError::Validation(format!(
            "vault content manifest {label} length is invalid"
        )));
    }
    output.extend_from_slice(&(value.len() as u16).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn validate_text(value: &str, maximum: usize, label: &str) -> StorageResult<()> {
    if value.is_empty() || value.len() > maximum {
        return Err(StorageError::Validation(format!(
            "vault content manifest {label} length is invalid"
        )));
    }
    Ok(())
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

struct ManifestReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ManifestReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_u8(&mut self, label: &str) -> StorageResult<u8> {
        Ok(self.read_slice(1, label)?[0])
    }

    fn read_array<const N: usize>(&mut self, label: &str) -> StorageResult<[u8; N]> {
        self.read_slice(N, label)?.try_into().map_err(|_| {
            StorageError::Validation(format!("vault content manifest {label} is truncated"))
        })
    }

    fn read_text(&mut self, maximum: usize, label: &str) -> StorageResult<String> {
        let length = usize::from(u16::from_le_bytes(self.read_array("text length")?));
        if length == 0 || length > maximum {
            return Err(StorageError::Validation(format!(
                "vault content manifest {label} length is invalid"
            )));
        }
        String::from_utf8(self.read_slice(length, label)?.to_vec()).map_err(|_| {
            StorageError::Validation(format!("vault content manifest {label} is not UTF-8"))
        })
    }

    fn read_slice(&mut self, length: usize, label: &str) -> StorageResult<&'a [u8]> {
        let end = self.offset.checked_add(length).ok_or_else(|| {
            StorageError::Validation(format!("vault content manifest {label} length overflow"))
        })?;
        let value = self.bytes.get(self.offset..end).ok_or_else(|| {
            StorageError::Validation(format!("vault content manifest {label} is truncated"))
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
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{CommitContext, ProjectRepo};
    use crate::unlock::UnlockService;

    const PASSWORD: &str = "content-manifest-password";

    fn setup() -> VaultConnection {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        UnlockService::setup_password(&mut conn, PASSWORD).unwrap();
        conn
    }

    #[test]
    fn exact_manifest_roundtrips_and_legitimate_changes_require_reissue() {
        let conn = setup();
        let token = VaultContentManifestService::issue(&conn).unwrap();
        assert_eq!(token[MANIFEST_MAGIC.len()], MANIFEST_VERSION_V2);
        let equal = VaultContentManifestService::verify(&conn, &token).unwrap();
        assert!(equal.table_count > 0);
        assert!(equal.row_count > 0);

        ProjectRepo::create(
            &conn,
            &CommitContext::new("manifest-device".to_string()),
            "After manifest",
            None,
            None,
        )
        .unwrap();
        assert!(VaultContentManifestService::verify(&conn, &token).is_err());
        let replacement = VaultContentManifestService::issue(&conn).unwrap();
        assert!(VaultContentManifestService::verify(&conn, &replacement).is_ok());
    }

    #[test]
    fn legacy_v1_tokens_remain_verifiable_after_v2_issue_becomes_current() {
        let conn = setup();
        let token = issue_with_profile(&conn, ManifestProfile::V1).unwrap();
        assert_eq!(token[MANIFEST_MAGIC.len()], MANIFEST_VERSION_V1);

        let verification = VaultContentManifestService::verify(&conn, &token).unwrap();
        assert!(verification.table_count > 0);
        assert!(verification.row_count > 0);

        let current = VaultContentManifestService::issue(&conn).unwrap();
        assert_eq!(current[MANIFEST_MAGIC.len()], MANIFEST_VERSION_V2);
    }

    #[test]
    fn v2_covers_generated_columns_and_canonicalizes_nullable_primary_keys() {
        let conn = setup();
        conn.inner()
            .execute_batch(
                "CREATE TABLE extension_generated_probe (
                     raw TEXT,
                     folded TEXT GENERATED ALWAYS AS (lower(raw)) STORED,
                     sized INTEGER GENERATED ALWAYS AS (length(raw)) VIRTUAL
                 );
                 INSERT INTO extension_generated_probe (raw) VALUES ('Alpha');
                 CREATE TABLE extension_nullable_pk (
                     key TEXT PRIMARY KEY,
                     payload TEXT COLLATE NOCASE
                 );
                 INSERT INTO extension_nullable_pk (key, payload)
                 VALUES (NULL, 'second'), (NULL, 'first');",
            )
            .unwrap();

        let legacy_columns =
            load_columns(&conn, "extension_generated_probe", ManifestProfile::V1).unwrap();
        assert_eq!(
            legacy_columns
                .iter()
                .map(|column| column.name.as_str())
                .collect::<Vec<_>>(),
            ["raw"]
        );
        let columns =
            load_columns(&conn, "extension_generated_probe", ManifestProfile::V2).unwrap();
        assert_eq!(
            columns
                .iter()
                .map(|column| (column.name.as_str(), column.hidden_kind))
                .collect::<Vec<_>>(),
            [("raw", 0), ("folded", 3), ("sized", 2)]
        );

        let before = conn
            .with_read_transaction(|| compute_snapshot(&conn, ManifestProfile::V2))
            .unwrap();
        conn.inner()
            .execute_batch(
                "DELETE FROM extension_nullable_pk;
                 INSERT INTO extension_nullable_pk (key, payload)
                 VALUES (NULL, 'first'), (NULL, 'second');",
            )
            .unwrap();
        let after = conn
            .with_read_transaction(|| compute_snapshot(&conn, ManifestProfile::V2))
            .unwrap();
        assert_eq!(after, before);
    }

    #[test]
    fn direct_row_schema_and_foreign_tampering_fail_closed() {
        let conn = setup();
        ProjectRepo::create(
            &conn,
            &CommitContext::new("manifest-device".to_string()),
            "Tamper target",
            None,
            None,
        )
        .unwrap();
        let token = VaultContentManifestService::issue(&conn).unwrap();
        let project_id: String = conn
            .inner()
            .query_row("SELECT project_id FROM projects LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE projects SET title_ct = X'01' WHERE project_id = ?1",
                [project_id],
            )
            .unwrap();
        assert!(VaultContentManifestService::verify(&conn, &token).is_err());

        let clean = setup();
        let clean_token = VaultContentManifestService::issue(&clean).unwrap();
        clean
            .inner()
            .execute(
                "CREATE TABLE extension_manifest_probe (id TEXT PRIMARY KEY, value BLOB)",
                [],
            )
            .unwrap();
        assert!(VaultContentManifestService::verify(&clean, &clean_token).is_err());
        assert!(VaultContentManifestService::verify(&conn, &clean_token).is_err());
    }

    #[test]
    fn malformed_and_oversized_tokens_fail_closed() {
        let conn = setup();
        let token = VaultContentManifestService::issue(&conn).unwrap();
        assert!(VaultContentManifestService::verify(&conn, &token[..20]).is_err());
        assert!(VaultContentManifestService::verify(
            &conn,
            &vec![0_u8; MAX_VAULT_CONTENT_MANIFEST_BYTES + 1]
        )
        .is_err());
        let mut tampered = token;
        tampered[10] ^= 1;
        assert!(VaultContentManifestService::verify(&conn, &tampered).is_err());
    }
}
