import { tr } from '../i18n';
import type { IdentityItem, LoginItem, VaultItem, VaultItemKind } from "../core/model";
import { parseSshKeyMetadata, parseWifiMetadata } from "../core/special-login";

export type VaultManagerSection = "passwords" | "wallet" | "notes" | "totp" | "passkeys";

const KIND_META: Record<VaultItemKind, { label: string; icon: string; section: VaultManagerSection }> = {
  login: { get label() { return tr('登录项'); }, icon: "password", section: "passwords" },
  card: { get label() { return tr('银行卡'); }, icon: "credit_card", section: "wallet" },
  identity: { get label() { return tr('证件'); }, icon: "badge", section: "wallet" },
  "billing-address": { get label() { return tr('账单地址'); }, icon: "home_pin", section: "wallet" },
  "payment-account": { get label() { return tr('支付账号'); }, icon: "account_balance", section: "wallet" },
  "secure-note": { get label() { return tr('安全笔记'); }, icon: "note", section: "notes" },
  totp: { get label() { return tr('动态验证码'); }, icon: "timer", section: "totp" },
  passkey: { label: "Passkey", icon: "key_vertical", section: "passkeys" }
};

export function itemKindLabel(kind: VaultItemKind): string { return KIND_META[kind].label; }
export function itemIcon(kind: VaultItemKind): string { return KIND_META[kind].icon; }
export function itemSection(item: VaultItem): VaultManagerSection { return KIND_META[item.kind].section; }
export function itemKindSection(kind: VaultItemKind): VaultManagerSection { return KIND_META[kind].section; }

/** Home cards never render a login URI: imported otpauth URLs can contain secrets. */
export function homeItemSummary(item: VaultItem): string {
  return item.kind === "login" ? item.username.trim() || itemKindLabel(item.kind) : itemSafeSummary(item);
}

export function itemSafeSummary(item: VaultItem): string {
  switch (item.kind) {
    case "login": return loginSafeSummary(item);
    case "card": return [item.brand || tr('银行卡'), maskedSuffix(item.number)].filter(Boolean).join(" · ");
    case "identity": return [documentLabel(item.documentType), item.fullName, maskedSuffix(item.documentNumber)].filter(Boolean).join(" · ");
    case "billing-address": return [item.fullName, item.city, item.country].filter(Boolean).join(" · ") || tr('地址信息');
    case "payment-account": return [item.provider || item.paymentType, item.accountName || item.accountHolderName, maskedSuffix(item.maskedAccountNumber)].filter(Boolean).join(" · ") || tr('支付账号');
    case "secure-note": return item.content ? tr('已加密笔记 · {0} 字符', { 0: item.content.length }) : tr('空笔记');
    case "totp": return [item.otpType === "STEAM" ? "Steam Guard" : item.issuer, item.accountName].filter(Boolean).join(" · ") || tr('{0} 位 · {1} 秒', { 0: item.digits, 1: item.period });
    case "passkey": return [item.rpId, item.userName || item.userDisplayName, sourceLabel(item.sourceMode)].filter(Boolean).join(" · ");
  }
}

export function itemSearchText(item: VaultItem): string {
  const common = `${item.title} ${item.notes} ${itemKindLabel(item.kind)} ${itemSafeSummary(item)}`;
  switch (item.kind) {
    case "login": return `${common} ${item.username} ${item.uris.join(" ")} ${loginSearchMetadata(item)}`;
    case "card": return `${common} ${item.cardholderName} ${item.brand || ""}`;
    case "identity": return `${common} ${item.firstName} ${item.middleName} ${item.lastName} ${item.email || ""} ${item.phone || ""}`;
    case "billing-address": return `${common} ${item.company} ${item.streetAddress} ${item.postalCode} ${item.email}`;
    case "payment-account": return `${common} ${item.paymentType} ${item.provider} ${item.accountHolderName} ${item.email} ${item.iban} ${item.swiftBic}`;
    case "secure-note": return `${common} ${item.content}`;
    case "totp": return `${common} ${item.issuer || ""} ${item.accountName || ""}`;
    case "passkey": return `${common} ${item.rpName} ${item.rpId} ${item.userDisplayName}`;
  }
}

function loginSafeSummary(item: LoginItem): string {
  if (item.loginType === "WIFI") {
    const wifi = parseWifiMetadata(item.wifiMetadata);
    return [wifi.ssid || item.title, wifi.security].filter(Boolean).join(" · ");
  }
  if (item.loginType === "SSH_KEY") {
    const ssh = parseSshKeyMetadata(item.sshKeyData);
    return [ssh.algorithm || "SSH", ssh.fingerprintSha256 || tr('密钥内容已加密')].join(" · ");
  }
  if (item.loginType === "BARCODE") return tr('条码内容已加密');
  if (item.loginType === "SSO") return [item.ssoProvider || "SSO", item.username || tr('无用户名')].join(" · ");
  return [item.username || tr('无用户名'), item.uris[0]].filter(Boolean).join(" · ");
}

function loginSearchMetadata(item: LoginItem): string {
  if (item.loginType === "WIFI") {
    const wifi = parseWifiMetadata(item.wifiMetadata);
    return `${wifi.ssid} ${wifi.security} ${wifi.bssid}`;
  }
  if (item.loginType === "SSH_KEY") {
    const ssh = parseSshKeyMetadata(item.sshKeyData);
    return `${ssh.algorithm} ${ssh.fingerprintSha256} ${ssh.comment}`;
  }
  return item.loginType === "SSO" ? `${item.ssoProvider || ""}` : "";
}

export function sourceLabel(sourceMode: "browser-local" | "bitwarden" | "android-metadata-only"): string {
  return sourceMode === "browser-local" ? tr('浏览器本地') : sourceMode === "bitwarden" ? "Bitwarden" : tr('Android 元数据');
}

function maskedSuffix(value: string): string {
  const suffix = value.replace(/\s+/g, "").slice(-4);
  return suffix ? `•••• ${suffix}` : "";
}

function documentLabel(type: IdentityItem["documentType"]): string {
  return ({ ID_CARD: tr('身份证'), PASSPORT: tr('护照'), DRIVER_LICENSE: tr('驾驶证'), SOCIAL_SECURITY: tr('社会保障号'), OTHER: tr('其他证件') } as const)[type];
}
