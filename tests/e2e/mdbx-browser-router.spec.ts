import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

const password = 'synthetic-routing-password';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function send(page: Page, op: string, params: Record<string, unknown> = {}, method?: string, owner?: string) {
  const result = await page.evaluate(message => chrome.runtime.sendMessage(message), { type: 'TEST_ROUTER', op, params, method, owner });
  expect(result.ok, `${op}/${method || ''}: ${result.code || ''}`).toBe(true); return result.value;
}
const rpc = (page: Page, method: string, params: Record<string, unknown> = {}) => send(page, 'rpc', params, method);

test('MDBX routes legacy Native Host and bundled browser vaults across restart without changing keys', async (_, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(180_000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'), engine = path.join(extension, 'mdbx-browser');
  await mkdir(engine, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Monica synthetic MDBX router acceptance', version: '1.0.0', permissions: ['offscreen', 'nativeMessaging'], background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'" } }));
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Monica MDBX routing acceptance</title>');
  await writeFile(path.join(extension, 'mdbx-offscreen.html'), '<!doctype html><script type="module" src="mdbx-browser/offscreen.js"></script>');
  for (const file of ['engine.js', 'monica_mdbx2_browser.wasm']) await copyFile(path.resolve('native/mdbx2-browser/pkg', file), path.join(engine, file));
  await Promise.all([
    build({ entryPoints: ['src/providers/mdbx2/browser/offscreen.ts'], outfile: path.join(engine, 'offscreen.js'), bundle: true, format: 'esm', target: 'chrome130' }),
    build({ entryPoints: ['src/providers/mdbx2/browser/engine-worker.ts'], outfile: path.join(engine, 'engine-worker.js'), bundle: true, format: 'esm', target: 'chrome130', external: ['./engine.js'] }),
    build({ entryPoints: ['tests/e2e/fixtures/mdbx-router-background.ts'], outfile: path.join(extension, 'background.js'), bundle: true, format: 'iife', target: 'chrome130' })
  ]);
  const profile = path.join(run, 'profile'), appData = path.resolve('.tmp/router-native', randomUUID().slice(0, 18));
  await mkdir(appData, { recursive: true });
  let context: BrowserContext | undefined, registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', managerUiAcceptance: false, realCloudAcceptance: false, androidApplicationAcceptance: false };
  const launch = async () => {
    context = await launchEdgeContext(profile, { env: { ...process.env, LOCALAPPDATA: appData, APPDATA: appData }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    evidence.edgeVersion = context.browser()?.version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    return { page, extensionId };
  };
  try {
    const launched = await launch();
    let { page } = launched;
    const { extensionId } = launched;
    registration = await temporaryNativeHost(extensionId, path.join(run, 'native'));
    evidence.originStore = await send(page, 'origin-suite');
    // Create with the production typed API; the initial vault is the browser one.
    const browserVault = await send(page, 'create', { password });
    const browserHandle = browserVault.vaultHandle;
    const key = await page.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
      return { credential_id: b64(crypto.getRandomValues(new Uint8Array(32)).buffer), rp_id: 'router.example.test', user_id: 'AQID', private_key_alias: b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), public_key: b64(await crypto.subtle.exportKey('spki', pair.publicKey)), public_key_algorithm: -7, key_status: 'portable', backup_eligible: true, backup_state: true };
    });
    const keys: { objectId: string; counter: number }[] = [];
    for (const counter of [0, 19]) {
      const record = await rpc(page, 'object.upsert', { vaultHandle: browserHandle, operationId: randomUUID(), logicalObjectId: `passkey:router-${counter}`, collectionId: null, objectTypeId: 'passkey', title: 'Synthetic routing key', payloadJson: JSON.stringify({ ...key, monica_entry_id: `passkey:router-${counter}`, sign_count: counter }) });
      keys.push({ objectId: record.objectId, counter });
    }
    const backup = await send(page, 'backup', { handle: browserHandle });
    const parts: Buffer[] = [];
    for (let offset = 0; offset < backup.sizeBytes; offset += 262144) {
      const part = await rpc(page, 'vault.export.read', { vaultHandle: browserHandle, fileHandle: backup.fileHandle, offset, maxBytes: 262144 }); parts.push(Buffer.from(part.dataBase64, 'base64'));
    }
    const bytes = Buffer.concat(parts); expect(sha(bytes)).toBe(backup.sha256);
    await rpc(page, 'vault.export.release', { fileHandle: backup.fileHandle });
    // Seed a legacy Native Host vault via the pre-router API; no origin metadata
    // is supplied. Only the isolated Edge process sees the temporary app data.
    const transfer = await send(page, 'seed', { direction: 'extension-to-host', purpose: 'vault-bootstrap', sizeBytes: bytes.length, sha256: sha(bytes) }, 'transfer.begin');
    for (let offset = 0; offset < bytes.length; offset += 262144) await send(page, 'seed', { transferId: transfer.transferId, offset, dataBase64: bytes.subarray(offset, offset + 262144).toString('base64') }, 'transfer.chunk');
    const file = await send(page, 'seed', { transferId: transfer.transferId }, 'transfer.finish');
    const nativeVault = await send(page, 'seed', { source: { kind: 'file', handle: file.fileHandle }, credential: { method: 'password', password } }, 'vault.open');
    const nativeHandle = nativeVault.vaultHandle;
    expect(nativeHandle).not.toBe(browserHandle); expect(nativeVault.vaultId).toBe(browserVault.vaultId);
    expect(await send(page, 'lookup', { handles: [nativeHandle] })).toEqual([]);
    await send(page, 'seed', { vaultHandle: nativeHandle }, 'vault.lock');
    await rpc(page, 'vault.lock', { vaultHandle: browserHandle });
    await send(page, 'close-seed');
    const verify = async () => {
      for (const [vaultHandle, backend] of [[nativeHandle, 'native'], [browserHandle, 'browser']]) {
        expect(await send(page, 'origin', { handle: vaultHandle })).toBe(backend);
        await rpc(page, 'vault.open', { source: { kind: 'vault', handle: vaultHandle }, credential: { method: 'password', password } });
        expect((await send(page, 'hello', { handle: vaultHandle })).supportsCompleteBackup).toBe(true);
        expect((await send(page, 'status', { handle: vaultHandle })).availability).toBe('ready');
        await send(page, 'revision', { handle: vaultHandle });
        for (const ref of keys) {
          const record = await rpc(page, 'object.reveal', { vaultHandle, objectId: ref.objectId });
          const payload = JSON.parse(record.payloadJson);
          expect(payload.credential_id).toBe(key.credential_id); expect(payload.sign_count).toBe(ref.counter);
          expect(sha(Buffer.from(payload.private_key_alias, 'base64'))).toBe(sha(Buffer.from(key.private_key_alias, 'base64')));
          expect(await page.evaluate(async ({ payload, publicKey }) => {
            const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
            const privateKey = await crypto.subtle.importKey('pkcs8', decode(payload.private_key_alias), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
            const verifier = await crypto.subtle.importKey('spki', decode(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const data = crypto.getRandomValues(new Uint8Array(80));
            return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data), data);
          }, { payload, publicKey: key.public_key })).toBe(true);
        }
        // Incoming sync downloads start without a file handle, so they must
        // explicitly inherit the destination vault's engine before any bytes.
        const inbound = await send(page, 'inbound', { handle: vaultHandle, size: 3 });
        expect((await send(page, 'lookup', { handles: [inbound.transferId] }))[0][1].backend).toBe(backend);
        await rpc(page, 'transfer.chunk', { transferId: inbound.transferId, offset: 0, dataBase64: 'AQID' });
        const downloaded = await rpc(page, 'transfer.finish', { transferId: inbound.transferId });
        expect((await send(page, 'lookup', { handles: [downloaded.fileHandle] }))[0][1].backend).toBe(backend);
        await rpc(page, 'transfer.release', { fileHandle: downloaded.fileHandle });
      }
    };
    await verify();
    await send(page, 'reset'); await verify(); evidence.routerReplacement = true;
    await send(page, 'close'); await context!.close(); context = undefined;
    ({ page } = await launch()); await verify(); evidence.fullBrowserRestart = true;
    const mixed = await page.evaluate(params => chrome.runtime.sendMessage({ type: 'TEST_ROUTER', op: 'rpc', method: 'sync.segment.inspect', params }), { vaultHandle: nativeHandle, fileHandle: backup.fileHandle });
    expect(mixed).toMatchObject({ ok: false, code: 'mdbx-backend-conflict' });
    evidence.mixedBackendRejected = true;
    evidence.statusDoesNotRetireLiveOwner = true;
    evidence.originalCredentialBytesAndSignatures = true; evidence.counters = [0, 19]; evidence.legacyNativeAndNewBrowser = true; evidence.ownerAwareIncomingTransfers = true;
    await send(page, 'close'); evidence.status = 'passed';
  } finally {
    if (context) await context.close();
    try { if (registration) await registration.restore(); }
    finally { evidence.nativeRegistrationRestored = registration?.evidence.restored === true; await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
  }
});
