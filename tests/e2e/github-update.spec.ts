import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { GITHUB_LATEST_API, GITHUB_RELEASES_URL } from '../../src/runtime/github-update';
import { readFileSync } from 'node:fs';

const currentVersion: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const nextVersion = currentVersion.replace(/\d+$/, patch => String(Number(patch) + 1));

test('GitHub updates in settings: manual check, release notice, safe link, failures and narrow layout', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce', viewport: { width: 1200, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
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
      await route.fulfill({ json: { tag_name, draft: false, prerelease: false, html_url: 'https://evil.example.test', body: '<img src=x onerror=evil>' } });
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }))).ok).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    const entry = page.locator('[data-settings-entry="updates"]');
    await expect(entry).toContainText(`当前版本 ${currentVersion}`); await entry.click();
    const panel = page.locator('[data-extension-updates]');
    await expect(panel).toContainText(`当前版本 ${currentVersion}`);
    await expect(panel.getByRole('status').locator('p')).toHaveText('点击检查 GitHub 正式发布');
    expect(calls).toBe(0);
    const check = panel.getByRole('button', { name: '检查更新', exact: true });
    await check.click();
    await expect(panel.getByRole('status').locator('p')).toHaveText(`发现新版本 ${nextVersion}`);
    const link = panel.getByRole('link', { name: '查看新版本', exact: true });
    await expect(link).toHaveAttribute('href', `${GITHUB_RELEASES_URL}/tag/v${nextVersion}`);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(panel.locator('img, script')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('updates-desktop.png') });
    await context.route(`${GITHUB_RELEASES_URL}/tag/v${nextVersion}`, route => route.fulfill({ body: '<title>Synthetic release</title><h1>GitHub release fixture</h1>', contentType: 'text/html' }));
    const opened = context.waitForEvent('page'); await link.click(); const releasePage = await opened;
    await expect(releasePage).toHaveURL(`${GITHUB_RELEASES_URL}/tag/v${nextVersion}`); await releasePage.close();
    await page.setViewportSize({ width: 320, height: 950 });
    await page.evaluate(() => document.documentElement.style.fontSize = '200%');
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await check.click({ trial: true });
    await page.screenshot({ path: info.outputPath('updates-320-large-text.png'), fullPage: true });
    await page.evaluate(() => document.documentElement.style.fontSize = '');
    await page.setViewportSize({ width: 1200, height: 950 });
    for (const [next, text] of [
      ['older', '未发现更新（GitHub 最新发布 0.1.48）。'], ['same', `未发现更新（GitHub 最新发布 ${currentVersion}）。`],
      ['limited', 'GitHub 请求过于频繁，请稍后重试。'], ['offline', '无法连接 GitHub，请检查网络后重试。'],
      ['invalid', '无法识别 GitHub 发布信息，请打开发布页查看。'], ['none', 'GitHub 暂无正式发布版本。']
    ]) {
      mode = next; await check.click(); await expect(panel.getByRole('status').locator('p')).toHaveText(text);
      await expect(panel.getByRole('link', { name: '打开 GitHub 发布页', exact: true })).toHaveAttribute('href', GITHUB_RELEASES_URL);
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
  } finally { await context.close(); }
});
