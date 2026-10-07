use std::fs;
use std::path::{Path, PathBuf};

use mdbx_ffi::{
    create_portable_backup, create_vault, create_vault_with_tiga_mode,
    default_attachment_batch_limits, default_attachment_presentation_limits,
    default_composite_write_operation_limits, default_conflict_summary_limits,
    default_object_metadata_disclosure_limits, default_snapshot_summary_limits,
    default_write_operation_limits, inspect_vault_migration, open_vault,
    open_vault_with_password_security_key, open_vault_with_security_key, upgrade_vault,
    MdbxAttachmentBatchCommand, MdbxAttachmentContentLimits, MdbxAttachmentCreateRequest,
    MdbxAuthorizationConstraintKind, MdbxAuthorizationOutcome, MdbxAuthorizationReason,
    MdbxDeviceAssurance, MdbxDeviceContext, MdbxExtensionProfile, MdbxExtensionRegistration,
    MdbxFfiError, MdbxObjectMetadataDisclosureLimits, MdbxPolicyCompliance, MdbxTigaMode,
    MdbxTigaOperation, MdbxTigaScope, MdbxTigaScopeType, MdbxUnlockMethodType, MdbxWriteCommand,
};
use mdbx_storage::migration::CURRENT_SCHEMA_VERSION;
use uuid::Uuid;

struct TempVaultPath {
    path: PathBuf,
    path_string: String,
}

impl TempVaultPath {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("mdbx-ffi-{}-{}.mdbx", label, Uuid::new_v4()));
        let path_string = path.to_string_lossy().to_string();
        Self { path, path_string }
    }

    fn as_path_string(&self) -> String {
        self.path_string.clone()
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempVaultPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(sqlite_sidecar_path(&self.path, "-shm"));
        let _ = fs::remove_file(sqlite_sidecar_path(&self.path, "-wal"));
    }
}

fn temp_vault_path(label: &str) -> TempVaultPath {
    TempVaultPath::new(label)
}

fn vault_scope() -> MdbxTigaScope {
    MdbxTigaScope {
        scope_type: MdbxTigaScopeType::Vault,
        scope_id: None,
    }
}

fn standard_device() -> MdbxDeviceContext {
    MdbxDeviceContext {
        assurance: MdbxDeviceAssurance::Standard,
        secure_clipboard_available: false,
        screen_capture_protection_available: false,
        secure_temp_files_available: true,
    }
}

fn trusted_device() -> MdbxDeviceContext {
    MdbxDeviceContext {
        assurance: MdbxDeviceAssurance::TrustedHardware,
        secure_clipboard_available: true,
        screen_capture_protection_available: true,
        secure_temp_files_available: true,
    }
}

fn mail_extension_profile() -> MdbxExtensionProfile {
    MdbxExtensionProfile {
        extension_id: "com.monica.mail".to_string(),
        profile_version: 1,
        collection_type_ids: vec!["com.monica.mail".to_string()],
        object_type_ids: vec!["com.monica.mail.message".to_string()],
        relation_kind_ids: vec!["com.monica.mail.reply-to".to_string()],
        capability_ids: vec!["com.monica.mail.store".to_string()],
        optional_index_ids: vec!["com.monica.mail.index.messages".to_string()],
        import_adapter_ids: vec!["com.monica.mail.import.eml".to_string()],
        export_adapter_ids: vec!["com.monica.mail.export.eml".to_string()],
        presentation_hint_ids: vec!["com.monica.mail.presentation.threaded".to_string()],
    }
}

#[test]
fn extension_profile_registry_is_available_and_process_local() {
    let vault_path = temp_vault_path("extension-profile-registry");
    let path = vault_path.as_path_string();
    let password = "extension profile password 12345!";
    let vault = create_vault(
        path.clone(),
        password.to_string(),
        "ffi-extension-device".to_string(),
    )
    .unwrap();
    assert_eq!(
        vault
            .register_extension_profile(mail_extension_profile())
            .unwrap(),
        MdbxExtensionRegistration::Registered
    );
    assert_eq!(vault.list_extension_profiles().unwrap().len(), 1);
    drop(vault);

    let reopened = open_vault(
        path,
        password.to_string(),
        "ffi-extension-device".to_string(),
    )
    .unwrap();
    assert!(reopened.list_extension_profiles().unwrap().is_empty());
}

