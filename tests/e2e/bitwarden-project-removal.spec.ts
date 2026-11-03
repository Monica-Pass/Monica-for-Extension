import { expect, test, type Page, type Route } from '@playwright/test';
import { createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { saveBitwardenNativeSnapshot } from './fixtures/bitwarden-native-snapshot';
import { dialogContent } from './fixtures/material';
import { createLoginItem, type LoginItem, type PasskeyItem } from '../../src/core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../src/core/project-credentials';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { encodeBitwardenCipher, encodeBitwardenPasskeyCipher, decodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, encryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';
import { createPasskey } from '../../src/passkey/webauthn-core';

const HOST = 'https://removal.example.test', EMAIL = 'synthetic@example.test', PASSWORD = 'Synthetic Bitwarden password';
const DATE = '2026-10-09T12:00:00.000Z';
async function server(loseCreate: boolean, withFolder = false) {
  const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  const folderId = 'synthetic-passkey-folder', folderName = '跨端 / Passkeys';
  const folders = withFolder ? [{id: folderId, name: await encryptBitwardenString(folderName, key)}] : [];
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(PASSWORD, EMAIL, {type: 0, iterations: 10_000}));
  const protectedKey = await new BitwardenClient().protectVaultKey(key, stretched, new Uint8Array(16));
  const rows: Record<string, any>[] = [], originals: PasskeyItem[] = [], events: string[] = [];
  const projectId = crypto.randomUUID();
  for (let index = 0; index < 2; index++) {
    const login: LoginItem = { ...createLoginItem({ title: 'Synthetic removal project', username: `synthetic-${index}`, password: `synthetic-${index}` }),
      passwordGroupId: projectId, customFields: [{name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({
        version: 1, projectId, groupId: crypto.randomUUID(), passwordId: crypto.randomUUID(), label: `Group ${index}`, primary: index === 0, groupOrder: index, passwordOrder: 0 })}] };
    const row: Record<string, any> = {...await encodeBitwardenCipher(login, key), id: `source-${index}`, revisionDate: DATE, creationDate: DATE};
    if (index) {
      row.login.fido2Credentials = [];
      for (const count of [0, 23]) {
        const generated = await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, count + 1).toString('base64url'),
          rpName: 'Synthetic RP', userId: 'c3ludGhldGlj', userName: 'Synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] });
        const item: PasskeyItem = { id: crypto.randomUUID(), kind: 'passkey', title: 'Synthetic RP', favorite: false, notes: '', createdAt: DATE, updatedAt: DATE,
          providerRefs: [], credentialId: generated.credentialId, rpId: 'example.test', rpName: 'Synthetic RP', userHandle: 'c3ludGhldGlj', userName: 'Synthetic', userDisplayName: 'Synthetic',
          algorithm: -7, publicKey: generated.publicKeySpki, privateKeyPkcs8: generated.privateKeyPkcs8, signCount: count, discoverable: true, sourceMode: 'bitwarden' };
        originals.push(item);
        const encoded = await encodeBitwardenPasskeyCipher(item, key);
        row.login.fido2Credentials.push(...((encoded.login as Record<string, unknown>).fido2Credentials as Record<string, unknown>[]));
      }
    }
    if (withFolder) row.folderId = folderId;
    rows.push(row);
  }
  let revision = 1;
  const hooks: {afterDelete?: () => Promise<void>; afterCopy?: () => Promise<void>; hideCopies?: boolean} = {};
  const stamp = () => new Date(Date.parse(DATE) + revision++ * 1000).toISOString();
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  return { rows, originals, events, key, hooks, folderId, folderName, route: async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.pathname === '/identity/accounts/prelogin/password') return json(route, {Kdf: 0, KdfIterations: 10_000});
    if (url.pathname === '/identity/connect/token') return json(route, {access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, Key: protectedKey});
    if (url.pathname === '/api/sync') { events.push('sync'); return json(route, {Profile: {Id: 'synthetic-user'}, Folders: folders, Ciphers: hooks.hideCopies ? rows.filter(row => row.id.startsWith('source-')) : rows}); }
    if (url.pathname === '/api/ciphers' && method === 'POST') {
      const row = {...request.postDataJSON(), id: crypto.randomUUID(), revisionDate: stamp(), creationDate: DATE}; rows.push(row); events.push('copy');
      await hooks.afterCopy?.();
      if (loseCreate) { loseCreate = false; return route.abort('connectionreset'); }
      return json(route, row);
    }
    const match = url.pathname.match(/^\/api\/ciphers\/([^/]+)(?:\/(details|delete|restore))?$/);
    if (match) {
      const row = rows.find(row => row.id === match[1]);
      if (!row) return json(route, {}, 404);
      if (method === 'GET') return json(route, row);
      if (method === 'PUT' && match[2] === 'delete') { row.deletedDate = stamp(); row.revisionDate = row.deletedDate; events.push('delete'); await hooks.afterDelete?.(); return route.fulfill({status: 204}); }
      if (method === 'PUT' && match[2] === 'restore') { row.deletedDate = null; row.revisionDate = stamp(); events.push('restore'); return json(route, row); }
      if (method === 'PUT' && !match[2]) { Object.assign(row, request.postDataJSON(), {revisionDate: stamp()}); events.push('update'); return json(route, row); }
    }
    events.push(`unexpected:${method}:${url.pathname}`); return route.abort('failed');
  }};
}
async function send(page: Page, request: object): Promise<any> {
  const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(response.ok, response.error).toBe(true); return response.data;
}

