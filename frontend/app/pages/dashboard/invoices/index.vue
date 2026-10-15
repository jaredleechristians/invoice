<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  customerName?: string;
  issueDate: string;
  total: number;
  outstanding: number;
  status: string;
};

const { user, ready } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();

const invoices = ref<InvoiceRow[]>([]);
const loading = ref(false);
const error = ref("");
const q = ref("");
const status = ref("");

function formatZar(n: number) {
  return `R ${Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusColor(s: string) {
  if (s === "paid") return "success";
  if (s === "overdue") return "error";
  if (s === "partially_paid") return "warning";
  return "neutral";
}

async function load() {
  if (!activeCompanyId.value || !user.value) return;
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams();
    if (q.value) params.set("q", q.value);
    if (status.value) params.set("status", status.value);
    const qs = params.toString() ? `?${params}` : "";
    const data = await apiFetch<{ invoices: InvoiceRow[] }>(
      `/companies/${activeCompanyId.value}/invoices${qs}`
    );
    invoices.value = data.invoices;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load invoices";
  } finally {
    loading.value = false;
  }
}

watch([activeCompanyId, () => user.value?.uid, ready], () => load(), { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Invoices</h1>
        <p class="text-neutral-400 text-sm mt-1">Search and open invoices for payments or PDF.</p>
      </div>
      <UButton to="/dashboard" variant="ghost" color="neutral">Dashboard</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div class="flex flex-wrap gap-2">
      <UInput v-model="q" placeholder="Search number or customer" class="min-w-56" @keyup.enter="load" />
      <UInput v-model="status" placeholder="Status filter (optional)" class="min-w-44" @keyup.enter="load" />
      <UButton variant="soft" @click="load">Refresh</UButton>
    </div>

    <div v-if="invoices.length" class="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
      <NuxtLink
        v-for="inv in invoices"
        :key="inv.id"
        :to="`/dashboard/invoices/${inv.id}`"
        class="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-neutral-900/60"
      >
        <div class="min-w-[8rem] font-medium">{{ inv.invoiceNumber || "Draft" }}</div>
        <div class="flex-1 text-sm text-neutral-400">{{ inv.customerName || "—" }}</div>
        <div class="text-sm tabular-nums">{{ formatZar(inv.total) }}</div>
        <div class="text-sm tabular-nums text-neutral-300">{{ formatZar(inv.outstanding) }}</div>
        <UBadge :color="statusColor(inv.status)" variant="subtle">
          {{ inv.status.replace("_", " ") }}
        </UBadge>
      </NuxtLink>
    </div>
    <p v-else-if="!loading" class="text-neutral-500 text-sm">No invoices yet.</p>
  </div>
</template>
