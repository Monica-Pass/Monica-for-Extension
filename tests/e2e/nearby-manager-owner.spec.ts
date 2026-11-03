import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createConnection } from 'node:net';
import path from 'node:path';
import { createLoginItem, type PasskeyItem } from '../../src/core/model';
import { createPasskey } from '../../src/passkey/webauthn-core';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

const password = 'Synthetic nearby manager password';
async function runtime(page: Page, request: unknown): Promise<any> {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
async function connect(page: Page): Promise<void> {
  await page.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'monica-nearby-manager-v1' });
    const state = { port, id: 0, messages: [] as any[], disconnected: false };
    (window as any).nearbyManagerTest = state;
    port.onMessage.addListener(value => state.messages.push(value));
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; state.disconnected = true; });
  });
  await page.waitForFunction(() => (window as any).nearbyManagerTest.messages.some((m: any) => m.type === 'ready'));
}
async function command(page: Page, request: Record<string, unknown>): Promise<any> {
  const id = await page.evaluate(request => {
    const state = (window as any).nearbyManagerTest; const id = ++state.id; state.port.postMessage({ ...request, id }); return id;
  }, request);
  await page.waitForFunction(id => (window as any).nearbyManagerTest.messages.some((m: any) => m.id === id), id);
  const result = await page.evaluate(id => (window as any).nearbyManagerTest.messages.find((m: any) => m.id === id), id);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
async function closed(page: Page, reason: string) {
  await page.waitForFunction(reason => (window as any).nearbyManagerTest.messages.some((m: any) => m.type === 'closed' && m.reason === reason), reason);
}
async function cancel(page: Page) {
  await page.evaluate(() => { const s = (window as any).nearbyManagerTest; s.port.postMessage({ id: ++s.id, type: 'cancel' }); });
  await closed(page, 'cancelled');
}
function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(500, () => finish(false));
  });
}

