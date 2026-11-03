import { NEARBY_MANAGER_PORT, type NearbyManagerRequest } from './manager-contract';

export type NearbyManagerCommand = NearbyManagerRequest extends infer T ? T extends { id: number } ? Omit<T, 'id'> : never : never;
export class NearbyManagerClientError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NearbyManagerClientError'; }
}
/** The manager holds only view data. Disconnect rejects every pending request
 * and tears down the background lease; mutations are never replayed silently. */
export class NearbyManagerClient {
  private port?: chrome.runtime.Port;
  private next = 0;
  private pending = new Map<number, { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private dead = false;
  private closeReason = 'connection-closed';
  constructor(private readonly disconnected: (reason: string) => void = () => {}, runtime: Pick<typeof chrome.runtime, 'connect'> = chrome.runtime) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Avoid an unhandled rejection when unmount precedes the first caller.
    void this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.close('connection-timeout'), 10_000);
    try {
      this.port = runtime.connect({ name: NEARBY_MANAGER_PORT });
      this.port.onMessage.addListener(this.message); this.port.onDisconnect.addListener(this.disconnect);
    } catch { this.close('connection-failed'); }
  }
  private disconnect = () => { void chrome.runtime.lastError; this.close('connection-closed'); };
  private message = (value: unknown) => {
    if (!value || typeof value !== "object" || this.dead) return;
    const reply = value as { type?: unknown; id?: unknown; ok?: unknown; data?: unknown; error?: unknown; reason?: unknown };
    if (reply.type === 'ready') { clearTimeout(this.readyTimer); this.resolveReady(); return; }
    if (reply.type === 'closed') { this.close(typeof reply.reason === 'string' ? reply.reason : 'connection-closed'); return; }
    if (typeof reply.id !== 'number') return;
    const request = this.pending.get(reply.id); if (!request) return;
    clearTimeout(request.timer); this.pending.delete(reply.id);
    if (reply.ok === true) request.resolve(reply.data);
    else request.reject(new NearbyManagerClientError(typeof reply.error === 'string' ? reply.error : 'operation-failed'));
  };
  async request<T>(command: NearbyManagerCommand): Promise<T> {
    await this.ready;
    if (this.dead || !this.port) throw new NearbyManagerClientError(this.closeReason);
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.close('operation-timeout'), 180_000);
      this.pending.set(id, { resolve: data => resolve(data as T), reject, timer });
      try { this.port!.postMessage({ ...command, id }); } catch { this.close('connection-closed'); }
    });
  }
  close(reason = 'cancelled'): void {
    if (this.dead) return; this.dead = true; this.closeReason = reason;
    clearTimeout(this.readyTimer); const error = new NearbyManagerClientError(reason); this.rejectReady(error);
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); } this.pending.clear();
    const port = this.port; this.port = undefined;
    if (port) { port.onMessage.removeListener(this.message); port.onDisconnect.removeListener(this.disconnect); try { port.disconnect(); } catch { /* Gone. */ } }
    this.disconnected(reason);
  }
}
