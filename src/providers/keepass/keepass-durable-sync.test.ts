import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  createLoginItem,
  type PendingMutation,
  type ProviderAccount,
  type ProviderConflictInput,
  type ProviderSourceRecord,
  type VaultItem,
  type VaultState
} from "../../core/model";
import { keePassCredentials, buildKeePassFixture, type KeePassFixtureEntry } from "./keepass-fixture";
import {
  KEEPASS_ITEM_SYNC_BATCH_LIMIT,
  KEEPASS_ITEM_SYNC_RECEIPT_ID,
  KeePassDurableSyncCoordinator,
  type KeePassDurableSyncVault
} from "./keepass-durable-sync";
import { KeePassProvider } from "./keepass-provider";
import { KeePassRemoteSessionService, type KeePassRemoteFileClient } from "./keepass-remote-session";
import {
  MemoryKeePassWorkingCopyStorage,
  type KeePassEncryptedMutationReceipt,
  type KeePassRemoteWorkingCopyRecord
} from "./keepass-working-copy-store";
import { keePassFieldText } from "./keepass-login-codec";

const PASSWORD = "durable sync fixture password";
const NOW = "2026-08-07T07:00:00.000Z";

describe("KeePass durable item synchronization", () => {
  it.each(["create", "update", "delete"] as const)(
    "recovers one committed %s after the vault state write fails and the background restarts",
    async (operation) => {
      const fixtureEntries: KeePassFixtureEntry[] = operation === "create"
        ? []
        : [{ title: "Existing login", fields: { UserName: "before" }, protectedFields: { Password: "secret" } }];
      const environment = await openRemoteFixture(fixtureEntries);
      const initial = (await environment.provider.sync(environment.account, { now: NOW, localItems: [] })).items;
      const localItems = localItemsForOperation(operation, initial, environment.account.id);
      const mutation = pendingMutation(localItems[0].id, operation, 0);
      const vault = new TestDurableVault({ items: localItems, mutationQueue: [mutation] }, 1);
      const writeAccountConfig = accountWriter(environment);
      const coordinator = new KeePassDurableSyncCoordinator(
        environment.provider,
        environment.sessions,
        vault,
        writeAccountConfig
      );

      await expect(coordinator.synchronize(environment.account)).rejects.toThrow("simulated encrypted-vault write failure");
      expect(await environment.storage.readReceipt(environment.account.id, KEEPASS_ITEM_SYNC_RECEIPT_ID)).toBeDefined();
      expect((await environment.storage.read(environment.account.id))?.revision).toBe(3);

      environment.provider.lockAccount(environment.account.id);
      const restartedProvider = new KeePassProvider();
      const restartedSessions = new KeePassRemoteSessionService(restartedProvider, environment.storage, () => remoteClient(environment.remoteBytes));
      const restored = await restartedSessions.restore(environment.account);
      environment.account = { ...environment.account, config: restored.accountConfig };
      const restartedCoordinator = new KeePassDurableSyncCoordinator(
        restartedProvider,
        restartedSessions,
        vault,
        accountWriter(environment)
      );

      await restartedCoordinator.synchronize(environment.account);

      expect(vault.state.mutationQueue).toEqual([]);
      expect(vault.appliedConflicts.flat()).toEqual([]);
      expect(await environment.storage.readReceipt(environment.account.id, KEEPASS_ITEM_SYNC_RECEIPT_ID)).toBeUndefined();
      await expectOperationAppliedOnce(restartedProvider, environment.account, operation);
    }
  );

  it("persists at most 100 queued items per batch and processes the remainder on the next synchronization", async () => {
    const environment = await openRemoteFixture([]);
    const items = Array.from({ length: KEEPASS_ITEM_SYNC_BATCH_LIMIT + 1 }, (_, index) => ({
      ...createLoginItem({
        title: `Batch login ${index.toString().padStart(3, "0")}`,
        username: `user-${index}`,
        password: `secret-${index}`,
        providerRefs: [{ providerId: environment.account.id }]
      }),
      id: `item-${index.toString().padStart(3, "0")}`
    }));
    const mutations = items.map((item, index) => pendingMutation(
      item.id,
      "create",
      index,
      `mutation-${index.toString().padStart(3, "0")}`
    ));
    const vault = new TestDurableVault({ items, mutationQueue: mutations });
    const coordinator = new KeePassDurableSyncCoordinator(
      environment.provider,
      environment.sessions,
      vault,
      accountWriter(environment)
    );

    const first = await coordinator.synchronize(environment.account);

    expect(first.warnings.join("\n")).toContain(`本轮按 Monica Android 上限处理了 ${KEEPASS_ITEM_SYNC_BATCH_LIMIT} 条`);
    expect(vault.state.mutationQueue).toEqual([expect.objectContaining({ id: "mutation-100", itemId: "item-100" })]);
    expect(await activeEntryCount(environment.provider, environment.account)).toBe(KEEPASS_ITEM_SYNC_BATCH_LIMIT);
    expect(await environment.storage.readReceipt(environment.account.id, KEEPASS_ITEM_SYNC_RECEIPT_ID)).toBeUndefined();

    await coordinator.synchronize(environment.account);

    expect(vault.state.mutationQueue).toEqual([]);
    expect(await activeEntryCount(environment.provider, environment.account)).toBe(KEEPASS_ITEM_SYNC_BATCH_LIMIT + 1);
  });
});

