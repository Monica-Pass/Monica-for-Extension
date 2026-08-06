import { chromium, expect, test, type BrowserContext, type Download, type Locator, type Page, type TestInfo } from "@playwright/test";
import * as kdbxweb from "kdbxweb";
import path from "node:path";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";

const kdbxRuntime = ((kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb);
const DATABASE_PASSWORD = "keepass attachment fixture password";
const VAULT_PASSWORD = "keepass attachment manager password";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function launchExtension(testInfo: TestInfo): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("p"), {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 375, height: 1000 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  const setup = await manager.evaluate(async (masterPassword) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword }), VAULT_PASSWORD) as RuntimeResponse;
  expect(setup, setup.error).toMatchObject({ ok: true });
  await manager.reload();
  await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  return { context, manager };
}

test("KeePass attachments round-trip through a real KDBX session and remain usable at 375px with 200% text", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo);
    context = launched.context;
    const page = launched.manager;
    const fixture = await buildKeePassFixture({
      password: DATABASE_PASSWORD,
      version: 4,
      kdf: "argon2id",
      name: "KeePass Attachment Fixture",
      entries: [{
        title: "KeePass attachment account",
        fields: { UserName: "attachment@example.test", URL: "https://attachment.example.test" },
        protectedFields: { Password: "fixture-secret" },
        binaries: { "original.bin": new Uint8Array([1, 2, 3, 4]) }
      }]
    });

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "打开 KeePass 文件" }).click();
    const sourceDialog = page.getByRole("dialog", { name: "打开 KeePass 文件" });
    await sourceDialog.getByLabel("显示名称").fill("KeePass Attachment Source");
    await sourceDialog.getByLabel("KeePass 数据库文件").setInputFiles({
      name: "attachment-fixture.kdbx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture)
    });
    await sourceDialog.getByLabel("数据库密码（可留空）").fill(DATABASE_PASSWORD);
    await sourceDialog.getByRole("button", { name: "解锁并连接" }).click();
    await expect(sourceDialog).toHaveCount(0);
    const providerCard = page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name: "KeePass Attachment Source" }) });
    await expect(providerCard).toBeVisible();

    const providerResponse = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as RuntimeResponse<Array<{ id: string; name: string }>>;
    expect(providerResponse, providerResponse.error).toMatchObject({ ok: true });
    const provider = providerResponse.data?.find((candidate) => candidate.name === "KeePass Attachment Source");
    expect(provider).toBeTruthy();
    await providerCard.getByRole("button", { name: "立即同步" }).click();
    await expect.poll(async () => (await listItems(page)).some((item) => item.title === "KeePass attachment account")).toBe(true);

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    const manageButton = page.getByRole("button", { name: "管理 KeePass attachment account 的附件" });
    await expect(manageButton).toBeVisible();
    await expectMinimumTarget(manageButton);
    await manageButton.click();

    const dialog = page.getByRole("dialog", { name: "附件 · KeePass attachment account" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog).toHaveCSS("background-image", "none");
    await expect(dialog.locator(".attachment-list-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.locator(".attachment-list-shell")).toHaveCSS("background-image", "none");
    await expect(dialog.getByText("KeePass 附件保存在当前已解锁的 KDBX 会话中，完成后需要导出数据库文件。", { exact: false })).toBeVisible();
    await expect(dialog.getByText("original.bin", { exact: true })).toBeVisible();
    await expectNoGradients(dialog);
    await expectNoHorizontalOverflow(dialog);
    await expectIconsRemainFixedSize(dialog);
    await expectCentered(dialog.locator(".attachment-file-icon").first(), dialog.locator(".attachment-file-icon m3e-icon").first());
    const closeButton = dialog.locator('m3e-icon-button[aria-label="关闭附件管理"]');
    await expectMinimumTarget(closeButton);
    await expectCentered(closeButton, closeButton.locator("m3e-icon"));
    await expectVisibleTargetsAtLeast44(dialog);

    const initialDownload = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载 original.bin" }).click();
    expect(await downloadBytes(await initialDownload)).toEqual(Buffer.from([1, 2, 3, 4]));

    const addChooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "添加附件" }).click();
    await (await addChooser).setFiles({
      name: "new.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([5, 6, 7])
    });
    await expect(dialog.getByText("new.bin", { exact: true })).toBeVisible();
    await expect(dialog.locator(".provider-attachment-row").filter({ hasText: "new.bin" })).toContainText("3 B · 未知媒体类型");
    await expectNoHorizontalOverflow(dialog);

    const originalRow = dialog.locator(".provider-attachment-row").filter({ hasText: "original.bin" });
    const replaceChooser = page.waitForEvent("filechooser");
    await originalRow.getByRole("button", { name: "替换 original.bin 的内容" }).click();
    await (await replaceChooser).setFiles({
      name: "different-name.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([9, 8, 7, 6, 5])
    });
    await expect(dialog.getByText("different-name.bin", { exact: true })).toHaveCount(0);
    await expect(originalRow).toContainText("5 B");

    const replacedDownload = page.waitForEvent("download");
    await originalRow.getByRole("button", { name: "下载 original.bin" }).click();
    expect(await downloadBytes(await replacedDownload)).toEqual(Buffer.from([9, 8, 7, 6, 5]));

    const newRow = dialog.locator(".provider-attachment-row").filter({ hasText: "new.bin" });
    await newRow.getByRole("button", { name: "删除 new.bin" }).click();
    const confirmDelete = newRow.getByRole("button", { name: "确认删除" });
    await expect(confirmDelete).toBeFocused();
    await expect(confirmDelete).toBeVisible();
    await expectMinimumTarget(confirmDelete);
    await confirmDelete.click();
    await expect(dialog.getByText("new.bin", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("original.bin", { exact: true })).toBeVisible();
    await expect(dialog.locator('m3e-icon-button[aria-label="刷新附件列表"]')).toBeFocused();
    await expectNoHorizontalOverflow(dialog);
    await dialog.evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("keepass-attachments-dark-375-large-text.png") });

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.evaluate(() => localStorage.setItem("monica.scheme", "light"));
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    await page.getByRole("button", { name: "管理 KeePass attachment account 的附件" }).click();
    const lightDialog = page.getByRole("dialog", { name: "附件 · KeePass attachment account" });
    await expect(lightDialog).toHaveCSS("background-image", "none");
    await expectNoGradients(lightDialog);
    await expectNoHorizontalOverflow(lightDialog);
    await expectIconsRemainFixedSize(lightDialog);
    await expectVisibleTargetsAtLeast44(lightDialog);
    await page.screenshot({ path: testInfo.outputPath("keepass-attachments-light-375-large-text.png") });

    await lightDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    const refreshedCard = page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name: "KeePass Attachment Source" }) });
    await expect(refreshedCard.getByText("有尚未导出的 KDBX 修改", { exact: true })).toBeVisible();

    const exportDownload = page.waitForEvent("download");
    await refreshedCard.getByRole("button", { name: "导出 KDBX" }).click();
    const exported = await downloadBytes(await exportDownload);
    await expect(refreshedCard.getByText("有尚未导出的 KDBX 修改", { exact: true })).toHaveCount(0);
    await assertExportedDatabase(exported);
  } finally {
    await context?.close();
  }
});

