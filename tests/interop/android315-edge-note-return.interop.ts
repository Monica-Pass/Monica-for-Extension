import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { LoginItem, SecureNoteItem } from '../../src/core/model';
import { resolveBoundNote } from '../../src/core/bound-notes';
import { readAndroidBackup } from '../../src/providers/webdav/android-backup-codec';
import { decryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';
import { WebDavClient } from '../../src/providers/webdav/webdav-client';

const directory=process.env.MONICA_315_APP_FIXTURE;
if (!directory) throw new Error('An explicit MONICA_315_APP_FIXTURE directory is required');
const root=resolve(directory), stage=process.env.MONICA_EDGE_NOTE_STAGE || 'prepare';
if (!['prepare','verify','publish','final'].includes(stage)) throw new Error('Unknown Edge note roundtrip stage');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const noteSnapshot=(note?:SecureNoteItem)=>note?{title:note.title,content:note.content,notes:note.notes,tags:note.tags||[],isMarkdown:Boolean(note.isMarkdown),favorite:note.favorite,customFields:note.customFields||[]}:null;
const loginSnapshot=(item:LoginItem)=>({title:item.title,username:item.username,password:item.password,notes:item.notes,uris:item.uris,favorite:item.favorite,loginType:item.loginType,customFields:item.customFields});
const decode=async(bytes:Uint8Array,providerId:string)=>readAndroidBackup(await decryptAndroidBackup(bytes,'synthetic archive password'),providerId);

it(`real Edge -> Android -> Edge note archive: ${stage}`,async()=>{
  await mkdir(root,{recursive:true});
  const report:Record<string,unknown>={stage,status:'failed',at:new Date().toISOString()};
  try {
    if(stage==='prepare') {
      const sourceRun=process.env.MONICA_EDGE_NOTE_UI_RUN;
      if(!sourceRun) throw new Error('MONICA_EDGE_NOTE_UI_RUN must name the actual successful Edge run');
      const edge=await json(join(sourceRun,'evidence.json'));
      expect(edge.status).toBe('passed');expect(edge.webdavNotes.status).toBe('passed');expect(edge.nativeRegistryRestored).toBe(true);
      const archiveRoot=dirname(edge.webdavNotes.fixture);
      const readback=await json(join(archiveRoot,'remote-readback.json'));expect(readback.status).toBe('passed');
      const bytes=await readFile(join(archiveRoot,'edge-note-return.zip'));
      expect(hash(bytes)).toBe(readback.archiveSha256);
      const document=await decode(bytes,'edge-note-source');expect(document.items).toHaveLength(8);
      const logins=document.items.filter((item):item is LoginItem=>item.kind==='login');
      const notes=document.items.filter((item):item is SecureNoteItem=>item.kind==='secure-note');
      expect(logins).toHaveLength(5);expect(notes).toHaveLength(3);
      expect(new Set(logins.map(item=>item.title)).size).toBe(5);
      expect(logins.filter(item=>!resolveBoundNote(item,document.items))).toHaveLength(1);
      const expected={logins:logins.map(item=>({...loginSnapshot(item),note:noteSnapshot(resolveBoundNote(item,document.items))})),notes:notes.map(noteSnapshot)};
      await writeFile(join(root,'edge-note.zip'),bytes);
      await writeFile(join(root,'edge-note-expected.json'),JSON.stringify(expected,null,2));
      Object.assign(report,{sourceRun:resolve(sourceRun),sourceArchive:join(archiveRoot,'edge-note-return.zip'),sourceArchiveSha256:hash(bytes),recordCount:8});
    } else if(stage==='verify') {
      const prepared=await json(join(root,'edge-note-prepare-evidence.json'));expect(prepared.status).toBe('passed');
      expect(hash(await readFile(join(root,'edge-note.zip')))).toBe(prepared.sourceArchiveSha256);
      const device=await json(join(root,'edge-note-import-evidence.json'));expect(device.status).toBe('passed');
      const build=await json(join(root,'build-evidence.json'));expect(build.status).toBe('passed');
      expect(device.installedTestApkSha256).toBe(build.builtTestApkSha256);
      expect(device.testSourceHashes).toEqual(build.testSourceHashes);
      expect(device.installedApkSha256).toBe(build.installedApkSha256);
      for(const key of ['androidSourcesUnchanged','testSourcesUnchanged','installedApplicationUnchanged','installedTestApkUnchanged','deviceBootUnchanged']) expect(device[key],key).toBe(true);
      expect(device.inputs[0].sha256).toBe(prepared.sourceArchiveSha256);
      const bytes=await readFile(join(root,'android-edge-note-return.zip'));
      expect(hash(bytes)).toBe(device.outputs.find((file:{name:string})=>file.name==='android-edge-note-return.zip').sha256);
      const restored=await json(join(root,'android-edge-note-restore.json'));expect(restored.status).toBe('passed');expect(restored.imported).toBe(8);
      expect(restored.links).toHaveLength(5);expect(restored.links.filter((link:{targetFound:boolean})=>link.targetFound)).toHaveLength(4);
      const document=await decode(bytes,'android-edge-note-return');expect(document.items).toHaveLength(8);
      const expected=await json(join(root,'edge-note-expected.json'));
      for(const before of expected.logins) {
        const item=document.items.find((item):item is LoginItem=>item.kind==='login'&&item.title===before.title);
        expect(item).toBeDefined();
        const {note,...fields}=before;
        expect(loginSnapshot(item!)).toEqual(fields);
        expect(noteSnapshot(resolveBoundNote(item!,document.items))).toEqual(note);
      }
      const returnedNotes=document.items.filter((item):item is SecureNoteItem=>item.kind==='secure-note').map(noteSnapshot);
      expect(returnedNotes).toHaveLength(expected.notes.length);
      for(const note of expected.notes) expect(returnedNotes).toContainEqual(note);
      Object.assign(report,{inputSha256:prepared.sourceArchiveSha256,outputSha256:hash(bytes),androidVersion:device.androidVersion,
        installedApkSha256:device.installedApkSha256,recordCount:8,checks:['all five password fields and four links','explicit unlink','all three notes incl. tags/Markdown','actual fresh Room ID remapping','Android re-export and extension reimport']});
    } else if(stage==='publish') {
      const verified=await json(join(root,'edge-note-verify-evidence.json'));expect(verified.status).toBe('passed');
      const configFile=process.env.MONICA_315_REAL_SERVICES_CONFIG;
      if(!configFile) throw new Error('Explicit loopback service config required');
      const config=await json(configFile);expect(new URL(config.webdav.baseUrl).hostname).toBe('127.0.0.1');
      const baseUrl=`${config.webdav.baseUrl}/android-note-return-${randomUUID()}`;
      const created=await fetch(baseUrl,{method:'MKCOL',headers:{Authorization:`Basic ${Buffer.from(`${config.webdav.username}:${config.webdav.password}`).toString('base64')}`}});
      expect(created.status).toBe(201);
      const bytes=await readFile(join(root,'android-edge-note-return.zip'));expect(hash(bytes)).toBe(verified.outputSha256);
      const fixture={...config.webdav,baseUrl,name:'Android 导回笔记',backupPassword:'synthetic archive password',expectedArchiveSha256:hash(bytes),expectedFile:join(root,'edge-note-expected.json')};
      await new WebDavClient(fixture).upload(bytes,true);
      await writeFile(join(root,'return-edge-fixture.json'),JSON.stringify(fixture,null,2));
      report.archiveSha256=hash(bytes);
    } else {
      const verified=await json(join(root,'edge-note-verify-evidence.json'));expect(verified.status).toBe('passed');
      const published=await json(join(root,'edge-note-publish-evidence.json'));expect(published.status).toBe('passed');
      const browserRun=process.env.MONICA_EDGE_NOTE_RETURN_UI_RUN;
      if(!browserRun) throw new Error('MONICA_EDGE_NOTE_RETURN_UI_RUN must name the final Edge run');
      const edge=await json(join(browserRun,'evidence.json'));expect(edge.status).toBe('passed');expect(edge.webdavNoteReturn.status).toBe('passed');
      expect(edge.nativeRegistryRestored).toBe(true);
      expect(resolve(edge.webdavNoteReturn.fixture)).toBe(join(root,'return-edge-fixture.json'));
      expect(edge.webdavNoteReturn.checks).toHaveLength(4);
      for(const phase of ['initial','reload','real side panel','browser restart']) expect(edge.webdavNoteReturn.checks.some((check:string)=>check.startsWith(`${phase}:`))).toBe(true);
      const fixture=await json(join(root,'return-edge-fixture.json'));
      expect(fixture.expectedArchiveSha256).toBe(verified.outputSha256);
      expect(fixture.expectedArchiveSha256).toBe(published.archiveSha256);
      const client=new WebDavClient(fixture),latest=(await client.listBackups())[0];
      expect(hash(await client.download(latest))).toBe(fixture.expectedArchiveSha256);
      Object.assign(report,{browserRun:resolve(browserRun),checks:edge.webdavNoteReturn.checks,remoteUnchanged:true,archiveSha256:fixture.expectedArchiveSha256});
    }
    report.status='passed';
  } catch(error) {report.error=error instanceof Error?error.message:String(error);throw error;}
  finally {await writeFile(join(root,`edge-note-${stage}-evidence.json`),JSON.stringify(report,null,2));}
});
