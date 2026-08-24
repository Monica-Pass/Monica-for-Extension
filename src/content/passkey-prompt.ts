import type { PasskeyPromptContext } from "../runtime/messages";
import { PROMPT_BASE_STYLES, promptIcon } from "./prompt-styles";

const HOST_ID = "monica-passkey-prompt-host";
const TEST_ROOTS = new WeakMap<HTMLElement, ShadowRoot>();
const CLOSE_HANDLERS = new WeakMap<HTMLElement, () => void>();

export interface PasskeyPromptRenderOptions {
  allowUntrustedEvents?: boolean;
}

export function passkeyPromptRootForTest(host: HTMLElement): ShadowRoot | undefined {
  return TEST_ROOTS.get(host);
}

export function closePasskeyPrompt(rootDocument: Document = document): void {
  const host = rootDocument.getElementById(HOST_ID);
  if (host) CLOSE_HANDLERS.get(host)?.();
}

export function renderPasskeyPrompt(
  context: PasskeyPromptContext,
  accept: (itemId?: string, providerId?: string) => Promise<void>,
  dismiss: () => Promise<void>,
  rootDocument: Document = document,
  options: PasskeyPromptRenderOptions = {}
): HTMLElement {
  rootDocument.getElementById("monica-save-prompt-host")?.remove();
  rootDocument.getElementById(HOST_ID)?.remove();
  const ViewHTMLElement = rootDocument.defaultView?.HTMLElement;
  const previousFocus = ViewHTMLElement && rootDocument.activeElement instanceof ViewHTMLElement ? rootDocument.activeElement : null;
  const host = rootDocument.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;pointer-events:auto!important;background:rgba(0,0,0,.42)!important";
  const shadow = host.attachShadow({ mode: "closed" });
  TEST_ROOTS.set(host, shadow);
  shadow.innerHTML = `<style>${PROMPT_BASE_STYLES}
    .site-identity { display:grid; gap:2px; min-height:64px; padding:10px 12px; border-radius:8px; background:var(--monica-surface-container); }
    .security-label { color:var(--monica-muted); font-size:0.6875rem; font-weight:700; letter-spacing:.02em; }
    .rp-id { overflow-wrap:anywhere; font-size:0.9375rem; }
    .rp-name { color:var(--monica-muted); font-size:0.75rem; overflow-wrap:anywhere; }
    .choices { display:grid; gap:8px; }
    .choice { width:100%; min-height:64px; display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--monica-outline); color:var(--monica-text); background:var(--monica-surface); text-align:left; }
    .choice[aria-checked="true"] { border-color:var(--monica-primary); background:var(--monica-surface-container); box-shadow:inset 3px 0 0 var(--monica-primary); }
    .choice-copy { min-width:0; flex:1; display:grid; gap:2px; }
    .choice-copy strong,.choice-copy span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .source { flex:0 0 auto; padding:3px 7px; border-radius:8px; color:var(--monica-primary); background:var(--monica-surface-high); font-size:0.6875rem; }
    .choice.conflict { border-color:var(--monica-error); }
    .choice.conflict .supporting { color:var(--monica-error); }
    .source { max-width:42%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .field { display:grid; gap:6px; }
    .field-label { color:var(--monica-muted); font-size:0.75rem; }
    select { width:100%; min-height:48px; border:1px solid var(--monica-outline); border-radius:8px; padding:0 12px; color:var(--monica-text); background:var(--monica-surface); }
  </style>`;

  const card = rootDocument.createElement("section");
  card.className = "card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", "monica-passkey-title");
  card.setAttribute("aria-describedby", "monica-passkey-description");
  const titleText = context.operation === "create" ? "创建 Monica Passkey？" : "使用 Monica Passkey 登录？";
  card.innerHTML = `<header class="header"><span class="brand-icon">${promptIcon("key")}</span><div class="heading"><strong id="monica-passkey-title" class="title">${titleText}</strong><span class="subtitle"></span></div><button class="icon-button" type="button" aria-label="取消 Passkey 操作">${promptIcon("close")}</button></header>`;
  (card.querySelector(".subtitle") as HTMLElement).textContent = context.operation === "create" ? "确认网站与保存位置" : "确认网站并选择账户";

  const siteIdentity = rootDocument.createElement("div");
  siteIdentity.className = "site-identity";
  siteIdentity.innerHTML = `<span class="security-label">已验证 Passkey 范围</span><strong class="rp-id"></strong><span class="rp-name"></span>`;
  (siteIdentity.querySelector(".rp-id") as HTMLElement).textContent = context.rpId;
  const pageHost = safeHost(context.origin);
  (siteIdentity.querySelector(".rp-name") as HTMLElement).textContent = [context.rpName && context.rpName !== context.rpId ? context.rpName : "", pageHost && pageHost !== context.rpId ? `当前页面：${pageHost}` : ""].filter(Boolean).join(" · ");
  card.append(siteIdentity);

  let selectedProviderId = context.defaultSaveTargetId;
  let targetSelect: HTMLSelectElement | undefined;
  if (context.operation === "create") {
    const summary = rootDocument.createElement("div");
    summary.className = "summary";
    summary.innerHTML = `<div class="summary-copy"><strong></strong><span class="muted supporting"></span></div>`;
    (summary.querySelector("strong") as HTMLElement).textContent = context.userDisplayName || context.userName || "网站未提供用户名";
    const selectedTargetName = context.saveTargets.find((target) => target.providerId === context.defaultSaveTargetId)?.name;
    (summary.querySelector(".supporting") as HTMLElement).textContent = [context.userDisplayName && context.userName ? context.userName : "Passkey 账户", context.saveTargets.length === 1 && selectedTargetName ? `保存到 ${selectedTargetName}` : ""].filter(Boolean).join(" · ");
    card.append(summary);

    if (context.saveTargets.length > 1) {
      const field = rootDocument.createElement("label");
      field.className = "field";
      field.innerHTML = `<span class="field-label">保存到</span>`;
      const select = rootDocument.createElement("select");
      targetSelect = select;
      select.setAttribute("aria-label", "Passkey 保存位置");
      for (const target of context.saveTargets) {
        const option = rootDocument.createElement("option");
        option.value = target.providerId;
        option.textContent = target.name;
        option.selected = target.providerId === context.defaultSaveTargetId;
        select.append(option);
      }
      selectedProviderId = select.value;
      select.addEventListener("change", (event) => {
        if (!trustedEvent(event, options)) return;
        selectedProviderId = select.value;
      });
      field.append(select);
      card.append(field);
    }
  }

  const requiresExplicitSelection = context.credentials.some((credential) => credential.credentialConflict);
  let selected = requiresExplicitSelection ? undefined : context.credentials[0]?.itemId;
  if (context.operation === "get") {
    const choices = rootDocument.createElement("div");
    choices.className = "choices";
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-label", "选择 Passkey");
    context.credentials.forEach((credential, index) => {
      const choice = rootDocument.createElement("button");
      choice.type = "button";
      choice.className = "choice";
      if (credential.credentialConflict) choice.classList.add("conflict");
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-checked", String(!requiresExplicitSelection && index === 0));
      choice.tabIndex = index === 0 ? 0 : -1;
      choice.innerHTML = `<span class="choice-copy"><strong></strong><span class="supporting"></span></span><span class="source"></span>`;
      (choice.querySelector("strong") as HTMLElement).textContent = credential.title;
      (choice.querySelector(".supporting") as HTMLElement).textContent = [credential.userDisplayName || credential.userName || "无用户名", credential.useCount ? `已使用 ${credential.useCount} 次` : "未使用", credential.userVerificationRequired ? "Windows Hello" : "", credential.credentialConflict ? "凭据 ID 重复，请确认密码源" : ""].filter(Boolean).join(" · ");
      const source = choice.querySelector(".source") as HTMLElement;
      source.textContent = credential.providerName;
      source.title = credential.providerName;
      const selectChoice = () => {
        selected = credential.itemId;
        for (const item of Array.from(choices.querySelectorAll<HTMLButtonElement>('[role="radio"]'))) {
          item.setAttribute("aria-checked", String(item === choice));
          item.tabIndex = item === choice ? 0 : -1;
        }
      };
      choice.onclick = (event) => { if (trustedEvent(event, options)) selectChoice(); };
      choice.onkeydown = (event) => {
        if (!trustedEvent(event, options)) return;
        if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(choices.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
        const current = items.indexOf(choice);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : current + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1);
        const nextChoice = items[(next + items.length) % items.length];
        if (nextChoice) {
          selected = context.credentials[items.indexOf(nextChoice)]?.itemId;
          for (const item of items) {
            item.setAttribute("aria-checked", String(item === nextChoice));
            item.tabIndex = item === nextChoice ? 0 : -1;
          }
          nextChoice.focus();
        }
      };
      choices.append(choice);
    });
    card.append(choices);
  }

  const notice = rootDocument.createElement("p");
  notice.id = "monica-passkey-description";
  notice.className = "notice";
  notice.innerHTML = `${promptIcon("info")}<span></span>`;
  (notice.querySelector("span") as HTMLElement).textContent = requiresExplicitSelection
    ? "凭据 ID 重复，请确认密码源。只有明确选择后才会使用对应私钥。"
    : context.userVerificationRequired
    ? "确认后将通过 Windows Hello 验证身份，再完成本次 Passkey 操作。"
    : context.operation === "create"
      ? "私钥会加密保存；Monica 不会把私钥发送给当前网站。"
      : "只有确认后才会使用所选私钥完成本次签名。";
  const status = rootDocument.createElement("p"); status.className = "status"; status.setAttribute("aria-live", "polite");
  const actions = rootDocument.createElement("footer"); actions.className = "actions";
  const cancel = rootDocument.createElement("button"); cancel.type = "button"; cancel.className = "secondary"; cancel.textContent = "取消";
  const confirm = rootDocument.createElement("button"); confirm.type = "button"; confirm.className = "primary"; confirm.textContent = context.operation === "create" ? "创建 Passkey" : "继续登录";
  actions.append(cancel, confirm); card.append(notice, status, actions); shadow.append(card); rootDocument.documentElement.append(host);

  let busy = false;
  let removed = false;
  let observer: MutationObserver | undefined;
  const expiryTimer = rootDocument.defaultView?.setTimeout(() => void cancelPrompt(), Math.max(0, context.expiresAt - Date.now()) + 100);
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (expiryTimer !== undefined) rootDocument.defaultView?.clearTimeout(expiryTimer);
    observer?.disconnect();
    rootDocument.removeEventListener("keydown", onKeyDown, true);
    CLOSE_HANDLERS.delete(host);
    host.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const cancelPrompt = async (force = false) => { if (removed || busy && !force) return; busy = true; try { await dismiss(); } catch { /* Cancellation is already reported to the page. */ } finally { cleanup(); } };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!trustedEvent(event, options)) return;
    if (event.key === "Escape") { event.preventDefault(); void cancelPrompt(); return; }
    if (event.key !== "Tab") return;
    const focusable = Array.from(shadow.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex]')).filter((item) => item.tabIndex >= 0);
    if (!focusable.length) return;
    const current = focusable.indexOf(shadow.activeElement as HTMLElement);
    const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
    event.preventDefault();
    focusable[next].focus();
  };
  CLOSE_HANDLERS.set(host, () => void cancelPrompt(true));
  rootDocument.addEventListener("keydown", onKeyDown, true);
  cancel.onclick = (event) => { if (trustedEvent(event, options)) void cancelPrompt(); };
  (card.querySelector(".icon-button") as HTMLButtonElement).onclick = (event) => { if (trustedEvent(event, options)) void cancelPrompt(); };
  confirm.onclick = (event) => {
    if (!trustedEvent(event, options)) return;
    if (busy) return;
    busy = true;
    card.setAttribute("aria-busy", "true");
    const busyControls = Array.from(shadow.querySelectorAll<HTMLButtonElement>("button"));
    for (const control of busyControls) control.disabled = true;
    if (targetSelect) targetSelect.disabled = true;
    status.className = "status";
    status.removeAttribute("role");
    status.textContent = context.userVerificationRequired ? "正在等待 Windows Hello…" : context.operation === "create" ? "正在创建并加密保存…" : "正在完成安全签名…";
    void accept(selected, selectedProviderId).then(cleanup).catch((error) => {
      busy = false;
      card.removeAttribute("aria-busy");
      for (const control of busyControls) control.disabled = false;
      if (targetSelect) targetSelect.disabled = false;
      status.className = "status error";
      status.setAttribute("role", "alert");
      status.textContent = error instanceof Error ? error.message : "Passkey 操作失败，请重试。";
      confirm.focus();
    });
  };
  const MutationObserverCtor = rootDocument.defaultView?.MutationObserver;
  if (MutationObserverCtor) {
    observer = new MutationObserverCtor((records) => {
      if (!host.isConnected || records.some((record) => record.type === "attributes" && record.target === host)) void cancelPrompt(true);
    });
    observer.observe(rootDocument.documentElement, { childList: true, subtree: true });
    observer.observe(host, { attributes: true });
  }
  rootDocument.defaultView?.setTimeout(() => (context.operation === "get" ? shadow.querySelector<HTMLButtonElement>(".choice") : confirm)?.focus(), 0);
  return host;
}

function trustedEvent(event: Event, options: PasskeyPromptRenderOptions): boolean {
  return options.allowUntrustedEvents === true || event.isTrusted;
}

function safeHost(origin: string): string {
  try { return new URL(origin).host; } catch { return ""; }
}
