import type { ProviderSourceRecord, VaultItem } from "../../core/model";
import { ProviderTransportError } from "../provider-transport";
import { BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";

export type BitwardenSyncHint = { type: "check-remote" | "full" } | { type: "ciphers"; ids: string[] };
export interface DecodedCipherCacheEntry { fingerprint: string; items: VaultItem[] }

interface RemoteSnapshot {
  binding: string;
  payload: Record<string, unknown>;
  revision?: number;
  revisionUnsupported: boolean;
  fullReadAt: number;
  decoded: Map<string, DecodedCipherCacheEntry>;
  records: Map<string, ProviderSourceRecord>;
}

export interface BitwardenRemoteRead {
  session: BitwardenSessionConfig;
  payload: Record<string, unknown>;
  unchanged: boolean;
  deletedIds: Set<string>;
  decoded: Map<string, DecodedCipherCacheEntry>;
  records: Map<string, ProviderSourceRecord>;
  commit(ciphers: Record<string, unknown>[]): void;
}

const MAX_DELTA_IDS = 64;
const MAX_CACHED_ACCOUNTS = 4;
const FULL_RECONCILE_MS = 15 * 60_000;

/**
 * An unlocked, in-memory remote baseline. A delta always overlays the complete
 * baseline: passing a partial /sync response to the merge would delete other
 * Ciphers. Worker restart, key/server changes and lock all require a full read.
 */
export class BitwardenSyncCache {
  private readonly snapshots = new Map<string, RemoteSnapshot>();
  private generation = 0;

  constructor(private readonly client: BitwardenClient, private readonly now = Date.now) {}

  clear(providerId?: string): void {
    this.generation += 1;
    if (providerId) this.snapshots.delete(providerId);
    else this.snapshots.clear();
  }

  async read(providerId: string, original: BitwardenSessionConfig, hint: BitwardenSyncHint | undefined, mayReuse: boolean, signal?: AbortSignal): Promise<BitwardenRemoteRead> {
    const generation = this.generation;
    const binding = JSON.stringify([original.apiUrl, original.identityUrl, original.email, original.deviceId, original.vaultKeyEnc, original.vaultKeyMac]);
    const previous = this.snapshots.get(providerId);
    const cached = previous?.binding === binding ? previous : undefined;
    let session = original;
    let revision = cached?.revision;
    let revisionUnsupported = cached?.revisionUnsupported ?? false;
    let fullReadAt = cached?.fullReadAt ?? 0;
    let payload: Record<string, unknown> | undefined;
    const deletedIds = new Set<string>();
    let unchanged = false;

    const fresh = cached && this.now() - cached.fullReadAt < FULL_RECONCILE_MS;
    if (hint?.type === "ciphers" && mayReuse && fresh && hint.ids.length > 0 && hint.ids.length <= MAX_DELTA_IDS) {
      const byId = new Map(ciphersOf(cached.payload).map(cipher => [textField(cipher, "Id", "id"), cipher]));
      for (const id of new Set(hint.ids)) {
        signal?.throwIfAborted();
        const response = await this.client.getCipherDetails(session, id, signal);
        session = response.session;
        if (response.payload) byId.set(id, response.payload);
        else { byId.delete(id); deletedIds.add(id); }
      }
      // A Cipher may have moved to a newly shared organization or a new folder.
      // Refresh its key/folder context before attempting decryption.
      const next = withCiphers(cached.payload, [...byId.values()]);
      if (hasOwnerAndFolderContext(next)) payload = next;
    }

    if (!payload && hint && !revisionUnsupported) {
      try {
        // Capture BEFORE /sync. A change during the download must be detected
        // by the next revision check, not accidentally acknowledged afterwards.
        const checked = await this.client.accountRevision(session, signal);
        session = checked.session;
        revision = checked.revision;
        if (hint.type === "check-remote" && mayReuse && fresh && revision === cached.revision) {
          payload = cached.payload;
          unchanged = session.accessToken === original.accessToken && session.refreshToken === original.refreshToken && session.expiresAt === original.expiresAt;
        }
      } catch (error) {
        if (!(error instanceof ProviderTransportError) || (error.status !== 404 && error.status !== 405)) throw error;
        // Older compatible servers can still synchronize through /sync.
        revisionUnsupported = true;
      }
    }

    if (!payload) {
      const response = await this.client.sync(session, signal);
      session = response.session;
      payload = response.payload;
      ciphersOf(payload); // Reject malformed/partial responses, never interpret them as an empty vault.
      fullReadAt = this.now();
      if (!hint) revision = undefined;
      deletedIds.clear();
    }
    signal?.throwIfAborted();
    const selectedPayload = payload;
    const decoded = cached && cryptoContext(cached.payload) === cryptoContext(payload)
      ? new Map(cached.decoded) : new Map<string, DecodedCipherCacheEntry>();
    const records = new Map(cached?.records);
    return {
      session, payload, unchanged, deletedIds, decoded, records,
      commit: ciphers => {
        if (signal?.aborted || generation !== this.generation) return;
        const next = withCiphers(selectedPayload, ciphers);
        // Bound the additional unlocked cache; large vaults safely use full reads.
        if (ciphers.length > 20_000 || JSON.stringify(next).length > 16 * 1024 * 1024) {
          this.snapshots.delete(providerId);
          return;
        }
        const ids = new Set(ciphers.map(cipher => textField(cipher, "Id", "id")));
        for (const id of decoded.keys()) if (!ids.has(id)) decoded.delete(id);
        for (const id of records.keys()) if (!ids.has(id)) records.delete(id);
        this.snapshots.delete(providerId);
        this.snapshots.set(providerId, { binding, payload: next, revision, revisionUnsupported, fullReadAt, decoded, records });
        while (this.snapshots.size > MAX_CACHED_ACCOUNTS) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
    };
  }
}

export function ciphersOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const entries = payload.Ciphers ?? payload.ciphers;
  if (!Array.isArray(entries) || entries.some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("Bitwarden 同步响应不完整，已保留本地数据。");
  const ids = entries.map(value => textField(value, "Id", "id"));
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("Bitwarden 同步响应包含无效或重复的项目标识。");
  return entries as Record<string, unknown>[];
}

function withCiphers(payload: Record<string, unknown>, ciphers: Record<string, unknown>[]): Record<string, unknown> {
  const { Ciphers: _upper, ciphers: _lower, ...context } = payload;
  return { ...context, Ciphers: ciphers };
}

function cryptoContext(payload: Record<string, unknown>): string {
  return JSON.stringify([payload.Profile ?? payload.profile, payload.Folders ?? payload.folders, payload.Organizations ?? payload.organizations]);
}

function hasOwnerAndFolderContext(payload: Record<string, unknown>): boolean {
  const profile = (payload.Profile ?? payload.profile ?? {}) as Record<string, unknown>;
  const organizations = (profile.Organizations ?? profile.organizations ?? payload.Organizations ?? payload.organizations ?? []) as Record<string, unknown>[];
  const folders = (payload.Folders ?? payload.folders ?? []) as Record<string, unknown>[];
  if (!Array.isArray(organizations) || !Array.isArray(folders)) return false;
  const owners = new Set(organizations.map(value => textField(value, "Id", "id")));
  const folderIds = new Set(folders.map(value => textField(value, "Id", "id")));
  return ciphersOf(payload).every(cipher => {
    const owner = textField(cipher, "OrganizationId", "organizationId");
    const folder = textField(cipher, "FolderId", "folderId");
    return (!owner || owners.has(owner)) && (!folder || folderIds.has(folder));
  });
}

function textField(value: Record<string, unknown>, upper: string, lower: string): string {
  const text = value[upper] ?? value[lower];
  return typeof text === "string" ? text : "";
}
