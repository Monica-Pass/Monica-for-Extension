import type { LoginItem, SecureCustomField } from "./model";
import { jsonScalarText, parseLosslessJson } from "./lossless-json";
import { mergeMonicaItemData, readCardFaceConfig } from "../providers/monica-item-data";

export const CONTENT_ORDER = "monica.content.order";
export const BLOCK_PREFIX = "monica.content.block.";
export const WALLET_PREFIX = "monica.content.wallet.";
export const MAX_CONTENT_BYTES = 256 * 1024;
export type ContentBlockKind = "API_KEY" | "API_TOKEN" | "SSH_KEY" | "GPG_KEY" | "QR_CODE";
export type WalletKind = "BANK_CARD" | "DOCUMENT" | "ADDRESS" | "NOTE";
type JsonObject = Record<string, unknown>;
export interface ContentBlock { id: string; kind: ContentBlockKind; title: string; raw: JsonObject; data: JsonObject }
export interface WalletAsset { name: string; displayName: string; mimeType: string; role: "CARD_FACE" | "FRONT" | "BACK" | "INLINE_IMAGE" | "ATTACHMENT"; size: number; sha256: string }
export interface WalletContent { id: string; kind: WalletKind; title: string; notes: string; favorite: boolean; raw: JsonObject; data: JsonObject; assets: WalletAsset[] }
export type StoredContent<T> = { token: string; value?: T; reason?: string; originalFields: SecureCustomField[] };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const utf8 = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const kinds: ContentBlockKind[] = ["API_KEY", "API_TOKEN", "SSH_KEY", "GPG_KEY", "QR_CODE"];
export const BLOCK_EDITABLE_KEYS: Record<ContentBlockKind, string[]> = {
  API_KEY: ["key", "url", "notes"], API_TOKEN: ["provider", "api_base", "token", "notes"],
  SSH_KEY: ["algorithm", "keySize", "format", "publicKeyOpenSsh", "privateKeyOpenSsh", "fingerprintSha256", "comment", "notes"],
  GPG_KEY: ["publicKey", "privateKey", "fingerprint", "userId", "notes"], QR_CODE: ["content", "notes"]
};

