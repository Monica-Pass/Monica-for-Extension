// Additional installed-Firefox UI and lifecycle acceptance. Clipboard is a
// synthetic in-memory fixture: never inspect the real OS/browser clipboard.
import { launchFirefox,root,scratch } from './firefox-harness.mjs';
import { createServer } from 'node:http';
import { cp,readFile,writeFile,mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory=await mkdtemp(path.join(scratch,'permission-fixture-'));
await cp(path.join(root,'dist-firefox'),directory,{recursive:true});
const manifestFile=path.join(directory,'manifest.json'),manifest=JSON.parse(await readFile(manifestFile,'utf8'));
const currentVersion=manifest.version,nextVersion=currentVersion.replace(/\d+$/,patch=>String(Number(patch)+1));
manifest.permissions.push(...manifest.optional_permissions);delete manifest.optional_permissions;
// Stub the native API before Monica binds it. This never opens a system
// authenticator or enumerates any personal credentials.
await writeFile(path.join(directory,'synthetic-native.js'),`window.__syntheticNativeCalls=0;Object.defineProperty(navigator.credentials,'get',{configurable:true,value:async options=>{window.__syntheticNativeCalls++;window.__syntheticNativeSignal=options.signal;if(window.__syntheticNativeWait)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Synthetic cancellation','AbortError')),{once:true}));return {id:'synthetic-native-only'};}});`);
manifest.content_scripts.find(s=>s.world==='MAIN').js.unshift('synthetic-native.js');
await writeFile(manifestFile,JSON.stringify(manifest));
const ff=await launchFirefox(directory),evidence={status:'failed',version:ff.browserVersion,checks:[],clipboard:'synthetic memory only; never read OS clipboard'};
const mark=name=>{evidence.checks.push(name);console.log('PASS',name)};
const send=async input=>{const r=await ff.command(input);assert.equal(r?.ok,true,JSON.stringify(r));return r.data;};
const wait=async(script,expected=true)=>{let v;for(let n=0;n<150;n++){v=await ff.evaluate(script);if(JSON.stringify(v)===JSON.stringify(expected))return v;await new Promise(r=>setTimeout(r,100))}throw Error(`Wait failed: ${script}: ${JSON.stringify(v)}`)};
const click=async selector=>{await wait(`return !!document.querySelector(${JSON.stringify(selector)});`);const el=await ff.call('POST','/element',{using:'css selector',value:selector});await ff.call('POST',`/element/${el['element-6066-11e4-a52e-4f735466cecf']}/click`,{});};
const key=async value=>ff.call('POST','/actions',{actions:[{type:'key',id:'keys',actions:[{type:'keyDown',value},{type:'keyUp',value}]}]});
let nativeKey;
const webServer=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><button id="get">Synthetic authentication</button><output id="result"></output><script>get.onclick=async()=>{result.textContent='waiting';window.controller=new AbortController();try{const c=await navigator.credentials.get({signal:controller.signal,publicKey:{challenge:new Uint8Array(32).fill(42),rpId:'localhost',userVerification:'required',timeout:60000}});result.textContent=c.id}catch(e){result.textContent='error:'+e.name}};</script>`)});
await new Promise(r=>webServer.listen(0,'127.0.0.1',r));
try{
  await ff.goto(ff.url+'index.html');const manager=await ff.call('GET','/window');
  await send({type:'VAULT_SETUP',masterPassword:'synthetic-ui-password'});await ff.asyncEval(`await chrome.storage.local.set({'monica.locale':'zh-CN'});return true;`);
  const now=new Date().toISOString(),base={favorite:false,notes:'',createdAt:now,updatedAt:now,providerRefs:[]};
  await send({type:'VAULT_IMPORT_ITEMS',items:[{...base,id:'ui-login',kind:'login',title:'Firefox UI account',username:'synthetic',password:'synthetic',uris:[],customFields:[]},{...base,id:'ui-otp',kind:'totp',title:'Firefox OTP',secret:'JBSWY3DPEHPK3PXP',issuer:'Synthetic',accountName:'test'}]});
  await ff.goto(ff.url+'index.html');await wait('return document.body.innerText.includes("Firefox UI account");');
  await ff.call('POST','/actions',{actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',origin:await ff.call('POST','/element',{using:'css selector',value:'.item-card'}),x:0,y:0},{type:'pointerDown',button:2},{type:'pointerUp',button:2}]}]});
  await wait('return !!document.querySelector("[data-item-selection-toolbar]");');await key('\uE00C');await wait('return !document.querySelector("[data-item-selection-toolbar]");');
  mark('rendered manager, imported OTP and real right-click multi-selection/Escape');
  await ff.evaluate(`const b=[...document.querySelectorAll('#primary-navigation button')].find(b=>/设置与备份|Settings and backup/.test(b.textContent));if(b)b.dataset.testSettings='';return true;`);
  await click('[data-test-settings]');await click('[data-settings-entry="updates"]');
  await ff.evaluate(`window.__updateMode='new';window.__updateCalls=0;const original=window.fetch.bind(window);window.fetch=async(input,init)=>{if(String(input).includes('api.github.com/repos/Monica-Pass/Monica-for-Extension/releases/latest')){__updateCalls++;if(__updateMode==='limited')return new Response('{}',{status:403});if(__updateMode==='none')return new Response('{}',{status:404});if(__updateMode==='bad')return new Response('<html>');return Response.json({tag_name:__updateMode==='same'?'v${currentVersion}':'v${nextVersion}',draft:false,prerelease:false,html_url:'https://evil.invalid'});}return original(input,init)};return true;`);
  assert.equal(await ff.evaluate('return window.__updateCalls;'),0);
  for(const [mode,text]of [['new',`发现新版本 ${nextVersion}`],['same',`未发现更新（GitHub 最新发布 ${currentVersion}）。`],['limited','GitHub 请求过于频繁，请稍后重试。'],['none','GitHub 暂无正式发布版本。'],['bad','无法识别 GitHub 发布信息，请打开发布页查看。']]){
    await ff.evaluate('window.__updateMode=arguments[0];',[mode]);await click('[data-extension-updates] m3e-button');await wait('return document.querySelector("[data-extension-updates] [role=status] p").textContent;',text);
    if(mode==='new')assert.equal(await ff.evaluate('return document.querySelector("[data-extension-updates] a").href;'),`https://github.com/Monica-Pass/Monica-for-Extension/releases/tag/v${nextVersion}`);
  }
  await ff.call('POST','/window/rect',{width:420,height:850});assert.equal(await ff.evaluate('return document.documentElement.scrollWidth<=innerWidth+1;'),true);
  await writeFile(path.join(scratch,'updates-firefox.png'),Buffer.from(await ff.call('GET','/screenshot'),'base64'));
  await ff.call('POST','/window/rect',{width:1200,height:950});
  mark('settings update detector in Firefox: new/same/rate-limit/no-release/invalid data, safe link and narrow view');
  await ff.asyncEval('await browser.sidebarAction.close();return true;');
  const popup=await ff.call('POST','/window/new',{type:'tab'});await ff.call('POST','/window',{handle:popup.handle});await ff.goto(ff.url+'popup.html');
  await click('footer m3e-button[aria-label="在侧栏打开密码库"]');await ff.call('POST','/window',{handle:manager});
  assert.equal(await ff.asyncEval(`return (await browser.runtime.getContexts({contextTypes:['SIDE_PANEL']})).some(c=>c.documentUrl.endsWith('index.html?surface=sidepanel'));`),true);
  const lease=await ff.asyncEval(`const view=browser.extension.getViews().find(v=>v.location.href.endsWith('index.html?surface=sidepanel'));if(!view)return {error:'sidebar view absent'};return await new Promise(resolve=>{const p=view.chrome.runtime.connect({name:'monica-nearby-manager-v1'});p.onMessage.addListener(m=>{p.disconnect();resolve(m)});setTimeout(()=>{p.disconnect();resolve({error:'timeout'})},4000)});`);
  assert.equal(lease.type,'ready',JSON.stringify(lease));
  mark('popup trusted user gesture opens actual Firefox sidebar; sidebar owns a validated nearby manager lease');
  await send({type:'MDBX2_HOST_STATUS'});
  await ff.asyncEval(`const bg=await browser.runtime.getBackgroundPage();const engine=bg.document.querySelector('iframe').contentWindow;bg.__syntheticClipboard='Synthetic expiry text';engine.document.execCommand=command=>{const field=engine.document.querySelector('textarea');if(!field||engine.document.activeElement!==field)return false;if(command==='paste'){field.value=bg.__syntheticClipboard;return true;}if(command==='copy'){const data=new engine.DataTransfer();const event=new engine.ClipboardEvent('copy',{clipboardData:data,cancelable:true});engine.document.dispatchEvent(event);bg.__syntheticClipboard=data.getData('text/plain');return true;}return false};await browser.storage.local.set({'monica.clipboard.preferences.v1':{enabled:true,seconds:30}});return true;`);
  const expire=()=>ff.asyncEval(`const bg=await browser.runtime.getBackgroundPage();const value='Synthetic expiry text';const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');await browser.runtime.sendMessage({type:'CLIPBOARD_ARM',digest});const k='monica.clipboard.pending.v1';const row=(await browser.storage.session.get(k))[k];row.expiresAt=Date.now()-1;await browser.storage.session.set({[k]:row});await browser.alarms.create('monica.clipboard.expiry',{when:Date.now()+50});return true;`);
  await expire();let cleared=false;for(let n=0;n<150;n++){cleared=await ff.asyncEval(`return (await browser.runtime.getBackgroundPage()).__syntheticClipboard==='';`);if(cleared)break;await new Promise(r=>setTimeout(r,100));}assert.equal(cleared,true,'background clipboard frame must be focusable for the production clearing algorithm');
  await ff.asyncEval(`(await browser.runtime.getBackgroundPage()).__syntheticClipboard='Synthetic newer text';return true;`);await expire();
  await new Promise(r=>setTimeout(r,1000));assert.equal(await ff.asyncEval(`return (await browser.runtime.getBackgroundPage()).__syntheticClipboard;`),'Synthetic newer text');
  mark('production clipboard alarm lifecycle clears matching synthetic text and preserves subsequent copies (no real clipboard access)');
  // Use a unique task-owned registry name; never overwrite production registrations.
  const hostName='com.monica_pass.firefox_test_'+randomUUID().replaceAll('-',''),nativeManifest=path.join(ff.profile,'native-host.json');
  await writeFile(nativeManifest,JSON.stringify({name:hostName,description:'Synthetic Firefox native probe',path:path.join(root,'native/mdbx2-host/target/release/monica-mdbx2-host.exe'),type:'stdio',allowed_extensions:[ff.id]}));
  nativeKey=`HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\${hostName}`;
  const ps=path.join(ff.profile,'register-test-host.ps1');
  await writeFile(ps,`$ErrorActionPreference='Stop'\n$key='${nativeKey}'\nif(Test-Path -LiteralPath $key){throw 'Test registration collision'}\nNew-Item -Path $key -Force | Out-Null\nSet-Item -LiteralPath $key -Value '${nativeManifest.replaceAll("'","''")}'\n`);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',ps],{windowsHide:true});
  const hello=await ff.asyncEval(`return await browser.runtime.sendNativeMessage(arguments[0],{protocol:2,requestId:'firefox-probe',method:'host.hello',params:{}});`,[hostName]);assert.equal(hello.ok,true,JSON.stringify(hello));assert.equal(hello.result.nearbyTransportVersion,2);
  mark('actual Firefox Native Messaging launches bundled Windows helper using exact add-on ID and isolated helper data');
  // Copy the CLI helper into the synthetic profile to exclude portable data
  // beside the developer's original executable as well as personal appdata.
  const cliHost=path.join(ff.profile,'monica-browser-host.exe');
  await cp(path.join(root,'../monica-pass-cli/target/release/monica-browser-host.exe'),cliHost);
  await writeFile(nativeManifest,JSON.stringify({name:hostName,description:'Synthetic Firefox CLI probe',path:cliHost,type:'stdio',allowed_extensions:[ff.id]}));
  const cliHello=await ff.asyncEval(`return await browser.runtime.sendNativeMessage(arguments[0],{id:1,protocol:2,op:'hello'});`,[hostName]);
  assert.equal(cliHello.ok,true,JSON.stringify(cliHello));assert.equal(cliHello.data.protocol,2);assert.equal(cliHello.data.unlocked,false);assert.deepEqual(cliHello.data.databases,[]);
  mark('actual Firefox launches updated CLI native helper with fixed add-on ID and empty isolated configuration');
  assert.equal(await ff.evaluate('return browser.identity.getRedirectURL("onedrive");'),'https://f8bbc9f1d8ddc2cfc3d3e3082d3d44219d7d3b9b.extensions.allizom.org/onedrive');
  mark('Firefox OneDrive identity redirect matches the exact callback allowlist');
  const web=(await ff.call('POST','/window/new',{type:'tab'})).handle;await ff.call('POST','/window',{handle:web});
  await ff.goto('http://localhost:'+webServer.address().port+'/');
  await ff.evaluate(`window.__seedDone=false;navigator.credentials.create({publicKey:{challenge:new Uint8Array(32).fill(41),rp:{id:'localhost',name:'Synthetic'},user:{id:new Uint8Array([1]),name:'synthetic',displayName:'Synthetic'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'discouraged'}}}).then(()=>window.__seedDone=true);return true;`);
  await wait('return document.activeElement?.id === "monica-passkey-prompt-host";');await key('\uE007');await wait('return window.__seedDone;');
  for(const locked of [false,true]){
    await ff.call('POST','/window',{handle:manager});if(locked)await send({type:'VAULT_LOCK'});
    await ff.call('POST','/window',{handle:web});
    const start=async()=>{await click('#get');await wait('return document.activeElement?.id === "monica-passkey-prompt-host";');};
    await start();await key('\uE00C');await wait('return document.querySelector("#result").textContent;','error:NotAllowedError');
    await start();await ff.evaluate('controller.abort();return true;');await wait('return document.querySelector("#result").textContent;','error:AbortError');
    const count=await ff.evaluate('return window.__syntheticNativeCalls;');
    await start();for(let n=0;n<(locked?1:3);n++)await key('\uE004');await key('\uE007');
    await wait('return document.querySelector("#result").textContent;','synthetic-native-only');assert.equal(await ff.evaluate('return window.__syntheticNativeCalls;'),count+1);
    await ff.evaluate('window.__syntheticNativeWait=true;return true;');await start();for(let n=0;n<(locked?1:3);n++)await key('\uE004');await key('\uE007');
    await wait('return window.__syntheticNativeCalls;',count+2);await ff.evaluate('controller.abort();return true;');await wait('return document.querySelector("#result").textContent;','error:AbortError');
    assert.equal(await ff.evaluate('return window.__syntheticNativeSignal===controller.signal;'),true);await ff.evaluate('window.__syntheticNativeWait=false;return true;');
    await ff.call('POST','/window',{handle:manager});assert.equal(await send({type:'VAULT_STATUS'}),locked?'locked':'unlocked');await ff.call('POST','/window',{handle:web});
  }
  mark('locked/unlocked Passkey native handoff, Escape and AbortSignal cancellation using only synthetic native credentials');
  evidence.status='passed';
}catch(e){evidence.failure=String(e);throw e;}
finally{
  if(nativeKey){const ps=path.join(ff.profile,'unregister-test-host.ps1');await writeFile(ps,`Remove-Item -LiteralPath '${nativeKey}' -Force -ErrorAction SilentlyContinue\n`);execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',ps],{windowsHide:true});}
  await writeFile(path.join(scratch,'ui-evidence.json'),JSON.stringify(evidence,null,2));await ff.close();
  await new Promise(r=>webServer.close(r));
}
