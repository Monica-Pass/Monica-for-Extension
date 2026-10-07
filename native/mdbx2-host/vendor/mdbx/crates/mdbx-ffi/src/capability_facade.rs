use mdbx_storage::capability::CapabilitySet;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxBuildCapabilityManifest {
    pub profile: String,
    pub engine_version: String,
    pub storage_profile: String,
    pub enabled_storage_capability_ids: Vec<String>,
    pub disabled_optional_storage_capability_ids: Vec<String>,
    pub sync_profile: String,
    pub sync_protocol_version: u32,
    pub enabled_sync_capability_ids: Vec<String>,
    pub disabled_optional_sync_capability_ids: Vec<String>,
}

/// Describes the modules compiled into this library without opening a vault.
/// This is discovery metadata, not Adapter authority or sync negotiation.
#[uniffi::export]
pub fn mdbx_build_capability_manifest() -> MdbxBuildCapabilityManifest {
    let manifest = CapabilitySet::current().build_manifest();
    MdbxBuildCapabilityManifest {
        profile: manifest.profile,
        engine_version: manifest.engine_version,
        storage_profile: manifest.storage.profile,
        enabled_storage_capability_ids: manifest.storage.enabled_capability_ids,
        disabled_optional_storage_capability_ids: manifest.storage.disabled_optional_capability_ids,
        sync_profile: manifest.synchronization.profile,
        sync_protocol_version: manifest.synchronization.protocol_version,
        enabled_sync_capability_ids: manifest.synchronization.enabled_capability_ids,
        disabled_optional_sync_capability_ids: manifest
            .synchronization
            .disabled_optional_capability_ids,
    }
}
