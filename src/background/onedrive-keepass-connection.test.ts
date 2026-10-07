import { describe, expect, it, vi } from "vitest";
import { OneDriveKeePassConnections, type KeePassOneDriveConnectInput } from "./onedrive-keepass-connection";
import { SecureVaultService } from "../security/secure-vault-service";
import { MemoryVaultStorage } from "../security/vault-storage";
import { MemoryVaultSessionStore } from "../security/vault-session";
import { KeePassProvider } from "../providers/keepass/keepass-provider";
import { KeePassRemoteSessionService } from "../providers/keepass/keepass-remote-session";
import { MemoryKeePassWorkingCopyStorage, type KeePassDurableMutationReceipt } from "../providers/keepass/keepass-working-copy-store";
import { buildKeePassFixture } from "../providers/keepass/keepass-fixture";
import { OneDriveSessionService } from "../providers/onedrive/onedrive-session";
import type { OneDriveConnection } from "../providers/onedrive/onedrive-token-manager";

const password = "Synthetic database password";
const redirect = `https://${"a".repeat(32)}.chromiumapp.org/onedrive`;
async function fixture() {
  const bytes = await buildKeePassFixture({ password, entries: [{ title: "Original" }] });
  const disk = new MemoryVaultStorage(), vaultSessions = new MemoryVaultSessionStore();
  const vault = new SecureVaultService(disk, vaultSessions);
  await vault.setup("Synthetic master password");
  let token = 0, accountId = "account1";
  const fetcher = vi.fn(async (url: RequestInfo | URL): Promise<Response> => {
    const path = String(url);
    if (path.endsWith("/token")) return Response.json({ access_token: `secret-access-${++token}`, refresh_token: `secret-refresh-${token}`, token_type: "Bearer", scope: "Files.ReadWrite User.Read", expires_in: 3600 });
    if (path.includes("/me?")) return Response.json({ id: accountId, displayName: "Test", mail: "test@example.invalid" });
    if (path.includes("/me/drive?")) return Response.json({ id: "drive1", name: "OneDrive", driveType: "personal" });
    if (path.startsWith("https://test.files.1drv.com/")) return new Response(bytes.slice());
    return Response.json({ id: "item1", name: "Vault.kdbx", size: bytes.length, eTag: '"v1"', parentReference: { driveId: "drive1" }, file: {}, "@microsoft.graph.downloadUrl": "https://test.files.1drv.com/content" });
  });
  const cloud = new OneDriveSessionService({ sessionId: () => vault.passkeySessionId(), getProvider: id => vault.getProvider(id), rotateOneDriveTokens: (...args) => vault.rotateOneDriveTokens(...args) }, fetcher);
  const storage = new MemoryKeePassWorkingCopyStorage(), provider = new KeePassProvider();
  const remote = new KeePassRemoteSessionService(provider, storage, undefined, (account, identity) => cloud.fileClient(account, identity));
  const flush = vi.fn(async () => {});
  const connections = new OneDriveKeePassConnections(vault, provider, remote, storage, cloud, flush);
  async function login() {
    const id = crypto.randomUUID();
    await cloud.login(id, redirect, async url => `${redirect}?state=${new URL(url).searchParams.get("state")}&code=synthetic`);
    return id;
  }
  const input = (loginId?: string, providerId?: string): KeePassOneDriveConnectInput => ({ name: "My OneDrive", driveId: "drive1", itemId: "item1", databasePassword: providerId ? "" : password, loginId, providerId });
  async function connect() {
    const result = await connections.connect(input(await login()));
    return (await vault.getProvider(result.account.id))!;
  }
  return { disk, vaultSessions, vault, fetcher, cloud, storage, provider, remote, connections, flush, input, login, connect, setAccount: (id: string) => { accountId = id; } };
}

