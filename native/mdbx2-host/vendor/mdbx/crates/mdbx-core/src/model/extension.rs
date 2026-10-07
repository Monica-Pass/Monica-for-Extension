use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::entry::validate_extension_id;
use super::{CollectionTypeId, ExtensionCapabilityId, ObjectTypeId, RelationKindId};

pub const MAX_EXTENSION_PROFILE_COLLECTION_TYPES: usize = 64;
pub const MAX_EXTENSION_PROFILE_OBJECT_TYPES: usize = 256;
pub const MAX_EXTENSION_PROFILE_RELATION_KINDS: usize = 256;
pub const MAX_EXTENSION_PROFILE_CAPABILITIES: usize = 128;
pub const MAX_EXTENSION_PROFILE_FEATURES_PER_CATEGORY: usize = 128;

/// Stable namespaced identity of one process-loaded domain extension.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExtensionId(String);

impl ExtensionId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        value.into().parse()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn owns(&self, value: &str) -> bool {
        value == self.0
            || value
                .strip_prefix(&self.0)
                .is_some_and(|suffix| suffix.starts_with('.'))
    }
}

impl std::fmt::Display for ExtensionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for ExtensionId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        validate_namespaced_id(value, "extension")?;
        Ok(Self(value.to_string()))
    }
}

impl Serialize for ExtensionId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExtensionId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Stable namespaced identity of one optional, non-authority extension feature.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ExtensionFeatureId(String);

impl ExtensionFeatureId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        value.into().parse()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ExtensionFeatureId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for ExtensionFeatureId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        validate_namespaced_id(value, "extension feature")?;
        Ok(Self(value.to_string()))
    }
}

impl Serialize for ExtensionFeatureId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ExtensionFeatureId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Canonical process-local declaration supplied by one loaded domain Adapter.
///
/// This descriptor is discovery and validation metadata. It is never persisted
/// as vault authority and grants no encryption-key or Tiga access.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExtensionProfile {
    pub extension_id: ExtensionId,
    pub profile_version: u32,
    #[serde(default)]
    pub collection_type_ids: Vec<CollectionTypeId>,
    #[serde(default)]
    pub object_type_ids: Vec<ObjectTypeId>,
    #[serde(default)]
    pub relation_kind_ids: Vec<RelationKindId>,
    #[serde(default)]
    pub capability_ids: Vec<ExtensionCapabilityId>,
    #[serde(default)]
    pub optional_index_ids: Vec<ExtensionFeatureId>,
    #[serde(default)]
    pub import_adapter_ids: Vec<ExtensionFeatureId>,
    #[serde(default)]
    pub export_adapter_ids: Vec<ExtensionFeatureId>,
    #[serde(default)]
    pub presentation_hint_ids: Vec<ExtensionFeatureId>,
}

impl ExtensionProfile {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_version == 0 {
            return Err("extension profile version must be greater than zero".to_string());
        }
        if self.collection_type_ids.is_empty() {
            return Err("extension profile requires at least one collection type".to_string());
        }
        validate_len(
            "collection types",
            self.collection_type_ids.len(),
            MAX_EXTENSION_PROFILE_COLLECTION_TYPES,
        )?;
        validate_len(
            "object types",
            self.object_type_ids.len(),
            MAX_EXTENSION_PROFILE_OBJECT_TYPES,
        )?;
        validate_len(
            "relation kinds",
            self.relation_kind_ids.len(),
            MAX_EXTENSION_PROFILE_RELATION_KINDS,
        )?;
        validate_len(
            "capabilities",
            self.capability_ids.len(),
            MAX_EXTENSION_PROFILE_CAPABILITIES,
        )?;
        for (name, values) in [
            ("optional indexes", self.optional_index_ids.as_slice()),
            ("import adapters", self.import_adapter_ids.as_slice()),
            ("export adapters", self.export_adapter_ids.as_slice()),
            ("presentation hints", self.presentation_hint_ids.as_slice()),
        ] {
            validate_len(
                name,
                values.len(),
                MAX_EXTENSION_PROFILE_FEATURES_PER_CATEGORY,
            )?;
        }

        for collection_type_id in &self.collection_type_ids {
            self.validate_owned(collection_type_id.as_str(), "collection type")?;
        }
        for object_type_id in &self.object_type_ids {
            object_type_id.validate()?;
            match object_type_id {
                ObjectTypeId::Custom(value) => self.validate_owned(value, "object type")?,
                _ => {
                    return Err(format!(
                        "extension {} cannot claim legacy object type {}",
                        self.extension_id, object_type_id
                    ));
                }
            }
        }
        for relation_kind_id in &self.relation_kind_ids {
            self.validate_owned(relation_kind_id.as_str(), "relation kind")?;
        }
        for capability_id in &self.capability_ids {
            self.validate_owned(capability_id.as_str(), "capability")?;
        }

