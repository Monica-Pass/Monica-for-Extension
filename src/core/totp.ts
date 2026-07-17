export interface TotpParameters {
  secret: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: number;
  period: number;
}

export async function generateTotp(input: string, now = Date.now()): Promise<string> {
  const parameters = parseTotpParameters(input);
  return generateTotpWithParameters(parameters, now);
}

export async function generateTotpWithParameters(parameters: TotpParameters, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / 1000 / parameters.period);
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const key = await crypto.subtle.importKey("raw", decodeBase32(parameters.secret) as BufferSource, { name: "HMAC", hash: `SHA-${parameters.algorithm.slice(3)}` }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary = ((signature[offset] & 0x7f) << 24) | (signature[offset + 1] << 16) | (signature[offset + 2] << 8) | signature[offset + 3];
  return String(binary % 10 ** parameters.digits).padStart(parameters.digits, "0");
}

export function parseTotpParameters(input: string): TotpParameters {
  const trimmed = input.trim();
  let secret = trimmed;
  let algorithm = "SHA1" as TotpParameters["algorithm"];
  let digits = 6;
  let period = 30;
  if (/^otpauth:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "totp") throw new Error("仅支持 TOTP 类型的 OTP URI。");
    secret = url.searchParams.get("secret") || "";
    const rawAlgorithm = (url.searchParams.get("algorithm") || "SHA1").replace(/-/g, "").toUpperCase();
    if (rawAlgorithm === "SHA256" || rawAlgorithm === "SHA512") algorithm = rawAlgorithm;
    digits = Number(url.searchParams.get("digits") || 6);
    period = Number(url.searchParams.get("period") || 30);
  }
  if (!secret) throw new Error("TOTP 密钥为空。");
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error("TOTP 位数无效。");
  if (!Number.isInteger(period) || period < 5 || period > 300) throw new Error("TOTP 周期无效。");
  return { secret, algorithm, digits, period };
}

function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || [...normalized].some((character) => !alphabet.includes(character))) throw new Error("TOTP Base32 密钥无效。");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
