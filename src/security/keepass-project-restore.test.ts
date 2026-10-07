import { expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { keePassRestoreProject, readKeePassProjectRestoreRequest, type KeePassProjectRestoreRequest } from '../core/keepass-project-restore';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: { databaseId: 1 } };
async function fixture(active = false) {
  const rows = [0, 1, 2].map(n => ({ ...createLoginItem({ title: 'Project', username: 'shared', password: `secret-${n}`, providerRefs: [{ providerId: 'kp', remoteId: uuid(n + 10) }] }),
    passwordGroupId: uuid(1), keepassDatabaseId: 1, keepassEntryUuid: uuid(n + 10),
    updatedAt: `2026-10-01T0${n}:00:00.000Z`, deletedAt: active && n === 2 ? undefined : `2026-09-0${n + 1}T00:00:00.000Z`,
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId: uuid(1), groupId: uuid(2), passwordId: uuid(n + 10), label: 'Account', primary: true, groupOrder: 0, passwordOrder: n }) }] }));
  const independent = { ...rows[0], id: 'independent', passwordGroupId: undefined };
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const service = new SecureVaultService(storage, sessions);
  await service.setup('Synthetic local master', [...rows, independent]); await service.upsertProvider(account);
  const request: KeePassProjectRestoreRequest = { backend: 'keepass', operationId: uuid(90), providerId: 'kp', anchorItemId: rows[0].id,
    expected: Object.fromEntries(rows.map(row => [row.id, row.updatedAt])), restoreIds: rows.filter(row => row.deletedAt).map(row => row.id) };
  return { service, storage, sessions, rows, independent, request };
}

it('queues all native restorations in one commit across distinct deletion times; leaves active and unrelated rows exact', async () => {
  const f = await fixture(true), write = vi.spyOn(f.storage, 'write');
  expect(keePassRestoreProject(f.rows[0], [...f.rows, f.independent], [account])).toEqual([...f.rows].sort((a,b) => a.id.localeCompare(b.id)));
  const receipt = await f.service.restoreKeePassPasswordProject(f.request);
  expect(write).toHaveBeenCalledOnce();
  const state = await f.service.readState();
  expect(state.mutationQueue.map(row => row.itemId).sort()).toEqual([...f.request.restoreIds].sort());
  expect(state.mutationQueue.every(row => row.keepassRestore && row.operation === 'update')).toBe(true);
  for (const row of f.rows.slice(0, 2)) expect(state.items.find(item => item.id === row.id)).toEqual({ ...row, deletedAt: undefined, updatedAt: receipt.queuedAt });
  expect(state.items.find(item => item.id === f.rows[2].id)).toEqual(f.rows[2]);
  expect(state.items.find(item => item.id === f.independent.id)).toEqual(f.independent);
});

it.each(['stale', 'missing-active', 'missing-trash', 'bad-provider', 'duplicate-restore-id', 'extra-member'] as const)('rejects %s before encrypted persistence', async mode => {
  const f = await fixture(true), before = JSON.stringify(f.storage.envelope), input = structuredClone(f.request);
  if (mode === 'stale') input.expected[f.rows[2].id] = '2026-09-01T00:00:00Z';
  if (mode === 'missing-active') delete input.expected[f.rows[2].id];
  if (mode === 'missing-trash') input.restoreIds.pop();
  if (mode === 'bad-provider') input.providerId = 'other';
  if (mode === 'duplicate-restore-id') input.restoreIds.push(input.restoreIds[0]);
  if (mode === 'extra-member') input.expected[f.independent.id] = f.independent.updatedAt;
  await expect(f.service.restoreKeePassPasswordProject(input)).rejects.toThrow();
  expect(JSON.stringify(f.storage.envelope)).toBe(before);
});

it('survives response loss/restart without reapplying an old restoration after later deletion', async () => {
  const f = await fixture();
  const receipt = await f.service.restoreKeePassPasswordProject(f.request);
  await f.service.deleteItem(f.rows[0].id);
  const state = await f.service.readState(), envelope = JSON.stringify(f.storage.envelope);
  const restarted = new SecureVaultService(f.storage, new MemoryVaultSessionStore());
  await restarted.unlock('Synthetic local master');
  expect(await restarted.restoreKeePassPasswordProject(f.request)).toEqual(receipt);
  expect(await restarted.readKeePassProjectRestores()).toEqual([receipt]);
  expect((await restarted.readState()).items).toEqual(state.items);
  expect(JSON.stringify(f.storage.envelope)).toBe(envelope);
  await expect(restarted.restoreKeePassPasswordProject({ ...f.request, restoreIds: [f.rows[0].id] })).rejects.toThrow('标识');
});

it('retains every tombstone and queue on failed persistence, then permits the same request', async () => {
  const f = await fixture(), before = JSON.stringify(f.storage.envelope);
  vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('disk full'));
  await expect(f.service.restoreKeePassPasswordProject(f.request)).rejects.toThrow('disk full');
  expect(JSON.stringify(f.storage.envelope)).toBe(before);
  expect(await f.service.readKeePassProjectRestores()).toEqual([]);
  expect((await f.service.restoreKeePassPasswordProject(f.request)).request).toEqual(readKeePassProjectRestoreRequest(f.request));
});

it('does not restore conflicting old account metadata alongside current active members', async () => {
  const f = await fixture(true);
  await f.service.upsertItem({ ...f.rows[2], username: 'later account' });
  const state = await f.service.readState(), current = state.items.find(row => row.id === f.rows[2].id)!;
  f.request.expected[current.id] = current.updatedAt;
  const before = JSON.stringify(f.storage.envelope);
  await expect(f.service.restoreKeePassPasswordProject(f.request)).rejects.toThrow('凭据分组');
  expect(JSON.stringify(f.storage.envelope)).toBe(before);
});
