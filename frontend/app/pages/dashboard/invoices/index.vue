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
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Invoices</h1>
        <p class="text-neutral-400 text-sm mt-1">Drafts get a number when you finalize them.</p>
      </div>
      <UButton to="/dashboard/invoices/new" icon="i-lucide-plus">New invoice</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div class="flex flex-wrap gap-2">
      <UInput v-model="q" placeholder="Search number or customer" class="min-w-56" icon="i-lucide-search" />
      <div class="w-44"><NSelect v-model="status" placeholder="All statuses" :options="[{ label: 'open (any unpaid)', value: 'open' }, ...STATUS_OPTIONS]" /></div>
      <div class="w-32"><NSelect v-model="currency" placeholder="All currencies" :options="currencies.map((c) => ({ label: c, value: c }))" /></div>
      <UButton variant="ghost" color="neutral" icon="i-lucide-refresh-cw" :loading="loading" @click="load" />
    </div>

    <div v-if="filtered.length" class="overflow-x-auto rounded-lg border border-neutral-800">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-neutral-500 bg-neutral-900/60">
          <tr>
            <th class="px-4 py-2">Number</th>
            <th class="px-4 py-2">Customer</th>
            <th class="px-4 py-2">Issued</th>
            <th class="px-4 py-2">Due</th>
            <th class="px-4 py-2 text-right">Total</th>
            <th class="px-4 py-2 text-right">Outstanding</th>
            <th class="px-4 py-2">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-neutral-800">
          <tr
            v-for="inv in filtered"
            :key="inv.id"
            class="hover:bg-neutral-900/60 cursor-pointer"
            @click="navigateTo(`/dashboard/invoices/${inv.id}`)"
          >
            <td class="px-4 py-2.5 font-medium">{{ inv.invoiceNumber || "Draft" }}</td>
            <td class="px-4 py-2.5 text-neutral-300">{{ inv.customerName || "—" }}</td>
            <td class="px-4 py-2.5 text-neutral-400">{{ formatDate(inv.issueDateIso) }}</td>
            <td class="px-4 py-2.5 text-neutral-400">{{ inv.dueDateIso ? formatDate(inv.dueDateIso) : inv.dueDate || "—" }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums">{{ formatCurrency(inv.total, inv.currency) }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums">{{ inv.outstanding > 0 ? formatCurrency(inv.outstanding, inv.currency) : "—" }}</td>
            <td class="px-4 py-2.5">
              <UBadge :color="STATUS_COLORS[inv.status] || 'neutral'" variant="subtle">{{ statusLabel(inv.status) }}</UBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!loading" class="text-neutral-500 text-sm">No invoices match.</p>
  </div>
</template>
