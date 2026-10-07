use std::collections::BTreeMap;

use mdbx_core::model::{
    CollectionProfile, CollectionTypeId, ExtensionCapabilityId, ExtensionFeatureId, ExtensionId,
    ExtensionProfile, ObjectTypeId, RelationKindId,
};

use crate::error::{StorageError, StorageResult};

pub const MAX_REGISTERED_EXTENSION_PROFILES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionRegistration {
    Registered,
    AlreadyRegistered,
}

/// Process-local registry of the semantic surface supplied by loaded Adapters.
///
/// The registry is never persisted and grants no storage, key, or Tiga
/// authority. Its ownership indexes prevent two loaded extensions from
/// claiming the same stable identifier.
#[derive(Debug, Clone, Default)]
pub struct ExtensionRegistry {
    profiles: BTreeMap<ExtensionId, ExtensionProfile>,
    collection_type_owners: BTreeMap<CollectionTypeId, ExtensionId>,
    object_type_owners: BTreeMap<ObjectTypeId, ExtensionId>,
    relation_kind_owners: BTreeMap<RelationKindId, ExtensionId>,
    capability_owners: BTreeMap<ExtensionCapabilityId, ExtensionId>,
    feature_owners: BTreeMap<ExtensionFeatureId, ExtensionId>,
}

impl ExtensionRegistry {
    pub fn register(&mut self, profile: ExtensionProfile) -> StorageResult<ExtensionRegistration> {
        let mut next = self.clone();
        let registration = next.register_in_place(profile)?;
        *self = next;
        Ok(registration)
    }

    pub fn replace_all<I>(&mut self, profiles: I) -> StorageResult<()>
    where
        I: IntoIterator<Item = ExtensionProfile>,
    {
        let mut next = Self::default();
        for profile in profiles {
            next.register_in_place(profile)?;
        }
        *self = next;
        Ok(())
    }

