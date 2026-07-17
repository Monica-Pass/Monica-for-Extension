<script setup lang="ts">
import { ref } from "vue";
import type { TotpItem } from "../core/model";
import type { SteamConfirmation, SteamPendingLogin } from "../runtime/messages";
import { vaultClient } from "../runtime/client";

const props = defineProps<{ item: TotpItem }>();
const confirmations = ref<SteamConfirmation[]>([]);
const pendingLogins = ref<SteamPendingLogin[]>([]);
const busy = ref<"confirmations" | "logins" | "action" | "">("");
const error = ref("");

async function loadConfirmations() {
  busy.value = "confirmations";
  error.value = "";
  try { confirmations.value = await vaultClient.listSteamConfirmations(props.item.id); } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法读取 Steam 交易确认。"; }
  finally { busy.value = ""; }
}

async function loadLogins() {
  busy.value = "logins";
  error.value = "";
  try { pendingLogins.value = await vaultClient.listSteamPendingLogins(props.item.id); } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法读取 Steam 登录请求。"; }
  finally { busy.value = ""; }
}

async function respondConfirmation(confirmation: SteamConfirmation, accept: boolean) {
  busy.value = "action";
  error.value = "";
  try { if (await vaultClient.respondSteamConfirmation(props.item.id, confirmation, accept)) confirmations.value = confirmations.value.filter((entry) => entry.id !== confirmation.id); else error.value = "Steam 没有接受该交易操作。"; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Steam 交易操作失败。"; }
  finally { busy.value = ""; }
}

async function respondLogin(login: SteamPendingLogin, approve: boolean) {
  busy.value = "action";
  error.value = "";
  try { if (await vaultClient.respondSteamLogin(props.item.id, { clientId: login.clientId, version: login.version }, approve)) pendingLogins.value = pendingLogins.value.filter((entry) => entry.clientId !== login.clientId); else error.value = "Steam 没有接受该登录操作。"; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "Steam 登录操作失败。"; }
  finally { busy.value = ""; }
}
</script>

<template>
  <div class="steam-network-actions">
    <div class="steam-action-buttons">
      <button type="button" :disabled="Boolean(busy)" @click="loadConfirmations">{{ busy === 'confirmations' ? '读取中…' : `交易确认${confirmations.length ? `（${confirmations.length}）` : ''}` }}</button>
      <button type="button" :disabled="Boolean(busy)" @click="loadLogins">{{ busy === 'logins' ? '读取中…' : `登录请求${pendingLogins.length ? `（${pendingLogins.length}）` : ''}` }}</button>
    </div>
    <ul v-if="confirmations.length" class="steam-request-list"><li v-for="confirmation in confirmations" :key="confirmation.id"><span><strong>{{ confirmation.headline || 'Steam 交易' }}</strong><small>{{ confirmation.summary || '待确认操作' }}</small></span><span class="steam-request-actions"><button type="button" :disabled="busy === 'action'" @click="respondConfirmation(confirmation, true)">允许</button><button type="button" :disabled="busy === 'action'" @click="respondConfirmation(confirmation, false)">取消</button></span></li></ul>
    <ul v-if="pendingLogins.length" class="steam-request-list"><li v-for="login in pendingLogins" :key="login.clientId"><span><strong>{{ login.deviceName || 'Steam 登录设备' }}</strong><small>{{ [login.ip, login.city, login.country].filter(Boolean).join(' · ') || '待批准登录' }}</small></span><span class="steam-request-actions"><button type="button" :disabled="busy === 'action'" @click="respondLogin(login, true)">批准</button><button type="button" :disabled="busy === 'action'" @click="respondLogin(login, false)">拒绝</button></span></li></ul>
    <small v-if="error" class="steam-action-error" role="alert">{{ error }}</small>
  </div>
</template>
