import { parse } from "tldts";
import type { LoginItem, LoginUriRule, VaultItemKind } from "./model";

/** Only display metadata is needed; passwords and provider records stay out of icon requests. */
export interface WebsiteIconItem {
  kind?: VaultItemKind;
  uris?: readonly string[];
  uriRules?: readonly LoginUriRule[];
  loginType?: LoginItem["loginType"];
  favorite?: boolean;
  /** Sanitized projection used by the popup; empty explicitly means no website icon. */
  iconOrigin?: string;
}

export function websiteOrigin(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 8192 || /[\u0000-\u001f\u007f\\]/.test(value)) return "";
  let candidate = value;
  if (!/^https?:\/\//i.test(candidate)) {
    // Bare domains are common in Android/Bitwarden imports. Never interpret an
    // app URI, email address, regex or a scheme such as otpauth as a website.
    if (candidate.startsWith("//")) candidate = `https:${candidate}`;
    else {
      const authority = candidate.split(/[/?#]/, 1)[0];
      if (authority.includes("@") || !/^(?:\[[\da-f:]+\]|[\p{L}\p{N}_.-]+)(?::\d{1,5})?$/iu.test(authority)) return "";
      if (!authority.includes(".") && !authority.startsWith("[") && !/^localhost(?::\d+)?$/i.test(authority)) return "";
      candidate = `https://${candidate}`;
    }
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (!url.hostname || /[^a-z\d.:[\]-]/i.test(url.hostname)) return "";
    // URL.origin deliberately drops credentials, path, query and fragment.
    return url.origin;
  } catch {
    return "";
  }
}

export function loginWebsiteOrigin(item: WebsiteIconItem): string {
  if (item.kind && item.kind !== "login") return "";
  if (item.loginType && !["PASSWORD", "SSO", "STEAM_MAFILE"].includes(item.loginType)) return "";
  if (item.iconOrigin !== undefined) return websiteOrigin(item.iconOrigin);
  const regexUris = new Set(item.uriRules?.filter(rule => rule.matchType === "regex").map(rule => rule.uri.trim()));
  const candidates = [
    ...(item.uris || []).filter(uri => !regexUris.has(uri.trim())),
    ...(item.uriRules || []).filter(rule => rule.matchType !== "regex").map(rule => rule.uri)
  ];
  for (const candidate of candidates) {
    const origin = websiteOrigin(candidate);
    if (origin) return origin;
  }
  return "";
}

export function loginFallbackIcon(loginType?: LoginItem["loginType"]): string {
  switch (loginType) {
    case "WIFI": return "wifi";
    case "SSH_KEY": return "terminal";
    case "BARCODE": return "qr_code_2";
    default: return "language";
  }
}

/** IP literals, local-only/special-use names, nonstandard ports and HTTP use local icons only. */
export function websiteFaviconUrl(origin: string): string {
  const normalized = websiteOrigin(origin);
  if (!normalized) return "";
  const url = new URL(normalized);
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid|onion|i2p|arpa)\.?$/i.test(url.hostname)) return "";
  const domain = parse(url.hostname, { allowPrivateDomains: true });
  if (url.protocol !== "https:" || url.port || domain.isIp || !domain.domain || !domain.isIcann && !domain.isPrivate) return "";
  return `${url.origin}/favicon.ico`;
}
