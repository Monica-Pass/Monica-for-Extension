import { describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import { ProviderAttachmentError } from "../attachments/attachment-contract";
import {
  BitwardenAttachmentMutationService,
  bitwardenAttachmentSha256
} from "./bitwarden-attachment-mutations";
import { MemoryBitwardenAttachmentMutationStore } from "./bitwarden-attachment-mutation-store";
import {
  decryptBitwardenSymmetricKey,
  encryptBitwardenBytes,
  encryptBitwardenString,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";

const API_URL = "https://vault.example.test/api";
const PROVIDER_ID = "provider-1";
const ITEM_ID = "item-1";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

describe("Bitwarden durable attachment mutations", () => {
  it.each([0, 1] as const)("uploads and authenticates official mode %s with an independent attachment key", async (mode) => {
    const server = new FakeBitwardenAttachmentServer(mode);
    const plaintext = new TextEncoder().encode(`mode-${mode}-中文`);
    const service = mutationService(server);
    const result = await service.upload(uploadInput(server, plaintext));

    expect(result).toMatchObject({
      changed: true,
      attachment: { providerKind: "bitwarden", fileName: "fixture.txt", sizeBytes: plaintext.length }
    });
    expect(server.prepareCount).toBe(1);
    expect(server.attachments()).toHaveLength(1);
    expect(server.bodies.size).toBe(1);
    expect(server.maximumAttachmentCount).toBe(1);
    expect(server.signedAuthorizationHeaders).toEqual(mode === 0 ? [null] : [null, null]);

    const request = server.prepareRequests[0];
    expect(request.lastKnownRevisionDate).toBe("2026-08-08T00:00:00.000Z");
    expect(request.fileSize).toBeGreaterThan(plaintext.length);
    const attachmentKey = await decryptBitwardenSymmetricKey(String(request.key), server.vaultKey);
    expect(attachmentKey).not.toEqual(server.vaultKey);
    expect(attachmentKey.encKey).not.toEqual(server.vaultKey.encKey);
    attachmentKey.encKey.fill(0);
    attachmentKey.macKey.fill(0);
  });

  it("rolls back newly created metadata after a definitive byte-upload failure", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    server.directStatus = 400;
    const service = mutationService(server);

    await expect(service.upload(uploadInput(server, new TextEncoder().encode("rollback"))))
      .rejects.toMatchObject({ code: "client" });
    expect(server.attachments()).toHaveLength(0);
    expect(server.events).toEqual(expect.arrayContaining(["prepare:attachment-1", "delete:attachment-1"]));
  });

  it.each([0, 1] as const)("accepts a lost mode %s completion response only after authenticated verification", async (mode) => {
    const server = new FakeBitwardenAttachmentServer(mode);
    server.failUploadAfterStoreOnce = true;
    const result = await mutationService(server).upload(uploadInput(server, new TextEncoder().encode(`lost-upload-${mode}`)));

    expect(result.attachment?.attachmentId).toBe("attachment-1");
    expect(server.attachmentIds()).toEqual(["attachment-1"]);
    expect(server.events).toEqual(expect.arrayContaining(["upload:attachment-1", "download:attachment-1"]));
  });

  it("keeps unrelated legacy attachments without an independent key compatible", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    await server.addLegacyMetadata("legacy-attachment", "legacy.txt");
    const result = await mutationService(server).upload(uploadInput(server, new TextEncoder().encode("new attachment")));

    expect(result.attachment?.attachmentId).toBe("attachment-1");
    expect(server.attachmentIds()).toEqual(["legacy-attachment", "attachment-1"]);
  });

  it.each([0, 1] as const)("resumes the same prepared mode %s attachment after a Service Worker restart without creating a duplicate", async (mode) => {
    const server = new FakeBitwardenAttachmentServer(mode);
    const sharedRecords = new Map();
    const store = new MemoryBitwardenAttachmentMutationStore(sharedRecords);
    server.failUploadBeforeStoreOnce = true;
    const plaintext = new TextEncoder().encode("restart recovery");

    await expect(mutationService(server, store).upload(uploadInput(server, plaintext)))
      .rejects.toMatchObject({ code: "bitwarden-attachment-upload-pending" });
    expect(server.prepareCount).toBe(1);
    expect(server.attachments()).toHaveLength(1);
    expect(server.bodies.size).toBe(0);

    const restarted = new BitwardenAttachmentMutationService({
      fetcher: server.fetcher,
      transportPolicy: fastTransport(),
      store: new MemoryBitwardenAttachmentMutationStore(sharedRecords)
    });
    const result = await restarted.upload(uploadInput(server, plaintext));
    expect(result.attachment?.attachmentId).toBe("attachment-1");
    expect(server.prepareCount).toBe(1);
    expect(server.attachments()).toHaveLength(1);
    expect(server.bodies.has("attachment-1")).toBe(true);
  });

  it("finds and rolls back metadata after a lost create response before allowing a fresh attempt", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    const sharedRecords = new Map();
    const plaintext = new TextEncoder().encode("lost create response");
    server.failPrepareAfterCreateOnce = true;

    await expect(mutationService(server, new MemoryBitwardenAttachmentMutationStore(sharedRecords)).upload(uploadInput(server, plaintext)))
      .rejects.toMatchObject({ code: "bitwarden-attachment-create-recovered" });
    expect(server.attachments()).toHaveLength(0);
    expect(server.maximumAttachmentCount).toBe(1);

    const result = await mutationService(server, new MemoryBitwardenAttachmentMutationStore(sharedRecords)).upload(uploadInput(server, plaintext));
    expect(result.attachment?.attachmentId).toBe("attachment-2");
    expect(server.prepareCount).toBe(2);
    expect(server.attachments()).toHaveLength(1);
    expect(server.maximumAttachmentCount).toBe(1);
  });

  it("replaces by verifying the new bytes before deleting the old attachment", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    await server.addExisting("old-attachment", "old.txt", new TextEncoder().encode("old bytes"));
    server.events.length = 0;
    const plaintext = new TextEncoder().encode("new bytes");
    const result = await mutationService(server).upload({
      ...uploadInput(server, plaintext),
      replaceAttachmentId: "old-attachment"
    });

    expect(result.attachment?.attachmentId).toBe("attachment-1");
    expect(server.attachmentIds()).toEqual(["attachment-1"]);
    expect(server.events.indexOf("download:attachment-1")).toBeLessThan(server.events.indexOf("delete:old-attachment"));
  });

  it("recovers a lost delete response through synchronization", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    await server.addExisting("old-attachment", "old.txt", new TextEncoder().encode("old bytes"));
    server.failDeleteAfterApplyOnce = true;
    const result = await mutationService(server).delete({
      ...context(server),
      operationId: OPERATION_ID,
      attachmentId: "old-attachment"
    });

    expect(result.changed).toBe(true);
    expect(server.attachments()).toHaveLength(0);
  });

  it("returns a completed retry and rejects operation-ID reuse with different content", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    const store = new MemoryBitwardenAttachmentMutationStore();
    const service = mutationService(server, store);
    const firstBytes = new TextEncoder().encode("same operation");
    const input = uploadInput(server, firstBytes);
    const first = await service.upload(input);
    const repeated = await service.upload(input);
    expect(repeated.attachment?.attachmentId).toBe(first.attachment?.attachmentId);
    expect(server.prepareCount).toBe(1);

    const changed = new TextEncoder().encode("changed content");
    await expect(service.upload({ ...input, bytes: changed, sha256: await bitwardenAttachmentSha256(changed) }))
      .rejects.toMatchObject({ code: "bitwarden-attachment-operation-reused" });
    expect(server.prepareCount).toBe(1);
  });

  it("applies a configurable test limit while retaining the production 100 MiB ceiling", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    const service = new BitwardenAttachmentMutationService({
      fetcher: server.fetcher,
      transportPolicy: fastTransport(),
      store: new MemoryBitwardenAttachmentMutationStore(),
      limits: { maxPlaintextBytes: 8 }
    });
    const bytes = new Uint8Array(9);
    await expect(service.upload(await uploadInputWithDigest(server, bytes))).rejects.toBeInstanceOf(ProviderAttachmentError);
    expect(server.prepareCount).toBe(0);
  });

  it("clears generated 64-byte attachment key material after upload", async () => {
    const server = new FakeBitwardenAttachmentServer(0);
    const generated: Uint8Array[] = [];
    let seed = 1;
    const service = new BitwardenAttachmentMutationService({
      fetcher: server.fetcher,
      transportPolicy: fastTransport(),
      store: new MemoryBitwardenAttachmentMutationStore(),
      randomness: (length) => {
        const value = Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
        seed += 17;
        generated.push(value);
        return value;
      }
    });

    await service.upload(uploadInput(server, new TextEncoder().encode("zeroize key")));
    const keyMaterial = generated.filter((value) => value.length === 64);
    expect(keyMaterial).toHaveLength(1);
    expect(keyMaterial[0].every((value) => value === 0)).toBe(true);
  });
});

