<script setup lang="ts" generic="T extends { description: string; note: string; qty: number; unitPrice: number; taxable?: boolean }">
import { docTotals, formatCurrency, lineTotal } from "~/utils/money";

/**
 * Line items card shared by the signed-in invoice/quote form (DocumentForm)
 * and the signed-out editor: column headers on desktop, per-field labels on
 * mobile, right-aligned numbers, a fixed actions column and the totals block.
 * Extra per-line controls (product picker, VAT checkbox) go in #line-extra.
 */
const props = withDefaults(defineProps<{ currency?: string; vatRate?: number; newLine: () => T }>(), {
  currency: "ZAR",
  vatRate: 0,
});
const items = defineModel<T[]>({ required: true });
defineSlots<{ "line-extra"?: (props: { line: T; index: number }) => unknown }>();

const totals = computed(() => docTotals(items.value, props.vatRate));
// Line fields show their own label on mobile; desktop uses the header row.
const LINE_FIELD_UI = { labelWrapper: "sm:hidden" };
const GRID = "sm:grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_8.5rem_5.5rem]";

function move(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= items.value.length) return;
  const [row] = items.value.splice(i, 1);
  items.value.splice(j, 0, row!);
}
</script>

<template>
  <UCard>
    <template #header><span class="font-medium">Line items</span></template>
    <div class="space-y-3">
      <div
        class="hidden sm:grid gap-3 border-b border-default pb-2 text-xs font-medium uppercase tracking-wide text-dimmed"
        :class="GRID"
      >
        <span>Item / description</span>
        <span class="text-right">Qty</span>
        <span class="text-right">Price ({{ currency }})</span>
        <span class="text-right">Amount</span>
        <span class="sr-only">Actions</span>
      </div>

      <div
        v-for="(line, i) in items"
        :key="i"
        class="grid grid-cols-2 gap-x-3 gap-y-2 items-start border-b border-default pb-3 last:border-b-0"
        :class="GRID"
      >
        <UFormField label="Item / description" class="col-span-2 sm:col-span-1" :ui="LINE_FIELD_UI">
          <div class="space-y-2">
            <UInput v-model="line.description" placeholder="Description" aria-label="Description" class="w-full" />
            <UTextarea v-model="line.note" :rows="1" autoresize placeholder="Details (optional)" aria-label="Details" class="w-full" />
            <slot name="line-extra" :line="line" :index="i" />
          </div>
        </UFormField>
        <UFormField label="Qty" :ui="LINE_FIELD_UI">
          <UInput v-model.number="line.qty" type="number" step="any" aria-label="Quantity" class="w-full" :ui="{ base: 'text-right tabular-nums' }" />
        </UFormField>
        <UFormField :label="`Price (${currency})`" :ui="LINE_FIELD_UI">
          <UInput v-model.number="line.unitPrice" type="number" step="0.01" aria-label="Unit price" class="w-full" :ui="{ base: 'text-right tabular-nums' }" />
        </UFormField>
        <UFormField label="Amount" :ui="LINE_FIELD_UI">
          <p class="flex h-8 items-center justify-end tabular-nums font-medium">{{ formatCurrency(lineTotal(line), currency) }}</p>
        </UFormField>
        <div class="flex h-8 items-center justify-end gap-0.5 self-end sm:self-start">
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-up" aria-label="Move up" :disabled="i === 0" @click="move(i, -1)" />
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-arrow-down" aria-label="Move down" :disabled="i === items.length - 1" @click="move(i, 1)" />
          <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Remove line" @click="items.splice(i, 1)" />
        </div>
      </div>
      <UButton size="sm" variant="soft" icon="i-lucide-plus" @click="items.push(newLine())">Add line</UButton>
    </div>

    <div class="flex justify-end mt-6">
      <div class="w-72 space-y-1 text-sm">
        <div v-if="vatRate > 0" class="flex justify-between"><span>Subtotal</span><span class="tabular-nums">{{ formatCurrency(totals.subtotal, currency) }}</span></div>
        <div v-if="vatRate > 0" class="flex justify-between"><span>VAT ({{ vatRate }}%)</span><span class="tabular-nums">{{ formatCurrency(totals.taxTotal, currency) }}</span></div>
        <div class="flex justify-between text-lg font-semibold pt-1"><span>Total</span><span class="tabular-nums">{{ formatCurrency(totals.total, currency) }}</span></div>
      </div>
    </div>
  </UCard>
</template>
