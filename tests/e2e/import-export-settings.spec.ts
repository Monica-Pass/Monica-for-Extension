import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('independent file migration previews before saving and reauthenticates every export in Edge', async ({}, info) => {
  test.setTimeout(180000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1160, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => console.log('Migration page error:', error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const send = (request: object) => page.evaluate(input => chrome.runtime.sendMessage(input), request);
    expect((await send({ type: 'VAULT_SETUP', masterPassword: '1234' })).ok).toBe(true);
    await page.reload(); await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    await page.locator('[data-settings-entry="transfer"]').click();
    await expect(page.getByRole('heading', { name: '导入与导出', exact: true })).toBeVisible();
    await page.locator('[data-transfer-file]').setInputFiles(path.resolve('.tmp/file-transfer-interop/extension.zip'));
    await page.getByLabel('文件密码（如有）', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: '读取并预览', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('[data-transfer-preview]')).toHaveCount(0);
    await page.getByLabel('文件密码（如有）', { exact: true }).fill('synthetic-file-password');
    await page.getByRole('button', { name: '读取并预览', exact: true }).click();
    await expect(page.locator('[data-transfer-preview]')).toContainText('可导入 3 个项目');
    expect((await send({ type: 'VAULT_LIST_ITEMS' })).data).toHaveLength(0);
    await page.getByRole('button', { name: '导入 3 个项目', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已加密导入 3 个密码库项目');
    const imported = (await send({ type: 'VAULT_LIST_ITEMS' })).data;
    expect(imported).toHaveLength(3); expect(imported.every((item: { providerRefs: unknown[] }) => item.providerRefs.length === 0)).toBe(true);
    const outputs = path.resolve('.tmp/file-transfer-interop/edge'); await mkdir(outputs, { recursive: true });
    for (const format of ['json', 'zip', 'kdbx']) {
      await page.locator('[data-transfer-export-format]').selectOption(format);
      if (format !== 'json') {
        await page.getByLabel(format === 'zip' ? '文件密码（留空导出明文 ZIP）' : 'KDBX 文件密码', { exact: true }).fill('synthetic-file-password');
        await page.getByLabel('确认文件密码', { exact: true }).fill('synthetic-file-password');
      }
      await page.getByRole('button', { name: '验证身份并导出', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '验证身份并导出', exact: true });
      if (format === 'json') {
        await dialog.getByLabel('当前主密码', { exact: true }).fill('wrong');
        await dialog.getByRole('button', { name: '验证并导出', exact: true }).click();
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog.getByLabel('当前主密码', { exact: true })).toHaveValue('');
      }
      await dialog.getByLabel('当前主密码', { exact: true }).fill('1234');
      const pending = page.waitForEvent('download', { timeout: 20000 });
      await dialog.getByRole('button', { name: '验证并导出', exact: true }).click();
      const download = await pending.catch(async cause => { console.log('Export state:', await page.locator('.transfer-settings').innerText()); throw cause; });
      await download.saveAs(path.join(outputs, `extension.${format}`));
      if (format === 'json') expect(JSON.parse(await readFile(path.join(outputs, 'extension.json'), 'utf8')).items).toHaveLength(3);
      await expect(page.getByRole('status')).toContainText('已导出 3 个项目');
    }
    await page.screenshot({ path: info.outputPath('import-export-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#primary-navigation')).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => page.locator('#primary-navigation').evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-transfer-export-format]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    await page.screenshot({ path: info.outputPath('import-export-mobile.png') });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(page.getByRole('button', { name: '验证身份并导出', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: info.outputPath('import-export-320-large.png') });
  } finally { await context.close(); }
});
