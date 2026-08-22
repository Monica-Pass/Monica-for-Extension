import { bytesToBase64 } from "../../security/encoding";
import { ProviderTransportError } from "../provider-transport";
import {
  BITWARDEN_SEND_KEY_BYTES,
  decryptBitwardenBytes,
  decryptBitwardenString,
  deriveBitwardenSendKey,
  encryptBitwardenBytes,
  encryptBitwardenString,
  generateBitwardenSendKeyMaterial,
  hashBitwardenSendPassword,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";
import {
  BitwardenClient,
  type BitwardenFileUploadType,
  type BitwardenSessionConfig,
  type BitwardenSendFileUploadInfo
} from "./bitwarden-client";

export type BitwardenSendType = "text" | "file" | "unsupported";
export type BitwardenSendAuthMode = "none" | "password" | "email" | "unknown";

export interface BitwardenSendSummary {
  providerId: string;
  sendId: string;
  type: BitwardenSendType;
  name: string;
  notes: string;
  accessId: string;
  shareUrl: string;
  accessCount: number;
  maxAccessCount?: number;
  authMode: BitwardenSendAuthMode;
  hasPassword: boolean;
  disabled: boolean;
  hideEmail: boolean;
  textHidden?: boolean;
  fileName?: string;
  fileSizeBytes?: number;
  revisionDate: string;
  expirationDate?: string;
  deletionDate?: string;
  editable: boolean;
  warning?: string;
}

export interface BitwardenSendDetail extends BitwardenSendSummary {
  textContent?: string;
}

export interface BitwardenSendPage {
  items: BitwardenSendSummary[];
  nextCursor?: string;
  total: number;
}

export interface BitwardenSendTextInput {
  name: string;
  text: string;
  notes?: string;
  password?: string;
  maxAccessCount?: number;
  hideEmail?: boolean;
  hiddenText?: boolean;
  disabled?: boolean;
  deletionDate: string;
  expirationDate?: string;
}

export interface BitwardenSendFileInput {
  name: string;
  fileName: string;
  bytes: Uint8Array;
  notes?: string;
  password?: string;
  maxAccessCount?: number;
  hideEmail?: boolean;
  disabled?: boolean;
  deletionDate: string;
  expirationDate?: string;
  operationId?: string;
}

export type BitwardenSendPasswordAction = "preserve" | "set" | "remove";

export interface BitwardenSendUpdateInput {
  sendId: string;
  expectedRevision: string;
  name: string;
  notes?: string;
  text?: string;
  hiddenText?: boolean;
  passwordAction?: BitwardenSendPasswordAction;
  password?: string;
  maxAccessCount?: number;
  hideEmail?: boolean;
  disabled?: boolean;
  deletionDate: string;
  expirationDate?: string;
}

export interface BitwardenSendServiceOptions {
  client?: BitwardenClient;
  randomness?: (length: number) => Uint8Array;
  now?: () => number;
}

export class BitwardenSendError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BitwardenSendError";
  }
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_SENDS = 1_000;
const MAX_NAME_BYTES = 512;
const MAX_NOTES_BYTES = 512;
const MAX_TEXT_BYTES = 350_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FILE_IV_BYTES = 16;
const FILE_MAC_BYTES = 32;
const FILE_BLOCK_BYTES = 16;
const FILE_ENCRYPTION_TYPE = 2;
const SEND_RESPONSE_ONLY = new Set([
  "id", "accessid", "accesscount", "revisiondate", "urlb64key", "createdat", "updatedat"
]);

export class BitwardenSendService {
  private readonly client: BitwardenClient;
  private readonly randomness: (length: number) => Uint8Array;
  private readonly now: () => number;

  constructor(clientOrOptions: BitwardenClient | BitwardenSendServiceOptions = {}, options: BitwardenSendServiceOptions = {}) {
    if (clientOrOptions instanceof BitwardenClient) {
      this.client = clientOrOptions;
      this.randomness = options.randomness || defaultRandomness;
      this.now = options.now || Date.now;
    } else {
      this.client = clientOrOptions.client || new BitwardenClient();
      this.randomness = clientOrOptions.randomness || defaultRandomness;
      this.now = clientOrOptions.now || Date.now;
    }
  }

