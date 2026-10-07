use mdbx_core::model::{
    CollectionProfile, CollectionTypeId, ExtensionCapabilityId, ExtensionFeatureId, ExtensionId,
    ExtensionProfile, PayloadMigrationOutput,
};
use mdbx_storage::extension_registry::ExtensionRegistration;
use mdbx_storage::repo::{
    CollectionProfileRepo, CollectionProfileSpec, CommitContext, PayloadMigrationPlanRequest,
    PayloadMigrationRepo,
};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxExtensionProfile {
    pub extension_id: String,
    pub profile_version: u32,
    pub collection_type_ids: Vec<String>,
    pub object_type_ids: Vec<String>,
    pub relation_kind_ids: Vec<String>,
    pub capability_ids: Vec<String>,
    pub optional_index_ids: Vec<String>,
    pub import_adapter_ids: Vec<String>,
    pub export_adapter_ids: Vec<String>,
    pub presentation_hint_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MdbxExtensionRegistration {
    Registered,
    AlreadyRegistered,
}
use mdbx_storage::tiga_policy::TigaAuthorizationContext;

use super::{
    conservative_ffi_device_context, parse_object_type_id, parse_relation_kind, unix_now,
    MdbxCollectionProfile, MdbxDeviceContext, MdbxFfiError, MdbxPayloadMigrationExecution,
    MdbxPayloadMigrationOutput, MdbxPayloadMigrationPlan, MdbxVault,
};

#[uniffi::export]
impl MdbxVault {
    pub fn register_extension_profile(
        &self,
        profile: MdbxExtensionProfile,
    ) -> Result<MdbxExtensionRegistration, MdbxFfiError> {
        let profile = extension_profile_into_core(profile)?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(registration_from_core(
            conn.register_extension_profile(profile)?,
        ))
    }

    pub fn replace_extension_profiles(
        &self,
        profiles: Vec<MdbxExtensionProfile>,
    ) -> Result<(), MdbxFfiError> {
        let profiles = profiles
            .into_iter()
            .map(extension_profile_into_core)
            .collect::<Result<Vec<_>, _>>()?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        conn.replace_extension_profiles(profiles)?;
        Ok(())
    }

    pub fn get_extension_profile(
        &self,
        extension_id: String,
    ) -> Result<Option<MdbxExtensionProfile>, MdbxFfiError> {
        let extension_id = parse_extension_id(&extension_id)?;
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(conn
            .extension_profile(&extension_id)
            .cloned()
            .map(extension_profile_from_core))
    }

    pub fn list_extension_profiles(&self) -> Result<Vec<MdbxExtensionProfile>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(conn
            .extension_profiles()
            .into_iter()
            .map(extension_profile_from_core)
            .collect())
    }

    pub fn unregister_extension_profile(
        &self,
        extension_id: String,
    ) -> Result<Option<MdbxExtensionProfile>, MdbxFfiError> {
        let extension_id = parse_extension_id(&extension_id)?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(conn
            .unregister_extension_profile(&extension_id)
            .map(extension_profile_from_core))
    }

    pub fn set_extension_capabilities(
        &self,
        capability_ids: Vec<String>,
    ) -> Result<(), MdbxFfiError> {
        let capabilities = capability_ids
            .iter()
            .map(|capability_id| parse_extension_capability_id(capability_id))
            .collect::<Result<Vec<_>, _>>()?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        conn.set_extension_capabilities(capabilities);
        Ok(())
    }

    pub fn get_collection_profile(
        &self,
        collection_id: String,
    ) -> Result<Option<MdbxCollectionProfile>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(
            CollectionProfileRepo::get_by_collection_id(&conn, &collection_id)?
                .map(collection_profile_from_core),
        )
    }

    pub fn set_collection_profile(
        &self,
        collection_id: String,
        collection_type_id: String,
        payload: Vec<u8>,
        payload_schema_version: u32,
        allowed_object_type_ids: Vec<String>,
        required_capability_ids: Vec<String>,
    ) -> Result<MdbxCollectionProfile, MdbxFfiError> {
        let allowed_object_type_ids = allowed_object_type_ids
            .iter()
            .map(|object_type_id| parse_object_type_id(object_type_id))
            .collect::<Result<Vec<_>, _>>()?;
        let required_capability_ids = required_capability_ids
            .iter()
            .map(|capability_id| parse_extension_capability_id(capability_id))
            .collect::<Result<Vec<_>, _>>()?;
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let ctx = CommitContext::new(self.device_id.clone());
        let profile = CollectionProfileRepo::set(
            &conn,
            &ctx,
            CollectionProfileSpec {
                collection_id,
                collection_type_id: parse_collection_type_id(&collection_type_id)?,
                payload,
                payload_schema_version,
                allowed_object_type_ids,
                required_capability_ids,
            },
        )?;
        Ok(collection_profile_from_core(profile))
    }

    /// Build a bounded Adapter payload migration plan through the active vault
    /// session and a conservative Standard device context. Tiga authorization
    /// precedes loading or decrypting the returned source payload bytes.
    pub fn create_payload_migration_plan(
        &self,
        collection_id: String,
        object_type_id: String,
        source_schema_version: u32,
        target_schema_version: u32,
        max_items: u32,
        branch_id: Option<String>,
    ) -> Result<MdbxPayloadMigrationPlan, MdbxFfiError> {
        self.create_payload_migration_plan_with_device_context(
            collection_id,
            object_type_id,
            source_schema_version,
            target_schema_version,
            max_items,
            branch_id,
            conservative_ffi_device_context(),
        )
    }

    /// Build a migration plan with the caller's real device assurance. The
    /// active session must satisfy the Collection's MigratePayload policy.
    #[allow(clippy::too_many_arguments)]
    pub fn create_payload_migration_plan_with_device_context(
        &self,
        collection_id: String,
        object_type_id: String,
        source_schema_version: u32,
        target_schema_version: u32,
        max_items: u32,
        branch_id: Option<String>,
        device: MdbxDeviceContext,
    ) -> Result<MdbxPayloadMigrationPlan, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let context = TigaAuthorizationContext {
            session: session.as_ref(),
            device: &device,
            now_unix_secs: unix_now(),
        };
        Ok(PayloadMigrationRepo::create_plan_authorized(
            &conn,
            PayloadMigrationPlanRequest {
                collection_id,
                object_type_id: parse_object_type_id(&object_type_id)?,
                source_schema_version,
                target_schema_version,
                max_items: max_items as usize,
                branch_id,
            },
            context,
        )?
        .0
        .into())
    }

    /// Apply Adapter-produced payloads as one Tiga-authorized, idempotent user
    /// operation using the conservative Standard device context.
    pub fn execute_payload_migration(
        &self,
        plan: MdbxPayloadMigrationPlan,
        outputs: Vec<MdbxPayloadMigrationOutput>,
    ) -> Result<MdbxPayloadMigrationExecution, MdbxFfiError> {
        self.execute_payload_migration_with_device_context(
            plan,
            outputs,
            conservative_ffi_device_context(),
        )
    }

    /// Reauthorize and apply a migration with the caller's real device
    /// assurance. Binding checks, one commit, audit, and sync delta are atomic.
    pub fn execute_payload_migration_with_device_context(
        &self,
        plan: MdbxPayloadMigrationPlan,
        outputs: Vec<MdbxPayloadMigrationOutput>,
        device: MdbxDeviceContext,
    ) -> Result<MdbxPayloadMigrationExecution, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let plan = plan.into_core()?;
        let outputs = outputs
            .into_iter()
            .map(|output| PayloadMigrationOutput {
                object_id: output.object_id,
                target_payload: output.target_payload,
            })
            .collect::<Vec<_>>();
        let ctx = CommitContext::new(self.device_id.clone());
        let session = conn.active_session().cloned();
        let device = device.into_core(&self.device_id);
        let context = TigaAuthorizationContext {
            session: session.as_ref(),
            device: &device,
            now_unix_secs: unix_now(),
        };
        Ok(
            PayloadMigrationRepo::execute_authorized(&conn, &ctx, &plan, &outputs, context)?
                .0
                .into(),
        )
    }
}

