<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { tr } from "../i18n";
import { MIN_MASTER_PASSWORD_LENGTH } from "../security/master-password-policy";
import { vaultClient } from "../runtime/client";
import { MDBX2_MAX_INBOUND_FILE_BYTES, MDBX3_RUNTIME_NAME, type Mdbx2UnlockMethod, type Mdbx2VaultCredential, type Mdbx2VaultInspection } from "../providers/mdbx2/native-contract";
import { advertisedUnlockMethods, resolveImportUnlockMethod, sniffMdbxImportBlob, type MdbxImportSniff } from "../providers/mdbx2/mdbx-import-detect";
import { mdbxImportUserMessage } from "../providers/mdbx2/mdbx-import-coordinator";
import { bytesToBase64 } from "../security/encoding";
import type { VaultItem } from "../core/model";

const emit = defineEmits<{
  completed: [items: VaultItem[], protection: "master-password" | "device-key"];
}>();

const file = shallowRef<File>();
const securityKeyFile = shallowRef<File>();
const sniff = ref<MdbxImportSniff>();
const inspection = ref<Mdbx2VaultInspection>();
const sourceHandle = ref("");
const operationId = ref("");
const vaultPassword = ref("");
const pluginPassword = ref("");
const pluginConfirmation = ref("");
const busy = ref<"upload" | "prepare" | "commit" | "">("");
const error = ref("");
const pluginOrphan = ref(false);

const isKdbx = computed(() => sniff.value?.kind === "kdbx");
const isMdbx = computed(() => sniff.value?.kind === "mdbx-vault" || sniff.value?.kind === "mdbx-complete-backup-zip");
const canUnlock = computed(() => Boolean((isMdbx.value || isKdbx.value) && sniff.value && !sniff.value.incompatibilityReason));
const selectedUnlock = ref<Mdbx2UnlockMethod>("password");
const unlockChoices = computed(() => advertisedUnlockMethods(sniff.value?.unlockMethods || []));
const unlockMethod = computed(() => resolveImportUnlockMethod(sniff.value?.unlockMethods || [], selectedUnlock.value));
const needsPassword = computed(() => isKdbx.value ? Boolean(sniff.value?.needsPasswordPrompt) : unlockMethod.value !== "security-key");
const needsSecurityKey = computed(() => !isKdbx.value && unlockMethod.value !== "password");

watch(unlockChoices, (choices) => {
  if (choices.length && !choices.includes(selectedUnlock.value)) selectedUnlock.value = choices[0];
  if (!choices.length) selectedUnlock.value = "password";
});

onBeforeUnmount(() => {
  vaultPassword.value = "";
  pluginPassword.value = "";
  pluginConfirmation.value = "";
  if (operationId.value) void vaultClient.cancelMdbx2Import(operationId.value).catch(() => undefined);
});

async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const chosen = input.files?.[0];
  input.value = "";
  error.value = "";
  sniff.value = undefined;
  inspection.value = undefined;
  pluginOrphan.value = false;
  if (operationId.value) await vaultClient.cancelMdbx2Import(operationId.value).catch(() => undefined);
  operationId.value = "";
  sourceHandle.value = "";
  file.value = chosen;
  if (!chosen) return;
  if (!chosen.size || chosen.size > MDBX2_MAX_INBOUND_FILE_BYTES) {
    error.value = tr("MDBX2 文件为空或超过 2 GiB 安全上限。");
    file.value = undefined;
    return;
  }
  const detected = await sniffMdbxImportBlob(chosen);
  sniff.value = detected;
  if (detected.kind === "plugin-backup-json") {
    error.value = tr("恢复插件状态（条目与密码源配置）。独立 MDBX 数据库需要单独的 MDBX 备份。");
    return;
  }
  if (detected.incompatibilityReason) {
    error.value = tr(mdbxImportUserMessage(detected.incompatibilityReason) || "无法识别此文件。");
    if (detected.kind === "android-project-zip") error.value += " " + tr("已初始化后可在导入与导出中作为条目导入。");
  }
}

