use super::*;
use std::io::Write;
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use mdbx_core::model::{ConflictObjectType, EntryType, SnapshotKind};
use mdbx_storage::connection::VaultConnection;
use mdbx_storage::init::{initialize_vault, VaultInitParams};
use mdbx_storage::repo::{
    AttachmentRepo, CommitContext, ConflictRepo, EntryRepo, ObjectLabelAssignmentRepo,
    ObjectLabelRepo, ObjectRelationCreateRequest, ObjectRelationRepo, ProjectRepo,
    SnapshotLifecycleRepo, SnapshotRepo, TombstoneRepo,
};
use mdbx_storage::runtime::VaultRuntime;
use mdbx_storage::unlock::UnlockService;
use sha2::{Digest, Sha256};

fn ffi_test_vault() -> MdbxVault {
    let mut conn = VaultConnection::open_in_memory().unwrap();
    let init = initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    UnlockService::setup_password_with_mode(&mut conn, "attachment-password", TigaMode::Multi)
        .unwrap();
    MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-attachment-device".to_string(),
        vault_id: init.vault_id,
    }
}

fn ffi_test_extension_profile(namespace: &str) -> MdbxExtensionProfile {
    MdbxExtensionProfile {
        extension_id: namespace.to_string(),
        profile_version: 1,
        collection_type_ids: vec![namespace.to_string()],
        object_type_ids: vec![format!("{namespace}.item")],
        relation_kind_ids: vec![format!("{namespace}.member")],
        capability_ids: vec![format!("{namespace}.store")],
        optional_index_ids: vec![format!("{namespace}.index.main")],
        import_adapter_ids: Vec::new(),
        export_adapter_ids: Vec::new(),
        presentation_hint_ids: Vec::new(),
    }
}

fn ffi_test_count(vault: &MdbxVault, table: &str) -> i64 {
    let conn = vault.conn.lock().unwrap();
    conn.inner()
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn shared_ffi_vault_uses_one_runtime_writer_gate() {
    let vault = Arc::new(ffi_test_vault());
    let start = Arc::new(Barrier::new(3));
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    let workers = (0..2)
        .map(|_| {
            let vault = Arc::clone(&vault);
            let start = Arc::clone(&start);
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            thread::spawn(move || {
                start.wait();
                vault
                    .conn
                    .with_write(|_| {
                        let current = active.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
                        peak.fetch_max(current, std::sync::atomic::Ordering::AcqRel);
                        thread::sleep(Duration::from_millis(10));
                        active.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                        Ok(())
                    })
                    .unwrap();
            })
        })
        .collect::<Vec<_>>();

    start.wait();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(peak.load(std::sync::atomic::Ordering::Acquire), 1);
}

#[test]
fn diagnostics_summary_matches_storage_counts() {
    let vault = ffi_test_vault();
    let summary = vault.diagnostics_summary().unwrap();

    assert_eq!(
        summary.commit_count,
        ffi_test_count(&vault, "commits") as u64
    );
    assert_eq!(
        summary.tombstone_count,
        ffi_test_count(&vault, "tombstones") as u64
    );
    assert_eq!(
        summary.branch_count,
        ffi_test_count(&vault, "branches") as u64
    );
    assert_eq!(
        summary.device_count,
        ffi_test_count(&vault, "device_heads") as u64
    );
    assert_eq!(
        summary.snapshot_count,
        ffi_test_count(&vault, "snapshots") as u64
    );
    assert_eq!(summary.unresolved_conflict_count, 0);
    assert_eq!(summary.deleted_project_count, 0);
    assert_eq!(summary.deleted_entry_count, 0);
    assert_eq!(summary.deleted_attachment_count, 0);
    assert_eq!(summary.external_attachment_count, 0);
    assert_eq!(summary.original_attachment_bytes, 0);
    assert_eq!(summary.stored_attachment_bytes, 0);
}

#[test]
fn managed_snapshot_and_commit_actions_round_trip_through_ffi() {
    let vault = ffi_test_vault();
    let entry_id = {
        let conn = vault.conn.lock().unwrap();
        let ctx = CommitContext::new(vault.device_id.clone());
        let project = ProjectRepo::create(&conn, &ctx, "Snapshot project", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Before"),
            &serde_json::json!({"password":"one"}),
        )
        .unwrap();
        entry.entry_id
    };
    let created_snapshot = vault
        .create_manual_snapshot(
            "Before update".to_string(),
            conservative_ffi_device_context(),
        )
        .unwrap();
    assert_eq!(created_snapshot.name, "Before update");
    let update_commit_id = {
        let conn = vault.conn.lock().unwrap();
        let ctx = CommitContext::new(vault.device_id.clone());
        let mut changed = EntryRepo::get_by_id(&conn, &entry_id).unwrap().unwrap();
        changed.title_ct = Some(b"After".to_vec());
        changed.payload_ct = serde_json::to_vec(&serde_json::json!({"password":"two"})).unwrap();
        let updated = EntryRepo::update(&conn, &ctx, &changed).unwrap();
        updated.head_commit_id
    };

    let diff = vault.list_commit_diff(update_commit_id.clone()).unwrap();
    assert_eq!(diff.len(), 1);
    assert_eq!(diff[0].previous_title.as_deref(), Some("Before"));
    assert_eq!(diff[0].current_title.as_deref(), Some("After"));

    let page = vault.list_managed_snapshots(20, None).unwrap();
    let snapshot = page
        .items
        .iter()
        .find(|item| item.name == "Before update")
        .unwrap()
        .clone();
    let preview = vault
        .get_snapshot_structure_preview(snapshot.snapshot_id.clone())
        .unwrap();
    assert!(preview
        .current_nodes
        .iter()
        .any(|node| node.id == entry_id && node.status == "modified"));

    let restored = vault
        .restore_snapshot(
            snapshot.snapshot_id.clone(),
            conservative_ffi_device_context(),
        )
        .unwrap();
    assert!(restored.affected_object_count >= 1);
    {
        let conn = vault.conn.lock().unwrap();
        let entry = EntryRepo::get_by_id(&conn, &entry_id).unwrap().unwrap();
        assert_eq!(
            String::from_utf8(entry.title_ct.unwrap()).unwrap(),
            "Before"
        );
    }

    let revert = vault
        .revert_commit(
            update_commit_id,
            uuid::Uuid::new_v4().to_string(),
            conservative_ffi_device_context(),
        )
        .unwrap();
    assert_eq!(revert.reverted_object_count, 1);

    let deleted = vault
        .delete_snapshot(
            snapshot.snapshot_id.clone(),
            conservative_ffi_device_context(),
        )
        .unwrap();
    assert_eq!(deleted.snapshot_id, snapshot.snapshot_id);
    assert!(vault
        .list_managed_snapshots(20, None)
        .unwrap()
        .items
        .iter()
        .all(|item| item.snapshot_id != deleted.snapshot_id));
}

#[test]
fn build_capability_manifest_is_available_without_a_vault() {
    let manifest = mdbx_build_capability_manifest();
    assert_eq!(manifest.profile, "mdbx-build-capabilities-v1");
    assert_eq!(manifest.engine_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(manifest.storage_profile, "mdbx-storage-capabilities-v1");
    assert_eq!(manifest.sync_profile, "mdbx-sync-capabilities-v1");
    assert_eq!(manifest.sync_protocol_version, mdbx_sync::PROTOCOL_VERSION);
    assert!(manifest
        .enabled_storage_capability_ids
        .contains(&"mdbx.storage.mdbx1-compatibility".to_string()));
    assert!(manifest
        .enabled_sync_capability_ids
        .contains(&mdbx_sync::CAPABILITY_AUTHENTICATED_STATE_ROOT_V1.to_string()));

    // Cargo may unify dependency features in workspace builds. The manifest
    // must report the resulting binary and partition each optional ID once.
    for capability in [
        "mdbx.storage.benchmarks",
        "mdbx.storage.derived-search-index",
        "mdbx.storage.filesystem-blob-store",
        "mdbx.storage.kdbx-json-export",
        "mdbx.storage.kdbx-json-import",
    ] {
        let enabled = manifest
            .enabled_storage_capability_ids
            .contains(&capability.to_string());
        let disabled = manifest
            .disabled_optional_storage_capability_ids
            .contains(&capability.to_string());
        assert_ne!(enabled, disabled, "optional capability {capability}");
    }
    let zstd = mdbx_sync::CAPABILITY_ZSTD_BUNDLE_V1.to_string();
    assert_ne!(
        manifest.enabled_sync_capability_ids.contains(&zstd),
        manifest
            .disabled_optional_sync_capability_ids
            .contains(&zstd)
    );
}

#[test]
fn runtime_manifest_is_available_without_a_vault_and_preserves_mdbx2_storage() {
    let manifest = mdbx_runtime_manifest();

    assert_eq!(manifest.profile, "mdbx-runtime-manifest-v1");
    assert_eq!(manifest.runtime_name, "MDBX3");
    assert_eq!(manifest.runtime_version, "3.0.0-alpha.1");
    assert_eq!(manifest.implementation_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(manifest.build_profile, "mdbx3-ffi-compatible-v1");
    assert_eq!(manifest.storage_format, mdbx_storage::migration::FORMAT_V2);
    assert_eq!(
        manifest.current_schema_version,
        mdbx_storage::schema::SCHEMA_VERSION
    );
    assert_eq!(
        manifest.readable_storage_formats,
        vec![
            mdbx_storage::migration::FORMAT_V1,
            mdbx_storage::migration::FORMAT_V1_DRAFT,
            mdbx_storage::migration::FORMAT_V2,
        ]
    );
    assert_eq!(
        manifest.writable_storage_format,
        mdbx_storage::migration::FORMAT_V2
    );
    assert_eq!(manifest.ffi_abi_profile, "mdbx-ffi-abi-v1");
    assert_eq!(manifest.ffi_namespace, "mdbx_ffi");
    assert_eq!(manifest.native_library_name, "mdbx_ffi");
    assert_eq!(manifest.android_shared_object_name, "libmdbx_ffi.so");
    assert_eq!(manifest.compatibility_profile, "mdbx3-mdbx2-drop-in-v1");
}

#[test]
fn authenticated_manual_bundle_round_trip_replay_and_tamper_guard() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.mdbx");
    let target_path = directory.path().join("target.mdbx");
    let bundle_path = directory.path().join("manual.mdbx-sync");
    let tampered_path = directory.path().join("tampered.mdbx-sync");
    let password = "manual-bundle-password";
    let source = create_vault_with_tiga_mode(
        source_path.to_string_lossy().into_owned(),
        password.to_string(),
        "manual-source".to_string(),
        MdbxTigaMode::Sky,
    )
    .unwrap();
    create_portable_backup(
        source_path.to_string_lossy().into_owned(),
        target_path.to_string_lossy().into_owned(),
    )
    .unwrap();

    let project_id = Uuid::new_v4().to_string();
    source
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "manual-bundle-source-change".to_string(),
            vec![MdbxWriteCommand::CreateProject {
                project_id: project_id.clone(),
                title: "Transferred project".to_string(),
            }],
        )
        .unwrap();
    let exported = source
        .export_manual_sync_bundle(bundle_path.to_string_lossy().into_owned())
        .unwrap();
    assert_eq!(exported.vault_id, source.info().vault_id);
    assert!(exported.commit_count >= 2);
    assert_eq!(exported.payload_sha256.len(), 32);
    assert_eq!(
        exported.file_size_bytes,
        std::fs::metadata(&bundle_path).unwrap().len()
    );

    let target = open_vault(
        target_path.to_string_lossy().into_owned(),
        password.to_string(),
        "manual-target".to_string(),
    )
    .unwrap();
    let first = target
        .apply_manual_sync_bundle(bundle_path.to_string_lossy().into_owned())
        .unwrap();
    assert!(first.applied_commits >= 1);
    assert_eq!(first.missing_parent_count, 0);
    assert!(target
        .list_collection_summaries(100, None)
        .unwrap()
        .items
        .iter()
        .any(|project| project.collection_id == project_id));

    let replay = target
        .apply_manual_sync_bundle(bundle_path.to_string_lossy().into_owned())
        .unwrap();
    assert_eq!(replay.applied_commits, 0);
    assert!(replay.skipped_commits >= exported.commit_count);

    let commits_before_tamper = ffi_test_count(&target, "commits");
    let mut tampered = std::fs::read(&bundle_path).unwrap();
    let last = tampered.last_mut().unwrap();
    *last ^= 1;
    std::fs::write(&tampered_path, tampered).unwrap();
    assert!(target
        .apply_manual_sync_bundle(tampered_path.to_string_lossy().into_owned())
        .is_err());
    assert_eq!(ffi_test_count(&target, "commits"), commits_before_tamper);
}

#[test]
fn metadata_benchmark_is_bounded_and_appends_only_requested_commits() {
    let vault = ffi_test_vault();
    let before = ffi_test_count(&vault, "commits");
    let result = vault.run_metadata_benchmark(3).unwrap();
    assert_eq!(result.operation_count, 3);
    assert_eq!(ffi_test_count(&vault, "commits"), before + 3);
    assert!(vault.run_metadata_benchmark(0).is_err());
    assert!(vault
        .run_metadata_benchmark(MAX_METADATA_BENCHMARK_OPERATIONS + 1)
        .is_err());
}

#[test]
fn extension_profile_registry_is_canonical_idempotent_and_atomic() {
    let vault = ffi_test_vault();
    let mut mail = ffi_test_extension_profile("com.monica.mail");
    mail.object_type_ids
        .push("com.monica.mail.contact".to_string());
    mail.object_type_ids
        .push("com.monica.mail.item".to_string());

    assert_eq!(
        vault.register_extension_profile(mail.clone()).unwrap(),
        MdbxExtensionRegistration::Registered
    );
    assert_eq!(
        vault.register_extension_profile(mail.clone()).unwrap(),
        MdbxExtensionRegistration::AlreadyRegistered
    );
    let stored = vault
        .get_extension_profile("com.monica.mail".to_string())
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.object_type_ids,
        vec![
            "com.monica.mail.contact".to_string(),
            "com.monica.mail.item".to_string(),
        ]
    );

    let mut changed = mail.clone();
    changed.profile_version = 2;
    assert!(vault.register_extension_profile(changed).is_err());
    assert_eq!(
        vault.list_extension_profiles().unwrap(),
        vec![stored.clone()]
    );

    let mut umbrella = ffi_test_extension_profile("com.monica");
    umbrella.collection_type_ids = stored.collection_type_ids.clone();
    umbrella.object_type_ids = stored.object_type_ids.clone();
    umbrella.relation_kind_ids = stored.relation_kind_ids.clone();
    umbrella.capability_ids = stored.capability_ids.clone();
    umbrella.optional_index_ids = stored.optional_index_ids.clone();
    assert!(vault
        .replace_extension_profiles(vec![stored.clone(), umbrella])
        .is_err());
    assert_eq!(
        vault.list_extension_profiles().unwrap(),
        vec![stored.clone()]
    );

    assert_eq!(
        vault
            .unregister_extension_profile("com.monica.mail".to_string())
            .unwrap(),
        Some(stored)
    );
    assert!(vault.list_extension_profiles().unwrap().is_empty());
}

