import { launchEdgeContext } from "./fixtures/edge";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { decodeBitwardenCipher, encodeBitwardenPasskeyCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";
import { createPasskey } from "../../src/passkey/webauthn-core";
import type { PasskeyItem, ProviderConflictSummary } from "../../src/core/model";

const HOST = "https://bw-passkey.example.test";
const ORIGIN = "https://counter.example.test";
const EMAIL = "synthetic@example.test";
const PASSWORD = "synthetic Bitwarden password";
const REVISION = "2026-09-14T00:00:00.000Z";
const CHALLENGE = Buffer.alloc(32, 19).toString("base64url");

async function server(initialCounter: number) {
  const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(16), macKey: new Uint8Array(32).fill(24) };
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient().protectVaultKey(key, stretched, new Uint8Array(16));
  const credential = await createPasskey({ origin: ORIGIN, challenge: CHALLENGE, rpName: "Counter test", userId: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithms: [-7], excludeCredentialIds: [] });
  const item: PasskeyItem = { id: "fixture", kind: "passkey", title: "Counter test", favorite: false, notes: "", createdAt: REVISION, updatedAt: REVISION, providerRefs: [], credentialId: credential.credentialId, rpId: "counter.example.test", rpName: "Counter test", userHandle: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithm: -7, publicKey: credential.publicKeySpki, privateKeyPkcs8: credential.privateKeyPkcs8, signCount: initialCounter, discoverable: true, sourceMode: "bitwarden" };
  let raw = { ...await encodeBitwardenPasskeyCipher(item, key), id: "counter-cipher", revisionDate: REVISION, creationDate: REVISION };
  const events: string[] = [];
  let revision = 0;
  let offline = false;
  let failure = false;
  let hold: Promise<void> | undefined;
  let release = () => undefined as void;
  let readHold: Promise<void> | undefined;
  let releaseRead = () => undefined as void;
  return {
    credential, events,
    offline: () => { offline = true; },
    fail: () => { failure = true; },
    hold: () => { hold = new Promise<void>(resolve => { release = resolve; }); },
    release: () => release(),
    holdReads: () => { readHold = new Promise<void>(resolve => { releaseRead = resolve; }); },
    releaseReads: () => { releaseRead(); readHold = undefined; },
    counter: async () => (await decodeBitwardenCipher(raw, "fixture-provider", key)).items.find((candidate): candidate is PasskeyItem => candidate.kind === "passkey")!.signCount,
    advanceElsewhere: async (counter: number) => { raw = { ...await encodeBitwardenPasskeyCipher({ ...item, signCount: counter }, key, raw), id: raw.id, revisionDate: new Date(Date.parse(REVISION) + ++revision * 1000).toISOString(), creationDate: REVISION }; },
    route: async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (offline) { events.push("offline-request"); return route.abort("internetdisconnected"); }
      if (url.pathname === "/identity/accounts/prelogin/password") return json(route, { Kdf: 0, KdfIterations: 10_000 });
      if (url.pathname === "/identity/connect/token") return json(route, { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, Key: protectedKey });
      if (url.pathname === "/api/sync") { events.push("read"); if (readHold) await readHold; return json(route, { Profile: { Id: "synthetic-user" }, Ciphers: [raw] }); }
      if (url.pathname === "/api/ciphers/counter-cipher" && request.method() === "PUT") {
        events.push("write");
        if (hold) await hold;
        if (failure) return json(route, { Message: "Synthetic server failure" }, 503);
        const body = request.postDataJSON();
        if (body.lastKnownRevisionDate !== raw.revisionDate) return json(route, { Message: "The cipher has been modified." }, 400);
        raw = { ...body, id: raw.id, revisionDate: new Date(Date.parse(REVISION) + ++revision * 1000).toISOString(), creationDate: REVISION };
        events.push("committed");
        return json(route, raw);
      }
      return route.abort("failed");
    }
  };
}

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}
function json(route: Route, body: unknown, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }); }

