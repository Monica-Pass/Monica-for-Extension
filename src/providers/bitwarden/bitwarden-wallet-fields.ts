import type { CardFaceConfig, CardItem, IdentityItem, SecureCustomField } from "../../core/model";
import { parseLosslessJson } from "../../core/lossless-json";

/** Names emitted by Android CipherUploadProcessor, not Room property names. */
export const CARD_FIELD_NAMES = {
  bankName: ["Bank Name", "monica_bank_name"], cardType: ["Card Type", "monica_card_type"],
  billingAddress: ["Billing Address", "monica_billing_address"], nickname: ["Nickname", "monica_nickname"],
  validFromMonth: ["Valid From Month", "monica_valid_from_month"], validFromYear: ["Valid From Year", "monica_valid_from_year"],
  pin: ["PIN", "monica_pin"], iban: ["IBAN", "monica_iban"], swiftBic: ["SWIFT/BIC", "monica_swift_bic"],
  routingNumber: ["Routing Number", "monica_routing_number"], accountNumber: ["Account Number", "monica_account_number"],
  branchCode: ["Branch Code", "monica_branch_code"], currency: ["Currency", "monica_currency"],
  customerServicePhone: ["Customer Service Phone", "monica_customer_service_phone"]
} as const;
export const DOCUMENT_FIELD_NAMES = {
  documentType: ["monica_document_type"], issuedDate: ["monica_issue_date"], expiryDate: ["monica_expiry_date"],
  issuedBy: ["monica_issued_by"], nationality: ["monica_nationality"], additionalInfo: ["monica_additional_info"]
} as const;
const CARD_FACE_NAMES = ["Monica Card Face", "monica_card_face"];
export type WalletItem = CardItem | IdentityItem;
type PlainField = { name: string; value: string; type: number; linked: boolean; readable?: boolean };

export function walletManagedNames(kind: WalletItem["kind"]): Set<string> {
  return new Set([...Object.values(kind === "card" ? CARD_FIELD_NAMES : DOCUMENT_FIELD_NAMES).flat(), ...CARD_FACE_NAMES].map((name) => name.toLowerCase()));
}

export function walletFieldsToItem(kind: WalletItem["kind"], fields: PlainField[]): Partial<WalletItem> {
  const result: Record<string, unknown> = {};
  const names = kind === "card" ? CARD_FIELD_NAMES : DOCUMENT_FIELD_NAMES;
  for (const [property, aliases] of Object.entries(names)) {
    const field = aliases.map((name: string) => fields.find((field) => field.name.toLowerCase() === name.toLowerCase() && field.readable !== false && !field.linked)).find(Boolean);
    if (field) result[property] = field.value;
  }
  if (kind === "card" && result.cardType && !["CREDIT", "DEBIT", "PREPAID"].includes(String(result.cardType))) delete result.cardType;
  if (kind === "identity" && result.documentType && !["ID_CARD", "PASSPORT", "DRIVER_LICENSE", "SOCIAL_SECURITY", "OTHER"].includes(String(result.documentType))) delete result.documentType;
  const faceField = fields.find((field) => CARD_FACE_NAMES.includes(field.name) && field.readable !== false && !field.linked);
  if (faceField) {
    const face = parseFace(faceField.value);
    if (face) result.cardFace = { imageAttachmentName: face.imageAttachmentName, displayMode: face.displayMode || "ALL", showBrandIcon: face.showBrandIcon ?? true };
    else if (faceField.value === "null") result.cardFace = null;
  }
  const managed = walletManagedNames(kind);
  result.customFields = fields.filter((field) => field.name && !field.linked && field.readable !== false && [0, 1, 2].includes(field.type) && !managed.has(field.name.toLowerCase())).map((field): SecureCustomField => ({ name: field.name, value: field.value, protected: field.type === 1, fieldType: field.type === 2 ? "BOOLEAN" : field.type === 1 ? "HIDDEN" : "TEXT" }));
  return result;
}

export function walletItemToFields(item: WalletItem, original: PlainField[]): SecureCustomField[] {
  const names = item.kind === "card" ? CARD_FIELD_NAMES : DOCUMENT_FIELD_NAMES;
  const output: SecureCustomField[] = [];
  for (const [property, aliases] of Object.entries(names)) {
    const value = (item as unknown as Record<string, unknown>)[property];
    const source = aliases.map((name: string) => original.find((field) => field.readable !== false && !field.linked && field.name.toLowerCase() === name.toLowerCase())).find(Boolean);
    if (typeof value === "string") output.push({ name: source?.name || aliases[0], value, protected: source?.type === 1 });
  }
  if (item.cardFace !== undefined) {
    const originalField = original.find((field) => CARD_FACE_NAMES.includes(field.name));
    const raw = originalField ? parseFace(originalField.value) : undefined;
    const face = item.cardFace === null ? null : { ...raw, ...item.cardFace };
    const unchanged = raw && item.cardFace && raw.imageAttachmentName === item.cardFace.imageAttachmentName && (raw.displayMode || "ALL") === item.cardFace.displayMode && (raw.showBrandIcon ?? true) === item.cardFace.showBrandIcon;
    output.push({ name: originalField?.name || CARD_FACE_NAMES[0], value: unchanged ? originalField!.value : JSON.stringify(face), protected: originalField?.type === 1 });
  }
  const managed = walletManagedNames(item.kind);
  output.push(...(item.customFields || []).filter((field) => !managed.has(field.name.toLowerCase())));
  return output;
}

function parseFace(text: string): CardFaceConfig | undefined {
  try {
    const parsed = parseLosslessJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = parsed as CardFaceConfig;
    return typeof value.imageAttachmentName === "string" && (value.displayMode === undefined || ["ALL", "CARD_NUMBER_ONLY", "HIDDEN"].includes(value.displayMode)) && (value.showBrandIcon === undefined || typeof value.showBrandIcon === "boolean") ? value : undefined;
  } catch { return undefined; }
}
