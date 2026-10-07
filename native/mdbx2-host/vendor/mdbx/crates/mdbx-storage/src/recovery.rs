use std::path::Path;

use crate::commit_integrity::{compute_commit_integrity_tag, CommitIntegrityInput};
use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::init::INIT_KEY_EPOCH_PROFILE_ID;
use crate::repo::{
    CollectionProfileRepo, CommitGraphRepo, TombstoneAcknowledgementRepo, TombstoneRepo,
};

/// 数据库健康检查结果。
#[derive(Debug, Clone)]
pub struct HealthCheckResult {
    pub healthy: bool,
    pub issues: Vec<HealthIssue>,
}

/// 健康问题描述。
#[derive(Debug, Clone)]
pub struct HealthIssue {
    pub severity: IssueSeverity,
    pub category: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IssueSeverity {
    Info,
    Warning,
    Error,
    Critical,
}

/// 恢复验证器。
///
/// 检查 vault 数据库在异常场景下的完整性和可恢复性：
/// - WAL 恢复后的数据一致性
/// - 损坏 chunk 检测
/// - 陈旧设备 head 检测
/// - 快照完整性
/// - 孤儿记录检测
/// - 对象删除状态与墓碑一致性
pub struct RecoveryVerifier;

impl RecoveryVerifier {
    /// 对打开的 vault 进行完整健康检查。
    pub fn full_health_check(conn: &VaultConnection) -> StorageResult<HealthCheckResult> {
        let mut issues: Vec<HealthIssue> = Vec::new();

        // 1. 基本完整性检查
        if let Err(e) = Self::check_basic_integrity(conn) {
            issues.push(HealthIssue {
                severity: IssueSeverity::Critical,
                category: "integrity".to_string(),
                description: format!("basic integrity check failed: {}", e),
            });
        }

        match crate::vault_header_integrity::check(conn) {
            Ok(crate::vault_header_integrity::VaultHeaderIntegrityStatus::Pending) => {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Warning,
                    category: "vault-header-integrity".to_string(),
                    description:
                        "vault header authentication is pending the first successful unlock"
                            .to_string(),
                });
            }
            Ok(crate::vault_header_integrity::VaultHeaderIntegrityStatus::UnverifiedLocked) => {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Warning,
                    category: "vault-header-integrity".to_string(),
                    description:
                        "vault header authentication requires an unlocked keyring for verification"
                            .to_string(),
                });
            }
            Ok(crate::vault_header_integrity::VaultHeaderIntegrityStatus::Verified) => {}
            Err(error) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "vault-header-integrity".to_string(),
                description: format!("vault header authentication failed: {error}"),
            }),
        }

        match Self::check_incremental_integrity_root(conn) {
            Ok(root_issues) => issues.extend(root_issues),
            Err(error) => issues.push(HealthIssue {
                severity: IssueSeverity::Critical,
                category: "incremental-integrity-root".to_string(),
                description: format!("incremental integrity root verification failed: {error}"),
            }),
        }

        // 2. 检查 commit 链
        match Self::check_commit_chain(conn) {
            Ok(commit_issues) => issues.extend(commit_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "commit-chain".to_string(),
                description: format!("commit chain check failed: {}", e),
            }),
        }

        // 3. 检查附件 chunk 完整性
        match Self::check_attachment_chunks(conn) {
            Ok(chunk_issues) => issues.extend(chunk_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "attachment-chunks".to_string(),
                description: format!("chunk check failed: {}", e),
            }),
        }

        // 4. 检查 snapshot 完整性
        match Self::check_snapshots(conn) {
            Ok(snapshot_issues) => issues.extend(snapshot_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "snapshots".to_string(),
                description: format!("snapshot check failed: {}", e),
            }),
        }

        // 5. 检查孤儿记录
        match Self::check_orphans(conn) {
            Ok(orphan_issues) => issues.extend(orphan_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Warning,
                category: "orphans".to_string(),
                description: format!("orphan check failed: {}", e),
            }),
        }

        match Self::check_collection_profiles(conn) {
            Ok(profile_issues) => issues.extend(profile_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "collection-profiles".to_string(),
                description: format!("collection profile check failed: {}", e),
            }),
        }

        // 6. 检查对象删除状态与墓碑
        match Self::check_tombstone_consistency(conn) {
            Ok(tombstone_issues) => issues.extend(tombstone_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "tombstones".to_string(),
                description: format!("tombstone consistency check failed: {}", e),
            }),
        }

        match Self::check_tombstone_acknowledgements(conn) {
            Ok(acknowledgement_issues) => issues.extend(acknowledgement_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "tombstone-acknowledgements".to_string(),
                description: format!("tombstone acknowledgement check failed: {e}"),
            }),
        }

        match Self::check_purge_receipts(conn) {
            Ok(receipt_issues) => issues.extend(receipt_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "purge-receipts".to_string(),
                description: format!("purge receipt check failed: {}", e),
            }),
        }

        // 7. 检查陈旧 head
        match Self::check_stale_heads(conn) {
            Ok(head_issues) => issues.extend(head_issues),
            Err(e) => issues.push(HealthIssue {
                severity: IssueSeverity::Warning,
                category: "stale-heads".to_string(),
                description: format!("stale head check failed: {}", e),
            }),
        }

        let error_count = issues
            .iter()
            .filter(|i| i.severity >= IssueSeverity::Error)
            .count();
        let healthy = error_count == 0;

        Ok(HealthCheckResult { healthy, issues })
    }

    pub fn check_incremental_integrity_root(
        conn: &VaultConnection,
    ) -> StorageResult<Vec<HealthIssue>> {
        use crate::integrity_root::{IntegrityRootService, IntegrityRootState};

        let status = IntegrityRootService::status(conn)?;
        let issue = match status.state {
            IntegrityRootState::Disabled => None,
            IntegrityRootState::Pending => Some(HealthIssue {
                severity: IssueSeverity::Warning,
                category: "incremental-integrity-root".to_string(),
                description: "incremental integrity root is pending its first rebuild".to_string(),
            }),
            IntegrityRootState::Building => Some(HealthIssue {
                severity: IssueSeverity::Warning,
                category: "incremental-integrity-root".to_string(),
                description: "incremental integrity root rebuild is incomplete".to_string(),
            }),
            IntegrityRootState::Stale => Some(HealthIssue {
                severity: IssueSeverity::Critical,
                category: "incremental-integrity-root".to_string(),
                description: "incremental integrity root is stale and requires rebuild".to_string(),
            }),
            IntegrityRootState::Established if !status.authenticated => Some(HealthIssue {
                severity: IssueSeverity::Warning,
                category: "incremental-integrity-root".to_string(),
                description:
                    "incremental integrity root requires an unlocked keyring for verification"
                        .to_string(),
            }),
            IntegrityRootState::Established => {
                IntegrityRootService::verify_with_limits(
                    conn,
                    crate::integrity_root::IntegrityRootLimits::desktop(),
                )?;
                None
            }
        };
        Ok(issue.into_iter().collect())
    }

    /// 基本完整性：检查 SQLite 内部一致性。
    pub fn check_basic_integrity(conn: &VaultConnection) -> StorageResult<()> {
        let result: String = conn
            .inner()
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(StorageError::Database)?;

        if result != "ok" {
            return Err(StorageError::SchemaCreation(format!(
                "integrity_check failed: {}",
                result
            )));
        }
        Ok(())
    }

    /// 检查 commit DAG 是否有断链。
    pub fn check_commit_chain(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues: Vec<HealthIssue> = Vec::new();

        // 查找 parent commit 不存在的 commit（除了 genesis）
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT cp.commit_id, cp.parent_commit_id
                 FROM commit_parents cp
                 LEFT JOIN commits c ON cp.parent_commit_id = c.commit_id
                 WHERE c.commit_id IS NULL",
            )
            .map_err(StorageError::Database)?;

        let orphans: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (commit_id, parent_id) in &orphans {
            issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "commit-chain".to_string(),
                description: format!(
                    "commit {} references non-existent parent {}",
                    commit_id, parent_id
                ),
            });
        }

        // 检查是否有引用不存在 commit 的 branch head
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT b.branch_id, b.head_commit_id
                 FROM branches b
                 LEFT JOIN commits c ON b.head_commit_id = c.commit_id
                 WHERE c.commit_id IS NULL",
            )
            .map_err(StorageError::Database)?;

        let dangling_branches: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (branch_id, head_id) in &dangling_branches {
            issues.push(HealthIssue {
                severity: IssueSeverity::Critical,
                category: "commit-chain".to_string(),
                description: format!(
                    "branch {} head points to non-existent commit {}",
                    branch_id, head_id
                ),
            });
        }

        issues.extend(Self::check_commit_integrity_tags(conn)?);

        Ok(issues)
    }

    fn check_commit_integrity_tags(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues = Vec::new();
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT commit_id, device_id, local_seq, commit_kind, change_scope,
                        changed_object_ids_ct, vector_clock, message_ct,
                        created_at, integrity_tag
                 FROM commits",
            )
            .map_err(StorageError::Database)?;

        let commits = stmt
            .query_map([], |row| {
                Ok(CommitIntegrityRow {
                    commit_id: row.get(0)?,
                    device_id: row.get(1)?,
                    local_seq: row.get::<_, i64>(2)? as u64,
                    commit_kind: row.get(3)?,
                    change_scope: row.get(4)?,
                    changed_object_ids_ct: row.get(5)?,
                    vector_clock: row.get(6)?,
                    message_ct: row.get(7)?,
                    created_at: row.get(8)?,
                    integrity_tag: row.get(9)?,
                })
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for commit in commits {
            let parents = CommitGraphRepo::parent_ids(conn, &commit.commit_id)?;
            let input = CommitIntegrityInput {
                commit_id: &commit.commit_id,
                device_id: &commit.device_id,
                local_seq: commit.local_seq,
                commit_kind: &commit.commit_kind,
                change_scope: &commit.change_scope,
                changed_object_ids_ct: &commit.changed_object_ids_ct,
                vector_clock: &commit.vector_clock,
                message_ct: commit.message_ct.as_deref(),
                created_at: &commit.created_at,
                parents: &parents,
            };
            let expected = compute_commit_integrity_tag(conn.keyring(), &input)?;

            if expected == commit.integrity_tag {
                continue;
            }

            if conn.keyring().is_some()
                && looks_like_plain_history_payload(&commit.changed_object_ids_ct)
                && compute_commit_integrity_tag(None, &input)? == commit.integrity_tag
            {
                continue;
            }

            if conn.keyring().is_none()
                && !looks_like_plain_history_payload(&commit.changed_object_ids_ct)
            {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Warning,
                    category: "commit-integrity".to_string(),
                    description: format!(
                        "commit {} integrity cannot be verified without an unlocked keyring",
                        commit.commit_id
                    ),
                });
            } else {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "commit-integrity".to_string(),
                    description: format!("commit {} integrity tag mismatch", commit.commit_id),
                });
            }
        }

        Ok(issues)
    }

    /// 检查附件 chunk 完整性。
    pub fn check_attachment_chunks(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues: Vec<HealthIssue> = Vec::new();

        // 查找 chunk_count 与实际 chunk 数不匹配的附件
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT a.attachment_id, a.chunk_count,
                        (SELECT COUNT(*) FROM attachment_chunks ac
                         WHERE ac.attachment_id = a.attachment_id) as actual_count
                 FROM attachments a
                 WHERE a.deleted = 0",
            )
            .map_err(StorageError::Database)?;

        let mismatches: Vec<(String, i32, i32)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (att_id, expected, actual) in &mismatches {
            if expected != actual {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "attachment-chunks".to_string(),
                    description: format!(
                        "attachment {} has chunk_count={} but {} actual chunks",
                        att_id, expected, actual
                    ),
                });
            }
        }

        // 检查 chunk_index 连续性
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT attachment_id, chunk_index
                 FROM attachment_chunks
                 ORDER BY attachment_id, chunk_index",
            )
            .map_err(StorageError::Database)?;

        let chunks: Vec<(String, i32)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        // 按 attachment 分组，检查 index 是否连续
        let mut current_att_id: Option<&str> = None;
        let mut expected_index: i32 = 0;
        for (att_id, chunk_index) in &chunks {
            if current_att_id != Some(att_id.as_str()) {
                current_att_id = Some(att_id.as_str());
                expected_index = 0;
            }
            if *chunk_index != expected_index {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "attachment-chunks".to_string(),
                    description: format!(
                        "attachment {} has non-sequential chunk index: expected {}, got {}",
                        att_id, expected_index, chunk_index
                    ),
                });
                // 重新同步期望值
                expected_index = *chunk_index;
            }
            expected_index += 1;
        }

        Ok(issues)
    }

    /// 检查孤儿记录（entries/attachments 引用了不存在的 project）。
    pub fn check_orphans(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues: Vec<HealthIssue> = Vec::new();

        // 检查引用不存在 project 的 entry
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT e.entry_id, e.project_id
                 FROM entries e
                 LEFT JOIN projects p ON e.project_id = p.project_id
                 WHERE p.project_id IS NULL",
            )
            .map_err(StorageError::Database)?;

        let orphan_entries: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (entry_id, project_id) in &orphan_entries {
            issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "orphans".to_string(),
                description: format!(
                    "entry {} references non-existent project {}",
                    entry_id, project_id
                ),
            });
        }

        // 检查引用不存在 project 的 attachment
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT a.attachment_id, a.project_id
                 FROM attachments a
                 LEFT JOIN projects p ON a.project_id = p.project_id
                 WHERE p.project_id IS NULL",
            )
            .map_err(StorageError::Database)?;

        let orphan_attachments: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (att_id, project_id) in &orphan_attachments {
            issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "orphans".to_string(),
                description: format!(
                    "attachment {} references non-existent project {}",
                    att_id, project_id
                ),
            });
        }

        Ok(issues)
    }

    pub fn check_collection_profiles(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues = Vec::new();
        let mut stmt = conn.inner().prepare(
            "SELECT cp.project_id, p.project_id
             FROM collection_profiles cp
             LEFT JOIN projects p ON p.project_id = cp.project_id
             ORDER BY cp.project_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (collection_id, project_id) = row?;
            if project_id.is_none() {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "collection-profiles".to_string(),
                    description: format!(
                        "collection profile {} has no owning project",
                        collection_id
                    ),
                });
                continue;
            }
            let profile = match CollectionProfileRepo::get_by_collection_id(conn, &collection_id) {
                Ok(Some(profile)) => profile,
                Ok(None) => continue,
                Err(error) => {
                    issues.push(HealthIssue {
                        severity: IssueSeverity::Error,
                        category: "collection-profiles".to_string(),
                        description: format!(
                            "collection profile {} is invalid: {}",
                            collection_id, error
                        ),
                    });
                    continue;
                }
            };

            let mut entry_stmt = conn.inner().prepare(
                "SELECT entry_id, entry_type FROM entries
                 WHERE project_id = ?1 AND deleted = 0 ORDER BY entry_id",
            )?;
            let entries = entry_stmt.query_map([&collection_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for entry in entries {
                let (entry_id, object_type) = entry?;
                let object_type = match object_type.parse() {
                    Ok(object_type) => object_type,
                    Err(error) => {
                        issues.push(HealthIssue {
                            severity: IssueSeverity::Error,
                            category: "collection-profiles".to_string(),
                            description: format!(
                                "object {} has invalid type in collection {}: {}",
                                entry_id, collection_id, error
                            ),
                        });
                        continue;
                    }
                };
                if !profile.allows_object_type(&object_type) {
                    issues.push(HealthIssue {
                        severity: IssueSeverity::Error,
                        category: "collection-profiles".to_string(),
                        description: format!(
                            "object {} type {} is outside collection {} profile",
                            entry_id, object_type, collection_id
                        ),
                    });
                }
            }
        }
        Ok(issues)
    }

    /// 检查带删除状态的对象是否具有精确类型且唯一的当前墓碑。
    pub fn check_tombstone_consistency(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues = Vec::new();

        let mut duplicate_stmt = conn
            .inner()
            .prepare(
                "SELECT target_object_type, target_object_id, COUNT(*)
                 FROM tombstones
                 WHERE target_object_type IN
                    ('project', 'entry', 'attachment', 'object-relation',
                     'object-label', 'object-label-assignment')
                 GROUP BY target_object_type, target_object_id
                 HAVING COUNT(*) > 1
                 ORDER BY target_object_type, target_object_id",
            )
            .map_err(StorageError::Database)?;
        let duplicates = duplicate_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;
        for (object_type, object_id, count) in &duplicates {
            issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "tombstones".to_string(),
                description: format!(
                    "{} {} has {} typed tombstones; expected exactly one current marker",
                    object_type, object_id, count
                ),
            });
        }

        let mut state_stmt = conn
            .inner()
            .prepare(
                "WITH object_states(object_type, object_id, deleted) AS (
                    SELECT 'project', project_id, deleted FROM projects
                    UNION ALL SELECT 'entry', entry_id, deleted FROM entries
                    UNION ALL SELECT 'attachment', attachment_id, deleted FROM attachments
                    UNION ALL SELECT 'object-relation', relation_id, deleted FROM object_relations
                    UNION ALL SELECT 'object-label', label_id, deleted FROM object_labels
                    UNION ALL SELECT 'object-label-assignment', assignment_id, deleted
                              FROM object_label_assignments
                 )
                 SELECT o.object_type, o.object_id, o.deleted, COUNT(t.tombstone_id)
                 FROM object_states o
                 LEFT JOIN tombstones t
                    ON t.target_object_type = o.object_type
                   AND t.target_object_id = o.object_id
                 GROUP BY o.object_type, o.object_id, o.deleted
                 ORDER BY o.object_type, o.object_id",
            )
            .map_err(StorageError::Database)?;
        let states = state_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i32>(2)? != 0,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (object_type, object_id, deleted, tombstone_count) in states {
            if tombstone_count > 1 {
                continue;
            }
            if deleted && tombstone_count == 0 {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "tombstones".to_string(),
                    description: format!(
                        "{} {} is deleted without an exact typed tombstone",
                        object_type, object_id
                    ),
                });
                continue;
            }
            if !deleted
                && tombstone_count == 1
                && !Self::has_unresolved_deletion_conflict(conn, &object_type, &object_id)?
            {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "tombstones".to_string(),
                    description: format!(
                        "{} {} is active but retains a typed tombstone without an unresolved deletion conflict",
                        object_type, object_id
                    ),
                });
            }
        }

        Ok(issues)
    }

    pub fn check_tombstone_acknowledgements(
        conn: &VaultConnection,
    ) -> StorageResult<Vec<HealthIssue>> {
        let mut issues = Vec::new();
        let mut stmt = conn.inner().prepare(
            "SELECT tombstone_id, device_id, observed_commit_id
             FROM tombstone_acknowledgements
             ORDER BY tombstone_id, device_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let acknowledgements = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for (tombstone_id, device_id, observed_commit_id) in acknowledgements {
            if let Err(error) = TombstoneAcknowledgementRepo::validate_causal_proof(
                conn,
                &tombstone_id,
                &observed_commit_id,
            ) {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "tombstone-acknowledgements".to_string(),
                    description: format!(
                        "device {} tombstone acknowledgement failed causal validation: {}",
                        device_id, error
                    ),
                });
            }
        }
        Ok(issues)
    }

    pub fn check_purge_receipts(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues = Vec::new();
        let mut stmt = conn.inner().prepare(
            "SELECT target_object_type, target_object_id FROM purge_receipts
             ORDER BY target_object_type, target_object_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let targets = rows.collect::<Result<Vec<_>, _>>()?;
        for (object_type, object_id) in targets {
            if let Err(error) =
                TombstoneRepo::find_purge_receipt_by_target(conn, &object_type, &object_id)
            {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Critical,
                    category: "purge-receipts".to_string(),
                    description: format!(
                        "permanent purge receipt for {} {} failed integrity verification: {}",
                        object_type, object_id, error
                    ),
                });
                continue;
            }
            let tombstone_count: i64 = conn.inner().query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE target_object_type = ?1 AND target_object_id = ?2",
                rusqlite::params![object_type, object_id],
                |row| row.get(0),
            )?;
            if tombstone_count > 0 {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "purge-receipts".to_string(),
                    description: format!(
                        "permanently purged {} {} still has a tombstone",
                        object_type, object_id
                    ),
                });
            }
            if physical_object_exists(conn, &object_type, &object_id)? {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Critical,
                    category: "purge-receipts".to_string(),
                    description: format!(
                        "permanently purged {} {} still has an active storage row",
                        object_type, object_id
                    ),
                });
            }
        }
        Ok(issues)
    }

    fn has_unresolved_deletion_conflict(
        conn: &VaultConnection,
        object_type: &str,
        object_id: &str,
    ) -> StorageResult<bool> {
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT conflicting_fields FROM conflicts
                 WHERE object_type = ?1 AND object_id = ?2 AND resolution = 'unresolved'",
            )
            .map_err(StorageError::Database)?;
        let fields = stmt
            .query_map(rusqlite::params![object_type, object_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;
        Ok(fields.iter().any(|encoded| {
            serde_json::from_str::<Vec<String>>(encoded)
                .map(|fields| fields.iter().any(|field| field == "deleted"))
                .unwrap_or(false)
        }))
    }

    /// 检查 device head 的引用、设备归属与设备本地序列。
    pub fn check_stale_heads(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        let mut issues: Vec<HealthIssue> = Vec::new();

        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT dh.device_id, dh.head_commit_id
                 FROM device_heads dh
                 LEFT JOIN commits c ON dh.head_commit_id = c.commit_id
                 WHERE c.commit_id IS NULL",
            )
            .map_err(StorageError::Database)?;

        let stale_heads: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (device_id, head_id) in &stale_heads {
            issues.push(HealthIssue {
                severity: IssueSeverity::Critical,
                category: "stale-heads".to_string(),
                description: format!(
                    "device {} head {} references non-existent commit",
                    device_id, head_id
                ),
            });
        }

        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT dh.device_id, dh.head_commit_id, c.device_id
                 FROM device_heads dh
                 JOIN commits c ON dh.head_commit_id = c.commit_id
                 WHERE dh.device_id <> c.device_id",
            )
            .map_err(StorageError::Database)?;
        let wrong_device_heads: Vec<(String, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;
        for (device_id, head_id, commit_device_id) in wrong_device_heads {
            issues.push(HealthIssue {
                severity: IssueSeverity::Critical,
                category: "stale-heads".to_string(),
                description: format!(
                    "device {} head {} is authored by device {}",
                    device_id, head_id, commit_device_id
                ),
            });
        }

        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT dh.device_id, dh.head_commit_id, head_commit.local_seq,
                        MAX(candidate.local_seq)
                 FROM device_heads dh
                 JOIN commits head_commit ON dh.head_commit_id = head_commit.commit_id
                 JOIN commits candidate ON candidate.device_id = dh.device_id
                 WHERE head_commit.device_id = dh.device_id
                 GROUP BY dh.device_id, dh.head_commit_id, head_commit.local_seq
                 HAVING MAX(candidate.local_seq) > head_commit.local_seq",
            )
            .map_err(StorageError::Database)?;
        let regressed_heads: Vec<(String, String, i64, i64)> = stmt
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;
        for (device_id, head_id, head_sequence, latest_sequence) in regressed_heads {
            issues.push(HealthIssue {
                severity: IssueSeverity::Error,
                category: "stale-heads".to_string(),
                description: format!(
                    "device {} head {} at local sequence {} is behind local sequence {}",
                    device_id, head_id, head_sequence, latest_sequence
                ),
            });
        }

        // 检查是否有从未活跃过的设备（head = genesis only，可能已废弃）
        // 这里只是 Info 级别
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT dh.device_id, dh.last_seen_at
                 FROM device_heads dh
                 WHERE dh.last_seen_at < ?1",
            )
            .map_err(StorageError::Database)?;

        let old_threshold = "2024-01-01T00:00:00Z";
        let old_devices: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![old_threshold], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        for (device_id, last_seen) in &old_devices {
            issues.push(HealthIssue {
                severity: IssueSeverity::Info,
                category: "stale-heads".to_string(),
                description: format!(
                    "device {} last seen at {} (before threshold {})",
                    device_id, last_seen, old_threshold
                ),
            });
        }

        Ok(issues)
    }

    /// 检查所有 snapshot 的公开摘要，并在解锁后验证认证描述、密文与 payload 结构。
    pub fn check_snapshots(conn: &VaultConnection) -> StorageResult<Vec<HealthIssue>> {
        use crate::repo::snapshot::SnapshotRepo;

        let mut stmt = conn
            .inner()
            .prepare("SELECT snapshot_id FROM snapshots ORDER BY created_at, snapshot_id")
            .map_err(StorageError::Database)?;
        let snapshot_ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        let mut issues = Vec::new();
        for snapshot_id in snapshot_ids {
            if !SnapshotRepo::verify_integrity(conn, &snapshot_id)? {
                issues.push(HealthIssue {
                    severity: IssueSeverity::Error,
                    category: "snapshots".to_string(),
                    description: format!(
                        "snapshot {} failed hash or authenticated payload verification",
                        snapshot_id
                    ),
                });
            }
        }
        Ok(issues)
    }

    /// 验证快照完整性（摘要、记录描述和解锁后的 payload）。
    pub fn verify_snapshot_integrity(
        conn: &VaultConnection,
        snapshot_id: &str,
    ) -> StorageResult<bool> {
        use crate::repo::snapshot::SnapshotRepo;
        SnapshotRepo::verify_integrity(conn, snapshot_id)
    }
}

