import type { LoginItem } from "../core/model";
import { parseLosslessJson } from "../core/lossless-json";

const inputs: Record<string, string[]> = {
  customIconType: ['customIconType', 'customIconValue'], customIconValue: ['customIconType', 'customIconValue'], customIconUpdatedAt: ['customIconType', 'customIconValue'],
  title: ["name"], username: ["username"], appName: ["appName"], appPackageName: ["appPackageName"], password: ["loginType", "password", "wifiPassword", "barcodeContent"],
  uris: ["uriRules"], uriRules: ["uriRules"], notes: ["notes"], favorite: ["favorite"], loginType: ["loginType"],
  ssoProvider: ["loginType", "ssoProvider"], ssoRefEntryId: ["loginType", "ssoRefEntryId"],
  ssoRefLogicalId: ["loginType", "ssoRefEntryId", "ssoRefLogicalId"],
  totpSecret: ["totpSecret"], boundTotpItemId: ["boundTotpItemId"], passkeyBindings: ["passkeyBindings"],
  passwordGroupId: ["passwordGroupId"], archivedAt: ["archived"],
  customFields: ["customFields", "loginType", "gpgPublicKey", "gpgFingerprint", "gpgUserId", "apiKeyUrl"],
  wifiMetadata: ["loginType", "wifiMetadataRaw", "wifi"], sshKeyData: ["loginType", "sshKeyDataRaw", "sshKey"]
};
for (const key of ["email", "phone", "addressLine", "city", "state", "zipCode", "country", "creditCardNumber", "creditCardHolder", "creditCardExpiry", "creditCardCVV"]) inputs[key] = [key];

/** A display form may fill defaults. Unedited defaults must not overwrite absent/null source fields. */
export function preserveLoginFormSource(original: LoginItem, candidate: LoginItem, beforeJson: string, currentForm: unknown): LoginItem {
  const before = parseLosslessJson(beforeJson) as Record<string, unknown>;
  const current = currentForm as Record<string, unknown>;
  const result = { ...candidate } as LoginItem & Record<string, unknown>;
  const source = original as LoginItem & Record<string, unknown>;
  for (const [key, controls] of Object.entries(inputs)) {
    if (!controls.every(control => JSON.stringify(before[control]) === JSON.stringify(current[control]))) continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key]; else delete result[key];
  }
  return result;
}
