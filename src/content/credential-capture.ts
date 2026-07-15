import type { CredentialCaptureInput } from "../runtime/messages";

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[autocomplete="tel"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
  'input[name*="mobile" i]',
  'input[id*="mobile" i]',
  'input[type="text"]'
];

export function captureCredentialInput(root: ParentNode, rootDocument: Document = document, pageLocation: Location = location): CredentialCaptureInput | null {
  const passwordInputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => !input.disabled && !input.readOnly && input.value.length > 0);
  if (!passwordInputs.length) return null;

  const newPasswordInputs = passwordInputs.filter((input) => input.autocomplete.toLowerCase() === "new-password");
  const captureKind = newPasswordInputs.length ? "password-change" : "login";
  const password = choosePassword(newPasswordInputs.length ? newPasswordInputs : passwordInputs);
  if (!password) return null;
  const username = findUsername(root, passwordInputs)?.value || "";
  return {
    username: username.trim(),
    password,
    pageUrl: pageLocation.href,
    pageTitle: rootDocument.title,
    captureKind
  };
}

export function captureRootForEvent(target: EventTarget | null, rootDocument: Document = document): ParentNode {
  if (target instanceof rootDocument.defaultView!.HTMLFormElement) return target;
  if (target instanceof rootDocument.defaultView!.Element) return target.closest("form") || rootDocument;
  return rootDocument;
}

function choosePassword(inputs: HTMLInputElement[]): string {
  if (inputs.length === 1) return inputs[0].value;
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.value, (counts.get(input.value) || 0) + 1);
  const confirmed = [...counts.entries()].find(([, count]) => count >= 2)?.[0];
  return confirmed || inputs[inputs.length - 1].value;
}

function findUsername(root: ParentNode, passwordInputs: HTMLInputElement[]): HTMLInputElement | undefined {
  for (const selector of USERNAME_SELECTORS) {
    const candidate = Array.from(root.querySelectorAll<HTMLInputElement>(selector)).find((input) =>
      !passwordInputs.includes(input) && !input.disabled && !input.readOnly && input.value.trim().length > 0
    );
    if (candidate) return candidate;
  }
  return undefined;
}