fn physical_object_exists(
    conn: &VaultConnection,
    object_type: &str,
    object_id: &str,
) -> StorageResult<bool> {
    let (table, id_column) = match object_type {
        "project" => ("projects", "project_id"),
        "entry" => ("entries", "entry_id"),
        "attachment" => ("attachments", "attachment_id"),
        "object-relation" => ("object_relations", "relation_id"),
        "object-label" => ("object_labels", "label_id"),
        "object-label-assignment" => ("object_label_assignments", "assignment_id"),
        _ => return Ok(false),
    };
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {id_column} = ?1)");
    conn.inner()
        .query_row(&sql, rusqlite::params![object_id], |row| row.get(0))
        .map_err(StorageError::Database)
}

struct CommitIntegrityRow {
    commit_id: String,
    device_id: String,
    local_seq: u64,
    commit_kind: String,
    change_scope: String,
    changed_object_ids_ct: Vec<u8>,
    vector_clock: String,
    message_ct: Option<Vec<u8>>,
    created_at: String,
    integrity_tag: Vec<u8>,
}

fn looks_like_plain_history_payload(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes).is_ok()
}

/// WAL 恢复测试工具。
///
/// 模拟异常关闭后 WAL 恢复场景，验证数据完整性。
pub struct WalRecoveryTester;

