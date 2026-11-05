import type { BitwardenProjectDeletionJournal } from '../../core/bitwarden-project-removal-journal';
import { BitwardenProjectLocalChange } from '../../core/bitwarden-project-removal-local';
import { sha256Hex } from '../../core/digest';
import { readPasswordProjectRemovalJournal, type PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { assertKnownBitwardenCipher } from './bitwarden-cipher-codec';
import type { SecureVaultService } from '../../security/secure-vault-service';
import { BitwardenClient, type BitwardenSessionConfig } from './bitwarden-client';

export type BitwardenProjectRemovalConflictReason = NonNullable<BitwardenProjectDeletionJournal['reason']>;
export class BitwardenProjectRemovalConflict extends Error {
  constructor(readonly reason: BitwardenProjectRemovalConflictReason) {
    super('Bitwarden 项目在移除期间变化，正在恢复原密码；保留的草稿需要重新核对。');
  }
}

export interface BitwardenProjectRemovalStore {
  read(operationId: string): Promise<PasswordProjectRemovalRecord>;
  update(operationId: string, expectedRevision: number, next: BitwardenProjectDeletionJournal): Promise<PasswordProjectRemovalRecord>;
}
export interface BitwardenProjectRemovalRemote {
  readCipher(cipherId: string): Promise<Record<string, unknown> | null>;
  /** Must never retry an ambiguous request at the transport layer. */
  deleteCipher(cipherId: string): Promise<void>;
  /** Must never retry an ambiguous request at the transport layer. */
  restoreCipher(cipherId: string): Promise<void>;
  /** Fresh project membership, retained content and both attachment byte streams.
   * Semantic mismatch must throw BitwardenProjectRemovalConflict; network failure
   * must retain its distinct error so it cannot falsely authorize compensation.
   */
  verifyRetained(record: PasswordProjectRemovalRecord): Promise<void>;
}

export function bitwardenProjectRemovalStore(vault: SecureVaultService): BitwardenProjectRemovalStore {
  return {
    read: async operationId => {
      const record = (await vault.readPasswordProjectRemovals()).find(row => row.id === operationId);
      if (!record) throw new Error('找不到 Bitwarden 项目移除日志。');
      return record;
    },
    update: (operationId, expectedRevision, next) => vault.updatePasswordProjectBitwardenDeletion(operationId, expectedRevision, next)
  };
}

/** Real HTTP transport; the verification callback belongs to the source-specific
 * coordinator, never to manager input. Refresh credentials stay in background.
 */
export function bitwardenProjectRemovalRemote(client: BitwardenClient, initialSession: BitwardenSessionConfig,
  verifyRetained: BitwardenProjectRemovalRemote['verifyRetained'], signal?: AbortSignal): BitwardenProjectRemovalRemote {
  let session = initialSession;
  return {
    readCipher: async cipherId => { const result = await client.getCipherDetails(session, cipherId, signal); session = result.session; return result.payload; },
    deleteCipher: async cipherId => { session = await client.softDeleteCipher(session, cipherId, signal); },
    restoreCipher: async cipherId => { session = (await client.restoreCipherOnce(session, cipherId, signal)).session; },
    verifyRetained
  };
}

const text = (raw: Record<string, unknown>, key: string) => raw[key] ?? raw[key[0].toUpperCase() + key.slice(1)];
const trashed = (raw: Record<string, unknown>) => Boolean(text(raw, 'deletedDate'));

/** Compare native bytes conservatively. Re-encryption counts as a conflict.
 * Signed attachment URLs expire without changing any user data; other unknown
 * fields remain in the digest and cannot disappear unnoticed.
 */
export async function bitwardenRemovalSnapshotSha256(raw: Record<string, unknown>): Promise<string> {
  assertKnownBitwardenCipher(raw);
  if (typeof text(raw, 'id') !== 'string' || !text(raw, 'id') || typeof text(raw, 'revisionDate') !== 'string'
    || !Number.isFinite(Date.parse(String(text(raw, 'revisionDate'))))) throw new Error('Bitwarden 原始项目缺少身份或修订。');
  // The RawJSON passthrough must be re-checked at every recursion level:
  // rebuilding an object through Object.entries destroys the rawJSON marker,
  // so this recursion is intentionally NOT the shared canonical kernel.
  const stable = (value: unknown): unknown => (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON?.(value) ? value
    : Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value;
  const canonical = Object.fromEntries(Object.entries(raw).filter(([key]) => !['revisiondate', 'deleteddate'].includes(key.toLowerCase())).map(([key, value]) => {
    if (key.toLowerCase() !== 'attachments' || !Array.isArray(value)) return [key, value];
    return [key, value.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Bitwarden 附件清单无效。');
      return Object.fromEntries(Object.entries(row).filter(([name]) => name.toLowerCase() !== 'url'));
    }).sort((a, b) => String(text(a, 'id')).localeCompare(String(text(b, 'id'))))];
  }));
  return sha256Hex(JSON.stringify(stable(canonical)));
}

