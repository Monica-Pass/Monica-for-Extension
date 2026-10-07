import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createLoginItem, type VaultItem } from '../../src/core/model';
import { createPasskey } from '../../src/passkey/webauthn-core';
import { buildKeePassFixture } from '../../src/providers/keepass/keepass-fixture';

const password = 'synthetic archive lifecycle master password';
const dbPassword = 'synthetic archive KDBX password';
const site = 'https://archive.example.test';
async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<T> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data as T;
}
async function launch(info: TestInfo) {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('p'), { locale: 'zh-CN', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const manager = await context.newPage();
  await manager.goto(`${origin}/index.html`);
  return { context, manager, origin };
}
interface ArchiveGate { release?: () => Promise<void>; restore: () => void; writes: number; }
async function holdUnarchive(page: Page) {
  await page.evaluate(() => {
    const target = window as unknown as { archiveGate: ArchiveGate };
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    target.archiveGate = { writes: 0, restore: () => { chrome.runtime.sendMessage = original; } };
    chrome.runtime.sendMessage = ((request: { type: string }) => {
      if (request.type !== 'VAULT_UNARCHIVE_ITEM') return original(request);
      target.archiveGate.writes++;
      return new Promise(resolve => { target.archiveGate.release = async () => { resolve(await original(request)); }; });
    }) as typeof chrome.runtime.sendMessage;
  });
}
async function releaseUnarchive(page: Page) {
  await page.evaluate(async () => {
    const gate = (window as unknown as { archiveGate: ArchiveGate }).archiveGate;
    gate.restore(); await gate.release!();
  });
}

test('archive actions reject stale edits and deletion, preserve selected-row scope and survive Edge restart', async ({}, info) => {
  const app = await launch(info);
  const row = { ...createLoginItem({ title: 'Archived account', password: 'old password', notes: 'old notes', uris: [site] }),
    passwordGroupId: 'explicit-project', archivedAt: '2026-01-01T00:00:00Z' };
  const sibling = { ...row, id: 'archived-sibling', title: 'Other archived member', password: 'sibling password' };
  try {
    await send(app.manager, { type: 'VAULT_SETUP', masterPassword: password });
    await send(app.manager, { type: 'VAULT_IMPORT_ITEMS', items: [row, sibling] });
    await app.manager.reload();
    await app.manager.locator('button.nav-item').filter({ hasText: '归档' }).click();
    const action = app.manager.getByRole('button', { name: '取消归档 Archived account', exact: true });
    await holdUnarchive(app.manager);
    await action.click();
    await expect(action).toBeDisabled();
    await action.evaluate(button => (button as HTMLButtonElement).click());
    expect(await app.manager.evaluate(() => (window as unknown as { archiveGate: ArchiveGate }).archiveGate.writes)).toBe(1);
    const current = await send<VaultItem>(app.manager, { type: 'VAULT_GET_ITEM', itemId: row.id });
    await send(app.manager, { type: 'VAULT_UPSERT_ITEM', item: { ...current, notes: 'Edited before unarchive arrived', password: 'new password' } });
    await releaseUnarchive(app.manager);
    await expect(app.manager.getByText('项目已变化，请刷新列表后重试。', { exact: true })).toBeVisible();
    await expect(action).toBeEnabled();
    expect(await send(app.manager, { type: 'VAULT_GET_ITEM', itemId: row.id })).toMatchObject({ archivedAt: row.archivedAt, password: 'new password' });
    await action.click();
    await expect(action).toHaveCount(0);
    expect(await send(app.manager, { type: 'VAULT_GET_ITEM', itemId: row.id })).toMatchObject({ password: 'new password', notes: 'Edited before unarchive arrived' });
    expect((await send<VaultItem>(app.manager, { type: 'VAULT_GET_ITEM', itemId: sibling.id })).archivedAt).toBe(row.archivedAt);

    // A later delete must not be undone by an already-dispatched unarchive action.
    await holdUnarchive(app.manager);
    await app.manager.getByRole('button', { name: '取消归档 Other archived member', exact: true }).click();
    await send(app.manager, { type: 'VAULT_DELETE_ITEM', itemId: sibling.id });
    await releaseUnarchive(app.manager);
    await expect.poll(async () => (await send<VaultItem[]>(app.manager, { type: 'VAULT_LIST_DELETED_ITEMS' })).map(item => item.id)).toContain(sibling.id);
    expect((await send<VaultItem[]>(app.manager, { type: 'VAULT_LIST_ITEMS' })).some(item => item.id === sibling.id)).toBe(false);
    const popup = await app.context.newPage();
    await popup.goto(`${app.origin}/popup.html`);
    const denied = await popup.evaluate(item => chrome.runtime.sendMessage({ type: 'VAULT_UNARCHIVE_ITEM', itemId: item.id, expectedUpdatedAt: item.updatedAt }), row);
    expect(denied).toMatchObject({ ok: false });
    expect(denied.error).toContain('管理页');
    await popup.close();
    await app.manager.screenshot({ path: info.outputPath('archive-stale-state.png') });
  } finally { await app.context.close(); }
  const reopened = await launch(info);
  try {
    await send(reopened.manager, { type: 'VAULT_UNLOCK', masterPassword: password });
    const restored = await send<VaultItem>(reopened.manager, { type: 'VAULT_GET_ITEM', itemId: row.id });
    expect(restored).toMatchObject({ password: 'new password', notes: 'Edited before unarchive arrived' });
    expect(restored.archivedAt).toBeUndefined();
    const deleted = await send<VaultItem[]>(reopened.manager, { type: 'VAULT_LIST_DELETED_ITEMS' });
    expect(deleted.map(item => item.id)).toContain(sibling.id);
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ status: 'passed', restored, deleted, staleRejected: true, popupDenied: true, restart: true }, null, 2));
  } finally { await reopened.context.close(); }
});

