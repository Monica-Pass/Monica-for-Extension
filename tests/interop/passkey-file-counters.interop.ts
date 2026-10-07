import { expect, it } from "vitest";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PasskeyItem, ProviderAccount } from "../../src/core/model";
import type { ProviderAdapter } from "../../src/core/provider";
import { prepareFileAssertion } from "../../src/passkey/file-assertion";
import { createAssertion } from "../../src/passkey/webauthn-core";
import { SecureVaultService } from "../../src/security/secure-vault-service";
import { MemoryVaultStorage } from "../../src/security/vault-storage";
import { MemoryVaultSessionStore } from "../../src/security/vault-session";
import { KeePassProvider } from "../../src/providers/keepass/keepass-provider";
import { buildKeePassFixture } from "../../src/providers/keepass/keepass-fixture";
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from "../../src/providers/keepass/keepass-remote-session";
import { KeePassDurableSyncCoordinator } from "../../src/providers/keepass/keepass-durable-sync";
import { MemoryKeePassWorkingCopyStorage } from "../../src/providers/keepass/keepass-working-copy-store";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { Mdbx2Provider } from "../../src/providers/mdbx2/mdbx2-provider";
import { ProcessNativeRuntime } from "./mdbx2-interop-support";

const output = process.env.MONICA_317_FILE_COUNTER_OUTPUT;
const input = process.env.MONICA_317_FILE_COUNTER_MDBX;
const password = "Synthetic transfer fixture password";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const challenge = Buffer.alloc(32, 13).toString("base64url");
function key(algorithm: -7 | -257, account: ProviderAccount): PasskeyItem {
  const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { id: randomUUID(), kind: "passkey", title: `Synthetic counter ${algorithm}`, notes: "exact\r\n notes", favorite: false,
    createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", providerRefs: [{ providerId: account.id }],
    credentialId: Buffer.from(randomUUID()).toString("base64url"), rpId: "counter.example.test", rpName: "Synthetic counter",
    userHandle: "AAEC_w", userName: `synthetic-${algorithm}`, userDisplayName: "Synthetic", algorithm, signCount: 41,
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKeyPkcs8: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    backupEligible: false, backupState: false, discoverable: true, sourceMode: "browser-local" };
}
async function verifyKey(item: PasskeyItem, original: PasskeyItem) {
  expect(item).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8,
    userHandle: original.userHandle, algorithm: original.algorithm, notes: original.notes, signCount: 42, backupEligible: false, backupState: false });
  const signed = await createAssertion({ origin: "https://counter.example.test", challenge, rpId: item.rpId, credentialId: item.credentialId,
    userHandle: item.userHandle, privateKeyPkcs8: item.privateKeyPkcs8!, algorithm: item.algorithm,
    signCount: item.signCount, backupEligible: item.backupEligible, backupState: item.backupState, userVerified: true });
  const auth = Buffer.from(signed.response.authenticatorData, "base64url"), client = Buffer.from(signed.response.clientDataJSON, "base64url");
  expect(auth[32]).toBe(5); expect(auth.readUInt32BE(33)).toBe(42);
  expect(verify("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]),
    createPublicKey({ key: Buffer.from(original.publicKey!, "base64"), type: "spki", format: "der" }), Buffer.from(signed.response.signature, "base64url"))).toBe(true);
  return { algorithm: item.algorithm, credentialId: item.credentialId, counter: 42, flags: auth[32], signatureVerified: true };
}

