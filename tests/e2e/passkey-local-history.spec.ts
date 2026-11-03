import { expect, test, type Page } from "@playwright/test";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PasskeyItem } from "../../src/core/model";
import { launchEdgeContext } from "./fixtures/edge";

const rp = "local-history.example.test";
const password = "Synthetic local history master password";
const challenge = Buffer.alloc(32, 39).toString("base64url");
async function send(page: Page, input: Record<string, unknown>) {
  const response = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(response.ok, response.error).toBe(true);
  return response.data;
}

test("local imported positive Passkey history advances before signing and survives Edge restart", async ({}, info) => {
  test.setTimeout(180_000);
  const records = ([-7, -257] as const).map((algorithm, index) => {
    const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
    const item: PasskeyItem = {
      id: randomUUID(), kind: "passkey", title: `Synthetic history ${algorithm}`, favorite: false, notes: "Exact synthetic notes", providerRefs: [],
      createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z",
      credentialId: Buffer.alloc(32, index + 21).toString("base64url"), rpId: rp, rpName: "Synthetic local history",
      userHandle: "AAEC_w", userName: `synthetic-${index}`, userDisplayName: `Synthetic ${index}`, algorithm,
      publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      privateKeyPkcs8: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      signCount: 41, discoverable: true, sourceMode: "browser-local", backupEligible: false, backupState: false
    };
    return { item, publicKey: pair.publicKey };
  });
  const profile = info.outputPath("local-history");
  const options = { locale: "zh-CN", args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
  let context = await launchEdgeContext(profile, options);
  const signatures: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = { status: "failed", scope: "Synthetic imported local credentials, actual Edge prompts/master-password UV/ES256 and RS256 signatures/restart. No file-provider or Android counter claim." };
  try {
    for (let run = 0; run < 2; run++) {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      await send(manager, { type: run ? "VAULT_UNLOCK" : "VAULT_SETUP", masterPassword: password });
      if (!run) await send(manager, { type: "VAULT_IMPORT_ITEMS", items: records.map(record => record.item) });
      await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>Local counter RP</title><button id="login">Sign in</button><output id="result"></output><script>
        window.credentialId='';
        login.onclick=async()=>{ result.textContent='waiting'; window.assertion=null; try {
          const options=PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',userVerification:'required',timeout:60000,allowCredentials:[{type:'public-key',id:window.credentialId}]});
          window.assertion=(await navigator.credentials.get({publicKey:options})).toJSON(); result.textContent='authenticated';
        }catch(e){result.textContent='error:'+e.name+':'+e.message;} };
      </script>` }));
      const website = await context.newPage(); await website.goto(`https://${rp}/`);
      for (const record of records) {
        const before = (await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[]).find(item => item.id === record.item.id)!;
        expect(before.signCount).toBe(41 + run);
        await website.evaluate(id => { (window as any).credentialId = id; }, record.item.credentialId);
        await website.locator("#login").click();
        await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
        await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
        const verificationPromise = context.waitForEvent("page");
        await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); await website.keyboard.press("Enter");
        const verification = await verificationPromise;
        await verification.getByLabel("Monica 主密码", { exact: true }).fill(password);
        await verification.getByRole("button", { name: "确认", exact: true }).click();
        await expect(website.locator("#result")).toHaveText("authenticated");
        const assertion = await website.evaluate(() => (window as any).assertion);
        const auth = Buffer.from(assertion.response.authenticatorData, "base64url"), client = Buffer.from(assertion.response.clientDataJSON, "base64url");
        expect(assertion.id).toBe(record.item.credentialId);
        expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", origin: `https://${rp}`, challenge, crossOrigin: false });
        expect(auth.length).toBe(37); expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
        expect(auth[32]).toBe(5); expect(auth.readUInt32BE(33)).toBe(42 + run);
        expect(Buffer.from(assertion.response.userHandle, "base64url")).toEqual(Buffer.from([0, 1, 2, 255]));
        expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), record.publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
        const after = (await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[]).find(item => item.id === record.item.id)!;
        expect(after).toMatchObject({ signCount: 42 + run, signCountHighWaterMark: 42 + run, notes: record.item.notes,
          credentialId: record.item.credentialId, privateKeyPkcs8: record.item.privateKeyPkcs8, useCount: run + 1, providerRefs: [] });
        signatures.push({ algorithm: record.item.algorithm, run, recordedRpCounter: before.signCount, returnedCounter: auth.readUInt32BE(33), signatureVerified: true });
      }
      await context.close();
      if (!run) context = await launchEdgeContext(profile, options);
    }
    Object.assign(evidence, { status: "passed", signatures, restartVerified: true });
  } catch (error) { evidence.error = String(error); throw error; }
  finally { await context.close().catch(() => undefined); await writeFile(info.outputPath("evidence.json"), JSON.stringify(evidence, null, 2)); }
});
