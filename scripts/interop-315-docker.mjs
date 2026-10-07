import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Generates only synthetic credentials, in the ignored task-specific directory.
const root = resolve(import.meta.dirname, '..');
const dir = resolve(root, '.tmp/interop-315-docker');
const configPath = resolve(dir, 'services.json');
const project = 'monica315-interop-20260930';
const compose = resolve(root, 'tests/interop/docker315/compose.yaml');
const run = (args, options={}) => execFileSync('docker', args, { windowsHide:true, cwd:root, encoding:'utf8', ...options });
await mkdir(dir, { recursive:true });
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!config) {
  const password = `synthetic-${randomBytes(24).toString('hex')}`;
  const passwd = run(['run','--rm','--entrypoint','htpasswd','httpd:2.4.65-alpine','-nbB','monica315',password]);
  await writeFile(resolve(dir,'test.htpasswd'),passwd);
  config = { webdav:{baseUrl:'http://127.0.0.1:18315',username:'monica315',password}, vaultwarden:{baseUrl:'http://127.0.0.1:18316',password:`Synthetic-${randomBytes(24).toString('hex')}`}, versions:{webdav:'Apache httpd 2.4.65',vaultwarden:'1.37.3'}, project, generatedAt:new Date().toISOString() };
  await writeFile(configPath,JSON.stringify(config,null,2));
}
const env = {...process.env,MONICA_315_HTPASSWD:resolve(dir,'test.htpasswd')};
if (process.argv.includes('--stop')) {
  run(['compose','-p',project,'-f',compose,'stop'],{env,stdio:'inherit'});
} else {
  run(['compose','-p',project,'-f',compose,'up','-d','--build'],{env,stdio:'inherit'});
  const inspect = JSON.parse(run(['compose','-p',project,'-f',compose,'ps','--format','json'],{env}).trim().split('\n').filter(Boolean).map(line=>line).join(',').replace(/^/,'[').replace(/$/,']'));
  await writeFile(resolve(dir,'deployment.json'),JSON.stringify({at:new Date().toISOString(),docker:JSON.parse(run(['version','--format','{{json .}}'])),containers:inspect,project,configPath},null,2));
  console.log(JSON.stringify({configPath,project,ports:[18315,18316],credentials:'synthetic; stored only in ignored services.json'}));
}
