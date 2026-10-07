import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';
import type { LoginItem } from '../../src/core/model';

const master = 'Synthetic project restore master', password = 'Synthetic transfer fixture password';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fieldText = (value: string | { getText(): string } | undefined) => typeof value === 'string' ? value : value?.getText() ?? '';
async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data as T;
}
async function launch(info: TestInfo, name: string) {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath(name), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  return { context, page };
}
async function items(page: Page) {
  const summaries = await send<LoginItem[]>(page, { type: 'VAULT_LIST_ITEMS' });
  return Promise.all(summaries.map(row => send<LoginItem>(page, { type: 'VAULT_GET_ITEM', itemId: row.id })));
}

test('actual Edge restores a freshly imported KDBX trash project together and publishes after a full restart', async ({}, info) => {
  test.skip(!process.env.MONICA_315_REAL_SERVICES_CONFIG, 'Requires isolated actual Apache');
  test.setTimeout(150_000);
  const config = JSON.parse(await readFile(process.env.MONICA_315_REAL_SERVICES_CONFIG!, 'utf8')).webdav;
  expect(config.baseUrl).toBe('http://127.0.0.1:18315');
  const helper = info.outputPath('kdbx-reader.cjs');
  await build({ entryPoints: ['src/providers/keepass/keepass-vault.ts'], outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { openKeePassVault } = createRequire(import.meta.url)(helper) as typeof import('../../src/providers/keepass/keepass-vault');
  const bytes = await readFile('.tmp/android-keepass-project-317/android-keepass-project.kdbx');
  expect(hash(bytes)).toBe('b580fa742caed7b875aff74f3027777fa293c4ee2b6ad9edef04c718dc3bacbe');
  const folder = `/project-restore-${randomUUID()}`, url = `${config.baseUrl}${folder}/vault.kdbx`;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  expect((await fetch(`${config.baseUrl}${folder}`, { method: 'MKCOL', headers: { Authorization: authorization } })).status).toBe(201);
  expect((await fetch(url, { method: 'PUT', headers: { Authorization: authorization, 'If-None-Match': '*' }, body: bytes })).status).toBe(201);
  const remoteBytes = async () => {
    const response = await fetch(url, { headers: { Authorization: authorization } }); expect(response.ok).toBe(true);
    return Buffer.from(await response.arrayBuffer());
  };
  const connect = async (page: Page) => (await send<{ account: { id: string } }>(page, { type: 'KEEPASS_WEBDAV_OPEN', input: {
    name: 'Project restore WebDAV', baseUrl: `${config.baseUrl}${folder}`, username: config.username, webDavPassword: config.password,
    remotePath: 'vault.kdbx', databasePassword: password } })).account.id;
  const evidence: Record<string, unknown> = { status: 'failed', sourceSha256: hash(bytes), url, androidRuntimeTest: false };
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(info, 'origin'); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    const sourceId = await connect(app.page); await send(app.page, { type: 'PROVIDER_SYNC', providerId: sourceId });
    const original = await items(app.page), project = original.filter(row => row.passwordGroupId);
    expect(project).toHaveLength(3); expect(original).toHaveLength(4);
    // Two separately published deletion operations. A fresh profile has no local deletion-cohort history.
    await send(app.page, { type: 'VAULT_DELETE_ITEM', itemId: project[0].id });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: sourceId });
    const remaining = (await items(app.page)).filter(row => row.passwordGroupId);
    await send(app.page, { type: 'VAULT_DELETE_PASSWORD_GROUP', anchorItemId: remaining[0].id,
      expected: Object.fromEntries(remaining.map(row => [row.id, row.updatedAt])) });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: sourceId });
    const trashFile = await remoteBytes(); await writeFile(info.outputPath('native-trash.kdbx'), trashFile);
    await app.context.close(); app = await launch(info, 'fresh'); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    const providerId = await connect(app.page); await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const trash = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_DELETED_ITEMS' }); expect(trash).toHaveLength(3);
    await app.page.reload(); await app.page.getByRole('button', { name: /^回收站/ }).click();
    await app.page.locator('[data-restore-project]').click();
    const dialog = app.page.locator('[data-project-restore-dialog]');
    await expect(dialog).toContainText('恢复此项目回收站中的 3 个密码');
    await expect(dialog).toContainText('包含此项目较早删除的成员');
    await app.page.setViewportSize({ width: 320, height: 850 });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await app.page.screenshot({ path: info.outputPath('restore-confirm-320.png') });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(await send(app.page, { type: 'VAULT_LIST_DELETED_ITEMS' })).toEqual(trash);
    expect(await remoteBytes()).toEqual(trashFile);
    await app.page.locator('[data-restore-project]').click();
    await app.page.locator('[data-confirm-project-restore]').click();
    await expect(dialog).not.toBeVisible();
    expect(await send(app.page, { type: 'VAULT_LIST_DELETED_ITEMS' })).toEqual([]);
    expect(await remoteBytes()).toEqual(trashFile);
    const queued = await items(app.page); expect(queued).toHaveLength(4);
    await app.context.close(); app = await launch(info, 'fresh');
    await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    expect(await items(app.page)).toEqual(queued);
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const restoredBytes = await remoteBytes(); await writeFile(info.outputPath('restored-project.kdbx'), restoredBytes);
    const restored = await openKeePassVault(restoredBytes, { password, providerId: 'check', databaseId: 1 });
    const before = await openKeePassVault(bytes, { password, providerId: 'before', databaseId: 1 });
    expect(restored.items).toHaveLength(4); expect(restored.items.every(row => !row.deletedAt)).toBe(true);
    for (const row of original) {
      const first = before.entriesByUuid.get(row.keepassEntryUuid!)!, last = restored.entriesByUuid.get(row.keepassEntryUuid!)!;
      expect(last).toBeTruthy(); expect(last.parentGroup?.uuid.toString()).toBe(first.parentGroup?.uuid.toString());
      expect([...last.fields.keys()].sort()).toEqual([...first.fields.keys()].sort());
      for (const [name, value] of first.fields) expect(fieldText(last.fields.get(name))).toBe(fieldText(value));
      expect(last.binaries).toEqual(first.binaries); expect(last.history.length).toBe(first.history.length);
    }
    await app.page.reload(); await app.page.getByRole('button', { name: /^登录项/ }).click();
    await expect(app.page.locator('[data-stack-project], .credential-table tbody tr')).toHaveCount(2);
    await app.page.screenshot({ path: info.outputPath('restored-project.png') });
    evidence.trashSha256 = hash(trashFile); evidence.restoredSha256 = hash(restoredBytes);
    evidence.cancelPreserved = true; evidence.freshTrashProject = 3; evidence.queuedRestartVerified = true;
    evidence.nativeIdentityFieldsParentsHistoryPreserved = true; evidence.status = 'passed';
  } finally { await app?.context.close(); await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
});
