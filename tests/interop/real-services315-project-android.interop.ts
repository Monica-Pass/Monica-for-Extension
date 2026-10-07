import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { LoginItem, ProviderAccount } from '../../src/core/model';
import { groupedPasswords } from '../../src/core/password-groups';
import { parseLosslessJson } from '../../src/core/lossless-json';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../../src/core/project-credentials';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { decryptBitwardenString } from '../../src/providers/bitwarden/bitwarden-crypto';
import { resolveBitwardenCipherKey } from '../../src/providers/bitwarden/bitwarden-cipher-codec';

const path = process.env.MONICA_BW_PROJECT_EDGE_READBACK;
const directory = process.env.MONICA_315_APP_FIXTURE;
const stage = process.env.MONICA_BW_PROJECT_ANDROID_STAGE ?? 'prepare';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cipherId = (item: LoginItem) => item.bitwardenCipherId ?? item.providerRefs.find(ref => ref.remoteId)?.remoteId;
const snapshot = (item: LoginItem) => ({ cipherId: cipherId(item), projectId: item.passwordGroupId ?? '', title: item.title,
  username: item.username, password: item.password, notes: item.notes, otp: item.totpSecret ?? '', website: item.uris[0] ?? '',
  fields: item.customFields.map(field => ({ name: field.name, value: field.value, protected: field.protected })) });
const comparable = (row: ReturnType<typeof snapshot>) => ({ ...row, fields: row.fields.map(field => ({ ...field,
  value: field.name === PROJECT_CREDENTIAL_FIELD ? parseLosslessJson(field.value) : field.value })).sort((a,b) => a.name.localeCompare(b.name)) });

