import type { CredentialCaptureInput, ExtensionResponse, SavePromptContext, WalletFillPayload } from "../runtime/messages";
import { captureCredentialInput, captureRootForEvent } from "./credential-capture";
import { fillCredential, scanPage, type FillCredentialInput } from "./dom";
import { renderSavePrompt } from "./save-prompt";
import { fillWallet } from "./wallet-dom";

chrome.runtime.onMessage.addListener((message: { type?: string; credential?: FillCredentialInput; context?: SavePromptContext; wallet?: WalletFillPayload }, _sender, sendResponse) => {
  if (message?.type === "MONICA_SCAN_PAGE") {
    sendResponse(scanPage());
    return false;
  }
  if (message?.type === "MONICA_FILL_CREDENTIAL") {
    sendResponse(fillCredential(message.credential || {}));
    return false;
  }
  if (message?.type === "MONICA_FILL_WALLET" && message.wallet) {
    sendResponse(fillWallet(message.wallet));
    return false;
  }
  if (message?.type === "MONICA_SHOW_SAVE_PROMPT" && message.context) {
    showPrompt(message.context);
    return false;
  }
  return false;
});

document.addEventListener("submit", (event) => {
  const candidate = captureCredentialInput(captureRootForEvent(event.target));
  if (candidate) void submitCandidate(candidate);
}, true);

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest('button,input[type="submit"],input[type="button"]') : null;
  if (!target || !isCredentialSubmissionControl(target)) return;
  const candidate = captureCredentialInput(captureRootForEvent(target));
  if (candidate) window.setTimeout(() => void submitCandidate(candidate), 0);
}, true);

if (window.top === window) void restorePendingPrompt();

async function submitCandidate(candidate: CredentialCaptureInput): Promise<void> {
  try {
    const context = await sendRuntime<SavePromptContext>({ type: "CREDENTIAL_CAPTURE", candidate });
    if (window.top === window) showPrompt(context);
  } catch (error) {
    // Locked vaults and unsupported pages fail closed without retaining the password in page state.
    console.warn("[Monica] Credential candidate rejected:", error instanceof Error ? error.message : "unknown error");
  }
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
    accept: (providerId) => sendRuntime<{ action: "saved" | "updated"; title: string; providerName: string; syncPending: boolean }>({ type: "CREDENTIAL_ACCEPT", candidateId: context.candidateId, providerId }),
    dismiss: () => sendRuntime({ type: "CREDENTIAL_DISMISS", candidateId: context.candidateId })
  });
}

async function sendRuntime<T>(request: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as ExtensionResponse<T>;
  if (!response?.ok) throw new Error(response?.error || "Monica 后台操作失败。");
  return response.data;
}

function isCredentialSubmissionControl(target: Element): boolean {
  const type = target.getAttribute("type")?.toLowerCase();
  if (target.tagName === "INPUT") return type === "submit";
  if (!type || type === "submit") return true;
  const label = `${target.textContent || ""} ${target.getAttribute("aria-label") || ""}`.toLowerCase();
  return /sign.?in|log.?in|登录|登入|继续|continue|submit|save|保存|更新/.test(label);
}
