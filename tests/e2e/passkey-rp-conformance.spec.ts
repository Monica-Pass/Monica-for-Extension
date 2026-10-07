import { launchEdgeContext } from "./fixtures/edge";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import path from "node:path";
import { completeUserVerification } from "./fixtures/passkey-verification";

const RP_ID = "rpconf.example.test";
const ORIGIN = `https://${RP_ID}`;
const MASTER_PASSWORD = "rp conformance master password";

const PAGE_HTML = `<!doctype html><title>RP conformance</title><body>
<script>
  const toB64Url = (v) => { const b = v instanceof Uint8Array ? v : new Uint8Array(v); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
  const fromB64Url = (s) => { const n = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(n + "=".repeat((4 - n.length % 4) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); };
  window.__credId = null;
  const merge = (base, extra) => { const publicKey = Object.assign({}, base, extra.publicKey || {}); const options = { publicKey }; if (extra.mediation) options.mediation = extra.mediation; return options; };
  window.__create = async (challenge, extra) => {
    try {
      const base = { challenge: fromB64Url(challenge), rp: { id: "${RP_ID}", name: "RP Conformance" }, user: { id: new Uint8Array(16).fill(9), name: "joy@example.com", displayName: "Joy" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 60000, attestation: "none" };
      const c = await navigator.credentials.create(merge(base, extra || {}));
      window.__credId = c.id;
      return JSON.stringify({ ok: true, id: c.id, authData: toB64Url(c.response.getAuthenticatorData()), clientDataJSON: toB64Url(c.response.clientDataJSON) });
    } catch (error) { return JSON.stringify({ ok: false, name: error.name, message: error.message }); }
  };
  window.__get = async (challenge, extra) => {
    try {
      const base = { challenge: fromB64Url(challenge), rpId: "${RP_ID}", allowCredentials: window.__credId ? [{ type: "public-key", id: fromB64Url(window.__credId) }] : [], timeout: 60000 };
      const c = await navigator.credentials.get(merge(base, extra || {}));
      return JSON.stringify({ ok: true, id: c.id, clientDataJSON: toB64Url(c.response.clientDataJSON), authData: toB64Url(c.response.authenticatorData), signature: toB64Url(c.response.signature), userHandleByteLength: c.response.userHandle.byteLength });
    } catch (error) { return JSON.stringify({ ok: false, name: error.name, message: error.message }); }
  };
</script></body>`;

async function confirmPrompt(page: Page, create: boolean): Promise<void> {
  const host = page.locator("#monica-passkey-prompt-host");
  await expect(host).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
  if (!create) {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Enter");
}

function flagReport(flags: number): string {
  return `0x${flags.toString(16).padStart(2, "0")} [UP=${flags & 1 ? 1 : 0} UV=${flags & 4 ? 1 : 0} BE=${flags & 8 ? 1 : 0} BS=${flags & 16 ? 1 : 0} AT=${flags & 64 ? 1 : 0} ED=${flags & 128 ? 1 : 0}]`;
}

/** Replays the WebAuthn §7.2 verification steps an ordinary relying party runs before it accepts a login. */
function verifyAssertion(publicKey: KeyObject, challenge: string, payload: any): Record<string, unknown> {
  const clientDataBuf = Buffer.from(payload.clientDataJSON, "base64url");
  const authData = Buffer.from(payload.authData, "base64url");
  const clientData = JSON.parse(clientDataBuf.toString("utf8")) as Record<string, unknown>;
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataBuf).digest()]);
  const flags = authData[32];
  return {
    "clientData.type": clientData.type === "webauthn.get",
    "clientData.challenge matches RP nonce": clientData.challenge === challenge,
    "clientData.origin": clientData.origin === ORIGIN,
    "authData.rpIdHash": authData.subarray(0, 32).equals(createHash("sha256").update(RP_ID).digest()),
    "authData.length": authData.length,
    "authData.flags": flagReport(flags),
    "UV bit set": Boolean(flags & 0x04),
    "signature verifies": verify("sha256", signed, publicKey, Buffer.from(payload.signature, "base64url")),
    "userHandle.byteLength": payload.userHandleByteLength
  };
}

