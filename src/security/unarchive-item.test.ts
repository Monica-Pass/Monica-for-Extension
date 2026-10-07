import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type VaultItem, type ProviderKind } from '../core/model';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const password = 'synthetic archive lifecycle password';
function archived() {
  return { ...createLoginItem({ title: 'Archived account', password: 'synthetic', notes: 'original' }),
    archivedAt: '2026-01-01T00:00:00Z' };
}
async function fixture() {
  const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const row = archived();
  await service.setup(password, [row]);
  return { service, storage, row };
}
const requestUnarchive = (service: SecureVaultService, row: VaultItem) => service.unarchiveItem(row.id, row.updatedAt);

describe('versioned archive lifecycle', () => {
  it('refuses a stale unarchive after another window edited the item', async () => {
    const { service, storage, row } = await fixture();
    await service.upsertItem({ ...row, notes: 'later edit', password: 'later password' });
    const before = JSON.stringify(storage.envelope);
    await expect(requestUnarchive(service, row)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('does not resurrect a record deleted before unarchive reached the service', async () => {
    const { service, storage, row } = await fixture();
    await service.deleteItem(row.id);
    const before = JSON.stringify(storage.envelope);
    await expect(requestUnarchive(service, row)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it.each(['local', 'mdbx2', 'monica-webdav', 'keepass', 'bitwarden'] satisfies ProviderKind[])(
    'unarchives only the selected record and commits its %s intent with current fields', async kind => {
      const { service, storage, row } = await fixture();
      await service.upsertProvider({ id: 'source', kind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} });
      const member = await service.upsertItem({ ...row, passwordGroupId: 'group', providerRefs: [{ providerId: 'source' }],
        totpSecret: 'otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=9007199254740993',
        customFields: [{ name: 'future data', value: '  9007199254740993\r\n', protected: true }], email: 'new@example.test' });
      const other = await service.upsertItem({ ...member, id: 'other-group-member' });
      const state = await service.readState();
      const write = vi.spyOn(storage, 'write'); write.mockClear();
      const current = await requestUnarchive(service, member);
      expect(write).toHaveBeenCalledTimes(1);
      expect({ ...current, updatedAt: member.updatedAt }).toEqual({ ...member, archivedAt: undefined });
      expect(Date.parse(current.updatedAt)).toBeGreaterThan(Date.parse(member.updatedAt));
      expect(await service.getItem(other.id)).toEqual(other);
      const after = await service.readState();
      expect(after.mutationQueue.filter(mutation => mutation.itemId === other.id)).toEqual(state.mutationQueue.filter(mutation => mutation.itemId === other.id));
      expect(after.mutationQueue.filter(mutation => mutation.itemId === member.id)).toHaveLength(kind === 'local' ? 0 : 1);
      await service.lock();
      const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore());
      await reopened.unlock(password);
      expect(await reopened.getItem(member.id)).toEqual(current);
      const envelope = JSON.stringify(storage.envelope);
      await requestUnarchive(reopened, current);
      expect(JSON.stringify(storage.envelope)).toBe(envelope);
    });

  it('keeps the archived data and original queue after storage failure and permits a retry', async () => {
    const { service, storage, row } = await fixture();
    const state = await service.readState(), before = JSON.stringify(storage.envelope);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic disk failure'));
    await expect(requestUnarchive(service, row)).rejects.toThrow('Synthetic disk failure');
    expect(JSON.stringify(storage.envelope)).toBe(before);
    expect(await service.readState()).toEqual(state);
    expect((await requestUnarchive(service, row)).archivedAt).toBeUndefined();
  });

  it('rejects missing, malformed and locked requests without changing storage', async () => {
    const { service, storage, row } = await fixture();
    const before = JSON.stringify(storage.envelope);
    await expect(service.unarchiveItem('missing', row.updatedAt)).rejects.toThrow();
    await expect(service.unarchiveItem(row.id, '')).rejects.toThrow();
    await service.lock();
    await expect(requestUnarchive(service, row)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('leaves a pending project removal and its archived records untouched', async () => {
    const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const rows = [0, 1].map(index => ({ ...archived(), passwordGroupId: 'group',
      providerRefs: [{ providerId: 'source', remoteId: `remote-${index}` }],
      customFields: [{ name: 'monica.content.credential', protected: true, value: JSON.stringify({ version: 1,
        groupId: '00000000-0000-0000-0000-000000000001', passwordId: `00000000-0000-0000-0000-00000000001${index}`,
        label: 'Account', primary: true, groupOrder: 0, passwordOrder: index }) }] }));
    await service.setup(password, rows);
    await service.upsertProvider({ id: 'source', kind: 'monica-webdav', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} });
    const [first, second] = rows;
    const result = await service.stagePasswordProjectRemoval({ operationId: crypto.randomUUID(), items: [first, second],
      expected: { [first.id]: first.updatedAt, [second.id]: second.updatedAt }, removedItemIds: [second.id] });
    expect(result.removal?.status).not.toBe('completed');
    const latest = (await service.getItem(first.id))!;
    const before = JSON.stringify(storage.envelope);
    await expect(requestUnarchive(service, latest)).rejects.toThrow('待处理');
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('refuses provider conflicts without discarding the archived local version', async () => {
    const { service, storage, row } = await fixture();
    await service.upsertProvider({ id: 'source', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} });
    const item = await service.upsertItem({ ...row, providerRefs: [{ providerId: 'source' }] });
    await service.applyProviderSync('source', [item], undefined, [{ itemId: item.id, reason: 'Conflict', local: item, remote: { ...item, notes: 'remote change' } }]);
    expect(await service.getItem(item.id)).toEqual(item);
    const before = JSON.stringify(storage.envelope);
    await expect(requestUnarchive(service, item)).rejects.toThrow('待处理');
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });
});
