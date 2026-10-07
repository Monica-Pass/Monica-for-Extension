import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchEdgeContext } from "./fixtures/edge";
import { temporaryNativeHost } from "./fixtures/native-host";
import type { PasskeyItem, ProviderAccount } from "../../src/core/model";
import { decodeMdbx2Object } from "../../src/providers/mdbx2/mdbx2-item-codec";

const fixture = process.env.MONICA_317_PASSKEY_ANDROID_FIXTURE;
const rp = "passkey-interop.example.test";
const password = "Synthetic Edge Android Passkey password";
const databasePassword = "Synthetic transfer fixture password";
const sourceName = "Actual Android Passkeys";
const challenge = Buffer.alloc(32, 73).toString("base64url");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
interface Expected { credentialId: string; algorithm: number; spki: string; keyMaterialSha256: string; signCount: number; backupEligible: boolean; backupState: boolean; }

const html = `<!doctype html><html lang="en"><title>Android / Edge Passkey acceptance</title>
<h1>Android / Edge Passkey acceptance</h1><button id="login">Sign in</button><button id="create">Create RSA Passkey</button><output id="result"></output><script>
window.credentialId=''; window.discover=false; window.exclude=false;
login.onclick=async()=>{result.textContent='waiting';window.assertion=null;try{const options=PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',userVerification:'required',timeout:60000,allowCredentials:window.discover?[]:[{type:'public-key',id:window.credentialId}]});const c=await navigator.credentials.get({publicKey:options});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent='error:'+e.name+':'+e.message;}};
create.onclick=async()=>{result.textContent='waiting';try{const options=PublicKeyCredential.parseCreationOptionsFromJSON({challenge:'${challenge}',rp:{id:'${rp}',name:'Edge MDBX RSA'},user:{id:'AAEC_w',name:'edge-rsa@example.test',displayName:'Edge RSA'},pubKeyCredParams:[{type:'public-key',alg:-257}],authenticatorSelection:{residentKey:'required',userVerification:'required'},extensions:{credProps:true},excludeCredentials:window.exclude?[{type:'public-key',id:window.credentialId}]:[],timeout:60000});const c=await navigator.credentials.create({publicKey:options});window.registration=c.toJSON();window.credentialId=c.id;result.textContent='registered';}catch(e){result.textContent='error:'+e.name+':'+e.message;}};
</script></html>`;

async function send(page: Page, request: Record<string, unknown>) {
  const response = await page.evaluate(value => chrome.runtime.sendMessage(value), request);
  expect(response.ok, response.error).toBe(true);
  return response.data;
}

async function approve(context: BrowserContext, website: Page, operation: "create" | "get", screenshot?: string) {
  await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
  await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
  if (screenshot) await website.screenshot({ path: screenshot });
  const opened = context.waitForEvent("page");
  if (operation === "get") { await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); }
  await website.keyboard.press("Enter");
  const verification = await opened;
  await verification.getByLabel("Monica 主密码", { exact: true }).fill(password);
  await verification.getByRole("button", { name: "确认", exact: true }).click();
}

function verifyAssertion(assertion: any, record: Expected) {
  expect(assertion.id).toBe(record.credentialId);
  const auth = Buffer.from(assertion.response.authenticatorData, "base64url");
  const client = Buffer.from(assertion.response.clientDataJSON, "base64url");
  expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", challenge, origin: `https://${rp}`, crossOrigin: false });
  expect(auth.length).toBe(37);
  expect(auth.subarray(0, 32).toString("hex")).toBe(hash(rp));
  expect(auth[32]).toBe(5 | (record.backupEligible ? 8 : 0) | (record.backupState ? 16 : 0));
  expect(Buffer.from(assertion.response.userHandle, "base64url")).toEqual(Buffer.from([0, 1, 2, 255]));
  expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), createPublicKey({ key: Buffer.from(record.spki, "base64"), format: "der", type: "spki" }), Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
  const count = auth.readUInt32BE(33);
  const previousCount = record.signCount;
  expect(count).toBe(previousCount === 0 ? 0 : previousCount + 1);
  // Track the RP's actual accepted history across successive ceremonies/restart.
  record.signCount = count;
  return { credentialId: record.credentialId, algorithm: record.algorithm, flags: auth[32], count, storedCount: previousCount,
    independentSignatureVerified: true, counterAcceptedForRecordedHistory: previousCount === 0 && count === 0 || count > previousCount };
}

