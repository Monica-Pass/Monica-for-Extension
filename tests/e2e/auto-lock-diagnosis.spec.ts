import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

// Only synthetic vaults in this run's isolated profile. Observe session metadata,
// never return session keys or credentials to the test process.
async function sessionMetadata(page: Page) {
  return page.evaluate(async () => {
    const value = (await chrome.storage.session.get('monica.secureVault.session.v1'))['monica.secureVault.session.v1'];
    return value ? { id: value.id as string, lastActivityAt: value.lastActivityAt as number, expiresAt: value.expiresAt as number } : null;
  });
}

test('default expiry survives MV3 restart; opening views does not renew it but trusted interactions do', async ({}, info) => {
  test.setTimeout(90_000);
  const extension = path.resolve(process.env.MONICA_DIAG_EXTENSION_DIR || 'dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {
    locale: 'zh-CN', reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const errors: string[] = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).host}`;
    const manager = await context.newPage();
    manager.on('pageerror', error => errors.push(error.message));
    await manager.goto(`${base}/index.html`);
    const setup = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: 'synthetic lock diagnosis password' }));
    expect(setup.ok).toBe(true);
    await manager.reload();
    await expect(manager.getByRole('button', { name: '立即锁定', exact: true })).toBeVisible();
    const initial = (await sessionMetadata(manager))!;
    expect(initial.expiresAt - initial.lastActivityAt).toBe(15 * 60_000);

    const website = await context.newPage();
    await context.route('https://lock-diagnosis.example.test/**', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Synthetic browsing</title><label>Notes<input id="notes"></label>'
    }));
    await website.goto('https://lock-diagnosis.example.test/');
    const cdp = await context.newCDPSession(website);
    let versionId = '';
    cdp.on('ServiceWorker.workerVersionUpdated', event => {
      versionId = event.versions.find(version => version.scriptURL.startsWith(base) && version.runningStatus === 'running')?.versionId || versionId;
    });
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versionId).not.toBe('');
    await manager.close();
    await website.getByLabel('Notes').fill('Ordinary browsing is not a vault interaction.');
    await cdp.send('ServiceWorker.stopWorker', { versionId });
    await cdp.detach();

    const popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.goto(`${base}/popup.html`);
    expect((await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_STATUS' }))).data).toBe('unlocked');
    expect(await sessionMetadata(popup)).toEqual(initial);
    // Ensure observable elapsed time before the first genuine popup key event.
    await expect.poll(() => Date.now() - initial.lastActivityAt).toBeGreaterThan(1000);
    await popup.bringToFront();
    await popup.keyboard.press('Tab');
    await expect.poll(async () => (await sessionMetadata(popup))!.lastActivityAt).toBeGreaterThan(initial.lastActivityAt);
    const afterPopup = (await sessionMetadata(popup))!;
    expect(afterPopup.id).toBe(initial.id);
    expect(afterPopup.expiresAt - afterPopup.lastActivityAt).toBe(15 * 60_000);

    const reopened = await context.newPage();
    reopened.on('pageerror', error => errors.push(error.message));
    await reopened.goto(`${base}/index.html`);
    await expect(reopened.getByRole('button', { name: '立即锁定', exact: true })).toBeVisible();
    expect(await sessionMetadata(reopened)).toEqual(afterPopup);
    await reopened.bringToFront();
    await reopened.getByRole('button', { name: '设置与备份', exact: true }).click();
    await expect.poll(async () => (await sessionMetadata(reopened))!.lastActivityAt).toBeGreaterThan(afterPopup.lastActivityAt);
    const afterManager = (await sessionMetadata(reopened))!;
    expect(afterManager.id).toBe(initial.id);
    expect(afterManager.expiresAt - afterManager.lastActivityAt).toBe(15 * 60_000);
    expect(errors).toEqual([]);
    await info.attach('session-behavior', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      defaultMinutes: 15, workerRestartPreservedSession: true, openingViewsRenewed: false,
      popupInteractionRenewed: true, managerInteractionRenewed: true
    })) });
  } finally { await context.close(); }
});
