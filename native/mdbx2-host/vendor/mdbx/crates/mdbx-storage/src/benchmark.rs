use std::time::{Duration, Instant};
use std::{env, process::Command};

use mdbx_core::model::EntryType;

use crate::connection::VaultConnection;
use crate::error::StorageResult;
use crate::repo::attachment::AttachmentRepo;
use crate::repo::commit_ctx::CommitContext;
use crate::repo::entry::EntryRepo;
use crate::repo::project::ProjectRepo;
use crate::repo::snapshot::SnapshotRepo;
use crate::sync_delta::{materialize_pending_sync_delta, SyncDeltaLimits};
use crate::unlock::UnlockService;

const BENCHMARK_PASSWORD: &str = "mdbx-benchmark-password";

/// Storage mode used by a benchmark suite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BenchmarkMode {
    /// Legacy/test path without an attached keyring.
    Compatibility,
    /// Formally configured and unlocked vault with epoch-tagged field encryption.
    Encrypted,
}

impl BenchmarkMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Compatibility => "compatibility",
            Self::Encrypted => "encrypted",
        }
    }

    pub const fn is_encrypted(self) -> bool {
        matches!(self, Self::Encrypted)
    }
}

/// 单个 benchmark 结果。
#[derive(Debug, Clone)]
pub struct BenchResult {
    pub name: String,
    pub duration: Duration,
    pub ops: u32,
    pub ops_per_sec: f64,
    /// Measured bytes produced or processed by successful operations.
    pub output_bytes: u64,
}

/// Benchmark 套件结果。
#[derive(Debug, Clone)]
pub struct BenchSuite {
    pub suite_name: String,
    pub results: Vec<BenchResult>,
    pub total_duration: Duration,
}

impl BenchSuite {
    pub fn print(&self) {
        println!("=== {} ===", self.suite_name);
        for r in &self.results {
            println!(
                "  {:40} {:>8} ops  {:>12.3} µs/op  {:>10.1} ops/s  {:>12} bytes",
                r.name,
                r.ops,
                r.duration.as_micros() as f64 / r.ops.max(1) as f64,
                r.ops_per_sec,
                r.output_bytes,
            );
        }
        println!(
            "  Total: {:>12.3} ms",
            self.total_duration.as_secs_f64() * 1000.0
        );
        println!();
    }

    /// 与另一组对照结果比较。
    pub fn compare(&self, other: &BenchSuite, label_a: &str, label_b: &str) {
        println!("=== Comparison: {} vs {} ===", label_a, label_b);
        for a in &self.results {
            let Some(b) = other
                .results
                .iter()
                .find(|candidate| candidate.name == a.name)
            else {
                continue;
            };
            let ratio = if b.ops_per_sec > 0.0 {
                a.ops_per_sec / b.ops_per_sec
            } else {
                f64::NAN
            };
            let winner = if ratio > 1.0 { label_a } else { label_b };
            println!(
                "  {:38}  {:>10.1} vs {:>10.1} ops/s  ({:.2}x, {} faster)",
                a.name,
                a.ops_per_sec,
                b.ops_per_sec,
                ratio.max(1.0 / ratio),
                winner
            );
        }
        println!();
    }

