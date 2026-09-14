import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PasskeyItem, ProviderAccount } from "../core/model";
import { BitwardenProvider } from "../providers/bitwarden/bitwarden-provider";
import { BitwardenDurableSyncCoordinator } from "../providers/bitwarden/bitwarden-durable-sync";
import { decodeBitwardenCipher, encodeBitwardenPasskeyCipher } from "../providers/bitwarden/bitwarden-cipher-codec";
import { encryptBitwardenString, type BitwardenSymmetricKey } from "../providers/bitwarden/bitwarden-crypto";
import { SecureVaultService } from "../security/secure-vault-service";
import { MemoryVaultSessionStore } from "../security/vault-session";
import { MemoryVaultStorage } from "../security/vault-storage";
import { prepareBitwardenAssertion } from "./bitwarden-assertion";
import { createAssertion, createPasskey } from "./webauthn-core";

const KEY: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(31), macKey: new Uint8Array(32).fill(47) };
const REVISION = "2026-09-14T00:00:00.000Z";
const challenge = Buffer.alloc(32, 7).toString("base64url");
const account: ProviderAccount = {
  id: "bw-counter-test", kind: "bitwarden", name: "Synthetic Bitwarden", enabled: true, isDefaultSaveTarget: false,
  config: {
    vaultUrl: "https://bitwarden.example.com", apiUrl: "https://bitwarden.example.com/api", identityUrl: "https://bitwarden.example.com/identity",
    email: "synthetic@example.com", deviceId: "synthetic-device", accessToken: "synthetic-token", refreshToken: "synthetic-refresh",
    expiresAt: Number.MAX_SAFE_INTEGER, kdf: { type: 0, iterations: 100_000 },
    vaultKeyEnc: Buffer.from(KEY.encKey).toString("base64"), vaultKeyMac: Buffer.from(KEY.macKey).toString("base64")
  }
};

