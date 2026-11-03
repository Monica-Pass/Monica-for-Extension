import { describe, expect, it, vi } from 'vitest';
import { LocalTransferCoordinator } from './local-transfer-coordinator';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { createLoginItem } from '../../core/model';
import type { Mdbx2BatchTransferRequest } from '../mdbx2/mdbx2-batch-transfer-coordinator';

async function setup() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), vault = new SecureVaultService(storage, sessions);
  const source = { ...createLoginItem({ title: 'Synthetic project', password: 'never expose this secret' }), passwordGroupId: '81111111-1111-4111-8111-111111111111' };
  await vault.setup('', [source, { ...source, id: crypto.randomUUID(), username: 'second' }]);
  const state = await vault.readState(), load = vi.fn().mockRejectedValue(new Error('synthetic source offline'));
  const coordinator = new LocalTransferCoordinator(vault, load);
  const input: Mdbx2BatchTransferRequest = { itemIds: [source.id], targetProviderId: state.providers[0].id, action: 'copy', preserveCategories: true };
  return { vault, storage, coordinator, load, input, source };
}

describe('local destination coordinator', () => {
  it('returns a secret-free group preview and restores completed results after coordinator restart', async () => {
    const { vault, coordinator, input, load } = await setup();
    try {
      const plan = await coordinator.plan(input), request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
      expect(plan.transferableCount).toBe(2); expect(JSON.stringify(plan)).not.toContain('never expose');
      const copied = await coordinator.execute(request); expect(copied.completedCount).toBe(2);
      coordinator.clear();
      const target = (await vault.getItem(copied.items[0].targetItemId!))!;
      await vault.upsertItem({ ...target, notes: 'later edit', deletedAt: new Date().toISOString() });
      const before = await vault.readState(), restarted = new LocalTransferCoordinator(vault, load);
      expect(await restarted.execute(request)).toEqual(copied);
      expect(await vault.readState()).toEqual(before);
      await expect(restarted.execute({ ...request, preserveCategories: false })).rejects.toThrow('原预览');
    } finally { coordinator.clear(); }
  });
  it('skips a complete blocked group and commits an unrelated selected project', async () => {
    const { vault, coordinator, input, source } = await setup();
    try {
      await vault.upsertProvider({ id: 'remote', name: 'Remote', kind: 'bitwarden', enabled: true, isDefaultSaveTarget: false, config: {} });
      const foreign = { ...createLoginItem({ title: 'Offline source' }), providerRefs: [{ providerId: 'remote', remoteId: 'cipher' }] };
      await vault.upsertItem(foreign);
      const selected = { ...input, itemIds: [source.id, foreign.id] }, plan = await coordinator.plan(selected);
      expect(plan.blockedCount).toBe(1); expect(plan.transferableCount).toBe(2);
      const result = await coordinator.execute({ ...selected, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt });
      expect(result.completedCount).toBe(2); expect(result.blockedCount).toBe(1);
      expect(await vault.getItem(foreign.id)).toMatchObject({ title: 'Offline source' });
    } finally { coordinator.clear(); }
  });
  it('fails atomically after a later source edit and never accepts a changed selection', async () => {
    const { vault, coordinator, input, source } = await setup();
    try {
      const plan = await coordinator.plan(input), request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
      await expect(coordinator.execute({ ...request, itemIds: [crypto.randomUUID()] })).rejects.toThrow('过期');
      await vault.upsertItem({ ...source, notes: 'new content' });
      const before = await vault.readState(), result = await coordinator.execute(request);
      expect(result.failedCount).toBe(2); expect(result.completedCount).toBe(0); expect(await vault.readState()).toEqual(before);
    } finally { coordinator.clear(); }
  });
  it('recovers a lost storage acknowledgement without creating another copy', async () => {
    const { vault, storage, coordinator, input } = await setup();
    try {
      const plan = await coordinator.plan(input), request = { ...input, operationId: plan.operationId, operationCreatedAt: plan.operationCreatedAt };
      const write = storage.write.bind(storage);
      vi.spyOn(storage, 'write').mockImplementationOnce(async value => { await write(value); throw new Error('synthetic response lost'); });
      expect((await coordinator.execute(request)).failedCount).toBe(2);
      expect((await coordinator.execute(request)).completedCount).toBe(2);
      expect(await vault.listItems()).toHaveLength(4);
    } finally { coordinator.clear(); }
  });
  it('keeps a bounded plan cache and cancels in-flight preparation on lock', async () => {
    const { vault, coordinator, input } = await setup();
    try {
      const first = await coordinator.plan(input);
      for (let i = 0; i < 5; i++) await coordinator.plan(input);
      await expect(coordinator.execute({ ...input, operationId: first.operationId, operationCreatedAt: first.operationCreatedAt })).rejects.toThrow('过期');
      const original = vault.prepareLocalTransfer.bind(vault);
      vi.spyOn(vault, 'prepareLocalTransfer').mockImplementation(async (...args) => { const result = await original(...args); coordinator.clear(); return result; });
      await expect(coordinator.plan(input)).rejects.toThrow('已锁定');
    } finally { coordinator.clear(); }
  });
});
