import type { ProviderAccount } from "../core/model";
import { isRemoteKeePassSource } from "../providers/keepass/keepass-source";

export interface HomeProviderQueue { providerId: string; pending: number; failed: number; recovering?: number }
export interface HomeProviderStatus {
  state: "local" | "syncing" | "conflict" | "confirmation" | "error" | "paused" | "pending" | "file" | "synced" | "never" | "missing";
  count?: number;
  needsAttention: boolean;
}

/** Only status and counts belong on the homepage; raw sync errors can contain credentials or URLs. */
export function homeProviderStatus(provider: ProviderAccount | undefined, queue?: HomeProviderQueue, conflicts = 0, syncing = false): HomeProviderStatus {
  const status = (state: HomeProviderStatus["state"], needsAttention = false, count?: number) => ({ state, needsAttention, count });
  if (!provider) return status("missing", true);
  if (provider.kind === "local") return status("local");
  if (syncing) return status("syncing");
  if (conflicts > 0) return status("conflict", true, conflicts);
  if (provider.requiresEmptyRemoteConfirmation) return status("confirmation", true);
  if (provider.lastError || (queue?.failed || 0) > 0) return status("error", true);
  if (!provider.enabled) return status("paused");
  if ((queue?.pending || 0) > 0) return status("pending", false, queue!.pending);
  if (provider.kind === "keepass" && !isRemoteKeePassSource(provider.config.sourceMode)) return status("file");
  return status(provider.lastSyncAt ? "synced" : "never");
}
