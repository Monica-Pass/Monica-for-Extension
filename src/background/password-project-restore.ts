import { mdbx2RestoreBatchSources, readMdbx2RestoreBatchRequest, type Mdbx2RestoreBatchRequest, type Mdbx2RestoreBatchRecord } from '../core/mdbx2-restore-batch-journal';
import type { VaultItem } from '../core/model';
import type { SecureVaultService } from '../security/secure-vault-service';
import { ProviderOperationQueue } from './provider-operation-queue';
import { readKeePassProjectRestoreRequest, type KeePassProjectRestoreRequest, type KeePassProjectRestoreReceipt } from '../core/keepass-project-restore';

export type PasswordProjectRestoreRequest = Mdbx2RestoreBatchRequest | KeePassProjectRestoreRequest;

export interface PasswordProjectRestoreStatus {
  operationId: string;
  providerId: string;
  title: string;
  memberIds: string[];
  status: 'prepared' | 'completed';
  /** KeePass has durably queued the local restore; remote publication is a separate sync. */
  queued?: true;
}
export class PasswordProjectRestoreNotStagedError extends Error {
  readonly code = 'password-project-restore-not-staged';
}
export class PasswordProjectRestoreWorkflow {
  constructor(private readonly vault: SecureVaultService,
    private readonly restore: { restoreProject(anchorItemId: string, request: Mdbx2RestoreBatchRequest): Promise<VaultItem[]>; resume(operationId: string): Promise<VaultItem[]> },
    private readonly queue: ProviderOperationQueue, private readonly changed: () => void = () => undefined) {}

  async pending(operationId?: string): Promise<PasswordProjectRestoreStatus[]> {
    if (operationId !== undefined) validId(operationId);
    const batches=(await this.vault.readMdbx2RestoreBatches()).filter(row => operationId !== undefined ? row.id === operationId : row.status === 'prepared').map(describe);
    if(operationId===undefined)return batches;
    const cancellations=(await this.vault.readMdbx2DeletionCancellations()).filter(row=>row.request.operationId===operationId).map(row=>({
      operationId:row.request.operationId,providerId:row.request.providerId,title:row.title,memberIds:Object.keys(row.request.expected),status:'completed' as const}));
    if(batches.length && cancellations.length)throw new Error('恢复操作标识冲突，原始记录已保留。');
    const keepass = (await this.vault.readKeePassProjectRestores()).filter(row => row.request.operationId === operationId).map(describeKeePass);
    if (batches.length + cancellations.length + keepass.length > 1) throw new Error('恢复操作标识冲突，原始记录已保留。');
    return [...batches,...cancellations,...keepass];
  }

  async start(input: PasswordProjectRestoreRequest): Promise<PasswordProjectRestoreStatus> {
    if ('backend' in input && input.backend === 'keepass') {
      const request = readKeePassProjectRestoreRequest(input);
      return this.queue.run(request.providerId, async () => {
        try {
          // Reject namespace reuse before any encrypted state changes.
          const prior = await this.pending(request.operationId);
          if (prior.some(row => !row.queued)) throw new Error('恢复操作标识已用于其他范围。');
          return describeKeePass(await this.vault.restoreKeePassPasswordProject(request));
        } catch (cause) {
          const records = await this.pending(request.operationId).catch(() => undefined);
          if (records && !records.length)
            throw new PasswordProjectRestoreNotStagedError(cause instanceof Error ? cause.message : '恢复未开始。');
          throw cause;
        } finally { this.changed(); }
      });
    }
    if ('backend' in input) throw new Error('恢复密码源类型无效。');
    const request = readMdbx2RestoreBatchRequest(input);
    return this.queue.run(request.providerId, async () => {
      try {
        if ((await this.vault.readKeePassProjectRestores()).some(row => row.request.operationId === request.operationId))
          throw new Error('恢复操作标识已用于其他范围。');
        await this.restore.restoreProject(request.anchorItemId, request);
        const [receipt] = await this.pending(request.operationId);
        if (!receipt) throw new Error('恢复结果尚未确认，请保留原操作并重试。');
        return receipt;
      } catch (cause) {
        // This source queue has settled. Absence outside this boundary proves nothing.
        const records = await this.pending(request.operationId).catch(() => undefined);
        if (records && !records.length)
          throw new PasswordProjectRestoreNotStagedError(cause instanceof Error ? cause.message : '恢复未开始。');
        throw cause;
      } finally { this.changed(); }
    });
  }

  async resume(operationId: string): Promise<PasswordProjectRestoreStatus> {
    validId(operationId);
    const keepass = (await this.vault.readKeePassProjectRestores()).find(row => row.request.operationId === operationId);
    if (keepass) return describeKeePass(keepass);
    const record = (await this.vault.readMdbx2RestoreBatches()).find(row => row.id === operationId);
    const cancellation=!record && (await this.vault.readMdbx2DeletionCancellations()).find(row=>row.request.operationId===operationId);
    const providerId=record?.members[0].provider.id || cancellation && cancellation.request.providerId;
    if (!providerId) throw new Error('找不到密码恢复操作。');
    return this.queue.run(providerId, async () => {
      try {
        await this.restore.resume(operationId);
        const [receipt] = await this.pending(operationId);
        if (!receipt) throw new Error('恢复结果尚未确认，请重试。');
        return receipt;
      } finally { this.changed(); }
    });
  }
}
function validId(value: string) {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error('密码恢复操作标识无效。');
}
function describe(record: Mdbx2RestoreBatchRecord): PasswordProjectRestoreStatus {
  return { operationId: record.id, providerId: record.members[0].provider.id, title: record.members[0].source.title,
    memberIds: mdbx2RestoreBatchSources(record).map(row => row.id), status: record.status };
}
function describeKeePass(record: KeePassProjectRestoreReceipt): PasswordProjectRestoreStatus {
  return { operationId: record.request.operationId, providerId: record.request.providerId, title: record.title,
    memberIds: record.request.restoreIds, status: 'completed', queued: true };
}
