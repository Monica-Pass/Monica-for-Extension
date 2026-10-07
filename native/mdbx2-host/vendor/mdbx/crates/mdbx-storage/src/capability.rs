use serde::{Deserialize, Serialize};

use mdbx_sync::SyncCapabilityManifest;

pub const BUILD_CAPABILITY_MANIFEST_PROFILE_V1: &str = "mdbx-build-capabilities-v1";
pub const STORAGE_CAPABILITY_MANIFEST_PROFILE_V1: &str = "mdbx-storage-capabilities-v1";
pub const MAX_STORAGE_BUILD_CAPABILITIES: usize = 64;

const MANDATORY_STORAGE_CAPABILITIES: [&str; 18] = [
    "mdbx.storage.authenticated-encryption",
    "mdbx.storage.bounded-sync-state",
    "mdbx.storage.collection-profiles",
    "mdbx.storage.commit-history",
    "mdbx.storage.conflicts",
    "mdbx.storage.external-blob-lifecycle",
    "mdbx.storage.external-blob-references",
    "mdbx.storage.external-blob-replication",
    "mdbx.storage.external-blob-transfer",
    "mdbx.storage.generic-metadata",
    "mdbx.storage.generic-objects",
    "mdbx.storage.key-epochs",
    "mdbx.storage.mdbx1-compatibility",
    "mdbx.storage.payload-migrations",
    "mdbx.storage.recovery",
    "mdbx.storage.snapshots",
    "mdbx.storage.synchronization",
    "mdbx.storage.tiga-policy",
];

/// Compile-time capabilities present in the current MDBX build.
///
/// Security and compatibility invariants are intentionally absent from the
/// feature switch list: they are mandatory in every supported build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilitySet {
    pub mdbx1_compatibility: bool,
    pub authenticated_encryption: bool,
    pub tiga_policy: bool,
    pub key_epochs: bool,
    pub generic_objects: bool,
    pub generic_metadata: bool,
    pub collection_profiles: bool,
    pub payload_migrations: bool,
    pub commit_history: bool,
    pub conflicts: bool,
    pub snapshots: bool,
    pub recovery: bool,
    pub synchronization: bool,
    pub bounded_sync_state: bool,
    pub external_blob_references: bool,
    pub external_blob_lifecycle: bool,
    pub external_blob_transfer: bool,
    pub external_blob_replication: bool,
    pub filesystem_blob_store: bool,
    pub kdbx_import: bool,
    pub kdbx_export: bool,
    pub kdbx_binary_import: bool,
    pub kdbx_binary_export: bool,
    pub benchmarks: bool,
    pub derived_search_index: bool,
}

/// Stable storage capability inventory for one compiled MDBX library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StorageCapabilityManifest {
    pub profile: String,
    pub enabled_capability_ids: Vec<String>,
    pub disabled_optional_capability_ids: Vec<String>,
}

/// Combined build inventory exposed to clients before any vault is opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildCapabilityManifest {
    pub profile: String,
    pub engine_version: String,
    pub storage: StorageCapabilityManifest,
    pub synchronization: SyncCapabilityManifest,
}

impl CapabilitySet {
    /// Returns the capabilities compiled into this library.
    pub const fn current() -> Self {
        Self {
            mdbx1_compatibility: true,
            authenticated_encryption: true,
            tiga_policy: true,
            key_epochs: true,
            generic_objects: true,
            generic_metadata: true,
            collection_profiles: true,
            payload_migrations: true,
            commit_history: true,
            conflicts: true,
            snapshots: true,
            recovery: true,
            synchronization: true,
            bounded_sync_state: true,
            external_blob_references: true,
            external_blob_lifecycle: true,
            external_blob_transfer: true,
            external_blob_replication: true,
            filesystem_blob_store: cfg!(feature = "filesystem-blob-store"),
            kdbx_import: cfg!(feature = "kdbx-import"),
            kdbx_export: cfg!(feature = "kdbx-export"),
            kdbx_binary_import: cfg!(feature = "kdbx-binary-import"),
            kdbx_binary_export: cfg!(feature = "kdbx-binary-export"),
            benchmarks: cfg!(feature = "benchmarks"),
            derived_search_index: cfg!(feature = "derived-search-index"),
        }
    }

    pub fn storage_manifest(&self) -> StorageCapabilityManifest {
        let mut enabled_capability_ids = MANDATORY_STORAGE_CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_string())
            .collect::<Vec<_>>();
        let mut disabled_optional_capability_ids = Vec::new();

