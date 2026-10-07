//! Synthetic Android 1.0.315 contract fixtures against the actual vendored engine.
use super::*;

const PASSWORD: &str = "synthetic-android-315-only";

#[test]
fn complete_backup_archive_restores_active_deleted_and_chunked_content_without_live_reads() {
    let (root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let object = vault.create_object(collection.clone(), "login".into(), "backup".into(), PRECISE_PAYLOAD.into(), 1).unwrap();
    let active = fresh_uuid();
    let deleted = fresh_uuid();
    let content = vec![42; 300_007];
    for id in [&active, &deleted] {
        vault.create_attachment_with_external_content(fresh_uuid(), MdbxAttachmentCreateRequest {
            attachment_id: id.clone(), project_id: collection.clone(), entry_id: Some(object.object_id.clone()),
            file_name: "synthetic.bin".into(), media_type: None,
        }, content.clone(), MdbxAttachmentContentLimits { chunk_size: 65_536, max_plaintext_bytes: 1_048_576 }).unwrap();
    }
    vault.delete_attachment(deleted.clone()).unwrap();
    let original_payload = read(&mut runtime, &handle, &object.object_id)["payloadJson"].clone();
    let revision = runtime.handle("vault.writeRevision", json!({ "vaultHandle":handle })).unwrap();
    let prepared = runtime.handle("vault.export.begin", json!({ "vaultHandle":handle })).unwrap();
    assert_eq!(prepared["format"], "zip");
    assert!(prepared["blobCount"].as_u64().unwrap() >= 10);
    assert_eq!(runtime.handle("vault.writeRevision", json!({ "vaultHandle":handle })).unwrap(), revision);
    // Changing source after begin must not affect any downloaded archive byte.
    let later = vault.create_object(collection.clone(), "login".into(), "later".into(), "{}".into(), 1).unwrap();
    let mut bytes = Vec::new();
    loop {
        let chunk = runtime.handle("vault.export.read", json!({ "vaultHandle":handle, "fileHandle":prepared["fileHandle"],
            "offset":bytes.len(), "maxBytes":MAX_BINARY_CHUNK_BYTES })).unwrap();
        bytes.extend(BASE64.decode(chunk["dataBase64"].as_str().unwrap()).unwrap());
        if chunk["eof"] == true { break; }
    }
    assert_eq!(sha256_hex(&bytes), prepared["sha256"].as_str().unwrap());
    let begin = runtime.handle("transfer.begin", json!({ "direction":"extension-to-host", "purpose":"vault-bootstrap", "sizeBytes":bytes.len(), "sha256":sha256_hex(&bytes) })).unwrap();
    for (index, chunk) in bytes.chunks(MAX_BINARY_CHUNK_BYTES).enumerate() {
        runtime.handle("transfer.chunk", json!({ "transferId":begin["transferId"], "offset":index * MAX_BINARY_CHUNK_BYTES,
            "dataBase64":BASE64.encode(chunk) })).unwrap();
    }
    let finished = runtime.handle("transfer.finish", json!({ "transferId":begin["transferId"] })).unwrap();
    let input_handle = finished["fileHandle"].as_str().unwrap();
    let source = json!({ "kind":"file", "handle":input_handle });
    runtime.handle("vault.inspect", json!({ "source":source })).unwrap();
    assert!(runtime.handle("vault.open", json!({ "source":source, "credential":{"method":"password","password":"wrong"} })).is_err());
    let opened = runtime.handle("vault.open", json!({ "source":source, "credential":{"method":"password","password":PASSWORD} })).unwrap();
    let imported = runtime.require_open_vault(opened["vaultHandle"].as_str().unwrap()).unwrap();
    assert!(imported.get_object_summary(later.object_id).unwrap().is_none());
    assert_eq!(imported.read_attachment_content(active.clone(), 1_048_576).unwrap(), content);
    assert_eq!(imported.list_external_blob_references(None, 200).unwrap().unique_reference_count, prepared["blobCount"].as_u64().unwrap());
    assert_eq!(read(&mut runtime, opened["vaultHandle"].as_str().unwrap(), &object.object_id)["payloadJson"], original_payload);
    assert_eq!(runtime.handle("transfer.release", json!({"fileHandle":input_handle})).unwrap()["released"], true);
    assert!(!root.path().join("imports").join(input_handle).exists());
    assert_eq!(imported.read_attachment_content(active, 1_048_576).unwrap(), content);
    runtime.handle("vault.lock", json!({"vaultHandle":handle})).unwrap();
    assert!(runtime.handle("vault.export.read", json!({ "vaultHandle":handle, "fileHandle":prepared["fileHandle"], "offset":0,"maxBytes":64 })).is_err());
    assert_eq!(runtime.handle("vault.export.release", json!({"fileHandle":prepared["fileHandle"]})).unwrap()["released"], false);
    assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("complete-backup-")));
}

