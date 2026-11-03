import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption } from './fixtures/material';
import type { ProviderAccount } from '../../src/core/model';
import { createEmptyVaultState } from '../../src/core/model';
import { deriveVaultKey, encryptVaultState } from '../../src/security/vault-crypto';

const master = 'Synthetic browser app master password';
const password = 'Synthetic MDBX browser database password';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function send(page: Page, message: Record<string, unknown>) {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), message);
  expect(result.ok, result.error).toBe(true); return result.data;
}

test('production UI creates and reopens MDBX in the browser without an installed MDBX helper', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(180000);
  const run = path.resolve('.tmp/browser-mdbx-app', randomUUID().slice(0, 12)), extension = path.join(run, 'extension');
  await mkdir(run, { recursive: true }); await cp(path.resolve('dist'), extension, { recursive: true });
  const profile = path.join(run, 'profile'), appData = path.join(run, 'appdata'); await mkdir(appData, { recursive: true });
  let context: BrowserContext | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', run, nativeHostRegisteredByTest: false, androidAcceptance: false };
  const errors: string[] = [];
  const launch = async () => {
    context = await launchEdgeContext(profile, { locale: 'zh-CN', viewport: { width: 1180, height: 950 }, env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    evidence.edgeVersion = context.browser()?.version();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
  };
  try {
    let page = await launch();
    evidence.nativeUnavailable = await page.evaluate(() => new Promise<string>(resolve => {
      const port = chrome.runtime.connectNative('com.monica_pass.mdbx2');
      port.onDisconnect.addListener(() => resolve(chrome.runtime.lastError?.message || 'disconnected'));
      port.onMessage.addListener(() => { port.disconnect(); resolve('available'); });
      port.postMessage({ protocol: 2, requestId: crypto.randomUUID(), method: 'host.hello', params: {} });
    }));
    expect(evidence.nativeUnavailable).not.toBe('available');
    // Import an authenticated pre-upgrade account with no backend field. Its
    // unavailable native helper must not hide or disconnect new browser vaults.
    const legacyId = randomUUID(), legacyHandle = randomUUID();
    const state = createEmptyVaultState(new Date().toISOString());
    state.providers.push({ id: legacyId, name: 'Legacy helper copy', kind: 'mdbx2', enabled: true, isDefaultSaveTarget: false,
      config: { vaultHandle: legacyHandle, formatVersion: 'MDBX-2' } });
    const { key, kdf } = await deriveVaultKey(master);
    const backup = { magic: 'MONICA_EXTENSION_BACKUP', version: 1, exportedAt: new Date().toISOString(), envelope: await encryptVaultState(state, key, kdf) };
    await send(page, { type: 'VAULT_RESTORE_ENCRYPTED', backup, backupPassword: master });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } })); await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.getByRole('button', { name: /^连接 MDBX2 保险库/ }).click();
    let dialog = page.locator('.mdbx2-dialog[role="dialog"]');
    await expect(dialog.getByText('已内置，无需安装组件。数据保存在此浏览器。', { exact: true })).toBeVisible();
    await dialog.getByLabel('显示名称', { exact: true }).fill('内置 MDBX 验收');
    await dialog.getByLabel('数据库密码', { exact: true }).fill(password);
    await dialog.getByLabel('确认数据库密码', { exact: true }).fill(password);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole('button', { name: '创建数据库', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('create-compact.png') });
    await dialog.getByRole('button', { name: '创建数据库', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60000 });
    const provider = ((await send(page, { type: 'PROVIDER_LIST' })) as ProviderAccount[]).find(p => p.name === '内置 MDBX 验收')!;
    expect(provider.config.runtimeBackend).toBe('browser');
    const record = await send(page, { type: 'MDBX2_OBJECT_UPSERT', providerId: provider.id, operationId: randomUUID(), input: {
      logicalObjectId: 'password:browser-ui', objectTypeId: 'login', title: 'Browser UI record', payloadJson: '{"monica_entry_id":"password:browser-ui","username":"synthetic@example.test","password_plain":"synthetic-browser-ui-secret"}'
    } });
    await send(page, { type: 'PROVIDER_SYNC', providerId: provider.id });
    const read = async () => {
      const value = await send(page, { type: 'MDBX2_OBJECT_REVEAL', providerId: provider.id, objectId: record.objectId });
      expect(JSON.parse(value.payloadJson).password_plain).toBe('synthetic-browser-ui-secret');
    };
    await read();
    // Repeated status checks must not close the authenticated Worker lease.
    await send(page, { type: 'MDBX2_HOST_STATUS', providerId: provider.id }); await read();
    const legacyStatus = await send(page, { type: 'MDBX2_HOST_STATUS', providerId: legacyId });
    expect(legacyStatus).toMatchObject({ runtimeBackend: 'native', availability: 'not-installed' }); await read();
    await page.setViewportSize({ width: 1180, height: 950 }); await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await expect(page.locator(`[data-home-provider-id="${legacyId}"]`).getByText('数据库暂不可用', { exact: true })).toBeVisible();
    const card = () => page.locator(`[data-home-provider-id="${provider.id}"]`);
    const downloading = page.waitForEvent('download'); await card().getByRole('button', { name: '导出 MDBX2 完整备份', exact: true }).click();
    const download = await downloading, exported = path.join(run, 'exported.mdbx'); await download.saveAs(exported);
    expect(await download.failure()).toBeNull(); evidence.exportSha256 = hash(await readFile(exported));
    await send(page, { type: 'MDBX2_VAULT_LOCK', providerId: provider.id });
    const locked = await page.evaluate(providerId => chrome.runtime.sendMessage({ type: 'MDBX2_OBJECT_REVEAL', providerId, objectId: '00000000-0000-4000-8000-000000000001' }), provider.id);
    expect(locked.ok).toBe(false);
    await context!.close(); context = undefined;
    page = await launch();
    if ((await send(page, { type: 'VAULT_STATUS' })) === 'locked') await send(page, { type: 'VAULT_UNLOCK', masterPassword: master });
    await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    await card().getByRole('button', { name: '解锁并设置', exact: true }).click(); dialog = page.locator('.mdbx2-dialog[role="dialog"]');
    await dialog.getByLabel('保险库密码（可留空）', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '解锁本机副本', exact: true }).click();
    await expect(dialog.getByText('数据库已就绪', { exact: true })).toBeVisible(); await read();
    const legacy = ((await send(page, { type: 'PROVIDER_LIST' })) as ProviderAccount[]).find(row => row.id === legacyId)!;
    expect(legacy.config).toMatchObject({ vaultHandle: legacyHandle, runtimeBackend: 'native' });
    await dialog.getByRole('button', { name: '关闭 MDBX2 设置', exact: true }).click();
    // Import the actual exported encrypted file through the user-facing picker.
    await page.getByRole('button', { name: /^连接 MDBX2 保险库/ }).click(); dialog = page.locator('.mdbx2-dialog[role="dialog"]');
    await chooseOption(dialog.locator('m3e-select').first(), 'local');
    await dialog.getByLabel('显示名称', { exact: true }).fill('内置 MDBX 备份导入');
    await dialog.getByLabel('MDBX 可移植备份', { exact: true }).setInputFiles(exported);
    await dialog.getByLabel('保险库密码（可留空）', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '验证、解锁并导入', exact: true }).click(); await expect(dialog).toHaveCount(0, { timeout: 60000 });
    const imported = ((await send(page, { type: 'PROVIDER_LIST' })) as ProviderAccount[]).find(p => p.name === '内置 MDBX 备份导入')!;
    expect(imported.config.runtimeBackend).toBe('browser'); expect(imported.config.vaultHandle).not.toBe(provider.config.vaultHandle);
    const restored = await send(page, { type: 'MDBX2_OBJECT_REVEAL', providerId: imported.id, objectId: record.objectId });
    expect(JSON.parse(restored.payloadJson).password_plain).toBe('synthetic-browser-ui-secret');
    await page.screenshot({ path: info.outputPath('sources-final.png'), fullPage: true });
    expect(errors).toEqual([]);
    evidence.status = 'passed'; evidence.createReadExportLockRestartImport = true; evidence.legacyUnavailableKeepsBrowserUsable = true; evidence.errors = errors;
  } finally { if (context) await context.close(); await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
});
