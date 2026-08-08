import type { PendingMutation, ProviderAccount, ProviderConflictInput, ProviderKind, ProviderMutationReceipt, ProviderSourceRecord, VaultItem } from "./model";

export interface ProviderAcknowledgedMutation {
  mutationId: string;
  itemId: string;
  operation: PendingMutation["operation"];
  remoteId: string;
  /** The committed intent was recovered, but a newer local edit still needs another write. */
  followUp?: boolean;
}

/**
 * A provider-discovered local normalization that must be written through the
 * same durable mutation queue as an explicit user edit. The request contains
 * only stable routing metadata; the encrypted vault remains authoritative for
 * the item payload.
 */
export interface ProviderRequestedMutation {
  itemId: string;
  operation: PendingMutation["operation"];
}

export interface ProviderSyncContext {
  signal?: AbortSignal;
  now: string;
  localItems: VaultItem[];
  /** Optional bounded mutation batch. Providers that support durable replay must not write other local changes. */
  pendingMutations?: PendingMutation[];
  /** Provider writes already committed before a previous Service Worker stopped. */
  acknowledgedMutations?: ProviderAcknowledgedMutation[];
  /** Encrypted durable intents prepared before provider writes begin. */
  mutationReceipts?: ProviderMutationReceipt[];
  /** Must be awaited immediately before the provider starts a remote write. */
  markMutationsAttempted?: (mutationIds: string[]) => Promise<void>;
}

export interface ProviderSyncResult {
  items: VaultItem[];
  accountPatch?: Partial<ProviderAccount>;
  conflicts: ProviderConflictInput[];
  warnings: string[];
  sourceRecords?: ProviderSourceRecord[];
  acknowledgedMutations?: ProviderAcknowledgedMutation[];
  requestedMutations?: ProviderRequestedMutation[];
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
