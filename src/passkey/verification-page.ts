import { getUiLocale, initializeUiLocale, tr, translateRuntimeError } from "../i18n/runtime";
import type { ExtensionResponse, PasskeyVerificationContext } from "../runtime/messages";
import "./verification-page.css";

const verificationId = new URL(location.href).searchParams.get("request") || "";
const form = document.querySelector("form")!;
const password = document.querySelector<HTMLInputElement>("#password")!;
const confirm = document.querySelector<HTMLButtonElement>("#confirm")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const status = document.querySelector<HTMLElement>("#status")!;
let busy = false;
let method: "master-password" | "windows-hello" = "master-password";

async function send<T>(request: unknown): Promise<T> {
  const response = await chrome.runtime.sendMessage(request) as ExtensionResponse<T>;
  if (!response?.ok) throw new Error(translateRuntimeError(response?.error || "Passkey 操作失败，请重试。"));
  return response.data;
}

async function dismiss(): Promise<void> {
  password.value = "";
  try { await send({ type: "PASSKEY_CANCEL_VERIFICATION", verificationId }); }
  finally { window.close(); }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  busy = true;
  confirm.disabled = true;
  form.setAttribute("aria-busy", "true");
  status.textContent = tr("正在验证身份，请稍候。");
  const request = { type: method === "windows-hello" ? "PASSKEY_VERIFY_HELLO" : "PASSKEY_VERIFY_PASSWORD", verificationId, masterPassword: password.value };
  password.value = "";
  void send(request).then(() => window.close()).catch(error => {
    status.textContent = error instanceof Error ? error.message : tr("Passkey 操作失败，请重试。");
    status.setAttribute("role", "alert");
    password.focus();
  }).finally(() => {
    request.masterPassword = "";
    busy = false;
    confirm.disabled = false;
    form.removeAttribute("aria-busy");
  });
});
cancel.addEventListener("click", () => void dismiss());
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); void dismiss(); }
});
window.addEventListener("pagehide", () => { password.value = ""; });

void (async () => {
  await initializeUiLocale();
  document.documentElement.lang = getUiLocale();
  for (const element of document.querySelectorAll<HTMLElement>("[data-message]")) element.textContent = tr(element.dataset.message!);
  try {
    const context = await send<PasskeyVerificationContext>({ type: "PASSKEY_VERIFICATION_CONTEXT", verificationId });
    document.querySelector("#site")!.textContent = context.rpId;
    document.querySelector("#account")!.textContent = context.accountName;
    method = context.method || "master-password";
    if (context.unlockRequired) {
      document.querySelector("h1")!.textContent = tr('解锁 Monica 以继续');
      document.querySelector(".hint")!.textContent = tr('解锁后选择 Passkey 账户或保存位置');
      confirm.textContent = tr('解锁并继续');
    }
    if (method === "windows-hello") {
      password.disabled = true;
      password.hidden = true;
      document.querySelector<HTMLElement>('label[for="password"]')!.hidden = true;
      document.querySelector(".hint")!.textContent = tr('确认后将通过 Windows Hello 验证身份，再完成本次 Passkey 操作。');
      confirm.focus();
    } else password.focus();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : tr("Passkey 操作失败，请重试。");
    password.disabled = confirm.disabled = true;
    cancel.focus();
  }
})();
