import type { WalletFillKind } from "../runtime/messages";
import { elementByIdInRoot, queryComposedAll } from "./composed-dom";
import { scanWalletKinds } from "./wallet-dom";

export interface PageScan {
  ok: true;
  url: string;
  origin: string;
  host: string;
  title: string;
  hasUsernameField: boolean;
  hasPasswordField: boolean;
  hasTotpField: boolean;
  walletKinds: WalletFillKind[];
}

export interface FillCredentialInput {
  username?: string;
  password?: string;
  totpCode?: string;
  customFields?: Array<{ name: string; value: string }>;
}

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="tel"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
  'input[name*="mobile" i]',
  'input[id*="mobile" i]',
  'input[type="text"]'
];

const TOTP_SELECTORS = [
  'input[autocomplete="one-time-code"]'
];

export function findLoginFields(rootDocument: Document = document): { username?: HTMLInputElement; password?: HTMLInputElement; totp?: HTMLInputElement } {
  const password = firstVisible('input[type="password"]', rootDocument);
  const totp = firstVisibleFrom(TOTP_SELECTORS, rootDocument) || findExplicitTotp(rootDocument);
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
    hasTotpField: Boolean(fields.totp),
    walletKinds: scanWalletKinds(rootDocument)
  };
}

export function fillCredential(credential: FillCredentialInput, rootDocument: Document = document): { ok: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean; filledTotp?: boolean; filledCustomFields?: number } {
  const fields = findLoginFields(rootDocument);
  const filledUsername = Boolean(fields.username && credential.username);
  const filledPassword = Boolean(fields.password && credential.password);
  const filledTotp = Boolean(fields.totp && credential.totpCode);
  if (fields.username && credential.username) setNativeValue(fields.username, credential.username);
  if (fields.password && credential.password) setNativeValue(fields.password, credential.password);
  if (fields.totp && credential.totpCode) setNativeValue(fields.totp, credential.totpCode);
  const customTargets = fillCustomFields(credential.customFields || [], fields, rootDocument);
  const focusTarget = customTargets[customTargets.length - 1] || (filledTotp ? fields.totp : filledPassword ? fields.password : filledUsername ? fields.username : undefined);
  if (!focusTarget) return { ok: false, error: "当前页面没有与此登录项对应的可填写字段。" };
  focusTarget.focus();
  return { ok: true, filledUsername, filledPassword, filledTotp, filledCustomFields: customTargets.length };
}

function fillCustomFields(values: Array<{ name: string; value: string }>, loginFields: ReturnType<typeof findLoginFields>, root: ParentNode): HTMLInputElement[] {
  const reserved = new Set([loginFields.username, loginFields.password, loginFields.totp].filter(Boolean));
  const inputs = queryComposedAll<HTMLInputElement>(root, "input").filter((input) => visibleInput(input) && !reserved.has(input));
  const filled: HTMLInputElement[] = [];
  for (const field of values) {
    const name = normalizeHint(field.name);
    if (!name || !field.value) continue;
    const target = inputs.find((input) => !filled.includes(input) && inputHints(input).includes(name));
    if (!target) continue;
    setNativeValue(target, field.value);
    filled.push(target);
  }
  return filled;
}

function firstVisible(selector: string, root: ParentNode): HTMLInputElement | undefined {
  return queryComposedAll<HTMLInputElement>(root, selector).find(visibleInput);
}

function firstVisibleFrom(selectors: string[], root: ParentNode): HTMLInputElement | undefined {
  for (const selector of selectors) {
    const input = firstVisible(selector, root);
    if (input) return input;
  }
  return undefined;
}

function findExplicitTotp(root: ParentNode): HTMLInputElement | undefined {
  return queryComposedAll<HTMLInputElement>(root, "input").find((input) => {
    if (!visibleInput(input)) return false;
    return inputHints(input).some((hint) => /^(totp|otp|2fa|twofa)(code|token|input|field)?$|^(code|token)(totp|otp|2fa|twofa)$/.test(hint));
  });
}

function inputHints(input: HTMLInputElement): string[] {
  const labelledBy = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map((id) => elementByIdInRoot(input, id)?.textContent);
  return [input.id, input.name, input.getAttribute("aria-label"), input.placeholder, ...labelledBy, ...Array.from(input.labels || []).map((label) => label.textContent)]
    .map((value) => normalizeHint(value || ""))
    .filter(Boolean);
}

function normalizeHint(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
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