class TestDurableVault implements KeePassDurableSyncVault {
  readonly appliedConflicts: ProviderConflictInput[][] = [];

  constructor(
    readonly state: Pick<VaultState, "items" | "mutationQueue">,
    private failuresRemaining = 0
  ) {}

  async readState(): Promise<Pick<VaultState, "items" | "mutationQueue">> {
    return structuredClone(this.state);
  }

  async applyProviderSync(
    providerId: string,
    items: VaultItem[],
    _accountPatch?: Partial<ProviderAccount>,
    conflicts: ProviderConflictInput[] = [],
    _sourceRecords?: ProviderSourceRecord[],
    _syncSnapshot?: VaultItem[]
  ): Promise<unknown> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("simulated encrypted-vault write failure");
    }
    this.appliedConflicts.push(structuredClone(conflicts));
    this.state.items = structuredClone(items);
    const conflictsByItem = new Set(conflicts.map((conflict) => conflict.itemId));
    const resultById = new Map(items.map((item) => [item.id, item]));
    this.state.mutationQueue = this.state.mutationQueue.filter((mutation) => {
      if (mutation.providerId !== providerId || conflictsByItem.has(mutation.itemId)) return true;
      const result = resultById.get(mutation.itemId);
      if (mutation.operation === "delete") return Boolean(result);
      return !result?.providerRefs.some((reference) => reference.providerId === providerId && reference.remoteId);
    });
    return { conflicts: conflicts.length };
  }
}

interface RemoteFixtureEnvironment {
  provider: KeePassProvider;
  sessions: KeePassRemoteSessionService;
  storage: MemoryKeePassWorkingCopyStorage;
  account: ProviderAccount;
  remoteBytes: Uint8Array;
}

async function openRemoteFixture(entries: KeePassFixtureEntry[]): Promise<RemoteFixtureEnvironment> {
  const bytes = await buildKeePassFixture({ password: PASSWORD, entries, name: "Durable Sync Fixture" });
  const records = new Map<string, KeePassRemoteWorkingCopyRecord>();
  const receipts = new Map<string, KeePassEncryptedMutationReceipt>();
  const storage = new MemoryKeePassWorkingCopyStorage(records, receipts);
  const provider = new KeePassProvider();
  const sessions = new KeePassRemoteSessionService(provider, storage, () => remoteClient(bytes));
  const base = remoteAccount();
  const opened = await sessions.open(base, {
    baseUrl: "http://127.0.0.1:8787/dav/durable-sync",
    username: "fixture",
    webDavPassword: "webdav secret",
    remotePath: "vaults/durable-sync.kdbx",
    databasePassword: PASSWORD
  });
  return { provider, sessions, storage, account: { ...base, config: opened.accountConfig }, remoteBytes: bytes };
}

