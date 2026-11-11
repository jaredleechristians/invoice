<script setup lang="ts">
import { formatCurrency, formatDate, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type QuoteRow = { id: string; quoteNumber: string; customerName?: string; issueDateIso: string; expiryDateIso: string; currency: string; total: number; displayStatus: string };

const { activeCompanyId, capi } = useCompanyApi();
const quotes = ref<QuoteRow[]>([]);
const loading = ref(false);
const error = ref("");
const q = ref("");
const status = ref("");

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return quotes.value.filter(
    (x) =>
      (!status.value || x.displayStatus === status.value) &&
      (!needle || x.quoteNumber?.toLowerCase().includes(needle) || x.customerName?.toLowerCase().includes(needle))
  );
});

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  try {
    quotes.value = (await capi<{ quotes: QuoteRow[] }>("/quotes")).quotes;
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Estimates you can send and convert into invoices.">
      <template #filters>
        <UInput v-model="q" placeholder="Search number or customer" class="w-full sm:w-72" icon="i-lucide-search" />
        <div class="w-full sm:w-44">
          <AppSelect v-model="status" placeholder="All statuses" :options="['draft', 'sent', 'accepted', 'declined', 'converted', 'expired'].map((s) => ({ label: statusLabel(s), value: s }))" />
        </div>
      </template>
      <UButton to="/dashboard/quotes/new" icon="i-lucide-plus">New quote</UButton>
    </PageHeader>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UTable
      :data="filtered"
      :columns="[
        { accessorKey: 'quoteNumber', header: 'Number' },
        { accessorKey: 'customerName', header: 'Customer' },
        { accessorKey: 'issueDateIso', header: 'Date' },
        { accessorKey: 'expiryDateIso', header: 'Valid until' },
        { accessorKey: 'total', header: 'Total', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'displayStatus', header: 'Status' },
      ]"
      :loading="loading"
      class="rounded-lg border border-default" :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed', tr: 'cursor-pointer' }"
      @select="(_e, row) => navigateTo(`/dashboard/quotes/${row.original.id}`)"
    >
      <template #quoteNumber-cell="{ row }"><span class="font-medium text-highlighted">{{ row.original.quoteNumber }}</span></template>
      <template #customerName-cell="{ row }"><span class="text-toned">{{ row.original.customerName || "—" }}</span></template>
      <template #issueDateIso-cell="{ row }"><span class="text-muted">{{ formatDate(row.original.issueDateIso) }}</span></template>
      <template #expiryDateIso-cell="{ row }"><span class="text-muted">{{ formatDate(row.original.expiryDateIso) }}</span></template>
      <template #total-cell="{ row }"><span class="tabular-nums">{{ formatCurrency(row.original.total, row.original.currency) }}</span></template>
      <template #displayStatus-cell="{ row }"><UBadge :color="STATUS_COLORS[row.original.displayStatus] || 'neutral'" variant="subtle">{{ statusLabel(row.original.displayStatus) }}</UBadge></template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No quotes yet.</p></template>
    </UTable>
  </div>
</template>
