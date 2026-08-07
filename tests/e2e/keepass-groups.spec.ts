import { chromium, expect, test, type BrowserContext, type Download, type Locator, type Page, type TestInfo } from "@playwright/test";
import * as kdbxweb from "kdbxweb";
import path from "node:path";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";

const kdbxRuntime = ((kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb);
const DATABASE_PASSWORD = "keepass group fixture password";
const VAULT_PASSWORD = "keepass group manager password";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface GroupFixture {
  bytes: Uint8Array;
  accountsUuid: string;
  workUuid: string;
}

async function launchExtension(testInfo: TestInfo): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("keepass-group-profile"), {
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

test("KeePass groups preserve nested KDBX data through create rename move recycle and restore", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo);
    context = launched.context;
    const page = launched.manager;
    const fixture = await buildGroupFixture();

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "连接 KeePass" }).click();
    const sourceDialog = page.getByRole("dialog", { name: "连接 KeePass" });
    await sourceDialog.getByLabel("显示名称").fill("KeePass Group Source");
    await sourceDialog.getByLabel("KeePass 数据库文件").setInputFiles({
      name: "group-fixture.kdbx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.bytes)
    });
    await sourceDialog.getByLabel("数据库密码（可留空）").fill(DATABASE_PASSWORD);
    await sourceDialog.getByRole("button", { name: "解锁并连接" }).click();

    const providerCard = page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name: "KeePass Group Source" }) });
    const manageGroups = providerCard.getByRole("button", { name: "管理分组" });
    await expect(manageGroups).toBeVisible();
    await expectMinimumTarget(manageGroups);
    await manageGroups.click();

    const dialog = page.getByRole("dialog", { name: "KeePass 分组 · KeePass Group Source" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog).toHaveCSS("background-image", "none");
    await expect(dialog.locator(".keepass-groups-list-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.locator(".keepass-groups-list-shell")).toHaveCSS("background-image", "none");
    await expect(dialog).not.toContainText(fixture.accountsUuid);
    await expect(dialog).not.toContainText(fixture.workUuid);
    await expect(groupRow(dialog, "Work")).toContainText("Accounts > Work");
    await expectNoGradients(dialog);
    await expectNoHorizontalOverflow(dialog);
    await expectIconsRemainFixedSize(dialog);
    await expectVisibleTargetsAtLeast44(dialog);
    const closeButton = dialog.locator('m3e-icon-button[aria-label="关闭 KeePass 分组管理"]');
    await expectMinimumTarget(closeButton);
    await expectCentered(closeButton, closeButton.locator("m3e-icon"));
    await expectCentered(dialog.locator(".keepass-group-icon").first(), dialog.locator(".keepass-group-icon m3e-icon").first());

    await dialog.getByRole("button", { name: "新建分组" }).click();
    const createForm = dialog.locator(".keepass-group-create");
    await createForm.getByLabel("分组名称").fill("Projects");
    await createForm.getByLabel("父分组").selectOption({ label: "Accounts > Work" });
    await createForm.getByRole("button", { name: "创建", exact: true }).click();
    await expect(groupRow(dialog, "Projects")).toContainText("Accounts > Work > Projects");

    await groupRow(dialog, "Projects").click();
    await dialog.getByRole("button", { name: "重命名" }).click();
    const renameForm = dialog.locator('[data-group-mode="rename"]');
    await renameForm.getByLabel("新名称").fill("Client Projects");
    await renameForm.getByRole("button", { name: "保存名称" }).click();
    await expect(groupRow(dialog, "Client Projects")).toContainText("Accounts > Work > Client Projects");

    await expect(groupRow(dialog, "Client Projects")).toHaveAttribute("aria-expanded", "true");
    await dialog.getByRole("button", { name: "移动", exact: true }).click();
    const moveForm = dialog.locator('[data-group-mode="move"]');
    await moveForm.getByLabel("目标父分组").selectOption({ label: "Archive" });
    await moveForm.getByRole("button", { name: "确认移动" }).click();
    await expect(groupRow(dialog, "Client Projects")).toContainText("Archive > Client Projects");

    await groupRow(dialog, "Work").click();
    await dialog.getByRole("button", { name: "移入回收站" }).click();
    const confirmDelete = dialog.getByRole("button", { name: "确认移入回收站" });
    await expect(confirmDelete).toBeFocused();
    await expectMinimumTarget(confirmDelete);
    await confirmDelete.click();
    await expect(dialog.getByRole("tab", { name: /回收站/ })).toHaveAttribute("aria-selected", "true");
    const recycledWork = groupRow(dialog, "Work");
    await expect(recycledWork).toContainText("可恢复");
    await expect(recycledWork).toHaveAttribute("aria-expanded", "true");
    await dialog.getByRole("button", { name: "恢复完整分组树" }).click();
    const restoreForm = dialog.locator('[data-group-mode="restore"]');
    await restoreForm.getByRole("button", { name: "确认恢复" }).click();
    await expect(dialog.getByRole("tab", { name: /分组/ })).toHaveAttribute("aria-selected", "true");
    await expect(groupRow(dialog, "Work")).toContainText("Accounts > Work");
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("keepass-groups-dark-375-large-text.png") });

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.evaluate(() => localStorage.setItem("monica.scheme", "light"));
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    const refreshedCard = page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name: "KeePass Group Source" }) });
    await refreshedCard.getByRole("button", { name: "管理分组" }).click();
    const lightDialog = page.getByRole("dialog", { name: "KeePass 分组 · KeePass Group Source" });
    await expect(lightDialog).toHaveCSS("background-image", "none");
    await expectNoGradients(lightDialog);
    await expectNoHorizontalOverflow(lightDialog);
    await expectIconsRemainFixedSize(lightDialog);
    await expectVisibleTargetsAtLeast44(lightDialog);
    await page.screenshot({ path: testInfo.outputPath("keepass-groups-light-375-large-text.png") });
    await lightDialog.getByRole("button", { name: "关闭", exact: true }).click();

    await expect(refreshedCard.getByText("有尚未导出的 KDBX 修改", { exact: true })).toBeVisible();
    const exportDownload = page.waitForEvent("download");
    await refreshedCard.getByRole("button", { name: "导出 KDBX" }).click();
    const exported = await downloadBytes(await exportDownload);
    await assertExportedDatabase(exported, fixture);
  } finally {
    await context?.close();
  }
});

