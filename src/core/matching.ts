import type { LoginItem } from "./model";

export function normalizeHost(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  try {
    return new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return candidate.toLowerCase().replace(/^www\./, "").split("/")[0] || "";
  }
}

export function loginMatchScore(item: LoginItem, pageUrl: string): number {
  const pageHost = normalizeHost(pageUrl);
  if (!pageHost) return 0;
  return item.uris.reduce((score, uri) => {
    const storedHost = normalizeHost(uri);
    if (!storedHost) return score;
    if (storedHost === pageHost) return Math.max(score, 100);
    if (pageHost.endsWith(`.${storedHost}`) || storedHost.endsWith(`.${pageHost}`)) return Math.max(score, 80);
    return score;
  }, 0);
}

export function matchingLogins(items: LoginItem[], pageUrl: string): LoginItem[] {
  return items
    .map((item) => ({ item, score: loginMatchScore(item, pageUrl) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.item.favorite) - Number(left.item.favorite) || left.item.title.localeCompare(right.item.title))
    .map(({ item }) => item);
}
