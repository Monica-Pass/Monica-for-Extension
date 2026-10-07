import { describe, expect, it, vi } from "vitest";
import type { PasskeyItem, ProviderAccount } from "../core/model";
import { SecureVaultService } from "../security/secure-vault-service";
import { MemoryVaultStorage } from "../security/vault-storage";
import { MemoryVaultSessionStore } from "../security/vault-session";
import { prepareFileAssertion } from "./file-assertion";

const timestamp = "2026-10-05T00:00:00.000Z";
const base: PasskeyItem = { id: "synthetic-key", kind: "passkey", title: "Synthetic", notes: "exact", favorite: false,
  createdAt: timestamp, updatedAt: timestamp, providerRefs: [], credentialId: "AAECAw", rpId: "example.test", rpName: "Synthetic",
  userHandle: "AAE", userName: "synthetic", userDisplayName: "Synthetic", algorithm: -7, publicKey: "", privateKeyPkcs8: "synthetic-test-key",
  signCount: 41, discoverable: true, sourceMode: "browser-local", backupEligible: false, backupState: false };

async function fixture(kind: "keepass" | "mdbx2" | "monica-webdav" = "mdbx2", count = 41) {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const vault = new SecureVaultService(storage, sessions);
  await vault.setup("");
  const account: ProviderAccount = { id: "synthetic-source", kind, name: kind, enabled: true, isDefaultSaveTarget: false,
    config: { vaultHandle: "synthetic-vault", sourceMode: "webdav", remotePath: "synthetic.kdbx", lastFileName: "synthetic.zip" } };
  await vault.upsertProvider(account);
  let remote: PasskeyItem = { ...base, signCount: count, providerRefs: [{ providerId: account.id, remoteId: "remote-key", revision: timestamp }] };
  await vault.applyProviderSync(account.id, [remote]);
  const selected = await vault.getItem(base.id) as PasskeyItem;
  let revision = 0;
  const events: string[] = [];
  const sync = vi.fn(async () => {
    const before = await vault.readState(); events.push("read");
    const pending = before.mutationQueue.find(mutation => mutation.providerId === account.id && mutation.itemId === selected.id);
    if (pending) {
      events.push("write");
      const local = before.items.find(candidate => candidate.id === selected.id) as PasskeyItem;
      remote = { ...local, signCountHighWaterMark: undefined,
        providerRefs: [{ providerId: account.id, remoteId: "remote-key", revision: `${timestamp}:${++revision}` }] };
    }
    await vault.applyProviderSync(account.id, [structuredClone(remote)], undefined, [], undefined, before.items);
    if (pending) events.push("acknowledged");
  });
  return { storage, sessions, vault, account, selected, sync, events, remote: () => remote,
    setRemote: (patch: Partial<PasskeyItem>) => { remote = { ...remote, ...patch }; } };
}

