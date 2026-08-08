import { describe, expect, it, vi } from "vitest";
import type { LoginItem, PasskeyItem, ProviderAccount, VaultItem } from "../../core/model";
import { bytesToBase64 } from "../../security/encoding";
import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenProvider } from "./bitwarden-provider";
import { bitwardenMutationFingerprint } from "./bitwarden-durable-sync";

const KEY: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 32) };
const ORGANIZATION_KEY: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 64), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 96) };
const OLD_REVISION = "2026-07-15T03:00:00.000Z";
const RSA_FIXTURE_TIMEOUT_MS = 15_000;

describe("Bitwarden provider", () => {
  it("imports and updates a personal login Cipher", async () => {
    let remote = await loginCipher("remote-secret", OLD_REVISION);
    let putCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        remote = { ...request, Id: "cipher-1", RevisionDate: "2026-07-15T03:05:00.000Z", CreationDate: OLD_REVISION } as typeof remote;
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${url}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [] });
    const imported = first.items[0] as LoginItem;
    expect(imported).toMatchObject({ kind: "login", password: "remote-secret" });

    const changed: LoginItem = { ...imported, password: "browser-secret", updatedAt: "2026-07-15T03:04:00.000Z" };
    const second = await provider.sync(account(), { now: "2026-07-15T03:06:00.000Z", localItems: [changed] });
    expect(second.conflicts).toEqual([]);
    expect(second.items[0]).toMatchObject({ password: "browser-secret", updatedAt: "2026-07-15T03:05:00.000Z" });
    expect(putCount).toBe(1);
    expect(second.sourceRecords?.[0]?.revision).toBe("2026-07-15T03:05:00.000Z");
    const finalRaw = JSON.parse(second.sourceRecords?.[0]?.payload || "{}") as Record<string, unknown>;
    const finalLogin = (finalRaw.login || finalRaw.Login) as Record<string, unknown>;
    await expect(decryptBitwardenString(String(finalLogin.password || finalLogin.Password), KEY)).resolves.toBe("browser-secret");
  });

  it("initializes matching legacy custom fields without an unnecessary upload", async () => {
    const remoteField = { Type: 0, Name: await encryptBitwardenString("Existing", KEY), Value: await encryptBitwardenString("value", KEY) };
    const remote = { ...(await loginCipher("remote-secret", OLD_REVISION)), Fields: [remoteField] };
    let putCount = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") putCount += 1;
      return json({ Profile: { Id: "user" }, Ciphers: [remote] });
    }) as unknown as typeof fetch;
    const cached: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "remote-secret",
      uris: ["https://example.com"],
      customFields: [{ name: "Existing", value: "value", protected: false }],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const result = await new BitwardenProvider(fetcher).sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [cached] });

    expect(putCount).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.items[0]).toMatchObject({
      id: cached.id,
      bitwardenCustomFieldsVersion: 1,
      customFields: cached.customFields
    });
  });

  it("merges exact legacy occurrences once and then allows initialized field deletion", async () => {
    const enc = (value: string) => encryptBitwardenString(value, KEY);
    let remote: Record<string, unknown> = {
      ...(await loginCipher("remote-secret", OLD_REVISION)),
      Fields: [
        { Type: 0, Name: await enc("Remote"), Value: await enc("remote") },
        { Type: 0, Name: await enc("Duplicate"), Value: await enc("same") },
        { Type: 0, Name: await enc("Duplicate"), Value: await enc("same") },
        { Type: 2, Name: await enc("Boolean"), Value: await enc("true"), Future: "preserve" }
      ]
    };
    const writes: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(request);
        remote = {
          ...request,
          Id: "cipher-1",
          RevisionDate: writes.length === 1 ? "2026-07-15T03:02:00.000Z" : "2026-07-15T03:04:00.000Z",
          CreationDate: OLD_REVISION
        };
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const cached: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "remote-secret",
      uris: ["https://example.com"],
      customFields: [
        { name: "Remote", value: "remote", protected: false },
        { name: "Duplicate", value: "same", protected: false },
        { name: "Duplicate", value: "same", protected: false },
        { name: "Duplicate", value: "same", protected: false },
        { name: "LocalOnly", value: "local", protected: true }
      ],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const migrated = await provider.sync(account(), { now: "2026-07-15T03:03:00.000Z", localItems: [cached] });
    const migratedLogin = migrated.items[0] as LoginItem;
    expect(migrated.conflicts).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(migratedLogin.bitwardenCustomFieldsVersion).toBe(1);
    expect(migratedLogin.customFields).toEqual(cached.customFields);
    await expect(decryptedRequestFields(writes[0])).resolves.toEqual([
      ["Boolean", "true", 2, undefined],
      ["Remote", "remote", 0, null],
      ["Duplicate", "same", 0, null],
      ["Duplicate", "same", 0, null],
      ["Duplicate", "same", 0, null],
      ["LocalOnly", "local", 1, null]
    ]);

    const deleted: LoginItem = {
      ...migratedLogin,
      customFields: migratedLogin.customFields.filter((field) => field.name !== "Remote" && field.name !== "LocalOnly"),
      updatedAt: "2026-07-15T03:03:30.000Z"
    };
    const afterDelete = await provider.sync(account(), { now: "2026-07-15T03:05:00.000Z", localItems: [deleted] });

    expect(afterDelete.conflicts).toEqual([]);
    expect(writes).toHaveLength(2);
    await expect(decryptedRequestFields(writes[1])).resolves.toEqual([
      ["Boolean", "true", 2, undefined],
      ["Duplicate", "same", 0, null],
      ["Duplicate", "same", 0, null],
      ["Duplicate", "same", 0, null]
    ]);
  });

  it("requests a durable migration mutation instead of bypassing an explicit empty batch", async () => {
    const remoteField = { Type: 0, Name: await encryptBitwardenString("Remote", KEY), Value: await encryptBitwardenString("remote", KEY) };
    const remote = { ...(await loginCipher("remote-secret", OLD_REVISION)), Fields: [remoteField] };
    let putCount = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") putCount += 1;
      return json({ Profile: { Id: "user" }, Ciphers: [remote] });
    }) as unknown as typeof fetch;
    const cached: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "remote-secret",
      uris: ["https://example.com"],
      customFields: [
        { name: "Remote", value: "remote", protected: false },
        { name: "Local only", value: "local", protected: true }
      ],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };
    const now = "2026-07-15T03:01:00.000Z";

    const result = await new BitwardenProvider(fetcher).sync(account(), { now, localItems: [cached], pendingMutations: [] });

    expect(putCount).toBe(0);
    expect(result.requestedMutations).toEqual([{ itemId: cached.id, operation: "update" }]);
    expect(result.items[0]).toMatchObject({ bitwardenCustomFieldsVersion: 1, updatedAt: now, customFields: cached.customFields });
  });

  it("imports and updates an organization-shared login Cipher", async () => {
    const profile = await organizationProfile();
    let remote = await organizationLoginCipher("shared-secret", OLD_REVISION);
    let putCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: profile, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(request).toMatchObject({ organizationId: "org-1", collectionIds: ["collection-1"] });
        remote = { ...request, Id: "shared-cipher", RevisionDate: "2026-07-15T03:05:00.000Z", CreationDate: OLD_REVISION } as typeof remote;
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [] });
    const imported = first.items[0] as LoginItem;
    expect(first.warnings).toEqual([]);
    expect(imported).toMatchObject({ kind: "login", password: "shared-secret" });

    const result = await provider.sync(account(), { now: "2026-07-15T03:06:00.000Z", localItems: [{ ...imported, password: "updated-shared-secret", updatedAt: "2026-07-15T03:04:00.000Z" }] });
    expect(result.conflicts).toEqual([]);
    expect(result.items[0]).toMatchObject({ password: "updated-shared-secret" });
    expect(putCount).toBe(1);
  }, RSA_FIXTURE_TIMEOUT_MS);

  it("keeps an imported native SSH Cipher native while editing its known fields", async () => {
    let remote: Record<string, unknown> = {
      Id: "native-ssh-cipher",
      Type: 5,
      Name: await encryptBitwardenString("Native SSH", KEY),
      Notes: null,
      Favorite: false,
      RevisionDate: OLD_REVISION,
      CreationDate: OLD_REVISION,
      SshKey: {
        PrivateKey: await encryptBitwardenString("private-old", KEY),
        PublicKey: await encryptBitwardenString("ssh-ed25519 AAAA old", KEY),
        KeyFingerprint: await encryptBitwardenString("SHA256:old", KEY),
        FutureNative: { keep: true }
      },
      FutureTopLevel: "keep"
    };
    let putCount = 0;
    let written: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        remote = { ...written, Id: "native-ssh-cipher", RevisionDate: "2026-07-15T03:06:00.000Z", CreationDate: OLD_REVISION };
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const imported = await provider.sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [] });
    const item = imported.items[0] as LoginItem;
    const ssh = JSON.parse(item.sshKeyData || "{}") as Record<string, unknown>;
    expect(item).toMatchObject({ loginType: "SSH_KEY", bitwardenSshKeyMode: "native" });

    const result = await provider.sync(account(), {
      now: "2026-07-15T03:07:00.000Z",
      localItems: [{
        ...item,
        updatedAt: "2026-07-15T03:05:00.000Z",
        sshKeyData: JSON.stringify({ ...ssh, publicKeyOpenSsh: "ssh-ed25519 AAAA updated", fingerprintSha256: "SHA256:updated" })
      }]
    });

    expect(result.conflicts).toEqual([]);
    expect(putCount).toBe(1);
    expect(written).toMatchObject({ type: 5, futureTopLevel: "keep", sshKey: { futureNative: { keep: true } } });
    const writtenSsh = written?.sshKey as Record<string, unknown>;
    await expect(decryptBitwardenString(String(writtenSsh.publicKey), KEY)).resolves.toBe("ssh-ed25519 AAAA updated");
    expect(result.items[0]).toMatchObject({ loginType: "SSH_KEY", bitwardenSshKeyMode: "native" });
  });

  it("creates new SSH keys in the Monica Android Type 1 fallback format", async () => {
    let createdRequest: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [] });
      if (init?.method === "POST") {
        createdRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ ...createdRequest, Id: "fallback-created", RevisionDate: "2026-07-15T03:08:00.000Z", CreationDate: OLD_REVISION });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const local: LoginItem = {
      id: "local-fallback-ssh",
      kind: "login",
      title: "Fallback SSH",
      username: "",
      password: "",
      uris: [],
      uriRules: [],
      customFields: [{ name: "Owner", value: "Joy", protected: false }],
      favorite: false,
      notes: "",
      loginType: "SSH_KEY",
      sshKeyData: JSON.stringify({
        algorithm: "RSA",
        keySize: 4096,
        publicKeyOpenSsh: "ssh-rsa AAAA fallback",
        privateKeyOpenSsh: "private-fallback",
        fingerprintSha256: "SHA256:fallback",
        comment: "joy",
        format: "OPENSSH"
      }),
      createdAt: OLD_REVISION,
      updatedAt: "2026-07-15T03:07:00.000Z",
      providerRefs: [{ providerId: "provider-1" }]
    };

    const result = await new BitwardenProvider(fetcher).sync(account(), { now: "2026-07-15T03:09:00.000Z", localItems: [local] });

    expect(createdRequest?.type).toBe(1);
    expect(createdRequest?.sshKey).toBeUndefined();
    await expect(decryptedRequestFields(createdRequest || {})).resolves.toEqual(expect.arrayContaining([
      ["monica_login_type", "SSH_KEY", 0, null],
      ["monica_ssh_algorithm", "RSA", 0, null],
      ["monica_ssh_private_key", "private-fallback", 1, null],
      ["monica_ssh_fingerprint", "SHA256:fallback", 0, null],
      ["Owner", "Joy", 0, null]
    ]));
    expect(result.items[0]).toMatchObject({ id: local.id, loginType: "SSH_KEY", bitwardenSshKeyMode: "fallback" });
  });

  it("retains cached organization items when the organization key is unavailable", async () => {
    const remote = await organizationLoginCipher("remote-secret", OLD_REVISION);
    const cached: LoginItem = {
      id: "bitwarden:provider-1:shared-cipher",
      kind: "login",
      title: "Cached shared login",
      username: "cached",
      password: "cached-secret",
      uris: [],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "shared-cipher", revision: OLD_REVISION }]
    };
    const fetcher = vi.fn(async () => json({ Profile: { Id: "user", Organizations: [{ Id: "org-1", Key: "4.AA==" }] }, Ciphers: [remote] })) as unknown as typeof fetch;
    const result = await new BitwardenProvider(fetcher).sync(account(), { now: "2026-07-15T03:06:00.000Z", localItems: [cached] });
    expect(result.items).toEqual([cached]);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings.join(" ")).toContain("私钥");
  });

  it("does not overwrite concurrent browser and server changes", async () => {
    let remote = await loginCipher("initial", OLD_REVISION);
    let putCount = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") putCount += 1;
      return json({ Profile: { Id: "user" }, Ciphers: [remote] });
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [] });
    const local = { ...(first.items[0] as LoginItem), password: "browser", updatedAt: "2026-07-15T03:03:00.000Z" };
    remote = await loginCipher("server", "2026-07-15T03:02:00.000Z");
    const second = await provider.sync(account(), { now: "2026-07-15T03:04:00.000Z", localItems: [local] });
    expect(second.conflicts).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ password: "browser" });
    expect(putCount).toBe(0);
  });

  it("protects local cache when the server unexpectedly returns an empty vault", async () => {
    const fetcher = vi.fn(async () => json({ Profile: { Id: "user" }, Ciphers: [] })) as unknown as typeof fetch;
    const local: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Cached",
      username: "user",
      password: "secret",
      uris: ["example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };
    const result = await new BitwardenProvider(fetcher).sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [local] });
    expect(result.items).toEqual([local]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.warnings[0]).toContain("未删除本地缓存");
  });

  it("adopts an authenticated empty vault only after explicit confirmation", async () => {
    const fetcher = vi.fn(async () => json({ Profile: { Id: "user" }, Ciphers: [] })) as unknown as typeof fetch;
    const local: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Cached",
      username: "user",
      password: "secret",
      uris: ["example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const result = await new BitwardenProvider(fetcher).sync(account(), {
      now: "2026-07-15T03:01:00.000Z",
      localItems: [local],
      allowEmptyRemote: true
    });

    expect(result.items).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.accountPatch).toMatchObject({ requiresEmptyRemoteConfirmation: false });
  });

  it("keeps every cached item when empty-vault confirmation meets an unsynchronized edit", async () => {
    const fetcher = vi.fn(async () => json({ Profile: { Id: "user" }, Ciphers: [] })) as unknown as typeof fetch;
    const unchanged: LoginItem = {
      id: "bitwarden:provider-1:cipher-1", kind: "login", title: "Unchanged", username: "one", password: "one", uris: [], customFields: [],
      favorite: false, notes: "", createdAt: OLD_REVISION, updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };
    const changed: LoginItem = {
      ...unchanged,
      id: "bitwarden:provider-1:cipher-2",
      title: "Changed",
      password: "local edit",
      updatedAt: "2026-07-15T03:02:00.000Z",
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-2", revision: OLD_REVISION }]
    };

    const result = await new BitwardenProvider(fetcher).sync(account(), {
      now: "2026-07-15T03:03:00.000Z",
      localItems: [unchanged, changed],
      allowEmptyRemote: true,
      pendingMutations: [{ id: "pending-update", providerId: "provider-1", itemId: changed.id, operation: "update", createdAt: changed.updatedAt, attempts: 0 }]
    });

    expect(result.items).toEqual([unchanged, changed]);
    expect(result.conflicts).toEqual([expect.objectContaining({ itemId: changed.id, local: changed })]);
    expect(result.accountPatch).toMatchObject({ requiresEmptyRemoteConfirmation: true });
  });

  it("persists a count-only compatibility status for future Cipher types while retaining the raw record", async () => {
    const futureCipher = {
      Id: "future-cipher",
      Type: 99,
      Name: await encryptBitwardenString("Future record", KEY),
      RevisionDate: OLD_REVISION,
      CreationDate: OLD_REVISION,
      FutureBoolean: false,
      FutureNested: { values: [1, "two", null] }
    };
    const fetcher = vi.fn(async () => json({ Profile: { Id: "user" }, Ciphers: [futureCipher] })) as unknown as typeof fetch;

    const result = await new BitwardenProvider(fetcher).sync(account(), { now: "2026-07-15T03:03:00.000Z", localItems: [] });

    expect(result.items).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.accountPatch).toMatchObject({
      requiresEmptyRemoteConfirmation: false,
      compatibility: { preservedUnsupportedRecords: 1, unreadableRecords: 0 }
    });
    expect(JSON.parse(result.sourceRecords?.[0]?.payload || "{}")).toEqual(futureCipher);
    expect(result.warnings.join(" ")).toContain("类型 99");
  });

  it("keeps an existing local item untouched when its remote Cipher becomes a future type", async () => {
    let remote: Record<string, unknown> = await loginCipher("known-secret", OLD_REVISION);
    let writeCount = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writeCount += 1;
      return json({ Profile: { Id: "user" }, Ciphers: [remote] });
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const imported = await provider.sync(account(), { now: "2026-07-15T03:01:00.000Z", localItems: [] });
    const local = imported.items[0] as LoginItem;
    remote = {
      Id: "cipher-1",
      Type: 99,
      Name: await encryptBitwardenString("Future replacement", KEY),
      RevisionDate: "2026-07-15T03:02:00.000Z",
      CreationDate: OLD_REVISION,
      FutureBoolean: false,
      FutureNested: { values: [1, "two", null] }
    };

    const result = await provider.sync(account(), { now: "2026-07-15T03:03:00.000Z", localItems: [local], pendingMutations: [] });

    expect(result.items).toEqual([local]);
    expect(writeCount).toBe(0);
    expect(result.accountPatch?.compatibility).toEqual({ preservedUnsupportedRecords: 1, unreadableRecords: 0 });
    expect(JSON.parse(result.sourceRecords?.[0]?.payload || "{}")).toEqual(remote);
  });

  it("creates and trashes a personal Cipher through provider sync", async () => {
    let remote: Record<string, unknown>[] = [];
    let postCount = 0;
    const deleteUrls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: remote });
      if (init?.method === "POST") {
        postCount += 1;
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        const created = { ...request, id: "created-cipher", revisionDate: "2026-07-15T04:00:00.000Z", creationDate: OLD_REVISION };
        remote = [created];
        return json(created);
      }
      if (init?.method === "PUT" && String(input).endsWith("/delete")) {
        deleteUrls.push(String(input));
        remote = remote.map((cipher) => ({ ...cipher, deletedDate: "2026-07-15T04:03:00.000Z" }));
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const local: LoginItem = {
      id: "local-new",
      kind: "login",
      title: "New login",
      username: "joy",
      password: "secret",
      uris: ["https://new.example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1" }]
    };
    const created = await provider.sync(account(), { now: "2026-07-15T04:01:00.000Z", localItems: [local] });
    expect(created.conflicts).toEqual([]);
    expect(created.items[0]?.id).toBe(local.id);
    expect(created.items[0].providerRefs[0]).toMatchObject({ remoteId: "created-cipher", revision: "2026-07-15T04:00:00.000Z" });
    expect(postCount).toBe(1);

    const deleted = { ...created.items[0], updatedAt: "2026-07-15T04:02:00.000Z", deletedAt: "2026-07-15T04:02:00.000Z" } as LoginItem;
    const afterDelete = await provider.sync(account(), { now: "2026-07-15T04:03:00.000Z", localItems: [deleted] });
    expect(afterDelete.conflicts).toEqual([]);
    expect(afterDelete.items).toEqual([expect.objectContaining({ id: local.id, deletedAt: deleted.deletedAt })]);
    expect(deleteUrls).toEqual(["https://self.example.com/api/ciphers/created-cipher/delete"]);
  });

  it("persists a Bitwarden Passkey signature counter through its parent Cipher", async () => {
    let remote = await loginCipher("secret", OLD_REVISION, [await fidoCredential("credential-1", 7)]);
    let putCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "cipher-1", RevisionDate: "2026-07-15T05:01:00.000Z", CreationDate: OLD_REVISION } as typeof remote;
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T05:00:00.000Z", localItems: [] });
    const local = first.items.map((item) => item.kind === "passkey" ? { ...item, signCount: 8, updatedAt: "2026-07-15T05:00:30.000Z" } : item) as VaultItem[];

    const result = await provider.sync(account(), { now: "2026-07-15T05:02:00.000Z", localItems: local });

    expect(result.conflicts).toEqual([]);
    expect(putCount).toBe(1);
    expect(result.items).toHaveLength(2);
    expect(result.items.find((item): item is PasskeyItem => item.kind === "passkey")).toMatchObject({ credentialId: "credential-1", signCount: 8, updatedAt: "2026-07-15T05:01:00.000Z" });
  });

  it("deletes one Bitwarden Passkey without deleting its parent login or sibling", async () => {
    let remote = await loginCipher("secret", OLD_REVISION, [await fidoCredential("remove-me", 1), await fidoCredential("keep-me", 2)]);
    let putCount = 0;
    let deleteCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "cipher-1", RevisionDate: "2026-07-15T05:03:00.000Z", CreationDate: OLD_REVISION } as typeof remote;
        return json(remote);
      }
      if (init?.method === "DELETE") { deleteCount += 1; return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T05:00:00.000Z", localItems: [] });
    const local = first.items.map((item) => item.kind === "passkey" && item.credentialId === "remove-me" ? { ...item, updatedAt: "2026-07-15T05:02:00.000Z", deletedAt: "2026-07-15T05:02:00.000Z" } : item) as VaultItem[];

    const result = await provider.sync(account(), { now: "2026-07-15T05:04:00.000Z", localItems: local });

    expect(result.conflicts).toEqual([]);
    expect(putCount).toBe(1);
    expect(deleteCount).toBe(0);
    expect(result.items.map((item) => item.kind === "passkey" ? item.credentialId : item.kind)).toEqual(["login", "keep-me"]);
  });

  it("creates a new parent login Cipher for a Bitwarden-targeted Passkey", async () => {
    let postCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [] });
      if (init?.method === "POST") {
        postCount += 1;
        return json({ ...(JSON.parse(String(init.body)) as Record<string, unknown>), id: "passkey-cipher", revisionDate: "2026-07-15T05:05:00.000Z", creationDate: OLD_REVISION });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const item = localPasskey("new-credential");

    const result = await provider.sync(account(), { now: "2026-07-15T05:06:00.000Z", localItems: [item] });

    expect(result.conflicts).toEqual([]);
    expect(postCount).toBe(1);
    expect(result.items.map((candidate) => candidate.kind)).toEqual(["login", "passkey"]);
    expect(result.items.find((candidate) => candidate.kind === "passkey")?.providerRefs[0]).toMatchObject({ remoteId: "passkey-cipher#fido2:new-credential", revision: "2026-07-15T05:05:00.000Z" });
  });

  it("preserves the Monica Passkey identity through create update and child-only delete", async () => {
    let remote: Record<string, unknown> | undefined;
    let putCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: remote ? [remote] : [] });
      if (init?.method === "POST") {
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), id: "stable-passkey-cipher", revisionDate: "2026-07-15T05:10:00.000Z", creationDate: OLD_REVISION };
        return json(remote);
      }
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), id: "stable-passkey-cipher", revisionDate: `2026-07-15T05:1${putCount}:00.000Z`, creationDate: OLD_REVISION };
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const local = localPasskey("stable-credential");

    const created = await provider.sync(account(), { now: "2026-07-15T05:10:30.000Z", localItems: [local] });
    expect(created.conflicts).toEqual([]);
    expect(created.items.find((item) => item.kind === "passkey")?.id).toBe(local.id);

    const usedAt = "2026-07-15T05:10:45.000Z";
    const used = created.items.map((item) => item.kind === "passkey" ? { ...item, useCount: 1, lastUsedAt: usedAt, updatedAt: usedAt } : item) as VaultItem[];
    const updated = await provider.sync(account(), { now: "2026-07-15T05:11:30.000Z", localItems: used });
    const updatedPasskey = updated.items.find((item): item is PasskeyItem => item.kind === "passkey")!;
    expect(updated.conflicts).toEqual([]);
    expect(updatedPasskey).toMatchObject({ id: local.id, useCount: 1, lastUsedAt: usedAt, publicKey: local.publicKey });

    const deleted = updated.items.map((item) => item.kind === "passkey" ? { ...item, deletedAt: "2026-07-15T05:11:45.000Z", updatedAt: "2026-07-15T05:11:45.000Z" } : item) as VaultItem[];
    const afterDelete = await provider.sync(account(), { now: "2026-07-15T05:12:30.000Z", localItems: deleted });
    expect(afterDelete.conflicts).toEqual([]);
    expect(afterDelete.items.map((item) => item.kind)).toEqual(["login"]);
    expect(putCount).toBe(2);
  });

  it("coalesces login and Passkey changes for the same Cipher into one update", async () => {
    let remote = await loginCipher("initial", OLD_REVISION, [await fidoCredential("credential-1", 3)]);
    let putCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "PUT") {
        putCount += 1;
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "cipher-1", RevisionDate: "2026-07-15T05:07:00.000Z", CreationDate: OLD_REVISION } as typeof remote;
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T05:00:00.000Z", localItems: [] });
    const changed = first.items.map((item) => item.kind === "login"
      ? { ...item, password: "changed", updatedAt: "2026-07-15T05:06:00.000Z" }
      : { ...item, signCount: 4, updatedAt: "2026-07-15T05:06:00.000Z" }) as VaultItem[];

    const result = await provider.sync(account(), { now: "2026-07-15T05:08:00.000Z", localItems: changed });

    expect(result.conflicts).toEqual([]);
    expect(putCount).toBe(1);
    expect(result.items.find((item): item is LoginItem => item.kind === "login")?.password).toBe("changed");
    expect(result.items.find((item): item is PasskeyItem => item.kind === "passkey")?.signCount).toBe(4);
  });
  it("keeps a trashed remote Cipher as a local encrypted tombstone", async () => {
    const remote = { ...(await loginCipher("remote-secret", OLD_REVISION)), DeletedDate: "2026-07-15T06:00:00.000Z" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);

    const result = await provider.sync(account(), { now: "2026-07-15T06:01:00.000Z", localItems: [] });

    expect(result.conflicts).toEqual([]);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "bitwarden:provider-1:cipher-1",
        kind: "login",
        deletedAt: "2026-07-15T06:00:00.000Z"
      })
    ]);
    expect(result.sourceRecords?.[0]).toMatchObject({ remoteId: "cipher-1", format: "bitwarden-cipher" });
  });

  it("retains a previously cached tombstone when the server Cipher remains trashed", async () => {
    const remote = { ...(await loginCipher("remote-secret", OLD_REVISION)), DeletedDate: "2026-07-15T06:00:00.000Z" };
    let deleteCount = 0;
    let writeCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (init?.method === "DELETE") { deleteCount += 1; return new Response(null, { status: 204 }); }
      writeCount += 1;
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const cached: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "joy",
      password: "remote-secret",
      uris: [],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const result = await provider.sync(account(), { now: "2026-07-15T06:01:00.000Z", localItems: [cached] });

    expect(deleteCount).toBe(0);
    expect(writeCount).toBe(0);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: cached.id,
        deletedAt: "2026-07-15T06:00:00.000Z"
      })
    ]);
  });

  it("never issues Bitwarden's permanent delete for a locally trashed item", async () => {
    const remote = await loginCipher("remote-secret", OLD_REVISION);
    const methods: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      methods.push(`${init?.method} ${new URL(String(input)).pathname}`);
      if (init?.method === "PUT" && String(input).endsWith("/delete")) return new Response(null, { status: 200 });
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const trashed: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "remote-secret",
      uris: ["https://example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: "2026-07-15T07:00:00.000Z",
      deletedAt: "2026-07-15T07:00:00.000Z",
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const result = await provider.sync(account(), { now: "2026-07-15T07:01:00.000Z", localItems: [trashed] });

    expect(result.conflicts).toEqual([]);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: trashed.id,
        deletedAt: trashed.deletedAt
      })
    ]);
    expect(methods).toEqual(["PUT /api/ciphers/cipher-1/delete"]);
  });

  it("moves every login and Passkey sibling into the local recycle-bin projection together", async () => {
    const remote = await loginCipher("remote-secret", OLD_REVISION, [await fidoCredential("first", 1), await fidoCredential("second", 2)]);
    let deleteCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      if (String(input).endsWith("/delete") && init?.method === "PUT") {
        deleteCount += 1;
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const imported = await provider.sync(account(), { now: "2026-07-15T07:00:00.000Z", localItems: [] });
    const deletedAt = "2026-07-15T07:01:00.000Z";
    const local = imported.items.map((item) => item.kind === "login" ? { ...item, deletedAt, updatedAt: deletedAt } : item) as VaultItem[];

    const result = await provider.sync(account(), { now: "2026-07-15T07:02:00.000Z", localItems: local });

    expect(deleteCount).toBe(1);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.deletedAt === deletedAt)).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(imported.items.map((item) => item.id));
  });

  it("restores a remotely trashed Cipher before writing a revived local edit", async () => {
    let remote: Record<string, unknown> = { ...(await loginCipher("remote-secret", OLD_REVISION)), DeletedDate: "2026-07-15T08:00:00.000Z" };
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path.endsWith("/restore")) {
        remote = { ...remote, DeletedDate: null };
        return json(remote);
      }
      if (init?.method === "PUT") {
        remote = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "cipher-1", RevisionDate: "2026-07-15T08:02:00.000Z", CreationDate: OLD_REVISION };
        return json(remote);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const revived: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "revived",
      uris: ["https://example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: "2026-07-15T08:01:00.000Z",
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const result = await provider.sync(account(), { now: "2026-07-15T08:03:00.000Z", localItems: [revived] });

    expect(result.conflicts).toEqual([]);
    expect(calls).toEqual(["PUT /api/ciphers/cipher-1/restore", "PUT /api/ciphers/cipher-1"]);
    expect(result.items.find((item): item is LoginItem => item.kind === "login")).toMatchObject({ password: "revived", deletedAt: undefined });
  });

  it("does not re-trash a Cipher the server already moved to the recycle bin", async () => {
    const remote = { ...(await loginCipher("remote-secret", OLD_REVISION)), DeletedDate: "2026-07-15T09:00:00.000Z" };
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remote] });
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const trashed: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "remote-secret",
      uris: ["https://example.com"],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: "2026-07-15T09:01:00.000Z",
      deletedAt: "2026-07-15T09:01:00.000Z",
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    const result = await provider.sync(account(), { now: "2026-07-15T09:02:00.000Z", localItems: [trashed] });

    expect(result.conflicts).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("moves an explicit provider removal to the Bitwarden recycle bin", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${new URL(String(input)).pathname}`);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const item: LoginItem = {
      id: "bitwarden:provider-1:cipher-1",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "remote-secret",
      uris: [],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: OLD_REVISION,
      providerRefs: [{ providerId: "provider-1", remoteId: "cipher-1", revision: OLD_REVISION }]
    };

    await new BitwardenProvider(fetcher).remove(account(), item);

    expect(calls).toEqual(["PUT /api/ciphers/cipher-1/delete"]);
  });

  it("defers local edits outside the durable batch instead of overwriting them", async () => {
    let remoteA = await loginCipher("remote-a", OLD_REVISION);
    let remoteB = { ...(await loginCipher("remote-b", OLD_REVISION)), Id: "cipher-2" };
    let putCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: [remoteA, remoteB] });
      if (init?.method === "PUT") {
        putCount += 1;
        remoteA = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), Id: "cipher-1", RevisionDate: "2026-07-15T10:01:00.000Z", CreationDate: OLD_REVISION } as typeof remoteA;
        return json(remoteA);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    const imported = await provider.sync(account(), { now: "2026-07-15T10:00:00.000Z", localItems: [] });
    const first = imported.items.find((item) => item.providerRefs.some((reference) => reference.remoteId === "cipher-1")) as LoginItem;
    const second = imported.items.find((item) => item.providerRefs.some((reference) => reference.remoteId === "cipher-2")) as LoginItem;
    const changedA = { ...first, password: "browser-a", updatedAt: "2026-07-15T10:00:30.000Z" };
    const changedB = { ...second, password: "browser-b", updatedAt: "2026-07-15T10:00:31.000Z" };
    const result = await provider.sync(account(), {
      now: "2026-07-15T10:02:00.000Z",
      localItems: [changedA, changedB],
      pendingMutations: [{ id: "mutation-a", providerId: "provider-1", itemId: changedA.id, operation: "update", createdAt: changedA.updatedAt, attempts: 0 }]
    });
    expect(putCount).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.items.find((item) => item.id === changedB.id)).toMatchObject({ password: "browser-b" });
  });

  it("recovers a Bitwarden create after the response is lost without issuing a second POST", async () => {
    let remote: Record<string, unknown>[] = [];
    let postCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: remote });
      if (init?.method === "POST") {
        postCount += 1;
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        remote = [{ ...request, id: "created-after-restart", revisionDate: "2026-07-15T11:01:00.000Z", creationDate: OLD_REVISION }];
        if (postCount === 1) return new Response("{malformed", { status: 200, headers: { "Content-Type": "application/json" } });
        return json(remote[0]);
      }
      throw new Error(`Unexpected ${init?.method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const provider = new BitwardenProvider(fetcher);
    // Build the local item from the same Android/Bitwarden projection used by
    // the decoder so the recovery fingerprint compares content only.
    const local: LoginItem = {
      id: "create-after-restart",
      kind: "login",
      title: "Example",
      username: "alice",
      password: "secret",
      uris: ["https://example.com"],
      uriRules: [{ uri: "https://example.com", matchType: "base-domain" }],
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: OLD_REVISION,
      updatedAt: "2026-07-15T11:00:00.000Z",
      providerRefs: [{ providerId: "provider-1" }]
    };
    const fingerprint = await bitwardenMutationFingerprint(local);
    const mutation = { id: "mutation-create", providerId: "provider-1", itemId: local.id, operation: "create" as const, createdAt: local.updatedAt, attempts: 0 };
    let attempted = false;
    const prepared = {
      version: 1 as const,
      providerId: "provider-1",
      mutationId: mutation.id,
      itemId: local.id,
      operation: "create" as const,
      stage: "prepared" as const,
      intentFingerprint: fingerprint,
      attemptCount: 0,
      createdAt: local.createdAt,
      updatedAt: local.updatedAt
    };
    const first = await provider.sync(account(), {
      now: "2026-07-15T11:00:01.000Z",
      localItems: [local],
      pendingMutations: [mutation],
      mutationReceipts: [prepared],
      markMutationsAttempted: async () => { attempted = true; }
    });
    expect(attempted).toBe(true);
    expect(first.conflicts).toHaveLength(1);
    expect(postCount).toBe(1);
    const recovered = await provider.sync(account(), {
      now: "2026-07-15T11:02:00.000Z",
      localItems: [local],
      pendingMutations: [mutation],
      mutationReceipts: [{ ...prepared, stage: "attempted", attemptCount: 1, attemptedAt: "2026-07-15T11:00:01.000Z", updatedAt: "2026-07-15T11:00:01.000Z" }]
    });
    expect(recovered.conflicts).toEqual([]);
    expect(recovered.acknowledgedMutations).toMatchObject([{ mutationId: mutation.id, itemId: local.id, operation: "create", remoteId: "created-after-restart" }]);
    expect(postCount).toBe(1);
    expect(recovered.items.find((item) => item.id === local.id)?.providerRefs).toContainEqual(expect.objectContaining({ remoteId: "created-after-restart" }));
  });
});