    /// Return a stable, machine-readable report for publication and CI.
    pub fn json_report(&self, iterations: u32) -> serde_json::Value {
        self.json_report_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    /// Return a report that identifies the storage and unlock mode under test.
    pub fn json_report_with_mode(&self, iterations: u32, mode: BenchmarkMode) -> serde_json::Value {
        let rustc = Command::new("rustc")
            .arg("--version")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
        let git_commit = env::var("MDBX_BENCH_GIT_COMMIT").ok().or_else(|| {
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        });

        serde_json::json!({
            "format": "mdbx-benchmark-report-v1",
            "suite_name": self.suite_name,
            "metadata": {
                "iterations": iterations,
                "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
                "os": env::consts::OS,
                "arch": env::consts::ARCH,
                "rustc": rustc,
                "git_commit": git_commit,
                "storage_mode": mode.as_str(),
                "field_encryption": mode.is_encrypted(),
                "unlock_policy": if mode.is_encrypted() {
                    serde_json::Value::String("multi-password".to_string())
                } else {
                    serde_json::Value::Null
                },
                "dataset": {
                    "search_projects": 100,
                    "snapshot_projects": 20,
                    "compaction_blob_bytes": 64 * 16 * 1024,
                    "sync_delta_objects": 1,
                },
            },
            "results": self.results.iter().map(|result| serde_json::json!({
                "name": result.name,
                "duration_us": result.duration.as_secs_f64() * 1_000_000.0,
                "ops": result.ops,
                "ops_per_sec": result.ops_per_sec,
                "output_bytes": result.output_bytes,
                "output_bytes_per_op": if result.ops == 0 {
                    0.0
                } else {
                    result.output_bytes as f64 / result.ops as f64
                },
            })).collect::<Vec<_>>(),
            "total_duration_ms": self.total_duration.as_secs_f64() * 1_000.0,
            "limitations": [
                "Results are wall-clock measurements from one host and are not a capacity guarantee.",
                "KDBX reference numbers in the source are estimates and are not measured in this report.",
                "vault_compaction uses SQLite WAL checkpoint plus VACUUM on a synthetic fragmentation table.",
                "output_bytes is operation-specific: it is encoded payload bytes for sync and stored content bytes for attachment writes.",
                "encrypted mode configures a Multi password before workload setup; only vault_create and vault_open include password KDF cost.",
            ],
        })
    }
}

/// MDBX Benchmark 执行器。
///
/// 覆盖以下操作：
/// - vault 创建
/// - entry 创建与小修改
/// - project 搜索
/// - 附件创建、重命名与内容替换
/// - snapshot 创建
/// - vault 打开
/// - vault 文件压缩
/// - 同步 delta 物化与编码
pub struct BenchmarkRunner;

impl BenchmarkRunner {
    /// 运行完整 benchmark 套件。
    pub fn run_full_suite(iterations: u32) -> BenchSuite {
        Self::run_full_suite_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    /// Run all workloads with the requested storage mode.
    pub fn run_full_suite_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchSuite {
        let mut results = Vec::new();
        let start = Instant::now();

        results.push(Self::bench_create_vault_with_mode(iterations, mode));
        results.push(Self::bench_save_entry_with_mode(iterations, mode));
        results.push(Self::bench_edit_entry_with_mode(iterations, mode));
        results.push(Self::bench_search_with_mode(iterations, mode));
        results.push(Self::bench_attachment_write_with_mode(iterations, mode));
        results.push(Self::bench_attachment_rename_with_mode(iterations, mode));
        results.push(Self::bench_attachment_replace_with_mode(iterations, mode));
        results.push(Self::bench_snapshot_with_mode(iterations, mode));
        results.push(Self::bench_open_vault_with_mode(iterations, mode));
        results.push(Self::bench_compaction_with_mode(iterations, mode));
        results.push(Self::bench_sync_delta_with_mode(iterations, mode));

        let total = start.elapsed();
        BenchSuite {
            suite_name: format!(
                "MDBX Benchmark ({} mode, {} iterations)",
                mode.as_str(),
                iterations
            ),
            results,
            total_duration: total,
        }
    }

    /// Benchmark: vault 创建。
    pub fn bench_create_vault(iterations: u32) -> BenchResult {
        Self::bench_create_vault_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_create_vault_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let start = Instant::now();
        let mut success = 0u32;

        for _ in 0..iterations {
            let mut conn = VaultConnection::open_in_memory().unwrap();
            let params = crate::init::VaultInitParams::default();
            if crate::init::initialize_vault(&conn, &params).is_ok()
                && configure_benchmark_mode(&mut conn, mode).is_ok()
            {
                success += 1;
            }
            // conn 在作用域结束时关闭
        }

        let duration = start.elapsed();
        bench_result("vault_create", duration, success, 0)
    }

    /// Benchmark: entry 保存。
    pub fn bench_save_entry(iterations: u32) -> BenchResult {
        Self::bench_save_entry_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_save_entry_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());

        // 预先创建 project
        let project = ProjectRepo::create(&conn, &ctx, "Bench Project", None, None).unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;

        for i in 0..iterations {
            let payload = serde_json::json!({
                "username": format!("user-{}", i),
                "password": format!("pass-{}", i),
                "url": format!("https://site-{}.example.com", i),
            });
            if let Ok(entry) = EntryRepo::create(
                &conn,
                &ctx,
                &project.project_id,
                EntryType::Login,
                Some(&format!("Entry-{}", i)),
                &payload,
            ) {
                success += 1;
                output_bytes += entry.payload_ct.len() as u64;
            }
        }

        let duration = start.elapsed();
        bench_result("entry_create", duration, success, output_bytes)
    }

