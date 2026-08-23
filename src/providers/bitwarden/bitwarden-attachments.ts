import { createHMAC, createSHA256 } from "hash-wasm";
import { ProviderBodyReadNetworkError } from "../bounded-body";
import {
  BITWARDEN_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS,
  PROVIDER_ATTACHMENT_UPLOAD_TTL_MS,
  ProviderAttachmentError,
  type ProviderAttachmentPage,
  type ProviderAttachmentReadBeginResult,
  type ProviderAttachmentSummary
} from "../attachments/attachment-contract";
import { paginateProviderAttachments } from "../attachments/attachment-pagination";
import { ProviderTransportError, providerHttpError, resilientFetch, type ProviderTransportPolicy } from "../provider-transport";
import {
  BitwardenClient,
  type BitwardenAttachmentDownloadInfo,
  type BitwardenClientLimits,
  type BitwardenSessionConfig
} from "./bitwarden-client";
import {
  decryptBitwardenString,
  decryptBitwardenSymmetricKey,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";

const AES_BLOCK_BYTES = 16;
const ATTACHMENT_IV_BYTES = 16;
const ATTACHMENT_MAC_BYTES = 32;
const MAX_BITWARDEN_ATTACHMENTS_PER_CIPHER = 512;
const MAX_OPAQUE_ID_BYTES = 4096;
const MAX_FILE_NAME_BYTES = 4096;
const EMPTY_BYTES: Uint8Array = new Uint8Array(0);
const SYNTHETIC_PADDING_PLAINTEXT = new Uint8Array(AES_BLOCK_BYTES).fill(AES_BLOCK_BYTES);

export interface BitwardenAttachmentVaultContext {
  providerId: string;
  itemId: string;
  session: BitwardenSessionConfig;
  rawCipher: Record<string, unknown>;
  organizationKeys?: ReadonlyMap<string, BitwardenSymmetricKey>;
}

export interface BitwardenAttachmentDownloadInput extends BitwardenAttachmentVaultContext {
  attachmentId: string;
  signal?: AbortSignal;
}

export interface BitwardenAttachmentDownloadBeginResult extends ProviderAttachmentReadBeginResult {
  session: BitwardenSessionConfig;
}

export interface BitwardenAttachmentPlainChunk {
  readHandle: string;
  attachmentId: string;
  fileName: string;
  sizeBytes: number;
  offset: number;
  nextOffset: number;
  bytes: Uint8Array;
  eof: boolean;
  mediaType?: string;
}

export interface BitwardenAttachmentDownloadLimits {
  maxPlaintextBytes: number;
  maxRetainedPlaintextBytes: number;
  maxActiveSessions: number;
  sessionTtlMs: number;
}

export interface BitwardenAttachmentDownloadServiceOptions {
  fetcher?: typeof fetch;
  transportPolicy?: ProviderTransportPolicy;
  clientLimits?: Partial<BitwardenClientLimits>;
  limits?: Partial<BitwardenAttachmentDownloadLimits>;
  now?: () => number;
  randomUUID?: () => string;
}

interface RawAttachment {
  id: string;
  encryptedFileName?: string;
  declaredCiphertextBytes: number;
  key?: string;
}

interface PlaintextSession {
  providerId: string;
  itemId: string;
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  chunks: Uint8Array[];
  nextOffset: number;
  lastOffset?: number;
  lastNextOffset?: number;
  lastMaximum?: number;
  expiresAt: number;
}

interface CiphertextEnvelope {
  iv: Uint8Array;
  chunks: Uint8Array[];
  ciphertextBytes: number;
}

const DEFAULT_LIMITS: Readonly<BitwardenAttachmentDownloadLimits> = Object.freeze({
  maxPlaintextBytes: BITWARDEN_ATTACHMENT_MAX_BYTES,
  maxRetainedPlaintextBytes: BITWARDEN_ATTACHMENT_MAX_BYTES,
  maxActiveSessions: PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS,
  sessionTtlMs: PROVIDER_ATTACHMENT_UPLOAD_TTL_MS
});

export class BitwardenAttachmentDownloadService {
  private readonly fetcher: typeof fetch;
  private readonly transportPolicy: ProviderTransportPolicy;
  private readonly client: BitwardenClient;
  private readonly limits: BitwardenAttachmentDownloadLimits;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly sessions = new Map<string, PlaintextSession>();
  private retainedPlaintextBytes = 0;
  private activeDownloads = 0;

  constructor(options: BitwardenAttachmentDownloadServiceOptions = {}) {
    this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
    this.transportPolicy = options.transportPolicy || {};
    this.client = new BitwardenClient(this.fetcher, this.transportPolicy, options.clientLimits);
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || (() => crypto.randomUUID());
  }

  async listAttachments(
    input: BitwardenAttachmentVaultContext,
    page: { pageSize?: number; cursor?: string } = {}
  ): Promise<ProviderAttachmentPage> {
    const cipherId = cipherIdOf(input.rawCipher);
    assertOpaqueId(cipherId, "Cipher");
    const attachments = parseRawAttachments(input.rawCipher, this.maximumCiphertextBytes());
    const cipherKey = await this.resolveCipherKey(input);
    try {
      const summaries: ProviderAttachmentSummary[] = [];
      for (const attachment of attachments) {
        summaries.push(await attachmentSummary(attachment, cipherKey));
      }
      return paginateProviderAttachments(summaries, page);
    } finally {
      clearKey(cipherKey);
    }
  }

  async beginDownload(input: BitwardenAttachmentDownloadInput): Promise<BitwardenAttachmentDownloadBeginResult> {
    this.reserveDownloadSlot();
    let cipherKey: BitwardenSymmetricKey | undefined;
    let attachmentKey: BitwardenSymmetricKey | undefined;
    let plaintext: { chunks: Uint8Array[]; sizeBytes: number } | undefined;
    try {
      const cipherId = cipherIdOf(input.rawCipher);
      assertOpaqueId(cipherId, "Cipher");
      assertOpaqueId(input.attachmentId, "附件");
      const rawAttachment = parseRawAttachments(input.rawCipher, this.maximumCiphertextBytes())
        .find((candidate) => candidate.id === input.attachmentId);
      if (!rawAttachment) throw attachmentError("attachment-not-found", "Bitwarden 附件不存在或已被删除。");

      cipherKey = await this.resolveCipherKey(input);
      const download = await this.client.attachmentDownloadInfo(input.session, cipherId, input.attachmentId, input.signal);
      const reconciled = reconcileDownloadInfo(rawAttachment, download.info, input.attachmentId, this.maximumCiphertextBytes());
      const fileName = await decryptAttachmentFileName(reconciled.encryptedFileName, cipherKey);
      attachmentKey = reconciled.key
        ? await decryptBitwardenSymmetricKey(reconciled.key, cipherKey)
        : cloneKey(cipherKey);
      const signedUrl = validateSignedDownloadUrl(download.info.url, download.session.apiUrl);
      let lastError: unknown;
      for (const candidateUrl of attachmentDownloadCandidates(signedUrl, download.session.apiUrl)) {
        try {
          plaintext = await this.downloadAuthenticatedPlaintext(candidateUrl, attachmentKey, input.signal, download.session.accessToken, download.session.apiUrl);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (!(error instanceof ProviderTransportError) || error.status !== 404) throw error;
        }
      }
      if (!plaintext) throw lastError instanceof Error ? lastError : new Error("Bitwarden 附件下载失败。");
      if (plaintext.sizeBytes > this.limits.maxPlaintextBytes) {
        throw attachmentError("bitwarden-attachment-too-large", "Bitwarden 附件明文超过 100 MiB 安全上限。");
      }

      this.pruneExpired();
      if (
        this.sessions.size >= this.limits.maxActiveSessions
        || this.retainedPlaintextBytes + plaintext.sizeBytes > this.limits.maxRetainedPlaintextBytes
      ) {
        throw attachmentError("attachment-read-limit", "同时保留的附件下载过多，请完成或取消现有下载。");
      }
      const readHandle = this.randomUUID();
      if (!readHandle || this.sessions.has(readHandle)) throw attachmentError("attachment-read-handle-invalid", "无法创建安全的附件读取会话。");
      const session: PlaintextSession = {
        providerId: input.providerId,
        itemId: input.itemId,
        attachmentId: input.attachmentId,
        fileName,
        sizeBytes: plaintext.sizeBytes,
        chunks: plaintext.chunks,
        nextOffset: 0,
        expiresAt: this.now() + this.limits.sessionTtlMs
      };
      this.sessions.set(readHandle, session);
      this.retainedPlaintextBytes += session.sizeBytes;
      plaintext = undefined;
      return {
        readHandle,
        attachmentId: session.attachmentId,
        providerKind: "bitwarden",
        fileName: session.fileName,
        sizeBytes: session.sizeBytes,
        protected: true,
        maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES,
        session: download.session
      };
    } finally {
      if (plaintext) clearChunks(plaintext.chunks);
      if (attachmentKey) clearKey(attachmentKey);
      if (cipherKey) clearKey(cipherKey);
      this.activeDownloads -= 1;
    }
  }

  readChunk(providerId: string, readHandle: string, offset: number, maximum: number): BitwardenAttachmentPlainChunk {
    this.pruneExpired();
    const session = this.sessions.get(readHandle);
    if (!session || session.providerId !== providerId) {
      throw attachmentError("attachment-read-not-found", "Bitwarden 附件下载已过期，请重新开始。");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > PROVIDER_ATTACHMENT_CHUNK_BYTES) {
      throw attachmentError("attachment-read-size-invalid", "Bitwarden 附件读取分块大小无效。");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > session.sizeBytes) {
      throw attachmentError("attachment-read-offset-invalid", "Bitwarden 附件读取偏移无效。");
    }

    let nextOffset: number;
    if (offset === session.lastOffset) {
      if (maximum !== session.lastMaximum || session.lastNextOffset === undefined) {
        throw attachmentError("attachment-read-offset-invalid", "Bitwarden 附件重试必须使用相同的分块边界。");
      }
      nextOffset = session.lastNextOffset;
    } else {
      if (offset !== session.nextOffset) {
        throw attachmentError("attachment-read-offset-invalid", "Bitwarden 附件必须按顺序读取，不能跳过或回退。");
      }
      nextOffset = Math.min(session.sizeBytes, offset + maximum);
      session.lastOffset = offset;
      session.lastNextOffset = nextOffset;
      session.lastMaximum = maximum;
      session.nextOffset = nextOffset;
    }
    session.expiresAt = this.now() + this.limits.sessionTtlMs;
    return {
      readHandle,
      attachmentId: session.attachmentId,
      fileName: session.fileName,
      sizeBytes: session.sizeBytes,
      offset,
      nextOffset,
      bytes: copyPlaintextRange(session.chunks, offset, nextOffset),
      eof: nextOffset === session.sizeBytes,
      mediaType: session.mediaType
    };
  }

  release(providerId: string, readHandle: string): boolean {
    this.pruneExpired();
    const session = this.sessions.get(readHandle);
    if (!session || session.providerId !== providerId) return false;
    this.destroySession(readHandle, session);
    return true;
  }

  clear(): void {
    for (const [readHandle, session] of this.sessions) this.destroySession(readHandle, session);
  }

  private reserveDownloadSlot(): void {
    this.pruneExpired();
    if (this.activeDownloads >= 1 || this.sessions.size + this.activeDownloads >= this.limits.maxActiveSessions) {
      throw attachmentError("attachment-read-limit", "同时进行的 Bitwarden 附件下载过多，请完成或取消现有下载。");
    }
    this.activeDownloads += 1;
  }

  private async resolveCipherKey(input: BitwardenAttachmentVaultContext): Promise<BitwardenSymmetricKey> {
    const personalKey = this.client.vaultKey(input.session);
    let ownerCopy: BitwardenSymmetricKey | undefined;
    try {
      const organizationId = optionalString(input.rawCipher, "OrganizationId", "organizationId");
      const selected = organizationId ? input.organizationKeys?.get(organizationId) : personalKey;
      if (!selected) {
        throw attachmentError("bitwarden-organization-key-missing", "Bitwarden 组织附件的组织密钥不可用。");
      }
      ownerCopy = cloneKey(selected);
    } finally {
      clearKey(personalKey);
    }
    try {
      const protectedCipherKey = optionalString(input.rawCipher, "Key", "key");
      return protectedCipherKey ? await decryptBitwardenSymmetricKey(protectedCipherKey, ownerCopy) : cloneKey(ownerCopy);
    } finally {
      clearKey(ownerCopy);
    }
  }

  private async downloadAuthenticatedPlaintext(
    signedUrl: string,
    key: BitwardenSymmetricKey,
    signal?: AbortSignal,
    accessToken?: string,
    apiUrl?: string
  ): Promise<{ chunks: Uint8Array[]; sizeBytes: number }> {
    const headers = new Headers({ Accept: "application/octet-stream", "Cache-Control": "no-store" });
    if (accessToken && apiUrl && sameOrigin(signedUrl, apiUrl)) headers.set("Authorization", `Bearer ${accessToken}`);
    return resilientFetch(signedUrl, {
      method: "GET",
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal
    }, {
      ...this.transportPolicy,
      operation: "下载 Bitwarden 附件",
      fetcher: this.fetcher,
      idempotent: true
    }, async (response, requestSignal) => {
      if (!response.ok) throw providerHttpError("下载 Bitwarden 附件失败", response);
      const envelope = await readAuthenticatedEnvelope(response, key.macKey, this.maximumCiphertextBytes(), requestSignal);
      return decryptAuthenticatedEnvelope(envelope, key.encKey, this.limits.maxPlaintextBytes);
    });
  }

  private maximumCiphertextBytes(): number {
    return this.limits.maxPlaintextBytes + ATTACHMENT_IV_BYTES + ATTACHMENT_MAC_BYTES + AES_BLOCK_BYTES;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [readHandle, session] of this.sessions) {
      if (session.expiresAt <= now) this.destroySession(readHandle, session);
    }
  }

  private destroySession(readHandle: string, session: PlaintextSession): void {
    if (this.sessions.get(readHandle) !== session) return;
    this.sessions.delete(readHandle);
    clearChunks(session.chunks);
    this.retainedPlaintextBytes = Math.max(0, this.retainedPlaintextBytes - session.sizeBytes);
    session.nextOffset = 0;
    session.lastOffset = undefined;
    session.lastNextOffset = undefined;
    session.lastMaximum = undefined;
  }
}

