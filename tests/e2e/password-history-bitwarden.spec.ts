import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import type { LoginItem } from '../../src/core/model';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';

const master = 'Synthetic live history browser vault';
interface Fixture { synthetic: boolean; baseUrl: string; email: string; password: string; name: string; expected: LoginItem[]; }
async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data as T;
}
async function launch(info: TestInfo, name: string) {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath(name), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 940 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await send(page, { type: 'VAULT_SETUP', masterPassword: master });
  await page.reload(); return { context, page };
}
async function connect(page: Page, fixture: Fixture) {
  await page.getByRole('button', { name: '密码源', exact: true }).click();
  await page.locator('m3e-list-action').filter({ hasText: '连接 Bitwarden' }).click();
  const form = dialogContent(page, { name: '连接 Bitwarden', exact: true });
  for (const [label, value] of Object.entries({ '显示名称': fixture.name, '服务器地址 *': fixture.baseUrl, '邮箱 *': fixture.email, '主密码 *': fixture.password }))
    await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole('button', { name: '登录并连接', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 30000 });
  const source = page.locator('[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: fixture.name, exact: true }) });
  await expect(source).toBeVisible();
  const id = await source.getAttribute('data-home-provider-id'); expect(id).toBeTruthy();
  await sync(page, id!); return id!;
}
async function sync(page: Page, providerId: string) {
  await page.getByRole('button', { name: '密码源', exact: true }).click();
  const source = page.locator(`[data-home-provider-id="${providerId}"]`);
  const before = (await send<{ id: string; lastSyncAt?: string }[]>(page, { type: 'PROVIDER_LIST' })).find(row => row.id === providerId)?.lastSyncAt;
  await source.locator('.source-actions-primary').getByRole('button', { name: /^(立即同步|重试同步)$/ }).click();
  await expect.poll(async () => {
    const current = (await send<{ id: string; lastSyncAt?: string; lastError?: string }[]>(page, { type: 'PROVIDER_LIST' })).find(row => row.id === providerId);
    return !!current?.lastSyncAt && current.lastSyncAt !== before && !current.lastError;
  }, { timeout: 30000 }).toBe(true);
  await expect(source.getByRole('button', { name: '取消同步', exact: true })).toHaveCount(0, { timeout: 30000 });
}
async function open(page: Page, title: string) {
  await page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
  await page.getByRole('button', { name: `查看${title}详情`, exact: true }).click();
  return dialogContent(page, { name: new RegExp(`^${title}$`) });
}
test('real Edge native history edits reach Vaultwarden and a separate fresh browser profile', async ({}, info) => {
  test.skip(!process.env.MONICA_317_PASSWORD_HISTORY_FIXTURE, 'Requires an explicit isolated running Vaultwarden fixture');
  const latest = JSON.parse(await readFile(process.env.MONICA_317_PASSWORD_HISTORY_FIXTURE!, 'utf8')) as { fixture: string };
  const fixture = JSON.parse(await readFile(latest.fixture, 'utf8')) as Fixture;
  expect(fixture.synthetic).toBe(true); expect(fixture.baseUrl).toBe('http://127.0.0.1:18316'); expect(fixture.email).toMatch(/^history-[0-9a-f-]+@example\.invalid$/);
  let expected: LoginItem;
  const app = await launch(info, 'client-a');
  try {
    const providerId = await connect(app.page, fixture);
    let rows = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' }); expect(rows).toHaveLength(2);
    expect(rows.find(row => row.title === 'Native history')?.passwordHistory).toEqual(fixture.expected.find(row => row.title === 'Native history')?.passwordHistory);
    let view = await open(app.page, 'Partial native history');
    await view.locator('.password-history').getByRole('button', { name: /密码历史/ }).click();
    await expect(view.getByText('部分历史无法显示，已保留在原密码源。', { exact: true })).toBeVisible();
    await expect(view.locator('.history-row')).toHaveCount(3);
    await view.getByRole('button', { name: '关闭', exact: true }).click();
    view = await open(app.page, 'Native history');
    await view.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = dialogContent(app.page, { name: '编辑密码', exact: true });
    await editor.getByLabel('密码', { exact: true }).fill('changed in real Edge');
    await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
    await sync(app.page, providerId);
    rows = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' });
    const saved = rows.find(row => row.title === 'Native history')!;
    expect(saved.passwordHistory?.[0].password).toBe('third');
    view = await open(app.page, 'Native history');
    const history = view.locator('.password-history'); await history.getByRole('button', { name: /密码历史/ }).click();
    await history.getByRole('button', { name: '删除历史密码 1', exact: true }).click();
    await history.getByRole('button', { name: '删除这条历史', exact: true }).click();
    await expect(history.locator('.history-row')).toHaveCount(saved.passwordHistory!.length - 1);
    await view.getByRole('button', { name: '关闭', exact: true }).click(); await sync(app.page, providerId);
    expected = (await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' })).find(row => row.title === 'Native history')!;
    expect(expected.passwordHistory).toEqual(saved.passwordHistory!.slice(1)); expect(expected.password).toBe('changed in real Edge');
    // A separate API login confirms the actual server independently of the browser cache.
    const login = await new BitwardenClient().login({ vaultUrl: fixture.baseUrl, email: fixture.email, masterPassword: fixture.password, deviceId: crypto.randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Fresh independent login failed');
    const server = await new BitwardenProvider().sync({ id: 'independent', kind: 'bitwarden', name: fixture.name, enabled: true, isDefaultSaveTarget: false, config: login.session }, { localItems: [], now: new Date().toISOString() });
    expect((server.items.find(row => row.title === 'Native history') as LoginItem).passwordHistory).toEqual(expected.passwordHistory);
    expect((server.items.find(row => row.title === 'Partial native history') as LoginItem).passwordHistoryIncomplete).toBe(true);
  } finally { await app.context.close(); }
  const fresh = await launch(info, 'client-b');
  try {
    await connect(fresh.page, fixture);
    const actual = (await send<LoginItem[]>(fresh.page, { type: 'VAULT_LIST_ITEMS' })).find(row => row.title === 'Native history')!;
    expect(actual.passwordHistory).toEqual(expected!.passwordHistory); expect(actual.password).toBe('changed in real Edge');
    const view = await open(fresh.page, 'Native history'), history = view.locator('.password-history');
    await history.getByRole('button', { name: /密码历史/ }).click(); await expect(history.locator('.history-row')).toHaveCount(actual.passwordHistory!.length);
    await fresh.page.setViewportSize({ width: 420, height: 900 }); await history.scrollIntoViewIfNeeded();
    await fresh.page.screenshot({ path: info.outputPath('fresh-native-history-420.png') });
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ status: 'passed', sourceFixture: latest.fixture, profiles: ['client-a', 'client-b'],
      actualServer: 'Vaultwarden 1.37.3', uiLogin: true, uiEditAndDelete: true, independentApiReadback: true, freshBrowserSourceConnection: true,
      incompleteHistoryLoginVisible: true, expectedHistory: actual.passwordHistory, androidVerified: false }, null, 2));
  } finally { await fresh.context.close(); }
});
