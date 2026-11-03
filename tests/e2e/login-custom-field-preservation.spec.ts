import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { projectLogins } from './fixtures/project-logins';
import type { LoginItem } from '../../src/core/model';

async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<T> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(response.ok, response.error).toBe(true);
  return response.data as T;
}

test('editing project custom fields preserves empty source occurrences and independent passwords', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce',
    viewport: { width: 1180, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const rows = projectLogins('https://example.test');
    rows.find(row => row.id === 'independent-project')!.title = 'Independent sentinel';
    const primary = rows.find(row => row.id === 'project-password-1')!;
    primary.customFields.push(
      { name: 'Recovery', value: 'synthetic-secret', protected: true },
      { name: '', value: '', protected: true, future: { exact: '9007199254740993', empty: null } } as LoginItem['customFields'][number],
      { name: 'Duplicate', value: 'first', protected: false },
      { name: 'Duplicate', value: 'second', protected: true }
    );
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: rows });
    const before = await send<LoginItem[]>(page, { type: 'VAULT_LIST_ITEMS' });
    await page.reload();
    const open = async () => {
      await page.getByRole('button', { name: '查看Example Mail详情', exact: true }).first().click();
      await page.locator('.detail-dialog').getByRole('button', { name: '编辑', exact: true }).click();
      await expect(page.locator('#login-item-form')).toBeVisible();
      await page.getByRole('button', { name: '自定义字段', exact: true }).click();
      await expect(page.getByLabel('自定义字段 2 值', { exact: true })).toHaveValue('synthetic-secret');
    };
    await open();
    await page.getByLabel('自定义字段 4 值', { exact: true }).fill('edited first');
    await page.locator('.editor-content-dialog').getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(page.locator('#login-item-form')).toHaveCount(0);
    const saved = await send<LoginItem[]>(page, { type: 'VAULT_LIST_ITEMS' });
    for (const old of before) {
      const actual = saved.find(row => row.id === old.id)!;
      expect(actual.customFields).toEqual(old.id === primary.id
        ? old.customFields.map((field, index) => index === 3 ? { ...field, value: 'edited first' } : field)
        : old.customFields);
      expect(actual.password).toBe(old.password);
      expect(actual.passwordGroupId).toBe(old.passwordGroupId);
    }
    await page.reload();
    await open();
    await expect(page.getByLabel('自定义字段 3 名称', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('自定义字段 3 值', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '添加字段', exact: true }).click();
    await page.getByLabel('自定义字段 6 值', { exact: true }).fill('keep invalid draft');
    await page.locator('.editor-content-dialog').getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(page.locator('.editor-footer-status')).toHaveText('请输入自定义字段名称。');
    await page.getByRole('button', { name: '自定义字段', exact: true }).click();
    await expect(page.getByLabel('自定义字段 6 值', { exact: true })).toHaveValue('keep invalid draft');
    expect(await send(page, { type: 'VAULT_LIST_ITEMS' })).toEqual(saved);
    await page.locator('.editor-content-dialog').getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
