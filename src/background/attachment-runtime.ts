import { type ProviderAccount, type VaultItem } from "../core/model";
import { BITWARDEN_ATTACHMENT_MAX_BYTES, KEEPASS_ATTACHMENT_MAX_BYTES, PROVIDER_ATTACHMENT_CHUNK_BYTES, PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS, PROVIDER_ATTACHMENT_READ_CACHE_MAX_BYTES, PROVIDER_ATTACHMENT_READ_CACHE_TOTAL_MAX_BYTES, PROVIDER_ATTACHMENT_UPLOAD_TTL_MS, ProviderAttachmentError, type ProviderAttachmentMutationResult, type ProviderAttachmentReadBeginResult, type ProviderAttachmentReadChunk, type ProviderAttachmentUploadBeginResult, type ProviderAttachmentUploadChunkResult } from "../providers/attachments/attachment-contract";
import { paginateProviderAttachments } from "../providers/attachments/attachment-pagination";
import { ProviderAttachmentTransferCoordinator, type ProviderAttachmentTransferBackend } from "../providers/attachments/attachment-transfer";
import { ProviderAttachmentUploadStore } from "../providers/attachments/attachment-upload-store";
import { LocalAttachmentService } from '../providers/attachments/local-attachments';
import { isLocalTransferItem, LOCAL_ATTACHMENT_MAX_BYTES } from '../core/local-transfer';
import type { BitwardenSessionConfig } from "../providers/bitwarden/bitwarden-client";
import { BitwardenAttachmentDownloadService } from "../providers/bitwarden/bitwarden-attachments";
import { BitwardenAttachmentMutationService } from "../providers/bitwarden/bitwarden-attachment-mutations";
import type { BitwardenSymmetricKey } from "../providers/bitwarden/bitwarden-crypto";
import { Mdbx2BackendRouter } from '../providers/mdbx2/backend-router';
import { KeePassProvider, type KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import { KeePassRemoteSessionError } from "../providers/keepass/keepass-remote-session";
import { type KeePassDurableMutationKind, type KeePassDurableMutationResult } from "../providers/keepass/keepass-working-copy-store";
import { MonicaWebDavProvider } from "../providers/webdav/monica-webdav-provider";
import { finishWebDavAttachmentUpload } from "./webdav-attachment-upload";
import type { ExtensionRequest } from "../runtime/messages";
import { base64ToBytes, bytesToBase64 } from "../security/encoding";
import { SecureVaultService } from "../security/secure-vault-service";
import type { CommandHandlers, CommandExecutor } from './command-router';
import { commandHandler } from './command-router';
import { assertManagerPage } from './request-access';
import type { BitwardenAttachmentContext } from './bitwarden-attachment-context';

export function unsupportedAttachmentProvider(kind: ProviderAccount["kind"]): ProviderAttachmentError {
  return new ProviderAttachmentError("attachment-provider-unsupported", `${kind} 附件操作尚未接入此共享传输接口。`);
}

export interface AttachmentDependencies {
  service: SecureVaultService;
  localAttachments: LocalAttachmentService;
  mdbx2NativeClient: Mdbx2BackendRouter;
  keePassProvider: KeePassProvider;
  monicaWebDavProvider: MonicaWebDavProvider;
  bitwardenAttachmentDownloads: BitwardenAttachmentDownloadService;
  bitwardenAttachmentMutations: BitwardenAttachmentMutationService;
  ensureKeePassSession(account: ProviderAccount, requireUnlocked: true): Promise<KeePassSessionSummary>;
  loadBitwardenAttachmentContext(account: ProviderAccount, item: VaultItem): Promise<BitwardenAttachmentContext>;
  persistBitwardenSession(account: ProviderAccount, session: BitwardenSessionConfig): Promise<void>;
  acknowledgeBitwardenAttachmentMutation(account: ProviderAccount, item: VaultItem, session: BitwardenSessionConfig, rawCipher: Record<string, unknown>): Promise<void>;
  clearBitwardenOrganizationKeys(keys: Map<string, BitwardenSymmetricKey>): void;
  executeKeePassDurableMutation<T>(input: {
    account: ProviderAccount; operationId: string; kind: KeePassDurableMutationKind; intent: unknown;
    replay: (result: KeePassDurableMutationResult) => T | Promise<T>;
    mutate: () => { result: T; durableResult: KeePassDurableMutationResult } | Promise<{ result: T; durableResult: KeePassDurableMutationResult }>;
  }): Promise<T>;
  executeCommand: CommandExecutor;
}

export type AttachmentRequest = Extract<ExtensionRequest, { type: `PROVIDER_ATTACHMENT_${string}` }>;

/** Owns attachment handles, upload receipts, transfers and expiry. Provider
 * adapters retain encryption/format logic; all writes cross executeCommand. */
export function createAttachmentRuntime(dependencies: AttachmentDependencies) {
  const { service, mdbx2NativeClient, keePassProvider, monicaWebDavProvider,
    bitwardenAttachmentDownloads, bitwardenAttachmentMutations, ensureKeePassSession,
    loadBitwardenAttachmentContext, persistBitwardenSession,
    acknowledgeBitwardenAttachmentMutation, clearBitwardenOrganizationKeys,
    executeKeePassDurableMutation, executeCommand, localAttachments } = dependencies;

  const providerAttachmentUploads = new ProviderAttachmentUploadStore();

  const providerAttachmentTransfers = new ProviderAttachmentTransferCoordinator();

  /** Read routes carry decrypted bytes only for providers without offset
   * reads (monica-webdav); every removal path must zero them first. */
  const providerAttachmentReads = new Map<string, { providerId: string; itemId: string; attachmentId: string; expiresAt: number; cached?: { fileName: string; sizeBytes: number; bytes: Uint8Array } }>();

  const bitwardenAttachmentReadRoutes = new Map<string, { providerId: string; itemId: string; attachmentId: string; expiresAt: number }>();

  const PROVIDER_ATTACHMENT_MAX_BASE64_CHUNK_LENGTH = Math.ceil(PROVIDER_ATTACHMENT_CHUNK_BYTES / 3) * 4;

  function providerAttachmentTransferBackend(sender: chrome.runtime.MessageSender): ProviderAttachmentTransferBackend {
    return {
      beginRead: async (providerId, itemId, attachmentId) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId, itemId, attachmentId }, sender) as ProviderAttachmentReadBeginResult,
      readChunk: async (providerId, readHandle, offset, maxBytes) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId, readHandle, offset, maxBytes }, sender) as ProviderAttachmentReadChunk,
      releaseRead: async (providerId, readHandle) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId, readHandle }, sender) as boolean,
      beginUpload: async (providerId, itemId, input) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId, itemId, ...input }, sender) as ProviderAttachmentUploadBeginResult,
      uploadChunk: async (providerId, transferId, offset, bytes) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId, transferId, offset, dataBase64: bytesToBase64(bytes) }, sender) as ProviderAttachmentUploadChunkResult,
      finishUpload: async (providerId, itemId, transferId, operationId) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId, itemId, transferId, operationId }, sender) as ProviderAttachmentMutationResult,
      abortUpload: async (providerId, transferId) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT", providerId, transferId }, sender) as boolean,
      deleteAttachment: async (providerId, itemId, attachmentId, operationId) => await invokeAttachment({ type: "PROVIDER_ATTACHMENT_DELETE", providerId, itemId, attachmentId, operationId, confirmed: true }, sender) as ProviderAttachmentMutationResult
    };
  }

  async function requireAttachmentTarget(providerId: string, itemId: string): Promise<{ account: ProviderAccount; item: VaultItem }> {
    const [account, item] = await Promise.all([service.getProvider(providerId), service.getItem(itemId)]);
    if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
    if (account.kind === "keepass") await ensureKeePassSession(account, true);
    if (!item || !(account.kind === 'local' ? isLocalTransferItem(item, [account]) : item.providerRefs.some((reference) => reference.providerId === providerId))) {
      throw new ProviderAttachmentError("attachment-target-not-found", "附件项目不存在或不属于所选密码源。");
    }
    return { account, item };
  }

  function requireMdbx2AttachmentTarget(account: ProviderAccount, item: VaultItem): { vaultHandle: string; collectionId: string; objectId: string } {
    const vaultHandle = account.kind === "mdbx2" ? typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "" : "";
    const reference = item.providerRefs.find((candidate) => candidate.providerId === account.id);
    const collectionId = reference?.remoteFolderId || item.mdbxFolderId || "";
    const objectId = reference?.remoteId || "";
    if (!vaultHandle) throw new ProviderAttachmentError("attachment-vault-locked", "MDBX2 本机工作副本尚未解锁。");
    if (!collectionId || !objectId) throw new ProviderAttachmentError("attachment-target-not-synced", "该项目尚未写入 MDBX2，完成项目同步后才能管理附件。");
    return { vaultHandle, collectionId, objectId };
  }

  function providerAttachmentSummaryFromMdbx2(input: { attachmentId: string; fileName: string; sizeBytes: number; mediaType?: string }) {
    return {
      attachmentId: input.attachmentId,
      providerKind: "mdbx2" as const,
      fileName: input.fileName,
      sizeBytes: input.sizeBytes,
      protected: true,
      mediaType: input.mediaType
    };
  }

  function deleteProviderAttachmentRead(readHandle: string): boolean {
    const route = providerAttachmentReads.get(readHandle);
    if (!route) return false;
    if (route.cached) route.cached.bytes.fill(0);
    return providerAttachmentReads.delete(readHandle);
  }

  function providerAttachmentCachedReadBytes(): number {
    let total = 0;
    for (const route of providerAttachmentReads.values()) total += route.cached?.bytes.byteLength ?? 0;
    return total;
  }

  function pruneProviderAttachmentReads(): void {
    const now = Date.now();
    for (const [readHandle, route] of providerAttachmentReads) {
      if (route.expiresAt <= now) deleteProviderAttachmentRead(readHandle);
    }
    for (const [readHandle, route] of bitwardenAttachmentReadRoutes) {
      if (route.expiresAt <= now) {
        bitwardenAttachmentReadRoutes.delete(readHandle);
        bitwardenAttachmentDownloads.release(route.providerId, readHandle);
      }
    }
  }

  function durableKeePassAttachmentResult(account: ProviderAccount, item: VaultItem, result: ProviderAttachmentMutationResult): KeePassDurableMutationResult {
    if (!result.attachment) throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 附件操作缺少持久结果。");
    return {
      type: "attachment",
      changed: result.changed,
      entryUuid: keePassProvider.attachmentEntryUuid(account, item),
      fileName: result.attachment.fileName
    };
  }

  function replayKeePassAttachmentResult(account: ProviderAccount, item: VaultItem, result: KeePassDurableMutationResult): ProviderAttachmentMutationResult {
    if (result.type !== "attachment") throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久附件回执类型无效。");
    return keePassProvider.attachmentResultFromName(account, item, result.fileName, result.changed);
  }

  function clearBitwardenAttachmentSessions(providerId?: string): void {
    bitwardenAttachmentDownloads.clear();
    for (const [readHandle, route] of bitwardenAttachmentReadRoutes) {
      if (providerId === undefined || route.providerId === providerId) bitwardenAttachmentReadRoutes.delete(readHandle);
    }
  }

  const handlers: CommandHandlers<AttachmentRequest> = {
    "PROVIDER_ATTACHMENT_TRANSFER": async (request, sender) => {
      assertManagerPage(sender);
      return providerAttachmentTransfers.execute(request, providerAttachmentTransferBackend(sender));
    },
    "PROVIDER_ATTACHMENT_LIST": async (request, sender) => {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === 'local') return paginateProviderAttachments(await localAttachments.list(account, item), request);
      if (account.kind === "keepass") return paginateProviderAttachments(keePassProvider.listAttachments(account, item), request);
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const page = await mdbx2NativeClient.listAttachments(target.vaultHandle, target.collectionId, target.objectId, request);
        return { items: page.items.map(providerAttachmentSummaryFromMdbx2), nextCursor: page.nextCursor };
      }
      if (account.kind === "bitwarden") {
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const page = await bitwardenAttachmentDownloads.listAttachments(context, request);
          await persistBitwardenSession(account, context.session);
          return page;
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      if (account.kind === "monica-webdav") return monicaWebDavProvider.listAttachments(account, item);
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_RECOVERY_STATUS": async (request, sender) => {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
      if (account.kind !== "bitwarden") return { providerId: account.id, pending: [], completedCount: 0 };
      const records = await bitwardenAttachmentMutations.listRecoveryRecords(account.id);
      return {
        providerId: account.id,
        pending: records
          .filter((record) => record.stage !== "completed")
          .map((record) => ({ operationId: record.operationId, kind: record.kind, stage: record.stage, updatedAt: record.updatedAt })),
        completedCount: records.filter((record) => record.stage === "completed").length
      };
    },
    "PROVIDER_ATTACHMENT_READ_BEGIN": async (request, sender) => {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === 'local') return localAttachments.begin(account.id, item.id, request.attachmentId);
      if (account.kind === "keepass") {
        pruneProviderAttachmentReads();
        if (providerAttachmentReads.size >= PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) {
          throw new ProviderAttachmentError("attachment-read-limit", "同时进行的附件下载过多，请完成或取消现有下载。");
        }
        const attachment = keePassProvider.listAttachments(account, item).find((candidate) => candidate.attachmentId === request.attachmentId);
        if (!attachment) throw new ProviderAttachmentError("attachment-not-found", "附件不存在或已被删除。");
        const readHandle = crypto.randomUUID();
        providerAttachmentReads.set(readHandle, {
          providerId: account.id,
          itemId: item.id,
          attachmentId: attachment.attachmentId,
          expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS
        });
        return { ...attachment, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
      }
      if (account.kind === "monica-webdav") {
        pruneProviderAttachmentReads();
        if (providerAttachmentReads.size >= PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) throw new ProviderAttachmentError("attachment-read-limit", "同时进行的附件下载过多，请完成或取消现有下载。");
        const result = await monicaWebDavProvider.readAttachment(account, item, request.attachmentId);
        const readHandle = crypto.randomUUID();
        // Cache decrypted bytes only within the read-cache budget; reads above
        // it keep the legacy per-chunk download path in READ_CHUNK.
        const cacheBytes = result.bytes.byteLength <= PROVIDER_ATTACHMENT_READ_CACHE_MAX_BYTES
          && providerAttachmentCachedReadBytes() + result.bytes.byteLength <= PROVIDER_ATTACHMENT_READ_CACHE_TOTAL_MAX_BYTES
          ? { fileName: result.fileName, sizeBytes: result.sizeBytes, bytes: result.bytes }
          : undefined;
        providerAttachmentReads.set(readHandle, { providerId: account.id, itemId: item.id, attachmentId: request.attachmentId, expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS, cached: cacheBytes });
        if (!cacheBytes) result.bytes.fill(0);
        return { attachmentId: result.attachmentId, providerKind: result.providerKind, fileName: result.fileName, sizeBytes: result.sizeBytes, protected: result.protected, mediaType: result.mediaType, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
      }
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const result = await mdbx2NativeClient.beginAttachmentRead(target.vaultHandle, request.attachmentId);
        return { ...providerAttachmentSummaryFromMdbx2(result), readHandle: result.readHandle, maxChunkBytes: result.maxChunkBytes };
      }
      if (account.kind === "bitwarden") {
        pruneProviderAttachmentReads();
        if (bitwardenAttachmentReadRoutes.size >= PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) {
          throw new ProviderAttachmentError("attachment-read-limit", "同时进行的附件下载过多，请完成或取消现有下载。");
        }
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const result = await bitwardenAttachmentDownloads.beginDownload({ ...context, attachmentId: request.attachmentId });
          await persistBitwardenSession(account, result.session);
          bitwardenAttachmentReadRoutes.set(result.readHandle, {
            providerId: account.id,
            itemId: item.id,
            attachmentId: result.attachmentId,
            expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS
          });
          const { session: _session, ...publicResult } = result;
          return publicResult;
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_READ_CHUNK": async (request, sender) => {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
      if (account.kind === 'local') return localAttachments.chunk(account.id, request.readHandle, request.offset, request.maxBytes);
      if (account.kind === "keepass") {
        pruneProviderAttachmentReads();
        const route = providerAttachmentReads.get(request.readHandle);
        if (!route || route.providerId !== account.id) throw new ProviderAttachmentError("attachment-read-not-found", "附件下载已过期，请重新开始。");
        const { item } = await requireAttachmentTarget(route.providerId, route.itemId);
        const result = keePassProvider.readAttachment(account, item, route.attachmentId, request.offset, request.maxBytes);
        route.expiresAt = Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
        try {
          return {
            readHandle: request.readHandle,
            attachmentId: result.attachment.attachmentId,
            fileName: result.attachment.fileName,
            sizeBytes: result.attachment.sizeBytes,
            offset: result.offset,
            nextOffset: result.nextOffset,
            dataBase64: bytesToBase64(result.bytes),
            eof: result.eof
          };
        } finally {
          result.bytes.fill(0);
        }
      }
      if (account.kind === "mdbx2") {
        const result = await mdbx2NativeClient.readAttachmentChunk(request.readHandle, request.offset, request.maxBytes);
        return { ...result };
      }
      if (account.kind === "monica-webdav") {
        pruneProviderAttachmentReads();
        const route = providerAttachmentReads.get(request.readHandle);
        if (!route || route.providerId !== account.id) throw new ProviderAttachmentError("attachment-read-not-found", "附件下载已过期，请重新开始。");
        const { item } = await requireAttachmentTarget(route.providerId, route.itemId);
        route.expiresAt = Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
        const offset = request.offset;
        const maxBytes = Math.min(request.maxBytes ?? PROVIDER_ATTACHMENT_CHUNK_BYTES, PROVIDER_ATTACHMENT_CHUNK_BYTES);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new ProviderAttachmentError("attachment-read-offset-invalid", "附件读取位置无效。");
        // Uncached routes (attachment above the read-cache budget) re-download
        // the whole attachment per chunk and zero it right after slicing.
        const source = route.cached ?? await monicaWebDavProvider.readAttachment(account, item, route.attachmentId);
        let bytes: Uint8Array | undefined;
        try {
          if (offset > source.bytes.byteLength) throw new ProviderAttachmentError("attachment-read-offset-invalid", "附件读取位置无效。");
          bytes = source.bytes.slice(offset, Math.min(offset + maxBytes, source.bytes.byteLength));
          return { readHandle: request.readHandle, attachmentId: route.attachmentId, fileName: source.fileName, sizeBytes: source.sizeBytes, offset, nextOffset: offset + bytes.byteLength, dataBase64: bytesToBase64(bytes), eof: offset + bytes.byteLength === source.sizeBytes };
        } finally {
          bytes?.fill(0);
          if (!route.cached) source.bytes.fill(0);
        }
      }
      if (account.kind === "bitwarden") {
        pruneProviderAttachmentReads();
        const route = bitwardenAttachmentReadRoutes.get(request.readHandle);
        if (!route || route.providerId !== account.id) throw new ProviderAttachmentError("attachment-read-not-found", "Bitwarden 附件下载已过期，请重新开始。");
        const maximum = request.maxBytes ?? PROVIDER_ATTACHMENT_CHUNK_BYTES;
        const result = bitwardenAttachmentDownloads.readChunk(account.id, request.readHandle, request.offset, maximum);
        route.expiresAt = Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS;
        try {
          return {
            readHandle: result.readHandle,
            attachmentId: result.attachmentId,
            fileName: result.fileName,
            sizeBytes: result.sizeBytes,
            offset: result.offset,
            nextOffset: result.nextOffset,
            dataBase64: bytesToBase64(result.bytes),
            eof: result.eof
          };
        } finally {
          result.bytes.fill(0);
        }
      }
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_READ_RELEASE": async (request, sender) => {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (!account) return deleteProviderAttachmentRead(request.readHandle);
      if (account.kind === 'local') return localAttachments.release(account.id, request.readHandle);
      if (account.kind === "keepass") return deleteProviderAttachmentRead(request.readHandle);
      if (account.kind === "mdbx2") return mdbx2NativeClient.releaseAttachmentRead(request.readHandle);
      if (account.kind === "bitwarden") {
        bitwardenAttachmentReadRoutes.delete(request.readHandle);
        return bitwardenAttachmentDownloads.release(account.id, request.readHandle);
      }
      if (account.kind === "monica-webdav") return deleteProviderAttachmentRead(request.readHandle);
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_UPLOAD_BEGIN": async (request, sender) => {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === 'local') {
        const current = await service.readLocalAttachmentSnapshot(account.id, item.id);
        if (!current.sessionId) throw new Error('密码库已锁定。');
        return providerAttachmentUploads.begin({ providerId: account.id, itemId: item.id, providerKind: 'local',
          fileName: request.fileName, mediaType: request.mediaType, sizeBytes: request.sizeBytes, sha256: request.sha256,
          replaceExisting: request.replaceExisting === true, operationId: request.operationId || crypto.randomUUID(),
          attachmentId: request.attachmentId || crypto.randomUUID(), expectedRevision: request.expectedRevision, sessionId: current.sessionId }, LOCAL_ATTACHMENT_MAX_BYTES);
      }
      if (account.kind === "keepass") {
        keePassProvider.assertAttachmentTarget(account, item);
        if (request.replaceExisting) {
          const attachment = request.attachmentId
            ? keePassProvider.listAttachments(account, item).find((candidate) => candidate.attachmentId === request.attachmentId)
            : undefined;
          if (!attachment) throw new ProviderAttachmentError("attachment-not-found", "要替换的 KeePass 附件不存在，请刷新附件列表。");
          if (attachment.fileName !== request.fileName) throw new ProviderAttachmentError("attachment-target-mismatch", "KeePass 附件替换必须保留原文件名。");
        }
        return providerAttachmentUploads.begin({
          providerId: account.id,
          itemId: item.id,
          providerKind: "keepass",
          fileName: request.fileName,
          mediaType: request.mediaType,
          sizeBytes: request.sizeBytes,
          sha256: request.sha256,
          replaceExisting: request.replaceExisting === true,
          operationId: request.operationId,
          attachmentId: request.attachmentId
        }, KEEPASS_ATTACHMENT_MAX_BYTES);
      }
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const operationId = request.operationId || crypto.randomUUID();
        const attachmentId = request.replaceExisting
          ? request.attachmentId
          : request.attachmentId || operationId;
        if (!attachmentId) throw new ProviderAttachmentError("attachment-id-required", "替换 MDBX2 附件需要指定现有附件。");
        const result = await mdbx2NativeClient.beginAttachmentUpload(target.vaultHandle, {
          operationId,
          attachmentId,
          collectionId: target.collectionId,
          objectId: target.objectId,
          fileName: request.fileName,
          mediaType: request.mediaType,
          mode: request.replaceExisting ? "replace" : "create",
          sizeBytes: request.sizeBytes,
          sha256: request.sha256
        });
        return { ...result, expiresAt: Date.now() + PROVIDER_ATTACHMENT_UPLOAD_TTL_MS };
      }
      if (account.kind === "bitwarden") {
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          if (request.replaceExisting) {
            if (!request.attachmentId) throw new ProviderAttachmentError("attachment-id-required", "替换 Bitwarden 附件需要指定现有附件。");
            const page = await bitwardenAttachmentDownloads.listAttachments(context, { pageSize: 50 });
            const attachment = page.items.find((candidate) => candidate.attachmentId === request.attachmentId);
            if (!attachment) throw new ProviderAttachmentError("attachment-not-found", "要替换的 Bitwarden 附件不存在，请刷新附件列表。");
            if (attachment.fileName !== request.fileName) throw new ProviderAttachmentError("attachment-target-mismatch", "Bitwarden 附件替换必须保留原文件名。");
          }
          const operationId = request.operationId || crypto.randomUUID();
          return providerAttachmentUploads.begin({
            providerId: account.id,
            itemId: item.id,
            providerKind: "bitwarden",
            fileName: request.fileName,
            mediaType: request.mediaType,
            sizeBytes: request.sizeBytes,
            sha256: request.sha256,
            replaceExisting: request.replaceExisting === true,
            operationId,
            attachmentId: request.replaceExisting ? request.attachmentId : undefined
          }, BITWARDEN_ATTACHMENT_MAX_BYTES);
        } finally {
          await persistBitwardenSession(account, context.session);
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      if (account.kind === "monica-webdav") {
        const config = account.config as { backupPassword?: unknown };
        if (typeof config.backupPassword !== "string" || !config.backupPassword) throw new ProviderAttachmentError("attachment-encryption-required", "写入 Android portable 附件前必须设置 WebDAV 备份密码。");
        return providerAttachmentUploads.begin({
          providerId: account.id,
          itemId: item.id,
          providerKind: "monica-webdav",
          fileName: request.fileName,
          mediaType: request.mediaType,
          sizeBytes: request.sizeBytes,
          sha256: request.sha256,
          replaceExisting: request.replaceExisting === true,
          operationId: request.operationId,
          attachmentId: request.replaceExisting ? request.attachmentId : undefined
        }, 256 * 1024 * 1024);
      }
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_UPLOAD_CHUNK": async (request, sender) => {
      assertManagerPage(sender);
      if (typeof request.dataBase64 !== "string" || request.dataBase64.length > PROVIDER_ATTACHMENT_MAX_BASE64_CHUNK_LENGTH) {
        throw new ProviderAttachmentError("attachment-upload-chunk-invalid", "附件上传分块编码超过安全上限。");
      }
      const account = await service.getProvider(request.providerId);
      if (!account) throw new ProviderAttachmentError("attachment-provider-not-found", "附件密码源不存在。");
      const bytes = base64ToBytes(request.dataBase64);
      try {
        if (account.kind === 'local') {
          const intent = providerAttachmentUploads.intent(request.transferId);
          if (!intent || intent.providerId !== account.id || intent.providerKind !== 'local') throw new Error('附件上传会话不匹配。');
          return providerAttachmentUploads.write(request.transferId, request.offset, bytes);
        }
        if (account.kind === "keepass") {
          const intent = providerAttachmentUploads.intent(request.transferId);
          if (intent && (intent.providerId !== account.id || intent.providerKind !== "keepass")) {
            throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
          }
          return providerAttachmentUploads.write(request.transferId, request.offset, bytes);
        }
        if (account.kind === "bitwarden") {
          const intent = providerAttachmentUploads.intent(request.transferId);
          if (intent && (intent.providerId !== account.id || intent.providerKind !== "bitwarden")) {
            throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
          }
          return providerAttachmentUploads.write(request.transferId, request.offset, bytes);
        }
        if (account.kind === "mdbx2") return await mdbx2NativeClient.sendAttachmentUploadChunk(request.transferId, request.offset, bytes);
        if (account.kind === "monica-webdav") {
          const intent = providerAttachmentUploads.intent(request.transferId);
          if (intent && (intent.providerId !== account.id || intent.providerKind !== "monica-webdav")) throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
          return providerAttachmentUploads.write(request.transferId, request.offset, bytes);
        }
        throw unsupportedAttachmentProvider(account.kind);
      } finally {
        bytes.fill(0);
      }
    },
    "PROVIDER_ATTACHMENT_UPLOAD_FINISH": async (request, sender) => {
      assertManagerPage(sender);
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === 'local') {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (!intent || intent.providerId !== account.id || intent.itemId !== item.id || intent.providerKind !== 'local' || !intent.sessionId) throw new Error('附件上传目标不匹配。');
        const old = providerAttachmentUploads.committedResult(request.transferId); if (old) return old;
        const upload = await providerAttachmentUploads.complete(request.transferId);
        const result = await service.mutateLocalAttachment({ operationId: intent.operationId!, providerId: account.id, itemId: item.id,
          attachmentId: intent.attachmentId!, mode: intent.replaceExisting ? 'replace' : 'create', expectedRevision: intent.expectedRevision,
          attachment: { itemId: item.id, attachmentId: intent.attachmentId!, fileName: intent.fileName, mediaType: intent.mediaType,
            sizeBytes: upload.bytes.length, sha256: upload.sha256, dataBase64: bytesToBase64(upload.bytes) } }, intent.sessionId);
        providerAttachmentUploads.markCommitted(request.transferId, result); return result;
      }
      if (account.kind === "keepass") {
        const durableOperationId = request.operationId || request.transferId;
        const durableIntent = request.operationId
          ? { itemId: request.itemId, operationId: request.operationId }
          : { itemId: request.itemId, transferId: request.transferId };
        return executeKeePassDurableMutation({
          account,
          operationId: durableOperationId,
          kind: "attachment-upload",
          intent: durableIntent,
          replay: (result) => {
            const replayed = replayKeePassAttachmentResult(account, item, result);
            if (providerAttachmentUploads.has(request.transferId)) providerAttachmentUploads.markCommitted(request.transferId, replayed);
            return replayed;
          },
          mutate: async () => {
            const intent = providerAttachmentUploads.intent(request.transferId);
            if (intent && (intent.providerId !== account.id || intent.itemId !== item.id || intent.providerKind !== "keepass")) {
              throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传目标与当前项目不一致。");
            }
            const committed = providerAttachmentUploads.committedResult(request.transferId);
            if (committed) return { result: committed, durableResult: durableKeePassAttachmentResult(account, item, committed) };
            const upload = await providerAttachmentUploads.complete(request.transferId);
            if (upload.intent.providerId !== account.id || upload.intent.itemId !== item.id || upload.intent.providerKind !== "keepass") {
              throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传目标与当前项目不一致。");
            }
            const attachment = await keePassProvider.addAttachment(
              account,
              item,
              upload.intent.fileName,
              upload.bytes,
              upload.intent.replaceExisting
            );
            const result = { changed: true, attachment };
            providerAttachmentUploads.markCommitted(request.transferId, result);
            return { result, durableResult: durableKeePassAttachmentResult(account, item, result) };
          }
        });
      }
      if (account.kind === "mdbx2") {
        requireMdbx2AttachmentTarget(account, item);
        const result = await mdbx2NativeClient.finishAttachmentUpload(request.transferId);
        return { changed: result.changed, attachment: providerAttachmentSummaryFromMdbx2(result.attachment) };
      }
      if (account.kind === "bitwarden") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (!intent || intent.providerId !== account.id || intent.itemId !== item.id || intent.providerKind !== "bitwarden") {
          throw new ProviderAttachmentError("attachment-upload-target-mismatch", "Bitwarden 附件上传目标与当前项目不一致。");
        }
        const committed = providerAttachmentUploads.committedResult(request.transferId);
        if (committed) return committed;
        const upload = await providerAttachmentUploads.complete(request.transferId);
        const operationId = upload.intent.operationId || request.operationId;
        if (!operationId) throw new ProviderAttachmentError("attachment-operation-invalid", "Bitwarden 附件上传缺少可恢复的操作标识。");
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const result = await bitwardenAttachmentMutations.upload({
            ...context,
            operationId,
            fileName: upload.intent.fileName,
            bytes: upload.bytes,
            sha256: upload.sha256,
            replaceAttachmentId: upload.intent.replaceExisting ? upload.intent.attachmentId : undefined
          });
          await acknowledgeBitwardenAttachmentMutation(account, item, result.session, result.rawCipher);
          const publicResult: ProviderAttachmentMutationResult = {
            changed: result.changed,
            attachment: result.attachment
          };
          providerAttachmentUploads.markCommitted(request.transferId, publicResult);
          return publicResult;
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      if (account.kind === "monica-webdav") {
        return finishWebDavAttachmentUpload(providerAttachmentUploads, monicaWebDavProvider, account, item, request);
      }
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_UPLOAD_ABORT": async (request, sender) => {
      assertManagerPage(sender);
      const account = await service.getProvider(request.providerId);
      if (account?.kind === 'local') {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (intent && (intent.providerId !== account.id || intent.providerKind !== 'local')) throw new Error('附件上传会话不匹配。');
        return providerAttachmentUploads.abort(request.transferId);
      }
      if (!account) return providerAttachmentUploads.abort(request.transferId);
      if (account.kind === "keepass") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (intent && (intent.providerId !== account.id || intent.providerKind !== "keepass")) {
          throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
        }
        return providerAttachmentUploads.abort(request.transferId);
      }
      if (account.kind === "mdbx2") return mdbx2NativeClient.abortAttachmentUpload(request.transferId);
      if (account.kind === "bitwarden") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (intent && (intent.providerId !== account.id || intent.providerKind !== "bitwarden")) {
          throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
        }
        return providerAttachmentUploads.abort(request.transferId);
      }
      if (account.kind === "monica-webdav") {
        const intent = providerAttachmentUploads.intent(request.transferId);
        if (intent && (intent.providerId !== account.id || intent.providerKind !== "monica-webdav")) throw new ProviderAttachmentError("attachment-upload-target-mismatch", "附件上传会话与当前密码源不一致。");
        return providerAttachmentUploads.abort(request.transferId);
      }
      throw unsupportedAttachmentProvider(account.kind);
    },
    "PROVIDER_ATTACHMENT_DELETE": async (request, sender) => {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new ProviderAttachmentError("attachment-delete-confirmation-required", "删除附件需要明确确认。");
      const { account, item } = await requireAttachmentTarget(request.providerId, request.itemId);
      if (account.kind === 'local') {
        const current = await service.readLocalAttachmentSnapshot(account.id, item.id);
        if (!current.sessionId) throw new Error('密码库已锁定。');
        return service.mutateLocalAttachment({ operationId: request.operationId, providerId: account.id, itemId: item.id,
          attachmentId: request.attachmentId, mode: 'delete', expectedRevision: request.expectedRevision }, current.sessionId);
      }
      if (account.kind === "keepass") {
        return executeKeePassDurableMutation({
          account,
          operationId: request.operationId,
          kind: "attachment-delete",
          intent: { itemId: request.itemId, attachmentId: request.attachmentId },
          replay: (result) => {
            if (result.type !== "attachment-delete") throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久附件删除回执类型无效。");
            return { changed: result.changed };
          },
          mutate: () => {
            const result = { changed: keePassProvider.deleteAttachment(account, item, request.attachmentId) };
            return { result, durableResult: { type: "attachment-delete", changed: result.changed } };
          }
        });
      }
      if (account.kind === "mdbx2") {
        const target = requireMdbx2AttachmentTarget(account, item);
        const result = await mdbx2NativeClient.deleteAttachment(target.vaultHandle, request.operationId, request.attachmentId);
        return { changed: result.changed, attachment: providerAttachmentSummaryFromMdbx2(result.attachment) };
      }
      if (account.kind === "bitwarden") {
        const context = await loadBitwardenAttachmentContext(account, item);
        try {
          const result = await bitwardenAttachmentMutations.delete({
            ...context,
            operationId: request.operationId,
            attachmentId: request.attachmentId
          });
          await acknowledgeBitwardenAttachmentMutation(account, item, result.session, result.rawCipher);
          return { changed: result.changed };
        } finally {
          clearBitwardenOrganizationKeys(context.organizationKeys);
        }
      }
      if (account.kind === "monica-webdav") return { changed: await monicaWebDavProvider.deleteAttachment(account, item, request.attachmentId) };
      throw unsupportedAttachmentProvider(account.kind);
    }
  };

  function invokeAttachment(request: AttachmentRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
    const handler = commandHandler(handlers, request);
    if (!handler) throw new Error('未知附件操作。');
    return executeCommand(request, sender, handler);
  }
  return {
    handlers,
    clear: (providerId?: string) => {
      providerAttachmentUploads.clear(providerId);
      if (providerId === undefined) localAttachments.clear();
      for (const [handle, route] of providerAttachmentReads) {
        if (providerId === undefined || route.providerId === providerId) deleteProviderAttachmentRead(handle);
      }
      clearBitwardenAttachmentSessions(providerId);
    }
  };
}
