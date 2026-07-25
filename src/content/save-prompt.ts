import type { SavePromptContext } from "../runtime/messages";
import { PROMPT_BASE_STYLES, promptIcon } from "./prompt-styles";

export interface SavePromptHandlers {
  accept(providerId?: string, existingItemId?: string): Promise<{ action: "saved" | "updated"; title: string; providerName: string; syncPending: boolean }>;
  dismiss(): Promise<void>;
}

const HOST_ID = "monica-save-prompt-host";
const TEST_ROOTS = new WeakMap<HTMLElement, ShadowRoot>();

export interface SavePromptRenderOptions { allowUntrustedEvents?: boolean; }

export function savePromptRootForTest(host: HTMLElement): ShadowRoot | undefined {
  return TEST_ROOTS.get(host);
}

export function renderSavePrompt(context: SavePromptContext, handlers: SavePromptHandlers, rootDocument: Document = document, options: SavePromptRenderOptions = {}): HTMLElement {
  rootDocument.getElementById("monica-passkey-prompt-host")?.remove();
  rootDocument.getElementById(HOST_ID)?.remove();
  const ViewHTMLElement = rootDocument.defaultView?.HTMLElement;
  const previousFocus = ViewHTMLElement && rootDocument.activeElement instanceof ViewHTMLElement ? rootDocument.activeElement : null;
  const host = rootDocument.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  TEST_ROOTS.set(host, shadow);
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
  title.textContent = context.action === "update" ? "更新 Monica 中的密码？" : context.action === "choose" ? "选择如何保存密码" : "保存到 Monica？";
  const subtitle = element(rootDocument, "span", "subtitle");
  subtitle.textContent = context.action === "update"
    ? `更新“${context.existingTitle || context.title}”`
    : context.action === "choose" ? `${context.host} · 检测到 ${context.updateTargets.length} 个同名登录项` : context.host;
  heading.append(title, subtitle);
  const close = button(rootDocument, "", "icon-button");
  close.innerHTML = promptIcon("close");
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

  let providerSelect: HTMLSelectElement | undefined;
  let providerField: HTMLLabelElement | undefined;
  let strategySelect: HTMLSelectElement | undefined;
  let selectedExistingItemId = context.existingItemId;
  let savingNew = context.action === "save";
  if (context.action === "save" || context.action === "choose") {
    providerField = element(rootDocument, "label", "field");
    const label = element(rootDocument, "span", "field-label");
    label.textContent = "保存到";
    providerSelect = rootDocument.createElement("select");
    providerSelect.setAttribute("aria-label", "保存密码源");
    for (const provider of context.providers) {
      const option = rootDocument.createElement("option");
      option.value = provider.id;
      option.textContent = provider.name;
      option.selected = provider.id === context.defaultProviderId;
      providerSelect.append(option);
    }
    providerField.append(label, providerSelect);
  }
  if (context.action === "choose") {
    const strategyField = element(rootDocument, "label", "field");
    const strategyLabel = element(rootDocument, "span", "field-label");
    strategyLabel.textContent = "处理方式";
    strategySelect = rootDocument.createElement("select");
    strategySelect.setAttribute("aria-label", "选择更新目标或另存为新项");
    const placeholder = rootDocument.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "请选择处理方式";
    placeholder.disabled = true;
    placeholder.selected = true;
    strategySelect.append(placeholder);
    const saveNew = rootDocument.createElement("option");
    saveNew.value = "new";
    saveNew.textContent = "另存为新登录项";
    strategySelect.append(saveNew);
    for (const target of context.updateTargets) {
      const option = rootDocument.createElement("option");
      option.value = target.id;
      option.textContent = `更新“${target.title}” · ${target.providerName}`;
      strategySelect.append(option);
    }
    strategyField.append(strategyLabel, strategySelect);
    providerField!.hidden = true;
    providerSelect!.disabled = true;
    card.append(header, account, strategyField, providerField!);
  } else if (providerField) {
    card.append(header, account, providerField);
  } else {
    card.append(header, account);
  }

  const status = element(rootDocument, "p", "status");
  status.setAttribute("aria-live", "polite");
  const actions = element(rootDocument, "footer", "actions");
  const dismiss = button(rootDocument, "不保存", "secondary");
  const accept = button(rootDocument, context.action === "update" ? "更新密码" : context.action === "choose" ? "请选择" : "保存密码", "primary");
  if (context.action === "choose") accept.disabled = true;
  actions.append(dismiss, accept);
  card.append(status, actions);
  shadow.append(card);
  rootDocument.documentElement.append(host);

  const applyStrategy = () => {
    savingNew = strategySelect!.value === "new";
    selectedExistingItemId = savingNew ? undefined : strategySelect!.value || undefined;
    providerField!.hidden = !savingNew;
    providerSelect!.disabled = !savingNew;
    accept.disabled = !strategySelect!.value;
    accept.textContent = savingNew ? "保存为新登录项" : "更新所选密码";
  };
  const updateStrategy = (event: Event) => {
    if (!trustedEvent(event, options)) return;
    applyStrategy();
  };
  strategySelect?.addEventListener("input", updateStrategy);
  strategySelect?.addEventListener("change", updateStrategy);
  strategySelect?.addEventListener("keydown", (event) => {
    if (!trustedEvent(event, options) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const enabled = Array.from(strategySelect!.options).filter((option) => !option.disabled);
    if (!enabled.length) return;
    event.preventDefault();
    const current = enabled.findIndex((option) => option.value === strategySelect!.value);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? enabled.length - 1
        : event.key === "ArrowDown"
          ? (current + 1 + enabled.length) % enabled.length
          : (current <= 0 ? enabled.length - 1 : current - 1);
    strategySelect!.value = enabled[next].value;
    applyStrategy();
  });

  let busy = false;
  let removed = false;
  let observer: MutationObserver | undefined;
  const expiryTimer = rootDocument.defaultView?.setTimeout(() => void closePrompt(true), Math.max(0, context.expiresAt - Date.now()) + 100);
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (expiryTimer !== undefined) rootDocument.defaultView?.clearTimeout(expiryTimer);
    observer?.disconnect();
    rootDocument.removeEventListener("keydown", onKeyDown, true);
    host.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const closePrompt = async (force = false) => {
    if (removed || busy && !force) return;
    busy = true;
    try { await handlers.dismiss(); } finally { cleanup(); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!trustedEvent(event, options)) return;
    if (event.key !== "Escape") return;
    event.preventDefault();
    void closePrompt();
  };
  rootDocument.addEventListener("keydown", onKeyDown, true);
  close.addEventListener("click", (event) => { if (trustedEvent(event, options)) void closePrompt(); });
  dismiss.addEventListener("click", (event) => { if (trustedEvent(event, options)) void closePrompt(); });
  accept.addEventListener("click", (event) => {
    if (!trustedEvent(event, options)) return;
    if (busy) return;
    busy = true;
    card.setAttribute("aria-busy", "true");
    close.disabled = true;
    accept.disabled = true;
    dismiss.disabled = true;
    if (strategySelect) strategySelect.disabled = true;
    if (providerSelect) providerSelect.disabled = true;
    status.className = "status";
    status.removeAttribute("role");
    status.textContent = selectedExistingItemId ? "正在加密更新…" : "正在加密保存…";
    void handlers.accept(savingNew ? providerSelect?.value : undefined, selectedExistingItemId).then((result) => {
      status.classList.add("success");
      status.textContent = `${result.action === "updated" ? "已更新" : "已保存"}到 ${result.providerName}${result.syncPending ? "，等待同步" : ""}`;
      rootDocument.defaultView?.setTimeout(cleanup, 1400);
    }).catch((error: unknown) => {
      busy = false;
      card.removeAttribute("aria-busy");
      close.disabled = false;
      accept.disabled = context.action === "choose" && !strategySelect?.value;
      dismiss.disabled = false;
      if (strategySelect) strategySelect.disabled = false;
      if (providerSelect) providerSelect.disabled = !savingNew;
      status.classList.add("error");
      status.setAttribute("role", "alert");
      status.textContent = error instanceof Error ? error.message : "保存失败，请重试。";
      accept.focus();
    });
  });

  const MutationObserverCtor = rootDocument.defaultView?.MutationObserver;
  if (MutationObserverCtor) {
    observer = new MutationObserverCtor((records) => {
      if (!host.isConnected || records.some((record) => record.type === "attributes" && record.target === host)) void closePrompt(true);
    });
    observer.observe(rootDocument.documentElement, { childList: true, subtree: true });
    observer.observe(host, { attributes: true });
  }
  rootDocument.defaultView?.setTimeout(() => (strategySelect || accept).focus(), 0);
  return host;
}

function trustedEvent(event: Event, options: SavePromptRenderOptions): boolean {
  return options.allowUntrustedEvents === true || event.isTrusted;
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
  .field[hidden] { display:none; }
  .field-label { color:var(--monica-muted); font-size:0.75rem; }
  select { width:100%; min-height:48px; border:1px solid var(--monica-outline); border-radius:8px; padding:0 12px; color:var(--monica-text); background:var(--monica-surface); }
`;
