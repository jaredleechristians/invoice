<script setup lang="ts">
import { formatCurrency, formatDate, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Row = {
  id: string;
  creditNoteNumber?: string;
  invoiceId: string;
  invoiceNumber?: string;
  customerName?: string;
  issueDateIso?: string;
  currency: string;
  total: number;
  status: string;
};

const { activeCompanyId, capi } = useCompanyApi();
const rows = ref<Row[]>([]);
const loading = ref(false);
const error = ref("");
const q = ref("");
const status = ref("");

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return rows.value.filter(
    (n) =>
      (!status.value || n.status === status.value) &&
      (!needle ||
        n.creditNoteNumber?.toLowerCase().includes(needle) ||
        n.invoiceNumber?.toLowerCase().includes(needle) ||
        n.customerName?.toLowerCase().includes(needle))
  );
});

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    rows.value = (await capi<{ creditNotes: Row[] }>("/credit-notes")).creditNotes;
  } catch (e) {
    error.value = errMsg(e, "Failed to load credit notes");
  } finally {
    loading.value = false;
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Credit notes reduce what a customer owes on one invoice and post a reversal to the ledger.">
      <template #filters>
        <UInput v-model="q" placeholder="Search number or customer" class="w-full sm:w-72" icon="i-lucide-search" />
        <div class="w-full sm:w-44">
          <AppSelect v-model="status" placeholder="All statuses" :options="['draft', 'issued', 'void'].map((s) => ({ label: statusLabel(s), value: s }))" />
        </div>
      </template>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UTable
      :data="filtered"
      :columns="[
        { accessorKey: 'creditNoteNumber', header: 'Number' },
        { accessorKey: 'invoiceNumber', header: 'Invoice' },
        { accessorKey: 'customerName', header: 'Customer' },
        { accessorKey: 'issueDateIso', header: 'Issued' },
        { accessorKey: 'total', header: 'Total', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'status', header: 'Status' },
      ]"
      :loading="loading"
      class="rounded-lg border border-default"
      :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #creditNoteNumber-cell="{ row }">
        <NuxtLink :to="`/dashboard/credit-notes/${row.original.id}`" class="font-medium text-highlighted hover:underline">{{ row.original.creditNoteNumber || "Draft" }}</NuxtLink>
      </template>
      <template #invoiceNumber-cell="{ row }">
        <NuxtLink v-if="row.original.invoiceId" :to="`/dashboard/invoices/${row.original.invoiceId}`" class="hover:underline">{{ row.original.invoiceNumber || "Invoice" }}</NuxtLink>
      </template>
      <template #issueDateIso-cell="{ row }">{{ formatDate(row.original.issueDateIso) }}</template>
      <template #total-cell="{ row }"><span class="tabular-nums">{{ formatCurrency(row.original.total, row.original.currency) }}</span></template>
      <template #status-cell="{ row }"><UBadge :color="STATUS_COLORS[row.original.status] || 'neutral'" variant="subtle">{{ statusLabel(row.original.status) }}</UBadge></template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No credit notes yet. Issue one from a published invoice.</p></template>
    </UTable>
  </div>
</template>
