#[derive(Debug, Clone, uniffi::Record)]
pub struct ProjectRecord {
    pub project_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxCollectionProfile {
    pub collection_id: String,
    pub collection_type_id: String,
    pub payload: Vec<u8>,
    pub payload_schema_version: u32,
    pub allowed_object_type_ids: Vec<String>,
    pub required_capability_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: String,
    pub updated_by_device_id: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct EntryRecord {
    pub entry_id: String,
    pub project_id: String,
    pub entry_type: String,
    pub title: String,
    pub payload_json: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectRecord {
    pub object_id: String,
    pub collection_id: String,
    pub object_type_id: String,
    pub title: String,
    pub payload_json: String,
    pub payload_schema_version: u32,
    pub deleted: bool,
}

/// Resource contract for one policy-authorized object payload disclosure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectDisclosureLimits {
    pub max_payload_bytes: u64,
}

#[uniffi::export]
pub fn default_object_disclosure_limits() -> MdbxObjectDisclosureLimits {
    MdbxObjectDisclosureLimits {
        max_payload_bytes: ObjectDisclosureLimits::default().max_payload_bytes(),
    }
}

/// Resource contract shared by policy-authorized relation and label payload disclosure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectMetadataDisclosureLimits {
    pub max_payload_bytes: u64,
}

#[uniffi::export]
pub fn default_object_metadata_disclosure_limits() -> MdbxObjectMetadataDisclosureLimits {
    MdbxObjectMetadataDisclosureLimits {
        max_payload_bytes: ObjectMetadataDisclosureLimits::default().max_payload_bytes(),
    }
}

/// Typed result of a Tiga-controlled object reveal.
///
/// `object` is present only for Allow or AllowWithConstraints decisions.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectDisclosureResult {
    pub object: Option<MdbxObjectRecord>,
    pub authorization: MdbxAuthorizationDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxPayloadMigrationPlanItem {
    pub object_id: String,
    pub object_head_commit_id: String,
    pub source_payload_digest: Vec<u8>,
    pub source_payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxPayloadMigrationPlan {
    pub plan_id: String,
    pub collection_id: String,
    pub object_type_id: String,
    pub source_schema_version: u32,
    pub target_schema_version: u32,
    pub branch_id: String,
    pub branch_name: String,
    pub branch_head_commit_id: String,
    pub collection_profile_digest: Option<Vec<u8>>,
    pub items: Vec<MdbxPayloadMigrationPlanItem>,
    pub remaining_count: u64,
    pub total_source_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxPayloadMigrationOutput {
    pub object_id: String,
    pub target_payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxPayloadMigrationExecution {
    pub commit_id: String,
    pub migrated_count: u32,
    pub already_committed: bool,
}

impl From<PayloadMigrationPlanItem> for MdbxPayloadMigrationPlanItem {
    fn from(value: PayloadMigrationPlanItem) -> Self {
        Self {
            object_id: value.object_id,
            object_head_commit_id: value.object_head_commit_id,
            source_payload_digest: value.source_payload_digest,
            source_payload: value.source_payload,
        }
    }
}

impl From<PayloadMigrationPlan> for MdbxPayloadMigrationPlan {
    fn from(value: PayloadMigrationPlan) -> Self {
        Self {
            plan_id: value.plan_id,
            collection_id: value.collection_id,
            object_type_id: value.object_type_id.to_string(),
            source_schema_version: value.source_schema_version,
            target_schema_version: value.target_schema_version,
            branch_id: value.branch_id,
            branch_name: value.branch_name,
            branch_head_commit_id: value.branch_head_commit_id,
            collection_profile_digest: value.collection_profile_digest,
            items: value.items.into_iter().map(Into::into).collect(),
            remaining_count: value.remaining_count,
            total_source_bytes: value.total_source_bytes,
        }
    }
}

impl MdbxPayloadMigrationPlan {
    pub(crate) fn into_core(self) -> Result<PayloadMigrationPlan, MdbxFfiError> {
        Ok(PayloadMigrationPlan {
            plan_id: self.plan_id,
            collection_id: self.collection_id,
            object_type_id: parse_object_type_id(&self.object_type_id)?,
            source_schema_version: self.source_schema_version,
            target_schema_version: self.target_schema_version,
            branch_id: self.branch_id,
            branch_name: self.branch_name,
            branch_head_commit_id: self.branch_head_commit_id,
            collection_profile_digest: self.collection_profile_digest,
            items: self
                .items
                .into_iter()
                .map(|item| PayloadMigrationPlanItem {
                    object_id: item.object_id,
                    object_head_commit_id: item.object_head_commit_id,
                    source_payload_digest: item.source_payload_digest,
                    source_payload: item.source_payload,
                })
                .collect(),
            remaining_count: self.remaining_count,
            total_source_bytes: self.total_source_bytes,
        })
    }
}

impl From<PayloadMigrationExecution> for MdbxPayloadMigrationExecution {
    fn from(value: PayloadMigrationExecution) -> Self {
        Self {
            commit_id: value.commit_id,
            migrated_count: value.migrated_count,
            already_committed: value.already_committed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectSummary {
    pub object_id: String,
    pub collection_id: String,
    pub object_type_id: String,
    pub title: String,
    pub payload_schema_version: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectSummaryPage {
    pub items: Vec<MdbxObjectSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectRelationRecord {
    pub relation_id: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub relation_kind: String,
    pub payload_json: String,
    pub payload_schema_version: u32,
    pub deleted: bool,
}

/// Typed dual-scope result. `relation` is absent unless both Entry scopes allow disclosure.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectRelationDisclosureResult {
    pub relation: Option<MdbxObjectRelationRecord>,
    pub source_authorization: MdbxScopedAuthorizationDecision,
    pub target_authorization: MdbxScopedAuthorizationDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectRelationSummary {
    pub relation_id: String,
    pub source_object_id: String,
    pub target_object_id: String,
    pub relation_kind: String,
    pub payload_schema_version: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectRelationSummaryPage {
    pub items: Vec<MdbxObjectRelationSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelRecord {
    pub label_id: String,
    pub collection_id: String,
    pub name: String,
    pub payload_json: String,
    pub payload_schema_version: u32,
    pub deleted: bool,
}

/// Typed collection-policy result. `label` is absent unless the Project scope allows disclosure.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelDisclosureResult {
    pub label: Option<MdbxObjectLabelRecord>,
    pub project_authorization: MdbxScopedAuthorizationDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelSummary {
    pub label_id: String,
    pub collection_id: String,
    pub name: String,
    pub payload_schema_version: u32,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelSummaryPage {
    pub items: Vec<MdbxObjectLabelSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelAssignmentRecord {
    pub assignment_id: String,
    pub object_id: String,
    pub label_id: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelAssignmentSummary {
    pub assignment_id: String,
    pub object_id: String,
    pub label_id: String,
    pub head_commit_id: String,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct MdbxObjectLabelAssignmentSummaryPage {
    pub items: Vec<MdbxObjectLabelAssignmentSummary>,
    pub next_cursor: Option<String>,
}

use mdbx_core::model::{
    EntryType, ObjectLabelAssignmentSummary, ObjectLabelSummary, ObjectRelationSummary,
    ObjectSummary, ObjectTypeId, PayloadMigrationExecution, PayloadMigrationPlan,
    PayloadMigrationPlanItem, RelationKindId,
};
use mdbx_storage::connection::VaultConnection;
use mdbx_storage::error::{StorageError, StorageResult};
use mdbx_storage::object_disclosure::{
    DisclosedObject, ObjectDisclosureLimits, ObjectDisclosureService,
};
use mdbx_storage::object_metadata_disclosure::{
    ObjectLabelDisclosureResult as StorageObjectLabelDisclosureResult,
    ObjectMetadataDisclosureLimits, ObjectMetadataDisclosureService,
    ObjectRelationDisclosureResult as StorageObjectRelationDisclosureResult,
};
use mdbx_storage::repo::{
    CommitContext, EntryRepo, ObjectLabelAssignmentCreateRequest, ObjectLabelAssignmentRepo,
    ObjectLabelCreateRequest, ObjectLabelRepo, ObjectMetadataSummaryRepo,
    ObjectRelationCreateRequest, ObjectRelationRepo, ObjectSummaryRepo, ProjectRepo,
};

use super::{
    conservative_ffi_device_context, unix_now, MdbxAuthorizationDecision, MdbxDeviceContext,
    MdbxFfiError, MdbxScopedAuthorizationDecision, MdbxVault,
};

pub(crate) fn entry_for_project(
    conn: &VaultConnection,
    project_id: &str,
    entry_id: &str,
) -> StorageResult<mdbx_core::model::Entry> {
    let entry = EntryRepo::get_by_id(conn, entry_id)?
        .ok_or_else(|| StorageError::NotFound(entry_id.to_string()))?;
    if entry.project_id != project_id {
        return Err(StorageError::ConstraintViolation(format!(
            "entry {} does not belong to project {}",
            entry_id, project_id
        )));
    }
    Ok(entry)
}

fn parse_entry_type(entry_type: &str) -> Result<EntryType, MdbxFfiError> {
    let parsed: EntryType = entry_type
        .parse()
        .map_err(|_| MdbxFfiError::InvalidEntryType {
            entry_type: entry_type.to_string(),
        })?;
    if parsed.is_legacy() {
        Ok(parsed)
    } else {
        Err(MdbxFfiError::InvalidEntryType {
            entry_type: entry_type.to_string(),
        })
    }
}

fn parse_optional_entry_type(
    entry_type: Option<String>,
) -> Result<Option<EntryType>, MdbxFfiError> {
    entry_type.as_deref().map(parse_entry_type).transpose()
}

pub(crate) fn parse_object_type_id(object_type_id: &str) -> Result<ObjectTypeId, MdbxFfiError> {
    object_type_id
        .parse()
        .map_err(|_| MdbxFfiError::InvalidObjectTypeId {
            object_type_id: object_type_id.to_string(),
        })
}

fn parse_optional_object_type_id(
    object_type_id: Option<String>,
) -> Result<Option<ObjectTypeId>, MdbxFfiError> {
    object_type_id
        .as_deref()
        .map(parse_object_type_id)
        .transpose()
}

pub(crate) fn parse_relation_kind(relation_kind: &str) -> Result<RelationKindId, MdbxFfiError> {
    relation_kind
        .parse()
        .map_err(|_| MdbxFfiError::InvalidRelationKind {
            relation_kind: relation_kind.to_string(),
        })
}

pub(crate) fn parse_payload_json(payload_json: &str) -> Result<serde_json::Value, MdbxFfiError> {
    mdbx_core::json::from_str(payload_json).map_err(MdbxFfiError::from)
}

fn entry_record_from_entry(entry: &mdbx_core::model::Entry) -> Result<EntryRecord, MdbxFfiError> {
    let payload: serde_json::Value = mdbx_core::json::from_slice(&entry.payload_ct)?;
    Ok(EntryRecord {
        entry_id: entry.entry_id.clone(),
        project_id: entry.project_id.clone(),
        entry_type: entry.entry_type.to_string(),
        title: entry
            .title_ct
            .as_deref()
            .map(String::from_utf8_lossy)
            .map(|s| s.to_string())
            .unwrap_or_default(),
        payload_json: serde_json::to_string(&payload)?,
        deleted: entry.deleted,
    })
}

fn object_record_from_entry(
    entry: &mdbx_core::model::Entry,
) -> Result<MdbxObjectRecord, MdbxFfiError> {
    let payload: serde_json::Value = mdbx_core::json::from_slice(&entry.payload_ct)?;
    Ok(MdbxObjectRecord {
        object_id: entry.entry_id.clone(),
        collection_id: entry.project_id.clone(),
        object_type_id: entry.entry_type.to_string(),
        title: entry
            .title_ct
            .as_deref()
            .map(String::from_utf8_lossy)
            .map(|s| s.to_string())
            .unwrap_or_default(),
        payload_json: serde_json::to_string(&payload)?,
        payload_schema_version: entry.payload_schema_version,
        deleted: entry.deleted,
    })
}

fn object_disclosure_result(
    result: StorageResult<DisclosedObject>,
) -> Result<MdbxObjectDisclosureResult, MdbxFfiError> {
    match result {
        Ok(disclosed) => Ok(MdbxObjectDisclosureResult {
            object: Some(object_record_from_entry(&disclosed.object)?),
            authorization: disclosed.authorization.into(),
        }),
        Err(StorageError::Authorization(decision)) => Ok(MdbxObjectDisclosureResult {
            object: None,
            authorization: decision.into(),
        }),
        Err(error) => Err(error.into()),
    }
}

fn object_disclosure_limits(
    limits: MdbxObjectDisclosureLimits,
) -> Result<ObjectDisclosureLimits, MdbxFfiError> {
    ObjectDisclosureLimits::new(limits.max_payload_bytes).map_err(Into::into)
}

fn object_metadata_disclosure_limits(
    limits: MdbxObjectMetadataDisclosureLimits,
) -> Result<ObjectMetadataDisclosureLimits, MdbxFfiError> {
    ObjectMetadataDisclosureLimits::new(limits.max_payload_bytes).map_err(Into::into)
}

fn object_summary_from_core(summary: ObjectSummary) -> MdbxObjectSummary {
    MdbxObjectSummary {
        object_id: summary.object_id,
        collection_id: summary.collection_id,
        object_type_id: summary.object_type_id.to_string(),
        title: summary
            .title
            .as_deref()
            .map(String::from_utf8_lossy)
            .map(|value| value.to_string())
            .unwrap_or_default(),
        payload_schema_version: summary.payload_schema_version,
        head_commit_id: summary.head_commit_id,
        deleted: summary.deleted,
        updated_at: summary.updated_at,
    }
}

fn object_relation_record(
    relation: &mdbx_core::model::ObjectRelation,
) -> Result<MdbxObjectRelationRecord, MdbxFfiError> {
    let payload: serde_json::Value = mdbx_core::json::from_slice(&relation.payload_ct)?;
    Ok(MdbxObjectRelationRecord {
        relation_id: relation.relation_id.clone(),
        source_object_id: relation.source_object_id.clone(),
        target_object_id: relation.target_object_id.clone(),
        relation_kind: relation.relation_kind.to_string(),
        payload_json: serde_json::to_string(&payload)?,
        payload_schema_version: relation.payload_schema_version,
        deleted: relation.deleted,
    })
}

fn object_relation_disclosure_result(
    result: StorageObjectRelationDisclosureResult,
) -> Result<MdbxObjectRelationDisclosureResult, MdbxFfiError> {
    Ok(MdbxObjectRelationDisclosureResult {
        relation: result
            .relation
            .as_ref()
            .map(object_relation_record)
            .transpose()?,
        source_authorization: result.source_authorization.into(),
        target_authorization: result.target_authorization.into(),
    })
}

fn object_relation_summary_from_core(summary: ObjectRelationSummary) -> MdbxObjectRelationSummary {
    MdbxObjectRelationSummary {
        relation_id: summary.relation_id,
        source_object_id: summary.source_object_id,
        target_object_id: summary.target_object_id,
        relation_kind: summary.relation_kind.to_string(),
        payload_schema_version: summary.payload_schema_version,
        head_commit_id: summary.head_commit_id,
        deleted: summary.deleted,
        updated_at: summary.updated_at,
    }
}

fn object_label_record(
    label: &mdbx_core::model::ObjectLabel,
) -> Result<MdbxObjectLabelRecord, MdbxFfiError> {
    let name =
        String::from_utf8(label.name_ct.clone()).map_err(|error| MdbxFfiError::Serialization {
            message: error.to_string(),
        })?;
    let payload: serde_json::Value = mdbx_core::json::from_slice(&label.payload_ct)?;
    Ok(MdbxObjectLabelRecord {
        label_id: label.label_id.clone(),
        collection_id: label.collection_id.clone(),
        name,
        payload_json: serde_json::to_string(&payload)?,
        payload_schema_version: label.payload_schema_version,
        deleted: label.deleted,
    })
}

fn object_label_disclosure_result(
    result: StorageObjectLabelDisclosureResult,
) -> Result<MdbxObjectLabelDisclosureResult, MdbxFfiError> {
    Ok(MdbxObjectLabelDisclosureResult {
        label: result.label.as_ref().map(object_label_record).transpose()?,
        project_authorization: result.project_authorization.into(),
    })
}

fn object_label_summary_from_core(
    summary: ObjectLabelSummary,
) -> Result<MdbxObjectLabelSummary, MdbxFfiError> {
    let name = String::from_utf8(summary.name).map_err(|error| MdbxFfiError::Serialization {
        message: error.to_string(),
    })?;
    Ok(MdbxObjectLabelSummary {
        label_id: summary.label_id,
        collection_id: summary.collection_id,
        name,
        payload_schema_version: summary.payload_schema_version,
        head_commit_id: summary.head_commit_id,
        deleted: summary.deleted,
        updated_at: summary.updated_at,
    })
}

fn object_label_assignment_record(
    assignment: &mdbx_core::model::ObjectLabelAssignment,
) -> MdbxObjectLabelAssignmentRecord {
    MdbxObjectLabelAssignmentRecord {
        assignment_id: assignment.assignment_id.clone(),
        object_id: assignment.object_id.clone(),
        label_id: assignment.label_id.clone(),
        deleted: assignment.deleted,
    }
}

fn object_label_assignment_summary_from_core(
    summary: ObjectLabelAssignmentSummary,
) -> MdbxObjectLabelAssignmentSummary {
    MdbxObjectLabelAssignmentSummary {
        assignment_id: summary.assignment_id,
        object_id: summary.object_id,
        label_id: summary.label_id,
        head_commit_id: summary.head_commit_id,
        deleted: summary.deleted,
        updated_at: summary.updated_at,
    }
}

#[uniffi::export]
impl MdbxVault {
    pub fn create_project(&self, title: String) -> Result<ProjectRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let ctx = CommitContext::new(self.device_id.clone());
        let project = ProjectRepo::create(&conn, &ctx, &title, None, None)?;
        Ok(ProjectRecord {
            project_id: project.project_id,
            title: String::from_utf8_lossy(&project.title_ct).to_string(),
        })
    }

    pub fn create_entry(
        &self,
        project_id: String,
        entry_type: String,
        title: String,
        payload_json: String,
    ) -> Result<EntryRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let ctx = CommitContext::new(self.device_id.clone());
        let payload = parse_payload_json(&payload_json)?;
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            parse_entry_type(&entry_type)?,
            Some(&title),
            &payload,
        )?;
        entry_record_from_entry(&entry)
    }

    pub fn create_object(
        &self,
        collection_id: String,
        object_type_id: String,
        title: String,
        payload_json: String,
        payload_schema_version: u32,
    ) -> Result<MdbxObjectRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let ctx = CommitContext::new(self.device_id.clone());
        let payload = parse_payload_json(&payload_json)?;
        let object = EntryRepo::create_with_payload_schema_version(
            &conn,
            &ctx,
            &collection_id,
            parse_object_type_id(&object_type_id)?,
            Some(&title),
            &payload,
            payload_schema_version,
        )?;
        object_record_from_entry(&object)
    }

    /// Read one object's presentation metadata without selecting or decrypting its payload.
    pub fn get_object_summary(
        &self,
        object_id: String,
    ) -> Result<Option<MdbxObjectSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(ObjectSummaryRepo::get(&conn, &object_id)?.map(object_summary_from_core))
    }

    /// Reveal an object using a conservative Standard device profile.
    pub fn reveal_object(
        &self,
        object_id: String,
    ) -> Result<MdbxObjectDisclosureResult, MdbxFfiError> {
        self.reveal_object_with_limits(object_id, default_object_disclosure_limits())
    }

    /// Reveal with a conservative Standard device profile and an explicit bounded payload size.
    pub fn reveal_object_with_limits(
        &self,
        object_id: String,
        limits: MdbxObjectDisclosureLimits,
    ) -> Result<MdbxObjectDisclosureResult, MdbxFfiError> {
        self.reveal_object_with_device_context_and_limits(
            object_id,
            conservative_ffi_device_context(),
            limits,
        )
    }

    /// Reveal an object through the active vault session and the supplied real device
    /// capabilities. A non-allow Tiga decision returns `object = None` instead of plaintext.
    pub fn reveal_object_with_device_context(
        &self,
        object_id: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxObjectDisclosureResult, MdbxFfiError> {
        self.reveal_object_with_device_context_and_limits(
            object_id,
            device,
            default_object_disclosure_limits(),
        )
    }

    /// Reveal through the active session with explicit device capabilities and payload limits.
    pub fn reveal_object_with_device_context_and_limits(
        &self,
        object_id: String,
        device: MdbxDeviceContext,
        limits: MdbxObjectDisclosureLimits,
    ) -> Result<MdbxObjectDisclosureResult, MdbxFfiError> {
        let limits = object_disclosure_limits(limits)?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let device = device.into_core(&self.device_id);
        object_disclosure_result(
            ObjectDisclosureService::reveal_with_active_session_and_limits(
                &mut conn,
                &object_id,
                &device,
                unix_now(),
                limits,
            ),
        )
    }

    /// MDBX1-compatible complete-payload read. New clients should prefer
    /// `get_object_summary` and an authorized disclosure method.
    pub fn get_object(
        &self,
        collection_id: String,
        object_id: String,
    ) -> Result<Option<MdbxObjectRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let Some(object) = EntryRepo::get_by_id(&conn, &object_id)? else {
            return Ok(None);
        };
        if object.project_id != collection_id {
            return Ok(None);
        }
        Ok(Some(object_record_from_entry(&object)?))
    }

    /// MDBX1-compatible complete-payload list. New collection screens should
    /// use `list_object_summaries`.
    pub fn list_objects(
        &self,
        collection_id: String,
        object_type_id: Option<String>,
    ) -> Result<Vec<MdbxObjectRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let object_type_id = parse_optional_object_type_id(object_type_id)?;
        let objects = match object_type_id {
            Some(object_type_id) => {
                EntryRepo::list_by_project_and_type(&conn, &collection_id, object_type_id)?
            }
            None => EntryRepo::list_by_project(&conn, &collection_id)?,
        };
        objects.iter().map(object_record_from_entry).collect()
    }

    pub fn list_object_summaries(
        &self,
        collection_id: String,
        object_type_id: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let object_type_id = parse_optional_object_type_id(object_type_id)?;
        let page = ObjectSummaryRepo::list(
            &conn,
            &collection_id,
            object_type_id.as_ref(),
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    /// List deleted object presentation metadata for one Collection without
    /// selecting or decrypting object payloads.
    pub fn list_deleted_object_summaries(
        &self,
        collection_id: String,
        object_type_id: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let object_type_id = parse_optional_object_type_id(object_type_id)?;
        let page = ObjectSummaryRepo::list_deleted_by_collection(
            &conn,
            &collection_id,
            object_type_id.as_ref(),
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    /// List all deleted object presentation metadata without selecting or
    /// decrypting object payloads.
    pub fn list_all_deleted_object_summaries(
        &self,
        object_type_id: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let object_type_id = parse_optional_object_type_id(object_type_id)?;
        let page = ObjectSummaryRepo::list_deleted_all(
            &conn,
            object_type_id.as_ref(),
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    pub fn update_object(
        &self,
        collection_id: String,
        object_id: String,
        object_type_id: String,
        title: String,
        payload_json: String,
        payload_schema_version: u32,
    ) -> Result<MdbxObjectRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let expected_type = parse_object_type_id(&object_type_id)?;
        let mut object = entry_for_project(&conn, &collection_id, &object_id)?;
        if object.deleted {
            return Err(StorageError::ConstraintViolation(format!(
                "object {} is deleted",
                object_id
            ))
            .into());
        }
        if object.entry_type != expected_type {
            return Err(StorageError::ConstraintViolation(format!(
                "object {} does not have type {}",
                object_id, object_type_id
            ))
            .into());
        }

        object.title_ct = Some(title.into_bytes());
        object.payload_ct = serde_json::to_vec(&parse_payload_json(&payload_json)?)?;
        object.payload_schema_version = payload_schema_version;

        let ctx = CommitContext::new(self.device_id.clone());
        let updated = EntryRepo::update(&conn, &ctx, &object)?;
        object_record_from_entry(&updated)
    }

    pub fn create_object_relation(
        &self,
        source_object_id: String,
        target_object_id: String,
        relation_kind: String,
        payload_json: String,
        payload_schema_version: u32,
    ) -> Result<MdbxObjectRelationRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let ctx = CommitContext::new(self.device_id.clone());
        let relation = ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                source_object_id,
                target_object_id,
                parse_relation_kind(&relation_kind)?,
                parse_payload_json(&payload_json)?,
            )
            .with_payload_schema_version(payload_schema_version),
        )?;
        object_relation_record(&relation)
    }

    /// Read relation navigation metadata without selecting or decrypting its payload.
    pub fn get_object_relation_summary(
        &self,
        relation_id: String,
    ) -> Result<Option<MdbxObjectRelationSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(
            ObjectMetadataSummaryRepo::get_relation(&conn, &relation_id)?
                .map(object_relation_summary_from_core),
        )
    }

    /// Reveal a relation payload only after both endpoint Entry policies allow it.
    pub fn reveal_object_relation(
        &self,
        relation_id: String,
    ) -> Result<MdbxObjectRelationDisclosureResult, MdbxFfiError> {
        self.reveal_object_relation_with_limits(
            relation_id,
            default_object_metadata_disclosure_limits(),
        )
    }

    pub fn reveal_object_relation_with_limits(
        &self,
        relation_id: String,
        limits: MdbxObjectMetadataDisclosureLimits,
    ) -> Result<MdbxObjectRelationDisclosureResult, MdbxFfiError> {
        self.reveal_object_relation_with_device_context_and_limits(
            relation_id,
            conservative_ffi_device_context(),
            limits,
        )
    }

    pub fn reveal_object_relation_with_device_context(
        &self,
        relation_id: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxObjectRelationDisclosureResult, MdbxFfiError> {
        self.reveal_object_relation_with_device_context_and_limits(
            relation_id,
            device,
            default_object_metadata_disclosure_limits(),
        )
    }

    pub fn reveal_object_relation_with_device_context_and_limits(
        &self,
        relation_id: String,
        device: MdbxDeviceContext,
        limits: MdbxObjectMetadataDisclosureLimits,
    ) -> Result<MdbxObjectRelationDisclosureResult, MdbxFfiError> {
        let limits = object_metadata_disclosure_limits(limits)?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let device = device.into_core(&self.device_id);
        object_relation_disclosure_result(
            ObjectMetadataDisclosureService::reveal_relation_with_active_session_and_limits(
                &mut conn,
                &relation_id,
                &device,
                unix_now(),
                limits,
            )?,
        )
    }

    /// MDBX1/MDBX2-compatible complete-payload read. New clients should use the summary and
    /// explicit multi-scope disclosure methods.
    pub fn get_object_relation(
        &self,
        relation_id: String,
    ) -> Result<Option<MdbxObjectRelationRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        ObjectRelationRepo::get_by_id(&conn, &relation_id)?
            .as_ref()
            .map(object_relation_record)
            .transpose()
    }

    pub fn list_object_relations_from(
        &self,
        source_object_id: String,
        relation_kind: Option<String>,
    ) -> Result<Vec<MdbxObjectRelationRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let kind = relation_kind
            .as_deref()
            .map(parse_relation_kind)
            .transpose()?;
        ObjectRelationRepo::list_from_object(&conn, &source_object_id, kind.as_ref())?
            .iter()
            .map(object_relation_record)
            .collect()
    }

    pub fn list_object_relation_summaries_from(
        &self,
        source_object_id: String,
        relation_kind: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectRelationSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let kind = relation_kind
            .as_deref()
            .map(parse_relation_kind)
            .transpose()?;
        let page = ObjectMetadataSummaryRepo::list_relations_from(
            &conn,
            &source_object_id,
            kind.as_ref(),
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectRelationSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_relation_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    pub fn list_object_relations_to(
        &self,
        target_object_id: String,
        relation_kind: Option<String>,
    ) -> Result<Vec<MdbxObjectRelationRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let kind = relation_kind
            .as_deref()
            .map(parse_relation_kind)
            .transpose()?;
        ObjectRelationRepo::list_to_object(&conn, &target_object_id, kind.as_ref())?
            .iter()
            .map(object_relation_record)
            .collect()
    }

    pub fn list_object_relation_summaries_to(
        &self,
        target_object_id: String,
        relation_kind: Option<String>,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectRelationSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let kind = relation_kind
            .as_deref()
            .map(parse_relation_kind)
            .transpose()?;
        let page = ObjectMetadataSummaryRepo::list_relations_to(
            &conn,
            &target_object_id,
            kind.as_ref(),
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectRelationSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_relation_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    pub fn update_object_relation(
        &self,
        relation_id: String,
        relation_kind: String,
        payload_json: String,
        payload_schema_version: u32,
    ) -> Result<MdbxObjectRelationRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let mut relation = ObjectRelationRepo::get_by_id(&conn, &relation_id)?
            .ok_or_else(|| StorageError::NotFound(relation_id.clone()))?;
        relation.relation_kind = parse_relation_kind(&relation_kind)?;
        relation.payload_ct = serde_json::to_vec(&parse_payload_json(&payload_json)?)?;
        relation.payload_schema_version = payload_schema_version;
        let ctx = CommitContext::new(self.device_id.clone());
        object_relation_record(&ObjectRelationRepo::update(&conn, &ctx, &relation)?)
    }

    pub fn delete_object_relation(&self, relation_id: String) -> Result<(), MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        ObjectRelationRepo::soft_delete(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &relation_id,
        )?;
        Ok(())
    }

    pub fn create_object_label(
        &self,
        collection_id: String,
        name: String,
        payload_json: String,
        payload_schema_version: u32,
    ) -> Result<MdbxObjectLabelRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let label = ObjectLabelRepo::create(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            ObjectLabelCreateRequest::new(collection_id, name, parse_payload_json(&payload_json)?)
                .with_payload_schema_version(payload_schema_version),
        )?;
        object_label_record(&label)
    }

    /// Read label presentation metadata without selecting or decrypting its payload.
    pub fn get_object_label_summary(
        &self,
        label_id: String,
    ) -> Result<Option<MdbxObjectLabelSummary>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        ObjectMetadataSummaryRepo::get_label(&conn, &label_id)?
            .map(object_label_summary_from_core)
            .transpose()
    }

    /// Reveal a label payload only after its collection Project policy allows it.
    pub fn reveal_object_label(
        &self,
        label_id: String,
    ) -> Result<MdbxObjectLabelDisclosureResult, MdbxFfiError> {
        self.reveal_object_label_with_limits(label_id, default_object_metadata_disclosure_limits())
    }

    pub fn reveal_object_label_with_limits(
        &self,
        label_id: String,
        limits: MdbxObjectMetadataDisclosureLimits,
    ) -> Result<MdbxObjectLabelDisclosureResult, MdbxFfiError> {
        self.reveal_object_label_with_device_context_and_limits(
            label_id,
            conservative_ffi_device_context(),
            limits,
        )
    }

    pub fn reveal_object_label_with_device_context(
        &self,
        label_id: String,
        device: MdbxDeviceContext,
    ) -> Result<MdbxObjectLabelDisclosureResult, MdbxFfiError> {
        self.reveal_object_label_with_device_context_and_limits(
            label_id,
            device,
            default_object_metadata_disclosure_limits(),
        )
    }

    pub fn reveal_object_label_with_device_context_and_limits(
        &self,
        label_id: String,
        device: MdbxDeviceContext,
        limits: MdbxObjectMetadataDisclosureLimits,
    ) -> Result<MdbxObjectLabelDisclosureResult, MdbxFfiError> {
        let limits = object_metadata_disclosure_limits(limits)?;
        let mut conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let device = device.into_core(&self.device_id);
        object_label_disclosure_result(
            ObjectMetadataDisclosureService::reveal_label_with_active_session_and_limits(
                &mut conn,
                &label_id,
                &device,
                unix_now(),
                limits,
            )?,
        )
    }

    /// MDBX1/MDBX2-compatible complete-payload list. New clients should use label summaries and
    /// explicit policy-aware disclosure.
    pub fn list_object_labels(
        &self,
        collection_id: String,
    ) -> Result<Vec<MdbxObjectLabelRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        ObjectLabelRepo::list_by_collection(&conn, &collection_id)?
            .iter()
            .map(object_label_record)
            .collect()
    }

    pub fn list_object_label_summaries(
        &self,
        collection_id: String,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectLabelSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let page = ObjectMetadataSummaryRepo::list_labels(
            &conn,
            &collection_id,
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectLabelSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_label_summary_from_core)
                .collect::<Result<Vec<_>, _>>()?,
            next_cursor: page.next_cursor,
        })
    }

    pub fn update_object_label(
        &self,
        label_id: String,
        name: String,
        payload_json: String,
        payload_schema_version: u32,
    ) -> Result<MdbxObjectLabelRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let mut label = ObjectLabelRepo::get_by_id(&conn, &label_id)?
            .ok_or_else(|| StorageError::NotFound(label_id.clone()))?;
        label.name_ct = name.into_bytes();
        label.payload_ct = serde_json::to_vec(&parse_payload_json(&payload_json)?)?;
        label.payload_schema_version = payload_schema_version;
        object_label_record(&ObjectLabelRepo::update(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &label,
        )?)
    }

    pub fn delete_object_label(&self, label_id: String) -> Result<(), MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        ObjectLabelRepo::soft_delete(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &label_id,
        )?;
        Ok(())
    }

    pub fn assign_object_label(
        &self,
        object_id: String,
        label_id: String,
    ) -> Result<MdbxObjectLabelAssignmentRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(object_label_assignment_record(
            &ObjectLabelAssignmentRepo::create(
                &conn,
                &CommitContext::new(self.device_id.clone()),
                ObjectLabelAssignmentCreateRequest::new(object_id, label_id),
            )?,
        ))
    }

    pub fn list_object_label_assignments(
        &self,
        object_id: String,
    ) -> Result<Vec<MdbxObjectLabelAssignmentRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        Ok(
            ObjectLabelAssignmentRepo::list_by_object(&conn, &object_id)?
                .iter()
                .map(object_label_assignment_record)
                .collect(),
        )
    }

    pub fn list_object_label_assignment_summaries_by_object(
        &self,
        object_id: String,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectLabelAssignmentSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let page = ObjectMetadataSummaryRepo::list_assignments_by_object(
            &conn,
            &object_id,
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectLabelAssignmentSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_label_assignment_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    pub fn list_object_label_assignment_summaries_by_label(
        &self,
        label_id: String,
        page_size: u32,
        cursor: Option<String>,
    ) -> Result<MdbxObjectLabelAssignmentSummaryPage, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let page = ObjectMetadataSummaryRepo::list_assignments_by_label(
            &conn,
            &label_id,
            page_size as usize,
            cursor.as_deref(),
        )?;
        Ok(MdbxObjectLabelAssignmentSummaryPage {
            items: page
                .items
                .into_iter()
                .map(object_label_assignment_summary_from_core)
                .collect(),
            next_cursor: page.next_cursor,
        })
    }

    pub fn remove_object_label_assignment(
        &self,
        assignment_id: String,
    ) -> Result<(), MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        ObjectLabelAssignmentRepo::soft_delete(
            &conn,
            &CommitContext::new(self.device_id.clone()),
            &assignment_id,
        )?;
        Ok(())
    }

    pub fn list_entries(
        &self,
        project_id: String,
        entry_type: Option<String>,
    ) -> Result<Vec<EntryRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let entry_type = parse_optional_entry_type(entry_type)?;
        let entries = match entry_type {
            Some(entry_type) => {
                EntryRepo::list_by_project_and_type(&conn, &project_id, entry_type)?
            }
            None => EntryRepo::list_by_project(&conn, &project_id)?,
        };
        entries.iter().map(entry_record_from_entry).collect()
    }

