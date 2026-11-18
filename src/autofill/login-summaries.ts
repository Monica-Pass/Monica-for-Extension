import { isLoginItem, type LoginItem, type VaultItem } from '../core/model';
import { customIconProjection } from '../core/custom-icon';
import { loginWebsiteOrigin } from '../core/website-icon';
import { loginMatchScore } from '../core/matching';
import { autofillCredentialIdentities } from './credential-identity';
import { createLoginSummaryMatcher } from './login-search';
import type { LoginMatchSummary } from '../runtime/messages';

export interface LoginSummaryQuery {
  page?: number;
  text?: string;
  passwordLabel?: string;
  excludeMatchingUrl?: string;
  /** Reuse a small already-validated match set; large sets use URL exclusion. */
  excludeIds?: string[];
}
export interface LoginSummaryPage { items: LoginMatchSummary[]; page: number; total: number; }
export const LOGIN_SUMMARY_PAGE_SIZE = 20;

export function normalizeLoginSummaryQuery(input: LoginSummaryQuery): LoginSummaryQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('登录查询无效。');
  const { page = 1, text = '', passwordLabel = '{0}', excludeMatchingUrl, excludeIds } = input;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000
    || typeof text !== 'string' || text.length > 1024
    || typeof passwordLabel !== 'string' || passwordLabel.length > 160
    || excludeMatchingUrl !== undefined && (typeof excludeMatchingUrl !== 'string' || excludeMatchingUrl.length > 8192)
    || excludeIds !== undefined && (!Array.isArray(excludeIds) || excludeIds.length > 100 || excludeIds.some(id => typeof id !== 'string' || id.length > 512))) {
    throw new Error('登录查询无效。');
  }
  return { page, text, passwordLabel, excludeMatchingUrl, excludeIds: excludeIds ? [...excludeIds] : undefined };
}

export function toMatchSummary(item: LoginItem, credentialIdentity?: LoginMatchSummary['credentialIdentity']): LoginMatchSummary {
  return { id: item.id, title: item.title, username: item.username, favorite: item.favorite, uris: item.uris,
    loginType: item.loginType, iconOrigin: loginWebsiteOrigin(item), ...customIconProjection(item),
    hasTotp: Boolean(item.totpSecret || item.boundTotpItemId), ...(credentialIdentity ? { credentialIdentity } : {}) };
}

/** Runs inside the authenticated read projection. Only the result leaves the vault cache. */
export function selectLoginSummaries(items: VaultItem[], query?: LoginSummaryQuery): LoginMatchSummary[] | LoginSummaryPage {
  const identities = autofillCredentialIdentities(items);
  const excluded = new Set(query?.excludeIds || []);
  const matches = createLoginSummaryMatcher(query?.text || '', query?.passwordLabel);
  const logins = items.filter((item): item is LoginItem => isLoginItem(item) && !item.deletedAt && !item.archivedAt)
    .filter(item => !excluded.has(item.id))
    .filter(item => !query?.excludeMatchingUrl || loginMatchScore(item, query.excludeMatchingUrl) === 0)
    .filter(item => !query?.text || matches({ title: item.title, username: item.username, uris: item.uris, credentialIdentity: identities[item.id] }))
    .sort((left, right) => Number(right.favorite) - Number(left.favorite) || right.updatedAt.localeCompare(left.updatedAt));
  if (!query) return logins.map(item => toMatchSummary(item, identities[item.id]));
  const page = Math.min(query.page || 1, Math.max(1, Math.ceil(logins.length / LOGIN_SUMMARY_PAGE_SIZE)));
  return { page, total: logins.length, items: logins.slice((page - 1) * LOGIN_SUMMARY_PAGE_SIZE, page * LOGIN_SUMMARY_PAGE_SIZE)
    .map(item => toMatchSummary(item, identities[item.id])) };
}
