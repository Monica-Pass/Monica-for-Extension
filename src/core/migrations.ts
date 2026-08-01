import type { LoginItem, LoginUriMatchType, ProviderSourceRecord, VaultItem, VaultState } from "./model";

const URI_MATCH_TYPES = new Set<LoginUriMatchType>(["base-domain", "domain", "starts-with", "exact", "regex", "never"]);
const LEGACY_MDBX_MESSAGE = "此密码源使用 Monica Extension 已停用的 MDBX1 实现。请使用 Monica Android 或桌面端升级为 MDBX2 后重新连接。";
export const MAX_SOURCE_RECORD_TAG_LENGTH = 64;

export function migrateVaultState(input: unknown): VaultState {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Vault payload is invalid or unsupported");
  const raw = structuredClone(input) as Record<string, unknown>;
  const version = Number(raw.schemaVersion);
  if (version !== 1 && version !== 2) throw new Error("Vault payload is invalid or unsupported");

  const items = Array.isArray(raw.items) ? raw.items.map(migrateItem) : raw.items;
  let providers = Array.isArray(raw.providers) ? raw.providers.map(migrateProvider) : raw.providers;
  let settings = raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
    ? { ...(raw.settings as Record<string, unknown>), protectionMode: normalizeProtectionMode((raw.settings as Record<string, unknown>).protectionMode) }
    : raw.settings;
  ({ providers, settings } = normalizeDefaultProvider(providers, settings));
  const sourceRecords = Array.isArray(raw.sourceRecords) ? raw.sourceRecords.filter(validSourceRecord).map((record) => ({ ...record })) : [];

  return {
    ...raw,
    schemaVersion: 2,
    items,
    providers,
    settings,
    providerConflicts: Array.isArray(raw.providerConflicts) ? raw.providerConflicts : [],
    providerDiagnostics: Array.isArray(raw.providerDiagnostics) ? raw.providerDiagnostics : [],
    sourceRecords
  } as VaultState;
}

function migrateProvider(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const provider = value as Record<string, unknown>;
  const config = provider.config && typeof provider.config === "object" && !Array.isArray(provider.config)
    ? provider.config as Record<string, unknown>
    : {};
  if (provider.kind === "mdbx" || provider.kind === "mdbx-legacy") {
    const previousError = typeof provider.lastError === "string" && provider.lastError !== LEGACY_MDBX_MESSAGE
      ? provider.lastError
      : typeof config.legacyLastError === "string" ? config.legacyLastError : undefined;
    return {
      ...provider,
      kind: "mdbx-legacy",
      enabled: false,
      isDefaultSaveTarget: false,
      config: {
        ...config,
        mdbxGeneration: 1,
        formatVersion: "MDBX-1",
        supportState: "unsupported",
        ...(previousError ? { legacyLastError: previousError } : {})
      },
      lastError: LEGACY_MDBX_MESSAGE
    };
  }
  if (provider.kind === "mdbx2") {
    return { ...provider, config: { ...config, mdbxGeneration: 2, formatVersion: "MDBX-2" } };
  }
  return provider;
}

function normalizeDefaultProvider(providers: unknown, settings: unknown): { providers: unknown; settings: unknown } {
  if (!Array.isArray(providers) || !settings || typeof settings !== "object" || Array.isArray(settings)) return { providers, settings };
  const providerRecords = providers.filter((provider): provider is Record<string, unknown> => Boolean(provider) && typeof provider === "object" && !Array.isArray(provider));
  const currentId = typeof (settings as Record<string, unknown>).defaultProviderId === "string"
    ? (settings as Record<string, unknown>).defaultProviderId as string
    : "";
  const current = providerRecords.find((provider) => provider.id === currentId);
  const currentUsable = current && current.kind !== "mdbx-legacy" && current.enabled !== false;
  const local = providerRecords.find((provider) => provider.kind === "local" && typeof provider.id === "string");
  const defaultProviderId = currentUsable ? currentId : typeof local?.id === "string" ? local.id : currentId;
  if (!defaultProviderId) return { providers, settings };
  return {
    providers: providers.map((provider) => provider && typeof provider === "object" && !Array.isArray(provider) && typeof (provider as Record<string, unknown>).id === "string"
      ? { ...(provider as Record<string, unknown>), isDefaultSaveTarget: (provider as Record<string, unknown>).id === defaultProviderId }
      : provider),
    settings: { ...(settings as Record<string, unknown>), defaultProviderId }
  };
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

/**
 * Structural check only. An unrecognised `format` must still round-trip, otherwise a build that
 * predates a provider would silently discard that provider's source envelopes on first unlock.
 */
function validSourceRecord(value: unknown): value is ProviderSourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ProviderSourceRecord>;
  return typeof record.providerId === "string" && typeof record.remoteId === "string" && typeof record.payload === "string" && typeof record.contentHash === "string"
    && typeof record.format === "string" && Boolean(record.format) && record.format.length <= MAX_SOURCE_RECORD_TAG_LENGTH
    && typeof record.encoding === "string" && Boolean(record.encoding) && record.encoding.length <= MAX_SOURCE_RECORD_TAG_LENGTH;
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