function mutationService(
  server: FakeBitwardenAttachmentServer,
  store = new MemoryBitwardenAttachmentMutationStore()
): BitwardenAttachmentMutationService {
  return new BitwardenAttachmentMutationService({
    fetcher: server.fetcher,
    transportPolicy: fastTransport(),
    store
  });
}

function context(server: FakeBitwardenAttachmentServer) {
  return {
    providerId: PROVIDER_ID,
    itemId: ITEM_ID,
    session: session(server.vaultKey),
    rawCipher: server.cloneCipher()
  };
}

function uploadInput(server: FakeBitwardenAttachmentServer, bytes: Uint8Array) {
  return {
    ...context(server),
    operationId: OPERATION_ID,
    fileName: "fixture.txt",
    bytes,
    sha256: ""
  };
}

async function uploadInputWithDigest(server: FakeBitwardenAttachmentServer, bytes: Uint8Array) {
  return { ...uploadInput(server, bytes), sha256: await bitwardenAttachmentSha256(bytes) };
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

class FakeBitwardenAttachmentServer {
  readonly vaultKey = symmetricKey(7);
  readonly bodies = new Map<string, Uint8Array>();
  readonly events: string[] = [];
  readonly prepareRequests: Array<Record<string, unknown>> = [];
  readonly signedAuthorizationHeaders: Array<string | null> = [];
  readonly fetcher: typeof fetch;
  prepareCount = 0;
  maximumAttachmentCount = 0;
  directStatus?: number;
  failUploadBeforeStoreOnce = false;
  failPrepareAfterCreateOnce = false;
  failDeleteAfterApplyOnce = false;
  failUploadAfterStoreOnce = false;
  private revision = 0;
  private readonly cipher: Record<string, unknown> = {
    Id: "cipher-1",
    Type: 1,
    OrganizationId: null,
    RevisionDate: "2026-08-08T00:00:00.000Z",
    Attachments: []
  };

  constructor(readonly mode: 0 | 1) {
    this.fetcher = vi.fn(this.handle.bind(this)) as unknown as typeof fetch;
  }

  attachments(): Array<Record<string, unknown>> {
    return this.cipher.Attachments as Array<Record<string, unknown>>;
  }

  attachmentIds(): string[] {
    return this.attachments().map((entry) => String(entry.Id));
  }

  cloneCipher(): Record<string, unknown> {
    return structuredClone(this.cipher);
  }

  async addExisting(id: string, fileName: string, plaintext: Uint8Array): Promise<void> {
    const key = symmetricKey(91 + this.attachments().length);
    const encryptedFileName = await encryptBitwardenString(fileName, this.vaultKey, fixedRandom(3));
    const rawKey = concat(key.encKey, key.macKey);
    const wrapped = await encryptBitwardenBytes(rawKey, this.vaultKey, fixedRandom(5));
    rawKey.fill(0);
    const body = await encryptAttachmentBytes(plaintext, key, fixedRandom(11));
    key.encKey.fill(0);
    key.macKey.fill(0);
    this.attachments().push({ Id: id, FileName: encryptedFileName, Key: wrapped, Size: String(body.length) });
    this.bodies.set(id, body);
  }

  async addLegacyMetadata(id: string, fileName: string): Promise<void> {
    this.attachments().push({
      Id: id,
      FileName: await encryptBitwardenString(fileName, this.vaultKey, fixedRandom(17)),
      Size: "64"
    });
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const method = String(init?.method || "GET").toUpperCase();
    if (url === `${API_URL}/sync?excludeDomains=true`) return json({ Ciphers: [this.cloneCipher()] });
    if (url === `${API_URL}/ciphers/cipher-1/attachment/v2` && method === "POST") return this.prepare(init);
    if (url.startsWith(`${API_URL}/ciphers/cipher-1/attachment/`)) return this.attachmentApi(url, method, init);
    if (url.startsWith("https://objects.example.test/upload/")) return this.azureUpload(url, init);
    if (url.startsWith("https://objects.example.test/download/")) return this.download(url, init);
    throw new Error(`Unexpected URL ${method} ${url}`);
  }

  private prepare(init?: RequestInit): Response {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.prepareRequests.push(request);
    const attachmentId = `attachment-${++this.prepareCount}`;
    this.attachments().push({
      Id: attachmentId,
      FileName: request.fileName,
      Key: request.key,
      Size: String(request.fileSize)
    });
    this.bumpRevision();
    this.maximumAttachmentCount = Math.max(this.maximumAttachmentCount, this.attachments().length);
    this.events.push(`prepare:${attachmentId}`);
    if (this.failPrepareAfterCreateOnce) {
      this.failPrepareAfterCreateOnce = false;
      throw new TypeError("prepare response lost");
    }
    return json({
      attachmentId,
      fileUploadType: this.mode,
      url: this.mode === 1 ? this.uploadUrl(attachmentId) : "",
      cipherResponse: this.cloneCipher()
    });
  }

  private async attachmentApi(url: string, method: string, init?: RequestInit): Promise<Response> {
    const path = new URL(url).pathname.split("/");
    const attachmentId = decodeURIComponent(path[path.indexOf("attachment") + 1] || "");
    if (url.endsWith("/renew") && method === "GET") return json({ url: this.uploadUrl(attachmentId) });
    if (method === "POST") {
      if (this.directStatus) return json({ message: "direct rejected" }, this.directStatus);
      if (this.failUploadBeforeStoreOnce) {
        this.failUploadBeforeStoreOnce = false;
        throw new TypeError("direct request lost before store");
      }
      const form = init?.body as FormData;
      const data = form.get("data") as Blob;
      this.bodies.set(attachmentId, new Uint8Array(await data.arrayBuffer()));
      this.events.push(`upload:${attachmentId}`);
      if (this.failUploadAfterStoreOnce) {
        this.failUploadAfterStoreOnce = false;
        throw new TypeError("direct response lost after store");
      }
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      const index = this.attachments().findIndex((entry) => entry.Id === attachmentId);
      if (index >= 0) this.attachments().splice(index, 1);
      this.bodies.delete(attachmentId);
      this.bumpRevision();
      this.events.push(`delete:${attachmentId}`);
      if (this.failDeleteAfterApplyOnce) {
        this.failDeleteAfterApplyOnce = false;
        throw new TypeError("delete response lost");
      }
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      const attachment = this.attachments().find((entry) => entry.Id === attachmentId);
      if (!attachment) return json({ message: "missing" }, 404);
      return json({
        id: attachmentId,
        url: `https://objects.example.test/download/${attachmentId}?sig=opaque`,
        fileName: attachment.FileName,
        key: attachment.Key,
        size: attachment.Size
      });
    }
    throw new Error(`Unexpected attachment request ${method} ${url}`);
  }

  private async azureUpload(url: string, init?: RequestInit): Promise<Response> {
    this.signedAuthorizationHeaders.push(new Headers(init?.headers).get("Authorization"));
    const uploadParts = new URL(url).pathname.split("/");
    const attachmentId = uploadParts[uploadParts.length - 1];
    if (this.failUploadBeforeStoreOnce) {
      this.failUploadBeforeStoreOnce = false;
      throw new TypeError("azure request lost before store");
    }
    const body = init?.body as Blob;
    this.bodies.set(attachmentId, new Uint8Array(await body.arrayBuffer()));
    this.events.push(`upload:${attachmentId}`);
    if (this.failUploadAfterStoreOnce) {
      this.failUploadAfterStoreOnce = false;
      throw new TypeError("azure response lost after store");
    }
    return new Response(null, { status: 201 });
  }

  private download(url: string, init?: RequestInit): Response {
    this.signedAuthorizationHeaders.push(new Headers(init?.headers).get("Authorization"));
    const downloadParts = new URL(url).pathname.split("/");
    const attachmentId = downloadParts[downloadParts.length - 1];
    const body = this.bodies.get(attachmentId);
    if (!body) return json({ message: "not uploaded" }, 404);
    this.events.push(`download:${attachmentId}`);
    return new Response(body.slice(), { status: 200, headers: { "Content-Length": String(body.length) } });
  }

  private uploadUrl(attachmentId: string): string {
    return `https://objects.example.test/upload/${attachmentId}?sv=2026-01-01&se=2099-01-01T00%3A00%3A00Z&sig=opaque`;
  }

  private bumpRevision(): void {
    this.revision += 1;
    this.cipher.RevisionDate = `2026-08-08T00:00:${String(this.revision).padStart(2, "0")}.000Z`;
  }
}

async function encryptAttachmentBytes(
  plaintext: Uint8Array,
  key: BitwardenSymmetricKey,
  randomness: (length: number) => Uint8Array
): Promise<Uint8Array> {
  const iv = randomness(16);
  const cryptoKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource));
  const hmacKey = await crypto.subtle.importKey("raw", key.macKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, concat(iv, ciphertext) as BufferSource));
  return concat(iv, ciphertext, mac);
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function fixedRandom(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000, maxAttempts: 1 };
}