fn count_rows(path: &Path, table: &str) -> i64 {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn active_key_epoch_id(path: &Path) -> String {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.query_row("SELECT active_key_epoch_id FROM vault_meta", [], |row| {
        row.get(0)
    })
    .unwrap()
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

#[test]
fn create_failure_removes_database_and_sidecars() {
    let vault_path = temp_vault_path("create-failure-cleanup");

    let result = create_vault(
        vault_path.as_path_string(),
        String::new(),
        "ffi-create-failure-device".to_string(),
    );

    assert!(result.is_err());
    assert!(!vault_path.path().exists());
    assert!(!sqlite_sidecar_path(vault_path.path(), "-wal").exists());
    assert!(!sqlite_sidecar_path(vault_path.path(), "-shm").exists());
}

#[test]
fn create_rejects_existing_vault_and_preserves_contents() {
    let vault_path = temp_vault_path("create-existing-preserved");
    let path = vault_path.as_path_string();
    let password = "existing vault password 12345!";
    let vault = create_vault(
        path.clone(),
        password.to_string(),
        "ffi-existing-device".to_string(),
    )
    .unwrap();
    let project = vault.create_project("Preserved".to_string()).unwrap();
    drop(vault);

    assert!(create_vault(
        path.clone(),
        "replacement password 12345!".to_string(),
        "ffi-replacement-device".to_string(),
    )
    .is_err());
    let reopened = open_vault(
        path,
        password.to_string(),
        "ffi-existing-device".to_string(),
    )
    .unwrap();
    let entry = reopened
        .create_entry(
            project.project_id.clone(),
            "note".to_string(),
            "Preservation Check".to_string(),
            r#"{"body":"original vault remains writable"}"#.to_string(),
        )
        .unwrap();

    assert_eq!(entry.project_id, project.project_id);
}

#[test]
fn open_and_upgrade_missing_paths_do_not_create_files() {
    let open_path = temp_vault_path("open-missing");
    assert!(open_vault(
        open_path.as_path_string(),
        "unused password 12345!".to_string(),
        "ffi-open-missing-device".to_string(),
    )
    .is_err());
    assert!(!open_path.path().exists());

    let upgrade_path = temp_vault_path("upgrade-missing");
    assert!(upgrade_vault(upgrade_path.as_path_string()).is_err());
    assert!(!upgrade_path.path().exists());
}

#[test]
fn open_and_upgrade_reject_non_mdbx_sqlite_without_modification() {
    let vault_path = temp_vault_path("open-non-mdbx");
    {
        let conn = rusqlite::Connection::open(vault_path.path()).unwrap();
        conn.execute_batch(
            "CREATE TABLE unrelated_data (value TEXT NOT NULL);
             INSERT INTO unrelated_data VALUES ('preserve-me');",
        )
        .unwrap();
    }
    let before = fs::read(vault_path.path()).unwrap();

    assert!(open_vault(
        vault_path.as_path_string(),
        "unused password 12345!".to_string(),
        "ffi-open-non-mdbx-device".to_string(),
    )
    .is_err());
    assert_eq!(fs::read(vault_path.path()).unwrap(), before);
    assert!(upgrade_vault(vault_path.as_path_string()).is_err());
    assert_eq!(fs::read(vault_path.path()).unwrap(), before);
}

#[test]
fn backup_reopens_with_original_password_and_remains_writable() {
    let source_path = temp_vault_path("backup-source");
    let backup_path = temp_vault_path("backup-target");
    let password = "backup 中文 password 12345!";
    let device_id = "ffi-backup-device";
    let vault = create_vault(
        source_path.as_path_string(),
        password.to_string(),
        device_id.to_string(),
    )
    .unwrap();
    let project = vault
        .create_project("Backed up project".to_string())
        .unwrap();

    let info = vault.create_backup(backup_path.as_path_string()).unwrap();

    assert_eq!(info.vault_id, vault.info().vault_id);
    assert_eq!(info.format_version, "MDBX-2");
    assert!(info.file_size_bytes > 0);
    assert!(!sqlite_sidecar_path(backup_path.path(), "-wal").exists());
    assert!(!sqlite_sidecar_path(backup_path.path(), "-shm").exists());
    let reopened = open_vault(
        backup_path.as_path_string(),
        password.to_string(),
        device_id.to_string(),
    )
    .unwrap();
    let entry = reopened
        .create_entry(
            project.project_id.clone(),
            "note".to_string(),
            "Backup remains writable".to_string(),
            r#"{"body":"verified"}"#.to_string(),
        )
        .unwrap();
    assert_eq!(entry.project_id, project.project_id);
}

#[test]
fn backup_does_not_replace_existing_destination() {
    let source_path = temp_vault_path("backup-no-clobber-source");
    let backup_path = temp_vault_path("backup-no-clobber-target");
    let vault = create_vault(
        source_path.as_path_string(),
        "backup no clobber password 12345!".to_string(),
        "ffi-backup-no-clobber-device".to_string(),
    )
    .unwrap();
    fs::write(backup_path.path(), b"preserve existing destination").unwrap();

    assert!(vault.create_backup(backup_path.as_path_string()).is_err());
    assert_eq!(
        fs::read(backup_path.path()).unwrap(),
        b"preserve existing destination"
    );
}

#[test]
fn write_operation_coalesces_commands_and_retries_idempotently() {
    let vault_path = temp_vault_path("write-operation");
    let vault = create_vault(
        vault_path.as_path_string(),
        "operation password 12345!".to_string(),
        "ffi-operation-device".to_string(),
    )
    .unwrap();
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();
    let commands = vec![
        MdbxWriteCommand::CreateProject {
            project_id: project_id.clone(),
            title: "Operation Project".to_string(),
        },
        MdbxWriteCommand::CreateEntry {
            entry_id: entry_id.clone(),
            project_id: project_id.clone(),
            entry_type: "login".to_string(),
            title: "Operation Entry".to_string(),
            payload_json: r#"{"username":"alice","password":"secret"}"#.to_string(),
        },
    ];
    let before = count_rows(vault_path.path(), "commits");

    let first = vault
        .execute_write_operation(
            "ffi-operation-1".to_string(),
            "create-project-with-entry".to_string(),
            commands.clone(),
        )
        .unwrap();
    assert!(!first.already_committed);
    assert_eq!(first.project_ids, vec![project_id.clone()]);
    assert_eq!(first.entry_ids, vec![entry_id.clone()]);
    assert_eq!(count_rows(vault_path.path(), "commits"), before + 1);

    let db = rusqlite::Connection::open(vault_path.path()).unwrap();
    let (project_head, entry_head): (String, String) = db
        .query_row(
            "SELECT p.head_commit_id, e.head_commit_id
             FROM projects p JOIN entries e ON e.project_id = p.project_id
             WHERE p.project_id = ?1 AND e.entry_id = ?2",
            rusqlite::params![project_id, entry_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(project_head, first.commit_id);
    assert_eq!(entry_head, first.commit_id);
    drop(db);

    let retry = vault
        .execute_write_operation(
            "ffi-operation-1".to_string(),
            "create-project-with-entry".to_string(),
            commands.clone(),
        )
        .unwrap();
    assert!(retry.already_committed);
    assert_eq!(retry.commit_id, first.commit_id);
    assert_eq!(count_rows(vault_path.path(), "commits"), before + 1);

    let mut changed_commands = commands;
    if let MdbxWriteCommand::CreateProject { title, .. } = &mut changed_commands[0] {
        *title = "Different Intent".to_string();
    }
    assert!(vault
        .execute_write_operation(
            "ffi-operation-1".to_string(),
            "create-project-with-entry".to_string(),
            changed_commands,
        )
        .is_err());
}

#[test]
fn generic_metadata_summary_pages_are_available_to_external_clients() {
    let vault_path = temp_vault_path("generic-metadata-operation");
    let vault = create_vault(
        vault_path.as_path_string(),
        "generic metadata password 12345!".to_string(),
        "ffi-generic-metadata-device".to_string(),
    )
    .unwrap();
    let project_id = Uuid::new_v4().to_string();
    let first_entry_id = Uuid::new_v4().to_string();
    let second_entry_id = Uuid::new_v4().to_string();
    let relation_id = Uuid::new_v4().to_string();
    let label_id = Uuid::new_v4().to_string();
    let assignment_id = Uuid::new_v4().to_string();
    let before = count_rows(vault_path.path(), "commits");

    let result = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "create-mail-thread".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: project_id.clone(),
                    title: "Mail".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: first_entry_id.clone(),
                    project_id: project_id.clone(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "First".to_string(),
                    payload_json: "{}".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: second_entry_id.clone(),
                    project_id: project_id.clone(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Second".to_string(),
                    payload_json: "{}".to_string(),
                },
                MdbxWriteCommand::CreateObjectRelation {
                    relation_id: relation_id.clone(),
                    source_object_id: first_entry_id.clone(),
                    target_object_id: second_entry_id.clone(),
                    relation_kind: "com.monica.mail.reply-to".to_string(),
                    payload_json: "{}".to_string(),
                    payload_schema_version: 1,
                },
                MdbxWriteCommand::CreateObjectLabel {
                    label_id: label_id.clone(),
                    collection_id: project_id.clone(),
                    name: "Important".to_string(),
                    payload_json: "{}".to_string(),
                    payload_schema_version: 1,
                },
                MdbxWriteCommand::AssignObjectLabel {
                    assignment_id: assignment_id.clone(),
                    object_id: first_entry_id.clone(),
                    label_id: label_id.clone(),
                },
            ],
        )
        .unwrap();

    assert_eq!(count_rows(vault_path.path(), "commits"), before + 1);
    assert_eq!(result.relation_ids, vec![relation_id.clone()]);
    assert_eq!(result.label_ids, vec![label_id.clone()]);
    assert_eq!(result.label_assignment_ids, vec![assignment_id.clone()]);
    assert_eq!(
        vault
            .get_object_relation(relation_id.clone())
            .unwrap()
            .unwrap()
            .relation_kind,
        "com.monica.mail.reply-to"
    );
    assert_eq!(
        vault.list_object_labels(project_id.clone()).unwrap().len(),
        1
    );
    assert_eq!(
        vault
            .list_object_label_assignments(first_entry_id.clone())
            .unwrap()[0]
            .assignment_id,
        assignment_id
    );
    assert_eq!(
        vault
            .get_object_relation_summary(relation_id)
            .unwrap()
            .unwrap()
            .target_object_id,
        second_entry_id
    );
    assert_eq!(
        vault
            .list_object_relation_summaries_from(
                first_entry_id.clone(),
                Some("com.monica.mail.reply-to".to_string()),
                10,
                None,
            )
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        vault
            .get_object_label_summary(label_id.clone())
            .unwrap()
            .unwrap()
            .name,
        "Important"
    );
    assert_eq!(
        vault
            .list_object_label_summaries(project_id, 10, None)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        vault
            .list_object_label_assignment_summaries_by_object(first_entry_id, 10, None)
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        vault
            .list_object_label_assignment_summaries_by_label(label_id, 10, None)
            .unwrap()
            .items
            .len(),
        1
    );
}

#[test]
fn bounded_conflict_summary_api_is_available_to_external_clients() {
    let vault_path = temp_vault_path("conflict-summary");
    let vault = create_vault(
        vault_path.as_path_string(),
        "conflict summary password 12345!".to_string(),
        "ffi-conflict-summary-device".to_string(),
    )
    .unwrap();

    let limits = default_conflict_summary_limits();
    assert_eq!(limits.max_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);
    assert_eq!(limits.max_fields_json_bytes, 64 * 1024);
    assert_eq!(limits.max_field_count, 256);
    assert_eq!(limits.max_field_path_bytes, 4096);

    let page = vault
        .list_unresolved_conflict_summaries(None, 1, None)
        .unwrap();
    assert!(page.items.is_empty());
    assert!(page.next_cursor.is_none());
    assert!(matches!(
        vault.list_unresolved_conflict_summaries(Some("unknown".to_string()), 1, None),
        Err(MdbxFfiError::InvalidConflictObjectType { object_type })
            if object_type == "unknown"
    ));
}

#[test]
fn bounded_snapshot_summary_api_is_available_to_external_clients() {
    let vault_path = temp_vault_path("snapshot-summary");
    let vault = create_vault(
        vault_path.as_path_string(),
        "snapshot summary password 12345!".to_string(),
        "ffi-snapshot-summary-device".to_string(),
    )
    .unwrap();
    let limits = default_snapshot_summary_limits();
    assert_eq!(limits.max_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);
    assert_eq!(limits.max_text_bytes, 4096);

    let page = vault.list_snapshot_summaries(1, None).unwrap();
    assert!(page.items.is_empty());
    assert!(page.next_cursor.is_none());
    assert!(vault
        .get_snapshot_summary("missing-snapshot".to_string())
        .unwrap()
        .is_none());
    assert!(vault.list_snapshot_summaries(0, None).is_err());
}

#[test]
fn attachment_batch_is_available_to_external_clients() {
    let vault_path = temp_vault_path("attachment-batch");
    let vault = create_vault(
        vault_path.as_path_string(),
        "attachment batch password 12345!".to_string(),
        "ffi-attachment-batch-device".to_string(),
    )
    .unwrap();
    let project = vault.create_project("Mail".to_string()).unwrap();
    let first_id = Uuid::new_v4().to_string();
    let second_id = Uuid::new_v4().to_string();
    let before = count_rows(vault_path.path(), "commits");
    let mut limits = default_attachment_batch_limits();
    limits.max_commands = 2;
    limits.max_plaintext_bytes_per_command = 64;
    limits.max_plaintext_bytes = 128;
    limits.chunk_size = 3;

    let result = vault
        .execute_attachment_batch_with_limits(
            Uuid::new_v4().to_string(),
            vec![
                MdbxAttachmentBatchCommand::Create {
                    attachment_id: first_id.clone(),
                    project_id: project.project_id.clone(),
                    entry_id: None,
                    file_name: "first.eml".to_string(),
                    media_type: Some("message/rfc822".to_string()),
                    content: b"first".to_vec(),
                },
                MdbxAttachmentBatchCommand::Create {
                    attachment_id: second_id.clone(),
                    project_id: project.project_id,
                    entry_id: None,
                    file_name: "second.eml".to_string(),
                    media_type: Some("message/rfc822".to_string()),
                    content: b"second".to_vec(),
                },
            ],
            limits,
        )
        .unwrap();

    assert_eq!(count_rows(vault_path.path(), "commits"), before + 1);
    assert_eq!(
        result
            .attachments
            .iter()
            .map(|attachment| attachment.attachment_id.clone())
            .collect::<Vec<_>>(),
        vec![first_id.clone(), second_id]
    );
    assert_eq!(
        vault.read_attachment_content(first_id, 64).unwrap(),
        b"first"
    );
}

#[test]
fn bounded_attachment_summary_api_is_available_to_external_clients() {
    let vault_path = temp_vault_path("attachment-summaries");
    let vault = create_vault(
        vault_path.as_path_string(),
        "attachment summary password 12345!".to_string(),
        "ffi-attachment-summary-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    let object = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Message".to_string(),
            "{}".to_string(),
            1,
        )
        .unwrap();
    let attachment_id = Uuid::new_v4().to_string();
    vault
        .create_attachment_with_content(
            Uuid::new_v4().to_string(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: collection.project_id.clone(),
                entry_id: Some(object.object_id.clone()),
                file_name: "message.eml".to_string(),
                media_type: Some("message/rfc822".to_string()),
            },
            b"mail body".to_vec(),
            MdbxAttachmentContentLimits {
                chunk_size: 4,
                max_plaintext_bytes: 64,
            },
        )
        .unwrap();

    let limits = default_attachment_presentation_limits();
    assert_eq!(limits.max_file_name_bytes, 4096);
    assert_eq!(limits.max_media_type_bytes, 512);
    assert_eq!(limits.max_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);

    let page = vault
        .list_attachment_summaries(
            collection.project_id.clone(),
            Some(object.object_id),
            10,
            None,
        )
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].attachment_id, attachment_id);
    assert_eq!(page.items[0].file_name, "message.eml");
    assert_eq!(page.items[0].media_type.as_deref(), Some("message/rfc822"));
}

#[test]
fn composite_write_operation_is_available_to_external_clients() {
    let vault_path = temp_vault_path("composite-write-operation");
    let vault = create_vault(
        vault_path.as_path_string(),
        "composite password 12345!".to_string(),
        "ffi-composite-device".to_string(),
    )
    .unwrap();
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();
    let attachment_id = Uuid::new_v4().to_string();
    let before = count_rows(vault_path.path(), "commits");
    let mut limits = default_composite_write_operation_limits();
    limits.write_limits.max_commands = 2;
    limits.write_limits.max_payload_bytes_per_command = 1024;
    limits.write_limits.max_payload_bytes = 1024;
    limits.write_limits.max_intent_bytes = 4096;
    limits.attachment_limits.max_commands = 1;
    limits.attachment_limits.max_plaintext_bytes_per_command = 64;
    limits.attachment_limits.max_plaintext_bytes = 64;
    limits.attachment_limits.chunk_size = 3;

    let result = vault
        .execute_composite_write_operation_with_limits(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: project_id.clone(),
                    title: "Mail".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Message".to_string(),
                    payload_json: "{}".to_string(),
                },
            ],
            vec![MdbxAttachmentBatchCommand::Create {
                attachment_id: attachment_id.clone(),
                project_id,
                entry_id: Some(entry_id),
                file_name: "message.eml".to_string(),
                media_type: Some("message/rfc822".to_string()),
                content: b"mail body".to_vec(),
            }],
            limits,
        )
        .unwrap();
    assert_eq!(count_rows(vault_path.path(), "commits"), before + 1);
    assert_eq!(result.operation.project_ids.len(), 1);
    assert_eq!(result.operation.entry_ids.len(), 1);
    assert_eq!(result.attachments[0].attachment_id, attachment_id.clone());
    assert_eq!(
        vault.read_attachment_content(attachment_id, 64).unwrap(),
        b"mail body"
    );
}

