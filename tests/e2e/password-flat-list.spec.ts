import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchTestContext } from './fixtures/edge';

async function send(page: Page, message: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), message);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

for (const mode of ['website', 'manual'] as const) test(`flat password lists ignore legacy ${mode} stacks and retain project data`, async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchTestContext(info.outputPath('profile'), { channel: 'chromium', headless: true,
    locale: 'zh-CN', colorScheme: mode === 'website' ? 'dark' : 'light', viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: 'synthetic flat list password' });
    const base = { kind: 'login', username: 'personal@example.test', password: 'synthetic-secret', uris: ['https://example.test'],
      notes: '', favorite: false, createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z', providerRefs: [],
      customFields: [{ name: '__monica_manual_stack_group', value: 'synthetic-same-stack', protected: false }] };
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: [
      { ...base, id: 'personal', title: 'Example', isGroupCover: true },
      { ...base, id: 'work', title: 'Example', username: 'work@example.test' },
      { ...base, id: 'project-one', title: 'Mail project', passwordGroupId: 'mail', sortOrder: 0 },
      { ...base, id: 'project-two', title: 'Mail project', passwordGroupId: 'mail', sortOrder: 1, username: 'second@example.test', password: 'synthetic-second' },
      { ...base, id: 'api-key', title: 'Developer API', loginType: 'API_KEY', password: 'synthetic-api-secret' },
      { id: 'note', kind: 'secure-note', title: 'Travel note', content: 'Synthetic travel note', tags: [], favorite: false, notes: '', createdAt: base.createdAt, updatedAt: base.updatedAt, providerRefs: [], customFields: [] }
    ] });
    await send(page, { type: 'VAULT_HOME_SET', preferences: { passwordStackMode: mode, passwordWebsiteMatch: 'relaxed' } });
    const original = await send(page, { type: 'VAULT_LIST_ITEMS' });
    await page.reload();
    const cards = page.locator('.vault-list-card .item-card');
    await expect(cards).toHaveCount(5);
    const layout = () => page.locator('[data-item-id="personal"]').evaluate(el => {
      const css = getComputedStyle(el); return { height: el.getBoundingClientRect().height, columns: css.gridTemplateColumns,
        padding: css.padding, radius: css.borderRadius, background: css.backgroundColor };
    });
    const allLayout = await layout();
    expect(allLayout.height).toBeLessThanOrEqual(88);
    await page.screenshot({ path: info.outputPath('all-items.png') });
    await page.getByRole('navigation').getByRole('button', { name: /^登录项/ }).click();
    await expect(cards).toHaveCount(4);
    expect(await layout()).toEqual(allLayout);
    await expect(page.getByRole('combobox', { name: '显示分组', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /管理堆叠|设为封面|取消.*封面/ })).toHaveCount(0);
    await expect(page.locator('[data-password-stacks], .manual-stack-dialog, .credential-table')).toHaveCount(0);
    await expect(page.locator('[data-item-id="work"]')).toBeVisible();
    await page.locator('[data-item-id="project-one"]').getByRole('button', { name: '查看Mail project详情', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-project-navigation] [data-password-member-id]')).toHaveCount(2);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('searchbox').fill('second@example.test');
    await expect(cards).toHaveCount(1);
    await expect(page.locator('[data-item-id="project-one"]')).toBeVisible();
    await page.getByRole('searchbox').fill('');
    await expect(cards).toHaveCount(4);
    await page.getByRole('searchbox').blur();
    await page.screenshot({ path: info.outputPath('logins.png') });
    for (const width of [420, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const row = page.locator('[data-item-id="personal"]');
      for (const name of ['编辑登录项', '删除登录项', '管理 Example 的附件']) {
        const control = row.getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      await page.getByRole('searchbox').blur();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`logins-${width}.png`) });
    }
    await page.reload();
    await expect(cards).toHaveCount(5);
    expect(await send(page, { type: 'VAULT_LIST_ITEMS' })).toEqual(original);
    expect(await send(page, { type: 'VAULT_HOME_GET' })).toMatchObject({ passwordStackMode: mode });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
