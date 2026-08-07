import { createSHA256 } from "hash-wasm";
import { randomBytes } from "../../security/encoding";
import {
  BITWARDEN_ATTACHMENT_MAX_BYTES,
  PROVIDER_ATTACHMENT_CHUNK_BYTES,
  ProviderAttachmentError,
  type ProviderAttachmentSummary
} from "../attachments/attachment-contract";
import { ProviderTransportError, type ProviderTransportPolicy } from "../provider-transport";
import {
  IndexedDbBitwardenAttachmentMutationStore,
  type BitwardenAttachmentMutationKind,
  type BitwardenAttachmentMutationRecord,
  type BitwardenAttachmentMutationStore
} from "./bitwarden-attachment-mutation-store";
import {
  BitwardenAttachmentDownloadService,
  type BitwardenAttachmentVaultContext
} from "./bitwarden-attachments";
import { resolveBitwardenCipherKey } from "./bitwarden-cipher-codec";
import {
  BitwardenClient,
  type BitwardenClientLimits,
  type BitwardenFileUploadType,
  type BitwardenSessionConfig
} from "./bitwarden-client";
import {
  decryptBitwardenSymmetricKey,
  encryptBitwardenBytes,
  encryptBitwardenString,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";

const AES_BLOCK_BYTES = 16;
const ATTACHMENT_IV_BYTES = 16;
const ATTACHMENT_MAC_BYTES = 32;
const MAX_MUTATION_RECORDS_PER_PROVIDER = 256;
const MAX_ATTACHMENTS_PER_CIPHER = 512;
const MAX_FILE_NAME_BYTES = 4096;
const MAX_ID_BYTES = 4096;
const MAX_ATTEMPTS = 8;
const OPERATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface BitwardenAttachmentUploadMutationInput extends BitwardenAttachmentVaultContext {
  operationId: string;
  fileName: string;
  bytes: Uint8Array;
  sha256?: string;
  replaceAttachmentId?: string;
  signal?: AbortSignal;
}

export interface BitwardenAttachmentDeleteMutationInput extends BitwardenAttachmentVaultContext {
  operationId: string;
  attachmentId: string;
  signal?: AbortSignal;
}

export interface BitwardenAttachmentMutationResult {
  changed: boolean;
  session: BitwardenSessionConfig;
  rawCipher: Record<string, unknown>;
  attachment?: ProviderAttachmentSummary;
}

export interface BitwardenAttachmentMutationLimits {
  maxPlaintextBytes: number;
}

export interface BitwardenAttachmentMutationServiceOptions {
  fetcher?: typeof fetch;
  transportPolicy?: ProviderTransportPolicy;
  clientLimits?: Partial<BitwardenClientLimits>;
  limits?: Partial<BitwardenAttachmentMutationLimits>;
  store?: BitwardenAttachmentMutationStore;
  now?: () => number;
  randomness?: (length: number) => Uint8Array;
}

interface NormalizedUploadInput extends Omit<BitwardenAttachmentUploadMutationInput, "bytes" | "sha256"> {
  bytes: Uint8Array;
  sha256: string;
  fileNameSha256: string;
  kind: "upload" | "replace";
}

interface SyncedCipher {
  session: BitwardenSessionConfig;
  rawCipher: Record<string, unknown>;
}

interface PreparedMaterial {
  encryptedFileName: string;
  wrappedKey: string;
  encryptedBytes: Uint8Array;
}

interface RemoteAttachment {
  id: string;
  encryptedFileName: string;
  wrappedKey?: string;
  encryptedSizeBytes: number;
}

interface VerificationResult extends SyncedCipher {
  verified: boolean;
}

interface ActiveOperation {
  fingerprint: string;
  promise: Promise<BitwardenAttachmentMutationResult>;
}

const DEFAULT_LIMITS: Readonly<BitwardenAttachmentMutationLimits> = Object.freeze({
  maxPlaintextBytes: BITWARDEN_ATTACHMENT_MAX_BYTES
});

export class BitwardenAttachmentMutationService {
  private readonly fetcher: typeof fetch;
  private readonly transportPolicy: ProviderTransportPolicy;
  private readonly client: BitwardenClient;
  private readonly downloads: BitwardenAttachmentDownloadService;
  private readonly store: BitwardenAttachmentMutationStore;
  private readonly now: () => number;
  private readonly randomness: (length: number) => Uint8Array;
  private readonly limits: BitwardenAttachmentMutationLimits;
  private readonly active = new Map<string, ActiveOperation>();

  constructor(options: BitwardenAttachmentMutationServiceOptions = {}) {
    this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
    this.transportPolicy = options.transportPolicy || {};
    this.client = new BitwardenClient(this.fetcher, this.transportPolicy, options.clientLimits);
    this.store = options.store || new IndexedDbBitwardenAttachmentMutationStore();
    this.now = options.now || Date.now;
    this.randomness = options.randomness || randomBytes;
    this.limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.downloads = new BitwardenAttachmentDownloadService({
      fetcher: this.fetcher,
      transportPolicy: this.transportPolicy,
      clientLimits: options.clientLimits,
      limits: {
        maxPlaintextBytes: this.limits.maxPlaintextBytes,
        maxRetainedPlaintextBytes: this.limits.maxPlaintextBytes
      },
      now: this.now
    });
  }

  async upload(input: BitwardenAttachmentUploadMutationInput): Promise<BitwardenAttachmentMutationResult> {
    const normalized = await this.normalizeUploadInput(input);
    const activeKey = operationKey(normalized.providerId, normalized.operationId);
    const fingerprint = uploadOperationFingerprint(normalized);
    const current = this.active.get(activeKey);
    if (current) {
      normalized.bytes.fill(0);
      if (current.fingerprint !== fingerprint) throw mutationError("bitwarden-attachment-operation-reused", "附件操作 ID 已用于其他内容。");
      return current.promise;
    }
    const promise = this.executeUpload(normalized).finally(() => {
      normalized.bytes.fill(0);
      if (this.active.get(activeKey)?.promise === promise) this.active.delete(activeKey);
    });
    this.active.set(activeKey, { fingerprint, promise });
    return promise;
  }

  async delete(input: BitwardenAttachmentDeleteMutationInput): Promise<BitwardenAttachmentMutationResult> {
    validateContext(input);
    assertOperationId(input.operationId);
    assertOpaqueId(input.attachmentId, "附件");
    const fingerprint = `delete\0${input.providerId}\0${cipherIdOf(input.rawCipher)}\0${input.attachmentId}`;
    const activeKey = operationKey(input.providerId, input.operationId);
    const current = this.active.get(activeKey);
    if (current) {
      if (current.fingerprint !== fingerprint) throw mutationError("bitwarden-attachment-operation-reused", "附件操作 ID 已用于其他内容。");
      return current.promise;
    }
    const promise = this.executeDelete(input).finally(() => {
      if (this.active.get(activeKey)?.promise === promise) this.active.delete(activeKey);
    });
    this.active.set(activeKey, { fingerprint, promise });
    return promise;
  }

  listRecoveryRecords(providerId: string): Promise<BitwardenAttachmentMutationRecord[]> {
    return this.store.list(providerId);
  }

  private async executeUpload(input: NormalizedUploadInput): Promise<BitwardenAttachmentMutationResult> {
    const cipherId = cipherIdOf(input.rawCipher);
    let synced = await this.syncCipher(input.session, cipherId, input.signal);
    let record = await this.store.read(input.providerId, input.operationId);
    if (record) {
      assertUploadRecordIntent(record, input, cipherId);
    } else {
      await this.ensureRecordCapacity(input.providerId);
      const timestamp = isoTimestamp(this.now());
      record = await this.store.save({
        version: 1,
        revision: 0,
        providerId: input.providerId,
        operationId: input.operationId,
        cipherId,
        kind: input.kind,
        stage: "intent",
        attempt: 0,
        oldAttachmentId: input.replaceAttachmentId,
        plaintextSha256: input.sha256,
        fileNameSha256: input.fileNameSha256,
        plainSizeBytes: input.bytes.length,
        serverRevisionDate: revisionDateOf(synced.rawCipher),
        createdAt: timestamp,
        updatedAt: timestamp
      }, 0);
    }

    if (record.stage === "completed") return this.completedUploadResult(input, record, synced);
    if (record.stage === "rolling-back") {
      const recovered = await this.rollbackCreatedAttachment(input, record, synced);
      throw mutationError("bitwarden-attachment-create-recovered", recovered
        ? "前一次附件创建已回滚，请重试上传。"
        : "附件回滚状态仍需确认，请稍后重试。");
    }
    if (record.stage === "preparing") {
      const matched = await findAttachmentByFingerprints(synced.rawCipher, record);
      if (!matched) throw mutationError("bitwarden-attachment-create-pending", "Bitwarden 附件创建结果仍需同步确认，未再次创建附件。");
      if (record.oldAttachmentId && matched.id === record.oldAttachmentId) {
        throw mutationError("bitwarden-attachment-target-mismatch", "Bitwarden 返回的新附件 ID 与待替换旧附件相同，操作已停止。");
      }
      record = await this.updateRecord(record, {
        stage: "rolling-back",
        newAttachmentId: matched.id,
        fileUploadType: 0
      });
      await this.rollbackCreatedAttachment(input, record, synced);
      throw mutationError("bitwarden-attachment-create-recovered", "丢失响应的附件元数据已找到并回滚，请重试上传。");
    }
    if (record.stage !== "intent") return this.resumePreparedUpload(input, record, synced);
    if (record.attempt >= MAX_ATTEMPTS) throw mutationError("bitwarden-attachment-attempt-limit", "Bitwarden 附件恢复尝试次数超过安全上限，请使用新的操作 ID。");

    const attempt = await this.createPreparedMaterial(input, synced.rawCipher);
    let material = attempt.material;
    record = await this.updateRecord(record, {
      stage: "preparing",
      attempt: record.attempt + 1,
      encryptedFileNameSha256: await bitwardenAttachmentTextSha256(material.encryptedFileName),
      wrappedKeySha256: await bitwardenAttachmentTextSha256(material.wrappedKey),
      encryptedSizeBytes: material.encryptedBytes.length,
      serverRevisionDate: revisionDateOf(synced.rawCipher),
      newAttachmentId: undefined,
      fileUploadType: undefined
    });

    try {
      let prepared;
      try {
        prepared = await this.client.prepareAttachmentUpload(synced.session, cipherId, {
          key: material.wrappedKey,
          fileName: material.encryptedFileName,
          fileSize: material.encryptedBytes.length,
          lastKnownRevisionDate: revisionDateOf(synced.rawCipher)
        }, input.signal);
      } catch (cause) {
        synced = await this.reconcileUnknownCreate(input, record, synced, cause);
        throw cause;
      }
      synced = {
        session: prepared.session,
        rawCipher: choosePreparedCipher(prepared.upload.cipherResponse, prepared.upload.cipherMiniResponse, synced.rawCipher, cipherId)
      };
      if (input.replaceAttachmentId && prepared.upload.attachmentId === input.replaceAttachmentId) {
        throw mutationError("bitwarden-attachment-target-mismatch", "Bitwarden 返回的新附件 ID 与待替换旧附件相同，操作已停止。");
      }
      record = await this.updateRecord(record, {
        stage: "prepared",
        newAttachmentId: prepared.upload.attachmentId,
        fileUploadType: prepared.upload.fileUploadType,
        serverRevisionDate: revisionDateOf(synced.rawCipher)
      });
      synced = await this.syncCipher(synced.session, cipherId, input.signal);
      const confirmed = await findAttachmentByFingerprints(synced.rawCipher, record);
      if (!confirmed) throw mutationError("bitwarden-attachment-create-pending", "Bitwarden 附件元数据尚未出现在同步结果中，上传将在恢复后继续。");
      if (input.replaceAttachmentId && confirmed.id === input.replaceAttachmentId) {
        throw mutationError("bitwarden-attachment-target-mismatch", "Bitwarden 同步返回的新附件 ID 与待替换旧附件相同，操作已停止。");
      }
      if (confirmed.id !== record.newAttachmentId) record = await this.updateRecord(record, { newAttachmentId: confirmed.id });
      return await this.uploadAndVerify(input, record, synced, material, prepared.upload.url);
    } finally {
      material.encryptedBytes.fill(0);
      material = { ...material, encryptedBytes: new Uint8Array() };
    }
  }

  private async resumePreparedUpload(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    synced: SyncedCipher
  ): Promise<BitwardenAttachmentMutationResult> {
    if (!record.newAttachmentId || (record.fileUploadType !== 0 && record.fileUploadType !== 1)) {
      throw mutationError("bitwarden-attachment-recovery-invalid", "Bitwarden 附件恢复记录缺少远端上传信息。");
    }
    let remote = await requireRecordAttachment(synced.rawCipher, record);
    if (!remote) {
      const matched = await findAttachmentByFingerprints(synced.rawCipher, record);
      if (matched) {
        if (record.oldAttachmentId && matched.id === record.oldAttachmentId) {
          throw mutationError("bitwarden-attachment-target-mismatch", "Bitwarden 同步返回的新附件 ID 与待替换旧附件相同，操作已停止。");
        }
        record = await this.updateRecord(record, { newAttachmentId: matched.id, serverRevisionDate: revisionDateOf(synced.rawCipher) });
        remote = matched;
      } else {
        record = await this.resetRecordToIntent(record, revisionDateOf(synced.rawCipher));
        throw mutationError("bitwarden-attachment-remote-missing", "待恢复的 Bitwarden 附件元数据已不存在，请重试上传。");
      }
    }

    if (record.stage === "verified" || record.stage === "deleting-old") {
      return this.finishVerifiedUpload(input, record, synced);
    }

    const existing = await this.verifyRemoteAttachment(input, record, synced);
    synced = { session: existing.session, rawCipher: existing.rawCipher };
    if (existing.verified) {
      record = await this.updateRecord(record, { stage: "verified", serverRevisionDate: revisionDateOf(synced.rawCipher) });
      return this.finishVerifiedUpload(input, record, synced);
    }

    const material = await this.recreatePreparedMaterial(input, synced.rawCipher, remote, record);
    try {
      return await this.uploadAndVerify(input, record, synced, material);
    } finally {
      material.encryptedBytes.fill(0);
    }
  }

  private async uploadAndVerify(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    synced: SyncedCipher,
    material: PreparedMaterial,
    initialAzureUrl?: string
  ): Promise<BitwardenAttachmentMutationResult> {
    record = await this.updateRecord(record, { stage: "uploading", serverRevisionDate: revisionDateOf(synced.rawCipher) });
    try {
      if (record.fileUploadType === 0) {
        synced.session = await this.client.uploadAttachmentDirect(
          synced.session,
          record.cipherId,
          record.newAttachmentId!,
          material.encryptedFileName,
          material.encryptedBytes,
          input.signal
        );
      } else if (record.fileUploadType === 1) {
        let url = initialAzureUrl;
        if (!url || azureUrlNeedsRenewal(url, this.now())) {
          const renewed = await this.client.renewAttachmentUploadUrl(synced.session, record.cipherId, record.newAttachmentId!, input.signal);
          synced.session = renewed.session;
          url = renewed.url;
        }
        await this.client.uploadAttachmentAzure(url, material.encryptedBytes, input.signal);
      } else {
        throw mutationError("bitwarden-attachment-recovery-invalid", "Bitwarden 附件上传模式无效。");
      }
    } catch (cause) {
      const recovered = await this.verifyRemoteAttachment(input, record, synced).catch((verificationCause) => {
        if (isTransientVerificationFailure(verificationCause)) return { ...synced, verified: false };
        throw verificationCause;
      });
      synced = { session: recovered.session, rawCipher: recovered.rawCipher };
      if (recovered.verified) {
        record = await this.updateRecord(record, { stage: "verified", serverRevisionDate: revisionDateOf(synced.rawCipher) });
        return this.finishVerifiedUpload(input, record, synced);
      }
      if (isDefinitiveUploadFailure(cause)) {
        await this.rollbackCreatedAttachment(input, record, synced);
        throw cause;
      }
      throw mutationError("bitwarden-attachment-upload-pending", "Bitwarden 附件上传结果仍需恢复确认，请使用相同文件和操作 ID 重试。");
    }

    record = await this.updateRecord(record, { stage: "verifying" });
    const verified = await this.verifyRemoteAttachment(input, record, synced);
    synced = { session: verified.session, rawCipher: verified.rawCipher };
    if (!verified.verified) {
      await this.rollbackCreatedAttachment(input, record, synced);
      throw mutationError("bitwarden-attachment-verification-failed", "Bitwarden 新附件未通过完整性验证，远端元数据已回滚。");
    }
    record = await this.updateRecord(record, { stage: "verified", serverRevisionDate: revisionDateOf(synced.rawCipher) });
    return this.finishVerifiedUpload(input, record, synced);
  }

  private async finishVerifiedUpload(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    synced: SyncedCipher
  ): Promise<BitwardenAttachmentMutationResult> {
    if (record.kind === "replace") {
      if (!record.oldAttachmentId) throw mutationError("bitwarden-attachment-recovery-invalid", "Bitwarden 替换操作缺少旧附件 ID。");
      const oldAttachmentId = record.oldAttachmentId;
      record = await this.updateRecord(record, { stage: "deleting-old", serverRevisionDate: revisionDateOf(synced.rawCipher) });
      try {
        const deleted = await this.client.deleteAttachment(synced.session, record.cipherId, oldAttachmentId, input.signal);
        synced.session = deleted.session;
      } catch (cause) {
        const reconciled = await this.syncCipher(synced.session, record.cipherId, input.signal);
        synced = reconciled;
        if (findAttachmentById(synced.rawCipher, oldAttachmentId)) {
          if (isAuthorizationOrCancellation(cause) || isDefinitiveUploadFailure(cause)) throw cause;
          throw mutationError("bitwarden-attachment-delete-pending", "新附件已验证，旧附件删除结果仍需确认；恢复前不会创建其他附件。");
        }
      }
      synced = await this.syncCipher(synced.session, record.cipherId, input.signal);
      if (findAttachmentById(synced.rawCipher, oldAttachmentId)) {
        throw mutationError("bitwarden-attachment-delete-pending", "新附件已验证，但旧附件仍存在，请使用相同操作 ID 重试。");
      }
    } else {
      synced = await this.syncCipher(synced.session, record.cipherId, input.signal);
    }
    record = await this.updateRecord(record, { stage: "completed", serverRevisionDate: revisionDateOf(synced.rawCipher) });
    return this.completedUploadResult(input, record, synced);
  }

  private async executeDelete(input: BitwardenAttachmentDeleteMutationInput): Promise<BitwardenAttachmentMutationResult> {
    const cipherId = cipherIdOf(input.rawCipher);
    let synced = await this.syncCipher(input.session, cipherId, input.signal);
    let record = await this.store.read(input.providerId, input.operationId);
    if (record) {
      assertDeleteRecordIntent(record, input, cipherId);
      if (record.stage === "completed") return { changed: true, ...synced };
    } else {
      await this.ensureRecordCapacity(input.providerId);
      const timestamp = isoTimestamp(this.now());
      record = await this.store.save({
        version: 1,
        revision: 0,
        providerId: input.providerId,
        operationId: input.operationId,
        cipherId,
        kind: "delete",
        stage: "deleting",
        attempt: 0,
        oldAttachmentId: input.attachmentId,
        serverRevisionDate: revisionDateOf(synced.rawCipher),
        createdAt: timestamp,
        updatedAt: timestamp
      }, 0);
    }

    if (!findAttachmentById(synced.rawCipher, input.attachmentId)) {
      record = await this.updateRecord(record, { stage: "completed", serverRevisionDate: revisionDateOf(synced.rawCipher) });
      return { changed: false, ...synced };
    }
    try {
      const deleted = await this.client.deleteAttachment(synced.session, cipherId, input.attachmentId, input.signal);
      synced.session = deleted.session;
    } catch (cause) {
      synced = await this.syncCipher(synced.session, cipherId, input.signal);
      if (findAttachmentById(synced.rawCipher, input.attachmentId)) {
        if (isAuthorizationOrCancellation(cause) || isDefinitiveUploadFailure(cause)) throw cause;
        throw mutationError("bitwarden-attachment-delete-pending", "Bitwarden 附件删除结果仍需恢复确认，请使用相同操作 ID 重试。");
      }
    }
    synced = await this.syncCipher(synced.session, cipherId, input.signal);
    if (findAttachmentById(synced.rawCipher, input.attachmentId)) {
      throw mutationError("bitwarden-attachment-delete-pending", "Bitwarden 附件删除尚未在同步结果中生效。");
    }
    await this.updateRecord(record, { stage: "completed", serverRevisionDate: revisionDateOf(synced.rawCipher) });
    return { changed: true, ...synced };
  }

  private async normalizeUploadInput(input: BitwardenAttachmentUploadMutationInput): Promise<NormalizedUploadInput> {
    validateContext(input);
    assertOperationId(input.operationId);
    validateFileName(input.fileName);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length > this.limits.maxPlaintextBytes) {
      throw mutationError("bitwarden-attachment-size-invalid", `Bitwarden 附件超过 ${formatBytes(this.limits.maxPlaintextBytes)} 安全上限。`);
    }
    if (input.replaceAttachmentId !== undefined) assertOpaqueId(input.replaceAttachmentId, "旧附件");
    const bytes = input.bytes.slice();
    try {
      const digest = await bitwardenAttachmentSha256(bytes);
      if (input.sha256 && input.sha256 !== digest) throw mutationError("bitwarden-attachment-digest-mismatch", "Bitwarden 附件 SHA-256 与接收内容不一致。");
      return {
        ...input,
        bytes,
        sha256: digest,
        fileNameSha256: await bitwardenAttachmentTextSha256(input.fileName),
        kind: input.replaceAttachmentId ? "replace" : "upload"
      };
    } catch (cause) {
      bytes.fill(0);
      throw cause;
    }
  }

  private async createPreparedMaterial(input: NormalizedUploadInput, rawCipher: Record<string, unknown>): Promise<{ material: PreparedMaterial }> {
    const cipherKey = await this.resolveCipherKey({ ...input, rawCipher });
    const rawAttachmentKey = this.randomness(64);
    if (!(rawAttachmentKey instanceof Uint8Array) || rawAttachmentKey.length !== 64) {
      clearKey(cipherKey);
      rawAttachmentKey?.fill?.(0);
      throw mutationError("bitwarden-attachment-random-invalid", "无法生成 Bitwarden 附件独立密钥。");
    }
    const attachmentKey: BitwardenSymmetricKey = {
      encKey: rawAttachmentKey.slice(0, 32),
      macKey: rawAttachmentKey.slice(32)
    };
    try {
      const encryptedFileName = await encryptBitwardenString(input.fileName, cipherKey, this.randomness);
      const wrappedKey = await encryptBitwardenBytes(rawAttachmentKey, cipherKey, this.randomness);
      const encryptedBytes = await encryptAttachmentPayload(input.bytes, attachmentKey, this.randomness, this.limits.maxPlaintextBytes);
      return { material: { encryptedFileName, wrappedKey, encryptedBytes } };
    } finally {
      rawAttachmentKey.fill(0);
      clearKey(attachmentKey);
      clearKey(cipherKey);
    }
  }

  private async recreatePreparedMaterial(
    input: NormalizedUploadInput,
    rawCipher: Record<string, unknown>,
    remote: RemoteAttachment,
    record: BitwardenAttachmentMutationRecord
  ): Promise<PreparedMaterial> {
    if (
      await bitwardenAttachmentTextSha256(remote.encryptedFileName) !== record.encryptedFileNameSha256
      || !remote.wrappedKey
      || await bitwardenAttachmentTextSha256(remote.wrappedKey) !== record.wrappedKeySha256
      || remote.encryptedSizeBytes !== record.encryptedSizeBytes
    ) throw mutationError("bitwarden-attachment-remote-changed", "Bitwarden 附件元数据与恢复记录不一致。");
    const cipherKey = await this.resolveCipherKey({ ...input, rawCipher });
    let attachmentKey: BitwardenSymmetricKey | undefined;
    try {
      attachmentKey = await decryptBitwardenSymmetricKey(remote.wrappedKey, cipherKey);
      const encryptedBytes = await encryptAttachmentPayload(input.bytes, attachmentKey, this.randomness, this.limits.maxPlaintextBytes);
      if (encryptedBytes.length !== record.encryptedSizeBytes) {
        encryptedBytes.fill(0);
        throw mutationError("bitwarden-attachment-size-invalid", "重新加密的 Bitwarden 附件大小与恢复记录不一致。");
      }
      return { encryptedFileName: remote.encryptedFileName, wrappedKey: remote.wrappedKey, encryptedBytes };
    } finally {
      if (attachmentKey) clearKey(attachmentKey);
      clearKey(cipherKey);
    }
  }

  private async resolveCipherKey(input: BitwardenAttachmentVaultContext): Promise<BitwardenSymmetricKey> {
    const personal = this.client.vaultKey(input.session);
    let owner: BitwardenSymmetricKey | undefined;
    try {
      const organizationId = optionalString(input.rawCipher, "OrganizationId", "organizationId");
      const selected = organizationId ? input.organizationKeys?.get(organizationId) : personal;
      if (!selected) throw mutationError("bitwarden-organization-key-missing", "Bitwarden 组织附件的组织密钥不可用。");
      owner = cloneKey(selected);
    } finally {
      clearKey(personal);
    }
    try {
      const resolved = await resolveBitwardenCipherKey(input.rawCipher, owner);
      if (resolved === owner) {
        owner = undefined;
        return resolved;
      }
      return resolved;
    } finally {
      if (owner) clearKey(owner);
    }
  }

  private async verifyRemoteAttachment(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    current: SyncedCipher
  ): Promise<VerificationResult> {
    const synced = await this.syncCipher(current.session, record.cipherId, input.signal);
    if (!record.newAttachmentId || !findAttachmentById(synced.rawCipher, record.newAttachmentId)) return { ...synced, verified: false };
    let readHandle: string | undefined;
    try {
      const begun = await this.downloads.beginDownload({
        providerId: input.providerId,
        itemId: input.itemId,
        session: synced.session,
        rawCipher: synced.rawCipher,
        organizationKeys: input.organizationKeys,
        attachmentId: record.newAttachmentId,
        signal: input.signal
      });
      readHandle = begun.readHandle;
      const hasher = await createSHA256();
      hasher.init();
      let offset = 0;
      while (offset < begun.sizeBytes) {
        const chunk = this.downloads.readChunk(input.providerId, begun.readHandle, offset, Math.min(PROVIDER_ATTACHMENT_CHUNK_BYTES, begun.sizeBytes - offset));
        try {
          hasher.update(chunk.bytes);
          offset = chunk.nextOffset;
        } finally {
          chunk.bytes.fill(0);
        }
      }
      return { session: begun.session, rawCipher: synced.rawCipher, verified: begun.sizeBytes === input.bytes.length && hasher.digest("hex") === input.sha256 };
    } catch (cause) {
      if (isVerificationAbsence(cause)) return { ...synced, verified: false };
      throw cause;
    } finally {
      if (readHandle) this.downloads.release(input.providerId, readHandle);
    }
  }

  private async reconcileUnknownCreate(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    current: SyncedCipher,
    cause: unknown
  ): Promise<SyncedCipher> {
    let synced: SyncedCipher;
    try {
      synced = await this.syncCipher(current.session, record.cipherId, input.signal);
    } catch {
      if (cause instanceof ProviderTransportError && isDefinitiveUploadFailure(cause)) {
        await this.resetRecordToIntent(record, record.serverRevisionDate);
      }
      throw cause;
    }
    const matched = await findAttachmentByFingerprints(synced.rawCipher, record);
    if (matched) {
      if (record.oldAttachmentId && matched.id === record.oldAttachmentId) {
        throw mutationError("bitwarden-attachment-target-mismatch", "Bitwarden 返回的新附件 ID 与待替换旧附件相同，操作已停止。");
      }
      const rollingBack = await this.updateRecord(record, {
        stage: "rolling-back",
        newAttachmentId: matched.id,
        fileUploadType: 0,
        serverRevisionDate: revisionDateOf(synced.rawCipher)
      });
      await this.rollbackCreatedAttachment(input, rollingBack, synced);
      throw mutationError("bitwarden-attachment-create-recovered", "丢失响应的 Bitwarden 附件元数据已找到并回滚，请重试上传。");
    }
    if (cause instanceof ProviderTransportError && isDefinitiveUploadFailure(cause)) {
      await this.resetRecordToIntent(record, revisionDateOf(synced.rawCipher));
      throw cause;
    }
    throw mutationError("bitwarden-attachment-create-pending", "Bitwarden 附件创建响应丢失，当前同步未确认远端结果；未再次创建附件。");
  }

  private async rollbackCreatedAttachment(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    current: SyncedCipher
  ): Promise<boolean> {
    if (!record.newAttachmentId) return false;
    const newAttachmentId = record.newAttachmentId;
    if (record.stage !== "rolling-back") record = await this.updateRecord(record, { stage: "rolling-back" });
    let synced = current;
    try {
      const deleted = await this.client.deleteAttachment(synced.session, record.cipherId, newAttachmentId, input.signal);
      synced.session = deleted.session;
    } catch (cause) {
      synced = await this.syncCipher(synced.session, record.cipherId, input.signal);
      if (findAttachmentById(synced.rawCipher, newAttachmentId)) {
        if (isAuthorizationOrCancellation(cause) || isDefinitiveUploadFailure(cause)) throw cause;
        throw mutationError("bitwarden-attachment-rollback-pending", "Bitwarden 新附件回滚结果仍需确认；恢复前不会创建其他附件。");
      }
    }
    synced = await this.syncCipher(synced.session, record.cipherId, input.signal);
    if (findAttachmentById(synced.rawCipher, newAttachmentId)) {
      throw mutationError("bitwarden-attachment-rollback-pending", "Bitwarden 新附件回滚尚未在同步结果中生效。");
    }
    await this.resetRecordToIntent(record, revisionDateOf(synced.rawCipher));
    return true;
  }

  private async syncCipher(session: BitwardenSessionConfig, cipherId: string, signal?: AbortSignal): Promise<SyncedCipher> {
    const synced = await this.client.sync(session, signal);
    const ciphers = arrayValue(synced.payload, "Ciphers", "ciphers");
    const rawCipher = ciphers.map(asRecord).find((candidate) => optionalString(candidate, "Id", "id") === cipherId);
    if (!rawCipher) throw mutationError("bitwarden-cipher-not-found", "Bitwarden Cipher 不存在或已被删除。");
    revisionDateOf(rawCipher);
    return { session: synced.session, rawCipher };
  }

  private completedUploadResult(
    input: NormalizedUploadInput,
    record: BitwardenAttachmentMutationRecord,
    synced: SyncedCipher
  ): BitwardenAttachmentMutationResult {
    if (!record.newAttachmentId) throw mutationError("bitwarden-attachment-recovery-invalid", "Bitwarden 已完成操作缺少附件 ID。");
    return {
      changed: true,
      session: synced.session,
      rawCipher: synced.rawCipher,
      attachment: {
        attachmentId: record.newAttachmentId,
        providerKind: "bitwarden",
        fileName: input.fileName,
        sizeBytes: input.bytes.length,
        protected: true
      }
    };
  }

  private updateRecord(
    record: BitwardenAttachmentMutationRecord,
    patch: Partial<BitwardenAttachmentMutationRecord>
  ): Promise<BitwardenAttachmentMutationRecord> {
    return this.store.save({ ...record, ...patch, updatedAt: isoTimestamp(this.now()) }, record.revision);
  }

  private resetRecordToIntent(record: BitwardenAttachmentMutationRecord, serverRevisionDate: string): Promise<BitwardenAttachmentMutationRecord> {
    return this.updateRecord(record, {
      stage: "intent",
      newAttachmentId: undefined,
      fileUploadType: undefined,
      encryptedFileNameSha256: undefined,
      wrappedKeySha256: undefined,
      encryptedSizeBytes: undefined,
      serverRevisionDate
    });
  }

  private async ensureRecordCapacity(providerId: string): Promise<void> {
    const records = await this.store.list(providerId);
    if (records.length < MAX_MUTATION_RECORDS_PER_PROVIDER) return;
    const completed = records.filter((record) => record.stage === "completed");
    for (const record of completed) {
      await this.store.delete(providerId, record.operationId);
      if (records.length - completed.indexOf(record) - 1 < MAX_MUTATION_RECORDS_PER_PROVIDER) return;
    }
    throw mutationError("bitwarden-attachment-operation-limit", "Bitwarden 待恢复附件操作过多，请先完成现有操作。");
  }
}

