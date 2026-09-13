import { computed, ref, watch } from "vue";

/** Keep full-vault search independent of the small set of mounted result rows. */
export function useListPagination(total: () => number, resetKey: () => unknown, pageSize = 50) {
  const page = ref(1);
  const pageCount = computed(() => Math.max(1, Math.ceil(total() / pageSize)));
  const offset = computed(() => (page.value - 1) * pageSize);
  const change = (value: number) => { page.value = Math.min(pageCount.value, Math.max(1, Math.trunc(value) || 1)); };
  watch(resetKey, () => change(1), { flush: "sync" });
  watch(pageCount, () => change(page.value), { flush: "sync" });
  return { page, pageCount, pageSize, change, slice: <T>(items: readonly T[]) => items.slice(offset.value, offset.value + pageSize) };
}
