use mdbx_core::model::EntryType;
use mdbx_crypto::aead::generate_key;
use mdbx_crypto::keyring::Keyring;
use mdbx_storage::connection::VaultConnection;
use mdbx_storage::health_repair::{
    HealthRepairChoice, HealthRepairDecision, HealthRepairItemKind, HealthRepairService,
    HealthRepairStatus,
};
use mdbx_storage::init::{initialize_vault, VaultInitParams};
use mdbx_storage::repo::{CommitContext, EntryRepo, ProjectRepo};

fn setup() -> (VaultConnection, CommitContext, String) {
    let mut conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let vault_key = generate_key().unwrap();
    let keyring = Keyring::from_vault_key(&vault_key, b"health-repair-test").unwrap();
    conn.attach_keyring(keyring);
    let ctx = CommitContext::new("health-repair-device".to_string());
    let project = ProjectRepo::create(&conn, &ctx, "Health repair", None, None).unwrap();
    (conn, ctx, project.project_id)
}

fn create_entry(
    conn: &VaultConnection,
    ctx: &CommitContext,
    project_id: &str,
    title: &str,
) -> String {
    EntryRepo::create(
        conn,
        ctx,
        project_id,
        EntryType::Login,
        Some(title),
        &serde_json::json!({"username": title}),
    )
    .unwrap()
    .entry_id
}

fn typed_tombstone_count(conn: &VaultConnection, object_type: &str, object_id: &str) -> i64 {
    conn.inner()
        .query_row(
            "SELECT COUNT(*) FROM tombstones
             WHERE target_object_type = ?1 AND target_object_id = ?2",
            rusqlite::params![object_type, object_id],
            |row| row.get(0),
        )
        .unwrap()
}

fn table_count(conn: &VaultConnection, table: &str) -> i64 {
    conn.inner()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn plan_separates_safe_repairs_from_item_conflicts() {
    let (conn, ctx, project_id) = setup();
    let missing_id = create_entry(&conn, &ctx, &project_id, "Missing marker");
    let duplicate_id = create_entry(&conn, &ctx, &project_id, "Duplicate marker");
    let conflict_id = create_entry(&conn, &ctx, &project_id, "Active conflict");

    EntryRepo::soft_delete(&conn, &ctx, &missing_id).unwrap();
    conn.inner()
        .execute(
            "DELETE FROM tombstones WHERE target_object_type = 'entry' AND target_object_id = ?1",
            rusqlite::params![missing_id],
        )
        .unwrap();

    EntryRepo::soft_delete(&conn, &ctx, &duplicate_id).unwrap();
    ctx.create_tombstone(&conn, "entry", &duplicate_id).unwrap();
    ctx.create_tombstone(&conn, "entry", &conflict_id).unwrap();

    let plan = HealthRepairService::plan(&conn).unwrap();

    assert!(plan.automatic_items.iter().any(|item| {
        item.object_id == missing_id && item.kind == HealthRepairItemKind::MissingTombstone
    }));
    assert!(plan.automatic_items.iter().any(|item| {
        item.object_id == duplicate_id && item.kind == HealthRepairItemKind::DuplicateTombstones
    }));
    assert!(plan.conflict_items.iter().any(|item| {
        item.object_id == conflict_id
            && item.kind == HealthRepairItemKind::ActiveObjectTombstoneConflict
    }));
}

#[test]
fn cancelling_one_conflict_aborts_the_entire_repair_without_writes() {
    let (conn, ctx, project_id) = setup();
    let entry_id = create_entry(&conn, &ctx, &project_id, "Cancel repair");
    ctx.create_tombstone(&conn, "entry", &entry_id).unwrap();
    let plan = HealthRepairService::plan(&conn).unwrap();
    let conflict = plan.conflict_items.first().unwrap();
    let before_commits = table_count(&conn, "commits");
    let before_snapshots = table_count(&conn, "snapshots");
    let before_tombstones = table_count(&conn, "tombstones");

    let result = HealthRepairService::apply(
        &conn,
        &ctx,
        &plan.token,
        "cancel-health-repair",
        &[HealthRepairDecision {
            repair_id: conflict.repair_id.clone(),
            choice: HealthRepairChoice::Cancel,
        }],
    )
    .unwrap();

    assert_eq!(result.status, HealthRepairStatus::Cancelled);
    assert!(result.snapshot_id.is_none());
    assert!(result.commit_id.is_none());
    assert_eq!(table_count(&conn, "commits"), before_commits);
    assert_eq!(table_count(&conn, "snapshots"), before_snapshots);
    assert_eq!(table_count(&conn, "tombstones"), before_tombstones);
}

#[test]
fn apply_repairs_safe_items_and_can_keep_active_content() {
    let (conn, ctx, project_id) = setup();
    let missing_id = create_entry(&conn, &ctx, &project_id, "Deleted entry");
    let active_id = create_entry(&conn, &ctx, &project_id, "Keep active");
    EntryRepo::soft_delete(&conn, &ctx, &missing_id).unwrap();
    conn.inner()
        .execute(
            "DELETE FROM tombstones WHERE target_object_type = 'entry' AND target_object_id = ?1",
            rusqlite::params![missing_id],
        )
        .unwrap();
    ctx.create_tombstone(&conn, "entry", &active_id).unwrap();
    let plan = HealthRepairService::plan(&conn).unwrap();
    let conflict = plan.conflict_items.first().unwrap();

    let result = HealthRepairService::apply(
        &conn,
        &ctx,
        &plan.token,
        "keep-active-health-repair",
        &[HealthRepairDecision {
            repair_id: conflict.repair_id.clone(),
            choice: HealthRepairChoice::KeepContent,
        }],
    )
    .unwrap();

    assert_eq!(result.status, HealthRepairStatus::Applied);
    assert!(result.snapshot_id.is_some());
    assert!(result.commit_id.is_some());
    assert_eq!(typed_tombstone_count(&conn, "entry", &missing_id), 1);
    assert_eq!(typed_tombstone_count(&conn, "entry", &active_id), 0);
    assert!(
        !EntryRepo::get_by_id(&conn, &active_id)
            .unwrap()
            .unwrap()
            .deleted
    );
    assert!(result
        .health
        .issues
        .iter()
        .all(|issue| issue.category != "tombstones"));
}

#[test]
fn delete_choice_soft_deletes_the_conflicting_item_and_keeps_one_marker() {
    let (conn, ctx, project_id) = setup();
    let entry_id = create_entry(&conn, &ctx, &project_id, "Delete conflict");
    ctx.create_tombstone(&conn, "entry", &entry_id).unwrap();
    ctx.create_tombstone(&conn, "entry", &entry_id).unwrap();
    let plan = HealthRepairService::plan(&conn).unwrap();
    let conflict = plan.conflict_items.first().unwrap();

    let result = HealthRepairService::apply(
        &conn,
        &ctx,
        &plan.token,
        "delete-conflict-health-repair",
        &[HealthRepairDecision {
            repair_id: conflict.repair_id.clone(),
            choice: HealthRepairChoice::DeleteObject,
        }],
    )
    .unwrap();

    assert_eq!(result.status, HealthRepairStatus::Applied);
    assert!(
        EntryRepo::get_by_id(&conn, &entry_id)
            .unwrap()
            .unwrap()
            .deleted
    );
    assert_eq!(typed_tombstone_count(&conn, "entry", &entry_id), 1);
    assert!(result
        .health
        .issues
        .iter()
        .all(|issue| issue.category != "tombstones"));
}