export function isContentMetadata(name: string): boolean { return name.startsWith("monica.content."); }
export function contentOrder(fields: SecureCustomField[]): string[] {
  return [...new Set((fields.find(field => field.name === CONTENT_ORDER)?.value || "").split(",").filter(token => token.trim()))];
}
export const BASE_CONTENT_ORDER = ["AUTHENTICATOR", "PAYMENT", "CONTACT", "ADDRESS", "NOTES", "CUSTOM_FIELDS", "ATTACHMENTS"];
export function orderedContentTokens(fields: SecureCustomField[]): string[] {
  const blocks = fields.filter(field => field.name.startsWith(BLOCK_PREFIX)).map(field => `BLOCK:${field.name.slice(BLOCK_PREFIX.length).split(".")[0]}`);
  return [...new Set([...contentOrder(fields), ...BASE_CONTENT_ORDER, ...blocks])];
}
export function contentRank(fields: SecureCustomField[], token: string): number { return orderedContentTokens(fields).indexOf(token); }
export function moveContentToken(fields: SecureCustomField[], token: string, target: string, after = false): SecureCustomField[] {
  const baseline = orderedContentTokens(fields), order = [...baseline];
  if (token === target || !order.includes(token) || !order.includes(target)) return fields;
  order.splice(order.indexOf(token), 1);
  order.splice(order.indexOf(target) + (after ? 1 : 0), 0, token);
  if (order.every((value, index) => value === baseline[index])) return fields;
  return withContentOrder(fields, order);
}
export function withContentOrder(fields: SecureCustomField[], order: string[]): SecureCustomField[] {
  const matches = fields.filter(field => field.name === CONTENT_ORDER);
  if (matches.length > 1) throw new Error("内容排序字段重复，请先处理原始数据。");
  const value = [...new Set([...order, ...contentOrder(fields)])].join(",");
  return [...fields.filter(field => field.name !== CONTENT_ORDER), { ...(matches[0] || { name: CONTENT_ORDER, protected: true }), value }];
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) === null && "rawJSON" in value) throw new Error("内容不是对象。");
  return value as JsonObject;
}
function text(value: unknown): string { if (typeof value !== "string") throw new Error("内容字段不是文本。"); return value; }
function base64(bytes: Uint8Array): string { let result = ""; for (const value of bytes) result += String.fromCharCode(value); return btoa(result); }
function decode64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("内容编码无效。");
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
async function digest(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()))].map(value => value.toString(16).padStart(2, "0")).join(""); }
function checkedBytes(value: string): Uint8Array { const bytes = utf8.encode(value); if (bytes.length > MAX_CONTENT_BYTES) throw new Error("内容超过 256 KiB，未保存。"); return bytes; }
function blockFromRaw(raw: JsonObject, id: string): ContentBlock {
  if (raw.version !== 1 || raw.id !== id || !uuid.test(id) || !kinds.includes(raw.kind as ContentBlockKind)) throw new Error("不支持的内容版本或类型。");
  const title = text(raw.title); const kind = raw.kind as ContentBlockKind; const data = object(raw.data);
  for (const key of BLOCK_EDITABLE_KEYS[kind]) if (key in data) text(data[key]);
  if (kind === "QR_CODE") {
    if ("mode" in data) text(data.mode);
    if ("templateVersion" in data) text(data.templateVersion);
    if (![undefined, "", "literal", "template"].includes(data.mode as string) || data.mode === "template" && data.templateVersion !== "1") throw new Error("不支持的二维码模板版本。");
  }
  return { id, kind, title, raw, data };
}
export function createContentBlock(kind: ContentBlockKind): ContentBlock {
  const id = crypto.randomUUID(); return blockFromRaw({ version: 1, id, kind, title: "", data: {} }, id);
}
export async function readContentBlocks(fields: SecureCustomField[]): Promise<StoredContent<ContentBlock>[]> {
  const ids = [...new Set(fields.filter(field => field.name.startsWith(BLOCK_PREFIX)).map(field => field.name.slice(BLOCK_PREFIX.length).split(".")[0]))];
  return Promise.all(ids.map(async id => {
    const prefix = BLOCK_PREFIX + id;
    const originalFields = fields.filter(field => field.name === prefix || field.name.startsWith(prefix + "."));
    try {
      if (!uuid.test(id)) throw new Error("内容 ID 无效。");
      const headers = originalFields.filter(field => field.name === prefix);
      if (headers.length !== 1) throw new Error("内容清单缺失或重复。");
      const header = object(parseLosslessJson(headers[0].value));
      const count = header.parts;
      if (header.version !== 1 || header.encoding !== "base64" || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 220) throw new Error("内容清单版本或分段数无效。");
      if (originalFields.length !== count + 1) throw new Error("内容分段缺失或重复。");
      let encoded = "";
      for (let i = 0; i < count; i++) {
        const parts = originalFields.filter(field => field.name === `${prefix}.${String(i).padStart(4, "0")}`);
        if (parts.length !== 1 || parts[0].value.length > 1600) throw new Error("内容分段缺失或重复。");
        encoded += parts[0].value;
      }
      const bytes = decode64(encoded);
      if (bytes.length > MAX_CONTENT_BYTES || await digest(bytes) !== header.sha256) throw new Error("内容摘要校验失败。");
      return { token: `BLOCK:${id}`, value: blockFromRaw(object(parseLosslessJson(strictDecoder.decode(bytes))), id), originalFields };
    } catch (error) { return { token: `BLOCK:${id}`, reason: error instanceof Error ? error.message : "内容不可读取。", originalFields }; }
  }));
}
export function editContentBlock(block: ContentBlock, title: string, patch: Record<string, string>): ContentBlock {
  return blockFromRaw({ ...block.raw, title, data: { ...block.data, ...patch } }, block.id);
}
export async function putContentBlock(fields: SecureCustomField[], block: ContentBlock): Promise<SecureCustomField[]> {
  const current = (await readContentBlocks(fields)).find(value => value.token === `BLOCK:${block.id}`);
  if (current && !current.value) throw new Error("无法改写损坏或未知版本的内容。");
  blockFromRaw(block.raw, block.id);
  const bytes = checkedBytes(JSON.stringify(block.raw)); const encoded = base64(bytes);
  const parts = encoded.match(/.{1,1600}/g)!; const name = BLOCK_PREFIX + block.id;
  const previous = fields.find(field => field.name === name);
  const header = previous ? object(parseLosslessJson(previous.value)) : {};
  const replacement = [[name, JSON.stringify({ ...header, version: 1, encoding: "base64", parts: parts.length, sha256: await digest(bytes) })], ...parts.map((part, index) => [`${name}.${String(index).padStart(4, "0")}`, part])];
  const result = fields.filter(field => field.name !== name && !field.name.startsWith(name + "."));
  for (const [fieldName, value] of replacement) result.push({ ...fields.find(field => field.name === fieldName), name: fieldName, value, protected: true });
  return withContentOrder(result, [...contentOrder(fields), `BLOCK:${block.id}`]);
}
export async function removeContentBlock(fields: SecureCustomField[], token: string): Promise<SecureCustomField[]> {
  const block = (await readContentBlocks(fields)).find(value => value.token === token);
  if (!block?.value) throw new Error("无法删除损坏或未知版本的内容。");
  const name = BLOCK_PREFIX + block.value.id;
  return fields.filter(field => field.name !== name && !field.name.startsWith(name + ".")).map(field => field.name === CONTENT_ORDER ? { ...field, value: field.value.split(",").filter(value => value !== token).join(",") } : field);
}

