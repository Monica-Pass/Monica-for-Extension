import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import { encryptBitwardenBytes, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenAttachmentDownloadService } from "./bitwarden-attachments";

const API_URL = "https://vault.example.test/api";
const SIGNED_URL = "https://objects.example.test/opaque?sig=must-not-leak";
const SELF_SIGNED_URL = "https://vault.example.test/attachments/cipher-1/attachment-1?token=opaque";
const PROVIDER_ID = "provider-1";
const ITEM_ID = "item-1";

describe("Bitwarden authenticated attachment download", () => {
  it("decrypts a personal per-Cipher attachment and never forwards the bearer token", async () => {
    const fixture = await attachmentFixture({ perCipherKey: true, independentAttachmentKey: true, fileName: "机密.txt" });
    const fetcher = attachmentFetcher(fixture.body);
    const service = new BitwardenAttachmentDownloadService({ fetcher, transportPolicy: fastTransport() });

    const begun = await service.beginDownload(context(fixture));
    expect(begun).toMatchObject({ attachmentId: "attachment-1", fileName: "机密.txt", sizeBytes: fixture.plaintext.length, protected: true });
    await expect(readAll(service, begun.readHandle, 7)).resolves.toEqual(fixture.plaintext);

    const calls = fetchCalls(fetcher);
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0])).toBe(`${API_URL}/ciphers/cipher-1/attachment/attachment-1`);
    expect(new Headers(calls[0][1].headers).get("Authorization")).toBe("Bearer access-secret");
    expect(String(calls[1][0])).toBe(SIGNED_URL);
    expect(new Headers(calls[1][1].headers).get("Authorization")).toBeNull();
    expect(calls[1][1]).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  });

  it("selects an organization key before unwrapping a per-Cipher and attachment key", async () => {
    const organizationKey = symmetricKey(41);
    const fixture = await attachmentFixture({ ownerKey: organizationKey, organizationId: "org-1", perCipherKey: true, independentAttachmentKey: true });
    const service = new BitwardenAttachmentDownloadService({ fetcher: attachmentFetcher(fixture.body), transportPolicy: fastTransport() });

    const begun = await service.beginDownload(context(fixture, {
      sessionKey: symmetricKey(3),
      organizationKeys: new Map([["org-1", organizationKey]])
    }));
    await expect(readAll(service, begun.readHandle, 13)).resolves.toEqual(fixture.plaintext);
    expect(organizationKey.encKey.some(Boolean)).toBe(true);
    expect(organizationKey.macKey.some(Boolean)).toBe(true);
  });

  it("retries a self-hosted attachment URL with the API deployment prefix after a 404", async () => {
    const fixture = await attachmentFixture({ perCipherKey: true, independentAttachmentKey: true });
    const base = attachmentFetcher(fixture.body, { url: SELF_SIGNED_URL });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === SELF_SIGNED_URL) return new Response(null, { status: 404 });
      if (url === "https://vault.example.test/api/attachments/cipher-1/attachment-1?token=opaque") {
        return new Response(fixture.body.slice(), { headers: { "content-type": "application/octet-stream" } });
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    const service = new BitwardenAttachmentDownloadService({ fetcher, transportPolicy: fastTransport() });
    const begun = await service.beginDownload(context(fixture));
    await expect(readAll(service, begun.readHandle, 64)).resolves.toEqual(fixture.plaintext);
    expect(fetchCalls(fetcher).map((call) => String(call[0]))).toEqual([
      `${API_URL}/ciphers/cipher-1/attachment/attachment-1`,
      SELF_SIGNED_URL,
      "https://vault.example.test/api/attachments/cipher-1/attachment-1?token=opaque"
    ]);
  });

  it("falls back to the Cipher key for legacy attachments without an independent key", async () => {
    const fixture = await attachmentFixture({ perCipherKey: true, independentAttachmentKey: false });
    const service = new BitwardenAttachmentDownloadService({ fetcher: attachmentFetcher(fixture.body), transportPolicy: fastTransport() });

    const begun = await service.beginDownload(context(fixture));
    await expect(readAll(service, begun.readHandle, 9)).resolves.toEqual(fixture.plaintext);
  });

  it("decrypts more than one aligned ciphertext chunk without exposing synthetic padding", async () => {
    const plaintext = Uint8Array.from({ length: 256 * 1024 + 37 }, (_, index) => index & 0xff);
    const fixture = await attachmentFixture({ plaintext, perCipherKey: true, independentAttachmentKey: true });
    const service = new BitwardenAttachmentDownloadService({ fetcher: attachmentFetcher(fixture.body), transportPolicy: fastTransport() });

    const begun = await service.beginDownload(context(fixture));
    await expect(readAll(service, begun.readHandle, 64 * 1024)).resolves.toEqual(plaintext);
  });

  it("accepts an attachment key supplied by the authenticated download-info response", async () => {
    const fixture = await attachmentFixture({ independentAttachmentKey: true });
    const rawAttachment = (fixture.rawCipher.Attachments as Array<Record<string, unknown>>)[0];
    const key = rawAttachment.Key as string;
    delete rawAttachment.Key;
    const service = new BitwardenAttachmentDownloadService({
      fetcher: attachmentFetcher(fixture.body, { key }),
      transportPolicy: fastTransport()
    });

    const begun = await service.beginDownload(context(fixture));
    await expect(readAll(service, begun.readHandle, 64)).resolves.toEqual(fixture.plaintext);
  });

  it("fails closed when an organization key is absent or an attachment key unwraps to the wrong length", async () => {
    const organizationKey = symmetricKey(91);
    const organizationFixture = await attachmentFixture({ ownerKey: organizationKey, organizationId: "org-missing", perCipherKey: true });
    const missingKeyFetcher = attachmentFetcher(organizationFixture.body);
    const missingKeyService = new BitwardenAttachmentDownloadService({ fetcher: missingKeyFetcher, transportPolicy: fastTransport() });
    await expect(missingKeyService.beginDownload(context(organizationFixture, { sessionKey: symmetricKey(4) })))
      .rejects.toMatchObject({ code: "bitwarden-organization-key-missing" });
    expect(missingKeyFetcher).not.toHaveBeenCalled();

    const malformedFixture = await attachmentFixture({ independentAttachmentKey: false });
    const rawAttachment = (malformedFixture.rawCipher.Attachments as Array<Record<string, unknown>>)[0];
    rawAttachment.Key = await encryptBitwardenBytes(new Uint8Array(32), malformedFixture.cipherKey, fixedIv(19));
    const malformedFetcher = attachmentFetcher(malformedFixture.body);
    const malformedService = new BitwardenAttachmentDownloadService({ fetcher: malformedFetcher, transportPolicy: fastTransport() });
    await expect(malformedService.beginDownload(context(malformedFixture))).rejects.toThrow("对称密钥长度无效");
    expect(malformedFetcher).toHaveBeenCalledTimes(1);
    expect(activeSessions(malformedService)).toBe(0);
  });

  it("decrypts and pages stable attachment metadata without exposing encrypted names", async () => {
    const fixture = await attachmentFixture({ fileName: "one.txt" });
    const cipherKey = fixture.cipherKey;
    const attachments = fixture.rawCipher.Attachments as Array<Record<string, unknown>>;
    for (const [index, name] of ["two.txt", "three.txt"].entries()) {
      attachments.push({
        Id: `attachment-${index + 2}`,
        FileName: await encryptBitwardenString(name, cipherKey, fixedIv(index + 7)),
        Size: String(80 + index)
      });
    }
    const service = new BitwardenAttachmentDownloadService();
    const first = await service.listAttachments(context(fixture), { pageSize: 2 });
    expect(first.items.map((item) => item.fileName)).toEqual(["one.txt", "two.txt"]);
    expect(first.items.every((item) => item.protected && item.providerKind === "bitwarden")).toBe(true);
    const second = await service.listAttachments(context(fixture), { pageSize: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.fileName)).toEqual(["three.txt"]);
  });

  it("preserves legacy plaintext attachment names used by older Monica records", async () => {
    const fixture = await attachmentFixture({ fileName: "legacy.maFile" });
    const attachment = (fixture.rawCipher.Attachments as Array<Record<string, unknown>>)[0];
    attachment.FileName = "legacy.maFile";
    const service = new BitwardenAttachmentDownloadService({
      fetcher: attachmentFetcher(fixture.body),
      transportPolicy: fastTransport()
    });

    const page = await service.listAttachments(context(fixture));
    expect(page.items).toHaveLength(1);
    expect(page.items[0].fileName).toBe("legacy.maFile");
    const begun = await service.beginDownload(context(fixture));
    expect(begun.fileName).toBe("legacy.maFile");
    await expect(readAll(service, begun.readHandle, 64)).resolves.toEqual(fixture.plaintext);
  });

  it("keeps an unreadable CipherString downloadable without exposing it as a file name", async () => {
    const fixture = await attachmentFixture();
    const attachment = (fixture.rawCipher.Attachments as Array<Record<string, unknown>>)[0];
    const unreadableName = "2.AQIDBAUGBwgJCgsMDQ4PEA==|ERITFBUWFxgZGhscHR4fIA==|ISIjJCUmJygpKissLS4vMA==";
    attachment.FileName = unreadableName;
    const service = new BitwardenAttachmentDownloadService({
      fetcher: attachmentFetcher(fixture.body),
      transportPolicy: fastTransport()
    });

    const page = await service.listAttachments(context(fixture));
    expect(page.items).toHaveLength(1);
    expect(page.items[0].fileName).toBe("Bitwarden 加密附件");
    expect(JSON.stringify(page)).not.toContain(unreadableName);
    const begun = await service.beginDownload(context(fixture));
    expect(begun.fileName).toBe("Bitwarden 加密附件");
    await expect(readAll(service, begun.readHandle, 64)).resolves.toEqual(fixture.plaintext);
  });

  it("rejects oversized metadata and counts streamed bytes instead of trusting Content-Length", async () => {
    const fixture = await attachmentFixture({ independentAttachmentKey: false });
    const rawAttachment = (fixture.rawCipher.Attachments as Array<Record<string, unknown>>)[0];
    rawAttachment.Size = "97";
    const unusedFetcher = vi.fn() as unknown as typeof fetch;
    const metadataService = new BitwardenAttachmentDownloadService({
      fetcher: unusedFetcher,
      limits: { maxPlaintextBytes: 32, maxRetainedPlaintextBytes: 32 },
      transportPolicy: fastTransport()
    });
    await expect(metadataService.beginDownload(context(fixture))).rejects.toMatchObject({ code: "bitwarden-attachment-too-large" });
    expect(unusedFetcher).not.toHaveBeenCalled();

    rawAttachment.Size = "0";
    const oversized = new Uint8Array(97);
    const bodyFetcher = attachmentFetcher(oversized, {}, { "Content-Length": "1" });
    const bodyService = new BitwardenAttachmentDownloadService({
      fetcher: bodyFetcher,
      limits: { maxPlaintextBytes: 32, maxRetainedPlaintextBytes: 32 },
      transportPolicy: fastTransport()
    });
    await expect(bodyService.beginDownload(context(fixture))).rejects.toMatchObject({ code: "bitwarden-attachment-too-large" });
  });

  it.each([
    ["truncated header", new Uint8Array(15), "bitwarden-attachment-truncated"],
    ["truncated MAC", new Uint8Array(63), "bitwarden-attachment-truncated"]
  ])("rejects %s without creating a plaintext session", async (_label, body, code) => {
    const fixture = await attachmentFixture({ independentAttachmentKey: false });
    const service = new BitwardenAttachmentDownloadService({ fetcher: attachmentFetcher(body), transportPolicy: fastTransport() });
    await expect(service.beginDownload(context(fixture))).rejects.toMatchObject({ code });
    expect(activeSessions(service)).toBe(0);
  });

  it("rejects a modified HMAC before creating a plaintext session", async () => {
    const fixture = await attachmentFixture({ independentAttachmentKey: false });
    fixture.body[fixture.body.length - 1] ^= 1;
    const service = new BitwardenAttachmentDownloadService({ fetcher: attachmentFetcher(fixture.body), transportPolicy: fastTransport() });
    await expect(service.beginDownload(context(fixture))).rejects.toMatchObject({ code: "bitwarden-attachment-mac-invalid" });
    expect(activeSessions(service)).toBe(0);
  });

  it("rejects invalid PKCS7 even when the attacker recomputes a valid HMAC", async () => {
    const fixture = await attachmentFixture({ plaintext: new Uint8Array(16).fill(7), independentAttachmentKey: false });
    const forged = fixture.body.slice();
    const macOffset = forged.length - 32;
    forged[macOffset - 17] ^= 1;
    forged.set(await hmac(fixture.attachmentKey.macKey, forged.subarray(0, macOffset)), macOffset);
    const service = new BitwardenAttachmentDownloadService({ fetcher: attachmentFetcher(forged), transportPolicy: fastTransport() });
    await expect(service.beginDownload(context(fixture))).rejects.toMatchObject({ code: "bitwarden-attachment-padding-invalid" });
    expect(activeSessions(service)).toBe(0);
  });

  it.each([
    "http://objects.example.test/file",
    "ftp://localhost/file",
    "https://user:secret@objects.example.test/file"
  ])("rejects unsafe signed URL %s without making the second request", async (url) => {
    const fixture = await attachmentFixture({ independentAttachmentKey: false });
    const fetcher = attachmentFetcher(fixture.body, { url });
    const service = new BitwardenAttachmentDownloadService({ fetcher, transportPolicy: fastTransport() });
    const error = await service.beginDownload(context(fixture)).catch((cause) => cause);
    expect(error).toMatchObject({ code: "bitwarden-attachment-url-invalid" });
    expect(error.message).not.toContain(url);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight body and leaves no usable session", async () => {
    const fixture = await attachmentFixture({ independentAttachmentKey: false });
    let signedStarted!: () => void;
    const started = new Promise<void>((resolve) => { signedStarted = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith(API_URL)) return json({ id: "attachment-1", url: SIGNED_URL });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          value.enqueue(fixture.body.subarray(0, 24));
          signedStarted();
        }
      });
      init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      return new Response(stream);
    }) as unknown as typeof fetch;
    const service = new BitwardenAttachmentDownloadService({ fetcher, transportPolicy: fastTransport() });
    const controller = new AbortController();
    const pending = service.beginDownload({ ...context(fixture), signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(activeSessions(service)).toBe(0);
  });

  it("enforces session count, TTL, sequential offsets, exact replay, release, and zeroization", async () => {
    const fixture = await attachmentFixture({ independentAttachmentKey: false, plaintext: Uint8Array.from({ length: 33 }, (_, index) => index) });
    let now = 1_000;
    const service = new BitwardenAttachmentDownloadService({
      fetcher: attachmentFetcher(fixture.body),
      transportPolicy: fastTransport(),
      limits: { maxActiveSessions: 1, sessionTtlMs: 50 },
      now: () => now,
      randomUUID: (() => { let value = 0; return () => `read-${++value}`; })()
    });
    const first = await service.beginDownload(context(fixture));
    await expect(service.beginDownload(context(fixture))).rejects.toMatchObject({ code: "attachment-read-limit" });

    const chunk = service.readChunk(PROVIDER_ID, first.readHandle, 0, 8);
    expect(chunk.bytes).toEqual(fixture.plaintext.subarray(0, 8));
    expect(service.readChunk(PROVIDER_ID, first.readHandle, 0, 8).bytes).toEqual(chunk.bytes);
    expect(() => service.readChunk(PROVIDER_ID, first.readHandle, 9, 8)).toThrowError(expect.objectContaining({ code: "attachment-read-offset-invalid" }));
    expect(service.readChunk(PROVIDER_ID, first.readHandle, 8, 8).nextOffset).toBe(16);

    const retained = retainedPlaintextChunks(service, first.readHandle);
    expect(service.release(PROVIDER_ID, first.readHandle)).toBe(true);
    expect(retained.every((part) => part.every((value) => value === 0))).toBe(true);
    expect(() => service.readChunk(PROVIDER_ID, first.readHandle, 0, 8)).toThrowError(expect.objectContaining({ code: "attachment-read-not-found" }));

    const expiring = await service.beginDownload(context(fixture));
    const expiringChunks = retainedPlaintextChunks(service, expiring.readHandle);
    now += 51;
    const replacement = await service.beginDownload(context(fixture));
    expect(expiringChunks.every((part) => part.every((value) => value === 0))).toBe(true);
    expect(replacement.readHandle).not.toBe(expiring.readHandle);
  });
});

