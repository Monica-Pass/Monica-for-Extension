import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { LoginItem, ProviderAccount } from '../../core/model';
import { readAndroidBackup } from './android-backup-codec';
import { decryptAndroidBackup, encryptAndroidBackup, getAndroidBackupEncryptionFormat } from './android-backup-crypto';
import { MonicaWebDavProvider } from './monica-webdav-provider';

const password = 'synthetic HTTP V2 password';
const sourceName = 'monica_backup_20200101_000000.enc.zip';
const loginPath = 'passwords/password_42.json';
const zip = () => zipSync({
  [loginPath]: strToU8(JSON.stringify({ id: 42, title: 'Synthetic HTTP login', username: 'synthetic@example.test',
    password: 'synthetic initial record', createdAt: 1, updatedAt: 2 })),
  'future/unknown.bin': Uint8Array.of(0, 1, 254, 255)
});
const etag = (bytes: Uint8Array) => `"${createHash('sha256').update(bytes).digest('hex')}"`;

async function localServer(source: Uint8Array) {
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
    void handle(request, response).catch(() => { response.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic server failed to listen');
  const account: ProviderAccount = { id: 'synthetic-http-webdav', kind: 'monica-webdav', name: 'Synthetic HTTP', enabled: true,
    isDefaultSaveTarget: false, config: { baseUrl: `http://127.0.0.1:${address.port}/dav`, username: 'synthetic', password: 'synthetic',
      backupPassword: password, backupEncryptionFormat: 'v1' } };
  return { account, files, requests, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

describe('V2 WebDAV over real loopback HTTP', () => {
  it('conditionally downloads and publishes a verified V2 snapshot while preserving its source and unknown entries', async () => {
    const original = await encryptAndroidBackup(zip(), password, undefined, undefined, 'v2');
    const server = await localServer(original);
    try {
      const provider = new MonicaWebDavProvider();
      const initial = await provider.sync(server.account, { now: '2026-11-11T00:00:00Z', localItems: [] });
      const local = { ...initial.items[0], password: 'synthetic HTTP updated record', updatedAt: '2026-11-11T00:01:00Z' } as LoginItem;
      const before = structuredClone(local);
      const result = await provider.sync({ ...server.account, config: initial.accountPatch!.config! },
        { now: '2026-11-11T00:02:00Z', localItems: [local] });
      expect(result.conflicts).toEqual([]);
      expect(local).toEqual(before);
      expect(server.files).toHaveLength(2);
      expect(server.files.get(sourceName)!.bytes).toEqual(original);
      const [[publishedName, published]] = [...server.files].filter(([name]) => name !== sourceName);
      expect(getAndroidBackupEncryptionFormat(published.bytes)).toBe('v2');
      const decoded = await decryptAndroidBackup(published.bytes, password);
      expect(readAndroidBackup(decoded, server.account.id).items[0]).toMatchObject({ password: local.password });
      expect(unzipSync(decoded)['future/unknown.bin']).toEqual(Uint8Array.of(0, 1, 254, 255));
      expect(server.requests.filter(request => request.method === 'PUT')).toEqual([
        { method: 'PUT', name: publishedName, ifMatch: undefined, ifNoneMatch: '*' }
      ]);
      expect(server.requests.filter(request => request.method === 'GET' && request.name === sourceName)
        .every(request => request.ifMatch === etag(original))).toBe(true);
      expect(result.accountPatch!.config).toMatchObject({ lastFileName: publishedName, lastEtag: etag(published.bytes) });
    } finally { await server.close(); }
  });

  it.each(['password', 'profile', 'version'] as const)('rejects an invalid V2 %s without any HTTP write', async failure => {
    const original = await encryptAndroidBackup(zip(), password, undefined, undefined, 'v2');
    if (failure === 'profile') original[16] ^= 1;
    if (failure === 'version') original[12] = 0x39;
    const server = await localServer(original), before = original.slice();
    try {
      const account = failure === 'password' ? { ...server.account, config: { ...server.account.config, backupPassword: 'synthetic wrong password' } } : server.account;
      await expect(new MonicaWebDavProvider().sync(account, { now: '2026-11-11T00:00:00Z', localItems: [] })).rejects.toThrow();
      expect(server.requests.every(request => request.method === 'GET' || request.method === 'PROPFIND')).toBe(true);
      expect(server.files).toHaveLength(1);
      expect(server.files.get(sourceName)!.bytes).toEqual(before);
    } finally { await server.close(); }
  });
});
