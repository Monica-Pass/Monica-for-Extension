import type { SecureCustomField } from "./model";
import { isPasswordStackMetadata } from "./password-manual-stacks";

const GPG_PREFIX = "monica_gpg_public_";
const GPG_ENCODING = "monica_gpg_encoding";
const GPG_MAX_BYTES = 1024 * 1024;
export interface GpgPublicFields { publicKey: string; fingerprint: string; userId: string }
export function isCredentialMetadata(name: string): boolean {
  return name.startsWith("monica_gpg_") || name === "monica_api_key_type" || name === "monica_api_key_url" || isPasswordStackMetadata(name);
}
function single(fields: SecureCustomField[], name: string): string | undefined {
  const matches = fields.filter(field => field.name === name);
  if (matches.length > 1) throw new Error("凭据字段重复，保留原件且不覆盖。");
  return matches[0]?.value;
}
export function readGpgFields(fields: SecureCustomField[]): GpgPublicFields {
  const chunks = fields.filter(field => field.name.startsWith(GPG_PREFIX)).sort((a, b) => a.name.localeCompare(b.name));
  if (!chunks.length || chunks.some((field, index) => field.name !== GPG_PREFIX + String(index).padStart(4, "0"))) throw new Error("GPG 公钥分段缺失或重复。");
  const encoding = single(fields, GPG_ENCODING);
  const stored = chunks.map(field => field.value).join("");
  if (stored.length > Math.ceil(GPG_MAX_BYTES / 3) * 4) throw new Error("GPG 公钥超过 1 MiB。");
  let bytes: Uint8Array;
  if (encoding === "base64") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(stored)) throw new Error("GPG 编码无效。");
    bytes = Uint8Array.from(atob(stored), char => char.charCodeAt(0));
  } else if (encoding === undefined) bytes = new TextEncoder().encode(stored);
  else throw new Error("GPG 编码版本不受支持。");
  if (bytes.length > GPG_MAX_BYTES) throw new Error("GPG 公钥超过 1 MiB。");
  return { publicKey: new TextDecoder("utf-8", { fatal: true }).decode(bytes), fingerprint: single(fields, "monica_gpg_fingerprint") || "", userId: single(fields, "monica_gpg_user_id") || "" };
}
export function putGpgFields(fields: SecureCustomField[], value: GpgPublicFields): SecureCustomField[] {
  for (const name of ["monica_gpg_type", "monica_gpg_fingerprint", "monica_gpg_user_id", GPG_ENCODING]) single(fields, name);
  const existing = fields.some(field => field.name.startsWith(GPG_PREFIX));
  const original = existing ? readGpgFields(fields) : undefined;
  if (original && JSON.stringify(original) === JSON.stringify(value)) return fields;
  const updates = new Map([["monica_gpg_type", "GPG_KEY"], ["monica_gpg_fingerprint", value.fingerprint], ["monica_gpg_user_id", value.userId]]);
  const replacePublicKey = !original || original.publicKey !== value.publicKey;
  if (replacePublicKey) {
    const bytes = new TextEncoder().encode(value.publicKey);
    if (!bytes.length || bytes.length > GPG_MAX_BYTES) throw new Error("请填写不超过 1 MiB 的 GPG 公钥。");
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    updates.set(GPG_ENCODING, "base64");
    btoa(binary).match(/.{1,2000}/g)!.forEach((chunk, index) => updates.set(GPG_PREFIX + String(index).padStart(4, "0"), chunk));
  }
  // A metadata edit leaves the original encoding and chunk boundaries intact.
  // Existing fields retain their position and attributes, including protection.
  const result: SecureCustomField[] = [];
  for (const field of fields) {
    if (updates.has(field.name)) {
      const content = updates.get(field.name)!;
      updates.delete(field.name);
      result.push(content === field.value ? field : { ...field, value: content });
    } else if (!replacePublicKey || !field.name.startsWith(GPG_PREFIX)) result.push(field);
  }
  const protectNewChunks = fields.some(field => field.name.startsWith(GPG_PREFIX) && field.protected);
  for (const [name, content] of updates) {
    if (original && content === "" && (name === "monica_gpg_fingerprint" || name === "monica_gpg_user_id")) continue;
    result.push({ name, value: content, protected: name.startsWith(GPG_PREFIX) && protectNewChunks });
  }
  return result;
}
export function putApiKeyFields(fields: SecureCustomField[], endpoint: string): SecureCustomField[] {
  // Android ApiKeyEntryFields stores arbitrary address text. URL validation
  // belongs to navigation, never to saving or renaming a credential.
  single(fields, "monica_api_key_type"); single(fields, "monica_api_key_url");
  const updates = new Map([["monica_api_key_type", "API_KEY"], ["monica_api_key_url", endpoint]]);
  const result = fields.map(field => {
    if (!updates.has(field.name)) return field;
    const value = updates.get(field.name)!;
    updates.delete(field.name);
    return field.value === value ? field : { ...field, value };
  });
  for (const [name, value] of updates) {
    // Keep an existing blank carrier when explicitly clearing it, while leaving
    // an absent optional carrier absent on an unrelated save.
    if (name !== "monica_api_key_url" || value !== "") result.push({ name, value, protected: false });
  }
  return result.length === fields.length && result.every((field, index) => field === fields[index]) ? fields : result;
}
