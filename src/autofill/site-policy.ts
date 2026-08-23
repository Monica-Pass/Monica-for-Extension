import { getDomain, getPublicSuffix } from "tldts";

export const MAX_SITE_POLICY_HOSTS = 500;
const MAX_HOST_BYTES = 253;

export interface AutofillSitePolicy {
  blockedHosts: string[];
  saveBlockedHosts: string[];
}

export function normalizeSitePolicyHost(input: string): string {
  const candidate = input.trim();
  if (!candidate) throw new Error("网站域名不能为空。");
  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : "https://" + candidate);
  } catch {
    throw new Error("网站域名格式无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 HTTP 或 HTTPS 网站。");
  const host = url.hostname.toLocaleLowerCase().replace(/\.$/, "");
  if (!host || new TextEncoder().encode(host).byteLength > MAX_HOST_BYTES) throw new Error("网站域名长度无效。");
  if (url.port || url.username || url.password) throw new Error("排除项只能包含网站域名。");
  if (!isValidHostname(host) || !getDomain(host, { allowPrivateDomains: true })) throw new Error("请输入可注册的网站域名，不能使用公共后缀或本机地址。");
  if (getPublicSuffix(host, { allowPrivateDomains: true }) === host) throw new Error("公共后缀不能作为排除项。");
  return host;
}

export function normalizeSitePolicy(value: AutofillSitePolicy): AutofillSitePolicy {
  return {
    blockedHosts: normalizeList(value.blockedHosts),
    saveBlockedHosts: normalizeList(value.saveBlockedHosts)
  };
}

export function isAutofillBlocked(pageUrl: string, policy: AutofillSitePolicy): boolean {
  return isBlocked(pageUrl, policy.blockedHosts);
}

export function isSaveBlocked(pageUrl: string, policy: AutofillSitePolicy): boolean {
  return isBlocked(pageUrl, policy.saveBlockedHosts) || isBlocked(pageUrl, policy.blockedHosts);
}

function normalizeList(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_SITE_POLICY_HOSTS) throw new Error("网站排除项不能超过 " + MAX_SITE_POLICY_HOSTS + " 个。");
  return [...new Set(values.map(normalizeSitePolicyHost))].sort();
}

function isBlocked(pageUrl: string, blockedHosts: string[]): boolean {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return true;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return true;
  const host = page.hostname.toLocaleLowerCase().replace(/\.$/, "");
  return blockedHosts.some((blocked) => host === blocked || host.endsWith("." + blocked));
}

function isValidHostname(host: string): boolean {
  if (host.length > MAX_HOST_BYTES || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) return false;
  return host.split(".").every((label) => Boolean(label) && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}