#[test]
fn bounded_write_operation_accepts_namespaced_object_types() {
    let vault_path = temp_vault_path("bounded-generic-write-operation");
    let vault = create_vault(
        vault_path.as_path_string(),
        "generic operation password 12345!".to_string(),
        "ffi-generic-operation-device".to_string(),
    )
    .unwrap();
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();
    let mut limits = default_write_operation_limits();
    limits.max_commands = 2;
    limits.max_payload_bytes_per_command = 1024;
    limits.max_payload_bytes = 1024;
    limits.max_intent_bytes = 4096;

    let result = vault
        .execute_write_operation_with_limits(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: project_id.clone(),
                    title: "Mail".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: entry_id.clone(),
                    project_id: project_id.clone(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Message".to_string(),
                    payload_json: r#"{"body":"hello"}"#.to_string(),
                },
            ],
            limits,
        )
        .unwrap();

    assert_eq!(result.entry_ids, vec![entry_id.clone()]);
    let stored = vault.get_object(project_id, entry_id).unwrap().unwrap();
    assert_eq!(stored.object_type_id, "com.monica.mail.message");
}

#[test]
fn write_operation_rolls_back_every_command_on_failure() {
    let vault_path = temp_vault_path("write-operation-rollback");
    let vault = create_vault(
        vault_path.as_path_string(),
        "rollback password 12345!".to_string(),
        "ffi-operation-device".to_string(),
    )
    .unwrap();
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();
    let missing_project_id = Uuid::new_v4().to_string();
    let before = count_rows(vault_path.path(), "commits");

    let result = vault.execute_write_operation(
        "ffi-operation-rollback".to_string(),
        "failing-batch".to_string(),
        vec![
            MdbxWriteCommand::CreateProject {
                project_id: project_id.clone(),
                title: "Rolled Back".to_string(),
            },
            MdbxWriteCommand::CreateEntry {
                entry_id,
                project_id: missing_project_id,
                entry_type: "note".to_string(),
                title: "Fails".to_string(),
                payload_json: r#"{"body":"failure"}"#.to_string(),
            },
        ],
    );
    assert!(result.is_err());

    let db = rusqlite::Connection::open(vault_path.path()).unwrap();
    let project_count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM projects WHERE project_id = ?1",
            rusqlite::params![project_id],
            |row| row.get(0),
        )
        .unwrap();
    let operation_count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM commit_operations WHERE operation_id = 'ffi-operation-rollback'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(project_count, 0);
    assert_eq!(operation_count, 0);
    assert_eq!(count_rows(vault_path.path(), "commits"), before);
}

