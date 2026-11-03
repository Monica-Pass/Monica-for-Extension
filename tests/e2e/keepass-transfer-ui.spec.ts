import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';

const extension = path.resolve('dist');
const options = { locale: 'zh-CN', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const, acceptDownloads: true,
  viewport: { width: 1180, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
async function send(page: Page, request: Record<string, unknown>): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}

for (const interrupt of [false, true]) test(`KeePass destination UI copies a complete project and ${interrupt ? 'recovers an aborted adoption after full Edge restart' : 'exports exact KDBX and replays after restart'}`, async ({}, info) => {
  test.setTimeout(120_000);
  const helper = info.outputPath('keepass-fixture.cjs');
  await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture'; export {openKeePassVault} from './src/providers/keepass/keepass-vault';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(helper) as typeof import('../../src/providers/keepass/keepass-fixture') & typeof import('../../src/providers/keepass/keepass-vault');
  const password = 'Synthetic transfer KDBX';
  const bytes = await api.buildKeePassFixture({ password, kdf: 'argon2id', entries: [{ title: 'Existing target', group: 'Destination', protectedFields: { Password: 'existing secret' } }] });
  const profile = info.outputPath('profile');
  let context = await launchEdgeContext(profile, options);
  const manager = async () => {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
  };
  try {
    let page = await manager(); await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    const projectId = '81111111-1111-4111-8111-111111111111';
    const sources = [0, 1].map(n => ({ id: `portable-${n}`, kind: 'login', title: 'Transfer source', username: `user-${n}`, password: `synthetic secret ${n}`,
      favorite: false, notes: '', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', providerRefs: [], uris: [],
      passwordGroupId: projectId, categoryName: 'Personal / literal', categoryId: 7, customFields: [{ name: 'monica.content.credential', protected: true,
        value: JSON.stringify({ version: 1, projectId, groupId: projectId, passwordId: `82222222-2222-4222-8222-22222222222${n}`, label: 'Accounts', primary: n === 0, groupOrder: 0, passwordOrder: n }) }] }));
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: sources });
    await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.getByRole('button', { name: '连接 KeePass' }).click();
    const open = async (reopen = false) => {
      const dialog = dialogContent(page, { name: /KeePass/ });
      await dialog.getByLabel('显示名称', { exact: true }).fill('Synthetic destination');
      await dialog.getByLabel('KeePass 数据库文件', { exact: true }).setInputFiles({ name: 'destination.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      await dialog.getByLabel('数据库密码（可留空）', { exact: true }).fill(password);
      await dialog.getByRole('button', { name: reopen ? '重新选择并解锁' : '解锁并连接', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    };
    await open();
    let card = page.locator('m3e-card.source-card').filter({ has: page.getByRole('heading', { name: 'Synthetic destination', exact: true }) });
    await card.getByRole('button', { name: '批量传输', exact: true }).click();
    let transfer = dialogContent(page, { name: '复制或移动项目' });
    await expect(transfer.getByRole('radio', { name: /Destination/ })).toBeVisible();
    await transfer.getByRole('radio', { name: /Destination/ }).check();
    await transfer.getByRole('checkbox', { name: /Transfer source/ }).first().check();
    await transfer.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(transfer.getByText('2 个可传输，0 个被阻断', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 950 });
    expect(await transfer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('keepass-transfer-320.png') });
    await page.setViewportSize(options.viewport);
    await page.evaluate(() => {
      const runtime = chrome.runtime as any, original = runtime.sendMessage.bind(runtime);
      runtime.sendMessage = async (request: any) => {
        if (request.type === 'MDBX2_BATCH_TRANSFER_EXECUTE') (window as any).transferRequest = JSON.parse(JSON.stringify(request));
        return original(request);
      };
    });
    if (interrupt) await context.serviceWorkers()[0].evaluate(() => {
      const put = IDBObjectStore.prototype.put; let fileCommitted = false;
      IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
        const request = put.apply(this, args), transaction = this.transaction;
        if (transaction.db.name === 'monica-extension-keepass-working-copies' && this.name === 'working-copies')
          transaction.addEventListener('complete', () => { fileCommitted = true; }, { once: true });
        if (fileCommitted && transaction.db.name === 'monica-extension-secure-vault' && this.name === 'vault') {
          request.addEventListener('success', () => transaction.abort(), { once: true }); IDBObjectStore.prototype.put = put;
        }
        return request;
      };
    });
    await transfer.getByRole('button', { name: '执行复制', exact: true }).click();
    const request = await page.evaluate(() => (window as any).transferRequest);
    const targetId = request.input.targetProviderId;
    if (interrupt) {
      await expect(transfer.getByRole('button', { name: '恢复传输', exact: true })).toBeVisible();
      expect((await send(page, { type: 'KEEPASS_PENDING_TRANSFERS', providerId: targetId }))).toHaveLength(1);
    } else {
      await expect(transfer.getByText('2 个成功 · 0 个阻断 · 0 个失败', { exact: true })).toBeVisible();
      await expect(transfer.locator('.batch-result-panel .batch-inline-note')).toContainText('已保存的修改会在本机加密保留。解锁仍需数据库密码或密钥文件，完成后请导出并保存 KDBX。');
    }
    await context.close(); context = await launchEdgeContext(profile, options); page = await manager();
    await send(page, { type: 'VAULT_UNLOCK', masterPassword: '' }); await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    card = page.locator('m3e-card.source-card').filter({ has: page.getByRole('heading', { name: 'Synthetic destination', exact: true }) });
    await card.getByRole('button', { name: '管理 KeePass', exact: true }).click(); await open(true);
    if (interrupt) {
      await card.getByRole('button', { name: '批量传输', exact: true }).click(); transfer = dialogContent(page, { name: '复制或移动项目' });
      await expect(transfer.getByRole('button', { name: '恢复传输', exact: true })).toBeEnabled();
      await page.setViewportSize({ width: 320, height: 950 });
      expect(await transfer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('keepass-recovery-320.png') }); await page.setViewportSize(options.viewport);
      await transfer.getByRole('button', { name: '恢复传输', exact: true }).click();
      await expect(transfer.getByText('2 个成功 · 0 个阻断 · 0 个失败', { exact: true })).toBeVisible();
      await transfer.getByRole('button', { name: '关闭批量传输', exact: true }).click();
    }
    const replay = await send(page, request);
    expect(replay.completedCount).toBe(2);
    const items = await send(page, { type: 'VAULT_LIST_ITEMS' }); expect(items).toHaveLength(5);
    const copies = items.filter((item: any) => replay.items.some((row: any) => row.targetItemId === item.id));
    expect(copies).toHaveLength(2); expect(copies[0].passwordGroupId).toBe(copies[1].passwordGroupId);
    expect(copies[0].passwordGroupId).not.toBe(projectId);
    for (const source of sources) expect(items.find((row: any) => row.id === source.id)).toMatchObject({ password: source.password, passwordGroupId: projectId });
    const download = page.waitForEvent('download'); await card.getByRole('button', { name: '导出 KDBX', exact: true }).click();
    const exported = await readFile((await (await download).path())!);
    const reopened = await api.openKeePassVault(exported, { password, providerId: targetId, databaseId: copies[0].keepassDatabaseId });
    expect(reopened.items).toHaveLength(3);
    expect(reopened.items.filter(row => row.title === 'Transfer source').every(row => row.keepassGroupPath === 'Destination/Personal%20%2F%20literal')).toBe(true);
    const popup = await context.newPage(); await popup.goto(page.url().replace('index.html', 'popup.html'));
    for (const type of ['KEEPASS_PENDING_TRANSFERS', 'KEEPASS_CANCEL_UNWRITTEN_TRANSFER']) {
      const denied = await popup.evaluate(request => chrome.runtime.sendMessage(request), { type, providerId: targetId, operationId: request.input.operationId });
      expect(denied.ok).toBe(false); expect(denied.error).toContain('管理页');
    }
  } finally { await context.close(); }
});