export async function bitwardenAttachmentSha256(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array)) throw mutationError("bitwarden-attachment-size-invalid", "Bitwarden 附件字节无效。");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return toHex(digest);
}

async function bitwardenAttachmentTextSha256(value: string): Promise<string> {
  return bitwardenAttachmentSha256(new TextEncoder().encode(value));
}

async function encryptAttachmentPayload(
  plaintext: Uint8Array,
  key: BitwardenSymmetricKey,
  randomness: (length: number) => Uint8Array,
  maximumPlaintextBytes: number
): Promise<Uint8Array> {
  if (plaintext.length > maximumPlaintextBytes || plaintext.length > BITWARDEN_ATTACHMENT_MAX_BYTES) {
    throw mutationError("bitwarden-attachment-size-invalid", "Bitwarden 附件明文超过 100 MiB 安全上限。");
  }
  if (key.encKey.length !== 32 || key.macKey.length !== 32) throw mutationError("bitwarden-attachment-key-invalid", "Bitwarden 附件密钥长度无效。");
  const iv = randomness(ATTACHMENT_IV_BYTES);
  if (!(iv instanceof Uint8Array) || iv.length !== ATTACHMENT_IV_BYTES) {
    iv?.fill?.(0);
    throw mutationError("bitwarden-attachment-random-invalid", "Bitwarden 附件 IV 长度无效。");
  }
  let ciphertext = new Uint8Array();
  let macInput = new Uint8Array();
  let mac = new Uint8Array();
  try {
    const encryptionKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
    ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, encryptionKey, plaintext as BufferSource));
    if (!ciphertext.length || ciphertext.length % AES_BLOCK_BYTES !== 0) throw mutationError("bitwarden-attachment-encryption-failed", "Bitwarden 附件 AES-CBC 密文边界无效。");
    macInput = concatBytes(iv, ciphertext);
    const hmacKey = await crypto.subtle.importKey("raw", key.macKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, macInput as BufferSource));
    if (mac.length !== ATTACHMENT_MAC_BYTES) throw mutationError("bitwarden-attachment-encryption-failed", "Bitwarden 附件 HMAC 长度无效。");
    return concatBytes(iv, ciphertext, mac);
  } finally {
    iv.fill(0);
    ciphertext.fill(0);
    macInput.fill(0);
    mac.fill(0);
  }
}

