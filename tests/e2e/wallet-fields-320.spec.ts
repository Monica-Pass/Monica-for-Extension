import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('independent profile editors persist and production autofill respects semantic scopes', async ({}, info) => {
  test.setTimeout(120000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', viewport: { width: 1200, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`, manager = await context.newPage();
    await manager.goto(url);
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }))).toMatchObject({ ok: true });
    const base = { favorite: false, notes: '', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', providerRefs: [] };
    const extras = { district: 'County', homeEmail: 'home@example.test', homePhone: '+12025550143', workEmail: 'work@example.test', workPhone: '+12025550144' };
    const items = [
      { ...base, ...extras, id: 'field-address', title: 'Synthetic address profile', kind: 'billing-address', fullName: 'Separate Full Name', firstName: 'Independent', middleName: 'Middle', lastName: 'Parts', company: '', streetAddress: 'One', apartment: 'Two', addressLine3: 'Three', city: 'City', stateProvince: '', country: 'US', postalCode: '00001', email: 'default@example.test', phone: '+12025550142' },
      { ...base, ...extras, id: 'field-identity', title: 'Synthetic identity profile', kind: 'identity', fullName: 'Identity Full Name', firstName: 'IdentityFirst', middleName: '', lastName: 'IdentityLast', documentType: 'OTHER', documentNumber: 'SYNTHETIC', address3: 'Third', address: { country: 'US' } },
      { ...base, id: 'field-card', title: 'Synthetic card profile', kind: 'card', cardholderName: 'Separate Holder', cardholderFirstName: 'CardFirst', cardholderMiddleName: 'CardMiddle', cardholderLastName: 'CardLast', number: '4111111111111111', expiryMonth: '12', expiryYear: '2030', securityCode: '123', billingAddress: '{"district":"Card County","addressLine3":"Card Third"}' }
    ];
    for (const item of items) expect(await manager.evaluate(item => chrome.runtime.sendMessage({ type: 'VAULT_UPSERT_ITEM', item }), item)).toMatchObject({ ok: true });
    for (const item of items) {
      await manager.reload(); await manager.getByRole('button', { name: /钱包与身份/ }).click();
      await manager.getByRole('button', { name: `查看${item.title}详情`, exact: true }).click();
      await manager.getByRole('button', { name: '编辑', exact: true }).click();
      if (item.kind === 'billing-address') {
        await manager.getByRole('button', { name: '姓名与联系方式', exact: true }).click();
        await expect(manager.getByLabel('名', { exact: true })).toHaveValue('Independent');
        await manager.getByLabel('名', { exact: true }).fill('Address Edited');
        await manager.getByLabel('家庭邮箱', { exact: true }).fill('');
        await manager.getByLabel('区/县', { exact: true }).fill('Edited County');
      } else if (item.kind === 'identity') {
        await manager.getByRole('button', { name: '编辑更多身份信息', exact: true }).click();
        await manager.getByLabel('名', { exact: true }).fill('Identity Edited');
        await manager.getByLabel('工作电话', { exact: true }).fill('+12025550145');
      } else {
        await manager.getByRole('button', { name: '编辑更多银行卡信息', exact: true }).click();
        await expect(manager.getByLabel('持卡人名', { exact: true })).toHaveValue('CardFirst');
        await manager.getByLabel('持卡人名', { exact: true }).fill('Card Edited');
        await manager.getByLabel('持卡人中间名', { exact: true }).fill('');
      }
      await manager.screenshot({ path: info.outputPath(`${item.kind}-editor.png`), fullPage: true, animations: 'disabled' });
      await manager.getByRole('button', { name: '完成', exact: true }).click();
      if (item.kind === 'card') {
        await manager.getByRole('button', { name: '编辑账单地址', exact: true }).click();
        await expect(manager.getByLabel('地址第三行', { exact: true })).toHaveValue('Card Third');
        await manager.getByLabel('区/县', { exact: true }).fill('Card County Edited');
        await manager.getByRole('button', { name: '完成', exact: true }).click();
      }
      await manager.getByRole('button', { name: '加密保存', exact: true }).click();
      await expect(manager.locator('#vault-item-form')).toHaveCount(0);
    }
    await manager.reload();
    const saved = await manager.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data);
    expect(saved.find((i: any) => i.id === 'field-address')).toMatchObject({ fullName: 'Separate Full Name', firstName: 'Address Edited', middleName: 'Middle', homeEmail: '', workEmail: 'work@example.test', addressLine3: 'Three', district: 'Edited County' });
    expect(saved.find((i: any) => i.id === 'field-identity')).toMatchObject({ fullName: 'Identity Full Name', firstName: 'Identity Edited', workPhone: '+12025550145' });
    expect(saved.find((i: any) => i.id === 'field-card')).toMatchObject({ cardholderName: 'Separate Holder', cardholderFirstName: 'Card Edited', cardholderMiddleName: '', cardholderLastName: 'CardLast' });
    await context.route('https://profile.example.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><title>Synthetic profile form</title>
      <form id="shipping"><input id="name" autocomplete="section-order shipping name"><input id="first" autocomplete="section-order shipping given-name"><input id="street" autocomplete="section-order shipping street-address"><input id="third" autocomplete="section-order shipping address-line3"><input id="county" autocomplete="section-order shipping address-level3"><input id="default" autocomplete="section-order shipping email"><input id="home" autocomplete="section-order shipping home email"><input id="work" autocomplete="section-order shipping work email"><select id="country" autocomplete="section-order shipping country"><option value="">Choose</option><option value="usa">United States</option></select></form>
      <form><input id="other" autocomplete="billing name"></form><form id="card"><input id="holder" autocomplete="cc-name"><input id="card-first" autocomplete="cc-given-name"><input id="card-middle" autocomplete="cc-additional-name"><select id="month" autocomplete="cc-exp-month"><option value="">Choose</option><option value="dec">December</option></select><select id="year" autocomplete="cc-exp-year"><option value="">Choose</option><option value="30">2030</option></select></form><form><input id="wrong-phone" type="tel" autocomplete="given-name"></form></html>` }));
    const target = await context.newPage(); await target.goto('https://profile.example.test/form');
    const tabId = await manager.evaluate(async () => (await chrome.tabs.query({ url: 'https://profile.example.test/*' }))[0].id!);
    const fill = async (itemId: string, selector: string) => {
      await target.bringToFront(); await target.locator(selector).click();
      expect(await manager.evaluate(({ itemId, tabId }) => chrome.runtime.sendMessage({ type: 'VAULT_FILL_WALLET', itemId, tabId, expectedOrigin: 'https://profile.example.test' }), { itemId, tabId })).toMatchObject({ ok: true });
    };
    await fill('field-address', '#name');
    await expect(target.locator('#name')).toHaveValue('Separate Full Name'); await expect(target.locator('#first')).toHaveValue('Address Edited');
    await expect(target.locator('#street')).toHaveValue('One, Two, Three'); await expect(target.locator('#third')).toHaveValue('Three');
    await expect(target.locator('#county')).toHaveValue('Edited County'); await expect(target.locator('#country')).toHaveValue('usa');
    await expect(target.locator('#home')).toHaveValue(''); await expect(target.locator('#work')).toHaveValue('work@example.test');
    await expect(target.locator('#other')).toHaveValue(''); await expect(target.locator('#wrong-phone')).toHaveValue('');
    await fill('field-card', '#holder');
    await expect(target.locator('#holder')).toHaveValue('Separate Holder'); await expect(target.locator('#card-first')).toHaveValue('Card Edited');
    await expect(target.locator('#card-middle')).toHaveValue(''); await expect(target.locator('#month')).toHaveValue('dec'); await expect(target.locator('#year')).toHaveValue('30');
    await target.screenshot({ path: info.outputPath('synthetic-filled-form.png'), fullPage: true, animations: 'disabled' });
    const canvas = await context.newPage();
    await canvas.goto('http://127.0.0.1:5186/#doc=' + encodeURIComponent(await readFile('docs/design/wallet-fields-320.m3e.json', 'utf8')));
    await expect(canvas.getByText('姓名与联系方式', { exact: true }).first()).toBeVisible();
    await canvas.screenshot({ path: info.outputPath('canvas.png'), fullPage: true, animations: 'disabled' });
  } finally { await context.close(); }
});