it.skipIf(!path || !directory)(`actual Android Bitwarden projects ${stage}`, async () => {
  if (!['prepare', 'return'].includes(stage)) throw new Error('Choose prepare or return');
  const input = JSON.parse(await readFile(resolve(path!), 'utf8')) as {synthetic:boolean;fixturePath:string;items:LoginItem[]};
  expect(input.synthetic).toBe(true); expect(input.items).toHaveLength(9);
  const fixture = JSON.parse(await readFile(input.fixturePath, 'utf8'));
  expect(fixture.baseUrl).toBe('http://127.0.0.1:18316'); expect(fixture.email).toMatch(/^project-[0-9a-f-]{36}@example\.invalid$/);
  const root = resolve(directory!); await mkdir(root, {recursive:true});
  const report:Record<string,unknown> = {status:'failed',stage};
  try {
    const login = await new BitwardenClient().login({vaultUrl:fixture.baseUrl,email:fixture.email,masterPassword:fixture.password,deviceId:randomUUID()});
    if (login.status !== 'authenticated') throw new Error('Synthetic login failed');
    const account:ProviderAccount = {id:'android-server-return',name:'Synthetic',kind:'bitwarden',enabled:true,isDefaultSaveTarget:false,config:login.session};
    const items = (await new BitwardenProvider().sync(account,{now:new Date().toISOString(),localItems:[]})).items as LoginItem[];
    expect(items).toHaveLength(9); expect(groupedPasswords(items).map(group=>group.length).sort((a,b)=>a-b)).toEqual([1,2,6]);
    const remote = await new BitwardenClient().sync(login.session);
    const vaultKey = {encKey:new Uint8Array(Buffer.from(login.session.vaultKeyEnc,'base64')),macKey:new Uint8Array(Buffer.from(login.session.vaultKeyMac,'base64'))};
    const rawCiphers = (remote.payload.ciphers ?? remote.payload.Ciphers) as Record<string,unknown>[];
    const androidFields = new Map<string,ReturnType<typeof snapshot>['fields']>();
    try {
      for (const raw of rawCiphers) {
        const id = String(raw.id??raw.Id), item = items.find(item=>cipherId(item)===id)!;
        const cipherKey = await resolveBitwardenCipherKey(raw,vaultKey);
        try {
          const rawFields=(raw.fields??raw.Fields??[]) as Record<string,unknown>[];
          const decoded = await Promise.all(rawFields.map(async field=>{
            const type=field.type??field.Type??0; expect([0,1]).toContain(type);
            return {name:await decryptBitwardenString((field.name??field.Name) as string,cipherKey),
              value:await decryptBitwardenString((field.value??field.Value) as string,cipherKey),protected:type===1};
          }));
          // Current Android treats icon transport fields as user fields. Check their exact
          // encrypted server values; only the two email aliases belong to its dedicated model here.
          const expectedNames=new Set([...item.customFields.map(field=>field.name),
            'monica_custom_icon_type','monica_custom_icon_value','monica_custom_icon_updated_at','monica_email','email']);
          for(const field of decoded)expect(expectedNames.has(field.name),`Unexpected raw field ${field.name}`).toBe(true);
          androidFields.set(id,decoded.filter(field=>field.name!=='monica_email'&&field.name!=='email'));
        } finally {if(cipherKey!==vaultKey){cipherKey.encKey.fill(0);cipherKey.macKey.fill(0);}}
      }
    } finally {vaultKey.encKey.fill(0);vaultKey.macKey.fill(0);}
    const androidSnapshot=(item:LoginItem)=>({...snapshot(item),fields:androidFields.get(cipherId(item)!)!});
    report.serverFieldNames=[...androidFields].map(([cipherId,fields])=>({cipherId,names:fields.map(field=>field.name)}));
    if (stage === 'prepare') {
      for (const expected of input.items) expect(comparable(snapshot(items.find(item=>cipherId(item)===cipherId(expected))!))).toEqual(comparable(snapshot(expected)));
      const payload = {synthetic:true,baseUrl:fixture.baseUrl,email:fixture.email,projectId:fixture.projectId,
        accessToken:login.session.accessToken,vaultKeyEnc:login.session.vaultKeyEnc,vaultKeyMac:login.session.vaultKeyMac,items:items.map(androidSnapshot)};
      const bytes = Buffer.from(JSON.stringify(payload,null,2));
      await writeFile(join(root,'bitwarden-project-input.json'),bytes);
      report.inputSha256 = hash(bytes);
    } else {
      const device = JSON.parse(await readFile(join(root,'bitwarden-project-evidence.json'),'utf8'));
      const build = JSON.parse(await readFile(join(root,'build-evidence.json'),'utf8'));
      expect(device.status).toBe('passed'); expect(build.status).toBe('passed');
      expect(device.installedTestApkSha256).toBe(build.builtTestApkSha256);
      expect(device.baseline).toEqual(build.baseline); expect(device.testSourceHashes).toEqual(build.testSourceHashes);
      for (const invariant of ['installedApplicationUnchanged','installedTestApkUnchanged','androidSourcesUnchanged','testSourcesUnchanged','deviceBootUnchanged']) expect(device[invariant],invariant).toBe(true);
      expect(device.androidVersion).toMatch(/^1\.0\.317-/);
      const returnedBytes = await readFile(join(root,'bitwarden-project-return.json'));
      expect(hash(returnedBytes)).toBe(device.outputs.find((row:{name:string})=>row.name==='bitwarden-project-return.json').sha256);
      const returned = JSON.parse(returnedBytes.toString('utf8'));
      expect(returned.status).toBe('passed'); expect(returned.before).toHaveLength(9); expect(returned.after).toHaveLength(9);
      for (const expected of returned.after) {
        const actual = androidSnapshot(items.find(item=>cipherId(item)===expected.cipherId)!);
        expect(comparable(actual)).toEqual(comparable({...expected,projectId:expected.projectId??''}));
      }
      const project = items.filter(item=>item.passwordGroupId===fixture.projectId);
      expect(project).toHaveLength(6);
      const originalProject = input.items.filter(item=>item.passwordGroupId===fixture.projectId);
      const previousOwner=originalProject.find(item=>{const meta=readProjectCredential(item.customFields)!;return meta.primary&&meta.passwordOrder===0;})!;
      for (const item of items) {
        const original = input.items.find(before=>cipherId(before)===cipherId(item))!;
        if (item.passwordGroupId !== fixture.projectId) expect(comparable(snapshot(item))).toEqual(comparable(snapshot(original)));
        else {
          expect(item.password).toBe(original.password); expect(item.notes).toBe('  Android HTTP 回写\r\n\t保留  ');
          expect([item.customIconType,item.customIconValue,item.customIconUpdatedAt]).toEqual([original.customIconType,original.customIconValue,original.customIconUpdatedAt]);
          const meta = readProjectCredential(item.customFields)!; const beforeMeta = readProjectCredential(original.customFields)!;
          expect(meta.passwordId).toBe(beforeMeta.passwordId); expect(meta.groupId).toBe(beforeMeta.groupId);
          if (meta.primary) {
            expect(item.username).toBe('android-server-user'); expect(meta.label).toBe('Android 服务回写');
            expect(meta.passwordOrder).toBe(originalProject.filter(row=>readProjectCredential(row.customFields)!.primary).length - 1 - beforeMeta.passwordOrder);
          }
          // Android's group writer applies the editor's common fields to the resulting first row.
          // This fixture reverses an unadorned appended password into first place; the previous
          // owner's common field is copied there while all original row fields remain retained.
          const fieldSource=meta.primary&&meta.passwordOrder===0?previousOwner:original;
          const beforeFields = fieldSource.customFields.filter(field=>field.name!==PROJECT_CREDENTIAL_FIELD);
          expect(item.customFields.filter(field=>field.name!==PROJECT_CREDENTIAL_FIELD)).toEqual(beforeFields);
          const beforeRaw = parseLosslessJson(original.customFields.find(field=>field.name===PROJECT_CREDENTIAL_FIELD)!.value) as Record<string, unknown>;
          const afterRaw = parseLosslessJson(item.customFields.find(field=>field.name===PROJECT_CREDENTIAL_FIELD)!.value);
          expect(afterRaw).toEqual({...beforeRaw,label:meta.primary?'Android 服务回写':beforeMeta.label,passwordOrder:meta.passwordOrder});
        }
      }
      Object.assign(report,{androidVersion:device.androidVersion,installedApkSha256:device.installedApkSha256,
        installedTestApkSha256:device.installedTestApkSha256,baseline:device.baseline,returnSha256:hash(returnedBytes),checks:[
          'real server to actual Android storage','Android project writer changes shared username/notes/label and password order',
          'real Android encrypted upload','fresh Android download reconstructs same rows','independent extension HTTP readback',
          'nine rows; no secret or identity loss; unrelated projects unchanged']});
      const edgeBytes = Buffer.from(JSON.stringify({synthetic:true,fixturePath:input.fixturePath,items},null,2));
      await writeFile(join(root,'edge-return-fixture.json'),edgeBytes);
      report.edgeFixtureSha256 = hash(edgeBytes);
    }
    Object.assign(report,{status:'passed',items:items.length,groups:[1,2,6]});
  } catch(error) {report.error=error instanceof Error?error.message:String(error);throw error;}
  finally {await writeFile(join(root,`bitwarden-project-${stage}-evidence.json`),JSON.stringify(report,null,2));}
});