function walletFromRaw(raw: JsonObject): WalletContent {
  const kind = text(raw.kind) as WalletKind;
  if (raw.version !== 1 || !["BANK_CARD", "DOCUMENT", "ADDRESS", "NOTE"].includes(kind) || !text(raw.id).trim()) throw new Error("不支持的副本版本或类型。");
  const data = object(raw.data); const title = text(raw.title); const notes = text(raw.notes);
  if (!Array.isArray(raw.assets)) throw new Error("副本附件清单无效。");
  const names = new Set<string>();
  const assets = raw.assets.map(value => {
    const asset = object(value); const name = text(asset.name); const size = Number(jsonScalarText(asset.size));
    if (!/^wallet-[a-zA-Z0-9-]+$/.test(name) || names.has(name) || !Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/.test(text(asset.sha256)) || !["CARD_FACE", "FRONT", "BACK", "INLINE_IMAGE", "ATTACHMENT"].includes(text(asset.role))) throw new Error("副本附件清单无效。");
    names.add(name);
    return { name, size, displayName: text(asset.displayName), mimeType: text(asset.mimeType), role: text(asset.role) as WalletAsset["role"], sha256: text(asset.sha256) };
  });
  if (data.cardFace !== undefined) readCardFaceConfig(data.cardFace);
  return { id: text(raw.id), kind, title, notes, favorite: raw.favorite === true, data, assets, raw };
}
export function readWalletContents(fields: SecureCustomField[]): StoredContent<WalletContent>[] {
  return [...new Set(fields.filter(field => field.name.startsWith(WALLET_PREFIX)).map(field => field.name))].map(name => {
    const originalFields = fields.filter(field => field.name === name);
    try {
      if (originalFields.length !== 1) throw new Error("副本字段重复。");
      const value = walletFromRaw(object(parseLosslessJson(originalFields[0].value)));
      if (name !== WALLET_PREFIX + value.kind.toLowerCase()) throw new Error("副本类型与字段名不一致。");
      return { token: walletSection(value.kind), value, originalFields };
    } catch (error) { return { token: name, reason: error instanceof Error ? error.message : "副本不可读取。", originalFields }; }
  });
}
export function walletSection(kind: WalletKind): string { return ({ BANK_CARD: "PAYMENT", DOCUMENT: "CONTACT", ADDRESS: "ADDRESS", NOTE: "NOTES" })[kind]; }
export function createWalletContent(kind: WalletKind, title: string, data: JsonObject): WalletContent { return walletFromRaw({ version: 1, id: crypto.randomUUID(), kind, title, notes: "", favorite: false, data, assets: [] }); }
export function editWalletContent(wallet: WalletContent, patch: { title?: string; notes?: string; favorite?: boolean; data?: JsonObject; assets?: WalletAsset[] }): WalletContent {
  return walletFromRaw({ ...wallet.raw, ...patch, data: patch.data ? mergeMonicaItemData(wallet.data, patch.data) : wallet.data });
}
export function putWalletContent(fields: SecureCustomField[], wallet: WalletContent): SecureCustomField[] {
  const name = WALLET_PREFIX + wallet.kind.toLowerCase();
  const previous = readWalletContents(fields).find(value => value.originalFields.some(field => field.name === name));
  if (previous && !previous.value) throw new Error("无法改写损坏或未知版本的副本。");
  walletFromRaw(wallet.raw);
  const value = JSON.stringify(wallet.raw);
  const field = { ...fields.find(field => field.name === name), name, value, protected: true };
  const result = previous ? fields.map(candidate => candidate.name === name ? field : candidate) : [...fields, field];
  return withContentOrder(result, [...contentOrder(fields), walletSection(wallet.kind)]);
}

export function renderQrTemplate(template: string, item: Pick<LoginItem, "username" | "password" | "title" | "uris" | "email" | "phone" | "notes" | "customFields">): string {
  checkedBytes(template);
  const values: Record<string, string | undefined> = { ACCOUNT: item.username, PASSWORD: item.password, TITLE: item.title, URL: item.uris.join("\n"), EMAIL: item.email ?? "", PHONE: item.phone ?? "", NOTES: item.notes };
  const wifi = /^WIFI:/i.test(template);
  const output = template.replace(/%%|%([A-Z][A-Z0-9_]*)(?::([^%]*))?%/g, (match, key: string, parameter?: string) => {
    if (match === "%%") return "%";
    let value: string | undefined;
    if (key === "FIELD") {
      if (!parameter || !/^[A-Za-z0-9_-]*$/.test(parameter)) throw new Error("二维码模板字段名称无效。");
      const encoded = parameter.replace(/-/g, "+").replace(/_/g, "/");
      const name = strictDecoder.decode(decode64(encoded + "=".repeat((4 - encoded.length % 4) % 4)));
      const fields = item.customFields.filter(field => field.name === name);
      if (fields.length !== 1) throw new Error(`二维码字段缺失或重复：${name}`);
      value = fields[0].value;
    } else if (!parameter) value = values[key];
    if (value === undefined) throw new Error(`二维码字段不可读取：${key}`);
    return wifi ? value.replace(/[\\;,:\"]/g, character => "\\" + character) : value;
  });
  checkedBytes(output); return output;
}