function account(): ProviderAccount {
  return {
    id: "provider-1",
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

async function loginCipher(password: string, revisionDate: string, fido2Credentials: Record<string, unknown>[] = []) {
  return {
    Id: "cipher-1",
    Type: 1,
    Name: await encryptBitwardenString("Example", KEY),
    Notes: null,
    Favorite: false,
    RevisionDate: revisionDate,
    CreationDate: OLD_REVISION,
    Login: {
      Username: await encryptBitwardenString("alice", KEY),
      Password: await encryptBitwardenString(password, KEY),
      Uris: [{ Uri: await encryptBitwardenString("https://example.com", KEY) }],
      Fido2Credentials: fido2Credentials
    }
  };
}

async function organizationProfile() {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
  const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const rawOrganizationKey = new Uint8Array(64);
  rawOrganizationKey.set(ORGANIZATION_KEY.encKey);
  rawOrganizationKey.set(ORGANIZATION_KEY.macKey, 32);
  const encryptedOrganizationKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, rawOrganizationKey));
  return {
    Id: "user",
    PrivateKey: await encryptBitwardenString(bytesToBase64(privateKey), KEY),
    Organizations: [{ Id: "org-1", Key: `4.${bytesToBase64(encryptedOrganizationKey)}` }]
  };
}

