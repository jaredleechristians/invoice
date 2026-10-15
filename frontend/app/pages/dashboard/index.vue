<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

const { user } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();

type Receivable = {
  customerId: string;
  customerName: string;
  outstanding: number;
  invoiceCount: number;
};

const stats = ref({
  customers: 0,
  invoices: 0,
  unpaid: 0,
});
const receivables = ref<Receivable[]>([]);
const loading = ref(false);

function formatZar(n: number) {
  return `R ${Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function loadStats() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  try {
    const [customers, invoices, recv] = await Promise.all([
      apiFetch<{ customers: unknown[] }>(`/companies/${activeCompanyId.value}/customers`),
      apiFetch<{ invoices: { status: string }[] }>(
        `/companies/${activeCompanyId.value}/invoices`
      ),
      apiFetch<{ receivables: Receivable[] }>(
        `/companies/${activeCompanyId.value}/receivables`
      ),
    ]);
    stats.value = {
      customers: customers.customers.length,
      invoices: invoices.invoices.length,
      unpaid: invoices.invoices.filter((i) =>
        ["unpaid", "partially_paid", "overdue"].includes(i.status)
      ).length,
    };
    receivables.value = recv.receivables.slice(0, 8);
  } finally {
    loading.value = false;
  }
}

watch(activeCompanyId, () => loadStats(), { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Dashboard</h1>
      <p class="text-neutral-400 mt-1">
        Signed-in workspace for customers, invoices, payments, and statements.
      </p>
    </div>

    <div v-if="user && activeCompanyId" class="grid gap-4 sm:grid-cols-3">
      <UCard>
        <p class="text-sm text-neutral-400">Customers</p>
        <p class="text-3xl font-semibold mt-1">{{ stats.customers }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-neutral-400">Invoices</p>
        <p class="text-3xl font-semibold mt-1">{{ stats.invoices }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-neutral-400">Open invoices</p>
        <p class="text-3xl font-semibold mt-1">{{ stats.unpaid }}</p>
      </UCard>
    </div>

    <div v-if="loading" class="text-neutral-500 text-sm">Loading…</div>

    <UCard v-if="receivables.length">
      <template #header>
        <span class="font-medium">Who owes money</span>
      </template>
      <ul class="space-y-2 text-sm">
        <li
          v-for="row in receivables"
          :key="row.customerId || row.customerName"
          class="flex justify-between gap-3"
        >
          <span>{{ row.customerName }}</span>
          <span class="tabular-nums font-medium">{{ formatZar(row.outstanding) }}</span>
        </li>
      </ul>
    </UCard>

    <div class="flex flex-wrap gap-2">
      <UButton to="/" variant="outline" color="neutral">Open anonymous editor</UButton>
      <UButton v-if="activeCompanyId" to="/dashboard/customers" variant="soft">Customers</UButton>
      <UButton v-if="activeCompanyId" to="/dashboard/invoices" variant="soft">Invoices</UButton>
      <UButton v-if="activeCompanyId" to="/dashboard/import" variant="soft">Import local invoice</UButton>
    </div>
  </div>
</template>