async function readAuthenticatedEnvelope(
  response: Response,
  macKey: Uint8Array,
  maximumBytes: number,
  signal: AbortSignal
): Promise<CiphertextEnvelope> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw attachmentError("bitwarden-attachment-too-large", "Bitwarden 附件密文超过安全上限。");
    }
  }
  const hmac = await createHMAC(createSHA256(), macKey);
  hmac.init();
  const collector = new CiphertextCollector();
  let tail = EMPTY_BYTES;
  let total = 0;
  const reader = response.body?.getReader();
  const onAbort = () => { void reader?.cancel(signal.reason).catch(() => undefined); };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (!reader) {
      let value: Uint8Array;
      try {
        value = new Uint8Array(await response.arrayBuffer());
      } catch (cause) {
        throw new ProviderBodyReadNetworkError(cause);
      }
      ({ tail, total } = consumeDownloadedBytes(value, tail, total, maximumBytes, hmac, collector));
      value.fill(0);
    } else {
      while (true) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (cause) {
          if (signal.aborted) throw cause;
          throw new ProviderBodyReadNetworkError(cause);
        }
        if (result.done) break;
        ({ tail, total } = consumeDownloadedBytes(result.value, tail, total, maximumBytes, hmac, collector));
      }
    }
    if (signal.aborted) throw signal.reason || new DOMException("Attachment download aborted", "AbortError");
    if (total < ATTACHMENT_IV_BYTES + AES_BLOCK_BYTES + ATTACHMENT_MAC_BYTES || tail.length !== ATTACHMENT_MAC_BYTES) {
      throw attachmentError("bitwarden-attachment-truncated", "Bitwarden 附件密文不完整。");
    }
    const digest = hmac.digest("binary");
    if (!(digest instanceof Uint8Array) || !constantTimeEqual(digest, tail)) {
      if (digest instanceof Uint8Array) digest.fill(0);
      throw attachmentError("bitwarden-attachment-mac-invalid", "Bitwarden 附件完整性校验失败。");
    }
    digest.fill(0);
    tail.fill(0);
    tail = EMPTY_BYTES;
    return collector.finish();
  } catch (error) {
    tail.fill(0);
    collector.destroy();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

function consumeDownloadedBytes(
  value: Uint8Array,
  previousTail: Uint8Array,
  previousTotal: number,
  maximumBytes: number,
  hmac: { update(data: Uint8Array): unknown },
  collector: CiphertextCollector
): { tail: Uint8Array; total: number } {
  const total = previousTotal + value.length;
  if (!Number.isSafeInteger(total) || total > maximumBytes) {
    throw attachmentError("bitwarden-attachment-too-large", "Bitwarden 附件密文超过安全上限。");
  }
  const combined = new Uint8Array(previousTail.length + value.length);
  combined.set(previousTail);
  combined.set(value, previousTail.length);
  previousTail.fill(0);
  const releasedLength = Math.max(0, combined.length - ATTACHMENT_MAC_BYTES);
  if (releasedLength) {
    const released = combined.subarray(0, releasedLength);
    hmac.update(released);
    collector.append(released);
  }
  const tail = combined.slice(releasedLength);
  combined.fill(0);
  return { tail, total };
}

class CiphertextCollector {
  private iv: Uint8Array = new Uint8Array(ATTACHMENT_IV_BYTES);
  private ivLength = 0;
  private chunks: Uint8Array[] = [];
  private current: Uint8Array = new Uint8Array(PROVIDER_ATTACHMENT_CHUNK_BYTES);
  private currentLength = 0;
  private ciphertextBytes = 0;
  private finished = false;

  append(input: Uint8Array): void {
    if (this.finished) throw new Error("Bitwarden attachment collector already finished.");
    let offset = 0;
    if (this.ivLength < ATTACHMENT_IV_BYTES) {
      const take = Math.min(ATTACHMENT_IV_BYTES - this.ivLength, input.length);
      this.iv.set(input.subarray(0, take), this.ivLength);
      this.ivLength += take;
      offset += take;
    }
    while (offset < input.length) {
      const take = Math.min(this.current.length - this.currentLength, input.length - offset);
      this.current.set(input.subarray(offset, offset + take), this.currentLength);
      this.currentLength += take;
      this.ciphertextBytes += take;
      offset += take;
      if (this.currentLength === this.current.length) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(PROVIDER_ATTACHMENT_CHUNK_BYTES);
        this.currentLength = 0;
      }
    }
  }

  finish(): CiphertextEnvelope {
    if (this.finished) throw new Error("Bitwarden attachment collector already finished.");
    if (this.ivLength !== ATTACHMENT_IV_BYTES || this.ciphertextBytes < AES_BLOCK_BYTES || this.ciphertextBytes % AES_BLOCK_BYTES !== 0) {
      throw attachmentError("bitwarden-attachment-truncated", "Bitwarden 附件 AES-CBC 密文边界无效。");
    }
    if (this.currentLength) {
      this.chunks.push(this.current.slice(0, this.currentLength));
      this.current.fill(0);
    } else {
      this.current.fill(0);
    }
    this.finished = true;
    const envelope = { iv: this.iv, chunks: this.chunks, ciphertextBytes: this.ciphertextBytes };
    this.iv = EMPTY_BYTES;
    this.chunks = [];
    this.current = EMPTY_BYTES;
    this.currentLength = 0;
    this.ciphertextBytes = 0;
    return envelope;
  }

  destroy(): void {
    this.iv.fill(0);
    this.current.fill(0);
    clearChunks(this.chunks);
    this.chunks = [];
    this.finished = true;
  }
}

