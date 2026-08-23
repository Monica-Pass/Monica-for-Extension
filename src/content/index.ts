import type { CredentialCaptureInput, ExtensionResponse, PasskeyPromptContext, PasskeyRequest, PasskeyResult, SavePromptContext, WalletFillPayload } from "../runtime/messages";
import { installCredentialCapture } from "./content-lifecycle";
import { fillCredential, scanPageWithFieldContext, type FillCredentialInput } from "./dom";
import { createCurrentFieldContext } from "./field-signature";
import { createFieldContextsForRoot } from "./field-signature";
import { renderSavePrompt } from "./save-prompt";
import { fillWallet } from "./wallet-dom";
import { closePasskeyPrompt, renderPasskeyPrompt } from "./passkey-prompt";

chrome.runtime.onMessage.addListener((message: { type?: string; credential?: FillCredentialInput; context?: SavePromptContext; wallet?: WalletFillPayload; expectedOrigin?: string; candidateId?: string }, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")) || sender.tab !== undefined) return false;
  if (message?.type === "MONICA_SCAN_PAGE") {
    void scanPageWithFieldContext().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "MONICA_GET_FIELD_CONTEXT") {
    void createCurrentFieldContext().then((context) => sendResponse({ ok: true, context })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "MONICA_FILL_CREDENTIAL") {
    if (message.expectedOrigin !== location.origin) return void sendResponse({ ok: false, error: "页面来源已变化，已阻止填充。" });
    sendResponse(fillCredential(message.credential || {}));
    return false;
  }
  if (message?.type === "MONICA_FILL_WALLET" && message.wallet) {
    if (message.expectedOrigin !== location.origin) return void sendResponse({ ok: false, error: "页面来源已变化，已阻止敏感信息填充。" });
    sendResponse(fillWallet(message.wallet));
    return false;
  }
  if (message?.type === "MONICA_SHOW_SAVE_PROMPT" && message.context) {
    showPrompt(message.context);
    return false;
  }
  if (message?.type === "MONICA_CANCEL_PASSKEY" && message.candidateId) {
    const active = [...activePasskeyRequests.values()].find((request) => request.candidateId === message.candidateId);
    if (active) active.cancelFromBackground();
    else pendingBackgroundPasskeyCancellations.add(message.candidateId);
    window.setTimeout(() => pendingBackgroundPasskeyCancellations.delete(message.candidateId!), 120_000);
    return false;
  }
  return false;
});

installCredentialCapture({ onCandidate: submitCandidate, onUsernameContext: rememberUsernameContext });

if (window.top === window) void restorePendingPrompt();

interface PasskeyCancellationReason { message: string; name: "AbortError" | "NotAllowedError"; }
const activePasskeyRequests = new Map<string, { candidateId: string; dismiss: (reason?: PasskeyCancellationReason) => Promise<boolean>; cancelFromBackground: () => void }>();
const pendingPasskeyCancellations = new Map<string, PasskeyCancellationReason>();
const pendingBackgroundPasskeyCancellations = new Set<string>();
let currentPasskeyRequestId: string | undefined;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin || !event.data?.requestId) return;
  const requestId = String(event.data.requestId);
  if (event.data.source === "monica-passkey-page-cancel") {
    const reason = cancellationReason(event.data);
    const active = activePasskeyRequests.get(requestId);
    if (active) void active.dismiss(reason).then((cancelled) => { if (cancelled) closePasskeyPrompt(); });
    else pendingPasskeyCancellations.set(requestId, reason);
    window.setTimeout(() => pendingPasskeyCancellations.delete(requestId), 120_000);
    return;
  }
  if (event.data.source !== "monica-passkey-page") return;
  if (requestId.length > 128 || !isBoundedBridgeRequest(event.data.request)) {
    window.postMessage({ source: "monica-passkey-extension", requestId: requestId.slice(0, 128), error: "Passkey 请求格式无效或过大。", name: "DataError" }, location.origin);
    return;
  }
  window.postMessage({ source: "monica-passkey-extension", requestId, ack: true }, location.origin);
  void handlePasskeyRequest(requestId, event.data.request as PasskeyRequest);
});

