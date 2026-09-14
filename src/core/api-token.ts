import type { ApiTokenItem } from "./model";

export const API_TOKEN_TYPE = "api-token";
export const API_TOKEN_SCHEMA = "monica.api-token.v1";
export const API_TOKEN_GATEWAY_SCHEMA = "monica.gateway.credential.v1";
export const API_TOKEN_METADATA_SCHEMA = "monica.api-token.fields.v1";
export const API_TOKEN_MAX_BYTES = 16 * 1024;
export const API_TOKEN_METADATA_MAX_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const control = /[\u0000-\u001f\u007f-\u009f]/;

function object(value: string, maximum: number): JsonObject | undefined {
  if (bytes(value) > maximum) return;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch { return; }
}

export function decodeApiTokenPayload(value: string): JsonObject | undefined {
  const fields = object(value, API_TOKEN_MAX_BYTES);
  if (!fields || ![API_TOKEN_SCHEMA, API_TOKEN_GATEWAY_SCHEMA].includes(String(fields.schema))) return;
  if (["provider", "api_base", "token"].some(key => typeof fields[key] !== "string")) return;
  if ("note" in fields && typeof fields.note !== "string") return;
  return fields;
}

export function decodeApiTokenMetadata(value: string): JsonObject | undefined {
  const fields = object(value, API_TOKEN_METADATA_MAX_BYTES);
  if (!fields || fields.schema !== API_TOKEN_METADATA_SCHEMA) return;
  if ("notes" in fields && typeof fields.notes !== "string") return;
  if ("custom_fields" in fields) {
    if (!Array.isArray(fields.custom_fields) || fields.custom_fields.length > 128) return;
    const ids = new Set<number>();
    for (const [index, entry] of fields.custom_fields.entries()) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const field = entry as JsonObject;
      const id = field.id ?? -(index + 1);
      if (!Number.isSafeInteger(id) || ids.has(id as number) || typeof field.title !== "string" || typeof field.value !== "string" || typeof field.protected !== "boolean") return;
      ids.add(id as number);
    }
  }
  return fields;
}

export function apiTokenFromPayload(payloadJson: string, metadataJson?: string): Pick<ApiTokenItem, "provider" | "apiBase" | "token" | "notes" | "customFields" | "apiTokenPayload" | "apiTokenMetadata" | "archivedAt"> | undefined {
  const payload = decodeApiTokenPayload(payloadJson);
  const metadata = metadataJson ? decodeApiTokenMetadata(metadataJson) : undefined;
  if (!payload || (metadataJson && !metadata)) return;
  const custom = (metadata?.custom_fields || []) as JsonObject[];
  const archived = metadata?.["monica:extension:archived_at"];
  return {
    provider: payload.provider as string,
    apiBase: payload.api_base as string,
    token: payload.token as string,
    notes: typeof metadata?.notes === "string" ? metadata.notes : String(payload.note || ""),
    archivedAt: typeof archived === "string" && Number.isFinite(Date.parse(archived)) ? archived : undefined,
    customFields: custom.map((field, index) => ({ id: (field.id as number | undefined) ?? -(index + 1), name: field.title as string, value: field.value as string, protected: field.protected as boolean })),
    apiTokenPayload: payloadJson,
    apiTokenMetadata: metadataJson
  };
}

/** Keep the CLI schema only while the edited record still meets its stricter rules. */
export function serializeApiTokenPayload(item: Pick<ApiTokenItem, "provider" | "apiBase" | "token" | "title" | "apiTokenPayload">): string {
  const original = item.apiTokenPayload ? decodeApiTokenPayload(item.apiTokenPayload) : undefined;
  if (item.apiTokenPayload && !original) throw new Error("API 密钥原始数据无法识别，请保留原件后重新导入。");
  const payload = { schema: API_TOKEN_SCHEMA, ...original, provider: item.provider, api_base: item.apiBase, token: item.token };
  if (payload.schema === API_TOKEN_GATEWAY_SCHEMA && !isGatewayCredential(payload, item.title)) payload.schema = API_TOKEN_SCHEMA;
  return JSON.stringify(payload);
}

