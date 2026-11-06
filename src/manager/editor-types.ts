import type { ApiTokenItem } from '../core/model';
import { tr } from '../i18n';

// Editor switches are narrower than the top-level create catalogue.
export const CREDENTIAL_CREATE_TYPES = ['PASSWORD', 'API_KEY', 'WIFI', 'SSH_KEY', 'BARCODE', 'api-token', 'GPG_KEY'] as const;
export type CredentialCreateType = typeof CREDENTIAL_CREATE_TYPES[number];
export function credentialCreateOptions() {
  return [
    { value: 'PASSWORD', label: tr('密码') }, { value: 'API_KEY', label: 'API Key' },
    { value: 'WIFI', label: 'Wi-Fi' }, { value: 'SSH_KEY', label: tr('SSH 密钥') },
    { value: 'BARCODE', label: tr('条码') }, { value: 'api-token', label: tr('API 令牌') },
    { value: 'GPG_KEY', label: tr('GPG 密钥') }
  ] satisfies { value: CredentialCreateType; label: string }[];
}
// Legacy payment accounts remain readable/editable but have no create action.
export const WALLET_CREATE_TYPES = ['card', 'identity', 'billing-address', 'MEMBERSHIP', 'REWARDS', 'TRAVEL'] as const;
export type WalletCreateType = typeof WALLET_CREATE_TYPES[number];
export function walletCreateOptions() {
  return [
    { value: 'card', label: tr('银行卡') }, { value: 'identity', label: tr('证件') },
    { value: 'billing-address', label: tr('账单地址') }, { value: 'MEMBERSHIP', label: tr('会员卡') },
    { value: 'REWARDS', label: tr('积分卡') }, { value: 'TRAVEL', label: tr('旅行票证') }
  ] satisfies { value: WalletCreateType; label: string }[];
}
export type ApiTokenDraft = Pick<ApiTokenItem, 'title' | 'provider' | 'apiBase' | 'token' | 'notes' | 'favorite' | 'customFields'> & { providerId: string };
