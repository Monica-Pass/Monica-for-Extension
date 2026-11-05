<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import QRCode from 'qrcode';
import { parseNearbyHotspotInvitation } from '../nearby/hotspot-invitation';
import { nativeInstallerBrowser } from '../runtime/browser-platform';
import { nearbyErrorMessage, nearbyStageLabel } from '../nearby/manager-messages';
import { tr } from '../i18n';
import { materialOptionTag, materialSelectTag } from '../lib/material-controls';
import { NearbyManagerClient, NearbyManagerClientError, type NearbyManagerCommand } from '../nearby/manager-client';
import type { NearbyCoordinatorView, NearbyDiscoveryView, NearbyDiscoveredPeer, NearbyEndpoint } from '../nearby/local-coordinator';
import type { NearbyPreferencesView, NearbySyncMode } from '../nearby/preferences';
import type { NearbyManagerChange } from '../nearby/manager-contract';
import type { NearbyNativeRecoveryView } from '../nearby/native-journal';
import type { NearbyRecoveryReviewView } from '../nearby/native-recovery-review';
import NearbyDeletionReviewDialog from './NearbyDeletionReviewDialog.vue';
import NearbySyncResultDialog from './NearbySyncResultDialog.vue';
import type { NearbySyncResult } from '../nearby/local-coordinator';

