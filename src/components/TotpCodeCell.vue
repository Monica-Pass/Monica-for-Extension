<script setup lang="ts">
import { tr } from '../i18n';

import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { LoginItem, TotpItem } from "../core/model";
import { parametersFromItem } from "../core/login-otp";
import { otpSecondsRemaining } from "../core/totp";
import { createOtpDisplayCache } from "../core/otp-display-cache";
import { subscribeForegroundClock } from "../lib/foreground-clock";

const props = withDefaults(defineProps<{
  item: LoginItem | TotpItem;
  allowUse?: boolean;
  showCopyIcon?: boolean;
  consumeCode?: (item: LoginItem | TotpItem) => Promise<void>;
}>(), { allowUse: false, showCopyIcon: false });
const code = ref("•••••");
const remaining = ref(0);
const copyState = ref("");
const available = ref(false);
const unavailable = ref(false);
const copying = ref(false);
const displayCode = computed(() => unavailable.value ? tr('不可用') : code.value);
const parameters = computed(() => {
  try { return parametersFromItem(props.item); }
  catch { return undefined; }
});
const cache = createOtpDisplayCache();
let stopClock: (() => void) | undefined;
let copyTimer: number | undefined;
let revision = 0;
let disposed = false;

async function refresh(now = Date.now()) {
  const request = ++revision;
  try {
    if (!parameters.value) throw new Error("Missing OTP parameters");
    const value = await cache.get(parameters.value, now);
    if (disposed || request !== revision) return;
    code.value = value;
    remaining.value = otpSecondsRemaining(parameters.value, now);
    available.value = true;
    unavailable.value = false;
  } catch {
    if (disposed || request !== revision) return;
    unavailable.value = true;
    remaining.value = 0;
    available.value = false;
  }
}

async function useCode() {
  if (copying.value) return;
  copying.value = true;
  let copied = false;
  try {
    await refresh();
    if (disposed || !available.value) return;
    const isHotp = parameters.value?.otpType === "HOTP";
    if (isHotp && !props.consumeCode) return;
    const source = props.item;
    await navigator.clipboard.writeText(code.value);
    copied = true;
    // Keep copying disabled until the source counter has been saved and refreshed.
    if (isHotp) await props.consumeCode!(source);
    if (disposed) return;
    copyState.value = tr('已复制');
    window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copyState.value = ""; }, 1600);
  } catch {
    if (!disposed) copyState.value = copied ? tr('验证码已复制，但计数器更新失败。') : tr('复制失败');
  } finally {
    copying.value = false;
  }
}

watch(parameters, () => {
  stopClock?.();
  stopClock = undefined;
  revision++;
  cache.clear();
  available.value = false;
  unavailable.value = false;
  code.value = "•••••";
  if (!parameters.value || parameters.value.otpType === "HOTP") void refresh();
  else stopClock = subscribeForegroundClock((now) => {
    if (now === null) {
      revision++;
      cache.clear();
      code.value = "•••••";
      remaining.value = 0;
      available.value = false;
    } else void refresh(now);
  });
}, { immediate: true });
onBeforeUnmount(() => {
  disposed = true;
  revision++;
  stopClock?.();
  window.clearTimeout(copyTimer);
  cache.clear();
});
</script>

<template>
  <span class="totp-code-cell">
    <button v-if="allowUse" type="button" :disabled="!available || copying || (parameters?.otpType === 'HOTP' && !consumeCode)" :aria-label="parameters?.otpType === 'HOTP' ? tr('复制验证码并将计数器加一') : tr('复制验证码')" @click="useCode"><strong>{{ displayCode }}</strong><m3e-icon v-if="showCopyIcon" name="content_copy" aria-hidden="true"></m3e-icon></button>
    <strong v-else>{{ displayCode }}</strong>
    <small v-if="remaining">{{ tr('{0} 秒', { 0: remaining }) }}</small>
    <small v-else-if="parameters?.otpType === 'HOTP'">{{ tr('计数 {0}', { 0: parameters.counter || 0 }) }}</small>
    <small class="otp-copy-status" aria-live="polite">{{ copyState }}</small>
  </span>
</template>
