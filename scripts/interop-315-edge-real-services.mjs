import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { chooseOption, loginEditor, save, fill, readItem, payloadHash } from "./interop-315-edge-features.mjs";

// Real Edge UI only. Fixtures point to isolated actual Docker services, not routes.
// Runtime messages below only inspect item/provider state.
export async function runRealServiceUiChecks({ page, evidence, screenshot, output }) {
  const path = process.env.MONICA_315_REAL_EDGE_FIXTURES;
  assert.ok(path, "MONICA_315_REAL_EDGE_FIXTURES must name successful real-service seed fixtures.");
  const fixtures = JSON.parse(await readFile(path, "utf8"));
  const expected = [];
  evidence.featureChecks ||= [];
  evidence.featurePersistence ||= [];
  for (const backend of ["webdav", "keepass", "vaultwarden"]) {
    if (!fixtures[backend]) { evidence.featureChecks.push({ name: `ui-real-${backend}`, status: "skipped", reason: "Actual server fixture preparation did not succeed." }); continue; }
    const fixture = fixtures[backend];
    try {
      console.error(`Real Edge Docker UI START ${backend}`);
      await page.reload();
      await page.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
      await page.getByRole("button", { name: "密码源", exact: true }).click();
      if (backend === "webdav") {
        await page.locator("m3e-list-action").filter({ hasText: "连接 Monica Android WebDAV" }).click();
        const dialog = page.getByRole("dialog", { name: "连接 Monica Android WebDAV", exact: true });
        await fill(dialog, { "显示名称": fixture.name, "WebDAV 地址 *": fixture.baseUrl, "用户名": fixture.username, "WebDAV 密码": fixture.password, "Android 备份加密密码（可选）": fixture.backupPassword });
        await dialog.getByRole("button", { name: "测试连接", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "加密保存", exact: true })).toBeEnabled({ timeout: 30000 });
        await dialog.getByRole("button", { name: "加密保存", exact: true }).click();
        await dialog.waitFor({ state: "hidden", timeout: 60000 });
      } else if (backend === "keepass") {
        await page.locator("m3e-list-action").filter({ hasText: "连接 KeePass" }).click();
        const dialog = page.getByRole("dialog", { name: "连接 KeePass", exact: true });
        await dialog.getByRole("radio", { name: "WebDAV 文件", exact: true }).click();
        await fill(dialog, { "显示名称": fixture.name, "WebDAV 地址": fixture.baseUrl, "用户名": fixture.username, "WebDAV 密码": fixture.password, "远端 .kdbx 位置": fixture.remotePath, "数据库密码（可留空）": fixture.databasePassword });
        await dialog.getByRole("button", { name: "连接并解锁", exact: true }).click();
        await dialog.waitFor({ state: "hidden", timeout: 60000 });
      } else {
        await page.locator("m3e-list-action").filter({ hasText: "连接 Bitwarden" }).click();
        const dialog = page.getByRole("dialog", { name: "连接 Bitwarden", exact: true });
        await fill(dialog, { "显示名称": fixture.name, "服务器地址 *": fixture.baseUrl, "邮箱 *": fixture.email, "主密码 *": fixture.password });
        await dialog.getByRole("button", { name: "登录并连接", exact: true }).click();
        await dialog.waitFor({ state: "hidden", timeout: 60000 });
      }
      const card = providerCard(fixture.name);
      const providerId = await card.getAttribute("data-home-provider-id");
      await synchronize(fixture.name);
      const imported = (await list()).filter(item => item.providerRefs.some(ref => ref.providerId === providerId));
      assert.equal(imported.length, backend === "keepass" ? 1 : fixture.itemCount);
      await screenshot(page, `real-${backend}-01-imported.png`);
      const title = `Edge Docker ${backend}315`;
      await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
      await page.locator('m3e-menu-item[data-create-type="GPG_KEY"]').click();
      let editor = loginEditor(page);
      await fill(editor, { "名称 *": title, "GPG 私钥": `SYNTHETIC-${backend}-GPG-PRIVATE`, "GPG 公钥": `SYNTHETIC-${backend}-GPG-PUBLIC`, "指纹": `SYNTHETIC-${backend}-FINGERPRINT`, "用户身份": "Synthetic User <synthetic@example.invalid>", "恢复备注与笔记": "Created with real Edge extension UI" });
      await chooseOption(editor.getByLabel("保存到", { exact: true }), { label: fixture.name });
      await save(editor);
      await page.getByLabel("搜索密码库", { exact: true }).fill(title);
      await page.getByLabel(`查看${title}详情`, { exact: true }).click();
      const detail = page.locator('[role="dialog"][data-item-kind="login"]');
      await expect(detail.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await detail.getByRole("button", { name: "编辑", exact: true }).click();
      editor = loginEditor(page);
      await editor.getByLabel("恢复备注与笔记", { exact: true }).fill("Edited with real Edge extension UI");
      await save(editor);
      await synchronize(fixture.name);
      const item = await find(title);
      assert.equal(item.loginType, "GPG_KEY");
      assert.equal(item.notes, "Edited with real Edge extension UI");
      const reference = item.providerRefs.find(ref => ref.providerId === providerId);
      assert.ok(reference?.remoteId && reference.revision);
      await page.getByLabel("搜索密码库", { exact: true }).fill(title);
      await page.getByRole("button", { name: `管理 ${title} 的附件`, exact: true }).click();
      const attachmentDialog = page.getByRole("dialog", { name: `附件 · ${title}`, exact: true });
      const bytes = Buffer.from(`Real Edge ${backend} attachment\n中文\0exact`);
      const addAttachment = attachmentDialog.getByRole("button", { name: "添加附件", exact: true });
      // Lit custom controls can receive a Playwright click while their disabled
      // property still guards the Vue handler during the initial attachment load.
      await expect.poll(() => addAttachment.evaluate(node => node.disabled)).toBe(false);
      await addAttachment.evaluate(async node => { await node.updateComplete; });
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        addAttachment.click()
      ]);
      await chooser.setFiles({ name: "edge-real-service.txt", mimeType: "text/plain", buffer: bytes });
      await expect(attachmentDialog.getByText("edge-real-service.txt", { exact: true })).toBeVisible({ timeout: 60000 });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        attachmentDialog.getByRole("button", { name: "下载 edge-real-service.txt", exact: true }).click()
      ]);
      assert.equal(hash(await readFile(await download.path())), hash(bytes));
      await screenshot(page, `real-${backend}-02-attachment.png`);
      await attachmentDialog.getByRole("button", { name: "关闭附件管理", exact: true }).click();
      await synchronize(fixture.name);
      const fresh = await find(title);
      const fields = { loginType: fresh.loginType, username: fresh.username, password: fresh.password, notes: fresh.notes, customFields: fresh.customFields };
      expected.push({ backend, title, fields, attachmentName: "edge-real-service.txt", attachmentSha256: hash(bytes), attachmentSize: bytes.length });
      evidence.featurePersistence.push({ id: fresh.id, title, sha256: payloadHash(fresh) });
      evidence.featureChecks.push({ name: `ui-real-${backend}`, status: "passed", details: { providerId, importedCount: imported.length, createdTitle: title, attachmentSha256: hash(bytes), transport: "actual Docker service HTTP; no Playwright route mocks", serverVerification: "independent adapter verifier required after this run" } });
    } catch (error) {
      evidence.featureChecks.push({ name: `ui-real-${backend}`, status: "failed", error: error.message, stack: error.stack });
      await screenshot(page, `real-${backend}-failed.png`).catch(() => undefined);
      console.error(`Real Edge Docker UI FAILED ${backend}: ${error.message}`);
    }
  }
  await writeFile(join(output, "real-services-ui-return.json"), JSON.stringify({ fixturePath: path, expected }, null, 2));
  evidence.limitations.push("Real Docker WebDAV/Vaultwarden UI changes require separate independent server readback; they do not prove Android application UI reopening or official Bitwarden cloud acceptance.");
  await page.reload(); await page.getByRole("heading", { name: "全部项目", exact: true }).waitFor();

  function providerCard(name) { return page.locator('[data-home-provider-id]').filter({ has: page.getByRole("heading", { name, exact: true }) }); }
  async function synchronize(name) {
    await page.getByRole("button", { name: "密码源", exact: true }).click();
    const card = providerCard(name); const sync = card.getByRole("button", { name: /^(立即同步|重试同步|写入本机副本)$/ }).first();
    await sync.click(); await expect(card.getByRole("button", { name: "取消同步", exact: true })).toHaveCount(0, { timeout: 60000 }); await expect(sync).toBeVisible({ timeout: 60000 });
    await expect(card.locator(".form-error")).toHaveCount(0);
    await page.getByRole("button", { name: /^全部项目/ }).click();
  }
  async function list() { const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })); assert.equal(response.ok, true, JSON.stringify(response)); return response.data; }
  async function find(title) { const item = (await list()).find(item => item.title === title); assert.ok(item); return readItem(page, item.id); }
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
