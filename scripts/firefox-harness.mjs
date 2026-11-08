// WebDriver harness restricted to fresh, task-owned profiles. No personal data.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { zipSync } from 'fflate';
export const root = path.resolve(import.meta.dirname, '..');
export const scratch = path.join(root, '.tmp/firefox-acceptance');
export async function archiveAddon(directory, filename) {
  const files = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      files[path.relative(directory, full).split(path.sep).join('/')] = new Uint8Array(await readFile(full));
    }
  }
  await writeFile(filename, zipSync(files));
}
export async function launchFirefox(directory = path.join(root, 'dist-firefox'), options = {}) {
  await mkdir(scratch, { recursive: true });
  let profile;
  if (options.profile) {
    profile = path.resolve(options.profile);
    if (!profile.startsWith(scratch + path.sep + 'profile-')) throw Error('Only task-owned Firefox profiles may be reused');
    const marker=JSON.parse(await readFile(path.join(profile,'.monica-firefox-test-profile.json'),'utf8'));
    if(marker.kind!=='monica-firefox-synthetic-only')throw Error('Missing synthetic profile ownership marker');
  } else {
    profile = await mkdtemp(path.join(scratch, 'profile-'));
    await writeFile(path.join(profile,'.monica-firefox-test-profile.json'),JSON.stringify({kind:'monica-firefox-synthetic-only'}));
  }
  const appdata=path.join(profile,'synthetic-appdata');await mkdir(appdata,{recursive:true});
  const addon = path.join(profile, 'synthetic-test.xpi');
  await archiveAddon(directory, addon);
  const port = await reservePort();
  const driver = spawn(path.resolve(root, '../.tools/geckodriver/geckodriver.exe'), ['--port', String(port), '--allow-system-access', '--log', 'warn'], {windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,LOCALAPPDATA:appdata,APPDATA:appdata}});
  let logs = ''; driver.stderr.on('data', x => { logs += x; }); driver.stdout.on('data', x => { logs += x; });
  const base = `http://127.0.0.1:${port}`; let session;
  async function call(method, endpoint, body) {
    const response = await fetch(base + (session && !endpoint.startsWith('/session') && endpoint !== '/status' ? `/session/${session}` : '') + endpoint,
      { method, headers:{'content-type':'application/json'}, ...(body !== undefined ? {body:JSON.stringify(body)} : {}) });
    const result = await response.json(); if (!response.ok) throw Error(JSON.stringify(result.value)); return result.value;
  }
  const close = async () => { if(session) await call('DELETE', `/session/${session}`).catch(()=>{});if(driver.exitCode===null){const exited=new Promise(r=>driver.once('exit',r));driver.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,10000))]);}await writeFile(path.join(profile,'driver.log'),logs); };
  try {
    for (let n=0;n<100;n++) { try { await call('GET','/status'); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
    const created = await call('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox','moz:firefoxOptions':{
      binary:'C:/Program Files/Mozilla Firefox/firefox.exe',args:['-headless','-profile',profile],prefs:{
        'signon.rememberSignons':false,'signon.autofillForms':false,'datareporting.policy.dataSubmissionEnabled':false,
        'toolkit.telemetry.enabled':false,'intl.locale.requested':'zh-CN','extensions.webextensions.warnings-as-errors':false
      }}}}});
    session = created.sessionId;
    await call('POST','/timeouts',{script:120000,pageLoad:60000,implicit:0});
    const id = await call('POST','/moz/addon/install',{path:addon,temporary:true});
    await call('POST','/moz/context',{context:'chrome'});
    const url = await call('POST','/execute/sync',{script:'return WebExtensionPolicy.getByID(arguments[0]).getURL("")',args:[id]});
    await call('POST','/moz/context',{context:'content'});
    const evaluate = (script,args=[])=>call('POST','/execute/sync',{script,args});
    const asyncEval = (script,args=[])=>call('POST','/execute/async',{script:`var done=arguments[arguments.length-1]; Promise.resolve().then(async()=>{${script}}).then(done,e=>done({__error:String(e),stack:e.stack}));`,args});
    const goto = url => call('POST','/url',{url});
    const command = input => asyncEval('return await chrome.runtime.sendMessage(arguments[0]);',[input]);
    return {profile,url,id,browserVersion:created.capabilities.browserVersion,call,evaluate,asyncEval,goto,command,close};
  } catch(e) { await close(); throw e; }
}
async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return address.port;
}
