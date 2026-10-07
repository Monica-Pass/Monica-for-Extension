//! Optional, pure-Rust Steam mafile domain Adapter for MDBX2.
//
// The Adapter deliberately stops at a bounded, opaque JSON document. It does
// not contact Steam, decrypt tokens, write SQLite, or grant a storage/Tiga
// capability. Callers pass the resulting canonical bytes to the generic MDBX
// object interface and may remove this crate without changing the stored
// object type or payload.

use std::collections::BTreeSet;
use std::fmt;

use mdbx_core::model::{
    CollectionTypeId, ExtensionCapabilityId, ExtensionFeatureId, ExtensionId, ExtensionProfile,
    ObjectTypeId,
};
use serde::de::{self, DeserializeSeed, Error as DeError, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

pub const STEAM_EXTENSION_ID: &str = "com.monica.steam";
/// Collection contract used by Steam account/mafile adapters.
pub const STEAM_COLLECTION_TYPE_ID: &str = "com.monica.steam";
/// Opaque object contract for one Steam mafile document.
pub const STEAM_MAFILE_OBJECT_TYPE_ID: &str = "com.monica.steam.mafile";
/// Capability required for a user-visible Steam object mutation.
pub const STEAM_STORE_CAPABILITY_ID: &str = "com.monica.steam.store";
/// Optional import feature declared by this Adapter.
pub const STEAM_MAFILE_IMPORT_FEATURE_ID: &str = "com.monica.steam.import.mafile";
/// Optional export feature declared by this Adapter.
pub const STEAM_MAFILE_EXPORT_FEATURE_ID: &str = "com.monica.steam.export.mafile";
pub const STEAM_EXTENSION_PROFILE_VERSION: u32 = 1;

pub const DEFAULT_MAX_INPUT_BYTES: usize = 1024 * 1024;
pub const DEFAULT_MAX_DEPTH: usize = 32;
pub const DEFAULT_MAX_FIELDS: usize = 512;
pub const DEFAULT_MAX_ARRAY_ITEMS: usize = 512;
pub const DEFAULT_MAX_NODES: usize = 8 * 1024;
pub const DEFAULT_MAX_STRING_BYTES: usize = 64 * 1024;
pub const DEFAULT_MAX_AGGREGATE_STRING_BYTES: usize = 1024 * 1024;

pub const HARD_MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
pub const HARD_MAX_DEPTH: usize = 64;
pub const HARD_MAX_FIELDS: usize = 4 * 1024;
pub const HARD_MAX_ARRAY_ITEMS: usize = 4 * 1024;
pub const HARD_MAX_NODES: usize = 65_536;
pub const HARD_MAX_STRING_BYTES: usize = 1024 * 1024;
pub const HARD_MAX_AGGREGATE_STRING_BYTES: usize = 8 * 1024 * 1024;

const MAX_IDENTITY_COMPONENT_BYTES: usize = 256;
const OBJECT_ID_DOMAIN: &[u8] = b"mdbx-steam-mafile-object-id-v1";

const ERR_DUPLICATE_KEY: &str = "__mdbx_steam_duplicate_key__";
const ERR_UNSUPPORTED_VALUE: &str = "__mdbx_steam_unsupported_value__";

/// The resource dimension which stopped parsing or invalidated a limit set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    InputBytes,
    Depth,
    Fields,
    ArrayItems,
    Nodes,
    StringBytes,
    AggregateStringBytes,
}

/// Bounds applied before the Adapter returns an owned JSON document.
///
/// Every value can be lowered for a constrained client, but validate rejects
/// zero values and values above the crate hard ceiling. The input byte check
/// happens before invoking serde_json.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SteamMaFileLimits {
    pub max_input_bytes: usize,
    pub max_depth: usize,
    pub max_fields: usize,
    pub max_array_items: usize,
    pub max_nodes: usize,
    pub max_string_bytes: usize,
    pub max_aggregate_string_bytes: usize,
}

impl Default for SteamMaFileLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_depth: DEFAULT_MAX_DEPTH,
            max_fields: DEFAULT_MAX_FIELDS,
            max_array_items: DEFAULT_MAX_ARRAY_ITEMS,
            max_nodes: DEFAULT_MAX_NODES,
            max_string_bytes: DEFAULT_MAX_STRING_BYTES,
            max_aggregate_string_bytes: DEFAULT_MAX_AGGREGATE_STRING_BYTES,
        }
    }
}

