import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount, type VaultItem } from '../../src/core/model';
import { applySsoAccountChoice, resolveSsoAccount, ssoLogicalId } from '../../src/core/sso-links';
import { KeePassProvider } from '../../src/providers/keepass/keepass-provider';
import { KeePassWebDavClient } from '../../src/providers/keepass/keepass-webdav-client';
import { buildKeePassFixture } from '../../src/providers/keepass/keepass-fixture';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';

interface Config { webdav: { baseUrl: string; username: string; password: string }; vaultwarden: { baseUrl: string; password: string } }
const enabled = Boolean(process.env.MONICA_315_REAL_SERVICES_CONFIG);
let config: Config;
let output: string;
const checks: unknown[] = [];
const fixtures: Record<string, unknown> = {};
const now = () => new Date().toISOString();
const password = 'Synthetic SSO KDBX password';
beforeAll(async () => {
  if (!enabled) return;
  config = JSON.parse(await readFile(resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!), 'utf8'));
  for (const url of [config.webdav.baseUrl, config.vaultwarden.baseUrl]) expect(new URL(url).hostname).toBe('127.0.0.1');
  const parent = resolve('.tmp/sso-real-services');
  await mkdir(parent, { recursive: true });
  output = await mkdtemp(join(parent, 'run-'));
});
afterAll(async () => {
  if (!output) return;
  await writeFile(join(output, 'edge-fixtures.json'), JSON.stringify(fixtures, null, 2));
  await writeFile(join(output, 'evidence.json'), JSON.stringify({ layer: 'actual loopback Apache/Vaultwarden, real fetch; not Android or Edge UI', checks, finishedAt: now() }, null, 2));
  process.stdout.write(`SSO_SERVICES_EVIDENCE ${join(output, 'evidence.json')}\n`);
});