  async list(
    session: BitwardenSessionConfig,
    providerId: string,
    input: { pageSize?: number; cursor?: string } = {},
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; page: BitwardenSendPage }> {
    assertProviderId(providerId);
    const pageSize = clampPageSize(input.pageSize);
    const start = parseCursor(input.cursor);
    const result = await this.client.listSends(session, signal);
    const vaultKey = this.client.vaultKey(result.session);
    try {
      const rawSends = recordsFromPayload(result.payload);
      if (rawSends.length > MAX_SENDS) throw new BitwardenSendError("send-list-too-large", "Bitwarden Send 数量超过安全上限。");
      const items = await Promise.all(rawSends.map((raw) => this.decodeSummarySafe(raw, providerId, result.session, vaultKey)));
      const pageItems = items.slice(start, start + pageSize);
      return {
        session: result.session,
        page: { items: pageItems, total: items.length, ...(start + pageItems.length < items.length ? { nextCursor: String(start + pageItems.length) } : {}) }
      };
    } finally {
      clearKey(vaultKey);
    }
  }

  async get(
    session: BitwardenSessionConfig,
    providerId: string,
    sendId: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; send: BitwardenSendDetail }> {
    assertProviderId(providerId);
    assertSendId(sendId);
    const result = await this.client.getSend(session, sendId, signal);
    const raw = unwrapSendRecord(result.payload);
    const vaultKey = this.client.vaultKey(result.session);
    try {
      return { session: result.session, send: await this.decodeDetail(raw, providerId, result.session, vaultKey) };
    } finally {
      clearKey(vaultKey);
    }
  }

  async createText(
    session: BitwardenSessionConfig,
    providerId: string,
    input: BitwardenSendTextInput,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; send: BitwardenSendDetail }> {
    assertProviderId(providerId);
    const normalized = validateTextInput(input, this.now());
    const vaultKey = this.client.vaultKey(session);
    let seed: Uint8Array | undefined;
    let sendKey: BitwardenSymmetricKey | undefined;
    try {
      seed = generateBitwardenSendKeyMaterial(this.randomness);
      sendKey = await deriveBitwardenSendKey(seed);
      const request = await buildTextRequest(normalized, seed, sendKey, vaultKey);
      const created = await this.client.createSend(session, request, signal);
      const raw = unwrapSendRecord(created.payload);
      const send = await this.decodeDetail(raw, providerId, created.session, vaultKey);
      return { session: created.session, send };
    } finally {
      clearKey(sendKey);
      seed?.fill(0);
      clearKey(vaultKey);
    }
  }

  async createFile(
    session: BitwardenSessionConfig,
    providerId: string,
    input: BitwardenSendFileInput,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; send: BitwardenSendDetail }> {
    assertProviderId(providerId);
    const normalized = validateFileInput(input, this.now());
    const vaultKey = this.client.vaultKey(session);
    let seed: Uint8Array | undefined;
    let sendKey: BitwardenSymmetricKey | undefined;
    let encryptedBytes: Uint8Array | undefined;
    let createdId: string | undefined;
    try {
      seed = generateBitwardenSendKeyMaterial(this.randomness);
      sendKey = await deriveBitwardenSendKey(seed);
      encryptedBytes = await encryptSendFileData(normalized.bytes, sendKey, this.randomness);
      const request = await buildFileRequest(normalized, seed, sendKey, vaultKey, encryptedBytes.length);
      const created = await this.client.createFileSend(session, request, signal);
      const upload = created.upload;
      const sendRaw = unwrapSendRecord(upload.sendResponse);
      createdId = stringValue(sendRaw, "Id", "id");
      const fileId = recordValue(sendRaw, "File", "file") ? stringValue(recordValue(sendRaw, "File", "file")!, "Id", "id") : "";
      if (!createdId || !fileId) throw new BitwardenSendError("send-file-response-invalid", "Bitwarden 文件 Send 响应缺少标识。");
      let activeSession = created.session;
      try {
        activeSession = await this.uploadFile(activeSession, createdId, fileId, stringValue(recordValue(sendRaw, "File", "file")!, "FileName", "fileName"), encryptedBytes, upload, signal);
      } catch (cause) {
        await this.client.deleteSend(activeSession, createdId, signal).catch(() => undefined);
        throw new BitwardenSendError("send-file-upload-failed", cause instanceof Error ? cause.message : "Bitwarden 文件 Send 上传失败。");
      }
      const verified = await this.client.getSend(activeSession, createdId, signal);
      const finalRaw = unwrapSendRecord(verified.payload);
      const send = await this.decodeDetail(finalRaw, providerId, verified.session, vaultKey);
      return { session: verified.session, send };
    } finally {
      clearKey(sendKey);
      seed?.fill(0);
      encryptedBytes?.fill(0);
      clearKey(vaultKey);
    }
  }

