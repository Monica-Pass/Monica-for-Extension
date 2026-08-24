<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { DEFAULT_SYMBOLS, generatePassphrase, generatePassword, generatePin, passwordStrengthBits } from "../core/credential-generator";
import { DEFAULT_GENERATOR_PREFERENCES, GeneratorPreferencesStore, normalizeGeneratorPreferences, resolveAllowedSymbols } from "../core/generator-preferences";
import type { ProviderAccount } from "../core/model";
import { vaultClient } from "../runtime/client";
import type { AndroidGeneratorHistoryEntry } from "../runtime/messages";

const props = defineProps<{ providers: ProviderAccount[] }>();

interface GeneratorHistoryRow extends AndroidGeneratorHistoryEntry {
  providerId: string;
  providerName: string;
}

type Mode = "password" | "pin" | "passphrase";
const mode = ref<Mode>("password");
const result = ref("");
const status = ref("");
const history = ref<GeneratorHistoryRow[]>([]);
const historyBusy = ref(false);
const historyError = ref("");
const revealedHistory = ref(new Set<string>());
const pendingDelete = ref("");
const preferencesStore = new GeneratorPreferencesStore();
let restored = false;
const password = reactive({ length: DEFAULT_GENERATOR_PREFERENCES.symbolLength, uppercase: true, lowercase: true, numbers: true, symbols: true, excludeSimilar: DEFAULT_GENERATOR_PREFERENCES.excludeSimilar, excludeAmbiguous: false, uppercaseMin: DEFAULT_GENERATOR_PREFERENCES.uppercaseMin, lowercaseMin: DEFAULT_GENERATOR_PREFERENCES.lowercaseMin, numbersMin: DEFAULT_GENERATOR_PREFERENCES.numbersMin, symbolsMin: DEFAULT_GENERATOR_PREFERENCES.symbolsMin, useSymbolExclusionMode: true, excludedSymbols: "", customSymbols: DEFAULT_GENERATOR_PREFERENCES.customSymbols });
const pin = reactive({ length: DEFAULT_GENERATOR_PREFERENCES.pinLength });
const phrase = reactive({ length: DEFAULT_GENERATOR_PREFERENCES.passphraseWordCount, delimiter: DEFAULT_GENERATOR_PREFERENCES.passphraseDelimiter, capitalize: false, includeNumber: false, customWord: "" });
const entropy = computed(() => mode.value === "password" ? passwordStrengthBits(result.value) : 0);
const symbolSource = computed({
  get: () => password.useSymbolExclusionMode ? "exclusion" : "custom",
  set: (value: string) => { password.useSymbolExclusionMode = value !== "custom"; }
});

function toPreferences() {
  return normalizeGeneratorPreferences({
    selectedGenerator: mode.value === "pin" ? "PIN" : mode.value === "passphrase" ? "PASSPHRASE" : "SYMBOL",
    symbolLength: password.length,
    includeUppercase: password.uppercase,
    includeLowercase: password.lowercase,
    includeNumbers: password.numbers,
    includeSymbols: password.symbols,
    useSymbolExclusionMode: password.useSymbolExclusionMode,
    excludedSymbols: password.excludedSymbols,
    customSymbols: password.customSymbols,
    excludeSimilar: password.excludeSimilar,
    excludeAmbiguous: password.excludeAmbiguous,
    uppercaseMin: password.uppercase ? password.uppercaseMin : 0,
    lowercaseMin: password.lowercase ? password.lowercaseMin : 0,
    numbersMin: password.numbers ? password.numbersMin : 0,
    symbolsMin: password.symbols ? password.symbolsMin : 0,
    passphraseWordCount: phrase.length,
    passphraseDelimiter: phrase.delimiter,
    passphraseCapitalize: phrase.capitalize,
    passphraseIncludeNumber: phrase.includeNumber,
    passphraseCustomWord: phrase.customWord,
    pinLength: pin.length
  });
}

function applyPreferences(preferences: ReturnType<typeof normalizeGeneratorPreferences>) {
  password.length = preferences.symbolLength;
  password.uppercase = preferences.includeUppercase;
  password.lowercase = preferences.includeLowercase;
  password.numbers = preferences.includeNumbers;
  password.symbols = preferences.includeSymbols;
  password.useSymbolExclusionMode = preferences.useSymbolExclusionMode;
  password.excludedSymbols = preferences.excludedSymbols;
  password.customSymbols = preferences.customSymbols;
  password.excludeSimilar = preferences.excludeSimilar;
  password.excludeAmbiguous = preferences.excludeAmbiguous;
  password.uppercaseMin = preferences.uppercaseMin || 1;
  password.lowercaseMin = preferences.lowercaseMin || 1;
  password.numbersMin = preferences.numbersMin || 1;
  password.symbolsMin = preferences.symbolsMin || 1;
  pin.length = preferences.pinLength;
  phrase.length = preferences.passphraseWordCount;
  phrase.delimiter = preferences.passphraseDelimiter;
  phrase.capitalize = preferences.passphraseCapitalize;
  phrase.includeNumber = preferences.passphraseIncludeNumber;
  phrase.customWord = preferences.passphraseCustomWord;
  mode.value = preferences.selectedGenerator === "PIN" ? "pin" : preferences.selectedGenerator === "PASSPHRASE" ? "passphrase" : "password";
}