    pub fn list_deleted_entries(
        &self,
        project_id: String,
        entry_type: Option<String>,
    ) -> Result<Vec<EntryRecord>, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let entry_type = parse_optional_entry_type(entry_type)?;
        let entries = match entry_type {
            Some(entry_type) => {
                EntryRepo::list_deleted_by_project_and_type(&conn, &project_id, entry_type)?
            }
            None => EntryRepo::list_deleted_by_project(&conn, &project_id)?,
        };
        entries.iter().map(entry_record_from_entry).collect()
    }

    pub fn update_entry(
        &self,
        project_id: String,
        entry_id: String,
        entry_type: String,
        title: String,
        payload_json: String,
    ) -> Result<EntryRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let expected_type = parse_entry_type(&entry_type)?;
        let mut entry = entry_for_project(&conn, &project_id, &entry_id)?;
        if entry.deleted {
            return Err(StorageError::ConstraintViolation(format!(
                "entry {} is deleted",
                entry_id
            ))
            .into());
        }
        if entry.entry_type != expected_type {
            return Err(StorageError::ConstraintViolation(format!(
                "entry {} is not a {} entry",
                entry_id, entry_type
            ))
            .into());
        }

        entry.title_ct = Some(title.into_bytes());
        entry.payload_ct = serde_json::to_vec(&parse_payload_json(&payload_json)?)?;

        let ctx = CommitContext::new(self.device_id.clone());
        let updated = EntryRepo::update(&conn, &ctx, &entry)?;
        entry_record_from_entry(&updated)
    }

    pub fn delete_entry(&self, project_id: String, entry_id: String) -> Result<(), MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let entry = entry_for_project(&conn, &project_id, &entry_id)?;
        if entry.deleted {
            return Err(StorageError::ConstraintViolation(format!(
                "entry {} is already deleted",
                entry_id
            ))
            .into());
        }

        let ctx = CommitContext::new(self.device_id.clone());
        EntryRepo::soft_delete(&conn, &ctx, &entry_id)?;
        Ok(())
    }

    pub fn restore_entry(
        &self,
        project_id: String,
        entry_id: String,
    ) -> Result<EntryRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let entry = entry_for_project(&conn, &project_id, &entry_id)?;
        if !entry.deleted {
            return Err(StorageError::ConstraintViolation(format!(
                "entry {} is not deleted",
                entry_id
            ))
            .into());
        }

        let ctx = CommitContext::new(self.device_id.clone());
        let restored = EntryRepo::restore(&conn, &ctx, &entry_id)?;
        entry_record_from_entry(&restored)
    }

    pub fn move_entry(
        &self,
        project_id: String,
        entry_id: String,
        target_project_id: String,
    ) -> Result<EntryRecord, MdbxFfiError> {
        let conn = self.conn.lock().map_err(|_| MdbxFfiError::LockPoisoned)?;
        let entry = entry_for_project(&conn, &project_id, &entry_id)?;
        if entry.deleted {
            return Err(StorageError::ConstraintViolation(format!(
                "entry {} is deleted",
                entry_id
            ))
            .into());
        }

        let ctx = CommitContext::new(self.device_id.clone());
        let moved = EntryRepo::move_to_project(&conn, &ctx, &entry_id, &target_project_id)?;
        entry_record_from_entry(&moved)
    }
}