const preferences = ref<NearbyPreferencesView>(), view = ref<NearbyCoordinatorView>({ phase: 'idle' });
const busy = ref(false), connected = ref(false), searching = ref(false), discovered = ref<NearbyDiscoveredPeer[]>([]);
const sources = ref<{id:string;name:string;kind:string}[]>([]), qr = ref('');
const recovery = ref<NearbyNativeRecoveryView | null>(null), recovered = ref(false);
const recoveryReview = ref<NearbyRecoveryReviewView | null>(null);
const syncResult = ref<{result:NearbySyncResult;peerName?:string} | null>(null);
const error = ref(''), invitation = ref(''), name = ref(''), copied = ref(false), forgetId = ref('');
const hotspot = computed(() => parseNearbyHotspotInvitation(invitation.value));
let hotspotExpires = 0;
watch(invitation, value => { hotspotExpires = parseNearbyHotspotInvitation(value) ? Date.now() + 180_000 : 0; });
const setupOpen = ref(false), helperAvailable = ref(false), setupCopied = ref(false);
const invitationInput = ref<HTMLTextAreaElement>();
const extensionId = chrome.runtime.id;
const helperDownload = chrome.runtime.getURL('nearby-helper/monica-wifi-windows-x64.zip');
const setupCommand = `powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-wifi.ps1 -${nativeInstallerBrowser()}ExtensionId ${extensionId}`;
async function showSetup() {
  setupOpen.value = !setupOpen.value;
  if (setupOpen.value) {
    try { helperAvailable.value = (await (await fetch(chrome.runtime.getURL('nearby-helper/availability.json'))).json()).windowsX64 === true; }
    catch { helperAvailable.value = false; }
  }
}
async function copySetup() { try { await navigator.clipboard.writeText(setupCommand); setupCopied.value = true; } catch { setupCopied.value = false; } }
async function enterInvitation() {
  const text = invitation.value;
  cancel(); await connect(); invitation.value = text;
  invitationInput.value?.focus();
}
let client: NearbyManagerClient | undefined, disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
let nextAutomatic = 0, automaticCursor = 0, searchStarted = 0, waitingStarted = 0, pendingEndpoint: NearbyEndpoint | undefined;
const active = computed(() => ['pairing', 'preparing', 'review', 'ready', 'transferring', 'saving', 'confirming'].includes(view.value.phase));
const editable = computed(() => connected.value && !busy.value && !active.value && !searching.value);
const phaseText = computed(() => view.value.phase === 'transferring' && view.value.transport ? nearbyStageLabel(view.value.transport.stage) : tr(view.value.deletionReview && !view.value.review ? '请确认历史删除的处理方式' : view.value.phase==='completed' && view.value.kind==='pairing' ? '配对成功，尚未同步数据' : ({ idle: '准备同步', pairing: '等待配对设备', preparing: '正在准备同步', review: '请检查 Passkey 兼容性', ready: '准备完成', transferring: '正在连接或传输', saving: '正在安全保存', confirming:'等待对方确认保存', completed: '同步完成', failed: '同步未完成', cancelled: '同步已取消' })[view.value.phase]));
function errorText(code: string): string {
  const messages: Record<string, string> = {
    'host-update-required': '请更新 Monica 本机通信组件后重试。',
    'native-host-not-installed': 'Wi-Fi 同步需要 Monica 本机通信组件。MDBX 数据库本身已内置于插件。',
    'native-host-forbidden': '浏览器阻止了 Monica 本机通信组件，请检查安装配置。',
    'source-paired': '切换同步密码库前，请先移除现有配对设备。', 'recovery-required': '请先恢复当前数据库未完成的接收，再切换密码库。',
    'source-changed': '同步期间密码库发生了修改，请重新同步。', 'native-source-changed': '同步期间密码库发生了修改，请重新同步。',
    'native-sequence-conflict': '接收期间密码库有新的修改，已停止继续写入。未完成的接收仍被保留，不能直接覆盖本机修改。',
    'native-recovery-changed': '待恢复的接收已发生变化，请检查最新状态后重试。',
    'native-recovery-overlap': '无法确认本机修改与接收内容互不影响，已保留冲突和接收内容。',
    'content-write-outcome-unknown': '上次保存的结果尚未确认。可以检查并继续接收，插件会核对原来的保存操作。',
    'stale-session': '设置已更新，请重新连接同步页面。', 'manager-busy': '另一窗口正在使用 Wi-Fi 同步，请先关闭该窗口的同步页面。',
    'manager-context-invalid': 'Wi-Fi 同步需要在 Monica 的完整管理页或侧栏中打开。',
    'vault-locked': '密码库已锁定，请解锁后重新进入同步页面。', 'session-expired': '密码库已锁定，请解锁后重新进入同步页面。',
    'session-changed': '密码库已锁定，请解锁后重新进入同步页面。', 'session-closed': '同步会话已结束，请重新连接。',
    'invalid-invitation': '配对邀请无效，请粘贴另一端显示的完整邀请。', 'local-network-only': '配对邀请无效，请粘贴另一端显示的完整邀请。',
    'invalid-endpoint': '配对邀请无效，请粘贴另一端显示的完整邀请。', 'peer-limit': '最多保存 8 台设备，请先移除不再使用的设备。',
    'transfer-failed': '连接未完成，请确认两端在同一网络并同时打开同步页面。',
    'peer-save-rejected': '另一端未能保存，本次同步未完成。请查看 Android 的错误提示后重试。',
    'peer-save-timeout': '等待另一端保存确认超时，本次同步未完成。',
    'native-projection-incomplete': '此数据库包含暂时无法完整同步的内容，已停止发送以保护原始数据。',
    'operation-failed': '同步未完成，请检查本机通信组件和另一端状态后重试。',
    'cancelled': '同步已取消。', 'connection-closed': '同步连接已关闭，请重新连接。',
    'operation-timeout': '同步等待超时，请重新连接。', 'connection-timeout': '同步连接超时，请重新连接。'
  };
  if (messages[code]) return tr(messages[code]);
  const detail = nearbyErrorMessage(code);
  return [detail.message, detail.hint].filter(Boolean).join(' ');
}
function report(e: unknown) { if (!disposed) { recoveryReview.value = null; syncResult.value=null; error.value = errorText(e instanceof NearbyManagerClientError ? e.code : 'operation-failed'); view.value = {phase:'failed'}; searching.value=false; } }
async function request<T>(command: NearbyManagerCommand): Promise<T> {
  if (!client) throw new NearbyManagerClientError('connection-closed');
  const current = client, result = await current.request<T>(command);
  if (disposed || current !== client) throw new NearbyManagerClientError('session-closed');
  return result;
}
async function run(work: () => Promise<void>) {
  if (busy.value || disposed) return;
  const operationGeneration = generation;
  busy.value = true; error.value = ''; copied.value = false; recovered.value = false;
  try { await work(); } catch (e) {
    if (!disposed && operationGeneration === generation) {
      report(e);
      if (connected.value) try { await loadRecovery(); } catch { /* Preserve the original operation failure. */ }
    }
  }
  finally { if (operationGeneration === generation) busy.value = false; }
}
function deferAutomatic() { nextAutomatic = Date.now() + Math.max(60, preferences.value?.intervalSeconds || 300) * 1000; }
async function loadPreferences() {
  preferences.value = await request<NearbyPreferencesView>({ type: 'preferences' }); name.value = preferences.value.name;
}
async function loadRecovery() { recoveryReview.value = null; recovery.value = await request<NearbyNativeRecoveryView | null>({ type: 'recovery-status' }); }
async function reviewReceive() {
  const pending = recovery.value; if (!pending || !editable.value) return;
  await run(async () => { recoveryReview.value = await request<NearbyRecoveryReviewView>({ type: 'recovery-review', operationId: pending.operationId }); deferAutomatic(); });
}
async function confirmReceive() {
  const review = recoveryReview.value; if (!review || !editable.value) return;
  recoveryReview.value = null;
  await run(async () => {
    await request({ type: 'recovery-confirm', reviewId: review.reviewId });
    await loadRecovery(); view.value = { phase: 'idle' }; recovered.value = true; deferAutomatic();
  });
}
async function resumeReceive() {
  const pending = recovery.value; if (!pending || !editable.value) return;
  await run(async () => {
    await request({ type: 'recover', operationId: pending.operationId });
    await loadRecovery(); view.value = { phase: 'idle' }; recovered.value = true; deferAutomatic();
  });
}
async function connect() {
  if (busy.value || disposed) return;
  generation++;
  await run(async () => {
    client?.close();
    const current = new NearbyManagerClient(reason => { queueMicrotask(() => {
      if (disposed || client !== current) return;
      connected.value = false; searching.value = false; invitation.value = ''; copied.value = false; recovery.value = null; recoveryReview.value = null; syncResult.value=null;
      view.value = { phase: 'cancelled' }; if (reason !== 'cancelled') error.value = errorText(reason);
    }); });
    client = current; await current.ready;
    if (disposed || client !== current) { current.close(); return; }
    connected.value = true; await loadPreferences(); sources.value = await request({type:'sources'}); await loadRecovery(); view.value = { phase: 'idle' }; deferAutomatic();
  });
}
async function change(change: NearbyManagerChange) {
  if (!preferences.value || !editable.value) return;
  await run(async () => {
    preferences.value = await request<NearbyPreferencesView>({ type: 'update', epoch: preferences.value!.epoch, change });
    name.value = preferences.value.name; view.value = { phase: 'idle' }; discovered.value = []; forgetId.value = ''; await loadRecovery(); deferAutomatic();
  });
}
function value(event: Event) { return (event.target as HTMLInputElement).value; }
async function pair(join: boolean) {
  if (!editable.value) return;
  await run(async () => { view.value = await request({ type: 'pair', ...(join ? { invitation: invitation.value.trim() } : {}) }); invitation.value = ''; waitingStarted = Date.now(); });
}
async function discover() {
  if (!editable.value) return;
  await run(async () => { const result = await request<NearbyDiscoveryView>({ type: 'discover' }); searching.value = result.searching; discovered.value = []; searchStarted = Date.now(); });
}
async function startPrepared() {
  view.value = { ...view.value, phase: 'transferring', transport: { stage: 'waiting', transferred: 0, total: 0 } }; waitingStarted = Date.now();
  view.value = await request({ type: 'start', ...(pendingEndpoint ? { endpoint: pendingEndpoint } : {}) }); waitingStarted = Date.now();
}
async function synchronize(peerId: string, address?: NearbyEndpoint) {
  pendingEndpoint = address;
  view.value = await request({ type: 'prepare', peerId });
  if (view.value.phase === 'ready') await startPrepared();
}
async function sync(peerId: string) {
  if (!editable.value) return;
  await run(() => synchronize(peerId, discovered.value.find(row => row.deviceId === peerId)?.endpoint)); deferAutomatic();
}
async function confirm() {
  const review = view.value.review; if (!review) return;
  await run(async () => { view.value = await request({ type: 'confirm', reviewId: review.id }); if (view.value.phase === 'ready') await startPrepared(); });
}
async function confirmDeletions(choice: 'omit' | 'include') {
  const review = view.value.deletionReview; if (!review) return;
  await run(async () => {
    view.value = await request({ type: 'confirm-deletions', reviewId: review.id, choice });
    if (view.value.phase === 'ready') await startPrepared();
  });
}
function cancel() {
  generation++;
  client?.close(); client = undefined; connected.value = false; searching.value = false; busy.value = false;
  view.value = { phase: 'cancelled' }; discovered.value = []; invitation.value = ''; pendingEndpoint = undefined; error.value = ''; deferAutomatic();
  recovery.value = null; recovered.value = false; recoveryReview.value = null; syncResult.value=null;
}
async function copyInvitation() {
  const text = view.value.pairing?.invitations[0]; if (!text) return;
  try { await navigator.clipboard.writeText(text); copied.value = true; } catch { error.value = tr('复制失败，请选择邀请文本手动复制。'); }
}
async function tick() {
  if (disposed) return;
  try {
    if (hotspotExpires && Date.now() >= hotspotExpires) {
      invitation.value = ''; hotspotExpires = 0; error.value = tr('热点邀请已过期，请重新获取。');
    }
    if (connected.value && !busy.value) {
      if (searching.value) await run(async () => {
        if (Date.now() - searchStarted > 15_000) { cancel(); error.value = tr('查找设备超时，请重新连接。'); return; }
        const result = await request<NearbyDiscoveryView>({ type: 'discovery-progress' }); searching.value = result.searching; discovered.value = result.devices;
      });
      else if (['pairing', 'transferring', 'saving', 'confirming'].includes(view.value.phase)) await run(async () => {
        const state = await request<NearbyCoordinatorView>({ type: 'progress' }); view.value = state; if (state.error) error.value = errorText(state.error);
        if (state.phase === 'completed') { await loadPreferences(); await loadRecovery(); deferAutomatic(); if(state.kind==='sync' && state.result) syncResult.value={result:state.result,peerName:state.peerName}; }
        else if (Date.now() - waitingStarted > 180_000) { cancel(); error.value = tr('同步等待超时，请重新连接。'); }
      });
      else if (!active.value && !recovery.value && preferences.value?.enabled && preferences.value.intervalSeconds > 0 && preferences.value.peers.length && Date.now() >= nextAutomatic) {
        deferAutomatic();
        // No automatic consent: a Passkey review remains visible until approved.
        const peers = preferences.value.peers, peer = peers[automaticCursor++ % peers.length];
        await run(() => synchronize(peer.deviceId, discovered.value.find(row => row.deviceId === peer.deviceId)?.endpoint));
      }
    }
  } finally { if (!disposed) timer = setTimeout(tick, active.value || searching.value ? 500 : 5_000); }
}
function networkWake() { if (!disposed && !busy.value) { clearTimeout(timer); timer = setTimeout(tick, 0); } }
function visibilityChanged() { if (document.hidden) cancel(); else networkWake(); }
watch(() => view.value.pairing?.invitations[0], async text => { qr.value=''; if (!text) return; try { const result=await QRCode.toDataURL(text,{width:240,margin:2,errorCorrectionLevel:'M'}); if (!disposed && view.value.pairing?.invitations[0]===text) qr.value=result; } catch { if (!disposed && view.value.pairing?.invitations[0]===text) error.value=tr('二维码生成失败，请复制下方配对邀请。'); } });
onMounted(() => { void connect(); timer = setTimeout(tick, 500); window.addEventListener('online', networkWake); document.addEventListener('visibilitychange', visibilityChanged); });
onUnmounted(() => { disposed = true; clearTimeout(timer); window.removeEventListener('online', networkWake); document.removeEventListener('visibilitychange', visibilityChanged); client?.close(); client = undefined; invitation.value = ''; view.value = { phase: 'idle' }; });
</script>

