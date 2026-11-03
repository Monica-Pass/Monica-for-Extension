import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

test('Passkey and Steam transfers retain the filtered scope including off-page items', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce',
    viewport: {width: 1180, height: 950}, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, {type: 'VAULT_SETUP', masterPassword: ''});
    const common = {favorite: false, notes: '', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', providerRefs: []};
    const passkeys = Array.from({length: 135}, (_, index) => ({...common, id: `scope-key-${index}`, title: `Scope match ${index}`,
      kind: 'passkey', credentialId: Buffer.from(`credential-${index}`).toString('base64url'), rpId: 'example.test', rpName: 'Example',
      userHandle: 'dXNlcg', userName: 'Synthetic', userDisplayName: 'Synthetic', algorithm: -7, publicKey: '',
      signCount: 0, discoverable: true, sourceMode: 'android-metadata-only'}));
    const steam = {...common, id: 'steam-visible', title: 'Steam match', kind: 'login', username: 'synthetic', password: 'synthetic-only',
      uris: [], customFields: [], categoryId: 7, categoryName: 'Games', totpSecret: 'steam://QUJDREVGR0hJSktMTU5PUFFSU1Q='};
    await send(page, {type: 'VAULT_IMPORT_ITEMS', items: [...passkeys, {...passkeys[0], id: 'excluded-key', title: 'Unrelated', credentialId: 'AQID'},
      steam, {...steam, id: 'steam-excluded', title: 'Steam match in Other', categoryId: 8, categoryName: 'Other'},
      {...steam, id: 'password-excluded', title: 'Steam match password', totpSecret: undefined}]});
    await page.reload();
    await page.locator('.nav-item').filter({hasText: 'Passkey'}).click();
    await page.getByRole('searchbox', {name: '搜索密码库'}).fill('Scope match');
    await expect.poll(() => page.locator('.item-card').count()).toBeGreaterThan(0);
    expect(await page.locator('.item-card').count()).toBeLessThan(135);
    await page.getByRole('button', {name: '批量传输', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: '复制或移动项目', exact: true});
    await expect(dialog.locator('.batch-item-row')).toHaveCount(135);
    await expect(dialog).not.toContainText('Unrelated');
    await expect(dialog.locator('.dialog-eyebrow')).toContainText('Passkey');
    // Local is available, but no write can start until the user selects items.
    await expect(dialog.getByRole('button', {name: '检查并生成计划', exact: true})).toBeDisabled();
    await dialog.getByRole('button', {name: '关闭批量传输', exact: true}).click();
    await page.locator('.nav-item').filter({hasText: 'Steam'}).click();
    await page.getByRole('searchbox', {name: '搜索密码库'}).fill('Steam match');
    await page.getByRole('button', {name: '筛选', exact: true}).click();
    const filter = page.getByRole('dialog', {name: '筛选密码库', exact: true});
    await filter.locator('.folder-scope-list button').filter({hasText: 'Games'}).click();
    await filter.getByRole('button', {name: '完成', exact: true}).click();
    await page.getByRole('button', {name: '批量传输', exact: true}).click();
    await expect(dialog.locator('.batch-item-row')).toHaveCount(1);
    await expect(dialog.locator('.batch-item-row')).toContainText('Steam match');
    await expect(dialog).not.toContainText('Steam match password');
    await expect(dialog).not.toContainText('Steam match in Other');
    await expect(dialog.locator('.dialog-eyebrow')).toContainText('Steam');
    await dialog.getByRole('checkbox', {name: /选择当前结果/}).check();
    await expect(dialog.locator('.batch-item-row m3e-checkbox')).toBeChecked();
    await expect(dialog.getByRole('button', {name: '检查并生成计划', exact: true})).toBeEnabled();
    // Refresh from another window removes vanished candidates and selection.
    await send(page, {type: 'VAULT_DELETE_ITEM', itemId: 'steam-visible'});
    await expect(dialog.locator('.batch-item-row')).toHaveCount(0);
    await expect(dialog.getByRole('button', {name: '清除', exact: true})).toBeDisabled();
    await page.setViewportSize({width: 320, height: 900});
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    const actions = dialog.locator('.batch-action-segments');
    await actions.scrollIntoViewIfNeeded();
    for (const title of await actions.locator('strong').all()) {
      const geometry = await title.evaluate(node => ({height: node.getBoundingClientRect().height, font: parseFloat(getComputedStyle(node).fontSize)}));
      expect(geometry.height).toBeLessThanOrEqual(geometry.font * 1.6);
    }
    await page.screenshot({path: info.outputPath('steam-transfer-320.png')});
    await dialog.getByRole('button', {name: '关闭批量传输', exact: true}).click();
    await page.screenshot({path: info.outputPath('steam-entry-320.png')});
    const stored = await send(page, {type: 'VAULT_LIST_ITEMS'});
    expect(stored.filter((item: {kind: string}) => item.kind === 'passkey')).toHaveLength(136);
  } finally { await context.close(); }
});
