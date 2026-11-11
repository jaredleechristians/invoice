<script setup lang="ts">
import { formatCurrency } from "~/utils/money";

const props = withDefaults(defineProps<{ value?: Record<string, number> | null; empty?: string; size?: "lg" | "sm" }>(), {
  value: null,
  empty: "—",
  size: "lg",
});
const entries = computed(() =>
  Object.entries(props.value || {})
    .filter(([, v]) => Math.abs(Number(v)) > 0.0001)
    .sort(([a], [b]) => a.localeCompare(b))
);
</script>

<template>
  <div>
    <template v-if="entries.length">
      <p
        v-for="[cur, amount] in entries"
        :key="cur"
        class="tabular-nums font-semibold"
        :class="size === 'lg' ? 'text-2xl' : 'text-sm'"
      >
        {{ formatCurrency(amount, cur) }}
      </p>
    </template>
    <p v-else class="text-neutral-500" :class="size === 'lg' ? 'text-2xl' : 'text-sm'">{{ empty }}</p>
  </div>
</template>
