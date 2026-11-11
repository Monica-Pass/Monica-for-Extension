import * as kdbxweb from 'kdbxweb';
import { strToU8, zipSync } from 'fflate';
import type { TotpItem, VaultItem } from '../core/model';
import { parseLosslessJson } from '../core/lossless-json';
import { generateOtpUri, parseOtpUris } from '../core/totp';
import { parseSteamMaFile, exportSteamMaFile } from '../core/steam-mafile';
import { projectSteamItem } from '../core/steam-item';
import { independentImportedPasskey, normalizeImportedVaultItem } from './import-items';
import { isPlainBitwardenExport, importPlainBitwardenJson } from './bitwarden-json-import';
import { parseCsvToVaultItems } from './csv-import';
import { decodeAegis, decodeStratum, otpItem, readAuthenticators, record } from './authenticator-import';
import { readAndroidBackup, writeAndroidBackup, vaultItemToAndroidRecord } from '../providers/webdav/android-backup-codec';
import { decryptAndroidBackup, encryptAndroidBackup, getAndroidBackupEncryptionFormat, type AndroidBackupEncryptionFormat } from '../providers/webdav/android-backup-crypto';
import { openKeePassVault } from '../providers/keepass/keepass-vault';
import { createKeePassEntry } from '../providers/keepass/keepass-writer';
import { installKdbxCryptoEngine } from '../providers/keepass/keepass-crypto';
import { decodeKeePassPathSegments, encodeKeePassPathSegment } from '../providers/keepass/keepass-path-codec';
import { safeUnzipSync } from '../providers/webdav/zip-safety';
import { sniffMdbxImportFile } from '../providers/mdbx2/mdbx-import-detect';

export type TransferFormat = 'auto' | 'json' | 'csv' | 'zip' | 'kdbx' | 'aegis' | 'stratum' | 'otp' | 'steam';
export type ExportFormat = Exclude<TransferFormat, 'auto'>;
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
export interface FileImportPreview { format: TransferFormat; items: VaultItem[]; skipped: number; warnings: string[] }
export interface TransferInput { name: string; bytes: Uint8Array; format?: TransferFormat; password?: string; keyFile?: Uint8Array }
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
const portable = { allowPortablePasskeys: true, allowPortableAttachments: true };

