import { test, expect, chromium, type Page, type BrowserContext } from '@playwright/test';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import type { PasskeyItem, ProviderAccount } from '../../src/core/model';

const directory = path.resolve('.tmp/android-passkey-fixes-317/acceptance');
const phase = process.env.MONICA_PASSKEY_REPAIR_PHASE;
const password = 'Synthetic Bitwarden Passkey test password';
const baseUrl = 'http://127.0.0.1:18316';
const rp = 'bitwarden-passkey.example.test';
const finalNotes = 'PRIVATE_NOTE_REPAIR_317\n---\n只属于备注的内容  ';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function send(page: Page, request: Record<string, unknown>) {
  const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(response.ok, response.error).toBe(true);
  return response.data;
}
async function managerPage(context: BrowserContext) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.goto('chrome-extension://' + new URL(worker.url()).host + '/index.html');
  return page;
}
const options = { locale: 'zh-CN', args: ['--disable-extensions-except=' + path.resolve('dist'), '--load-extension=' + path.resolve('dist')] };

test('original Edge32 credential survives repaired Android sync and system authentication', async ({}, info) => {
  test.skip(!['prepare', 'return'].includes(phase || ''), 'Explicit isolated acceptance phase required');
  test.setTimeout(180_000);
  await mkdir(directory, { recursive: true });
  const client = new BitwardenClient();
  const provider = new BitwardenProvider();
  const original = JSON.parse(await readFile('.tmp/android-bitwarden-passkeys-317/extension-passkey-expected.json', 'utf8'));
  expect(Buffer.from(original.credentialId, 'base64url').length).toBe(32);
  let settings: { synthetic: boolean; baseUrl: string; email: string; password: string };
  if (phase === 'prepare') {
    const source = JSON.parse(await readFile('.tmp/bitwarden-passkey-edge-prepare-final2/passkey-bitwarden-android--02aa1-n-and-actual-Android-return/bitwarden-prepare-browser.json', 'utf8'));
    expect(source.profile).toBe(path.resolve('.tmp/edge-audit-profiles/998093aa-bb9e-42c9'));
    const clone = path.resolve('.tmp/edge-audit-profiles/repair-' + randomUUID().slice(0, 12));
    // Use a copy of the known synthetic registration profile; the original evidence stays unchanged.
    await cp(source.profile, clone, { recursive: true, filter: name => !['Cache', 'Code Cache', 'GPUCache', 'BrowserMetrics', 'SingletonLock', 'SingletonSocket'].includes(path.basename(name)) });
    const context = await chromium.launchPersistentContext(clone, { ...options, channel: 'msedge', executablePath: source.executablePath, headless: false });
    let recovered: PasskeyItem;
    try {
      const page = await managerPage(context);
      const userAgent = await page.evaluate(() => navigator.userAgent);
      expect(userAgent).toMatch(/Edg\//);
      await send(page, { type: 'VAULT_UNLOCK', masterPassword: password });
      const items: PasskeyItem[] = await send(page, { type: 'VAULT_LIST_ITEMS' });
      recovered = items.find(item => item.kind === 'passkey' && item.credentialId === original.credentialId)!;
      expect(recovered).toBeTruthy();
      expect(recovered.algorithm).toBe(-7);
      expect(createHash('sha256').update(Buffer.from(recovered.privateKeyPkcs8!, 'base64')).digest('base64')).toBe(original.keyMaterialSha256);
      await writeFile(path.join(directory, 'historical-recovery.json'), JSON.stringify({ originalId: original.credentialId, originalKeyHash: original.keyMaterialSha256, sourceProfile: source.profile, copiedProfile: clone, userAgent, exactOldIdentity: true }, null, 2));
    } finally { await context.close(); }
    settings = { synthetic: true, baseUrl, email: `passkey-${randomUUID()}@example.invalid`, password };
    const master = await deriveBitwardenMasterKey(password, settings.email, { type: 0, iterations: 600000 });
    const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const response = await fetch(baseUrl + '/identity/accounts/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email: settings.email, name: 'Synthetic repair acceptance', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, password),
        key: await client.protectVaultKey(key, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) });
      expect(response.ok).toBe(true);
    } finally { master.fill(0); key.encKey.fill(0); key.macKey.fill(0); }
    await writeFile(path.join(directory, 'bitwarden-account.json'), JSON.stringify(settings, null, 2));
    const login = await client.login({ vaultUrl: baseUrl, email: settings.email, masterPassword: password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    const account: ProviderAccount = { id: 'repair317', kind: 'bitwarden', name: 'Synthetic repair', enabled: true, isDefaultSaveTarget: false, config: login.session };
    const item = await provider.create(account, { ...recovered!, id: randomUUID(), providerRefs: [{ providerId: account.id }], notes: 'Original Edge credential — notes before Android', signCount: 0 });
    expect(item.kind).toBe('passkey');
    const remote = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items.filter((item): item is PasskeyItem => item.kind === 'passkey');
    expect(remote).toHaveLength(1);
    expect(remote[0].credentialId).toBe(original.credentialId);
    const expected = { ...original, notes: remote[0].notes, cipherId: remote[0].providerRefs[0].remoteId!.split('#fido2:')[0], backupEligible: true, backupState: true };
    await writeFile(path.join(directory, 'expected.json'), JSON.stringify([expected], null, 2));
    await writeFile(path.join(directory, 'repair-config.json'), JSON.stringify({ syntheticFreshInstallation: true, baseUrl: 'http://10.0.2.2:18316', email: settings.email,
      accessToken: login.session.accessToken, vaultKeyEnc: login.session.vaultKeyEnc, vaultKeyMac: login.session.vaultKeyMac, expected }, null, 2));
    await writeFile(path.join(directory, 'edge-prepare-evidence.json'), JSON.stringify({ status: 'passed', original32ByteId: original.credentialId, samePrivateKey: true, configSha256: sha(await readFile(path.join(directory, 'repair-config.json'))) }, null, 2));
    return;
  }
  settings = JSON.parse(await readFile(path.join(directory, 'bitwarden-account.json'), 'utf8'));
  expect(settings).toMatchObject({ synthetic: true, baseUrl });
  expect(settings.email).toMatch(/^passkey-[0-9a-f-]{36}@example.invalid$/);
  const login = await client.login({ vaultUrl: baseUrl, email: settings.email, masterPassword: password, deviceId: randomUUID() });
  if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
  const account: ProviderAccount = { id: 'repair-return', kind: 'bitwarden', name: 'Synthetic repair return', enabled: true, isDefaultSaveTarget: false, config: login.session };
  const returned = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items.filter((item): item is PasskeyItem => item.kind === 'passkey');
  expect(returned).toHaveLength(1);
  expect(returned[0]).toMatchObject({ credentialId: original.credentialId, notes: finalNotes, signCount: 0, algorithm: -7 });
  expect(createHash('sha256').update(Buffer.from(returned[0].privateKeyPkcs8!, 'base64')).digest('base64')).toBe(original.keyMaterialSha256);
  const profile = info.outputPath('repair-return');
  let context = await launchEdgeContext(profile, options);
  try {
    let manager = await managerPage(context);
    await send(manager, { type: 'VAULT_SETUP', masterPassword: password });
    await send(manager, { type: 'BITWARDEN_LOGIN', name: 'Repaired Android return', vaultUrl: baseUrl, email: settings.email, masterPassword: password });
    for (const restart of [false, true]) {
      if (restart) {
        await context.close(); context = await launchEdgeContext(profile, options); manager = await managerPage(context);
        await send(manager, { type: 'VAULT_UNLOCK', masterPassword: password });
      }
      await expect.poll(async () => (await send(manager, { type: 'VAULT_LIST_ITEMS' })).filter((item: PasskeyItem) => item.kind === 'passkey').length).toBe(1);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const challengeText = Buffer.from(challenge).toString('base64url');
      const html = `<!doctype html><title>Original credential RP</title><button id="login">Sign in</button><output id="result"></output><script>login.onclick=async()=>{try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challengeText}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:'${original.credentialId}'}],userVerification:'required'})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};</script>`;
      await context.route('https://' + rp + '/**', route => route.fulfill({ contentType: 'text/html', body: html }));
      const website = await context.newPage(); await website.goto('https://' + rp + '/');
      await website.locator('#login').click();
      await expect(website.locator('#monica-passkey-prompt-host')).toHaveCount(1);
      const opened = context.waitForEvent('page');
      await website.keyboard.press('Tab'); await website.keyboard.press('Tab'); await website.keyboard.press('Enter');
      const verification = await opened;
      await verification.getByLabel('Monica 主密码', { exact: true }).fill(password);
      await verification.getByRole('button', { name: '确认', exact: true }).click();
      await expect(website.locator('#result')).toHaveText('authenticated');
      const assertion = await website.evaluate(() => (window as any).assertion);
      expect(assertion.id).toBe(original.credentialId);
      expect(assertion.response.userHandle).toBe(original.userHandle);
      const auth = Buffer.from(assertion.response.authenticatorData, 'base64url');
      const clientData = Buffer.from(assertion.response.clientDataJSON, 'base64url');
      expect(JSON.parse(clientData.toString())).toMatchObject({ type: 'webauthn.get', challenge: challengeText, origin: 'https://' + rp, crossOrigin: false });
      expect(auth.subarray(0, 32)).toEqual(createHash('sha256').update(rp).digest());
      expect(auth[32]).toBe(29); expect(auth.readUInt32BE(33)).toBe(0);
      expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(clientData).digest()]), createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(original.spki, 'base64') }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
      await writeFile(path.join(directory, `edge-return-${restart ? 'restart' : 'initial'}.json`), JSON.stringify({ originalId: original.credentialId, signature: true, zeroCounter: true, originalPublicKey: true, notesExact: true, assertion }, null, 2));
      await website.close();
    }
  } finally { await context.close(); }
});
