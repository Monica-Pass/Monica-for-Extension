import {
  MDBX2_BLOB_REFERENCE_PAGE_SIZE,
  MDBX2_FORMAT_VERSION,
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_MAX_CONFLICT_PAGE_SIZE,
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_MAX_HISTORY_DIFF_ITEMS,
  MDBX2_MAX_HISTORY_PAGE_SIZE,
  MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES,
  MDBX2_MAX_OBJECT_BATCH_MUTATIONS,
  MDBX2_MAX_OBJECT_PAYLOAD_BYTES,
  MDBX2_MAX_REMOTE_BLOB_BYTES,
  MDBX2_MAX_SUMMARY_PAGE_SIZE,
  MDBX2_NATIVE_HOST_NAME,
  MDBX2_NATIVE_PROTOCOL_VERSION,
  MDBX2_SYNC_SEGMENT_PAGE_SIZE,
  Mdbx2NativeHostError,
  mdbx2NativeConnectionError,
  parseMdbx2NativeResponse,
  validateMdbx2HostCapabilities,
  type Mdbx2HostCapabilities,
  type Mdbx2HostStatus,
  type Mdbx2CommitDiffResult,
  type Mdbx2CommitHistoryPage,
  type Mdbx2ConflictResolutionChoice,
  type Mdbx2ConflictResolutionResult,
  type Mdbx2ConflictSummaryPage,
  type Mdbx2ExternalBlobChunk,
  type Mdbx2ExternalBlobReceiveState,
  type Mdbx2ExternalBlobReferencePage,
  type Mdbx2InboundTransferPurpose,
  type Mdbx2CollectionSummaryPage,
  type Mdbx2NativeMethod,
  type Mdbx2NativeRequest,
  type Mdbx2ObjectDeleteResult,
  type Mdbx2ObjectBatchResult,
  type Mdbx2ObjectMutationInput,
  type Mdbx2ObjectOperationStatus,
  type Mdbx2ObjectOperationResolution,
  type Mdbx2ObjectRecord,
  type Mdbx2ObjectSummaryPage,
  type Mdbx2ObjectUpsertInput,
  type Mdbx2ObjectWriteResult,
  type Mdbx2OutputFileDescriptor,
  type Mdbx2RemoteStreamSummary,
  type Mdbx2SyncBootstrapPrepareResult,
  type Mdbx2SyncSegmentApplyResult,
  type Mdbx2SyncSegmentDescriptor,
  type Mdbx2SyncSegmentPrepareResult,
  type Mdbx2SyncStateStatus,
  type Mdbx2TransferBeginResult,
  type Mdbx2TransferChunkResult,
  type Mdbx2TransferFinishResult,
  type Mdbx2TransferReadResult,
  type Mdbx2VaultCredential,
  type Mdbx2VaultInspection,
  type Mdbx2VaultRuntimeStatus,
  type Mdbx2VaultSessionSummary,
  type Mdbx2VaultSource
} from "./native-contract";
import { base64ToBytes, bytesToBase64 } from "../../security/encoding";

interface NativeEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface Mdbx2NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativeEvent<(message: never) => void>;
  onDisconnect: NativeEvent<() => void>;
}

export interface Mdbx2NativeRuntime {
  connectNative(hostName: string): Mdbx2NativePort;
  disconnectErrorMessage(): string | undefined;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class Mdbx2NativeClient {
  private port?: Mdbx2NativePort;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly runtime: Mdbx2NativeRuntime,
    private readonly createRequestId: () => string = () => crypto.randomUUID()
  ) {}

  async hello(timeoutMs = 5_000): Promise<Mdbx2HostCapabilities> {
    return validateMdbx2HostCapabilities(await this.request("host.hello", {}, timeoutMs));
  }

