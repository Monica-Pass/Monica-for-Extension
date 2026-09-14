import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoginItem, ProviderAccount, VaultItem } from "../../core/model";
import { bytesToBase64 } from "../../security/encoding";
import * as codec from "./bitwarden-cipher-codec";
import { encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenProvider } from "./bitwarden-provider";
import type { ProviderSyncContext, ProviderSyncResult } from "../../core/provider";

const KEY: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(12) };
const BASE = "2026-09-14T00:00:00.000Z";
const NEXT = "2026-09-14T00:01:00.000Z";
afterEach(() => vi.restoreAllMocks());

async function fixture(count = 2) {
  const ciphers = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < count; index++) ciphers.set(`cipher-${index}`, await cipher(`cipher-${index}`, `Password ${index}`, BASE));
  let revision = 1;
  let folders: Record<string, unknown>[] = [];
  let duringFullRead: (() => void) | undefined;
  const paths: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith("/accounts/revision-date")) return json(revision);
    if (url.pathname.endsWith("/sync")) {
      const payload = { Profile: { Id: "synthetic-user" }, Folders: folders, Ciphers: [...ciphers.values()] };
      duringFullRead?.();
      duringFullRead = undefined;
      return json(payload);
    }
    const id = /\/ciphers\/([^/]+)\/details$/.exec(url.pathname)?.[1];
    if (id) return json(ciphers.get(id) ?? {}, ciphers.has(id) ? 200 : 404);
    throw new Error("Unexpected synthetic request");
  }) as unknown as typeof fetch;
  const account: ProviderAccount = {
    id: "bw", kind: "bitwarden", name: "Synthetic", enabled: true, isDefaultSaveTarget: false,
    config: { vaultUrl: "https://synthetic.example.test", apiUrl: "https://synthetic.example.test/api", identityUrl: "https://synthetic.example.test/identity", email: "synthetic@example.test", deviceId: "synthetic-device", accessToken: "synthetic-token", expiresAt: Date.now() + 3600_000, kdf: { type: 0, iterations: 10_000 }, vaultKeyEnc: bytesToBase64(KEY.encKey), vaultKeyMac: bytesToBase64(KEY.macKey) }
  };
  const provider = new BitwardenProvider(fetcher);
  let items: VaultItem[] = [];
  const sync = async (hint: ProviderSyncContext["syncHint"] = { type: "full" }): Promise<ProviderSyncResult> => {
    const result = await provider.sync(account, { now: NEXT, localItems: items, pendingMutations: [], syncHint: hint });
    if (!result.unchanged) { items = result.items; Object.assign(account, result.accountPatch); }
    return result;
  };
  return { ciphers, paths, provider, account, sync, bump: () => { revision++; }, duringNextFullRead: (task: () => void) => { duringFullRead = task; }, setFolders: (value: Record<string, unknown>[]) => { folders = value; }, items: () => items };
}

