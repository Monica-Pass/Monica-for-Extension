import { sameProviderBinding } from '../core/provider';
import { planKeePassProjectRemoval } from '../core/keepass-project-removal';
import { keePassRemovalFileRequestHash, type KeePassProjectRemovalIntent } from '../core/keepass-project-removal-journal';
import type { SecureVaultService } from '../security/secure-vault-service';
import type { KeePassRemoteSessionService } from '../providers/keepass/keepass-remote-session';
import { isRemoteKeePassSource } from '../providers/keepass/keepass-source';
import { ProviderOperationQueue } from './provider-operation-queue';
import { PasswordProjectRemovalNotStagedError } from './password-project-removal';
import type { KeePassProjectRemovalDraft } from '../core/keepass-project-removal';

export interface KeePassProjectRemovalRequest {
  operationId: string;
  sourceToken: string;
  draft: KeePassProjectRemovalDraft;
}

/** Manager-safe status. Local completion does not claim remote publication. */
export interface KeePassProjectRemovalStatus {
  operationId: string;
  providerId: string;
  title: string;
  status: KeePassProjectRemovalIntent['status'];
  canCancel: boolean;
  localAdoptionCompleted: boolean;
  removedItemIds: string[];
}

export interface KeePassRemovalLifecycle {
  runMutationExclusive<T>(providerId: string, task: () => Promise<T>): Promise<T>;
  beforeCapture(source: KeePassProjectRemovalIntent['source']): Promise<void>;
  invalidateSession(providerId: string): void;
}

/** Coordinates encrypted intent, native working-file commit and local adoption.
 * Production lifecycle hooks serialize native mutations, persist live edits
 * before capture and invalidate the old session after an attempted file commit.
 */
export class KeePassProjectRemovalWorkflow {
  constructor(private readonly vault: SecureVaultService, private readonly remote: KeePassRemoteSessionService,
    private readonly queue: ProviderOperationQueue, private readonly changed: () => void = () => undefined,
    private readonly lifecycle?: KeePassRemovalLifecycle) {}

  async stage(input: Parameters<SecureVaultService['stageKeePassProjectRemoval']>[0]): Promise<KeePassProjectRemovalStatus> {
    const request = structuredClone(input);
    return this.queue.run(request.source.id, () => this.runMutation(request.source.id, async () => {
      return this.stageLocked(request);
    }));
  }

  /** Opaque, session-bound editor token. Passwords and key-file material never
   * leave the background; HMAC prevents guessing low-entropy source credentials.
   */
  async sourceToken(providerId: string): Promise<string> {
    const source = await this.vault.getProvider(providerId);
    if (!source) throw new Error('KeePass 密码源不存在。');
    return this.tokenForSource(source);
  }

  private async tokenForSource(source: KeePassProjectRemovalIntent['source']): Promise<string> {
    this.assertSupported(source);
    const sessionId = await this.vault.passkeySessionId();
    if (!sessionId) throw new Error('密码库已锁定，请重新打开编辑器。');
    const keys = ['sourceMode', 'databaseId', 'webDavBaseUrl', 'webDavUsername', 'webDavPassword', 'remotePath',
      'databasePassword', 'keyFile', 'oneDriveDriveId', 'oneDriveItemId'];
    const connection = source.config.oneDriveConnection as { id?: string; clientId?: string; profile?: { id?: string } } | undefined;
    const payload = JSON.stringify({ providerId: source.id, config: keys.map(key => [key, source.config[key]]),
      connection: [connection?.id, connection?.clientId, connection?.profile?.id] });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sessionId), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async stageFromManager(input: KeePassProjectRemovalRequest): Promise<KeePassProjectRemovalStatus> {
    const request = structuredClone(input);
    if (!request || !request.draft || !/^[a-f0-9]{64}$/.test(request.sourceToken)) throw new Error('请重新打开项目编辑器。');
    return this.queue.run(request.draft.providerId, () => this.runMutation(request.draft.providerId, async () => {
      try {
        const source = await this.vault.getProvider(request.draft.providerId);
        if (!source) throw new Error('KeePass 密码源不存在。');
        if (request.sourceToken !== await this.tokenForSource(source)) throw new Error('编辑期间密码源或解锁会话已变化，请重新打开项目。');
        return await this.stageLocked({ operationId: request.operationId, source, draft: request.draft });
      } catch (cause) {
        // Only release the editor's frozen request after a successful journal read
        // proves there is no durable operation. A lost write response is ambiguous.
        let intents;
        try { intents = await this.vault.readKeePassProjectRemovalIntents(); }
        catch { throw cause; }
        if (!intents.some(row => row.operationId === request.operationId))
          throw new PasswordProjectRemovalNotStagedError(cause instanceof Error ? cause.message : '保存失败，请重试。');
        throw cause;
      }
    }));
  }

  private async stageLocked(request: Parameters<SecureVaultService['stageKeePassProjectRemoval']>[0]) {
    this.assertSupported(request.source);
    const intent = await this.vault.stageKeePassProjectRemoval(request);
    this.changed();
    return this.resumeLocked(intent.operationId);
  }