const EXPECTED_UV: Record<string, boolean> = { omitted: true, preferred: true, discouraged: false, required: true };

test("assertions satisfy RP-side verification per userVerification mode", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  const report: Array<{ mode: string; outcome: unknown }> = [];
  try {
    context = await launchEdgeContext(testInfo.outputPath("rpconf"), {
      channel: "chromium", headless: true, locale: "zh-CN",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: password }), MASTER_PASSWORD)).toMatchObject({ ok: true });
    await context.route(`https://${RP_ID}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE_HTML }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);

    // Registration exactly as most RPs call it: userVerification omitted, which defaults to "preferred".
    const registerChallenge = Buffer.alloc(32, 1).toString("base64url");
    const createCall = page.evaluate((challenge) => (window as any).__create(challenge, null), registerChallenge);
    await confirmPrompt(page, true);
    expect(await completeUserVerification(context, MASTER_PASSWORD), "registration verified the user").toBe(true);
    const created = JSON.parse(await createCall as string);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const createdFlags = Buffer.from(created.authData, "base64url")[32];
    report.push({ mode: "REGISTER (userVerification omitted)", outcome: { flags: flagReport(createdFlags) } });
    expect(createdFlags & 0x04, flagReport(createdFlags)).toBe(0x04);

    // A credential registered without verification is the only shape on which an RP may skip it later.
    const lenientChallenge = Buffer.alloc(32, 30).toString("base64url");
    const lenientCall = page.evaluate(({ challenge, extra }) => (window as any).__create(challenge, extra), { challenge: lenientChallenge, extra: { publicKey: { authenticatorSelection: { userVerification: "discouraged" } } } });
    await confirmPrompt(page, true);
    expect(await completeUserVerification(context, MASTER_PASSWORD, 3_000), "discouraged registration stayed popup-free").toBe(false);
    const lenient = JSON.parse(await lenientCall as string);
    expect(lenient.ok, JSON.stringify(lenient)).toBe(true);
    const lenientFlags = Buffer.from(lenient.authData, "base64url")[32];
    report.push({ mode: "REGISTER (userVerification discouraged)", outcome: { flags: flagReport(lenientFlags) } });
    expect(lenientFlags & 0x04, flagReport(lenientFlags)).toBe(0);

    const items = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<Record<string, string>> };
    const canonicalId = (value: string) => Buffer.from(value, "base64").toString("base64url");
    const lenientItem = items.data.find(item => canonicalId(item.credentialId) === canonicalId(lenient.id));
    expect(lenientItem, JSON.stringify(items.data.map(item => item.credentialId))).toBeDefined();
    const publicKey = createPublicKey({ key: Buffer.from(lenientItem!.publicKey, "base64"), format: "der", type: "spki" });

    for (const [index, mode] of (["omitted", "preferred", "discouraged", "required"] as const).entries()) {
      const extra = mode === "omitted" ? {} : { publicKey: { userVerification: mode } };
      const challenge = Buffer.alloc(32, index + 2).toString("base64url");
      const getCall = page.evaluate(({ challenge, extra }) => (window as any).__get(challenge, extra), { challenge, extra });
      await confirmPrompt(page, false);
      await completeUserVerification(context, MASTER_PASSWORD);
      const payload = JSON.parse(await getCall as string);
      expect(payload.ok, `${mode}: ${JSON.stringify(payload)}`).toBe(true);
      const checks = verifyAssertion(publicKey, challenge, payload);
      report.push({ mode: `GET (userVerification: ${mode})`, outcome: checks });
      expect(checks["clientData.type"], mode).toBe(true);
      expect(checks["clientData.challenge matches RP nonce"], mode).toBe(true);
      expect(checks["clientData.origin"], mode).toBe(true);
      expect(checks["authData.rpIdHash"], mode).toBe(true);
      expect(checks["authData.length"], mode).toBe(37);
      expect(checks["signature verifies"], mode).toBe(true);
      expect(checks["userHandle.byteLength"], mode).toBe(16);
      expect(checks["UV bit set"], `${mode} -> ${checks["authData.flags"]}`).toBe(EXPECTED_UV[mode]);
    }
  } finally {
    console.log("\n===== Monica passkey RP-side audit =====\n" + report.map((entry) => `${entry.mode}\n${JSON.stringify(entry.outcome, null, 2)}`).join("\n\n") + "\n=====================================\n");
    await context?.close();
  }
});

test("unsupported Passkey requests stay native and locked requests offer Monica unlock", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  const report: Array<{ case: string; outcome: unknown }> = [];
  const variants: Array<{ case: string, op: "__create" | "__get", origin: string, extra: Record<string, unknown>, lock?: boolean }> = [
    { case: "GET, vault has no passkey for this rpId", op: "__get", origin: "absent.example.test", extra: { publicKey: { rpId: "absent.example.test", allowCredentials: [] } } },
    { case: "GET, vault locked", op: "__get", origin: RP_ID, extra: {}, lock: true },
    { case: "GET, mediation conditional", op: "__get", origin: RP_ID, extra: { mediation: "conditional" } },
    { case: "CREATE, authenticatorAttachment cross-platform", op: "__create", origin: RP_ID, extra: { publicKey: { authenticatorSelection: { authenticatorAttachment: "cross-platform" } } } },
    { case: "CREATE, extension largeBlob", op: "__create", origin: RP_ID, extra: { publicKey: { extensions: { largeBlob: { support: "preferred" } } } } }
  ];
  try {
    context = await launchEdgeContext(testInfo.outputPath("handoff"), {
      channel: "chromium", headless: true, locale: "zh-CN",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: password }), MASTER_PASSWORD)).toMatchObject({ ok: true });
    for (const origin of [RP_ID, "absent.example.test"]) {
      await context.route(`https://${origin}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE_HTML }));
    }
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    // Seed one credential so a declined request is not confounded with an empty vault.
    const seedCall = page.evaluate((challenge) => (window as any).__create(challenge, {}), Buffer.alloc(32, 9).toString("base64url"));
    await confirmPrompt(page, true);
    await completeUserVerification(context, MASTER_PASSWORD);
    expect(JSON.parse(await seedCall as string).ok).toBe(true);

    for (const variant of variants) {
      if (variant.lock) {
        expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
      }
      const target = variant.origin === RP_ID ? page : await context.newPage().then(async (other) => { await other.goto(`https://${variant.origin}/`); return other; });
      const challenge = Buffer.alloc(32, 5).toString("base64url");
      const promptSeen = target.waitForSelector("#monica-passkey-prompt-host", { timeout: 8_000 }).then(() => true).catch(() => false);
      const ceremony = target.evaluate(({ op, challenge, extra }) => (window as any)[op](challenge, extra), { op: variant.op, challenge, extra: variant.extra })
        .then((raw: string) => JSON.parse(raw) as Record<string, unknown>)
        .catch((error: Error) => ({ crashed: String(error) }));
      const monicaIntercepted = await promptSeen;
      if (monicaIntercepted) await target.keyboard.press("Escape");
      report.push({ case: variant.case, outcome: { monicaPrompt: monicaIntercepted ? "SHOWN" : "not shown, request left Monica", pageResult: await ceremony } });
      expect(monicaIntercepted, variant.case).toBe(variant.lock === true);
      if (variant.lock) {
        expect(await manager.evaluate(async (password) => chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword: password }), MASTER_PASSWORD)).toMatchObject({ ok: true });
      }
    }
  } finally {
    console.log("\n===== Monica -> native WebAuthn handoff matrix =====\n" + report.map((entry) => `${entry.case}\n${JSON.stringify(entry.outcome, null, 2)}`).join("\n\n") + "\n====================================================\n");
    await context?.close();
  }
});