#[test]
fn registered_extension_profile_constrains_collection_profile_writes() {
    let vault = ffi_test_vault();
    let mut mail = ffi_test_extension_profile("com.monica.mail");
    mail.object_type_ids = vec!["com.monica.mail.message".to_string()];
    mail.relation_kind_ids = vec!["com.monica.mail.reply-to".to_string()];
    mail.optional_index_ids = vec!["com.monica.mail.index.messages".to_string()];
    vault.register_extension_profile(mail).unwrap();
    vault
        .set_extension_capabilities(vec!["com.monica.mail.store".to_string()])
        .unwrap();
    let collection = vault.create_project("Mail".to_string()).unwrap();

    assert!(vault
        .set_collection_profile(
            collection.project_id.clone(),
            "com.monica.mail".to_string(),
            Vec::new(),
            1,
            vec!["com.monica.mail.folder".to_string()],
            vec!["com.monica.mail.store".to_string()],
        )
        .is_err());
    assert!(vault
        .get_collection_profile(collection.project_id.clone())
        .unwrap()
        .is_none());

    vault
        .set_collection_profile(
            collection.project_id,
            "com.monica.mail".to_string(),
            Vec::new(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.store".to_string()],
        )
        .unwrap();
}

#[test]
fn integrity_root_ffi_exposes_metadata_only_status_and_locked_inspection() {
    let path =
        std::env::temp_dir().join(format!("mdbx-ffi-integrity-root-{}.mdbx", Uuid::new_v4()));
    let path_string = path.to_string_lossy().into_owned();
    let vault = create_vault(
        path_string.clone(),
        "integrity-root-password".to_string(),
        "ffi-integrity-root-device".to_string(),
    )
    .unwrap();

    let disabled = vault.integrity_root_status().unwrap();
    assert_eq!(disabled.state, MdbxIntegrityRootState::Disabled);
    assert!(!disabled.authenticated);
    assert!(disabled.root_hash.is_none());

    let enabled = vault.enable_integrity_root().unwrap();
    assert_eq!(enabled.state, MdbxIntegrityRootState::Established);
    assert!(enabled.authenticated);
    assert_eq!(enabled.root_hash.as_ref().map(Vec::len), Some(32));
    let verified = vault.verify_integrity_root().unwrap();
    assert_eq!(verified.profile, "mdbx-authenticated-state-root-v1");
    assert_eq!(verified.root_hash.len(), 32);

    let rebuilt = vault.rebuild_integrity_root().unwrap();
    assert!(rebuilt.generation > enabled.generation);
    drop(vault);

    let locked = inspect_vault_integrity_root(path_string.clone()).unwrap();
    assert_eq!(locked.state, MdbxIntegrityRootState::Established);
    assert!(!locked.authenticated);
    assert_eq!(locked.root_hash.as_ref().map(Vec::len), Some(32));

    let reopened = open_vault(
        path_string,
        "integrity-root-password".to_string(),
        "ffi-integrity-root-device".to_string(),
    )
    .unwrap();
    assert!(reopened.integrity_root_status().unwrap().authenticated);
    drop(reopened);
    for suffix in ["", "-wal", "-shm"] {
        let candidate = std::path::PathBuf::from(format!("{}{}", path.display(), suffix));
        let _ = std::fs::remove_file(candidate);
    }
}

#[test]
fn integrity_root_checkpoint_ffi_authenticates_negotiates_and_roundtrips_wire() {
    let vault = ffi_test_vault();
    vault.enable_integrity_root().unwrap();
    let first = vault.create_integrity_root_checkpoint().unwrap();
    let verified = vault
        .verify_integrity_root_checkpoint(first.clone())
        .unwrap();
    assert_eq!(verified.root_hash, first.root_hash);

    vault
        .create_project("checkpoint advance".to_string())
        .unwrap();
    let advanced = vault.create_integrity_root_checkpoint().unwrap();
    assert_eq!(
        vault
            .compare_integrity_root_checkpoints(first.clone(), advanced.clone())
            .unwrap(),
        MdbxIntegrityRootCheckpointRelation::Advanced
    );
    assert!(vault
        .compare_integrity_root_checkpoints(advanced.clone(), first.clone())
        .is_err());

    let initiator =
        create_integrity_root_sync_session("root-initiator".to_string(), first.clone()).unwrap();
    let responder =
        create_integrity_root_sync_session("root-responder".to_string(), advanced.clone()).unwrap();
    let hello = initiator.hello().unwrap();
    assert_eq!(hello.authenticated_state_root, Some(first.clone()));

    let sender =
        create_sync_wire_session("root-wire".to_string(), default_sync_wire_payload_bytes())
            .unwrap();
    let receiver =
        create_sync_wire_session("root-wire".to_string(), default_sync_wire_payload_bytes())
            .unwrap();
    let bytes = sender
        .encode_integrity_root_hello(hello.clone(), None)
        .unwrap();
    let decoded = receiver.accept_integrity_root_hello(bytes).unwrap();
    assert_eq!(decoded.hello, hello);
    receiver.acknowledge_inbound(decoded.sequence).unwrap();

    let ack = responder.accept_hello(decoded.hello).unwrap();
    let ack_bytes = receiver
        .encode_integrity_root_hello_ack(ack, Some(decoded.sequence))
        .unwrap();
    let decoded_ack = sender.accept_integrity_root_hello_ack(ack_bytes).unwrap();
    assert_eq!(decoded_ack.in_reply_to, Some(decoded.sequence));
    sender.acknowledge_inbound(decoded_ack.sequence).unwrap();
    initiator.accept_hello_ack(decoded_ack.hello).unwrap();
    assert!(initiator.integrity_root_is_negotiated().unwrap());
    assert!(responder.integrity_root_is_negotiated().unwrap());
    assert_eq!(
        initiator.remote_integrity_root_checkpoint().unwrap(),
        Some(advanced.clone())
    );
    assert_eq!(
        responder.remote_integrity_root_checkpoint().unwrap(),
        Some(first.clone())
    );

    let mut tampered = advanced;
    tampered.authentication_tag[0] ^= 1;
    assert!(vault.verify_integrity_root_checkpoint(tampered).is_err());
}

#[test]
fn rollback_anchor_ffi_roundtrips_opaque_tokens_and_reports_advancement() {
    let vault = ffi_test_vault();
    let token = vault.create_rollback_anchor().unwrap();
    let equal = vault.verify_rollback_anchor(token.clone()).unwrap();
    assert!(!equal.advanced);
    assert_eq!(
        equal.anchored_commit_inventory_seq,
        equal.current_commit_inventory_seq
    );

    vault.create_project("After anchor".to_string()).unwrap();
    let advanced = vault.verify_rollback_anchor(token.clone()).unwrap();
    assert!(advanced.advanced);
    assert!(advanced.current_commit_inventory_seq > advanced.anchored_commit_inventory_seq);

    let mut tampered = token.clone();
    tampered[12] ^= 1;
    assert!(vault.verify_rollback_anchor(tampered).is_err());

    let foreign = ffi_test_vault();
    assert!(foreign.verify_rollback_anchor(token).is_err());
}

#[test]
fn content_manifest_ffi_roundtrips_and_rejects_stale_state() {
    let vault = ffi_test_vault();
    let token = vault.create_content_manifest().unwrap();
    let equal = vault.verify_content_manifest(token.clone()).unwrap();
    assert!(equal.table_count > 0);
    assert!(equal.row_count > 0);

    vault
        .create_project("Manifest FFI change".to_string())
        .unwrap();
    assert!(vault.verify_content_manifest(token).is_err());
    let replacement = vault.create_content_manifest().unwrap();
    assert!(vault.verify_content_manifest(replacement).is_ok());
}

#[test]
fn ffi_wire_session_roundtrips_blob_messages_and_sequences() {
    let limit = default_sync_wire_payload_bytes();
    let sender = create_sync_wire_session("wire-session".to_string(), limit).unwrap();
    let receiver = create_sync_wire_session("wire-session".to_string(), limit).unwrap();
    let blob_id = "a".repeat(64);
    let request = MdbxBlobChunkRequest {
        namespace_id: "source".to_string(),
        blob_id: blob_id.clone(),
        total_size: 8,
        offset: 0,
        max_bytes: 4,
    };
    let bytes = sender
        .encode_blob_chunk_request(request.clone(), None)
        .unwrap();
    let decoded = receiver.accept_blob_chunk_request(bytes.clone()).unwrap();
    assert_eq!(decoded.sequence, 1);
    assert_eq!(decoded.request, request);
    assert_eq!(receiver.pending_inbound_sequence().unwrap(), Some(1));
    receiver.acknowledge_inbound(1).unwrap();
    assert!(receiver.accept_blob_chunk_request(bytes).is_err());

    let response = MdbxBlobChunkResponse {
        namespace_id: "source".to_string(),
        blob_id,
        total_size: 8,
        offset: 0,
        ciphertext: vec![1, 2, 3, 4],
        is_last: false,
    };
    let response_bytes = sender
        .encode_blob_chunk_response(response.clone(), Some(decoded.sequence))
        .unwrap();
    let decoded_response = receiver.accept_blob_chunk_response(response_bytes).unwrap();
    assert_eq!(decoded_response.sequence, 2);
    assert_eq!(decoded_response.in_reply_to, Some(1));
    assert_eq!(decoded_response.response, response);
}

#[test]
fn ffi_wire_session_restores_sequence_state_and_rejects_wrong_types() {
    let limit = default_sync_wire_payload_bytes();
    let sender = create_sync_wire_session("wire-session".to_string(), limit).unwrap();
    let receiver = create_sync_wire_session("wire-session".to_string(), limit).unwrap();
    let hello = MdbxSyncHello {
        device_id: "device-a".to_string(),
        protocol_version: 2,
        heads: Vec::new(),
        known_commit_ids: Vec::new(),
        capabilities: Vec::new(),
    };
    let hello_bytes = sender.encode_hello(hello.clone(), None).unwrap();
    let decoded = receiver.accept_hello(hello_bytes).unwrap();
    assert_eq!(decoded.hello, hello);
    receiver.acknowledge_inbound(decoded.sequence).unwrap();
    let resume = receiver.resume().unwrap();
    let encoded_resume = serde_json::to_vec(&resume).unwrap();
    let restored: MdbxSyncWireResume = serde_json::from_slice(&encoded_resume).unwrap();
    let restarted = create_sync_wire_session("wire-session".to_string(), limit).unwrap();
    restarted.restore_resume(restored).unwrap();
    assert_eq!(restarted.resume().unwrap().next_inbound_sequence, 2);

    let response = MdbxBlobChunkResponse {
        namespace_id: "source".to_string(),
        blob_id: "b".repeat(64),
        total_size: 4,
        offset: 0,
        ciphertext: vec![8, 9, 10, 11],
        is_last: true,
    };
    let response_bytes = sender
        .encode_blob_chunk_response(response, Some(decoded.sequence))
        .unwrap();
    assert!(restarted.accept_blob_chunk_request(response_bytes).is_err());
    assert_eq!(restarted.pending_inbound_sequence().unwrap(), None);
}

#[test]
fn ffi_blob_sync_session_negotiates_and_advances_only_after_ack() {
    let local = create_blob_sync_session("ffi-local".to_string()).unwrap();
    let remote = create_blob_sync_session("ffi-remote".to_string()).unwrap();
    local
        .begin_blob_sync("source-namespace".to_string())
        .unwrap();
    let hello = local.hello().unwrap();
    assert_eq!(hello.capabilities.len(), 3);
    let ack = remote.accept_hello(hello).unwrap();
    local.accept_hello_ack(ack).unwrap();
    assert!(local.blob_replication_is_negotiated().unwrap());
    assert_eq!(
        local.blob_sync_phase().unwrap(),
        MdbxBlobSyncPhase::Manifest
    );

    let blob_id = "a".repeat(64);
    local.blob_manifest_request(8).unwrap();
    let manifest = MdbxBlobManifestPageResponse {
        namespace_id: "source-namespace".to_string(),
        checkpoint: "checkpoint".to_string(),
        items: vec![MdbxBlobManifestEntry {
            blob_id: blob_id.clone(),
            total_size: Some(8),
            state: MdbxBlobManifestEntryState::Available,
        }],
        next_cursor: None,
    };
    local
        .validate_blob_manifest_response(manifest.clone())
        .unwrap();
    assert!(local
        .blob_resume()
        .unwrap()
        .unwrap()
        .manifest_checkpoint
        .is_none());

    let first_request = local.blob_chunk_request(blob_id.clone(), 8, 4).unwrap();
    let first = MdbxBlobChunkResponse {
        namespace_id: "source-namespace".to_string(),
        blob_id: blob_id.clone(),
        total_size: 8,
        offset: first_request.offset,
        ciphertext: vec![1, 2, 3, 4],
        is_last: false,
    };
    local.validate_blob_chunk_response(first.clone()).unwrap();
    assert_eq!(local.blob_resume().unwrap().unwrap().next_durable_offset, 0);
    local.acknowledge_blob_chunk(first).unwrap();
    assert_eq!(local.blob_resume().unwrap().unwrap().next_durable_offset, 4);

    let second_request = local.blob_chunk_request(blob_id.clone(), 8, 4).unwrap();
    let second = MdbxBlobChunkResponse {
        namespace_id: "source-namespace".to_string(),
        blob_id,
        total_size: 8,
        offset: second_request.offset,
        ciphertext: vec![5, 6, 7, 8],
        is_last: true,
    };
    local.acknowledge_blob_chunk(second).unwrap();
    local.acknowledge_blob_manifest_page(manifest).unwrap();
    assert_eq!(
        local.blob_sync_phase().unwrap(),
        MdbxBlobSyncPhase::Complete
    );
}

#[test]
fn ffi_blob_sync_session_restores_resume_and_rejects_partial_negotiation() {
    let local = create_blob_sync_session("ffi-local".to_string()).unwrap();
    let remote = create_blob_sync_session("ffi-remote".to_string()).unwrap();
    local
        .begin_blob_sync("source-namespace".to_string())
        .unwrap();
    let hello = local.hello().unwrap();
    let mut ack = remote.accept_hello(hello).unwrap();
    ack.capabilities.pop();
    local.accept_hello_ack(ack).unwrap();
    assert!(!local.blob_replication_is_negotiated().unwrap());
    assert!(matches!(
        local.blob_manifest_request(1),
        Err(MdbxFfiError::SyncProtocol { .. })
    ));

    let restored = MdbxBlobSyncResume {
        namespace_id: "source-namespace".to_string(),
        manifest_checkpoint: Some("checkpoint".to_string()),
        manifest_cursor: None,
        current_blob_id: Some("b".repeat(64)),
        total_size: 8,
        next_durable_offset: 4,
        manifest_complete: false,
    };
    let resumed = create_blob_sync_session("ffi-resumed".to_string()).unwrap();
    let peer = create_blob_sync_session("ffi-peer".to_string()).unwrap();
    resumed
        .begin_blob_sync("source-namespace".to_string())
        .unwrap();
    let hello = resumed.hello().unwrap();
    let ack = peer.accept_hello(hello).unwrap();
    resumed.accept_hello_ack(ack).unwrap();
    resumed.restore_blob_sync(restored.clone()).unwrap();
    assert_eq!(resumed.blob_resume().unwrap().unwrap(), restored);
}

#[test]
fn ffi_incremental_segment_files_are_authenticated_atomic_and_idempotent() {
    const PASSWORD: &str = "ffi-incremental-password";

    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source.mdbx");
    let target_path = directory.path().join("target.mdbx");
    let bootstrap_segment_path = directory.path().join("bootstrap-pending.mdbxsync");
    let segment_path = directory.path().join("pending.mdbxsync");
    let tampered_path = directory.path().join("tampered.mdbxsync");
    let source = create_vault(
        source_path.to_string_lossy().into_owned(),
        PASSWORD.to_string(),
        "source-device".to_string(),
    )
    .unwrap();
    let bootstrap = source
        .create_incremental_sync_bootstrap(target_path.to_string_lossy().into_owned())
        .unwrap();
    source
        .create_project("Incremental project".to_string())
        .unwrap();
    let bootstrap_segment = source
        .export_incremental_sync_segment(
            bootstrap_segment_path.to_string_lossy().into_owned(),
            MdbxIncrementalSyncCheckpoint {
                commit_inventory: String::new(),
                delta_inventory: String::new(),
            },
            None,
            128,
        )
        .unwrap();
    assert_eq!(bootstrap_segment.segment_index, 0);
    assert!(bootstrap_segment.is_last);
    let exported = source
        .export_incremental_sync_segment(
            segment_path.to_string_lossy().into_owned(),
            bootstrap.checkpoint.clone(),
            None,
            128,
        )
        .unwrap();
    assert!(segment_path.is_file());
    assert_eq!(exported.segment_index, 0);
    assert_eq!(exported.payload_sha256.len(), 32);
    assert_eq!(
        source
            .inspect_incremental_sync_segment(segment_path.to_string_lossy().into_owned())
            .unwrap(),
        exported
    );

    let original_bytes = std::fs::read(&segment_path).unwrap();
    assert!(source
        .export_incremental_sync_segment(
            segment_path.to_string_lossy().into_owned(),
            bootstrap.checkpoint.clone(),
            None,
            128,
        )
        .is_err());
    assert_eq!(std::fs::read(&segment_path).unwrap(), original_bytes);

    let mut tampered = original_bytes.clone();
    let middle = tampered.len() / 2;
    tampered[middle] ^= 0x40;
    std::fs::write(&tampered_path, tampered).unwrap();
    assert!(source
        .inspect_incremental_sync_segment(tampered_path.to_string_lossy().into_owned())
        .is_err());

    let target = open_vault(
        target_path.to_string_lossy().into_owned(),
        PASSWORD.to_string(),
        "target-device".to_string(),
    )
    .unwrap();
    let applied = target
        .apply_incremental_sync_segment(
            bootstrap_segment_path.to_string_lossy().into_owned(),
            MdbxIncrementalSyncCheckpoint {
                commit_inventory: String::new(),
                delta_inventory: String::new(),
            },
            None,
        )
        .unwrap();
    assert!(applied.applied_commits > 0);
    assert!(target
        .list_collection_summaries(100, None)
        .unwrap()
        .items
        .iter()
        .any(|item| item.title == "Incremental project"));
    let replay = target
        .apply_incremental_sync_segment(
            segment_path.to_string_lossy().into_owned(),
            bootstrap.checkpoint,
            None,
        )
        .unwrap();
    assert_eq!(replay.applied_commits, 0);
    assert!(replay.skipped_commits > 0);
}

#[test]
fn ffi_external_blob_transfer_pages_chunks_resumes_and_aborts() {
    const PASSWORD: &str = "ffi-blob-transfer-password";

    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("blob-source.mdbx");
    let target_path = directory.path().join("blob-target.mdbx");
    let source = create_vault(
        source_path.to_string_lossy().into_owned(),
        PASSWORD.to_string(),
        "blob-source-device".to_string(),
    )
    .unwrap();
    source
        .create_incremental_sync_bootstrap(target_path.to_string_lossy().into_owned())
        .unwrap();
    let project = source.create_project("Blob project".to_string()).unwrap();
    source
        .create_attachment_with_external_content(
            Uuid::new_v4().to_string(),
            MdbxAttachmentCreateRequest {
                attachment_id: Uuid::new_v4().to_string(),
                project_id: project.project_id,
                entry_id: None,
                file_name: "blob.bin".to_string(),
                media_type: None,
            },
            b"bounded encrypted Blob transfer".to_vec(),
            MdbxAttachmentContentLimits {
                chunk_size: 8,
                max_plaintext_bytes: 1024,
            },
        )
        .unwrap();
    let page = source.list_external_blob_references(None, 100).unwrap();
    assert!(page.raw_reference_count > 0);
    assert!(!page.items.is_empty());
    assert!(page
        .items
        .iter()
        .all(|item| item.state == MdbxExternalBlobState::Available));

    let target = open_vault(
        target_path.to_string_lossy().into_owned(),
        PASSWORD.to_string(),
        "blob-target-device".to_string(),
    )
    .unwrap();
    for reference in page.items {
        let total_size = reference.total_size.unwrap();
        let owner = format!("transfer-{}", reference.blob_id);
        target
            .acquire_external_blob_lease(reference.blob_id.clone(), owner.clone(), 1_000, 60)
            .unwrap();
        let mut offset = 0;
        while offset < total_size {
            let chunk = source
                .read_external_blob_chunk(reference.blob_id.clone(), total_size, offset, 5)
                .unwrap();
            target
                .write_external_blob_chunk(
                    chunk.blob_id,
                    chunk.total_size,
                    chunk.offset,
                    chunk.ciphertext.clone(),
                    chunk.is_last,
                )
                .unwrap();
            offset += chunk.ciphertext.len() as u64;
        }
        target
            .release_external_blob_lease(reference.blob_id.clone(), owner)
            .unwrap();
        assert!(target
            .has_external_blob(reference.blob_id, total_size)
            .unwrap());
    }

    let abandoned = b"abandoned transfer bytes";
    let abandoned_id = format!("{:x}", Sha256::digest(abandoned));
    target
        .acquire_external_blob_lease(
            abandoned_id.clone(),
            "abandoned-owner".to_string(),
            2_000,
            60,
        )
        .unwrap();
    target
        .write_external_blob_chunk(
            abandoned_id.clone(),
            abandoned.len() as u64,
            0,
            abandoned[..5].to_vec(),
            false,
        )
        .unwrap();
    target
        .abort_external_blob_transfer(abandoned_id.clone(), "abandoned-owner".to_string())
        .unwrap();
    assert!(!target
        .has_external_blob(abandoned_id, abandoned.len() as u64)
        .unwrap());
}

#[test]
fn attachment_tiga_scope_roundtrips_through_ffi_types() {
    let core = MdbxTigaScope {
        scope_type: MdbxTigaScopeType::Attachment,
        scope_id: Some("attachment-1".to_string()),
    }
    .into_core()
    .unwrap();
    assert_eq!(
        core,
        TigaScope::Attachment {
            attachment_id: "attachment-1".to_string()
        }
    );
    assert_eq!(
        scope_from_core(core),
        MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Attachment,
            scope_id: Some("attachment-1".to_string())
        }
    );
}

