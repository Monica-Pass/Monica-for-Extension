import {
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS,
  PROVIDER_ATTACHMENT_MAX_MEDIA_TYPE_BYTES,
  PROVIDER_ATTACHMENT_MAX_NAME_BYTES,
  PROVIDER_ATTACHMENT_UPLOAD_TTL_MS,
  ProviderAttachmentError,
  type ProviderAttachmentMutationResult,
  type ProviderAttachmentUploadBeginResult,
  type ProviderAttachmentUploadChunkResult,
  type ProviderAttachmentUploadIntent
} from "./attachment-contract";

interface PendingAttachmentUpload {
  transferId: string;
  intent: ProviderAttachmentUploadIntent;
  bytes: Uint8Array;
  receivedBytes: number;
  expiresAt: number;
  verifiedSha256?: string;
  committedResult?: ProviderAttachmentMutationResult;
}

export interface CompletedAttachmentUpload {
  transferId: string;
  intent: ProviderAttachmentUploadIntent;
  bytes: Uint8Array;
  sha256: string;
}

export class ProviderAttachmentUploadStore {
  private readonly uploads = new Map<string, PendingAttachmentUpload>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly randomId: () => string = () => crypto.randomUUID()
  ) {}

  begin(input: ProviderAttachmentUploadIntent, maxBytes: number): ProviderAttachmentUploadBeginResult {
    this.pruneExpired();
    if (this.uploads.size >= PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) {
      throw new ProviderAttachmentError("attachment-upload-limit", "同时进行的附件上传过多，请完成或取消现有上传。");
    }
    const intent = validateIntent(input, maxBytes);
    let transferId = this.randomId();
    while (this.uploads.has(transferId)) transferId = this.randomId();
    const expiresAt = this.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
    this.uploads.set(transferId, {
      transferId,
      intent,
      bytes: new Uint8Array(intent.sizeBytes),
      receivedBytes: 0,
      expiresAt
    });
    return {
      transferId,
      nextOffset: 0,
      maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES,
      expiresAt,
      operationId: intent.operationId,
      attachmentId: intent.attachmentId
    };
  }

  write(transferId: string, offset: number, bytes: Uint8Array): ProviderAttachmentUploadChunkResult {
    const upload = this.requireUpload(transferId);
    if (upload.committedResult) throw new ProviderAttachmentError("attachment-upload-already-committed", "此附件上传已经写入密码源。");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ProviderAttachmentError("attachment-upload-offset-invalid", "附件上传偏移量无效。");
    }
    if (!bytes.length || bytes.length > PROVIDER_ATTACHMENT_CHUNK_BYTES) {
      throw new ProviderAttachmentError("attachment-upload-chunk-invalid", "附件上传分块为空或超过 256 KiB。");
    }
    if (offset + bytes.length > upload.intent.sizeBytes) {
      throw new ProviderAttachmentError("attachment-upload-size-mismatch", "附件上传分块超过声明的文件大小。");
    }
    if (offset < upload.receivedBytes) {
      if (offset + bytes.length > upload.receivedBytes || !equalBytes(upload.bytes.subarray(offset, offset + bytes.length), bytes)) {
        throw new ProviderAttachmentError("attachment-upload-overlap-mismatch", "附件上传重试分块与已接收内容不一致。");
      }
      upload.expiresAt = this.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
      return { transferId, nextOffset: upload.receivedBytes, acceptedBytes: 0, repeated: true };
    }
    if (offset !== upload.receivedBytes) {
      throw new ProviderAttachmentError("attachment-upload-gap", "附件上传必须从后台确认的下一偏移量继续。");
    }
    upload.bytes.set(bytes, offset);
    upload.receivedBytes += bytes.length;
    upload.verifiedSha256 = undefined;
    upload.expiresAt = this.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
    return { transferId, nextOffset: upload.receivedBytes, acceptedBytes: bytes.length, repeated: false };
  }

  async complete(transferId: string): Promise<CompletedAttachmentUpload> {
    const upload = this.requireUpload(transferId);
    if (upload.committedResult) throw new ProviderAttachmentError("attachment-upload-already-committed", "此附件上传已经写入密码源。");
    if (upload.receivedBytes !== upload.intent.sizeBytes) {
      throw new ProviderAttachmentError("attachment-upload-incomplete", `附件仅接收 ${upload.receivedBytes} / ${upload.intent.sizeBytes} 字节。`);
    }
    const digest = upload.verifiedSha256 || await sha256Hex(upload.bytes);
    upload.verifiedSha256 = digest;
    if (upload.intent.sha256 && upload.intent.sha256 !== digest) {
      this.release(transferId);
      throw new ProviderAttachmentError("attachment-upload-digest-mismatch", "附件 SHA-256 校验失败，上传内容已丢弃。");
    }
    upload.expiresAt = this.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
    return { transferId, intent: upload.intent, bytes: upload.bytes, sha256: digest };
  }

  committedResult(transferId: string): ProviderAttachmentMutationResult | undefined {
    const result = this.requireUpload(transferId).committedResult;
    return result ? { ...result, attachment: result.attachment ? { ...result.attachment } : undefined } : undefined;
  }

  intent(transferId: string): ProviderAttachmentUploadIntent | undefined {
    this.pruneExpired();
    const intent = this.uploads.get(transferId)?.intent;
    return intent ? { ...intent } : undefined;
  }

  markCommitted(transferId: string, result: ProviderAttachmentMutationResult): void {
    const upload = this.requireUpload(transferId);
    upload.bytes.fill(0);
    upload.bytes = new Uint8Array();
    upload.committedResult = { ...result, attachment: result.attachment ? { ...result.attachment } : undefined };
    upload.expiresAt = this.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
  }

  abort(transferId: string): boolean {
    return this.release(transferId);
  }

  release(transferId: string): boolean {
    const upload = this.uploads.get(transferId);
    if (!upload) return false;
    upload.bytes.fill(0);
    this.uploads.delete(transferId);
    return true;
  }

  has(transferId: string): boolean {
    this.pruneExpired();
    return this.uploads.has(transferId);
  }

  private requireUpload(transferId: string): PendingAttachmentUpload {
    this.pruneExpired();
    const upload = this.uploads.get(transferId);
    if (!upload) throw new ProviderAttachmentError("attachment-upload-not-found", "附件上传已过期或 Service Worker 已重启，请重新选择文件。");
    return upload;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [transferId, upload] of this.uploads) {
      if (upload.expiresAt <= now) this.release(transferId);
    }
  }
}

