<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue';
import { tr } from '../i18n';
import { vaultClient } from '../runtime/client';
import { DEFAULT_AUTO_LOCK_MINUTES, MIN_AUTO_LOCK_MINUTES, MAX_AUTO_LOCK_MINUTES, validAutoLockMinutes } from '../core/auto-lock';

const emit = defineEmits<{ busy: [value: boolean] }>();
const id = useId();
// Vue's number input model returns numbers for numeric values and strings for
// empty/incomplete input. Validate both without losing the empty-input boundary.
const minutes = ref<string | number>(String(DEFAULT_AUTO_LOCK_MINUTES)), saved = ref(DEFAULT_AUTO_LOCK_MINUTES);
const loaded = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const valid = computed(() => String(minutes.value).trim() !== '' && validAutoLockMinutes(Number(minutes.value)));
const dirty = computed(() => Number(minutes.value) !== saved.value);
function setBusy(value: boolean) { busy.value = value; emit('busy', value); }
async function load() {
  if (busy.value) return;
  setBusy(true); error.value = '';
  try {
    saved.value = await vaultClient.getAutoLockMinutes();
    minutes.value = String(saved.value); loaded.value = true;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : tr('未能读取锁定时间，请重试。'); }
  finally { setBusy(false); }
}
async function save() {
  if (!loaded.value || busy.value || !valid.value || !dirty.value) return;
  setBusy(true); error.value = ''; notice.value = '';
  try {
    saved.value = await vaultClient.setAutoLockMinutes(Number(minutes.value));
    minutes.value = String(saved.value); notice.value = tr('锁定时间已保存。');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : tr('未能保存锁定时间，请重试。'); }
  finally { setBusy(false); }
}
onMounted(() => { void load(); });
</script>

<template>
  <section class="auto-lock-settings" :aria-labelledby="`${id}-title`">
    <h2 :id="`${id}-title`">{{ tr('自动锁定') }}</h2>
    <p class="supporting" :id="`${id}-hint`">{{ tr('在所设时长内没有密码库操作时自动锁定。默认 15 分钟，支持 1～1440 分钟；保存后重新开始计时，浏览器退出会结束当前会话。') }}</p>
    <form @submit.prevent="save">
      <label :for="id">{{ tr('自动锁定时间（分钟）') }}</label>
      <m3e-form-field variant="filled" hide-required-marker hide-subscript="always">
        <input :id="id" v-model="minutes" type="number" inputmode="numeric" required :min="MIN_AUTO_LOCK_MINUTES" :max="MAX_AUTO_LOCK_MINUTES" step="1" :disabled="!loaded || busy" :aria-describedby="`${id}-hint${!valid ? ` ${id}-invalid` : ''}`" :aria-invalid="!valid" @input="notice = ''" />
      </m3e-form-field>
      <p v-if="!valid" :id="`${id}-invalid`" class="form-error" role="alert">{{ tr('锁定时间必须是 1～1440 分钟的整数。') }}</p>
      <m3e-button type="submit" variant="filled" :disabled="!loaded || busy || !valid || !dirty" @click.prevent="save">{{ busy && loaded ? tr('正在保存…') : tr('保存锁定时间') }}</m3e-button>
    </form>
    <m3e-button v-if="!loaded && !busy" variant="text" @click="load">{{ tr('重试') }}</m3e-button>
    <p v-if="notice" class="supporting" role="status">{{ notice }}</p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.auto-lock-settings{display:grid;gap:12px;min-width:0}h2,p{margin:0}form{display:grid;gap:12px;min-width:0}label{font-size:.875rem}m3e-form-field{width:100%;min-width:0}input{width:100%;min-width:0;font:inherit;color:inherit}m3e-button{justify-self:start;max-width:100%}
</style>
