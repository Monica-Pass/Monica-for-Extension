import { normalizeOtpCounter, type OtpCounter } from "../../core/otp-counter";
import { encodeBase32, type OtpType } from "../../core/totp";

/**
 * 1:1 port of Android `keepass/KeePassTotpCodec.kt` (SHA 9930d8d8).
 *
 * KeePass has no single TOTP convention: KeePassXC writes `otp`, KeePass2Android writes `TOTP Seed` +
 * `TOTP Settings`, and various plugins write the split `TOTP Period`/`TOTP Digits`/`TOTP Algorithm`
 * fields. Android reads all of them and writes all of them back so no client loses its own view.
 */

export const KEEPASS_TOTP_FIELDS = {
  otp: "otp",
  seed: "TOTP Seed",
  settings: "TOTP Settings",
  period: "TOTP Period",
  digits: "TOTP Digits",
  algorithm: "TOTP Algorithm",
  otpType: "OTP Type",
  hotpCounter: "HOTP Counter"
} as const;

export interface KeePassTotpFields {
  otp?: string;
  seed?: string;
  settings?: string;
  period?: string;
  digits?: string;
  algorithm?: string;
  counter?: string;
  type?: string;
  issuer?: string;
  accountName?: string;
  link?: string;
}

export interface KeePassTotpData {
  secret: string;
  issuer: string;
  accountName: string;
  period: number;
  digits: number;
  algorithm: string;
  otpType: OtpType;
  counter: OtpCounter;
  pin?: string;
  link: string;
}