impl SteamMaFileLimits {
    pub const fn new(
        max_input_bytes: usize,
        max_depth: usize,
        max_fields: usize,
        max_array_items: usize,
        max_nodes: usize,
        max_string_bytes: usize,
        max_aggregate_string_bytes: usize,
    ) -> Self {
        Self {
            max_input_bytes,
            max_depth,
            max_fields,
            max_array_items,
            max_nodes,
            max_string_bytes,
            max_aggregate_string_bytes,
        }
    }

    pub const fn with_max_input_bytes(mut self, value: usize) -> Self {
        self.max_input_bytes = value;
        self
    }

    pub const fn with_max_depth(mut self, value: usize) -> Self {
        self.max_depth = value;
        self
    }

    pub const fn with_max_fields(mut self, value: usize) -> Self {
        self.max_fields = value;
        self
    }

    pub const fn with_max_array_items(mut self, value: usize) -> Self {
        self.max_array_items = value;
        self
    }

    pub const fn with_max_nodes(mut self, value: usize) -> Self {
        self.max_nodes = value;
        self
    }

    pub const fn with_max_string_bytes(mut self, value: usize) -> Self {
        self.max_string_bytes = value;
        self
    }

    pub const fn with_max_aggregate_string_bytes(mut self, value: usize) -> Self {
        self.max_aggregate_string_bytes = value;
        self
    }

    pub fn validate(&self) -> Result<(), SteamMaFileError> {
        validate_limit(
            self.max_input_bytes,
            HARD_MAX_INPUT_BYTES,
            ResourceKind::InputBytes,
        )?;
        validate_limit(self.max_depth, HARD_MAX_DEPTH, ResourceKind::Depth)?;
        validate_limit(self.max_fields, HARD_MAX_FIELDS, ResourceKind::Fields)?;
        validate_limit(
            self.max_array_items,
            HARD_MAX_ARRAY_ITEMS,
            ResourceKind::ArrayItems,
        )?;
        validate_limit(self.max_nodes, HARD_MAX_NODES, ResourceKind::Nodes)?;
        validate_limit(
            self.max_string_bytes,
            HARD_MAX_STRING_BYTES,
            ResourceKind::StringBytes,
        )?;
        validate_limit(
            self.max_aggregate_string_bytes,
            HARD_MAX_AGGREGATE_STRING_BYTES,
            ResourceKind::AggregateStringBytes,
        )?;
        Ok(())
    }
}

fn validate_limit(
    value: usize,
    hard_ceiling: usize,
    resource: ResourceKind,
) -> Result<(), SteamMaFileError> {
    if value == 0 || value > hard_ceiling {
        return Err(SteamMaFileError::InvalidLimits { resource });
    }
    Ok(())
}

/// Errors intentionally contain only static field names and resource classes;
/// neither the original JSON nor any secret field value is retained.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SteamMaFileError {
    #[error("mafile limits are invalid")]
    InvalidLimits { resource: ResourceKind },
    #[error("mafile input exceeds the configured byte limit")]
    InputTooLarge,
    #[error("mafile JSON exceeds the configured resource limit")]
    ResourceLimit { resource: ResourceKind },
    #[error("mafile JSON is invalid")]
    InvalidJson,
    #[error("mafile root must be a JSON object")]
    RootNotObject,
    #[error("mafile contains a duplicate JSON object key")]
    DuplicateKey,
    #[error("mafile contains an unsupported JSON value")]
    UnsupportedValue,
    #[error("mafile identity field has an invalid JSON type")]
    InvalidIdentityFieldType,
    #[error("mafile contains conflicting identity fields")]
    ConflictingIdentityFields,
    #[error("mafile SteamID is invalid")]
    InvalidSteamId,
    #[error("mafile serial number is invalid")]
    InvalidSerialNumber,
    #[error("mafile SteamID is missing")]
    MissingSteamId,
    #[error("mafile serial number is missing")]
    MissingSerialNumber,
    #[error("mafile SteamID does not match the supplied account identity")]
    SteamIdMismatch,
    #[error("mafile canonical serialization failed")]
    SerializationFailed,
}