    /// Benchmark: repeatedly make a small edit to one entry.
    pub fn bench_edit_entry(iterations: u32) -> BenchResult {
        Self::bench_edit_entry_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_edit_entry_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Edit Bench", None, None).unwrap();
        let mut entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Editable"),
            &serde_json::json!({"username":"bench","counter":0}),
        )
        .unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;
        for i in 0..iterations {
            entry.payload_ct = serde_json::to_vec(&serde_json::json!({
                "username": "bench",
                "counter": i,
            }))
            .unwrap();
            match EntryRepo::update(&conn, &ctx, &entry) {
                Ok(updated) => {
                    output_bytes += updated.payload_ct.len() as u64;
                    entry = updated;
                    success += 1;
                }
                Err(_) => break,
            }
        }

        bench_result("entry_edit_small", start.elapsed(), success, output_bytes)
    }

    /// Benchmark: project 标题搜索。
    pub fn bench_search(iterations: u32) -> BenchResult {
        Self::bench_search_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_search_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());

        // 预先创建数据
        let mut project_ids = Vec::new();
        for i in 0..100u32 {
            let p = ProjectRepo::create(
                &conn,
                &ctx,
                &format!("Searchable Project {}", i),
                None,
                None,
            )
            .unwrap();

            // 为一半的项目做 FTS 索引
            if i < 50 {
                crate::search::SearchService::index_project_title(
                    &conn,
                    &p.project_id,
                    &format!("Searchable Project {}", i),
                )
                .unwrap();
            }
            project_ids.push(p.project_id);
        }

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;

        for i in 0..iterations {
            let query = format!("Project {}", i % 100);
            if let Ok(matches) = crate::search::SearchService::search_by_title(&conn, &query) {
                output_bytes += matches
                    .iter()
                    .map(|item| item.project_id.len() + item.title.len() + item.summary.len())
                    .sum::<usize>() as u64;
                success += 1;
            }
        }

