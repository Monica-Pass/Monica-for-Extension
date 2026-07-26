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
  otpType: "TOTP" | "HOTP";
  counter: number;
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

  const settings = parseSettings(fields);
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
  const secret = normalizeKeePassTotpSecret(data.secret);
  if (!secret) return {};
  const algorithm = (data.algorithm.trim().toUpperCase() || "SHA1");
  const period = data.period > 0 ? data.period : 30;
  const digits = data.digits > 0 ? data.digits : 6;
  const counter = Math.max(0, data.counter);
  const isHotp = data.otpType === "HOTP";

  const settings = [`period=${period}`, `digits=${digits}`, `algorithm=${algorithm}`];
  if (isHotp) settings.push("type=hotp", `counter=${counter}`);

  return {
    [KEEPASS_TOTP_FIELDS.otp]: buildOtpAuthUri({ ...data, secret, algorithm, period, digits, counter }, title),
    [KEEPASS_TOTP_FIELDS.seed]: secret,
    [KEEPASS_TOTP_FIELDS.settings]: settings.join(";"),
    [KEEPASS_TOTP_FIELDS.period]: String(period),
    [KEEPASS_TOTP_FIELDS.digits]: String(digits),
    [KEEPASS_TOTP_FIELDS.algorithm]: algorithm,
    [KEEPASS_TOTP_FIELDS.otpType]: isHotp ? "HOTP" : "TOTP",
    ...(isHotp ? { [KEEPASS_TOTP_FIELDS.hotpCounter]: String(counter) } : {})
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
  let otpType: "TOTP" | "HOTP" = "TOTP";
  let counter = 0;

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
          const parsed = intOrUndefined(value);
          if (parsed !== undefined) { counter = parsed; otpType = "HOTP"; }
          break;
        }
        case "type": case "otp_type": if (value.toLowerCase() === "hotp") otpType = "HOTP"; break;
      }
    } else {
      const number = intOrUndefined(token);
      if (number !== undefined) {
        // Positional fallback, matching Android: the first bare number fills whichever slot is
        // still at its default, so "30 6" and "60" both parse the way KeePassXC users expect.
        if (period === 30) period = number;
        else if (digits === 6) digits = number;
      }
      if (/^sha/i.test(token)) algorithm = token.toUpperCase();
      if (token.toLowerCase() === "hotp") otpType = "HOTP";
    }
  }

  period = intOr(fields.period ?? "", period);
  digits = intOr(fields.digits ?? "", digits);
  if (fields.algorithm?.trim()) algorithm = fields.algorithm.toUpperCase();
  const explicitCounter = intOrUndefined(fields.counter ?? "");
  if (explicitCounter !== undefined) { counter = explicitCounter; otpType = "HOTP"; }
  if ((fields.type ?? "").toLowerCase() === "hotp") otpType = "HOTP";

  return { period, digits, algorithm, otpType, counter };
}

function parseOtpAuthUri(uri: string, fields: KeePassTotpFields): KeePassTotpData | undefined {
  if (!/^otpauth:\/\//i.test(uri)) return undefined;
  try {
    const parsed = new URL(uri);
    const otpType = parsed.host.toLowerCase() === "hotp" ? "HOTP" : "TOTP";
    const label = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const separator = label.indexOf(":");
    const labelIssuer = separator >= 0 ? label.slice(0, separator) : "";
    const labelAccount = separator >= 0 ? label.slice(separator + 1) : label;

    const params = new Map<string, string>();
    parsed.searchParams.forEach((value, key) => params.set(key.toLowerCase(), value));

    const secret = normalizeKeePassTotpSecret(params.get("secret") ?? "");
    if (!secret) return undefined;

    return {
      secret,
      issuer: params.get("issuer") || labelIssuer || fields.issuer || "",
      accountName: labelAccount || fields.accountName || "",
      algorithm: (params.get("algorithm") ?? "SHA1").toUpperCase(),
      digits: intOr(params.get("digits") ?? "", 6),
      period: intOr(params.get("period") ?? "", 30),
      otpType,
      counter: intOr(params.get("counter") ?? "", 0),
      link: fields.link ?? ""
    };
  } catch {
    return undefined;
  }
}

function buildOtpAuthUri(data: KeePassTotpData, title: string): string {
  const type = data.otpType === "HOTP" ? "hotp" : "totp";
  const label = data.issuer && data.accountName
    ? `${data.issuer}:${data.accountName}`
    : data.accountName || data.issuer || title || "Authenticator";

  const query = [`secret=${encodeUriComponent(data.secret)}`];
  if (data.issuer) query.push(`issuer=${encodeUriComponent(data.issuer)}`);
  if (data.algorithm.toUpperCase() !== "SHA1") query.push(`algorithm=${encodeUriComponent(data.algorithm.toUpperCase())}`);
  if (data.digits !== 6) query.push(`digits=${data.digits}`);
  if (data.period !== 30) query.push(`period=${data.period}`);
  if (data.otpType === "HOTP") query.push(`counter=${Math.max(0, data.counter)}`);
  return `otpauth://${type}/${encodeUriComponent(label)}?${query.join("&")}`;
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
