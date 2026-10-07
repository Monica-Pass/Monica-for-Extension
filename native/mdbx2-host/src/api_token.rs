//! Android native API-token metadata lives in collection-scoped labels, never
//! in the gateway credential payload (older CLI readers parse that strictly).
use super::{java_name_uuid, RpcFailure};
use mdbx_ffi::{MdbxObjectMetadataDisclosureLimits, MdbxVault, MdbxWriteCommand};
use serde_json::{json, Value};
use std::collections::HashSet;

const FIELDS_LABEL: &str = "monica:api-token:fields:v1";
const FAVORITE_LABEL: &str = "monica:api-token:favorite:v1";
const MAX_METADATA: usize = 64 * 1024;
const MAX_ASSIGNMENTS: usize = 512;

#[derive(Clone)]
pub(super) struct WriteFields {
    pub metadata_json: String,
    pub favorite: bool,
}

impl std::fmt::Debug for WriteFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiTokenFields(redacted)")
    }
}

struct FieldsLabel {
    id: String,
    assignment_id: String,
    collection_id: String,
    payload: String,
}

pub(super) struct Labels {
    fields: Option<FieldsLabel>,
    favorites: Vec<String>,
}

impl Labels {
    pub fn metadata_json(&self) -> Option<&str> {
        self.fields.as_ref().map(|field| field.payload.as_str())
    }
    pub fn favorite(&self) -> bool {
        !self.favorites.is_empty()
    }
}

fn read_error() -> RpcFailure {
    RpcFailure::new("api-token-metadata-unavailable", "API token metadata could not be disclosed safely. Reload or resolve conflicting fields before editing.", false)
}

pub(super) fn read(
    vault: &MdbxVault,
    object_id: &str,
    collection_id: &str,
) -> Result<Labels, RpcFailure> {
    let mut result = Labels {
        fields: None,
        favorites: Vec::new(),
    };
    let mut cursor = None;
    let mut seen = HashSet::new();
    let mut total = 0;
    loop {
        let page = vault
            .list_object_label_assignment_summaries_by_object(object_id.to_string(), 100, cursor)
            .map_err(|_| read_error())?;
        total += page.items.len();
        if total > MAX_ASSIGNMENTS {
            return Err(read_error());
        }
        for assignment in page
            .items
            .into_iter()
            .filter(|assignment| !assignment.deleted)
        {
            let Some(summary) = vault
                .get_object_label_summary(assignment.label_id.clone())
                .map_err(|_| read_error())?
            else {
                continue;
            };
            if summary.deleted {
                continue;
            }
            if summary.name == FAVORITE_LABEL && summary.collection_id == collection_id {
                result.favorites.push(assignment.assignment_id);
            } else if summary.name == FIELDS_LABEL {
                if result.fields.is_some() {
                    return Err(read_error());
                }
                let label = vault
                    .reveal_object_label_with_limits(
                        summary.label_id,
                        MdbxObjectMetadataDisclosureLimits {
                            max_payload_bytes: MAX_METADATA as u64,
                        },
                    )
                    .map_err(|_| read_error())?
                    .label
                    .ok_or_else(read_error)?;
                if label.payload_json.len() > MAX_METADATA {
                    return Err(read_error());
                }
                result.fields = Some(FieldsLabel {
                    id: label.label_id,
                    assignment_id: assignment.assignment_id,
                    collection_id: label.collection_id,
                    payload: label.payload_json,
                });
            }
        }
        match page.next_cursor {
            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
            Some(_) => return Err(read_error()),
            None => return Ok(result),
        }
    }
}

pub(super) fn object_id(logical_id: &str) -> Result<Option<String>, RpcFailure> {
    logical_id
        .strip_prefix("api-token:")
        .map(|id| {
            let parsed = uuid::Uuid::parse_str(id)
                .map_err(|_| RpcFailure::invalid("API token identity must contain a UUID."))?;
            if parsed.to_string() != id {
                return Err(RpcFailure::invalid(
                    "API token identity must be a canonical UUID.",
                ));
            }
            Ok(id.to_string())
        })
        .transpose()
}

