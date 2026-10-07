use serde::{Deserialize, Serialize};

use crate::message::{
    CAPABILITY_AUTHENTICATED_BUNDLE_V1, CAPABILITY_AUTHENTICATED_STATE_ROOT_V1,
    CAPABILITY_BLOB_CHUNK_TRANSFER_V1, CAPABILITY_BLOB_MANIFEST_PAGING_V1,
    CAPABILITY_BLOB_TRANSFER_RESUME_V1, CAPABILITY_COMMIT_INVENTORY_PAGING_V1,
    CAPABILITY_DELTA_INVENTORY_PAGING_V1, CAPABILITY_INCREMENTAL_BUNDLE_V4,
    CAPABILITY_INCREMENTAL_RESUME_V1, CAPABILITY_ZSTD_BUNDLE_V1, PROTOCOL_VERSION,
};

pub const SYNC_CAPABILITY_MANIFEST_PROFILE_V1: &str = "mdbx-sync-capabilities-v1";
pub const MAX_SYNC_BUILD_CAPABILITIES: usize = 32;

const ALWAYS_AVAILABLE_SYNC_CAPABILITIES: [&str; 9] = [
    CAPABILITY_AUTHENTICATED_BUNDLE_V1,
    CAPABILITY_AUTHENTICATED_STATE_ROOT_V1,
    CAPABILITY_BLOB_CHUNK_TRANSFER_V1,
    CAPABILITY_BLOB_MANIFEST_PAGING_V1,
    CAPABILITY_BLOB_TRANSFER_RESUME_V1,
    CAPABILITY_COMMIT_INVENTORY_PAGING_V1,
    CAPABILITY_DELTA_INVENTORY_PAGING_V1,
    CAPABILITY_INCREMENTAL_BUNDLE_V4,
    CAPABILITY_INCREMENTAL_RESUME_V1,
];

const OPTIONAL_SYNC_CAPABILITIES: [&str; 1] = [CAPABILITY_ZSTD_BUNDLE_V1];

/// Read-only description of synchronization features compiled into this crate.
/// It does not advertise capabilities to a peer or negotiate a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncCapabilityManifest {
    pub profile: String,
    pub protocol_version: u32,
    pub enabled_capability_ids: Vec<String>,
    pub disabled_optional_capability_ids: Vec<String>,
}

impl SyncCapabilityManifest {
    pub fn current() -> Self {
        let mut enabled_capability_ids = ALWAYS_AVAILABLE_SYNC_CAPABILITIES
            .iter()
            .map(|capability| (*capability).to_string())
            .collect::<Vec<_>>();
        let mut disabled_optional_capability_ids = Vec::new();

        for capability in OPTIONAL_SYNC_CAPABILITIES {
            if capability == CAPABILITY_ZSTD_BUNDLE_V1 && cfg!(feature = "zstd-compression") {
                enabled_capability_ids.push(capability.to_string());
            } else {
                disabled_optional_capability_ids.push(capability.to_string());
            }
        }

        enabled_capability_ids.sort();
        enabled_capability_ids.dedup();
        disabled_optional_capability_ids.sort();
        disabled_optional_capability_ids.dedup();

        debug_assert!(enabled_capability_ids.len() <= MAX_SYNC_BUILD_CAPABILITIES);
        debug_assert!(disabled_optional_capability_ids.len() <= MAX_SYNC_BUILD_CAPABILITIES);

        Self {
            profile: SYNC_CAPABILITY_MANIFEST_PROFILE_V1.to_string(),
            protocol_version: PROTOCOL_VERSION,
            enabled_capability_ids,
            disabled_optional_capability_ids,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_sync_capability_manifest_is_canonical_and_matches_codec_feature() {
        let manifest = SyncCapabilityManifest::current();
        assert_eq!(manifest.profile, SYNC_CAPABILITY_MANIFEST_PROFILE_V1);
        assert_eq!(manifest.protocol_version, PROTOCOL_VERSION);
        assert!(manifest
            .enabled_capability_ids
            .contains(&CAPABILITY_AUTHENTICATED_STATE_ROOT_V1.to_string()));

        let mut sorted = manifest.enabled_capability_ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(manifest.enabled_capability_ids, sorted);
        assert_eq!(
            manifest
                .enabled_capability_ids
                .contains(&CAPABILITY_ZSTD_BUNDLE_V1.to_string()),
            cfg!(feature = "zstd-compression")
        );
        assert_eq!(
            manifest
                .disabled_optional_capability_ids
                .contains(&CAPABILITY_ZSTD_BUNDLE_V1.to_string()),
            !cfg!(feature = "zstd-compression")
        );
    }
}
