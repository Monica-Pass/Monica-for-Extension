import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

const app = (page: Page, method: string, args: unknown[] = []): Promise<any> => page.evaluate(({ method, args }) => (window as any).nearbyApp[method](...args), { method, args });
const rpc = (page: Page, operation: string, params: object = {}) => app(page, 'call', [operation, params]);
const device = (id: string) => ({ device_id: id, name: id, sync_mode: 'bidirectional' });

test('nearby transport durably adopts local projects and original keys before acknowledgement', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge and Native Messaging'); test.setTimeout(180000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'); await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic Monica nearby adoption', version: '1.0.0',
    permissions: ['nativeMessaging', 'storage'], content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }, background: { service_worker: 'worker.js' } }));
  await writeFile(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Nearby adoption acceptance</title><script src="harness.js"></script>');
  await build({ entryPoints: [path.resolve('tests/e2e/fixtures/nearby-application.ts')], bundle: true, format: 'iife', target: 'chrome130',
    alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') }, outfile: path.join(extension, 'harness.js') });
  const contexts = new Map<string, BrowserContext>(); const errors: string[] = [];
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const evidence: Record<string, any> = { status: 'failed', managerUiAcceptance: false, androidApplicationAcceptance: false, phases: [] };
  let extensionId: string;
  const launch = async (name: string) => {
    const appData = path.join(run, `appdata-${name}`); await mkdir(appData, { recursive: true });
    const context = await launchEdgeContext(path.join(run, `profile-${name}`), { env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }); contexts.set(name, context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/index.html`); await page.waitForFunction(() => Boolean((window as any).nearbyApp));
    evidence.edgeVersion = context.browser()?.version(); return page;
  };
  const wait = async (page: Page, session: string, phase: string) => {
    await expect.poll(async () => (await rpc(page, 'progress', { handle: session })).phase, { timeout: 20000 }).toBe(phase);
  };
  try {
    const a = await launch('a'); registration = await temporaryNativeHost(extensionId!, path.join(run, 'native'));
    let b = await launch('b'); const source = await app(a, 'seed', [true]); await app(b, 'seed', [false]);
    const replicaKeyA = randomBytes(32).toString('base64url'), replicaKeyB = randomBytes(32).toString('base64url'), storageB = randomUUID();
    const ar = (await rpc(a, 'replica_open', { storage_id: randomUUID(), device_id: 'a', key: replicaKeyA })).handle;
    let br = (await rpc(b, 'replica_open', { storage_id: storageB, device_id: 'b', key: replicaKeyB })).handle;
    const ax = await app(a, 'snapshot', [ar]), bx = await app(b, 'snapshot', [br]);
    expect(ax.recordCount).toBe(7); expect(ax.issues).toHaveLength(1); expect(ax.issues[0].skipForCounter).toBe(true);
    const started = await rpc(a, 'start', { snapshot: ax.handle, device: device('a'), listen_address: '127.0.0.1' });
    const sb = (await rpc(b, 'connect', { snapshot: bx.handle, device: device('b'), invitation: started.invitations[0] })).handle;
    await wait(a, started.handle, 'received'); await wait(b, sb, 'received');
    await rpc(b, 'replica_merge', { handle: br, session: sb });
    const pending = await rpc(b, 'replica_pending', { handle: br }); expect(pending.items).toHaveLength(6);
    await expect(app(b, 'adopt', [br, sb, true])).rejects.toThrow('synthetic stored response lost');
    expect((await rpc(b, 'replica_pending', { handle: br })).items).toHaveLength(6);
    evidence.phases.push('real-noise-merge-local-commit-response-lost-no-ack');
    await contexts.get('b')!.close(); contexts.delete('b'); await rpc(a, 'cancel', { handle: started.handle });
    b = await launch('b'); br = (await rpc(b, 'replica_open', { storage_id: storageB, device_id: 'b', key: replicaKeyB })).handle;
    const restored = await app(b, 'inspect');
    expect(restored).toMatchObject({ count: 6, note: 'Bound note', sso: 'SSO identity', otp: 'Bound OTP', credentialId: source.credentialId,
      publicKey: source.publicKey, privateKeyHash: source.privateKeyHash, countHistory: [0], attachmentHash: source.sha256, attachmentBytes: 600000, signatureVerified: true });
    expect(restored.one).toMatchObject({ passwordGroupId: source.group, appPackageName: 'synthetic.application', addressLine: 'Synthetic street' });
    for (const secret of ['synthetic-first-password', 'old synthetic password', 'Synthetic secret note']) expect(JSON.stringify(restored.encrypted)).not.toContain(secret);
    // Remote scratch assets no longer exist; the encrypted transaction already
    // owns the complete files. Recovery only returns its saved acknowledgement.
    await app(b, 'edit'); const before = (await app(b, 'inspect')).encrypted;
    expect(await app(b, 'adopt', [br])).toBe(6);
    expect((await rpc(b, 'replica_pending', { handle: br })).items).toHaveLength(0);
    const after = await app(b, 'inspect'); expect(after.encrypted).toEqual(before); expect(after.one.notes).toBe('after-restart edit');
    const captured = JSON.parse(await app(b, 'captured'));
    expect(captured.records).toHaveLength(6);
    expect(captured.records.find((row: any) => row.data.title === 'Nearby project one').data.notes).toBe('after-restart edit');
    expect(captured.assets).toHaveLength(1);
    expect((await app(a, 'inspect')).countHistory).toEqual([0, 19]);
    evidence.phases.push('full-restart-local-readback-original-signature-and-file', 'saved-ack-recovery-preserves-later-edit-and-reexport');
    evidence.status = 'passed'; evidence.records = 6; evidence.attachmentBytes = 600000; evidence.originalPrivateBytesPreserved = true;
    evidence.errors = errors; evidence.native = registration.evidence; expect(errors).toEqual([]);
    await rpc(a, 'close_all'); await rpc(b, 'close_all');
  } finally {
    for (const context of contexts.values()) await context.close();
    try { await registration?.restore(); } finally { await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
  }
});
