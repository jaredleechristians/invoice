<script setup lang="ts">
import { formatCurrency, formatDate, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Summary = {
  today: string;
  month: { from: string; to: string };
  outstanding: Record<string, number>;
  overdue: Record<string, number>;
  openCount: number;
  overdueCount: number;
  draftCount: number;
  incomeThisMonth: Record<string, number>;
  expensesThisMonth: Record<string, number>;
  recentInvoices: { id: string; invoiceNumber: string; customerName: string; currency: string; total: number; outstanding: number; status: string }[];
  topOverdue: { id: string; invoiceNumber: string; customerName: string; currency: string; outstanding: number; daysOverdue: number }[];
};

const { user } = useAuth();
const { activeCompanyId, capi } = useCompanyApi();
const { company } = useCompany();

const summary = ref<Summary | null>(null);
const loading = ref(false);
const error = ref("");

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    summary.value = await capi<Summary>("/summary");
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

const netThisMonth = computed(() => {
  const out: Record<string, number> = {};
  const s = summary.value;
  if (!s) return out;
  for (const c of new Set([...Object.keys(s.incomeThisMonth), ...Object.keys(s.expensesThisMonth)])) {
    out[c] = Math.round(((s.incomeThisMonth[c] || 0) - (s.expensesThisMonth[c] || 0)) * 100) / 100;
  }
  return out;
});

const needsSetup = computed(() => company.value && !company.value.bankAccounts?.length);

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Figures are per currency — ZAR and USD are never added together.">
      <UButton to="/dashboard/invoices/new" icon="i-lucide-plus" class="hidden sm:inline-flex">Invoice</UButton>
      <UButton to="/dashboard/quotes/new" variant="soft" icon="i-lucide-plus" class="hidden md:inline-flex">Quote</UButton>
      <UButton to="/dashboard/expenses" variant="soft" icon="i-lucide-plus" class="hidden md:inline-flex">Expense</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="needsSetup" color="info" variant="subtle" title="Add your logo, address and bank details so they appear on invoices.">
      <template #description><NuxtLink to="/dashboard/settings" class="underline">Open settings</NuxtLink></template>
    </UAlert>

    <div v-if="user && summary" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <UCard>
        <p class="text-sm text-muted">Outstanding <span class="text-dimmed">({{ summary.openCount }})</span></p>
        <MoneyList :value="summary.outstanding" empty="Nothing owed" />
        <NuxtLink to="/dashboard/invoices?status=open" class="text-xs text-dimmed underline">View</NuxtLink>
      </UCard>
      <UCard>
        <p class="text-sm text-muted">Overdue <span class="text-dimmed">({{ summary.overdueCount }})</span></p>
        <MoneyList :value="summary.overdue" empty="None" class="text-error" />
        <NuxtLink to="/dashboard/invoices?status=overdue" class="text-xs text-dimmed underline">View</NuxtLink>
      </UCard>
      <UCard>
        <p class="text-sm text-muted">Income this month</p>
        <MoneyList :value="summary.incomeThisMonth" empty="None yet" />
        <p class="text-xs text-dimmed">Payments received since {{ formatDate(summary.month.from) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-muted">Expenses this month</p>
        <MoneyList :value="summary.expensesThisMonth" empty="None yet" />
        <p class="text-xs text-dimmed">Net: <span v-for="(v, c) in netThisMonth" :key="c" class="mr-2 tabular-nums">{{ formatCurrency(v, String(c)) }}</span></p>
      </UCard>
    </div>
    <div v-else-if="loading" class="text-dimmed text-sm">Loading…</div>

    <div v-if="summary" class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <template #header><span class="font-medium">Overdue invoices</span></template>
        <ul v-if="summary.topOverdue.length" class="divide-y divide-default text-sm">
          <li v-for="i in summary.topOverdue" :key="i.id">
            <NuxtLink :to="`/dashboard/invoices/${i.id}`" class="flex justify-between gap-3 py-2 hover:text-highlighted">
              <span>{{ i.invoiceNumber }} · {{ i.customerName }} <span class="text-error text-xs">{{ i.daysOverdue }}d</span></span>
              <span class="tabular-nums">{{ formatCurrency(i.outstanding, i.currency) }}</span>
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="text-sm text-dimmed">Nothing overdue. 🎉</p>
      </UCard>
      <UCard>
        <template #header>
          <div class="flex justify-between"><span class="font-medium">Recent invoices</span><span v-if="summary.draftCount" class="text-xs text-dimmed">{{ summary.draftCount }} draft(s)</span></div>
        </template>
        <ul v-if="summary.recentInvoices.length" class="divide-y divide-default text-sm">
          <li v-for="i in summary.recentInvoices" :key="i.id">
            <NuxtLink :to="`/dashboard/invoices/${i.id}`" class="flex justify-between items-center gap-3 py-2 hover:text-highlighted">
              <span>{{ i.invoiceNumber || "Draft" }} · {{ i.customerName || "—" }}</span>
              <span class="flex items-center gap-2">
                <span class="tabular-nums">{{ formatCurrency(i.total, i.currency) }}</span>
                <UBadge size="sm" :color="STATUS_COLORS[i.status] || 'neutral'" variant="subtle">{{ statusLabel(i.status) }}</UBadge>
              </span>
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="text-sm text-dimmed">No invoices yet. <NuxtLink to="/dashboard/invoices/new" class="underline">Create one</NuxtLink> or <NuxtLink to="/dashboard/import" class="underline">import from the editor</NuxtLink>.</p>
      </UCard>
    </div>
  </div>
</template>