test("actual Android MDBX Passkeys authenticate in Edge and RSA registration persists through Native Host and restart", async ({}, info) => {
  test.skip(!fixture, "Explicit actual Android instrumentation artifact directory required");
  test.setTimeout(240_000);
  const input = path.resolve(fixture!);
  const proof = JSON.parse(await readFile(path.join(input, "passkey-signatures-import-evidence.json"), "utf8"));
  expect(proof.status).toBe("passed");
  for (const flag of ["androidSourcesUnchanged", "testSourcesUnchanged", "installedApplicationUnchanged", "installedTestApkUnchanged", "deviceBootUnchanged"]) expect(proof[flag], flag).toBe(true);
  for (const file of proof.outputs) expect(hash(await readFile(path.join(input, file.name)))).toBe(file.sha256);
  const returnEvidence = JSON.parse(await readFile(path.join(input, "signature-return-evidence.json"), "utf8"));
  expect(returnEvidence.status).toBe("passed");
  const source = path.join(input, "android-return-passkeys.mdbx");
  const sourceHash = hash(await readFile(source));
  expect(sourceHash).toBe(returnEvidence.inputSha256);
  const expected: Expected[] = JSON.parse(await readFile(path.join(input, "extension-passkey-expected.json"), "utf8"));
  expect(expected).toHaveLength(4);
  const appData = info.outputPath("host-appdata"); await mkdir(appData, { recursive: true });
  const profile = info.outputPath("passkey-native");
  const options = { locale: "zh-CN", viewport: { width: 1280, height: 860 }, env: { ...process.env, LOCALAPPDATA: appData },
    args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] };
  let context = await launchEdgeContext(profile, options);
  let host: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const evidence: Record<string, any> = { status: "failed", input, inputSha256: sourceHash, androidAppSha256: proof.installedApkSha256,
    signatures: [], consoleErrors: [], limitations: ["Synthetic relying party with actual Edge APIs, extension verification UI, Native Messaging and Android-produced data; no Android Credential Manager or hardware UV acceptance.", "Known Android backup-flag gaps remain open."] };
  let provider: ProviderAccount;
  let created: Expected;
  const watch = () => context.on("page", page => page.on("pageerror", error => evidence.consoleErrors.push(error.message)));
  watch();
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    host = await temporaryNativeHost(id, info.outputPath("native"));
    expect(host.evidence.sha256).toBe(returnEvidence.hostSha256);
    let manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/index.html`);
    await manager.getByLabel("主密码", { exact: true }).fill(password);
    await manager.locator('input[autocomplete="new-password"]').fill(password);
    await manager.getByRole("button", { name: "创建并解锁", exact: true }).click();
    await manager.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
    await manager.evaluate(() => chrome.storage.local.set({ "monica.sync.preferences.v1": { enabled: false } }));
    await manager.getByRole("button", { name: "密码源", exact: true }).click();
    await manager.locator("m3e-list-action").filter({ hasText: "连接 MDBX2 保险库" }).click();
    const dialog = manager.locator('.mdbx2-dialog[role="dialog"]');
    await dialog.getByLabel("显示名称", { exact: true }).fill(sourceName);
    await dialog.getByLabel("MDBX2 可移植备份", { exact: true }).setInputFiles(source);
    await dialog.getByLabel("保险库密码（可留空）", { exact: true }).fill(databasePassword);
    await dialog.locator("label").filter({ hasText: "设为新项目的默认保存目标" }).click();
    await dialog.getByRole("button", { name: "验证、解锁并导入", exact: true }).click();
    await dialog.waitFor({ state: "hidden", timeout: 60000 });
    provider = (await send(manager, { type: "PROVIDER_LIST" }) as ProviderAccount[]).find(row => row.name === sourceName)!;
    expect(provider).toMatchObject({ kind: "mdbx2", isDefaultSaveTarget: true });
    const list = async () => await send(manager, { type: "VAULT_LIST_ITEMS" }) as PasskeyItem[];
    await expect.poll(async () => (await list()).length).toBe(4);
    for (const record of expected) {
      const item = (await list()).find(row => row.credentialId === record.credentialId)!;
      expect(item).toMatchObject({ kind: "passkey", algorithm: record.algorithm, signCount: record.signCount, backupEligible: record.backupEligible, backupState: record.backupState, sourceMode: "browser-local" });
      expect(createHash("sha256").update(Buffer.from(item.privateKeyPkcs8!, "base64")).digest("base64")).toBe(record.keyMaterialSha256);
      expect(item.providerRefs.map(ref => ref.providerId)).toEqual([provider.id]);
    }
    await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
    let website = await context.newPage(); await website.goto(`https://${rp}/`);
    for (const record of expected) {
      await website.evaluate(value => { (window as any).credentialId = value; }, record.credentialId);
      await website.locator("#login").click(); await approve(context, website, "get");
      await expect(website.locator("#result")).toHaveText("authenticated");
      evidence.signatures.push(verifyAssertion(await website.evaluate(() => (window as any).assertion), record));
    }
    // Discoverable account selection uses the keyboard inside the real closed-shadow prompt.
    await website.evaluate(() => { (window as any).discover = true; });
    await website.locator("#login").click();
    await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
    await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
    await website.keyboard.press("End");
    await approve(context, website, "get", info.outputPath("android-account-choice.png"));
    await expect(website.locator("#result")).toHaveText("authenticated");
    const discovered = await website.evaluate(() => (window as any).assertion);
    expect(discovered.id).toBe((await list()).at(-1)!.credentialId);
    evidence.signatures.push({ ...verifyAssertion(discovered, expected.find(row => row.credentialId === discovered.id)!), discoverable: true });
    const beforeCancel = (await list()).map(row => [row.id, row.useCount]);
    await website.locator("#login").click(); await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
    await website.keyboard.press("Escape"); await expect(website.locator("#result")).toContainText("error:NotAllowedError");
    expect((await list()).map(row => [row.id, row.useCount])).toEqual(beforeCancel);
    evidence.discoveryAndCancel = true;

    await website.locator("#create").click(); await approve(context, website, "create", info.outputPath("mdbx-rsa-registration.png"));
    await expect(website.locator("#result")).toHaveText("registered");
    const registration = await website.evaluate(() => (window as any).registration);
    expect(registration.response.publicKeyAlgorithm).toBe(-257);
    expect(registration.clientExtensionResults).toEqual({ credProps: { rk: true } });
    const client = JSON.parse(Buffer.from(registration.response.clientDataJSON, "base64url").toString());
    expect(client).toMatchObject({ type: "webauthn.create", challenge, origin: `https://${rp}`, crossOrigin: false });
    const auth = Buffer.from(registration.response.authenticatorData, "base64url");
    expect(auth.subarray(0, 32).toString("hex")).toBe(hash(rp)); expect(auth[32]).toBe(0x5d); expect(auth.readUInt32BE(33)).toBe(0);
    const length = auth.readUInt16BE(53); expect(auth.subarray(55, 55 + length).toString("base64url")).toBe(registration.id);
    const cose = auth.subarray(55 + length);
    expect(cose.subarray(0, 11)).toEqual(Buffer.from("a401030339010020590100", "hex"));
    expect(cose.subarray(267)).toEqual(Buffer.from("2143010001", "hex"));
    const publicKey = createPublicKey({ format: "jwk", key: { kty: "RSA", n: cose.subarray(11, 267).toString("base64url"), e: "AQAB" } });
    expect(publicKey.export({ format: "der", type: "spki" })).toEqual(Buffer.from(registration.response.publicKey, "base64url"));
    const saved = (await list()).find(row => row.credentialId === registration.id)!;
    expect(saved).toMatchObject({ algorithm: -257, keyAlgorithm: "RSA", passkeyMode: "BW_COMPAT", signCount: 0, discoverable: true });
    expect(saved.providerRefs.map(ref => ref.providerId)).toEqual([provider.id]);
    created = { credentialId: saved.credentialId, algorithm: -257, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"), keyMaterialSha256: createHash("sha256").update(Buffer.from(saved.privateKeyPkcs8!, "base64")).digest("base64"), signCount: 0, backupEligible: true, backupState: true };
    expected.push(created);
    await website.evaluate(() => { (window as any).discover = false; });
    await website.locator("#login").click(); await approve(context, website, "get");
    await expect(website.locator("#result")).toHaveText("authenticated");
    evidence.signatures.push(verifyAssertion(await website.evaluate(() => (window as any).assertion), created));
    await website.evaluate(() => { (window as any).exclude = true; });
    await website.locator("#create").click(); await expect(website.locator("#result")).toContainText("error:InvalidStateError");
    expect(await list()).toHaveLength(5);
    await send(manager, { type: "PROVIDER_SYNC", providerId: provider.id });
    evidence.createdCredentialId = created.credentialId;

    await context.close(); context = await launchEdgeContext(profile, options); watch();
    const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    expect(new URL(restartedWorker.url()).host).toBe(id);
    manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/index.html`);
    await manager.getByLabel("主密码", { exact: true }).fill(password);
    await manager.getByRole("button", { name: "解锁", exact: true }).click();
    await manager.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
    // Reopen the actual managed Native copy; no file import or payload reseeding.
    await manager.getByRole("button", { name: "密码源", exact: true }).click();
    await manager.locator(`[data-home-provider-id="${provider.id}"]`).getByRole("button", { name: "解锁并设置", exact: true }).click();
    const reopened = manager.locator('.mdbx2-dialog[role="dialog"]');
    await reopened.getByLabel("保险库密码（可留空）", { exact: true }).fill(databasePassword);
    await reopened.getByRole("button", { name: "解锁本机副本", exact: true }).click();
    await reopened.getByRole("button", { name: "解锁本机副本", exact: true }).waitFor({ state: "hidden" });
    await reopened.getByRole("button", { name: "取消", exact: true }).click();
    await send(manager, { type: "PROVIDER_SYNC", providerId: provider.id });
    expect(await list()).toHaveLength(5);
    await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: html }));
    website = await context.newPage(); await website.goto(`https://${rp}/`);
    for (const record of expected.filter(row => row.algorithm === -257 || row.signCount > 0)) {
      await website.evaluate(value => { (window as any).credentialId = value; }, record.credentialId);
      await website.locator("#login").click(); await approve(context, website, "get");
      await expect(website.locator("#result")).toHaveText("authenticated");
      evidence.signatures.push({ ...verifyAssertion(await website.evaluate(() => (window as any).assertion), record), afterRestart: true });
    }
    await send(manager, { type: "PROVIDER_SYNC", providerId: provider.id });
    for (const record of expected) {
      const item = (await list()).find(row => row.credentialId === record.credentialId)!;
      expect(item.signCount).toBe(record.signCount);
      expect(createHash("sha256").update(Buffer.from(item.privateKeyPkcs8!, "base64")).digest("base64")).toBe(record.keyMaterialSha256);
      const ref = item.providerRefs.find(ref => ref.providerId === provider.id)!;
      expect(ref.remoteId).toBeTruthy();
      const native = await send(manager, { type: "MDBX2_OBJECT_REVEAL", providerId: provider.id, objectId: ref.remoteId });
      const payload = JSON.parse(native.payloadJson);
      expect(payload.credential_id).toBe(record.credentialId);
      expect(payload.sign_count).toBe(record.signCount);
      const decoded = decodeMdbx2Object(native, { headCommitId: native.headCommitId, updatedAt: item.updatedAt }, provider.id).item as PasskeyItem;
      expect(decoded.kind).toBe("passkey"); expect(decoded.algorithm).toBe(record.algorithm);
      expect(decoded.signCount).toBe(record.signCount);
      expect(createHash("sha256").update(Buffer.from(decoded.privateKeyPkcs8!, "base64")).digest("base64")).toBe(record.keyMaterialSha256);
      expect(decoded.backupEligible ?? true).toBe(record.backupEligible);
      expect(decoded.backupState ?? true).toBe(record.backupState);
    }
    const download = await send(manager, { type: "MDBX2_FILE_EXPORT_BEGIN", providerId: provider.id });
    const chunks: Buffer[] = [];
    try {
      for (let offset = 0; offset < download.sizeBytes;) {
        const chunk = await send(manager, { type: "MDBX2_FILE_EXPORT_READ", providerId: provider.id, downloadHandle: download.downloadHandle, offset });
        expect(chunk.nextOffset).toBeGreaterThan(offset); chunks.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
      }
    } finally { await send(manager, { type: "MDBX2_FILE_EXPORT_RELEASE", providerId: provider.id, downloadHandle: download.downloadHandle }); }
    const exported = Buffer.concat(chunks); expect(hash(exported)).toBe(download.sha256);
    await writeFile(info.outputPath("edge-passkeys.mdbx"), exported);
    await writeFile(info.outputPath("edge-passkeys-expected.json"), JSON.stringify(expected, null, 2));
    evidence.exportSha256 = hash(exported); evidence.restartVerified = true;
    evidence.compatibilityGaps = evidence.signatures.filter((row: any) => !row.counterAcceptedForRecordedHistory).map((row: any) => ({ kind: "positive-counter-reset", assumedRpHistory: row.storedCount, ...row }));
    expect(evidence.compatibilityGaps).toEqual([]);
    evidence.interoperabilityComplete = false;
    expect(hash(await readFile(source))).toBe(sourceHash);
    expect(evidence.consoleErrors).toEqual([]);
    await website.screenshot({ path: info.outputPath("mdbx-rsa-after-restart.png") });
    evidence.status = "passed";
  } catch (error) { evidence.error = String(error); throw error; }
  finally {
    await context.close();
    try { await host?.restore(); evidence.nativeHost = host?.evidence; }
    catch (error) { evidence.status = "failed"; evidence.cleanupError = String(error); throw error; }
    finally { await writeFile(info.outputPath("evidence.json"), JSON.stringify(evidence, null, 2)); }
  }
});
