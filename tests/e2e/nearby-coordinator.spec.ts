import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';

const app = (page: Page, method: string, args: unknown[] = []): Promise<any> => page.evaluate(({ method, args }) => (window as any).nearbyApp[method](...args), { method, args });

for (const history of ['retained', 'legacy-purge', 'historical-tombstone', 'explicit-include'] as const) test(`incremental nearby deletion policy after ${history}`, async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge and Native Messaging'); test.setTimeout(120000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'); await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic nearby deletion regression', version: '1.0.0', permissions: ['nativeMessaging', 'storage'], content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }, background: { service_worker: 'worker.js' } }));
  await writeFile(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><script src="harness.js"></script>');
  await build({ entryPoints: [path.resolve('tests/e2e/fixtures/nearby-application.ts')], bundle: true, format: 'iife', target: 'chrome130', alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') }, outfile: path.join(extension, 'harness.js') });
  const contexts: BrowserContext[] = [];
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const launch = async (name: string) => {
    const appData = path.join(run, `appdata-${name}`); await mkdir(appData, { recursive: true });
    const context = await launchEdgeContext(path.join(run, `profile-${name}`), { env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }); contexts.push(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host, page = await context.newPage();
    await page.goto(`chrome-extension://${id}/index.html`); await page.waitForFunction(() => Boolean((window as any).nearbyApp));
    return { page, id };
  };
  const complete = async (a: Page, b: Page, receiveChoice: 'omit' | 'include' = 'omit') => expect.poll(async () => {
    const pages = [a, b], views = await Promise.all(pages.map(page => app(page, 'coordinatorPoll')));
    for (let i = 0; i < views.length; i++) if (views[i].deletionReview?.incoming) {
      expect(views[i].phase).toBe('review'); expect(views[i].deletionReview.count).toBe(1);
      await app(pages[i], 'coordinatorConfirmDeletions', [views[i].deletionReview.id, receiveChoice]);
    }
    return views.map(view => view.phase);
  }, { timeout: 25000 }).toEqual(['completed', 'completed']);
  try {
    const { page: a, id } = await launch('a'); registration = await temporaryNativeHost(id, path.join(run, 'native'));
    const { page: b } = await launch('b'); await app(a, 'seed', [false]); await app(b, 'seed', [false]); await app(a, 'standaloneOtp', ['create']);
    const pairing = await app(a, 'coordinatorPair'); await app(b, 'coordinatorPair', [pairing.pairing.invitations[0]]); await complete(a, b);
    const peerA = (await app(a, 'coordinatorStatus')).peerId, peerB = (await app(b, 'coordinatorStatus')).peerId;
    const sync = async () => {
      const prepared = await app(a, 'coordinatorPrepare', [peerA]);
      // Before the fix this goes straight to ready and sends an unreviewed deletion.
      if (prepared.deletionReview) await app(a, 'coordinatorConfirmDeletions', [prepared.deletionReview.id, history === 'explicit-include' ? 'include' : 'omit']);
      await app(b, 'coordinatorPrepare', [peerB]);
      const aListens = (await app(a, 'preferences')).deviceId > (await app(b, 'preferences')).deviceId;
      const listener = await app(aListens ? a : b, 'coordinatorStart');
      await app(aListens ? b : a, 'coordinatorStart', [listener.endpoint]); await complete(a, b, history === 'explicit-include' ? 'include' : 'omit');
      return prepared;
    };
    await sync();
    if (history !== 'retained') await app(a, 'setIncremental', [false]);
    await app(a, 'standaloneOtp', ['purge']);
    if (history === 'historical-tombstone') { await app(a, 'coordinatorPrepare', [peerA]); await app(a, 'coordinatorClose'); }
    await app(a, 'setIncremental', [true]);
    const prepared = await sync();
    expect(await app(b, 'standaloneOtp', ['inspect'])).toEqual({ secret: 'JBSWY3DPEHPK3PXP', deleted: history === 'explicit-include' });
    if (history !== 'retained') expect(prepared.deletionReview).toMatchObject({ count: 1 });
    expect((await app(a, 'preferences')).view.incrementalOnly).toBe(true);
    if (history === 'explicit-include') {
      expect((await app(a, 'coordinatorStatus')).result.includedDeletions).toBe(1);
      expect((await app(a, 'coordinatorPrepare', [peerA])).deletionReview).toMatchObject({ count: 1 });
    }
    await app(a, 'coordinatorClose'); await app(b, 'coordinatorClose');
  } finally { for (const context of contexts) await context.close(); await registration?.restore(); }
});

for (const paged of [false, true]) test(`production nearby coordinator ${paged ? 'recovers paginated partial adoption' : 'pairs without source content and recovers reciprocal local adoption'}`, async ({}, info) => {
  test.skip(process.platform !== 'win32', 'Installed Edge and Native Messaging'); test.setTimeout(180000);
  const run = path.resolve(info.outputPath('isolated')), extension = path.join(run, 'extension'); await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Synthetic Monica nearby coordinator', version: '1.0.0',
    permissions: ['nativeMessaging', 'storage'], content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }, background: { service_worker: 'worker.js' } }));
  await writeFile(path.join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(path.join(extension, 'index.html'), '<!doctype html><title>Nearby coordinator acceptance</title><script src="harness.js"></script>');
  await build({ entryPoints: [path.resolve('tests/e2e/fixtures/nearby-application.ts')], bundle: true, format: 'iife', target: 'chrome130',
    alias: { crypto: path.resolve('scripts/stubs/node-crypto.js') }, outfile: path.join(extension, 'harness.js') });
  const contexts = new Map<string, BrowserContext>(), errors: string[] = [];
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined, extensionId = '';
  const evidence: Record<string, any> = { status: 'failed', managerUi: false, androidApplicationAcceptance: false, phases: [] };
  const launch = async (name: string) => {
    const appData = path.join(run, `appdata-${name}`); await mkdir(appData, { recursive: true });
    const context = await launchEdgeContext(path.join(run, `profile-${name}`), { env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] }); contexts.set(name, context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/index.html`); await page.waitForFunction(() => Boolean((window as any).nearbyApp));
    evidence.edgeVersion = context.browser()?.version(); return page;
  };
  const complete = async (a: Page, b: Page) => {
    await expect.poll(async () => (await Promise.all([app(a, 'coordinatorPoll'), app(b, 'coordinatorPoll')])).map(view => view.phase), { timeout: 25000 }).toEqual(['completed', 'completed']);
  };
  const prepare = async (page: Page, id: string) => {
    const view = await app(page, 'coordinatorPrepare', [id]);
    if (view.phase === 'review') return app(page, 'coordinatorConfirm', [view.review.id]);
    expect(view.phase).toBe('ready'); return view;
  };
  const connect = async (a: Page, b: Page) => {
    const aListens = (await app(a, 'preferences')).deviceId > (await app(b, 'preferences')).deviceId;
    const listener = await app(aListens ? a : b, 'coordinatorStart');
    await app(aListens ? b : a, 'coordinatorStart', [listener.endpoint]);
  };
  try {
    let a = await launch('a'); registration = await temporaryNativeHost(extensionId, path.join(run, 'native'));
    let b = await launch('b'); const original = await app(a, 'seed', [true]); await app(b, 'seed', [false]);
    if (paged) await app(a, 'seedAdditional', [300]);
    const originalIds = await app(a, 'itemIds');
    const pair = await app(a, 'coordinatorPair'); await app(b, 'coordinatorPair', [pair.pairing.invitations[0]]);
    await complete(a, b);
    const peerA = (await app(a, 'coordinatorStatus')).peerId, peerB = (await app(b, 'coordinatorStatus')).peerId;
    expect(await app(b, 'itemIds')).toEqual([]); expect(await app(a, 'itemIds')).toEqual(originalIds);
    evidence.phases.push('real-pairing-only-no-source-content');
    const review = await app(a, 'coordinatorPrepare', [peerA]); expect(review.phase).toBe('review');
    expect(review.review.issues).toMatchObject([{ skipForCounter: true }]);
    await app(a, 'coordinatorConfirm', [review.review.id]); await prepare(b, peerB);
    await connect(a, b);
    await expect.poll(async () => {
      try { await app(b, 'coordinatorPoll', [true]); } catch { return 'failed'; }
      return 'waiting';
    }, { timeout: 20000 }).toBe('failed');
    // The actual local encrypted commit succeeded; no native apply/network ack
    // was emitted. Restart both browsers and recover using stored receipts.
    const firstIds = await app(b, 'itemIds'); expect(firstIds).toHaveLength(paged ? 200 : 6);
    if (!paged) {
      const received = await app(b, 'inspect'); expect(received.signatureVerified).toBe(true);
      expect(received.privateKeyHash).toBe(original.privateKeyHash); expect(received.attachmentHash).toBe(original.sha256);
    }
    await app(a, 'coordinatorClose');
    for (const context of contexts.values()) await context.close(); contexts.clear();
    a = await launch('a'); b = await launch('b');
    if (!paged) await app(b, 'edit'); const targetIds = await app(b, 'itemIds');
    await prepare(a, peerA); const preparedB = await prepare(b, peerB);
    expect(Boolean(preparedB.recoveryOnly)).toBe(paged);
    await connect(a, b);
    await complete(a, b);
    if (paged) {
      await app(b, 'editAdditional'); await prepare(a, peerA); await prepare(b, peerB);
      await connect(a, b);
      await complete(a, b);
      expect(await app(a, 'additionalEditCount')).toBe(300); expect(await app(b, 'additionalEditCount')).toBe(300);
      evidence.phases.push('300-reciprocal-updates-across-legacy-scope-normalization');
    }
    const source = await app(a, 'inspect'), target = await app(b, 'inspect');
    if (!paged) { expect(source.one.notes).toBe('after-restart edit'); expect(target.one.notes).toBe('after-restart edit'); }
    expect(source.count).toBe(paged ? 307 : 7); expect(target.count).toBe(paged ? 306 : 6);
    expect((await app(a, 'itemIds')).map((row: any) => row.id).sort()).toEqual(originalIds.map((row: any) => row.id).sort());
    const finalIds = new Set((await app(b, 'itemIds')).map((row: any) => row.id));
    for (const item of targetIds) expect(finalIds.has(item.id)).toBe(true);
    for (const result of [source, target]) {
      expect(result).toMatchObject({ privateKeyHash: original.privateKeyHash, credentialId: original.credentialId, publicKey: original.publicKey,
        attachmentHash: original.sha256, attachmentBytes: 600000, signatureVerified: true, note: 'Bound note', sso: 'SSO identity', otp: 'Bound OTP' });
    }
    expect(source.countHistory).toEqual([0, 19]); expect(target.countHistory).toEqual([0]);
    evidence.phases.push('stored-application-reply-loss-no-ack', 'both-browser-restart-receipt-replay', paged ? 'remaining-pages-recovered-with-receive-only-transfer' : 'reciprocal-update-preserves-original-local-ids-and-project');
    evidence.status = 'passed'; evidence.records = paged ? 306 : 6; evidence.originalKeyVerified = true; evidence.attachmentBytes = 600000; evidence.errors = errors; evidence.native = registration.evidence;
    await app(a, 'coordinatorClose'); await app(b, 'coordinatorClose'); expect(errors).toEqual([]);
  } finally {
    for (const context of contexts.values()) await context.close();
    try { await registration?.restore(); } finally { await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2)); }
  }
});
