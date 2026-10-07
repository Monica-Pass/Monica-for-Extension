import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenDurableSyncCoordinator } from '../../src/providers/bitwarden/bitwarden-durable-sync';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey, encryptBitwardenBytes,
  decryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';
import { encodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { MemoryVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';

it.skipIf(!process.env.MONICA_315_REAL_SERVICES_CONFIG)('persists password histories through real Vaultwarden and independent clients', async () => {
  const config = JSON.parse(await readFile(resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!), 'utf8')).vaultwarden as { baseUrl: string; password: string };
  expect(config.baseUrl).toBe('http://127.0.0.1:18316');
  const root = resolve('.tmp/password-history-live-317'); await mkdir(root, { recursive: true });
  const output = await mkdtemp(join(root, 'run-')), checks: string[] = [];
  const cipherKey = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  try {
    const client = new BitwardenClient(), email = `history-${randomUUID()}@example.invalid`;
    const master = await deriveBitwardenMasterKey(config.password, email, { type: 0, iterations: 600000 });
    const vaultKey = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const response = await fetch(`${config.baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email, name: 'Synthetic password history interop', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, config.password),
        key: await client.protectVaultKey(vaultKey, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) }); expect(response.ok).toBe(true);
    } finally { master.fill(0); vaultKey.encKey.fill(0); vaultKey.macKey.fill(0); }
    const login = await client.login({ vaultUrl: config.baseUrl, email, masterPassword: config.password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    const account: ProviderAccount = { id: 'history-live', kind: 'bitwarden', name: 'History Vaultwarden', enabled: true, isDefaultSaveTarget: false, config: login.session };
    const key = client.vaultKey(login.session);
    const old = [{ password: ' original\r\n历史 ', lastUsedAt: '2026-01-01T00:00:00.000Z' },
      { password: 'older reused', lastUsedAt: '2025-01-01T00:00:00.000Z' }, { password: ' original\r\n历史 ', lastUsedAt: '1970-01-01T00:00:00.000Z' }];
    const ids: string[] = [];
    const unreadable = { password: '2.future-unreadable-format', lastUsedDate: '2024-01-01T00:00:00.000Z' };
    try {
      for (const partial of [false, true]) {
        const payload = await encodeBitwardenCipher({ ...createLoginItem({ title: partial ? 'Partial native history' : 'Native history', username: 'synthetic', password: 'current',
          uris: ['https://history.example.test'] }), passwordHistory: old }, cipherKey);
        payload.key = await encryptBitwardenBytes(new Uint8Array([...cipherKey.encKey, ...cipherKey.macKey]), key);
        if (partial) (payload.passwordHistory as unknown[]).push(unreadable);
        const response = await client.createCipher(login.session, payload);
        ids.push(String(response.payload.id ?? response.payload.Id));
      }
    } finally { key.encKey.fill(0); key.macKey.fill(0); }
    const remoteHistory = async (id: string) => {
      const raw = (await client.getCipherDetails(login.session, id)).payload!;
      const history = (raw.passwordHistory ?? raw.PasswordHistory) as Record<string, unknown>[];
      return { raw, encrypted: history, plain: await Promise.all(history.map(async row => {
        const encrypted = (row.password ?? row.Password) as string, lastUsedAt = row.lastUsedDate ?? row.LastUsedDate;
        return { password: encrypted === unreadable.password ? encrypted : await decryptBitwardenString(encrypted, cipherKey), lastUsedAt: new Date(String(lastUsedAt)).toISOString() };
      })) };
    };
    expect((await remoteHistory(ids[0])).plain).toEqual(old); checks.push('real-server-native-per-cipher-history');
    const storage = new MemoryVaultStorage(), service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await service.setup('synthetic local history vault'); await service.upsertProvider(account);
    const sync = async () => new BitwardenDurableSyncCoordinator(new BitwardenProvider(), service).synchronize((await service.readState()).providers.find(row => row.id === account.id)!);
    await sync();
    const rows = (await service.listItems()) as LoginItem[]; expect(rows).toHaveLength(2);
    const clean = rows.find(row => row.title === 'Native history')!, partial = rows.find(row => row.title === 'Partial native history')!;
    expect(clean.passwordHistory).toEqual(old); expect(partial.passwordHistoryIncomplete).toBe(true);
    const beforeCiphertext = (await remoteHistory(ids[0])).encrypted;
    let edited = await service.upsertItem({ ...clean, password: 'second' }, undefined, clean.updatedAt) as LoginItem;
    edited = await service.upsertItem({ ...edited, password: 'third' }, undefined, edited.updatedAt) as LoginItem;
    await service.upsertItem({ ...partial, notes: 'Unrelated edit keeps unreadable history' }, undefined, partial.updatedAt);
    await sync();
    const expected = edited.passwordHistory!;
    const written = await remoteHistory(ids[0]);
    expect(written.plain).toEqual(expected);
    expect(written.encrypted.slice(2)).toEqual(beforeCiphertext);
    expect((await remoteHistory(ids[1])).encrypted.some(row => (row.password ?? row.Password) === unreadable.password)).toBe(true);
    expect((await service.readState()).mutationQueue).toEqual([]); checks.push('two-local-saves-one-sync', 'existing-ciphertext-retained', 'unreadable-history-preserved');
    const current = await service.getItem(clean.id) as LoginItem;
    await service.deletePasswordHistory(current.id, 1, current.updatedAt); await sync();
    expect((await remoteHistory(ids[0])).plain).toEqual(expected.filter((_, index) => index !== 1)); checks.push('single-history-delete-on-real-server');
    await service.lock();
    const freshLogin = await new BitwardenClient().login({ vaultUrl: config.baseUrl, email, masterPassword: config.password, deviceId: randomUUID() });
    if (freshLogin.status !== 'authenticated') throw new Error('Fresh synthetic login failed');
    const freshAccount = { ...account, id: 'fresh-history-client', config: freshLogin.session };
    const fresh = (await new BitwardenProvider().sync(freshAccount, { localItems: [], now: new Date().toISOString() })).items as LoginItem[];
    expect(fresh.find(row => row.title === clean.title)?.passwordHistory).toEqual(expected.filter((_, index) => index !== 1));
    expect(fresh.find(row => row.title === partial.title)?.passwordHistoryIncomplete).toBe(true); checks.push('fresh-login-empty-local-state');
    await expect(new BitwardenProvider().create(freshAccount, { ...fresh.find(row => row.title === partial.title)!, id: randomUUID(), providerRefs: [{ providerId: freshAccount.id }] })).rejects.toThrow(/历史/);
    expect((await new BitwardenProvider().sync(freshAccount, { localItems: [], now: new Date().toISOString() })).items).toHaveLength(2); checks.push('incomplete-transfer-refused-before-create');
    await writeFile(join(output, 'edge-fixture.json'), JSON.stringify({ synthetic: true, baseUrl: config.baseUrl, email, password: config.password, name: 'History Vaultwarden',
      cipherIds: ids, expected: fresh, checks }, null, 2));
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ status: 'passed', server: 'Vaultwarden 1.37.3', checks, androidVerified: false }, null, 2));
    await writeFile(join(root, 'latest.json'), JSON.stringify({ output, fixture: join(output, 'edge-fixture.json') }, null, 2));
    console.log(`History live evidence: ${output}`);
  } catch (error) {
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2)); throw error;
  } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
});
