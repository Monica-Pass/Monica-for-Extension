import { chromium, expect, test, type BrowserContext, type Download, type Locator, type Page, type TestInfo } from "@playwright/test";
import * as kdbxweb from "kdbxweb";
import path from "node:path";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";

const kdbxRuntime = ((kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb);
const DATABASE_PASSWORD = "keepass history fixture password";
const VAULT_PASSWORD = "keepass history manager password";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function launchExtension(testInfo: TestInfo): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("keepass-history-profile"), {
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

test("KeePass history reveals one field at a time and restores a complete KDBX4.1 version", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo);
    context = launched.context;
    const page = launched.manager;
    const fixture = await buildHistoryFixture();

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "打开 KeePass 文件" }).click();
    const sourceDialog = page.getByRole("dialog", { name: "打开 KeePass 文件" });
    await sourceDialog.getByLabel("显示名称").fill("KeePass History Source");
    await sourceDialog.getByLabel("KeePass 数据库文件").setInputFiles({
      name: "history-fixture.kdbx",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(fixture.bytes)
    });
    await sourceDialog.getByLabel("数据库密码（可留空）").fill(DATABASE_PASSWORD);
    await sourceDialog.getByRole("button", { name: "解锁并连接" }).click();

    const providerResponse = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as RuntimeResponse<Array<{ id: string; name: string }>>;
    expect(providerResponse, providerResponse.error).toMatchObject({ ok: true });
    const provider = providerResponse.data?.find((candidate) => candidate.name === "KeePass History Source");
    expect(provider).toBeTruthy();
    const providerCard = page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name: "KeePass History Source" }) });
    await providerCard.getByRole("button", { name: "立即同步" }).click();
    await expect.poll(async () => (await listItems(page)).some((item) => item.title === "KeePass history account")).toBe(true);

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    const historyButton = page.getByRole("button", { name: "查看 KeePass history account 的 KeePass 历史" });
    await expectMinimumTarget(historyButton);
    await historyButton.click();

    const dialog = page.getByRole("dialog", { name: "KeePass 历史 · KeePass history account" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog).toHaveCSS("background-image", "none");
    await expect(dialog.locator(".keepass-history-list-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.locator(".keepass-history-detail-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.locator(".keepass-history-row")).toHaveCount(2);
    await expect(dialog.getByText("old-secret", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("old-unknown", { exact: true })).toHaveCount(0);
    await expectNoGradients(dialog);
    await expectNoHorizontalOverflow(dialog);
    await expectIconsRemainFixedSize(dialog);
    await expectVisibleTargetsAtLeast44(dialog);
    const closeButton = dialog.locator('m3e-icon-button[aria-label="关闭 KeePass 历史"]');
    await expectCentered(closeButton, closeButton.locator("m3e-icon"));
    await expectCentered(dialog.locator(".keepass-history-icon").first(), dialog.locator(".keepass-history-icon m3e-icon").first());

    await dialog.locator(".keepass-history-row").last().click();
    await expect(dialog.getByRole("heading", { name: "字段" })).toBeVisible();
    await expect(dialog.getByText("old.bin", { exact: true })).toBeVisible();
    await expect(dialog.getByText("自定义元数据").locator("xpath=following-sibling::dd")).toHaveText("1 项");

    const passwordRow = dialog.locator(".keepass-history-fields li").filter({ has: page.getByText("Password", { exact: true }) });
    await expect(passwordRow).toContainText("受保护字段");
    await expect(passwordRow.getByRole("button", { name: "查看" })).toBeVisible();
    await passwordRow.getByRole("button", { name: "查看" }).click();
    await expect(passwordRow.getByText("old-secret", { exact: true })).toBeVisible();
    await passwordRow.getByRole("button", { name: "隐藏" }).click();
    await expect(passwordRow.getByText("old-secret", { exact: true })).toHaveCount(0);

    const unknownRow = dialog.locator(".keepass-history-fields li").filter({ has: page.getByText("Some Future Field", { exact: true }) });
    await unknownRow.getByRole("button", { name: "查看" }).click();
    await expect(unknownRow.getByText("old-unknown", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);

    await dialog.getByRole("button", { name: "准备恢复此版本" }).click();
    const confirmRestore = dialog.getByRole("button", { name: "确认恢复此版本" });
    await expect(confirmRestore).toBeFocused();
    await expectMinimumTarget(confirmRestore);
    await confirmRestore.click();
    await expect(dialog.getByText("需要导出 KDBX 才会永久保存", { exact: false })).toBeVisible();
    await expect(dialog.locator(".keepass-history-row")).toHaveCount(3);
    await expect(dialog.locator('m3e-icon-button[aria-label="刷新 KeePass 历史"]')).toBeFocused();
    await expect.poll(async () => (await listItems(page)).find((item) => item.title === "KeePass history account")?.username).toBe("old-user");
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("keepass-history-dark-375-large-text.png") });

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.evaluate(() => localStorage.setItem("monica.scheme", "light"));
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    await page.getByRole("button", { name: "查看 KeePass history account 的 KeePass 历史" }).click();
    const lightDialog = page.getByRole("dialog", { name: "KeePass 历史 · KeePass history account" });
    await expect(lightDialog).toHaveCSS("background-image", "none");
    await expectNoGradients(lightDialog);
    await expectNoHorizontalOverflow(lightDialog);
    await expectIconsRemainFixedSize(lightDialog);
    await expectVisibleTargetsAtLeast44(lightDialog);
    await page.screenshot({ path: testInfo.outputPath("keepass-history-light-375-large-text.png") });

    await lightDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    const refreshedCard = page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name: "KeePass History Source" }) });
    await expect(refreshedCard.getByText("有尚未导出的 KDBX 修改", { exact: true })).toBeVisible();
    const exportDownload = page.waitForEvent("download");
    await refreshedCard.getByRole("button", { name: "导出 KDBX" }).click();
    await assertExportedDatabase(await downloadBytes(await exportDownload), fixture.currentPreviousParentId);
  } finally {
    await context?.close();
  }
});

