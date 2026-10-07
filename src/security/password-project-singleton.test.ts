import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderKind } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const projectId = '00000000-0000-4000-8000-000000000001';
const row = (index: number, kind: ProviderKind): LoginItem => ({
  ...createLoginItem({ title: 'Singleton project', username: 'shared', password: `password-${index}` }),
  passwordGroupId: projectId, notes: '  notes\r\nkept  ',
  providerRefs: kind === 'local' ? [] : [{ providerId: kind, remoteId: `remote-${index}`, revision: 'revision' }],
  customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
    value: `{"version":1,"projectId":"${projectId}","groupId":"00000000-0000-4000-8000-000000000002","passwordId":"00000000-0000-4000-8000-00000000001${index}","label":"Account","primary":true,"groupOrder":0,"passwordOrder":${index},"future":9007199254740993}` }]
});
async function fixture(kind: ProviderKind, count = 1) {
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  const rows = Array.from({ length: count }, (_, index) => row(index, kind));
  await service.setup('synthetic singleton master password', rows);
  if (kind !== 'local') await service.upsertProvider({ id: kind, kind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} });
  return { storage, service, rows };
}
const versions = (rows: LoginItem[]) => Object.fromEntries(rows.map(item => [item.id, item.updatedAt]));

describe('complete password project saves including a single remaining row', () => {
  it.each(['local', 'mdbx2', 'monica-webdav', 'bitwarden', 'keepass'] as const)('saves and reopens an explicit singleton on %s with exact metadata and update intent', async kind => {
    const { service, rows: [original] } = await fixture(kind);
    const [saved] = await service.savePasswordGroup([{ ...original, title: 'Edited singleton' }], versions([original]));
    expect(saved).toEqual({ ...original, title: 'Edited singleton', updatedAt: saved.updatedAt });
    expect(saved.updatedAt > original.updatedAt).toBe(true);
    const state = await service.readState();
    expect(state.mutationQueue).toEqual(kind === 'local' ? [] : [expect.objectContaining({ itemId: original.id, providerId: kind, operation: 'update' })]);
    await service.lock();
    expect((await service.unlock('synthetic singleton master password')).items).toEqual([saved]);
  });

  it('rejects a singleton draft when another row has arrived, without changing storage or queue', async () => {
    const { service, storage, rows } = await fixture('mdbx2');
    await service.upsertItem(row(1, 'mdbx2'));
    const before = await service.readState(), envelope = JSON.stringify(storage.envelope);
    await expect(service.savePasswordGroup([{ ...rows[0], notes: 'stale' }], versions(rows))).rejects.toThrow('成员已变化');
    expect(await service.readState()).toEqual(before); expect(JSON.stringify(storage.envelope)).toBe(envelope);
  });

  it('rejects an omitted snapshot member even after that member was independently detached', async () => {
    const { service, storage, rows } = await fixture('local', 3);
    await service.upsertItem({ ...rows[2], passwordGroupId: undefined }, undefined, rows[2].updatedAt);
    const before = await service.readState(), envelope = JSON.stringify(storage.envelope);
    await expect(service.savePasswordGroup(rows.slice(0, 2), versions(rows))).rejects.toThrow('成员已变化');
    expect(await service.readState()).toEqual(before); expect(JSON.stringify(storage.envelope)).toBe(envelope);
  });

  it('keeps a singleton and its queue unchanged when encrypted persistence fails', async () => {
    const { service, storage, rows } = await fixture('bitwarden');
    const before = await service.readState(), envelope = JSON.stringify(storage.envelope);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('synthetic persistence failure'));
    await expect(service.savePasswordGroup([{ ...rows[0], password: 'new password' }], versions(rows))).rejects.toThrow('synthetic persistence failure');
    expect(await service.readState()).toEqual(before); expect(JSON.stringify(storage.envelope)).toBe(envelope);
  });

  it('uses the complete snapshot when deleting a singleton and rejects a confirmation predating a new member', async () => {
    const { service, storage, rows } = await fixture('mdbx2');
    const added = await service.upsertItem(row(1, 'mdbx2')) as LoginItem;
    const before = await service.readState(), envelope = JSON.stringify(storage.envelope);
    await expect(service.deletePasswordGroup(rows[0].id, versions(rows))).rejects.toThrow('成员已变化');
    expect(await service.readState()).toEqual(before); expect(JSON.stringify(storage.envelope)).toBe(envelope);
    await service.deletePasswordGroup(rows[0].id, versions([...rows, added]));
    expect((await service.listDeletedItems()).map(item => item.id).sort()).toEqual([...rows, added].map(item => item.id).sort());
    const single = await fixture('local');
    await single.service.deletePasswordGroup(single.rows[0].id, versions(single.rows));
    expect((await single.service.listDeletedItems()).map(item => item.id)).toEqual([single.rows[0].id]);
  });

  it('still rejects zero rows, missing explicit membership and missing KeePass metadata', async () => {
    const { service, storage, rows } = await fixture('keepass');
    const before = JSON.stringify(storage.envelope);
    await expect(service.savePasswordGroup([], {})).rejects.toThrow();
    await expect(service.savePasswordGroup([{ ...rows[0], passwordGroupId: undefined }], versions(rows))).rejects.toThrow();
    await expect(service.savePasswordGroup([{ ...rows[0], customFields: [] }], versions(rows))).rejects.toThrow('显式分组');
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });
});
