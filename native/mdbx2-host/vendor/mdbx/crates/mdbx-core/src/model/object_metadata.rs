use serde::{Deserialize, Serialize};

use super::entry::validate_extension_id;
use crate::types::*;

/// Namespaced stable identifier describing the meaning of a directed relation.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RelationKindId(String);

impl RelationKindId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        value.into().parse()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for RelationKindId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::str::FromStr for RelationKindId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        validate_extension_id(value)?;
        if !value.contains('.') {
            return Err("relation kind ID must be namespaced".to_string());
        }
        Ok(Self(value.to_string()))
    }
}

impl Serialize for RelationKindId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for RelationKindId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// Stable directed edge between two encrypted object records.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectRelation {
    pub relation_id: ObjectRelationId,
    pub source_object_id: EntryId,
    pub target_object_id: EntryId,
    pub relation_kind: RelationKindId,
    pub payload_ct: CipherText,
    pub payload_schema_version: u32,
    pub object_clock: ObjectClock,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: DeviceId,
    pub updated_by_device_id: DeviceId,
}

/// Payload-free relation metadata for navigation and selection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectRelationSummary {
    pub relation_id: ObjectRelationId,
    pub source_object_id: EntryId,
    pub target_object_id: EntryId,
    pub relation_kind: RelationKindId,
    pub payload_schema_version: u32,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub updated_at: String,
}

/// Bounded page of relation summaries with an opaque query-bound cursor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectRelationSummaryPage {
    pub items: Vec<ObjectRelationSummary>,
    pub next_cursor: Option<String>,
}

/// Stable encrypted label definition scoped to one collection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabel {
    pub label_id: ObjectLabelId,
    pub collection_id: ProjectId,
    pub name_ct: CipherText,
    pub payload_ct: CipherText,
    pub payload_schema_version: u32,
    pub object_clock: ObjectClock,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: DeviceId,
    pub updated_by_device_id: DeviceId,
}

/// Payload-free label metadata. The display name is decrypted presentation metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelSummary {
    pub label_id: ObjectLabelId,
    pub collection_id: ProjectId,
    pub name: Vec<u8>,
    pub payload_schema_version: u32,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub updated_at: String,
}

/// Bounded page of label summaries with an opaque query-bound cursor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelSummaryPage {
    pub items: Vec<ObjectLabelSummary>,
    pub next_cursor: Option<String>,
}

/// Stable many-to-many membership between an object and a label definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelAssignment {
    pub assignment_id: ObjectLabelAssignmentId,
    pub object_id: EntryId,
    pub label_id: ObjectLabelId,
    pub object_clock: ObjectClock,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_by_device_id: DeviceId,
    pub updated_by_device_id: DeviceId,
}

/// Compact assignment metadata for bounded membership traversal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelAssignmentSummary {
    pub assignment_id: ObjectLabelAssignmentId,
    pub object_id: EntryId,
    pub label_id: ObjectLabelId,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub updated_at: String,
}

/// Bounded page of object-label assignment summaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObjectLabelAssignmentSummaryPage {
    pub items: Vec<ObjectLabelAssignmentSummary>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relation_kind_requires_a_valid_namespace() {
        let kind = RelationKindId::new("com.monica.mail.reply-to").unwrap();
        assert_eq!(kind.as_str(), "com.monica.mail.reply-to");
        assert!(RelationKindId::new("reply-to").is_err());
        assert!(RelationKindId::new("Com.Monica.Mail").is_err());
        assert!(RelationKindId::new("com.monica..mail").is_err());
    }

    #[test]
    fn relation_kind_serializes_as_its_exact_identifier() {
        let kind = RelationKindId::new("com.monica.bookmark.member-of").unwrap();
        let encoded = serde_json::to_string(&kind).unwrap();
        assert_eq!(encoded, r#""com.monica.bookmark.member-of""#);
        assert_eq!(
            serde_json::from_str::<RelationKindId>(&encoded).unwrap(),
            kind
        );
    }

    #[test]
    fn metadata_summaries_roundtrip_without_payload_fields() {
        let relation = ObjectRelationSummary {
            relation_id: "relation-1".to_string(),
            source_object_id: "source-1".to_string(),
            target_object_id: "target-1".to_string(),
            relation_kind: RelationKindId::new("com.monica.mail.reply-to").unwrap(),
            payload_schema_version: 2,
            head_commit_id: "commit-1".to_string(),
            deleted: false,
            updated_at: "2026-07-23T00:00:00Z".to_string(),
        };
        let label = ObjectLabelSummary {
            label_id: "label-1".to_string(),
            collection_id: "collection-1".to_string(),
            name: b"Important".to_vec(),
            payload_schema_version: 3,
            head_commit_id: "commit-2".to_string(),
            deleted: false,
            updated_at: "2026-07-23T00:00:01Z".to_string(),
        };
        let assignment = ObjectLabelAssignmentSummary {
            assignment_id: "assignment-1".to_string(),
            object_id: "object-1".to_string(),
            label_id: "label-1".to_string(),
            head_commit_id: "commit-3".to_string(),
            deleted: false,
            updated_at: "2026-07-23T00:00:02Z".to_string(),
        };

        for value in [
            serde_json::to_value(&relation).unwrap(),
            serde_json::to_value(&label).unwrap(),
            serde_json::to_value(&assignment).unwrap(),
        ] {
            assert!(value.get("payload").is_none());
            assert!(value.get("payload_ct").is_none());
        }
        assert_eq!(
            serde_json::from_value::<ObjectRelationSummary>(
                serde_json::to_value(&relation).unwrap()
            )
            .unwrap(),
            relation
        );
        assert_eq!(
            serde_json::from_value::<ObjectLabelSummary>(serde_json::to_value(&label).unwrap())
                .unwrap(),
            label
        );
        assert_eq!(
            serde_json::from_value::<ObjectLabelAssignmentSummary>(
                serde_json::to_value(&assignment).unwrap()
            )
            .unwrap(),
            assignment
        );
    }
}
