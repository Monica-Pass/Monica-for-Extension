import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../core/model';
import { groupedPasswords } from '../../core/password-groups';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { decodeBitwardenCipher, encodeBitwardenCipher } from './bitwarden-cipher-codec';
import { bitwardenMutationFingerprint } from './bitwarden-durable-sync';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { BitwardenProvider } from './bitwarden-provider';
import { bytesToBase64 } from '../../security/encoding';

const uuid = (value: number) => `00000000-0000-0000-0000-${String(value).padStart(12,'0')}`;
const key = { encKey: new Uint8Array(32).fill(12), macKey: new Uint8Array(32).fill(13) };
const source = (index: number): LoginItem => ({ ...createLoginItem({ title: 'Same title', username: index < 2 ? 'shared' : 'other', password: `password-${index}` }),
  passwordGroupId: uuid(99), providerRefs: [{ providerId: 'bw' }], customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true,
    value: JSON.stringify({ version:1, projectId:uuid(99), groupId:uuid(index < 2 ? 1 : 2), passwordId:uuid(index + 10),
      label: index < 2 ? 'Primary' : 'Recovery', primary:index < 2, groupOrder:index < 2 ? 0 : 1, passwordOrder:index < 2 ? index : 0 }).replace(/}$/, ',"future":9007199254740993}') }] });
const decode = async (item: LoginItem, id: string, provider = 'bw') => {
  const cipher = await encodeBitwardenCipher(item, key);
  return (await decodeBitwardenCipher({ ...cipher, id }, provider, key)).items[0] as LoginItem;
};

it('restores explicit Android Bitwarden project membership through encrypted ciphers and reconnect', async () => {
  const items = await Promise.all([2, 1, 0].map(index => decode(source(index), `cipher-${index}`)));
  expect(items.every(item => item.passwordGroupId === uuid(99))).toBe(true);
  expect(groupedPasswords(items)[0].map(item => item.password)).toEqual(['password-0','password-1','password-2']);
  const otherAccount = await decode(source(0), 'cipher-0', 'another-account');
  const independent = await decode({...source(0),passwordGroupId:undefined,customFields:[]}, 'independent');
  expect(groupedPasswords([...items, otherAccount, independent])).toHaveLength(3);
  for (const item of items) {
    const reopened = await decode({...item, title:'Edited'}, item.bitwardenCipherId!, 'reconnected');
    expect(reopened.passwordGroupId).toBe(uuid(99)); expect(reopened.customFields).toEqual(item.customFields);
  }
});

it('never invents membership from missing, duplicated, malformed or future metadata', async () => {
  const original = source(0);
  for (const fields of [[], [...original.customFields, ...original.customFields],
    original.customFields.map(field=>({...field,value:'{'})),
    original.customFields.map(field=>({...field,value:field.value.replace('"version":1','"version":2')})),
    original.customFields.map(field=>({...field,value:field.value.replace(`"projectId":"${uuid(99)}",`, '')}))]) {
    const item = await decode({...original, passwordGroupId:undefined, customFields:fields}, crypto.randomUUID());
    expect(item.passwordGroupId).toBeUndefined(); expect(item.customFields).toEqual(fields);
  }
});

it('keeps receipt fingerprints compatible with older cached records whose group ID was not projected', async () => {
  const item = await decode(source(0),'cipher');
  expect(await bitwardenMutationFingerprint({...item,passwordGroupId:undefined})).toBe(await bitwardenMutationFingerprint({...item,passwordGroupId:uuid(99)}));
});

it('upgrades older ungrouped cached rows on normal sync without remote writes or changed local identities', async () => {
  const revision = '2026-10-04T01:00:00.000Z';
  const ciphers = await Promise.all([0,1,2].map(async index => ({...await encodeBitwardenCipher(source(index),key),
    id:`cipher-${index}`,revisionDate:revision,creationDate:revision})));
  const fetcher = vi.fn(async (_input:RequestInfo|URL,init?:RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET');
    return new Response(JSON.stringify({profile:{id:'synthetic'},folders:[],ciphers}),{headers:{'Content-Type':'application/json'}});
  });
  const account:ProviderAccount = {id:'bw',kind:'bitwarden',name:'Synthetic',enabled:true,isDefaultSaveTarget:false,
    config:{vaultUrl:'https://synthetic.example.invalid',apiUrl:'https://synthetic.example.invalid/api',identityUrl:'https://synthetic.example.invalid/identity',
      email:'synthetic@example.invalid',deviceId:'synthetic',accessToken:'synthetic',expiresAt:Date.now()+3_600_000,
      kdf:{type:0,iterations:100_000},vaultKeyEnc:bytesToBase64(key.encKey),vaultKeyMac:bytesToBase64(key.macKey)}};
  const provider = new BitwardenProvider(fetcher);
  const first = await provider.sync(account,{now:revision,localItems:[]});
  const cached = first.items.map(item=>({...item,id:`cached-${item.id}`,passwordGroupId:undefined}));
  const before = structuredClone(cached);
  const restored = await provider.sync(account,{now:revision,localItems:cached});
  expect(restored.conflicts).toEqual([]); expect(restored.requestedMutations ?? []).toEqual([]);
  expect(restored.items.map(item=>item.id)).toEqual(cached.map(item=>item.id));
  expect(groupedPasswords(restored.items as LoginItem[]).map(group=>group.length)).toEqual([3]);
  expect(restored.items.map(item=>item.kind==='login' ? item.password : '')).toEqual(['password-0','password-1','password-2']);
  expect(cached).toEqual(before); expect(fetcher).toHaveBeenCalledTimes(2);
});

it('saves complete known Bitwarden projects and queue intents atomically, preserving independent accounts', async () => {
  const items = await Promise.all([0,1,2].map(index=>decode(source(index),`cipher-${index}`)));
  const storage = new MemoryVaultStorage(); const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup('Synthetic project master', items);
  await service.upsertProvider({ id:'bw', kind:'bitwarden', name:'Synthetic', enabled:true, isDefaultSaveTarget:false, config:{} });
  const expected = Object.fromEntries(items.map(item=>[item.id,item.updatedAt]));
  const saved = await service.savePasswordGroup(items.map((item,index)=> index===0 ? {...item,notes:'  shared\r\n',username:'updated'} : item),expected);
  expect(saved.map(item=>item.username)).toEqual(['updated','updated','other']);
  expect(saved.every(item=>item.notes==='  shared\r\n')).toBe(true);
  const state = await service.readState(); expect(state.mutationQueue).toHaveLength(3);
  const before=JSON.stringify(storage.envelope);
  await expect(service.savePasswordGroup(saved.slice(0,2),Object.fromEntries(saved.map(item=>[item.id,item.updatedAt])))).rejects.toThrow();
  expect(JSON.stringify(storage.envelope)).toBe(before);
  const savedExpected=Object.fromEntries(saved.map(item=>[item.id,item.updatedAt]));
  for (const malformed of [
    saved.map(item=>({...item,customFields:[]})),
    saved.map(item=>({...item,customFields:item.customFields.map(field=>({...field,value:field.value.replace(uuid(99),uuid(98))}))})),
    saved.map((item,index)=>index===1?{...item,customFields:saved[0].customFields}:item)
  ]) {
    await expect(service.savePasswordGroup(malformed,savedExpected)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  }
  await service.lock(); expect((await service.unlock('Synthetic project master')).items).toEqual(state.items);
});
