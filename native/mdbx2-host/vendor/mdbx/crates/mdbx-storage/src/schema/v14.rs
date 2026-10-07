use rusqlite::Connection;

use crate::error::{StorageError, StorageResult};

pub const SYNC_DELTA_MUTATION_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS sync_delta_mutations (
    mutation_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_kind  TEXT NOT NULL,
    entity_id    TEXT NOT NULL,
    action       TEXT NOT NULL CHECK (action IN ('upsert', 'delete'))
);

CREATE INDEX IF NOT EXISTS idx_sync_delta_mutation_entity
    ON sync_delta_mutations (entity_kind, entity_id, mutation_seq);
"#;

pub const SYNC_DELTA_MUTATION_TRIGGERS_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_commit_insert
AFTER INSERT ON commits BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('commit', NEW.commit_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_vault_meta_insert
AFTER INSERT ON vault_meta BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('vault-meta', NEW.vault_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_vault_meta_update
AFTER UPDATE ON vault_meta
WHEN OLD.schema_version = NEW.schema_version
BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('vault-meta', NEW.vault_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_key_epoch_insert
AFTER INSERT ON key_epochs BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('key-epochs', 'all', 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_key_epoch_update
AFTER UPDATE ON key_epochs BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('key-epochs', 'all', 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_key_epoch_delete
AFTER DELETE ON key_epochs BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('key-epochs', 'all', 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tiga_override_insert
AFTER INSERT ON tiga_policy_overrides BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tiga-override', NEW.scope_type || char(31) || NEW.scope_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tiga_override_update
AFTER UPDATE ON tiga_policy_overrides BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tiga-override', NEW.scope_type || char(31) || NEW.scope_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tiga_override_delete
AFTER DELETE ON tiga_policy_overrides BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tiga-override', OLD.scope_type || char(31) || OLD.scope_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tiga_exception_insert
AFTER INSERT ON tiga_policy_exceptions BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tiga-exception', NEW.exception_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tiga_exception_update
AFTER UPDATE ON tiga_policy_exceptions BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tiga-exception', NEW.exception_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tiga_exception_delete
AFTER DELETE ON tiga_policy_exceptions BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tiga-exception', OLD.exception_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_audit_insert
AFTER INSERT ON security_audit_events BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('security-audit', NEW.event_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_project_insert
AFTER INSERT ON projects BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('project', NEW.project_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_project_update
AFTER UPDATE ON projects BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('project', NEW.project_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_project_delete
AFTER DELETE ON projects BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('project', OLD.project_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_profile_insert
AFTER INSERT ON collection_profiles BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('collection-profile', NEW.project_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_profile_update
AFTER UPDATE ON collection_profiles BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('collection-profile', NEW.project_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_profile_delete
AFTER DELETE ON collection_profiles BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('collection-profile', OLD.project_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_entry_insert
AFTER INSERT ON entries BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('entry', NEW.entry_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_entry_update
AFTER UPDATE ON entries BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('entry', NEW.entry_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_entry_delete
AFTER DELETE ON entries BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('entry', OLD.entry_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_relation_insert
AFTER INSERT ON object_relations BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-relation', NEW.relation_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_relation_update
AFTER UPDATE ON object_relations BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-relation', NEW.relation_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_relation_delete
AFTER DELETE ON object_relations BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-relation', OLD.relation_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_label_insert
AFTER INSERT ON object_labels BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-label', NEW.label_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_label_update
AFTER UPDATE ON object_labels BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-label', NEW.label_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_label_delete
AFTER DELETE ON object_labels BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-label', OLD.label_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_assignment_insert
AFTER INSERT ON object_label_assignments BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-label-assignment', NEW.assignment_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_assignment_update
AFTER UPDATE ON object_label_assignments BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-label-assignment', NEW.assignment_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_assignment_delete
AFTER DELETE ON object_label_assignments BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('object-label-assignment', OLD.assignment_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_attachment_insert
AFTER INSERT ON attachments BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('attachment', NEW.attachment_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_attachment_update
AFTER UPDATE ON attachments BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('attachment', NEW.attachment_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_attachment_delete
AFTER DELETE ON attachments BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('attachment', OLD.attachment_id, 'delete');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_chunk_insert
AFTER INSERT ON attachment_chunks BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('attachment', NEW.attachment_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_chunk_update
AFTER UPDATE ON attachment_chunks BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('attachment', NEW.attachment_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_chunk_delete
AFTER DELETE ON attachment_chunks BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('attachment', OLD.attachment_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tag_insert
AFTER INSERT ON project_tags BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('project-tags', NEW.project_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tag_delete
AFTER DELETE ON project_tags BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('project-tags', OLD.project_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tombstone_insert
AFTER INSERT ON tombstones BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tombstone', NEW.tombstone_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tombstone_update
AFTER UPDATE ON tombstones BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tombstone', NEW.tombstone_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_tombstone_delete
AFTER DELETE ON tombstones BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tombstone', OLD.tombstone_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_ack_insert
AFTER INSERT ON tombstone_acknowledgements BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tombstone-ack', NEW.tombstone_id || char(31) || NEW.device_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_ack_update
AFTER UPDATE ON tombstone_acknowledgements BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tombstone-ack', NEW.tombstone_id || char(31) || NEW.device_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_ack_delete
AFTER DELETE ON tombstone_acknowledgements BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('tombstone-ack', OLD.tombstone_id || char(31) || OLD.device_id, 'delete');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_purge_insert
AFTER INSERT ON purge_receipts BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('purge-receipt', NEW.purge_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_branch_insert
AFTER INSERT ON branches BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('branch', NEW.branch_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_branch_update
AFTER UPDATE ON branches BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('branch', NEW.branch_id, 'upsert');
END;

CREATE TRIGGER IF NOT EXISTS trg_sync_delta_device_head_insert
AFTER INSERT ON device_heads BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('device-head', NEW.device_id, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_device_head_update
AFTER UPDATE ON device_heads BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('device-head', NEW.device_id, 'upsert');
END;
"#;

pub const SYNC_STATE_EXTENSION_TRIGGERS_DDL: &str = r#"
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_sync_extension_insert
AFTER INSERT ON sync_state_extensions BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('sync-extension', NEW.extension_key, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_sync_extension_update
AFTER UPDATE ON sync_state_extensions BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('sync-extension', NEW.extension_key, 'upsert');
END;
CREATE TRIGGER IF NOT EXISTS trg_sync_delta_sync_extension_delete
AFTER DELETE ON sync_state_extensions BEGIN
    INSERT INTO sync_delta_mutations(entity_kind, entity_id, action)
    VALUES ('sync-extension', OLD.extension_key, 'delete');
END;
"#;

pub fn create_extensions(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(SYNC_DELTA_MUTATION_DDL)
        .map_err(StorageError::Database)?;
    conn.execute_batch(SYNC_DELTA_MUTATION_TRIGGERS_DDL)
        .map_err(StorageError::Database)
}

pub fn discard_bootstrap_mutations(conn: &Connection) -> StorageResult<()> {
    discard_captured_mutations(conn)
}

pub(crate) fn discard_captured_mutations(conn: &Connection) -> StorageResult<()> {
    conn.execute("DELETE FROM sync_delta_mutations", [])?;
    Ok(())
}

pub(crate) fn ensure_sync_state_extension_triggers(conn: &Connection) -> StorageResult<()> {
    conn.execute_batch(SYNC_STATE_EXTENSION_TRIGGERS_DDL)
        .map_err(StorageError::Database)
}

pub(crate) fn validate_sync_delta_capture(conn: &Connection) -> StorageResult<()> {
    for trigger in [
        "trg_sync_delta_commit_insert",
        "trg_sync_delta_vault_meta_update",
        "trg_sync_delta_key_epoch_update",
        "trg_sync_delta_tiga_override_delete",
        "trg_sync_delta_tiga_exception_update",
        "trg_sync_delta_audit_insert",
        "trg_sync_delta_project_update",
        "trg_sync_delta_profile_delete",
        "trg_sync_delta_entry_update",
        "trg_sync_delta_relation_update",
        "trg_sync_delta_label_update",
        "trg_sync_delta_assignment_update",
        "trg_sync_delta_attachment_update",
        "trg_sync_delta_chunk_insert",
        "trg_sync_delta_tag_delete",
        "trg_sync_delta_tombstone_update",
        "trg_sync_delta_ack_update",
        "trg_sync_delta_purge_insert",
        "trg_sync_delta_branch_update",
        "trg_sync_delta_device_head_update",
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?1)",
            [trigger],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::Validation(format!(
                "sync delta capture is missing required trigger {trigger}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::VaultConnection;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::{AttachmentRepo, CommitContext, ProjectRepo};

    #[test]
    fn bootstrap_is_clean_and_project_changes_capture_commit_and_state_keys() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let initial: i64 = conn
            .inner()
            .query_row("SELECT COUNT(*) FROM sync_delta_mutations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(initial, 0);

        let ctx = CommitContext::new("device-1".to_string());
        conn.inner().execute_batch("BEGIN IMMEDIATE;").unwrap();
        let project = ProjectRepo::create(&conn, &ctx, "Captured", None, None).unwrap();
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT entity_kind, entity_id FROM sync_delta_mutations
                 WHERE entity_kind IN ('commit', 'project', 'device-head', 'branch')
                 ORDER BY mutation_seq",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(rows.iter().any(|(kind, _)| kind == "commit"));
        assert!(rows
            .iter()
            .any(|(kind, id)| kind == "project" && id == &project.project_id));
        assert!(rows.iter().any(|(kind, _)| kind == "device-head"));
        assert!(rows.iter().any(|(kind, _)| kind == "branch"));
        validate_sync_delta_capture(conn.inner()).unwrap();
        conn.inner().execute_batch("ROLLBACK;").unwrap();
    }

    #[test]
    fn attachment_chunk_and_auxiliary_audit_changes_have_logical_keys() {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("device-1".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Attachments", None, None).unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "capture.bin",
            None,
            "",
            0,
        )
        .unwrap();
        discard_bootstrap_mutations(conn.inner()).unwrap();
        conn.inner().execute_batch("BEGIN IMMEDIATE;").unwrap();
        AttachmentRepo::write_inline_content(
            &conn,
            &ctx,
            &attachment.attachment_id,
            b"captured content",
        )
        .unwrap();
        let attachment_changes: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM sync_delta_mutations
                 WHERE entity_kind = 'attachment' AND entity_id = ?1",
                [&attachment.attachment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(attachment_changes >= 2);

        conn.inner().execute_batch("ROLLBACK;").unwrap();
        conn.inner()
            .execute(
                "INSERT INTO security_audit_events
                    (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                     reason_codes_json, constraints_json)
                 VALUES ('audit-1', '2026-07-20T00:00:00Z', 'copy-secret', 'deny',
                         'vault', '', '[]', '[]')",
                [],
            )
            .unwrap();
        let captured: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM sync_delta_mutations
                 WHERE entity_kind = 'security-audit' AND entity_id = 'audit-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(captured, 1);
    }
}