async function decryptAuthenticatedEnvelope(
  envelope: CiphertextEnvelope,
  encryptionKey: Uint8Array,
  maximumPlaintextBytes: number
): Promise<{ chunks: Uint8Array[]; sizeBytes: number }> {
  const plaintextChunks: Uint8Array[] = [];
  let currentIv = envelope.iv.slice();
  let plaintextBytes = 0;
  try {
    const cryptoKey = await crypto.subtle.importKey("raw", encryptionKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
    for (let index = 0; index < envelope.chunks.length; index += 1) {
      const ciphertext = envelope.chunks[index];
      const final = index === envelope.chunks.length - 1;
      const nextIv = ciphertext.slice(ciphertext.length - AES_BLOCK_BYTES);
      let decrypted: Uint8Array;
      try {
        if (final) {
          decrypted = new Uint8Array(await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: currentIv as BufferSource },
            cryptoKey,
            ciphertext as BufferSource
          ));
        } else {
          const syntheticEncrypted = new Uint8Array(await crypto.subtle.encrypt(
            { name: "AES-CBC", iv: nextIv as BufferSource },
            cryptoKey,
            SYNTHETIC_PADDING_PLAINTEXT as BufferSource
          ));
          const joined = new Uint8Array(ciphertext.length + AES_BLOCK_BYTES);
          joined.set(ciphertext);
          joined.set(syntheticEncrypted.subarray(0, AES_BLOCK_BYTES), ciphertext.length);
          try {
            decrypted = new Uint8Array(await crypto.subtle.decrypt(
              { name: "AES-CBC", iv: currentIv as BufferSource },
              cryptoKey,
              joined as BufferSource
            ));
          } finally {
            joined.fill(0);
            syntheticEncrypted.fill(0);
          }
          if (decrypted.length !== ciphertext.length) throw new Error("non-final AES-CBC chunk length mismatch");
        }
      } catch {
        throw attachmentError("bitwarden-attachment-padding-invalid", "Bitwarden 附件 AES-CBC 填充无效。");
      }
      plaintextBytes += decrypted.length;
      if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes > maximumPlaintextBytes) {
        decrypted.fill(0);
        throw attachmentError("bitwarden-attachment-too-large", "Bitwarden 附件明文超过安全上限。");
      }
      plaintextChunks.push(decrypted);
      ciphertext.fill(0);
      envelope.chunks[index] = EMPTY_BYTES;
      currentIv.fill(0);
      currentIv = nextIv;
    }
    return { chunks: plaintextChunks, sizeBytes: plaintextBytes };
  } catch (error) {
    clearChunks(plaintextChunks);
    throw error;
  } finally {
    currentIv.fill(0);
    destroyEnvelope(envelope);
  }
}

