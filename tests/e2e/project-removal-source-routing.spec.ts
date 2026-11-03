import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('pending password removal opens matching WebDAV, OneDrive, MDBX or Bitwarden settings', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce',
    viewport: { width: 1180, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }))).toMatchObject({ ok: true });
    // UI routing fixture only; do not create real pending operations or remote accounts.
    await page.addInitScript(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const sources = [
        { id: 'pending-webdav', kind: 'keepass', name: 'Synthetic WebDAV', enabled: false, isDefaultSaveTarget: false,
          config: { sourceMode: 'webdav', webDavBaseUrl: 'https://routing.example.test/root', webDavUsername: 'fixture-user', remotePath: 'project.kdbx' } },
        { id: 'pending-onedrive', kind: 'keepass', name: 'Synthetic OneDrive', enabled: false, isDefaultSaveTarget: false,
          config: { sourceMode: 'onedrive', fileName: 'cloud-project.kdbx', oneDriveDriveId: 'fixture-drive', oneDriveItemId: 'fixture-file' } },
        { id: 'pending-mdbx', kind: 'mdbx2', name: 'Synthetic MDBX', enabled: false, isDefaultSaveTarget: false, config: {} },
        { id: 'pending-bitwarden', kind: 'bitwarden', name: 'Synthetic Bitwarden', enabled: true, isDefaultSaveTarget: false,
          config: {authenticated: false, email: 'synthetic@example.test', vaultUrl: 'https://routing.example.test'} }
      ];
      chrome.runtime.sendMessage = (async (request: { type: string }) => {
        if (request.type === 'PROVIDER_LIST') return { ok: true, data: sources };
        if (request.type === 'VAULT_KEEPASS_PROJECT_REMOVALS') return { ok: true, data: sources.slice(0, 2).map(provider => ({
          operationId: provider.id, providerId: provider.id, title: provider.name, status: 'staged', canCancel: true,
          localAdoptionCompleted: false, removedItemIds: ['fixture-password']
        })) };
        if (request.type === 'VAULT_PASSWORD_PROJECT_REMOVALS') return { ok: true, data: sources.slice(2).map(source => ({ operationId: source.id,
          providerId: source.id, title: source.name, status: 'preparing', removedItemIds: ['fixture-password'],
          retainedItemIds: [], pendingRestoreItemIds: [], canCancel: true, supported: true })) };
        if (request.type === 'MDBX2_HOST_STATUS') return { ok: true, data: { availability: 'unavailable', reason: 'Synthetic UI fixture' } };
        return original(request);
      }) as typeof chrome.runtime.sendMessage;
    });
    await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    for (const source of ['webdav', 'onedrive', 'mdbx', 'bitwarden'] as const) {
      const panel = page.locator(`[data-removal-operation="pending-${source}"]`);
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: source === 'bitwarden' ? '重新登录' : '解锁并设置', exact: true }).click();
      const selector = source === 'webdav' ? '.keepass-provider-dialog' : source === 'onedrive' ? '.onedrive-dialog' : source === 'bitwarden' ? '[aria-labelledby="bitwarden-dialog-title"]' : '.mdbx2-dialog';
      const dialog = page.locator(selector);
      await expect(dialog).toBeVisible();
      if (source === 'webdav') {
        await expect(dialog).toContainText('管理 KeePass');
        expect(await dialog.locator('input').evaluateAll(inputs => inputs.some(input => (input as HTMLInputElement).value === 'project.kdbx'))).toBe(true);
        await expect(page.locator('.mdbx2-dialog')).toHaveCount(0);
      }
      if (source === 'onedrive') {
        await expect(dialog).toContainText('管理 OneDrive 数据库');
        await expect(dialog).toContainText('cloud-project.kdbx');
        await expect(page.locator('.mdbx2-dialog')).toHaveCount(0);
      }
      if (source === 'bitwarden') {
        await expect(dialog).toContainText('重新登录 Bitwarden');
        expect(await dialog.locator('input').evaluateAll(inputs => inputs.some(input => input.value === 'synthetic@example.test'))).toBe(true);
        await expect(page.locator('.mdbx2-dialog')).toHaveCount(0);
      }
      await page.setViewportSize({ width: 320, height: 950 });
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${source}-settings-320.png`) });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await page.setViewportSize({ width: 1180, height: 950 });
      await expect(panel).toBeVisible();
    }
  } finally { await context.close(); }
});