test('production nearby manager owns cancellation, trust and recovery across real Edge restarts', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge and Native Messaging'); test.setTimeout(180000);
  const extension = path.resolve('dist'), run = path.resolve(info.outputPath('isolated')); await mkdir(run, { recursive: true });
  const contexts = new Map<string, BrowserContext>(), evidence: Record<string, any> = { status: 'failed', productionBackground: true, managerUi: false, androidApplicationAcceptance: false, phases: [] };
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined, extensionId = '';
  const launch = async (name: string) => {
    const appData = path.join(run, `appdata-${name}`); await mkdir(appData, { recursive: true });
    const context = await launchEdgeContext(path.join(run, `profile-${name}`), { env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }); contexts.set(name, context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    await page.waitForLoadState('domcontentloaded'); evidence.edgeVersion = context.browser()?.version(); return page;
  };
  const complete = async (a: Page, b: Page) => {
    await expect.poll(async () => (await Promise.all([command(a, { type: 'progress' }), command(b, { type: 'progress' })])).map(v => v.phase), { timeout: 20000 }).toEqual(['completed', 'completed']);
  };
  const prepare = async (page: Page, peerId: string) => {
    const view = await command(page, { type: 'prepare', peerId });
    if (view.phase === 'review') await command(page, { type: 'confirm', reviewId: view.review.id });
    else expect(view.phase).toBe('ready');
  };
  try {
    let a = await launch('a'); registration = await temporaryNativeHost(extensionId, path.join(run, 'native'));
    let b = await launch('b');
    await runtime(a, { type: 'VAULT_SETUP', masterPassword: password }); await runtime(b, { type: 'VAULT_SETUP', masterPassword: password });
    const key = await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 5).toString('base64url'), rpName: 'Synthetic',
      userId: 'c3ludGhldGlj', userName: 'synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] });
    const passkey: PasskeyItem = { ...createLoginItem({ title: 'Synthetic zero Passkey' }), kind: 'passkey', rpId: key.rpId, rpName: 'Synthetic',
      userHandle: 'c3ludGhldGlj', userName: 'synthetic', userDisplayName: 'Synthetic', credentialId: key.credentialId,
      publicKey: key.publicKeySpki, privateKeyPkcs8: key.privateKeyPkcs8, signCount: 0, algorithm: -7, discoverable: true, backupEligible: true, sourceMode: 'browser-local' };
    const positive = { ...passkey, id: crypto.randomUUID(), title: 'Synthetic positive Passkey', credentialId: Buffer.alloc(32, 9).toString('base64url'), signCount: 19 };
    const login = createLoginItem({ title: 'Synthetic original login', password: 'synthetic password' });
    await runtime(a, { type: 'VAULT_IMPORT_ITEMS', items: [login, passkey, positive] });
    await connect(a); await connect(b);
    const popup = await contexts.get('a')!.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const denied = await popup.evaluate(() => new Promise<any[]>(resolve => {
      const port = chrome.runtime.connect({ name: 'monica-nearby-manager-v1' }); const messages:any[] = [];
      port.onMessage.addListener(message => messages.push(message)); port.onDisconnect.addListener(() => { void chrome.runtime.lastError; resolve(messages); });
    })); expect(denied).toEqual([{type:'closed',reason:'manager-context-invalid'}]); await popup.close();
    const pair = await command(a, { type: 'pair' });
    await command(b, { type: 'pair', invitation: pair.pairing.invitations[0] }); await complete(a, b);
    const peerA = (await command(a, { type: 'status' })).peerId, peerB = (await command(b, { type: 'status' })).peerId;
    // Each side names its peer; the local device ID is the other side's peer ID.
    const startTransfer=async()=>{
      const aListens=peerB>peerA;
      const listener=await command(aListens?a:b,{type:'start'});
      await command(aListens?b:a,{type:'start',endpoint:listener.endpoint});
      return listener;
    };
    expect(await runtime(b, { type: 'VAULT_LIST_ITEMS' })).toEqual([]);
    evidence.phases.push('production-port-rejects-popup-and-pairs-without-content');

    await prepare(a, peerA); await prepare(b, peerB);
    const interrupted = await startTransfer();
    await runtime(a, { type: 'VAULT_LOCK' }); await closed(a, 'vault-locked'); await cancel(b);
    await expect.poll(() => listening(interrupted.endpoint.port)).toBe(false);
    expect(await runtime(b, { type: 'VAULT_LIST_ITEMS' })).toEqual([]);
    evidence.phases.push('lock-closes-real-native-listener-before-application-adoption');
    for (const context of contexts.values()) await context.close(); contexts.clear();
    a = await launch('a'); b = await launch('b');
    await runtime(a, { type: 'VAULT_UNLOCK', masterPassword: password }); await runtime(b, { type: 'VAULT_UNLOCK', masterPassword: password });
    await connect(a); await connect(b); await prepare(a, peerA); await prepare(b, peerB);
    await startTransfer(); await complete(a, b);
    const received: any[] = await runtime(b, { type: 'VAULT_LIST_ITEMS' }); expect(received).toHaveLength(2);
    const original = received.find(row => row.kind === 'passkey'); expect(original.credentialId).toBe(passkey.credentialId);
    expect(original.privateKeyPkcs8).toBe(passkey.privateKeyPkcs8); expect(original.signCount).toBe(0);
    const challenge = Buffer.from('synthetic post-restart signature');
    const signature = sign('sha256', challenge, createPrivateKey({ key: Buffer.from(original.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' }));
    expect(verify('sha256', challenge, createPublicKey({ key: Buffer.from(passkey.publicKey, 'base64'), format: 'der', type: 'spki' }), signature)).toBe(true);
    const source: any[] = await runtime(a, { type: 'VAULT_LIST_ITEMS' });
    expect(source.find(item => item.id === passkey.id)?.signCount).toBe(0);
    expect(source.find(item => item.id === positive.id)?.signCount).toBe(19);
    evidence.phases.push('browser-and-native-restart-reuses-trust-preserves-original-keys-zero-and-positive-history');

    const ownerName=peerB>peerA?'a':'b',ownerPeer=peerB>peerA?peerA:peerB;
    let owner=peerB>peerA?a:b;
    await prepare(owner, ownerPeer); const prefListener = await command(owner, { type: 'start' });
    const p = await command(owner, { type: 'preferences' });
    expect(Object.keys(p).sort()).toEqual(['enabled', 'epoch', 'incrementalOnly', 'intervalSeconds', 'localProviderId', 'mode', 'name', 'peers']);
    await command(owner, { type: 'update', epoch: p.epoch, change: { kind: 'preferences', mode: 'receive_only' } });
    await expect.poll(() => listening(prefListener.endpoint.port)).toBe(false);
    expect(await command(owner, { type: 'status' })).toEqual({ phase: 'idle' });
    evidence.phases.push('preference-change-closes-native-ownership-without-exposing-trust');

    await prepare(owner, ownerPeer); const disposeListener = await command(owner, { type: 'start' }); await owner.close();
    await expect.poll(() => listening(disposeListener.endpoint.port)).toBe(false);
    owner = await contexts.get(ownerName)!.newPage(); await owner.goto(`chrome-extension://${extensionId}/index.html`); await connect(owner);
    await prepare(owner, ownerPeer); const expiryListener = await command(owner, { type: 'start' });
    await owner.evaluate(async () => {
      const key = 'monica.secureVault.session.v1', data = await chrome.storage.session.get(key);
      await chrome.storage.session.set({ [key]: { ...(data[key] as Record<string, unknown>), expiresAt: Date.now() + 300 } });
    });
    await closed(owner, 'session-expired'); await expect.poll(() => listening(expiryListener.endpoint.port)).toBe(false);
    evidence.phases.push('manager-document-close-and-session-deadline-stop-real-native-listeners');
    evidence.status = 'passed';
  } finally {
    for (const context of contexts.values()) await context.close(); await registration?.restore();
    evidence.backgroundSha256 = createHash('sha256').update(await readFile(path.join(extension, 'background.js'))).digest('hex');
    await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