fn extension_profile_into_core(
    profile: MdbxExtensionProfile,
) -> Result<ExtensionProfile, MdbxFfiError> {
    let object_type_ids = profile
        .object_type_ids
        .iter()
        .map(|value| {
            let object_type = parse_object_type_id(value)?;
            if object_type.is_legacy() {
                return Err(MdbxFfiError::InvalidEntryType {
                    entry_type: value.clone(),
                });
            }
            Ok(object_type)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ExtensionProfile {
        extension_id: parse_extension_id(&profile.extension_id)?,
        profile_version: profile.profile_version,
        collection_type_ids: profile
            .collection_type_ids
            .iter()
            .map(|value| parse_collection_type_id(value))
            .collect::<Result<Vec<_>, _>>()?,
        object_type_ids,
        relation_kind_ids: profile
            .relation_kind_ids
            .iter()
            .map(|value| parse_relation_kind(value))
            .collect::<Result<Vec<_>, _>>()?,
        capability_ids: profile
            .capability_ids
            .iter()
            .map(|value| parse_extension_capability_id(value))
            .collect::<Result<Vec<_>, _>>()?,
        optional_index_ids: profile
            .optional_index_ids
            .iter()
            .map(|value| parse_extension_feature_id(value))
            .collect::<Result<Vec<_>, _>>()?,
        import_adapter_ids: profile
            .import_adapter_ids
            .iter()
            .map(|value| parse_extension_feature_id(value))
            .collect::<Result<Vec<_>, _>>()?,
        export_adapter_ids: profile
            .export_adapter_ids
            .iter()
            .map(|value| parse_extension_feature_id(value))
            .collect::<Result<Vec<_>, _>>()?,
        presentation_hint_ids: profile
            .presentation_hint_ids
            .iter()
            .map(|value| parse_extension_feature_id(value))
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn extension_profile_from_core(profile: ExtensionProfile) -> MdbxExtensionProfile {
    MdbxExtensionProfile {
        extension_id: profile.extension_id.to_string(),
        profile_version: profile.profile_version,
        collection_type_ids: profile
            .collection_type_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        object_type_ids: profile
            .object_type_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        relation_kind_ids: profile
            .relation_kind_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        capability_ids: profile
            .capability_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        optional_index_ids: profile
            .optional_index_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        import_adapter_ids: profile
            .import_adapter_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        export_adapter_ids: profile
            .export_adapter_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
        presentation_hint_ids: profile
            .presentation_hint_ids
            .into_iter()
            .map(|value| value.to_string())
            .collect(),
    }
}

fn registration_from_core(value: ExtensionRegistration) -> MdbxExtensionRegistration {
    match value {
        ExtensionRegistration::Registered => MdbxExtensionRegistration::Registered,
        ExtensionRegistration::AlreadyRegistered => MdbxExtensionRegistration::AlreadyRegistered,
    }
}

fn parse_extension_id(value: &str) -> Result<ExtensionId, MdbxFfiError> {
    value.parse().map_err(|_| MdbxFfiError::InvalidExtensionId {
        extension_id: value.to_string(),
    })
}

fn parse_extension_feature_id(value: &str) -> Result<ExtensionFeatureId, MdbxFfiError> {
    value
        .parse()
        .map_err(|_| MdbxFfiError::InvalidExtensionFeatureId {
            feature_id: value.to_string(),
        })
}

fn parse_collection_type_id(collection_type_id: &str) -> Result<CollectionTypeId, MdbxFfiError> {
    collection_type_id
        .parse()
        .map_err(|_| MdbxFfiError::InvalidCollectionTypeId {
            collection_type_id: collection_type_id.to_string(),
        })
}

fn parse_extension_capability_id(
    capability_id: &str,
) -> Result<ExtensionCapabilityId, MdbxFfiError> {
    capability_id
        .parse()
        .map_err(|_| MdbxFfiError::InvalidExtensionCapabilityId {
            capability_id: capability_id.to_string(),
        })
}

fn collection_profile_from_core(profile: CollectionProfile) -> MdbxCollectionProfile {
    MdbxCollectionProfile {
        collection_id: profile.collection_id,
        collection_type_id: profile.collection_type_id.to_string(),
        payload: profile.payload_ct,
        payload_schema_version: profile.payload_schema_version,
        allowed_object_type_ids: profile
            .allowed_object_type_ids
            .into_iter()
            .map(|object_type| object_type.to_string())
            .collect(),
        required_capability_ids: profile
            .required_capability_ids
            .into_iter()
            .map(|capability| capability.to_string())
            .collect(),
        created_at: profile.created_at,
        updated_at: profile.updated_at,
        created_by_device_id: profile.created_by_device_id,
        updated_by_device_id: profile.updated_by_device_id,
    }
}
