import { createSHA256 } from "hash-wasm";
import { base64ToBytes } from "../../security/encoding";
import {
  KEEPASS_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_ATTACHMENT_UPLOAD_TTL_MS,
  ProviderAttachmentError,
  type ProviderAttachmentMutationResult,
  type ProviderAttachmentReadBeginResult,
  type ProviderAttachmentReadChunk,
  type ProviderAttachmentSummary,
  type ProviderAttachmentUploadBeginResult,
  type ProviderAttachmentUploadChunkResult
} from "./attachment-contract";

export type ProviderAttachmentTransferMode = "copy" | "move";

export interface ProviderAttachmentTransferRequest {
  operationId: string;
  sourceProviderId: string;
  sourceItemId: string;
  sourceAttachmentId: string;
  targetProviderId: string;
  targetItemId: string;
  mode: ProviderAttachmentTransferMode;
  confirmedMove: boolean;
}

export interface ProviderAttachmentTransferResult {
  operationId: string;
  mode: ProviderAttachmentTransferMode;
  copiedBytes: number;
  sourceDeleted: boolean;
  attachment: ProviderAttachmentSummary;
}

export interface ProviderAttachmentTransferBackend {
  beginRead(providerId: string, itemId: string, attachmentId: string): Promise<ProviderAttachmentReadBeginResult>;
  readChunk(providerId: string, readHandle: string, offset: number, maxBytes: number): Promise<ProviderAttachmentReadChunk>;
  releaseRead(providerId: string, readHandle: string): Promise<boolean>;
  beginUpload(providerId: string, itemId: string, input: {
    fileName: string;
    mediaType?: string;
    sizeBytes: number;
    replaceExisting: false;
    operationId: string;
    attachmentId: string;
  }): Promise<ProviderAttachmentUploadBeginResult>;
  uploadChunk(providerId: string, transferId: string, offset: number, bytes: Uint8Array): Promise<ProviderAttachmentUploadChunkResult>;
  finishUpload(providerId: string, itemId: string, transferId: string, operationId?: string): Promise<ProviderAttachmentMutationResult>;
  abortUpload(providerId: string, transferId: string): Promise<boolean>;
  deleteAttachment(providerId: string, itemId: string, attachmentId: string, operationId: string): Promise<ProviderAttachmentMutationResult>;
}

interface ActiveTransfer {
  fingerprint: string;
  promise: Promise<ProviderAttachmentTransferResult>;
}

interface CompletedTransfer {
  fingerprint: string;
  result: ProviderAttachmentTransferResult;
  expiresAt: number;
}

const MAX_COMPLETED_TRANSFERS = 64;