#[test]
fn attachment_facade_roundtrips_and_coalesces_content_commits() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Steam".to_string()).unwrap();
    let attachment_id = Uuid::new_v4().to_string();
    let operation_id = Uuid::new_v4().to_string();
    let limits = MdbxAttachmentContentLimits {
        chunk_size: 3,
        max_plaintext_bytes: 64,
    };
    let commits_before = ffi_test_count(&vault, "commits");

    let created = vault
        .create_attachment_with_content(
            operation_id.clone(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: project.project_id.clone(),
                entry_id: None,
                file_name: "account.maFile".to_string(),
                media_type: Some("application/json".to_string()),
            },
            b"mafile".to_vec(),
            limits,
        )
        .unwrap();
    assert!(!created.already_committed);
    assert_eq!(created.attachment.attachment_id, attachment_id);
    assert_eq!(created.attachment.chunk_count, 2);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);
    assert_eq!(
        vault
            .read_attachment_content(attachment_id.clone(), 64)
            .unwrap(),
        b"mafile"
    );

    let retried = vault
        .create_attachment_with_content(
            operation_id.clone(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: project.project_id.clone(),
                entry_id: None,
                file_name: "account.maFile".to_string(),
                media_type: Some("application/json".to_string()),
            },
            b"mafile".to_vec(),
            limits,
        )
        .unwrap();
    assert!(retried.already_committed);
    assert_eq!(retried.commit_id, created.commit_id);
    assert!(vault
        .create_attachment_with_content(
            operation_id,
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: project.project_id.clone(),
                entry_id: None,
                file_name: "account.maFile".to_string(),
                media_type: Some("application/json".to_string()),
            },
            b"different".to_vec(),
            limits,
        )
        .is_err());
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);

    let original_hash = created.attachment.content_hash;
    let replaced = vault
        .replace_attachment_content(
            Uuid::new_v4().to_string(),
            attachment_id.clone(),
            b"mail-body".to_vec(),
            limits,
        )
        .unwrap();
    assert_ne!(replaced.attachment.content_hash, original_hash);
    let renamed = vault
        .rename_attachment(
            attachment_id.clone(),
            "message.eml".to_string(),
            Some("message/rfc822".to_string()),
        )
        .unwrap();
    assert_eq!(renamed.content_hash, replaced.attachment.content_hash);
    assert_eq!(renamed.file_name, "message.eml");
    assert_eq!(
        vault
            .list_attachments(project.project_id, None)
            .unwrap()
            .len(),
        1
    );

    vault.delete_attachment(attachment_id.clone()).unwrap();
    assert!(
        vault
            .get_attachment(attachment_id.clone())
            .unwrap()
            .unwrap()
            .deleted
    );
    assert!(vault
        .list_deleted_attachments()
        .unwrap()
        .iter()
        .any(|attachment| attachment.attachment_id == attachment_id));
}

#[test]
fn attachment_summary_facade_pages_without_chunk_reads_and_binds_cursors() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail summaries".to_string()).unwrap();
    let other_project = vault.create_project("Other summaries".to_string()).unwrap();
    let object = vault
        .create_object(
            project.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Message".to_string(),
            "{}".to_string(),
            1,
        )
        .unwrap();

    let mut attachment_ids = Vec::new();
    for index in 0..3 {
        let attachment_id = Uuid::new_v4().to_string();
        vault
            .create_attachment_with_content(
                Uuid::new_v4().to_string(),
                MdbxAttachmentCreateRequest {
                    attachment_id: attachment_id.clone(),
                    project_id: project.project_id.clone(),
                    entry_id: Some(object.object_id.clone()),
                    file_name: format!("message-{index}.eml"),
                    media_type: Some("message/rfc822".to_string()),
                },
                b"mail body".to_vec(),
                MdbxAttachmentContentLimits {
                    chunk_size: 4,
                    max_plaintext_bytes: 64,
                },
            )
            .unwrap();
        attachment_ids.push(attachment_id);
    }

    let limits = default_attachment_presentation_limits();
    assert_eq!(limits.max_file_name_bytes, 4096);
    assert_eq!(limits.max_media_type_bytes, 512);
    assert_eq!(limits.ciphertext_envelope_allowance_bytes, 128 * 1024);
    assert_eq!(limits.max_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);

    let first = vault
        .list_attachment_summaries(
            project.project_id.clone(),
            Some(object.object_id.clone()),
            1,
            None,
        )
        .unwrap();
    assert_eq!(first.items.len(), 1);
    let cursor = first.next_cursor.clone().unwrap();
    assert!(vault
        .list_attachment_summaries(other_project.project_id, None, 1, Some(cursor.clone()))
        .is_err());
    assert!(vault
        .list_deleted_attachment_summaries(1, Some(cursor))
        .is_err());

    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = X'00' WHERE attachment_id = ?1",
                [&attachment_ids[0]],
            )
            .unwrap();
    }

    let mut cursor = None;
    let mut summaries = Vec::new();
    loop {
        let page = vault
            .list_attachment_summaries(
                project.project_id.clone(),
                Some(object.object_id.clone()),
                2,
                cursor.clone(),
            )
            .unwrap();
        summaries.extend(page.items);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    assert_eq!(summaries.len(), attachment_ids.len());
    assert!(summaries
        .iter()
        .all(|summary| summary.file_name.ends_with(".eml")));
    assert!(summaries
        .iter()
        .all(|summary| summary.object_id.as_deref() == Some(object.object_id.as_str())));

    vault.delete_attachment(attachment_ids[0].clone()).unwrap();
    let deleted = vault.list_deleted_attachment_summaries(10, None).unwrap();
    assert!(deleted
        .items
        .iter()
        .any(|summary| summary.attachment_id == attachment_ids[0] && summary.deleted));
    let by_id = vault
        .get_attachment_summary(attachment_ids[0].clone())
        .unwrap()
        .unwrap();
    assert!(by_id.deleted);
}

#[test]
fn attachment_batch_is_atomic_idempotent_and_mixes_content_metadata() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail".to_string()).unwrap();
    let first_id = Uuid::new_v4().to_string();
    let second_id = Uuid::new_v4().to_string();
    let operation_id = Uuid::new_v4().to_string();
    let limits = MdbxAttachmentBatchLimits {
        max_commands: 4,
        max_plaintext_bytes_per_command: 64,
        max_plaintext_bytes: 64,
        chunk_size: 3,
    };
    let commands = vec![
        MdbxAttachmentBatchCommand::Create {
            attachment_id: first_id.clone(),
            project_id: project.project_id.clone(),
            entry_id: None,
            file_name: "first.bin".to_string(),
            media_type: Some("application/octet-stream".to_string()),
            content: b"first-content".to_vec(),
        },
        MdbxAttachmentBatchCommand::Create {
            attachment_id: second_id.clone(),
            project_id: project.project_id,
            entry_id: None,
            file_name: "second.bin".to_string(),
            media_type: None,
            content: b"second-content".to_vec(),
        },
        MdbxAttachmentBatchCommand::Rename {
            attachment_id: first_id.clone(),
            file_name: "renamed.bin".to_string(),
            media_type: Some("application/custom".to_string()),
        },
        MdbxAttachmentBatchCommand::Replace {
            attachment_id: second_id.clone(),
            content: b"replacement".to_vec(),
        },
    ];
    let commits_before = ffi_test_count(&vault, "commits");
    let first = vault
        .execute_attachment_batch_with_limits(operation_id.clone(), commands.clone(), limits)
        .unwrap();
    assert!(!first.already_committed);
    assert_eq!(first.attachments.len(), 2);
    assert_eq!(first.attachments[0].attachment_id, first_id);
    assert_eq!(first.attachments[0].file_name, "renamed.bin");
    assert_eq!(first.attachments[1].attachment_id, second_id);
    assert_eq!(first.attachments[1].original_size, 14);
    assert_eq!(first.attachments[1].stored_size, 11);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);
    assert_eq!(
        vault
            .read_attachment_content(first.attachments[0].attachment_id.clone(), 64)
            .unwrap(),
        b"first-content"
    );
    assert_eq!(
        vault
            .read_attachment_content(first.attachments[1].attachment_id.clone(), 64)
            .unwrap(),
        b"replacement"
    );

    let retry = vault
        .execute_attachment_batch_with_limits(operation_id.clone(), commands.clone(), limits)
        .unwrap();
    assert!(retry.already_committed);
    assert_eq!(retry.commit_id, first.commit_id);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);

    let mut changed_commands = commands;
    if let MdbxAttachmentBatchCommand::Replace { content, .. } = &mut changed_commands[3] {
        *content = b"different-content".to_vec();
    }
    assert!(vault
        .execute_attachment_batch_with_limits(operation_id, changed_commands, limits,)
        .unwrap_err()
        .to_string()
        .contains("reused for a different operation"));

    let deleted = vault
        .execute_attachment_batch_with_limits(
            Uuid::new_v4().to_string(),
            vec![
                MdbxAttachmentBatchCommand::Delete {
                    attachment_id: first.attachments[0].attachment_id.clone(),
                },
                MdbxAttachmentBatchCommand::Replace {
                    attachment_id: first.attachments[1].attachment_id.clone(),
                    content: b"final".to_vec(),
                },
            ],
            limits,
        )
        .unwrap();
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 2);
    assert!(deleted.attachments[0].deleted);
    assert_eq!(
        vault
            .read_attachment_content(first.attachments[1].attachment_id.clone(), 64)
            .unwrap(),
        b"final"
    );
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = zeroblob(length(chunk_ct))
                     WHERE attachment_id = ?1 AND chunk_index = 0",
                [&first.attachments[1].attachment_id],
            )
            .unwrap();
    }
    assert!(!vault
        .verify_attachment_integrity(first.attachments[1].attachment_id.clone())
        .unwrap());
    assert!(vault
        .read_attachment_content(first.attachments[1].attachment_id.clone(), 64)
        .is_err());
}

#[test]
fn attachment_batch_rejects_partial_failures_bounds_and_missing_capability() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail".to_string()).unwrap();
    let commits_before = ffi_test_count(&vault, "commits");
    let attachments_before = ffi_test_count(&vault, "attachments");
    assert!(vault
        .execute_attachment_batch(
            Uuid::new_v4().to_string(),
            vec![
                MdbxAttachmentBatchCommand::Create {
                    attachment_id: Uuid::new_v4().to_string(),
                    project_id: project.project_id.clone(),
                    entry_id: None,
                    file_name: "rolled-back.bin".to_string(),
                    media_type: None,
                    content: b"content".to_vec(),
                },
                MdbxAttachmentBatchCommand::Delete {
                    attachment_id: Uuid::new_v4().to_string(),
                },
            ],
        )
        .is_err());
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before);
    assert_eq!(ffi_test_count(&vault, "attachments"), attachments_before);

    let small_limits = MdbxAttachmentBatchLimits {
        max_commands: 2,
        max_plaintext_bytes_per_command: 4,
        max_plaintext_bytes: 8,
        chunk_size: 2,
    };
    assert!(vault
        .execute_attachment_batch_with_limits(
            Uuid::new_v4().to_string(),
            vec![MdbxAttachmentBatchCommand::Create {
                attachment_id: Uuid::new_v4().to_string(),
                project_id: project.project_id.clone(),
                entry_id: None,
                file_name: "oversized.bin".to_string(),
                media_type: None,
                content: b"12345".to_vec(),
            }],
            small_limits,
        )
        .unwrap_err()
        .to_string()
        .contains("command plaintext bytes"));
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before);

    vault
        .set_extension_capabilities(vec!["com.monica.mail.store".to_string()])
        .unwrap();
    vault
        .set_collection_profile(
            project.project_id.clone(),
            "com.monica.mail".to_string(),
            b"profile".to_vec(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.store".to_string()],
        )
        .unwrap();
    vault.set_extension_capabilities(Vec::new()).unwrap();
    let commits_before_capability_failure = ffi_test_count(&vault, "commits");
    assert!(vault
        .execute_attachment_batch(
            Uuid::new_v4().to_string(),
            vec![MdbxAttachmentBatchCommand::Create {
                attachment_id: Uuid::new_v4().to_string(),
                project_id: project.project_id,
                entry_id: None,
                file_name: "blocked.bin".to_string(),
                media_type: None,
                content: b"content".to_vec(),
            }],
        )
        .is_err());
    assert_eq!(
        ffi_test_count(&vault, "commits"),
        commits_before_capability_failure
    );
    assert_eq!(ffi_test_count(&vault, "attachments"), attachments_before);
}

