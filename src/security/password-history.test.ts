import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem } from '../core/model';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const unlock = 'synthetic password history vault';
async function fixture() {
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup(unlock);
  const item = await service.upsertItem(createLoginItem({ title: 'History', password: 'first' })) as LoginItem;
  return { service, storage, item };
}

describe('password history transactions', () => {
  it('deletes one indexed historical value while preserving current password and equal duplicate rows', async () => {
    const { service, storage } = await fixture();
    const row = { password: 'same', lastUsedAt: new Date(0).toISOString() };
    const item = await service.upsertItem({ ...createLoginItem({ title: 'Duplicates', password: 'current' }), passwordHistory: [row, row] }) as LoginItem;
    const saved = await service.deletePasswordHistory(item.id, 1, item.updatedAt);
    expect(saved.password).toBe('current'); expect(saved.passwordHistory).toEqual([row]);
    const before = structuredClone(storage.envelope);
    await expect(service.deletePasswordHistory(item.id, 0, item.updatedAt)).rejects.toThrow(/历史已变化/);
    expect(storage.envelope).toEqual(before);
    const empty = await service.deletePasswordHistory(item.id, 0, saved.updatedAt);
    expect(empty.passwordHistory).toEqual([]);
    const changed = await service.upsertItem({ ...empty, password: 'next' }) as LoginItem;
    expect(changed.passwordHistory).toEqual([{ password: 'current', lastUsedAt: changed.updatedAt }]);
  });

  it('does not change history on failed persistence, invalid index, lock or deleted item', async () => {
    const { service, storage, item } = await fixture();
    const current = await service.upsertItem({ ...item, password: 'next' }) as LoginItem;
    const before = structuredClone(storage.envelope);
    for (const index of [-1, 0.5, 3, NaN]) await expect(service.deletePasswordHistory(item.id, index, current.updatedAt)).rejects.toThrow();
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic delete failure'));
    await expect(service.deletePasswordHistory(item.id, 0, current.updatedAt)).rejects.toThrow('Synthetic delete failure');
    expect(storage.envelope).toEqual(before);
    await service.lock();
    await expect(service.deletePasswordHistory(item.id, 0, current.updatedAt)).rejects.toThrow();
    await service.unlock(unlock); await service.deleteItem(item.id);
    await expect(service.deletePasswordHistory(item.id, 0, current.updatedAt)).rejects.toThrow();
  });
  it('captures every change before sync, including reused passwords, and survives encrypted restart', async () => {
    const { service, storage, item } = await fixture();
    let current = item;
    for (const password of ['second', 'first', 'third']) {
      const previous = current;
      current = await service.upsertItem({ ...current, password }, undefined, current.updatedAt) as LoginItem;
      expect(current.passwordHistory?.[0]).toEqual({ password: previous.password, lastUsedAt: current.updatedAt });
    }
    expect(current.passwordHistory?.map(row => row.password)).toEqual(['first', 'second', 'first']);
    const unchanged = await service.upsertItem({ ...current, notes: 'new notes' }) as LoginItem;
    expect(unchanged.passwordHistory).toEqual(current.passwordHistory);
    await service.lock();
    const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await reopened.unlock(unlock);
    expect(await reopened.getItem(item.id)).toEqual(unchanged);
    expect(JSON.stringify(storage.envelope)).not.toContain('second');
  });

  it('captures current data rather than a stale draft history and refuses a stale checked edit', async () => {
    const { service, storage, item } = await fixture();
    const second = await service.upsertItem({ ...item, password: 'second' }) as LoginItem;
    const third = await service.upsertItem({ ...item, password: 'third' }) as LoginItem;
    expect(third.passwordHistory?.map(row => row.password)).toEqual(['second', 'first']);
    const before = structuredClone(storage.envelope);
    await expect(service.upsertItem({ ...second, password: 'stale' }, undefined, second.updatedAt)).rejects.toThrow();
    expect(storage.envelope).toEqual(before);
  });

  it('commits independent member histories and provider intents in one group write', async () => {
    const { service, storage, item } = await fixture();
    const provider = { id: 'source', kind: 'monica-webdav' as const, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} };
    await service.upsertProvider(provider);
    const first = await service.upsertItem({ ...item, passwordGroupId: 'project', providerRefs: [{ providerId: provider.id }] }) as LoginItem;
    const second = await service.upsertItem({ ...createLoginItem({ title: 'Other', password: 'other' }), passwordGroupId: 'project', providerRefs: first.providerRefs }) as LoginItem;
    const write = vi.spyOn(storage, 'write'); write.mockClear();
    const result = await service.savePasswordGroup([{ ...first, password: 'new first' }, { ...second, password: 'new other' }], { [first.id]: first.updatedAt, [second.id]: second.updatedAt });
    expect(write).toHaveBeenCalledTimes(1);
    expect(result[0].passwordHistory).toEqual([{ password: 'first', lastUsedAt: result[0].updatedAt }]);
    expect(result[1].passwordHistory).toEqual([{ password: 'other', lastUsedAt: result[1].updatedAt }]);
    expect((await service.readState()).mutationQueue.filter(row => row.providerId === provider.id)).toHaveLength(2);
  });

  it('retains history and password on persistence failure, then captures exactly once on retry', async () => {
    const { service, storage, item } = await fixture();
    const before = structuredClone(storage.envelope);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic failure'));
    await expect(service.upsertItem({ ...item, password: 'second' })).rejects.toThrow('Synthetic failure');
    expect(storage.envelope).toEqual(before);
    expect(await service.getItem(item.id)).toEqual(item);
    const result = await service.upsertItem({ ...item, password: 'second' }) as LoginItem;
    expect(result.passwordHistory).toEqual([{ password: 'first', lastUsedAt: result.updatedAt }]);
  });

  it('preserves imported histories longer than Android retention and does not snapshot a blank password', async () => {
    const { service } = await fixture();
    const imported = Array.from({ length: 20 }, (_, index) => ({ password: `old ${index}`, lastUsedAt: new Date(index).toISOString(), future: index }));
    const item = await service.upsertItem({ ...createLoginItem({ title: 'Imported', password: 'current' }), passwordHistory: imported }) as LoginItem;
    expect(item.passwordHistory).toEqual(imported);
    const result = await service.upsertItem({ ...item, password: '' }) as LoginItem;
    expect(result.passwordHistory?.slice(1)).toEqual(imported);
    const next = await service.upsertItem({ ...result, password: 'new' }) as LoginItem;
    expect(next.passwordHistory).toEqual(result.passwordHistory);
  });
});
