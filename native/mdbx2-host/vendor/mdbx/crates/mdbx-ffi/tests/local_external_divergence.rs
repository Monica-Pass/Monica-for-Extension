use std::fs;

use mdbx_ffi::{
    create_portable_backup, create_vault_with_tiga_mode, open_vault, MdbxTigaMode, MdbxWriteCommand,
};
use uuid::Uuid;

#[test]
fn whole_file_replacement_loses_divergent_history_while_sync_surfaces_conflict() {
    let directory = tempfile::tempdir().expect("create divergence test directory");
    let base_path = directory.path().join("base.mdbx");
    let overwrite_a_path = directory.path().join("overwrite-a.mdbx");
    let overwrite_b_path = directory.path().join("overwrite-b.mdbx");
    let sync_a_path = directory.path().join("sync-a.mdbx");
    let sync_b_path = directory.path().join("sync-b.mdbx");
    let shared_path = directory.path().join("shared.mdbx");
    let bundle_path = directory.path().join("a-to-b.mdbx-sync");
    let password = "MDBX2 local external divergence password 12345!";
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();

    create_vault_with_tiga_mode(
        base_path.to_string_lossy().into_owned(),
        password.to_string(),
        "base-device".to_string(),
        MdbxTigaMode::Sky,
    )
    .expect("create base vault")
    .execute_write_operation(
        Uuid::new_v4().to_string(),
        "create-shared-base".to_string(),
        vec![
            MdbxWriteCommand::CreateProject {
                project_id: project_id.clone(),
                title: "Shared project".to_string(),
            },
            MdbxWriteCommand::CreateEntry {
                entry_id: entry_id.clone(),
                project_id: project_id.clone(),
                entry_type: "login".to_string(),
                title: "Base title".to_string(),
                payload_json: r#"{"source":"base"}"#.to_string(),
            },
        ],
    )
    .expect("create base object");

    for destination in [
        &overwrite_a_path,
        &overwrite_b_path,
        &sync_a_path,
        &sync_b_path,
    ] {
        create_portable_backup(
            base_path.to_string_lossy().into_owned(),
            destination.to_string_lossy().into_owned(),
        )
        .expect("clone base vault");
    }

    let overwrite_a = open_vault(
        overwrite_a_path.to_string_lossy().into_owned(),
        password.to_string(),
        "overwrite-device-a".to_string(),
    )
    .expect("open overwrite A");
    let overwrite_a_commit =
        update_shared_entry(&overwrite_a, &project_id, &entry_id, "A title", "a");
    drop(overwrite_a);

    let overwrite_b = open_vault(
        overwrite_b_path.to_string_lossy().into_owned(),
        password.to_string(),
        "overwrite-device-b".to_string(),
    )
    .expect("open overwrite B");
    let overwrite_b_commit =
        update_shared_entry(&overwrite_b, &project_id, &entry_id, "B title", "b");
    drop(overwrite_b);

    create_portable_backup(
        overwrite_a_path.to_string_lossy().into_owned(),
        shared_path.to_string_lossy().into_owned(),
    )
    .expect("publish A whole file");
    fs::remove_file(&shared_path).expect("replace shared whole file");
    create_portable_backup(
        overwrite_b_path.to_string_lossy().into_owned(),
        shared_path.to_string_lossy().into_owned(),
    )
    .expect("publish B whole file");

    let overwritten = open_vault(
        shared_path.to_string_lossy().into_owned(),
        password.to_string(),
        "overwrite-reader".to_string(),
    )
    .expect("open overwritten shared file");
    assert_eq!(
        overwritten
            .get_object(project_id.clone(), entry_id.clone())
            .expect("read overwritten object")
            .expect("overwritten object exists")
            .title,
        "B title"
    );
    assert!(overwritten
        .get_commit_history(overwrite_a_commit)
        .expect("query overwritten A commit")
        .is_none());
    assert!(overwritten
        .get_commit_history(overwrite_b_commit)
        .expect("query overwritten B commit")
        .is_some());
    assert!(overwritten
        .list_unresolved_conflicts()
        .expect("list overwrite conflicts")
        .is_empty());
    drop(overwritten);

    let sync_a = open_vault(
        sync_a_path.to_string_lossy().into_owned(),
        password.to_string(),
        "sync-device-a".to_string(),
    )
    .expect("open sync A");
    let sync_a_commit = update_shared_entry(&sync_a, &project_id, &entry_id, "A title", "a");
    sync_a
        .export_manual_sync_bundle(bundle_path.to_string_lossy().into_owned())
        .expect("export A sync bundle");

    let sync_b = open_vault(
        sync_b_path.to_string_lossy().into_owned(),
        password.to_string(),
        "sync-device-b".to_string(),
    )
    .expect("open sync B");
    let sync_b_commit = update_shared_entry(&sync_b, &project_id, &entry_id, "B title", "b");
    let applied = sync_b
        .apply_manual_sync_bundle(bundle_path.to_string_lossy().into_owned())
        .expect("apply divergent A bundle to B");
    assert!(applied.applied_commits >= 1);
    assert!(applied.conflict_count >= 1);
    assert!(sync_b
        .get_commit_history(sync_a_commit)
        .expect("query synchronized A commit")
        .is_some());
    assert!(sync_b
        .get_commit_history(sync_b_commit)
        .expect("query local B commit")
        .is_some());
    assert!(!sync_b
        .list_unresolved_conflicts()
        .expect("list synchronized conflicts")
        .is_empty());
}

fn update_shared_entry(
    vault: &mdbx_ffi::MdbxVault,
    project_id: &str,
    entry_id: &str,
    title: &str,
    source: &str,
) -> String {
    vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            format!("update-from-{source}"),
            vec![MdbxWriteCommand::UpdateEntry {
                entry_id: entry_id.to_string(),
                project_id: project_id.to_string(),
                entry_type: "login".to_string(),
                title: title.to_string(),
                payload_json: format!(r#"{{"source":"{source}"}}"#),
            }],
        )
        .expect("update shared entry")
        .commit_id
}