  async update(
    session: BitwardenSessionConfig,
    providerId: string,
    input: BitwardenSendUpdateInput,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; send: BitwardenSendDetail }> {
    assertProviderId(providerId);
    validateUpdateInput(input, this.now());
    const rawResult = await this.client.getSend(session, input.sendId, signal);
    const raw = unwrapSendRecord(rawResult.payload);
    const vaultKey = this.client.vaultKey(rawResult.session);
    let seed: Uint8Array | undefined;
    let sendKey: BitwardenSymmetricKey | undefined;
    try {
      const current = await this.decodeDetail(raw, providerId, rawResult.session, vaultKey);
      if (current.revisionDate !== input.expectedRevision) throw new BitwardenSendError("send-conflict", "Bitwarden Send 已在其他设备修改，请刷新后再保存。");
      if (!current.editable) throw new BitwardenSendError("send-not-editable", current.warning || "当前 Send 类型或验证方式暂不支持编辑。");
      if (current.authMode === "email") throw new BitwardenSendError("send-email-auth-unsupported", "邮箱验证 Send 暂时只支持查看、复制链接和删除。");
      if (current.type === "unsupported") throw new BitwardenSendError("send-type-unsupported", "当前 Send 类型无法由浏览器安全编辑。");
      // Existing Sends can legitimately carry an already-expired deletion
      // date. Allow a content-only edit to preserve that remote policy; any
      // policy change still has to satisfy the normal future-date limits.
      const currentExpiration = current.expirationDate || undefined;
      if (input.deletionDate !== current.deletionDate || input.expirationDate !== currentExpiration) {
        validatePolicyDates(input.deletionDate, input.expirationDate, this.now());
      }
      seed = await decryptSendSeed(raw, vaultKey);
      sendKey = await deriveBitwardenSendKey(seed);
      const action = input.passwordAction || "preserve";
      if (action === "set" && current.hasPassword) throw new BitwardenSendError("send-password-change-requires-removal", "现有 Send 已有密码，请先移除旧密码，再设置新密码。");
      const request = current.type === "text"
        ? await buildTextUpdateRequest(raw, input, action, seed, sendKey)
        : await buildFileUpdateRequest(raw, input, action, seed, sendKey);
      const updated = await this.client.updateSend(rawResult.session, input.sendId, request, signal);
      let finalSession = updated.session;
      let finalPayload = mergeSendProjection(mergeSendProjection(raw, request), unwrapSendRecord(updated.payload));
      if (action === "remove" && current.hasPassword) {
        const removed = await this.client.removeSendPassword(finalSession, input.sendId, signal);
        finalSession = removed.session;
        finalPayload = mergeSendProjection(finalPayload, unwrapSendRecord(removed.payload));
      }
      const finalRevision = stringValue(finalPayload, "RevisionDate", "revisionDate");
      if (!finalRevision || !Number.isFinite(Date.parse(finalRevision))) throw new BitwardenSendError("send-response-invalid", "Bitwarden Send 更新响应缺少可验证修订时间。");
      const send = await this.decodeDetail(finalPayload, providerId, finalSession, vaultKey);
      return { session: finalSession, send };
    } finally {
      clearKey(sendKey);
      seed?.fill(0);
      clearKey(vaultKey);
    }
  }

  async removePassword(
    session: BitwardenSessionConfig,
    providerId: string,
    sendId: string,
    expectedRevision?: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; send: BitwardenSendDetail }> {
    assertProviderId(providerId);
    assertSendId(sendId);
    const before = await this.client.getSend(session, sendId, signal);
    const beforeRaw = unwrapSendRecord(before.payload);
    const beforeKey = this.client.vaultKey(before.session);
    try {
      const current = await this.decodeDetail(beforeRaw, providerId, before.session, beforeKey);
      if (expectedRevision && current.revisionDate !== expectedRevision) throw new BitwardenSendError("send-conflict", "Bitwarden Send 已在其他设备修改，请刷新后再操作。");
      if (!current.hasPassword) return { session: before.session, send: current };
    } finally {
      clearKey(beforeKey);
    }
    const removed = await this.client.removeSendPassword(before.session, sendId, signal);
    const fresh = await this.client.getSend(removed.session, sendId, signal);
    const raw = mergeSendProjection(beforeRaw, unwrapSendRecord(fresh.payload));
    const key = this.client.vaultKey(fresh.session);
    try {
      return { session: fresh.session, send: await this.decodeDetail(raw, providerId, fresh.session, key) };
    } finally {
      clearKey(key);
    }
  }

  async remove(
    session: BitwardenSessionConfig,
    providerId: string,
    sendId: string,
    expectedRevision?: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; deleted: boolean }> {
    const current = await this.get(session, providerId, sendId, signal).catch((cause) => {
      if (cause instanceof ProviderTransportError && cause.status === 404) return undefined;
      throw cause;
    });
    if (!current) return { session, deleted: false };
    if (expectedRevision && current.send.revisionDate !== expectedRevision) throw new BitwardenSendError("send-conflict", "Bitwarden Send 已在其他设备修改，请刷新后再删除。");
    const result = await this.client.deleteSend(current.session, sendId, signal);
    return { session: result.session, deleted: !result.alreadyAbsent };
  }

