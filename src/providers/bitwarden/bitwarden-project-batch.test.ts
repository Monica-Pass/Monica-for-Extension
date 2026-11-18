import { expect, it } from 'vitest';
import { createLoginItem, type ProviderAccount } from '../../core/model';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { bytesToBase64 } from '../../security/encoding';
import { BitwardenProvider } from './bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from './bitwarden-durable-sync';

const master = 'Synthetic project batch vault password';
const stamp = '2026-10-09T00:00:00.000Z';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture(singles = 99) {
  let clock = Date.parse(stamp);
  const store = new MemoryVaultStorage();
  const vault = new SecureVaultService(store, new MemoryVaultSessionStore(), () => clock);
  const account: ProviderAccount = { id: 'batch-source', kind: 'bitwarden', name: 'Synthetic batch', enabled: true,
    isDefaultSaveTarget: false, config: { vaultUrl: 'https://batch.example.test', apiUrl: 'https://batch.example.test/api',
      identityUrl: 'https://batch.example.test/identity', email: 'batch@example.test', deviceId: 'synthetic',
      accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000,
      kdf: { type: 0, iterations: 100_000 }, vaultKeyEnc: bytesToBase64(new Uint8Array(32).fill(4)),
      vaultKeyMac: bytesToBase64(new Uint8Array(32).fill(8)) } };
  await vault.setup(master); await vault.upsertProvider(account);
  const independent = Array.from({ length: singles }, (_, n) => ({ ...createLoginItem({
    title: 'Same title', username: `single-${n}`, password: `synthetic-${n}`, providerRefs: [{ providerId: account.id }] }), id: `independent-${n}` }));
  if (independent.length) await vault.importItems(independent); clock += 1000;
  const project = [0, 1].map(n => ({ ...createLoginItem({ title: 'Same title', username: 'shared',
    password: `project-secret-${n}`, providerRefs: [{ providerId: account.id }] }), id: `project-${n}`, passwordGroupId: uuid(1),
    customFields: [{ name: 'monica.content.credential', protected: true, value: JSON.stringify({ version: 1, projectId: uuid(1),
      groupId: uuid(2), passwordId: uuid(10 + n), primary: true, groupOrder: 0, passwordOrder: n, label: 'Main' }) }] }));
  await vault.savePasswordGroup(project, {});
  const remote: Record<string, unknown>[] = [], requests: string[] = [];
  let loseResponseAt = -1;
  const fetcher: typeof fetch = async (url, input) => {
    if (String(url).includes('/sync')) return Response.json({ Profile: { Id: 'batch-user' }, Ciphers: remote });
    if (input?.method === 'POST' && String(url).endsWith('/ciphers')) {
      const raw = JSON.parse(String(input.body));
      const id = uuid(1000 + remote.length);
      const cipher = { ...raw, id, revisionDate: new Date(clock + requests.length + 1000).toISOString(), creationDate: stamp };
      remote.push(cipher); requests.push(id);
      if (requests.length === loseResponseAt) return new Response('{lost-response', { status: 200, headers: { 'Content-Type': 'application/json' } });
      return Response.json(cipher);
    }
    throw new Error(`Unexpected request ${input?.method} ${String(url)}`);
  };
  return { vault, store, account, project, remote, requests, fetcher, clock: () => clock, loseNextResponse: () => { loseResponseAt = requests.length + 1; } };
}

it('defers the complete project at a 100-item boundary and uploads both members after a vault/coordinator restart', async () => {
  const f = await fixture();
  const first = await new BitwardenDurableSyncCoordinator(new BitwardenProvider(f.fetcher), f.vault)
    .synchronize(f.account, undefined, { diagnosticStartedAt: f.clock() });
  expect(first.conflicts).toEqual([]);
  expect(f.requests).toHaveLength(99);
  expect(first.warnings.join(' ')).toContain('99');
  const remaining = await f.vault.readState();
  expect(remaining.providerDiagnostics[remaining.providerDiagnostics.length - 1]).toMatchObject({ warnings: first.warnings.length });
  expect(remaining.mutationQueue.map(row => row.itemId).sort()).toEqual(['project-0', 'project-1']);
  expect(remaining.providerMutationReceipts).toEqual([]);
  for (const original of f.project) expect(remaining.items.find(row => row.id === original.id)).toMatchObject({
    password: original.password, customFields: original.customFields, passwordGroupId: original.passwordGroupId });

  await f.vault.lock();
  const restored = new SecureVaultService(f.store, new MemoryVaultSessionStore(), f.clock); await restored.unlock(master);
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(f.fetcher), restored).synchronize(f.account);
  expect(f.requests).toHaveLength(101);
  expect((await restored.readState()).mutationQueue).toEqual([]);
  const fresh = await new BitwardenProvider(f.fetcher).sync(f.account, { now: stamp, localItems: [] });
  const members = fresh.items.filter(row => row.kind === 'login' && row.passwordGroupId === uuid(1));
  expect(members).toHaveLength(2);
  expect(members.map(row => row.kind === 'login' && row.password).sort()).toEqual(['project-secret-0', 'project-secret-1']);
  expect(fresh.items.filter(row => row.kind === 'login' && !row.passwordGroupId)).toHaveLength(99);
});

it('expands a targeted password sync to its queued project members without uploading same-title independent passwords', async () => {
  const f = await fixture(2);
  const before = await f.vault.readState();
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(f.fetcher), f.vault)
    .synchronize(f.account, undefined, { itemIds: [f.project[0].id] });
  expect(f.requests).toHaveLength(2);
  const after = await f.vault.readState();
  expect(after.mutationQueue.map(row => row.itemId).sort()).toEqual(['independent-0', 'independent-1']);
  for (const row of before.items.filter(row => row.id.startsWith('independent')))
    expect(after.items.find(item => item.id === row.id)).toEqual(row);
});

it('keeps project edits queued during a read-only refresh', async () => {
  const f = await fixture(0), before = await f.vault.readState();
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(f.fetcher), f.vault)
    .synchronize(f.account, undefined, { readOnly: true, itemIds: [f.project[0].id] });
  expect(f.requests).toEqual([]);
  expect((await f.vault.readState()).mutationQueue).toEqual(before.mutationQueue);
});

it('recovers a committed member response loss without uploading duplicate passwords after restart', async () => {
  const f = await fixture(0); f.loseNextResponse();
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(f.fetcher), f.vault).synchronize(f.account).catch(() => undefined);
  expect(f.requests.length).toBeGreaterThan(0);
  expect((await f.vault.readState()).mutationQueue.length).toBeGreaterThan(0);
  await f.vault.lock();
  const restored = new SecureVaultService(f.store, new MemoryVaultSessionStore(), f.clock); await restored.unlock(master);
  await new BitwardenDurableSyncCoordinator(new BitwardenProvider(f.fetcher), restored).synchronize(f.account);
  expect(f.requests).toHaveLength(2);
  expect((await restored.readState()).mutationQueue).toEqual([]);
  expect((await restored.readState()).providerMutationReceipts).toEqual([]);
  const fresh = await new BitwardenProvider(f.fetcher).sync(f.account, { now: stamp, localItems: [] });
  expect(fresh.items).toHaveLength(2);
  for (const row of f.project) expect(fresh.items.find(item => item.kind === 'login' && item.password === row.password)).toMatchObject({
    passwordGroupId: row.passwordGroupId, customFields: row.customFields });
});
