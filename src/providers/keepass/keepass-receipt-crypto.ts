import type { ProviderAccount } from "../../core/model";
import { base64ToBytes, bytesToBase64, randomBytes } from "../../security/encoding";
import {
  KEEPASS_DURABLE_RECEIPT_MAX_PLAINTEXT_BYTES,
  type KeePassDurableMutationReceipt,
  type KeePassEncryptedMutationReceipt,
  validateKeePassDurableMutationReceipt
} from "./keepass-working-copy-store";

export const KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG = "cacheEncryptionKey";

const AAD_PREFIX = "monica-extension-keepass-receipt-v1";

export type KeePassReceiptCryptoErrorCode = "cache-key-missing" | "receipt-invalid" | "receipt-too-large";

export class KeePassReceiptCryptoError extends Error {
  constructor(readonly code: KeePassReceiptCryptoErrorCode, message: string) {
    super(message);
    this.name = "KeePassReceiptCryptoError";
  }
}

export function createKeePassCacheEncryptionKey(): string {
  const bytes = randomBytes(32);
  try {
    return bytesToBase64(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function hasKeePassCacheEncryptionKey(account: ProviderAccount): boolean {
  try {
    const bytes = cacheKeyBytes(account);
    bytes.fill(0);
    return true;
  } catch {
    return false;
  }
}

export async function sealKeePassDurableReceipt(
  account: ProviderAccount,
  input: KeePassDurableMutationReceipt
): Promise<KeePassEncryptedMutationReceipt> {
  const receipt = validateKeePassDurableMutationReceipt(input);
  if (receipt.providerId !== account.id) throw invalidReceipt();
  const rawKey = cacheKeyBytes(account);
  const plaintext = new TextEncoder().encode(JSON.stringify(receipt));
  if (!plaintext.length || plaintext.length > KEEPASS_DURABLE_RECEIPT_MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    rawKey.fill(0);
    throw new KeePassReceiptCryptoError("receipt-too-large", "KeePass 持久操作载荷超过安全上限。");
  }
  const iv = randomBytes(12);
  try {
    const intentTag = await receiptIntentTag(rawKey, receipt);
    const envelope: Omit<KeePassEncryptedMutationReceipt, "ciphertext"> = {
      version: 1,
      providerId: receipt.providerId,
      operationId: receipt.operationId,
      intentTag,
      completedAt: receipt.completedAt,
      cipher: "AES-256-GCM",
      iv: bytesToBase64(iv)
    };
    const key = await crypto.subtle.importKey("raw", rawKey as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: receiptAad(envelope) as BufferSource,
      tagLength: 128
    }, key, plaintext as BufferSource));
    return { ...envelope, ciphertext: bytesToBase64(ciphertext) };
  } catch (cause) {
    if (cause instanceof KeePassReceiptCryptoError) throw cause;
    throw invalidReceipt();
  } finally {
    rawKey.fill(0);
    plaintext.fill(0);
  }
}

export async function openKeePassDurableReceipt(
  account: ProviderAccount,
  envelope: KeePassEncryptedMutationReceipt
): Promise<KeePassDurableMutationReceipt> {
  if (envelope.providerId !== account.id) throw invalidReceipt();
  const rawKey = cacheKeyBytes(account);
  let plaintext: Uint8Array | undefined;
  try {
    const key = await crypto.subtle.importKey("raw", rawKey as BufferSource, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv) as BufferSource,
      additionalData: receiptAad(envelope) as BufferSource,
      tagLength: 128
    }, key, base64ToBytes(envelope.ciphertext) as BufferSource));
    if (!plaintext.length || plaintext.length > KEEPASS_DURABLE_RECEIPT_MAX_PLAINTEXT_BYTES) throw invalidReceipt();
    const receipt = validateKeePassDurableMutationReceipt(JSON.parse(new TextDecoder().decode(plaintext)));
    if (
      receipt.providerId !== envelope.providerId ||
      receipt.operationId !== envelope.operationId ||
      receipt.completedAt !== envelope.completedAt ||
      !constantTimeHexEqual(await receiptIntentTag(rawKey, receipt), envelope.intentTag)
    ) throw invalidReceipt();
    return receipt;
  } catch (cause) {
    if (cause instanceof KeePassReceiptCryptoError) throw cause;
    throw invalidReceipt();
  } finally {
    rawKey.fill(0);
    plaintext?.fill(0);
  }
}

function cacheKeyBytes(account: ProviderAccount): Uint8Array {
  const value = account.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG];
  if (typeof value !== "string") throw new KeePassReceiptCryptoError("cache-key-missing", "KeePass 本机缓存加密密钥不存在，请重新连接密码源。");
  try {
    const bytes = base64ToBytes(value);
    if (bytes.length !== 32) throw new Error("invalid length");
    return bytes;
  } catch {
    throw new KeePassReceiptCryptoError("cache-key-missing", "KeePass 本机缓存加密密钥无效，请重新连接密码源。");
  }
}

async function receiptIntentTag(rawKey: Uint8Array, receipt: KeePassDurableMutationReceipt): Promise<string> {
  const key = await crypto.subtle.importKey("raw", rawKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const message = new TextEncoder().encode(JSON.stringify({
    version: 1,
    providerId: receipt.providerId,
    operationId: receipt.operationId,
    kind: receipt.kind,
    intentSha256: receipt.intentSha256
  }));
  try {
    const tag = new Uint8Array(await crypto.subtle.sign("HMAC", key, message as BufferSource));
    return [...tag].map((value) => value.toString(16).padStart(2, "0")).join("");
  } finally {
    message.fill(0);
  }
}

function receiptAad(envelope: Omit<KeePassEncryptedMutationReceipt, "ciphertext"> | KeePassEncryptedMutationReceipt): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    prefix: AAD_PREFIX,
    version: envelope.version,
    providerId: envelope.providerId,
    operationId: envelope.operationId,
    intentTag: envelope.intentTag,
    completedAt: envelope.completedAt,
    cipher: envelope.cipher
  }));
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function invalidReceipt(): KeePassReceiptCryptoError {
  return new KeePassReceiptCryptoError("receipt-invalid", "KeePass 持久操作回执无效或已损坏。");
}
