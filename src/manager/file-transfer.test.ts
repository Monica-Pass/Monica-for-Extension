import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createLoginItem, type TotpItem, type VaultItem } from '../core/model';
import { createTransferExport, independentItems, previewImport, MAX_IMPORT_BYTES, type ExportFormat } from './file-transfer';
import { generateOtpWithParameters } from '../core/totp';
import { getAndroidBackupEncryptionFormat } from '../providers/webdav/android-backup-crypto';

const login = { ...createLoginItem({ title: '迁移登录', username: '  用户@example.invalid  ', password: '  pass,"word\r\n🔑  ',
  notes: '第一行\nsecond line', uris: ['https://example.invalid/login'] }), id: 'synthetic-file-login', username: '  用户@example.invalid  ', categoryName: '工作', totpSecret: 'JBSWY3DPEHPK3PXP' };
const totp: TotpItem = { id: 'synthetic-totp', kind: 'totp', title: '测试验证码', secret: 'JBSWY3DPEHPK3PXP', issuer: '测试服务', accountName: 'alice',
  algorithm: 'SHA256', digits: 8, period: 60, otpType: 'TOTP', notes: '备注', favorite: false, providerRefs: [], createdAt: login.createdAt, updatedAt: login.updatedAt };
const note: VaultItem = { id: 'synthetic-note', kind: 'secure-note', title: '笔记', notes: '', content: '  # 内容\n🔑  ', favorite: false, providerRefs: [], createdAt: login.createdAt, updatedAt: login.updatedAt };
const input = (text: unknown, name = 'test.json') => ({ name, bytes: strToU8(typeof text === 'string' ? text : JSON.stringify(text)) });

