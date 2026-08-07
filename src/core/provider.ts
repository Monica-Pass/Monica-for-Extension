import type { PendingMutation, ProviderAccount, ProviderConflictInput, ProviderKind, ProviderSourceRecord, VaultItem } from "./model";

export interface ProviderAcknowledgedMutation {
  mutationId: string;
  itemId: string;
  operation: PendingMutation["operation"];
  remoteId: string;
}

export interface ProviderSyncContext {
  signal?: AbortSignal;
  now: string;
  localItems: VaultItem[];
  /** Optional bounded mutation batch. Providers that support durable replay must not write other local changes. */
  pendingMutations?: PendingMutation[];
  /** Provider writes already committed before a previous Service Worker stopped. */
  acknowledgedMutations?: ProviderAcknowledgedMutation[];
}

export interface ProviderSyncResult {
  items: VaultItem[];
  accountPatch?: Partial<ProviderAccount>;
  conflicts: ProviderConflictInput[];
  warnings: string[];
  sourceRecords?: ProviderSourceRecord[];
}

export interface ProviderAdapter<TAccount extends ProviderAccount = ProviderAccount> {
  readonly kind: ProviderKind;
  testConnection(account: TAccount, signal?: AbortSignal): Promise<void>;
  sync(account: TAccount, context: ProviderSyncContext): Promise<ProviderSyncResult>;
  create(account: TAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem>;
  update(account: TAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem>;
  remove(account: TAccount, item: VaultItem, signal?: AbortSignal): Promise<void>;
  lock?(): void;
}

export class ProviderRegistry {
  private readonly adapters = new Map<ProviderKind, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: ProviderKind): ProviderAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Provider adapter is not registered: ${kind}`);
    return adapter;
  }
}