#[test]
fn complete_backup_missing_or_corrupt_blob_fails_without_output_or_source_mutation() {
    let (root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let attachment = fresh_uuid();
    vault.create_attachment_with_external_content(fresh_uuid(), MdbxAttachmentCreateRequest {
        attachment_id: attachment, project_id: collection, entry_id: None, file_name: "synthetic".into(), media_type: None,
    }, b"precious synthetic content".to_vec(), MdbxAttachmentContentLimits { chunk_size: 65536, max_plaintext_bytes: 1048576 }).unwrap();
    let reference = &vault.list_external_blob_references(None, 10).unwrap().items[0];
    let id = &reference.blob_id;
    let path = root.path().join("vaults").join(&handle).join("vault.mdbx.blobs").join(&id[..2]).join(&id[2..4]).join(id);
    let original = fs::read(&path).unwrap();
    let revision = runtime.handle("vault.writeRevision", json!({"vaultHandle":handle})).unwrap();
    for corrupt in [true, false] {
        if corrupt { fs::write(&path, vec![0; original.len()]).unwrap(); } else { fs::remove_file(&path).unwrap(); }
        assert!(runtime.handle("vault.export.begin", json!({"vaultHandle":handle})).is_err());
        assert_eq!(runtime.handle("vault.writeRevision", json!({"vaultHandle":handle})).unwrap(), revision);
        assert!(!fs::read_dir(root.path()).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with("complete-backup-")));
    }
    fs::write(&path, original).unwrap();
}
const PRECISE_PAYLOAD: &str = r#"{"monica_entry_id":"password:android-315","password_plain":"","notes":"before","counter":18446744073709551615,"big":9007199254740993,"decimal":0.12345678901234567890123456789,"future":{"$serde_json::private::Number":"literal","$serde_json::private::RawValue":"verbatim","null":null,"empty":"","enabled":false},"array":[null,9007199254740993,"中文"]}"#;