interface Fixture {
  ownerKey: BitwardenSymmetricKey;
  cipherKey: BitwardenSymmetricKey;
  attachmentKey: BitwardenSymmetricKey;
  rawCipher: Record<string, unknown>;
  body: Uint8Array;
  plaintext: Uint8Array;
  organizationId?: string;
}

async function attachmentFixture(input: {
  ownerKey?: BitwardenSymmetricKey;
  organizationId?: string;
  perCipherKey?: boolean;
  independentAttachmentKey?: boolean;
  fileName?: string;
  plaintext?: Uint8Array;
} = {}): Promise<Fixture> {
  const ownerKey = input.ownerKey || symmetricKey(1);
  const cipherKey = input.perCipherKey ? symmetricKey(17) : ownerKey;
  const attachmentKey = input.independentAttachmentKey ? symmetricKey(73) : cipherKey;
  const plaintext = input.plaintext || new TextEncoder().encode("Bitwarden attachment fixture 中文");
  const body = await encryptedAttachment(plaintext, attachmentKey);
  const attachment: Record<string, unknown> = {
    Id: "attachment-1",
    FileName: await encryptBitwardenString(input.fileName || "fixture.txt", cipherKey, fixedIv(4)),
    Size: String(body.length)
  };
  if (input.independentAttachmentKey) attachment.Key = await wrapKey(attachmentKey, cipherKey, 5);
  const rawCipher: Record<string, unknown> = {
    Id: "cipher-1",
    Type: 1,
    OrganizationId: input.organizationId || null,
    Attachments: [attachment]
  };
  if (input.perCipherKey) rawCipher.Key = await wrapKey(cipherKey, ownerKey, 6);
  return { ownerKey, cipherKey, attachmentKey, rawCipher, body, plaintext, organizationId: input.organizationId };
}

