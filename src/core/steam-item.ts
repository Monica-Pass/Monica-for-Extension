import type { LoginItem, TotpItem } from "./model";
import { parseTotpParameters } from "./totp";

/**
 * Android's full external Steam account uses a marked Bitwarden login plus a
 * maFile attachment. Standalone and historical Steam OTP entries can still use
 * Login.Totp = `steam://<shared secret>`. Both remain canonical login Ciphers;
 * this helper only exposes a TotpItem-shaped runtime view.
 */
export function projectSteamLogin(item: LoginItem): TotpItem | undefined {
  const encoded = item.totpSecret?.trim();
  if (item.steamSharedSecretBase64) {
    return {
      ...item,
      kind: "totp",
      secret: item.steamSharedSecretBase64,
      issuer: "Steam",
      accountName: item.steamAccountName || item.username || undefined,
      otpType: "STEAM",
      algorithm: "SHA1",
      digits: 5,
      period: 30
    } as TotpItem;
  }
  if (!encoded || !/^steam:\/\//i.test(encoded)) return undefined;
  try {
    const parameters = parseTotpParameters(encoded);
    if (parameters.otpType !== "STEAM") return undefined;
    return {
      ...item,
      id: item.id,
      kind: "totp",
      title: item.title,
      secret: parameters.secret,
      issuer: parameters.issuer || "Steam",
      accountName: parameters.accountName || item.username || undefined,
      otpType: "STEAM",
      algorithm: "SHA1",
      digits: 5,
      period: 30
    } as TotpItem;
  } catch {
    return undefined;
  }
}

export function projectSteamItem(item: LoginItem | TotpItem): TotpItem | undefined {
  return item.kind === "totp" ? item.otpType === "STEAM" ? item : undefined : projectSteamLogin(item);
}