  private async uploadFile(
    session: BitwardenSessionConfig,
    sendId: string,
    fileId: string,
    encryptedFileName: string,
    encryptedBytes: Uint8Array,
    upload: BitwardenSendFileUploadInfo,
    signal?: AbortSignal
  ): Promise<BitwardenSessionConfig> {
    if (upload.fileUploadType === 0) return this.client.uploadSendFileDirect(session, sendId, fileId, encryptedFileName, encryptedBytes, signal);
    try {
      await this.client.uploadSendFileAzure(upload.url || "", encryptedBytes, signal);
      return session;
    } catch (cause) {
      if (!(cause instanceof ProviderTransportError) || (cause.status !== 401 && cause.status !== 403)) throw cause;
      const renewed = await this.client.renewSendFileUploadUrl(session, sendId, fileId, signal);
      if (renewed.fileUploadType === 0) return this.client.uploadSendFileDirect(renewed.session, sendId, fileId, encryptedFileName, encryptedBytes, signal);
      await this.client.uploadSendFileAzure(renewed.url || "", encryptedBytes, signal);
      return renewed.session;
    }
  }

  private async decodeSummarySafe(raw: Record<string, unknown>, providerId: string, session: BitwardenSessionConfig, vaultKey: BitwardenSymmetricKey): Promise<BitwardenSendSummary> {
    try {
      return await this.decodeSummary(raw, providerId, session, vaultKey, false);
    } catch (cause) {
      const sendId = stringValue(raw, "Id", "id") || "unknown";
      return {
        providerId,
        sendId,
        type: typeOfSend(numberValue(raw, "Type", "type")),
        name: "（无法解密）",
        notes: "",
        accessId: stringValue(raw, "AccessId", "accessId"),
        shareUrl: "",
        accessCount: numberValue(raw, "AccessCount", "accessCount"),
        maxAccessCount: optionalPositiveInteger(raw, "MaxAccessCount", "maxAccessCount"),
        authMode: authModeOf(raw),
        hasPassword: Boolean(stringValue(raw, "Password", "password")),
        disabled: BooleanValue(raw, "Disabled", "disabled"),
        hideEmail: BooleanValue(raw, "HideEmail", "hideEmail"),
        revisionDate: validDateOrEmpty(value(raw, "RevisionDate", "revisionDate")),
        expirationDate: optionalDate(raw, "ExpirationDate", "expirationDate"),
        deletionDate: optionalDate(raw, "DeletionDate", "deletionDate"),
        editable: false,
        warning: cause instanceof Error ? "Send 密钥或字段无法解密，已停止编辑并保留远端记录。" : "Send 无法解密，已停止编辑并保留远端记录。"
      };
    }
  }

  private async decodeDetail(raw: Record<string, unknown>, providerId: string, session: BitwardenSessionConfig, vaultKey: BitwardenSymmetricKey): Promise<BitwardenSendDetail> {
    return this.decodeSummary(raw, providerId, session, vaultKey, true) as Promise<BitwardenSendDetail>;
  }

