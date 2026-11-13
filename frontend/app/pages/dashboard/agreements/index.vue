<script setup lang="ts">
import { formatCurrency, formatDate, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Row = {
  id: string;
  name: string;
  status: string;
  customerId: string;
  customerName?: string;
  startDate: string;
  endDate?: string;
  period: string;
  hours: number;
  fee: number;
  currency: string;
  autoPublish: boolean;
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
    (a) =>
      (!status.value || a.status === status.value) &&
      (!needle || a.name.toLowerCase().includes(needle) || (a.customerName || "").toLowerCase().includes(needle))
  );
});

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    rows.value = (await capi<{ agreements: Row[] }>("/agreements")).agreements;
  } catch (e) {
    error.value = errMsg(e, "Failed to load agreements");
  } finally {
    loading.value = false;
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="An agreement is a retainer: a customer, a billable service, included hours and a period fee. Recurring invoices are created at the start of each calendar period.">
      <template #filters>
        <UInput v-model="q" placeholder="Search name or customer" class="w-full sm:w-72" icon="i-lucide-search" />
        <div class="w-full sm:w-44">
          <AppSelect v-model="status" placeholder="All statuses" :options="['draft', 'active', 'paused', 'ended'].map((s) => ({ label: statusLabel(s), value: s }))" />
        </div>
      </template>
      <UButton to="/dashboard/agreements/new" icon="i-lucide-plus">New agreement</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UTable
      :data="filtered"
      :columns="[
        { accessorKey: 'name', header: 'Agreement' },
        { accessorKey: 'customerName', header: 'Customer' },
        { accessorKey: 'startDate', header: 'Start' },
        { accessorKey: 'hours', header: 'Hours', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'fee', header: 'Fee', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'status', header: 'Status' },
      ]"
      :loading="loading"
      class="rounded-lg border border-default"
      :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #name-cell="{ row }">
        <NuxtLink :to="`/dashboard/agreements/${row.original.id}`" class="font-medium text-highlighted hover:underline">{{ row.original.name }}</NuxtLink>
      </template>
      <template #startDate-cell="{ row }">{{ formatDate(row.original.startDate) }}</template>
      <template #hours-cell="{ row }"><span class="tabular-nums">{{ row.original.hours }}</span></template>
      <template #fee-cell="{ row }"><span class="tabular-nums">{{ formatCurrency(row.original.fee, row.original.currency) }}</span></template>
      <template #status-cell="{ row }"><UBadge :color="STATUS_COLORS[row.original.status] || 'neutral'" variant="subtle">{{ statusLabel(row.original.status) }}</UBadge></template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No agreements yet. Set one up for a customer retainer.</p></template>
    </UTable>
  </div>
</template>
