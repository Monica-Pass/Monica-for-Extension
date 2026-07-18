<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { generatePassphrase, generatePassword, generatePin, passwordStrengthBits } from "../core/credential-generator";

type Mode = "password" | "pin" | "passphrase";
const mode = ref<Mode>("password");
const result = ref("");
const status = ref("");
const password = reactive({ length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true, excludeSimilar: true, excludeAmbiguous: false, uppercaseMin: 1, lowercaseMin: 1, numbersMin: 1, symbolsMin: 1 });
const pin = reactive({ length: 6 });
const phrase = reactive({ length: 4, delimiter: "-", capitalize: false, includeNumber: false, customWord: "" });
const entropy = computed(() => mode.value === "password" ? passwordStrengthBits(result.value) : 0);

function generate() {
  status.value = "";
  try {
    if (mode.value === "password") result.value = generatePassword({ length: password.length, uppercaseChars: password.uppercase ? undefined : "", lowercaseChars: password.lowercase ? undefined : "", numberChars: password.numbers ? undefined : "", symbolChars: password.symbols ? undefined : "", uppercaseMin: password.uppercase ? password.uppercaseMin : 0, lowercaseMin: password.lowercase ? password.lowercaseMin : 0, numbersMin: password.numbers ? password.numbersMin : 0, symbolsMin: password.symbols ? password.symbolsMin : 0, excludeSimilar: password.excludeSimilar, excludeAmbiguous: password.excludeAmbiguous });
    else if (mode.value === "pin") result.value = generatePin(pin.length);
    else result.value = generatePassphrase(phrase);
  } catch (error) { status.value = error instanceof Error ? error.message : "无法生成。"; }
}

async function copyResult() {
  if (!result.value) return;
  try { await navigator.clipboard.writeText(result.value); status.value = "已复制到剪贴板。"; }
  catch { status.value = "复制失败，请手动选择结果。"; }
}

function changeMode(value: Mode) { mode.value = value; generate(); }
generate();
</script>

<template>
  <section class="generator-panel" aria-labelledby="generator-result-title">
    <div class="generator-result">
      <div><span id="generator-result-title">生成结果</span><output aria-live="polite">{{ result }}</output><small v-if="mode === 'password'">约 {{ entropy }} bit</small></div>
      <div class="generator-result-actions"><m3e-icon-button aria-label="重新生成" title="重新生成" @click="generate"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button><m3e-icon-button aria-label="复制结果" title="复制结果" @click="copyResult"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button></div>
    </div>

    <div class="generator-modes" role="tablist" aria-label="生成类型">
      <button v-for="entry in ([['password','密码','password'],['pin','PIN','pin'],['passphrase','短语','text_fields']] as const)" :key="entry[0]" type="button" role="tab" :aria-selected="mode === entry[0]" :class="{ selected: mode === entry[0] }" @click="changeMode(entry[0])"><m3e-icon :name="entry[2]"></m3e-icon><span>{{ entry[1] }}</span></button>
    </div>

    <form class="generator-form" @submit.prevent="generate">
      <template v-if="mode === 'password'">
        <label class="field field-wide"><span>长度：{{ password.length }}</span><input v-model.number="password.length" type="range" min="4" max="64" /></label>
        <fieldset class="generator-options field-wide"><legend>字符类型</legend><label><input v-model="password.uppercase" type="checkbox" />大写字母</label><label><input v-model="password.lowercase" type="checkbox" />小写字母</label><label><input v-model="password.numbers" type="checkbox" />数字</label><label><input v-model="password.symbols" type="checkbox" />符号</label></fieldset>
        <fieldset class="generator-options field-wide"><legend>可读性</legend><label><input v-model="password.excludeSimilar" type="checkbox" />排除 0 O l 1 I</label><label><input v-model="password.excludeAmbiguous" type="checkbox" />排除模糊符号</label></fieldset>
      </template>
      <template v-else-if="mode === 'pin'"><label class="field field-wide"><span>PIN 长度</span><input v-model.number="pin.length" type="number" min="1" max="128" inputmode="numeric" /></label></template>
      <template v-else><label class="field"><span>单词数</span><input v-model.number="phrase.length" type="number" min="1" max="32" /></label><label class="field"><span>分隔符</span><input v-model="phrase.delimiter" maxlength="8" /></label><label class="field field-wide"><span>自定义单词（可选）</span><input v-model="phrase.customWord" /></label><label class="favorite-row"><input v-model="phrase.capitalize" type="checkbox" />首字母大写</label><label class="favorite-row"><input v-model="phrase.includeNumber" type="checkbox" />附加数字</label></template>
      <p v-if="status" class="generator-status field-wide" aria-live="polite">{{ status }}</p>
      <footer class="field-wide"><m3e-button variant="filled" type="submit"><m3e-icon slot="icon" name="refresh"></m3e-icon>重新生成</m3e-button></footer>
    </form>
  </section>
</template>