function context(fixture: Fixture, options: {
  sessionKey?: BitwardenSymmetricKey;
  organizationKeys?: ReadonlyMap<string, BitwardenSymmetricKey>;
} = {}) {
  return {
    providerId: PROVIDER_ID,
    itemId: ITEM_ID,
    session: session(options.sessionKey || fixture.ownerKey),
    rawCipher: fixture.rawCipher,
    organizationKeys: options.organizationKeys,
    attachmentId: "attachment-1"
  };
}

function session(vaultKey: BitwardenSymmetricKey) {
  return {
    vaultUrl: "https://vault.example.test",
    apiUrl: API_URL,
    identityUrl: "https://vault.example.test/identity",
    email: "alice@example.test",
    deviceId: "device-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3_600_000,
    kdf: { type: 0 as const, iterations: 1 },
    vaultKeyEnc: bytesToBase64(vaultKey.encKey),
    vaultKeyMac: bytesToBase64(vaultKey.macKey)
  };
}

function attachmentFetcher(body: Uint8Array, info: Record<string, unknown> = {}, headers: HeadersInit = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(API_URL)) return json({ id: "attachment-1", url: SIGNED_URL, ...info });
    if (url === String(info.url || SIGNED_URL)) return new Response(body.slice(), { headers });
    throw new Error(`Unexpected URL ${url}`);
  }) as unknown as typeof fetch;
}