async function restore() {
  try { applyPreferences(await preferencesStore.load()); }
  catch { /* 首次运行使用默认值。 */ }
  restored = true;
}

function persist() {
  if (!restored) return;
  void preferencesStore.save(toPreferences()).catch(() => { /* 偏好保存失败不影响生成。 */ });
}

watch([password, pin, phrase, mode], persist, { deep: true });

function generate() {
  status.value = "";
  try {
    if (mode.value === "password") result.value = generatePassword({ length: password.length, uppercaseChars: password.uppercase ? undefined : "", lowercaseChars: password.lowercase ? undefined : "", numberChars: password.numbers ? undefined : "", symbolChars: password.symbols ? resolveAllowedSymbols(toPreferences()) : "", uppercaseMin: password.uppercase ? password.uppercaseMin : 0, lowercaseMin: password.lowercase ? password.lowercaseMin : 0, numbersMin: password.numbers ? password.numbersMin : 0, symbolsMin: password.symbols ? password.symbolsMin : 0, excludeSimilar: password.excludeSimilar, excludeAmbiguous: password.excludeAmbiguous });
    else if (mode.value === "pin") result.value = generatePin(pin.length);
    else result.value = generatePassphrase(phrase);
  } catch (error) { status.value = error instanceof Error ? error.message : "无法生成。"; }
}

function toggleExcludedSymbol(symbol: string) {
  password.excludedSymbols = password.excludedSymbols.includes(symbol)
    ? [...password.excludedSymbols].filter((value) => value !== symbol).join("")
    : password.excludedSymbols + symbol;
}

async function copyResult() {
  if (!result.value) return;
  try { await navigator.clipboard.writeText(result.value); status.value = "已复制到剪贴板。"; }
  catch { status.value = "复制失败，请手动选择结果。"; }
}

function changeMode(value: Mode) { mode.value = value; generate(); }

async function loadHistory() {
  historyBusy.value = true;
  historyError.value = "";
  try {
    const pages = await Promise.all(props.providers
      .filter((provider) => provider.kind === "monica-webdav" && provider.enabled)
      .map(async (provider) => (await vaultClient.listAndroidGeneratorHistory(provider.id))
        .map((entry) => ({ ...entry, providerId: provider.id, providerName: provider.name }))));
    history.value = pages.flat().sort((left, right) => right.timestamp - left.timestamp);
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "无法读取 Android 生成历史。";
  } finally {
    historyBusy.value = false;
  }
}

