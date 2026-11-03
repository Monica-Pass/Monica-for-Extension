import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchEdgeContext } from './fixtures/edge';

const VAULT_PASSWORD = "synthetic nearby page password";

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

/** The real manager page, background owner and Native Messaging path. No native
 * helper is registered in this profile, so actions must explain how to recover. */
test("nearby sync page pairs through the background owner and explains a missing helper", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const context = await launchEdgeContext(testInfo.outputPath("profile"), { locale: "zh-CN",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await worker.evaluate(() => { const connect=chrome.runtime.connectNative.bind(chrome.runtime); chrome.runtime.connectNative=(name:string)=>connect(name==='com.monica_pass.mdbx2'?'com.monica_pass.missing_pairing_test':name); });
    const manager = await context.newPage();
    const errors: string[] = [];
    manager.on("pageerror", error => errors.push(error.message));
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: VAULT_PASSWORD });
    await manager.reload();
    await manager.getByRole("button", { name: "设置与备份", exact: true }).first().click();
    await manager.locator('[data-settings-entry="wifi-sync"]').click();

    const page = manager.locator("[data-settings-page=wifi-sync]");
    await expect(manager.locator('[data-settings-entry="nearby-sync"]')).toHaveCount(0);
    await expect(page.getByText('先在两端完成一次配对，再同步密码库。')).toBeVisible();

    // Settings round-trip through the encrypted preferences store.
    await page.getByRole("textbox", { name: "设备名称", exact: true }).fill("Synthetic work browser");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "设备名称", exact: true })).toBeEnabled();

    // Local deletions stay local unless the user explicitly turns this off.
    const incremental = page.getByRole("switch", { name: "只同步新增和修改", exact: true });
    await expect(incremental).toBeChecked();
    await incremental.click();
    await expect(incremental).not.toBeChecked();
    await incremental.click();
    await expect(incremental).toBeChecked();

    const lan = `monica-lan:2:192.168.43.1:12345:${'a'.repeat(43)}`;
    const encode = (text: string) => Buffer.from(text).toString('base64url');
    const hotspot = `monica-hotspot:1:${encode('Monica synthetic')}:${encode('synthetic-only')}:${encode(lan)}`;
    const invitation = page.getByRole('textbox', { name: '配对邀请', exact: true });
    await invitation.fill(hotspot);
    await expect(page.locator('[data-nearby-hotspot]')).toContainText('浏览器无法自动加入热点');
    await expect(page.locator('[data-nearby-hotspot]')).toContainText('Monica synthetic');
    await expect(page.locator('[data-nearby-hotspot]')).toContainText('synthetic-only');
    await manager.clock.setFixedTime(new Date(Date.now() + 181_000));
    await expect(invitation).toHaveValue('', { timeout: 8_000 });
    await expect(page.locator('[data-nearby-hotspot]')).toHaveCount(0);

    await page.getByRole("button", { name: "显示本机邀请" }).click();
    await expect(page.getByRole("alert")).toContainText("本机通信组件");
    await expect(page.getByRole("button", { name: "配置本机通信组件" })).toBeVisible();
    await testInfo.attach("wifi-sync-page", { body: await manager.screenshot({ fullPage: true }), contentType: "image/png" });

    // Leaving the page releases the single manager lease; reopening works.
    await manager.getByRole("button", { name: "返回" }).click();
    await manager.locator('[data-settings-entry="wifi-sync"]').click();
    await expect(page.getByRole("textbox", { name: "设备名称", exact: true })).toHaveValue("Synthetic work browser");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

// Exercise the actual manager and M3E dialog with a synthetic manager-port
// review. Native transfer behavior is covered separately by nearby-coordinator.
for (const incoming of [false, true]) for (const choice of ['omit', 'include', 'cancel'] as const) test(`historical deletion dialog requires a user choice: ${incoming ? 'receive' : 'send'} ${choice}`, async ({}, info) => {
  const extensionPath = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.addInitScript(({ incoming }) => {
      const original = chrome.runtime.connect.bind(chrome.runtime);
      const decisions: string[] = [], started: string[] = [];
      (window as any).reviewEvidence = { decisions, started };
      chrome.runtime.connect = ((options: chrome.runtime.ConnectInfo) => {
        const port = original(options);
        if (options.name !== 'monica-nearby-manager-v1') return port;
        const listeners = new Set<(message: any) => void>(), requests = new Map<number, string>();
        const emit = (message: any) => listeners.forEach(listener => listener(message));
        port.onMessage.addListener(message => {
          if (requests.get(message.id) === 'preferences' && message.ok) message.data.peers = [{ deviceId: 'synthetic-phone', name: '测试手机', lastSyncedAt: 0 }];
          emit(message);
        });
        return { ...port, onDisconnect: port.onDisconnect, disconnect: () => port.disconnect(),
          onMessage: { addListener: (listener: (m: any) => void) => listeners.add(listener), removeListener: (listener: (m: any) => void) => listeners.delete(listener) },
          postMessage: (request: any) => {
            requests.set(request.id, request.type);
            const reply = (data: unknown) => queueMicrotask(() => emit({ id: request.id, ok: true, data }));
            if (request.type === 'prepare') reply({ phase: 'review', peerName: '测试手机', deletionReview: { id: '11111111-1111-4111-8111-111111111111', count: 3, incoming } });
            else if (request.type === 'confirm-deletions') { decisions.push(request.choice); reply({ phase: incoming ? 'confirming' : 'ready', peerName: '测试手机' }); }
            else if (request.type === 'progress' && incoming) reply({ phase: 'confirming', peerName: '测试手机' });
            else if (request.type === 'start') { started.push('start'); reply({ phase: 'transferring', peerName: '测试手机' }); }
            else port.postMessage(request);
          }
        } as unknown as chrome.runtime.Port;
      }) as typeof chrome.runtime.connect;
    }, { incoming });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: VAULT_PASSWORD }); await page.reload();
    await page.getByRole('button', { name: '设置与备份', exact: true }).first().click();
    await page.locator('[data-settings-entry="wifi-sync"]').click();
    await page.getByRole('button', { name: '同步', exact: true }).click();
    const dialog = page.locator('m3e-dialog').filter({ has: page.locator('[data-nearby-deletion-review]') });
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText('3 条历史删除记录');
    await page.setViewportSize({ width: 420, height: 850 });
    await dialog.evaluate(async element => {
      const surface = element.shadowRoot?.querySelector('dialog');
      if (surface) await Promise.all(surface.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    await expect(dialog).toContainText(incoming ? '尚未修改本机内容' : '尚未开始传输');
    await expect(dialog.getByRole('button', { name: '本次包含删除', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '跳过删除，继续同步', exact: true })).toBeVisible();
    if (choice === 'omit') await page.screenshot({ path: info.outputPath('deletion-review.png') });
    expect(await page.evaluate(() => (window as any).reviewEvidence)).toEqual({ decisions: [], started: [] });
    if (choice === 'omit') await dialog.getByRole('button', { name: '跳过删除，继续同步', exact: true }).click();
    else if (choice === 'include') await dialog.getByRole('button', { name: '本次包含删除', exact: true }).click();
    else await dialog.getByRole('button', { name: '取消同步', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).reviewEvidence)).toEqual(choice === 'cancel' ? { decisions: [], started: [] } : { decisions: [choice], started: incoming ? [] : ['start'] });
  } finally { await context.close(); }
});