async function findAttachmentByFingerprints(
  rawCipher: Record<string, unknown>,
  record: BitwardenAttachmentMutationRecord
): Promise<RemoteAttachment | undefined> {
  if (!record.encryptedFileNameSha256 || !record.wrappedKeySha256 || record.encryptedSizeBytes === undefined) return undefined;
  const matches: RemoteAttachment[] = [];
  for (const attachment of parseRemoteAttachments(rawCipher)) {
    if (
      attachment.encryptedSizeBytes === record.encryptedSizeBytes
      && await bitwardenAttachmentTextSha256(attachment.encryptedFileName) === record.encryptedFileNameSha256
      && attachment.wrappedKey !== undefined
      && await bitwardenAttachmentTextSha256(attachment.wrappedKey) === record.wrappedKeySha256
    ) matches.push(attachment);
  }
  if (matches.length > 1) throw mutationError("bitwarden-attachment-recovery-ambiguous", "Bitwarden 同步结果包含多个相同的附件恢复候选项。");
  return matches[0];
}

async function requireRecordAttachment(
  rawCipher: Record<string, unknown>,
  record: BitwardenAttachmentMutationRecord
): Promise<RemoteAttachment | undefined> {
  if (!record.newAttachmentId) return undefined;
  const remote = parseRemoteAttachments(rawCipher).find((attachment) => attachment.id === record.newAttachmentId);
  if (!remote) return undefined;
  if (
    await bitwardenAttachmentTextSha256(remote.encryptedFileName) !== record.encryptedFileNameSha256
    || !remote.wrappedKey
    || await bitwardenAttachmentTextSha256(remote.wrappedKey) !== record.wrappedKeySha256
    || remote.encryptedSizeBytes !== record.encryptedSizeBytes
  ) throw mutationError("bitwarden-attachment-remote-changed", "Bitwarden 附件元数据与持久恢复记录不一致。");
  return remote;
}

