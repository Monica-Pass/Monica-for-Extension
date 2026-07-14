<script setup lang="ts">
import type { AttachmentRecord, VaultEntry, VaultProject } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { kindLabel, projectIcon, stateLabel } from "../lib/modules";
import { locale, t } from "../i18n";
import type { MessageKey } from "../i18n";

defineProps<{
  project: VaultProject;
  entries: VaultEntry[];
  attachments: AttachmentRecord[];
}>();

function entryIcon(type: VaultEntry["type"]) {
  if (type === "note") return "notes";
  if (type === "totp") return "qr_code_2";
  if (type === "ssh-key") return "terminal";
  if (type === "passkey") return "fingerprint";
  return "key";
}

function dateTime(value: string) {
  return formatDateTime(value, locale.value);
}

function modeLabel(mode: VaultProject["tigaMode"]) {
  return t(`modes.${mode}` as MessageKey);
}
</script>

<template>
  <m3e-card variant="filled" class="detail-card">
    <div slot="content" class="stack">
      <div class="row-title">
        <m3e-icon :name="projectIcon(project.kind)"></m3e-icon>
        <div>
          <h2>{{ project.title }}</h2>
          <small>{{ project.subtitle }}</small>
        </div>
      </div>
      <m3e-chip-set>
        <m3e-chip>{{ kindLabel(project.kind) }}</m3e-chip>
        <m3e-chip>{{ modeLabel(project.tigaMode) }}</m3e-chip>
        <m3e-chip>{{ stateLabel(project.syncStatus) }}</m3e-chip>
        <m3e-chip v-for="tag in project.tags" :key="tag">{{ tag }}</m3e-chip>
      </m3e-chip-set>
      <dl class="detail-grid">
        <div><dt>{{ t("detail.vault") }}</dt><dd>{{ project.vaultId }}</dd></div>
        <div><dt>{{ t("detail.folder") }}</dt><dd>{{ project.folderId ?? "-" }}</dd></div>
        <div><dt>{{ t("detail.entries") }}</dt><dd>{{ entries.length }}</dd></div>
        <div><dt>{{ t("detail.files") }}</dt><dd>{{ attachments.length }}</dd></div>
        <div><dt>{{ t("detail.customFields") }}</dt><dd>{{ project.customFieldCount }}</dd></div>
        <div><dt>{{ t("detail.updated") }}</dt><dd>{{ dateTime(project.updatedAt) }}</dd></div>
      </dl>
      <div>
        <h3>{{ t("detail.entries") }}</h3>
        <div v-for="entry in entries" :key="entry.id" class="mini-row">
          <m3e-icon :name="entryIcon(entry.type)"></m3e-icon>
          <span>{{ entry.label }}</span>
          <small>{{ entry.valuePreview }}</small>
        </div>
      </div>
      <div>
        <h3>{{ t("detail.attachments") }}</h3>
        <div v-for="file in attachments.slice(0, 4)" :key="file.id" class="mini-row">
          <m3e-icon :name="file.isImage ? 'image' : 'attach_file'"></m3e-icon>
          <span>{{ file.fileName }}</span>
          <small>{{ formatBytes(file.sizeBytes) }}</small>
        </div>
      </div>
    </div>
  </m3e-card>
</template>