#[test]
fn branch_history_pages_include_stable_identity_and_legacy_records() {
    let vault_path = temp_vault_path("commit-history");
    let vault = create_vault(
        vault_path.as_path_string(),
        "history password 12345!".to_string(),
        "ffi-history-device".to_string(),
    )
    .unwrap();
    let branches = vault.list_branches().unwrap();
    assert_eq!(branches.len(), 1);
    assert_eq!(branches[0].branch_name, "main");
    let main_branch_id = branches[0].branch_id.clone();
    let before = count_rows(vault_path.path(), "commits");
    assert!(vault
        .execute_write_operation_on_branch(
            "missing-branch-id".to_string(),
            "history-missing-branch".to_string(),
            "create-project".to_string(),
            vec![MdbxWriteCommand::CreateProject {
                project_id: Uuid::new_v4().to_string(),
                title: "Missing Branch".to_string(),
            }],
        )
        .is_err());
    assert_eq!(count_rows(vault_path.path(), "commits"), before);
    assert_eq!(count_rows(vault_path.path(), "commit_operations"), 0);

    let project_id = Uuid::new_v4().to_string();
    let execution = vault
        .execute_write_operation_on_branch(
            main_branch_id.clone(),
            "history-typed-summary".to_string(),
            "create-project".to_string(),
            vec![MdbxWriteCommand::CreateProject {
                project_id: project_id.clone(),
                title: "History Project".to_string(),
            }],
        )
        .unwrap();

    let first = vault.list_commit_history(1, None).unwrap();
    assert_eq!(first.items.len(), 1);
    assert!(first.items[0].operation_id.is_some());
    assert_eq!(first.items[0].changes[0].object_id, project_id);
    assert_eq!(first.items[0].changes[0].action, "create");
    assert_eq!(first.items[0].changes[0].fields, vec!["title"]);
    let detail = vault
        .get_commit_history(first.items[0].commit_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(detail.commit_id, first.items[0].commit_id);

    let first_v2 = vault.list_commit_history_v2(1, None).unwrap();
    assert_eq!(first_v2.items.len(), 1);
    assert_eq!(
        first_v2.items[0].branch_id.as_deref(),
        Some(main_branch_id.as_str())
    );
    assert_eq!(first_v2.items[0].item.commit_id, execution.commit_id);
    let detail_v2 = vault
        .get_commit_history_v2(first_v2.items[0].item.commit_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(
        detail_v2.branch_id.as_deref(),
        Some(main_branch_id.as_str())
    );
    assert_eq!(detail_v2.item.commit_id, execution.commit_id);

    let second = vault.list_commit_history(1, first.next_cursor).unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.items[0].legacy);
    assert!(second.items[0].operation_id.is_none());
    assert!(vault
        .get_commit_history("missing-commit".to_string())
        .unwrap()
        .is_none());
}

#[test]
fn commit_history_preserves_extended_commit_kind_at_ffi_boundary() {
    let vault_path = temp_vault_path("commit-history-kind");
    let vault = create_vault(
        vault_path.as_path_string(),
        "history kind password 12345!".to_string(),
        "ffi-history-kind-device".to_string(),
    )
    .unwrap();
    let source_project_id = Uuid::new_v4().to_string();
    let target_project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();

    vault
        .execute_write_operation(
            "history-kind-create".to_string(),
            "create-movable-entry".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: source_project_id.clone(),
                    title: "Source".to_string(),
                },
                MdbxWriteCommand::CreateProject {
                    project_id: target_project_id.clone(),
                    title: "Target".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: entry_id.clone(),
                    project_id: source_project_id.clone(),
                    entry_type: "login".to_string(),
                    title: "Movable".to_string(),
                    payload_json: "{}".to_string(),
                },
            ],
        )
        .unwrap();
    let moved = vault
        .execute_write_operation(
            "history-kind-move".to_string(),
            "move-entry".to_string(),
            vec![MdbxWriteCommand::MoveEntry {
                entry_id,
                project_id: source_project_id,
                target_project_id,
            }],
        )
        .unwrap();

    let page = vault.list_commit_history(1, None).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].commit_id, moved.commit_id);
    assert_eq!(page.items[0].commit_kind, "move");
    let detail = vault
        .get_commit_history(page.items[0].commit_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(detail.commit_kind, "move");
}

#[test]
fn project_hierarchy_commands_round_trip_at_ffi_boundary() {
    let vault_path = temp_vault_path("project-hierarchy");
    let vault = create_vault(
        vault_path.as_path_string(),
        "project hierarchy password 12345!".to_string(),
        "ffi-project-hierarchy-device".to_string(),
    )
    .unwrap();
    let parent_id = Uuid::new_v4().to_string();
    let child_id = Uuid::new_v4().to_string();

    vault
        .execute_write_operation(
            "ffi-project-hierarchy-create".to_string(),
            "project-hierarchy".to_string(),
            vec![
                MdbxWriteCommand::CreateProjectWithParent {
                    project_id: parent_id.clone(),
                    title: "Parent".to_string(),
                    parent_project_id: None,
                },
                MdbxWriteCommand::CreateProjectWithParent {
                    project_id: child_id.clone(),
                    title: "Child".to_string(),
                    parent_project_id: Some(parent_id.clone()),
                },
            ],
        )
        .unwrap();
    assert_eq!(
        vault
            .get_collection_summary(child_id.clone())
            .unwrap()
            .unwrap()
            .group_id
            .as_deref(),
        Some(parent_id.as_str())
    );

    let cycle = vault
        .execute_write_operation(
            "ffi-project-hierarchy-cycle".to_string(),
            "project-hierarchy".to_string(),
            vec![MdbxWriteCommand::MoveProject {
                project_id: parent_id.clone(),
                parent_project_id: Some(child_id.clone()),
            }],
        )
        .unwrap_err();
    assert!(cycle.to_string().contains("cycle"));

    vault
        .execute_write_operation(
            "ffi-project-hierarchy-rename".to_string(),
            "project-hierarchy".to_string(),
            vec![MdbxWriteCommand::RenameProject {
                project_id: child_id.clone(),
                title: "Renamed child".to_string(),
            }],
        )
        .unwrap();
    vault
        .execute_write_operation(
            "ffi-project-hierarchy-delete".to_string(),
            "project-hierarchy".to_string(),
            vec![MdbxWriteCommand::DeleteProject {
                project_id: child_id.clone(),
            }],
        )
        .unwrap();
    assert!(
        vault
            .get_collection_summary(child_id.clone())
            .unwrap()
            .unwrap()
            .deleted
    );
    vault
        .execute_write_operation(
            "ffi-project-hierarchy-restore".to_string(),
            "project-hierarchy".to_string(),
            vec![MdbxWriteCommand::RestoreProject {
                project_id: child_id.clone(),
                parent_project_id: Some(parent_id.clone()),
            }],
        )
        .unwrap();
    let restored = vault.get_collection_summary(child_id).unwrap().unwrap();
    assert!(!restored.deleted);
    assert_eq!(restored.title, "Renamed child");
    assert_eq!(restored.group_id.as_deref(), Some(parent_id.as_str()));
}

#[test]
fn creates_reopens_and_preserves_generic_entries() {
    let vault_path = temp_vault_path("roundtrip");
    let path = vault_path.as_path_string();
    let password = "中文 password 12345!";
    let device_id = "ffi-test-device";

    let vault = create_vault(path.clone(), password.to_string(), device_id.to_string()).unwrap();
    let project = vault.create_project("Personal".to_string()).unwrap();

    let payloads = [
        (
            "login",
            "GitHub Login",
            r#"{"kind":"password","username":"alice","password":"secret","favorite":false}"#,
        ),
        (
            "note",
            "Recovery Codes",
            r#"{"kind":"note","body":"code-1\ncode-2","favorite":true}"#,
        ),
        (
            "totp",
            "GitHub TOTP",
            r#"{"kind":"totp","secret":"JBSWY3DPEHPK3PXP","period":30,"digits":6}"#,
        ),
        (
            "card",
            "Everyday Visa",
            r#"{"kind":"card","cardholderName":"Alice","number":"4111111111111111"}"#,
        ),
        (
            "identity",
            "Passport",
            r#"{"kind":"identity","documentType":"passport","fullName":"Alice Example"}"#,
        ),
    ];

    for (entry_type, title, payload_json) in payloads {
        let created = vault
            .create_entry(
                project.project_id.clone(),
                entry_type.to_string(),
                title.to_string(),
                payload_json.to_string(),
            )
            .unwrap();
        assert_eq!(created.entry_type, entry_type);
        assert_eq!(created.title, title);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&created.payload_json).unwrap(),
            serde_json::from_str::<serde_json::Value>(payload_json).unwrap()
        );
    }
    drop(vault);

    let reopened = open_vault(path.clone(), password.to_string(), device_id.to_string()).unwrap();
    let all_entries = reopened
        .list_entries(project.project_id.clone(), None)
        .unwrap();
    assert_eq!(all_entries.len(), 5);

    let login_entries = reopened
        .list_entries(project.project_id.clone(), Some("login".to_string()))
        .unwrap();
    assert_eq!(login_entries.len(), 1);
    assert_eq!(login_entries[0].entry_type, "login");
    assert_eq!(login_entries[0].title, "GitHub Login");

    let invalid_payload = reopened.create_entry(
        project.project_id.clone(),
        "login".to_string(),
        "Broken".to_string(),
        "{not json".to_string(),
    );
    assert!(invalid_payload.is_err());
}

