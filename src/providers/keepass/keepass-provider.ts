import * as kdbxweb from "kdbxweb";
import type { ProviderAccount, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { createSourceRecord } from "../../core/source-records";
import { keePassSourceRecordFor, openKeePassVault, readKeePassEntries, type KeePassSkippedEntry, type KeePassVaultEntries } from "./keepass-vault";
import { createKeePassEntry, removeKeePassEntry, writeKeePassEntry } from "./keepass-writer";

/**
 * What the settings UI is allowed to see. The open `Kdbx`, the master credential and the entry fields
 * stay in this module: the popup and content scripts must never receive more than a summary.
 */
export interface KeePassSessionSummary {
  providerId: string;
  databaseName: string;
  versionMajor: number;
  cipherName?: string;
  itemCount: number;
  /** Entries no codec claimed. Never rewritten, reported so the user knows they are still in the file. */
  skipped: KeePassSkippedEntry[];
  warnings: string[];
  /** Writes live in memory until the file is exported; the UI must prompt while this is true. */
  dirty: boolean;
}

interface KeePassSession {
  database: kdbxweb.Kdbx;
  databaseId: number;
  entries: KeePassVaultEntries;
  summary: Omit<KeePassSessionSummary, "itemCount" | "skipped" | "dirty">;
  dirty: boolean;
}

export interface KeePassUnlockCredential {
  password: string;
  keyFile?: Uint8Array;
  sourceName?: string;
}

/**
 * One adapter instance serves every `.kdbx` file, because `ProviderRegistry` keys adapters by
 * `ProviderKind` (`provider.ts:31`). Files are multiplexed on `account.id`.
 *
 * A session must be opened with {@link unlock} before any other method works. The bytes come from a
 * file the user picked in an extension page, and {@link exportFile} hands the edited file back for the
 * user to save over the original: the browser cannot hold a writable handle to the picked file across
 * a service-worker restart, so the extension never claims to edit the original in place.
 */
export class KeePassProvider implements ProviderAdapter {
  readonly kind = "keepass" as const;
  private readonly sessions = new Map<string, KeePassSession>();

  async unlock(
    account: ProviderAccount,
    bytes: Uint8Array,
    credential: KeePassUnlockCredential
  ): Promise<KeePassSessionSummary> {
    const snapshot = await openKeePassVault(bytes, {
      password: credential.password,
      keyFile: credential.keyFile,
      sourceName: credential.sourceName,
      databaseId: databaseIdOf(account),
      providerId: account.id
    });

    this.lockAccount(account.id);
    this.sessions.set(account.id, {
      database: snapshot.database,
      databaseId: databaseIdOf(account),
      entries: { items: snapshot.items, skipped: snapshot.skipped, entriesByUuid: snapshot.entriesByUuid },
      summary: {
        providerId: account.id,
        databaseName: snapshot.database.meta.name || credential.sourceName || "KeePass 数据库",
        versionMajor: snapshot.versionMajor,
        cipherName: snapshot.cipherName,
        warnings: snapshot.warnings
      },
      dirty: false
    });
    return this.summarize(account.id);
  }

  isUnlocked(providerId: string): boolean {
    return this.sessions.has(providerId);
  }

  summarize(providerId: string): KeePassSessionSummary {
    const session = this.requireSession(providerId);
    return {
      ...session.summary,
      itemCount: session.entries.items.filter((item) => !item.deletedAt).length,
      skipped: session.entries.skipped,
      dirty: session.dirty
    };
  }

  /**
   * Re-encrypts the whole database so the user can overwrite the original file, and clears the
   * unsaved-changes flag. The KDF is whatever the file already declares, so a KDBX 3 file stays KDBX 3.
   */
  async exportFile(providerId: string): Promise<Uint8Array> {
    const session = this.requireSession(providerId);
    const bytes = new Uint8Array(await session.database.save());
    session.dirty = false;
    return bytes;
  }

  lockAccount(providerId: string): void {
    this.sessions.delete(providerId);
  }

  lock(): void {
    this.sessions.clear();
  }

  async testConnection(account: ProviderAccount): Promise<void> {
    this.requireSession(account.id);
  }

  async sync(account: ProviderAccount, context: ProviderSyncContext): Promise<ProviderSyncResult> {
    const session = this.requireSession(account.id);
    const scoped = context.localItems.filter((item) => referenceOf(item, account.id));
    const unrelated = context.localItems.filter((item) => !referenceOf(item, account.id));

    const localByUuid = new Map<string, VaultItem>();
    const creations: VaultItem[] = [];
    for (const item of scoped) {
      const remoteId = referenceOf(item, account.id)?.remoteId;
      if (remoteId) localByUuid.set(remoteId, item);
      else if (!item.deletedAt) creations.push(item);
    }
    const remoteByUuid = new Map(session.entries.items.map((item) => [remoteIdOf(item, account.id), item]));

    const conflicts: ProviderSyncResult["conflicts"] = [];
    const keepLocal = new Map<string, VaultItem>();
    const updates: Array<{ entryUuid: string; item: VaultItem }> = [];
    const deletions: string[] = [];

    for (const [entryUuid, local] of localByUuid) {
      const reference = referenceOf(local, account.id)!;
      const remote = remoteByUuid.get(entryUuid);
      /** No stored fingerprint means no baseline, so the safe move is always to take the file's copy. */
      const localChanged = Boolean(reference.etag) && fingerprint(local) !== reference.etag;

      if (!remote) {
        if (local.deletedAt) continue;
        if (reference.etag && !localChanged) continue;
        conflicts.push({ itemId: local.id, reason: "此条目已从 KeePass 数据库中移除，但浏览器中还有未同步的修改。", local });
        keepLocal.set(entryUuid, local);
        continue;
      }

      const remoteChanged = (referenceOf(remote, account.id)?.revision || "") !== (reference.revision || "");
      if (local.deletedAt) {
        if (remoteChanged) {
          conflicts.push({ itemId: local.id, reason: "此条目在浏览器中已删除，但 Monica Android 之后又修改过它。", local, remote });
          keepLocal.set(entryUuid, local);
        } else {
          deletions.push(entryUuid);
        }
        continue;
      }
      if (!localChanged) continue;
      if (remoteChanged) {
        conflicts.push({ itemId: local.id, reason: "浏览器和 Monica Android 在上次同步后都修改了此条目。", local, remote });
        keepLocal.set(entryUuid, local);
        continue;
      }
      updates.push({ entryUuid, item: local });
    }

    for (const update of updates) {
      const entry = session.entries.entriesByUuid.get(update.entryUuid);
      if (entry) writeKeePassEntry(session.database, entry, update.item);
    }
    for (const item of creations) {
      const { entry } = createKeePassEntry(session.database, item, item.keepassGroupPath);
      localByUuid.set(entry.uuid.toString(), item);
    }
    for (const entryUuid of deletions) {
      const entry = session.entries.entriesByUuid.get(entryUuid);
      if (entry) removeKeePassEntry(session.database, entry);
    }

    if (updates.length + creations.length + deletions.length) session.dirty = true;
    this.reread(session, account.id);

    const warnings = [...session.summary.warnings];
    const items = [...unrelated];
    const emitted = new Set<string>();
    for (const remote of session.entries.items) {
      const entryUuid = remoteIdOf(remote, account.id);
      emitted.add(entryUuid);
      const conflicted = keepLocal.get(entryUuid);
      if (conflicted) items.push(conflicted);
      else if (!remote.deletedAt) items.push(finalize(remote, localByUuid.get(entryUuid), account.id));
    }
    for (const [entryUuid, local] of keepLocal) if (!emitted.has(entryUuid)) items.push(local);

    if (session.entries.skipped.length) {
      warnings.push(`有 ${session.entries.skipped.length} 个条目本版本无法解析，已原样保留、不会被改写。`);
    }
    if (session.dirty) {
      warnings.push("KeePass 数据库的改动仅存在于内存中，请导出文件并覆盖原文件后再在 Monica Android 或 KeePassXC 中打开。");
    }

    return {
      items,
      accountPatch: conflicts.length
        ? { lastError: `发现 ${conflicts.length} 个 KeePass 同步冲突。` }
        : { lastSyncAt: context.now, lastError: undefined },
      conflicts,
      warnings,
      sourceRecords: await skippedSourceRecords(session, account.id)
    };
  }

  async create(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    const session = this.requireSession(account.id);
    const { entry } = createKeePassEntry(session.database, item, item.keepassGroupPath);
    return this.afterWrite(session, account.id, entry.uuid.toString(), item);
  }

  async update(account: ProviderAccount, item: VaultItem): Promise<VaultItem> {
    const session = this.requireSession(account.id);
    const entryUuid = referenceOf(item, account.id)?.remoteId;
    const entry = entryUuid ? session.entries.entriesByUuid.get(entryUuid) : undefined;
    if (!entry || !entryUuid) return this.create(account, item);
    writeKeePassEntry(session.database, entry, item);
    return this.afterWrite(session, account.id, entryUuid, item);
  }

  async remove(account: ProviderAccount, item: VaultItem): Promise<void> {
    const session = this.requireSession(account.id);
    const entryUuid = referenceOf(item, account.id)?.remoteId;
    const entry = entryUuid ? session.entries.entriesByUuid.get(entryUuid) : undefined;
    if (!entry) return;
    removeKeePassEntry(session.database, entry);
    session.dirty = true;
    this.reread(session, account.id);
  }

  private afterWrite(session: KeePassSession, providerId: string, entryUuid: string, item: VaultItem): VaultItem {
    session.dirty = true;
    this.reread(session, providerId);
    const stored = session.entries.items.find((candidate) => remoteIdOf(candidate, providerId) === entryUuid);
    return finalize(stored || item, item, providerId);
  }

  private reread(session: KeePassSession, providerId: string): void {
    session.entries = readKeePassEntries(session.database, session.databaseId, providerId);
  }

  private requireSession(providerId: string): KeePassSession {
    const session = this.sessions.get(providerId);
    if (!session) throw new Error("此 KeePass 数据库尚未解锁，请在 Monica 设置页中选择 .kdbx 文件并输入密码或密钥文件。");
    return session;
  }
}

/**
 * Only entries no codec claimed are kept as source envelopes. Every other entry is reproducible from
 * the item plus the file itself, and mirroring the whole database here would push a large vault past
 * the 32 MiB envelope budget in `source-records.ts`.
 */
async function skippedSourceRecords(session: KeePassSession, providerId: string): Promise<ProviderSourceRecord[]> {
  const records: ProviderSourceRecord[] = [];
  for (const skipped of session.entries.skipped) {
    const entry = session.entries.entriesByUuid.get(skipped.entryUuid);
    if (!entry) continue;
    records.push(await createSourceRecord(keePassSourceRecordFor(entry, providerId)));
  }
  return records;
}

function databaseIdOf(account: ProviderAccount): number {
  const value = Number(account.config.databaseId);
  return Number.isFinite(value) ? value : 0;
}

function referenceOf(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function remoteIdOf(item: VaultItem, providerId: string): string {
  return referenceOf(item, providerId)?.remoteId || item.keepassEntryUuid || item.id;
}

/**
 * Keeps the browser-side identity of an item that already existed locally. `favorite` is carried over
 * because a KeePass login entry has no field for it, so taking the decoded entry verbatim would reset
 * the user's local flag on every sync.
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
 * Local-change detection. A KDBX entry carries no revision the browser can compare against, so the
 * fingerprint of the last synced content is stored in the provider reference's `etag`. Keys are sorted
 * so a differently ordered but equal item does not register as an edit.
 */
function fingerprint(item: VaultItem): string {
  const { id: _id, providerRefs: _refs, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, ...content } = item;
  return JSON.stringify(content, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
      : value);
}