/** `normalizeSecret`: strips whitespace and dashes, then upper-cases. Base32 padding is left alone. */
export function normalizeKeePassTotpSecret(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function parseKeePassTotpFields(fields: KeePassTotpFields): KeePassTotpData | undefined {
  const fromUri = parseOtpAuthUri(fields.otp ?? "", fields);
  if (fromUri) return fromUri;

  const otp = fields.otp ?? "";
  const raw = fields.seed?.trim() ? fields.seed : otp.trim() && !otp.includes("://") ? otp : "";
  const secret = normalizeKeePassTotpSecret(raw);
  if (!secret) return undefined;

  let settings: ParsedSettings;
  try { settings = parseSettings(fields); } catch { return undefined; }
  return {
    secret,
    issuer: fields.issuer ?? "",
    accountName: fields.accountName ?? "",
    link: fields.link ?? "",
    ...settings
  };
}

/**
 * Emits every field Android emits. A partial write would leave a stale `TOTP Settings` next to a fresh
 * `otp`, and whichever field the other client reads first would win.
 */
export function keePassTotpFieldsFor(data: KeePassTotpData, title: string): Record<string, string> {
  if (data.otpType === "MOTP") {
    if (!data.secret.trim()) return {};
    return { otp: `motp://${encodeUriComponent(data.issuer || title)}:${encodeUriComponent(data.accountName)}?secret=${encodeUriComponent(data.secret.trim())}${data.pin ? `&pin=${encodeUriComponent(data.pin)}` : ""}` };
  }
  const secret = normalizeKeePassTotpSecret(data.secret);
  if (!secret) return {};
  const algorithm = (data.algorithm.trim().toUpperCase() || "SHA1");
  const period = data.period > 0 ? data.period : 30;
  const digits = data.otpType === "STEAM" ? 5 : data.digits > 0 ? data.digits : 6;
  const counter = normalizeOtpCounter(data.counter);
  const isHotp = data.otpType === "HOTP";
  const otp = buildOtpAuthUri({ ...data, secret, algorithm, period, digits, counter }, title);
  if (data.otpType === "YANDEX") return { otp };
  if (isHotp) return {
    otp,
    [KEEPASS_TOTP_FIELDS.otpType]: "HOTP",
    [KEEPASS_TOTP_FIELDS.hotpCounter]: String(counter),
    ...(algorithm === "SHA1" && digits === 6 ? { "HmacOtp-Secret-Base32": secret, "HmacOtp-Counter": String(counter) } : {})
  };
  return {
    otp,
    [KEEPASS_TOTP_FIELDS.seed]: secret,
    [KEEPASS_TOTP_FIELDS.settings]: `${period};${data.otpType === "STEAM" ? "S" : digits}`,
    [KEEPASS_TOTP_FIELDS.period]: String(period),
    [KEEPASS_TOTP_FIELDS.digits]: String(digits),
    [KEEPASS_TOTP_FIELDS.algorithm]: algorithm,
    [KEEPASS_TOTP_FIELDS.otpType]: data.otpType,
    ...(data.otpType === "TOTP" && digits <= 8 ? {
      "TimeOtp-Secret-Base32": secret, "TimeOtp-Length": String(digits), "TimeOtp-Period": String(period), "TimeOtp-Algorithm": `HMAC-SHA-${algorithm.slice(3)}`
    } : {})
  };
}

type ParsedSettings = Pick<KeePassTotpData, "period" | "digits" | "algorithm" | "otpType" | "counter">;

/**
 * Deliberately permissive: separators may be `;`, `,` or space, keys have aliases, and a bare token is
 * read positionally. The dedicated fields are applied afterwards so they override the settings string.
 */
function parseSettings(fields: KeePassTotpFields): ParsedSettings {
  let period = 30;
  let digits = 6;
  let algorithm = "SHA1";
  let otpType: OtpType = "TOTP";
  let counter: OtpCounter = 0;
  let positionalIndex = 0;

  const tokens = (fields.settings ?? "").split(/[;, ]/).map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    if (token.includes("=")) {
      const separator = token.indexOf("=");
      const key = token.slice(0, separator).trim().toLowerCase();
      const value = token.slice(separator + 1).trim();
      switch (key) {
        case "period": case "step": case "time_step": period = intOr(value, period); break;
        case "digits": case "length": digits = intOr(value, digits); break;
        case "algorithm": case "algo": case "digest": if (value) algorithm = value.toUpperCase(); break;
        case "counter": {
          const parsed = normalizeOtpCounter(value);
          if (parsed !== undefined) { counter = parsed; otpType = "HOTP"; }
          break;
        }
        case "type": case "otp_type": case "encoder":
          if (value.toLowerCase() === "hotp") otpType = "HOTP";
          if (/^(steam|s)$/i.test(value)) otpType = "STEAM";
          break;
      }
    } else {
      const number = intOrUndefined(token);
      if (number !== undefined) {
        // Positional fallback, matching Android: the first bare number fills whichever slot is
        // still at its default, so "30 6" and "60" both parse the way KeePassXC users expect.
        if (positionalIndex++ === 0) period = number;
        else if (positionalIndex === 2) digits = number;
      }
      if (/^sha/i.test(token)) algorithm = token.toUpperCase();
      if (token.toLowerCase() === "hotp") otpType = "HOTP";
      if (/^(steam|s)$/i.test(token)) otpType = "STEAM";
    }
  }

  period = intOr(fields.period ?? "", period);
  digits = intOr(fields.digits ?? "", digits);
  if (fields.algorithm?.trim()) algorithm = fields.algorithm.toUpperCase();
  const explicitCounter = fields.counter?.trim() ? normalizeOtpCounter(fields.counter) : undefined;
  if (explicitCounter !== undefined) { counter = explicitCounter; otpType = "HOTP"; }
  if ((fields.type ?? "").toLowerCase() === "hotp") otpType = "HOTP";
  if (/^(steam|s)$/i.test(fields.type || "")) otpType = "STEAM";
  if (otpType === "STEAM") digits = 5;

  return { period, digits, algorithm, otpType, counter };
}

