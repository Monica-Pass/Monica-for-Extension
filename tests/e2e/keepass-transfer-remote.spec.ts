import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import type { PasskeyItem, VaultItem } from '../../src/core/model';

const extension = path.resolve('dist');
const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const, viewport: { width: 1180, height: 950 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
async function send(page: Page, request: Record<string, unknown>): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}

for (const lostReply of [false, true]) test(`KeePass remote transfer ${lostReply ? 'resumes a lost upload response after full Edge restart' : 'rebases peer changes'} and preserves a usable Passkey`, async ({}, info) => {
  test.setTimeout(150_000);
  const helper = info.outputPath('keepass-fixture.cjs');
  await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture'; export {openKeePassVault} from './src/providers/keepass/keepass-vault';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(helper) as typeof import('../../src/providers/keepass/keepass-fixture') & typeof import('../../src/providers/keepass/keepass-vault');
  const password = 'Synthetic remote KDBX password';
  const initial = await api.buildKeePassFixture({ password, kdf: 'argon2id', entries: [{ title: 'Existing remote', protectedFields: { Password: 'untouched synthetic secret' } }] });
  const remote = { bytes: Buffer.from(initial), etag: '"initial"', puts: [] as string[], conflicts: 0, offline: false, loseNextReply: lostReply };
  const authorization = `Basic ${Buffer.from('fixture:synthetic-transport').toString('base64')}`;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== authorization) { response.writeHead(401).end(); return; }
      if (!['/dav/', '/dav/vault.kdbx'].includes(request.url!)) { response.writeHead(404).end(); return; }
      if (remote.offline) { response.writeHead(503).end(); return; }
      if (request.method === 'PROPFIND') {
        response.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/vault.kdbx</d:href><d:propstat><d:prop><d:getetag>${remote.etag.replaceAll('"', '&quot;')}</d:getetag><d:getcontentlength>${remote.bytes.length}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
        return;
      }
      if (request.method === 'GET') {
        if (request.headers['if-match'] && request.headers['if-match'] !== remote.etag) { response.writeHead(412).end(); return; }
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: remote.etag, 'Content-Length': remote.bytes.length }).end(remote.bytes); return;
      }
      if (request.method === 'PUT') {
        if (request.headers['if-match'] !== remote.etag) { remote.conflicts++; response.writeHead(412).end(); return; }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        remote.puts.push(request.headers['if-match']!); remote.bytes = Buffer.concat(chunks); remote.etag = `"upload-${remote.puts.length}"`;
        if (remote.loseNextReply) { remote.loseNextReply = false; remote.offline = true; response.destroy(); return; }
        response.writeHead(204, { ETag: remote.etag }).end(); return;
      }
      response.writeHead(405).end();
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}/dav`;
  const profile = info.outputPath('profile');
  let context: Awaited<ReturnType<typeof launchEdgeContext>> | undefined;
  const manager = async () => {
    const worker = context!.serviceWorkers()[0] || await context!.waitForEvent('serviceworker');
    const page = await context!.newPage(); page.setDefaultTimeout(20_000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
  };
  try {
    context = await launchEdgeContext(profile, options);
    let page = await manager(); await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key: PasskeyItem = { id: 'synthetic-portable-key', kind: 'passkey', title: 'Transfer Passkey',
      favorite: false, notes: 'Synthetic portable key', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', providerRefs: [],
      credentialId: randomBytes(32).toString('base64url'), rpId: 'synthetic.example', rpName: 'Synthetic', userHandle: 'AQID',
      userName: 'synthetic-user', userDisplayName: 'Synthetic user', algorithm: -7,
      publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      privateKeyPkcs8: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      signCount: 0, backupEligible: true, backupState: true, discoverable: true, sourceMode: 'browser-local' };
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: [key] });
    const { account } = await send(page, { type: 'KEEPASS_WEBDAV_OPEN', input: { name: 'Synthetic remote destination', baseUrl,
      username: 'fixture', webDavPassword: 'synthetic-transport', remotePath: 'vault.kdbx', databasePassword: password } });
    await send(page, { type: 'PROVIDER_SYNC', providerId: account.id });
    await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    let card = page.locator('m3e-card.source-card').filter({ has: page.getByRole('heading', { name: 'Synthetic remote destination', exact: true }) });
    await card.getByRole('button', { name: '批量传输', exact: true }).click();
    let transfer = dialogContent(page, { name: '复制或移动项目' });
    await transfer.getByRole('checkbox', { name: /Transfer Passkey/ }).check();
    await transfer.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(transfer.getByText('1 个可传输，0 个被阻断', { exact: true })).toBeVisible();
    if (!lostReply) {
      const peer = await api.openKeePassVault(Uint8Array.from(remote.bytes), { password, databaseId: 1, providerId: 'peer' });
      peer.database.getDefaultGroup().entries[0].fields.set('Notes', 'Unrelated peer edit survives');
      remote.bytes = Buffer.from(await peer.database.save()); remote.etag = '"peer-2"';
    }
    await transfer.getByRole('button', { name: '执行复制', exact: true }).click();
    if (lostReply) {
      await expect(transfer.getByRole('button', { name: '恢复传输', exact: true })).toBeVisible({ timeout: 45_000 });
      expect(remote.puts).toHaveLength(1);
      expect(await send(page, { type: 'KEEPASS_PENDING_TRANSFERS', providerId: account.id })).toHaveLength(1);
      await context.close(); remote.offline = false;
      context = await launchEdgeContext(profile, options); page = await manager();
      await send(page, { type: 'VAULT_UNLOCK', masterPassword: '' }); await page.reload();
      await page.getByRole('button', { name: '密码源', exact: true }).click();
      card = page.locator('m3e-card.source-card').filter({ has: page.getByRole('heading', { name: 'Synthetic remote destination', exact: true }) });
      await card.getByRole('button', { name: '批量传输', exact: true }).click();
      transfer = dialogContent(page, { name: '复制或移动项目' });
      await transfer.getByRole('button', { name: '恢复传输', exact: true }).click();
    }
    await expect(transfer.getByText('1 个成功 · 0 个阻断 · 0 个失败', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('remote-transfer-complete.png') });
    expect(await send(page, { type: 'KEEPASS_PENDING_TRANSFERS', providerId: account.id })).toEqual([]);
    if (!lostReply) { expect(remote.conflicts).toBeGreaterThan(0); expect(remote.puts).toEqual(['"peer-2"']); }
    const reopened = await api.openKeePassVault(Uint8Array.from(remote.bytes), { password, databaseId: 1, providerId: 'independent-reader' });
    expect(reopened.items).toHaveLength(2);
    const copied = reopened.items.find(row => row.kind === 'passkey') as PasskeyItem;
    expect(copied).toMatchObject({ credentialId: key.credentialId, algorithm: -7, signCount: 0, backupEligible: true, backupState: true });
    expect(Buffer.from(copied.privateKeyPkcs8!, 'base64url')).toEqual(Buffer.from(key.privateKeyPkcs8!, 'base64url'));
    const challenge = randomBytes(64), signature = sign('sha256', challenge, { key: Buffer.from(copied.privateKeyPkcs8!, 'base64url'), format: 'der', type: 'pkcs8' });
    expect(verify('sha256', challenge, pair.publicKey, signature)).toBe(true);
    if (!lostReply) expect(reopened.items.find(row => row.title === 'Existing remote')?.notes).toBe('Unrelated peer edit survives');
    const items: VaultItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items.filter(row => row.kind === 'passkey')).toHaveLength(2);
    expect(items.find(row => row.id === key.id)).toMatchObject({ credentialId: key.credentialId, signCount: 0 });
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