for (const mode of ['copy-reply', 'lost-reply', 'unknown-then-found'] as const) test(`Bitwarden preparation recovery keeps edits and reconciles ${mode} without deleting sources`, async ({}, info) => {
  const mock = await server(mode !== 'copy-reply', true), extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {locale: 'zh-CN', reducedMotion: 'reduce', viewport: {width: 1180, height: 950},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  try {
    await context.route(`${HOST}/**`, mock.route);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, {type: 'VAULT_SETUP', masterPassword: 'Synthetic preparation recovery password'});
    await page.evaluate(() => chrome.storage.local.set({'monica.sync.preferences.v1': {enabled: false}}));
    const {providerId} = await send(page, {type: 'BITWARDEN_LOGIN', name: 'Synthetic Bitwarden', vaultUrl: HOST, email: EMAIL, masterPassword: PASSWORD, isDefaultSaveTarget: false});
    await send(page, {type: 'PROVIDER_SYNC', providerId});
    expect(await send(page, {type: 'PROVIDER_QUEUE_STATUS'})).toContainEqual(expect.objectContaining({providerId, pending: 0, failed: 0, recovering: 0}));
    const before: Array<LoginItem | PasskeyItem> = await send(page, {type: 'VAULT_LIST_ITEMS'});
    const passwords = before.filter((row): row is LoginItem => row.kind === 'login' && Boolean(row.passwordGroupId));
    const source = passwords.find(row => row.providerRefs[0].remoteId === 'source-1')!, target = passwords.find(row => row !== source)!;
    const editedPassword = 'synthetic-preparation-local-password';
    mock.hooks.afterCopy = async () => {
      if (mode === 'unknown-then-found') mock.hooks.hideCopies = true;
      await send(page, {type: 'VAULT_UPSERT_ITEM', item: {...target, password: editedPassword}});
    };
    const operationId = crypto.randomUUID();
    const response = await page.evaluate(input => chrome.runtime.sendMessage(input), {type: 'VAULT_PASSWORD_PROJECT_REMOVE', confirmed: true,
      input: {operationId, items: passwords, expected: Object.fromEntries(passwords.map(row => [row.id, row.updatedAt])), removedItemIds: [source.id]}});
    expect(response.ok).toBe(mode !== 'unknown-then-found');
    await page.reload(); await page.getByRole('button', {name: '密码源', exact: true}).click();
    await expect(page.locator('.bitwarden-provider-card')).not.toContainText('队列状态不可用');
    if (mode === 'unknown-then-found') {
      const pending = page.locator(`[data-removal-operation="${operationId}"]`);
      await expect(pending).toContainText('正在核对操作结果');
      await expect(pending.locator('[data-removal-cancel]')).toHaveCount(0);
      expect(await send(page, {type: 'PROVIDER_QUEUE_STATUS'})).toContainEqual(expect.objectContaining({providerId, recovering: 1}));
      await page.setViewportSize({width: 320, height: 950});
      await pending.screenshot({path: info.outputPath('preparation-recovery-320.png')});
      expect(mock.events.filter(row => row === 'copy')).toHaveLength(1);
      mock.hooks.hideCopies = false;
      await pending.locator('[data-removal-resume]').click();
      await expect(pending).toHaveCount(0);
    }
    const recovered = await send(page, {type: 'VAULT_LIST_ITEMS'});
    const recoveredCopies = recovered.filter((row: LoginItem | PasskeyItem) => !before.some(original => original.id === row.id));
    expect(recoveredCopies).toHaveLength(2);
    for (const row of recoveredCopies) {
      expect(row.categoryName).toBe(mock.folderName);
      expect(row.providerRefs).toContainEqual(expect.objectContaining({providerId, remoteFolderId: mock.folderId}));
    }
    const conflict = page.locator('.bitwarden-conflict-group');
    await expect(conflict).toContainText('本地与远端版本均已保留');
    await expect(conflict).not.toContainText(editedPassword);
    await conflict.getByRole('button', {name: '保留浏览器版本', exact: true}).click();
    await dialogContent(page, {name: '保留浏览器版本？', exact: true}).getByRole('button', {name: '确认保留浏览器版本', exact: true}).click();
    await expect(conflict).toHaveCount(0);
    await send(page, {type: 'PROVIDER_SYNC', providerId}); await send(page, {type: 'PROVIDER_SYNC', providerId});
    const rows: Array<LoginItem | PasskeyItem> = await send(page, {type: 'VAULT_LIST_ITEMS'});
    expect(rows.find(row => row.id === target.id)).toMatchObject({password: editedPassword});
    expect(rows.find(row => row.id === source.id)?.deletedAt).toBeUndefined();
    for (const original of before.filter((row): row is PasskeyItem => row.kind === 'passkey')) {
      expect(rows.find(row => row.id === original.id)).toMatchObject({credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, signCount: original.signCount});
    }
    const native = (await decodeBitwardenCipher(mock.rows.find(row => row.id === 'source-0')!, providerId, mock.key)).items.find(row => row.kind === 'login');
    expect(native).toMatchObject({password: editedPassword});
    let signatures = 0;
    for (const cipher of mock.rows) for (const item of (await decodeBitwardenCipher(cipher, providerId, mock.key)).items) {
      if (item.kind !== 'passkey') continue;
      const original = mock.originals.find(row => row.credentialId === item.credentialId)!;
      expect(item.signCount).toBe(original.signCount);
      const key = await crypto.subtle.importKey('pkcs8', Buffer.from(item.privateKeyPkcs8!, 'base64'), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
      const data = Buffer.from('preparation recovery independent signature');
      const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, data);
      expect(verify('sha256', data, {key: createPublicKey({key: Buffer.from(original.publicKey, 'base64'), format: 'der', type: 'spki'}), dsaEncoding: 'ieee-p1363'}, Buffer.from(signature))).toBe(true);
      signatures++;
    }
    expect(signatures).toBe(3);
    expect(mock.events.filter(row => row === 'copy')).toHaveLength(1);
    expect(mock.events.filter(row => row === 'delete' || row === 'restore')).toHaveLength(0);
    expect(mock.rows.every(row => !row.deletedDate)).toBe(true);
    await page.reload();
    if (mode === 'unknown-then-found') await page.getByRole('button', {name: '打开导航', exact: true}).click();
    await page.getByRole('button', {name: '密码源', exact: true}).click();
    await expect(page.locator('.bitwarden-provider-card')).toContainText('没有待处理操作');
    await expect(page.locator('.bitwarden-provider-card')).not.toContainText('队列状态不可用');
  } finally { await context.close(); }
});

