import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption, dialogContent } from './fixtures/material';

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function setup(page: Page) {
  await page.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let mode = 'device-key';
    chrome.runtime.sendMessage = (async (message: {type: string; newPassword?: string}) => {
      if (message.type === 'VAULT_HELLO_STATUS') return { ok: true, data: {native: {available: false, supported: false, reason: 'Synthetic UI fixture'}, vaultEnrolled: false, bindingConsistent: true, protectionMode: mode, unlockAvailable: false} };
      const result = await original(message);
      if (result.ok && message.type === 'VAULT_CHANGE_MASTER_PASSWORD') mode = message.newPassword ? 'master-password' : 'device-key';
      return result;
    }) as typeof chrome.runtime.sendMessage;
  });
  await send(page, {type: 'VAULT_SETUP', masterPassword: ''});
  await page.reload();
  await page.getByRole('button', {name: '设置与备份', exact: true}).click();
}

async function expectCenteredSwitches(page: Page) {
  const rows = page.locator('.automatic-sync-row, .inline-autofill-setting-row, .cli-integration-setting-row');
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    const geometry = await row.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const toggle = node.querySelector('m3e-switch')!;
      const track = toggle.shadowRoot!.querySelector('.track')!.getBoundingClientRect();
      return { offset: Math.abs((bounds.top + bounds.bottom - track.top - track.bottom) / 2), inside: track.left >= bounds.left - 1 && track.right <= bounds.right + 1 };
    });
    expect(geometry.offset).toBeLessThanOrEqual(1);
    expect(geometry.inside).toBe(true);
  }
}

