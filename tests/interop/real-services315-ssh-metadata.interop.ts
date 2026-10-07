import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../../src/core/model';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, deriveBitwardenMasterPasswordHash, stretchBitwardenMasterKey, decryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';


it.skipIf(!process.env.MONICA_315_REAL_SERVICES_CONFIG)('clears SSH fallback metadata through real Vaultwarden writes and reconnect', async () => {
  const config = JSON.parse(await readFile(resolve(process.env.MONICA_315_REAL_SERVICES_CONFIG!), 'utf8')).vaultwarden as { baseUrl: string; password: string };
  expect(new URL(config.baseUrl).hostname).toBe('127.0.0.1');
  await mkdir(resolve('.tmp/ssh-metadata-real-services'), { recursive: true });
  const output = await mkdtemp(join(resolve('.tmp/ssh-metadata-real-services'), 'run-'));
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
    const ssh = { algorithm: 'RSA', keySize: 4096, publicKeyOpenSsh: 'ssh-rsa synthetic', privateKeyOpenSsh: 'synthetic-private', fingerprintSha256: 'SHA256:synthetic', comment: 'Synthetic comment', format: 'PEM' };
    const created = await provider.create(account, { ...createLoginItem({title:'SSH metadata',providerRefs:[{providerId:account.id}]}), loginType:'SSH_KEY', sshKeyData:JSON.stringify(ssh) });
    account = {...account,id:'ssh-reconnected'};
    const read = async () => {
      const result = await new BitwardenProvider().sync(account,{now:new Date().toISOString(),localItems:[]});
      expect(result.items).toHaveLength(1);
      return result.items[0] as LoginItem;
    };
    let item = await read();
    expect(item.bitwardenSshKeyMode).toBe('fallback');
    expect(JSON.parse(item.sshKeyData!)).toEqual(ssh);
    checks.push('fallback-create-reconnect');
    await provider.update(account,{...item,title:'Renamed SSH'});
    item=await read();expect(JSON.parse(item.sshKeyData!)).toEqual(ssh);
    checks.push('unrelated-rename');
    for (const property of Object.keys(ssh) as Array<keyof typeof ssh>) {
      const current = JSON.parse(item.sshKeyData!);
      current[property] = property === 'keySize' ? 0 : '';
      await provider.update(account,{...item,sshKeyData:JSON.stringify(current)});
      item=await read();
      expect(JSON.parse(item.sshKeyData!)).toEqual({...current,format:property==='format'?'OPENSSH':current.format});
      checks.push(`cleared-${property}-reconnected`);
    }
    await provider.update(account,{...item,sshKeyData:undefined});
    item=await read();
    expect(item.loginType).toBe('SSH_KEY');
    expect(JSON.parse(item.sshKeyData!)).toEqual({algorithm:'',keySize:0,publicKeyOpenSsh:'',privateKeyOpenSsh:'',fingerprintSha256:'',comment:'',format:'OPENSSH'});
    checks.push('all-cleared-reconnected');
    const raw=(await client.getCipherDetails(login.session,String(created.providerRefs[0].remoteId))).payload!;
    const readKey=client.vaultKey(login.session);
    try {
      const names=await Promise.all(((raw.fields??raw.Fields??[]) as Record<string,unknown>[]).map(field=>decryptBitwardenString(String(field.name??field.Name),readKey)));
      expect(names.some(name=>name.startsWith('monica_ssh_'))).toBe(false);
      checks.push('remote-raw-fields-cleared');
    } finally {readKey.encKey.fill(0);readKey.macKey.fill(0);}
    await writeFile(join(output,'evidence.json'),JSON.stringify({status:'passed',checks,androidVerified:false},null,2));
  } catch(error) {
    await writeFile(join(output,'evidence.json'),JSON.stringify({status:'failed',checks,error:String(error)},null,2));
    throw error;
  }
});