describe("Bitwarden incremental reads", () => {
  it("downloads, decrypts and fingerprints only the changed Cipher, retaining every other item", async () => {
    const f = await fixture(20);
    await f.sync();
    f.paths.length = 0;
    f.ciphers.set("cipher-3", await cipher("cipher-3", "Edited on Android", NEXT));
    const decode = vi.spyOn(codec, "decodeBitwardenCipher");
    const digest = vi.spyOn(crypto.subtle, "digest");
    const result = await f.sync({ type: "ciphers", ids: ["cipher-3"] });
    expect(f.paths).toEqual(["/api/ciphers/cipher-3/details"]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(20);
    expect(result.items.find(item => item.title === "cipher-3")).toMatchObject({ password: "Edited on Android" });
    expect(result.items.find(item => item.title === "cipher-19")).toMatchObject({ password: "Password 19" });
  });

  it("checks an unchanged account without downloading or decrypting the vault", async () => {
    const f = await fixture(); await f.sync(); f.paths.length = 0;
    const decode = vi.spyOn(codec, "decodeBitwardenCipher");
    const result = await f.sync({ type: "check-remote" });
    expect(result.unchanged).toBe(true);
    expect(f.paths).toEqual(["/api/accounts/revision-date"]);
    expect(decode).not.toHaveBeenCalled();
  });

  it("accepts a confirmed deletion of the last Cipher without accepting an unverified empty sync", async () => {
    const f = await fixture(1); await f.sync(); f.paths.length = 0;
    f.ciphers.delete("cipher-0");
    const delta = await f.sync({ type: "ciphers", ids: ["cipher-0"] });
    expect(delta.items).toEqual([]);
    expect(delta.confirmedRemovedItemIds).toHaveLength(1);
    expect(delta.conflicts).toEqual([]);
    expect(f.paths).toEqual(["/api/ciphers/cipher-0/details"]);

    const other = await fixture(1); await other.sync(); other.ciphers.clear();
    const unverified = await other.sync();
    expect(unverified.items).toHaveLength(1);
    expect(unverified.accountPatch?.requiresEmptyRemoteConfirmation).toBe(true);
  });

  it("confirms a reordered delete against the current server instead of deleting a restored item", async () => {
    const f = await fixture(); await f.sync();
    f.ciphers.set("cipher-0", await cipher("cipher-0", "Restored on phone", NEXT));
    const result = await f.sync({ type: "ciphers", ids: ["cipher-0"] });
    expect(result.items).toHaveLength(2);
    expect(result.items.find(item => item.title === "cipher-0")).toMatchObject({ password: "Restored on phone" });
  });

  it("fully reconciles a missed revision and discards its cache on lock", async () => {
    const f = await fixture(); await f.sync(); f.paths.length = 0;
    f.bump(); f.ciphers.set("cipher-1", await cipher("cipher-1", "Missed while offline", NEXT));
    await f.sync({ type: "check-remote" });
    expect(f.paths).toEqual(["/api/accounts/revision-date", "/api/sync"]);
    f.provider.lock(); f.paths.length = 0;
    await f.sync({ type: "ciphers", ids: ["cipher-1"] });
    expect(f.paths).toEqual(["/api/accounts/revision-date", "/api/sync"]);
  });

  it("loads new folder context before applying a Cipher delta", async () => {
    const f = await fixture(); await f.sync(); f.paths.length = 0;
    f.setFolders([{ Id: "phone-folder", Name: await encryptBitwardenString("Phone folder", KEY) }]);
    f.ciphers.set("cipher-0", { ...await cipher("cipher-0", "Moved on phone", NEXT), FolderId: "phone-folder" });
    const result = await f.sync({ type: "ciphers", ids: ["cipher-0"] });
    expect(f.paths).toContain("/api/sync");
    expect(result.items.find(item => item.title === "cipher-0")).toMatchObject({ categoryName: "Phone folder" });
  });

  it("does not let a trashed item disable incremental synchronization for the whole account", async () => {
    const f = await fixture();
    f.ciphers.get("cipher-1")!.DeletedDate = BASE;
    await f.sync(); f.paths.length = 0;
    f.ciphers.set("cipher-0", await cipher("cipher-0", "Live item changed", NEXT));
    await f.sync({ type: "ciphers", ids: ["cipher-0"] });
    expect(f.paths).toEqual(["/api/ciphers/cipher-0/details"]);
    expect(f.items().find(item => item.title === "cipher-1")?.deletedAt).toBe(BASE);
  });

  it("rejects a malformed full response without treating omitted Ciphers as deletion", async () => {
    const f = await fixture(); await f.sync();
    const broken = new BitwardenProvider(async () => json({ Profile: { Id: "synthetic-user" } }));
    await expect(broken.sync(f.account, { now: NEXT, localItems: f.items(), pendingMutations: [] })).rejects.toThrow("不完整");
  });

  it("does not reuse another server's cached baseline", async () => {
    const f = await fixture(); await f.sync(); f.paths.length = 0;
    f.account.config.apiUrl = "https://replacement.example.test/api";
    await f.sync({ type: "ciphers", ids: ["cipher-1"] });
    expect(f.paths).toContain("/api/sync");
  });

  it("does not acknowledge an edit that arrived while the full snapshot was downloading", async () => {
    const f = await fixture();
    const edited = await cipher("cipher-0", "Changed during download", NEXT);
    f.duringNextFullRead(() => { f.bump(); f.ciphers.set("cipher-0", edited); });
    await f.sync();
    expect(f.items().find(item => item.title === "cipher-0")).toMatchObject({ password: "Password 0" });
    f.paths.length = 0;
    await f.sync({ type: "check-remote" });
    expect(f.paths).toEqual(["/api/accounts/revision-date", "/api/sync"]);
    expect(f.items().find(item => item.title === "cipher-0")).toMatchObject({ password: "Changed during download" });
  });
});

async function cipher(id: string, password: string, revision: string): Promise<Record<string, unknown>> {
  const item: LoginItem = { id, kind: "login", title: id, username: "synthetic", password, uris: ["https://example.test"], customFields: [], favorite: false, notes: "", createdAt: BASE, updatedAt: revision, providerRefs: [] };
  return { ...await codec.encodeBitwardenCipher(item, KEY), id, revisionDate: revision, creationDate: BASE };
}
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
