import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption, dialogContent } from './fixtures/material';
import { groupedPasswords } from '../../src/core/password-groups';
import type { LoginItem } from '../../src/core/model';

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

test('real Apache response loss preserves a new grouped project and edits made before a full Edge restart', async ({}, info) => {
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
  let app: Awaited<ReturnType<typeof launch>> | undefined, expected: LoginItem[] = [], providerId = '';
  try {
    app = await launch(info); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    providerId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_WEBDAV_OPEN', input: { name: 'Recovery WebDAV', baseUrl,
      username: config.username, webDavPassword: config.password, remotePath: 'vault.kdbx', databasePassword } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const original = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(original).toHaveLength(4);
    await app.page.reload(); await app.page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await app.page.getByRole('button', { name: '选择新建类型', exact: true }).click();
    await app.page.locator('m3e-menu-item[data-create-type="PASSWORD"]').click();
    let editor = dialogContent(app.page, { name: '添加密码', exact: true });
    await editor.getByLabel('名称 *', { exact: true }).fill('Recovery project');
    await chooseOption(editor.getByLabel('保存到', { exact: true }), { label: 'Recovery WebDAV' });
    await editor.getByLabel('用户名', { exact: true }).fill('initial-user');
    await editor.getByLabel('密码', { exact: true }).fill('initial-secret');
    await editor.getByRole('button', { name: '添加凭据组', exact: true }).click();
    let groups = editor.locator('[data-credential-group]'); await expect(groups).toHaveCount(2);
    await groups.nth(0).getByRole('button', { name: '添加密码', exact: true }).click();
    await groups.nth(0).getByLabel('密码 2', { exact: true }).fill('other-secret');
    await groups.nth(1).getByLabel('用户名', { exact: true }).fill('recovery-user');
    await groups.nth(1).getByLabel('密码 1', { exact: true }).fill('recovery-secret');
    await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
    const created = (await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' })).filter(row => row.title === 'Recovery project');
    expect(created).toHaveLength(3); expect(groupedPasswords(created)).toHaveLength(1);
    failNextPut = true;
    const failed = await app.page.evaluate(id => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId: id }), providerId);
    expect(failed.ok).toBe(false); expect(lostResponse).toBe(true); report.failedSyncMessage = failed.error;
    const committed = await fetch(`${config.baseUrl}${remotePath}`, { headers: { Authorization: authorization } }); expect(committed.ok).toBe(true);
    const committedBytes = Buffer.from(await committed.arrayBuffer());
    await writeFile(info.outputPath('committed-before-response-loss.kdbx'), committedBytes); report.committedSha256 = hash(committedBytes);
    // Continue through the rendered editor while the transport remains unavailable.
    await app.page.reload(); await app.page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await app.page.getByRole('button', { name: '查看Recovery project详情', exact: true }).click();
    await dialogContent(app.page, { name: 'Recovery project', exact: true }).getByRole('button', { name: '编辑', exact: true }).click();
    editor = dialogContent(app.page, { name: '编辑密码', exact: true }); groups = editor.locator('[data-credential-group]');
    await groups.nth(0).getByLabel('密码 1', { exact: true }).fill('edited-after-response-loss');
    await groups.nth(0).getByRole('button', { name: '添加密码', exact: true }).click();
    await groups.nth(0).getByLabel('密码 3', { exact: true }).fill('added-after-response-loss');
    await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
    expected = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(expected).toHaveLength(8);
    await app.page.screenshot({ path: info.outputPath('edited-while-offline.png') });
    await app.context.close(); app = undefined;
    app = await launch(info); await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    blocked = false;
    await send(app.page, { type: 'KEEPASS_REMOTE_RESTORE', providerId });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const restored = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' });
    expect(restored).toHaveLength(8); expect(groupedPasswords(restored)).toHaveLength(3);
    for (const old of expected) {
      const row = restored.find(item => item.id === old.id)!; expect(row).toBeTruthy();
      for (const key of ['title', 'password', 'username', 'notes', 'passwordGroupId'] as const) expect(row[key]).toBe(old[key]);
      expect(row.customFields).toEqual(old.customFields);
    }
    const queue = await send<{ providerId: string; pending: number }[]>(app.page, { type: 'PROVIDER_QUEUE_STATUS' });
    expect(queue.find(row => row.providerId === providerId)?.pending ?? 0).toBe(0);
    const remote = await fetch(`${config.baseUrl}${remotePath}`, { headers: { Authorization: authorization } }); expect(remote.ok).toBe(true);
    const finalBytes = Buffer.from(await remote.arrayBuffer()); report.returnSha256 = hash(finalBytes);
    await writeFile(info.outputPath('recovered.kdbx'), finalBytes);
    report.expected = restored; report.original = original;
    await app.context.close(); app = undefined;
    app = await launch(info, 'fresh-profile'); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    const freshId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_WEBDAV_OPEN', input: { name: 'Fresh Apache source', baseUrl: `${config.baseUrl}${folder}`,
      username: config.username, webDavPassword: config.password, remotePath: 'vault.kdbx', databasePassword } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: freshId });
    const fresh = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(fresh).toHaveLength(8);
    for (const old of restored) {
      const row = fresh.find(item => item.keepassEntryUuid === old.keepassEntryUuid)!; expect(row).toBeTruthy();
      for (const key of ['title', 'password', 'username', 'notes', 'passwordGroupId'] as const) expect(row[key]).toBe(old[key]);
      expect(row.customFields).toEqual(old.customFields);
    }
    await app.page.reload(); await app.page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await app.page.screenshot({ path: info.outputPath('fresh-apache-projects.png') });
    report.status = 'passed'; report.freshBrowser = true; report.fullRestart = true; report.projectRows = 4;
  } finally {
    if (app) await app.context.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(report, null, 2));
  }
});