function pluginProtectionError(): string {
  if (pluginPassword.value && pluginPassword.value.length < MIN_MASTER_PASSWORD_LENGTH) {
    return tr("主密码至少需要 {0} 个字符。", { 0: MIN_MASTER_PASSWORD_LENGTH });
  }
  if (pluginPassword.value !== pluginConfirmation.value) return tr("两次输入的主密码不一致。");
  return "";
}

async function importVault() {
  if (!file.value || !canUnlock.value || busy.value) return;
  error.value = "";
  if (isKdbx.value) return importKdbx();
  const protectionError = pluginProtectionError();
  if (protectionError) {
    error.value = protectionError;
    return;
  }
  try {
    if (!sourceHandle.value) {
      busy.value = "upload";
      sourceHandle.value = await stageFile(file.value);
    }
    const source = { kind: "file" as const, handle: sourceHandle.value };
    busy.value = "upload";
    const detected = await vaultClient.detectMdbx2Import(source, sniff.value?.kind === "mdbx-complete-backup-zip" ? "mdbx-complete-backup-zip" : "mdbx-vault");
    sniff.value = detected.sniff;
    inspection.value = detected.inspection;
    if (detected.sniff.incompatibilityReason) throw new Error(mdbxImportUserMessage(detected.sniff.incompatibilityReason) || "无法识别此文件。");
    selectedUnlock.value = resolveImportUnlockMethod(detected.sniff.unlockMethods, selectedUnlock.value);
    if (unlockMethod.value !== "password" && !securityKeyFile.value) {
      error.value = tr("所选解锁方式需要安全密钥文件。");
      return;
    }
    const credential = await buildCredential();
    if (!operationId.value) operationId.value = crypto.randomUUID();
    busy.value = "prepare";
    await vaultClient.prepareMdbx2Import({
      operationId: operationId.value,
      source,
      credential,
      name: file.value.name.replace(/(?:\.mdbx-backup\.zip|\.mdbx|\.zip)$/i, "") || "Monica MDBX",
      kind: detected.sniff.kind === "mdbx-complete-backup-zip" ? "mdbx-complete-backup-zip" : "mdbx-vault"
    });
    busy.value = "commit";
    const committed = await vaultClient.commitMdbx2Import({
      operationId: operationId.value,
      name: file.value.name.replace(/(?:\.mdbx-backup\.zip|\.mdbx|\.zip)$/i, "") || "Monica MDBX",
      pluginMasterPassword: pluginPassword.value
    });
    if (committed.operation.stage !== "completed" && committed.operation.stage !== "syncing" && committed.operation.stage !== "registered") {
      throw new Error(committed.operation.lastError?.message || "MDBX 导入失败。");
    }
    const items = committed.items?.length ? committed.items : await vaultClient.listItems();
    if (committed.operation.stage !== "completed" && committed.operation.lastError && !items.length) {
      error.value = tr(mdbxImportUserMessage(committed.operation.lastError.code) || committed.operation.lastError.message);
      return;
    }
    operationId.value = "";
    emit("completed", items, pluginPassword.value ? "master-password" : "device-key");
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: string }).code || "") : "";
    if (code === "mdbx-import-setup-orphan") pluginOrphan.value = true;
    if (sourceHandle.value && (busy.value === "commit" || code === "vault-source-not-found")) {
      await vaultClient.releaseMdbx2File(sourceHandle.value).catch(() => undefined);
      sourceHandle.value = "";
    }
    error.value = tr(mdbxImportUserMessage(code) || (cause instanceof Error ? cause.message : "MDBX 导入失败。"));
  } finally {
    busy.value = "";
    vaultPassword.value = "";
  }
}

