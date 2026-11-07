<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { tr as cliTr } from '../cli/i18n';
import { CliError, CliNativeClient, type CliDatabase, type CliEntry, type CliSnapshot, type CliHello, type CliReceipt,type CliKey } from '../cli/native-client';
import { CliRecovery,type PendingOperation } from '../cli/recovery';
import SettingsPasswordField from './SettingsPasswordField.vue';
import { nativeInstallerBrowser } from '../runtime/browser-platform';

const busy = ref(false), available = ref(false), unlocked = ref(false), error = ref(''), notice = ref('');
const password = ref(''), databases = ref<CliDatabase[]>([]), database = ref('current');
const snapshot = ref<CliSnapshot>(), category = ref(''), query = ref(''), tab = ref('content');
const hello=ref<CliHello>(),keys=ref<CliKey[]>([]),keyFile=ref<File>(),sessionKeyFile=ref<File>(),authPassword=ref('');
const recovery=new CliRecovery(),pending=ref<PendingOperation[]>(recovery.list()),receipts=reactive<Record<string,CliReceipt>>({});
const grant=reactive({connection:'',repositories:'',ttl:240,rpm:60,maxCalls:0,approval:'write',readIssue:true,writeIssue:false,apiRead:false,apiWrite:false});
const key=reactive({algorithm:'ed25519',format:'ssh',text:''}),webdavPassword=ref('');
const dialog = ref<HTMLDialogElement>(), action = ref(''), entry = ref<CliEntry>();
const form = reactive({ title:'', target:'', name:'', provider:'github', token:'', username:'', website:'', secret:'', notes:'', head:'', identity:'', replaceUsername:false, replaceWebsite:false, replaceSecret:false, replaceNotes:false });
let disposed = false, revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
let ownerTab: number | undefined, ownerWindow: number | undefined;
const client = new CliNativeClient(undefined, () => clear());
const currentDatabase = computed(() => databases.value.find(d => d.current));
const extensionId = chrome.runtime.id;
const categories = computed(() => snapshot.value?.categories || []);
const childCategories = computed(() => categories.value.filter(c => (c.parent || '') === category.value));
const entries = computed(() => (snapshot.value?.entries || []).filter(e => (!category.value || e.category === category.value) && `${e.title} ${e.kind} ${e.connection || ''}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const selectedCategory = computed(() => categories.value.find(c => c.id === category.value));
const installCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\install-browser.ps1 -${nativeInstallerBrowser()}ExtensionId ${chrome.runtime.id}`;
function clearForm() {
  form.title=''; form.target=''; form.name=''; form.provider='github'; form.token=''; form.username=''; form.website=''; form.secret=''; form.notes=''; form.head=''; form.identity='';
  form.replaceUsername=false; form.replaceWebsite=false; form.replaceSecret=false; form.replaceNotes=false;
  authPassword.value='';key.text='';webdavPassword.value='';
  Object.assign(grant,{connection:'',repositories:'',ttl:240,rpm:60,maxCalls:0,approval:'write',readIssue:true,writeIssue:false,apiRead:false,apiWrite:false});
  key.algorithm='ed25519';key.format='ssh';
}
function clear() {
  revision++; unlocked.value=false; snapshot.value=undefined; password.value=''; query.value=''; category.value='';
  dialog.value?.close(); action.value=''; entry.value=undefined; clearForm(); clearTimeout(timer);
  keyFile.value=undefined;sessionKeyFile.value=undefined;keys.value=[];pending.value=recovery.list();
}
function lock() { client.close(); }
function arm() { clearTimeout(timer); timer=setTimeout(lock, 300000); }
function message(e: unknown) {
  const code = e instanceof CliError ? e.code : 'operation_failed';
  const known: Record<string,string> = {
    host_unavailable:'无法连接 Monica CLI，请先安装浏览器联动组件。',
    host_not_registered:'尚未注册 CLI 浏览器联动，请运行安装脚本。',
    origin_not_allowed:'当前扩展 ID 未获准连接，请用此页面的扩展 ID 重新注册。',
    host_exited:'CLI 辅助程序已退出，请运行安装诊断并核对保存结果。',
    host_incompatible:'CLI 辅助程序版本或能力不兼容，请同时更新 CLI 和浏览器辅助程序。',
    host_not_negotiated:'请先重新连接 CLI 并检查组件版本。',
    recovery_required:'还有保存结果需要核对，请先检查下方回执。',
    unlock_required:'CLI 已锁定或密码不正确，请重新解锁。',
    broker_already_running:'CLI 仍在处理请求，请稍后重试。',
    object_changed:'内容已经改变，请刷新后重新编辑。',
    object_read_only:'此条目暂不支持编辑，原内容已保留。',
    protected_collection:'Android 默认目录不能删除或移动。',
    attachment_move_unsupported:'此条目含附件，目前不能移动。',
    already_exists:'名称已存在，请使用其他名称。',
    invalid_request:'操作无效。删除目录前请先移出子目录和条目。',
    timeout:'等待 CLI 超时，保存结果尚未确认。请重新连接并检查内容后再操作。',
    response_too_large:'CLI 内容超过浏览器通道容量，请先在 CLI 中管理。',
    input_too_large:'CLI 内容超过浏览器通道容量，请先在 CLI 中管理。',
    glitter_unavailable:'CLI 暂不支持此数据库的保护级别。',
    not_found:'数据库或条目已不存在，请刷新后重试。',
  };
  error.value=cliTr(known[code] || 'CLI 操作未完成，请检查数据库状态后重试。');
  if (['host_incompatible','host_not_registered','origin_not_allowed'].includes(code))available.value=false;
  if (['unlock_required','object_changed'].includes(code)) lock();
}
async function run(work: () => Promise<void>) {
  if (busy.value || disposed) return;
  busy.value=true; error.value=''; notice.value='';
  try { await work(); } catch(e) { if (!disposed) message(e); }
  finally { busy.value=false; }
}
async function request<T>(command: Record<string, unknown>): Promise<T> {
  const expected = revision;
  const result = await client.request<T>(command);
  if (disposed || revision !== expected) throw new CliError('closed',true);
  arm(); return result;
}
async function connect() {
  const result = await request<CliHello>({op:'hello'});
  hello.value=result;available.value=true; databases.value=result.databases;
  if(!result.databases.some(d=>d.id===database.value))database.value='current';
}
function supports(capability:string) {return hello.value?.capabilities.includes(capability)===true;}
async function fileBytes(file:File|undefined):Promise<string|null> {
  if(!file)return null;if(!file.size || file.size>32768)throw new CliError('input_too_large');
  const bytes=new Uint8Array(await file.arrayBuffer());try{return btoa(String.fromCharCode(...bytes));}finally{bytes.fill(0);}
}
function selectFile(event:Event) {
  const input=event.target as HTMLInputElement;const file=input.files?.[0];input.value='';
  keyFile.value=file;
}
async function factors() {const password=authPassword.value;authPassword.value='';return {password,key_file:await fileBytes(sessionKeyFile.value)};}
function operationLabel(operation:string) {
  return cliTr(({
    switch_database:'切换数据库',create_category:'新建目录',rename_category:'重命名目录',move:'移动条目',delete:'删除条目',delete_category:'删除目录',create_password:'新增 CLI 密码',edit_password:'编辑 CLI 密码',add_connection:'新增 CLI 连接',rename_connection:'重命名连接',replace_token:'替换 Token',revoke:'撤销 AI 授权',generate_ssh:'生成 SSH 密钥',import_key:'导入 SSH / GPG',issue_grant:'创建 AI 授权',renew_grant:'续期 AI 授权',sync:'同步 CLI 数据库'
  } as Record<string,string>)[operation] || 'CLI 内容管理');
}
const currentPending=computed(()=>pending.value.filter(p=>p.database===currentDatabase.value?.path && (!p.vault||p.vault===snapshot.value?.vault_id)));
async function reconcile() {
  for(const item of currentPending.value) {
    const receipt=await request<CliReceipt>({op:'operation_status',operation:item.id});receipts[item.id]=receipt;
    if(receipt.state==='succeeded') {recovery.forget(item.id);notice.value=cliTr('已核对：保存成功。原操作未重发。');}
  }
  pending.value=recovery.list();await refresh();
}
async function acknowledge(item:PendingOperation) {
  // A human explicitly checks the current snapshot; this only dismisses a
  // warning. It never executes, reconstructs or retries the old request.
  await refresh();recovery.forget(item.id);delete receipts[item.id];pending.value=recovery.list();
}
async function mutate(command:Record<string,unknown>,switchPath?:string) {
  if(!switchPath && currentPending.value.length)throw new CliError('recovery_required');
  const record=recovery.begin(switchPath?'':snapshot.value!.vault_id,switchPath||currentDatabase.value!.path,String(command.op));pending.value=recovery.list();
  try {
    const result=await request<{receipt:CliReceipt;saved?:boolean;locked?:boolean} >({...command,operation_id:record.id});
    if(result.receipt?.operation_id!==record.id || result.receipt.state!=='succeeded')throw new CliError('invalid_reply',true);
    recovery.forget(record.id);pending.value=recovery.list();return result;
  }catch(e){if(e instanceof CliError && !e.sent){recovery.forget(record.id);pending.value=recovery.list();}throw e;}
}
async function refresh() {
  const result=await request<CliSnapshot>({op:'snapshot'});
  snapshot.value=result; databases.value=result.databases;
  if (category.value && !result.categories.some(c => c.id===category.value)) category.value='';
}
async function unlock() {
  const value=password.value;password.value='';const selected=keyFile.value;keyFile.value=undefined;
  if(!client.ready)await connect();
  const key_file=await fileBytes(selected);
  if (database.value !== 'current') {
    const path=databases.value.find(d=>d.id===database.value)?.path;if(!path)throw new CliError('not_found');
    await mutate({op:'switch_database',database:database.value,password:value,key_file},path);
    await connect(); database.value='current';
    notice.value=cliTr('数据库已切换，旧 AI 授权已撤销。请解锁当前数据库。'); return;
  }
  const result=await request<CliSnapshot>({op:'unlock',password:value,key_file});
  snapshot.value=result; databases.value=result.databases; sessionKeyFile.value=selected;unlocked.value=true;
  if(currentPending.value.length)await reconcile();
}
function open(kind:string, item?:CliEntry) {
  clearForm(); action.value=kind; entry.value=item;
  form.title=item?.title || selectedCategory.value?.title || '';
  if (['password-new','category-new','connection-new'].includes(kind)) form.title='';
  form.target=category.value; form.identity=crypto.randomUUID();
  dialog.value?.showModal();
}
async function editPassword(item:CliEntry) {
  const info=await request<{head_commit_id:string;android_roundtrip_identity:boolean}>({op:'password_info',entry:item.id});
  if (!info.android_roundtrip_identity) throw new CliError('object_read_only');
  open('password-edit',item); form.head=info.head_commit_id;
}
function closeDialog() { if (!busy.value) {dialog.value?.close(); clearForm(); action.value='';entry.value=undefined;} }
async function save() {
  let command: Record<string,unknown>;
  const id=entry.value?.id || category.value;
  switch(action.value) {
    case 'password-new': case 'password-edit': {
      const fields:Record<string,string>={};
      const creating=action.value==='password-new';
      if (creating || form.replaceUsername) fields.username=form.username;
      if (creating || form.replaceWebsite) fields.website=form.website;
      if (creating || form.replaceSecret) fields.password_plain=form.secret;
      if (creating || form.replaceNotes) fields.notes=form.notes;
      command=creating ? {op:'create_password',identity:form.identity,title:form.title,category:category.value||null,fields:JSON.stringify(fields)} : {op:'edit_password',entry:id,head:form.head,title:form.title,fields:JSON.stringify(fields)};
      break;
    }
    case 'category-new': command={op:'create_category',title:form.title,parent:category.value||null}; break;
    case 'category-rename': command={op:'rename_category',entry:id,title:form.title}; break;
    case 'move': case 'category-move': command={op:'move',entry:id,target:form.target};break;
    case 'delete': command={op:'delete',entry:id};break;
    case 'category-delete':command={op:'delete_category',entry:id};break;
    case 'connection-new':command={op:'add_connection',name:form.name,title:form.title,provider:form.provider,category:category.value||null,token:form.token};break;
    case 'connection-rename': command={op:'rename_connection',name:entry.value?.connection,title:form.title};break;
    case 'token':command={op:'replace_token',name:entry.value?.connection,token:form.token};break;
    case 'revoke':command={op:'revoke',name:form.name};break;
    case 'ssh-new':command={op:'generate_ssh',title:form.title,category:category.value||null,algorithm:key.algorithm,auth:await factors()};break;
    case 'key-import':command={op:'import_key',title:form.title,category:category.value||null,format:key.format,text:key.text,auth:await factors()};break;
    case 'grant-new':command={op:'issue_grant',name:form.name,connection:grant.connection,repositories:grant.repositories.split(/[\n,]+/).map(r=>r.trim()).filter(Boolean),operations:[...(grant.readIssue?['list_issues','get_issue']:[]),...(grant.writeIssue?['create_issue']:[]),...(grant.apiRead?['api_read']:[]),...(grant.apiWrite?['api_write']:[])],ttl_minutes:Number(grant.ttl),requests_per_minute:Number(grant.rpm),max_calls:Number(grant.maxCalls),approval:grant.approval,auth:await factors()};break;
    case 'grant-renew':command={op:'renew_grant',name:form.name,auth:await factors()};break;
    case 'sync':command={op:'sync',webdav_password:webdavPassword.value,auth:await factors()};break;
    default:return;
  }
  dialog.value?.close(); clearForm(); action.value=''; entry.value=undefined;
  const result=await mutate(command);
  notice.value=cliTr('已保存到 CLI 数据库。');
  if(result.locked){lock();notice.value=cliTr('同步已完成，请重新解锁并查看结果。');return;}
  await refresh();
  if(tab.value==='keys')await loadKeys();
}
async function loadKeys() {keys.value=(await request<{keys:CliKey[]}>({op:'keys'})).keys;}
const needsAuth=computed(()=>['ssh-new','key-import','grant-new','grant-renew','sync'].includes(action.value));
const heading = computed(() => cliTr(({'ssh-new':'生成 SSH 密钥','key-import':'导入 SSH / GPG','grant-new':'创建 AI 授权','grant-renew':'续期 AI 授权','sync':'同步 CLI 数据库','password-new':'新增 CLI 密码','password-edit':'编辑 CLI 密码','category-new':'新建 CLI 目录','category-rename':'重命名目录','category-move':'移动目录','category-delete':'删除目录','move':'移动条目','delete':'删除条目','connection-new':'新增 CLI 连接','connection-rename':'重命名连接','token':'替换 Token','revoke':'撤销 AI 授权'} as Record<string,string>)[action.value] || 'CLI 内容管理'));
function visibility() { if(document.hidden) lock(); }
function pagehide() {lock();}
function activated(info: chrome.tabs.OnActivatedInfo) {
  if (ownerTab === undefined || (info.windowId === ownerWindow && info.tabId !== ownerTab)) lock();
}
function storageChanged(event:StorageEvent){if(event.key?.startsWith('monica.cli.operation.'))pending.value=recovery.list();}
onMounted(() => {
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);window.addEventListener('blur',pagehide);
  chrome.tabs.onActivated.addListener(activated);
  window.addEventListener('storage',storageChanged);
  void chrome.tabs.getCurrent().then(tab => {ownerTab=tab?.id;ownerWindow=tab?.windowId;}).catch(()=>undefined);
  void run(connect);
});
onUnmounted(() => {
  disposed=true;lock();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);window.removeEventListener('blur',pagehide);
  chrome.tabs.onActivated.removeListener(activated);
  window.removeEventListener('storage',storageChanged);
});
</script>