#[test]
fn generic_object_summaries_are_paginated_and_query_bound() {
    let vault_path = temp_vault_path("object-summaries");
    let vault = create_vault(
        vault_path.as_path_string(),
        "summary password 12345!".to_string(),
        "ffi-summary-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    let other_collection = vault.create_project("Other".to_string()).unwrap();
    for index in 0..5 {
        vault
            .create_object(
                collection.project_id.clone(),
                "com.monica.mail.message".to_string(),
                format!("Message {index}"),
                format!(r#"{{"body":"secret body {index}"}}"#),
                4,
            )
            .unwrap();
    }

    let first = vault
        .list_object_summaries(
            collection.project_id.clone(),
            Some("com.monica.mail.message".to_string()),
            2,
            None,
        )
        .unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.next_cursor.is_some());
    assert!(first.items.iter().all(|item| {
        item.collection_id == collection.project_id
            && item.object_type_id == "com.monica.mail.message"
            && item.payload_schema_version == 4
            && !item.head_commit_id.is_empty()
    }));

    let second = vault
        .list_object_summaries(
            collection.project_id.clone(),
            Some("com.monica.mail.message".to_string()),
            2,
            first.next_cursor.clone(),
        )
        .unwrap();
    assert_eq!(second.items.len(), 2);
    assert!(second.next_cursor.is_some());
    let third = vault
        .list_object_summaries(
            collection.project_id.clone(),
            Some("com.monica.mail.message".to_string()),
            2,
            second.next_cursor,
        )
        .unwrap();
    assert_eq!(third.items.len(), 1);
    assert!(third.next_cursor.is_none());

    assert!(vault
        .list_object_summaries(
            other_collection.project_id,
            Some("com.monica.mail.message".to_string()),
            2,
            first.next_cursor,
        )
        .is_err());
    let full = vault
        .list_objects(
            collection.project_id,
            Some("com.monica.mail.message".to_string()),
        )
        .unwrap();
    assert_eq!(full.len(), 5);
    assert!(full[0].payload_json.contains("secret body"));
}

#[test]
fn deleted_object_summary_smoke_path_is_bounded_and_payload_free() {
    let vault_path = temp_vault_path("deleted-object-summaries");
    let vault = create_vault(
        vault_path.as_path_string(),
        "deleted summary password 12345!".to_string(),
        "ffi-deleted-summary-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    let other_collection = vault.create_project("Other".to_string()).unwrap();
    for index in 0..3 {
        let object = vault
            .create_object(
                collection.project_id.clone(),
                "com.monica.mail.message".to_string(),
                format!("Deleted {index}"),
                format!(r#"{{"body":"secret {index}"}}"#),
                9,
            )
            .unwrap();
        vault
            .delete_entry(collection.project_id.clone(), object.object_id)
            .unwrap();
    }
    let other = vault
        .create_object(
            other_collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Other deleted".to_string(),
            r#"{"body":"other secret"}"#.to_string(),
            10,
        )
        .unwrap();
    vault
        .delete_entry(other_collection.project_id.clone(), other.object_id)
        .unwrap();
    rusqlite::Connection::open(vault_path.path())
        .unwrap()
        .execute(
            "UPDATE entries SET payload_ct = X'00', updated_at = '2026-07-25T00:00:00Z'",
            [],
        )
        .unwrap();

    let page = vault
        .list_deleted_object_summaries(
            collection.project_id.clone(),
            Some("com.monica.mail.message".to_string()),
            2,
            None,
        )
        .unwrap();
    assert_eq!(page.items.len(), 2);
    assert!(page.items.iter().all(|item| item.deleted));
    let next = vault
        .list_deleted_object_summaries(
            collection.project_id,
            Some("com.monica.mail.message".to_string()),
            2,
            page.next_cursor,
        )
        .unwrap();
    assert_eq!(next.items.len(), 1);

    let global = vault
        .list_all_deleted_object_summaries(Some("com.monica.mail.message".to_string()), 4, None)
        .unwrap();
    assert_eq!(global.items.len(), 4);
    assert!(global
        .items
        .iter()
        .any(|item| item.payload_schema_version == 10));
}

#[test]
fn ffi_object_disclosure_is_typed_and_policy_first() {
    let vault_path = temp_vault_path("object-disclosure");
    let vault = create_vault(
        vault_path.as_path_string(),
        "disclosure password 12345!".to_string(),
        "ffi-disclosure-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    let object = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Subject".to_string(),
            r#"{"body":"secret body"}"#.to_string(),
            2,
        )
        .unwrap();

    let summary = vault
        .get_object_summary(object.object_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(summary.title, "Subject");
    assert_eq!(summary.payload_schema_version, 2);

    let allowed = vault.reveal_object(object.object_id.clone()).unwrap();
    assert_eq!(
        allowed.authorization.outcome,
        MdbxAuthorizationOutcome::Allow
    );
    assert_eq!(
        allowed.object.unwrap().payload_json,
        r#"{"body":"secret body"}"#
    );

    vault
        .set_tiga_profile(MdbxTigaMode::Power, None, None, standard_device())
        .unwrap();
    rusqlite::Connection::open(vault_path.path())
        .unwrap()
        .execute(
            "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
            [&object.object_id],
        )
        .unwrap();

    let denied = vault
        .reveal_object_with_device_context(object.object_id.clone(), standard_device())
        .unwrap();
    assert!(denied.object.is_none());
    assert!(!matches!(
        denied.authorization.outcome,
        MdbxAuthorizationOutcome::Allow | MdbxAuthorizationOutcome::AllowWithConstraints
    ));
    assert!(vault
        .get_object(collection.project_id, object.object_id)
        .is_err());

    let reveal_events = vault
        .list_security_audit_events(20)
        .unwrap()
        .into_iter()
        .filter(|event| event.operation == MdbxTigaOperation::RevealSecret)
        .collect::<Vec<_>>();
    assert_eq!(reveal_events.len(), 2);
}

#[test]
fn ffi_metadata_disclosure_is_typed_for_external_clients() {
    let vault_path = temp_vault_path("metadata-disclosure");
    let vault = create_vault(
        vault_path.as_path_string(),
        "metadata disclosure password 12345!".to_string(),
        "ffi-metadata-disclosure-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    let source = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Source".to_string(),
            r#"{"body":"source"}"#.to_string(),
            1,
        )
        .unwrap();
    let target = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Target".to_string(),
            r#"{"body":"target"}"#.to_string(),
            1,
        )
        .unwrap();
    let relation = vault
        .create_object_relation(
            source.object_id.clone(),
            target.object_id.clone(),
            "com.monica.mail.reply-to".to_string(),
            r#"{"position":1}"#.to_string(),
            1,
        )
        .unwrap();
    let label = vault
        .create_object_label(
            collection.project_id.clone(),
            "Important".to_string(),
            r#"{"color":"red"}"#.to_string(),
            1,
        )
        .unwrap();

    assert_eq!(
        default_object_metadata_disclosure_limits().max_payload_bytes,
        8 * 1024 * 1024
    );
    let relation_result = vault
        .reveal_object_relation_with_device_context_and_limits(
            relation.relation_id,
            standard_device(),
            MdbxObjectMetadataDisclosureLimits {
                max_payload_bytes: 1024,
            },
        )
        .unwrap();
    assert_eq!(
        relation_result.relation.unwrap().payload_json,
        r#"{"position":1}"#
    );
    assert_eq!(
        relation_result.source_authorization.scope.scope_type,
        MdbxTigaScopeType::Entry
    );
    assert_eq!(
        relation_result.source_authorization.scope.scope_id,
        Some(source.object_id)
    );
    assert_eq!(
        relation_result.target_authorization.scope.scope_id,
        Some(target.object_id)
    );

    let label_result = vault.reveal_object_label(label.label_id).unwrap();
    assert_eq!(
        label_result.label.unwrap().payload_json,
        r#"{"color":"red"}"#
    );
    assert_eq!(
        label_result.project_authorization.scope,
        MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Project,
            scope_id: Some(collection.project_id),
        }
    );
}

#[test]
fn updates_deletes_restores_and_moves_generic_entry() {
    let vault_path = temp_vault_path("mutation");
    let path = vault_path.as_path_string();
    let password = "中文 password 12345!";
    let device_id = "ffi-test-device";

    let vault = create_vault(path.clone(), password.to_string(), device_id.to_string()).unwrap();
    let source = vault.create_project("Source".to_string()).unwrap();
    let target = vault.create_project("Target".to_string()).unwrap();
    let created = vault
        .create_entry(
            source.project_id.clone(),
            "login".to_string(),
            "Original".to_string(),
            r#"{"kind":"password","username":"alice","favorite":false}"#.to_string(),
        )
        .unwrap();

    let updated = vault
        .update_entry(
            source.project_id.clone(),
            created.entry_id.clone(),
            "login".to_string(),
            "Updated".to_string(),
            r#"{"kind":"password","username":"alice@example.com","favorite":true}"#.to_string(),
        )
        .unwrap();
    assert_eq!(updated.entry_id, created.entry_id);
    assert_eq!(updated.title, "Updated");
    assert_eq!(updated.entry_type, "login");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&updated.payload_json).unwrap()["favorite"],
        true
    );

    vault
        .delete_entry(source.project_id.clone(), created.entry_id.clone())
        .unwrap();
    assert!(vault
        .list_entries(source.project_id.clone(), Some("login".to_string()))
        .unwrap()
        .is_empty());
    let deleted = vault
        .list_deleted_entries(source.project_id.clone(), Some("login".to_string()))
        .unwrap();
    assert_eq!(deleted.len(), 1);
    assert!(deleted[0].deleted);

    let restored = vault
        .restore_entry(source.project_id.clone(), created.entry_id.clone())
        .unwrap();
    assert!(!restored.deleted);

    let moved = vault
        .move_entry(
            source.project_id.clone(),
            created.entry_id.clone(),
            target.project_id.clone(),
        )
        .unwrap();
    assert_eq!(moved.project_id, target.project_id);
    assert_eq!(moved.entry_id, created.entry_id);
}