for (const resolution of ['keep-local', 'use-remote'] as const) test(`Bitwarden removal preserves a concurrent edit and resolves ${resolution} through the real manager`, async ({}, info) => {
  const mock = await server(false), extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), {locale: 'zh-CN', reducedMotion: 'reduce', viewport: {width: 1180, height: 950},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
  try {
    await context.route(`${HOST}/**`, mock.route);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, {type: 'VAULT_SETUP', masterPassword: 'Synthetic local recovery password'});
    await page.evaluate(() => chrome.storage.local.set({'monica.sync.preferences.v1': {enabled: false}}));
    const {providerId} = await send(page, {type: 'BITWARDEN_LOGIN', name: 'Synthetic Bitwarden', vaultUrl: HOST, email: EMAIL, masterPassword: PASSWORD, isDefaultSaveTarget: false});
    await send(page, {type: 'PROVIDER_SYNC', providerId});
    const before: Array<LoginItem | PasskeyItem> = await send(page, {type: 'VAULT_LIST_ITEMS'});
    const passwords = before.filter((row): row is LoginItem => row.kind === 'login' && Boolean(row.passwordGroupId));
    const source = passwords.find(row => row.providerRefs[0].remoteId === 'source-1')!, target = passwords.find(row => row !== source)!;
    const newerPassword = 'synthetic-concurrent-password';
    mock.hooks.afterDelete = async () => {await send(page, {type: 'VAULT_UPSERT_ITEM', item: {...target, password: newerPassword}});};
    const operationId = crypto.randomUUID();
    const result = await send(page, {type: 'VAULT_PASSWORD_PROJECT_REMOVE', confirmed: true, input: {operationId, items: passwords,
      expected: Object.fromEntries(passwords.map(row => [row.id, row.updatedAt])), removedItemIds: [source.id]}});
    expect(result.status).toBe('cancelled');
    expect(mock.events.filter(event => event === 'copy')).toHaveLength(2);
    expect(mock.events.filter(event => event === 'delete')).toHaveLength(1);
    expect(mock.events.filter(event => event === 'restore')).toHaveLength(1);
    expect(mock.rows.find(row => row.id === 'source-1')?.deletedDate).toBeNull();
    expect(await send(page, {type: 'PROVIDER_CONFLICT_LIST', providerId})).toHaveLength(1);
    await page.reload(); await page.getByRole('button', {name: '密码源', exact: true}).click();
    const conflict = page.locator('.bitwarden-conflict-group');
    await expect(conflict).toContainText('本地与远端版本均已保留');
    await expect(page.locator(`[data-removal-operation="${operationId}"]`)).toHaveCount(0);
    await expect(conflict).not.toContainText(newerPassword);
    await page.setViewportSize({width: 320, height: 950});
    await conflict.screenshot({path: info.outputPath('local-edit-conflict-320.png')});
    await conflict.getByRole('button', {name: resolution === 'keep-local' ? '保留浏览器版本' : '采用 Bitwarden 版本', exact: true}).click();
    const confirm = dialogContent(page, {name: resolution === 'keep-local' ? '保留浏览器版本？' : '采用 Bitwarden 版本？', exact: true});
    await expect(confirm).not.toContainText(newerPassword);
    await confirm.getByRole('button', {name: resolution === 'keep-local' ? '确认保留浏览器版本' : '确认采用 Bitwarden 版本', exact: true}).click();
    await expect(conflict).toHaveCount(0);
    await send(page, {type: 'PROVIDER_SYNC', providerId});
    await send(page, {type: 'PROVIDER_SYNC', providerId});
    const rows: Array<LoginItem | PasskeyItem> = await send(page, {type: 'VAULT_LIST_ITEMS'});
    expect(rows.find(row => row.id === target.id)).toMatchObject({password: resolution === 'keep-local' ? newerPassword : target.password});
    expect(rows.find(row => row.id === source.id)?.deletedAt).toBeUndefined();
    for (const original of before.filter((row): row is PasskeyItem => row.kind === 'passkey')) {
      const current = rows.find(row => row.id === original.id) as PasskeyItem;
      expect(current).toMatchObject({credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, signCount: original.signCount});
      expect(current.deletedAt).toBeUndefined();
    }
    const native = (await decodeBitwardenCipher(mock.rows.find(row => row.id === 'source-0')!, providerId, mock.key)).items.find(row => row.kind === 'login');
    expect(native).toMatchObject({password: resolution === 'keep-local' ? newerPassword : target.password});
    let verified = 0;
    for (const cipher of mock.rows.filter(row => !row.deletedDate)) {
      for (const item of (await decodeBitwardenCipher(cipher, providerId, mock.key)).items) {
        if (item.kind !== 'passkey') continue;
        const original = mock.originals.find(row => row.credentialId === item.credentialId)!;
        const key = await crypto.subtle.importKey('pkcs8', Buffer.from(item.privateKeyPkcs8!, 'base64'), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, key, challenge);
        expect(verify('sha256', challenge, {key: createPublicKey({key: Buffer.from(original.publicKey!, 'base64'), format: 'der', type: 'spki'}), dsaEncoding: 'ieee-p1363'}, Buffer.from(signature))).toBe(true);
        expect(item.signCount).toBe(original.signCount); verified++;
      }
    }
    expect(verified).toBe(4); // Two original keys plus their retained independent copies.
    expect(mock.events.filter(event => event === 'delete')).toHaveLength(1);
    expect(mock.events.filter(event => event === 'restore')).toHaveLength(1);
    expect(mock.events.filter(event => event.startsWith('unexpected:'))).toEqual([]);
  } finally {await context.close();}
});