impl WalRecoveryTester {
    /// 创建一个基于文件的数据库（启用 WAL 模式），写入数据后关闭，
    /// 然后重新打开验证数据完整。
    pub fn test_wal_recovery_roundtrip(db_path: &Path) -> StorageResult<WalRecoveryResult> {
        let mut result = WalRecoveryResult {
            entries_before_crash: 0,
            entries_after_recovery: 0,
            recovery_successful: false,
            issues: Vec::new(),
        };

        // Phase 1: 创建并写入
        {
            let conn = VaultConnection::create(db_path)?;

            // 手动初始化（简化版）
            let now = chrono::Utc::now().to_rfc3339();
            let vault_id = uuid::Uuid::new_v4().to_string();
            let commit_id = uuid::Uuid::new_v4().to_string();
            let branch_id = uuid::Uuid::new_v4().to_string();
            let key_epoch_id = uuid::Uuid::new_v4().to_string();
            let initial_key_epoch_marker =
                mdbx_crypto::aead::generate_key().map_err(StorageError::Crypto)?;

            conn.inner()
                .execute(
                    "INSERT INTO vault_meta (vault_id, format_version, created_at,
                     updated_at, default_tiga_mode, active_key_epoch_id)
                     VALUES (?1, 'MDBX-1', ?2, ?2, 'multi', ?3)",
                    rusqlite::params![vault_id, now, key_epoch_id],
                )
                .map_err(StorageError::Database)?;

            conn.inner()
                .execute(
                    "INSERT INTO commits (commit_id, device_id, local_seq, commit_kind,
                     change_scope, changed_object_ids_ct, vector_clock, message_ct,
                     created_at, integrity_tag)
                     VALUES (?1, 'test-device', 0, 'change', 'vault-meta', X'00',
                     '{}', NULL, ?2, X'00')",
                    rusqlite::params![commit_id, now],
                )
                .map_err(StorageError::Database)?;

