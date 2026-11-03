import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';
import { createEmptyVaultState, createLoginItem, type PasskeyItem } from '../../src/core/model';
import { createPasskey } from '../../src/passkey/webauthn-core';
import { nearbyLocalItemToWire } from '../../src/nearby/application-codec';
import { applyNearbyLocalBatch, nearbyLocalSourceHash, type NearbyIncomingRecord } from '../../src/nearby/local-adoption';
import { deriveVaultKey, encryptVaultState, decryptVaultState } from '../../src/security/vault-crypto';
import { parseLosslessJson } from '../../src/core/lossless-json';
import { createSourceRecord } from '../../src/core/source-records';

const master = 'Synthetic nearby metadata password';
async function runtime(page: Page, request: unknown): Promise<any> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  expect(response.ok, JSON.stringify(response)).toBe(true); return response.data;
}
async function openPort(page: Page) {
  await page.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'monica-nearby-manager-v1' }), state = { port, id: 0, replies: [] as any[] };
    (window as any).nearbyMetadataTest = state; port.onMessage.addListener(reply => state.replies.push(reply));
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
  });
  await page.waitForFunction(() => (window as any).nearbyMetadataTest.replies.some((r: any) => r.type === 'ready'));
}
async function command(page: Page, request: Record<string, unknown>): Promise<any> {
  const id = await page.evaluate(request => { const s = (window as any).nearbyMetadataTest; s.port.postMessage({ ...request, id: ++s.id }); return s.id; }, request);
  await page.waitForFunction(id => (window as any).nearbyMetadataTest.replies.some((r: any) => r.id === id), id);
  const result = await page.evaluate(id => (window as any).nearbyMetadataTest.replies.find((r: any) => r.id === id), id);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
async function state(page: Page) {
  const backup = await runtime(page, { type: 'VAULT_EXPORT_ENCRYPTED', backupPassword: master });
  return decryptVaultState(backup.envelope, (await deriveVaultKey(master, backup.envelope.kdf)).key);
}

test('production nearby transfers Android-shaped folders root tags and original Passkeys across restarts', async ({}, info) => {
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
    evidence.edgeVersion = context.browser()?.version(); return page;
  };
  const complete = async (a: Page, b: Page) => expect.poll(async () => (await Promise.all([command(a, { type: 'progress' }), command(b, { type: 'progress' })])).map(view => view.phase), { timeout: 30000 }).toEqual(['completed', 'completed']);
  const prepare = async (page: Page, peerId: string) => {
    const review = await command(page, { type: 'prepare', peerId });
    if (review.phase === 'review') await command(page, { type: 'confirm', reviewId: review.review.id }); else expect(review.phase).toBe('ready');
  };
  try {
    let a = await launch('a'); registration = await temporaryNativeHost(extensionId, path.join(run, 'native')); let b = await launch('b');
    const parent = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222', root = '33333333-3333-4333-8333-333333333333';
    const parentPath = [{ id: parent, title: 'Same name', parent: null }], childPath = [...parentPath, { id: child, title: 'Same name', parent }];
    const key = await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 3).toString('base64url'), rpName: 'Synthetic',
      userId: 'dXNlcg', userName: 'Synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] });
    const passkey: PasskeyItem = { ...createLoginItem({ title: 'Synthetic portable key' }), kind: 'passkey', sourceMode: 'browser-local', rpId: key.rpId, rpName: 'Synthetic',
      userHandle: 'dXNlcg', userName: 'Synthetic', userDisplayName: 'Synthetic', credentialId: key.credentialId,
      publicKey: key.publicKeySpki, privateKeyPkcs8: key.privateKeyPkcs8, signCount: 0, algorithm: -7, discoverable: true, backupEligible: true };
    const positive = { ...passkey, id: crypto.randomUUID(), title: 'Synthetic positive history', credentialId: Buffer.alloc(32, 8).toString('base64url'), signCount: 19 };
    const payload = '{"wide":9007199254740993,"decimal":1.00000000000000001}';
    const records: NearbyIncomingRecord[] = [
      { id: parent, deleted: false, clockJson: '{"android":1}', dataJson: JSON.stringify({ title: 'Same name', folder: '', entry_type: 'folder', payload: { path: parentPath, tags: [{ name: 'parent tag', payload, version: 1 }] } }) },
      { id: child, deleted: false, clockJson: '{"android":1}', dataJson: JSON.stringify({ title: 'Same name', folder: '', entry_type: 'folder', payload: { path: childPath } }) },
      { id: root, deleted: false, clockJson: '{"android":1}', dataJson: JSON.stringify({ title: 'Root metadata', folder: '', entry_type: 'vault-metadata', payload: { tags: [{ name: 'root tag', payload, version: 1 }] } }) }
    ];
    records.push({ id: '44444444-4444-4444-8444-444444444444', deleted: true, clockJson: '{"android":2}', dataJson: '{}' });
    const bytes = Buffer.alloc(600000, 42), sha = createHash('sha256').update(bytes).digest('hex');
    for (const [index, item] of [createLoginItem({ title: 'Classified login', password: 'synthetic secret' }), passkey, positive].entries()) {
      records.push({ id: crypto.randomUUID(), deleted: false, clockJson: '{"android":1}', dataJson: JSON.stringify(await nearbyLocalItemToWire(item,
        { folder: 'Same name', folder_path: childPath, assets: index === 0 ? [{ id: sha, size: bytes.length, file_name: 'synthetic.bin', media_type: 'application/octet-stream' }] : [] })) });
    }
    const empty = createEmptyVaultState(), seed = (await applyNearbyLocalBatch(empty, { providerId: empty.providers[0].id, sourceHash: await nearbyLocalSourceHash(empty), records,
      assets: [{ id: sha, dataBase64: bytes.toString('base64') }] }, new Date().toISOString())).state;
    const { key: backupKey, kdf } = await deriveVaultKey(master);
    const seedLogin = seed.items.find(item => item.kind === 'login')!;
    const originRecords = await Promise.all(['bitwarden-cipher', 'keepass-entry', 'future-format'].map((format, index) => createSourceRecord({
      providerId: `former-${format}`, remoteId: `former-record-${index}`, itemId: 'former-item', revision: 'original-source-revision', format, encoding: 'json',
      payload: `{ "opaque":9007199254740993,"decimal":1.00000000000000001,"raw":"${'synthetic archive '.repeat(index === 2 ? 5000 : 1)}" }` })));
    seed.localItemOrigins = [{ itemId: seedLogin.id, records: originRecords }];
    await runtime(a, { type: 'VAULT_RESTORE_ENCRYPTED', backupPassword: master, backup: { magic: 'MONICA_EXTENSION_BACKUP', version: 1, exportedAt: new Date().toISOString(), envelope: await encryptVaultState(seed, backupKey, kdf) } });
    await runtime(b, { type: 'VAULT_SETUP', masterPassword: master }); await openPort(a); await openPort(b);
    const pair = await command(a, { type: 'pair' }); await command(b, { type: 'pair', invitation: pair.pairing.invitations[0] }); await complete(a, b);
    const peerA = (await command(a, { type: 'status' })).peerId, peerB = (await command(b, { type: 'status' })).peerId;
    await prepare(a, peerA); await prepare(b, peerB); const transfer = await command(a, { type: 'start' });
    await command(b, { type: 'start', endpoint: transfer.endpoint }); await complete(a, b);
    const received = await state(b); expect(received.items).toHaveLength(2); expect(received.nearbyLocalMetadata).toHaveLength(4); expect(received.localTransferFolders).toHaveLength(2);
    expect(received.nearbyLocalMetadata!.find(row => row.recordId === records[3].id)).toMatchObject({ deleted: true, dataJson: '{}' });
    for (const expected of records.slice(0, 3)) expect(parseLosslessJson(received.nearbyLocalMetadata!.find(row => row.recordId === expected.id)!.dataJson)).toEqual(parseLosslessJson(expected.dataJson));
    expect(received.localItemAttachments?.[0].sha256).toBe(sha);
    expect(createHash('sha256').update(Buffer.from(received.localItemAttachments![0].dataBase64, 'base64')).digest('hex')).toBe(sha);
    const copiedKey = received.items.find((item): item is PasskeyItem => item.kind === 'passkey')!;
    expect(copiedKey.privateKeyPkcs8).toBe(key.privateKeyPkcs8); expect(copiedKey.credentialId).toBe(key.credentialId); expect(copiedKey.signCount).toBe(0);
    const challenge = Buffer.from('synthetic nearby metadata signature'), signature = sign('sha256', challenge, createPrivateKey({ key: Buffer.from(copiedKey.privateKeyPkcs8!, 'base64'), format: 'der', type: 'pkcs8' }));
    expect(verify('sha256', challenge, createPublicKey({ key: Buffer.from(key.publicKeySpki, 'base64'), format: 'der', type: 'spki' }), signature)).toBe(true);
    evidence.phases.push('actual-noise-preserves-nested-empty-folder-root-tags-empty-tombstone-attachment-and-original-key');
    const login = received.items.find(item => item.kind === 'login')!;
    expect(received.localItemOrigins).toEqual([{ itemId: login.id, records: expect.arrayContaining(originRecords) }]);
    expect(received.localItemOrigins![0].records).toHaveLength(3);
    expect(received.providers).toHaveLength(1); expect(received.sourceRecords).toEqual([]);
    expect(login.providerRefs).toEqual([{ providerId: received.providers[0].id }]);
    evidence.phases.push('opaque-source-archives-preserved-without-live-provider-bindings');
    await runtime(b, { type: 'VAULT_UPSERT_ITEM', item: { ...login, notes: 'reciprocal edit' } });
    for (const context of contexts.values()) await context.close(); contexts.clear();
    a = await launch('a'); b = await launch('b');
    await runtime(a, { type: 'VAULT_UNLOCK', masterPassword: master }); await runtime(b, { type: 'VAULT_UNLOCK', masterPassword: master });
    await openPort(a); await openPort(b); await prepare(a, peerA); await prepare(b, peerB);
    const again = await command(a, { type: 'start' }); await command(b, { type: 'start', endpoint: again.endpoint }); await complete(a, b);
    const source = await state(a), target = await state(b);
    expect(source.items.find(item => item.id === seed.items.find(item => item.kind === 'login')!.id)?.notes).toBe('reciprocal edit');
    expect(source.items.filter((item): item is PasskeyItem => item.kind === 'passkey').map(item => item.signCount).sort((a, b) => a - b)).toEqual([0, 19]);
    expect(source.localItemOrigins).toEqual([{ itemId: seedLogin.id, records: expect.arrayContaining(originRecords) }]);
    expect(source.localItemOrigins![0].records).toHaveLength(3);
    expect(target.localItemOrigins).toEqual(received.localItemOrigins);
    expect(target.nearbyLocalMetadata).toHaveLength(4); expect(target.localTransferFolders).toHaveLength(2); expect(target.items.map(item => item.id).sort()).toEqual(received.items.map(item => item.id).sort());
    for (const expected of records.slice(0, 3)) expect(parseLosslessJson(target.nearbyLocalMetadata!.find(row => row.recordId === expected.id)!.dataJson)).toEqual(parseLosslessJson(expected.dataJson));
    evidence.phases.push('both-browser-native-restart-reciprocal-edit-retains-folder-and-content-identities'); evidence.status = 'passed';
  } finally {
    for (const context of contexts.values()) await context.close(); await registration?.restore();
    evidence.backgroundSha256 = createHash('sha256').update(await readFile(path.join(extension, 'background.js'))).digest('hex');
    await writeFile(path.join(run, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
