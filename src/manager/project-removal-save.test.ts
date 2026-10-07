import { expect, it, vi } from 'vitest';
import { saveProjectRemoval, saveKeePassProjectRemoval } from './project-removal-save';
import type { KeePassProjectRemovalRequest, KeePassProjectRemovalStatus } from '../background/keepass-project-removal';
import type { PasswordProjectRemovalRequest, PasswordProjectRemovalStatus } from '../background/password-project-removal';

const request: PasswordProjectRemovalRequest = { operationId:crypto.randomUUID(), items:[], expected:{}, removedItemIds:[] };
const receipt = (status: PasswordProjectRemovalStatus['status']): PasswordProjectRemovalStatus => ({operationId:request.operationId,title:'Synthetic',status,retainedItemIds:[],removedItemIds:[],pendingRestoreItemIds:[],canCancel:false,supported:true});
it.each(['completed','cancelled'] as const)('settles %s after response loss without issuing another removal', async status => {
  const client = {removePasswordProjectMembers:vi.fn().mockRejectedValue(new Error('Connection lost')),listPasswordProjectRemovals:vi.fn().mockResolvedValue([receipt(status)])};
  expect(await saveProjectRemoval(client,request)).toEqual(receipt(status));
  expect(client.removePasswordProjectMembers).toHaveBeenCalledExactlyOnceWith(request,true);
  expect(client.listPasswordProjectRemovals).toHaveBeenCalledExactlyOnceWith(request.operationId);
});
it.each([{rows:[]},{rows:[receipt('preparing')]},{rows:[receipt('restoring')]}])('does not interpret absent or unfinished receipts as failed staging', async ({rows}) => {
  const error = new Error('Unknown');
  const client = {removePasswordProjectMembers:vi.fn().mockRejectedValue(error),listPasswordProjectRemovals:vi.fn().mockResolvedValue(rows)};
  await expect(saveProjectRemoval(client,request)).rejects.toBe(error);
});
it('preserves the original failure if receipt lookup is also unavailable', async () => {
  const error = new Error('Unknown');
  const client = {removePasswordProjectMembers:vi.fn().mockRejectedValue(error),listPasswordProjectRemovals:vi.fn().mockRejectedValue(new Error('Read failed'))};
  await expect(saveProjectRemoval(client,request)).rejects.toBe(error);
});

const keepassRequest: KeePassProjectRemovalRequest = { operationId: crypto.randomUUID(), sourceToken: 'old-editor-token',
  draft: { providerId: 'kp', anchorItemId: 'anchor', originals: [], items: [], removedItemIds: ['anchor'] } };
const keepassReceipt = (status: KeePassProjectRemovalStatus['status']): KeePassProjectRemovalStatus => ({ operationId: keepassRequest.operationId,
  providerId: 'kp', title: 'Synthetic', status, canCancel: status === 'staged', localAdoptionCompleted: status === 'completed', removedItemIds: ['anchor'] });
it.each(['staged', 'writing'] as const)('resumes an existing KeePass %s operation without submitting the expired editor token', async status => {
  const client = { listKeePassProjectRemovals: vi.fn().mockResolvedValue([keepassReceipt(status)]),
    resumeKeePassProjectRemoval: vi.fn().mockResolvedValue(keepassReceipt('completed')), removeKeePassProjectMembers: vi.fn() };
  expect(await saveKeePassProjectRemoval(client, keepassRequest)).toEqual(keepassReceipt('completed'));
  expect(client.removeKeePassProjectMembers).not.toHaveBeenCalled();
  expect(client.resumeKeePassProjectRemoval).toHaveBeenCalledExactlyOnceWith(keepassRequest.operationId);
});
it('recovers a lost KeePass save response by reading its completed receipt', async () => {
  const client = { listKeePassProjectRemovals: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([keepassReceipt('completed')]),
    resumeKeePassProjectRemoval: vi.fn(), removeKeePassProjectMembers: vi.fn().mockRejectedValue(new Error('lost response')) };
  expect(await saveKeePassProjectRemoval(client, keepassRequest)).toEqual(keepassReceipt('completed'));
  expect(client.removeKeePassProjectMembers).toHaveBeenCalledExactlyOnceWith(keepassRequest, true);
});
it('never starts a new KeePass removal when its prior status cannot be read', async () => {
  const client = { listKeePassProjectRemovals: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
    resumeKeePassProjectRemoval: vi.fn(), removeKeePassProjectMembers: vi.fn() };
  await expect(saveKeePassProjectRemoval(client, keepassRequest)).rejects.toThrow('lookup unavailable');
  expect(client.removeKeePassProjectMembers).not.toHaveBeenCalled();
});
