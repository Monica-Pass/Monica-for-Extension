import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount, type VaultItem } from "../../src/core/model";
import { launchEdgeContext } from "./fixtures/edge";
import { temporaryNativeHost } from "./fixtures/native-host";

const master = "Synthetic complete backup master password";
const databasePassword = "Synthetic transfer fixture password";
const sourceFixture = process.env.MONICA_317_NATIVE_PASSKEY_FIXTURE || "";
const rp = "passkey-interop.example.test";
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function send(page: Page, message: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), message);
  expect(result.ok, result.error).toBe(true); return result.data;
}

test("real Edge complete MDBX backup restores password projects, external attachments and original Passkeys", async ({}, info) => {
  test.skip(!sourceFixture, 'Requires an explicit verified Android MDBX fixture and Windows Native Host');
  test.setTimeout(240_000);
  const evidence: Record<string, any> = { status: "failed", androidApplicationAcceptance: false, phases: [], errors: [] };
  const inputProof = JSON.parse(await readFile(path.join(sourceFixture, "evidence.json"), "utf8"));
  expect(inputProof.status).toBe("passed");
  const originalFile = path.resolve(sourceFixture, "edge-passkeys.mdbx");
  const originalHash = hash(await readFile(originalFile)); expect(originalHash).toBe(inputProof.exportSha256);
  const originalKeys = JSON.parse(await readFile(path.join(sourceFixture, "edge-passkeys-expected.json"), "utf8"));
  const runRoot = path.resolve(".tmp/complete-backup-317", randomUUID().slice(0, 8)); await mkdir(runRoot, { recursive: true });
  evidence.runRoot = runRoot; evidence.input = { path: originalFile, sha256: originalHash };
  const appData = (phase: string) => path.join(runRoot, phase);
  const options = (phase: string) => ({ locale: "zh-CN", viewport: { width: 1180, height: 960 }, env: { ...process.env, LOCALAPPDATA: appData(phase) },
    args: [`--disable-extensions-except=${path.resolve("dist")}`, `--load-extension=${path.resolve("dist")}`] });
  await mkdir(appData("source"), { recursive: true }); await mkdir(appData("restored"), { recursive: true });
  let context = await launchEdgeContext(info.outputPath("source-profile"), options("source"));
  let host: Awaited<ReturnType<typeof temporaryNativeHost>> | undefined;
  const watch = () => context.on("page", page => page.on("pageerror", error => evidence.errors.push(error.message))); watch();
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host; const root = `chrome-extension://${extensionId}/`;
    host = await temporaryNativeHost(extensionId, info.outputPath("native"));
    let page = await context.newPage(); await page.goto(`${root}index.html`);
    const setup = async () => {
      await send(page, { type: "VAULT_SETUP", masterPassword: master });
      await page.evaluate(() => chrome.storage.local.set({ "monica.sync.preferences.v1": { enabled: false } }));
      await page.reload();
    };
    await setup();
    expect(await send(page, { type: "MDBX2_HOST_STATUS" })).toMatchObject({ capabilities: { supportsCompleteBackup: true } });
    const sources = async () => { await page.getByRole("button", { name: "密码源", exact: true }).click(); };
    const openImport = async (file: string, name: string, width = 1180) => {
      await page.setViewportSize({ width: 1180, height: 960 }); await sources();
      await page.locator("m3e-list-action").filter({ hasText: "连接 MDBX2 保险库" }).click();
      const dialog = page.locator('.mdbx2-dialog[role="dialog"]');
      await dialog.getByLabel("显示名称", { exact: true }).fill(name);
      await dialog.getByLabel("MDBX2 可移植备份", { exact: true }).setInputFiles(file);
      await page.setViewportSize({ width, height: 960 }); return dialog;
    };
    const importFile = async (file: string, name: string) => {
      const dialog = await openImport(file, name);
      await dialog.getByLabel("保险库密码（可留空）", { exact: true }).fill(databasePassword);
      await dialog.getByRole("button", { name: "验证、解锁并导入", exact: true }).click();
      await expect(dialog).toHaveCount(0, { timeout: 60000 });
      const provider = (await send(page, { type: "PROVIDER_LIST" }) as ProviderAccount[]).find(row => row.name === name)!;
      expect(provider?.kind).toBe("mdbx2"); return provider;
    };
    let provider = await importFile(originalFile, "完整备份来源");
    await sources();
    await expect(page.getByText("含外部附件时导出完整备份 ZIP，可在插件中直接打开。Android 暂不支持直接恢复此 ZIP，请保留完整备份。", { exact: true })).toBeVisible();
    const list = () => send(page, { type: "VAULT_LIST_ITEMS" }) as Promise<VaultItem[]>;
    expect(await list()).toHaveLength(5);
    const card = () => page.locator(`[data-home-provider-id="${provider.id}"]`);
    const exportFile = async (name: string) => {
      await page.setViewportSize({ width: 1180, height: 960 }); await sources();
      const downloading = page.waitForEvent("download");
      await card().getByRole("button", { name: "导出 MDBX2 完整备份", exact: true }).click();
      const download = await downloading; const output = path.join(runRoot, name); await download.saveAs(output);
      expect(await download.failure()).toBeNull(); return { output, suggested: download.suggestedFilename(), bytes: await readFile(output) };
    };
    const embedded = await exportFile("embedded-passkeys.mdbx");
    expect(embedded.suggested).toMatch(/\.mdbx$/); expect(embedded.bytes.subarray(0, 4).toString()).not.toBe("PK\x03\x04");
    evidence.phases.push("standalone-encrypted-mdbx-download");
    const group = randomUUID();
    const base = createLoginItem({ title: "完整备份密码项目", username: "backup@example.test", password: "first-synthetic-password", uris: ["https://backup.example.test", "https://backup.example.test/account"], notes: "Synthetic multiline note\n原样保留", providerRefs: [{ providerId: provider.id }] });
    const first: LoginItem = { ...base, passwordGroupId: group, sortOrder: 0, customFields: [{ name: "恢复说明", value: "synthetic recovery codes", protected: true }, { name: "__monica_manual_stack_group", value: "complete-backup-stack", protected: false }] };
    const second: LoginItem = { ...first, id: randomUUID(), password: "second-synthetic-password", sortOrder: 1 };
    await send(page, { type: "VAULT_SAVE_PASSWORD_GROUP", items: [first, second], expected: {} });
    await send(page, { type: "PROVIDER_SYNC", providerId: provider.id });
    const passwords = (await list()).filter((row): row is LoginItem => row.kind === "login");
    expect(passwords).toHaveLength(2); expect(new Set(passwords.map(row => row.passwordGroupId))).toEqual(new Set([group]));
    const attachedTo = passwords.find(row => row.id === first.id)!;
    const attachment = Buffer.alloc(3 * 1024 * 1024 + 73); for (let i = 0; i < attachment.length; i++) attachment[i] = i % 251;
    const upload = await send(page, { type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId: provider.id, itemId: attachedTo.id,
      fileName: "完整附件.bin", mediaType: "application/octet-stream", sizeBytes: attachment.length, sha256: hash(attachment) });
    for (let offset = 0; offset < attachment.length; offset += 128 * 1024) await send(page, { type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId: provider.id, transferId: upload.transferId, offset, dataBase64: attachment.subarray(offset, offset + 128 * 1024).toString("base64") });
    await send(page, { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId: provider.id, itemId: attachedTo.id, transferId: upload.transferId });
    await send(page, { type: "PROVIDER_SYNC", providerId: provider.id });
    const before = await list();
    const originals = await Promise.all(before.map(async row => ({ objectId: row.providerRefs[0].remoteId!, value: await send(page, { type: "MDBX2_OBJECT_REVEAL", providerId: provider.id, objectId: row.providerRefs[0].remoteId }) })));
    // Click the actual cancel action while the normal export/sync work is running.
    await sources(); let downloads = 0; const onDownload = () => downloads++; page.on("download", onDownload);
    await card().getByRole("button", { name: "导出 MDBX2 完整备份", exact: true }).click();
    await card().getByRole("button", { name: "取消导出", exact: true }).click();
    await expect(card().getByRole("button", { name: "导出 MDBX2 完整备份", exact: true })).toBeEnabled();
    expect(downloads).toBe(0); page.off("download", onDownload);
    expect(await list()).toEqual(before); evidence.phases.push("cancel-export-no-download-or-item-change");
    const archive = await exportFile("complete.mdbx-backup.zip"); expect(archive.suggested).toMatch(/\.mdbx-backup\.zip$/);
    const files = unzipSync(archive.bytes); expect(files["vault.mdbx"]).toBeTruthy();
    const blobs = Object.keys(files).filter(name => name !== "vault.mdbx"); expect(blobs.length).toBeGreaterThan(0);
    for (const name of blobs) { expect(name).toMatch(/^vault\.mdbx\.blobs\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/); expect(hash(files[name])).toBe(name.split("/").at(-1)); }
    await expect(page.getByText("完整备份已导出并校验，包含数据库和附件。恢复时使用原数据库密码。", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("complete-backup-source.png"), fullPage: true });
    expect((await readdir(path.join(appData("source"), "Monica Extension/MDBX2"))).filter(name => name.startsWith("complete-backup-"))).toEqual([]);
    evidence.archive = { path: archive.output, sha256: hash(archive.bytes), fileCount: Object.keys(files).length, blobCount: blobs.length, bytes: archive.bytes.length };
    await writeFile(path.join(runRoot, "expected-native-objects.json"), JSON.stringify(originals, null, 2));
    await writeFile(path.join(runRoot, "expected-items.json"), JSON.stringify(before, null, 2));
    evidence.phases.push("complete-zip-download-and-ciphertext-hashes");
    await context.close();
    const restoredProfile = info.outputPath("restore-profile"); context = await launchEdgeContext(restoredProfile, options("restored")); watch();
    page = await context.newPage(); await page.goto(`${root}index.html`); await setup();
    const providersBeforeImport = await send(page, { type: "PROVIDER_LIST" });
    let dialog = await openImport(archive.output, "完整备份恢复", 320);
    expect(await dialog.locator('.mdbx2-host-row').evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    expect(await dialog.evaluate(node => node.querySelector('.mdbx2-mode-picker')!.getBoundingClientRect().top >= node.querySelector('.mdbx2-host-row')!.getBoundingClientRect().bottom)).toBe(true);
    await page.screenshot({ path: info.outputPath("complete-restore-cancel-320.png") });
    await page.evaluate(() => { (window as any).cancelEvents = []; for (const type of ["pointerdown", "pointerup", "click"]) document.addEventListener(type, event => { (window as any).cancelEvents.push({ type, path: event.composedPath().filter(node => node instanceof HTMLElement).slice(0, 5).map(node => (node as HTMLElement).localName + ':' + (node as HTMLElement).textContent?.slice(0, 35)) }); }, true); });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await writeFile(info.outputPath("cancel-click-events.json"), JSON.stringify(await page.evaluate(() => (window as any).cancelEvents), null, 2));
    await page.screenshot({ path: info.outputPath("after-cancel-320.png") });
    await expect(dialog).toHaveCount(0);
    expect(await send(page, { type: "PROVIDER_LIST" })).toEqual(providersBeforeImport); expect(await list()).toEqual([]);
    evidence.phases.push("cancel-import-before-write");
    dialog = await openImport(archive.output, "完整备份恢复", 420);
    await dialog.getByLabel("保险库密码（可留空）", { exact: true }).fill("wrong synthetic password");
    await dialog.getByRole("button", { name: "验证、解锁并导入", exact: true }).click();
    await expect(dialog.locator('.form-error')).toBeVisible({ timeout: 30000 });
    expect(await send(page, { type: "PROVIDER_LIST" })).toEqual(providersBeforeImport); expect(await list()).toEqual([]);
    await page.screenshot({ path: info.outputPath("complete-restore-wrong-password-420.png") });
    await dialog.getByLabel("保险库密码（可留空）", { exact: true }).fill(databasePassword);
    await dialog.getByRole("button", { name: "验证、解锁并导入", exact: true }).click(); await expect(dialog).toHaveCount(0, { timeout: 60000 });
    provider = (await send(page, { type: "PROVIDER_LIST" }) as ProviderAccount[]).find(row => row.kind === "mdbx2")!; expect(provider.name).toBe("完整备份恢复");
    const verifyRestored = async () => {
      const rows = await list(); expect(rows).toHaveLength(before.length);
      for (const original of originals) expect(await send(page, { type: "MDBX2_OBJECT_REVEAL", providerId: provider.id, objectId: original.objectId })).toEqual(original.value);
      const restoredPasswords = rows.filter((row): row is LoginItem => row.kind === "login");
      expect(restoredPasswords.map(row => [row.passwordGroupId, row.password, row.customFields, row.uris, row.notes, row.sortOrder]).sort()).toEqual(before.filter((row): row is LoginItem => row.kind === "login").map(row => [row.passwordGroupId, row.password, row.customFields, row.uris, row.notes, row.sortOrder]).sort());
      const item = rows.find(row => row.providerRefs[0].remoteId === attachedTo.providerRefs[0].remoteId)!;
      const attachments = await send(page, { type: "PROVIDER_ATTACHMENT_LIST", providerId: provider.id, itemId: item.id }); expect(attachments.items).toHaveLength(1);
      const start = await send(page, { type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId: provider.id, itemId: item.id, attachmentId: attachments.items[0].attachmentId });
      const chunks: Buffer[] = [];
      try { for (let offset = 0; offset < start.sizeBytes;) {
        const chunk = await send(page, { type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId: provider.id, readHandle: start.readHandle, offset });
        const bytes = Buffer.from(chunk.dataBase64, "base64"); expect(chunk.nextOffset).toBe(offset + bytes.length); chunks.push(bytes); offset = chunk.nextOffset;
      } } finally { await send(page, { type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId: provider.id, readHandle: start.readHandle }); }
      expect(Buffer.concat(chunks)).toEqual(attachment);
      for (const expected of originalKeys) {
        const key = rows.find((row): row is PasskeyItem => row.kind === "passkey" && row.credentialId === expected.credentialId)!;
        expect(key).toMatchObject({ algorithm: expected.algorithm, signCount: expected.signCount });
        const original = before.find((row): row is PasskeyItem => row.kind === "passkey" && row.credentialId === expected.credentialId)!;
        expect([key.backupEligible, key.backupState]).toEqual([original.backupEligible, original.backupState]);
        expect([key.backupEligible ?? true, key.backupState ?? true]).toEqual([expected.backupEligible, expected.backupState]);
        expect(createHash("sha256").update(Buffer.from(key.privateKeyPkcs8!, "base64")).digest("base64")).toBe(expected.keyMaterialSha256);
      }
    };
    await verifyRestored(); evidence.phases.push("wrong-password-retry-and-exact-native-project-key-attachment-readback");
    await page.setViewportSize({ width: 1180, height: 960 });
    await page.getByRole("button", { name: /^登录项/ }).click();
    await page.getByLabel("查看完整备份密码项目详情", { exact: true }).click();
    await expect(page.locator('[data-project-navigation] [data-password-member-id]')).toHaveCount(2);
    await page.setViewportSize({ width: 320, height: 960 }); await page.screenshot({ path: info.outputPath("complete-restored-project-320.png"), fullPage: true });
    await context.close(); context = await launchEdgeContext(restoredProfile, options("restored")); watch();
    page = await context.newPage(); await page.goto(`${root}index.html`); await send(page, { type: "VAULT_UNLOCK", masterPassword: master }); await page.reload(); await sources();
    await card().getByRole("button", { name: "解锁并设置", exact: true }).click(); dialog = page.locator('.mdbx2-dialog[role="dialog"]');
    await dialog.getByLabel("保险库密码（可留空）", { exact: true }).fill(databasePassword); await dialog.getByRole("button", { name: "解锁本机副本", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "解锁本机副本", exact: true })).toHaveCount(0); await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await send(page, { type: "PROVIDER_SYNC", providerId: provider.id }); await verifyRestored(); evidence.phases.push("browser-and-native-host-restart-exact-readback");
    // Authenticate with the original Edge-created RSA key after archive restore/restart.
    const key = originalKeys.at(-1); const challenge = Buffer.alloc(32, 87).toString("base64url");
    await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><button id="login">Sign in</button><output id="result"></output><script>login.onclick=async()=>{try{const c=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',userVerification:'required',allowCredentials:[{type:'public-key',id:'${key.credentialId}'}],timeout:60000})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent=e.name+':'+e.message;}}</script>` }));
    const website = await context.newPage(); await website.goto(`https://${rp}/`); await website.locator("#login").click();
    await expect(website.locator("#monica-passkey-prompt-host")).toHaveCount(1);
    await expect.poll(() => website.evaluate(() => document.activeElement?.id)).toBe("monica-passkey-prompt-host");
    const opened = context.waitForEvent("page"); await website.keyboard.press("Tab"); await website.keyboard.press("Tab"); await website.keyboard.press("Enter");
    const verificationPage = await opened; await verificationPage.getByLabel("Monica 主密码", { exact: true }).fill(master); await verificationPage.getByRole("button", { name: "确认", exact: true }).click();
    await expect(website.locator("#result")).toHaveText("authenticated"); const assertion = await website.evaluate(() => (window as any).assertion);
    expect(assertion.id).toBe(key.credentialId); const auth = Buffer.from(assertion.response.authenticatorData, "base64url"), client = Buffer.from(assertion.response.clientDataJSON, "base64url");
    expect(JSON.parse(client.toString())).toMatchObject({ type: "webauthn.get", challenge, origin: `https://${rp}`, crossOrigin: false });
    expect(auth.length).toBe(37); expect(auth.subarray(0, 32).toString("hex")).toBe(hash(rp)); expect(auth[32]).toBe(29); expect(auth.readUInt32BE(33)).toBe(0);
    expect(Buffer.from(assertion.response.userHandle, "base64url")).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" }), Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
    await writeFile(path.join(runRoot, "restored-rsa-assertion.json"), JSON.stringify(assertion, null, 2));
    evidence.phases.push("original-edge-rsa-platform-webauthn-independent-signature");
    expect(hash(await readFile(originalFile))).toBe(originalHash); expect(evidence.errors).toEqual([]); evidence.status = "passed";
  } catch (error) { evidence.error = String(error); throw error; }
  finally {
    await context.close();
    try { await host?.restore(); evidence.nativeHost = host?.evidence; }
    catch (error) { evidence.status = "failed"; evidence.cleanupError = String(error); throw error; }
    finally { await writeFile(info.outputPath("evidence.json"), JSON.stringify(evidence, null, 2)); }
  }
});
