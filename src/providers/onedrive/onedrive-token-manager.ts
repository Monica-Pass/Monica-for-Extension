import { OneDriveAuthClient, OneDriveAuthorizationError, type OneDriveTokens } from "./onedrive-auth";
import type { OneDriveProfile } from "./onedrive-graph-client";

/** Stored only inside the encrypted vault. Same-account reauthorization retains a saved source's ID for durable journals. */
export interface OneDriveConnection {
  id: string;
  clientId: string;
  profile: OneDriveProfile;
  tokens: OneDriveTokens;
}
export type OneDriveConnectionBinding = Pick<OneDriveConnection, "id" | "clientId"> & { accountId: string };

export interface OneDriveTokenStore {
  read(providerId: string): Promise<OneDriveConnection | undefined>;
  /** Atomically check the connection identity AND prior tokens before persisting rotation. */
  rotate(providerId: string, previous: OneDriveConnection, tokens: OneDriveTokens, signal?: AbortSignal): Promise<void>;
}
interface PendingRefresh { connectionId: string; controller: AbortController; promise: Promise<string> }

/** No plaintext persistent cache. Concurrent readers share one refresh; vault lock aborts all of them. */
export class OneDriveTokenManager {
  private epoch = 0;
  private readonly pending = new Map<string, PendingRefresh>();
  constructor(
    private readonly store: OneDriveTokenStore,
    private readonly auth: (clientId: string) => Pick<OneDriveAuthClient, "refresh"> = clientId => new OneDriveAuthClient(clientId),
    private readonly now: () => number = Date.now
  ) {}

  clear(): void {
    this.epoch++;
    for (const refresh of this.pending.values()) refresh.controller.abort();
    this.pending.clear();
  }

  async accessToken(providerId: string, binding: OneDriveConnectionBinding, signal?: AbortSignal): Promise<string> {
    const epoch = this.epoch;
    signal?.throwIfAborted();
    const current = parseOneDriveConnection(await this.store.read(providerId));
    this.assertCurrent(epoch, signal);
    if (!current || !matchesBinding(current, binding)) throw new OneDriveAuthorizationError();
    if (current.tokens.expiresAt > this.now() + 60000) return current.tokens.accessToken;
    let refresh = this.pending.get(providerId);
    if (refresh && refresh.connectionId !== current.id) {
      refresh.controller.abort();
      this.pending.delete(providerId);
      refresh = undefined;
    }
    if (!refresh) {
      const controller = new AbortController();
      const promise = (async () => {
        const tokens = await this.auth(current.clientId).refresh(current.tokens.refreshToken, controller.signal);
        this.assertCurrent(epoch, controller.signal);
        // A removed/replaced provider or another successful rotation must reject this CAS.
        await this.store.rotate(providerId, current, tokens, controller.signal);
        this.assertCurrent(epoch, controller.signal);
        return tokens.accessToken;
      })();
      refresh = { connectionId: current.id, controller, promise };
      this.pending.set(providerId, refresh);
      const clear = () => { if (this.pending.get(providerId)?.promise === promise) this.pending.delete(providerId); };
      void promise.then(clear, clear);
    }
    const token = await waitForCaller(refresh.promise, signal);
    this.assertCurrent(epoch, signal);
    return token;
  }

  private assertCurrent(epoch: number, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.epoch !== epoch) throw new OneDriveAuthorizationError("密码库会话已变化，请重新解锁。");
  }
}

export function oneDriveConnectionBinding(connection: OneDriveConnection): OneDriveConnectionBinding {
  return { id: connection.id, clientId: connection.clientId, accountId: connection.profile.id };
}
export function matchesBinding(connection: OneDriveConnection, binding: OneDriveConnectionBinding): boolean {
  return connection.id === binding.id && connection.clientId === binding.clientId && connection.profile.id === binding.accountId;
}

export function parseOneDriveConnection(value: unknown): OneDriveConnection | undefined {
  if (!object(value) || !object(value.profile) || !object(value.tokens)) return undefined;
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
    typeof value.clientId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value.clientId) ||
    typeof value.profile.id !== "string" || !/^[A-Za-z0-9!_-]{1,256}$/.test(value.profile.id) ||
    !safeText(value.profile.displayName, 256) || !safeText(value.profile.username, 320) || !validOneDriveTokens(value.tokens)) return undefined;
  return { id: value.id, clientId: value.clientId, profile: { id: value.profile.id, displayName: value.profile.displayName, username: value.profile.username },
    tokens: { accessToken: value.tokens.accessToken, refreshToken: value.tokens.refreshToken, expiresAt: value.tokens.expiresAt, scope: value.tokens.scope } };
}

export function validOneDriveTokens(value: unknown): value is OneDriveTokens {
  if (!object(value)) return false;
  return secret(value.accessToken) && secret(value.refreshToken) && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0 &&
    typeof value.scope === "string" && value.scope.length < 4096 && value.scope.split(/\s+/).some(scope => ["files.readwrite", "https://graph.microsoft.com/files.readwrite"].includes(scope.toLowerCase()));
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function safeText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value); }
function secret(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,32768}$/.test(value); }

function waitForCaller<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new DOMException("OneDrive request cancelled", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
