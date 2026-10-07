import { expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { deletedPasswordCohort, projectRestoreRequest, saveProjectRestore } from './project-restore';
const providers: ProviderAccount[] = [{ id: 'native', name: 'Native', kind: 'mdbx2', enabled: true, isDefaultSaveTarget: false, config: {} }];
function items() { return [0, 1].map(n => ({ ...createLoginItem({ title: `Password ${n}` }), passwordGroupId: 'group', deletedAt: '2026-10-01T00:00:00.000Z', providerRefs: [{ providerId: 'native' }] })); }
it('selects exactly the deleted cohort without older removals or another source', () => {
  const rows = items(), old = { ...rows[0], id: 'old', deletedAt: '2026-09-01T00:00:00.000Z' };
  const other = { ...rows[0], id: 'other', providerRefs: [{ providerId: 'other' }] }, active = { ...rows[0], id: 'active', deletedAt: undefined };
  const selected = deletedPasswordCohort(rows[0], [...rows, old, other, active], providers);
  expect(selected.map(row => row.id).sort()).toEqual(rows.map(row => row.id).sort());
  expect(deletedPasswordCohort(rows[0], [...rows, old, active], [{ ...providers[0], kind: 'keepass' }]).map(row => row.id).sort()).toEqual([...rows, old].map(row => row.id).sort());
  expect(projectRestoreRequest(selected, rows[0].id).expected).toEqual(Object.fromEntries(rows.map(row => [row.id, row.updatedAt])));
});
it.each(['completed', 'prepared', 'absent', 'read-failed'] as const)('recovers only a terminal matching receipt after response loss: %s', async status => {
  const rows = items(), request = projectRestoreRequest(rows, rows[0].id), error = new Error('Response lost');
  const receipt = { operationId: request.operationId, providerId: 'native', title: 'Synthetic', memberIds: rows.map(row => row.id), status: status === 'completed' ? 'completed' as const : 'prepared' as const };
  const client = { restorePasswordProject: vi.fn().mockRejectedValue(error), listPasswordProjectRestores: vi.fn().mockResolvedValue(status === 'absent' ? [] : [receipt]) };
  if (status === 'read-failed') client.listPasswordProjectRestores.mockRejectedValue(new Error('Read failed'));
  if (status === 'completed') expect(await saveProjectRestore(client, request)).toEqual(receipt);
  else await expect(saveProjectRestore(client, request)).rejects.toBe(error);
  expect(client.restorePasswordProject).toHaveBeenCalledExactlyOnceWith(request, true);
});
it('counts active members toward the KeePass transaction limit before exposing the dialog', () => {
  const rows = items();
  const active = Array.from({ length: 99 }, (_, n) => ({ ...rows[0], id: `active-${n}`, deletedAt: undefined }));
  expect(deletedPasswordCohort(rows[0], [...rows, ...active], [{ ...providers[0], kind: 'keepass' }])).toEqual([]);
  expect(deletedPasswordCohort(rows[0], [...rows, ...active.slice(1)], [{ ...providers[0], kind: 'keepass' }])).toHaveLength(2);
});