function parseRawAttachments(rawCipher: Record<string, unknown>, maximumCiphertextBytes: number): RawAttachment[] {
  const raw = value(rawCipher, "Attachments", "attachments");
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_BITWARDEN_ATTACHMENTS_PER_CIPHER) {
    throw attachmentError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件元数据数量或结构无效。");
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw attachmentError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件元数据结构无效。");
    }
    const record = entry as Record<string, unknown>;
    const id = optionalString(record, "Id", "id") || "";
    assertOpaqueId(id, "附件");
    if (seen.has(id)) throw attachmentError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件 ID 重复。");
    seen.add(id);
    const declaredCiphertextBytes = parseAttachmentSize(value(record, "Size", "size"));
    if (declaredCiphertextBytes > maximumCiphertextBytes) {
      throw attachmentError("bitwarden-attachment-too-large", "Bitwarden 附件密文超过安全上限。");
    }
    return {
      id,
      encryptedFileName: optionalString(record, "FileName", "fileName"),
      declaredCiphertextBytes,
      key: optionalString(record, "Key", "key")
    };
  });
}

async function attachmentSummary(attachment: RawAttachment, cipherKey: BitwardenSymmetricKey): Promise<ProviderAttachmentSummary> {
  return {
    attachmentId: attachment.id,
    providerKind: "bitwarden",
    fileName: await decryptAttachmentFileName(attachment.encryptedFileName, cipherKey),
    sizeBytes: attachment.declaredCiphertextBytes,
    protected: true
  };
}

