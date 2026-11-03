import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

const app = (page: Page, method: string, args: unknown[] = []): Promise<any> => page.evaluate(({ method, args }) => (window as any).nearbyApp[method](...args), { method, args });
const rpc = (page: Page, method: string, input: object = {}) => app(page, 'call', [method, input]);

test('encrypted nearby identity and real pairing trust survive browser restart and reject stale resurrection', async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge and Native Messaging'); test.setTimeout(120000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'); await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic Monica nearby preferences', version: '1.0.0',
    permissions: ['nativeMessaging', 'storage'], content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }, background: { service_worker: 'worker.js' } }));
  await writeFile(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Nearby preferences acceptance</title><script src="harness.js"></script>');
  await build({ entryPoints: [path.resolve('tests/e2e/fixtures/nearby-application.ts')], bundle: true, format: 'iife', target: 'chrome130',
    alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') }, outfile: path.join(extension, 'harness.js') });
  const contexts = new Map<string, BrowserContext>(), errors: string[] = [];
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined, extensionId = '';
  const evidence: Record<string, any> = { status: 'failed', productionCoordinator: false, androidApplicationAcceptance: false };
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
  const snapshot = async (page: Page) => {
    const replica = (await app(page, 'openOwnedReplica')).handle;
    return { ...await app(page, 'snapshot', [replica]), replica };
  };
  const mergeEmpty = async (page: Page, replica: string, session: string) => {
    await rpc(page, 'replica_merge', { handle: replica, session });
    expect((await rpc(page, 'replica_pending', { handle: replica })).items).toEqual([]);
  };
  try {
    let a = await launch('a'); registration = await temporaryNativeHost(extensionId, path.join(run, 'native'));
    let b = await launch('b'); await app(a, 'seed', [false]); await app(b, 'seed', [false]);
    const originalA = await app(a, 'preferences'), originalB = await app(b, 'preferences');
    expect(originalA.view.enabled).toBe(false); expect(originalB.view.enabled).toBe(false);
    const ax = await snapshot(a), bx = await snapshot(b);
    const first = await app(a, 'beginOwned', [ax.handle]);
    const firstB = await app(b, 'beginOwned', [bx.handle, first.invitations[0]]);
    await wait(a, first.handle, 'received'); await wait(b, firstB.handle, 'received');
    await mergeEmpty(a, ax.replica, first.handle); await mergeEmpty(b, bx.replica, firstB.handle);
    await app(a, 'rememberOwned', [first.handle]);
    await expect(app(b, 'rememberOwned', [firstB.handle, true])).rejects.toThrow('synthetic trust response lost');
    await contexts.get('a')!.close(); contexts.delete('a'); await contexts.get('b')!.close(); contexts.delete('b');
    a = await launch('a'); b = await launch('b');
    const restoredA = await app(a, 'preferences'), restoredB = await app(b, 'preferences');
    for (const [original, restored] of [[originalA, restoredA], [originalB, restoredB]]) {
      expect(restored.deviceId).toBe(original.deviceId); expect(restored.keyHash).toBe(original.keyHash); expect(restored.storageHash).toBe(original.storageHash);
      expect(restored.view.peers).toHaveLength(1); expect(restored.view.enabled).toBe(false);
    }
    expect(restoredA.view.peers[0].deviceId).toBe(originalB.deviceId); expect(restoredB.view.peers[0].deviceId).toBe(originalA.deviceId);
    const againA = await snapshot(a), againB = await snapshot(b);
    const second = await app(a, 'beginOwned', [againA.handle, undefined, originalB.deviceId]);
    const secondB = await app(b, 'beginOwned', [againB.handle, second.invitations[0], originalA.deviceId]);
    await wait(a, second.handle, 'received'); await wait(b, secondB.handle, 'received');
    await mergeEmpty(a, againA.replica, second.handle); await mergeEmpty(b, againB.replica, secondB.handle);
    await app(a, 'rememberOwned', [second.handle]); await app(b, 'rememberOwned', [secondB.handle]);
    await rpc(a, 'acknowledge', { handle: second.handle, success: true }); await rpc(b, 'acknowledge', { handle: secondB.handle, success: true });
    await wait(a, second.handle, 'completed'); await wait(b, secondB.handle, 'completed');
    const third = await app(a, 'beginOwned', [againA.handle, undefined, originalB.deviceId]);
    const thirdB = await app(b, 'beginOwned', [againB.handle, third.invitations[0], originalA.deviceId]);
    await wait(a, third.handle, 'received'); await wait(b, thirdB.handle, 'received');
    await app(b, 'forgetOwned', [originalA.deviceId]);
    await expect(app(b, 'rememberOwned', [thirdB.handle])).rejects.toThrow('stale-session');
    expect((await app(b, 'preferences')).view.peers).toEqual([]);
    await expect(app(b, 'beginOwned', [againB.handle, third.invitations[0], originalA.deviceId])).rejects.toThrow('peer forgotten');
    await rpc(a, 'close_all'); await rpc(b, 'close_all'); expect(errors).toEqual([]);
    evidence.status = 'passed'; evidence.realNoisePairing = true; evidence.storedTrustReplyLossRecovered = true;
    evidence.bothBrowsersRestarted = true; evidence.trustedReconnectCompleted = true; evidence.forgottenPeerNotResurrected = true;
    evidence.automaticNetworkingStayedDisabled = true; evidence.errors = errors; evidence.native = registration.evidence;
  } finally {
    for (const context of contexts.values()) await context.close();
    try { await registration?.restore(); } finally { await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
  }
});