  private async decodeSummary(raw: Record<string, unknown>, providerId: string, session: BitwardenSessionConfig, vaultKey: BitwardenSymmetricKey, includeText: boolean): Promise<BitwardenSendDetail> {
    const sendId = stringValue(raw, "Id", "id");
    if (!sendId) throw new BitwardenSendError("send-id-invalid", "Bitwarden Send 响应缺少 ID。");
    const typeNumber = numberValue(raw, "Type", "type");
    const type = typeOfSend(typeNumber);
    const seed = await decryptSendSeed(raw, vaultKey);
    const sendKey = await deriveBitwardenSendKey(seed);
    try {
      const name = await decryptBitwardenString(stringValue(raw, "Name", "name"), sendKey);
      const notes = await decryptBitwardenString(stringValue(raw, "Notes", "notes"), sendKey);
      const file = recordValue(raw, "File", "file");
      const text = recordValue(raw, "Text", "text");
      const fileNameCipher = file ? stringValue(file, "FileName", "fileName") : "";
      const fileName = fileNameCipher ? await decryptBitwardenString(fileNameCipher, sendKey) : undefined;
      const textContent = type === "text" && includeText
        ? await decryptBitwardenString(text ? stringValue(text, "Text", "text") : "", sendKey)
        : undefined;
      const accessId = stringValue(raw, "AccessId", "accessId");
      const revisionDate = validDateOrEmpty(value(raw, "RevisionDate", "revisionDate"));
      const authMode = authModeOf(raw);
      const editable = (type === "text" || type === "file") && (authMode === "none" || authMode === "password") && Boolean(revisionDate);
      const detail: BitwardenSendDetail = {
        providerId,
        sendId,
        type,
        name: name || "未命名 Send",
        notes,
        accessId,
        shareUrl: buildShareUrl(session.vaultUrl, accessId, seed, stringValue(raw, "UrlB64Key", "urlB64Key")),
        accessCount: numberValue(raw, "AccessCount", "accessCount"),
        maxAccessCount: optionalPositiveInteger(raw, "MaxAccessCount", "maxAccessCount"),
        authMode,
        hasPassword: authMode === "password" || Boolean(stringValue(raw, "Password", "password")),
        disabled: BooleanValue(raw, "Disabled", "disabled"),
        hideEmail: BooleanValue(raw, "HideEmail", "hideEmail"),
        textHidden: text ? BooleanValue(text, "Hidden", "hidden") : undefined,
        fileName: fileName || undefined,
        fileSizeBytes: file ? parseFileSize(value(file, "Size", "size")) : undefined,
        revisionDate,
        expirationDate: optionalDate(raw, "ExpirationDate", "expirationDate"),
        deletionDate: optionalDate(raw, "DeletionDate", "deletionDate"),
        editable,
        ...(type === "unsupported" ? { warning: `Bitwarden Send 类型 ${typeNumber} 暂不支持编辑，原始远端记录保持不变。` } : {}),
        ...(authMode === "email" ? { warning: "邮箱验证 Send 暂时只支持查看、复制链接和删除。" } : {}),
        ...(includeText && textContent !== undefined ? { textContent } : {})
      };
      return detail;
    } finally {
      clearKey(sendKey);
      seed.fill(0);
    }
  }
}

async function buildTextRequest(input: BitwardenSendTextInput, seed: Uint8Array, sendKey: BitwardenSymmetricKey, vaultKey: BitwardenSymmetricKey): Promise<Record<string, unknown>> {
  return {
    key: await encryptBitwardenBytes(seed, vaultKey),
    type: 0,
    name: await encryptBitwardenString(input.name, sendKey),
    notes: input.notes ? await encryptBitwardenString(input.notes, sendKey) : null,
    password: input.password ? await hashBitwardenSendPassword(input.password, seed) : null,
    authType: input.password ? 1 : 2,
    disabled: Boolean(input.disabled),
    hideEmail: Boolean(input.hideEmail),
    deletionDate: input.deletionDate,
    expirationDate: input.expirationDate || null,
    maxAccessCount: input.maxAccessCount ?? null,
    text: { text: await encryptBitwardenString(input.text, sendKey), hidden: Boolean(input.hiddenText) }
  };
}

async function buildFileRequest(input: BitwardenSendFileInput, seed: Uint8Array, sendKey: BitwardenSymmetricKey, vaultKey: BitwardenSymmetricKey, encryptedLength: number): Promise<Record<string, unknown>> {
  return {
    key: await encryptBitwardenBytes(seed, vaultKey),
    type: 1,
    fileLength: encryptedLength,
    name: await encryptBitwardenString(input.name, sendKey),
    notes: input.notes ? await encryptBitwardenString(input.notes, sendKey) : null,
    password: input.password ? await hashBitwardenSendPassword(input.password, seed) : null,
    authType: input.password ? 1 : 2,
    disabled: Boolean(input.disabled),
    hideEmail: Boolean(input.hideEmail),
    deletionDate: input.deletionDate,
    expirationDate: input.expirationDate || null,
    maxAccessCount: input.maxAccessCount ?? null,
    file: { fileName: await encryptBitwardenString(input.fileName, sendKey) }
  };
}

async function buildTextUpdateRequest(raw: Record<string, unknown>, input: BitwardenSendUpdateInput, action: BitwardenSendPasswordAction, seed: Uint8Array, sendKey: BitwardenSymmetricKey): Promise<Record<string, unknown>> {
  const request = requestProjection(raw);
  const existingText = lowerCaseRecord(recordValue(raw, "Text", "text") || {});
  request.type = 0;
  request.key = stringValue(raw, "Key", "key");
  request.name = await encryptBitwardenString(input.name.trim(), sendKey);
  request.notes = input.notes === undefined
    ? value(raw, "Notes", "notes") ?? null
    : input.notes.trim() ? await encryptBitwardenString(input.notes.trim(), sendKey) : null;
  request.disabled = input.disabled ?? BooleanValue(raw, "Disabled", "disabled");
  request.hideEmail = input.hideEmail ?? BooleanValue(raw, "HideEmail", "hideEmail");
  request.deletionDate = input.deletionDate;
  request.expirationDate = input.expirationDate || null;
  request.maxAccessCount = input.maxAccessCount ?? null;
  applyPasswordPolicy(request, raw, action, seed, input.password);
  request.text = {
    ...existingText,
    text: input.text === undefined ? existingText.text : await encryptBitwardenString(input.text, sendKey),
    hidden: input.hiddenText ?? BooleanValue(existingText, "hidden", "Hidden")
  };
  return request;
}

