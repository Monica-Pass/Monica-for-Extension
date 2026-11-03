import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('UI runtime client recovers an actual missing Edge message receiver', async ({}, testInfo) => {
  const root = testInfo.outputPath('extension');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const { buildId } = JSON.parse(await readFile('src/runtime/build-id.json', 'utf8'));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'Monica runtime recovery fixture', background: { service_worker: 'background.js' } }));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Runtime recovery</title><script src="client.js"></script>');
  await build({ stdin: { contents: `import { vaultClient } from './src/runtime/client'; globalThis.fixtureClient = vaultClient;`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', platform: 'browser', outfile: path.join(root, 'client.js') });
  await writeFile(path.join(root, 'background.js'), `
    globalThis.counts = { info: 0, status: 0, unlock: 0 };
    function receive(message, sender, respond) {
      if (message.type === 'RUNTIME_INFO') { counts.info++; respond({ok:true,data:{version:${JSON.stringify(version)},protocolVersion:1,buildId:${JSON.stringify(buildId)}}}); }
      if (message.type === 'VAULT_STATUS') { counts.status++; respond({ok:true,data:'locked'}); }
      if (message.type === 'VAULT_UNLOCK') { counts.unlock++; respond({ok:true,data:[]}); }
    }
    chrome.runtime.onMessage.addListener(receive);
    globalThis.hideReceiver = () => {
      chrome.runtime.onMessage.removeListener(receive);
      setTimeout(() => chrome.runtime.onMessage.addListener(receive), 600);
    };
  `);
  const context = await launchEdgeContext(testInfo.outputPath('profile'), { args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await worker.evaluate('hideReceiver()');
    // Confirm the actual Chrome error first, before asking the production client
    // to recover it. This fixture never receives or logs a real password.
    expect(await page.evaluate(async () => {
      try { await chrome.runtime.sendMessage({ type: 'RUNTIME_INFO' }); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    })).toBe('Could not establish connection. Receiving end does not exist.');
    expect(await page.evaluate('fixtureClient.status()')).toBe('locked');
    await worker.evaluate('hideReceiver()');
    expect(await page.evaluate('fixtureClient.status()')).toBe('locked');
    await worker.evaluate('hideReceiver()');
    expect(await page.evaluate("fixtureClient.unlock('synthetic acceptance password')")).toEqual([]);
    expect(await worker.evaluate('counts')).toEqual({ info: 3, status: 2, unlock: 1 });
  } finally { await context.close(); }
});
