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
      <UButton to="/dashboard/invoices/new" icon="i-lucide-plus">New invoice</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div class="flex flex-wrap gap-2">
      <UInput v-model="q" placeholder="Search number or customer" class="min-w-56" icon="i-lucide-search" />
      <div class="w-44"><AppSelect v-model="status" placeholder="All statuses" :options="[{ label: 'open (any unpaid)', value: 'open' }, ...STATUS_OPTIONS]" /></div>
      <div class="w-32"><AppSelect v-model="currency" placeholder="All currencies" :options="currencies.map((c) => ({ label: c, value: c }))" /></div>
      <UButton variant="ghost" color="neutral" icon="i-lucide-refresh-cw" :loading="loading" @click="load" />
    </div>

    <div v-if="filtered.length" class="overflow-x-auto rounded-lg border border-default">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-dimmed bg-elevated/60">
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
        <tbody class="divide-y divide-default">
          <tr
            v-for="inv in filtered"
            :key="inv.id"
            class="hover:bg-elevated/60 cursor-pointer"
            @click="navigateTo(`/dashboard/invoices/${inv.id}`)"
          >
            <td class="px-4 py-2.5 font-medium">{{ inv.invoiceNumber || "Draft" }}</td>
            <td class="px-4 py-2.5 text-toned">{{ inv.customerName || "—" }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatDate(inv.issueDateIso) }}</td>
            <td class="px-4 py-2.5 text-muted">{{ inv.dueDateIso ? formatDate(inv.dueDateIso) : inv.dueDate || "—" }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums">{{ formatCurrency(inv.total, inv.currency) }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums">{{ inv.outstanding > 0 ? formatCurrency(inv.outstanding, inv.currency) : "—" }}</td>
            <td class="px-4 py-2.5">
              <UBadge :color="STATUS_COLORS[inv.status] || 'neutral'" variant="subtle">{{ statusLabel(inv.status) }}</UBadge>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!loading" class="text-dimmed text-sm">No invoices match.</p>
  </div>
</template>