describe('manual file migration', () => {
  it.each(['auto', 'zip'] as const)('imports a V2 encrypted ZIP using %s detection and preserves sensitive values', async format => {
    const password = '  中文🔑e\u0301 backup  ';
    const output = await createTransferExport([login, note, totp], 'zip', password, 'v2');
    expect(getAndroidBackupEncryptionFormat(output.bytes)).toBe('v2');
    const result = await previewImport({ name: 'opaque.backup', bytes: output.bytes, password, format });
    expect(result.items).toHaveLength(3);
    expect(result.items.find(item => item.kind === 'login')).toMatchObject({ username: login.username, password: login.password, notes: login.notes, providerRefs: [] });
    expect(result.items.find(item => item.kind === 'secure-note')).toMatchObject({ content: note.content });
    expect(result.items.find(item => item.kind === 'totp')).toMatchObject({ secret: totp.secret, algorithm: 'SHA256', digits: 8, period: 60 });
    expect(result.items.every(item => ![login.id, note.id, totp.id].includes(item.id))).toBe(true);
  });
  it('keeps default encrypted ZIP exports at V1 and rejects passwordless V2', async () => {
    const encrypted = await createTransferExport([login], 'zip', 'synthetic');
    expect(getAndroidBackupEncryptionFormat(encrypted.bytes)).toBe('v1');
    const plain = await createTransferExport([login], 'zip');
    expect(getAndroidBackupEncryptionFormat(plain.bytes)).toBeUndefined();
    await expect(createTransferExport([login], 'zip', '', 'v2')).rejects.toThrow('必须设置文件密码');
  });
  it('rejects V2 password errors, corrupt headers and unknown versions without producing a preview', async () => {
    const output = await createTransferExport([login], 'zip', 'synthetic', 'v2');
    const original = output.bytes.slice();
    for (const password of ['', 'wrong']) {
      await expect(previewImport({ name: 'test.zip', bytes: output.bytes, password })).rejects.toThrow(/密码/);
    }
    const corrupt = output.bytes.slice(); corrupt[corrupt.length - 1] ^= 1;
    await expect(previewImport({ name: 'test.zip', bytes: corrupt, password: 'synthetic' })).rejects.toThrow('文件已损坏');
    const parameters = output.bytes.slice(); parameters[16] ^= 1;
    await expect(previewImport({ name: 'test.zip', bytes: parameters, password: 'synthetic' })).rejects.toThrow('加密参数');
    const unknown = output.bytes.slice(); unknown[12] = 0x33;
    for (const format of ['auto', 'zip', 'json', 'csv'] as const) {
      await expect(previewImport({ name: 'test.json', bytes: unknown, password: 'synthetic', format })).rejects.toThrow('加密版本');
    }
    expect(output.bytes).toEqual(original);
  });
  it.each<ExportFormat>(['json', 'csv', 'zip', 'kdbx'])('%s round trips sensitive login whitespace, folder and OTP', async format => {
    const out = await createTransferExport([login], format, 'synthetic-file-password');
    const result = await previewImport({ name: `test.${out.extension}`, bytes: out.bytes, password: 'synthetic-file-password' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: 'login', title: login.title, username: login.username, password: login.password, notes: login.notes, categoryName: '工作', providerRefs: [] });
    expect(result.items[0].id).not.toBe(login.id);
  });
  it.each<ExportFormat>(['zip', 'kdbx', 'json'])('%s preserves note content and OTP parameters', async format => {
    const out = await createTransferExport([note, totp], format, 'synthetic-file-password');
    const result = await previewImport({ name: `test.${out.extension}`, bytes: out.bytes, password: 'synthetic-file-password' });
    expect(result.items.find(item => item.kind === 'secure-note')).toMatchObject({ content: note.content });
    expect(result.items.find(item => item.kind === 'totp')).toMatchObject({ secret: totp.secret, algorithm: 'SHA256', digits: 8, period: 60 });
  });
  it.each<ExportFormat>(['aegis', 'stratum', 'otp'])('%s preserves TOTP codes and 64-bit HOTP counters', async format => {
    const hotp = { ...totp, id: 'synthetic-hotp', otpType: 'HOTP' as const, counter: '9007199254740993' };
    const out = await createTransferExport([totp, hotp], format);
    const result = await previewImport({ name: `test.${out.extension}`, bytes: out.bytes });
    expect(result.items).toHaveLength(2);
    const imported = result.items as TotpItem[];
    expect(imported.find(item => item.otpType === 'HOTP')?.counter).toBe(hotp.counter);
    expect(await generateOtpWithParameters(imported[0], 1700000000000)).toBe(await generateOtpWithParameters(totp, 1700000000000));
  });
  it('rejects wrong ZIP and KDBX passwords without an import result', async () => {
    for (const format of ['zip', 'kdbx'] as const) {
      const out = await createTransferExport([login], format, 'synthetic-secret');
      await expect(previewImport({ name: `test.${format}`, bytes: out.bytes, password: 'wrong' })).rejects.toThrow();
    }
  });
  it('re-ids linked copies and never imports provider identity', () => {
    const copies = independentItems([{ ...login, passwordGroupId: 'old-group', boundTotpItemId: totp.id, providerRefs: [{ providerId: 'untrusted', remoteId: 'remote' }] }, totp]);
    expect(copies[0]).toMatchObject({ boundTotpItemId: copies[1].id, providerRefs: [] });
    expect((copies[0] as typeof login).passwordGroupId).not.toBe('old-group');
    expect(login.id).toBe('synthetic-file-login');
  });
  it('converts all Bitwarden plaintext types without remote references', async () => {
    const result = await previewImport(input({ encrypted: false, items: [{ id: 'remote-id', type: 1, name: 'Login', login: { username: 'alice', password: 'pass' } },
      { type: 2, name: 'Note', notes: 'secret' }, { type: 3, name: 'Card', card: { number: '0001234' } }, { type: 4, name: 'Identity', identity: { firstName: 'Alice' } },
      { type: 5, name: 'SSH', sshKey: { publicKey: 'ssh-ed25519 synthetic', privateKey: 'synthetic' } }] }));
    expect(result.items.map(item => item.kind)).toEqual(['login', 'secure-note', 'card', 'identity', 'login']);
    expect(result.items.every(item => !item.providerRefs.length && item.id !== 'remote-id')).toBe(true);
  });
  it('supports CSV families, counts unsupported rows, and retains note types', async () => {
    const result = await previewImport(input('folder,favorite,type,name,notes,login_uri,login_username,login_password,login_totp\n工作,1,login,Account,Notes,https://example.invalid,alice,pass,JBSWY3DPEHPK3PXP\n,,note,Note,Contents,,,,\n,,card,Unsupported,,,,,', 'bitwarden.csv'));
    expect(result.items.map(item => item.kind)).toEqual(['login', 'secure-note']); expect(result.skipped).toBe(1);
    const auth = await previewImport(input('name,secret,issuer,algorithm,digits,period\nalice,JBSWY3DPEHPK3PXP,Example,SHA512,8,60', 'auth.csv'));
    expect(auth.items[0]).toMatchObject({ kind: 'totp', algorithm: 'SHA512', digits: 8, period: 60 });
  });
  it('extracts Stratum HTML URIs without executing HTML', async () => {
    const result = await previewImport(input('<script>throw new Error("never execute")</script><a href="otpauth://totp/Alice?secret=JBSWY3DPEHPK3PXP&amp;issuer=Example">OTP</a>', 'stratum.html'));
    expect(result.items[0]).toMatchObject({ kind: 'totp', issuer: 'Example' });
  });
  it('round trips Steam maFile metadata', async () => {
    const result = await previewImport(input({ account_name: 'synthetic-steam', shared_secret: 'SGVsbG8h3q2+7w==', identity_secret: 'synthetic-identity', steamid: '76561198000000000' }, 'account.maFile'));
    const out = await createTransferExport(result.items, 'steam');
    expect(JSON.parse(new TextDecoder().decode(out.bytes))).toMatchObject({ account_name: 'synthetic-steam', steamid: '76561198000000000', identity_secret: 'synthetic-identity' });
  });
  it('imports a multiple-account Steam ZIP exported by the extension', async () => {
    const result = await previewImport(input({ account_name: 'synthetic-steam', shared_secret: 'SGVsbG8h3q2+7w==', steamid: '76561198000000000' }, 'account.maFile'));
    const second = { ...result.items[0], id: 'second-steam', accountName: 'second-steam', steamId: '76561198000000001', steamRawJson: undefined } as TotpItem;
    const output = await createTransferExport([...result.items, second], 'steam');
    expect(output.extension).toBe('zip');
    expect((await previewImport({ name: 'steam.zip', bytes: output.bytes })).items).toHaveLength(2);
  });
  it('preserves credential JSON account and note whitespace', async () => {
    const result = await previewImport(input({ credentials: [{ name: 'Synthetic', username: login.username, password: login.password, urls: login.uris, notes: '  note  ' }] }));
    expect(result.items[0]).toMatchObject({ username: login.username, password: login.password, notes: '  note  ' });
  });
  it('preserves all-space credentials in CSV', async () => {
    const output = await createTransferExport([{ ...login, username: '  ', password: '   ' }], 'csv');
    expect((await previewImport({ name: 'spaces.csv', bytes: output.bytes })).items[0]).toMatchObject({ username: '  ', password: '   ' });
  });
  it('imports JSON vaults that use null for unused required fields', async () => {
    const result = await previewImport(input({
      items: [
        { kind: 'login', id: 'good', title: 'Good', username: 'alice', password: 'secret', uris: ['https://example.invalid'] },
        { kind: 'login', id: 'nulls', title: 'Sparse', username: 'bob', password: null, notes: null, uris: null, customFields: null }
      ]
    }));
    expect(result.items).toHaveLength(2);
    expect(result.items.map(item => item.kind)).toEqual(['login', 'login']);
    expect(result.items[1]).toMatchObject({ title: 'Sparse', username: 'bob', password: '', notes: '', uris: [] });
    expect(result.warnings.some(warning => warning.includes('只读'))).toBe(false);
  });

  it('rejects oversized, malformed and encrypted Bitwarden inputs', async () => {
    await expect(previewImport({ name: 'huge.json', bytes: new Uint8Array(MAX_IMPORT_BYTES + 1) })).rejects.toThrow('64 MB');
    await expect(previewImport(input('name,password\n"unclosed', 'broken.csv'))).rejects.toThrow('引号');
    await expect(previewImport(input({ encrypted: true, items: [] }))).rejects.toThrow('Bitwarden');
    await expect(previewImport(input({ magic: 'MONICA_EXTENSION_BACKUP' }))).rejects.toThrow('整库备份');
    const sqlite = new Uint8Array(32);
    new TextEncoder().encodeInto('SQLite format 3\0', sqlite);
    await expect(previewImport({ name: 'vault.mdbx', bytes: sqlite })).rejects.toThrow('打开已有的密码库');
    const complete = zipSync({
      'vault.mdbx': sqlite,
      [`vault.mdbx.blobs/aa/aa/${'a'.repeat(64)}`]: new Uint8Array([1])
    });
    await expect(previewImport({ name: 'vault.mdbx-backup.zip', bytes: complete })).rejects.toThrow('打开已有的密码库');
  });
});
