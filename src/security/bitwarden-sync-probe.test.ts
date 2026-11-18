import { afterEach, expect, it, vi } from 'vitest';
import { createLoginItem, type ProviderAccount, type VaultState } from '../core/model';
import { bytesToBase64 } from './encoding';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { BitwardenProvider } from '../providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../providers/bitwarden/bitwarden-durable-sync';
import { encodeBitwardenCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { encryptVaultState, importVaultKey } from './vault-crypto';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const key = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(9) };
  const account: ProviderAccount = { id: 'probe-bw', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { vaultUrl: 'https://probe.example.test', apiUrl: 'https://probe.example.test/api', identityUrl: 'https://probe.example.test/identity', email: 'probe@example.test', deviceId: 'synthetic', accessToken: 'synthetic-token', expiresAt: Date.now() + 3600000,
      kdf: { type: 0, iterations: 10000 }, vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey) } };
  let cipher = { ...await encodeBitwardenCipher(createLoginItem({ title: 'Remote', username: 'user', password: 'synthetic-secret' }), key), id: 'remote', revisionDate: '2026-11-18T00:00:00Z' };
  let revision = 1, refreshRequired = false;
  let wait: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const provider = new BitwardenProvider(async (input, init) => {
    const url = new URL(String(input)); requests.push(url.pathname);
    if (url.pathname.endsWith('/connect/token')) {
      expect(String(init?.body)).toContain('refresh_token=synthetic-refresh');
      return Response.json({ access_token: 'synthetic-refreshed', refresh_token: 'synthetic-rotated', expires_in: 3600 });
    }
    if (refreshRequired && new Headers(init?.headers).get('Authorization') === 'Bearer synthetic-token') return Response.json({}, { status: 401 });
    if (url.pathname.endsWith('revision-date')) { await wait?.(); return Response.json(revision); }
    if (url.pathname.endsWith('/sync')) return Response.json({ Profile: { Id: 'synthetic-user' }, Folders: [], Ciphers: [cipher] });
    throw new Error('Unexpected request');
  });
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), vault = new SecureVaultService(storage, sessions);
  await vault.setup(''); await vault.upsertProvider(account);
  const coordinator = new BitwardenDurableSyncCoordinator(provider, vault);
  await coordinator.synchronize(account, undefined, { syncHint: { type: 'full' } }); requests.length = 0;
  return { account, provider, storage, vault, coordinator, requests, setWait: (callback: () => Promise<void>) => { wait = callback; },
    expireToken: () => { refreshRequired = true; },
    replaceState: async (mutate: (state: VaultState) => void) => {
      const state = await vault.readState(), envelope = (await storage.read())!, session = (await sessions.read())!;
      mutate(state); await storage.write(await encryptVaultState(state, await importVaultKey(session.rawKey), envelope.kdf));
    },
    changeRemote: async () => { revision++; cipher = { ...await encodeBitwardenCipher(createLoginItem({ title: 'Remote edited', username: 'user', password: 'synthetic-new' }), key), id: 'remote', revisionDate: '2026-11-18T01:00:00Z' }; } };
}

it('unchanged check reads no full state, writes nothing and leaves stored data byte-identical', async () => {
  const f = await fixture();
  try {
    const before = await f.storage.read(), read = vi.spyOn(f.vault, 'readState'), write = vi.spyOn(f.storage, 'write');
    const result = await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } });
    expect(result.unchanged).toBe(true); expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(f.requests).toEqual(['/api/accounts/revision-date']); expect(await f.storage.read()).toEqual(before);
    expect(await f.vault.listItems()).toHaveLength(1);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('lock during the remote check rejects the late result', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  f.setWait(async () => { started(); await waiting; });
  const pending = f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } });
  const rejected = expect(pending).rejects.toThrow();
  await requested; await f.vault.lock(); f.provider.lock(); release(); await rejected;
});

