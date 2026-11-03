import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, encryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';
import { createAssertion, createPasskey } from '../../src/passkey/webauthn-core';
import { createLoginItem, type PasskeyItem } from '../../src/core/model';

const stamp = '2026-10-12T00:00:00.000Z', password = 'Synthetic batch password', email = 'batch@example.invalid';
const options = { locale: 'zh-CN', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const, viewport: { width: 1180, height: 950 },
  args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };
async function send(page: Page, request: object): Promise<any> { const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(response.ok, response.error).toBe(true); return response.data; }

test('native Bitwarden graph copies through folder/Cipher HTTP loss and two complete Edge restarts', async ({}, info) => {
  test.setTimeout(180_000);
  const key = { encKey: new Uint8Array(32).fill(12), macKey: new Uint8Array(32).fill(29) };
  const protectedKey = await new BitwardenClient().protectVaultKey(key,
    await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 10_000 })), new Uint8Array(16));
  const base = { ...createLoginItem({ title: 'Linked base', password: 'Synthetic source secret' }), createdAt: stamp, updatedAt: stamp };
  const sso = { ...createLoginItem({ title: 'Linked SSO' }), loginType: 'SSO' as const, ssoRefLogicalId: 'password:bitwarden:source-base', createdAt: stamp, updatedAt: stamp };
  let native = await encodeBitwardenCipher(base, key);
  const originals: PasskeyItem[] = [];
  for (const count of [0, 19]) {
    const generated = await createPasskey({ origin: 'https://batch.example.test', challenge: Buffer.alloc(32, 9).toString('base64url'),
      rpName: 'Batch', userId: 'dXNlcg', userName: `user-${count}`, userDisplayName: `User ${count}`, algorithms: [-7], excludeCredentialIds: [] });
    const passkey: PasskeyItem = { id: `key-${count}`, kind: 'passkey', title: 'Linked base', notes: '', favorite: false, createdAt: stamp, updatedAt: stamp,
      providerRefs: [], credentialId: generated.credentialId, rpId: 'batch.example.test', rpName: 'Batch', userHandle: 'dXNlcg', userName: `user-${count}`,
      userDisplayName: `User ${count}`, algorithm: -7, publicKey: generated.publicKeySpki, privateKeyPkcs8: generated.privateKeyPkcs8,
      signCount: count, discoverable: true, backupEligible: true, backupState: true, sourceMode: 'browser-local' };
    native = await encodeBitwardenPasskeyCipher(passkey, key, native); originals.push(passkey);
  }
  const rows: Record<string, unknown>[] = [{ ...native, id: 'source-base', revisionDate: stamp, creationDate: stamp, folderId: 'games' },
    { ...await encodeBitwardenCipher(sso, key), id: 'source-sso', revisionDate: stamp, creationDate: stamp, folderId: 'games' }];
  const folders = [{ id: 'games', name: await encryptBitwardenString('Games', key) }, { id: 'imports', name: await encryptBitwardenString('Imports', key) }];
  let folderPosts = 0, cipherPosts = 0, loseCipher = true;
  const unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    const json = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    const body = async () => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString()); };
    const lost = () => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' }); response.flushHeaders(); response.write('{"lost":'); setImmediate(() => response.destroy()); };
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/identity/accounts/prelogin/password') return json({ Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === '/identity/connect/token') return json({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, Key: protectedKey });
    if (url.pathname === '/api/sync') return json({ Profile: { Id: 'batch-user', Email: email }, Ciphers: rows, Folders: folders });
    if (url.pathname === '/api/folders' && request.method === 'GET') return json({ Data: folders });
    if (url.pathname === '/api/accounts/revision-date') return json(Date.parse(stamp));
    if (url.pathname === '/api/folders' && request.method === 'POST') { folderPosts++; folders.push({ ...await body(), id: 'copied-folder' }); lost(); return; }
    if (url.pathname === '/api/ciphers' && request.method === 'POST') {
      const raw = { ...await body(), id: `copy-${cipherPosts++}`, revisionDate: stamp, creationDate: stamp }; rows.push(raw);
      if (loseCipher) { loseCipher = false; lost(); return; } return json(raw);
    }
    const detail = /^\/api\/ciphers\/([^/]+)\/details$/.exec(url.pathname);
    if (detail) return json(rows.find(row => row.id === detail[1]));
    unexpected.push(`${request.method} ${url.pathname}`); response.writeHead(404); response.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`, profile = info.outputPath('profile');
  let context: BrowserContext | undefined;
  const open = async () => { context = await launchEdgeContext(profile, options); const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); page.setDefaultTimeout(20_000); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page; };
  const transfer = async (page: Page) => { await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: 'Synthetic batch', exact: true }) }).getByRole('button', { name: '批量传输', exact: true }).click();
    return dialogContent(page, { name: '复制或移动项目' }); };
  try {
    let page = await open(); await send(page, { type: 'VAULT_SETUP', masterPassword: password });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    const { providerId } = await send(page, { type: 'BITWARDEN_LOGIN', name: 'Synthetic batch', vaultUrl: host, email, masterPassword: password });
    await send(page, { type: 'PROVIDER_SYNC', providerId });
    let dialog = await transfer(page);
    // Source moves have been supported since before this refactor. This test
    // exercises a copy, while the planner validates eligible move sources.
    await expect(dialog.getByRole('radio', { name: /移动/ })).toBeEnabled();
    await expect(dialog.getByRole('radio', { name: /复制/ })).toBeChecked();
    await dialog.getByRole('radio', { name: /Imports/ }).check(); await dialog.getByRole('checkbox', { name: /Linked SSO/ }).check();
    await dialog.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(dialog.getByText('4 个可传输，0 个被阻断', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 950 }); expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await dialog.locator('.batch-plan-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('bitwarden-preview-320.png') }); await page.setViewportSize(options.viewport);
    await dialog.getByRole('button', { name: '执行复制', exact: true }).click(); await expect(dialog.getByRole('button', { name: '恢复传输', exact: true })).toBeVisible();
    expect(folderPosts).toBe(1); expect(cipherPosts).toBe(0);
    const pending = await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId }); expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain('Synthetic source secret'); expect(JSON.stringify(pending)).not.toContain('vaultKey');
    for (let restart = 0; restart < 2; restart++) {
      await send(page, { type: 'VAULT_LOCK' }); await context!.close(); context = undefined;
      page = await open(); await send(page, { type: 'VAULT_UNLOCK', masterPassword: password }); dialog = await transfer(page);
      await dialog.getByRole('button', { name: '恢复传输', exact: true }).click();
      if (!restart) { await expect(dialog.locator('.batch-dialog-error')).toBeVisible(); expect(cipherPosts).toBe(1); }
      else await expect(dialog.getByText('4 个成功 · 0 个阻断 · 0 个失败', { exact: true })).toBeVisible();
    }
    expect(folderPosts).toBe(1); expect(cipherPosts).toBe(2); expect(rows).toHaveLength(4);
    const copied = (await Promise.all(rows.slice(2).map(row => decodeBitwardenCipher(row, providerId, key)))).flatMap(row => row.items);
    expect(copied.find(row => row.kind === 'login' && row.loginType === 'SSO')).toMatchObject({ ssoRefLogicalId: 'password:bitwarden:copy-0' });
    for (const original of originals) {
      const actual = copied.find(row => row.kind === 'passkey' && row.credentialId === original.credentialId) as PasskeyItem;
      expect(actual.signCount).toBe(original.signCount); expect(Buffer.from(actual.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(original.privateKeyPkcs8!, 'base64'));
      const assertion = await createAssertion({ origin: 'https://batch.example.test', challenge: Buffer.alloc(32, 6).toString('base64url'),
        rpId: actual.rpId, credentialId: actual.credentialId, userHandle: actual.userHandle, privateKeyPkcs8: actual.privateKeyPkcs8!, signCount: actual.signCount });
      const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'); expect(auth.readUInt32BE(33)).toBe(original.signCount);
      const signed = Buffer.concat([auth, createHash('sha256').update(Buffer.from(assertion.response.clientDataJSON, 'base64url')).digest()]);
      expect(verify('sha256', signed, createPublicKey({ key: Buffer.from(original.publicKey!, 'base64'), type: 'spki', format: 'der' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    }
    const replay = await send(page, { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request }); expect(replay.completedCount).toBe(4); expect(cipherPosts).toBe(2);
    expect(await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId })).toEqual([]); expect(unexpected).toEqual([]);
    await page.setViewportSize({ width: 320, height: 950 }); await dialog.locator('.batch-result-panel').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('bitwarden-completed-320.png') });
    const popup = await context!.newPage(); await popup.goto(new URL('popup.html', page.url()).href);
    for (const type of ['BITWARDEN_PENDING_TRANSFERS', 'BITWARDEN_CANCEL_UNWRITTEN_TRANSFER']) {
      const denied = await popup.evaluate(input => chrome.runtime.sendMessage(input), { type, providerId, operationId: pending[0].request.operationId });
      expect(denied.ok).toBe(false); expect(denied.error).toContain('管理页');
    }
  } finally { await context?.close(); await new Promise<void>(done => server.close(() => done())); key.encKey.fill(0); key.macKey.fill(0); }
});