function parseOtpAuthUri(uri: string, fields: KeePassTotpFields): KeePassTotpData | undefined {
  if (/^motp:\/\//i.test(uri)) {
    const match = /^motp:\/\/(.*?):(.*?)\?(.*)$/i.exec(uri);
    if (!match) return undefined;
    try {
      const params = new URLSearchParams(match[3]);
      const secret = params.get("secret")?.trim();
      if (!secret) return undefined;
      return { secret, issuer: decodeURIComponent(match[1]) || fields.issuer || "", accountName: decodeURIComponent(match[2]) || fields.accountName || "", period: 10, digits: 6, algorithm: "SHA1", otpType: "MOTP", counter: 0, pin: params.get("pin") || "", link: fields.link || "" };
    } catch { return undefined; }
  }
  if (!/^otpauth:\/\//i.test(uri)) return undefined;
  try {
    const parsed = new URL(uri);
    const authority = parsed.host.toLowerCase();
    if (!["totp", "hotp", "steam", "yaotp"].includes(authority)) return undefined;
    const label = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const separator = label.indexOf(":");
    const labelIssuer = separator >= 0 ? label.slice(0, separator) : "";
    const labelAccount = separator >= 0 ? label.slice(separator + 1) : label;

    const params = new Map<string, string>();
    parsed.searchParams.forEach((value, key) => params.set(key.toLowerCase(), value));
    const otpType: OtpType = authority === "hotp" ? "HOTP" : authority === "yaotp" ? "YANDEX" : authority === "steam" || params.get("encoder")?.toLowerCase() === "steam" ? "STEAM" : "TOTP";

    const secret = normalizeKeePassTotpSecret(params.get("secret") ?? "");
    if (!secret) return undefined;

    return {
      secret,
      issuer: params.get("issuer") || labelIssuer || fields.issuer || "",
      accountName: params.get("issuer") && label.startsWith(`${params.get("issuer")}:`) ? label.slice(params.get("issuer")!.length + 1) : labelAccount || fields.accountName || "",
      algorithm: (params.get("algorithm") ?? "SHA1").toUpperCase(),
      digits: otpType === "STEAM" ? 5 : intOr(params.get("digits") ?? "", 6),
      period: intOr(params.get("period") ?? "", 30),
      otpType,
      counter: normalizeOtpCounter(params.get("counter")),
      ...(params.has("pin") ? { pin: params.get("pin")! } : {}),
      link: fields.link ?? ""
    };
  } catch {
    return undefined;
  }
}

function buildOtpAuthUri(data: KeePassTotpData, title: string): string {
  const type = data.otpType === "HOTP" ? "hotp" : data.otpType === "YANDEX" ? "yaotp" : "totp";
  const label = data.issuer && data.accountName
    ? `${data.issuer}:${data.accountName}`
    : data.accountName || data.issuer || title || "Authenticator";

  const query = [`secret=${encodeUriComponent(data.secret)}`];
  if (data.otpType === "STEAM") query.push("encoder=steam");
  if (data.issuer) query.push(`issuer=${encodeUriComponent(data.issuer)}`);
  if (data.algorithm.toUpperCase() !== "SHA1") query.push(`algorithm=${encodeUriComponent(data.algorithm.toUpperCase())}`);
  if (data.digits !== 6) query.push(`digits=${data.digits}`);
  if (data.period !== 30) query.push(`period=${data.period}`);
  if (data.otpType === "HOTP") query.push(`counter=${normalizeOtpCounter(data.counter)}`);
  if (data.otpType === "YANDEX" && data.pin) query.push(`pin=${encodeUriComponent(data.pin)}`);
  return `otpauth://${type}/${encodeUriComponent(label)}?${query.join("&")}`;
}

/** Current Android also reads native KeePass TimeOtp/HmacOtp fields, with exactly one secret encoding. */
export function parseKeePassNativeTotpFields(get: (name: string) => string, prefix: "TimeOtp" | "HmacOtp", fallback: KeePassTotpFields): KeePassTotpData | undefined {
  const secrets = ["Secret", "Secret-Hex", "Secret-Base32", "Secret-Base64"].map((encoding) => ({ encoding, value: get(`${prefix}-${encoding}`) })).filter((entry) => entry.value !== "");
  if (secrets.length !== 1) return undefined;
  try {
    const { encoding, value } = secrets[0];
    let secret: string;
    if (encoding === "Secret-Base32") secret = normalizeKeePassTotpSecret(value);
    else if (encoding === "Secret") secret = encodeBase32(new TextEncoder().encode(value));
    else if (encoding === "Secret-Hex") {
      const hex = value.replace(/\s/g, "");
      if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
      secret = encodeBase32(Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16)));
    } else secret = encodeBase32(Uint8Array.from(atob(value.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
    if (!secret) return undefined;
    const hotp = prefix === "HmacOtp";
    const algorithm = hotp ? "SHA1" : get("TimeOtp-Algorithm").toUpperCase().replace(/^HMAC/, "").replace(/[-_]/g, "") || "SHA1";
    if (!["SHA1", "SHA256", "SHA512"].includes(algorithm)) return undefined;
    return { secret, issuer: fallback.issuer || "", accountName: fallback.accountName || "", link: fallback.link || "", otpType: hotp ? "HOTP" : "TOTP", counter: hotp ? normalizeOtpCounter(get("HmacOtp-Counter")) : 0, algorithm, period: intOr(get("TimeOtp-Period"), 30), digits: hotp ? 6 : intOr(get("TimeOtp-Length"), 6) };
  } catch { return undefined; }
}

/** Android uses `URLEncoder` + `+`→`%20`; `encodeURIComponent` differs only on `!'()*`, which it leaves raw. */
function encodeUriComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function intOrUndefined(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function intOr(value: string, fallback: number): number {
  return intOrUndefined(value) ?? fallback;
}
