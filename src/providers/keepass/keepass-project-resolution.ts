import type { ProviderAccount } from '../../core/model';
import { sameProviderBinding } from '../../core/provider';
import { base64ToBytes } from '../../security/encoding';
import { keePassConflictReviewToken, type KeePassConflictRevision } from './keepass-conflict-review-token';
import { openKeePassConflictRecovery, sealKeePassConflictRecovery, type KeePassConflictRecoveryInput } from './keepass-conflict-recovery';
import type { KeePassConflictRecoveryStorage } from './keepass-conflict-recovery-store';
import { resolveKeePassProjectConflicts, type KeePassProjectConflictChoice } from './keepass-remote-rebase';
import { openKeePassVault } from './keepass-vault';
import { openKeePassDurableReceipt, sealKeePassDurableReceipt } from './keepass-receipt-crypto';
import type { KeePassDurableMutationReceipt, KeePassWorkingCopyStorage } from './keepass-working-copy-store';
import type { KeePassWebDavSnapshot } from './keepass-webdav-client';

export interface KeePassProjectResolutionRequest { operationId: string; reviewToken: string; choices: KeePassProjectConflictChoice[] }
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const choicesKey = (choices: KeePassProjectConflictChoice[]) => JSON.stringify(choices.map(row => ({ projectId: row.projectId, choice: row.choice })).sort((a, b) => a.projectId.localeCompare(b.projectId)));
const stale = () => new Error('KeePass 冲突预览或密码源已变化，请重新核对。');
export const keePassProjectResolutionRequestHash = (request: KeePassProjectResolutionRequest) => digest(new TextEncoder().encode(JSON.stringify({
  operationId: request.operationId, reviewToken: request.reviewToken, choices: choicesKey(request.choices) })));

/** Native file transaction only. The caller must flush live edits and hold its
 * provider mutation queue; exclusive must be the remote-session persistence queue.
 * Vault adoption and remote publication are separate recoverable steps.
 */
export class KeePassProjectResolutionService {
  constructor(private readonly storage: KeePassWorkingCopyStorage, private readonly recovery: KeePassConflictRecoveryStorage,
    private readonly readRemote: (account: ProviderAccount, signal?: AbortSignal) => Promise<KeePassWebDavSnapshot>,
    private readonly exclusive: <T>(providerId: string, task: () => Promise<T>) => Promise<T>) {}

  /** Keep the file persistence lock until the encrypted vault records cancellation.
   * A failed receipt read is never evidence that the file was not committed. */
  async withUncommitted<T>(input: ProviderAccount, requestInput: KeePassProjectResolutionRequest, cancel: (requestHash: string) => Promise<T>): Promise<T> {
    const account = structuredClone(input), request = structuredClone(requestInput);
    const requestHash = await keePassProjectResolutionRequestHash(request);
    return this.exclusive(account.id, async () => {
      if (await this.storage.readReceipt(account.id, request.operationId))
        throw new Error('冲突解决文件已经提交，请继续接纳结果。');
      const record = await this.storage.read(account.id);
      let capsule: KeePassConflictRecoveryInput | undefined;
      try {
        if (!record || await digest(record.baseBytes) !== record.baseSha256 || await digest(record.workingBytes) !== record.workingSha256)
          throw new Error('无法核对工作副本，已保留冲突解决记录。');
        const encrypted = await this.recovery.read(account.id, request.operationId);
        if (encrypted) {
          capsule = await openKeePassConflictRecovery(account, encrypted);
          if (capsule.reviewToken !== request.reviewToken || choicesKey(capsule.choices) !== choicesKey(request.choices)
            || !sameProviderBinding(account, capsule.source) || account.config.databaseId !== capsule.source.config.databaseId) throw stale();
        }
        return await cancel(requestHash);
      } finally {
        record?.baseBytes.fill(0); record?.workingBytes.fill(0);
        if (capsule) for (const bytes of Object.values(capsule.files)) bytes.fill(0);
      }
    });
  }