function reconcileDownloadInfo(
  raw: RawAttachment,
  info: BitwardenAttachmentDownloadInfo,
  requestedAttachmentId: string,
  maximumCiphertextBytes: number
): RawAttachment {
  if (info.id && info.id !== requestedAttachmentId) {
    throw attachmentError("bitwarden-attachment-target-mismatch", "Bitwarden 附件下载响应指向了其他附件。");
  }
  if (raw.encryptedFileName && info.fileName && raw.encryptedFileName !== info.fileName) {
    throw attachmentError("bitwarden-attachment-metadata-changed", "Bitwarden 附件名称在下载期间发生变化，请重新同步。");
  }
  if (raw.key && info.key && raw.key !== info.key) {
    throw attachmentError("bitwarden-attachment-metadata-changed", "Bitwarden 附件密钥在下载期间发生变化，请重新同步。");
  }
  const infoSize = parseAttachmentSize(info.size);
  if (infoSize > maximumCiphertextBytes) {
    throw attachmentError("bitwarden-attachment-too-large", "Bitwarden 附件密文超过安全上限。");
  }
  if (raw.declaredCiphertextBytes > 0 && infoSize > 0 && raw.declaredCiphertextBytes !== infoSize) {
    throw attachmentError("bitwarden-attachment-metadata-changed", "Bitwarden 附件大小在下载期间发生变化，请重新同步。");
  }
  return {
    ...raw,
    encryptedFileName: raw.encryptedFileName || info.fileName,
    key: raw.key || info.key,
    declaredCiphertextBytes: infoSize || raw.declaredCiphertextBytes
  };
}

