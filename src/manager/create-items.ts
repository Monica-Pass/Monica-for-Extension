import { tr } from "../i18n";

export type CreateItemType = "PASSWORD" | "WIFI" | "SSH_KEY" | "GPG_KEY" | "API_KEY" | "BARCODE" | "api-token" | "totp" | "secure-note" | "card" | "identity" | "billing-address" | "payment-account";

// Both the full chooser and the split menu use this catalogue. Passkeys are
// created by a website's WebAuthn request, so they have no manual create action.
export function createItemGroups() {
  return [
    { label: tr('账号与安全'), items: [
      { kind: "PASSWORD", icon: "password", label: tr('密码'), description: tr('网站与应用账号') },
      { kind: "API_KEY", icon: "key", label: "API Key", description: "服务商 Key 与地址" },
      { kind: "api-token", icon: "key", label: "API Token", description: "原生访问令牌与元数据" },
      { kind: "totp", icon: "timer", label: tr('动态验证码'), description: tr('TOTP、HOTP 与其他验证器') },
      { kind: "WIFI", icon: "wifi", label: "Wi-Fi", description: tr('网络密码与连接配置') },
      { kind: "SSH_KEY", icon: "terminal", label: tr('SSH 密钥'), description: tr('公钥、私钥与指纹') },
      { kind: "GPG_KEY", icon: "key", label: "GPG 密钥", description: "公钥、私钥与用户身份" },
      { kind: "secure-note", icon: "note", label: tr('安全笔记'), description: tr('需要加密保存的文字') }
    ] },
    { label: tr('钱包与其他'), items: [
      { kind: "card", icon: "credit_card", label: tr('银行卡'), description: tr('卡号与账单信息') },
      { kind: "identity", icon: "badge", label: tr('证件'), description: tr('身份信息与证件号码') },
      { kind: "billing-address", icon: "home_pin", label: tr('账单地址'), description: tr('收件人与联系方式') },
      { kind: "payment-account", icon: "account_balance", label: tr('支付账号'), description: tr('付款账户与银行信息') },
      { kind: "BARCODE", icon: "qr_code_2", label: tr('条码'), description: tr('二维码与条形码内容') }
    ] }
  ] satisfies { label: string; items: { kind: CreateItemType; icon: string; label: string; description: string }[] }[];
}