async function listItems(page: Page): Promise<Array<Record<string, any>>> {
  const response = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as RuntimeResponse<Array<Record<string, any>>>;
  expect(response, response.error).toMatchObject({ ok: true });
  return response.data || [];
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function assertExportedDatabase(bytes: Buffer): Promise<void> {
  const database = await kdbxRuntime.Kdbx.load(new Uint8Array(bytes).slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  const entry = database.getDefaultGroup().entries.find((candidate) => fieldText(candidate.fields.get("Title")) === "KeePass attachment account");
  expect(entry).toBeTruthy();
  expect([...binaryBytes(entry!.binaries.get("original.bin")!)]).toEqual([9, 8, 7, 6, 5]);
  expect(entry!.binaries.has("new.bin")).toBe(false);
  expect(entry!.history).toHaveLength(3);
  expect([...binaryBytes(entry!.history[0].binaries.get("original.bin")!)]).toEqual([1, 2, 3, 4]);
  expect(entry!.history[0].binaries.has("new.bin")).toBe(false);
  expect([...binaryBytes(entry!.history[1].binaries.get("original.bin")!)]).toEqual([1, 2, 3, 4]);
  expect([...binaryBytes(entry!.history[1].binaries.get("new.bin")!)]).toEqual([5, 6, 7]);
  expect([...binaryBytes(entry!.history[2].binaries.get("original.bin")!)]).toEqual([9, 8, 7, 6, 5]);
  expect([...binaryBytes(entry!.history[2].binaries.get("new.bin")!)]).toEqual([5, 6, 7]);
}

function fieldText(value: kdbxweb.KdbxEntryField | undefined): string {
  return value instanceof kdbxRuntime.ProtectedValue ? value.getText() : typeof value === "string" ? value : "";
}

function binaryBytes(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const value = kdbxRuntime.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxRuntime.ProtectedValue ? value.getBinary() : new Uint8Array(value);
}

async function expectNoGradients(locator: Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => {
    const candidates = [root, ...root.querySelectorAll<HTMLElement>("*")];
    return candidates.flatMap((candidate) => {
      const image = getComputedStyle(candidate).backgroundImage;
      return /gradient\(/i.test(image) ? [{ tag: candidate.tagName.toLowerCase(), className: candidate.className, image }] : [];
    }).slice(0, 10);
  });
  expect(offenders).toEqual([]);
}

async function expectVisibleTargetsAtLeast44(locator: Locator): Promise<void> {
  const targets = locator.locator("m3e-button:visible, m3e-icon-button:visible, button:visible, select:visible");
  const count = await targets.count();
  for (let index = 0; index < count; index += 1) await expectMinimumTarget(targets.nth(index));
}

async function expectIconsRemainFixedSize(locator: Locator): Promise<void> {
  const issues = await locator.evaluate((root) => [...root.querySelectorAll<HTMLElement>("m3e-icon")].flatMap((icon) => {
    const rect = icon.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const fontSize = parseFloat(getComputedStyle(icon).fontSize);
    const cropped = icon.scrollWidth - icon.clientWidth > 1 || icon.scrollHeight - icon.clientHeight > 1;
    return fontSize > 24.1 || cropped
      ? [{
        name: (icon as HTMLElement & { name?: string }).name,
        parent: `${icon.parentElement?.tagName.toLowerCase()}.${icon.parentElement?.className || ""}`,
        customSize: getComputedStyle(icon).getPropertyValue("--m3e-icon-size"),
        fontSize,
        width: rect.width,
        height: rect.height,
        clientWidth: icon.clientWidth,
        scrollWidth: icon.scrollWidth
      }]
      : [];
  }));
  expect(issues).toEqual([]);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const report = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const descendants = [...element.querySelectorAll<HTMLElement>("*")];
    const offenders = descendants.flatMap((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const boundaryOverflow = Math.max(0, root.left - rect.left, rect.right - root.right);
      const contentOverflow = Math.max(0, candidate.scrollWidth - candidate.clientWidth);
      const overflow = Math.max(boundaryOverflow, contentOverflow);
      return overflow > 1 ? [{
        tag: candidate.tagName.toLowerCase(),
        className: candidate.className,
        overflow,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        clientWidth: candidate.clientWidth,
        scrollWidth: candidate.scrollWidth
      }] : [];
    }).slice(0, 10);
    const style = getComputedStyle(element);
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const verticalScrollbar = Math.max(0, element.offsetWidth - element.clientWidth - borders);
    return {
      overflow: Math.max(0, element.scrollWidth - element.clientWidth - verticalScrollbar),
      root: { left: root.left, right: root.right, width: root.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth },
      offenders
    };
  });
  expect(report.overflow, JSON.stringify(report)).toBeLessThanOrEqual(1);
}

async function expectMinimumTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function expectCentered(container: Locator, icon: Locator): Promise<void> {
  const [containerBox, iconBox] = await Promise.all([container.boundingBox(), icon.boundingBox()]);
  expect(containerBox).toBeTruthy();
  expect(iconBox).toBeTruthy();
  expect(Math.abs((containerBox!.x + containerBox!.width / 2) - (iconBox!.x + iconBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((containerBox!.y + containerBox!.height / 2) - (iconBox!.y + iconBox!.height / 2))).toBeLessThanOrEqual(1);
}
