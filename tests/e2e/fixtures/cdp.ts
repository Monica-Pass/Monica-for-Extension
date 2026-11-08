import type { CDPSession } from "@playwright/test";

/** Minimal response shape of chrome.runtime.sendMessage probes in extension e2e. */
export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/**
 * Sends a runtime message from the extension's isolated content-script world, which the page
 * main world cannot reach on its own. Every execution context is probed through CDP; the
 * extension isolated world is the target.
 */
export async function sendFromExtensionContentWorld(cdp: CDPSession, message: Record<string, unknown>): Promise<RuntimeResponse> {
  const contexts: Array<{ id: number }> = [];
  cdp.on("Runtime.executionContextCreated", (event) => contexts.push({ id: event.context.id }));
  await cdp.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const context of contexts) {
    try {
      const probe = await cdp.send("Runtime.evaluate", {
        contextId: context.id,
        expression: "typeof globalThis.chrome?.runtime?.sendMessage === 'function'",
        returnByValue: true
      });
      if (probe.result.value !== true) continue;
      const evaluated = await cdp.send("Runtime.evaluate", {
        contextId: context.id,
        expression: `globalThis.chrome.runtime.sendMessage(${JSON.stringify(message)})`,
        awaitPromise: true,
        returnByValue: true
      });
      if (evaluated.exceptionDetails) continue;
      const value = evaluated.result.value as RuntimeResponse | undefined;
      if (value && typeof value.ok === "boolean") return value;
    } catch {
      // Ignore page worlds and stale contexts; the extension isolated world is the target.
    }
  }
  throw new Error("未找到可调用 chrome.runtime.sendMessage 的 Monica 内容脚本执行上下文。");
}
