import type { WalletFillKind } from "../runtime/messages";
import { queryComposedAll } from "./composed-dom";
import { inputHints, loginFieldRole, loginFieldScope, normalizeHint, type AutofillFormControl } from "./login-field-role";
import { scanWalletKinds } from "./wallet-dom";
import { createCurrentFieldContext, type AutofillFieldContext } from "./field-signature";
import { websiteCustomFields, type AutofillCustomField } from "../autofill/custom-fields";

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
  currentField?: AutofillFieldContext;
}

export async function scanPageWithFieldContext(rootDocument: Document = document, pageLocation: Location = location): Promise<PageScan> {
  return { ...scanPage(rootDocument, pageLocation), currentField: await createCurrentFieldContext(rootDocument, pageLocation) };
}

export interface FillCredentialInput {
  username?: string;
  password?: string;
  totpCode?: string;
  customFields?: AutofillCustomField[];
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
  type Kind = 'username' | 'password' | 'totp' | 'custom';
  const targets: Array<ControlTarget & { kind: Kind }> = [];
  for (const [kind, value] of [['username', credential.username], ['password', credential.password], ['totp', credential.totpCode]] as const) {
    const input = fields[kind];
    if (input && value) targets.push({ input, value, kind });
  }
  targets.push(...customFieldTargets(websiteCustomFields(credential.customFields || []), fields, fields.scope).map(target => ({ ...target, kind: 'custom' as const })));
  if (!targets.length) return { ok: false, error: "当前页面没有与此登录项对应的可填写字段。" };
  const planned = targets.map(target => ({ ...target, current: currentInputGuard(target.input, rootDocument) }));
  const completed: typeof planned = [];
  const result = () => ({
    filledUsername: completed.some(target => target.kind === 'username' && target.current() && hasTargetValue(target)),
    filledPassword: completed.some(target => target.kind === 'password' && target.current() && hasTargetValue(target)),
    filledTotp: completed.some(target => target.kind === 'totp' && target.current() && hasTargetValue(target)),
    filledCustomFields: completed.filter(target => target.kind === 'custom' && target.current() && hasTargetValue(target)).length
  });
  for (const target of planned) {
    if (!target.current() || completed.some(previous => !previous.current() || !hasTargetValue(previous))
      || !setNativeValue(target, target.current)) {
      return { ok: false, error: "页面字段已变化，请重新选择输入框后填写。", ...result() };
    }
    completed.push(target);
  }
  if (completed.some(target => !target.current() || !hasTargetValue(target))) return { ok: false, error: "页面字段已变化，请重新选择输入框后填写。", ...result() };
  completed[completed.length - 1].input.focus();
  if (completed.some(target => !target.current() || !hasTargetValue(target))) return { ok: false, error: "页面字段已变化，请重新选择输入框后填写。", ...result() };
  return { ok: true, ...result() };
}

interface ControlTarget { input: AutofillFormControl; value: string; checked?: boolean; option?: HTMLOptionElement; }
const isInput = (input: AutofillFormControl): input is HTMLInputElement => input.tagName === 'INPUT';
const isSelect = (input: AutofillFormControl): input is HTMLSelectElement => input.tagName === 'SELECT';

function currentInputGuard(input: AutofillFormControl, root: Document): () => boolean {
  const scope = loginFieldScope(input, root);
  const originalForm = input.form;
  const originalOptions = isSelect(input) ? Array.from(input.options) : [];
  const attributes = () => JSON.stringify([input.type, input.id, input.name, input.autocomplete, inputHints(input),
    isInput(input) && input.type === 'checkbox' ? [input.value, input.indeterminate] : null,
    isSelect(input) ? [input.multiple, Array.from(input.options, option => [option.value, option.label, option.disabled, option.hidden,
      option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.hasAttribute('disabled')])] : null]);
  const original = attributes();
  const action = () => input.form ? `${input.form.action}\n${input.form.method}` : '';
  const originalAction = action();
  return () => input.isConnected && visibleInput(input) && input.form === originalForm && loginFieldScope(input, root) === scope
    && attributes() === original && action() === originalAction
    && (!isSelect(input) || originalOptions.every((option, index) => input.options[index] === option));
}