function toggleHistorySecret(id: string) {
  const next = new Set(revealedHistory.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  revealedHistory.value = next;
}

async function deleteHistoryEntry(entry: GeneratorHistoryRow) {
  if (pendingDelete.value !== entry.id) {
    pendingDelete.value = entry.id;
    return;
  }
  historyBusy.value = true;
  historyError.value = "";
  try {
    await vaultClient.deleteAndroidGeneratorHistory(entry.providerId, entry.id);
    pendingDelete.value = "";
    await loadHistory();
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : "无法删除 Android 生成历史。";
    historyBusy.value = false;
  }
}

function historyTypeLabel(type: string): string {
  return ({ SYMBOL: "密码", PASSWORD: "单词密码", PASSPHRASE: "密码短语", PIN: "PIN", AUTOFILL: "自动填充" } as Record<string, string>)[type.toUpperCase()] || type;
}

function historyContext(entry: GeneratorHistoryRow): string {
  return entry.username || entry.domain || entry.packageName || "未关联账号";
}

function historyTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

onMounted(async () => {
  await restore();
  generate();
  await loadHistory();
});
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
        <fieldset class="generator-options field-wide"><legend>最少数量</legend><label><input v-model.number="password.uppercaseMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.uppercase" aria-label="大写最少数量" /><span>大写</span></label><label><input v-model.number="password.lowercaseMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.lowercase" aria-label="小写最少数量" /><span>小写</span></label><label><input v-model.number="password.numbersMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.numbers" aria-label="数字最少数量" /><span>数字</span></label><label><input v-model.number="password.symbolsMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.symbols" aria-label="符号最少数量" /><span>符号</span></label></fieldset>
        <fieldset class="generator-options field-wide"><legend>符号来源</legend><label><input v-model="symbolSource" type="radio" value="exclusion" name="symbol-source" />排除默认符号</label><label><input v-model="symbolSource" type="radio" value="custom" name="symbol-source" />自定义符号集</label>
          <div v-if="password.useSymbolExclusionMode" class="generator-symbol-grid field-wide">
            <label v-for="symbol in [...DEFAULT_SYMBOLS]" :key="symbol" class="generator-symbol-chip">
              <input type="checkbox" :checked="!password.excludedSymbols.includes(symbol)" :aria-label="`使用符号 ${symbol}`" @change="toggleExcludedSymbol(symbol)" />
              <span>{{ symbol }}</span>
            </label>
          </div>
          <label v-else class="field field-wide"><span>自定义符号集</span><input v-model="password.customSymbols" aria-label="自定义符号集" maxlength="256" /></label>
        </fieldset>
        <fieldset class="generator-options field-wide"><legend>可读性</legend><label><input v-model="password.excludeSimilar" type="checkbox" />排除 0 O l 1 I</label><label><input v-model="password.excludeAmbiguous" type="checkbox" />排除模糊符号</label></fieldset>
      </template>
      <template v-else-if="mode === 'pin'"><label class="field field-wide"><span>PIN 长度</span><input v-model.number="pin.length" type="number" min="1" max="128" inputmode="numeric" /></label></template>
      <template v-else><label class="field"><span>单词数</span><input v-model.number="phrase.length" type="number" min="1" max="32" /></label><label class="field"><span>分隔符</span><input v-model="phrase.delimiter" maxlength="8" /></label><label class="field field-wide"><span>自定义单词（可选）</span><input v-model="phrase.customWord" /></label><label class="favorite-row"><input v-model="phrase.capitalize" type="checkbox" />首字母大写</label><label class="favorite-row"><input v-model="phrase.includeNumber" type="checkbox" />附加数字</label></template>
      <p v-if="status" class="generator-status field-wide" aria-live="polite">{{ status }}</p>
      <footer class="field-wide"><m3e-button variant="filled" type="submit"><m3e-icon slot="icon" name="refresh"></m3e-icon>重新生成</m3e-button></footer>
    </form>

    <details class="generator-history">
      <summary>
        <span><m3e-icon name="history"></m3e-icon><strong>Android 生成历史</strong></span>
        <span class="generator-history-count">{{ history.length }}</span>
      </summary>
      <div class="generator-history-body">
        <div class="generator-history-toolbar">
          <span>{{ props.providers.filter((provider) => provider.kind === 'monica-webdav' && provider.enabled).length ? '来自 Monica Android WebDAV' : '尚未连接 Android WebDAV' }}</span>
          <m3e-icon-button aria-label="刷新 Android 生成历史" title="刷新" :disabled="historyBusy" @click="loadHistory"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button>
        </div>
        <p v-if="historyError" class="form-error" role="alert">{{ historyError }}</p>
        <p v-else-if="historyBusy && !history.length" class="generator-history-empty">正在读取…</p>
        <ul v-else-if="history.length" class="generator-history-list">
          <li v-for="entry in history" :key="`${entry.providerId}:${entry.id}`">
            <div class="generator-history-main">
              <code :aria-label="revealedHistory.has(entry.id) ? '已显示生成值' : '生成值已隐藏'">{{ revealedHistory.has(entry.id) ? entry.password : '••••••••' }}</code>
              <span>{{ historyTypeLabel(entry.type) }}</span>
            </div>
            <div class="generator-history-meta"><span>{{ historyContext(entry) }}</span><time :datetime="new Date(entry.timestamp).toISOString()">{{ historyTime(entry.timestamp) }}</time><span>{{ entry.providerName }}</span></div>
            <div class="generator-history-actions">
              <m3e-icon-button :aria-label="revealedHistory.has(entry.id) ? '隐藏生成值' : '显示生成值'" :title="revealedHistory.has(entry.id) ? '隐藏' : '显示'" @click="toggleHistorySecret(entry.id)"><m3e-icon :name="revealedHistory.has(entry.id) ? 'visibility_off' : 'visibility'"></m3e-icon></m3e-icon-button>
              <button v-if="pendingDelete === entry.id" type="button" class="generator-history-confirm" @click="deleteHistoryEntry(entry)">确认删除</button>
              <m3e-icon-button v-else aria-label="删除生成历史" title="删除" @click="deleteHistoryEntry(entry)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
              <m3e-icon-button v-if="pendingDelete === entry.id" aria-label="取消删除" title="取消" @click="pendingDelete = ''"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
            </div>
          </li>
        </ul>
        <p v-else class="generator-history-empty">没有可读取的 Android 生成历史</p>
      </div>
    </details>
  </section>
</template>
