import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createPasskey } from "../../src/passkey/webauthn-core";
import * as kdbxweb from "kdbxweb";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
const kdbxRuntime = (kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb;

const MASTER_PASSWORD = "synthetic passkey verification password";
const DATABASE_PASSWORD = "synthetic portable database password";
const RP = "github.com";
const ORIGIN = "https://github.com";
const CHALLENGE = Buffer.alloc(32, 19).toString("base64url");

interface Client { context: BrowserContext; manager: Page; website: Page; providerId: string; }

async function send<T = any>(manager: Page, request: Record<string, unknown>): Promise<T> {
  const result = await manager.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

async function fixture() {
  const credential = await createPasskey({ origin: ORIGIN, challenge: CHALLENGE, rpId: RP, rpName: "GitHub", userId: "c3ludGhldGljLXVzZXI", userName: "synthetic-user", userDisplayName: "Synthetic", algorithms: [-7], excludeCredentialIds: [], userVerified: true });
  const pem = `-----BEGIN PRIVATE KEY-----\n${credential.privateKeyPkcs8}\n-----END PRIVATE KEY-----`;
  const bytes = await buildKeePassFixture({ password: DATABASE_PASSWORD, name: "Synthetic shared vault", entries: [{
    title: "GitHub [Passkey]",
    fields: { UserName: "synthetic-user", URL: ORIGIN, Notes: "Only synthetic test data", KPEX_PASSKEY_USERNAME: "synthetic-user", KPEX_PASSKEY_RELYING_PARTY: RP, KPEX_PASSKEY_FLAG_BE: "true", KPEX_PASSKEY_FLAG_BS: "true" },
    protectedFields: { Password: "", KPEX_PASSKEY_PRIVATE_KEY_PEM: pem, KPEX_PASSKEY_CREDENTIAL_ID: credential.credentialId, KPEX_PASSKEY_USER_HANDLE: "c3ludGhldGljLXVzZXI" }
  }] });
  return { bytes, credential };
}

function websiteHtml(early = false): string {
  return `<!doctype html><title>Synthetic GitHub request</title><label>Username<input autocomplete="username webauthn"></label><button id="login">Sign in with a passkey</button><button id="register">Create a passkey</button><output id="result"></output><script>
    window.controller = new AbortController(); window.observedKeys = [];
    document.addEventListener('keydown', e => window.observedKeys.push(e.key));
    window.login = async () => {
      controller = new AbortController(); result.textContent = 'waiting'; window.assertion = null;
      try {
        const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON({userVerification:'required',timeout:60000,challenge:'${CHALLENGE}',allowCredentials:[],rpId:'${RP}'});
        const credential = await navigator.credentials.get({publicKey,signal:controller.signal});
        window.assertion = credential.toJSON(); result.textContent = 'authenticated';
      } catch(error) { result.textContent = 'error:' + error.name; }
    };
    document.querySelector('#login').onclick = window.login;
    register.onclick = async () => {
      result.textContent = 'waiting';
      try {
        const credential = await navigator.credentials.create({publicKey:{challenge:new Uint8Array(32).fill(3),rp:{id:'${RP}',name:'GitHub'},user:{id:new Uint8Array(16).fill(7),name:'new-synthetic-user',displayName:'Synthetic'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:60000}});
        window.registration = credential.toJSON(); result.textContent = 'registered';
      } catch(error) { result.textContent = 'error:' + error.name; }
    };
    ${early ? "window.login();" : ""}
  </script>${early ? '<script src="/synthetic-delayed-resource.js"></script>' : ''}`;
}

async function launch(testInfo: TestInfo, suffix: string, bytes: Uint8Array, early = false): Promise<Client> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath(`profile-${suffix}`), { channel: "chromium", headless: true, locale: "zh-CN", args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: MASTER_PASSWORD });
    const opened = await send(manager, { type: "KEEPASS_OPEN", input: { name: "Shared test vault", fileName: "synthetic.kdbx", password: DATABASE_PASSWORD, file: Buffer.from(bytes).toString("base64") } });
    const providerId = opened.account.id as string;
    await send(manager, { type: "PROVIDER_SYNC", providerId });
    const items = await send(manager, { type: "VAULT_LIST_ITEMS" });
    expect(items).toEqual([expect.objectContaining({ kind: "passkey", rpId: RP, userName: "synthetic-user", userVerificationRequired: true, signCount: 0 })]);
    await context.route(`${ORIGIN}/**`, async route => {
      if (route.request().url().endsWith("synthetic-delayed-resource.js")) {
        await new Promise(resolve => setTimeout(resolve, 1800));
        return route.fulfill({ contentType: "text/javascript", body: "window.delayedResourceLoaded = true;" });
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: websiteHtml(early) });
    });
    const website = await context.newPage();
    await website.goto(`${ORIGIN}/login`);
    return { context, manager, website, providerId };
  } catch (error) { await context.close(); throw error; }
}

