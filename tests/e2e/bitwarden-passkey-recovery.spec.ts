import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { decodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';
import { createPasskey } from '../../src/passkey/webauthn-core';
import type { PasskeyItem } from '../../src/core/model';

const password = 'Synthetic recovery master password', email = 'synthetic@example.invalid';
const stamp = '2026-10-12T00:00:00.000Z', rpId = 'recovery.example.test', origin = `https://${rpId}`;
const challenge = Buffer.alloc(32, 63).toString('base64url');
const options = { locale: 'zh-CN', reducedMotion: 'reduce' as const,
  args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] };
async function send(page: Page, request: object): Promise<any> {
  const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(response.ok, response.error).toBe(true); return response.data;
}

for (const loss of ['body', 'headers'] as const) test(`Bitwarden HTTP ${loss} loss recovers or retains ambiguous Passkeys after full Edge restart`, async ({}, info) => {
  test.setTimeout(120_000);
  const key = { encKey: new Uint8Array(32).fill(18), macKey: new Uint8Array(32).fill(31) };
  const protectedKey = await new BitwardenClient().protectVaultKey(key,
    await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 10_000 })), new Uint8Array(16));
  const rows: Record<string, unknown>[] = [], writes: string[] = [], unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const json = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    if (url.pathname === '/identity/accounts/prelogin/password') return json({ Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === '/identity/connect/token') return json({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, Key: protectedKey });
    if (url.pathname === '/api/sync') return json({ Profile: { Id: 'synthetic-user', Email: email }, Ciphers: rows, Folders: [] });
    if (url.pathname === '/api/accounts/revision-date') return json(Date.parse(stamp));
    if (url.pathname === '/api/ciphers' && request.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = JSON.parse(Buffer.concat(chunks).toString());
      const id = `committed-${rows.length}`; writes.push(id);
      rows.push({ ...raw, id, revisionDate: stamp, creationDate: stamp });
      // Chromium may transparently replay a POST on a reused socket if no
      // headers arrive. Exercise that ambiguity separately from truncated body recovery.
      if (loss === 'headers') response.destroy();
      else {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        response.flushHeaders(); response.write('{"interrupted":'); setImmediate(() => response.destroy());
      }
      return;
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = info.outputPath('profile'); let context: BrowserContext | undefined;
  const open = async () => {
    context = await launchEdgeContext(profile, options);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    return manager;
  };
  try {
    let page = await open(); await send(page, { type: 'VAULT_SETUP', masterPassword: password });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    const { providerId } = await send(page, { type: 'BITWARDEN_LOGIN', name: 'Synthetic recovery', vaultUrl: host, email, masterPassword: password });
    const fixtures: Array<{ item: PasskeyItem; id: string; spki: string }> = [];
    for (const representation of ['canonical', 'base64url-key', 'uuid-id', 'restricted']) {
      const created = await createPasskey({ origin, challenge, rpName: representation, userId: 'dXNlcg', userName: representation,
        userDisplayName: representation, algorithms: [-7], excludeCredentialIds: [], credentialIdFormat: 'uuid' });
      const item: PasskeyItem = { id: representation, kind: 'passkey', title: representation, notes: '', favorite: false,
        createdAt: stamp, updatedAt: stamp, providerRefs: [{ providerId }],
        credentialId: representation === 'uuid-id' ? created.credentialIdUuid! : created.credentialId,
        rpId, rpName: representation, userHandle: 'dXNlcg', userName: representation, userDisplayName: representation,
        algorithm: -7, publicKey: created.publicKeySpki,
        privateKeyPkcs8: representation === 'base64url-key' ? created.privateKeyPkcs8.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : created.privateKeyPkcs8,
        signCount: 0, discoverable: true, sourceMode: 'browser-local', backupEligible: representation !== 'restricted', backupState: false };
      await send(page, { type: 'VAULT_UPSERT_ITEM', item }); fixtures.push({ item, id: created.credentialId, spki: created.publicKeySpki });
    }
    await send(page, { type: 'PROVIDER_SYNC', providerId });
    const observations = await Promise.all(rows.map(async raw => ({ id: raw.id,
      entries: (await decodeBitwardenCipher(raw, providerId, key)).items.filter(row => row.kind === 'passkey').map(row => ({ name: row.userName, id: row.credentialId })) })));
    const ambiguous = fixtures.filter(fixture => observations.filter(row => row.entries.some(entry => entry.id === fixture.id)).length > 1);
    expect(ambiguous).toHaveLength(loss === 'headers' ? 1 : 0);
    // The repeated HTTP payload is byte-for-byte identical, including random IVs.
    if (loss === 'headers') expect({ ...rows[0], id: '' }).toEqual({ ...rows[1], id: '' });
    expect(writes).toHaveLength(loss === 'headers' ? 4 : 3);
    expect(await send(page, { type: 'PROVIDER_CONFLICT_LIST', providerId })).toHaveLength(4);
    await send(page, { type: 'VAULT_LOCK' }); await context!.close(); context = undefined;
    page = await open(); await send(page, { type: 'VAULT_UNLOCK', masterPassword: password });
    await send(page, { type: 'PROVIDER_SYNC', providerId });
    expect(writes).toHaveLength(loss === 'headers' ? 4 : 3);
    const conflicts = await send(page, { type: 'PROVIDER_CONFLICT_LIST', providerId });
    expect(conflicts).toHaveLength(1 + ambiguous.length);
    expect(conflicts.some((row: any) => row.reason.includes('注册时不允许备份'))).toBe(true);
    if (ambiguous.length) expect(conflicts.some((row: any) => row.reason.includes('匹配不唯一'))).toBe(true);
    const local: PasskeyItem[] = (await send(page, { type: 'VAULT_LIST_ITEMS' })).filter((row: PasskeyItem) => row.kind === 'passkey');
    expect(local.filter(row => fixtures.some(fixture => fixture.item.id === row.id))).toHaveLength(4);
    for (const fixture of fixtures) {
      const item = local.find(row => row.id === fixture.item.id)!;
      expect(item.signCount).toBe(0);
      expect(Buffer.from(item.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(fixture.item.privateKeyPkcs8!, 'base64'));
      if (item.id === 'restricted') { expect(item.backupEligible).toBe(false); expect(item.providerRefs[0].remoteId).toBeUndefined(); continue; }
      if (ambiguous.some(row => row.item.id === item.id)) { expect(item.providerRefs[0].remoteId).toBeUndefined(); continue; }
      const remote = rows.find(row => item.providerRefs[0].remoteId?.startsWith(`${row.id}#`))!;
      const decoded = (await decodeBitwardenCipher(remote, providerId, key)).items.find(row => row.kind === 'passkey') as PasskeyItem;
      expect(decoded.credentialId).toBe(fixture.id);
      expect(Buffer.from(decoded.privateKeyPkcs8!, 'base64')).toEqual(Buffer.from(fixture.item.privateKeyPkcs8!, 'base64'));
    }
    await context!.route(`${origin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Synthetic Passkey recovery</title>
      <button id="login">Sign in</button><output id="result"></output><script>
      window.credentialId='';login.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rpId}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required'})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};</script>` }));
    const website = await context!.newPage(); await website.goto(origin);
    const recovered = fixtures.filter(row => row.item.id !== 'restricted' && !ambiguous.some(other => other.item.id === row.item.id));
    for (const fixture of recovered) {
      await website.evaluate(id => { (window as any).credentialId = id; }, fixture.id);
      await website.locator('#login').click();
      await expect(website.locator('#monica-passkey-prompt-host')).toHaveCount(1);
      await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
      await website.keyboard.press('Home'); await website.keyboard.press('Tab'); await website.keyboard.press('Tab');
      const opened = context!.waitForEvent('page'); await website.keyboard.press('Enter'); const confirmation = await opened;
      await confirmation.getByLabel('Monica 主密码', { exact: true }).fill(password);
      await confirmation.getByRole('button', { name: '确认', exact: true }).click();
      await expect(website.locator('#result')).toHaveText('authenticated');
      const assertion = await website.evaluate(() => (window as any).assertion);
      expect(assertion.id).toBe(fixture.id); expect(assertion.response.userHandle).toBe('dXNlcg');
      const auth = Buffer.from(assertion.response.authenticatorData, 'base64url'), client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
      expect(auth.readUInt32BE(33)).toBe(0); expect(auth[32] & 0x0d).toBe(0x0d);
      expect(JSON.parse(client.toString())).toMatchObject({ origin, challenge, type: 'webauthn.get' });
      expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]),
        createPublicKey({ key: Buffer.from(fixture.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    }
    expect(writes).toHaveLength(loss === 'headers' ? 4 : 3); expect(unexpected).toEqual([]);
    await info.attach('acceptance', { contentType: 'application/json', body: JSON.stringify({ fullRestart: true, responseLoss: loss,
      recovered: recovered.length, independentSignatures: recovered.length, zeroCounters: true, restrictedUploads: 0,
      observedHttpCreates: writes.length, ambiguityRetained: ambiguous.length, writesAfterRestart: 0, observations }) });
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    key.encKey.fill(0); key.macKey.fill(0);
  }
});
