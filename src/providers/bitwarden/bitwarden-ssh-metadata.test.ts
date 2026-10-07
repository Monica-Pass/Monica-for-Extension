import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem } from '../../core/model';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden-cipher-codec';
import { encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';

const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(3), macKey: new Uint8Array(32).fill(4) };
const ssh = { algorithm: 'RSA', keySize: 4096, publicKeyOpenSsh: 'ssh-rsa public', privateKeyOpenSsh: 'private', fingerprintSha256: 'SHA256:test', comment: 'comment', format: 'PEM' };
const read = async (raw: Record<string, unknown>) => (await decodeBitwardenCipher({ ...raw, id: 'ssh' }, 'reconnected', key)).items[0] as LoginItem;
const fixture = () => encodeBitwardenCipher({ ...createLoginItem({ title: 'SSH' }), loginType: 'SSH_KEY', sshKeyData: JSON.stringify(ssh) }, key);

it.each(Object.keys(ssh) as Array<keyof typeof ssh>)('clears SSH %s without resurrecting its remote value', async property => {
  const raw = await fixture();
  const item = await read(raw);
  const changed = { ...ssh, [property]: property === 'keySize' ? 0 : '' };
  const output = await encodeBitwardenCipher({ ...item, sshKeyData: JSON.stringify(changed) }, key, raw);
  const reopened = JSON.parse((await read(output)).sshKeyData!);
  expect(reopened).toEqual({ ...changed, format: property === 'format' ? 'OPENSSH' : ssh.format });
});

it('retains comment-only fallback data', async () => {
  const raw = await encodeBitwardenCipher({ ...createLoginItem({ title: 'SSH' }), loginType: 'SSH_KEY', sshKeyData: JSON.stringify({ comment: 'remaining' }) }, key);
  expect(JSON.parse((await read(raw)).sshKeyData!).comment).toBe('remaining');
});

it('clears all SSH data and stale custom duplicates while retaining the SSH type', async () => {
  const raw = await fixture();
  const item = await read(raw);
  const output = await encodeBitwardenCipher({ ...item, sshKeyData: undefined, customFields: [{ name: 'monica_ssh_comment', value: 'stale', protected: false }] }, key, raw);
  const reopened = await read(output);
  expect(reopened.loginType).toBe('SSH_KEY');
  expect(JSON.parse(reopened.sshKeyData!)).toEqual({ algorithm: '', keySize: 0, publicKeyOpenSsh: '', privateKeyOpenSsh: '', fingerprintSha256: '', comment: '', format: 'OPENSSH' });
});

it('retains remote SSH metadata for a legacy model without a projection', async () => {
  const raw = await fixture();
  const output = await encodeBitwardenCipher(createLoginItem({ title: 'Legacy rename' }), key, raw);
  expect(JSON.parse((await read(output)).sshKeyData!)).toEqual(ssh);
});

it.each(['4096junk', '9007199254740993', '-1', '2.5'])('preserves malformed key size %s without projecting it', async value => {
  const raw = await fixture();
  const malformed = { name: await encryptBitwardenString('monica_ssh_key_size', key), value: await encryptBitwardenString(value, key), type: 0, future: true };
  (raw.fields as unknown[]).push(malformed);
  const item = await read(raw);
  expect(JSON.parse(item.sshKeyData!).keySize).toBe(4096);
  const output = await encodeBitwardenCipher({ ...item, title: 'Renamed' }, key, raw);
  expect(output.fields).toContainEqual(malformed);
});

it('preserves unsupported SSH fields and hidden duplicate comments on unrelated edits', async () => {
  const raw = await fixture();
  const enc = (value: string) => encryptBitwardenString(value, key);
  const future = { name: await enc('monica_ssh_public_key'), value: await enc('true'), type: 2, future: [1] };
  const comments = await Promise.all(['first', 'second'].map(async value => ({ name: await enc('monica_ssh_comment'), value: await enc(value), type: 1, future: value })));
  (raw.fields as unknown[]).push(future, ...comments);
  const item = await read(raw);
  expect(JSON.parse(item.sshKeyData!).publicKeyOpenSsh).toBe(ssh.publicKeyOpenSsh);
  const output = await encodeBitwardenCipher({ ...item, title: 'Renamed' }, key, raw);
  expect(output.fields).toEqual(expect.arrayContaining([future, ...comments]));
});
