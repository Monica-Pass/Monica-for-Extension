#[path = "sync_apply/api.rs"]
mod api_apply;
#[path = "sync_apply/attachment.rs"]
mod attachment_apply;
#[path = "sync_apply/commit_graph.rs"]
mod commit_graph_apply;
#[path = "sync_apply/commit_ingest.rs"]
mod commit_ingest_apply;
#[path = "sync_apply/entry.rs"]
mod entry_apply;
#[path = "sync_apply/generic_metadata.rs"]
mod generic_metadata_apply;
#[path = "sync_apply/key_epoch.rs"]
mod key_epoch_apply;
#[path = "sync_apply/lifecycle.rs"]
mod lifecycle_apply;
#[path = "sync_apply/object_merge.rs"]
mod object_merge_apply;
#[path = "sync_apply/payload.rs"]
mod payload_apply;
#[path = "sync_apply/project.rs"]
mod project_apply;
#[path = "sync_apply/state.rs"]
mod state_apply;
#[path = "sync_apply/tiga.rs"]
mod tiga_apply;

#[cfg(test)]
use mdbx_core::tiga::TigaPolicyOverride;
#[cfg(test)]
use mdbx_sync::SerializedCommit;

#[cfg(test)]
use crate::connection::VaultConnection;
#[cfg(test)]
use crate::error::{StorageError, StorageResult};
#[cfg(test)]
use crate::repo::CommitContext;
#[cfg(test)]
use crate::sync_state::{SecurityAuditEventRow, TigaPolicyOverrideRow, TigaVaultStateRow};
#[cfg(test)]
use crate::tiga_policy::optional_integrity_tag;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApplyBatchResult {
    pub applied_commits: u32,
    pub skipped_commits: u32,
    pub conflict_count: u32,
    pub missing_parent_count: u32,
}

pub struct SyncApplyRepo;

impl SyncApplyRepo {
    #[cfg(test)]
    fn commit_exists(conn: &VaultConnection, commit_id: &str) -> StorageResult<bool> {
        crate::repo::CommitGraphRepo::commit_exists(conn, commit_id)
    }

    #[cfg(test)]
    fn parent_ids_for_commit(
        conn: &VaultConnection,
        commit_id: &str,
    ) -> StorageResult<Vec<String>> {
        crate::repo::CommitGraphRepo::parent_ids(conn, commit_id)
    }

    #[cfg(test)]
    fn sync_device_head(
        conn: &VaultConnection,
        serialized: &SerializedCommit,
    ) -> StorageResult<()> {
        commit_graph_apply::sync_device_head(conn, serialized)
    }