async function readAll(service: BitwardenAttachmentDownloadService, readHandle: string, maximum: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (true) {
    const chunk = service.readChunk(PROVIDER_ID, readHandle, offset, maximum);
    parts.push(chunk.bytes);
    offset = chunk.nextOffset;
    if (chunk.eof) break;
  }
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
    part.fill(0);
  }
  return output;
}

async function encryptedAttachment(plaintext: Uint8Array, key: BitwardenSymmetricKey): Promise<Uint8Array> {
  const iv = fixedIv(2)(16);
  const cryptoKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource));
  return concat(iv, ciphertext, await hmac(key.macKey, concat(iv, ciphertext)));
}

async function wrapKey(value: BitwardenSymmetricKey, wrappingKey: BitwardenSymmetricKey, seed: number): Promise<string> {
  const raw = concat(value.encKey, value.macKey);
  try {
    return await encryptBitwardenBytes(raw, wrappingKey, fixedIv(seed));
  } finally {
    raw.fill(0);
  }
}

async function hmac(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, value as BufferSource));
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function fixedIv(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000 };
}

function fetchCalls(fetcher: typeof fetch): Array<[RequestInfo | URL, RequestInit]> {
  return (fetcher as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit]> } }).mock.calls;
}

function activeSessions(service: BitwardenAttachmentDownloadService): number {
  return (service as unknown as { sessions: Map<string, unknown> }).sessions.size;
}

function retainedPlaintextChunks(service: BitwardenAttachmentDownloadService, readHandle: string): Uint8Array[] {
  const session = (service as unknown as { sessions: Map<string, { chunks: Uint8Array[] }> }).sessions.get(readHandle);
  if (!session) throw new Error("missing test session");
  return session.chunks;
}
