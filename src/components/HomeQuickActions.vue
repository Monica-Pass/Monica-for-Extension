<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { tr } from "../i18n";
import type { LoginItem, TotpItem, VaultItem } from "../core/model";
import { findBoundTotpItem, parametersFromItem } from "../core/login-otp";
import { generateOtpWithParameters } from "../core/totp";
import { vaultClient } from "../runtime/client";

const props = defineProps<{
  item: VaultItem;
  items: readonly VaultItem[];
  consumeOtp: (item: LoginItem | TotpItem) => Promise<void>;
}>();
const busy = ref(false);
const status = ref("");
let alive = true;
let revision = 0;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
const usernameAvailable = computed(() => props.item.kind === "login" && props.item.username && !["SSH_KEY", "BARCODE"].includes(props.item.loginType || ""));
const otpSource = computed(() => props.item.kind === "totp" ? props.item : props.item.kind === "login" ? findBoundTotpItem(props.item, props.items) || (props.item.totpSecret ? props.item : undefined) : undefined);
const linkedOtp = computed(() => props.item.kind === "login" && Boolean(props.item.boundTotpItemId || otpSource.value));
watch(() => props.item.id, () => { revision++; status.value = ""; });
onBeforeUnmount(() => { alive = false; revision++; clearTimeout(statusTimer); status.value = ""; });

async function copy(field: "username" | "otp") {
  if (busy.value) return;
  busy.value = true;
  status.value = "";
  const request = revision;
  const current = () => alive && request === revision;
  let copied = false;
  try {
    // Read through the unlocked manager boundary so a stale homepage cannot copy a locked/deleted item.
    const item = await vaultClient.getItem(props.item.id);
    if (!current()) return;
    if (!item || item.archivedAt || item.deletedAt) throw new Error("Unavailable item");
    if (field === "username") {
      if (item.kind !== "login" || !item.username) throw new Error("No username");
      await navigator.clipboard.writeText(item.username);
    } else {
      if (item.kind !== "login" && item.kind !== "totp") throw new Error("No authenticator");
      const bound = item.kind === "login" ? findBoundTotpItem(item, props.items) : undefined;
      const source = bound ? await vaultClient.getItem(bound.id) : item;
      if (!current()) return;
      if (!source || source.archivedAt || source.deletedAt || (source.kind !== "login" && source.kind !== "totp")) throw new Error("Unavailable authenticator");
      const parameters = parametersFromItem(source);
      const code = await generateOtpWithParameters(parameters);
      if (!current()) return;
      await navigator.clipboard.writeText(code);
      copied = true;
      // A successful HOTP copy must be consumed even if the user then navigates away.
      if (parameters.otpType === "HOTP") await props.consumeOtp(source);
    }
    if (current()) status.value = tr('已复制{0}。', { 0: field === "username" ? tr('用户名') : tr('验证码') });
  } catch {
    if (current()) status.value = copied ? tr('验证码已复制，但计数器更新失败。') : tr('复制失败，请打开详情重试。');
  } finally {
    busy.value = false;
    if (current() && status.value) {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.value = ""; }, 4000);
    }
  }
}
</script>

<template>
  <div v-if="usernameAvailable || otpSource || linkedOtp" class="home-quick-actions">
    <span v-if="linkedOtp" class="home-otp-badge"><m3e-icon name="security" aria-hidden="true" />{{ tr('已关联验证码') }}</span>
    <div class="home-quick-buttons">
      <button v-if="usernameAvailable" type="button" class="home-button" :disabled="busy" @click="copy('username')"><m3e-icon name="content_copy" aria-hidden="true" />{{ tr('复制用户名') }}</button>
      <button v-if="otpSource || linkedOtp" type="button" class="home-button" :disabled="busy || !otpSource" @click="copy('otp')"><m3e-icon name="content_copy" aria-hidden="true" />{{ tr('复制验证码') }}</button>
    </div>
    <p v-if="linkedOtp && !otpSource" class="home-caption">{{ tr('验证码暂不可用，请检查关联条目。') }}</p>
    <p class="home-copy-status" role="status">{{ status }}</p>
  </div>
</template>