async function importKdbx() {
  if (!file.value || busy.value) return;
  error.value = "";
  const protectionError = pluginProtectionError();
  if (protectionError) {
    error.value = protectionError;
    return;
  }
  if (file.value.size > 64 * 1024 * 1024) {
    error.value = tr("文件为空或超过 64 MB。");
    return;
  }
  try {
    busy.value = "prepare";
    const bytes = new Uint8Array(await file.value.arrayBuffer());
    const keyFile = securityKeyFile.value ? new Uint8Array(await securityKeyFile.value.arrayBuffer()) : undefined;
    if (keyFile && keyFile.length > 1024 * 1024) throw new Error("密钥文件超过 1 MB。");
    busy.value = "commit";
    const password = String(pluginPassword.value || "");
    const databasePassword = String(vaultPassword.value || "");
    let pluginCreated = false;
    if (await vaultClient.status() === "uninitialized") {
      await vaultClient.setup(password);
      pluginCreated = true;
    } else {
      await vaultClient.unlock(password);
    }
    let opened: { account: { id: string } };
    try {
      opened = await vaultClient.openKeePass({
          name: file.value.name.replace(/\.kdbx$/i, "") || "KeePass",
          fileName: file.value.name,
          file: bytesToBase64(bytes),
          password: databasePassword,
          ...(keyFile ? { keyFile: bytesToBase64(keyFile) } : {}),
          isDefaultSaveTarget: true
      });
    } catch (cause) {
      if (pluginCreated) pluginOrphan.value = true;
      throw cause;
    }
    try {
      await vaultClient.syncProvider(opened.account.id);
    } catch {
      // KeePass is already attached; listing still finishes first-run.
    }
    emit("completed", await vaultClient.listItems(), password ? "master-password" : "device-key");
  } catch (cause) {
    error.value = tr(cause instanceof Error ? cause.message : "KeePass 数据库导入失败。");
  } finally {
    busy.value = "";
    vaultPassword.value = "";
  }
}

async function stageFile(chosen: File): Promise<string> {
  const transfer = await vaultClient.beginMdbx2Transfer(chosen.size);
  try {
    let offset = transfer.nextOffset;
    while (offset < chosen.size) {
      const bytes = new Uint8Array(await chosen.slice(offset, Math.min(chosen.size, offset + transfer.maxChunkBytes)).arrayBuffer());
      offset = (await vaultClient.sendMdbx2Chunk(transfer.transferId, offset, bytes)).nextOffset;
    }
    return (await vaultClient.finishMdbx2Transfer(transfer.transferId)).fileHandle;
  } catch (cause) {
    await vaultClient.abortMdbx2Transfer(transfer.transferId).catch(() => undefined);
    throw cause;
  }
}

async function buildCredential(): Promise<Mdbx2VaultCredential> {
  const method = unlockMethod.value;
  if (method === "password-security-key") {
    return { method, password: vaultPassword.value, keyMaterialBase64: await readKey() };
  }
  if (method === "security-key") return { method, keyMaterialBase64: await readKey() };
  return { method: "password", password: vaultPassword.value };
}

async function readKey(): Promise<string> {
  const key = securityKeyFile.value;
  if (!key) throw new Error(mdbxImportUserMessage("vault-unlock-not-portable"));
  if (key.size > 64 * 1024) throw new Error("安全密钥文件超过 64 KiB。");
  return bytesToBase64(new Uint8Array(await key.arrayBuffer()));
}
</script>

