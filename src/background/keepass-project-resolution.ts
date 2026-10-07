import type { ProviderAccount } from '../core/model';
import { sameProviderBinding } from '../core/provider';
import { assertKeePassResolutionUnchanged, type KeePassProjectResolutionIntent } from '../core/keepass-project-resolution-journal';
import type { SecureVaultService } from '../security/secure-vault-service';
import { base64ToBytes } from '../security/encoding';
import { KeePassProvider } from '../providers/keepass/keepass-provider';
import type { KeePassRemoteSessionService } from '../providers/keepass/keepass-remote-session';
import type { KeePassWorkingCopyStorage } from '../providers/keepass/keepass-working-copy-store';
import type { KeePassConflictRecoveryStorage } from '../providers/keepass/keepass-conflict-recovery-store';
import { keePassProjectResolutionRequestHash, type KeePassProjectResolutionRequest } from '../providers/keepass/keepass-project-resolution';
import { isRemoteKeePassSource } from '../providers/keepass/keepass-source';
import { exportKeePassConflictRecovery } from '../providers/keepass/keepass-conflict-recovery-export';
import { ProviderOperationQueue } from './provider-operation-queue';

export interface KeePassResolutionLifecycle {
  runMutationExclusive<T>(providerId: string, task: () => Promise<T>): Promise<T>;
  beforeCapture(source: ProviderAccount): Promise<void>;
  beforeResolve(source: ProviderAccount): Promise<void>;
  invalidateSession(providerId: string): void;
}
export interface KeePassProjectResolutionStatus {
  operationId: string; providerId: string; status: KeePassProjectResolutionIntent['status'];
  canCancel: boolean; localAdoptionCompleted: boolean;
}
const describe = (intent: KeePassProjectResolutionIntent): KeePassProjectResolutionStatus => ({
  operationId: intent.request.operationId, providerId: intent.source.id, status: intent.status,
  canCancel: intent.status === 'staged' || intent.status === 'writing', localAdoptionCompleted: intent.status === 'completed'
});
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The manager supplies choices only. Projection is decoded here from the exact
 * committed KDBX, using a disposable provider that cannot reuse a stale session. */
export class KeePassProjectResolutionWorkflow {
  constructor(private readonly vault: SecureVaultService, private readonly remote: KeePassRemoteSessionService,
    private readonly files: KeePassWorkingCopyStorage, private readonly recovery: KeePassConflictRecoveryStorage,
    private readonly queue: ProviderOperationQueue, private readonly lifecycle: KeePassResolutionLifecycle,
    private readonly changed: () => void = () => undefined) {}

