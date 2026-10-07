import { INLINE_AUTOFILL_ENABLED_KEY, inlineAutofillEnabled, readInlineAutofillEnabled } from "../autofill/inline-preferences";
import type { InlineAutofillResult } from "../autofill/inline-contract";
import { formatAutofillCredential } from "../autofill/credential-identity";
import { getUiLocale, initializeUiLocale, tr } from "../i18n/runtime";
import { createPromptI18n } from "./prompt-i18n";
import { fillCredential, type FillCredentialInput } from "./dom";
import { createCurrentFieldContext } from "./field-signature";
import { loginFieldRole, loginFieldScope } from "./login-field-role";
import { inlineMenuPosition } from "./inline-position";
import { INLINE_AUTOFILL_STYLES } from "./inline-styles";
import { createMonicaLogo } from "./brand-logo";

export const INLINE_AUTOFILL_HOST_ID = "monica-inline-autofill-host";

interface Handlers {
  query(sessionId: string): Promise<InlineAutofillResult>;
  fill(sessionId: string, itemId: string): Promise<unknown>;
  openManager(sessionId: string): Promise<unknown>;
}

interface FieldSession {
  id: string;
  input: HTMLInputElement;
  scope: ParentNode;
  role: "username" | "current-password" | "totp";
  url: string;
  signature?: string;
  busy: boolean;
  consumed: boolean;
  focusRequested?: boolean;
}

