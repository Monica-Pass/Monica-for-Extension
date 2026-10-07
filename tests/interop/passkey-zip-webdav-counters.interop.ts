import { expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PasskeyItem, ProviderAccount } from "../../src/core/model";
import { prepareFileAssertion } from "../../src/passkey/file-assertion";
import { createAssertion } from "../../src/passkey/webauthn-core";
import { SecureVaultService } from "../../src/security/secure-vault-service";
import { MemoryVaultStorage } from "../../src/security/vault-storage";
import { MemoryVaultSessionStore } from "../../src/security/vault-session";
import { MonicaWebDavProvider } from "../../src/providers/webdav/monica-webdav-provider";
import { WebDavClient } from "../../src/providers/webdav/webdav-client";
import { decryptAndroidBackup } from "../../src/providers/webdav/android-backup-crypto";
import { readAndroidBackup } from "../../src/providers/webdav/android-backup-codec";

const output = process.env.MONICA_317_ZIP_WEBDAV_COUNTER_OUTPUT;
const password = "Synthetic ZIP network counter password";
const challenge = Buffer.alloc(32, 53).toString("base64url");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(algorithm: -7 | -257) {
  if (!output) throw new Error("Explicit synthetic output required");
  const services = JSON.parse(await readFile(".tmp/interop-315-docker/services.json", "utf8"));
  expect(services.webdav.baseUrl).toBe("http://127.0.0.1:18315");
  const remotePath = `zip-counter-${randomUUID()}`;
  const baseUrl = `${services.webdav.baseUrl}/${remotePath}`;
  const credentials = { ...services.webdav, baseUrl };
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  expect((await fetch(baseUrl, { method: "MKCOL", headers: { authorization }, redirect: "error" })).status).toBe(201);
  const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account: ProviderAccount = { id: "seed", kind: "monica-webdav", name: "Synthetic ZIP", enabled: true, isDefaultSaveTarget: false,
    config: { ...credentials, backupPassword: password } };
  const original: PasskeyItem = { id: randomUUID(), kind: "passkey", title: "Synthetic ZIP network history", notes: "exact notes", favorite: false,
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", providerRefs: [{ providerId: account.id }],
    credentialId: Buffer.from(randomUUID()).toString("base64url"), rpId: "zip-counter.example.test", rpName: "Synthetic ZIP",
    userHandle: "AAEC_w", userName: "synthetic", userDisplayName: "Synthetic", algorithm, signCount: 41, discoverable: true,
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), sourceMode: "browser-local", backupEligible: false, backupState: false };
  await new MonicaWebDavProvider().create(account, original);
  const calls: { client: string; method: string; status?: number }[] = [];
  const open = async (name: string, intercept?: (init: RequestInit | undefined, next: () => Promise<Response>) => Promise<Response>) => {
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore()); await vault.setup("");
    let currentAccount = { ...account, id: name };
    await vault.upsertProvider(currentAccount);
    const provider = new MonicaWebDavProvider(async (request, init) => {
      const call = { client: name, method: init?.method || "GET", status: undefined as number | undefined }; calls.push(call);
      const next = async () => { const response = await fetch(request, init); call.status = response.status; return response; };
      return intercept ? intercept(init, next) : next();
    });
    const sync = async () => {
      const state = await vault.readState();
      const result = await provider.sync(currentAccount, { localItems: structuredClone(state.items), pendingMutations: state.mutationQueue, now: new Date().toISOString() });
      await vault.applyProviderSync(currentAccount.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, state.items);
      currentAccount = (await vault.readState()).providers.find(row => row.id === name)!;
      return result;
    };
    await sync();
    return { vault, sign: async () => {
      const selected = (await vault.listItems()).find((item): item is PasskeyItem => item.kind === "passkey")!;
      const item = await prepareFileAssertion(selected, vault, sync, async () => undefined);
      expect(item).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, algorithm,
        userHandle: original.userHandle, notes: original.notes, backupEligible: false, backupState: false });
      const assertion = await createAssertion({ origin: `https://${original.rpId}`, challenge, rpId: item.rpId, credentialId: item.credentialId,
        userHandle: item.userHandle, algorithm, privateKeyPkcs8: item.privateKeyPkcs8!, signCount: item.signCount,
        backupEligible: false, backupState: false, userVerified: true });
      const auth = Buffer.from(assertion.response.authenticatorData, "base64url"), client = Buffer.from(assertion.response.clientDataJSON, "base64url");
      expect(auth[32]).toBe(5); expect(auth.readUInt32BE(33)).toBe(item.signCount);
      expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), pair.publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
      return item.signCount;
    } };
  };
  const read = async () => {
    const client = new WebDavClient(credentials), files = await client.listBackups();
    const encrypted = await client.download(files[0]);
    const document = readAndroidBackup(await decryptAndroidBackup(encrypted, password), "independent", { allowPortablePasskeys: true });
    expect(document.items).toHaveLength(1);
    const item = document.items[0] as PasskeyItem;
    expect(item).toMatchObject({ kind: "passkey", credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, algorithm, notes: original.notes });
    return { count: item.signCount, files: files.map(file => file.name), encrypted, sha256: hash(encrypted) };
  };
  return { open, read, remotePath, calls };
}

