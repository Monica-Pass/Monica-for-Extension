const SEGMENT_SUFFIX = ".mdbxsync";
const SYNC_SUFFIX = ".sync";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function normalizeMdbx2RemotePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!normalized) throw new Error("MDBX2 远端文件位置不能为空。");
  if (normalized.split("/").some((component) => !component || component === "." || component === "..")) {
    throw new Error("MDBX2 远端文件位置包含不安全的组成部分。");
  }
  return normalized;
}

export function normalizeMdbx2RemoteComponent(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error("MDBX2 远端标识为空或过长。");
  if (normalized === "." || normalized === ".." || /[\\/\0]/.test(normalized)) {
    throw new Error("MDBX2 远端标识包含不安全字符。");
  }
  return normalized;
}

export function mdbx2SyncRoot(remoteVaultPath: string): string {
  return `${normalizeMdbx2RemotePath(remoteVaultPath)}${SYNC_SUFFIX}`;
}

export function mdbx2StreamsRoot(remoteVaultPath: string): string {
  return `${mdbx2SyncRoot(remoteVaultPath)}/streams`;
}

export function mdbx2BlobsRoot(remoteVaultPath: string): string {
  return `${mdbx2SyncRoot(remoteVaultPath)}/blobs`;
}

export function mdbx2StreamRoot(remoteVaultPath: string, deviceId: string, generationId: string): string {
  return `${mdbx2StreamsRoot(remoteVaultPath)}/${normalizeMdbx2RemoteComponent(deviceId)}/${normalizeMdbx2RemoteComponent(generationId)}`;
}

export function mdbx2SegmentPath(
  remoteVaultPath: string,
  deviceId: string,
  generationId: string,
  sequence: number,
  digestHex: string
): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) throw new Error("MDBX2 增量段序号无效。");
  const digest = normalizeSha256(digestHex, "MDBX2 增量段摘要");
  return `${mdbx2StreamRoot(remoteVaultPath, deviceId, generationId)}/segments/${String(sequence).padStart(10, "0")}-${digest}${SEGMENT_SUFFIX}`;
}

export function mdbx2BlobPath(remoteVaultPath: string, blobId: string): string {
  const id = normalizeSha256(blobId, "MDBX2 Blob ID");
  return `${mdbx2BlobsRoot(remoteVaultPath)}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
}

export interface Mdbx2RemoteSegmentDescriptor {
  deviceId: string;
  generationId: string;
  sequence: number;
  digestHex: string;
  path: string;
  streamId: string;
}

export function parseMdbx2RemoteSegmentPath(remoteVaultPath: string, path: string): Mdbx2RemoteSegmentDescriptor | undefined {
  const normalized = normalizeMdbx2RemotePath(path);
  const prefix = `${mdbx2StreamsRoot(remoteVaultPath)}/`;
  if (!normalized.startsWith(prefix)) return undefined;
  const relative = normalized.slice(prefix.length).split("/");
  if (relative.length !== 4 || relative[2] !== "segments") return undefined;
  let deviceId: string;
  let generationId: string;
  try {
    deviceId = normalizeMdbx2RemoteComponent(relative[0]);
    generationId = normalizeMdbx2RemoteComponent(relative[1]);
  } catch {
    return undefined;
  }
  const match = relative[3].match(/^(\d{10})-([a-f0-9]{64})\.mdbxsync$/);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence > 0xffff_ffff) return undefined;
  return {
    deviceId,
    generationId,
    sequence,
    digestHex: match[2],
    path: normalized,
    streamId: `${deviceId}/${generationId}`
  };
}

export function mdbx2ParentPath(path: string): string {
  return normalizeMdbx2RemotePath(path).split("/").slice(0, -1).join("/");
}

export function normalizeSha256(value: string, label = "SHA-256"): string {
  const normalized = value.toLocaleLowerCase("en-US");
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label}无效。`);
  return normalized;
}
