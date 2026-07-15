export interface WebPageSenderContext {
  tabId: number;
  frameId: number;
  url: string;
  origin: string;
}

export function assertTrustedExtensionPage(
  sender: chrome.runtime.MessageSender,
  runtimeId: string,
  extensionRoot: string
): void {
  if (sender.id !== runtimeId || !sender.url?.startsWith(extensionRoot)) {
    throw new Error("此命令只允许 Monica 插件页面调用。");
  }
}

export function requireTrustedWebPageSender(sender: chrome.runtime.MessageSender, runtimeId: string): WebPageSenderContext {
  const url = sender.url || "";
  const parsed = new URL(url);
  const frameId = sender.frameId ?? 0;
  if (
    sender.id !== runtimeId ||
    sender.tab?.id === undefined ||
    !Number.isInteger(sender.tab.id) ||
    sender.tab.id < 0 ||
    !Number.isInteger(frameId) ||
    frameId < 0 ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    (sender.origin !== undefined && sender.origin !== parsed.origin)
  ) {
    throw new Error("此命令只允许 Monica 网页内容脚本调用。");
  }
  return { tabId: sender.tab.id, frameId, url: parsed.toString(), origin: parsed.origin };
}

export function isSecureSensitivePageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
