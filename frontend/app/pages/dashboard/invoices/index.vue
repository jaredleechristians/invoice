<script setup lang="ts">
import { formatCurrency, formatDate, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  customerName?: string;
  issueDateIso?: string;
  dueDateIso?: string;
  dueDate?: string;
  currency: string;
  total: number;
  outstanding: number;
  status: string;
};

const route = useRoute();
const { activeCompanyId, capi } = useCompanyApi();

const invoices = ref<InvoiceRow[]>([]);
const loading = ref(false);
const error = ref("");
const q = ref("");
const status = ref(typeof route.query.status === "string" ? route.query.status : "");
const currency = ref("");

const STATUS_OPTIONS = ["draft", "unpaid", "partially_paid", "overdue", "paid", "void"].map((s) => ({ label: statusLabel(s), value: s }));

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return invoices.value.filter(
    (i) =>
      (!status.value || i.status === status.value || (status.value === "open" && i.outstanding > 0)) &&
      (!currency.value || i.currency === currency.value) &&
      (!needle || i.invoiceNumber?.toLowerCase().includes(needle) || i.customerName?.toLowerCase().includes(needle))
  );
});

const currencies = computed(() => [...new Set(invoices.value.map((i) => i.currency))].sort());

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    invoices.value = (await capi<{ invoices: InvoiceRow[] }>("/invoices")).invoices;
  } catch (e) {
    error.value = errMsg(e, "Failed to load invoices");
  } finally {
    loading.value = false;
  }
}

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Drafts get a number when you finalize them.">
      <template #filters>
        <UInput v-model="q" placeholder="Search number or customer" class="min-w-56" icon="i-lucide-search" />
        <div class="w-44"><AppSelect v-model="status" placeholder="All statuses" :options="[{ label: statusLabel('open'), value: 'open' }, ...STATUS_OPTIONS]" /></div>
        <div class="w-32"><AppSelect v-model="currency" placeholder="All currencies" :options="currencies.map((c) => ({ label: c, value: c }))" /></div>
      </template>
      <UButton to="/dashboard/invoices/new" icon="i-lucide-plus">New invoice</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UTable
      :data="filtered"
      :columns="[
        { accessorKey: 'invoiceNumber', header: 'Number' },
        { accessorKey: 'customerName', header: 'Customer' },
        { accessorKey: 'issueDateIso', header: 'Issued' },
        { accessorKey: 'dueDateIso', header: 'Due' },
        { accessorKey: 'total', header: 'Total', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'outstanding', header: 'Outstanding', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'status', header: 'Status' },
      ]"
      :loading="loading"
      class="rounded-lg border border-default" :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed', tr: 'cursor-pointer' }"
      @select="(_e, row) => navigateTo(`/dashboard/invoices/${row.original.id}`)"
    >
      <template #invoiceNumber-cell="{ row }"><span class="font-medium text-highlighted">{{ row.original.invoiceNumber || "Draft" }}</span></template>
      <template #customerName-cell="{ row }"><span class="text-toned">{{ row.original.customerName || "—" }}</span></template>
      <template #issueDateIso-cell="{ row }"><span class="text-muted">{{ formatDate(row.original.issueDateIso) }}</span></template>
      <template #dueDateIso-cell="{ row }"><span class="text-muted">{{ row.original.dueDateIso ? formatDate(row.original.dueDateIso) : row.original.dueDate || "—" }}</span></template>
      <template #total-cell="{ row }"><span class="tabular-nums">{{ formatCurrency(row.original.total, row.original.currency) }}</span></template>
      <template #outstanding-cell="{ row }"><span class="tabular-nums">{{ row.original.outstanding > 0 ? formatCurrency(row.original.outstanding, row.original.currency) : "—" }}</span></template>
      <template #status-cell="{ row }"><UBadge :color="STATUS_COLORS[row.original.status] || 'neutral'" variant="subtle">{{ statusLabel(row.original.status) }}</UBadge></template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">{{ invoices.length ? "No invoices match these filters." : "No invoices yet." }}</p></template>
    </UTable>
  </div>
</template>
