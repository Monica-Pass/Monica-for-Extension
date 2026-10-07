use rusqlite::types::Type;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use mdbx_core::model::{
    ObjectLabelAssignmentSummary, ObjectLabelAssignmentSummaryPage, ObjectLabelSummary,
    ObjectLabelSummaryPage, ObjectRelationSummary, ObjectRelationSummaryPage, RelationKindId,
};

use crate::connection::VaultConnection;
use crate::crypto_layer::{decrypt_field, FieldKeyPurpose};
use crate::error::{StorageError, StorageResult};
use crate::presentation_metadata::{
    bounded_required_ciphertext, enforce_plaintext_length, max_field_ciphertext_bytes,
    MAX_PRESENTATION_LABEL_NAME_BYTES,
};

pub const MAX_OBJECT_METADATA_SUMMARY_PAGE_SIZE: usize = 200;
const OBJECT_METADATA_SUMMARY_CURSOR_VERSION: u8 = 1;
const MAX_OBJECT_METADATA_SUMMARY_CURSOR_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ObjectMetadataSummaryQuery {
    RelationFrom,
    RelationTo,
    LabelsByCollection,
    AssignmentsByObject,
    AssignmentsByLabel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ObjectMetadataSummaryCursor {
    version: u8,
    query: ObjectMetadataSummaryQuery,
    scope_id: String,
    relation_kind: Option<String>,
    updated_at: String,
    item_id: String,
}

#[derive(Debug)]
struct RawRelationSummary {
    relation_id: String,
    source_object_id: String,
    target_object_id: String,
    relation_kind: String,
    payload_schema_version: u32,
    head_commit_id: String,
    deleted: bool,
    updated_at: String,
}

#[derive(Debug)]
struct RawLabelSummary {
    label_id: String,
    collection_id: String,
    name_ciphertext_bytes: i64,
    name_ct: Option<Vec<u8>>,
    payload_schema_version: u32,
    head_commit_id: String,
    deleted: bool,
    updated_at: String,
}

#[derive(Debug)]
struct RawAssignmentSummary {
    assignment_id: String,
    object_id: String,
    label_id: String,
    head_commit_id: String,
    deleted: bool,
    updated_at: String,
}

/// Payload-free, bounded projections for generic relation and classification metadata.
pub struct ObjectMetadataSummaryRepo;

impl ObjectMetadataSummaryRepo {
    pub fn get_relation(
        conn: &VaultConnection,
        relation_id: &str,
    ) -> StorageResult<Option<ObjectRelationSummary>> {
        let raw = conn
            .inner()
            .query_row(
                "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                        payload_schema_version, head_commit_id, deleted, updated_at
                 FROM object_relations WHERE relation_id = ?1",
                [relation_id],
                read_raw_relation_summary,
            )
            .optional()
            .map_err(StorageError::Database)?;
        raw.map(decode_relation_summary).transpose()
    }

    pub fn list_relations_from(
        conn: &VaultConnection,
        source_object_id: &str,
        relation_kind: Option<&RelationKindId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectRelationSummaryPage> {
        Self::list_relations(
            conn,
            ObjectMetadataSummaryQuery::RelationFrom,
            source_object_id,
            relation_kind,
            page_size,
            cursor,
        )
    }

    pub fn list_relations_to(
        conn: &VaultConnection,
        target_object_id: &str,
        relation_kind: Option<&RelationKindId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectRelationSummaryPage> {
        Self::list_relations(
            conn,
            ObjectMetadataSummaryQuery::RelationTo,
            target_object_id,
            relation_kind,
            page_size,
            cursor,
        )
    }

    fn list_relations(
        conn: &VaultConnection,
        query: ObjectMetadataSummaryQuery,
        scope_id: &str,
        relation_kind: Option<&RelationKindId>,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectRelationSummaryPage> {
        validate_page_size(page_size)?;
        let relation_kind = relation_kind.map(RelationKindId::as_str);
        let cursor = cursor
            .map(|value| parse_cursor(value, query, scope_id, relation_kind))
            .transpose()?;
        let endpoint_column = match query {
            ObjectMetadataSummaryQuery::RelationFrom => "source_object_id",
            ObjectMetadataSummaryQuery::RelationTo => "target_object_id",
            _ => unreachable!("relation page uses a relation query kind"),
        };
        let sql = format!(
            "SELECT relation_id, source_object_id, target_object_id, relation_kind,
                    payload_schema_version, head_commit_id, deleted, updated_at
             FROM object_relations
             WHERE deleted = 0 AND {endpoint_column} = ?1
               AND (?2 IS NULL OR relation_kind = ?2)
               AND (?3 IS NULL OR updated_at < ?3
                    OR (updated_at = ?3 AND relation_id < ?4))
             ORDER BY updated_at DESC, relation_id DESC
             LIMIT ?5"
        );
        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![
                scope_id,
                relation_kind,
                cursor.as_ref().map(|cursor| cursor.updated_at.as_str()),
                cursor.as_ref().map(|cursor| cursor.item_id.as_str()),
                (page_size + 1) as i64,
            ],
            read_raw_relation_summary,
        )?;
        let mut raw_items = collect_page_rows(rows, page_size)?;
        let has_next = raw_items.len() > page_size;
        if has_next {
            raw_items.pop();
        }
        let next_cursor = if has_next {
            raw_items.last().map(|row| {
                encode_cursor(
                    query,
                    scope_id,
                    relation_kind,
                    &row.updated_at,
                    &row.relation_id,
                )
                .expect("metadata summary cursor serialization cannot fail")
            })
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(decode_relation_summary)
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(ObjectRelationSummaryPage { items, next_cursor })
    }

    pub fn get_label(
        conn: &VaultConnection,
        label_id: &str,
    ) -> StorageResult<Option<ObjectLabelSummary>> {
        let raw = conn
            .inner()
            .query_row(
                "SELECT label_id, collection_id, length(name_ct),
                        CASE WHEN length(name_ct) <= ?2 THEN name_ct END,
                        payload_schema_version, head_commit_id, deleted, updated_at
                 FROM object_labels WHERE label_id = ?1",
                rusqlite::params![
                    label_id,
                    max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES) as i64,
                ],
                read_raw_label_summary,
            )
            .optional()
            .map_err(StorageError::Database)?;
        raw.map(|row| decode_label_summary(conn, row)).transpose()
    }

    pub fn list_labels(
        conn: &VaultConnection,
        collection_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectLabelSummaryPage> {
        validate_page_size(page_size)?;
        let query = ObjectMetadataSummaryQuery::LabelsByCollection;
        let cursor = cursor
            .map(|value| parse_cursor(value, query, collection_id, None))
            .transpose()?;
        let mut stmt = conn.inner().prepare(
            "SELECT label_id, collection_id, length(name_ct),
                    CASE WHEN length(name_ct) <= ?4 THEN name_ct END,
                    payload_schema_version, head_commit_id, deleted, updated_at
             FROM object_labels
             WHERE deleted = 0 AND collection_id = ?1
               AND (?2 IS NULL OR updated_at < ?2
                    OR (updated_at = ?2 AND label_id < ?3))
             ORDER BY updated_at DESC, label_id DESC
             LIMIT ?5",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![
                collection_id,
                cursor.as_ref().map(|cursor| cursor.updated_at.as_str()),
                cursor.as_ref().map(|cursor| cursor.item_id.as_str()),
                max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES) as i64,
                (page_size + 1) as i64,
            ],
            read_raw_label_summary,
        )?;
        let mut raw_items = collect_page_rows(rows, page_size)?;
        let has_next = raw_items.len() > page_size;
        if has_next {
            raw_items.pop();
        }
        let next_cursor = if has_next {
            raw_items.last().map(|row| {
                encode_cursor(query, collection_id, None, &row.updated_at, &row.label_id)
                    .expect("metadata summary cursor serialization cannot fail")
            })
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(|row| decode_label_summary(conn, row))
            .collect::<StorageResult<Vec<_>>>()?;
        Ok(ObjectLabelSummaryPage { items, next_cursor })
    }

    pub fn list_assignments_by_object(
        conn: &VaultConnection,
        object_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectLabelAssignmentSummaryPage> {
        Self::list_assignments(
            conn,
            ObjectMetadataSummaryQuery::AssignmentsByObject,
            object_id,
            page_size,
            cursor,
        )
    }

    pub fn list_assignments_by_label(
        conn: &VaultConnection,
        label_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectLabelAssignmentSummaryPage> {
        Self::list_assignments(
            conn,
            ObjectMetadataSummaryQuery::AssignmentsByLabel,
            label_id,
            page_size,
            cursor,
        )
    }

    fn list_assignments(
        conn: &VaultConnection,
        query: ObjectMetadataSummaryQuery,
        scope_id: &str,
        page_size: usize,
        cursor: Option<&str>,
    ) -> StorageResult<ObjectLabelAssignmentSummaryPage> {
        validate_page_size(page_size)?;
        let cursor = cursor
            .map(|value| parse_cursor(value, query, scope_id, None))
            .transpose()?;
        let owner_column = match query {
            ObjectMetadataSummaryQuery::AssignmentsByObject => "object_id",
            ObjectMetadataSummaryQuery::AssignmentsByLabel => "label_id",
            _ => unreachable!("assignment page uses an assignment query kind"),
        };
        let sql = format!(
            "SELECT assignment_id, object_id, label_id, head_commit_id, deleted, updated_at
             FROM object_label_assignments
             WHERE deleted = 0 AND {owner_column} = ?1
               AND (?2 IS NULL OR updated_at < ?2
                    OR (updated_at = ?2 AND assignment_id < ?3))
             ORDER BY updated_at DESC, assignment_id DESC
             LIMIT ?4"
        );
        let mut stmt = conn.inner().prepare(&sql)?;
        let rows = stmt.query_map(
            rusqlite::params![
                scope_id,
                cursor.as_ref().map(|cursor| cursor.updated_at.as_str()),
                cursor.as_ref().map(|cursor| cursor.item_id.as_str()),
                (page_size + 1) as i64,
            ],
            read_raw_assignment_summary,
        )?;
        let mut raw_items = collect_page_rows(rows, page_size)?;
        let has_next = raw_items.len() > page_size;
        if has_next {
            raw_items.pop();
        }
        let next_cursor = if has_next {
            raw_items.last().map(|row| {
                encode_cursor(query, scope_id, None, &row.updated_at, &row.assignment_id)
                    .expect("metadata summary cursor serialization cannot fail")
            })
        } else {
            None
        };
        let items = raw_items
            .into_iter()
            .map(|row| ObjectLabelAssignmentSummary {
                assignment_id: row.assignment_id,
                object_id: row.object_id,
                label_id: row.label_id,
                head_commit_id: row.head_commit_id,
                deleted: row.deleted,
                updated_at: row.updated_at,
            })
            .collect();
        Ok(ObjectLabelAssignmentSummaryPage { items, next_cursor })
    }
}

fn validate_page_size(page_size: usize) -> StorageResult<()> {
    if page_size == 0 || page_size > MAX_OBJECT_METADATA_SUMMARY_PAGE_SIZE {
        return Err(StorageError::Validation(format!(
            "object metadata summary page size must be between 1 and {MAX_OBJECT_METADATA_SUMMARY_PAGE_SIZE}"
        )));
    }
    Ok(())
}

fn collect_page_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
    page_size: usize,
) -> StorageResult<Vec<T>> {
    let mut values = Vec::with_capacity(page_size + 1);
    for row in rows.take(page_size + 1) {
        values.push(row?);
    }
    Ok(values)
}

fn read_raw_relation_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawRelationSummary> {
    Ok(RawRelationSummary {
        relation_id: row.get(0)?,
        source_object_id: row.get(1)?,
        target_object_id: row.get(2)?,
        relation_kind: row.get(3)?,
        payload_schema_version: read_schema_version(row, 4)?,
        head_commit_id: row.get(5)?,
        deleted: row.get::<_, i32>(6)? != 0,
        updated_at: row.get(7)?,
    })
}

fn decode_relation_summary(row: RawRelationSummary) -> StorageResult<ObjectRelationSummary> {
    Ok(ObjectRelationSummary {
        relation_id: row.relation_id,
        source_object_id: row.source_object_id,
        target_object_id: row.target_object_id,
        relation_kind: row
            .relation_kind
            .parse()
            .map_err(StorageError::Validation)?,
        payload_schema_version: row.payload_schema_version,
        head_commit_id: row.head_commit_id,
        deleted: row.deleted,
        updated_at: row.updated_at,
    })
}

fn read_raw_label_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawLabelSummary> {
    Ok(RawLabelSummary {
        label_id: row.get(0)?,
        collection_id: row.get(1)?,
        name_ciphertext_bytes: row.get(2)?,
        name_ct: row.get(3)?,
        payload_schema_version: read_schema_version(row, 4)?,
        head_commit_id: row.get(5)?,
        deleted: row.get::<_, i32>(6)? != 0,
        updated_at: row.get(7)?,
    })
}

fn decode_label_summary(
    conn: &VaultConnection,
    row: RawLabelSummary,
) -> StorageResult<ObjectLabelSummary> {
    let name_ct = bounded_required_ciphertext(
        "object label name ciphertext bytes",
        row.name_ciphertext_bytes,
        row.name_ct,
        MAX_PRESENTATION_LABEL_NAME_BYTES,
    )?;
    let name = decrypt_field(
        conn,
        FieldKeyPurpose::Metadata,
        &name_ct,
        "object-label",
        &row.label_id,
        "name",
    )?;
    enforce_plaintext_length(
        "object label name plaintext bytes",
        name.len() as u64,
        MAX_PRESENTATION_LABEL_NAME_BYTES,
    )?;
    crate::repo::object_label::validate_name_bytes(&name)?;
    Ok(ObjectLabelSummary {
        label_id: row.label_id,
        collection_id: row.collection_id,
        name,
        payload_schema_version: row.payload_schema_version,
        head_commit_id: row.head_commit_id,
        deleted: row.deleted,
        updated_at: row.updated_at,
    })
}

fn read_raw_assignment_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawAssignmentSummary> {
    Ok(RawAssignmentSummary {
        assignment_id: row.get(0)?,
        object_id: row.get(1)?,
        label_id: row.get(2)?,
        head_commit_id: row.get(3)?,
        deleted: row.get::<_, i32>(4)? != 0,
        updated_at: row.get(5)?,
    })
}

fn read_schema_version(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u32> {
    let value = row.get::<_, i64>(column)?;
    u32::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Integer, Box::new(error))
    })
}

fn encode_cursor(
    query: ObjectMetadataSummaryQuery,
    scope_id: &str,
    relation_kind: Option<&str>,
    updated_at: &str,
    item_id: &str,
) -> StorageResult<String> {
    serde_json::to_string(&ObjectMetadataSummaryCursor {
        version: OBJECT_METADATA_SUMMARY_CURSOR_VERSION,
        query,
        scope_id: scope_id.to_string(),
        relation_kind: relation_kind.map(str::to_string),
        updated_at: updated_at.to_string(),
        item_id: item_id.to_string(),
    })
    .map_err(|error| StorageError::Validation(error.to_string()))
}

fn parse_cursor(
    value: &str,
    query: ObjectMetadataSummaryQuery,
    scope_id: &str,
    relation_kind: Option<&str>,
) -> StorageResult<ObjectMetadataSummaryCursor> {
    if value.len() > MAX_OBJECT_METADATA_SUMMARY_CURSOR_BYTES {
        return Err(StorageError::Validation(format!(
            "object metadata summary cursor exceeds {MAX_OBJECT_METADATA_SUMMARY_CURSOR_BYTES} bytes"
        )));
    }
    let cursor: ObjectMetadataSummaryCursor = serde_json::from_str(value).map_err(|error| {
        StorageError::Validation(format!("invalid object metadata summary cursor: {error}"))
    })?;
    if cursor.version != OBJECT_METADATA_SUMMARY_CURSOR_VERSION {
        return Err(StorageError::Validation(format!(
            "unsupported object metadata summary cursor version {}",
            cursor.version
        )));
    }
    if cursor.query != query
        || cursor.scope_id != scope_id
        || cursor.relation_kind.as_deref() != relation_kind
    {
        return Err(StorageError::Validation(
            "object metadata summary cursor does not match the requested query".to_string(),
        ));
    }
    if cursor.updated_at.is_empty() || cursor.item_id.is_empty() {
        return Err(StorageError::Validation(
            "object metadata summary cursor position is incomplete".to_string(),
        ));
    }
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{
        CommitContext, EntryRepo, ObjectLabelAssignmentCreateRequest, ObjectLabelAssignmentRepo,
        ObjectLabelCreateRequest, ObjectLabelRepo, ObjectRelationCreateRequest, ObjectRelationRepo,
        ProjectRepo,
    };
    use mdbx_core::model::{EntryType, ObjectTypeId};
    use mdbx_crypto::keyring::Keyring;

    fn setup() -> (VaultConnection, CommitContext, String, String) {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let key = mdbx_crypto::aead::generate_key().unwrap();
        conn.attach_keyring(Keyring::from_vault_key(&key, b"metadata-summary-test").unwrap());
        let ctx = CommitContext::new("metadata-summary-device".to_string());
        let collection = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
        let object = EntryRepo::create(
            &conn,
            &ctx,
            &collection.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Source"),
            &serde_json::json!({"body": "source"}),
        )
        .unwrap();
        (conn, ctx, collection.project_id, object.entry_id)
    }

    fn create_object(
        conn: &VaultConnection,
        ctx: &CommitContext,
        collection_id: &str,
        title: &str,
    ) -> String {
        EntryRepo::create(
            conn,
            ctx,
            collection_id,
            ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            Some(title),
            &serde_json::json!({"body": title}),
        )
        .unwrap()
        .entry_id
    }

    #[test]
    fn object_metadata_summary_relation_pages_are_stable_and_payload_free() {
        let (conn, ctx, collection_id, source_id) = setup();
        let kind = RelationKindId::new("com.monica.mail.reply-to").unwrap();
        let other_kind = RelationKindId::new("com.monica.mail.forward-of").unwrap();
        let mut expected_ids = Vec::new();
        for index in 0..5 {
            let target_id = create_object(&conn, &ctx, &collection_id, &format!("Target {index}"));
            let relation = ObjectRelationRepo::create(
                &conn,
                &ctx,
                ObjectRelationCreateRequest::new(
                    &source_id,
                    target_id,
                    kind.clone(),
                    serde_json::json!({"position": index}),
                )
                .with_payload_schema_version(2),
            )
            .unwrap();
            expected_ids.push(relation.relation_id);
        }
        let other_target = create_object(&conn, &ctx, &collection_id, "Other target");
        ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &source_id,
                other_target,
                other_kind,
                serde_json::json!({}),
            ),
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE object_relations SET updated_at = '2026-07-23T00:00:00Z'
                 WHERE source_object_id = ?1 AND relation_kind = ?2",
                rusqlite::params![&source_id, kind.as_str()],
            )
            .unwrap();
        expected_ids.sort_by(|left, right| right.cmp(left));
        conn.inner()
            .execute(
                "UPDATE object_relations SET payload_ct = X'00' WHERE relation_id = ?1",
                [&expected_ids[0]],
            )
            .unwrap();

        let mut cursor = None;
        let mut actual_ids = Vec::new();
        loop {
            let page = ObjectMetadataSummaryRepo::list_relations_from(
                &conn,
                &source_id,
                Some(&kind),
                2,
                cursor.as_deref(),
            )
            .unwrap();
            for item in &page.items {
                assert_eq!(item.source_object_id, source_id);
                assert_eq!(item.relation_kind, kind);
                assert_eq!(item.payload_schema_version, 2);
                actual_ids.push(item.relation_id.clone());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual_ids, expected_ids);
        assert_eq!(
            ObjectMetadataSummaryRepo::get_relation(&conn, &expected_ids[0])
                .unwrap()
                .unwrap()
                .relation_id,
            expected_ids[0]
        );
        assert!(ObjectRelationRepo::get_by_id(&conn, &expected_ids[0]).is_err());
    }

    #[test]
    fn object_metadata_summary_label_pages_ignore_payload_corruption_and_show_tombstones() {
        let (conn, ctx, collection_id, _) = setup();
        let mut active_ids = Vec::new();
        for index in 0..5 {
            let label = ObjectLabelRepo::create(
                &conn,
                &ctx,
                ObjectLabelCreateRequest::new(
                    &collection_id,
                    format!("Label {index}"),
                    serde_json::json!({"color": index}),
                )
                .with_payload_schema_version(3),
            )
            .unwrap();
            active_ids.push(label.label_id);
        }
        let deleted = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(
                &collection_id,
                "Deleted",
                serde_json::json!({"hidden": true}),
            ),
        )
        .unwrap();
        ObjectLabelRepo::soft_delete(&conn, &ctx, &deleted.label_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE object_labels SET updated_at = '2026-07-23T00:00:00Z'
                 WHERE collection_id = ?1",
                [&collection_id],
            )
            .unwrap();
        active_ids.sort_by(|left, right| right.cmp(left));
        conn.inner()
            .execute(
                "UPDATE object_labels SET payload_ct = X'00'
                 WHERE label_id IN (?1, ?2)",
                rusqlite::params![&active_ids[0], &deleted.label_id],
            )
            .unwrap();

        let mut cursor = None;
        let mut actual_ids = Vec::new();
        loop {
            let page =
                ObjectMetadataSummaryRepo::list_labels(&conn, &collection_id, 2, cursor.as_deref())
                    .unwrap();
            for item in &page.items {
                assert_eq!(item.collection_id, collection_id);
                assert_eq!(item.payload_schema_version, 3);
                assert!(std::str::from_utf8(&item.name)
                    .unwrap()
                    .starts_with("Label"));
                actual_ids.push(item.label_id.clone());
            }
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(actual_ids, active_ids);
        let deleted_summary = ObjectMetadataSummaryRepo::get_label(&conn, &deleted.label_id)
            .unwrap()
            .unwrap();
        assert!(deleted_summary.deleted);
        assert_eq!(deleted_summary.name, b"Deleted");
        assert!(ObjectLabelRepo::get_by_id(&conn, &deleted.label_id).is_err());
        assert!(ObjectLabelRepo::get_by_id(&conn, &active_ids[0]).is_err());
    }

    #[test]
    fn presentation_label_summary_bounds_name_ciphertext_and_plaintext() {
        let (conn, ctx, collection_id, _) = setup();
        let label = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(
                &collection_id,
                "Bounded",
                serde_json::json!({"color":"red"}),
            ),
        )
        .unwrap();
        let ciphertext_bytes = max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES) + 1;
        conn.inner()
            .execute(
                "UPDATE object_labels SET name_ct = zeroblob(?2) WHERE label_id = ?1",
                rusqlite::params![&label.label_id, ciphertext_bytes as i64],
            )
            .unwrap();

        let error = ObjectMetadataSummaryRepo::get_label(&conn, &label.label_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object label name ciphertext bytes"
                && actual == ciphertext_bytes
                && limit == max_field_ciphertext_bytes(MAX_PRESENTATION_LABEL_NAME_BYTES)
        ));
        assert!(matches!(
            ObjectMetadataSummaryRepo::list_labels(&conn, &collection_id, 10, None),
            Err(StorageError::ResourceLimit { ref resource, .. })
                if resource == "object label name ciphertext bytes"
        ));

        let plaintext = vec![b'x'; MAX_PRESENTATION_LABEL_NAME_BYTES as usize + 1];
        let ciphertext = crate::crypto_layer::encrypt_field(
            &conn,
            FieldKeyPurpose::Metadata,
            &plaintext,
            "object-label",
            &label.label_id,
            "name",
        )
        .unwrap();
        conn.inner()
            .execute(
                "UPDATE object_labels SET name_ct = ?2 WHERE label_id = ?1",
                rusqlite::params![&label.label_id, ciphertext],
            )
            .unwrap();
        let error = ObjectMetadataSummaryRepo::get_label(&conn, &label.label_id).unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit {
                ref resource,
                actual,
                limit,
            } if resource == "object label name plaintext bytes"
                && actual == MAX_PRESENTATION_LABEL_NAME_BYTES + 1
                && limit == MAX_PRESENTATION_LABEL_NAME_BYTES
        ));
    }

    #[test]
    fn object_metadata_summary_assignment_pages_are_bounded_in_both_directions() {
        let (conn, ctx, collection_id, object_id) = setup();
        let shared_label = ObjectLabelRepo::create(
            &conn,
            &ctx,
            ObjectLabelCreateRequest::new(&collection_id, "Shared", serde_json::json!({})),
        )
        .unwrap();
        let mut object_assignment_ids = Vec::new();
        for index in 0..5 {
            let label = ObjectLabelRepo::create(
                &conn,
                &ctx,
                ObjectLabelCreateRequest::new(
                    &collection_id,
                    format!("Object label {index}"),
                    serde_json::json!({}),
                ),
            )
            .unwrap();
            let assignment = ObjectLabelAssignmentRepo::create(
                &conn,
                &ctx,
                ObjectLabelAssignmentCreateRequest::new(&object_id, label.label_id),
            )
            .unwrap();
            object_assignment_ids.push(assignment.assignment_id);
        }
        let mut label_assignment_ids = Vec::new();
        for index in 0..4 {
            let assigned_object = create_object(
                &conn,
                &ctx,
                &collection_id,
                &format!("Shared object {index}"),
            );
            let assignment = ObjectLabelAssignmentRepo::create(
                &conn,
                &ctx,
                ObjectLabelAssignmentCreateRequest::new(assigned_object, &shared_label.label_id),
            )
            .unwrap();
            label_assignment_ids.push(assignment.assignment_id);
        }
        conn.inner()
            .execute(
                "UPDATE object_label_assignments
                 SET updated_at = '2026-07-23T00:00:00Z'",
                [],
            )
            .unwrap();
        object_assignment_ids.sort_by(|left, right| right.cmp(left));
        label_assignment_ids.sort_by(|left, right| right.cmp(left));

        let object_ids = collect_assignment_ids(|cursor| {
            ObjectMetadataSummaryRepo::list_assignments_by_object(&conn, &object_id, 2, cursor)
        });
        let label_ids = collect_assignment_ids(|cursor| {
            ObjectMetadataSummaryRepo::list_assignments_by_label(
                &conn,
                &shared_label.label_id,
                2,
                cursor,
            )
        });
        assert_eq!(object_ids, object_assignment_ids);
        assert_eq!(label_ids, label_assignment_ids);
    }

    fn collect_assignment_ids(
        mut load: impl FnMut(Option<&str>) -> StorageResult<ObjectLabelAssignmentSummaryPage>,
    ) -> Vec<String> {
        let mut cursor = None;
        let mut ids = Vec::new();
        loop {
            let page = load(cursor.as_deref()).unwrap();
            ids.extend(page.items.into_iter().map(|item| item.assignment_id));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        ids
    }

    #[test]
    fn object_metadata_summary_cursors_are_bounded_and_query_bound() {
        let (conn, ctx, collection_id, object_id) = setup();
        let target_id = create_object(&conn, &ctx, &collection_id, "Target");
        let kind = RelationKindId::new("com.monica.mail.reply-to").unwrap();
        ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &object_id,
                &target_id,
                kind.clone(),
                serde_json::json!({}),
            ),
        )
        .unwrap();
        ObjectRelationRepo::create(
            &conn,
            &ctx,
            ObjectRelationCreateRequest::new(
                &object_id,
                create_object(&conn, &ctx, &collection_id, "Target 2"),
                kind.clone(),
                serde_json::json!({}),
            ),
        )
        .unwrap();

        assert!(ObjectMetadataSummaryRepo::list_relations_from(
            &conn,
            &object_id,
            Some(&kind),
            0,
            None,
        )
        .is_err());
        assert!(ObjectMetadataSummaryRepo::list_labels(
            &conn,
            &collection_id,
            MAX_OBJECT_METADATA_SUMMARY_PAGE_SIZE + 1,
            None,
        )
        .is_err());
        assert!(ObjectMetadataSummaryRepo::list_assignments_by_object(
            &conn,
            &object_id,
            1,
            Some(&"x".repeat(MAX_OBJECT_METADATA_SUMMARY_CURSOR_BYTES + 1)),
        )
        .is_err());

        let first =
            ObjectMetadataSummaryRepo::list_relations_from(&conn, &object_id, Some(&kind), 1, None)
                .unwrap();
        let cursor = first.next_cursor.unwrap();
        let error = ObjectMetadataSummaryRepo::list_relations_to(
            &conn,
            &target_id,
            Some(&kind),
            1,
            Some(&cursor),
        )
        .unwrap_err();
        assert!(error.to_string().contains("does not match"));
        let other_kind = RelationKindId::new("com.monica.mail.forward-of").unwrap();
        let error = ObjectMetadataSummaryRepo::list_relations_from(
            &conn,
            &object_id,
            Some(&other_kind),
            1,
            Some(&cursor),
        )
        .unwrap_err();
        assert!(error.to_string().contains("does not match"));
    }
}