  async beginInboundTransfer(
    sizeBytes: number,
    sha256?: string,
    purpose: Mdbx2InboundTransferPurpose = "vault-bootstrap",
    timeoutMs = 15_000
  ): Promise<Mdbx2TransferBeginResult> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MDBX2_MAX_INBOUND_FILE_BYTES) {
      throw new Mdbx2NativeHostError("transfer-size-invalid", "MDBX2 文件大小超出允许范围。", false);
    }
    if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) throw new Mdbx2NativeHostError("transfer-digest-invalid", "MDBX2 文件摘要无效。", false);
    if (purpose !== "vault-bootstrap" && purpose !== "sync-segment") throw new Mdbx2NativeHostError("transfer-purpose-invalid", "MDBX2 文件用途无效。", false);
    return transferBeginResult(await this.request("transfer.begin", {
      direction: "extension-to-host",
      purpose,
      sizeBytes,
      sha256: sha256 || null
    }, timeoutMs));
  }

  async sendInboundChunk(transferId: string, offset: number, bytes: Uint8Array, timeoutMs = 30_000): Promise<Mdbx2TransferChunkResult> {
    if (!bytes.length || bytes.length > MDBX2_MAX_BINARY_CHUNK_BYTES) {
      throw new Mdbx2NativeHostError("transfer-chunk-invalid", "MDBX2 文件分块大小无效。", false);
    }
    return transferChunkResult(await this.request("transfer.chunk", {
      transferId: opaqueHandle(transferId, "传输"),
      offset: safeInteger(offset, "传输偏移"),
      dataBase64: bytesToBase64(bytes)
    }, timeoutMs));
  }

  async finishInboundTransfer(transferId: string, timeoutMs = 60_000): Promise<Mdbx2TransferFinishResult> {
    return transferFinishResult(await this.request("transfer.finish", { transferId: opaqueHandle(transferId, "传输") }, timeoutMs));
  }

  async abortInboundTransfer(transferId: string, timeoutMs = 15_000): Promise<boolean> {
    const result = objectResult(await this.request("transfer.abort", { transferId: opaqueHandle(transferId, "传输") }, timeoutMs), "Native Host 中止传输响应无效。");
    return booleanResult(result.aborted, "Native Host 中止传输状态无效。");
  }

  async inspectVault(source: Mdbx2VaultSource, timeoutMs = 15_000): Promise<Mdbx2VaultInspection> {
    return vaultInspection(await this.request("vault.inspect", { source: vaultSource(source) }, timeoutMs));
  }

  async openVault(source: Mdbx2VaultSource, credential: Mdbx2VaultCredential, timeoutMs = 5 * 60_000): Promise<Mdbx2VaultSessionSummary> {
    return vaultSessionSummary(await this.request("vault.open", { source: vaultSource(source), credential }, timeoutMs));
  }

  async vaultStatus(vaultHandle: string, timeoutMs = 15_000): Promise<Mdbx2VaultRuntimeStatus> {
    const result = objectResult(await this.request("vault.status", { vaultHandle: opaqueHandle(vaultHandle, "保险库") }, timeoutMs), "Native Host 保险库状态响应无效。");
    return {
      vaultHandle: opaqueHandle(result.vaultHandle, "保险库"),
      open: booleanResult(result.open, "Native Host 保险库打开状态无效。"),
      available: booleanResult(result.available, "Native Host 保险库可用状态无效。")
    };
  }

  async lockVault(vaultHandle: string, timeoutMs = 15_000): Promise<boolean> {
    const result = objectResult(await this.request("vault.lock", { vaultHandle: opaqueHandle(vaultHandle, "保险库") }, timeoutMs), "Native Host 锁定响应无效。");
    return booleanResult(result.locked, "Native Host 锁定状态无效。");
  }

  async listCollections(vaultHandle: string, input: { deleted?: boolean; pageSize?: number; cursor?: string } = {}, timeoutMs = 15_000): Promise<Mdbx2CollectionSummaryPage> {
    const pageSize = pageSizeValue(input.pageSize);
    return collectionSummaryPage(await this.request("collection.list", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      deleted: Boolean(input.deleted),
      pageSize,
      cursor: input.cursor || null
    }, timeoutMs));
  }

  async listObjects(vaultHandle: string, collectionId: string, input: { objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string } = {}, timeoutMs = 15_000): Promise<Mdbx2ObjectSummaryPage> {
    const pageSize = pageSizeValue(input.pageSize);
    return objectSummaryPage(await this.request("object.list", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      collectionId: opaqueHandle(collectionId, "Collection"),
      objectTypeId: input.objectTypeId || null,
      deleted: Boolean(input.deleted),
      pageSize,
      cursor: input.cursor || null
    }, timeoutMs));
  }

  async revealObject(vaultHandle: string, objectId: string, timeoutMs = 30_000): Promise<Mdbx2ObjectRecord> {
    return objectRecord(await this.request("object.reveal", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      objectId: opaqueHandle(objectId, "Object")
    }, timeoutMs));
  }

  async upsertObject(vaultHandle: string, operationId: string, input: Mdbx2ObjectUpsertInput, timeoutMs = 60_000): Promise<Mdbx2ObjectWriteResult> {
    const logicalObjectId = textResult(input.logicalObjectId, 4096, false, "逻辑 Object ID 无效。");
    const objectTypeId = textResult(input.objectTypeId, 512, false, "Object 类型无效。");
    const title = textResult(input.title, 64 * 1024, true, "Object 标题无效。");
    const payloadJson = textResult(input.payloadJson, MDBX2_MAX_OBJECT_PAYLOAD_BYTES, false, "Object 载荷无效。");
    return objectWriteResult(await this.request("object.upsert", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      operationId: opaqueHandle(operationId, "操作"),
      logicalObjectId,
      collectionId: input.collectionId ? opaqueHandle(input.collectionId, "Collection") : null,
      objectTypeId,
      title,
      payloadJson
    }, timeoutMs));
  }

  async deleteObject(vaultHandle: string, operationId: string, logicalObjectId: string, timeoutMs = 60_000): Promise<Mdbx2ObjectDeleteResult> {
    return objectDeleteResult(await this.request("object.delete", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      operationId: opaqueHandle(operationId, "操作"),
      logicalObjectId: textResult(logicalObjectId, 4096, false, "逻辑 Object ID 无效。")
    }, timeoutMs));
  }

  async mutateObjects(vaultHandle: string, operationScope: string, mutations: Mdbx2ObjectMutationInput[], timeoutMs = 120_000): Promise<Mdbx2ObjectBatchResult> {
    if (!Array.isArray(mutations) || mutations.length < 1 || mutations.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS) {
      throw new Mdbx2NativeHostError("object-batch-invalid", "MDBX2 Object 批量数量无效。", false);
    }
    const normalized = mutations.map((mutation): Mdbx2ObjectMutationInput => {
      const logicalObjectId = textResult(mutation.logicalObjectId, 4096, false, "逻辑 Object ID 无效。");
      if (mutation.kind === "delete") return { kind: "delete", logicalObjectId };
      if (mutation.kind !== "upsert") throw new Mdbx2NativeHostError("object-batch-invalid", "MDBX2 Object 批量操作无效。", false);
      return {
        kind: "upsert",
        logicalObjectId,
        collectionId: mutation.collectionId ? opaqueHandle(mutation.collectionId, "Collection") : undefined,
        objectTypeId: textResult(mutation.objectTypeId, 512, false, "Object 类型无效。"),
        title: textResult(mutation.title, 64 * 1024, true, "Object 标题无效。"),
        payloadJson: textResult(mutation.payloadJson, MDBX2_MAX_OBJECT_PAYLOAD_BYTES, false, "Object 载荷无效。")
      };
    });
    if (normalized.length > 1 && new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES) {
      throw new Mdbx2NativeHostError("object-batch-too-large", "MDBX2 Object 批量内容超过 Native Host 上限。", false);
    }
    return objectBatchResult(await this.request("object.batch", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      operationId: null,
      operationScope: sha256Value(operationScope, "操作范围"),
      mutations: normalized.map((mutation) => mutation.kind === "upsert"
        ? { ...mutation, collectionId: mutation.collectionId || null }
        : mutation)
    }, timeoutMs));
  }

  async objectOperationStatus(vaultHandle: string, operationId: string, timeoutMs = 30_000): Promise<Mdbx2ObjectOperationStatus> {
    return objectOperationStatusResult(await this.request("object.operation.status", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      operationId: opaqueHandle(operationId, "操作")
    }, timeoutMs));
  }

  async resolveObjectOperation(vaultHandle: string, operationScope: string, timeoutMs = 30_000): Promise<Mdbx2ObjectOperationResolution> {
    return objectOperationResolutionResult(await this.request("object.operation.resolve", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      operationScope: sha256Value(operationScope, "操作范围")
    }, timeoutMs));
  }

  async listCommitHistory(
    vaultHandle: string,
    input: { pageSize?: number; cursor?: string } = {},
    timeoutMs = 30_000
  ): Promise<Mdbx2CommitHistoryPage> {
    return commitHistoryPage(await this.request("history.list", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      pageSize: historyPageSizeValue(input.pageSize),
      cursor: input.cursor || null
    }, timeoutMs));
  }

  async listCommitDiff(vaultHandle: string, commitId: string, timeoutMs = 30_000): Promise<Mdbx2CommitDiffResult> {
    return commitDiffResult(await this.request("history.diff", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      commitId: opaqueHandle(commitId, "Commit")
    }, timeoutMs));
  }

  async listConflicts(
    vaultHandle: string,
    input: { pageSize?: number; cursor?: string } = {},
    timeoutMs = 30_000
  ): Promise<Mdbx2ConflictSummaryPage> {
    return conflictSummaryPage(await this.request("conflict.list", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      pageSize: conflictPageSizeValue(input.pageSize),
      cursor: input.cursor || null
    }, timeoutMs));
  }

  async resolveConflict(
    vaultHandle: string,
    operationId: string,
    conflictId: string,
    choice: Mdbx2ConflictResolutionChoice,
    timeoutMs = 30_000
  ): Promise<Mdbx2ConflictResolutionResult> {
    return conflictResolutionResult(await this.request("conflict.resolve", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      operationId: opaqueHandle(operationId, "冲突解决操作"),
      conflictId: opaqueHandle(conflictId, "冲突"),
      choice: conflictResolutionChoiceValue(choice)
    }, timeoutMs));
  }

  async readOutputFile(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    fileHandle: string,
    offset: number,
    maxBytes = MDBX2_MAX_BINARY_CHUNK_BYTES,
    timeoutMs = 30_000
  ): Promise<Mdbx2TransferReadResult> {
    const result = transferReadResult(await this.request("transfer.read", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      stateHandle: opaqueHandle(stateHandle, "同步状态"),
      remoteBinding: sha256Value(remoteBinding, "远端绑定"),
      fileHandle: opaqueHandle(fileHandle, "文件"),
      offset: safeInteger(offset, "文件偏移"),
      maxBytes: binaryChunkSize(maxBytes)
    }, timeoutMs));
    if (result.offset !== offset) throw incompatibleResult("Native Host 文件读取偏移发生变化。");
    return result;
  }

  async releaseFile(fileHandle: string, timeoutMs = 15_000): Promise<boolean> {
    const result = objectResult(await this.request("transfer.release", {
      fileHandle: opaqueHandle(fileHandle, "文件")
    }, timeoutMs), "Native Host 文件释放响应无效。");
    return booleanResult(result.released, "Native Host 文件释放状态无效。");
  }

  async registerSyncState(vaultHandle: string, remoteBinding: string, stateHandle?: string, timeoutMs = 30_000): Promise<Mdbx2SyncStateStatus> {
    return syncStateStatus(await this.request("sync.state.register", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      stateHandle: stateHandle ? opaqueHandle(stateHandle, "同步状态") : null,
      remoteBinding: sha256Value(remoteBinding, "远端绑定")
    }, timeoutMs));
  }

  async syncStateStatus(vaultHandle: string, stateHandle: string, remoteBinding: string, timeoutMs = 15_000): Promise<Mdbx2SyncStateStatus> {
    return syncStateStatus(await this.request("sync.state.status", syncStateParams(vaultHandle, stateHandle, remoteBinding), timeoutMs));
  }

  async prepareSyncBootstrap(vaultHandle: string, remoteBinding: string, stateHandle?: string, timeoutMs = 5 * 60_000): Promise<Mdbx2SyncBootstrapPrepareResult> {
    const value = objectResult(await this.request("sync.bootstrap.prepare", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      stateHandle: stateHandle ? opaqueHandle(stateHandle, "同步状态") : null,
      remoteBinding: sha256Value(remoteBinding, "远端绑定")
    }, timeoutMs), "Native Host MDBX2 bootstrap 响应无效。");
    return {
      stateHandle: opaqueHandle(value.stateHandle, "同步状态"),
      vaultId: textResult(value.vaultId, 128, false, "MDBX2 vault ID 无效。"),
      deviceId: textResult(value.deviceId, 128, false, "MDBX2 device ID 无效。"),
      file: outputFileDescriptor(value.file, "sync-bootstrap")
    };
  }

  async commitSyncBootstrap(vaultHandle: string, stateHandle: string, remoteBinding: string, fileHandle: string, timeoutMs = 30_000): Promise<Mdbx2SyncStateStatus> {
    return syncStateStatus(await this.request("sync.bootstrap.commit", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      fileHandle: opaqueHandle(fileHandle, "文件")
    }, timeoutMs));
  }

  async prepareSyncSegment(vaultHandle: string, stateHandle: string, remoteBinding: string, timeoutMs = 60_000): Promise<Mdbx2SyncSegmentPrepareResult> {
    return syncSegmentPrepareResult(await this.request("sync.segment.prepare", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      pageSize: MDBX2_SYNC_SEGMENT_PAGE_SIZE
    }, timeoutMs));
  }

  async commitSyncSegment(vaultHandle: string, stateHandle: string, remoteBinding: string, fileHandle: string, payloadSha256: string, timeoutMs = 30_000): Promise<{ committed: true; hasMore: boolean }> {
    const value = objectResult(await this.request("sync.segment.commit", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      fileHandle: opaqueHandle(fileHandle, "文件"),
      payloadSha256: sha256Value(payloadSha256, "增量段摘要")
    }, timeoutMs), "Native Host MDBX2 增量段提交响应无效。");
    if (value.committed !== true) throw incompatibleResult("Native Host MDBX2 增量段提交状态无效。");
    return { committed: true, hasMore: booleanResult(value.hasMore, "MDBX2 后续增量段状态无效。") };
  }

  async listSyncStreams(vaultHandle: string, stateHandle: string, remoteBinding: string, timeoutMs = 15_000): Promise<Mdbx2RemoteStreamSummary[]> {
    const value = objectResult(await this.request("sync.stream.list", syncStateParams(vaultHandle, stateHandle, remoteBinding), timeoutMs), "Native Host MDBX2 远端流列表无效。");
    if (!Array.isArray(value.items) || value.items.length > 4_096) throw incompatibleResult("Native Host MDBX2 远端流数量无效。");
    return value.items.map(remoteStreamSummary);
  }

  async blockSyncStream(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    descriptor: { deviceId: string; generationId: string; sequence: number; digest: string; reason: string },
    timeoutMs = 15_000
  ): Promise<Mdbx2RemoteStreamSummary> {
    return remoteStreamSummary(await this.request("sync.stream.block", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      deviceId: remoteComponent(descriptor.deviceId, "设备 ID"),
      generationId: remoteComponent(descriptor.generationId, "传输 ID"),
      sequence: safeInteger(descriptor.sequence, "增量段序号"),
      digest: sha256Value(descriptor.digest, "增量段摘要"),
      reason: textResult(descriptor.reason, 512, false, "远端流阻止原因无效。")
    }, timeoutMs));
  }

  async inspectSyncSegment(vaultHandle: string, fileHandle: string, timeoutMs = 30_000): Promise<Mdbx2SyncSegmentDescriptor> {
    return syncSegmentDescriptor(await this.request("sync.segment.inspect", {
      vaultHandle: opaqueHandle(vaultHandle, "保险库"),
      fileHandle: opaqueHandle(fileHandle, "文件")
    }, timeoutMs));
  }

  async applySyncSegment(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    fileHandle: string,
    descriptor: { deviceId: string; generationId: string; sequence: number; digest: string },
    timeoutMs = 60_000
  ): Promise<Mdbx2SyncSegmentApplyResult> {
    return syncSegmentApplyResult(await this.request("sync.segment.apply", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      fileHandle: opaqueHandle(fileHandle, "文件"),
      deviceId: remoteComponent(descriptor.deviceId, "设备 ID"),
      generationId: remoteComponent(descriptor.generationId, "传输 ID"),
      sequence: safeInteger(descriptor.sequence, "增量段序号"),
      digest: sha256Value(descriptor.digest, "增量段摘要")
    }, timeoutMs));
  }

  async acknowledgeSyncSegment(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    descriptor: { deviceId: string; generationId: string; sequence: number; digest: string },
    timeoutMs = 15_000
  ): Promise<Mdbx2RemoteStreamSummary> {
    return remoteStreamSummary(await this.request("sync.segment.acknowledge", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      deviceId: remoteComponent(descriptor.deviceId, "设备 ID"),
      generationId: remoteComponent(descriptor.generationId, "传输 ID"),
      sequence: safeInteger(descriptor.sequence, "增量段序号"),
      digest: sha256Value(descriptor.digest, "增量段摘要")
    }, timeoutMs));
  }

  async listExternalBlobs(vaultHandle: string, stateHandle: string, remoteBinding: string, cursor?: string, timeoutMs = 30_000): Promise<Mdbx2ExternalBlobReferencePage> {
    return externalBlobReferencePage(await this.request("sync.blob.list", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      cursor: cursor ? sha256Value(cursor, "Blob 游标") : null,
      pageSize: MDBX2_BLOB_REFERENCE_PAGE_SIZE
    }, timeoutMs));
  }

  async readExternalBlob(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    blobId: string,
    totalSize: number,
    offset: number,
    maxBytes = MDBX2_MAX_BINARY_CHUNK_BYTES,
    timeoutMs = 30_000
  ): Promise<Mdbx2ExternalBlobChunk> {
    return externalBlobChunk(await this.request("sync.blob.read", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      blobId: sha256Value(blobId, "Blob ID"),
      totalSize: remoteBlobSize(totalSize),
      offset: safeInteger(offset, "Blob 偏移"),
      maxBytes: binaryChunkSize(maxBytes)
    }, timeoutMs));
  }

  async markRemoteBlobVerified(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, totalSize: number, timeoutMs = 15_000): Promise<void> {
    const value = objectResult(await this.request("sync.blob.remote.verify", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      blobId: sha256Value(blobId, "Blob ID"),
      totalSize: remoteBlobSize(totalSize)
    }, timeoutMs), "Native Host MDBX2 Blob 验证响应无效。");
    if (value.remoteVerified !== true || value.blobId !== blobId || value.totalSize !== totalSize) throw incompatibleResult("Native Host MDBX2 Blob 验证状态无效。");
  }

  async beginExternalBlobReceive(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, totalSize: number, timeoutMs = 15_000): Promise<Mdbx2ExternalBlobReceiveState> {
    return externalBlobReceiveState(await this.request("sync.blob.receive.begin", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      blobId: sha256Value(blobId, "Blob ID"),
      totalSize: remoteBlobSize(totalSize)
    }, timeoutMs));
  }

  async writeExternalBlobReceiveChunk(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    blobId: string,
    totalSize: number,
    offset: number,
    bytes: Uint8Array,
    finalize: boolean,
    timeoutMs = 30_000
  ): Promise<Mdbx2ExternalBlobReceiveState> {
    if (!bytes.length || bytes.length > MDBX2_MAX_BINARY_CHUNK_BYTES) throw new Mdbx2NativeHostError("blob-chunk-invalid", "MDBX2 Blob 分块大小无效。", false);
    return externalBlobReceiveState(await this.request("sync.blob.receive.chunk", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      blobId: sha256Value(blobId, "Blob ID"),
      totalSize: remoteBlobSize(totalSize),
      offset: safeInteger(offset, "Blob 偏移"),
      dataBase64: bytesToBase64(bytes),
      finalize
    }, timeoutMs));
  }

  async abortExternalBlobReceive(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, timeoutMs = 15_000): Promise<boolean> {
    const value = objectResult(await this.request("sync.blob.receive.abort", {
      ...syncStateParams(vaultHandle, stateHandle, remoteBinding),
      blobId: sha256Value(blobId, "Blob ID")
    }, timeoutMs), "Native Host MDBX2 Blob 中止响应无效。");
    return booleanResult(value.aborted, "Native Host MDBX2 Blob 中止状态无效。");
  }

  async probe(timeoutMs = 5_000): Promise<Mdbx2HostStatus> {
    try {
      const capabilities = await this.hello(timeoutMs);
      return {
        availability: "ready",
        hostName: MDBX2_NATIVE_HOST_NAME,
        message: "Monica MDBX2 Native Host 已安装并通过版本检查。",
        capabilities
      };
    } catch (error) {
      const nativeError = error instanceof Mdbx2NativeHostError ? error : mdbx2NativeConnectionError(error);
      return {
        availability: nativeError.code === "native-host-not-installed"
          ? "not-installed"
          : nativeError.code === "native-host-incompatible" || nativeError.code === "native-host-forbidden"
            ? "incompatible"
            : "unavailable",
        hostName: MDBX2_NATIVE_HOST_NAME,
        message: nativeError.message
      };
    } finally {
      this.close();
    }
  }

  async request(method: Mdbx2NativeMethod, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 5 * 60_000) {
      throw new Mdbx2NativeHostError("native-timeout-invalid", "Native Host 请求超时设置无效。", false);
    }
    const port = this.ensurePort();
    const requestId = this.createRequestId();
    const request: Mdbx2NativeRequest = { protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId, method, params };
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Mdbx2NativeHostError("native-request-timeout", "Native Host 请求超时。", true));
        this.close();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeoutId });
      try {
        port.postMessage(request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(mdbx2NativeConnectionError(error));
        this.close();
      }
    });
  }

  close(): void {
    const port = this.port;
    this.port = undefined;
    if (port) {
      port.onMessage.removeListener(this.onMessage);
      port.onDisconnect.removeListener(this.onDisconnect);
      try { port.disconnect(); } catch { /* Port may already be closed. */ }
    }
    this.rejectPending(new Mdbx2NativeHostError("native-host-closed", "Native Host 会话已关闭。", true));
  }

  private ensurePort(): Mdbx2NativePort {
    if (this.port) return this.port;
    try {
      const port = this.runtime.connectNative(MDBX2_NATIVE_HOST_NAME);
      port.onMessage.addListener(this.onMessage);
      port.onDisconnect.addListener(this.onDisconnect);
      this.port = port;
      return port;
    } catch (error) {
      throw mdbx2NativeConnectionError(error);
    }
  }

  private readonly onMessage = (message: never): void => {
    let response;
    try {
      response = parseMdbx2NativeResponse(message);
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error("Native Host 响应无效。"));
      this.close();
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeoutId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Mdbx2NativeHostError(response.error.code, response.error.message, response.error.retryable));
  };

  private readonly onDisconnect = (): void => {
    const message = this.runtime.disconnectErrorMessage();
    const port = this.port;
    this.port = undefined;
    if (port) {
      port.onMessage.removeListener(this.onMessage);
      port.onDisconnect.removeListener(this.onDisconnect);
    }
    this.rejectPending(mdbx2NativeConnectionError(message || "Native Host 连接已断开。"));
  };

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createChromeMdbx2NativeRuntime(): Mdbx2NativeRuntime {
  return {
    connectNative: (hostName) => chrome.runtime.connectNative(hostName) as unknown as Mdbx2NativePort,
    disconnectErrorMessage: () => chrome.runtime.lastError?.message
  };
}

