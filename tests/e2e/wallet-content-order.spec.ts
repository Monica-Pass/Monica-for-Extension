import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption } from './fixtures/material';

test('wallet nested editor preserves secrets, ordering, cancel and keyboard boundaries', async ({}, info) => {
  test.setTimeout(150_000);
  const extension = path.resolve('dist');
  const profile = info.outputPath('profile');
  const options = { locale: 'zh-CN', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const,
    viewport: { width: 1200, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchEdgeContext(profile, options);
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    let page = await context.newPage();
    await page.goto(url);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }))).toMatchObject({ ok: true });
    await page.evaluate(() => { localStorage.setItem('monica.scheme', 'dark'); localStorage.setItem('monica.palette', 'monica'); });
    await page.reload();
    const search = page.getByRole('searchbox', { name: '搜索密码库' });
    await search.focus();
    expect(await search.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
    await page.screenshot({ path: info.outputPath('search-focus-dark.png') });
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    const filter = page.getByRole('dialog', { name: '筛选密码库', exact: true });
    const source = filter.locator('.filter-source-field');
    const shape = await source.evaluate(node => {
      const style = getComputedStyle(node.shadowRoot!.querySelector('.base')!, '::before');
      return { top: style.borderTopLeftRadius, bottom: style.borderBottomLeftRadius, border: style.borderBottomColor };
    });
    expect(shape).toMatchObject({ top: '24px', bottom: '24px', border: 'rgba(0, 0, 0, 0)' });
    await source.getByRole('combobox').click();
    await page.screenshot({ path: info.outputPath('database-open-dark.png') });
    await page.keyboard.press('Escape');
    await filter.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
    await page.locator('[data-create-type="card"]').click();
    const main = page.locator('m3e-dialog').filter({ has: page.locator('#vault-item-form') });
    await page.getByLabel('名称 *', { exact: true }).fill('Synthetic ordered card');
    await page.getByLabel('银行卡号 *', { exact: true }).fill('4111111111111111');
    await page.getByLabel('持卡人', { exact: true }).fill('Synthetic Holder');
    await page.screenshot({ path: info.outputPath('create-card-dark.png') });
    await page.getByRole('button', { name: '编辑更多银行卡信息', exact: true }).click();
    const nested = page.locator('.wallet-content-dialog');
    await page.getByLabel('PIN', { exact: true }).fill('9876');
    await page.getByLabel('银行', { exact: true }).fill('Synthetic bank');
    await page.keyboard.press('Enter');
    await expect(nested).toBeVisible();
    expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data)).toHaveLength(0);
    await nested.getByRole('button', { name: '完成', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(nested.getByRole('button', { name: '返回', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(nested.getByRole('button', { name: '完成', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(nested).toHaveCount(0);
    await expect(main).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑更多银行卡信息', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '编辑自定义字段', exact: true }).click();
    await nested.getByRole('button', { name: '添加字段' }).click();
    await page.getByLabel('自定义字段 1 名称', { exact: true }).fill('Recovery');
    await page.getByLabel('自定义字段 1 值', { exact: true }).fill('Synthetic secret');
    await chooseOption(page.getByLabel('自定义字段 1 类型', { exact: true }), 'HIDDEN');
    await nested.getByRole('button', { name: '添加字段' }).click();
    await page.getByLabel('自定义字段 2 名称', { exact: true }).fill('Second');
    await page.getByLabel('自定义字段 2 值', { exact: true }).fill('text');
    await page.getByRole('button', { name: '上移自定义字段 2', exact: true }).click();
    await expect(page.getByLabel('自定义字段 2 值', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('自定义字段 2 值', { exact: true })).toHaveValue('Synthetic secret');
    await page.setViewportSize({ width: 320, height: 850 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await nested.locator('.wallet-content-fields').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    for (const field of await nested.locator('m3e-form-field').filter({ has: page.locator('m3e-select') }).all()) {
      expect(await field.evaluate(node => node.shadowRoot!.querySelector('.label')!.getBoundingClientRect().bottom
        <= node.querySelector('m3e-select')!.getBoundingClientRect().top + 1)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath('wallet-custom-320-large-text.png') });
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 1200, height: 950 });
    await nested.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '上移自定义字段', exact: true }).click();
    await page.getByRole('button', { name: '上移自定义字段', exact: true }).click();
    await page.getByRole('button', { name: '编辑备注', exact: true }).click();
    await page.getByLabel('备注', { exact: true }).fill('Synthetic note');
    await nested.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(main).toHaveCount(0);
    const saved = await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data[0]);
    expect(saved).toMatchObject({ pin: '9876', notes: 'Synthetic note', editorSectionOrder: ['custom', 'billing', 'extended', 'notes'],
      customFields: [{ name: 'Second', value: 'text' }, { name: 'Recovery', value: 'Synthetic secret', fieldType: 'HIDDEN', protected: true }] });
    // Restart the actual browser profile, reopen, and cancel a reordered draft.
    await context.close();
    context = await launchEdgeContext(profile, options);
    page = await context.newPage();
    await page.goto(url);
    await page.getByRole('button', { name: /钱包与身份/ }).click();
    await page.getByRole('button', { name: '查看Synthetic ordered card详情', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    expect(await page.locator('[data-wallet-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-wallet-section')))).toEqual(['custom', 'billing', 'extended', 'notes']);
    await page.getByRole('button', { name: '下移自定义字段', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(await page.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data[0])).toEqual(saved);
  } finally { await context.close(); }
});
