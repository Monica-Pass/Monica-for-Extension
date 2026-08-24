<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { generatePassphrase, generatePassword, generatePin, passwordStrengthBits } from "../core/credential-generator";
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

generate();
onMounted(loadHistory);
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
