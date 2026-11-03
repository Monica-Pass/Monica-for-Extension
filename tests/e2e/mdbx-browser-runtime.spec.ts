import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchEdgeContext } from './fixtures/edge';

const api = async (page: Page, op: string, method?: string, params: Record<string, unknown> = {}) => {
  const response = await page.evaluate(input => chrome.runtime.sendMessage(input), { type: 'TEST_BROWSER_MDBX', op, method, params });
  expect(response.ok, JSON.stringify({ code: response.code, diagnostic: response.diagnostic })).toBe(true); return response.value;
};
test('offscreen MDBX accepts only its background owner and recovers after service-worker termination', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(150_000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'), engine = path.join(extension, 'mdbx-browser');
  await mkdir(engine, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Monica synthetic production offscreen MDBX', version: '1.0.0', permissions: ['offscreen'], background: { service_worker: 'background.js' }, content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'" } }));
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Monica offscreen acceptance</title>');
  await writeFile(path.join(extension, 'mdbx-offscreen.html'), '<!doctype html><script type="module" src="mdbx-browser/offscreen.js"></script>');
  for (const file of ['engine.js', 'monica_mdbx2_browser.wasm']) await copyFile(path.resolve('native/mdbx2-browser/pkg', file), path.join(engine, file));
  await Promise.all([
    build({ entryPoints: ['src/providers/mdbx2/browser/offscreen.ts'], outfile: path.join(engine, 'offscreen.js'), bundle: true, format: 'esm', target: 'chrome130' }),
    build({ entryPoints: ['src/providers/mdbx2/browser/engine-worker.ts'], outfile: path.join(engine, 'engine-worker.js'), bundle: true, format: 'esm', target: 'chrome130', external: ['./engine.js'] }),
    build({ stdin: { contents: `import {Mdbx2NativeClient} from './src/providers/mdbx2/native-client';
      import {createBrowserMdbx2Runtime,isBrowserMdbxControlMessage} from './src/providers/mdbx2/browser/runtime';
      const runtime=createBrowserMdbx2Runtime();const client=new Mdbx2NativeClient(runtime);let authorizationSender;
      chrome.runtime.onMessage.addListener((message,sender,respond)=>{
        if(isBrowserMdbxControlMessage(message)){authorizationSender={url:sender.url,documentId:sender.documentId,hasTab:!!sender.tab};return false;}
        if(message?.type!=='TEST_BROWSER_MDBX')return false;
        if(sender.url!==chrome.runtime.getURL('index.html')){respond({ok:false,code:'test-driver-denied'});return false;}
        const run=async()=>{if(message.op==='rpc')return client.request(message.method,message.params,60000);if(message.op==='close'){client.close();return true;}if(message.op==='contexts')return chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});if(message.op==='sender')return authorizationSender;if(message.op==='hello')return client.hello(60000);throw Error('bad-driver-op');};
        run().then(value=>respond({ok:true,value}),e=>respond({ok:false,code:e.code||e.message,diagnostic:{runtimeError:runtime.disconnectErrorMessage(),authorizationSender}}));return true;
      });`, resolveDir: process.cwd(), loader: 'ts' }, outfile: path.join(extension, 'background.js'), bundle: true, format: 'iife', target: 'chrome130' })
  ]);
  const context = await launchEdgeContext(path.join(run, 'profile'), { args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const evidence: Record<string, unknown> = { status: 'failed', edgeVersion: context.browser()?.version(), nativeMessagingUsed: false, managerUiAcceptance: false };
  try {
    const background = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(background.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${id}/index.html`);
    const hello = await api(page, 'hello'); expect(hello.supportsLosslessJson).toBe(true);
    evidence.offscreenSender = await api(page, 'sender');
    expect((evidence.offscreenSender as { hasTab: boolean }).hasTab).toBe(false);
    const contexts = await api(page, 'contexts'); expect(contexts).toHaveLength(1);
    const opened = await api(page, 'rpc', 'vault.create', { mode: 'sky', password: 'synthetic-offscreen-password' });
    const vaultHandle = opened.vaultHandle;
    const written = await api(page, 'rpc', 'object.upsert', { vaultHandle, operationId: randomUUID(), logicalObjectId: 'password:offscreen', collectionId: null, objectTypeId: 'login', title: 'Synthetic offscreen record', payloadJson: '{"monica_entry_id":"password:offscreen","password_plain":"synthetic-offscreen-secret"}' });
    const read = async () => {
      const record = await api(page, 'rpc', 'object.reveal', { vaultHandle, objectId: written.objectId });
      expect(JSON.parse(record.payloadJson).password_plain).toBe('synthetic-offscreen-secret');
    };
    await read();
    // A normal extension page cannot impersonate the background endpoint.
    const rejected = await page.evaluate(() => new Promise<boolean>(resolve => {
      const port = chrome.runtime.connect({ name: 'monica-mdbx-browser-v1' }); let sawReady = false;
      port.onMessage.addListener(() => { sawReady = true; }); port.onDisconnect.addListener(() => { void chrome.runtime.lastError; resolve(!sawReady); });
    })); expect(rejected).toBe(true); await read();
    evidence.pagePortRejectedWithoutDisturbingOwner = true;
    // Loading the offscreen file in a visible tab cannot create another receiver.
    const fake = await context.newPage(); await fake.goto(`chrome-extension://${id}/mdbx-offscreen.html`);
    await api(page, 'close');
    await api(page, 'rpc', 'vault.open', { source: { kind: 'vault', handle: vaultHandle }, credential: { method: 'password', password: 'synthetic-offscreen-password' } });
    await read(); expect(await api(page, 'contexts')).toHaveLength(1); await fake.close();
    evidence.visibleOffscreenPageCannotBecomeOwner = true;
    // Stop only this isolated extension's background worker, not all browsers.
    const cdp = await context.newCDPSession(page); let versionId: string | undefined;
    cdp.on('ServiceWorker.workerVersionUpdated', event => { for (const v of event.versions) if (v.scriptURL === `chrome-extension://${id}/background.js` && v.runningStatus === 'running') versionId = v.versionId; });
    await cdp.send('ServiceWorker.enable'); await expect.poll(() => versionId).toBeTruthy();
    await cdp.send('ServiceWorker.stopWorker', { versionId: versionId! });
    await api(page, 'rpc', 'vault.open', { source: { kind: 'vault', handle: vaultHandle }, credential: { method: 'password', password: 'synthetic-offscreen-password' } });
    await read(); await cdp.detach();
    evidence.backgroundTerminationRecovered = true;
    await api(page, 'close'); await api(page, 'hello'); await api(page, 'close');
    evidence.closeReopen = true; evidence.status = 'passed';
  } finally { await context.close(); await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
