import { queryComposedAll } from "./composed-dom";
import { loginFieldRole, type LoginFieldRole } from "./login-field-role";
import { walletFieldName } from "./wallet-dom";
import type { AutofillFieldRole } from "../autofill/field-policy";

export type { AutofillFieldRole } from "../autofill/field-policy";

export interface AutofillFieldContext {
  signature: string;
  hostname: string;
  frameScope: "top-level" | "frame";
  role: AutofillFieldRole;
  hints: AutofillFieldRole[];
}

const MAX_STRUCTURAL_CONTROLS = 512;
const MAX_CREDENTIAL_TARGETS = 128;

export async function createCurrentFieldContext(rootDocument: Document = document, pageLocation: Location = location): Promise<AutofillFieldContext | undefined> {
  const active = deepActiveControl(rootDocument);
  if (!active) return undefined;
  return createFieldContext(active, rootDocument, pageLocation);
}

export async function createFieldContextsForRoot(root: ParentNode, rootDocument: Document = document, pageLocation: Location = location): Promise<AutofillFieldContext[]> {
  const controls = queryComposedAll<AutofillControl>(root, "input,select,textarea").slice(0, MAX_CREDENTIAL_TARGETS);
  const contexts = await Promise.all(controls.map((control) => createFieldContext(control, rootDocument, pageLocation)));
  return contexts.filter((context): context is AutofillFieldContext => Boolean(context));
}

async function createFieldContext(active: AutofillControl, rootDocument: Document, pageLocation: Location): Promise<AutofillFieldContext | undefined> {
  const role = fieldRole(active, rootDocument);
  if (!role) return undefined;

  const allControls = queryComposedAll<AutofillControl>(rootDocument, "input,select,textarea");
  const boundedControls = allControls.slice(0, MAX_STRUCTURAL_CONTROLS);
  if (!boundedControls.includes(active)) boundedControls.push(active);
  const forms = queryComposedAll<HTMLFormElement>(rootDocument, "form").slice(0, MAX_STRUCTURAL_CONTROLS);
  const targets = boundedControls.flatMap((control) => {
    const candidateRole = fieldRole(control, rootDocument);
    if (!candidateRole) return [];
    const formIndex = control.form ? boundedIndex(forms.indexOf(control.form)) : -1;
    return [`${candidateRole}@${boundedIndex(allControls.indexOf(control))}@${formIndex}@${isVisible(control) ? 1 : 0}`];
  }).slice(0, MAX_CREDENTIAL_TARGETS);
  const currentIndex = boundedIndex(allControls.indexOf(active));
  const currentFormIndex = active.form ? boundedIndex(forms.indexOf(active.form)) : -1;
  const hostname = normalizeHostname(pageLocation.hostname);
  if (!hostname) return undefined;
  const frameScope = isTopLevel(rootDocument) ? "top-level" : "frame";
  const raw = `${hostname}|${frameScope}|${role}@${currentIndex}@${currentFormIndex}@${isVisible(active) ? 1 : 0}|${targets.join("|")}`;
  return {
    signature: await sha256Hex(raw),
    hostname,
    frameScope,
    role,
    hints: [...new Set(targets.map((target) => target.split("@", 1)[0] as AutofillFieldRole))]
  };
}

type AutofillControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function deepActiveControl(rootDocument: Document): AutofillControl | undefined {
  let active: Element | null = rootDocument.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const view = rootDocument.defaultView;
  if (!view || !active) return undefined;
  return active instanceof view.HTMLInputElement || active instanceof view.HTMLSelectElement || active instanceof view.HTMLTextAreaElement ? active : undefined;
}

function fieldRole(control: AutofillControl, rootDocument: Document): AutofillFieldRole | undefined {
  const view = rootDocument.defaultView;
  if (!view) return undefined;
  if (control instanceof view.HTMLInputElement) {
    const role = loginFieldRole(control, rootDocument);
    if (role !== "other") return role;
  }
  return walletFieldName(control) ? "wallet" : undefined;
}

function isVisible(control: AutofillControl): boolean {
  const view = control.ownerDocument.defaultView;
  const style = view?.getComputedStyle(control);
  const rect = control.getBoundingClientRect();
  return !control.disabled
    && !(control instanceof control.ownerDocument.defaultView!.HTMLInputElement && control.readOnly)
    && !(control instanceof control.ownerDocument.defaultView!.HTMLTextAreaElement && control.readOnly)
    && style?.display !== "none"
    && style?.visibility !== "hidden"
    && rect.width > 0
    && rect.height > 0;
}

function isTopLevel(rootDocument: Document): boolean {
  try { return rootDocument.defaultView?.top === rootDocument.defaultView; }
  catch { return false; }
}

function boundedIndex(index: number): number {
  if (index < 0) return -1;
  return Math.min(index, MAX_STRUCTURAL_CONTROLS);
}

function normalizeHostname(value: string): string {
  try { return new URL(`https://${value.toLowerCase().replace(/\.+$/, "")}`).hostname; }
  catch { return ""; }
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持字段签名。");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