function customFieldTargets(values: AutofillCustomField[], loginFields: ReturnType<typeof findLoginFields>, root: ParentNode): ControlTarget[] {
  const reserved = new Set([loginFields.username, loginFields.password, loginFields.totp].filter(Boolean));
  const associated = 'tagName' in root && root.tagName === 'FORM' ? Array.from((root as HTMLFormElement).elements)
    .filter((element): element is AutofillFormControl => ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) : [];
  const inputs = [...new Set([...queryComposedAll<AutofillFormControl>(root, "input,textarea,select"), ...associated])].filter(input => visibleInput(input)
    && !(isInput(input) && reserved.has(input))
    && (root === input.ownerDocument || loginFieldScope(input) === root));
  const filled: ControlTarget[] = [];
  for (const field of values) {
    const name = normalizeHint(field.name);
    if (!name || !field.value) continue;
    const target = inputs.filter(input => !filled.some(target => target.input === input) && inputHints(input).includes(name))
      .map(input => customTarget(input, field)).find(target => target !== undefined);
    if (!target) continue;
    filled.push(target);
  }
  return filled;
}

function customTarget(input: AutofillFormControl, field: AutofillCustomField): ControlTarget | undefined {
  if (isInput(input)) {
    if (input.type === 'checkbox') {
      const booleanField = field.fieldType ? field.fieldType === 'BOOLEAN' : field.type === 'boolean';
      const value = field.value.trim().toLowerCase();
      return booleanField && !input.indeterminate && ['true', 'false'].includes(value) ? { input, value: input.value, checked: value === 'true' } : undefined;
    }
    if (!['text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'time', 'month', 'week'].includes(input.type)
      || loginFieldRole(input) === 'new-password') return undefined;
  }
  if (isSelect(input)) {
    if (input.multiple) return undefined;
    const options = Array.from(input.options);
    const exact = options.filter(option => option.value === field.value);
    const matches = exact.length ? exact : options.filter(option => option.label === field.value);
    if (matches.length !== 1) return undefined;
    const option = matches[0];
    if (option.disabled || option.hidden || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.hasAttribute('disabled')
      || options.filter(other => other.value === option.value).length !== 1) return undefined;
    return { input, value: option.value, option };
  }
  // HTML textarea APIs normalize line endings; the stored vault value stays exact.
  return { input, value: input.tagName === 'TEXTAREA' ? field.value.replace(/\r\n?/g, '\n') : field.value };
}

function hasTargetValue(target: ControlTarget): boolean {
  return target.checked !== undefined ? isInput(target.input) && target.input.checked === target.checked
    : target.input.value === target.value && (!target.option || isSelect(target.input) && target.input.selectedOptions.length === 1 && target.input.selectedOptions[0] === target.option);
}

function firstVisibleRole(role: "username" | "current-password" | "totp", root: ParentNode): HTMLInputElement | undefined {
  return queryComposedAll<HTMLInputElement>(root, "input").find((input) => visibleInput(input) && loginFieldRole(input, root) === role);
}

function visibleInput(input: AutofillFormControl): boolean {
  const style = input.ownerDocument.defaultView?.getComputedStyle(input);
  const rect = input.getBoundingClientRect();
  return !input.disabled && !input.matches(':disabled') && !('readOnly' in input && input.readOnly)
    && !(isInput(input) && input.type === 'hidden') && style?.display !== "none" && style?.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function setNativeValue(target: ControlTarget, current: () => boolean): boolean {
  const { input, value, checked } = target;
  const view = input.ownerDocument.defaultView;
  if (!view) return false;
  const prototype = isInput(input) ? view.HTMLInputElement.prototype : isSelect(input) ? view.HTMLSelectElement.prototype : view.HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, checked === undefined ? 'value' : 'checked');
  if (!descriptor?.set) return false;
  try { descriptor.set.call(input, checked === undefined ? value : checked); } catch { return false; }
  const InputEventCtor = view?.InputEvent || InputEvent;
  const EventCtor = view?.Event || Event;
  input.dispatchEvent(checked !== undefined || isSelect(input) ? new EventCtor('input', { bubbles: true })
    : new InputEventCtor("input", { bubbles: true, inputType: "insertText", data: value }));
  if (!current()) return false;
  input.dispatchEvent(new EventCtor("change", { bubbles: true }));
  return current() && hasTargetValue(target);
}
