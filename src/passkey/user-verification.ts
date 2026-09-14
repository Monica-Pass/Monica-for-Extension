import type { PasskeyVerificationContext } from "../runtime/messages";
import { assertTrustedExtensionPage } from "../runtime/sender-policy";

interface Verification extends PasskeyVerificationContext {
  candidateId: string;
  windowId?: number;
  timer: ReturnType<typeof setTimeout>;
  attempts: number;
  busy: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Passwords never enter the requesting website, its DOM or its content-script bridge. */
export class PasskeyUserVerification {
  private readonly pending = new Map<string, Verification>();

  constructor(
    private readonly verifyPassword: (password: string) => Promise<void>,
    private readonly browser: Pick<typeof chrome, "runtime" | "windows"> = chrome,
    private readonly now: () => number = Date.now
  ) {
    browser.windows.onRemoved.addListener(windowId => {
      for (const entry of this.pending.values()) if (entry.windowId === windowId) this.finish(entry, false);
    });
  }

  request(input: Omit<PasskeyVerificationContext, "verificationId"> & { candidateId: string }): Promise<void> {
    if (input.expiresAt <= this.now()) return Promise.reject(new Error("Passkey 身份验证已过期。"));
    this.cancelCandidate(input.candidateId);
    const verificationId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const entry: Verification = {
        ...input, verificationId, attempts: 0, busy: false, resolve, reject,
        timer: setTimeout(() => this.finish(entry, false), input.expiresAt - this.now())
      };
      this.pending.set(verificationId, entry);
      void this.browser.windows.create({
        url: this.browser.runtime.getURL(`passkey-verify.html?request=${verificationId}`),
        type: "popup", width: 460, height: 580, focused: true
      }).then(window => {
        entry.windowId = window?.id;
        if (!this.pending.has(verificationId)) this.closeWindow(entry);
        else if (entry.windowId === undefined) this.finish(entry, false);
      }).catch(() => this.finish(entry, false));
    });
  }

  context(verificationId: string, sender: chrome.runtime.MessageSender): PasskeyVerificationContext {
    const entry = this.require(verificationId, sender);
    return { verificationId, operation: entry.operation, rpId: entry.rpId, origin: entry.origin, accountName: entry.accountName, expiresAt: entry.expiresAt };
  }

  async verify(verificationId: string, password: string, sender: chrome.runtime.MessageSender): Promise<void> {
    const entry = this.require(verificationId, sender);
    if (entry.busy) throw new Error("正在验证身份，请稍候。");
    if (typeof password !== "string" || !password || password.length > 4096) throw new Error("请输入 Monica 主密码。");
    entry.busy = true;
    entry.attempts++;
    try {
      await this.verifyPassword(password);
      this.require(verificationId, sender);
      this.finish(entry, true);
    } catch (error) {
      if (entry.attempts >= 5) this.finish(entry, false);
      throw error;
    } finally {
      password = "";
      entry.busy = false;
    }
  }

  cancel(verificationId: string, sender: chrome.runtime.MessageSender): void {
    this.finish(this.require(verificationId, sender), false);
  }

  cancelCandidate(candidateId: string): void {
    for (const entry of this.pending.values()) if (entry.candidateId === candidateId) this.finish(entry, false);
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) this.finish(entry, false);
  }

  private require(verificationId: string, sender: chrome.runtime.MessageSender): Verification {
    const root = this.browser.runtime.getURL("");
    assertTrustedExtensionPage(sender, this.browser.runtime.id, root);
    const url = new URL(sender.url!);
    if (url.pathname !== "/passkey-verify.html" || url.searchParams.get("request") !== verificationId || (sender.frameId ?? 0) !== 0) {
      throw new Error("此命令只允许当前 Monica 身份验证窗口调用。");
    }
    const entry = this.pending.get(verificationId);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.finish(entry, false);
      throw new Error("Passkey 身份验证已取消或过期，请返回网站重试。");
    }
    return entry;
  }

  private finish(entry: Verification, verified: boolean): void {
    if (!this.pending.delete(entry.verificationId)) return;
    clearTimeout(entry.timer);
    this.closeWindow(entry);
    if (verified) entry.resolve();
    else entry.reject(new Error("Passkey 身份验证已取消或过期。"));
  }

  private closeWindow(entry: Verification): void {
    if (entry.windowId !== undefined) void this.browser.windows.remove(entry.windowId).catch(() => undefined);
  }
}
