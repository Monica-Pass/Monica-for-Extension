import { expect, test, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';
import { dialogContent, chooseOption } from './fixtures/material';
import type { LoginItem, ProviderAccount } from '../../src/core/model';

const fixtureRoot = process.env.MONICA_PROJECT_FIELDS_FIXTURE;
const returnPhase = process.env.MONICA_PROJECT_FIELDS_PHASE === 'return';
const master = 'Synthetic browser project fields password';
const databasePassword = 'Synthetic transfer fixture password';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Row = { entryId: string; title: string; payload: Record<string, any> };
const orderedRows = (rows: Row[]) => [...rows].sort((a,b) => a.entryId.localeCompare(b.entryId));
async function send<T = any>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}

test('current Android rich project crosses actual Edge native edit and restart', async ({}, info) => {
  test.skip(!fixtureRoot, 'Requires the current Android writer/return artifact and provenance');
  test.setTimeout(120_000);
  const fixture = path.resolve(fixtureRoot!);
  const stage = returnPhase ? 'project-fields-import' : 'project-fields-export';
  const proof = JSON.parse(await readFile(path.join(fixture, `${stage}-evidence.json`), 'utf8'));
  const build = JSON.parse(await readFile(path.join(fixture, 'build-evidence.json'), 'utf8'));
  expect(proof.status).toBe('passed'); expect(build.status).toBe('passed');
  expect(proof.androidSourcesUnchanged).toBe(true); expect(proof.testSourcesUnchanged).toBe(true);
  const runtimeBytes = await readFile(path.join(fixture, 'runtime-evidence.json'));
  const runtime = JSON.parse(runtimeBytes.toString('utf8'));
  expect(runtime.status).toBe('passed'); expect(runtime.productionSourceUnmodified).toBe(true);
  expect(hash(runtimeBytes)).toBe(proof.runtimeEvidence.sha256);
  expect(hash(await readFile(path.join(fixture, 'build-evidence.json')))).toBe(runtime.buildEvidenceSha256);
  expect(proof.installedApkSha256).toBe(runtime.runtimeApkSha256);
  expect(proof.baseline.revision).toBe(runtime.runtimeRevision);
  expect(runtime.compileApkSha256).toBe(build.builtAppApkSha256);
  expect(proof.installedTestApkSha256).toBe(build.builtTestApkSha256);
  expect(proof.installedApplicationUnchanged).toBe(true); expect(proof.installedTestApkUnchanged).toBe(true);
  const name = returnPhase ? 'android-project-fields-return.mdbx' : 'android-project-fields.mdbx';
  const source = path.join(fixture, name), inputBytes = await readFile(source);
  expect(hash(inputBytes)).toBe(proof.outputs.find((file: {name:string}) => file.name === name).sha256);
  const sourceData = JSON.parse(await readFile(path.join(fixture, returnPhase ? 'android-project-fields-return.json' : 'android-project-fields.json'), 'utf8'));
  expect(sourceData.status).toBe('passed'); expect(sourceData.synthetic).toBe(true);
  const sourceRows: Row[] = returnPhase ? sourceData.after : sourceData.rows;
  if (returnPhase) {
    const forward = JSON.parse(await readFile(path.join(fixture, 'edge-project-fields-expected.json'), 'utf8'));
    expect(forward.synthetic).toBe(true);
    expect(orderedRows(sourceData.before)).toEqual(orderedRows(forward.rows));
    expect(proof.inputs.find((file: {name:string}) => file.name === 'edge-project-fields.mdbx').sha256)
      .toBe(hash(await readFile(path.join(fixture, 'edge-project-fields.mdbx'))));
  }
  const runRoot = path.resolve('.tmp', `project-fields-native-${randomUUID().slice(0, 12)}`);
  const localAppData = path.join(runRoot, 'local-app-data'); await mkdir(localAppData, { recursive: true });
  const options = { locale: 'zh-CN', colorScheme: 'dark' as const, reducedMotion: 'reduce' as const,
    viewport: { width: 1180, height: 950 }, env: { ...process.env, LOCALAPPDATA: localAppData },
    args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };
  const profile = info.outputPath('profile');
  let context = await launchEdgeContext(profile, options);
  let host: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const evidence: Record<string, any> = { status: 'failed', phase: returnPhase ? 'return' : 'forward', source, inputSha256: hash(inputBytes), runRoot };
  const errors: string[] = [];
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host, url = `chrome-extension://${extensionId}/index.html`;
    host = await temporaryNativeHost(extensionId, info.outputPath('native'));
    let page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
    await send(page, { type: 'VAULT_SETUP', masterPassword: master });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
    const connect = page.locator('.mdbx2-dialog[role="dialog"]');
    await connect.getByLabel('显示名称', { exact: true }).fill('Current Android project');
    await chooseOption(connect.locator('m3e-select').first(), 'local');
    await connect.getByLabel('MDBX2 可移植备份', { exact: true }).setInputFiles(source);
    await connect.getByLabel('保险库密码（可留空）', { exact: true }).fill(databasePassword);
    await connect.getByRole('button', { name: '验证、解锁并导入', exact: true }).click();
    await expect(connect).toHaveCount(0, { timeout: 60000 });
    const provider = (await send<ProviderAccount[]>(page, { type: 'PROVIDER_LIST' })).find(row => row.name === 'Current Android project')!;
    expect(provider.kind).toBe('mdbx2');
    const list = async () => (await send<LoginItem[]>(page, { type: 'VAULT_LIST_ITEMS' })).filter(item => item.providerRefs.some(ref => ref.providerId === provider.id));
    const nativeRows = async (): Promise<Row[]> => Promise.all((await list()).map(async item => {
      const native = await send(page, { type: 'MDBX2_OBJECT_REVEAL', providerId: provider.id, objectId: item.providerRefs.find(ref => ref.providerId === provider.id)!.remoteId });
      const payload = JSON.parse(native.payloadJson);
      return { entryId: payload.monica_entry_id, title: native.title, payload };
    }));
    const equalRows = (actual: Row[], expected: Row[]) => expect(orderedRows(actual)).toEqual(orderedRows(expected));
    equalRows(await nativeRows(), sourceRows);
    const before = await list(); expect(before).toHaveLength(3);
    expect(new Set(before.map(item => item.passwordGroupId)).size).toBe(1);
    expect(before[0].passwordGroupId).toBeTruthy();
    if (!returnPhase) for (const item of before) expect(item).toMatchObject({
      title: 'Current rich password project', notes: '  Recovery notes\r\n中文\tretained  ',
      email: 'synthetic@example.invalid', phone: '00001', addressLine: '  街道 12\nUnit 007  ', city: 'City 字', state: 'State', zipCode: '00007', country: 'CN',
      creditCardNumber: '00001234', creditCardHolder: '  ALICE  ', creditCardExpiry: '09/30', creditCardCVV: '007', appName: '合成应用', appPackageName: 'invalid.synthetic.app'
    });
    await page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await page.getByRole('button', { name: '查看Current rich password project详情', exact: true }).click();
    await dialogContent(page, { name: /Current rich password project/ }).getByRole('button', { name: '编辑', exact: true }).click();
    const editor = dialogContent(page, { name: '编辑密码', exact: true });
    const groups = editor.locator('[data-credential-group]'); await expect(groups).toHaveCount(2);
    await expect(groups.first().getByLabel('用户名', { exact: true })).toHaveValue(returnPhase ? 'android-return-user' : 'android-primary-user');
    let expectedRows = sourceRows;
    if (!returnPhase) {
      const primary = before.find(item => item.password === 'first-synthetic-password')!;
      const index = primary.customFields.findIndex(field => field.name === 'Recovery'); expect(index).toBeGreaterThanOrEqual(0);
      await groups.first().getByLabel('用户名', { exact: true }).fill('edge-primary-user');
      await editor.locator('[slot="header"]').filter({ hasText: '个人信息' }).click();
      await editor.getByLabel('邮箱', { exact: true }).fill('');
      await editor.getByLabel(`自定义字段 ${index + 1} 值`, { exact: true }).fill('  edge custom value  ');
      await editor.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(editor).toHaveCount(0);
      await send(page, { type: 'PROVIDER_SYNC', providerId: provider.id });
      expectedRows = structuredClone(sourceRows);
      for (const row of expectedRows) {
        row.payload.email = '';
        if (row.payload.username === 'android-primary-user') row.payload.username = 'edge-primary-user';
        if (row.payload.password_plain === 'first-synthetic-password') row.payload.custom_fields.find((field: any) => field.title === 'Recovery').value = '  edge custom value  ';
      }
      equalRows(await nativeRows(), expectedRows);
    } else {
      await page.setViewportSize({ width: 320, height: 950 });
      await groups.first().scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('android-return-project-320.png') });
      await editor.getByRole('button', { name: '取消', exact: true }).click();
    }
    const saved = await list(); evidence.saved = saved;
    await context.close(); context = await launchEdgeContext(profile, options);
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(url);
    await page.getByLabel('主密码', { exact: true }).fill(master);
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await page.getByRole('heading', { name: '全部项目', exact: true }).waitFor();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator(`[data-home-provider-id="${provider.id}"]`).getByRole('button', { name: '解锁并设置', exact: true }).click();
    const reopen = page.locator('.mdbx2-dialog[role="dialog"]');
    await reopen.getByLabel('保险库密码（可留空）', { exact: true }).fill(databasePassword);
    await reopen.getByRole('button', { name: '解锁本机副本', exact: true }).click();
    await reopen.getByRole('button', { name: '解锁本机副本', exact: true }).waitFor({ state: 'hidden' });
    await reopen.getByRole('button', { name: '取消', exact: true }).click();
    await send(page, { type: 'PROVIDER_SYNC', providerId: provider.id });
    equalRows(await nativeRows(), expectedRows); evidence.restartVerified = true;
    if (!returnPhase) {
      const download = await send(page, { type: 'MDBX2_FILE_EXPORT_BEGIN', providerId: provider.id });
      const chunks: Buffer[] = [];
      try { for (let offset = 0; offset < download.sizeBytes;) {
        const chunk = await send(page, { type: 'MDBX2_FILE_EXPORT_READ', providerId: provider.id, downloadHandle: download.downloadHandle, offset });
        expect(chunk.nextOffset).toBeGreaterThan(offset); chunks.push(Buffer.from(chunk.dataBase64, 'base64')); offset = chunk.nextOffset;
      } } finally { await send(page, { type: 'MDBX2_FILE_EXPORT_RELEASE', providerId: provider.id, downloadHandle: download.downloadHandle }); }
      const bytes = Buffer.concat(chunks); expect(hash(bytes)).toBe(download.sha256);
      await writeFile(path.join(fixture, 'edge-project-fields.mdbx'), bytes); evidence.exportSha256 = hash(bytes);
      await writeFile(path.join(fixture, 'edge-project-fields-expected.json'), JSON.stringify({ synthetic: true, rows: expectedRows }, null, 2));
    }
    expect(hash(await readFile(source))).toBe(hash(inputBytes)); expect(errors).toEqual([]);
    evidence.status = 'passed';
  } finally {
    await context.close();
    if (host) { await host.restore(); evidence.nativeHost = host.evidence; }
    evidence.consoleErrors = errors;
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
