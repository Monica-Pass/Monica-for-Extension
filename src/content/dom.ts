export interface PageScan {
  ok: true;
  url: string;
  origin: string;
  host: string;
  title: string;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
  hasTotpField: boolean;
}

export interface FillCredentialInput {
  username?: string;
  password?: string;
  totpCode?: string;
}

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[type="text"]'
];

const TOTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="totp" i]',
  'input[id*="totp" i]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name="code" i]',
  'input[id="code" i]'
];

export function findLoginFields(rootDocument: Document = document): { username?: HTMLInputElement; password?: HTMLInputElement; totp?: HTMLInputElement } {
  const password = firstVisible('input[type="password"]', rootDocument);
  const totp = firstVisibleFrom(TOTP_SELECTORS, rootDocument);
  const root: ParentNode = password?.form || totp?.form || rootDocument;
  let username: HTMLInputElement | undefined;
  for (const selector of USERNAME_SELECTORS) {
    username = firstVisible(selector, root);
    if (username && username !== password && username !== totp) break;
    username = undefined;
  }
  return { username, password, totp };
}

export function scanPage(rootDocument: Document = document, pageLocation: Location = location): PageScan {
  const fields = findLoginFields(rootDocument);
  return {
    ok: true,
    url: pageLocation.href,
    origin: pageLocation.origin,
    host: pageLocation.hostname,
    title: rootDocument.title,
    hasUsernameField: Boolean(fields.username),
    hasPasswordField: Boolean(fields.password),
    hasTotpField: Boolean(fields.totp)
  };
}

export function fillCredential(credential: FillCredentialInput, rootDocument: Document = document): { ok: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean; filledTotp?: boolean } {
  const fields = findLoginFields(rootDocument);
  const filledUsername = Boolean(fields.username && credential.username);
  const filledPassword = Boolean(fields.password && credential.password);
  const filledTotp = Boolean(fields.totp && credential.totpCode);
  if (fields.username && credential.username) setNativeValue(fields.username, credential.username);
  if (fields.password && credential.password) setNativeValue(fields.password, credential.password);
  if (fields.totp && credential.totpCode) setNativeValue(fields.totp, credential.totpCode);
  const focusTarget = filledTotp ? fields.totp : filledPassword ? fields.password : filledUsername ? fields.username : undefined;
  if (!focusTarget) return { ok: false, error: "当前页面没有与此登录项对应的可填写字段。" };
  focusTarget.focus();
  return { ok: true, filledUsername, filledPassword, filledTotp };
}

function firstVisible(selector: string, root: ParentNode): HTMLInputElement | undefined {
  return Array.from(root.querySelectorAll<HTMLInputElement>(selector)).find(visibleInput);
}

function firstVisibleFrom(selectors: string[], root: ParentNode): HTMLInputElement | undefined {
  for (const selector of selectors) {
    const input = firstVisible(selector, root);
    if (input) return input;
  }
  return undefined;
}

function visibleInput(input: HTMLInputElement): boolean {
  const style = input.ownerDocument.defaultView?.getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  return !input.disabled && !input.readOnly && style?.display !== "none" && style?.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const prototype = view?.HTMLInputElement.prototype || HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(input, value);
  const InputEventCtor = view?.InputEvent || InputEvent;
  const EventCtor = view?.Event || Event;
  input.dispatchEvent(new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: value }));
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
}
