import { test, expect, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import type { NearbyNativeSource } from '../../src/nearby/native-source';
import type { NearbyNativeMetadataRecord } from '../../src/nearby/native-metadata';
import type { NearbyNativeProjection } from '../../src/nearby/native-records';

test('native nearby catalog adopts folder and root metadata while preserving original content and blocked rows', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(240_000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'), database = `synthetic-nearby-catalog-${randomUUID()}`;
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Monica synthetic native nearby catalog', version: '1.0.0', background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'" } }));
  await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Synthetic native catalog</title><script src="harness.js"></script>');
  for (const name of ['engine.js', 'monica_mdbx2_browser.wasm']) await copyFile(path.resolve('native/mdbx2-browser/pkg', name), path.join(extension, name));
  await build({ entryPoints: ['tests/e2e/fixtures/mdbx-browser-worker.ts'], outfile: path.join(extension, 'worker.js'), bundle: true, format: 'esm', target: 'chrome130', external: ['./engine.js'], alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') } });
  await writeFile(path.join(extension, 'harness.js'), `const worker=new Worker('./worker.js',{type:'module'}),pending=new Map();worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error.code+': '+data.error.message)):p.resolve(data.result);};window.probe=(op,data)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});worker.postMessage({id,op,data});});`);
  let context: BrowserContext | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', androidApplicationAcceptance: false, fullNearbyCoordinator: false };
  try {
    const connect = async () => {
      context = await launchEdgeContext(path.join(run, 'profile'), { args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
      evidence.edgeVersion = context.browser()?.version();
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
      await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      return (op: string, data?: unknown): Promise<any> => page.evaluate(({ op, data }) => (window as unknown as { probe: (op: string, data: unknown) => Promise<unknown> }).probe(op, data), { op, data });
    };
    let call = await connect();
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const result = await call('rpc', { protocol: 2, requestId: randomUUID(), method, params }); if (!result.ok) throw Error(result.error.code); return result.result;
    };
    await call('open', { name: database });
    const password = 'synthetic-nearby-catalog-password', handle = (await rpc('vault.create', { password, mode: 'multi' })).vaultHandle, providerId = randomUUID();
    const capture = (): Promise<NearbyNativeSource> => call('nearby-native-source', { providerId, vaultHandle: handle });
    const empty = await capture(), folderA = randomUUID(), folderB = randomUUID(), child = randomUUID(), rootOwner = randomUUID();
    const folder = (id: string, title: string) => ({ kind: 'folder', id, expectedGuard: null, deleted: false, data: { title, folder: '', entry_type: 'folder', payload: { path: [{ id, title, parent: null }], tags: [] } } });
    const nested = folder(child, 'Nested'); nested.data.payload.path = [{ id: folderB, title: 'Same name', parent: null }, { id: child, title: 'Nested', parent: folderB } as any];
    const rootData = { title: 'Transferred root', folder: '', entry_type: 'vault-metadata', payload: { tags: [{ name: 'Owned tag', payload: '{"kind":"monica-project-tag","unknown":9007199254740993}', version: 7 }], opaque: '{"decimal":1.00000000000000001}' }, future: { retained: true } };
    const operationId = randomUUID(), commands = await call('nearby-native-plan', { source: empty, operationId, changes: [folder(folderA, 'Same name'), nested, { kind: 'root', id: rootOwner, expectedGuard: null, deleted: false, data: rootData }] });
    const objectId = randomUUID(), unassignedId = randomUUID(), freeTagId = randomUUID(), trashId = randomUUID(), key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKey = key.privateKey.export({ format: 'der', type: 'pkcs8' }), publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const credential = Buffer.from('synthetic-existing-credential').toString('base64'), passkey = JSON.stringify({ credential_id: credential, rp_id: 'example.test', user_id: 'dXNlcg', public_key: publicKey, public_key_algorithm: -7, private_key_alias: privateKey.toString('base64'), key_status: 'portable', sign_count: 0 });
    commands.push({ kind: 'object-create', objectId, collectionId: child, objectTypeId: 'passkey', title: 'Existing Passkey', payloadJson: passkey },
      { kind: 'object-create', objectId: trashId, collectionId: folderA, objectTypeId: 'note', title: 'Retained deleted note', payloadJson: '{"item_data":"synthetic retained text","deleted_at":123}' },
      { kind: 'label-create', labelId: unassignedId, collectionId: child, name: 'Unassigned future metadata', payloadJson: '{"future":9007199254740993}', payloadSchemaVersion: 8 },
      { kind: 'label-create', labelId: freeTagId, collectionId: empty.rootId, name: 'Root own tag', payloadJson: '{"kind":"monica-project-tag"}', payloadSchemaVersion: 1 });
    const assetId = randomUUID(), folderAsset = randomUUID(), bytes = Buffer.alloc(280000, 0x5a);
    const receipt = await call('content-write', { handle, input: { operationId, writeRevision: empty.writeRevision, plan: { commands, attachments: [{ kind: 'create', attachmentId: folderAsset, collectionId: folderB, objectId: null, fileName: 'folder.bin', assetId }] }, assets: [{ id: assetId, base64: bytes.toString('base64') }] } });
    let source = await capture(), meta = await call('nearby-native-metadata', source) as NearbyNativeMetadataRecord[];
    expect(source.collections.find(row => row.collectionId === folderB)?.title).toBe(`Same name [${folderB.slice(0, 8)}]`);
    expect(meta.find(row => row.id === folderB)?.data).toMatchObject({ title: 'Same name' });
    expect(meta.find(row => row.id === rootOwner)?.data).toEqual(rootData);
    expect(meta.find(row => row.id === empty.rootId)?.data).toMatchObject({ payload: { tags: [{ name: 'Root own tag' }] } });
    expect(source.metadata.labels.find(row => row.labelId === unassignedId)).toMatchObject({ payloadSchemaVersion: 8, payloadJson: '{"future":9007199254740993}' });
    let projection = await call('nearby-native-project', source) as NearbyNativeProjection;
    expect(projection.records.find(row => row.global_id === objectId)?.data).toMatchObject({ entry_type: 'passkey', folder: 'Nested', payload: { private_key_alias: privateKey.toString('base64'), credential_id: credential, sign_count: 0 } });
    expect(projection.blockers).toEqual([]);
    expect(projection.records.find(row=>row.global_id===child)?.data.labels).toEqual([{name:'Unassigned future metadata',payload:'{"future":9007199254740993}',version:8}]);
    expect(projection.records.find(row=>row.global_id===folderB)?.data.assets).toMatchObject([{attachment_id:folderAsset,size:bytes.length}]);
    const beforeChange = source;
    const changeOp = randomUUID(), planned = await call('nearby-native-plan', { source, operationId: changeOp, changes: [{ kind: 'root', id: rootOwner, expectedGuard: meta.find(row => row.id === rootOwner)!.guard, deleted: true, data: {} },
      { ...folder(folderA, 'Renamed'), expectedGuard: meta.find(row => row.id === folderA)!.guard },
      { ...folder(folderB, `Same name [${folderB.slice(0, 8)}]`), expectedGuard: meta.find(row => row.id === folderB)!.guard }] });
    planned.push({ kind: 'object-delete', objectId: trashId, collectionId: folderA });
    await call('content-write', { handle, input: { operationId: changeOp, writeRevision: source.writeRevision, plan: { commands: planned, attachments: [] }, assets: [] } });
    await expect(call('content-write', { handle, input: { operationId: randomUUID(), writeRevision: beforeChange.writeRevision, plan: { commands: [{ kind: 'collection-rename', collectionId: folderA, title: 'Stale overwrite' }], attachments: [] }, assets: [] } })).rejects.toThrow('content-write-stale');
    await call('close'); await context!.close(); call = await connect(); await call('open', { name: database });
    await rpc('vault.open', { source: { kind: 'vault', handle }, credential: { method: 'password', password } });
    source = await capture(); meta = await call('nearby-native-metadata', source) as NearbyNativeMetadataRecord[]; projection = await call('nearby-native-project', source);
    expect(meta.find(row => row.id === folderA)?.data).toMatchObject({ title: 'Renamed' });
    expect(meta.find(row => row.id === folderB)?.data).toMatchObject({ title: `Same name [${folderB.slice(0, 8)}]` });
    expect(meta.find(row => row.id === rootOwner)).toMatchObject({ deleted: true, data: {} });
    expect(source.metadata.labels.find(row => row.labelId === freeTagId)?.deleted).toBe(false);
    expect(source.metadata.labels.find(row => row.labelId === unassignedId)?.deleted).toBe(false);
    expect(source.objects.find(row => row.summary.objectId === trashId)).toMatchObject({ summary: { deleted: true }, record: {deleted:true} });
    expect(projection.records.find(row => row.global_id === trashId)).toMatchObject({deleted:true,data:{trashed:true,payload:{item_data:'synthetic retained text'}}});
    expect(await call('verify-key', { payload: source.objects.find(row => row.summary.objectId === objectId)!.record!.payloadJson, expected: { id: credential, hash: createHash('sha256').update(privateKey).digest('hex'), publicKey, counter: 0 } })).toBe(true);
    const file = source.attachments.find(row => row.attachmentId === folderAsset)!;
    expect(await call('content-attachment-bytes', { handle, input: { writeRevision: source.writeRevision, attachment: file } })).toEqual({ sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await call('scan', [password, privateKey.toString('base64'), 'synthetic retained text']); await call('close');
    Object.assign(evidence, { status: 'passed', rootOwnerIsolation: true, logicalFolderNames: true, storedNameRenameAfterRestart: true, nativeMetadataAtomicAdoption: true, originalPasskeySignature: true, zeroCounterPreserved: true,
      unassignedAndDeletedInventory: true, completeSupportedScan: true, actualBrowserRestart: true, assetHashVerified: true, receiptCommit: receipt.commitId, engineBuild: JSON.parse(await readFile('native/mdbx2-browser/pkg/BROWSER-BUILD.json', 'utf8')) });
  } finally { await context?.close(); await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
