import { expect, it } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PasskeyItem, ProviderAccount } from "../../src/core/model";
import { prepareFileAssertion } from "../../src/passkey/file-assertion";
import { createAssertion } from "../../src/passkey/webauthn-core";
import { SecureVaultService } from "../../src/security/secure-vault-service";
import { MemoryVaultStorage } from "../../src/security/vault-storage";
import { MemoryVaultSessionStore } from "../../src/security/vault-session";
import { KeePassProvider } from "../../src/providers/keepass/keepass-provider";
import { buildKeePassFixture } from "../../src/providers/keepass/keepass-fixture";
import { KeePassRemoteSessionService } from "../../src/providers/keepass/keepass-remote-session";
import { KeePassDurableSyncCoordinator } from "../../src/providers/keepass/keepass-durable-sync";
import { KeePassWebDavClient } from "../../src/providers/keepass/keepass-webdav-client";
import { MemoryKeePassWorkingCopyStorage } from "../../src/providers/keepass/keepass-working-copy-store";

const output = process.env.MONICA_317_REAL_WEBDAV_COUNTER_OUTPUT;
const password = "Synthetic network counter database password";
const challenge = Buffer.alloc(32, 29).toString("base64url");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  if (!output) throw new Error("Explicit synthetic output required");
  const services = JSON.parse(await readFile(".tmp/interop-315-docker/services.json", "utf8"));
  expect(services.webdav.baseUrl).toBe("http://127.0.0.1:18315");
  const remotePath = `counter-${randomUUID()}/vault.kdbx`;
  const url = `${services.webdav.baseUrl}/${remotePath}`;
  const authorization = `Basic ${Buffer.from(`${services.webdav.username}:${services.webdav.password}`).toString("base64")}`;
  expect((await fetch(url.slice(0, url.lastIndexOf("/")), { method: "MKCOL", headers: { authorization } })).status).toBe(201);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const seedAccount: ProviderAccount = { id: "seed", kind: "keepass", name: "Synthetic", enabled: true, isDefaultSaveTarget: false, config: {} };
  const original: PasskeyItem = { id: randomUUID(), kind: "passkey", title: "Synthetic network history", notes: "exact notes", favorite: false,
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", providerRefs: [{ providerId: seedAccount.id }],
    credentialId: Buffer.from(randomUUID()).toString("base64url"), rpId: "network-counter.example.test", rpName: "Synthetic network",
    userHandle: "AAEC_w", userName: "synthetic", userDisplayName: "Synthetic", algorithm: -7, signCount: 41, discoverable: true,
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), sourceMode: "browser-local", backupEligible: false, backupState: false };
  const seed = new KeePassProvider(); await seed.unlock(seedAccount, await buildKeePassFixture({ password, entries: [] }), { password });
  await seed.create(seedAccount, original);
  expect((await fetch(url, { method: "PUT", headers: { authorization, "If-None-Match": "*" }, body: Uint8Array.from(await seed.exportFile(seedAccount.id)) })).status).toBe(201);
  seed.lock();
  const calls: { client: string; method: string; status?: number; ifMatch?: string | null }[] = [];
  const open = async (name: string, intercept?: (request: RequestInfo | URL, init: RequestInit | undefined, next: () => Promise<Response>) => Promise<Response>) => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore()); await vault.setup("");
    const provider = new KeePassProvider();
    let account: ProviderAccount = { ...seedAccount, id: name };
    const fetcher: typeof fetch = async (request, init) => {
      const call = { client: name, method: init?.method || "GET", ifMatch: new Headers(init?.headers).get("If-Match"), status: undefined as number | undefined };
      calls.push(call);
      const next = async () => { const response = await fetch(request, init); call.status = response.status; return response; };
      return intercept ? intercept(request, init, next) : next();
    };
    const sessions = new KeePassRemoteSessionService(provider, new MemoryKeePassWorkingCopyStorage(), config => new KeePassWebDavClient(config, fetcher));
    const opened = await sessions.open(account, { baseUrl: services.webdav.baseUrl, username: services.webdav.username,
      webDavPassword: services.webdav.password, remotePath, databasePassword: password });
    account = { ...account, config: opened.accountConfig }; await vault.upsertProvider(account);
    const coordinator = new KeePassDurableSyncCoordinator(provider, sessions, vault, async (_before, config) => {
      account = { ...account, config }; await vault.upsertProvider(account, false); return account;
    });
    const sync = () => coordinator.synchronize(account);
    await sync();
    return { vault, provider, sign: async () => {
      const selected = (await vault.listItems()).find((item): item is PasskeyItem => item.kind === "passkey")!;
      const item = await prepareFileAssertion(selected, vault, sync, async () => undefined);
      expect(item.privateKeyPkcs8).toBe(original.privateKeyPkcs8); expect(item.credentialId).toBe(original.credentialId);
      const assertion = await createAssertion({ origin: `https://${original.rpId}`, challenge, rpId: item.rpId, credentialId: item.credentialId,
        userHandle: item.userHandle, algorithm: item.algorithm, privateKeyPkcs8: item.privateKeyPkcs8!, signCount: item.signCount,
        backupEligible: item.backupEligible, backupState: item.backupState, userVerified: true });
      const auth = Buffer.from(assertion.response.authenticatorData, "base64url"), client = Buffer.from(assertion.response.clientDataJSON, "base64url");
      expect(auth[32]).toBe(5); expect(auth.readUInt32BE(33)).toBe(item.signCount);
      expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), createPublicKey({ key: Buffer.from(original.publicKey!, "base64"), type: "spki", format: "der" }), Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
      return item.signCount;
    } };
  };
  const read = async () => {
    const response = await fetch(url, { headers: { authorization } }); expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const reader = new KeePassProvider(); await reader.unlock(seedAccount, bytes, { password });
    const item = (await reader.sync(seedAccount, { localItems: [], now: new Date().toISOString() })).items[0] as PasskeyItem;
    expect(item.credentialId).toBe(original.credentialId); expect(item.privateKeyPkcs8).toBe(original.privateKeyPkcs8); reader.lock();
    return { count: item.signCount, sha256: hash(bytes), bytes };
  };
  return { calls, open, read, remotePath };
}