        let optional_capabilities = [
            ("mdbx.storage.benchmarks", self.benchmarks),
            (
                "mdbx.storage.derived-search-index",
                self.derived_search_index,
            ),
            (
                "mdbx.storage.filesystem-blob-store",
                self.filesystem_blob_store,
            ),
            ("mdbx.storage.kdbx-json-export", self.kdbx_export),
            ("mdbx.storage.kdbx-json-import", self.kdbx_import),
            ("mdbx.storage.kdbx-binary-export", self.kdbx_binary_export),
            ("mdbx.storage.kdbx-binary-import", self.kdbx_binary_import),
        ];
        for (capability, is_enabled) in optional_capabilities {
            if is_enabled {
                enabled_capability_ids.push(capability.to_string());
            } else {
                disabled_optional_capability_ids.push(capability.to_string());
            }
        }

        enabled_capability_ids.sort();
        enabled_capability_ids.dedup();
        disabled_optional_capability_ids.sort();
        disabled_optional_capability_ids.dedup();

        debug_assert!(enabled_capability_ids.len() <= MAX_STORAGE_BUILD_CAPABILITIES);
        debug_assert!(disabled_optional_capability_ids.len() <= MAX_STORAGE_BUILD_CAPABILITIES);

        StorageCapabilityManifest {
            profile: STORAGE_CAPABILITY_MANIFEST_PROFILE_V1.to_string(),
            enabled_capability_ids,
            disabled_optional_capability_ids,
        }
    }

    pub fn build_manifest(&self) -> BuildCapabilityManifest {
        BuildCapabilityManifest {
            profile: BUILD_CAPABILITY_MANIFEST_PROFILE_V1.to_string(),
            engine_version: env!("CARGO_PKG_VERSION").to_string(),
            storage: self.storage_manifest(),
            synchronization: SyncCapabilityManifest::current(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CapabilitySet, BUILD_CAPABILITY_MANIFEST_PROFILE_V1};
    use mdbx_sync::CAPABILITY_AUTHENTICATED_STATE_ROOT_V1;

    #[test]
    fn mandatory_database_invariants_are_present_in_every_build() {
        let capabilities = CapabilitySet::current();
        assert!(capabilities.mdbx1_compatibility);
        assert!(capabilities.authenticated_encryption);
        assert!(capabilities.tiga_policy);
        assert!(capabilities.key_epochs);
        assert!(capabilities.generic_objects);
        assert!(capabilities.generic_metadata);
        assert!(capabilities.collection_profiles);
        assert!(capabilities.payload_migrations);
        assert!(capabilities.commit_history);
        assert!(capabilities.conflicts);
        assert!(capabilities.snapshots);
        assert!(capabilities.recovery);
        assert!(capabilities.synchronization);
        assert!(capabilities.bounded_sync_state);
        assert!(capabilities.external_blob_references);
        assert!(capabilities.external_blob_lifecycle);
        assert!(capabilities.external_blob_transfer);
        assert!(capabilities.external_blob_replication);
    }

    #[test]
    fn optional_capabilities_match_cargo_features() {
        let capabilities = CapabilitySet::current();
        assert_eq!(
            capabilities.filesystem_blob_store,
            cfg!(feature = "filesystem-blob-store")
        );
        assert_eq!(capabilities.kdbx_import, cfg!(feature = "kdbx-import"));
        assert_eq!(capabilities.kdbx_export, cfg!(feature = "kdbx-export"));
        assert_eq!(
            capabilities.kdbx_binary_import,
            cfg!(feature = "kdbx-binary-import")
        );
        assert_eq!(
            capabilities.kdbx_binary_export,
            cfg!(feature = "kdbx-binary-export")
        );
        assert_eq!(capabilities.benchmarks, cfg!(feature = "benchmarks"));
        assert_eq!(
            capabilities.derived_search_index,
            cfg!(feature = "derived-search-index")
        );
    }

    #[test]
    fn build_capability_manifest_is_canonical_and_matches_features() {
        let manifest = CapabilitySet::current().build_manifest();
        assert_eq!(manifest.profile, BUILD_CAPABILITY_MANIFEST_PROFILE_V1);
        assert_eq!(manifest.engine_version, env!("CARGO_PKG_VERSION"));
        assert!(manifest
            .storage
            .enabled_capability_ids
            .contains(&"mdbx.storage.mdbx1-compatibility".to_string()));
        assert!(manifest
            .synchronization
            .enabled_capability_ids
            .contains(&CAPABILITY_AUTHENTICATED_STATE_ROOT_V1.to_string()));

        let mut sorted = manifest.storage.enabled_capability_ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(manifest.storage.enabled_capability_ids, sorted);
        assert_eq!(
            manifest
                .storage
                .enabled_capability_ids
                .contains(&"mdbx.storage.kdbx-json-import".to_string()),
            cfg!(feature = "kdbx-import")
        );
        assert_eq!(
            manifest
                .storage
                .disabled_optional_capability_ids
                .contains(&"mdbx.storage.kdbx-json-import".to_string()),
            !cfg!(feature = "kdbx-import")
        );
        assert_eq!(
            manifest
                .storage
                .enabled_capability_ids
                .contains(&"mdbx.storage.kdbx-binary-export".to_string()),
            cfg!(feature = "kdbx-binary-export")
        );
    }
}