it('replacement of the account during the check rejects adoption', async () => {
  const f = await fixture(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  f.setWait(async () => { started(); await waiting; });
  try {
    const pending = f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } });
    const rejected = expect(pending).rejects.toThrow();
    await requested; await f.vault.upsertProvider({ ...f.account, config: { ...f.account.config, apiUrl: 'https://replacement.example.test/api' } });
    release(); await rejected;
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('a write or external envelope replacement invalidates an outstanding proof', async () => {
  const f = await fixture();
  try {
    const first = await f.vault.readBitwardenSyncProbe(f.account); expect(first).toBeDefined();
    await f.vault.setAutoLockMinutes(10); expect(await f.vault.verifyBitwardenSyncProbe(f.account, first!)).toBe(false);
    const second = await f.vault.readBitwardenSyncProbe(f.account); expect(second).toBeDefined();
    const envelope = (await f.storage.read())!; await f.storage.write({ ...envelope, updatedAt: '2026-11-18T01:00:00Z' });
    expect(await f.vault.verifyBitwardenSyncProbe(f.account, second!)).toBe(false);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('local unsynchronized changes cannot use the fast proof', async () => {
  const f = await fixture();
  try { const item = (await f.vault.listItems())[0]; await f.vault.upsertItem({ ...item, title: 'Local changed' });
    expect(await f.vault.readBitwardenSyncProbe(f.account)).toBeUndefined();
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('a changed revision uses the prefetched full response once and adopts it', async () => {
  const f = await fixture();
  try {
    await f.changeRemote();
    const result = await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } });
    expect(result.unchanged).not.toBe(true);
    expect(f.requests).toEqual(['/api/accounts/revision-date', '/api/sync']);
    expect(await f.vault.listItems()).toMatchObject([{ title: 'Remote edited', password: 'synthetic-new' }]);
    f.requests.length = 0;
    expect((await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } })).unchanged).toBe(true);
    expect(f.requests).toEqual(['/api/accounts/revision-date']);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('cancellation during final proof validation cannot report success', async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const verify = f.vault.verifyBitwardenSyncProbe.bind(f.vault);
    vi.spyOn(f.vault, 'verifyBitwardenSyncProbe').mockImplementation(async (...args) => {
      const result = await verify(...args); controller.abort(); return result;
    });
    const before = await f.storage.read();
    await expect(f.coordinator.synchronize(f.account, controller.signal, { syncHint: { type: 'check-remote' } })).rejects.toThrow();
    expect(await f.storage.read()).toEqual(before);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('a failed adoption cannot acknowledge the prefetched revision', async () => {
  const f = await fixture();
  try {
    await f.changeRemote();
    const write = vi.spyOn(f.storage, 'write').mockRejectedValueOnce(new Error('Synthetic write failure'));
    await expect(f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } })).rejects.toThrow();
    write.mockRestore(); f.requests.length = 0;
    const result = await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } });
    expect(result.unchanged).not.toBe(true);
    expect(f.requests).toEqual(['/api/accounts/revision-date', '/api/sync']);
    expect(await f.vault.listItems()).toMatchObject([{ title: 'Remote edited' }]);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('a cold remote cache falls back to a full read and keeps stored records', async () => {
  const f = await fixture();
  try {
    f.provider.lock();
    expect((await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } })).unchanged).not.toBe(true);
    expect(f.requests).toEqual(['/api/accounts/revision-date', '/api/sync']);
    expect(await f.vault.listItems()).toHaveLength(1);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('a rotated token is adopted once without refreshing the old token again', async () => {
  const f = await fixture();
  try {
    f.account.config.refreshToken = 'synthetic-refresh'; await f.vault.upsertProvider(f.account); f.expireToken();
    const result = await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } });
    expect(result.unchanged).not.toBe(true);
    expect(f.requests).toEqual(['/api/accounts/revision-date', '/identity/connect/token', '/api/accounts/revision-date']);
    expect((await f.vault.getProvider(f.account.id))?.config).toMatchObject({ accessToken: 'synthetic-refreshed', refreshToken: 'synthetic-rotated' });
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('an expired remote baseline forces full reconciliation even with a clean proof', async () => {
  const f = await fixture();
  try {
    (f.provider as any).syncCache.now = () => Date.now() + 16 * 60_000;
    expect((await f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } })).unchanged).not.toBe(true);
    expect(f.requests).toEqual(['/api/accounts/revision-date', '/api/sync']);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('an incomplete Steam projection cannot use a clean proof', async () => {
  const f = await fixture();
  try {
    await f.replaceState(state => { const item = state.items[0]; if (item.kind === 'login') item.loginType = 'STEAM_MAFILE'; });
    expect(await f.vault.readBitwardenSyncProbe(f.account)).toBeUndefined();
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('an orphan durable receipt disables the proof and remains protected on sync', async () => {
  const f = await fixture();
  try {
    await f.replaceState(state => { state.providerMutationReceipts.push({ version: 1, providerId: f.account.id, mutationId: 'synthetic-orphan', itemId: state.items[0].id,
      operation: 'update', stage: 'attempted', intentFingerprint: 'a'.repeat(64), attemptCount: 1, attemptedAt: '2026-11-18T00:00:00Z', createdAt: '2026-11-18T00:00:00Z', updatedAt: '2026-11-18T00:00:00Z' }); });
    const before = await f.storage.read();
    expect(await f.vault.readBitwardenSyncProbe(f.account)).toBeUndefined();
    await expect(f.coordinator.synchronize(f.account, undefined, { syncHint: { type: 'check-remote' } })).rejects.toThrow('未知远端写入');
    expect(await f.storage.read()).toEqual(before); expect(f.requests).toEqual([]);
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('automatic scheduling projects only account configuration and queue routing', async () => {
  const f = await fixture();
  try {
    const item = (await f.vault.listItems())[0]; await f.vault.upsertItem({ ...item, title: 'Local edit' });
    const schedule = await f.vault.readProviderSyncSchedule();
    expect(Object.keys(schedule).sort()).toEqual(['mutationQueue', 'providers']);
    expect(schedule.mutationQueue).toHaveLength(1);
    expect(Object.keys(schedule.mutationQueue[0]).sort()).toEqual(['lastError', 'providerId']);
    schedule.providers[0].name = 'Mutated projection';
    expect((await f.vault.getProvider(f.account.id))?.name).toBe('Synthetic');
  } finally { await f.vault.lock(); f.provider.lock(); }
});

it('a Bitwarden merge snapshot cannot mutate cached rows or be read after lock', async () => {
  const f = await fixture();
  try {
    const [item] = await f.vault.listItems();
    await f.vault.upsertItem({ ...item, title: 'Queued local edit' });
    const envelope = await f.storage.read();
    const snapshot = await f.vault.readBitwardenSyncState();
    expect(snapshot.items[0].providerRefs[0].remoteId).toBe('remote');
    expect(snapshot.mutationQueue).toMatchObject([{ itemId: item.id, operation: 'update' }]);

    snapshot.items[0].providerRefs[0].remoteId = 'changed in scratch copy';
    snapshot.mutationQueue[0].itemId = 'different item';
    expect(await f.vault.readBitwardenSyncState()).toMatchObject({
      items: [{ id: item.id, providerRefs: [{ remoteId: 'remote' }] }],
      mutationQueue: [{ itemId: item.id, operation: 'update' }]
    });

    await f.vault.lock();
    await expect(f.vault.readBitwardenSyncState()).rejects.toThrow();
    expect(await f.storage.read()).toEqual(envelope);
  } finally { await f.vault.lock(); f.provider.lock(); }
});
