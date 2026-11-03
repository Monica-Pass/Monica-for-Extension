import { launchTestContext } from "./fixtures/edge";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import path from "node:path";
import { buildKeePassFixture } from "../../src/providers/keepass/keepass-fixture";

const GOLDEN = path.resolve("native/mdbx2-host/vendor/mdbx/crates/mdbx-storage/test-data/mdbx1-release-1.0.mdbx");

async function completeBackup(testInfo: { outputPath: (name: string) => string }): Promise<Uint8Array> {
  const { context, manager } = await openManager({ outputPath: name => testInfo.outputPath(`zip-seed-${name}`) });
  try {
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await manager.locator('input[type="file"][accept*=".mdbx"]').setInputFiles(GOLDEN);
    await manager.getByLabel("MDBX 密码").fill("mdbx1-golden-password");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible({ timeout: 90_000 });
    return await manager.evaluate(async () => {
      const send = async (request: Record<string, unknown>) => {
        const response = await chrome.runtime.sendMessage(request);
        if (!response.ok) throw new Error(response.error);
        return response.data;
      };
      const provider = (await send({ type: "PROVIDER_LIST" })).find((entry: { kind: string }) => entry.kind === "mdbx2");
      const descriptor = await send({ type: "MDBX2_FILE_EXPORT_BEGIN", providerId: provider.id });
      const chunks: number[][] = [];
      try {
        for (let offset = 0; offset < descriptor.sizeBytes;) {
          const part = await send({ type: "MDBX2_FILE_EXPORT_READ", providerId: provider.id, downloadHandle: descriptor.downloadHandle, offset });
          chunks.push(Array.from(atob(part.dataBase64), byte => byte.charCodeAt(0)));
          offset = part.nextOffset;
        }
        return { bytes: chunks.flat(), format: descriptor.format };
      } finally {
        await send({ type: "MDBX2_FILE_EXPORT_RELEASE", providerId: provider.id, downloadHandle: descriptor.downloadHandle });
      }
    }).then(({ bytes, format }) => format === "zip" ? new Uint8Array(bytes) : zipSync({ "vault.mdbx": new Uint8Array(bytes) }, { level: 0 }));
  } finally {
    await context.close();
  }
}

async function openManager(testInfo: { outputPath: (name: string) => string }): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await launchTestContext(testInfo.outputPath("mdbx-first-import-profile"), {
    channel: "chromium",
    headless: true,
    locale: "zh-CN",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(manager.getByRole("heading", { name: "创建加密密码库", exact: true })).toBeVisible();
  return { context, manager };
}

test("first-run shows three entries and keeps ordinary open locked", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await expect(manager.getByRole("heading", { name: "创建加密密码库", exact: true })).toBeVisible();
    await expect(manager.getByRole("tab", { name: "创建密码库" })).toBeVisible();
    await expect(manager.getByRole("tab", { name: "打开已有的密码库" })).toBeVisible();
    await expect(manager.getByRole("tab", { name: "恢复插件备份" })).toBeVisible();
    await expect(manager.getByRole("button", { name: "创建并解锁" })).toBeVisible();
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await expect(manager.getByText("将在独立工作副本上升级为 MDBX-2。原始文件不会被修改。").first()).toBeVisible();
    await mkdir("docs/design/first-run-import-20261031", { recursive: true });
    await manager.screenshot({ path: "docs/design/first-run-import-20261031/edge-first-run.png", fullPage: true });
    await manager.getByRole("tab", { name: "恢复插件备份" }).click();
    await expect(manager.getByText("恢复插件状态（条目与密码源配置）。独立 MDBX 数据库需要单独的 MDBX 备份。").first()).toBeVisible();
    const locked = await manager.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_VAULT_OPEN",
      input: {
        name: "locked",
        source: { kind: "file", handle: "11111111-1111-4111-8111-111111111111" },
        credential: { method: "password", password: "x" }
      }
    }));
    expect(locked).toMatchObject({ ok: false, code: "VAULT_LOCKED" });
  } finally {
    await context?.close();
  }
});