    #[cfg(test)]
    fn current_branch_head(
        conn: &VaultConnection,
        branch_id: Option<&str>,
        branch_name: &str,
    ) -> StorageResult<Option<String>> {
        commit_graph_apply::current_branch_head(conn, branch_id, branch_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commit_integrity::compute_commit_integrity_tag;
    use crate::commit_integrity::CommitIntegrityInput;
    use crate::init::{initialize_vault, VaultInitParams};
    use crate::key_epoch::{KeyEpochRotationResult, KeyEpochService};
    use crate::repo::{
        AttachmentRepo, CollectionProfileRepo, CollectionProfileSpec, CommitChange,
        CommitOperation, ConflictRepo, EntryRepo, ObjectLabelAssignmentCreateRequest,
        ObjectLabelAssignmentRepo, ObjectLabelCreateRequest, ObjectLabelRepo,
        ObjectRelationCreateRequest, ObjectRelationRepo, ObjectVersionRepo, ProjectRepo,
        TombstoneRepo,
    };
    use crate::sync_delta::{
        decode_sync_delta_body, load_sync_delta_envelope, sync_delta_object_payload,
        DeletedSyncEntity, DeviceHeadRow, NewSyncDeltaEnvelope, SyncDeltaBatchKind, SyncDeltaBody,
        SyncDeltaEnvelope, SyncDeltaLimits,
    };
    use crate::sync_state::{
        collect_sync_state, collect_sync_state_payload, SyncStateLimits,
        TombstoneAcknowledgementRow,
    };
    use crate::tiga::TigaService;
    use crate::tiga_policy::TigaAuthorizationContext;
    use crate::unlock::UnlockService;
    use mdbx_core::model::{
        ChangeScope, CollectionTypeId, Commit, CommitKind, ConflictObjectType, ConflictResolution,
        EntryType, ExtensionCapabilityId, ObjectTypeId, RelationKindId, UnlockMethodType,
        VaultSession,
    };
    use mdbx_core::tiga::{
        DeviceAssurance, DeviceContext, SessionAssurance, TigaScope, TIGA_POLICY_VERSION,
    };

    #[test]
    fn synced_tiga_scope_accepts_attachment_ids() {
        assert_eq!(
            tiga_apply::tiga_scope_from_parts("attachment", "attachment-1").unwrap(),
            TigaScope::Attachment {
                attachment_id: "attachment-1".to_string()
            }
        );
    }
    use mdbx_crypto::keyring::Keyring;
    use mdbx_sync::{
        CommitBatch, CommitOperationMetadata, ObjectPayload, SerializedCommit, TombstoneRecord,
    };
    use rusqlite::{params, OptionalExtension};
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use uuid::Uuid;

    fn setup() -> (VaultConnection, CommitContext) {
        let conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        let ctx = CommitContext::new("device-a".to_string());
        (conn, ctx)
    }

    #[test]
    fn synced_tiga_records_reject_invalid_authenticated_tags() {
        let mut conn = VaultConnection::open_in_memory().unwrap();
        initialize_vault(&conn, &VaultInitParams::default()).unwrap();
        conn.attach_keyring(Keyring::from_vault_key(&[9_u8; 32], b"sync-tiga-test").unwrap());

        let policy = TigaPolicyOverride {
            clipboard_allowed: Some(false),
            ..Default::default()
        };
        let mut policy_tag = optional_integrity_tag(&conn, b"tiga-policy-override", &policy)
            .unwrap()
            .unwrap();
        policy_tag[0] ^= 1;
        let error = tiga_apply::apply_tiga_policy_overrides(
            &conn,
            &[TigaPolicyOverrideRow {
                scope_type: "vault".to_string(),
                scope_id: String::new(),
                policy_json: serde_json::to_string(&policy).unwrap(),
                exception_id: None,
                updated_at: "2026-07-19T00:00:00Z".to_string(),
                updated_by_device_id: "remote".to_string(),
                integrity_tag: Some(policy_tag),
            }],
        )
        .unwrap_err();
        assert!(error.to_string().contains("integrity tag mismatch"));

        let state_error = tiga_apply::apply_tiga_vault_state(
            &conn,
            &TigaVaultStateRow {
                default_tiga_mode: "multi".to_string(),
                policy_version: TIGA_POLICY_VERSION + 1,
                compliance_status: "compliant".to_string(),
                updated_at: "2026-07-19T00:00:00Z".to_string(),
            },
        )
        .unwrap_err();
        assert!(state_error
            .to_string()
            .contains("unsupported incoming Tiga policy version"));
    }

    #[test]
    fn synced_tiga_policy_conflicts_merge_to_stricter_fields() {
        let (conn, _) = setup();
        let local = TigaPolicyOverride {
            clipboard_allowed: Some(true),
            clipboard_ttl_secs: Some(30),
            minimum_auth_factors: Some(2),
            ..Default::default()
        };
        conn.inner()
            .execute(
                "INSERT INTO tiga_policy_overrides
                    (scope_type, scope_id, policy_json, exception_id, updated_at,
                     updated_by_device_id, integrity_tag)
                 VALUES ('vault', '', ?1, NULL, '2026-01-01T00:00:00Z', 'local', NULL)",
                params![serde_json::to_string(&local).unwrap()],
            )
            .unwrap();
        let incoming = TigaPolicyOverride {
            clipboard_allowed: Some(false),
            clipboard_ttl_secs: Some(10),
            minimum_auth_factors: Some(1),
            ..Default::default()
        };
        tiga_apply::apply_tiga_policy_overrides(
            &conn,
            &[TigaPolicyOverrideRow {
                scope_type: "vault".to_string(),
                scope_id: String::new(),
                policy_json: serde_json::to_string(&incoming).unwrap(),
                exception_id: None,
                updated_at: "2026-01-02T00:00:00Z".to_string(),
                updated_by_device_id: "remote".to_string(),
                integrity_tag: None,
            }],
        )
        .unwrap();
        let stored: String = conn
            .inner()
            .query_row(
                "SELECT policy_json FROM tiga_policy_overrides
                 WHERE scope_type = 'vault' AND scope_id = ''",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let stored: TigaPolicyOverride = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored.clipboard_allowed, Some(false));
        assert_eq!(stored.clipboard_ttl_secs, Some(10));
        assert_eq!(stored.minimum_auth_factors, Some(2));
    }

    #[test]
    fn synced_tiga_vault_state_never_lowers_profile_or_compliance() {
        let (conn, _) = setup();
        conn.inner()
            .execute(
                "UPDATE vault_meta SET default_tiga_mode = 'power',
                 tiga_compliance_status = 'remediation-required'",
                [],
            )
            .unwrap();
        tiga_apply::apply_tiga_vault_state(
            &conn,
            &TigaVaultStateRow {
                default_tiga_mode: "sky".to_string(),
                policy_version: 1,
                compliance_status: "compliant".to_string(),
                updated_at: "2026-01-02T00:00:00Z".to_string(),
            },
        )
        .unwrap();
        let state: (String, i64, String) = conn
            .inner()
            .query_row(
                "SELECT default_tiga_mode, tiga_policy_version, tiga_compliance_status
                 FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(state.0, "power");
        assert_eq!(state.1, i64::from(TIGA_POLICY_VERSION));
        assert_eq!(state.2, "remediation-required");
    }

    #[test]
    fn synced_audit_event_id_cannot_be_rewritten() {
        let (conn, _) = setup();
        let mut event = SecurityAuditEventRow {
            event_id: "event-1".to_string(),
            occurred_at: "2026-01-01T00:00:00Z".to_string(),
            operation: "copy-secret".to_string(),
            outcome: "allow".to_string(),
            scope_type: "vault".to_string(),
            scope_id: String::new(),
            session_id: None,
            device_id: Some("device-a".to_string()),
            reason_codes_json: "[]".to_string(),
            constraints_json: "[]".to_string(),
            exception_id: None,
            operation_id: None,
            commit_id: None,
            policy_version: None,
            policy_fingerprint: None,
            integrity_tag: None,
        };
        tiga_apply::apply_security_audit_events(&conn, &[event.clone()]).unwrap();
        event.outcome = "deny".to_string();
        let error = tiga_apply::apply_security_audit_events(&conn, &[event]).unwrap_err();
        assert!(error.to_string().contains("was rewritten"));
    }

    fn make_commit(
        commit_id: &str,
        device_id: &str,
        local_seq: u64,
        parents: Vec<String>,
        changed: Vec<String>,
        object_id: &str,
        payload_object_type: &str,
    ) -> SerializedCommit {
        let commit = Commit {
            commit_id: commit_id.to_string(),
            device_id: device_id.to_string(),
            local_seq,
            commit_kind: CommitKind::Change,
            change_scope: ChangeScope::Project,
            changed_object_ids_ct: serde_json::to_vec(&changed).unwrap(),
            vector_clock: format!(r#"{{"{}":{}}}"#, device_id, local_seq),
            message_ct: None,
            created_at: "2026-05-22T00:00:00Z".to_string(),
            integrity_tag: vec![],
        };
        let tag = compute_commit_integrity_tag(
            None,
            &CommitIntegrityInput {
                commit_id: &commit.commit_id,
                device_id: &commit.device_id,
                local_seq: commit.local_seq,
                commit_kind: &commit.commit_kind.to_string(),
                change_scope: &commit.change_scope.to_string(),
                changed_object_ids_ct: &commit.changed_object_ids_ct,
                vector_clock: &commit.vector_clock,
                message_ct: None,
                created_at: &commit.created_at,
                parents: &parents,
            },
        )
        .unwrap();
        SerializedCommit {
            commit: Commit {
                integrity_tag: tag,
                ..commit
            },
            operation: None,
            parent_ids: parents,
            tombstones: vec![TombstoneRecord {
                tombstone_id: format!("t-{}", commit_id),
                target_object_type: payload_object_type.to_string(),
                target_object_id: object_id.to_string(),
                delete_clock: "{}".to_string(),
                deleted_by_device_id: device_id.to_string(),
                deleted_at: "2026-05-22T00:00:00Z".to_string(),
            }],
            object_payloads: vec![ObjectPayload {
                object_type: payload_object_type.to_string(),
                object_id: object_id.to_string(),
                ciphertext: vec![1, 2, 3],
                associated_data: vec![],
            }],
        }
    }

    fn resign_serialized_commit(conn: &VaultConnection, serialized: &mut SerializedCommit) {
        let commit_kind = serialized.commit.commit_kind.to_string();
        let change_scope = serialized.commit.change_scope.to_string();
        serialized.commit.integrity_tag = compute_commit_integrity_tag(
            conn.keyring(),
            &CommitIntegrityInput {
                commit_id: &serialized.commit.commit_id,
                device_id: &serialized.commit.device_id,
                local_seq: serialized.commit.local_seq,
                commit_kind: &commit_kind,
                change_scope: &change_scope,
                changed_object_ids_ct: &serialized.commit.changed_object_ids_ct,
                vector_clock: &serialized.commit.vector_clock,
                message_ct: serialized.commit.message_ct.as_deref(),
                created_at: &serialized.commit.created_at,
                parents: &serialized.parent_ids,
            },
        )
        .unwrap();
    }

    fn graph_only_commit(
        commit_id: &str,
        device_id: &str,
        local_seq: u64,
        parents: Vec<String>,
    ) -> SerializedCommit {
        let mut commit = make_commit(
            commit_id,
            device_id,
            local_seq,
            parents,
            Vec::new(),
            "unused-object",
            "project",
        );
        commit.tombstones.clear();
        commit.object_payloads.clear();
        commit
    }

    struct AcknowledgementGraph {
        before_delete: &'static str,
        delete: &'static str,
        descendant: &'static str,
        concurrent_left: &'static str,
        concurrent_right: &'static str,
    }

    fn insert_acknowledgement_graph(conn: &VaultConnection) -> AcknowledgementGraph {
        let graph = AcknowledgementGraph {
            before_delete: "ack-before-delete",
            delete: "ack-delete",
            descendant: "ack-descendant",
            concurrent_left: "ack-concurrent-left",
            concurrent_right: "ack-concurrent-right",
        };
        let genesis = SyncApplyRepo::current_branch_head(conn, None, "main")
            .unwrap()
            .unwrap();
        let commits = [
            graph_only_commit(graph.before_delete, "ack-graph-device", 1, vec![genesis]),
            graph_only_commit(
                graph.delete,
                "ack-graph-device",
                2,
                vec![graph.before_delete.to_string()],
            ),
            graph_only_commit(
                graph.descendant,
                "ack-graph-device",
                3,
                vec![graph.delete.to_string()],
            ),
            graph_only_commit(
                graph.concurrent_left,
                "ack-graph-device",
                4,
                vec![graph.delete.to_string()],
            ),
            graph_only_commit(
                graph.concurrent_right,
                "ack-graph-device",
                5,
                vec![graph.delete.to_string()],
            ),
        ];
        for commit in &commits {
            commit_ingest_apply::insert_commit(conn, commit).unwrap();
        }
        conn.inner()
            .execute(
                "INSERT INTO tombstones
                    (tombstone_id, target_object_type, target_object_id, delete_clock,
                     deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id)
                 VALUES ('ack-tombstone', 'entry', 'ack-object', '{}',
                         'ack-device', '2026-05-22T00:00:00Z', NULL, ?1)",
                [graph.delete],
            )
            .unwrap();
        graph
    }

    fn write_acknowledgement(
        conn: &VaultConnection,
        observed_commit_id: &str,
        acknowledged_at: &str,
    ) {
        conn.inner()
            .execute(
                "INSERT INTO tombstone_acknowledgements
                    (tombstone_id, device_id, observed_commit_id, acknowledged_at)
                 VALUES ('ack-tombstone', 'ack-device', ?1, ?2)
                 ON CONFLICT(tombstone_id, device_id) DO UPDATE SET
                    observed_commit_id = excluded.observed_commit_id,
                    acknowledged_at = excluded.acknowledged_at",
                params![observed_commit_id, acknowledged_at],
            )
            .unwrap();
    }

    fn read_acknowledgement(conn: &VaultConnection) -> (String, String) {
        conn.inner()
            .query_row(
                "SELECT observed_commit_id, acknowledged_at
                 FROM tombstone_acknowledgements
                 WHERE tombstone_id = 'ack-tombstone' AND device_id = 'ack-device'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    fn assert_rejected_commit_has_no_graph_side_effects(
        conn: &VaultConnection,
        commit_id: &str,
        device_id: &str,
        original_head: &str,
    ) {
        assert!(!SyncApplyRepo::commit_exists(conn, commit_id).unwrap());
        let inventory_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_inventory WHERE commit_id = ?1",
                params![commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(inventory_count, 0);
        let parent_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_parents WHERE commit_id = ?1",
                params![commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent_count, 0);
        let sequence_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_device_sequences WHERE device_id = ?1",
                params![device_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sequence_count, 0);
        assert_eq!(
            SyncApplyRepo::current_branch_head(conn, None, "main")
                .unwrap()
                .as_deref(),
            Some(original_head)
        );
    }

    #[test]
    fn synced_device_head_preserves_local_revocation() {
        let (conn, _) = setup();
        let first = make_commit(
            "remote-1",
            "remote-device",
            1,
            Vec::new(),
            vec!["project-1".to_string()],
            "project-1",
            "project",
        );
        commit_ingest_apply::insert_commit(&conn, &first).unwrap();
        conn.inner()
            .execute(
                "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at, revoked)
                 VALUES (?1, ?2, ?3, 1)",
                params![
                    first.commit.device_id,
                    first.commit.commit_id,
                    first.commit.created_at
                ],
            )
            .unwrap();

        let second = make_commit(
            "remote-2",
            "remote-device",
            2,
            vec!["remote-1".to_string()],
            vec!["project-1".to_string()],
            "project-1",
            "project",
        );
        commit_ingest_apply::insert_commit(&conn, &second).unwrap();
        SyncApplyRepo::sync_device_head(&conn, &second).unwrap();

        let stored: (String, i64) = conn
            .inner()
            .query_row(
                "SELECT head_commit_id, revoked FROM device_heads WHERE device_id = ?1",
                params![second.commit.device_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, second.commit.commit_id);
        assert_eq!(stored.1, 1);
    }

    #[test]
    fn synced_device_head_does_not_regress_to_delayed_commit() {
        let (conn, ctx) = setup();
        let genesis = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let mut newer =
            graph_only_commit("remote-newer", "remote-device", 2, vec![genesis.clone()]);
        newer.commit.created_at = "2026-05-22T02:00:00Z".to_string();
        resign_serialized_commit(&conn, &mut newer);
        SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![newer], 0, true)).unwrap();

        let mut delayed = graph_only_commit("remote-delayed", "remote-device", 1, vec![genesis]);
        delayed.commit.created_at = "2026-05-22T01:00:00Z".to_string();
        resign_serialized_commit(&conn, &mut delayed);
        SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![delayed], 0, true)).unwrap();

        let stored: (String, String) = conn
            .inner()
            .query_row(
                "SELECT head_commit_id, last_seen_at FROM device_heads
                 WHERE device_id = 'remote-device'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored.0, "remote-newer");
        assert_eq!(stored.1, "2026-05-22T02:00:00Z");
    }

    #[test]
    fn synced_commit_rejects_reused_device_sequence() {
        let (conn, ctx) = setup();
        let genesis = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let first = graph_only_commit(
            "remote-sequence-first",
            "remote-device",
            1,
            vec![genesis.clone()],
        );
        SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![first], 0, true)).unwrap();

        let conflicting = graph_only_commit(
            "remote-sequence-conflict",
            "remote-device",
            1,
            vec![genesis],
        );
        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![conflicting], 0, true))
                .unwrap_err();
        assert!(matches!(&error, StorageError::Validation(_)));
        assert!(error.to_string().contains("local sequence 1"));
        assert!(!SyncApplyRepo::commit_exists(&conn, "remote-sequence-conflict").unwrap());
        assert_eq!(
            SyncApplyRepo::current_branch_head(&conn, None, "main")
                .unwrap()
                .as_deref(),
            Some("remote-sequence-first")
        );
        let device_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM device_heads WHERE device_id = 'remote-device'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(device_head, "remote-sequence-first");
    }

    #[test]
    fn sync_delta_device_head_advances_by_device_sequence_across_branches() {
        let (conn, _) = setup();
        let genesis = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let older = graph_only_commit(
            "delta-device-older",
            "delta-device",
            1,
            vec![genesis.clone()],
        );
        let newer = graph_only_commit("delta-device-newer", "delta-device", 2, vec![genesis]);
        commit_ingest_apply::insert_commit(&conn, &older).unwrap();
        commit_ingest_apply::insert_commit(&conn, &newer).unwrap();

        lifecycle_apply::apply_delta_device_heads(
            &conn,
            &[DeviceHeadRow {
                device_id: "delta-device".to_string(),
                head_commit_id: "delta-device-older".to_string(),
                last_seen_at: "2026-05-22T02:00:00Z".to_string(),
                revoked: true,
            }],
        )
        .unwrap();
        lifecycle_apply::apply_delta_device_heads(
            &conn,
            &[DeviceHeadRow {
                device_id: "delta-device".to_string(),
                head_commit_id: "delta-device-newer".to_string(),
                last_seen_at: "2026-05-22T01:00:00Z".to_string(),
                revoked: false,
            }],
        )
        .unwrap();

        let stored: (String, String, bool) = conn
            .inner()
            .query_row(
                "SELECT head_commit_id, last_seen_at, revoked FROM device_heads
                 WHERE device_id = 'delta-device'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i32>(2)? != 0)),
            )
            .unwrap();
        assert_eq!(stored.0, "delta-device-newer");
        assert_eq!(stored.1, "2026-05-22T02:00:00Z");
        assert!(stored.2);
    }

    #[test]
    fn sync_delta_device_head_rejects_commit_from_another_device() {
        let (conn, _) = setup();
        let genesis = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let commit = graph_only_commit("actual-device-commit", "actual-device", 1, vec![genesis]);
        commit_ingest_apply::insert_commit(&conn, &commit).unwrap();

        let error = lifecycle_apply::apply_delta_device_heads(
            &conn,
            &[DeviceHeadRow {
                device_id: "claimed-device".to_string(),
                head_commit_id: "actual-device-commit".to_string(),
                last_seen_at: "2026-05-22T01:00:00Z".to_string(),
                revoked: false,
            }],
        )
        .unwrap_err();
        assert!(error.to_string().contains("authored by actual-device"));
        let stored: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM device_heads WHERE device_id = 'claimed-device'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, 0);
    }

    #[test]
    fn sync_delta_device_head_rejects_wrong_existing_commit_device() {
        let (conn, _) = setup();
        let genesis = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let wrong = graph_only_commit(
            "wrong-existing-head",
            "wrong-device",
            1,
            vec![genesis.clone()],
        );
        let incoming = graph_only_commit("claimed-device-head", "claimed-device", 1, vec![genesis]);
        commit_ingest_apply::insert_commit(&conn, &wrong).unwrap();
        commit_ingest_apply::insert_commit(&conn, &incoming).unwrap();
        conn.inner()
            .execute(
                "INSERT INTO device_heads (device_id, head_commit_id, last_seen_at, revoked)
                 VALUES ('claimed-device', 'wrong-existing-head',
                         '2026-05-22T00:00:00Z', 1)",
                [],
            )
            .unwrap();

        let error = lifecycle_apply::apply_delta_device_heads(
            &conn,
            &[DeviceHeadRow {
                device_id: "claimed-device".to_string(),
                head_commit_id: "claimed-device-head".to_string(),
                last_seen_at: "2026-05-22T01:00:00Z".to_string(),
                revoked: false,
            }],
        )
        .unwrap_err();
        assert!(error.to_string().contains("authored by wrong-device"));
        let stored: (String, bool) = conn
            .inner()
            .query_row(
                "SELECT head_commit_id, revoked FROM device_heads
                 WHERE device_id = 'claimed-device'",
                [],
                |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
            )
            .unwrap();
        assert_eq!(stored.0, "wrong-existing-head");
        assert!(stored.1);
    }

    #[test]
    fn receiving_tombstone_records_local_and_deleting_device_acknowledgements() {
        let (conn, ctx) = setup();
        let serialized = make_commit(
            "remote-delete",
            "remote-device",
            1,
            Vec::new(),
            vec!["project-1".to_string()],
            "project-1",
            "project",
        );

        commit_ingest_apply::insert_commit(&conn, &serialized).unwrap();
        commit_ingest_apply::acknowledge_received_tombstones(&conn, &ctx, &serialized).unwrap();

        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT device_id, observed_commit_id FROM tombstone_acknowledgements
                 WHERE tombstone_id = 't-remote-delete' ORDER BY device_id",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![
                ("device-a".to_string(), "remote-delete".to_string()),
                ("remote-device".to_string(), "remote-delete".to_string()),
            ]
        );
    }

    #[test]
    fn synced_acknowledgement_rejects_commit_before_delete() {
        let (conn, _) = setup();
        let graph = insert_acknowledgement_graph(&conn);
        write_acknowledgement(&conn, graph.descendant, "2026-05-22T02:00:00Z");

        let error = lifecycle_apply::apply_tombstone_acknowledgements(
            &conn,
            &[TombstoneAcknowledgementRow {
                tombstone_id: "ack-tombstone".to_string(),
                device_id: "ack-device".to_string(),
                observed_commit_id: graph.before_delete.to_string(),
                acknowledged_at: "2026-05-22T03:00:00Z".to_string(),
            }],
        )
        .unwrap_err();
        assert!(matches!(&error, StorageError::Validation(_)));
        assert!(error.to_string().contains("does not causally contain"));
        assert_eq!(
            read_acknowledgement(&conn),
            (
                graph.descendant.to_string(),
                "2026-05-22T02:00:00Z".to_string()
            )
        );
    }

    #[test]
    fn synced_acknowledgement_does_not_regress_to_ancestor() {
        let (conn, _) = setup();
        let graph = insert_acknowledgement_graph(&conn);
        write_acknowledgement(&conn, graph.descendant, "2026-05-22T02:00:00Z");

        lifecycle_apply::apply_tombstone_acknowledgements(
            &conn,
            &[TombstoneAcknowledgementRow {
                tombstone_id: "ack-tombstone".to_string(),
                device_id: "ack-device".to_string(),
                observed_commit_id: graph.delete.to_string(),
                acknowledged_at: "2026-05-22T03:00:00Z".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(
            read_acknowledgement(&conn),
            (
                graph.descendant.to_string(),
                "2026-05-22T03:00:00Z".to_string()
            )
        );
    }

    #[test]
    fn synced_acknowledgement_advances_without_regressing_time() {
        let (conn, _) = setup();
        let graph = insert_acknowledgement_graph(&conn);
        write_acknowledgement(&conn, graph.delete, "2026-05-22T03:00:00Z");

        lifecycle_apply::apply_tombstone_acknowledgements(
            &conn,
            &[TombstoneAcknowledgementRow {
                tombstone_id: "ack-tombstone".to_string(),
                device_id: "ack-device".to_string(),
                observed_commit_id: graph.descendant.to_string(),
                acknowledged_at: "2026-05-22T02:00:00Z".to_string(),
            }],
        )
        .unwrap();

        assert_eq!(
            read_acknowledgement(&conn),
            (
                graph.descendant.to_string(),
                "2026-05-22T03:00:00Z".to_string()
            )
        );
    }

    #[test]
    fn synced_concurrent_acknowledgements_converge_independent_of_arrival_order() {
        let (conn, _) = setup();
        let graph = insert_acknowledgement_graph(&conn);
        let left = TombstoneAcknowledgementRow {
            tombstone_id: "ack-tombstone".to_string(),
            device_id: "ack-device".to_string(),
            observed_commit_id: graph.concurrent_left.to_string(),
            acknowledged_at: "2026-05-22T01:00:00Z".to_string(),
        };
        let right = TombstoneAcknowledgementRow {
            tombstone_id: "ack-tombstone".to_string(),
            device_id: "ack-device".to_string(),
            observed_commit_id: graph.concurrent_right.to_string(),
            acknowledged_at: "2026-05-22T02:00:00Z".to_string(),
        };

        write_acknowledgement(&conn, &left.observed_commit_id, &left.acknowledged_at);
        lifecycle_apply::apply_tombstone_acknowledgements(&conn, &[right.clone()]).unwrap();
        let left_then_right = read_acknowledgement(&conn);

        conn.inner()
            .execute(
                "DELETE FROM tombstone_acknowledgements
                 WHERE tombstone_id = 'ack-tombstone' AND device_id = 'ack-device'",
                [],
            )
            .unwrap();
        write_acknowledgement(&conn, &right.observed_commit_id, &right.acknowledged_at);
        lifecycle_apply::apply_tombstone_acknowledgements(&conn, &[left]).unwrap();
        let right_then_left = read_acknowledgement(&conn);

        assert_eq!(left_then_right, right_then_left);
        assert_eq!(
            left_then_right,
            (
                graph.concurrent_right.to_string(),
                "2026-05-22T02:00:00Z".to_string()
            )
        );
    }

    #[test]
    fn synced_acknowledgement_keeps_missing_reference_compatibility() {
        let (conn, _) = setup();
        lifecycle_apply::apply_tombstone_acknowledgements(
            &conn,
            &[TombstoneAcknowledgementRow {
                tombstone_id: "missing-tombstone".to_string(),
                device_id: "ack-device".to_string(),
                observed_commit_id: "missing-commit".to_string(),
                acknowledged_at: "2026-05-22T00:00:00Z".to_string(),
            }],
        )
        .unwrap();
        let count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM tombstone_acknowledgements",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    fn temp_vault_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mdbx-sync-{}-{}.mdbx", label, Uuid::new_v4()))
    }

    fn remove_vault_files(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut candidate = path.as_os_str().to_os_string();
            candidate.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(candidate));
        }
    }

    fn rotation_device(device_id: &str) -> DeviceContext {
        DeviceContext {
            device_id: Some(device_id.to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: true,
            screen_capture_protection_available: true,
            secure_temp_files_available: true,
        }
    }

    fn rotate_epoch_for_sync(
        conn: &mut VaultConnection,
        ctx: &CommitContext,
        device_id: &str,
    ) -> KeyEpochRotationResult {
        let session = conn.active_session().cloned().unwrap();
        let device = rotation_device(device_id);
        KeyEpochService::rotate_authorized(
            conn,
            ctx,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: session.assurance.authenticated_at_unix_secs + 1,
            },
        )
        .unwrap()
    }

    fn create_key_epoch_sync_pair(label: &str) -> (PathBuf, PathBuf, String) {
        let source_path = temp_vault_path(&format!("{label}-source"));
        let target_path = temp_vault_path(&format!("{label}-target"));
        let base_project_id;
        {
            let mut source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some(format!("{label}-vault")),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            UnlockService::setup_password(&mut source, "epoch sync password").unwrap();
            let base = ProjectRepo::create(
                &source,
                &CommitContext::new("device-a".to_string()),
                "Base",
                None,
                None,
            )
            .unwrap();
            base_project_id = base.project_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        (source_path, target_path, base_project_id)
    }

    fn checkpoint(conn: &VaultConnection) {
        conn.inner()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .unwrap();
    }

    fn serialized_commits_from(conn: &VaultConnection) -> Vec<SerializedCommit> {
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT commit_id, device_id, local_seq, commit_kind, change_scope,
                        changed_object_ids_ct, vector_clock, message_ct, created_at, integrity_tag
                 FROM commits
                 ORDER BY created_at ASC, device_id ASC, local_seq ASC",
            )
            .unwrap();

        let rows = stmt
            .query_map([], |row| {
                let commit_id: String = row.get(0)?;
                Ok(SerializedCommit {
                    parent_ids: SyncApplyRepo::parent_ids_for_commit(conn, &commit_id).unwrap(),
                    tombstones: vec![],
                    object_payloads: vec![],
                    operation: operation_for_commit(conn, &commit_id).unwrap(),
                    commit: Commit {
                        commit_id,
                        device_id: row.get(1)?,
                        local_seq: row.get::<_, i64>(2)? as u64,
                        commit_kind: parse_commit_kind_for_test(&row.get::<_, String>(3)?),
                        change_scope: parse_change_scope_for_test(&row.get::<_, String>(4)?),
                        changed_object_ids_ct: row.get(5)?,
                        vector_clock: row.get(6)?,
                        message_ct: row.get(7)?,
                        created_at: row.get(8)?,
                        integrity_tag: row.get(9)?,
                    },
                })
            })
            .unwrap();

        rows.map(|row| row.unwrap()).collect()
    }

    fn parse_commit_kind_for_test(value: &str) -> CommitKind {
        value.parse().unwrap()
    }

    fn parse_change_scope_for_test(value: &str) -> ChangeScope {
        value.parse().unwrap()
    }

    fn operation_for_commit(
        conn: &VaultConnection,
        commit_id: &str,
    ) -> rusqlite::Result<Option<CommitOperationMetadata>> {
        conn.inner()
            .query_row(
                "SELECT operation_id, operation_kind, branch_id, branch_name,
                        change_summary_ct, request_hash, integrity_tag
                 FROM commit_operations WHERE commit_id = ?1",
                params![commit_id],
                |row| {
                    Ok(CommitOperationMetadata {
                        operation_id: row.get(0)?,
                        operation_kind: row.get(1)?,
                        branch_id: row.get(2)?,
                        branch_name: row.get(3)?,
                        change_summary_ct: row.get(4)?,
                        request_hash: row.get(5)?,
                        integrity_tag: row.get(6)?,
                    })
                },
            )
            .optional()
    }

    fn update_entry_payload(
        conn: &VaultConnection,
        ctx: &CommitContext,
        entry_id: &str,
        payload: serde_json::Value,
    ) -> mdbx_core::model::Entry {
        let mut entry = EntryRepo::get_by_id(conn, entry_id).unwrap().unwrap();
        entry.payload_ct = serde_json::to_vec(&payload).unwrap();
        EntryRepo::update(conn, ctx, &entry).unwrap()
    }

    fn update_project_for_test(
        conn: &VaultConnection,
        ctx: &CommitContext,
        project_id: &str,
        mutate: impl FnOnce(&mut mdbx_core::model::Project),
    ) -> mdbx_core::model::Project {
        let mut project = ProjectRepo::get_by_id(conn, project_id).unwrap().unwrap();
        mutate(&mut project);
        ProjectRepo::update(conn, ctx, &project).unwrap()
    }

    fn attach_state_payload_to_commit(
        conn: &VaultConnection,
        commits: &mut [SerializedCommit],
        commit_id: &str,
    ) {
        let payload = collect_sync_state_payload(conn).unwrap();
        commits
            .iter_mut()
            .find(|commit| commit.commit.commit_id == commit_id)
            .unwrap()
            .object_payloads
            .push(payload);
    }

    fn latest_delta_envelope_for_test(conn: &VaultConnection) -> SyncDeltaEnvelope {
        let batch_id: String = conn
            .inner()
            .query_row(
                "SELECT batch_id FROM sync_delta_batches ORDER BY batch_seq DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        load_sync_delta_envelope(conn, &batch_id, SyncDeltaLimits::default())
            .unwrap()
            .unwrap()
    }

    fn delta_envelope_for_commit_test(
        conn: &VaultConnection,
        commit_id: &str,
    ) -> SyncDeltaEnvelope {
        let batch_id: String = conn
            .inner()
            .query_row(
                "SELECT b.batch_id
                 FROM sync_delta_batches b
                 JOIN sync_delta_batch_commits bc ON bc.batch_id = b.batch_id
                 WHERE bc.commit_id = ?1
                 ORDER BY b.batch_seq DESC LIMIT 1",
                [commit_id],
                |row| row.get(0),
            )
            .unwrap();
        load_sync_delta_envelope(conn, &batch_id, SyncDeltaLimits::default())
            .unwrap()
            .unwrap()
    }

    fn attach_delta_payload_to_commits(
        conn: &VaultConnection,
        commits: &mut [SerializedCommit],
        envelope: &SyncDeltaEnvelope,
    ) {
        let commit_id = envelope.commit_ids.last().unwrap();
        let payload = sync_delta_object_payload(envelope, SyncDeltaLimits::default()).unwrap();
        commits
            .iter_mut()
            .find(|commit| &commit.commit.commit_id == commit_id)
            .unwrap()
            .object_payloads
            .push(payload);
        envelope.verify(conn, SyncDeltaLimits::default()).unwrap();
    }

    fn rebuild_delta_envelope(
        conn: &VaultConnection,
        template: &SyncDeltaEnvelope,
        batch_id: &str,
        batch_kind: SyncDeltaBatchKind,
        commit_ids: Vec<String>,
        body: &SyncDeltaBody,
    ) -> SyncDeltaEnvelope {
        let logical_row_count = body
            .state
            .total_rows()
            .unwrap()
            .checked_add(body.device_heads.len())
            .and_then(|count| count.checked_add(body.deletions.len()))
            .unwrap();
        SyncDeltaEnvelope::new(
            conn,
            NewSyncDeltaEnvelope {
                batch_id: batch_id.to_string(),
                batch_kind,
                commit_ids,
                logical_row_count: u32::try_from(logical_row_count).unwrap(),
                payload: serde_json::to_vec(body).unwrap(),
                created_at: template.created_at.clone(),
            },
            SyncDeltaLimits::default(),
        )
        .unwrap()
    }

    fn attach_tombstones_to_commit(
        conn: &VaultConnection,
        commits: &mut [SerializedCommit],
        commit_id: &str,
    ) {
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT tombstone_id, target_object_type, target_object_id,
                        delete_clock, deleted_by_device_id, deleted_at
                 FROM tombstones",
            )
            .unwrap();
        let tombstones = stmt
            .query_map([], |row| {
                Ok(TombstoneRecord {
                    tombstone_id: row.get(0)?,
                    target_object_type: row.get(1)?,
                    target_object_id: row.get(2)?,
                    delete_clock: row.get(3)?,
                    deleted_by_device_id: row.get(4)?,
                    deleted_at: row.get(5)?,
                })
            })
            .unwrap()
            .map(|row| row.unwrap())
            .collect::<Vec<_>>();

        commits
            .iter_mut()
            .find(|commit| commit.commit.commit_id == commit_id)
            .unwrap()
            .tombstones
            .extend(tombstones);
    }

    fn entry_payload_json(conn: &VaultConnection, entry_id: &str) -> serde_json::Value {
        let entry = EntryRepo::get_by_id(conn, entry_id).unwrap().unwrap();
        serde_json::from_slice(&entry.payload_ct).unwrap()
    }

    fn entry_tombstone_count(conn: &VaultConnection, entry_id: &str) -> i64 {
        conn.inner()
            .query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE target_object_type = 'entry' AND target_object_id = ?1",
                params![entry_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn sync_delta_apply_fast_forward_converges_and_persists_received_batch() {
        let source_path = temp_vault_path("delta-apply-ff-source");
        let target_path = temp_vault_path("delta-apply-ff-target");
        let project_id;
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-ff-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            project_id = ProjectRepo::create(
                &source,
                &CommitContext::new("device-a".to_string()),
                "Before",
                None,
                None,
            )
            .unwrap()
            .project_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("mail".to_string()),
        );
        let envelope = latest_delta_envelope_for_test(&source);
        let mut commits = serialized_commits_from(&source)
            .into_iter()
            .filter(|commit| {
                !SyncApplyRepo::commit_exists(&target, &commit.commit.commit_id).unwrap()
            })
            .collect::<Vec<_>>();
        attach_delta_payload_to_commits(&source, &mut commits, &envelope);

        let result = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch {
                batch_index: 0,
                commits,
                is_last: true,
            },
        )
        .unwrap();
        assert_eq!(result.applied_commits, 1);
        assert_eq!(result.conflict_count, 0);
        let applied = ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .unwrap();
        assert_eq!(applied.icon_ref.as_deref(), Some("mail"));
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_some()
        );
        let pending: i64 = target
            .inner()
            .query_row("SELECT COUNT(*) FROM sync_delta_mutations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(pending, 0);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_tamper_rolls_back_commit_state_and_batch() {
        let source_path = temp_vault_path("delta-apply-tamper-source");
        let target_path = temp_vault_path("delta-apply-tamper-target");
        let project_id;
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-tamper-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            project_id = ProjectRepo::create(
                &source,
                &CommitContext::new("device-a".to_string()),
                "Before",
                None,
                None,
            )
            .unwrap()
            .project_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let updated = update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("tampered".to_string()),
        );
        let envelope = latest_delta_envelope_for_test(&source);
        let mut commits = serialized_commits_from(&source)
            .into_iter()
            .filter(|commit| {
                !SyncApplyRepo::commit_exists(&target, &commit.commit.commit_id).unwrap()
            })
            .collect::<Vec<_>>();
        attach_delta_payload_to_commits(&source, &mut commits, &envelope);
        let payload = &mut commits[0].object_payloads[0];
        let last = payload.ciphertext.len() - 1;
        payload.ciphertext[last] ^= 1;

        let error = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch {
                batch_index: 0,
                commits,
                is_last: true,
            },
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("schema creation failed")
                || error.to_string().contains("digest mismatch")
        );
        assert!(!SyncApplyRepo::commit_exists(&target, &updated.head_commit_id).unwrap());
        assert_eq!(
            ProjectRepo::get_by_id(&target, &project_id)
                .unwrap()
                .unwrap()
                .icon_ref,
            None
        );
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_none()
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_divergence_preserves_local_merge_delta() {
        let (source_path, target_path, project_id) =
            create_project_divergence("delta-apply-divergent");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("remote-icon".to_string()),
        );
        update_project_for_test(
            &target,
            &CommitContext::new("device-b".to_string()),
            &project_id,
            |project| project.group_id = Some("local-group".to_string()),
        );
        let envelope = latest_delta_envelope_for_test(&source);
        let mut commits = serialized_commits_from(&source)
            .into_iter()
            .filter(|commit| {
                !SyncApplyRepo::commit_exists(&target, &commit.commit.commit_id).unwrap()
            })
            .collect::<Vec<_>>();
        attach_delta_payload_to_commits(&source, &mut commits, &envelope);

        let result = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch {
                batch_index: 0,
                commits,
                is_last: true,
            },
        )
        .unwrap();
        assert_eq!(result.applied_commits, 1);
        assert_eq!(result.conflict_count, 0);
        let merged = ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .unwrap();
        assert_eq!(merged.icon_ref.as_deref(), Some("remote-icon"));
        assert_eq!(merged.group_id.as_deref(), Some("local-group"));
        let merge_delta_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*)
                 FROM sync_delta_batch_commits bc
                 JOIN commits c ON c.commit_id = bc.commit_id
                 WHERE c.commit_kind = 'merge'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(merge_delta_count >= 1);
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_some()
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_auxiliary_audit_is_atomic_and_idempotent() {
        let source_path = temp_vault_path("delta-apply-aux-source");
        let target_path = temp_vault_path("delta-apply-aux-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-aux-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        source
            .with_immediate_transaction(|| {
                source.inner().execute(
                    "INSERT INTO security_audit_events
                        (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                         reason_codes_json, constraints_json)
                     VALUES ('remote-aux-audit', '2026-07-20T00:00:00Z',
                             'copy-secret', 'deny', 'vault', '', '[]', '[]')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let envelope = latest_delta_envelope_for_test(&source);
        assert_eq!(envelope.batch_kind, SyncDeltaBatchKind::Auxiliary);

        let ctx = CommitContext::new("device-b".to_string());
        assert_eq!(
            SyncApplyRepo::apply_auxiliary_delta(&target, &ctx, &envelope).unwrap(),
            0
        );
        assert_eq!(
            SyncApplyRepo::apply_auxiliary_delta(&target, &ctx, &envelope).unwrap(),
            0
        );
        let event_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
                 WHERE event_id = 'remote-aux-audit'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 1);
        let batch_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM sync_delta_batches WHERE batch_id = ?1",
                [&envelope.batch_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(batch_count, 1);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn incremental_segment_rolls_back_commits_when_auxiliary_decode_fails() {
        let source_path = temp_vault_path("incremental-atomic-source");
        let target_path = temp_vault_path("incremental-atomic-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("incremental-atomic-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let project = ProjectRepo::create(
            &source,
            &CommitContext::new("device-a".to_string()),
            "Atomic project",
            None,
            None,
        )
        .unwrap();
        let commit_envelope = latest_delta_envelope_for_test(&source);
        let mut commits = serialized_commits_from(&source)
            .into_iter()
            .filter(|commit| commit.commit.commit_id == project.head_commit_id)
            .collect::<Vec<_>>();
        attach_delta_payload_to_commits(&source, &mut commits, &commit_envelope);
        let malformed_auxiliary = crate::sync_delta::SyncDeltaEnvelope::new(
            &source,
            crate::sync_delta::NewSyncDeltaEnvelope {
                batch_id: "malformed-auxiliary".to_string(),
                batch_kind: SyncDeltaBatchKind::Auxiliary,
                commit_ids: Vec::new(),
                logical_row_count: 0,
                payload: b"not-a-sync-delta-body".to_vec(),
                created_at: "2026-07-21T00:00:00Z".to_string(),
            },
            SyncDeltaLimits::default(),
        )
        .unwrap();

        let mut target = VaultConnection::open(&target_path).unwrap();
        let error = SyncApplyRepo::apply_incremental_batch_mut(
            &mut target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch::new(commits, 0, true),
            &[malformed_auxiliary],
        )
        .unwrap_err();
        assert!(error.to_string().contains("schema creation failed"));
        assert!(!SyncApplyRepo::commit_exists(&target, &project.head_commit_id).unwrap());
        assert!(ProjectRepo::get_by_id(&target, &project.project_id)
            .unwrap()
            .is_none());
        assert!(load_sync_delta_envelope(
            &target,
            &commit_envelope.batch_id,
            SyncDeltaLimits::default()
        )
        .unwrap()
        .is_none());

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_auxiliary_metadata_deletion_converges() {
        let source_path = temp_vault_path("delta-apply-delete-source");
        let target_path = temp_vault_path("delta-apply-delete-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-delete-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            source
                .with_immediate_transaction(|| {
                    source.inner().execute(
                        "INSERT INTO tiga_policy_overrides
                            (scope_type, scope_id, policy_json, updated_at,
                             updated_by_device_id)
                         VALUES ('vault', '', '{}', '2026-07-20T00:00:00Z', 'device-a')",
                        [],
                    )?;
                    Ok(())
                })
                .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        source
            .with_immediate_transaction(|| {
                source.inner().execute(
                    "DELETE FROM tiga_policy_overrides
                     WHERE scope_type = 'vault' AND scope_id = ''",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let envelope = latest_delta_envelope_for_test(&source);

        SyncApplyRepo::apply_auxiliary_delta(
            &target,
            &CommitContext::new("device-b".to_string()),
            &envelope,
        )
        .unwrap();
        let remaining: i64 = target
            .inner()
            .query_row("SELECT COUNT(*) FROM tiga_policy_overrides", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_late_payload_repairs_an_existing_commit() {
        let source_path = temp_vault_path("delta-apply-late-source");
        let target_path = temp_vault_path("delta-apply-late-target");
        let project_id;
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-late-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            project_id = ProjectRepo::create(
                &source,
                &CommitContext::new("device-a".to_string()),
                "Before",
                None,
                None,
            )
            .unwrap()
            .project_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("late".to_string()),
        );
        let envelope = latest_delta_envelope_for_test(&source);
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == *envelope.commit_ids.last().unwrap())
            .unwrap();
        let commit_without_delta = commit.clone();
        let ctx = CommitContext::new("device-b".to_string());
        SyncApplyRepo::apply_batch(
            &target,
            &ctx,
            &CommitBatch {
                batch_index: 0,
                commits: vec![commit_without_delta],
                is_last: true,
            },
        )
        .unwrap();
        assert_eq!(
            ProjectRepo::get_by_id(&target, &project_id)
                .unwrap()
                .unwrap()
                .icon_ref,
            None
        );

        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());
        let result = SyncApplyRepo::apply_batch(
            &target,
            &ctx,
            &CommitBatch {
                batch_index: 1,
                commits: vec![commit],
                is_last: true,
            },
        )
        .unwrap();
        assert_eq!(result.skipped_commits, 1);
        assert_eq!(
            ProjectRepo::get_by_id(&target, &project_id)
                .unwrap()
                .unwrap()
                .icon_ref
                .as_deref(),
            Some("late")
        );
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_some()
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_replaces_attachment_chunks_atomically() {
        let (source_path, target_path, attachment_id) =
            create_attachment_divergence("delta-apply-attachment");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        AttachmentRepo::write_inline_content(
            &source,
            &CommitContext::new("device-a".to_string()),
            &attachment_id,
            b"delta replacement content",
        )
        .unwrap();
        let envelope = latest_delta_envelope_for_test(&source);
        let mut commits = serialized_commits_from(&source)
            .into_iter()
            .filter(|commit| {
                !SyncApplyRepo::commit_exists(&target, &commit.commit.commit_id).unwrap()
            })
            .collect::<Vec<_>>();
        attach_delta_payload_to_commits(&source, &mut commits, &envelope);

        SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch {
                batch_index: 0,
                commits,
                is_last: true,
            },
        )
        .unwrap();
        assert_eq!(
            AttachmentRepo::read_content(&target, &attachment_id).unwrap(),
            b"delta replacement content"
        );
        let chunk_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM attachment_chunks WHERE attachment_id = ?1",
                [&attachment_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(chunk_count, 1);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_delta_apply_mutable_refreshes_rotated_key_epoch() {
        let (source_path, target_path, _) = create_key_epoch_sync_pair("delta-apply-key-epoch");
        let mut source = VaultConnection::open(&source_path).unwrap();
        let mut target = VaultConnection::open(&target_path).unwrap();
        UnlockService::unlock_with_password(&mut source, "epoch sync password").unwrap();
        UnlockService::unlock_with_password(&mut target, "epoch sync password").unwrap();
        let rotation = rotate_epoch_for_sync(
            &mut source,
            &CommitContext::new("device-a".to_string()),
            "device-a",
        );
        let envelope = delta_envelope_for_commit_test(&source, &rotation.commit_id);
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == rotation.commit_id)
            .unwrap();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());

        SyncApplyRepo::apply_batch_mut(
            &mut target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch::new(vec![commit], 0, true),
        )
        .unwrap();
        assert_eq!(
            target.active_key_epoch_id(),
            Some(rotation.active_epoch_id.as_str())
        );
        assert!(target
            .keyring_for_epoch(&rotation.previous_epoch_id)
            .is_some());
        assert!(target
            .keyring_for_epoch(&rotation.active_epoch_id)
            .is_some());

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_immutable_rejects_key_epoch_changes_atomically() {
        let (source_path, target_path, _) =
            create_key_epoch_sync_pair("delta-apply-key-epoch-immutable");
        let mut source = VaultConnection::open(&source_path).unwrap();
        let mut target = VaultConnection::open(&target_path).unwrap();
        UnlockService::unlock_with_password(&mut source, "epoch sync password").unwrap();
        UnlockService::unlock_with_password(&mut target, "epoch sync password").unwrap();
        let original_epoch_id = target.active_key_epoch_id().unwrap().to_string();
        let rotation = rotate_epoch_for_sync(
            &mut source,
            &CommitContext::new("device-a".to_string()),
            "device-a",
        );
        let envelope = delta_envelope_for_commit_test(&source, &rotation.commit_id);
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == rotation.commit_id)
            .unwrap();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());

        let error = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch::new(vec![commit], 0, true),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("key epoch changes require mutable sync apply"));
        assert_eq!(
            target.active_key_epoch_id(),
            Some(original_epoch_id.as_str())
        );
        assert!(!SyncApplyRepo::commit_exists(&target, &rotation.commit_id).unwrap());
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_none()
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_rejects_missing_commit_association_atomically() {
        let (source_path, target_path, project_id) =
            create_project_divergence("delta-apply-missing-association");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let updated = update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("must-rollback".to_string()),
        );
        let template = latest_delta_envelope_for_test(&source);
        let body = decode_sync_delta_body(&template, SyncDeltaLimits::default()).unwrap();
        let envelope = rebuild_delta_envelope(
            &source,
            &template,
            "delta-missing-associated-commit",
            SyncDeltaBatchKind::Commit,
            vec![
                "missing-associated-commit".to_string(),
                updated.head_commit_id.clone(),
            ],
            &body,
        );
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == updated.head_commit_id)
            .unwrap();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());

        let error = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch::new(vec![commit], 0, true),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("references unavailable commit missing-associated-commit"));
        assert!(!SyncApplyRepo::commit_exists(&target, &updated.head_commit_id).unwrap());
        assert_eq!(
            ProjectRepo::get_by_id(&target, &project_id)
                .unwrap()
                .unwrap()
                .icon_ref,
            None
        );
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_none()
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_rejects_row_count_mismatch_atomically() {
        let (source_path, target_path, project_id) =
            create_project_divergence("delta-apply-row-mismatch");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let updated = update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("invalid-row-count".to_string()),
        );
        let mut envelope = latest_delta_envelope_for_test(&source);
        envelope.logical_row_count += 1;
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == updated.head_commit_id)
            .unwrap();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());

        let error = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch::new(vec![commit], 0, true),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("sync delta logical row count mismatch"));
        assert!(!SyncApplyRepo::commit_exists(&target, &updated.head_commit_id).unwrap());
        assert_eq!(
            ProjectRepo::get_by_id(&target, &project_id)
                .unwrap()
                .unwrap()
                .icon_ref,
            None
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_rejects_foreign_vault_atomically() {
        let (source_path, target_path, project_id) =
            create_project_divergence("delta-apply-foreign-vault");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let updated = update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("foreign".to_string()),
        );
        let envelope = latest_delta_envelope_for_test(&source);
        target
            .inner()
            .execute("UPDATE vault_meta SET vault_id = 'different-vault-id'", [])
            .unwrap();
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == updated.head_commit_id)
            .unwrap();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());

        let error = SyncApplyRepo::apply_batch(
            &target,
            &CommitContext::new("device-b".to_string()),
            &CommitBatch::new(vec![commit], 0, true),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("sync delta belongs to a different vault"));
        assert!(!SyncApplyRepo::commit_exists(&target, &updated.head_commit_id).unwrap());
        assert_eq!(
            ProjectRepo::get_by_id(&target, &project_id)
                .unwrap()
                .unwrap()
                .icon_ref,
            None
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_auxiliary_limit_rejects_before_writing() {
        let source_path = temp_vault_path("delta-apply-limit-source");
        let target_path = temp_vault_path("delta-apply-limit-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-limit-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        source
            .with_immediate_transaction(|| {
                for event_id in ["limited-incoming-a", "limited-incoming-b"] {
                    source.inner().execute(
                        "INSERT INTO security_audit_events
                            (event_id, occurred_at, operation, outcome, scope_type, scope_id,
                             reason_codes_json, constraints_json)
                         VALUES (?1, '2026-07-20T00:00:00Z', 'copy-secret', 'deny',
                                 'vault', '', '[]', '[]')",
                        [event_id],
                    )?;
                }
                Ok(())
            })
            .unwrap();
        let envelope = latest_delta_envelope_for_test(&source);
        let defaults = SyncDeltaLimits::default();
        let limits =
            SyncDeltaLimits::new(defaults.max_payload_bytes(), 1, defaults.max_commits()).unwrap();

        let error = SyncApplyRepo::apply_auxiliary_delta_with_limits(
            &target,
            &CommitContext::new("device-b".to_string()),
            &envelope,
            limits,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            StorageError::ResourceLimit { resource, .. } if resource == "sync delta rows"
        ));
        let event_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM security_audit_events
                 WHERE event_id IN ('limited-incoming-a', 'limited-incoming-b')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(event_count, 0);
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_none()
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_rejects_reused_batch_id_with_different_content() {
        let (source_path, target_path, project_id) =
            create_project_divergence("delta-apply-batch-id-conflict");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let updated = update_project_for_test(
            &source,
            &CommitContext::new("device-a".to_string()),
            &project_id,
            |project| project.icon_ref = Some("accepted".to_string()),
        );
        let envelope = latest_delta_envelope_for_test(&source);
        let mut commit = serialized_commits_from(&source)
            .into_iter()
            .find(|commit| commit.commit.commit_id == updated.head_commit_id)
            .unwrap();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&envelope, SyncDeltaLimits::default()).unwrap());
        let ctx = CommitContext::new("device-b".to_string());
        SyncApplyRepo::apply_batch(
            &target,
            &ctx,
            &CommitBatch::new(vec![commit.clone()], 0, true),
        )
        .unwrap();

        let mut conflicting = envelope.clone();
        conflicting.created_at = "2026-07-20T23:59:59Z".to_string();
        commit.object_payloads.clear();
        commit
            .object_payloads
            .push(sync_delta_object_payload(&conflicting, SyncDeltaLimits::default()).unwrap());
        let error =
            SyncApplyRepo::apply_batch(&target, &ctx, &CommitBatch::new(vec![commit], 1, true))
                .unwrap_err();
        assert!(error.to_string().contains("conflicts with stored content"));
        let stored =
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .unwrap();
        assert_eq!(stored, envelope);

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_sparse_tombstones_preserve_unrelated_local_rows() {
        let source_path = temp_vault_path("delta-apply-sparse-tombstone-source");
        let target_path = temp_vault_path("delta-apply-sparse-tombstone-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-sparse-tombstone-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        source
            .with_immediate_transaction(|| {
                source.inner().execute(
                    "INSERT INTO tombstones
                        (tombstone_id, target_object_type, target_object_id, delete_clock,
                         deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id)
                     VALUES ('remote-tombstone', 'entry', 'remote-entry', '{}',
                             'device-a', '2026-07-20T01:00:00Z', NULL, NULL)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        target
            .with_immediate_transaction(|| {
                target.inner().execute(
                    "INSERT INTO tombstones
                        (tombstone_id, target_object_type, target_object_id, delete_clock,
                         deleted_by_device_id, deleted_at, purge_eligible_at, delete_commit_id)
                     VALUES ('local-tombstone', 'entry', 'local-entry', '{}',
                             'device-b', '2026-07-20T00:00:00Z', NULL, NULL)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let envelope = latest_delta_envelope_for_test(&source);

        SyncApplyRepo::apply_auxiliary_delta(
            &target,
            &CommitContext::new("device-b".to_string()),
            &envelope,
        )
        .unwrap();
        let tombstone_ids = TombstoneRepo::list_all(&target)
            .unwrap()
            .into_iter()
            .map(|row| row.tombstone_id)
            .collect::<HashSet<_>>();
        assert!(tombstone_ids.contains("local-tombstone"));
        assert!(tombstone_ids.contains("remote-tombstone"));

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_device_revocation_is_monotonic() {
        let source_path = temp_vault_path("delta-apply-device-head-source");
        let target_path = temp_vault_path("delta-apply-device-head-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("delta-apply-device-head-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        source
            .with_immediate_transaction(|| {
                source.inner().execute(
                    "UPDATE device_heads SET last_seen_at = '2026-07-20T02:00:00Z', revoked = 0
                     WHERE device_id = 'device-a'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        target
            .with_immediate_transaction(|| {
                target.inner().execute(
                    "UPDATE device_heads SET last_seen_at = '2026-07-20T01:00:00Z', revoked = 1
                     WHERE device_id = 'device-a'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let envelope = latest_delta_envelope_for_test(&source);

        SyncApplyRepo::apply_auxiliary_delta(
            &target,
            &CommitContext::new("device-b".to_string()),
            &envelope,
        )
        .unwrap();
        let stored: (String, bool) = target
            .inner()
            .query_row(
                "SELECT last_seen_at, revoked FROM device_heads WHERE device_id = 'device-a'",
                [],
                |row| Ok((row.get(0)?, row.get::<_, i32>(1)? != 0)),
            )
            .unwrap();
        assert_eq!(stored.0, "2026-07-20T02:00:00Z");
        assert!(stored.1);

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_delta_apply_rejects_physical_deletion_without_purge_receipt() {
        let (source_path, target_path, project_id) =
            create_project_divergence("delta-apply-unauthorized-delete");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let template = latest_delta_envelope_for_test(&source);
        let mut body = decode_sync_delta_body(&template, SyncDeltaLimits::default()).unwrap();
        body.deletions.push(DeletedSyncEntity {
            entity_kind: "project".to_string(),
            entity_id: project_id.clone(),
        });
        let envelope = rebuild_delta_envelope(
            &source,
            &template,
            "delta-unauthorized-physical-delete",
            SyncDeltaBatchKind::Auxiliary,
            vec![],
            &body,
        );

        let error = SyncApplyRepo::apply_auxiliary_delta(
            &target,
            &CommitContext::new("device-b".to_string()),
            &envelope,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("physical project deletion lacks a matching purge receipt"));
        assert!(ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .is_some());
        assert!(
            load_sync_delta_envelope(&target, &envelope.batch_id, SyncDeltaLimits::default())
                .unwrap()
                .is_none()
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    fn create_project_divergence(label: &str) -> (PathBuf, PathBuf, String) {
        let source_path = temp_vault_path(&format!("{}-source", label));
        let target_path = temp_vault_path(&format!("{}-target", label));
        let project_id;

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some(format!("{}-vault", label)),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let project =
                ProjectRepo::create(&source, &source_ctx, "P", Some("base"), None).unwrap();
            project_id = project.project_id.clone();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        (source_path, target_path, project_id)
    }

    fn create_attachment_divergence(label: &str) -> (PathBuf, PathBuf, String) {
        let source_path = temp_vault_path(&format!("{}-source", label));
        let target_path = temp_vault_path(&format!("{}-target", label));
        let attachment_id;

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some(format!("{}-vault", label)),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &source_ctx, "P", None, None).unwrap();
            let attachment = AttachmentRepo::add(
                &source,
                &source_ctx,
                &project.project_id,
                None,
                "base.txt",
                Some("text/plain"),
                "",
                0,
            )
            .unwrap();
            AttachmentRepo::write_inline_content(
                &source,
                &source_ctx,
                &attachment.attachment_id,
                b"base content",
            )
            .unwrap();
            attachment_id = attachment.attachment_id.clone();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();
        (source_path, target_path, attachment_id)
    }

    fn create_divergent_password_conflict(label: &str) -> (PathBuf, PathBuf, String) {
        let source_path = temp_vault_path(&format!("{}-source", label));
        let target_path = temp_vault_path(&format!("{}-target", label));
        let entry_id;

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some(format!("{}-vault", label)),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &source_ctx, "P", None, None).unwrap();
            let entry = EntryRepo::create(
                &source,
                &source_ctx,
                &project.project_id,
                EntryType::Login,
                Some("Login"),
                &serde_json::json!({
                    "username": "alice",
                    "password": "old",
                    "url": "https://old.example"
                }),
            )
            .unwrap();
            entry_id = entry.entry_id.clone();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let incoming = update_entry_payload(
            &source,
            &source_ctx,
            &entry_id,
            serde_json::json!({
                "username": "alice",
                "password": "remote-secret",
                "url": "https://old.example"
            }),
        );
        let _local = update_entry_payload(
            &target,
            &target_ctx,
            &entry_id,
            serde_json::json!({
                "username": "alice",
                "password": "local-secret",
                "url": "https://old.example"
            }),
        );

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.conflict_count, 1);

        drop(source);
        drop(target);
        (source_path, target_path, entry_id)
    }

    fn create_delete_modify_conflict(
        label: &str,
        remote_deletes: bool,
    ) -> (PathBuf, PathBuf, String) {
        let source_path = temp_vault_path(&format!("{}-source", label));
        let target_path = temp_vault_path(&format!("{}-target", label));
        let entry_id;

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some(format!("{}-vault", label)),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &source_ctx, "P", None, None).unwrap();
            let entry = EntryRepo::create(
                &source,
                &source_ctx,
                &project.project_id,
                EntryType::Login,
                Some("Login"),
                &serde_json::json!({
                    "username": "alice",
                    "password": "old"
                }),
            )
            .unwrap();
            entry_id = entry.entry_id.clone();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let incoming_head = if remote_deletes {
            EntryRepo::soft_delete(&source, &source_ctx, &entry_id).unwrap();
            EntryRepo::get_by_id(&source, &entry_id)
                .unwrap()
                .unwrap()
                .head_commit_id
        } else {
            update_entry_payload(
                &source,
                &source_ctx,
                &entry_id,
                serde_json::json!({
                    "username": "alice",
                    "password": "remote-change"
                }),
            )
            .head_commit_id
        };

        if remote_deletes {
            update_entry_payload(
                &target,
                &target_ctx,
                &entry_id,
                serde_json::json!({
                    "username": "alice",
                    "password": "local-change"
                }),
            );
        } else {
            EntryRepo::soft_delete(&target, &target_ctx, &entry_id).unwrap();
        }

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming_head);
        attach_tombstones_to_commit(&source, &mut commits, &incoming_head);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.conflict_count, 1);

        drop(source);
        drop(target);
        (source_path, target_path, entry_id)
    }

    #[test]
    fn apply_fast_forward_commit() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let main_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let incoming = make_commit(
            "remote-1",
            "device-b",
            1,
            vec![main_head],
            vec![project.project_id.clone()],
            &project.project_id,
            "project",
        );
        let batch = CommitBatch::new(vec![incoming], 0, true);
        let result = SyncApplyRepo::apply_batch(&conn, &ctx, &batch).unwrap();
        assert_eq!(result.applied_commits, 1);
        assert_eq!(result.conflict_count, 0);
    }

    #[test]
    fn sync_state_resource_limit_rolls_back_commit_tombstone_and_branch_head() {
        let (conn, ctx) = setup();
        let original_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let payload = collect_sync_state_payload(&conn).unwrap();
        let payload_len = payload.ciphertext.len();
        let mut incoming = make_commit(
            "remote-over-limit",
            "device-b",
            1,
            vec![original_head.clone()],
            vec!["project-over-limit".to_string()],
            "project-over-limit",
            "project",
        );
        incoming.object_payloads = vec![payload];
        let batch = CommitBatch::new(vec![incoming], 0, true);
        let limits = SyncStateLimits::new(payload_len, 2).unwrap();

        assert!(matches!(
            SyncApplyRepo::apply_batch_with_limits(&conn, &ctx, &batch, limits),
            Err(StorageError::ResourceLimit { resource, .. })
                if resource == "sync state rows"
        ));
        let commit_exists: bool = conn
            .inner()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM commits WHERE commit_id = 'remote-over-limit')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tombstone_exists: bool = conn
            .inner()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM tombstones WHERE tombstone_id = 't-remote-over-limit')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let current_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!commit_exists);
        assert!(!tombstone_exists);
        assert_eq!(current_head, original_head);
    }

    #[test]
    fn incoming_commit_advances_the_device_sequence_floor() {
        let (conn, ctx) = setup();
        let main_head: String = conn
            .inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let incoming = make_commit(
            "remote-seq-50",
            "device-a",
            50,
            vec![main_head],
            Vec::new(),
            "unused",
            "project",
        );
        SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![incoming], 0, true))
            .unwrap();

        let operation = CommitOperation::new(
            "local-after-sync",
            "change",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        let local_seq: i64 = conn
            .inner()
            .query_row(
                "SELECT local_seq FROM commits WHERE commit_id = ?1",
                params![commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(local_seq, 51);
    }

    #[test]
    fn operation_metadata_roundtrips_through_sync() {
        let source_path = temp_vault_path("operation-source");
        let target_path = temp_vault_path("operation-target");
        let source = VaultConnection::create(&source_path).unwrap();
        initialize_vault(
            &source,
            &VaultInitParams {
                device_id: "device-a".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        checkpoint(&source);
        std::fs::copy(&source_path, &target_path).unwrap();

        let source_ctx = CommitContext::new("device-a".to_string());
        let operation = CommitOperation::new(
            "sync-operation-1",
            "batch-move",
            "main",
            "change",
            "entry",
            vec![CommitChange {
                object_type: "entry".to_string(),
                object_id: "entry-1".to_string(),
                action: "move".to_string(),
                fields: vec!["project_id".to_string()],
            }],
        );
        let commit_id = source_ctx
            .create_operation_commit(&source, &operation)
            .unwrap();
        checkpoint(&source);

        let target = VaultConnection::open(&target_path).unwrap();
        let target_ctx = CommitContext::new("device-b".to_string());
        let commits = serialized_commits_from(&source);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.applied_commits, 1);

        let stored: (String, String, Option<String>, String) = target
            .inner()
            .query_row(
                "SELECT operation_id, operation_kind, branch_id, branch_name
                 FROM commit_operations WHERE commit_id = ?1",
                params![commit_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let source_branch_id: String = source
            .inner()
            .query_row(
                "SELECT branch_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                "sync-operation-1".to_string(),
                "batch-move".to_string(),
                Some(source_branch_id),
                "main".to_string()
            )
        );

        drop(source);
        drop(target);
        for path in [&source_path, &target_path] {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(format!("{}-wal", path.display()));
            let _ = std::fs::remove_file(format!("{}-shm", path.display()));
        }
    }

    #[test]
    fn existing_commit_replay_rejects_changed_authenticated_commit_metadata() {
        let (conn, ctx) = setup();
        let operation = CommitOperation::new(
            "existing-commit-equivocation",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        let mut replay = serialized_commits_from(&conn)
            .into_iter()
            .find(|serialized| serialized.commit.commit_id == commit_id)
            .unwrap();
        replay.commit.vector_clock = r#"{"device-a":999}"#.to_string();
        resign_serialized_commit(&conn, &mut replay);

        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![replay], 0, true))
                .unwrap_err();

        assert!(error
            .to_string()
            .contains("conflicts with existing metadata"));
    }

    #[test]
    fn incoming_commit_structure_rejects_duplicate_parents() {
        let (conn, ctx) = setup();
        let original_head = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let incoming = graph_only_commit(
            "duplicate-parent-commit",
            "remote-duplicate-parent-device",
            1,
            vec![original_head.clone(), original_head.clone()],
        );

        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![incoming], 0, true))
                .unwrap_err();

        assert!(error.to_string().contains("duplicate parent"));
        assert_rejected_commit_has_no_graph_side_effects(
            &conn,
            "duplicate-parent-commit",
            "remote-duplicate-parent-device",
            &original_head,
        );
    }

    #[test]
    fn incoming_commit_structure_rejects_malformed_vector_clock() {
        let (conn, ctx) = setup();
        let original_head = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let mut incoming = graph_only_commit(
            "malformed-vector-clock-commit",
            "remote-malformed-clock-device",
            1,
            vec![original_head.clone()],
        );
        incoming.commit.vector_clock = "not-json".to_string();
        resign_serialized_commit(&conn, &mut incoming);

        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![incoming], 0, true))
                .unwrap_err();

        assert!(error.to_string().contains("invalid vector clock"));
        assert_rejected_commit_has_no_graph_side_effects(
            &conn,
            "malformed-vector-clock-commit",
            "remote-malformed-clock-device",
            &original_head,
        );
    }

    #[test]
    fn incoming_commit_structure_rejects_unrepresentable_local_sequence() {
        let (conn, ctx) = setup();
        let original_head = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let incoming = graph_only_commit(
            "oversized-local-sequence-commit",
            "remote-oversized-sequence-device",
            u64::MAX,
            vec![original_head.clone()],
        );

        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![incoming], 0, true))
                .unwrap_err();

        assert!(error.to_string().contains("does not fit SQLite INTEGER"));
        assert_rejected_commit_has_no_graph_side_effects(
            &conn,
            "oversized-local-sequence-commit",
            "remote-oversized-sequence-device",
            &original_head,
        );
    }

    #[test]
    fn incoming_commit_structure_accepts_legacy_empty_vector_clock() {
        let (conn, ctx) = setup();
        let original_head = SyncApplyRepo::current_branch_head(&conn, None, "main")
            .unwrap()
            .unwrap();
        let mut incoming = graph_only_commit(
            "legacy-empty-vector-clock-commit",
            "remote-legacy-clock-device",
            1,
            vec![original_head],
        );
        incoming.commit.vector_clock = "{}".to_string();
        resign_serialized_commit(&conn, &mut incoming);

        let result =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![incoming], 0, true))
                .unwrap();

        assert_eq!(result.applied_commits, 1);
        assert!(SyncApplyRepo::commit_exists(&conn, "legacy-empty-vector-clock-commit").unwrap());
    }

    #[test]
    fn existing_commit_replay_rejects_changed_parent_membership() {
        let (conn, ctx) = setup();
        let operation = CommitOperation::new(
            "existing-commit-parent-equivocation",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        let mut replay = serialized_commits_from(&conn)
            .into_iter()
            .find(|serialized| serialized.commit.commit_id == commit_id)
            .unwrap();
        replay.parent_ids.clear();
        resign_serialized_commit(&conn, &mut replay);

        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![replay], 0, true))
                .unwrap_err();

        assert!(error
            .to_string()
            .contains("conflicts with existing metadata"));
    }

    #[test]
    fn existing_commit_replay_rejects_conflicting_operation_metadata() {
        let (conn, ctx) = setup();
        let operation = CommitOperation::new(
            "existing-operation-equivocation",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        let replay = serialized_commits_from(&conn)
            .into_iter()
            .find(|serialized| serialized.commit.commit_id == commit_id)
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE commit_operations SET operation_kind = 'tampered-local-kind'
                 WHERE operation_id = ?1",
                params![operation.operation_id],
            )
            .unwrap();

        let error =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![replay], 0, true))
                .unwrap_err();

        assert!(error
            .to_string()
            .contains("conflicts with existing metadata"));
    }

    #[test]
    fn existing_commit_replay_restores_previously_omitted_operation_metadata() {
        let (conn, ctx) = setup();
        let operation = CommitOperation::new(
            "late-operation-metadata",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        let replay = serialized_commits_from(&conn)
            .into_iter()
            .find(|serialized| serialized.commit.commit_id == commit_id)
            .unwrap();
        let expected = replay.operation.clone();
        conn.inner()
            .execute(
                "DELETE FROM commit_operations WHERE operation_id = ?1",
                params![operation.operation_id],
            )
            .unwrap();

        let result =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![replay], 0, true))
                .unwrap();

        assert_eq!(result.skipped_commits, 1);
        assert_eq!(operation_for_commit(&conn, &commit_id).unwrap(), expected);
    }

    #[test]
    fn legacy_existing_commit_replay_may_omit_local_operation_metadata() {
        let (conn, ctx) = setup();
        let operation = CommitOperation::new(
            "legacy-replay-without-operation",
            "edit-session",
            "main",
            "change",
            "project",
            Vec::new(),
        );
        let commit_id = ctx.create_operation_commit(&conn, &operation).unwrap();
        let mut replay = serialized_commits_from(&conn)
            .into_iter()
            .find(|serialized| serialized.commit.commit_id == commit_id)
            .unwrap();
        let expected = replay.operation.take();

        let result =
            SyncApplyRepo::apply_batch(&conn, &ctx, &CommitBatch::new(vec![replay], 0, true))
                .unwrap();

        assert_eq!(result.skipped_commits, 1);
        assert_eq!(operation_for_commit(&conn, &commit_id).unwrap(), expected);
    }

    #[test]
    fn apply_divergent_commit_creates_conflict() {
        let (conn, ctx) = setup();
        let project = ProjectRepo::create(&conn, &ctx, "P", None, None).unwrap();
        let updated = ProjectRepo::update(
            &conn,
            &ctx,
            &ProjectRepo::get_by_id(&conn, &project.project_id)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let incoming = make_commit(
            "remote-2",
            "device-b",
            1,
            vec![project.head_commit_id.clone()],
            vec![project.project_id.clone()],
            &updated.project_id,
            "project",
        );
        let batch = CommitBatch::new(vec![incoming], 0, true);
        let result = SyncApplyRepo::apply_batch(&conn, &ctx, &batch).unwrap();
        assert_eq!(result.conflict_count, 1);
        assert!(!ConflictRepo::list_unresolved(&conn).unwrap().is_empty());
    }

    #[test]
    fn apply_fast_forward_state_payload_materializes_objects() {
        let source_path = temp_vault_path("source");
        let target_path = temp_vault_path("target");

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("sync-state-test-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let project =
            ProjectRepo::create(&source, &source_ctx, "Synced Project", Some("work"), None)
                .unwrap();
        let entry = EntryRepo::create(
            &source,
            &source_ctx,
            &project.project_id,
            EntryType::Login,
            Some("Synced Login"),
            &serde_json::json!({
                "username": "alice",
                "password": "synced-secret",
                "url": "https://sync.example"
            }),
        )
        .unwrap();
        let attachment = AttachmentRepo::add(
            &source,
            &source_ctx,
            &project.project_id,
            Some(&entry.entry_id),
            "proof.txt",
            Some("text/plain"),
            "",
            0,
        )
        .unwrap();
        AttachmentRepo::write_inline_content(
            &source,
            &source_ctx,
            &attachment.attachment_id,
            b"hello from source",
        )
        .unwrap();

        let mut commits = serialized_commits_from(&source);
        commits
            .last_mut()
            .unwrap()
            .object_payloads
            .push(collect_sync_state_payload(&source).unwrap());

        let batch = CommitBatch::new(commits, 0, true);
        let result = SyncApplyRepo::apply_batch(&target, &target_ctx, &batch).unwrap();

        assert!(result.applied_commits >= 4);
        assert_eq!(result.conflict_count, 0);

        let synced_project = ProjectRepo::get_by_id(&target, &project.project_id)
            .unwrap()
            .unwrap();
        assert_eq!(synced_project.title_ct, b"Synced Project");

        let synced_entry = EntryRepo::get_by_id(&target, &entry.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(synced_entry.project_id, project.project_id);
        assert_eq!(synced_entry.title_ct, Some(b"Synced Login".to_vec()));

        let synced_attachment = AttachmentRepo::get_by_id(&target, &attachment.attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            synced_attachment.entry_id.as_deref(),
            Some(entry.entry_id.as_str())
        );
        assert_eq!(
            AttachmentRepo::read_content(&target, &attachment.attachment_id).unwrap(),
            b"hello from source"
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn collection_profile_and_opaque_object_survive_sync_without_target_adapter() {
        let source_path = temp_vault_path("profile-source");
        let target_path = temp_vault_path("profile-target");

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("profile-sync-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let mut source = VaultConnection::open(&source_path).unwrap();
        source.set_extension_capabilities([
            ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
        ]);
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let project = ProjectRepo::create(&source, &source_ctx, "Mail", None, None).unwrap();
        CollectionProfileRepo::set(
            &source,
            &source_ctx,
            CollectionProfileSpec {
                collection_id: project.project_id.clone(),
                collection_type_id: CollectionTypeId::new("com.monica.mail").unwrap(),
                payload: br#"{"account":"primary"}"#.to_vec(),
                payload_schema_version: 1,
                allowed_object_type_ids: vec![
                    ObjectTypeId::custom("com.monica.mail.message").unwrap()
                ],
                required_capability_ids: vec![
                    ExtensionCapabilityId::new("com.monica.mail.store").unwrap()
                ],
            },
        )
        .unwrap();
        let entry = EntryRepo::create(
            &source,
            &source_ctx,
            &project.project_id,
            ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            Some("Message"),
            &serde_json::json!({"body":"opaque"}),
        )
        .unwrap();
        checkpoint(&source);

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &entry.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.conflict_count, 0);

        let profile = CollectionProfileRepo::get_by_collection_id(&target, &project.project_id)
            .unwrap()
            .unwrap();
        assert_eq!(profile.collection_type_id.as_str(), "com.monica.mail");
        assert_eq!(profile.payload_ct, br#"{"account":"primary"}"#);
        let synced = EntryRepo::get_by_id(&target, &entry.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(synced.entry_type.as_str(), "com.monica.mail.message");

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn purge_receipt_sync_removes_stale_object_and_blocks_old_state_revival() {
        let source_path = temp_vault_path("purge-receipt-source");
        let target_path = temp_vault_path("purge-receipt-target");
        let project_id;

        {
            let mut source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("purge-receipt-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            UnlockService::setup_password(&mut source, "purge receipt password").unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            project_id = ProjectRepo::create(&source, &source_ctx, "Purged", None, None)
                .unwrap()
                .project_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let mut source = VaultConnection::open(&source_path).unwrap();
        let mut target = VaultConnection::open(&target_path).unwrap();
        let session =
            UnlockService::unlock_with_password(&mut source, "purge receipt password").unwrap();
        UnlockService::unlock_with_password(&mut target, "purge receipt password").unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());
        let stale_state = collect_sync_state(&target).unwrap();

        ProjectRepo::soft_delete(&source, &source_ctx, &project_id).unwrap();
        let tombstone = TombstoneRepo::find_by_target(&source, &project_id)
            .unwrap()
            .unwrap();
        let device = rotation_device("device-a");
        let now = chrono::Utc::now().timestamp() + 1;
        let context = TigaAuthorizationContext {
            session: Some(&session),
            device: &device,
            now_unix_secs: now,
        };
        TombstoneRepo::schedule_purge_authorized(
            &source,
            &source_ctx,
            &tombstone.tombstone_id,
            &tombstone.deleted_at,
            context,
        )
        .unwrap();
        let (receipt, _) =
            TombstoneRepo::purge_authorized(&source, &source_ctx, &tombstone.tombstone_id, context)
                .unwrap();

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &receipt.purge_commit_id);
        SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
            .unwrap();
        assert!(ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .is_none());
        assert!(
            TombstoneRepo::find_purge_receipt_by_target(&target, "project", &project_id)
                .unwrap()
                .is_some()
        );

        project_apply::apply_projects(
            &target,
            &target_ctx,
            &receipt.purge_commit_id,
            &stale_state.projects,
        )
        .unwrap();
        assert!(ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .is_none());
        assert_eq!(
            target
                .inner()
                .query_row(
                    "SELECT COUNT(*) FROM object_versions
                     WHERE object_type = 'project' AND object_id = ?1",
                    params![project_id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn sync_state_preserves_custom_object_type_and_payload_schema_version() {
        let source_path = temp_vault_path("custom-object-source");
        let target_path = temp_vault_path("custom-object-target");

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("custom-object-sync-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());
        let project = ProjectRepo::create(&source, &source_ctx, "Mail", None, None).unwrap();
        let object = EntryRepo::create_with_payload_schema_version(
            &source,
            &source_ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Encrypted message"),
            &serde_json::json!({"subject": "sync", "body": "opaque"}),
            12,
        )
        .unwrap();

        let mut commits = serialized_commits_from(&source);
        commits
            .last_mut()
            .unwrap()
            .object_payloads
            .push(collect_sync_state_payload(&source).unwrap());
        SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
            .unwrap();

        let synced = EntryRepo::get_by_id(&target, &object.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(synced.entry_type.as_str(), "com.monica.mail.message");
        assert_eq!(synced.payload_schema_version, 12);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn sync_state_extensions_survive_apply_collect_and_omission() {
        let source_path = temp_vault_path("extension-roundtrip-source");
        let target_path = temp_vault_path("extension-roundtrip-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("extension-roundtrip-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());
        let first_project =
            ProjectRepo::create(&source, &source_ctx, "Extension source", None, None).unwrap();

        let mut extension_payload = collect_sync_state_payload(&source).unwrap();
        let mut encoded: serde_json::Value =
            serde_json::from_slice(&extension_payload.ciphertext).unwrap();
        encoded.as_object_mut().unwrap().insert(
            "com.example.future-metadata".to_string(),
            serde_json::json!({"revision": 3, "flags": ["a", "b"]}),
        );
        extension_payload.ciphertext = serde_json::to_vec(&encoded).unwrap();

        let mut first_commits = serialized_commits_from(&source);
        first_commits
            .iter_mut()
            .find(|commit| commit.commit.commit_id == first_project.head_commit_id)
            .unwrap()
            .object_payloads
            .push(extension_payload);
        SyncApplyRepo::apply_batch(
            &target,
            &target_ctx,
            &CommitBatch::new(first_commits, 0, true),
        )
        .unwrap();

        let collected = collect_sync_state(&target).unwrap();
        assert_eq!(
            collected.extensions.get("com.example.future-metadata"),
            Some(&serde_json::json!({"revision": 3, "flags": ["a", "b"]}))
        );
        let stored_source_commit: String = target
            .inner()
            .query_row(
                "SELECT source_commit_id FROM sync_state_extensions
                 WHERE extension_key = 'com.example.future-metadata'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored_source_commit, first_project.head_commit_id);

        let second_project =
            ProjectRepo::create(&source, &source_ctx, "Extension update", None, None).unwrap();
        let mut updated_extension_payload = collect_sync_state_payload(&source).unwrap();
        let mut encoded: serde_json::Value =
            serde_json::from_slice(&updated_extension_payload.ciphertext).unwrap();
        encoded.as_object_mut().unwrap().insert(
            "com.example.future-metadata".to_string(),
            serde_json::json!({"revision": 4, "flags": ["c"]}),
        );
        updated_extension_payload.ciphertext = serde_json::to_vec(&encoded).unwrap();
        let mut second_commits = serialized_commits_from(&source);
        second_commits
            .iter_mut()
            .find(|commit| commit.commit.commit_id == second_project.head_commit_id)
            .unwrap()
            .object_payloads
            .push(updated_extension_payload);
        SyncApplyRepo::apply_batch(
            &target,
            &target_ctx,
            &CommitBatch::new(second_commits, 0, true),
        )
        .unwrap();

        assert_eq!(
            collect_sync_state(&target)
                .unwrap()
                .extensions
                .get("com.example.future-metadata"),
            Some(&serde_json::json!({"revision": 4, "flags": ["c"]}))
        );

        let third_project =
            ProjectRepo::create(&source, &source_ctx, "Extension omission", None, None).unwrap();
        let mut third_commits = serialized_commits_from(&source);
        third_commits
            .iter_mut()
            .find(|commit| commit.commit.commit_id == third_project.head_commit_id)
            .unwrap()
            .object_payloads
            .push(collect_sync_state_payload(&source).unwrap());
        SyncApplyRepo::apply_batch(
            &target,
            &target_ctx,
            &CommitBatch::new(third_commits, 0, true),
        )
        .unwrap();

        let preserved = collect_sync_state(&target).unwrap();
        assert_eq!(
            preserved.extensions.get("com.example.future-metadata"),
            Some(&serde_json::json!({"revision": 4, "flags": ["c"]}))
        );
        let preserved_source_commit: String = target
            .inner()
            .query_row(
                "SELECT source_commit_id FROM sync_state_extensions
                 WHERE extension_key = 'com.example.future-metadata'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(preserved_source_commit, second_project.head_commit_id);

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn relation_sync_roundtrips_generic_metadata_and_versions() {
        let source_path = temp_vault_path("relation-sync-source");
        let target_path = temp_vault_path("relation-sync-target");
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("relation-sync-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());
        let project = ProjectRepo::create(&source, &source_ctx, "Mail", None, None).unwrap();
        let first = EntryRepo::create(
            &source,
            &source_ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("First"),
            &serde_json::json!({"body": "first"}),
        )
        .unwrap();
        let second = EntryRepo::create(
            &source,
            &source_ctx,
            &project.project_id,
            EntryType::custom("com.monica.mail.message").unwrap(),
            Some("Second"),
            &serde_json::json!({"body": "second"}),
        )
        .unwrap();
        let relation = ObjectRelationRepo::create(
            &source,
            &source_ctx,
            ObjectRelationCreateRequest::new(
                &first.entry_id,
                &second.entry_id,
                RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                serde_json::json!({"position": 1}),
            )
            .with_payload_schema_version(4),
        )
        .unwrap();
        let label = ObjectLabelRepo::create(
            &source,
            &source_ctx,
            ObjectLabelCreateRequest::new(
                &project.project_id,
                "Important",
                serde_json::json!({"color": "red"}),
            ),
        )
        .unwrap();
        let assignment = ObjectLabelAssignmentRepo::create(
            &source,
            &source_ctx,
            ObjectLabelAssignmentCreateRequest::new(&first.entry_id, &label.label_id),
        )
        .unwrap();

        let mut commits = serialized_commits_from(&source);
        commits
            .last_mut()
            .unwrap()
            .object_payloads
            .push(collect_sync_state_payload(&source).unwrap());
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.conflict_count, 0);

        let synced_relation = ObjectRelationRepo::get_by_id(&target, &relation.relation_id)
            .unwrap()
            .unwrap();
        let synced_label = ObjectLabelRepo::get_by_id(&target, &label.label_id)
            .unwrap()
            .unwrap();
        let synced_assignment =
            ObjectLabelAssignmentRepo::get_by_id(&target, &assignment.assignment_id)
                .unwrap()
                .unwrap();
        assert_eq!(synced_relation.relation_kind, relation.relation_kind);
        assert_eq!(synced_relation.payload_schema_version, 4);
        assert_eq!(synced_label.name_ct, label.name_ct);
        assert_eq!(synced_assignment.object_id, first.entry_id);
        assert!(ObjectVersionRepo::get_object_relation(
            &target,
            &relation.relation_id,
            &relation.head_commit_id,
        )
        .unwrap()
        .is_some());

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn duplicate_assignment_conflict_maps_incoming_state_to_local_logical_identity() {
        let source_path = temp_vault_path("assignment-conflict-source");
        let target_path = temp_vault_path("assignment-conflict-target");
        let object_id;
        let label_id;
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("assignment-conflict-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &ctx, "Mail", None, None).unwrap();
            object_id = EntryRepo::create(
                &source,
                &ctx,
                &project.project_id,
                EntryType::custom("com.monica.mail.message").unwrap(),
                Some("Message"),
                &serde_json::json!({"body":"message"}),
            )
            .unwrap()
            .entry_id;
            label_id = ObjectLabelRepo::create(
                &source,
                &ctx,
                ObjectLabelCreateRequest::new(
                    &project.project_id,
                    "Important",
                    serde_json::json!({}),
                ),
            )
            .unwrap()
            .label_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());
        let incoming_assignment = ObjectLabelAssignmentRepo::create(
            &source,
            &source_ctx,
            ObjectLabelAssignmentCreateRequest::new(&object_id, &label_id),
        )
        .unwrap();
        let local_assignment = ObjectLabelAssignmentRepo::create(
            &target,
            &target_ctx,
            ObjectLabelAssignmentCreateRequest::new(&object_id, &label_id),
        )
        .unwrap();
        assert_ne!(
            incoming_assignment.assignment_id,
            local_assignment.assignment_id
        );

        let mut commits = serialized_commits_from(&source);
        commits
            .last_mut()
            .unwrap()
            .object_payloads
            .push(collect_sync_state_payload(&source).unwrap());
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.conflict_count, 1);

        let conflict = ConflictRepo::list_by_object(
            &target,
            ConflictObjectType::ObjectLabelAssignment,
            &local_assignment.assignment_id,
        )
        .unwrap()
        .pop()
        .unwrap();
        let logical_incoming = ObjectVersionRepo::get_object_label_assignment(
            &target,
            &local_assignment.assignment_id,
            &conflict.incoming_commit_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            logical_incoming.assignment_id,
            local_assignment.assignment_id
        );
        assert_eq!(logical_incoming.object_id, object_id);
        assert_eq!(logical_incoming.label_id, label_id);

        ConflictRepo::resolve_object_label_assignment(
            &target,
            &target_ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();
        assert!(
            ObjectLabelAssignmentRepo::get_by_id(&target, &local_assignment.assignment_id)
                .unwrap()
                .is_some()
        );
        assert!(
            ObjectLabelAssignmentRepo::get_by_id(&target, &incoming_assignment.assignment_id)
                .unwrap()
                .is_none()
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_relation_changes_create_a_typed_conflict() {
        let source_path = temp_vault_path("relation-conflict-source");
        let target_path = temp_vault_path("relation-conflict-target");
        let relation_id;
        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("relation-conflict-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &ctx, "Mail", None, None).unwrap();
            let first = EntryRepo::create(
                &source,
                &ctx,
                &project.project_id,
                EntryType::custom("com.monica.mail.message").unwrap(),
                Some("First"),
                &serde_json::json!({}),
            )
            .unwrap();
            let second = EntryRepo::create(
                &source,
                &ctx,
                &project.project_id,
                EntryType::custom("com.monica.mail.message").unwrap(),
                Some("Second"),
                &serde_json::json!({}),
            )
            .unwrap();
            relation_id = ObjectRelationRepo::create(
                &source,
                &ctx,
                ObjectRelationCreateRequest::new(
                    first.entry_id,
                    second.entry_id,
                    RelationKindId::new("com.monica.mail.reply-to").unwrap(),
                    serde_json::json!({"position": 1}),
                ),
            )
            .unwrap()
            .relation_id;
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());
        let mut remote = ObjectRelationRepo::get_by_id(&source, &relation_id)
            .unwrap()
            .unwrap();
        remote.payload_ct = serde_json::to_vec(&serde_json::json!({"position": 2})).unwrap();
        ObjectRelationRepo::update(&source, &source_ctx, &remote).unwrap();
        let mut local = ObjectRelationRepo::get_by_id(&target, &relation_id)
            .unwrap()
            .unwrap();
        local.payload_ct = serde_json::to_vec(&serde_json::json!({"position": 3})).unwrap();
        let local = ObjectRelationRepo::update(&target, &target_ctx, &local).unwrap();

        let mut commits = serialized_commits_from(&source);
        commits
            .last_mut()
            .unwrap()
            .object_payloads
            .push(collect_sync_state_payload(&source).unwrap());
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();
        assert_eq!(result.conflict_count, 1);
        assert_eq!(
            ObjectRelationRepo::get_by_id(&target, &relation_id)
                .unwrap()
                .unwrap()
                .head_commit_id,
            local.head_commit_id
        );
        let conflicts =
            ConflictRepo::list_by_object(&target, ConflictObjectType::ObjectRelation, &relation_id)
                .unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].object_type, ConflictObjectType::ObjectRelation);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn audit_commit_correlation_roundtrips_and_rejects_tampering() {
        let source_path = temp_vault_path("audit-correlation-source");
        let target_path = temp_vault_path("audit-correlation-target");
        let mut source = VaultConnection::create(&source_path).unwrap();
        initialize_vault(
            &source,
            &VaultInitParams {
                device_id: "device-a".to_string(),
                ..Default::default()
            },
        )
        .unwrap();
        checkpoint(&source);
        std::fs::copy(&source_path, &target_path).unwrap();

        source.attach_keyring(
            Keyring::from_vault_key(&[11_u8; 32], b"sync-audit-correlation").unwrap(),
        );
        let source_ctx = CommitContext::new("device-a".to_string());
        let project = ProjectRepo::create(&source, &source_ctx, "P", None, None).unwrap();
        let session = VaultSession {
            session_id: "session-a".to_string(),
            unlock_method: UnlockMethodType::Password,
            created_at: "1970-01-01T00:16:40Z".to_string(),
            assurance: SessionAssurance::from_unlock_method(UnlockMethodType::Password, 1_000),
        };
        let device = DeviceContext {
            device_id: Some("device-a".to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: true,
            screen_capture_protection_available: false,
            secure_temp_files_available: true,
        };
        TigaService::set_policy_override_authorized(
            &source,
            &source_ctx,
            TigaScope::Project {
                project_id: project.project_id,
            },
            TigaPolicyOverride {
                clipboard_allowed: Some(false),
                ..Default::default()
            },
            None,
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: 1_010,
            },
        )
        .unwrap();
        let source_event = TigaService::list_security_audit_events(&source, 10)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let audit_commit_id = source_event.commit_id.clone().unwrap();

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &audit_commit_id);
        let mut target = VaultConnection::open(&target_path).unwrap();
        target.attach_keyring(
            Keyring::from_vault_key(&[11_u8; 32], b"sync-audit-correlation").unwrap(),
        );
        let target_ctx = CommitContext::new("device-b".to_string());
        SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
            .unwrap();

        let target_event = TigaService::list_security_audit_events(&target, 10)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(target_event, source_event);

        let synced_row = collect_sync_state(&source)
            .unwrap()
            .security_audit_events
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let mut rewritten_correlation = synced_row.clone();
        rewritten_correlation.operation_id = Some("rewritten-operation".to_string());
        rewritten_correlation.integrity_tag = None;
        let correlation_error =
            tiga_apply::apply_security_audit_events(&target, &[rewritten_correlation]).unwrap_err();
        assert!(correlation_error
            .to_string()
            .contains("mismatched operation and commit"));

        let mut rewritten_evidence = synced_row;
        rewritten_evidence.policy_fingerprint.as_mut().unwrap()[0] ^= 1;
        let evidence_error =
            tiga_apply::apply_security_audit_events(&target, &[rewritten_evidence]).unwrap_err();
        assert!(evidence_error
            .to_string()
            .contains("integrity tag mismatch"));

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_entry_different_payload_fields_auto_merge() {
        let source_path = temp_vault_path("field-merge-source");
        let target_path = temp_vault_path("field-merge-target");
        let entry_id;

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("field-merge-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &source_ctx, "P", None, None).unwrap();
            let entry = EntryRepo::create(
                &source,
                &source_ctx,
                &project.project_id,
                EntryType::Login,
                Some("Login"),
                &serde_json::json!({
                    "username": "alice",
                    "password": "old",
                    "url": "https://old.example"
                }),
            )
            .unwrap();
            entry_id = entry.entry_id.clone();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let incoming = update_entry_payload(
            &source,
            &source_ctx,
            &entry_id,
            serde_json::json!({
                "username": "alice",
                "password": "old",
                "url": "https://remote.example"
            }),
        );
        let _local = update_entry_payload(
            &target,
            &target_ctx,
            &entry_id,
            serde_json::json!({
                "username": "alice-local",
                "password": "old",
                "url": "https://old.example"
            }),
        );

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();

        assert_eq!(result.conflict_count, 0);
        assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());
        let merged = entry_payload_json(&target, &entry_id);
        assert_eq!(merged["username"], "alice-local");
        assert_eq!(merged["password"], "old");
        assert_eq!(merged["url"], "https://remote.example");

        let merged_entry = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
        let parent_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_parents WHERE commit_id = ?1",
                params![merged_entry.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent_count, 2);
        let version_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM object_versions
                 WHERE object_type = 'entry' AND object_id = ?1 AND commit_id = ?2",
                params![entry_id, merged_entry.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version_count, 1);

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_entry_same_payload_field_creates_conflict() {
        let source_path = temp_vault_path("field-conflict-source");
        let target_path = temp_vault_path("field-conflict-target");
        let entry_id;

        {
            let source = VaultConnection::create(&source_path).unwrap();
            initialize_vault(
                &source,
                &VaultInitParams {
                    vault_id: Some("field-conflict-vault".to_string()),
                    device_id: "device-a".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let project = ProjectRepo::create(&source, &source_ctx, "P", None, None).unwrap();
            let entry = EntryRepo::create(
                &source,
                &source_ctx,
                &project.project_id,
                EntryType::Login,
                Some("Login"),
                &serde_json::json!({
                    "username": "alice",
                    "password": "old",
                    "url": "https://old.example"
                }),
            )
            .unwrap();
            entry_id = entry.entry_id.clone();
            checkpoint(&source);
        }
        std::fs::copy(&source_path, &target_path).unwrap();

        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let incoming = update_entry_payload(
            &source,
            &source_ctx,
            &entry_id,
            serde_json::json!({
                "username": "alice",
                "password": "remote-secret",
                "url": "https://old.example"
            }),
        );
        let _local = update_entry_payload(
            &target,
            &target_ctx,
            &entry_id,
            serde_json::json!({
                "username": "alice",
                "password": "local-secret",
                "url": "https://old.example"
            }),
        );

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();

        assert_eq!(result.conflict_count, 1);
        let conflicts = ConflictRepo::list_unresolved(&target).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].object_id, entry_id);
        assert_eq!(conflicts[0].conflicting_fields, vec!["password"]);

        let local_after = entry_payload_json(&target, &entry_id);
        assert_eq!(local_after["password"], "local-secret");

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_project_different_fields_auto_merge() {
        let (source_path, target_path, project_id) =
            create_project_divergence("project-field-merge");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let incoming = update_project_for_test(&source, &source_ctx, &project_id, |project| {
            project.icon_ref = Some("remote-icon".to_string());
        });
        let _local = update_project_for_test(&target, &target_ctx, &project_id, |project| {
            project.favorite = true;
        });

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();

        assert_eq!(result.conflict_count, 0);
        assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());
        let merged = ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .unwrap();
        assert_eq!(merged.icon_ref.as_deref(), Some("remote-icon"));
        assert!(merged.favorite);

        let parent_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM commit_parents WHERE commit_id = ?1",
                params![merged.head_commit_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(parent_count, 2);
        assert!(
            ObjectVersionRepo::get_project(&target, &project_id, &merged.head_commit_id)
                .unwrap()
                .is_some()
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_project_same_field_creates_field_conflict() {
        let (source_path, target_path, project_id) =
            create_project_divergence("project-field-conflict");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let incoming = update_project_for_test(&source, &source_ctx, &project_id, |project| {
            project.group_id = Some("remote".to_string());
        });
        let _local = update_project_for_test(&target, &target_ctx, &project_id, |project| {
            project.group_id = Some("local".to_string());
        });

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();

        assert_eq!(result.conflict_count, 1);
        let conflicts = ConflictRepo::list_unresolved(&target).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].object_id, project_id);
        assert_eq!(conflicts[0].conflicting_fields, vec!["group_id"]);

        let local_after = ProjectRepo::get_by_id(&target, &project_id)
            .unwrap()
            .unwrap();
        assert_eq!(local_after.group_id.as_deref(), Some("local"));

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_attachment_metadata_and_remote_content_auto_merge() {
        let (source_path, target_path, attachment_id) =
            create_attachment_divergence("attachment-field-merge");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        AttachmentRepo::write_inline_content(
            &source,
            &source_ctx,
            &attachment_id,
            b"remote content",
        )
        .unwrap();
        let incoming = AttachmentRepo::get_by_id(&source, &attachment_id)
            .unwrap()
            .unwrap();
        let _local =
            AttachmentRepo::rename(&target, &target_ctx, &attachment_id, "local.txt", None)
                .unwrap();

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();

        assert_eq!(result.conflict_count, 0);
        assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());
        let merged = AttachmentRepo::get_by_id(&target, &attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(merged.file_name_ct, b"local.txt");
        assert_eq!(
            AttachmentRepo::read_content(&target, &attachment_id).unwrap(),
            b"remote content"
        );
        assert!(
            ObjectVersionRepo::get_attachment(&target, &attachment_id, &merged.head_commit_id)
                .unwrap()
                .is_some()
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn divergent_attachment_both_change_content_creates_conflict() {
        let (source_path, target_path, attachment_id) =
            create_attachment_divergence("attachment-content-conflict");
        let source = VaultConnection::open(&source_path).unwrap();
        let target = VaultConnection::open(&target_path).unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        AttachmentRepo::write_inline_content(
            &source,
            &source_ctx,
            &attachment_id,
            b"remote content",
        )
        .unwrap();
        let incoming = AttachmentRepo::get_by_id(&source, &attachment_id)
            .unwrap()
            .unwrap();
        AttachmentRepo::write_inline_content(
            &target,
            &target_ctx,
            &attachment_id,
            b"local content",
        )
        .unwrap();

        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &incoming.head_commit_id);
        let result =
            SyncApplyRepo::apply_batch(&target, &target_ctx, &CommitBatch::new(commits, 0, true))
                .unwrap();

        assert_eq!(result.conflict_count, 1);
        let conflicts = ConflictRepo::list_unresolved(&target).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].object_id, attachment_id);
        assert_eq!(conflicts[0].conflicting_fields, vec!["content_hash"]);
        assert_eq!(
            AttachmentRepo::read_content(&target, &attachment_id).unwrap(),
            b"local content"
        );

        drop(source);
        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn entry_conflict_resolve_local_wins_writes_resolution_commit() {
        let (source_path, target_path, entry_id) =
            create_divergent_password_conflict("resolve-local-wins");
        let target = VaultConnection::open(&target_path).unwrap();
        let target_ctx = CommitContext::new("device-b".to_string());
        let conflict = ConflictRepo::list_unresolved(&target).unwrap().remove(0);
        let before = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();

        let resolved = ConflictRepo::resolve_entry(
            &target,
            &target_ctx,
            &conflict.conflict_id,
            ConflictResolution::LocalWins,
        )
        .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::LocalWins);
        assert!(resolved.resolved_at.is_some());
        assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());

        let after = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
        assert_ne!(after.head_commit_id, before.head_commit_id);
        assert_eq!(
            entry_payload_json(&target, &entry_id)["password"],
            "local-secret"
        );

        let parents = SyncApplyRepo::parent_ids_for_commit(&target, &after.head_commit_id).unwrap();
        assert!(parents.contains(&before.head_commit_id));
        assert!(parents.contains(&conflict.incoming_commit_id));

        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn entry_conflict_resolve_incoming_wins_applies_incoming_snapshot() {
        let (source_path, target_path, entry_id) =
            create_divergent_password_conflict("resolve-incoming-wins");
        let target = VaultConnection::open(&target_path).unwrap();
        let target_ctx = CommitContext::new("device-b".to_string());
        let conflict = ConflictRepo::list_unresolved(&target).unwrap().remove(0);
        let before = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();

        let resolved = ConflictRepo::resolve_entry(
            &target,
            &target_ctx,
            &conflict.conflict_id,
            ConflictResolution::IncomingWins,
        )
        .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::IncomingWins);
        assert!(resolved.resolved_at.is_some());
        assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());

        let after = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
        assert_ne!(after.head_commit_id, before.head_commit_id);
        assert_eq!(
            entry_payload_json(&target, &entry_id)["password"],
            "remote-secret"
        );
        assert!(
            ObjectVersionRepo::get_entry(&target, &entry_id, &after.head_commit_id)
                .unwrap()
                .is_some()
        );

        let parents = SyncApplyRepo::parent_ids_for_commit(&target, &after.head_commit_id).unwrap();
        assert!(parents.contains(&before.head_commit_id));
        assert!(parents.contains(&conflict.incoming_commit_id));

        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn entry_conflict_resolve_custom_payload_writes_merge_commit() {
        let (source_path, target_path, entry_id) =
            create_divergent_password_conflict("resolve-custom-payload");
        let target = VaultConnection::open(&target_path).unwrap();
        let target_ctx = CommitContext::new("device-b".to_string());
        let conflict = ConflictRepo::list_unresolved(&target).unwrap().remove(0);
        let before = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();

        let resolved = ConflictRepo::resolve_entry_custom_payload(
            &target,
            &target_ctx,
            &conflict.conflict_id,
            &serde_json::json!({
                "username": "alice",
                "password": "merged-secret",
                "url": "https://old.example"
            }),
        )
        .unwrap();

        assert_eq!(resolved.resolution, ConflictResolution::Custom);
        assert!(resolved.resolved_at.is_some());
        assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());

        let after = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
        assert_ne!(after.head_commit_id, before.head_commit_id);
        assert_eq!(
            entry_payload_json(&target, &entry_id)["password"],
            "merged-secret"
        );
        assert!(
            ObjectVersionRepo::get_entry(&target, &entry_id, &after.head_commit_id)
                .unwrap()
                .is_some()
        );

        let parents = SyncApplyRepo::parent_ids_for_commit(&target, &after.head_commit_id).unwrap();
        assert!(parents.contains(&before.head_commit_id));
        assert!(parents.contains(&conflict.incoming_commit_id));

        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn remote_delete_local_modify_creates_conflict_without_losing_tombstone() {
        let (source_path, target_path, entry_id) =
            create_delete_modify_conflict("remote-delete-local-modify", true);
        let target = VaultConnection::open(&target_path).unwrap();

        let conflicts = ConflictRepo::list_unresolved(&target).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].object_id, entry_id);
        assert_eq!(conflicts[0].conflicting_fields, vec!["deleted"]);

        let entry = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
        assert!(!entry.deleted);
        assert_eq!(
            entry_payload_json(&target, &entry_id)["password"],
            "local-change"
        );

        let tombstone_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE target_object_type = 'entry' AND target_object_id = ?1",
                params![entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstone_count, 1);

        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn local_delete_remote_modify_creates_conflict_without_reviving_entry() {
        let (source_path, target_path, entry_id) =
            create_delete_modify_conflict("local-delete-remote-modify", false);
        let target = VaultConnection::open(&target_path).unwrap();

        let conflicts = ConflictRepo::list_unresolved(&target).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].object_id, entry_id);
        assert_eq!(conflicts[0].conflicting_fields, vec!["deleted"]);

        let entry = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
        assert!(entry.deleted);

        let tombstone_count: i64 = target
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM tombstones
                 WHERE target_object_type = 'entry' AND target_object_id = ?1",
                params![entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tombstone_count, 1);

        drop(target);
        let _ = std::fs::remove_file(source_path);
        let _ = std::fs::remove_file(target_path);
    }

    #[test]
    fn resolved_conflict_sync_converges_delete_and_revival_tombstones() {
        for (label, remote_deletes, expected_deleted) in [
            ("resolved-revival", true, false),
            ("resolved-delete", false, true),
        ] {
            let (source_path, target_path, entry_id) =
                create_delete_modify_conflict(label, remote_deletes);
            let source = VaultConnection::open(&source_path).unwrap();
            let target = VaultConnection::open(&target_path).unwrap();
            let source_ctx = CommitContext::new("device-a".to_string());
            let target_ctx = CommitContext::new("device-b".to_string());
            let conflict = ConflictRepo::list_unresolved(&target).unwrap().remove(0);

            ConflictRepo::resolve_entry(
                &target,
                &target_ctx,
                &conflict.conflict_id,
                ConflictResolution::LocalWins,
            )
            .unwrap();
            let resolved = EntryRepo::get_by_id(&target, &entry_id).unwrap().unwrap();
            assert_eq!(resolved.deleted, expected_deleted);
            assert_eq!(
                entry_tombstone_count(&target, &entry_id),
                i64::from(expected_deleted)
            );
            assert!(ConflictRepo::list_unresolved(&target).unwrap().is_empty());

            let mut commits = serialized_commits_from(&target);
            attach_state_payload_to_commit(&target, &mut commits, &resolved.head_commit_id);
            let batch = CommitBatch::new(commits, 0, true);
            let result = SyncApplyRepo::apply_batch(&source, &source_ctx, &batch).unwrap();

            assert_eq!(result.conflict_count, 0);
            assert!(ConflictRepo::list_unresolved(&source).unwrap().is_empty());
            let synchronized = EntryRepo::get_by_id(&source, &entry_id).unwrap().unwrap();
            assert_eq!(synchronized.deleted, expected_deleted);
            assert_eq!(synchronized.head_commit_id, resolved.head_commit_id);
            assert_eq!(
                entry_tombstone_count(&source, &entry_id),
                i64::from(expected_deleted)
            );
            assert!(
                ObjectVersionRepo::get_entry(&source, &entry_id, &synchronized.head_commit_id)
                    .unwrap()
                    .is_some()
            );
            assert_eq!(
                SyncApplyRepo::current_branch_head(&source, None, "main")
                    .unwrap()
                    .as_deref(),
                Some(resolved.head_commit_id.as_str())
            );

            let repeated = SyncApplyRepo::apply_batch(&source, &source_ctx, &batch).unwrap();
            assert_eq!(repeated.conflict_count, 0);
            assert_eq!(
                EntryRepo::get_by_id(&source, &entry_id)
                    .unwrap()
                    .unwrap()
                    .head_commit_id,
                resolved.head_commit_id
            );
            assert_eq!(
                entry_tombstone_count(&source, &entry_id),
                i64::from(expected_deleted)
            );

            drop(source);
            drop(target);
            remove_vault_files(&source_path);
            remove_vault_files(&target_path);
        }
    }

    #[test]
    fn mutable_sync_apply_refreshes_keys_after_sequential_rotation() {
        let (source_path, target_path, base_project_id) =
            create_key_epoch_sync_pair("sequential-key-epoch");
        let mut source = VaultConnection::open(&source_path).unwrap();
        let mut target = VaultConnection::open(&target_path).unwrap();
        UnlockService::unlock_with_password(&mut source, "epoch sync password").unwrap();
        UnlockService::unlock_with_password(&mut target, "epoch sync password").unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        let target_ctx = CommitContext::new("device-b".to_string());

        let rotation = rotate_epoch_for_sync(&mut source, &source_ctx, "device-a");
        let after =
            ProjectRepo::create(&source, &source_ctx, "After rotation", None, None).unwrap();
        let mut commits = serialized_commits_from(&source);
        attach_state_payload_to_commit(&source, &mut commits, &after.head_commit_id);

        let result = SyncApplyRepo::apply_batch_mut(
            &mut target,
            &target_ctx,
            &CommitBatch::new(commits, 0, true),
        )
        .unwrap();
        assert_eq!(result.conflict_count, 0);
        assert_eq!(
            target.active_key_epoch_id(),
            Some(rotation.active_epoch_id.as_str())
        );
        assert!(target
            .keyring_for_epoch(&rotation.previous_epoch_id)
            .is_some());
        assert!(target
            .keyring_for_epoch(&rotation.active_epoch_id)
            .is_some());
        assert_eq!(
            ProjectRepo::get_by_id(&target, &base_project_id)
                .unwrap()
                .unwrap()
                .title_ct,
            b"Base"
        );
        assert_eq!(
            ProjectRepo::get_by_id(&target, &after.project_id)
                .unwrap()
                .unwrap()
                .title_ct,
            b"After rotation"
        );

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }

    #[test]
    fn concurrent_rotations_converge_and_preserve_both_epoch_keys() {
        let (left_path, right_path, base_project_id) =
            create_key_epoch_sync_pair("concurrent-key-epoch");
        let mut left = VaultConnection::open(&left_path).unwrap();
        let mut right = VaultConnection::open(&right_path).unwrap();
        UnlockService::unlock_with_password(&mut left, "epoch sync password").unwrap();
        UnlockService::unlock_with_password(&mut right, "epoch sync password").unwrap();
        let left_ctx = CommitContext::new("device-a".to_string());
        let right_ctx = CommitContext::new("device-b".to_string());

        let left_rotation = rotate_epoch_for_sync(&mut left, &left_ctx, "device-a");
        let left_project = ProjectRepo::create(&left, &left_ctx, "Left epoch", None, None).unwrap();
        let right_rotation = rotate_epoch_for_sync(&mut right, &right_ctx, "device-b");
        let right_project =
            ProjectRepo::create(&right, &right_ctx, "Right epoch", None, None).unwrap();

        let mut left_commits = serialized_commits_from(&left);
        attach_state_payload_to_commit(&left, &mut left_commits, &left_project.head_commit_id);
        let mut right_commits = serialized_commits_from(&right);
        attach_state_payload_to_commit(&right, &mut right_commits, &right_project.head_commit_id);

        SyncApplyRepo::apply_batch_mut(
            &mut left,
            &left_ctx,
            &CommitBatch::new(right_commits, 0, true),
        )
        .unwrap();
        SyncApplyRepo::apply_batch_mut(
            &mut right,
            &right_ctx,
            &CommitBatch::new(left_commits, 0, true),
        )
        .unwrap();

        let expected_active = if (
            right_rotation.rotated_at.as_str(),
            right_rotation.active_epoch_id.as_str(),
        ) > (
            left_rotation.rotated_at.as_str(),
            left_rotation.active_epoch_id.as_str(),
        ) {
            right_rotation.active_epoch_id.as_str()
        } else {
            left_rotation.active_epoch_id.as_str()
        };
        assert_eq!(left.active_key_epoch_id(), Some(expected_active));
        assert_eq!(right.active_key_epoch_id(), Some(expected_active));
        for conn in [&left, &right] {
            assert!(conn
                .keyring_for_epoch(&left_rotation.active_epoch_id)
                .is_some());
            assert!(conn
                .keyring_for_epoch(&right_rotation.active_epoch_id)
                .is_some());
            let epoch_count: i64 = conn
                .inner()
                .query_row("SELECT COUNT(*) FROM key_epochs", [], |row| row.get(0))
                .unwrap();
            assert_eq!(epoch_count, 3);
            assert_eq!(
                ProjectRepo::get_by_id(conn, &base_project_id)
                    .unwrap()
                    .unwrap()
                    .title_ct,
                b"Base"
            );
            assert_eq!(
                ProjectRepo::get_by_id(conn, &left_project.project_id)
                    .unwrap()
                    .unwrap()
                    .title_ct,
                b"Left epoch"
            );
            assert_eq!(
                ProjectRepo::get_by_id(conn, &right_project.project_id)
                    .unwrap()
                    .unwrap()
                    .title_ct,
                b"Right epoch"
            );
        }

        drop(left);
        drop(right);
        remove_vault_files(&left_path);
        remove_vault_files(&right_path);
    }

    #[test]
    fn key_epoch_sync_rejects_immutable_unsigned_and_tampered_changes() {
        let (source_path, target_path, _) = create_key_epoch_sync_pair("rejected-key-epoch");
        let mut source = VaultConnection::open(&source_path).unwrap();
        let mut target = VaultConnection::open(&target_path).unwrap();
        UnlockService::unlock_with_password(&mut source, "epoch sync password").unwrap();
        UnlockService::unlock_with_password(&mut target, "epoch sync password").unwrap();
        let source_ctx = CommitContext::new("device-a".to_string());
        rotate_epoch_for_sync(&mut source, &source_ctx, "device-a");
        let incoming = collect_sync_state(&source)
            .unwrap()
            .key_epoch_state
            .unwrap();
        let original_active = target.active_key_epoch_id().unwrap().to_string();

        let immutable_error = key_epoch_apply::apply(
            &target,
            &incoming,
            key_epoch_apply::MergeMode::FastForward,
            false,
        )
        .unwrap_err();
        assert!(immutable_error.to_string().contains("mutable sync apply"));

        let mut unsigned = incoming.clone();
        unsigned.integrity_tag = None;
        let unsigned_error = key_epoch_apply::apply(
            &target,
            &unsigned,
            key_epoch_apply::MergeMode::FastForward,
            true,
        )
        .unwrap_err();
        assert!(unsigned_error.to_string().contains("integrity tag"));

        let mut tampered = incoming;
        tampered.integrity_tag.as_mut().unwrap()[0] ^= 1;
        let tampered_error = key_epoch_apply::apply(
            &target,
            &tampered,
            key_epoch_apply::MergeMode::FastForward,
            true,
        )
        .unwrap_err();
        assert!(tampered_error
            .to_string()
            .contains("integrity tag mismatch"));
        assert_eq!(target.active_key_epoch_id(), Some(original_active.as_str()));
        let database_active: String = target
            .inner()
            .query_row("SELECT active_key_epoch_id FROM vault_meta", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(database_active, original_active);

        drop(source);
        drop(target);
        remove_vault_files(&source_path);
        remove_vault_files(&target_path);
    }
}