function parseRemoteAttachments(rawCipher: Record<string, unknown>): RemoteAttachment[] {
  const raw = value(rawCipher, "Attachments", "attachments");
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS_PER_CIPHER) throw mutationError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件元数据数量或结构无效。");
  const seen = new Set<string>();
  return raw.map((entry) => {
    const record = asRecord(entry);
    const id = optionalString(record, "Id", "id") || "";
    const encryptedFileName = optionalString(record, "FileName", "fileName") || "";
    const wrappedKey = optionalString(record, "Key", "key");
    assertOpaqueId(id, "附件");
    if (seen.has(id)) throw mutationError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件 ID 重复。");
    seen.add(id);
    if (!encryptedFileName) throw mutationError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件缺少加密名称。");
    const sizeValue = value(record, "Size", "size");
    const encryptedSizeBytes = typeof sizeValue === "string" && /^\d+$/.test(sizeValue) ? Number(sizeValue) : sizeValue;
    if (!Number.isSafeInteger(encryptedSizeBytes) || Number(encryptedSizeBytes) < 64 || Number(encryptedSizeBytes) > BITWARDEN_ATTACHMENT_MAX_BYTES + 64) {
      throw mutationError("bitwarden-attachment-metadata-invalid", "Bitwarden 附件密文大小无效。");
    }
    return { id, encryptedFileName, wrappedKey, encryptedSizeBytes: Number(encryptedSizeBytes) };
  });
}

