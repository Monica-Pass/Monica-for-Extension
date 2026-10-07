use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::entry::validate_extension_id;
use super::ObjectTypeId;
use crate::types::{CipherText, DeviceId, ProjectId};

pub const MAX_COLLECTION_PROFILE_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_COLLECTION_PROFILE_OBJECT_TYPES: usize = 256;
pub const MAX_COLLECTION_PROFILE_CAPABILITIES: usize = 128;

/// Stable namespaced identifier for the semantic kind of a Collection.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CollectionTypeId(String);

impl CollectionTypeId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        value.into().parse()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for CollectionTypeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for CollectionTypeId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        validate_namespaced_id(value, "collection type")?;
        Ok(Self(value.to_string()))
    }
}

impl Serialize for CollectionTypeId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CollectionTypeId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Stable namespaced capability supplied by a domain Adapter.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExtensionCapabilityId(String);

impl ExtensionCapabilityId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        value.into().parse()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ExtensionCapabilityId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for ExtensionCapabilityId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        validate_namespaced_id(value, "extension capability")?;
        Ok(Self(value.to_string()))
    }
}

impl Serialize for ExtensionCapabilityId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExtensionCapabilityId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Versioned encrypted semantic description attached to one Collection.
///
/// MDBX1 Collections have no profile row. Once a profile is established its
/// CollectionTypeId is immutable; payload versions and capability declarations
/// may advance through tracked Collection mutations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionProfile {
    pub collection_id: ProjectId,
    pub collection_type_id: CollectionTypeId,
    pub payload_ct: CipherText,
    pub payload_schema_version: u32,
    pub allowed_object_type_ids: Vec<ObjectTypeId>,
    pub required_capability_ids: Vec<ExtensionCapabilityId>,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: DeviceId,
    pub updated_by_device_id: DeviceId,
}

impl CollectionProfile {
    pub fn validate(&self) -> Result<(), String> {
        if self.collection_id.is_empty() {
            return Err("collection profile requires a collection ID".to_string());
        }
        if self.payload_schema_version == 0 {
            return Err(
                "collection profile payload schema version must be greater than zero".to_string(),
            );
        }
        if self.payload_ct.len() > MAX_COLLECTION_PROFILE_PAYLOAD_BYTES {
            return Err(format!(
                "collection profile payload exceeds {} bytes",
                MAX_COLLECTION_PROFILE_PAYLOAD_BYTES
            ));
        }
        if self.allowed_object_type_ids.len() > MAX_COLLECTION_PROFILE_OBJECT_TYPES {
            return Err(format!(
                "collection profile declares more than {} object types",
                MAX_COLLECTION_PROFILE_OBJECT_TYPES
            ));
        }
        if self.required_capability_ids.len() > MAX_COLLECTION_PROFILE_CAPABILITIES {
            return Err(format!(
                "collection profile declares more than {} capabilities",
                MAX_COLLECTION_PROFILE_CAPABILITIES
            ));
        }
        for object_type in &self.allowed_object_type_ids {
            object_type.validate()?;
        }
        if self.created_at.is_empty()
            || self.updated_at.is_empty()
            || self.created_by_device_id.is_empty()
            || self.updated_by_device_id.is_empty()
        {
            return Err("collection profile requires timestamps and device identities".to_string());
        }
        Ok(())
    }

    pub fn normalize(mut self) -> Result<Self, String> {
        self.allowed_object_type_ids.sort();
        self.allowed_object_type_ids.dedup();
        self.required_capability_ids.sort();
        self.required_capability_ids.dedup();
        self.validate()?;
        Ok(self)
    }

    pub fn allows_object_type(&self, object_type: &ObjectTypeId) -> bool {
        self.allowed_object_type_ids
            .binary_search(object_type)
            .is_ok()
    }

