import { expect, test, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';
import { dialogContent } from './fixtures/material';

const master = 'Synthetic native history transfer password';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data as T;
}

test('actual Edge and Native Host block history loss before MDBX transfer and preserve it after restart', async ({}, info) => {
  test.skip(!process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE, 'Requires an explicit verified Android MDBX fixture and Windows Native Host');
  test.setTimeout(120_000);
  const fixtureRoot = process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE!;
  const fixture = path.resolve(fixtureRoot, 'edge-passkeys.mdbx');
  const proof = JSON.parse(await readFile(path.join(fixtureRoot, 'evidence.json'), 'utf8'));
  expect(proof.status).toBe('passed');
  expect(hash(await readFile(fixture))).toBe(proof.exportSha256);
  const runRoot = path.resolve('.tmp', `history-native-${randomUUID().slice(0, 12)}`);
  const localAppData = path.join(runRoot, 'local-app-data'); await mkdir(localAppData, { recursive: true });
  const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const, viewport: { width: 1180, height: 950 },
    env: { ...process.env, LOCALAPPDATA: localAppData },
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };
  const profile = info.outputPath('profile');
  let context = await launchEdgeContext(profile, options);
  let host: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const evidence: Record<string, unknown> = { status: 'failed', runRoot, fixture, fixtureSha256: proof.exportSha256, androidRuntimeTest: false };
  const errors: string[] = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host, root = `chrome-extension://${extensionId}/`;
    host = await temporaryNativeHost(extensionId, info.outputPath('native'));
    let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${root}index.html`);
    await send(page, { type: 'VAULT_SETUP', masterPassword: master });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
    const connect = page.locator('.mdbx2-dialog[role="dialog"]');
    await connect.getByLabel('显示名称', { exact: true }).fill('History native target');
    await connect.getByLabel('MDBX2 可移植备份', { exact: true }).setInputFiles(fixture);
    await connect.getByLabel('保险库密码（可留空）', { exact: true }).fill('Synthetic transfer fixture password');
    await connect.getByRole('button', { name: '验证、解锁并导入', exact: true }).click();
    await expect(connect).toHaveCount(0, { timeout: 60000 });
    const target = (await send<ProviderAccount[]>(page, { type: 'PROVIDER_LIST' })).find(row => row.name === 'History native target')!;
    expect(target.kind).toBe('mdbx2');
    const nativeSnapshot = async () => {
      const collections = await send<{ items: { collectionId: string }[]; nextCursor?: string }>(page, { type: 'MDBX2_COLLECTION_LIST', providerId: target.id, pageSize: 200 });
      expect(collections.nextCursor).toBeFalsy();
      const records = [];
      for (const collection of collections.items) {
        const objects = await send<{ items: { objectId: string }[]; nextCursor?: string }>(page, { type: 'MDBX2_OBJECT_LIST', providerId: target.id, collectionId: collection.collectionId, pageSize: 200 });
        expect(objects.nextCursor).toBeFalsy();
        for (const object of objects.items) records.push(await send(page, { type: 'MDBX2_OBJECT_REVEAL', providerId: target.id, objectId: object.objectId }));
      }
      return { collections, records };
    };
    const before = await nativeSnapshot();
    const item = createLoginItem({ title: 'Native history transfer fixture', password: 'synthetic old 密码\r\n', uris: ['https://history.example.test'] });
    await send(page, { type: 'VAULT_IMPORT_ITEMS', items: [item] }); await page.reload();
    await page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await page.getByRole('button', { name: `查看${item.title}详情`, exact: true }).click();
    await dialogContent(page, { name: new RegExp(item.title) }).getByRole('button', { name: '编辑', exact: true }).click();
    const editor = dialogContent(page, { name: '编辑密码', exact: true });
    await editor.getByLabel('密码', { exact: true }).fill('synthetic new password');
    await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
    const saved = await send<LoginItem>(page, { type: 'VAULT_GET_ITEM', itemId: item.id });
    expect(saved.passwordHistory?.map(row => row.password)).toEqual([item.password]);
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.getByRole('button', { name: '批量传输', exact: true }).click();
    const transfer = dialogContent(page, { name: '复制或移动项目', exact: true });
    await transfer.getByRole('checkbox', { name: new RegExp(item.title) }).check();
    await transfer.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(transfer.getByText('0 个可传输，1 个被阻断', { exact: true })).toBeVisible();
    await expect(transfer.getByRole('button', { name: '执行复制', exact: true })).toBeDisabled();
    await expect(transfer.getByText(/MDBX2 目标无法保存此项目的逐密码历史/).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath('blocked-history-copy.png') });
    const outcomes = [];
    for (const action of ['copy', 'move']) {
      const result = await send<{ blockedCount: number; completedCount: number; failedCount: number }>(page, { type: 'MDBX2_BATCH_TRANSFER_EXECUTE',
        input: { itemIds: [item.id], targetProviderId: target.id, action, confirmed: true, preserveCategories: true }, confirmed: true });
      expect(result).toMatchObject({ blockedCount: 1, completedCount: 0, failedCount: 0 }); outcomes.push({ action, result });
    }
    expect(await nativeSnapshot()).toEqual(before);
    expect(await send(page, { type: 'VAULT_GET_ITEM', itemId: item.id })).toEqual(saved);
    evidence.nativeSnapshotSha256 = hash(JSON.stringify(before)); evidence.outcomes = outcomes;
    evidence.sourceSha256 = hash(JSON.stringify(saved)); evidence.nativeUnchanged = true;
    await context.close(); context = await launchEdgeContext(profile, options);
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(`${root}index.html`);
    await send(page, { type: 'VAULT_UNLOCK', masterPassword: master });
    expect(await send(page, { type: 'VAULT_GET_ITEM', itemId: item.id })).toEqual(saved);
    expect(errors).toEqual([]); evidence.restartVerified = true; evidence.status = 'passed';
  } finally {
    await context.close();
    if (host) { await host.restore(); evidence.nativeHost = host.evidence; }
    evidence.consoleErrors = errors;
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