<template>
  <section class="cli-management" data-cli-management :aria-busy="busy">
    <header class="cli-header"><div><h2>Monica CLI · {{ cliTr('不完善') }}</h2><p>{{ cliTr('直接管理本机 CLI 数据库') }}</p><small v-if="hello">{{ cliTr('辅助程序') }} {{ hello.version }} · {{ cliTr('协议') }} {{ hello.protocol }}</small></div><m3e-button v-if="unlocked" type="button" variant="tonal" @click="lock">{{ cliTr('锁定 CLI') }}</m3e-button></header>
    <p v-if="error" role="alert" class="cli-error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="!unlocked">
      <p>{{ cliTr('主密码仅用于本机 CLI 授权。离开此页面、切到其他标签页或 5 分钟无操作后锁定；最长会话 15 分钟。') }}</p>
      <form v-if="available && databases.length" class="cli-form" @submit.prevent="run(unlock)">
        <label for="cli-database">{{ cliTr('CLI 数据库') }}</label><select id="cli-database" v-model="database" :disabled="busy"><option v-for="db in databases" :key="db.id" :value="db.id">{{ db.name }}{{ db.current ? ` · ${cliTr('当前')}` : '' }}</option></select>
        <SettingsPasswordField v-model="password" :label="cliTr('CLI 主密码')" autocomplete="off" />
        <label v-if="supports('key_file_bytes')">{{ cliTr('密钥文件（可选，最多 32 KiB）') }}<input type="file" @change="selectFile($event)" :disabled="busy" /><small>{{ keyFile?.name }}</small></label>
        <small>{{ cliTr('需要密钥文件时，先选择文件再输入主密码。系统文件选择器会触发失焦锁定。') }}</small>
        <p v-if="database !== 'current'" class="cli-error">{{ cliTr('切换数据库会撤销旧 AI 授权，并保留原数据库文件。') }}</p>
        <m3e-button type="submit" variant="filled" :disabled="busy || !password">{{ database==='current' ? cliTr('解锁 CLI') : cliTr('切换数据库') }}</m3e-button>
      </form>
      <p v-else-if="available">{{ cliTr('CLI 尚无数据库，请先运行 monica 初始化或打开数据库。') }}</p>
      <m3e-button variant="tonal" :disabled="busy" @click="run(connect)">{{ cliTr('重新连接 CLI') }}</m3e-button>
      <details><summary>{{ cliTr('安装浏览器联动') }}</summary><p>{{ cliTr('在 CLI 安装目录执行以下命令，需要新版 CLI 附带的 monica-browser-host 和安装脚本。') }}</p><code>{{ installCommand }}</code><p>{{ cliTr('扩展 ID') }}: <code>{{ extensionId }}</code></p><p>{{ cliTr('只读安装诊断') }}</p><code>{{ installCommand }} -Diagnose</code><p>{{ cliTr('诊断区分注册、扩展 ID、宿主版本和 CLI 初始化状态，不读取保险库秘密。') }}</p></details>
    </template>
    <template v-else-if="snapshot">
      <div class="cli-toolbar"><strong>{{ currentDatabase?.name }}</strong><m3e-button variant="text" :disabled="busy" @click="run(refresh)">{{ cliTr('刷新') }}</m3e-button></div>
      <div class="cli-tabs" role="group" :aria-label="cliTr('CLI 管理视图')"><m3e-button type="button" :variant="tab==='content'?'filled':'text'" @click="tab='content'">{{ cliTr('内容') }}</m3e-button><m3e-button type="button" :variant="tab==='gateway'?'filled':'text'" @click="tab='gateway'">{{ cliTr('连接与 AI 授权') }}</m3e-button><m3e-button v-if="supports('key_management')" type="button" :disabled="busy" :variant="tab==='keys'?'filled':'text'" @click="run(async()=>{tab='keys';await loadKeys();})">{{ cliTr('SSH / GPG 密钥') }}</m3e-button></div>
      <m3e-button v-if="supports('configured_sync') && snapshot.sync?.configured" type="button" variant="tonal" :disabled="busy || currentPending.length>0" @click="open('sync')">{{ cliTr('同步 CLI 数据库') }}</m3e-button>
      <template v-if="tab==='content'">
        <label class="cli-search">{{ cliTr('搜索 CLI 内容') }}<m3e-form-field variant="filled"><input v-model="query" type="search" :aria-label="cliTr('搜索 CLI 内容')" /></m3e-form-field></label>
        <div class="cli-toolbar"><m3e-button variant="text" @click="category=selectedCategory?.parent || ''">{{ category ? cliTr('上级目录') : cliTr('所有内容') }}</m3e-button><strong>{{ selectedCategory?.title || cliTr('所有内容') }}</strong></div>
        <div class="cli-actions"><m3e-button variant="filled" :disabled="busy" @click="open('password-new')">{{ cliTr('新增 CLI 密码') }}</m3e-button><m3e-button variant="tonal" :disabled="busy" @click="open('category-new')">{{ cliTr('新建目录') }}</m3e-button><m3e-button variant="tonal" :disabled="busy" @click="open('connection-new')">{{ cliTr('新增 CLI 连接') }}</m3e-button></div>
        <div v-if="category" class="cli-actions"><m3e-button variant="text" :disabled="busy" @click="open('category-rename')">{{ cliTr('重命名目录') }}</m3e-button><m3e-button variant="text" :disabled="busy" @click="open('category-move')">{{ cliTr('移动目录') }}</m3e-button><m3e-button variant="text" :disabled="busy" @click="open('category-delete')">{{ cliTr('删除目录') }}</m3e-button></div>
        <div class="cli-list"><button v-for="folder in childCategories" :key="folder.id" class="cli-folder" :disabled="busy" @click="category=folder.id;query=''" :data-cli-category="folder.id"><m3e-icon name="folder" /><span>{{ folder.title }}</span><m3e-icon name="chevron_right" /></button></div>
        <div class="cli-list"><article v-for="item in entries" :key="item.id" class="cli-row" :data-cli-entry="item.id"><div><strong>{{ item.title }}</strong><small>{{ item.kind }} · {{ categories.find(c=>c.id===item.category)?.title }}<template v-if="item.connection"> · {{ item.connection }}</template></small></div><div class="cli-actions">
          <m3e-button v-if="item.kind==='login'" variant="text" :disabled="busy" @click="run(()=>editPassword(item))">{{ cliTr('编辑密码') }}</m3e-button>
          <m3e-button v-if="item.connection" variant="text" :disabled="busy" @click="open('connection-rename',item)">{{ cliTr('重命名') }}</m3e-button><m3e-button v-if="item.connection" variant="text" :disabled="busy" @click="open('token',item)">{{ cliTr('替换 Token') }}</m3e-button>
          <m3e-button variant="text" :disabled="busy" @click="open('move',item)">{{ cliTr('移动') }}</m3e-button><m3e-button variant="text" :disabled="busy" @click="open('delete',item)">{{ cliTr('删除') }}</m3e-button></div></article></div>
        <p v-if="!entries.length && !childCategories.length">{{ cliTr('没有匹配的 CLI 内容。') }}</p>
        <p class="cli-hint">{{ cliTr('编辑密码只替换勾选的字段，其他字段完整保留。未知类型由 CLI 拒绝修改；已有秘密值可在 CLI 本人详情中查看。') }}</p>
      </template>
      <template v-else-if="tab==='gateway'">
        <h3>{{ cliTr('CLI 连接') }}</h3><div class="cli-list"><article v-for="connection in snapshot.connections" :key="connection.name" class="cli-row"><div><strong>{{ connection.name }}</strong><small>{{ connection.provider }} · {{ connection.api_base }}</small><small>{{ connection.note }}</small></div></article></div>
        <h3>{{ cliTr('AI 授权') }}</h3><m3e-button v-if="supports('grant_management')" type="button" variant="filled" :disabled="busy || currentPending.length>0 || !snapshot.connections.length" @click="open('grant-new')">{{ cliTr('创建 AI 授权') }}</m3e-button><div class="cli-list"><article v-for="item in snapshot.grants" :key="item.name" class="cli-row"><div><strong>{{ item.name }} · {{ item.connection }}</strong><small>{{ item.repositories.join(', ') }} · {{ item.operations.join(', ') }}</small><small>{{ item.refresh_required ? cliTr('需要重新授权') : `${cliTr('到期时间')} ${new Date(item.expires_at_unix*1000).toLocaleString()}` }} · {{ item.calls_used }} / {{ item.max_calls || '∞' }} · {{ item.approval }}</small></div><div class="cli-actions"><m3e-button v-if="supports('grant_management')" type="button" variant="text" :disabled="busy || currentPending.length>0" @click="open('grant-renew');form.name=item.name">{{ cliTr('续期 AI 授权') }}</m3e-button><m3e-button type="button" variant="text" :disabled="busy" @click="open('revoke');form.name=item.name">{{ cliTr('撤销 AI 授权') }}</m3e-button></div></article></div><p v-if="!snapshot.grants.length">{{ cliTr('没有 AI 授权。') }}</p>
      </template>
      <template v-else-if="tab==='keys'">
        <h3>{{ cliTr('SSH / GPG 密钥') }}</h3><div class="cli-actions"><m3e-button type="button" variant="filled" :disabled="busy || currentPending.length>0" @click="open('ssh-new')">{{ cliTr('生成 SSH 密钥') }}</m3e-button><m3e-button type="button" variant="tonal" :disabled="busy || currentPending.length>0" @click="open('key-import')">{{ cliTr('导入 SSH / GPG') }}</m3e-button></div>
        <div class="cli-list"><article v-for="item in keys" :key="item.entry_id" class="cli-row"><div><strong>{{ item.title }}</strong><small>{{ item.kind }} · {{ item.algorithm }}</small><small>{{ item.fingerprint }}</small></div></article></div><p>{{ cliTr('只显示密钥摘要和指纹。现有私钥、备注及密钥导出仍在 CLI 本人界面中管理。') }}</p>
      </template>
    </template>
    <section v-if="pending.length" class="cli-recovery" aria-labelledby="cli-recovery-heading" data-cli-recovery>
      <h3 id="cli-recovery-heading">{{ cliTr('保存结果需要核对') }}</h3><p>{{ cliTr('连接中断后不会自动重发保存。重新解锁相应数据库后查询回执，结果未知时请先检查数据库内容。') }}</p>
      <m3e-button v-if="unlocked" type="button" variant="tonal" :disabled="busy" @click="run(reconcile)">{{ cliTr('核对保存结果') }}</m3e-button>
      <article v-for="item in pending" :key="item.id"><small>{{ operationLabel(item.operation) }} · {{ new Date(item.created).toLocaleString() }}</small><p>{{ receipts[item.id]?.state==='unconfirmed' ? cliTr('操作已开始，但完成结果尚未确认。') : receipts[item.id]?.state==='not_recorded' ? cliTr('尚未找到回执；这不能证明写入没有发生。') : cliTr('等待重新解锁并核对。') }}</p><m3e-button v-if="unlocked && currentPending.some(p=>p.id===item.id) && receipts[item.id]" type="button" variant="text" :disabled="busy" @click="run(()=>acknowledge(item))">{{ cliTr('我已检查数据库内容') }}</m3e-button></article>
    </section>
    <dialog ref="dialog" class="cli-dialog" @cancel.prevent="closeDialog" @close="clearForm">
      <form class="cli-form" @submit.prevent="run(save)"><h2>{{ heading }}</h2>
        <template v-if="['delete','category-delete','revoke'].includes(action)"><p>{{ entry?.title || selectedCategory?.title || form.name }}</p><p class="cli-error">{{ action==='revoke' ? cliTr('撤销后 AI 客户端将无法继续使用此授权。') : cliTr('确认删除？删除会写入 CLI 数据库，并随后续同步传播。关联连接的 AI 授权也会撤销。') }}</p></template>
        <template v-else-if="['move','category-move'].includes(action)"><label for="cli-target">{{ cliTr('目标目录') }}</label><select id="cli-target" v-model="form.target" required><option value="" disabled>{{ cliTr('选择目录') }}</option><option v-for="folder in categories.filter(c=>c.id!==(entry?.id || category))" :key="folder.id" :value="folder.id">{{ folder.title }} · {{ folder.id.slice(0,8) }}</option></select></template>
        <template v-else>
          <template v-if="!['token','grant-new','grant-renew','sync'].includes(action)"><label for="cli-title">{{ cliTr('标题') }}</label><m3e-form-field variant="filled"><input id="cli-title" v-model="form.title" required maxlength="256" /></m3e-form-field></template>
          <template v-if="action==='connection-new'"><label for="cli-name">{{ cliTr('连接名称（英文标识）') }}</label><m3e-form-field variant="filled"><input id="cli-name" v-model="form.name" required pattern="[A-Za-z0-9_-]+" /></m3e-form-field><label for="cli-provider">{{ cliTr('服务') }}</label><select id="cli-provider" v-model="form.provider"><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></template>
          <SettingsPasswordField v-if="['connection-new','token'].includes(action)" v-model="form.token" label="Token" autocomplete="off" />
          <template v-if="action.startsWith('password-')">
            <p>{{ cliTr('原有字段不会读取到浏览器。编辑时勾选需要替换的字段，空值表示清空该字段。') }}</p>
            <label v-if="action==='password-edit'"><input v-model="form.replaceUsername" type="checkbox" />{{ cliTr('替换用户名') }}</label><template v-if="action==='password-new' || form.replaceUsername"><label for="cli-username">{{ cliTr('用户名') }}</label><m3e-form-field variant="filled"><input id="cli-username" v-model="form.username" autocomplete="off" /></m3e-form-field></template>
            <label v-if="action==='password-edit'"><input v-model="form.replaceWebsite" type="checkbox" />{{ cliTr('替换网址') }}</label><template v-if="action==='password-new' || form.replaceWebsite"><label for="cli-website">{{ cliTr('网址') }}</label><m3e-form-field variant="filled"><input id="cli-website" v-model="form.website" /></m3e-form-field></template>
            <label v-if="action==='password-edit'"><input v-model="form.replaceSecret" type="checkbox" />{{ cliTr('替换密码') }}</label><SettingsPasswordField v-if="action==='password-new' || form.replaceSecret" v-model="form.secret" :label="cliTr('密码')" autocomplete="new-password" />
            <label v-if="action==='password-edit'"><input v-model="form.replaceNotes" type="checkbox" />{{ cliTr('替换备注') }}</label><template v-if="action==='password-new' || form.replaceNotes"><label for="cli-notes">{{ cliTr('备注') }}</label><m3e-form-field variant="filled"><textarea id="cli-notes" v-model="form.notes" rows="3" /></m3e-form-field></template>
          </template>
          <template v-if="action==='ssh-new'"><label for="cli-key-algorithm">{{ cliTr('密钥算法') }}</label><select id="cli-key-algorithm" v-model="key.algorithm"><option value="ed25519">Ed25519</option><option value="rsa2048">RSA 2048</option><option value="rsa3072">RSA 3072</option><option value="rsa4096">RSA 4096</option></select></template>
          <template v-if="action==='key-import'"><label for="cli-key-format">{{ cliTr('密钥格式') }}</label><select id="cli-key-format" v-model="key.format"><option value="ssh">SSH PEM / OpenSSH</option><option value="openpgp">OpenPGP armor</option></select><label for="cli-key-text">{{ cliTr('导入密钥内容（最多 32 KiB）') }}</label><m3e-form-field variant="filled"><textarea id="cli-key-text" v-model="key.text" required rows="5" autocomplete="off" spellcheck="false" /></m3e-form-field></template>
          <template v-if="action==='grant-new'">
            <label for="cli-grant-name">{{ cliTr('授权名称') }}</label><m3e-form-field variant="filled"><input id="cli-grant-name" v-model="form.name" required pattern="[A-Za-z0-9_-]+" /></m3e-form-field>
            <label for="cli-grant-connection">{{ cliTr('连接') }}</label><select id="cli-grant-connection" v-model="grant.connection" required><option value="" disabled>{{ cliTr('选择连接') }}</option><option v-for="connection in snapshot?.connections.filter(c=>['github','gitlab'].includes(c.provider))" :key="connection.name" :value="connection.name">{{ connection.name }}</option></select>
            <label for="cli-grant-repositories">{{ cliTr('仓库范围（每行一个）') }}</label><m3e-form-field variant="filled"><textarea id="cli-grant-repositories" v-model="grant.repositories" required rows="3" /></m3e-form-field><p>{{ cliTr('Issue 操作需要精确仓库。通用 API 操作必须明确填写 *，代表整个服务。') }}</p>
            <label><input v-model="grant.readIssue" type="checkbox" />{{ cliTr('读取 Issue') }}</label><label><input v-model="grant.writeIssue" type="checkbox" />{{ cliTr('创建 Issue') }}</label><label><input v-model="grant.apiRead" type="checkbox" />{{ cliTr('通用 API 读取') }}</label><label><input v-model="grant.apiWrite" type="checkbox" />{{ cliTr('通用 API 写入') }}</label>
            <label for="cli-grant-ttl">{{ cliTr('有效期（分钟）') }}</label><input id="cli-grant-ttl" v-model.number="grant.ttl" type="number" min="1" max="1440" required />
            <label for="cli-grant-rpm">{{ cliTr('每分钟请求上限') }}</label><input id="cli-grant-rpm" v-model.number="grant.rpm" type="number" min="1" max="600" required />
            <label for="cli-grant-calls">{{ cliTr('总调用次数（0 为不限次数，仍会到期）') }}</label><input id="cli-grant-calls" v-model.number="grant.maxCalls" type="number" min="0" max="100000" required />
            <label for="cli-grant-approval">{{ cliTr('人工批准') }}</label><select id="cli-grant-approval" v-model="grant.approval"><option value="write">{{ cliTr('写操作') }}</option><option value="all">{{ cliTr('每次调用') }}</option><option value="off">{{ cliTr('不询问') }}</option></select>
          </template>
          <template v-if="action==='grant-renew'"><strong>{{ form.name }}</strong><p>{{ cliTr('续期保留原仓库、操作、期限、次数和人工批准设置，并立即使旧客户端凭据失效。需要重启 MCP 客户端。') }}</p></template>
          <template v-if="action==='sync'"><strong>{{ snapshot?.sync?.path }}</strong><p>{{ cliTr('仅同步 CLI 已配置的 WebDAV，保留 ETag 与冲突检查。同步后锁定，超时后先核对回执。') }}</p><SettingsPasswordField v-model="webdavPassword" :label="cliTr('WebDAV 密码（仅本次使用）')" autocomplete="off" /></template>
          <template v-if="needsAuth"><p>{{ cliTr('此操作需要重新认证 CLI 数据库。主密码及密钥文件不会保存到浏览器。') }}</p><SettingsPasswordField v-model="authPassword" :label="cliTr('重新输入 CLI 主密码')" autocomplete="off" /><small v-if="sessionKeyFile">{{ cliTr('使用本次解锁选择的密钥文件；更换文件请先锁定 CLI。') }}</small></template>
        </template>
        <p v-if="error" role="alert" class="cli-error">{{ error }}</p>
        <div class="cli-actions"><m3e-button type="button" variant="text" :disabled="busy" @click="closeDialog">{{ cliTr('取消') }}</m3e-button><m3e-button type="submit" variant="filled" :disabled="busy || currentPending.length>0 || (needsAuth && !authPassword)">{{ ['delete','category-delete','revoke'].includes(action) ? cliTr('确认') : cliTr('保存') }}</m3e-button></div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.cli-management,.cli-form { display:grid;gap:16px;min-width:0; }