function findAttachmentById(rawCipher: Record<string, unknown>, attachmentId: string): RemoteAttachment | undefined {
  return parseRemoteAttachments(rawCipher).find((attachment) => attachment.id === attachmentId);
}

function assertUploadRecordIntent(record: BitwardenAttachmentMutationRecord, input: NormalizedUploadInput, cipherId: string): void {
  if (
    record.providerId !== input.providerId
    || record.operationId !== input.operationId
    || record.cipherId !== cipherId
    || record.kind !== input.kind
    || record.oldAttachmentId !== input.replaceAttachmentId
    || record.plaintextSha256 !== input.sha256
    || record.fileNameSha256 !== input.fileNameSha256
    || record.plainSizeBytes !== input.bytes.length
  ) throw mutationError("bitwarden-attachment-operation-reused", "附件操作 ID 已用于其他目标、文件名或内容。");
}

function assertDeleteRecordIntent(record: BitwardenAttachmentMutationRecord, input: BitwardenAttachmentDeleteMutationInput, cipherId: string): void {
  if (
    record.providerId !== input.providerId
    || record.operationId !== input.operationId
    || record.cipherId !== cipherId
    || record.kind !== "delete"
    || record.oldAttachmentId !== input.attachmentId
  ) throw mutationError("bitwarden-attachment-operation-reused", "附件操作 ID 已用于其他删除目标。");
}