#[test]
fn clients_can_schedule_and_execute_permanent_entry_purge() {
    let vault_path = temp_vault_path("permanent-entry-purge");
    let path = vault_path.as_path_string();
    let password = "permanent purge password 12345!";
    let device_id = "ffi-permanent-purge-device";

    let vault = create_vault(path.clone(), password.to_string(), device_id.to_string()).unwrap();
    drop(vault);
    let vault = open_vault(path.clone(), password.to_string(), device_id.to_string()).unwrap();
    let project = vault.create_project("Purge test".to_string()).unwrap();
    let entry = vault
        .create_entry(
            project.project_id.clone(),
            "note".to_string(),
            "Temporary".to_string(),
            r#"{"kind":"note","body":"erase after retention"}"#.to_string(),
        )
        .unwrap();

    vault
        .delete_entry(project.project_id.clone(), entry.entry_id.clone())
        .unwrap();
    let tombstone = vault
        .find_tombstone_by_target(entry.entry_id.clone())
        .unwrap()
        .unwrap();
    let schedule = vault
        .schedule_tombstone_purge(
            tombstone.tombstone_id.clone(),
            tombstone.deleted_at.clone(),
            standard_device(),
        )
        .unwrap();
    assert_eq!(schedule.tombstone_id, tombstone.tombstone_id);
    assert_eq!(schedule.purge_eligible_at, tombstone.deleted_at);

    std::thread::sleep(std::time::Duration::from_secs(1));
    let receipt = vault
        .purge_tombstone(tombstone.tombstone_id.clone(), standard_device())
        .unwrap();
    assert_eq!(receipt.tombstone_id, tombstone.tombstone_id);
    assert_eq!(receipt.target_object_type, "entry");
    assert_eq!(receipt.target_object_id, entry.entry_id);
    assert_eq!(receipt.delete_clock, tombstone.delete_clock);
    assert!(!receipt.integrity_tag.is_empty());
    assert!(vault
        .find_tombstone_by_target(receipt.target_object_id.clone())
        .unwrap()
        .is_none());
    assert!(vault
        .list_deleted_entries(project.project_id.clone(), Some("note".to_string()))
        .unwrap()
        .is_empty());
    assert_eq!(
        vault
            .find_permanent_purge_receipt_by_target(
                "entry".to_string(),
                receipt.target_object_id.clone(),
            )
            .unwrap()
            .unwrap(),
        receipt
    );

    let retried = vault
        .purge_tombstone(tombstone.tombstone_id.clone(), standard_device())
        .unwrap();
    assert_eq!(retried.purge_id, receipt.purge_id);
    assert_eq!(retried.purge_commit_id, receipt.purge_commit_id);
    assert_eq!(count_rows(vault_path.path(), "purge_receipts"), 1);

    drop(vault);
    let reopened = open_vault(path, password.to_string(), device_id.to_string()).unwrap();
    assert_eq!(
        reopened
            .find_permanent_purge_receipt_by_tombstone(tombstone.tombstone_id)
            .unwrap()
            .unwrap(),
        receipt
    );
}

#[test]
fn namespaced_objects_roundtrip_through_the_generic_client_api() {
    let vault_path = temp_vault_path("generic-object-api");
    let vault = create_vault(
        vault_path.as_path_string(),
        "generic object password 12345!".to_string(),
        "ffi-generic-object-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Encrypted mail".to_string()).unwrap();

    let created = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "MDBX2 design".to_string(),
            r#"{"from":"alice@example.com","body":"opaque domain payload"}"#.to_string(),
            3,
        )
        .unwrap();
    assert_eq!(created.collection_id, collection.project_id);
    assert_eq!(created.object_type_id, "com.monica.mail.message");
    assert_eq!(created.payload_schema_version, 3);

    let fetched = vault
        .get_object(collection.project_id.clone(), created.object_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(fetched, created);

    let listed = vault
        .list_objects(
            collection.project_id.clone(),
            Some("com.monica.mail.message".to_string()),
        )
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].object_id, created.object_id);

    let updated = vault
        .update_object(
            collection.project_id.clone(),
            created.object_id.clone(),
            "com.monica.mail.message".to_string(),
            "MDBX2 design updated".to_string(),
            r#"{"from":"alice@example.com","body":"new authenticated payload"}"#.to_string(),
            4,
        )
        .unwrap();
    assert_eq!(updated.object_id, created.object_id);
    assert_eq!(updated.payload_schema_version, 4);
    assert_eq!(updated.title, "MDBX2 design updated");

    let legacy_result = vault.create_entry(
        collection.project_id.clone(),
        "com.monica.bookmark".to_string(),
        "Legacy adapter".to_string(),
        "{}".to_string(),
    );
    assert!(matches!(
        legacy_result,
        Err(MdbxFfiError::InvalidEntryType { .. })
    ));

    let invalid_object = vault.create_object(
        collection.project_id,
        "Mail.Message".to_string(),
        "Invalid".to_string(),
        "{}".to_string(),
        1,
    );
    assert!(matches!(
        invalid_object,
        Err(MdbxFfiError::InvalidObjectTypeId { .. })
    ));
}

