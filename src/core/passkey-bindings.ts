import { parseLosslessJson } from "./lossless-json";

export const PASSKEY_BINDING_FIELDS = ["credentialId", "rpId", "rpName", "userName", "userDisplayName"] as const;
export type PasskeyBindingField = typeof PASSKEY_BINDING_FIELDS[number];
export type PasskeyBinding = Partial<Record<PasskeyBindingField, string>> & Record<string, unknown>;

/** Binding metadata is not a signing credential. Never derive a private key or capability from it. */
export function readPasskeyBindings(raw: string): PasskeyBinding[] {
  if (!raw.trim()) return [];
  const value = parseLosslessJson(raw);
  if (!Array.isArray(value) || value.length > 1000) throw new Error("Passkey 绑定列表格式不受支持，原数据保持不变。");
  for (const binding of value) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding) || PASSKEY_BINDING_FIELDS.some(field => field in binding && typeof binding[field] !== "string")) throw new Error("Passkey 绑定字段格式不受支持，原数据保持不变。");
  }
  return value;
}

export function patchPasskeyBinding(raw: string, index: number, patch: Partial<Record<PasskeyBindingField, string>>): string {
  const bindings = readPasskeyBindings(raw);
  if (!Number.isInteger(index) || index < 0 || index >= bindings.length) throw new Error("Passkey 绑定已变化，请重新打开。");
  if (Object.keys(patch).some(key => !PASSKEY_BINDING_FIELDS.includes(key as PasskeyBindingField)) || Object.values(patch).some(value => typeof value !== "string")) throw new Error("不能修改未知绑定字段。");
  const original = bindings[index];
  if (Object.entries(patch).every(([key, value]) => value === (original[key] ?? ""))) return raw;
  bindings[index] = { ...original, ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => value !== (original[key] ?? ""))) };
  return JSON.stringify(bindings);
}

export function addPasskeyBinding(raw: string): string {
  return JSON.stringify([...readPasskeyBindings(raw), Object.fromEntries(PASSKEY_BINDING_FIELDS.map(field => [field, ""]))]);
}
export function removePasskeyBinding(raw: string, index: number): string {
  const bindings = readPasskeyBindings(raw);
  if (!Number.isInteger(index) || index < 0 || index >= bindings.length) throw new Error("Passkey 绑定已变化，请重新打开。");
  return JSON.stringify(bindings.filter((_, candidate) => candidate !== index));
}
