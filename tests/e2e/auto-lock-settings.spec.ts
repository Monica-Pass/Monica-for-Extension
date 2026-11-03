import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

const password = 'synthetic auto lock test password';
const extension = path.resolve('dist');
const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const, viewport: { width: 1180, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
async function open(context: BrowserContext, errors: string[] = []) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  return page;
}
async function send(page: Page, request: object) {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function protection(page: Page) {
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.locator('[data-settings-entry="protection"]').click();
  await expect(page.getByLabel('自动锁定时间（分钟）')).toBeEnabled();
}
async function unlock(page: Page) {
  await expect(page.getByRole('heading', { name: '解锁 Monica', exact: true })).toBeVisible();
  await page.locator('input[type="password"][autocomplete="current-password"]').first().fill(password);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByRole('button', { name: '立即锁定', exact: true })).toBeVisible();
}

test('custom lock minutes validate and persist through real UI lock, browser restart and narrow layout', async ({}, info) => {
  test.setTimeout(180_000);
  const profile = info.outputPath('profile'), errors: string[] = []; let context: BrowserContext | undefined;
  try {
    context = await launchEdgeContext(profile, options); let page = await open(context, errors);
    await send(page, { type: 'VAULT_SETUP', masterPassword: password }); await page.reload(); await protection(page);
    const input = page.getByLabel('自动锁定时间（分钟）'), save = page.getByRole('button', { name: '保存锁定时间', exact: true });
    await expect(input).toHaveValue('15'); await expect(save).toBeDisabled();
    for (const invalid of ['', '0', '1441', '1.5']) {
      await input.fill(invalid); await expect(save).toBeDisabled();
      expect(await send(page, { type: 'VAULT_AUTO_LOCK_GET' })).toBe(15);
    }
    const invalidResponse = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_AUTO_LOCK_SET', minutes: 0 }));
    expect(invalidResponse.ok).toBe(false);
    await input.fill('37'); await save.click();
    await expect(page.getByRole('status').filter({ hasText: '锁定时间已保存。' })).toBeVisible();
    expect(await send(page, { type: 'VAULT_AUTO_LOCK_GET' })).toBe(37);
    await page.setViewportSize({ width: 320, height: 950 });
    expect(await page.locator('.auto-lock-settings').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.setViewportSize(options.viewport);
    await page.getByRole('button', { name: '立即锁定', exact: true }).click(); await unlock(page); await protection(page);
    await expect(page.getByLabel('自动锁定时间（分钟）')).toHaveValue('37');
    await context.close(); context = await launchEdgeContext(profile, options); page = await open(context, errors);
    expect(await send(page, { type: 'VAULT_STATUS' })).toBe('locked'); await unlock(page); await protection(page);
    await expect(page.getByLabel('自动锁定时间（分钟）')).toHaveValue('37');
    await page.getByLabel('自动锁定时间（分钟）').fill('1440'); await page.getByRole('button', { name: '保存锁定时间', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '锁定时间已保存。' })).toBeVisible();
    expect(await send(page, { type: 'VAULT_AUTO_LOCK_GET' })).toBe(1440);
    expect(errors).toEqual([]);
  } finally { await context?.close(); }
});

test('one-minute custom inactivity timeout locks the actual background session without read keepalive', async ({}, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const context = await launchEdgeContext(info.outputPath('profile'), options);
  try {
    const page = await open(context, errors); await send(page, { type: 'VAULT_SETUP', masterPassword: password }); await page.reload(); await protection(page);
    await page.getByLabel('自动锁定时间（分钟）').fill('1');
    const started = Date.now(); await page.getByRole('button', { name: '保存锁定时间', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '锁定时间已保存。' })).toBeVisible();
    expect(await send(page, { type: 'VAULT_AUTO_LOCK_GET' })).toBe(1);
    await expect.poll(() => send(page, { type: 'VAULT_STATUS' }), { timeout: 90_000, intervals: [1000, 5000] }).toBe('locked');
    expect(Date.now() - started).toBeGreaterThanOrEqual(59_000);
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_AUTO_LOCK_GET' }))).ok).toBe(false);
    await page.reload(); await unlock(page); await protection(page);
    await expect(page.getByLabel('自动锁定时间（分钟）')).toHaveValue('1');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('English auto-lock control supports keyboard saving in a device-key vault', async ({}, info) => {
  const errors: string[] = [], context = await launchEdgeContext(info.outputPath('profile'), { ...options, locale: 'en-US' });
  try {
    const page = await open(context, errors); await send(page, { type: 'VAULT_SETUP', masterPassword: '' }); await page.reload();
    await page.getByRole('button', { name: 'Settings and backups', exact: true }).click();
    await page.locator('[data-settings-entry="protection"]').click();
    const input = page.getByLabel('Automatic lock time (minutes)'); await expect(input).toBeEnabled();
    await input.fill('12'); await input.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Lock time saved.' })).toBeVisible();
    expect(await send(page, { type: 'VAULT_AUTO_LOCK_GET' })).toBe(12);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