/** Dedicated journaled transaction. Ordinary sync remains forbidden while the
 * parent removal is pending. Remote completion is separate from local adoption.
 * The caller serializes one provider's mutations for this entire operation.
 */
export class BitwardenProjectRemovalTransaction {
  private readonly active = new Map<string, Promise<PasswordProjectRemovalRecord>>();
  constructor(private readonly store: BitwardenProjectRemovalStore, private readonly remote: BitwardenProjectRemovalRemote) {}

  resume(operationId: string): Promise<PasswordProjectRemovalRecord> {
    const previous = this.active.get(operationId);
    if (previous) return previous;
    const current = this.run(operationId).finally(() => this.active.delete(operationId));
    this.active.set(operationId, current); return current;
  }

  /** The coordinator observed a local edit. Stop deleting, but retain all remote
   * results and finish compensation before exposing both versions as conflicts. */
  restoreAfterLocalChange(operationId: string): Promise<PasswordProjectRemovalRecord> {
    return this.compensate(operationId, 'local-changed');
  }

  private async read(operationId: string) {
    const [record] = readPasswordProjectRemovalJournal([await this.store.read(operationId)]);
    if (record.id !== operationId || !record.bitwardenDeletion || record.status !== 'deleting')
      throw new Error('Bitwarden 项目移除尚未准备或已经由其他操作处理。');
    return record;
  }

  private async update(record: PasswordProjectRemovalRecord, patch: Partial<BitwardenProjectDeletionJournal>, index?: number,
    stage?: BitwardenProjectDeletionJournal['members'][number]['stage']) {
    const saved = record.bitwardenDeletion!;
    const next = { ...saved, ...patch, revision: saved.revision + 1,
      members: saved.members.map((row, position) => position === index && stage ? { ...row, stage } : row) };
    return this.store.update(record.id, saved.revision, next);
  }

  private async source(record: PasswordProjectRemovalRecord, index: number) {
    const row = record.bitwardenDeletion!.members[index];
    const raw = await this.remote.readCipher(row.cipherId);
    if (!raw || text(raw, 'id') !== row.cipherId) throw new Error('Bitwarden 原密码不存在或不可访问，已保留恢复日志。');
    return raw;
  }

  private async verifySource(record: PasswordProjectRemovalRecord, index: number, raw: Record<string, unknown>) {
    let digest: string;
    try { digest = await bitwardenRemovalSnapshotSha256(raw); }
    catch { throw new BitwardenProjectRemovalConflict('source-changed'); }
    if (digest !== record.bitwardenDeletion!.members[index].snapshotSha256)
      throw new BitwardenProjectRemovalConflict('source-changed');
  }

