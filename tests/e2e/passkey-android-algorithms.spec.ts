import { expect, test, type Page } from "@playwright/test";
import { constants, createHash, generateKeyPairSync } from "node:crypto";
import { verify } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import path from "node:path";
import { encryptAndroidBackup } from "../../src/providers/webdav/android-backup-crypto";
import { launchEdgeContext } from "./fixtures/edge";

const rp = "portable.example.test";
const masterPassword = "Synthetic Edge verification password";
const backupPassword = "Synthetic Android snapshot password";
const challenge = Buffer.alloc(32, 21).toString("base64url");
const dav = "https://portable-dav.example.test";

async function send(page: Page, input: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

test("encrypted Android-format portable keys sign in Edge after import and restart", async ({}, info) => {
  test.setTimeout(150_000);
  // Synthetic keys in the production Android backup format; not Android device evidence.
  const entries: Record<string, Uint8Array> = {};
  const records = [-7, -257, -37, -8].map((algorithm, index) => {
    const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      : algorithm === -8 ? generateKeyPairSync("ed25519") : generateKeyPairSync("rsa", { modulusLength: 2048 });
    const id = Buffer.from(`portable-key-${index}`).toString("base64url");
    entries[`folders/_root/passkeys/passkey_${index}.json`] = strToU8(JSON.stringify({ credentialId: id, rpId: rp, rpName: `Portable ${algorithm}`, userId: "dXNlcg", userName: `synthetic-${index}`, userDisplayName: `Synthetic ${index}`, publicKeyAlgorithm: algorithm, publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyAlias: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), signCount: 0, backupEligible: false, backupState: false, isDiscoverable: true, isUserVerificationRequired: true, createdAt: 1700000000000 }));
    return { algorithm, id, pair };
  });
  const encrypted = await encryptAndroidBackup(zipSync(entries), backupPassword);
  const profile = info.outputPath("portable");
  let context = await launchEdgeContext(profile, { locale: "zh-CN", args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] });
  let writes = 0;
  try {
    for (let run = 0; run < 2; run++) {
      await context.route(`${dav}/**`, route => {
        if (route.request().method() === "PROPFIND") return route.fulfill({ status: 207, contentType: "application/xml", body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Monica_Backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Monica_Backups/monica_backup_20261005_120000.enc.zip</d:href><d:propstat><d:prop><d:getetag>"portable"</d:getetag><d:getlastmodified>Mon, 05 Oct 2026 04:00:00 GMT</d:getlastmodified><d:getcontentlength>${encrypted.length}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>` });
        if (route.request().method() === "GET") return route.fulfill({ status: 200, body: Buffer.from(encrypted), contentType: "application/octet-stream" });
        writes++;
        return route.fulfill({ status: 405 });
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      await manager.evaluate(() => chrome.storage.local.set({ "monica.sync.preferences.v1": { enabled: false } }));
      await send(manager, { type: run ? "VAULT_UNLOCK" : "VAULT_SETUP", masterPassword });
      if (!run) {
        const provider = await send(manager, { type: "WEBDAV_SAVE", name: "Synthetic Android snapshot", config: { baseUrl: `${dav}/dav`, username: "synthetic", password: "synthetic", backupPassword }, isDefaultSaveTarget: false });
        await send(manager, { type: "PROVIDER_SYNC", providerId: provider.id });
      }
      const items = await send(manager, { type: "VAULT_LIST_ITEMS" });
      expect(items).toHaveLength(4);
      for (const record of records) expect(items).toContainEqual(expect.objectContaining({ kind: "passkey", credentialId: record.id, algorithm: record.algorithm, sourceMode: "browser-local", privateKeyPkcs8: expect.any(String) }));
      await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Portable RP</title><button id="login">Sign in</button><output id="result"></output><script>
        window.credentialId = ''; window.discover = false;
        login.onclick = async () => { result.textContent='waiting'; window.assertion=null; try {
          const options = PublicKeyCredential.parseRequestOptionsFromJSON({ challenge:'${challenge}', rpId:'${rp}', userVerification:'required', timeout:60000, allowCredentials: window.discover ? [] : [{type:'public-key',id:window.credentialId}] });
          const c = await navigator.credentials.get({publicKey:options}); window.assertion=c.toJSON(); result.textContent='authenticated';
        } catch(e) { result.textContent='error:'+e.name; } };
      </script>` }));
      const website = await context.newPage();
      await website.goto(`https://${rp}/`);
      for (const record of run ? records.slice(1, 2) : records) {
        await website.evaluate(id => { (window as any).credentialId = id; }, record.id);
        await website.locator("#login").click();
        await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
        const verificationPromise = context.waitForEvent("page");
        await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); await website.keyboard.press("Enter");
        const verification = await verificationPromise;
        await verification.getByLabel("Monica 主密码", { exact: true }).fill(masterPassword);
        await verification.getByRole("button", { name: "确认", exact: true }).click();
        await expect(website.locator("#result")).toHaveText("authenticated");
        const assertion = await website.evaluate(() => (window as any).assertion);
        expect(assertion.id).toBe(record.id);
        const client = Buffer.from(assertion.response.clientDataJSON, "base64url");
        const auth = Buffer.from(assertion.response.authenticatorData, "base64url");
        expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", challenge, origin: `https://${rp}` });
        expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
        expect(auth[32]).toBe(5); expect(auth.readUInt32BE(33)).toBe(0);
        const key = record.algorithm === -37 ? { key: record.pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : record.pair.publicKey;
        expect(verify(record.algorithm === -8 ? null : "sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), key, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
      }
      if (!run) {
        // Empty allowCredentials must support an actual user choice among accounts.
        await website.evaluate(() => { (window as any).discover = true; });
        await website.locator("#login").click();
        await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
        await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
        await website.keyboard.press("End");
        const verificationPromise = context.waitForEvent("page");
        await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); await website.keyboard.press("Enter");
        const verification = await verificationPromise;
        await verification.getByLabel("Monica 主密码", { exact: true }).fill(masterPassword);
        await verification.getByRole("button", { name: "确认", exact: true }).click();
        await expect(website.locator("#result")).toHaveText("authenticated");
        expect(await website.evaluate(() => (window as any).assertion.id)).toBe(items.at(-1).credentialId);
        const beforeCancel = (await send(manager, { type: "VAULT_LIST_ITEMS" })).map((item: any) => [item.id, item.useCount]);
        await website.locator("#login").click();
        await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
        await website.keyboard.press("Escape");
        await expect(website.locator("#result")).toHaveText("error:NotAllowedError");
        expect(await website.evaluate(() => (window as any).assertion)).toBeNull();
        expect((await send(manager, { type: "VAULT_LIST_ITEMS" })).map((item: any) => [item.id, item.useCount])).toEqual(beforeCancel);
      }
      expect(writes).toBe(0);
      await website.screenshot({ path: info.outputPath(`portable-rp-${run}.png`) });
      if (!run) {
        await context.close();
        context = await launchEdgeContext(profile, { locale: "zh-CN", args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] });
      }
    }
  } finally { await context.close(); }
});
