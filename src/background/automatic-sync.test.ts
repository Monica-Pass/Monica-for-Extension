import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomaticSyncScheduler } from "./automatic-sync";
import type { BitwardenSyncHint } from "../providers/bitwarden/bitwarden-sync-cache";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => vi.useRealTimers());

describe("automatic source synchronization", () => {
  it("coalesces a burst into one bounded Cipher delta", async () => {
    const execute = vi.fn(async () => undefined);
    const scheduler = new AutomaticSyncScheduler(execute);
    scheduler.configure([{ id: "bw", intervalMs: 60_000 }]);
    scheduler.request("bw", { type: "ciphers", ids: ["one"] });
    scheduler.request("bw", { type: "ciphers", ids: ["one", "two"] });
    scheduler.request("bw", { type: "check-remote" });
    await vi.advanceTimersByTimeAsync(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith("bw", { type: "ciphers", ids: ["one", "two"] });
    scheduler.stop();
  });

  it("reconciles fully instead of retaining unbounded notifications", async () => {
    const execute = vi.fn(async () => undefined);
    const scheduler = new AutomaticSyncScheduler(execute);
    scheduler.configure([{ id: "bw", intervalMs: 60_000 }]);
    for (let i = 0; i < 200; i++) scheduler.request("bw", { type: "ciphers", ids: [`cipher-${i}`] });
    await vi.advanceTimersByTimeAsync(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith("bw", { type: "full" });
    scheduler.stop();
  });

  it("runs at most two accounts and retains hints arriving during a run", async () => {
    const releases: Array<() => void> = [];
    const execute = vi.fn((_providerId: string, _hint: BitwardenSyncHint) => new Promise<void>(resolve => releases.push(resolve)));
    const scheduler = new AutomaticSyncScheduler(execute);
    scheduler.configure(["a", "b", "c"].map(id => ({ id, intervalMs: 60_000 })));
    await vi.advanceTimersByTimeAsync(500);
    expect(execute.mock.calls.map(args => args[0])).toEqual(["a", "b"]);
    scheduler.request("a", { type: "ciphers", ids: ["changed-during-read"] });
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(200);
    expect(execute.mock.calls.map(args => args[0])).toEqual(["a", "b", "c"]);
    releases.shift()!();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute.mock.calls[3]).toEqual(["a", { type: "ciphers", ids: ["changed-during-read"] }]);
    scheduler.stop();
    releases.forEach(release => release());
  });

  it("defers to the existing provider/Passkey lock without dropping the notification", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ busy: true }).mockResolvedValue({});
    const scheduler = new AutomaticSyncScheduler(execute);
    scheduler.configure([{ id: "bw", intervalMs: 60_000 }]);
    scheduler.request("bw", { type: "ciphers", ids: ["locked-cipher"] });
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute.mock.calls).toEqual([
      ["bw", { type: "ciphers", ids: ["locked-cipher"] }],
      ["bw", { type: "ciphers", ids: ["locked-cipher"] }]
    ]);
    scheduler.stop();
  });

  it("respects Retry-After even if focus and notifications keep arriving", async () => {
    const execute = vi.fn().mockRejectedValueOnce({ retryable: true, retryAfterMs: 30_000 }).mockResolvedValue({});
    const scheduler = new AutomaticSyncScheduler(execute, Date.now, () => 0);
    scheduler.configure([{ id: "bw", intervalMs: 60_000 }]);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.wake();
    scheduler.reconnected("bw");
    scheduler.request("bw", { type: "ciphers", ids: ["next"] });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(execute.mock.calls[1]).toEqual(["bw", { type: "full" }]);
    scheduler.stop();
  });

  it("continues a bounded mutation batch and cancels follow-up work on lock", async () => {
    const execute = vi.fn().mockResolvedValue({ morePending: true });
    const scheduler = new AutomaticSyncScheduler(execute);
    scheduler.configure([{ id: "bw", intervalMs: 60_000 }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles promptly after a connection returns without waiting out network backoff", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const scheduler = new AutomaticSyncScheduler(execute, Date.now, () => 0);
    scheduler.configure([{ id: "bw", intervalMs: 60_000 }]);
    await vi.advanceTimersByTimeAsync(500);
    scheduler.reconnected("bw");
    await vi.advanceTimersByTimeAsync(200);
    expect(execute.mock.calls).toEqual([["bw", { type: "check-remote" }], ["bw", { type: "full" }]]);
    scheduler.stop();
  });

  it("keeps a failing account from delaying healthy accounts", async () => {
    const execute = vi.fn(async (id: string) => { if (id === "broken") throw { retryable: false }; });
    const scheduler = new AutomaticSyncScheduler(execute, Date.now, () => 0);
    scheduler.configure([{ id: "broken", intervalMs: 15_000 }, { id: "healthy", intervalMs: 15_000 }]);
    await vi.advanceTimersByTimeAsync(30_500);
    expect(execute.mock.calls.filter(args => args[0] === "broken")).toHaveLength(1);
    expect(execute.mock.calls.filter(args => args[0] === "healthy")).toHaveLength(3);
    scheduler.stop();
  });

  it("removes a locked database immediately while other sources keep syncing", async () => {
    const execute = vi.fn(async () => undefined);
    const scheduler = new AutomaticSyncScheduler(execute);
    scheduler.configure([{ id: "locked", intervalMs: 15_000 }, { id: "open", intervalMs: 15_000 }]);
    scheduler.request("locked", { type: "ciphers", ids: ["pending"] });
    scheduler.remove("locked");
    await vi.advanceTimersByTimeAsync(15_500);
    expect(execute.mock.calls).toEqual([["open", { type: "check-remote" }], ["open", { type: "check-remote" }]]);
    scheduler.stop();
  });
});
