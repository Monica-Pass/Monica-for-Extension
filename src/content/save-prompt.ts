import type { SavePromptContext } from "../runtime/messages";

export interface SavePromptHandlers {
  accept(providerId?: string): Promise<{ action: "saved" | "updated"; title: string; providerName: string; syncPending: boolean }>;
  dismiss(): Promise<void>;
}

const HOST_ID = "monica-save-prompt-host";

export function renderSavePrompt(context: SavePromptContext, handlers: SavePromptHandlers, rootDocument: Document = document): HTMLElement {
  rootDocument.getElementById(HOST_ID)?.remove();
  const host = rootDocument.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = rootDocument.createElement("style");
  style.textContent = STYLES;
  shadow.append(style);

  const card = element(rootDocument, "section", "card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "false");
  card.setAttribute("aria-labelledby", "monica-save-title");
  const header = element(rootDocument, "header", "header");
  const logo = rootDocument.createElement("img");
  logo.src = chrome.runtime.getURL("icons/logo-256.png");
  logo.alt = "";
  const heading = element(rootDocument, "div", "heading");
  const title = element(rootDocument, "strong", "title");
  title.id = "monica-save-title";
  title.textContent = context.action === "update" ? "更新 Monica 中的密码？" : "保存到 Monica？";
  const subtitle = element(rootDocument, "span", "subtitle");
  subtitle.textContent = context.action === "update" ? `更新“${context.existingTitle || context.title}”` : context.host;
  heading.append(title, subtitle);
  const close = button(rootDocument, "×", "icon-button");
  close.setAttribute("aria-label", "不保存并关闭");
  header.append(logo, heading, close);

  const account = element(rootDocument, "div", "account");
  const accountIcon = element(rootDocument, "span", "account-icon");
  accountIcon.textContent = context.username ? context.username.slice(0, 1).toUpperCase() : "•";
  const accountCopy = element(rootDocument, "div", "account-copy");
  const accountName = element(rootDocument, "strong", "account-name");
  accountName.textContent = context.username || "无用户名";
  const password = element(rootDocument, "span", "password");
  password.textContent = "••••••••••••";
  accountCopy.append(accountName, password);
  account.append(accountIcon, accountCopy);

  let select: HTMLSelectElement | undefined;
  if (context.action === "save") {
    const field = element(rootDocument, "label", "field");
    const label = element(rootDocument, "span", "field-label");
    label.textContent = "保存到";
    select = rootDocument.createElement("select");
    select.setAttribute("aria-label", "保存密码源");
    for (const provider of context.providers) {
      const option = rootDocument.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      option.selected = provider.id === context.defaultProviderId;
      select.append(option);
    }
    field.append(label, select);
    card.append(header, account, field);
  } else {
    card.append(header, account);
  }

  const status = element(rootDocument, "p", "status");
  status.setAttribute("aria-live", "polite");
  const actions = element(rootDocument, "footer", "actions");
  const dismiss = button(rootDocument, "不保存", "secondary");
  const accept = button(rootDocument, context.action === "update" ? "更新密码" : "保存密码", "primary");
  actions.append(dismiss, accept);
  card.append(status, actions);
  shadow.append(card);
  rootDocument.documentElement.append(host);

  let busy = false;
  const closePrompt = async () => {
    if (busy) return;
    busy = true;
    try { await handlers.dismiss(); } finally { host.remove(); }
  };
  close.addEventListener("click", () => void closePrompt());
  dismiss.addEventListener("click", () => void closePrompt());
  accept.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    accept.disabled = true;
    dismiss.disabled = true;
    status.textContent = context.action === "update" ? "正在加密更新…" : "正在加密保存…";
    void handlers.accept(select?.value).then((result) => {
      status.classList.add("success");
      status.textContent = `${result.action === "updated" ? "已更新" : "已保存"}到 ${result.providerName}${result.syncPending ? "，等待同步" : ""}`;
      rootDocument.defaultView?.setTimeout(() => host.remove(), 1400);
    }).catch((error: unknown) => {
      busy = false;
      accept.disabled = false;
      dismiss.disabled = false;
      status.classList.add("error");
      status.textContent = error instanceof Error ? error.message : "保存失败，请重试。";
    });
  });

  rootDocument.defaultView?.setTimeout(() => host.remove(), Math.max(0, context.expiresAt - Date.now()) + 100);
  return host;
}

function element<K extends keyof HTMLElementTagNameMap>(rootDocument: Document, tag: K, className: string): HTMLElementTagNameMap[K] {
  const value = rootDocument.createElement(tag);
  value.className = className;
  return value;
}

function button(rootDocument: Document, text: string, className: string): HTMLButtonElement {
  const value = element(rootDocument, "button", className);
  value.type = "button";
  value.textContent = text;
  return value;
}

const STYLES = `
  :host { color-scheme: light dark; }
  * { box-sizing: border-box; }
  .card { pointer-events:auto; position:fixed; top:18px; right:18px; width:min(380px,calc(100vw - 36px)); display:grid; gap:16px; padding:18px; border:1px solid color-mix(in srgb,#6750a4 24%,transparent); border-radius:28px; color:#242126; background:#fff8ff; box-shadow:0 18px 54px rgba(31,24,40,.24); font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif; animation:monica-in .22s cubic-bezier(.2,.8,.2,1); }
  .header,.account,.actions { display:flex; align-items:center; }
  .header { gap:12px; }
  .header img { width:42px; height:42px; object-fit:contain; }
  .heading { min-width:0; flex:1; display:grid; gap:2px; }
  .title { font-size:16px; }
  .subtitle,.password,.field-label { color:#655d68; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  button,select { font:inherit; }
  button { min-height:42px; border:0; border-radius:21px; padding:0 16px; cursor:pointer; font-weight:700; }
  button:focus-visible,select:focus-visible { outline:3px solid #6750a4; outline-offset:2px; }
  button:disabled { cursor:wait; opacity:.6; }
  .icon-button { width:42px; padding:0; color:#655d68; background:transparent; font-size:24px; }
  .icon-button:hover,.secondary:hover { background:#f0e8f2; }
  .account { gap:12px; min-height:64px; border-radius:20px; padding:10px 12px; background:#f4ecf5; }
  .account-icon { width:42px; height:42px; flex:0 0 42px; display:grid; place-items:center; border-radius:15px; color:#21005d; background:#eaddff; font-weight:800; }
  .account-copy { min-width:0; display:grid; }
  .account-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .field { display:grid; gap:6px; }
  select { width:100%; min-height:48px; border:1px solid #cac4d0; border-radius:15px; padding:0 12px; color:#242126; background:#fff; }
  .status { min-height:20px; margin:0; color:#655d68; font-size:12px; text-align:center; }
  .status.success { color:#146c3a; }
  .status.error { color:#b3261e; }
  .actions { justify-content:flex-end; gap:10px; }
  .secondary { color:#6750a4; background:transparent; }
  .primary { color:#fff; background:#6750a4; }
  .primary:hover { background:#57408f; }
  @keyframes monica-in { from { opacity:0; transform:translateY(-8px) scale(.98); } }
  @media (prefers-color-scheme:dark) { .card { color:#e8e0e9; background:#211f22; border-color:#4f4654; } .subtitle,.password,.field-label,.status { color:#cac4d0; } .account { background:#2b292d; } select { color:#e8e0e9; background:#2b292d; border-color:#49454f; } .icon-button:hover,.secondary:hover { background:#343138; } }
  @media (prefers-reduced-motion:reduce) { .card { animation:none; } }
`;
