import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MDBX2_CORE_REVISION,
  MDBX2_ENGINE_VERSION,
  MDBX2_FORMAT_VERSION,
  MDBX2_MAX_ATTACHMENT_BYTES,
  MDBX2_MAX_ATTACHMENT_MEMORY_BYTES,
  MDBX2_MAX_ATTACHMENT_PAGE_SIZE,
  MDBX2_MAX_ATTACHMENT_SESSIONS,
  MDBX2_MAX_ACTIVE_TRANSFERS,
  MDBX2_BLOB_REFERENCE_PAGE_SIZE,
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_MAX_CONFLICT_PAGE_SIZE,
  MDBX2_MAX_CONFLICT_RESULT_BYTES,
  MDBX2_MAX_COLLECTION_RESULT_BYTES,
  MDBX2_MAX_COLLECTION_TITLE_BYTES,
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_MAX_HISTORY_PAGE_SIZE,
  MDBX2_MAX_HISTORY_REVERT_ITEMS,
  MDBX2_MAX_HISTORY_RESULT_BYTES,
  MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES,
  MDBX2_MAX_OBJECT_BATCH_MUTATIONS,
  MDBX2_MAX_OBJECT_PAYLOAD_BYTES,
  MDBX2_MAX_REMOTE_BLOB_BYTES,
  MDBX2_MAX_SNAPSHOT_NAME_BYTES,
  MDBX2_MAX_SNAPSHOT_PAGE_SIZE,
  MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES,
  MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST,
  MDBX2_MAX_SNAPSHOT_RESULT_BYTES,
  MDBX2_MAX_SNAPSHOT_STRUCTURE_NODES,
  MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE,
  MDBX2_MAX_SUMMARY_PAGE_SIZE,
  MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES,
  MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES,
  MDBX2_NATIVE_HOST_NAME,
  MDBX2_NATIVE_PROTOCOL_VERSION,
  MDBX2_SYNC_PROTOCOL_VERSION,
  MDBX2_SYNC_SEGMENT_PAGE_SIZE,
  Mdbx2NativeHostError,
  validateMdbx2HostCapabilities
} from "./native-contract";
import { Mdbx2NativeClient, type Mdbx2NativePort, type Mdbx2NativeRuntime } from "./native-client";

class FakeEvent<Listener extends (...args: never[]) => void> {
  readonly listeners = new Set<Listener>();
  addListener(listener: Listener): void { this.listeners.add(listener); }
  removeListener(listener: Listener): void { this.listeners.delete(listener); }
  emit(...args: Parameters<Listener>): void { for (const listener of this.listeners) listener(...args); }
}

class FakePort implements Mdbx2NativePort {
  readonly onMessage = new FakeEvent<(message: never) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly messages: unknown[] = [];
  disconnected = false;
  onPost?: (message: unknown) => void;

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onPost?.(message);
  }

  disconnect(): void { this.disconnected = true; }
}

class FakeRuntime implements Mdbx2NativeRuntime {
  lastError?: string;
  constructor(readonly port = new FakePort(), readonly connectError?: Error) {}
  connectNative(hostName: string): Mdbx2NativePort {
    expect(hostName).toBe(MDBX2_NATIVE_HOST_NAME);
    if (this.connectError) throw this.connectError;
    return this.port;
  }
  disconnectErrorMessage(): string | undefined { return this.lastError; }
}

const HELLO = {
  hostName: MDBX2_NATIVE_HOST_NAME,
  hostVersion: "0.1.0",
  protocolVersion: MDBX2_NATIVE_PROTOCOL_VERSION,
  mdbxCoreRevision: MDBX2_CORE_REVISION,
  mdbxEngineVersion: MDBX2_ENGINE_VERSION,
  mdbxFormatVersion: MDBX2_FORMAT_VERSION,
  supportsMdbx1: false,
  maxBinaryChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES,
  maxInboundFileBytes: MDBX2_MAX_INBOUND_FILE_BYTES,
  maxActiveTransfers: MDBX2_MAX_ACTIVE_TRANSFERS,
  maxObjectPayloadBytes: MDBX2_MAX_OBJECT_PAYLOAD_BYTES,
  maxSummaryPageSize: MDBX2_MAX_SUMMARY_PAGE_SIZE,
  maxCollectionTitleBytes: MDBX2_MAX_COLLECTION_TITLE_BYTES,
  maxCollectionResultBytes: MDBX2_MAX_COLLECTION_RESULT_BYTES,
  supportsCollectionMutation: true,
  maxVaultDiagnosticCategories: MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES,
  maxVaultDiagnosticsResultBytes: MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES,
  supportsVaultDiagnostics: true,
  maxObjectBatchMutations: MDBX2_MAX_OBJECT_BATCH_MUTATIONS,
  maxObjectBatchIntentBytes: MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES,
  maxHistoryPageSize: MDBX2_MAX_HISTORY_PAGE_SIZE,
  maxHistoryResultBytes: MDBX2_MAX_HISTORY_RESULT_BYTES,
  supportsHistoryDiff: true,
  maxHistoryRevertItems: MDBX2_MAX_HISTORY_REVERT_ITEMS,
  supportsHistoryRevert: true,
  maxSnapshotPageSize: MDBX2_MAX_SNAPSHOT_PAGE_SIZE,
  maxSnapshotStructurePageSize: MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE,
  maxSnapshotResultBytes: MDBX2_MAX_SNAPSHOT_RESULT_BYTES,
  maxSnapshotNameBytes: MDBX2_MAX_SNAPSHOT_NAME_BYTES,
  maxSnapshotPruneCandidates: MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES,
  maxSnapshotPruneKeepLatest: MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST,
  supportsSnapshotStructure: true,
  supportsSnapshotMutation: true,
  supportsSnapshotPrune: true,
  maxConflictPageSize: MDBX2_MAX_CONFLICT_PAGE_SIZE,
  maxConflictResultBytes: MDBX2_MAX_CONFLICT_RESULT_BYTES,
  supportsConflictResolution: true,
  maxAttachmentBytes: MDBX2_MAX_ATTACHMENT_BYTES,
  maxAttachmentPageSize: MDBX2_MAX_ATTACHMENT_PAGE_SIZE,
  maxAttachmentSessions: MDBX2_MAX_ATTACHMENT_SESSIONS,
  maxAttachmentMemoryBytes: MDBX2_MAX_ATTACHMENT_MEMORY_BYTES,
  supportsAttachmentManagement: true,
  supportsDurableCloudSync: true,
  maxSyncSegmentPageSize: MDBX2_SYNC_SEGMENT_PAGE_SIZE,
  maxBlobReferencePageSize: MDBX2_BLOB_REFERENCE_PAGE_SIZE,
  maxRemoteBlobBytes: MDBX2_MAX_REMOTE_BLOB_BYTES,
  supportedUnlockMethods: ["password", "security-key", "password-security-key"],
  storageProfile: "full",
  syncProfile: "full",
  syncProtocolVersion: MDBX2_SYNC_PROTOCOL_VERSION,
  enabledStorageCapabilityIds: ["object-record-v2"],
  enabledSyncCapabilityIds: ["authenticated-state-delta-v8"]
} as const;