async function confirmWebsitePrompt(page: Page, create = false): Promise<void> {
  await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
  if (!create) { await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); }
  await page.keyboard.press("Enter");
}

async function verificationWindow(client: Client, options: { early?: boolean; create?: boolean } = {}): Promise<Page> {
  if (!options.early) await client.website.locator(options.create ? "#register" : "#login").click();
  const opened = client.context.waitForEvent("page");
  await confirmWebsitePrompt(client.website, options.create);
  const verification = await opened;
  await verification.waitForURL(/\/passkey-verify\.html\?request=/);
  await expect(verification.getByLabel("Monica 主密码", { exact: true })).toBeEnabled();
  await expect(verification.locator("#site")).toHaveText(RP);
  return verification;
}

async function acceptVerification(verification: Page): Promise<void> {
  await verification.getByLabel("Monica 主密码", { exact: true }).pressSequentially(MASTER_PASSWORD);
  const closed = verification.waitForEvent("close");
  await verification.getByRole("button", { name: "确认", exact: true }).click();
  await closed;
}

function verifyAssertion(assertion: any, publicKeySpki: string, credentialId: string): void {
  expect(assertion.id).toBe(credentialId);
  const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
  const clientData = Buffer.from(assertion.response.clientDataJSON, "base64url");
  expect(JSON.parse(clientData.toString())).toMatchObject({ type: "webauthn.get", origin: ORIGIN, challenge: CHALLENGE, crossOrigin: false });
  expect(authData.subarray(0, 32)).toEqual(createHash("sha256").update(RP).digest());
  expect(authData[32]).toBe(0x1d);
  expect(authData.readUInt32BE(33)).toBe(0);
  const publicKey = createPublicKey({ key: Buffer.from(publicKeySpki, "base64"), type: "spki", format: "der" });
  expect(verify("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
}

test("GitHub-shaped UV requests use imported KDBX Passkeys across two offline clients", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { bytes, credential } = await fixture();
  const clients: Client[] = [];
  try {
    clients.push(await launch(testInfo, "a", bytes), await launch(testInfo, "b", bytes));
    for (const [index, device] of [0, 1, 0, 1].entries()) {
      const client = clients[device];
      const verification = await verificationWindow(client);
      if (index === 0) {
        await verification.getByLabel("Monica 主密码", { exact: true }).fill("wrong synthetic password");
        await verification.getByRole("button", { name: "确认", exact: true }).click();
        await expect(verification.getByRole("alert")).toContainText("主密码错误");
        await expect(client.website.locator("#result")).toHaveText("waiting");
        await verification.setViewportSize({ width: 320, height: 640 });
        await verification.emulateMedia({ colorScheme: "dark" });
        await verification.addStyleTag({ content: "html { font-size: 200%; }" });
        expect(await verification.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        const audit = await new AxeBuilder({ page: verification }).analyze();
        expect(audit.violations.filter(item => ["serious", "critical"].includes(item.impact || ""))).toEqual([]);
        await verification.screenshot({ path: testInfo.outputPath("master-password-verification.png") });
        const id = new URL(verification.url()).searchParams.get("request");
        const forged = await client.manager.evaluate(input => chrome.runtime.sendMessage(input), { type: "PASSKEY_VERIFY_PASSWORD", verificationId: id, masterPassword: MASTER_PASSWORD });
        expect(forged.ok).toBe(false);
      }
      await client.website.evaluate(() => { (window as any).observedKeys = []; });
      await acceptVerification(verification);
      await expect(client.website.locator("#result")).toHaveText("authenticated");
      verifyAssertion(await client.website.evaluate(() => (window as any).assertion), credential.publicKeySpki, credential.credentialId);
      expect(await client.website.evaluate(() => (window as any).observedKeys.join(""))).not.toContain(MASTER_PASSWORD);
      await send(client.manager, { type: "PROVIDER_SYNC", providerId: client.providerId });
      const exported = await send(client.manager, { type: "KEEPASS_EXPORT_FILE", providerId: client.providerId });
      const database = await kdbxRuntime.Kdbx.load(Uint8Array.from(Buffer.from(exported.file, "base64")).buffer, keePassCredentials(DATABASE_PASSWORD));
      const entry = database.getDefaultGroup().entries.find(entry => entry.fields.has("KPEX_PASSKEY_CREDENTIAL_ID"));
      expect(entry).toBeDefined();
      expect((entry!.fields.get("KPEX_PASSKEY_CREDENTIAL_ID") as kdbxweb.ProtectedValue).getText()).toBe(credential.credentialId);
      expect((entry!.fields.get("KPEX_PASSKEY_PRIVATE_KEY_PEM") as kdbxweb.ProtectedValue).getText()).toContain(credential.privateKeyPkcs8);
      // Authentication statistics must not rewrite the entry or manufacture history.
      expect(entry!.fields.has("MonicaPasskeyData")).toBe(false);
      expect(entry!.history).toHaveLength(0);
      expect(entry!.fields.get("KPEX_PASSKEY_FLAG_BE")).toBe("true");
      expect(entry!.fields.get("KPEX_PASSKEY_FLAG_BS")).toBe("true");
    }
    for (const client of clients) expect((await send(client.manager, { type: "VAULT_LIST_ITEMS" }))[0]).toMatchObject({ signCount: 0, useCount: 2 });
  } finally { for (const client of clients) await client.context.close(); }
});

for (const action of ["close", "abort", "lock", "navigate", "key-change"] as const) {
  test(`Passkey verification fails closed on ${action}`, async ({}, testInfo) => {
    const { bytes } = await fixture();
    const client = await launch(testInfo, action, bytes);
    try {
      const verification = await verificationWindow(client);
      const closed = verification.waitForEvent("close");
      if (action === "close") await verification.close();
      else if (action === "abort") await client.website.evaluate(() => (window as any).controller.abort());
      else if (action === "lock") await send(client.manager, { type: "VAULT_LOCK" });
      else if (action === "navigate") await client.website.goto("about:blank");
      else {
        const item = (await send(client.manager, { type: "VAULT_LIST_ITEMS" }))[0];
        await send(client.manager, { type: "VAULT_UPSERT_ITEM", item: { ...item, userHandle: "Y2hhbmdlZA" } });
        await acceptVerification(verification);
      }
      await closed;
      if (action !== "navigate") await expect(client.website.locator("#result")).toContainText("error:");
      if (action === "lock") await send(client.manager, { type: "VAULT_UNLOCK", masterPassword: MASTER_PASSWORD });
      const items = await send(client.manager, { type: "VAULT_LIST_ITEMS" });
      expect(items[0].useCount || 0).toBe(0);
      expect(items[0].signCount).toBe(0);
    } finally { await client.context.close(); }
  });
}

test("early page requests wait for the content bridge and UV registration verifies in Monica", async ({}, testInfo) => {
  const { bytes, credential } = await fixture();
  const client = await launch(testInfo, "early", bytes, true);
  try {
    const verification = await verificationWindow(client, { early: true });
    await acceptVerification(verification);
    await expect(client.website.locator("#result")).toHaveText("authenticated");
    verifyAssertion(await client.website.evaluate(() => (window as any).assertion), credential.publicKeySpki, credential.credentialId);
    const createVerification = await verificationWindow(client, { create: true });
    await acceptVerification(createVerification);
    await expect(client.website.locator("#result")).toHaveText("registered");
    const registration = await client.website.evaluate(() => (window as any).registration);
    expect(Buffer.from(registration.response.authenticatorData, "base64url")[32]).toBe(0x5d);
    const items = await send(client.manager, { type: "VAULT_LIST_ITEMS" });
    expect(items).toHaveLength(2);
    expect(items.find((item: any) => item.credentialId === registration.id)).toMatchObject({ signCount: 0, userVerificationRequired: true });
  } finally { await client.context.close(); }
});
