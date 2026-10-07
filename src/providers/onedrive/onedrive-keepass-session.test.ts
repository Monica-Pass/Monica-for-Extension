import { describe, expect, it, vi } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign, verify } from "node:crypto";
import * as kdbxweb from "kdbxweb";
import type { PasskeyItem, ProviderAccount } from "../../core/model";
import { sameProviderBinding } from "../../core/provider";
import { SecureVaultService } from "../../security/secure-vault-service";
import { MemoryVaultStorage } from "../../security/vault-storage";
import { MemoryVaultSessionStore } from "../../security/vault-session";
import { KeePassProvider } from "../keepass/keepass-provider";
import { KeePassRemoteSessionService } from "../keepass/keepass-remote-session";
import { MemoryKeePassWorkingCopyStorage } from "../keepass/keepass-working-copy-store";
import { buildKeePassFixture, keePassCredentials } from "../keepass/keepass-fixture";
import { OneDriveGraphClient, OneDriveKeePassFileClient } from "./onedrive-graph-client";
import { MONICA_ONEDRIVE_CLIENT_ID } from "./onedrive-auth";

const PASSWORD = "synthetic KDBX password";
const NOW = "2026-10-05T00:00:00.000Z";
const identity = { driveId: "drive1", itemId: "item1" };
const connection = { id: "connection1", clientId: MONICA_ONEDRIVE_CLIENT_ID, profile: { id: "user1", displayName: "Synthetic account", username: "test@example.invalid" },
  tokens: { accessToken: "synthetic-secret-access", refreshToken: "synthetic-secret-refresh", expiresAt: 9999999999999, scope: "Files.ReadWrite" } };
const baseAccount = (): ProviderAccount => ({ id: "onedrive-kdbx", kind: "keepass", name: "OneDrive KDBX", enabled: true, isDefaultSaveTarget: false,
  config: { databaseId: 42, oneDriveConnection: structuredClone(connection) } });

/** Fake Graph wire; KDBX encryption, source codecs, receipts and provider lifecycle are real. */
async function setup() {
  const remote = { bytes: await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Before", fields: { UserName: "base-user" } }] }), version: 1, puts: 0, conditionalRequests: 0 };
  const meta = () => ({ id: identity.itemId, name: "Vault.kdbx", size: remote.bytes.length, eTag: `"v${remote.version}"`, parentReference: { driveId: identity.driveId },
    file: {}, "@microsoft.graph.downloadUrl": "https://test.files.1drv.com/content?synthetic=capability" });
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT") {
      remote.conditionalRequests++;
      if (new Headers(init.headers).get("If-Match") !== `"v${remote.version}"`) return new Response(null, { status: 412 });
      remote.puts++;
      remote.bytes = (init.body as Uint8Array).slice(); remote.version++;
      return Response.json(meta());
    }
    if (String(url).startsWith("https://test.files.1drv.com/")) return new Response(remote.bytes.slice());
    return Response.json(meta());
  });
  const graph = new OneDriveGraphClient(async () => connection.tokens.accessToken, fetcher, { maxAttempts: 1 });
  const storage = new MemoryKeePassWorkingCopyStorage();
  const provider = new KeePassProvider();
  const factory = (_account: ProviderAccount, target: typeof identity) => new OneDriveKeePassFileClient(target, graph);
  const sessions = new KeePassRemoteSessionService(provider, storage, undefined, factory);
  const account = baseAccount();
  const opened = await sessions.openOneDrive(account, { ...identity, databasePassword: PASSWORD });
  account.config = opened.accountConfig;
  return { remote, fetcher, graph, storage, provider, sessions, account, factory, opened };
}

