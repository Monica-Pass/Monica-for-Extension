import type { ProviderAccount, ProviderReference, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { decryptAndroidBackup, encryptAndroidBackup, isAndroidEncryptedBackup } from "./android-backup-crypto";
import { deleteAndroidBackupItem, readAndroidBackup, writeAndroidBackup, type AndroidBackupDocument } from "./android-backup-codec";
import { WebDavClient, type WebDavBackupFile, type WebDavCredentials } from "./webdav-client";

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
    const localScoped = context.localItems.filter((item) => hasProviderReference(item, account.id));
    const unrelated = context.localItems.filter((item) => !hasProviderReference(item, account.id));
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
        warnings: loaded.document.warnings
      };
    }

    let baselineFile = loaded.file;
    if (needsUpload) baselineFile = await this.uploadDocument(account, loaded.document, [...merged, ...localScoped.filter((item) => item.deletedAt)], context.signal, loaded.file);
    const synced = finalizeItems(merged, account.id, baselineFile);
    return {
      items: [...unrelated, ...synced],
      accountPatch: syncAccountPatch(account, context.now, baselineFile),
      conflicts,
      warnings: loaded.document.warnings
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

  async loadLatest(account: ProviderAccount, signal?: AbortSignal): Promise<{ file: WebDavBackupFile; document: AndroidBackupDocument } | null> {
    const client = this.client(account);
    const [file] = await client.listBackups(signal);
    if (!file) return null;
    const config = readConfig(account);
    const remoteBytes = await client.download(file, signal);
    const zipBytes = isAndroidEncryptedBackup(remoteBytes) ? await decryptAndroidBackup(remoteBytes, config.backupPassword || "") : remoteBytes;
    return { file, document: readAndroidBackup(zipBytes, account.id) };
  }

  private async uploadDocument(
    account: ProviderAccount,
    document: AndroidBackupDocument,
    items: VaultItem[],
    signal?: AbortSignal,
    expectedLatest?: WebDavBackupFile
  ): Promise<WebDavBackupFile> {
    const config = readConfig(account);
    const zipBytes = writeAndroidBackup(document, items, account.id);
    const encrypted = Boolean(config.backupPassword);
    const payload = encrypted ? await encryptAndroidBackup(zipBytes, config.backupPassword!) : zipBytes;
    const client = this.client(account);
    if (expectedLatest) {
      const [latest] = await client.listBackups(signal);
      if (!latest || latest.name !== expectedLatest.name || (latest.etag && expectedLatest.etag && latest.etag !== expectedLatest.etag)) {
        throw new Error("WebDAV 最新备份在同步期间发生变化，已停止写入以避免覆盖 Android 数据。");
      }
    }
    return client.upload(payload, encrypted, signal);
  }

  private client(account: ProviderAccount): WebDavClient {
    return new WebDavClient(readConfig(account), this.fetcher);
  }
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
