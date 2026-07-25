import { elementByIdInRoot } from "./composed-dom";

export type LoginFieldRole = "username" | "current-password" | "new-password" | "totp" | "other";

const OTP_HINT = /^(totp|otp|2fa|twofa|mfa)(code|token|input|field|password)?$|^(code|token)(totp|otp|2fa|twofa|mfa)$|^(verification|verify|sms|auth|authentication|login)(code|token)$|^(动态|短信|登录|身份)验证码$/;
const AMBIGUOUS_CODE_HINT = /^(code|token|pin|securitycode|securitytoken|验证码|安全码|校验码)$/;
const NEW_PASSWORD_HINT = /(newpassword|confirmpassword|passwordconfirmation|createpassword|setpassword|新密码|确认密码|重复密码)/;
const NEW_PASSWORD_SCOPE = /(signup|sign-up|register|registration|createaccount|resetpassword|forgotpassword|changepassword|注册|创建账户|重置密码|修改密码|设置密码)/;

export function loginFieldRole(input: HTMLInputElement, fallbackRoot: ParentNode = input.ownerDocument): LoginFieldRole {
  const autocomplete = autocompleteTokens(input);
  const hints = inputHints(input);
  if (looksLikeOtpInput(input, autocomplete, hints)) return "totp";
  if (autocomplete.includes("new-password")) return "new-password";
  if (autocomplete.includes("current-password")) return "current-password";
  if (input.type === "password") {
    if (hints.some((hint) => NEW_PASSWORD_HINT.test(hint)) || likelyNewPasswordScope(loginFieldScope(input, fallbackRoot))) return "new-password";
    return "current-password";
  }
  if (autocomplete.some((token) => token === "username" || token === "email" || token === "tel")) return "username";
  if (input.type === "email" || input.type === "tel") return "username";
  if ((input.type === "text" || input.type === "search") && hints.some((hint) => /(user|login|email|phone|mobile|account|用户名|邮箱|手机|账号)/.test(hint))) return "username";
  if (hints.some((hint) => /(username|loginname|email|emailaddress|phone|phonenumber|mobile|accountname|用户名|邮箱|手机号|账号)/.test(hint))) return "username";
  if (input.type === "text" && isOnlyTextCandidateBeforePassword(input, fallbackRoot)) return "username";
  return "other";
}

export function loginFieldScope(input: HTMLInputElement, fallbackRoot: ParentNode = input.ownerDocument): ParentNode {
  if (input.form) return input.form;
  const semantic = input.closest<HTMLElement>('[role="form"],dialog,[aria-modal="true"]');
  if (semantic) return semantic;
  let current = input.parentElement;
  while (current && current !== input.ownerDocument.body) {
    if (current.querySelector('button[type="submit"],input[type="submit"]') && current.querySelector('input[type="password"]')) return current;
    current = current.parentElement;
  }
  return input.getRootNode() as ParentNode || fallbackRoot;
}

export function inputHints(input: HTMLInputElement): string[] {
  const labelledBy = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
    .map((id) => elementByIdInRoot(input, id)?.textContent);
  return [input.id, input.name, input.getAttribute("aria-label"), input.placeholder, ...labelledBy, ...Array.from(input.labels || []).map((label) => label.textContent)]
    .map((value) => normalizeHint(value || ""))
    .filter(Boolean);
}

export function normalizeHint(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function autocompleteTokens(input: HTMLInputElement): string[] {
  return input.autocomplete.toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function likelyNewPasswordScope(root: ParentNode): boolean {
  const passwords = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => !looksLikeOtpInput(input, autocompleteTokens(input), inputHints(input)));
  const hasCurrent = passwords.some((input) => autocompleteTokens(input).includes("current-password"));
  if (passwords.length >= 2 && !hasCurrent) return true;
  const ownerDocument = "defaultView" in root ? root as Document : root.ownerDocument;
  const view = ownerDocument?.defaultView;
  const element = view && root instanceof view.Element ? root : undefined;
  const documentPath = ownerDocument?.location?.pathname || "";
  const semantics = [documentPath, element?.id, element?.getAttribute("name"), element?.getAttribute("action"), element?.getAttribute("aria-label"), element?.textContent?.slice(0, 500)]
    .filter(Boolean).join(" ").toLocaleLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
  return NEW_PASSWORD_SCOPE.test(semantics);
}

function isOnlyTextCandidateBeforePassword(input: HTMLInputElement, fallbackRoot: ParentNode): boolean {
  const scope = loginFieldScope(input, fallbackRoot);
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
  const passwordIndex = inputs.findIndex((candidate) => candidate.type === "password"
    && !autocompleteTokens(candidate).includes("new-password")
    && !looksLikeOtpInput(candidate, autocompleteTokens(candidate), inputHints(candidate)));
  const inputIndex = inputs.indexOf(input);
  if (passwordIndex < 0 || inputIndex < 0 || inputIndex > passwordIndex) return false;
  const candidates = inputs.slice(0, passwordIndex).filter((candidate) =>
    !candidate.disabled
    && !candidate.readOnly
    && (candidate.type === "text" || candidate.type === "search" || candidate.type === "email" || candidate.type === "tel")
    && !inputHints(candidate).some((hint) => OTP_HINT.test(hint) || AMBIGUOUS_CODE_HINT.test(hint))
  );
  return candidates.length === 1 && candidates[0] === input;
}

function looksLikeOtpInput(input: HTMLInputElement, autocomplete = autocompleteTokens(input), hints = inputHints(input)): boolean {
  if (autocomplete.includes("one-time-code") || hints.some((hint) => OTP_HINT.test(hint))) return true;
  if (!hints.some((hint) => AMBIGUOUS_CODE_HINT.test(hint))) return false;
  const numeric = input.inputMode === "numeric"
    || input.inputMode === "decimal"
    || input.inputMode === "tel"
    || /\\d|0-9/.test(input.pattern);
  return numeric && input.maxLength >= 4 && input.maxLength <= 10;
}