describe("OneDrive connection commits", () => {
  it("opens a real encrypted KDBX and stores only encrypted tokens, returning a safe summary", async () => {
    const f = await fixture(), loginId = await f.login(), input = f.input(loginId);
    const result = await f.connections.connect(input);
    expect(result).toMatchObject({ workingCopyPreserved: false, session: { itemCount: 1, sourceMode: "onedrive" } });
    expect(JSON.stringify(result)).not.toMatch(/secret-access|secret-refresh|Synthetic database password|oneDriveConnection/);
    expect(JSON.stringify(await f.disk.read())).not.toMatch(/secret-access|secret-refresh|Synthetic database password/);
    expect(input.databasePassword).toBe("");
    await expect(f.cloud.connectionForLogin(loginId)).rejects.toThrow();
    expect((await f.vault.getProvider(result.account.id))?.config.databasePassword).toBe(password);
  });

  it("reauthorizes without losing an unpersisted edit or its durable receipt and keeps the source binding", async () => {
    const f = await fixture(), account = await f.connect();
    const oldConnection = account.config.oneDriveConnection as OneDriveConnection;
    const group = f.provider.createGroup(account, "unsent-group", "Unsaved group");
    const receipt: KeePassDurableMutationReceipt = { providerId: account.id, operationId: "unsent-group", kind: "group-create", intentSha256: "a".repeat(64), completedAt: new Date().toISOString(), result: { type: "group", changed: true, groupUuid: f.provider.groupUuidForHandle(account.id, group.group.groupId) } };
    f.flush.mockImplementationOnce(async () => { await f.remote.persistWorkingCopy(account, receipt); });
    const restore = vi.spyOn(f.remote, "restore");
    const result = await f.connections.connect(f.input(await f.login(), account.id));
    expect(result.workingCopyPreserved).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    const saved = (await f.vault.getProvider(account.id))!;
    expect((saved.config.oneDriveConnection as OneDriveConnection).id).toBe(oldConnection.id);
    expect((saved.config.oneDriveConnection as OneDriveConnection).tokens.accessToken).toBe("secret-access-2");
    expect(await f.remote.readAnyDurableReceipt(saved, "unsent-group")).toEqual(receipt);
    expect(JSON.stringify(await f.storage.readReceipt(account.id, "unsent-group"))).not.toContain("Unsaved group");
    f.provider.lock(); await f.remote.restore(saved);
    expect((await f.provider.listGroups(saved)).items.some(group => group.name === "Unsaved group")).toBe(true);
    await expect(f.vault.rotateOneDriveTokens(account.id, oldConnection, oldConnection.tokens)).rejects.toThrow(/会话已变化/);
  });

  it("preserves the offline working copy when authorization persistence fails", async () => {
    const f = await fixture(), account = await f.connect();
    f.provider.createGroup(account, "pending", "Still here");
    const loginId = await f.login();
    vi.spyOn(f.vault, "upsertProvider").mockRejectedValueOnce(new Error("Disk full"));
    await expect(f.connections.connect(f.input(loginId, account.id))).rejects.toThrow("Disk full");
    expect(f.provider.isUnlocked(account.id)).toBe(true);
    expect((await f.vault.getProvider(account.id))?.config.oneDriveConnection).toEqual(account.config.oneDriveConnection);
    expect((await f.cloud.connectionForLogin(loginId)).tokens.accessToken).toBe("secret-access-2");
    f.provider.lock(); await f.remote.restore(account);
    expect((await f.provider.listGroups(account)).items.some(group => group.name === "Still here")).toBe(true);
  });

  it("does not replace an existing source with another account or file", async () => {
    const f = await fixture(), account = await f.connect(), before = await f.storage.read(account.id);
    f.setAccount("other"); const loginId = await f.login();
    await expect(f.connections.connect(f.input(loginId, account.id))).rejects.toThrow(/账号.*不一致/);
    await expect(f.connections.connect({ ...f.input(loginId, account.id), itemId: "other-file" })).rejects.toThrow(/另一个数据库/);
    expect(await f.storage.read(account.id)).toEqual(before);
    expect(f.flush).not.toHaveBeenCalled();
  });

  it("requires an existing provider to still exist", async () => {
    const f = await fixture(), account = await f.connect();
    await f.vault.removeProvider(account.id);
    const input = f.input(await f.login(), account.id); input.databasePassword = password;
    await expect(f.connections.connect(input)).rejects.toThrow(/移除/);
    expect(input.databasePassword).toBe("");
  });

  it("rejects changed KDBX credentials while local edits are pending", async () => {
    const f = await fixture(), account = await f.connect();
    f.provider.createGroup(account, "pending", "Keep me");
    const input = { ...f.input(await f.login(), account.id), databasePassword: "changed" };
    await expect(f.connections.connect(input)).rejects.toThrow(/待同步修改/);
    expect(f.provider.isUnlocked(account.id)).toBe(true);
    expect(input.databasePassword).toBe("");
    f.provider.lock(); await f.remote.restore(account);
    expect((await f.provider.listGroups(account)).items.some(group => group.name === "Keep me")).toBe(true);
  });

  it("retains the old encrypted working copy on a wrong KDBX password", async () => {
    const f = await fixture(), account = await f.connect(), before = await f.storage.read(account.id);
    await expect(f.connections.connect({ ...f.input(await f.login(), account.id), databasePassword: "wrong" })).rejects.toThrow();
    expect(await f.storage.read(account.id)).toEqual(before);
    expect((await f.vault.getProvider(account.id))?.config.databasePassword).toBe(password);
  });

  it("rolls back a new working copy if the vault session changes before commit", async () => {
    const f = await fixture(), loginId = await f.login();
    const open = f.remote.openOneDrive.bind(f.remote);
    let providerId = "";
    vi.spyOn(f.remote, "openOneDrive").mockImplementationOnce(async (...args) => {
      const result = await open(...args); providerId = args[0].id;
      f.vaultSessions.session!.id = "replacement-session";
      return result;
    });
    await expect(f.connections.connect(f.input(loginId))).rejects.toThrow(/会话已变化/);
    expect(await f.storage.read(providerId)).toBeUndefined();
    expect(f.provider.isUnlocked(providerId)).toBe(false);
    expect(await f.vault.getProvider(providerId)).toBeUndefined();
  });

  it("rejects a stale session atomically even without a pending login", async () => {
    const f = await fixture(), account = await f.connect();
    const old = await f.vault.passkeySessionId(); f.vaultSessions.session!.id = "new-session";
    await expect(f.vault.upsertProvider({ ...account, name: "Must not save" }, true, account, { sessionId: old! })).rejects.toThrow();
    expect((await f.vault.getProvider(account.id))?.name).toBe(account.name);
  });

  it("does not revert refreshed tokens when the KDBX password changes", async () => {
    const f = await fixture(), account = await f.connect();
    const connection = account.config.oneDriveConnection as OneDriveConnection;
    const rotated = { ...connection.tokens, accessToken: "rotated-access", refreshToken: "rotated-refresh" };
    await f.vault.rotateOneDriveTokens(account.id, connection, rotated);
    await f.vault.upsertProvider({ ...account, config: { ...account.config, databasePassword: "new database password" } }, true, account,
      { sessionId: (await f.vault.passkeySessionId())! });
    expect(((await f.vault.getProvider(account.id))?.config.oneDriveConnection as OneDriveConnection).tokens).toEqual(rotated);
  });

  it("rejects changing the account during an explicit reauthorization commit", async () => {
    const f = await fixture(), account = await f.connect();
    const connection = account.config.oneDriveConnection as OneDriveConnection;
    await expect(f.vault.upsertProvider({ ...account, config: { ...account.config, oneDriveConnection: {
      ...connection, profile: { ...connection.profile, id: "another-account" }
    } } }, true, account, { sessionId: (await f.vault.passkeySessionId())!, oneDriveReauthorization: true })).rejects.toThrow(/已变化/);
    expect((await f.vault.getProvider(account.id))?.config.oneDriveConnection).toEqual(connection);
  });

  it("clears expired-login status after successful reauthorization", async () => {
    const f = await fixture(), account = await f.connect();
    await f.vault.upsertProvider({ ...account, lastError: "Expired", config: { ...account.config,
      remoteLastErrorCode: "authentication", remoteLastErrorRetryable: false, remoteLastErrorAt: new Date().toISOString() } });
    await f.connections.connect(f.input(await f.login(), account.id));
    const saved = (await f.vault.getProvider(account.id))!;
    expect(saved.lastError).toBeUndefined(); expect(saved.config.remoteLastErrorCode).toBeUndefined();
    expect((await f.remote.managerStatus(saved)).lastError).toBeUndefined();
  });
});