/// Return the process-local declaration for the Steam Adapter.
///
/// This descriptor is metadata only. Registering it does not open a vault,
/// authorize a write, or expose encryption keys.
pub fn extension_profile() -> ExtensionProfile {
    ExtensionProfile {
        extension_id: ExtensionId::new(STEAM_EXTENSION_ID).expect("static extension ID is valid"),
        profile_version: STEAM_EXTENSION_PROFILE_VERSION,
        collection_type_ids: vec![CollectionTypeId::new(STEAM_COLLECTION_TYPE_ID)
            .expect("static collection type ID is valid")],
        object_type_ids: vec![ObjectTypeId::custom(STEAM_MAFILE_OBJECT_TYPE_ID)
            .expect("static object type ID is valid")],
        relation_kind_ids: Vec::new(),
        capability_ids: vec![ExtensionCapabilityId::new(STEAM_STORE_CAPABILITY_ID)
            .expect("static capability ID is valid")],
        optional_index_ids: Vec::new(),
        import_adapter_ids: vec![ExtensionFeatureId::new(STEAM_MAFILE_IMPORT_FEATURE_ID)
            .expect("static import feature ID is valid")],
        export_adapter_ids: vec![ExtensionFeatureId::new(STEAM_MAFILE_EXPORT_FEATURE_ID)
            .expect("static export feature ID is valid")],
        presentation_hint_ids: Vec::new(),
    }
    .normalize()
    .expect("static Steam extension profile is valid")
}

/// Parsed mafile document. The complete JSON value is retained so fields not
/// understood by this Adapter survive a canonical parse/serialize cycle.
#[derive(Clone, PartialEq, Eq)]
pub struct SteamMaFile {
    value: Value,
    steam_id: Option<String>,
    serial_number: Option<String>,
}

impl fmt::Debug for SteamMaFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SteamMaFile")
            .field("field_count", &self.field_count())
            .field("has_steam_id", &self.steam_id.is_some())
            .field("has_serial_number", &self.serial_number.is_some())
            .field("canonical_bytes", &self.canonical_len())
            .finish()
    }
}

impl SteamMaFile {
    pub fn parse(input: &[u8]) -> Result<Self, SteamMaFileError> {
        Self::parse_with_limits(input, SteamMaFileLimits::default())
    }

    pub fn parse_with_limits(
        input: &[u8],
        limits: SteamMaFileLimits,
    ) -> Result<Self, SteamMaFileError> {
        limits.validate()?;
        if input.len() > limits.max_input_bytes {
            return Err(SteamMaFileError::InputTooLarge);
        }

        let mut budget = Budget::new(limits);
        let mut deserializer = serde_json::Deserializer::from_slice(input);
        let value = BoundedSeed {
            budget: &mut budget,
            depth: 1,
        }
        .deserialize(&mut deserializer)
        .map_err(classify_json_error)?;
        deserializer.end().map_err(classify_json_error)?;

        let value = canonicalize_value(value);
        let object = match &value {
            Value::Object(object) => object,
            _ => return Err(SteamMaFileError::RootNotObject),
        };
        let steam_id = extract_identity(object, IdentityKind::SteamId)?;
        let serial_number = extract_identity(object, IdentityKind::SerialNumber)?;

        Ok(Self {
            value,
            steam_id,
            serial_number,
        })
    }

    /// Borrow the canonical in-memory JSON value. It may contain secrets; do
    /// not log or persist it outside the encrypted MDBX payload path.
    pub fn as_json(&self) -> &Value {
        &self.value
    }

    /// Borrow one field without assigning semantics to unknown keys.
    pub fn field(&self, name: &str) -> Option<&Value> {
        match &self.value {
            Value::Object(object) => object.get(name),
            _ => None,
        }
    }

    pub fn field_count(&self) -> usize {
        match &self.value {
            Value::Object(object) => object.len(),
            _ => 0,
        }
    }

    pub fn steam_id(&self) -> Option<&str> {
        self.steam_id.as_deref()
    }

    pub fn serial_number(&self) -> Option<&str> {
        self.serial_number.as_deref()
    }

    /// Serialize the complete document with deterministic object-key order.
    /// Unknown fields, including fields added by newer Steam clients, remain in
    /// the output.
    pub fn canonical_json(&self) -> Result<Vec<u8>, SteamMaFileError> {
        serde_json::to_vec(&self.value).map_err(|_| SteamMaFileError::SerializationFailed)
    }

