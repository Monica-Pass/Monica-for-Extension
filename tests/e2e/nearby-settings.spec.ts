import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLoginItem } from '../../src/core/model';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

test('missing communication helper keeps pairing input usable and explains setup', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge');
  const extension=path.resolve('dist'), run=info.outputPath('isolated'); await mkdir(run,{recursive:true});
  const context=await launchEdgeContext(path.join(run,'profile'),{locale:'zh-CN',viewport:{width:1000,height:950},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(()=>{
      const original=chrome.runtime.connectNative.bind(chrome.runtime);
      chrome.runtime.connectNative=(host:string)=>original(host==='com.monica_pass.mdbx2'?'com.monica_pass.missing_pairing_test':host);
    });
    const page=await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await runtime(page,{type:'VAULT_SETUP',masterPassword:''}); await page.reload();
    await page.getByRole('button',{name:'设置与备份',exact:true}).click();await page.locator('[data-settings-entry="wifi-sync"]').click();
    await page.getByRole('button',{name:'显示本机邀请',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('本机通信组件');
    const input=page.getByRole('textbox',{name:'配对邀请',exact:true});
    await input.fill('monica-lan:2:192.168.1.2:12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(input).toHaveValue(/monica-lan:2:/);
    await expect(page.getByRole('button',{name:'连接设备',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'连接设备',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('本机通信组件');
    await expect(input).toHaveValue(/monica-lan:2:/);
    await expect(page.getByRole('img',{name:'本次配对邀请二维码'})).toHaveCount(0);
    await expect(page.getByText('通过局域网地址查找',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'配置本机通信组件',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'配置本机通信组件',exact:true}).click();
    await expect(page.locator('[data-nearby-setup]')).toContainText(new URL(worker.url()).host);
    const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'下载 Windows 通信组件'}).click();
    const download=await downloadPromise;await download.saveAs(path.join(run,'setup.zip'));
    await page.screenshot({path:path.join(run,'missing-helper.png'),fullPage:true});
  } finally {await context.close();}
});

async function runtime(page: Page, request: unknown): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}
test('settings UI pairs, discovers, synchronizes and cancels using actual Native Messaging', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(150000);
  const extension = path.resolve('dist'), run = path.resolve(info.outputPath('isolated')); await mkdir(run, { recursive: true });
  const contexts: BrowserContext[] = [], evidence: Record<string, unknown> = { status: 'failed', productionUi: true, androidApplicationAcceptance: false };
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const launch = async (name: string) => {
    const data = path.join(run, `appdata-${name}`); await mkdir(data, { recursive: true });
    const context = await launchEdgeContext(path.join(run, `profile-${name}`), { locale: 'zh-CN', colorScheme: 'dark', viewport: { width: 1080, height: 960 },
      env: { ...process.env, APPDATA: data, LOCALAPPDATA: data }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }); contexts.push(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); evidence.edgeVersion = context.browser()?.version(); return page;
  };
  const settings = async (page: Page) => {
    await page.reload(); await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    await page.locator('[data-settings-entry="wifi-sync"]').click();
    await expect(page.getByRole('button', { name: '显示本机邀请', exact: true })).toBeEnabled();
  };
  try {
    const a = await launch('a'); registration = await temporaryNativeHost(new URL(a.url()).host, path.join(run, 'native')); const b = await launch('b');
    for (const page of [a, b]) await runtime(page, { type: 'VAULT_SETUP', masterPassword: '' });
    await runtime(a, { type: 'VAULT_IMPORT_ITEMS', items: [createLoginItem({ title: 'Synthetic UI sync login', username: 'alice', password: 'synthetic UI password' })] });
    await settings(a); await settings(b);
    await a.getByRole('button', { name: '显示本机邀请', exact: true }).click();
    await expect(a.getByRole('img', { name: '本次配对邀请二维码' })).toBeVisible();
    await a.getByRole('textbox',{name:'配对邀请',exact:true}).fill('retained input while showing QR');
    await a.getByRole('button',{name:'改为输入配对链接',exact:true}).click();
    await expect(a.getByRole('textbox',{name:'配对邀请',exact:true})).toHaveValue('retained input while showing QR');
    await expect(a.getByRole('textbox',{name:'本次配对邀请',exact:true})).toHaveCount(0);
    await a.getByRole('button', { name: '显示本机邀请', exact: true }).click();
    const invite = await a.getByRole('textbox', { name: '本次配对邀请', exact: true }).inputValue();
    await expect(a.getByRole('img', { name: '本次配对邀请二维码' })).toBeVisible();
    await b.getByRole('textbox', { name: '配对邀请', exact: true }).fill(invite);
    await b.getByRole('button', { name: '连接设备', exact: true }).click();
    for (const page of [a, b]) {
      await expect(page.locator('[data-nearby-phase]')).toContainText('配对成功，尚未同步数据', { timeout: 20000 });
      await expect(page.locator('[data-nearby-result]')).toHaveCount(0);
    }
    expect(await runtime(b, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(0);
    await expect(a.getByRole('textbox', { name: '本次配对邀请', exact: true })).toHaveCount(0);
    // Follow the same device-ID roles as Android, independent of random IDs.
    const aId=await b.locator('[data-nearby-sync]').getAttribute('data-nearby-sync');
    const bId=await a.locator('[data-nearby-sync]').getAttribute('data-nearby-sync');
    const listener=aId! > bId! ? a : b, dialer=listener===a ? b : a;
    await listener.locator('[data-nearby-sync]').click();
    await expect(listener.locator('[data-nearby-phase]')).toContainText('等待手机连接', { timeout: 15000 });
    await dialer.getByRole('button', { name: '查找附近设备', exact: true }).click();
    await expect(dialer.getByText('找到 1 台已配对设备', { exact: true })).toBeVisible({ timeout: 15000 });
    await dialer.locator('[data-nearby-sync]').click();
    for (const page of [a, b]) await expect(page.locator('[data-nearby-phase]')).toContainText('同步完成', { timeout: 20000 });
    await expect(b.locator('[data-nearby-result]')).toContainText('本机处理 1 项：保存 1 项，删除 0 项。');
    await expect(b.locator('[data-nearby-result]')).toContainText('Synthetic UI sync login');
    await expect(b.locator('[data-nearby-result]')).not.toContainText('synthetic UI password');
    await b.evaluate(async () => { await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))); });
    await b.screenshot({path:path.join(run,'sync-result.png'),fullPage:true});
    for(const page of [a,b]) await page.getByRole('button',{name:'知道了',exact:true}).click();
    const received = await runtime(b, { type: 'VAULT_LIST_ITEMS' }); expect(received).toHaveLength(1); expect(received[0].password).toBe('synthetic UI password');
    await b.setViewportSize({ width: 360, height: 900 });
    const closeNavigation=b.getByRole('button',{name:'关闭导航',exact:true}); if(await closeNavigation.isVisible())await closeNavigation.click();
    expect(await b.locator('[data-nearby-settings]').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await b.screenshot({ path: path.join(run, 'nearby-settings-narrow.png'), fullPage: true });
    await a.locator('[data-nearby-sync]').click(); await a.getByRole('button', { name: '取消同步', exact: true }).click();
    await expect(a.locator('[data-nearby-phase]')).toContainText('同步已取消');
    await a.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect(a.getByRole('button', { name: '显示本机邀请', exact: true })).toBeEnabled();
    expect(await runtime(b, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(1);
    evidence.status = 'passed'; evidence.pairingWithoutContent = true; evidence.automaticDiscovery = true; evidence.manualAddressInput = false; evidence.qrToLinkSwitch = true; evidence.cancelReconnect = true;
  } finally { for (const context of contexts) await context.close(); await registration?.restore(); await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2)); }
});