export class ProviderAttachmentTransferCoordinator {
  private readonly active = new Map<string, ActiveTransfer>();
  private readonly completed = new Map<string, CompletedTransfer>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async execute(input: ProviderAttachmentTransferRequest, backend: ProviderAttachmentTransferBackend): Promise<ProviderAttachmentTransferResult> {
    const request = validateRequest(input);
    const fingerprint = JSON.stringify(request);
    this.pruneCompleted();
    const completed = this.completed.get(request.operationId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new ProviderAttachmentError("attachment-transfer-operation-reused", "附件传输操作标识已用于其他来源、目标或模式。");
      }
      return cloneTransferResult(completed.result);
    }
    const existing = this.active.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ProviderAttachmentError("attachment-transfer-operation-reused", "附件传输操作标识已用于其他来源、目标或模式。");
      }
      return existing.promise;
    }
    const promise = this.executeOnce(request, backend)
      .then((result) => {
        this.rememberCompleted(fingerprint, result);
        return cloneTransferResult(result);
      })
      .finally(() => {
        if (this.active.get(request.operationId)?.promise === promise) this.active.delete(request.operationId);
      });
    this.active.set(request.operationId, { fingerprint, promise });
    return promise;
  }

  private async executeOnce(request: ProviderAttachmentTransferRequest, backend: ProviderAttachmentTransferBackend): Promise<ProviderAttachmentTransferResult> {
    const targetOperationId = await derivedUuid(request.operationId, "target-upload");
    const targetAttachmentId = await derivedUuid(request.operationId, "target-attachment");
    const targetCleanupOperationId = await derivedUuid(request.operationId, "target-cleanup");
    const sourceDeleteOperationId = await derivedUuid(request.operationId, "source-delete");
    const source = await backend.beginRead(request.sourceProviderId, request.sourceItemId, request.sourceAttachmentId);
    validateReadBegin(source, request.sourceAttachmentId);
    let targetTransferId: string | undefined;
    let finishAttempted = false;
    try {
      const upload = await backend.beginUpload(request.targetProviderId, request.targetItemId, {
        fileName: source.fileName,
        mediaType: source.mediaType,
        sizeBytes: source.sizeBytes,
        replaceExisting: false,
        operationId: targetOperationId,
        attachmentId: targetAttachmentId
      });
      targetTransferId = upload.transferId;
      validateUploadBegin(upload, source.sizeBytes);
      const sourceDigest = await copySourceToTarget(request, source, upload, backend);
      finishAttempted = true;
      const targetCommitted = await backend.finishUpload(request.targetProviderId, request.targetItemId, upload.transferId, targetOperationId);
      let targetAttachment: ProviderAttachmentSummary;
      try {
        targetAttachment = validateTargetMutation(targetCommitted, source);
        const targetDigest = await hashAttachment(
          backend,
          request.targetProviderId,
          request.targetItemId,
          targetAttachment.attachmentId,
          source.fileName,
          source.sizeBytes
        );
        if (targetDigest !== sourceDigest) {
          throw new ProviderAttachmentError("attachment-transfer-digest-mismatch", "目标附件与来源附件的 SHA-256 不一致。");
        }
      } catch (cause) {
        let cleanupConfirmed = false;
        const cleanupAttachmentId = targetCommitted.attachment?.attachmentId;
        if (typeof cleanupAttachmentId === "string" && cleanupAttachmentId) {
          try {
            cleanupConfirmed = (await backend.deleteAttachment(
              request.targetProviderId,
              request.targetItemId,
              cleanupAttachmentId,
              targetCleanupOperationId
            )).changed;
          } catch {
            cleanupConfirmed = false;
          }
        }
        throw withCause(new ProviderAttachmentError(
          "attachment-transfer-verification-failed",
          cleanupConfirmed
            ? "目标附件完整性验证失败，已删除目标副本；来源附件保持不变。"
            : "目标附件完整性验证失败，目标清理结果不确定；来源附件保持不变，请检查目标密码源。"
        ), cause);
      }

      if (request.mode === "move") {
        try {
          const deleted = await backend.deleteAttachment(
            request.sourceProviderId,
            request.sourceItemId,
            request.sourceAttachmentId,
            sourceDeleteOperationId
          );
          if (!deleted.changed) {
            throw new ProviderAttachmentError("attachment-transfer-source-delete-unconfirmed", "目标附件已验证，但来源附件删除结果未确认；两个副本均保留。");
          }
        } catch (cause) {
          if (cause instanceof ProviderAttachmentError && cause.code === "attachment-transfer-source-delete-unconfirmed") throw cause;
          throw withCause(new ProviderAttachmentError(
            "attachment-transfer-source-delete-failed",
            "目标附件已完整写入，但来源附件删除失败；为避免数据丢失，两个副本均保留。"
          ), cause);
        }
      }

      return {
        operationId: request.operationId,
        mode: request.mode,
        copiedBytes: source.sizeBytes,
        sourceDeleted: request.mode === "move",
        attachment: { ...targetAttachment }
      };
    } catch (cause) {
      if (targetTransferId && !finishAttempted) await backend.abortUpload(request.targetProviderId, targetTransferId).catch(() => false);
      throw cause;
    } finally {
      await backend.releaseRead(request.sourceProviderId, source.readHandle).catch(() => false);
    }
  }

  private rememberCompleted(fingerprint: string, result: ProviderAttachmentTransferResult): void {
    this.pruneCompleted();
    while (this.completed.size >= MAX_COMPLETED_TRANSFERS) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
    this.completed.set(result.operationId, {
      fingerprint,
      result: cloneTransferResult(result),
      expiresAt: this.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS
    });
  }

  private pruneCompleted(): void {
    const now = this.now();
    for (const [operationId, receipt] of this.completed) {
      if (receipt.expiresAt <= now) this.completed.delete(operationId);
    }
  }
}

