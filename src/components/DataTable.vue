<script setup lang="ts">
import { computed } from "vue";
import type { TableColumn, TableRow } from "../lib/modules";
import { stateClass, stateLabel } from "../lib/modules";
import { t } from "../i18n";

const props = defineProps<{
  columns: TableColumn[];
  rows: TableRow[];
}>();

const hasStatus = computed(() => props.rows.some((row) => row.state));
</script>

<template>
  <div class="table-wrap">
    <table v-if="rows.length">
      <thead>
        <tr>
          <th>{{ t("columns.item") }}</th>
          <th v-for="column in columns" :key="column.key">{{ t(column.labelKey) }}</th>
          <th v-if="hasStatus">{{ t("columns.status") }}</th>
          <th></th>
        </tr>
      </thead>
      <TransitionGroup name="row-motion" tag="tbody">
        <tr v-for="row in rows" :key="row.id">
          <td class="item-cell" :data-label="t('columns.item')">
            <div class="row-title">
              <m3e-icon :name="row.icon"></m3e-icon>
              <div>
                <strong>{{ row.title }}</strong>
                <small v-if="row.subtitle">{{ row.subtitle }}</small>
              </div>
            </div>
          </td>
          <td v-for="column in columns" :key="column.key" :data-label="t(column.labelKey)">
            {{ row.cells[column.key] ?? "-" }}
          </td>
          <td v-if="hasStatus" :data-label="t('columns.status')" :class="{ 'empty-status': !row.state }">
            <span v-if="row.state" :class="stateClass(row.state)">{{ stateLabel(row.state) }}</span>
          </td>
          <td class="action-cell">
            <m3e-icon-button :aria-label="t('common.more')"><m3e-icon name="more_vert"></m3e-icon></m3e-icon-button>
          </td>
        </tr>
      </TransitionGroup>
    </table>
    <div v-else class="empty">{{ t("common.empty") }}</div>
  </div>
</template>
