import { expect, test, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import type { LoginItem, ProviderAccount } from '../../src/core/model';

const master = 'Synthetic local file manager password', password = 'Synthetic local KDBX password';
const title = 'Local KDBX project acceptance';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function send<T = any>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}

for (const version of [3, 4] as const) test(`local KDBX ${version} owner removal survives original-file reopen and browser restart`, async ({}, info) => {
  test.setTimeout(120_000);
  const helper = info.outputPath('fixture.cjs');
  await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture'; export {openKeePassVault} from './src/providers/keepass/keepass-vault';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { buildKeePassFixture, openKeePassVault } = createRequire(import.meta.url)(helper) as
    typeof import('../../src/providers/keepass/keepass-fixture') & typeof import('../../src/providers/keepass/keepass-vault');
  const projectId = randomUUID(), groupId = randomUUID(), keyFile = version === 3 ? Uint8Array.from({ length: 32 }, (_, i) => i + 1) : undefined;
  const bytes = await buildKeePassFixture({ password, keyFile, version, entries: [0, 1].map(n => ({ title,
    fields: { URL: 'https://example.invalid/', UserName: 'synthetic-user', Notes: 'Shared project notes' },
    protectedFields: { Password: `original-synthetic-password-${n}`, 'monica.content.credential': JSON.stringify({ version: 1, projectId, groupId,
      passwordId: randomUUID(), label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }).replace(/}$/, ',"future":9007199254740993}') },
    binaries: n === 0 ? { 'shared.bin': Uint8Array.of(2, 4, 6, 8) } : undefined })) });
  const file = info.outputPath('original.kdbx'); await writeFile(file, bytes);
  const extension = path.resolve('dist'), profile = info.outputPath('profile');
  const options = { locale: 'zh-CN', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const,
    viewport: { width: 1180, height: 950 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchEdgeContext(profile, options);
  context.setDefaultTimeout(15_000);
  const errors: string[] = [], evidence: Record<string, any> = { status: 'failed', version, synthetic: true, sourceSha256: hash(bytes) };
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    let page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(url);
    await send(page, { type: 'VAULT_SETUP', masterPassword: master });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } })); await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.getByRole('button', { name: '连接 KeePass' }).click();
    const open = async (reopening: boolean, selected = file, secret = password, error?: RegExp) => {
      const dialog = dialogContent(page, { name: /KeePass/ });
      await dialog.getByLabel('显示名称', { exact: true }).fill('Local project source');
      await dialog.getByLabel('KeePass 数据库文件', { exact: true }).setInputFiles(selected);
      if (keyFile) await dialog.getByLabel('密钥文件（可选）', { exact: true }).setInputFiles({ name: 'synthetic.key', mimeType: 'application/octet-stream', buffer: Buffer.from(keyFile) });
      await dialog.getByLabel('数据库密码（可留空）', { exact: true }).fill(secret);
      await dialog.getByRole('button', { name: reopening ? '重新选择并解锁' : '解锁并连接', exact: true }).click();
      if (error) await expect(dialog.getByRole('alert')).toContainText(error); else await expect(dialog).toHaveCount(0);
    };
    await open(false);
    const account = (await send<ProviderAccount[]>(page, { type: 'PROVIDER_LIST' })).find(p => p.name === 'Local project source')!;
    expect(account.config.localFileSourceSha256).toBe(hash(bytes));
    expect(account.config).not.toHaveProperty('databasePassword'); expect(account.config).not.toHaveProperty('keyFile');
    const sourceCard = () => page.locator(`[data-home-provider-id="${account.id}"]`);
    await sourceCard().getByRole('button', { name: '立即同步', exact: true }).click();
    const list = async () => (await send<LoginItem[]>(page, { type: 'VAULT_LIST_ITEMS' })).filter(row => !row.deletedAt && row.providerRefs.some(ref => ref.providerId === account.id));
    await expect.poll(async () => (await list()).length).toBe(2);
    const original = await list(); evidence.original = original;
    await page.getByRole('button', { name: /^全部项目/ }).click();
    await page.getByRole('button', { name: `查看${title}详情`, exact: true }).click();
    await dialogContent(page, { name: title, exact: true }).getByRole('button', { name: '编辑', exact: true }).click();
    const editor = dialogContent(page, { name: '编辑密码', exact: true });
    const remove = editor.locator('[data-remove-password]').first();
    await expect(remove).toBeEnabled(); await remove.click(); await remove.click(); await remove.click();
    await editor.getByRole('button', { name: '查看移除并保存', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 950 }); await page.screenshot({ path: info.outputPath('local-removal-review-320.png') });
    await editor.getByRole('button', { name: '确认移除并保存', exact: true }).click();
    await expect(editor).toHaveCount(0);
    const retained = await list(); expect(retained).toHaveLength(1); evidence.retained = retained;
    expect(retained[0].password).toBe('original-synthetic-password-1');
    expect(retained[0].keepassEntryUuid).toBe(original.find(row => row.password.endsWith('-1'))!.keepassEntryUuid);
    const savedId = retained[0].id;
    await context.close(); context = await launchEdgeContext(profile, options);
    context.setDefaultTimeout(15_000);
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(url);
    await page.getByLabel('主密码', { exact: true }).fill(master); await page.getByRole('button', { name: '解锁', exact: true }).click();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await sourceCard().getByRole('button', { name: '管理 KeePass', exact: true }).click();
    await open(true);
    await sourceCard().getByRole('button', { name: '立即同步', exact: true }).click();
    expect((await list()).map(row => row.id)).toEqual([savedId]);
    await page.screenshot({ path: info.outputPath('local-recovered-source.png') });
    const downloadEvent = page.waitForEvent('download'); await sourceCard().getByRole('button', { name: '导出 KDBX', exact: true }).click();
    const download = await downloadEvent, exportedPath = info.outputPath('after-removal.kdbx'); await download.saveAs(exportedPath);
    const exported = await readFile(exportedPath);
    const opened = await openKeePassVault(exported, { password, keyFile, databaseId: Number(account.config.databaseId), providerId: account.id });
    const live = opened.items.filter(row => !row.deletedAt); expect(live).toHaveLength(1);
    expect(live[0].keepassEntryUuid).toBe(retained[0].keepassEntryUuid);
    expect((live[0] as LoginItem).password).toBe('original-synthetic-password-1');
    const removed = opened.items.filter(row => row.deletedAt);
    expect(removed.map(row => row.keepassEntryUuid)).toEqual([original.find(row => row.password.endsWith('-0'))!.keepassEntryUuid]);
    expect((removed[0] as LoginItem).password).toBe('original-synthetic-password-0');
    expect(opened.versionMajor).toBe(version); expect(opened.items.filter(row => row.deletedAt)).toHaveLength(1);
    for (const row of opened.items) {
      const entry = opened.entriesByUuid.get(row.keepassEntryUuid!)!;
      const attachment = entry.binaries.get('shared.bin'); expect(attachment).toBeTruthy();
      const value = attachment && 'hash' in attachment ? attachment.value : attachment!;
      expect('getBinary' in value).toBe(false);
      expect(hash(new Uint8Array(value as ArrayBuffer))).toBe(hash(Uint8Array.of(2, 4, 6, 8)));
      for (const field of ['Password', 'monica.content.credential']) {
        const value = entry.fields.get(field);
        expect(typeof value).toBe('object'); expect(value && typeof value !== 'string' && value.getText()).toBeTruthy();
      }
    }
    expect((live[0] as LoginItem).customFields.find(field => field.name === 'monica.content.credential')?.value).toContain('9007199254740993');
    expect(hash(await readFile(file))).toBe(hash(bytes));
    expect((await send<{ dirty: boolean }>(page, { type: 'KEEPASS_STATUS', providerId: account.id })).dirty).toBe(false);
    // Ordinary edits use the shared durable sync path after project removal.
    await page.getByRole('button', { name: /^全部项目/ }).click();
    await page.getByRole('button', { name: `查看${title}详情`, exact: true }).click();
    await dialogContent(page, { name: title, exact: true }).getByRole('button', { name: '编辑', exact: true }).click();
    const followup = dialogContent(page, { name: '编辑密码', exact: true });
    const laterNotes = 'Saved after removal · 中文';
    await followup.getByRole('button', { name: '笔记与恢复备注', exact: true }).click();
    const noteEditor = page.locator('.editor-content-dialog');
    await noteEditor.getByLabel('恢复备注与笔记', { exact: true }).fill(laterNotes);
    await noteEditor.getByRole('button', { name: '完成', exact: true }).click(); await expect(noteEditor).toHaveCount(0);
    await followup.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(followup).toHaveCount(0);
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await sourceCard().getByRole('button', { name: '立即同步', exact: true }).click();
    expect((await send<{ dirty: boolean }>(page, { type: 'KEEPASS_STATUS', providerId: account.id })).dirty).toBe(true);
    await sourceCard().getByRole('button', { name: '锁定', exact: true }).click();
    await expect(sourceCard().getByRole('button', { name: '立即同步', exact: true })).toBeDisabled();
    await sourceCard().getByRole('button', { name: '管理 KeePass', exact: true }).click();
    const otherFile = info.outputPath('externally-changed.kdbx'); await writeFile(otherFile, await buildKeePassFixture({ password, keyFile, version }));
    await open(true, otherFile, password, /所选文件已在外部修改/);
    await open(true, file, 'wrong synthetic password', /无法解锁|密码|InvalidKey/);
    // The previously exported version can identify the source; latest local notes win.
    await open(true, exportedPath);
    await sourceCard().getByRole('button', { name: '立即同步', exact: true }).click();
    expect((await list()).map(row => [row.id, row.notes])).toEqual([[savedId, laterNotes]]);
    const finalDownload = page.waitForEvent('download'); await sourceCard().getByRole('button', { name: '导出 KDBX', exact: true }).click();
    const finalPath = info.outputPath('after-followup.kdbx'); await (await finalDownload).saveAs(finalPath);
    const finalBytes = await readFile(finalPath);
    const finalVault = await openKeePassVault(finalBytes, { password, keyFile, databaseId: Number(account.config.databaseId), providerId: account.id });
    expect(finalVault.items.filter(row => !row.deletedAt).map(row => row.notes)).toEqual([laterNotes]);
    expect(hash(await readFile(file))).toBe(hash(bytes));
    evidence.followupExportSha256 = hash(finalBytes); evidence.wrongFileRejected = true; evidence.lockReopenVerified = true;
    evidence.exportSha256 = hash(exported); evidence.restartVerified = true; expect(errors).toEqual([]); evidence.status = 'passed';
  } finally { await context.close(); evidence.consoleErrors = errors; await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
});
