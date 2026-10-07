import { jsonNumber, jsonScalarText } from "./lossless-json";

/** Numbers from existing vaults remain valid; larger counters use decimal text. */
export type OtpCounter = number | string;
export const MAX_OTP_COUNTER = 9223372036854775807n; // Android non-negative Long

export function normalizeOtpCounter(value: unknown = 0): OtpCounter {
  const text = value == null || value === "" ? "0" : jsonScalarText(value);
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("HOTP 计数器已超出安全数字精度，请使用十进制文本。");
  if (!/^\d+$/.test(text)) throw new Error("HOTP 计数器必须是非负 64 位整数。");
  const counter = BigInt(text);
  if (counter > MAX_OTP_COUNTER) throw new Error("HOTP 计数器超出 Android 64 位范围。");
  return counter <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(counter) : counter.toString();
}

export function nextOtpCounter(value: OtpCounter = 0): OtpCounter {
  return normalizeOtpCounter((BigInt(normalizeOtpCounter(value)) + 1n).toString());
}

export function otpCounterJson(value: OtpCounter = 0) {
  return jsonNumber(String(normalizeOtpCounter(value)));
}