#[test]
fn generic_relation_and_label_client_apis_preserve_encrypted_metadata() {
    let vault_path = temp_vault_path("generic-metadata-api");
    let vault = create_vault(
        vault_path.as_path_string(),
        "generic metadata password 12345!".to_string(),
        "ffi-generic-metadata-device".to_string(),
    )
    .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    let first = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "First".to_string(),
            r#"{"body":"first"}"#.to_string(),
            1,
        )
        .unwrap();
    let second = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Second".to_string(),
            r#"{"body":"second"}"#.to_string(),
            1,
        )
        .unwrap();

    let relation = vault
        .create_object_relation(
            first.object_id.clone(),
            second.object_id.clone(),
            "com.monica.mail.reply-to".to_string(),
            r#"{"position":1}"#.to_string(),
            2,
        )
        .unwrap();
    assert_eq!(relation.payload_schema_version, 2);
    assert_eq!(
        vault
            .list_object_relations_from(
                first.object_id.clone(),
                Some("com.monica.mail.reply-to".to_string()),
            )
            .unwrap(),
        vec![relation.clone()]
    );
    let relation = vault
        .update_object_relation(
            relation.relation_id.clone(),
            relation.relation_kind.clone(),
            r#"{"position":2}"#.to_string(),
            3,
        )
        .unwrap();
    assert_eq!(relation.payload_schema_version, 3);

    let label = vault
        .create_object_label(
            collection.project_id,
            "Important".to_string(),
            r#"{"color":"red"}"#.to_string(),
            1,
        )
        .unwrap();
    let assignment = vault
        .assign_object_label(first.object_id.clone(), label.label_id.clone())
        .unwrap();
    assert_eq!(
        vault
            .list_object_label_assignments(first.object_id.clone())
            .unwrap(),
        vec![assignment.clone()]
    );
    let label = vault
        .update_object_label(
            label.label_id,
            "Priority".to_string(),
            r#"{"color":"orange"}"#.to_string(),
            2,
        )
        .unwrap();
    assert_eq!(label.name, "Priority");
    assert_eq!(label.payload_schema_version, 2);

    vault
        .remove_object_label_assignment(assignment.assignment_id)
        .unwrap();
    vault.delete_object_label(label.label_id).unwrap();
    vault.delete_object_relation(relation.relation_id).unwrap();

    let invalid_kind = vault.create_object_relation(
        first.object_id,
        second.object_id,
        "reply-to".to_string(),
        "{}".to_string(),
        1,
    );
    assert!(matches!(
        invalid_kind,
        Err(MdbxFfiError::InvalidRelationKind { .. })
    ));
}

#[test]
fn opens_with_security_key_material() {
    let vault_path = temp_vault_path("security-key");
    let path = vault_path.as_path_string();
    let password = "中文 password 12345!";
    let device_id = "ffi-test-device";
    let key_material = b"local-security-key-material".to_vec();

    let vault = create_vault(path.clone(), password.to_string(), device_id.to_string()).unwrap();
    let project = vault.create_project("Personal".to_string()).unwrap();
    vault
        .setup_local_security_key_unlock(key_material.clone())
        .unwrap();
    drop(vault);

    let reopened =
        open_vault_with_security_key(path.clone(), key_material, device_id.to_string()).unwrap();
    let info = reopened.info();
    assert_eq!(info.device_id, device_id);
    reopened
        .create_entry(
            project.project_id,
            "note".to_string(),
            "Unlocked".to_string(),
            r#"{"kind":"note","body":"opened with security key"}"#.to_string(),
        )
        .unwrap();
}

#[test]
fn resets_master_password_for_unlocked_vault() {
    let vault_path = temp_vault_path("reset-password");
    let path = vault_path.as_path_string();
    let old_password = "中文 password 12345!";
    let new_password = "new 中文 password 67890!";
    let device_id = "ffi-test-device";

    let vault = create_vault(
        path.clone(),
        old_password.to_string(),
        device_id.to_string(),
    )
    .unwrap();
    vault
        .reset_master_password(new_password.to_string())
        .unwrap();
    drop(vault);

    assert!(open_vault(
        path.clone(),
        old_password.to_string(),
        device_id.to_string()
    )
    .is_err());
    let reopened = open_vault(
        path.clone(),
        new_password.to_string(),
        device_id.to_string(),
    )
    .unwrap();
    assert_eq!(reopened.info().device_id, device_id);
}