function transferBeginResult(input: unknown): Mdbx2TransferBeginResult {
  const value = objectResult(input, "Native Host 传输开始响应无效。");
  const maxChunkBytes = safeInteger(value.maxChunkBytes, "分块上限");
  if (maxChunkBytes !== MDBX2_MAX_BINARY_CHUNK_BYTES) throw incompatibleResult("Native Host 分块上限发生变化。");
  return {
    transferId: opaqueHandle(value.transferId, "传输"),
    nextOffset: safeInteger(value.nextOffset, "传输偏移"),
    maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES
  };
}

function transferChunkResult(input: unknown): Mdbx2TransferChunkResult {
  const value = objectResult(input, "Native Host 传输分块响应无效。");
  return {
    nextOffset: safeInteger(value.nextOffset, "传输偏移"),
    acceptedBytes: safeInteger(value.acceptedBytes, "已接收字节数"),
    repeated: booleanResult(value.repeated, "Native Host 分块重试状态无效。")
  };
}

function transferFinishResult(input: unknown): Mdbx2TransferFinishResult {
  const value = objectResult(input, "Native Host 传输完成响应无效。");
  const sha256 = stringResult(value.sha256, 64, "Native Host 文件摘要无效。");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw incompatibleResult("Native Host 文件摘要无效。");
  return {
    fileHandle: opaqueHandle(value.fileHandle, "文件"),
    purpose: transferPurpose(value.purpose),
    sizeBytes: safeInteger(value.sizeBytes, "文件大小"),
    sha256
  };
}