function choosePreparedCipher(
  full: Record<string, unknown> | undefined,
  mini: Record<string, unknown> | undefined,
  fallback: Record<string, unknown>,
  cipherId: string
): Record<string, unknown> {
  for (const candidate of [full, mini]) {
    if (!candidate) continue;
    const id = optionalString(candidate, "Id", "id");
    if (id && id !== cipherId) throw mutationError("bitwarden-attachment-target-mismatch", "Bitwarden 附件创建响应指向了其他 Cipher。");
    if (id === cipherId && optionalString(candidate, "RevisionDate", "revisionDate")) return candidate;
  }
  return fallback;
}

function uploadOperationFingerprint(input: NormalizedUploadInput): string {
  return `${input.kind}\0${input.providerId}\0${cipherIdOf(input.rawCipher)}\0${input.replaceAttachmentId || ""}\0${input.fileNameSha256}\0${input.sha256}\0${input.bytes.length}`;
}

function operationKey(providerId: string, operationId: string): string {
  return `${providerId}\0${operationId}`;
}

function validateContext(input: BitwardenAttachmentVaultContext): void {
  if (typeof input.providerId !== "string" || !input.providerId || typeof input.itemId !== "string" || !input.itemId) {
    throw mutationError("bitwarden-attachment-target-invalid", "Bitwarden 附件密码源或项目无效。");
  }
  cipherIdOf(input.rawCipher);
}