const DIAGNOSTIC_COUNTS = {
  commitCount: 0, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: 0,
  unresolvedConflictCount: 0, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 0,
  deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0,
  originalAttachmentBytes: 0, storedAttachmentBytes: 0
} as const;

const DIAGNOSTIC_REPORT = {
  checkedAtUnixSeconds: 1785648000,
  fileSizeBytes: 4096,
  formatVersion: MDBX2_FORMAT_VERSION,
  schemaVersion: 17,
  health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [] },
  diagnostics: DIAGNOSTIC_COUNTS
} as const;

afterEach(() => vi.useRealTimers());

describe("MDBX2 Native Messaging client", () => {
  it("performs a pinned hello request and validates MDBX2-only capabilities", async () => {
    const runtime = new FakeRuntime();
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: HELLO
      } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => "request-1");

    await expect(client.hello()).resolves.toEqual(HELLO);
    expect(runtime.port.messages).toEqual([{
      protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
      requestId: "request-1",
      method: "host.hello",
      params: {}
    }]);
    client.close();
  });

  it("rejects a Host that claims MDBX1 support or a different chunk boundary", () => {
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsMdbx1: true })).toThrowError(Mdbx2NativeHostError);
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, maxBinaryChunkBytes: 64 * 1024 })).toThrow("分块限制");
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsHistoryRevert: false })).toThrow("历史恢复能力");
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsSnapshotPrune: false })).toThrow("自动快照清理能力");
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsCollectionMutation: false })).toThrow("Collection 管理能力");
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsVaultDiagnostics: false })).toThrow("诊断刷新能力");
  });

  it("preserves stable Host error codes and retryability", async () => {
    const runtime = new FakeRuntime();
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code: "vault-locked", message: "Vault is locked.", retryable: true }
      } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => "request-2");

    await expect(client.hello()).rejects.toMatchObject({ code: "vault-locked", retryable: true });
    client.close();
  });

  it("validates bounded Collection list and all retry-safe mutation methods", async () => {
    const runtime = new FakeRuntime();
    const vaultHandle = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const collectionId = "33333333-3333-4333-8333-333333333333";
    const parentCollectionId = "44444444-4444-4444-8444-444444444444";
    const commitId = "55555555-5555-4555-8555-555555555555";
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string; method: string; params: Record<string, unknown> };
      requests.push({ method: request.method, params: request.params });
      const collection = {
        collectionId,
        title: request.method === "collection.rename" ? request.params.title : "Accounts",
        collectionTypeId: null,
        profileSchemaVersion: null,
        groupId: request.method === "collection.move" || request.method === "collection.restore"
          ? request.params.parentCollectionId
          : parentCollectionId,
        iconRef: null,
        favorite: false,
        archived: false,
        attachmentCount: 0,
        headCommitId: commitId,
        deleted: request.method === "collection.delete",
        updatedAt: "2026-08-02T00:00:00Z"
      };
      const result = request.method === "collection.list"
        ? { items: [collection], nextCursor: null }
        : { operationId, commitId, alreadyCommitted: false, collection };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result
      } as never);
    };
    let requestNumber = 0;
    const client = new Mdbx2NativeClient(runtime, () => `collection-request-${++requestNumber}`);

    await expect(client.listCollections(vaultHandle, { excludeRoot: true, pageSize: 50 })).resolves.toMatchObject({ items: [{ collectionId }] });
    await expect(client.createCollection(vaultHandle, operationId, collectionId, "  Accounts  ", parentCollectionId)).resolves.toMatchObject({ operationId, collection: { title: "Accounts" } });
    await expect(client.renameCollection(vaultHandle, operationId, collectionId, "Work")).resolves.toMatchObject({ collection: { title: "Work" } });
    await expect(client.moveCollection(vaultHandle, operationId, collectionId)).resolves.toMatchObject({ collection: { groupId: undefined } });
    await expect(client.deleteCollection(vaultHandle, operationId, collectionId)).resolves.toMatchObject({ collection: { deleted: true } });
    await expect(client.restoreCollection(vaultHandle, operationId, collectionId, parentCollectionId)).resolves.toMatchObject({ collection: { groupId: parentCollectionId, deleted: false } });

    expect(requests.map(({ method }) => method)).toEqual([
      "collection.list", "collection.create", "collection.rename", "collection.move", "collection.delete", "collection.restore"
    ]);
    expect(requests[0].params).toMatchObject({ deleted: false, excludeRoot: true, pageSize: 50, cursor: null });
    expect(requests[1].params).toMatchObject({ operationId, collectionId, title: "Accounts", parentCollectionId });
    expect(requests[3].params).toMatchObject({ parentCollectionId: null });
    client.close();
  });

  it("rejects invalid Collection titles, mismatched targets, and extra result fields", async () => {
    const runtime = new FakeRuntime();
    const vaultHandle = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const collectionId = "33333333-3333-4333-8333-333333333333";
    const otherCollectionId = "44444444-4444-4444-8444-444444444444";
    const commitId = "55555555-5555-4555-8555-555555555555";
    const client = new Mdbx2NativeClient(runtime, () => "collection-invalid-request");

    await expect(client.createCollection(vaultHandle, operationId, collectionId, "   ")).rejects.toMatchObject({ code: "collection-title-invalid" });
    await expect(client.createCollection(vaultHandle, operationId, collectionId, "x".repeat(MDBX2_MAX_COLLECTION_TITLE_BYTES + 1))).rejects.toMatchObject({ code: "collection-title-invalid" });
    expect(runtime.port.messages).toHaveLength(0);

    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: {
          operationId,
          commitId,
          alreadyCommitted: false,
          collection: {
            collectionId: otherCollectionId,
            title: "Accounts",
            collectionTypeId: null,
            profileSchemaVersion: null,
            groupId: null,
            iconRef: null,
            favorite: false,
            archived: false,
            attachmentCount: 0,
            headCommitId: commitId,
            deleted: false,
            updatedAt: "2026-08-02T00:00:00Z"
          },
          leakedPayload: "forbidden"
        }
      } as never);
    };
    await expect(client.renameCollection(vaultHandle, operationId, collectionId, "Accounts"))
      .rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("uses bounded transfer and MDBX2-only vault lifecycle methods", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    let requestNumber = 0;
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string; method: string };
      const result: Record<string, unknown> = {
        "transfer.begin": { transferId: handle, nextOffset: 0, maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES },
        "transfer.chunk": { nextOffset: 3, acceptedBytes: 3, repeated: false },
        "transfer.finish": { fileHandle: handle, purpose: "vault-bootstrap", sizeBytes: 3, sha256: "a".repeat(64) },
        "vault.inspect": {
          source: { kind: "file", handle }, initialized: true, formatVersion: MDBX2_FORMAT_VERSION, schemaVersion: 17,
          minReaderVersion: "MDBX-2", minWriterVersion: "MDBX-2", requiresUpgrade: false,
          unknownCriticalExtensions: false, targetFormatVersion: MDBX2_FORMAT_VERSION, targetSchemaVersion: 17
        },
        "vault.open": {
          vaultHandle: handle, vaultId: handle, deviceId: handle,
          migrated: false, preUpgradeBackupCreated: false, ...DIAGNOSTIC_REPORT
        },
        "vault.status": { vaultHandle: handle, open: true, available: true },
        "vault.diagnostics": DIAGNOSTIC_REPORT,
        "vault.lock": { locked: true },
        "collection.list": { items: [{ collectionId: handle, title: ".monica-root", collectionTypeId: null, profileSchemaVersion: null, groupId: null, iconRef: null, favorite: false, archived: false, attachmentCount: 0, headCommitId: "commit-1", deleted: false, updatedAt: "2026-08-02T00:00:00Z" }], nextCursor: null },
        "object.list": { items: [{ objectId: handle, collectionId: handle, objectTypeId: "login", title: "Example", payloadSchemaVersion: 1, headCommitId: "commit-2", deleted: false, updatedAt: "2026-08-02T00:00:00Z" }], nextCursor: null },
        "object.reveal": { objectId: handle, collectionId: handle, objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:1" }), payloadSchemaVersion: 1, deleted: false },
        "object.upsert": { commitId: "commit-3", alreadyCommitted: false, logicalObjectId: "password:1", objectId: handle, collectionId: handle, objectTypeId: "login" },
        "object.delete": { changed: true, commitId: "commit-4", alreadyCommitted: false, logicalObjectId: "password:1", objectId: handle },
        "object.batch": {
          changed: true,
          operationId: handle,
          commitId: "commit-5",
          alreadyCommitted: false,
          items: [
            { kind: "upsert", changed: true, logicalObjectId: "password:1", objectId: handle, collectionId: handle, objectTypeId: "login" },
            { kind: "delete", changed: true, logicalObjectId: "password:2", objectId: handle, collectionId: null, objectTypeId: null }
          ]
        },
        "object.operation.status": { known: true, committed: true, commitId: "commit-5" },
        "object.operation.resolve": { known: true, committed: true, operationId: handle, commitId: "commit-5" },
        "history.list": {
          items: [{
            commitId: handle,
            deviceId: handle,
            localSeq: 5,
            commitKind: "change",
            changeScope: "entry",
            createdAt: "2026-08-02T00:00:00Z",
            operationId: "android-batch-operation",
            operationKind: "monica-extension-batch-objects",
            branchName: "main",
            message: null,
            changes: [{ objectType: "entry", objectId: handle, action: "update", fields: ["payload"] }],
            parentIds: [],
            legacy: false
          }],
          nextCursor: null
        },
        "history.diff": {
          items: [{
            commitId: handle,
            objectType: "entry",
            objectId: handle,
            collectionId: handle,
            previousTitle: "Before",
            currentTitle: "After",
            previousDeleted: false,
            currentDeleted: false,
            changedFields: ["payload"],
            payloadChanged: true,
            contentType: "login",
            createdAt: "2026-08-02T00:00:00Z"
          }]
        },
        "history.revert": { operationId: handle, commitId: handle, revertedObjectCount: 1 },
        "snapshot.list": {
          items: [{
            snapshotId: handle,
            baseCommitId: handle,
            name: "手动快照",
            kind: "manual",
            isFull: true,
            payloadBytes: 128,
            createdAt: "2026-08-02T00:00:00Z",
            createdByDeviceId: "device-a",
            autoPrune: false,
            integrityOk: true
          }],
          nextCursor: null
        },
        "snapshot.structure": {
          snapshotId: handle,
          side: "snapshot",
          currentItemCount: 2,
          snapshotItemCount: 1,
          totalNodes: 1,
          items: [{
            nodeId: handle,
            parentNodeId: null,
            name: "工作账号",
            nodeType: "entry",
            path: "登录/工作账号",
            status: "modified",
            childCount: 0
          }],
          nextCursor: null
        },
        "snapshot.prune.plan": { planToken: "a".repeat(64), keepLatest: 0, candidateCount: 2, hasMore: false, totalCiphertextBytes: 256 },
        "snapshot.prune.execute": { planToken: "a".repeat(64), commitId: handle, deletedSnapshotCount: 2 },
        "snapshot.create": { operationId: handle, snapshotId: handle, commitId: handle, alreadyCompleted: false },
        "snapshot.delete": { operationId: handle, snapshotId: handle, commitId: null, alreadyCompleted: true },
        "snapshot.restore": { operationId: handle, snapshotId: handle, commitId: handle, affectedObjectCount: 2, alreadyCompleted: false },
        "conflict.list": {
          items: [{
            conflictId: handle,
            objectType: "entry",
            objectId: handle,
            displayTitle: "Local account",
            contentType: "login",
            conflictingFields: ["payload", "title_ct"],
            createdAt: "2026-08-02T00:00:00Z"
          }],
          nextCursor: null
        },
        "conflict.resolve": {
          resolved: true,
          alreadyResolved: false,
          conflictId: handle,
          objectType: "entry",
          objectId: handle,
          choice: "incoming-wins",
          resolvedAt: "2026-08-02T00:01:00Z"
        },
        "attachment.list": {
          items: [{ attachmentId: handle, fileName: "evidence.bin", mediaType: "application/octet-stream", sizeBytes: 3, storageMode: "external-hash-ref", protected: true, deleted: false, updatedAt: "2026-08-02T00:00:00Z" }],
          nextCursor: null
        },
        "attachment.read.begin": { readHandle: handle, attachmentId: handle, fileName: "evidence.bin", mediaType: "application/octet-stream", sizeBytes: 3, maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES },
        "attachment.read.chunk": { readHandle: handle, attachmentId: handle, fileName: "evidence.bin", mediaType: "application/octet-stream", sizeBytes: 3, offset: 0, dataBase64: "AQID", nextOffset: 3, eof: true },
        "attachment.read.release": { released: true },
        "attachment.upload.begin": { transferId: handle, operationId: handle, attachmentId: handle, nextOffset: 0, maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES, alreadyCommitted: false },
        "attachment.upload.chunk": { transferId: handle, nextOffset: 3, acceptedBytes: 3, repeated: false },
        "attachment.upload.finish": { transferId: handle, attachment: { attachmentId: handle, fileName: "evidence.bin", mediaType: "application/octet-stream", sizeBytes: 3, storageMode: "external-hash-ref", protected: true, deleted: false }, commitId: handle, alreadyCommitted: false, changed: true },
        "attachment.upload.abort": { aborted: true },
        "attachment.delete": { operationId: handle, attachment: { attachmentId: handle, fileName: "evidence.bin", mediaType: "application/octet-stream", sizeBytes: 3, storageMode: "external-hash-ref", protected: true, deleted: true }, commitId: handle, alreadyCommitted: false, changed: true }
      }[request.method] as Record<string, unknown>;
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => `request-${++requestNumber}`);

    await expect(client.beginInboundTransfer(3, "a".repeat(64))).resolves.toMatchObject({ transferId: handle, nextOffset: 0 });
    await expect(client.sendInboundChunk(handle, 0, new Uint8Array([1, 2, 3]))).resolves.toMatchObject({ nextOffset: 3, acceptedBytes: 3 });
    await expect(client.finishInboundTransfer(handle)).resolves.toMatchObject({ fileHandle: handle, sizeBytes: 3 });
    await expect(client.inspectVault({ kind: "file", handle })).resolves.toMatchObject({ formatVersion: "MDBX-2", schemaVersion: 17 });
    await expect(client.openVault({ kind: "file", handle }, { method: "password", password: "" })).resolves.toMatchObject({ vaultHandle: handle, health: { healthy: true } });
    await expect(client.vaultStatus(handle)).resolves.toEqual({ vaultHandle: handle, open: true, available: true });
    await expect(client.vaultDiagnostics(handle)).resolves.toMatchObject({ fileSizeBytes: 4096, health: { issueCount: 0 }, diagnostics: { folderCount: 0 } });
    await expect(client.listCollections(handle)).resolves.toMatchObject({ items: [{ collectionId: handle, title: ".monica-root" }] });
    await expect(client.listObjects(handle, handle)).resolves.toMatchObject({ items: [{ objectId: handle, objectTypeId: "login" }] });
    await expect(client.revealObject(handle, handle)).resolves.toMatchObject({ payloadSchemaVersion: 1, payloadJson: expect.stringContaining("password:1") });
    await expect(client.upsertObject(handle, handle, { logicalObjectId: "password:1", objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:1" }) })).resolves.toMatchObject({ commitId: "commit-3", objectId: handle });
    await expect(client.deleteObject(handle, handle, "password:1")).resolves.toMatchObject({ changed: true, commitId: "commit-4" });
    await expect(client.mutateObjects(handle, "ab".repeat(32), [
      { kind: "upsert", logicalObjectId: "password:1", objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:1" }) },
      { kind: "delete", logicalObjectId: "password:2" }
    ])).resolves.toMatchObject({ changed: true, commitId: "commit-5", items: [{ kind: "upsert" }, { kind: "delete" }] });
    await expect(client.objectOperationStatus(handle, handle)).resolves.toEqual({ known: true, committed: true, commitId: "commit-5" });
    await expect(client.resolveObjectOperation(handle, "ab".repeat(32))).resolves.toEqual({ known: true, committed: true, operationId: handle, commitId: "commit-5" });
    await expect(client.listCommitHistory(handle)).resolves.toMatchObject({ items: [{ commitId: handle, operationKind: "monica-extension-batch-objects", changes: [{ fields: ["payload"] }] }] });
    await expect(client.listCommitDiff(handle, handle)).resolves.toMatchObject({ items: [{ commitId: handle, currentTitle: "After", payloadChanged: true, contentType: "login" }] });
    await expect(client.revertCommit(handle, handle, handle)).resolves.toEqual({ operationId: handle, commitId: handle, revertedObjectCount: 1 });
    await expect(client.listSnapshots(handle)).resolves.toMatchObject({ items: [{ snapshotId: handle, name: "手动快照", integrityOk: true }] });
    await expect(client.listSnapshotStructure(handle, handle, "snapshot")).resolves.toMatchObject({ side: "snapshot", totalNodes: 1, items: [{ name: "工作账号", status: "modified" }] });
    await expect(client.planAutomaticSnapshotPrune(handle)).resolves.toEqual({ planToken: "a".repeat(64), keepLatest: 0, candidateCount: 2, hasMore: false, totalCiphertextBytes: 256 });
    await expect(client.pruneAutomaticSnapshots(handle, "a".repeat(64))).resolves.toEqual({ planToken: "a".repeat(64), commitId: handle, deletedSnapshotCount: 2 });
    await expect(client.createSnapshot(handle, handle, " 手动快照 ")).resolves.toMatchObject({ operationId: handle, alreadyCompleted: false });
    await expect(client.deleteSnapshot(handle, handle, handle)).resolves.toEqual({ operationId: handle, snapshotId: handle, commitId: undefined, alreadyCompleted: true });
    await expect(client.restoreSnapshot(handle, handle, handle)).resolves.toMatchObject({ operationId: handle, affectedObjectCount: 2 });
    await expect(client.listConflicts(handle)).resolves.toMatchObject({ items: [{ conflictId: handle, displayTitle: "Local account", conflictingFields: ["payload", "title_ct"] }] });
    await expect(client.resolveConflict(handle, handle, handle, "incoming-wins")).resolves.toMatchObject({ resolved: true, alreadyResolved: false, choice: "incoming-wins" });
    await expect(client.listAttachments(handle, handle, handle)).resolves.toMatchObject({ items: [{ attachmentId: handle, fileName: "evidence.bin", sizeBytes: 3 }] });
    await expect(client.beginAttachmentRead(handle, handle)).resolves.toMatchObject({ readHandle: handle, sizeBytes: 3 });
    await expect(client.readAttachmentChunk(handle, 0)).resolves.toMatchObject({ nextOffset: 3, eof: true });
    await expect(client.releaseAttachmentRead(handle)).resolves.toBe(true);
    await expect(client.beginAttachmentUpload(handle, { operationId: handle, attachmentId: handle, collectionId: handle, objectId: handle, fileName: "evidence.bin", mediaType: "application/octet-stream", mode: "create", sizeBytes: 3, sha256: "a".repeat(64) })).resolves.toMatchObject({ transferId: handle, nextOffset: 0 });
    await expect(client.sendAttachmentUploadChunk(handle, 0, new Uint8Array([1, 2, 3]))).resolves.toMatchObject({ nextOffset: 3, acceptedBytes: 3 });
    await expect(client.finishAttachmentUpload(handle)).resolves.toMatchObject({ attachment: { attachmentId: handle }, changed: true });
    await expect(client.abortAttachmentUpload(handle)).resolves.toBe(true);
    await expect(client.deleteAttachment(handle, handle, handle)).resolves.toMatchObject({ operationId: handle, attachment: { deleted: true } });
    await expect(client.lockVault(handle)).resolves.toBe(true);
    expect((runtime.port.messages[4] as { params: unknown }).params).toEqual({
      source: { kind: "file", handle },
      credential: { method: "password", password: "" }
    });
    client.close();
  });

  it("rejects oversized disclosed or internally inconsistent vault diagnostics", async () => {
    const vaultHandle = "11111111-1111-4111-8111-111111111111";
    const invalidReports: unknown[] = [
      { ...DIAGNOSTIC_REPORT, filePath: "C:\\private\\vault.mdbx" },
      {
        ...DIAGNOSTIC_REPORT,
        health: {
          healthy: true, issueCount: 1, infoCount: 1, warningCount: 0, errorCount: 0, criticalCount: 0,
          categories: [{ category: "future-user-category", count: 1, highestSeverity: "info" }]
        }
      },
      {
        ...DIAGNOSTIC_REPORT,
        health: {
          healthy: true, issueCount: 1, infoCount: 0, warningCount: 1, errorCount: 0, criticalCount: 0,
          categories: []
        }
      },
      {
        ...DIAGNOSTIC_REPORT,
        health: {
          healthy: false, issueCount: 1, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 1,
          categories: [{ category: "integrity", count: 1, highestSeverity: "warning" }]
        }
      },
      { ...DIAGNOSTIC_REPORT, fileSizeBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...DIAGNOSTIC_REPORT, checkedAtUnixSeconds: 8_640_000_001 },
      { ...DIAGNOSTIC_REPORT, padding: "x".repeat(MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES) }
    ];

    for (const [index, result] of invalidReports.entries()) {
      const runtime = new FakeRuntime();
      runtime.port.onPost = (message) => {
        const request = message as { requestId: string; method: string };
        expect(request.method).toBe("vault.diagnostics");
        runtime.port.onMessage.emit({
          protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result
        } as never);
      };
      const client = new Mdbx2NativeClient(runtime, () => `diagnostics-invalid-${index}`);
      await expect(client.vaultDiagnostics(vaultHandle)).rejects.toMatchObject({ code: "native-host-incompatible" });
      client.close();
    }
  });

  it("validates durable sync files, streams, segments and Blob RPC responses", async () => {
    const runtime = new FakeRuntime();
    const vaultHandle = "11111111-1111-4111-8111-111111111111";
    const stateHandle = "22222222-2222-4222-8222-222222222222";
    const fileHandle = "33333333-3333-4333-8333-333333333333";
    const remoteBinding = "ab".repeat(32);
    const digest = "cd".repeat(32);
    const blobId = "ef".repeat(32);
    let requestNumber = 0;
    const status = {
      stateHandle, vaultHandle, vaultId: "vault-a", deviceId: "device-a", initialized: true,
      hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false,
      pendingRemoteAcknowledgement: false, remoteStreamCount: 1, blockedStreamCount: 0,
      blobTransferCount: 0, verifiedRemoteBlobCount: 0
    };
    const file = { fileHandle, purpose: "sync-segment", sizeBytes: 3, sha256: digest };
    const segment = {
      file, vaultId: "vault-a", sourceDeviceId: "device-a", transferId: "transfer-a",
      segmentIndex: 0, isLast: true, commitCount: 1, deltaCount: 1, payloadSha256: digest
    };
    const stream = {
      streamId: "device-a/transfer-a", deviceId: "device-a", generationId: "transfer-a",
      nextSequence: 1, lastAppliedDigest: digest, blockedReason: null
    };
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string; method: string };
      const result: Record<string, unknown> = {
        "transfer.read": { ...file, offset: 0, dataBase64: "AQID", nextOffset: 3, eof: true },
        "transfer.release": { released: true },
        "sync.state.register": status,
        "sync.state.status": status,
        "sync.bootstrap.prepare": { stateHandle, vaultId: "vault-a", deviceId: "device-a", file: { ...file, purpose: "sync-bootstrap" } },
        "sync.bootstrap.commit": status,
        "sync.segment.prepare": { hasSegment: true, stateHandle, ...segment },
        "sync.segment.commit": { committed: true, hasMore: false },
        "sync.stream.list": { items: [stream] },
        "sync.stream.block": { ...stream, blockedReason: "missing segment 0" },
        "sync.segment.inspect": segment,
        "sync.segment.apply": { status: "applied", appliedCommits: 1, skippedCommits: 0, conflictCount: 0, missingParentCount: 0, pendingAcknowledgement: true, blockedReason: null },
        "sync.segment.acknowledge": stream,
        "sync.blob.list": { rawReferenceCount: 1, uniqueReferenceCount: 1, items: [{ blobId, totalSize: 3, state: "available", remoteVerified: false }], nextCursor: null },
        "sync.blob.read": { blobId, totalSize: 3, offset: 0, dataBase64: "AQID", nextOffset: 3, isLast: true },
        "sync.blob.remote.verify": { blobId, totalSize: 3, remoteVerified: true },
        "sync.blob.receive.begin": { blobId, totalSize: 3, nextOffset: 0, complete: false },
        "sync.blob.receive.chunk": { blobId, totalSize: 3, nextOffset: 3, complete: true },
        "sync.blob.receive.abort": { aborted: true }
      }[request.method] as Record<string, unknown>;
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => `sync-request-${++requestNumber}`);

    await expect(client.readOutputFile(vaultHandle, stateHandle, remoteBinding, fileHandle, 0)).resolves.toMatchObject({ nextOffset: 3, eof: true });
    await expect(client.releaseFile(fileHandle)).resolves.toBe(true);
    await expect(client.registerSyncState(vaultHandle, remoteBinding)).resolves.toMatchObject({ stateHandle, initialized: true });
    await expect(client.syncStateStatus(vaultHandle, stateHandle, remoteBinding)).resolves.toMatchObject({ remoteStreamCount: 1 });
    await expect(client.prepareSyncBootstrap(vaultHandle, remoteBinding, stateHandle)).resolves.toMatchObject({ file: { purpose: "sync-bootstrap" } });
    await expect(client.commitSyncBootstrap(vaultHandle, stateHandle, remoteBinding, fileHandle)).resolves.toMatchObject({ initialized: true });
    await expect(client.prepareSyncSegment(vaultHandle, stateHandle, remoteBinding)).resolves.toMatchObject({ hasSegment: true, payloadSha256: digest });
    await expect(client.commitSyncSegment(vaultHandle, stateHandle, remoteBinding, fileHandle, digest)).resolves.toEqual({ committed: true, hasMore: false });
    await expect(client.listSyncStreams(vaultHandle, stateHandle, remoteBinding)).resolves.toMatchObject([{ streamId: stream.streamId, nextSequence: 1, lastAppliedDigest: digest }]);
    await expect(client.inspectSyncSegment(vaultHandle, fileHandle)).resolves.toMatchObject({ transferId: "transfer-a" });
    await expect(client.applySyncSegment(vaultHandle, stateHandle, remoteBinding, fileHandle, { deviceId: "device-a", generationId: "transfer-a", sequence: 0, digest })).resolves.toMatchObject({ status: "applied", pendingAcknowledgement: true });
    await expect(client.acknowledgeSyncSegment(vaultHandle, stateHandle, remoteBinding, { deviceId: "device-a", generationId: "transfer-a", sequence: 0, digest })).resolves.toMatchObject({ nextSequence: 1 });
    await expect(client.listExternalBlobs(vaultHandle, stateHandle, remoteBinding)).resolves.toMatchObject({ items: [{ blobId, state: "available" }] });
    await expect(client.readExternalBlob(vaultHandle, stateHandle, remoteBinding, blobId, 3, 0)).resolves.toMatchObject({ nextOffset: 3, isLast: true });
    await expect(client.markRemoteBlobVerified(vaultHandle, stateHandle, remoteBinding, blobId, 3)).resolves.toBeUndefined();
    await expect(client.beginExternalBlobReceive(vaultHandle, stateHandle, remoteBinding, blobId, 3)).resolves.toMatchObject({ nextOffset: 0, complete: false });
    await expect(client.writeExternalBlobReceiveChunk(vaultHandle, stateHandle, remoteBinding, blobId, 3, 0, new Uint8Array([1, 2, 3]), true)).resolves.toMatchObject({ complete: true });
    await expect(client.abortExternalBlobReceive(vaultHandle, stateHandle, remoteBinding, blobId)).resolves.toBe(true);
    client.close();
  });

  it("rejects unbounded history requests and oversized Host history pages", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const client = new Mdbx2NativeClient(runtime, () => "history-request");

    await expect(client.listCommitHistory(handle, { pageSize: MDBX2_MAX_HISTORY_PAGE_SIZE + 1 }))
      .rejects.toMatchObject({ code: "history-page-size-invalid" });
    expect(runtime.port.messages).toHaveLength(0);

    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: { items: Array.from({ length: MDBX2_MAX_HISTORY_PAGE_SIZE + 1 }, () => ({})), nextCursor: null }
      } as never);
    };
    await expect(client.listCommitHistory(handle, { pageSize: MDBX2_MAX_HISTORY_PAGE_SIZE }))
      .rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("rejects malformed history revert responses and changed operation identity", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const otherHandle = "22222222-2222-4222-8222-222222222222";
    const client = new Mdbx2NativeClient(runtime, () => crypto.randomUUID());
    let responseNumber = 0;
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      responseNumber += 1;
      const result = responseNumber === 1
        ? { operationId: otherHandle, commitId: handle, revertedObjectCount: 1 }
        : { operationId: handle, commitId: handle, revertedObjectCount: MDBX2_MAX_HISTORY_REVERT_ITEMS + 1 };
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };

    await expect(client.revertCommit(handle, handle, handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.revertCommit(handle, handle, handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("rejects unbounded conflict requests and unsupported resolution choices", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const client = new Mdbx2NativeClient(runtime, () => "conflict-request");

    await expect(client.listConflicts(handle, { pageSize: MDBX2_MAX_CONFLICT_PAGE_SIZE + 1 }))
      .rejects.toMatchObject({ code: "conflict-page-size-invalid" });
    await expect(client.resolveConflict(handle, handle, handle, "custom" as never))
      .rejects.toMatchObject({ code: "conflict-choice-invalid" });
    expect(runtime.port.messages).toHaveLength(0);
    client.close();
  });

  it("rejects unbounded snapshot requests and malformed snapshot pages", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const client = new Mdbx2NativeClient(runtime, () => crypto.randomUUID());

    await expect(client.listSnapshots(handle, { pageSize: MDBX2_MAX_SNAPSHOT_PAGE_SIZE + 1 }))
      .rejects.toMatchObject({ code: "snapshot-page-size-invalid" });
    await expect(client.listSnapshotStructure(handle, handle, "snapshot", { pageSize: MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE + 1 }))
      .rejects.toMatchObject({ code: "snapshot-structure-page-size-invalid" });
    await expect(client.listSnapshotStructure(handle, handle, "both" as never))
      .rejects.toMatchObject({ code: "snapshot-structure-side-invalid" });
    await expect(client.createSnapshot(handle, handle, "x".repeat(MDBX2_MAX_SNAPSHOT_NAME_BYTES + 1)))
      .rejects.toMatchObject({ code: "snapshot-name-invalid" });
    expect(runtime.port.messages).toHaveLength(0);

    let responseNumber = 0;
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      responseNumber += 1;
      const result = responseNumber === 1
        ? { items: Array.from({ length: MDBX2_MAX_SNAPSHOT_PAGE_SIZE + 1 }, () => ({})), nextCursor: null }
        : responseNumber === 2
          ? { snapshotId: handle, side: "snapshot", currentItemCount: 1, snapshotItemCount: 1, totalNodes: MDBX2_MAX_SNAPSHOT_STRUCTURE_NODES + 1, items: [], nextCursor: null }
          : { snapshotId: handle, side: "snapshot", currentItemCount: 1, snapshotItemCount: 1, totalNodes: 1, items: [{ nodeId: handle, parentNodeId: null, name: "项目", nodeType: "entry", path: "项目", status: "custom", childCount: 0 }], nextCursor: null };
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };

    await expect(client.listSnapshots(handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.listSnapshotStructure(handle, handle, "snapshot")).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.listSnapshotStructure(handle, handle, "snapshot")).rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("rejects malformed or mismatched automatic snapshot prune plans and results", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const client = new Mdbx2NativeClient(runtime, () => crypto.randomUUID());

    await expect(client.planAutomaticSnapshotPrune(handle, MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST + 1))
      .rejects.toMatchObject({ code: "snapshot-prune-keep-latest-invalid" });
    await expect(client.pruneAutomaticSnapshots(handle, "invalid"))
      .rejects.toMatchObject({ code: "digest-invalid" });
    expect(runtime.port.messages).toHaveLength(0);

    let responseNumber = 0;
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      responseNumber += 1;
      const result = responseNumber === 1
        ? { planToken: "a".repeat(64), keepLatest: 0, candidateCount: 1, hasMore: false, totalCiphertextBytes: 128, candidateIds: [handle] }
        : responseNumber === 2
          ? { planToken: "a".repeat(64), keepLatest: 1, candidateCount: 1, hasMore: false, totalCiphertextBytes: 128 }
          : responseNumber === 3
            ? { planToken: "b".repeat(64), commitId: handle, deletedSnapshotCount: 1 }
            : { planToken: "a".repeat(64), commitId: handle, deletedSnapshotCount: MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES + 1 };
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };

    await expect(client.planAutomaticSnapshotPrune(handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.planAutomaticSnapshotPrune(handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.pruneAutomaticSnapshots(handle, "a".repeat(64))).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.pruneAutomaticSnapshots(handle, "a".repeat(64))).rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("rejects snapshot responses that do not match the requested mutation intent", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const otherHandle = "22222222-2222-4222-8222-222222222222";
    const client = new Mdbx2NativeClient(runtime, () => crypto.randomUUID());
    let responseNumber = 0;
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      responseNumber += 1;
      const result = responseNumber === 1
        ? { operationId: otherHandle, snapshotId: handle, commitId: handle, alreadyCompleted: false }
        : responseNumber === 2
          ? { operationId: handle, snapshotId: otherHandle, commitId: null, alreadyCompleted: false }
          : { operationId: otherHandle, snapshotId: handle, commitId: handle, affectedObjectCount: 1, alreadyCompleted: false };
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };

    await expect(client.createSnapshot(handle, handle, "快照")).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.deleteSnapshot(handle, handle, handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    await expect(client.restoreSnapshot(handle, handle, handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("rejects unbounded attachment requests and malformed attachment disclosures", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    const client = new Mdbx2NativeClient(runtime, () => crypto.randomUUID());

    await expect(client.listAttachments(handle, handle, handle, { pageSize: MDBX2_MAX_ATTACHMENT_PAGE_SIZE + 1 }))
      .rejects.toMatchObject({ code: "attachment-page-size-invalid" });
    await expect(client.beginAttachmentUpload(handle, {
      operationId: handle,
      attachmentId: handle,
      collectionId: handle,
      objectId: handle,
      fileName: "oversized.bin",
      mode: "create",
      sizeBytes: MDBX2_MAX_ATTACHMENT_BYTES + 1
    })).rejects.toMatchObject({ code: "attachment-size-invalid" });
    expect(runtime.port.messages).toHaveLength(0);

    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: {
          items: [{ attachmentId: handle, fileName: "private.bin", sizeBytes: 1, storageMode: "external-hash-ref", protected: false, deleted: false }],
          nextCursor: null
        }
      } as never);
    };
    await expect(client.listAttachments(handle, handle, handle)).rejects.toMatchObject({ code: "native-host-incompatible" });
    client.close();
  });

  it("bounds request time and closes the native port after a timeout", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const client = new Mdbx2NativeClient(runtime, () => "request-3");
    const request = client.hello(100);
    const rejection = expect(request).rejects.toMatchObject({ code: "native-request-timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(101);

    await rejection;
    expect(runtime.port.disconnected).toBe(true);
  });

  it("reports a missing Host without exposing the browser error text", async () => {
    const runtime = new FakeRuntime(undefined, new Error("Specified native messaging host not found."));
    const client = new Mdbx2NativeClient(runtime, () => "request-4");

    await expect(client.probe()).resolves.toEqual({
      availability: "not-installed",
      hostName: MDBX2_NATIVE_HOST_NAME,
      message: "尚未安装 Monica MDBX2 Native Host。"
    });
  });
});