#[test]
fn attachment_facade_rejects_oversized_content_without_side_effects() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail".to_string()).unwrap();
    let commits_before = ffi_test_count(&vault, "commits");
    let attachments_before = ffi_test_count(&vault, "attachments");
    let result = vault.create_attachment_with_content(
        Uuid::new_v4().to_string(),
        MdbxAttachmentCreateRequest {
            attachment_id: Uuid::new_v4().to_string(),
            project_id: project.project_id,
            entry_id: None,
            file_name: "large.eml".to_string(),
            media_type: Some("message/rfc822".to_string()),
        },
        vec![0; 5],
        MdbxAttachmentContentLimits {
            chunk_size: 2,
            max_plaintext_bytes: 4,
        },
    );
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("attachment plaintext bytes"));
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before);
    assert_eq!(ffi_test_count(&vault, "attachments"), attachments_before);
}

#[test]
fn external_attachment_facade_accepts_hard_max_content_with_bounded_sync_delta() {
    const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;
    const CHUNK_SIZE: u64 = 256 * 1024;
    const PASSWORD: &str = "external-boundary-password";

    let directory = tempfile::tempdir().unwrap();
    let vault_path = directory.path().join("external-boundary.mdbx");
    let vault = create_vault(
        vault_path.to_string_lossy().into_owned(),
        PASSWORD.to_string(),
        "external-boundary-device".to_string(),
    )
    .unwrap();
    let project = vault
        .create_project("Boundary attachment".to_string())
        .unwrap();
    let attachment_id = Uuid::new_v4().to_string();
    let created = vault
        .create_attachment_with_external_content(
            Uuid::new_v4().to_string(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: project.project_id,
                entry_id: None,
                file_name: "exact-64-mib.bin".to_string(),
                media_type: Some("application/octet-stream".to_string()),
            },
            vec![0; MAX_ATTACHMENT_BYTES],
            MdbxAttachmentContentLimits {
                chunk_size: CHUNK_SIZE,
                max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
            },
        )
        .unwrap();

    assert_eq!(
        created.attachment.original_size,
        MAX_ATTACHMENT_BYTES as u64
    );
    assert_eq!(created.attachment.stored_size, MAX_ATTACHMENT_BYTES as u64);
    assert_eq!(created.attachment.chunk_count, 256);
    assert_eq!(created.attachment.storage_mode, "external-hash-ref");
    let delta_payload_bytes: i64 = vault
        .conn
        .lock()
        .unwrap()
        .inner()
        .query_row(
            "SELECT length(payload) FROM sync_delta_batches ORDER BY batch_seq DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(delta_payload_bytes < 16 * 1024 * 1024);
    assert!(std::path::PathBuf::from(format!("{}.blobs", vault_path.display())).is_dir());
    assert_eq!(
        vault
            .read_attachment_content(attachment_id.clone(), MAX_ATTACHMENT_BYTES as u64)
            .unwrap()
            .len(),
        MAX_ATTACHMENT_BYTES
    );
    assert!(vault
        .verify_attachment_integrity(attachment_id.clone())
        .unwrap());

    drop(vault);
    let reopened = open_vault(
        vault_path.to_string_lossy().into_owned(),
        PASSWORD.to_string(),
        "external-boundary-reopen".to_string(),
    )
    .unwrap();
    assert_eq!(
        reopened
            .read_attachment_content(attachment_id.clone(), MAX_ATTACHMENT_BYTES as u64)
            .unwrap()
            .len(),
        MAX_ATTACHMENT_BYTES
    );

    let replacement = b"replacement content".to_vec();
    reopened
        .replace_attachment_external_content(
            Uuid::new_v4().to_string(),
            attachment_id.clone(),
            replacement.clone(),
            MdbxAttachmentContentLimits {
                chunk_size: CHUNK_SIZE,
                max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
            },
        )
        .unwrap();
    assert_eq!(
        reopened
            .read_attachment_content(attachment_id, MAX_ATTACHMENT_BYTES as u64)
            .unwrap(),
        replacement
    );
}

#[test]
fn attachment_facade_enforces_stream_limits_and_detects_tampering() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail".to_string()).unwrap();
    let attachment_id = Uuid::new_v4().to_string();
    vault
        .create_attachment_with_content(
            Uuid::new_v4().to_string(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: project.project_id,
                entry_id: None,
                file_name: "message.eml".to_string(),
                media_type: None,
            },
            b"123456".to_vec(),
            MdbxAttachmentContentLimits {
                chunk_size: 3,
                max_plaintext_bytes: 64,
            },
        )
        .unwrap();
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE attachments SET stored_size = 1 WHERE attachment_id = ?1",
                [&attachment_id],
            )
            .unwrap();
    }
    let limit_error = vault
        .read_attachment_content(attachment_id.clone(), 4)
        .unwrap_err();
    assert!(
        limit_error
            .to_string()
            .contains("attachment stored size mismatch"),
        "unexpected error: {limit_error}"
    );
    let mut limited = LimitedAttachmentContentWriter::new(4);
    limited.write_all(b"123").unwrap();
    assert!(limited.write_all(b"456").is_err());
    assert_eq!(limited.bytes, b"123");
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE attachments SET stored_size = 6 WHERE attachment_id = ?1",
                [&attachment_id],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE attachment_chunks SET chunk_ct = zeroblob(length(chunk_ct))
                     WHERE attachment_id = ?1 AND chunk_index = 0",
                [&attachment_id],
            )
            .unwrap();
    }
    assert!(vault
        .read_attachment_content(attachment_id.clone(), 64)
        .is_err());
    assert!(!vault.verify_attachment_integrity(attachment_id).unwrap());
}

#[test]
fn attachment_facade_honors_collection_capability_trimming() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail".to_string()).unwrap();
    vault
        .set_extension_capabilities(vec!["com.monica.mail.store".to_string()])
        .unwrap();
    vault
        .set_collection_profile(
            project.project_id.clone(),
            "com.monica.mail".to_string(),
            b"profile".to_vec(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.store".to_string()],
        )
        .unwrap();
    vault.set_extension_capabilities(Vec::new()).unwrap();
    let commits_before = ffi_test_count(&vault, "commits");

    assert!(vault
        .create_attachment_with_content(
            Uuid::new_v4().to_string(),
            MdbxAttachmentCreateRequest {
                attachment_id: Uuid::new_v4().to_string(),
                project_id: project.project_id,
                entry_id: None,
                file_name: "blocked.eml".to_string(),
                media_type: None,
            },
            b"content".to_vec(),
            default_attachment_content_limits(),
        )
        .is_err());
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before);
    assert_eq!(ffi_test_count(&vault, "attachments"), 0);
}

#[test]
fn collection_summary_ffi_discovers_profiles_pages_tombstones_and_limits() {
    let vault = ffi_test_vault();
    let first = vault.create_project("Mail".to_string()).unwrap();
    let second = vault.create_project("Bookmarks".to_string()).unwrap();
    vault
        .set_collection_profile(
            first.project_id.clone(),
            "com.monica.mail".to_string(),
            b"secret profile payload".to_vec(),
            7,
            Vec::new(),
            Vec::new(),
        )
        .unwrap();

    let limits = default_presentation_metadata_limits();
    assert_eq!(limits.max_title_bytes, 64 * 1024);
    assert_eq!(limits.max_label_name_bytes, 512);
    assert_eq!(limits.max_reference_bytes, 4096);
    assert_eq!(limits.max_collection_summary_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);

    let first_page = vault.list_collection_summaries(1, None).unwrap();
    assert_eq!(first_page.items.len(), 1);
    let active_cursor = first_page.next_cursor.clone().unwrap();
    let second_page = vault
        .list_collection_summaries(1, Some(active_cursor.clone()))
        .unwrap();
    assert_eq!(second_page.items.len(), 1);
    let mut discovered = vec![
        first_page.items[0].collection_id.clone(),
        second_page.items[0].collection_id.clone(),
    ];
    discovered.sort();
    let mut expected = vec![first.project_id.clone(), second.project_id.clone()];
    expected.sort();
    assert_eq!(discovered, expected);

    let summary = vault
        .get_collection_summary(first.project_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(summary.title, "Mail");
    assert_eq!(
        summary.collection_type_id.as_deref(),
        Some("com.monica.mail")
    );
    assert_eq!(summary.profile_schema_version, Some(7));

    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE collection_profiles SET payload_ct = X'00' WHERE project_id = ?1",
                [&first.project_id],
            )
            .unwrap();
        ProjectRepo::soft_delete(
            &conn,
            &CommitContext::new("ffi-collection-summary-delete".to_string()),
            &second.project_id,
        )
        .unwrap();
    }

    assert_eq!(
        vault
            .get_collection_summary(first.project_id)
            .unwrap()
            .unwrap()
            .title,
        "Mail"
    );
    let deleted = vault.list_deleted_collection_summaries(10, None).unwrap();
    assert_eq!(deleted.items.len(), 1);
    assert_eq!(deleted.items[0].collection_id, second.project_id);
    assert!(deleted.items[0].deleted);
    assert!(vault
        .list_deleted_collection_summaries(1, Some(active_cursor))
        .is_err());
    assert!(vault.list_collection_summaries(0, None).is_err());
}

#[test]
fn collection_profile_facade_registers_capabilities_and_guards_object_types() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-profile-device".to_string(),
        vault_id: "ffi-profile-vault".to_string(),
    };
    let collection = vault.create_project("Mail".to_string()).unwrap();
    vault
        .set_extension_capabilities(vec!["com.monica.mail.store".to_string()])
        .unwrap();
    let profile = vault
        .set_collection_profile(
            collection.project_id.clone(),
            "com.monica.mail".to_string(),
            b"opaque-profile".to_vec(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.store".to_string()],
        )
        .unwrap();
    assert_eq!(profile.collection_type_id, "com.monica.mail");
    assert_eq!(
        vault
            .get_collection_profile(collection.project_id.clone())
            .unwrap()
            .unwrap()
            .payload,
        b"opaque-profile"
    );

    vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Message".to_string(),
            r#"{"body":"hello"}"#.to_string(),
            1,
        )
        .unwrap();
    assert!(vault
        .create_object(
            collection.project_id,
            "login".to_string(),
            "Login".to_string(),
            "{}".to_string(),
            1,
        )
        .is_err());
}

#[test]
fn ffi_object_summary_by_id_is_payload_free_and_tombstone_visible() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Summary collection".to_string())
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Visible subject".to_string(),
            r#"{"body":"secret body"}"#.to_string(),
            3,
        )
        .unwrap();
    vault
        .delete_entry(collection.project_id.clone(), object.object_id.clone())
        .unwrap();
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00' WHERE entry_id = ?1",
                [&object.object_id],
            )
            .unwrap();
    }

    let summary = vault
        .get_object_summary(object.object_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(summary.object_id, object.object_id);
    assert_eq!(summary.collection_id, collection.project_id);
    assert_eq!(summary.object_type_id, "com.monica.mail.message");
    assert_eq!(summary.title, "Visible subject");
    assert_eq!(summary.payload_schema_version, 3);
    assert!(summary.deleted);

    assert!(vault
        .get_object(summary.collection_id, summary.object_id)
        .is_err());
}

#[test]
fn ffi_deleted_object_summary_pages_are_bounded_and_query_bound() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Deleted summary collection".to_string())
        .unwrap();
    let other_collection = vault
        .create_project("Other deleted summary collection".to_string())
        .unwrap();
    let object_type = "com.monica.mail.message".to_string();
    let mut deleted_ids = Vec::new();
    for index in 0..3 {
        let object = vault
            .create_object(
                collection.project_id.clone(),
                object_type.clone(),
                format!("Deleted {index}"),
                format!(r#"{{"body":"secret {index}"}}"#),
                5,
            )
            .unwrap();
        vault
            .delete_entry(collection.project_id.clone(), object.object_id.clone())
            .unwrap();
        deleted_ids.push(object.object_id);
    }
    let other_object = vault
        .create_object(
            other_collection.project_id.clone(),
            object_type.clone(),
            "Other deleted".to_string(),
            r#"{"body":"other secret"}"#.to_string(),
            6,
        )
        .unwrap();
    vault
        .delete_entry(
            other_collection.project_id.clone(),
            other_object.object_id.clone(),
        )
        .unwrap();

    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = X'00', updated_at = '2026-07-25T00:00:00Z'",
                [],
            )
            .unwrap();
    }

    let first = vault
        .list_deleted_object_summaries(
            collection.project_id.clone(),
            Some(object_type.clone()),
            2,
            None,
        )
        .unwrap();
    assert_eq!(first.items.len(), 2);
    assert!(first.items.iter().all(|item| {
        item.collection_id == collection.project_id
            && item.object_type_id == object_type
            && item.payload_schema_version == 5
            && item.deleted
    }));
    let second = vault
        .list_deleted_object_summaries(
            collection.project_id.clone(),
            Some(object_type.clone()),
            2,
            first.next_cursor.clone(),
        )
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.next_cursor.is_none());

    let global = vault
        .list_all_deleted_object_summaries(Some(object_type.clone()), 2, None)
        .unwrap();
    assert_eq!(global.items.len(), 2);
    assert!(global.next_cursor.is_some());
    let mut global_items = global.items;
    let global_second = vault
        .list_all_deleted_object_summaries(Some(object_type.clone()), 2, global.next_cursor)
        .unwrap();
    assert_eq!(global_second.items.len(), 2);
    global_items.extend(global_second.items);
    assert!(global_items.iter().any(|item| {
        item.object_id == other_object.object_id && item.payload_schema_version == 6
    }));

    let cursor = first.next_cursor.unwrap();
    assert!(vault
        .list_object_summaries(
            collection.project_id.clone(),
            Some(object_type.clone()),
            2,
            Some(cursor.clone()),
        )
        .is_err());
    assert!(vault
        .list_deleted_object_summaries(
            other_collection.project_id,
            Some(object_type.clone()),
            2,
            Some(cursor.clone()),
        )
        .is_err());
    assert!(vault
        .list_all_deleted_object_summaries(Some("login".to_string()), 2, Some(cursor))
        .is_err());
    assert_eq!(deleted_ids.len(), 3);
}

