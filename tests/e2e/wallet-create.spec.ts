import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption, dialogContent } from './fixtures/material';
import type { VaultItem } from '../../src/core/model';

async function send(page: Page, request: unknown): Promise<any> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.data;
}

const passes = [
  { type: 'MEMBERSHIP', label: '会员卡', fields: { tier: 'Gold', website: 'https://member.example.test' }, labels: { tier: '会员等级', website: '网站' } },
  { type: 'REWARDS', label: '积分卡', fields: { tier: 'Silver', points: '0007', pointsExpiry: '2028-12-31', website: 'https://points.example.test' }, labels: { tier: '会员等级', points: '积分余额', pointsExpiry: '积分到期', website: '网站' } },
  { type: 'TRAVEL', label: '旅行票证', fields: { serviceNumber: 'G0007', origin: '上海', destination: '北京', departure: '2026-10-23T08:30+08:00', arrival: '2026-10-23T13:00+08:00', terminal: 'T2', gate: '007', seat: '01A', travelClass: '一等座' }, labels: { serviceNumber: '航班或车次', origin: '出发地', destination: '目的地', departure: '出发时间', arrival: '到达时间', terminal: '航站楼或站台', gate: '登机口', seat: '座位', travelClass: '舱位或席别' } }
] as const;

test('new menu groups barcode under security and creates all wallet passes with persistent fields', async ({}, info) => {
  test.setTimeout(180000);
  const extension = path.resolve('dist');
  const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const, viewport: { width: 1200, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchEdgeContext(info.outputPath('profile'), options);
  try {
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    let page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    await page.reload();
    for (const pass of passes) {
      await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
      const menu = page.getByRole('menu', { name: '选择新建类型', exact: true });
      await expect(menu.locator('m3e-menu-item-group[aria-label="账号与安全"] [data-create-type="BARCODE"]')).toBeVisible();
      await expect(menu.locator('m3e-menu-item-group[aria-label="钱包与其他"] [data-create-type="BARCODE"]')).toHaveCount(0);
      await expect(menu.locator('m3e-menu-item-group[aria-label="钱包与其他"] [data-create-type]')).toHaveCount(6);
      await expect(menu.locator('[data-create-type="payment-account"]')).toHaveCount(0);
      if (pass.type === 'MEMBERSHIP') await page.screenshot({ path: info.outputPath('create-groups.png') });
      await menu.getByRole('menuitem', { name: pass.label, exact: true }).click();
      const editor = dialogContent(page, { name: `添加${pass.label}`, exact: true });
      await expect(editor.getByLabel('名称 *', { exact: true })).toBeFocused();
      await expect(editor.getByRole('combobox', { name: '卡包类型', exact: true })).toHaveJSProperty('value', pass.type);
      await editor.getByLabel('名称 *', { exact: true }).fill(`Synthetic ${pass.type}`);
      await editor.getByLabel('卡号或票号', { exact: true }).fill('000123007');
      await editor.getByLabel('持有人', { exact: true }).fill('  Synthetic Holder  ');
      await editor.getByLabel('发行方', { exact: true }).fill('Synthetic issuer');
      await editor.getByLabel('有效期至', { exact: true }).fill('2029-01-01');
      for (const [key, value] of Object.entries(pass.fields)) {
        await editor.getByLabel(pass.labels[key as keyof typeof pass.labels], { exact: true }).fill(value);
      }
      if (pass.type === 'TRAVEL') {
        await page.setViewportSize({ width: 420, height: 950 });
        await editor.getByLabel('出发时间', { exact: true }).scrollIntoViewIfNeeded();
        expect(await editor.locator('#vault-item-form').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('create-travel-420.png') });
      }
      await editor.getByRole('button', { name: '加密保存', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await page.setViewportSize({ width: 1200, height: 950 });
      const saved: VaultItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
      expect(saved.find(item => item.title === `Synthetic ${pass.type}`)).toMatchObject({
        kind: 'identity', documentType: 'OTHER', walletTemplate: pass.type, documentNumber: '000123007',
        fullName: '  Synthetic Holder  ', issuedBy: 'Synthetic issuer', expiryDate: '2029-01-01', walletFields: pass.fields
      });
    }
    // Cancelling a template must not make the next ordinary document a pass.
    await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
    await page.getByRole('menuitem', { name: '会员卡', exact: true }).click();
    await chooseOption(dialogContent(page).getByRole('combobox', { name: '卡包类型', exact: true }), 'REWARDS');
    await expect(dialogContent(page, { name: '添加积分卡', exact: true }).getByLabel('积分余额', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogContent(page)).toHaveCount(0);
    await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
    await page.getByRole('menuitem', { name: '证件', exact: true }).click();
    const identity = dialogContent(page, { name: '添加证件', exact: true });
    await expect(identity.getByRole('combobox', { name: '卡包类型', exact: true })).toHaveJSProperty('value', 'identity');
    await expect(identity.locator('[data-wallet-pass-common]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialogContent(page)).toHaveCount(0);
    await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
    await page.getByRole('menuitem', { name: '条码', exact: true }).click();
    await expect(dialogContent(page, { name: '添加条码', exact: true }).getByLabel('条码内容', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
    context = await launchEdgeContext(info.outputPath('profile'), options);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await page.getByRole('button', { name: /^钱包与身份/ }).click();
    for (const pass of passes) {
      await page.getByRole('button', { name: `查看Synthetic ${pass.type}详情`, exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      const editor = dialogContent(page, { name: `编辑${pass.label}`, exact: true });
      await expect(editor.getByRole('combobox', { name: '卡包模板', exact: true })).toHaveJSProperty('value', pass.type);
      await expect(editor.getByLabel('卡号或票号', { exact: true })).toHaveValue('000123007');
      for (const [key, value] of Object.entries(pass.fields)) {
        await expect(editor.getByLabel(pass.labels[key as keyof typeof pass.labels], { exact: true })).toHaveValue(value);
      }
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('fallback full chooser shares categories and opens selected wallet template', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await context.addInitScript(() => Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: undefined }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    await page.reload();
    for (const pass of passes) {
      const trigger = page.getByRole('button', { name: '选择新建类型', exact: true });
      await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await trigger.click();
      const picker = dialogContent(page, { name: '新建项目', exact: true });
      await expect(picker.locator('section').filter({ has: page.getByRole('heading', { name: '账号与安全', exact: true }) }).getByRole('button', { name: /^条码/ })).toBeVisible();
      const wallet = picker.locator('section').filter({ has: page.getByRole('heading', { name: '钱包与其他', exact: true }) });
      await expect(wallet.getByRole('button', { name: /^条码/ })).toHaveCount(0);
      await expect(picker.getByRole('button', { name: /^支付账号/ })).toHaveCount(0);
      await wallet.getByRole('button', { name: new RegExp(`^${pass.label}`) }).click();
      const editor = dialogContent(page, { name: `添加${pass.label}`, exact: true });
      await expect(editor.getByRole('combobox', { name: '卡包类型', exact: true })).toHaveJSProperty('value', pass.type);
      await page.keyboard.press('Escape');
      await expect(dialogContent(page)).toHaveCount(0);
    }
  } finally { await context.close(); }
});
