import { SecureVaultService } from '../../../src/security/secure-vault-service';
import { IndexedDbVaultStorage } from '../../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../../src/security/vault-session';
import { createEmptyVaultState, createLoginItem } from '../../../src/core/model';
import { deriveVaultKey, encryptVaultState } from '../../../src/security/vault-crypto';
import { BitwardenProvider } from '../../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenDurableSyncCoordinator } from '../../../src/providers/bitwarden/bitwarden-durable-sync';
import { encodeBitwardenCipher } from '../../../src/providers/bitwarden/bitwarden-cipher-codec';
import { bytesToBase64 } from '../../../src/security/encoding';

const storage = new IndexedDbVaultStorage(), password = 'synthetic record vault password';
const service = () => new SecureVaultService(storage, new MemoryVaultSessionStore());
function check(v: unknown, message: string) { if (!v) throw Error(message); }
async function rejected(fn: () => Promise<unknown>) {
  try { await fn(); } catch { return; } throw Error('Expected operation to be refused');
}
async function dbOp(fn: (s: IDBObjectStore) => void) {
  const db = await new Promise<IDBDatabase>((ok, fail) => {
    const req = indexedDB.open('monica-extension-secure-vault'); req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error);
  });
  try { await new Promise<void>((ok, fail) => {
    const tx = db.transaction('vault', 'readwrite'); fn(tx.objectStore('vault'));
    tx.oncomplete = () => ok(); tx.onabort = () => fail(tx.error);
  }); } finally { db.close(); }
}
export async function compatibility() {
  const s = createEmptyVaultState(), item = createLoginItem({title:'Synthetic legacy', password:'private-record'});
  s.items.push(item);
  s.localItemAttachments = [{itemId:item.id,attachmentId:'synth',fileName:'fixture',dataBase64:'YWJj',sizeBytes:3,sha256:'fixture'}];
  Object.assign(s, { futureVaultField: { untouched:[false, '📦'] } });
  const {key,kdf} = await deriveVaultKey(password), v1 = await encryptVaultState(s,key,kdf);
  // Seed the actual old database version before the production implementation opens it.
  const oldDb = await new Promise<IDBDatabase>((ok,fail)=>{
    const req=indexedDB.open('monica-extension-secure-vault',1);req.onupgradeneeded=()=>req.result.createObjectStore('vault');
    req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error);
  });
  await new Promise<void>((ok,fail)=>{ const tx=oldDb.transaction('vault','readwrite');tx.objectStore('vault').put(v1,'primary');
    tx.oncomplete=()=>ok();tx.onabort=()=>fail(tx.error); }); oldDb.close();
  const blocked = service(), activate = storage.records.activate;
  storage.records.activate = async () => { throw new DOMException('Synthetic interruption','QuotaExceededError'); };
  try {
    await blocked.unlock(password); check((await blocked.readState()).items[0].password === item.password, 'Legacy unavailable after interrupted migration');
    check(JSON.stringify(await storage.read()) === JSON.stringify(v1), 'Legacy envelope changed');
  } finally { storage.records.activate = activate; await blocked.lock(); }
  const active = service(); await active.unlock(password);
  const state = await active.readState();
  check((await storage.read())?.version === 2 && state.localItemAttachments?.[0].dataBase64 === 'YWJj', 'Migration not complete');
  await rejected(()=>new Promise<void>((ok,fail)=>{const req=indexedDB.open('monica-extension-secure-vault',1);
    req.onsuccess=()=>{req.result.close();ok();};req.onerror=()=>fail(req.error);}));
  check(JSON.stringify((await storage.recoveryCopies())[0].envelope) === JSON.stringify(v1), 'Original checkpoint not retained');
  const backup = await active.exportEncryptedBackup(password); check(backup.envelope.version === 1, 'Portable format changed');
  const prior = await storage.read();
  const commit = storage.records.commit;
  storage.records.commit = async (...args) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, name) {
      const req = put.call(this,value,name);
      if (name === 'primary') req.onsuccess = () => this.transaction.abort(); return req;
    };
    try { await commit(...args); } finally { IDBObjectStore.prototype.put = put; }
  };
  try { await rejected(() => active.upsertItem({...item,password:'aborted'})); }
  finally { storage.records.commit = commit; }
  check(JSON.stringify(await storage.read()) === JSON.stringify(prior), 'Partial commit after abort');
  await active.lock(); await active.unlock(password);
  check((await active.readState()).items[0].password === item.password, 'Aborted rows visible');
  await active.upsertItem({...item,password:'committed'}); await active.lock();
  const cold = service(); await cold.unlock(password);
  const after = await cold.readState();
  check(after.items[0].kind === 'login' && after.items[0].password === 'committed' && JSON.stringify(after.localItemAttachments) === JSON.stringify(s.localItemAttachments), 'Cold reopen lost content');
  check(JSON.stringify((after as unknown as Record<string,unknown>).futureVaultField) === JSON.stringify({untouched:[false,'📦']}), 'Unknown field lost');
  await cold.changeMasterPassword(password, 'new synthetic master'); await cold.lock();
  await rejected(() => service().unlock(password));
  check(!(await storage.recoveryCopies()).some(c => JSON.stringify(c.envelope.kdf) === JSON.stringify(v1.kdf)), 'Old protection retained');
  await cold.unlock('new synthetic master'); await cold.readState();
  const activeHead = await storage.read(); await cold.lock();
  await dbOp(store => { const cursor = store.openCursor(IDBKeyRange.bound(['block'], ['block',[]]));
    cursor.onsuccess = () => cursor.result?.delete(); });
  await rejected(() => service().unlock('new synthetic master'));
  check(JSON.stringify(await storage.read()) === JSON.stringify(activeHead), 'Corruption silently rolled back');
  await storage.clear(); const restored = service(); await restored.restoreEncryptedBackup(backup,password);
  check((await restored.readState()).items[0].id === item.id, 'Legacy backup not restorable');
  await restored.lock(); await storage.clear();
  const legacyKey = await deriveVaultKey(password, {name:'PBKDF2-SHA256',iterations:100000,salt:bytesToBase64(new Uint8Array(24).fill(11))});
  const legacy = await encryptVaultState(s, legacyKey.key, legacyKey.kdf);
  await storage.write(legacy);
  const upgrading=service();
  storage.records.activate=async()=>{throw new DOMException('Synthetic quota at KDF cutover','QuotaExceededError');};
  try {
    await upgrading.unlock(password); check(JSON.stringify(await storage.read())===JSON.stringify(legacy),'Failed KDF upgrade changed original bytes');
  } finally {storage.records.activate=activate;await upgrading.lock();}
  await upgrading.unlock(password);
  const hardened=await storage.read();
  check(hardened?.version===2 && hardened.kdf.name==='ARGON2ID' && !(await storage.recoveryCopies()).length,'KDF upgrade retained weaker key or failed to migrate');
  await upgrading.lock(); await upgrading.unlock(password);
  check((await upgrading.readState()).localItemAttachments?.[0].dataBase64==='YWJj','KDF upgrade lost original data');
  await upgrading.lock();
}
export async function syncMeasure(records:boolean) {
  await storage.clear();
  const vault = new SecureVaultService(records ? storage : {read:storage.read.bind(storage),write:storage.write.bind(storage),clear:storage.clear.bind(storage)},new MemoryVaultSessionStore());
  const key={encKey:new Uint8Array(32).fill(7),macKey:new Uint8Array(32).fill(12)}, base='2026-11-12T00:00:00.000Z';
  const template=await encodeBitwardenCipher(createLoginItem({title:'Synthetic',password:'first'}),key);
  const changed=await encodeBitwardenCipher(createLoginItem({title:'Changed',password:'second'}),key);
  const rows=Array.from({length:5000},(_,i)=>({...template,id:'fixture-'+i,revisionDate:base,creationDate:base}));
  const account={id:'synthetic-bw',kind:'bitwarden' as const,name:'Synthetic',enabled:true,isDefaultSaveTarget:false,config:{vaultUrl:'https://site.example.test',apiUrl:'https://site.example.test/api',identityUrl:'https://site.example.test/identity',email:'a@example.test',deviceId:'synthetic',accessToken:'synthetic',expiresAt:Date.now()+3600000,kdf:{type:0,iterations:10000},vaultKeyEnc:bytesToBase64(key.encKey),vaultKeyMac:bytesToBase64(key.macKey)}};
  let full=0,delta=0;
  const bw=new BitwardenProvider(async input=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/sync')){full++;return Response.json({Profile:{Id:'synthetic'},Folders:[],Ciphers:rows});}
    if(path.endsWith('/accounts/revision-date'))return Response.json(1);
    if(path.endsWith('/ciphers/fixture-0/details')){delta++;return Response.json(rows[0]);}
    throw Error('Unexpected synthetic request');
  });
  await vault.setup(password);await vault.upsertProvider(account);
  const coordinator=new BitwardenDurableSyncCoordinator(bw,vault);
  await coordinator.synchronize(account,undefined,{syncHint:{type:'full'}});
  const ms:number[]=[],writes:number[]=[];
  for(let i=0;i<3;i++){
    rows[0]={...(i%2===0?changed:template),id:'fixture-0',revisionDate:'2026-11-12T00:0'+(i+1)+':00.000Z',creationDate:base};
    const put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;let bytes=0;
    const tally=(v:{data?:ArrayBuffer;iv?:Uint8Array})=>{bytes+=v?.data instanceof ArrayBuffer?v.data.byteLength+(v.iv?.byteLength||0):new TextEncoder().encode(JSON.stringify(v)).length;};
    IDBObjectStore.prototype.put=function(v,k){if(this.name==='vault')tally(v);return put.call(this,v,k);};
    IDBObjectStore.prototype.add=function(v,k){if(this.name==='vault')tally(v);return add.call(this,v,k);};
    const start=performance.now();
    try{await coordinator.synchronize(account,undefined,{syncHint:{type:'ciphers',ids:['fixture-0']},diagnosticStartedAt:Date.now()});}
    finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
    ms.push(performance.now()-start);writes.push(bytes);
  }
  await vault.lock();await vault.unlock(password);const state=await vault.readState();
  check(full===1&&delta===3&&state.items.length===5000&&state.sourceRecords.length===5000&&state.items.some(i=>i.kind==='login'&&i.password==='second'),'Incremental sync cold verification failed');
  await vault.lock();return {records,ms,writes};
}
export async function measure(count: number, records: boolean) {
  await storage.clear();
  const store = records ? storage : {read:storage.read.bind(storage), write:storage.write.bind(storage), clear:storage.clear.bind(storage)};
  const vault = new SecureVaultService(store, new MemoryVaultSessionStore());
  const items = Array.from({length:count},(_,i)=>createLoginItem({title:'Synthetic '+i,password:'synthetic credential '+i,username:'synthetic user',uris:['https://site.example.test']}));
  const target = items[Math.floor(count/2)];
  await vault.setup(password,items); await vault.getItem(target.id);
  const ms:number[] = [], writes:number[] = [];
  for (let i=0;i<4;i++) {
    let bytes=0;
    const put=IDBObjectStore.prototype.put, add=IDBObjectStore.prototype.add;
    const tally = (v: {data?: ArrayBuffer;iv?: Uint8Array}) => { bytes += v?.data instanceof ArrayBuffer ? v.data.byteLength+(v.iv?.byteLength || 0) : new TextEncoder().encode(JSON.stringify(v)).length; };
    IDBObjectStore.prototype.put=function(v,k){if(this.name==='vault')tally(v);return put.call(this,v,k);};
    IDBObjectStore.prototype.add=function(v,k){if(this.name==='vault')tally(v);return add.call(this,v,k);};
    const start=performance.now();
    try { await vault.upsertItem({...target,notes:'edit '+i}); } finally {IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
    if(i){ms.push(performance.now()-start);writes.push(bytes);}
  }
  await vault.lock(); await vault.unlock(password); const state=await vault.readState();
  check(state.items.length === count && state.items.find(row=>row.id===target.id)?.notes==='edit 3','Benchmark round trip failed');
  await vault.lock(); return {count,records,ms,writes};
}
