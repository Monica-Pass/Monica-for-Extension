import type { ProviderAccount, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { createSourceRecord } from "../../core/source-records";
import type { MdbxCredential, MdbxUnlockMethod } from "./mdbx-crypto";
import type { MdbxAccessLevel } from "./mdbx-format";
import { loadMdbxSqliteEngine, type MdbxSqliteDatabase } from "./mdbx-sqlite";
import { openMdbxVault, readMdbxEntries, type MdbxUnsupportedEntry, type MdbxVaultEntries } from "./mdbx-vault";
import { deleteMdbxEntry, writeMdbxEntry, type MdbxWriteContext } from "./mdbx-writer";

/**
 * What the settings UI is allowed to see. The decrypted database, the epoch key and the raw rows stay
 * in this module: the popup and content scripts must never receive more than a summary.
 */
export interface MdbxSessionSummary {
  providerId: string;
  vaultId: string;
  formatVersion: string;
  unlockMethod: MdbxUnlockMethod;
  accessLevel: MdbxAccessLevel;
  accessReason?: string;
  /** False when the vault carries no credential material, i.e. Android stored its contents as text. */
  encrypted: boolean;
  itemCount: number;
  unsupported: MdbxUnsupportedEntry[];
  warnings: string[];
  /** Writes live in memory until the file is exported; the UI must prompt while this is true. */
  dirty: boolean;
}

interface MdbxSession {
  database: MdbxSqliteDatabase;
  epochKey?: Uint8Array;
  deviceId: string;
  databaseId: number;
  entries: MdbxVaultEntries;
  summary: Omit<MdbxSessionSummary, "itemCount" | "unsupported" | "dirty">;
  dirty: boolean;
}

/**
 * One adapter instance serves every `.mdbx` file, because `ProviderRegistry` keys adapters by
 * `ProviderKind` (`provider.ts:31`). Files are multiplexed on `account.id`.
 *
 * A session must be opened with {@link unlock} before any other method works. The bytes come from a
 * file the user picked in an extension page — `chrome.identity` is barred by the permission whitelist
 * (`security-audit.mjs:12`), so cloud-backed sources are out of scope for this version.
 */
export class MdbxProvider implements ProviderAdapter {
  readonly kind = "mdbx" as const;
  private readonly sessions = new Map<string, MdbxSession>();

  async unlock(account: ProviderAccount, bytes: Uint8Array, credential: MdbxCredential): Promise<MdbxSessionSummary> {
    const engine = await loadMdbxSqliteEngine();
    const database = engine.open(bytes);
    try {
      const snapshot = await openMdbxVault(database, credential, databaseIdOf(account), account.id);
      this.lockAccount(account.id);
      this.sessions.set(account.id, {
        database,
        epochKey: snapshot.epochKey,
        deviceId: typeof account.config.deviceId === "string" && account.config.deviceId ? account.config.deviceId : crypto.randomUUID(),
        databaseId: databaseIdOf(account),
        entries: { items: snapshot.items, unsupported: snapshot.unsupported, payloads: snapshot.payloads },
        summary: {
          providerId: account.id,
          vaultId: snapshot.meta.vaultId,
          formatVersion: snapshot.meta.formatVersion,
          unlockMethod: snapshot.meta.unlockMethod,
          accessLevel: snapshot.access.level,
          accessReason: snapshot.access.reason,
          encrypted: Boolean(snapshot.epochKey),
          warnings: snapshot.warnings
        },
        dirty: false
      });
      return this.summarize(account.id);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  isUnlocked(providerId: string): boolean {
    return this.sessions.has(providerId);
  }

  summarize(providerId: string): MdbxSessionSummary {
    const session = this.requireSession(providerId);
    return {
      ...session.summary,
      itemCount: session.entries.items.filter((item) => !item.deletedAt).length,
      unsupported: session.entries.unsupported,
      dirty: session.dirty
    };
  }

  /** Returns the whole file so the user can overwrite the original. Clears the unsaved-changes flag. */
  exportFile(providerId: string): Uint8Array {
    const session = this.requireSession(providerId);
    const bytes = session.database.export();
    session.dirty = false;
    return bytes;
  }

  lockAccount(providerId: string): void {
    const session = this.sessions.get(providerId);
    if (!session) return;
    session.database.close();
    this.sessions.delete(providerId);
  }

  lock(): void {
    for (const providerId of [...this.sessions.keys()]) this.lockAccount(providerId);
  }

  async testConnection(account: ProviderAccount): Promise<void> {
    this.requireSession(account.id);
  }

  async sync(account: ProviderAccount, context: ProviderSyncContext): Promise<ProviderSyncResult> {
    const session = this.requireSession(account.id);
    const scoped = context.localItems.filter((item) => referenceOf(item, account.id));
    const unrelated = context.localItems.filter((item) => !referenceOf(item, account.id));
    const remoteById = new Map(session.entries.items.map((item) => [remoteIdOf(item, account.id), item]));

    const localById = new Map<string, VaultItem>();
    const creations: VaultItem[] = [];
    for (const item of scoped) {
      const remoteId = referenceOf(item, account.id)?.remoteId;
      if (remoteId) localById.set(remoteId, item);
      else if (!item.deletedAt) creations.push(item);
    }

    const conflicts: ProviderSyncResult["conflicts"] = [];
    const keepLocal = new Map<string, VaultItem>();
    const updates: Array<{ entryId: string; item: VaultItem; previous: VaultItem }> = [];
    const deletions: string[] = [];

    for (const [remoteId, local] of localById) {
      const reference = referenceOf(local, account.id)!;
      const remote = remoteById.get(remoteId);
      /** No stored fingerprint means no baseline, so the safe move is always to take the file's copy. */
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== reference.etag;

      if (!remote) {
        if (local.deletedAt) continue;
        if (reference.etag && !localChanged) continue;
        conflicts.push({ itemId: local.id, reason: "此条目已从 MDBX 数据库中移除，但浏览器中还有未同步的修改。", local });
        keepLocal.set(remoteId, local);
        continue;
      }

      const remoteChanged = (referenceOf(remote, account.id)?.revision || "") !== (reference.revision || "");
      if (local.deletedAt) {
        if (remoteChanged) {
          conflicts.push({ itemId: local.id, reason: "此条目在浏览器中已删除，但 Monica Android 之后又修改过它。", local, remote });
          keepLocal.set(remoteId, local);
        } else {
          deletions.push(remoteId);
        }
        continue;
      }
      if (!localChanged) continue;
      if (remoteChanged) {
        conflicts.push({ itemId: local.id, reason: "浏览器和 Monica Android 在上次同步后都修改了此条目。", local, remote });
        keepLocal.set(remoteId, local);
        continue;
      }
      updates.push({ entryId: remoteId, item: local, previous: remote });
    }

    const warnings = [...session.summary.warnings];
    if (session.summary.accessLevel !== "read-write" && (updates.length || deletions.length || creations.length)) {
      const reason = `此 MDBX 数据库当前为只读（${session.summary.accessReason || "未知原因"}），本地修改未写入。`;
      for (const item of [...updates.map((update) => update.item), ...creations, ...deletions.map((id) => localById.get(id)!)]) {
        conflicts.push({ itemId: item.id, reason, local: item });
        const remoteId = referenceOf(item, account.id)?.remoteId;
        if (remoteId) keepLocal.set(remoteId, item);
      }
      updates.length = 0;
      deletions.length = 0;
      creations.length = 0;
    }

    const writeContext: MdbxWriteContext = {
      database: session.database,
      epochKey: session.epochKey,
      deviceId: session.deviceId,
      now: context.now
    };
    for (const update of updates) {
      await writeMdbxEntry({ ...writeContext, originalPayload: session.entries.payloads.get(update.entryId), previous: update.previous }, update.entryId, update.item);
    }
    for (const item of creations) {
      const entryId = crypto.randomUUID();
      await writeMdbxEntry(writeContext, entryId, item);
      localById.set(entryId, item);
    }
    for (const entryId of deletions) await deleteMdbxEntry(writeContext, entryId);

    const written = updates.length + creations.length + deletions.length;
    if (written) session.dirty = true;
    session.entries = await readMdbxEntries(session.database, session.epochKey, session.databaseId, account.id);

    const items = [...unrelated];
    const emitted = new Set<string>();
    for (const remote of session.entries.items) {
      const remoteId = remoteIdOf(remote, account.id);
      emitted.add(remoteId);
      const conflicted = keepLocal.get(remoteId);
      if (conflicted) items.push(conflicted);
      else if (!remote.deletedAt) items.push(finalize(remote, localById.get(remoteId), account.id));
    }
    for (const [remoteId, local] of keepLocal) if (!emitted.has(remoteId)) items.push(local);

    if (session.entries.unsupported.length) {
      warnings.push(`有 ${session.entries.unsupported.length} 个条目的类型本版本无法解析，已原样保留、不会被改写。`);
    }
    if (session.dirty) warnings.push("MDBX 数据库的改动仅存在于内存中，请导出文件并覆盖原文件后再在 Monica Android 中打开。");

    return {
      items,
      accountPatch: conflicts.length
        ? { lastError: `发现 ${conflicts.length} 个 MDBX 同步冲突。` }
        : { lastSyncAt: context.now, lastError: undefined, config: { ...account.config, deviceId: session.deviceId } },
      conflicts,
      warnings,
      sourceRecords: await unsupportedSourceRecords(session, account.id)
    };
  }

  async create(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    const session = this.requireWritableSession(account.id);
    const entryId = crypto.randomUUID();
    await writeMdbxEntry(this.writeContext(session), entryId, item);
    return this.afterWrite(session, account.id, entryId, item);
  }

  async update(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    const session = this.requireWritableSession(account.id);
    const entryId = referenceOf(item, account.id)?.remoteId;
    if (!entryId) return this.create(account, item);
    const previous = session.entries.items.find((candidate) => remoteIdOf(candidate, account.id) === entryId);
    await writeMdbxEntry(
      { ...this.writeContext(session), originalPayload: session.entries.payloads.get(entryId), previous },
      entryId,
      item
    );
    return this.afterWrite(session, account.id, entryId, item);
  }

  async remove(account: ProviderAccount, item: VaultItem): Promise<void> {
    const session = this.requireWritableSession(account.id);
    const entryId = referenceOf(item, account.id)?.remoteId;
    if (!entryId) return;
    await deleteMdbxEntry(this.writeContext(session), entryId);
    await this.refresh(session, account.id);
  }

  private async afterWrite(session: MdbxSession, providerId: string, entryId: string, item: VaultItem): Promise<VaultItem> {
    await this.refresh(session, providerId);
    const stored = session.entries.items.find((candidate) => remoteIdOf(candidate, providerId) === entryId);
    return finalize(stored || item, item, providerId);
  }

  private async refresh(session: MdbxSession, providerId: string): Promise<void> {
    session.dirty = true;
    session.entries = await readMdbxEntries(session.database, session.epochKey, session.databaseId, providerId);
  }

  private writeContext(session: MdbxSession): MdbxWriteContext {
    return { database: session.database, epochKey: session.epochKey, deviceId: session.deviceId, now: new Date().toISOString() };
  }

  private requireSession(providerId: string): MdbxSession {
    const session = this.sessions.get(providerId);
    if (!session) throw new Error("此 MDBX 数据库尚未解锁，请在 Monica 设置页中选择 .mdbx 文件并输入凭据。");
    return session;
  }

  private requireWritableSession(providerId: string): MdbxSession {
    const session = this.requireSession(providerId);
    if (session.summary.accessLevel !== "read-write") {
      throw new Error(`此 MDBX 数据库当前为只读（${session.summary.accessReason || "未知原因"}），已拒绝写入以免损坏数据。`);
    }
    return session;
  }
}

/**
 * Only rows this build cannot model are kept as source envelopes. Every other row is reproducible
 * from the item plus the `.mdbx` file itself, and mirroring the whole database here would push a
 * large vault past the 32 MiB envelope budget in `source-records.ts`.
 */
async function unsupportedSourceRecords(session: MdbxSession, providerId: string): Promise<ProviderSourceRecord[]> {
  return Promise.all(session.entries.unsupported.map((entry) => createSourceRecord({
    providerId,
    remoteId: entry.entryId,
    format: "mdbx-row",
    encoding: "json",
    payload: JSON.stringify({ entry_type: entry.entryType, payload: session.entries.payloads.get(entry.entryId) ?? {} })
  })));
}

function databaseIdOf(account: ProviderAccount): number {
  const value = Number(account.config.databaseId);
  return Number.isFinite(value) ? value : 0;
}

function referenceOf(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function remoteIdOf(item: VaultItem, providerId: string): string {
  return referenceOf(item, providerId)?.remoteId || item.id;
}

/**
 * Keeps the browser-side identity of an item that already existed locally. `favorite` is carried over
 * because MDBX `entries` rows have no such column, so taking the decoded row verbatim would reset the
 * user's local flag on every sync.
 */
function finalize(remote: VaultItem, local: VaultItem | undefined, providerId: string): VaultItem {
  const merged = (local ? { ...remote, id: local.id, favorite: local.favorite } : remote) as VaultItem;
  const reference: ProviderReference = {
    providerId,
    remoteId: remoteIdOf(remote, providerId),
    revision: referenceOf(remote, providerId)?.revision,
    etag: fingerprint(merged)
  };
  return { ...merged, providerRefs: [...merged.providerRefs.filter((candidate) => candidate.providerId !== providerId), reference] } as VaultItem;
}

/**
 * Local-change detection. MDBX rows track their own revision in `object_clock`, but nothing on the
 * row says whether the browser copy drifted, so the fingerprint of the last synced content is stored
 * in the provider reference's `etag`. Keys are sorted so a differently ordered but equal item does
 * not register as an edit.
 */
function fingerprint(item: VaultItem): string {
  const { id: _id, providerRefs: _refs, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...content } = item;
  return JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}
