//! Generic UniFFI boundary for MDBX vault clients.
//!
//! This crate exposes vault, generic object, metadata, and attachment
//! operations. Product-specific payload meaning belongs in each client.

mod attachment_facade;
mod attachment_summary_facade;
mod capability_facade;
mod collection_facade;
mod conflict_facade;
mod extension_facade;
mod history_action_facade;
mod history_facade;
mod integrity_root_facade;
mod lifecycle_facade;
mod object_facade;
mod runtime_facade;
mod security_facade;
mod snapshot_lifecycle_facade;
mod snapshot_management_facade;
mod snapshot_summary_facade;
mod sync_facade;
mod vault_facade;
mod write_facade;

pub use attachment_facade::*;
pub use attachment_summary_facade::*;
pub use capability_facade::*;
pub use collection_facade::*;
pub use conflict_facade::*;
pub use extension_facade::*;
pub use history_action_facade::*;
pub use history_facade::*;
pub use integrity_root_facade::*;
pub use lifecycle_facade::*;
pub use object_facade::*;
pub(crate) use object_facade::{parse_object_type_id, parse_payload_json, parse_relation_kind};
pub use runtime_facade::*;
#[cfg(test)]
pub(crate) use security_facade::scope_from_core;
pub use security_facade::*;
pub(crate) use security_facade::{conservative_ffi_device_context, unix_now};
pub use snapshot_lifecycle_facade::*;
pub use snapshot_management_facade::*;
pub use snapshot_summary_facade::*;
pub use sync_facade::*;
pub use vault_facade::*;
pub(crate) use write_facade::validate_uuid;
pub use write_facade::*;
#[cfg(test)]
pub(crate) use write_facade::{
    DEFAULT_MAX_WRITE_COMMANDS, DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND,
    HARD_MAX_WRITE_COMMANDS,
};

#[cfg(test)]
use mdbx_core::model::RelationKindId;
#[cfg(test)]
use mdbx_core::tiga::{TigaMode, TigaScope};
use mdbx_storage::error::StorageError;
use mdbx_storage::runtime::VaultRuntime;
#[cfg(test)]
use uuid::Uuid;

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum MdbxFfiError {
    #[error("storage error: {message}")]
    Storage { message: String },
    #[error("serialization error: {message}")]
    Serialization { message: String },
    #[error("sync protocol error: {message}")]
    SyncProtocol { message: String },
    #[error("invalid entry type: {entry_type}")]
    InvalidEntryType { entry_type: String },
    #[error("invalid object type ID: {object_type_id}")]
    InvalidObjectTypeId { object_type_id: String },
    #[error("invalid relation kind: {relation_kind}")]
    InvalidRelationKind { relation_kind: String },
    #[error("invalid collection type ID: {collection_type_id}")]
    InvalidCollectionTypeId { collection_type_id: String },
    #[error("invalid extension capability ID: {capability_id}")]
    InvalidExtensionCapabilityId { capability_id: String },
    #[error("vault lock poisoned")]
    LockPoisoned,
    #[error("invalid conflict object type: {object_type}")]
    InvalidConflictObjectType { object_type: String },
    #[error("invalid extension ID: {extension_id}")]
    InvalidExtensionId { extension_id: String },
    #[error("invalid extension feature ID: {feature_id}")]
    InvalidExtensionFeatureId { feature_id: String },
}

impl From<StorageError> for MdbxFfiError {
    fn from(value: StorageError) -> Self {
        MdbxFfiError::Storage {
            message: value.to_string(),
        }
    }
}

impl From<serde_json::Error> for MdbxFfiError {
    fn from(value: serde_json::Error) -> Self {
        MdbxFfiError::Serialization {
            message: value.to_string(),
        }
    }
}

impl From<mdbx_sync::SyncError> for MdbxFfiError {
    fn from(value: mdbx_sync::SyncError) -> Self {
        MdbxFfiError::SyncProtocol {
            message: value.to_string(),
        }
    }
}

#[derive(uniffi::Object)]
pub struct MdbxVault {
    pub(crate) conn: VaultRuntime,
    device_id: String,
    vault_id: String,
}

#[cfg(test)]
mod tests;