async function buildFileUpdateRequest(raw: Record<string, unknown>, input: BitwardenSendUpdateInput, action: BitwardenSendPasswordAction, seed: Uint8Array, sendKey: BitwardenSymmetricKey): Promise<Record<string, unknown>> {
  const request = requestProjection(raw);
  request.type = 1;
  request.key = stringValue(raw, "Key", "key");
  request.name = await encryptBitwardenString(input.name.trim(), sendKey);
  request.notes = input.notes === undefined
    ? value(raw, "Notes", "notes") ?? null
    : input.notes.trim() ? await encryptBitwardenString(input.notes.trim(), sendKey) : null;
  request.disabled = input.disabled ?? BooleanValue(raw, "Disabled", "disabled");
  request.hideEmail = input.hideEmail ?? BooleanValue(raw, "HideEmail", "hideEmail");
  request.deletionDate = input.deletionDate;
  request.expirationDate = input.expirationDate || null;
  request.maxAccessCount = input.maxAccessCount ?? null;
  applyPasswordPolicy(request, raw, action, seed, input.password);
  request.file = lowerCaseRecord(recordValue(raw, "File", "file") || {});
  return request;
}

async function applyPasswordPolicy(
  request: Record<string, unknown>,
  raw: Record<string, unknown>,
  action: BitwardenSendPasswordAction,
  seed: Uint8Array,
  password?: string
): Promise<void> {
  if (action === "set") {
    request.authType = 1;
    request.password = await hashBitwardenSendPassword(password || "", seed);
    request.emails = null;
    return;
  }
  request.authType = authTypeNumber(raw);
  request.password = value(raw, "Password", "password") ?? null;
  request.emails = value(raw, "Emails", "emails") ?? null;
}

async function encryptSendFileData(plaintext: Uint8Array, key: BitwardenSymmetricKey, randomness: (length: number) => Uint8Array): Promise<Uint8Array> {
  if (!(plaintext instanceof Uint8Array) || plaintext.length > MAX_FILE_BYTES) throw new BitwardenSendError("send-file-too-large", "Bitwarden Send 文件超过 100 MiB 上限。");
  if (key.encKey.length !== 32 || key.macKey.length !== 32) throw new BitwardenSendError("send-file-key-invalid", "Bitwarden Send 文件密钥无效。");
  const iv = randomness(FILE_IV_BYTES);
  if (!(iv instanceof Uint8Array) || iv.length !== FILE_IV_BYTES) throw new BitwardenSendError("send-file-random-invalid", "Bitwarden Send 文件 IV 无效。");
  let ciphertext: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let macInput: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let mac: Uint8Array<ArrayBufferLike> = new Uint8Array();
  try {
    const encryptionKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
    ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, encryptionKey, plaintext as BufferSource));
    if (!ciphertext.length || ciphertext.length % FILE_BLOCK_BYTES !== 0) throw new BitwardenSendError("send-file-encryption-invalid", "Bitwarden Send 文件密文边界无效。");
    macInput = concatBytes(iv, ciphertext);
    const macKey = await crypto.subtle.importKey("raw", key.macKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    mac = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, macInput as BufferSource));
    return concatBytes(Uint8Array.of(FILE_ENCRYPTION_TYPE), iv, mac, ciphertext);
  } finally {
    iv.fill(0);
    ciphertext.fill(0);
    macInput.fill(0);
    mac.fill(0);
  }
}

async function decryptSendSeed(raw: Record<string, unknown>, vaultKey: BitwardenSymmetricKey): Promise<Uint8Array> {
  const wrapped = stringValue(raw, "Key", "key");
  if (!wrapped) throw new BitwardenSendError("send-key-missing", "Bitwarden Send 响应缺少加密密钥。");
  const bytes = await decryptBitwardenBytes(wrapped, vaultKey);
  if (bytes.length === BITWARDEN_SEND_KEY_BYTES) return bytes;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    const decoded = Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
    if (decoded.length === BITWARDEN_SEND_KEY_BYTES) return decoded;
  } finally {
    bytes.fill(0);
  }
  throw new BitwardenSendError("send-key-invalid", "Bitwarden Send 加密密钥长度无效。");
}

