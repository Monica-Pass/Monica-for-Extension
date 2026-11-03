import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';
import type { LoginItem } from '../../src/core/model';

const master = 'Synthetic project conflict master';
const databasePassword = 'Synthetic transfer fixture password';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const keePassFieldText = (value: string | { getText(): string } | undefined) => typeof value === 'string' ? value : value?.getText() ?? '';
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

test('real Edge keeps a conflicting KDBX password project intact through restart and a fresh peer can save it together', async ({}, info) => {
  test.skip(!process.env.MONICA_315_REAL_SERVICES_CONFIG, 'Requires isolated actual Apache');
  test.setTimeout(150_000);
  const config = JSON.parse(await readFile(process.env.MONICA_315_REAL_SERVICES_CONFIG!, 'utf8')).webdav;
  // Playwright's TS loader does not normalize kdbxweb's CommonJS namespace.
  // Bundle this test-side file reader with the same explicit interop as Vite.
  const helperPath = info.outputPath('kdbx-reader.cjs');
  await build({ entryPoints: ['src/providers/keepass/keepass-vault.ts'], outfile: helperPath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { openKeePassVault } = createRequire(import.meta.url)(helperPath) as typeof import('../../src/providers/keepass/keepass-vault');
  expect(config.baseUrl).toBe('http://127.0.0.1:18315');
  const bytes = await readFile('.tmp/android-keepass-project-317/android-keepass-project.kdbx');
  expect(hash(bytes)).toBe('b580fa742caed7b875aff74f3027777fa293c4ee2b6ad9edef04c718dc3bacbe');
  const folder = `/project-conflict-${randomUUID()}`, url = `${config.baseUrl}${folder}/vault.kdbx`;
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  expect((await fetch(`${config.baseUrl}${folder}`, { method: 'MKCOL', headers: { Authorization: authorization } })).status).toBe(201);
  expect((await fetch(url, { method: 'PUT', headers: { Authorization: authorization, 'If-None-Match': '*' }, body: bytes })).status).toBe(201);
  const remoteBytes = async () => {
    const response = await fetch(url, { headers: { Authorization: authorization } }); expect(response.ok).toBe(true);
    return { bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get('etag')! };
  };
  const connect = async (page: Page) => (await send<{ account: { id: string } }>(page, { type: 'KEEPASS_WEBDAV_OPEN', input: {
    name: 'Project conflict WebDAV', baseUrl: `${config.baseUrl}${folder}`, username: config.username, webDavPassword: config.password,
    remotePath: 'vault.kdbx', databasePassword } })).account.id;
  const evidence: Record<string, unknown> = { status: 'failed', sourceSha256: hash(bytes), url, androidRuntimeTest: false };
  let app: Awaited<ReturnType<typeof launch>> | undefined, peer: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(info, 'profile'); await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    const providerId = await connect(app.page); await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const original = await items(app.page), project = original.filter(row => row.passwordGroupId);
    expect(original).toHaveLength(4); expect(project).toHaveLength(3);
    const drafts = project.map(row => ({ ...row, notes: 'local whole-project edit retained' }));
    await send(app.page, { type: 'VAULT_SAVE_PASSWORD_GROUP', items: drafts, expected: Object.fromEntries(project.map(row => [row.id, row.updatedAt])) });
    const pending = await items(app.page);
    // A synthetic peer changes another member in the actual server file without
    // incrementing UsageCount. This is not an Android application execution.
    const source = await remoteBytes();
    const changed = await openKeePassVault(source.bytes, { password: databasePassword, providerId: 'peer', databaseId: 1 });
    const remoteEntry = changed.entriesByUuid.get(project[1].keepassEntryUuid!)!;
    const originalUsage = remoteEntry.times.usageCount;
    remoteEntry.fields.set('Notes', 'remote member edit retained');
    remoteEntry.times.lastModTime = new Date('2026-10-06T12:00:00Z');
    const peerFile = new Uint8Array(await changed.database.save());
    expect((await fetch(url, { method: 'PUT', headers: { Authorization: authorization, 'If-Match': source.etag }, body: Buffer.from(peerFile) })).ok).toBe(true);
    await writeFile(info.outputPath('remote-concurrent.kdbx'), peerFile);
    await app.page.reload(); await app.page.getByRole('button', { name: '密码源', exact: true }).click();
    const card = app.page.locator(`[data-home-provider-id="${providerId}"]`);
    await card.getByRole('button', { name: '立即同步', exact: true }).click();
    await expect(card).toContainText(/字段或结构冲突|密码项目|同步失败/);
    await expect.poll(async () => (await send<{ lastError?: string }[]>(app!.page, { type: 'PROVIDER_LIST' })).some(row => row.lastError?.includes('冲突'))).toBe(true);
    expect((await remoteBytes()).bytes).toEqual(Buffer.from(peerFile));
    expect(await items(app.page)).toEqual(pending);
    await app.page.screenshot({ path: info.outputPath('project-conflict.png') });
    await app.context.close(); app = await launch(info, 'profile');
    await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    const retried = await app.page.evaluate(id => chrome.runtime.sendMessage({ type: 'PROVIDER_SYNC', providerId: id }), providerId);
    expect(retried.ok).toBe(false); expect(retried.error).toContain('冲突');
    expect(await items(app.page)).toEqual(pending); expect((await remoteBytes()).bytes).toEqual(Buffer.from(peerFile));
    evidence.conflictSurvivesRestart = true;

    peer = await launch(info, 'fresh'); await send(peer.page, { type: 'VAULT_SETUP', masterPassword: master });
    const peerId = await connect(peer.page); await send(peer.page, { type: 'PROVIDER_SYNC', providerId: peerId });
    const fresh = await items(peer.page), freshProject = fresh.filter(row => row.passwordGroupId);
    expect(freshProject.find(row => row.keepassEntryUuid === project[1].keepassEntryUuid)?.notes).toBe('remote member edit retained');
    await send(peer.page, { type: 'VAULT_SAVE_PASSWORD_GROUP', items: freshProject.map(row => ({ ...row, notes: 'fresh whole-project accepted' })),
      expected: Object.fromEntries(freshProject.map(row => [row.id, row.updatedAt])) });
    await send(peer.page, { type: 'PROVIDER_SYNC', providerId: peerId });
    const accepted = await remoteBytes(); await writeFile(info.outputPath('accepted-project.kdbx'), accepted.bytes);
    const final = await openKeePassVault(accepted.bytes, { password: databasePassword, providerId: 'check', databaseId: 1 });
    expect(final.items).toHaveLength(4);
    const before = await openKeePassVault(bytes, { password: databasePassword, providerId: 'before', databaseId: 1 });
    for (const originalRow of original) {
      const uuid = originalRow.keepassEntryUuid!, entry = final.entriesByUuid.get(uuid)!, initial = before.entriesByUuid.get(uuid)!;
      expect(keePassFieldText(entry.fields.get('Notes'))).toBe(originalRow.passwordGroupId ? 'fresh whole-project accepted' : keePassFieldText(initial.fields.get('Notes')));
      for (const [name, value] of initial.fields) if (name !== 'Notes') expect(keePassFieldText(entry.fields.get(name))).toBe(keePassFieldText(value));
      expect([...entry.binaries.keys()]).toEqual([...initial.binaries.keys()]);
      expect(entry.parentGroup?.uuid.toString()).toBe(initial.parentGroup?.uuid.toString());
    }
    expect(remoteEntry.times.usageCount).toBe(originalUsage);
    evidence.remoteConcurrentSha256 = hash(peerFile); evidence.acceptedSha256 = hash(accepted.bytes);
    evidence.localPendingSha256 = hash(JSON.stringify(pending)); evidence.nativeUuidsAndOtherFieldsExact = true;
    evidence.freshPeerWholeProjectSaved = true; evidence.status = 'passed';
  } finally {
    await peer?.context.close(); await app?.context.close();
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