function validateFileName(fileName: string): void {
  const length = typeof fileName === "string" ? new TextEncoder().encode(fileName).length : 0;
  if (!fileName || length > MAX_FILE_NAME_BYTES || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw mutationError("bitwarden-attachment-name-invalid", "Bitwarden 附件文件名无效或超过 4096 个 UTF-8 字节。");
  }
}

function cipherIdOf(rawCipher: Record<string, unknown>): string {
  const id = optionalString(rawCipher, "Id", "id") || "";
  assertOpaqueId(id, "Cipher");
  return id;
}

function revisionDateOf(rawCipher: Record<string, unknown>): string {
  const revision = optionalString(rawCipher, "RevisionDate", "revisionDate") || "";
  if (!revision || revision.length > 256 || !Number.isFinite(Date.parse(revision)) || /[\u0000-\u001f\u007f]/.test(revision)) {
    throw mutationError("bitwarden-cipher-revision-invalid", "Bitwarden Cipher 缺少有效修订时间，无法安全添加附件。");
  }
  return revision;
}

function assertOperationId(value: string): void {
  if (!OPERATION_ID_PATTERN.test(value)) throw mutationError("bitwarden-attachment-operation-invalid", "Bitwarden 附件操作 ID 无效。");
}

function assertOpaqueId(value: string, label: string): void {
  const length = typeof value === "string" ? new TextEncoder().encode(value).length : 0;
  if (!value || length > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/.test(value)) throw mutationError("bitwarden-attachment-metadata-invalid", `Bitwarden ${label} ID 无效。`);
}

