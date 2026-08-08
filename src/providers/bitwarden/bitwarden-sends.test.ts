import { describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import {
  decryptBitwardenBytes,
  decryptBitwardenString,
  deriveBitwardenSendKey,
  encryptBitwardenBytes,
  encryptBitwardenString,
  hashBitwardenSendPassword,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";
import { BitwardenClient } from "./bitwarden-client";
import { BitwardenSendService } from "./bitwarden-sends";

const VAULT_KEY: BitwardenSymmetricKey = {
  encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 65)
};
const SEED = Uint8Array.from({ length: 16 }, (_, index) => index);
const NOW = Date.parse("2026-08-08T08:00:00.000Z");
const REVISION = "2026-08-08T08:01:00.000Z";
const NEXT_REVISION = "2026-08-08T08:02:00.000Z";
const DELETION_DATE = "2026-08-15T08:00:00.000Z";

describe("Bitwarden Send cryptography", () => {
  it("matches independent Android-compatible HKDF and PBKDF2 vectors", async () => {
    const sendKey = await deriveBitwardenSendKey(SEED);
    expect(bytesToBase64(sendKey.encKey)).toBe("BjqVWhwBtOGqy3zTWckZssthBBwMBclMDrdvuanhRLM=");
    expect(bytesToBase64(sendKey.macKey)).toBe("++ygdN4UN6GiMwrSgzE4q/O+JWGjowrh8z4V4aL3ygQ=");
    await expect(hashBitwardenSendPassword("S3nd pass!", SEED)).resolves.toBe("/VgCF7suo+WH22MWp7MlcuE726h8UkCf2+XR9Kx8EiM=");
  });
});

describe("Bitwarden Send service", () => {
  it("decodes text, file, email-auth, and future Send records without exposing encrypted fields", async () => {
    const text = await rawTextSend({ authType: "1", password: "password-proof" });
    const file = await rawFileSend();
    const email = await rawTextSend({ id: "send-email", authType: undefined, emails: [{ Email: "2.encrypted" }] });
    const future = await rawTextSend({ id: "send-future", type: "2" });
    const fetcher = vi.fn().mockResolvedValue(json({ Data: [text, file, email, future] })) as unknown as typeof fetch;
    const service = new BitwardenSendService({ client: new BitwardenClient(fetcher, fastTransport()), now: () => NOW });

    const result = await service.list(activeSession(), "provider-1");
    expect(result.page.items).toHaveLength(4);
    expect(result.page.items[0]).toMatchObject({ type: "text", name: "Text Send", authMode: "password", hasPassword: true, editable: true });
    expect(result.page.items[1]).toMatchObject({ type: "file", fileName: "report.txt", fileSizeBytes: 123, authMode: "none", editable: true });
    expect(result.page.items[2]).toMatchObject({ authMode: "email", editable: false });
    expect(result.page.items[3]).toMatchObject({ type: "unsupported", editable: false });
    expect(result.page.items[3].warning).toContain("类型 2");
    const serialized = JSON.stringify(result.page);
    expect(serialized).not.toContain(String(text.Name));
    expect(serialized).not.toContain(String((text.Text as Record<string, unknown>).Text));
    expect(serialized).not.toContain("password-proof");
  });

  it("creates a text Send with encrypted fields, a password proof, and zeroized seed material", async () => {
    let request: Record<string, unknown> | undefined;
    const ownedSeed = SEED.slice();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ ...request, Id: "send-created", AccessId: "access-created", RevisionDate: REVISION });
    }) as unknown as typeof fetch;
    const service = new BitwardenSendService({
      client: new BitwardenClient(fetcher, fastTransport()),
      randomness: () => ownedSeed,
      now: () => NOW
    });

    const result = await service.createText(activeSession(), "provider-1", {
      name: "  Shared note  ",
      text: "secret text",
      notes: "team only",
      password: "S3nd pass!",
      maxAccessCount: 3,
      hideEmail: true,
      hiddenText: true,
      deletionDate: DELETION_DATE
    });

    expect(result.send).toMatchObject({ sendId: "send-created", name: "Shared note", textContent: "secret text", authMode: "password", hasPassword: true });
    const wrappedSeed = await decryptBitwardenBytes(String(request?.key), VAULT_KEY);
    expect(wrappedSeed).toEqual(SEED);
    const sendKey = await deriveBitwardenSendKey(SEED);
    await expect(decryptBitwardenString(String(request?.name), sendKey)).resolves.toBe("Shared note");
    await expect(decryptBitwardenString(String((request?.text as Record<string, unknown>).text), sendKey)).resolves.toBe("secret text");
    expect(request).toMatchObject({ type: 0, authType: 1, maxAccessCount: 3, hideEmail: true, deletionDate: DELETION_DATE });
    expect(request?.password).toBe("/VgCF7suo+WH22MWp7MlcuE726h8UkCf2+XR9Kx8EiM=");
    expect(ownedSeed.every((value) => value === 0)).toBe(true);
  });

  it("updates metadata while preserving omitted text, password proof, and unknown fields byte-for-value", async () => {
    const raw = await rawTextSend({
      password: "existing-proof",
      authType: 1,
      extra: { FutureTopLevel: { untouched: true }, Text: { FutureNested: ["opaque"] } }
    });
    let written: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      if (method === "GET") return json(raw);
      if (method === "PUT") {
        written = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ Id: "send-text", RevisionDate: NEXT_REVISION });
      }
      throw new Error(`Unexpected ${method} ${String(input)}`);
    }) as unknown as typeof fetch;
    const service = new BitwardenSendService({ client: new BitwardenClient(fetcher, fastTransport()), now: () => NOW });

    const result = await service.update(activeSession(), "provider-1", {
      sendId: "send-text",
      expectedRevision: REVISION,
      name: "Renamed",
      deletionDate: DELETION_DATE
    });

    expect(result.send).toMatchObject({ name: "Renamed", textContent: "Text content", hasPassword: true, revisionDate: NEXT_REVISION });
    expect(written?.password).toBe("existing-proof");
    expect(written?.authType).toBe(1);
    expect(written?.notes).toBe(raw.Notes);
    expect((written?.text as Record<string, unknown>).text).toBe((raw.Text as Record<string, unknown>).Text);
    expect((written?.text as Record<string, unknown>).futureNested).toEqual(["opaque"]);
    expect(written?.futureTopLevel).toEqual({ untouched: true });
  });

  it("fails closed for a stale revision, email verification, and future Send types before writing", async () => {
    for (const raw of [
      await rawTextSend(),
      await rawTextSend({ id: "send-email", authType: 0, emails: [{ Email: "2.encrypted" }] }),
      await rawTextSend({ id: "send-future", type: 2 })
    ]) {
      const fetcher = vi.fn().mockResolvedValue(json(raw)) as unknown as typeof fetch;
      const service = new BitwardenSendService({ client: new BitwardenClient(fetcher, fastTransport()), now: () => NOW });
      const expectedRevision = raw.Id === "send-text" ? "2026-08-08T00:00:00.000Z" : REVISION;
      await expect(service.update(activeSession(), "provider-1", {
        sendId: String(raw.Id),
        expectedRevision,
        name: "Blocked",
        deletionDate: DELETION_DATE
      })).rejects.toMatchObject({ code: raw.Id === "send-text" ? "send-conflict" : "send-not-editable" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("creates and uploads an empty Direct file in Android's type-IV-HMAC-ciphertext format", async () => {
    let createRequest: Record<string, unknown> | undefined;
    let uploaded: Uint8Array | undefined;
    const seed = SEED.slice();
    const iv = Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index);
    let randomCall = 0;
    let createdRaw: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sends/file/v2")) {
        createRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        createdRaw = { ...createRequest, Id: "send-file", AccessId: "file-access", RevisionDate: REVISION, File: { ...(createRequest.file as Record<string, unknown>), Id: "file-1", Size: "0" } };
        return json({ FileUploadType: 0, SendResponse: createdRaw });
      }
      if (url.endsWith("/sends/send-file/file/file-1")) {
        const data = (init?.body as FormData).get("data") as Blob;
        uploaded = new Uint8Array(await data.arrayBuffer());
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/sends/send-file")) return json(createdRaw);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const service = new BitwardenSendService({
      client: new BitwardenClient(fetcher, fastTransport()),
      randomness: () => (randomCall++ === 0 ? seed : iv),
      now: () => NOW
    });

    const result = await service.createFile(activeSession(), "provider-1", {
      name: "Empty file",
      fileName: "empty.bin",
      bytes: new Uint8Array(),
      deletionDate: DELETION_DATE
    });

    expect(result.send).toMatchObject({ type: "file", fileName: "empty.bin" });
    expect(createRequest?.fileLength).toBe(65);
    expect(uploaded).toHaveLength(65);
    expect(uploaded?.[0]).toBe(2);
    await expect(decryptSendFile(uploaded!, SEED)).resolves.toEqual(new Uint8Array());
    expect(seed.every((value) => value === 0)).toBe(true);
    expect(iv.every((value) => value === 0)).toBe(true);
  });

  it("rolls back file metadata after a failed upload", async () => {
    const raw = await rawFileSend();
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method || "GET"} ${url}`);
      if (url.endsWith("/sends/file/v2")) return json({ FileUploadType: 0, SendResponse: raw });
      if (url.includes("/file/file-1")) return json({ message: "failed" }, 500);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const service = new BitwardenSendService({ client: new BitwardenClient(fetcher, fastTransport()), randomness: deterministicRandomness(), now: () => NOW });

    await expect(service.createFile(activeSession(), "provider-1", {
      name: "Failure",
      fileName: "failure.bin",
      bytes: Uint8Array.of(1, 2, 3),
      deletionDate: DELETION_DATE
    })).rejects.toMatchObject({ code: "send-file-upload-failed" });
    expect(calls.some((call) => call === "DELETE https://self.example.com/api/sends/send-file")).toBe(true);
  });

  it("removes a password through the dedicated endpoint and treats a 404 delete as idempotent", async () => {
    const before = await rawTextSend({ password: "existing-proof", authType: 1 });
    const after = { ...before, Password: null, AuthType: 2, RevisionDate: NEXT_REVISION };
    let getCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/remove-password")) return json({ Id: "send-text", RevisionDate: NEXT_REVISION });
      if (init?.method === "DELETE") return json({ message: "gone" }, 404);
      if (url.endsWith("/sends/send-text")) return json(getCount++ === 0 ? before : after);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const service = new BitwardenSendService({ client: new BitwardenClient(fetcher, fastTransport()), now: () => NOW });

    const removed = await service.removePassword(activeSession(), "provider-1", "send-text", REVISION);
    expect(removed.send).toMatchObject({ hasPassword: false, authMode: "none", revisionDate: NEXT_REVISION });
    const deleted = await service.remove(removed.session, "provider-1", "send-text", NEXT_REVISION);
    expect(deleted).toEqual({ session: removed.session, deleted: false });
  });

  it("isolates Azure upload URLs from bearer credentials and renews an expired URL", async () => {
    const encrypted = new Uint8Array(65).fill(1);
    const signed = "https://objects.example.test/send?sig=expired";
    const renewed = "https://objects.example.test/send?sig=renewed";
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url === signed) return new Response(null, { status: 403 });
      if (url.endsWith("/sends/send-file/file/file-1")) return json({ FileUploadType: 1, Url: renewed });
      if (url === renewed) return new Response(null, { status: 201 });
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher, fastTransport());
    const service = new BitwardenSendService(client);

    const active = await (service as unknown as { uploadFile(session: ReturnType<typeof activeSession>, sendId: string, fileId: string, encryptedFileName: string, bytes: Uint8Array, upload: { fileUploadType: 1; url: string }): Promise<ReturnType<typeof activeSession>> })
      .uploadFile(activeSession(), "send-file", "file-1", "2.encrypted", encrypted, { fileUploadType: 1, url: signed });
    expect(active.accessToken).toBe("access-secret");
    expect(calls[0].headers.get("Authorization")).toBeNull();
    expect(calls[1].headers.get("Authorization")).toBe("Bearer access-secret");
    expect(calls[2].headers.get("Authorization")).toBeNull();
  });
});

async function rawTextSend(input: {
  id?: string;
  type?: number | string;
  authType?: number | string;
  password?: string;
  emails?: unknown;
  extra?: Record<string, unknown>;
} = {}): Promise<Record<string, unknown>> {
  const sendKey = await deriveBitwardenSendKey(SEED);
  const extraText = input.extra?.Text && typeof input.extra.Text === "object" ? input.extra.Text as Record<string, unknown> : {};
  return {
    Id: input.id || "send-text",
    AccessId: "access-text",
    Key: await encryptBitwardenBytes(SEED, VAULT_KEY, fixedIv(1)),
    Type: input.type ?? 0,
    Name: await encryptBitwardenString("Text Send", sendKey, fixedIv(2)),
    Notes: await encryptBitwardenString("Text notes", sendKey, fixedIv(3)),
    Text: { ...extraText, Text: await encryptBitwardenString("Text content", sendKey, fixedIv(4)), Hidden: true },
    AccessCount: 1,
    MaxAccessCount: 5,
    Password: input.password ?? null,
    ...(input.authType === undefined ? {} : { AuthType: input.authType }),
    ...(input.emails === undefined ? {} : { Emails: input.emails }),
    Disabled: false,
    HideEmail: true,
    RevisionDate: REVISION,
    DeletionDate: DELETION_DATE,
    FutureTopLevel: input.extra?.FutureTopLevel,
    Object: "send"
  };
}

async function rawFileSend(): Promise<Record<string, unknown>> {
  const sendKey = await deriveBitwardenSendKey(SEED);
  return {
    Id: "send-file",
    AccessId: "access-file",
    Key: await encryptBitwardenBytes(SEED, VAULT_KEY, fixedIv(5)),
    Type: "1",
    Name: await encryptBitwardenString("File Send", sendKey, fixedIv(6)),
    Notes: null,
    File: { Id: "file-1", FileName: await encryptBitwardenString("report.txt", sendKey, fixedIv(7)), Size: "123" },
    AccessCount: 0,
    AuthType: "2",
    Password: null,
    Disabled: false,
    HideEmail: false,
    RevisionDate: REVISION,
    DeletionDate: DELETION_DATE
  };
}

async function decryptSendFile(value: Uint8Array, seed: Uint8Array): Promise<Uint8Array> {
  expect(value[0]).toBe(2);
  const sendKey = await deriveBitwardenSendKey(seed);
  const iv = value.slice(1, 17);
  const actualMac = value.slice(17, 49);
  const ciphertext = value.slice(49);
  const macKey = await crypto.subtle.importKey("raw", sendKey.macKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macInput = new Uint8Array(iv.length + ciphertext.length);
  macInput.set(iv);
  macInput.set(ciphertext, iv.length);
  const expectedMac = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, macInput));
  expect(actualMac).toEqual(expectedMac);
  const encKey = await crypto.subtle.importKey("raw", sendKey.encKey as BufferSource, { name: "AES-CBC" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, encKey, ciphertext));
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
    vaultKeyEnc: bytesToBase64(VAULT_KEY.encKey),
    vaultKeyMac: bytesToBase64(VAULT_KEY.macKey)
  };
}

function fixedIv(value: number): () => Uint8Array {
  return () => new Uint8Array(16).fill(value);
}

function deterministicRandomness(): (length: number) => Uint8Array {
  let value = 1;
  return (length) => new Uint8Array(length).fill(value++);
}

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000 };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
