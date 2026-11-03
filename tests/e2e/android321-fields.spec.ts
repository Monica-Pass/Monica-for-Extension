import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption, dialogContent } from './fixtures/material';
import { projectLogins } from './fixtures/project-logins';
import { ANDROID_URL_RULE_FIELD } from '../../src/core/url-rules';
import type { VaultItem } from '../../src/core/model';

async function send(page: Page, request: unknown): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
const base = { favorite: false, notes: 'Project note', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', providerRefs: [] };

test('Android 321 credential notes and URL edits persist across groups and restart', async ({}, info) => {
  test.setTimeout(120000);
  const extension = path.resolve('dist'), options = { locale: 'zh-CN', reducedMotion: 'reduce' as const,
    viewport: { width: 1200, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchEdgeContext(info.outputPath('profile'), options);
  try {
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    let page = await context.newPage(); await page.goto(url); await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const originals = projectLogins('https://example.test').slice(0, 3).map((row, i) => ({ ...row, uris: ['www.example.test'],
      customFields: [...row.customFields.map(field => ({ ...field, value: field.value.replace(/}$/, `,"note":"${i === 0 ? 'Other account' : 'Work note'}","future":9007199254740993}`) })),
        { name: ANDROID_URL_RULE_FIELD, protected: true, value: `{"version":1,"owner":${i},"urls":[{"url":"www.example.test","mode":"HOST","future":9007199254740993}]}` }] }));
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: originals }); await page.reload();
    await page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await page.getByRole('button', { name: '查看Example Mail详情', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = dialogContent(page, { name: '编辑密码', exact: true });
    await expect(editor.getByLabel('凭据备注', { exact: true })).toHaveValue('Work note');
    await editor.getByLabel('凭据备注', { exact: true }).fill('  Edited work\n备注  ');
    await editor.getByLabel('网址 1', { exact: true }).fill('https://www.example.test/Auth');
    await chooseOption(editor.locator('.uri-rule-row m3e-select'), 'exact');
    await page.setViewportSize({ width: 420, height: 950 });
    await editor.getByLabel('凭据备注', { exact: true }).scrollIntoViewIfNeeded();
    expect(await editor.locator('#login-item-form').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('credential-note-420.png') });
    await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
    const saved: VaultItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
    for (const original of originals) {
      const row = saved.find(item => item.id === original.id)!;
      expect(row.kind).toBe('login'); if (row.kind !== 'login') throw Error('login missing');
      const credential = JSON.parse(row.customFields[0].value);
      expect(credential.note).toBe(original.id === 'project-password-3' ? 'Other account' : '  Edited work\n备注  ');
      expect(row.notes).toBe(original.notes);
      expect(row.customFields[0].value).toContain('9007199254740993');
      const carrier = JSON.parse(row.customFields[1].value);
      expect(carrier.owner).toBe(JSON.parse(original.customFields[1].value).owner);
      expect(carrier.urls).toEqual([{ url: 'https://www.example.test/Auth', mode: 'EXACT', future: 9007199254740992 }]);
      expect(row.customFields[1].value).toContain('9007199254740993');
    }
    await context.close(); context = await launchEdgeContext(info.outputPath('profile'), options);
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await send(page, { type: 'VAULT_LIST_ITEMS' })).toEqual(saved);
  } finally { await context.close(); }
});

test('Android 321 wallet templates edit known fields and retain unknown templates and raw strings', async ({}, info) => {
  test.setTimeout(120000);
  const extension = path.resolve('dist'), context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1200, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    for (const template of ['MEMBERSHIP', 'REWARDS', 'TRAVEL', 'FUTURE_TEMPLATE']) {
      const item = { ...base, id: template, kind: 'identity', title: `Synthetic ${template}`, documentType: 'OTHER', documentNumber: '000123007',
        fullName: '  Holder  ', firstName: '', middleName: '', lastName: '', walletTemplate: template,
        walletFields: { tier: 'Gold', points: '0007', departure: '2026-10-21T10:30+08:00', future: '  Raw\r\n  ' }, customFields: [] };
      await send(page, { type: 'VAULT_UPSERT_ITEM', item }); await page.reload();
      await page.getByRole('button', { name: /钱包与身份/ }).click();
      await page.getByRole('button', { name: `查看${item.title}详情`, exact: true }).click();
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      const editor = dialogContent(page).filter({ has: page.locator('#vault-item-form') });
      await expect(editor.getByLabel('卡号或票号', { exact: true })).toHaveValue('000123007');
      if (template === 'REWARDS') await editor.getByLabel('积分余额', { exact: true }).fill('');
      if (template === 'TRAVEL') {
        await expect(editor.getByLabel('出发时间', { exact: true })).toHaveValue(item.walletFields.departure);
        await editor.getByLabel('出发时间', { exact: true }).fill('2026-10-22T10:30+08:00');
        await page.setViewportSize({ width: 420, height: 950 });
        await editor.getByLabel('出发时间', { exact: true }).scrollIntoViewIfNeeded();
        expect(await editor.locator('#vault-item-form').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath('travel-pass-420.png') });
      }
      if (template === 'FUTURE_TEMPLATE') {
        await expect(editor.locator('[data-wallet-template] m3e-select')).toHaveJSProperty('disabled', true);
        await expect(editor.getByText('此卡包模板暂不支持，原始字段已保留。')).toBeVisible();
      }
      await editor.getByLabel('名称 *', { exact: true }).fill(item.title + ' edited');
      await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
      const saved = (await send(page, { type: 'VAULT_LIST_ITEMS' })).find((row: VaultItem) => row.id === item.id);
      const expectedFields = { ...item.walletFields } as Record<string, string>;
      if (template === 'REWARDS') delete expectedFields.points;
      if (template === 'TRAVEL') expectedFields.departure = '2026-10-22T10:30+08:00';
      expect(saved).toMatchObject({ documentNumber: item.documentNumber, fullName: item.fullName, walletTemplate: template, walletFields: expectedFields });
      if (template === 'REWARDS') expect(saved.walletFields).not.toHaveProperty('points');
      await page.setViewportSize({ width: 1200, height: 950 });
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('unknown URL rule carriers remain intact on a title-only edit', async ({}, info) => {
  const extension = path.resolve('dist'), context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', viewport: { width: 1200, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const item = { ...base, id: 'future-rules', kind: 'login', title: 'Future rules', username: '', password: 'synthetic', uris: ['https://example.test'],
      customFields: [{ name: ANDROID_URL_RULE_FIELD, protected: true, value: '{"version":2,"future":9007199254740993}' }] };
    await send(page, { type: 'VAULT_UPSERT_ITEM', item }); await page.reload();
    await page.locator('button.nav-item').filter({ hasText: '登录项' }).click(); await page.getByRole('button', { name: '查看Future rules详情', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByText('网址匹配规则暂不支持，原始数据已保留且不会自动推荐。')).toBeVisible();
    await expect(page.getByRole('button', { name: '添加网址', exact: true })).toBeDisabled();
    await page.getByLabel('名称 *', { exact: true }).fill('Renamed future rules'); await page.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(page.locator('#login-item-form')).toHaveCount(0);
    expect((await send(page, { type: 'VAULT_LIST_ITEMS' }))[0]).toMatchObject({ uris: item.uris, customFields: item.customFields });
  } finally { await context.close(); }
});
