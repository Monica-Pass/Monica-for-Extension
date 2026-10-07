use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use mdbx_ffi::{create_vault, default_write_operation_limits, open_vault, MdbxWriteCommand};
use uuid::Uuid;

const ENTRY_COUNT: usize = 200;
const MEASURED_RUNS: usize = 3;

#[derive(Debug)]
struct TempVaultPath {
    path: PathBuf,
    path_string: String,
}

impl TempVaultPath {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "mdbx-ffi-batch-performance-{label}-{}.mdbx",
            Uuid::new_v4()
        ));
        let path_string = path.to_string_lossy().to_string();
        Self { path, path_string }
    }
}

impl Drop for TempVaultPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_file(sidecar_path(&self.path, "-wal"));
        let _ = fs::remove_file(sidecar_path(&self.path, "-shm"));
        let _ = fs::remove_dir_all(sidecar_path(&self.path, ".blobs"));
    }
}

#[derive(Clone, Copy, Debug)]
struct BatchMetrics {
    create_vault_ms: u128,
    batch_create_ms: u128,
    cold_read_ms: u128,
    hot_read_ms: u128,
    batch_update_ms: u128,
    batch_delete_ms: u128,
}

#[test]
#[ignore = "manual performance feedback loop; run with --ignored --nocapture"]
fn native_batch_performance_baseline() {
    let _warmup = run_scenario("warmup");
    let measured = (0..MEASURED_RUNS)
        .map(|index| run_scenario(&format!("measured-{index}")))
        .collect::<Vec<_>>();

    let medians = BatchMetrics {
        create_vault_ms: median(measured.iter().map(|value| value.create_vault_ms)),
        batch_create_ms: median(measured.iter().map(|value| value.batch_create_ms)),
        cold_read_ms: median(measured.iter().map(|value| value.cold_read_ms)),
        hot_read_ms: median(measured.iter().map(|value| value.hot_read_ms)),
        batch_update_ms: median(measured.iter().map(|value| value.batch_update_ms)),
        batch_delete_ms: median(measured.iter().map(|value| value.batch_delete_ms)),
    };

    println!(
        "MDBX2_BATCH_PERF {{\"entries\":{ENTRY_COUNT},\"runs\":{MEASURED_RUNS},\"create_vault_ms\":{},\"batch_create_ms\":{},\"cold_read_ms\":{},\"hot_read_ms\":{},\"batch_update_ms\":{},\"batch_delete_ms\":{}}}",
        medians.create_vault_ms,
        medians.batch_create_ms,
        medians.cold_read_ms,
        medians.hot_read_ms,
        medians.batch_update_ms,
        medians.batch_delete_ms,
    );
}

#[test]
fn public_default_limit_rejects_257_and_explicit_limit_is_idempotent() {
    const COMMAND_COUNT: usize = 257;
    let vault_path = TempVaultPath::new("command-limit");
    let vault = create_vault(
        vault_path.path_string.clone(),
        "MDBX2 command limit password 12345!".to_string(),
        "native-command-limit-device".to_string(),
    )
    .expect("create command-limit vault");
    let project = vault
        .create_project("Command limit project".to_string())
        .expect("create command-limit project");
    let commands = (0..COMMAND_COUNT)
        .map(|index| MdbxWriteCommand::CreateEntry {
            entry_id: Uuid::new_v4().to_string(),
            project_id: project.project_id.clone(),
            entry_type: "login".to_string(),
            title: format!("Limit entry {index:03}"),
            payload_json: format!(r#"{{"index":{index}}}"#),
        })
        .collect::<Vec<_>>();

    let default_error = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "default-limit-rejection".to_string(),
            commands.clone(),
        )
        .expect_err("the default 256-command profile must reject 257 commands");
    assert!(default_error
        .to_string()
        .contains("write operation commands"));
    assert!(vault
        .list_objects(project.project_id.clone(), Some("login".to_string()))
        .expect("list after rejected default operation")
        .is_empty());

    let operation_id = Uuid::new_v4().to_string();
    let mut limits = default_write_operation_limits();
    limits.max_commands = 4_096;
    let first = vault
        .execute_write_operation_with_limits(
            operation_id.clone(),
            "explicit-limit-success".to_string(),
            commands.clone(),
            limits,
        )
        .expect("explicit hard-ceiling profile accepts 257 commands");
    assert!(!first.already_committed);
    assert_eq!(first.entry_ids.len(), COMMAND_COUNT);

    limits.max_commands = 300;
    let retry = vault
        .execute_write_operation_with_limits(
            operation_id,
            "explicit-limit-success".to_string(),
            commands,
            limits,
        )
        .expect("exact retry may use a different valid execution limit");
    assert!(retry.already_committed);
    assert_eq!(retry.commit_id, first.commit_id);
    assert_eq!(
        vault
            .list_objects(project.project_id, Some("login".to_string()))
            .expect("list explicitly accepted entries")
            .len(),
        COMMAND_COUNT
    );
}

