import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { ProcessNativeRuntime } from '../interop/mdbx2-interop-support';
import { Mdbx2NativeClient } from '../../src/providers/mdbx2/native-client';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const PASSWORD = 'synthetic-browser-mdbx-probe-password';
const SECRET = 'synthetic-browser-runtime-secret';
type Harness = { start(name: string): void; stop(name: string): void; call(name: string, op: string, data?: unknown): Promise<any>; events: string[] };
const call = (page: Page, name: string, op: string, data?: unknown) => page.evaluate(({ name, op, data }) => (window as unknown as { probe: Harness }).probe.call(name, op, data), { name, op, data });
const rpc = async (page: Page, method: string, params: Record<string, unknown> = {}, name = 'a') => {
  const result = await call(page, name, 'rpc', { protocol: 2, requestId: randomUUID(), method, params });
  expect(result.ok, `${method}: ${result.error?.code || ''}`).toBe(true); return result.result;
};

test('production browser MDBX engine durably commits blocks, keys and attachments without Native Messaging', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge acceptance');
  test.setTimeout(240_000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension');
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Monica production browser MDBX synthetic acceptance', version: '1.0.0', background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" } }));
  await writeFile(path.join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Monica synthetic MDBX browser acceptance</title><script src="harness.js"></script>');
  for (const file of ['engine.js', 'monica_mdbx2_browser.wasm']) await copyFile(path.resolve('native/mdbx2-browser/pkg', file), path.join(extension, file));
  await build({ entryPoints: ['tests/e2e/fixtures/mdbx-browser-worker.ts'], outfile: path.join(extension, 'worker.js'), bundle: true, format: 'esm', target: 'chrome130', external: ['./engine.js'], alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') } });
  await writeFile(path.join(extension, 'harness.js'), `const workers=new Map();window.probe={events:[],start(name){const w=new Worker('./worker.js',{type:'module'});const pending=new Map();w.onmessage=({data})=>{if(data.event){probe.events.push(name+':'+data.event);return;}const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Object.assign(Error(data.error.message),data.error)):p.resolve(data.result);};w.onerror=e=>{for(const p of pending.values())p.reject(Error(e.message));pending.clear();};workers.set(name,{w,pending});},stop(name){const item=workers.get(name);if(!item)return;item.w.terminate();for(const p of item.pending.values())p.reject(Error('worker terminated'));workers.delete(name);},call(name,op,data){const {w,pending}=workers.get(name),id=crypto.randomUUID();return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});w.postMessage({id,op,data});});}};`);
  const profile = path.join(run, 'profile');
  let context: BrowserContext | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', nativeMessagingUsed: false, managerUiAcceptance: false, androidApplicationAcceptance: false };
  const launch = async () => {
    context = await launchEdgeContext(profile, { args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    evidence.edgeVersion = context.browser()?.version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await page.evaluate(() => (window as unknown as { probe: Harness }).probe.start('a'));
    return page;
  };
  const restartWorker = async (page: Page, name = 'a') => {
    await page.evaluate(name => { const { probe } = window as unknown as { probe: Harness }; probe.stop(name); probe.start(name); }, name);
  };
  try {
    let page = await launch();
    evidence.filesystem = await call(page, 'a', 'fs-suite');
    evidence.lifecycle = await call(page, 'a', 'lifecycle-suite');
    const db = `synthetic-engine-${randomUUID()}`;
    await call(page, 'a', 'open', { name: db });
    const hello = await rpc(page, 'host.hello'); expect(hello.runtimeKind).toBe('browser'); expect(hello.supportsWindowsHello).toBe(false); expect(hello.nearbyTransportVersion).toBe(0);
    for (const method of ['hello.status', 'nearby.call']) {
      const denied = await call(page, 'a', 'rpc', { protocol: 2, requestId: randomUUID(), method, params: {} }); expect(denied.ok).toBe(false); expect(denied.error.code).toBe('browser-native-capability-unavailable');
    }
    await page.evaluate(() => (window as unknown as { probe: Harness }).probe.start('b'));
    await expect(call(page, 'b', 'open', { name: db })).rejects.toThrow('already-open');
    const refs: any[] = [];
    const seed = await page.evaluate(async () => {
      const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const enc = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
      return { credential_id: enc(crypto.getRandomValues(new Uint8Array(32)).buffer), rp_id: 'browser-mdbx.example.test', user_id: 'AQID', private_key_alias: enc(await crypto.subtle.exportKey('pkcs8', key.privateKey)), public_key: enc(await crypto.subtle.exportKey('spki', key.publicKey)), public_key_algorithm: -7, key_status: 'portable', backup_eligible: true, backup_state: true };
    });
    const expected = { id: seed.credential_id, hash: sha(Buffer.from(seed.private_key_alias, 'base64')), publicKey: seed.public_key };
    for (const [index, mode] of ['sky', 'multi', 'power'].entries()) {
      const opened = await rpc(page, 'vault.create', { password: PASSWORD, mode });
      const vaultHandle = opened.vaultHandle; expect(typeof vaultHandle).toBe('string');
      const written = await rpc(page, 'object.upsert', { vaultHandle, operationId: randomUUID(), logicalObjectId: `password:${mode}`, collectionId: null, objectTypeId: 'login', title: `Synthetic ${mode}`, payloadJson: JSON.stringify({ monica_entry_id: `password:${mode}`, password_plain: SECRET, large: 'fixture'.repeat(8000), exact: { '$serde_json::private::Number': 'literal marker' } }).replace('"exact":', '"precise":9007199254740993,"negativeZero":-0,"decimal":1.00000000000000001,"exact":') });
      const counter = index === 1 ? 19 : 0;
      const key = await rpc(page, 'object.upsert', { vaultHandle, operationId: randomUUID(), logicalObjectId: `passkey:${mode}`, collectionId: written.collectionId, objectTypeId: 'passkey', title: `Synthetic ${mode} key`, payloadJson: JSON.stringify({ ...seed, monica_entry_id: `passkey:${mode}`, sign_count: counter }) });
      const ref = { vaultHandle, objectId: written.objectId, collectionId: written.collectionId, keyId: key.objectId, mode, counter }; refs.push(ref);
      if (mode === 'power') {
        const denied = await call(page, 'a', 'rpc', { protocol: 2, requestId: randomUUID(), method: 'object.reveal', params: { vaultHandle, objectId: key.objectId } });
        expect(denied.error?.code).toBe('object-disclosure-denied');
      } else {
        const revealed = await rpc(page, 'object.reveal', { vaultHandle, objectId: key.objectId });
        expect(await call(page, 'a', 'verify-key', { payload: revealed.payloadJson, expected: { ...expected, counter } })).toBe(true);
      }
    }
    const ref = refs[0], attachment = Buffer.from(Array.from({ length: 600_000 }, (_, i) => i % 251));
    const upload = await rpc(page, 'attachment.upload.begin', { vaultHandle: ref.vaultHandle, operationId: randomUUID(), attachmentId: randomUUID(), collectionId: ref.collectionId, objectId: ref.objectId, fileName: 'synthetic.bin', mediaType: 'application/octet-stream', sizeBytes: attachment.length, sha256: sha(attachment), mode: 'create' });
    for (let offset = 0; offset < attachment.length; offset += 256 * 1024) await rpc(page, 'attachment.upload.chunk', { transferId: upload.transferId, offset, dataBase64: attachment.subarray(offset, offset + 256 * 1024).toString('base64') });
    const finished = await rpc(page, 'attachment.upload.finish', { transferId: upload.transferId });
    const attachmentId = finished.attachment.attachmentId; expect(typeof attachmentId).toBe('string');
    evidence.encryptedFiles = await call(page, 'a', 'scan', [PASSWORD, SECRET, seed.private_key_alias]);
    const beforeRead = (await call(page, 'a', 'stats')).length;
    for (let i = 0; i < 5; i++) await rpc(page, 'object.reveal', { vaultHandle: ref.vaultHandle, objectId: ref.objectId });
    expect((await call(page, 'a', 'stats')).length).toBe(beforeRead);
    evidence.readOnlyCommits = 0;
    // Kill a live Worker without closing SQLite. Fresh Worker must recover the WAL.
    await restartWorker(page); await call(page, 'a', 'open', { name: db });
    const verify = async (page: Page) => {
      for (const r of refs) {
        const wrong = await call(page, 'a', 'rpc', { protocol: 2, requestId: randomUUID(), method: 'vault.open', params: { source: { kind: 'vault', handle: r.vaultHandle }, credential: { method: 'password', password: 'wrong' } } }); expect(wrong.ok).toBe(false);
        await rpc(page, 'vault.open', { source: { kind: 'vault', handle: r.vaultHandle }, credential: { method: 'password', password: PASSWORD } });
        if (r.mode === 'power') {
          const denied = await call(page, 'a', 'rpc', { protocol: 2, requestId: randomUUID(), method: 'object.reveal', params: { vaultHandle: r.vaultHandle, objectId: r.keyId } });
          expect(denied.error?.code).toBe('object-disclosure-denied'); continue;
        }
        const key = await rpc(page, 'object.reveal', { vaultHandle: r.vaultHandle, objectId: r.keyId });
        expect(await call(page, 'a', 'verify-key', { payload: key.payloadJson, expected: { ...expected, counter: r.counter } })).toBe(true);
        const password = await rpc(page, 'object.reveal', { vaultHandle: r.vaultHandle, objectId: r.objectId });
        expect(password.payloadJson).toContain('9007199254740993'); expect(password.payloadJson).toContain('1.00000000000000001'); expect(JSON.parse(password.payloadJson).password_plain).toBe(SECRET);
      }
      const read = await rpc(page, 'attachment.read.begin', { vaultHandle: ref.vaultHandle, attachmentId });
      const parts: Buffer[] = [];
      for (let offset = 0; offset < attachment.length; offset += 256 * 1024) { const part = await rpc(page, 'attachment.read.chunk', { readHandle: read.readHandle, offset, maxBytes: 256 * 1024 }); parts.push(Buffer.from(part.dataBase64, 'base64')); }
      expect(sha(Buffer.concat(parts))).toBe(sha(attachment)); await rpc(page, 'attachment.read.release', { readHandle: read.readHandle });
    };
    await verify(page);
    const unchangedHead = await call(page, 'a', 'head');
    await call(page, 'a', 'abort');
    await expect(rpc(page, 'object.upsert', { vaultHandle: ref.vaultHandle, operationId: randomUUID(), logicalObjectId: 'password:sky', collectionId: ref.collectionId, objectTypeId: 'login', title: 'Aborted change', payloadJson: JSON.stringify({ monica_entry_id: 'password:sky', password_plain: 'uncommitted secret' }) })).rejects.toThrow('commit-failed');
    expect(await call(page, 'a', 'head')).toEqual(unchangedHead);
    await expect(rpc(page, 'host.hello')).rejects.toThrow('closed');
    await restartWorker(page); await call(page, 'a', 'open', { name: db }); await verify(page);
    evidence.abortRollback = true;
    // A committed response can be lost. Worker restart must expose the committed
    // generation; the adapter must not replay the write itself.
    await call(page, 'a', 'hold', 'after');
    const lost = rpc(page, 'object.upsert', { vaultHandle: ref.vaultHandle, operationId: randomUUID(), logicalObjectId: 'note:lost-reply', collectionId: ref.collectionId, objectTypeId: 'note', title: 'Committed lost reply', payloadJson: '{"monica_entry_id":"note:lost-reply","note":"durable"}' }).catch(e => String(e));
    await page.waitForFunction(() => (window as unknown as { probe: Harness }).probe.events.includes('a:held-after'));
    const committed = await call(page, 'a', 'head');
    await restartWorker(page); await lost;
    await call(page, 'a', 'open', { name: db }); expect((await call(page, 'a', 'head')).generation).toBeGreaterThanOrEqual(committed.generation);
    await verify(page);
    evidence.workerCrashAndLostReplyRecovery = true;
    const recoveredNotes = await rpc(page, 'object.list', { vaultHandle: ref.vaultHandle, collectionId: ref.collectionId, objectTypeId: 'note', pageSize: 50 });
    expect(recoveredNotes.items.filter((item: { title: string }) => item.title === 'Committed lost reply')).toHaveLength(1);
    const durableNote = await rpc(page, 'object.reveal', { vaultHandle: ref.vaultHandle, objectId: recoveredNotes.items.find((item: { title: string }) => item.title === 'Committed lost reply').objectId });
    expect(JSON.parse(durableNote.payloadJson).note).toBe('durable');
    await call(page, 'a', 'hold', 'before');
    const closingWrite = rpc(page, 'object.upsert', { vaultHandle: ref.vaultHandle, operationId: randomUUID(), logicalObjectId: 'note:closing', collectionId: ref.collectionId, objectTypeId: 'note', title: 'Closing write', payloadJson: '{"monica_entry_id":"note:closing","note":"saved before closing"}' }).catch(e => String(e));
    await page.waitForFunction(() => (window as unknown as { probe: Harness }).probe.events.includes('a:held-before'));
    const closing = call(page, 'a', 'close');
    await call(page, 'a', 'release'); expect(await closingWrite).toContain('closed'); await closing;
    await restartWorker(page); await call(page, 'a', 'open', { name: db }); await verify(page);
    const closedNotes = await rpc(page, 'object.list', { vaultHandle: ref.vaultHandle, collectionId: ref.collectionId, objectTypeId: 'note', pageSize: 50 });
    expect(closedNotes.items.filter((item: { title: string }) => item.title === 'Closing write')).toHaveLength(1);
    evidence.closeDuringCommitSuppressesResponseAndPreservesWrite = true;
    for (const r of refs) await rpc(page, 'vault.lock', { vaultHandle: r.vaultHandle });
    await call(page, 'a', 'close'); await context!.close(); context = undefined;
    page = await launch(); await call(page, 'a', 'open', { name: db }); await verify(page);
    // Complete backup includes encrypted external blobs and is independently
    // hashed after reassembling the bounded export chunks.
    const backup = await rpc(page, 'vault.export.begin', { vaultHandle: ref.vaultHandle }); const output: Buffer[] = [];
    for (let offset = 0; offset < backup.sizeBytes; offset += 256 * 1024) { const part = await rpc(page, 'vault.export.read', { vaultHandle: ref.vaultHandle, fileHandle: backup.fileHandle, offset, maxBytes: 256 * 1024 }); output.push(Buffer.from(part.dataBase64, 'base64')); }
    expect(sha(Buffer.concat(output))).toBe(backup.sha256); expect(backup.blobCount).toBeGreaterThan(0);
    await rpc(page, 'vault.export.release', { fileHandle: backup.fileHandle });
    evidence.completeBackup = { bytes: backup.sizeBytes, blobs: backup.blobCount, sha256: backup.sha256 };
    const archive = unzipSync(Buffer.concat(output)), nativeDir = path.join(run, 'native-readback'); await mkdir(nativeDir);
    for (const [name, bytes] of Object.entries(archive)) {
      expect(name === 'vault.mdbx' || /^vault\.mdbx\.blobs\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(name)).toBe(true);
      const destination = path.join(nativeDir, name); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    }
    // Use the reproducible production helper instead of an untracked probe EXE.
    // Its isolated process opens the actual browser backup and returns a native
    // edit with the original object IDs, precise JSON numbers and key intact.
    const nativeExe = path.resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe');
    const native = new Mdbx2NativeClient(new ProcessNativeRuntime(nativeExe, path.join(nativeDir, 'host-data')));
    let roundtrip: Buffer;
    try {
      const bytes = Buffer.concat(output);
      const transfer = await native.beginInboundTransfer(bytes.length, sha(bytes));
      for (let offset = 0; offset < bytes.length;) {
        const sent = await native.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes));
        offset = sent.nextOffset;
      }
      const file = await native.finishInboundTransfer(transfer.transferId);
      const opened = await native.openVault({ kind: 'file', handle: file.fileHandle }, { method: 'password', password: PASSWORD });
      const password = await native.revealObject(opened.vaultHandle, ref.objectId);
      expect(password.payloadJson).toContain('9007199254740993');
      expect(password.payloadJson).toContain('1.00000000000000001');
      expect(JSON.parse(password.payloadJson).password_plain).toBe(SECRET);
      const key = await native.revealObject(opened.vaultHandle, ref.keyId);
      expect(sha(Buffer.from(JSON.parse(key.payloadJson).private_key_alias, 'base64'))).toBe(expected.hash);
      const updated = await native.upsertObject(opened.vaultHandle, randomUUID(), { logicalObjectId: 'password:sky', collectionId: ref.collectionId, objectTypeId: 'login', title: password.title, payloadJson: password.payloadJson.replace(/}\s*$/, ',"native_roundtrip":true}') });
      expect(updated.objectId).toBe(ref.objectId);
      const prepared = await native.prepareCompleteBackup(opened.vaultHandle);
      const chunks: Buffer[] = [];
      try {
        for (let offset = 0; offset < prepared.sizeBytes;) {
          const part = await native.readCompleteBackup(opened.vaultHandle, prepared.fileHandle, offset, 256 * 1024);
          chunks.push(Buffer.from(part.dataBase64, 'base64')); offset = part.nextOffset;
        }
        roundtrip = Buffer.concat(chunks);
        expect(sha(roundtrip)).toBe(prepared.sha256);
      } finally { await native.releaseCompleteBackup(prepared.fileHandle); }
    } finally { native.close(); }
    await page.evaluate(() => (window as unknown as { probe: Harness }).probe.start('c'));
    await call(page, 'c', 'open', { name: `synthetic-native-${randomUUID()}` });
    const uploaded = await rpc(page, 'transfer.begin', { direction: 'extension-to-host', purpose: 'vault-bootstrap', sizeBytes: roundtrip.length, sha256: sha(roundtrip) }, 'c');
    for (let offset = 0; offset < roundtrip.length; offset += 256 * 1024) await rpc(page, 'transfer.chunk', { transferId: uploaded.transferId, offset, dataBase64: roundtrip.subarray(offset, offset + 256 * 1024).toString('base64') }, 'c');
    const imported = await rpc(page, 'transfer.finish', { transferId: uploaded.transferId }, 'c');
    const openedNative = await rpc(page, 'vault.open', { source: { kind: 'file', handle: imported.fileHandle }, credential: { method: 'password', password: PASSWORD } }, 'c');
    const nativePayload = await rpc(page, 'object.reveal', { vaultHandle: openedNative.vaultHandle, objectId: ref.objectId }, 'c');
    expect(JSON.parse(nativePayload.payloadJson).native_roundtrip).toBe(true);
    const nativeKey = await rpc(page, 'object.reveal', { vaultHandle: openedNative.vaultHandle, objectId: ref.keyId }, 'c');
    expect(await call(page, 'c', 'verify-key', { payload: nativeKey.payloadJson, expected: { ...expected, counter: 0 } })).toBe(true);
    await call(page, 'c', 'close');
    evidence.nativeRoundtrip = { verified: true, executableSha256: sha(await readFile(nativeExe)) };
    evidence.fullBrowserRestart = true; evidence.originalPasskeySignatureCounters = refs.filter(r => r.mode !== 'power').map(r => r.counter);
    evidence.powerPolicyDisclosureDenied = true;
    evidence.stats = await call(page, 'a', 'stats');
    evidence.engineBuild = JSON.parse(await readFile('native/mdbx2-browser/pkg/BROWSER-BUILD.json', 'utf8'));
    evidence.status = 'passed'; await call(page, 'a', 'close');
  } finally {
    try { await context?.close(); }
    finally { await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
  }
});
