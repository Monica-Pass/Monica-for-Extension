import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import * as kdbxweb from "kdbxweb";
import { launchEdgeContext } from "./fixtures/edge";
import { SyntheticOneDrive } from "./fixtures/onedrive";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
import { writeAndroidBackup, readAndroidBackup } from "../../src/providers/webdav/android-backup-codec";
import { readKeePassPasskeyFields } from "../../src/providers/keepass/keepass-passkey-codec";
import type { PasskeyItem } from "../../src/core/model";

const kdbx = (kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb;
const rp = "registration.example.test";
const password = "Synthetic registration verification password";
const databasePassword = "Synthetic KDBX registration password";
const challenge = Buffer.alloc(32, 27).toString("base64url");
const html = `<!doctype html><title>Registration RP</title><button id="create">Register</button><button id="login">Sign in</button><output id="result"></output><script>
  window.algorithms=[-257]; window.credentialId=''; window.exclude=false;
  create.onclick=async()=>{result.textContent='waiting';try{const options=PublicKeyCredential.parseCreationOptionsFromJSON({challenge:'${challenge}',rp:{id:'${rp}',name:'Synthetic registration'},user:{id:'dXNlcg',name:'synthetic',displayName:'Synthetic'},pubKeyCredParams:algorithms.map(alg=>({type:'public-key',alg})),authenticatorSelection:{residentKey:'required',userVerification:'required'},extensions:{credProps:true},excludeCredentials:window.exclude?[{type:'public-key',id:credentialId}]:[],timeout:60000});window.creationOptions=options;const c=await navigator.credentials.create({publicKey:options});window.registration=c.toJSON();window.returnedAlgorithm=c.response.getPublicKeyAlgorithm();window.credentialId=c.id;result.textContent='registered';}catch(e){result.textContent='error:'+e.name+':'+e.message;}};
  login.onclick=async()=>{result.textContent='waiting';try{const options=PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required',timeout:60000});const c=await navigator.credentials.get({publicKey:options});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent='error:'+e.name+':'+e.message;}};
</script>`;

async function send(page: Page, input: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

async function approve(context: BrowserContext, page: Page, operation: "create" | "get") {
  await expect(page.locator("#monica-passkey-prompt-host")).toHaveCount(1).catch(async error => {
    const diagnostic = await page.evaluate(() => ({ result: document.querySelector("#result")?.textContent, options: (window as any).creationOptions }));
    throw new Error(`${String(error)}\nSynthetic RP diagnostic: ${JSON.stringify(diagnostic)}`);
  });
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
  const opened = context.waitForEvent("page");
  if (operation === "get") { await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); }
  await page.keyboard.press("Enter");
  const verification = await opened;
  await verification.getByLabel("Monica 主密码", { exact: true }).fill(password);
  await verification.getByRole("button", { name: "确认", exact: true }).click();
}

function verifyRegistration(registration: any, expectedAlgorithm: number) {
  expect(registration.response.publicKeyAlgorithm).toBe(expectedAlgorithm);
  expect(registration.clientExtensionResults).toEqual({ credProps: { rk: true } });
  const client = JSON.parse(Buffer.from(registration.response.clientDataJSON, "base64url").toString());
  expect(client).toMatchObject({ type: "webauthn.create", challenge, origin: `https://${rp}`, crossOrigin: false });
  const auth = Buffer.from(registration.response.authenticatorData, "base64url");
  expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
  expect(auth[32]).toBe(0x5d); expect(auth.readUInt32BE(33)).toBe(0);
  const length = auth.readUInt16BE(53);
  expect(auth.subarray(55, 55 + length).toString("base64url")).toBe(registration.id);
  const cose = auth.subarray(55 + length);
  const key = expectedAlgorithm === -257 ? (() => {
    expect(cose.subarray(0, 11)).toEqual(Buffer.from("a401030339010020590100", "hex"));
    expect(cose.subarray(267)).toEqual(Buffer.from("2143010001", "hex"));
    return createPublicKey({ format: "jwk", key: { kty: "RSA", n: cose.subarray(11, 267).toString("base64url"), e: "AQAB" } });
  })() : createPublicKey({ format: "der", type: "spki", key: Buffer.from(registration.response.publicKey, "base64url") });
  expect(key.export({ format: "der", type: "spki" })).toEqual(Buffer.from(registration.response.publicKey, "base64url"));
  return key;
}

for (const source of ["local", "keepass", "onedrive"] as const) {
  test(`${source} RSA registration honors RP negotiation and preserves portable signing material`, async ({}, info) => {
    test.setTimeout(120_000);
    const profile = info.outputPath("registration");
    const options = { locale: "zh-CN", args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
    let context = await launchEdgeContext(profile, options);
    let keepassId: string | undefined;
    let oneDrive: SyntheticOneDrive | undefined;
    let lastItem: PasskeyItem | undefined;
    let lastRegistration: any;
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      let manager = await context.newPage();
      await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      await send(manager, { type: "VAULT_SETUP", masterPassword: password });
      await manager.evaluate(() => chrome.storage.local.set({ "monica.sync.preferences.v1": { enabled: false } }));
      if (source === "onedrive") {
        oneDrive = new SyntheticOneDrive(await buildKeePassFixture({ password: databasePassword, entries: [] }));
        await oneDrive.install(context, worker);
        const loginId = crypto.randomUUID();
        await send(manager, { type: "ONEDRIVE_LOGIN", loginId });
        const opened = await send(manager, { type: "KEEPASS_ONEDRIVE_OPEN", input: { name: "Synthetic OneDrive", loginId,
          driveId: "drive1", itemId: "file1", databasePassword, isDefaultSaveTarget: true } });
        keepassId = opened.account.id;
      }
      if (source === "keepass") {
        const file = await buildKeePassFixture({ password: databasePassword, name: "Synthetic RSA", entries: [] });
        const opened = await send(manager, { type: "KEEPASS_OPEN", input: { name: "Synthetic KDBX", fileName: "synthetic.kdbx", file: Buffer.from(file).toString("base64"), password: databasePassword, isDefaultSaveTarget: true } });
        keepassId = opened.account.id;
      }
      await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
      let website = await context.newPage();
      await website.goto(`https://${rp}/`);
      for (const algorithms of source === "local" ? [[-7, -257], [-257, -7], [-257]] : [[-257]]) {
        await website.evaluate(value => { (window as any).algorithms = value; }, algorithms);
        await website.locator("#create").click();
        await approve(context, website, "create");
        await expect(website.locator("#result")).toHaveText("registered");
        const registration = await website.evaluate(() => (window as any).registration);
        const publicKey = verifyRegistration(registration, algorithms[0]);
        expect(await website.evaluate(() => (window as any).returnedAlgorithm)).toBe(algorithms[0]);
        const items = await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[];
        const item = items.find(item => item.credentialId === registration.id)!;
        expect(item).toMatchObject({ algorithm: algorithms[0], keyAlgorithm: algorithms[0] === -7 ? "ECDSA" : "RSA", passkeyMode: source !== "local" ? "KEEPASS_COMPAT" : "BW_COMPAT", signCount: 0 });
        expect(item.providerRefs.map(ref => ref.providerId)).toEqual(keepassId ? [keepassId] : []);
        await website.locator("#login").click(); await approve(context, website, "get");
        await expect(website.locator("#result")).toHaveText("authenticated");
        const assertion = await website.evaluate(() => (window as any).assertion);
        const client = Buffer.from(assertion.response.clientDataJSON, "base64url");
        expect(verify("sha256", Buffer.concat([Buffer.from(assertion.response.authenticatorData, "base64url"), createHash("sha256").update(client).digest()]), publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
        const zip = writeAndroidBackup({ entries: {}, items: [], records: new Map(), warnings: [] }, [item], source, { allowPortablePasskeys: true });
        expect(readAndroidBackup(zip, "android-return", { allowPortablePasskeys: true }).items[0]).toMatchObject({ algorithm: item.algorithm, credentialId: item.credentialId, privateKeyPkcs8: item.privateKeyPkcs8 });
        lastItem = item; lastRegistration = registration;
      }
      await website.evaluate(() => { (window as any).exclude = true; });
      await website.locator("#create").click();
      await expect(website.locator("#result")).toContainText("error:InvalidStateError");
      expect((await send(manager, { type: "VAULT_LIST_ITEMS" })).length).toBe(source === "local" ? 3 : 1);
      if (keepassId) {
        await send(manager, { type: "PROVIDER_SYNC", providerId: keepassId });
        const exported = await send(manager, { type: "KEEPASS_EXPORT_FILE", providerId: keepassId });
        const db = await kdbx.Kdbx.load(Uint8Array.from(Buffer.from(exported.file, "base64")).buffer, keePassCredentials(databasePassword));
        const projection = readKeePassPasskeyFields(db.getDefaultGroup().entries[0].fields);
        expect(projection).toMatchObject({ algorithm: -257, credentialId: lastItem!.credentialId, privateKeyPkcs8: lastItem!.privateKeyPkcs8 });
        if (oneDrive) {
          expect(oneDrive.puts).toBeGreaterThan(0);
          const remote = await kdbx.Kdbx.load(Uint8Array.from(oneDrive.bytes).buffer, keePassCredentials(databasePassword));
          expect(readKeePassPasskeyFields(remote.getDefaultGroup().entries[0].fields)).toMatchObject({ algorithm: -257, credentialId: lastItem!.credentialId, privateKeyPkcs8: lastItem!.privateKeyPkcs8 });
          await writeFile(info.outputPath("extension-passkeys.kdbx"), oneDrive.bytes);
          await writeFile(info.outputPath("extension-passkeys-expected.json"), JSON.stringify({ synthetic: true, password: databasePassword,
            inputSha256: createHash("sha256").update(oneDrive.bytes).digest("hex"),
            microsoftNetwork: "simulated; credential created by real Edge WebAuthn and saved by extension runtime",
            passkeys: [{ credentialId: lastItem!.credentialId, algorithm: lastItem!.algorithm, rpId: lastItem!.rpId,
              userHandle: lastItem!.userHandle, userName: lastItem!.userName, userDisplayName: lastItem!.userDisplayName,
              signCount: lastItem!.signCount, backupEligible: lastItem!.backupEligible !== false, backupState: lastItem!.backupState !== false,
              keyMaterialSha256: createHash("sha256").update(Buffer.from(lastItem!.privateKeyPkcs8!, "base64")).digest("base64"),
              spki: lastItem!.publicKey }]
          }, null, 2));
        }
      }
      await context.close(); context = await launchEdgeContext(profile, options);
      const restarted = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(restarted.url()).host}/index.html`);
      await send(manager, { type: "VAULT_UNLOCK", masterPassword: password });
      await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
      website = await context.newPage(); await website.goto(`https://${rp}/`);
      await website.evaluate(id => { (window as any).credentialId = id; }, lastItem!.credentialId);
      await website.locator("#login").click(); await approve(context, website, "get");
      await expect(website.locator("#result")).toHaveText("authenticated");
      const assertion = await website.evaluate(() => (window as any).assertion);
      const publicKey = verifyRegistration(lastRegistration, lastItem!.algorithm);
      expect(verify("sha256", Buffer.concat([Buffer.from(assertion.response.authenticatorData, "base64url"), createHash("sha256").update(Buffer.from(assertion.response.clientDataJSON, "base64url")).digest()]), publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
    } finally { await context.close(); }
  });
}