    pub fn canonical_json_string(&self) -> Result<String, SteamMaFileError> {
        String::from_utf8(self.canonical_json()?).map_err(|_| SteamMaFileError::SerializationFailed)
    }

    pub fn canonical_len(&self) -> usize {
        serde_json::to_vec(&self.value)
            .map(|bytes| bytes.len())
            .unwrap_or_default()
    }

    /// Derive the opaque object identity using the supplied account SteamID and
    /// this document serial number. If the document contains a SteamID, it
    /// must agree with the supplied value.
    pub fn stable_object_id(&self, steam_id: &str) -> Result<String, SteamMaFileError> {
        let normalized_steam_id = normalize_steam_id(steam_id)?;
        if let Some(document_steam_id) = self.steam_id.as_deref() {
            if document_steam_id != normalized_steam_id {
                return Err(SteamMaFileError::SteamIdMismatch);
            }
        }
        let serial_number = self
            .serial_number
            .as_deref()
            .ok_or(SteamMaFileError::MissingSerialNumber)?;
        Ok(derive_stable_object_id_normalized(
            &normalized_steam_id,
            serial_number,
        ))
    }

    /// Derive an identity only when both components were present in the
    /// document itself.
    pub fn stable_object_id_from_document(&self) -> Result<String, SteamMaFileError> {
        let steam_id = self
            .steam_id
            .as_deref()
            .ok_or(SteamMaFileError::MissingSteamId)?;
        self.stable_object_id(steam_id)
    }

    /// Derive the deterministic RFC-compatible UUID used by generic MDBX
    /// write commands. It projects the same domain-separated digest as
    /// `stable_object_id` into a custom version-8 UUID without exposing either
    /// identity component.
    pub fn stable_object_uuid(&self, steam_id: &str) -> Result<String, SteamMaFileError> {
        let normalized_steam_id = normalize_steam_id(steam_id)?;
        if let Some(document_steam_id) = self.steam_id.as_deref() {
            if document_steam_id != normalized_steam_id {
                return Err(SteamMaFileError::SteamIdMismatch);
            }
        }
        let serial_number = self
            .serial_number
            .as_deref()
            .ok_or(SteamMaFileError::MissingSerialNumber)?;
        Ok(derive_stable_object_uuid_normalized(
            &normalized_steam_id,
            serial_number,
        ))
    }

    pub fn stable_object_uuid_from_document(&self) -> Result<String, SteamMaFileError> {
        let steam_id = self
            .steam_id
            .as_deref()
            .ok_or(SteamMaFileError::MissingSteamId)?;
        self.stable_object_uuid(steam_id)
    }
}

/// Derive a stable, non-secret, domain-separated object ID from an account
/// SteamID and mafile serial number. Neither input is returned or logged.
pub fn derive_stable_object_id(
    steam_id: &str,
    serial_number: &str,
) -> Result<String, SteamMaFileError> {
    let normalized_steam_id = normalize_steam_id(steam_id)?;
    let normalized_serial_number = normalize_serial_number(serial_number)?;
    Ok(derive_stable_object_id_normalized(
        &normalized_steam_id,
        &normalized_serial_number,
    ))
}

/// Project the stable Steam object digest into a deterministic custom UUID.
///
/// Generic MDBX write operations require UUID object identities. The UUID is
/// derived from the existing SHA-256 identity rather than introducing a
/// second identity source or using a random UUID.
pub fn derive_stable_object_uuid(
    steam_id: &str,
    serial_number: &str,
) -> Result<String, SteamMaFileError> {
    let normalized_steam_id = normalize_steam_id(steam_id)?;
    let normalized_serial_number = normalize_serial_number(serial_number)?;
    Ok(derive_stable_object_uuid_normalized(
        &normalized_steam_id,
        &normalized_serial_number,
    ))
}

fn derive_stable_object_id_normalized(steam_id: &str, serial_number: &str) -> String {
    let digest = stable_object_digest_normalized(steam_id, serial_number);
    let mut encoded = Vec::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize]);
        encoded.push(HEX[(byte & 0x0f) as usize]);
    }
    String::from_utf8(encoded).expect("hex digits are valid UTF-8")
}

