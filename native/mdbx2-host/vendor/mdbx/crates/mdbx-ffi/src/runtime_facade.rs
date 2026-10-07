use mdbx_storage::migration::{FORMAT_V1, FORMAT_V1_DRAFT, FORMAT_V2};
use mdbx_storage::schema::SCHEMA_VERSION;

pub const MDBX_RUNTIME_MANIFEST_PROFILE_V1: &str = "mdbx-runtime-manifest-v1";
pub const MDBX_RUNTIME_NAME: &str = "MDBX3";
pub const MDBX_RUNTIME_VERSION: &str = "3.0.0-alpha.1";
pub const MDBX_RUNTIME_BUILD_PROFILE_V1: &str = "mdbx3-ffi-compatible-v1";
pub const MDBX_FFI_ABI_PROFILE_V1: &str = "mdbx-ffi-abi-v1";
pub const MDBX_FFI_NAMESPACE: &str = "mdbx_ffi";
pub const MDBX_NATIVE_LIBRARY_NAME: &str = "mdbx_ffi";
pub const MDBX_ANDROID_SHARED_OBJECT_NAME: &str = "libmdbx_ffi.so";
pub const MDBX_MDBX2_DROP_IN_PROFILE_V1: &str = "mdbx3-mdbx2-drop-in-v1";

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxRuntimeManifest {
    pub profile: String,
    pub runtime_name: String,
    pub runtime_version: String,
    pub implementation_version: String,
    pub build_profile: String,
    pub storage_format: String,
    pub current_schema_version: u32,
    pub readable_storage_formats: Vec<String>,
    pub writable_storage_format: String,
    pub ffi_abi_profile: String,
    pub ffi_namespace: String,
    pub native_library_name: String,
    pub android_shared_object_name: String,
    pub compatibility_profile: String,
}

/// Describes the MDBX3 runtime identity without opening or modifying a vault.
/// Existing MDBX2 bindings do not depend on this additive discovery method.
#[uniffi::export]
pub fn mdbx_runtime_manifest() -> MdbxRuntimeManifest {
    MdbxRuntimeManifest {
        profile: MDBX_RUNTIME_MANIFEST_PROFILE_V1.to_string(),
        runtime_name: MDBX_RUNTIME_NAME.to_string(),
        runtime_version: MDBX_RUNTIME_VERSION.to_string(),
        implementation_version: env!("CARGO_PKG_VERSION").to_string(),
        build_profile: MDBX_RUNTIME_BUILD_PROFILE_V1.to_string(),
        storage_format: FORMAT_V2.to_string(),
        current_schema_version: SCHEMA_VERSION,
        readable_storage_formats: vec![
            FORMAT_V1.to_string(),
            FORMAT_V1_DRAFT.to_string(),
            FORMAT_V2.to_string(),
        ],
        writable_storage_format: FORMAT_V2.to_string(),
        ffi_abi_profile: MDBX_FFI_ABI_PROFILE_V1.to_string(),
        ffi_namespace: MDBX_FFI_NAMESPACE.to_string(),
        native_library_name: MDBX_NATIVE_LIBRARY_NAME.to_string(),
        android_shared_object_name: MDBX_ANDROID_SHARED_OBJECT_NAME.to_string(),
        compatibility_profile: MDBX_MDBX2_DROP_IN_PROFILE_V1.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_manifest_freezes_mdbx3_identity_and_mdbx2_storage() {
        let manifest = mdbx_runtime_manifest();

        assert_eq!(manifest.profile, MDBX_RUNTIME_MANIFEST_PROFILE_V1);
        assert_eq!(manifest.runtime_name, MDBX_RUNTIME_NAME);
        assert_eq!(manifest.runtime_version, MDBX_RUNTIME_VERSION);
        assert!(manifest.runtime_version.starts_with("3."));
        assert_eq!(manifest.implementation_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(manifest.build_profile, MDBX_RUNTIME_BUILD_PROFILE_V1);
        assert_eq!(manifest.storage_format, FORMAT_V2);
        assert_eq!(manifest.current_schema_version, SCHEMA_VERSION);
        assert_eq!(
            manifest.readable_storage_formats,
            vec![FORMAT_V1, FORMAT_V1_DRAFT, FORMAT_V2]
        );
        assert_eq!(manifest.writable_storage_format, FORMAT_V2);
        assert_eq!(manifest.ffi_abi_profile, MDBX_FFI_ABI_PROFILE_V1);
        assert_eq!(manifest.ffi_namespace, MDBX_FFI_NAMESPACE);
        assert_eq!(manifest.native_library_name, MDBX_NATIVE_LIBRARY_NAME);
        assert_eq!(
            manifest.android_shared_object_name,
            MDBX_ANDROID_SHARED_OBJECT_NAME
        );
        assert_eq!(
            manifest.compatibility_profile,
            MDBX_MDBX2_DROP_IN_PROFILE_V1
        );
    }
}
