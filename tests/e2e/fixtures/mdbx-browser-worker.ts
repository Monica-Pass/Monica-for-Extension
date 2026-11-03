// Synthetic acceptance only. This file is never an extension entry point.
import { MdbxBrowserSession } from '../../../src/providers/mdbx2/browser/session';
import { MdbxBrowserBlockStore, blockHash, type BrowserCommit } from '../../../src/providers/mdbx2/browser/block-store';
import { MdbxBrowserFilesystem } from '../../../src/providers/mdbx2/browser/filesystem';
import { readMdbx2ContentMetadata } from '../../../src/providers/mdbx2/content-metadata';
import { writeMdbx2Content } from '../../../src/providers/mdbx2/content-write';
import { readMdbx2ContentWriteAnchor } from '../../../src/providers/mdbx2/content-write-anchor';
import { readMdbx2ContentAttachments, readMdbx2ContentAttachmentBytes } from '../../../src/providers/mdbx2/content-attachments';
import { Mdbx2NativeClient } from '../../../src/providers/mdbx2/native-client';
import { captureNearbyNativeSource } from '../../../src/nearby/native-source';
import { planNearbyNativeMetadata, projectNearbyNativeMetadata } from '../../../src/nearby/native-metadata';
import { projectNearbyNativeRecords } from '../../../src/nearby/native-records';
import { clearNearbyNativeAdoption, planNearbyNativeAdoption } from '../../../src/nearby/native-adoption';
import { bytesToBase64 } from '../../../src/security/encoding';
import { SecureVaultService } from '../../../src/security/secure-vault-service';
import { IndexedDbVaultStorage } from '../../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../../src/security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../../../src/security/vault-device-key';
import { nearbyNativeIntent } from '../../../src/nearby/native-journal';
import { nativeNearbySource } from '../../../src/nearby/native-adapter';
import { NearbyLocalCoordinator } from '../../../src/nearby/local-coordinator';
import type { NearbyNativeTransport } from '../../../src/nearby/native-transport';
import type { NearbyIncomingRecord } from '../../../src/nearby/local-adoption';
import { Mdbx2NativeHostError, parseMdbx2NativeResponse, validateMdbx2HostCapabilities, type Mdbx2NativeMethod } from '../../../src/providers/mdbx2/native-contract';
// Packaged by the fixture alongside the production compiled engine.
// @ts-expect-error A generated, external Emscripten module.
import create from './engine.js';

