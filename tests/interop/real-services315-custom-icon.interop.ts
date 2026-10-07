import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';

it.skipIf(!process.env.MONICA_315_REAL_SERVICES_CONFIG)('persists password icons through real Vaultwarden create, reconnect, update and clear', async () => {
  const config = JSON.parse(await readFile(resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!), 'utf8')).vaultwarden as { baseUrl: string; password: string };
  expect(new URL(config.baseUrl).hostname).toBe('127.0.0.1');
  await mkdir(resolve('.tmp/icon-real-services'), { recursive: true });
  const output = await mkdtemp(join(resolve('.tmp/icon-real-services'), 'run-'));
  const checks: string[] = [];
  try {
    const client = new BitwardenClient();
    const email = `icon-${randomUUID()}@example.invalid`;
    const master = await deriveBitwardenMasterKey(config.password, email, { type: 0, iterations: 600000 });
    const vaultKey = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const response = await fetch(`${config.baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email, name: 'Synthetic icon test', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, config.password),
        key: await client.protectVaultKey(vaultKey, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) });
      expect(response.ok).toBe(true);
    } finally { master.fill(0); vaultKey.encKey.fill(0); vaultKey.macKey.fill(0); }
    const login = await client.login({ vaultUrl: config.baseUrl, email, masterPassword: config.password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    let account: ProviderAccount = { id: 'icons-old', kind: 'bitwarden', name: 'Synthetic icons', enabled: true, isDefaultSaveTarget: false, config: login.session };
    const provider = new BitwardenProvider();
    await provider.create(account, { ...createLoginItem({ title: 'Icon account', username: email, password: 'synthetic', providerRefs: [{ providerId: account.id }] }), customIconType: 'SIMPLE_ICON', customIconValue: 'github', customIconUpdatedAt: 10 });
    account = { ...account, id: 'icons-reconnected' };
    const read = async () => {
      const items = (await new BitwardenProvider().sync(account, { now: new Date().toISOString(), localItems: [] })).items;
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe('login');
      return items[0] as LoginItem;
    };
    let item = await read();
    expect(item).toMatchObject({ customIconType: 'SIMPLE_ICON', customIconValue: 'github', customIconUpdatedAt: 10 });
    checks.push('create-reconnect');
    await provider.update(account, { ...item, title: 'Renamed' });
    item = await read();
    expect(item.customIconValue).toBe('github');
    checks.push('unrelated-edit');
    await provider.update(account, { ...item, customIconType: 'EMOJI', customIconValue: '🔐', customIconUpdatedAt: 20 });
    item = await read();
    expect(item).toMatchObject({ customIconType: 'EMOJI', customIconValue: '🔐', customIconUpdatedAt: 20 });
    checks.push('replace');
    await provider.update(account, { ...item, customIconType: 'NONE', customIconValue: undefined, customIconUpdatedAt: 30 });
    item = await read();
    expect(item).toMatchObject({ customIconType: 'NONE', customIconUpdatedAt: 30, password: 'synthetic' });
    expect(item.customIconValue).toBeUndefined();
    expect(item.customFields).toEqual([]);
    checks.push('clear-password-unchanged');
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ status: 'passed', checks, androidVerified: false }, null, 2));
  } catch (error) {
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2));
    throw error;
  }
});
