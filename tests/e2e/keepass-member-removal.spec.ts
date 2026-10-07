import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';
import type { LoginItem } from '../../src/core/model';

const master = 'Synthetic removal master', password = 'Synthetic KDBX removal password';
const title = 'KeePass member removal acceptance';
async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data as T;
}
async function launch(info: TestInfo) {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  return { context, page, worker };
}
async function items(page: Page) {
  const rows = await send<LoginItem[]>(page, { type: 'VAULT_LIST_ITEMS' });
  return Promise.all(rows.map(row => send<LoginItem>(page, { type: 'VAULT_GET_ITEM', itemId: row.id })));
}
async function editor(page: Page) {
  await page.getByRole('button', { name: /^全部项目/ }).click();
  await page.getByLabel('搜索密码库', { exact: true }).fill(title);
  await page.getByLabel(`查看${title}详情`, { exact: true }).first().click();
  await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.locator('m3e-dialog.material-editor-dialog');
  await expect(dialog.locator('[data-project-credential-editor]').first()).toBeVisible();
  return dialog;
}

for (const mode of ['ack-loss', 'remote-edit', 'stale-draft', 'staged-cancel', 'writing-resume'] as const) test(`actual Edge KeePass owner removal preserves data after restart: ${mode}`, async ({}, info) => {
  test.skip(!process.env.MONICA_315_REAL_SERVICES_CONFIG, 'Requires isolated Apache WebDAV');
  test.setTimeout(180_000);
  const config = JSON.parse(await readFile(process.env.MONICA_315_REAL_SERVICES_CONFIG!, 'utf8')).webdav;
  expect(config.baseUrl).toBe('http://127.0.0.1:18315');
  const helper = info.outputPath('fixture.cjs');
  await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture'; export {openKeePassVault} from './src/providers/keepass/keepass-vault';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { buildKeePassFixture, openKeePassVault } = createRequire(import.meta.url)(helper) as
    typeof import('../../src/providers/keepass/keepass-fixture') & typeof import('../../src/providers/keepass/keepass-vault');
  const projectId = randomUUID(), groupId = randomUUID();
  const bytes = await buildKeePassFixture({ password, entries: [0, 1, 2].map(n => ({ title,
    fields: { URL: 'https://example.com', UserName: 'synthetic-user', Notes: 'Original shared notes' },
    protectedFields: { Password: `synthetic-${n}`, 'monica.content.credential': JSON.stringify({ version: 1, projectId, groupId,
      passwordId: randomUUID(), label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }) },
    binaries: n === 0 ? { 'shared.bin': Uint8Array.of(2, 4, 6) } : undefined })) });
  const folder = `/member-removal-${randomUUID()}`, url = `${config.baseUrl}${folder}/vault.kdbx`;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  expect((await fetch(`${config.baseUrl}${folder}`, { method: 'MKCOL', headers: { Authorization: authorization } })).status).toBe(201);
  expect((await fetch(url, { method: 'PUT', headers: { Authorization: authorization, 'If-None-Match': '*' }, body: Buffer.from(bytes) })).status).toBe(201);
  const remoteBytes = async () => {
    const response = await fetch(url, { headers: { Authorization: authorization } }); expect(response.ok).toBe(true);
    return Buffer.from(await response.arrayBuffer());
  };
  const evidence: Record<string, unknown> = { status: 'failed', url, syntheticFixture: true, androidRuntimeTest: false };
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(info); let page = app.page;
    await send(page, { type: 'VAULT_SETUP', masterPassword: master });
    const { account } = await send<{ account: { id: string } }>(page, { type: 'KEEPASS_WEBDAV_OPEN', input: {
      name: 'Removal WebDAV', baseUrl: `${config.baseUrl}${folder}`, username: config.username, webDavPassword: config.password,
      remotePath: 'vault.kdbx', databasePassword: password } });
    await send(page, { type: 'PROVIDER_SYNC', providerId: account.id });
    const original = await items(page); expect(original).toHaveLength(3);
    await page.reload();
    let dialog = await editor(page);
    const remove = () => dialog.locator('[data-remove-password]').first();
    await remove().click(); await expect(remove()).toHaveAttribute('aria-label', '撤销移除密码 1');
    await remove().click(); await expect(remove()).toHaveAttribute('aria-label', '移除密码 1');
    await remove().click();
    await dialog.getByRole('button', { name: '查看移除并保存', exact: true }).click();
    await expect(dialog.locator('[data-removal-review]')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 950 });
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath('removal-review-320.png') });
    await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await items(page)).toEqual(original); expect(await remoteBytes()).toEqual(Buffer.from(bytes));
    await page.setViewportSize({ width: 1180, height: 950 });
    dialog = await editor(page); await remove().click();
    // Discard only the real commit's acknowledgement to exercise manager receipt recovery.
    await page.evaluate(mode => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
      const audit = { calls: 0, dropped: false };
      (window as unknown as { removalAudit: typeof audit }).removalAudit = audit;
      chrome.runtime.sendMessage = ((request: { type?: string }) => {
        const result = originalSend(request);
        if (request.type !== 'VAULT_KEEPASS_PROJECT_REMOVE') return result;
        audit.calls++;
        return result.then(response => {
          if (['ack-loss', 'remote-edit'].includes(mode) && !audit.dropped) { audit.dropped = true; return undefined; }
          return response;
        });
      }) as typeof chrome.runtime.sendMessage;
    }, mode);
    if (mode === 'staged-cancel' || mode === 'writing-resume') {
      await app.worker.evaluate(mode => {
        const originalGet = IDBObjectStore.prototype.get, originalPut = IDBObjectStore.prototype.put;
        const audit = { failures: 0 };
        (globalThis as unknown as { storageFaultAudit: typeof audit }).storageFaultAudit = audit;
        IDBObjectStore.prototype.get = function(key) {
          if (mode === 'staged-cancel' && this.transaction.db.name === 'monica-extension-keepass-working-copies' && this.name === 'working-copies') {
            audit.failures++; throw new Error('Synthetic working-copy read failure before capture');
          }
          return originalGet.call(this, key);
        };
        IDBObjectStore.prototype.put = function(value, key) {
          if (mode === 'writing-resume' && this.transaction.db.name === 'monica-extension-keepass-working-copies' && this.name === 'operation-receipts') {
            audit.failures++; this.transaction.abort(); throw new Error('Synthetic receipt transaction failure');
          }
          return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
        };
      }, mode);
    }
    await dialog.getByRole('button', { name: '查看移除并保存', exact: true }).click();
    if (mode === 'stale-draft') {
      const concurrent = { ...original[1], notes: 'Later local edit must survive rejection' };
      await send(page, { type: 'VAULT_UPSERT_ITEM', item: concurrent, expectedUpdatedAt: original[1].updatedAt });
      const before = await items(page);
      await dialog.getByRole('button', { name: '确认移除并保存', exact: true }).click();
      await expect(dialog.locator('[data-removal-review]')).toHaveCount(0);
      await expect(dialog.locator('[data-project-credential-editor]').first()).toBeVisible();
      await expect(remove()).toHaveAttribute('aria-label', '撤销移除密码 1');
      expect(await send(page, { type: 'VAULT_KEEPASS_PROJECT_REMOVALS' })).toEqual([]);
      expect(await items(page)).toEqual(before); expect(await remoteBytes()).toEqual(Buffer.from(bytes));
      await page.screenshot({ path: info.outputPath('rejected-draft-preserved.png') });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      evidence.status = 'passed'; evidence.rejectedBeforeWrite = true; evidence.editorDraftSelectionPreserved = true;
      return;
    }
    await dialog.getByRole('button', { name: '确认移除并保存', exact: true }).click();
    if (mode === 'staged-cancel' || mode === 'writing-resume') {
      await expect(dialog.getByRole('button', { name: '重试这次保存', exact: true })).toBeVisible();
      expect(await app.worker.evaluate(() => (globalThis as unknown as { storageFaultAudit: { failures: number } }).storageFaultAudit.failures)).toBeGreaterThan(0);
      const pending = await send<{ operationId: string; status: string }[]>(page, { type: 'VAULT_KEEPASS_PROJECT_REMOVALS' });
      expect(pending).toHaveLength(1); expect(pending[0].status).toBe(mode === 'staged-cancel' ? 'staged' : 'writing');
      expect(await items(page)).toEqual(original); expect(await remoteBytes()).toEqual(Buffer.from(bytes));
      await dialog.getByRole('button', { name: '查看待处理操作', exact: true }).click();
      await expect(page.locator(`[data-removal-operation="${pending[0].operationId}"]`)).toBeVisible();
      await app.context.close(); app = await launch(info); page = app.page;
      dialog = page.locator('m3e-dialog.material-editor-dialog');
      await send(page, { type: 'VAULT_UNLOCK', masterPassword: master }); await page.reload();
      await page.getByRole('button', { name: '密码源', exact: true }).click();
      const panel = page.locator(`[data-removal-operation="${pending[0].operationId}"]`);
      await expect(panel).toBeVisible(); await page.setViewportSize({ width: 320, height: 950 });
      await panel.scrollIntoViewIfNeeded(); expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('pending-after-restart-320.png') });
      if (mode === 'staged-cancel') {
        await panel.locator('[data-removal-cancel]').click(); await expect(panel).toHaveCount(0);
        const terminal = await send<{ status: string }[]>(page, { type: 'VAULT_KEEPASS_PROJECT_REMOVALS', operationId: pending[0].operationId });
        expect(terminal[0].status).toBe('cancelled'); expect(await items(page)).toEqual(original); expect(await remoteBytes()).toEqual(Buffer.from(bytes));
        evidence.status = 'passed'; evidence.stagedCancellationAfterRestart = true; evidence.originalLocalAndRemotePreserved = true; return;
      }
      await expect(panel.locator('[data-removal-cancel]')).toHaveCount(0);
      await panel.locator('[data-removal-resume]').click(); await expect(panel).toHaveCount(0);
      expect(await send(page, { type: 'VAULT_KEEPASS_PROJECT_REMOVALS' })).toEqual([]);
      evidence.writingResumedAfterRestart = true;
    }
    await expect(dialog).not.toBeVisible({ timeout: 30_000 });
    if (mode !== 'writing-resume') expect(await page.evaluate(() => (window as unknown as { removalAudit: { calls: number; dropped: boolean } }).removalAudit))
      .toEqual({ calls: 1, dropped: true });
    const retained = await items(page); expect(retained).toHaveLength(2);
    const trash = await send<LoginItem[]>(page, { type: 'VAULT_LIST_DELETED_ITEMS' }); expect(trash).toHaveLength(1);
    expect(trash[0].password).toBe('synthetic-0');
    const removedId = original.find(row => !retained.some(item => item.id === row.id))!.id;
    expect(original.find(row => row.id === removedId)!.password).toBe('synthetic-0');
    if (mode === 'remote-edit') {
      // An independent peer edits the member being deleted, using the real HTTP ETag.
      const response = await fetch(url, { headers: { Authorization: authorization } });
      expect(response.ok).toBe(true);
      const changed = await openKeePassVault(Buffer.from(await response.arrayBuffer()), { password, providerId: 'peer', databaseId: 7 });
      const entry = changed.entriesByUuid.get(original.find(row => row.id === removedId)!.keepassEntryUuid!)!;
      entry.fields.set('Notes', 'Concurrent peer owner note must survive');
      entry.times.lastModTime = new Date(Date.now() + 10_000);
      const peerFile = Buffer.from(await changed.database.save());
      expect((await fetch(url, { method: 'PUT', headers: { Authorization: authorization, 'If-Match': response.headers.get('etag')! }, body: peerFile })).ok).toBe(true);
      await writeFile(info.outputPath('peer-concurrent.kdbx'), peerFile);
      const sync = () => app!.page.evaluate(providerId => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId }), account.id);
      const failed = await sync(); expect(failed.ok).toBe(false); expect(failed.error).toContain('冲突');
      expect(await remoteBytes()).toEqual(peerFile); expect(await items(page)).toEqual(retained);
      await app.context.close(); app = await launch(info);
      await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
      const retry = await sync(); expect(retry.ok).toBe(false); expect(retry.error).toContain('冲突');
      expect(await remoteBytes()).toEqual(peerFile); expect(await items(app.page)).toEqual(retained);
      await app.page.reload(); await app.page.getByRole('button', { name: '密码源', exact: true }).click();
      await expect(app.page.locator(`[data-home-provider-id="${account.id}"]`)).toContainText('冲突');
      await app.page.screenshot({ path: info.outputPath('removal-conflict.png') });
      evidence.status = 'passed'; evidence.conflictPreservesPeerFileAndLocalRemoval = true; evidence.conflictSurvivesRestart = true;
      evidence.conflictResolved = false; return;
    }
    await send(page, { type: 'PROVIDER_SYNC', providerId: account.id });
    const saved = await remoteBytes(); await writeFile(info.outputPath('published.kdbx'), saved);
    const native = await openKeePassVault(saved, { password, providerId: 'readback', databaseId: 7 });
    expect(native.items).toHaveLength(3); expect(native.items.filter(row => row.deletedAt)).toHaveLength(1);
    for (const row of original) {
      const reread = native.items.find(item => item.keepassEntryUuid === row.keepassEntryUuid)!;
      expect(reread).toBeTruthy(); expect(reread.password).toBe(row.password); expect(reread.notes).toBe(row.notes);
      const metadata = (item: LoginItem) => JSON.parse(item.customFields.find(field => field.name === 'monica.content.credential')!.value);
      expect(metadata(reread as LoginItem).passwordId).toBe(metadata(row).passwordId);
    }
    const owner = native.items.find(row => !row.deletedAt && row.password === 'synthetic-1')!;
    const entry = native.entriesByUuid.get(owner.keepassEntryUuid!)!;
    expect(entry.binaries.has('shared.bin')).toBe(true);
    const binary = entry.binaries.get('shared.bin') as { value: ArrayBuffer };
    expect([...new Uint8Array(binary.value)]).toEqual([2, 4, 6]);
    await app.context.close(); app = await launch(info);
    await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: account.id });
    expect((await items(app.page)).map(row => row.id).sort()).toEqual(retained.map(row => row.id).sort());
    const final = await openKeePassVault(await remoteBytes(), { password, providerId: 'final', databaseId: 7 });
    expect(final.items.filter(row => row.deletedAt)).toHaveLength(1);
    evidence.status = 'passed'; evidence.cancelPreserved = true; evidence.retained = 2; evidence.trash = 1;
    evidence.nativeIdsPasswordsNotesAttachmentPreserved = true; evidence.restartSyncVerified = true;
    evidence.lostResponseRecoveredWithoutSecondRemoval = mode === 'ack-loss';
    evidence.publishedSha256 = createHash('sha256').update(saved).digest('hex');
  } finally {
    if (app) { await app.page.screenshot({ path: info.outputPath('last-state.png') }).catch(() => undefined); await app.context.close(); }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
