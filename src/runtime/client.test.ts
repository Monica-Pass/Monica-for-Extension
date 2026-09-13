import { afterEach, describe, expect, it, vi } from "vitest";
import { version } from "../../package.json";

const compatible = { ok: true, data: { version, protocolVersion: 1 } };
const unsupported = { ok: false, error: "不支持的 Monica 运行时命令。" };

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("UI and background compatibility", () => {
  it("checks compatibility before sending a password to an older background", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? unsupported : { ok: true, data: [] });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.unlock("synthetic secret")).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
    expect(sendMessage.mock.calls.map(([request]) => request)).toEqual([{ type: "RUNTIME_INFO" }]);
  });

  it.each([
    { version: "0.0.0", protocolVersion: 1 },
    { version, protocolVersion: 99 },
    null
  ])("rejects incompatible or malformed runtime information: %j", async data => {
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.status()).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent checks, then checks again immediately before unlocking", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? compatible : { ok: true, data: request.type === "VAULT_STATUS" ? "locked" : [] });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await Promise.all([vaultClient.status(), vaultClient.listItems()]);
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "RUNTIME_INFO")).toHaveLength(1);
    await vaultClient.unlock("synthetic password");
    expect(sendMessage.mock.calls.slice(-2).map(([request]) => request.type)).toEqual(["RUNTIME_INFO", "VAULT_UNLOCK"]);
  });

  it("retries a failed compatibility check after the background becomes available", async () => {
    let ready = false;
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? ready ? compatible : unsupported : { ok: true, data: "locked" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.status()).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
    ready = true;
    await expect(vaultClient.status()).resolves.toBe("locked");
  });

  it("preserves a real authentication failure instead of treating it as an upgrade", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? compatible : { ok: false, error: "主密码错误。", code: "TEST_AUTHENTICATION_FAILURE" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.unlock("wrong password")).rejects.toMatchObject({ message: "主密码错误。", code: "TEST_AUTHENTICATION_FAILURE" });
  });

  it("offers recovery if a supported command disappears after the initial check", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? compatible : unsupported);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.lockedAutofillIds()).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
  });
});