            conn.inner()
                .execute(
                    "INSERT INTO branches (branch_id, branch_name, head_commit_id,
                     created_at, updated_at)
                     VALUES (?1, 'main', ?2, ?3, ?3)",
                    rusqlite::params![branch_id, commit_id, now],
                )
                .map_err(StorageError::Database)?;

            conn.inner()
                .execute(
                    "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at)
                     VALUES ('test-device', ?1, ?2)",
                    rusqlite::params![commit_id, now],
                )
                .map_err(StorageError::Database)?;

            conn.inner()
                .execute(
                    "INSERT INTO key_epochs (key_epoch_id, status, wrapped_epoch_key_ct,
                     kdf_profile_id, created_at, activated_at)
                     VALUES (?1, 'active', ?2, ?3, ?4, ?4)",
                    rusqlite::params![
                        key_epoch_id,
                        initial_key_epoch_marker,
                        INIT_KEY_EPOCH_PROFILE_ID,
                        now
                    ],
                )
                .map_err(StorageError::Database)?;

            // 写入一些 project 和 entry
            for i in 0..3 {
                let project_id = uuid::Uuid::new_v4().to_string();
                let entry_id = uuid::Uuid::new_v4().to_string();
                let obj_clock = format!("{{\"test-device\":{}}}", i + 1);

                conn.inner()
                    .execute(
                        "INSERT INTO projects (project_id, title_ct, object_clock,
                         head_commit_id, created_at, updated_at,
                         created_by_device_id, updated_by_device_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'test-device', 'test-device')",
                        rusqlite::params![
                            project_id,
                            format!("project-{}", i).as_bytes(),
                            obj_clock,
                            commit_id,
                            now
                        ],
                    )
                    .map_err(StorageError::Database)?;

                conn.inner()
                    .execute(
                        "INSERT INTO entries (entry_id, project_id, entry_type,
                         payload_ct, object_clock, head_commit_id,
                         created_at, updated_at, created_by_device_id, updated_by_device_id)
                         VALUES (?1, ?2, 'login', X'00', ?3, ?4, ?5, ?5, 'test-device', 'test-device')",
                        rusqlite::params![entry_id, project_id, obj_clock, commit_id, now],
                    )
                    .map_err(StorageError::Database)?;

                result.entries_before_crash += 1;
            }
            // conn 在作用域结束时关闭（模拟 crash）
        }

        // Phase 2: 重新打开并验证
        {
            let conn = VaultConnection::open(db_path)?;

            let count: i32 = conn
                .inner()
                .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
                .map_err(StorageError::Database)?;

            result.entries_after_recovery = count as u32;

            // 运行完整性检查
            match RecoveryVerifier::full_health_check(&conn) {
                Ok(health) => {
                    result.recovery_successful = health.healthy
                        && result.entries_before_crash == result.entries_after_recovery;
                    result.issues = health
                        .issues
                        .iter()
                        .map(|i| i.description.clone())
                        .collect();
                }
                Err(e) => {
                    result
                        .issues
                        .push(format!("health check after recovery failed: {}", e));
                }
            }
        }

        Ok(result)
    }
}