<template>
  <div class="mdbx-first-import stack">
    <p class="supporting">{{ isKdbx ? tr("将把 KeePass KDBX 作为密码源接入。原始文件不会被修改。") : tr("将在独立工作副本上升级为 MDBX-2。原始文件不会被修改。") }}</p>
    <p class="supporting">{{ tr("主密码可选，也可使用设备密钥。此选项只保护插件，不用于解锁所选密码库。") }}</p>
    <label class="file-action"><m3e-icon name="upload" aria-hidden="true"></m3e-icon><span>{{ file?.name || tr("选择 MDBX、KDBX 或完整备份 ZIP") }}</span><input type="file" accept=".mdbx,.kdbx,.zip,application/octet-stream,application/zip" :aria-label="tr('打开已有的密码库')" @change="selectFile" /></label>
    <div v-if="isKdbx" class="mdbx2-inspection" role="status">
      <span><strong>KDBX</strong><small>{{ tr("文件格式") }}</small></span>
      <span><strong>KeePass</strong><small>{{ tr("运行时") }}</small></span>
      <span><strong>{{ tr("当前版本") }}</strong><small>{{ tr("打开前检查") }}</small></span>
    </div>
    <div v-else-if="inspection || sniff?.formatVersion" class="mdbx2-inspection" role="status">
      <span><strong>{{ inspection?.formatVersion || sniff?.formatVersion }}</strong><small>{{ tr("文件格式") }}</small></span>
      <span><strong>{{ MDBX3_RUNTIME_NAME }}</strong><small>{{ tr("运行时") }}</small></span>
      <span><strong>{{ (inspection?.requiresUpgrade || sniff?.requiresMigration) ? tr("需要迁移") : tr("当前版本") }}</strong><small>{{ tr("打开前检查") }}</small></span>
    </div>
    <p v-if="inspection?.requiresUpgrade || sniff?.requiresMigration" class="settings-safety-note">{{ tr("将在独立工作副本上升级为 MDBX-2。原始文件不会被修改。") }}</p>
    <template v-if="canUnlock">
      <div v-if="!isKdbx && unlockChoices.length > 1" class="auth-action-picker" role="radiogroup" :aria-label="tr('解锁方式')">
        <button v-for="method in unlockChoices" :key="method" type="button" role="radio" :aria-checked="selectedUnlock === method" :class="{ selected: selectedUnlock === method }" @click="selectedUnlock = method">{{ method === "password" ? tr("密码") : method === "security-key" ? tr("安全密钥") : tr("密码 + 安全密钥") }}</button>
      </div>
      <m3e-form-field v-if="needsPassword" v-field-label variant="outlined" hide-required-marker class="field auth-password-field"><label slot="label">{{ isKdbx ? tr("数据库密码（可留空）") : tr("MDBX 密码") }}</label><input v-model="vaultPassword" type="password" autocomplete="off" :aria-label="isKdbx ? tr('数据库密码（可留空）') : tr('MDBX 密码')" @keydown.enter.prevent="importVault" /></m3e-form-field>
      <label v-if="needsSecurityKey || isKdbx" class="file-action"><m3e-icon name="key"></m3e-icon><span>{{ securityKeyFile?.name || (isKdbx ? tr("选择密钥文件（可选）") : tr("选择最大 64 KiB 的安全密钥文件")) }}</span><input type="file" :aria-label="isKdbx ? tr('选择密钥文件（可选）') : tr('MDBX2 安全密钥文件')" @change="securityKeyFile = ($event.target as HTMLInputElement).files?.[0] || undefined" /></label>
      <m3e-form-field v-field-label variant="outlined" hide-required-marker class="field auth-password-field"><label slot="label">{{ tr("插件主密码（可选）") }}</label><input v-model="pluginPassword" type="password" autocomplete="new-password" :aria-label="tr('插件主密码（可选）')" @keydown.enter.prevent="importVault" /></m3e-form-field>
      <m3e-form-field v-field-label variant="outlined" hide-required-marker class="field auth-password-field"><label slot="label">{{ tr("确认主密码") }}</label><input v-model="pluginConfirmation" type="password" autocomplete="new-password" :aria-label="tr('确认主密码')" @keydown.enter.prevent="importVault" /></m3e-form-field>
      <p class="settings-safety-note">{{ pluginPassword ? tr("主密码保护：每次解锁需要主密码。请保存独立加密备份，忘记密码后无法直接找回。") : tr("设备密钥保护：依赖当前浏览器与操作系统，使用此浏览器配置的人可解锁。创建后可绑定 Windows Hello；请保存独立加密备份以便迁移或恢复。") }}</p>
      <m3e-button variant="filled" type="button" :disabled="Boolean(busy)" @click="importVault">{{ busy ? tr("处理中…") : tr("打开并接入密码库") }}</m3e-button>
    </template>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="pluginOrphan" class="form-error" role="alert">{{ tr("插件密码库已创建，所选密码库尚未接入。可在导入与导出中重试。") }}</p>
  </div>
</template>
