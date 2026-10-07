import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderKind } from '../core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../core/project-credentials';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultStorage } from '../security/vault-storage';
import { PasswordProjectRemovalWorkflow, PasswordProjectRemovalNotStagedError } from './password-project-removal';
import { ProviderOperationQueue } from './provider-operation-queue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(kind: ProviderKind = 'mdbx2') {
  const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  const group = crypto.randomUUID(), credential = crypto.randomUUID();
  const rows: LoginItem[] = [0, 1, 2].map(index => ({ ...createLoginItem({ title: 'Project', username: 'private-account', password: `private-password-${index}` }),
    passwordGroupId: group, providerRefs: [{ providerId: kind, remoteId: `remote-${index}`, remoteFolderId: 'folder', revision: 'commit' }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, value: JSON.stringify({ version: 1, projectId: group, groupId: credential,
      passwordId: crypto.randomUUID(), label: 'Group', primary: true, groupOrder: 0, passwordOrder: index }), protected: true }] }));
  await vault.setup('Synthetic workflow master password', rows);
  await vault.upsertProvider({ id: kind, kind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: 'handle', nativeVaultId: 'vault', password: 'private-provider-secret' } });
  const items = await vault.listItems() as LoginItem[];
  const input = { operationId: crypto.randomUUID(), items, expected: Object.fromEntries(items.map(row => [row.id, row.updatedAt])), removedItemIds: [items[0].id] };
  const queue = new ProviderOperationQueue(), changed = vi.fn();
  const removal = { resume: vi.fn(async () => (await vault.readPasswordProjectRemovals())[0]) };
  const restore = { restore: vi.fn() };
  const workflow = new PasswordProjectRemovalWorkflow(vault, removal, restore, queue, changed);
  return { vault, input, queue, removal, restore, workflow, changed };
}

it.each(['keepass', 'monica-webdav', 'bitwarden'] as const)('rejects unsupported %s before any draft/journal write even with incoming references omitted', async kind => {
  const f = await fixture(kind), before = await f.vault.readState();
  await expect(f.workflow.stage({ ...f.input, items: f.input.items.map(row => ({ ...row, providerRefs: [] })) })).rejects.toThrow('目前支持');
  expect(await f.vault.readState()).toEqual(before); expect(f.removal.resume).not.toHaveBeenCalled();
});

it('lists recoverable operations without disclosing passwords or saved provider secrets, then cancels', async () => {
  const f = await fixture();
  f.removal.resume.mockRejectedValue(new Error('Synthetic remote interruption'));
  await expect(f.workflow.stage(f.input)).rejects.toThrow('remote interruption');
  const pending = await f.workflow.pending();
  expect(pending).toEqual([expect.objectContaining({ operationId: f.input.operationId, status: 'preparing', canCancel: true, supported: true,
    removedItemIds: f.input.removedItemIds, providerId: 'mdbx2' })]);
  expect(JSON.stringify(pending)).not.toContain('private-');
  expect(f.changed).toHaveBeenCalled();
  expect((await f.workflow.cancel(f.input.operationId)).status).toBe('cancelled');
  expect(await f.workflow.pending()).toEqual([]);
  expect(await f.workflow.pending(f.input.operationId)).toEqual([expect.objectContaining({status:'cancelled'})]);
  expect(await f.workflow.pending(crypto.randomUUID())).toEqual([]);
  await expect(f.workflow.pending('')).rejects.toThrow('标识无效');
  expect(await f.vault.listDeletedItems()).toEqual([]);
});

it('allows draft editing only after a rejected stage has no durable receipt', async () => {
  const f = await fixture();
  const stale = { ...f.input, expected: { ...f.input.expected, [f.input.items[0].id]: 'stale' } };
  await expect(f.workflow.stage(stale)).rejects.toBeInstanceOf(PasswordProjectRemovalNotStagedError);
  expect(await f.workflow.pending()).toEqual([]);
  const pendingError = new Error('Native preparation failed');
  f.removal.resume.mockRejectedValue(pendingError);
  await expect(f.workflow.stage(f.input)).rejects.toBe(pendingError);
  expect(await f.workflow.pending(f.input.operationId)).toHaveLength(1);
  await expect(f.workflow.stage({...f.input, removedItemIds:[f.input.items[1].id]})).rejects.not.toBeInstanceOf(PasswordProjectRemovalNotStagedError);
});

it('keeps stage outcome unknown when journal readback fails', async () => {
  const f = await fixture();
  const writeError = new Error('Storage result unknown');
  vi.spyOn(f.vault, 'stagePasswordProjectRemoval').mockRejectedValue(writeError);
  vi.spyOn(f.vault, 'readPasswordProjectRemovals').mockRejectedValue(new Error('Read failed'));
  await expect(f.workflow.stage(f.input)).rejects.toBe(writeError);
});

it('queues a new removal after failed sync without blocking another source', async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  const sync = f.queue.run('mdbx2', async () => { started.resolve(); await release.promise; throw new Error('Synthetic sync failure'); });
  const expectedFailure = expect(sync).rejects.toThrow('sync failure');
  await started.promise;
  const stage = f.workflow.stage(f.input);
  await f.queue.run('independent', async () => undefined);
  expect(await f.vault.readPasswordProjectRemovals()).toEqual([]);
  release.resolve(); await expectedFailure;
  expect((await stage).status).toBe('preparing'); expect(f.removal.resume).toHaveBeenCalledOnce();
});

it('rechecks source replacement before a queued draft can be saved', async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  const sync = f.queue.run('mdbx2', async () => { started.resolve(); await release.promise; });
  await started.promise;
  const stage = f.workflow.stage(f.input), failed = expect(stage).rejects.toThrow('密码源已变化');
  // Allow the request to capture its original source while the write queue remains held.
  await f.queue.run('independent', async () => undefined);
  const account = (await f.vault.getProvider('mdbx2'))!;
  await f.vault.upsertProvider({ ...account, config: { ...account.config, vaultHandle: 'replacement' } });
  release.resolve(); await sync; await failed;
  expect(await f.vault.readPasswordProjectRemovals()).toEqual([]);
});

it('allows cancellation while the source queue is held by preparation', async () => {
  const f = await fixture(), started = deferred(), release = deferred();
  f.removal.resume.mockImplementation(async () => { started.resolve(); await release.promise; return (await f.vault.readPasswordProjectRemovals())[0]; });
  const stage = f.workflow.stage(f.input); await started.promise;
  expect((await f.workflow.cancel(f.input.operationId)).status).toBe('cancelled');
  release.resolve(); expect((await stage).status).toBe('cancelled');
  expect(await f.workflow.pending()).toEqual([]);
});

it('runs local removal without any native coordinator call', async () => {
  const f = await fixture('local');
  expect((await f.workflow.stage(f.input)).status).toBe('completed');
  expect(await f.vault.listDeletedItems()).toHaveLength(1);
  expect(f.removal.resume).not.toHaveBeenCalled();
  expect(await f.workflow.pending()).toEqual([]);
});