test('common settings act directly while grouped configuration pages retain focus and fit at 320px', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce', viewport: {width: 1180, height: 1000},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await setup(page);
    const home = page.locator('[data-settings-page="home"]');
    const ids = ['appearance', 'exclusions', 'protection', 'transfer', 'backup', 'wifi-sync', 'diagnostics', 'updates'];
    await expect(home.locator('[data-settings-entry]')).toHaveCount(ids.length);
    await expect(home.getByRole('combobox')).toHaveCount(2);
    await expect(home.getByRole('switch')).toHaveCount(3);
    await expect(home.locator('.settings-group')).toHaveCount(3);
    await expect(home.locator('[data-settings-back]')).toHaveCount(0);
    // Direct preferences have no navigation wrapper; the only arrows lead to multi-control pages.
    await chooseOption(home.getByRole('combobox', {name: '显示模式', exact: true}), 'dark');
    await expect(home).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.mouse.move(0, 0);
    const mode = home.getByRole('combobox', {name: '显示模式', exact: true});
    const language = home.getByRole('combobox', {name: '界面语言', exact: true});
    const modeRow = home.locator('.settings-control').filter({has: page.getByRole('combobox', {name: '显示模式', exact: true})});
    const fieldChrome = () => home.locator('[data-settings-select]').evaluateAll(fields => fields.map(field => {
      const base = field.shadowRoot!.querySelector('.base')!;
      return {border: getComputedStyle(base, '::before').display, layer: getComputedStyle(base, '::after').display};
    }));
    await expect.poll(fieldChrome).toEqual([{border: 'none', layer: 'none'}, {border: 'none', layer: 'none'}]);
    // A mouse selection must not leave either an inner capsule or a row outline.
    await expect(modeRow).toHaveCSS('outline-style', 'none');
    await expect(mode).toBeFocused();
    await language.click();
    await expect(language).toHaveAttribute('aria-expanded', 'true');
    const languagePanel = page.locator(`[id="${await language.getAttribute('aria-controls')}"]`);
    await expect(languagePanel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(language).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Tab');
    await expect(mode).toBeFocused();
    await expect(modeRow).toHaveCSS('outline-style', 'solid');
    // Edge snaps the 2 CSS-pixel outline to device pixels at Windows scaling.
    await expect.poll(() => modeRow.evaluate(node => Math.abs(parseFloat(getComputedStyle(node).outlineWidth) - 2) * devicePixelRatio)).toBeLessThanOrEqual(1);
    await expect(mode).toHaveCSS('outline-style', 'none');
    await expect(mode.locator(':scope > m3e-focus-ring .outline')).toHaveCSS('visibility', 'hidden');
    await home.screenshot({path: info.outputPath('settings-keyboard-focus.png')});
    await page.keyboard.press('Enter');
    await expect(mode).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator(`[id="${await mode.getAttribute('aria-controls')}"]`);
    await expect(panel.getByRole('option', {name: '深色', exact: true})).toBeVisible();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(mode).toHaveJSProperty('value', 'auto');
    await expect(panel).toHaveCount(0);
    await expect(mode).toBeFocused();
    await page.emulateMedia({forcedColors: 'active'});
    await expect(modeRow).toHaveCSS('outline-style', 'solid');
    await expect.poll(() => modeRow.evaluate(node => Math.abs(parseFloat(getComputedStyle(node).outlineWidth) - 2) * devicePixelRatio)).toBeLessThanOrEqual(1);
    await home.screenshot({path: info.outputPath('settings-high-contrast-focus.png')});
    await page.emulateMedia({forcedColors: 'none'});
    await chooseOption(mode, 'dark');
    await page.mouse.move(0, 0);
    await expect(modeRow).toHaveCSS('outline-style', 'none');
    const groups = await home.locator('.settings-entry-list').evaluateAll(groups => groups.map(group => {
      const first=getComputedStyle(group.firstElementChild!), last=getComputedStyle(group.lastElementChild!);
      return [first.borderTopLeftRadius, last.borderBottomRightRadius, first.padding, last.padding, first.backgroundColor === last.backgroundColor];
    }));
    for (const group of groups) expect(group).toEqual(['24px', '24px', '8px 16px', '8px 16px', true]);
    for (const row of await home.locator('.settings-group').first().locator('.settings-entry-list > *').all()) {
      const box = await row.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(76);
      expect(box!.height).toBeGreaterThanOrEqual(48);
    }
    await expectCenteredSwitches(page);
    await page.screenshot({path: info.outputPath('settings-dark-desktop.png'), fullPage: true});
    for (const id of ids) {
      await home.locator(`[data-settings-entry="${id}"]`).click();
      const secondary = page.locator(`[data-settings-page="${id}"]`);
      await expect(secondary).toBeVisible(); await expect(secondary.locator('h1')).toBeFocused();
      await expect(secondary.locator('m3e-expansion-panel,m3e-dialog,[role="dialog"]')).toHaveCount(0);
      await secondary.locator('[data-settings-back]').click();
      await expect(home.locator(`[data-settings-entry="${id}"]`)).toBeFocused();
    }
    await page.setViewportSize({width: 320, height: 950});
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await expectCenteredSwitches(page);
    await home.screenshot({path: info.outputPath('settings-dark-320-200.png')});
    await chooseOption(home.getByRole('combobox', {name: '显示模式', exact: true}), 'light');
    await expect(home).toBeVisible();
    await chooseOption(home.getByRole('combobox', {name: '显示模式', exact: true}), 'dark');
    for (const id of ids) {
      await home.locator(`[data-settings-entry="${id}"]`).click();
      const secondary = page.locator(`[data-settings-page="${id}"]`);
      expect(await secondary.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await expect(secondary.locator('h1')).toBeFocused();
      const heading = await secondary.locator('h1').boundingBox();
      const back = await secondary.locator('[data-settings-back]').boundingBox();
      expect(heading!.y).toBeGreaterThanOrEqual(0);
      expect(heading!.x).toBeGreaterThanOrEqual(0);
      expect(heading!.x + heading!.width).toBeLessThanOrEqual(320);
      expect(back!.y).toBeGreaterThanOrEqual(0);
      await secondary.locator('[data-settings-back]').click({trial: true});
      await page.screenshot({path: info.outputPath(`${id}-320-200-top.png`)});
      if (id === 'protection') {
        const labels = await secondary.locator('.settings-password-field > label').evaluateAll(nodes => nodes.map(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1));
        expect(labels).toEqual([true, true, true]);
        await secondary.getByRole('button', {name: '更改主密码', exact: true}).click({trial: true});
        await page.screenshot({path: info.outputPath('protection-320-200-bottom.png')});
      }
      if (id === 'protection') await expect(secondary.getByRole('heading', {name: 'Windows Hello', exact: true})).toBeVisible();
      if (id === 'transfer') await expect(secondary.getByRole('heading', {name: '导入文件', exact: true})).toBeVisible();
      await secondary.locator('[data-settings-back]').click();
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await home.locator('[data-settings-entry="appearance"]').click();
    await page.getByRole('radio', {name: 'Monica', exact: true}).check();
    await page.locator('[data-settings-back]').click();
    await chooseOption(home.getByRole('combobox', {name: '显示模式', exact: true}), 'light');
    await page.setViewportSize({width: 1180, height: 1000});
    await expectCenteredSwitches(page);
    await page.screenshot({path: info.outputPath('settings-light-desktop.png'), fullPage: true});
  } finally { await context.close(); }
});

test('secondary settings retain autofill exclusions, toggles, protection changes and portable backup export', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {locale: 'zh-CN', reducedMotion: 'reduce', viewport: {width: 1180, height: 950},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await setup(page);
    const home = page.locator('[data-settings-page="home"]');
    const open = (id: string) => home.locator(`[data-settings-entry="${id}"]`).click();
    const back = () => page.locator('[data-settings-back]').click();
    await page.getByRole('switch', {name: '自动同步', exact: true}).click();
    await expect(page.getByRole('switch', {name: '自动同步', exact: true})).not.toBeChecked();
    await page.getByRole('switch', {name: '表单旁自动填充', exact: true}).click();
    await expect(page.getByRole('switch', {name: '表单旁自动填充', exact: true})).not.toBeChecked();
    await open('exclusions'); await page.getByLabel('网站域名', {exact: true}).fill('settings.example.test');
    await page.getByRole('button', {name: '添加', exact: true}).click(); await page.getByRole('button', {name: '保存', exact: true}).click();
    await expect(home.locator('[data-settings-entry="exclusions"]')).toContainText('自动填充 1 个');
    await open('exclusions'); await expect(page.locator('.site-policy-lists')).toContainText('settings.example.test');
    await page.getByLabel('网站域名', {exact: true}).fill('cancelled.example.test');
    await page.getByRole('button', {name: '添加', exact: true}).click(); await back(); await open('exclusions');
    await expect(page.locator('.site-policy-lists')).not.toContainText('cancelled.example.test'); await back();
    await open('protection');
    const secret = 'Synthetic settings master password';
    await page.getByLabel('新主密码（可选）', {exact: true}).fill(secret);
    await page.getByLabel('确认新主密码', {exact: true}).fill(secret);
    await page.getByRole('button', {name: '更改主密码', exact: true}).click();
    await expect(home).toBeVisible(); await open('protection');
    await expect(page.getByLabel('新主密码（可选）', {exact: true})).toHaveValue('');
    await back(); await open('backup');
    await page.getByRole('button', {name: '导出加密整库备份', exact: true}).click();
    const dialog = dialogContent(page, {name: '导出加密整库备份', exact: true});
    await dialog.getByLabel('当前主密码', {exact: true}).fill(secret);
    await dialog.getByLabel('备份密码 *', {exact: true}).fill('Synthetic portable backup password');
    await dialog.getByLabel('确认备份密码 *', {exact: true}).fill('Synthetic portable backup password');
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', {name: '验证并导出', exact: true}).click();
    const download = await downloading, output = info.outputPath('synthetic-settings-backup.json'); await download.saveAs(output);
    const bytes = await readFile(output, 'utf8'); expect(bytes).not.toContain(secret); expect(JSON.parse(bytes).envelope).toBeDefined();
    await expect(page.locator('[data-settings-page="backup"]')).toBeVisible();
  } finally { await context.close(); }
});
