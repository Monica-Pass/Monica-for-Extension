import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { WebDavClient } from '../../src/providers/webdav/webdav-client';
import { MonicaWebDavProvider } from '../../src/providers/webdav/monica-webdav-provider';
import { resolveBoundNote } from '../../src/core/bound-notes';
import type { LoginItem, ProviderAccount } from '../../src/core/model';
const fixturePath = process.env.MONICA_WEBDAV_NOTE_FIXTURE;
const now = () => new Date().toISOString();

it(fixturePath ? 'independently reads real Edge note writes from Apache' : 'seeds Apache with an actual Android note archive', async () => {
  if (!fixturePath) {
    const configPath = process.env.MONICA_315_REAL_SERVICES_CONFIG;
    if (!configPath) throw new Error('Explicit loopback service config required');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    expect(new URL(config.webdav.baseUrl).hostname).toBe('127.0.0.1');
    const baseUrl = `${config.webdav.baseUrl}/note-ui-${randomUUID()}`;
    const collection = await fetch(baseUrl, {method:'MKCOL',headers:{Authorization:`Basic ${Buffer.from(`${config.webdav.username}:${config.webdav.password}`).toString('base64')}`}});
    expect(collection.status).toBe(201);
    const android = resolve('.tmp/android-zip-note-20261002-final');
    const evidence = JSON.parse(await readFile(join(android,'zip-note-export-evidence.json'),'utf8'));
    expect(evidence.status).toBe('passed');
    const bytes = await readFile(join(android,'android-note.zip'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(evidence.outputs.find((output: {name:string})=>output.name==='android-note.zip').sha256);
    const fixture = {...config.webdav,baseUrl,backupPassword:'synthetic archive password',name:'Android WebDAV 笔记',androidSource:android};
    await new WebDavClient(fixture).upload(bytes,true);
    const parent=resolve('.tmp/webdav-note-ui'); await mkdir(parent,{recursive:true});
    const output=await mkdtemp(join(parent,'run-'));
    await writeFile(join(output,'fixture.json'),JSON.stringify(fixture,null,2));
    console.log(`WEBDAV_NOTE_FIXTURE ${join(output,'fixture.json')}`);
  } else {
    const fixture=JSON.parse(await readFile(fixturePath,'utf8'));
    expect(new URL(fixture.baseUrl).hostname).toBe('127.0.0.1');
    const account:ProviderAccount={id:'independent-note-reader',kind:'monica-webdav',name:fixture.name,enabled:true,isDefaultSaveTarget:false,config:fixture};
    const result=await new MonicaWebDavProvider().sync(account,{now:now(),localItems:[]});
    const owner=(title:string)=>result.items.find(item=>item.kind==='login'&&item.title===title) as LoginItem;
    const linked=owner('Edge WebDAV note password'); expect(linked).toBeDefined();
    expect(resolveBoundNote(linked,result.items)?.content).toBe('# Second note\n\nSame title, different ID\n');
    expect(linked.password).toBe('synthetic-edge-note-password');
    const fresh=owner('Edge fresh note password'); expect(fresh).toBeDefined();
    expect(resolveBoundNote(fresh,result.items)?.content).toBe('Created from real Edge\n保留正文 🔑');
    const unlinked=result.items.find(item=>item.kind==='login'&&item.title.endsWith('-unlink')) as LoginItem;
    expect(unlinked.boundNoteEntryId).toBeUndefined(); expect(unlinked.boundNoteId).toBeUndefined();
    const original=result.items.find(item=>item.kind==='login'&&item.title.endsWith('-keep')) as LoginItem;
    expect(resolveBoundNote(original,result.items)?.content).toBe('# First note\n\n  中文 🔑  \n');
    const client=new WebDavClient(fixture),latest=(await client.listBackups())[0];
    const bytes=await client.download(latest);
    await writeFile(join(resolve(fixturePath,'..'),'edge-note-return.zip'),bytes);
    await writeFile(join(resolve(fixturePath,'..'),'remote-readback.json'),JSON.stringify({status:'passed',at:now(),source:fixture.baseUrl,
      itemCount:result.items.length,checks:['created association','same-title replacement','unlink','new note association','original link retained'],
      archiveSha256:createHash('sha256').update(bytes).digest('hex')},null,2));
  }
});
