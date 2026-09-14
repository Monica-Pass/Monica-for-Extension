import type { LoginItem, LoginUriRule, SecureCustomField } from "../core/model";
import type { SshKeyMetadata, WifiMetadata } from "../core/special-login";

export interface LoginForm {
  name: string;
  username: string;
  password: string;
  wifiPassword: string;
  barcodeContent: string;
  notes: string;
  favorite: boolean;
  archived: boolean;
  allowLockedAutofill: boolean;
  providerId: string;
  loginType: NonNullable<LoginItem["loginType"]>;
  ssoProvider: string;
  ssoRefEntryId: string;
  totpSecret: string;
  boundTotpItemId: string;
  uriRules: LoginUriRule[];
  customFields: SecureCustomField[];
  wifiMetadataRaw: string;
  wifi: WifiMetadata;
  sshKeyDataRaw: string;
  sshKey: SshKeyMetadata;
}
