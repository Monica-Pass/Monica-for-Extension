import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as kdbxweb from "kdbxweb";
import { launchEdgeContext } from "./fixtures/edge";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
import { readKeePassPasskeyFields } from "../../src/providers/keepass/keepass-passkey-codec";
import type { PasskeyItem } from "../../src/core/model";

const phase = process.env.MONICA_WEBDAV_PASSKEY_PHASE;
const kdbx = (kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb;
const directory = path.resolve(".tmp/android-webdav-passkeys-317");
const rp = "webdav-passkey.example.test";
const password = "Synthetic WebDAV Passkey test password";
const challenge = Buffer.alloc(32, 91).toString("base64url");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const html = `<!doctype html><title>WebDAV test RP</title><button id="create">Register</button><button id="login">Sign in</button><output id="result"></output><script>
window.credentialId='';
create.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({challenge:'${challenge}',rp:{id:'${rp}',name:'WebDAV passkey'},user:{id:'AAECA_8',name:'webdav-user',displayName:'Android WebDAV'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'}})});window.registration=c.toJSON();window.credentialId=c.id;result.textContent='registered';}catch(e){result.textContent=e.name+':'+e.message;}};
login.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required'})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}};
</script>`;
async function send(page: Page, input: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}
async function approve(context: BrowserContext, page: Page, operation: "create" | "get") {
  await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
  const opened = context.waitForEvent("page");
  if (operation === "get") { await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); }
  await page.keyboard.press("Enter");
  const verification = await opened;
  await verification.getByLabel("Monica 主密码", { exact: true }).fill(password);
  await verification.getByRole("button", { name: "确认", exact: true }).click();
}
function verifyAssertion(value: any, key: any) {
  expect(value.id).toBe(key.credentialId);
  expect(value.response.userHandle).toBe(key.userHandle);
  const auth = Buffer.from(value.response.authenticatorData, "base64url");
  const client = Buffer.from(value.response.clientDataJSON, "base64url");
  expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", challenge, origin: `https://${rp}`, crossOrigin: false });
  expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
  expect(auth[32]).toBe(0x1d); expect(auth.readUInt32BE(33)).toBe(0);
  expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]),
    createPublicKey({ format: "der", type: "spki", key: Buffer.from(key.spki, "base64") }), Buffer.from(value.response.signature, "base64url"))).toBe(true);
}