fn derive_stable_object_uuid_normalized(steam_id: &str, serial_number: &str) -> String {
    let digest = stable_object_digest_normalized(steam_id, serial_number);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn stable_object_digest_normalized(steam_id: &str, serial_number: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(OBJECT_ID_DOMAIN);
    update_length_prefixed(&mut hasher, steam_id.as_bytes());
    update_length_prefixed(&mut hasher, serial_number.as_bytes());
    hasher.finalize().into()
}

fn update_length_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

#[derive(Clone, Copy)]
enum IdentityKind {
    SteamId,
    SerialNumber,
}

fn extract_identity(
    object: &Map<String, Value>,
    kind: IdentityKind,
) -> Result<Option<String>, SteamMaFileError> {
    let keys: &[&str] = match kind {
        IdentityKind::SteamId => &["steamid", "steam_id", "steamID"],
        IdentityKind::SerialNumber => &["serial_number", "serialNumber"],
    };
    let mut extracted = None;
    for key in keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        let normalized = match kind {
            IdentityKind::SteamId => match value {
                Value::String(value) => normalize_steam_id(value)?,
                Value::Number(value) => normalize_steam_id(&value.to_string())?,
                _ => return Err(SteamMaFileError::InvalidIdentityFieldType),
            },
            IdentityKind::SerialNumber => match value {
                Value::String(value) => normalize_serial_number(value)?,
                Value::Number(value) => normalize_serial_number(&value.to_string())?,
                _ => return Err(SteamMaFileError::InvalidIdentityFieldType),
            },
        };
        if extracted
            .as_deref()
            .is_some_and(|previous: &str| previous != normalized)
        {
            return Err(SteamMaFileError::ConflictingIdentityFields);
        }
        extracted = Some(normalized);
    }
    Ok(extracted)
}

fn normalize_steam_id(value: &str) -> Result<String, SteamMaFileError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_IDENTITY_COMPONENT_BYTES
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(SteamMaFileError::InvalidSteamId);
    }
    let numeric = value
        .parse::<u64>()
        .map_err(|_| SteamMaFileError::InvalidSteamId)?;
    Ok(numeric.to_string())
}

fn normalize_serial_number(value: &str) -> Result<String, SteamMaFileError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_IDENTITY_COMPONENT_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(SteamMaFileError::InvalidSerialNumber);
    }
    Ok(value.to_owned())
}

struct Budget {
    limits: SteamMaFileLimits,
    fields: usize,
    nodes: usize,
    aggregate_string_bytes: usize,
}

impl Budget {
    fn new(limits: SteamMaFileLimits) -> Self {
        Self {
            limits,
            fields: 0,
            nodes: 0,
            aggregate_string_bytes: 0,
        }
    }

    fn node(&mut self, depth: usize) -> Result<(), ResourceKind> {
        if depth > self.limits.max_depth {
            return Err(ResourceKind::Depth);
        }
        self.nodes = self.nodes.saturating_add(1);
        if self.nodes > self.limits.max_nodes {
            return Err(ResourceKind::Nodes);
        }
        Ok(())
    }

    fn field(&mut self) -> Result<(), ResourceKind> {
        self.fields = self.fields.saturating_add(1);
        if self.fields > self.limits.max_fields {
            return Err(ResourceKind::Fields);
        }
        Ok(())
    }

    fn array_item(&self, count: usize) -> Result<(), ResourceKind> {
        if count > self.limits.max_array_items {
            Err(ResourceKind::ArrayItems)
        } else {
            Ok(())
        }
    }

    fn string_bytes(&mut self, length: usize) -> Result<(), ResourceKind> {
        if length > self.limits.max_string_bytes {
            return Err(ResourceKind::StringBytes);
        }
        self.aggregate_string_bytes = self
            .aggregate_string_bytes
            .checked_add(length)
            .ok_or(ResourceKind::AggregateStringBytes)?;
        if self.aggregate_string_bytes > self.limits.max_aggregate_string_bytes {
            return Err(ResourceKind::AggregateStringBytes);
        }
        Ok(())
    }
}

struct BoundedSeed<'a> {
    budget: &'a mut Budget,
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for BoundedSeed<'_> {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BoundedVisitor {
            budget: self.budget,
            depth: self.depth,
        })
    }
}

struct BoundedVisitor<'a> {
    budget: &'a mut Budget,
    depth: usize,
}

