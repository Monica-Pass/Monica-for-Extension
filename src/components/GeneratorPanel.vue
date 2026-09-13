<script setup lang="ts">
import { tr } from '../i18n';

import { computed, onMounted, reactive, ref, watch } from "vue";
import { DEFAULT_SYMBOLS, generatePassphrase, generatePassword, generatePin, generateWordPassword, passwordStrengthBits } from "../core/credential-generator";
import { DEFAULT_GENERATOR_PREFERENCES, GeneratorPreferencesStore, normalizeGeneratorPreferences, resolveAllowedSymbols } from "../core/generator-preferences";
import { generateSshKeyPair, type SshKeyPairData } from "../core/ssh-key-generator";
import type { ProviderAccount } from "../core/model";
import { vaultClient } from "../runtime/client";
import type { AndroidGeneratorHistoryEntry } from "../runtime/messages";

const props = defineProps<{ providers: ProviderAccount[] }>();

interface GeneratorHistoryRow extends AndroidGeneratorHistoryEntry {
  providerId: string;
  providerName: string;
}

type Mode = "password" | "word" | "pin" | "passphrase" | "ssh";
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
const words = reactive({ length: DEFAULT_GENERATOR_PREFERENCES.passwordLength, firstLetterUppercase: DEFAULT_GENERATOR_PREFERENCES.firstLetterUppercase, includeNumbers: DEFAULT_GENERATOR_PREFERENCES.includeNumbersInPassword, separator: DEFAULT_GENERATOR_PREFERENCES.customSeparator, separatorCountsTowardsLength: DEFAULT_GENERATOR_PREFERENCES.separatorCountsTowardsLength, segmentLength: DEFAULT_GENERATOR_PREFERENCES.segmentLength });
const ssh = reactive({ algorithm: DEFAULT_GENERATOR_PREFERENCES.sshKeyAlgorithm, rsaSize: DEFAULT_GENERATOR_PREFERENCES.sshKeyRsaSize });
const sshResult = ref<SshKeyPairData | null>(null);
const revealedPrivateKey = ref(false);
const generating = ref(false);
const entropy = computed(() => mode.value === "password" ? passwordStrengthBits(result.value) : 0);
const symbolSource = computed({
  get: () => password.useSymbolExclusionMode ? "exclusion" : "custom",
  set: (value: string) => { password.useSymbolExclusionMode = value !== "custom"; }
});

function toPreferences() {
  return normalizeGeneratorPreferences({
    selectedGenerator: mode.value === "pin" ? "PIN" : mode.value === "passphrase" ? "PASSPHRASE" : mode.value === "word" ? "PASSWORD" : mode.value === "ssh" ? "SSH_KEY" : "SYMBOL",
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
    pinLength: pin.length,
    passwordLength: words.length,
    firstLetterUppercase: words.firstLetterUppercase,
    includeNumbersInPassword: words.includeNumbers,
    customSeparator: words.separator,
    separatorCountsTowardsLength: words.separatorCountsTowardsLength,
    segmentLength: words.segmentLength,
    sshKeyAlgorithm: ssh.algorithm,
    sshKeyRsaSize: ssh.rsaSize
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
  words.length = preferences.passwordLength;
  words.firstLetterUppercase = preferences.firstLetterUppercase;
  words.includeNumbers = preferences.includeNumbersInPassword;
  words.separator = preferences.customSeparator;
  words.separatorCountsTowardsLength = preferences.separatorCountsTowardsLength;
  words.segmentLength = preferences.segmentLength;
  ssh.algorithm = preferences.sshKeyAlgorithm;
  ssh.rsaSize = preferences.sshKeyRsaSize;
  mode.value = preferences.selectedGenerator === "PIN" ? "pin" : preferences.selectedGenerator === "PASSPHRASE" ? "passphrase" : preferences.selectedGenerator === "PASSWORD" ? "word" : preferences.selectedGenerator === "SSH_KEY" ? "ssh" : "password";
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

watch([password, pin, phrase, words, ssh, mode], persist, { deep: true });

async function generate() {
  if (generating.value) return;
  status.value = "";
  try {
    if (mode.value === "password") result.value = generatePassword({ length: password.length, uppercaseChars: password.uppercase ? undefined : "", lowercaseChars: password.lowercase ? undefined : "", numberChars: password.numbers ? undefined : "", symbolChars: password.symbols ? resolveAllowedSymbols(toPreferences()) : "", uppercaseMin: password.uppercase ? password.uppercaseMin : 0, lowercaseMin: password.lowercase ? password.lowercaseMin : 0, numbersMin: password.numbers ? password.numbersMin : 0, symbolsMin: password.symbols ? password.symbolsMin : 0, excludeSimilar: password.excludeSimilar, excludeAmbiguous: password.excludeAmbiguous });
    else if (mode.value === "word") result.value = generateWordPassword({ length: words.length, firstLetterUppercase: words.firstLetterUppercase, includeNumbers: words.includeNumbers, separator: words.separator, separatorCountsTowardsLength: words.separatorCountsTowardsLength, segmentLength: words.segmentLength });
    else if (mode.value === "pin") result.value = generatePin(pin.length);
    else if (mode.value === "ssh") {
      generating.value = true;
      revealedPrivateKey.value = false;
      sshResult.value = await generateSshKeyPair({ algorithm: ssh.algorithm === "RSA" ? "RSA" : "ED25519", rsaKeySize: ssh.rsaSize });
      result.value = "";
      generating.value = false;
      return;
    }
    else result.value = generatePassphrase(phrase);
  } catch (error) { status.value = error instanceof Error ? error.message : tr('无法生成。'); }
  generating.value = false;
}

async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); status.value = tr('已复制到剪贴板。'); }
  catch { status.value = tr('复制失败，请手动选择内容。'); }
}