async function handlePasskeyRequest(requestId: string, request: PasskeyRequest): Promise<void> {
  if (currentPasskeyRequestId && currentPasskeyRequestId !== requestId) {
    window.postMessage({ source: "monica-passkey-extension", requestId, error: "已有另一个 Passkey 请求正在处理。", name: "NotAllowedError" }, location.origin);
    return;
  }
  currentPasskeyRequestId = requestId;
  try {
    const context = await sendRuntime<PasskeyPromptContext>({ type: "PASSKEY_BEGIN", request });
    let settled = false;
    let accepting = false;
    let requestedCancellation: PasskeyCancellationReason | undefined;
    let dismissalInFlight: Promise<boolean> | undefined;
    const finish = () => {
      activePasskeyRequests.delete(requestId);
      pendingPasskeyCancellations.delete(requestId);
      if (currentPasskeyRequestId === requestId) currentPasskeyRequestId = undefined;
    };
    const rejectPage = (reason: PasskeyCancellationReason | { message: string; name: "InvalidStateError" | "NotSupportedError" }) => {
      if (settled) return;
      settled = true;
      finish();
      window.postMessage({ source: "monica-passkey-extension", requestId, error: reason.message, name: reason.name }, location.origin);
    };
    const resolvePage = (result: PasskeyResult) => {
      if (settled) return;
      settled = true;
      finish();
      window.postMessage({ source: "monica-passkey-extension", requestId, result }, location.origin);
    };
    const resolveDismissal = async (reason: PasskeyCancellationReason): Promise<boolean> => {
      const deadline = Math.max(context.expiresAt, Date.now()) + 125_000;
      while (!settled && Date.now() < deadline) {
        try {
          const result = await sendRuntimeWithTransportRetry<{ cancelled: boolean; pending?: boolean; result?: PasskeyResult }>({ type: "PASSKEY_DISMISS", candidateId: context.candidateId }, 2);
          if (result.result) {
            resolvePage(result.result);
            closePasskeyPrompt();
            return false;
          }
          if (result.cancelled !== false) {
            rejectPage(reason);
            return true;
          }
          if (!result.pending) return false;
        } catch {
          if (!accepting) {
            rejectPage(reason);
            return true;
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      if (!settled) {
        rejectPage(reason);
        return true;
      }
      return false;
    };
    const dismiss = (reason: PasskeyCancellationReason = { message: "用户取消了 Passkey 操作。", name: "NotAllowedError" }): Promise<boolean> => {
      if (settled) return Promise.resolve(false);
      if (!requestedCancellation || reason.name === "AbortError") requestedCancellation = reason;
      if (dismissalInFlight) return dismissalInFlight;
      dismissalInFlight = resolveDismissal(requestedCancellation).finally(() => { dismissalInFlight = undefined; });
      return dismissalInFlight;
    };
    const cancelFromBackground = () => {
      if (settled) return;
      rejectPage({ message: "密码库已锁定，Passkey 请求已取消。", name: "NotAllowedError" });
      closePasskeyPrompt();
    };
    activePasskeyRequests.set(requestId, { candidateId: context.candidateId, dismiss, cancelFromBackground });
    if (pendingBackgroundPasskeyCancellations.delete(context.candidateId)) return void cancelFromBackground();
    const pendingCancellation = pendingPasskeyCancellations.get(requestId);
    if (pendingCancellation) return void await dismiss(pendingCancellation);
    renderPasskeyPrompt(context, async (itemId, providerId) => {
      if (settled) return;
      accepting = true;
      let result: PasskeyResult;
      try {
        result = await sendRuntimeWithTransportRetry<PasskeyResult>({ type: "PASSKEY_ACCEPT", candidateId: context.candidateId, itemId, providerId }, 2);
      } catch (error) {
        if (settled) return;
        if (error instanceof RuntimeRequestError && (error.code === "PASSKEY_CANCELLED" || error.code === "PASSKEY_EXCLUDED")) {
          const reason = error.code === "PASSKEY_EXCLUDED"
            ? { message: error.message, name: "InvalidStateError" as const }
            : requestedCancellation || { message: error.message, name: "NotAllowedError" as const };
          rejectPage(reason);
          closePasskeyPrompt();
          return;
        }
        if (error instanceof RuntimeRequestError && error.code !== "PASSKEY_COMMIT_UNKNOWN") accepting = false;
        if (requestedCancellation) {
          const cancelled = await dismiss(requestedCancellation);
          if (cancelled) closePasskeyPrompt();
          if (settled) return;
        }
        throw error;
      }
      if (settled) return;
      resolvePage(result);
    }, async () => { await dismiss(); });
  } catch (error) {
    activePasskeyRequests.delete(requestId);
    if (currentPasskeyRequestId === requestId) currentPasskeyRequestId = undefined;
    const cancellation = pendingPasskeyCancellations.get(requestId);
    pendingPasskeyCancellations.delete(requestId);
    const code = error instanceof RuntimeRequestError ? error.code : undefined;
    const name = cancellation?.name || (code === "PASSKEY_EXCLUDED"
      ? "InvalidStateError"
      : code === "VAULT_LOCKED" || code === "PASSKEY_UNAVAILABLE" || !(error instanceof RuntimeRequestError)
        ? "NotSupportedError"
        : "NotAllowedError");
    window.postMessage({ source: "monica-passkey-extension", requestId, error: cancellation?.message || (error instanceof Error ? error.message : "Passkey 请求失败。"), name }, location.origin);
  }
}

function cancellationReason(input: Record<string, unknown>): PasskeyCancellationReason {
  return {
    message: typeof input.message === "string" && input.message.length <= 512 ? input.message : "Passkey 请求已取消。",
    name: input.name === "AbortError" ? "AbortError" : "NotAllowedError"
  };
}

function isBoundedBridgeRequest(request: unknown): request is PasskeyRequest {
  if (!request || typeof request !== "object") return false;
  try {
    return JSON.stringify(request).length <= 64 * 1024;
  } catch {
    return false;
  }
}

async function submitCandidate(candidate: CredentialCaptureInput, root: ParentNode): Promise<void> {
  try {
    const contexts = await createFieldContextsForRoot(root);
    const context = await sendRuntime<SavePromptContext>({ type: "CREDENTIAL_CAPTURE", candidate: { ...candidate, fieldSignatures: [...new Set(contexts.map((field) => field.signature))] } });
    if (window.top === window) showPrompt(context);
  } catch (error) {
    // Locked vaults and unsupported pages fail closed without retaining the password in page state.
    console.warn("[Monica] Credential candidate rejected:", error instanceof Error ? error.message : "unknown error");
  }
}

function rememberUsernameContext(username: string): void {
  void sendRuntime({ type: "CREDENTIAL_USERNAME_REMEMBER", username }).catch(() => {
    // Locked vaults and pages navigating away do not retain username context.
  });
}

async function restorePendingPrompt(): Promise<void> {
  try {
    const context = await sendRuntime<SavePromptContext | null>({ type: "CREDENTIAL_PENDING" });
    if (context) showPrompt(context);
  } catch {
    // No pending candidate is the normal case.
  }
}

function showPrompt(context: SavePromptContext): void {
  renderSavePrompt(context, {
    accept: (providerId, existingItemId) => sendRuntime<{ action: "saved" | "updated"; title: string; providerName: string; syncPending: boolean }>({ type: "CREDENTIAL_ACCEPT", candidateId: context.candidateId, providerId, existingItemId }),
    dismiss: () => sendRuntime({ type: "CREDENTIAL_DISMISS", candidateId: context.candidateId })
  });
}

async function sendRuntime<T>(request: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as ExtensionResponse<T>;
  if (!response?.ok) throw new RuntimeRequestError(response?.error || "Monica 后台操作失败。", response?.code);
  return response.data;
}

async function sendRuntimeWithTransportRetry<T>(request: unknown, retries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await sendRuntime<T>(request);
    } catch (error) {
      if (error instanceof RuntimeRequestError || attempt === retries) throw error;
      lastError = error;
      await new Promise((resolve) => window.setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Monica 后台通信中断。");
}

class RuntimeRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
