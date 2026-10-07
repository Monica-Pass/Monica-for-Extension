import type { WifiMetadata } from "./special-login";

export const wifiProxyKinds = ["None", "Manual", "AutoConfig"] as const;
export const wifiIpKinds = ["Dhcp", "Static"] as const;
export const wifiEapMethods = ["PEAP", "TLS", "TTLS", "PWD", "SIM", "AKA", "AKA_PRIME"];
export const wifiPhase2Methods = ["NONE", "PAP", "MSCHAP", "MSCHAPV2", "GTC", "SIM", "AKA", "AKA_PRIME"];
export function wifiSettingKind(value: Record<string, unknown> | undefined, type: "proxy" | "ip"): string {
  if (value?.kind == null) return type === "proxy" ? "None" : "Dhcp";
  const raw = String(value.kind);
  const prefix = `takagi.ru.monica.data.model.${type === "proxy" ? "WifiProxy" : "WifiIp"}.`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}
export function changeWifiSettingKind(wifi: WifiMetadata, type: "proxy" | "ip", kind: string): void {
  const allowed: readonly string[] = type === "proxy" ? wifiProxyKinds : wifiIpKinds;
  if (!allowed.includes(kind)) throw new Error("Unsupported Wi-Fi setting kind");
  const prior = wifi[type];
  if (wifiSettingKind(prior, type) === kind) return;
  const next = { ...prior };
  for (const key of type === "proxy" ? ["host", "port", "bypassList", "pacUrl"] : ["ipAddress", "gateway", "networkPrefixLength", "dns1", "dns2"]) delete next[key];
  next.kind = `takagi.ru.monica.data.model.${type === "proxy" ? "WifiProxy" : "WifiIp"}.${kind}`;
  wifi[type] = next;
}

export function wifiAdvancedDetailFields(wifi: WifiMetadata): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => { if (value != null && value !== "") rows.push({ label, value: String(value) }); };
  if (wifi.eap) {
    add("EAP 方法", wifi.eap.method ?? "PEAP"); add("第二阶段认证", wifi.eap.phase2 ?? "MSCHAPV2");
    add("匿名身份", wifi.eap.anonymousIdentity); add("CA 证书", wifi.eap.caCertificate); add("域名", wifi.eap.domain);
  }
  add("MAC 随机化", wifi.macRandomization ?? "DEFAULT");
  const proxy = wifiSettingKind(wifi.proxy, "proxy"), ip = wifiSettingKind(wifi.ip, "ip");
  add("代理设置", proxy);
  if (proxy === "Manual") { add("代理主机", wifi.proxy?.host); add("代理端口", wifi.proxy?.port ?? 0); add("绕过代理的地址", wifi.proxy?.bypassList); }
  if (proxy === "AutoConfig") add("PAC 地址", wifi.proxy?.pacUrl);
  add("IP 设置", ip);
  if (ip === "Static") { add("IP 地址", wifi.ip?.ipAddress); add("网关", wifi.ip?.gateway); add("网络前缀长度", wifi.ip?.networkPrefixLength ?? 24); add("DNS 1", wifi.ip?.dns1); add("DNS 2", wifi.ip?.dns2); }
  return rows;
}