.cli-recovery {border:1px solid var(--md-sys-color-outline);border-radius:20px;padding:16px;display:grid;gap:12px;overflow-wrap:anywhere;}.cli-recovery h3,.cli-recovery p{margin:0;}.cli-recovery article{padding-block:8px;}.cli-form input[type=number]{min-height:48px;padding:8px;box-sizing:border-box;max-width:100%;border:1px solid var(--md-sys-color-outline);border-radius:12px;background:var(--md-sys-color-surface);color:inherit;}
.cli-header,.cli-toolbar,.cli-tabs,.cli-actions {display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.cli-header,.cli-toolbar {justify-content:space-between;}
.cli-header p {margin:4px 0 0;}.cli-search {display:grid;gap:8px;}
.cli-list {display:grid;gap:3px;}.cli-row,.cli-folder {padding:16px;border-radius:4px;background:var(--md-sys-color-surface-container-high, var(--app-surface-high));min-width:0;}
.cli-list>:first-child {border-start-start-radius:20px;border-start-end-radius:20px;}.cli-list>:last-child {border-end-start-radius:20px;border-end-end-radius:20px;}
.cli-row {display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;}.cli-row>div:first-child {flex:1;min-width:140px;}.cli-row small {display:block;margin-top:4px;overflow-wrap:anywhere;color:var(--md-sys-color-on-surface-variant);}
.cli-folder {display:flex;align-items:center;gap:12px;text-align:start;border:0;color:inherit;font:inherit;cursor:pointer;}.cli-folder span {flex:1;}
.cli-error {color:var(--md-sys-color-error, #b3261e);}.cli-hint,details {font-size:.875rem;color:var(--md-sys-color-on-surface-variant, var(--app-muted));line-height:1.6;}
code {white-space:pre-wrap;overflow-wrap:anywhere;}.cli-dialog {background:var(--md-sys-color-surface-container-high, var(--app-surface-high));color:var(--md-sys-color-on-surface, var(--app-text));border:0;border-radius:28px;padding:24px;width:min(540px,calc(100vw - 48px));max-height:85vh;box-sizing:border-box;}.cli-dialog::backdrop {background:#0008;}
.cli-form label {font-size:.875rem;}.cli-form select {min-height:48px;border:1px solid var(--md-sys-color-outline, var(--app-outline));border-radius:12px;background:var(--md-sys-color-surface, var(--app-surface));color:inherit;padding:8px;max-width:100%;}
.cli-form input[type=checkbox] {accent-color:var(--md-sys-color-primary);margin-inline-end:8px;}m3e-button {max-width:100%;}
</style>
