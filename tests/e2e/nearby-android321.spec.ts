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
    s.pending.set(id,(message:any)=>{clearTimeout(timer);if(message.ok)resolve(message.data);else reject(Error(message.error));});s.port.postMessage({...request as object,id});
  }),request);
}

test('Android 321 exchanges URL rules, independent notes, wallet templates and Passkey over authenticated LAN',async({},info)=>{
  test.skip(process.env.MONICA_ANDROID_INTEROP!=='1','Explicit shared-AVD acceptance only');
  const stress = process.env.MONICA_SYNC_STRESS === '1'; test.setTimeout(stress ? 900000 : 240000);
  const adb='D:/AndroidSDK/platform-tools/adb.exe',serial=process.env.MONICA_ANDROID_SERIAL||'emulator-5554';
  const run=path.resolve(info.outputPath('isolated')),extension=path.resolve('dist');await mkdir(run,{recursive:true});
  const callAdb=(args:string[])=>execFileSync(adb,['-s',serial,...args],{encoding:'utf8',windowsHide:true});
  expect(callAdb(['emu','avd','name'])).toContain('Monica_Issue136_API_32');
  const port=Number(callAdb(['forward','tcp:0','tcp:39484']).trim());
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
      try { const result = JSON.parse(received.trim()); if (result.error) reject(Error(`Android ${(request as any).op}: ${result.error}`)); else resolve(result); }
      catch (error) { reject(error); }
    });
  });
  const instrument=spawn(adb,['-s',serial,'shell','am','instrument','--user','10','-w','-r','-e','class','takagi.ru.monica.lansync.Extension321NearbyInteropTest','-e','browserInterop','true','takagi.ru.monica.test/androidx.test.runner.AndroidJUnitRunner'],{windowsHide:true});
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
    login.passwordGroupId='00000000-0000-0000-0000-000000000099';
    login.uris=['www.browser.example.test'];
    login.customFields=[{name:'Protected extra',value:'synthetic-field',protected:true},
      {name:'monica.autofill.url_rules',protected:true,value:'{"version":1,"future":9007199254740993,"urls":[{"url":"www.browser.example.test","mode":"HOST"}]}'},
      {name:'monica.content.credential',protected:true,value:'{"version":1,"groupId":"00000000-0000-0000-0000-000000000081","passwordId":"00000000-0000-0000-0000-000000000082","label":"Browser","primary":true,"groupOrder":0,"passwordOrder":0,"note":"Browser note","future":9007199254740993}'}];
    const wallets=['MEMBERSHIP','REWARDS','TRAVEL'].map(walletTemplate=>({...createLoginItem({title:'Browser '+walletTemplate}),kind:'identity',documentType:'OTHER',documentNumber:'0000123007',fullName:'Synthetic holder',firstName:'',middleName:'',lastName:'',walletTemplate,walletFields:{points:'0001250.50',departure:'2026-10-21T10:30+08:00',future:'  Raw value  '}}));
    const key=await createPasskey({origin:'https://example.test',challenge:Buffer.alloc(32,4).toString('base64url'),rpName:'Synthetic',userId:'dXNlcg',userName:'browser',userDisplayName:'Browser',algorithms:[-7],excludeCredentialIds:[]});
    const passkey:PasskeyItem={...createLoginItem({title:'Browser Passkey'}),kind:'passkey',rpId:key.rpId,rpName:'Synthetic',userHandle:'dXNlcg',userName:'browser',userDisplayName:'Browser',credentialId:key.credentialId,publicKey:key.publicKeySpki,privateKeyPkcs8:key.privateKeyPkcs8,signCount:0,algorithm:-7,discoverable:true,backupEligible:true,sourceMode:'browser-local'};
    await runtime(page,{type:'VAULT_IMPORT_ITEMS',items:[login,passkey,...wallets]});
    const connectManager=async()=>{await page.evaluate(()=>{const port=chrome.runtime.connect({name:'monica-nearby-manager-v1'}),s={port,id:0,ready:false,pending:new Map()};(window as any).nearbyAndroid=s;
      port.onMessage.addListener(m=>{if(m.type==='ready')s.ready=true;else if(s.pending.has(m.id)){s.pending.get(m.id)(m);s.pending.delete(m.id);}});});
      await page.waitForFunction(()=>(window as any).nearbyAndroid.ready);};
    const cancelManager=async()=>{await page.evaluate(()=>new Promise<void>(resolve=>{
      const s=(window as any).nearbyAndroid;
      s.port.onMessage.addListener((message:any)=>{if(message.type==='closed'&&message.reason==='cancelled')resolve();});
      s.port.postMessage({id:++s.id,type:'cancel'});
    }));await connectManager();};
    await connectManager();
    const complete=async()=>{let phone=false,browser=false;await expect.poll(async()=>{
      if(!phone)phone=(await control({op:'progress'})).phase==='completed';
      if(!browser)browser=(await command(page,{type:'progress'})).phase==='completed';
      return phone&&browser;
    },{timeout:60000}).toBe(true);};
    const pairing=await command(page,{type:'pair'}),parts=pairing.pairing.invitations[0].split(':');parts[2]='10.0.2.2';
    await control({op:'pair',invitation:parts.join(':')});await complete();
    expect((await control({op:'inspect'})).items).toHaveLength(1);expect(await runtime(page,{type:'VAULT_LIST_ITEMS'})).toHaveLength(5);
    const peerId=(await command(page,{type:'status'})).peerId;
    expect(peerId).toBe('0');
    const exchange=async(choice:'omit'|'include'='omit')=>{let prepared=await command(page,{type:'prepare',peerId});
      if(prepared.review)prepared=await command(page,{type:'confirm',reviewId:prepared.review.id});
      if(prepared.deletionReview)prepared=await command(page,{type:'confirm-deletions',reviewId:prepared.deletionReview.id,choice});
      expect(prepared.phase).toBe('ready');
      const start=await command(page,{type:'start'});expect(start.role).toBe('listening');await control({op:'sync',port:start.endpoint.port});await complete();};
    await exchange();const phone=await control({op:'inspect'});expect(phone.passkeys).toBe(1);expect(phone.items).toContainEqual({title:'Browser synthetic',password:'browser-original'});
    expect(await runtime(page,{type:'VAULT_LIST_ITEMS'})).toEqual(expect.arrayContaining([expect.objectContaining({title:'Android synthetic',password:'android-original'})]));
    const rich=await control({op:'inspect321'});
    expect(rich.wallets).toHaveLength(6);
    for(const wallet of wallets) expect(rich.wallets.find((row:any)=>row.title===wallet.title).data).toMatchObject({walletTemplate:wallet.walletTemplate,documentNumber:wallet.documentNumber,walletFields:wallet.walletFields});
    expect(rich.passwords.find((row:any)=>row.title===login.title).fields).toEqual(expect.arrayContaining(login.customFields));
    const received=await runtime(page,{type:'VAULT_LIST_ITEMS'});
    const androidLogin=received.find((row:any)=>row.title==='Android synthetic');
    expect(androidLogin.customFields.find((row:any)=>row.name==='monica.autofill.url_rules').value).toContain('9007199254740993');
    expect(JSON.parse(androidLogin.customFields.find((row:any)=>row.name==='monica.content.credential').value).note).toBe('Android note');
    for(const template of ['MEMBERSHIP','REWARDS','TRAVEL']) expect(received.find((row:any)=>row.title==='Android '+template)).toMatchObject({walletTemplate:template,documentNumber:'0000123007',walletFields:{points:'0001250.50',departure:'2026-10-21T10:30+08:00',future:'  Raw value  '}});
    await control({op:'edit321'});
    await control({op:'edit'});await exchange();
    const final=await runtime(page,{type:'VAULT_LIST_ITEMS'});expect(final.find((item:any)=>item.id===login.id)).toMatchObject({password:'android-edited'});
    expect(final.find((item:any)=>item.kind==='passkey')).toMatchObject({credentialId:passkey.credentialId,privateKeyPkcs8:passkey.privateKeyPkcs8,signCount:0});
    const returned=final.find((row:any)=>row.id===login.id);
    expect(JSON.parse(returned.customFields.find((row:any)=>row.name==='monica.content.credential').value).note).toBe('Android edited note');
    expect(returned.customFields.find((row:any)=>row.name==='monica.content.credential').value).toContain('9007199254740993');
    expect(JSON.parse(returned.customFields.find((row:any)=>row.name==='monica.autofill.url_rules').value).urls[0].mode).toBe('NEVER');
    for(const wallet of wallets){const row=final.find((row:any)=>row.id===wallet.id);expect(row.walletFields).toMatchObject({seat:'08A',future:'  Raw value  ',departure:'2026-10-21T10:30+08:00'});expect(row.walletFields).not.toHaveProperty('points');}
    Object.assign(evidence,{urlRules:true,independentCredentialNotes:true,walletTemplates:['MEMBERSHIP','REWARDS','TRAVEL'],unknownFields:true,leadingZeroNumbers:true,timezoneStrings:true,clearedMapKeys:true});
    if(stress){
      const phases:string[]=[]; evidence.stressPhases=phases;
      const phase=(name:string)=>{phases.push(name);console.log('Android stress phase:',name);};
      const list=()=>runtime(page,{type:'VAULT_LIST_ITEMS'});
      const update=async(change:Record<string,unknown>)=>{
        const prefs=await command(page,{type:'preferences'});
        await command(page,{type:'update',epoch:prefs.epoch,change:{kind:'preferences',...change}});
      };
      const find=async(title:string)=>(await list()).find((row:any)=>row.title===title);
      const checkLogin=async(title:string,password:string)=>{
        expect(await find(title)).toMatchObject({password});
        expect((await control({op:'inspectStress'})).passwords.find((row:any)=>row.title===title)).toMatchObject({password,deleted:false});
      };
      await control({op:'seedStress',count:220});
      const bulk=Array.from({length:230},(_,index)=>({...createLoginItem({title:`Browser stress ${index}`,username:`用户-${index}-🔐`,password:`浏览器密码-${index}-\n"\\-🔑`}),notes:`  note-${index}\n第二行\t  `}));
      const duplicateA=createLoginItem({title:'同名账户',username:'one',password:'same-title-one'});
      const duplicateB=createLoginItem({title:'同名账户',username:'two',password:'same-title-two'});
      const otp={...createLoginItem({title:'Protected Android TOTP'}),kind:'totp',secret:'JBSWY3DPEHPK3PXP',digits:6,period:30,algorithm:'SHA1'};
      const removable={...otp,id:crypto.randomUUID(),title:'Explicit deletion TOTP'};
      await runtime(page,{type:'VAULT_IMPORT_ITEMS',items:[...bulk,duplicateA,duplicateB,otp,removable]});
      await exchange();
      const phone=await control({op:'inspectStress'}),browser=await list();
      expect(phone.passwords.filter((row:any)=>row.title.startsWith('Browser stress '))).toHaveLength(230);
      expect(browser.filter((row:any)=>row.title.startsWith('Android stress '))).toHaveLength(220);
      for(let i=0;i<230;i++)expect(phone.passwords.find((row:any)=>row.title===`Browser stress ${i}`)).toMatchObject({password:bulk[i].password,username:bulk[i].username,notes:bulk[i].notes});
      for(let i=0;i<220;i++)expect(browser.find((row:any)=>row.title===`Android stress ${i}`)).toMatchObject({password:`安卓密码-${i}-\n"\\-🔑`,username:`用户-${i}-🔐`,notes:`  note-${i}\n第二行\t  `});
      expect(phone.passwords.filter((row:any)=>row.title==='同名账户').map((row:any)=>row.password).sort()).toEqual(['same-title-one','same-title-two']);
      phase('450-record-bidirectional-pagination-unicode-whitespace-duplicate-titles');
      const ids=browser.map((row:any)=>row.id).sort(),phoneIds=phone.passwords.map((row:any)=>row.id).sort((a:number,b:number)=>a-b);
      for(let i=0;i<3;i++)await exchange();
      expect((await list()).map((row:any)=>row.id).sort()).toEqual(ids);
      expect((await control({op:'inspectStress'})).passwords.map((row:any)=>row.id).sort((a:number,b:number)=>a-b)).toEqual(phoneIds);
      phase('three-noop-rounds-stable-identities-no-duplicates');

      // Prepare and connect, then abort before either application polls/applies.
      await runtime(page,{type:'VAULT_UPSERT_ITEM',item:{...await find('Browser stress 0'),password:'browser-after-interruption'}});
      await command(page,{type:'prepare',peerId});
      const started=await command(page,{type:'start'});
      await control({op:'sync',port:started.endpoint.port});
      await cancelManager();await control({op:'cancel'});
      expect((await command(page,{type:'status'})).phase).not.toBe('completed');
      expect((await control({op:'inspectStress'})).passwords.find((row:any)=>row.title==='Browser stress 0').password).toBe(bulk[0].password);
      await control({op:'reopen'});await page.reload();await connectManager();
      await exchange();await checkLogin('Browser stress 0','browser-after-interruption');
      phase('transport-cancel-before-adoption-provider-reopen-manager-reload-retry');

      // Both devices change the same record offline. Require convergence to a whole candidate.
      await runtime(page,{type:'VAULT_UPSERT_ITEM',item:{...await find('Browser stress 1'),password:'concurrent-browser',notes:'browser conflict note'}});
      await control({op:'mutateStress',title:'Browser stress 1',action:'edit',password:'concurrent-android',notes:'android conflict note'});
      await exchange();await exchange();
      const resolved=await find('Browser stress 1');
      expect(['concurrent-browser','concurrent-android']).toContain(resolved.password);
      expect(resolved.notes).toBe(resolved.password==='concurrent-browser'?'browser conflict note':'android conflict note');
      await checkLogin('Browser stress 1',resolved.password);
      phase('concurrent-edit-whole-candidate-and-eventual-convergence');

      await update({mode:'receive_only'});
      await runtime(page,{type:'VAULT_UPSERT_ITEM',item:{...await find('Browser stress 2'),password:'private-unsent-edit'}});
      await control({op:'mutateStress',title:'Android stress 0',action:'edit',password:'receive-only-phone-edit'});
      await exchange();await checkLogin('Android stress 0','receive-only-phone-edit');
      expect((await control({op:'inspectStress'})).passwords.find((row:any)=>row.title==='Browser stress 2').password).toBe(bulk[2].password);
      expect((await find('Browser stress 2')).password).toBe('private-unsent-edit');
      await update({mode:'bidirectional'});await exchange();await checkLogin('Browser stress 2','private-unsent-edit');
      phase('receive-only-no-outgoing-disclosure-and-return-to-bidirectional');

      await update({mode:'send_only'});
      await runtime(page,{type:'VAULT_UPSERT_ITEM',item:{...await find('Browser stress 3'),password:'send-only-browser-edit'}});
      await control({op:'mutateStress',title:'Android stress 1',action:'edit',password:'not-received-until-bidirectional'});
      await exchange();await checkLogin('Browser stress 3','send-only-browser-edit');
      expect((await find('Android stress 1')).password).toBe('安卓密码-1-\n"\\-🔑');
      await update({mode:'bidirectional'});await exchange();await checkLogin('Android stress 1','not-received-until-bidirectional');
      phase('send-only-no-incoming-adoption-and-return-to-bidirectional');

      // Reproduce the reported danger: corrupt only the browser key, purge, then sync.
      await runtime(page,{type:'VAULT_UPSERT_ITEM',item:{...await find(otp.title),secret:'MZXW6YTBOI'}});
      await runtime(page,{type:'VAULT_DELETE_ITEM',itemId:otp.id});await runtime(page,{type:'VAULT_EMPTY_LOCAL_TRASH'});
      await exchange();
      const kept=(await control({op:'inspectStress'})).secure.find((row:any)=>row.title===otp.title);
      expect(kept).toMatchObject({deleted:false});expect(JSON.parse(kept.data).secret).toBe(otp.secret);
      phase('wrong-browser-totp-purged-correct-android-key-remains-active');

      // Historical deletions must wait for a fresh explicit decision each transfer.
      await update({incrementalOnly:false});
      await runtime(page,{type:'VAULT_DELETE_ITEM',itemId:removable.id});await runtime(page,{type:'VAULT_EMPTY_LOCAL_TRASH'});
      await command(page,{type:'prepare',peerId});await cancelManager();await update({incrementalOnly:true});
      const review=await command(page,{type:'prepare',peerId});expect(review.deletionReview.count).toBeGreaterThan(0);
      await expect(command(page,{type:'start'})).rejects.toThrow('not-ready');
      await cancelManager();
      expect((await control({op:'inspectStress'})).secure.find((row:any)=>row.title===removable.title).deleted).toBe(false);
      await exchange('omit');
      expect((await control({op:'inspectStress'})).secure.find((row:any)=>row.title===removable.title).deleted).toBe(false);
      await exchange('include');
      // A purge removes the Android row; a trash operation retains a deleted row.
      const afterInclude=(await control({op:'inspectStress'})).secure;
      expect(afterInclude.some((row:any)=>row.title===removable.title&&!row.deleted)).toBe(false);
      expect((await command(page,{type:'preferences'})).incrementalOnly).toBe(true);
      phase('historical-deletion-start-blocked-cancel-omit-explicit-include-once');

      // Android's incoming deletions remain independent from the browser send filter.
      await control({op:'mutateStress',title:'Android stress 2',action:'trash'});await exchange();
      expect(await find('Android stress 2')).toBeUndefined();
      await control({op:'mutateStress',title:'Android stress 2',action:'restore'});await exchange();
      await checkLogin('Android stress 2','安卓密码-2-\n"\\-🔑');
      phase('android-trash-and-restore-return-original-browser-item');
      expect((await find('Android stress 2')).id).toBe(browser.find((row:any)=>row.title==='Android stress 2').id);
      await exchange();
      expect((await find('Browser Passkey')).privateKeyPkcs8).toBe(passkey.privateKeyPkcs8);
      evidence.stressCompletedRounds=(await control({op:'status'})).rounds;
      console.log('Android stress phases:',JSON.stringify(phases));
    }
    await control({op:'stop'});stopped=true;await done;expect(androidOutput).toContain('OK (1 test)');
    Object.assign(evidence,{status:'passed',rounds:evidence.stressCompletedRounds??2,androidOriginalKeySignature:true,zeroCounter:true,appVersion:callAdb(['shell','dumpsys','package','takagi.ru.monica']).match(/versionName=([^\r\n]+)/)?.[1]});
  }finally{
    if(!stopped)await control({op:'stop'},3000).catch(()=>{});
    await context.close();await registration?.restore();callAdb(['forward','--remove',`tcp:${port}`]);
    await writeFile(path.join(run,'android-instrumentation.log'),androidOutput);await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));
  }
});
