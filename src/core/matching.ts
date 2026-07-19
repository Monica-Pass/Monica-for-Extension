import safeRegex from "safe-regex2";
import { getDomain } from "tldts";
import type { LoginItem, LoginUriRule } from "./model";

const MAX_REGEX_LENGTH = 512;

export function normalizeHost(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    return normalizeHostname(new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname);
  } catch {
    return normalizeHostname(candidate.split("/")[0] || "");
  }
}

export function loginMatchScore(item: LoginItem, pageUrl: string): number {
  if (item.deletedAt || item.archivedAt) return 0;
  if (item.loginType && item.loginType !== "PASSWORD" && item.loginType !== "SSO") return 0;
  const page = parsePageUrl(pageUrl);
  if (!page) return 0;
  const rules = effectiveUriRules(item);
  return rules.reduce((score, rule) => Math.max(score, uriRuleMatchScore(rule, page)), 0);
}

export function matchingLogins(items: LoginItem[], pageUrl: string): LoginItem[] {
  return items
    .map((item) => ({ item, score: loginMatchScore(item, pageUrl) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.item.favorite) - Number(left.item.favorite) || left.item.title.localeCompare(right.item.title))
    .map(({ item }) => item);
}

function effectiveUriRules(item: LoginItem): LoginUriRule[] {
  if (item.uriRules?.length) return item.uriRules;
  return item.uris.map((uri) => ({ uri, matchType: "base-domain" }));
}

function uriRuleMatchScore(rule: LoginUriRule, page: URL): number {
  const stored = rule.uri.trim();
  if (!stored || rule.matchType === "never") return 0;
  if (rule.matchType === "exact") return comparableUrl(stored) === page.href ? 140 : 0;
  if (rule.matchType === "starts-with") return page.href.startsWith(comparableUrl(stored, false)) ? 120 : 0;
  if (rule.matchType === "regex") return matchesSafeRegex(stored, page.href) ? 115 : 0;

  const storedHost = normalizeHost(stored);
  const pageHost = normalizeHostname(page.hostname);
  if (!storedHost || !pageHost) return 0;
  if (rule.matchType === "domain") {
    if (storedHost === pageHost) return 110;
    return pageHost.endsWith(`.${storedHost}`) ? 90 : 0;
  }

  if (storedHost === pageHost) return 100;
  return registrableDomain(storedHost) === registrableDomain(pageHost) ? 80 : 0;
}

function parsePageUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function comparableUrl(value: string, ensureTrailingSlash = true): string {
  const candidate = value.trim();
  if (!candidate.includes("://")) return candidate;
  try {
    const url = new URL(candidate);
    if (!ensureTrailingSlash && url.pathname === "/" && !/[/?#]$/.test(candidate)) return url.href.slice(0, -1);
    return url.href;
  } catch {
    return candidate;
  }
}

function matchesSafeRegex(pattern: string, value: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH || !safeRegex(pattern)) return false;
  try {
    return new RegExp(pattern, "i").test(value);
  } catch {
    return false;
  }
}

function registrableDomain(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

function normalizeHostname(host: string): string {
  return host.toLocaleLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}
