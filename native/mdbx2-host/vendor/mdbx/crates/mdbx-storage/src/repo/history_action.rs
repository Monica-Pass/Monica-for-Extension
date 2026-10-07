use rusqlite::{params, OptionalExtension};
use serde::de::DeserializeOwned;

use mdbx_core::tiga::{AuthorizationDecision, TigaOperation, TigaScope};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::repo::{
    AttachmentRepo, CommitChange, CommitContext, CommitHistoryRepo, CommitOperation, EntryRepo,
    ObjectVersionRepo,
};
use crate::sync_state::{
    AttachmentRow, EntryRow, ObjectLabelAssignmentRow, ObjectLabelRow, ObjectRelationRow,
    ProjectRow,
};
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

pub const MAX_COMMIT_DIFF_ITEMS: usize = 500;
pub const MAX_COMMIT_DIFF_PREVIEW_CHARS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitDiffItem {
    pub commit_id: String,
    pub object_type: String,
    pub object_id: String,
    pub collection_id: Option<String>,
    pub previous_title: Option<String>,
    pub current_title: Option<String>,
    pub previous_payload_preview: Option<String>,
    pub current_payload_preview: Option<String>,
    pub previous_deleted: Option<bool>,
    pub current_deleted: bool,
    pub changed_fields: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRevertResult {
    pub commit_id: String,
    pub reverted_object_count: usize,
}

#[derive(Debug, Clone)]
struct RawObjectVersion {
    object_type: String,
    object_id: String,
    commit_id: String,
    snapshot_ct: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
struct DecodedState {
    collection_id: Option<String>,
    title: Option<String>,
    payload_preview: Option<String>,
    deleted: bool,
}

pub struct HistoryActionRepo;

impl HistoryActionRepo {
    pub fn list_commit_diff(
        conn: &VaultConnection,
        commit_id: &str,
    ) -> StorageResult<Vec<CommitDiffItem>> {
        let history = CommitHistoryRepo::get(conn, commit_id)?
            .ok_or_else(|| StorageError::NotFound(commit_id.to_string()))?;
        let versions = versions_for_commit(conn, commit_id)?;
        let mut items = Vec::with_capacity(versions.len());
        for version in versions {
            let previous = previous_version(conn, &version)?;
            let current_state = decode_state(conn, &version)?;
            let previous_state = previous
                .as_ref()
                .map(|value| decode_state(conn, value))
                .transpose()?;
            let declared_fields = history
                .changes
                .iter()
                .find(|change| {
                    change.object_type == version.object_type
                        && change.object_id == version.object_id
                })
                .map(|change| change.fields.clone())
                .unwrap_or_default();
            let changed_fields =
                merge_changed_fields(declared_fields, previous_state.as_ref(), &current_state);
            items.push(CommitDiffItem {
                commit_id: version.commit_id.clone(),
                object_type: version.object_type.clone(),
                object_id: version.object_id.clone(),
                collection_id: current_state
                    .collection_id
                    .clone()
                    .or_else(|| previous_state.as_ref()?.collection_id.clone()),
                previous_title: previous_state
                    .as_ref()
                    .and_then(|state| state.title.clone()),
                current_title: current_state.title,
                previous_payload_preview: previous_state
                    .as_ref()
                    .and_then(|state| state.payload_preview.clone()),
                current_payload_preview: current_state.payload_preview,
                previous_deleted: previous_state.as_ref().map(|state| state.deleted),
                current_deleted: current_state.deleted,
                changed_fields,
                created_at: history.created_at.clone(),
            });
        }
        Ok(items)
    }

    pub fn revert_commit_authorized(
        conn: &VaultConnection,
        ctx: &CommitContext,
        commit_id: &str,
        operation_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<(CommitRevertResult, AuthorizationDecision)> {
        let (result, decision) = TigaService::execute_authorized_with_commit(
            conn,
            &TigaScope::Vault,
            TigaOperation::RestoreSnapshot,
            context,
            || {
                let result = Self::revert_commit(conn, ctx, commit_id, operation_id)?;
                let recovery_commit_id = result.commit_id.clone();
                Ok((result, recovery_commit_id))
            },
        )?;
        Ok((result, decision))
    }

    fn revert_commit(
        conn: &VaultConnection,
        ctx: &CommitContext,
        commit_id: &str,
        operation_id: &str,
    ) -> StorageResult<CommitRevertResult> {
        CommitHistoryRepo::get(conn, commit_id)?
            .ok_or_else(|| StorageError::NotFound(commit_id.to_string()))?;
        let target_versions = versions_for_commit(conn, commit_id)?
            .into_iter()
            .filter(|version| version.object_type == "entry")
            .collect::<Vec<_>>();
        if target_versions.is_empty() {
            return Err(StorageError::ConstraintViolation(format!(
                "commit {commit_id} has no restorable entry versions"
            )));
        }
        let mut targets = Vec::with_capacity(target_versions.len());
        for version in &target_versions {
            let target = match previous_version(conn, version)? {
                Some(previous) => decode_row::<EntryRow>(&previous)?,
                None => {
                    let mut current =
                        ObjectVersionRepo::current_entry_row(conn, &version.object_id)?;
                    current.deleted = true;
                    current
                }
            };
            targets.push(target);
        }

        let changes = targets
            .iter()
            .map(|row| CommitChange {
                object_type: "entry".to_string(),
                object_id: row.entry_id.clone(),
                action: "revert".to_string(),
                fields: vec!["history".to_string()],
            })
            .collect::<Vec<_>>();
        let operation = CommitOperation::new(
            operation_id.to_string(),
            "revert-commit",
            "main",
            "restore",
            "entry",
            changes,
        )
        .with_message(format!("revert commit {commit_id}"));
        let recovery_commit_id = ctx.create_operation_commit(conn, &operation)?;
        for row in &targets {
            EntryRepo::apply_version_for_commit(conn, ctx, row, &recovery_commit_id)?;
        }
        Ok(CommitRevertResult {
            commit_id: recovery_commit_id,
            reverted_object_count: targets.len(),
        })
    }
}

fn versions_for_commit(
    conn: &VaultConnection,
    commit_id: &str,
) -> StorageResult<Vec<RawObjectVersion>> {
    let mut statement = conn.inner().prepare(
        "SELECT object_type, object_id, commit_id, snapshot_ct
         FROM object_versions
         WHERE commit_id = ?1
         ORDER BY object_type, object_id
         LIMIT ?2",
    )?;
    let rows = statement.query_map(
        params![commit_id, (MAX_COMMIT_DIFF_ITEMS + 1) as i64],
        read_raw_version,
    )?;
    let versions = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    if versions.len() > MAX_COMMIT_DIFF_ITEMS {
        return Err(StorageError::ResourceLimit {
            resource: "commit diff objects".to_string(),
            actual: versions.len() as u64,
            limit: MAX_COMMIT_DIFF_ITEMS as u64,
        });
    }
    Ok(versions)
}

fn previous_version(
    conn: &VaultConnection,
    version: &RawObjectVersion,
) -> StorageResult<Option<RawObjectVersion>> {
    conn.inner()
        .query_row(
            "WITH RECURSIVE ancestry(commit_id, depth) AS (
                SELECT parent_commit_id, 1
                FROM commit_parents
                WHERE commit_id = ?3
                UNION ALL
                SELECT parents.parent_commit_id, ancestry.depth + 1
                FROM commit_parents parents
                JOIN ancestry ON parents.commit_id = ancestry.commit_id
                WHERE ancestry.depth < 1000
             ), nearest AS (
                SELECT commit_id, MIN(depth) AS depth
                FROM ancestry
                GROUP BY commit_id
             )
             SELECT versions.object_type, versions.object_id,
                    versions.commit_id, versions.snapshot_ct
             FROM nearest
             JOIN object_versions versions
               ON versions.commit_id = nearest.commit_id
              AND versions.object_type = ?1
              AND versions.object_id = ?2
             JOIN commits ON commits.commit_id = versions.commit_id
             ORDER BY nearest.depth ASC, commits.created_at DESC,
                      commits.local_seq DESC, versions.commit_id DESC
             LIMIT 1",
            params![version.object_type, version.object_id, version.commit_id],
            read_raw_version,
        )
        .optional()
        .map_err(StorageError::Database)
}

fn read_raw_version(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawObjectVersion> {
    Ok(RawObjectVersion {
        object_type: row.get(0)?,
        object_id: row.get(1)?,
        commit_id: row.get(2)?,
        snapshot_ct: row.get(3)?,
    })
}

fn decode_row<T: DeserializeOwned>(version: &RawObjectVersion) -> StorageResult<T> {
    serde_json::from_slice(&version.snapshot_ct).map_err(|error| {
        StorageError::Validation(format!(
            "invalid {} history row {}: {error}",
            version.object_type, version.object_id
        ))
    })
}

fn decode_state(conn: &VaultConnection, version: &RawObjectVersion) -> StorageResult<DecodedState> {
    match version.object_type.as_str() {
        "entry" => {
            let row: EntryRow = decode_row(version)?;
            let title = row
                .title_ct
                .as_deref()
                .map(|value| EntryRepo::decrypt_metadata(conn, &row.entry_id, "title", value))
                .transpose()?
                .map(decode_utf8)
                .transpose()?
                .or_else(|| Some(row.entry_type.clone()));
            let payload = EntryRepo::decrypt_payload_blob(conn, &row.entry_id, &row.payload_ct)?;
            Ok(DecodedState {
                collection_id: Some(row.project_id),
                title,
                payload_preview: Some(preview_bytes(&payload)),
                deleted: row.deleted,
            })
        }
        "project" => {
            let row: ProjectRow = decode_row(version)?;
            let title = decode_utf8(crate::repo::ProjectRepo::decrypt_metadata(
                conn,
                &row.project_id,
                "title",
                &row.title_ct,
            )?)?;
            let summary = row
                .summary_ct
                .as_deref()
                .map(|value| {
                    crate::repo::ProjectRepo::decrypt_metadata(
                        conn,
                        &row.project_id,
                        "summary",
                        value,
                    )
                })
                .transpose()?
                .map(|value| preview_bytes(&value));
            Ok(DecodedState {
                collection_id: row.group_id,
                title: Some(title),
                payload_preview: summary,
                deleted: row.deleted,
            })
        }
        "attachment" => {
            let row: AttachmentRow = decode_row(version)?;
            let title = decode_utf8(AttachmentRepo::decrypt_attachment_field(
                conn,
                &row.attachment_id,
                "file_name",
                &row.file_name_ct,
            )?)?;
            let media_type = row
                .media_type_ct
                .as_deref()
                .map(|value| {
                    AttachmentRepo::decrypt_attachment_field(
                        conn,
                        &row.attachment_id,
                        "media_type",
                        value,
                    )
                })
                .transpose()?
                .map(decode_utf8)
                .transpose()?;
            Ok(DecodedState {
                collection_id: Some(row.project_id),
                title: Some(title),
                payload_preview: media_type,
                deleted: row.deleted,
            })
        }
        "object-relation" => {
            let row: ObjectRelationRow = decode_row(version)?;
            let payload = decrypt_field(
                conn,
                FieldKeyPurpose::Record,
                &row.payload_ct,
                "object-relation",
                &row.relation_id,
                "payload",
            )?;
            Ok(DecodedState {
                title: Some(row.relation_kind),
                payload_preview: Some(preview_bytes(&payload)),
                deleted: row.deleted,
                ..Default::default()
            })
        }
        "object-label" => {
            let row: ObjectLabelRow = decode_row(version)?;
            let name = decrypt_field(
                conn,
                FieldKeyPurpose::Metadata,
                &row.name_ct,
                "object-label",
                &row.label_id,
                "name",
            )?;
            let payload = decrypt_field(
                conn,
                FieldKeyPurpose::Record,
                &row.payload_ct,
                "object-label",
                &row.label_id,
                "payload",
            )?;
            Ok(DecodedState {
                collection_id: Some(row.collection_id),
                title: Some(decode_utf8(name)?),
                payload_preview: Some(preview_bytes(&payload)),
                deleted: row.deleted,
            })
        }
        "object-label-assignment" => {
            let row: ObjectLabelAssignmentRow = decode_row(version)?;
            Ok(DecodedState {
                title: Some(row.label_id),
                payload_preview: Some(row.object_id),
                deleted: row.deleted,
                ..Default::default()
            })
        }
        _ => {
            let value: serde_json::Value = decode_row(version)?;
            Ok(DecodedState {
                deleted: value
                    .get("deleted")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
                ..Default::default()
            })
        }
    }
}

fn merge_changed_fields(
    mut declared: Vec<String>,
    previous: Option<&DecodedState>,
    current: &DecodedState,
) -> Vec<String> {
    if previous.is_none() {
        declared.push("created".to_string());
    }
    if previous.and_then(|state| state.title.as_ref()) != current.title.as_ref() {
        declared.push("title".to_string());
    }
    if previous.and_then(|state| state.payload_preview.as_ref()) != current.payload_preview.as_ref()
    {
        declared.push("payload".to_string());
    }
    if previous.map(|state| state.deleted) != Some(current.deleted) {
        declared.push("deleted".to_string());
    }
    if previous.and_then(|state| state.collection_id.as_ref()) != current.collection_id.as_ref() {
        declared.push("collection".to_string());
    }
    declared.sort();
    declared.dedup();
    if declared.is_empty() {
        declared.push("metadata".to_string());
    }
    declared
}

fn decode_utf8(value: Vec<u8>) -> StorageResult<String> {
    String::from_utf8(value)
        .map_err(|error| StorageError::Validation(format!("history text is not UTF-8: {error}")))
}

fn preview_bytes(value: &[u8]) -> String {
    let text = String::from_utf8_lossy(value);
    let mut chars = text.chars();
    let preview = chars
        .by_ref()
        .take(MAX_COMMIT_DIFF_PREVIEW_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{EntryRepo, ProjectRepo};
    use crate::unlock::UnlockService;
    use mdbx_core::model::EntryType;
    use mdbx_core::tiga::{DeviceAssurance, DeviceContext};

    #[test]
    fn commit_diff_and_authorized_revert_restore_previous_entry_state() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn,
            &VaultInitParams {
                device_id: "history-action-device".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        UnlockService::setup_password(&mut conn, "history action password").unwrap();
        let ctx = CommitContext::new("history-action-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "History", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Before"),
            &serde_json::json!({"password":"one"}),
        )
        .unwrap();
        let mut changed = entry.clone();
        changed.title_ct = Some(b"After".to_vec());
        changed.payload_ct = serde_json::to_vec(&serde_json::json!({"password":"two"})).unwrap();
        let updated = EntryRepo::update(&conn, &ctx, &changed).unwrap();
        let diff = HistoryActionRepo::list_commit_diff(&conn, &updated.head_commit_id).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(diff[0].previous_title.as_deref(), Some("Before"));
        assert_eq!(diff[0].current_title.as_deref(), Some("After"));

        let device = DeviceContext {
            device_id: Some("history-action-device".to_string()),
            assurance: DeviceAssurance::Standard,
            ..Default::default()
        };
        let now = chrono::Utc::now().timestamp();
        let (result, _) = HistoryActionRepo::revert_commit_authorized(
            &conn,
            &ctx,
            &updated.head_commit_id,
            &uuid::Uuid::new_v4().to_string(),
            TigaAuthorizationContext {
                session: conn.active_session(),
                device: &device,
                now_unix_secs: now,
            },
        )
        .unwrap();
        assert_eq!(result.reverted_object_count, 1);
        let restored = EntryRepo::get_by_id(&conn, &entry.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            String::from_utf8(restored.title_ct.unwrap()).unwrap(),
            "Before"
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&restored.payload_ct).unwrap(),
            serde_json::json!({"password":"one"})
        );
    }
}