function transferReadResult(input: unknown): Mdbx2TransferReadResult {
  const value = objectResult(input, "Native Host 文件读取响应无效。");
  const descriptor = outputFileDescriptor(value, value.purpose === "sync-bootstrap" ? "sync-bootstrap" : "sync-segment");
  const dataBase64 = textResult(value.dataBase64, Math.ceil(MDBX2_MAX_BINARY_CHUNK_BYTES / 3) * 4 + 4, false, "Native Host 文件分块无效。");
  const bytes = decodeBoundedBase64(dataBase64, MDBX2_MAX_BINARY_CHUNK_BYTES, "Native Host 文件分块无效。");
  const offset = safeInteger(value.offset, "文件偏移");
  const nextOffset = safeInteger(value.nextOffset, "文件下一偏移");
  if (nextOffset !== offset + bytes.length || nextOffset > descriptor.sizeBytes) throw incompatibleResult("Native Host 文件分块边界无效。");
  const eof = booleanResult(value.eof, "Native Host 文件结束状态无效。");
  if (eof !== (nextOffset === descriptor.sizeBytes)) throw incompatibleResult("Native Host 文件结束边界无效。");
  return { ...descriptor, offset, dataBase64, nextOffset, eof };
}

function outputFileDescriptor(input: unknown, expectedPurpose?: Mdbx2OutputFileDescriptor["purpose"]): Mdbx2OutputFileDescriptor {
  const value = objectResult(input, "Native Host 文件描述无效。");
  const purpose = value.purpose === "sync-bootstrap" || value.purpose === "sync-segment" ? value.purpose : undefined;
  if (!purpose || expectedPurpose && purpose !== expectedPurpose) throw incompatibleResult("Native Host 文件用途无效。");
  return {
    fileHandle: opaqueHandle(value.fileHandle, "文件"),
    purpose,
    sizeBytes: positiveSafeInteger(value.sizeBytes, "文件大小"),
    sha256: sha256Result(value.sha256, "文件摘要")
  };
}