#[test]
fn creates_vault_with_explicit_tiga_mode() {
    let vault_path = temp_vault_path("tiga-mode");
    let path = vault_path.as_path_string();
    let password = "中文 password 12345!";
    let device_id = "ffi-test-device";

    let vault = create_vault_with_tiga_mode(
        path.clone(),
        password.to_string(),
        device_id.to_string(),
        MdbxTigaMode::Sky,
    )
    .unwrap();
    assert_eq!(vault.info().device_id, device_id);
    drop(vault);

    let conn = rusqlite::Connection::open(vault_path.path()).unwrap();
    let mode: String = conn
        .query_row(
            "SELECT default_tiga_mode FROM vault_meta LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(mode, "sky");
}

#[test]
fn clients_can_inspect_and_explicitly_upgrade_legacy_vault() {
    let vault_path = temp_vault_path("migration-plan");
    {
        let conn = rusqlite::Connection::open(vault_path.path()).unwrap();
        mdbx_storage::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('ffi-legacy-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
            [],
        )
        .unwrap();
    }

    let plan = inspect_vault_migration(vault_path.as_path_string()).unwrap();
    assert!(plan.initialized);
    assert_eq!(plan.format_version.as_deref(), Some("MDBX-1"));
    assert_eq!(plan.schema_version, Some(1));
    assert!(plan.requires_upgrade);
    assert!(!plan.unknown_critical_extensions);

    let upgraded = upgrade_vault(vault_path.as_path_string()).unwrap();
    assert_eq!(upgraded.format_version.as_deref(), Some("MDBX-2"));
    assert_eq!(upgraded.schema_version, Some(CURRENT_SCHEMA_VERSION));
    assert!(!upgraded.requires_upgrade);

    let stored_format: String = rusqlite::Connection::open(vault_path.path())
        .unwrap()
        .query_row("SELECT format_version FROM vault_meta", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(stored_format, "MDBX-2");
    assert_eq!(count_rows(vault_path.path(), "purge_receipts"), 0);
}

#[test]
fn migration_integrity_gate_rejects_damaged_legacy_vault_without_writing() {
    let vault_path = temp_vault_path("migration-integrity-gate");
    {
        let conn = rusqlite::Connection::open(vault_path.path()).unwrap();
        mdbx_storage::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute(
            "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('ffi-damaged-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entries
                (entry_id, project_id, entry_type, payload_ct, object_clock,
                 head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
             VALUES ('orphan-entry', 'missing-project', 'note', X'01', '{}',
                     'missing-commit', '2026-01-01T00:00:00Z',
                     '2026-01-01T00:00:00Z', 'device-1', 'device-1')",
            [],
        )
        .unwrap();
    }
    let before = fs::read(vault_path.path()).unwrap();
    let inspection_error = inspect_vault_migration(vault_path.as_path_string()).unwrap_err();
    assert!(inspection_error
        .to_string()
        .contains("foreign_key_check failed"));

    let upgrade_error = upgrade_vault(vault_path.as_path_string()).unwrap_err();
    assert!(upgrade_error
        .to_string()
        .contains("foreign_key_check failed"));
    let open_error = open_vault(
        vault_path.as_path_string(),
        "unused password 12345!".to_string(),
        "ffi-damaged-device".to_string(),
    )
    .err()
    .unwrap();
    assert!(open_error.to_string().contains("foreign_key_check failed"));
    assert_eq!(fs::read(vault_path.path()).unwrap(), before);
    let format: String = rusqlite::Connection::open(vault_path.path())
        .unwrap()
        .query_row("SELECT format_version FROM vault_meta", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(format, "MDBX-1");
}

#[test]
fn clients_can_backup_legacy_vault_before_explicit_upgrade() {
    let vault_path = temp_vault_path("pre-migration-backup-source");
    let backup_path = temp_vault_path("pre-migration-backup-target");
    {
        let conn = rusqlite::Connection::open(vault_path.path()).unwrap();
        mdbx_storage::schema::v1::create_all_tables(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_meta (vault_id, format_version, created_at, updated_at,
             default_tiga_mode, active_key_epoch_id, compat_flags, critical_extensions)
             VALUES ('ffi-pre-migration-vault', 'MDBX-1', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', 'multi', 'epoch-1', '', '')",
            [],
        )
        .unwrap();
    }
    let source_before = fs::read(vault_path.path()).unwrap();

    let info =
        create_portable_backup(vault_path.as_path_string(), backup_path.as_path_string()).unwrap();

    assert_eq!(info.vault_id, "ffi-pre-migration-vault");
    assert_eq!(info.format_version, "MDBX-1");
    assert_eq!(info.schema_version, 1);
    assert_eq!(fs::read(vault_path.path()).unwrap(), source_before);
    let source_plan = inspect_vault_migration(vault_path.as_path_string()).unwrap();
    let backup_plan = inspect_vault_migration(backup_path.as_path_string()).unwrap();
    assert_eq!(source_plan, backup_plan);
    assert!(source_plan.requires_upgrade);

    let upgraded = upgrade_vault(vault_path.as_path_string()).unwrap();
    assert_eq!(upgraded.format_version.as_deref(), Some("MDBX-2"));
    assert_eq!(
        inspect_vault_migration(backup_path.as_path_string())
            .unwrap()
            .format_version
            .as_deref(),
        Some("MDBX-1")
    );
}

#[test]
fn exposes_tiga_policy_typed_authorization_and_exact_exceptions() {
    let vault_path = temp_vault_path("tiga-runtime");
    let vault = create_vault(
        vault_path.as_path_string(),
        "中文 password 12345!".to_string(),
        "ffi-policy-device".to_string(),
    )
    .unwrap();

    let policy = vault.resolve_tiga_policy(vault_scope()).unwrap();
    assert_eq!(policy.profile, MdbxTigaMode::Multi);
    assert_eq!(policy.compliance, MdbxPolicyCompliance::Compliant);
    assert_eq!(policy.idle_timeout_secs, 600);
    assert!(policy.security_key_recommended);

    let before = vault.active_session_info().unwrap().unwrap();
    let copy = vault
        .authorize_tiga_operation(
            vault_scope(),
            MdbxTigaOperation::CopySecret,
            standard_device(),
        )
        .unwrap();
    assert_eq!(copy.outcome, MdbxAuthorizationOutcome::AllowWithConstraints);
    assert!(copy.constraints.iter().any(|constraint| {
        constraint.kind == MdbxAuthorizationConstraintKind::ClearClipboardAfterSeconds
            && constraint.seconds == Some(30)
    }));
    let after = vault.active_session_info().unwrap().unwrap();
    assert_eq!(
        after.authenticated_at_unix_secs,
        before.authenticated_at_unix_secs
    );
    assert!(after.last_activity_at_unix_secs >= before.last_activity_at_unix_secs);

    let denied = vault
        .authorize_tiga_operation(
            vault_scope(),
            MdbxTigaOperation::RevealSecret,
            MdbxDeviceContext {
                assurance: MdbxDeviceAssurance::Unknown,
                secure_clipboard_available: false,
                screen_capture_protection_available: false,
                secure_temp_files_available: false,
            },
        )
        .unwrap();
    assert_eq!(denied.outcome, MdbxAuthorizationOutcome::Deny);
    assert!(denied
        .reasons
        .contains(&MdbxAuthorizationReason::DeviceAssuranceInsufficient));

    let weakened = vault
        .set_tiga_profile(
            MdbxTigaMode::Sky,
            Some("portable recovery required for travel".to_string()),
            None,
            standard_device(),
        )
        .unwrap();
    assert_eq!(weakened.profile, MdbxTigaMode::Sky);
    assert_eq!(weakened.compliance, MdbxPolicyCompliance::Exception);
    assert!(weakened.exception_id.is_some());

    let audit = vault.list_security_audit_events(20).unwrap();
    assert!(audit
        .iter()
        .any(|event| event.operation == MdbxTigaOperation::CopySecret));
    assert!(audit
        .iter()
        .any(|event| event.operation == MdbxTigaOperation::ChangeSecurityPolicy));
    let audit_v2 = vault.list_security_audit_events_v2(20).unwrap();
    let policy_change = audit_v2
        .iter()
        .find(|event| event.operation == MdbxTigaOperation::ChangeSecurityPolicy)
        .unwrap();
    assert!(policy_change.operation_id.is_some());
    assert!(policy_change.commit_id.is_some());
    assert_eq!(policy_change.policy_version, Some(2));
    assert_eq!(
        policy_change.policy_fingerprint.as_deref().map(<[u8]>::len),
        Some(32)
    );
    let copy_v2 = audit_v2
        .iter()
        .find(|event| event.operation == MdbxTigaOperation::CopySecret)
        .unwrap();
    assert!(copy_v2.commit_id.is_none());
    assert_eq!(copy_v2.policy_version, Some(2));
}

#[test]
fn clients_can_rotate_key_epochs_with_tiga_authorization() {
    let vault_path = temp_vault_path("key-epoch-rotation");
    let vault = create_vault(
        vault_path.as_path_string(),
        "rotation 中文 password 12345!".to_string(),
        "ffi-rotation-device".to_string(),
    )
    .unwrap();
    let before_epoch = active_key_epoch_id(vault_path.path());
    let before_commits = count_rows(vault_path.path(), "commits");

    let denied = vault.rotate_key_epoch(MdbxDeviceContext {
        assurance: MdbxDeviceAssurance::Unknown,
        secure_clipboard_available: false,
        screen_capture_protection_available: false,
        secure_temp_files_available: false,
    });
    assert!(denied.is_err());
    assert_eq!(active_key_epoch_id(vault_path.path()), before_epoch);
    assert_eq!(count_rows(vault_path.path(), "commits"), before_commits);

    let rotated = vault.rotate_key_epoch(standard_device()).unwrap();
    assert_eq!(rotated.previous_epoch_id, before_epoch);
    assert_ne!(rotated.active_epoch_id, rotated.previous_epoch_id);
    assert_eq!(
        active_key_epoch_id(vault_path.path()),
        rotated.active_epoch_id
    );
    assert_eq!(count_rows(vault_path.path(), "commits"), before_commits + 1);

    let db = rusqlite::Connection::open(vault_path.path()).unwrap();
    let commit: (String, String) = db
        .query_row(
            "SELECT commit_kind, change_scope FROM commits WHERE commit_id = ?1",
            rusqlite::params![rotated.commit_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        commit,
        ("key-rotation".to_string(), "key-epoch".to_string())
    );
}

#[test]
fn power_vault_can_complete_combined_factor_remediation_through_ffi() {
    let vault_path = temp_vault_path("power-remediation");
    let path = vault_path.as_path_string();
    let password = "power 中文 password 12345!";
    let key_material = b"power-security-key-material".to_vec();
    let device_id = "ffi-power-device";

    let vault = create_vault_with_tiga_mode(
        path.clone(),
        password.to_string(),
        device_id.to_string(),
        MdbxTigaMode::Power,
    )
    .unwrap();
    assert_eq!(
        vault.resolve_tiga_policy(vault_scope()).unwrap().compliance,
        MdbxPolicyCompliance::RemediationRequired
    );
    let password_method = vault
        .list_unlock_methods()
        .unwrap()
        .into_iter()
        .find(|method| method.method_type == MdbxUnlockMethodType::Password)
        .unwrap();

    vault
        .setup_password_security_key_unlock(
            password.to_string(),
            key_material.clone(),
            standard_device(),
        )
        .unwrap();
    vault
        .remove_unlock_method(password_method.method_id, standard_device())
        .unwrap();
    let assessment = vault.assess_tiga_unlock_policy().unwrap();
    assert!(assessment.satisfies_policy);
    assert_eq!(assessment.configured_methods.len(), 1);
    assert_eq!(
        assessment.configured_methods[0],
        MdbxUnlockMethodType::PasswordSecurityKey
    );
    drop(vault);

    let reopened = open_vault_with_password_security_key(
        path,
        password.to_string(),
        key_material,
        device_id.to_string(),
    )
    .unwrap();
    assert_eq!(
        reopened
            .active_session_info()
            .unwrap()
            .unwrap()
            .unlock_method,
        MdbxUnlockMethodType::PasswordSecurityKey
    );
    assert_eq!(
        reopened
            .resolve_tiga_policy(vault_scope())
            .unwrap()
            .compliance,
        MdbxPolicyCompliance::Compliant
    );
    let reveal = reopened
        .authorize_tiga_operation(
            vault_scope(),
            MdbxTigaOperation::RevealSecret,
            trusted_device(),
        )
        .unwrap();
    assert_eq!(
        reveal.outcome,
        MdbxAuthorizationOutcome::AllowWithConstraints
    );
    assert!(reveal.constraints.iter().any(|constraint| {
        constraint.kind == MdbxAuthorizationConstraintKind::PreventScreenCapture
    }));
    let export = reopened
        .authorize_tiga_operation(
            vault_scope(),
            MdbxTigaOperation::ExportData,
            trusted_device(),
        )
        .unwrap();
    assert_eq!(export.outcome, MdbxAuthorizationOutcome::Deny);
    assert!(export
        .reasons
        .contains(&MdbxAuthorizationReason::OperationDisabled));
}
