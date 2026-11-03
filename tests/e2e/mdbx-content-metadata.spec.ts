import { test, expect, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import type { Mdbx2ContentMetadata } from '../../src/providers/mdbx2/content-metadata';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
test('bundled MDBX reads native metadata and tombstones with precision, revision and Power policy', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge acceptance'); test.setTimeout(180_000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension');
  await mkdir(extension, { recursive: true });
  execFileSync(path.resolve('native/mdbx2-host/target/debug/examples/content_metadata_fixture.exe'), [run], { windowsHide: true, timeout: 60_000 });
  const fixtures = JSON.parse(await readFile(path.join(run, 'fixtures.json'), 'utf8')) as { mode: string; file: string; owner: string; source: string; label: string; relation: string; tombstone: string; payloadJson: string }[];
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Monica synthetic metadata acceptance', version: '1.0.0', background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" } }));
  await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Synthetic metadata acceptance</title><script src="harness.js"></script>');
  for (const file of ['engine.js', 'monica_mdbx2_browser.wasm']) await copyFile(path.resolve('native/mdbx2-browser/pkg', file), path.join(extension, file));
  await build({ entryPoints: ['tests/e2e/fixtures/mdbx-browser-worker.ts'], outfile: path.join(extension, 'worker.js'), bundle: true, format: 'esm', target: 'chrome130', external: ['./engine.js'], alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') } });
  await writeFile(path.join(extension, 'harness.js'), `const worker=new Worker('./worker.js',{type:'module'}),pending=new Map();worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error.code+': '+data.error.message)):p.resolve(data.result);};window.probe=(op,data)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,op,data});});`);
  let context: BrowserContext | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', nativeFixture: true, browserEngine: true, androidApplicationAcceptance: false };
  try {
    context = await launchEdgeContext(path.join(run, 'profile'), { args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    evidence.edgeVersion = context.browser()?.version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const call = (op: string, data?: unknown): Promise<any> => page.evaluate(({ op, data }) => (window as unknown as { probe: (op: string, data: unknown) => Promise<unknown> }).probe(op, data), { op, data });
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await call('rpc', { protocol: 2, requestId: randomUUID(), method, params });
      if (!response.ok) throw Error(response.error.code); return response.result;
    };
    await call('open', { name: `synthetic-metadata-${randomUUID()}` });
    expect((await rpc('host.hello')).supportsContentMetadata).toBe(true);
    for (const fixture of fixtures) {
      const bytes = await readFile(path.join(run, fixture.file));
      const transfer = await rpc('transfer.begin', { direction: 'extension-to-host', purpose: 'vault-bootstrap', sizeBytes: bytes.length, sha256: sha(bytes) });
      for (let offset = 0; offset < bytes.length; offset += 262144) await rpc('transfer.chunk', { transferId: transfer.transferId, offset, dataBase64: bytes.subarray(offset, offset + 262144).toString('base64') });
      const file = await rpc('transfer.finish', { transferId: transfer.transferId });
      const opened = await rpc('vault.open', { source: { kind: 'file', handle: file.fileHandle }, credential: { method: 'password', password: 'synthetic-metadata-acceptance-password' } });
      const handle = opened.vaultHandle, revision = await rpc('vault.writeRevision', { vaultHandle: handle });
      const input = { writeRevision: revision, collectionIds: [fixture.owner], objectIds: [fixture.source] };
      const before = (await call('stats')).length;
      if (fixture.mode === 'power') {
        await expect(call('content-metadata', { handle, input })).rejects.toThrow('content-metadata-unavailable');
        for (const [kind, id] of [['label', fixture.label], ['relation', fixture.relation]]) await expect(rpc('content.metadata.read', { vaultHandle: handle, kind, id, writeRevision: revision, offset: 0, limit: 262144 })).rejects.toThrow('content-metadata-unavailable');
        evidence.powerDenial = true;
      } else {
        const catalog = await call('content-metadata', { handle, input }) as Mdbx2ContentMetadata;
        expect(catalog.labels).toHaveLength(2); expect(catalog.assignments).toHaveLength(1); expect(catalog.relations).toHaveLength(1);
        expect(catalog.labels.find(row => row.labelId === fixture.tombstone)).toMatchObject({ deleted: true, payloadJson: null });
        expect(catalog.labels.find(row => row.labelId === fixture.label)?.payloadJson).toBe(fixture.payloadJson);
        expect(catalog.relations[0].payloadJson).toBe(fixture.payloadJson);
        expect(catalog.relations[0].payloadJson).toContain('9007199254740993'); expect(catalog.relations[0].payloadJson).toContain('1.00000000000000001');
        // Authorized disclosure retains its native security-audit writes. These
        // must not alter the content revision, or mix catalog generations.
        expect(await rpc('vault.writeRevision', { vaultHandle: handle })).toEqual(revision);
        evidence.metadataPolicyAuditCommits = (await call('stats')).length - before;
        await rpc('collection.rename', { vaultHandle: handle, collectionId: fixture.owner, operationId: randomUUID(), title: 'Changed synthetic owner' });
        await expect(call('content-metadata', { handle, input })).rejects.toThrow('content-metadata-stale');
        evidence.precisionChunksTombstonesStableContentRevisionAndStaleGuard = true;
      }
      await rpc('vault.lock', { vaultHandle: handle });
      await expect(call('content-metadata', { handle, input })).rejects.toThrow('vault-locked');
    }
    await call('close'); evidence.status = 'passed';
    evidence.engineBuild = JSON.parse(await readFile('native/mdbx2-browser/pkg/BROWSER-BUILD.json', 'utf8'));
  } finally { await context?.close(); await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
