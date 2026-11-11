import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createLoginItem } from '../../src/core/model';
import { createTransferExport, previewImport } from '../../src/manager/file-transfer';
import { getAndroidBackupEncryptionFormat } from '../../src/providers/webdav/android-backup-crypto';
import { launchEdgeContext } from './fixtures/edge';

const filePassword = '  中文🔑e\u0301 synthetic backup  ';
const vaultPassword = 'Synthetic browser master password';

test('Edge previews V2 safely and exports V1 and V2 only after fresh authentication', async ({}, info) => {
  test.setTimeout(120_000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {
    locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1160, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const send = (input: object) => page.evaluate(request => chrome.runtime.sendMessage(request), input);
    expect((await send({ type: 'VAULT_SETUP', masterPassword: vaultPassword })).ok).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(manifest.version);
    await page.reload();
    await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    await page.locator('[data-settings-entry="transfer"]').click();
    const item = createLoginItem({ title: 'Synthetic V2 import', username: '  synthetic@example.test  ',
      password: '  Synthetic record secret 🔑  ', notes: '  Unicode 内容\n  ', uris: ['https://example.test'] });
    const source = await createTransferExport([item], 'zip', filePassword, 'v2');
    const selectFile = async (bytes: Uint8Array) => page.locator('[data-transfer-file]').setInputFiles({
      name: 'android-v2.backup', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes)
    });
    const preview = page.locator('[data-transfer-preview]');
    await selectFile(source.bytes);
    await page.getByLabel('文件密码（如有）', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: '读取并预览', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('密码错误');
    await expect(preview).toHaveCount(0);
    expect((await send({ type: 'VAULT_LIST_ITEMS' })).data).toHaveLength(0);
    const invalid = source.bytes.slice(); invalid[16] ^= 1;
    await selectFile(invalid);
    await page.getByLabel('文件密码（如有）', { exact: true }).fill(filePassword);
    await page.getByRole('button', { name: '读取并预览', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('加密参数');
    await expect(preview).toHaveCount(0);
    expect((await send({ type: 'VAULT_LIST_ITEMS' })).data).toHaveLength(0);
    await selectFile(source.bytes);
    await page.getByLabel('文件密码（如有）', { exact: true }).fill(filePassword);
    await page.getByRole('button', { name: '读取并预览', exact: true }).click();
    await expect(preview).toContainText('可导入 1 个项目');
    expect((await send({ type: 'VAULT_LIST_ITEMS' })).data).toHaveLength(0);
    await page.getByRole('button', { name: '导入 1 个项目', exact: true }).click();
    await expect(page.locator('.transfer-status')).toContainText('已加密导入 1 个密码库项目');
    expect((await send({ type: 'VAULT_LIST_ITEMS' })).data).toMatchObject([{ title: item.title, providerRefs: [] }]);

    const format = page.locator('[data-transfer-encryption-format]');
    await expect(format).toHaveValue('v1');
    await format.selectOption('v2');
    await page.getByRole('button', { name: '验证身份并导出', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('必须设置文件密码');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.settings-safety-note')).toHaveCount(0);
    await format.selectOption('v1');
    await expect(page.getByRole('alert')).toHaveCount(0);

    const exports: { version: string; sha256: string; valuesPreserved: boolean }[] = [];
    for (const version of ['v1', 'v2'] as const) {
      await format.selectOption(version);
      await page.getByLabel(version === 'v2' ? 'ZIP 文件密码（增强 V2 必填）' : '文件密码（留空导出明文 ZIP）', { exact: true }).fill(filePassword);
      await page.getByLabel('确认文件密码', { exact: true }).fill(filePassword);
      await page.getByRole('button', { name: '验证身份并导出', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '验证身份并导出', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('当前主密码', { exact: true })).toHaveValue('');
      if (version === 'v2') {
        await dialog.getByLabel('当前主密码', { exact: true }).fill('wrong');
        await dialog.getByRole('button', { name: '验证并导出', exact: true }).click();
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog.getByLabel('当前主密码', { exact: true })).toHaveValue('');
      }
      await dialog.getByLabel('当前主密码', { exact: true }).fill(vaultPassword);
      const pending = page.waitForEvent('download');
      await dialog.getByRole('button', { name: '验证并导出', exact: true }).click();
      const download = await pending;
      const bytes = new Uint8Array(await readFile((await download.path())!));
      await download.saveAs(info.outputPath(`synthetic-${version}.zip`));
      expect(getAndroidBackupEncryptionFormat(bytes)).toBe(version);
      const imported = await previewImport({ name: download.suggestedFilename(), bytes, password: filePassword });
      expect(imported.items).toMatchObject([{ username: item.username, password: item.password, notes: item.notes }]);
      exports.push({ version, sha256: createHash('sha256').update(bytes).digest('hex'), valuesPreserved: true });
      await expect(page.locator('.transfer-status')).toContainText('已导出 1 个项目');
    }
    await page.screenshot({ path: info.outputPath('v2-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(format).toBeVisible();
    await expect(page.locator('[data-transfer-encryption-summary]')).toHaveText('增强 V2（600,000 次）');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await format.evaluate(select => {
      const element = select as HTMLSelectElement, style = getComputedStyle(element);
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
      ctx.font = style.font;
      return ctx.measureText(element.selectedOptions[0].text).width <= element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 24;
    })).toBe(true);
    await format.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('v2-large-font.png') });
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed: true,
      runtime: (await send({ type: 'RUNTIME_INFO' })).data, exports, synthetic: true,
      previewBeforeImport: true, wrongPasswordAndProfileRejected: true, freshAuthenticationPerExport: true,
      narrowLargeFontSelectedLabelFits: true }, null, 2));
  } finally { await context.close(); }
});
