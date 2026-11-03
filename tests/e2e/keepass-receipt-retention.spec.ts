import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';

type StorageApi = typeof import('../../src/providers/keepass/keepass-working-copy-store');
declare global { interface Window { ReceiptStorage: StorageApi } }

test('actual Edge upgrades existing KeePass receipts and atomically retains spent operation identities across restart', async ({}, info) => {
  test.setTimeout(90_000);
  const helper = info.outputPath('receipts.js');
  await build({ stdin: { contents: "export * from './src/providers/keepass/keepass-working-copy-store';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'browser', format: 'iife', globalName: 'ReceiptStorage', logLevel: 'silent',
    // Same alias as scripts/build-workers.mjs: kdbxweb only touches Node crypto without WebCrypto.
    alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') } });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Synthetic KeePass receipt test</title>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test server');
  const url = `http://127.0.0.1:${address.port}`;
  let context: Awaited<ReturnType<typeof launchEdgeContext>> | undefined;
  try {
    context = await launchEdgeContext(info.outputPath('profile'));
    let page = await context.newPage(); await page.goto(url); await page.addScriptTag({ path: helper });
    const first = await page.evaluate(async () => {
      const name = 'synthetic-keepass-receipt-retention', providerId = 'synthetic-provider';
      const row = { providerId, baseBytes: Uint8Array.of(1, 2, 3), workingBytes: Uint8Array.of(4, 5, 6),
        baseSha256: 'a'.repeat(64), workingSha256: 'b'.repeat(64), updatedAt: '2026-10-11T00:00:00Z', revision: 1 };
      const receipt = { version: 1 as const, providerId, operationId: 'old-operation', intentTag: 'd'.repeat(64),
        completedAt: '2026-10-10T00:00:00Z', cipher: 'AES-256-GCM' as const, iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };
      // Upgrade a real version-2 database in place, including its existing data.
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(name, 2);
        open.onupgradeneeded = () => {
          open.result.createObjectStore('working-copies');
          open.result.createObjectStore('operation-receipts', { keyPath: 'key' }).createIndex('providerId', 'providerId');
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction(['working-copies', 'operation-receipts'], 'readwrite');
          tx.objectStore('working-copies').put(row, providerId);
          for (let n = 0; n < window.ReceiptStorage.KEEPASS_DURABLE_RECEIPT_LIMIT; n++) {
            const operationId = n ? `later-${n}` : receipt.operationId;
            tx.objectStore('operation-receipts').put({ ...receipt, operationId, key: `${providerId}\u0000${operationId}`,
              completedAt: n ? '2026-10-11T00:00:00Z' : receipt.completedAt });
          }
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
      const storage = new window.ReceiptStorage.IndexedDbKeePassWorkingCopyStorage(name);
      const migrated = await storage.read(providerId), originalReceipt = await storage.readReceipt(providerId, receipt.operationId);
      const next = { ...receipt, operationId: 'new-operation', completedAt: '2026-10-12T00:00:00Z' };
      const put = IDBObjectStore.prototype.put;
      let aborted = 0;
      for (const failAt of ['expired-operations', 'working-copies']) {
        IDBObjectStore.prototype.put = function(value, key) {
          const result = key === undefined ? put.call(this, value) : put.call(this, value, key);
          if (this.transaction.db.name === name && this.name === failAt) {
            this.transaction.abort(); throw new Error(`Synthetic ${failAt} write failure`);
          }
          return result;
        };
        try { await storage.save({ ...row, workingBytes: Uint8Array.of(7, 8, 9) }, 1, next); }
        catch { aborted++; } finally { IDBObjectStore.prototype.put = put; }
      }
      const afterAbort = await storage.read(providerId);
      const oldSurvivesAbort = !!await storage.readReceipt(providerId, receipt.operationId);
      const newAbsentAfterAbort = !await storage.readReceipt(providerId, next.operationId);
      await storage.save({ ...row, workingBytes: Uint8Array.of(7, 8, 9) }, 1, next);
      let expired = false, overwriteBlocked = false, staleBlocked = false, crossProviderBlocked = false;
      try { await storage.readReceipt(providerId, receipt.operationId); } catch (e) { expired = (e as { code: string }).code === 'operation-expired'; }
      try { await storage.save(row, 2, receipt); } catch (e) { overwriteBlocked = (e as { code: string }).code === 'operation-expired'; }
      try { await storage.save(row, 1, { ...next, operationId: 'stale' }); } catch (e) { staleBlocked = (e as { code: string }).code === 'revision-stale'; }
      try { await storage.save(row, 2, { ...next, providerId: 'other-provider' }); } catch (e) { crossProviderBlocked = (e as { code: string }).code === 'record-invalid'; }
      return { migrated: migrated?.revision === 1 && !!originalReceipt, aborted, oldSurvivesAbort, newAbsentAfterAbort,
        afterAbort: { revision: afterAbort?.revision, bytes: [...afterAbort!.workingBytes] },
        expired, overwriteBlocked, staleBlocked, crossProviderBlocked };
    });
    expect(first).toEqual({ migrated: true, aborted: 2, oldSurvivesAbort: true, newAbsentAfterAbort: true,
      afterAbort: { revision: 1, bytes: [4, 5, 6] }, expired: true, overwriteBlocked: true, staleBlocked: true, crossProviderBlocked: true });
    await context.close(); context = await launchEdgeContext(info.outputPath('profile'));
    page = await context.newPage(); await page.goto(url); await page.addScriptTag({ path: helper });
    const restarted = await page.evaluate(async () => {
      const name = 'synthetic-keepass-receipt-retention', providerId = 'synthetic-provider';
      const storage = new window.ReceiptStorage.IndexedDbKeePassWorkingCopyStorage(name);
      const row = await storage.read(providerId);
      let expired = false;
      // Even an acknowledgement cannot clear the automatic-retirement guard.
      await storage.deleteReceipt(providerId, 'old-operation');
      try { await storage.readReceipt(providerId, 'old-operation'); } catch (e) { expired = (e as { code: string }).code === 'operation-expired'; }
      const active = await storage.readReceipt(providerId, 'new-operation');
      const all = await new Promise<{ receipts: number; markers: unknown[] }>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction(['operation-receipts', 'expired-operations'], 'readonly');
          const receipts = tx.objectStore('operation-receipts').count(), markers = tx.objectStore('expired-operations').getAll();
          tx.oncomplete = () => { db.close(); resolve({ receipts: receipts.result, markers: markers.result }); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
      // Explicit provider removal clears its complete lifecycle, including guards.
      await storage.delete(providerId);
      const removed = !await storage.read(providerId) && !await storage.readReceipt(providerId, 'old-operation') && !await storage.hasReceipts(providerId);
      return { revision: row?.revision, bytes: [...row!.workingBytes], expired, active: !!active, all, removed };
    });
    expect(restarted).toEqual({ revision: 2, bytes: [7, 8, 9], expired: true, active: true, removed: true,
      all: { receipts: 256, markers: [{ key: 'synthetic-provider\u0000old-operation', version: 1, providerId: 'synthetic-provider', operationId: 'old-operation', expired: true }] } });
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('installed extension refuses an expired group creation after 257 real mutations and full browser restart', async ({}, info) => {
  test.setTimeout(120_000);
  const helper = info.outputPath('fixture.cjs');
  await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { buildKeePassFixture } = createRequire(import.meta.url)(helper) as typeof import('../../src/providers/keepass/keepass-fixture');
  const masterPassword = 'Synthetic Monica receipt test', password = 'Synthetic KDBX receipt test';
  const file = info.outputPath('original.kdbx');
  await writeFile(file, await buildKeePassFixture({ password, kdf: 'argon2id', entries: [{ title: 'Preserved password',
    protectedFields: { Password: 'Synthetic existing password' }, binaries: { 'preserved.bin': Uint8Array.of(2, 4, 6) } }] }));
  const extension = path.resolve('dist'), profile = info.outputPath('profile');
  const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchEdgeContext(profile, options);
  const raw = (page: Page, request: Record<string, unknown>) => page.evaluate(request => chrome.runtime.sendMessage(request), request);
  const send = async <T = any>(page: Page, request: Record<string, unknown>): Promise<T> => {
    const response = await raw(page, request); expect(response.ok, response.error).toBe(true); return response.data;
  };
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    let page = await context.newPage(); await page.goto(url);
    await send(page, { type: 'VAULT_SETUP', masterPassword });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } })); await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('m3e-list-action').filter({ hasText: '连接 KeePass' }).click();
    const open = async (reopening = false) => {
      const dialog = page.locator('.keepass-provider-dialog[role="dialog"]');
      await dialog.getByLabel('显示名称', { exact: true }).fill('Receipt test source');
      await dialog.getByLabel('KeePass 数据库文件', { exact: true }).setInputFiles(file);
      await dialog.getByLabel('数据库密码（可留空）', { exact: true }).fill(password);
      await dialog.getByRole('button', { name: reopening ? '重新选择并解锁' : '解锁并连接', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    };
    await open();
    const account = (await send<Array<{ id: string; name: string }>>(page, { type: 'PROVIDER_LIST' })).find(row => row.name === 'Receipt test source')!;
    const providerId = account.id, createRequest = { type: 'KEEPASS_GROUP_CREATE', providerId, operationId: randomUUID(), name: 'Deleted after receipt expiry' };
    const first = await send(page, createRequest);
    const later = await send(page, { type: 'KEEPASS_GROUP_CREATE', providerId, operationId: randomUUID(), name: 'Later edits' });
    // Real runtime mutations exercise the encrypted receipt writer and its bound.
    const completed = await page.evaluate(async ({ providerId, groupId }) => {
      for (let n = 0; n < 254; n++) {
        const response = await chrome.runtime.sendMessage({ type: 'KEEPASS_GROUP_RENAME', providerId, groupId,
          operationId: crypto.randomUUID(), name: `Later edits ${n}` });
        if (!response.ok) throw new Error(`Mutation ${n} failed: ${response.error}`);
      }
      return 254;
    }, { providerId, groupId: later.group.groupId });
    expect(completed).toBe(254);
    await send(page, { type: 'KEEPASS_GROUP_DELETE', providerId, operationId: randomUUID(), groupId: first.group.groupId, confirmed: true });
    await context.close(); context = await launchEdgeContext(profile, options);
    page = await context.newPage(); await page.goto(url);
    await page.getByLabel('主密码', { exact: true }).fill(masterPassword); await page.getByRole('button', { name: '解锁', exact: true }).click();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator(`[data-home-provider-id="${providerId}"]`).getByRole('button', { name: '管理 KeePass', exact: true }).click();
    await open(true);
    const checkpoint = () => page.evaluate(providerId => new Promise<{ revision: number; sha: string }>((resolve, reject) => {
      const open = indexedDB.open('monica-extension-keepass-working-copies');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('working-copies', 'readonly');
        const read = tx.objectStore('working-copies').get(providerId);
        tx.oncomplete = () => { db.close(); resolve({ revision: read.result.revision, sha: read.result.workingSha256 }); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), providerId);
    const before = await checkpoint();
    const replay = await raw(page, createRequest);
    expect(replay.ok).toBe(false); expect(replay.error).toMatch(/回执已过期/);
    expect(await checkpoint()).toEqual(before);
    const groups = await send(page, { type: 'KEEPASS_GROUP_LIST', providerId, includeRecycleBin: true, pageSize: 100 });
    expect(groups.items.filter((row: { name: string; inRecycleBin: boolean }) => row.name === createRequest.name && !row.inRecycleBin)).toHaveLength(0);
    expect(groups.items.filter((row: { name: string; inRecycleBin: boolean }) => row.name === createRequest.name && row.inRecycleBin)).toHaveLength(1);
    expect(groups.items.some((row: { name: string }) => row.name === 'Later edits 253')).toBe(true);
    // Unrelated new operations still work after the bound is reached.
    await send(page, { type: 'KEEPASS_GROUP_CREATE', providerId, operationId: randomUUID(), name: 'New operation still works' });
  } finally { await context.close(); }
});