describe("OneDrive KDBX durable sessions", () => {
  it("opens through Graph, preserves the source on restart, and discloses no credentials in status", async () => {
    const f = await setup();
    expect(f.opened.session).toMatchObject({ sourceMode: "onedrive", itemCount: 1, dirty: false });
    expect(f.account.config).toMatchObject({ sourceMode: "onedrive", oneDriveDriveId: identity.driveId, oneDriveItemId: identity.itemId, oneDriveConnection: connection });
    expect(f.account.config).not.toHaveProperty("webDavPassword");
    f.provider.lock();
    const freshProvider = new KeePassProvider();
    const restarted = new KeePassRemoteSessionService(freshProvider, f.storage);
    expect((await restarted.restore(f.account)).session).toMatchObject({ sourceMode: "onedrive", itemCount: 1 });
    const status = await restarted.managerStatus(f.account);
    expect(status).toMatchObject({ sourceMode: "onedrive", workingCopyState: "ready", publicationState: "clean" });
    expect(JSON.stringify(status)).not.toMatch(/password|synthetic-secret|capability/);
    expect(f.fetcher).toHaveBeenCalledTimes(3); // Offline restore made no Graph request.
  });

  it("rebases an independent remote change while keeping local edits and the authenticated file identity", async () => {
    const f = await setup();
    const items = (await f.provider.sync(f.account, { now: NOW, localItems: [] })).items;
    await f.provider.update(f.account, { ...items[0], title: "Local edit", updatedAt: NOW });
    await f.sessions.persistWorkingCopy(f.account);
    const androidCopy = await kdbxweb.Kdbx.load(f.remote.bytes.slice().buffer, keePassCredentials(PASSWORD));
    androidCopy.getDefaultGroup().entries[0].fields.set("UserName", "remote-user");
    f.remote.bytes = new Uint8Array(await androidCopy.save()); f.remote.version++;
    const result = await f.sessions.publishWorkingCopy(f.account);
    expect(result?.status).toBe("rebased");
    expect(result?.accountConfig).toMatchObject({ sourceMode: "onedrive", oneDriveItemId: identity.itemId, oneDriveConnection: connection });
    const merged = await kdbxweb.Kdbx.load(f.remote.bytes.slice().buffer, keePassCredentials(PASSWORD));
    expect(merged.getDefaultGroup().entries[0].fields.get("Title")).toBe("Local edit");
    expect(merged.getDefaultGroup().entries[0].fields.get("UserName")).toBe("remote-user");
    expect(f.remote.puts).toBe(1);
    expect(f.remote.conditionalRequests).toBe(2); // One stale precondition, then the merged revision.
  });

  it("retains the encrypted working copy and rejects conflicting changes without overwriting the remote file", async () => {
    const f = await setup();
    const items = (await f.provider.sync(f.account, { now: NOW, localItems: [] })).items;
    await f.provider.update(f.account, { ...items[0], title: "Local edit", updatedAt: NOW });
    await f.sessions.persistWorkingCopy(f.account);
    const other = await kdbxweb.Kdbx.load(f.remote.bytes.slice().buffer, keePassCredentials(PASSWORD));
    other.getDefaultGroup().entries[0].fields.set("Title", "Other edit");
    f.remote.bytes = new Uint8Array(await other.save()); f.remote.version++;
    await expect(f.sessions.publishWorkingCopy(f.account)).rejects.toMatchObject({ code: "remote-rebase-conflict" });
    expect(f.remote.puts).toBe(0);
    expect(f.remote.conditionalRequests).toBe(1); // Rejected by the remote ETag, not applied.
    f.provider.lock();
    await f.sessions.restore(f.account);
    const restored = (await f.provider.sync(f.account, { now: NOW, localItems: [] })).items;
    expect(restored[0].title).toBe("Local edit");
    expect((await f.sessions.managerStatus(f.account)).publicationState).toBe("local-changes");
  });

  it.each([-7, -257])("publishes an actual %s private key through encrypted KDBX and reopens it with signature usability intact", async algorithm => {
    const f = await setup();
    const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("rsa", { modulusLength: 2048 });
    const original: PasskeyItem = { id: `key${-algorithm}`, kind: "passkey", title: "Portable key", favorite: false, notes: "", createdAt: NOW, updatedAt: NOW, providerRefs: [],
      credentialId: Buffer.from(`credential-${algorithm}`).toString("base64url"), rpId: "example.test", rpName: "Example", userHandle: "AAECA_8", userName: "test",
      userDisplayName: "Test user", algorithm, publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 41, backupEligible: true, backupState: false,
      discoverable: true, sourceMode: "browser-local", passkeyMode: "KEEPASS_COMPAT" };
    await f.provider.create(f.account, original);
    await f.sessions.persistWorkingCopy(f.account);
    const result = await f.sessions.publishWorkingCopy(f.account);
    expect(result?.status).toBe("uploaded");
    expect(Buffer.from(f.remote.bytes).includes(Buffer.from(original.privateKeyPkcs8!))).toBe(false);
    const reopened = new KeePassProvider();
    await reopened.unlock(f.account, f.remote.bytes, { password: PASSWORD, sourceMode: "onedrive" });
    const returned = (await reopened.sync(f.account, { now: NOW, localItems: [] })).items.find((item): item is PasskeyItem => item.kind === "passkey")!;
    expect(returned).toMatchObject({ credentialId: original.credentialId, privateKeyPkcs8: original.privateKeyPkcs8, userHandle: original.userHandle, algorithm,
      signCount: 41, backupEligible: true, backupState: false });
    const message = Buffer.from("Independent signature check after KDBX transfer");
    const key = createPrivateKey({ key: Buffer.from(returned.privateKeyPkcs8!, "base64"), format: "der", type: "pkcs8" });
    expect(verify("sha256", message, pair.publicKey, sign("sha256", message, key))).toBe(true);
  });
});