const check = (ok: unknown, reason: string) => { if (!ok) throw Error(reason); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let session: MdbxBrowserSession | undefined;
let recoveryCoordinator: NearbyLocalCoordinator | undefined;
let dbName = '';
const journalStorage = new IndexedDbVaultStorage();
const journalService = new SecureVaultService(journalStorage, new MemoryVaultSessionStore(), Date.now, new MemoryVaultDeviceKeyStore());
async function unlockJournal() {
  const state = await journalService.status();
  if (state === 'uninitialized') await journalService.setup('synthetic-journal-master-password');
  else if (state === 'locked') await journalService.unlock('synthetic-journal-master-password');
  return (await journalService.passkeySessionId())!;
}
let abortNext = false;
let holdBefore = false, holdAfter = false, release: (() => void) | undefined;
const commits: { generation: number; blocks: number; bytes: number; total: number }[] = [];
const put = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args) {
  const result = put.apply(this, args);
  if (abortNext && this.name === 'catalog') { abortNext = false; this.transaction.abort(); }
  return result;
};
class ObservedStore extends MdbxBrowserBlockStore {
  override async commit(plan: BrowserCommit) {
    if (holdBefore) { holdBefore = false; await new Promise<void>(resolve => { release = resolve; postMessage({ event: 'held-before' }); }); }
    await super.commit(plan);
    commits.push({ generation: plan.next.generation, blocks: plan.blocks.length, bytes: plan.blocks.reduce((n, b) => n + b.data.length, 0), total: plan.next.files.reduce((n, f) => n + f.size, 0) });
    if (holdAfter) { holdAfter = false; await new Promise<void>(resolve => { release = resolve; postMessage({ event: 'held-after' }); }); }
  }
}
async function fsSuite() {
  const store = new ObservedStore(`synthetic-fs-${crypto.randomUUID()}`);
  const module = await create({ print: () => {}, printErr: () => {} });
  const fs = module.FS;
  const tracker = new MdbxBrowserFilesystem(fs);
  await tracker.restore(store);
  const save = async () => { const p = await tracker.prepare(); if (p) { await store.commit(p); tracker.accept(p); } return p; };
  const expected = new Uint8Array(4 * 65536 + 13).map((_, i) => i % 251);
  const path = '/monica/blocks';
  fs.writeFile(path, expected);
  await save();
  check(await tracker.prepare() === null, 'unchanged filesystem committed');
  let stream = fs.open(path, 'r+');
  const edit = new Uint8Array([91, 92, 93]); fs.write(stream, edit, 0, edit.length, 65537); fs.close(stream); expected.set(edit, 65537);
  let plan = await save(); check(plan?.blocks.length === 1 && plan.blocks[0].data.length === 65536, 'small edit rewrote unrelated blocks');
  fs.rename(path, '/monica/renamed');
  plan = await save(); check(plan?.blocks.length === 0, 'rename copied file content');
  stream = fs.open('/monica/renamed', 'a'); const append = new Uint8Array([23, 24]); fs.write(stream, append, 0, 2); fs.close(stream);
  plan = await save(); check(plan?.blocks.length === 1 && plan.blocks[0].index === 4, 'append did not update final block');
  // Real MEMFS mapped-write route used by the native runtime.
  stream = fs.open('/monica/renamed', 'r+'); fs.msync(stream, new Uint8Array([17, 18]), 131072, 2, 0); fs.close(stream);
  plan = await save(); check(plan?.blocks.length === 1 && plan.blocks[0].index === 2, 'mapped update missed');
  fs.truncate('/monica/renamed', 65538); fs.truncate('/monica/renamed', expected.length + 2);
  plan = await save(); check(plan && plan.blocks.length === 4, 'truncate/regrow missed zeroed contents');
  const bytes = fs.readFile('/monica/renamed'); check(bytes.slice(65538).every((b: number) => b === 0), 'regrown file not zeroed');
  const before = await store.readHead();
  stream = fs.open('/monica/renamed', 'r+'); fs.write(stream, new Uint8Array([99]), 0, 1, 3); fs.close(stream);
  const uncommitted = await tracker.prepare(); check(uncommitted, 'missing pending edit');
  abortNext = true;
  try { await store.commit(uncommitted!); throw Error('abort was accepted'); } catch (e) { check((e as { code?: string }).code === 'commit-failed', 'wrong abort result'); }
  check(same(await store.readHead(), before), 'aborted transaction advanced catalog');
  const restoredModule = await create({ print: () => {}, printErr: () => {} });
  const restored = new MdbxBrowserFilesystem(restoredModule.FS); await restored.restore(store);
  check(restoredModule.FS.readFile('/monica/renamed')[3] === expected[3], 'aborted write leaked bytes');
  await store.commit(uncommitted!); tracker.accept(uncommitted!);
  const stale = { previous: uncommitted!.next, next: { ...uncommitted!.next, generation: uncommitted!.next.generation + 1 }, blocks: [] };
  fs.unlink('/monica/renamed'); await save(); check((await store.readHead()).files.length === 0, 'delete retained catalog file');
  try { await store.commit(stale); throw Error('stale generation accepted'); } catch (e) { check((e as { code?: string }).code === 'generation-conflict', 'wrong stale generation result'); }
  // Restore from real IDB and verify all block keys were actually removed.
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(store.lockName.slice('monica-mdbx-browser:'.length)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const count = await new Promise<number>((resolve, reject) => { const r = db.transaction('blocks').objectStore('blocks').count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
  check(count === 0, 'delete retained old blocks');
  // Caller buffers change immediately after commit() yields to crypto hashing.
  fs.writeFile('/monica/mutable', expected); const mutable = (await tracker.prepare())!;
  const committing = store.commit(mutable); for (const b of mutable.blocks) b.data.fill(77); await committing; tracker.accept(mutable);
  const committedFile = (await store.readHead()).files[0];
  for (const b of await store.readBlocks(committedFile, 0)) check(b.data.every((v, i) => v === expected[b.index * 65536 + i]), 'caller mutation changed committed bytes');
  module.HEAPU8.fill(0); restoredModule.HEAPU8.fill(0);
  return { smallEditBlocks: 1, appendBlocks: 1, renameContentBlocks: 0, mappedWrites: true, truncateRegrow: true, rollback: true, generationConflict: true, callerMutationIsolated: true, deletedBlocks: count };
}
async function lifecycleSuite() {
  const store = new MdbxBrowserBlockStore(`synthetic-abort-${crypto.randomUUID()}`);
  let count = 0, closeCalls = 0, active = false;
  const aborting = await MdbxBrowserSession.open(async options => {
    const module = await create(options), dispatch = module._mdbx_dispatch.bind(module), close = module._mdbx_close.bind(module);
    module._mdbx_dispatch = () => {
      if (++count === 2) {
        active = true; try { options.onAbort(); check(closeCalls === 0, 'abort reentered Rust'); throw Error('synthetic WASM trap'); } finally { active = false; }
      }
      dispatch();
    };
    module._mdbx_close = () => { check(!active, 'reentrant Rust close'); closeCalls++; close(); };
    return module;
  }, store);
  try { await aborting.request({ protocol: 2, requestId: crypto.randomUUID(), method: 'host.hello', params: {} }); throw Error('trap accepted'); }
  catch (e) { check((e as { code?: string }).code === 'engine-failed', 'wrong trap result'); }
  check(closeCalls === 0, 'called back into aborted engine');
  const recovered = await MdbxBrowserSession.open(create, store); await recovered.close();
  return { noAbortReentry: true, lockReleasedAfterTrap: true };
}
async function action(op: string, data: any): Promise<unknown> {
  if(op==='nearby-local-forward'){
    const sessionId=await unlockJournal(),providerId=(await journalService.readState()).providers.find(p=>p.kind==='local')!.id;
    const snapshot=await journalService.captureNearbyLocalRecords();
    const records=(data.records as NearbyIncomingRecord[]).map(row=>{
      const existing=snapshot.records.find(old=>old.global_id===row.id);
      return existing?{...row,localId:existing.local_id,scope:existing.scope,expectedGuard:existing.guard}:row;
    });
    await journalService.adoptNearbyLocalTransaction({providerId,sourceHash:await journalService.nearbyLocalSnapshotHash(),records,assets:data.assets},sessionId);
    return journalService.captureNearbyLocalRecords();
  }
  if (op === 'content-metadata' || op === 'content-write' || op === 'content-write-anchor' || op === 'content-attachments' || op === 'content-attachment-bytes' || op.startsWith('nearby-native-')) {
    const request = async (method: Mdbx2NativeMethod, params: Record<string, unknown> = {}) => {
      const response = parseMdbx2NativeResponse(await session!.request({ protocol: 2, requestId: crypto.randomUUID(), method, params }));
      if (!response) throw Error('Invalid synthetic native response');
      if (!response.ok) throw new Mdbx2NativeHostError(response.error.code, response.error.message, response.error.retryable);
      return response.result;
    };
    const client = { request, hello: async () => validateMdbx2HostCapabilities(await request('host.hello')) };
    if (op === 'content-write-anchor') return readMdbx2ContentWriteAnchor(client, data.handle, data.writeRevision);
    if (op === 'nearby-native-adopt') {
      const sessionId = await unlockJournal(), source = data.source;
      await journalService.upsertProvider({id:source.providerId,kind:'mdbx2',enabled:true,isDefaultSaveTarget:false,name:'Synthetic sequence source',config:{vaultHandle:source.vaultHandle}});
      const previous = await journalService.nearbySessionPreferences(sessionId);
      if (previous.localProviderId !== source.providerId) await journalService.updateNearbyPreferences({kind:'source',providerId:source.providerId},previous.epoch,sessionId);
      const preferences = await journalService.nearbySessionPreferences(sessionId);
      const typed = new Mdbx2NativeClient({connectNative(){throw Error('Synthetic fixture must use its compiled engine');},disconnectErrorMessage(){return undefined;}});
      typed.request = request;
      const adapter = nativeNearbySource({store:journalService,client:typed,providerId:source.providerId,replicaStorageId:preferences.replicaStorageId,sessionId,
        epoch:()=>preferences.epoch,assertActive:()=>{},signal:new AbortController().signal,exclusive:work=>work()});
      return adapter.adopt({...data.batch,providerId:source.providerId});
    }
    if (op === 'nearby-native-journal-stage') {
      const sessionId = await unlockJournal(), plan = data.plan;
      await journalService.upsertProvider({id:plan.providerId,kind:'mdbx2',enabled:true,isDefaultSaveTarget:false,name:'Synthetic journal source',config:{vaultHandle:plan.vaultHandle}});
      const previous = await journalService.nearbySessionPreferences(sessionId);
      await journalService.updateNearbyPreferences({kind:'source',providerId:plan.providerId},previous.epoch,sessionId);
      const preferences = await journalService.nearbySessionPreferences(sessionId);
      const decode = (write:typeof plan.write) => ({...write,assets:write.assets.map((a:{id:string;base64:string})=>({id:a.id,bytes:Uint8Array.from(atob(a.base64),c=>c.charCodeAt(0))}))});
      const nativePlan = {...plan,write:decode(plan.write),...(plan.remainingWrites?{remainingWrites:plan.remainingWrites.map(decode)}:{})};
      try {
        const anchor = nativePlan.remainingWrites?.length ? await readMdbx2ContentWriteAnchor(client, nativePlan.vaultHandle, nativePlan.write.writeRevision) : undefined;
        const intent = await nearbyNativeIntent(nativePlan, preferences.replicaStorageId, anchor);
        await journalService.stageNearbyNativeIntent(intent, preferences.epoch, sessionId, () => {});
        return { operationId:intent.operationId, acknowledgements:intent.acknowledgements };
      } finally { clearNearbyNativeAdoption(nativePlan); }
    }
    if (op === 'nearby-native-journal-read') return journalService.readNearbyNativeJournal(await unlockJournal());
    if (op === 'nearby-native-coordinator-confirm') {
      check(recoveryCoordinator, 'Synthetic review missing');
      try { return await recoveryCoordinator!.confirmRecovery(data.reviewId); }
      finally { recoveryCoordinator?.close(); recoveryCoordinator = undefined; }
    }
    if (op === 'nearby-native-journal-recover' || op === 'nearby-native-coordinator-recover' || op === 'nearby-native-coordinator-review') {
      const sessionId = await unlockJournal(), preferences = await journalService.nearbySessionPreferences(sessionId);
      const typed = new Mdbx2NativeClient({connectNative(){throw Error('Synthetic fixture must use its compiled engine');},disconnectErrorMessage(){return undefined;}});
      let confirmed=0;
      typed.request = async(method,params)=>{
        if(data?.pauseAfterConfirmedSteps && method==='content.write.begin' && confirmed>=data.pauseAfterConfirmedSteps)throw new Mdbx2NativeHostError('synthetic-interruption','Synthetic receive interruption');
        const result=await request(method,params); if(method==='content.write.finish') {
          confirmed++;
          if (data?.loseConfirmedReply && confirmed === 1) throw new Mdbx2NativeHostError('synthetic-reply-lost', 'Synthetic committed reply loss');
        }
        return result;
      };
      const adapter = nativeNearbySource({store:journalService,client:typed,providerId:preferences.localProviderId,replicaStorageId:preferences.replicaStorageId,sessionId,
        epoch:()=>preferences.epoch,assertActive:()=>{},signal:new AbortController().signal,exclusive:work=>work()});
      const before = await journalService.readNearbyNativeJournal(sessionId);
      if(op==='nearby-native-coordinator-recover' || op==='nearby-native-coordinator-review'){
        let reviewError = '';
        const coordinator=new NearbyLocalCoordinator(journalService,()=>({close(){},async call(){throw Error('Offline recovery attempted LAN access');}} as unknown as NearbyNativeTransport),undefined,undefined,
          async(_preferences,_sessionId,signal,assertActive,epoch)=>{
            const source=nativeNearbySource({store:journalService,client:typed,providerId:preferences.localProviderId,
              replicaStorageId:preferences.replicaStorageId,sessionId,epoch,assertActive,signal,exclusive:work=>work()});
            const review=source.reviewRecovery!.bind(source);
            source.reviewRecovery=async id=>{try{return await review(id);}catch(error){reviewError=error instanceof Error ? error.stack || error.message : String(error);throw error;}};
            return source;
          });
        if(op==='nearby-native-coordinator-review') {
          recoveryCoordinator?.close(); recoveryCoordinator = coordinator;
          try { return await coordinator.reviewRecovery(data.operationId); }
          catch(error) { throw Error(`${String(error)}; synthetic review diagnostic: ${reviewError}`, { cause: error }); }
        }
        try{return await coordinator.recover(data.operationId);}finally{coordinator.close();}
      }
      const acknowledgements = await adapter.recover(data?.operationId);
      const journal = await journalService.readNearbyNativeJournal(sessionId);
      return {before,acknowledgements,journal};
    }
    if (op === 'nearby-native-journal-scan') {
      const envelope = JSON.stringify(await journalStorage.read());
      check((data as string[]).every(secret=>!envelope.includes(secret)), 'plaintext fixture found in journal storage');
      return true;
    }
    if (op === 'nearby-native-source') {
      const typed = new Mdbx2NativeClient({ connectNative() { throw Error('Synthetic fixture must use its compiled engine'); }, disconnectErrorMessage() { return undefined; } });
      typed.request = request; return captureNearbyNativeSource(typed, data);
    }
    if (op === 'nearby-native-metadata') return projectNearbyNativeMetadata(data);
    if (op === 'nearby-native-project') return projectNearbyNativeRecords(data);
    if (op === 'nearby-native-plan') return planNearbyNativeMetadata(data.source, data.operationId, data.changes);
    if (op === 'nearby-native-adopt-plan') {
      const plan = await planNearbyNativeAdoption(data.source, data.batch);
      const encode = (write:Omit<typeof plan.write,'writeRevision'>) => ({...write,assets:write.assets.map(asset=>({id:asset.id,base64:bytesToBase64(asset.bytes)}))});
      try { return { ...plan, write: { ...plan.write, ...encode(plan.write) }, ...(plan.remainingWrites?{remainingWrites:plan.remainingWrites.map(encode)}:{}) }; }
      finally { clearNearbyNativeAdoption(plan); }
    }
    if (op === 'content-attachments') return readMdbx2ContentAttachments(client, data.handle, data.input);
    if (op === 'content-attachment-bytes') {
      const bytes = await readMdbx2ContentAttachmentBytes(client, data.handle, data.input);
      try { return { sizeBytes: bytes.length, sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('') }; }
      finally { bytes.fill(0); }
    }
    if (op === 'content-write') {
      const input = { ...data.input, assets: data.input.assets.map((row: { id: string; base64: string }) => ({ id: row.id, bytes: Uint8Array.from(atob(row.base64), c => c.charCodeAt(0)) })) };
      return writeMdbx2Content(client, data.handle, input);
    }
    return readMdbx2ContentMetadata(client, data.handle, data.input);
  }
  if (op === 'open') { dbName = data.name; session = await MdbxBrowserSession.open(create, new ObservedStore(dbName)); return true; }
  if (op === 'rpc') return session!.request(data);
  if (op === 'close') { await session?.close(); return true; }
  if (op === 'stats') return commits;
  if (op === 'head') return new MdbxBrowserBlockStore(dbName).readHead();
  if (op === 'abort') { abortNext = true; return true; }
  if (op === 'hold') { holdBefore = data === 'before'; holdAfter = data === 'after'; return true; }
  if (op === 'release') { release?.(); release = undefined; return true; }
  if (op === 'fs-suite') return fsSuite();
  if (op === 'lifecycle-suite') return lifecycleSuite();
  if (op === 'scan') {
    const store = new MdbxBrowserBlockStore(dbName), head = await store.readHead();
    const secrets = data as string[];
    for (const file of head.files) {
      let tail = '';
      for (let first = 0; first < file.hashes.length; first += 32) for (const block of await store.readBlocks(file, first)) {
        const text = tail + new TextDecoder().decode(block.data); check(secrets.every(secret => !text.includes(secret)), 'plaintext fixture found in durable storage');
        tail = text.slice(-Math.max(...secrets.map(s => s.length))); block.data.fill(0);
      }
    }
    return { files: head.files.length, bytes: head.files.reduce((n, f) => n + f.size, 0) };
  }
  if (op === 'verify-key') {
    const { payload, expected } = data, key = JSON.parse(payload);
    const decode = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const bytes = decode(key.private_key_alias);
    check(await blockHash(bytes) === expected.hash && key.credential_id === expected.id && key.sign_count === expected.counter, 'Passkey key/identity/counter changed');
    const privateKey = await crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); bytes.fill(0);
    const publicKey = await crypto.subtle.importKey('spki', decode(expected.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, challenge);
    check(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, challenge), 'original public key rejected signature');
    return true;
  }
  throw Error('unknown fixture action');
}
onmessage = ({ data: { id, op, data } }) => {
  void action(op, data).then(result => postMessage({ id, result }), error => postMessage({ id, error: { code: error?.code, message: error?.message } }));
};