function syncStateStatus(input: unknown): Mdbx2SyncStateStatus {
  const value = objectResult(input, "Native Host MDBX2 同步状态无效。");
  return {
    stateHandle: opaqueHandle(value.stateHandle, "同步状态"),
    vaultHandle: opaqueHandle(value.vaultHandle, "保险库"),
    vaultId: textResult(value.vaultId, 128, false, "MDBX2 vault ID 无效。"),
    deviceId: textResult(value.deviceId, 128, false, "MDBX2 device ID 无效。"),
    initialized: booleanResult(value.initialized, "MDBX2 初始化状态无效。"),
    hasLocalChanges: booleanResult(value.hasLocalChanges, "MDBX2 本机修改状态无效。"),
    pendingBootstrap: booleanResult(value.pendingBootstrap, "MDBX2 bootstrap 等待状态无效。"),
    pendingSegment: booleanResult(value.pendingSegment, "MDBX2 增量段等待状态无效。"),
    pendingRemoteAcknowledgement: booleanResult(value.pendingRemoteAcknowledgement, "MDBX2 远端确认状态无效。"),
    remoteStreamCount: safeInteger(value.remoteStreamCount, "MDBX2 远端流数量"),
    blockedStreamCount: safeInteger(value.blockedStreamCount, "MDBX2 受阻远端流数量"),
    blobTransferCount: safeInteger(value.blobTransferCount, "MDBX2 Blob 传输数量"),
    verifiedRemoteBlobCount: safeInteger(value.verifiedRemoteBlobCount, "MDBX2 已验证 Blob 数量")
  };
}

function syncSegmentPrepareResult(input: unknown): Mdbx2SyncSegmentPrepareResult {
  const value = objectResult(input, "Native Host MDBX2 增量段准备响应无效。");
  const stateHandle = opaqueHandle(value.stateHandle, "同步状态");
  const hasSegment = booleanResult(value.hasSegment, "MDBX2 增量段存在状态无效。");
  if (!hasSegment) return { hasSegment: false, stateHandle };
  return { hasSegment: true, stateHandle, ...syncSegmentDescriptor(value) };
}

function syncSegmentDescriptor(input: unknown): Mdbx2SyncSegmentDescriptor {
  const value = objectResult(input, "Native Host MDBX2 增量段描述无效。");
  return {
    file: outputFileDescriptor(value.file, "sync-segment"),
    vaultId: textResult(value.vaultId, 128, false, "MDBX2 增量段 vault ID 无效。"),
    sourceDeviceId: remoteComponentResult(value.sourceDeviceId, "MDBX2 增量段设备 ID"),
    transferId: remoteComponentResult(value.transferId, "MDBX2 增量段传输 ID"),
    segmentIndex: safeInteger(value.segmentIndex, "MDBX2 增量段序号"),
    isLast: booleanResult(value.isLast, "MDBX2 增量段结束状态无效。"),
    commitCount: safeInteger(value.commitCount, "MDBX2 Commit 数量"),
    deltaCount: safeInteger(value.deltaCount, "MDBX2 state delta 数量"),
    payloadSha256: sha256Result(value.payloadSha256, "MDBX2 增量段载荷摘要")
  };
}

function remoteStreamSummary(input: unknown): Mdbx2RemoteStreamSummary {
  const value = objectResult(input, "Native Host MDBX2 远端流摘要无效。");
  const deviceId = remoteComponentResult(value.deviceId, "MDBX2 远端流设备 ID");
  const generationId = remoteComponentResult(value.generationId, "MDBX2 远端流传输 ID");
  const streamId = textResult(value.streamId, 513, false, "MDBX2 远端流 ID 无效。");
  if (streamId !== `${deviceId}/${generationId}`) throw incompatibleResult("Native Host MDBX2 远端流 ID 不一致。");
  return {
    streamId,
    deviceId,
    generationId,
    nextSequence: safeInteger(value.nextSequence, "MDBX2 远端流下一序号"),
    lastAppliedDigest: optionalSha256(value.lastAppliedDigest, "MDBX2 远端流最近摘要"),
    blockedReason: optionalString(value.blockedReason, 512, "MDBX2 远端流受阻原因")
  };
}

function syncSegmentApplyResult(input: unknown): Mdbx2SyncSegmentApplyResult {
  const value = objectResult(input, "Native Host MDBX2 增量段应用响应无效。");
  const status = value.status === "applied" || value.status === "duplicate" || value.status === "blocked" ? value.status : undefined;
  if (!status) throw incompatibleResult("Native Host MDBX2 增量段应用状态无效。");
  return {
    status,
    appliedCommits: safeInteger(value.appliedCommits, "MDBX2 已应用 Commit 数量"),
    skippedCommits: safeInteger(value.skippedCommits, "MDBX2 已跳过 Commit 数量"),
    conflictCount: safeInteger(value.conflictCount, "MDBX2 冲突数量"),
    missingParentCount: safeInteger(value.missingParentCount, "MDBX2 缺失父 Commit 数量"),
    pendingAcknowledgement: booleanResult(value.pendingAcknowledgement, "MDBX2 远端确认等待状态无效。"),
    blockedReason: optionalString(value.blockedReason, 512, "MDBX2 增量段受阻原因")
  };
}

function externalBlobReferencePage(input: unknown): Mdbx2ExternalBlobReferencePage {
  const value = objectResult(input, "Native Host MDBX2 Blob 分页响应无效。");
  if (!Array.isArray(value.items) || value.items.length > MDBX2_BLOB_REFERENCE_PAGE_SIZE) throw incompatibleResult("Native Host MDBX2 Blob 分页大小无效。");
  return {
    rawReferenceCount: safeInteger(value.rawReferenceCount, "MDBX2 Blob 原始引用数量"),
    uniqueReferenceCount: safeInteger(value.uniqueReferenceCount, "MDBX2 Blob 唯一引用数量"),
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host MDBX2 Blob 引用无效。");
      const state = item.state === "available" || item.state === "missing" || item.state === "size-mismatch" ? item.state : undefined;
      if (!state) throw incompatibleResult("Native Host MDBX2 Blob 状态无效。");
      return {
        blobId: sha256Result(item.blobId, "MDBX2 Blob ID"),
        totalSize: optionalRemoteBlobSize(item.totalSize),
        state,
        remoteVerified: booleanResult(item.remoteVerified, "MDBX2 Blob 远端验证状态无效。")
      };
    }),
    nextCursor: optionalSha256(value.nextCursor, "MDBX2 Blob 游标")
  };
}

function externalBlobChunk(input: unknown): Mdbx2ExternalBlobChunk {
  const value = objectResult(input, "Native Host MDBX2 Blob 分块响应无效。");
  const dataBase64 = textResult(value.dataBase64, Math.ceil(MDBX2_MAX_BINARY_CHUNK_BYTES / 3) * 4 + 4, false, "MDBX2 Blob 分块无效。");
  const bytes = decodeBoundedBase64(dataBase64, MDBX2_MAX_BINARY_CHUNK_BYTES, "MDBX2 Blob 分块无效。");
  const offset = safeInteger(value.offset, "MDBX2 Blob 偏移");
  const nextOffset = safeInteger(value.nextOffset, "MDBX2 Blob 下一偏移");
  const totalSize = remoteBlobSize(value.totalSize);
  if (nextOffset !== offset + bytes.length || nextOffset > totalSize) throw incompatibleResult("Native Host MDBX2 Blob 分块边界无效。");
  const isLast = booleanResult(value.isLast, "MDBX2 Blob 结束状态无效。");
  if (isLast !== (nextOffset === totalSize)) throw incompatibleResult("Native Host MDBX2 Blob 结束边界无效。");
  return { blobId: sha256Result(value.blobId, "MDBX2 Blob ID"), totalSize, offset, dataBase64, nextOffset, isLast };
}

function externalBlobReceiveState(input: unknown): Mdbx2ExternalBlobReceiveState {
  const value = objectResult(input, "Native Host MDBX2 Blob 接收状态无效。");
  const totalSize = remoteBlobSize(value.totalSize);
  const nextOffset = safeInteger(value.nextOffset, "MDBX2 Blob 接收偏移");
  if (nextOffset > totalSize) throw incompatibleResult("Native Host MDBX2 Blob 接收偏移无效。");
  const complete = booleanResult(value.complete, "MDBX2 Blob 接收完成状态无效。");
  if (complete !== (nextOffset === totalSize)) throw incompatibleResult("Native Host MDBX2 Blob 接收完成边界无效。");
  return { blobId: sha256Result(value.blobId, "MDBX2 Blob ID"), totalSize, nextOffset, complete };
}

