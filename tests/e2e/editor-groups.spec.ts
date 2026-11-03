import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption, dialogContent } from './fixtures/material';

const walletTypes = ['card', 'identity', 'billing-address', 'MEMBERSHIP', 'REWARDS', 'TRAVEL'];
const credentialTypes = ['PASSWORD', 'API_KEY', 'WIFI', 'SSH_KEY', 'BARCODE', 'api-token', 'GPG_KEY'];
async function options(control: Locator) {
  await expect(control).toBeVisible();
  return control.locator('m3e-option, option').evaluateAll(nodes => nodes.map(node => (node as HTMLElement & { value: string }).value));
}
async function send(page: Page, request: unknown): Promise<any> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.data;
}
async function create(page: Page, label: string) {
  await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  return dialogContent(page);
}
test('new wallet stays in its group, card subtypes persist and standalone editors cannot switch groups', async ({}, info) => {
  test.setTimeout(150000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1200, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' }); await page.reload();
    let editor = await create(page, '银行卡');
    const wallet = () => dialogContent(page).getByRole('combobox', { name: '卡包类型', exact: true });
    expect(await options(wallet())).toEqual(walletTypes);
    expect(await options(editor.getByRole('combobox', { name: '卡类型', exact: true }))).toEqual(['DEBIT', 'CREDIT', 'PREPAID']);
    await editor.getByLabel('名称 *', { exact: true }).fill('Synthetic grouped bank');
    await editor.getByLabel('银行卡号 *', { exact: true }).fill('4111111111111111');
    await chooseOption(editor.getByRole('combobox', { name: '卡类型', exact: true }), 'PREPAID');
    await chooseOption(wallet(), 'REWARDS');
    editor = dialogContent(page, { name: '添加积分卡', exact: true });
    await expect(editor.getByLabel('名称 *', { exact: true })).toHaveValue('Synthetic grouped bank');
    await editor.getByLabel('积分余额', { exact: true }).fill('0088');
    await chooseOption(wallet(), 'TRAVEL');
    await expect(dialogContent(page).getByLabel('航班或车次', { exact: true })).toHaveValue('');
    await chooseOption(wallet(), 'REWARDS');
    await expect(dialogContent(page).getByLabel('积分余额', { exact: true })).toHaveValue('0088');
    for (const type of ['identity','billing-address','MEMBERSHIP','card']) await chooseOption(wallet(), type);
    editor = dialogContent(page, { name: '添加银行卡', exact: true });
    await expect(editor.getByLabel('银行卡号 *', { exact: true })).toHaveValue('4111111111111111');
    await expect(editor.getByRole('combobox', { name: '卡类型', exact: true })).toHaveJSProperty('value', 'PREPAID');
    await page.setViewportSize({ width: 420, height: 950 });
    expect(await editor.locator('form').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('bank-420.png') });
    await editor.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const items = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items.find((item: any) => item.title === 'Synthetic grouped bank')).toMatchObject({ kind: 'card', cardType: 'PREPAID', number: '4111111111111111' });
    await page.setViewportSize({ width: 1200, height: 950 });
    await page.getByRole('button', { name: /^钱包与身份/ }).click();
    await page.getByRole('button', { name: '查看Synthetic grouped bank详情', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    editor = dialogContent(page);
    await expect(editor.getByRole('combobox', { name: '卡类型', exact: true })).toHaveJSProperty('value', 'PREPAID');
    await expect(editor.getByRole('combobox', { name: '卡包类型', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
    editor = await create(page, '银行卡');
    await editor.getByLabel('名称 *', { exact: true }).fill('Synthetic switched rewards');
    await editor.getByLabel('银行卡号 *', { exact: true }).fill('4111111111111111');
    await chooseOption(wallet(), 'REWARDS');
    editor = dialogContent(page);
    await editor.getByLabel('积分余额', { exact: true }).fill('0007');
    await editor.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const switched = (await send(page, { type: 'VAULT_LIST_ITEMS' })).find((item: any) => item.title === 'Synthetic switched rewards');
    expect(switched).toMatchObject({ kind: 'identity', walletTemplate: 'REWARDS', walletFields: { points: '0007' } });
    expect(switched.number).toBeUndefined();
    for (const label of ['安全笔记', '动态验证码']) {
      editor = await create(page, label);
      await expect(editor.getByRole('combobox', { name: '项目类型', exact: true })).toHaveCount(0);
      await expect(editor.getByRole('combobox', { name: '卡包类型', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
    }
  } finally { await context.close(); }
});

test('credential group includes native API token with reversible separate drafts and resets after cancel', async ({}, info) => {
  test.setTimeout(120000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' }); await page.reload();
    let editor = await create(page, '密码');
    const type = () => dialogContent(page).getByRole('combobox', { name: '项目类型', exact: true });
    expect(await options(type())).toEqual(credentialTypes);
    await editor.getByLabel('名称 *', { exact: true }).fill('Synthetic credential');
    await editor.getByLabel('密码', { exact: true }).fill('synthetic-password');
    // A different editor replaces the select, so select by label without asserting on the disposed control.
    await type().click(); await page.getByRole('option', { name: 'API 令牌', exact: true }).click();
    editor = dialogContent(page);
    await expect(editor.getByLabel('服务商 *', { exact: true })).toBeVisible();
    expect(await options(type())).toEqual(credentialTypes);
    await expect(editor.getByLabel('名称 *', { exact: true })).toHaveValue('Synthetic credential');
    await editor.getByLabel('服务商 *', { exact: true }).fill('github');
    await editor.getByLabel('API 密钥 *', { exact: true }).fill('synthetic-token');
    await type().click(); await page.getByRole('option', { name: '密码', exact: true }).click();
    await expect(dialogContent(page).getByLabel('密码', { exact: true })).toHaveValue('synthetic-password');
    for (const kind of ['API_KEY', 'WIFI', 'SSH_KEY', 'BARCODE', 'GPG_KEY', 'PASSWORD']) await chooseOption(type(), kind);
    await type().click(); await page.getByRole('option', { name: 'API 令牌', exact: true }).click();
    await expect(dialogContent(page).getByLabel('API 密钥 *', { exact: true })).toHaveValue('synthetic-token');
    await dialogContent(page).getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(dialogContent(page)).toHaveCount(0);
    const items = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'api-token', token: 'synthetic-token', provider: 'github', title: 'Synthetic credential' });
    editor = await create(page, 'API Token');
    await expect(editor.getByLabel('API 密钥 *', { exact: true })).toHaveValue('');
    await editor.getByLabel('API 密钥 *', { exact: true }).fill('cancelled-token');
    await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0);
    editor = await create(page, 'API Token');
    await expect(editor.getByLabel('API 密钥 *', { exact: true })).toHaveValue('');
  } finally { await context.close(); }
});

test('legacy payment accounts remain editable while filtered primary create cannot create another payment account', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1200, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const legacy = { id: 'legacy-payment', kind: 'payment-account', title: 'Synthetic legacy payment', paymentType: 'DIGITAL_WALLET', provider: 'paypal', accountName: 'Original account', accountHolderName: 'Synthetic Holder', email: '', phone: '', username: '', accountId: 'synthetic-account-id', maskedAccountNumber: '**** 0007', routingNumber: '', iban: '', swiftBic: '', website: '', currency: 'USD', notes: 'Preserve legacy payment', favorite: false, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', providerRefs: [] };
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: [legacy] });
    await page.reload();
    await page.getByRole('button', { name: /^钱包与身份/ }).click();
    await page.getByRole('button', { name: '支付账号', exact: true }).click();
    await page.getByRole('button', { name: '添加钱包项目', exact: true }).click();
    await expect(dialogContent(page, { name: '添加银行卡', exact: true })).toBeVisible();
    expect(await options(dialogContent(page).getByRole('combobox', { name: '卡包类型', exact: true }))).toEqual(walletTypes);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '查看Synthetic legacy payment详情', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = dialogContent(page, { name: '编辑支付账号', exact: true });
    await expect(editor.getByLabel('账号 ID', { exact: true })).toHaveValue(legacy.accountId);
    await editor.getByLabel('账号名称', { exact: true }).fill('Updated legacy account');
    await editor.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const items = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ...legacy, accountName: 'Updated legacy account', updatedAt: expect.any(String) });
    await page.getByRole('button', { name: /^全部项目/ }).click();
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    const filters = dialogContent(page, { name: '筛选密码库' });
    await chooseOption(filters.getByRole('combobox', { name: '项目类型', exact: true }), 'payment-account');
    await filters.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: '新建', exact: true }).click();
    await expect(dialogContent(page, { name: '添加银行卡', exact: true })).toBeVisible();
  } finally { await context.close(); }
});