describe("file-source positive Passkey assertion coordination", () => {
  it.each(["keepass", "mdbx2", "monica-webdav"] as const)("refreshes %s then persists and acknowledges the increment", async kind => {
    const f = await fixture(kind); f.setRemote({ signCount: 90 });
    const result = await prepareFileAssertion(f.selected, f.vault, f.sync, async () => undefined);
    expect(result).toMatchObject({ signCount: 91, signCountHighWaterMark: 91, notes: "exact", backupEligible: false, backupState: false });
    expect(f.events).toEqual(["read", "read", "write", "acknowledged"]);
    expect(f.remote().signCount).toBe(91);
    expect((await f.vault.readState()).mutationQueue).toEqual([]);
    await f.vault.lock(); await f.vault.unlock("");
    expect(await f.vault.getItem(base.id)).toMatchObject({ signCount: 91, signCountHighWaterMark: 91 });
  });

  it("keeps zero available without invoking a network write", async () => {
    const f = await fixture("keepass", 0);
    expect(await prepareFileAssertion(f.selected, f.vault, f.sync, async () => undefined)).toMatchObject({ signCount: 0 });
    expect(f.sync).not.toHaveBeenCalled();
  });

  it.each([0, 40])("rejects a remote counter regression to %s without writing", async signCount => {
    const f = await fixture(); f.setRemote({ signCount });
    await expect(prepareFileAssertion(f.selected, f.vault, f.sync, async () => undefined)).rejects.toThrow("回退");
    expect(f.events).toEqual(["read"]);
  });

  it("retains an interrupted encrypted reservation and recovers it before another increment", async () => {
    const f = await fixture();
    const fail = vi.fn(async () => { if (fail.mock.calls.length === 2) throw new Error("synthetic transport failure"); await f.sync(); });
    await expect(prepareFileAssertion(f.selected, f.vault, fail, async () => undefined)).rejects.toThrow("transport failure");
    expect(await f.vault.getItem(base.id)).toMatchObject({ signCount: 42 });
    expect((await f.vault.readState()).mutationQueue).toHaveLength(1);
    await f.vault.lock(); await f.vault.unlock("");
    const selected = await f.vault.getItem(base.id) as PasskeyItem;
    expect(await prepareFileAssertion(selected, f.vault, f.sync, async () => undefined)).toMatchObject({ signCount: 43 });
    expect(f.remote().signCount).toBe(43);
  });

  it("requires the queued counter to be acknowledged rather than accepting a successful callback", async () => {
    const f = await fixture();
    const sync = vi.fn(async () => { if (sync.mock.calls.length === 1) await f.sync(); });
    await expect(prepareFileAssertion(f.selected, f.vault, sync, async () => undefined)).rejects.toThrow("未完成");
    expect(f.remote().signCount).toBe(41);
  });

  it("allocates again when an identical count was merged after another client already committed it", async () => {
    const f = await fixture();
    const sync = vi.fn(async () => { await f.sync(); return { sourceWriteRebased: sync.mock.calls.length === 2 }; });
    expect(await prepareFileAssertion(f.selected, f.vault, sync, async () => undefined)).toMatchObject({ signCount: 43 });
    expect(f.remote().signCount).toBe(43);
    expect(f.events.filter(event => event === "write")).toHaveLength(2);
  });

  it("bounds repeated concurrent rebases without authorizing a signature", async () => {
    const f = await fixture();
    const sync = vi.fn(async () => { await f.sync(); return { sourceWriteRebased: true }; });
    await expect(prepareFileAssertion(f.selected, f.vault, sync, async () => undefined)).rejects.toThrow("持续修改");
    expect(sync).toHaveBeenCalledTimes(4); expect(f.remote().signCount).toBe(44);
  });

  it("rejects cancellation after a committed source write", async () => {
    const f = await fixture(); const controller = new AbortController();
    const sync = async () => { await f.sync(); if (f.events.includes("acknowledged")) controller.abort(new Error("synthetic cancellation")); };
    await expect(prepareFileAssertion(f.selected, f.vault, sync, async () => undefined, controller.signal)).rejects.toThrow("cancellation");
    expect(f.remote().signCount).toBe(42);
  });

  it.each(["replacement", "disabled", "identity", "conflict"] as const)("rejects %s during source refresh", async change => {
    const f = await fixture();
    const sync = async () => {
      await f.sync();
      if (change === "replacement") await f.vault.upsertProvider({ ...f.account, config: { ...f.account.config, vaultHandle: "other-vault" } });
      if (change === "disabled") await f.vault.upsertProvider({ ...f.account, enabled: false });
      if (change === "identity") f.setRemote({ credentialId: "BAUG" });
      if (change === "identity") await f.sync();
      if (change === "conflict") await f.vault.applyProviderSync(f.account.id, [f.selected], undefined, [{ itemId: base.id, local: f.selected, remote: f.selected, reason: "Synthetic conflict" }]);
    };
    await expect(prepareFileAssertion(f.selected, f.vault, sync, async () => undefined)).rejects.toThrow(/变化|冲突/);
    expect(f.events).not.toContain("write");
  });

  it("does not reserve a counter on encrypted storage failure", async () => {
    const f = await fixture();
    const sync = async () => { await f.sync(); vi.spyOn(f.storage, "write").mockRejectedValueOnce(new Error("synthetic disk failure")); };
    await expect(prepareFileAssertion(f.selected, f.vault, sync, async () => undefined)).rejects.toThrow("disk failure");
    expect(f.remote().signCount).toBe(41);
    expect(await f.vault.getItem(base.id)).toMatchObject({ signCount: 41 });
  });
});