function transferPurpose(value: unknown): Mdbx2InboundTransferPurpose {
  if (value === "vault-bootstrap" || value === "sync-segment") return value;
  throw incompatibleResult("Native Host 文件用途无效。");
}

function vaultInspection(input: unknown): Mdbx2VaultInspection {
  const value = objectResult(input, "Native Host 保险库检查响应无效。");
  const source = objectResult(value.source, "Native Host 保险库来源无效。");
  const kind = source.kind === "file" || source.kind === "vault" ? source.kind : undefined;
  if (!kind) throw incompatibleResult("Native Host 保险库来源类型无效。");
  if (value.initialized !== true || value.formatVersion !== MDBX2_FORMAT_VERSION || value.unknownCriticalExtensions !== false || value.targetFormatVersion !== MDBX2_FORMAT_VERSION) {
    throw incompatibleResult("Native Host 返回了非 MDBX2 保险库检查结果。");
  }
  return {
    source: { kind, handle: opaqueHandle(source.handle, "来源") },
    initialized: true,
    formatVersion: MDBX2_FORMAT_VERSION,
    schemaVersion: optionalInteger(value.schemaVersion, "Schema 版本"),
    minReaderVersion: optionalString(value.minReaderVersion, 64, "最低读取版本"),
    minWriterVersion: optionalString(value.minWriterVersion, 64, "最低写入版本"),
    requiresUpgrade: booleanResult(value.requiresUpgrade, "升级状态无效。"),
    unknownCriticalExtensions: false,
    targetFormatVersion: MDBX2_FORMAT_VERSION,
    targetSchemaVersion: safeInteger(value.targetSchemaVersion, "目标 Schema 版本")
  };
}

function vaultSessionSummary(input: unknown): Mdbx2VaultSessionSummary {
  const value = objectResult(input, "Native Host 保险库打开响应无效。");
  if (value.formatVersion !== MDBX2_FORMAT_VERSION) throw incompatibleResult("Native Host 返回了非 MDBX2 会话。");
  const health = objectResult(value.health, "Native Host 健康检查摘要无效。");
  const diagnostics = objectResult(value.diagnostics, "Native Host诊断摘要无效。");
  const count = (key: string) => safeInteger(diagnostics[key], `诊断字段 ${key}`);
  return {
    vaultHandle: opaqueHandle(value.vaultHandle, "保险库"),
    vaultId: stringResult(value.vaultId, 128, "Native Host vault ID 无效。"),
    deviceId: stringResult(value.deviceId, 128, "Native Host device ID 无效。"),
    formatVersion: MDBX2_FORMAT_VERSION,
    schemaVersion: safeInteger(value.schemaVersion, "Schema 版本"),
    migrated: booleanResult(value.migrated, "迁移状态无效。"),
    preUpgradeBackupCreated: booleanResult(value.preUpgradeBackupCreated, "升级备份状态无效。"),
    health: {
      healthy: booleanResult(health.healthy, "保险库健康状态无效。"),
      issueCount: safeInteger(health.issueCount, "健康问题数量")
    },
    diagnostics: {
      commitCount: count("commitCount"), tombstoneCount: count("tombstoneCount"), branchCount: count("branchCount"), deviceCount: count("deviceCount"),
      snapshotCount: count("snapshotCount"), unresolvedConflictCount: count("unresolvedConflictCount"), projectCount: count("projectCount"),
      deletedProjectCount: count("deletedProjectCount"), entryCount: count("entryCount"), deletedEntryCount: count("deletedEntryCount"),
      attachmentCount: count("attachmentCount"), deletedAttachmentCount: count("deletedAttachmentCount"), externalAttachmentCount: count("externalAttachmentCount"),
      originalAttachmentBytes: count("originalAttachmentBytes"), storedAttachmentBytes: count("storedAttachmentBytes")
    }
  };
}

function collectionSummaryPage(input: unknown): Mdbx2CollectionSummaryPage {
  const value = objectResult(input, "Native Host Collection 分页响应无效。");
  if (!Array.isArray(value.items) || value.items.length > MDBX2_MAX_SUMMARY_PAGE_SIZE) throw incompatibleResult("Native Host Collection 分页大小无效。");
  return {
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host Collection 摘要无效。");
      return {
        collectionId: opaqueHandle(item.collectionId, "Collection"),
        title: textResult(item.title, 64 * 1024, true, "Collection 标题无效。"),
        collectionTypeId: optionalString(item.collectionTypeId, 512, "Collection 类型"),
        profileSchemaVersion: optionalInteger(item.profileSchemaVersion, "Collection Profile Schema 版本"),
        groupId: optionalString(item.groupId, 4096, "Collection 分组"),
        iconRef: optionalString(item.iconRef, 4096, "Collection 图标引用"),
        favorite: booleanResult(item.favorite, "Collection 收藏状态无效。"),
        archived: booleanResult(item.archived, "Collection 归档状态无效。"),
        attachmentCount: safeInteger(item.attachmentCount, "Collection 附件数量"),
        headCommitId: textResult(item.headCommitId, 128, false, "Collection Commit ID 无效。"),
        deleted: booleanResult(item.deleted, "Collection 删除状态无效。"),
        updatedAt: textResult(item.updatedAt, 128, false, "Collection 更新时间无效。")
      };
    }),
    nextCursor: optionalString(value.nextCursor, 4096, "Collection 游标")
  };
}

function objectSummaryPage(input: unknown): Mdbx2ObjectSummaryPage {
  const value = objectResult(input, "Native Host Object 分页响应无效。");
  if (!Array.isArray(value.items) || value.items.length > MDBX2_MAX_SUMMARY_PAGE_SIZE) throw incompatibleResult("Native Host Object 分页大小无效。");
  return {
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host Object 摘要无效。");
      return {
        objectId: opaqueHandle(item.objectId, "Object"),
        collectionId: opaqueHandle(item.collectionId, "Collection"),
        objectTypeId: textResult(item.objectTypeId, 512, false, "Object 类型无效。"),
        title: textResult(item.title, 64 * 1024, true, "Object 标题无效。"),
        payloadSchemaVersion: safeInteger(item.payloadSchemaVersion, "Object 载荷 Schema 版本"),
        headCommitId: textResult(item.headCommitId, 128, false, "Object Commit ID 无效。"),
        deleted: booleanResult(item.deleted, "Object 删除状态无效。"),
        updatedAt: textResult(item.updatedAt, 128, false, "Object 更新时间无效。")
      };
    }),
    nextCursor: optionalString(value.nextCursor, 4096, "Object 游标")
  };
}

