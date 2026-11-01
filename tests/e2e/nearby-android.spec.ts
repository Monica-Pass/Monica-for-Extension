import {test,expect,type Page} from '@playwright/test';
import {spawn,execFileSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';
import {temporaryNativeHost} from './fixtures/native-host';
import {createLoginItem,type PasskeyItem} from '../../src/core/model';
import {createPasskey} from '../../src/passkey/webauthn-core';

async function runtime(page:Page,request:unknown):Promise<any>{
  const r=await page.evaluate(request=>chrome.runtime.sendMessage(request),request);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data;
}
async function command(page:Page,request:unknown):Promise<any>{
  return page.evaluate(request=>new Promise((resolve,reject)=>{
    const s=(window as any).nearbyAndroid,id=++s.id;
    const timer=setTimeout(()=>{s.pending.delete(id);reject(Error('Manager timeout'));},45000);
    s.pending.set(id,(message:any)=>{clearTimeout(timer);message.ok?resolve(message.data):reject(Error(message.error));});s.port.postMessage({...request as object,id});
  }),request);
}

test('installed Android provider exchanges passwords and signs a browser Passkey over authenticated LAN',async({},info)=>{
  test.skip(process.env.MONICA_ANDROID_INTEROP!=='1','Explicit shared-AVD acceptance only');test.setTimeout(240000);
  const adb='D:/AndroidSDK/platform-tools/adb.exe',serial=process.env.MONICA_ANDROID_SERIAL||'emulator-5554';
  const run=path.resolve(info.outputPath('isolated')),extension=path.resolve('dist');await mkdir(run,{recursive:true});
  const callAdb=(args:string[])=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true});
  const androidUser = process.env.MONICA_ANDROID_USER;
  expect(androidUser, 'Explicit disposable test user is required').toMatch(/^[1-9]\d+$/);
  expect(callAdb(['shell', 'am', 'get-current-user']).trim()).toBe(androidUser);
  const applicationId = process.env.MONICA_ANDROID_APPLICATION_ID || 'takagi.ru.monica';
  expect(['takagi.ru.monica', 'takagi.ru.monica.fdroid']).toContain(applicationId);
  const testClass = process.env.MONICA_ANDROID_NEARBY_TEST_CLASS || 'takagi.ru.monica.lansync.NearbyIncrementalBrowserInteropTest';
  expect(testClass).toMatch(/^takagi\.ru\.monica\.lansync\.Nearby(?:Incremental)?BrowserInteropTest$/);
  expect(callAdb(['emu','avd','name'])).toContain('Monica_Issue136_API_32');
  const port=Number(callAdb(['forward','tcp:0','tcp:39483']).trim());
  const control=(request:unknown,timeoutMs=60000):Promise<any>=>new Promise((resolve,reject)=>{
    const socket=createConnection({host:'127.0.0.1',port});let received='', complete=false;
    socket.setTimeout(timeoutMs,()=>socket.destroy(Error('Android control timeout')));
    socket.on('close',()=>{if(!complete)reject(Error('Android control closed before a complete response'));});
    socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data', chunk => {
      received += chunk;
      if (!received.includes('\n')) return;
      complete = true;
      socket.destroy();
      try { const result = JSON.parse(received.trim()); if (result.error) reject(Error(result.error)); else resolve(result); }
      catch (error) { reject(error); }
    });
  });
  const instrument=spawn(adb,['-s',serial,'shell','am','instrument','--user',androidUser!,'-w','-r','-e','class',testClass,'-e','browserInterop','true',`${applicationId}.test/androidx.test.runner.AndroidJUnitRunner`],{windowsHide:true});
  let androidOutput='';instrument.stdout.on('data',b=>androidOutput+=b);instrument.stderr.on('data',b=>androidOutput+=b);
  const done=new Promise<number|null>(resolve=>instrument.once('exit',resolve));
  const appData=path.join(run,'appdata');await mkdir(appData,{recursive:true});
  const context=await launchEdgeContext(path.join(run,'profile'),{env:{...process.env,APPDATA:appData,LOCALAPPDATA:appData},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  let registration:Awaited<ReturnType<typeof temporaryNativeHost>>|undefined,stopped=false;
  const evidence:Record<string,unknown>={status:'failed',androidProvider:true,productionBrowserCoordinator:true,androidMulticastTested:false};
  try{
    await expect.poll(async()=>{try{return(await control({op:'status'},1000)).ready;}catch{return false;}},{timeout:25000}).toBe(true);
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage(),id=new URL(worker.url()).host;
    registration=await temporaryNativeHost(id,path.join(run,'host'));await page.goto(`chrome-extension://${id}/index.html`);
    await runtime(page,{type:'VAULT_SETUP',masterPassword:'Synthetic browser interop password'});
    const login=createLoginItem({title:'Browser synthetic',username:'browser',password:'browser-original'});
    login.customFields=[{name:'Protected extra',value:'synthetic-field',protected:true}];
    const key=await createPasskey({origin:'https://example.test',challenge:Buffer.alloc(32,4).toString('base64url'),rpName:'Synthetic',userId:'dXNlcg',userName:'browser',userDisplayName:'Browser',algorithms:[-7],excludeCredentialIds:[]});
    const passkey:PasskeyItem={...createLoginItem({title:'Browser Passkey'}),kind:'passkey',rpId:key.rpId,rpName:'Synthetic',userHandle:'dXNlcg',userName:'browser',userDisplayName:'Browser',credentialId:key.credentialId,publicKey:key.publicKeySpki,privateKeyPkcs8:key.privateKeyPkcs8,signCount:0,algorithm:-7,discoverable:true,backupEligible:true,sourceMode:'browser-local'};
    await runtime(page,{type:'VAULT_IMPORT_ITEMS',items:[login,passkey]});
    await page.evaluate(()=>{const port=chrome.runtime.connect({name:'monica-nearby-manager-v1'}),s={port,id:0,ready:false,pending:new Map()};(window as any).nearbyAndroid=s;
      port.onMessage.addListener(m=>{if(m.type==='ready')s.ready=true;else if(s.pending.has(m.id)){s.pending.get(m.id)(m);s.pending.delete(m.id);}});});
    await page.waitForFunction(()=>(window as any).nearbyAndroid.ready);
    const phases: Array<{phone?:string;browser?:string}> = []; evidence.phases = phases;
    const complete=async()=>{let phone=false,browser=false;await expect.poll(async()=>{
      const step: {phone?:string;browser?:string} = {}; phases.push(step);
      if(!phone){step.phone=(await control({op:'progress'})).phase;phone=step.phone==='completed';}
      if(!browser){step.browser=(await command(page,{type:'progress'})).phase;browser=step.browser==='completed';}
      return phone&&browser;
    },{timeout:60000}).toBe(true);};
    const pairing=await command(page,{type:'pair'}),parts=pairing.pairing.invitations[0].split(':');parts[2]='10.0.2.2';
    await control({op:'pair',invitation:parts.join(':')});await complete();
    expect((await control({op:'inspect'})).items).toHaveLength(1);expect(await runtime(page,{type:'VAULT_LIST_ITEMS'})).toHaveLength(2);
    const incrementalAcceptance = testClass.includes('Incremental');
    if (incrementalAcceptance) expect((await control({op:'seed'})).seeded).toBe(200);
    const peerId=(await command(page,{type:'status'})).peerId;
    const exchange=async()=>{const prepared=await command(page,{type:'prepare',peerId});if(prepared.phase==='review')await command(page,{type:'confirm',reviewId:prepared.review.id});else expect(prepared.phase).toBe('ready');
      const listener=await control({op:'sync',listen:true});
      const forwarded=Number(callAdb(['forward','tcp:0',`tcp:${listener.port}`]).trim());
      try{await command(page,{type:'start',endpoint:{addresses:['127.0.0.1'],port:forwarded}});await complete();}
      finally{callAdb(['forward','--remove',`tcp:${forwarded}`]);}};
    await exchange();const phone=await control({op:'inspect'});expect(phone.passkeys).toBe(1);expect(phone.items).toContainEqual({title:'Browser synthetic',password:'browser-original'});
    const initialBytes = incrementalAcceptance ? (await control({op:'metrics'})).total : undefined;
    expect(await runtime(page,{type:'VAULT_LIST_ITEMS'})).toEqual(expect.arrayContaining([expect.objectContaining({title:'Android synthetic',password:'android-original'})]));
    await control({op:'edit'});await exchange();
    const final=await runtime(page,{type:'VAULT_LIST_ITEMS'});expect(final.find((item:any)=>item.id===login.id)).toMatchObject({password:'android-edited'});
    expect(final.find((item:any)=>item.kind==='passkey')).toMatchObject({credentialId:passkey.credentialId,privateKeyPkcs8:passkey.privateKeyPkcs8,signCount:0});
    if (incrementalAcceptance) {
      await exchange(); const metrics = await control({op:'metrics'});
      expect(initialBytes).toBeGreaterThan(100_000); expect(metrics.total).toBeLessThan(4096);
      const unchanged = await runtime(page,{type:'VAULT_LIST_ITEMS'});
      expect(unchanged.filter((item:any)=>item.title.startsWith('Incremental filler '))).toHaveLength(200);
      expect(unchanged.find((item:any)=>item.id===login.id).password).toBe('android-edited');
      Object.assign(evidence,{initialPayloadBytes:initialBytes,unchangedPayloadBytes:metrics.total,incrementalRecords:200});
    }
    await control({op:'stop'});stopped=true;await done;expect(androidOutput).toContain('OK (1 test)');
    Object.assign(evidence,{status:'passed',rounds:incrementalAcceptance?3:2,applicationId,androidUser,androidOriginalKeySignature:true,zeroCounter:true,appVersion:callAdb(['shell','dumpsys','package',applicationId]).match(/versionName=([^\r\n]+)/)?.[1]});
  }finally{
    if(!stopped)await control({op:'stop'},3000).catch(()=>{});
    await context.close();await registration?.restore();callAdb(['forward','--remove',`tcp:${port}`]);
    await writeFile(path.join(run,'android-instrumentation.log'),androidOutput);await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));
  }
});
