import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { dialogContent, chooseOption } from './fixtures/material';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { createLoginItem, type LoginItem, type PasskeyItem, type VaultItem } from '../../src/core/model';
import { BITWARDEN_TRANSFER_MARKER } from '../../src/providers/bitwarden/bitwarden-transfer-cipher';
import { temporaryNativeHost } from './fixtures/native-host';
import { resolveBitwardenCipherKey } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { decryptBitwardenSymmetricKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../../src/core/project-credentials';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';
import { encryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';
import { vaultItemToAndroidRecord } from '../../src/providers/webdav/android-backup-codec';

const stamp = '2026-10-12T00:00:00.000Z', password = 'Synthetic portable password', email = 'portable@example.invalid';
const origin = 'https://portable.example.test', challenge = Buffer.alloc(32, 41).toString('base64url');
const options = { locale: 'zh-CN', colorScheme: 'dark' as const, viewport: { width: 1180, height: 950 },
  args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };
async function send(page: Page, request: object): Promise<any> { const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(response.ok, response.error).toBe(true); return response.data; }

for (const sourceKind of ['local', 'local-move', 'local-keep-both', 'mdbx', 'mdbx-move', 'mdbx-keep-both', 'keepass', 'keepass-move', 'keepass-keep-both', 'keepass-webdav-move', 'webdav'] as const) test(`a browser-created ${sourceKind} Passkey survives Bitwarden transfer interruption and authenticates on a fresh Edge client`, async ({}, info) => {
  const nativeKeePass = sourceKind.startsWith('keepass'), cloudKeePass = sourceKind === 'keepass-webdav-move';
  let keepassInitial: Uint8Array | undefined, keepassApi: typeof import('../../src/providers/keepass/keepass-fixture') & typeof import('../../src/providers/keepass/keepass-vault');
  const kdbxRemote = { bytes: Buffer.alloc(0) as Buffer, etag: '"initial"', puts: 0, loseNextReply: false, offline: false };
  const nativeMdbx = sourceKind.startsWith('mdbx'), keepBoth = sourceKind.endsWith('keep-both');
  // Native registration and full-vault verification outlived the default 5s
  // assertion on this host; retain exact results with an explicit native budget.
  const nativeCheck = { timeout: nativeMdbx ? 20_000 : 5_000 };
  let registrationMs: number, previewMs: number;
  test.skip(nativeMdbx && !process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE, 'Requires an explicitly selected verified synthetic MDBX fixture');
  test.setTimeout(180_000);
  const local = sourceKind.startsWith('local'), moving = sourceKind.endsWith('-move') || keepBoth, withProject = sourceKind !== 'local';
  let copyReadbackOffline = false, editedSource: VaultItem | undefined;
  let nativeHost: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined, sourceProviderId: string | undefined;
  const appData = path.resolve('.tmp', `mdbx-bitwarden-${randomUUID().slice(0, 12)}`, 'appdata');
  if (nativeMdbx) await mkdir(appData, { recursive: true });
  let deletedSourceProbe: (() => Promise<boolean>) | undefined, interruptedAfterNativeDeletion = false;
  const attachment = Buffer.from('synthetic encrypted MDBX attachment\n保留原字节'), files = new Map<string, Buffer>();
  const key = { encKey: new Uint8Array(32).fill(11), macKey: new Uint8Array(32).fill(22) };
  const protectedKey = await new BitwardenClient().protectVaultKey(key,
    await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 10_000 })), new Uint8Array(16));
  const rows: Record<string, unknown>[] = [], unexpected: string[] = []; let posts = 0;
  const projectId = randomUUID(), credentialGroupId = randomUUID(), expectedCopies = withProject ? 3 : 2;
  const secondRecovery = nativeKeePass ? 'Second recovery' : 'Recovery';
  const backups = new Map<string, Buffer>(), davMethods: string[] = [];
  if (sourceKind === 'webdav') backups.set('monica_backup_initial.enc.zip', Buffer.from(await encryptAndroidBackup(zipSync({}), 'Synthetic WebDAV backup')));
  const archiveHashes = () => [...backups].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]);
  const projectField = (index: number) => ({ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1,
    projectId, groupId: credentialGroupId, passwordId: randomUUID(), label: `Account ${index}`, primary: index === 0, groupOrder: 0, passwordOrder: index }) });
  const server = createServer(async (request, response) => {
    try {
    const json = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    const body = async () => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); };
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/kdbx/')) {
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('synthetic:synthetic').toString('base64')}`);
      if (kdbxRemote.offline) { response.writeHead(503).end(); return; }
      if (request.method === 'PROPFIND') {
        response.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/kdbx/source.kdbx</d:href><d:propstat><d:prop><d:getetag>${kdbxRemote.etag.replaceAll('"', '&quot;')}</d:getetag><d:getcontentlength>${kdbxRemote.bytes.length}</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`); return;
      }
      if (request.method === 'GET') {
        if (request.headers['if-match'] && request.headers['if-match'] !== kdbxRemote.etag) { response.writeHead(412).end(); return; }
        response.writeHead(200, { ETag: kdbxRemote.etag, 'Content-Length': kdbxRemote.bytes.length }).end(kdbxRemote.bytes); return;
      }
      if (request.method === 'PUT') {
        if (request.headers['if-match'] !== kdbxRemote.etag) { response.writeHead(412).end(); return; }
        kdbxRemote.bytes = await body(); kdbxRemote.puts++; kdbxRemote.etag = `"write-${kdbxRemote.puts}"`;
        if (kdbxRemote.loseNextReply) { kdbxRemote.loseNextReply = false; kdbxRemote.offline = true; response.destroy(); return; }
        response.writeHead(204, { ETag: kdbxRemote.etag }).end(); return;
      }
    }
    if (url.pathname.startsWith('/dav/')) {
      davMethods.push(request.method!);
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('synthetic:synthetic').toString('base64')}`);
      if (request.method === 'PROPFIND') {
        response.writeHead(207, { 'Content-Type': 'application/xml' });
        response.end(`<d:multistatus xmlns:d="DAV:">${[...backups].map(([name, bytes], index) => `<d:response><d:href>/dav/Monica_Backups/${name}</d:href><d:propstat><d:prop>
          <d:getetag>"${createHash('sha256').update(bytes).digest('hex')}"</d:getetag><d:getcontentlength>${bytes.length}</d:getcontentlength>
          <d:getlastmodified>${new Date(Date.parse(stamp) + index * 1000).toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`); return;
      }
      const name = url.pathname.split('/').pop()!;
      if (request.method === 'PUT') {
        expect(request.headers['if-none-match']).toBe('*'); expect(backups.has(name)).toBe(false);
        backups.set(name, await body()); response.writeHead(201); response.end(); return;
      }
      if (request.method === 'GET' && backups.has(name)) {
        const bytes = backups.get(name)!, etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
        if (request.headers['if-match']) expect(request.headers['if-match']).toBe(etag);
        response.writeHead(200, { etag, 'last-modified': new Date(Date.parse(stamp) + [...backups.keys()].indexOf(name) * 1000).toUTCString() });
        response.end(bytes); return;
      }
    }
    if (url.pathname === '/identity/accounts/prelogin/password') return json({ Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === '/identity/connect/token') return json({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, Key: protectedKey });
    if (url.pathname === '/api/sync') {
      if (copyReadbackOffline) { response.writeHead(503); response.end('Synthetic copy recovery outage'); return; }
      if (deletedSourceProbe && (interruptedAfterNativeDeletion || await deletedSourceProbe())) {
        interruptedAfterNativeDeletion = true;
        response.writeHead(503); response.end('Synthetic readback interruption after native deletion'); return;
      }
      return json({ Profile: { Id: 'portable-user', Email: email }, Ciphers: rows, Folders: [] });
    }
    if (url.pathname === '/api/folders' && request.method === 'GET') return json({ Data: [] });
    if (url.pathname === '/api/accounts/revision-date') return json(Date.parse(stamp));
    if (url.pathname === '/api/ciphers' && request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = { ...JSON.parse(Buffer.concat(chunks).toString()), id: `copy-${posts++}`, revisionDate: stamp, creationDate: stamp }; rows.push(raw);
      if (posts === 1) { response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        response.flushHeaders(); response.write('{"lost":'); setImmediate(() => response.destroy()); return; }
      return json(raw);
    }
    const detail = /^\/api\/ciphers\/([^/]+)\/details$/.exec(url.pathname);
    if (detail) return json(rows.find(row => row.id === detail[1]));
    const begin = /^\/api\/ciphers\/([^/]+)\/attachment\/v2$/.exec(url.pathname);
    if (begin && request.method === 'POST') {
      const data = JSON.parse((await body()).toString()), raw = rows.find(row => row.id === begin[1])!, id = 'copied-file';
      raw.attachments = [{ id, fileName: data.fileName, key: data.key, size: String(data.fileSize) }];
      raw.revisionDate = '2026-10-12T00:00:01.000Z';
      return json({ attachmentId: id, fileUploadType: 0, url: '', cipherResponse: raw });
    }
    const file = /^\/api\/ciphers\/([^/]+)\/attachment\/(copied-file)$/.exec(url.pathname);
    if (file && request.method === 'POST') {
      const form = await new Response(await body(), { headers: { 'content-type': request.headers['content-type']! } }).formData();
      files.set(file[2], Buffer.from(await (form.get('data') as Blob).arrayBuffer())); response.end(); return;
    }
    if (file && request.method === 'GET') return json({ ...(rows.find(row => row.id === file[1])!.attachments as object[])[0], url: `${host}/download/${file[2]}` });
    if (url.pathname === '/download/copied-file') {
      expect(request.headers.authorization).toBe('Bearer synthetic'); response.end(files.get('copied-file')); return;
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.writeHead(404); response.end();
    } catch { unexpected.push('Synthetic HTTP handler failed'); response.destroy(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let context: BrowserContext | undefined;
  const open = async (profile: string) => {
    context = await launchEdgeContext(info.outputPath(profile), { ...options, ...(nativeMdbx ? { env: { ...process.env, LOCALAPPDATA: appData } } : {}) });
    await context.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic portable Passkey</title>
      <button id="register">Register</button><button id="login">Sign in</button><output id="result"></output><script>
      window.credentialId='';register.onclick=async()=>{try{const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({
        challenge:'${challenge}',rp:{id:'portable.example.test',name:'Portable passkey'},user:{id:'dXNlcg',name:'synthetic',displayName:'Synthetic'},
        pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'${local ? 'required' : 'discouraged'}',userVerification:'required'}})});
        window.registration=c.toJSON();result.textContent='registered';}catch(e){result.textContent=e.name+':'+e.message;}};
      login.onclick=async()=>{try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',
        rpId:'portable.example.test',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'discouraged'})});
        window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};</script>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`); return page;
  };
  const confirm = async (website: Page, create: boolean) => {
    await expect(website.locator('#monica-passkey-prompt-host')).toHaveCount(1);
    await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
    if (!create) { await website.keyboard.press('Home'); await website.keyboard.press('Tab'); await website.keyboard.press('Tab'); }
    const opened = context!.waitForEvent('page'); await website.keyboard.press('Enter'); const confirmation = await opened;
    await confirmation.getByLabel('Monica 主密码', { exact: true }).fill(password);
    await confirmation.getByRole('button', { name: '确认', exact: true }).click();
  };
  const setup = async (page: Page) => {
    await send(page, { type: 'VAULT_SETUP', masterPassword: password });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  };
  const login = (page: Page) => send(page, { type: 'BITWARDEN_LOGIN', name: 'Synthetic portable target', vaultUrl: host, email, masterPassword: password });
  try {
    let page = await open('original'); await setup(page);
    if (nativeMdbx) {
      const fixtureRoot = process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE!, fixture = path.join(fixtureRoot, 'edge-passkeys.mdbx');
      const evidence = JSON.parse(await readFile(path.join(fixtureRoot, 'evidence.json'), 'utf8'));
      expect(evidence.status).toBe('passed'); expect(createHash('sha256').update(await readFile(fixture)).digest('hex')).toBe(evidence.exportSha256);
      nativeHost = await temporaryNativeHost(new URL(page.url()).host, info.outputPath('native'));
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
      const connect = page.locator('.mdbx2-dialog[role="dialog"]');
      await connect.getByLabel('显示名称', { exact: true }).fill('Synthetic MDBX source');
      await chooseOption(connect.locator('m3e-select').first(), 'local');
      await connect.getByLabel('MDBX2 可移植备份', { exact: true }).setInputFiles(fixture);
      await connect.getByLabel('保险库密码（可留空）', { exact: true }).fill('Synthetic transfer fixture password');
      await connect.locator('label').filter({ hasText: '设为新项目的默认保存目标' }).click();
      await connect.getByRole('button', { name: '验证、解锁并导入', exact: true }).click(); await expect(connect).toHaveCount(0, { timeout: 60000 });
      const source = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.name === 'Synthetic MDBX source');
      expect(source.isDefaultSaveTarget).toBe(true); sourceProviderId = source.id;
    }
    if (nativeKeePass) {
      const helper = info.outputPath('keepass-fixture.cjs');
      await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture'; export {openKeePassVault} from './src/providers/keepass/keepass-vault';", resolveDir: process.cwd() },
        outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
      const api = keepassApi = createRequire(import.meta.url)(helper);
      const bytes = keepassInitial = await api.buildKeePassFixture({ password: 'Synthetic source KDBX', entries: [] });
      if (cloudKeePass) {
        kdbxRemote.bytes = Buffer.from(bytes);
        const opened = await send(page, { type: 'KEEPASS_WEBDAV_OPEN', input: { name: 'Synthetic KeePass source', isDefaultSaveTarget: true,
          baseUrl: `${host}/kdbx`, username: 'synthetic', webDavPassword: 'synthetic', remotePath: 'source.kdbx', databasePassword: 'Synthetic source KDBX' } });
        sourceProviderId = opened.account.id;
      } else {
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.locator('m3e-list-action').filter({ hasText: '连接 KeePass' }).click();
      const connect = dialogContent(page, { name: /KeePass/ });
      await connect.getByLabel('显示名称', { exact: true }).fill('Synthetic KeePass source');
      await connect.getByLabel('KeePass 数据库文件', { exact: true }).setInputFiles({ name: 'synthetic.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      await connect.getByLabel('数据库密码（可留空）', { exact: true }).fill('Synthetic source KDBX');
      await connect.locator('label').filter({ hasText: '设为新项目的默认保存目标' }).click();
      await connect.getByRole('button', { name: '解锁并连接', exact: true }).click(); await expect(connect).toHaveCount(0);
      const source = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.name === 'Synthetic KeePass source');
      expect(source.isDefaultSaveTarget).toBe(true); sourceProviderId = source.id;
      }
    }
    if (sourceKind === 'webdav') {
      await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
      await page.locator('m3e-list-action').filter({ hasText: '连接 Monica Android WebDAV' }).click();
      const connect = page.getByRole('dialog', { name: '连接 Monica Android WebDAV', exact: true });
      await connect.getByLabel('显示名称', { exact: true }).fill('Synthetic WebDAV source');
      await connect.getByLabel('WebDAV 地址 *', { exact: true }).fill(`${host}/dav`);
      await connect.getByLabel('用户名', { exact: true }).fill('synthetic');
      await connect.getByLabel('WebDAV 密码', { exact: true }).fill('synthetic');
      await connect.getByLabel('Android 备份加密密码（可选）', { exact: true }).fill('Synthetic WebDAV backup');
      await connect.locator('label').filter({ hasText: '设为新项目的默认保存目标' }).click();
      await connect.getByRole('button', { name: '加密保存', exact: true }).click(); await expect(connect).toHaveCount(0);
      const source = (await send(page, { type: 'PROVIDER_LIST' })).find((row: any) => row.name === 'Synthetic WebDAV source');
      expect(source.isDefaultSaveTarget).toBe(true); sourceProviderId = source.id;
      await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
    }
    let website = await context!.newPage(); await website.goto(origin);
    const registrationStarted = Date.now();
    await website.locator('#register').click(); await confirm(website, true); await expect(website.locator('#result')).toHaveText('registered', nativeCheck);
    registrationMs = Date.now() - registrationStarted;
    const original = (await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.kind === 'passkey' && row.rpId === 'portable.example.test') as PasskeyItem;
    expect(original).toMatchObject({ sourceMode: 'browser-local', signCount: 0, userVerificationRequired: true, discoverable: local });
    expect(original.providerRefs.map(row => row.providerId)).toEqual(sourceProviderId && sourceKind !== 'webdav' ? [sourceProviderId] : []);
    if (sourceKind === 'webdav') {
      // Legacy snapshot providers are not direct WebAuthn registration targets.
      // Import an encrypted native backup of this genuinely registered key.
      backups.set('monica_backup_registered.enc.zip', Buffer.from(await encryptAndroidBackup(zipSync({
        'passkeys/passkey_registered.json': strToU8(JSON.stringify(vaultItemToAndroidRecord(original, undefined, undefined, { allowPortablePasskeys: true })))
      }), 'Synthetic WebDAV backup')));
      await send(page, { type: 'VAULT_DELETE_ITEM', itemId: original.id });
      await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
      const native = (await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.kind === 'passkey' && row.providerRefs[0]?.providerId === sourceProviderId) as PasskeyItem;
      expect(native).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, signCount: 0 });
    }
    const rich: LoginItem = { ...createLoginItem({ title: 'Rich portable password', username: 'synthetic', password: 'synthetic-secret', uris: [origin] }),
      loginType: 'PASSWORD', appPackageName: 'test.portable', appName: 'Portable', email: 'user@example.test', phone: '+000123',
      addressLine: 'Synthetic street', city: 'City', state: 'State', zipCode: '1234', country: 'XX',
      customFields: [{ name: 'Recovery', value: 'first', protected: true }, { name: secondRecovery, value: 'second', protected: true, fieldType: 'HIDDEN' }],
      passwordHistory: local || sourceKind === 'webdav' ? [{ password: 'synthetic-older', lastUsedAt: stamp }] : undefined,
      providerRefs: sourceProviderId ? [{ providerId: sourceProviderId }] : [], mdbxFolderId: original.mdbxFolderId };
    if (withProject) { rich.passwordGroupId = projectId; rich.customFields.push(projectField(0)); }
    await send(page, { type: 'VAULT_UPSERT_ITEM', item: rich });
    if (withProject) {
      await send(page, { type: 'VAULT_UPSERT_ITEM', item: { ...rich, id: randomUUID(), title: 'Second project account',
        username: 'second', password: 'synthetic-second-secret', customFields: [projectField(1)] } });
      if (sourceProviderId) await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
      const attachmentProvider = sourceProviderId || 'local';
      const upload = await send(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_BEGIN', providerId: attachmentProvider, itemId: rich.id,
        fileName: 'recovery.txt', sizeBytes: attachment.length, sha256: createHash('sha256').update(attachment).digest('hex') });
      await send(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId: attachmentProvider, transferId: upload.transferId, offset: 0, dataBase64: attachment.toString('base64') });
      await send(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId: attachmentProvider, itemId: rich.id, transferId: upload.transferId });
      if (sourceProviderId) await send(page, { type: 'PROVIDER_SYNC', providerId: sourceProviderId });
    }
    // Native sync adds committed remote identity and revision. Compare against
    // that committed source snapshot, while original key bytes stay anchored to registration.
    const sourcesBeforeCopy = await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[];
    const selectedSources = sourcesBeforeCopy.filter(row => row.id === original.id || row.id === rich.id
      || row.kind === 'login' && readProjectCredential(row.customFields)?.projectId === projectId);
    const archivesBeforeCopy = archiveHashes();
    if (nativeKeePass) await info.attach('source-shape', { contentType: 'application/json', body: JSON.stringify(sourcesBeforeCopy.map(row => {
      const base = JSON.parse(row.providerRefs[0]?.etag || '{}');
      return { kind: row.kind, database: row.keepassDatabaseId, baselineDatabase: base.keepassDatabaseId,
        algorithm: row.kind === 'passkey' ? row.keyAlgorithm : undefined, baselineAlgorithm: base.keyAlgorithm,
        aaguid: row.kind === 'passkey' ? row.aaguid : undefined, baselineAaguid: base.aaguid };
    })) });
    const { providerId } = await login(page); await page.reload(); await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: 'Synthetic portable target', exact: true }) })
      .getByRole('button', { name: '批量传输', exact: true }).click();
    const dialog = dialogContent(page, { name: '复制或移动项目' });
    await dialog.getByRole('checkbox', { name: /Portable passkey/ }).check(); await dialog.getByRole('checkbox', { name: /Rich portable password/ }).check();
    if (moving) await dialog.locator('.batch-action-picker label').filter({ hasText: '移动' }).click();
    const davStart = davMethods.length;
    const previewStarted = Date.now();
    await dialog.getByRole('button', { name: '检查并生成计划', exact: true }).click();
    await expect(dialog.getByText(`${expectedCopies} 个可传输，0 个被阻断`, { exact: true })).toBeVisible(nativeCheck);
    previewMs = Date.now() - previewStarted;
    if (sourceKind === 'webdav') expect(davMethods.slice(davStart)).toEqual(['PROPFIND', 'GET', 'PROPFIND']);
    if (moving) {
      await dialog.locator('label').filter({ hasText: '我确认执行移动' }).click();
      await page.screenshot({ path: info.outputPath('move-confirmation.png'), fullPage: true });
      await page.setViewportSize({ width: 375, height: 820 });
      await dialog.locator('label').filter({ hasText: '我确认执行移动' }).scrollIntoViewIfNeeded();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('move-confirmation-narrow.png') });
      await page.setViewportSize(options.viewport);
    }
    await dialog.getByRole('button', { name: moving ? '确认并移动' : '执行复制', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '恢复传输', exact: true })).toBeVisible(nativeCheck); expect(posts).toBe(1);
    const pending = await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId }); expect(pending).toHaveLength(1);
    if (nativeMdbx && moving) {
      const source = selectedSources[0];
      for (const request of [
        { type: 'PROVIDER_SYNC', providerId: sourceProviderId },
        { type: 'MDBX2_OBJECT_DELETE', providerId: sourceProviderId, operationId: randomUUID(),
          logicalObjectId: `native:${source.providerRefs[0].remoteId}`, expectedHeadCommitId: source.providerRefs[0].revision }
      ]) {
        const guarded = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
        expect(guarded.ok).toBe(false); expect(guarded.error).toContain('待恢复');
      }
    }
    if (moving) for (const source of sourcesBeforeCopy) expect((await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.id === source.id)).toEqual(source);
    if (keepBoth) {
      const source = sourcesBeforeCopy.find(row => row.id === rich.id)!;
      await send(page, { type: 'VAULT_UPSERT_ITEM', item: { ...source, password: 'Edited after transfer started' } });
      editedSource = (await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.id === rich.id)!;
      const failed = await page.evaluate(input => chrome.runtime.sendMessage(input), { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request });
      expect(failed.ok).toBe(false);
      // Native conversion detects the queued password edit against the actual
      // database before the final indexed-source hash check can run.
      expect(failed.error).toContain(nativeMdbx ? '无法完整保存 password 字段' : nativeKeePass ? '仍有未保存修改' : '已变化');
      const popup = await context!.newPage(); await popup.goto(new URL('popup.html', page.url()).href);
      const denied = await popup.evaluate(input => chrome.runtime.sendMessage(input), { type: 'BITWARDEN_KEEP_BOTH_TRANSFER', providerId,
        operationId: pending[0].request.operationId, confirmed: true });
      expect(denied.ok).toBe(false); expect(denied.error).toContain('管理页'); await popup.close();
      await dialog.getByRole('button', { name: '保留两端，完成复制', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '确认并移动', exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '恢复传输', exact: true })).toHaveCount(0);
      const confirmCopy = dialog.getByRole('button', { name: '确认保留并继续', exact: true });
      await expect(confirmCopy).toBeDisabled();
      await dialog.getByRole('checkbox', { name: '我确认保留来源并按复制完成', exact: true }).check();
      await page.setViewportSize({ width: 375, height: 820 });
      await confirmCopy.scrollIntoViewIfNeeded();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: info.outputPath('keep-both-confirmation-narrow.png') });
      await page.setViewportSize(options.viewport);
      copyReadbackOffline = true;
      await confirmCopy.click();
      await expect(dialog.getByRole('button', { name: '继续复制', exact: true })).toBeEnabled({ timeout: 20_000 });
      const resolved = await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId });
      expect(resolved[0]).toMatchObject({ canKeepBoth: false, keptBoth: true, request: { action: 'move' }, plan: { action: 'copy' } });
      await expect(dialog.getByText('已选择保留来源；继续完成预览版本的复制。', { exact: true })).toBeVisible();
    }
    await send(page, { type: 'VAULT_LOCK' }); await context!.close(); context = undefined;
    copyReadbackOffline = false;
    page = await open('original'); await send(page, { type: 'VAULT_UNLOCK', masterPassword: password });
    const reopenNative = async () => {
      const sources = await send(page, { type: 'PROVIDER_LIST' });
      const account = sources.find((row: any) => row.id === sourceProviderId);
      await send(page, { type: 'MDBX2_VAULT_OPEN', input: { providerId: sourceProviderId, name: account.name,
        source: { kind: 'vault', handle: account.config.vaultHandle }, credential: { method: 'password', password: 'Synthetic transfer fixture password' }, isDefaultSaveTarget: false } });
    };
    const reopenKeePass = async () => {
      if (cloudKeePass) await send(page, { type: 'KEEPASS_REMOTE_RESTORE', providerId: sourceProviderId });
      else await send(page, { type: 'KEEPASS_OPEN', input: { providerId: sourceProviderId, name: 'Synthetic KeePass source',
        fileName: 'synthetic.kdbx', file: Buffer.from(keepassInitial!).toString('base64'), password: 'Synthetic source KDBX', isDefaultSaveTarget: false } });
    };
    if (nativeKeePass && moving) await reopenKeePass();
    if (cloudKeePass) {
      const putsBeforeRemoval = kdbxRemote.puts;
      kdbxRemote.loseNextReply = true;
      const interrupted = await page.evaluate(input => chrome.runtime.sendMessage(input), { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request });
      expect(interrupted.ok).toBe(false); expect(kdbxRemote.offline, interrupted.error).toBe(true);
      expect(kdbxRemote.puts).toBe(putsBeforeRemoval + 1);
      for (const source of selectedSources) expect((await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.id === source.id)).toEqual(source);
      const denied = await page.evaluate(providerId => chrome.runtime.sendMessage({ type: 'PROVIDER_REMOVE', providerId }), sourceProviderId!);
      expect(denied.ok).toBe(false); expect(denied.error).toContain('待恢复');
      await send(page, { type: 'VAULT_LOCK' }); await context!.close(); context = undefined;
      kdbxRemote.offline = false;
      page = await open('original'); await send(page, { type: 'VAULT_UNLOCK', masterPassword: password }); await reopenKeePass();
      // The server already accepted the exact encrypted bytes. Retry must not issue a second successful PUT.
      await send(page, { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request });
      expect(kdbxRemote.puts).toBe(putsBeforeRemoval + 1);
    }
    if (nativeMdbx && moving) await reopenNative();
    if (nativeMdbx && moving && !keepBoth) {
      deletedSourceProbe = async () => {
        const deleted = new Set<string>();
        for (const collectionId of new Set(selectedSources.map(source => source.providerRefs[0].remoteFolderId))) {
          const result = await send(page, { type: 'MDBX2_OBJECT_LIST', providerId: sourceProviderId, collectionId, deleted: true, pageSize: 200 });
          expect(result.nextCursor).toBeUndefined();
          for (const row of result.items) if (row.deleted) deleted.add(row.objectId);
        }
        return selectedSources.every(source => deleted.has(source.providerRefs[0].remoteId!));
      };
      const interrupted = await page.evaluate(input => chrome.runtime.sendMessage(input), { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request });
      expect(interrupted.ok).toBe(false); expect(interruptedAfterNativeDeletion, interrupted.error).toBe(true);
      deletedSourceProbe = undefined; // Release the synthetic outage only after all client retries have failed.
      expect((await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId }))).toHaveLength(1);
      for (const source of sourcesBeforeCopy) expect((await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[]).find(row => row.id === source.id)).toEqual(source);
      await send(page, { type: 'VAULT_LOCK' }); await context!.close(); context = undefined;
      page = await open('original'); await send(page, { type: 'VAULT_UNLOCK', masterPassword: password }); await reopenNative();
    }
    expect(await send(page, { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request })).toMatchObject({ completedCount: expectedCopies, failedCount: 0, action: moving && !keepBoth ? 'move' : 'copy' });
    expect(posts).toBe(expectedCopies);
    const afterCopy = await send(page, { type: 'VAULT_LIST_ITEMS' }) as VaultItem[];
    for (const source of sourcesBeforeCopy) expect(afterCopy.find(row => row.id === source.id)).toEqual(moving && !keepBoth && selectedSources.includes(source) ? undefined : source.id === editedSource?.id ? editedSource : source);
    if (keepBoth) {
      expect(await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId })).toEqual([]);
      const sourceFiles = await send(page, { type: 'PROVIDER_ATTACHMENT_LIST', providerId: sourceProviderId || 'local', itemId: rich.id });
      expect(sourceFiles.items).toHaveLength(1);
      if (nativeMdbx) for (const source of selectedSources) {
        const live = await send(page, { type: 'MDBX2_OBJECT_REVEAL', providerId: sourceProviderId, objectId: source.providerRefs[0].remoteId });
        expect(live.deleted).not.toBe(true);
      }
    }
    if (moving && !keepBoth) {
      const completed = await send(page, { type: 'MDBX2_BATCH_TRANSFER_EXECUTE', input: pending[0].request });
      expect(completed).toMatchObject({ action: 'move', completedCount: 3 }); expect(posts).toBe(3);
      expect(await send(page, { type: 'BITWARDEN_PENDING_TRANSFERS', providerId })).toEqual([]);
      const removedFile = await page.evaluate(input => chrome.runtime.sendMessage(input), { type: 'PROVIDER_ATTACHMENT_LIST', providerId: sourceProviderId || 'local', itemId: rich.id });
      expect(removedFile.ok).toBe(false);
      if (nativeMdbx) for (const source of selectedSources) {
        const deleted = await send(page, { type: 'MDBX2_OBJECT_LIST', providerId: sourceProviderId, collectionId: source.providerRefs[0].remoteFolderId, deleted: true });
        expect(deleted.items.find((row: any) => row.objectId === source.providerRefs[0].remoteId)).toMatchObject({ deleted: true });
      }
    }
    if (nativeKeePass && moving) {
      const exported = await send(page, { type: 'KEEPASS_EXPORT_FILE', providerId: sourceProviderId });
      const db = await keepassApi!.openKeePassVault(new Uint8Array(Buffer.from(exported.file, 'base64')), { password: 'Synthetic source KDBX', databaseId: 1, providerId: sourceProviderId! });
      for (const source of selectedSources) expect(Boolean(db.items.find(row => row.keepassEntryUuid === source.keepassEntryUuid)?.deletedAt)).toBe(!keepBoth);
      expect(db.items.find(row => row.kind === 'passkey')).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, signCount: 0 });
      const entry = db.entriesByUuid.get(selectedSources.find(row => row.id === rich.id)!.keepassEntryUuid!)!;
      const binary = entry.binaries.get('recovery.txt')!;
      const value = binary instanceof ArrayBuffer ? binary : binary.value;
      const bytes = 'getBinary' in value ? value.getBinary() : value;
      expect(Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)).toEqual(attachment);
      if (cloudKeePass) {
        const remote = await keepassApi!.openKeePassVault(new Uint8Array(kdbxRemote.bytes), { password: 'Synthetic source KDBX', databaseId: 1, providerId: sourceProviderId! });
        expect(remote.items.filter(row => row.deletedAt)).toHaveLength(3);
      }
    }
    if (sourceKind === 'webdav') {
      expect(archiveHashes()).toEqual(archivesBeforeCopy);
      expect(davMethods.slice(davStart)).toEqual(['PROPFIND', 'GET', 'PROPFIND', 'PROPFIND', 'GET', 'PROPFIND']);
    }
    await context!.close(); context = undefined;

    // Independent installation has no local policy/identity cache from registration.
    page = await open('fresh-client'); await setup(page); const fresh = await login(page);
    await send(page, { type: 'PROVIDER_SYNC', providerId: fresh.providerId });
    const imported: VaultItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
    const passkey = imported.find(row => row.kind === 'passkey') as PasskeyItem;
    expect(passkey).toMatchObject({ credentialId: original.credentialId, signCount: 0, userVerificationRequired: true, discoverable: local });
    expect(Buffer.from(passkey.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(original.privateKeyPkcs8!, 'base64'));
    const passwordItem = imported.find(row => row.title === rich.title) as LoginItem;
    for (const field of ['username','password','uris','passwordHistory','appPackageName','appName','email','phone','addressLine','city','state','zipCode','country'] as const)
      if (!(nativeKeePass && field === 'passwordHistory')) expect(passwordItem[field], field).toEqual(rich[field]);
    if (nativeKeePass) expect(passwordItem.passwordHistory).toEqual([{ password: rich.password, lastUsedAt: expect.any(String) }]);
    expect(passwordItem.customFields.filter(row => row.name !== PROJECT_CREDENTIAL_FIELD)).toEqual([{ name: 'Recovery', value: 'first', protected: true }, { name: secondRecovery, value: 'second', protected: true },
      { name: BITWARDEN_TRANSFER_MARKER, value: expect.any(String), protected: true }]);
    expect(JSON.parse(passwordItem.customFields.find(row => row.name === BITWARDEN_TRANSFER_MARKER)!.value)).toMatchObject({ version: 1, operationId: pending[0].request.operationId });
    if (withProject) {
      const sibling = imported.find(row => row.title === 'Second project account') as LoginItem;
      expect(sibling).toMatchObject({ username: 'second', password: 'synthetic-second-secret', passwordGroupId: passwordItem.passwordGroupId });
      expect(passwordItem.passwordGroupId).toBeTruthy(); expect(passwordItem.passwordGroupId).not.toBe(projectId);
      expect(readProjectCredential(passwordItem.customFields)).toEqual({ ...readProjectCredential(rich.customFields), projectId: passwordItem.passwordGroupId });
      expect(readProjectCredential(sibling.customFields)).toMatchObject({ projectId: passwordItem.passwordGroupId, groupId: credentialGroupId, passwordOrder: 1 });
      const catalog = await send(page, { type: 'PROVIDER_ATTACHMENT_LIST', providerId: fresh.providerId, itemId: passwordItem.id });
      expect(catalog.items).toHaveLength(1); expect(catalog.items[0].fileName).toBe('recovery.txt');
      const download = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_BEGIN', providerId: fresh.providerId, itemId: passwordItem.id,
        attachmentId: catalog.items[0].attachmentId });
      try {
        const chunk = await send(page, { type: 'PROVIDER_ATTACHMENT_READ_CHUNK', providerId: fresh.providerId, readHandle: download.readHandle, offset: 0 });
        expect(chunk.eof).toBe(true); expect(Buffer.from(chunk.dataBase64, 'base64')).toEqual(attachment);
      } finally { await send(page, { type: 'PROVIDER_ATTACHMENT_READ_RELEASE', providerId: fresh.providerId, readHandle: download.readHandle }); }
      const raw = rows.find(row => (row.attachments as unknown[])?.length)!;
      const cipherKey = await resolveBitwardenCipherKey(raw, key), file = (raw.attachments as Record<string, string>[])[0];
      try {
        const fileKey = await decryptBitwardenSymmetricKey(file.key, cipherKey), wire = Uint8Array.from(files.get('copied-file')!);
        try {
          const mac = await crypto.subtle.importKey('raw', fileKey.macKey as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
          expect(await crypto.subtle.verify('HMAC', mac, wire.subarray(17, 49), Buffer.concat([wire.subarray(1, 17), wire.subarray(49)]))).toBe(true);
          const aes = await crypto.subtle.importKey('raw', fileKey.encKey as BufferSource, 'AES-CBC', false, ['decrypt']);
          expect(Buffer.from(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: wire.subarray(1, 17) }, aes, wire.subarray(49)))).toEqual(attachment);
        } finally { fileKey.encKey.fill(0); fileKey.macKey.fill(0); }
      } finally { cipherKey.encKey.fill(0); cipherKey.macKey.fill(0); }
    }
    website = await context!.newPage(); await website.goto(origin); await website.evaluate(id => { (window as any).credentialId = id; }, original.credentialId);
    await website.locator('#login').click(); await confirm(website, false); await expect(website.locator('#result')).toHaveText('authenticated');
    const assertion = await website.evaluate(() => (window as any).assertion);
    expect(assertion.id).toBe(original.credentialId);
    const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    expect(auth.readUInt32BE(33)).toBe(0); expect(auth[32] & 0x1c).toBe(0x1c);
    expect(JSON.parse(client.toString())).toMatchObject({ origin, challenge, type: 'webauthn.get' });
    expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
      createPublicKey({ key: Buffer.from(original.publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    expect(posts).toBe(expectedCopies); expect(unexpected).toEqual([]);
    const acceptance = { browserRegistration: true, interruptedCreate: true,
      fullRestart: true, independentFreshClient: true, preservedSources: !moving || keepBoth, removedOnlyAfterVerification: moving && !keepBoth,
      keepBothAfterSourceEdit: keepBoth, durableCopyDecisionDuringOutage: keepBoth, interruptedAfterNativeDeletion, remoteCiphers: posts, zeroCounter: true,
      sourceKind, registrationMs, previewMs, verificationRequiredWhenRpDiscourages: true, independentlyVerifiedAssertion: true, richPasswordFields: true, nativeAttachment: withProject,
      nativeProjectMembers: withProject ? 2 : 0, freshClientAttachmentRead: withProject };
    await writeFile(info.outputPath('acceptance.json'), JSON.stringify(acceptance, null, 2));
    await info.attach('acceptance', { contentType: 'application/json', body: JSON.stringify(acceptance) });
  } finally {
    try { await context?.close(); } finally {
      try { await nativeHost?.restore(); } finally {
        server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); key.encKey.fill(0); key.macKey.fill(0);
      }
    }
  }
});
