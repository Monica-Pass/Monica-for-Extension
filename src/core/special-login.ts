export interface WifiMetadata {
  ssid: string;
  hiddenNetwork: boolean;
  security: "NONE" | "WEP" | "WPA_WPA2" | "WPA2_WPA3" | "WPA3" | "WPA2_ENTERPRISE" | "WPA3_ENTERPRISE";
  bssid: string;
  eap?: Record<string, unknown> | null;
  macRandomization?: string;
  proxy?: Record<string, unknown>;
  ip?: Record<string, unknown>;
}

export interface SshKeyMetadata {
  algorithm: string;
  keySize: number;
  publicKeyOpenSsh: string;
  privateKeyOpenSsh: string;
  fingerprintSha256: string;
  comment: string;
  format: string;
}

const WIFI_SECURITIES = new Set<WifiMetadata["security"]>(["NONE", "WEP", "WPA_WPA2", "WPA2_WPA3", "WPA3", "WPA2_ENTERPRISE", "WPA3_ENTERPRISE"]);

export function parseWifiMetadata(raw: string | undefined): WifiMetadata {
  const source = parseObject(raw);
  const security = String(source.security || "WPA2_WPA3").toUpperCase() as WifiMetadata["security"];
  return {
    ssid: string(source.ssid),
    hiddenNetwork: Boolean(source.hiddenNetwork),
    security: WIFI_SECURITIES.has(security) ? security : "WPA2_WPA3",
    bssid: string(source.bssid),
    eap: objectOrNull(source.eap),
    macRandomization: optional(source.macRandomization),
    proxy: objectOrUndefined(source.proxy),
    ip: objectOrUndefined(source.ip)
  };
}

export function serializeWifiMetadata(original: string | undefined, value: WifiMetadata): string {
  const source = parseObject(original);
  if (original && sameWifiMetadata(parseWifiMetadata(original), value)) return original;
  const output: Record<string, unknown> = {
    ...source,
    ssid: value.ssid.trim(),
    hiddenNetwork: value.hiddenNetwork,
    security: value.security
  };
  assignOptional(output, "bssid", value.bssid.trim());
  assignOptional(output, "eap", value.eap);
  assignOptional(output, "macRandomization", value.macRandomization);
  assignOptional(output, "proxy", value.proxy);
  assignOptional(output, "ip", value.ip);
  return JSON.stringify(output);
}

export function buildWifiQrPayload(value: WifiMetadata, password: string, identity = ""): string {
  const security = value.security === "NONE" ? "nopass" : value.security === "WEP" ? "WEP" : value.security.includes("ENTERPRISE") ? "WPA2-EAP" : "WPA";
  const fields = [`T:${security}`, `S:${escapeWifi(value.ssid)}`];
  if (password) fields.push(`P:${escapeWifi(password)}`);
  if (identity) fields.push(`I:${escapeWifi(identity)}`);
  if (value.hiddenNetwork) fields.push("H:true");
  return `WIFI:${fields.join(";")};;`;
}

export function parseSshKeyMetadata(raw: string | undefined): SshKeyMetadata {
  const source = parseObject(raw);
  return {
    algorithm: string(source.algorithm),
    keySize: safeInteger(source.keySize),
    publicKeyOpenSsh: string(source.publicKeyOpenSsh),
    privateKeyOpenSsh: string(source.privateKeyOpenSsh),
    fingerprintSha256: string(source.fingerprintSha256),
    comment: string(source.comment),
    format: string(source.format) || "OPENSSH"
  };
}

export function serializeSshKeyMetadata(original: string | undefined, value: SshKeyMetadata): string {
  const source = parseObject(original);
  if (![value.algorithm, value.publicKeyOpenSsh, value.privateKeyOpenSsh, value.fingerprintSha256].some((field) => field.trim())) return "";
  if (original && sameSshKeyMetadata(parseSshKeyMetadata(original), value)) return original;
  return JSON.stringify({
    ...source,
    algorithm: value.algorithm.trim(),
    keySize: safeInteger(value.keySize),
    publicKeyOpenSsh: value.publicKeyOpenSsh.trim(),
    privateKeyOpenSsh: value.privateKeyOpenSsh.trim(),
    fingerprintSha256: value.fingerprintSha256.trim(),
    comment: value.comment.trim(),
    format: value.format.trim() || "OPENSSH"
  });
}

function parseObject(raw: string | undefined): Record<string, unknown> {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null | undefined {
  return value == null ? (value as null | undefined) : objectOrUndefined(value) || {};
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function assignOptional(output: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === "" || (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)) delete output[key];
  else output[key] = value;
}

function sameWifiMetadata(left: WifiMetadata, right: WifiMetadata): boolean {
  return left.ssid === right.ssid.trim()
    && left.hiddenNetwork === right.hiddenNetwork
    && left.security === right.security
    && left.bssid === right.bssid.trim()
    && structuredEqual(left.eap, right.eap)
    && left.macRandomization === optional(right.macRandomization)
    && structuredEqual(left.proxy, right.proxy)
    && structuredEqual(left.ip, right.ip);
}

function sameSshKeyMetadata(left: SshKeyMetadata, right: SshKeyMetadata): boolean {
  return left.algorithm === right.algorithm.trim()
    && left.keySize === safeInteger(right.keySize)
    && left.publicKeyOpenSsh === right.publicKeyOpenSsh.trim()
    && left.privateKeyOpenSsh === right.privateKeyOpenSsh.trim()
    && left.fingerprintSha256 === right.fingerprintSha256.trim()
    && left.comment === right.comment.trim()
    && left.format === (right.format.trim() || "OPENSSH");
}

function structuredEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function string(value: unknown): string { return typeof value === "string" ? value : value == null ? "" : String(value); }
function optional(value: unknown): string | undefined { return string(value).trim() || undefined; }
function safeInteger(value: unknown): number { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }
function escapeWifi(value: string): string { return value.replace(/([\\;,:"])/g, "\\$1"); }