function objectRecord(input: unknown): Mdbx2ObjectRecord {
  const value = objectResult(input, "Native Host Object 披露响应无效。");
  const payloadJson = textResult(value.payloadJson, MDBX2_MAX_OBJECT_PAYLOAD_BYTES, false, "Object 载荷无效。");
  try {
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch {
    throw incompatibleResult("Native Host Object 载荷不是 JSON 对象。");
  }
  return {
    objectId: opaqueHandle(value.objectId, "Object"),
    collectionId: opaqueHandle(value.collectionId, "Collection"),
    objectTypeId: textResult(value.objectTypeId, 512, false, "Object 类型无效。"),
    title: textResult(value.title, 64 * 1024, true, "Object 标题无效。"),
    payloadJson,
    payloadSchemaVersion: safeInteger(value.payloadSchemaVersion, "Object 载荷 Schema 版本"),
    deleted: booleanResult(value.deleted, "Object 删除状态无效。")
  };
}

function objectWriteResult(input: unknown): Mdbx2ObjectWriteResult {
  const value = objectResult(input, "Native Host Object 写入响应无效。");
  return {
    commitId: textResult(value.commitId, 128, false, "Object Commit ID 无效。"),
    alreadyCommitted: booleanResult(value.alreadyCommitted, "Object 幂等状态无效。"),
    logicalObjectId: textResult(value.logicalObjectId, 4096, false, "逻辑 Object ID 无效。"),
    objectId: opaqueHandle(value.objectId, "Object"),
    collectionId: opaqueHandle(value.collectionId, "Collection"),
    objectTypeId: textResult(value.objectTypeId, 512, false, "Object 类型无效。")
  };
}

function objectDeleteResult(input: unknown): Mdbx2ObjectDeleteResult {
  const value = objectResult(input, "Native Host Object 删除响应无效。");
  const changed = booleanResult(value.changed, "Object 删除状态无效。");
  return {
    changed,
    commitId: changed ? textResult(value.commitId, 128, false, "Object 删除 Commit ID 无效。") : undefined,
    alreadyCommitted: changed ? booleanResult(value.alreadyCommitted, "Object 删除幂等状态无效。") : undefined,
    logicalObjectId: textResult(value.logicalObjectId, 4096, false, "逻辑 Object ID 无效。"),
    objectId: opaqueHandle(value.objectId, "Object")
  };
}

function commitHistoryPage(input: unknown): Mdbx2CommitHistoryPage {
  const value = objectResult(input, "Native Host MDBX2 历史分页响应无效。");
  if (!Array.isArray(value.items) || value.items.length > MDBX2_MAX_HISTORY_PAGE_SIZE) {
    throw incompatibleResult("Native Host MDBX2 历史分页大小无效。");
  }
  return {
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host MDBX2 历史项目无效。");
      if (!Array.isArray(item.changes) || item.changes.length > MDBX2_MAX_HISTORY_DIFF_ITEMS) {
        throw incompatibleResult("Native Host MDBX2 历史变更数量无效。");
      }
      return {
        commitId: opaqueHandle(item.commitId, "Commit"),
        deviceId: textResult(item.deviceId, 128, false, "MDBX2 历史设备 ID 无效。"),
        localSeq: safeInteger(item.localSeq, "MDBX2 历史序号"),
        commitKind: textResult(item.commitKind, 128, false, "MDBX2 Commit 类型无效。"),
        changeScope: textResult(item.changeScope, 128, false, "MDBX2 变更范围无效。"),
        createdAt: textResult(item.createdAt, 128, false, "MDBX2 历史时间无效。"),
        operationId: optionalString(item.operationId, 512, "MDBX2 操作 ID"),
        operationKind: optionalString(item.operationKind, 512, "MDBX2 操作类型"),
        branchName: optionalString(item.branchName, 1024, "MDBX2 分支名称"),
        message: optionalTextResult(item.message, 64 * 1024, true, "MDBX2 历史消息无效。"),
        changes: item.changes.map((changeCandidate) => {
          const change = objectResult(changeCandidate, "Native Host MDBX2 历史变更无效。");
          return {
            objectType: textResult(change.objectType, 512, false, "MDBX2 历史 Object 类型无效。"),
            objectId: textResult(change.objectId, 128, false, "MDBX2 历史 Object ID 无效。"),
            action: textResult(change.action, 128, false, "MDBX2 历史动作无效。"),
            fields: boundedTextArray(change.fields, 512, 4096, "MDBX2 历史字段")
          };
        }),
        parentIds: boundedTextArray(item.parentIds, 32, 128, "MDBX2 父 Commit"),
        legacy: booleanResult(item.legacy, "MDBX2 历史兼容标记无效。")
      };
    }),
    nextCursor: optionalString(value.nextCursor, 4096, "MDBX2 历史游标")
  };
}

function commitDiffResult(input: unknown): Mdbx2CommitDiffResult {
  const value = objectResult(input, "Native Host MDBX2 Commit 差异响应无效。");
  if (!Array.isArray(value.items) || value.items.length > MDBX2_MAX_HISTORY_DIFF_ITEMS) {
    throw incompatibleResult("Native Host MDBX2 Commit 差异数量无效。");
  }
  return {
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host MDBX2 Commit 差异项目无效。");
      return {
        commitId: opaqueHandle(item.commitId, "Commit"),
        objectType: textResult(item.objectType, 512, false, "MDBX2 Commit Object 类型无效。"),
        objectId: textResult(item.objectId, 128, false, "MDBX2 Commit Object ID 无效。"),
        collectionId: optionalOpaqueHandle(item.collectionId, "Collection"),
        previousTitle: optionalTextResult(item.previousTitle, 64 * 1024, true, "MDBX2 Commit 原标题无效。"),
        currentTitle: optionalTextResult(item.currentTitle, 64 * 1024, true, "MDBX2 Commit 新标题无效。"),
        previousDeleted: optionalBooleanResult(item.previousDeleted, "MDBX2 Commit 原删除状态无效。"),
        currentDeleted: booleanResult(item.currentDeleted, "MDBX2 Commit 删除状态无效。"),
        changedFields: boundedTextArray(item.changedFields, 512, 4096, "MDBX2 Commit 变更字段"),
        payloadChanged: booleanResult(item.payloadChanged, "MDBX2 Commit 内容变更状态无效。"),
        contentType: optionalString(item.contentType, 512, "MDBX2 Commit 内容类型"),
        createdAt: textResult(item.createdAt, 128, false, "MDBX2 Commit 差异时间无效。")
      };
    })
  };
}

function conflictSummaryPage(input: unknown): Mdbx2ConflictSummaryPage {
  const value = objectResult(input, "Native Host MDBX2 冲突分页响应无效。");
  if (!Array.isArray(value.items) || value.items.length > MDBX2_MAX_CONFLICT_PAGE_SIZE) {
    throw incompatibleResult("Native Host MDBX2 冲突分页大小无效。");
  }
  return {
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host MDBX2 冲突项目无效。");
      return {
        conflictId: opaqueHandle(item.conflictId, "冲突"),
        objectType: textResult(item.objectType, 128, false, "MDBX2 冲突 Object 类型无效。"),
        objectId: opaqueHandle(item.objectId, "冲突 Object"),
        displayTitle: optionalTextResult(item.displayTitle, 64 * 1024, true, "MDBX2 冲突标题无效。"),
        contentType: optionalString(item.contentType, 512, "MDBX2 冲突内容类型"),
        conflictingFields: boundedTextArray(item.conflictingFields, 256, 4096, "MDBX2 冲突字段"),
        createdAt: textResult(item.createdAt, 128, false, "MDBX2 冲突时间无效。")
      };
    }),
    nextCursor: optionalString(value.nextCursor, 4096, "MDBX2 冲突游标")
  };
}

function conflictResolutionResult(input: unknown): Mdbx2ConflictResolutionResult {
  const value = objectResult(input, "Native Host MDBX2 冲突解决响应无效。");
  if (value.resolved !== true) throw incompatibleResult("Native Host MDBX2 冲突解决状态无效。");
  return {
    resolved: true,
    alreadyResolved: booleanResult(value.alreadyResolved, "MDBX2 冲突重试状态无效。"),
    conflictId: opaqueHandle(value.conflictId, "冲突"),
    objectType: textResult(value.objectType, 128, false, "MDBX2 冲突 Object 类型无效。"),
    objectId: opaqueHandle(value.objectId, "冲突 Object"),
    choice: conflictResolutionChoiceResult(value.choice),
    resolvedAt: optionalString(value.resolvedAt, 128, "MDBX2 冲突解决时间")
  };
}

function objectBatchResult(input: unknown): Mdbx2ObjectBatchResult {
  const value = objectResult(input, "Native Host Object 批量响应无效。");
  const changed = booleanResult(value.changed, "Object 批量变更状态无效。");
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MDBX2_MAX_OBJECT_BATCH_MUTATIONS) {
    throw incompatibleResult("Native Host Object 批量项目数量无效。");
  }
  const commitId = changed ? textResult(value.commitId, 128, false, "Object 批量 Commit ID 无效。") : undefined;
  const alreadyCommitted = changed ? booleanResult(value.alreadyCommitted, "Object 批量幂等状态无效。") : undefined;
  return {
    changed,
    operationId: opaqueHandle(value.operationId, "操作"),
    commitId,
    alreadyCommitted,
    items: value.items.map((candidate) => {
      const item = objectResult(candidate, "Native Host Object 批量项目无效。");
      const kind = item.kind;
      if (kind !== "upsert" && kind !== "delete") throw incompatibleResult("Native Host Object 批量项目类型无效。");
      return {
        kind,
        changed: booleanResult(item.changed, "Object 批量项目状态无效。"),
        logicalObjectId: textResult(item.logicalObjectId, 4096, false, "逻辑 Object ID 无效。"),
        objectId: opaqueHandle(item.objectId, "Object"),
        collectionId: optionalOpaqueHandle(item.collectionId, "Collection"),
        objectTypeId: optionalString(item.objectTypeId, 512, "Object 类型")
      };
    })
  };
}