function recordsFromPayload(payload: Record<string, unknown>): Record<string, unknown>[] {
  for (const name of ["Data", "data", "Sends", "sends"]) {
    const value = payload[name];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      for (const nested of ["Data", "data", "Sends", "sends"]) if (Array.isArray(value[nested])) return (value[nested] as unknown[]).filter(isRecord);
    }
  }
  return stringValue(payload, "Id", "id") ? [payload] : [];
}

function unwrapSendRecord(payload: Record<string, unknown>): Record<string, unknown> {
  if (stringValue(payload, "Id", "id")) return payload;
  for (const name of ["SendResponse", "sendResponse", "Send", "send", "Data", "data"]) if (isRecord(payload[name])) return payload[name] as Record<string, unknown>;
  return payload;
}

function mergeSendProjection(original: Record<string, unknown>, response: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...original };
  for (const [name, nextValue] of Object.entries(response)) {
    const matchingNames = Object.keys(merged).filter((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const previousValue = matchingNames.map((candidate) => merged[candidate]).find((candidate) => candidate !== undefined);
    for (const matchingName of matchingNames) delete merged[matchingName];
    merged[name] = isRecord(previousValue) && isRecord(nextValue)
      ? mergeSendProjection(previousValue, nextValue)
      : nextValue;
  }
  return merged;
}

function requestProjection(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw)
    .filter(([name]) => !SEND_RESPONSE_ONLY.has(name.toLowerCase()))
    .map(([name, value]) => [lowerFirst(name), value]));
}

function lowerCaseRecord(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [lowerFirst(name), value]));
}

function typeOfSend(value: number): BitwardenSendType {
  if (value === 0) return "text";
  if (value === 1) return "file";
  return "unsupported";
}

function authModeOf(raw: Record<string, unknown>): BitwardenSendAuthMode {
  const authType = value(raw, "AuthType", "authType");
  const parsedAuthType = typeof authType === "number" && Number.isSafeInteger(authType)
    ? authType
    : typeof authType === "string" && /^\d+$/.test(authType.trim()) ? Number(authType) : undefined;
  if (parsedAuthType !== undefined) return parsedAuthType === 0 ? "email" : parsedAuthType === 1 ? "password" : parsedAuthType === 2 ? "none" : "unknown";
  const emails = value(raw, "Emails", "emails");
  if ((Array.isArray(emails) && emails.length > 0) || (typeof emails === "string" && emails.trim()) || isRecord(emails)) return "email";
  if (stringValue(raw, "Password", "password")) return "password";
  return "none";
}

function authTypeNumber(raw: Record<string, unknown>): number {
  const mode = authModeOf(raw);
  return mode === "password" ? 1 : mode === "email" ? 0 : 2;
}