pub(super) fn validate(payload: &str, title: &str, fields: &WriteFields) -> Result<(), RpcFailure> {
    let invalid = || {
        RpcFailure::invalid("API token fields are invalid or exceed the Android storage limits.")
    };
    if payload.len() > 16 * 1024
        || fields.metadata_json.len() > MAX_METADATA
        || title.trim().is_empty()
        || title.encode_utf16().count() > 256
        || title.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let raw: Value = mdbx_core::json::from_str(payload).map_err(|_| invalid())?;
    if !matches!(
        raw["schema"].as_str(),
        Some("monica.api-token.v1" | "monica.gateway.credential.v1")
    ) {
        return Err(invalid());
    }
    let provider = raw["provider"].as_str().ok_or_else(invalid)?;
    let endpoint = raw["api_base"].as_str().ok_or_else(invalid)?;
    let token = raw["token"].as_str().ok_or_else(invalid)?;
    if provider.trim().is_empty()
        || provider.encode_utf16().count() > 128
        || provider.chars().any(char::is_control)
        || token.trim().is_empty()
        || (token.encode_utf16().count() >= 16 && title.contains(token))
        || endpoint.encode_utf16().count() > 2048
    {
        return Err(invalid());
    }
    if raw.get("note").is_some_and(|note| !note.is_string()) {
        return Err(invalid());
    }
    let metadata: Value =
        mdbx_core::json::from_str(&fields.metadata_json).map_err(|_| invalid())?;
    if metadata["schema"] != "monica.api-token.fields.v1"
        || metadata
            .get("notes")
            .is_some_and(|notes| !notes.is_string())
    {
        return Err(invalid());
    }
    if let Some(custom) = metadata.get("custom_fields") {
        let custom = custom.as_array().ok_or_else(invalid)?;
        if custom.len() > 128 {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        for (index, field) in custom.iter().enumerate() {
            let id = match field.get("id") {
                Some(id) => id.as_i64().ok_or_else(invalid)?,
                None => -(index as i64 + 1),
            };
            if !ids.insert(id)
                || !field["title"].is_string()
                || !field["value"].is_string()
                || !field["protected"].is_boolean()
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

pub(super) struct LabelPlan {
    pub before_move: Vec<MdbxWriteCommand>,
    pub after_write: Vec<MdbxWriteCommand>,
    pub intent: Value,
}

pub(super) fn plan(
    vault: &MdbxVault,
    object_id: &str,
    old_collection_id: Option<&str>,
    target_collection_id: &str,
    write: &WriteFields,
) -> Result<LabelPlan, RpcFailure> {
    let current = match old_collection_id {
        Some(id) => read(vault, object_id, id)?,
        None => Labels {
            fields: None,
            favorites: Vec::new(),
        },
    };
    let moving = old_collection_id.is_some_and(|id| id != target_collection_id);
    let mut before = Vec::new();
    let mut after = Vec::new();
    let mut actions = Vec::new();
    if moving || !write.favorite {
        for assignment_id in &current.favorites {
            before.push(MdbxWriteCommand::RemoveObjectLabelAssignment {
                assignment_id: assignment_id.clone(),
            });
            actions.push(json!({ "removeAssignment": assignment_id }));
        }
    }
    if moving {
        if let Some(field) = &current.fields {
            before.push(MdbxWriteCommand::RemoveObjectLabelAssignment {
                assignment_id: field.assignment_id.clone(),
            });
            actions.push(json!({ "removeAssignment": field.assignment_id }));
        }
    }
    if write.favorite && (current.favorites.is_empty() || moving) {
        let id =
            java_name_uuid(format!("monica-api-token-favorite:{target_collection_id}").as_bytes());
        let summary = vault
            .get_object_label_summary(id.clone())
            .map_err(|_| read_error())?;
        if let Some(summary) = &summary {
            if summary.deleted
                || summary.name != FAVORITE_LABEL
                || summary.collection_id != target_collection_id
            {
                return Err(read_error());
            }
        } else {
            after.push(MdbxWriteCommand::CreateObjectLabel {
                label_id: id.clone(),
                collection_id: target_collection_id.to_string(),
                name: FAVORITE_LABEL.to_string(),
                payload_json: "{\"kind\":\"monica-api-token-favorites\"}".to_string(),
                payload_schema_version: 1,
            });
            actions.push(json!({ "createFavoriteLabel": id }));
        }
        // Include the current assignment history in the identity, so unfavorite
        // then favorite creates a fresh assignment instead of reusing a tombstone.
        let assignment_id = java_name_uuid(
            format!(
                "monica-api-token-favorite:{object_id}:{target_collection_id}:{}",
                assignment_generation(vault, object_id)?
            )
            .as_bytes(),
        );
        after.push(MdbxWriteCommand::AssignObjectLabel {
            assignment_id: assignment_id.clone(),
            object_id: object_id.to_string(),
            label_id: id.clone(),
        });
        actions.push(json!({ "assignFavorite": assignment_id, "labelId": id }));
    }
    if let Some(field) = current
        .fields
        .as_ref()
        .filter(|field| !moving && field.collection_id == target_collection_id)
    {
        if field.payload != write.metadata_json {
            after.push(MdbxWriteCommand::UpdateObjectLabel {
                label_id: field.id.clone(),
                name: FIELDS_LABEL.to_string(),
                payload_json: write.metadata_json.clone(),
                payload_schema_version: 1,
            });
            actions
                .push(json!({ "updateFieldsLabel": field.id, "payloadJson": write.metadata_json }));
        }
    } else {
        let id = java_name_uuid(
            format!(
                "monica-api-token-fields:{object_id}:{target_collection_id}:{}",
                assignment_generation(vault, object_id)?
            )
            .as_bytes(),
        );
        let assignment_id =
            java_name_uuid(format!("monica-api-token-fields-assignment:{id}").as_bytes());
        after.push(MdbxWriteCommand::CreateObjectLabel {
            label_id: id.clone(),
            collection_id: target_collection_id.to_string(),
            name: FIELDS_LABEL.to_string(),
            payload_json: write.metadata_json.clone(),
            payload_schema_version: 1,
        });
        after.push(MdbxWriteCommand::AssignObjectLabel {
            assignment_id: assignment_id.clone(),
            object_id: object_id.to_string(),
            label_id: id.clone(),
        });
        actions.push(json!({ "createFieldsLabel": id, "assignmentId": assignment_id, "payloadJson": write.metadata_json }));
    }
    Ok(LabelPlan {
        before_move: before,
        after_write: after,
        intent: json!({ "kind": "api-token-labels", "objectId": object_id, "collectionId": target_collection_id, "actions": actions }),
    })
}

fn assignment_generation(vault: &MdbxVault, object_id: &str) -> Result<String, RpcFailure> {
    // Hash bounded summary IDs, never credential values, for deterministic retries.
    let mut ids = Vec::new();
    let mut cursor = None;
    let mut seen = HashSet::new();
    loop {
        let page = vault
            .list_object_label_assignment_summaries_by_object(object_id.to_string(), 100, cursor)
            .map_err(|_| read_error())?;
        ids.extend(page.items.into_iter().map(|item| item.assignment_id));
        if ids.len() > MAX_ASSIGNMENTS {
            return Err(read_error());
        }
        match page.next_cursor {
            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
            Some(_) => return Err(read_error()),
            None => break,
        }
    }
    ids.sort();
    Ok(java_name_uuid(ids.join(":").as_bytes()))
}
