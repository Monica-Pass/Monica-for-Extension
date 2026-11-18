import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {requestWindowsHelloHost,expectHostSuccess} from './windows-hello-native-protocol.mjs';

// Package an existing executable; never trigger a native rebuild from UI builds.
const output=resolve(process.env.MONICA_BUILD_OUT_DIR || 'dist','nearby-helper');await mkdir(output,{recursive:true});
const executable=resolve(process.env.MONICA_WIFI_HOST_EXECUTABLE || 'native/mdbx2-host/target/release/monica-mdbx2-host.exe');
let available=process.platform==='win32' && process.arch==='x64';
try{await access(executable);}catch{available=false;}
if(available){
  const probe=resolve('.artifacts/nearby-helper-probe');await mkdir(probe,{recursive:true});
  const hello=expectHostSuccess(await requestWindowsHelloHost({executable,localAppData:probe,method:'host.hello',params:{}}),'host.hello');
  if(hello.nearbyTransportVersion!==2)throw new Error('Wi-Fi component must support transport version 2.');
  const binary=await readFile(executable),sha256=createHash('sha256').update(binary).digest('hex');
  const metadata=JSON.stringify({platform:'windows-x64',nearbyTransportVersion:2,sha256,bytes:binary.length},null,2);
  const files={
    'monica-mdbx2-host.exe':binary,
    'install-wifi.ps1':await readFile('native/mdbx2-host/install-wifi.ps1'),
    'WIFI-HELPER.json':Buffer.from(metadata),
    'LICENSE':await readFile('LICENSE'),
    'README.txt':Buffer.from('Monica Wi-Fi communication component (Windows x64).\r\nExtract this ZIP, open PowerShell in the extracted folder, and run the command shown by Monica Wi-Fi settings.\r\nThe installer checks the executable checksum and registers only the selected browser and exact extension IDs for the current user. It does not enroll Windows Hello or access vault records.\r\nSource: https://github.com/Monica-Pass/Monica-for-Extension/tree/main/native/mdbx2-host\r\n')
  };
  const date=new Date(1980,0,1);await writeFile(resolve(output,'monica-wifi-windows-x64.zip'),zipSync(Object.fromEntries(Object.entries(files).map(([name,data])=>[name,[data,{mtime:date}]])),{level:6}));
  console.log('Bundled Windows Wi-Fi setup; capability handshake passed; SHA256 '+sha256);
}
await writeFile(resolve(output,'availability.json'),JSON.stringify({windowsX64:available}));