#[test]
fn batch_restore_preserves_all_members_and_replays_without_reviving_a_later_delete() {
    let (root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let mut ids = Vec::new();
    let mut originals = Vec::new();
    for n in 0..3 {
        let object = vault
            .create_object(
                collection.clone(),
                "login".into(),
                format!("member-{n}"),
                PRECISE_PAYLOAD.replace(
                    "password:android-315",
                    &format!("password:batch-restore-{n}"),
                ),
                1,
            )
            .unwrap();
        originals.push(read(&mut runtime, &handle, &object.object_id));
        ids.push(object.object_id);
    }
    let attachment = fresh_uuid();
    vault
        .create_attachment_with_external_content(
            fresh_uuid(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment.clone(),
                project_id: collection.clone(),
                entry_id: Some(ids[0].clone()),
                file_name: "shared.txt".into(),
                media_type: Some("text/plain".into()),
            },
            b" shared\r\n0007 ".to_vec(),
            MdbxAttachmentContentLimits {
                chunk_size: MAX_BINARY_CHUNK_BYTES as u64,
                max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
            },
        )
        .unwrap();
    let deleted = runtime.handle("object.batch", json!({ "vaultHandle": handle, "operationScope": "1".repeat(64),
        "mutations": ids.iter().zip(&originals).map(|(id, before)| json!({ "kind": "delete",
            "logicalObjectId": format!("native:{id}"), "expectedHeadCommitId": before["headCommitId"] })).collect::<Vec<_>>() })).unwrap();
    let revision = runtime
        .handle("vault.writeRevision", json!({"vaultHandle":handle}))
        .unwrap();
    let request = json!({ "vaultHandle": handle, "operationScope": "2".repeat(64), "writeRevision": revision,
        "objects": ids.iter().map(|id| json!({ "objectId": id, "collectionId": collection, "objectTypeId":"login",
            "expectedHeadCommitId": deleted["commitId"] })).collect::<Vec<_>>() });
    for mode in [
        "wrong-head",
        "wrong-collection",
        "wrong-type",
        "duplicate",
        "missing-revision",
        "payload",
        "empty",
        "oversize",
    ] {
        let mut bad = request.clone();
        bad["operationScope"] = json!(sha256_hex(mode.as_bytes()));
        match mode {
            "wrong-head" => bad["objects"][2]["expectedHeadCommitId"] = json!(fresh_uuid()),
            "wrong-collection" => bad["objects"][2]["collectionId"] = json!(fresh_uuid()),
            "wrong-type" => bad["objects"][2]["objectTypeId"] = json!("note"),
            "duplicate" => bad["objects"][2] = bad["objects"][0].clone(),
            "missing-revision" => {
                bad.as_object_mut().unwrap().remove("writeRevision");
            }
            "payload" => bad["objects"][2]["payloadJson"] = json!("{}"),
            "empty" => bad["objects"] = json!([]),
            "oversize" => {
                bad["objects"] = json!(vec![
                    request["objects"][0].clone();
                    MAX_OBJECT_BATCH_MUTATIONS + 1
                ])
            }
            _ => unreachable!(),
        }
        assert!(
            runtime.handle("object.restoreBatch", bad).is_err(),
            "{mode}"
        );
        assert_eq!(
            runtime
                .handle("vault.writeRevision", json!({"vaultHandle":handle}))
                .unwrap(),
            revision,
            "{mode}"
        );
        for id in &ids {
            assert!(
                vault
                    .get_object_summary(id.clone())
                    .unwrap()
                    .unwrap()
                    .deleted,
                "{mode}"
            );
        }
    }
    let restored = runtime
        .handle("object.restoreBatch", request.clone())
        .unwrap();
    assert_eq!(restored["items"].as_array().unwrap().len(), 3);
    for (id, original) in ids.iter().zip(&originals) {
        let after = read(&mut runtime, &handle, id);
        assert_eq!(after["payloadJson"], original["payloadJson"]);
        assert_eq!(after["collectionId"], original["collectionId"]);
        assert_eq!(after["headCommitId"], restored["commitId"]);
        assert_eq!(after["deleted"], false);
    }
    assert_eq!(
        vault
            .read_attachment_content(attachment.clone(), 1024)
            .unwrap(),
        b" shared\r\n0007 "
    );
    // A retry must acknowledge the original commit even if a later command deleted a member.
    let later = runtime.handle("object.delete", json!({ "vaultHandle":handle, "operationId":fresh_uuid(),
        "logicalObjectId":format!("native:{}", ids[1]), "expectedHeadCommitId":restored["commitId"] })).unwrap();
    let operation_id = restored["operationId"].as_str().unwrap();
    runtime
        .object_operations
        .receipts
        .iter_mut()
        .find(|row| row.operation_id == operation_id)
        .unwrap()
        .commit_id = None;
    runtime.persist_object_operations().unwrap();
    drop(vault);
    drop(runtime);
    let mut reopened = HostRuntime::new(root.path().to_path_buf()).unwrap();
    reopened
        .handle(
            "vault.open",
            json!({"source":{"kind":"vault","handle":handle},
        "credential":{"method":"password","password":PASSWORD}}),
        )
        .unwrap();
    let replay = reopened
        .handle("object.restoreBatch", request.clone())
        .unwrap();
    assert_eq!(replay["alreadyCommitted"], true);
    assert_eq!(replay["commitId"], restored["commitId"]);
    assert_eq!(replay["operationId"], restored["operationId"]);
    assert_eq!(replay["items"], restored["items"]);
    let vault = reopened.require_open_vault(&handle).unwrap();
    let tombstone = vault.get_object_summary(ids[1].clone()).unwrap().unwrap();
    assert!(tombstone.deleted);
    assert_eq!(
        tombstone.head_commit_id,
        later["commitId"].as_str().unwrap()
    );
    assert_eq!(
        vault.read_attachment_content(attachment, 1024).unwrap(),
        b" shared\r\n0007 "
    );
    let mut changed = request;
    changed["objects"][2]["expectedHeadCommitId"] = later["commitId"].clone();
    assert_eq!(
        reopened
            .handle("object.restoreBatch", changed)
            .unwrap_err()
            .code,
        "object-operation-intent-mismatch"
    );
}

#[test]
fn batch_restore_refuses_a_deleted_parent_without_restoring_other_members() {
    let (_root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let other_collection = vault
        .create_project("Deleted parent".into())
        .unwrap()
        .project_id;
    let mut objects = Vec::new();
    for folder in [&collection, &other_collection] {
        let item = vault
            .create_object(
                folder.clone(),
                "login".into(),
                "deleted member".into(),
                PRECISE_PAYLOAD.into(),
                1,
            )
            .unwrap();
        let head = vault
            .get_object_summary(item.object_id.clone())
            .unwrap()
            .unwrap()
            .head_commit_id;
        let deletion = runtime
            .handle(
                "object.delete",
                json!({"vaultHandle":handle,"operationId":fresh_uuid(),
            "logicalObjectId":format!("native:{}",item.object_id),"expectedHeadCommitId":head}),
            )
            .unwrap();
        objects.push(json!({"objectId":item.object_id,"collectionId":folder,"objectTypeId":"login","expectedHeadCommitId":deletion["commitId"]}));
    }
    runtime.handle("collection.delete", json!({"vaultHandle":handle,"operationId":fresh_uuid(),"collectionId":other_collection})).unwrap();
    let revision = runtime
        .handle("vault.writeRevision", json!({"vaultHandle":handle}))
        .unwrap();
    let error = runtime
        .handle(
            "object.restoreBatch",
            json!({"vaultHandle":handle,"operationScope":"4".repeat(64),
        "writeRevision":revision,"objects":objects}),
        )
        .unwrap_err();
    assert_eq!(error.code, "object-restore-collection-deleted");
    assert_eq!(
        runtime
            .handle("vault.writeRevision", json!({"vaultHandle":handle}))
            .unwrap(),
        revision
    );
    for item in &objects {
        assert!(
            vault
                .get_object_summary(item["objectId"].as_str().unwrap().into())
                .unwrap()
                .unwrap()
                .deleted
        );
    }
    assert!(
        vault
            .get_collection_summary(other_collection)
            .unwrap()
            .unwrap()
            .deleted
    );
}

#[test]
fn batch_restore_engine_rolls_back_and_checks_revision_from_another_connection() {
    let (root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let object = vault
        .create_object(
            collection.clone(),
            "login".into(),
            "restore".into(),
            PRECISE_PAYLOAD.into(),
            1,
        )
        .unwrap();
    let active = vault
        .create_object(
            collection.clone(),
            "note".into(),
            "active".into(),
            "{}".into(),
            1,
        )
        .unwrap();
    let head = vault
        .get_object_summary(object.object_id.clone())
        .unwrap()
        .unwrap()
        .head_commit_id;
    let deleted = runtime
        .handle(
            "object.delete",
            json!({"vaultHandle":handle,"operationId":fresh_uuid(),
        "logicalObjectId":format!("native:{}",object.object_id),"expectedHeadCommitId":head}),
        )
        .unwrap();
    let before = vault.read_write_revision().unwrap();
    let commands = vec![
        MdbxWriteCommand::RestoreEntry {
            entry_id: object.object_id.clone(),
            project_id: collection.clone(),
        },
        MdbxWriteCommand::RestoreEntry {
            entry_id: active.object_id,
            project_id: collection.clone(),
        },
    ];
    // The first command is valid, the second fails inside the same engine transaction.
    assert!(vault
        .execute_write_operation_at_revision(
            fresh_uuid(),
            "synthetic-restore-rollback".into(),
            commands,
            before.clone()
        )
        .is_err());
    assert!(
        vault
            .get_object_summary(object.object_id.clone())
            .unwrap()
            .unwrap()
            .deleted
    );
    assert_eq!(vault.read_write_revision().unwrap(), before);
    let other = mdbx_ffi::open_vault(
        path_string(&root.path().join("vaults").join(&handle).join("vault.mdbx")).unwrap(),
        PASSWORD.into(),
        "synthetic-other-connection".into(),
    )
    .unwrap();
    other
        .create_object(
            collection.clone(),
            "note".into(),
            "late".into(),
            "{}".into(),
            1,
        )
        .unwrap();
    let request = json!({"vaultHandle":handle,"operationScope":"3".repeat(64),
        "writeRevision":{"vaultId":before.vault_id,"revisionSha256":before.revision_sha256},
        "objects":[{"objectId":object.object_id,"collectionId":collection,"objectTypeId":"login","expectedHeadCommitId":deleted["commitId"]}]});
    assert_eq!(
        runtime
            .handle("object.restoreBatch", request)
            .unwrap_err()
            .code,
        "vault-revision-conflict"
    );
    assert!(
        vault
            .get_object_summary(object.object_id)
            .unwrap()
            .unwrap()
            .deleted
    );
}

#[test]
fn explicit_restore_preserves_raw_payload_and_replays_core_commit_after_receipt_loss() {
    let (root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let object = vault
        .create_object(
            collection.clone(),
            "login".into(),
            "Restore original".into(),
            PRECISE_PAYLOAD.into(),
            1,
        )
        .unwrap();
    let before = read(&mut runtime, &handle, &object.object_id);
    let deleted = runtime.handle("object.delete", json!({ "vaultHandle": handle, "operationId": fresh_uuid(),
        "logicalObjectId": format!("native:{}", object.object_id), "expectedHeadCommitId": before["headCommitId"] })).unwrap();
    let mut restore = json!({ "vaultHandle": handle, "operationScope": "a".repeat(64), "objectId": object.object_id,
        "collectionId": collection, "objectTypeId": "login", "expectedHeadCommitId": deleted["commitId"],
        "writeRevision": runtime.handle("vault.writeRevision", json!({"vaultHandle": handle})).unwrap() });
    vault
        .create_object(
            collection.clone(),
            "note".into(),
            "Interleaved".into(),
            "{}".into(),
            1,
        )
        .unwrap();
    assert_eq!(
        runtime
            .handle("object.restore", restore.clone())
            .unwrap_err()
            .code,
        "vault-revision-conflict"
    );
    assert!(
        vault
            .get_object_summary(object.object_id.clone())
            .unwrap()
            .unwrap()
            .deleted
    );
    restore["operationScope"] = json!("b".repeat(64));
    restore["writeRevision"] = runtime
        .handle("vault.writeRevision", json!({"vaultHandle": handle}))
        .unwrap();
    let restored = runtime.handle("object.restore", restore.clone()).unwrap();
    let after = read(&mut runtime, &handle, &object.object_id);
    assert_eq!(after["payloadJson"], before["payloadJson"]);
    assert_eq!(after["collectionId"], before["collectionId"]);
    assert_eq!(after["deleted"], false);
    assert_eq!(after["headCommitId"], restored["commitId"]);
    let operation_id = restored["operationId"].as_str().unwrap();
    runtime
        .object_operations
        .receipts
        .iter_mut()
        .find(|receipt| receipt.operation_id == operation_id)
        .unwrap()
        .commit_id = None;
    runtime.persist_object_operations().unwrap();
    drop(vault);
    drop(runtime);
    let mut reopened = HostRuntime::new(root.path().to_path_buf()).unwrap();
    reopened.handle("vault.open", json!({"source": {"kind":"vault", "handle":handle}, "credential": {"method":"password", "password":PASSWORD}})).unwrap();
    let replay = reopened.handle("object.restore", restore.clone()).unwrap();
    assert_eq!(replay["alreadyCommitted"], true);
    assert_eq!(replay["commitId"], restored["commitId"]);
    assert_eq!(replay["operationId"], restored["operationId"]);
    let mut changed = restore.clone();
    changed["writeRevision"]["revisionSha256"] = json!("f".repeat(64));
    assert_eq!(
        reopened.handle("object.restore", changed).unwrap_err().code,
        "object-operation-intent-mismatch"
    );
    let mut changed = restore;
    changed["operationScope"] = json!("c".repeat(64));
    changed["expectedHeadCommitId"] = restored["commitId"].clone();
    changed["writeRevision"] = reopened
        .handle("vault.writeRevision", json!({"vaultHandle":handle}))
        .unwrap();
    assert_eq!(
        reopened.handle("object.restore", changed).unwrap_err().code,
        "object-restore-state-changed"
    );
}

#[test]
fn project_removal_revision_rejects_attachment_only_changes_and_replays_after_restart() {
    let (root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let source = vault
        .create_object(
            collection.clone(),
            "login".into(),
            "source".into(),
            PRECISE_PAYLOAD.into(),
            1,
        )
        .unwrap();
    let target = vault
        .create_object(
            collection.clone(),
            "login".into(),
            "target".into(),
            PRECISE_PAYLOAD.into(),
            1,
        )
        .unwrap();
    let attachment_id = fresh_uuid();
    let limits = MdbxAttachmentContentLimits {
        chunk_size: MAX_BINARY_CHUNK_BYTES as u64,
        max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
    };
    vault
        .create_attachment_with_external_content(
            fresh_uuid(),
            MdbxAttachmentCreateRequest {
                attachment_id: attachment_id.clone(),
                project_id: collection.clone(),
                entry_id: Some(target.object_id.clone()),
                file_name: "shared.txt".into(),
                media_type: Some("text/plain".into()),
            },
            b"good".to_vec(),
            limits,
        )
        .unwrap();
    let source_before = read(&mut runtime, &handle, &source.object_id);
    let target_before = read(&mut runtime, &handle, &target.object_id);
    let revision = runtime
        .handle("vault.writeRevision", json!({"vaultHandle": handle}))
        .unwrap();
    let batch = json!({ "vaultHandle": handle, "operationScope": "a".repeat(64), "writeRevision": revision,
        "mutations": [{"kind":"delete", "logicalObjectId": format!("native:{}", source.object_id), "expectedHeadCommitId": source_before["headCommitId"]}] });
    vault
        .replace_attachment_external_content(
            fresh_uuid(),
            attachment_id.clone(),
            b"evil".to_vec(),
            limits,
        )
        .unwrap();
    assert_eq!(
        read(&mut runtime, &handle, &target.object_id),
        target_before
    );
    assert_ne!(
        runtime
            .handle("vault.writeRevision", json!({"vaultHandle": handle}))
            .unwrap(),
        revision
    );
    assert_eq!(
        runtime
            .handle("object.batch", batch.clone())
            .unwrap_err()
            .code,
        "vault-revision-conflict"
    );
    assert_eq!(
        read(&mut runtime, &handle, &source.object_id),
        source_before
    );
    vault
        .replace_attachment_external_content(
            fresh_uuid(),
            attachment_id.clone(),
            b"good".to_vec(),
            limits,
        )
        .unwrap();
    let mut verified = batch.clone();
    verified["operationScope"] = json!("b".repeat(64));
    verified["writeRevision"] = runtime
        .handle("vault.writeRevision", json!({"vaultHandle": handle}))
        .unwrap();
    let deleted = runtime.handle("object.batch", verified.clone()).unwrap();
    assert_eq!(deleted["changed"], true);
    assert_eq!(
        read(&mut runtime, &handle, &target.object_id),
        target_before
    );
    assert_eq!(
        vault
            .read_attachment_content(attachment_id.clone(), 1024)
            .unwrap(),
        b"good"
    );
    assert!(
        vault
            .get_object_summary(source.object_id.clone())
            .unwrap()
            .unwrap()
            .deleted
    );
    drop(vault);
    drop(runtime);
    let mut restarted = HostRuntime::new(root.path().to_path_buf()).unwrap();
    restarted.handle("vault.open", json!({"source":{"kind":"vault","handle":handle},"credential":{"method":"password","password":PASSWORD}})).unwrap();
    let retry = restarted.handle("object.batch", verified.clone()).unwrap();
    assert_eq!(retry["commitId"], deleted["commitId"]);
    assert_eq!(retry["alreadyCommitted"], true);
    let mut wrong_proof = verified.clone();
    wrong_proof["writeRevision"]["revisionSha256"] = json!("c".repeat(64));
    assert_eq!(
        restarted
            .handle("object.batch", wrong_proof)
            .unwrap_err()
            .code,
        "object-operation-intent-mismatch"
    );
    let mut wrong_vault = verified;
    wrong_vault["writeRevision"]["vaultId"] = json!(fresh_uuid());
    assert_eq!(
        restarted
            .handle("object.batch", wrong_vault)
            .unwrap_err()
            .code,
        "vault-revision-conflict"
    );
    restarted
        .handle("vault.lock", json!({"vaultHandle":handle}))
        .unwrap();
    assert_eq!(
        restarted
            .handle("vault.writeRevision", json!({"vaultHandle":handle}))
            .unwrap_err()
            .code,
        "vault-locked"
    );
}

#[test]
fn project_removal_revision_is_checked_inside_engine_transaction_across_connections() {
    let (root, runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let first = vault
        .create_object(
            collection.clone(),
            "login".into(),
            "one".into(),
            PRECISE_PAYLOAD.into(),
            1,
        )
        .unwrap();
    let second = vault
        .create_object(
            collection.clone(),
            "login".into(),
            "two".into(),
            PRECISE_PAYLOAD.into(),
            1,
        )
        .unwrap();
    let expected = vault.read_write_revision().unwrap();
    let other = mdbx_ffi::open_vault(
        path_string(&root.path().join("vaults").join(&handle).join("vault.mdbx")).unwrap(),
        PASSWORD.into(),
        "other-synthetic-connection".into(),
    )
    .unwrap();
    other
        .create_attachment_with_external_content(
            fresh_uuid(),
            MdbxAttachmentCreateRequest {
                attachment_id: fresh_uuid(),
                project_id: collection.clone(),
                entry_id: Some(second.object_id.clone()),
                file_name: "new.txt".into(),
                media_type: None,
            },
            b"late".to_vec(),
            MdbxAttachmentContentLimits {
                chunk_size: MAX_BINARY_CHUNK_BYTES as u64,
                max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
            },
        )
        .unwrap();
    assert_ne!(vault.read_write_revision().unwrap(), expected);
    let commands = vec![
        MdbxWriteCommand::DeleteEntry {
            entry_id: first.object_id.clone(),
            project_id: collection.clone(),
        },
        MdbxWriteCommand::DeleteEntry {
            entry_id: second.object_id.clone(),
            project_id: collection,
        },
    ];
    let rejected = vault
        .execute_write_operation_at_revision(
            fresh_uuid(),
            "synthetic-guarded-delete".into(),
            commands.clone(),
            expected,
        )
        .unwrap_err();
    assert!(rejected.to_string().contains("write revision changed"));
    for id in [first.object_id.clone(), second.object_id.clone()] {
        assert!(!vault.get_object_summary(id).unwrap().unwrap().deleted);
    }
    let operation_id = fresh_uuid();
    let verified = vault.read_write_revision().unwrap();
    let result = vault
        .execute_write_operation_at_revision(
            operation_id.clone(),
            "synthetic-guarded-delete".into(),
            commands.clone(),
            verified.clone(),
        )
        .unwrap();
    let replay = vault
        .execute_write_operation_at_revision(
            operation_id.clone(),
            "synthetic-guarded-delete".into(),
            commands.clone(),
            verified,
        )
        .unwrap();
    assert_eq!(replay.commit_id, result.commit_id);
    assert!(replay.already_committed);
    // Core's authenticated receipt itself binds the revision, even without Host sidecar state.
    assert!(vault
        .execute_write_operation_at_revision(
            operation_id,
            "synthetic-guarded-delete".into(),
            commands,
            vault.read_write_revision().unwrap()
        )
        .is_err());
}

fn fixture() -> (tempfile::TempDir, HostRuntime, String, String) {
    let root = tempfile::tempdir().unwrap();
    let mut runtime = HostRuntime::new(root.path().to_path_buf()).unwrap();
    let source = mdbx_ffi::create_vault(
        path_string(&root.path().join("synthetic-source.mdbx")).unwrap(),
        PASSWORD.to_string(),
        "interop-315-device".to_string(),
    )
    .unwrap();
    let file_handle = fresh_uuid();
    source
        .create_backup(path_string(&runtime.import_file_path(&file_handle)).unwrap())
        .unwrap();
    drop(source);
    let opened = runtime
        .handle(
            "vault.open",
            json!({
                "source": {"kind": "file", "handle": file_handle},
                "credential": {"method": "password", "password": PASSWORD}
            }),
        )
        .unwrap();
    let handle = opened["vaultHandle"].as_str().unwrap().to_string();
    let collection = runtime
        .require_open_vault(&handle)
        .unwrap()
        .create_project("Interop fixture".to_string())
        .unwrap()
        .project_id;
    (root, runtime, handle, collection)
}

fn read(runtime: &mut HostRuntime, handle: &str, id: &str) -> Value {
    runtime
        .handle(
            "object.reveal",
            json!({"vaultHandle": handle, "objectId": id}),
        )
        .unwrap()
}

fn upsert(handle: &str, collection: &str, id: &str, head: &str, payload: &str) -> Value {
    json!({
        "vaultHandle": handle, "operationId": fresh_uuid(),
        "logicalObjectId": format!("native:{id}"), "collectionId": collection,
        "objectTypeId": "login", "payloadSchemaVersion": 1,
        "expectedHeadCommitId": head, "title": "Synthetic native record",
        "payloadJson": payload
    })
}

#[test]
fn android315_native_edit_preserves_identity_json_lexemes_revision_and_restart() {
    let (root, mut runtime, handle, collection) = fixture();
    let object = runtime
        .require_open_vault(&handle)
        .unwrap()
        .create_object(
            collection.clone(),
            "login".to_string(),
            "Android fixture".to_string(),
            PRECISE_PAYLOAD.to_string(),
            1,
        )
        .unwrap();
    let before = read(&mut runtime, &handle, &object.object_id);
    let expected = mdbx_core::json::from_str(PRECISE_PAYLOAD).unwrap();
    assert_eq!(
        mdbx_core::json::from_str(before["payloadJson"].as_str().unwrap()).unwrap(),
        expected
    );
    let edited_payload = PRECISE_PAYLOAD.replace("\"notes\":\"before\"", "\"notes\":\"after\"");
    let request = upsert(
        &handle,
        &collection,
        &object.object_id,
        before["headCommitId"].as_str().unwrap(),
        &edited_payload,
    );
    let written = runtime.handle("object.upsert", request.clone()).unwrap();
    assert_eq!(written["objectId"], object.object_id);
    assert_eq!(
        runtime.handle("object.upsert", request.clone()).unwrap()["alreadyCommitted"],
        true
    );
    let mut stale = request.clone();
    stale["operationId"] = json!(fresh_uuid());
    assert_eq!(
        runtime.handle("object.upsert", stale).unwrap_err().code,
        "object-revision-conflict"
    );
    let after = read(&mut runtime, &handle, &object.object_id);
    assert_ne!(after["headCommitId"], before["headCommitId"]);
    let mut edited = expected;
    edited["notes"] = json!("after");
    assert_eq!(
        mdbx_core::json::from_str(after["payloadJson"].as_str().unwrap()).unwrap(),
        edited
    );
    let objects = runtime
        .require_open_vault(&handle)
        .unwrap()
        .list_object_summaries(collection, None, 100, None)
        .unwrap();
    assert_eq!(objects.items.len(), 1);
    runtime
        .handle("vault.lock", json!({"vaultHandle": handle}))
        .unwrap();
    assert_eq!(
        runtime
            .handle(
                "object.reveal",
                json!({"vaultHandle": handle, "objectId": object.object_id})
            )
            .unwrap_err()
            .code,
        "vault-locked"
    );
    drop(runtime);
    let mut restarted = HostRuntime::new(root.path().to_path_buf()).unwrap();
    restarted
        .handle(
            "vault.open",
            json!({
                "source": {"kind": "vault", "handle": handle},
                "credential": {"method": "password", "password": PASSWORD}
            }),
        )
        .unwrap();
    assert_eq!(
        mdbx_core::json::from_str(
            read(&mut restarted, &handle, &object.object_id)["payloadJson"]
                .as_str()
                .unwrap()
        )
        .unwrap(),
        edited
    );
}

#[test]
fn android315_future_type_and_schema_are_visible_but_native_mutations_fail_closed() {
    let (_root, mut runtime, handle, collection) = fixture();
    for (kind, version, error) in [
        ("com.example.future-kit", 1, "object-type-read-only"),
        ("login", 7, "object-schema-read-only"),
    ] {
        let object = runtime
            .require_open_vault(&handle)
            .unwrap()
            .create_object(
                collection.clone(),
                kind.to_string(),
                "Future fixture".to_string(),
                PRECISE_PAYLOAD.to_string(),
                version,
            )
            .unwrap();
        let before = read(&mut runtime, &handle, &object.object_id);
        assert_eq!(before["objectTypeId"], kind);
        assert_eq!(before["payloadSchemaVersion"], version);
        assert_eq!(
            mdbx_core::json::from_str(before["payloadJson"].as_str().unwrap()).unwrap(),
            mdbx_core::json::from_str(PRECISE_PAYLOAD).unwrap()
        );
        let request = upsert(
            &handle,
            &collection,
            &object.object_id,
            before["headCommitId"].as_str().unwrap(),
            PRECISE_PAYLOAD,
        );
        assert_eq!(
            runtime.handle("object.upsert", request).unwrap_err().code,
            error
        );
        assert_eq!(runtime.handle("object.delete", json!({
            "vaultHandle": handle, "operationId": fresh_uuid(), "logicalObjectId": format!("native:{}", object.object_id), "expectedHeadCommitId": before["headCommitId"]
        })).unwrap_err().code, error);
        assert_eq!(read(&mut runtime, &handle, &object.object_id), before);
    }
}

#[test]
fn android315_future_object_attachments_remain_readable_but_cannot_be_mutated() {
    let (_root, mut runtime, handle, collection) = fixture();
    for (kind, version, error) in [
        ("com.example.future-kit", 1, "object-type-read-only"),
        ("login", 7, "object-schema-read-only"),
    ] {
        let vault = runtime.require_open_vault(&handle).unwrap();
        let object = vault
            .create_object(
                collection.clone(),
                kind.to_string(),
                "Synthetic future attachment".to_string(),
                PRECISE_PAYLOAD.to_string(),
                version,
            )
            .unwrap();
        let attachment_id = fresh_uuid();
        vault
            .create_attachment_with_external_content(
                fresh_uuid(),
                MdbxAttachmentCreateRequest {
                    attachment_id: attachment_id.clone(),
                    project_id: collection.clone(),
                    entry_id: Some(object.object_id.clone()),
                    file_name: "synthetic.txt".to_string(),
                    media_type: Some("text/plain".to_string()),
                },
                b"synthetic".to_vec(),
                MdbxAttachmentContentLimits {
                    chunk_size: MAX_BINARY_CHUNK_BYTES as u64,
                    max_plaintext_bytes: MAX_ATTACHMENT_BYTES as u64,
                },
            )
            .unwrap();
        let before = read(&mut runtime, &handle, &object.object_id);
        let listed = runtime.handle("attachment.list", json!({ "vaultHandle": handle, "collectionId": collection, "objectId": object.object_id, "pageSize": 50 })).unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        let begun = runtime
            .handle(
                "attachment.read.begin",
                json!({ "vaultHandle": handle, "attachmentId": attachment_id }),
            )
            .unwrap();
        runtime
            .handle(
                "attachment.read.release",
                json!({ "readHandle": begun["readHandle"] }),
            )
            .unwrap();
        assert_eq!(runtime.handle("attachment.upload.begin", json!({
            "vaultHandle": handle, "operationId": fresh_uuid(), "attachmentId": fresh_uuid(), "collectionId": collection,
            "objectId": object.object_id, "fileName": "new.txt", "mode": "create", "sizeBytes": 0
        })).unwrap_err().code, error);
        assert_eq!(runtime.handle("attachment.delete", json!({ "vaultHandle": handle, "operationId": fresh_uuid(), "attachmentId": attachment_id })).unwrap_err().code, error);
        assert_eq!(read(&mut runtime, &handle, &object.object_id), before);
        assert!(
            !vault
                .get_attachment_summary(attachment_id)
                .unwrap()
                .unwrap()
                .deleted
        );
    }
}

#[test]
fn android315_attachment_finish_rechecks_the_target_payload_version() {
    let (_root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let object = vault
        .create_object(
            collection.clone(),
            "login".to_string(),
            "Synthetic".to_string(),
            PRECISE_PAYLOAD.to_string(),
            1,
        )
        .unwrap();
    let attachment_id = fresh_uuid();
    let started = runtime.handle("attachment.upload.begin", json!({
        "vaultHandle": handle, "operationId": fresh_uuid(), "attachmentId": attachment_id, "collectionId": collection,
        "objectId": object.object_id, "fileName": "empty.txt", "mode": "create", "sizeBytes": 0
    })).unwrap();
    vault
        .update_object(
            collection,
            object.object_id,
            "login".to_string(),
            "Synthetic".to_string(),
            PRECISE_PAYLOAD.to_string(),
            7,
        )
        .unwrap();
    assert_eq!(
        runtime
            .handle(
                "attachment.upload.finish",
                json!({ "transferId": started["transferId"] })
            )
            .unwrap_err()
            .code,
        "object-schema-read-only"
    );
    assert!(vault
        .get_attachment_summary(attachment_id)
        .unwrap()
        .is_none());
}

#[test]
fn android315_native_identity_and_type_cannot_be_changed_or_recreated() {
    let (_root, mut runtime, handle, collection) = fixture();
    let object = runtime
        .require_open_vault(&handle)
        .unwrap()
        .create_object(
            collection.clone(),
            "login".to_string(),
            "Identity".to_string(),
            PRECISE_PAYLOAD.to_string(),
            1,
        )
        .unwrap();
    let before = read(&mut runtime, &handle, &object.object_id);
    let request = upsert(
        &handle,
        &collection,
        &object.object_id,
        before["headCommitId"].as_str().unwrap(),
        PRECISE_PAYLOAD,
    );
    let mut no_revision = request.clone();
    no_revision
        .as_object_mut()
        .unwrap()
        .remove("expectedHeadCommitId");
    assert_eq!(
        runtime
            .handle("object.upsert", no_revision)
            .unwrap_err()
            .code,
        "object-revision-required"
    );
    let mut wrong_type = request.clone();
    wrong_type["operationId"] = json!(fresh_uuid());
    wrong_type["objectTypeId"] = json!("note");
    assert_eq!(
        runtime
            .handle("object.upsert", wrong_type)
            .unwrap_err()
            .code,
        "object-type-mismatch"
    );
    let mut wrong_identity = request.clone();
    wrong_identity["operationId"] = json!(fresh_uuid());
    wrong_identity["payloadJson"] =
        json!(PRECISE_PAYLOAD.replace("password:android-315", "password:wrong"));
    assert_eq!(
        runtime
            .handle("object.upsert", wrong_identity)
            .unwrap_err()
            .code,
        "object-identity-mismatch"
    );
    let mut future = request.clone();
    future["operationId"] = json!(fresh_uuid());
    future["payloadSchemaVersion"] = json!(2);
    assert_eq!(
        runtime.handle("object.upsert", future).unwrap_err().code,
        "object-schema-read-only"
    );
    assert_eq!(read(&mut runtime, &handle, &object.object_id), before);
    let deleted = runtime.handle("object.delete", json!({
        "vaultHandle": handle, "operationId": fresh_uuid(), "logicalObjectId": format!("native:{}", object.object_id), "expectedHeadCommitId": before["headCommitId"]
    })).unwrap();
    let mut resurrection = request;
    resurrection["operationId"] = json!(fresh_uuid());
    resurrection["expectedHeadCommitId"] = deleted["commitId"].clone();
    assert_eq!(
        runtime
            .handle("object.upsert", resurrection)
            .unwrap_err()
            .code,
        "object-not-found"
    );
}

#[test]
fn android315_native_batch_is_atomic_on_stale_revision_and_rejects_identity_aliases() {
    let (_root, mut runtime, handle, collection) = fixture();
    let vault = runtime.require_open_vault(&handle).unwrap();
    let first = vault
        .create_object(
            collection.clone(),
            "login".to_string(),
            "Same title".to_string(),
            PRECISE_PAYLOAD.to_string(),
            1,
        )
        .unwrap();
    let second = vault
        .create_object(
            collection.clone(),
            "login".to_string(),
            "Same title".to_string(),
            PRECISE_PAYLOAD.to_string(),
            1,
        )
        .unwrap();
    let before = read(&mut runtime, &handle, &first.object_id);
    let mut first_mutation = upsert(
        &handle,
        &collection,
        &first.object_id,
        before["headCommitId"].as_str().unwrap(),
        &PRECISE_PAYLOAD.replace("before", "batch edit"),
    );
    first_mutation
        .as_object_mut()
        .unwrap()
        .remove("vaultHandle");
    first_mutation
        .as_object_mut()
        .unwrap()
        .remove("operationId");
    first_mutation["kind"] = json!("upsert");
    let batch = json!({
        "vaultHandle": handle, "operationId": fresh_uuid(),
        "mutations": [first_mutation.clone(), {"kind": "delete", "logicalObjectId": format!("native:{}", second.object_id), "expectedHeadCommitId": fresh_uuid()}]
    });
    assert_eq!(
        runtime.handle("object.batch", batch).unwrap_err().code,
        "object-revision-conflict"
    );
    assert_eq!(read(&mut runtime, &handle, &first.object_id), before);
    assert_eq!(
        vault
            .list_object_summaries(collection.clone(), None, 100, None)
            .unwrap()
            .items
            .len(),
        2
    );
    let alias = json!({"kind": "delete", "logicalObjectId": first.object_id, "expectedHeadCommitId": before["headCommitId"]});
    assert_eq!(runtime.handle("object.batch", json!({"vaultHandle": handle, "operationId": fresh_uuid(), "mutations": [first_mutation, alias]})).unwrap_err().code, "params-invalid");
    assert_eq!(read(&mut runtime, &handle, &first.object_id), before);
}

#[test]
fn android315_api_token_labels_keep_full_i64_field_ids_and_future_json() {
    let (_root, mut runtime, handle, collection) = fixture();
    let id = fresh_uuid();
    let metadata = r#"{"schema":"monica.api-token.fields.v1","notes":"synthetic","custom_fields":[{"id":9223372036854775807,"title":"maximum","value":"synthetic","protected":true},{"id":-9223372036854775808,"title":"minimum","value":"","protected":false}],"future":{"decimal":0.123456789012345678901,"$serde_json::private::Number":"literal"}}"#;
    let payload = r#"{"schema":"monica.api-token.v1","provider":"synthetic","api_base":"https://example.test","token":"synthetic-api-token-only","future":{"counter":18446744073709551615}}"#;
    let request = json!({
        "vaultHandle": handle, "operationId": fresh_uuid(), "logicalObjectId": format!("api-token:{id}"),
        "collectionId": collection, "objectTypeId": "api-token", "title": "Synthetic API token",
        "payloadJson": payload, "apiTokenMetadataJson": metadata, "apiTokenFavorite": true
    });
    let written = runtime.handle("object.upsert", request.clone()).unwrap();
    assert_eq!(written["objectId"], id);
    let revealed = read(&mut runtime, &handle, &id);
    assert_eq!(revealed["apiTokenFavorite"], true);
    assert_eq!(
        mdbx_core::json::from_str(revealed["apiTokenMetadataJson"].as_str().unwrap()).unwrap(),
        mdbx_core::json::from_str(metadata).unwrap()
    );
    assert_eq!(
        mdbx_core::json::from_str(revealed["payloadJson"].as_str().unwrap()).unwrap(),
        mdbx_core::json::from_str(payload).unwrap()
    );
    let mut duplicate = request;
    duplicate["operationId"] = json!(fresh_uuid());
    duplicate["apiTokenMetadataJson"] =
        json!(metadata.replace("-9223372036854775808", "9223372036854775807"));
    assert_eq!(
        runtime.handle("object.upsert", duplicate).unwrap_err().code,
        "params-invalid"
    );
    assert_eq!(read(&mut runtime, &handle, &id), revealed);
}