describe.skipIf(!enabled)('SSO against actual backend services', () => {
  it('keeps a KDBX account link through conditional WebDAV writes, reconnect and unlink', async () => record('keepass-webdav', async () => {
    const baseUrl = `${config.webdav.baseUrl}/sso-${randomUUID()}`;
    const headers = { Authorization: `Basic ${Buffer.from(`${config.webdav.username}:${config.webdav.password}`).toString('base64')}` };
    expect((await fetch(baseUrl, { method: 'MKCOL', headers })).status).toBe(201);
    const bytes = await buildKeePassFixture({ password, entries: [
      { title: 'Account', fields: { UserName: 'user@example.test', Password: 'synthetic' } },
      { title: 'Site', fields: { MonicaLoginType: 'SSO', 'SSO Provider': 'OKTA' } }
    ] });
    expect((await fetch(`${baseUrl}/sso.kdbx`, { method: 'PUT', headers: { ...headers, 'If-None-Match': '*' }, body: bytes as BodyInit })).status).toBe(201);
    const client = new KeePassWebDavClient({ ...config.webdav, baseUrl, remotePath: 'sso.kdbx' });
    let provider = new KeePassProvider();
    let account: ProviderAccount = { id: 'sso-kp-old', kind: 'keepass', name: 'Synthetic SSO', enabled: true, isDefaultSaveTarget: false, config: { sourceMode: 'webdav', databaseId: 991 } };
    let remote = await client.read();
    await provider.unlock(account, remote.bytes, { password, sourceMode: 'webdav' });
    const read = async () => (await provider.sync(account, { now: now(), localItems: [] })).items;
    let items = await read();
    const originalAccount = named(items, 'Account');
    const linked = applySsoAccountChoice(named(items, 'Site'), ssoLogicalId(originalAccount), items);
    await provider.update(account, linked);
    await client.write(await provider.exportFile(account.id), remote.etag!);
    remote = await client.read();
    provider = new KeePassProvider();
    account = { ...account, id: 'sso-kp-new', config: { ...account.config, databaseId: 992 } };
    await provider.unlock(account, remote.bytes, { password, sourceMode: 'webdav' });
    items = await read();
    let site = named(items, 'Site');
    expect(resolveSsoAccount(site, items)?.keepassEntryUuid).toBe(originalAccount.keepassEntryUuid);
    expect(named(items, 'Account').id).not.toBe(originalAccount.id);
    await provider.update(account, { ...site, notes: 'Unrelated edit' });
    await client.write(await provider.exportFile(account.id), remote.etag!);
    remote = await client.read();
    provider = new KeePassProvider();
    await provider.unlock(account, remote.bytes, { password, sourceMode: 'webdav' });
    items = await read(); site = named(items, 'Site');
    expect(resolveSsoAccount(site, items)?.title).toBe('Account');
    await provider.update(account, applySsoAccountChoice(site, '', items));
    await client.write(await provider.exportFile(account.id), remote.etag!);
    provider = new KeePassProvider();
    await provider.unlock(account, (await client.read()).bytes, { password, sourceMode: 'webdav' });
    items = await read();
    expect(named(items, 'Site').ssoRefLogicalId).toBeUndefined();
    expect(named(items, 'Account').password).toBe(originalAccount.password);
    fixtures.keepass = { ...config.webdav, baseUrl, remotePath: 'sso.kdbx', databasePassword: password, name: 'SSO KeePass' };
  }));

  it('keeps a Vaultwarden account link through real writes, reconnect and unlink', async () => record('vaultwarden', async () => {
    const client = new BitwardenClient();
    const email = `sso-${randomUUID()}@example.invalid`;
    const master = await deriveBitwardenMasterKey(config.vaultwarden.password, email, { type: 0, iterations: 600000 });
    const vaultKey = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    const response = await fetch(`${config.vaultwarden.baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      email, name: 'Synthetic SSO', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, config.vaultwarden.password),
      key: await client.protectVaultKey(vaultKey, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
    }) });
    expect(response.ok).toBe(true); master.fill(0); vaultKey.encKey.fill(0); vaultKey.macKey.fill(0);
    const login = await client.login({ vaultUrl: config.vaultwarden.baseUrl, email, masterPassword: config.vaultwarden.password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    let account: ProviderAccount = { id: 'sso-bw-old', kind: 'bitwarden', name: 'Synthetic SSO', enabled: true, isDefaultSaveTarget: false, config: login.session };
    const provider = new BitwardenProvider();
    const originalAccount = await provider.create(account, createLoginItem({ title: 'Account', username: email, password: 'synthetic', providerRefs: [{ providerId: account.id }] })) as LoginItem;
    const siteDraft = { ...createLoginItem({ title: 'Site', providerRefs: [{ providerId: account.id }] }), loginType: 'SSO' as const, ssoProvider: 'OKTA' };
    const legacySite = await provider.create(account, { ...siteDraft, ssoRefEntryId: 42 }) as LoginItem;
    const legacyRead = (await new BitwardenProvider().sync(account, { now: now(), localItems: [] })).items;
    expect(named(legacyRead, 'Site').ssoRefEntryId).toBe(42);
    await provider.update(account, applySsoAccountChoice(legacySite, ssoLogicalId(originalAccount), [originalAccount]));
    account = { ...account, id: 'sso-bw-new' };
    const read = async () => (await new BitwardenProvider().sync(account, { now: now(), localItems: [] })).items;
    let items = await read();
    let site = named(items, 'Site');
    expect(site.ssoRefEntryId).toBeUndefined();
    expect(resolveSsoAccount(site, items)?.providerRefs[0].remoteId).toBe(originalAccount.providerRefs[0].remoteId);
    expect(named(items, 'Account').id).not.toBe(originalAccount.id);
    await provider.update(account, { ...site, notes: 'Unrelated edit' });
    items = await read(); site = named(items, 'Site');
    expect(resolveSsoAccount(site, items)?.title).toBe('Account');
    await provider.update(account, applySsoAccountChoice(site, '', items));
    items = await read();
    expect(named(items, 'Site').ssoRefLogicalId).toBeUndefined();
    expect(named(items, 'Account').password).toBe(originalAccount.password);
    expect(items).toHaveLength(2);
    fixtures.vaultwarden = { ...config.vaultwarden, email, name: 'SSO Vaultwarden' };
  }));
});
function named(items: VaultItem[], title: string): LoginItem { const item = items.find(item => item.title === title); expect(item?.kind).toBe('login'); return item as LoginItem; }
async function record(name: string, body: () => Promise<void>) {
  try { await body(); checks.push({ name, status: 'passed', reconnect: true, unrelatedEdit: true, unlink: true, accountUnchanged: true }); }
  catch (error) { checks.push({ name, status: 'failed', error: String(error) }); throw error; }
}