export function serializeApiTokenMetadata(item: Pick<ApiTokenItem, "notes" | "customFields" | "apiTokenMetadata" | "archivedAt">): string {
  const original = item.apiTokenMetadata ? decodeApiTokenMetadata(item.apiTokenMetadata) : undefined;
  if (item.apiTokenMetadata && !original) throw new Error("API 密钥补充字段无法识别，请保留原件后重新导入。");
  const previous = new Map(((original?.custom_fields || []) as JsonObject[]).map((field, index) => [(field.id as number | undefined) ?? -(index + 1), field]));
  const occupied = new Set(item.customFields.flatMap(field => field.id === undefined ? [] : [field.id]));
  let nextId = -1;
  const fields = item.customFields.map(field => {
    while (occupied.has(nextId)) nextId--;
    const id = field.id ?? nextId--;
    return { ...previous.get(id), id, title: field.name, value: field.value, protected: field.protected };
  });
  // Android preserves unknown label fields. Keep extension-only archive state
  // here so Android edits and subsequent extension syncs cannot lose it.
  const metadata: JsonObject = { schema: API_TOKEN_METADATA_SCHEMA, ...original, notes: item.notes, custom_fields: fields };
  if (item.archivedAt) metadata["monica:extension:archived_at"] = item.archivedAt;
  else delete metadata["monica:extension:archived_at"];
  return JSON.stringify(metadata);
}

export function apiTokenValidationError(item: Pick<ApiTokenItem, "title" | "provider" | "apiBase" | "token" | "notes" | "customFields" | "apiTokenPayload" | "apiTokenMetadata">): string | undefined {
  if ([item.title, item.provider, item.apiBase, item.token, item.notes].some(value => typeof value !== "string") || !Array.isArray(item.customFields)) return "API 密钥格式无效。";
  if (!item.title.trim() || item.title.length > 256 || control.test(item.title)) return "请输入 1–256 个字符的名称。";
  if (!item.provider.trim() || item.provider.length > 128 || control.test(item.provider)) return "请填写服务商名称，最多 128 个字符。";
  if (!item.token.trim()) return "请输入 API 密钥。";
  if (item.token.length >= 16 && item.title.includes(item.token)) return "名称中不能包含完整 API 密钥。";
  if (item.apiBase.trim()) {
    try {
      const uri = new URL(item.apiBase);
      if (!/^https?:$/.test(uri.protocol) || !uri.hostname || uri.username || uri.password || item.apiBase.length > 2048 || control.test(item.apiBase) || (item.token.length >= 16 && item.apiBase.includes(item.token))) return "API 地址需为有效的 HTTP 或 HTTPS 地址，不能包含账号密码或密钥。";
    } catch { return "API 地址需为有效的 HTTP 或 HTTPS 地址，不能包含账号密码或密钥。"; }
  }
  try {
    if (!decodeApiTokenPayload(serializeApiTokenPayload(item))) return "API 密钥内容不能超过 16 KB。";
    if (!decodeApiTokenMetadata(serializeApiTokenMetadata(item))) return "补充信息最多 128 个字段、64 KB，字段标识不能重复。";
  } catch { return "API 密钥原始数据无法识别，请保留原件后重新导入。"; }
}

function isGatewayCredential(fields: JsonObject, title: string): boolean {
  const token = String(fields.token), note = String(fields.note || ""), endpoint = String(fields.api_base);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(title) || !/^[\x21-\x7e]{16,4096}$/.test(token) || bytes(note) > 1024 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(note) || note.includes(token) || endpoint.includes(token) || bytes(endpoint) > 2048) return false;
  try {
    const uri = new URL(endpoint);
    const path = fields.provider === "gitlab" ? uri.pathname === "/api/v4/" : fields.provider === "github" && ["/", "/api/v3/"].includes(uri.pathname);
    return Boolean(path && uri.protocol === "https:" && uri.hostname && !uri.username && !uri.password && !uri.search && !uri.hash);
  } catch { return false; }
}
