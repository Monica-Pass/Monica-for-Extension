import type { ProviderAccount } from "../../core/model";

export interface BitwardenAccountSyncSummary {
  providerId: string;
  ok: boolean;
  conflicts: number;
  warnings: number;
}

export function bitwardenAccountsForSync(accounts: ProviderAccount[]): ProviderAccount[] {
  return accounts.filter((account) =>
    account.kind === "bitwarden"
    && account.enabled
    && account.config.authenticated === true
  ).map((account, index) => ({ account, index }))
    .sort((left, right) => Number(right.account.isDefaultSaveTarget) - Number(left.account.isDefaultSaveTarget) || left.index - right.index)
    .map(({ account }) => account);
}

export async function syncBitwardenAccountsIsolated(
  accounts: ProviderAccount[],
  synchronize: (account: ProviderAccount) => Promise<{ conflicts: number; warnings: string[] }>
): Promise<BitwardenAccountSyncSummary[]> {
  const summaries: BitwardenAccountSyncSummary[] = [];
  for (const account of bitwardenAccountsForSync(accounts)) {
    try {
      const result = await synchronize(account);
      summaries.push({ providerId: account.id, ok: true, conflicts: result.conflicts, warnings: result.warnings.length });
    } catch {
      summaries.push({ providerId: account.id, ok: false, conflicts: 0, warnings: 0 });
    }
  }
  return summaries;
}