for (const mode of ['complete', 'resume', 'cancel', 'editor'] as const) test(`Bitwarden project removal MV3 ${mode}`, async ({}, info) => {
  const mock = await server(mode === 'resume' || mode === 'cancel', mode === 'cancel'), extension = path.resolve('dist');
  const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const, viewport: {width: 1180, height: 950},
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  let context = await launchEdgeContext(info.outputPath('profile'), options);
  try {
    await context.route(`${HOST}/**`, mock.route);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page, {type: 'VAULT_SETUP', masterPassword: 'Synthetic browser vault password'});
    await page.evaluate(() => chrome.storage.local.set({'monica.sync.preferences.v1': {enabled: false}}));
    const login = await send(page, {type: 'BITWARDEN_LOGIN', name: 'Synthetic Bitwarden', vaultUrl: HOST, email: EMAIL, masterPassword: PASSWORD, isDefaultSaveTarget: false});
    await send(page, {type: 'PROVIDER_SYNC', providerId: login.providerId});
    const before = await send(page, {type: 'VAULT_LIST_ITEMS'});
    const passwords = before.filter((row: LoginItem) => row.kind === 'login' && row.passwordGroupId);
    expect(passwords).toHaveLength(2);
    const source = passwords.find((row: LoginItem) => row.providerRefs.some(ref => ref.remoteId === 'source-1'));
    const input = { operationId: crypto.randomUUID(), items: passwords, expected: Object.fromEntries(passwords.map((row: LoginItem) => [row.id, row.updatedAt])), removedItemIds: [source.id] };
    const request = {type: 'VAULT_PASSWORD_PROJECT_REMOVE', input, confirmed: true};
    if (mode === 'editor') {
      await page.reload();
      await page.getByRole('button', {name: '查看Synthetic removal project详情', exact: true}).click();
      await dialogContent(page, {name: 'Synthetic removal project', exact: true}).getByRole('button', {name: '编辑', exact: true}).click();
      const editor = dialogContent(page, {name: '编辑密码', exact: true});
      await editor.locator('[data-remove-password]').last().click();
      await editor.getByRole('button', {name: '查看移除并保存', exact: true}).click();
      await expect(editor).toContainText('原密码中的 Passkey 会先保留');
      await page.setViewportSize({width: 320, height: 950});
      await page.screenshot({path: info.outputPath('editor-review-320.png')});
      await editor.getByRole('button', {name: '确认移除并保存', exact: true}).click();
      await expect(editor).toHaveCount(0);
    }
    else {
      const initial = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
      if (mode === 'complete') expect(initial).toMatchObject({ok: true, data: {status: 'completed'}});
      else {
      if (initial.ok) {
        const current = await send(page, {type: 'VAULT_LIST_ITEMS'});
        await info.attach('unexpected-removal-status.json', {contentType: 'application/json', body: JSON.stringify({status: initial.data?.status, events: mock.events,
          changedFields: current.map((row: LoginItem | PasskeyItem) => ({id: row.id, keys: Object.keys(row).filter(key =>
            JSON.stringify(Reflect.get(row, key)) !== JSON.stringify(Reflect.get(before.find((prior: LoginItem | PasskeyItem) => prior.id === row.id) || {}, key)))}))})});
      }
      expect(initial.ok, JSON.stringify({status: initial.data?.status, events: mock.events})).toBe(false);
      expect(mock.events.filter(event => event === 'delete')).toHaveLength(0);
      expect(await send(page, {type: 'VAULT_PASSWORD_PROJECT_REMOVALS', operationId: input.operationId})).toEqual([
        expect.objectContaining({status: 'preparing', canCancel: true, supported: true, passkeyPreservation: {total: 2, verified: 0, uncertain: 1}})]);
      await page.reload();
      await page.getByRole('button', {name: '密码源', exact: true}).click();
      const panel = page.locator(`[data-removal-operation="${input.operationId}"]`);
      await expect(panel).toContainText('已核对 0 / 2 个独立 Passkey 副本');
      await expect(panel.getByRole('button', {name: '核对并继续', exact: true})).toBeEnabled();
      for (const width of [1180, 320]) {
        await page.setViewportSize({width, height: 950});
        expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await panel.screenshot({path: info.outputPath(`pending-${width}.png`)});
      }
      await panel.getByRole('button', {name: mode === 'cancel' ? '取消这次移除' : '核对并继续', exact: true}).click();
      await expect(page.locator('[data-pending-removals]')).toContainText(mode === 'cancel' ? '独立 Passkey 副本会保留' : '密码移除已完成');
      await expect(panel).toHaveCount(0);
      }
    }
    if (mode !== 'cancel') {
      await send(page, {type: 'PROVIDER_SYNC', providerId: login.providerId});
      await send(page, {type: 'PROVIDER_SYNC', providerId: login.providerId});
      const after = await send(page, {type: 'VAULT_LIST_ITEMS'});
      const passkeys: PasskeyItem[] = after.filter((row: PasskeyItem) => row.kind === 'passkey' && !row.deletedAt);
      expect(passkeys).toHaveLength(2);
      for (const original of mock.originals) {
        const current = passkeys.find(row => row.credentialId === original.credentialId)!;
        const prior = before.find((row: PasskeyItem) => row.credentialId === original.credentialId);
        expect(current.id).toBe(prior.id); expect(current.signCount).toBe(original.signCount);
        const native = mock.rows.find(row => row.id === current.providerRefs.find(ref => ref.providerId === login.providerId)!.remoteId!.split('#')[0])!;
        const decoded = (await decodeBitwardenCipher(native, login.providerId, mock.key)).items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
        const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(decoded.privateKeyPkcs8!, 'base64'), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, privateKey, challenge);
        expect(verify('sha256', challenge, {key: createPublicKey({key: Buffer.from(original.publicKey!, 'base64'), format: 'der', type: 'spki'}), dsaEncoding: 'ieee-p1363'}, Buffer.from(signature))).toBe(true);
      }
      expect(mock.events.filter(event => event === 'copy')).toHaveLength(2);
      expect(mock.events.filter(event => event === 'delete')).toHaveLength(1);
    } else {
      expect(mock.events.filter(event => event === 'copy')).toHaveLength(1);
      expect(mock.events.filter(event => event === 'delete')).toHaveLength(0);
      await send(page, {type: 'PROVIDER_SYNC', providerId: login.providerId});
      await send(page, {type: 'PROVIDER_SYNC', providerId: login.providerId});
      const after: Array<LoginItem | PasskeyItem> = await send(page, {type: 'VAULT_LIST_ITEMS'});
      expect(after.filter(row => row.kind === 'passkey' && !row.deletedAt)).toHaveLength(3);
      for (const original of before as Array<LoginItem | PasskeyItem>) {
        const current = after.find(row => row.id === original.id)!;
        expect(current.deletedAt).toBeUndefined();
        if (original.kind === 'passkey') expect(current).toMatchObject({credentialId: original.credentialId,
          privateKeyPkcs8: original.privateKeyPkcs8, signCount: original.signCount});
      }
      for (const row of after) {
        expect(row.categoryName).toBe(mock.folderName);
        expect(row.providerRefs).toContainEqual(expect.objectContaining({remoteFolderId: mock.folderId}));
        if (row.kind !== 'passkey') continue;
        const original = mock.originals.find(item => item.credentialId === row.credentialId)!;
        const native = mock.rows.find(cipher => cipher.id === row.providerRefs[0].remoteId!.split('#')[0])!;
        expect(native.deletedDate).toBeFalsy();
        const decoded = (await decodeBitwardenCipher(native, login.providerId, mock.key)).items
          .find((item): item is PasskeyItem => item.kind === 'passkey' && item.credentialId === row.credentialId)!;
        const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(decoded.privateKeyPkcs8!, 'base64'), {name: 'ECDSA', namedCurve: 'P-256'}, false, ['sign']);
        const data = crypto.getRandomValues(new Uint8Array(32));
        const signature = await crypto.subtle.sign({name: 'ECDSA', hash: 'SHA-256'}, privateKey, data);
        expect(verify('sha256', data, {key: createPublicKey({key: Buffer.from(original.publicKey!, 'base64'), format: 'der', type: 'spki'}), dsaEncoding: 'ieee-p1363'}, Buffer.from(signature))).toBe(true);
        expect(decoded.signCount).toBe(original.signCount);
      }
      await send(page, {type: 'VAULT_LOCK'});
      await context.close(); context = await launchEdgeContext(info.outputPath('profile'), options);
      await context.route(`${HOST}/**`, mock.route);
      const resumedWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${new URL(resumedWorker.url()).host}/index.html`);
      await send(reopened, {type: 'VAULT_UNLOCK', masterPassword: 'Synthetic browser vault password'});
      await send(reopened, {type: 'PROVIDER_SYNC', providerId: login.providerId});
      const reloaded: Array<LoginItem | PasskeyItem> = await send(reopened, {type: 'VAULT_LIST_ITEMS'});
      expect(reloaded.map(row => row.id).sort()).toEqual(after.map(row => row.id).sort());
      for (const row of after.filter((item): item is PasskeyItem => item.kind === 'passkey'))
        expect(reloaded.find(item => item.id === row.id)).toMatchObject({credentialId: row.credentialId,
          privateKeyPkcs8: row.privateKeyPkcs8, signCount: row.signCount, categoryName: mock.folderName});
      expect(mock.events.filter(event => event === 'copy')).toHaveLength(1);
      expect(mock.events.filter(event => event === 'delete' || event === 'restore')).toHaveLength(0);
    }
    if (mode === 'complete' || mode === 'cancel') await saveBitwardenNativeSnapshot(`copies-${mode}`, mock.rows, mock.key, mock.originals);
    expect(mock.events.filter(event => event.startsWith('unexpected:'))).toEqual([]);
    await info.attach('acceptance.json', {body: JSON.stringify({mode, transport: 'Playwright synthetic HTTPS routes', runtime: 'actual installed Edge MV3 and IndexedDB',
      copies: mock.events.filter(event => event === 'copy').length, deletes: mock.events.filter(event => event === 'delete').length}), contentType: 'application/json'});
  } finally { await context.close(); }
});