function validateIntent(input: ProviderAttachmentUploadIntent, maxBytes: number): ProviderAttachmentUploadIntent {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("附件提供方大小上限无效。");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > maxBytes) {
    throw new ProviderAttachmentError("attachment-size-invalid", `附件大小超过此密码源允许的 ${formatBytes(maxBytes)} 上限。`);
  }
  if (typeof input.fileName !== "string" || !input.fileName.trim() || utf8Bytes(input.fileName) > PROVIDER_ATTACHMENT_MAX_NAME_BYTES || input.fileName.includes("\0")) {
    throw new ProviderAttachmentError("attachment-name-invalid", "附件名称为空、包含 NUL 或超过 4096 个 UTF-8 字节。");
  }
  if (input.mediaType !== undefined && (typeof input.mediaType !== "string" || utf8Bytes(input.mediaType) > PROVIDER_ATTACHMENT_MAX_MEDIA_TYPE_BYTES)) {
    throw new ProviderAttachmentError("attachment-media-type-invalid", "附件媒体类型超过 512 个 UTF-8 字节。");
  }
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new ProviderAttachmentError("attachment-sha256-invalid", "附件 SHA-256 必须是 64 位小写十六进制。");
  }
  if (input.providerKind !== "keepass" && input.providerKind !== "bitwarden" && input.providerKind !== "mdbx2") {
    throw new ProviderAttachmentError("attachment-provider-invalid", "附件密码源类型无效。");
  }
  if (typeof input.providerId !== "string" || !input.providerId || typeof input.itemId !== "string" || !input.itemId) {
    throw new ProviderAttachmentError("attachment-target-invalid", "附件目标密码源或项目无效。");
  }
  if (input.operationId !== undefined && !isUuid(input.operationId)) {
    throw new ProviderAttachmentError("attachment-operation-invalid", "附件操作 ID 无效。");
  }
  if (input.attachmentId !== undefined && !isUuid(input.attachmentId)) {
    throw new ProviderAttachmentError("attachment-id-invalid", "附件 ID 无效。");
  }
  return { ...input, mediaType: input.mediaType?.trim() || undefined, replaceExisting: input.replaceExisting === true };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}
