import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenClient } from "./bitwarden-client";
import { BitwardenFolderService } from "./bitwarden-folders";

const KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 65)
};
const REVISION = "2026-08-08T08:00:00.000Z";

describe("Bitwarden folder service", () => {
  it("reads encrypted Folders from sync and counts active Ciphers", async () => {
    const folders = [await rawFolder("Work", "folder-work", REVISION), await rawFolder("Archive", "folder-archive", REVISION)];
    const fetcher = vi.fn(async () => json({ Folders: folders, Ciphers: [
      { Id: "cipher-1", FolderId: "folder-work" },
      { Id: "cipher-2", FolderId: "folder-work", DeletedDate: "2026-08-08T08:01:00.000Z" },
      { Id: "cipher-3", FolderId: "folder-archive" }
    ] })) as unknown as typeof fetch;
    const service = new BitwardenFolderService(new BitwardenClient(fetcher, fastTransport()));

    const result = await service.list(activeSession(), { pageSize: 1 });
    expect(result.page).toMatchObject({ total: 2, nextCursor: "1" });
    expect(result.page.items[0]).toMatchObject({ folderId: "folder-work", name: "Work", cipherCount: 1, readable: true });
    expect(JSON.stringify(result.page)).not.toContain(folders[0].Name as string);
    const next = await service.list(activeSession(), { pageSize: 1, cursor: result.page.nextCursor });
    expect(next.page.items[0]).toMatchObject({ folderId: "folder-archive", name: "Archive", cipherCount: 1 });
  });

  it("encrypts create and rename names and refuses a stale folder revision", async () => {
    const current = await rawFolder("Work", "folder-work", REVISION);
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({ url, method, body });
      if (url.includes("/sync")) return json({ Folders: [current], Ciphers: [] });
      if (method === "PUT") return json({ Id: "folder-work", Name: body?.name, RevisionDate: "2026-08-08T08:02:00.000Z" });
      if (method === "POST") return json({ Id: "folder-new", Name: body?.name, RevisionDate: "2026-08-08T08:03:00.000Z" });
      throw new Error(`Unexpected ${method} ${url}`);
    }) as unknown as typeof fetch;
    const service = new BitwardenFolderService(new BitwardenClient(fetcher, fastTransport()));

    const created = await service.create(activeSession(), "Personal");
    expect(created.result.folder).toMatchObject({ folderId: "folder-new", name: "Personal" });
    const renamed = await service.rename(activeSession(), "folder-work", "Work 2", REVISION);
    expect(renamed.result.folder).toMatchObject({ folderId: "folder-work", name: "Work 2" });
    await expect(service.rename(activeSession(), "folder-work", "Nope", "2020-01-01T00:00:00.000Z"))
      .rejects.toMatchObject({ code: "folder-conflict" });
    const writes = calls.filter((call) => call.method === "POST" || call.method === "PUT");
    await expect(decryptBitwardenString(String(writes[0].body?.name), KEY)).resolves.toBe("Personal");
    await expect(decryptBitwardenString(String(writes[1].body?.name), KEY)).resolves.toBe("Work 2");
  });

  it("treats an already absent folder as an idempotent delete", async () => {
    const current = await rawFolder("Work", "folder-work", REVISION);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sync")) return json({ Folders: [current], Ciphers: [] });
      if (url.endsWith("/folders/folder-work")) return json({ message: "gone" }, 404);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const result = await new BitwardenFolderService(new BitwardenClient(fetcher, fastTransport())).remove(activeSession(), "folder-work", REVISION);
    expect(result.result).toMatchObject({ changed: false, alreadyAbsent: true });
  });

  it("moves a personal Cipher by changing only FolderId and preserves opaque fields", async () => {
    const target = await rawFolder("Work", "folder-work", REVISION);
    const encryptedName = await encryptBitwardenString("Secret", KEY);
    const raw = {
      Id: "cipher-1",
      Type: 1,
      Name: encryptedName,
      RevisionDate: REVISION,
      FolderId: "folder-old",
      Login: { Username: "2.opaque", Fido2Credentials: [{ CredentialId: "2.passkey" }] },
      FutureCipherField: { untouched: true }
    };
    let written: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sync")) return json({ Folders: [target], Ciphers: [raw] });
      if (init?.method === "PUT") {
        written = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({ ...raw, ...written, Id: "cipher-1", RevisionDate: "2026-08-08T08:04:00.000Z" });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const result = await new BitwardenFolderService(new BitwardenClient(fetcher, fastTransport())).moveCipher(activeSession(), "cipher-1", "folder-work", REVISION, REVISION);
    expect(result.result).toMatchObject({ changed: true, previousFolderId: "folder-old", targetFolderId: "folder-work" });
    expect(written).toMatchObject({ folderId: "folder-work", futureCipherField: { untouched: true } });
    expect((written?.login as Record<string, unknown>).Fido2Credentials).toEqual(raw.Login.Fido2Credentials);
    expect(written).not.toHaveProperty("FolderId");
  });

  it("fails closed for organization Ciphers and stale target folders", async () => {
    const target = await rawFolder("Work", "folder-work", REVISION);
    const organizationCipher = { Id: "cipher-org", OrganizationId: "org-1", RevisionDate: REVISION, FolderId: null };
    const fetcher = vi.fn(async () => json({ Folders: [target], Ciphers: [organizationCipher] })) as unknown as typeof fetch;
    const service = new BitwardenFolderService(new BitwardenClient(fetcher, fastTransport()));
    await expect(service.moveCipher(activeSession(), "cipher-org", "folder-work", REVISION, REVISION))
      .rejects.toMatchObject({ code: "folder-organization-cipher" });

    const personal = { Id: "cipher-1", RevisionDate: REVISION, FolderId: null };
    const staleFetcher = vi.fn(async () => json({ Folders: [target], Ciphers: [personal] })) as unknown as typeof fetch;
    await expect(new BitwardenFolderService(new BitwardenClient(staleFetcher, fastTransport())).moveCipher(activeSession(), "cipher-1", "folder-work", REVISION, "stale"))
      .rejects.toMatchObject({ code: "folder-conflict" });
  });
});

async function rawFolder(name: string, id: string, revision: string): Promise<Record<string, unknown>> {
  return { Id: id, Name: await encryptBitwardenString(name, KEY), RevisionDate: revision };
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
    vaultKeyEnc: bytesToBase64(KEY.encKey),
    vaultKeyMac: bytesToBase64(KEY.macKey)
  };
}

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
