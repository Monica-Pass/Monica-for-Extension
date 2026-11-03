import { expect, test, type CDPSession } from '@playwright/test';
import path from 'node:path';
import { launchTestContext } from './fixtures/edge';

async function contentProbe(cdp: CDPSession) {
  await cdp.send('Runtime.disable');
  const worlds: number[] = [];
  const onContext = (event: { context: { id: number } }) => { worlds.push(event.context.id); };
  cdp.on('Runtime.executionContextCreated', onContext);
  try { await cdp.send('Runtime.enable'); }
  finally { cdp.removeListener('Runtime.executionContextCreated', onContext); }
  for (const contextId of worlds) {
    const probe = await cdp.send('Runtime.evaluate', { contextId, expression: "typeof chrome?.runtime?.sendMessage === 'function'", returnByValue: true });
    if (probe.result.value !== true) continue;
    const result = await cdp.send('Runtime.evaluate', { contextId, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        const local = await chrome.storage.local.get(null);
        let sessionDenied = false;
        try { await chrome.storage.session.get(null); } catch { sessionDenied = true; }
        const vault = await chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'});
        const deviceDbVisible = (await indexedDB.databases()).some(db=>db.name==='monica-extension-device-keys');
        return {deviceKeyVisible:Object.keys(local).some(key=>key.startsWith('monica.secureVault.deviceKey.v1.')),deviceDbVisible,sessionDenied,vaultDenied:!vault.ok};
      })()` });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  throw new Error('Extension content world not found');
}

test('device-key vault remains readable while content scripts cannot access its key', async ({}, info) => {
  const extension = path.resolve('dist');
  // The bundled headless shell cannot load extensions; use full Chromium.
  const options = { channel: 'chromium', locale: 'zh-CN', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchTestContext(info.outputPath('profile'), options);
  try {
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    let manager = await context.newPage(); await manager.goto(url);
    const setup = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }));
    expect(setup.ok, setup.error).toBe(true);
    const now = new Date().toISOString();
    const added = await manager.evaluate(item => chrome.runtime.sendMessage({ type: 'VAULT_UPSERT_ITEM', item }), {
      id: 'isolation-login', kind: 'login', title: 'Synthetic isolation login', username: 'synthetic', password: 'synthetic-vault-secret',
      uris: ['https://isolation.example.test'], customFields: [], notes: '', favorite: false, createdAt: now, updatedAt: now, providerRefs: [] });
    expect(added.ok, added.error).toBe(true);
    await context.route('https://isolation.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<input name="username"><input type="password">' }));
    const page = await context.newPage(); await page.goto('https://isolation.example.test/');
    const cdp = await context.newCDPSession(page);
    try { await expect.poll(() => contentProbe(cdp)).toMatchObject({ deviceKeyVisible: false, deviceDbVisible: false, sessionDenied: true, vaultDenied: true }); }
    finally { await cdp.detach(); }
    // Recreate the historical layout using only this synthetic vault. Restart
    // must migrate the exact key and keep the existing encrypted vault readable.
    await manager.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('monica-extension-device-keys', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const entries = await new Promise<Array<{id: IDBValidKey; key: string}>>((resolve, reject) => {
        const tx = db.transaction('keys', 'readonly'), entries: Array<{id: IDBValidKey; key: string}> = [];
        const cursor = tx.objectStore('keys').openCursor();
        cursor.onsuccess = () => { if (cursor.result) { entries.push({id: cursor.result.key, key: cursor.result.value}); cursor.result.continue(); } };
        tx.oncomplete = () => resolve(entries); tx.onerror = () => reject(tx.error);
      });
      if (entries.length !== 1) throw new Error('Synthetic fixture must contain one device key');
      await chrome.storage.local.set(Object.fromEntries(entries.map(entry => [`monica.secureVault.deviceKey.v1.${entry.id}`, entry.key])));
      await new Promise<void>((resolve, reject) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
      db.close();
    });
    await context.close(); context = await launchTestContext(info.outputPath('profile'), options);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    manager = await context.newPage(); await manager.goto(url);
    await expect.poll(async () => {
      const result = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' }));
      return result.ok && result.data.some((item: any) => item.id === 'isolation-login' && item.password === 'synthetic-vault-secret');
    }).toBe(true);
    expect(await manager.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).some(key => key.startsWith('monica.secureVault.deviceKey.v1.')))).toBe(false);
    // Simulate a restart after the private copy committed but before legacy
    // cleanup, with the public copy subsequently tampered with. Never replace
    // the committed key from this less trusted input.
    await manager.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('monica-extension-device-keys', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const id = await new Promise<IDBValidKey>((resolve, reject) => { const tx = db.transaction('keys', 'readonly'), request = tx.objectStore('keys').getAllKeys(); request.onsuccess = () => resolve(request.result[0]); request.onerror = () => reject(request.error); });
      db.close();
      await chrome.storage.local.set({ [`monica.secureVault.deviceKey.v1.${id}`]: btoa(String.fromCharCode(...new Uint8Array(32))) });
    });
    await context.close(); context = await launchTestContext(info.outputPath('profile'), options);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    manager = await context.newPage(); await manager.goto(url);
    const recovered = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' }));
    expect(recovered.ok, recovered.error).toBe(true);
    expect(recovered.data.find((item: any) => item.id === 'isolation-login').password).toBe('synthetic-vault-secret');
    expect(await manager.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).some(key => key.startsWith('monica.secureVault.deviceKey.v1.')))).toBe(false);
  } finally { await context.close(); }
});
