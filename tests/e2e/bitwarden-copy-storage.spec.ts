import { expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { launchEdgeContext } from './fixtures/edge';
import { resolveBitwardenCipherKey } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { decryptBitwardenSymmetricKey, decryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';

test('full Bitwarden Cipher and files recover through HTTP loss, real IndexedDB abort and two full Edge restarts', async ({}, info) => {
  test.setTimeout(120_000);
  const bundle = await build({ entryPoints: ['tests/e2e/fixtures/bitwarden-copy-harness.ts'], bundle: true, platform: 'browser',
    format: 'iife', globalName: 'bitwardenCopyTest', write: false, logLevel: 'silent', alias: { crypto: resolve('scripts/stubs/node-crypto.js') } });
  const rows: Record<string, any>[] = [], files = new Map<string, Buffer>(), unexpected: string[] = [], events: string[] = [];
  let sequence = 0, createPosts = 0, uploadLoss = false, host = '';
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const json = (data: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); };
    const body = async () => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
    const lost = () => { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      response.flushHeaders(); response.write('{"lost":'); setImmediate(() => response.destroy()); };
    try {
      if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Synthetic Bitwarden copy acceptance</title>'); return; }
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      events.push(`${request.method} ${pathname}`);
      if (pathname === '/api/sync') return json({ Ciphers: rows, Profile: { Id: 'synthetic' }, Folders: [] });
      if (pathname === '/api/ciphers' && request.method === 'POST') {
        createPosts++; rows.push({ ...JSON.parse((await body()).toString()), id: 'remote-copy', revisionDate: '2026-10-12T00:00:00.000Z' });
        lost(); return;
      }
      if (pathname === '/api/ciphers/remote-copy/details') return json(rows[0]);
      if (pathname === '/api/ciphers/remote-copy/attachment/v2' && request.method === 'POST') {
        const data = JSON.parse((await body()).toString()), id = `file-${sequence++}`;
        rows[0].attachments ||= []; rows[0].attachments.push({ id, fileName: data.fileName, key: data.key, size: String(data.fileSize) });
        rows[0].revisionDate = new Date(Date.parse('2026-10-12T00:00:00.000Z') + sequence * 1000).toISOString();
        return json({ attachmentId: id, fileUploadType: 0, url: '', cipherResponse: rows[0] });
      }
      const match = /^\/api\/ciphers\/remote-copy\/attachment\/(file-\d+)$/.exec(pathname);
      if (match && request.method === 'POST') {
        const form = await new Response(await body(), { headers: { 'content-type': request.headers['content-type']! } }).formData();
        files.set(match[1], Buffer.from(await (form.get('data') as Blob).arrayBuffer()));
        if (!uploadLoss) { uploadLoss = true; response.destroy(); return; }
        response.end(); return;
      }
      if (match && request.method === 'GET') {
        const attachment = rows[0].attachments.find((row: any) => row.id === match[1]);
        return json({ ...attachment, url: `${host}/download/${match[1]}` });
      }
      const download = /^\/download\/(file-\d+)$/.exec(pathname);
      if (download) {
        // Vaultwarden serves authenticated files on the API origin. Separate
        // object-server origins must not receive this header (covered elsewhere).
        if (request.headers.authorization !== 'Bearer synthetic-token') throw new Error('Missing same-origin authorization');
        const bytes = files.get(download[1]);
        if (!bytes) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Length', bytes.length); response.end(bytes); return;
      }
      unexpected.push(`${request.method} ${pathname}`); response.writeHead(404); response.end();
    } catch { unexpected.push(`handler ${pathname}`); response.writeHead(500); response.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let context: BrowserContext | undefined;
  const open = async () => {
    context = await launchEdgeContext(info.outputPath('profile'));
    const page = await context.newPage(); await page.goto(host); await page.addScriptTag({ content: bundle.outputFiles[0].text }); return page;
  };
  try {
    let page = await open();
    const first = await page.evaluate(host => (window as any).bitwardenCopyTest.first(host), host);
    expect(first.aborted).toBe(true); expect(first.lost).toBe(true); expect(createPosts).toBe(1); expect(files.size).toBe(0);
    await context!.close(); context = undefined; page = await open();
    expect(await page.evaluate(id => (window as any).bitwardenCopyTest.second(id), first.copyId)).toEqual({ lost: true, receipts: 1 });
    expect(sequence).toBe(1); expect(files.size).toBe(1);
    await context!.close(); context = undefined; page = await open();
    const final = await page.evaluate(id => (window as any).bitwardenCopyTest.final(id), first.copyId);
    expect(final).toMatchObject({ stage: 'verified', fileCount: 2, kinds: ['login', 'totp', 'passkey', 'passkey'], counts: [0, 19], sourceIds: first.sourceItemIds });
    expect(createPosts).toBe(1); expect(sequence).toBe(2); expect(files.size).toBe(2); expect(unexpected).toEqual([]);
    for (const [index, assertion] of final.assertions.entries()) {
      const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
      expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
        createPublicKey({ key: Buffer.from(first.publicKeys[index], 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    }
    const cipherKey = await resolveBitwardenCipherKey(rows[0], { encKey: new Uint8Array(32).fill(24), macKey: new Uint8Array(32).fill(25) });
    try {
      expect(await decryptBitwardenString(rows[0].FutureData.secret, cipherKey)).toBe('private future field');
      for (const [index, attachment] of rows[0].attachments.entries()) {
        const fileKey = await decryptBitwardenSymmetricKey(attachment.key, cipherKey), wire = Uint8Array.from(files.get(attachment.id)!);
        try {
          expect(wire[0]).toBe(2);
          const mac = await crypto.subtle.importKey('raw', fileKey.macKey as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
          expect(await crypto.subtle.verify('HMAC', mac, wire.subarray(17, 49), Buffer.concat([wire.subarray(1, 17), wire.subarray(49)]))).toBe(true);
          const aes = await crypto.subtle.importKey('raw', fileKey.encKey as BufferSource, 'AES-CBC', false, ['decrypt']);
          expect([...new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: wire.subarray(1, 17) }, aes, wire.subarray(49)))]).toEqual([index, 1, 42, 255]);
        } finally { fileKey.encKey.fill(0); fileKey.macKey.fill(0); }
      }
    } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
    await info.attach('cipher-copy-recovery', { body: JSON.stringify({ indexedDbAbort: first.aborted, browserRestarts: 2, createPosts,
      attachmentCreates: sequence, independentSignatures: final.assertions.length, counters: final.counts, events }, null, 2), contentType: 'application/json' });
  } finally { await context?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
