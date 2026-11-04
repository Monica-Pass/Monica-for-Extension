import { describe, expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount, type TotpItem, type VaultItem } from '../core/model';
import { decodeBitwardenCipher, encodeBitwardenCipher } from '../providers/bitwarden/bitwarden-cipher-codec';
import { selectAuthenticatorItems } from './authenticator-items';

const key = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(12) };
const providers: ProviderAccount[] = ['bw-a', 'bw-b'].map(id => ({ id, kind: 'bitwarden', name: 'Bitwarden', enabled: true, isDefaultSaveTarget: false, config: {} }));
const secret = 'JBSWY3DPEHPK3PXP';
async function pair(id = 'cipher', provider = 'bw-a', otp = secret): Promise<[LoginItem, TotpItem]> {
  const login = { ...createLoginItem({ title: 'Same title', username: 'same-user', password: 'synthetic-password' }), totpSecret: otp };
  const decoded = await decodeBitwardenCipher({ ...await encodeBitwardenCipher(login, key), id, revisionDate: login.updatedAt }, provider, key);
  expect(decoded.items.map(item => item.kind)).toEqual(['login', 'totp']);
  return decoded.items as [LoginItem, TotpItem];
}

describe('authenticator display rows', () => {
  it.each([false, true])('shows one projection per real decoded cipher without altering data (reverse=%s)', async reverse => {
    const [login, otp] = await pair();
    const items = reverse ? [otp, login] : [login, otp], before = structuredClone(items);
    expect(selectAuthenticatorItems(items, providers)).toEqual([otp]);
    expect(selectAuthenticatorItems(items, providers)[0]).toBe(otp);
    expect(items).toEqual(before);
  });

  it('uses provider references when local creation preserved different item IDs', async () => {
    const [login, otp] = await pair(); login.id = 'local-login'; otp.id = 'local-otp';
    expect(selectAuthenticatorItems([login, otp], providers)).toEqual([otp]);
  });

  it('keeps identical keys and labels in separate ciphers and accounts', async () => {
    const pairs = await Promise.all([pair('first'), pair('second'), pair('first', 'bw-b')]);
    expect(selectAuthenticatorItems(pairs.flat(), providers)).toEqual(pairs.map(items => items[1]));
    expect(selectAuthenticatorItems([pairs[0][0], pairs[1][1], pairs[2][1]], providers)).toHaveLength(3);
  });

  it('keeps standalone validators and inline local/KeePass logins', async () => {
    const [login, otp] = await pair();
    const local = { ...login, id: 'local', providerRefs: [] };
    const keepass = { ...login, id: 'keepass', providerRefs: [{ providerId: 'kp', remoteId: 'cipher' }] };
    const items = [local, keepass, otp];
    expect(selectAuthenticatorItems(items, providers)).toEqual(items);
  });

  it.each(['absent', 'deleted', 'archived', 'filtered'] as const)('keeps the inline login when its projection is %s', async mode => {
    const [login, otp] = await pair();
    if (mode === 'deleted') otp.deletedAt = '2026-11-04';
    if (mode === 'archived') otp.archivedAt = '2026-11-04';
    const items = mode === 'absent' || mode === 'filtered' ? [login] : [login, otp];
    expect(selectAuthenticatorItems(items, providers)).toEqual([login]);
  });

  it.each(['secret', 'algorithm', 'digits', 'period', 'otpType', 'counter', 'pin', 'pinLength'] as const)('preserves an inconsistent %s projection', async field => {
    const [login, otp] = await pair();
    Object.assign(otp, { [field]: { secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'SHA256', digits: 8, period: 60, otpType: 'HOTP', counter: 9, pin: '1234', pinLength: 4 }[field] });
    expect(selectAuthenticatorItems([login, otp], providers)).toEqual([login, otp]);
  });

  it.each(['missing-provider', 'other-kind', 'other-source', 'other-cipher', 'bad-suffix', 'multiple-sources'] as const)('does not collapse unproven source identity: %s', async mode => {
    const [login, otp] = await pair();
    let accounts = providers;
    if (mode === 'missing-provider') accounts = [];
    if (mode === 'other-kind') accounts = providers.map(provider => ({ ...provider, kind: 'keepass' }));
    if (mode === 'other-source') otp.providerRefs[0].providerId = 'bw-b';
    if (mode === 'other-cipher') otp.providerRefs[0].remoteId = 'other#totp';
    if (mode === 'bad-suffix') otp.providerRefs[0].remoteId = 'cipher#totp-extra';
    if (mode === 'multiple-sources') login.providerRefs.push({ providerId: 'bw-b', remoteId: 'cipher' });
    expect(selectAuthenticatorItems([login, otp], accounts)).toEqual([login, otp]);
  });

  it.each([
    `otpauth://hotp/Test?secret=${secret}&counter=9007199254740993&digits=8&algorithm=SHA256`,
    `otpauth://totp/Test?secret=${secret}&period=60&digits=8&algorithm=SHA512`,
    `otpauth://totp/Steam?secret=${secret}&encoder=steam`,
    `motp://Example:user?secret=0123456789abcdef&pin=1234`,
    `otpauth://yaotp/Yandex?secret=${secret}&pin=1234&pin_length=4`
  ])('retains the same complete OTP parameters for %s', async uri => {
    const items = await pair('cipher', 'bw-a', uri);
    expect(selectAuthenticatorItems(items, providers)).toEqual([items[1]]);
  });

  it('retains unsupported inline values and hides neither archived nor deleted data through an active alias', async () => {
    const [login, otp] = await pair();
    login.totpSecret = 'otpauth://unknown/Test?secret=bad';
    expect(selectAuthenticatorItems([login, otp], providers)).toEqual([login, otp]);
    const hidden: VaultItem[] = [{ ...login, archivedAt: '2026-11-04' }, { ...otp, deletedAt: '2026-11-04' }];
    expect(selectAuthenticatorItems(hidden, providers)).toEqual([]);
  });
});