/// WAL 恢复测试结果。
#[derive(Debug, Clone)]
pub struct WalRecoveryResult {
    pub entries_before_crash: u32,
    pub entries_after_recovery: u32,
    pub recovery_successful: bool,
    pub issues: Vec<String>,
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::repo::attachment::AttachmentRepo;
    use crate::repo::commit_ctx::CommitContext;
    use crate::repo::conflict::ConflictRepo;
    use crate::repo::entry::EntryRepo;
    use crate::repo::object_label::{
        ObjectLabelAssignmentCreateRequest, ObjectLabelAssignmentRepo, ObjectLabelCreateRequest,
        ObjectLabelRepo,
    };
    use crate::repo::object_relation::{ObjectRelationCreateRequest, ObjectRelationRepo};
    use crate::repo::project::ProjectRepo;
    use mdbx_core::model::{ConflictObjectType, RelationKindId};

    fn setup() -> (VaultConnection, CommitContext, String) {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        let ctx = CommitContext::new("test-device".to_string());
        let project = ProjectRepo::create(&conn, &ctx, "Test", None, None).unwrap();
        (conn, ctx, project.project_id)
    }

    fn attach_test_keyring(conn: &mut VaultConnection) {
        let vault_key = mdbx_crypto::aead::generate_key().unwrap();
        let keyring =
            mdbx_crypto::keyring::Keyring::from_vault_key(&vault_key, b"recovery-test").unwrap();
        conn.attach_keyring(keyring);
    }

    fn tombstone_object_fixture(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
    ) -> Vec<(&'static str, String)> {
        let first = EntryRepo::create(
            conn,
            ctx,
            project_id,
            mdbx_core::model::EntryType::custom("com.monica.health.first").unwrap(),
            Some("First"),
            &serde_json::json!({"body":"first"}),
        )
        .unwrap();
        let second = EntryRepo::create(
            conn,
            ctx,
            project_id,
            mdbx_core::model::EntryType::custom("com.monica.health.second").unwrap(),
            Some("Second"),
            &serde_json::json!({"body":"second"}),
        )
        .unwrap();
        let attachment = AttachmentRepo::add(
            conn,
            ctx,
            project_id,
            Some(&first.entry_id),
            "health.bin",
            Some("application/octet-stream"),
            "",
            0,
        )
        .unwrap();
        let relation = ObjectRelationRepo::create(
            conn,
            ctx,
            ObjectRelationCreateRequest::new(
                &first.entry_id,
                &second.entry_id,
                RelationKindId::new("com.monica.health.related").unwrap(),
                serde_json::json!({}),
            ),
        )
        .unwrap();
        let label = ObjectLabelRepo::create(
            conn,
            ctx,
            ObjectLabelCreateRequest::new(project_id, "Health", serde_json::json!({})),
        )
        .unwrap();
        let assignment = ObjectLabelAssignmentRepo::create(
            conn,
            ctx,
            ObjectLabelAssignmentCreateRequest::new(&first.entry_id, &label.label_id),
        )
        .unwrap();

        vec![
            ("project", project_id.to_string()),
            ("entry", first.entry_id),
            ("attachment", attachment.attachment_id),
            ("object-relation", relation.relation_id),
            ("object-label", label.label_id),
            ("object-label-assignment", assignment.assignment_id),
        ]
    }

    // -----------------------------------------------------------------------
    // BASIC INTEGRITY
    // -----------------------------------------------------------------------

    #[test]
    fn test_basic_integrity_check_passes() {
        let (conn, _ctx, _p) = setup();
        RecoveryVerifier::check_basic_integrity(&conn).unwrap();
    }

    #[test]
    fn test_full_health_check_passes_on_clean_vault() {
        let (conn, _ctx, _p) = setup();
        let result = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(result.healthy);
        // 可能有 Info 级别的陈旧 head 告警（测试中 last_seen_at 是当前时间，不应触发旧设备检查）
        let has_errors = result
            .issues
            .iter()
            .any(|i| i.severity >= IssueSeverity::Error);
        assert!(!has_errors, "unexpected errors: {:?}", result.issues);
    }

