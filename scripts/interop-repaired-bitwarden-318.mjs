import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root=resolve(import.meta.dirname,'..'), workspace=resolve(root,'..');
const project=join(workspace,'Monica-main/Monica for Android');
const output=join(root,'.tmp/android-bitwarden-repaired-318');
const build=join(output,'build'), stage=process.argv[2];
const adbExecutable=`${process.env.ANDROID_SDK_ROOT||'D:/AndroidSDK'}/platform-tools/adb.exe`;
const adbSerial=process.env.ANDROID_SERIAL||'emulator-5554';
const adb=(...args)=>execFileSync(adbExecutable,['-s',adbSerial,...args],{windowsHide:true,maxBuffer:256*1024*1024});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>JSON.parse(await readFile(join(output,file),'utf8'));
const save=async(file,value)=>writeFile(join(output,file),JSON.stringify(value,null,2)+'\n');
const packageInfo=name=>{
  const path=adb('shell','pm','path',name).toString().trim().replace(/^package:/,'');
  assert.match(path,/^\/data\/app\/[^\r\n]+\/base\.apk$/);
  const sha256=adb('shell','sha256sum',path).toString().split(/\s+/)[0];assert.match(sha256,/^[a-f0-9]{64}$/);
  return {path,sha256};
};
function idle(){
  assert.match(adb('emu','avd','name').toString(),/^Monica_Issue136_API_32\r?\r?$/m);
  const state=adb('shell','dumpsys','activity','processes').toString();
  assert.ok(state.includes('ACTIVITY MANAGER RUNNING PROCESSES')&&!state.includes('ActiveInstrumentation{'));
}
const boot=()=>adb('shell','cat','/proc/sys/kernel/random/boot_id').toString().trim();
const runtimeReportPath=join(workspace,'.codex-tasks/passkey-fix-20261010/verification.json');
const runtimeReport=JSON.parse(await readFile(runtimeReportPath,'utf8')).main;
async function verifySources(expected){for(const [file,sha] of Object.entries(expected)) assert.equal(hash(await readFile(file)),sha,`Source changed: ${file}`);}
await mkdir(output,{recursive:true});
if(stage==='capture'){
  idle();assert.equal(packageInfo('takagi.ru.monica').sha256,runtimeReport.debugApkSHA256);
  try{await readFile(join(output,'baseline.json'));throw new Error('Baseline already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  const sourceHashes={};
  for(const [file,sha] of Object.entries(runtimeReport.sourceSHA256)) sourceHashes[join(project,'app/src',file)]=sha;
  await verifySources(sourceHashes);
  const sourceRoot=join(output,'sources/takagi/ru/monica/credentialexchange');await mkdir(sourceRoot,{recursive:true});
  const testSources={};
  for(const file of [join(project,'app/src/androidTest/java/takagi/ru/monica/credentialexchange/TransferFixture.kt'),join(root,'tests/interop/android-app/src/takagi/ru/monica/credentialexchange/ExtensionBitwardenCopyInteropTest.kt')]){
    const bytes=await readFile(file),name=file.split(/[\\/]/).at(-1);testSources[file]=hash(bytes);await writeFile(join(sourceRoot,name),bytes);
  }
  const compileApi=join(project,'app/build/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar');
  const test=packageInfo('takagi.ru.monica.test'),app=packageInfo('takagi.ru.monica');
  assert.equal(test.sha256,runtimeReport['androidTest/debugApkSHA256']);
  const original=adb('exec-out','cat',test.path);assert.equal(hash(original),test.sha256);await writeFile(join(output,'original-test.apk'),original);
  await save('baseline.json',{at:new Date().toISOString(),app,test,bootId:boot(),sourceHashes,testSources,compileApi,compileApiSha256:hash(await readFile(compileApi)),runtimeReportPath,runtimeReportSha256:hash(await readFile(runtimeReportPath))});
  console.log('Captured current repaired application, compile API, source and instrumentation provenance.');
}else{
  const baseline=await read('baseline.json');
  assert.equal(packageInfo('takagi.ru.monica').sha256,baseline.app.sha256);
  await verifySources(baseline.sourceHashes);await verifySources(baseline.testSources);
  if(stage==='build'){
    assert.equal(hash(await readFile(baseline.compileApi)),baseline.compileApiSha256);
    const classes=join(build,'app/intermediates/compile_app_classes_jar/debug/bundleDebugClassesToCompileJar/classes.jar');await mkdir(resolve(classes,'..'),{recursive:true});await copyFile(baseline.compileApi,classes);
    const env={...process.env,JAVA_HOME:process.env.JAVA_HOME||'C:/jdk-17.0.1',GRADLE_USER_HOME:process.env.GRADLE_USER_HOME||'D:/GradleRepository',MONICA_APP_INTEROP_BUILD_DIR:build,
      MONICA_APP_INTEROP_SOURCE_DIR:join(output,'sources'),MONICA_APP_INTEROP_REPLACE_TEST_SOURCES:'1',MONICA_APP_INTEROP_REUSE_VERIFIED_APPLICATION:'1',
      MONICA_APP_INTEROP_TEST_MANIFEST:join(root,'tests/interop/android-app/passkey-signatures-AndroidManifest.xml')};
    const args=['--init-script',`"${join(root,'tests/interop/android-app/interop.init.gradle')}"`,':app:assembleDebugAndroidTest','-PincludeX86TestAbi','--max-workers=2','--console=plain'];
    await new Promise((done,fail)=>{const child=spawn('gradlew.bat',args,{cwd:project,env,windowsHide:true,shell:true,stdio:'inherit'});child.on('error',fail);child.on('exit',code=>code===0?done():fail(new Error(`Gradle exited ${code}`)));});
    await verifySources(baseline.sourceHashes);await verifySources(baseline.testSources);
    assert.equal(hash(await readFile(classes)),baseline.compileApiSha256);
    const apk=join(build,'app/outputs/apk/androidTest/debug/app-debug-androidTest.apk');
    await copyFile(apk,join(output,'targeted-test.apk'));
    await save('build-evidence.json',{at:new Date().toISOString(),testApkSha256:hash(await readFile(apk)),compileApiSha256:baseline.compileApiSha256,sourceVerified:true,androidApplicationRebuilt:false});
  }else if(stage==='run'){
    idle();assert.equal(boot(),baseline.bootId);
    const built=await read('build-evidence.json');assert.equal(packageInfo('takagi.ru.monica.test').sha256,baseline.test.sha256);
    assert.equal(hash(await readFile(join(output,'targeted-test.apk'))),built.testApkSha256);
    const cases=[];for(const name of ['direct','copies-complete','copies-cancel']){const value=await read(`${name}-input.json`);assert.equal(value.synthetic,true);cases.push(value);}
    await save('bitwarden-snapshot-input.json',{synthetic:true,cases});
    const remoteDir='files/extension-interop-315', backups={};
    for(const name of ['bitwarden-snapshot-input.json','android-bitwarden-copies.json']){
      try{backups[name]=adb('exec-out','run-as','takagi.ru.monica','cat',`${remoteDir}/${name}`);await writeFile(join(output,`previous-${name}`),backups[name]);}catch{/* No earlier fixture file. */}
    }
    let installed=false,runOutput='';
    try{
      adb('install','-r','-t',join(output,'targeted-test.apk'));installed=true;
      adb('shell','run-as','takagi.ru.monica','mkdir','-p',remoteDir);
      adb('push',join(output,'bitwarden-snapshot-input.json'),'/data/local/tmp/monica-repaired-bw-input.json');
      adb('shell','run-as','takagi.ru.monica','cp','/data/local/tmp/monica-repaired-bw-input.json',`${remoteDir}/bitwarden-snapshot-input.json`);
      const log=join(output,'device.log');
      await new Promise((done,fail)=>{const child=spawn(adbExecutable,['-s',adbSerial,'shell','am','instrument','-w','-r','-e','class','takagi.ru.monica.credentialexchange.ExtensionBitwardenCopyInteropTest','takagi.ru.monica.test/androidx.test.runner.AndroidJUnitRunner'],{windowsHide:true});
        child.stdout.on('data',chunk=>{runOutput+=chunk;process.stdout.write(chunk);});child.stderr.on('data',chunk=>{runOutput+=chunk;process.stderr.write(chunk);});child.on('error',fail);child.on('exit',code=>code===0?done():fail(new Error(`adb instrument ${code}`)));});
      await writeFile(log,runOutput);
      const bytes=adb('exec-out','run-as','takagi.ru.monica','cat',`${remoteDir}/android-bitwarden-copies.json`);await writeFile(join(output,'android-bitwarden-copies.json'),bytes);
      await verifySources(baseline.sourceHashes);await verifySources(baseline.testSources);
      const evidence={at:new Date().toISOString(),androidSourcesUnchanged:true,testSourcesUnchanged:true,installedApplicationUnchanged:packageInfo('takagi.ru.monica').sha256===baseline.app.sha256,
        installedTestApkUnchanged:packageInfo('takagi.ru.monica.test').sha256===built.testApkSha256,deviceBootUnchanged:boot()===baseline.bootId,
        outputs:[{name:'android-bitwarden-copies.json',sha256:hash(bytes)}],baseline:'baseline.json',build:'build-evidence.json'};
      await save('bitwarden-copies-evidence.json',evidence);
      assert.match(runOutput,/OK \(1 test\)/);assert.equal(JSON.parse(bytes).status,'passed');
    }finally{
      await writeFile(join(output,'device.log'),runOutput);
      if(installed){idle();assert.equal(packageInfo('takagi.ru.monica.test').sha256,built.testApkSha256);assert.equal(hash(await readFile(join(output,'original-test.apk'))),baseline.test.sha256);adb('install','-r','-t',join(output,'original-test.apk'));}
      for(const name of Object.keys(backups)){
        adb('push',join(output,`previous-${name}`),'/data/local/tmp/monica-repaired-bw-restore.json');adb('shell','run-as','takagi.ru.monica','cp','/data/local/tmp/monica-repaired-bw-restore.json',`${remoteDir}/${name}`);
      }
      assert.equal(packageInfo('takagi.ru.monica').sha256,baseline.app.sha256);assert.equal(packageInfo('takagi.ru.monica.test').sha256,baseline.test.sha256);
      await save('restoration.json',{at:new Date().toISOString(),appUnchanged:true,originalInstrumentationRestored:true,emulatorStopped:false});
    }
  }else throw new Error('Use capture, build or run');
}
