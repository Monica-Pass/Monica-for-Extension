import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { decodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { deriveBitwardenMasterKey, encryptBitwardenString, stretchBitwardenMasterKey, type BitwardenKdfConfig, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const P256_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";
const IMPORTED_CREDENTIAL_ID = "AAECAwQFBgcICQoLDA0ODw";

async function confirmPasskeyCreate(page: import("@playwright/test").Page): Promise<void> {
  const prompt = page.locator("#monica-passkey-prompt-host");
  await expect(prompt).toHaveCount(1);
  expect(await prompt.evaluate((host) => host.shadowRoot)).toBeNull();
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
  await page.keyboard.press("Enter");
}

async function confirmFirstPasskey(page: import("@playwright/test").Page): Promise<void> {
  const prompt = page.locator("#monica-passkey-prompt-host");
  await expect(prompt).toHaveCount(1);
  expect(await prompt.evaluate((host) => host.shadowRoot)).toBeNull();
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
}

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
    await confirmPasskeyCreate(page);
    await expect(page.locator("#result")).toContainText("registered:"); await expect(page.locator("#result")).not.toContainText("error:");
    const created = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(created.data).toEqual([expect.objectContaining({ kind: "passkey", sourceMode: "browser-local", privateKeyPkcs8: expect.any(String), signCount: 0 })]);
    const sessionSnapshot = await manager.evaluate(async () => chrome.storage.session.get(null));
    expect(JSON.stringify(sessionSnapshot)).not.toContain(String(created.data[0].privateKeyPkcs8));
    await page.locator("#authenticate").click(); await confirmFirstPasskey(page);
    await expect(page.locator("#result")).toContainText("authenticated:"); await expect(page.locator("#result")).not.toContainText("error:");
    const signed = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, unknown>> };
    expect(signed.data[0]).toMatchObject({ signCount: 0, useCount: 1, lastUsedAt: expect.any(String) });
  } finally { await context?.close(); }
});

test("an imported Bitwarden FIDO2 credential completes the page authentication path", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  const email = "import@example.com"; const masterPassword = "imported passkey master password";
  const kdf: BitwardenKdfConfig = { type: 0, iterations: 10_000 };
  const vaultKey: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 2), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 34) };
  const enc = (value: string) => encryptBitwardenString(value, vaultKey);
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(masterPassword, email, kdf));
  const protectedKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch).protectVaultKey(vaultKey, stretched, Uint8Array.from({ length: 16 }, (_, index) => index + 1));
  const revision = "2026-08-31T12:00:00.000Z";
  const remoteCipher = {
    Id: "imported-passkey-cipher", Type: 1, Name: await enc("Imported Passkey"), Notes: null, Favorite: false,
    RevisionDate: revision, CreationDate: revision,
    Login: { Username: await enc("joy@example.com"), Password: null, Uris: [], Fido2Credentials: [{
      CredentialId: await enc(`b64.${IMPORTED_CREDENTIAL_ID}`), KeyType: await enc("public-key"), KeyAlgorithm: await enc("ECDSA"),
      KeyCurve: await enc("P-256"), KeyValue: await enc(P256_PKCS8.replace(/\+/g, "-").replace(/\//g, "_")),
      RpId: await enc("imported-passkey.example.test"), RpName: await enc("Imported Passkey"), Counter: await enc("4"),
      UserHandle: await enc("dXNlcg"), UserName: await enc("joy@example.com"), UserDisplayName: await enc("Joy"),
      Discoverable: await enc("true"), CreationDate: await enc(revision)
    }] }
  };
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("pk-import"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    await context.route("https://import-bw.example.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: kdf.iterations });
      if (pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "import-access", refresh_token: "import-refresh", expires_in: 3600, Key: protectedKey });
      if (pathname === "/api/sync") return jsonRoute(route, { Profile: { Id: "import-user" }, Ciphers: [remoteCipher] });
      return route.abort("failed");
    });
    await context.route("https://imported-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><button id="authenticate">Authenticate</button><output id="result"></output><script>
      const decode=value=>{const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));return Uint8Array.from(binary,c=>c.charCodeAt(0));};
      authenticate.onclick=async()=>{try{const credential=await navigator.credentials.get({publicKey:{challenge:new Uint8Array(32).fill(13),rpId:'imported-passkey.example.test',allowCredentials:[{type:'public-key',id:decode('${IMPORTED_CREDENTIAL_ID}')}],timeout:60000}});result.textContent='authenticated:'+credential.id+':'+credential.response.signature.byteLength;}catch(error){result.textContent='error:'+error.name+':'+error.message;}};
    </script>` }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "imported provider vault password" })) as { ok: boolean; error?: string };
    expect(setup.ok, setup.error).toBe(true);
    const login = await manager.evaluate(async ({ email, masterPassword }) => chrome.runtime.sendMessage({ type: "BITWARDEN_LOGIN", name: "Imported Bitwarden", vaultUrl: "https://import-bw.example.test", email, masterPassword }), { email, masterPassword }) as { ok: boolean; data: { providerId: string }; error?: string };
    expect(login.ok, login.error).toBe(true);
    expect(await manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId }), login.data.providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    const imported = (await listVaultItems(manager)).find((item) => item.kind === "passkey")!;
    expect(imported).toMatchObject({ credentialId: IMPORTED_CREDENTIAL_ID, sourceMode: "bitwarden", signCount: 4, privateKeyPkcs8: P256_PKCS8 });

    const page = await context.newPage(); await page.goto("https://imported-passkey.example.test/");
    await page.locator("#authenticate").click(); await confirmFirstPasskey(page);
    await expect(page.locator("#result")).toContainText(`authenticated:${IMPORTED_CREDENTIAL_ID}:`);
    await expect(page.locator("#result")).not.toContainText("error:");
  } finally { await context?.close(); }
});

test("locking cancels an unconfirmed Passkey prompt without saving", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("pk-lock-pending"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const masterPassword = "pending passkey lock password";
    expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: password }), masterPassword)).toMatchObject({ ok: true });
    await context.route("https://pending-lock-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><button id="register">Register</button><output id="result"></output><script>
      register.onclick = async () => { try { await navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32).fill(7), rp: { id: 'pending-lock-passkey.example.test', name: 'Pending lock test' }, user: { id: new Uint8Array(16).fill(8), name: 'joy', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000 } }); result.textContent='registered'; } catch(error) { result.textContent='error:'+error.name; } };
    </script>` }));
    const page = await context.newPage(); await page.goto("https://pending-lock-passkey.example.test/");
    await page.locator("#register").click();
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
    await expect(page.locator("#result")).toHaveText("error:NotAllowedError");
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(0);
    expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword: password }), masterPassword)).toMatchObject({ ok: true });
    expect(await listVaultItems(manager)).toEqual([]);
  } finally { await context?.close(); }
});

