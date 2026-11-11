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

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Estimates you can send and convert into invoices.">
      <UButton to="/dashboard/quotes/new" icon="i-lucide-plus">New quote</UButton>
    </PageHeader>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <div class="flex flex-wrap gap-2">
      <UInput v-model="q" placeholder="Search number or customer" class="min-w-56" icon="i-lucide-search" />
      <div class="w-44">
        <AppSelect v-model="status" placeholder="All statuses" :options="['draft', 'sent', 'accepted', 'declined', 'converted', 'expired'].map((s) => ({ label: statusLabel(s), value: s }))" />
      </div>
    </div>
    <div v-if="filtered.length" class="overflow-x-auto rounded-lg border border-default">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-dimmed bg-elevated/60">
          <tr><th class="px-4 py-2">Number</th><th class="px-4 py-2">Customer</th><th class="px-4 py-2">Date</th><th class="px-4 py-2">Valid until</th><th class="px-4 py-2 text-right">Total</th><th class="px-4 py-2">Status</th></tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="x in filtered" :key="x.id" class="hover:bg-elevated/60 cursor-pointer" @click="navigateTo(`/dashboard/quotes/${x.id}`)">
            <td class="px-4 py-2.5 font-medium">{{ x.quoteNumber }}</td>
            <td class="px-4 py-2.5 text-toned">{{ x.customerName || "—" }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatDate(x.issueDateIso) }}</td>
            <td class="px-4 py-2.5 text-muted">{{ formatDate(x.expiryDateIso) }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums">{{ formatCurrency(x.total, x.currency) }}</td>
            <td class="px-4 py-2.5"><UBadge :color="STATUS_COLORS[x.displayStatus] || 'neutral'" variant="subtle">{{ statusLabel(x.displayStatus) }}</UBadge></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="!loading" class="text-dimmed text-sm">No quotes yet.</p>
  </div>
</template>