for (const mode of ["zero-offline", "positive", "during-sync", "failure", "cancel", "discover", "regression-zero", "regression-positive", "regression-resolved"] as const) {
  test(`Bitwarden Passkey runtime: ${mode}`, async ({}, testInfo) => {
    const mock = await server(mode === "zero-offline" || mode === "discover" ? 0 : 3);
    const extensionPath = path.resolve("dist");
    const context = await launchEdgeContext(testInfo.outputPath("profile"), { channel: "chromium", headless: true, locale: "zh-CN", args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    let concurrentSync: Promise<unknown> | undefined;
    try {
      await context.route(`${HOST}/**`, mock.route);
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      await send(manager, { type: "VAULT_SETUP", masterPassword: "synthetic browser vault password" });
      // This suite isolates ceremony-driven traffic from the periodic sync scheduler.
      await manager.evaluate(() => chrome.storage.local.set({ "monica.sync.preferences.v1": { enabled: false } }));
      const login = await send(manager, { type: "BITWARDEN_LOGIN", name: "Counter test", vaultUrl: HOST, email: EMAIL, masterPassword: PASSWORD, isDefaultSaveTarget: false });
      if (mode !== "discover") await send(manager, { type: "PROVIDER_SYNC", providerId: login.providerId });
      mock.events.length = 0;
      if (mode === "zero-offline") mock.offline();
      if (mode === "positive") await mock.advanceElsewhere(9000);
      if (mode === "regression-zero") await mock.advanceElsewhere(0);
      if (mode === "regression-positive") await mock.advanceElsewhere(2);
      if (mode === "regression-resolved") {
        await mock.advanceElsewhere(0);
        await send(manager, { type: "PROVIDER_SYNC", providerId: login.providerId });
        const conflicts: ProviderConflictSummary[] = await send(manager, { type: "PROVIDER_CONFLICT_LIST", providerId: login.providerId });
        expect(conflicts).toHaveLength(1);
        const conflict = conflicts[0];
        expect(conflict.reason).toContain("计数");
        await send(manager, { type: "PROVIDER_CONFLICT_RESOLVE", conflictId: conflict.id, resolution: "use-remote" });
        // An offline zero fast path must still honor the retained positive history.
        mock.offline();
      }
      if (mode === "failure") mock.fail();
      if (mode === "cancel") mock.hold();
      if (mode === "during-sync") {
        mock.holdReads();
        concurrentSync = send(manager, { type: "PROVIDER_SYNC", providerId: login.providerId });
        await expect.poll(() => mock.events.includes("read")).toBe(true);
      }
      await context.route(`${ORIGIN}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body><button id="login">Login</button><p id="result">idle</p><script>
        const id=Uint8Array.from(atob('${mock.credential.credentialId}'.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
        login.onclick=async()=>{window.controller=new AbortController();result.textContent='waiting';try{const credential=await navigator.credentials.get({signal:controller.signal,publicKey:{challenge:new Uint8Array(32).fill(19),rpId:'counter.example.test',allowCredentials:[{type:'public-key',id}],userVerification:'discouraged',timeout:60000}});window.assertion=credential.toJSON();result.textContent='authenticated';}catch(error){result.textContent='error:'+error.name;}};
        </script></body></html>` }));
      const website = await context.newPage();
      await website.goto(`${ORIGIN}/login`);
      await website.getByRole("button", { name: "Login", exact: true }).click();
      await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
      await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
      await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); await website.keyboard.press("Enter");
      if (mode === "during-sync") {
        await website.waitForTimeout(250);
        expect(await website.evaluate(() => (window as any).assertion)).toBeUndefined();
        expect(mock.events).not.toContain("write");
        mock.releaseReads();
        await concurrentSync;
      }
      if (mode === "cancel") {
        await expect.poll(() => mock.events.includes("write")).toBe(true);
        await website.evaluate(() => (window as any).controller.abort());
        mock.release();
      }
      if (mode === "failure" || mode === "regression-zero" || mode === "regression-positive" || mode === "regression-resolved") {
        // The prompt keeps a recoverable error visible so the user can retry or cancel.
        // Inspect the closed shadow root through CDP so a pre-existing conflict
        // cannot let this test abort before the actual completion result arrives.
        const cdp = await context.newCDPSession(website);
        await cdp.send("DOM.enable");
        await expect.poll(async () => {
          const { nodes } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true });
          const alert = nodes.find(node => node.attributes?.some((attribute, index, attributes) => index % 2 === 0 && attribute === "role" && attributes[index + 1] === "alert"));
          return alert ? (await cdp.send("DOM.getOuterHTML", { nodeId: alert.nodeId })).outerHTML : "";
        }).toContain(mode === "regression-resolved" ? "回退" : 'role="alert"');
        await cdp.detach();
        if (mode !== "regression-resolved") await expect.poll(async () => (await send(manager, { type: "PROVIDER_CONFLICT_LIST", providerId: login.providerId })).length).toBeGreaterThan(0);
        expect(await website.evaluate(() => (window as any).assertion)).toBeUndefined();
        if (mode !== "failure") {
          const items = await send(manager, { type: "VAULT_LIST_ITEMS" });
          expect(items.find((item: PasskeyItem) => item.kind === "passkey")).toMatchObject({ signCount: mode === "regression-resolved" ? 0 : 3, signCountHighWaterMark: 3 });
          expect(mock.events).not.toContain("write");
        }
        await website.evaluate(() => (window as any).controller.abort());
      }
      if (mode === "cancel" || mode === "failure" || mode === "regression-zero" || mode === "regression-positive" || mode === "regression-resolved") {
        await expect(website.locator("#result")).toContainText("error:");
        expect(await website.evaluate(() => (window as any).assertion)).toBeUndefined();
        const receipts = await manager.evaluate(() => chrome.storage.session.get(null));
        expect(Object.keys(receipts).filter(key => key.startsWith("monica.passkey.completion.v1."))).toEqual([]);
      } else {
        await expect(website.locator("#result")).toHaveText("authenticated");
        const assertion = await website.evaluate(() => (window as any).assertion);
        const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
        const counter = mode === "positive" ? 9001 : mode === "during-sync" ? 4 : 0;
        expect(authData.readUInt32BE(33)).toBe(counter);
        expect(await mock.counter()).toBe(counter);
        const signed = Buffer.concat([authData, createHash("sha256").update(Buffer.from(assertion.response.clientDataJSON, "base64url")).digest()]);
        expect(verify("sha256", signed, createPublicKey({ key: Buffer.from(mock.credential.publicKeySpki, "base64"), format: "der", type: "spki" }), Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
        if (mode === "zero-offline") expect(mock.events).toEqual([]);
        if (mode === "positive") expect(mock.events).toContain("committed");
        if (mode === "discover") expect(mock.events).toEqual(["read"]);
        const items = await send(manager, { type: "VAULT_LIST_ITEMS" });
        expect(items.find((item: PasskeyItem) => item.kind === "passkey")).toMatchObject({ signCount: counter, useCount: 1 });
      }
    } finally { mock.release(); mock.releaseReads(); await concurrentSync?.catch(() => undefined); await context.close(); }
  });
}