function objectOperationStatusResult(input: unknown): Mdbx2ObjectOperationStatus {
  const value = objectResult(input, "Native Host Object 操作状态响应无效。");
  const known = booleanResult(value.known, "Object 操作已知状态无效。");
  const committed = booleanResult(value.committed, "Object 操作提交状态无效。");
  if (!known && committed) throw incompatibleResult("未知的 Object 操作不能标记为已提交。");
  if (!known) return { known: false, committed: false };
  if (!committed) return { known: true, committed: false };
  return { known: true, committed: true, commitId: textResult(value.commitId, 128, false, "Object 操作 Commit ID 无效。") };
}

function objectOperationResolutionResult(input: unknown): Mdbx2ObjectOperationResolution {
  const value = objectResult(input, "Native Host Object 操作恢复响应无效。");
  const known = booleanResult(value.known, "Object 操作已知状态无效。");
  const committed = booleanResult(value.committed, "Object 操作提交状态无效。");
  if (!known && committed) throw incompatibleResult("未知的 Object 操作不能标记为已提交。");
  if (!known) return { known: false, committed: false };
  const operationId = opaqueHandle(value.operationId, "操作");
  if (!committed) return { known: true, committed: false, operationId };
  return {
    known: true,
    committed: true,
    operationId,
    commitId: textResult(value.commitId, 128, false, "Object 操作 Commit ID 无效。")
  };
}

function vaultSource(source: Mdbx2VaultSource): Mdbx2VaultSource {
  if (source.kind !== "file" && source.kind !== "vault") throw new Mdbx2NativeHostError("vault-source-invalid", "MDBX2 保险库来源无效。", false);
  return { kind: source.kind, handle: opaqueHandle(source.handle, "来源") };
}

function syncStateParams(vaultHandle: string, stateHandle: string, remoteBinding: string): Record<string, unknown> {
  return {
    vaultHandle: opaqueHandle(vaultHandle, "保险库"),
    stateHandle: opaqueHandle(stateHandle, "同步状态"),
    remoteBinding: sha256Value(remoteBinding, "远端绑定")
  };
}

function sha256Value(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Mdbx2NativeHostError("digest-invalid", `${label}无效。`, false);
  return value;
}

function sha256Result(value: unknown, label: string): string {
  const digest = stringResult(value, 64, `${label}无效。`);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw incompatibleResult(`${label}无效。`);
  return digest;
}

function optionalSha256(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : sha256Result(value, label);
}

function remoteComponent(value: string, label: string): string {
  const normalized = textResult(value.trim(), 256, false, `${label}无效。`);
  if (normalized === "." || normalized === ".." || /[\\/\0]/.test(normalized)) throw new Mdbx2NativeHostError("remote-component-invalid", `${label}无效。`, false);
  return normalized;
}

function remoteComponentResult(value: unknown, label: string): string {
  const component = textResult(value, 256, false, `${label}无效。`);
  if (component !== component.trim() || component === "." || component === ".." || /[\\/\0]/.test(component)) throw incompatibleResult(`${label}无效。`);
  return component;
}

function binaryChunkSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MDBX2_MAX_BINARY_CHUNK_BYTES) throw new Mdbx2NativeHostError("chunk-size-invalid", "MDBX2 分块大小无效。", false);
  return value;
}

function remoteBlobSize(value: unknown): number {
  const size = positiveSafeInteger(value, "MDBX2 Blob 大小");
  if (size > MDBX2_MAX_REMOTE_BLOB_BYTES) throw incompatibleResult("MDBX2 Blob 大小超过允许范围。");
  return size;
}

function optionalRemoteBlobSize(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : remoteBlobSize(value);
}

function positiveSafeInteger(value: unknown, label: string): number {
  const number = safeInteger(value, label);
  if (number < 1) throw incompatibleResult(`${label}无效。`);
  return number;
}

function decodeBoundedBase64(value: string, maximum: number, message: string): Uint8Array {
  try {
    const bytes = base64ToBytes(value);
    if (!bytes.length || bytes.length > maximum) throw new Error();
    return bytes;
  } catch {
    throw incompatibleResult(message);
  }
}

function objectResult(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw incompatibleResult(message);
  return value as Record<string, unknown>;
}

function opaqueHandle(value: unknown, label: string): string {
  const handle = stringResult(value, 36, `${label}句柄无效。`);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(handle)) throw incompatibleResult(`${label}句柄无效。`);
  return handle;
}

function optionalOpaqueHandle(value: unknown, label: string): string | undefined {
  return value === null || value === undefined ? undefined : opaqueHandle(value, label);
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw incompatibleResult(`${label}无效。`);
  return value;
}

function pageSizeValue(value: number | undefined): number {
  const pageSize = value ?? MDBX2_MAX_SUMMARY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MDBX2_MAX_SUMMARY_PAGE_SIZE) throw new Mdbx2NativeHostError("page-size-invalid", "MDBX2 摘要分页大小无效。", false);
  return pageSize;
}

function historyPageSizeValue(value: number | undefined): number {
  const pageSize = value ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MDBX2_MAX_HISTORY_PAGE_SIZE) {
    throw new Mdbx2NativeHostError("history-page-size-invalid", "MDBX2 历史分页大小无效。", false);
  }
  return pageSize;
}

function conflictPageSizeValue(value: number | undefined): number {
  const pageSize = value ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MDBX2_MAX_CONFLICT_PAGE_SIZE) {
    throw new Mdbx2NativeHostError("conflict-page-size-invalid", "MDBX2 冲突分页大小无效。", false);
  }
  return pageSize;
}

function conflictResolutionChoiceValue(value: unknown): Mdbx2ConflictResolutionChoice {
  if (value === "local-wins" || value === "incoming-wins") return value;
  throw new Mdbx2NativeHostError("conflict-choice-invalid", "MDBX2 冲突解决方式无效。", false);
}

function conflictResolutionChoiceResult(value: unknown): Mdbx2ConflictResolutionChoice {
  if (value === "local-wins" || value === "incoming-wins") return value;
  throw incompatibleResult("Native Host MDBX2 冲突解决方式无效。");
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : safeInteger(value, label);
}

function stringResult(value: unknown, maxBytes: number, message: string): string {
  return textResult(value, maxBytes, false, message);
}

function textResult(value: unknown, maxBytes: number, allowEmpty: boolean, message: string): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || new TextEncoder().encode(value).byteLength > maxBytes) throw incompatibleResult(message);
  return value;
}

function optionalString(value: unknown, maxBytes: number, label: string): string | undefined {
  return value === null || value === undefined ? undefined : stringResult(value, maxBytes, `${label}无效。`);
}

function optionalTextResult(value: unknown, maxBytes: number, allowEmpty: boolean, message: string): string | undefined {
  return value === null || value === undefined ? undefined : textResult(value, maxBytes, allowEmpty, message);
}

function optionalBooleanResult(value: unknown, message: string): boolean | undefined {
  return value === null || value === undefined ? undefined : booleanResult(value, message);
}

function boundedTextArray(value: unknown, maxItems: number, maxBytes: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw incompatibleResult(`${label}列表无效。`);
  return value.map((entry) => textResult(entry, maxBytes, false, `${label}无效。`));
}

function booleanResult(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw incompatibleResult(message);
  return value;
}

function incompatibleResult(message: string): Mdbx2NativeHostError {
  return new Mdbx2NativeHostError("native-host-incompatible", message, false);
}
