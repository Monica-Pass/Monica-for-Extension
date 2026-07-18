import type { LoginItem, LoginUriMatchType, ProviderSourceRecord, VaultItem, VaultState } from "./model";

const URI_MATCH_TYPES = new Set<LoginUriMatchType>(["base-domain", "domain", "starts-with", "exact", "regex", "never"]);

export function migrateVaultState(input: unknown): VaultState {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Vault payload is invalid or unsupported");
  const raw = structuredClone(input) as Record<string, unknown>;
  const version = Number(raw.schemaVersion);
  if (version !== 1 && version !== 2) throw new Error("Vault payload is invalid or unsupported");

  const items = Array.isArray(raw.items) ? raw.items.map(migrateItem) : raw.items;
  const settings = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
    ? { ...(raw.settings as Record<string, unknown>), protectionMode: normalizeProtectionMode((raw.settings as Record<string, unknown>).protectionMode) }
    : raw.settings;
  const sourceRecords = Array.isArray(raw.sourceRecords) ? raw.sourceRecords.filter(validSourceRecord).map((record) => ({ ...record })) : [];

  return {
    ...raw,
    schemaVersion: 2,
    items,
    settings,
    providerConflicts: Array.isArray(raw.providerConflicts) ? raw.providerConflicts : [],
    providerDiagnostics: Array.isArray(raw.providerDiagnostics) ? raw.providerDiagnostics : [],
    sourceRecords
  } as VaultState;
}

function migrateItem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (item.kind !== "login") return item;
  const uris = Array.isArray(item.uris) ? item.uris.filter((uri): uri is string => typeof uri === "string" && Boolean(uri.trim())) : [];
  const existingRules = Array.isArray(item.uriRules) ? item.uriRules.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const rule = candidate as Record<string, unknown>;
    if (typeof rule.uri !== "string" || !rule.uri.trim()) return [];
    const matchType = typeof rule.matchType === "string" && URI_MATCH_TYPES.has(rule.matchType as LoginUriMatchType) ? rule.matchType as LoginUriMatchType : "base-domain";
    return [{ uri: rule.uri.trim(), matchType }];
  }) : [];
  const seen = new Set(existingRules.map((rule) => rule.uri));
  const uriRules = [...existingRules, ...uris.filter((uri) => !seen.has(uri)).map((uri) => ({ uri, matchType: "base-domain" as const }))];
  return { ...item, uris: [...new Set(uris)], uriRules } satisfies Partial<LoginItem>;
}

function normalizeProtectionMode(value: unknown): VaultState["settings"]["protectionMode"] {
  return value === "device-key" ? "device-key" : "master-password";
}

function validSourceRecord(value: unknown): value is ProviderSourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ProviderSourceRecord>;
  return typeof record.providerId === "string" && typeof record.remoteId === "string" && typeof record.payload === "string" && typeof record.contentHash === "string"
    && (record.format === "android-entry" || record.format === "bitwarden-cipher") && (record.encoding === "base64" || record.encoding === "json");
}

export function providerSourceRecordsFor(state: VaultState, providerId: string): ProviderSourceRecord[] {
  return state.sourceRecords.filter((record) => record.providerId === providerId).map((record) => structuredClone(record));
}

export function replaceProviderSourceRecords(state: VaultState, providerId: string, records: ProviderSourceRecord[]): void {
  state.sourceRecords = [
    ...state.sourceRecords.filter((record) => record.providerId !== providerId),
    ...records.filter((record) => record.providerId === providerId).map((record) => structuredClone(record))
  ];
}
