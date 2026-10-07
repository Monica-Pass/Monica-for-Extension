import { parseLosslessJson } from "./lossless-json";

// Android SecureItemModels.kt::BillingAddress, not the richer standalone BillingAddressData.
export const BILLING_ADDRESS_FIELDS = {
  streetAddress: "街道地址", apartment: "公寓/单元", city: "城市",
  stateProvince: "省/州", postalCode: "邮编", country: "国家/地区"
} as const;
export type BillingAddressField = keyof typeof BILLING_ADDRESS_FIELDS;

function source(value: string): Record<string, unknown> {
  const parsed = value.trim() ? parseLosslessJson(value) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error("账单地址格式暂不支持结构化编辑。");
  const data = parsed as Record<string, unknown>;
  for (const key of Object.keys(BILLING_ADDRESS_FIELDS)) if (data[key] != null && typeof data[key] !== "string") throw new Error("账单地址字段格式暂不支持结构化编辑。");
  return data;
}

export function readBillingAddress(value: string): { editable: boolean; fields: Record<BillingAddressField, string> } {
  const fields = Object.fromEntries(Object.keys(BILLING_ADDRESS_FIELDS).map(key => [key, ""])) as Record<BillingAddressField, string>;
  try {
    const data = source(value);
    for (const key of Object.keys(fields) as BillingAddressField[]) fields[key] = typeof data[key] === "string" ? data[key] as string : "";
    return { editable: true, fields };
  } catch { return { editable: false, fields }; }
}

export function editBillingAddressField(value: string, field: BillingAddressField, next: string): string {
  if (!Object.prototype.hasOwnProperty.call(BILLING_ADDRESS_FIELDS, field) || typeof next !== "string") throw new Error("账单地址字段无效。");
  const data = source(value);
  if ((data[field] ?? "") === next) return value;
  return JSON.stringify({ ...data, [field]: next });
}
