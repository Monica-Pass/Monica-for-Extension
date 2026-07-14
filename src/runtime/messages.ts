import type { LoginItem, VaultItem } from "../core/model";
import type { VaultLifecycleStatus } from "../security/secure-vault-service";

export interface LoginMatchSummary {
  id: string;
  title: string;
  username: string;
  favorite: boolean;
  uris: string[];
}

export type ExtensionRequest =
  | { type: "VAULT_STATUS" }
  | { type: "VAULT_SETUP"; masterPassword: string }
  | { type: "VAULT_UNLOCK"; masterPassword: string }
  | { type: "VAULT_LOCK" }
  | { type: "VAULT_LIST_ITEMS" }
  | { type: "VAULT_GET_ITEM"; itemId: string }
  | { type: "VAULT_UPSERT_ITEM"; item: VaultItem }
  | { type: "VAULT_DELETE_ITEM"; itemId: string }
  | { type: "VAULT_MATCH_LOGINS"; pageUrl: string }
  | { type: "VAULT_FILL_LOGIN"; itemId: string; tabId: number };

export type ExtensionResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export type VaultStatusResponse = VaultLifecycleStatus;

// Type-only re-exports keep UI imports centered on the runtime contract.
export type { LoginItem, VaultItem };
