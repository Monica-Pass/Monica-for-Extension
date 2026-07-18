import type { TotpItem } from "../../core/model";
import { createSteamSessionId, prepareSteamAccount, requireSteamId, SteamNetworkError, steamCommunityJson, steamCommunityText } from "./steam-network";

export interface SteamWalletInfo {
  currency: number;
  steamFeePercent: number;
  publisherFeePercent: number;
  marketMinimum: number;
  currencyIncrement: number;
}

export interface SteamInventoryGame {
  appId: number;
  contextId: string;
  name: string;
  contextName: string;
  iconUrl: string;
  itemCount: number;
}

export interface SteamInventoryItem {
  appId: number;
  contextId: string;
  assetId: string;
  classId: string;
  instanceId: string;
  amount: number;
  marketHashName: string;
  name: string;
  type: string;
  iconUrl: string;
  marketable: boolean;
  tradable: boolean;
  commodity: boolean;
  publisherFeePercent?: number;
}

export interface SteamInventoryOverview {
  games: SteamInventoryGame[];
  wallet: SteamWalletInfo;
}

export interface SteamInventoryPage {
  items: SteamInventoryItem[];
  lastAssetId?: string;
  hasMore: boolean;
  totalCount: number;
}

export const FALLBACK_STEAM_WALLET: SteamWalletInfo = {
  currency: 1,
  steamFeePercent: 0.05,
  publisherFeePercent: 0.1,
  marketMinimum: 1,
  currencyIncrement: 1
};

export async function getSteamInventoryOverview(item: TotpItem): Promise<SteamInventoryOverview> {
  const account = await prepareSteamAccount(item);
  const steamId = requireSteamId(account.item).toString();
  const sessionId = createSteamSessionId();
  const html = await steamCommunityText(`/profiles/${steamId}/inventory/`, {}, account.item, {
    cookies: { sessionid: sessionId }
  });
  return parseSteamInventoryOverview(html);
}

export async function listSteamInventoryItems(item: TotpItem, input: {
  appId: number;
  contextId: string;
  language?: string;
  startAssetId?: string;
  count?: number;
}): Promise<SteamInventoryPage> {
  const account = await prepareSteamAccount(item);
  const steamId = requireSteamId(account.item).toString();
  const appId = requirePositiveInteger(input.appId, "Steam AppID");
  const contextId = requireNumericId(input.contextId, "Steam inventory context");
  const count = Math.min(2_000, Math.max(1, Math.trunc(input.count || 75)));
  const values: Record<string, string> = { l: steamCommunityLanguage(input.language || navigatorLanguage()), count: String(count) };
  if (input.startAssetId) values.start_assetid = requireNumericId(input.startAssetId, "Steam inventory cursor");
  const payload = await steamCommunityJson(`/inventory/${steamId}/${appId}/${contextId}`, values, account.item, {
    cookies: { sessionid: createSteamSessionId() }
  });
  return parseSteamInventoryPage(payload);
}

export function parseSteamInventoryOverview(html: string): SteamInventoryOverview {
  const apps = extractAssignedJsonObject(html, "g_rgAppContextData");
  const wallet = parseWallet(extractAssignedJsonObject(html, "g_rgWalletInfo"));
  const games: SteamInventoryGame[] = [];
  for (const [appIdText, rawApp] of Object.entries(apps || {})) {
    if (!isObject(rawApp)) continue;
    const appId = positiveInteger(rawApp.appid) || positiveInteger(appIdText);
    if (!appId || !isObject(rawApp.rgContexts)) continue;
    for (const [contextId, rawContext] of Object.entries(rawApp.rgContexts)) {
      if (!isObject(rawContext) || !/^\d+$/.test(contextId)) continue;
      const itemCount = Math.max(0, integerValue(rawContext.asset_count));
      if (!itemCount) continue;
      games.push({
        appId,
        contextId,
        name: stringValue(rawApp.name),
        contextName: stringValue(rawContext.name),
        iconUrl: sanitizeSteamAssetUrl(stringValue(rawApp.icon)),
        itemCount
      });
    }
  }
  games.sort((left, right) => right.itemCount - left.itemCount);
  return { games, wallet };
}

