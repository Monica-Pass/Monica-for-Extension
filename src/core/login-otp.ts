import type { LoginItem, TotpItem, VaultItem } from "./model";
import { nextOtpCounter, normalizeOtpCounter, type OtpCounter } from "./otp-counter";
import { passwordGroupKey } from "./password-groups";
import { readProjectCredential } from "./project-credentials";
import { generateOtpUri, generateOtpWithParameters, parseTotpParameters } from "./totp";

export interface LoginOtpResolution {
  code: string;
  usage?: HotpUsage;
}

/** A successful-use acknowledgement, never a replacement item snapshot. */
export interface HotpUsage {
  itemId: string;
  identity: string;
  counter: OtpCounter;
  login?: { itemId: string; binding: string };
}

async function fingerprint(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function otpSourceBinding(item: LoginItem | TotpItem): Promise<string> {
  const credential = item.kind === 'login' ? readProjectCredential(item.customFields) : undefined;
  return fingerprint([item.id, item.kind, item.createdAt,
    item.providerRefs.map(ref => [ref.providerId, ref.remoteId ?? null, ref.remoteFolderId ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    item.mdbxDatabaseId ?? null, item.keepassDatabaseId ?? null,
    item.kind === 'login' ? [passwordGroupKey(item), credential?.groupId ?? null, credential?.passwordId ?? null, item.boundTotpItemId ?? null] : item.boundPasswordId ?? null]);
}

export async function hotpSigningIdentity(item: LoginItem | TotpItem): Promise<string> {
  const parameters = parametersFromItem(item);
  return fingerprint([parameters.otpType, parameters.secret, parameters.algorithm, parameters.digits, parameters.secretEncoding ?? 'base32']);
}

export async function hotpUsageFromItem(item: LoginItem | TotpItem): Promise<HotpUsage | undefined> {
  const parameters = parametersFromItem(item);
  if (parameters.otpType !== 'HOTP') return undefined;
  return { itemId: item.id, counter: normalizeOtpCounter(parameters.counter),
    identity: await fingerprint([await otpSourceBinding(item), await hotpSigningIdentity(item)]) };
}

export async function resolveLoginOtp(login: LoginItem, items: VaultItem[], now = Date.now()): Promise<LoginOtpResolution | undefined> {
  const source = findBoundTotpItem(login, items) || login;
  if (source.kind === "login" && !source.totpSecret) return undefined;
  const parameters = parametersFromItem(source);
  if (parameters.otpType === 'HOTP') nextOtpCounter(parameters.counter);
  const code = await generateOtpWithParameters(parameters, now);
  const usage = await hotpUsageFromItem(source);
  if (usage) usage.login = { itemId: login.id, binding: await otpSourceBinding(login) };
  return {
    code,
    usage
  };
}

/** Return a counter update to persist only after the code was successfully used. */
export function advanceHotpCounter(item: LoginItem | TotpItem, now = Date.now()): LoginItem | TotpItem | undefined {
  const parameters = parametersFromItem(item);
  if (parameters.otpType !== "HOTP") return undefined;
  const counter = nextOtpCounter(parameters.counter);
  const updatedAt = new Date(now).toISOString();
  return item.kind === "totp"
    ? { ...item, counter, updatedAt }
    : { ...item, totpSecret: incrementHotpUri(item.totpSecret || "", counter, parameters), updatedAt };
}

function incrementHotpUri(raw: string, counter: number | string, parameters: ReturnType<typeof parametersFromItem>): string {
  if (/^otpauth:\/\/hotp\//i.test(raw)) {
    const uri = new URL(raw);
    uri.searchParams.set("counter", String(counter));
    return uri.toString();
  }
  return generateOtpUri({ ...parameters, counter });
}

export function findBoundTotpItem(login: LoginItem, items: readonly VaultItem[]): TotpItem | undefined {
  if (login.boundTotpItemId !== undefined) {
    return login.boundTotpItemId ? items.find((item): item is TotpItem => item.kind === "totp" && item.id === login.boundTotpItemId && !item.deletedAt && !item.archivedAt) : undefined;
  }
  const androidId = androidPasswordId(login);
  if (androidId == null) return undefined;
  const providerIds = new Set(login.providerRefs.map((reference) => reference.providerId));
  return items.find((item): item is TotpItem => item.kind === "totp" && !item.deletedAt && !item.archivedAt && item.boundPasswordId === androidId && item.providerRefs.some((reference) => providerIds.has(reference.providerId)));
}

export function parametersFromItem(item: LoginItem | TotpItem) {
  if (item.kind === "login") return parseTotpParameters(item.totpSecret || "");
  return {
    secret: item.steamSharedSecretBase64 || item.secret,
    algorithm: item.algorithm,
    digits: item.digits,
    period: item.period,
    otpType: item.otpType || "TOTP",
    counter: item.counter || 0,
    pin: item.pin || "",
    pinLength: item.pinLength,
    issuer: item.issuer,
    accountName: item.accountName,
    secretEncoding: item.otpType === "STEAM" && item.steamSharedSecretBase64 ? "base64" as const : "base32" as const
  };
}

function androidPasswordId(login: LoginItem): number | undefined {
  for (const reference of login.providerRefs) {
    const match = reference.remoteId?.match(/\/password_(-?\d+)_\d+\.json$/i);
    if (match) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value)) return value;
    }
  }
  return undefined;
}
