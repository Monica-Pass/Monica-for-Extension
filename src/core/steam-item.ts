import type { LoginItem, TotpItem } from "./model";
import { parseTotpParameters } from "./totp";

/**
 * Android stores Steam Guard in a Bitwarden login's Login.Totp field as
 * `steam://<shared secret>`. Keep the login as the canonical persisted item,
 * but expose a TotpItem-shaped view to Steam UI and network operations.
 */
export function projectSteamLogin(item: LoginItem): TotpItem | undefined {
  const encoded = item.totpSecret?.trim();
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
