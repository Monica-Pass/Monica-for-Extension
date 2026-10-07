import * as kdbxweb from 'kdbxweb';
import type { ProviderAccount } from '../../core/model';
import { base64ToBytes } from '../../security/encoding';
import { installKdbxCryptoEngine } from './keepass-crypto';
import { openKeePassConflictRecovery, type KeePassEncryptedConflictRecovery } from './keepass-conflict-recovery';

/** A standard password-encrypted KDBX, readable independently of Monica's cache
 * key and IndexedDB. Each original native file is an exact binary attachment.
 * Cloud credentials are deliberately excluded from the portable container. */
export async function exportKeePassConflictRecovery(account: ProviderAccount, envelope: KeePassEncryptedConflictRecovery,
  expectedIntentTag: string, exportPassword: string): Promise<Uint8Array> {
  if (typeof exportPassword !== 'string' || exportPassword.length < 8 || exportPassword.length > 4096)
    throw new Error('恢复副本导出密码须为 8 至 4096 个字符。');
  if (!/^[a-f0-9]{64}$/.test(expectedIntentTag) || envelope.intentTag !== expectedIntentTag)
    throw new Error('恢复副本已变化，请重新查看。');
  const opened = await openKeePassConflictRecovery(account, envelope);
  let keyFile: Uint8Array | undefined;
  try {
    installKdbxCryptoEngine();
    const database = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(exportPassword)), 'Monica recovery');
    database.setVersion(4); database.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    const parameters = database.header.kdfParameters!;
    parameters.set('M', kdbxweb.VarDictionary.ValueType.UInt64, new kdbxweb.Int64(64 * 1024 * 1024));
    parameters.set('I', kdbxweb.VarDictionary.ValueType.UInt64, new kdbxweb.Int64(3));
    parameters.set('P', kdbxweb.VarDictionary.ValueType.UInt32, 1);
    const root = database.getDefaultGroup();
    keyFile = typeof opened.source.config.keyFile === 'string' ? base64ToBytes(opened.source.config.keyFile) : undefined;
    const keyAttachment = keyFile?.length ? await database.createBinary(keyFile.slice().buffer) : undefined;
    const labels = { base: '共同基线 / Common baseline', working: '原本机版本 / Original local version',
      remote: '原远端版本 / Original remote version', resolved: '所选结果 / Selected result' };
    for (const part of ['base', 'working', 'remote', 'resolved'] as const) {
      const entry = database.createEntry(root);
      entry.fields.set('Title', labels[part]);
      entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(String(opened.source.config.databasePassword ?? '')));
      entry.fields.set('Notes', '提取 .kdbx 附件，用此条目的密码及密钥文件（如有）打开。请先另存并核对内容。\nExtract the .kdbx attachment and open it with this entry’s password and key file, if present. Save a separate copy and review it before use.');
      entry.fields.set('MonicaRecoveryVersion', '1');
      entry.fields.set('MonicaRecoveryPart', part);
      entry.fields.set('MonicaRecoveryCreatedAt', opened.createdAt);
      entry.fields.set('MonicaRecoveryOperation', opened.operationId);
      entry.fields.set('MonicaRecoveryChoices', kdbxweb.ProtectedValue.fromString(JSON.stringify(opened.choices)));
      entry.binaries.set(`${part}.kdbx`, await database.createBinary(opened.files[part].slice().buffer));
      if (keyAttachment) entry.binaries.set('original-key-file.key', keyAttachment);
    }
    return new Uint8Array(await database.save());
  } finally {
    keyFile?.fill(0);
    for (const bytes of Object.values(opened.files)) bytes.fill(0);
  }
}
