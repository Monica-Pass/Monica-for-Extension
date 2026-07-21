import type { SavePromptContext } from "../runtime/messages";
import { PROMPT_BASE_STYLES } from "./prompt-styles";

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
  const cleanup = () => {
    rootDocument.removeEventListener("keydown", onKeyDown, true);
    host.remove();
  };
  const closePrompt = async () => {
    if (busy) return;
    busy = true;
    try { await handlers.dismiss(); } finally { cleanup(); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    void closePrompt();
  };
  rootDocument.addEventListener("keydown", onKeyDown, true);
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
      rootDocument.defaultView?.setTimeout(cleanup, 1400);
    }).catch((error: unknown) => {
      busy = false;
      accept.disabled = false;
      dismiss.disabled = false;
      status.classList.add("error");
      status.textContent = error instanceof Error ? error.message : "保存失败，请重试。";
    });
  });

  rootDocument.defaultView?.setTimeout(cleanup, Math.max(0, context.expiresAt - Date.now()) + 100);
  rootDocument.defaultView?.setTimeout(() => accept.focus(), 0);
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

const STYLES = `${PROMPT_BASE_STYLES}
  .header,.account { display:flex; align-items:center; }
  .header img { width:44px; height:44px; object-fit:contain; }
  .account { gap:12px; min-height:64px; border-radius:8px; padding:10px 12px; background:var(--monica-surface-container); }
  .account-icon { width:44px; height:44px; flex:0 0 44px; display:grid; place-items:center; border-radius:8px; color:var(--monica-on-primary-container); background:var(--monica-primary-container); font-weight:800; }
  .account-copy { min-width:0; display:grid; }
  .account-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .field { display:grid; gap:6px; }
  .field-label { color:var(--monica-muted); font-size:12px; }
  select { width:100%; min-height:48px; border:1px solid var(--monica-outline); border-radius:8px; padding:0 12px; color:var(--monica-text); background:var(--monica-surface); }
`;
