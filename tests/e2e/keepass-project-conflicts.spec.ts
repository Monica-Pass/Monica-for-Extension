import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
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

for (const mode of ['normal', 'response-loss', 'writing-resume', 'writing-cancel', 'local-choice', 'automatic-publish', 'recovery-export'] as const) test(`actual Edge project conflict choice publishes and restarts: ${mode}`, async ({}, info) => {
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
    binaries: n === 0 ? { 'shared.bin': mode === 'recovery-export' ? randomBytes(300 * 1024) : Uint8Array.of(2, 4, 6) } : undefined })) });
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
    const sourceToken = await send<string>(page, { type: 'VAULT_KEEPASS_PROJECT_SOURCE_TOKEN', providerId: account.id });
    await send(page, { type: 'VAULT_KEEPASS_PROJECT_REMOVE', confirmed: true, input: { operationId: randomUUID(), sourceToken,
      draft: { providerId: account.id, anchorItemId: original[0].id, originals: original, items: original, removedItemIds: [original[0].id] } } });
    const response = await fetch(url, { headers: { Authorization: authorization } });
    const peer = await openKeePassVault(Buffer.from(await response.arrayBuffer()), { password, providerId: 'peer', databaseId: 7 });
    peer.entriesByUuid.get(original[0].keepassEntryUuid!)!.fields.set('Notes', 'Peer conflict note');
    const peerBytes = Buffer.from(await peer.database.save());
    expect((await fetch(url, { method: 'PUT', headers: { Authorization: authorization, 'If-Match': response.headers.get('etag')! }, body: peerBytes })).ok).toBe(true);
    const conflict = await page.evaluate(providerId => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId }), account.id);
    expect(conflict.ok).toBe(false); expect(conflict.error).toContain('冲突');
    if (mode === 'automatic-publish') {
      await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: true } }));
      // Drain a real pre-review sync. It must still report the unresolved conflict.
      const retry = await page.evaluate(providerId => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId }), account.id);
      expect(retry.ok).toBe(false);
    }
    await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    let panel = page.locator('[data-keepass-project-conflicts]');
    await panel.locator('[data-conflict-review]').click();
    await expect(panel.locator('[data-conflict-choices]')).toBeVisible();
    await expect(panel.locator('[data-conflict-confirm]')).toBeDisabled();
    await page.setViewportSize({ width: 320, height: 950 });
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('conflict-choices-320.png') });
    await panel.getByRole('button', { name: '返回', exact: true }).click();
    expect(await remoteBytes()).toEqual(peerBytes);
    await panel.locator('[data-conflict-review]').click();
    await panel.locator('select').selectOption(mode === 'local-choice' ? 'local' : 'remote');
    await page.evaluate(drop => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      (window as any).resolutionCalls = 0;
      chrome.runtime.sendMessage = ((request: {type?: string}) => {
        const promise = send(request);
        if (request.type !== 'VAULT_KEEPASS_PROJECT_RESOLVE') return promise;
        (window as any).resolutionCalls++;
        return promise.then(result => drop ? undefined : result);
      }) as typeof chrome.runtime.sendMessage;
    }, mode === 'response-loss');
    const localBefore = await items(page);
    if (mode.startsWith('writing-')) await app.worker.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      (globalThis as any).resolutionFaults = 0;
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.transaction.db.name === 'monica-extension-keepass-working-copies' && this.name === 'operation-receipts') {
          (globalThis as any).resolutionFaults++; this.transaction.abort(); throw new Error('Synthetic resolution receipt transaction abort');
        }
        return key === undefined ? put.call(this, value) : put.call(this, value, key);
      };
    });
    await panel.locator('[data-conflict-confirm]').click();
    if (mode.startsWith('writing-')) {
      await expect(panel.locator('[data-resolution-operation]')).toHaveCount(1);
      const operations = await send<{ operationId: string; status: string }[]>(page, { type: 'VAULT_KEEPASS_PROJECT_RESOLUTIONS' });
      expect(operations).toHaveLength(1); expect(operations[0].status).toBe('writing');
      expect(await app.worker.evaluate(() => (globalThis as any).resolutionFaults)).toBeGreaterThan(0);
      expect(await items(page)).toEqual(localBefore); expect(await remoteBytes()).toEqual(peerBytes);
      await app.context.close(); app = await launch(info); page = app.page;
      await send(page, { type: 'VAULT_UNLOCK', masterPassword: master });
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.setViewportSize({ width: 320, height: 950 });
      panel = page.locator('[data-keepass-project-conflicts]');
      await expect(panel.locator('[data-resolution-operation]')).toHaveCount(1);
      await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('pending-resolution-320.png') });
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      if (mode === 'writing-cancel') {
        await panel.locator('[data-resolution-cancel]').click();
        await expect(panel.locator('[data-resolution-operation]')).toHaveCount(0);
        expect((await send<{status:string}[]>(page, { type: 'VAULT_KEEPASS_PROJECT_RESOLUTIONS', operationId: operations[0].operationId }))[0].status).toBe('cancelled');
        expect(await items(page)).toEqual(localBefore); expect(await remoteBytes()).toEqual(peerBytes);
        await panel.locator('[data-conflict-review]').click(); await panel.locator('select').selectOption('remote');
        await panel.locator('[data-conflict-confirm]').click();
      } else await panel.locator('[data-resolution-resume]').click();
      evidence.recoveredAfterTransactionAbortAndRestart = true;
    }
    await expect(panel.getByRole('status')).toContainText('所选版本已保存到本机', { timeout: 30_000 });
    if (!mode.startsWith('writing-')) expect(await page.evaluate(() => (window as any).resolutionCalls)).toBe(1);
    const expectedActive = mode === 'local-choice' ? original.slice(1) : original;
    const restored = await items(page); expect(restored).toHaveLength(expectedActive.length);
    expect(restored.map(row => row.keepassEntryUuid).sort()).toEqual(expectedActive.map(row => row.keepassEntryUuid).sort());
    if (mode === 'local-choice') expect(restored.every(row => row.notes === 'Original shared notes')).toBe(true);
    else expect(restored.find(row => row.keepassEntryUuid === original[0].keepassEntryUuid)!.notes).toBe('Peer conflict note');
    if (mode === 'automatic-publish') {
      await expect.poll(async () => (await remoteBytes()).equals(peerBytes), { timeout: 30_000 }).toBe(false);
      evidence.automaticPublicationWithoutManualSync = true;
    } else await send(page, { type: 'PROVIDER_SYNC', providerId: account.id });
    const actual = await openKeePassVault(await remoteBytes(), { password, providerId: 'independent', databaseId: 7 });
    expect(actual.entriesByUuid.get(original[0].keepassEntryUuid!)!.fields.get('Notes')).toBe(mode === 'local-choice' ? 'Original shared notes' : 'Peer conflict note');
    expect(actual.entriesByUuid.size).toBe(3);
    expect(actual.items.filter(row => !row.deletedAt)).toHaveLength(expectedActive.length);
    if (mode === 'recovery-export') {
      const copies = await send<Array<{operationId: string; intentTag: string}>>(page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_LIST', providerId: account.id });
      expect(copies).toHaveLength(1);
      const input = { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN', providerId: account.id, operationId: copies[0].operationId,
        expectedIntentTag: copies[0].intentTag, exportPassword: 'Synthetic portable recovery password', requestId: randomUUID() };
      // Discard the actual successful BEGIN reply, then recover the same export.
      await page.evaluate(async request => { await chrome.runtime.sendMessage(request); }, input);
      const recovered = await send<{state:string; descriptor:{downloadHandle:string; sizeBytes:number; maxChunkBytes:number; sha256:string}}>(page,
        { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_STATUS', providerId: account.id, requestId: input.requestId });
      expect(recovered.state).toBe('ready'); const descriptor = recovered.descriptor;
      expect(descriptor.sizeBytes).toBeGreaterThan(descriptor.maxChunkBytes);
      const another = await app.context.newPage(); await another.goto(page.url());
      expect((await another.evaluate(request => chrome.runtime.sendMessage(request), { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ', providerId: account.id,
        downloadHandle: descriptor.downloadHandle, offset: 0 })).ok).toBe(false); await another.close();
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < descriptor.sizeBytes) {
        const chunk = await send<{dataBase64:string; nextOffset:number; eof:boolean}>(page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ', providerId: account.id, downloadHandle: descriptor.downloadHandle, offset });
        const bytes = Buffer.from(chunk.dataBase64, 'base64'); expect(bytes.length).toBeLessThanOrEqual(descriptor.maxChunkBytes);
        expect(chunk.nextOffset).toBe(offset + bytes.length); expect(chunk.eof).toBe(chunk.nextOffset === descriptor.sizeBytes);
        chunks.push(bytes); offset = chunk.nextOffset;
      }
      const exported = Buffer.concat(chunks); expect(createHash('sha256').update(exported).digest('hex')).toBe(descriptor.sha256);
      await send(page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_RELEASE', providerId: account.id, downloadHandle: descriptor.downloadHandle });
      const container = await openKeePassVault(exported, { password: input.exportPassword, providerId: 'portable', databaseId: 8 });
      expect(container.entriesByUuid.size).toBe(4);
      for (const entry of container.entriesByUuid.values()) {
        const part = String(entry.fields.get('MonicaRecoveryPart')), blob = entry.binaries.get(`${part}.kdbx`) as any;
        const innerBytes = blob.value.getBinary ? blob.value.getBinary() : new Uint8Array(blob.value);
        const inner = await openKeePassVault(innerBytes, { password, providerId: 'extracted', databaseId: 9 });
        expect(inner.entriesByUuid.size).toBe(3);
        if (part === 'remote' || part === 'resolved') expect(inner.entriesByUuid.get(original[0].keepassEntryUuid!)!.fields.get('Notes')).toBe('Peer conflict note');
      }
      await writeFile(info.outputPath('portable-recovery.kdbx'), exported);
      const recoveryUi = page.locator('[data-recovery-copies]');
      await recoveryUi.locator('[data-recovery-open]').click();
      await recoveryUi.locator('[data-recovery-export]').click();
      await recoveryUi.locator('[data-recovery-password]').fill(input.exportPassword);
      await recoveryUi.locator('[data-recovery-repeat]').fill(input.exportPassword);
      expect(await recoveryUi.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await recoveryUi.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('recovery-export-ui-320.png') });
      await page.evaluate(() => {
        const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        (window as any).recoveryUiBegins = 0;
        chrome.runtime.sendMessage = ((request: { type?: string }) => {
          const result = originalSend(request);
          if (request.type !== 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN') return result;
          (window as any).recoveryUiBegins++;
          return result.then(() => undefined);
        }) as typeof chrome.runtime.sendMessage;
      });
      const downloadEvent = page.waitForEvent('download');
      await recoveryUi.locator('[data-recovery-download]').click();
      const download = await downloadEvent;
      await download.saveAs(info.outputPath('ui-recovery.kdbx'));
      const uiContainer = await openKeePassVault(await readFile(info.outputPath('ui-recovery.kdbx')), { password: input.exportPassword, providerId: 'ui-portable', databaseId: 10 });
      expect(uiContainer.entriesByUuid.size).toBe(4);
      expect(await page.evaluate(() => (window as any).recoveryUiBegins)).toBe(1);
      for (const entry of uiContainer.entriesByUuid.values()) {
        const part = String(entry.fields.get('MonicaRecoveryPart'));
        const binary = entry.binaries.get(`${part}.kdbx`) as any;
        const extracted = binary.value.getBinary ? binary.value.getBinary() : new Uint8Array(binary.value);
        const reference = [...container.entriesByUuid.values()].find(row => String(row.fields.get('MonicaRecoveryPart')) === part)!;
        const referenceBinary = reference.binaries.get(`${part}.kdbx`) as any;
        const expected = referenceBinary.value.getBinary ? referenceBinary.value.getBinary() : new Uint8Array(referenceBinary.value);
        expect(Buffer.from(extracted)).toEqual(Buffer.from(expected));
        expect((await openKeePassVault(extracted, { password, providerId: 'ui-extracted', databaseId: 11 })).entriesByUuid.size).toBe(3);
      }
      await expect(recoveryUi.locator('[data-recovery-export]')).toBeVisible();
      await recoveryUi.locator('[data-recovery-delete]').click();
      await recoveryUi.getByRole('button', { name: '保留副本', exact: true }).click();
      await expect(recoveryUi.locator('[data-recovery-copy]')).toHaveCount(1);
      evidence.managerDownloadAndDeleteCancel = true;
      await page.reload();
      const cancellationId = randomUUID();
      await send(page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_CANCEL', providerId: account.id, requestId: cancellationId });
      expect((await page.evaluate(request => chrome.runtime.sendMessage(request), { ...input, requestId: cancellationId })).ok).toBe(false);
      const cancellable = { ...input, requestId: randomUUID() };
      const cancelled = await send<{downloadHandle:string}>(page, cancellable);
      await send(page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_CANCEL', providerId: account.id, requestId: cancellable.requestId });
      expect((await page.evaluate(request => chrome.runtime.sendMessage(request), { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ', providerId: account.id,
        downloadHandle: cancelled.downloadHandle, offset: 0 })).ok).toBe(false);
      // Restore the manager after the intentional BEGIN-response-loss wrapper.
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await recoveryUi.locator('[data-recovery-open]').click();
      await recoveryUi.locator('[data-recovery-export]').click();
      await recoveryUi.locator('[data-recovery-password]').fill(input.exportPassword);
      await recoveryUi.locator('[data-recovery-repeat]').fill(input.exportPassword);
      await page.evaluate(() => {
        const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = ((request: { type?: string }) => {
          if (request.type !== 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN') return originalSend(request);
          (window as any).heldRecoveryRequest = request;
          return new Promise(resolve => { (window as any).dispatchHeldRecovery = async () => resolve(await originalSend(request)); });
        }) as typeof chrome.runtime.sendMessage;
      });
      let unexpectedDownloads = 0;
      const countDownload = () => { unexpectedDownloads++; }; page.on('download', countDownload);
      await recoveryUi.locator('[data-recovery-download]').click();
      await expect.poll(() => page.evaluate(() => !!(window as any).heldRecoveryRequest)).toBe(true);
      await recoveryUi.locator('[data-recovery-cancel]').click();
      await expect(recoveryUi.locator('[data-recovery-export]')).toBeVisible();
      await page.evaluate(() => (window as any).dispatchHeldRecovery());
      expect((await send<{state:string}>(page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_STATUS', providerId: account.id,
        requestId: await page.evaluate(() => (window as any).heldRecoveryRequest.requestId) })).state).toBe('cancelled');
      expect(unexpectedDownloads).toBe(0); page.off('download', countDownload);
      await page.reload();
      const second = await send<{downloadHandle:string}>(page, { ...input, requestId: randomUUID() });
      await send(page, { type: 'VAULT_LOCK' }); await send(page, { type: 'VAULT_UNLOCK', masterPassword: master });
      expect((await page.evaluate(request => chrome.runtime.sendMessage(request), { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ', providerId: account.id,
        downloadHandle: second.downloadHandle, offset: 0 })).ok).toBe(false);
      evidence.chunkedExportReadbackAndLock = true;
      evidence.beginResponseRecoveryAndCancellation = true;
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await recoveryUi.locator('[data-recovery-open]').click();
      await recoveryUi.locator('[data-recovery-delete]').click();
      const beforeDelete = await items(page), remoteBeforeDelete = await remoteBytes();
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        (window as any).recoveryDeleteCalls = 0;
        chrome.runtime.sendMessage = ((request: { type?: string }) => {
          const result = send(request);
          if (request.type !== 'VAULT_KEEPASS_PROJECT_RECOVERY_DELETE') return result;
          (window as any).recoveryDeleteCalls++;
          return result.then(() => undefined);
        }) as typeof chrome.runtime.sendMessage;
      });
      await recoveryUi.locator('[data-recovery-delete-confirm]').click();
      await expect(recoveryUi.locator('[data-recovery-copy]')).toHaveCount(0);
      await expect(recoveryUi.getByText('恢复副本已删除。', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => (window as any).recoveryDeleteCalls)).toBe(1);
      expect(await items(page)).toEqual(beforeDelete); expect(await remoteBytes()).toEqual(remoteBeforeDelete);
      evidence.managerLostResponseCancelAndDelete = true;
    }
    await app.context.close(); app = await launch(info);
    await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: account.id });
    expect((await items(app.page)).map(row => row.keepassEntryUuid).sort()).toEqual(expectedActive.map(row => row.keepassEntryUuid).sort());
    if (mode === 'recovery-export') expect(await send(app.page, { type: 'VAULT_KEEPASS_PROJECT_RECOVERY_LIST', providerId: account.id })).toEqual([]);
    evidence.status = 'passed'; evidence.choice = mode === 'local-choice' ? 'local' : 'remote'; evidence.restartVerified = true;
  } finally { await app?.context.close(); await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
});
