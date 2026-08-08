import { beforeAll, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import { encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenClient } from "./bitwarden-client";
import { BitwardenCollectionService } from "./bitwarden-collections";

const USER_KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 65)
};
const ORGANIZATION_KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 101),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 133)
};
const REVISION = "2026-08-08T08:00:00.000Z";
const RSA_FIXTURE_TIMEOUT_MS = 15_000;

let privateKeyCipher = "";
let organizationKeyCipher = "";

describe("Bitwarden organization Collection service", () => {
  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-1"
    }, true, ["encrypt", "decrypt"]);
    const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const encryptedOrganizationKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, joinKey(ORGANIZATION_KEY) as unknown as BufferSource));
    privateKeyCipher = await encryptBitwardenString(bytesToBase64(privateKeyPkcs8), USER_KEY);
    organizationKeyCipher = `4.${bytesToBase64(encryptedOrganizationKey)}`;
  }, RSA_FIXTURE_TIMEOUT_MS);

  it("decodes encrypted collections and the OrganizationsNew projection", async () => {
    const payload = await syncPayload({
      organizationProjection: "OrganizationsNew",
      collections: [
        await rawCollection("Shared", "collection-shared", "org-1", { ReadOnly: false, HidePasswords: false, Manage: true, Assigned: true }),
        { Id: "collection-missing-name", OrganizationId: "org-1", ReadOnly: false, HidePasswords: false, Manage: true }
      ]
    });
    const page = await new BitwardenCollectionService(new BitwardenClient(vi.fn(async () => json(payload)) as unknown as typeof fetch, fastTransport())).list(activeSession());

    expect(page.page.organizations).toEqual(expect.arrayContaining([expect.objectContaining({ organizationId: "org-1", keyAvailable: true })]));
    expect(page.page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ collectionId: "collection-shared", name: "Shared", readable: true, targetable: true, permissionKnown: true }),
      expect.objectContaining({ collectionId: "collection-missing-name", readable: false, targetable: false })
    ]));
    expect(JSON.stringify(page.page)).not.toContain("4.");
  });

  it("fails closed when organization keys or collection permissions are unavailable", async () => {
    const payload = await syncPayload({
      organizations: [
        { Id: "org-1", Name: await encryptBitwardenString("Org", ORGANIZATION_KEY), Key: "4.AA==", Type: "Manager", Status: "Confirmed", Enabled: true }
      ],
      collections: [
        await rawCollection("Read only", "collection-read-only", "org-1", { ReadOnly: true, HidePasswords: false, Manage: true }),
        await rawCollection("Unknown permissions", "collection-unknown", "org-1", {})
      ]
    });
    const page = await new BitwardenCollectionService(new BitwardenClient(vi.fn(async () => json(payload)) as unknown as typeof fetch, fastTransport())).list(activeSession());

    expect(page.page.warnings.join(" ")).toContain("密钥");
    expect(page.page.items.every((item) => !item.readable && !item.targetable)).toBe(true);
  });

  it("does not route disabled, unconfirmed, or unassigned collections", async () => {
    const payload = await syncPayload({
      organizations: [
        { Id: "org-1", Name: await encryptBitwardenString("Org", ORGANIZATION_KEY), Key: organizationKeyCipher, Type: "Manager", Status: "Confirmed", Enabled: true },
        { Id: "org-2", Name: await encryptBitwardenString("Pending", ORGANIZATION_KEY), Key: organizationKeyCipher, Type: "Manager", Status: "Invited", Enabled: true }
      ],
      collections: [
        await rawCollection("Unassigned", "collection-unassigned", "org-1", { ReadOnly: false, HidePasswords: false, Manage: false, Assigned: false }),
        await rawCollection("Pending", "collection-pending", "org-2", { ReadOnly: false, HidePasswords: false, Manage: true, Assigned: true })
      ]
    });
    const page = await new BitwardenCollectionService(new BitwardenClient(vi.fn(async () => json(payload)) as unknown as typeof fetch, fastTransport())).list(activeSession());
    expect(page.page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ collectionId: "collection-unassigned", readable: true, targetable: false }),
      expect.objectContaining({ collectionId: "collection-pending", readable: false, targetable: false })
    ]));
  });

  it("routes a shared Cipher through collections_v2 and preserves opaque fields", async () => {
    const raw = {
      Id: "cipher-shared",
      OrganizationId: "org-1",
      CollectionIds: ["collection-old"],
      RevisionDate: REVISION,
      Login: { Username: "2.opaque", Fido2Credentials: [{ CredentialId: "future-passkey" }] },
      FutureField: { keep: true }
    };
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const payload = await syncPayload({ collections: [
      await rawCollection("Old", "collection-old", "org-1", { ReadOnly: false, HidePasswords: false, Manage: true }),
      await rawCollection("Target", "collection-target", "org-1", { ReadOnly: false, HidePasswords: false, Manage: true })
    ], ciphers: [raw] });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.includes("/sync")) return json(payload);
      if (method === "PUT") return json({ unavailable: false, cipher: { ...raw, CollectionIds: ["collection-target"], RevisionDate: "2026-08-08T08:01:00.000Z" } });
      throw new Error(`Unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;

    const result = await new BitwardenCollectionService(new BitwardenClient(fetcher, fastTransport())).moveCipher(activeSession(), "cipher-shared", ["collection-target"], REVISION);
    expect(result.result).toMatchObject({ changed: true, organizationId: "org-1", previousCollectionIds: ["collection-old"], collectionIds: ["collection-target"] });
    const write = calls.find((call) => call.method === "PUT");
    expect(write?.url).toContain("/ciphers/cipher-shared/collections_v2");
    expect(write?.body).toEqual({ collectionIds: ["collection-target"] });
    expect(result.result.rawCipher).toMatchObject({ FutureField: { keep: true }, collectionIds: ["collection-target"], revisionDate: "2026-08-08T08:01:00.000Z" });
    expect(result.result.rawCipher).not.toHaveProperty("CollectionIds");
  });

  it("does not write when only the Collection order changed", async () => {
    const raw = { Id: "cipher-shared", OrganizationId: "org-1", CollectionIds: ["collection-a", "collection-b"], RevisionDate: REVISION };
    const payload = await syncPayload({ collections: [
      await rawCollection("A", "collection-a", "org-1", { ReadOnly: false, HidePasswords: false, Manage: true }),
      await rawCollection("B", "collection-b", "org-1", { ReadOnly: false, HidePasswords: false, Manage: true })
    ], ciphers: [raw] });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("unexpected write");
      return json(payload);
    }) as unknown as typeof fetch;
    const result = await new BitwardenCollectionService(new BitwardenClient(fetcher, fastTransport())).moveCipher(activeSession(), "cipher-shared", ["collection-b", "collection-a"], REVISION);
    expect(result.result.changed).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects personal and cross-organization targets before any write", async () => {
    const payload = await syncPayload({
      organizations: [
        { Id: "org-1", Name: await encryptBitwardenString("Org 1", ORGANIZATION_KEY), Key: organizationKeyCipher, Type: "Manager", Status: "Confirmed", Enabled: true },
        { Id: "org-2", Name: await encryptBitwardenString("Org 2", ORGANIZATION_KEY), Key: organizationKeyCipher, Type: "Manager", Status: "Confirmed", Enabled: true }
      ],
      collections: [await rawCollection("Other", "collection-other", "org-2", { ReadOnly: false, HidePasswords: false, Manage: true })],
      ciphers: [{ Id: "personal", RevisionDate: REVISION }, { Id: "shared", OrganizationId: "org-1", CollectionIds: [], RevisionDate: REVISION }]
    });
    const fetcher = vi.fn(async () => json(payload)) as unknown as typeof fetch;
    const service = new BitwardenCollectionService(new BitwardenClient(fetcher, fastTransport()));
    await expect(service.moveCipher(activeSession(), "personal", ["collection-other"], REVISION)).rejects.toMatchObject({ code: "collection-personal-cipher" });
    await expect(service.moveCipher(activeSession(), "shared", ["collection-other"], REVISION)).rejects.toMatchObject({ code: "collection-target-invalid" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects unavailable and reduced responses without acknowledging a stale revision", async () => {
    const raw = { Id: "cipher-shared", OrganizationId: "org-1", CollectionIds: [], RevisionDate: REVISION };
    const collection = await rawCollection("Target", "collection-target", "org-1", { ReadOnly: false, HidePasswords: false, Manage: true });
    const makePayload = await syncPayload({ collections: [collection], ciphers: [raw] });
    for (const response of [{ unavailable: true }, { unavailable: false, cipher: { Id: raw.Id, CollectionIds: [collection.Id] } }]) {
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/sync")) return json(makePayload);
        if (init?.method === "PUT") return json(response);
        throw new Error("unexpected request");
      }) as unknown as typeof fetch;
      await expect(new BitwardenCollectionService(new BitwardenClient(fetcher, fastTransport())).moveCipher(activeSession(), "cipher-shared", ["collection-target"], REVISION))
        .rejects.toMatchObject({ code: response.unavailable ? "cipher-unavailable" : "cipher-response-invalid" });
    }
  });
});

async function syncPayload(input: {
  organizationProjection?: "Organizations" | "OrganizationsNew";
  organizations?: Record<string, unknown>[];
  collections?: Record<string, unknown>[];
  ciphers?: Record<string, unknown>[];
}): Promise<Record<string, unknown>> {
  const organizations = input.organizations || [{
    Id: "org-1",
    Name: await encryptBitwardenString("Shared org", ORGANIZATION_KEY),
    Key: organizationKeyCipher,
    Type: "Manager",
    Enabled: true,
    Permissions: { EditAssignedCollections: true, CreateNewCollections: true },
    Status: "Confirmed"
  }];
  return {
    Profile: {
      PrivateKey: privateKeyCipher,
      [input.organizationProjection || "Organizations"]: organizations
    },
    Collections: input.collections || [],
    Ciphers: input.ciphers || []
  };
}

async function rawCollection(name: string, id: string, organizationId: string, permissions: Record<string, unknown>): Promise<Record<string, unknown>> {
  return {
    Id: id,
    OrganizationId: organizationId,
    Name: await encryptBitwardenString(name, ORGANIZATION_KEY),
    RevisionDate: REVISION,
    ...permissions
  };
}

function joinKey(key: BitwardenSymmetricKey): Uint8Array {
  const result = new Uint8Array(64);
  result.set(key.encKey, 0);
  result.set(key.macKey, 32);
  return result;
}

function activeSession() {
  return {
    vaultUrl: "https://self.example.com",
    apiUrl: "https://self.example.com/api",
    identityUrl: "https://self.example.com/identity",
    email: "alice@example.com",
    deviceId: "device-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3_600_000,
    kdf: { type: 0 as const, iterations: 1 },
    vaultKeyEnc: bytesToBase64(USER_KEY.encKey),
    vaultKeyMac: bytesToBase64(USER_KEY.macKey)
  };
}

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
