import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import type { VaultItem } from '../../src/core/model';

async function send(page: Page, request: unknown): Promise<any> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.data;
}

test('bottom selection actions stay fixed while scrolling and reserve space after lists and pagination', async ({}, info) => {
  test.setTimeout(180_000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    const page = await context.newPage();
    await page.goto(base);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const now = new Date().toISOString();
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: Array.from({ length: 75 }, (_, index) => ({ id: `scroll-${index}`, kind: 'secure-note', title: `Synthetic note ${index.toString().padStart(2, '0')}`, notes: 'Synthetic content', favorite: false, providerRefs: [], createdAt: now, updatedAt: now })) });
    for (const surface of ['', '?surface=sidepanel']) {
      await page.goto(base + surface);
      const toolbar = page.locator('[data-item-selection-toolbar]');
      const clearance = page.locator('[data-item-selection-clearance]');
      await page.locator('[data-item-id]').first().click({ button: 'right' });
      for (const [width, height, fontSize] of [[1200, 900, '100%'], [2560, 900, '100%'], [420, 900, '100%'], [320, 900, '100%'], [320, 950, '200%'], [420, 500, '100%'], [320, 360, '200%']] as const) {
        await page.setViewportSize({ width, height });
        await page.evaluate(size => { document.documentElement.style.fontSize = size; window.scrollTo(0, 0); }, fontSize);
        await expect(toolbar).toHaveCSS('position', 'fixed');
        await expect.poll(async () => {
          const bar = (await toolbar.boundingBox())!;
          return Math.abs(bar.y + bar.height - (height - 12));
        }).toBeLessThan(2);
        const before = (await toolbar.boundingBox())!;
        expect(before.x).toBeGreaterThanOrEqual(0);
        expect(before.x + before.width).toBeLessThanOrEqual(width + 1);
        expect(before.y).toBeGreaterThanOrEqual(100);
        expect(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        expect((await clearance.boundingBox())!.height).toBeGreaterThanOrEqual(before.height + 31);
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
        const after = (await toolbar.boundingBox())!;
        expect(Math.abs(after.y - before.y)).toBeLessThan(1);
        const last = (await page.locator('[data-item-id]').last().boundingBox())!;
        expect(last.y + last.height, 'the final list item must scroll clear of the floating actions').toBeLessThan(after.y - 8);
        const pagination = (await page.locator('.list-pagination').boundingBox());
        if (pagination) expect(pagination.y + pagination.height).toBeLessThan(after.y - 8);
        await expect(page.locator('.portrait-navigation')).toBeHidden();
        // A very short window scrolls the action surface, keeping every action reachable.
        await toolbar.getByRole('button', { name: '移到回收站', exact: true }).scrollIntoViewIfNeeded();
        await expect(toolbar.getByRole('button', { name: '移到回收站', exact: true })).toBeInViewport();
        if (width === 420 && height === 900 && !surface) await page.screenshot({ path: info.outputPath('floating-selection-420.png') });
      }
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await page.setViewportSize({ width: 420, height: 900 });
      await toolbar.getByRole('button', { name: '退出多选', exact: true }).click();
      await expect(toolbar).toHaveCount(0);
      await expect(clearance).toHaveCount(0);
      await expect(page.locator('.portrait-navigation')).toBeVisible();
    }
  } finally { await context.close(); }
});