#[test]
fn ffi_metadata_summary_pages_are_bounded_payload_free_and_compatible() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Metadata collection".to_string())
        .unwrap();
    let source = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Source".to_string(),
            r#"{"body":"source"}"#.to_string(),
            1,
        )
        .unwrap();
    let first_target = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Target 1".to_string(),
            r#"{"body":"one"}"#.to_string(),
            1,
        )
        .unwrap();
    let second_target = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Target 2".to_string(),
            r#"{"body":"two"}"#.to_string(),
            1,
        )
        .unwrap();
    let first_relation = vault
        .create_object_relation(
            source.object_id.clone(),
            first_target.object_id.clone(),
            "com.monica.mail.reply-to".to_string(),
            r#"{"position":1}"#.to_string(),
            2,
        )
        .unwrap();
    let second_relation = vault
        .create_object_relation(
            source.object_id.clone(),
            second_target.object_id.clone(),
            "com.monica.mail.reply-to".to_string(),
            r#"{"position":2}"#.to_string(),
            2,
        )
        .unwrap();
    let first_label = vault
        .create_object_label(
            collection.project_id.clone(),
            "Important".to_string(),
            r#"{"color":"red"}"#.to_string(),
            3,
        )
        .unwrap();
    let second_label = vault
        .create_object_label(
            collection.project_id.clone(),
            "Later".to_string(),
            r#"{"color":"blue"}"#.to_string(),
            3,
        )
        .unwrap();
    vault
        .assign_object_label(source.object_id.clone(), first_label.label_id.clone())
        .unwrap();
    vault
        .assign_object_label(source.object_id.clone(), second_label.label_id.clone())
        .unwrap();
    vault
        .assign_object_label(first_target.object_id.clone(), first_label.label_id.clone())
        .unwrap();
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE object_relations SET payload_ct = X'00' WHERE relation_id = ?1",
                [&first_relation.relation_id],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE object_labels SET payload_ct = X'00' WHERE label_id = ?1",
                [&first_label.label_id],
            )
            .unwrap();
    }

    let relation_summary = vault
        .get_object_relation_summary(first_relation.relation_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(relation_summary.relation_kind, "com.monica.mail.reply-to");
    assert_eq!(relation_summary.payload_schema_version, 2);
    let first_relation_page = vault
        .list_object_relation_summaries_from(
            source.object_id.clone(),
            Some("com.monica.mail.reply-to".to_string()),
            1,
            None,
        )
        .unwrap();
    assert_eq!(first_relation_page.items.len(), 1);
    let relation_cursor = first_relation_page.next_cursor.clone().unwrap();
    let second_relation_page = vault
        .list_object_relation_summaries_from(
            source.object_id.clone(),
            Some("com.monica.mail.reply-to".to_string()),
            1,
            Some(relation_cursor.clone()),
        )
        .unwrap();
    let relation_ids = first_relation_page
        .items
        .into_iter()
        .chain(second_relation_page.items)
        .map(|item| item.relation_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        relation_ids,
        [
            first_relation.relation_id.clone(),
            second_relation.relation_id
        ]
        .into_iter()
        .collect()
    );
    assert!(vault
        .list_object_relation_summaries_to(
            first_target.object_id,
            Some("com.monica.mail.reply-to".to_string()),
            1,
            Some(relation_cursor),
        )
        .is_err());

    let label_summary = vault
        .get_object_label_summary(first_label.label_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(label_summary.name, "Important");
    assert_eq!(label_summary.payload_schema_version, 3);
    let label_page = vault
        .list_object_label_summaries(collection.project_id.clone(), 1, None)
        .unwrap();
    assert_eq!(label_page.items.len(), 1);
    assert!(label_page.next_cursor.is_some());

    let object_assignments = vault
        .list_object_label_assignment_summaries_by_object(source.object_id, 10, None)
        .unwrap();
    assert_eq!(object_assignments.items.len(), 2);
    let label_assignments = vault
        .list_object_label_assignment_summaries_by_label(first_label.label_id, 10, None)
        .unwrap();
    assert_eq!(label_assignments.items.len(), 2);

    assert!(vault
        .get_object_relation(first_relation.relation_id)
        .is_err());
    assert!(vault.list_object_labels(collection.project_id).is_err());
    assert!(vault
        .list_object_label_summaries("missing".to_string(), 0, None)
        .is_err());
}

#[test]
fn ffi_object_disclosure_returns_typed_allow_and_missing_session_decisions() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Disclosure collection".to_string())
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id,
            "com.monica.mail.message".to_string(),
            "Message".to_string(),
            r#"{"body":"allowed plaintext"}"#.to_string(),
            1,
        )
        .unwrap();

    let allowed = vault.reveal_object(object.object_id.clone()).unwrap();
    assert_eq!(
        allowed.authorization.outcome,
        MdbxAuthorizationOutcome::Allow
    );
    assert_eq!(
        allowed.object.as_ref().unwrap().payload_json,
        r#"{"body":"allowed plaintext"}"#
    );

    {
        let mut conn = vault.conn.lock().unwrap();
        conn.clear_session();
    }
    let missing = vault.reveal_object(object.object_id).unwrap();
    assert!(missing.object.is_none());
    assert_eq!(
        missing.authorization.outcome,
        MdbxAuthorizationOutcome::RequireFreshAuthentication
    );
    assert!(missing
        .authorization
        .reasons
        .contains(&MdbxAuthorizationReason::SessionMissing));

    let reveal_events = vault
        .list_security_audit_events(10)
        .unwrap()
        .into_iter()
        .filter(|event| event.operation == MdbxTigaOperation::RevealSecret)
        .collect::<Vec<_>>();
    assert_eq!(reveal_events.len(), 2);
}

#[test]
fn ffi_object_disclosure_limits_are_discoverable_and_validated() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Bounded collection".to_string())
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id,
            "com.monica.mail.message".to_string(),
            "Bounded message".to_string(),
            r#"{"body":"bounded plaintext"}"#.to_string(),
            1,
        )
        .unwrap();
    let defaults = default_object_disclosure_limits();
    assert_eq!(defaults.max_payload_bytes, 8 * 1024 * 1024);

    let too_small = vault
        .reveal_object_with_limits(
            object.object_id.clone(),
            MdbxObjectDisclosureLimits {
                max_payload_bytes: 8,
            },
        )
        .unwrap_err();
    assert!(too_small
        .to_string()
        .contains("object plaintext payload bytes"));

    let allowed = vault
        .reveal_object_with_device_context_and_limits(
            object.object_id.clone(),
            conservative_ffi_device_context(),
            MdbxObjectDisclosureLimits {
                max_payload_bytes: 1024,
            },
        )
        .unwrap();
    assert!(allowed.object.is_some());

    for invalid in [0, 64 * 1024 * 1024 + 1] {
        let error = vault
            .reveal_object_with_limits(
                object.object_id.clone(),
                MdbxObjectDisclosureLimits {
                    max_payload_bytes: invalid,
                },
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("object disclosure max_payload_bytes must be between"));
    }
}

#[test]
fn ffi_object_disclosure_rejects_oversized_ciphertext_before_decryption() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Oversized collection".to_string())
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id,
            "com.monica.mail.message".to_string(),
            "Oversized message".to_string(),
            r#"{"body":"small"}"#.to_string(),
            1,
        )
        .unwrap();
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = zeroblob(?2) WHERE entry_id = ?1",
                rusqlite::params![&object.object_id, 256 * 1024],
            )
            .unwrap();
    }

    let error = vault
        .reveal_object_with_limits(
            object.object_id,
            MdbxObjectDisclosureLimits {
                max_payload_bytes: 16,
            },
        )
        .unwrap_err();
    assert!(error
        .to_string()
        .contains("object payload ciphertext bytes"));
    assert!(!error.to_string().contains("crypto error"));
}

#[test]
fn ffi_object_disclosure_power_denial_precedes_oversized_payload() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Power collection".to_string())
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Denied message".to_string(),
            r#"{"body":"must not decrypt"}"#.to_string(),
            1,
        )
        .unwrap();
    vault
        .set_tiga_profile(
            MdbxTigaMode::Power,
            None,
            None,
            conservative_ffi_device_context(),
        )
        .unwrap();
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET payload_ct = zeroblob(?2) WHERE entry_id = ?1",
                rusqlite::params![&object.object_id, 256 * 1024],
            )
            .unwrap();
    }

    let denied = vault
        .reveal_object_with_limits(
            object.object_id.clone(),
            MdbxObjectDisclosureLimits {
                max_payload_bytes: 16,
            },
        )
        .unwrap();
    assert!(denied.object.is_none());
    assert!(!matches!(
        denied.authorization.outcome,
        MdbxAuthorizationOutcome::Allow | MdbxAuthorizationOutcome::AllowWithConstraints
    ));
    assert!(vault
        .get_object(collection.project_id, object.object_id)
        .unwrap_err()
        .to_string()
        .contains("crypto error"));

    let reveal_event = vault
        .list_security_audit_events(10)
        .unwrap()
        .into_iter()
        .find(|event| event.operation == MdbxTigaOperation::RevealSecret)
        .unwrap();
    assert_ne!(reveal_event.outcome, MdbxAuthorizationOutcome::Allow);
}

#[test]
fn ffi_metadata_disclosure_returns_typed_scopes_payloads_and_limits() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Metadata disclosure collection".to_string())
        .unwrap();
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
            2,
        )
        .unwrap();
    let label = vault
        .create_object_label(
            collection.project_id.clone(),
            "Important".to_string(),
            r#"{"color":"red"}"#.to_string(),
            3,
        )
        .unwrap();

    assert_eq!(
        default_object_metadata_disclosure_limits().max_payload_bytes,
        8 * 1024 * 1024
    );
    let relation_result = vault.reveal_object_relation(relation.relation_id).unwrap();
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
        relation_result.target_authorization.scope.scope_type,
        MdbxTigaScopeType::Entry
    );
    assert_eq!(
        relation_result.target_authorization.scope.scope_id,
        Some(target.object_id)
    );

    let too_small = vault
        .reveal_object_label_with_limits(
            label.label_id.clone(),
            MdbxObjectMetadataDisclosureLimits {
                max_payload_bytes: 4,
            },
        )
        .unwrap_err();
    assert!(too_small
        .to_string()
        .contains("object label plaintext payload bytes"));
    let label_result = vault.reveal_object_label(label.label_id.clone()).unwrap();
    assert_eq!(
        label_result.label.unwrap().payload_json,
        r#"{"color":"red"}"#
    );
    assert_eq!(
        label_result.project_authorization.scope.scope_type,
        MdbxTigaScopeType::Project
    );
    assert_eq!(
        label_result.project_authorization.scope.scope_id,
        Some(collection.project_id)
    );

    for invalid in [0, 64 * 1024 * 1024 + 1] {
        let error = vault
            .reveal_object_label_with_limits(
                label.label_id.clone(),
                MdbxObjectMetadataDisclosureLimits {
                    max_payload_bytes: invalid,
                },
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("object metadata disclosure max_payload_bytes must be between"));
    }
}

#[test]
fn ffi_metadata_disclosure_denial_precedes_corrupted_payloads() {
    let vault = ffi_test_vault();
    let collection = vault
        .create_project("Metadata denial collection".to_string())
        .unwrap();
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
            "Denied".to_string(),
            r#"{"color":"red"}"#.to_string(),
            1,
        )
        .unwrap();
    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE entries SET tiga_mode_override = 'power' WHERE entry_id = ?1",
                [&target.object_id],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE object_relations SET payload_ct = zeroblob(?2) WHERE relation_id = ?1",
                rusqlite::params![&relation.relation_id, 256 * 1024],
            )
            .unwrap();
    }

    let denied_relation = vault
        .reveal_object_relation_with_limits(
            relation.relation_id.clone(),
            MdbxObjectMetadataDisclosureLimits {
                max_payload_bytes: 16,
            },
        )
        .unwrap();
    assert!(denied_relation.relation.is_none());
    assert!(matches!(
        denied_relation.source_authorization.decision.outcome,
        MdbxAuthorizationOutcome::Allow | MdbxAuthorizationOutcome::AllowWithConstraints
    ));
    assert!(!matches!(
        denied_relation.target_authorization.decision.outcome,
        MdbxAuthorizationOutcome::Allow | MdbxAuthorizationOutcome::AllowWithConstraints
    ));
    assert!(vault
        .get_object_relation(relation.relation_id)
        .unwrap_err()
        .to_string()
        .contains("crypto error"));
    let relation_events = vault
        .list_security_audit_events_v2(10)
        .unwrap()
        .into_iter()
        .filter(|event| event.operation == MdbxTigaOperation::RevealSecret)
        .collect::<Vec<_>>();
    assert_eq!(relation_events.len(), 2);
    let operation_id = relation_events[0].operation_id.as_ref().unwrap();
    assert!(relation_events
        .iter()
        .all(|event| event.operation_id.as_ref() == Some(operation_id)));

    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE projects SET tiga_mode_override = 'power' WHERE project_id = ?1",
                [&collection.project_id],
            )
            .unwrap();
        conn.inner()
            .execute(
                "UPDATE object_labels SET payload_ct = X'00' WHERE label_id = ?1",
                [&label.label_id],
            )
            .unwrap();
    }
    let denied_label = vault.reveal_object_label(label.label_id.clone()).unwrap();
    assert!(denied_label.label.is_none());
    assert_eq!(
        denied_label.project_authorization.scope,
        MdbxTigaScope {
            scope_type: MdbxTigaScopeType::Project,
            scope_id: Some(collection.project_id.clone()),
        }
    );
    assert!(vault
        .list_object_labels(collection.project_id)
        .unwrap_err()
        .to_string()
        .contains("crypto error"));
}

#[test]
fn payload_migration_facade_exposes_adapter_bytes_and_one_commit_result() {
    let vault = ffi_test_vault();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    vault
        .set_extension_capabilities(vec!["com.monica.mail.payload-v2".to_string()])
        .unwrap();
    vault
        .set_collection_profile(
            collection.project_id.clone(),
            "com.monica.mail".to_string(),
            b"profile".to_vec(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.payload-v2".to_string()],
        )
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Message".to_string(),
            r#"{"version":1}"#.to_string(),
            1,
        )
        .unwrap();

    let plan = vault
        .create_payload_migration_plan(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            1,
            2,
            16,
            None,
        )
        .unwrap();
    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.items[0].object_id, object.object_id);
    assert_eq!(plan.items[0].source_payload, br#"{"version":1}"#);

    let result = vault
        .execute_payload_migration(
            plan.clone(),
            vec![MdbxPayloadMigrationOutput {
                object_id: object.object_id.clone(),
                target_payload: br#"{"version":2}"#.to_vec(),
            }],
        )
        .unwrap();
    assert_eq!(result.migrated_count, 1);
    assert!(!result.already_committed);
    let migrated = vault
        .get_object(collection.project_id, object.object_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(migrated.payload_schema_version, 2);
    assert_eq!(migrated.payload_json, r#"{"version":2}"#);

    let repeated = vault
        .execute_payload_migration(
            plan,
            vec![MdbxPayloadMigrationOutput {
                object_id: object.object_id.clone(),
                target_payload: br#"{"version":2}"#.to_vec(),
            }],
        )
        .unwrap();
    assert!(repeated.already_committed);
    assert_eq!(repeated.commit_id, result.commit_id);

    let events = vault
        .list_security_audit_events_v2(20)
        .unwrap()
        .into_iter()
        .filter(|event| event.operation == MdbxTigaOperation::MigratePayload)
        .collect::<Vec<_>>();
    assert_eq!(events.len(), 2);
    let plan_event = events
        .iter()
        .find(|event| event.commit_id.is_none())
        .expect("plan authorization event must not reference a commit");
    let execution_event = events
        .iter()
        .find(|event| event.commit_id.as_deref() == Some(result.commit_id.as_str()))
        .expect("execution authorization event must reference its commit");
    assert_eq!(plan_event.operation_id, execution_event.operation_id);
}

#[test]
fn payload_migration_facade_requires_session_and_supports_device_context() {
    let vault = ffi_test_vault();
    let collection = vault.create_project("Mail".to_string()).unwrap();
    vault
        .set_extension_capabilities(vec!["com.monica.mail.payload-v2".to_string()])
        .unwrap();
    vault
        .set_collection_profile(
            collection.project_id.clone(),
            "com.monica.mail".to_string(),
            b"profile".to_vec(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.payload-v2".to_string()],
        )
        .unwrap();
    let object = vault
        .create_object(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Message".to_string(),
            r#"{"version":1}"#.to_string(),
            1,
        )
        .unwrap();

    vault.conn.lock().unwrap().clear_session();
    let denied = vault
        .create_payload_migration_plan(
            collection.project_id.clone(),
            "com.monica.mail.message".to_string(),
            1,
            2,
            16,
            None,
        )
        .unwrap_err();
    assert!(denied.to_string().contains("Tiga authorization"));

    UnlockService::unlock_with_password(&mut vault.conn.lock().unwrap(), "attachment-password")
        .unwrap();
    let device = MdbxDeviceContext {
        assurance: MdbxDeviceAssurance::Standard,
        secure_clipboard_available: false,
        screen_capture_protection_available: false,
        secure_temp_files_available: true,
    };
    let plan = vault
        .create_payload_migration_plan_with_device_context(
            collection.project_id,
            "com.monica.mail.message".to_string(),
            1,
            2,
            16,
            None,
            device.clone(),
        )
        .unwrap();
    let result = vault
        .execute_payload_migration_with_device_context(
            plan,
            vec![MdbxPayloadMigrationOutput {
                object_id: object.object_id,
                target_payload: br#"{"version":2}"#.to_vec(),
            }],
            device,
        )
        .unwrap();
    assert!(!result.already_committed);
    assert_eq!(result.migrated_count, 1);
}

#[test]
fn conflict_facade_lists_and_resolves_generic_metadata() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let ctx = CommitContext::new("ffi-conflict-device".to_string());
    let project = ProjectRepo::create(&conn, &ctx, "Mail", None, None).unwrap();
    let first = EntryRepo::create(
        &conn,
        &ctx,
        &project.project_id,
        EntryType::custom("com.monica.mail.message").unwrap(),
        Some("First"),
        &serde_json::json!({"body":"first"}),
    )
    .unwrap();
    let second = EntryRepo::create(
        &conn,
        &ctx,
        &project.project_id,
        EntryType::custom("com.monica.mail.message").unwrap(),
        Some("Second"),
        &serde_json::json!({"body":"second"}),
    )
    .unwrap();
    let relation = ObjectRelationRepo::create(
        &conn,
        &ctx,
        ObjectRelationCreateRequest::new(
            &first.entry_id,
            &second.entry_id,
            RelationKindId::new("com.monica.mail.reply-to").unwrap(),
            serde_json::json!({"position":1}),
        ),
    )
    .unwrap();
    let current = mdbx_storage::repo::ObjectVersionRepo::current_object_relation_row(
        &conn,
        &relation.relation_id,
    )
    .unwrap();
    let incoming_commit = ctx
        .create_commit(
            &conn,
            "change",
            "object-relation",
            std::slice::from_ref(&relation.relation_id),
            std::slice::from_ref(&current.head_commit_id),
        )
        .unwrap();
    let mut incoming = current.clone();
    incoming.payload_ct = serde_json::to_vec(&serde_json::json!({"position":2})).unwrap();
    incoming.head_commit_id = incoming_commit.clone();
    mdbx_storage::repo::ObjectVersionRepo::record_object_relation_row(
        &conn,
        &incoming_commit,
        &incoming,
    )
    .unwrap();
    let conflict = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::ObjectRelation,
        &relation.relation_id,
        &current.head_commit_id,
        &current.head_commit_id,
        &incoming_commit,
        &["payload_ct".to_string()],
    )
    .unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-conflict-device".to_string(),
        vault_id: "ffi-conflict-vault".to_string(),
    };

    let listed = vault.list_unresolved_conflicts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].object_type, "object-relation");
    let resolved = vault
        .resolve_conflict(conflict.conflict_id, MdbxConflictChoice::IncomingWins)
        .unwrap();
    assert_eq!(resolved.resolution, "incoming-wins");
    assert!(vault.list_unresolved_conflicts().unwrap().is_empty());
    let conn = vault.conn.lock().unwrap();
    let stored = ObjectRelationRepo::get_by_id(&conn, &relation.relation_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&stored.payload_ct).unwrap(),
        serde_json::json!({"position":2})
    );
}