async function buildHistoryFixture(): Promise<{ bytes: Uint8Array; currentPreviousParentId: string }> {
  const base = await buildKeePassFixture({
    password: DATABASE_PASSWORD,
    version: 4,
    kdf: "argon2id",
    name: "KeePass History Fixture",
    entries: [{
      title: "KeePass history account",
      fields: { UserName: "current-user", URL: "https://history.example.test", "Some Future Field": "current-unknown" },
      protectedFields: { Password: "current-secret" },
      binaries: { "current.bin": new Uint8Array([9, 8, 7, 6]) },
      tags: ["current-tag"]
    }]
  });
  const database = await kdbxRuntime.Kdbx.load(base.slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  database.header.versionMinor = 1;
  database.meta.historyMaxItems = 10;
  const entry = database.getDefaultGroup().entries[0];
  const currentPreviousParent = kdbxRuntime.KdbxUuid.random();
  entry.previousParentGroup = currentPreviousParent;
  entry.customData = customData("custom-current", "2026-03-03T00:00:00.000Z");
  entry.qualityCheck = true;
  entry.autoType = { enabled: true, obfuscation: 0, defaultSequence: "{USERNAME}{TAB}{PASSWORD}{ENTER}", items: [{ window: "Current *", keystrokeSequence: "{PASSWORD}{ENTER}" }] };
  entry.times.lastModTime = new Date("2026-03-03T03:03:03.000Z");
  entry.history = [
    await historyState(database, entry, {
      username: "old-user",
      password: "old-secret",
      unknown: "old-unknown",
      attachmentName: "old.bin",
      attachmentBytes: new Uint8Array([1, 2, 3]),
      tag: "old-tag",
      customValue: "custom-old",
      customModifiedAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T01:01:01.000Z",
      qualityCheck: false,
      previousParentGroup: kdbxRuntime.KdbxUuid.random(),
      autoType: { enabled: false, obfuscation: 1, defaultSequence: "{USERNAME}{TAB}{PASSWORD}", items: [{ window: "Old *", keystrokeSequence: "{USERNAME}{ENTER}" }] }
    }),
    await historyState(database, entry, {
      username: "middle-user",
      password: "middle-secret",
      unknown: "middle-unknown",
      attachmentName: "middle.bin",
      attachmentBytes: new Uint8Array([4, 5]),
      tag: "middle-tag",
      customValue: "custom-middle",
      customModifiedAt: "2026-02-02T00:00:00.000Z",
      modifiedAt: "2026-02-02T02:02:02.000Z",
      qualityCheck: true,
      previousParentGroup: kdbxRuntime.KdbxUuid.random(),
      autoType: { enabled: true, obfuscation: 0, defaultSequence: "{USERNAME}{ENTER}", items: [{ window: "Middle *", keystrokeSequence: "{PASSWORD}{ENTER}" }] }
    })
  ];
  return { bytes: new Uint8Array(await database.save()), currentPreviousParentId: currentPreviousParent.toString() };
}

async function historyState(
  database: kdbxweb.Kdbx,
  live: kdbxweb.KdbxEntry,
  input: {
    username: string;
    password: string;
    unknown: string;
    attachmentName: string;
    attachmentBytes: Uint8Array;
    tag: string;
    customValue: string;
    customModifiedAt: string;
    modifiedAt: string;
    qualityCheck: boolean;
    previousParentGroup: kdbxweb.KdbxUuid;
    autoType: kdbxweb.KdbxEntryAutoType;
  }
): Promise<kdbxweb.KdbxEntry> {
  const history = new kdbxRuntime.KdbxEntry();
  history.copyFrom(live);
  history.fields = new Map<string, kdbxweb.KdbxEntryField>([
    ["Title", "KeePass history account"],
    ["UserName", input.username],
    ["Password", kdbxRuntime.ProtectedValue.fromString(input.password)],
    ["URL", "https://history.example.test"],
    ["Some Future Field", input.unknown]
  ]);
  history.binaries = new Map([[input.attachmentName, await database.createBinary(input.attachmentBytes.slice().buffer)]]);
  history.tags = [input.tag];
  history.customData = customData(input.customValue, input.customModifiedAt);
  history.qualityCheck = input.qualityCheck;
  history.previousParentGroup = input.previousParentGroup;
  history.autoType = JSON.parse(JSON.stringify(input.autoType)) as kdbxweb.KdbxEntryAutoType;
  history.times.lastModTime = new Date(input.modifiedAt);
  return history;
}

function customData(value: string, modifiedAt: string): kdbxweb.KdbxCustomDataMap {
  return new Map([["plugin-state", { value, lastModified: new Date(modifiedAt) }]]);
}

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

async function assertExportedDatabase(bytes: Buffer, currentPreviousParentId: string): Promise<void> {
  const database = await kdbxRuntime.Kdbx.load(new Uint8Array(bytes).slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  expect(database.versionMajor).toBe(4);
  expect(database.versionMinor).toBe(1);
  const entry = database.getDefaultGroup().entries.find((candidate) => fieldText(candidate.fields.get("Title")) === "KeePass history account")!;
  expect(fieldText(entry.fields.get("UserName"))).toBe("old-user");
  expect(fieldText(entry.fields.get("Password"))).toBe("old-secret");
  expect(entry.fields.get("Password")).toBeInstanceOf(kdbxRuntime.ProtectedValue);
  expect(fieldText(entry.fields.get("Some Future Field"))).toBe("old-unknown");
  expect([...binaryBytes(entry.binaries.get("old.bin")!)]).toEqual([1, 2, 3]);
  expect(entry.tags).toEqual(["old-tag"]);
  expect(entry.customData?.get("plugin-state")?.value).toBe("custom-old");
  expect(entry.customData?.get("plugin-state")?.lastModified?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  expect(entry.qualityCheck).toBe(false);
  expect(entry.autoType).toMatchObject({ enabled: false, obfuscation: 1, defaultSequence: "{USERNAME}{TAB}{PASSWORD}" });
  expect(entry.previousParentGroup?.toString()).toBe(currentPreviousParentId);
  expect(entry.history).toHaveLength(3);
  const capturedCurrent = entry.history.find((candidate) => fieldText(candidate.fields.get("UserName")) === "current-user")!;
  expect(capturedCurrent.customData?.get("plugin-state")?.value).toBe("custom-current");
  expect(capturedCurrent.qualityCheck).toBe(true);
  expect(capturedCurrent.previousParentGroup?.toString()).toBe(currentPreviousParentId);
  expect([...binaryBytes(capturedCurrent.binaries.get("current.bin")!)]).toEqual([9, 8, 7, 6]);
  expect(entry.history.some((candidate) => fieldText(candidate.fields.get("UserName")) === "middle-user")).toBe(true);
}

function fieldText(value: kdbxweb.KdbxEntryField | undefined): string {
  return value instanceof kdbxRuntime.ProtectedValue ? value.getText() : typeof value === "string" ? value : "";
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
    return fontSize > 24.1 || cropped ? [{ name: (icon as HTMLElement & { name?: string }).name, fontSize, width: rect.width, height: rect.height }] : [];
  }));
  expect(issues).toEqual([]);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const report = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const offenders = [...element.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const overflow = Math.max(0, root.left - rect.left, rect.right - root.right);
      return overflow > 1 ? [{ tag: candidate.tagName.toLowerCase(), className: candidate.className, overflow }] : [];
    }).slice(0, 10);
    return { ownOverflow: element.scrollWidth - element.clientWidth, offenders };
  });
  expect(report.ownOverflow).toBeLessThanOrEqual(1);
  expect(report.offenders).toEqual([]);
}

async function expectMinimumTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(43.5);
  expect(box!.height).toBeGreaterThanOrEqual(43.5);
}

async function expectCentered(host: Locator, icon: Locator): Promise<void> {
  const hostBox = await host.boundingBox();
  const iconBox = await icon.boundingBox();
  expect(hostBox).toBeTruthy();
  expect(iconBox).toBeTruthy();
  expect(Math.abs((hostBox!.x + hostBox!.width / 2) - (iconBox!.x + iconBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((hostBox!.y + hostBox!.height / 2) - (iconBox!.y + iconBox!.height / 2))).toBeLessThanOrEqual(1);
}
