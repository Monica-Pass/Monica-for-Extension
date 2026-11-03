import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

const document = { id: 'document-parity', kind: 'identity', title: 'Synthetic document parity', documentType: 'PASSPORT',
  documentNumber: 'P-SYNTHETIC-42', fullName: 'Independent full name', firstName: 'Given', middleName: 'Middle', lastName: 'Family',
  documentTitle: 'Dr.', username: 'synthetic-account', company: 'Synthetic company', email: 'person@example.test', phone: '+1-555-0100',
  address: { fullName: 'Different addressee', company: 'Delivery company', email: 'delivery@example.test', phone: '+1-555-0123',
    streetAddress: '42 Example Lane', apartment: 'Suite 42', city: 'Example City', stateProvince: 'Example Province', postalCode: '42000', country: 'Example Country',
    future: { exact: '9007199254740993', empty: null } }, address3: 'West entrance',
  notes: 'Independent notes', favorite: false, createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z', providerRefs: [],
  editorSectionOrder: ['custom', 'future', 'identity', 'address', 'photos', 'notes'],
  customFields: [{ name: 'Recovery', value: 'synthetic-old-secret', protected: true, future: { exact: '9007199254740993', empty: null } },
    { name: '', value: 'legacy unnamed value', protected: false },
    { name: 'Duplicate', value: 'first duplicate', protected: false },
    { name: 'Duplicate', value: 'second duplicate', protected: false, future: ['retain', null] }] };

async function open(page: Page) {
  await page.getByRole('button', { name: /钱包与身份/ }).click();
  await page.getByRole('button', { name: `查看${document.title}详情`, exact: true }).click();
}

for (const scenario of ['detail', 'edit'] as const) test(`document ${scenario} retains complete Android fields and custom occurrences`, async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce',
    viewport: { width: 1200, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }))).toMatchObject({ ok: true });
    expect(await page.evaluate(item => chrome.runtime.sendMessage({ type: 'VAULT_UPSERT_ITEM', item }), document)).toMatchObject({ ok: true });
    await page.reload();
    await open(page);
    const detail = page.locator('.detail-dialog');
    if (scenario === 'detail') {
      await detail.locator('m3e-expansion-panel [slot="header"]').filter({ hasText: '更多信息' }).click();
      for (const value of ['Dr.', document.username, document.address.streetAddress, document.address.apartment, document.address3,
        document.address.city, document.address.stateProvince, document.address.postalCode, document.address.country,
        document.address.fullName, document.address.company, document.address.email, document.address.phone]) {
        await expect(detail.getByText(value, { exact: true })).toBeVisible();
      }
      await detail.getByRole('button', { name: '复制街道地址', exact: true }).click();
      await expect(detail.locator('.detail-status')).toHaveText('已复制街道地址。');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(document.address.streetAddress);
      await detail.getByRole('button', { name: '显示证件号码', exact: true }).click();
      await expect(detail.getByText(document.documentNumber, { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath('document-detail-dark.png') });
      await detail.getByText(document.address.streetAddress, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath('document-address-dark.png') });
      await page.setViewportSize({ width: 320, height: 850 });
      expect(await detail.locator('.detail-scroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('document-detail-320.png') });
    } else {
      await detail.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByRole('button', { name: '编辑自定义字段', exact: true }).click();
      await page.getByLabel('自定义字段 1 值', { exact: true }).fill('synthetic-new-secret');
      await page.getByRole('button', { name: '上移自定义字段 4', exact: true }).click();
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '加密保存', exact: true }).click();
      await expect(page.locator('#vault-item-form')).toHaveCount(0);
      const result = await page.evaluate(async id => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data.find((item: {id: string}) => item.id === id), document.id);
      expect(result.customFields).toEqual([{ ...document.customFields[0], value: 'synthetic-new-secret' }, document.customFields[1], document.customFields[3], document.customFields[2]]);
      expect(result).toMatchObject({ ...document, customFields: result.customFields, updatedAt: result.updatedAt });
      await page.reload();
      await open(page);
      await detail.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByRole('button', { name: '编辑自定义字段', exact: true }).click();
      await expect(page.getByLabel('自定义字段 1 值', { exact: true })).toHaveAttribute('type', 'password');
      await expect(page.getByLabel('自定义字段 2 值', { exact: true })).toHaveValue('legacy unnamed value');
      await page.getByRole('button', { name: '添加字段', exact: true }).click();
      await page.getByLabel('自定义字段 5 值', { exact: true }).fill('unsaved value must not disappear');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '加密保存', exact: true }).click();
      await expect(page.locator('.editor-footer-status')).toHaveText('请输入自定义字段名称。');
      expect(await page.evaluate(async id => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data.find((item: {id: string}) => item.id === id), document.id)).toEqual(result);
      await page.getByRole('button', { name: '编辑自定义字段', exact: true }).click();
      await expect(page.getByLabel('自定义字段 5 值', { exact: true })).toHaveValue('unsaved value must not disappear');
      await page.getByRole('button', { name: '完成', exact: true }).click();
      await page.getByRole('button', { name: '取消', exact: true }).click();
    }
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