async function organizationLoginCipher(password: string, revisionDate: string) {
  return {
    Id: "shared-cipher",
    OrganizationId: "org-1",
    CollectionIds: ["collection-1"],
    Type: 1,
    Name: await encryptBitwardenString("Shared Example", ORGANIZATION_KEY),
    Notes: null,
    Favorite: false,
    RevisionDate: revisionDate,
    CreationDate: OLD_REVISION,
    Login: {
      Username: await encryptBitwardenString("shared-user", ORGANIZATION_KEY),
      Password: await encryptBitwardenString(password, ORGANIZATION_KEY),
      Uris: [{ Uri: await encryptBitwardenString("https://shared.example.com", ORGANIZATION_KEY) }]
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
    CreationDate: await enc(OLD_REVISION)
  };
}

async function decryptedRequestFields(request: Record<string, unknown>): Promise<Array<[string, string, number, unknown]>> {
  const fields = Array.isArray(request.fields) ? request.fields as Array<Record<string, unknown>> : [];
  return Promise.all(fields.map(async (field) => {
    const name = field.name ?? field.Name;
    const value = field.value ?? field.Value;
    const type = field.type ?? field.Type;
    return [
      typeof name === "string" ? await decryptBitwardenString(name, KEY) : "",
      typeof value === "string" ? await decryptBitwardenString(value, KEY) : "",
      typeof type === "number" ? type : -1,
      "linkedId" in field ? field.linkedId : field.LinkedId
    ] as [string, string, number, unknown];
  }));
}

function localPasskey(credentialId: string): PasskeyItem {
  return {
    id: `local-${credentialId}`,
    kind: "passkey",
    title: "Example Passkey",
    favorite: false,
    notes: "",
    createdAt: OLD_REVISION,
    updatedAt: OLD_REVISION,
    providerRefs: [{ providerId: "provider-1" }],
    credentialId,
    rpId: "example.com",
    rpName: "Example",
    userHandle: "dXNlcg",
    userName: "joy@example.com",
    userDisplayName: "Joy",
    algorithm: -7,
    publicKey: "spki",
    privateKeyPkcs8: "pkcs8-new",
    signCount: 0,
    discoverable: true,
    sourceMode: "bitwarden"
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
