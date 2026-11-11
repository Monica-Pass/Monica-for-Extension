import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { LoginItem, ProviderAccount } from '../../src/core/model';
import { readAndroidBackup } from '../../src/providers/webdav/android-backup-codec';
import { decryptAndroidBackup, encryptAndroidBackup, getAndroidBackupEncryptionFormat } from '../../src/providers/webdav/android-backup-crypto';
import { launchEdgeContext } from './fixtures/edge';

const masterPassword = 'Synthetic Edge V2 vault password';
const backupPassword = '  Synthetic V2 中文🔑e\u0301 backup password  ';
const sourceName = 'monica_backup_20200101_000000.enc.zip';
const unknown = Uint8Array.of(0, 1, 254, 255);
const etag = (bytes: Uint8Array) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

async function send<T = any>(page: Page, input: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

async function localWebDav(source: Uint8Array) {
  const files = new Map([[sourceName, { bytes: source, modified: 'Wed, 01 Jan 2020 00:00:00 GMT' }]]);
  const requests: { method: string; name: string; ifMatch?: string; ifNoneMatch?: string }[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method || 'GET', name = request.url!.split('/').pop()!;
    requests.push({ method, name, ifMatch: request.headers['if-match'], ifNoneMatch: request.headers['if-none-match'] });
    if (method === 'PROPFIND') {
      response.writeHead(207, { 'Content-Type': 'application/xml' });
      response.end(`<d:multistatus xmlns:d="DAV:">${request.headers.depth === '1' ? [...files].map(([file, value]) =>
        `<d:response><d:href>/dav/Monica_Backups/${file}</d:href><d:propstat><d:prop><d:getetag>${etag(value.bytes)}</d:getetag><d:getcontentlength>${value.bytes.length}</d:getcontentlength><d:getlastmodified>${value.modified}</d:getlastmodified></d:prop></d:propstat></d:response>`).join('') : ''}</d:multistatus>`);
      return;
    }
    const file = files.get(name);
    if (method === 'GET') {
      if (!file) { response.writeHead(404).end(); return; }
      if (request.headers['if-match'] && request.headers['if-match'] !== etag(file.bytes)) { response.writeHead(412).end(); return; }
      response.writeHead(200, { ETag: etag(file.bytes), 'Content-Length': file.bytes.length, 'Last-Modified': file.modified });
      response.end(file.bytes);
      return;
    }
    if (method === 'PUT') {
      if (file || request.headers['if-none-match'] !== '*') { response.writeHead(412).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = new Uint8Array(Buffer.concat(chunks));
      files.set(name, { bytes, modified: new Date().toUTCString() });
      response.writeHead(201, { ETag: etag(bytes) }).end();
      return;
    }
    response.writeHead(405).end();
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.writableEnded) response.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic WebDAV server failed');
  return { files, requests, baseUrl: `http://127.0.0.1:${address.port}/dav`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('real Edge imports and writes V2 WebDAV without downgrade and retains data on password or profile failure', async ({}, info) => {
  test.setTimeout(120_000);
  const zip = zipSync({
    'passwords/password_42.json': strToU8(JSON.stringify({ id: 42, title: 'Synthetic V2 HTTP login', username: 'synthetic@example.test',
      password: 'synthetic initial record', createdAt: 1, updatedAt: 2 })),
    'future/unknown.bin': unknown
  });
  const original = await encryptAndroidBackup(zip, backupPassword, undefined, undefined, 'v2');
  const server = await localWebDav(original), extensionPath = path.resolve('dist');
  let context: Awaited<ReturnType<typeof launchEdgeContext>> | undefined;
  try {
    context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const manager = await context.newPage(), pageErrors: string[] = [];
    manager.on('pageerror', error => pageErrors.push(error.message));
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await manager.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    await send(manager, { type: 'VAULT_SETUP', masterPassword });
    const config = { baseUrl: server.baseUrl, username: 'synthetic', password: 'synthetic', backupPassword, backupEncryptionFormat: 'v1' };
    const provider = await send<ProviderAccount>(manager, { type: 'WEBDAV_SAVE', name: 'Synthetic V2 WebDAV', config, isDefaultSaveTarget: false });
    await send(manager, { type: 'PROVIDER_SYNC', providerId: provider.id });
    const initial = await send<LoginItem[]>(manager, { type: 'VAULT_LIST_ITEMS' });
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ title: 'Synthetic V2 HTTP login', password: 'synthetic initial record' });
    expect(server.files.size).toBe(1);
    await send(manager, { type: 'VAULT_UPSERT_ITEM', item: { ...initial[0], password: 'synthetic browser V2 edit' }, expectedUpdatedAt: initial[0].updatedAt });
    await send(manager, { type: 'PROVIDER_SYNC', providerId: provider.id });
    expect(server.files.size).toBe(2);
    expect(server.files.get(sourceName)!.bytes).toEqual(original);
    const [[publishedName, published]] = [...server.files].filter(([name]) => name !== sourceName);
    expect(getAndroidBackupEncryptionFormat(published.bytes)).toBe('v2');
    const decoded = await decryptAndroidBackup(published.bytes, backupPassword);
    expect(readAndroidBackup(decoded, provider.id).items[0]).toMatchObject({ password: 'synthetic browser V2 edit' });
    expect(unzipSync(decoded)['future/unknown.bin']).toEqual(unknown);
    expect(server.requests.filter(request => request.method === 'PUT')).toEqual([
      { method: 'PUT', name: publishedName, ifMatch: undefined, ifNoneMatch: '*' }
    ]);
    expect(server.requests.filter(request => request.method === 'GET' && request.name === sourceName)
      .every(request => request.ifMatch === etag(original))).toBe(true);
    const beforeFailures = await send<LoginItem[]>(manager, { type: 'VAULT_LIST_ITEMS' });
    await send(manager, { type: 'WEBDAV_SAVE', providerId: provider.id, name: provider.name,
      config: { ...config, backupPassword: 'synthetic wrong password' } });
    const badPassword = await manager.evaluate(id => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId: id }), provider.id);
    expect(badPassword.ok).toBe(false);
    expect(await send(manager, { type: 'VAULT_LIST_ITEMS' })).toEqual(beforeFailures);
    expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    await send(manager, { type: 'WEBDAV_SAVE', providerId: provider.id, name: provider.name, config });
    const changed = published.bytes.slice(); changed[16] ^= 1;
    server.files.set(publishedName, { ...published, bytes: changed });
    const badProfile = await manager.evaluate(id => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId: id }), provider.id);
    expect(badProfile.ok).toBe(false);
    expect(await send(manager, { type: 'VAULT_LIST_ITEMS' })).toEqual(beforeFailures);
    expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    expect(server.files.get(publishedName)!.bytes).toEqual(changed);
    expect(server.files.get(sourceName)!.bytes).toEqual(original);
    expect(pageErrors).toEqual([]);
    const evidence = JSON.stringify({
      status: 'passed', runtime: await send(manager, { type: 'RUNTIME_INFO' }), synthetic: true,
      sourceSha256: createHash('sha256').update(original).digest('hex'),
      publishedSha256: createHash('sha256').update(published.bytes).digest('hex'),
      format: 'v2', unknownEntriesPreserved: true, immutableSourcePreserved: true,
      conditionalPutCount: 1, wrongPasswordAndProfileRetainLocalItems: true, pageErrors
    }, null, 2);
    await writeFile(info.outputPath('evidence.json'), evidence);
    await info.attach('v2-webdav-evidence', { contentType: 'application/json', body: evidence });
  } finally {
    await context?.close();
    await server.close();
  }
});