it.skipIf(!output || !input).each(["keepass", "mdbx2", "webdav", "onedrive"] as const)("persists positive counters through actual %s adapter and independent reopen", async kind => {
  if (!output || !input) throw new Error("Explicit synthetic roots required");
  await mkdir(output, { recursive: true }); const directory = await mkdtemp(join(output, kind));
  let client: Mdbx2NativeClient | undefined;
  const report: Record<string, unknown> = { status: "failed", kind, scope: "Actual encrypted file/provider/signature/reopen, synthetic keys; not Android or Edge UI" };
  try {
    let provider: ProviderAdapter;
    const remote = kind === "webdav" || kind === "onedrive";
    let account: ProviderAccount = { id: `synthetic-${kind}`, kind: kind === "mdbx2" ? "mdbx2" : "keepass", name: kind, enabled: true, isDefaultSaveTarget: false, config: {} };
    if (kind !== "mdbx2") {
      const adapter = new KeePassProvider();
      await adapter.unlock(account, await buildKeePassFixture({ password, entries: [] }), { password }); provider = adapter;
    } else {
      const executable = resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe");
      report.hostSha256 = hash(await readFile(executable));
      client = new Mdbx2NativeClient(new ProcessNativeRuntime(executable, directory));
      const bytes = await readFile(input); report.inputSha256 = hash(bytes);
      const transfer = await client.beginInboundTransfer(bytes.length, hash(bytes));
      for (let offset = 0; offset < bytes.length;) offset = (await client.sendInboundChunk(transfer.transferId, offset, bytes.subarray(offset, offset + transfer.maxChunkBytes))).nextOffset;
      const inbound = await client.finishInboundTransfer(transfer.transferId);
      const opened = await client.openVault({ kind: "file", handle: inbound.fileHandle }, { method: "password", password });
      account = { ...account, config: { vaultHandle: opened.vaultHandle, nativeVaultId: opened.vaultId } }; provider = new Mdbx2Provider(client);
    }
    const originals = ([-7, -257] as const).map(algorithm => key(algorithm, account));
    for (const original of originals) await provider.create(account, original);
    const storage = new MemoryVaultStorage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
    let remoteBytes: Uint8Array | undefined, remoteWrites = 0, coordinator: KeePassDurableSyncCoordinator | undefined;
    if (remote) {
      remoteBytes = await (provider as KeePassProvider).exportFile(account.id);
      const copyStorage = new MemoryKeePassWorkingCopyStorage();
      const stat = () => ({ url: "https://synthetic.example.test/counter.kdbx", fileName: "counter.kdbx", etag: `"version-${remoteWrites}"`, sizeBytes: remoteBytes!.length });
      const remoteClient: KeePassRemoteFileClient = {
        async testConnection() {}, async stat() { return stat(); },
        async read() { return { ...stat(), bytes: remoteBytes!.slice(), sha256: hash(remoteBytes!) }; },
        async write(bytes, expectedEtag) {
          expect(expectedEtag).toBe(stat().etag);
          remoteBytes = bytes.slice(); remoteWrites++;
          return { ...stat(), bytes: remoteBytes.slice(), sha256: hash(remoteBytes), alreadyApplied: false };
        }
      };
      const adapter = new KeePassProvider();
      const sessions = new KeePassRemoteSessionService(adapter, copyStorage, () => remoteClient, () => remoteClient);
      if (kind === "onedrive") account.config.oneDriveConnection = { id: "synthetic-connection", clientId: "synthetic-client", profile: { id: "synthetic-account" } };
      const opened = kind === "onedrive"
        ? await sessions.openOneDrive(account, { driveId: "synthetic-drive", itemId: "synthetic-item", databasePassword: password })
        : await sessions.open(account, { baseUrl: "https://synthetic.example.test", remotePath: "counter.kdbx", username: "synthetic", webDavPassword: "synthetic", databasePassword: password });
      account = { ...account, config: opened.accountConfig }; provider = adapter;
      coordinator = new KeePassDurableSyncCoordinator(adapter, sessions, vault, async (_original, config) => {
        account = { ...account, config }; await vault.upsertProvider(account, false); return account;
      });
      report.transport = "Simulated conditional remote file I/O; real encrypted KDBX, durable session, receipt and synchronization coordinator. No Microsoft/network acceptance.";
    }
    await vault.setup(password); await vault.upsertProvider(account);
    const sync = async () => {
      if (coordinator) { await coordinator.synchronize(account); return; }
      const state = await vault.readState();
      const result = await provider.sync(account, { localItems: structuredClone(state.items), pendingMutations: state.mutationQueue, now: new Date().toISOString() });
      await vault.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, state.items);
    };
    await sync();
    const signatures = [];
    for (const original of originals) {
      const selected = (await vault.listItems()).find((item): item is PasskeyItem => item.kind === "passkey" && item.credentialId === original.credentialId)!;
      const current = await prepareFileAssertion(selected, vault, sync, async () => undefined);
      signatures.push(await verifyKey(current, original));
    }
    expect((await vault.readState()).mutationQueue).toEqual([]);
    await writeFile(join(directory, "encrypted-envelope.json"), JSON.stringify(storage.envelope));
    if (kind !== "mdbx2") {
      const bytes = remote ? remoteBytes! : await (provider as KeePassProvider).exportFile(account.id);
      if (remote) { expect(remoteWrites).toBe(2); report.conditionalRemoteWrites = remoteWrites; }
      await writeFile(join(directory, "returned.kdbx"), bytes); report.returnSha256 = hash(bytes);
      const reopened = new KeePassProvider(); await reopened.unlock(account, bytes, { password }); provider = reopened;
    } else {
      client!.close();
      client = new Mdbx2NativeClient(new ProcessNativeRuntime(resolve("native/mdbx2-host/target/debug/monica-mdbx2-host.exe"), directory));
      const opened = await client.openVault({ kind: "vault", handle: account.config.vaultHandle as string }, { method: "password", password });
      expect(opened.vaultId).toBe(account.config.nativeVaultId);
      account = { ...account, config: { ...account.config, vaultHandle: opened.vaultHandle } }; provider = new Mdbx2Provider(client);
    }
    const readback = await provider.sync(account, { localItems: [], now: new Date().toISOString() });
    for (const original of originals) await verifyKey(readback.items.find((item): item is PasskeyItem => item.kind === "passkey" && item.credentialId === original.credentialId)!, original);
    Object.assign(report, { status: "passed", signatures, independentFileReopenVerified: true });
  } catch (error) { report.error = String(error); throw error; }
  finally { client?.close(); await writeFile(join(directory, "evidence.json"), JSON.stringify(report, null, 2)); }
});
