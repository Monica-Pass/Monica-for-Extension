import type { ProviderAccount, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { createSourceRecord } from "../../core/source-records";
import { decodeMdbx2Object, encodeMdbx2Object, mdbx2LogicalObjectId } from "./mdbx2-item-codec";
import type {
  Mdbx2CollectionSummary,
  Mdbx2CollectionSummaryPage,
  Mdbx2ObjectDeleteResult,
  Mdbx2ObjectRecord,
  Mdbx2ObjectSummary,
  Mdbx2ObjectSummaryPage,
  Mdbx2ObjectUpsertInput,
  Mdbx2ObjectWriteResult,
  Mdbx2VaultRuntimeStatus
} from "./native-contract";

const MAX_SYNC_OBJECTS = 50_000;
const MAX_SYNC_COLLECTIONS = 10_000;
const MAX_SYNC_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_SYNC_SOURCE_RECORDS = 20_000;
const MAX_SYNC_WARNINGS = 200;

export interface Mdbx2RuntimeClient {
  vaultStatus(vaultHandle: string): Promise<Mdbx2VaultRuntimeStatus>;
  listCollections(vaultHandle: string, input?: { deleted?: boolean; pageSize?: number; cursor?: string }): Promise<Mdbx2CollectionSummaryPage>;
  listObjects(vaultHandle: string, collectionId: string, input?: { objectTypeId?: string; deleted?: boolean; pageSize?: number; cursor?: string }): Promise<Mdbx2ObjectSummaryPage>;
  revealObject(vaultHandle: string, objectId: string): Promise<Mdbx2ObjectRecord>;
  upsertObject(vaultHandle: string, operationId: string, input: Mdbx2ObjectUpsertInput): Promise<Mdbx2ObjectWriteResult>;
  deleteObject(vaultHandle: string, operationId: string, logicalObjectId: string): Promise<Mdbx2ObjectDeleteResult>;
}

interface RemoteObject {
  record: Mdbx2ObjectRecord;
  summary: Mdbx2ObjectSummary;
  logicalObjectId: string;
  payload: Record<string, unknown>;
  item?: VaultItem;
  unsupportedReason?: string;
}

interface Mdbx2ProviderSession {
  vaultHandle: string;
  payloads: Map<string, Record<string, unknown>>;
  originals: Map<string, VaultItem>;
}

interface RemoteSnapshot {
  active: Map<string, RemoteObject>;
  deleted: Map<string, Mdbx2ObjectSummary>;
  warnings: string[];
  sourceRecords: ProviderSourceRecord[];
  payloads: Map<string, Record<string, unknown>>;
  originals: Map<string, VaultItem>;
}

export class Mdbx2Provider implements ProviderAdapter {
  readonly kind = "mdbx2" as const;
  private readonly sessions = new Map<string, Mdbx2ProviderSession>();

  constructor(private readonly runtime: Mdbx2RuntimeClient) {}

  async testConnection(account: ProviderAccount): Promise<void> {
    const status = await this.runtime.vaultStatus(vaultHandleOf(account));
    if (!status.available) throw new Error("MDBX2 本机工作副本不存在，请重新导入可移植备份。");
    if (!status.open) throw new Error("MDBX2 保险库尚未解锁。");
  }

  async sync(account: ProviderAccount, context: ProviderSyncContext): Promise<ProviderSyncResult> {
    context.signal?.throwIfAborted();
    await this.testConnection(account);
    const remote = await this.loadRemote(account, context.signal);
    this.sessions.set(account.id, { vaultHandle: vaultHandleOf(account), payloads: remote.payloads, originals: remote.originals });
    const scoped = context.localItems.filter((item) => referenceOf(item, account.id));
    const unrelated = context.localItems.filter((item) => !referenceOf(item, account.id));
    const localByRemote = new Map<string, VaultItem>();
    const creations: VaultItem[] = [];
    for (const item of scoped) {
      const remoteId = referenceOf(item, account.id)?.remoteId;
      if (remoteId) localByRemote.set(remoteId, item);
      else if (!item.deletedAt) creations.push(item);
    }

    const items = [...unrelated];
    const conflicts: ProviderSyncResult["conflicts"] = [];
    const handled = new Set<string>();
    for (const [remoteId, remoteObject] of remote.active) {
      context.signal?.throwIfAborted();
      handled.add(remoteId);
      const local = localByRemote.get(remoteId);
      if (!remoteObject.item) {
        if (local) items.push(local);
        continue;
      }
      if (!local) {
        items.push(finalizeRemote(remoteObject.item, undefined, account.id, remoteObject.summary));
        continue;
      }
      const reference = referenceOf(local, account.id)!;
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== reference.etag;
      const remoteChanged = Boolean(reference.revision) && reference.revision !== remoteObject.summary.headCommitId;
      if (local.deletedAt) {
        if (remoteChanged) {
          conflicts.push({ itemId: local.id, reason: "MDBX2 Object 在浏览器删除后又被其他设备修改。", local, remote: remoteObject.item });
          items.push(local);
        } else {
          await this.runtime.deleteObject(vaultHandleOf(account), crypto.randomUUID(), remoteObject.logicalObjectId);
        }
        continue;
      }
      if (localChanged && remoteChanged) {
        conflicts.push({ itemId: local.id, reason: "浏览器与 MDBX2 远端在同一基线后都修改了该 Object。", local, remote: remoteObject.item });
        items.push(local);
        continue;
      }
      if (localChanged) {
        const encoded = encodeMdbx2Object(local, remoteObject.payload, remoteObject.item);
        if (!encoded) {
          conflicts.push({ itemId: local.id, reason: "此 Monica 项目类型暂时无法写入 MDBX2。", local, remote: remoteObject.item });
          items.push(local);
          continue;
        }
        const written = await this.runtime.upsertObject(vaultHandleOf(account), crypto.randomUUID(), encoded);
        if (written.objectId !== remoteId) throw new Error("MDBX2 物理 Object ID 与 Android 兼容算法不一致。");
        remote.payloads.set(remoteId, JSON.parse(encoded.payloadJson) as Record<string, unknown>);
        const finalized = finalizeWritten(local, account.id, written);
        remote.originals.set(remoteId, finalized);
        items.push(finalized);
        continue;
      }
      items.push(finalizeRemote(remoteObject.item, local, account.id, remoteObject.summary));
    }

    for (const [remoteId, summary] of remote.deleted) {
      context.signal?.throwIfAborted();
      handled.add(remoteId);
      const local = localByRemote.get(remoteId);
      if (!local) continue;
      const reference = referenceOf(local, account.id)!;
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== reference.etag;
      if (localChanged) {
        conflicts.push({ itemId: local.id, reason: "MDBX2 Object 已由其他设备删除，但浏览器仍有未同步修改。", local });
        items.push(local);
      } else if (reference.revision && reference.revision === summary.headCommitId) {
        items.push(local);
      }
    }

    for (const [remoteId, local] of localByRemote) {
      context.signal?.throwIfAborted();
      if (handled.has(remoteId)) continue;
      const reference = referenceOf(local, account.id)!;
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== reference.etag;
      if (localChanged && !local.deletedAt) {
        conflicts.push({ itemId: local.id, reason: "MDBX2 中已找不到该 Object，但浏览器仍有未同步修改。", local });
        items.push(local);
      }
    }

    for (const item of creations) {
      context.signal?.throwIfAborted();
      const encoded = encodeMdbx2Object(item);
      if (!encoded) {
        conflicts.push({ itemId: item.id, reason: "此 Monica 项目类型暂时无法写入 MDBX2。", local: item });
        items.push(item);
        continue;
      }
      const written = await this.runtime.upsertObject(vaultHandleOf(account), crypto.randomUUID(), encoded);
      remote.payloads.set(written.objectId, JSON.parse(encoded.payloadJson) as Record<string, unknown>);
      const finalized = finalizeWritten(item, account.id, written);
      remote.originals.set(written.objectId, finalized);
      items.push(finalized);
    }

    return {
      items,
      accountPatch: conflicts.length
        ? { lastError: `发现 ${conflicts.length} 个 MDBX2 同步冲突。` }
        : { lastSyncAt: context.now, lastError: undefined },
      conflicts,
      warnings: remote.warnings,
      sourceRecords: remote.sourceRecords
    };
  }

  async create(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    await this.testConnection(account);
    const encoded = encodeMdbx2Object(item);
    if (!encoded) throw new Error("此 Monica 项目类型暂时无法写入 MDBX2。");
    const result = await this.runtime.upsertObject(vaultHandleOf(account), crypto.randomUUID(), encoded);
    this.session(account).payloads.set(result.objectId, JSON.parse(encoded.payloadJson) as Record<string, unknown>);
    const finalized = finalizeWritten(item, account.id, result);
    this.session(account).originals.set(result.objectId, finalized);
    return finalized;
  }

  async update(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    await this.testConnection(account);
    const remoteId = referenceOf(item, account.id)?.remoteId;
    const session = this.session(account);
    const original = remoteId ? session.payloads.get(remoteId) : undefined;
    const originalItem = remoteId ? session.originals.get(remoteId) : undefined;
    const encoded = encodeMdbx2Object(item, original, originalItem);
    if (!encoded) throw new Error("此 Monica 项目类型暂时无法写入 MDBX2。");
    const result = await this.runtime.upsertObject(vaultHandleOf(account), crypto.randomUUID(), encoded);
    session.payloads.set(result.objectId, JSON.parse(encoded.payloadJson) as Record<string, unknown>);
    const finalized = finalizeWritten(item, account.id, result);
    session.originals.set(result.objectId, finalized);
    return finalized;
  }

  async remove(account: ProviderAccount, item: VaultItem): Promise<void> {
    await this.testConnection(account);
    const remoteId = referenceOf(item, account.id)?.remoteId;
    await this.runtime.deleteObject(vaultHandleOf(account), crypto.randomUUID(), mdbx2LogicalObjectId(item));
    if (remoteId) {
      this.session(account).payloads.delete(remoteId);
      this.session(account).originals.delete(remoteId);
    }
  }

  lockAccount(providerId: string): void {
    this.sessions.delete(providerId);
  }

  lock(): void {
    this.sessions.clear();
  }

  private session(account: ProviderAccount): Mdbx2ProviderSession {
    const vaultHandle = vaultHandleOf(account);
    const current = this.sessions.get(account.id);
    if (current?.vaultHandle === vaultHandle) return current;
    const session = { vaultHandle, payloads: new Map<string, Record<string, unknown>>(), originals: new Map<string, VaultItem>() };
    this.sessions.set(account.id, session);
    return session;
  }

  private async loadRemote(account: ProviderAccount, signal?: AbortSignal): Promise<RemoteSnapshot> {
    const vaultHandle = vaultHandleOf(account);
    signal?.throwIfAborted();
    const collectionMap = new Map<string, Mdbx2CollectionSummary>();
    for (const collection of [
      ...await listAllCollections(this.runtime, vaultHandle, false, signal),
      ...await listAllCollections(this.runtime, vaultHandle, true, signal)
    ]) collectionMap.set(collection.collectionId, collection);
    const collections = [...collectionMap.values()];
    if (collections.length > MAX_SYNC_COLLECTIONS) throw new Error(`MDBX2 Collection 数量超过浏览器单次同步上限 ${MAX_SYNC_COLLECTIONS}。`);
    const active = new Map<string, RemoteObject>();
    const deleted = new Map<string, Mdbx2ObjectSummary>();
    const warnings: string[] = [];
    const sourceRecords: ProviderSourceRecord[] = [];
    const payloads = new Map<string, Record<string, unknown>>();
    const originals = new Map<string, VaultItem>();
    let total = 0;
    let totalPayloadBytes = 0;
    let omittedWarnings = 0;
    const addWarning = (warning: string) => {
      if (warnings.length < MAX_SYNC_WARNINGS) warnings.push(warning);
      else omittedWarnings += 1;
    };
    for (const collection of collections) {
      signal?.throwIfAborted();
      for (const deletedState of [false, true]) {
        const summaries = await listAllObjects(this.runtime, vaultHandle, collection.collectionId, deletedState, signal);
        total += summaries.length;
        if (total > MAX_SYNC_OBJECTS) throw new Error(`MDBX2 Object 数量超过浏览器单次同步上限 ${MAX_SYNC_OBJECTS}。`);
        for (const summary of summaries) {
          signal?.throwIfAborted();
          if (summary.deleted || deletedState) {
            deleted.set(summary.objectId, summary);
            continue;
          }
          let record: Mdbx2ObjectRecord;
          try {
            record = await this.runtime.revealObject(vaultHandle, summary.objectId);
          } catch (error) {
            addWarning(`${summary.title || summary.objectId}: ${error instanceof Error ? error.message : "Tiga 披露失败"}`);
            continue;
          }
          totalPayloadBytes += new TextEncoder().encode(record.payloadJson).byteLength;
          if (totalPayloadBytes > MAX_SYNC_PAYLOAD_BYTES) throw new Error(`MDBX2 Object 载荷总量超过浏览器单次同步上限 ${MAX_SYNC_PAYLOAD_BYTES} 字节。`);
          const decoded = decodeMdbx2Object(record, { headCommitId: summary.headCommitId, updatedAt: summary.updatedAt }, account.id);
          payloads.set(summary.objectId, decoded.payload);
          if (decoded.item) originals.set(summary.objectId, decoded.item);
          const remoteObject: RemoteObject = { record, summary, ...decoded };
          active.set(summary.objectId, remoteObject);
          if (decoded.unsupportedReason) {
            addWarning(decoded.unsupportedReason);
            if (sourceRecords.length >= MAX_SYNC_SOURCE_RECORDS) throw new Error(`MDBX2 未映射 Object 数量超过浏览器保存上限 ${MAX_SYNC_SOURCE_RECORDS}。`);
            sourceRecords.push(await createSourceRecord({
              providerId: account.id,
              remoteId: summary.objectId,
              revision: summary.headCommitId,
              format: "mdbx2-object-v1",
              encoding: "json",
              payload: JSON.stringify({ record, payload: decoded.payload })
            }));
          }
        }
      }
    }
    if (omittedWarnings) warnings.push(`另有 ${omittedWarnings} 条 MDBX2 兼容性提示已省略。`);
    return { active, deleted, warnings, sourceRecords, payloads, originals };
  }
}

async function listAllCollections(runtime: Mdbx2RuntimeClient, vaultHandle: string, deleted: boolean, signal?: AbortSignal): Promise<Mdbx2CollectionSummary[]> {
  const items: Mdbx2CollectionSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await runtime.listCollections(vaultHandle, { deleted, pageSize: 200, cursor });
    items.push(...page.items);
    if (!page.nextCursor) break;
    if (!page.items.length || seen.has(page.nextCursor)) throw new Error("MDBX2 Collection 分页游标没有前进。");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function listAllObjects(runtime: Mdbx2RuntimeClient, vaultHandle: string, collectionId: string, deleted: boolean, signal?: AbortSignal): Promise<Mdbx2ObjectSummary[]> {
  const items: Mdbx2ObjectSummary[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await runtime.listObjects(vaultHandle, collectionId, { deleted, pageSize: 200, cursor });
    items.push(...page.items);
    if (!page.nextCursor) break;
    if (!page.items.length || seen.has(page.nextCursor)) throw new Error("MDBX2 Object 分页游标没有前进。");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function vaultHandleOf(account: ProviderAccount): string {
  const value = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
  if (!value) throw new Error("MDBX2 密码源缺少本机工作副本句柄。");
  return value;
}

function referenceOf(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function finalizeRemote(remote: VaultItem, local: VaultItem | undefined, providerId: string, summary: Mdbx2ObjectSummary): VaultItem {
  const merged = (local
    ? { ...remote, id: local.id, favorite: local.favorite, createdAt: local.createdAt }
    : remote) as VaultItem;
  const reference: ProviderReference = {
    providerId,
    remoteId: summary.objectId,
    remoteFolderId: summary.collectionId,
    revision: summary.headCommitId,
    etag: fingerprint(merged)
  };
  return { ...merged, providerRefs: [...merged.providerRefs.filter((candidate) => candidate.providerId !== providerId), reference] } as VaultItem;
}

function finalizeWritten(item: VaultItem, providerId: string, result: Mdbx2ObjectWriteResult): VaultItem {
  const updated = { ...item, replicaGroupId: result.logicalObjectId, mdbxFolderId: result.collectionId } as VaultItem;
  const reference: ProviderReference = {
    providerId,
    remoteId: result.objectId,
    remoteFolderId: result.collectionId,
    revision: result.commitId,
    etag: fingerprint(updated)
  };
  return { ...updated, providerRefs: [...updated.providerRefs.filter((candidate) => candidate.providerId !== providerId), reference] } as VaultItem;
}

function fingerprint(item: VaultItem): string {
  const { id: _id, providerRefs: _refs, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...content } = item;
  return JSON.stringify(content, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : value);
}
