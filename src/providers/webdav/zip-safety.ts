import { unzipSync, type Unzipped } from "fflate";

export interface ZipSafetyLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxJsonEntryBytes: number;
  maxCompressionRatio: number;
}

export interface ZipArchiveInspection {
  entryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  declaredSizes: Map<string, number>;
}

export const DEFAULT_ZIP_SAFETY_LIMITS: Readonly<ZipSafetyLimits> = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxJsonEntryBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 250
});

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;

export function inspectZipArchive(bytes: Uint8Array, overrides: Partial<ZipSafetyLimits> = {}): ZipArchiveInspection {
  const limits = resolveLimits(overrides);
  if (bytes.length > limits.maxArchiveBytes) throw new Error("Android 备份 ZIP 超过安全上限。");
  if (bytes.length < 22) throw new Error("Android 备份 ZIP 结构不完整。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== bytes.length) throw new Error("Android 备份 ZIP 尾部结构无效。");
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw new Error("不支持多磁盘 ZIP 备份。");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("不支持 ZIP64 备份。");
  if (entryCount > limits.maxEntries) throw new Error("Android 备份 ZIP 条目数量超过安全上限。");
  if (centralOffset + centralSize !== eocd || centralOffset > bytes.length) throw new Error("Android 备份 ZIP 中央目录无效。");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const declaredSizes = new Map<string, number>();
  const canonicalNames = new Set<string>();
  const dataRanges: Array<[number, number]> = [];
  let cursor = centralOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new Error("Android 备份 ZIP 中央目录条目无效。");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const entryDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (next > eocd || nameLength === 0) throw new Error("Android 备份 ZIP 条目长度无效。");
    if (entryDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error("不支持 ZIP64 或多磁盘 ZIP 条目。");
    if ((flags & 0x0001) !== 0) throw new Error("不支持 ZIP 内层加密条目。");
    if (method !== 0 && method !== 8) throw new Error("Android 备份 ZIP 使用了不支持的压缩算法。");

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw new Error("Android 备份 ZIP 条目名称不是有效 UTF-8。");
    }
    validateEntryPath(name);
    const canonicalName = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (canonicalNames.has(canonicalName)) throw new Error("Android 备份 ZIP 包含重复或混淆条目名。");
    canonicalNames.add(canonicalName);

    if (uncompressedSize > limits.maxEntryUncompressedBytes) throw new Error("单个 ZIP 条目超过安全上限。");
    if (/\.json$/i.test(name) && uncompressedSize > limits.maxJsonEntryBytes) throw new Error("Android 备份 JSON 条目超过安全上限。");
    totalCompressedBytes = checkedAdd(totalCompressedBytes, compressedSize);
    totalUncompressedBytes = checkedAdd(totalUncompressedBytes, uncompressedSize);
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) throw new Error("Android 备份 ZIP 解压后总大小超过安全上限。");

    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) throw new Error("Android 备份 ZIP 本地条目无效。");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = checkedAdd(dataStart, compressedSize);
    if (dataEnd > centralOffset) throw new Error("Android 备份 ZIP 条目数据范围无效。");
    if (localFlags !== flags || localMethod !== method) throw new Error("Android 备份 ZIP 本地头与中央目录不一致。");
    if ((flags & 0x0008) === 0) {
      const localCompressedSize = view.getUint32(localOffset + 18, true);
      const localUncompressedSize = view.getUint32(localOffset + 22, true);
      if (localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) throw new Error("Android 备份 ZIP 本地大小与中央目录不一致。");
    }
    const localNameBytes = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const centralNameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!sameBytes(localNameBytes, centralNameBytes)) throw new Error("Android 备份 ZIP 本地名称与中央目录不一致。");
    dataRanges.push([localOffset, dataEnd]);
    declaredSizes.set(name, uncompressedSize);
    cursor = next;
  }

  if (cursor !== eocd) throw new Error("Android 备份 ZIP 中央目录大小不一致。");
  dataRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < dataRanges.length; index += 1) {
    if (dataRanges[index][0] < dataRanges[index - 1][1]) throw new Error("Android 备份 ZIP 条目数据范围重叠。");
  }
  if (totalUncompressedBytes > 0 && totalUncompressedBytes / Math.max(1, totalCompressedBytes) > limits.maxCompressionRatio) {
    throw new Error("Android 备份 ZIP 压缩比异常，已拒绝解压。");
  }
  return { entryCount, totalCompressedBytes, totalUncompressedBytes, declaredSizes };
}

export function safeUnzipSync(bytes: Uint8Array, overrides: Partial<ZipSafetyLimits> = {}): Unzipped {
  const limits = resolveLimits(overrides);
  const inspection = inspectZipArchive(bytes, limits);
  const entries = unzipSync(bytes);
  let actualTotal = 0;
  for (const [name, declaredSize] of inspection.declaredSizes) {
    const entry = entries[name];
    if (!entry) {
      if (name.endsWith("/") && declaredSize === 0) continue;
      throw new Error("Android 备份 ZIP 解压结果缺少声明条目。");
    }
    if (entry.length !== declaredSize) throw new Error("Android 备份 ZIP 条目实际大小与声明不一致。");
    actualTotal = checkedAdd(actualTotal, entry.length);
    if (actualTotal > limits.maxTotalUncompressedBytes) throw new Error("Android 备份 ZIP 实际解压大小超过安全上限。");
  }
  return entries;
}

export function validateUncompressedZipEntries(entries: Record<string, Uint8Array>, overrides: Partial<ZipSafetyLimits> = {}): void {
  const limits = resolveLimits(overrides);
  const names = Object.keys(entries);
  if (names.length > limits.maxEntries) throw new Error("Android 备份 ZIP 条目数量超过安全上限。");
  const canonicalNames = new Set<string>();
  let total = 0;
  for (const name of names) {
    validateEntryPath(name);
    const canonicalName = name.normalize("NFC").toLocaleLowerCase("en-US");
    if (canonicalNames.has(canonicalName)) throw new Error("Android 备份 ZIP 包含重复或混淆条目名。");
    canonicalNames.add(canonicalName);
    const size = entries[name].length;
    if (size > limits.maxEntryUncompressedBytes) throw new Error("单个 ZIP 条目超过安全上限。");
    if (/\.json$/i.test(name) && size > limits.maxJsonEntryBytes) throw new Error("Android 备份 JSON 条目超过安全上限。");
    total = checkedAdd(total, size);
    if (total > limits.maxTotalUncompressedBytes) throw new Error("Android 备份 ZIP 解压后总大小超过安全上限。");
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const start = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("Android 备份 ZIP 缺少中央目录结束标记。");
}

function validateEntryPath(name: string): void {
  if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error("Android 备份 ZIP 包含不安全路径。");
  const parts = name.split("/");
  const isDirectory = name.endsWith("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === ".." || part === "." || (!part && !(isDirectory && index === parts.length - 1))) throw new Error("Android 备份 ZIP 包含不安全路径。");
  }
}

function resolveLimits(overrides: Partial<ZipSafetyLimits>): ZipSafetyLimits {
  const limits = { ...DEFAULT_ZIP_SAFETY_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(value)) throw new Error(`ZIP 安全限制无效: ${name}`);
  }
  return limits;
}

function checkedAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("Android 备份 ZIP 大小计算溢出。");
  return total;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
