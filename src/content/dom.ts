import type { WalletFillKind } from "../runtime/messages";
import { queryComposedAll } from "./composed-dom";
import { inputHints, loginFieldRole, loginFieldScope, normalizeHint } from "./login-field-role";
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
  hasFocusedLoginField: boolean;
  walletKinds: WalletFillKind[];
}

export interface FillCredentialInput {
  username?: string;
  password?: string;
  totpCode?: string;
  customFields?: Array<{ name: string; value: string }>;
}

export interface LoginFields {
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  totp?: HTMLInputElement;
  scope: ParentNode;
}

export function findLoginFields(rootDocument: Document = document): LoginFields {
  const active = deepActiveInput(rootDocument);
  const activeRole = active ? loginFieldRole(active, rootDocument) : "other";
  const focusedRoot = active && activeRole !== "other" ? loginFieldScope(active, rootDocument) : undefined;
  const password = activeRole === "current-password" ? active : firstVisibleRole("current-password", focusedRoot || rootDocument);
  const passwordRoot = password ? loginFieldScope(password, rootDocument) : undefined;
  const totp = activeRole === "totp" ? active : firstVisibleRole("totp", focusedRoot || passwordRoot || rootDocument);
  const scope = focusedRoot || passwordRoot || (totp ? loginFieldScope(totp, rootDocument) : undefined) || rootDocument;
  const username = activeRole === "username" ? active : firstVisibleRole("username", scope);
  return { username, password, totp, scope };
}

function deepActiveInput(rootDocument: Document): HTMLInputElement | undefined {
  let active: Element | null = rootDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof rootDocument.defaultView!.HTMLInputElement && visibleInput(active) ? active : undefined;
}

export function scanPage(rootDocument: Document = document, pageLocation: Location = location): PageScan {
  const fields = findLoginFields(rootDocument);
  const active = deepActiveInput(rootDocument);
  const activeRole = active ? loginFieldRole(active, rootDocument) : "other";
  return {
    ok: true,
    url: pageLocation.href,
    origin: pageLocation.origin,
    host: pageLocation.hostname,
    title: rootDocument.title,
    hasUsernameField: Boolean(fields.username),
    hasPasswordField: Boolean(fields.password),
    hasTotpField: Boolean(fields.totp),
    hasFocusedLoginField: activeRole === "username" || activeRole === "current-password" || activeRole === "totp",
    walletKinds: scanWalletKinds(rootDocument)
  };
}

export function fillCredential(credential: FillCredentialInput, rootDocument: Document = document): { ok: boolean; error?: string; filledUsername?: boolean; filledPassword?: boolean; filledTotp?: boolean; filledCustomFields?: number } {
  const fields = findLoginFields(rootDocument);
  const filledUsername = Boolean(fields.username && credential.username && setNativeValue(fields.username, credential.username));
  const filledPassword = Boolean(fields.password && credential.password && setNativeValue(fields.password, credential.password));
  const filledTotp = Boolean(fields.totp && credential.totpCode && setNativeValue(fields.totp, credential.totpCode));
  const customTargets = fillCustomFields(credential.customFields || [], fields, fields.scope);
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

function firstVisibleRole(role: "username" | "current-password" | "totp", root: ParentNode): HTMLInputElement | undefined {
  return queryComposedAll<HTMLInputElement>(root, "input").find((input) => visibleInput(input) && loginFieldRole(input, root) === role);
}

function visibleInput(input: HTMLInputElement): boolean {
  const style = input.ownerDocument.defaultView?.getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  return !input.disabled && !input.readOnly && style?.display !== "none" && style?.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function setNativeValue(input: HTMLInputElement, value: string): boolean {
  const view = input.ownerDocument.defaultView;
  const prototype = view?.HTMLInputElement.prototype || HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(input, value);
  const InputEventCtor = view?.InputEvent || InputEvent;
  const EventCtor = view?.Event || Event;
  input.dispatchEvent(new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: value }));
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  return input.value === value;
}