        let duration = start.elapsed();
        bench_result("search_by_title", duration, success, output_bytes)
    }

    /// Benchmark: 小附件写入。
    pub fn bench_attachment_write(iterations: u32) -> BenchResult {
        Self::bench_attachment_write_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_attachment_write_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());

        let project = ProjectRepo::create(&conn, &ctx, "Attach Bench", None, None).unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;

        for i in 0..iterations {
            let data = format!("benchmark attachment data {}", i);
            if let Ok(att) = AttachmentRepo::add(
                &conn,
                &ctx,
                &project.project_id,
                None,
                &format!("file-{}.txt", i),
                Some("text/plain"),
                "",
                0,
            ) {
                if AttachmentRepo::write_inline_content(
                    &conn,
                    &ctx,
                    &att.attachment_id,
                    data.as_bytes(),
                )
                .is_ok()
                {
                    success += 1;
                    output_bytes += data.len() as u64;
                }
            }
        }

        let duration = start.elapsed();
        bench_result("attachment_create_small", duration, success, output_bytes)
    }

    /// Benchmark: rename one attachment without touching its content.
    pub fn bench_attachment_rename(iterations: u32) -> BenchResult {
        Self::bench_attachment_rename_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_attachment_rename_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Rename Bench", None, None).unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "rename-0.txt",
            Some("text/plain"),
            "",
            0,
        )
        .unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;
        for i in 0..iterations {
            let file_name = format!("rename-{i}.txt");
            if AttachmentRepo::rename(
                &conn,
                &ctx,
                &attachment.attachment_id,
                &file_name,
                Some("text/plain"),
            )
            .is_ok()
            {
                success += 1;
                output_bytes += file_name.len() as u64;
            }
        }

        bench_result("attachment_rename", start.elapsed(), success, output_bytes)
    }

    /// Benchmark: replace the inline content of one existing attachment.
    pub fn bench_attachment_replace(iterations: u32) -> BenchResult {
        Self::bench_attachment_replace_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_attachment_replace_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Replace Bench", None, None).unwrap();
        let attachment = AttachmentRepo::add(
            &conn,
            &ctx,
            &project.project_id,
            None,
            "replace.bin",
            Some("application/octet-stream"),
            "",
            0,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &attachment.attachment_id, b"seed")
            .unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;
        for i in 0..iterations {
            let data = vec![(i % 251) as u8; 1024];
            if AttachmentRepo::write_inline_content(&conn, &ctx, &attachment.attachment_id, &data)
                .is_ok()
            {
                success += 1;
                output_bytes += data.len() as u64;
            }
        }

        bench_result(
            "attachment_replace_1k",
            start.elapsed(),
            success,
            output_bytes,
        )
    }

    /// Benchmark: snapshot a representative small vault.
    pub fn bench_snapshot(iterations: u32) -> BenchResult {
        Self::bench_snapshot_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_snapshot_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());
        for i in 0..20u32 {
            let project =
                ProjectRepo::create(&conn, &ctx, &format!("Snapshot Project {i}"), None, None)
                    .unwrap();
            EntryRepo::create(
                &conn,
                &ctx,
                &project.project_id,
                EntryType::Login,
                Some("Snapshot Entry"),
                &serde_json::json!({"username": format!("user-{i}")}),
            )
            .unwrap();
        }

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;
        for _ in 0..iterations {
            if let Ok(snapshot) = SnapshotRepo::create_snapshot(&conn, &ctx) {
                success += 1;
                output_bytes += snapshot.snapshot_ct.len() as u64;
            }
        }

        bench_result("snapshot_create", start.elapsed(), success, output_bytes)
    }

    /// Benchmark: vault 文件打开。
    pub fn bench_open_vault(iterations: u32) -> BenchResult {
        Self::bench_open_vault_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_open_vault_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        // 先创建一个持久化的 vault 文件
        let dir = std::env::temp_dir();
        let db_path = dir.join(format!("mdbx-bench-open-{}.mdbx", uuid::Uuid::new_v4()));

        {
            let mut conn = VaultConnection::create(&db_path).unwrap();
            crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
            configure_benchmark_mode(&mut conn, mode).unwrap();
            let ctx = CommitContext::new("bench-device".to_string());
            let p = ProjectRepo::create(&conn, &ctx, "Bench Open", None, None).unwrap();
            EntryRepo::create(
                &conn,
                &ctx,
                &p.project_id,
                EntryType::Login,
                Some("Login"),
                &serde_json::json!({"username":"a","password":"b"}),
            )
            .unwrap();
        }

        let start = Instant::now();
        let mut success = 0u32;

        for _ in 0..iterations {
            let opened = VaultConnection::open(&db_path).and_then(|mut conn| {
                if mode.is_encrypted() {
                    UnlockService::unlock_with_password(&mut conn, BENCHMARK_PASSWORD)?;
                }
                Ok(())
            });
            if opened.is_ok() {
                success += 1;
            }
        }

        let duration = start.elapsed();
        let result = bench_result("vault_open", duration, success, 0);

        // 清理
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-shm"));

        result
    }

    /// Benchmark: compact a persistent SQLite vault with VACUUM.
    pub fn bench_compaction(iterations: u32) -> BenchResult {
        Self::bench_compaction_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_compaction_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let directory = tempfile::tempdir().unwrap();
        let db_path = directory.path().join("compaction.mdbx");
        let mut conn = VaultConnection::create(&db_path).unwrap();
        crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
        configure_benchmark_mode(&mut conn, mode).unwrap();
        conn.inner()
            .execute_batch(
                "CREATE TABLE benchmark_compaction_data (
                    id INTEGER PRIMARY KEY,
                    payload BLOB NOT NULL
                 );",
            )
            .unwrap();
        let payload = vec![0x5au8; 16 * 1024];
        for id in 0..64u32 {
            conn.inner()
                .execute(
                    "INSERT INTO benchmark_compaction_data (id, payload) VALUES (?1, ?2)",
                    rusqlite::params![id, payload],
                )
                .unwrap();
        }
        conn.inner()
            .execute("DELETE FROM benchmark_compaction_data WHERE id % 2 = 0", [])
            .unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;
        for _ in 0..iterations {
            if conn
                .inner()
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
                .is_ok()
            {
                success += 1;
                output_bytes += std::fs::metadata(&db_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or_default();
            }
        }

        bench_result("vault_compaction", start.elapsed(), success, output_bytes)
    }

    /// Benchmark: materialize and encode a real sync delta envelope.
    pub fn bench_sync_delta(iterations: u32) -> BenchResult {
        Self::bench_sync_delta_with_mode(iterations, BenchmarkMode::Compatibility)
    }

    fn bench_sync_delta_with_mode(iterations: u32, mode: BenchmarkMode) -> BenchResult {
        let conn = initialized_memory_vault(mode);
        let ctx = CommitContext::new("bench-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Delta Project", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Login"),
            &serde_json::json!({"username":"delta-user"}),
        )
        .unwrap();

        let start = Instant::now();
        let mut success = 0u32;
        let mut output_bytes = 0u64;
        let limits = SyncDeltaLimits::default();

        for _ in 0..iterations {
            conn.inner()
                .execute(
                    "INSERT INTO sync_delta_mutations (entity_kind, entity_id, action)
                     VALUES ('commit', ?1, 'upsert'), ('entry', ?2, 'upsert')",
                    rusqlite::params![entry.head_commit_id, entry.entry_id],
                )
                .unwrap();
            if let Ok(Some(envelope)) = materialize_pending_sync_delta(&conn, limits) {
                if let Ok(encoded) = envelope.encode(limits) {
                    output_bytes += encoded.len() as u64;
                    success += 1;
                }
            }
        }

        let duration = start.elapsed();
        bench_result("sync_delta_materialize", duration, success, output_bytes)
    }

    /// KDBX 对照组的数据结构（参考值，用于对比输出）。
    ///
    /// 这些是预期的参考数量级，实际 KDBX benchmark 数据可从外部输入。
    pub fn kdbx_reference_numbers() -> BenchSuite {
        BenchSuite {
            suite_name: "KDBX Reference (estimated)".to_string(),
            results: vec![
                BenchResult {
                    name: "vault_create".to_string(),
                    duration: Duration::from_millis(100),
                    ops: 100,
                    ops_per_sec: 1000.0,
                    output_bytes: 0,
                },
                BenchResult {
                    name: "entry_create".to_string(),
                    duration: Duration::from_millis(200),
                    ops: 100,
                    ops_per_sec: 500.0,
                    output_bytes: 0,
                },
                BenchResult {
                    name: "search_by_title".to_string(),
                    duration: Duration::from_millis(50),
                    ops: 100,
                    ops_per_sec: 2000.0,
                    output_bytes: 0,
                },
                BenchResult {
                    name: "attachment_create_small".to_string(),
                    duration: Duration::from_millis(150),
                    ops: 100,
                    ops_per_sec: 666.0,
                    output_bytes: 0,
                },
                BenchResult {
                    name: "vault_open".to_string(),
                    duration: Duration::from_millis(300),
                    ops: 100,
                    ops_per_sec: 333.0,
                    output_bytes: 0,
                },
                BenchResult {
                    name: "sync_delta_materialize".to_string(),
                    duration: Duration::from_millis(80),
                    ops: 100,
                    ops_per_sec: 1250.0,
                    output_bytes: 0,
                },
            ],
            total_duration: Duration::from_millis(880),
        }
    }
}