async function copySourceToTarget(
  request: ProviderAttachmentTransferRequest,
  source: ProviderAttachmentReadBeginResult,
  upload: ProviderAttachmentUploadBeginResult,
  backend: ProviderAttachmentTransferBackend
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  let sourceOffset = 0;
  let targetOffset = upload.nextOffset;
  while (sourceOffset < source.sizeBytes) {
    const resumeBoundary = sourceOffset < targetOffset ? targetOffset - sourceOffset : Number.POSITIVE_INFINITY;
    const maxBytes = Math.min(
      source.maxChunkBytes,
      upload.maxChunkBytes,
      PROVIDER_ATTACHMENT_CHUNK_BYTES,
      source.sizeBytes - sourceOffset,
      resumeBoundary
    );
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new ProviderAttachmentError("attachment-transfer-boundary-invalid", "附件传输恢复边界无效。");
    }
    const chunk = await backend.readChunk(request.sourceProviderId, source.readHandle, sourceOffset, maxBytes);
    const bytes = validateReadChunk(source, chunk, sourceOffset, maxBytes);
    try {
      hasher.update(bytes);
      if (sourceOffset >= targetOffset) {
        const written = await backend.uploadChunk(request.targetProviderId, upload.transferId, targetOffset, bytes);
        if (written.transferId !== upload.transferId || written.nextOffset !== chunk.nextOffset) {
          throw new ProviderAttachmentError("attachment-transfer-upload-boundary-invalid", "目标附件上传偏移没有与来源分块同步前进。");
        }
        if (!written.repeated && written.acceptedBytes !== bytes.byteLength) {
          throw new ProviderAttachmentError("attachment-transfer-upload-size-invalid", "目标附件上传确认的字节数无效。");
        }
        targetOffset = written.nextOffset;
      }
      sourceOffset = chunk.nextOffset;
    } finally {
      bytes.fill(0);
    }
  }
  if (targetOffset !== source.sizeBytes) {
    throw new ProviderAttachmentError("attachment-transfer-upload-incomplete", "目标附件上传没有达到来源附件大小。");
  }
  return hasher.digest("hex");
}

async function hashAttachment(
  backend: ProviderAttachmentTransferBackend,
  providerId: string,
  itemId: string,
  attachmentId: string,
  expectedName: string,
  expectedSize: number
): Promise<string> {
  const read = await backend.beginRead(providerId, itemId, attachmentId);
  validateReadBegin(read, attachmentId);
  if (read.fileName !== expectedName || read.sizeBytes !== expectedSize) {
    await backend.releaseRead(providerId, read.readHandle).catch(() => false);
    throw new ProviderAttachmentError("attachment-transfer-target-mismatch", "目标附件名称或大小与来源不一致。");
  }
  const hasher = await createSHA256();
  hasher.init();
  let offset = 0;
  try {
    while (offset < read.sizeBytes) {
      const maxBytes = Math.min(read.maxChunkBytes, PROVIDER_ATTACHMENT_CHUNK_BYTES, read.sizeBytes - offset);
      const chunk = await backend.readChunk(providerId, read.readHandle, offset, maxBytes);
      const bytes = validateReadChunk(read, chunk, offset, maxBytes);
      try {
        hasher.update(bytes);
        offset = chunk.nextOffset;
      } finally {
        bytes.fill(0);
      }
    }
    return hasher.digest("hex");
  } finally {
    await backend.releaseRead(providerId, read.readHandle).catch(() => false);
  }
}

function validateRequest(input: ProviderAttachmentTransferRequest): ProviderAttachmentTransferRequest {
  if (!isUuid(input.operationId)) throw new ProviderAttachmentError("attachment-transfer-operation-invalid", "附件传输操作标识无效。");
  for (const [label, value] of [
    ["来源密码源", input.sourceProviderId],
    ["来源项目", input.sourceItemId],
    ["来源附件", input.sourceAttachmentId],
    ["目标密码源", input.targetProviderId],
    ["目标项目", input.targetItemId]
  ] as const) {
    if (typeof value !== "string" || !value) throw new ProviderAttachmentError("attachment-transfer-target-invalid", `${label}无效。`);
  }
  if (input.mode !== "copy" && input.mode !== "move") throw new ProviderAttachmentError("attachment-transfer-mode-invalid", "附件传输模式无效。");
  if (input.mode === "move" && input.confirmedMove !== true) {
    throw new ProviderAttachmentError("attachment-transfer-confirmation-required", "移动附件需要明确确认来源删除。");
  }
  if (input.sourceProviderId === input.targetProviderId && input.sourceItemId === input.targetItemId) {
    throw new ProviderAttachmentError("attachment-transfer-same-target", "来源和目标不能是同一密码源中的同一项目。");
  }
  return { ...input, confirmedMove: input.mode === "move" };
}

