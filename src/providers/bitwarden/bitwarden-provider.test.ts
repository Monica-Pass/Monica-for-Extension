import { describe, expect, it, vi } from "vitest";
import type { LoginItem, ProviderAccount } from "../../core/model";
import { bytesToBase64 } from "../../security/encoding";
import { encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenProvider } from "./bitwarden-provider";

const KEY: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 32) };
const OLD_REVISION = "2026-07-15T03:00:00.000Z";

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

  it("creates and deletes a personal Cipher through provider sync", async () => {
    let remote: Record<string, unknown>[] = [];
    let postCount = 0;
    let deleteCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/sync")) return json({ Profile: { Id: "user" }, Ciphers: remote });
      if (init?.method === "POST") {
        postCount += 1;
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        const created = { ...request, id: "created-cipher", revisionDate: "2026-07-15T04:00:00.000Z", creationDate: OLD_REVISION };
        remote = [created];
        return json(created);
      }
      if (init?.method === "DELETE") {
        deleteCount += 1;
        remote = [];
        return new Response(null, { status: 204 });
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
    expect(created.items[0].providerRefs[0]).toMatchObject({ remoteId: "created-cipher", revision: "2026-07-15T04:00:00.000Z" });
    expect(postCount).toBe(1);

    const deleted = { ...created.items[0], updatedAt: "2026-07-15T04:02:00.000Z", deletedAt: "2026-07-15T04:02:00.000Z" } as LoginItem;
    const afterDelete = await provider.sync(account(), { now: "2026-07-15T04:03:00.000Z", localItems: [deleted] });
    expect(afterDelete.conflicts).toEqual([]);
    expect(afterDelete.items).toEqual([]);
    expect(deleteCount).toBe(1);
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

async function loginCipher(password: string, revisionDate: string) {
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
      Uris: [{ Uri: await encryptBitwardenString("https://example.com", KEY) }]
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
