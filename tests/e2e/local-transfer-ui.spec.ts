import { expect, test, type Page, type BrowserContext, type Download, type Locator } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import { buildKeePassFixture } from '../../src/providers/keepass/keepass-fixture';

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function manager(context: BrowserContext) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
}
async function downloadBytes(download: Download) { return readFile((await download.path())!); }
async function downloadFromDialog(page: Page, dialog: Locator) {
  const pending = page.waitForEvent('download', { timeout: 5000 }).catch(() => undefined);
  await dialog.getByRole('button', { name: '下载 original.bin', exact: true }).click();
  const result = await pending;
  expect(result, await dialog.innerText()).toBeTruthy();
  return downloadBytes(result!);
}
async function observeTransfers(page: Page) {
  await page.evaluate(() => {
    const runtime = chrome.runtime as unknown as { sendMessage: (input: any) => Promise<any> };
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = async input => {
      // Vue may supply reactive proxies; Chrome's message transport is JSON based.
      if (input.type === 'MDBX2_BATCH_TRANSFER_EXECUTE') (window as any).__lastTransfer = JSON.parse(JSON.stringify(input));
      return send(input);
    };
  });
}
const options = { locale: 'zh-CN', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const, acceptDownloads: true,
  viewport: { width: 1180, height: 950 }, args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };

test('local files and project copy use the real extension runtime and survive Edge restart', async ({}, info) => {
  const profile = info.outputPath('profile');
  let context = await launchEdgeContext(profile, options);
  try {
    let page = await manager(context);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const common = { kind: 'login', favorite: false, notes: '', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z',
      providerRefs: [], username: 'synthetic', password: 'synthetic-only', uris: [], customFields: [], passwordGroupId: '81111111-1111-4111-8111-111111111111' };
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: [
      { ...common, id: 'source-one', title: 'Local source', categoryId: 7, categoryName: 'Games' },
      { ...common, id: 'source-two', title: 'Local source', username: 'second', categoryId: 7, categoryName: 'Games' },
      { ...common, id: 'folder-anchor', title: 'Folder anchor', passwordGroupId: undefined, categoryId: 8, categoryName: 'Destination' }
    ] });
    await page.reload();
    await page.getByRole('button', { name: '管理 Local source 的附件', exact: true }).first().click();
    let attachments = dialogContent(page, { name: '附件 · Local source' });
    await expect(attachments).toContainText('附件随本地密码库加密保存。');
    await expect(attachments).not.toContainText('KeePass');
    const chooser = page.waitForEvent('filechooser');
    await attachments.getByRole('button', { name: '添加附件', exact: true }).click();
    await (await chooser).setFiles({ name: 'original.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 255, 2]) });
    await expect(attachments.getByText('original.bin', { exact: true })).toBeVisible();
    for (const width of [320, 420, 1180]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await attachments.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`local-files-${width}.png`) });
    }
    await attachments.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('[data-home-provider-id="local"]').getByRole('button', { name: '批量传输', exact: true }).click();
    const transfer = dialogContent(page, { name: '复制或移动项目' });
    await transfer.getByRole('checkbox', { name: /Local source/ }).first().check();
    await transfer.getByRole('radio', { name: /Destination/ }).check();
    await transfer.getByRole('checkbox', { name: /保留原分类层级/ }).uncheck();
    await transfer.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(transfer.getByText('2 个可传输，0 个被阻断', { exact: true })).toBeVisible();
    for (const width of [320, 420, 1180]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await transfer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      if (width === 320) {
        const title = transfer.locator('.batch-item-row').filter({ hasText: 'Local source' }).first().locator('strong');
        expect(await title.evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(30);
      }
      await page.screenshot({ path: info.outputPath(`local-copy-${width}.png`) });
    }
    await observeTransfers(page);
    await transfer.getByRole('button', { name: '执行复制', exact: true }).click();
    await expect(transfer.getByText('2 个成功 · 0 个阻断 · 0 个失败', { exact: true })).toBeVisible();
    const request = await page.evaluate(() => (window as any).__lastTransfer);
    const result = await send(page, request);
    const items = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items).toHaveLength(5);
    const targets = items.filter((item: any) => result.items.some((row: any) => row.targetItemId === item.id));
    expect(targets).toHaveLength(2); expect(targets.every((item: any) => item.categoryId === 8 && item.categoryName === 'Destination')).toBe(true);
    const provider = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.kind === 'local');
    const target = targets.find((item: any) => item.username === 'synthetic');
    const listRequest = { type: 'PROVIDER_ATTACHMENT_LIST', providerId: provider.id, itemId: target.id };
    const original = (await send(page, listRequest)).items[0]; expect(original.fileName).toBe('original.bin');
    await transfer.getByRole('button', { name: '关闭批量传输', exact: true }).click();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^登录项/ }).click();
    // Use the real folder filter; category labels are not embedded in each compact row.
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    const filter = page.getByRole('dialog', { name: '筛选密码库', exact: true });
    await filter.locator('.folder-scope-list button').filter({ hasText: 'Destination' }).click();
    await filter.getByRole('button', { name: '完成', exact: true }).click();
    const manageCopy = page.getByRole('button', { name: '管理 Local source 的附件', exact: true });
    await expect(manageCopy).toHaveCount(1);
    await manageCopy.click();
    attachments = dialogContent(page, { name: '附件 · Local source' });
    expect(await downloadFromDialog(page, attachments)).toEqual(Buffer.from([0, 1, 255, 2]));
    const replace = page.waitForEvent('filechooser');
    await attachments.getByRole('button', { name: '替换 original.bin 的内容', exact: true }).click();
    await (await replace).setFiles({ name: 'renamed.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([9, 8, 7]) });
    await expect(attachments.locator('.provider-attachment-row')).toContainText('3 B');
    expect(await downloadFromDialog(page, attachments)).toEqual(Buffer.from([9, 8, 7]));
    const stale = await page.evaluate(input => chrome.runtime.sendMessage(input), { type: 'PROVIDER_ATTACHMENT_DELETE', providerId: provider.id,
      itemId: target.id, attachmentId: original.attachmentId, expectedRevision: original.revision, operationId: crypto.randomUUID(), confirmed: true });
    expect(stale.ok).toBe(false); expect(stale.error).toContain('已变化');
    await attachments.getByRole('button', { name: '删除 original.bin', exact: true }).click();
    await expect(attachments.getByRole('button', { name: '确认删除', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(attachments.getByText('original.bin', { exact: true })).toHaveCount(0);
    await context.close(); context = await launchEdgeContext(profile, options); page = await manager(context);
    await send(page, { type: 'VAULT_UNLOCK', masterPassword: '' });
    expect(await send(page, request)).toEqual(result);
    expect(await send(page, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(5);
    expect((await send(page, listRequest)).items).toEqual([]);
    expect((await send(page, { ...listRequest, itemId: 'source-one' })).items).toHaveLength(1);
    const popup = await context.newPage(); await popup.goto(page.url().replace('index.html', 'popup.html'));
    const denied = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'LOCAL_TRANSFER_FOLDERS' }));
    expect(denied.ok).toBe(false); expect(denied.error).toContain('管理页');
  } finally { await context.close(); }
});

test('real KDBX files copy to local through the product UI without altering the source', async ({}, info) => {
  const context = await launchEdgeContext(info.outputPath('profile'), options);
  try {
    const page = await manager(context); await send(page, { type: 'VAULT_SETUP', masterPassword: '' }); await page.reload();
    const body = Buffer.from([0, 255, 17, 4, 3]);
    const fixture = await buildKeePassFixture({ password: 'synthetic', version: 4, kdf: 'argon2id', entries: [{ title: 'KDBX source', group: 'Games',
      fields: { UserName: 'synthetic', URL: 'https://example.test' }, protectedFields: { Password: 'synthetic-secret' }, binaries: { 'Steam 原文件.maFile': new Uint8Array(body) } }] });
    await page.getByRole('button', { name: '密码源', exact: true }).click(); await page.getByRole('button', { name: /连接 KeePass/ }).click();
    const connection = dialogContent(page, { name: '连接 KeePass' });
    await connection.getByLabel('显示名称').fill('Synthetic KDBX');
    await connection.getByLabel('KeePass 数据库文件').setInputFiles({ name: 'synthetic.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture) });
    await connection.getByLabel('数据库密码（可留空）').fill('synthetic'); await connection.getByRole('button', { name: '解锁并连接', exact: true }).click();
    await expect(connection).toHaveCount(0);
    await page.locator('m3e-card.source-card').filter({ hasText: 'Synthetic KDBX' }).getByRole('button', { name: '立即同步', exact: true }).click();
    await expect.poll(async () => (await send(page, { type: 'VAULT_LIST_ITEMS' })).some((item: any) => item.title === 'KDBX source')).toBe(true);
    const before = (await send(page, { type: 'VAULT_LIST_ITEMS' })).find((item: any) => item.title === 'KDBX source');
    await page.locator('[data-home-provider-id="local"]').getByRole('button', { name: '批量传输', exact: true }).click();
    const transfer = dialogContent(page, { name: '复制或移动项目' });
    await transfer.getByRole('checkbox', { name: /KDBX source/ }).check();
    await transfer.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(transfer.getByText('1 个可传输，0 个被阻断', { exact: true })).toBeVisible();
    await observeTransfers(page); await transfer.getByRole('button', { name: '执行复制', exact: true }).click();
    await expect(transfer.getByText('1 个成功 · 0 个阻断 · 0 个失败', { exact: true })).toBeVisible();
    const result = await send(page, await page.evaluate(() => (window as any).__lastTransfer));
    const items = await send(page, { type: 'VAULT_LIST_ITEMS' }), target = items.find((item: any) => item.id === result.items[0].targetItemId);
    expect(items.find((item: any) => item.id === before.id)).toEqual(before);
    expect(target.providerRefs).toEqual([]); expect(target.categoryName).toContain('Games'); expect(target.password).toBe(before.password);
    for (const [providerId, itemId] of [['local', target.id], [before.providerRefs[0].providerId, before.id]]) {
      const file = (await send(page, { type: 'PROVIDER_ATTACHMENT_LIST', providerId, itemId })).items[0];
      expect(file.fileName).toBe('Steam 原文件.maFile');
      const read = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_BEGIN', providerId, itemId, attachmentId: file.attachmentId });
      const chunk = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_CHUNK', providerId, readHandle: read.readHandle, offset: 0 });
      expect(Buffer.from(chunk.dataBase64, 'base64')).toEqual(body);
      await send(page, { type: 'PROVIDER_ATTACHMENT_READ_RELEASE', providerId, readHandle: read.readHandle });
    }
    await page.screenshot({ path: info.outputPath('kdbx-local-completed.png') });
  } finally { await context.close(); }
});