test("locking immediately after confirmation keeps the page and vault consistent", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("pk-lock"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const masterPassword = "passkey lock race password";
    expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: password }), masterPassword)).toMatchObject({ ok: true });
    await context.route("https://lock-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><button id="register">Register</button><output id="result"></output><script>
      register.onclick = async () => { try { const credential = await navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32).fill(4), rp: { id: 'lock-passkey.example.test', name: 'Lock test' }, user: { id: new Uint8Array(16).fill(5), name: 'joy', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000 } }); result.textContent='registered:'+credential.id; } catch(error) { result.textContent='error:'+error.name; } };
    </script>` }));
    const page = await context.newPage(); await page.goto("https://lock-passkey.example.test/");
    await page.locator("#register").click();
    await confirmPasskeyCreate(page);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
    expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword: password }), masterPassword)).toMatchObject({ ok: true });
    await expect(page.locator("#result")).not.toHaveText("");
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(0);
    const outcome = await page.locator("#result").textContent();
    const items = await listVaultItems(manager);
    if (outcome?.startsWith("registered:")) {
      expect(items).toEqual([expect.objectContaining({ kind: "passkey", credentialId: outcome.slice("registered:".length) })]);
    } else {
      expect(outcome).toMatch(/^error:(NotAllowedError|NotSupportedError)$/);
      expect(items).toEqual([]);
    }
  } finally { await context?.close(); }
});

test("aborting immediately after confirmation never leaves an orphaned Passkey", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("pk-abort"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "abort passkey password" }))).toMatchObject({ ok: true });
    await context.route("https://abort-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><button id="register">Register</button><output id="result"></output><script>
      register.onclick = async () => { window.passkeyController = new AbortController(); try { const credential = await navigator.credentials.create({ signal: window.passkeyController.signal, publicKey: { challenge: new Uint8Array(32).fill(3), rp: { id: 'abort-passkey.example.test', name: 'Abort test' }, user: { id: new Uint8Array(16).fill(2), name: 'joy', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000 } }); result.textContent='registered:'+credential.id; } catch(error) { result.textContent='error:'+error.name; } };
    </script>` }));
    const page = await context.newPage(); await page.goto("https://abort-passkey.example.test/");
    await page.locator("#register").click();
    await confirmPasskeyCreate(page);
    await page.evaluate(() => (window as Window & { passkeyController: AbortController }).passkeyController.abort());
    await expect(page.locator("#result")).not.toHaveText("");
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(0);
    const outcome = await page.locator("#result").textContent();
    if (outcome?.startsWith("registered:")) {
      expect(await listVaultItems(manager)).toEqual([expect.objectContaining({ kind: "passkey", credentialId: outcome.slice("registered:".length) })]);
    } else {
      expect(outcome).toBe("error:AbortError");
      await expect.poll(async () => (await listVaultItems(manager)).length).toBe(0);
    }
  } finally { await context?.close(); }
});