    pub fn unregister(&mut self, extension_id: &ExtensionId) -> Option<ExtensionProfile> {
        let removed = self.profiles.get(extension_id)?.clone();
        let remaining = self
            .profiles
            .values()
            .filter(|profile| profile.extension_id != *extension_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut next = Self::default();
        for profile in remaining {
            next.register_in_place(profile)
                .expect("registered extension profiles must rebuild without conflict");
        }
        *self = next;
        Some(removed)
    }

    pub fn get(&self, extension_id: &ExtensionId) -> Option<&ExtensionProfile> {
        self.profiles.get(extension_id)
    }

    pub fn list(&self) -> Vec<ExtensionProfile> {
        self.profiles.values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.profiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.profiles.is_empty()
    }

    pub fn owner_for_collection_type(
        &self,
        collection_type_id: &CollectionTypeId,
    ) -> Option<&ExtensionId> {
        self.collection_type_owners.get(collection_type_id)
    }

    pub fn owner_for_object_type(&self, object_type_id: &ObjectTypeId) -> Option<&ExtensionId> {
        self.object_type_owners.get(object_type_id)
    }

    pub fn owner_for_relation_kind(
        &self,
        relation_kind_id: &RelationKindId,
    ) -> Option<&ExtensionId> {
        self.relation_kind_owners.get(relation_kind_id)
    }

    pub fn owner_for_capability(
        &self,
        capability_id: &ExtensionCapabilityId,
    ) -> Option<&ExtensionId> {
        self.capability_owners.get(capability_id)
    }

    pub fn owner_for_feature(&self, feature_id: &ExtensionFeatureId) -> Option<&ExtensionId> {
        self.feature_owners.get(feature_id)
    }

    pub fn validate_collection_profile(&self, profile: &CollectionProfile) -> StorageResult<()> {
        self.validate_collection_contract(
            &profile.collection_type_id,
            &profile.allowed_object_type_ids,
            &profile.required_capability_ids,
        )
    }

    pub fn validate_collection_contract(
        &self,
        collection_type_id: &CollectionTypeId,
        allowed_object_type_ids: &[ObjectTypeId],
        required_capability_ids: &[ExtensionCapabilityId],
    ) -> StorageResult<()> {
        let Some(owner) = self.owner_for_collection_type(collection_type_id) else {
            return Ok(());
        };
        let profile = self
            .profiles
            .get(owner)
            .expect("collection owner must reference a registered profile");
        for object_type_id in allowed_object_type_ids {
            if !profile.supports_object_type(object_type_id) {
                return Err(StorageError::ConstraintViolation(format!(
                    "collection type {collection_type_id} declares object type {object_type_id} outside registered extension {owner}"
                )));
            }
        }
        for capability_id in required_capability_ids {
            if profile.capability_ids.binary_search(capability_id).is_err() {
                return Err(StorageError::ConstraintViolation(format!(
                    "collection type {collection_type_id} requires capability {capability_id} outside registered extension {owner}"
                )));
            }
        }
        Ok(())
    }

    fn register_in_place(
        &mut self,
        profile: ExtensionProfile,
    ) -> StorageResult<ExtensionRegistration> {
        let profile = profile.normalize().map_err(StorageError::Validation)?;
        if let Some(existing) = self.profiles.get(&profile.extension_id) {
            if existing == &profile {
                return Ok(ExtensionRegistration::AlreadyRegistered);
            }
            return Err(StorageError::ConstraintViolation(format!(
                "extension {} is already registered with a different profile",
                profile.extension_id
            )));
        }
        if self.profiles.len() >= MAX_REGISTERED_EXTENSION_PROFILES {
            return Err(StorageError::ResourceLimit {
                resource: "registered extension profiles".to_string(),
                actual: (self.profiles.len() + 1) as u64,
                limit: MAX_REGISTERED_EXTENSION_PROFILES as u64,
            });
        }

        for collection_type_id in &profile.collection_type_ids {
            claim(
                &mut self.collection_type_owners,
                collection_type_id,
                &profile.extension_id,
                "collection type",
            )?;
        }
        for object_type_id in &profile.object_type_ids {
            claim(
                &mut self.object_type_owners,
                object_type_id,
                &profile.extension_id,
                "object type",
            )?;
        }
        for relation_kind_id in &profile.relation_kind_ids {
            claim(
                &mut self.relation_kind_owners,
                relation_kind_id,
                &profile.extension_id,
                "relation kind",
            )?;
        }
        for capability_id in &profile.capability_ids {
            claim(
                &mut self.capability_owners,
                capability_id,
                &profile.extension_id,
                "capability",
            )?;
        }
        for feature_id in profile
            .optional_index_ids
            .iter()
            .chain(&profile.import_adapter_ids)
            .chain(&profile.export_adapter_ids)
            .chain(&profile.presentation_hint_ids)
        {
            claim(
                &mut self.feature_owners,
                feature_id,
                &profile.extension_id,
                "extension feature",
            )?;
        }
        self.profiles.insert(profile.extension_id.clone(), profile);
        Ok(ExtensionRegistration::Registered)
    }
}

fn claim<K>(
    owners: &mut BTreeMap<K, ExtensionId>,
    value: &K,
    extension_id: &ExtensionId,
    kind: &str,
) -> StorageResult<()>
where
    K: Clone + Ord + std::fmt::Display,
{
    if let Some(existing) = owners.get(value) {
        if existing != extension_id {
            return Err(StorageError::ConstraintViolation(format!(
                "{kind} {value} is already owned by extension {existing}"
            )));
        }
        return Ok(());
    }
    owners.insert(value.clone(), extension_id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(namespace: &str) -> ExtensionProfile {
        ExtensionProfile {
            extension_id: ExtensionId::new(namespace).unwrap(),
            profile_version: 1,
            collection_type_ids: vec![CollectionTypeId::new(namespace).unwrap()],
            object_type_ids: vec![ObjectTypeId::custom(format!("{namespace}.item")).unwrap()],
            relation_kind_ids: vec![RelationKindId::new(format!("{namespace}.member")).unwrap()],
            capability_ids: vec![ExtensionCapabilityId::new(format!("{namespace}.store")).unwrap()],
            optional_index_ids: vec![
                ExtensionFeatureId::new(format!("{namespace}.index.main")).unwrap()
            ],
            import_adapter_ids: Vec::new(),
            export_adapter_ids: Vec::new(),
            presentation_hint_ids: Vec::new(),
        }
    }

    #[test]
    fn exact_registration_is_idempotent_and_list_is_canonical() {
        let mut registry = ExtensionRegistry::default();
        let mail = profile("com.monica.mail");
        let bookmark = profile("com.monica.bookmark");

        assert_eq!(
            registry.register(mail.clone()).unwrap(),
            ExtensionRegistration::Registered
        );
        assert_eq!(
            registry.register(mail).unwrap(),
            ExtensionRegistration::AlreadyRegistered
        );
        registry.register(bookmark).unwrap();

        assert_eq!(registry.len(), 2);
        assert_eq!(
            registry
                .list()
                .into_iter()
                .map(|profile| profile.extension_id.to_string())
                .collect::<Vec<_>>(),
            vec!["com.monica.bookmark", "com.monica.mail"]
        );
    }

    #[test]
    fn conflicting_registration_is_atomic() {
        let mut registry = ExtensionRegistry::default();
        let mail = profile("com.monica.mail");
        registry.register(mail.clone()).unwrap();
        let mut changed = mail.clone();
        changed.profile_version = 2;

        assert!(registry.register(changed).is_err());
        assert_eq!(registry.list(), vec![mail.normalize().unwrap()]);
    }

    #[test]
    fn duplicate_ownership_is_rejected_without_partial_indexes() {
        let mut registry = ExtensionRegistry::default();
        let mut umbrella = profile("com.monica");
        umbrella.collection_type_ids = vec![CollectionTypeId::new("com.monica.mail").unwrap()];
        umbrella.object_type_ids = vec![ObjectTypeId::custom("com.monica.mail.item").unwrap()];
        umbrella.relation_kind_ids = vec![RelationKindId::new("com.monica.mail.member").unwrap()];
        umbrella.capability_ids =
            vec![ExtensionCapabilityId::new("com.monica.mail.store").unwrap()];
        umbrella.optional_index_ids =
            vec![ExtensionFeatureId::new("com.monica.mail.index.main").unwrap()];
        registry.register(umbrella.clone()).unwrap();
        let mail = profile("com.monica.mail");

        assert!(registry.register(mail.clone()).is_err());
        assert_eq!(registry.len(), 1);
        assert!(registry.get(&mail.extension_id).is_none());
        assert_eq!(
            registry.owner_for_collection_type(&umbrella.collection_type_ids[0]),
            Some(&umbrella.extension_id)
        );
    }

    #[test]
    fn replace_all_and_unregister_rebuild_ownership_atomically() {
        let mut registry = ExtensionRegistry::default();
        let mail = profile("com.monica.mail");
        let bookmark = profile("com.monica.bookmark");
        registry
            .replace_all([bookmark.clone(), mail.clone()])
            .unwrap();
        let before = registry.list();
        let mut conflict = profile("com.monica");
        conflict.collection_type_ids = mail.collection_type_ids.clone();
        conflict.object_type_ids = mail.object_type_ids.clone();
        conflict.relation_kind_ids = mail.relation_kind_ids.clone();
        conflict.capability_ids = mail.capability_ids.clone();
        conflict.optional_index_ids = mail.optional_index_ids.clone();

        assert!(registry
            .replace_all([bookmark.clone(), mail.clone(), conflict])
            .is_err());
        assert_eq!(registry.list(), before);
        assert_eq!(registry.unregister(&mail.extension_id), Some(mail.clone()));
        assert_eq!(registry.list(), vec![bookmark.normalize().unwrap()]);
        assert!(registry
            .owner_for_object_type(&mail.object_type_ids[0])
            .is_none());
    }

    #[test]
    fn matching_collection_contract_is_checked_when_registered() {
        let mut registry = ExtensionRegistry::default();
        let mail = profile("com.monica.mail").normalize().unwrap();
        registry.register(mail.clone()).unwrap();
        let collection = CollectionProfile {
            collection_id: "collection-1".to_string(),
            collection_type_id: mail.collection_type_ids[0].clone(),
            payload_ct: Vec::new(),
            payload_schema_version: 1,
            allowed_object_type_ids: mail.object_type_ids.clone(),
            required_capability_ids: mail.capability_ids.clone(),
            created_at: "2026-07-25T00:00:00Z".to_string(),
            updated_at: "2026-07-25T00:00:00Z".to_string(),
            created_by_device_id: "device-1".to_string(),
            updated_by_device_id: "device-1".to_string(),
        };
        registry.validate_collection_profile(&collection).unwrap();

        let mut foreign = collection;
        foreign.allowed_object_type_ids =
            vec![ObjectTypeId::custom("com.monica.bookmark.item").unwrap()];
        assert!(registry.validate_collection_profile(&foreign).is_err());
    }

    #[test]
    fn registry_profile_count_is_bounded_without_partial_registration() {
        let mut registry = ExtensionRegistry::default();
        for index in 0..MAX_REGISTERED_EXTENSION_PROFILES {
            registry
                .register(profile(&format!("com.example.extension{index}")))
                .unwrap();
        }
        let before = registry.list();

        let error = registry
            .register(profile("com.example.extensionoverflow"))
            .unwrap_err();
        assert!(matches!(error, StorageError::ResourceLimit { .. }));
        assert_eq!(registry.list(), before);
    }
}
