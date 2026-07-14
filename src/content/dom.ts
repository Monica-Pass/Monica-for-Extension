export interface PageScan {
  ok: true;
  url: string;
  origin: string;
  host: string;
  title: string;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
}

export interface FillCredentialInput {
  username?: string;
  password?: string;
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

export function findLoginFields(rootDocument: Document = document): { username?: HTMLInputElement; password?: HTMLInputElement } {
  const password = firstVisible('input[type="password"]', rootDocument);
  if (!password) return {};
  const root: ParentNode = password.form || rootDocument;
  let username: HTMLInputElement | undefined;
  for (const selector of USERNAME_SELECTORS) {
    username = firstVisible(selector, root);
    if (username && username !== password) break;
  }
  return { username, password };
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
    hasPasswordField: Boolean(fields.password)
  };
}

export function fillCredential(credential: FillCredentialInput, rootDocument: Document = document): { ok: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean } {
  const fields = findLoginFields(rootDocument);
  if (!fields.password) return { ok: false, error: "当前页面没有可填写的密码框。" };
  if (fields.username && credential.username) setNativeValue(fields.username, credential.username);
  setNativeValue(fields.password, credential.password || "");
  fields.password.focus();
  return { ok: true, filledUsername: Boolean(fields.username && credential.username), filledPassword: true };
}

function firstVisible(selector: string, root: ParentNode): HTMLInputElement | undefined {
  return Array.from(root.querySelectorAll<HTMLInputElement>(selector)).find(visibleInput);
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
