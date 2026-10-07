import type { LoginItem, ProviderAccount } from '../core/model';

/** Match KeePassProvider's pre-write database scope for both picker and save validation. */
export function withLoginDraftSource(item: LoginItem, provider?: ProviderAccount): LoginItem {
  if (provider?.kind !== 'keepass') return item;
  const databaseId = Number(provider.config.databaseId);
  return { ...item, keepassDatabaseId: Number.isFinite(databaseId) ? databaseId : 0 };
}
