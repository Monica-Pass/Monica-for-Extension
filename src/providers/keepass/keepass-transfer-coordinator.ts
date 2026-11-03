import type { ProviderAccount, VaultItem, VaultState } from '../../core/model';
import { normalizeKeePassTransferRequest, readKeePassTransfers, assertKeePassTransferBindings, keePassTransferSnapshotHash,
  keePassTransferResult, type KeePassTransferIntent, type KeePassTransferRequest } from '../../core/keepass-transfer-journal';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { mdbx2TransferDependencies } from '../mdbx2/mdbx2-transfer-dependencies';
import type { Mdbx2BatchTransferRequest, Mdbx2BatchTransferPlanResult, Mdbx2BatchTransferExecuteResult, Mdbx2BatchTransferProgressListener } from '../mdbx2/mdbx2-batch-transfer-coordinator';
import type { SecureVaultService } from '../../security/secure-vault-service';
import type { KeePassProvider } from './keepass-provider';
import type { KeePassLocalWorkingCopyService } from './keepass-local-working-copy';
import type { KeePassWorkingCopyStorage } from './keepass-working-copy-store';
import { keePassTransferRequestHash, type KeePassTransferDraft, type KeePassTransferRow } from './keepass-transfer-file';
import { passkeyAvailability } from '../../passkey/source-policy';
import { inspectPasskeyKey } from '../../passkey/capability';

type Vault = Pick<SecureVaultService, 'readState' | 'stageKeePassTransfer' | 'cancelUnwrittenKeePassTransfer' | 'applyProviderSync'>;
type Persistence = Pick<KeePassLocalWorkingCopyService, 'persistTransfer' | 'readAnyDurableReceipt'>;
interface Dependencies {
  ensure(account: ProviderAccount): Promise<unknown>;
  reload(account: ProviderAccount): Promise<unknown>;
  publish(account: ProviderAccount, signal?: AbortSignal): Promise<Record<string, unknown>>;
  persistence(account: ProviderAccount): Persistence;
  resource(state: VaultState, item: VaultItem, preserveCategories: boolean): Promise<KeePassTransferRow>;
  exclusive<T>(providerId: string, work: () => Promise<T>): Promise<T>;
}
type SavedPlan = { intent: KeePassTransferIntent; draft: KeePassTransferDraft; timer: ReturnType<typeof setTimeout> };

/** Shared transfer contract. A journal precedes the file write; file publication
 * and current-state adoption finish before a terminal result is acknowledged. */
export class KeePassTransferCoordinator {
  private plans = new Map<string, SavedPlan>();
  private generation = 0;
  private publication = new AbortController();
  constructor(private readonly vault: Vault, private readonly provider: KeePassProvider,
    private readonly storage: KeePassWorkingCopyStorage, private readonly dependencies: Dependencies) {}
  clear() {
    this.generation++; this.publication.abort(); this.publication = new AbortController();
    for (const row of this.plans.values()) clearTimeout(row.timer); this.plans.clear();
  }

  async pending(providerId: string) {
    return readKeePassTransfers((await this.vault.readState(false)).keepassTransfers)
      .filter(row => row.target.id === providerId && row.status === 'writing')
      .map(row => ({ request: row.request, plan: row.plan }));
  }

