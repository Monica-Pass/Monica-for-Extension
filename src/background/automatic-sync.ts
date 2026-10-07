import type { BitwardenSyncHint } from "../providers/bitwarden/bitwarden-sync-cache";
import type { ProviderAccount } from "../core/model";

/** Connection eligibility only; enabled, paused and unlocked gates remain outside. */
export function mdbx2AutomaticSyncEligible(config: ProviderAccount["config"]): boolean {
  return Boolean(config.vaultHandle && (!config.webDavBaseUrl || config.syncStateHandle && config.remotePath));
}

export interface AutomaticSyncTarget { id: string; intervalMs: number }
export interface AutomaticSyncOutcome { busy?: boolean; morePending?: boolean }
interface Job extends AutomaticSyncTarget {
  nextCheckAt: number;
  pending?: BitwardenSyncHint;
  dueAt: number;
  retryAt: number;
  minimumRetryAt: number;
  failures: number;
  running: boolean;
}

/** One bounded queue for push, edits, focus and alarms. Provider locks remain authoritative. */
export class AutomaticSyncScheduler {
  private readonly jobs = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = 0;

  constructor(
    private readonly execute: (providerId: string, hint: BitwardenSyncHint) => Promise<AutomaticSyncOutcome | void>,
    private readonly now = Date.now,
    private readonly random = Math.random
  ) {}

  configure(targets: AutomaticSyncTarget[]): void {
    const ids = new Set(targets.map(target => target.id));
    for (const id of this.jobs.keys()) if (!ids.has(id)) this.jobs.delete(id);
    for (const target of targets) {
      const existing = this.jobs.get(target.id);
      if (existing) {
        existing.nextCheckAt = Math.min(existing.nextCheckAt, this.now() + target.intervalMs);
        existing.intervalMs = target.intervalMs;
      } else {
        this.jobs.set(target.id, { ...target, nextCheckAt: this.now() + target.intervalMs, dueAt: this.now() + 500, retryAt: 0, minimumRetryAt: 0, failures: 0, running: false, pending: { type: "check-remote" } });
      }
    }
    this.arm();
  }

  request(providerId: string, hint: BitwardenSyncHint = { type: "check-remote" }, debounceMs = 200): void {
    const job = this.jobs.get(providerId);
    if (!job) return;
    job.dueAt = job.pending ? Math.min(job.dueAt, this.now() + debounceMs) : this.now() + debounceMs;
    job.pending = mergeHints(job.pending, hint);
    this.arm();
  }

  wake(hint: BitwardenSyncHint = { type: "check-remote" }): void {
    for (const id of this.jobs.keys()) this.request(id, hint);
  }

  reconnected(providerId?: string): void {
    for (const job of this.jobs.values()) {
      if (providerId && job.id !== providerId) continue;
      // A restored connection can bypass network backoff, but not a server's
      // Retry-After or a failure that needs credentials/configuration repaired.
      job.retryAt = job.minimumRetryAt;
      this.request(job.id, { type: "full" });
    }
  }

  /** Manual completion avoids an immediate duplicate poll while retaining queued push hints. */
  completed(providerId: string): void {
    const job = this.jobs.get(providerId);
    if (!job) return;
    job.nextCheckAt = this.now() + job.intervalMs;
    job.failures = 0;
    job.retryAt = 0;
    job.minimumRetryAt = 0;
    this.arm();
  }

  remove(providerId: string): void {
    this.jobs.delete(providerId);
    this.arm();
  }

  stop(): void {
    this.jobs.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running >= 2) return;
    const due = [...this.jobs.values()].filter(job => !job.running).map(job => Math.max(job.retryAt, job.pending ? job.dueAt : job.nextCheckAt));
    if (!due.length) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, Math.max(0, Math.min(...due) - this.now()));
  }

  private drain(): void {
    const now = this.now();
    const eligible = [...this.jobs.values()]
      .filter(job => !job.running && Math.max(job.retryAt, job.pending ? job.dueAt : job.nextCheckAt) <= now)
      .sort((left, right) => left.dueAt - right.dueAt);
    for (const job of eligible) {
      if (this.running >= 2) break;
      job.running = true;
      this.running += 1;
      const hint = job.pending || { type: "check-remote" as const };
      job.pending = undefined;
      void this.run(job, hint);
    }
    this.arm();
  }

  private async run(job: Job, hint: BitwardenSyncHint): Promise<void> {
    try {
      const outcome = await this.execute(job.id, hint);
      if (this.jobs.get(job.id) !== job) return;
      job.failures = 0;
      job.retryAt = 0;
      job.minimumRetryAt = 0;
      job.nextCheckAt = this.now() + job.intervalMs;
      if (outcome?.busy) {
        job.pending = mergeHints(job.pending, hint);
        job.dueAt = this.now() + 1000;
      } else if (outcome?.morePending) {
        job.pending = mergeHints(job.pending, { type: "full" });
        job.dueAt = this.now() + 500;
      }
    } catch (error) {
      if (this.jobs.get(job.id) !== job) return;
      const failure = error as { retryAfterMs?: number; retryable?: boolean } | undefined;
      job.failures = Math.min(8, job.failures + 1);
      const backoff = failure?.retryable === false ? 15 * 60_000 : Math.min(5 * 60_000, 5000 * 2 ** (job.failures - 1));
      const retryAfter = typeof failure?.retryAfterMs === "number" && Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs) : 0;
      job.minimumRetryAt = this.now() + Math.max(retryAfter, failure?.retryable === false ? backoff : 0);
      job.retryAt = this.now() + Math.max(retryAfter, Math.round(backoff * (1 + this.random() * 0.2)));
      // Once a delta failed, do a complete reconciliation before accepting later hints.
      job.pending = { type: "full" };
      job.dueAt = job.retryAt;
    } finally {
      job.running = false;
      this.running -= 1;
      this.arm();
    }
  }
}

function mergeHints(left: BitwardenSyncHint | undefined, right: BitwardenSyncHint): BitwardenSyncHint {
  if (left?.type === "full" || right.type === "full") return { type: "full" };
  const ids = new Set([...(left?.type === "ciphers" ? left.ids : []), ...(right.type === "ciphers" ? right.ids : [])]);
  if (ids.size > 64) return { type: "full" };
  if (ids.size) return { type: "ciphers", ids: [...ids] };
  return { type: "check-remote" };
}