async function buildGroupFixture(): Promise<GroupFixture> {
  const initial = await buildKeePassFixture({
    password: DATABASE_PASSWORD,
    version: 4,
    kdf: "argon2id",
    name: "KeePass Group Fixture",
    entries: [{
      title: "Nested account",
      fields: { UserName: "groups@example.test" },
      protectedFields: { Password: "group-secret" }
    }]
  });
  const database = await kdbxRuntime.Kdbx.load(initial.slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  database.header.versionMinor = 1;
  const root = database.getDefaultGroup();
  const accounts = database.createGroup(root, "Accounts");
  const work = database.createGroup(accounts, "Work");
  database.createGroup(root, "Archive");
  database.move(root.entries[0], work);
  work.notes = "group note";
  work.tags = ["android-compatible"];
  work.customData = new Map([["plugin", { value: "future-value", lastModified: new Date("2026-08-02T00:00:00.000Z") }]]);
  const entry = work.entries[0];
  entry.binaries.set("document.bin", await database.createBinary(new Uint8Array([1, 2, 3, 4]).buffer));
  entry.pushHistory();
  entry.fields.set("Notes", "current value");
  return {
    bytes: new Uint8Array(await database.save()),
    accountsUuid: accounts.uuid.toString(),
    workUuid: work.uuid.toString()
  };
}

function groupRow(dialog: Locator, name: string): Locator {
  return dialog.locator(".keepass-group-row").filter({ has: dialog.page().getByText(name, { exact: true }) });
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function assertExportedDatabase(bytes: Buffer, fixture: GroupFixture): Promise<void> {
  const database = await kdbxRuntime.Kdbx.load(new Uint8Array(bytes).slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  const accounts = database.getGroup(fixture.accountsUuid)!;
  const work = database.getGroup(fixture.workUuid)!;
  const archive = database.getDefaultGroup().groups.find((group) => group.name === "Archive")!;
  expect(work.parentGroup).toBe(accounts);
  expect(work.previousParentGroup).toBeUndefined();
  expect(work.notes).toBe("group note");
  expect(work.tags).toEqual(["android-compatible"]);
  expect(work.customData?.get("plugin")?.value).toBe("future-value");
  expect(work.entries).toHaveLength(1);
  expect(work.entries[0].history).toHaveLength(1);
  expect([...binaryBytes(work.entries[0].binaries.get("document.bin")!)]).toEqual([1, 2, 3, 4]);
  expect(archive.groups.map((group) => group.name)).toContain("Client Projects");
  const recycleBin = database.getGroup(database.meta.recycleBinUuid!);
  expect(recycleBin?.groups.map((group) => group.uuid.toString())).not.toContain(fixture.workUuid);
}

function binaryBytes(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const value = kdbxRuntime.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxRuntime.ProtectedValue ? value.getBinary() : new Uint8Array(value);
}

async function expectNoGradients(locator: Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => {
    const image = getComputedStyle(candidate).backgroundImage;
    return /gradient\(/i.test(image) ? [{ tag: candidate.tagName.toLowerCase(), className: candidate.className, image }] : [];
  }).slice(0, 10));
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
    return fontSize > 24.1 || cropped ? [{ fontSize, width: rect.width, height: rect.height, clientWidth: icon.clientWidth, scrollWidth: icon.scrollWidth }] : [];
  }));
  expect(issues).toEqual([]);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const report = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const offenders = [...element.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const overflow = Math.max(0, root.left - rect.left, rect.right - root.right, candidate.scrollWidth - candidate.clientWidth);
      return overflow > 1 ? [{ tag: candidate.tagName.toLowerCase(), className: candidate.className, overflow }] : [];
    }).slice(0, 10);
    const style = getComputedStyle(element);
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const verticalScrollbar = Math.max(0, element.offsetWidth - element.clientWidth - borders);
    return { overflow: Math.max(0, element.scrollWidth - element.clientWidth - verticalScrollbar), offenders };
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
