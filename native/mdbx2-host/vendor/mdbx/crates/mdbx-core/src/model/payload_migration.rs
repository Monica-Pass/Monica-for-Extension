use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::ObjectTypeId;

pub const MAX_PAYLOAD_MIGRATION_ITEMS: usize = 256;
pub const MAX_PAYLOAD_MIGRATION_ITEM_BYTES: usize = 1024 * 1024;
pub const MAX_PAYLOAD_MIGRATION_TOTAL_BYTES: usize = 8 * 1024 * 1024;
pub const PAYLOAD_MIGRATION_DIGEST_BYTES: usize = 32;

pub fn payload_migration_digest(payload: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(b"mdbx-payload-migration-source-v1");
    hasher.update((payload.len() as u64).to_le_bytes());
    hasher.update(payload);
    hasher.finalize().to_vec()
}

/// A bounded, short-lived description of payloads an Adapter may transform.
///
/// Plans are not persisted. Storage revalidates every binding in the same
/// transaction that applies the migration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayloadMigrationPlan {
    pub plan_id: String,
    pub collection_id: String,
    pub object_type_id: ObjectTypeId,
    pub source_schema_version: u32,
    pub target_schema_version: u32,
    pub branch_id: String,
    pub branch_name: String,
    pub branch_head_commit_id: String,
    pub collection_profile_digest: Option<Vec<u8>>,
    pub items: Vec<PayloadMigrationPlanItem>,
    pub remaining_count: u64,
    pub total_source_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayloadMigrationPlanItem {
    pub object_id: String,
    pub object_head_commit_id: String,
    pub source_payload_digest: Vec<u8>,
    pub source_payload: Vec<u8>,
}

/// Adapter-produced payload for one item in a migration plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayloadMigrationOutput {
    pub object_id: String,
    pub target_payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayloadMigrationExecution {
    pub commit_id: String,
    pub migrated_count: u32,
    pub already_committed: bool,
}

impl PayloadMigrationPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.plan_id.trim().is_empty()
            || self.collection_id.trim().is_empty()
            || self.branch_id.trim().is_empty()
            || self.branch_name.trim().is_empty()
            || self.branch_head_commit_id.trim().is_empty()
        {
            return Err("payload migration plan contains an empty identity".to_string());
        }
        self.object_type_id.validate()?;
        if self.source_schema_version == 0 || self.target_schema_version == 0 {
            return Err("payload schema versions must be greater than zero".to_string());
        }
        if self.target_schema_version <= self.source_schema_version {
            return Err(
                "target payload schema version must advance the source version".to_string(),
            );
        }
        if self.items.is_empty() {
            return Err("payload migration plan contains no items".to_string());
        }
        if self.items.len() > MAX_PAYLOAD_MIGRATION_ITEMS {
            return Err(format!(
                "payload migration plan exceeds {MAX_PAYLOAD_MIGRATION_ITEMS} items"
            ));
        }
        if self
            .collection_profile_digest
            .as_ref()
            .is_some_and(|digest| digest.len() != PAYLOAD_MIGRATION_DIGEST_BYTES)
        {
            return Err("collection profile digest has an invalid length".to_string());
        }

        let mut object_ids = BTreeSet::new();
        let mut total_bytes = 0usize;
        for item in &self.items {
            if item.object_id.trim().is_empty() || item.object_head_commit_id.trim().is_empty() {
                return Err("payload migration item contains an empty identity".to_string());
            }
            if !object_ids.insert(item.object_id.as_str()) {
                return Err(format!(
                    "payload migration plan contains duplicate object {}",
                    item.object_id
                ));
            }
            if item.source_payload_digest.len() != PAYLOAD_MIGRATION_DIGEST_BYTES {
                return Err(format!(
                    "payload migration item {} has an invalid digest length",
                    item.object_id
                ));
            }
            if payload_migration_digest(&item.source_payload) != item.source_payload_digest {
                return Err(format!(
                    "payload migration item {} source payload does not match its digest",
                    item.object_id
                ));
            }
            if item.source_payload.len() > MAX_PAYLOAD_MIGRATION_ITEM_BYTES {
                return Err(format!(
                    "payload migration item {} exceeds {MAX_PAYLOAD_MIGRATION_ITEM_BYTES} bytes",
                    item.object_id
                ));
            }
            total_bytes = total_bytes
                .checked_add(item.source_payload.len())
                .ok_or_else(|| "payload migration plan byte count overflowed".to_string())?;
            if total_bytes > MAX_PAYLOAD_MIGRATION_TOTAL_BYTES {
                return Err(format!(
                    "payload migration plan exceeds {MAX_PAYLOAD_MIGRATION_TOTAL_BYTES} source bytes"
                ));
            }
        }
        if self.total_source_bytes != total_bytes as u64 {
            return Err(
                "payload migration plan source byte count does not match its items".to_string(),
            );
        }
        Ok(())
    }
}