    #[test]
    fn full_health_check_reports_authenticated_vault_header_tampering() {
        let (mut conn, _ctx, _project_id) = setup();
        crate::unlock::UnlockService::setup_password(&mut conn, "health-password").unwrap();
        assert!(RecoveryVerifier::full_health_check(&conn).unwrap().healthy);

        conn.inner()
            .execute("UPDATE vault_meta SET compat_flags = 'tampered'", [])
            .unwrap();
        let result = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(!result.healthy);
        assert!(result.issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error
                && issue.category == "vault-header-integrity"
                && issue.description.contains("invalidated")
        }));
    }

    #[test]
    fn full_health_check_verifies_an_established_incremental_root() {
        let (mut conn, _ctx, _project_id) = setup();
        crate::unlock::UnlockService::setup_password(&mut conn, "root-health-password").unwrap();
        crate::integrity_root::IntegrityRootService::enable(&conn).unwrap();

        let healthy = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(healthy.healthy, "unexpected issues: {:?}", healthy.issues);
        assert!(!healthy
            .issues
            .iter()
            .any(|issue| issue.category == "incremental-integrity-root"));

        conn.inner()
            .execute(
                "UPDATE mdbx_integrity_root_leaves SET integrity_tag = zeroblob(32)
                 WHERE key_hash = (SELECT key_hash FROM mdbx_integrity_root_leaves LIMIT 1)",
                [],
            )
            .unwrap();
        let damaged = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(!damaged.healthy);
        assert!(damaged.issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Critical
                && issue.category == "incremental-integrity-root"
                && issue.description.contains("authentication")
        }));
    }

    #[test]
    fn tombstone_consistency_detects_missing_markers_for_every_object_family() {
        let (conn, ctx, project_id) = setup();
        let objects = tombstone_object_fixture(&conn, &ctx, &project_id);

        ObjectLabelAssignmentRepo::soft_delete(&conn, &ctx, &objects[5].1).unwrap();
        ObjectLabelRepo::soft_delete(&conn, &ctx, &objects[4].1).unwrap();
        ObjectRelationRepo::soft_delete(&conn, &ctx, &objects[3].1).unwrap();
        AttachmentRepo::soft_delete(&conn, &ctx, &objects[2].1).unwrap();
        EntryRepo::soft_delete(&conn, &ctx, &objects[1].1).unwrap();
        ProjectRepo::soft_delete(&conn, &ctx, &objects[0].1).unwrap();
        conn.inner().execute("DELETE FROM tombstones", []).unwrap();

        let issues = RecoveryVerifier::check_tombstone_consistency(&conn).unwrap();
        for (object_type, object_id) in &objects {
            assert!(issues.iter().any(|issue| {
                issue.severity == IssueSeverity::Error
                    && issue.category == "tombstones"
                    && issue.description.contains(object_type)
                    && issue.description.contains(object_id)
                    && issue.description.contains("deleted without")
            }));
        }
        assert!(!RecoveryVerifier::full_health_check(&conn).unwrap().healthy);
    }

    #[test]
    fn tombstone_consistency_detects_stale_and_duplicate_markers() {
        let (conn, ctx, project_id) = setup();
        let objects = tombstone_object_fixture(&conn, &ctx, &project_id);
        for (object_type, object_id) in &objects {
            ctx.create_tombstone(&conn, object_type, object_id).unwrap();
        }

        let stale = RecoveryVerifier::check_tombstone_consistency(&conn).unwrap();
        assert_eq!(
            stale
                .iter()
                .filter(|issue| issue.description.contains("is active but retains"))
                .count(),
            objects.len()
        );

        ctx.create_tombstone(&conn, objects[0].0, &objects[0].1)
            .unwrap();
        let duplicated = RecoveryVerifier::check_tombstone_consistency(&conn).unwrap();
        assert!(duplicated.iter().any(|issue| {
            issue.description.contains(&objects[0].1)
                && issue.description.contains("has 2 typed tombstones")
        }));
    }

    #[test]
    fn tombstone_consistency_allows_unresolved_delete_conflict_marker() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("Conflicted"),
            &serde_json::json!({"password":"local"}),
        )
        .unwrap();
        ctx.create_tombstone(&conn, "entry", &entry.entry_id)
            .unwrap();
        ConflictRepo::create(
            &conn,
            &ctx,
            ConflictObjectType::Entry,
            &entry.entry_id,
            &entry.head_commit_id,
            &entry.head_commit_id,
            "incoming-delete",
            &["deleted".to_string()],
        )
        .unwrap();

        let issues = RecoveryVerifier::check_tombstone_consistency(&conn).unwrap();
        assert!(issues.is_empty(), "unexpected issues: {:?}", issues);
        assert!(RecoveryVerifier::full_health_check(&conn).unwrap().healthy);
    }

    #[test]
    fn full_health_check_reports_snapshot_hash_mismatch() {
        use crate::repo::snapshot::SnapshotRepo;

        let (conn, ctx, _project_id) = setup();
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = X'0000' WHERE snapshot_id = ?1",
                rusqlite::params![snapshot.snapshot_id],
            )
            .unwrap();

        let result = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(!result.healthy);
        assert!(result.issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error
                && issue.category == "snapshots"
                && issue.description.contains(&snapshot.snapshot_id)
        }));
    }

    #[test]
    fn full_health_check_authenticates_unlocked_snapshot_payload() {
        use crate::repo::snapshot::SnapshotRepo;
        use sha2::{Digest, Sha256};

        let (mut conn, ctx, _project_id) = setup();
        attach_test_keyring(&mut conn);
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        assert!(RecoveryVerifier::full_health_check(&conn).unwrap().healthy);

        let mut tampered = snapshot.snapshot_ct;
        let last = tampered.last_mut().unwrap();
        *last ^= 0x01;
        let recomputed_hash = format!("{:x}", Sha256::digest(&tampered));
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = ?1, snapshot_hash = ?2
                 WHERE snapshot_id = ?3",
                rusqlite::params![tampered, recomputed_hash, snapshot.snapshot_id],
            )
            .unwrap();

        let result = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(!result.healthy);
        assert!(result.issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error
                && issue.category == "snapshots"
                && issue.description.contains(&snapshot.snapshot_id)
        }));
    }

    #[test]
    fn full_health_check_reports_authenticated_snapshot_metadata_tampering() {
        use crate::repo::snapshot::SnapshotRepo;

        let (mut conn, ctx, _project_id) = setup();
        attach_test_keyring(&mut conn);
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        conn.inner()
            .execute(
                "UPDATE snapshots SET created_by_device_id = 'tampered-device'
                 WHERE snapshot_id = ?1",
                rusqlite::params![snapshot.snapshot_id],
            )
            .unwrap();

        let result = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(!result.healthy);
        assert!(result.issues.iter().any(|issue| {
            issue.severity == IssueSeverity::Error
                && issue.category == "snapshots"
                && issue.description.contains(&snapshot.snapshot_id)
        }));
    }

    // -----------------------------------------------------------------------
    // COMMIT CHAIN
    // -----------------------------------------------------------------------

    #[test]
    fn test_check_commit_chain_no_dangling_references() {
        let (conn, _ctx, _p) = setup();
        let issues = RecoveryVerifier::check_commit_chain(&conn).unwrap();
        let critical: Vec<_> = issues
            .iter()
            .filter(|i| i.severity >= IssueSeverity::Error)
            .collect();
        assert!(critical.is_empty(), "critical issues: {:?}", critical);
    }

    #[test]
    fn test_check_commit_chain_detects_dangling_branch() {
        let (conn, _ctx, _p) = setup();

        // 暂时禁用 FK 以便注入坏数据
        conn.inner().execute("PRAGMA foreign_keys=OFF", []).unwrap();

        // 插入一个指向不存在 commit 的 branch
        conn.inner()
            .execute(
                "INSERT INTO branches (branch_id, branch_name, head_commit_id,
                 created_at, updated_at)
                 VALUES ('bad-branch', 'bad', 'nonexistent-commit',
                 '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();

        conn.inner().execute("PRAGMA foreign_keys=ON", []).unwrap();

        let issues = RecoveryVerifier::check_commit_chain(&conn).unwrap();
        let critical: Vec<_> = issues
            .iter()
            .filter(|i| i.severity >= IssueSeverity::Critical)
            .collect();
        assert!(!critical.is_empty());
        assert!(critical[0].description.contains("bad-branch"));
    }

    #[test]
    fn test_check_commit_chain_detects_commit_integrity_tamper() {
        let (conn, _ctx, project_id) = setup();
        let commit_id: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM projects WHERE project_id = ?1",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .unwrap();

        conn.inner()
            .execute(
                "UPDATE commits SET change_scope = 'tampered-project' WHERE commit_id = ?1",
                rusqlite::params![commit_id],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_commit_chain(&conn).unwrap();
        let has_integrity_error = issues.iter().any(|i| {
            i.severity >= IssueSeverity::Error
                && i.category == "commit-integrity"
                && i.description.contains(&commit_id)
        });
        assert!(has_integrity_error, "issues: {:?}", issues);
    }

    #[test]
    fn test_check_commit_chain_accepts_legacy_plaintext_history_when_unlocked() {
        let (mut conn, _ctx, _p) = setup();

        // These commits were created before a keyring was attached, so their
        // history payload and integrity tag use the legacy plaintext profile.
        attach_test_keyring(&mut conn);

        let issues = RecoveryVerifier::check_commit_chain(&conn).unwrap();
        let errors: Vec<_> = issues
            .iter()
            .filter(|i| i.severity >= IssueSeverity::Error)
            .collect();
        assert!(errors.is_empty(), "unexpected errors: {:?}", errors);
    }

    // -----------------------------------------------------------------------
    // ATTACHMENT CHUNKS
    // -----------------------------------------------------------------------

    #[test]
    fn test_check_attachment_chunks_passes() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"username":"a"}),
        )
        .unwrap();

        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&entry.entry_id),
            "file.bin",
            Some("application/octet-stream"),
            "",
            0,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"data").unwrap();

        let issues = RecoveryVerifier::check_attachment_chunks(&conn).unwrap();
        assert!(issues.is_empty());
    }

    #[test]
    fn test_check_attachment_chunks_detects_count_mismatch() {
        let (conn, _ctx, project_id) = setup();

        // 手动创建附件元数据，但 chunk_count 与实际不符
        let now = chrono::Utc::now().to_rfc3339();
        let att_id = uuid::Uuid::new_v4().to_string();
        let commit_id = uuid::Uuid::new_v4().to_string();

        conn.inner()
            .execute(
                "INSERT INTO attachments (attachment_id, project_id, file_name_ct,
                 storage_mode, content_hash, original_size, stored_size,
                 chunk_count, head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
                 VALUES (?1, ?2, X'00', 'embedded-chunked', 'fake-hash',
                 100, 100, 3, ?3, ?4, ?4, 'dev', 'dev')",
                rusqlite::params![att_id, project_id, commit_id, now],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_attachment_chunks(&conn).unwrap();
        let has_mismatch = issues.iter().any(|i| i.description.contains("chunk_count"));
        assert!(has_mismatch);
    }

    // -----------------------------------------------------------------------
    // ORPHANS
    // -----------------------------------------------------------------------

    #[test]
    fn test_check_orphans_passes_on_clean_vault() {
        let (conn, ctx, project_id) = setup();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"username":"a"}),
        )
        .unwrap();

        let issues = RecoveryVerifier::check_orphans(&conn).unwrap();
        assert!(issues.is_empty());
    }

    #[test]
    fn test_check_orphans_detects_entry_without_project() {
        let (conn, _ctx, _p) = setup();

        // 暂时禁用 FK 以便注入坏数据
        conn.inner().execute("PRAGMA foreign_keys=OFF", []).unwrap();

        // 手动插入一个引用不存在 project 的 entry
        let now = chrono::Utc::now().to_rfc3339();
        conn.inner()
            .execute(
                "INSERT INTO entries (entry_id, project_id, entry_type, payload_ct,
                 object_clock, head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
                 VALUES ('orphan-entry', 'nonexistent-project', 'login', X'00',
                 '{}', 'fake-commit', ?1, ?1, 'dev', 'dev')",
                rusqlite::params![now],
            )
            .unwrap();

        conn.inner().execute("PRAGMA foreign_keys=ON", []).unwrap();

        let issues = RecoveryVerifier::check_orphans(&conn).unwrap();
        let has_orphan = issues
            .iter()
            .any(|i| i.description.contains("orphan-entry"));
        assert!(has_orphan);
    }

    // -----------------------------------------------------------------------
    // STALE HEADS
    // -----------------------------------------------------------------------

    #[test]
    fn test_check_stale_heads_detects_dangling_head() {
        let (conn, _ctx, _p) = setup();

        // 暂时禁用 FK 以便注入坏数据
        conn.inner().execute("PRAGMA foreign_keys=OFF", []).unwrap();

        // 插入指向不存在 commit 的 device head
        conn.inner()
            .execute(
                "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at)
                 VALUES ('ghost-device', 'nonexistent-commit', '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();

        conn.inner().execute("PRAGMA foreign_keys=ON", []).unwrap();

        let issues = RecoveryVerifier::check_stale_heads(&conn).unwrap();
        let has_critical = issues.iter().any(|i| {
            i.severity >= IssueSeverity::Critical && i.description.contains("ghost-device")
        });
        assert!(has_critical);
    }

    #[test]
    fn test_check_stale_heads_reports_old_devices() {
        let (conn, _ctx, _p) = setup();

        // 插入一个 last_seen_at 很旧的设备（不指向不存在 commit）
        let now = chrono::Utc::now().to_rfc3339();
        let commit_id = uuid::Uuid::new_v4().to_string();
        conn.inner()
            .execute(
                "INSERT INTO commits (commit_id, device_id, local_seq, commit_kind,
                 change_scope, changed_object_ids_ct, vector_clock, message_ct,
                 created_at, integrity_tag)
                 VALUES (?1, 'old-device', 1, 'change', 'project', X'00',
                 '{}', NULL, ?2, X'00')",
                rusqlite::params![commit_id, now],
            )
            .unwrap();
        conn.inner()
            .execute(
                "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at)
                 VALUES ('old-device', ?1, '2020-01-01T00:00:00Z')",
                rusqlite::params![commit_id],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_stale_heads(&conn).unwrap();
        let has_info = issues
            .iter()
            .any(|i| i.severity == IssueSeverity::Info && i.description.contains("old-device"));
        assert!(has_info);
    }

    #[test]
    fn full_health_check_detects_non_causal_tombstone_acknowledgement() {
        let (conn, ctx, project_id) = setup();
        let before_delete: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM projects WHERE project_id = ?1",
                [&project_id],
                |row| row.get(0),
            )
            .unwrap();
        ProjectRepo::soft_delete(&conn, &ctx, &project_id).unwrap();
        conn.inner()
            .execute(
                "UPDATE tombstone_acknowledgements
                 SET observed_commit_id = ?1
                 WHERE device_id = 'test-device'
                   AND tombstone_id = (
                       SELECT tombstone_id FROM tombstones
                       WHERE target_object_type = 'project' AND target_object_id = ?2
                   )",
                rusqlite::params![before_delete, project_id],
            )
            .unwrap();

        let health = RecoveryVerifier::full_health_check(&conn).unwrap();
        assert!(health.issues.iter().any(|issue| {
            issue.category == "tombstone-acknowledgements"
                && issue.description.contains("does not causally contain")
        }));
    }

    #[test]
    fn test_check_stale_heads_detects_wrong_commit_device() {
        let (conn, _ctx, project_id) = setup();
        let head_commit_id: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM projects WHERE project_id = ?1",
                [&project_id],
                |row| row.get(0),
            )
            .unwrap();
        conn.inner()
            .execute(
                "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at)
                 VALUES ('claimed-device', ?1, '2026-07-26T00:00:00Z')",
                [&head_commit_id],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_stale_heads(&conn).unwrap();
        assert!(issues.iter().any(|issue| {
            issue.severity >= IssueSeverity::Critical
                && issue.description.contains("claimed-device")
                && issue.description.contains("test-device")
        }));
    }

    #[test]
    fn test_check_stale_heads_detects_regressed_sequence() {
        let (conn, ctx, _project_id) = setup();
        ProjectRepo::create(&conn, &ctx, "Second", None, None).unwrap();
        let older_commit_id: String = conn
            .inner()
            .query_row(
                "SELECT commit_id FROM commits WHERE device_id = 'test-device'
                 ORDER BY local_seq ASC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE device_heads SET head_commit_id = ?1
                 WHERE device_id = 'test-device'",
                [&older_commit_id],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_stale_heads(&conn).unwrap();
        assert!(issues.iter().any(|issue| {
            issue.severity >= IssueSeverity::Error
                && issue.description.contains("test-device")
                && issue.description.contains("behind local sequence")
        }));
    }

    // -----------------------------------------------------------------------
    // CHUNK CORRUPTION
    // -----------------------------------------------------------------------

    #[test]
    fn test_detect_chunk_hash_mismatch() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"username":"a"}),
        )
        .unwrap();

        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&entry.entry_id),
            "data.bin",
            Some("application/octet-stream"),
            "",
            0,
        )
        .unwrap();

        // 写 chunk 内容
        AttachmentRepo::write_inline_content(&conn, &ctx, &att.attachment_id, b"original-content")
            .unwrap();

        // 模拟损坏：直接修改 chunk 内容
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = X'DEADBEEF'
                 WHERE attachment_id = ?1",
                rusqlite::params![att.attachment_id],
            )
            .unwrap();

        // 完整性验证应该检测到
        let result = AttachmentRepo::verify_integrity(&conn, &att.attachment_id);
        assert!(result.is_err() || !result.unwrap());
    }

    #[test]
    fn test_detect_missing_chunk() {
        let (conn, ctx, project_id) = setup();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"username":"a"}),
        )
        .unwrap();

        let att = AttachmentRepo::add(
            &conn,
            &ctx,
            &project_id,
            Some(&entry.entry_id),
            "chunked.bin",
            Some("application/octet-stream"),
            "",
            0,
        )
        .unwrap();

        // 写 chunked 内容（会自动分块）
        AttachmentRepo::write_chunked_content(
            &conn,
            &ctx,
            &att.attachment_id,
            b"chunk-0-data-plus-chunk-1-data",
            256,
        )
        .unwrap();

        // 手动修改 chunk_count 制造不一致
        conn.inner()
            .execute(
                "UPDATE attachments SET chunk_count = 99
                 WHERE attachment_id = ?1",
                rusqlite::params![att.attachment_id],
            )
            .unwrap();

        let issues = RecoveryVerifier::check_attachment_chunks(&conn).unwrap();
        let has_mismatch = issues
            .iter()
            .any(|i| i.description.contains(&att.attachment_id));
        assert!(has_mismatch);
    }

    // -----------------------------------------------------------------------
    // WAL RECOVERY
    // -----------------------------------------------------------------------

    #[test]
    fn test_wal_recovery_preserves_data() {
        let dir = std::env::temp_dir();
        let db_path = dir.join(format!("mdbx-wal-test-{}.mdbx", uuid::Uuid::new_v4()));

        let result = WalRecoveryTester::test_wal_recovery_roundtrip(&db_path).unwrap();
        assert!(result.recovery_successful);
        assert_eq!(result.entries_before_crash, 3);
        assert_eq!(
            result.entries_after_recovery, 3,
            "data lost after WAL recovery"
        );

        // 清理
        let _ = std::fs::remove_file(&db_path);
        // 也清理 WAL 和 SHM 文件
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-shm"));
    }

    #[test]
    fn test_wal_recovery_multiple_connections() {
        // 模拟 crash-recovery：写入 → 关闭 → 重新打开 → 验证
        let dir = std::env::temp_dir();
        let db_path = dir.join(format!("mdbx-wal-multi-{}.mdbx", uuid::Uuid::new_v4()));

        // 第一次打开，写入数据
        {
            let conn = VaultConnection::create(&db_path).unwrap();
            let params = VaultInitParams::default();
            initialize_vault(&conn, &params).unwrap();

            let ctx = CommitContext::new("test-device".to_string());
            let p = ProjectRepo::create(&conn, &ctx, "Survivor", None, None).unwrap();
            EntryRepo::create(
                &conn,
                &ctx,
                &p.project_id,
                mdbx_core::model::EntryType::Login,
                Some("Login"),
                &serde_json::json!({"username":"survivor", "password":"secret"}),
            )
            .unwrap();
            // conn 在此关闭
        }

        // 重新打开，验证数据完整
        {
            let conn = VaultConnection::open(&db_path).unwrap();
            let projects = ProjectRepo::list_all(&conn).unwrap();

            // 先检查基本完整性
            RecoveryVerifier::check_basic_integrity(&conn).unwrap();

            let survivor = projects
                .iter()
                .find(|p| String::from_utf8_lossy(&p.title_ct) == "Survivor");
            assert!(
                survivor.is_some(),
                "project 'Survivor' lost after WAL recovery"
            );

            let entries = EntryRepo::list_by_project(&conn, &survivor.unwrap().project_id).unwrap();
            assert_eq!(entries.len(), 1);
        }

        // 清理
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-shm"));
    }

    // -----------------------------------------------------------------------
    // SNAPSHOT INTEGRITY
    // -----------------------------------------------------------------------

    #[test]
    fn test_snapshot_integrity_after_recovery() {
        use crate::repo::snapshot::SnapshotRepo;

        let (conn, ctx, project_id) = setup();
        EntryRepo::create(
            &conn,
            &ctx,
            &project_id,
            mdbx_core::model::EntryType::Login,
            Some("E"),
            &serde_json::json!({"username":"a"}),
        )
        .unwrap();

        // 创建快照
        let snapshot = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        assert!(
            RecoveryVerifier::verify_snapshot_integrity(&conn, &snapshot.snapshot_id,).unwrap()
        );

        // 模拟腐败：修改快照密文
        conn.inner()
            .execute(
                "UPDATE snapshots SET snapshot_ct = X'0000' WHERE snapshot_id = ?1",
                rusqlite::params![snapshot.snapshot_id],
            )
            .unwrap();

        // 验证应失败
        assert!(
            !RecoveryVerifier::verify_snapshot_integrity(&conn, &snapshot.snapshot_id,).unwrap()
        );
    }

    // -----------------------------------------------------------------------
    // COMPREHENSIVE HEALTH CHECK
    // -----------------------------------------------------------------------

    #[test]
    fn test_health_check_detects_multiple_issues() {
        let (conn, _ctx, _p) = setup();

        // 暂时禁用 FK 以便注入坏数据
        conn.inner().execute("PRAGMA foreign_keys=OFF", []).unwrap();

        // 注入多种问题
        let now = chrono::Utc::now().to_rfc3339();

        // 1. 孤儿 entry
        conn.inner()
            .execute(
                "INSERT INTO entries (entry_id, project_id, entry_type, payload_ct,
                 object_clock, head_commit_id, created_at, updated_at,
                 created_by_device_id, updated_by_device_id)
                 VALUES ('orphan-1', 'no-such-project', 'login', X'00',
                 '{}', 'fake', ?1, ?1, 'dev', 'dev')",
                rusqlite::params![now],
            )
            .unwrap();

        // 2. 陈旧的 device head
        conn.inner()
            .execute(
                "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at)
                 VALUES ('ghost-1', 'no-such-commit', '2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();

        conn.inner().execute("PRAGMA foreign_keys=ON", []).unwrap();

        let result = RecoveryVerifier::full_health_check(&conn).unwrap();

        assert!(!result.healthy); // 孤儿 entry 导致不健康

        let has_orphan = result
            .issues
            .iter()
            .any(|i| i.description.contains("orphan-1"));
        let has_ghost = result
            .issues
            .iter()
            .any(|i| i.description.contains("ghost-1"));
        assert!(has_orphan);
        assert!(has_ghost);
    }

    // -----------------------------------------------------------------------
    // RESUME AFTER INTERRUPTED WRITE (SIMULATED)
    // -----------------------------------------------------------------------

    #[test]
    fn test_resume_after_interrupted_write() {
        // 模拟：写入一半时中断，然后重新打开验证
        let dir = std::env::temp_dir();
        let db_path = dir.join(format!("mdbx-interrupt-{}.mdbx", uuid::Uuid::new_v4()));

        // Phase 1: 正常创建和写入
        {
            let conn = VaultConnection::create(&db_path).unwrap();
            let params = VaultInitParams::default();
            initialize_vault(&conn, &params).unwrap();

            let ctx = CommitContext::new("test-device".to_string());
            for i in 0..5 {
                let p = ProjectRepo::create(&conn, &ctx, &format!("Project-{}", i), None, None)
                    .unwrap();

                // 为每个 project 写一个 entry（不在事务中，模拟可能中断）
                let _ = EntryRepo::create(
                    &conn,
                    &ctx,
                    &p.project_id,
                    mdbx_core::model::EntryType::Login,
                    Some("Login"),
                    &serde_json::json!({"username": format!("user-{}", i)}),
                );
            }
            // conn 正常关闭
        }

        // Phase 2: 验证数据完整
        {
            let conn = VaultConnection::open(&db_path).unwrap();
            // SQLite WAL 应自动恢复
            RecoveryVerifier::check_basic_integrity(&conn).unwrap();

            let projects = ProjectRepo::list_all(&conn).unwrap();
            assert_eq!(
                projects.len(),
                5,
                "some projects lost after interrupted write simulation"
            );

            let result = RecoveryVerifier::full_health_check(&conn).unwrap();
            let errors: Vec<_> = result
                .issues
                .iter()
                .filter(|i| i.severity >= IssueSeverity::Error)
                .collect();
            assert!(errors.is_empty(), "errors after recovery: {:?}", errors);
        }

        // 清理
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-wal"));
        let _ = std::fs::remove_file(db_path.with_extension("mdbx-shm"));
    }
}