it.skipIf(!output).each(["alternating", "simultaneous", "stale-reservation", "lost-response"] as const)("real Apache counter history: %s", async mode => {
  const f = await fixture(); await mkdir(output!, { recursive: true });
  const report: Record<string, unknown> = { status: "failed", mode, remotePath: f.remotePath, network: "real isolated Apache; fault injected only at fetch boundary", calls: f.calls };
  try {
    if (mode === "alternating") {
      const a = await f.open("a"), b = await f.open("b");
      const counts = [await a.sign(), await b.sign(), await a.sign()]; expect(counts).toEqual([42, 43, 44]); report.counts = counts;
    } else if (mode === "lost-response") {
      let lost = false;
      const a = await f.open("a", async (_request, init, next) => {
        const response = await next();
        if (init?.method === "PUT" && response.ok && !lost) { lost = true; await response.arrayBuffer(); throw new TypeError("Synthetic response lost after real server commit"); }
        return response;
      });
      expect(await a.sign()).toBe(42); expect(lost).toBe(true);
      expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1); report.counts = [42];
    } else {
      let arrived = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let completeFirst!: () => void;
      const firstComplete = new Promise<void>(resolve => { completeFirst = resolve; });
      const make = (name: string) => {
        let first = true;
        return f.open(name, async (_request, init, next) => {
          if (init?.method === "PUT" && first) {
            first = false; if (++arrived === 2) release(); await gate;
            if (mode === "stale-reservation" && name === "b") await firstComplete;
          }
          return next();
        });
      };
      const a = await make("a"), b = await make("b");
      const results = await Promise.allSettled([a.sign().finally(completeFirst), b.sign()]);
      const counts = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      report.results = results.map(result => result.status === "fulfilled" ? { status: result.status, count: result.value } : { status: result.status, error: String(result.reason) });
      expect(counts.length).toBeGreaterThan(0);
      expect(new Set(counts).size, "Two simultaneous clients must not return the same positive counter").toBe(counts.length);
      if (mode === "stale-reservation") expect(f.calls.some(call => call.status === 412)).toBe(true);
      report.serverReturnedPreconditionFailure = f.calls.some(call => call.status === 412);
      report.counts = counts;
    }
    const remote = await f.read();
    expect(remote.count).toBe(Math.max(...report.counts as number[]));
    await writeFile(join(output!, `${mode}.kdbx`), remote.bytes);
    Object.assign(report, { status: "passed", remoteCount: remote.count, remoteSha256: remote.sha256 });
  } catch (error) { report.error = String(error); throw error; }
  finally { await writeFile(join(output!, `${mode}-evidence.json`), JSON.stringify(report, null, 2)); }
});
