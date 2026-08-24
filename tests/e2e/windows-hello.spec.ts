import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("Windows Hello remains manager-only and exposes a truthful device-key recovery UI", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("windows-hello-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);

    const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "" }));
    expect(setup).toMatchObject({ ok: true });
    await manager.reload();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();

    await manager.getByRole("button", { name: "设置与备份" }).click();
    const helloDisclosure = manager.locator("details.hello-disclosure");
    await expect(helloDisclosure.locator("summary")).toContainText("设备不可用 · 设备密钥");
    await helloDisclosure.locator("summary").click();
    await expect(helloDisclosure.getByText("使用 Windows Hello 保护设备密钥；私钥不离开本机。")).toBeVisible();

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const popupHello = await popup.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_HELLO_STATUS" })) as { ok: boolean; error?: string };
    expect(popupHello.ok).toBe(false);
    expect(popupHello.error).toContain("只允许 Monica 管理页调用");
    for (const request of [{ type: "VAULT_HELLO_ENROLL" }, { type: "VAULT_HELLO_REVOKE", confirmed: true }]) {
      const popupMutation = await popup.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as { ok: boolean; error?: string };
      expect(popupMutation.ok).toBe(false);
      expect(popupMutation.error).toContain("只允许 Monica 管理页调用");
    }

    const lock = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
    expect(lock).toMatchObject({ ok: true });
    await manager.reload();
    await expect(manager.getByRole("heading", { name: "解锁 Monica" })).toBeVisible();
    await expect(manager.getByText(/取消或超时会保持锁定|设备密钥模式可留空解锁/)).toBeVisible();

    const dimensions = await manager.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      gradients: [...document.querySelectorAll<HTMLElement>("*")]
        .map((element) => getComputedStyle(element).backgroundImage)
        .filter((value) => value.includes("gradient"))
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    expect(dimensions.gradients).toEqual([]);
  } finally {
    await context?.close();
  }
});
