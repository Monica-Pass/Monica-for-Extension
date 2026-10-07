import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, randomUUID, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createPasskey } from '../../src/passkey/webauthn-core';
import { groupedPasswords } from '../../src/core/password-groups';
import type { LoginItem, PasskeyItem, VaultItem } from '../../src/core/model';

const master = 'Synthetic recovery browser master';
const databasePassword = 'Synthetic transfer fixture password';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function send<T = unknown>(page: Page, input: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), input);
  expect(result.ok, result.error).toBe(true); return result.data as T;
}
async function launch(info: TestInfo, name = 'profile') {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath(name), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  return { context, page };
}

test('real Apache deleted project and Passkey restore after response loss, restart and actual Edge signing', async ({}, info) => {
  test.skip(!process.env.MONICA_315_REAL_SERVICES_CONFIG, 'Requires the isolated actual Apache service');
  test.setTimeout(180_000);
  const config = JSON.parse(await readFile(process.env.MONICA_315_REAL_SERVICES_CONFIG!, 'utf8')).webdav;
  expect(config.baseUrl).toBe('http://127.0.0.1:18315');
  const bytes = await readFile(path.resolve('.tmp/android-keepass-project-317/android-keepass-project.kdbx'));
  const folder = `/keepass-recovery-${randomUUID()}`, remotePath = `${folder}/vault.kdbx`;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  expect((await fetch(`${config.baseUrl}${folder}`, { method: 'MKCOL', headers: { Authorization: authorization } })).status).toBe(201);
  expect((await fetch(`${config.baseUrl}${remotePath}`, { method: 'PUT', headers: { Authorization: authorization, 'If-None-Match': '*' }, body: bytes })).status).toBe(201);
  let failNextPut = false, blocked = false, lostResponse = false;
  const audit: { method: string; status: number; dropped?: boolean }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const uri = new URL(request.url!, 'http://127.0.0.1');
      if (uri.pathname !== folder && uri.pathname !== `${folder}/` && uri.pathname !== remotePath) { response.writeHead(404).end(); return; }
      if (request.headers.authorization !== authorization) { response.writeHead(401).end(); return; }
      if (blocked) { audit.push({ method: request.method!, status: 503 }); response.writeHead(503).end('Synthetic response loss'); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const upstream = await fetch(`${config.baseUrl}${uri.pathname}`, { method: request.method, headers,
        body: ['GET', 'HEAD'].includes(request.method!) ? undefined : Buffer.concat(chunks), redirect: 'manual' });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (request.method === 'PUT' && upstream.ok && failNextPut) {
        failNextPut = false; blocked = true; lostResponse = true;
        audit.push({ method: 'PUT', status: upstream.status, dropped: true });
        response.writeHead(503).end('Synthetic response loss after actual Apache commit'); return;
      }
      audit.push({ method: request.method!, status: upstream.status });
      const outputHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => { if (!['content-length', 'transfer-encoding', 'connection', 'content-encoding'].includes(key)) outputHeaders[key] = value; });
      response.writeHead(upstream.status, outputHeaders); response.end(body);
    })().catch(() => { if (!response.writableEnded) response.writeHead(500).end('Synthetic proxy failure'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No proxy address');
  const baseUrl = `http://127.0.0.1:${address.port}${folder}`;
  const report: Record<string, unknown> = { status: 'failed', sourceSha256: hash(bytes), remoteUrl: `${config.baseUrl}${remotePath}`, audit,
    fault: 'actual Apache PUT succeeds; a loopback proxy loses its response and temporarily rejects subsequent requests' };
  let app: Awaited<ReturnType<typeof launch>> | undefined, providerId = '';
  try {
    const rp = 'keepass-restore.example.test', site = `https://${rp}`, challenge = Buffer.alloc(32, 61).toString('base64url');
    const key = await createPasskey({ origin: site, challenge, rpId: rp, rpName: 'Restore RP', userId: 'AAEC_w', userName: 'restore-user',
      userDisplayName: 'Restore user', algorithms: [-7], excludeCredentialIds: [], userVerified: true });
    app = await launch(info); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    providerId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_WEBDAV_OPEN', input: { name: 'Recovery WebDAV', baseUrl,
      username: config.username, webDavPassword: config.password, remotePath: 'vault.kdbx', databasePassword } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const now = new Date().toISOString();
    const seeded: PasskeyItem = { id: randomUUID(), kind: 'passkey', title: 'Restore Passkey', notes: 'Synthetic restoration fixture', favorite: false,
      createdAt: now, updatedAt: now, providerRefs: [{ providerId }], credentialId: key.credentialId, rpId: rp, rpName: 'Restore RP',
      userHandle: 'AAEC_w', userName: 'restore-user', userDisplayName: 'Restore user', algorithm: -7, publicKey: key.publicKeySpki,
      privateKeyPkcs8: key.privateKeyPkcs8, signCount: 41, backupEligible: true, backupState: true, discoverable: true, sourceMode: 'browser-local' };
    await send(app.page, { type: 'VAULT_UPSERT_ITEM', item: seeded }); await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const original = await send<VaultItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(original).toHaveLength(5);
    const project = original.filter((row): row is LoginItem => row.kind === 'login' && Boolean(row.passwordGroupId)); expect(project).toHaveLength(3);
    const passkey = original.find(row => row.kind === 'passkey')!;
    const nativeBefore = await fetch(`${config.baseUrl}${remotePath}`, { headers: { Authorization: authorization } }); expect(nativeBefore.ok).toBe(true);
    await writeFile(info.outputPath('before-delete.kdbx'), Buffer.from(await nativeBefore.arrayBuffer()));
    await send(app.page, { type: 'VAULT_DELETE_PASSWORD_GROUP', anchorItemId: project[0].id, expected: Object.fromEntries(project.map(row => [row.id, row.updatedAt])) });
    await send(app.page, { type: 'VAULT_DELETE_ITEM', itemId: passkey.id });
    expect(await send(app.page, { type: 'VAULT_MATCH_PASSKEYS', pageUrl: site })).toEqual([]);
    failNextPut = true;
    const failed = await app.page.evaluate(id => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId: id }), providerId);
    expect(failed.ok).toBe(false); expect(lostResponse).toBe(true);
    const committed = await fetch(`${config.baseUrl}${remotePath}`, { headers: { Authorization: authorization } }); expect(committed.ok).toBe(true);
    const committedBytes = Buffer.from(await committed.arrayBuffer());
    await writeFile(info.outputPath('committed-delete.kdbx'), committedBytes); report.committedSha256 = hash(committedBytes);
    const trashReader = await launch(info, 'trash-reader');
    try {
      await send(trashReader.page, { type: 'VAULT_SETUP', masterPassword: master });
      const trashSource = (await send<{ account: { id: string } }>(trashReader.page, { type: 'KEEPASS_WEBDAV_OPEN', input: {
        name: 'Fresh native trash', baseUrl: `${config.baseUrl}${folder}`, username: config.username,
        webDavPassword: config.password, remotePath: 'vault.kdbx', databasePassword } })).account.id;
      await send(trashReader.page, { type: 'PROVIDER_SYNC', providerId: trashSource });
      expect(await send<VaultItem[]>(trashReader.page, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(1);
      expect(await send<VaultItem[]>(trashReader.page, { type: 'VAULT_LIST_DELETED_ITEMS' })).toHaveLength(4);
      expect(await send(trashReader.page, { type: 'VAULT_MATCH_PASSKEYS', pageUrl: site })).toEqual([]);
      report.freshNativeTrash = true;
    } finally { await trashReader.context.close(); }
    await app.page.reload(); await app.page.locator('button.nav-item').filter({ hasText: '回收站' }).click();
    await expect(app.page.locator('article').filter({ hasText: 'Restore Passkey' }).getByText('可用于浏览器认证', { exact: true })).toHaveCount(0);
    await app.page.screenshot({ path: info.outputPath('native-trash.png') });
    const deleted = await send<VaultItem[]>(app.page, { type: 'VAULT_LIST_DELETED_ITEMS' }); expect(deleted).toHaveLength(4);
    for (const [index, item] of [...project, passkey].entries()) {
      await app.page.getByRole('button', { name: `恢复 ${item.title}`, exact: true }).first().click();
      await expect.poll(async () => (await send<VaultItem[]>(app!.page, { type: 'VAULT_LIST_DELETED_ITEMS' })).length).toBe(3 - index);
    }
    await app.context.close(); app = undefined;
    app = await launch(info); await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master }); blocked = false;
    await send(app.page, { type: 'KEEPASS_REMOTE_RESTORE', providerId }); await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const restored = await send<VaultItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(restored).toHaveLength(5);
    expect(await send(app.page, { type: 'VAULT_LIST_DELETED_ITEMS' })).toEqual([]);
    for (const before of original) {
      const after = restored.find(row => row.id === before.id)!; expect(after).toBeTruthy();
      expect(after.keepassEntryUuid).toBe(before.keepassEntryUuid); expect(after.title).toBe(before.title); expect(after.notes).toBe(before.notes);
      if (before.kind === 'login' && after.kind === 'login') { expect(after.password).toBe(before.password); expect(after.customFields).toEqual(before.customFields); }
    }
    expect(groupedPasswords(restored.filter((row): row is LoginItem => row.kind === 'login')).map(rows => rows.length).sort()).toEqual([1, 3]);
    const candidates = await send<unknown[]>(app.page, { type: 'VAULT_MATCH_PASSKEYS', pageUrl: site }); expect(candidates).toHaveLength(1);
    await app.context.route(`${site}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><button id="login">Sign in</button><output id="result"></output><script>
      login.onclick=async()=>{result.textContent='waiting';try{window.assertion=(await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({
      challenge:'${challenge}',rpId:'${rp}',userVerification:'required',timeout:60000,allowCredentials:[{type:'public-key',id:'${key.credentialId}'}]})})).toJSON();result.textContent='authenticated';
      }catch(e){result.textContent='error:'+e.name+':'+e.message;}};</script>` }));
    const website = await app.context.newPage(); await website.goto(site); await website.locator('#login').click();
    await expect(website.locator('#monica-passkey-prompt-host')).toHaveCount(1);
    const verificationPromise = app.context.waitForEvent('page');
    await website.keyboard.press('Tab'); await website.keyboard.press('Tab'); await website.keyboard.press('Enter');
    const verification = await verificationPromise; await verification.getByLabel('Monica 主密码', { exact: true }).fill(master);
    await verification.getByRole('button', { name: '确认', exact: true }).click();
    await expect(website.locator('#result')).toHaveText('authenticated', { timeout: 30_000 });
    const assertion = await website.evaluate(() => (window as any).assertion), auth = Buffer.from(assertion.response.authenticatorData, 'base64url');
    const client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    expect(assertion.id).toBe(key.credentialId); expect(auth.readUInt32BE(33)).toBe(42); expect(auth[32]).toBe(29);
    expect(JSON.parse(client.toString())).toMatchObject({ origin: site, type: 'webauthn.get', challenge });
    expect(auth.subarray(0, 32)).toEqual(createHash('sha256').update(rp).digest());
    expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), createPublicKey({ key: Buffer.from(key.publicKeySpki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    const remote = await fetch(`${config.baseUrl}${remotePath}`, { headers: { Authorization: authorization } }); expect(remote.ok).toBe(true);
    const returned = Buffer.from(await remote.arrayBuffer()); await writeFile(info.outputPath('restored.kdbx'), returned); report.returnSha256 = hash(returned);
    report.original = original; report.expected = await send(app.page, { type: 'VAULT_LIST_ITEMS' }); report.assertion = assertion;
    await app.context.close(); app = undefined;
    app = await launch(info, 'fresh-profile'); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    const freshId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_WEBDAV_OPEN', input: { name: 'Fresh trash recovery', baseUrl: `${config.baseUrl}${folder}`,
      username: config.username, webDavPassword: config.password, remotePath: 'vault.kdbx', databasePassword } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: freshId });
    const fresh = await send<VaultItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(fresh).toHaveLength(5);
    const freshPasskey = fresh.find(row => row.kind === 'passkey') as PasskeyItem;
    expect(freshPasskey).toMatchObject({ credentialId: key.credentialId, privateKeyPkcs8: key.privateKeyPkcs8, signCount: 42 });
    expect(await send(app.page, { type: 'VAULT_LIST_DELETED_ITEMS' })).toEqual([]);
    await app.page.reload(); await app.page.locator('button.nav-item').filter({ hasText: '全部项目' }).click();
    await expect(app.page.getByRole('button', { name: '查看Restore Passkey详情', exact: true })).toBeVisible();
    await app.page.screenshot({ path: info.outputPath('fresh-restored.png') });
    report.status = 'passed'; report.fullRestart = true; report.freshBrowser = true; report.restoredPasswords = 3; report.passkeySigned = true;
    report.passkeyOrigin = 'Synthetic key generated by the shared core in the test runner, stored and restored through the actual extension';
  } finally {
    if (app) await app.context.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(report, null, 2));
  }
});