test('KeePass synchronization and encrypted reopen retain archived passwords and Passkeys outside candidates', async ({}, info) => {
  const credential = await createPasskey({ origin: site, challenge: Buffer.alloc(32, 3).toString('base64url'),
    rpId: 'archive.example.test', rpName: 'Archive fixture', userId: 'dGVzdA', userName: 'Synthetic',
    userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [], userVerified: true });
  const bytes = await buildKeePassFixture({ password: dbPassword, entries: [
    { title: 'KDBX archived login', fields: { UserName: 'synthetic', URL: site }, protectedFields: { Password: 'fixture password' } },
    { title: 'KDBX archived Passkey', fields: { URL: site, KPEX_PASSKEY_USERNAME: 'Synthetic', KPEX_PASSKEY_RELYING_PARTY: 'archive.example.test' },
      protectedFields: { KPEX_PASSKEY_PRIVATE_KEY_PEM: `-----BEGIN PRIVATE KEY-----\n${credential.privateKeyPkcs8}\n-----END PRIVATE KEY-----`,
        KPEX_PASSKEY_CREDENTIAL_ID: credential.credentialId, KPEX_PASSKEY_USER_HANDLE: 'dGVzdA' } }
  ] });
  const app = await launch(info);
  let providerId = '', exportedFile = '', archivedIds: string[] = [];
  try {
    await send(app.manager, { type: 'VAULT_SETUP', masterPassword: password });
    const opened = await send<{ account: { id: string } }>(app.manager, { type: 'KEEPASS_OPEN', input: { name: 'Archive fixture', fileName: 'archive.kdbx', file: Buffer.from(bytes).toString('base64'), password: dbPassword } });
    providerId = opened.account.id;
    await send(app.manager, { type: 'PROVIDER_SYNC', providerId });
    const items = await send<VaultItem[]>(app.manager, { type: 'VAULT_LIST_ITEMS' });
    expect(items.map(item => item.kind).sort()).toEqual(['login', 'passkey']);
    archivedIds = items.map(item => item.id);
    for (const item of items) await send(app.manager, { type: 'VAULT_UPSERT_ITEM', item: { ...item, archivedAt: '2026-01-01T00:00:00Z' }, expectedUpdatedAt: item.updatedAt });
    await send(app.manager, { type: 'PROVIDER_SYNC', providerId });
    expect((await send<VaultItem[]>(app.manager, { type: 'VAULT_LIST_ARCHIVED_ITEMS' })).map(item => item.id).sort()).toEqual([...archivedIds].sort());
    expect(await send(app.manager, { type: 'VAULT_MATCH_LOGINS', pageUrl: site })).toEqual([]);
    expect(await send(app.manager, { type: 'VAULT_MATCH_PASSKEYS', pageUrl: site })).toEqual([]);
    exportedFile = (await send<{ file: string }>(app.manager, { type: 'KEEPASS_EXPORT_FILE', providerId })).file;
    await writeFile(info.outputPath('archive.kdbx'), Buffer.from(exportedFile, 'base64'));
  } finally { await app.context.close(); }
  const reopened = await launch(info);
  try {
    await send(reopened.manager, { type: 'VAULT_UNLOCK', masterPassword: password });
    await send(reopened.manager, { type: 'KEEPASS_OPEN', input: { providerId, name: 'Archive fixture', fileName: 'archive.kdbx', file: exportedFile, password: dbPassword } });
    await send(reopened.manager, { type: 'PROVIDER_SYNC', providerId });
    const archived = await send<VaultItem[]>(reopened.manager, { type: 'VAULT_LIST_ARCHIVED_ITEMS' });
    expect(archived.map(item => item.id).sort()).toEqual([...archivedIds].sort());
    expect(await send(reopened.manager, { type: 'VAULT_MATCH_LOGINS', pageUrl: site })).toEqual([]);
    expect(await send(reopened.manager, { type: 'VAULT_MATCH_PASSKEYS', pageUrl: site })).toEqual([]);
    for (const item of archived) await send(reopened.manager, { type: 'VAULT_UNARCHIVE_ITEM', itemId: item.id, expectedUpdatedAt: item.updatedAt });
    await send(reopened.manager, { type: 'PROVIDER_SYNC', providerId });
    expect(await send(reopened.manager, { type: 'VAULT_LIST_ARCHIVED_ITEMS' })).toEqual([]);
    expect(await send<unknown[]>(reopened.manager, { type: 'VAULT_MATCH_LOGINS', pageUrl: site })).toHaveLength(1);
    expect(await send<unknown[]>(reopened.manager, { type: 'VAULT_MATCH_PASSKEYS', pageUrl: site })).toHaveLength(1);
    const passkey = (await send<VaultItem[]>(reopened.manager, { type: 'VAULT_LIST_ITEMS' })).find(item => item.kind === 'passkey');
    expect(passkey).toMatchObject({ credentialId: credential.credentialId, privateKeyPkcs8: credential.privateKeyPkcs8, signCount: 0 });
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ status: 'passed', providerId, archivedIds, candidatesExcludedWhileArchived: true, candidatesRestoredAfterUnarchive: true, encryptedFileReopened: true, restart: true }, null, 2));
  } finally { await reopened.context.close(); }
});
