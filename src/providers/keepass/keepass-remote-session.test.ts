import { describe, expect, it, vi } from "vitest";
import type { ProviderAccount } from "../../core/model";
import { buildKeePassFixture } from "./keepass-fixture";
import { KeePassProvider } from "./keepass-provider";
import { keePassMutationIntentSha256, KeePassRemoteSessionService, type KeePassRemoteFileClient } from "./keepass-remote-session";
import {
  type KeePassDurableMutationReceipt,
  type KeePassEncryptedMutationReceipt,
  MemoryKeePassWorkingCopyStorage,
  type KeePassRemoteWorkingCopyRecord
} from "./keepass-working-copy-store";

describe("KeePass remote session service", () => {
  it("opens WebDAV KDBX and restores it through a new provider instance", async () => {
    const bytes = await buildKeePassFixture({
      password: "database password",
      entries: [{ title: "Remote login", fields: { UserName: "remote-user" } }]
    });
    const records = new Map<string, KeePassRemoteWorkingCopyRecord>();
    const firstProvider = new KeePassProvider();
    const first = new KeePassRemoteSessionService(
      firstProvider,
      new MemoryKeePassWorkingCopyStorage(records),
      () => client(bytes)
    );
    const opened = await first.open(account(), {
      baseUrl: "http://127.0.0.1:8787/dav/demo",
      username: "demo",
      webDavPassword: "webdav secret",
      remotePath: "vaults/main.kdbx",
      databasePassword: "database password"
    });

    expect(opened.session).toMatchObject({ sourceMode: "webdav", itemCount: 1, dirty: false });
    expect(opened.accountConfig).toMatchObject({
      sourceMode: "webdav",
      webDavPassword: "webdav secret",
      databasePassword: "database password",
      workingCopyRevision: 1,
      remoteEtag: '"etag-1"'
    });
    firstProvider.lock();

    const secondProvider = new KeePassProvider();
    const second = new KeePassRemoteSessionService(secondProvider, new MemoryKeePassWorkingCopyStorage(records));
    const restored = await second.restore({ ...account(), config: opened.accountConfig });

    expect(restored.session).toMatchObject({ sourceMode: "webdav", itemCount: 1, dirty: false });
    expect(secondProvider.summarize("keepass-remote")).toMatchObject({ databaseName: "Monica Fixture" });
  });

  it("does not retain a working copy when KDBX credentials are invalid", async () => {
    const bytes = await buildKeePassFixture({ password: "correct password" });
    const storage = new MemoryKeePassWorkingCopyStorage();
    const service = new KeePassRemoteSessionService(new KeePassProvider(), storage, () => client(bytes));

    await expect(service.open(account(), {
      baseUrl: "http://127.0.0.1:8787/dav/demo",
      username: "demo",
      webDavPassword: "webdav secret",
      remotePath: "vaults/main.kdbx",
      databasePassword: "wrong password"
    })).rejects.toThrow();
    await expect(storage.read("keepass-remote")).resolves.toBeUndefined();
  });

  it("restores a remote KDBX whose database password is empty", async () => {
    const bytes = await buildKeePassFixture({
      password: "",
      entries: [{ title: "Passwordless remote login" }]
    });
    const records = new Map<string, KeePassRemoteWorkingCopyRecord>();
    const firstProvider = new KeePassProvider();
    const first = new KeePassRemoteSessionService(firstProvider, new MemoryKeePassWorkingCopyStorage(records), () => client(bytes));
    const opened = await first.open(account(), {
      baseUrl: "http://127.0.0.1:8787/dav/demo",
      username: "demo",
      webDavPassword: "webdav secret",
      remotePath: "vaults/main.kdbx",
      databasePassword: ""
    });
    firstProvider.lock();

    const secondProvider = new KeePassProvider();
    const second = new KeePassRemoteSessionService(secondProvider, new MemoryKeePassWorkingCopyStorage(records));
    await expect(second.restore({ ...account(), config: opened.accountConfig })).resolves.toMatchObject({
      session: { sourceMode: "webdav", itemCount: 1, dirty: false }
    });
  });

  it("locks the opened KDBX if persistent working-copy access fails", async () => {
    const bytes = await buildKeePassFixture({ password: "database password" });
    const provider = new KeePassProvider();
    const service = new KeePassRemoteSessionService(provider, {
      read: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }),
      readReceipt: vi.fn(),
      hasReceipts: vi.fn(),
      save: vi.fn(),
      deleteReceipt: vi.fn(),
      delete: vi.fn()
    }, () => client(bytes));

    await expect(service.open(account(), {
      baseUrl: "http://127.0.0.1:8787/dav/demo",
      username: "demo",
      webDavPassword: "webdav secret",
      remotePath: "vaults/main.kdbx",
      databasePassword: "database password"
    })).rejects.toThrow("IndexedDB unavailable");
    expect(provider.isUnlocked("keepass-remote")).toBe(false);
  });

  it("fails closed when the encrypted provider exists without its working copy", async () => {
    const service = new KeePassRemoteSessionService(new KeePassProvider(), new MemoryKeePassWorkingCopyStorage());
    await expect(service.restore({
      ...account(),
      config: { sourceMode: "webdav", databasePassword: "database password", fileName: "main.kdbx" }
    })).rejects.toMatchObject({ code: "remote-working-copy-missing" });
  });

  it("probes server and file metadata without opening KDBX", async () => {
    const remote = client(new Uint8Array([1, 2, 3]));
    const service = new KeePassRemoteSessionService(
      new KeePassProvider(),
      new MemoryKeePassWorkingCopyStorage(),
      () => remote
    );
    await expect(service.probe({
      baseUrl: "http://127.0.0.1:8787/dav/demo",
      username: "demo",
      webDavPassword: "secret",
      remotePath: "vaults/main.kdbx"
    })).resolves.toMatchObject({ reachable: true, file: { etag: '"etag-1"' } });
    expect(remote.testConnection).toHaveBeenCalledOnce();
  });

  it("atomically persists a dirty KDBX snapshot and durable operation receipt", async () => {
    const bytes = await buildKeePassFixture({ password: "database password" });
    const records = new Map<string, KeePassRemoteWorkingCopyRecord>();
    const receipts = new Map<string, KeePassEncryptedMutationReceipt>();
    const storage = new MemoryKeePassWorkingCopyStorage(records, receipts);
    const provider = new KeePassProvider();
    const service = new KeePassRemoteSessionService(provider, storage, () => client(bytes));
    const opened = await service.open(account(), {
      baseUrl: "http://127.0.0.1:8787/dav/demo",
      username: "demo",
      webDavPassword: "webdav secret",
      remotePath: "vaults/main.kdbx",
      databasePassword: "database password"
    });
    const remoteAccount = { ...account(), config: opened.accountConfig };
    const operationId = "11111111-1111-4111-8111-111111111111";
    const group = provider.createGroup(remoteAccount, operationId, "Persisted Group");
    const intentSha256 = await keePassMutationIntentSha256({ kind: "group-create", name: "Persisted Group" });
    const receipt: KeePassDurableMutationReceipt = {
      providerId: remoteAccount.id,
      operationId,
      kind: "group-create",
      intentSha256,
      completedAt: "2026-08-07T06:00:00.000Z",
      result: {
        type: "group",
        changed: group.changed,
        groupUuid: provider.groupUuidForHandle(remoteAccount.id, group.group.groupId)
      }
    };

    const persisted = await service.persistWorkingCopy(remoteAccount, receipt);
    expect(persisted).toMatchObject({ revision: 2, accountConfig: { workingCopyRevision: 2 } });
    expect(provider.summarize(remoteAccount.id).dirty).toBe(true);
    const encrypted = await storage.readReceipt(remoteAccount.id, operationId);
    expect(encrypted).toMatchObject({ version: 1, providerId: remoteAccount.id, operationId, cipher: "AES-256-GCM" });
    expect(JSON.stringify(encrypted)).not.toContain("group-uuid");
    const record = await storage.read(remoteAccount.id);
    expect(record?.workingSha256).not.toBe(record?.baseSha256);

    provider.lock();
    const nextProvider = new KeePassProvider();
    const nextService = new KeePassRemoteSessionService(nextProvider, new MemoryKeePassWorkingCopyStorage(records, receipts));
    await nextService.restore({ ...remoteAccount, config: persisted!.accountConfig });
    const durable = await nextService.readDurableReceipt(remoteAccount, operationId, "group-create", intentSha256);
    expect(durable).toEqual(receipt);
    expect(nextProvider.groupResultFromUuid(remoteAccount, receipt.result.type === "group" ? receipt.result.groupUuid : "", true).group.name).toBe("Persisted Group");
    await expect(nextService.readDurableReceipt(remoteAccount, operationId, "group-create", "f".repeat(64))).rejects.toMatchObject({ code: "remote-operation-reused" });
  });
});

function account(): ProviderAccount {
  return {
    id: "keepass-remote",
    kind: "keepass",
    name: "Remote KeePass",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { databaseId: 42 }
  };
}

function client(bytes: Uint8Array): KeePassRemoteFileClient {
  return {
    testConnection: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({
      url: "http://127.0.0.1:8787/dav/demo/vaults/main.kdbx",
      fileName: "main.kdbx",
      etag: '"etag-1"',
      sizeBytes: bytes.length
    })),
    read: vi.fn(async () => ({
      url: "http://127.0.0.1:8787/dav/demo/vaults/main.kdbx",
      fileName: "main.kdbx",
      etag: '"etag-1"',
      sizeBytes: bytes.length,
      bytes: bytes.slice(),
      sha256: "a".repeat(64)
    })),
    write: vi.fn(async () => ({
      url: "http://127.0.0.1:8787/dav/demo/vaults/main.kdbx",
      fileName: "main.kdbx",
      etag: '"etag-1"',
      sizeBytes: bytes.length,
      bytes: bytes.slice(),
      sha256: "a".repeat(64),
      alreadyApplied: false
    }))
  };
}
