import { expect, test, type Page, type BrowserContext } from '@playwright/test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { saveBitwardenNativeSnapshot } from './fixtures/bitwarden-native-snapshot';
import type { PasskeyItem } from '../../src/core/model';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { decodeBitwardenCipher, encodeBitwardenPasskeyCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { createPasskey } from '../../src/passkey/webauthn-core';

const directory = path.resolve(process.env.MONICA_BITWARDEN_SNAPSHOT_DIR || '.tmp/android-bitwarden-copies-runtime-318');
const phase = process.env.MONICA_BITWARDEN_SNAPSHOT_PHASE;
const host = 'https://snapshot.example.test', rp = 'bitwarden-snapshot.example.test';
const password = 'Synthetic snapshot vault password', email = 'snapshot@example.invalid';
const challenge = Buffer.alloc(32, 77).toString('base64url');
const html = `<!doctype html><title>Synthetic snapshot RP</title><button id="create">Register</button><button id="login">Sign in</button><output id="result"></output><script>
window.credentialId='';create.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({challenge:'${challenge}',rp:{id:'${rp}',name:'Snapshot RP'},user:{id:'AAECA_8',name:'snapshot-user',displayName:'Snapshot User'},pubKeyCredParams:[{type:'public-key',alg:-257},{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'}})});window.registration=c.toJSON();window.credentialId=c.id;result.textContent='registered';}catch(e){result.textContent=e.name+':'+e.message;}};
login.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required'})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};</script>`;
async function send(page: Page, value: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), value);
  expect(result.ok, result.error).toBe(true); return result.data;
}
async function approve(context: BrowserContext, page: Page, operation: 'create' | 'get') {
  await expect(page.locator('#monica-passkey-prompt-host')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
  const opened = context.waitForEvent('page');
  if (operation === 'get') { await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); }
  await page.keyboard.press('Enter');
  const verification = await opened;
  await verification.getByLabel('Monica 主密码', {exact: true}).fill(password);
  await verification.getByRole('button', {name: '确认', exact: true}).click();
}
function verifyAssertion(value: any, expected: any) {
  expect(value.id).toBe(expected.credentialId); expect(value.response.userHandle).toBe(expected.userHandle);
  const auth = Buffer.from(value.response.authenticatorData, 'base64url'), client = Buffer.from(value.response.clientDataJSON, 'base64url');
  expect(JSON.parse(client.toString())).toMatchObject({type: 'webauthn.get', origin: `https://${rp}`, challenge, crossOrigin: false});
  expect(auth.subarray(0, 32)).toEqual(createHash('sha256').update(rp).digest());
  expect(auth[32]).toBe(0x1d); expect(auth.readUInt32BE(33)).toBe(0);
  expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
    createPublicKey({key: Buffer.from(expected.spki, 'base64'), format: 'der', type: 'spki'}), Buffer.from(value.response.signature, 'base64url'))).toBe(true);
}