fn run_scenario(label: &str) -> BatchMetrics {
    let vault_path = TempVaultPath::new(label);
    let password = "MDBX2 batch performance password 12345!";
    let device_id = format!("native-batch-performance-{label}");

    let started = Instant::now();
    let vault = create_vault(
        vault_path.path_string.clone(),
        password.to_string(),
        device_id.clone(),
    )
    .expect("create benchmark vault");
    let create_vault_ms = started.elapsed().as_millis();

    let project = vault
        .create_project(format!("Performance project {label}"))
        .expect("create benchmark project");
    let entry_ids = (0..ENTRY_COUNT)
        .map(|_| Uuid::new_v4().to_string())
        .collect::<Vec<_>>();

    let create_commands = entry_ids
        .iter()
        .enumerate()
        .map(|(index, entry_id)| MdbxWriteCommand::CreateEntry {
            entry_id: entry_id.clone(),
            project_id: project.project_id.clone(),
            entry_type: "login".to_string(),
            title: format!("Entry {index:03}"),
            payload_json: format!(
                r#"{{"username":"user-{index:03}","password":"secret-{index:03}","revision":0}}"#
            ),
        })
        .collect::<Vec<_>>();
    let started = Instant::now();
    let created = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "native-batch-create".to_string(),
            create_commands,
        )
        .expect("batch create entries");
    let batch_create_ms = started.elapsed().as_millis();
    assert_eq!(created.entry_ids.len(), ENTRY_COUNT);

    drop(vault);
    let vault = open_vault(
        vault_path.path_string.clone(),
        password.to_string(),
        device_id,
    )
    .expect("reopen benchmark vault");

    let started = Instant::now();
    let cold_objects = vault
        .list_objects(project.project_id.clone(), Some("login".to_string()))
        .expect("cold list benchmark entries");
    let cold_read_ms = started.elapsed().as_millis();
    assert_eq!(cold_objects.len(), ENTRY_COUNT);

    let started = Instant::now();
    let hot_objects = vault
        .list_objects(project.project_id.clone(), Some("login".to_string()))
        .expect("hot list benchmark entries");
    let hot_read_ms = started.elapsed().as_millis();
    assert_eq!(hot_objects.len(), ENTRY_COUNT);

    let update_commands = entry_ids
        .iter()
        .enumerate()
        .map(|(index, entry_id)| MdbxWriteCommand::UpdateEntry {
            entry_id: entry_id.clone(),
            project_id: project.project_id.clone(),
            entry_type: "login".to_string(),
            title: format!("Updated entry {index:03}"),
            payload_json: format!(
                r#"{{"username":"user-{index:03}","password":"secret-{index:03}","revision":1}}"#
            ),
        })
        .collect::<Vec<_>>();
    let started = Instant::now();
    let updated = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "native-batch-update".to_string(),
            update_commands,
        )
        .expect("batch update entries");
    let batch_update_ms = started.elapsed().as_millis();
    assert_eq!(updated.entry_ids.len(), ENTRY_COUNT);

    let delete_commands = entry_ids
        .iter()
        .map(|entry_id| MdbxWriteCommand::DeleteEntry {
            entry_id: entry_id.clone(),
            project_id: project.project_id.clone(),
        })
        .collect::<Vec<_>>();
    let started = Instant::now();
    let deleted = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "native-batch-delete".to_string(),
            delete_commands,
        )
        .expect("batch delete entries");
    let batch_delete_ms = started.elapsed().as_millis();
    assert_eq!(deleted.entry_ids.len(), ENTRY_COUNT);
    assert!(vault
        .list_objects(project.project_id, Some("login".to_string()))
        .expect("verify deleted entries are absent")
        .is_empty());

    BatchMetrics {
        create_vault_ms,
        batch_create_ms,
        cold_read_ms,
        hot_read_ms,
        batch_update_ms,
        batch_delete_ms,
    }
}

fn median(values: impl Iterator<Item = u128>) -> u128 {
    let mut values = values.collect::<Vec<_>>();
    values.sort_unstable();
    values[values.len() / 2]
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}