    pub fn missing_capabilities<'a>(
        &'a self,
        available: &BTreeSet<ExtensionCapabilityId>,
    ) -> Vec<&'a ExtensionCapabilityId> {
        self.required_capability_ids
            .iter()
            .filter(|capability| !available.contains(*capability))
            .collect()
    }
}

/// Bounded, payload-free Collection metadata for navigation and adapter discovery.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionSummary {
    pub collection_id: ProjectId,
    pub title: Vec<u8>,
    pub collection_type_id: Option<CollectionTypeId>,
    pub profile_schema_version: Option<u32>,
    pub group_id: Option<String>,
    pub icon_ref: Option<String>,
    pub favorite: bool,
    pub archived: bool,
    pub attachment_count: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

/// Bounded page of Collection summaries with an opaque query-bound cursor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionSummaryPage {
    pub items: Vec<CollectionSummary>,
    pub next_cursor: Option<String>,
}

fn validate_namespaced_id(value: &str, kind: &str) -> Result<(), String> {
    validate_extension_id(value)?;
    if !value.contains('.') {
        return Err(format!("{kind} ID must be namespaced"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> CollectionProfile {
        CollectionProfile {
            collection_id: "collection-1".to_string(),
            collection_type_id: CollectionTypeId::new("com.monica.mail").unwrap(),
            payload_ct: br#"{"account":"primary"}"#.to_vec(),
            payload_schema_version: 2,
            allowed_object_type_ids: vec![
                ObjectTypeId::custom("com.monica.mail.message").unwrap(),
                ObjectTypeId::custom("com.monica.mail.contact").unwrap(),
                ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            ],
            required_capability_ids: vec![
                ExtensionCapabilityId::new("com.monica.mail.sync").unwrap(),
                ExtensionCapabilityId::new("com.monica.mail.store").unwrap(),
                ExtensionCapabilityId::new("com.monica.mail.sync").unwrap(),
            ],
            created_at: "2026-07-20T00:00:00Z".to_string(),
            updated_at: "2026-07-20T00:00:00Z".to_string(),
            created_by_device_id: "device-1".to_string(),
            updated_by_device_id: "device-1".to_string(),
        }
    }

    #[test]
    fn collection_and_capability_ids_require_namespaces() {
        assert!(CollectionTypeId::new("mail").is_err());
        assert!(CollectionTypeId::new("Com.Monica.Mail").is_err());
        assert!(ExtensionCapabilityId::new("sync").is_err());
        assert_eq!(
            CollectionTypeId::new("com.monica.mail").unwrap().as_str(),
            "com.monica.mail"
        );
    }

    #[test]
    fn profile_normalization_is_deterministic() {
        let profile = profile().normalize().unwrap();
        assert_eq!(profile.allowed_object_type_ids.len(), 2);
        assert_eq!(profile.required_capability_ids.len(), 2);
        assert!(
            profile.allows_object_type(&ObjectTypeId::custom("com.monica.mail.message").unwrap())
        );
        assert!(!profile.allows_object_type(&ObjectTypeId::Login));
    }

    #[test]
    fn missing_capabilities_are_reported_in_canonical_order() {
        let profile = profile().normalize().unwrap();
        let available =
            BTreeSet::from([ExtensionCapabilityId::new("com.monica.mail.store").unwrap()]);
        let missing = profile.missing_capabilities(&available);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].as_str(), "com.monica.mail.sync");
    }

    #[test]
    fn profile_rejects_zero_schema_version_and_oversized_payload() {
        let mut invalid = profile();
        invalid.payload_schema_version = 0;
        assert!(invalid.validate().is_err());

        invalid.payload_schema_version = 1;
        invalid.payload_ct = vec![0; MAX_COLLECTION_PROFILE_PAYLOAD_BYTES + 1];
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn profile_roundtrips_exact_extension_identifiers() {
        let profile = profile().normalize().unwrap();
        let encoded = serde_json::to_vec(&profile).unwrap();
        let decoded: CollectionProfile = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, profile);
    }
}
