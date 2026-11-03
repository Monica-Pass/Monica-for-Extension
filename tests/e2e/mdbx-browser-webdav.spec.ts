import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import path from 'node:path';
import { LocalWebDavServer } from '../interop/mdbx2-interop-support';
import { launchEdgeContext } from './fixtures/edge';
import { chooseOption } from './fixtures/material';
import { createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount, type VaultItem } from '../../src/core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../src/core/project-credentials';

const master = 'Synthetic browser WebDAV master password';
const databasePassword = 'Synthetic browser WebDAV database password';
const origin = 'https://mdbx-cloud.example.test', rpId = 'mdbx-cloud.example.test';
const challenge = Buffer.alloc(32, 47).toString('base64url');
const remotePath = 'Monica/browser.mdbx';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function raw(page: Page, message: object): Promise<any> { return page.evaluate(input => chrome.runtime.sendMessage(input), message); }
async function send(page: Page, message: object): Promise<any> {
  const result = await raw(page, message); expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}

test('bundled MDBX WebDAV preserves projects and original Passkeys through lost replies and full restarts', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge'); test.setTimeout(240_000);
  const run = path.resolve('.tmp/browser-mdbx-webdav', randomUUID().slice(0, 12)), extension = path.join(run, 'extension');
  await mkdir(run, { recursive: true }); await cp(path.resolve('dist'), extension, { recursive: true });
  const contexts = new Map<string, BrowserContext>();
  const evidence: Record<string, any> = { status: 'failed', run, phases: [], androidAcceptance: false, nativeHostRegistered: false };
  const errors: string[] = [];
  let offline = false, losePut: 'bootstrap' | 'segment' | undefined, truncateBlob = false, corruptBlob = false;
  let lostPath = '', truncatedPath = '';
  const server = new LocalWebDavServer('synthetic', 'synthetic', ({ phase, method, path: objectPath, response }) => {
    if (phase === 'before' && offline) { response.writeHead(503).end(); return true; }
    if (phase === 'stored' && losePut && (losePut === 'bootstrap' ? objectPath === remotePath : objectPath.endsWith('.mdbxsync'))) {
      losePut = undefined; lostPath = objectPath; offline = true; response.destroy(); return true;
    }
    if (phase === 'before' && method === 'GET' && truncateBlob && objectPath.includes('/blobs/')) {
      const bytes = server.file(objectPath); truncatedPath = objectPath;
      response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' });
      response.write(bytes.subarray(0, Math.min(300000, bytes.length - 1)));
      setTimeout(() => response.destroy(), 20); return true;
    }
    if (phase === 'before' && method === 'GET' && corruptBlob && objectPath.includes('/blobs/')) {
      const bytes = server.file(objectPath); bytes[bytes.length - 1] ^= 1;
      response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' }).end(bytes); return true;
    }
    return false;
  });
  const launch = async (name: string) => {
    const appData = path.join(run, name, 'appdata'); await mkdir(appData, { recursive: true });
    const context = await launchEdgeContext(path.join(run, name, 'profile'), { locale: 'zh-CN', viewport: { width: 1180, height: 950 },
      env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    contexts.set(name, context); evidence.edgeVersion = context.browser()?.version();
    await context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic MDBX WebDAV</title>
      <button id="register">Register</button><button id="login">Sign in</button><output id="result"></output><script>
      window.credentialId='';register.onclick=async()=>{try{const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({
        challenge:'${challenge}',rp:{id:'${rpId}',name:'MDBX WebDAV'},user:{id:'dXNlcg',name:'synthetic',displayName:'Synthetic'},
        pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'discouraged',userVerification:'required'}})});
        window.registration=c.toJSON();result.textContent='registered';}catch(e){result.textContent=e.name+':'+e.message;}};
      login.onclick=async()=>{try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',
        rpId:'${rpId}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'discouraged'})});window.assertion=c.toJSON();result.textContent='authenticated';}
        catch(e){result.textContent=e.name+':'+e.message;}};</script>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
  };
  const setup = async (page: Page) => {
    await send(page, { type: 'VAULT_SETUP', masterPassword: master });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    await page.reload();
  };
  const restart = async (name: string, providerId: string) => {
    await contexts.get(name)!.close(); contexts.delete(name); const page = await launch(name);
    if ((await send(page, { type: 'VAULT_STATUS' })) === 'locked') await send(page, { type: 'VAULT_UNLOCK', masterPassword: master });
    const account = ((await send(page, { type: 'PROVIDER_LIST' })) as ProviderAccount[]).find(row => row.id === providerId)!;
    await send(page, { type: 'MDBX2_VAULT_OPEN', input: { providerId, name: account.name,
      source: { kind: 'vault', handle: account.config.vaultHandle }, credential: { method: 'password', password: databasePassword }, isDefaultSaveTarget: account.isDefaultSaveTarget } });
    return page;
  };
  const confirm = async (name: string, website: Page, creating: boolean) => {
    await expect(website.locator('#monica-passkey-prompt-host')).toHaveCount(1);
    await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
    if (!creating) { await website.keyboard.press('Home'); await website.keyboard.press('Tab'); await website.keyboard.press('Tab'); }
    const popup = contexts.get(name)!.waitForEvent('page'); await website.keyboard.press('Enter'); const page = await popup;
    await page.getByLabel('Monica 主密码', { exact: true }).fill(master); await page.getByRole('button', { name: '确认', exact: true }).click();
  };
  const list = (page: Page): Promise<VaultItem[]> => send(page, { type: 'VAULT_LIST_ITEMS' });
  const sync = (page: Page, providerId: string) => send(page, { type: 'PROVIDER_SYNC', providerId });
  const cloudConfig = () => ({ baseUrl: server.baseUrl, username: 'synthetic', password: 'synthetic', remotePath });
  try {
    await server.start(); let a = await launch('a'); await setup(a);
    const created = await send(a, { type: 'MDBX2_VAULT_CREATE', input: { name: 'Browser A', password: databasePassword, isDefaultSaveTarget: true } });
    const aId: string = created.account.id; expect(created.account.config.runtimeBackend).toBe('browser');
    const website = await contexts.get('a')!.newPage(); await website.goto(origin);
    await website.locator('#register').click(); await confirm('a', website, true); await expect(website.locator('#result')).toHaveText('registered');
    await sync(a, aId);
    const original = (await list(a)).find(row => row.kind === 'passkey' && row.rpId === rpId) as PasskeyItem;
    expect(original.signCount).toBe(0); expect(original.providerRefs[0].providerId).toBe(aId);
    const positiveKeys = await a.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const encode = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
      return { privateKey: encode(await crypto.subtle.exportKey('pkcs8', pair.privateKey)), publicKey: encode(await crypto.subtle.exportKey('spki', pair.publicKey)) };
    });
    const positiveCredential = Buffer.from(randomUUID()).toString('base64url');
    const originalObject = await send(a, { type: 'MDBX2_OBJECT_REVEAL', providerId: aId, objectId: original.providerRefs[0].remoteId });
    const positivePayload = { ...JSON.parse(originalObject.payloadJson), monica_entry_id: `passkey:${positiveCredential}`, credential_id: positiveCredential,
      rp_id: 'positive-count.example.test', sign_count: 19, public_key: positiveKeys.publicKey, private_key_alias: positiveKeys.privateKey };
    await send(a, { type: 'MDBX2_OBJECT_UPSERT', providerId: aId, operationId: randomUUID(), input: {
      logicalObjectId: `passkey:${positiveCredential}`, objectTypeId: 'passkey', title: 'Existing positive counter', payloadJson: JSON.stringify(positivePayload) } });
    const projectId = randomUUID(), groupId = randomUUID();
    const projectField = (index: number) => ({ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1,
      projectId, groupId, passwordId: randomUUID(), label: `Account ${index}`, primary: index === 0, groupOrder: 0, passwordOrder: index }) });
    const rich: LoginItem = { ...createLoginItem({ title: 'Cloud rich password', username: 'synthetic', password: 'cloud-original-secret', uris: [origin] }),
      loginType: 'PASSWORD', appPackageName: 'test.mdbx.cloud', appName: 'Cloud fixture', email: 'user@example.test', phone: '+000123',
      addressLine: 'Synthetic street', city: 'City', state: 'State', zipCode: '1234', country: 'XX', notes: 'before cloud',
      passwordGroupId: projectId, customFields: [{ name: 'Recovery', value: 'first', protected: true }, { name: 'Recovery', value: 'second', protected: true }, projectField(0)],
      providerRefs: [{ providerId: aId }], mdbxFolderId: original.mdbxFolderId };
    const sibling = { ...rich, id: randomUUID(), title: 'Cloud project sibling', username: 'second', password: 'cloud-second-secret', customFields: [projectField(1)] };
    await send(a, { type: 'VAULT_UPSERT_ITEM', item: rich }); await send(a, { type: 'VAULT_UPSERT_ITEM', item: sibling }); await sync(a, aId);
    const attachment = Buffer.alloc(600000); for (let i = 0; i < attachment.length; i++) attachment[i] = i % 251;
    const upload = await send(a, { type: 'PROVIDER_ATTACHMENT_UPLOAD_BEGIN', providerId: aId, itemId: rich.id,
      fileName: 'cloud-recovery.bin', sizeBytes: attachment.length, sha256: hash(attachment) });
    for (let offset = 0; offset < attachment.length; offset += 32768) await send(a, { type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: aId,
      transferId: upload.transferId, offset, dataBase64: attachment.subarray(offset, offset + 32768).toString('base64') });
    await send(a, { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId: aId, itemId: rich.id, transferId: upload.transferId }); await sync(a, aId);
    const committed = await list(a), committedRich = committed.find(row => row.id === rich.id) as LoginItem;
    const richRemoteId = committedRich.providerRefs.find(ref => ref.providerId === aId)!.remoteId;
    const siblingRemoteId = committed.find(row => row.id === sibling.id)!.providerRefs.find(ref => ref.providerId === aId)!.remoteId;
    expect(richRemoteId).toBeTruthy(); expect(siblingRemoteId).toBeTruthy();
    await send(a, { type: 'MDBX2_WEBDAV_SAVE', providerId: aId, name: 'Browser A', config: cloudConfig(), isDefaultSaveTarget: true });
    losePut = 'bootstrap'; const interrupted = await raw(a, { type: 'MDBX2_BOOTSTRAP_PUBLISH', providerId: aId });
    expect(interrupted.ok).toBe(false); expect(lostPath).toBe(remotePath); const bootstrap = server.file(remotePath);
    evidence.phases.push('bootstrap-stored-reply-lost');
    // A later write must not be folded into a replacement bootstrap on recovery.
    const later = await send(a, { type: 'MDBX2_OBJECT_UPSERT', providerId: aId, operationId: randomUUID(), input: {
      logicalObjectId: 'password:after-bootstrap-loss', objectTypeId: 'login', title: 'After bootstrap loss',
      payloadJson: '{"monica_entry_id":"password:after-bootstrap-loss","username":"later","password_plain":"later-synthetic-secret"}' } });
    a = await restart('a', aId); offline = false;
    const published = await send(a, { type: 'MDBX2_BOOTSTRAP_PUBLISH', providerId: aId }); expect(published.initialized).toBe(true);
    expect(server.file(remotePath)).toEqual(bootstrap); expect(server.version(remotePath)).toBe(1);
    await sync(a, aId); evidence.phases.push('bootstrap-recovery-original-bytes-and-later-increment');

    let b = await launch('b'); await setup(b); await b.getByRole('button', { name: '密码源', exact: true }).click();
    await b.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
    const dialog = b.locator('.mdbx2-dialog[role="dialog"]'); await chooseOption(dialog.locator('m3e-select').first(), 'remote');
    await dialog.getByLabel('显示名称', { exact: true }).fill('Browser B'); await dialog.getByLabel('WebDAV 地址 *', { exact: true }).fill(server.baseUrl);
    await dialog.getByLabel('用户名', { exact: true }).fill('synthetic'); await dialog.getByLabel('WebDAV 密码', { exact: true }).fill('synthetic');
    await dialog.getByLabel('Android 兼容远端位置 *', { exact: true }).fill(remotePath); await dialog.getByLabel('保险库密码（可留空）', { exact: true }).fill(databasePassword);
    truncateBlob = true; await dialog.getByRole('button', { name: '下载并加入', exact: true }).click();
    const bAccount = async () => ((await send(b, { type: 'PROVIDER_LIST' })) as ProviderAccount[]).find(row => row.name === 'Browser B');
    await expect.poll(async () => (await bAccount())?.id).toBeTruthy(); const bId = (await bAccount())!.id;
    await expect.poll(() => truncatedPath).not.toBe('');
    // Wait for the failed sync to finish before restarting this receiver.
    await expect(dialog.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    expect((await bAccount())!.config.runtimeBackend).toBe('browser');
    const interruptedStatus = await send(b, { type: 'MDBX2_SYNC_STATUS', providerId: bId });
    expect(interruptedStatus).toMatchObject({ pendingRemoteAcknowledgement: true, blobTransferCount: 1 });
    b = await restart('b', bId); truncateBlob = false; corruptBlob = true;
    const damaged = await raw(b, { type: 'PROVIDER_SYNC', providerId: bId }); expect(damaged.ok).toBe(false);
    expect(damaged.error).toBe('MDBX2 Blob chunk could not be written.');
    const damagedStatus = await send(b, { type: 'MDBX2_SYNC_STATUS', providerId: bId });
    expect(damagedStatus).toMatchObject({ pendingRemoteAcknowledgement: true, blobTransferCount: 0 });
    evidence.phases.push('receiver-rejects-corrupted-blob-without-acknowledgement');
    b = await restart('b', bId); corruptBlob = false; await sync(b, bId);
    const check = async (page: Page, providerId: string, notes: string) => {
      const items = await list(page), key = items.find(row => row.kind === 'passkey' && row.rpId === rpId) as PasskeyItem;
      expect(key).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, publicKey: original.publicKey, signCount: 0 });
      const positive = items.find(row => row.kind === 'passkey' && row.credentialId === positiveCredential) as PasskeyItem;
      expect(positive).toMatchObject({ signCount: 19, publicKey: positiveKeys.publicKey, privateKeyPkcs8: positiveKeys.privateKey });
      const proof = Buffer.from('synthetic positive-counter key preservation');
      expect(verify('sha256', proof, createPublicKey({ key: Buffer.from(positiveKeys.publicKey, 'base64'), format: 'der', type: 'spki' }),
        sign('sha256', proof, createPrivateKey({ key: Buffer.from(positive.privateKeyPkcs8!, 'base64'), format: 'der', type: 'pkcs8' })))).toBe(true);
      const login = items.find(row => row.providerRefs.some(ref => ref.providerId === providerId && ref.remoteId === richRemoteId)) as LoginItem; expect(login).toBeTruthy();
      for (const field of ['username','password','uris','loginType','appPackageName','appName','email','phone','addressLine','city','state','zipCode','country','customFields','passwordGroupId'] as const) expect(login[field], field).toEqual(committedRich[field]);
      expect(login.notes).toBe(notes); expect(items.find(row => row.providerRefs.some(ref => ref.providerId === providerId && ref.remoteId === siblingRemoteId))).toMatchObject({ password: sibling.password, passwordGroupId: projectId });
      expect(await send(page, { type: 'MDBX2_OBJECT_REVEAL', providerId, objectId: later.objectId })).toMatchObject({ title: 'After bootstrap loss' });
      const catalog = await send(page, { type: 'PROVIDER_ATTACHMENT_LIST', providerId, itemId: login.id }); expect(catalog.items).toHaveLength(1);
      const read = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_BEGIN', providerId, itemId: login.id, attachmentId: catalog.items[0].attachmentId });
      const parts: Buffer[] = []; let offset = 0;
      try { while (true) { const chunk = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_CHUNK', providerId, readHandle: read.readHandle, offset });
        const bytes = Buffer.from(chunk.dataBase64, 'base64'); parts.push(bytes); offset += bytes.length; if (chunk.eof) break; expect(bytes.length).toBeGreaterThan(0); }
        expect(Buffer.concat(parts)).toEqual(attachment);
      } finally { await send(page, { type: 'PROVIDER_ATTACHMENT_READ_RELEASE', providerId, readHandle: read.readHandle }); }
      return login;
    };
    const remoteLogin = await check(b, bId, rich.notes); evidence.phases.push('receiver-truncated-blob-restart-exact-readback');
    await send(b, { type: 'VAULT_UPSERT_ITEM', item: { ...remoteLogin, notes: 'edited by browser B' } });
    losePut = 'segment'; await raw(b, { type: 'PROVIDER_SYNC', providerId: bId });
    expect(losePut).toBeUndefined(); expect(lostPath.endsWith('.mdbxsync')).toBe(true); const segment = server.file(lostPath), segmentPath = lostPath;
    b = await restart('b', bId); offline = false; await sync(b, bId); await sync(a, aId);
    expect(server.file(segmentPath)).toEqual(segment); expect(server.version(segmentPath)).toBe(1);
    await check(a, aId, 'edited by browser B'); await check(b, bId, 'edited by browser B');
    b = await restart('b', bId); await sync(b, bId); await check(b, bId, 'edited by browser B');
    const loginSite = await contexts.get('b')!.newPage(); await loginSite.goto(origin); await loginSite.evaluate(id => { (window as any).credentialId = id; }, original.credentialId);
    await loginSite.locator('#login').click(); await confirm('b', loginSite, false); await expect(loginSite.locator('#result')).toHaveText('authenticated');
    const assertion = await loginSite.evaluate(() => (window as any).assertion);
    expect(assertion.id).toBe(original.credentialId);
    const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    expect(auth.readUInt32BE(33)).toBe(0); expect(JSON.parse(client.toString())).toMatchObject({ origin, challenge, type: 'webauthn.get' });
    expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
      createPublicKey({ key: Buffer.from(original.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    expect(server.file(remotePath)).toEqual(bootstrap); expect(errors).toEqual([]);
    for (const p of server.filePaths()) {
      expect(server.version(p)).toBe(1);
      for (const secret of [master, databasePassword, rich.password, sibling.password, original.privateKeyPkcs8!]) expect(server.file(p).includes(Buffer.from(secret))).toBe(false);
    }
    expect(server.requests.filter(request => request.method === 'PUT').every(request => request.ifNoneMatch === '*')).toBe(true);
    evidence.phases.push('bidirectional-lost-segment-restart-original-key-signature');
    evidence.status = 'passed'; evidence.bootstrapSha256 = hash(bootstrap); evidence.attachmentSha256 = hash(attachment); evidence.preservedCounters = [0, 19];
    evidence.immutablePaths = server.filePaths().map(p => ({ path: p, sha256: hash(server.file(p)), version: server.version(p) }));
  } finally {
    for (const context of contexts.values()) await context.close(); await server.close();
    evidence.requests = server.requests; evidence.errors = errors; await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