async function decryptAttachmentFileName(value: string | undefined, key: BitwardenSymmetricKey): Promise<string> {
  if (!value) throw attachmentError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件缺少加密文件名。");
  let fileName: string;
  try {
    fileName = await decryptBitwardenString(value, key);
  } catch {
    throw attachmentError("bitwarden-attachment-name-invalid", "Bitwarden 附件文件名无法解密。");
  }
  const bytes = new TextEncoder().encode(fileName).length;
  if (!fileName || bytes > MAX_FILE_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw attachmentError("bitwarden-attachment-name-invalid", "Bitwarden 附件文件名无效或过长。");
  }
  return fileName;
}

function validateSignedDownloadUrl(raw: string, apiUrl?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw, apiUrl);
  } catch {
    throw attachmentError("bitwarden-attachment-url-invalid", "Bitwarden 附件签名地址无效。");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw attachmentError("bitwarden-attachment-url-invalid", "Bitwarden 附件签名地址包含不允许的凭据或片段。");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw attachmentError("bitwarden-attachment-url-invalid", "Bitwarden 附件签名地址必须使用 HTTPS。");
  }
  return parsed.toString();
}

function sameOrigin(left: string, right: string): boolean {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
}

/**
 * Vaultwarden installations hosted below a reverse-proxy prefix can return an
 * object URL without that prefix. Keep the signed URL first, then retry only
 * the safe same-origin prefixed variant when the object server responds 404.
 */