#[test]
fn conflict_summary_facade_pages_filters_binds_cursors_and_exposes_limits() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let ctx = CommitContext::new("ffi-conflict-summary-device".to_string());
    let first = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::Entry,
        "entry-1",
        "base-1",
        "local-1",
        "incoming-1",
        &["payload.title".to_string()],
    )
    .unwrap();
    let second = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::Entry,
        "entry-2",
        "base-2",
        "local-2",
        "incoming-2",
        &["payload.body".to_string()],
    )
    .unwrap();
    let project = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::Project,
        "project-1",
        "base-3",
        "local-3",
        "incoming-3",
        &["title".to_string()],
    )
    .unwrap();
    conn.inner()
        .execute(
            "UPDATE conflicts SET created_at = '2026-07-25T00:00:00Z' WHERE conflict_id IN (?1, ?2, ?3)",
            rusqlite::params![&first.conflict_id, &second.conflict_id, &project.conflict_id],
        )
        .unwrap();

    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-conflict-summary-device".to_string(),
        vault_id: "ffi-conflict-summary-vault".to_string(),
    };

    let limits = default_conflict_summary_limits();
    assert_eq!(limits.max_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);
    assert_eq!(limits.max_fields_json_bytes, 64 * 1024);
    assert_eq!(limits.max_field_count, 256);
    assert_eq!(limits.max_field_path_bytes, 4096);

    let first_page = vault
        .list_unresolved_conflict_summaries(Some("entry".to_string()), 1, None)
        .unwrap();
    assert_eq!(first_page.items.len(), 1);
    assert_eq!(first_page.items[0].object_type, "entry");
    assert!(first_page.next_cursor.is_some());
    let second_page = vault
        .list_unresolved_conflict_summaries(
            Some("entry".to_string()),
            1,
            first_page.next_cursor.clone(),
        )
        .unwrap();
    assert_eq!(second_page.items.len(), 1);
    assert_eq!(second_page.items[0].object_type, "entry");
    assert_ne!(
        first_page.items[0].conflict_id,
        second_page.items[0].conflict_id
    );
    assert!(second_page.next_cursor.is_none());
    assert!(vault
        .list_unresolved_conflict_summaries(Some("project".to_string()), 1, first_page.next_cursor,)
        .is_err());
    assert!(matches!(
        vault.list_unresolved_conflict_summaries(Some("unknown".to_string()), 1, None),
        Err(MdbxFfiError::InvalidConflictObjectType { object_type })
            if object_type == "unknown"
    ));

    // The legacy complete read remains callable alongside the bounded plane.
    assert_eq!(vault.list_unresolved_conflicts().unwrap().len(), 3);
}

#[test]
fn conflict_summary_facade_fails_closed_for_oversized_and_malformed_fields() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let ctx = CommitContext::new("ffi-conflict-summary-limits-device".to_string());
    let conflict = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::Entry,
        "entry-1",
        "base-1",
        "local-1",
        "incoming-1",
        &["payload.title".to_string()],
    )
    .unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-conflict-summary-limits-device".to_string(),
        vault_id: "ffi-conflict-summary-limits-vault".to_string(),
    };

    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = ?2 WHERE conflict_id = ?1",
                rusqlite::params![&conflict.conflict_id, "x".repeat(64 * 1024 + 1)],
            )
            .unwrap();
    }
    assert!(matches!(
        vault.list_unresolved_conflict_summaries(None, 1, None),
        Err(MdbxFfiError::Storage { message })
            if message.contains("conflicting fields JSON bytes")
    ));

    {
        let conn = vault.conn.lock().unwrap();
        conn.inner()
            .execute(
                "UPDATE conflicts SET conflicting_fields = 'not-json' WHERE conflict_id = ?1",
                [&conflict.conflict_id],
            )
            .unwrap();
    }
    assert!(matches!(
        vault.list_unresolved_conflict_summaries(None, 1, None),
        Err(MdbxFfiError::Storage { message })
            if message.contains("invalid conflicting fields JSON")
    ));
}

#[test]
fn snapshot_summary_facade_pages_without_loading_payload_and_preserves_legacy_reads() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let ctx = CommitContext::new("ffi-snapshot-summary-device".to_string());
    let first = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
    let second = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
    let third = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
    conn.inner()
        .execute(
            "UPDATE snapshots SET created_at = '2026-07-25T00:00:00Z'",
            [],
        )
        .unwrap();
    conn.inner()
        .execute(
            "UPDATE snapshots SET snapshot_ct = ?1 WHERE snapshot_id = ?2",
            rusqlite::params![vec![0x7f_u8; 512 * 1024], &second.snapshot_id],
        )
        .unwrap();

    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-snapshot-summary-device".to_string(),
        vault_id: "ffi-snapshot-summary-vault".to_string(),
    };
    let limits = default_snapshot_summary_limits();
    assert_eq!(limits.max_page_size, 200);
    assert_eq!(limits.max_cursor_bytes, 4096);
    assert_eq!(limits.max_text_bytes, 4096);

    let first_page = vault.list_snapshot_summaries(2, None).unwrap();
    assert_eq!(first_page.items.len(), 2);
    assert!(first_page.next_cursor.is_some());
    let second_page = vault
        .list_snapshot_summaries(2, first_page.next_cursor.clone())
        .unwrap();
    assert_eq!(second_page.items.len(), 1);
    assert!(second_page.next_cursor.is_none());
    let all_items = first_page
        .items
        .iter()
        .chain(second_page.items.iter())
        .collect::<Vec<_>>();
    assert!(all_items
        .iter()
        .any(|item| item.snapshot_id == first.snapshot_id));
    assert!(all_items
        .iter()
        .any(|item| item.snapshot_id == third.snapshot_id));
    assert!(all_items.iter().any(|item| {
        item.snapshot_id == second.snapshot_id && item.snapshot_ciphertext_bytes == 512 * 1024
    }));
    let by_id = vault
        .get_snapshot_summary(second.snapshot_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(by_id.snapshot_ciphertext_bytes, 512 * 1024);
    assert!(vault.list_snapshot_summaries(0, None).is_err());

    // Complete reads remain available for explicit compatibility/recovery use.
    assert_eq!(
        SnapshotRepo::list_all(&vault.conn.lock().unwrap())
            .unwrap()
            .len(),
        3
    );
    assert_ne!(first.snapshot_id, second.snapshot_id);
}

#[test]
fn snapshot_lifecycle_facade_keeps_legacy_manual_and_prunes_automatic_idempotently() {
    let vault = ffi_test_vault();
    let (legacy_id, automatic_id) = {
        let conn = vault.conn.lock().unwrap();
        let ctx = CommitContext::new(vault.device_id.clone());
        let legacy = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        let automatic = SnapshotRepo::create_snapshot(&conn, &ctx).unwrap();
        SnapshotLifecycleRepo::register(
            &conn,
            &automatic.snapshot_id,
            SnapshotKind::Automatic,
            Some(&automatic.created_at),
        )
        .unwrap();
        (legacy.snapshot_id, automatic.snapshot_id)
    };
    std::thread::sleep(std::time::Duration::from_secs(1));

    let limits = default_snapshot_lifecycle_limits();
    assert_eq!(limits.max_prune_candidates, 200);
    assert_eq!(limits.max_keep_latest, 10_000);
    assert_eq!(
        vault
            .get_snapshot_lifecycle(legacy_id.clone())
            .unwrap()
            .unwrap()
            .kind,
        MdbxSnapshotKind::Manual
    );
    assert_eq!(
        vault
            .get_snapshot_lifecycle(automatic_id.clone())
            .unwrap()
            .unwrap()
            .kind,
        MdbxSnapshotKind::Automatic
    );

    let plan = vault.plan_automatic_snapshot_prune(0).unwrap();
    assert_eq!(plan.candidates.len(), 1);
    assert_eq!(plan.candidates[0].summary.snapshot_id, automatic_id);
    let commit_count = ffi_test_count(&vault, "commits");
    let result = vault
        .prune_automatic_snapshots(
            plan.plan_token.clone(),
            0,
            conservative_ffi_device_context(),
        )
        .unwrap();
    assert_eq!(result.deleted_snapshot_ids, vec![automatic_id]);
    assert_eq!(ffi_test_count(&vault, "commits"), commit_count + 1);
    assert!(vault.get_snapshot_summary(legacy_id).unwrap().is_some());
    let history = vault
        .get_commit_history(result.commit_id.clone())
        .unwrap()
        .unwrap();
    assert_eq!(history.change_scope, "snapshot");

    let retry = vault
        .prune_automatic_snapshots(plan.plan_token, 0, conservative_ffi_device_context())
        .unwrap();
    assert_eq!(retry, result);
    assert_eq!(ffi_test_count(&vault, "commits"), commit_count + 1);
}

#[test]
fn conflict_facade_applies_typed_project_and_attachment_custom_merges() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let ctx = CommitContext::new("ffi-custom-conflict-device".to_string());
    let project = ProjectRepo::create(&conn, &ctx, "Local", None, None).unwrap();
    let project_row =
        mdbx_storage::repo::ObjectVersionRepo::current_project_row(&conn, &project.project_id)
            .unwrap();
    let project_incoming_commit = ctx
        .create_commit(
            &conn,
            "change",
            "project",
            std::slice::from_ref(&project.project_id),
            std::slice::from_ref(&project_row.head_commit_id),
        )
        .unwrap();
    let mut incoming_project = project_row.clone();
    incoming_project.title_ct = b"Incoming".to_vec();
    incoming_project.head_commit_id = project_incoming_commit.clone();
    mdbx_storage::repo::ObjectVersionRepo::record_project_row(
        &conn,
        &project_incoming_commit,
        &incoming_project,
    )
    .unwrap();
    let project_conflict = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::Project,
        &project.project_id,
        &project_row.head_commit_id,
        &project_row.head_commit_id,
        &project_incoming_commit,
        &["title_ct".to_string()],
    )
    .unwrap();

    let content_hash = "a".repeat(64);
    let attachment = AttachmentRepo::add(
        &conn,
        &ctx,
        &project.project_id,
        None,
        "local.mafile",
        Some("application/json"),
        &content_hash,
        256,
    )
    .unwrap();
    let attachment_row = mdbx_storage::repo::ObjectVersionRepo::current_attachment_row(
        &conn,
        &attachment.attachment_id,
    )
    .unwrap();
    let attachment_incoming_commit = ctx
        .create_commit(
            &conn,
            "change",
            "attachment",
            std::slice::from_ref(&attachment.attachment_id),
            std::slice::from_ref(&attachment_row.head_commit_id),
        )
        .unwrap();
    let mut incoming_attachment = attachment_row.clone();
    incoming_attachment.file_name_ct = b"incoming.mafile".to_vec();
    incoming_attachment.head_commit_id = attachment_incoming_commit.clone();
    mdbx_storage::repo::ObjectVersionRepo::record_attachment_row(
        &conn,
        &attachment_incoming_commit,
        &incoming_attachment,
    )
    .unwrap();
    let attachment_conflict = ConflictRepo::create(
        &conn,
        &ctx,
        ConflictObjectType::Attachment,
        &attachment.attachment_id,
        &attachment_row.head_commit_id,
        &attachment_row.head_commit_id,
        &attachment_incoming_commit,
        &["file_name_ct".to_string()],
    )
    .unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-custom-conflict-device".to_string(),
        vault_id: "ffi-custom-conflict-vault".to_string(),
    };

    assert!(vault
        .resolve_project_conflict_custom(
            attachment_conflict.conflict_id.clone(),
            MdbxProjectConflictMerge {
                title: "Wrong type".to_string(),
                summary: None,
                group_id: None,
                icon_ref: None,
                favorite: false,
                archived: false,
                deleted: false,
            },
        )
        .is_err());

    let resolved_project = vault
        .resolve_project_conflict_custom(
            project_conflict.conflict_id,
            MdbxProjectConflictMerge {
                title: "Merged".to_string(),
                summary: Some("Selected summary".to_string()),
                group_id: Some("accounts".to_string()),
                icon_ref: Some("steam".to_string()),
                favorite: true,
                archived: false,
                deleted: false,
            },
        )
        .unwrap();
    let resolved_attachment = vault
        .resolve_attachment_conflict_custom(
            attachment_conflict.conflict_id,
            MdbxAttachmentConflictMerge {
                project_id: project.project_id.clone(),
                entry_id: None,
                file_name: "merged.mafile".to_string(),
                media_type: Some("application/vnd.monica.mafile+json".to_string()),
                deleted: false,
            },
        )
        .unwrap();

    assert_eq!(resolved_project.resolution, "custom");
    assert_eq!(resolved_attachment.resolution, "custom");
    assert!(vault.list_unresolved_conflicts().unwrap().is_empty());
    let conn = vault.conn.lock().unwrap();
    let stored_project = ProjectRepo::get_by_id(&conn, &project.project_id)
        .unwrap()
        .unwrap();
    let stored_attachment = AttachmentRepo::get_by_id(&conn, &attachment.attachment_id)
        .unwrap()
        .unwrap();
    assert_eq!(stored_project.title_ct, b"Merged");
    assert_eq!(
        stored_project.summary_ct.as_deref(),
        Some(b"Selected summary".as_slice())
    );
    assert!(stored_project.favorite);
    assert_eq!(stored_attachment.file_name_ct, b"merged.mafile");
    assert_eq!(stored_attachment.content_hash, content_hash);
    assert_eq!(stored_attachment.original_size, 256);
}

