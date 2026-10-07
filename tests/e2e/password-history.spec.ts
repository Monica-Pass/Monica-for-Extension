import { expect, test, type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import { createLoginItem, type LoginItem } from '../../src/core/model';
import { buildKeePassFixture } from '../../src/providers/keepass/keepass-fixture';

const master = 'synthetic history master password';
async function send<T = unknown>(page: Page, input: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), input);
  expect(result.ok, result.error).toBe(true); return result.data as T;
}
async function launch(info: TestInfo) {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('p'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`, page = await context.newPage();
  await page.goto(`${origin}/index.html`); return { context, page, origin };
}
async function detail(page: Page, title: string) {
  await page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
  await page.getByRole('button', { name: `查看${title}详情`, exact: true }).click();
  return dialogContent(page, { name: new RegExp(title) });
}
test('actual editor saves password history, protects reveal/copy/delete, and survives a full Edge restart', async ({}, info) => {
  const app = await launch(info);
  const old = 'synthetic-very-long-password-'.repeat(5) + '<img src=x onerror=alert(1)>';
  const item = createLoginItem({ title: 'History fixture', password: old, uris: ['https://history.example.test'] });
  let expected: LoginItem;
  try {
    await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    await send(app.page, { type: 'VAULT_IMPORT_ITEMS', items: [item] });
    await app.page.reload();
    for (const password of ['second synthetic', 'third synthetic']) {
      const view = await detail(app.page, item.title);
      await view.getByRole('button', { name: '编辑', exact: true }).click();
      const editor = dialogContent(app.page, { name: '编辑密码', exact: true });
      await expect(editor).toBeVisible();
      await editor.getByLabel('密码', { exact: true }).fill(password);
      await editor.getByRole('button', { name: '加密保存', exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    let saved = await send<LoginItem>(app.page, { type: 'VAULT_GET_ITEM', itemId: item.id });
    expect(saved.passwordHistory?.map(row => row.password)).toEqual(['second synthetic', old]);
    const view = await detail(app.page, item.title), history = view.locator('.password-history');
    await expect(history.locator('.history-row')).toHaveCount(0);
    await history.getByRole('button', { name: /密码历史/ }).click();
    await expect(history.locator('code')).toHaveText(['••••••••', '••••••••']);
    await history.getByRole('button', { name: '显示历史密码 2', exact: true }).click();
    await expect(history.locator('code').nth(1)).toHaveText(old);
    await expect(history.locator('img')).toHaveCount(0);
    await history.getByRole('button', { name: '复制历史密码 2', exact: true }).click();
    expect(await app.page.evaluate(() => navigator.clipboard.readText())).toBe(old);
    await app.page.setViewportSize({ width: 320, height: 850 });
    await history.scrollIntoViewIfNeeded();
    expect(await history.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const axe = await new AxeBuilder({ page: app.page }).include('.password-history').analyze();
    expect(axe.violations.filter(row => row.impact === 'serious' || row.impact === 'critical')).toEqual([]);
    await app.page.screenshot({ path: info.outputPath('history-320.png') });
    await history.getByRole('button', { name: /密码历史/ }).click();
    await history.getByRole('button', { name: /密码历史/ }).click();
    await expect(history.locator('code')).toHaveText(['••••••••', '••••••••']);
    // Hold only the outgoing delete acknowledgement, then make a real later edit.
    await app.page.evaluate(() => {
      const target = window as unknown as { historyGate: { count: number; release?: () => Promise<void>; restore: () => void } };
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      target.historyGate = { count: 0, restore: () => { chrome.runtime.sendMessage = original; } };
      chrome.runtime.sendMessage = ((request: { type: string }) => {
        if (request.type !== 'VAULT_DELETE_PASSWORD_HISTORY') return original(request);
        target.historyGate.count++;
        return new Promise(resolve => { target.historyGate.release = async () => { resolve(await original(request)); }; });
      }) as typeof chrome.runtime.sendMessage;
    });
    await history.getByRole('button', { name: '删除历史密码 1', exact: true }).click();
    const confirm = history.getByRole('button', { name: '删除这条历史', exact: true });
    await confirm.click(); await expect(confirm).toBeDisabled();
    await confirm.evaluate(button => (button as HTMLButtonElement).click());
    expect(await app.page.evaluate(() => (window as unknown as { historyGate: { count: number } }).historyGate.count)).toBe(1);
    await send(app.page, { type: 'VAULT_UPSERT_ITEM', item: { ...saved, notes: 'concurrent edit retained' }, expectedUpdatedAt: saved.updatedAt });
    await app.page.evaluate(async () => {
      const gate = (window as unknown as { historyGate: { release: () => Promise<void>; restore: () => void } }).historyGate;
      gate.restore(); await gate.release();
    });
    await expect(history.getByRole('status')).toContainText('密码历史已变化');
    saved = await send<LoginItem>(app.page, { type: 'VAULT_GET_ITEM', itemId: item.id });
    expect(saved.notes).toBe('concurrent edit retained'); expect(saved.passwordHistory).toHaveLength(2);
    await history.getByRole('button', { name: '删除历史密码 1', exact: true }).click();
    await history.getByRole('button', { name: '取消', exact: true }).click();
    expect((await send<LoginItem>(app.page, { type: 'VAULT_GET_ITEM', itemId: item.id })).passwordHistory).toEqual(saved.passwordHistory);
    await history.getByRole('button', { name: '删除历史密码 1', exact: true }).click();
    const acknowledged = await send<LoginItem>(app.page, { type: 'VAULT_UPSERT_ITEM', item: { ...saved, notes: 'later metadata only' }, expectedUpdatedAt: saved.updatedAt });
    await expect(view.getByText('later metadata only', { exact: true })).toBeVisible();
    await expect(history.getByRole('button', { name: '删除这条历史', exact: true })).toBeVisible();
    expect(acknowledged.passwordHistory).toEqual(saved.passwordHistory);
    await history.getByRole('button', { name: '删除这条历史', exact: true }).click();
    await expect(history.locator('.history-row')).toHaveCount(1);
    const stale = await app.page.evaluate(row => chrome.runtime.sendMessage({ type: 'VAULT_DELETE_PASSWORD_HISTORY', itemId: row.id, index: 0, expectedUpdatedAt: row.updatedAt }), saved);
    expect(stale.ok).toBe(false);
    saved = await send<LoginItem>(app.page, { type: 'VAULT_GET_ITEM', itemId: item.id });
    expect(saved.password).toBe('third synthetic'); expect(saved.passwordHistory?.map(row => row.password)).toEqual([old]);
    const popup = await app.context.newPage(); await popup.goto(`${app.origin}/popup.html`);
    expect(await popup.evaluate(row => chrome.runtime.sendMessage({ type: 'VAULT_DELETE_PASSWORD_HISTORY', itemId: row.id, index: 0, expectedUpdatedAt: row.updatedAt }), saved)).toMatchObject({ ok: false });
    await popup.close(); expected = saved;
  } finally { await app.context.close(); }
  const reopened = await launch(info);
  try {
    await send(reopened.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    expect(await send(reopened.page, { type: 'VAULT_GET_ITEM', itemId: item.id })).toEqual(expected!);
    await reopened.page.reload();
    const view = await detail(reopened.page, item.title);
    await view.locator('.password-history').getByRole('button', { name: /密码历史/ }).click();
    await expect(view.locator('.history-row code')).toHaveText('••••••••');
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed: true, editorSaves: 2, copiedExactText: true, cancelledDeleteUnchanged: true, duplicateDeleteBlocked: true, concurrentEditRetained: true, staleRejected: true, popupDenied: true, restart: true, historyCount: 1 }, null, 2));
  } finally { await reopened.context.close(); }
});

test('KDBX sync and same-source encrypted reopen retain local password history', async ({}, info) => {
  const bytes = await buildKeePassFixture({ password: master, entries: [{ title: 'KDBX history fixture', protectedFields: { Password: 'original' } }] });
  const app = await launch(info); let providerId = '', file = '', expected: LoginItem;
  try {
    await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    providerId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_OPEN', input: { name: 'History', fileName: 'history.kdbx', file: Buffer.from(bytes).toString('base64'), password: master } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    let item = (await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }))[0];
    item = await send<LoginItem>(app.page, { type: 'VAULT_UPSERT_ITEM', item: { ...item, password: 'changed' }, expectedUpdatedAt: item.updatedAt });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    expected = await send<LoginItem>(app.page, { type: 'VAULT_GET_ITEM', itemId: item.id });
    expect(expected.passwordHistory).toEqual([{ password: 'original', lastUsedAt: item.updatedAt }]);
    file = (await send<{ file: string }>(app.page, { type: 'KEEPASS_EXPORT_FILE', providerId })).file;
    await writeFile(info.outputPath('history.kdbx'), Buffer.from(file, 'base64'));
  } finally { await app.context.close(); }
  const reopened = await launch(info);
  try {
    await send(reopened.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    await send(reopened.page, { type: 'KEEPASS_OPEN', input: { providerId, name: 'History', fileName: 'history.kdbx', file, password: master } });
    await send(reopened.page, { type: 'PROVIDER_SYNC', providerId });
    expect((await send<LoginItem>(reopened.page, { type: 'VAULT_GET_ITEM', itemId: expected!.id })).passwordHistory).toEqual(expected!.passwordHistory);
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed: true, restart: true, localHistoryRetained: true, freshClientHistoryTransfer: 'not supported by current Android KDBX contract' }, null, 2));
  } finally { await reopened.context.close(); }
});
