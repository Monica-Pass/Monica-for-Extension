<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { TotpItem } from "../core/model";
import { parametersFromItem } from "../core/login-otp";
import { generateOtpWithParameters, otpSecondsRemaining } from "../core/totp";

const props = withDefaults(defineProps<{ item: TotpItem; allowUse?: boolean }>(), { allowUse: false });
const emit = defineEmits<{ used: [code: string] }>();
const code = ref("•••••");
const remaining = ref(0);
const copyState = ref("");
let timer = 0;

async function refresh() {
  try {
    const now = Date.now();
    const parameters = parametersFromItem(props.item);
    code.value = await generateOtpWithParameters(parameters, now);
    remaining.value = otpSecondsRemaining(parameters, now);
  } catch {
    code.value = "不可用";
    remaining.value = 0;
  }
}

async function useCode() {
  if (code.value === "不可用" || code.value.includes("•")) return;
  try {
    await navigator.clipboard.writeText(code.value);
    copyState.value = "已复制";
    if (props.item.otpType === "HOTP") emit("used", code.value);
    window.setTimeout(() => { copyState.value = ""; }, 1600);
  } catch {
    copyState.value = "复制失败";
  }
}

void refresh();
timer = window.setInterval(() => void refresh(), 1000);
watch(() => [props.item.counter, props.item.secret, props.item.otpType], () => void refresh());
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <span class="totp-code-cell">
    <button v-if="allowUse" type="button" :aria-label="item.otpType === 'HOTP' ? '复制验证码并将计数器加一' : '复制验证码'" @click="useCode"><strong>{{ code }}</strong></button>
    <strong v-else>{{ code }}</strong>
    <small v-if="remaining">{{ remaining }} 秒</small>
    <small v-else-if="item.otpType === 'HOTP'">计数 {{ item.counter || 0 }}</small>
    <small class="visually-hidden" aria-live="polite">{{ copyState }}</small>
  </span>
</template>