#[test]
fn health_check_returns_structured_tombstone_issues() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let ctx = CommitContext::new("ffi-health-device".to_string());
    let project = ProjectRepo::create(&conn, &ctx, "Health", None, None).unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-health-device".to_string(),
        vault_id: "ffi-health-vault".to_string(),
    };

    let clean = vault.health_check().unwrap();
    assert!(clean.healthy);

    {
        let conn = vault.conn.lock().unwrap();
        ProjectRepo::soft_delete(&conn, &ctx, &project.project_id).unwrap();
        conn.inner()
            .execute(
                "DELETE FROM tombstones
                     WHERE target_object_type = 'project' AND target_object_id = ?1",
                rusqlite::params![project.project_id],
            )
            .unwrap();
    }

    let unhealthy = vault.health_check().unwrap();
    assert!(!unhealthy.healthy);
    assert!(unhealthy.issues.iter().any(|issue| {
        issue.severity == MdbxHealthIssueSeverity::Error
            && issue.category == "tombstones"
            && issue.description.contains(&project.project_id)
            && issue.description.contains("deleted without")
    }));
}

#[test]
fn health_repair_plan_and_conflict_choices_are_available_to_native_clients() {
    let vault = ffi_test_vault();
    let entry_id = {
        let conn = vault.conn.lock().unwrap();
        let ctx = CommitContext::new(vault.device_id.clone());
        let project = ProjectRepo::create(&conn, &ctx, "Repair", None, None).unwrap();
        let entry = EntryRepo::create(
            &conn,
            &ctx,
            &project.project_id,
            EntryType::Login,
            Some("Conflicting marker"),
            &serde_json::json!({"username":"active"}),
        )
        .unwrap();
        ctx.create_tombstone(&conn, "entry", &entry.entry_id)
            .unwrap();
        entry.entry_id
    };

    let plan = vault.plan_health_repair().unwrap();
    assert!(plan.can_apply);
    assert!(plan.automatic_items.is_empty());
    assert_eq!(plan.conflict_items.len(), 1);
    assert_eq!(plan.conflict_items[0].object_id, entry_id);

    let before_commits = ffi_test_count(&vault, "commits");
    let before_snapshots = ffi_test_count(&vault, "snapshots");
    let cancelled = vault
        .apply_health_repair(
            plan.token.clone(),
            "ffi-cancel-health-repair".to_string(),
            vec![MdbxHealthRepairDecision {
                repair_id: plan.conflict_items[0].repair_id.clone(),
                choice: MdbxHealthRepairChoice::Cancel,
            }],
        )
        .unwrap();
    assert_eq!(cancelled.status, MdbxHealthRepairStatus::Cancelled);
    assert_eq!(ffi_test_count(&vault, "commits"), before_commits);
    assert_eq!(ffi_test_count(&vault, "snapshots"), before_snapshots);

    let applied = vault
        .apply_health_repair(
            plan.token,
            "ffi-keep-health-repair".to_string(),
            vec![MdbxHealthRepairDecision {
                repair_id: plan.conflict_items[0].repair_id.clone(),
                choice: MdbxHealthRepairChoice::KeepContent,
            }],
        )
        .unwrap();
    assert_eq!(applied.status, MdbxHealthRepairStatus::Applied);
    assert!(applied.snapshot_id.is_some());
    assert!(applied.commit_id.is_some());
    assert!(applied
        .health
        .issues
        .iter()
        .all(|issue| issue.category != "tombstones"));
}

#[test]
fn tombstone_purge_eligibility_is_available_to_native_clients() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(
        &conn,
        &VaultInitParams {
            device_id: "ffi-purge-device".to_string(),
            ..VaultInitParams::default()
        },
    )
    .unwrap();
    let ctx = CommitContext::new("ffi-purge-device".to_string());
    let project = ProjectRepo::create(&conn, &ctx, "Purge", None, None).unwrap();
    ProjectRepo::soft_delete(&conn, &ctx, &project.project_id).unwrap();
    let tombstone = TombstoneRepo::find_by_target(&conn, &project.project_id)
        .unwrap()
        .unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-purge-device".to_string(),
        vault_id: "ffi-purge-vault".to_string(),
    };

    let result = vault
        .evaluate_tombstone_purge_eligibility(
            tombstone.tombstone_id,
            "2030-01-01T00:00:00Z".to_string(),
        )
        .unwrap();
    assert!(!result.eligible);
    assert_eq!(result.blockers.len(), 1);
    assert_eq!(result.blockers[0].code, "retention-not-scheduled");
}

#[test]
fn bounded_write_operation_limits_and_streaming_intent_hash_are_stable() {
    let limits = default_write_operation_limits();
    assert_eq!(limits.max_commands, 256);
    assert_eq!(limits.max_payload_bytes_per_command, 1024 * 1024);
    assert_eq!(limits.max_payload_bytes, 8 * 1024 * 1024);
    assert_eq!(limits.max_intent_bytes, 16 * 1024 * 1024);

    let commands = vec![MdbxWriteCommand::CreateProject {
        project_id: Uuid::new_v4().to_string(),
        title: "Mail".to_string(),
    }];
    let encoded = serde_json::to_vec(&commands).unwrap();
    let storage_commands: Vec<mdbx_storage::repo::WriteCommand> =
        commands.clone().into_iter().map(Into::into).collect();
    assert_eq!(serde_json::to_vec(&storage_commands).unwrap(), encoded);
    assert_eq!(
        hash_write_operation_intent(&commands, encoded.len()).unwrap(),
        Sha256::digest(&encoded).to_vec()
    );
    assert!(hash_write_operation_intent(&commands, encoded.len() - 1)
        .unwrap_err()
        .to_string()
        .contains("serialized intent bytes"));

    let invalid = MdbxWriteOperationLimits {
        max_commands: HARD_MAX_WRITE_COMMANDS as u64 + 1,
        ..limits
    };
    assert!(invalid.into_internal().is_err());
}

#[test]
fn bounded_write_operation_rejects_without_database_side_effects() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let initial_commits: i64 = conn
        .inner()
        .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
        .unwrap();
    let initial_projects: i64 = conn
        .inner()
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    let initial_head: String = conn
        .inner()
        .query_row(
            "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-bounded-write-device".to_string(),
        vault_id: "ffi-bounded-write-vault".to_string(),
    };

    let too_many = (0..=DEFAULT_MAX_WRITE_COMMANDS)
        .map(|index| MdbxWriteCommand::CreateProject {
            project_id: Uuid::new_v4().to_string(),
            title: format!("Collection {index}"),
        })
        .collect();
    assert!(vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "bulk-import".to_string(),
            too_many,
        )
        .unwrap_err()
        .to_string()
        .contains("write operation commands"));

    let oversized_payload = format!(
        "\"{}\"",
        "x".repeat(DEFAULT_MAX_WRITE_PAYLOAD_BYTES_PER_COMMAND)
    );
    assert!(vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![MdbxWriteCommand::CreateEntry {
                entry_id: Uuid::new_v4().to_string(),
                project_id: Uuid::new_v4().to_string(),
                entry_type: "com.monica.mail.message".to_string(),
                title: "Oversized".to_string(),
                payload_json: oversized_payload,
            }],
        )
        .unwrap_err()
        .to_string()
        .contains("command payload bytes"));

    let small_limits = MdbxWriteOperationLimits {
        max_commands: 2,
        max_payload_bytes_per_command: 16,
        max_payload_bytes: 16,
        max_intent_bytes: 4096,
    };
    let payload = r#"{"body":"1234"}"#.to_string();
    assert!(vault
        .execute_write_operation_with_limits(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![
                MdbxWriteCommand::CreateEntry {
                    entry_id: Uuid::new_v4().to_string(),
                    project_id: Uuid::new_v4().to_string(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "First".to_string(),
                    payload_json: payload.clone(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: Uuid::new_v4().to_string(),
                    project_id: Uuid::new_v4().to_string(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Second".to_string(),
                    payload_json: payload,
                },
            ],
            small_limits,
        )
        .unwrap_err()
        .to_string()
        .contains("write operation payload bytes"));

    let conn = vault.conn.lock().unwrap();
    assert_eq!(
        conn.inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        initial_commits
    );
    assert_eq!(
        conn.inner()
            .query_row("SELECT COUNT(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        initial_projects
    );
    assert_eq!(
        conn.inner()
            .query_row(
                "SELECT head_commit_id FROM branches WHERE branch_name = 'main'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        initial_head
    );
}

#[test]
fn write_operation_is_atomic_single_commit_and_idempotent_across_limit_apis() {
    let conn = VaultConnection::open_in_memory().unwrap();
    initialize_vault(&conn, &VaultInitParams::default()).unwrap();
    let initial_commits: i64 = conn
        .inner()
        .query_row("SELECT COUNT(*) FROM commits", [], |row| row.get(0))
        .unwrap();
    let vault = MdbxVault {
        conn: VaultRuntime::from_connection(conn),
        device_id: "ffi-write-device".to_string(),
        vault_id: "ffi-write-vault".to_string(),
    };
    let operation_id = Uuid::new_v4().to_string();
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();
    let commands = vec![
        MdbxWriteCommand::CreateProject {
            project_id: project_id.clone(),
            title: "Mail".to_string(),
        },
        MdbxWriteCommand::CreateEntry {
            entry_id: entry_id.clone(),
            project_id: project_id.clone(),
            entry_type: "com.monica.mail.message".to_string(),
            title: "Message".to_string(),
            payload_json: r#"{"body":"encrypted by storage"}"#.to_string(),
        },
    ];
    let explicit_limits = MdbxWriteOperationLimits {
        max_commands: 2,
        max_payload_bytes_per_command: 1024,
        max_payload_bytes: 1024,
        max_intent_bytes: 4096,
    };

    let first = vault
        .execute_write_operation_with_limits(
            operation_id.clone(),
            "mail-import".to_string(),
            commands.clone(),
            explicit_limits,
        )
        .unwrap();
    assert!(!first.already_committed);
    assert_eq!(first.project_ids, vec![project_id.clone()]);
    assert_eq!(first.entry_ids, vec![entry_id.clone()]);

    let retry = vault
        .execute_write_operation(
            operation_id.clone(),
            "mail-import".to_string(),
            commands.clone(),
        )
        .unwrap();
    assert!(retry.already_committed);
    assert_eq!(retry.commit_id, first.commit_id);

    let changed_commands = vec![commands[0].clone()];
    assert!(vault
        .execute_write_operation(operation_id, "mail-import".to_string(), changed_commands,)
        .unwrap_err()
        .to_string()
        .contains("reused for a different operation"));

    let failed_project_id = Uuid::new_v4().to_string();
    let missing_project_id = Uuid::new_v4().to_string();
    assert!(vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: failed_project_id.clone(),
                    title: "Rolled back".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: Uuid::new_v4().to_string(),
                    project_id: missing_project_id,
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Failure".to_string(),
                    payload_json: "{}".to_string(),
                },
            ],
        )
        .is_err());

    let conn = vault.conn.lock().unwrap();
    assert_eq!(
        conn.inner()
            .query_row("SELECT COUNT(*) FROM commits", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        initial_commits + 1
    );
    assert_eq!(
        conn.inner()
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE project_id = ?1",
                rusqlite::params![failed_project_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    let stored_entry = EntryRepo::get_by_id(&conn, &entry_id).unwrap().unwrap();
    assert_eq!(stored_entry.head_commit_id, first.commit_id);
}

#[test]
fn generic_metadata_write_operation_is_atomic_idempotent_and_lifecycle_complete() {
    let vault = ffi_test_vault();
    let operation_id = Uuid::new_v4().to_string();
    let project_id = Uuid::new_v4().to_string();
    let first_entry_id = Uuid::new_v4().to_string();
    let second_entry_id = Uuid::new_v4().to_string();
    let relation_id = Uuid::new_v4().to_string();
    let label_id = Uuid::new_v4().to_string();
    let assignment_id = Uuid::new_v4().to_string();
    let commits_before = ffi_test_count(&vault, "commits");
    let commands = vec![
        MdbxWriteCommand::CreateProject {
            project_id: project_id.clone(),
            title: "Mail".to_string(),
        },
        MdbxWriteCommand::CreateEntry {
            entry_id: first_entry_id.clone(),
            project_id: project_id.clone(),
            entry_type: "com.monica.mail.message".to_string(),
            title: "First".to_string(),
            payload_json: r#"{"body":"first"}"#.to_string(),
        },
        MdbxWriteCommand::CreateEntry {
            entry_id: second_entry_id.clone(),
            project_id: project_id.clone(),
            entry_type: "com.monica.mail.message".to_string(),
            title: "Second".to_string(),
            payload_json: r#"{"body":"second"}"#.to_string(),
        },
        MdbxWriteCommand::CreateObjectRelation {
            relation_id: relation_id.clone(),
            source_object_id: first_entry_id.clone(),
            target_object_id: second_entry_id.clone(),
            relation_kind: "com.monica.mail.reply-to".to_string(),
            payload_json: r#"{"position":1}"#.to_string(),
            payload_schema_version: 1,
        },
        MdbxWriteCommand::CreateObjectLabel {
            label_id: label_id.clone(),
            collection_id: project_id.clone(),
            name: "Important".to_string(),
            payload_json: r#"{"color":"red"}"#.to_string(),
            payload_schema_version: 1,
        },
        MdbxWriteCommand::AssignObjectLabel {
            assignment_id: assignment_id.clone(),
            object_id: first_entry_id.clone(),
            label_id: label_id.clone(),
        },
    ];

    let created = vault
        .execute_write_operation(
            operation_id.clone(),
            "mail-thread-import".to_string(),
            commands.clone(),
        )
        .unwrap();
    assert!(!created.already_committed);
    assert_eq!(created.project_ids, vec![project_id.clone()]);
    assert_eq!(
        created.entry_ids,
        vec![first_entry_id.clone(), second_entry_id.clone()]
    );
    assert_eq!(created.relation_ids, vec![relation_id.clone()]);
    assert_eq!(created.label_ids, vec![label_id.clone()]);
    assert_eq!(created.label_assignment_ids, vec![assignment_id.clone()]);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);
    {
        let conn = vault.conn.lock().unwrap();
        assert_eq!(
            ObjectRelationRepo::get_by_id(&conn, &relation_id)
                .unwrap()
                .unwrap()
                .head_commit_id,
            created.commit_id
        );
        assert_eq!(
            ObjectLabelRepo::get_by_id(&conn, &label_id)
                .unwrap()
                .unwrap()
                .head_commit_id,
            created.commit_id
        );
        assert_eq!(
            ObjectLabelAssignmentRepo::get_by_id(&conn, &assignment_id)
                .unwrap()
                .unwrap()
                .head_commit_id,
            created.commit_id
        );
    }

    let retry = vault
        .execute_write_operation(
            operation_id.clone(),
            "mail-thread-import".to_string(),
            commands.clone(),
        )
        .unwrap();
    assert!(retry.already_committed);
    assert_eq!(retry.commit_id, created.commit_id);
    let mut changed_commands = commands.clone();
    if let MdbxWriteCommand::CreateObjectRelation { payload_json, .. } = &mut changed_commands[3] {
        *payload_json = r#"{"position":2}"#.to_string();
    }
    assert!(vault
        .execute_write_operation(
            operation_id,
            "mail-thread-import".to_string(),
            changed_commands,
        )
        .unwrap_err()
        .to_string()
        .contains("reused for a different operation"));

    let updated = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "mail-thread-update".to_string(),
            vec![
                MdbxWriteCommand::UpdateObjectRelation {
                    relation_id: relation_id.clone(),
                    relation_kind: "com.monica.mail.thread-member".to_string(),
                    payload_json: r#"{"position":2}"#.to_string(),
                    payload_schema_version: 2,
                },
                MdbxWriteCommand::UpdateObjectLabel {
                    label_id: label_id.clone(),
                    name: "Priority".to_string(),
                    payload_json: r#"{"color":"orange"}"#.to_string(),
                    payload_schema_version: 2,
                },
            ],
        )
        .unwrap();
    assert_eq!(updated.relation_ids, vec![relation_id.clone()]);
    assert_eq!(updated.label_ids, vec![label_id.clone()]);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 2);

    let deleted = vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "mail-thread-delete".to_string(),
            vec![
                MdbxWriteCommand::RemoveObjectLabelAssignment {
                    assignment_id: assignment_id.clone(),
                },
                MdbxWriteCommand::DeleteObjectLabel {
                    label_id: label_id.clone(),
                },
                MdbxWriteCommand::DeleteObjectRelation {
                    relation_id: relation_id.clone(),
                },
            ],
        )
        .unwrap();
    assert_eq!(deleted.relation_ids, vec![relation_id.clone()]);
    assert_eq!(deleted.label_ids, vec![label_id.clone()]);
    assert_eq!(deleted.label_assignment_ids, vec![assignment_id.clone()]);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 3);
    let conn = vault.conn.lock().unwrap();
    assert!(
        ObjectRelationRepo::get_by_id(&conn, &relation_id)
            .unwrap()
            .unwrap()
            .deleted
    );
    assert!(
        ObjectLabelRepo::get_by_id(&conn, &label_id)
            .unwrap()
            .unwrap()
            .deleted
    );
    assert!(
        ObjectLabelAssignmentRepo::get_by_id(&conn, &assignment_id)
            .unwrap()
            .unwrap()
            .deleted
    );
}

