// Read only API capabilities in a new isolated profile. Never use personal profiles.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
const root = path.resolve(import.meta.dirname, '..');
const scratch = path.join(root, '.tmp/firefox-probe'); await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(path.join(scratch, 'profile-'));
const addon = path.join(scratch, 'probe.xpi');
await writeFile(addon, zipSync(Object.fromEntries(Object.entries({
  'manifest.json': JSON.stringify({manifest_version:3,name:'Synthetic Monica API probe',version:'1.0',permissions:['storage','webNavigation','tabs','scripting'],host_permissions:['http://127.0.0.1/*'],background:{scripts:['background.js']},browser_specific_settings:{gecko:{id:'synthetic-monica-api-probe@local.test'}},content_scripts:[{matches:['http://127.0.0.1/*'],js:['content.js'],run_at:'document_start'}]}),
  'background.js': "browser.runtime.onMessage.addListener((message,sender)=>Promise.resolve({sender,chromePromise:typeof chrome.storage.local.get('probe')?.then,browserPromise:typeof browser.storage.local.get('probe')?.then,session:typeof browser.storage.session,getContexts:typeof browser.runtime.getContexts,sidebar:typeof browser.sidebarAction,offscreen:typeof browser.offscreen}));",
  'content.js': "browser.runtime.sendMessage({probe:true}).then(value=>document.documentElement.setAttribute('data-probe',JSON.stringify(value)));",
  'probe.html': '<!DOCTYPE html><title>Synthetic API probe</title>'
}).map(([name,content]) => [name,strToU8(content)]))));
const port = await reservePort();
const driver = spawn(path.resolve(root,'../.tools/geckodriver/geckodriver.exe'), ['--port',String(port),'--allow-system-access','--log','warn'], {windowsHide:true,stdio:['ignore','pipe','pipe']});
driver.stderr.on('data', chunk => process.stderr.write(chunk));
const base=`http://127.0.0.1:${port}`; let session;
async function call(method,endpoint,body) { const r=await fetch(base+endpoint,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}); const j=await r.json(); if(j.value?.error)throw Error(JSON.stringify(j));return j.value; }
try {
  for(let n=0;n<50;n++) { try { await call('GET','/status'); break; } catch { await new Promise(resolve=>setTimeout(resolve,100)); } }
  const created=await call('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{binary:'C:/Program Files/Mozilla Firefox/firefox.exe',args:['-headless','-profile',profile],prefs:{'signon.rememberSignons':false,'signon.autofillForms':false,'datareporting.policy.dataSubmissionEnabled':false,'toolkit.telemetry.enabled':false}}}}});session=created.sessionId;
  const prefix=`/session/${session}`;
  const id=await call('POST',prefix+'/moz/addon/install',{path:addon,temporary:true});
  await call('POST',prefix+'/moz/context',{context:'chrome'});
  const url=await call('POST',prefix+'/execute/sync',{script:'return WebExtensionPolicy.getByID(arguments[0]).getURL("probe.html")',args:[id]});
  await call('POST',prefix+'/moz/context',{context:'content'});
  await call('POST',prefix+'/url',{url});
  const capabilities=await call('POST',prefix+'/execute/async',{script:'var done=arguments[arguments.length-1]; browser.runtime.sendMessage({probe:true}).then(async value=>done({...value,frames:await browser.webNavigation.getAllFrames({tabId:(await browser.tabs.getCurrent()).id})})).catch(e=>done({error:String(e)}));',args:[]});
  console.log(JSON.stringify({profile,browserVersion:created.capabilities.browserVersion,url,capabilities},null,2));
  await writeFile(path.join(scratch,'capabilities.json'),JSON.stringify({profile,browserVersion:created.capabilities.browserVersion,url,capabilities},null,2));
} finally { if(session)await call('DELETE',`/session/${session}`).catch(()=>{});if(driver.exitCode===null){const exited=new Promise(r=>driver.once('exit',r));driver.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,10000))]);} }

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}