function attachmentDownloadCandidates(signedUrl: string, apiUrl?: string): string[] {
  if (!apiUrl || !sameOrigin(signedUrl, apiUrl)) return [signedUrl];
  try {
    const signed = new URL(signedUrl);
    const api = new URL(apiUrl);
    const apiDirectory = api.pathname.endsWith("/") ? api.pathname.slice(0, -1) : api.pathname.substring(0, api.pathname.lastIndexOf("/"));
    if (!apiDirectory || apiDirectory === "/" || signed.pathname.startsWith(`${apiDirectory}/`)) return [signedUrl];
    const prefixed = new URL(signedUrl);
    prefixed.pathname = `${apiDirectory}${signed.pathname.startsWith("/") ? signed.pathname : `/${signed.pathname}`}`;
    const candidate = prefixed.toString();
    return candidate === signedUrl ? [signedUrl] : [signedUrl, candidate];
  } catch {
    return [signedUrl];
  }
}

function validateLimits(input: BitwardenAttachmentDownloadLimits): BitwardenAttachmentDownloadLimits {
  if (!Number.isSafeInteger(input.maxPlaintextBytes) || input.maxPlaintextBytes < 1 || input.maxPlaintextBytes > BITWARDEN_ATTACHMENT_MAX_BYTES) {
    throw new Error("Bitwarden 附件明文安全上限无效。");
  }
  if (!Number.isSafeInteger(input.maxRetainedPlaintextBytes) || input.maxRetainedPlaintextBytes < 1 || input.maxRetainedPlaintextBytes > BITWARDEN_ATTACHMENT_MAX_BYTES) {
    throw new Error("Bitwarden 附件保留内存上限无效。");
  }
  if (!Number.isSafeInteger(input.maxActiveSessions) || input.maxActiveSessions < 1 || input.maxActiveSessions > PROVIDER_ATTACHMENT_MAX_ACTIVE_UPLOADS) {
    throw new Error("Bitwarden 附件读取会话上限无效。");
  }
  if (!Number.isSafeInteger(input.sessionTtlMs) || input.sessionTtlMs < 1 || input.sessionTtlMs > PROVIDER_ATTACHMENT_UPLOAD_TTL_MS) {
    throw new Error("Bitwarden 附件读取会话有效期无效。");
  }
  return input;
}