function buildShareUrl(serverUrl: string, accessId: string, seed: Uint8Array, urlB64Key: string): string {
  const lower = serverUrl.toLowerCase();
  const base = lower.includes("bitwarden.eu") ? "https://send.bitwarden.eu/#/send/"
    : lower.includes("bitwarden.com") ? "https://send.bitwarden.com/#/send/"
      : `${serverUrl.replace(/\/$/, "")}/#/send/`;
  const key = urlB64Key || bytesToBase64(seed).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${base}${accessId ? `${accessId}/` : ""}${key}`;
}

function validateTextInput(input: BitwardenSendTextInput, now: number): BitwardenSendTextInput {
  const name = requireText(input.name, "Send 标题", MAX_NAME_BYTES);
  const text = requireText(input.text, "Send 内容", MAX_TEXT_BYTES);
  const notes = optionalText(input.notes, "Send 备注", MAX_NOTES_BYTES);
  validatePolicyDates(input.deletionDate, input.expirationDate, now);
  validateAccessCount(input.maxAccessCount);
  if (input.password !== undefined && input.password !== "") requireText(input.password, "Send 访问密码", 512);
  return { ...input, name, text, notes, deletionDate: normalizeIso(input.deletionDate), expirationDate: input.expirationDate ? normalizeIso(input.expirationDate) : undefined };
}

function validateFileInput(input: BitwardenSendFileInput, now: number): BitwardenSendFileInput {
  const name = requireText(input.name, "Send 标题", MAX_NAME_BYTES);
  const fileName = requireText(input.fileName, "Send 文件名", 4096);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length > MAX_FILE_BYTES) throw new BitwardenSendError("send-file-too-large", "Bitwarden Send 文件超过 100 MiB 上限。");
  validatePolicyDates(input.deletionDate, input.expirationDate, now);
  validateAccessCount(input.maxAccessCount);
  if (input.password !== undefined && input.password !== "") requireText(input.password, "Send 访问密码", 512);
  return { ...input, name, fileName, notes: optionalText(input.notes, "Send 备注", MAX_NOTES_BYTES), deletionDate: normalizeIso(input.deletionDate), expirationDate: input.expirationDate ? normalizeIso(input.expirationDate) : undefined };
}

function validateUpdateInput(input: BitwardenSendUpdateInput, now: number): void {
  assertSendId(input.sendId);
  if (!input.expectedRevision || !Number.isFinite(Date.parse(input.expectedRevision))) throw new BitwardenSendError("send-revision-invalid", "Bitwarden Send 缺少可验证修订时间。");
  requireText(input.name, "Send 标题", MAX_NAME_BYTES);
  optionalText(input.notes, "Send 备注", MAX_NOTES_BYTES);
  if (input.text !== undefined) requireText(input.text, "Send 内容", MAX_TEXT_BYTES);
  validateAccessCount(input.maxAccessCount);
  if (input.passwordAction === "set") requireText(input.password || "", "Send 访问密码", 512);
}

function validatePolicyDates(deletionDate: string, expirationDate: string | undefined, now: number): void {
  const deletion = Date.parse(deletionDate);
  if (!Number.isFinite(deletion) || deletion <= now + 60_000 || deletion > now + 31 * 24 * 60 * 60 * 1_000) throw new BitwardenSendError("send-deletion-date-invalid", "Send 删除日期必须在当前时间之后且不超过 31 天。");
  if (expirationDate) {
    const expiration = Date.parse(expirationDate);
    if (!Number.isFinite(expiration) || expiration <= now + 60_000 || expiration > deletion) throw new BitwardenSendError("send-expiration-date-invalid", "Send 到期日期必须晚于当前时间且早于删除日期。");
  }
}

function validateAccessCount(value?: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new BitwardenSendError("send-access-count-invalid", "Send 访问次数上限必须是正整数。");
}

function requireText(value: string, label: string, maxBytes: number): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new BitwardenSendError("send-field-required", `${label}不能为空。`);
  if (new TextEncoder().encode(normalized).byteLength > maxBytes) throw new BitwardenSendError("send-field-too-long", `${label}超过安全长度上限。`);
  return normalized;
}

function optionalText(value: string | undefined, label: string, maxBytes: number): string | undefined {
  if (value === undefined || !String(value).trim()) return undefined;
  return requireText(value, label, maxBytes);
}

function normalizeIso(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new BitwardenSendError("send-date-invalid", "Send 日期格式无效。");
  return new Date(time).toISOString();
}

function parseFileSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalPositiveInteger(raw: Record<string, unknown>, ...names: string[]): number | undefined {
  const value = numberValue(raw, ...names);
  return value > 0 ? value : undefined;
}

function optionalDate(raw: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = stringValue(raw, ...names);
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function validDateOrEmpty(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}

function numberValue(raw: Record<string, unknown>, ...names: string[]): number {
  for (const name of names) {
    if (typeof raw[name] === "number" && Number.isFinite(raw[name])) return Math.floor(raw[name] as number);
    if (typeof raw[name] === "string" && /^-?\d+$/.test((raw[name] as string).trim())) return Number(raw[name]);
  }
  return 0;
}

function BooleanValue(raw: Record<string, unknown>, ...names: string[]): boolean {
  for (const name of names) if (typeof raw[name] === "boolean") return raw[name] as boolean;
  return false;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof raw[name] === "string") return raw[name] as string;
  return "";
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (Object.prototype.hasOwnProperty.call(raw, name)) return raw[name];
  return undefined;
}

function recordValue(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  for (const name of names) if (isRecord(raw[name])) return raw[name] as Record<string, unknown>;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lowerFirst(value: string): string {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function assertProviderId(value: string): void {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new BitwardenSendError("send-provider-invalid", "Bitwarden Send 密码源标识无效。");
}

function assertSendId(value: string): void {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new BitwardenSendError("send-id-invalid", "Bitwarden Send 标识无效。");
}

function clampPageSize(value?: number): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new BitwardenSendError("send-page-invalid", "Bitwarden Send 分页大小无效。");
  return value;
}

function parseCursor(value?: string): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,9}$/.test(value)) throw new BitwardenSendError("send-cursor-invalid", "Bitwarden Send 分页游标无效。");
  return Number(value);
}

function defaultRandomness(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function clearKey(key: BitwardenSymmetricKey | undefined): void {
  key?.encKey.fill(0);
  key?.macKey.fill(0);
}

function concatBytes(...parts: Uint8Array<ArrayBufferLike>[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
