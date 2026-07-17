const STEAM_CODE_CHARS = "23456789BCDFGHJKMNPQRTVWXY";

/** Generate the 5-character Steam Guard code used by Monica Android. */
export async function generateSteamCode(sharedSecretBase64: string, now = Date.now()): Promise<string> {
  const secret = sharedSecretBase64.trim();
  if (!secret) throw new Error("Steam Shared Secret 为空。");
  const key = decodeBase64(secret);
  const counter = Math.floor(now / 1000 / 30);
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, message));
  const offset = digest[digest.length - 1] & 0x0f;
  let value = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += STEAM_CODE_CHARS[value % STEAM_CODE_CHARS.length];
    value = Math.floor(value / STEAM_CODE_CHARS.length);
  }
  return code;
}

export function steamSecondsRemaining(now = Date.now()): number {
  const elapsed = Math.floor(now / 1000) % 30;
  return 30 - elapsed;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (typeof atob === "function") {
    try {
      const binary = atob(normalized);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
      throw new Error("Steam Shared Secret 不是有效的 Base64。");
    }
  }
  throw new Error("当前环境不支持 Base64 解码。");
}