<template>
  <section class="nearby-settings" :aria-label="tr('Wi-Fi 同步')" data-nearby-settings>
    <p class="supporting">{{ tr('附近设备自动同步需要保持本页打开并连接本机通信组件。离开页面、锁库或断开组件后暂停；再次打开后恢复检查。') }}</p>
    <p class="supporting">{{ tr('通过同一 Wi-Fi 或局域网加密同步选定密码库。云端密码源仍使用各自的同步设置。') }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <m3e-button variant="text" @click="showSetup">{{ tr('配置本机通信组件') }}</m3e-button>
    <section v-if="setupOpen" class="nearby-section nearby-setup" data-nearby-setup>
      <p>{{ tr('Windows 首次使用需配置一次通信组件，二维码和配对链接会自动包含连接信息，无需填写 IP 地址。') }}</p>
      <a v-if="helperAvailable" :href="helperDownload" download="monica-wifi-windows-x64.zip">{{ tr('下载 Windows 通信组件') }}</a>
      <p v-else>{{ tr('此构建未附带 Windows 通信组件，请使用包含通信组件的 Windows 构建。') }}</p>
      <p>{{ tr('解压组件，在解压后的文件夹打开终端，运行以下命令；完成后返回此页重新配对。') }}</p>
      <code>{{ setupCommand }}</code><small>{{ tr('当前插件 ID') }}: {{ extensionId }}</small>
      <m3e-button @click="copySetup">{{ setupCopied ? tr('已复制') : tr('复制配置命令') }}</m3e-button>
    </section>
    <m3e-button v-if="!connected" variant="filled" :disabled="busy" @click="connect">{{ tr('重新连接') }}</m3e-button>
    <p v-if="recovered" role="status">{{ tr('接收保存已恢复。再次同步即可向另一端确认并交换后续修改。') }}</p>
    <section v-if="recovery" class="nearby-section" aria-labelledby="nearby-recovery" data-nearby-recovery>
      <h2 id="nearby-recovery">{{ tr('未完成的接收') }}</h2>
      <div class="nearby-rows">
        <p class="nearby-row">{{ tr('已保存 {0} 步，剩余 {1} 步',{0:recovery.completedSteps,1:recovery.remainingSteps}) }}</p>
        <p v-if="recovery.conflict" class="nearby-row">{{ tr('密码库有新的修改，继续接收需要先处理冲突。本机数据和待接收内容都没有被丢弃。') }}</p>
        <p v-if="recovery.conflict" class="nearby-row supporting">{{ tr('若检查后仍无法继续，请暂停两端编辑，先在两端分别导出独立加密备份，再到密码源处理冲突。保留原设备和当前浏览器配置，不要反复清库或覆盖恢复。') }}</p>
        <p class="nearby-row supporting">{{ tr(recovery.completeInputsRetained ? '本次接收的保存内容和附件副本仍加密保留，直到全部保存完成。' : '这是旧版创建的接收日志，仅保留剩余步骤；已完成部分以当前数据库和原设备为准。') }}</p>
      </div>
      <template v-if="recoveryReview">
        <p role="status">{{ tr('已核实 {0} 次修改，涉及 {1} 个条目，与剩余 {2} 步接收互不覆盖。',{0:recoveryReview.interveningCommits,1:recoveryReview.editedEntries,2:recoveryReview.remainingSteps}) }}</p>
        <p class="supporting">{{ tr('继续会保留本机条目修改，并保存剩余附件和文件夹信息。确认前会再次检查密码库是否变化。') }}</p>
      </template>
      <p v-else class="supporting">{{ tr('无需另一台设备在线。只检查并重试原来的保存操作；冲突仍存在时不会覆盖本机修改。') }}</p>
      <div class="nearby-actions">
        <m3e-button v-if="recoveryReview" variant="filled" :disabled="!editable" @click="confirmReceive">{{ tr('保留本机修改并继续') }}</m3e-button>
        <m3e-button v-else-if="recovery.conflict" variant="tonal" :disabled="!editable" @click="reviewReceive">{{ tr('检查能否继续接收') }}</m3e-button>
        <m3e-button v-else variant="tonal" :disabled="!editable" @click="resumeReceive">{{ tr('检查并继续接收') }}</m3e-button>
        <m3e-button :disabled="busy" @click="cancel">{{ tr('稍后处理') }}</m3e-button>
      </div>
    </section>
    <template v-if="preferences">
      <div class="nearby-rows">
        <m3e-form-field v-field-label variant="filled" hide-subscript="always" class="nearby-row"><label slot="label">{{ tr('同步密码库') }}</label><component :is="materialSelectTag" :disabled="!editable || preferences.peers.length>0" :aria-label="tr('同步密码库')" @change="change({kind:'source',providerId:value($event)})"><component v-for="source in sources" :key="source.id" :is="materialOptionTag" :value="source.id" :selected.prop="preferences.localProviderId===source.id">{{ source.name }} · {{ source.kind==='mdbx2' ? 'MDBX' : tr('本机') }}</component></component></m3e-form-field>
        <p v-if="preferences.peers.length" class="nearby-row supporting">{{ tr('切换同步密码库前，请先移除现有配对设备。') }}</p>
        <label class="nearby-row name-row"><span>{{ tr('设备名称') }}</span><input v-model="name" maxlength="64" autocomplete="off" :disabled="!editable" :aria-label="tr('设备名称')" /><m3e-button :disabled="!editable || name === preferences.name || !name.trim()" @click="change({kind:'preferences',name:name.trim()})">{{ tr('保存') }}</m3e-button></label>
        <m3e-form-field v-field-label variant="filled" hide-subscript="always" class="nearby-row">
          <label slot="label">{{ tr('同步方向') }}</label><component :is="materialSelectTag" :disabled="!editable" :aria-label="tr('同步方向')" @change="change({kind:'preferences',mode:value($event) as NearbySyncMode})">
            <component v-for="mode in ([['bidirectional','双向同步'],['send_only','仅发送'],['receive_only','仅接收']] as const)" :key="mode[0]" :is="materialOptionTag" :value="mode[0]" :selected.prop="preferences.mode === mode[0]">{{ tr(mode[1]) }}</component>
          </component>
        </m3e-form-field>
        <div class="nearby-row toggle-row"><div><strong id="nearby-incremental-label">{{ tr('只同步新增和修改') }}</strong><small>{{ tr('开启后，本机的删除和清空回收站只保留在本机，不会发送到另一端；另一端删除的内容仍会正常应用。') }}</small></div><m3e-switch :checked.prop="preferences.incrementalOnly" :disabled="!editable" aria-labelledby="nearby-incremental-label" @beforeinput.prevent="change({kind:'preferences',incrementalOnly:!preferences.incrementalOnly})" /></div>
        <div class="nearby-row toggle-row"><div><strong id="nearby-auto-label">{{ tr('页面打开时自动同步') }}</strong><small>{{ tr('锁定密码库或离开此页面后停止。') }}</small></div><m3e-switch :checked.prop="preferences.enabled" :disabled="!editable" aria-labelledby="nearby-auto-label" @beforeinput.prevent="change({kind:'preferences',enabled:!preferences.enabled,intervalSeconds:preferences.intervalSeconds || 300})" /></div>
        <m3e-form-field v-if="preferences.enabled" v-field-label variant="filled" hide-subscript="always" class="nearby-row"><label slot="label">{{ tr('同步间隔') }}</label><component :is="materialSelectTag" :disabled="!editable" :aria-label="tr('同步间隔')" @change="change({kind:'preferences',intervalSeconds:Number(value($event))})"><component v-for="seconds in [0,60,300,900,3600]" :key="seconds" :is="materialOptionTag" :value="String(seconds)" :selected.prop="preferences.intervalSeconds === seconds">{{ seconds ? tr('{0} 分钟',{0:seconds/60}) : tr('手动') }}</component><component v-if="![0,60,300,900,3600].includes(preferences.intervalSeconds)" :is="materialOptionTag" :value="String(preferences.intervalSeconds)" :selected.prop="true">{{ tr('{0} 秒',{0:preferences.intervalSeconds}) }}</component></component></m3e-form-field>
      </div>
      <section class="nearby-section" aria-labelledby="nearby-peers"><h2 id="nearby-peers">{{ tr('已配对设备') }}</h2>
        <p v-if="!preferences.peers.length" class="supporting">{{ tr('先在两端完成一次配对，再同步密码库。') }}</p>
        <div class="nearby-rows"><div v-for="peer in preferences.peers" :key="peer.deviceId" class="nearby-row peer-row"><m3e-icon name="devices" /><div><strong>{{ peer.name || tr('Monica 设备') }}</strong><small>{{ discovered.some(row=>row.deviceId===peer.deviceId) ? tr('附近可连接') : tr('等待另一端开启同步') }} · {{ peer.lastSyncedAt ? new Date(peer.lastSyncedAt).toLocaleString() : tr('尚未同步') }}</small></div><m3e-button variant="tonal" :disabled="!editable" :data-nearby-sync="peer.deviceId" @click="sync(peer.deviceId)">{{ tr('同步') }}</m3e-button><m3e-icon-button :disabled="!editable" :aria-label="tr('移除设备 {0}',{0:peer.name})" @click="forgetId = peer.deviceId"><m3e-icon name="link_off" /></m3e-icon-button><div v-if="forgetId===peer.deviceId" class="forget"><span>{{ tr('移除后需要重新配对，密码库内容保持原样。') }}</span><m3e-button :disabled="!editable" @click="change({kind:'forget',deviceId:peer.deviceId})">{{ tr('确认移除') }}</m3e-button><m3e-button @click="forgetId=''">{{ tr('取消') }}</m3e-button></div></div></div>
        <div class="nearby-actions"><m3e-button variant="tonal" :disabled="!editable || !preferences.peers.length" @click="discover">{{ searching ? tr('正在查找…') : tr('查找附近设备') }}</m3e-button><small v-if="discovered.length">{{ tr('找到 {0} 台已配对设备',{0:discovered.length}) }}</small></div>
      </section>
      <section class="nearby-section" aria-labelledby="nearby-pair"><h2 id="nearby-pair">{{ tr('配对新设备') }}</h2><p class="supporting">{{ tr('在 Android 的附近设备同步页面显示配对邀请，复制完整邀请到此处；也可让 Android 扫描本机邀请。配对过程仅建立信任，随后点击同步才传输内容。') }}</p><label>{{ tr('配对邀请') }}<textarea ref="invitationInput" v-model="invitation" :disabled="!connected || busy || !!recovery" rows="2" maxlength="1100" autocomplete="off" spellcheck="false" :aria-label="tr('配对邀请')" /></label><div v-if="hotspot" class="nearby-section" data-nearby-hotspot><p>{{ tr('请先在系统 Wi-Fi 设置中连接以下热点，再点击连接设备。浏览器无法自动加入热点；邀请会在取消、锁定、离开页面或超时后清除。') }}</p><p>{{ tr('热点名称') }}：{{ hotspot.ssid }}</p><p>{{ tr('热点密码') }}：{{ hotspot.passphrase }}</p></div><div class="nearby-actions"><m3e-button variant="filled" :disabled="!editable || !invitation.trim()" @click="pair(true)">{{ tr('连接设备') }}</m3e-button><m3e-button variant="tonal" :disabled="!editable || preferences.peers.length>=8" @click="pair(false)">{{ tr('显示本机邀请') }}</m3e-button><m3e-button v-if="view.phase==='pairing'" :disabled="busy" @click="enterInvitation">{{ tr('改为输入配对链接') }}</m3e-button></div></section>
    </template>
    <section class="nearby-section nearby-progress" aria-labelledby="nearby-status"><h2 id="nearby-status">{{ tr('同步状态') }}</h2><p role="status" aria-live="polite" data-nearby-phase>{{ phaseText }}<span v-if="view.peerName"> · {{ view.peerName }}</span><span v-if="view.applied"> · {{ tr('已保存 {0} 条记录',{0:view.applied}) }}</span></p>
      <template v-if="view.pairing?.invitations.length"><img v-if="qr" :src="qr" width="240" height="240" :alt="tr('本次配对邀请二维码')" /><label>{{ tr('本次配对邀请') }}<textarea readonly :value="view.pairing.invitations[0]" rows="3" :aria-label="tr('本次配对邀请')" spellcheck="false" /></label><m3e-button @click="copyInvitation">{{ copied ? tr('已复制') : tr('复制邀请') }}</m3e-button><small>{{ tr('邀请仅供可信设备使用。取消或离开页面后失效。') }}</small></template>
      <p v-if="view.phase==='transferring' && (!view.transport || ['waiting','connecting','authenticating'].includes(view.transport.stage))" class="supporting">{{ tr('两端各点一次同步即可，可先后操作；最多等待两分钟，请保持两端解锁。') }}</p>
      <p v-if="view.recoveryOnly" class="supporting">{{ tr('正在恢复上次未完成的接收，完成后再次同步即可发送本机修改。') }}</p>
      <template v-if="view.review"><p>{{ tr('以下 Passkey 存在跨设备限制。原始密钥、凭据 ID 和计数历史会保留。') }}</p><ul><li v-for="issue in view.review.issues" :key="issue.id"><strong>{{ issue.account }}</strong> · {{ issue.relyingParty }}<p>{{ tr(issue.skipForCounter ? '已有正计数历史，本次跳过发送，保留本机凭据。' : issue.restriction==='device-only' ? '仅本机可用，另一端只能收到凭据引用。' : issue.restriction==='backup-restricted' ? '此凭据限制备份，另一端的可用性取决于网站策略。' : '另一端可能不支持此密钥算法。') }}</p></li></ul><m3e-button variant="filled" :disabled="busy" @click="confirm">{{ tr('了解限制并继续同步') }}</m3e-button></template>
      <m3e-button v-if="active || searching || busy" variant="tonal" @click="cancel">{{ tr('取消同步') }}</m3e-button>
    </section>
    <NearbySyncResultDialog v-if="syncResult" :result="syncResult.result" :peer-name="syncResult.peerName" :mode="preferences?.mode" :incremental-only="preferences?.incrementalOnly" @close="syncResult=null" />
    <NearbyDeletionReviewDialog v-if="view.deletionReview && !view.review" :count="view.deletionReview.count" :incoming="view.deletionReview.incoming" :peer-name="view.peerName" :busy="busy" @choose="confirmDeletions" @cancel="cancel" />
  </section>
</template>

<style scoped>
.nearby-settings { display:grid;gap:16px;min-width:0; }
.nearby-settings p { margin:0;line-height:1.5; }.supporting,small { color:var(--md-sys-color-on-surface-variant);font-size:.875rem;line-height:1.5; }
.nearby-section { display:grid;gap:12px;min-width:0; }.nearby-section h2 { margin:0;font-size:1rem;font-weight:600; }
.nearby-settings>m3e-button,.nearby-setup>m3e-button {justify-self:start;}.nearby-setup{padding:14px;border-radius:20px;background:var(--md-sys-color-surface-container);}.nearby-setup code{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8rem;}.nearby-setup a{color:var(--md-sys-color-primary);}
.nearby-rows { display:grid;gap:4px; }.nearby-row { margin:0;padding:10px 14px;background:var(--md-sys-color-surface-container);border-radius:4px;min-width:0; }
.nearby-row:first-child {border-top-left-radius:24px;border-top-right-radius:24px;}.nearby-row:last-child{border-bottom-left-radius:24px;border-bottom-right-radius:24px;}
.toggle-row,.name-row{display:flex;align-items:center;gap:12px;}.toggle-row>div{flex:1;}.toggle-row small,.peer-row small{display:block;}.name-row input{min-width:0;flex:1;width:80px;}
.peer-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto auto;gap:10px;align-items:center;}.peer-row strong{overflow-wrap:anywhere;}.forget{grid-column:1/-1;}
.nearby-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}.nearby-settings label{display:grid;gap:6px;font-size:.875rem;}.nearby-settings label.name-row{display:flex;}
.nearby-settings :is(input,textarea){box-sizing:border-box;max-width:100%;font:inherit;color:var(--md-sys-color-on-surface);background:var(--md-sys-color-surface-container-high);border:0;border-radius:12px;padding:10px 12px;outline:none;}.nearby-settings textarea{width:100%;resize:vertical;overflow-wrap:anywhere;}.nearby-settings :is(input,textarea):focus-visible{outline:2px solid var(--md-sys-color-primary);outline-offset:1px;}
.nearby-settings m3e-form-field{--m3e-form-field-container-color:transparent;}.nearby-settings summary{cursor:pointer;font-size:.875rem;line-height:2;}.nearby-settings details[open]{display:grid;gap:8px;}.nearby-progress{padding-top:8px;}.nearby-progress>m3e-button{justify-self:start;}.nearby-progress li{margin-bottom:10px;}.nearby-settings :disabled{opacity:.6;}
@media(max-width:520px){.peer-row{grid-template-columns:minmax(0,1fr) auto auto;}.peer-row>m3e-icon{display:none;}.name-row{flex-wrap:wrap;}.name-row>span{width:100%;}}
</style>