function accountWriter(environment: RemoteFixtureEnvironment) {
  return async (_account: ProviderAccount, config: Record<string, unknown>): Promise<ProviderAccount> => {
    environment.account = { ...environment.account, config: structuredClone(config) };
    return environment.account;
  };
}

function localItemsForOperation(
  operation: PendingMutation["operation"],
  initial: VaultItem[],
  providerId: string
): VaultItem[] {
  if (operation === "create") {
    return [{
      ...createLoginItem({
        title: "Created once",
        username: "created-user",
        password: "created-secret",
        providerRefs: [{ providerId }]
      }),
      id: "created-item"
    }];
  }
  const existing = initial[0];
  if (!existing || existing.kind !== "login") throw new Error("fixture login is missing");
  if (operation === "update") return [{ ...existing, username: "after-restart", updatedAt: NOW }];
  return [{ ...existing, deletedAt: NOW, updatedAt: NOW }];
}

function pendingMutation(
  itemId: string,
  operation: PendingMutation["operation"],
  index: number,
  id = `mutation-${operation}`
): PendingMutation {
  return {
    id,
    providerId: "keepass-remote",
    itemId,
    operation,
    createdAt: new Date(Date.parse(NOW) + index).toISOString(),
    attempts: 0
  };
}

async function expectOperationAppliedOnce(
  provider: KeePassProvider,
  account: ProviderAccount,
  operation: PendingMutation["operation"]
): Promise<void> {
  const bytes = await provider.snapshotFile(account.id);
  try {
    const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    const root = database.getDefaultGroup();
    if (operation === "create") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0].history).toHaveLength(0);
      expect(keePassFieldText(root.entries[0].fields.get("Title"))).toBe("Created once");
      return;
    }
    if (operation === "update") {
      expect(root.entries).toHaveLength(1);
      expect(root.entries[0].history).toHaveLength(1);
      expect(keePassFieldText(root.entries[0].fields.get("UserName"))).toBe("after-restart");
      return;
    }
    expect(root.entries).toHaveLength(0);
    const recycleBin = root.groups.find((group) => group.uuid.equals(database.meta.recycleBinUuid!));
    expect(recycleBin?.entries).toHaveLength(1);
  } finally {
    bytes.fill(0);
  }
}

async function activeEntryCount(provider: KeePassProvider, account: ProviderAccount): Promise<number> {
  const bytes = await provider.snapshotFile(account.id);
  try {
    const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    return database.getDefaultGroup().entries.length;
  } finally {
    bytes.fill(0);
  }
}

function remoteAccount(): ProviderAccount {
  return {
    id: "keepass-remote",
    kind: "keepass",
    name: "Remote KeePass",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { databaseId: 42 }
  };
}

function remoteClient(bytes: Uint8Array): KeePassRemoteFileClient {
  return {
    async testConnection() {},
    async stat() {
      return {
        url: "http://127.0.0.1:8787/dav/durable-sync/vaults/durable-sync.kdbx",
        fileName: "durable-sync.kdbx",
        etag: "\"fixture-etag\"",
        sizeBytes: bytes.length
      };
    },
    async read() {
      return {
        url: "http://127.0.0.1:8787/dav/durable-sync/vaults/durable-sync.kdbx",
        fileName: "durable-sync.kdbx",
        etag: "\"fixture-etag\"",
        sizeBytes: bytes.length,
        bytes: bytes.slice(),
        sha256: "a".repeat(64)
      };
    },
    async write(inputBytes: Uint8Array) {
      return {
        url: "http://127.0.0.1:8787/dav/durable-sync/vaults/durable-sync.kdbx",
        fileName: "durable-sync.kdbx",
        etag: "\"fixture-etag\"",
        sizeBytes: inputBytes.length,
        bytes: inputBytes.slice(),
        sha256: "a".repeat(64),
        alreadyApplied: false
      };
    }
  };
}