for (const container of ["mdbx", "zip"] as const) {
test(`uninitialized manager imports ${container} with a plugin master password and retains it after reload`, async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    const bytes = await readFile(GOLDEN);
    const originalHash = createHash("sha256").update(bytes).digest("hex");
    const inputFile = container === "mdbx" ? GOLDEN : testInfo.outputPath("complete-backup.zip");
    if (container === "zip") await writeFile(inputFile, await completeBackup(testInfo));
    await manager.locator('input[type="file"][accept*=".mdbx"]').setInputFiles(inputFile);
    await manager.getByLabel("MDBX 密码").fill("wrong-password");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("alert")).toContainText("密码或安全密钥不正确。");
    await manager.getByLabel("MDBX 密码").fill("mdbx1-golden-password");
    await manager.getByLabel("插件主密码", { exact: false }).fill("first-run-mdbx-master");
    await manager.getByLabel("确认主密码").fill("first-run-mdbx-master");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible({ timeout: 90_000 });
    const providers = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" }));
    expect(providers.ok).toBe(true);
    const account = providers.data.find((entry: { kind: string }) => entry.kind === "mdbx2");
    expect(account.config.runtimeBackend).toBe("browser");
    await manager.reload();
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword: "first-run-mdbx-master" }))).toMatchObject({ ok: true });
    await manager.reload();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible();
    const after = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" }));
    expect(after.data.filter((entry: { kind: string }) => entry.kind === "mdbx2")).toHaveLength(1);
    expect(after.data.find((entry: { kind: string }) => entry.kind === "mdbx2").config.vaultHandle).toBe(account.config.vaultHandle);
    expect(createHash("sha256").update(await readFile(GOLDEN)).digest("hex")).toBe(originalHash);
    await mkdir("docs/design/first-run-import-20261031", { recursive: true });
    await manager.screenshot({ path: `docs/design/first-run-import-20261031/edge-${container}-import.png`, fullPage: true });
    await manager.getByRole("button", { name: "密码源" }).click();
    await expect(manager.getByText("MDBX", { exact: false }).first()).toBeVisible();
  } finally {
    await context?.close();
  }
});
}

test("uninitialized manager imports an MDBX1 golden with a device key", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await manager.locator('input[type="file"][accept*=".mdbx"]').setInputFiles(GOLDEN);
    await manager.getByLabel("MDBX 密码").fill("mdbx1-golden-password");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible({ timeout: 90_000 });
  } finally {
    await context?.close();
  }
});

test("uninitialized manager imports a KeePass KDBX as an existing vault", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const bytes = await buildKeePassFixture({
      password: "first-run-kdbx-password",
      name: "First-run KDBX",
      entries: [{ title: "ctf.show", fields: { UserName: "alice@example.test", otp: "otpauth://totp/Synthetic:alice?secret=JBSWY3DPEHPK3PXP&issuer=Synthetic" }, protectedFields: { Password: "synthetic-secret" } }]
    });
    const kdbxPath = testInfo.outputPath("first-run.kdbx");
    await writeFile(kdbxPath, bytes);
    const opened = await openManager(testInfo);
    context = opened.context;
    const manager = opened.manager;
    await manager.getByRole("tab", { name: "打开已有的密码库" }).click();
    await manager.locator('input[type="file"][accept*=".kdbx"]').setInputFiles(kdbxPath);
    await manager.getByLabel("数据库密码（可留空）").fill("incorrect-password");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("alert").filter({ hasText: "数据库密码或密钥文件不正确" })).toBeVisible();
    await expect(manager.getByLabel("数据库密码（可留空）")).toHaveValue("");
    await manager.getByLabel("数据库密码（可留空）").fill("first-run-kdbx-password");
    await manager.getByRole("button", { name: "打开并接入密码库" }).click();
    await expect(manager.getByRole("heading", { name: "全部项目", exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(manager.getByText("ctf.show", { exact: false }).first()).toBeVisible();
    expect(await readFile(kdbxPath)).toEqual(Buffer.from(bytes));
    const items = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
    expect(items.data).toEqual(expect.arrayContaining([expect.objectContaining({ title: "ctf.show", username: "alice@example.test", password: "synthetic-secret" })]));
    expect(items.data.find((item: { title: string }) => item.title === "ctf.show").totpSecret).toContain("JBSWY3DPEHPK3PXP");
    await manager.getByRole("button", { name: /动态验证码/ }).click();
    await expect(manager.getByText("ctf.show", { exact: true })).toBeVisible();
    await mkdir("docs/design/first-run-import-20261031", { recursive: true });
    await manager.screenshot({ path: "docs/design/first-run-import-20261031/edge-kdbx-import.png", fullPage: true });
  } finally {
    await context?.close();
  }
});
