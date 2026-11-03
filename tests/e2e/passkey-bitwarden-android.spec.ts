import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchEdgeContext } from "./fixtures/edge";
import type { PasskeyItem } from "../../src/core/model";

const phase = process.env.MONICA_BITWARDEN_PASSKEY_PHASE;
const directory = path.resolve(".tmp/android-bitwarden-uuid-passkeys-317");
const rp = "bitwarden-passkey.example.test";
const password = "Synthetic Bitwarden Passkey test password";
const challenge = Buffer.alloc(32, 91).toString("base64url");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const html = `<!doctype html><title>Bitwarden test RP</title><button id="create">Register</button><button id="login">Sign in</button><output id="result"></output><script>
window.credentialId='';
create.onclick=async()=>{result.textContent='waiting';try{const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({challenge:'${challenge}',rp:{id:'${rp}',name:'WebDAV passkey'},user:{id:'AAECA_8',name:'webdav-user',displayName:'Android WebDAV'},pubKeyCredParams:[{type:'public-key',alg:-257},{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'}})});window.registration=c.toJSON();window.credentialId=c.id;result.textContent='registered';}catch(e){result.textContent=e.name+':'+e.message;}};
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


import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { BitwardenProvider } from "../../src/providers/bitwarden/bitwarden-provider";
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey } from "../../src/providers/bitwarden/bitwarden-crypto";
import type { ProviderAccount } from "../../src/core/model";

test("real Vaultwarden Edge registration and actual Android return", async ({}, info) => {
  test.skip(phase !== "prepare" && phase !== "return", "Requires explicit phase and isolated Vaultwarden");
  test.setTimeout(150_000);
  await mkdir(directory, { recursive: true });
  const baseUrl = "http://127.0.0.1:18316";
  const settings = phase === "prepare" ? { synthetic: true, baseUrl, email: `passkey-${randomUUID()}@example.invalid`, password }
    : JSON.parse(await readFile(path.join(directory, "bitwarden-account.json"), "utf8"));
  expect(settings).toMatchObject({ synthetic: true, baseUrl });
  expect(settings.email).toMatch(/^passkey-[0-9a-f-]{36}@example.invalid$/);
  const client = new BitwardenClient();
  if (phase === "prepare") {
    const master = await deriveBitwardenMasterKey(password, settings.email, { type: 0, iterations: 600000 });
    const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const response = await fetch(baseUrl + "/identity/accounts/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        email: settings.email, name: "Synthetic Passkey interop", masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, password),
        key: await client.protectVaultKey(key, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) });
      expect(response.ok).toBe(true);
    } finally { master.fill(0); key.encKey.fill(0); key.macKey.fill(0); }
    await writeFile(path.join(directory, "bitwarden-account.json"), JSON.stringify(settings, null, 2));
  }
  const login = await client.login({ vaultUrl: baseUrl, email: settings.email, masterPassword: password, deviceId: randomUUID() });
  if (login.status !== "authenticated") throw new Error("Synthetic account login failed");
  const account: ProviderAccount = { id: "independent", kind: "bitwarden", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: login.session };
  const readServer = async () => (await new BitwardenProvider().sync(account, { now: new Date().toISOString(), localItems: [] })).items.filter((item): item is PasskeyItem => item.kind === "passkey");
  const profile = info.outputPath("bitwarden-" + phase);
  const options = { locale: "zh-CN", args: ["--disable-extensions-except=" + path.resolve("dist"), "--load-extension=" + path.resolve("dist")] };
  let context = await launchEdgeContext(profile, options);
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    let manager = await context.newPage(); await manager.goto("chrome-extension://" + new URL(worker.url()).host + "/index.html");
    await send(manager, { type: "VAULT_SETUP", masterPassword: password });
    const connected = await send(manager, { type: "BITWARDEN_LOGIN", name: "Real Vaultwarden Passkeys", vaultUrl: baseUrl, email: settings.email, masterPassword: password, isDefaultSaveTarget: true });
    expect(connected.status).toBe("authenticated");
    await context.route("https://" + rp + "/**", route => route.fulfill({ contentType: "text/html", body: html }));
    let website = await context.newPage(); await website.goto("https://" + rp + "/");
    let expected: any;
    if (phase === "prepare") {
      await website.locator("#create").click(); await approve(context, website, "create");
      await expect(website.locator("#result")).toHaveText("registered");
      const registration = await website.evaluate(() => (window as any).registration);
      expect(registration.response.publicKeyAlgorithm).toBe(-7);
      expect(JSON.parse(Buffer.from(registration.response.clientDataJSON, "base64url").toString())).toMatchObject({ type: "webauthn.create", challenge, origin: "https://" + rp, crossOrigin: false });
      const auth = Buffer.from(registration.response.authenticatorData, "base64url");
      expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
      expect(auth[32]).toBe(0x5d); expect(auth.readUInt32BE(33)).toBe(0);
      const length = auth.readUInt16BE(53), cose = auth.subarray(55 + length);
      expect(length).toBe(16);
      expect(auth.subarray(55, 55 + length).toString("base64url")).toBe(registration.id);
      expect(cose.subarray(0, 10).toString("hex")).toBe("a5010203262001215820");
      expect(cose.subarray(42, 45).toString("hex")).toBe("225820");
      const coseKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: cose.subarray(10,42).toString("base64url"), y: cose.subarray(45,77).toString("base64url") } });
      expect(coseKey.export({ format: "der", type: "spki" })).toEqual(Buffer.from(registration.response.publicKey,"base64url"));
      await expect.poll(async () => (await readServer()).length, { timeout: 30_000 }).toBe(1);
      const item = (await readServer())[0];
      expect(item).toMatchObject({ credentialId: registration.id, algorithm: -7, userHandle: "AAECA_8" });
      expected = { synthetic: true, credentialId: item.credentialId, algorithm: -7, rpId: rp, userHandle: item.userHandle,
        userName: item.userName, userDisplayName: item.userDisplayName, signCount: 0, cipherId: item.providerRefs[0].remoteId!.split("#fido2:")[0],
        keyMaterialSha256: createHash("sha256").update(Buffer.from(item.privateKeyPkcs8!, "base64")).digest("base64"), spki: Buffer.from(registration.response.publicKey, "base64url").toString("base64") };
      await writeFile(path.join(directory, "extension-passkey-expected.json"), JSON.stringify(expected, null, 2));
      await writeFile(path.join(directory, "bitwarden-passkey-input.json"), JSON.stringify({ synthetic: true, baseUrl: "http://10.0.2.2:18316", email: settings.email,
        accessToken: login.session.accessToken, vaultKeyEnc: login.session.vaultKeyEnc, vaultKeyMac: login.session.vaultKeyMac, expected }, null, 2));
    } else {
      expected = JSON.parse(await readFile(path.join(directory, "extension-passkey-expected.json"), "utf8"));
      const device = JSON.parse(await readFile(path.join(directory, "passkey-signatures-bitwarden-evidence.json"), "utf8"));
      const build = JSON.parse(await readFile(path.join(directory, "build-evidence.json"), "utf8"));
      expect(build.status).toBe("passed");
      expect(device.status).toBe("passed");
      expect(device.installedApkSha256).toBe(build.builtAppApkSha256);
      expect(device.installedTestApkSha256).toBe(build.builtTestApkSha256);
      expect(device.baseline).toEqual(build.baseline);
      expect(device.testSourceHashes).toEqual(build.testSourceHashes);
      expect(device.inputs[0].sha256).toBe(hash(await readFile(path.join(directory, "bitwarden-passkey-input.json"))));
      for (const invariant of ["installedApplicationUnchanged", "installedTestApkUnchanged", "androidSourcesUnchanged", "testSourcesUnchanged", "deviceBootUnchanged"]) expect(device[invariant], invariant).toBe(true);
      const proofBytes = await readFile(path.join(directory, "android-bitwarden-signatures.json"));
      expect(hash(proofBytes)).toBe(device.outputs.find((item: any) => item.name === "android-bitwarden-signatures.json").sha256);
      const proof = JSON.parse(proofBytes.toString());
      expect(proof).toMatchObject({ status: "passed", uploaded: 1, failed: 0, cipherId: expected.cipherId,
        interoperabilityComplete: false, notesPreserved: false, editedNotes: "Android Bitwarden signature return" });
      for (const signature of [proof.proof, proof.freshProof]) {
        expect(signature).toMatchObject({ credentialId: expected.credentialId, rpId: rp, algorithm: -7, userHandle: expected.userHandle, keyMaterialSha256: expected.keyMaterialSha256, protectedRoomReference: true, storedSignCount: 0 });
        const auth = Buffer.from(signature.authenticatorData, "base64"), data = Buffer.from(signature.clientDataJSON, "base64");
        expect(JSON.parse(data.toString())).toMatchObject({ type: "webauthn.get", origin: "https://" + rp, crossOrigin: false });
        expect(auth.subarray(0,32)).toEqual(createHash("sha256").update(rp).digest());
        expect(auth[32]).toBe(0x1d); expect(auth.readUInt32BE(33)).toBe(0);
        expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(data).digest()]), createPublicKey({ format: "der", type: "spki", key: Buffer.from(expected.spki, "base64") }), Buffer.from(signature.signature, "base64"))).toBe(true);
      }
      const server = await readServer(); expect(server).toHaveLength(1);
      expect(server[0]).toMatchObject({ credentialId: expected.credentialId, algorithm: -7, userHandle: expected.userHandle, userName: expected.userName,
        userDisplayName: expected.userDisplayName, signCount: 0 });
      expect(server[0].notes.startsWith(proof.freshNotes + "\n\n---\n[Monica Passkey Metadata]\n")).toBe(true);
      expect(server[0].providerRefs[0].remoteId).toBe(expected.cipherId + "#fido2:" + expected.credentialId);
      expect(createHash("sha256").update(Buffer.from(server[0].privateKeyPkcs8!, "base64")).digest("base64")).toBe(expected.keyMaterialSha256);
      await expect.poll(async () => (await send(manager,{type:"VAULT_LIST_ITEMS"})).filter((item: any)=>item.kind==="passkey").length,{timeout:30_000}).toBe(1);
      expect((await send(manager, {type:"VAULT_LIST_ITEMS"})).find((item: any)=>item.kind==="passkey")).toMatchObject({credentialId:expected.credentialId,notes:server[0].notes,algorithm:-7});
    }
    let localId: string | undefined;
    const assertSingleCredential = async () => {
      const keys = (await send(manager, { type: "VAULT_LIST_ITEMS" })).filter((item: any) => item.kind === "passkey");
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ credentialId: expected.credentialId, algorithm: -7 });
      if (localId) expect(keys[0].id).toBe(localId);
      else localId = keys[0].id;
      const remote = await readServer();
      expect(remote).toHaveLength(1);
      expect(remote[0].credentialId).toBe(expected.credentialId);
      expect(remote[0].providerRefs[0].remoteId).toBe(expected.cipherId + "#fido2:" + expected.credentialId);
    };
    for (const restarted of [false, true]) {
      if (restarted) {
        await context.close(); context = await launchEdgeContext(profile, options);
        const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
        manager = await context.newPage(); await manager.goto("chrome-extension://" + new URL(worker.url()).host + "/index.html");
        await send(manager, { type: "VAULT_UNLOCK", masterPassword: password });
        await context.route("https://" + rp + "/**", route => route.fulfill({ contentType: "text/html", body: html }));
        website = await context.newPage(); await website.goto("https://" + rp + "/");
      }
      await assertSingleCredential();
      await website.evaluate(id => { (window as any).credentialId = id; }, expected.credentialId);
      await website.locator("#login").click(); await approve(context, website, "get");
      await expect(website.locator("#result")).toHaveText("authenticated");
      verifyAssertion(await website.evaluate(() => (window as any).assertion), expected);
      await assertSingleCredential();
    }
    await writeFile(path.join(directory, "edge-" + phase + "-evidence.json"), JSON.stringify({ status: "passed", phase, source: "actual Edge and isolated Vaultwarden", credentialId: expected.credentialId,
      signatures: 2, restarted: true, canonicalLocalId: true, stableLocalItemId: localId, uniqueRemoteCredential: true, algorithm: -7, offeredAlgorithms: [-257,-7],
      interoperabilityComplete: false, ...(phase === "return" ? { notesPreserved: false, notesGap: "Android mapper appends notices/metadata; extension preserves returned server text" } : {}),
      scope: "Android system Credential Manager and real UV not covered" }, null, 2));
  } finally { await context.close(); }
});