test("real WebDAV Edge registration and actual Android return", async ({}, info) => {
  test.skip(phase !== "prepare" && phase !== "return", "Requires isolated running Apache and an explicit interop phase");
  test.setTimeout(120_000);
  await mkdir(directory, { recursive: true });
  const services = JSON.parse(await readFile(".tmp/interop-315-docker/services.json", "utf8"));
  expect(services.webdav.baseUrl).toBe("http://127.0.0.1:18315");
  const authorization = `Basic ${Buffer.from(`${services.webdav.username}:${services.webdav.password}`).toString("base64")}`;
  const settings = phase === "prepare" ? { synthetic: true, baseUrl: "http://10.0.2.2:18315", username: services.webdav.username,
    password: services.webdav.password, remotePath: `passkey-${randomUUID()}/vault.kdbx` }
    : JSON.parse(await readFile(path.join(directory, "webdav-passkey-input.json"), "utf8"));
  expect(settings.synthetic).toBe(true);
  expect(settings.remotePath).toMatch(/^passkey-[0-9a-f-]{36}\/vault\.kdbx$/);
  const remoteUrl = `${services.webdav.baseUrl}/${settings.remotePath}`;
  const download = async () => {
    const response = await fetch(remoteUrl, { headers: { authorization }, redirect: "error" });
    expect(response.status).toBe(200);
    return { bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
  };
  if (phase === "prepare") {
    const folder = await fetch(remoteUrl.slice(0, remoteUrl.lastIndexOf("/")), { method: "MKCOL", headers: { authorization }, redirect: "error" });
    expect(folder.status).toBe(201);
    const file = await buildKeePassFixture({ password, entries: [] });
    const created = await fetch(remoteUrl, { method: "PUT", headers: { authorization, "If-None-Match": "*" }, body: Uint8Array.from(file), redirect: "error" });
    expect(created.status).toBe(201);
    await writeFile(path.join(directory, "webdav-passkey-input.json"), JSON.stringify(settings, null, 2));
  } else {
    const proof = JSON.parse(await readFile(path.join(directory, "kdbx-return-evidence.json"), "utf8"));
    expect(proof.status).toBe("passed");
    expect(hash((await download()).bytes)).toBe(proof.outputSha256);
  }
  const profile = info.outputPath(`webdav-${phase}`);
  const options = { locale: "zh-CN", args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
  let context = await launchEdgeContext(profile, options);
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    let manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: password });
    const opened = await send(manager, { type: "KEEPASS_WEBDAV_OPEN", input: { name: "Real Apache Passkeys", baseUrl: services.webdav.baseUrl,
      username: settings.username, webDavPassword: settings.password, remotePath: settings.remotePath, databasePassword: password, isDefaultSaveTarget: true } });
    await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
    let website = await context.newPage(); await website.goto(`https://${rp}/`);
    let expected: any;
    if (phase === "prepare") {
      await website.locator("#create").click(); await approve(context, website, "create");
      await expect(website.locator("#result")).toHaveText("registered");
      const registration = await website.evaluate(() => (window as any).registration);
      expect(registration.response.publicKeyAlgorithm).toBe(-7);
      const client = JSON.parse(Buffer.from(registration.response.clientDataJSON, "base64url").toString());
      expect(client).toMatchObject({ type: "webauthn.create", challenge, origin: `https://${rp}`, crossOrigin: false });
      const auth = Buffer.from(registration.response.authenticatorData, "base64url");
      expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
      expect(auth[32]).toBe(0x5d); expect(auth.readUInt32BE(33)).toBe(0);
      const length = auth.readUInt16BE(53);
      expect(auth.subarray(55, 55 + length).toString("base64url")).toBe(registration.id);
      const cose = auth.subarray(55 + length);
      expect(cose.subarray(0, 10).toString("hex")).toBe("a5010203262001215820");
      expect(cose.subarray(42, 45).toString("hex")).toBe("225820");
      const coseKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: cose.subarray(10, 42).toString("base64url"), y: cose.subarray(45, 77).toString("base64url") } });
      expect(coseKey.export({ format: "der", type: "spki" })).toEqual(Buffer.from(registration.response.publicKey, "base64url"));
      const items = await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[];
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.providerRefs.map(ref => ref.providerId)).toEqual([opened.account.id]);
      await expect.poll(async () => {
        const db = await kdbx.Kdbx.load(Uint8Array.from((await download()).bytes).buffer, keePassCredentials(password));
        return db.getDefaultGroup().entries.length;
      }, { timeout: 30_000 }).toBe(1);
      const remote = await download();
      const db = await kdbx.Kdbx.load(Uint8Array.from(remote.bytes).buffer, keePassCredentials(password));
      expect(readKeePassPasskeyFields(db.getDefaultGroup().entries[0].fields)).toMatchObject({ algorithm: -7, credentialId: item.credentialId, privateKeyPkcs8: item.privateKeyPkcs8 });
      expected = { synthetic: true, password, inputSha256: hash(remote.bytes), network: "real isolated Apache WebDAV", passkeys: [{
        credentialId: item.credentialId, algorithm: -7, rpId: rp, userHandle: item.userHandle, userName: item.userName,
        userDisplayName: item.userDisplayName, signCount: 0, backupEligible: true, backupState: true,
        keyMaterialSha256: createHash("sha256").update(Buffer.from(item.privateKeyPkcs8!, "base64")).digest("base64"), spki: item.publicKey }] };
      await writeFile(path.join(directory, "extension-passkeys.kdbx"), remote.bytes);
      await writeFile(path.join(directory, "extension-passkeys-expected.json"), JSON.stringify(expected, null, 2));
    } else {
      expected = JSON.parse(await readFile(path.join(directory, "extension-passkeys-expected.json"), "utf8"));
      // Opening creates the source; the runtime schedules its first projection asynchronously.
      // Wait for that automatic sync, without issuing a manual PROVIDER_SYNC.
      await expect.poll(async () => (await send(manager, { type: "VAULT_LIST_ITEMS" })).length, { timeout: 30_000 }).toBe(1);
      const items = await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[];
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ credentialId: expected.passkeys[0].credentialId, notes: "Android KDBX signature return", algorithm: -7 });
    }
    await website.evaluate(id => { (window as any).credentialId = id; }, expected.passkeys[0].credentialId);
    await website.locator("#login").click(); await approve(context, website, "get");
    await expect(website.locator("#result")).toHaveText("authenticated");
    verifyAssertion(await website.evaluate(() => (window as any).assertion), expected.passkeys[0]);
    await context.close(); context = await launchEdgeContext(profile, options);
    const restarted = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(restarted.url()).host}/index.html`);
    await send(manager, { type: "VAULT_UNLOCK", masterPassword: password });
    await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
    website = await context.newPage(); await website.goto(`https://${rp}/`);
    await website.evaluate(id => { (window as any).credentialId = id; }, expected.passkeys[0].credentialId);
    await website.locator("#login").click(); await approve(context, website, "get");
    await expect(website.locator("#result")).toHaveText("authenticated");
    verifyAssertion(await website.evaluate(() => (window as any).assertion), expected.passkeys[0]);
    await writeFile(path.join(directory, `edge-${phase}-evidence.json`), JSON.stringify({ status: "passed", phase, source: "actual Edge and Apache WebDAV", credentialId: expected.passkeys[0].credentialId,
      signatures: 2, restarted: true, automaticUpload: phase === "prepare", inputSha256: expected.inputSha256 }, null, 2));
  } finally { await context.close(); }
});