it.skipIf(!output).each([
  { mode: "alternating", algorithm: -7 }, { mode: "alternating", algorithm: -257 },
  { mode: "lost-response", algorithm: -7 }, { mode: "simultaneous", algorithm: -7 }
] as const)("real encrypted ZIP WebDAV: $mode $algorithm", async ({ mode, algorithm }) => {
  const f = await fixture(algorithm); await mkdir(output!, { recursive: true });
  const report: Record<string, unknown> = { status: "failed", mode, algorithm, remotePath: f.remotePath, calls: f.calls,
    network: "Real isolated Apache and encrypted Android ZIP; fetch-boundary fault injection only" };
  try {
    if (mode === "alternating") {
      const a = await f.open("a"), b = await f.open("b");
      report.counts = [await a.sign(), await b.sign(), await a.sign()]; expect(report.counts).toEqual([42, 43, 44]);
    } else if (mode === "lost-response") {
      let lost = false;
      const a = await f.open("a", async (init, next) => {
        const response = await next();
        if (init?.method === "PUT" && response.ok && !lost) { lost = true; await response.arrayBuffer(); throw new TypeError("Synthetic lost response after actual ZIP upload"); }
        return response;
      });
      report.counts = [await a.sign()]; expect(lost).toBe(true); expect(report.counts).toEqual([42]);
      expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    } else {
      let arrived = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const make = (name: string) => {
        let first = true;
        return f.open(name, async (init, next) => {
          if (init?.method === "PUT" && first) { first = false; if (++arrived === 2) release(); await gate; }
          return next();
        });
      };
      const a = await make("a"), b = await make("b");
      const results = await Promise.allSettled([a.sign(), b.sign()]);
      report.results = results.map(row => row.status === "fulfilled" ? { status: row.status, count: row.value } : { status: row.status, error: String(row.reason) });
      const counts = results.flatMap(row => row.status === "fulfilled" ? [row.value] : []); report.counts = counts;
      expect(new Set(counts).size, "Concurrent ZIP clients must not sign the same positive counter").toBe(counts.length);
      for (const [index, client] of [a, b].entries()) if (results[index].status === "rejected") {
        const retained = await client.vault.readState();
        expect(retained.mutationQueue).toHaveLength(1);
        expect(retained.items[0]).toMatchObject({ kind: "passkey", signCount: 42 });
      }
      // Both clients may safely reject the contested publication. A fresh
      // source read must still allow a later login without reusing a counter.
      const recovery = await f.open("recovery");
      const resumed = await recovery.sign();
      expect(resumed).toBeGreaterThan(42); expect(counts).not.toContain(resumed);
      report.counts = [...counts, resumed]; report.recoveredAfterConflict = true;
    }
    const returned = await f.read(); expect(returned.count).toBe(Math.max(...report.counts as number[]));
    await writeFile(join(output!, `${mode}-${algorithm}.enc.zip`), returned.encrypted);
    Object.assign(report, { status: "passed", remoteCount: returned.count, remoteSha256: returned.sha256, backupFiles: returned.files });
  } catch (error) { report.error = String(error); throw error; }
  finally { await writeFile(join(output!, `${mode}-${algorithm}-evidence.json`), JSON.stringify(report, null, 2)); }
});