impl<'de> Visitor<'de> for BoundedVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        let number =
            serde_json::Number::from_f64(value).ok_or_else(|| E::custom(ERR_UNSUPPORTED_VALUE))?;
        Ok(Value::Number(number))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.visit_owned_string(value.to_owned())
    }

    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.visit_owned_string(value.to_owned())
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.visit_owned_string(value)
    }

    fn visit_bytes<E>(self, _value: &[u8]) -> Result<Value, E>
    where
        E: de::Error,
    {
        Err(E::custom(ERR_UNSUPPORTED_VALUE))
    }

    fn visit_byte_buf<E>(self, _value: Vec<u8>) -> Result<Value, E>
    where
        E: de::Error,
    {
        Err(E::custom(ERR_UNSUPPORTED_VALUE))
    }

    fn visit_none<E>(self) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        Ok(Value::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        BoundedSeed {
            budget: self.budget,
            depth: self.depth,
        }
        .deserialize(deserializer)
    }

    fn visit_newtype_struct<D>(self, deserializer: D) -> Result<Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        self.visit_some(deserializer)
    }

    fn visit_seq<A>(self, mut access: A) -> Result<Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        let mut values = Vec::new();
        let mut count = 0usize;
        loop {
            let Some(value) = access.next_element_seed(BoundedSeed {
                budget: &mut *self.budget,
                depth: self.depth.saturating_add(1),
            })?
            else {
                break;
            };
            let next_count = count.saturating_add(1);
            self.budget.array_item(next_count).map_err(resource_error)?;
            count = next_count;
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut access: A) -> Result<Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        let mut object = Map::new();
        let mut keys = BTreeSet::new();
        while let Some(key) = access.next_key::<String>()? {
            self.budget.field().map_err(resource_error)?;
            self.budget
                .string_bytes(key.len())
                .map_err(resource_error)?;
            if !keys.insert(key.clone()) {
                return Err(A::Error::custom(ERR_DUPLICATE_KEY));
            }
            let value = access.next_value_seed(BoundedSeed {
                budget: &mut *self.budget,
                depth: self.depth.saturating_add(1),
            })?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

impl BoundedVisitor<'_> {
    fn visit_owned_string<E>(self, value: String) -> Result<Value, E>
    where
        E: de::Error,
    {
        self.budget.node(self.depth).map_err(resource_error)?;
        self.budget
            .string_bytes(value.len())
            .map_err(resource_error)?;
        Ok(Value::String(value))
    }
}

fn resource_token(resource: ResourceKind) -> &'static str {
    match resource {
        ResourceKind::InputBytes => "__mdbx_steam_limit_input__",
        ResourceKind::Depth => "__mdbx_steam_limit_depth__",
        ResourceKind::Fields => "__mdbx_steam_limit_fields__",
        ResourceKind::ArrayItems => "__mdbx_steam_limit_array_items__",
        ResourceKind::Nodes => "__mdbx_steam_limit_nodes__",
        ResourceKind::StringBytes => "__mdbx_steam_limit_string__",
        ResourceKind::AggregateStringBytes => "__mdbx_steam_limit_aggregate_string__",
    }
}

fn resource_error<E>(resource: ResourceKind) -> E
where
    E: de::Error,
{
    E::custom(resource_token(resource))
}

fn classify_json_error(error: serde_json::Error) -> SteamMaFileError {
    let message = error.to_string();
    for resource in [
        ResourceKind::Depth,
        ResourceKind::Fields,
        ResourceKind::ArrayItems,
        ResourceKind::Nodes,
        ResourceKind::StringBytes,
        ResourceKind::AggregateStringBytes,
    ] {
        if message.contains(resource_token(resource)) {
            return SteamMaFileError::ResourceLimit { resource };
        }
    }
    if message.contains(ERR_DUPLICATE_KEY) {
        return SteamMaFileError::DuplicateKey;
    }
    if message.contains(ERR_UNSUPPORTED_VALUE) {
        return SteamMaFileError::UnsupportedValue;
    }
    SteamMaFileError::InvalidJson
}