test("Passkey create rechecks excluded credentials", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("pk-exclude"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage(); await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "exclude recheck password" }))).toMatchObject({ ok: true });
    await context.route("https://exclude-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><button id="register">Register</button><output id="result"></output><script>
      register.onclick = async () => { try { await navigator.credentials.create({ publicKey: { challenge: new Uint8Array(32).fill(8), rp: { id: 'exclude-passkey.example.test', name: 'Exclude test' }, user: { id: new Uint8Array(16).fill(6), name: 'joy', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ type: 'public-key', id: new Uint8Array([1,2,3,4]) }], timeout: 60000 } }); result.textContent='registered'; } catch(error) { result.textContent='error:'+error.name; } };
    </script>` }));
    const page = await context.newPage(); await page.goto("https://exclude-passkey.example.test/");
    await page.locator("#register").click();
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1);
    const now = new Date().toISOString();
    expect(await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: "late-excluded-passkey", kind: "passkey", title: "Existing excluded", favorite: false, notes: "", createdAt: now, updatedAt: now,
      providerRefs: [], credentialId: "AQIDBA", rpId: "exclude-passkey.example.test", rpName: "Exclude test", userHandle: "dXNlcg", userName: "joy", userDisplayName: "Joy",
      algorithm: -7, publicKey: "public", privateKeyPkcs8: "private", signCount: 0, discoverable: true, sourceMode: "browser-local"
    })).toMatchObject({ ok: true });
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
    await page.keyboard.press("Enter");
    await expect(page.locator("#result")).toHaveText("error:InvalidStateError");
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(0);
    expect((await listVaultItems(manager)).map((item) => item.id)).toEqual(["late-excluded-passkey"]);
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
      if (pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: kdf.iterations });
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
    const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "passkey provider e2e password" })) as { ok: boolean; error?: string };
    expect(setup.ok, setup.error).toBe(true);
    const login = await manager.evaluate(async ({ email, masterPassword }) => chrome.runtime.sendMessage({ type: "BITWARDEN_LOGIN", name: "Bitwarden E2E", vaultUrl: "https://bw.example.test", email, masterPassword, isDefaultSaveTarget: true }), { email, masterPassword }) as { ok: boolean; data: { providerId: string }; error?: string };
    expect(login.ok, login.error).toBe(true);
    expect(login.data.providerId).toEqual(expect.any(String));
    const providerId = login.data.providerId;

    await context.route("https://bitwarden-passkey.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: passkeyPage("bitwarden-passkey.example.test") }));
    const page = await context.newPage(); await page.goto("https://bitwarden-passkey.example.test/");
    await page.locator("#register").click();
    await confirmPasskeyCreate(page);
    await expect(page.locator("#result")).toContainText("registered:");
    const createdLocally = await listVaultItems(manager);
    const localPasskey = createdLocally.find((item) => item.kind === "passkey")!;
    expect(localPasskey).toMatchObject({ sourceMode: "bitwarden", providerRefs: [{ providerId }] });

    expect(await manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId }), providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(postCount).toBe(1);
    let synced = await listVaultItems(manager);
    // Provider sync preserves the position of the locally created Passkey and appends the sibling
    // login decoded from the same Bitwarden Cipher. Item order is UI history, not a codec contract.
    expect(synced.map((item) => item.kind).sort()).toEqual(["login", "passkey"]);
    const syncedPasskey = synced.find((item) => item.kind === "passkey")!;
    expect(syncedPasskey).toMatchObject({ sourceMode: "bitwarden", signCount: 0, providerRefs: [{ remoteId: expect.stringContaining("#fido2:") }] });

    await page.locator("#authenticate").click();
    await confirmFirstPasskey(page);
    await expect(page.locator("#result")).toContainText("authenticated:");
    expect((await listVaultItems(manager)).find((item) => item.kind === "passkey")).toMatchObject({ signCount: 0, useCount: 1, lastUsedAt: expect.any(String) });
    expect(await manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId }), providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(putCount).toBe(1);
    const remoteAfterSign = await decodeBitwardenCipher(remoteCipher!, providerId, vaultKey);
    expect(remoteAfterSign.items.find((item) => item.kind === "passkey")).toMatchObject({ signCount: 0 });

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
