import { afterEach, expect, it, vi } from 'vitest';
import { BitwardenProvider } from '../providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../providers/bitwarden/bitwarden-durable-sync';
import { encodeBitwardenCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { bytesToBase64 } from './encoding';
import { createLoginItem, type ProviderAccount } from '../core/model';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const key = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(12) };
  const account: ProviderAccount = { id: 'bw', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { vaultUrl: 'https://sync.example.test', apiUrl: 'https://sync.example.test/api', identityUrl: 'https://sync.example.test/identity',
      email: 'synthetic@example.test', deviceId: 'synthetic', accessToken: 'synthetic-token', expiresAt: Date.now() + 3600000,
      kdf: { type: 0, iterations: 10000 }, vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey) } };
  const raw = { ...await encodeBitwardenCipher(createLoginItem({ title: 'Synthetic', password: 'synthetic-password' }), key),
    id: 'cipher', revisionDate: '2026-11-12T00:00:00.000Z' };
  const provider = new BitwardenProvider(async input => Response.json(String(input).endsWith('revision-date') ? 1 : { Profile: {}, Folders: [], Ciphers: [raw] }));
  const storage = new MemoryVaultStorage();
  const vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await vault.setup(''); await vault.upsertProvider(account);
  const writes = vi.spyOn(storage, 'write');
  return { account, provider, storage, vault, writes, sync: new BitwardenDurableSyncCoordinator(provider, vault),
    options: { syncHint: { type: 'check-remote' as const }, diagnosticStartedAt: Date.now() } };
}

it('commits the ordinary sync diagnostic together with the encrypted projection, without a second write', async () => {
  const f = await fixture();
  await f.sync.synchronize(f.account, undefined, f.options);
  expect(f.writes).toHaveBeenCalledTimes(1);
  const state = await f.vault.readState();
  expect(state.items).toHaveLength(1);
  expect(state.providerDiagnostics).toHaveLength(1);
  expect(state.providerDiagnostics[0]).toMatchObject({ operation: 'sync', outcome: 'success', code: 'ok', conflicts: 0, warnings: 0 });
  expect(JSON.stringify(state.providerDiagnostics)).not.toContain('synthetic-password');
  f.writes.mockClear();
  expect((await f.sync.synchronize(f.account, undefined, f.options)).unchanged).toBe(true);
  expect(f.writes).not.toHaveBeenCalled();
  expect((await f.vault.readState()).providerDiagnostics).toHaveLength(1);
  await f.vault.lock();
});

it('never persists a success diagnostic if the projection commit fails', async () => {
  const f = await fixture();
  const before = structuredClone(f.storage.envelope);
  f.writes.mockRejectedValueOnce(new Error('synthetic disk full'));
  await expect(f.sync.synchronize(f.account, undefined, f.options)).rejects.toThrow('disk full');
  expect(f.storage.envelope).toEqual(before);
  expect((await f.vault.readState()).providerDiagnostics).toEqual([]);
  expect(await f.vault.listItems()).toEqual([]);
  await f.vault.lock();
});

it('records conflict diagnostics in the same transaction and retains the conflict', async () => {
  const f = await fixture();
  const actual = f.provider.sync.bind(f.provider);
  vi.spyOn(f.provider, 'sync').mockImplementation(async (...args) => {
    const result = await actual(...args);
    return { ...result, conflicts: [{ itemId: result.items[0].id, reason: 'synthetic conflict', remote: result.items[0] }] };
  });
  await f.sync.synchronize(f.account, undefined, f.options);
  const state = await f.vault.readState();
  expect(f.writes).toHaveBeenCalledTimes(1);
  expect(state.providerConflicts).toHaveLength(1);
  expect(state.providerDiagnostics[0]).toMatchObject({ outcome: 'conflict', code: 'conflict', conflicts: 1 });
  await f.vault.lock();
});

it('rejects cancellation after the remote read without committing either data or diagnostics', async () => {
  const f = await fixture(), controller = new AbortController();
  const actual = f.provider.sync.bind(f.provider);
  vi.spyOn(f.provider, 'sync').mockImplementation(async (...args) => {
    const result = await actual(...args); controller.abort(); return result;
  });
  await expect(f.sync.synchronize(f.account, controller.signal, f.options)).rejects.toThrow();
  expect(f.writes).not.toHaveBeenCalled();
  expect((await f.vault.readState()).providerDiagnostics).toEqual([]);
  await f.vault.lock();
});