function validateLimits(input: BitwardenAttachmentMutationLimits): BitwardenAttachmentMutationLimits {
  if (!Number.isSafeInteger(input.maxPlaintextBytes) || input.maxPlaintextBytes < 1 || input.maxPlaintextBytes > BITWARDEN_ATTACHMENT_MAX_BYTES) {
    throw new Error("Bitwarden 附件明文安全上限无效。");
  }
  return input;
}

function azureUrlNeedsRenewal(raw: string, now: number): boolean {
  try {
    const expiry = Date.parse(new URL(raw).searchParams.get("se") || "");
    return Number.isFinite(expiry) && expiry <= now + 1_000;
  } catch {
    return true;
  }
}

function isDefinitiveUploadFailure(cause: unknown): boolean {
  return cause instanceof ProviderTransportError
    && (cause.code === "authentication" || cause.code === "permission" || cause.code === "conflict" || cause.code === "client" || cause.code === "not-found");
}

function isAuthorizationOrCancellation(cause: unknown): boolean {
  return cause instanceof ProviderTransportError && (cause.code === "authentication" || cause.code === "permission" || cause.code === "cancelled");
}

function isVerificationAbsence(cause: unknown): boolean {
  if (cause instanceof ProviderTransportError) return cause.code === "not-found";
  return cause instanceof ProviderAttachmentError && new Set([
    "attachment-not-found",
    "bitwarden-attachment-truncated",
    "bitwarden-attachment-mac-invalid",
    "bitwarden-attachment-padding-invalid"
  ]).has(cause.code);
}

function isTransientVerificationFailure(cause: unknown): boolean {
  return cause instanceof ProviderTransportError
    && (cause.code === "network" || cause.code === "timeout" || cause.code === "server" || cause.code === "rate-limited");
}

function cloneKey(key: BitwardenSymmetricKey): BitwardenSymmetricKey {
  if (key.encKey.length !== 32 || key.macKey.length !== 32) throw mutationError("bitwarden-attachment-key-invalid", "Bitwarden 附件密钥长度无效。");
  return { encKey: key.encKey.slice(), macKey: key.macKey.slice() };
}

function clearKey(key: BitwardenSymmetricKey): void {
  key.encKey.fill(0);
  key.macKey.fill(0);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw mutationError("bitwarden-attachment-metadata-invalid", "Bitwarden 响应结构无效。");
  return value as Record<string, unknown>;
}

function arrayValue(raw: Record<string, unknown>, ...names: string[]): unknown[] {
  const found = value(raw, ...names);
  if (!Array.isArray(found)) throw mutationError("bitwarden-attachment-metadata-invalid", "Bitwarden 同步响应缺少 Cipher 列表。");
  return found;
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in raw) return raw[name];
  return undefined;
}

function optionalString(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  const found = value(raw, ...names);
  return typeof found === "string" && found ? found : undefined;
}

function isoTimestamp(now: number): string {
  if (!Number.isFinite(now)) throw new Error("Bitwarden 附件时钟无效。");
  return new Date(now).toISOString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

function mutationError(code: string, message: string): ProviderAttachmentError {
  return new ProviderAttachmentError(code, message);
}