test('Edge item selection: gestures, keyboard, complete projects, cancel, stale changes, transfer and layout', async ({}, info) => {
  test.setTimeout(180_000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {
    viewport: { width: 1200, height: 950 }, locale: 'zh-CN',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: '' });
    const now = new Date().toISOString();
    const login = (id: string, group?: string) => ({ id, kind: 'login', title: group ? 'Synthetic project' : 'Synthetic single', passwordGroupId: group,
      username: 'synthetic', password: 'synthetic-secret', uris: [], notes: '', customFields: [], favorite: false, providerRefs: [], createdAt: now, updatedAt: now });
    for (const item of [login('first', 'group'), login('second', 'group'), login('single'),
      { id: 'wallet', kind: 'identity', title: 'Synthetic membership', documentType: 'OTHER', walletTemplate: 'MEMBERSHIP', documentNumber: '000123', fullName: 'Synthetic', favorite: false, providerRefs: [], createdAt: now, updatedAt: now },
      { id: 'otp', kind: 'totp', title: 'Synthetic OTP', issuer: 'Synthetic', accountName: 'synthetic', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1', favorite: false, providerRefs: [], createdAt: now, updatedAt: now }]) {
      await send(page, { type: 'VAULT_UPSERT_ITEM', item });
    }
    await page.reload();
    const toolbar = page.locator('[data-item-selection-toolbar]');
    const first = page.locator('[data-item-id="first"], [data-item-id="second"]').first();
    const single = page.locator('[data-item-id="single"]');
    const count = (n: number) => expect(toolbar.getByRole('status')).toHaveText(`已选择 ${n} 个项目`);

    // Ordinary opening and nested edit remain available before selection.
    await first.locator('m3e-list-action').click();
    await expect(dialogContent(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialogContent(page)).toHaveCount(0);
    await single.getByRole('button', { name: '编辑登录项', exact: true }).click();
    await expect(dialogContent(page)).toBeVisible();
    await expect(toolbar).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialogContent(page)).toHaveCount(0);
    // Dragging the mouse cancels a pending long press.
    const box = (await single.boundingBox())!;
    await page.mouse.move(box.x + 65, box.y + 22); await page.mouse.down();
    await page.mouse.move(box.x + 95, box.y + 22);
    await page.waitForTimeout(650);
    await expect(toolbar).toHaveCount(0);
    await page.mouse.move(2, 2); await page.mouse.up();

    await first.locator('m3e-list-action').click({ button: 'right' });
    await count(1);
    await single.locator('m3e-list-action').click(); await count(2);
    await expect(dialogContent(page)).toHaveCount(0);
    const checkbox = single.getByRole('checkbox');
    await checkbox.focus(); await page.keyboard.press('Space'); await count(1);
    await page.keyboard.press('Space'); await count(2);
    await toolbar.getByRole('button', { name: '批量传输', exact: true }).click();
    const transfer = dialogContent(page, { name: '复制或移动项目', exact: true });
    await expect(transfer.locator('.batch-item-row')).toHaveCount(2);
    await expect(transfer.locator('.batch-item-row.selected')).toHaveCount(2);
    await transfer.getByRole('button', { name: '关闭批量传输', exact: true }).click();
    await expect(transfer).toHaveCount(0);
    await count(2);
    await toolbar.getByRole('button', { name: '收藏', exact: true }).click();
    await expect(toolbar).toHaveCount(0);
    let items: VaultItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items.filter(item => item.favorite).map(item => item.id).sort()).toEqual(['first', 'second', 'single']);
    await page.reload();
    items = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items.filter(item => item.favorite)).toHaveLength(3);

    // A long press enters once; its release must not open details or uncheck.
    await single.locator('m3e-list-action').click({ delay: 700 });
    await count(1); await expect(single.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    await expect(dialogContent(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(toolbar).toHaveCount(0);
    await expect(page.locator('[data-enter-selection]')).toBeFocused();
    await page.keyboard.press('Enter'); await count(0);
    await toolbar.getByRole('button', { name: '全选当前页', exact: true }).click(); await count(4);
    await toolbar.getByRole('button', { name: '取消选择当前页', exact: true }).click(); await count(0);
    await page.getByRole('searchbox', { name: '搜索密码库', exact: true }).fill('single');
    await expect(toolbar).toHaveCount(0);
    await page.getByRole('searchbox', { name: '搜索密码库', exact: true }).fill('');

    // Selected styling/actions remain reachable at narrow widths and 200% text.
    await first.click({ button: 'right' });
    for (const width of [320, 420]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(() => document.documentElement.style.fontSize = '200%');
      await expect(toolbar).toBeVisible();
      expect(await toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      const row = await first.boundingBox(), check = await first.getByRole('checkbox').boundingBox();
      expect(row && check && check.x >= row.x && check.x + check.width <= row.x + row.width + 1).toBeTruthy();
      await page.screenshot({ path: info.outputPath(`selection-${width}-large-text.png`), fullPage: true });
    }
    await page.evaluate(() => document.documentElement.style.fontSize = '');
    await page.setViewportSize({ width: 1200, height: 950 });
    await page.keyboard.press('Escape');
    await first.click({ button: 'right' });
    await toolbar.getByRole('button', { name: '取消收藏', exact: true }).click();
    await expect(toolbar).toHaveCount(0);
    items = await send(page, { type: 'VAULT_LIST_ITEMS' });
    expect(items.filter(item => item.favorite).map(item => item.id)).toEqual(['single']);

    // Trash cancel makes no change. A concurrent edit prevents all deletions.
    await first.click({ button: 'right' });
    await toolbar.getByRole('button', { name: '移到回收站', exact: true }).click();
    let trash = dialogContent(page, { name: '移到回收站', exact: true });
    await expect(trash).toContainText('已选择 1 个项目，共 2 条记录。');
    await trash.getByRole('button', { name: '取消', exact: true }).click();
    await expect(trash).toHaveCount(0); await count(1);
    expect((await send(page, { type: 'VAULT_LIST_ITEMS' })).length).toBe(5);
    await toolbar.getByRole('button', { name: '移到回收站', exact: true }).click();
    trash = dialogContent(page, { name: '移到回收站', exact: true });
    const sibling = (await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(item => item.id === 'second')!;
    await send(page, { type: 'VAULT_UPSERT_ITEM', item: { ...sibling, notes: 'Concurrent edit retained' } });
    await trash.getByRole('button', { name: '确认移到回收站', exact: true }).click();
    await expect(page.getByText('所选项目已变化，请重新选择。', { exact: true })).toBeVisible();
    expect((await send(page, { type: 'VAULT_LIST_DELETED_ITEMS' })).length).toBe(0);
    await trash.getByRole('button', { name: '取消', exact: true }).click();
    await page.reload();
    await first.click({ button: 'right' });
    await toolbar.getByRole('button', { name: '移到回收站', exact: true }).click();
    await dialogContent(page, { name: '移到回收站', exact: true }).getByRole('button', { name: '确认移到回收站', exact: true }).click();
    await expect(toolbar).toHaveCount(0);
    expect((await send(page, { type: 'VAULT_LIST_DELETED_ITEMS' }) as VaultItem[]).map(item => item.id).sort()).toEqual(['first', 'second']);

    // Tile pages use the same gestures, without invoking OTP copy/use.
    await page.getByRole('button', { name: /^钱包与身份/ }).click();
    const wallet = page.locator('[data-item-id="wallet"]');
    await wallet.locator('m3e-list-action').click({ button: 'right' }); await count(1);
    await wallet.getByRole('checkbox').click(); await count(0);
    await page.getByRole('button', { name: /^动态验证码/ }).click();
    await expect(toolbar).toHaveCount(0);
    const otp = page.locator('[data-item-id="otp"]');
    await otp.locator('m3e-list-action').click({ delay: 700 }); await count(1);
    await expect(otp.locator('.vault-tile-code')).toHaveAttribute('inert', '');
    await page.screenshot({ path: info.outputPath('selection-otp.png') });
    await send(page, { type: 'VAULT_LOCK' }); await page.reload();
    await expect(toolbar).toHaveCount(0);

    // The popup cannot issue the privileged batch command.
    const popup = await context.newPage(); await popup.goto(`${base}/popup.html`);
    const denied = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_BATCH_MUTATE', input: { action: 'trash', anchorIds: ['single'], expected: {}, confirmed: true } }));
    expect(denied.ok).toBe(false);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
