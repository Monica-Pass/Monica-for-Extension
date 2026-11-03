import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('generator track clicks update the value and persisted preferences', async ({}, testInfo) => {
  const extensionPath = path.resolve('dist');
  const context = await launchEdgeContext(testInfo.outputPath('profile'), {
    locale: 'zh-CN', viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: 'synthetic slider regression password' }))).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole('button', { name: '生成器', exact: true }).click();
    const slider = page.locator('m3e-slider').first();
    const thumb = slider.locator('m3e-slider-thumb');
    await expect(thumb).toHaveJSProperty('value', 20);
    await expect(slider).toHaveJSProperty('min', 4);
    await expect(slider).toHaveJSProperty('max', 64);
    await expect(slider).toHaveJSProperty('step', 1);
    const box = await slider.boundingBox();
    if (!box) throw new Error('Slider not rendered');
    await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
    await testInfo.attach('track-click-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
    await expect.poll(() => thumb.evaluate(el => (el as HTMLElement & { value: number }).value)).toBeGreaterThan(40);
    const value = await thumb.evaluate(el => (el as HTMLElement & { value: number }).value);
    expect(value).toBe(52);
    await expect(page.locator('.generator-slider-field > span').first()).toHaveText(`长度：${value}`);
    await page.getByRole('button', { name: '重新生成', exact: true }).last().click();
    await expect.poll(() => page.locator('.generator-result output').innerText()).toHaveLength(value);
    await page.getByRole('button', { name: /^登录项/ }).click();
    await page.getByRole('button', { name: '生成器', exact: true }).click();
    await expect(thumb).toHaveJSProperty('value', value);
    await thumb.press('End');
    await expect(thumb).toHaveJSProperty('value', 64);
    await thumb.press('Home');
    await expect(thumb).toHaveJSProperty('value', 4);
    await thumb.press('ArrowRight');
    await expect(thumb).toHaveJSProperty('value', 5);
    const handle = await thumb.boundingBox();
    if (!handle) throw new Error('Slider thumb not rendered');
    const track = await slider.boundingBox();
    if (!track) throw new Error('Slider track not rendered');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect(thumb).toHaveJSProperty('value', 34);
    await page.getByRole('tab', { name: '单词', exact: true }).click();
    for (const [index, max, expected] of [[0, 128, 66], [1, 20, 10]]) {
      const control = page.locator('m3e-slider').nth(index);
      await expect(control).toHaveJSProperty('max', max);
      const bounds = await control.boundingBox();
      if (!bounds) throw new Error('Word slider not rendered');
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(control.locator('m3e-slider-thumb')).toHaveJSProperty('value', expected);
    }
    await page.reload();
    await page.getByRole('button', { name: '生成器', exact: true }).click();
    await expect(page.locator('m3e-slider-thumb').first()).toHaveJSProperty('value', 66);
    await expect(page.locator('m3e-slider-thumb').last()).toHaveJSProperty('value', 10);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 375, height: 812 });
    const compact = await slider.boundingBox();
    if (!compact) throw new Error('Compact slider not rendered');
    await page.mouse.click(compact.x + compact.width * 0.75, compact.y + compact.height / 2);
    await expect(thumb).toHaveJSProperty('value', 97);
    await page.screenshot({ path: testInfo.outputPath('generator-slider-compact.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