  private async run(operationId: string): Promise<PasswordProjectRemovalRecord> {
    let record = await this.read(operationId);
    if (record.bitwardenDeletion!.phase === 'restored') return record;
    if (record.bitwardenDeletion!.phase === 'committed') {
      // Remote writes were confirmed, but the local adoption is still pending.
      // A later independent restore/change requires compensation, never a retry
      // that blindly re-deletes the source or adopts a now-invalid snapshot.
      try {
        await this.remote.verifyRetained(record);
        for (let index = 0; index < record.bitwardenDeletion!.members.length; index++) {
          const raw = await this.source(record, index);
          if (!trashed(raw)) throw new BitwardenProjectRemovalConflict('source-live');
          await this.verifySource(record, index, raw);
        }
        return record;
      } catch (cause) {
        if (!(cause instanceof BitwardenProjectRemovalConflict)) throw cause;
        return this.compensate(operationId, cause.reason);
      }
    }
    if (record.bitwardenDeletion!.phase === 'restoring') return this.restore(record);
    try {
      for (let index = 0; index < record.bitwardenDeletion!.members.length; index++) {
        const row = record.bitwardenDeletion!.members[index];
        const raw = await this.source(record, index);
        if (row.stage === 'ready') {
          if (trashed(raw)) throw new BitwardenProjectRemovalConflict('source-changed');
          await this.verifySource(record, index, raw);
          await this.remote.verifyRetained(record);
          // Save intent before the first network byte. A failed save never deletes.
          record = await this.update(record, {}, index, 'delete-attempted');
          await this.remote.deleteCipher(row.cipherId);
          const result = await this.source(record, index);
          if (!trashed(result)) throw new BitwardenProjectRemovalConflict('source-live');
          await this.verifySource(record, index, result);
          record = await this.update(record, {}, index, 'deleted');
        } else {
          // An attempted delete is never replayed. Its current result must be observed.
          if (!trashed(raw)) throw new BitwardenProjectRemovalConflict('source-live');
          await this.verifySource(record, index, raw);
          if (row.stage === 'delete-attempted') record = await this.update(record, {}, index, 'deleted');
        }
      }
      await this.remote.verifyRetained(record);
      for (let index = 0; index < record.bitwardenDeletion!.members.length; index++) {
        const raw = await this.source(record, index);
        if (!trashed(raw)) throw new BitwardenProjectRemovalConflict('source-live');
        await this.verifySource(record, index, raw);
      }
      // This records a verified sequence of individual writes, not a server CAS.
      return this.update(record, { phase: 'committed' });
    } catch (cause) {
      if (cause instanceof BitwardenProjectLocalChange) return this.restoreAfterLocalChange(operationId);
      if (!(cause instanceof BitwardenProjectRemovalConflict)) throw cause;
      // Re-read durable state: a lost journal-write response must not use a stale
      // revision, nor allow deletion to continue after compensation was selected.
      return this.compensate(operationId, cause.reason);
    }
  }

  private async compensate(operationId: string, reason: BitwardenProjectRemovalConflictReason) {
    const record = await this.read(operationId);
    if (record.bitwardenDeletion!.phase === 'deleting' || record.bitwardenDeletion!.phase === 'committed')
      return this.restore(await this.update(record, { phase: 'restoring', reason }));
    return record.bitwardenDeletion!.phase === 'restoring' ? this.restore(record) : record;
  }

  private async restore(initial: PasswordProjectRemovalRecord): Promise<PasswordProjectRemovalRecord> {
    let record = initial;
    for (let index = 0; index < record.bitwardenDeletion!.members.length; index++) {
      const row = record.bitwardenDeletion!.members[index];
      if (row.stage === 'ready' || row.stage === 'restored') continue;
      let raw = await this.source(record, index);
      if (trashed(raw)) {
        if (row.stage === 'restore-attempted') {
          // Another device might have deleted after a successful restore. The
          // original response being unknown is not permission to resurrect again.
          throw new Error('Bitwarden 恢复结果未确认，远端仍在回收站；已停止重复恢复，请检查远端状态。');
        }
        record = await this.update(record, {}, index, 'restore-attempted');
        await this.remote.restoreCipher(row.cipherId);
        raw = await this.source(record, index);
        if (trashed(raw)) throw new Error('Bitwarden 原密码尚未确认恢复，已保留恢复日志。');
      }
      // Keep the server's latest bytes. Never PUT a saved password snapshot back.
      record = await this.update(record, {}, index, 'restored');
    }
    // Verify all touched sources again before reporting compensation completed.
    for (let index = 0; index < record.bitwardenDeletion!.members.length; index++) {
      if (record.bitwardenDeletion!.members[index].stage !== 'ready' && trashed(await this.source(record, index)))
        throw new Error('Bitwarden 原密码再次发生变化，恢复日志已保留。');
    }
    return this.update(record, { phase: 'restored' });
  }
}
