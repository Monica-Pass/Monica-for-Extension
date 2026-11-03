import { test, expect, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import type { Mdbx2ContentAttachments } from '../../src/providers/mdbx2/content-attachments';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
test('bundled MDBX atomically adopts content and assets with durable replay and original Passkey signing', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(240_000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'), db = `synthetic-content-${randomUUID()}`;
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Monica synthetic content write acceptance', version: '1.0.0', background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'" } }));
  await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Synthetic content write acceptance</title><script src="harness.js"></script>');
  for (const file of ['engine.js', 'monica_mdbx2_browser.wasm']) await copyFile(path.resolve('native/mdbx2-browser/pkg', file), path.join(extension, file));
  await build({ entryPoints: ['tests/e2e/fixtures/mdbx-browser-worker.ts'], outfile: path.join(extension, 'worker.js'), bundle: true, format: 'esm', target: 'chrome130', external: ['./engine.js'], alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') } });
  await writeFile(path.join(extension, 'harness.js'), `const worker=new Worker('./worker.js',{type:'module'}),pending=new Map();worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error.code+': '+data.error.message)):p.resolve(data.result);};window.probe=(op,data)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,op,data});});`);
  let context: BrowserContext | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', androidApplicationAcceptance: false };
  try {
    const connect = async () => {
      context = await launchEdgeContext(path.join(run, 'profile'), { args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
      evidence.edgeVersion = context.browser()?.version();
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      return (op: string, data?: unknown): Promise<any> => page.evaluate(({ op, data }) => (window as unknown as { probe: (op: string, data: unknown) => Promise<unknown> }).probe(op, data), { op, data });
    };
    let call = await connect();
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const response = await call('rpc', { protocol: 2, requestId: randomUUID(), method, params });
      if (!response.ok) throw Error(response.error.code); return response.result;
    };
    await call('open', { name: db });
    const password = 'synthetic-content-write-acceptance-password';
    const opened = await rpc('vault.create', { password, mode: 'multi' }), handle = opened.vaultHandle;
    expect((await rpc('host.hello')).supportsContentWrite).toBe(true);
    expect((await rpc('host.hello')).supportsContentAttachments).toBe(true);
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKey = key.privateKey.export({ format: 'der', type: 'pkcs8' }), publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const credential = randomBytes(32).toString('base64'), owner = randomUUID(), objectId = randomUUID(), labelId = randomUUID(), attachmentId = randomUUID(), assetId = randomUUID();
    const folderAttachmentId = randomUUID();
    const secret = 'synthetic-content-write-private-payload';
    const payload = JSON.stringify({ credential_id: credential, private_key_alias: privateKey.toString('base64'), sign_count: 0, secret }).replace('"sign_count":0', '"sign_count":0,"large":9007199254740993,"decimal":1.00000000000000001');
    const bytes = Buffer.from(Array.from({ length: 280_000 }, (_, n) => n % 251));
    const before = await rpc('vault.writeRevision', { vaultHandle: handle });
    const input = { operationId: randomUUID(), writeRevision: before, plan: { commands: [
      { kind: 'collection-create', collectionId: owner, title: 'Synthetic imported folder' },
      { kind: 'object-create', objectId, collectionId: owner, objectTypeId: 'passkey', title: 'Original portable Passkey', payloadJson: payload },
      { kind: 'label-create', labelId, collectionId: owner, name: 'Synthetic imported tag', payloadJson: '{"original":true}', payloadSchemaVersion: 3 },
      { kind: 'label-assign', assignmentId: randomUUID(), objectId, labelId }
    ], attachments: [
      { kind: 'create', attachmentId, collectionId: owner, objectId, fileName: 'synthetic.bin', assetId },
      { kind: 'create', attachmentId: folderAttachmentId, collectionId: owner, objectId: null, fileName: 'synthetic-folder.bin', assetId }
    ] }, assets: [{ id: assetId, base64: bytes.toString('base64') }] };
    const commitsBefore = (await call('stats')).length;
    const receipt = await call('content-write', { handle, input });
    expect(receipt.alreadyCommitted).toBe(false);
    expect((await call('stats')).length - commitsBefore).toBe(1);
    const saved = await rpc('object.reveal', { vaultHandle: handle, objectId });
    expect(saved.payloadJson).toContain('9007199254740993'); expect(saved.payloadJson).toContain('1.00000000000000001');
    expect(await call('verify-key', { payload: saved.payloadJson, expected: { id: credential, hash: sha(privateKey), publicKey, counter: 0 } })).toBe(true);
    const revision = await rpc('vault.writeRevision', { vaultHandle: handle });
    await expect(call('content-write', { handle, input: { ...input, operationId: randomUUID() } })).rejects.toThrow('content-write-stale');
    expect(await rpc('vault.writeRevision', { vaultHandle: handle })).toEqual(revision);
    const metadata = await call('content-metadata', { handle, input: { writeRevision: revision, collectionIds: [owner], objectIds: [objectId] } });
    expect(metadata.labels[0].headCommitId).toBe(receipt.commitId); expect(metadata.assignments).toHaveLength(1);
    const catalog = await call('content-attachments', { handle, input: { writeRevision: revision, collectionIds: [owner] } }) as Mdbx2ContentAttachments;
    expect(catalog.attachments).toHaveLength(2);
    const folderAsset = catalog.attachments.find(row => row.attachmentId === folderAttachmentId)!;
    expect(folderAsset).toMatchObject({ collectionId: owner, objectId: null, contentHash: sha(bytes), headCommitId: receipt.commitId, deleted: false });
    expect(await call('content-attachment-bytes', { handle, input: { writeRevision: revision, attachment: folderAsset } })).toEqual({ sizeBytes: bytes.length, sha256: sha(bytes) });
    // A failed attachment must roll back the preceding generic mutation.
    const failedOwner = randomUUID(), bad = structuredClone(input); bad.operationId = randomUUID(); bad.writeRevision = revision;
    bad.plan.commands = [{ kind: 'collection-create', collectionId: failedOwner, title: 'Must roll back' }];
    bad.plan.attachments = [{ ...input.plan.attachments[0], attachmentId: randomUUID(), collectionId: failedOwner, objectId: randomUUID() }];
    await expect(call('content-write', { handle, input: bad })).rejects.toThrow('content-write-outcome-unknown');
    expect(await rpc('vault.writeRevision', { vaultHandle: handle })).toEqual(revision);
    // Restart the actual browser, then recover the original commit at its old revision.
    await call('close'); await context!.close(); call = await connect(); await call('open', { name: db });
    await rpc('vault.open', { source: { kind: 'vault', handle }, credential: { method: 'password', password } });
    const replay = await call('content-write', { handle, input });
    expect(replay).toEqual({ ...receipt, alreadyCommitted: true });
    expect(await call('content-attachments', { handle, input: { writeRevision: revision, collectionIds: [owner] } })).toEqual(catalog);
    expect(await call('content-attachment-bytes', { handle, input: { writeRevision: revision, attachment: folderAsset } })).toEqual({ sizeBytes: bytes.length, sha256: sha(bytes) });
    const reopened = await rpc('object.reveal', { vaultHandle: handle, objectId });
    expect(await call('verify-key', { payload: reopened.payloadJson, expected: { id: credential, hash: sha(privateKey), publicKey, counter: 0 } })).toBe(true);
    const read = await rpc('attachment.read.begin', { vaultHandle: handle, attachmentId }), pieces: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 262144) {
      const part = await rpc('attachment.read.chunk', { readHandle: read.readHandle, offset, maxBytes: 262144 }); pieces.push(Buffer.from(part.dataBase64, 'base64'));
    }
    expect(sha(Buffer.concat(pieces))).toBe(sha(bytes)); await rpc('attachment.read.release', { readHandle: read.readHandle });
    await call('content-write', { handle, input: { operationId: randomUUID(), writeRevision: revision, plan: { commands: [], attachments: [{ kind: 'delete', attachmentId: folderAttachmentId }] }, assets: [] } });
    await expect(call('content-attachments', { handle, input: { writeRevision: revision, collectionIds: [owner] } })).rejects.toThrow('content-attachments-stale');
    await expect(call('content-attachment-bytes', { handle, input: { writeRevision: revision, attachment: folderAsset } })).rejects.toThrow('content-attachments-stale');
    const afterDelete = await rpc('vault.writeRevision', { vaultHandle: handle });
    const deletedCatalog = await call('content-attachments', { handle, input: { writeRevision: afterDelete, collectionIds: [owner] } }) as Mdbx2ContentAttachments;
    expect(deletedCatalog.attachments).toHaveLength(2);
    expect(deletedCatalog.attachments.find(row => row.attachmentId === folderAttachmentId)).toMatchObject({ objectId: null, contentHash: folderAsset.contentHash, deleted: true });
    await expect(rpc('content.attachments.begin', { vaultHandle: handle, attachmentId: folderAttachmentId, writeRevision: afterDelete })).rejects.toThrow('attachment-deleted');
    await rpc('vault.lock', { vaultHandle: handle });
    await expect(call('content-attachments', { handle, input: { writeRevision: afterDelete, collectionIds: [owner] } })).rejects.toThrow('vault-locked');
    await call('scan', [secret, privateKey.toString('base64'), password]);
    await call('close');
    Object.assign(evidence, { status: 'passed', atomicDurableCommit: true, attachmentFailureRollback: true, actualBrowserRestartReplay: true, originalPasskeySigning: true, zeroCounterPreserved: true, assetSha256: sha(bytes), folderAttachmentCatalog: true, revisionBoundAttachmentDownload: true, attachmentTombstonePreserved: true, staleAndLockRejection: true, durablePlaintextScan: true, engineBuild: JSON.parse(await readFile('native/mdbx2-browser/pkg/BROWSER-BUILD.json', 'utf8')) });
  } finally { await context?.close(); await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
