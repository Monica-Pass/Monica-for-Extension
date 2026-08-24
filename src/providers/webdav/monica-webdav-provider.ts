import type { ProviderAccount, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { decryptAndroidBackup, encryptAndroidBackup, isAndroidEncryptedBackup } from "./android-backup-crypto";
import { deleteAndroidBackupItem, deleteAndroidPortableAttachment, listAndroidPortableAttachments, readAndroidBackup, readAndroidPortableAttachment, upsertAndroidPortableAttachment, writeAndroidBackup, type AndroidBackupDocument } from "./android-backup-codec";
import type { ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentSummary } from "../attachments/attachment-contract";
import { WebDavClient, type WebDavBackupFile, type WebDavCredentials } from "./webdav-client";
import { createSourceRecord } from "../../core/source-records";

export interface MonicaWebDavConfig extends WebDavCredentials, Record<string, unknown> {
  backupPassword?: string;
  lastFileName?: string;
  lastEtag?: string;
}

export class MonicaWebDavProvider implements ProviderAdapter {
  readonly kind = "monica-webdav" as const;

  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async testConnection(account: ProviderAccount, signal?: AbortSignal): Promise<void> {
    const client = this.client(account);
    await client.testConnection(signal);
    await client.listBackups(signal);
  }

  async sync(account: ProviderAccount, context: ProviderSyncContext): Promise<ProviderSyncResult> {
    const loaded = await this.loadLatest(account, context.signal);
    // Android serialization assigns missing path references as it writes. Never
    // let that codec-side normalization leak back into the caller's baseline.
    const localItems = structuredClone(context.localItems);
    const localScoped = localItems.filter((item) => hasProviderReference(item, account.id));
    const unrelated = localItems.filter((item) => !hasProviderReference(item, account.id));
    if (!loaded) {
      if (!localScoped.some((item) => !item.deletedAt)) {
        return {
          items: unrelated,
          accountPatch: { lastSyncAt: context.now, lastError: undefined },
          conflicts: [],
          warnings: ["WebDAV 中尚无 Monica Android 备份。"]
        };
      }
      const document = emptyDocument();
      const uploaded = await this.uploadDocument(account, document, localScoped, context.signal);
      return {
        items: [...unrelated, ...finalizeItems(localScoped, account.id, uploaded)],
        accountPatch: syncAccountPatch(account, context.now, uploaded),
        conflicts: [],
        warnings: []
      };
    }

    const sourceRecords = await androidSourceRecords(loaded.document, account.id);

    const config = readConfig(account);
    const hasBaseline = Boolean(config.lastFileName);
    const localByRemoteId = new Map(localScoped.map((item) => [remoteIdOf(item, account.id), item]));
    const remoteByRemoteId = new Map(loaded.document.items.map((item) => [remoteIdOf(item, account.id), item]));
    const allRemoteIds = new Set([...localByRemoteId.keys(), ...remoteByRemoteId.keys()]);
    const merged: VaultItem[] = [];
    const conflicts: ProviderSyncResult["conflicts"] = [];
    let needsUpload = false;

    for (const remoteId of allRemoteIds) {
      const local = localByRemoteId.get(remoteId);
      const remote = remoteByRemoteId.get(remoteId);
      if (!local && remote) {
        merged.push(remote);
        continue;
      }
      if (!local) continue;

      const reference = providerReference(local, account.id);
      const baselineRevision = reference?.revision;
      if (!remote) {
        if (!hasBaseline || !baselineRevision) {
          if (!local.deletedAt) {
            merged.push(local);
            needsUpload = true;
          }
        } else if (local.updatedAt !== baselineRevision || local.deletedAt) {
          conflicts.push({ itemId: local.id, reason: "此项目在 WebDAV 中已删除，但浏览器中也有未同步修改。", local });
          merged.push(local);
        }
        continue;
      }

      if (!hasBaseline || !baselineRevision) {
        if (local.deletedAt || Date.parse(local.updatedAt) > Date.parse(remote.updatedAt)) {
          if (!local.deletedAt) merged.push(local);
          needsUpload = true;
        } else {
          merged.push(remote);
        }
        continue;
      }

      const localChanged = local.updatedAt !== baselineRevision || Boolean(local.deletedAt);
      const remoteChanged = remote.updatedAt !== baselineRevision;
      if (localChanged && remoteChanged && !sameVaultPayload(local, remote)) {
        conflicts.push({ itemId: local.id, reason: "浏览器和 Monica Android 在上次同步后都修改了此项目。", local, remote });
        merged.push(local);
      } else if (localChanged) {
        if (!local.deletedAt) merged.push(local);
        needsUpload = true;
      } else {
        merged.push(remote);
      }
    }

    if (conflicts.length) {
      return {
        items: [...unrelated, ...merged],
        accountPatch: { lastError: `发现 ${conflicts.length} 个 WebDAV 同步冲突。` },
        conflicts,
        warnings: loaded.document.warnings,
        sourceRecords
      };
    }

    let baselineFile = loaded.file;
    if (needsUpload) baselineFile = await this.uploadDocument(account, loaded.document, [...merged, ...localScoped.filter((item) => item.deletedAt)], context.signal, loaded.file);
    const synced = finalizeItems(merged, account.id, baselineFile);
    return {
      items: [...unrelated, ...synced],
      accountPatch: syncAccountPatch(account, context.now, baselineFile),
      conflicts,
      warnings: loaded.document.warnings,
      sourceRecords
    };
  }

  async create(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem> {
    const loaded = await this.loadLatest(account, signal);
    const document = loaded?.document || emptyDocument();
    const uploaded = await this.uploadDocument(account, document, [...document.items, item], signal, loaded?.file);
    return finalizeItem(item, account.id, uploaded);
  }

  async update(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem> {
    const loaded = await this.loadLatest(account, signal);
    const document = loaded?.document || emptyDocument();
    const items = document.items.some((candidate) => candidate.id === item.id)
      ? document.items.map((candidate) => (candidate.id === item.id ? item : candidate))
      : [...document.items, item];
    const uploaded = await this.uploadDocument(account, document, items, signal, loaded?.file);
    return finalizeItem(item, account.id, uploaded);
  }

  async remove(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<void> {
    const loaded = await this.loadLatest(account, signal);
    if (!loaded) return;
    deleteAndroidBackupItem(loaded.document, item.id);
    await this.uploadDocument(account, loaded.document, loaded.document.items, signal, loaded.file);
  }

  async listAttachments(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<ProviderAttachmentPage> {
    const loaded = await this.loadLatest(account, signal);
    if (!loaded) return { items: [] };
    const items = listAndroidPortableAttachments(loaded.document, item).map((attachment) => portableSummary(attachment));
    return { items };
  }

  async readAttachment(account: ProviderAccount, item: VaultItem, attachmentId: string, signal?: AbortSignal): Promise<ProviderAttachmentReadBeginResult & { bytes: Uint8Array }> {
    const loaded = await this.loadLatest(account, signal);
    if (!loaded) throw new Error("WebDAV 中尚无 Monica Android 备份。");
    const attachment = listAndroidPortableAttachments(loaded.document, item).find((candidate) => candidate.attachmentId === attachmentId);
    if (!attachment) throw new Error("Android portable 附件不存在或不属于当前项目。");
    const bytes = await readAndroidPortableAttachment(loaded.document, attachment);
    return { ...portableSummary(attachment), readHandle: "", maxChunkBytes: 256 * 1024, bytes };
  }

  async addAttachment(account: ProviderAccount, item: VaultItem, input: { fileName: string; mediaType?: string; sizeBytes: number; sha256Hex: string; attachmentId?: string }, bytes: Uint8Array, signal?: AbortSignal): Promise<ProviderAttachmentSummary> {
    const config = readConfig(account);
    if (!config.backupPassword) throw new Error("写入 Android portable 附件前必须设置 WebDAV 备份密码。");
    const loaded = await this.loadLatest(account, signal);
    if (!loaded) throw new Error("WebDAV 中尚无 Monica Android 备份，请先完成一次同步。");
    const entry = upsertAndroidPortableAttachment(loaded.document, item, input, bytes);
    await this.uploadDocument(account, loaded.document, loaded.document.items, signal, loaded.file);
    return portableSummary(entry);
  }

  async deleteAttachment(account: ProviderAccount, item: VaultItem, attachmentId: string, signal?: AbortSignal): Promise<boolean> {
    const config = readConfig(account);
    if (!config.backupPassword) throw new Error("删除 Android portable 附件前必须设置 WebDAV 备份密码。");
    const loaded = await this.loadLatest(account, signal);
    if (!loaded) return false;
    const changed = deleteAndroidPortableAttachment(loaded.document, item, attachmentId);
    if (!changed) return false;
    await this.uploadDocument(account, loaded.document, loaded.document.items, signal, loaded.file);
    return true;
  }

  async loadLatest(account: ProviderAccount, signal?: AbortSignal): Promise<{ file: WebDavBackupFile; document: AndroidBackupDocument } | null> {
    const client = this.client(account);
    const [file] = await client.listBackups(signal);
    if (!file) return null;
    const config = readConfig(account);
    const remoteBytes = await client.download(file, signal);
    const encrypted = isAndroidEncryptedBackup(remoteBytes);
    const zipBytes = encrypted ? await decryptAndroidBackup(remoteBytes, config.backupPassword || "") : remoteBytes;
    return { file, document: readAndroidBackup(zipBytes, account.id, { allowPortablePasskeys: encrypted, allowPortableAttachments: encrypted }) };
  }

  private async uploadDocument(
    account: ProviderAccount,
    document: AndroidBackupDocument,
    items: VaultItem[],
    signal?: AbortSignal,
    expectedLatest?: WebDavBackupFile
  ): Promise<WebDavBackupFile> {
    const config = readConfig(account);
    const encrypted = Boolean(config.backupPassword);
    const zipBytes = writeAndroidBackup(document, items, account.id, { allowPortablePasskeys: encrypted });
    const payload = encrypted ? await encryptAndroidBackup(zipBytes, config.backupPassword!) : zipBytes;
    const client = this.client(account);
    if (expectedLatest) {
      const [latest] = await client.listBackups(signal);
      const etagChanged = Boolean(latest) && (Boolean(latest.etag) !== Boolean(expectedLatest.etag) || (latest.etag && latest.etag !== expectedLatest.etag));
      if (!latest || latest.name !== expectedLatest.name || etagChanged) {
        throw new Error("WebDAV 最新备份在同步期间发生变化，已停止写入以避免覆盖 Android 数据。");
      }
    }
    return client.upload(payload, encrypted, signal);
  }

  private client(account: ProviderAccount): WebDavClient {
    return new WebDavClient(readConfig(account), this.fetcher);
  }
}

function portableSummary(attachment: { attachmentId: string; fileName: string; sizeBytes: number; mimeType?: string }): ProviderAttachmentSummary {
  return { attachmentId: attachment.attachmentId, providerKind: "monica-webdav", fileName: attachment.fileName, sizeBytes: attachment.sizeBytes, protected: true, mediaType: attachment.mimeType };
}

function readConfig(account: ProviderAccount): MonicaWebDavConfig {
  const config = account.config as Partial<MonicaWebDavConfig>;
  if (!config.baseUrl || typeof config.baseUrl !== "string") throw new Error("WebDAV 地址未配置。");
  return {
    baseUrl: config.baseUrl,
    username: typeof config.username === "string" ? config.username : "",
    password: typeof config.password === "string" ? config.password : "",
    backupPassword: typeof config.backupPassword === "string" ? config.backupPassword : undefined,
    lastFileName: typeof config.lastFileName === "string" ? config.lastFileName : undefined,
    lastEtag: typeof config.lastEtag === "string" ? config.lastEtag : undefined
  };
}

function emptyDocument(): AndroidBackupDocument {
  return { entries: {}, items: [], records: new Map(), warnings: [] };
}

async function androidSourceRecords(document: AndroidBackupDocument, providerId: string): Promise<ProviderSourceRecord[]> {
  return Promise.all([...document.records.values()].map((record) => createSourceRecord({
    providerId,
    itemId: record.itemId,
    remoteId: record.path,
    revision: record.item.updatedAt,
    format: "android-entry",
    encoding: "base64",
    payload: document.entries[record.path]
  })));
}

function providerReference(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function hasProviderReference(item: VaultItem, providerId: string): boolean {
  return Boolean(providerReference(item, providerId));
}

function remoteIdOf(item: VaultItem, providerId: string): string {
  return providerReference(item, providerId)?.remoteId || item.id;
}

function finalizeItems(items: VaultItem[], providerId: string, file: WebDavBackupFile): VaultItem[] {
  return items.filter((item) => !item.deletedAt).map((item) => finalizeItem(item, providerId, file));
}

function finalizeItem(item: VaultItem, providerId: string, file: WebDavBackupFile): VaultItem {
  const existing = providerReference(item, providerId);
  const reference: ProviderReference = {
    ...existing,
    providerId,
    remoteId: existing?.remoteId || item.id,
    revision: item.updatedAt,
    etag: file.etag
  };
  return {
    ...item,
    providerRefs: [...item.providerRefs.filter((candidate) => candidate.providerId !== providerId), reference]
  } as VaultItem;
}

function syncAccountPatch(account: ProviderAccount, now: string, file: WebDavBackupFile): Partial<ProviderAccount> {
  return {
    lastSyncAt: now,
    lastError: undefined,
    config: { ...account.config, lastFileName: file.name, lastEtag: file.etag }
  };
}

function sameVaultPayload(left: VaultItem, right: VaultItem): boolean {
  return JSON.stringify(stripSyncMetadata(left)) === JSON.stringify(stripSyncMetadata(right));
}

function stripSyncMetadata(item: VaultItem): Record<string, unknown> {
  const { providerRefs: _providerRefs, updatedAt: _updatedAt, deletedAt: _deletedAt, ...payload } = item;
  return payload;
}