fn canonicalize_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
            let mut sorted = Map::new();
            for (key, value) in entries {
                sorted.insert(key, canonicalize_value(value));
            }
            Value::Object(sorted)
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_value).collect()),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYNTHETIC_SECRET: &str = "synthetic-secret-never-log";

    fn synthetic_mafile() -> Vec<u8> {
        format!(
            r#"{{
                "shared_secret": "{SYNTHETIC_SECRET}",
                "serial_number": " SERIAL-Case-42 ",
                "steamid": "76561198000000001",
                "unknown_future": {{"z": 2, "a": [true, null, "future"]}},
                "account_name": "synthetic-account"
            }}"#
        )
        .into_bytes()
    }

    #[test]
    fn profile_is_namespaced_and_declares_only_optional_adapter_surface() {
        let profile = extension_profile();
        assert_eq!(profile.extension_id.as_str(), STEAM_EXTENSION_ID);
        assert_eq!(profile.profile_version, 1);
        assert_eq!(
            profile.collection_type_ids[0].as_str(),
            STEAM_COLLECTION_TYPE_ID
        );
        assert_eq!(
            profile.object_type_ids[0].as_str(),
            STEAM_MAFILE_OBJECT_TYPE_ID
        );
        assert_eq!(
            profile.capability_ids[0].as_str(),
            STEAM_STORE_CAPABILITY_ID
        );
        assert_eq!(
            profile.import_adapter_ids[0].as_str(),
            STEAM_MAFILE_IMPORT_FEATURE_ID
        );
        assert_eq!(
            profile.export_adapter_ids[0].as_str(),
            STEAM_MAFILE_EXPORT_FEATURE_ID
        );
        assert!(profile.relation_kind_ids.is_empty());
    }

    #[test]
    fn unknown_fields_survive_deterministic_canonical_roundtrip() {
        let parsed = SteamMaFile::parse(&synthetic_mafile()).unwrap();
        let encoded = parsed.canonical_json().unwrap();
        let text = String::from_utf8(encoded.clone()).unwrap();
        assert!(text.contains(SYNTHETIC_SECRET));
        assert!(text.contains("unknown_future"));
        assert!(text.find("account_name").unwrap() < text.find("serial_number").unwrap());
        let reparsed = SteamMaFile::parse(&encoded).unwrap();
        assert_eq!(reparsed.as_json(), parsed.as_json());
        assert_eq!(reparsed.serial_number(), Some("SERIAL-Case-42"));
        assert_eq!(reparsed.steam_id(), Some("76561198000000001"));
    }

    #[test]
    fn duplicate_keys_are_rejected() {
        let error =
            SteamMaFile::parse(br#"{"serial_number":"a","serial_number":"b"}"#).unwrap_err();
        assert_eq!(error, SteamMaFileError::DuplicateKey);
    }

    #[test]
    fn limits_reject_input_depth_fields_arrays_strings_and_nodes() {
        let input_limit = SteamMaFileLimits::default().with_max_input_bytes(6);
        assert_eq!(
            SteamMaFile::parse_with_limits(br#"{"a":1}"#, input_limit).unwrap_err(),
            SteamMaFileError::InputTooLarge
        );

        let depth_input = br#"{"a":[[[[1]]]]}"#;
        let depth_limit = SteamMaFileLimits::default().with_max_depth(3);
        assert!(matches!(
            SteamMaFile::parse_with_limits(depth_input, depth_limit),
            Err(SteamMaFileError::ResourceLimit {
                resource: ResourceKind::Depth
            })
        ));

        let fields_input = br#"{"a":1,"b":2}"#;
        let fields_limit = SteamMaFileLimits::default().with_max_fields(1);
        assert!(matches!(
            SteamMaFile::parse_with_limits(fields_input, fields_limit),
            Err(SteamMaFileError::ResourceLimit {
                resource: ResourceKind::Fields
            })
        ));

        let array_input = br#"{"a":[1,2]}"#;
        let array_limit = SteamMaFileLimits::default().with_max_array_items(1);
        assert!(SteamMaFile::parse_with_limits(br#"{"a":[1]}"#, array_limit).is_ok());
        assert!(matches!(
            SteamMaFile::parse_with_limits(array_input, array_limit),
            Err(SteamMaFileError::ResourceLimit {
                resource: ResourceKind::ArrayItems
            })
        ));

        let string_input = br#"{"a":"12345"}"#;
        let string_limit = SteamMaFileLimits::default().with_max_string_bytes(4);
        assert!(matches!(
            SteamMaFile::parse_with_limits(string_input, string_limit),
            Err(SteamMaFileError::ResourceLimit {
                resource: ResourceKind::StringBytes
            })
        ));

        let aggregate_input = br#"{"a":"12","b":"34"}"#;
        let aggregate_limit = SteamMaFileLimits::default().with_max_aggregate_string_bytes(5);
        assert!(matches!(
            SteamMaFile::parse_with_limits(aggregate_input, aggregate_limit),
            Err(SteamMaFileError::ResourceLimit {
                resource: ResourceKind::AggregateStringBytes
            })
        ));
        assert!(SteamMaFile::parse_with_limits(
            br#"{"a":123456789}"#,
            SteamMaFileLimits::default().with_max_aggregate_string_bytes(1)
        )
        .is_ok());

        let nodes_input = br#"{"a":1,"b":2}"#;
        let nodes_limit = SteamMaFileLimits::default().with_max_nodes(2);
        assert!(matches!(
            SteamMaFile::parse_with_limits(nodes_input, nodes_limit),
            Err(SteamMaFileError::ResourceLimit {
                resource: ResourceKind::Nodes
            })
        ));
    }

    #[test]
    fn caller_limits_cannot_exceed_hard_ceiling() {
        let limits = SteamMaFileLimits::default().with_max_input_bytes(HARD_MAX_INPUT_BYTES + 1);
        assert!(matches!(
            limits.validate(),
            Err(SteamMaFileError::InvalidLimits {
                resource: ResourceKind::InputBytes
            })
        ));
    }

    #[test]
    fn debug_and_errors_do_not_disclose_payload_values() {
        let parsed = SteamMaFile::parse(&synthetic_mafile()).unwrap();
        let debug = format!("{parsed:?}");
        assert!(!debug.contains(SYNTHETIC_SECRET));
        let error =
            SteamMaFile::parse(br#"{"serial_number": {"secret":"synthetic-secret-never-log"}}"#)
                .unwrap_err();
        assert!(!format!("{error:?}").contains(SYNTHETIC_SECRET));
        assert!(!error.to_string().contains(SYNTHETIC_SECRET));
    }

    #[test]
    fn stable_identity_is_deterministic_and_domain_separated() {
        let parsed = SteamMaFile::parse(&synthetic_mafile()).unwrap();
        let first = parsed.stable_object_id("76561198000000001").unwrap();
        let second = parsed.stable_object_id("76561198000000001").unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(!first.contains(SYNTHETIC_SECRET));
        assert_ne!(
            first,
            derive_stable_object_id("76561198000000002", "SERIAL-Case-42").unwrap()
        );
        assert_eq!(
            first,
            derive_stable_object_id(" 76561198000000001 ", "SERIAL-Case-42").unwrap()
        );
        assert_eq!(parsed.stable_object_id_from_document().unwrap(), first);

        let object_uuid = parsed.stable_object_uuid("76561198000000001").unwrap();
        assert_eq!(
            object_uuid,
            derive_stable_object_uuid("76561198000000001", "SERIAL-Case-42").unwrap()
        );
        assert_eq!(
            parsed.stable_object_uuid_from_document().unwrap(),
            object_uuid
        );
        let object_uuid = Uuid::parse_str(&object_uuid).unwrap();
        assert_eq!(object_uuid.get_version_num(), 8);
        assert_eq!(object_uuid.get_variant(), uuid::Variant::RFC4122);
    }

    #[test]
    fn identity_validation_rejects_ambiguous_or_mismatched_inputs() {
        let conflict = SteamMaFile::parse(
            br#"{"steamid":"76561198000000001","steam_id":"76561198000000002","serial_number":"s"}"#,
        )
        .unwrap_err();
        assert_eq!(conflict, SteamMaFileError::ConflictingIdentityFields);

        let parsed = SteamMaFile::parse(br#"{"serial_number":"s"}"#).unwrap();
        assert_eq!(
            parsed.stable_object_id("76561198000000001").unwrap().len(),
            64
        );
        assert_eq!(
            parsed.stable_object_id("not-a-steam-id").unwrap_err(),
            SteamMaFileError::InvalidSteamId
        );

        let mismatched =
            SteamMaFile::parse(br#"{"steamid":"76561198000000001","serial_number":"s"}"#).unwrap();
        assert_eq!(
            mismatched
                .stable_object_id("76561198000000002")
                .unwrap_err(),
            SteamMaFileError::SteamIdMismatch
        );
    }
}
