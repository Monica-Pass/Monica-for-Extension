export type KeePassRemoteSourceMode = "webdav" | "onedrive";
export type KeePassSourceMode = "local-file" | KeePassRemoteSourceMode;

export function isRemoteKeePassSource(value: unknown): value is KeePassRemoteSourceMode {
  return value === "webdav" || value === "onedrive";
}
