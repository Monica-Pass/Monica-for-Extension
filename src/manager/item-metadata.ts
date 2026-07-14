import type { IdentityItem, VaultItem, VaultItemKind } from "../core/model";

export type VaultManagerSection = "passwords" | "wallet" | "notes" | "passkeys";

const KIND_META: Record<VaultItemKind, { label: string; icon: string; section: VaultManagerSection }> = {
  login: { label: "登录项", icon: "password", section: "passwords" },
  card: { label: "银行卡", icon: "credit_card", section: "wallet" },
  identity: { label: "证件", icon: "badge", section: "wallet" },
  "billing-address": { label: "账单地址", icon: "home_pin", section: "wallet" },
  "payment-account": { label: "支付账号", icon: "account_balance", section: "wallet" },
  "secure-note": { label: "安全笔记", icon: "note", section: "notes" },
  totp: { label: "动态验证码", icon: "timer", section: "notes" },
  passkey: { label: "Passkey", icon: "key_vertical", section: "passkeys" }
};

export function itemKindLabel(kind: VaultItemKind): string { return KIND_META[kind].label; }
export function itemIcon(kind: VaultItemKind): string { return KIND_META[kind].icon; }
export function itemSection(item: VaultItem): VaultManagerSection { return KIND_META[item.kind].section; }

export function itemSafeSummary(item: VaultItem): string {
  switch (item.kind) {
    case "login": return [item.username || "无用户名", item.uris[0]].filter(Boolean).join(" · ");
    case "card": return [item.brand || "银行卡", maskedSuffix(item.number)].filter(Boolean).join(" · ");
    case "identity": return [documentLabel(item.documentType), item.fullName, maskedSuffix(item.documentNumber)].filter(Boolean).join(" · ");
    case "billing-address": return [item.fullName, item.city, item.country].filter(Boolean).join(" · ") || "地址信息";
    case "payment-account": return [item.provider || item.paymentType, item.accountName || item.accountHolderName, maskedSuffix(item.maskedAccountNumber)].filter(Boolean).join(" · ") || "支付账号";
    case "secure-note": return item.content ? `已加密笔记 · ${item.content.length} 字符` : "空笔记";
    case "totp": return [item.issuer, item.accountName].filter(Boolean).join(" · ") || `${item.digits} 位 · ${item.period} 秒`;
    case "passkey": return [item.rpId, item.userName || item.userDisplayName, sourceLabel(item.sourceMode)].filter(Boolean).join(" · ");
  }
}

export function itemSearchText(item: VaultItem): string {
  const common = `${item.title} ${item.notes} ${itemKindLabel(item.kind)} ${itemSafeSummary(item)}`;
  switch (item.kind) {
    case "login": return `${common} ${item.username} ${item.uris.join(" ")}`;
    case "card": return `${common} ${item.cardholderName} ${item.brand || ""}`;
    case "identity": return `${common} ${item.firstName} ${item.middleName} ${item.lastName} ${item.email || ""} ${item.phone || ""}`;
    case "billing-address": return `${common} ${item.company} ${item.streetAddress} ${item.postalCode} ${item.email}`;
    case "payment-account": return `${common} ${item.paymentType} ${item.provider} ${item.accountHolderName} ${item.email} ${item.iban} ${item.swiftBic}`;
    case "secure-note": return `${common} ${item.content}`;
    case "totp": return `${common} ${item.issuer || ""} ${item.accountName || ""}`;
    case "passkey": return `${common} ${item.rpName} ${item.rpId} ${item.userDisplayName}`;
  }
}

export function sourceLabel(sourceMode: "browser-local" | "bitwarden" | "android-metadata-only"): string {
  return sourceMode === "browser-local" ? "浏览器本地" : sourceMode === "bitwarden" ? "Bitwarden" : "Android 元数据";
}

function maskedSuffix(value: string): string {
  const suffix = value.replace(/\s+/g, "").slice(-4);
  return suffix ? `•••• ${suffix}` : "";
}

function documentLabel(type: IdentityItem["documentType"]): string {
  return ({ ID_CARD: "身份证", PASSPORT: "护照", DRIVER_LICENSE: "驾驶证", SOCIAL_SECURITY: "社会保障号", OTHER: "其他证件" } as const)[type];
}
