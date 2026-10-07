import { expect, it } from 'vitest';
import { createLoginItem } from '../../core/model';
import { encodeBitwardenCipher, decodeBitwardenCipher } from './bitwarden-cipher-codec';
import type { LoginItem } from '../../core/model';
import { encryptBitwardenString, type BitwardenSymmetricKey } from './bitwarden-crypto';
const key:BitwardenSymmetricKey={encKey:new Uint8Array(32).fill(3),macKey:new Uint8Array(32).fill(4)};

it.each([1,5])('rejects malformed SSH without producing a destructive Type %s cipher',async type=>{
  const raw=type===5?{type:5,sshKey:{privateKey:await encryptBitwardenString('private',key),future:'keep'}}:await encodeBitwardenCipher({...createLoginItem({title:'SSH'}),loginType:'SSH_KEY',sshKeyData:'{"privateKeyOpenSsh":"private"}'},key);
  const before=JSON.stringify(raw);
  for(const sshKeyData of ['{','[]','null','"text"','{"privateKeyOpenSsh":42}','{"keySize":1.2}','{"keySize":-1}','{"keySize":9007199254740993}','{"keySize":"4096"}']) {
    await expect(encodeBitwardenCipher({...createLoginItem({title:'Must not apply'}),loginType:'SSH_KEY',sshKeyData},key,raw)).rejects.toThrow('SSH');
    expect(JSON.stringify(raw)).toBe(before);
  }
});

it.each(['', '  '])('treats an explicitly blank SSH payload as a clear (%j)',async sshKeyData=>{
  const raw=await encodeBitwardenCipher({...createLoginItem({title:'SSH'}),loginType:'SSH_KEY',sshKeyData:'{"privateKeyOpenSsh":"private"}'},key);
  const item=(await decodeBitwardenCipher({...raw,id:'cipher'},'source',key)).items[0] as LoginItem;
  const output=await encodeBitwardenCipher({...item,sshKeyData},key,raw);
  const reopened=(await decodeBitwardenCipher({...output,id:'cipher'},'source',key)).items[0] as LoginItem;
  expect(JSON.parse(reopened.sshKeyData!).privateKeyOpenSsh).toBe('');
});