#[test]
fn generic_metadata_write_operation_rolls_back_and_enforces_bounds() {
    let vault = ffi_test_vault();
    let project = vault.create_project("Mail".to_string()).unwrap();
    let first = vault
        .create_object(
            project.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "First".to_string(),
            "{}".to_string(),
            1,
        )
        .unwrap();
    let second = vault
        .create_object(
            project.project_id.clone(),
            "com.monica.mail.message".to_string(),
            "Second".to_string(),
            "{}".to_string(),
            1,
        )
        .unwrap();
    let rolled_back_label_id = Uuid::new_v4().to_string();
    let commits_before = ffi_test_count(&vault, "commits");

    assert!(vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "mail-label-import".to_string(),
            vec![
                MdbxWriteCommand::CreateObjectLabel {
                    label_id: rolled_back_label_id.clone(),
                    collection_id: project.project_id.clone(),
                    name: "Rolled back".to_string(),
                    payload_json: "{}".to_string(),
                    payload_schema_version: 1,
                },
                MdbxWriteCommand::AssignObjectLabel {
                    assignment_id: Uuid::new_v4().to_string(),
                    object_id: Uuid::new_v4().to_string(),
                    label_id: rolled_back_label_id.clone(),
                },
            ],
        )
        .is_err());
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before);
    assert_eq!(ffi_test_count(&vault, "object_labels"), 0);

    let limits = MdbxWriteOperationLimits {
        max_commands: 1,
        max_payload_bytes_per_command: 8,
        max_payload_bytes: 8,
        max_intent_bytes: 4096,
    };
    assert!(vault
        .execute_write_operation_with_limits(
            Uuid::new_v4().to_string(),
            "mail-relation-import".to_string(),
            vec![MdbxWriteCommand::CreateObjectRelation {
                relation_id: Uuid::new_v4().to_string(),
                source_object_id: first.object_id.clone(),
                target_object_id: second.object_id.clone(),
                relation_kind: "com.monica.mail.reply-to".to_string(),
                payload_json: r#"{"position":1}"#.to_string(),
                payload_schema_version: 1,
            }],
            limits,
        )
        .unwrap_err()
        .to_string()
        .contains("command payload bytes"));
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before);
    assert_eq!(ffi_test_count(&vault, "object_relations"), 0);

    vault
        .set_extension_capabilities(vec!["com.monica.mail.store".to_string()])
        .unwrap();
    vault
        .set_collection_profile(
            project.project_id.clone(),
            "com.monica.mail".to_string(),
            b"profile".to_vec(),
            1,
            vec!["com.monica.mail.message".to_string()],
            vec!["com.monica.mail.store".to_string()],
        )
        .unwrap();
    vault.set_extension_capabilities(Vec::new()).unwrap();
    let commits_before_capability_failure = ffi_test_count(&vault, "commits");
    assert!(vault
        .execute_write_operation(
            Uuid::new_v4().to_string(),
            "mail-relation-import".to_string(),
            vec![MdbxWriteCommand::CreateObjectRelation {
                relation_id: Uuid::new_v4().to_string(),
                source_object_id: first.object_id,
                target_object_id: second.object_id,
                relation_kind: "com.monica.mail.reply-to".to_string(),
                payload_json: "{}".to_string(),
                payload_schema_version: 1,
            }],
        )
        .is_err());
    assert_eq!(
        ffi_test_count(&vault, "commits"),
        commits_before_capability_failure
    );
    assert_eq!(ffi_test_count(&vault, "object_relations"), 0);
}

#[test]
fn composite_write_operation_creates_parent_and_attachment_in_one_commit() {
    let vault = ffi_test_vault();
    let project_id = Uuid::new_v4().to_string();
    let entry_id = Uuid::new_v4().to_string();
    let attachment_id = Uuid::new_v4().to_string();
    let operation_id = Uuid::new_v4().to_string();
    let mut limits = default_composite_write_operation_limits();
    limits.write_limits.max_commands = 2;
    limits.write_limits.max_payload_bytes_per_command = 1024;
    limits.write_limits.max_payload_bytes = 1024;
    limits.write_limits.max_intent_bytes = 4096;
    limits.attachment_limits.max_commands = 1;
    limits.attachment_limits.max_plaintext_bytes_per_command = 64;
    limits.attachment_limits.max_plaintext_bytes = 64;
    limits.attachment_limits.chunk_size = 3;
    let generic_commands = vec![
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
    ];
    let attachment_commands = vec![MdbxAttachmentBatchCommand::Create {
        attachment_id: attachment_id.clone(),
        project_id: project_id.clone(),
        entry_id: Some(entry_id.clone()),
        file_name: "message.eml".to_string(),
        media_type: Some("message/rfc822".to_string()),
        content: b"mail body".to_vec(),
    }];
    let commits_before = ffi_test_count(&vault, "commits");
    let first = vault
        .execute_composite_write_operation_with_limits(
            operation_id.clone(),
            "mail-import".to_string(),
            generic_commands.clone(),
            attachment_commands.clone(),
            limits,
        )
        .unwrap();
    assert!(!first.operation.already_committed);
    assert_eq!(first.operation.project_ids, vec![project_id.clone()]);
    assert_eq!(first.operation.entry_ids, vec![entry_id.clone()]);
    assert_eq!(first.attachments.len(), 1);
    assert_eq!(first.attachments[0].attachment_id, attachment_id);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);
    {
        let conn = vault.conn.lock().unwrap();
        let project = ProjectRepo::get_by_id(&conn, &project_id).unwrap().unwrap();
        let entry = EntryRepo::get_by_id(&conn, &entry_id).unwrap().unwrap();
        let attachment = AttachmentRepo::get_by_id(&conn, &attachment_id)
            .unwrap()
            .unwrap();
        assert_eq!(project.head_commit_id, first.operation.commit_id);
        assert_eq!(entry.head_commit_id, first.operation.commit_id);
        assert_eq!(attachment.head_commit_id, first.operation.commit_id);
    }
    assert_eq!(
        vault
            .read_attachment_content(attachment_id.clone(), 64)
            .unwrap(),
        b"mail body"
    );

    let retry = vault
        .execute_composite_write_operation_with_limits(
            operation_id.clone(),
            "mail-import".to_string(),
            generic_commands.clone(),
            attachment_commands.clone(),
            limits,
        )
        .unwrap();
    assert!(retry.operation.already_committed);
    assert_eq!(retry.operation.commit_id, first.operation.commit_id);
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);

    let changed_attachment_commands = vec![MdbxAttachmentBatchCommand::Create {
        attachment_id,
        project_id: project_id.clone(),
        entry_id: Some(entry_id.clone()),
        file_name: "message.eml".to_string(),
        media_type: Some("message/rfc822".to_string()),
        content: b"changed body".to_vec(),
    }];
    assert!(vault
        .execute_composite_write_operation_with_limits(
            operation_id,
            "mail-import".to_string(),
            generic_commands,
            changed_attachment_commands,
            limits,
        )
        .unwrap_err()
        .to_string()
        .contains("reused for a different operation"));

    let failed_project_id = Uuid::new_v4().to_string();
    let failed_entry_id = Uuid::new_v4().to_string();
    let failed_attachment_id = Uuid::new_v4().to_string();
    assert!(vault
        .execute_composite_write_operation(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: failed_project_id.clone(),
                    title: "Rolled back".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: failed_entry_id.clone(),
                    project_id: failed_project_id.clone(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Failure".to_string(),
                    payload_json: "{}".to_string(),
                },
            ],
            vec![MdbxAttachmentBatchCommand::Create {
                attachment_id: failed_attachment_id.clone(),
                project_id: failed_project_id.clone(),
                entry_id: Some(Uuid::new_v4().to_string()),
                file_name: "failure.eml".to_string(),
                media_type: None,
                content: b"failure".to_vec(),
            }],
        )
        .is_err());
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);
    {
        let conn = vault.conn.lock().unwrap();
        assert!(ProjectRepo::get_by_id(&conn, &failed_project_id)
            .unwrap()
            .is_none());
        assert!(EntryRepo::get_by_id(&conn, &failed_entry_id)
            .unwrap()
            .is_none());
        assert!(AttachmentRepo::get_by_id(&conn, &failed_attachment_id)
            .unwrap()
            .is_none());
    }

    let bounded_project_id = Uuid::new_v4().to_string();
    let bounded_entry_id = Uuid::new_v4().to_string();
    let mut bounded_limits = default_composite_write_operation_limits();
    bounded_limits.write_limits.max_commands = 2;
    bounded_limits.write_limits.max_payload_bytes_per_command = 1024;
    bounded_limits.write_limits.max_payload_bytes = 1024;
    bounded_limits.write_limits.max_intent_bytes = 4096;
    bounded_limits.attachment_limits.max_commands = 1;
    bounded_limits
        .attachment_limits
        .max_plaintext_bytes_per_command = 4;
    bounded_limits.attachment_limits.max_plaintext_bytes = 4;
    bounded_limits.attachment_limits.chunk_size = 2;
    assert!(vault
        .execute_composite_write_operation_with_limits(
            Uuid::new_v4().to_string(),
            "mail-import".to_string(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: bounded_project_id.clone(),
                    title: "Bounded".to_string(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: bounded_entry_id.clone(),
                    project_id: bounded_project_id.clone(),
                    entry_type: "com.monica.mail.message".to_string(),
                    title: "Bounded".to_string(),
                    payload_json: "{}".to_string(),
                },
            ],
            vec![MdbxAttachmentBatchCommand::Create {
                attachment_id: Uuid::new_v4().to_string(),
                project_id: bounded_project_id.clone(),
                entry_id: Some(bounded_entry_id),
                file_name: "oversized.eml".to_string(),
                media_type: None,
                content: b"12345".to_vec(),
            }],
            bounded_limits,
        )
        .unwrap_err()
        .to_string()
        .contains("command plaintext bytes"));
    assert_eq!(ffi_test_count(&vault, "commits"), commits_before + 1);
    let conn = vault.conn.lock().unwrap();
    assert!(ProjectRepo::get_by_id(&conn, &bounded_project_id)
        .unwrap()
        .is_none());
}

#[test]
fn every_write_command_has_a_typed_change_summary() {
    let commands = vec![
        MdbxWriteCommand::CreateProject {
            project_id: "project".to_string(),
            title: "Project".to_string(),
        },
        MdbxWriteCommand::CreateProjectWithParent {
            project_id: "project-child".to_string(),
            title: "Child".to_string(),
            parent_project_id: Some("project".to_string()),
        },
        MdbxWriteCommand::RenameProject {
            project_id: "project-renamed".to_string(),
            title: "Renamed".to_string(),
        },
        MdbxWriteCommand::MoveProject {
            project_id: "project-moved".to_string(),
            parent_project_id: Some("project".to_string()),
        },
        MdbxWriteCommand::DeleteProject {
            project_id: "project-deleted".to_string(),
        },
        MdbxWriteCommand::RestoreProject {
            project_id: "project-restored".to_string(),
            parent_project_id: None,
        },
        MdbxWriteCommand::CreateEntry {
            entry_id: "created".to_string(),
            project_id: "project".to_string(),
            entry_type: "login".to_string(),
            title: "Created".to_string(),
            payload_json: "{}".to_string(),
        },
        MdbxWriteCommand::UpdateEntry {
            entry_id: "updated".to_string(),
            project_id: "project".to_string(),
            entry_type: "login".to_string(),
            title: "Updated".to_string(),
            payload_json: "{}".to_string(),
        },
        MdbxWriteCommand::DeleteEntry {
            entry_id: "deleted".to_string(),
            project_id: "project".to_string(),
        },
        MdbxWriteCommand::RestoreEntry {
            entry_id: "restored".to_string(),
            project_id: "project".to_string(),
        },
        MdbxWriteCommand::MoveEntry {
            entry_id: "moved".to_string(),
            project_id: "project".to_string(),
            target_project_id: "target".to_string(),
        },
        MdbxWriteCommand::CreateObjectRelation {
            relation_id: "relation-created".to_string(),
            source_object_id: "source".to_string(),
            target_object_id: "target".to_string(),
            relation_kind: "com.monica.test.relation".to_string(),
            payload_json: "{}".to_string(),
            payload_schema_version: 1,
        },
        MdbxWriteCommand::UpdateObjectRelation {
            relation_id: "relation-updated".to_string(),
            relation_kind: "com.monica.test.relation".to_string(),
            payload_json: "{}".to_string(),
            payload_schema_version: 2,
        },
        MdbxWriteCommand::DeleteObjectRelation {
            relation_id: "relation-deleted".to_string(),
        },
        MdbxWriteCommand::CreateObjectLabel {
            label_id: "label-created".to_string(),
            collection_id: "project".to_string(),
            name: "Created".to_string(),
            payload_json: "{}".to_string(),
            payload_schema_version: 1,
        },
        MdbxWriteCommand::UpdateObjectLabel {
            label_id: "label-updated".to_string(),
            name: "Updated".to_string(),
            payload_json: "{}".to_string(),
            payload_schema_version: 2,
        },
        MdbxWriteCommand::DeleteObjectLabel {
            label_id: "label-deleted".to_string(),
        },
        MdbxWriteCommand::AssignObjectLabel {
            assignment_id: "assignment-created".to_string(),
            object_id: "created".to_string(),
            label_id: "label-created".to_string(),
        },
        MdbxWriteCommand::RemoveObjectLabelAssignment {
            assignment_id: "assignment-deleted".to_string(),
        },
    ];

    let changes = write_operation_changes(&commands);
    let actions = changes
        .iter()
        .map(|change| change.action.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        actions,
        vec![
            "create", "create", "update", "move", "delete", "restore", "create", "update",
            "delete", "restore", "move", "create", "update", "delete", "create", "update",
            "delete", "create", "delete"
        ]
    );
    assert_eq!(changes[0].fields, vec!["title"]);
    assert_eq!(changes[1].fields, vec!["title", "group_id"]);
    assert_eq!(changes[2].fields, vec!["title"]);
    assert_eq!(changes[3].fields, vec!["group_id"]);
    assert_eq!(changes[4].fields, vec!["deleted"]);
    assert_eq!(changes[5].fields, vec!["deleted", "group_id"]);
    assert_eq!(
        changes[6].fields,
        vec!["project_id", "entry_type", "title", "payload"]
    );
    assert_eq!(changes[7].fields, vec!["title", "payload"]);
    assert_eq!(changes[8].fields, vec!["deleted"]);
    assert_eq!(changes[9].fields, vec!["deleted"]);
    assert_eq!(changes[10].fields, vec!["project_id"]);
    assert_eq!(
        changes[11].fields,
        vec![
            "source_object_id",
            "target_object_id",
            "relation_kind",
            "payload",
            "payload_schema_version"
        ]
    );
    assert_eq!(
        changes[12].fields,
        vec!["relation_kind", "payload", "payload_schema_version"]
    );
    assert_eq!(changes[13].fields, vec!["deleted"]);
    assert_eq!(
        changes[14].fields,
        vec!["collection_id", "name", "payload", "payload_schema_version"]
    );
    assert_eq!(
        changes[15].fields,
        vec!["name", "payload", "payload_schema_version"]
    );
    assert_eq!(changes[16].fields, vec!["deleted"]);
    assert_eq!(changes[17].fields, vec!["object_id", "label_id"]);
    assert_eq!(changes[18].fields, vec!["deleted"]);
}