  async plan(input: Mdbx2BatchTransferRequest): Promise<Mdbx2BatchTransferPlanResult> {
    const request = normalizeKeePassTransferRequest(input), generation = this.generation;
    return this.dependencies.exclusive(request.targetProviderId, async () => {
      const state = await this.vault.readState(false), target = this.target(state, request);
      if (readKeePassTransfers(state.keepassTransfers).some(row => row.target.id === target.id && row.status === 'writing'))
        throw new Error('此 KeePass 数据库还有未完成的传输，请先恢复。');
      const snapshotHash = await keePassTransferSnapshotHash(state, request);
      await this.dependencies.ensure(target);
      const dependency = mdbx2TransferDependencies(request.itemIds, state.items, request.action);
      const selected = state.items.filter(row => dependency.selectedIds.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id));
      const rows: KeePassTransferRow[] = [], blocked = new Map<string, string>(), warnings: string[] = [];
      const sourceAccounts = state.providers.filter(account => selected.some(item => item.providerRefs.some(ref => ref.providerId === account.id)));
      for (const item of selected) {
        try {
          if (request.action === 'move' && (item.providerRefs.length !== 1 || item.providerRefs[0].providerId !== target.id || !item.keepassEntryUuid))
            throw new Error('此来源的跨库移动仍需持久删除恢复，请先使用复制。');
          if (item.kind === 'opaque') throw new Error('此原生项目类型尚不能完整写入 KeePass。');
          if (request.action === 'copy' && item.kind === 'passkey') {
            if (passkeyAvailability(item) !== 'ready' || await inspectPasskeyKey(item.privateKeyPkcs8, item.algorithm) !== 'usable')
              throw new Error('此 Passkey 缺少可用私钥或仅原设备可用，来源已保留。');
            if (item.backupEligible === false || item.signCount > 0 || item.algorithm !== -7)
              warnings.push(`Passkey「${item.title}」跨端受限：原始算法、注册标志和计数保持不变。`);
          }
          const row = await this.dependencies.resource(state, item, request.preserveCategories);
          if (!request.preserveCategories) delete row.folder;
          rows.push(row);
        } catch (cause) { blocked.set(item.id, message(cause)); }
        this.assertGeneration(generation);
      }
      for (const component of dependency.components) {
        const reason = component.map(id => blocked.get(id)).find(Boolean);
        if (reason) component.forEach(id => blocked.set(id, reason));
      }
      const accepted = rows.filter(row => !blocked.has(row.source.id));
      const targetGroupUuid = request.targetCollectionId ? this.provider.groupUuidForHandle(target.id, request.targetCollectionId) : undefined;
      const draft: KeePassTransferDraft = { operationId: request.operationId, createdAt: request.operationCreatedAt,
        action: request.action, targetGroupUuid, rows: accepted };
      const record = await this.storage.read(target.id);
      if (!record) throw new Error('KeePass 工作副本不存在，请重新连接。');
      try {
        if (accepted.length) {
          // Exactly one whole-file preparation, not one expensive KDF per item.
          const result = await this.provider.prepareTransferFile(target, draft, { bytes: record.workingBytes, expectedSha256: record.workingSha256 });
          result.bytes.fill(0);
        }
        const targetName = request.targetCollectionId ? this.groupLabel(target, request.targetCollectionId) : [];
        const plan: Mdbx2BatchTransferPlanResult = { ...request, items: selected.map(item => ({ sourceItemId: item.id, title: item.title,
          kind: item.kind, effectiveAction: request.action, blockedReason: blocked.get(item.id), pathIncomplete: false,
          sourcePath: rows.find(row => row.source.id === item.id)?.folder?.segments || [],
          targetPath: [...targetName, ...(request.preserveCategories ? rows.find(row => row.source.id === item.id)?.folder?.segments || [] : [])] })),
          blockedCount: blocked.size, transferableCount: accepted.length, requiresMoveConfirmation: request.action === 'move' && accepted.length > 0, warnings };
        const intent: KeePassTransferIntent = { version: 1, request, requestHash: await hash(request), target: structuredClone(target), sourceAccounts,
          plan, snapshotHash, inputSha256: record.workingSha256, inputContentSha256: await this.provider.transferNativeContentHash(target),
          fileIntentSha256: await keePassTransferRequestHash(target, { expectedWorkingSha256: record.workingSha256, draft }), status: 'writing' };
        const current = await this.vault.readState(false);
        assertKeePassTransferBindings(current, intent);
        if (snapshotHash !== await keePassTransferSnapshotHash(current, request)) throw new Error('生成预览期间项目已变化，请重试。');
        this.assertGeneration(generation);
        const old = this.plans.get(request.operationId); if (old) clearTimeout(old.timer);
        while (!this.plans.has(request.operationId) && this.plans.size >= 4) {
          const first = this.plans.keys().next().value!; clearTimeout(this.plans.get(first)!.timer); this.plans.delete(first);
        }
        const timer = setTimeout(() => this.plans.delete(request.operationId), 5 * 60_000);
        if (typeof timer === 'object') timer.unref?.();
        this.plans.set(request.operationId, { intent, draft, timer });
        return structuredClone(plan);
      } finally { record.baseBytes.fill(0); record.workingBytes.fill(0); }
    });
  }

  async execute(input: Mdbx2BatchTransferRequest, progress?: Mdbx2BatchTransferProgressListener): Promise<Mdbx2BatchTransferExecuteResult> {
    if (!input.operationId || !input.operationCreatedAt) throw new Error('请先生成传输预览。');
    const request = normalizeKeePassTransferRequest(input), requestHash = await hash(request), generation = this.generation;
    const signal = this.publication.signal;
    return this.dependencies.exclusive(request.targetProviderId, async () => {
      this.assertGeneration(generation);
      const state = await this.vault.readState(false), target = this.target(state, request);
      let intent = readKeePassTransfers(state.keepassTransfers).find(row => row.request.operationId === request.operationId);
      if (intent && (intent.requestHash !== requestHash || intent.status === 'cancelled')) throw new Error('传输请求与原计划不一致或已取消。');
      if (intent) assertKeePassTransferBindings(state, { target: intent.target, sourceAccounts: [] });
      if (intent?.status === 'completed') return intent.result!;
      if (request.action === 'move' && !input.confirmed) throw new Error('移动项目需要明确确认。');
      const persistence = this.dependencies.persistence(target);
      let receipt = await persistence.readAnyDurableReceipt(target, request.operationId);
      if (!receipt) {
        const saved = this.plans.get(request.operationId);
        if (!saved || saved.intent.requestHash !== requestHash || !saved.intent.plan.transferableCount)
          throw new Error('传输尚未写入且预览已过期，请取消此未写入操作后重新预览。');
        assertKeePassTransferBindings(state, saved.intent);
        if (saved.intent.snapshotHash !== await keePassTransferSnapshotHash(state, request)) throw new Error('预览后项目已变化，请重新预览。');
        // Re-authenticate attachment readback and native fields before committing.
        const refreshed: KeePassTransferDraft = { ...saved.draft, rows: [] };
        for (const before of saved.draft.rows) {
          const item = state.items.find(row => row.id === before.source.id)!;
          const row = await this.dependencies.resource(state, item, request.preserveCategories);
          if (!request.preserveCategories) delete row.folder;
          refreshed.rows.push(row);
        }
        if (saved.intent.fileIntentSha256 !== await keePassTransferRequestHash(target, { expectedWorkingSha256: saved.intent.inputSha256, draft: refreshed }))
          throw new Error('来源字段、附件或文件夹在预览后已变化。');
        this.assertGeneration(generation);
        intent = await this.vault.stageKeePassTransfer(saved.intent);
        this.assertGeneration(generation);
        progress?.(this.progress(intent, 'writing'));
        receipt = await persistence.persistTransfer(target, { expectedWorkingSha256: intent.inputSha256, draft: refreshed });
      }
      if (!intent) throw new Error('文件回执缺少已确认的传输记录。');
      keePassTransferResult(intent, receipt);
      this.assertGeneration(generation);
      progress?.(this.progress(intent, 'finalizing'));
      // Reload the current file, never replace it with old receipt snapshots.
      await this.dependencies.ensure(target);
      this.assertGeneration(generation);
      const checkpoint = await this.storage.read(target.id);
      if (!checkpoint) throw new Error('KeePass 工作副本不存在。');
      try { await this.provider.assertTransferReload(target, checkpoint.workingBytes, intent.inputContentSha256); }
      finally { checkpoint.baseBytes.fill(0); checkpoint.workingBytes.fill(0); }
      this.assertGeneration(generation);
      await this.dependencies.reload(target);
      const beforePublish = await this.vault.readState(false);
      assertKeePassTransferBindings(beforePublish, { target: intent.target, sourceAccounts: [] });
      this.assertGeneration(generation);
      const accountConfig = await this.dependencies.publish(this.target(beforePublish, request), signal);
      this.assertGeneration(generation);
      const latest = await this.vault.readState(false);
      const current = this.target(latest, request);
      assertKeePassTransferBindings(latest, { target: intent.target, sourceAccounts: [] });
      const known = new Set(latest.items.map(row => row.id));
      const receiptItems = receipt.result.type === 'batch-transfer' ? receipt.result.snapshotItems : [];
      const identities = [...latest.items, ...receiptItems.filter(row => !known.has(row.id))];
      const refreshed = await this.provider.refreshFromSession(current, identities, new Date().toISOString());
      const queued = latest.mutationQueue.filter(row => row.providerId === target.id), queuedIds = new Set(queued.map(row => row.itemId));
      const local = new Map(latest.items.map(row => [row.id, row]));
      const items = refreshed.items.map(row => queuedIds.has(row.id) ? local.get(row.id)! : row);
      const incoming = new Set(items.map(row => row.id));
      items.push(...latest.items.filter(row => queuedIds.has(row.id) && !incoming.has(row.id)));
      this.assertGeneration(generation);
      const config = { ...accountConfig, ...(current.config.oneDriveConnection ? { oneDriveConnection: current.config.oneDriveConnection } : {}) };
      await this.vault.applyProviderSync(target.id, items, { ...refreshed.accountPatch, config }, refreshed.conflicts,
        refreshed.sourceRecords, latest.items, [], [], true, queued.map(row => row.id), { expectedAccount: current, keePassTransfer: receipt });
      const result = keePassTransferResult(intent, receipt);
      const saved = this.plans.get(request.operationId); if (saved) clearTimeout(saved.timer); this.plans.delete(request.operationId);
      progress?.({ ...this.progress(intent, 'completed'), processed: intent.plan.items.length, completedCount: result.completedCount });
      return result;
    });
  }

  async cancel(providerId: string, operationId: string) {
    return this.dependencies.exclusive(providerId, async () => {
      const state = await this.vault.readState(false), intent = readKeePassTransfers(state.keepassTransfers).find(row => row.request.operationId === operationId);
      if (!intent || intent.target.id !== providerId || intent.status !== 'writing') throw new Error('待恢复传输不存在。');
      assertKeePassTransferBindings(state, { target: intent.target, sourceAccounts: [] });
      const target = this.target(state, intent.request);
      if (await this.dependencies.persistence(target).readAnyDurableReceipt(target, operationId)) throw new Error('文件已保存，请恢复传输结果，不能取消。');
      await this.vault.cancelUnwrittenKeePassTransfer(operationId);
    });
  }
  private target(state: VaultState, request: KeePassTransferRequest) {
    const target = state.providers.find(row => row.id === request.targetProviderId);
    if (!target?.enabled || target.kind !== 'keepass') throw new Error('目标 KeePass 不可用。');
    return target;
  }
  private assertGeneration(generation: number) { if (generation !== this.generation) throw new Error('密码库已锁定，传输已中止；已保存内容可恢复。'); }
  private groupLabel(account: ProviderAccount, handle: string): string[] {
    let cursor: string | undefined;
    do { const page = this.provider.listGroups(account, { cursor, pageSize: 100 });
      const row = page.items.find(row => row.groupId === handle); if (row) return [row.displayPath]; cursor = page.nextCursor;
    } while (cursor);
    throw new Error('目标 KeePass 文件夹已变化。');
  }
  private progress(intent: KeePassTransferIntent, phase: 'writing' | 'finalizing' | 'completed') {
    return { operationId: intent.request.operationId, phase, processed: 0, total: intent.plan.items.length,
      completedCount: 0, blockedCount: intent.plan.blockedCount, failedCount: 0 };
  }
}
function message(error: unknown) { return error instanceof Error ? error.message : '来源无法完整读取。'; }