function toggleExcludedSymbol(symbol: string) {
  password.excludedSymbols = password.excludedSymbols.includes(symbol)
    ? [...password.excludedSymbols].filter((value) => value !== symbol).join("")
    : password.excludedSymbols + symbol;
}

async function copyResult() {
  if (!result.value) return;
  await copyText(result.value);
}

function changeMode(value: Mode) {
  mode.value = value;
  if (value !== "ssh") { sshResult.value = null; revealedPrivateKey.value = false; }
  void generate();
}

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
    historyError.value = error instanceof Error ? error.message : tr('无法读取 Android 生成历史。');
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
    historyError.value = error instanceof Error ? error.message : tr('无法删除 Android 生成历史。');
    historyBusy.value = false;
  }
}

function historyTypeLabel(type: string): string {
  return ({ SYMBOL: tr('密码'), PASSWORD: tr('单词密码'), PASSPHRASE: tr('密码短语'), PIN: "PIN", AUTOFILL: tr('自动填充') } as Record<string, string>)[type.toUpperCase()] || type;
}

function historyContext(entry: GeneratorHistoryRow): string {
  return entry.username || entry.domain || entry.packageName || tr('未关联账号');
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
      <div><span id="generator-result-title">{{ tr('生成结果') }}</span><output aria-live="polite">{{ result }}</output><small v-if="mode === 'password'">{{ tr('约 {0} bit', { 0: entropy }) }}</small></div>
      <div class="generator-result-actions"><m3e-icon-button :aria-label="tr('重新生成')" :title="tr('重新生成')" @click="generate"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button><m3e-icon-button :aria-label="tr('复制结果')" :title="tr('复制结果')" @click="copyResult"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button></div>
    </div>

    <div class="generator-modes" role="tablist" :aria-label="tr('生成类型')">
      <button v-for="entry in ([['password','密码','password'],['word','单词','abc'],['pin','PIN','pin'],['passphrase','短语','text_fields'],['ssh','SSH 密钥','key']] as const)" :key="entry[0]" type="button" role="tab" :aria-selected="mode === entry[0]" :class="{ selected: mode === entry[0] }" @click="changeMode(entry[0])"><m3e-icon :name="entry[2]"></m3e-icon><span>{{ tr(entry[1]) }}</span></button>
    </div>

    <div v-if="mode === 'ssh' && sshResult" class="generator-ssh-result field-wide">
      <dl class="generator-ssh-facts">
        <div><dt>{{ tr('算法') }}</dt><dd>{{ tr('{0} · {1} 位', { 0: sshResult.algorithm, 1: sshResult.keySize }) }}</dd></div>
        <div><dt>{{ tr('指纹') }}</dt><dd><code>{{ sshResult.fingerprintSha256 }}</code></dd></div>
      </dl>
      <label class="field field-wide"><span>{{ tr('公钥（OpenSSH）') }}</span><textarea class="generator-ssh-text" readonly rows="3" :value="sshResult.publicKeyOpenSsh" :aria-label="tr('公钥内容')"></textarea></label>
      <div class="generator-result-actions">
        <m3e-icon-button :aria-label="tr('复制公钥')" :title="tr('复制公钥')" @click="copyText(sshResult.publicKeyOpenSsh)"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button>
        <m3e-icon-button :aria-label="revealedPrivateKey ? tr('隐藏私钥') : tr('显示私钥')" :title="revealedPrivateKey ? tr('隐藏私钥') : tr('显示私钥')" @click="revealedPrivateKey = !revealedPrivateKey"><m3e-icon :name="revealedPrivateKey ? 'visibility_off' : 'visibility'"></m3e-icon></m3e-icon-button>
        <m3e-icon-button v-if="revealedPrivateKey" :aria-label="tr('复制私钥')" :title="tr('复制私钥')" @click="copyText(sshResult.privateKeyOpenSsh)"><m3e-icon name="content_copy"></m3e-icon></m3e-icon-button>
      </div>
      <label v-if="revealedPrivateKey" class="field field-wide"><span>{{ tr('私钥（OpenSSH，请妥善保管）') }}</span><textarea class="generator-ssh-text" readonly rows="8" :value="sshResult.privateKeyOpenSsh" :aria-label="tr('私钥内容')"></textarea></label>
      <p class="generator-history-empty">{{ tr('私钥仅保存在本页面内存中，不会写入密码库或同步数据。') }}</p>
    </div>

    <form class="generator-form" @submit.prevent="generate">
      <template v-if="mode === 'password'">
        <label class="field field-wide"><span>{{ tr('长度：{0}', { 0: password.length }) }}</span><input v-model.number="password.length" type="range" min="4" max="64" /></label>
        <fieldset class="generator-options field-wide"><legend>{{ tr('字符类型') }}</legend><label><input v-model="password.uppercase" type="checkbox" />{{ tr('大写字母') }}</label><label><input v-model="password.lowercase" type="checkbox" />{{ tr('小写字母') }}</label><label><input v-model="password.numbers" type="checkbox" />{{ tr('数字') }}</label><label><input v-model="password.symbols" type="checkbox" />{{ tr('符号') }}</label></fieldset>
        <fieldset class="generator-options field-wide"><legend>{{ tr('最少数量') }}</legend><label><input v-model.number="password.uppercaseMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.uppercase" :aria-label="tr('大写最少数量')" /><span>{{ tr('大写') }}</span></label><label><input v-model.number="password.lowercaseMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.lowercase" :aria-label="tr('小写最少数量')" /><span>{{ tr('小写') }}</span></label><label><input v-model.number="password.numbersMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.numbers" :aria-label="tr('数字最少数量')" /><span>{{ tr('数字') }}</span></label><label><input v-model.number="password.symbolsMin" class="generator-min-input" type="number" min="0" max="32" :disabled="!password.symbols" :aria-label="tr('符号最少数量')" /><span>{{ tr('符号') }}</span></label></fieldset>
        <fieldset class="generator-options field-wide"><legend>{{ tr('符号来源') }}</legend><label><input v-model="symbolSource" type="radio" value="exclusion" name="symbol-source" />{{ tr('排除默认符号') }}</label><label><input v-model="symbolSource" type="radio" value="custom" name="symbol-source" />{{ tr('自定义符号集') }}</label>
          <div v-if="password.useSymbolExclusionMode" class="generator-symbol-grid field-wide">
            <label v-for="symbol in [...DEFAULT_SYMBOLS]" :key="symbol" class="generator-symbol-chip">
              <input type="checkbox" :checked="!password.excludedSymbols.includes(symbol)" :aria-label="tr('使用符号 {0}', { 0: symbol })" @change="toggleExcludedSymbol(symbol)" />
              <span>{{ symbol }}</span>
            </label>
          </div>
          <label v-else class="field field-wide"><span>{{ tr('自定义符号集') }}</span><input v-model="password.customSymbols" :aria-label="tr('自定义符号集')" maxlength="256" /></label>
        </fieldset>
        <fieldset class="generator-options field-wide"><legend>{{ tr('可读性') }}</legend><label><input v-model="password.excludeSimilar" type="checkbox" />{{ tr('排除 0 O l 1 I') }}</label><label><input v-model="password.excludeAmbiguous" type="checkbox" />{{ tr('排除模糊符号') }}</label></fieldset>
      </template>
      <template v-else-if="mode === 'word'">
        <label class="field field-wide"><span>{{ tr('长度：{0}', { 0: words.length }) }}</span><input v-model.number="words.length" type="range" min="4" max="128" :aria-label="tr('单词密码长度')" /></label>
        <fieldset class="generator-options field-wide"><legend>{{ tr('选项') }}</legend><label><input v-model="words.firstLetterUppercase" type="checkbox" />{{ tr('首字母大写') }}</label><label><input v-model="words.includeNumbers" type="checkbox" />{{ tr('附加数字') }}</label><label><input v-model="words.separatorCountsTowardsLength" type="checkbox" />{{ tr('分隔符计入长度') }}</label></fieldset>
        <label class="field field-wide"><span>{{ tr('自定义分隔符（可选）') }}</span><input v-model="words.separator" maxlength="8" :aria-label="tr('自定义分隔符')" /></label>
        <label class="field field-wide"><span>{{ tr('分段长度：{0}', { 0: words.segmentLength }) }}</span><input v-model.number="words.segmentLength" type="range" min="0" max="20" :aria-label="tr('分段长度')" /></label>
      </template>
      <template v-else-if="mode === 'pin'"><label class="field field-wide"><span>{{ tr('PIN 长度') }}</span><input v-model.number="pin.length" type="number" min="1" max="128" inputmode="numeric" /></label></template>
      <template v-else-if="mode === 'ssh'">
        <label class="field"><span>{{ tr('算法') }}</span><select v-model="ssh.algorithm" :aria-label="tr('SSH 算法')"><option value="ED25519">Ed25519</option><option value="RSA">RSA</option></select></label>
        <label v-if="ssh.algorithm === 'RSA'" class="field"><span>{{ tr('RSA 位数') }}</span><select v-model.number="ssh.rsaSize" :aria-label="tr('RSA 位数')"><option value="2048">2048</option><option value="3072">3072</option><option value="4096">4096</option></select></label>
      </template>
      <template v-else><label class="field"><span>{{ tr('单词数') }}</span><input v-model.number="phrase.length" type="number" min="1" max="32" /></label><label class="field"><span>{{ tr('分隔符') }}</span><input v-model="phrase.delimiter" maxlength="8" /></label><label class="field field-wide"><span>{{ tr('自定义单词（可选）') }}</span><input v-model="phrase.customWord" /></label><label class="favorite-row"><input v-model="phrase.capitalize" type="checkbox" />{{ tr('首字母大写') }}</label><label class="favorite-row"><input v-model="phrase.includeNumber" type="checkbox" />{{ tr('附加数字') }}</label></template>
      <p v-if="status" class="generator-status field-wide" aria-live="polite">{{ status }}</p>
      <footer class="field-wide"><m3e-button variant="filled" type="submit"><m3e-icon slot="icon" name="refresh"></m3e-icon>{{ tr('重新生成') }}</m3e-button></footer>
    </form>

    <details class="generator-history">
      <summary>
        <span><m3e-icon name="history"></m3e-icon><strong>{{ tr('Android 生成历史') }}</strong></span>
        <span class="generator-history-count">{{ history.length }}</span>
      </summary>
      <div class="generator-history-body">
        <div class="generator-history-toolbar">
          <span>{{ props.providers.filter((provider) => provider.kind === 'monica-webdav' && provider.enabled).length ? tr('来自 Monica Android WebDAV') : tr('尚未连接 Android WebDAV') }}</span>
          <m3e-icon-button :aria-label="tr('刷新 Android 生成历史')" :title="tr('刷新')" :disabled="historyBusy" @click="loadHistory"><m3e-icon name="refresh"></m3e-icon></m3e-icon-button>
        </div>
        <p v-if="historyError" class="form-error" role="alert">{{ historyError }}</p>
        <p v-else-if="historyBusy && !history.length" class="generator-history-empty">{{ tr('正在读取…') }}</p>
        <ul v-else-if="history.length" class="generator-history-list">
          <li v-for="entry in history" :key="`${entry.providerId}:${entry.id}`">
            <div class="generator-history-main">
              <code :aria-label="revealedHistory.has(entry.id) ? tr('已显示生成值') : tr('生成值已隐藏')">{{ revealedHistory.has(entry.id) ? entry.password : '••••••••' }}</code>
              <span>{{ historyTypeLabel(entry.type) }}</span>
            </div>
            <div class="generator-history-meta"><span>{{ historyContext(entry) }}</span><time :datetime="new Date(entry.timestamp).toISOString()">{{ historyTime(entry.timestamp) }}</time><span>{{ entry.providerName }}</span></div>
            <div class="generator-history-actions">
              <m3e-icon-button :aria-label="revealedHistory.has(entry.id) ? tr('隐藏生成值') : tr('显示生成值')" :title="revealedHistory.has(entry.id) ? tr('隐藏') : tr('显示')" @click="toggleHistorySecret(entry.id)"><m3e-icon :name="revealedHistory.has(entry.id) ? 'visibility_off' : 'visibility'"></m3e-icon></m3e-icon-button>
              <button v-if="pendingDelete === entry.id" type="button" class="generator-history-confirm" @click="deleteHistoryEntry(entry)">{{ tr('确认删除') }}</button>
              <m3e-icon-button v-else :aria-label="tr('删除生成历史')" :title="tr('删除')" @click="deleteHistoryEntry(entry)"><m3e-icon name="delete"></m3e-icon></m3e-icon-button>
              <m3e-icon-button v-if="pendingDelete === entry.id" :aria-label="tr('取消删除')" :title="tr('取消')" @click="pendingDelete = ''"><m3e-icon name="close"></m3e-icon></m3e-icon-button>
            </div>
          </li>
        </ul>
        <p v-else class="generator-history-empty">{{ tr('没有可读取的 Android 生成历史') }}</p>
      </div>
    </details>
  </section>
</template>
