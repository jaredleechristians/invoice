<script setup lang="ts">
// Native <select>: supports empty-string values (Nuxt UI's USelect does not).
type Option = { label: string; value: string | number };
const props = defineProps<{ options: Option[]; placeholder?: string; disabled?: boolean }>();
const model = defineModel<string | number>({ default: "" });
void props;
</script>

<template>
  <select
    v-model="model"
    :disabled="disabled"
    class="w-full rounded-md bg-neutral-900 border border-neutral-700 px-2.5 py-1.5 text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-60"
  >
    <option v-if="placeholder !== undefined" value="">{{ placeholder }}</option>
    <option v-for="o in options" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
  </select>
</template>
