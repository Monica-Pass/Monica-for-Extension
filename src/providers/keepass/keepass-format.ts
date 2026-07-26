import { bytesToBase64 } from "../../security/encoding";

/**
 * Pre-flight inspection of a `.kdbx` file, done on the raw bytes before kdbxweb ever touches them.
 *
 * kdbxweb reports an unsupported cipher as a generic `Unsupported` error that is indistinguishable
 * from a wrong password to the user. Sniffing the outer header first lets the UI say exactly what is
 * wrong and what to do about it, which the audit requires for Twofish specifically.
 *
 * Ports Android `utils/KeePassFormatInspector.kt` and extends it with cipher detection.
 */

export type KeePassContainerFormat = "kdbx" | "kdb-legacy" | "unknown";

export type KeePassErrorCode =
  | "legacy-kdb-unsupported"
  | "format-unsupported"
  | "cipher-unsupported"
  | "invalid-credential"
  | "kdf-memory-insufficient"
  | "io-read-write-failed";

export class KeePassOperationError extends Error {
  /** `cause` is set by hand: the build targets ES2020, whose `Error` has no `cause` option. */
  readonly cause?: unknown;

  constructor(readonly code: KeePassErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "KeePassOperationError";
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/** `KeePassFormatInspector.kt:12-15`. */
const KDBX_SIGNATURE = [0x03, 0xd9, 0xa2, 0x9a, 0x67, 0xfb, 0x4b, 0xb5];
/** `:16-25`. KeePass 1.x wrote `0x65`; the 2.x pre-release wrote `0x66`. */
const KDB_LEGACY_SIGNATURES = [
  [0x03, 0xd9, 0xa2, 0x9a, 0x65, 0xfb, 0x4b, 0xb5],
  [0x03, 0xd9, 0xa2, 0x9a, 0x66, 0xfb, 0x4b, 0xb5]
];

/** kdbxweb `defs/consts.ts:38-41` exposes only these two; anything else cannot be opened at all. */
const CIPHER_AES = "McHy5r9xQ1C+WAUhavxa/w==";
const CIPHER_CHACHA20 = "1gOKK4tvTLWlJDOaMdu1mg==";
/** `AD68F29F-576F-4BB9-A36A-D47AF965346C`, the cipher KeePass 2.x offers next to AES. */
const CIPHER_TWOFISH = "rWjyn1dvS7mjatR6+WU0bA==";

const CIPHER_NAMES: Record<string, string> = {
  [CIPHER_AES]: "AES-256",
  [CIPHER_CHACHA20]: "ChaCha20",
  [CIPHER_TWOFISH]: "Twofish"
};

/** `KdbxHeader.MinSupportedVersion` / `MaxSupportedVersion` (`format/kdbx-header.ts:57-58`). */
const MIN_SUPPORTED_MAJOR = 3;
const MAX_SUPPORTED_MAJOR = 4;

export interface KeePassHeaderInfo {
  format: KeePassContainerFormat;
  versionMajor?: number;
  versionMinor?: number;
  /** Raw 16-byte cipher UUID, base64-encoded exactly as kdbxweb's `KdbxUuid.toString()` renders it. */
  cipherUuid?: string;
  cipherName?: string;
}

export function detectKeePassContainerFormat(bytes: Uint8Array, sourceName?: string): KeePassContainerFormat {
  if (matchesSignature(bytes, KDBX_SIGNATURE)) return "kdbx";
  if (KDB_LEGACY_SIGNATURES.some((signature) => matchesSignature(bytes, signature))) return "kdb-legacy";
  if (isLikelyLegacyKdbExtension(sourceName)) return "kdb-legacy";
  return "unknown";
}

/**
 * Walks the outer header far enough to read `CipherID` (field 2). Field sizes are `uint16` in KDBX 3
 * and `uint32` in KDBX 4, so the version has to be read first. A malformed header yields whatever was
 * found so far rather than throwing: the caller turns that into a format error with better context.
 */
export function readKeePassHeader(bytes: Uint8Array, sourceName?: string): KeePassHeaderInfo {
  const format = detectKeePassContainerFormat(bytes, sourceName);
  if (format !== "kdbx" || bytes.length < 12) return { format };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionMinor = view.getUint16(8, true);
  const versionMajor = view.getUint16(10, true);
  const info: KeePassHeaderInfo = { format, versionMajor, versionMinor };

  const sizeBytes = versionMajor >= 4 ? 4 : 2;
  let offset = 12;
  while (offset + 1 + sizeBytes <= bytes.length) {
    const fieldId = bytes[offset];
    const size = sizeBytes === 4 ? view.getUint32(offset + 1, true) : view.getUint16(offset + 1, true);
    const dataStart = offset + 1 + sizeBytes;
    if (fieldId === 0 || dataStart + size > bytes.length) break;
    if (fieldId === 2 && size === 16) {
      info.cipherUuid = bytesToBase64(bytes.subarray(dataStart, dataStart + 16));
      info.cipherName = CIPHER_NAMES[info.cipherUuid];
      break;
    }
    offset = dataStart + size;
  }
  return info;
}

/**
 * Throws a `KeePassOperationError` when the file cannot be opened at all. Callers run this before
 * kdbxweb so that the failure names the actual cause instead of surfacing as a wrong-password error.
 */
export function assertKeePassFileSupported(bytes: Uint8Array, sourceName?: string): KeePassHeaderInfo {
  const info = readKeePassHeader(bytes, sourceName);
  if (info.format === "kdb-legacy") {
    throw new KeePassOperationError(
      "legacy-kdb-unsupported",
      "检测到旧版 .kdb（KeePass 1.x）数据库，当前仅支持 .kdbx。请先在 KeePassDX/KeePassXC 中另存为 .kdbx 后再导入。"
    );
  }
  if (info.format !== "kdbx") {
    throw new KeePassOperationError("format-unsupported", "这不是 KeePass .kdbx 数据库，或文件已损坏。");
  }
  const major = info.versionMajor ?? 0;
  if (major < MIN_SUPPORTED_MAJOR || major > MAX_SUPPORTED_MAJOR) {
    throw new KeePassOperationError(
      "format-unsupported",
      `不支持的 KDBX 版本 ${major}.${info.versionMinor ?? 0}，当前仅支持 KDBX 3 与 KDBX 4。`
    );
  }
  if (info.cipherUuid === CIPHER_TWOFISH) {
    throw new KeePassOperationError(
      "cipher-unsupported",
      "此数据库使用 Twofish 加密，浏览器端暂不支持。请在 Android 或 KeePassXC 中将其转换为 AES-256 后再导入。"
    );
  }
  if (info.cipherUuid && info.cipherUuid !== CIPHER_AES && info.cipherUuid !== CIPHER_CHACHA20) {
    throw new KeePassOperationError(
      "cipher-unsupported",
      `此数据库使用浏览器端不支持的加密算法（${info.cipherUuid}），请在 KeePassXC 中转换为 AES-256 后再导入。`
    );
  }
  return info;
}

/**
 * Maps a thrown error onto a code plus a Chinese message. Ports `utils/KeePassError.kt`; the checks are
 * ordered so the most specific cause wins, and an already-classified error passes through unchanged.
 */
export function toKeePassOperationError(error: unknown): KeePassOperationError {
  if (error instanceof KeePassOperationError) return error;

  const root = rootCause(error);
  const code = typeof (root as { code?: unknown })?.code === "string" ? (root as { code: string }).code : "";
  const message = (root instanceof Error ? root.message : String(root ?? "")).toLowerCase();

  if (code === "InvalidKey" || message.includes("invalid key") || message.includes("invalid credentials")) {
    return new KeePassOperationError("invalid-credential", "数据库密码或密钥文件不正确。", { cause: error });
  }
  if (message.includes("out of memory") || (message.includes("argon2") && message.includes("memory"))) {
    return new KeePassOperationError("kdf-memory-insufficient", "KDF 内存参数过高，浏览器内存不足，请降低内存占用或并行度。", { cause: error });
  }
  if (message.includes("keepass 1.x") || message.includes("legacy kdb")) {
    return new KeePassOperationError(
      "legacy-kdb-unsupported",
      "检测到旧版 .kdb（KeePass 1.x）数据库，当前仅支持 .kdbx。请先在 KeePassDX/KeePassXC 中另存为 .kdbx 后再导入。",
      { cause: error }
    );
  }
  if (message.includes("unsupported cipher")) {
    return new KeePassOperationError("cipher-unsupported", "此数据库使用浏览器端不支持的加密算法，请在 KeePassXC 中转换为 AES-256 后再导入。", { cause: error });
  }
  if (code === "BadSignature" || code === "InvalidVersion" || code === "Unsupported" || code === "FileCorrupt") {
    return new KeePassOperationError("format-unsupported", "数据库格式不支持或文件已损坏。", { cause: error });
  }
  return new KeePassOperationError(
    "io-read-write-failed",
    root instanceof Error && root.message ? root.message : "KeePass 操作失败。",
    { cause: error }
  );
}

/** `cause` is read structurally: the ES2020 lib does not declare it, but hosts and callers still set it. */
function rootCause(error: unknown): unknown {
  let current = error;
  while (current instanceof Error) {
    const cause = (current as { cause?: unknown }).cause;
    if (!cause || cause === current) break;
    current = cause;
  }
  return current;
}

function matchesSignature(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function isLikelyLegacyKdbExtension(sourceName: string | undefined): boolean {
  const lower = sourceName?.toLowerCase();
  if (!lower) return false;
  return lower.endsWith(".kdb") && !lower.endsWith(".kdbx");
}