function parseAttachmentSize(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  if (typeof raw === "string" && !/^\d+$/.test(raw)) {
    throw attachmentError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件大小无效。");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw attachmentError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件大小无效。");
  }
  return value;
}

function assertOpaqueId(value: string, label: string): void {
  const bytes = new TextEncoder().encode(value).length;
  if (!value || bytes > MAX_OPAQUE_ID_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw attachmentError("bitwarden-attachment-metadata-invalid", `Bitwarden ${label} ID 无效。`);
  }
}

function cipherIdOf(raw: Record<string, unknown>): string {
  return optionalString(raw, "Id", "id") || "";
}

function cloneKey(key: BitwardenSymmetricKey): BitwardenSymmetricKey {
  if (key.encKey.length !== 32 || key.macKey.length !== 32) {
    throw attachmentError("bitwarden-attachment-key-invalid", "Bitwarden 附件密钥长度无效。");
  }
  return { encKey: key.encKey.slice(), macKey: key.macKey.slice() };
}

function clearKey(key: BitwardenSymmetricKey): void {
  key.encKey.fill(0);
  key.macKey.fill(0);
}

function clearChunks(chunks: Uint8Array[]): void {
  for (const chunk of chunks) chunk.fill(0);
}

function destroyEnvelope(envelope: CiphertextEnvelope): void {
  envelope.iv.fill(0);
  clearChunks(envelope.chunks);
  envelope.chunks = [];
  envelope.ciphertextBytes = 0;
}

function copyPlaintextRange(chunks: Uint8Array[], start: number, end: number): Uint8Array {
  const output = new Uint8Array(end - start);
  let sourceOffset = 0;
  let targetOffset = 0;
  for (const chunk of chunks) {
    const chunkEnd = sourceOffset + chunk.length;
    if (chunkEnd > start && sourceOffset < end) {
      const from = Math.max(start, sourceOffset) - sourceOffset;
      const to = Math.min(end, chunkEnd) - sourceOffset;
      output.set(chunk.subarray(from, to), targetOffset);
      targetOffset += to - from;
    }
    sourceOffset = chunkEnd;
    if (sourceOffset >= end) break;
  }
  if (targetOffset !== output.length) {
    output.fill(0);
    throw attachmentError("attachment-read-corrupt", "Bitwarden 附件读取会话已损坏。");
  }
  return output;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in raw) return raw[name];
  return undefined;
}

function optionalString(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  const found = value(raw, ...names);
  return typeof found === "string" && found ? found : undefined;
}

function attachmentError(code: string, message: string): ProviderAttachmentError {
  return new ProviderAttachmentError(code, message);
}
