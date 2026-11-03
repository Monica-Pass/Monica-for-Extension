import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

async function headerGeometry(page: Page) {
  const drawer = page.locator('#primary-navigation');
  const title = await drawer.locator('.sidebar-wordmark').boundingBox();
  const close = await drawer.getByRole('button', { name: '关闭导航', exact: true }).boundingBox();
  const header = await drawer.locator('.sidebar-brand').boundingBox();
  const bounds = await drawer.boundingBox();
  expect(title).not.toBeNull(); expect(close).not.toBeNull(); expect(header).not.toBeNull();
  expect(title!.width, 'wordmark must not be confined to the old 44px logo track').toBeGreaterThan(100);
  expect(close!.x, 'close must sit to the right of the wordmark').toBeGreaterThanOrEqual(title!.x + title!.width + 6);
  expect(close!.x + close!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 12);
  // A short drawer owns a vertical scrollbar; measure alignment against the
  // header's content box so the scrollbar width is not mistaken for padding.
  expect(header!.x + header!.width - close!.x - close!.width).toBeGreaterThanOrEqual(8);
  expect(header!.x + header!.width - close!.x - close!.width).toBeLessThanOrEqual(16);
  expect(close!.y).toBeGreaterThanOrEqual(header!.y);
  expect(close!.y + close!.height).toBeLessThanOrEqual(header!.y + header!.height);
  expect(close!.width).toBeGreaterThanOrEqual(44); expect(close!.height).toBeGreaterThanOrEqual(44);
  await expect(drawer.getByRole('button', { name: '关闭导航', exact: true })).toBeInViewport();
  expect(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  return close!;
}

test('drawer close stays at the header right edge in sidepanel and full manager layouts', async ({}, info) => {
  test.setTimeout(120000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 560, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    await page.goto(url + '?surface=sidepanel');
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }))).toMatchObject({ ok: true });
    await page.reload();
    for (const surface of ['?surface=sidepanel', '']) {
      await page.goto(url + surface);
      for (const width of [560, 420, 320]) {
        for (const size of ['100%', '200%']) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(size => { document.documentElement.style.fontSize = size; }, size);
          const open = page.getByRole('button', { name: '打开导航', exact: true });
          await open.click();
          const close = page.getByRole('button', { name: '关闭导航', exact: true });
          const before = await headerGeometry(page);
          await page.locator('#primary-navigation nav').evaluate(node => { node.scrollTop = node.scrollHeight; });
          const after = await headerGeometry(page);
          expect(Math.abs(after.y - before.y)).toBeLessThan(1);
          if (surface && width === 420 && size === '100%') await page.screenshot({ path: info.outputPath('sidepanel-drawer-420.png') });
          await close.click();
          await expect(page.locator('#primary-navigation')).toHaveAttribute('aria-hidden', 'true');
          await expect(open).toBeFocused();
          await open.click(); await page.keyboard.press('Escape');
          await expect(open).toBeFocused();
        }
      }
      await page.setViewportSize({ width: 420, height: 500 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      await headerGeometry(page);
      await page.locator('#primary-navigation').evaluate(node => { node.scrollTop = node.scrollHeight; });
      await headerGeometry(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '打开导航', exact: true }).click();
      const scrim = page.locator('.navigation-scrim');
      const scrimBounds = (await scrim.boundingBox())!;
      await scrim.click({ position: { x: scrimBounds.width - 12, y: 100 }, timeout: 5000 });
      await expect(page.locator('#primary-navigation')).toHaveAttribute('aria-hidden', 'true');
    }
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toBeHidden();
    await expect(page.locator('#primary-navigation .brand-logo')).toBeVisible();
  } finally { await context.close(); }
});