async function fixture(initialCounter: number, options: { revisionPolicy?: "strict" | "one-second"; parallelWrites?: boolean } = {}) {
  const key = await createPasskey({ origin: "https://example.com", challenge, rpName: "Example", userId: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithms: [-7], excludeCredentialIds: [] });
  const item: PasskeyItem = {
    id: "test-passkey", kind: "passkey", title: "Example", favorite: false, notes: "", createdAt: REVISION, updatedAt: REVISION,
    providerRefs: [], credentialId: key.credentialId, rpId: "example.com", rpName: "Example", userHandle: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic",
    algorithm: -7, publicKey: key.publicKeySpki, privateKeyPkcs8: key.privateKeyPkcs8, signCount: initialCounter, discoverable: true, sourceMode: "bitwarden"
  };
  let raw = await encodeBitwardenPasskeyCipher(item, KEY, {
    Id: "test-cipher", Type: 1, Name: await encryptBitwardenString("Parent login", KEY), Notes: await encryptBitwardenString("parent notes", KEY),
    Favorite: true, RevisionDate: REVISION, CreationDate: REVISION, FutureCipherField: "preserve-me",
    Login: { Username: await encryptBitwardenString("parent user", KEY), Password: await encryptBitwardenString("parent password", KEY), Uris: [] }
  });
  raw = await encodeBitwardenPasskeyCipher({ ...item, credentialId: Buffer.alloc(32, 9).toString("base64url"), signCount: 21 }, KEY, raw);
  raw = { ...raw, Id: "test-cipher", RevisionDate: REVISION, CreationDate: REVISION };
  let revision = 0;
  const events: string[] = [];
  let failWrite = false;
  let loseResponse = false;
  let race = false;
  let arrivedWrites = 0;
  let releaseWrites = () => {};
  const bothWriters = new Promise<void>(resolve => { releaseWrites = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("/sync")) { events.push("read"); return json({ Profile: { Id: "synthetic-user" }, Ciphers: [raw] }); }
    if (String(input).endsWith("/ciphers/test-cipher") && init?.method === "PUT") {
      events.push("write");
      const payload = JSON.parse(String(init.body));
      if (failWrite) return json({ Message: "synthetic server failure" }, 503);
      if (race) { race = false; raw.RevisionDate = "2026-09-14T01:00:00.000Z"; }
      if (options.parallelWrites) {
        if (++arrivedWrites === 2) releaseWrites();
        await bothWriters;
      }
      // The exact-match model is a control, not the official server's guarantee.
      const stale = options.revisionPolicy === "one-second"
        ? Math.abs(Date.parse(payload.lastKnownRevisionDate) - Date.parse(String(raw.RevisionDate))) > 1000
        : payload.lastKnownRevisionDate !== raw.RevisionDate;
      if (stale) return json({ Message: "The cipher has been modified." }, 400);
      raw = { ...payload, Id: "test-cipher", RevisionDate: new Date(Date.parse(REVISION) + ++revision * 200).toISOString(), CreationDate: REVISION };
      events.push("acknowledged");
      if (loseResponse) { loseResponse = false; throw new TypeError("synthetic response loss"); }
      return json(raw);
    }
    throw new Error("Unexpected synthetic endpoint");
  };
  const makeClient = async () => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("");
    await vault.upsertProvider(account);
    const sync = new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), vault);
    await sync.synchronize(account);
    const selected = (await vault.listItems()).find((candidate): candidate is PasskeyItem => candidate.kind === "passkey" && candidate.credentialId === item.credentialId)!;
    return { vault, sync, selected };
  };
  const client = await makeClient();
  events.length = 0;
  return {
    ...client, makeClient, key, item, events, fetcher,
    setFailWrite: (value: boolean) => { failWrite = value; },
    loseResponse: () => { loseResponse = true; },
    race: () => { race = true; },
    remote: async () => decodeBitwardenCipher(raw, account.id, KEY),
    raw: () => raw,
    setRemoteCounter: async (counter: number) => {
      raw = await encodeBitwardenPasskeyCipher({ ...item, signCount: counter }, KEY, raw);
      raw.RevisionDate = new Date(Date.parse(REVISION) + ++revision * 1000).toISOString();
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function signed(item: PasskeyItem) {
  return createAssertion({ origin: "https://example.com", challenge, rpId: item.rpId, credentialId: item.credentialId, userHandle: item.userHandle, privateKeyPkcs8: item.privateKeyPkcs8!, signCount: item.signCount, userVerified: true });
}

describe("Bitwarden official assertion counter policy", () => {
  it("keeps zero offline, saves only local usage, and does not queue a Cipher write", async () => {
    const f = await fixture(0);
    const selected = await prepareBitwardenAssertion(f.selected, f.vault, f.sync, async () => undefined);
    const assertion = await signed(selected);
    await f.vault.recordPasskeyUse(selected.id, "2026-09-14T02:00:00.000Z", selected);
    expect(Buffer.from(assertion.response.authenticatorData, "base64url").readUInt32BE(33)).toBe(0);
    expect(f.events).toEqual([]);
    expect((await f.vault.readState()).mutationQueue).toEqual([]);
    expect(await f.vault.getItem(selected.id)).toMatchObject({ useCount: 1, signCount: 0, updatedAt: selected.updatedAt });
    await f.sync.synchronize(account);
    expect(f.events).toEqual(["read"]);
    expect(await f.vault.getItem(selected.id)).toMatchObject({ useCount: 1 });
  });

  it("refreshes a stale positive counter and commits before signing while preserving the parent and siblings", async () => {
    const f = await fixture(3);
    await f.setRemoteCounter(9000);
    const selected = await prepareBitwardenAssertion(f.selected, f.vault, f.sync, async () => undefined);
    expect(selected.signCount).toBe(9001);
    expect(f.events).toEqual(["read", "read", "write", "acknowledged"]);
    const assertion = await signed(selected);
    const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
    expect(authData.readUInt32BE(33)).toBe(9001);
    const bytes = Buffer.concat([authData, createHash("sha256").update(Buffer.from(assertion.response.clientDataJSON, "base64url")).digest()]);
    expect(verify("sha256", bytes, createPublicKey({ key: Buffer.from(f.key.publicKeySpki, "base64"), format: "der", type: "spki" }), Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
    const remote = await f.remote();
    expect(remote.items.find(item => item.kind === "login")).toMatchObject({ username: "parent user", password: "parent password", notes: "parent notes" });
    expect(remote.items.filter(item => item.kind === "passkey").map(item => item.signCount).sort((a, b) => a - b)).toEqual([21, 9001]);
    expect(f.raw().futureCipherField).toBe("preserve-me");
    expect((await f.vault.readState()).mutationQueue).toEqual([]);
  });

  it("refreshes counters between sequential, alternating clients", async () => {
    const f = await fixture(9000);
    const other = await f.makeClient();
    for (const [index, client] of [f, other, f, other].entries()) {
      const item = await prepareBitwardenAssertion(client.selected, client.vault, client.sync, async () => undefined);
      expect((await signed(item)).signCount).toBe(9001 + index);
    }
  }, 15_000);

  it.each([0, 2])("rejects a known counter of 8 falling to %s before or during authentication", async remoteCounter => {
    const f = await fixture(8);
    await f.setRemoteCounter(remoteCounter);
    const sign = vi.fn(signed);
    await expect(prepareBitwardenAssertion(f.selected, f.vault, f.sync, async () => undefined).then(sign)).rejects.toThrow(/回退|冲突/);
    expect(sign).not.toHaveBeenCalled();
    expect(f.events).toEqual(["read"]);
    expect(await f.vault.getItem(f.selected.id)).toMatchObject({ signCount: 8 });

    // Background refreshes and encrypted-vault reloads must not erase the evidence.
    await f.sync.synchronize(account, undefined, { readOnly: true });
    await f.vault.lock();
    await f.vault.unlock("");
    const selected = (await f.vault.getItem(f.selected.id)) as PasskeyItem;
    await expect(prepareBitwardenAssertion(selected, f.vault, f.sync, async () => undefined).then(sign)).rejects.toThrow(/回退|冲突/);
    expect(sign).not.toHaveBeenCalled();
    expect(f.events).not.toContain("write");
    expect((await f.vault.readState()).mutationQueue).toEqual([]);

    // A later forward remote value can recover without changing the credential.
    await f.setRemoteCounter(9);
    const recovered = await prepareBitwardenAssertion(selected, f.vault, f.sync, async () => undefined);
    expect(recovered.signCount).toBe(10);
  });

  it("retains history when resolving a regression with the remote version", async () => {
    const f = await fixture(8);
    await f.setRemoteCounter(0);
    await f.sync.synchronize(account, undefined, { readOnly: true });
    const conflict = (await f.vault.listProviderConflicts(account.id)).find(entry => entry.itemId === f.selected.id);
    expect(conflict).toBeDefined();
    await f.vault.resolveProviderConflict(conflict!.id, "use-remote");
    await f.vault.lock();
    await f.vault.unlock("");
    const selected = (await f.vault.getItem(f.selected.id)) as PasskeyItem;
    expect(selected).toMatchObject({ signCount: 0, signCountHighWaterMark: 8 });
    const sign = vi.fn(signed);
    await expect(prepareBitwardenAssertion(selected, f.vault, f.sync, async () => undefined).then(sign)).rejects.toThrow("回退");
    expect(sign).not.toHaveBeenCalled();
    expect(f.events).not.toContain("write");
  });

  it("blocks writes of the whole affected Cipher and retains pending parent edits", async () => {
    const f = await fixture(8);
    const parent = (await f.vault.listItems()).find(candidate => candidate.kind === "login")!;
    await f.vault.upsertItem({ ...parent, notes: "pending parent edit" });
    await f.setRemoteCounter(0);
    await f.sync.synchronize(account);
    expect(f.events).toEqual(["read"]);
    expect(await f.vault.getItem(parent.id)).toMatchObject({ notes: "pending parent edit" });
    expect((await f.vault.readState()).mutationQueue).toEqual([expect.objectContaining({ itemId: parent.id, operation: "update" })]);
    expect(await f.vault.getItem(f.selected.id)).toMatchObject({ signCount: 8 });
  });

  it("allows an explicitly deleted historical credential to be removed without rewriting its siblings", async () => {
    const f = await fixture(8);
    await f.setRemoteCounter(0);
    await f.sync.synchronize(account, undefined, { readOnly: true });
    const conflict = (await f.vault.listProviderConflicts(account.id)).find(entry => entry.itemId === f.selected.id)!;
    await f.vault.resolveProviderConflict(conflict.id, "use-remote");
    await f.vault.deleteItem(f.selected.id);
    await f.sync.synchronize(account);
    const remote = await f.remote();
    expect(remote.items.filter(item => item.kind === "passkey").map(item => item.signCount)).toEqual([21]);
    expect(remote.items.find(item => item.kind === "login")).toMatchObject({ username: "parent user", password: "parent password" });
    expect((await f.vault.readState()).mutationQueue).toEqual([]);
  });

  it("remembers a higher remote counter observed during a conflicting local edit", async () => {
    const f = await fixture(8);
    await f.vault.upsertItem({ ...f.selected, userDisplayName: "Edited locally" });
    await f.setRemoteCounter(9);
    await f.sync.synchronize(account);
    expect(await f.vault.getItem(f.selected.id)).toMatchObject({ signCount: 8, signCountHighWaterMark: 9 });
    const conflict = (await f.vault.listProviderConflicts(account.id)).find(entry => entry.itemId === f.selected.id)!;
    await f.vault.resolveProviderConflict(conflict.id, "keep-local");
    await f.sync.synchronize(account);
    expect(f.events).not.toContain("write");
    expect((await f.vault.readState()).mutationQueue).toHaveLength(1);

    const remaining = (await f.vault.listProviderConflicts(account.id)).find(entry => entry.itemId === f.selected.id)!;
    await f.vault.resolveProviderConflict(remaining.id, "use-remote");
    const selected = (await f.vault.getItem(f.selected.id)) as PasskeyItem;
    expect((await prepareBitwardenAssertion(selected, f.vault, f.sync, async () => undefined)).signCount).toBe(10);
  });

  it.each(["strict", "one-second"] as const)("documents simultaneous writes with the %s revision model", async revisionPolicy => {
    const f = await fixture(5, { revisionPolicy, parallelWrites: true });
    const other = await f.makeClient();
    const outcomes = await Promise.allSettled([f, other].map(async client => {
      const item = await prepareBitwardenAssertion(client.selected, client.vault, client.sync, async () => undefined);
      return (await signed(item)).signCount;
    }));
    const fulfilled = outcomes.filter((result): result is PromiseFulfilledResult<number> => result.status === "fulfilled");
    // A server that accepts nearby revisions can acknowledge both counters. The
    // client cannot claim globally unique allocation from a successful PUT alone.
    expect(fulfilled.map(result => result.value)).toEqual(revisionPolicy === "strict" ? [6] : [6, 6]);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(revisionPolicy === "strict" ? 1 : 0);
  });

  it("preserves unrelated pending edits during authentication refresh and counter commit", async () => {
    const f = await fixture(2);
    const other = { ...f.item, id: "other-pending", credentialId: Buffer.alloc(32, 8).toString("base64url"), providerRefs: [{ providerId: account.id }], signCount: 0 };
    await f.vault.upsertItem(other);
    await prepareBitwardenAssertion(f.selected, f.vault, f.sync, async () => undefined);
    expect((await f.vault.readState()).mutationQueue).toEqual([expect.objectContaining({ itemId: other.id, operation: "create" })]);
    expect(await f.vault.getItem(other.id)).toMatchObject({ credentialId: other.credentialId });
  });

  it.each(["failure", "conflict", "lost-response"] as const)("does not authorize a signature on %s", async mode => {
    const f = await fixture(7);
    if (mode === "failure") f.setFailWrite(true);
    if (mode === "conflict") f.race();
    if (mode === "lost-response") f.loseResponse();
    const sign = vi.fn(signed);
    await expect(prepareBitwardenAssertion(f.selected, f.vault, f.sync, async () => undefined).then(sign)).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
    expect((await f.vault.readState()).mutationQueue).toHaveLength(1);
    expect(await f.vault.getItem(f.selected.id)).not.toHaveProperty("lastUsedAt");
    if (mode === "lost-response") {
      const recovered = await prepareBitwardenAssertion(f.selected, f.vault, f.sync, async () => undefined);
      expect(recovered.signCount).toBe(9);
      expect((await f.vault.readState()).mutationQueue).toEqual([]);
    }
  });

  it("discards the result if cancellation arrives after the server commit", async () => {
    const f = await fixture(10);
    const sign = vi.fn(signed);
    const assertActive = async () => { if (f.events.includes("acknowledged")) throw new DOMException("cancelled", "AbortError"); };
    await expect(prepareBitwardenAssertion(f.selected, f.vault, f.sync, assertActive).then(sign)).rejects.toThrow("cancelled");
    expect(sign).not.toHaveBeenCalled();
    expect((await f.remote()).items.find(item => item.kind === "passkey" && item.credentialId === f.selected.credentialId)).toMatchObject({ signCount: 11 });
  });

  it("does not sign a key changed remotely during refresh", async () => {
    const f = await fixture(10);
    const sync = { synchronize: async () => {
      await f.vault.upsertItem({ ...f.selected, userHandle: "Y2hhbmdlZA" });
      return { items: [], conflicts: [], warnings: [] };
    } };
    await expect(prepareBitwardenAssertion(f.selected, f.vault, sync, async () => undefined)).rejects.toThrow("已变化");
    expect(f.events).toEqual([]);
  });
});
