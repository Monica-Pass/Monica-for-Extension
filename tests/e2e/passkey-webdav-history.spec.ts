import { expect, test, type Page } from "@playwright/test";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as kdbxweb from "kdbxweb";
import { strToU8, zipSync } from "fflate";
import type { PasskeyItem } from "../../src/core/model";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
import { readKeePassPasskeyFields } from "../../src/providers/keepass/keepass-passkey-codec";
import { launchEdgeContext } from "./fixtures/edge";
import { decryptAndroidBackup, encryptAndroidBackup } from "../../src/providers/webdav/android-backup-crypto";
import { readAndroidBackup } from "../../src/providers/webdav/android-backup-codec";
import { WebDavClient } from "../../src/providers/webdav/webdav-client";

const output = process.env.MONICA_317_WEBDAV_HISTORY_OUTPUT;
const snapshot = process.env.MONICA_317_WEBDAV_HISTORY_KIND === "zip";
const extension = snapshot ? "enc.zip" : "kdbx";
const kdbx = (kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb;
const password = "Synthetic WebDAV history master password";
const rp = "webdav-history.example.test";
const challenge = Buffer.alloc(32, 47).toString("base64url");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function send(page: Page, input: Record<string, unknown>) {
  const response = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(response.ok, response.error).toBe(true);
  return response.data;
}

test(`real WebDAV ${extension} positive history is published before Edge signs and survives restart`, async ({}, info) => {
  test.skip(!output, "Requires explicit output and isolated running Apache");
  test.setTimeout(180_000);
  await mkdir(output!, { recursive: true });
  const services = JSON.parse(await readFile(".tmp/interop-315-docker/services.json", "utf8"));
  expect(services.webdav.baseUrl).toBe("http://127.0.0.1:18315");
  const remotePath = `counter-${randomUUID()}/vault.kdbx`;
  const url = `${services.webdav.baseUrl}/${remotePath}`;
  const folderUrl = url.slice(0, url.lastIndexOf("/"));
  const zipClient = new WebDavClient({ ...services.webdav, baseUrl: folderUrl });
  const authorization = `Basic ${Buffer.from(`${services.webdav.username}:${services.webdav.password}`).toString("base64")}`;
  const records = ([-7, -257] as const).map((algorithm, index) => {
    const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
    const item: PasskeyItem = { id: randomUUID(), kind: "passkey", title: `Synthetic WebDAV ${algorithm}`, notes: "Exact synthetic notes", favorite: false,
      createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", providerRefs: [],
      credentialId: Buffer.alloc(32, index + 31).toString("base64url"), rpId: rp, rpName: "Synthetic WebDAV history",
      userHandle: "AAEC_w", userName: `synthetic-${index}`, userDisplayName: `Synthetic ${index}`, algorithm,
      publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      signCount: 41, discoverable: true, sourceMode: "browser-local", backupEligible: index === 1, backupState: false };
    return { item, publicKey: pair.publicKey };
  });
  const payload = (item: PasskeyItem) => ({
      credentialId: item.credentialId, rpId: rp, rpName: item.rpName, userId: item.userHandle,
      userName: item.userName, userDisplayName: item.userDisplayName, publicKeyAlgorithm: item.algorithm,
      publicKey: item.publicKey, privateKeyAlias: item.privateKeyPkcs8, signCount: 41,
      backupEligible: item.backupEligible, backupState: item.backupState,
      isDiscoverable: true, isUserVerificationRequired: true, createdAt: Date.parse(item.createdAt),
      passkeyMode: "KEEPASS_COMPAT", transports: "internal", useCount: 0 });
  const input = snapshot ? await encryptAndroidBackup(zipSync(Object.fromEntries(records.map(({ item }, index) => [
    `folders/_root/passkeys/passkey_synthetic_${index}.json`, strToU8(JSON.stringify({ ...payload(item), title: item.title, notes: item.notes, updatedAt: Date.parse(item.updatedAt) }))
  ]))), password) : await buildKeePassFixture({ password, entries: records.map(({ item }) => ({
    title: `${item.title} [Passkey]`, fields: { MonicaPasskeyCredentialId: item.credentialId, Notes: item.notes },
    protectedFields: { Password: "", MonicaPasskeyData: JSON.stringify(payload(item)) }
  })) });
  expect((await fetch(folderUrl, { method: "MKCOL", headers: { authorization }, redirect: "error" })).status).toBe(201);
  if (snapshot) await zipClient.upload(input, true);
  else expect((await fetch(url, { method: "PUT", headers: { authorization, "If-None-Match": "*" }, body: Uint8Array.from(input), redirect: "error" })).status).toBe(201);
  await writeFile(path.join(output!, `input.${extension}`), input);
  const inspectRemote = async () => {
    const bytes = snapshot ? await zipClient.download((await zipClient.listBackups())[0]) : await (async () => {
      const response = await fetch(url, { headers: { authorization }, redirect: "error" }); expect(response.status).toBe(200);
      return new Uint8Array(await response.arrayBuffer());
    })();
    const items = snapshot ? readAndroidBackup(await decryptAndroidBackup(bytes, password), "independent", { allowPortablePasskeys: true }).items as PasskeyItem[]
      : (await kdbx.Kdbx.load(Uint8Array.from(bytes).buffer, keePassCredentials(password))).getDefaultGroup().entries.map(entry => readKeePassPasskeyFields(entry.fields)!);
    expect(items).toHaveLength(2);
    for (const record of records) {
      expect(items.find(item => item.credentialId === record.item.credentialId)).toMatchObject({
        algorithm: record.item.algorithm, credentialId: record.item.credentialId, privateKeyPkcs8: record.item.privateKeyPkcs8,
        publicKey: record.item.publicKey, userHandle: record.item.userHandle, notes: record.item.notes,
        backupEligible: record.item.backupEligible, backupState: record.item.backupState });
    }
    return { bytes, items, sha256: hash(bytes) };
  };
  const profile = info.outputPath("webdav-history");
  const options = { locale: "zh-CN", args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
  let context = await launchEdgeContext(profile, options);
  const signatures: Record<string, unknown>[] = [];
  const evidence: Record<string, unknown> = { status: "failed", remotePath: snapshot ? `${remotePath.split("/")[0]}/Monica_Backups` : remotePath, format: extension, inputSha256: hash(input), signatures,
    scope: `Actual Edge prompt/master-password UV, real isolated Apache, independent encrypted ${extension} readback; synthetic imported keys. No Android or global concurrency claim.` };
  try {
    for (let run = 0; run < 2; run++) {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      await send(manager, { type: run ? "VAULT_UNLOCK" : "VAULT_SETUP", masterPassword: password });
      if (!run) {
        if (snapshot) {
          const opened = await send(manager, { type: "WEBDAV_SAVE", name: "Real ZIP history", config: { ...services.webdav, baseUrl: folderUrl, backupPassword: password } });
          await send(manager, { type: "PROVIDER_SYNC", providerId: opened.id });
        } else await send(manager, { type: "KEEPASS_WEBDAV_OPEN", input: { name: "Real WebDAV history", baseUrl: services.webdav.baseUrl,
          username: services.webdav.username, webDavPassword: services.webdav.password, remotePath, databasePassword: password, isDefaultSaveTarget: true } });
      }
      await expect.poll(async () => (await send(manager, { type: "VAULT_LIST_ITEMS" })).length).toBe(2);
      await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><title>WebDAV history RP</title><button id="login">Sign in</button><output id="result"></output><script>
        window.credentialId='';login.onclick=async()=>{result.textContent='waiting';window.assertion=null;try{
          const options=PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',userVerification:'required',timeout:60000,allowCredentials:[{type:'public-key',id:window.credentialId}]});
          window.assertion=(await navigator.credentials.get({publicKey:options})).toJSON();result.textContent='authenticated';
        }catch(e){result.textContent='error:'+e.name+':'+e.message;}};
      </script>` }));
      const website = await context.newPage(); await website.goto(`https://${rp}/`);
      for (const record of records) {
        const before = (await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[]).find(item => item.credentialId === record.item.credentialId)!;
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
        await expect(website.locator("#result")).toHaveText("authenticated", { timeout: 30_000 });
        const assertion = await website.evaluate(() => (window as any).assertion);
        const auth = Buffer.from(assertion.response.authenticatorData, "base64url"), client = Buffer.from(assertion.response.clientDataJSON, "base64url");
        expect(assertion.id).toBe(record.item.credentialId);
        expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", origin: `https://${rp}`, challenge, crossOrigin: false });
        expect(auth.length).toBe(37); expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update(rp).digest());
        expect(auth[32]).toBe(record.item.backupEligible ? 13 : 5); expect(auth.readUInt32BE(33)).toBe(42 + run);
        expect(assertion.response.userHandle).toBe(record.item.userHandle);
        expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), record.publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
        const remote = await inspectRemote();
        expect(remote.items.find(item => item.credentialId === record.item.credentialId)?.signCount).toBe(42 + run);
        const after = (await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[]).find(item => item.credentialId === record.item.credentialId)!;
        expect(after).toMatchObject({ signCount: 42 + run, signCountHighWaterMark: 42 + run, notes: record.item.notes });
        signatures.push({ algorithm: record.item.algorithm, run, recordedRpCounter: before.signCount, returnedCounter: auth.readUInt32BE(33), remoteSha256: remote.sha256, signatureVerified: true });
        await writeFile(path.join(output!, `after-${run}-${record.item.algorithm}.${extension}`), remote.bytes);
      }
      if (snapshot && run === 1) {
        const trusted = await inspectRemote();
        const older = new Uint8Array(await readFile(path.join(output!, "after-0--257.enc.zip")));
        await zipClient.upload(older, true);
        await website.evaluate(id => { (window as any).credentialId = id; }, records[0].item.credentialId);
        await website.locator("#login").click();
        await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
        await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
        const verificationPromise = context.waitForEvent("page");
        await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); await website.keyboard.press("Enter");
        const verification = await verificationPromise;
        await verification.getByLabel("Monica 主密码", { exact: true }).fill(password);
        await verification.getByRole("button", { name: "确认", exact: true }).click();
        const cdp = await context.newCDPSession(website); await cdp.send("DOM.enable");
        await expect.poll(async () => {
          const { nodes } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true });
          const alert = nodes.find(node => node.attributes?.some((attribute, index, attributes) => index % 2 === 0 && attribute === "role" && attributes[index + 1] === "alert"));
          return alert ? (await cdp.send("DOM.getOuterHTML", { nodeId: alert.nodeId })).outerHTML : "";
        }, { timeout: 30_000 }).toContain("回退");
        await cdp.detach();
        await website.screenshot({ path: path.join(output!, "rollback-rejected.png") });
        expect(await website.evaluate(() => (window as any).assertion)).toBeNull();
        const rolledBack = await inspectRemote();
        expect(rolledBack.sha256).toBe(hash(older)); expect(rolledBack.items.map(item => item.signCount)).toEqual([42, 42]);
        const state = await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[];
        expect(state.map(item => item.signCountHighWaterMark)).toEqual([43, 43]);
        await website.keyboard.press("Escape");
        await expect(website.locator("#result")).toContainText("error:");
        // Restore the known synthetic source only after proving no signature
        // or compensating overwrite hid the counter regression.
        await zipClient.upload(trusted.bytes, true);
        await send(manager, { type: "PROVIDER_SYNC", providerId: state[0].providerRefs[0].providerId });
        evidence.remoteRollbackRejected = true;
      }
      await website.screenshot({ path: path.join(output!, `edge-run-${run}.png`) });
      await context.close(); if (!run) context = await launchEdgeContext(profile, options);
    }
    const final = await inspectRemote();
    expect(final.items.map(item => item.signCount)).toEqual([43, 43]);
    Object.assign(evidence, { status: "passed", restartVerified: true, finalSha256: final.sha256 });
  } catch (error) { evidence.error = String(error); throw error; }
  finally { await context.close().catch(() => undefined); await writeFile(path.join(output!, "evidence.json"), JSON.stringify(evidence, null, 2)); }
});
