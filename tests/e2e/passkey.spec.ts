import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

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
    const prompt = page.locator("#monica-passkey-prompt-host"); await expect(prompt.locator("strong")).toContainText("创建 Monica Passkey"); await prompt.locator(".primary").click();
    await expect(page.locator("#result")).toContainText("registered:"); await expect(page.locator("#result")).not.toContainText("error:");
    const created = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data: Array<Record<string, unknown>> };
    expect(created.data).toEqual([expect.objectContaining({ kind: "passkey", sourceMode: "browser-local", privateKeyPkcs8: expect.any(String), signCount: 0 })]);
    await page.locator("#authenticate").click(); await expect(prompt.locator("strong")).toContainText("使用 Monica Passkey"); await expect(prompt.locator(".choice")).toContainText("Passkey Test"); await prompt.locator(".primary").click();
    await expect(page.locator("#result")).toContainText("authenticated:"); await expect(page.locator("#result")).not.toContainText("error:");
    const signed = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, unknown>> };
    expect(signed.data[0]).toMatchObject({ signCount: 1 });
  } finally { await context?.close(); }
});