  async resolve(input: ProviderAccount, requestInput: KeePassProjectResolutionRequest, signal?: AbortSignal): Promise<KeePassDurableMutationReceipt> {
    const account = structuredClone(input), request = structuredClone(requestInput);
    if (!account.enabled || account.kind !== 'keepass' || !['webdav', 'onedrive'].includes(String(account.config.sourceMode))
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.operationId) || !/^[a-f0-9]{64}$/.test(request.reviewToken)
      || !Array.isArray(request.choices) || !request.choices.length || request.choices.length > 1000
      || request.choices.some(row => !row || typeof row.projectId !== 'string' || !row.projectId || !['local', 'remote'].includes(row.choice))
      || new Set(request.choices.map(row => row.projectId)).size !== request.choices.length) throw stale();
    const intentSha256 = await keePassProjectResolutionRequestHash(request);
    return this.exclusive(account.id, async () => {
      signal?.throwIfAborted();
      let capsule: KeePassConflictRecoveryInput | undefined;
      let record: Awaited<ReturnType<KeePassWorkingCopyStorage['read']>> = undefined;
      let snapshot: KeePassWebDavSnapshot | undefined, keyFile: Uint8Array | undefined;
      try {
        let encrypted = await this.recovery.read(account.id, request.operationId);
        if (encrypted) capsule = await openKeePassConflictRecovery(account, encrypted);
        if (capsule && (capsule.reviewToken !== request.reviewToken || choicesKey(capsule.choices) !== choicesKey(request.choices)
          || !sameProviderBinding(account, capsule.source) || account.config.databaseId !== capsule.source.config.databaseId)) throw stale();
        const storedReceipt = await this.storage.readReceipt(account.id, request.operationId);
        if (storedReceipt) {
          const receipt = await openKeePassDurableReceipt(account, storedReceipt);
          if (!capsule || !encrypted || receipt.kind !== 'project-resolve' || receipt.result.type !== 'project-resolve'
            || receipt.intentSha256 !== intentSha256 || receipt.result.recoveryIntentTag !== encrypted.intentTag
            || receipt.result.reviewToken !== request.reviewToken || receipt.result.resolvedSha256 !== await digest(capsule.files.resolved)) throw stale();
          return receipt;
        }
        record = await this.storage.read(account.id);
        if (!record) throw stale();
        if (!capsule) {
          snapshot = await this.readRemote(account, signal);
          const version: KeePassConflictRevision = { revision: record.revision, baseSha256: await digest(record.baseBytes),
            workingSha256: await digest(record.workingBytes), remoteSha256: await digest(snapshot.bytes), remoteEtag: snapshot.etag || '' };
          if (version.baseSha256 !== record.baseSha256 || version.workingSha256 !== record.workingSha256 || version.remoteSha256 !== snapshot.sha256
            || await keePassConflictReviewToken(account, version) !== request.reviewToken) throw stale();
          keyFile = typeof account.config.keyFile === 'string' ? base64ToBytes(account.config.keyFile) : undefined;
          const options = { password: String(account.config.databasePassword ?? ''), keyFile, providerId: account.id, databaseId: Number(account.config.databaseId) };
          const base = await openKeePassVault(record.baseBytes, options), working = await openKeePassVault(record.workingBytes, options), remote = await openKeePassVault(snapshot.bytes, options);
          const resolved = resolveKeePassProjectConflicts(base.database, working.database, remote.database, request.choices);
          capsule = { operationId: request.operationId, reviewToken: request.reviewToken, createdAt: new Date().toISOString(), source: account,
            choices: request.choices, review: version, files: { base: record.baseBytes.slice(), working: record.workingBytes.slice(),
              remote: snapshot.bytes.slice(), resolved: new Uint8Array(await resolved.database.save()) } };
          signal?.throwIfAborted();
          encrypted = await this.recovery.create(await sealKeePassConflictRecovery(account, capsule));
        }
        if (!capsule.review || !encrypted || await keePassConflictReviewToken(account, capsule.review) !== request.reviewToken
          || record.revision !== capsule.review.revision || record.baseSha256 !== capsule.review.baseSha256 || record.workingSha256 !== capsule.review.workingSha256
          || await digest(record.baseBytes) !== capsule.review.baseSha256 || await digest(record.workingBytes) !== capsule.review.workingSha256) throw stale();
        // Recheck after saving recovery: a peer could have changed the file during preparation.
        snapshot?.bytes.fill(0); snapshot = await this.readRemote(account, signal);
        if (snapshot.etag !== capsule.review.remoteEtag || snapshot.sha256 !== capsule.review.remoteSha256
          || await digest(snapshot.bytes) !== capsule.review.remoteSha256) throw stale();
        const resolvedSha256 = await digest(capsule.files.resolved);
        const receipt: KeePassDurableMutationReceipt = { providerId: account.id, operationId: request.operationId, kind: 'project-resolve',
          intentSha256, completedAt: new Date().toISOString(), result: { type: 'project-resolve', reviewToken: request.reviewToken,
            recoveryIntentTag: encrypted.intentTag, baseSha256: capsule.review.remoteSha256, resolvedSha256 } };
        const sealedReceipt = await sealKeePassDurableReceipt(account, receipt);
        signal?.throwIfAborted();
        const saved = await this.storage.save({ providerId: account.id, baseBytes: capsule.files.remote, workingBytes: capsule.files.resolved,
          baseSha256: capsule.review.remoteSha256, workingSha256: resolvedSha256, baseEtag: capsule.review.remoteEtag,
          baseLastModified: snapshot.lastModified, updatedAt: receipt.completedAt }, record.revision, sealedReceipt);
        saved.baseBytes.fill(0); saved.workingBytes.fill(0);
        return receipt;
      } finally {
        record?.baseBytes.fill(0); record?.workingBytes.fill(0); snapshot?.bytes.fill(0); keyFile?.fill(0);
        if (capsule) for (const bytes of Object.values(capsule.files)) bytes.fill(0);
      }
    });
  }
}