export function parseSteamInventoryPage(payload: Record<string, unknown>): SteamInventoryPage {
  const descriptions = new Map<string, Record<string, unknown>>();
  for (const value of arrayValue(payload.descriptions)) {
    if (!isObject(value)) continue;
    descriptions.set(`${stringValue(value.classid)}_${stringValue(value.instanceid)}`, value);
  }
  const items: SteamInventoryItem[] = [];
  for (const value of arrayValue(payload.assets)) {
    if (!isObject(value)) continue;
    const classId = stringValue(value.classid);
    const instanceId = stringValue(value.instanceid);
    const description = descriptions.get(`${classId}_${instanceId}`);
    if (!description) continue;
    const appId = positiveInteger(value.appid);
    const contextId = numericString(value.contextid);
    const assetId = numericString(value.assetid);
    if (!appId || !contextId || !assetId) continue;
    items.push({
      appId,
      contextId,
      assetId,
      classId,
      instanceId,
      amount: Math.max(1, integerValue(value.amount)),
      marketHashName: stringValue(description.market_hash_name),
      name: stringValue(description.name) || stringValue(description.market_name),
      type: stringValue(description.type),
      iconUrl: steamEconomyImageUrl(stringValue(description.icon_url)),
      marketable: booleanValue(description.marketable),
      tradable: booleanValue(description.tradable),
      commodity: booleanValue(description.commodity),
      publisherFeePercent: optionalNumber(description.market_fee)
    });
  }
  return {
    items,
    lastAssetId: numericString(payload.last_assetid) || undefined,
    hasMore: booleanValue(payload.more_items),
    totalCount: Math.max(0, integerValue(payload.total_inventory_count))
  };
}

export function steamCommunityLanguage(languageCode: string): string {
  switch (languageCode.trim().toLowerCase()) {
    case "zh": case "zh-cn": case "zh-hans": return "schinese";
    case "zh-tw": case "zh-hk": case "zh-hant": return "tchinese";
    case "ja": return "japanese";
    case "ru": return "russian";
    case "vi": return "vietnamese";
    default: return "english";
  }
}

export function sanitizeSteamAssetUrl(raw: string): string {
  if (!raw) return "";
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw.startsWith("/") ? `https://steamcommunity.com${raw}` : raw;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "steamstatic.com" || host.endsWith(".steamstatic.com") || host === "steamcommunity.com" || host.endsWith(".steamcommunity.com")) return url.toString();
  } catch { return ""; }
  return "";
}

function steamEconomyImageUrl(raw: string): string {
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || raw.startsWith("//")) return sanitizeSteamAssetUrl(raw);
  return sanitizeSteamAssetUrl(`https://community.fastly.steamstatic.com/economy/image/${raw.replace(/^\/+/, "")}`);
}

function parseWallet(raw: Record<string, unknown> | undefined): SteamWalletInfo {
  if (!raw) return { ...FALLBACK_STEAM_WALLET };
  return {
    currency: positiveInteger(raw.wallet_currency) || FALLBACK_STEAM_WALLET.currency,
    steamFeePercent: optionalNumber(raw.wallet_fee_percent) ?? FALLBACK_STEAM_WALLET.steamFeePercent,
    publisherFeePercent: optionalNumber(raw.wallet_publisher_fee_percent_default) ?? FALLBACK_STEAM_WALLET.publisherFeePercent,
    marketMinimum: Math.max(1, integerValue(raw.wallet_market_minimum)),
    currencyIncrement: Math.max(1, integerValue(raw.wallet_currency_increment))
  };
}

function extractAssignedJsonObject(source: string, variableName: string): Record<string, unknown> | undefined {
  const match = new RegExp(`${escapeRegExp(variableName)}\\s*=\\s*`).exec(source);
  if (!match) return undefined;
  let index = match.index + match[0].length;
  if (source[index] !== "{") return undefined;
  const start = index;
  let depth = 0;
  let quote = "";
  for (; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(source.slice(start, index + 1)) as unknown;
        return isObject(parsed) ? parsed : undefined;
      } catch { return undefined; }
    }
  }
  return undefined;
}

function requirePositiveInteger(value: number, label: string): number {
  const parsed = positiveInteger(value);
  if (!parsed) throw new SteamNetworkError(`${label} 无效。`, false);
  return parsed;
}

function requireNumericId(value: string, label: string): string {
  const parsed = numericString(value);
  if (!parsed) throw new SteamNetworkError(`${label} 无效。`, false);
  return parsed;
}

function navigatorLanguage(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language;
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function numericString(value: unknown): string { const text = stringValue(value).trim(); return /^\d+$/.test(text) ? text : ""; }
function integerValue(value: unknown): number { const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : 0; }
function positiveInteger(value: unknown): number { const parsed = integerValue(value); return parsed > 0 && parsed <= 2_147_483_647 ? parsed : 0; }
function optionalNumber(value: unknown): number | undefined { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function booleanValue(value: unknown): boolean { return value === true || value === 1 || value === "1" || value === "true"; }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