  private exclusive<T>(providerId: string, task: () => Promise<T>) {
    return this.queue.run(providerId, () => this.lifecycle.runMutationExclusive(providerId, task));
  }
  private async source(providerId: string) {
    const source = await this.vault.getProvider(providerId);
    if (!source || source.kind !== 'keepass' || !source.enabled || !isRemoteKeePassSource(source.config.sourceMode))
      throw new Error('冲突解决需要已连接的远端 KeePass 工作副本。');
    return source;
  }
  async review(providerId: string) {
    return this.exclusive(providerId, async () => {
      await this.assertProviderReady(providerId);
      await this.lifecycle.beforeCapture(await this.source(providerId));
      return this.remote.reviewProjectConflicts(await this.source(providerId));
    });
  }
  async resolve(providerId: string, input: KeePassProjectResolutionRequest) {
    const request = structuredClone(input);
    return this.exclusive(providerId, async () => {
      const existing = (await this.vault.readKeePassProjectResolutions()).find(row => row.request.operationId === request.operationId);
      if (existing) {
        if (existing.source.id !== providerId || await keePassProjectResolutionRequestHash(existing.request) !== await keePassProjectResolutionRequestHash(request))
          throw new Error('冲突解决操作标识已用于其他选择。');
        return this.resumeLocked(existing.request.operationId);
      }
      await this.assertProviderReady(providerId);
      // Flush only pending mutations. Re-serializing an unchanged KDBX here
      // randomizes its encryption and invalidates the just-reviewed version.
      await this.lifecycle.beforeResolve(await this.source(providerId));
      const source = await this.source(providerId), review = await this.remote.reviewProjectConflicts(source);
      if (review.reviewToken !== request.reviewToken || !Array.isArray(request.choices)
        || request.choices.length !== review.projects.length || new Set(request.choices.map(row => row.projectId)).size !== request.choices.length
        || request.choices.some(row => !review.projects.some(project => project.projectId === row.projectId) || !['local', 'remote'].includes(row.choice)))
        throw new Error('冲突预览或选择已变化，请重新核对。');
      const state = await this.vault.readState();
      await this.vault.stageKeePassProjectResolution({ source, request,
        originals: state.items.filter(item => item.providerRefs.some(ref => ref.providerId === providerId)) });
      this.changed();
      return this.resumeLocked(request.operationId);
    });
  }
  async pending(operationId?: string) {
    return (await this.vault.readKeePassProjectResolutions()).filter(row => operationId ? row.request.operationId === operationId
      : row.status === 'staged' || row.status === 'writing').map(describe);
  }
  async recoveryCopies(providerId: string) {
    await this.source(providerId);
    const intents = await this.vault.readKeePassProjectResolutions();
    return (await this.recovery.list(providerId)).map(row => {
      const intent = intents.find(candidate => candidate.source.id === providerId && candidate.request.operationId === row.operationId);
      return { ...row, canDelete: !!intent && (intent.status === 'completed' || intent.status === 'cancelled') };
    });
  }
  async deleteRecoveryCopy(providerId: string, operationId: string, expectedIntentTag: string) {
    return this.exclusive(providerId, async () => {
      await this.source(providerId);
      const intent = await this.record(operationId);
      if (intent.source.id !== providerId || !['completed', 'cancelled'].includes(intent.status))
        throw new Error('未完成的冲突处理仍需要此恢复副本，请先完成或取消操作。');
      const deleted = await this.recovery.delete(providerId, operationId, expectedIntentTag);
      this.changed(); return { deleted };
    });
  }
  async exportRecoveryCopy(providerId: string, operationId: string, expectedIntentTag: string, exportPassword: string) {
    return this.exclusive(providerId, async () => {
      const source = await this.source(providerId), copy = await this.recovery.read(providerId, operationId);
      if (!copy) throw new Error('找不到所选恢复副本。');
      const sessionId = await this.vault.passkeySessionId();
      if (!sessionId) throw new Error('密码库已锁定，请重新解锁后导出。');
      // Recovery exports are read-only and are available even while adoption is
      // pending. The existing vault/session check must succeed before export.
      const bytes = await exportKeePassConflictRecovery(source, copy, expectedIntentTag, exportPassword);
      try {
        const current = await this.source(providerId);
        if (!sessionId || sessionId !== await this.vault.passkeySessionId() || !sameProviderBinding(source, current)
          || source.config.databaseId !== current.config.databaseId) throw new Error('导出期间密码源或解锁会话已变化，请重试。');
        return bytes;
      }
      catch (cause) { bytes.fill(0); throw cause; }
    });
  }
  private async record(operationId: string) {
    const intent = (await this.vault.readKeePassProjectResolutions()).find(row => row.request.operationId === operationId);
    if (!intent) throw new Error('找不到冲突解决恢复记录。');
    return intent;
  }
  async resume(operationId: string) {
    const intent = await this.record(operationId);
    return this.exclusive(intent.source.id, () => this.resumeLocked(operationId));
  }
  async cancel(operationId: string) {
    const intent = await this.record(operationId);
    return this.exclusive(intent.source.id, async () => {
      const current = await this.record(operationId);
      if (current.status === 'cancelled') return describe(current);
      if (current.status === 'completed') throw new Error('冲突解决已完成。');
      const cancelled = current.status === 'staged' ? await this.vault.cancelKeePassProjectResolution(operationId)
        : await this.remote.withUncommittedProjectResolution(current.source, current.request, this.recovery,
          hash => this.vault.cancelUncommittedKeePassProjectResolution(operationId, hash));
      this.changed(); return describe(cancelled);
    });
  }
  async assertProviderReady(providerId: string) {
    if ((await this.vault.readKeePassProjectResolutions()).some(row => row.source.id === providerId && ['staged', 'writing'].includes(row.status)))
      throw new Error('此 KeePass 数据库有待恢复的冲突解决，请先继续或取消。');
  }
  /** Outer provider queue is already held by ordinary sync. */
  async recoverProvider(providerId: string, signal?: AbortSignal) {
    return this.lifecycle.runMutationExclusive(providerId, async () => {
      for (const row of (await this.vault.readKeePassProjectResolutions()).filter(row => row.source.id === providerId && ['staged', 'writing'].includes(row.status))) {
        signal?.throwIfAborted(); await this.resumeLocked(row.request.operationId, signal);
      }
    });
  }
  private async resumeLocked(operationId: string, signal?: AbortSignal): Promise<KeePassProjectResolutionStatus> {
    let intent = await this.record(operationId);
    if (intent.status === 'completed' || intent.status === 'cancelled') return describe(intent);
    const source = assertKeePassResolutionUnchanged(await this.vault.readState(), intent);
    if (intent.status === 'staged') {
      intent = await this.vault.beginKeePassProjectResolution(operationId); this.changed();
    }
    // The file service resolves receipts/recovery first. Never flush or restore
    // the previous live session once this operation has begun writing.
    let receipt;
    try { receipt = await this.remote.resolveProjectConflicts(source, intent.request, this.recovery, signal); }
    finally { this.lifecycle.invalidateSession(source.id); }
    if (receipt.result.type !== 'project-resolve') throw new Error('冲突解决回执类型无效。');
    const record = await this.files.read(source.id), projection = new KeePassProvider();
    let keyFile: Uint8Array | undefined;
    try {
      if (!record || record.workingSha256 !== receipt.result.resolvedSha256 || await digest(record.workingBytes) !== receipt.result.resolvedSha256)
        throw new Error('冲突解决文件已有后续变化，已保留恢复记录。');
      signal?.throwIfAborted();
      keyFile = typeof source.config.keyFile === 'string' ? base64ToBytes(source.config.keyFile) : undefined;
      await projection.unlock(source, record.workingBytes, { password: String(source.config.databasePassword ?? ''), keyFile,
        sourceMode: source.config.sourceMode as 'webdav' | 'onedrive', dirty: false });
      const result = await projection.refreshFromSession(source, intent.originals, receipt.completedAt);
      const config = await this.remote.reconcileAccountConfig(source);
      signal?.throwIfAborted();
      const completed = await this.vault.completeKeePassProjectResolution(operationId, { receipt, projectionSha256: record.workingSha256,
        items: result.items, sourceRecords: result.sourceRecords || [], accountPatch: { config } });
      this.changed(); return describe(completed);
    } finally { projection.lockAccount(source.id); keyFile?.fill(0); record?.baseBytes.fill(0); record?.workingBytes.fill(0); }
  }
}