/** One menu and one live field per document; no credentials are cached in its DOM. */
export function installInlineAutofill(handlers: Handlers, rootDocument: Document = document) {
  const view = rootDocument.defaultView!;
  let enabled = false;
  let disposed = false;
  let session: FieldSession | undefined;
  let host: HTMLElement | undefined;
  let shadow: ShadowRoot | undefined;
  let panel: HTMLElement | undefined;
  let restoringFocus = false;
  let applying = false;
  let animationFrame = 0;
  let preferenceRevision = 0;
  const openCleanups: Array<() => void> = [];

  function activeInput() {
    let active = rootDocument.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active instanceof view.HTMLInputElement ? active : undefined;
  }

  function visible(input: HTMLInputElement) {
    const rect = input.getBoundingClientRect();
    return input.isConnected && !input.disabled && !input.readOnly && input.type !== "hidden"
      && !input.closest("[inert]") && rect.width > 0 && rect.height > 0
      && input.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }

  function valid(current: FieldSession, requireInputFocus = false) {
    return !disposed && enabled && session === current && !current.consumed
      && rootDocument.visibilityState !== "hidden" && current.url === view.location.href
      && visible(current.input) && loginFieldRole(current.input, rootDocument) === current.role
      && loginFieldScope(current.input, rootDocument) === current.scope
      && (activeInput() === current.input || !requireInputFocus && rootDocument.activeElement === host);
  }

  function focusInput(current: FieldSession) {
    restoringFocus = true;
    try { current.input.focus({ preventScroll: true }); }
    finally { restoringFocus = false; }
  }

  function dismiss(restoreFocus = false) {
    const previous = session;
    session = undefined;
    if (animationFrame) view.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    for (const cleanup of openCleanups.splice(0)) cleanup();
    host?.remove();
    host = undefined;
    shadow = undefined;
    panel = undefined;
    if (restoreFocus && previous && visible(previous.input)) focusInput(previous);
  }

  function updatePosition() {
    animationFrame = 0;
    const current = session;
    if (!current || !host || !panel) return;
    if (!host.isConnected || !valid(current)) return dismiss();
    const viewport = view.visualViewport;
    const position = inlineMenuPosition(current.input.getBoundingClientRect(), {
      left: viewport?.offsetLeft || 0, top: viewport?.offsetTop || 0,
      width: viewport?.width || view.innerWidth, height: viewport?.height || view.innerHeight
    }, panel.scrollHeight ? panel.scrollHeight + panel.offsetHeight - panel.clientHeight : 240);
    if (!position) return dismiss();
    for (const [property, value] of Object.entries({ left: position.left, top: position.top, width: position.width, "max-height": position.maxHeight })) {
      const pixels = `${value}px`;
      if (host.style.getPropertyValue(property) !== pixels) host.style.setProperty(property, pixels, "important");
    }
    panel.style.maxHeight = `${position.maxHeight}px`;
    host.dataset.placement = position.placement;
  }

  function schedulePosition() {
    if (host && !animationFrame) animationFrame = view.requestAnimationFrame(updatePosition);
  }

  function watchPosition(current: FieldSession) {
    const resize = new view.ResizeObserver(schedulePosition);
    resize.observe(current.input);
    resize.observe(panel!);
    openCleanups.push(() => resize.disconnect());
    const mutation = new view.MutationObserver(records => {
      if (records.some(record => record.target !== host)) schedulePosition();
    });
    mutation.observe(rootDocument, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "hidden", "style", "class", "disabled", "readonly", "autocomplete"] });
    let root: Node = current.input.getRootNode();
    while (root instanceof view.ShadowRoot) {
      const observedRoot = root;
      observedRoot.addEventListener("scroll", schedulePosition, true);
      mutation.observe(observedRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "hidden", "style", "class", "disabled", "readonly", "autocomplete"] });
      openCleanups.push(() => observedRoot.removeEventListener("scroll", schedulePosition, true));
      root = observedRoot.host.getRootNode();
    }
    openCleanups.push(() => mutation.disconnect());
    updatePosition();
  }

  function render(current: FieldSession, result: InlineAutofillResult) {
    const i18n = createPromptI18n();
    openCleanups.push(() => i18n.dispose());
    host = rootDocument.createElement("div");
    host.id = INLINE_AUTOFILL_HOST_ID;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:auto!important;margin:0!important;padding:0!important;border:0!important;z-index:2147483647!important;display:block!important;box-sizing:border-box!important;pointer-events:none!important;overflow:visible!important;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = rootDocument.createElement("style");
    style.textContent = INLINE_AUTOFILL_STYLES;
    panel = rootDocument.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    i18n.attribute(panel, "aria-label", () => tr("表单旁自动填充"));
    i18n.attribute(panel, "lang", getUiLocale);
    const header = rootDocument.createElement("header");
    const logo = createMonicaLogo(rootDocument, 24);
    const heading = rootDocument.createElement("strong");
    heading.textContent = "Monica";
    const label = rootDocument.createElement("span");
    label.className = "label";
    i18n.text(label, () => tr("自动填充"));
    const close = button("close");
    close.textContent = "×";
    i18n.attribute(close, "aria-label", () => tr("关闭自动填充菜单"));
    close.addEventListener("click", event => { if (event.isTrusted) dismiss(true); });
    header.append(logo, heading, label, close);
    panel.append(header);
    const list = rootDocument.createElement("div");
    list.className = "suggestions";
    list.setAttribute("role", "group");
    i18n.attribute(list, "aria-label", () => tr("此网站的登录项"));
    for (const item of result.candidates) {
      const row = button("suggestion");
      row.dataset.suggestion = "";
      const text = rootDocument.createElement("span");
      text.className = "account";
      const title = rootDocument.createElement("strong");
      title.textContent = item.title;
      const username = rootDocument.createElement("small");
      i18n.text(username, () => item.username || tr("无用户名"));
      text.append(title, username);
      if (item.credentialIdentity) {
        const identity = rootDocument.createElement('small');
        identity.className = 'credential-identity';
        i18n.text(identity, () => formatAutofillCredential(item.credentialIdentity, tr));
        text.append(identity);
      }
      const hint = rootDocument.createElement("span");
      hint.className = "hint";
      i18n.text(hint, () => result.status === "locked" && item.allowLockedAutofill ? tr("免解锁填写") : item.hasTotp ? tr("含验证码") : "↵");
      row.append(text, hint);
      row.addEventListener("click", event => { if (event.isTrusted) void act(current, () => handlers.fill(current.id, item.id)); });
      list.append(row);
    }
    panel.append(list);
    if (!result.candidates.length) {
      const empty = rootDocument.createElement("p");
      empty.className = "empty";
      i18n.text(empty, () => result.status === "unlocked" ? tr("此网站暂无匹配的登录项。") : tr("解锁后查看此网站的登录项。"));
      panel.append(empty);
    }
    if (result.total > result.candidates.length) {
      const count = rootDocument.createElement("p");
      count.className = "count";
      i18n.text(count, () => tr("显示前 {0} 项，共 {1} 项", { 0: result.candidates.length, 1: result.total }));
      panel.append(count);
    }
    const status = rootDocument.createElement("p");
    status.className = "status";
    status.setAttribute("role", "status");
    status.hidden = true;
    panel.append(status);
    const open = button("open-manager");
    i18n.text(open, () => result.status === "locked" ? tr("解锁 Monica") : tr("打开 Monica"));
    open.addEventListener("click", event => { if (event.isTrusted) void act(current, () => handlers.openManager(current.id)); });
    panel.append(open);
    // Keep the field focused during a pointer selection; keyboard navigation remains native.
    panel.addEventListener("pointerdown", event => { if (event.isTrusted && event.button === 0) event.preventDefault(); });
    shadow.append(style, panel);
    rootDocument.documentElement.append(host);
    if (typeof host.showPopover === "function") {
      host.setAttribute("popover", "manual");
      try { host.showPopover(); } catch { /* Older engines retain the fixed-position fallback. */ }
    }
    watchPosition(current);
    if (current.focusRequested) shadow?.querySelector<HTMLButtonElement>(".suggestion,.open-manager")?.focus();
  }

  function button(className: string) {
    const element = rootDocument.createElement("button");
    element.type = "button";
    element.className = className;
    return element;
  }

  async function act(current: FieldSession, action: () => Promise<unknown>) {
    if (!valid(current) || current.busy) return;
    current.busy = true;
    focusInput(current);
    const controls = [...shadow!.querySelectorAll("button")];
    controls.forEach(control => { control.disabled = true; });
    try {
      await action();
      if (session === current) dismiss();
    } catch {
      if (session !== current) return;
      current.busy = false;
      controls.forEach(control => { control.disabled = false; });
      const status = shadow?.querySelector<HTMLElement>(".status");
      if (status) { status.hidden = false; status.textContent = tr("填写失败，请重新选择输入框后重试。"); }
      schedulePosition();
    }
  }

  async function show(input: HTMLInputElement) {
    if (disposed || !enabled || !visible(input) || activeInput() !== input) return;
    const role = loginFieldRole(input, rootDocument);
    if (role !== "username" && role !== "current-password" && role !== "totp") return;
    if (session?.input === input) return;
    dismiss();
    const current: FieldSession = { id: crypto.randomUUID(), input, scope: loginFieldScope(input, rootDocument), role, url: view.location.href, busy: false, consumed: false };
    session = current;
    try {
      await initializeUiLocale();
      if (!valid(current, true)) { if (session === current) dismiss(); return; }
      const result = await handlers.query(current.id);
      if (!valid(current, true)) { if (session === current) dismiss(); return; }
      if (!result.enabled || result.sessionId !== current.id) return dismiss();
      render(current, result);
    } catch { if (session === current) dismiss(); }
  }

  function eventInput(event: Event) {
    const target = event.composedPath()[0];
    return target instanceof view.HTMLInputElement ? target : undefined;
  }
  function inside(event: Event) { return Boolean(host && event.composedPath().includes(host)); }
  function focus(event: FocusEvent) {
    if (restoringFocus || applying || inside(event)) return;
    const input = eventInput(event);
    if (input) void show(input);
    if (!input || session?.input !== input) dismiss();
  }
  function pointer(event: PointerEvent) {
    if (!event.isTrusted || inside(event)) return;
    const input = eventInput(event);
    if (input === session?.input) return;
    dismiss();
  }
  function click(event: MouseEvent) {
    if (!event.isTrusted || inside(event)) return;
    const input = eventInput(event);
    if (input) void show(input);
  }
  function input(event: Event) {
    if (!applying && eventInput(event) === session?.input) dismiss();
  }
  function key(event: KeyboardEvent) {
    if (!event.isTrusted || !enabled) return;
    const fromMenu = inside(event);
    if (event.key === "Escape" && session) { event.preventDefault(); event.stopPropagation(); dismiss(fromMenu); return; }
    if (!fromMenu && (event.key === "Tab" || event.key === "Enter")) return dismiss();
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = eventInput(event);
    if (!fromMenu && (!target || !["username", "current-password", "totp"].includes(loginFieldRole(target, rootDocument)))) return;
    event.preventDefault();
    if (!session && target) { void show(target).then(() => { if (session?.input === target) shadow?.querySelector<HTMLButtonElement>(".suggestion,.open-manager")?.focus(); }); return; }
    if (session && !shadow) { session.focusRequested = true; return; }
    const buttons = [...shadow?.querySelectorAll<HTMLButtonElement>(".suggestion,.open-manager") || []];
    const index = buttons.findIndex(button => button === shadow?.activeElement);
    const next = index < 0 ? event.key === "ArrowDown" ? 0 : buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  }
  function hide() { dismiss(Boolean(host && rootDocument.activeElement === host)); }
  function visibility() { if (rootDocument.visibilityState === "hidden") dismiss(); }
  function preferenceChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area !== "local" || !changes[INLINE_AUTOFILL_ENABLED_KEY]) return;
    preferenceRevision++;
    enabled = inlineAutofillEnabled(changes[INLINE_AUTOFILL_ENABLED_KEY].newValue);
    if (!enabled) dismiss();
  }
  chrome.storage.onChanged.addListener(preferenceChanged);
  const revision = preferenceRevision;
  void readInlineAutofillEnabled().then(value => {
    if (disposed || revision !== preferenceRevision) return;
    enabled = value;
    const input = activeInput();
    if (enabled && input && rootDocument.hasFocus()) void show(input);
  }).catch(() => undefined);
  rootDocument.addEventListener("focusin", focus, true);
  rootDocument.addEventListener("pointerdown", pointer, true);
  rootDocument.addEventListener("click", click, true);
  rootDocument.addEventListener("input", input, true);
  rootDocument.addEventListener("keydown", key, true);
  rootDocument.addEventListener("scroll", schedulePosition, true);
  rootDocument.addEventListener("visibilitychange", visibility);
  view.addEventListener("resize", schedulePosition);
  view.addEventListener("blur", hide);
  view.addEventListener("pagehide", hide);
  view.visualViewport?.addEventListener("resize", schedulePosition);
  view.visualViewport?.addEventListener("scroll", schedulePosition);

  return {
    async fieldContext(sessionId: string) {
      const current = session;
      if (!current || current.id !== sessionId || !valid(current, true)) return undefined;
      const context = await createCurrentFieldContext(rootDocument, view.location);
      if (!valid(current, true) || !context || current.signature && current.signature !== context.signature) return undefined;
      current.signature = context.signature;
      return context;
    },
    applyCredential(sessionId: string, credential: FillCredentialInput) {
      const current = session;
      if (!current || current.id !== sessionId || !current.busy || !valid(current, true)) return { ok: false, error: "自动填充菜单已失效，请重新选择输入框。" };
      current.consumed = true;
      applying = true;
      try { return fillCredential(current.role === "totp" ? { totpCode: credential.totpCode } : credential, rootDocument); }
      finally { applying = false; dismiss(); }
    },
    dismiss: hide,
    dispose() {
      if (disposed) return;
      disposed = true;
      dismiss();
      chrome.storage.onChanged.removeListener(preferenceChanged);
      rootDocument.removeEventListener("focusin", focus, true);
      rootDocument.removeEventListener("pointerdown", pointer, true);
      rootDocument.removeEventListener("click", click, true);
      rootDocument.removeEventListener("input", input, true);
      rootDocument.removeEventListener("keydown", key, true);
      rootDocument.removeEventListener("scroll", schedulePosition, true);
      rootDocument.removeEventListener("visibilitychange", visibility);
      view.removeEventListener("resize", schedulePosition);
      view.removeEventListener("blur", hide);
      view.removeEventListener("pagehide", hide);
      view.visualViewport?.removeEventListener("resize", schedulePosition);
      view.visualViewport?.removeEventListener("scroll", schedulePosition);
    }
  };
}
