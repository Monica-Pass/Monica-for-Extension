import type { ProviderAccount, ProviderSourceRecord, VaultItem } from "../../core/model";
import { base64ToBytes } from "../../security/encoding";
import {
  MDBX2_MAX_BINARY_CHUNK_BYTES
} from "./native-contract";
import { mdbx2TransferUuid } from "./mdbx2-transfer-identity";
import type {
  Mdbx2BatchTransferAttachmentBridge,
  Mdbx2BatchTransferNativeClient,
  Mdbx2TransferAttachmentDescriptor
} from "./mdbx2-batch-transfer-coordinator";
import type { KeePassProvider } from "../keepass/keepass-provider";
import { PROVIDER_ATTACHMENT_CHUNK_BYTES } from "../attachments/attachment-contract";

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 512;
const MAX_RETRIES = 2;

export class Mdbx2TransferAttachmentService implements Mdbx2BatchTransferAttachmentBridge {
  constructor(
    private readonly nativeClient: Mdbx2BatchTransferNativeClient,
    private readonly keepassProvider: Pick<KeePassProvider, "listAttachments" | "readAttachment">,
    private readonly sourceRecords?: (providerId: string) => Promise<ProviderSourceRecord[]>
  ) {}

  async listSourceAttachments(account: ProviderAccount, item: VaultItem): Promise<readonly Mdbx2TransferAttachmentDescriptor[]> {
    if (account.kind === "keepass") {
      return this.keepassProvider.listAttachments(account, item).map((attachment) => ({
        attachmentId: attachment.attachmentId,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
        mediaType: attachment.mediaType,
        protected: attachment.protected
      }));
    }
    if (account.kind === "mdbx2") {
      const reference = item.providerRefs.find((candidate) => candidate.providerId === account.id);
      const vaultHandle = vaultHandleOf(account);
      const collectionId = reference?.remoteFolderId || item.mdbxFolderId;
      const objectId = reference?.remoteId;
      if (!collectionId || !objectId) throw new Error("来源 MDBX2 项目缺少附件目标标识。");
      const attachments: Mdbx2TransferAttachmentDescriptor[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await this.nativeClient.listAttachments(vaultHandle, collectionId, objectId, { pageSize: 50, cursor });
        attachments.push(...page.items.map((attachment) => ({ ...attachment })));
        if (attachments.length > MAX_ATTACHMENT_COUNT) throw new Error("单个项目附件数量超过浏览器上限。");
        if (!page.nextCursor) break;
        if (!page.items.length || seen.has(page.nextCursor)) throw new Error("MDBX2 附件分页游标没有前进。");
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (cursor);
      return attachments;
    }
    if (account.kind === "bitwarden") {
      const records = this.sourceRecords ? await this.sourceRecords(account.id) : [];
      const reference = item.providerRefs.find((candidate) => candidate.providerId === account.id);
      const record = records.find((candidate) => candidate.remoteId === reference?.remoteId);
      const attachments = record ? parseBitwardenAttachments(record.payload) : [];
      if (attachments.length) {
        throw new Error("Bitwarden 附件当前没有安全读取接口，来源项目已保留。");
      }
      return [];
    }
    if (item.imagePaths?.length) throw new Error("来源图片附件当前没有安全读取接口，来源项目已保留。");
    return [];
  }

  async transferAttachments(
    account: ProviderAccount,
    sourceItem: VaultItem,
    targetAccount: ProviderAccount,
    targetItem: VaultItem,
    operationId: string
  ): Promise<number> {
    if (account.kind === "mdbx2" && targetAccount.kind === "mdbx2" && account.id === targetAccount.id) return 0;
    const sourceAttachments = await this.listSourceAttachments(account, sourceItem);
    if (!sourceAttachments.length) return 0;
    const targetReference = targetItem.providerRefs.find((reference) => reference.providerId === targetAccount.id);
    const collectionId = targetReference?.remoteFolderId || targetItem.mdbxFolderId;
    const objectId = targetReference?.remoteId;
    if (targetAccount.kind !== "mdbx2" || !collectionId || !objectId) throw new Error("目标 MDBX2 项目缺少附件写入标识。");
    let copied = 0;
    for (const attachment of sourceAttachments) {
      const bytes = await this.readSourceAttachment(account, sourceItem, attachment);
      const digest = await sha256Hex(bytes);
      if (bytes.byteLength !== attachment.sizeBytes) throw new Error(`附件「${attachment.fileName}」大小校验失败。`);
      const attachmentId = await mdbx2TransferUuid(operationId, `attachment:${attachment.attachmentId}`);
      const uploadOperationId = await mdbx2TransferUuid(operationId, `attachment-operation:${attachment.attachmentId}`);
      await this.uploadTargetAttachment(
        vaultHandleOf(targetAccount),
        { ...attachment, attachmentId, sizeBytes: bytes.byteLength },
        collectionId,
        objectId,
        uploadOperationId,
        digest,
        bytes
      );
      copied += 1;
    }
    return copied;
  }

  private async readSourceAttachment(
    account: ProviderAccount,
    item: VaultItem,
    attachment: Mdbx2TransferAttachmentDescriptor
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes < 0 || attachment.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件「${attachment.fileName}」大小超过 64 MiB 上限。`);
    }
    const bytes = new Uint8Array(attachment.sizeBytes);
    let offset = 0;
    if (account.kind === "keepass") {
      while (offset < bytes.length || (offset === 0 && bytes.length === 0)) {
        const chunk = this.keepassProvider.readAttachment(account, item, attachment.attachmentId, offset, PROVIDER_ATTACHMENT_CHUNK_BYTES);
        if (chunk.offset !== offset || chunk.nextOffset < offset || chunk.nextOffset > bytes.length) throw new Error("KeePass 附件读取边界无效。");
        bytes.set(chunk.bytes, offset);
        offset = chunk.nextOffset;
        if (chunk.eof) break;
        if (!chunk.bytes.length) throw new Error("KeePass 附件读取没有前进。");
      }
      if (offset !== bytes.length) throw new Error(`KeePass 附件「${attachment.fileName}」读取不完整。`);
      return bytes;
    }
    if (account.kind === "mdbx2") {
      const reference = item.providerRefs.find((candidate) => candidate.providerId === account.id);
      const read = await this.nativeClient.beginAttachmentRead(vaultHandleOf(account), attachment.attachmentId);
      if (read.attachmentId !== attachment.attachmentId || read.sizeBytes !== attachment.sizeBytes) throw new Error("MDBX2 附件读取目标不一致。");
      try {
        while (offset < bytes.length || (offset === 0 && bytes.length === 0)) {
          const chunk = await this.nativeClient.readAttachmentChunk(read.readHandle, offset, Math.min(read.maxChunkBytes, MDBX2_MAX_BINARY_CHUNK_BYTES));
          if (chunk.offset !== offset || chunk.nextOffset < offset || chunk.nextOffset > bytes.length) throw new Error("MDBX2 附件读取边界无效。");
          const data = base64ToBytes(chunk.dataBase64);
          if (data.length !== chunk.nextOffset - offset) throw new Error("MDBX2 附件分块长度无效。");
          bytes.set(data, offset);
          offset = chunk.nextOffset;
          if (chunk.eof) break;
          if (!data.length) throw new Error("MDBX2 附件读取没有前进。");
        }
      } finally {
        await this.nativeClient.releaseAttachmentRead(read.readHandle).catch(() => undefined);
      }
      if (!reference?.remoteId || offset !== bytes.length) throw new Error(`MDBX2 附件「${attachment.fileName}」读取不完整。`);
      return bytes;
    }
    throw new Error("当前来源密码源不支持附件读取。");
  }

  private async uploadTargetAttachment(
    vaultHandle: string,
    attachment: Mdbx2TransferAttachmentDescriptor,
    collectionId: string,
    objectId: string,
    operationId: string,
    digest: string,
    bytes: Uint8Array
  ): Promise<void> {
    const begin = await retry(() => this.nativeClient.beginAttachmentUpload(vaultHandle, {
      operationId,
      attachmentId: attachment.attachmentId,
      collectionId,
      objectId,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      mode: "create",
      sizeBytes: bytes.byteLength,
      sha256: digest
    }));
    let transferId = begin.transferId;
    let offset = begin.nextOffset;
    try {
      while (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + Math.min(begin.maxChunkBytes, MDBX2_MAX_BINARY_CHUNK_BYTES));
        const chunk = bytes.slice(offset, end);
        const result = await retry(() => this.nativeClient.sendAttachmentUploadChunk(transferId, offset, chunk));
        if (result.nextOffset < end || (!result.repeated && result.acceptedBytes !== chunk.length)) throw new Error("MDBX2 附件上传分块响应无效。");
        offset = result.nextOffset;
      }
      const finished = await retry(() => this.nativeClient.finishAttachmentUpload(transferId));
      if (
        finished.attachment.attachmentId !== attachment.attachmentId
          || finished.attachment.fileName !== attachment.fileName
          || finished.attachment.sizeBytes !== bytes.byteLength
      ) throw new Error(`目标附件「${attachment.fileName}」校验失败。`);
    } catch (error) {
      await this.nativeClient.abortAttachmentUpload(transferId).catch(() => undefined);
      throw error;
    }
  }
}

function vaultHandleOf(account: ProviderAccount): string {
  const value = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
  if (!value) throw new Error("MDBX2 附件密码源缺少本机工作副本句柄。");
  return value;
}

function parseBitwardenAttachments(payload: string): Mdbx2TransferAttachmentDescriptor[] {
  try {
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const attachments = raw.Attachments ?? raw.attachments;
    if (!Array.isArray(attachments)) return [];
    return attachments.flatMap((value, index) => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      const fileName = typeof (entry.FileName ?? entry.fileName) === "string" ? String(entry.FileName ?? entry.fileName) : `attachment-${index + 1}`;
      const size = Number(entry.Size ?? entry.size ?? 0);
      return [{ attachmentId: String(entry.Id ?? entry.id ?? index), fileName, sizeBytes: Number.isSafeInteger(size) && size >= 0 ? size : 0 }];
    });
  } catch {
    return [];
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("MDBX2 附件操作失败。");
}
