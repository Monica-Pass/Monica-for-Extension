use mdbx_ffi::{mdbx_build_capability_manifest, mdbx_runtime_manifest};
use serde_json::json;

fn main() {
    let runtime = mdbx_runtime_manifest();
    let capabilities = mdbx_build_capability_manifest();
    let manifest = json!({
        "profile": "mdbx3-build-report-input-v1",
        "runtime": {
            "profile": runtime.profile,
            "runtime_name": runtime.runtime_name,
            "runtime_version": runtime.runtime_version,
            "implementation_version": runtime.implementation_version,
            "build_profile": runtime.build_profile,
            "storage_format": runtime.storage_format,
            "current_schema_version": runtime.current_schema_version,
            "readable_storage_formats": runtime.readable_storage_formats,
            "writable_storage_format": runtime.writable_storage_format,
            "ffi_abi_profile": runtime.ffi_abi_profile,
            "ffi_namespace": runtime.ffi_namespace,
            "native_library_name": runtime.native_library_name,
            "android_shared_object_name": runtime.android_shared_object_name,
            "compatibility_profile": runtime.compatibility_profile,
        },
        "capabilities": {
            "profile": capabilities.profile,
            "engine_version": capabilities.engine_version,
            "storage_profile": capabilities.storage_profile,
            "enabled_storage_capability_ids": capabilities.enabled_storage_capability_ids,
            "disabled_optional_storage_capability_ids": capabilities.disabled_optional_storage_capability_ids,
            "sync_profile": capabilities.sync_profile,
            "sync_protocol_version": capabilities.sync_protocol_version,
            "enabled_sync_capability_ids": capabilities.enabled_sync_capability_ids,
            "disabled_optional_sync_capability_ids": capabilities.disabled_optional_sync_capability_ids,
        },
    });

    println!(
        "{}",
        serde_json::to_string_pretty(&manifest).expect("serialize MDBX3 build manifest")
    );
}