test('current Bitwarden native snapshot Edge registration and Android return', async ({}, info) => {
  test.skip(!['prepare', 'return'].includes(phase || ''), 'Explicit synthetic snapshot phase required');
  expect(path.resolve(process.env.MONICA_BITWARDEN_SNAPSHOT_DIR || '')).toBe(directory);
  expect(['.tmp/android-bitwarden-copies-runtime-318','.tmp/android-bitwarden-repaired-318'].map(value=>path.resolve(value))).toContain(directory);
  const input = phase === 'return' ? JSON.parse(await readFile(path.join(directory, 'direct-input.json'), 'utf8')) : undefined;
  const returned = phase === 'return' ? JSON.parse(await readFile(path.join(directory, 'android-bitwarden-copies.json'), 'utf8')).cases.find((row: any) => row.name === 'direct') : undefined;
  if (returned) expect(returned.status).toBe('passed');
  const key = input ? {encKey: new Uint8Array(Buffer.from(input.vaultKeyEnc, 'base64')), macKey: new Uint8Array(Buffer.from(input.vaultKeyMac, 'base64'))}
    : {encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32))};
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password, email, {type: 0, iterations: 10_000}));
  const protectedKey = await new BitwardenClient().protectVaultKey(key, stretched, new Uint8Array(16));
  const rows: Record<string, any>[] = returned ? returned.ciphers : [];
  const events: string[] = [];
  let revision = 0;
  const options = {locale: 'zh-CN', args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`]};
  let context = await launchEdgeContext(info.outputPath('profile'), options);
  const route = async () => {
    await context.route(`${host}/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (body: unknown) => route.fulfill({contentType: 'application/json', body: JSON.stringify(body)});
      if (url.pathname === '/identity/accounts/prelogin/password') return json({Kdf: 0, KdfIterations: 10_000});
      if (url.pathname === '/identity/connect/token') return json({access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, Key: protectedKey});
      if (url.pathname === '/api/sync') return json({Profile: {Id: 'snapshot', Email: email}, Ciphers: rows, Folders: []});
      if (url.pathname === '/api/ciphers' && request.method() === 'POST') {
        const date = new Date(Date.UTC(2026, 9, 10, 0, 0, ++revision)).toISOString();
        const raw = {...request.postDataJSON(), id: crypto.randomUUID(), creationDate: date, revisionDate: date};
        rows.push(raw); events.push('create'); return json(raw);
      }
      events.push(`unexpected:${request.method()}:${url.pathname}`); return route.abort('failed');
    });
    await context.route(`https://${rp}/**`, route => route.fulfill({contentType: 'text/html', body: html}));
  };
  try {
    await route();
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    let manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, {type: 'VAULT_SETUP', masterPassword: password});
    await manager.evaluate(() => chrome.storage.local.set({'monica.sync.preferences.v1': {enabled: false}}));
    const {providerId} = await send(manager, {type: 'BITWARDEN_LOGIN', name: 'Synthetic native snapshot', vaultUrl: host, email, masterPassword: password, isDefaultSaveTarget: true});
    await send(manager, {type: 'PROVIDER_SYNC', providerId});
    let website = await context.newPage(); await website.goto(`https://${rp}/`);
    let expected: any[] = input?.expected || [];
    if (phase === 'prepare') {
      await website.locator('#create').click(); await approve(context, website, 'create');
      await expect(website.locator('#result')).toHaveText('registered');
      const registration = await website.evaluate(() => (window as any).registration);
      expect(registration.response.publicKeyAlgorithm).toBe(-7);
      expect(Buffer.from(registration.id, 'base64url')).toHaveLength(16);
      await send(manager, {type: 'PROVIDER_SYNC', providerId});
      await expect.poll(() => rows.length).toBe(1);
      const item = (await decodeBitwardenCipher(rows[0], 'snapshot', key)).items.find((row): row is PasskeyItem => row.kind === 'passkey')!;
      expect(item.credentialId).toBe(registration.id);
      const original = {...item, publicKey: Buffer.from(registration.response.publicKey, 'base64url').toString('base64')};
      // A second, genuine 32-byte legacy-format identity exercises b64. import;
      // it is generated by extension core, not attributed to browser registration.
      const legacy = await createPasskey({rpId: rp, rpName: 'Legacy RP', userId: 'AAECA_8', userName: 'legacy-user',
        userDisplayName: 'Legacy User', challenge, origin: `https://${rp}`, algorithms: [-7], excludeCredentialIds: []});
      const legacyItem: PasskeyItem = {...original, id: crypto.randomUUID(), credentialId: legacy.credentialId,
        privateKeyPkcs8: legacy.privateKeyPkcs8, publicKey: legacy.publicKeySpki, notes: '原始备注\n---\n后半段🔑', userName: 'legacy-user', userDisplayName: 'Legacy User'};
      rows.push({...await encodeBitwardenPasskeyCipher(legacyItem, key), id: crypto.randomUUID(), creationDate: rows[0].creationDate, revisionDate: rows[0].revisionDate});
      await saveBitwardenNativeSnapshot('direct', rows, key, [original, legacyItem]);
      expected = JSON.parse(await readFile(path.join(directory, 'direct-input.json'), 'utf8')).expected;
      await writeFile(path.join(directory, 'browser-registration.json'), JSON.stringify(registration, null, 2));
      await send(manager, {type: 'PROVIDER_SYNC', providerId});
    }
    let assertions = 0;
    for (const restarted of [false, true]) {
      if (restarted) {
        await send(manager, {type: 'VAULT_LOCK'}); await context.close();
        context = await launchEdgeContext(info.outputPath('profile'), options); await route();
        worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
        await send(manager, {type: 'VAULT_UNLOCK', masterPassword: password});
        website = await context.newPage(); await website.goto(`https://${rp}/`);
      }
      for (const credential of expected) {
        await website.evaluate(id => { (window as any).credentialId = id; }, credential.credentialId);
        await website.locator('#login').click(); await approve(context, website, 'get');
        await expect(website.locator('#result')).toHaveText('authenticated');
        verifyAssertion(await website.evaluate(() => (window as any).assertion), credential); assertions++;
      }
    }
    expect(events.filter(row => row.startsWith('unexpected:'))).toEqual([]);
    expect(events.filter(row => row === 'create')).toHaveLength(phase === 'prepare' ? 1 : 0);
    await writeFile(path.join(directory, `edge-${phase}.json`), JSON.stringify({status: 'passed', phase, assertions,
      actualBrowserRegistrations: phase === 'prepare' ? 1 : 0, coreGeneratedLegacyCredentials: phase === 'prepare' ? 1 : 0,
      syntheticHttp: true, restarted: true, events}, null, 2));
  } finally { await context.close(); }
});
