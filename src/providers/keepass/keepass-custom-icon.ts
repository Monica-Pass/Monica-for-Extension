import * as kdbxweb from 'kdbxweb';
import type { LoginItem, VaultItem } from '../../core/model';
import { base64ToBytes, bytesToBase64 } from '../../security/encoding';

import { KEEPASS_CUSTOM_ICON_TYPE } from '../../core/bitmap-icon';
export { KEEPASS_CUSTOM_ICON_TYPE };
/** Binary transport only; consumers must validate image format before rendering. */
export function readKeePassCustomIcon(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry): Partial<LoginItem> {
  const icon = entry.customIcon && database.meta.customIcons.get(entry.customIcon.toString());
  if (!icon?.data.byteLength) return {};
  return {
    customIconType: KEEPASS_CUSTOM_ICON_TYPE,
    customIconValue: bytesToBase64(new Uint8Array(icon.data)),
    ...(icon.lastModified ? { customIconUpdatedAt: icon.lastModified.getTime() } : {})
  };
}

/** Validate before changing an entry, its history, groups, or shared icon pool. */
export function prepareKeePassCustomIcon(item: VaultItem): Uint8Array | null | undefined {
  if (item.kind !== 'login' && item.kind !== 'totp') return undefined;
  if (item.customIconType === 'NONE') return null;
  if (item.customIconType !== KEEPASS_CUSTOM_ICON_TYPE) return undefined;
  try {
    const bytes = base64ToBytes(item.customIconValue || '');
    if (!bytes.length) throw new Error('empty');
    return bytes;
  } catch {
    throw new Error('KeePass 自定义图标数据无效，未修改数据库。');
  }
}

export function applyKeePassCustomIcon(database: kdbxweb.Kdbx, entry: kdbxweb.KdbxEntry, bytes: Uint8Array | null | undefined): void {
  if (bytes === undefined) return;
  if (bytes === null) { entry.customIcon = undefined; return; }
  const matches = (data: ArrayBuffer | undefined) => data?.byteLength === bytes.length && new Uint8Array(data).every((byte, index) => byte === bytes[index]);
  // Prefer the existing UUID even when the pool contains identical images with different metadata.
  if (entry.customIcon && matches(database.meta.customIcons.get(entry.customIcon.toString())?.data)) return;
  for (const [uuid, icon] of database.meta.customIcons) {
    if (matches(icon.data)) { entry.customIcon = new kdbxweb.KdbxUuid(uuid); return; }
  }
  const uuid = kdbxweb.KdbxUuid.random();
  database.meta.customIcons.set(uuid.toString(), { data: bytes.slice().buffer, lastModified: new Date() });
  entry.customIcon = uuid;
}
