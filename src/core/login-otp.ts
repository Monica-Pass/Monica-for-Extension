import type { LoginItem, TotpItem, VaultItem } from "./model";
import { generateOtpUri, generateOtpWithParameters, parseTotpParameters } from "./totp";

export interface LoginOtpResolution {
  code: string;
  updatedItem?: LoginItem | TotpItem;
}

export async function resolveLoginOtp(login: LoginItem, items: VaultItem[], now = Date.now()): Promise<LoginOtpResolution | undefined> {
  const linked = findBoundTotpItem(login, items);
  if (linked) {
    const parameters = parametersFromItem(linked);
    const code = await generateOtpWithParameters(parameters, now);
    return {
      code,
      updatedItem: parameters.otpType === "HOTP" ? { ...linked, counter: (linked.counter || 0) + 1, updatedAt: new Date(now).toISOString() } : undefined
    };
  }
  if (!login.totpSecret) return undefined;
  const parameters = parseTotpParameters(login.totpSecret);
  const code = await generateOtpWithParameters(parameters, now);
  return {
    code,
    updatedItem: parameters.otpType === "HOTP"
      ? { ...login, totpSecret: generateOtpUri({ ...parameters, counter: (parameters.counter || 0) + 1 }), updatedAt: new Date(now).toISOString() }
      : undefined
  };
}

export function findBoundTotpItem(login: LoginItem, items: VaultItem[]): TotpItem | undefined {
  if (login.boundTotpItemId) {
    const explicit = items.find((item): item is TotpItem => item.kind === "totp" && item.id === login.boundTotpItemId && !item.deletedAt);
    if (explicit) return explicit;
  }
  const androidId = androidPasswordId(login);
  if (androidId == null) return undefined;
  const providerIds = new Set(login.providerRefs.map((reference) => reference.providerId));
  return items.find((item): item is TotpItem => item.kind === "totp" && !item.deletedAt && item.boundPasswordId === androidId && item.providerRefs.some((reference) => providerIds.has(reference.providerId)));
}

export function parametersFromItem(item: TotpItem) {
  return {
    secret: item.steamSharedSecretBase64 || item.secret,
    algorithm: item.algorithm,
    digits: item.digits,
    period: item.period,
    otpType: item.otpType || "TOTP",
    counter: item.counter || 0,
    pin: item.pin || "",
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
