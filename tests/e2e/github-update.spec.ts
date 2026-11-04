import { expect, test, type Download, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { GITHUB_LATEST_API, GITHUB_RELEASES_URL } from '../../src/runtime/github-update';
import { readFileSync } from 'node:fs';
import { createLoginItem } from '../../src/core/model';
import { strToU8, zipSync } from 'fflate';

const currentVersion: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const nextVersion = currentVersion.replace(/\d+$/, patch => String(Number(patch) + 1));

test('GitHub updates in settings: manual check, release notice, safe link, failures and narrow layout', async ({}, info) => {
  test.setTimeout(120_000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1200, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const base = `chrome-extension://${id}`;
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let calls = 0, mode = 'new';
    let finish: (() => void) | undefined;
    await page.route(GITHUB_LATEST_API, async route => {
      calls++;
      expect(route.request().method()).toBe('GET');
      expect(route.request().postData()).toBeNull();
      expect(route.request().headers()['authorization']).toBeUndefined();
      expect(route.request().headers()['cookie']).toBeUndefined();
      expect(route.request().headers()['referer']).toBeUndefined();
      if (mode === 'stall') { await new Promise<void>(resolve => finish = resolve); await route.fulfill({ json: { tag_name: 'v9.9.9', draft: false, prerelease: false } }).catch(() => {}); return; }
      if (mode === 'offline') { await route.abort('internetdisconnected'); return; }
      if (mode === 'limited') { await route.fulfill({ status: 403, json: { message: 'upstream detail must not render' } }); return; }
      if (mode === 'none') { await route.fulfill({ status: 404, json: { message: 'Not Found' } }); return; }
      if (mode === 'invalid') { await route.fulfill({ body: '<script>evil</script>', contentType: 'text/html' }); return; }
      const tag_name = mode === 'older' ? 'v0.1.48' : `v${mode === 'same' ? currentVersion : nextVersion}`;
      const name = `monica-extension-${tag_name.slice(1)}.zip`;
      await route.fulfill({ json: { tag_name, draft: false, prerelease: false, html_url: 'https://evil.example.test', body: '<img src=x onerror=evil>',
        assets: mode === 'no-asset' ? [] : [{ name, state: 'uploaded', size: 100, browser_download_url: `${GITHUB_RELEASES_URL}/download/${tag_name}/${name}` }] } });
    });
    await page.goto(`${base}/index.html`);
    const password = 'synthetic update flow password';
    expect((await page.evaluate(masterPassword => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword }), password)).ok).toBe(true);
    const item = createLoginItem({ title: 'Saved before update reload', username: 'synthetic-user', password: 'synthetic-secret' });
    expect((await page.evaluate(item => chrome.runtime.sendMessage({ type: 'VAULT_UPSERT_ITEM', item }), item)).ok).toBe(true);
    const saved = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' }));
    expect(saved.ok).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    const entry = page.locator('[data-settings-entry="updates"]');
    await expect(entry).toContainText(`当前版本 ${currentVersion}`); await entry.click();
    const panel = page.locator('[data-extension-updates]');
    await expect(panel).toContainText(`当前版本 ${currentVersion}`);
    await expect(panel).toContainText(`扩展 ID：${id}`);
    await expect(panel).toContainText(`构建标识：${JSON.parse(readFileSync('src/runtime/build-id.json', 'utf8')).buildId}`);
    await expect(panel.getByRole('status').locator('p')).toHaveText('点击检查 GitHub 正式发布');
    expect(calls).toBe(0);
    const check = panel.getByRole('button', { name: '检查更新', exact: true });
    await check.click();
    await expect(panel.getByRole('status').locator('p')).toHaveText(`发现新版本 ${nextVersion}`);
    const link = panel.getByRole('link', { name: '查看新版本', exact: true });
    await expect(link).toHaveAttribute('href', `${GITHUB_RELEASES_URL}/tag/v${nextVersion}`);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const zipUrl = `${GITHUB_RELEASES_URL}/download/v${nextVersion}/monica-extension-${nextVersion}.zip`;
    const downloadLink = panel.getByRole('link', { name: '下载扩展 ZIP', exact: true });
    await expect(downloadLink).toHaveAttribute('href', zipUrl);
    const zipBytes = Buffer.from(zipSync({ 'fixture.txt': strToU8('Synthetic update download') }));
    await context.route(zipUrl, route => route.fulfill({ body: zipBytes, contentType: 'application/zip', headers: {
      'Content-Disposition': `attachment; filename="monica-extension-${nextVersion}.zip"`
    } }));
    const downloads: Download[] = [];
    const recordDownload = (download: Download) => { if (download.url() === zipUrl) downloads.push(download); };
    const captureDownloads = (surface: Page) => surface.on('download', recordDownload);
    context.pages().forEach(captureDownloads);
    context.on('page', captureDownloads);
    await downloadLink.click();
    await expect.poll(() => downloads.length, { timeout: 20_000 }).toBe(1);
    context.off('page', captureDownloads);
    context.pages().forEach(surface => surface.off('download', recordDownload));
    const download = downloads[0];
    expect(download.suggestedFilename()).toBe(`monica-extension-${nextVersion}.zip`);
    await download.saveAs(info.outputPath('synthetic-update.zip'));
    expect(readFileSync(info.outputPath('synthetic-update.zip'))).toEqual(zipBytes);
    const managing = context.waitForEvent('page');
    await panel.getByRole('button', { name: '打开扩展管理页', exact: true }).click();
    const managementPage = await managing;
    await expect(managementPage).toHaveURL(`edge://extensions/?id=${id}`);
    await managementPage.evaluate(() => (chrome as unknown as { developerPrivate: {
      updateProfileConfiguration: (config: { inDeveloperMode: boolean }) => Promise<void>;
    } }).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    await managementPage.close();
    let cancelled = false;
    page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); expect(dialog.message()).toContain('未保存的编辑会丢失'); cancelled = true; await dialog.dismiss(); });
    await panel.getByRole('button', { name: '已覆盖，重新加载扩展', exact: true }).click();
    expect(cancelled).toBe(true);
    await expect(panel).toBeVisible();
    await expect(panel.locator('img, script')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('updates-desktop.png') });
    await context.route(`${GITHUB_RELEASES_URL}/tag/v${nextVersion}`, route => route.fulfill({ body: '<title>Synthetic release</title><h1>GitHub release fixture</h1>', contentType: 'text/html' }));
    const opened = context.waitForEvent('page'); await link.click(); const releasePage = await opened;
    await expect(releasePage).toHaveURL(`${GITHUB_RELEASES_URL}/tag/v${nextVersion}`); await releasePage.close();
    await page.setViewportSize({ width: 320, height: 950 });
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    const guide = panel.locator('.update-guide');
    for (const locale of ['en', 'de', 'es', 'ja', 'ko', 'ru', 'vi', 'zh-CN']) {
      await page.evaluate(locale => chrome.storage.local.set({ 'monica.locale': locale }), locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      const reloadText = '已覆盖，重新加载扩展';
      const messages = locale === 'zh-CN' ? { [reloadText]: reloadText } : JSON.parse(readFileSync(locale === 'en' ? 'src/i18n/ui-en.json' : `public/locales/ui-${locale}.json`, 'utf8'));
      const reloadButton = guide.getByRole('button', { name: messages[reloadText], exact: true });
      await expect(reloadButton).toBeVisible();
      await reloadButton.click({ trial: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      expect(await guide.evaluate(node => [...node.querySelectorAll<HTMLElement>('h3, p, ol, li, .update-actions, m3e-button')]
        .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || element.scrollWidth > element.clientWidth + 1)
        .map(element => element.tagName)), `Overflow inside update guide (${locale})`).toEqual([]);
      // Viewport screenshots preserve fixed navigation placement at each scroll position.
      if (locale === 'de' || locale === 'zh-CN') {
        await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
        await page.screenshot({ path: info.outputPath(`updates-320-${locale}-actions.png`) });
      }
    }
    await panel.locator('h2').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('updates-320-zh-CN-top.png') });
    await page.evaluate(() => document.documentElement.style.fontSize = '');
    await page.setViewportSize({ width: 1200, height: 950 });
    for (const [next, text] of [
      ['no-asset', `发现新版本 ${nextVersion}`],
      ['older', '未发现更新（GitHub 最新发布 0.1.48）。'], ['same', `未发现更新（GitHub 最新发布 ${currentVersion}）。`],
      ['limited', 'GitHub 请求过于频繁，请稍后重试。'], ['offline', '无法连接 GitHub，请检查网络后重试。'],
      ['invalid', '无法识别 GitHub 发布信息，请打开发布页查看。'], ['none', 'GitHub 暂无正式发布版本。']
    ]) {
      mode = next; await check.click(); await expect(panel.getByRole('status').locator('p')).toHaveText(text);
      await expect(downloadLink).toHaveCount(0);
      if (next !== 'no-asset') await expect(panel.getByRole('link', { name: '打开 GitHub 发布页', exact: true })).toHaveAttribute('href', GITHUB_RELEASES_URL);
      await expect(check).toBeEnabled();
    }
    mode = 'stall'; await check.click();
    await expect(panel.getByRole('button', { name: '正在检查…', exact: true })).toBeDisabled();
    await expect(panel.getByRole('status').locator('p')).toHaveText('正在检查 GitHub 更新…');
    await page.locator('[data-settings-back]').click();
    await expect(entry).toBeFocused();
    finish?.();
    await entry.click();
    await expect(panel.getByRole('status').locator('p')).toHaveText('点击检查 GitHub 正式发布');
    await expect(panel).not.toContainText('9.9.9');
    mode = 'new'; await check.click(); await expect(panel.getByRole('status').locator('p')).toHaveText(`发现新版本 ${nextVersion}`);
    expect(errors).toEqual([]);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: '已覆盖，重新加载扩展', exact: true }).click().catch(error => { if (!page.isClosed()) throw error; });
    const reopened = await context.newPage();
    await expect(async () => {
      await reopened.goto(`${base}/index.html`);
      await expect(reopened.getByRole('heading', { name: '解锁 Monica', exact: true })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    await reopened.getByLabel('主密码', { exact: true }).fill(password);
    await reopened.getByLabel('主密码', { exact: true }).press('Enter');
    await expect(reopened.getByRole('heading', { name: '全部项目', exact: true })).toBeVisible();
    const retained = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' }));
    expect(retained.ok).toBe(true);
    expect(retained.data).toEqual(saved.data);
  } finally { await context.close(); }
});