describe("OneDrive secret storage and source binding", () => {
  it("atomically rotates encrypted tokens and does not revert them when a stale KDBX sync finishes", async () => {
    const f = await setup();
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("synthetic master password");
    await vault.upsertProvider(f.account);
    const rotated = { ...connection.tokens, accessToken: "rotated-access", refreshToken: "rotated-refresh" };
    await vault.rotateOneDriveTokens(f.account.id, connection, rotated);
    await expect(vault.rotateOneDriveTokens(f.account.id, connection, rotated)).rejects.toThrow(/会话已变化/);
    await vault.upsertProvider({ ...f.account, config: { ...f.account.config, workingCopyRevision: 2 } }, false, f.account);
    const saved = await vault.getProvider(f.account.id);
    expect(saved?.config.workingCopyRevision).toBe(2);
    expect((saved?.config.oneDriveConnection as typeof connection).tokens).toEqual(rotated);
    await vault.lock();
    await expect(vault.rotateOneDriveTokens(f.account.id, { ...connection, tokens: rotated }, connection.tokens)).rejects.toThrow();
  });

  it("does not apply token rotation to a replaced login or deleted provider", async () => {
    const f = await setup();
    const vault = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    await vault.setup("synthetic master password");
    await vault.upsertProvider(f.account);
    await vault.upsertProvider({ ...f.account, config: { ...f.account.config, oneDriveConnection: { ...connection, id: "new-login" } } });
    await expect(vault.rotateOneDriveTokens(f.account.id, connection, connection.tokens)).rejects.toThrow(/会话已变化/);
    await vault.removeProvider(f.account.id);
    await expect(vault.rotateOneDriveTokens(f.account.id, connection, connection.tokens)).rejects.toThrow(/会话已变化/);
  });

  it("encrypts the tokens and KDBX credential while keeping only display fields in the manager summary", async () => {
    const f = await setup();
    const storage = new MemoryVaultStorage();
    const vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await vault.setup("synthetic master password");
    const summary = await vault.upsertProvider(f.account);
    expect(summary.config).toMatchObject({ sourceMode: "onedrive", oneDriveUsername: "test@example.invalid", oneDriveDisplayName: "Synthetic account",
      databaseCredentialStored: true, workingCopyAvailable: true, remoteEtagAvailable: true });
    expect(JSON.stringify(summary)).not.toMatch(/synthetic-secret|synthetic KDBX password|oneDriveConnection/);
    expect(JSON.stringify(await storage.read())).not.toMatch(/synthetic-secret|synthetic KDBX password/);
    await vault.lock();
    await expect(vault.getProvider(f.account.id)).rejects.toThrow();
    const fresh = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await fresh.unlock("synthetic master password");
    expect((await fresh.getProvider(f.account.id))?.config.oneDriveConnection).toEqual(connection);
    expect(JSON.stringify(await fresh.listProviders())).not.toMatch(/synthetic-secret|oneDriveConnection/);
  });

  it("rejects rebinding to another item, drive, account, application or login session while allowing token rotation", async () => {
    const f = await setup();
    const rotated = structuredClone(f.account);
    (rotated.config.oneDriveConnection as typeof connection).tokens.refreshToken = "rotated";
    expect(sameProviderBinding(f.account, rotated)).toBe(true);
    for (const field of ["oneDriveDriveId", "oneDriveItemId"]) {
      const changed = structuredClone(f.account); changed.config[field] = "different";
      expect(sameProviderBinding(f.account, changed)).toBe(false);
    }
    for (const field of ["id", "clientId", "account"] as const) {
      const changed = structuredClone(f.account), next = changed.config.oneDriveConnection as typeof connection;
      if (field === "account") next.profile.id = "other-user"; else next[field] = "different";
      expect(sameProviderBinding(f.account, changed)).toBe(false);
    }
    expect(sameProviderBinding(f.account, { ...f.account, config: { ...f.account.config, oneDriveConnection: undefined } })).toBe(false);
  });
});
