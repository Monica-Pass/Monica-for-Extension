import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { launchEdgeContext } from "./fixtures/edge";
import { temporaryNativeHost } from "./fixtures/native-host";

type Harness = {
  call(op: string, params?: Record<string, unknown>): Promise<any>;
  callJson(op: string, params: string): Promise<string>;
  append(snapshot: string, descriptor: { id: string; size: number }, bytes: number[]): Promise<void>;
  read(session: string, descriptor: { id: string; size: number }): Promise<number[]>;
};
const api = (page: Page, op: string, params: Record<string, unknown> = {}) => page.evaluate(({ op, params }) => (window as unknown as { nearby: Harness }).nearby.call(op, params), { op, params });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const local = (id: string, data: unknown) => ({ local_id: id, scope: "browser-test", guard: "saved-1", deleted: false, data });
const device = (node: string, mode = "bidirectional", pairId?: string) => ({ device_id: node, name: node, sync_mode: mode, ...(pairId ? { pair_id: pairId } : {}) });

test("Edge native LAN transport preserves a real key, large project and attachment through restart", async ({}, info) => {
  test.skip(process.platform !== "win32", "Installed Edge and Windows Native Messaging fixture");
  test.setTimeout(180_000);
  const run = path.resolve(info.outputPath("isolated")); await mkdir(run, { recursive: true });
  const extension = path.join(run, "extension"); await mkdir(extension);
  await writeFile(path.join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Monica synthetic nearby protocol acceptance", version: "1.0.0", permissions: ["nativeMessaging"], background: { service_worker: "worker.js" } }));
  await writeFile(path.join(extension, "worker.js"), "chrome.runtime.onInstalled.addListener(() => {});");
  await writeFile(path.join(extension, "index.html"), '<!doctype html><meta charset="utf-8"><title>Monica protocol acceptance</title><script src="harness.js"></script>');
  await build({ stdin: { contents: `import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from ${JSON.stringify(path.resolve("src/providers/mdbx2/native-client.ts"))};
    import { NearbyNativeTransport, appendNearbyAsset, readNearbyAsset } from ${JSON.stringify(path.resolve("src/nearby/native-transport.ts"))};
    import { parseLosslessJson } from ${JSON.stringify(path.resolve("src/core/lossless-json.ts"))};
    const transport = new NearbyNativeTransport(new Mdbx2NativeClient(createChromeMdbx2NativeRuntime()));
    window.nearby = { call: (op, params) => transport.call(op, params), callJson: async (op, params) => JSON.stringify(await transport.call(op, parseLosslessJson(params))), append: (h,d,b) => appendNearbyAsset(transport,h,d,new Uint8Array(b)), read: async (h,d) => Array.from(await readNearbyAsset(transport,h,d)) };`, resolveDir: process.cwd(), loader: "ts" }, outfile: path.join(extension, "harness.js"), bundle: true, format: "iife", target: "chrome130" });
  const appData = (name: string) => path.join(run, `appdata-${name}`);
  const profile = (name: string) => path.join(run, `profile-${name}`);
  const launch = async (name: string) => {
    await mkdir(appData(name), { recursive: true });
    return launchEdgeContext(profile(name), { env: { ...process.env, LOCALAPPDATA: appData(name), APPDATA: appData(name) }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  };
  let a: BrowserContext | undefined, b: BrowserContext | undefined;
  let registration: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const evidence: Record<string, unknown> = { status: "failed", androidApplicationAcceptance: false, managerUiAcceptance: false, transportSource: "pinned Android Rust core with documented extension JSON overlay" };
  try {
    a = await launch("a");
    const worker = a.serviceWorkers()[0] || await a.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    registration = await temporaryNativeHost(extensionId, path.join(run, "native"));
    const open = async (ctx: BrowserContext) => { const page = await ctx.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`); await page.waitForFunction(() => Boolean((window as unknown as { nearby?: unknown }).nearby)); return page; };
    const pa = await open(a); b = await launch("b"); let pb = await open(b);
    evidence.edgeVersion = a.browser()?.version();
    const credentials = await pa.evaluate(async () => {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      const enc = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
      return { privateKey: enc(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: enc(await crypto.subtle.exportKey("spki", pair.publicKey)), id: enc(crypto.getRandomValues(new Uint8Array(32)).buffer).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") };
    });
    const secrets = await pa.evaluate(() => {
      const key = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
      return { a: key(), b: key() };
    });
    const storageA = randomUUID(), storageB = randomUUID();
    const precision = (await api(pa, 'replica_open', { storage_id: randomUUID(), device_id: 'precision', key: secrets.a })).handle;
    await api(pa, 'replica_scan_begin', { handle: precision, scopes: ['browser-test'] });
    const numericData = '{"entry_type":"note","payload":{"n":9007199254740993,"decimal":1.00000000000000001,"exp":1e999,"zero":-0,"__proto__":{"literal":true},"marker":{"$serde_json::private::Number":"literal"}}}';
    const precisionParams = `{"handle":${JSON.stringify(precision)},"entries":[{"local_id":"precision","scope":"browser-test","guard":"saved-1","deleted":false,"data":${numericData}}]}`;
    await pa.evaluate(({ params }) => (window as unknown as { nearby: Harness }).nearby.callJson('replica_scan_batch', params), { params: precisionParams });
    await api(pa, 'replica_scan_end', { handle: precision });
    const precise = await pa.evaluate(async ({ handle }) => {
      const text = await (window as unknown as { nearby: Harness }).nearby.callJson('replica_local', JSON.stringify({ handle, local_ids: ['precision'], include_data: true }));
      return text;
    }, { handle: precision });
    for (const literal of ['9007199254740993', '1.00000000000000001', '1e999', '"zero":-0', '"__proto__":{"literal":true}', '"marker":{"$serde_json::private::Number":"literal"}']) expect(precise).toContain(literal);
    await api(pa, 'replica_close', { handle: precision });
    evidence.losslessNativeBoundary = true;
    const ar = (await api(pa, "replica_open", { storage_id: storageA, device_id: "browser-a", key: secrets.a })).handle;
    let br = (await api(pb, "replica_open", { storage_id: storageB, device_id: "browser-b", key: secrets.b })).handle;
    const bytes = Buffer.alloc(600_000, 137); const asset = { id: hash(bytes), size: bytes.length };
    const passkey = { entry_type: "passkey", payload: { credential_id: credentials.id, rp_id: "nearby.example.test", user_id: "AQID", public_key_algorithm: -7, public_key: credentials.publicKey, private_key_alias: credentials.privateKey, key_status: "portable", sign_count: 0, backup_eligible: true, backup_state: true } };
    const project = { entry_type: "password", payload: { title: "Synthetic project", passwords: ["first", "second"], notes: "rich-field-".repeat(70_000), extension: { future_field: true } }, assets: [asset] };
    const positive = { entry_type: "passkey", payload: { ...passkey.payload, credential_id: "BQYHCA", sign_count: 19 } };
    await api(pa, "replica_scan_begin", { handle: ar, scopes: ["browser-test"] });
    await api(pa, "replica_scan_batch", { handle: ar, entries: [local("key-zero", passkey), local("key-positive", positive), local("project", project)] });
    await pa.evaluate(({ handle, data }) => (window as unknown as { nearby: Harness }).nearby.callJson('replica_scan_batch', `{"handle":${JSON.stringify(handle)},"entries":[{"local_id":"precision","scope":"browser-test","guard":"saved-1","deleted":false,"data":${data}}]}`), { handle: ar, data: numericData });
    await api(pa, "replica_scan_end", { handle: ar });
    const ax = (await api(pa, "replica_export", { handle: ar })).handle;
    await pa.evaluate(async ({ ax, asset, bytes }) => (window as unknown as { nearby: Harness }).nearby.append(ax, asset, bytes), { ax, asset, bytes: Array.from(bytes) });
    const bx = (await api(pb, "replica_export", { handle: br })).handle;
    const started = await api(pa, "start", { snapshot: ax, device: device("browser-a"), listen_address: "127.0.0.1" });
    const sa = started.handle;
    const sb = (await api(pb, "connect", { snapshot: bx, device: device("browser-b"), invitation: started.invitations[0] })).handle;
    const wait = async (page: Page, session: string, phase: string) => {
      await expect.poll(async () => (await api(page, "progress", { handle: session })).phase, { timeout: 20_000 }).toBe(phase);
      return api(page, "progress", { handle: session });
    };
    const peer = await wait(pa, sa, "received"); await wait(pb, sb, "received");
    expect(peer.received_directory).toBeUndefined(); expect(peer.peer.pairing.content_key).toBeUndefined();
    await api(pb, "replica_merge", { handle: br, session: sb });
    const first = await api(pb, "replica_pending", { handle: br });
    expect(first.items).toHaveLength(3);
    const verifyPendingPrecision = async () => {
      const text = await pb.evaluate(handle => (window as unknown as { nearby: Harness }).nearby.callJson('replica_pending', JSON.stringify({ handle })), br);
      for (const literal of ['9007199254740993', '1.00000000000000001', '1e999', '"zero":-0', '"__proto__":{"literal":true}', '"marker":{"$serde_json::private::Number":"literal"}']) expect(text).toContain(literal);
    };
    await verifyPendingPrecision();
    // The application has not adopted/acknowledged these records. Lose the entire
    // browser and native process, reopen the encrypted journal, then retry once.
    await b.close(); b = undefined;
    await api(pa, "cancel", { handle: sa });
    await expect.poll(async () => ["cancelled", "failed", "completed"].includes((await api(pa, "progress", { handle: sa })).phase)).toBe(true);
    await api(pa, "release", { handle: sa });
    b = await launch("b"); pb = await open(b);
    br = (await api(pb, "replica_open", { storage_id: storageB, device_id: "browser-b", key: secrets.b })).handle;
    const recovered = await api(pb, "replica_pending", { handle: br }); expect(recovered).toEqual(first);
    await verifyPendingPrecision();
    const receiveReplica = (await api(pb, "replica_open", { storage_id: randomUUID(), device_id: "receiver", key: secrets.b })).handle;
    const receiver = (await api(pb, "replica_export", { handle: receiveReplica })).handle;
    const trust = peer.peer.pairing;
    const retry = await api(pa, "start", { snapshot: ax, device: device("browser-a", "send_only", trust.pair_id), expected_device_id: "browser-b", trusted_key: trust.trusted_key, listen_address: "127.0.0.1" });
    const sa2 = retry.handle;
    const sb2 = (await api(pb, "connect", { snapshot: receiver, device: device("browser-b", "receive_only", trust.pair_id), expected_device_id: "browser-a", invitation: retry.invitations[0] })).handle;
    await wait(pa, sa2, "received"); await wait(pb, sb2, "received");
    await api(pb, "replica_merge", { handle: br, session: sb2 });
    const incoming = await api(pb, "replica_pending", { handle: br }); expect(incoming).toEqual(first);
    const incomingKey = incoming.items.find((i: any) => i.record.data.entry_type === "passkey").record.data;
    expect(incomingKey).toEqual(passkey);
    expect(incoming.items.find((i: any) => i.record.data.entry_type === "password").record.data).toEqual(project);
    const valid = await pb.evaluate(async ({ payload, original }) => {
      const dec = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey("pkcs8", dec(payload.private_key_alias), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      const pub = await crypto.subtle.importKey("spki", dec(original), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, challenge), challenge);
    }, { payload: incomingKey.payload, original: credentials.publicKey }); expect(valid).toBe(true);
    const received = await pb.evaluate(async ({ session, asset }) => (window as unknown as { nearby: Harness }).nearby.read(session, asset), { session: sb2, asset });
    expect(hash(new Uint8Array(received))).toBe(asset.id);
    // Keep genuine JSON.rawJSON values inside the browser throughout adoption;
    // Playwright's own parameter serialization must not round this fixture.
    await pb.evaluate(async handle => {
      const transport = (window as unknown as { nearby: Harness }).nearby;
      const pending = await transport.call('replica_pending', { handle });
      await transport.call('replica_applied_batch', { handle, items: pending.items.map((item: any) => ({ record_id: item.record.id, clock: item.record.clock, local_id: `saved-${item.record.id}`, scope: 'browser-test', guard: 'saved-1', data: item.record.data })) });
      const ids = pending.items.map((item: any) => `saved-${item.record.id}`);
      const saved = await transport.call('replica_local', { handle, local_ids: ids, include_data: true });
      const literal = JSON.stringify(saved);
      if (!literal.includes('"zero":-0') || !literal.includes('1e999') || !literal.includes('9007199254740993')) throw new Error('Precision changed during synthetic adoption');
    }, br);
    await api(pa, "acknowledge", { handle: sa2, success: true }); await api(pb, "acknowledge", { handle: sb2, success: true });
    await wait(pa, sa2, "completed"); await wait(pb, sb2, "completed");
    await api(pa, "release", { handle: sa2 }); await api(pb, "release", { handle: sb2 });
    // A real paired endpoint now inventories its adopted records and fully
    // verified attachment. The third transfer must omit their network payload,
    // while still requiring actual replica application before a receipt.
    const inventoried = (await api(pb, "replica_export", { handle: br })).handle;
    await pb.evaluate(async ({ snapshot, asset, bytes }) => (window as unknown as { nearby: Harness }).nearby.append(snapshot, asset, bytes),
      { snapshot: inventoried, asset, bytes: Array.from(bytes) });
    const incremental = await api(pa, "start", { snapshot: ax, device: device("browser-a", "send_only", trust.pair_id), expected_device_id: "browser-b", trusted_key: trust.trusted_key, listen_address: "127.0.0.1" });
    const deltaA = incremental.handle, deltaB = (await api(pb, "connect", { snapshot: inventoried, device: device("browser-b", "receive_only", trust.pair_id), expected_device_id: "browser-a", invitation: incremental.invitations[0] })).handle;
    const deltaProgress = await wait(pa, deltaA, "received"); await wait(pb, deltaB, "received");
    expect(deltaProgress.total).toBeLessThan(4096);
    await api(pb, "replica_merge", { handle: br, session: deltaB });
    expect((await api(pb, "replica_pending", { handle: br })).items).toHaveLength(0);
    await api(pa, "acknowledge", { handle: deltaA, success: true }); await api(pb, "acknowledge", { handle: deltaB, success: true });
    await wait(pa, deltaA, "completed"); await wait(pb, deltaB, "completed");
    await api(pa, "release", { handle: deltaA }); await api(pb, "release", { handle: deltaB });
    evidence.authenticatedIncrementalPayloadBytes = deltaProgress.total;
    const preserved = await api(pa, "replica_local", { handle: ar, local_ids: ["key-zero", "key-positive"], include_data: true });
    expect(preserved.items.map((i: any) => i.data.payload.sign_count)).toEqual([0, 19]);
    evidence.status = "passed"; evidence.originalPublicKeyVerified = true; evidence.zeroAndPositiveCountersPreserved = true;
    evidence.encryptedRestartRecovery = true; evidence.incomingRecords = incoming.items.length; evidence.projectBytes = JSON.stringify(project).length;
    evidence.losslessNoiseTransferAndRestart = true;
    evidence.attachmentBytes = received.length; evidence.native = registration.evidence;
    await api(pa, "close_all"); await api(pb, "close_all");
  } finally {
    await b?.close(); await a?.close();
    try { await registration?.restore(); } finally { await writeFile(info.outputPath("evidence.json"), JSON.stringify(evidence, null, 2)); }
  }
});
