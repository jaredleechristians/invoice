<script setup lang="ts">
/**
 * Thin wrapper around Nuxt UI's USelectMenu.
 * - Supports "" as a real value (e.g. "All", "Any", "none") via a sentinel item,
 *   which USelect/USelectMenu cannot represent directly.
 * - Shows a search box for long lists (or when `searchable` is set).
 */
type Option = { label: string; value: string | number; description?: string; disabled?: boolean };
const props = withDefaults(
  defineProps<{
    options: Option[];
    placeholder?: string;
    disabled?: boolean;
    searchable?: boolean;
    icon?: string;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
  }>(),
  { placeholder: undefined, searchable: undefined, icon: undefined, size: "md" }
);
const model = defineModel<string | number>({ default: "" });

const NONE = "__none__";
type Item = { label: string; value: string; raw: string | number; description?: string; disabled?: boolean; class?: string };

const items = computed<Item[]>(() => [
  ...(props.placeholder !== undefined ? [{ label: props.placeholder, value: NONE, raw: "", class: "text-muted" }] : []),
  ...props.options.map((o) => ({ ...o, value: String(o.value), raw: o.value })),
]);

const inner = computed<string | undefined>({
  get() {
    if (model.value === "" || model.value == null) return props.placeholder !== undefined ? NONE : undefined;
    return String(model.value);
  },
  set(v) {
    if (v == null || v === NONE) model.value = "";
    else model.value = items.value.find((i) => i.value === v)?.raw ?? v;
  },
});

const showSearch = computed(() => props.searchable ?? props.options.length > 7);
</script>

<template>
  <USelectMenu
    v-model="inner"
    :items="items"
    value-key="value"
    label-key="label"
    :icon="icon"
    :size="size"
    :placeholder="placeholder"
    :disabled="disabled"
    :search-input="showSearch ? { placeholder: 'Search…', icon: 'i-lucide-search' } : false"
    class="w-full"
  />
</template>