export async function previewImport(input: TransferInput): Promise<FileImportPreview> {
  if (!input.bytes.length || input.bytes.length > MAX_IMPORT_BYTES) throw new Error('文件为空或超过 64 MB。');
  if (input.keyFile && input.keyFile.length > 1024 * 1024) throw new Error('密钥文件超过 1 MB。');
  const sniffed = sniffMdbxImportFile(input.bytes);
  if (sniffed.kind === 'plugin-backup-json') throw new Error('这是插件加密整库备份，请在“加密备份与恢复”中恢复。');
  if (sniffed.kind === 'mdbx-vault' || sniffed.kind === 'mdbx-complete-backup-zip') throw new Error('这是独立 MDBX 密码库，请在“打开已有的密码库”中导入。');
  const password = input.password || '', prefix = new TextDecoder().decode(input.bytes.subarray(0, 20));
  const encryptionFormat = getAndroidBackupEncryptionFormat(input.bytes);
  let format = input.format || 'auto';
  if (format === 'auto') {
    if (encryptionFormat || input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) format = 'zip';
    else if (/\.kdbx$/i.test(input.name) || input.bytes[0] === 3 && input.bytes[1] === 0xd9) format = 'kdbx';
    else if (/^(AUTHENTICATORPRO|AuthenticatorPro)/.test(prefix)) format = 'stratum';
    else if (/\.csv$/i.test(input.name)) format = 'csv';
    else if (/\.(txt|html?)$/i.test(input.name) || /^\s*(otpauth|steam|motp):\/\//i.test(prefix)) format = 'otp';
    else format = 'json';
  }
  let items: VaultItem[] = [], skipped = 0; const warnings: string[] = [];
  if (format === 'zip') {
    if (encryptionFormat && !password) throw new Error('请输入文件密码。');
    const bytes = encryptionFormat ? await decryptAndroidBackup(input.bytes, password) : input.bytes;
    const entries = safeUnzipSync(bytes);
    const steamFiles = Object.entries(entries).filter(([path]) => /\.mafile(?:\.json)?$/i.test(path));
    if (steamFiles.length) {
      for (const [name, bytes] of steamFiles) {
        try { items.push(...(await previewImport({ name, bytes, format: 'steam' })).items); }
        catch { skipped++; }
      }
      if (Object.keys(entries).length !== steamFiles.length) warnings.push('Steam ZIP 中的其他文件已跳过。');
    } else {
      const doc = readAndroidBackup(bytes, 'file-import', portable);
      items = doc.items; warnings.push(...doc.warnings);
      if (Object.keys(doc.entries).some(path => /^(attachments|images|icons)[/_]/i.test(path))) warnings.push('此导入仅迁移项目，ZIP 中的附件与图片文件不会导入。');
    }
  } else if (format === 'kdbx') {
    const vault = await openKeePassVault(input.bytes, { password, keyFile: input.keyFile, databaseId: 0, providerId: 'file-import', sourceName: input.name });
    items = vault.items.map(item => ({ ...item, categoryName: item.categoryName || (item.keepassGroupPath ? decodeKeePassPathSegments(item.keepassGroupPath).join('/') : undefined) })); skipped = vault.skipped.length; warnings.push(...vault.warnings);
    if ([...vault.entriesByUuid.values()].some(entry => entry.binaries.size)) warnings.push('此导入仅迁移项目，KDBX 中的附件文件不会导入。');
  } else if (format === 'csv') {
    ({ items, skipped } = parseCsvToVaultItems(decode(input.bytes)));
  } else if (format === 'otp') {
    // Extract only recognized URIs; HTML is never inserted into the document or executed.
    const uris = decode(input.bytes).match(/(?:otpauth(?:-migration)?|motp|steam):\/\/[^\s<>"']+/gi) || [];
    for (const uri of [...new Set(uris)]) {
      try { for (const parsed of parseOtpUris(uri.replace(/&amp;/g, '&'))) items.push(otpItem(parsed.parameters, parsed.label)); }
      catch { skipped++; }
    }
  } else {
    const root = format === 'stratum' ? await decodeStratum(input.bytes, password) : record(parseLosslessJson(decode(input.bytes)));
    if (format === 'json') {
      if (root.Authenticators) format = 'stratum';
      else if (root.db || root.entries) format = 'aegis';
      else if (root.shared_secret || /\.mafile(?:\.json)?$/i.test(input.name)) format = 'steam';
    }
    if (format === 'aegis' || format === 'stratum') {
      ({ items, skipped } = readAuthenticators(format === 'aegis' ? await decodeAegis(root, password) : root, format));
    } else if (format === 'steam') {
      const steam = parseSteamMaFile(decode(input.bytes), input.name);
      items = [{ ...otpItem({ secret: steam.sharedSecretBase64, secretEncoding: 'base64', otpType: 'STEAM', issuer: 'Steam', accountName: steam.accountName, algorithm: 'SHA1', digits: 5, period: 30 }, steam.accountName),
        steamSharedSecretBase64: steam.sharedSecretBase64, steamId: steam.steamId, steamDeviceId: steam.deviceId, steamIdentitySecret: steam.identitySecret,
        steamRevocationCode: steam.revocationCode, steamTokenGid: steam.tokenGid, steamAccessToken: steam.accessToken, steamRefreshToken: steam.refreshToken,
        steamLoginSecure: steam.steamLoginSecure, steamRawJson: steam.rawJson }];
    } else if (root.magic === 'MONICA_EXTENSION_BACKUP') throw new Error('这是插件加密整库备份，请在“加密备份与恢复”中恢复。');
    else if (root.encrypted === true) throw new Error('请先从 Bitwarden 导出未加密 JSON。');
    else if (isPlainBitwardenExport(root)) { items = importPlainBitwardenJson(root); skipped = (root.items as unknown[]).length - items.length; }
    else if (Array.isArray(root.items)) { items = root.items.flatMap(value => { const item = normalizeImportedVaultItem(value); return item ? [item] : []; }); skipped = root.items.length - items.length; }
    else if (Array.isArray(root.credentials)) {
      items = root.credentials.flatMap(value => { const row = record(value); return typeof row.password === 'string' && Array.isArray(row.urls)
        ? [normalizeImportedVaultItem({ kind: 'login', title: String(row.name || '导入登录项'), username: String(row.username || ''), password: row.password, uris: row.urls.map(String), notes: String(row.notes || '') })].filter((item): item is VaultItem => Boolean(item)) : []; });
      skipped = root.credentials.length - items.length;
    }
  }
  const active = items.filter(item => !item.deletedAt && !item.archivedAt);
  skipped += items.length - active.length;
  if (!active.length) throw new Error('文件中没有可导入的项目，请检查文件格式。');
  if (active.length > 100000) throw new Error('项目数量超过安全上限。');
  if (active.some(item => item.kind === 'opaque')) warnings.push('部分项目以只读原始记录保留，当前版本无法编辑。');
  return { format, items: independentItems(active), skipped, warnings: [...new Set(warnings)] };
}

/** Manual migration always creates independent local copies, including in-vault links. */
export function independentItems(items: VaultItem[]): VaultItem[] {
  const ids = new Map(items.map(item => [item.id, crypto.randomUUID()]));
  const groups = new Map<string, string>();
  return items.map(original => {
    const copy = structuredClone(original) as VaultItem & Record<string, unknown>;
    copy.id = ids.get(original.id)!; copy.providerRefs = [];
    for (const field of ['boundTotpItemId', 'boundNoteEntryId', 'ssoRefLogicalId']) {
      if (typeof copy[field] === 'string') copy[field] = ids.get(copy[field] as string);
    }
    if (typeof copy.passwordGroupId === 'string') {
      if (!groups.has(copy.passwordGroupId)) groups.set(copy.passwordGroupId, crypto.randomUUID());
      copy.passwordGroupId = groups.get(copy.passwordGroupId);
    }
    for (const field of ['keepassDatabaseId', 'keepassEntryUuid', 'keepassGroupUuid', 'mdbxDatabaseId', 'mdbxFolderId', 'replicaGroupId', 'categoryId', 'boundPasswordId', 'boundNoteId', 'ssoRefEntryId', 'imagePaths']) delete copy[field];
    return independentImportedPasskey(copy);
  });
}

export function exportableItems(items: VaultItem[], format: ExportFormat): VaultItem[] {
  const active = items.filter(item => !item.deletedAt && !item.archivedAt);
  if (format === 'json') return active;
  if (format === 'csv') return active.filter(item => item.kind === 'login');
  if (format === 'steam') return active.flatMap(item => item.kind === 'login' || item.kind === 'totp' ? projectSteamItem(item) || [] : []);
  if (['aegis', 'stratum', 'otp'].includes(format)) return active.filter((item): item is TotpItem => item.kind === 'totp' &&
    (format === 'otp' || ['TOTP', 'HOTP'].includes(item.otpType || 'TOTP')));
  if (format === 'zip') return active.filter(item => item.kind !== 'opaque' && Boolean(vaultItemToAndroidRecord(item, undefined, undefined, portable)));
  return active.filter(item => item.kind !== 'opaque');
}

export async function createTransferExport(items: VaultItem[], format: ExportFormat, password = '', backupEncryptionFormat: AndroidBackupEncryptionFormat = 'v1'): Promise<{ bytes: Uint8Array; extension: string; count: number }> {
  if (format === 'zip' && backupEncryptionFormat === 'v2' && !password) throw new Error('增强 V2 ZIP 导出必须设置文件密码。');
  const selected = structuredClone(exportableItems(items, format));
  if (!selected.length) throw new Error('当前没有可按此格式导出的项目。');
  let bytes: Uint8Array, extension: string = format;
  if (format === 'json') bytes = strToU8(JSON.stringify({ version: 1, items: selected }, null, 2));
  else if (format === 'zip') {
    bytes = writeAndroidBackup({ entries: {}, records: new Map(), warnings: [], items: [] }, selected, 'file-export', portable);
    if (password) bytes = await encryptAndroidBackup(bytes, password, undefined, undefined, backupEncryptionFormat);
  } else if (format === 'kdbx') {
    if (!password) throw new Error('请设置 KDBX 文件密码。');
    installKdbxCryptoEngine();
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)), 'Monica');
    for (const item of selected) createKeePassEntry(db, item, item.keepassGroupPath || (item.categoryName ? encodeKeePassPathSegment(item.categoryName) : undefined));
    bytes = new Uint8Array(await db.save());
  } else if (format === 'csv') {
    const rows = [['name', 'url', 'username', 'password', 'notes', 'totp', 'folder', 'favorite'], ...selected.map(item => {
      if (item.kind !== 'login') throw new Error('CSV only supports logins');
      return [item.title, item.uris.join(';'), item.username, item.password, item.notes, item.totpSecret || '', item.categoryName || '', String(item.favorite)];
    })];
    bytes = strToU8('\uFEFF' + rows.map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join(',')).join('\r\n'));
  } else if (format === 'steam') {
    const steam = selected as TotpItem[];
    if (steam.length === 1) { bytes = strToU8(exportSteamMaFile(steam[0])); extension = 'maFile'; }
    else { bytes = zipSync(Object.fromEntries(steam.map((item, index) => [`steam-${index + 1}.maFile`, strToU8(exportSteamMaFile(item))]))); extension = 'zip'; }
  } else if (format === 'otp') {
    bytes = strToU8((selected as TotpItem[]).map(item => generateOtpUri(item, item.title, { includePin: true })).join('\n')); extension = 'txt';
  } else if (format === 'aegis') {
    bytes = strToU8(JSON.stringify({ version: 1, header: { slots: null, params: null }, db: { version: 2, entries: (selected as TotpItem[]).map(item => ({
      type: (item.otpType || 'TOTP').toLowerCase(), uuid: item.id, name: item.accountName || item.title, issuer: item.issuer || '', note: item.notes,
      info: { secret: item.secret, algo: item.algorithm, digits: item.digits, period: item.period, counter: item.counter || 0 }
    })) } }, null, 2)); extension = 'json';
  } else {
    bytes = strToU8(JSON.stringify({ Authenticators: (selected as TotpItem[]).map(item => ({ Type: item.otpType === 'HOTP' ? 1 : 2, Issuer: item.issuer || '', Username: item.accountName || item.title,
      Secret: item.secret, Algorithm: ['SHA1', 'SHA256', 'SHA512'].indexOf(item.algorithm), Digits: item.digits, Period: item.period, Counter: item.counter || 0 })), Categories: [], AuthenticatorCategories: [] }, null, 2)); extension = 'json';
  }
  return { bytes, extension, count: selected.length };
}
