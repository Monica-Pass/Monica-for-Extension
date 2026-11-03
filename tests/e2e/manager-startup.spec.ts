import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('manager remains usable while native Windows Hello status is delayed', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {
    locale: 'zh-CN', reducedMotion: 'reduce', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const password = 'Synthetic release startup password';
    expect(await page.evaluate(masterPassword => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword }), password)).toMatchObject({ ok: true });
    await page.addInitScript(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((request: { type?: string }) => {
        if (request.type === 'VAULT_HELLO_STATUS') {
          (window as any).helloStatusPending = true;
          return new Promise(() => {});
        }
        return send(request);
      }) as typeof chrome.runtime.sendMessage;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => (window as any).helloStatusPending)).toBe(true);
    await page.getByRole('button', { name: '密码源', exact: true }).click({ timeout: 10_000 });
    await expect(page.getByText('正在检查加密密码库…', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LOCK' }))).toMatchObject({ ok: true });
    await page.reload();
    await expect(page.getByLabel('主密码', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByLabel('主密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.getByRole('button', { name: '密码源', exact: true })).toBeVisible({ timeout: 10_000 });
  } finally { await context.close(); }
});
