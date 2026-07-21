import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { decodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenKdfConfig, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

test("passkey bridge creates an encrypted ES256 credential and signs a later assertion", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("passkey-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "passkey e2e master password" }))).toMatchObject({ ok: true });
    await context.route("https://passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><title>Passkey Test</title><button id="register">Register passkey</button><button id="authenticate">Authenticate passkey</button><output id="result"></output><script>
      const challenge = () => new Uint8Array(32).fill(7); let credentialId;
      const decode = value => { const normalized=value.replace(/-/g,'+').replace(/_/g,'/'); const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4)); return Uint8Array.from(binary,c=>c.charCodeAt(0)); };
      register.onclick = async () => { try { const credential = await navigator.credentials.create({ publicKey: { challenge: challenge(), rp: { id: 'passkey.example.test', name: 'Passkey Test' }, user: { id: new Uint8Array(16).fill(9), name: 'joy@example.com', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none' } }); credentialId=credential.id; result.textContent='registered:'+credential.id+':'+credential.response.attestationObject.byteLength; } catch(error) { result.textContent='error:'+error.name+':'+error.message; } };
      authenticate.onclick = async () => { try { const credential = await navigator.credentials.get({ publicKey: { challenge: challenge(), rpId: 'passkey.example.test', allowCredentials: [{ type:'public-key', id: decode(credentialId) }], timeout: 60000 } }); result.textContent='authenticated:'+credential.id+':'+credential.response.signature.byteLength; } catch(error) { result.textContent='error:'+error.name+':'+error.message; } };
    </script>` }));
    const page = await context.newPage(); await page.goto("https://passkey.example.test/");
    await page.locator("#register").click();
    const prompt = page.locator("#monica-passkey-prompt-host"); await expect(prompt.locator(".title")).toContainText("创建 Monica Passkey"); await prompt.locator(".primary").click();
    await expect(page.locator("#result")).toContainText("registered:"); await expect(page.locator("#result")).not.toContainText("error:");
    const created = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(created.data).toEqual([expect.objectContaining({ kind: "passkey", sourceMode: "browser-local", privateKeyPkcs8: expect.any(String), signCount: 0 })]);
    await page.locator("#authenticate").click(); await expect(prompt.locator(".title")).toContainText("使用 Monica Passkey"); await expect(prompt.locator(".choice")).toContainText("Passkey Test"); await prompt.locator(".primary").click();
    await expect(page.locator("#result")).toContainText("authenticated:"); await expect(page.locator("#result")).not.toContainText("error:");
    const signed = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, unknown>> };
    expect(signed.data[0]).toMatchObject({ signCount: 1 });
  } finally { await context?.close(); }
});

test("Bitwarden Passkey creates syncs its counter and deletes only the FIDO2 credential", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  const email = "joy@example.com"; const masterPassword = "bitwarden e2e master password";
  const kdf: BitwardenKdfConfig = { type: 0, iterations: 10_000 };
  const vaultKey: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 33) };
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(masterPassword, email, kdf));
  const protectedKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch).protectVaultKey(vaultKey, stretched, Uint8Array.from({ length: 16 }, (_, index) => index));
  let remoteCipher: Record<string, unknown> | undefined; let postCount = 0; let putCount = 0; let deleteCount = 0;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-passkey-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    await context.route("https://bw.example.test/**", async (route) => {
      const request = route.request(); const pathname = new URL(request.url()).pathname;
      if (pathname === "/identity/accounts/prelogin") return jsonRoute(route, { Kdf: 0, KdfIterations: kdf.iterations });
      if (pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "e2e-access-token", refresh_token: "e2e-refresh-token", expires_in: 3600, Key: protectedKey });
      if (pathname === "/api/sync") return jsonRoute(route, { Profile: { Id: "e2e-user" }, Ciphers: remoteCipher ? [remoteCipher] : [] });
      if (pathname === "/api/ciphers" && request.method() === "POST") {
        postCount += 1;
        remoteCipher = { ...(request.postDataJSON() as Record<string, unknown>), id: "e2e-passkey-cipher", revisionDate: "2026-07-15T05:30:00.000Z", creationDate: "2026-07-15T05:29:00.000Z" };
        return jsonRoute(route, remoteCipher);
      }
      if (pathname === "/api/ciphers/e2e-passkey-cipher" && request.method() === "PUT") {
        putCount += 1;
        remoteCipher = { ...(request.postDataJSON() as Record<string, unknown>), id: "e2e-passkey-cipher", revisionDate: `2026-07-15T05:3${putCount}:00.000Z`, creationDate: "2026-07-15T05:29:00.000Z" };
        return jsonRoute(route, remoteCipher);
      }
      if (request.method() === "DELETE") { deleteCount += 1; return route.fulfill({ status: 204 }); }
      return route.abort("failed");
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "passkey provider e2e password" }))).toMatchObject({ ok: true });
    const login = await manager.evaluate(async ({ email, masterPassword }) => chrome.runtime.sendMessage({ type: "BITWARDEN_LOGIN", name: "Bitwarden E2E", vaultUrl: "https://bw.example.test", email, masterPassword, isDefaultSaveTarget: true }), { email, masterPassword }) as { ok: boolean; data: { providerId: string }; error?: string };
    expect(login.ok, login.error).toBe(true);
    expect(login.data.providerId).toEqual(expect.any(String));
    const providerId = login.data.providerId;

    await context.route("https://bitwarden-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: passkeyPage("bitwarden-passkey.example.test") }));
    const page = await context.newPage(); await page.goto("https://bitwarden-passkey.example.test/");
    const prompt = page.locator("#monica-passkey-prompt-host");
    await page.locator("#register").click();
    await expect(prompt.locator(".muted")).toContainText("保存至 Bitwarden E2E");
    await prompt.locator(".primary").click();
    await expect(page.locator("#result")).toContainText("registered:");
    const createdLocally = await listVaultItems(manager);
    const localPasskey = createdLocally.find((item) => item.kind === "passkey")!;
    expect(localPasskey).toMatchObject({ sourceMode: "bitwarden", providerRefs: [{ providerId }] });

    expect(await manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId }), providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(postCount).toBe(1);
    let synced = await listVaultItems(manager);
    expect(synced.map((item) => item.kind)).toEqual(["login", "passkey"]);
    const syncedPasskey = synced.find((item) => item.kind === "passkey")!;
    expect(syncedPasskey).toMatchObject({ sourceMode: "bitwarden", signCount: 0, providerRefs: [{ remoteId: expect.stringContaining("#fido2:") }] });

    await page.locator("#authenticate").click();
    await expect(prompt.locator(".choice")).toContainText("Bitwarden");
    await prompt.locator(".primary").click();
    await expect(page.locator("#result")).toContainText("authenticated:");
    expect((await listVaultItems(manager)).find((item) => item.kind === "passkey")).toMatchObject({ signCount: 1 });
    expect(await manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId }), providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(putCount).toBe(1);
    const remoteAfterSign = await decodeBitwardenCipher(remoteCipher!, providerId, vaultKey);
    expect(remoteAfterSign.items.find((item) => item.kind === "passkey")).toMatchObject({ signCount: 1 });

    synced = await listVaultItems(manager);
    const passkeyId = synced.find((item) => item.kind === "passkey")!.id;
    expect(await manager.evaluate(async (itemId) => chrome.runtime.sendMessage({ type: "VAULT_DELETE_ITEM", itemId }), passkeyId)).toMatchObject({ ok: true });
    expect(await manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId }), providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(putCount).toBe(2);
    expect(deleteCount).toBe(0);
    expect((await decodeBitwardenCipher(remoteCipher!, providerId, vaultKey)).items.map((item) => item.kind)).toEqual(["login"]);
    expect((await listVaultItems(manager)).map((item) => item.kind)).toEqual(["login"]);
  } finally { await context?.close(); }
});

function passkeyPage(rpId: string): string {
  return `<!doctype html><title>Bitwarden Passkey Test</title><button id="register">Register passkey</button><button id="authenticate">Authenticate passkey</button><output id="result"></output><script>
    const challenge = () => new Uint8Array(32).fill(11); let credentialId;
    const decode = value => { const normalized=value.replace(/-/g,'+').replace(/_/g,'/'); const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4)); return Uint8Array.from(binary,c=>c.charCodeAt(0)); };
    register.onclick = async () => { try { const credential = await navigator.credentials.create({ publicKey: { challenge: challenge(), rp: { id: '${rpId}', name: 'Bitwarden Passkey Test' }, user: { id: new Uint8Array(16).fill(12), name: 'joy@example.com', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none' } }); credentialId=credential.id; result.textContent='registered:'+credential.id; } catch(error) { result.textContent='error:'+error.name+':'+error.message; } };
    authenticate.onclick = async () => { try { const credential = await navigator.credentials.get({ publicKey: { challenge: challenge(), rpId: '${rpId}', allowCredentials: [{ type:'public-key', id: decode(credentialId) }], timeout: 60000 } }); result.textContent='authenticated:'+credential.id+':'+credential.response.signature.byteLength; } catch(error) { result.textContent='error:'+error.name+':'+error.message; } };
  </script>`;
}

async function listVaultItems(manager: import("@playwright/test").Page): Promise<Array<Record<string, any>>> {
  const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, any>> };
  expect(response.ok).toBe(true);
  return response.data;
}

function jsonRoute(route: import("@playwright/test").Route, body: unknown): Promise<void> {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}
