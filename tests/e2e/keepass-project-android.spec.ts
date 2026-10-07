import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent } from './fixtures/material';
import { groupedPasswords } from '../../src/core/password-groups';
import { readProjectCredential } from '../../src/core/project-credentials';
import type { LoginItem } from '../../src/core/model';

const master = 'Synthetic KDBX browser master password', databasePassword = 'Synthetic transfer fixture password';
const root = process.env.MONICA_KEEPASS_PROJECT_ANDROID;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function send<T = unknown>(page: Page, input: Record<string, unknown>): Promise<T> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), input);
  expect(response.ok, response.error).toBe(true); return response.data as T;
}
async function launch(info: TestInfo, profile = 'profile') {
  const extension = path.resolve('dist'), context = await launchEdgeContext(info.outputPath(profile), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  page.setDefaultTimeout(15_000);
  return { context, page };
}
test('Android native KDBX project -> Edge grouped edit/add/cancel -> file and fresh browser', async ({}, info) => {
  test.skip(!root, 'Requires an exact Android writer fixture and source/APK proof');
  test.setTimeout(120_000);
  const fixture = path.resolve(root!), bytes = await readFile(path.join(fixture, 'android-keepass-project.kdbx'));
  const android = JSON.parse(await readFile(path.join(fixture, 'android-keepass-project.json'), 'utf8'));
  const device = JSON.parse(await readFile(path.join(fixture, 'keepass-project-export-evidence.json'), 'utf8'));
  const build = JSON.parse(await readFile(path.join(fixture, 'build-evidence.json'), 'utf8'));
  expect(build.status).toBe('passed'); expect(device.androidSourcesUnchanged).toBe(true);
  expect(device.installedApkSha256).toBe(build.builtAppApkSha256);
  expect(device.outputs.find((entry: { name: string }) => entry.name === 'android-keepass-project.kdbx').sha256).toBe(hash(bytes));
  expect(android.originalFilterRestored).toBe(true);
  // Preserve this failed Android parity result; browser success does not turn it into a pass.
  expect(android.projectIdentityPreserved).toBe(false); expect(android.afterProjectCount).toBe(4);
  const properties = ['username', 'password', 'notes', 'email', 'phone', 'addressLine', 'city', 'state', 'zipCode', 'country', 'creditCardNumber', 'creditCardHolder', 'creditCardExpiry', 'creditCardCVV', 'appPackageName', 'appName'] as const;
  let app = await launch(info), providerId = '', exported = '', expected: LoginItem[] = [];
  try {
    await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    providerId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_OPEN', input: { name: 'Android KDBX project', fileName: 'android.kdbx', file: bytes.toString('base64'), password: databasePassword } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const initial = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' });
    expect(groupedPasswords(initial).map(rows => rows.length).sort()).toEqual([1, 3]);
    for (const actual of initial) {
      const source = android.before.find((row: { password: string }) => row.password === actual.password);
      expect(source).toBeTruthy();
      for (const key of properties) expect(actual[key], `${actual.password}: ${key}`).toBe(source[key]);
      const sourceMetadata = source.fields.find((field: { title: string }) => field.title === 'monica.content.credential');
      // The independent legacy singleton has a Room-only group ID, absent from its KDBX.
      expect(actual.passwordGroupId ?? null).toBe(sourceMetadata ? source.projectId : null);
      for (const field of source.fields) {
        const found = actual.customFields.find(row => row.name === field.title)!;
        expect(found?.value).toBe(field.value); expect(Boolean(found?.protected)).toBe(field.isProtected);
      }
    }
    const project = groupedPasswords(initial).find(rows => rows.length === 3)!;
    const independent = initial.find(row => !row.passwordGroupId)!;
    await app.page.reload();
    await app.page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    // The same-title control remains separate; the project action advertises its three passwords.
    await app.page.locator('tr.row-clickable').filter({ hasText: /3\s*条密码/ }).getByRole('button', { name: `查看${project[0].title}详情`, exact: true }).click();
    await dialogContent(app.page, { name: new RegExp(project[0].title) }).getByRole('button', { name: '编辑', exact: true }).click();
    let editor = dialogContent(app.page, { name: '编辑密码', exact: true }), groups = editor.locator('[data-credential-group]');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).getByLabel('密码 2', { exact: true })).toHaveValue('second-password');
    await groups.nth(0).getByLabel('用户名', { exact: true }).fill('edge-primary');
    await editor.getByLabel('名称 *', { exact: true }).fill('Edited KDBX project');
    await groups.nth(0).getByRole('button', { name: '添加密码', exact: true }).click();
    await groups.nth(0).getByLabel('密码 3', { exact: true }).fill('edge-added-password');
    await editor.getByRole('button', { name: '添加凭据组', exact: true }).click();
    await expect(groups).toHaveCount(3);
    await groups.nth(2).getByLabel('凭据组名称', { exact: true }).fill('Edge recovery');
    await groups.nth(2).getByLabel('用户名', { exact: true }).fill('edge-recovery');
    await groups.nth(2).getByLabel('密码 1', { exact: true }).fill('edge-recovery-password');
    await app.page.setViewportSize({ width: 320, height: 950 });
    await groups.nth(2).scrollIntoViewIfNeeded();
    expect(await groups.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await app.page.screenshot({ path: info.outputPath('kdbx-project-edit-320.png') });
    await editor.getByRole('button', { name: '加密保存', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    expected = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' });
    expect(groupedPasswords(expected).map(rows => rows.length).sort()).toEqual([1, 5]);
    expect(expected.find(row => row.id === independent.id)).toEqual(independent);
    for (const original of project) {
      const actual = expected.find(row => row.id === original.id)!;
      expect(actual.customFields).toEqual(original.customFields); expect(actual.password).toBe(original.password);
      for (const key of properties.filter(key => key !== 'username')) expect(actual[key]).toBe(original[key]);
    }
    expect(expected.filter(row => row.username === 'edge-primary')).toHaveLength(3);
    await app.page.setViewportSize({ width: 1180, height: 950 }); await app.page.reload();
    await app.page.getByRole('button', { name: '查看Edited KDBX project详情', exact: true }).click();
    await dialogContent(app.page, { name: 'Edited KDBX project' }).getByRole('button', { name: '编辑', exact: true }).click();
    editor = dialogContent(app.page, { name: '编辑密码', exact: true });
    await editor.locator('[data-credential-group]').first().getByLabel('用户名', { exact: true }).fill('cancelled');
    await editor.getByRole('button', { name: '取消', exact: true }).click(); await expect(editor).toHaveCount(0);
    expect(await send(app.page, { type: 'VAULT_LIST_ITEMS' })).toEqual(expected);
    exported = (await send<{ file: string }>(app.page, { type: 'KEEPASS_EXPORT_FILE', providerId })).file;
    await writeFile(info.outputPath('edge-return.kdbx'), Buffer.from(exported, 'base64'));
  } finally { await app.context.close(); }
  app = await launch(info);
  try {
    await send(app.page, { type: 'VAULT_UNLOCK', masterPassword: master });
    await send(app.page, { type: 'KEEPASS_OPEN', input: { providerId, name: 'Android KDBX project', fileName: 'returned.kdbx', file: exported, password: databasePassword } });
    await send(app.page, { type: 'PROVIDER_SYNC', providerId });
    const restored = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' });
    for (const old of expected) {
      const actual = restored.find(row => row.id === old.id)!;
      expect(actual.keepassEntryUuid).toBe(old.keepassEntryUuid);
      expect(actual.keepassEntryUuid).toBeTruthy();
      const content = ({ createdAt, updatedAt, totpSecret, ...row }: LoginItem) => ({ ...row, totpSecret: totpSecret || undefined });
      expect(content(actual)).toEqual(content(old));
      // KDBX4 timestamps have whole-second precision. No content change is allowed.
      expect(Date.parse(actual.createdAt)).toBe(Math.floor(Date.parse(old.createdAt) / 1000) * 1000);
      expect(Date.parse(actual.updatedAt)).toBe(Math.floor(Date.parse(old.updatedAt) / 1000) * 1000);
    }
    expected = restored;
  } finally { await app.context.close(); }
  // Another profile imports only the encrypted KDBX, without the first profile's local grouping.
  app = await launch(info, 'fresh-profile');
  try {
    await send(app.page, { type: 'VAULT_SETUP', masterPassword: master });
    const freshId = (await send<{ account: { id: string } }>(app.page, { type: 'KEEPASS_OPEN', input: { name: 'Fresh KDBX', fileName: 'returned.kdbx', file: exported, password: databasePassword } })).account.id;
    await send(app.page, { type: 'PROVIDER_SYNC', providerId: freshId });
    const fresh = await send<LoginItem[]>(app.page, { type: 'VAULT_LIST_ITEMS' });
    expect(groupedPasswords(fresh).map(rows => rows.length).sort()).toEqual([1, 5]);
    for (const original of expected) {
      const row = fresh.find(item => item.keepassEntryUuid === original.keepassEntryUuid)!;
      expect(row.password).toBe(original.password); expect(row.customFields).toEqual(original.customFields);
      expect(row.passwordGroupId).toBe(original.passwordGroupId);
      expect(readProjectCredential(row.customFields)).toEqual(readProjectCredential(original.customFields));
    }
    await app.page.reload(); await app.page.locator('button.nav-item').filter({ hasText: '登录项' }).click();
    await app.page.screenshot({ path: info.outputPath('kdbx-project-fresh.png') });
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ status: 'passed', androidApkSha256: device.installedApkSha256,
      androidFixtureSha256: hash(bytes), returnSha256: hash(Buffer.from(exported, 'base64')), initialProjects: 2, finalProjects: 2,
      androidFreshImportProjectIdentityPreserved: false, browserFullRestart: true, freshBrowserFileImport: true, expected }, null, 2));
  } finally { await app.context.close(); }
});
