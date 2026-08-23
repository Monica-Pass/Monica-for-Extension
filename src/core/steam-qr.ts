const MAX_QR_PAYLOAD_LENGTH = 4096;
const SIGNED_LONG_MAX = 0x7fffffffffffffffn;
const UNSIGNED_LONG_BASE = 0x10000000000000000n;
const UNSIGNED_LONG_MAX = UNSIGNED_LONG_BASE - 1n;
const ALLOWED_HOSTS = new Set(["s.team", "steamcommunity.com", "www.steamcommunity.com"]);
const URL_PATTERN = /(?:https?:\/\/|steam:\/\/)\S+/gi;
const STEAM_OPEN_URL_PATTERN = /^steam:\/\/openurl\/(.+)$/i;

export interface SteamQrChallenge {
  version: number;
  clientId: number;
}

/** Parse the same Steam login-approval QR payload accepted by Monica Android. */
export function parseSteamQrChallenge(raw: string): SteamQrChallenge | undefined {
  const normalized = raw.trim();
  if (!normalized || normalized.length > MAX_QR_PAYLOAD_LENGTH) return undefined;
  const candidates = parseCandidates(normalized);
  for (const candidate of candidates) {
    for (const decoded of [candidate, decodeUrlComponent(candidate)]) {
      const parsed = parseCandidate(decoded);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

function parseCandidates(raw: string): string[] {
  const trimmed = trimPayload(raw);
  const urls = [...trimmed.matchAll(URL_PATTERN)].map((match) => trimPayload(match[0]));
  const values = [trimmed, ...urls];
  for (const value of [...values]) {
    const match = value.match(STEAM_OPEN_URL_PATTERN);
    if (match) values.push(trimPayload(decodeUrlComponent(match[1])));
  }
  return [...new Set(values)];
}

function parseCandidate(value: string): SteamQrChallenge | undefined {
  let uri: URL;
  try { uri = new URL(trimPayload(value)); } catch { return undefined; }
  if (uri.protocol !== "https:" || !ALLOWED_HOSTS.has(uri.hostname.toLowerCase())) return undefined;
  const segments = uri.pathname.split("/").filter(Boolean);
  const index = segments.indexOf("q");
  if (index < 0 || segments.length < index + 3) return undefined;
  const version = Number(segments[index + 1]);
  if (!Number.isInteger(version) || version < 0 || String(version) !== segments[index + 1]) return undefined;
  const idText = segments[index + 2];
  if (!/^\d+$/.test(idText)) return undefined;
  let unsigned: bigint;
  try { unsigned = BigInt(idText); } catch { return undefined; }
  if (unsigned <= 0n || unsigned > UNSIGNED_LONG_MAX) return undefined;
  const clientId = unsigned <= SIGNED_LONG_MAX ? Number(unsigned) : Number(unsigned - UNSIGNED_LONG_BASE);
  if (!Number.isSafeInteger(clientId) && clientId !== -1) return undefined;
  return { version, clientId };
}

function decodeUrlComponent(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, "%2B")); } catch { return value; }
}

function trimPayload(value: string): string {
  return value.trim().replace(/^["'`<>()\[\]{}]+|["'`<>()\[\]{},.;]+$/g, "").trim();
}
