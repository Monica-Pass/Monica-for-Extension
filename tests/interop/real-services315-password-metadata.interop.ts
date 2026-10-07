import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey, encryptBitwardenString, decryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';
import { encodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';

it.skipIf(!process.env.MONICA_315_REAL_SERVICES_CONFIG)('clears Android password metadata through real Vaultwarden writes and reconnect', async () => {
  const config = JSON.parse(await readFile(resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!), 'utf8')).vaultwarden as { baseUrl: string; password: string };
  expect(new URL(config.baseUrl).hostname).toBe('127.0.0.1');
  await mkdir(resolve('.tmp/password-metadata-real-services'), { recursive: true });
  const output = await mkdtemp(join(resolve('.tmp/password-metadata-real-services'), 'run-'));
  const checks: string[] = [];
  try {
    const client = new BitwardenClient();
    const email = `icon-${randomUUID()}@example.invalid`;
    const master = await deriveBitwardenMasterKey(config.password, email, { type: 0, iterations: 600000 });
    const vaultKey = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
    try {
      const response = await fetch(`${config.baseUrl}/identity/accounts/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email, name: 'Synthetic password metadata test', masterPasswordHash: await deriveBitwardenMasterPasswordHash(master, config.password),
        key: await client.protectVaultKey(vaultKey, await stretchBitwardenMasterKey(master), crypto.getRandomValues(new Uint8Array(16))), kdf: 0, kdfIterations: 600000
      }) });
      expect(response.ok).toBe(true);
    } finally { master.fill(0); vaultKey.encKey.fill(0); vaultKey.macKey.fill(0); }
    const login = await client.login({ vaultUrl: config.baseUrl, email, masterPassword: config.password, deviceId: randomUUID() });
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    let account: ProviderAccount = { id: 'metadata-old', kind: 'bitwarden', name: 'Synthetic metadata', enabled: true, isDefaultSaveTarget: false, config: login.session };
    const provider = new BitwardenProvider();
    const metadata = {appPackageName:'example.app',appName:'Example',email:'contact@example.test',phone:'+12345',addressLine:'1 Main Street',city:'Test City',state:'Test State',zipCode:'12345',country:'Test Country',passkeyBindings:'[{"credentialId":"sample","future":true}]'};
    const seedKey = client.vaultKey(login.session);
    let cipherId: string;
    try {
      const payload = await encodeBitwardenCipher({ ...createLoginItem({title:'Metadata account',username:email,password:'synthetic',providerRefs:[{providerId:account.id}]}),...metadata }, seedKey);
      const fields = payload.fields as Record<string, unknown>[];
      for (const field of fields) if (await decryptBitwardenString(field.name as string, seedKey) === 'monica_city') {
        field.name = await encryptBitwardenString('city', seedKey); field.type = 1;
      }
      fields.unshift({ name: await encryptBitwardenString('city', seedKey), value: await encryptBitwardenString('Older city', seedKey), type: 1, linkedId: null });
      const created = await client.createCipher(login.session, payload);
      cipherId = String(created.payload.id ?? created.payload.Id);
    } finally { seedKey.encKey.fill(0); seedKey.macKey.fill(0); }
    const remoteFields = async () => {
      const raw = (await client.getCipherDetails(login.session, cipherId)).payload!;
      const key = client.vaultKey(login.session);
      try { return await Promise.all(((raw.fields ?? raw.Fields) as Record<string,unknown>[] || []).map(async field => ({
        name: await decryptBitwardenString((field.name ?? field.Name) as string, key),
        value: await decryptBitwardenString((field.value ?? field.Value) as string, key), type: field.type ?? field.Type
      }))); } finally { key.encKey.fill(0); key.macKey.fill(0); }
    };
    account={...account,id:'metadata-reconnected'};
    const read=async()=>{
      const items=(await new BitwardenProvider().sync(account,{now:new Date().toISOString(),localItems:[]})).items;
      expect(items).toHaveLength(1);expect(items[0].kind).toBe('login');return items[0] as LoginItem;
    };
    let item=await read();expect(item).toMatchObject(metadata);checks.push('create-reconnect');
    await provider.update(account,{...item,title:'Renamed'});item=await read();expect(item).toMatchObject(metadata);checks.push('unrelated-edit');
    const renamedFields = await remoteFields();
    expect(renamedFields.filter(field => field.name === 'city')).toEqual([
      {name:'city',value:'Older city',type:1},{name:'city',value:'Test City',type:1}
    ]);
    expect(renamedFields.find(field => field.name === 'address')?.type).toBe(1);
    checks.push('hidden-city-duplicates-and-composite-protection');
    await provider.update(account,{...item,addressLine:undefined});item=await read();expect(item.addressLine).toBeUndefined();expect(item.city).toBe(metadata.city);expect(item.country).toBe(metadata.country);checks.push('street-cleared-with-city-retained');
    const keys=Object.keys(metadata) as Array<keyof typeof metadata>;
    const cleared={...item};for(const name of keys) cleared[name]=undefined;
    await provider.update(account,cleared);item=await read();
    for(const name of keys) expect(item[name]).toBeUndefined();
    expect(item.password).toBe('synthetic');expect(item.customFields).toEqual([]);checks.push('all-metadata-cleared-password-unchanged');
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ status: 'passed', checks, androidVerified: false }, null, 2));
  } catch (error) {
    await writeFile(join(output, 'evidence.json'), JSON.stringify({ status: 'failed', checks, error: String(error) }, null, 2));
    throw error;
  }
});