pub fn validate_payload_migration_outputs(
    plan: &PayloadMigrationPlan,
    outputs: &[PayloadMigrationOutput],
) -> Result<(), String> {
    plan.validate()?;
    if outputs.len() != plan.items.len() {
        return Err("payload migration output count does not match the plan".to_string());
    }

    let planned_ids = plan
        .items
        .iter()
        .map(|item| item.object_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut output_ids = BTreeSet::new();
    let mut total_bytes = 0usize;
    for output in outputs {
        if !output_ids.insert(output.object_id.as_str()) {
            return Err(format!(
                "payload migration outputs contain duplicate object {}",
                output.object_id
            ));
        }
        if !planned_ids.contains(output.object_id.as_str()) {
            return Err(format!(
                "payload migration output contains unplanned object {}",
                output.object_id
            ));
        }
        if output.target_payload.len() > MAX_PAYLOAD_MIGRATION_ITEM_BYTES {
            return Err(format!(
                "payload migration output {} exceeds {MAX_PAYLOAD_MIGRATION_ITEM_BYTES} bytes",
                output.object_id
            ));
        }
        total_bytes = total_bytes
            .checked_add(output.target_payload.len())
            .ok_or_else(|| "payload migration output byte count overflowed".to_string())?;
        if total_bytes > MAX_PAYLOAD_MIGRATION_TOTAL_BYTES {
            return Err(format!(
                "payload migration outputs exceed {MAX_PAYLOAD_MIGRATION_TOTAL_BYTES} bytes"
            ));
        }
    }
    if output_ids != planned_ids {
        return Err("payload migration outputs do not cover every planned object".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> PayloadMigrationPlan {
        PayloadMigrationPlan {
            plan_id: "plan-1".to_string(),
            collection_id: "collection-1".to_string(),
            object_type_id: ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            source_schema_version: 1,
            target_schema_version: 2,
            branch_id: "branch-1".to_string(),
            branch_name: "main".to_string(),
            branch_head_commit_id: "commit-1".to_string(),
            collection_profile_digest: Some(vec![7; PAYLOAD_MIGRATION_DIGEST_BYTES]),
            items: vec![PayloadMigrationPlanItem {
                object_id: "object-1".to_string(),
                object_head_commit_id: "commit-1".to_string(),
                source_payload_digest: payload_migration_digest(b"old"),
                source_payload: b"old".to_vec(),
            }],
            remaining_count: 0,
            total_source_bytes: 3,
        }
    }

    #[test]
    fn plan_roundtrips_and_validates() {
        let plan = plan();
        plan.validate().unwrap();
        let encoded = serde_json::to_vec(&plan).unwrap();
        assert_eq!(
            serde_json::from_slice::<PayloadMigrationPlan>(&encoded).unwrap(),
            plan
        );
    }

    #[test]
    fn outputs_must_cover_plan_once_and_stay_bounded() {
        let plan = plan();
        validate_payload_migration_outputs(
            &plan,
            &[PayloadMigrationOutput {
                object_id: "object-1".to_string(),
                target_payload: b"new".to_vec(),
            }],
        )
        .unwrap();

        assert!(validate_payload_migration_outputs(&plan, &[]).is_err());
        assert!(validate_payload_migration_outputs(
            &plan,
            &[
                PayloadMigrationOutput {
                    object_id: "object-1".to_string(),
                    target_payload: b"new".to_vec(),
                },
                PayloadMigrationOutput {
                    object_id: "object-1".to_string(),
                    target_payload: b"duplicate".to_vec(),
                },
            ],
        )
        .is_err());
    }

    #[test]
    fn plan_rejects_version_regression_and_tampered_byte_count() {
        let mut invalid = plan();
        invalid.target_schema_version = 1;
        assert!(invalid.validate().is_err());

        let mut invalid = plan();
        invalid.total_source_bytes = 4;
        assert!(invalid.validate().is_err());
    }
}