        let mut feature_ids = BTreeSet::new();
        for (category, values) in [
            ("optional index", self.optional_index_ids.as_slice()),
            ("import adapter", self.import_adapter_ids.as_slice()),
            ("export adapter", self.export_adapter_ids.as_slice()),
            ("presentation hint", self.presentation_hint_ids.as_slice()),
        ] {
            for feature_id in values {
                self.validate_owned(feature_id.as_str(), category)?;
                if !feature_ids.insert(feature_id) {
                    return Err(format!(
                        "extension feature {} is declared in more than one category",
                        feature_id
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn normalize(mut self) -> Result<Self, String> {
        self.collection_type_ids.sort();
        self.collection_type_ids.dedup();
        self.object_type_ids.sort();
        self.object_type_ids.dedup();
        self.relation_kind_ids.sort();
        self.relation_kind_ids.dedup();
        self.capability_ids.sort();
        self.capability_ids.dedup();
        self.optional_index_ids.sort();
        self.optional_index_ids.dedup();
        self.import_adapter_ids.sort();
        self.import_adapter_ids.dedup();
        self.export_adapter_ids.sort();
        self.export_adapter_ids.dedup();
        self.presentation_hint_ids.sort();
        self.presentation_hint_ids.dedup();
        self.validate()?;
        Ok(self)
    }

    pub fn supports_collection_type(&self, value: &CollectionTypeId) -> bool {
        self.collection_type_ids.binary_search(value).is_ok()
    }

    pub fn supports_object_type(&self, value: &ObjectTypeId) -> bool {
        self.object_type_ids.binary_search(value).is_ok()
    }

    pub fn supports_relation_kind(&self, value: &RelationKindId) -> bool {
        self.relation_kind_ids.binary_search(value).is_ok()
    }

    fn validate_owned(&self, value: &str, kind: &str) -> Result<(), String> {
        if self.extension_id.owns(value) {
            Ok(())
        } else {
            Err(format!(
                "{kind} {value} is outside extension namespace {}",
                self.extension_id
            ))
        }
    }
}

fn validate_namespaced_id(value: &str, kind: &str) -> Result<(), String> {
    validate_extension_id(value)?;
    if !value.contains('.') {
        return Err(format!("{kind} ID must be namespaced"));
    }
    Ok(())
}

fn validate_len(name: &str, actual: usize, limit: usize) -> Result<(), String> {
    if actual > limit {
        return Err(format!(
            "extension profile declares more than {limit} {name}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ExtensionProfile {
        ExtensionProfile {
            extension_id: ExtensionId::new("com.monica.mail").unwrap(),
            profile_version: 2,
            collection_type_ids: vec![
                CollectionTypeId::new("com.monica.mail").unwrap(),
                CollectionTypeId::new("com.monica.mail.archive").unwrap(),
            ],
            object_type_ids: vec![
                ObjectTypeId::custom("com.monica.mail.message").unwrap(),
                ObjectTypeId::custom("com.monica.mail.contact").unwrap(),
                ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            ],
            relation_kind_ids: vec![
                RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                RelationKindId::new("com.monica.mail.thread-member").unwrap(),
            ],
            capability_ids: vec![
                ExtensionCapabilityId::new("com.monica.mail.store").unwrap(),
                ExtensionCapabilityId::new("com.monica.mail.sync").unwrap(),
            ],
            optional_index_ids: vec![
                ExtensionFeatureId::new("com.monica.mail.index.messages").unwrap()
            ],
            import_adapter_ids: vec![ExtensionFeatureId::new("com.monica.mail.import.eml").unwrap()],
            export_adapter_ids: vec![ExtensionFeatureId::new("com.monica.mail.export.eml").unwrap()],
            presentation_hint_ids: vec![ExtensionFeatureId::new(
                "com.monica.mail.presentation.threaded",
            )
            .unwrap()],
        }
    }

    #[test]
    fn extension_identifiers_are_namespaced_and_have_exact_ownership() {
        let extension = ExtensionId::new("com.monica.mail").unwrap();
        assert!(extension.owns("com.monica.mail"));
        assert!(extension.owns("com.monica.mail.message"));
        assert!(!extension.owns("com.monica.mailbox"));
        assert!(ExtensionId::new("mail").is_err());
        assert!(ExtensionFeatureId::new("index").is_err());
    }

    #[test]
    fn extension_profile_normalization_is_deterministic() {
        let profile = profile().normalize().unwrap();
        assert_eq!(profile.object_type_ids.len(), 2);
        assert!(profile
            .supports_collection_type(&CollectionTypeId::new("com.monica.mail.archive").unwrap()));
        assert!(
            profile.supports_object_type(&ObjectTypeId::custom("com.monica.mail.message").unwrap())
        );
        assert!(profile
            .supports_relation_kind(&RelationKindId::new("com.monica.mail.reply-to").unwrap()));
    }

    #[test]
    fn extension_profile_rejects_foreign_and_legacy_semantics() {
        let mut foreign = profile();
        foreign.object_type_ids = vec![ObjectTypeId::custom("com.monica.bookmark.item").unwrap()];
        assert!(foreign.validate().unwrap_err().contains("outside"));

        let mut legacy = profile();
        legacy.object_type_ids = vec![ObjectTypeId::Login];
        assert!(legacy
            .validate()
            .unwrap_err()
            .contains("legacy object type"));
    }

    #[test]
    fn extension_profile_rejects_feature_category_aliasing() {
        let mut profile = profile();
        profile.export_adapter_ids = profile.import_adapter_ids.clone();
        assert!(profile
            .validate()
            .unwrap_err()
            .contains("more than one category"));
    }

    #[test]
    fn extension_profile_roundtrips_canonically() {
        let profile = profile().normalize().unwrap();
        let encoded = serde_json::to_vec(&profile).unwrap();
        let decoded: ExtensionProfile = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded.normalize().unwrap(), profile);
    }
}