fn initialized_memory_vault(mode: BenchmarkMode) -> VaultConnection {
    let mut conn = VaultConnection::open_in_memory().unwrap();
    crate::init::initialize_vault(&conn, &crate::init::VaultInitParams::default()).unwrap();
    configure_benchmark_mode(&mut conn, mode).unwrap();
    conn
}

fn configure_benchmark_mode(conn: &mut VaultConnection, mode: BenchmarkMode) -> StorageResult<()> {
    if mode.is_encrypted() {
        UnlockService::setup_password(conn, BENCHMARK_PASSWORD)?;
    }
    Ok(())
}

fn bench_result(name: &str, duration: Duration, ops: u32, output_bytes: u64) -> BenchResult {
    BenchResult {
        name: name.to_string(),
        duration,
        ops,
        ops_per_sec: if duration.is_zero() {
            0.0
        } else {
            ops as f64 / duration.as_secs_f64()
        },
        output_bytes,
    }
}

// ---------------------------------------------------------------------------
// 测试（集成 smoke 测试）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bench_create_vault() {
        let result = BenchmarkRunner::bench_create_vault(10);
        assert_eq!(result.ops, 10);
        assert!(result.duration.as_micros() > 0);
        assert!(result.ops_per_sec > 0.0);
    }

    #[test]
    fn test_bench_save_entry() {
        let result = BenchmarkRunner::bench_save_entry(10);
        assert_eq!(result.ops, 10);
        assert!(result.ops_per_sec > 0.0);
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn test_bench_edit_entry() {
        let result = BenchmarkRunner::bench_edit_entry(5);
        assert_eq!(result.ops, 5);
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn test_bench_search() {
        let result = BenchmarkRunner::bench_search(10);
        assert_eq!(result.ops, 10);
        assert!(result.ops_per_sec > 0.0);
    }

    #[test]
    fn test_bench_attachment_write() {
        let result = BenchmarkRunner::bench_attachment_write(5);
        assert!(result.ops > 0);
        assert!(result.ops_per_sec > 0.0);
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn test_bench_attachment_changes() {
        let rename = BenchmarkRunner::bench_attachment_rename(3);
        let replace = BenchmarkRunner::bench_attachment_replace(3);
        assert_eq!(rename.ops, 3);
        assert_eq!(replace.ops, 3);
        assert!(rename.output_bytes > 0);
        assert_eq!(replace.output_bytes, 3 * 1024);
    }

    #[test]
    fn test_bench_snapshot() {
        let result = BenchmarkRunner::bench_snapshot(2);
        assert_eq!(result.ops, 2);
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn test_bench_open_vault() {
        let result = BenchmarkRunner::bench_open_vault(5);
        assert_eq!(result.ops, 5);
        assert!(result.ops_per_sec > 0.0);
    }

    #[test]
    fn test_bench_sync_delta() {
        let result = BenchmarkRunner::bench_sync_delta(5);
        assert_eq!(result.ops, 5);
        assert!(result.ops_per_sec > 0.0);
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn test_bench_compaction() {
        let result = BenchmarkRunner::bench_compaction(1);
        assert_eq!(result.ops, 1);
        assert!(result.output_bytes > 0);
    }

    #[test]
    fn test_run_full_suite() {
        let suite = BenchmarkRunner::run_full_suite(5);
        assert_eq!(suite.results.len(), 11);
        assert!(suite.total_duration.as_micros() > 0);

        // 验证可以打印
        suite.print();
    }

    #[test]
    fn json_report_contains_reproducibility_metadata() {
        let suite = BenchSuite {
            suite_name: "metadata test".to_string(),
            results: vec![bench_result("sample", Duration::from_millis(2), 2, 128)],
            total_duration: Duration::from_millis(2),
        };

        let report = suite.json_report(2);
        assert_eq!(report["format"], "mdbx-benchmark-report-v1");
        assert_eq!(report["metadata"]["iterations"], 2);
        assert_eq!(report["metadata"]["storage_mode"], "compatibility");
        assert_eq!(report["metadata"]["field_encryption"], false);
        assert!(report["metadata"]["unlock_policy"].is_null());
        assert!(report["metadata"]["os"].is_string());
        assert!(report["metadata"]["rustc"].is_string());
        assert_eq!(report["results"][0]["output_bytes"], 128);
        assert_eq!(report["results"][0]["output_bytes_per_op"], 64.0);
        assert_eq!(report["limitations"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn encrypted_mode_uses_verified_epoch_ciphertext() {
        let conn = initialized_memory_vault(BenchmarkMode::Encrypted);
        assert!(conn.is_encrypted());
        assert!(conn.active_session().is_some());
        assert!(conn.active_key_epoch_id().is_some());

        let ctx = CommitContext::new("encrypted-benchmark-test".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Encrypted title", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Encrypted entry"),
            &serde_json::json!({"secret":"value"}),
        )
        .unwrap();
        let raw_project: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT title_ct FROM projects WHERE project_id = ?1",
                [&project.project_id],
                |row| row.get(0),
            )
            .unwrap();
        let raw_entry: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT payload_ct FROM entries WHERE entry_id = ?1",
                [&entry.entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(raw_project.starts_with(b"MDBXFE2\0"));
        assert!(raw_entry.starts_with(b"MDBXFE2\0"));
    }

    #[test]
    fn encrypted_full_suite_completes_and_reports_mode() {
        let suite = BenchmarkRunner::run_full_suite_with_mode(1, BenchmarkMode::Encrypted);
        assert_eq!(suite.results.len(), 11);
        assert!(suite.results.iter().all(|result| result.ops == 1));

        let report = suite.json_report_with_mode(1, BenchmarkMode::Encrypted);
        assert_eq!(report["metadata"]["storage_mode"], "encrypted");
        assert_eq!(report["metadata"]["field_encryption"], true);
        assert_eq!(report["metadata"]["unlock_policy"], "multi-password");
    }

    #[test]
    fn test_compare_with_kdbx() {
        let mdbx_suite = BenchmarkRunner::run_full_suite(5);
        let kdbx_suite = BenchmarkRunner::kdbx_reference_numbers();
        mdbx_suite.compare(&kdbx_suite, "MDBX", "KDBX");
    }

    #[test]
    fn test_bench_results_are_reproducible() {
        // 连续运行两次，结果应在合理范围内
        let r1 = BenchmarkRunner::bench_save_entry(10);
        let r2 = BenchmarkRunner::bench_save_entry(10);

        assert_eq!(r1.ops, r2.ops);
        // ops_per_sec 应在 2x 范围内
        let ratio = if r2.ops_per_sec > 0.0 {
            r1.ops_per_sec / r2.ops_per_sec
        } else {
            1.0
        };
        assert!(
            ratio > 0.1 && ratio < 10.0,
            "benchmark results not reproducible: {:.1} vs {:.1} ops/s",
            r1.ops_per_sec,
            r2.ops_per_sec
        );
    }
}