  async resume(operationId: string): Promise<KeePassProjectRemovalStatus> {
    const intent = await this.record(operationId);
    return this.queue.run(intent.source.id, () => this.runMutation(intent.source.id, () => this.resumeLocked(operationId)));
  }

  async cancel(operationId: string): Promise<KeePassProjectRemovalStatus> {
    const intent = await this.record(operationId);
    return this.queue.run(intent.source.id, () => this.runMutation(intent.source.id, async () => {
      await this.vault.cancelKeePassProjectRemovalIntent(operationId);
      this.changed();
      return describe(await this.record(operationId));
    }));
  }

  async pending(operationId?: string): Promise<KeePassProjectRemovalStatus[]> {
    return (await this.vault.readKeePassProjectRemovalIntents())
      .filter(row => operationId ? row.operationId === operationId : row.status === 'staged' || row.status === 'writing').map(describe);
  }

  /** Called only while the outer provider-operation queue is already held. */
  async recoverProvider(providerId: string, signal?: AbortSignal): Promise<void> {
    return this.runMutation(providerId, async () => {
      const pending = (await this.vault.readKeePassProjectRemovalIntents()).filter(row => row.source.id === providerId
        && (row.status === 'staged' || row.status === 'writing'));
      for (const row of pending) { signal?.throwIfAborted(); await this.resumeLocked(row.operationId); }
      signal?.throwIfAborted();
    });
  }

  async assertProviderReady(providerId: string): Promise<void> {
    if ((await this.vault.readKeePassProjectRemovalIntents()).some(row => row.source.id === providerId
      && (row.status === 'staged' || row.status === 'writing')))
      throw new Error('此 KeePass 数据库有待恢复的项目移除，请先恢复或取消该操作。');
  }

  private runMutation<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    return this.lifecycle ? this.lifecycle.runMutationExclusive(providerId, task) : task();
  }

  private async resumeLocked(operationId: string): Promise<KeePassProjectRemovalStatus> {
    let intent = await this.record(operationId);
    if (intent.status === 'completed' || intent.status === 'cancelled') return describe(intent);
    let source = await this.currentSource(intent);
    if (intent.status === 'staged') {
      await this.lifecycle?.beforeCapture(source);
      source = await this.currentSource(intent);
      const config = await this.remote.reconcileAccountConfig(source);
      source = await this.currentSource(intent);
      intent = await this.vault.beginKeePassProjectRemoval(operationId, String(config.workingSha256 || ''));
      this.changed();
    }
    const request = { operationId, expectedWorkingSha256: intent.expectedWorkingSha256!, draft: intent.draft };
    const digest = await keePassRemovalFileRequestHash(intent.source, request);
    // A receipt may already exist after a crash. Read it before any source refresh
    // or write: regenerating the file could duplicate a newly created member.
    let receipt = await this.remote.readDurableReceipt(source, operationId, 'project-remove', digest);
    if (!receipt) {
      const state = await this.vault.readState();
      source = await this.currentSource(intent);
      planKeePassProjectRemoval(intent.draft, state.items, source);
      const ids = new Set(intent.draft.items.map(item => item.id));
      if (state.mutationQueue.some(row => ids.has(row.itemId)) || state.providerConflicts.some(row => ids.has(row.itemId)))
        throw new Error('项目出现后续修改或同步冲突，原密码尚未移除。');
      try { receipt = await this.remote.persistProjectRemoval(source, request); }
      finally { this.lifecycle?.invalidateSession(source.id); }
    } else {
      this.lifecycle?.invalidateSession(source.id);
    }
    await this.currentSource(intent);
    const completed = await this.vault.completeKeePassProjectRemoval(operationId, receipt);
    this.changed();
    return describe(completed);
  }

  private async record(operationId: string): Promise<KeePassProjectRemovalIntent> {
    const record = (await this.vault.readKeePassProjectRemovalIntents()).find(row => row.operationId === operationId);
    if (!record) throw new Error('找不到 KeePass 项目移除操作。');
    return record;
  }
  private assertSupported(source: KeePassProjectRemovalIntent['source']) {
    if (source.kind !== 'keepass' || !source.enabled || !isRemoteKeePassSource(source.config.sourceMode))
      throw new Error('此移除恢复流程需要已连接的远端 KeePass 工作副本。');
  }
  private async currentSource(intent: KeePassProjectRemovalIntent) {
    const current = await this.vault.getProvider(intent.source.id);
    if (!current || !sameProviderBinding(current, intent.source) || current.config.databaseId !== intent.source.config.databaseId)
      throw new Error('排队期间 KeePass 密码源已变化，请核对恢复操作。');
    this.assertSupported(current);
    return current;
  }
}

function describe(intent: KeePassProjectRemovalIntent): KeePassProjectRemovalStatus {
  return { operationId: intent.operationId, providerId: intent.source.id, title: intent.draft.originals[0]?.title || '',
    status: intent.status, canCancel: intent.status === 'staged', localAdoptionCompleted: intent.status === 'completed',
    removedItemIds: [...intent.draft.removedItemIds] };
}