function validateReadBegin(read: ProviderAttachmentReadBeginResult, expectedAttachmentId: string): void {
  if (read.attachmentId !== expectedAttachmentId || !read.readHandle) {
    throw new ProviderAttachmentError("attachment-transfer-read-target-mismatch", "附件读取会话与请求的附件不一致。");
  }
  if (!Number.isSafeInteger(read.sizeBytes) || read.sizeBytes < 0 || read.sizeBytes > KEEPASS_ATTACHMENT_MAX_BYTES) {
    throw new ProviderAttachmentError("attachment-transfer-size-invalid", "附件大小超过跨密码源传输的 256 MiB 上限。");
  }
  if (!Number.isSafeInteger(read.maxChunkBytes) || read.maxChunkBytes < 1 || read.maxChunkBytes > PROVIDER_ATTACHMENT_CHUNK_BYTES) {
    throw new ProviderAttachmentError("attachment-transfer-chunk-limit-invalid", "附件读取分块上限与后台协议不一致。");
  }
}

function validateReadChunk(
  read: ProviderAttachmentReadBeginResult,
  chunk: ProviderAttachmentReadChunk,
  expectedOffset: number,
  maxBytes: number
): Uint8Array {
  if (
    chunk.readHandle !== read.readHandle
      || chunk.attachmentId !== read.attachmentId
      || chunk.fileName !== read.fileName
      || chunk.sizeBytes !== read.sizeBytes
      || chunk.offset !== expectedOffset
      || chunk.nextOffset <= expectedOffset
      || chunk.nextOffset > read.sizeBytes
      || chunk.nextOffset - expectedOffset > maxBytes
      || chunk.eof !== (chunk.nextOffset === read.sizeBytes)
  ) {
    throw new ProviderAttachmentError("attachment-transfer-read-boundary-invalid", "附件读取分块描述无效或没有前进。");
  }
  const bytes = base64ToBytes(chunk.dataBase64);
  if (bytes.byteLength !== chunk.nextOffset - expectedOffset) {
    bytes.fill(0);
    throw new ProviderAttachmentError("attachment-transfer-read-size-invalid", "附件读取分块字节数与描述不一致。");
  }
  return bytes;
}

function validateUploadBegin(upload: ProviderAttachmentUploadBeginResult, sizeBytes: number): void {
  if (!upload.transferId || !Number.isSafeInteger(upload.nextOffset) || upload.nextOffset < 0 || upload.nextOffset > sizeBytes) {
    throw new ProviderAttachmentError("attachment-transfer-upload-state-invalid", "目标附件上传恢复状态无效。");
  }
  if (!Number.isSafeInteger(upload.maxChunkBytes) || upload.maxChunkBytes < 1 || upload.maxChunkBytes > PROVIDER_ATTACHMENT_CHUNK_BYTES) {
    throw new ProviderAttachmentError("attachment-transfer-upload-limit-invalid", "目标附件上传分块上限与后台协议不一致。");
  }
}

function validateTargetMutation(result: ProviderAttachmentMutationResult, source: ProviderAttachmentReadBeginResult): ProviderAttachmentSummary {
  const attachment = result.attachment;
  if (!attachment || !attachment.attachmentId || attachment.fileName !== source.fileName || attachment.sizeBytes !== source.sizeBytes) {
    throw new ProviderAttachmentError("attachment-transfer-target-mismatch", "目标附件写入结果与来源名称或大小不一致。");
  }
  return { ...attachment };
}

function cloneTransferResult(result: ProviderAttachmentTransferResult): ProviderAttachmentTransferResult {
  return { ...result, attachment: { ...result.attachment } };
}

async function derivedUuid(operationId: string, scope: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${operationId}\0${scope}`)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

function withCause<T extends Error>(error: T, cause: unknown): T {
  (error as T & { cause?: unknown }).cause = cause;
  return error;
}
