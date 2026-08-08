import { describe, expect, it } from "vitest";
import type { LoginItem, PasskeyItem, ProviderAccount } from "../../core/model";
import { bytesToBase64 } from "../../security/encoding";
import { SecureVaultService } from "../../security/secure-vault-service";
import { MemoryVaultSessionStore } from "../../security/vault-session";
import { MemoryVaultStorage } from "../../security/vault-storage";
import { encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenDurableSyncCoordinator, bitwardenMutationFingerprint } from "./bitwarden-durable-sync";
import { BitwardenProvider } from "./bitwarden-provider";

const KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 32)
};
const REVISION = "2026-08-08T00:00:00.000Z";

describe("Bitwarden durable item synchronization", () => {
  it("includes Passkey archive state in the durable Bitwarden intent fingerprint", async () => {
    const raw = await loginCipher("secret", REVISION, "archive-passkey-cipher");
    raw.Login = { ...(raw.Login as Record<string, unknown>), Fido2Credentials: [await fidoCredential("archive-credential", 0)] };
    const provider = new BitwardenProvider(async () => json({ Profile: { Id: "user" }, Ciphers: [raw] }));
    const imported = await provider.sync(bitwardenAccount(), { now: REVISION, localItems: [] });
    const passkey = imported.items.find((item): item is PasskeyItem => item.kind === "passkey")!;

    await expect(bitwardenMutationFingerprint(passkey)).resolves.not.toBe(
      await bitwardenMutationFingerprint({ ...passkey, archivedAt: "2026-08-08T00:01:00.000Z" })
    );
  });

  it("survives a Service Worker restart after a committed create response is lost", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable bitwarden vault password");
    await service.upsertProvider(account);
    const item: LoginItem = {
      id: "durable-create-item",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "secret",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id }]
    };
    await service.upsertItem(item);

    let remote: Record<string, unknown>[] = [];
    let postCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: remote });
      if (init?.method === "POST") {
        postCount += 1;
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        remote = [{ ...request, id: "durable-remote-cipher", revisionDate: "2026-08-08T00:01:00.000Z", creationDate: REVISION }];
        return new Response("{lost-response", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };

    const first = new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service);
    await first.synchronize(account).catch(() => undefined);
    const afterLoss = await service.readState();
    expect(afterLoss.providerMutationReceipts).toEqual([expect.objectContaining({ stage: "attempted", attemptCount: 1, itemId: item.id })]);
    expect(afterLoss.mutationQueue).toEqual([expect.objectContaining({ itemId: item.id, operation: "create" })]);
    expect(postCount).toBe(1);

    const recovered = new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service);
    await expect(recovered.synchronize(account)).resolves.toMatchObject({ conflicts: [] });
    const final = await service.readState();
    expect(final.providerMutationReceipts).toEqual([]);
    expect(final.mutationQueue).toEqual([]);
    expect(final.items.find((candidate) => candidate.id === item.id)?.providerRefs).toContainEqual(expect.objectContaining({ remoteId: "durable-remote-cipher" }));
    expect(postCount).toBe(1);
  });

  it("keeps the durable receipt encrypted and migrates a legacy state without one", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    const secret = "receipt-secret-value";
    await service.setup("receipt vault password");
    await service.upsertProvider(account);
    const item: LoginItem = {
      id: "receipt-item",
      kind: "login",
      title: "Receipt",
      username: "alice",
      password: secret,
      uris: [],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id }]
    };
    await service.upsertItem(item);
    await service.prepareProviderMutationReceipts([{
      version: 1,
      providerId: account.id,
      mutationId: "receipt-mutation",
      itemId: item.id,
      operation: "create",
      stage: "prepared",
      intentFingerprint: "a".repeat(64),
      attemptCount: 0,
      createdAt: REVISION,
      updatedAt: REVISION
    }]);
    expect(JSON.stringify(storage.envelope)).not.toContain(secret);
    await service.lock();
    await expect(service.unlock("receipt vault password")).resolves.toMatchObject({});
    expect((await service.readState()).providerMutationReceipts).toHaveLength(1);
  });

  it("recovers a committed update after restart and does not send a second PUT", async () => {
    const storage = new MemoryVaultStorage();
    const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable update vault password");
    await service.upsertProvider(account);
    const original: LoginItem = {
      id: "durable-update-item",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "before",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [],
      bitwardenCustomFieldsVersion: 1,
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id, remoteId: "update-cipher", revision: REVISION }]
    };
    await service.upsertItem(original);
    // Adopt the initial provider baseline before creating the user edit.
    const baselineState = await service.readState();
    await service.applyProviderSync(account.id, [original], undefined, [], undefined, baselineState.items);
    await service.upsertItem({ ...original, password: "after" });

    let remote: Record<string, unknown> = await loginCipher("before", REVISION, "update-cipher");
    let putCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "update-cipher", RevisionDate: "2026-08-08T00:02:00.000Z", CreationDate: REVISION };
        return new Response("{lost-response", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    expect((await service.readState()).providerMutationReceipts).toEqual([expect.objectContaining({ stage: "attempted", operation: "update" })]);
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const final = await service.readState();
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(final.items.find((item) => item.id === original.id)).toMatchObject({ password: "after" });
    expect(putCount).toBe(1);
  });

  it("recovers a lost recycle-bin response without sending another delete", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable delete vault password");
    await service.upsertProvider(account);
    const original: LoginItem = {
      id: "durable-delete-item",
      kind: "login",
      title: "Delete me",
      username: "alice",
      password: "secret",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [],
      bitwardenCustomFieldsVersion: 1,
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id, remoteId: "delete-cipher", revision: REVISION }]
    };
    await service.applyProviderSync(account.id, [original]);
    await service.deleteItem(original.id);

    let remote = await loginCipher("secret", REVISION, "delete-cipher");
    let deleteCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (String(input).endsWith("/delete") && init?.method === "PUT") {
        deleteCount += 1;
        remote = { ...remote, DeletedDate: "2026-08-08T00:03:00.000Z" };
        throw new DOMException("response lost", "AbortError");
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const afterLoss = await service.readState();
    expect(afterLoss.providerMutationReceipts).toEqual([expect.objectContaining({ stage: "attempted", operation: "delete" })]);
    expect(afterLoss.items.find((item) => item.id === original.id)?.deletedAt).toBeTruthy();
    const attemptsBeforeRestart = deleteCount;
    expect(attemptsBeforeRestart).toBeGreaterThan(0);

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const final = await service.readState();
    expect(final.providerMutationReceipts).toEqual([]);
    expect(final.mutationQueue).toEqual([]);
    expect(final.items.find((item) => item.id === original.id)).toMatchObject({ deletedAt: "2026-08-08T00:03:00.000Z" });
    expect(deleteCount).toBe(attemptsBeforeRestart);
  });

  it("restores a Cipher after a lost recycle-bin response without losing the local restore intent", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable restore vault password");
    await service.upsertProvider(account);
    const original: LoginItem = {
      id: "durable-restore-item",
      kind: "login",
      title: "Restore me",
      username: "alice",
      password: "secret",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [],
      bitwardenCustomFieldsVersion: 1,
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id, remoteId: "restore-cipher", revision: REVISION }]
    };
    await service.applyProviderSync(account.id, [original]);
    await service.deleteItem(original.id);

    let remote = await loginCipher("secret", REVISION, "restore-cipher");
    let deleteCount = 0;
    let restoreCount = 0;
    let updateCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (url.endsWith("/delete") && init?.method === "PUT") {
        deleteCount += 1;
        remote = { ...remote, DeletedDate: "2026-08-08T00:03:00.000Z" };
        throw new DOMException("response lost", "AbortError");
      }
      if (url.endsWith("/restore") && init?.method === "PUT") {
        restoreCount += 1;
        remote = { ...remote, DeletedDate: null };
        return json(remote);
      }
      if (init?.method === "PUT") {
        updateCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "restore-cipher", RevisionDate: "2026-08-08T00:04:00.000Z", CreationDate: REVISION, DeletedDate: null };
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${url}`);
    };

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const deleteAttemptsBeforeRestore = deleteCount;
    await service.restoreItem(original.id);
    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    expect((await service.readState()).mutationQueue).toEqual([expect.objectContaining({ itemId: original.id, operation: "update" })]);
    expect((await service.readState()).items.find((item) => item.id === original.id)?.deletedAt).toBeUndefined();

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const final = await service.readState();
    expect(final.items.find((item) => item.id === original.id)).toMatchObject({ password: "secret" });
    expect(final.items.find((item) => item.id === original.id)?.deletedAt).toBeUndefined();
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(deleteCount).toBe(deleteAttemptsBeforeRestore);
    expect({ restoreCount, updateCount }).toEqual({ restoreCount: 1, updateCount: 1 });
  });

  it("recovers login and Passkey children committed by one Cipher update", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable passkey vault password");
    await service.upsertProvider(account);
    const base = await loginCipher("before", REVISION, "passkey-cipher");
    let remote: Record<string, unknown> = {
      ...base,
      Login: {
        ...(base.Login as Record<string, unknown>),
        Fido2Credentials: [await fidoCredential("credential-1", 1)]
      }
    };
    let putCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "passkey-cipher", RevisionDate: "2026-08-08T00:04:00.000Z", CreationDate: REVISION };
        return new Response("{lost-response", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };
    const provider = new BitwardenProvider(fetcher);
    const imported = await provider.sync(account, { now: REVISION, localItems: [] });
    await service.applyProviderSync(account.id, imported.items, imported.accountPatch, imported.conflicts, imported.sourceRecords);
    const login = (await service.listItems()).find((item): item is LoginItem => item.kind === "login")!;
    const passkey = (await service.listItems()).find((item): item is PasskeyItem => item.kind === "passkey")!;
    await service.upsertItem({ ...login, password: "after" });
    await service.upsertItem({ ...passkey, signCount: 2, publicKey: "local-public-key", transports: ["internal"], useCount: 7 });

    await new BitwardenDurableSyncCoordinator(provider, service).synchronize(account);
    expect((await service.readState()).providerMutationReceipts).toHaveLength(2);
    await new BitwardenDurableSyncCoordinator(provider, service).synchronize(account);
    const final = await service.readState();
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(final.items.find((item): item is LoginItem => item.kind === "login")?.password).toBe("after");
    expect(final.items.find((item): item is PasskeyItem => item.kind === "passkey")).toMatchObject({ signCount: 2, publicKey: "local-public-key", useCount: 7 });
    expect(putCount).toBe(1);
  });

  it("recovers a native SSH update while retaining local-only Android metadata", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable native ssh password");
    await service.upsertProvider(account);
    let remote: Record<string, unknown> = {
      Id: "durable-native-ssh",
      Type: 5,
      Name: await encryptBitwardenString("Native SSH", KEY),
      RevisionDate: REVISION,
      CreationDate: REVISION,
      SshKey: {
        PrivateKey: await encryptBitwardenString("private-old", KEY),
        PublicKey: await encryptBitwardenString("ssh-ed25519 AAAA old", KEY),
        KeyFingerprint: await encryptBitwardenString("SHA256:old", KEY),
        FutureNative: "preserve"
      }
    };
    let putCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "durable-native-ssh", RevisionDate: "2026-08-08T00:04:30.000Z", CreationDate: REVISION };
        return new Response("{lost-response", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };
    const provider = new BitwardenProvider(fetcher);
    const imported = await provider.sync(account, { now: REVISION, localItems: [] });
    await service.applyProviderSync(account.id, imported.items, imported.accountPatch, imported.conflicts, imported.sourceRecords);
    const item = (await service.listItems())[0] as LoginItem;
    const ssh = JSON.parse(item.sshKeyData || "{}") as Record<string, unknown>;
    await service.upsertItem({
      ...item,
      sshKeyData: JSON.stringify({
        ...ssh,
        publicKeyOpenSsh: "ssh-ed25519 AAAA updated",
        fingerprintSha256: "SHA256:updated",
        keySize: 256,
        comment: "local-only comment",
        futureAndroidField: { keep: true }
      })
    });

    await new BitwardenDurableSyncCoordinator(provider, service).synchronize(account);
    expect((await service.readState()).providerMutationReceipts).toEqual([expect.objectContaining({ stage: "attempted", operation: "update" })]);
    await new BitwardenDurableSyncCoordinator(provider, service).synchronize(account);
    const final = await service.readState();
    const finalItem = final.items[0] as LoginItem;
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(finalItem.bitwardenSshKeyMode).toBe("native");
    expect(JSON.parse(finalItem.sshKeyData || "{}")).toMatchObject({
      publicKeyOpenSsh: "ssh-ed25519 AAAA updated",
      fingerprintSha256: "SHA256:updated",
      keySize: 256,
      comment: "local-only comment",
      futureAndroidField: { keep: true }
    });
    expect(putCount).toBe(1);
  });

  it("preserves an edit made while an acknowledged update response is in flight", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable follow-up vault password");
    await service.upsertProvider(account);
    const original: LoginItem = {
      id: "durable-follow-up-item",
      kind: "login",
      title: "Follow up",
      username: "alice",
      password: "before",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [],
      bitwardenCustomFieldsVersion: 1,
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id, remoteId: "follow-up-cipher", revision: REVISION }]
    };
    await service.applyProviderSync(account.id, [original]);
    await service.upsertItem({ ...original, password: "first write" });
    let remote = await loginCipher("before", REVISION, "follow-up-cipher");
    let putCount = 0;
    let injectedFollowUp = false;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        const revision = putCount === 1 ? "2026-08-08T00:05:00.000Z" : "2026-08-08T00:06:00.000Z";
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "follow-up-cipher", RevisionDate: revision, CreationDate: REVISION };
        if (!injectedFollowUp) {
          injectedFollowUp = true;
          const current = await service.getItem(original.id) as LoginItem;
          await service.upsertItem({ ...current, password: "follow-up write" });
        }
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const afterFirst = await service.readState();
    expect(afterFirst.providerConflicts).toEqual([]);
    expect(afterFirst.items.find((item) => item.id === original.id)).toMatchObject({ password: "follow-up write" });
    expect(afterFirst.mutationQueue).toEqual([expect.objectContaining({ operation: "update" })]);
    expect(afterFirst.providerMutationReceipts).toEqual([]);

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const final = await service.readState();
    expect(final.items.find((item) => item.id === original.id)).toMatchObject({ password: "follow-up write" });
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(putCount).toBe(2);
  });

  it("refreshes an unattempted receipt when the queued intent changes", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("prepared receipt refresh password");
    await service.upsertProvider(account);
    const created = await service.upsertItem({
      id: "prepared-refresh-item",
      kind: "login",
      title: "Prepared",
      username: "alice",
      password: "before",
      uris: [],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id }]
    } as LoginItem) as LoginItem;
    const queued = (await service.readState()).mutationQueue[0];
    await service.prepareProviderMutationReceipts([{
      version: 1,
      providerId: account.id,
      mutationId: queued.id,
      itemId: created.id,
      operation: "create",
      stage: "prepared",
      intentFingerprint: await bitwardenMutationFingerprint(created),
      attemptCount: 0,
      createdAt: queued.createdAt,
      updatedAt: queued.createdAt
    }]);
    await service.upsertItem({ ...created, password: "after" });

    let remote: Record<string, unknown>[] = [];
    let postCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: remote });
      if (init?.method === "POST") {
        postCount += 1;
        remote = [{ ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "prepared-refresh-cipher", RevisionDate: "2026-08-08T00:07:00.000Z", CreationDate: REVISION }];
        return json(remote[0]);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const final = await service.readState();
    expect(final.items.find((item) => item.id === created.id)).toMatchObject({ password: "after" });
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(postCount).toBe(1);
  });

  it("queues legacy custom-field migration before allowing the remote write", async () => {
    const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
    const account = bitwardenAccount();
    await service.setup("durable custom-field migration password");
    await service.upsertProvider(account);
    const remoteField = { Type: 0, Name: await encryptBitwardenString("Remote", KEY), Value: await encryptBitwardenString("remote", KEY) };
    let remote: Record<string, unknown> = { ...(await loginCipher("secret", REVISION, "migration-cipher")), Fields: [remoteField] };
    const cached: LoginItem = {
      id: "durable-migration-item",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "secret",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [
        { name: "Remote", value: "remote", protected: false },
        { name: "Local only", value: "local", protected: true }
      ],
      favorite: false,
      notes: "",
      createdAt: REVISION,
      updatedAt: REVISION,
      providerRefs: [{ providerId: account.id, remoteId: "migration-cipher", revision: REVISION }]
    };
    await service.applyProviderSync(account.id, [cached]);
    let putCount = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "migration-cipher", RevisionDate: "2026-08-08T00:08:00.000Z", CreationDate: REVISION };
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    };

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const queued = await service.readState();
    expect(putCount).toBe(0);
    expect(queued.items.find((item) => item.id === cached.id)).toMatchObject({ bitwardenCustomFieldsVersion: 1, customFields: cached.customFields });
    expect(queued.mutationQueue).toEqual([expect.objectContaining({ itemId: cached.id, operation: "update" })]);
    expect(queued.providerMutationReceipts).toEqual([]);

    await new BitwardenDurableSyncCoordinator(new BitwardenProvider(fetcher), service).synchronize(account);
    const final = await service.readState();
    expect(final.mutationQueue).toEqual([]);
    expect(final.providerMutationReceipts).toEqual([]);
    expect(putCount).toBe(1);
  });
});

function bitwardenAccount(): ProviderAccount {
  return {
    id: "bitwarden-durable-provider",
    kind: "bitwarden",
    name: "Bitwarden",
    enabled: true,
    isDefaultSaveTarget: false,
    config: {
      vaultUrl: "https://self.example.com",
      apiUrl: "https://self.example.com/api",
      identityUrl: "https://self.example.com/identity",
      email: "alice@example.com",
      deviceId: "device-1",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3_600_000,
      kdf: { type: 0, iterations: 100_000 },
      vaultKeyEnc: bytesToBase64(KEY.encKey),
      vaultKeyMac: bytesToBase64(KEY.macKey)
    }
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function loginCipher(password: string, revisionDate: string, id: string): Promise<Record<string, unknown>> {
  return {
    Id: id,
    Type: 1,
    Name: await encryptBitwardenString("Example", KEY),
    Notes: null,
    Favorite: false,
    RevisionDate: revisionDate,
    CreationDate: REVISION,
    Login: {
      Username: await encryptBitwardenString("alice", KEY),
      Password: await encryptBitwardenString(password, KEY),
      Uris: [{ Uri: await encryptBitwardenString("https://example.com", KEY) }]
    }
  };
}

async function fidoCredential(credentialId: string, counter: number): Promise<Record<string, unknown>> {
  const enc = (value: string) => encryptBitwardenString(value, KEY);
  return {
    CredentialId: await enc(credentialId),
    KeyAlgorithm: await enc("ECDSA"),
    KeyValue: await enc(`pkcs8-${credentialId}`),
    RpId: await enc("example.com"),
    RpName: await enc("Example"),
    Counter: await enc(String(counter)),
    UserHandle: await enc("dXNlcg"),
    UserName: await enc("joy@example.com"),
    UserDisplayName: await enc("Joy"),
    Discoverable: await enc("true"),
    CreationDate: await enc(REVISION)
  };
}
