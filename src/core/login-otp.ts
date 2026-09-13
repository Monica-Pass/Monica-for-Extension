import type { LoginItem, TotpItem, VaultItem } from "./model";
import { generateOtpUri, generateOtpWithParameters, parseTotpParameters } from "./totp";

export interface LoginOtpResolution {
  code: string;
  updatedItem?: LoginItem | TotpItem;
}

export async function resolveLoginOtp(login: LoginItem, items: VaultItem[], now = Date.now()): Promise<LoginOtpResolution | undefined> {
  const source = findBoundTotpItem(login, items) || login;
  if (source.kind === "login" && !source.totpSecret) return undefined;
  const parameters = parametersFromItem(source);
  const code = await generateOtpWithParameters(parameters, now);
  return {
    code,
    updatedItem: parameters.otpType === "HOTP" ? advanceHotpCounter(source, now) : undefined
  };
}

/** Return a counter update to persist only after the code was successfully used. */
export function advanceHotpCounter(item: LoginItem | TotpItem, now = Date.now()): LoginItem | TotpItem | undefined {
  const parameters = parametersFromItem(item);
  if (parameters.otpType !== "HOTP") return undefined;
  const counter = (parameters.counter || 0) + 1;
  const updatedAt = new Date(now).toISOString();
  return item.kind === "totp"
    ? { ...item, counter, updatedAt }
    : { ...item, totpSecret: generateOtpUri({ ...parameters, counter }), updatedAt };
}

export function findBoundTotpItem(login: LoginItem, items: readonly VaultItem[]): TotpItem | undefined {
  if (login.boundTotpItemId !== undefined) {
    return login.boundTotpItemId ? items.find((item): item is TotpItem => item.kind === "totp" && item.id === login.boundTotpItemId && !item.deletedAt) : undefined;
  }
  const androidId = androidPasswordId(login);
  if (androidId == null) return undefined;
  const providerIds = new Set(login.providerRefs.map((reference) => reference.providerId));
  return items.find((item): item is TotpItem => item.kind === "totp" && !item.deletedAt && item.boundPasswordId === androidId && item.providerRefs.some((reference) => providerIds.has(reference.providerId)));
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
