import type { LoginItem, ProviderAccount, TotpItem, VaultItem } from '../core/model';
import { parametersFromItem } from '../core/login-otp';
import { normalizeOtpCounter } from '../core/otp-counter';
import { itemCarriesAuthenticator } from './item-metadata';

/** Select display rows only. Keep the login and its projection in the vault for
 * editing, autofill and lossless provider write-back. Apply after view filters so
 * a filtered-out projection cannot hide a matching login. */
export function selectAuthenticatorItems(items: readonly VaultItem[], providers: readonly ProviderAccount[]): VaultItem[] {
  const active = items.filter(item => !item.deletedAt && !item.archivedAt && itemCarriesAuthenticator(item));
  const bitwardenIds = new Set(providers.filter(provider => provider.kind === 'bitwarden').map(provider => provider.id));
  const source = (item: VaultItem) => {
    // Ambiguous/multiple sources are not proof that two rows are one projection.
    const ref = item.providerRefs.length === 1 ? item.providerRefs[0] : undefined;
    return ref && bitwardenIds.has(ref.providerId) && ref.remoteId ? ref : undefined;
  };
  const projections = new Map<string, TotpItem[]>();
  for (const item of active) {
    if (item.kind !== 'totp') continue;
    const ref = source(item);
    if (!ref?.remoteId?.endsWith('#totp')) continue;
    const parent = ref.remoteId.slice(0, -5);
    if (!parent) continue;
    const key = JSON.stringify([ref.providerId, parent]);
    projections.set(key, [...(projections.get(key) || []), item]);
  }
  return active.filter(item => {
    if (item.kind !== 'login') return true;
    const ref = source(item);
    if (!ref) return true;
    return !projections.get(JSON.stringify([ref.providerId, ref.remoteId]))?.some(projection => sameAuthenticator(item, projection));
  });
}

function sameAuthenticator(login: LoginItem, projection: TotpItem): boolean {
  try {
    const left = parametersFromItem(login), right = parametersFromItem(projection);
    // A pending edit can temporarily leave two versions of the same source.
    // Preserve both when their parameters differ; never compare current codes,
    // titles, account names or secrets alone to establish source identity.
    return left.secret === right.secret && left.algorithm === right.algorithm
      && left.digits === right.digits && left.period === right.period
      && (left.otpType || 'TOTP') === (right.otpType || 'TOTP')
      && (left.secretEncoding || 'base32') === (right.secretEncoding || 'base32')
      && (left.pin || '') === (right.pin || '') && left.pinLength === right.pinLength
      && normalizeOtpCounter(left.counter) === normalizeOtpCounter(right.counter);
  } catch {
    return false;
  }
}
