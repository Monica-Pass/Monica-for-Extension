import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

const HOST_NAME = "com.monica_pass.windows_hello";
const REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`
];

test.describe.configure({ mode: "serial" });
test.skip(process.platform !== "win32", "Windows Native Messaging registry E2E requires Windows.");

async function extensionId(extensionPath: string, profilePath: string): Promise<string> {
  const context = await chromium.launchPersistentContext(profilePath, { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    return new URL(worker.url()).host;
  } finally {
    await context.close();
  }
}

function registryKeyExists(key: string): boolean {
  try { execFileSync("reg.exe", ["query", key, "/ve"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function registerHost(manifestPath: string): () => void {
  const occupied = REGISTRY_KEYS.filter(registryKeyExists);
  if (occupied.length) throw new Error(`Refusing to replace an installed Windows Hello Host: ${occupied.join(", ")}`);
  for (const key of REGISTRY_KEYS) execFileSync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore" });
  return () => {
    for (const key of REGISTRY_KEYS) execFileSync("reg.exe", ["delete", key, "/f"], { stdio: "ignore" });
  };
}

async function confirmCreate(page: Page): Promise<void> {
  await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
  await page.keyboard.press("Enter");
}

async function confirmFirstCredential(page: Page): Promise<void> {
  await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
}

function relyingPartyHtml(host: string): string {
  return `<!doctype html><button id="register">Register</button><button id="authenticate">Authenticate</button><output id="result"></output><script>
    const challenge=()=>new Uint8Array(32).fill(7); let credentialId;
    const decode=value=>{const normalized=value.replace(/-/g,'+').replace(/_/g,'/');const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));return Uint8Array.from(binary,c=>c.charCodeAt(0));};
    register.onclick=async()=>{try{const credential=await navigator.credentials.create({publicKey:{challenge:challenge(),rp:{id:'${host}',name:'UV Test'},user:{id:new Uint8Array(16).fill(9),name:'joy',displayName:'Joy'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'required',userVerification:'required'},timeout:60000}});credentialId=credential.id;const flags=new Uint8Array(credential.response.getAuthenticatorData())[32];result.textContent='registered:'+credential.id+':uv='+Boolean(flags&4);}catch(error){result.textContent='error:'+error.name;}};
    authenticate.onclick=async()=>{try{const credential=await navigator.credentials.get({publicKey:{challenge:challenge(),rpId:'${host}',allowCredentials:[{type:'public-key',id:decode(credentialId),transports:['internal']}],userVerification:'required',timeout:60000}});const flags=new Uint8Array(credential.response.authenticatorData)[32];result.textContent='authenticated:'+credential.id+':uv='+Boolean(flags&4);}catch(error){result.textContent='error:'+error.name;}};
  </script>`;
}

test("UV-required Passkey create/get uses Windows Hello and fails closed on cancel or vault lock", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const id = await extensionId(extensionPath, testInfo.outputPath("id-profile"));
  const executable = testInfo.outputPath("fake-windows-hello-host.exe");
  const control = testInfo.outputPath("hello-control.txt");
  const manifest = testInfo.outputPath("windows-hello-host.json");
  execFileSync("rustc", [path.resolve("tests/e2e/fixtures/fake-windows-hello-host.rs"), "-O", "-o", executable]);
  writeFileSync(control, "success", "utf8");
  writeFileSync(manifest, JSON.stringify({ name: HOST_NAME, description: "Monica Windows Hello E2E Host", path: executable, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] }), "utf8");
  const cleanupRegistry = registerHost(manifest);
  const previousControl = process.env.MONICA_FAKE_HELLO_CONTROL;
  process.env.MONICA_FAKE_HELLO_CONTROL = control;
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("uv-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "" }))).toMatchObject({ ok: true });
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_HELLO_ENROLL" }))).toMatchObject({ ok: true });

    const host = "hello-passkey.example.test";
    await context.route(`https://${host}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: relyingPartyHtml(host) }));
    const page = await context.newPage();
    await page.goto(`https://${host}/`);
    await expect.poll(() => page.evaluate(() => Boolean((navigator.credentials as CredentialsContainer & { __monicaPasskey?: boolean }).__monicaPasskey))).toBe(true);
    await page.locator("#register").click();
    await confirmCreate(page);
    await expect(page.locator("#result")).toContainText("registered:");
    await expect(page.locator("#result")).toContainText("uv=true");
    const items = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, unknown>> };
    expect(items.data).toEqual([expect.objectContaining({ kind: "passkey", userVerificationRequired: true, useCount: 0 })]);

    await page.locator("#authenticate").click();
    await confirmFirstCredential(page);
    await expect(page.locator("#result")).toContainText("authenticated:");
    await expect(page.locator("#result")).toContainText("uv=true");

    writeFileSync(control, "cancel", "utf8");
    await page.locator("#authenticate").click();
    await confirmFirstCredential(page);
    await expect(page.locator("#result")).toHaveText("error:NotAllowedError");
    let current = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, unknown>> };
    expect(current.data[0]).toMatchObject({ useCount: 1 });

    writeFileSync(control, "delay:800", "utf8");
    await page.locator("#authenticate").click();
    await confirmFirstCredential(page);
    await page.waitForTimeout(100);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
    await expect(page.locator("#result")).toHaveText("error:NotAllowedError");
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_UNLOCK_HELLO" }))).toMatchObject({ ok: true });
    current = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, unknown>> };
    expect(current.data[0]).toMatchObject({ useCount: 1 });
  } finally {
    await context?.close();
    cleanupRegistry();
    if (previousControl === undefined) delete process.env.MONICA_FAKE_HELLO_CONTROL;
    else process.env.MONICA_FAKE_HELLO_CONTROL = previousControl;
  }
});

test("missing Monica Windows Hello Host falls back to the browser platform authenticator", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("native-fallback-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "fallback password" }))).toMatchObject({ ok: true });
    const host = "native-fallback.example.test";
    await context.route(`https://${host}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: relyingPartyHtml(host) }));
    const page = await context.newPage();
    await page.goto(`https://${host}/`);
    await expect.poll(() => page.evaluate(() => Boolean((navigator.credentials as CredentialsContainer & { __monicaPasskey?: boolean }).__monicaPasskey))).toBe(true);
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.locator("#register").click();
    await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(0);
    await expect(page.locator("#result")).toContainText("registered:");
    await expect(page.locator("#result")).toContainText("uv=true");
    const items = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: unknown[] };
    expect(items.data).toEqual([]);
  } finally {
    await context?.close();
  }
});
