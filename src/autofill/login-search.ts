import type { LoginMatchSummary } from '../runtime/messages';

/** Search display fields only; never include notes, passwords or protected metadata. */
export function createLoginSummaryMatcher(query: string, passwordLabel = '{0}') {
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean);
  return (item: Pick<LoginMatchSummary, 'title' | 'username' | 'uris' | 'credentialIdentity'>): boolean => {
    if (!terms.length) return true;
    const identity = item.credentialIdentity;
    const text = normalize([item.title, item.username, ...item.uris, identity?.groupLabel || '',
      identity?.passwordNumber ? passwordLabel.replace('{0}', String(identity.passwordNumber)) : ''].join('\n'));
    return terms.every(term => text.includes(term));
  };
}
