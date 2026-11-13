<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { datePresets, formatCurrency, formatDate, todayIso, statusLabel } from "~/utils/money";
import { EXPORT_FORMATS, REPORT_EXPORTS, downloadReport, type ReportExport } from "~/utils/reportExports";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type ByMonth = Record<string, { month: string; amount: number }[]>;
type Reports = {
  range: { from: string; to: string; asOf: string };
  incomeByMonth: ByMonth;
  invoicedByMonth: ByMonth;
  incomeByCustomer: Record<string, { customerId: string; customerName: string; received: number; invoiced: number; invoiceCount: number }[]>;
  agedReceivables: Record<string, { rows: Record<string, any>[]; totals: Record<string, number> }>;
  outstandingInvoices: { id: string; invoiceNumber: string; customerName: string; currency: string; issueDate: string; dueDate: string; total: number; outstanding: number; daysOverdue: number }[];
  expensesByCategory: Record<string, { rows: { categoryName: string; amount: number; count: number }[]; total: number }>;
  profitAndLoss: Record<string, { income: number; expenses: number; net: number; expenseLines: { categoryName: string; amount: number }[] }>;
};

const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];
const { activeCompanyId, capi } = useCompanyApi();

const { company, ensure } = useCompany();
const today = todayIso();
const PRESETS = computed(() => datePresets(today, company.value?.taxYearEndMonth));

const range = reactive({ from: `${today.slice(0, 4)}-01-01`, to: today });
const data = ref<Reports | null>(null);
const loading = ref(false);
const error = ref("");
type HoursPeriod = { id: string; startsOn: string; endsOn: string; label?: string; hoursAllowed: number; hoursRolledIn: number; hoursUsed: number; hoursRemaining: number; hoursExpired: number; hoursOverage: number; hoursBilled: number; status: string; prorated?: boolean };
type HoursReportRow = { agreement: { id: string; name: string; status: string; customerName?: string; currency: string }; periods: HoursPeriod[]; totals: Record<string, number>; adHocHours?: { used: number; billed: number; unbilled: number } };
const hoursReport = ref<HoursReportRow[]>([]);
const hoursLoading = ref(false);

const tab = ref("pl");
const TABS = [
  { id: "pl", label: "Profit & loss" },
  { id: "income", label: "Income by month" },
  { id: "customers", label: "Income by customer" },
  { id: "aged", label: "Aged receivables" },
  { id: "outstanding", label: "Outstanding invoices" },
  { id: "expenses", label: "Expenses by category" },
  { id: "hours", label: "Agreement hours" },
];

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    ensure().catch(() => {});
    data.value = await capi<Reports>(`/reports?from=${range.from}&to=${range.to}`);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

const rangeModel = computed({
  get: () => ({ from: range.from, to: range.to }),
  set: (v: { from: string; to: string }) => Object.assign(range, v),
});
// Refresh automatically when the range changes.
watch(() => [range.from, range.to], () => load());

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

const incomeCurrencies = computed(() =>
  [...new Set([...Object.keys(data.value?.incomeByMonth || {}), ...Object.keys(data.value?.invoicedByMonth || {})])].sort()
);
function monthRows(cur: string) {
  const received = data.value?.incomeByMonth[cur] || [];
  const invoiced = data.value?.invoicedByMonth[cur] || [];
  const months = [...new Set([...received.map((r) => r.month), ...invoiced.map((r) => r.month)])].sort();
  return months.map((m) => ({
    month: m,
    received: received.find((r) => r.month === m)?.amount || 0,
    invoiced: invoiced.find((r) => r.month === m)?.amount || 0,
  }));
}
function maxOf(rows: { received: number; invoiced: number }[]) {
  return Math.max(1, ...rows.map((r) => Math.max(r.received, r.invoiced)));
}

// One group of report items per export format.
const exportItems = computed<DropdownMenuItem[][]>(() =>
  EXPORT_FORMATS.flatMap((fmt) => {
    const item = (r: ReportExport) => ({
      label: EXPORT_FORMATS.length > 1 ? `${r.label} (${fmt.label})` : r.label,
      icon: r.icon,
      onSelect: () => data.value && downloadReport(data.value, r, fmt),
    });
    return [REPORT_EXPORTS.map(item)];
  })
);

async function loadHours() {
  if (!activeCompanyId.value) return;
  hoursLoading.value = true;
  try {
    const r = await capi<{ reports: HoursReportRow[] }>(`/agreements/hours-report?asOf=${range.to}`);
    hoursReport.value = r.reports || [];
  } catch (e) {
    error.value = errMsg(e, "Failed to load the hours report");
  } finally {
    hoursLoading.value = false;
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
watch(tab, (id) => { if (id === "hours") loadHours(); });

</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Split by currency — amounts are never converted or added across currencies. P&L is cash basis (payments received minus expenses).">
      <template #filters>
        <DatePicker v-model="rangeModel" range :presets="PRESETS" />
      </template>
      <UDropdownMenu :items="exportItems" :content="{ align: 'end' }" :disabled="!data">
        <UButton variant="soft" color="neutral" icon="i-lucide-download" trailing-icon="i-lucide-chevron-down" :disabled="!data">Export</UButton>
      </UDropdownMenu>
    </PageHeader>


    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UTabs
      v-model="tab"
      :items="TABS.map((t) => ({ label: t.label, value: t.id }))"
      :content="false"
      variant="link"
      class="w-full overflow-x-auto"
    />

    <template v-if="data">
      <!-- P&L -->
      <div v-if="tab === 'pl'" class="grid gap-4 md:grid-cols-2">
        <UCard v-for="(v, cur) in data.profitAndLoss" :key="cur">
          <template #header><span class="font-medium">{{ cur }} · {{ formatDate(data.range.from) }} – {{ formatDate(data.range.to) }}</span></template>
          <table class="w-full text-sm">
            <tbody>
              <tr><td class="py-1 font-medium">Income (payments received)</td><td class="py-1 text-right tabular-nums">{{ formatCurrency(v.income, String(cur)) }}</td></tr>
              <tr><td class="pt-3 pb-1 font-medium" colspan="2">Expenses</td></tr>
              <tr v-for="l in v.expenseLines" :key="l.categoryName"><td class="py-0.5 pl-4 text-muted">{{ l.categoryName }}</td><td class="py-0.5 text-right tabular-nums text-muted">{{ formatCurrency(l.amount, String(cur)) }}</td></tr>
              <tr><td class="py-1 pl-4">Total expenses</td><td class="py-1 text-right tabular-nums">{{ formatCurrency(v.expenses, String(cur)) }}</td></tr>
              <tr class="border-t border-accented"><td class="pt-2 font-semibold">Net profit</td><td class="pt-2 text-right tabular-nums font-semibold" :class="v.net < 0 ? 'text-error' : 'text-success'">{{ formatCurrency(v.net, String(cur)) }}</td></tr>
            </tbody>
          </table>
        </UCard>
        <p v-if="!Object.keys(data.profitAndLoss).length" class="text-sm text-dimmed">No income or expenses in this range.</p>
      </div>

      <!-- Income by month -->
      <div v-else-if="tab === 'income'" class="space-y-4">
        <UCard v-for="cur in incomeCurrencies" :key="cur">
          <template #header><span class="font-medium">{{ cur }}</span> <span class="text-xs text-dimmed">received (bar) vs invoiced</span></template>
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-dimmed"><tr><th class="py-1">Month</th><th class="py-1 w-1/2" /><th class="py-1 text-right">Received</th><th class="py-1 text-right">Invoiced</th></tr></thead>
            <tbody class="divide-y divide-default">
              <tr v-for="r in monthRows(cur)" :key="r.month">
                <td class="py-1.5">{{ monthLabel(r.month) }}</td>
                <td class="py-1.5"><div class="h-2 rounded bg-primary/70" :style="{ width: `${(r.received / maxOf(monthRows(cur))) * 100}%` }" /></td>
                <td class="py-1.5 text-right tabular-nums">{{ formatCurrency(r.received, cur) }}</td>
                <td class="py-1.5 text-right tabular-nums text-muted">{{ formatCurrency(r.invoiced, cur) }}</td>
              </tr>
            </tbody>
          </table>
        </UCard>
        <p v-if="!incomeCurrencies.length" class="text-sm text-dimmed">No income in this range.</p>
      </div>

      <!-- Income by customer -->
      <div v-else-if="tab === 'customers'" class="space-y-4">
        <UCard v-for="(rows, cur) in data.incomeByCustomer" :key="cur">
          <template #header><span class="font-medium">{{ cur }}</span></template>
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-dimmed"><tr><th class="py-1">Customer</th><th class="py-1 text-right">Received</th><th class="py-1 text-right">Invoiced</th><th class="py-1 text-right">Invoices</th></tr></thead>
            <tbody class="divide-y divide-default">
              <tr v-for="r in rows" :key="r.customerId || r.customerName">
                <td class="py-1.5">{{ r.customerName }}</td>
                <td class="py-1.5 text-right tabular-nums">{{ formatCurrency(r.received, String(cur)) }}</td>
                <td class="py-1.5 text-right tabular-nums text-muted">{{ formatCurrency(r.invoiced, String(cur)) }}</td>
                <td class="py-1.5 text-right">{{ r.invoiceCount }}</td>
              </tr>
            </tbody>
          </table>
        </UCard>
        <p v-if="!Object.keys(data.incomeByCustomer).length" class="text-sm text-dimmed">No income in this range.</p>
      </div>

      <!-- Aged receivables -->
      <div v-else-if="tab === 'aged'" class="space-y-4">
        <p class="text-sm text-muted">As of {{ formatDate(data.range.asOf) }} (end of range), using payments and credit notes up to that date.</p>
        <UCard v-for="(v, cur) in data.agedReceivables" :key="cur">
          <template #header><span class="font-medium">{{ cur }}</span></template>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-left text-xs uppercase text-dimmed"><tr><th class="py-1">Customer</th><th v-for="b in BUCKETS" :key="b" class="py-1 text-right">{{ b }}</th><th class="py-1 text-right">Total</th><th class="py-1 text-right">Limit</th></tr></thead>
              <tbody class="divide-y divide-default">
                <tr v-for="r in v.rows" :key="r.customerId || r.customerName">
                  <td class="py-1.5">{{ r.customerName }}</td>
                  <td v-for="b in BUCKETS" :key="b" class="py-1.5 text-right tabular-nums" :class="r[b] ? '' : 'text-dimmed'">{{ r[b] ? formatCurrency(r[b], String(cur)) : "—" }}</td>
                  <td class="py-1.5 text-right tabular-nums font-medium">{{ formatCurrency(r.total, String(cur)) }}</td>
                  <td class="py-1.5 text-right tabular-nums" :class="r.overLimit ? 'text-error' : 'text-muted'">{{ r.creditLimit != null ? formatCurrency(r.creditLimit, String(cur)) : "—" }}</td>
                </tr>
                <tr class="font-semibold">
                  <td class="py-1.5">Total</td>
                  <td v-for="b in BUCKETS" :key="b" class="py-1.5 text-right tabular-nums">{{ formatCurrency(v.totals[b] || 0, String(cur)) }}</td>
                  <td class="py-1.5 text-right tabular-nums">{{ formatCurrency(v.totals.total || 0, String(cur)) }}</td>
                  <td class="py-1.5"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
        <p v-if="!Object.keys(data.agedReceivables).length" class="text-sm text-dimmed">Nothing outstanding.</p>
      </div>

      <!-- Outstanding invoices -->
      <div v-else-if="tab === 'outstanding'">
        <div v-if="data.outstandingInvoices.length" class="overflow-x-auto rounded-lg border border-default">
          <table class="w-full text-sm">
            <thead class="text-left text-xs uppercase text-dimmed bg-elevated/60"><tr><th class="px-4 py-2">Invoice</th><th class="px-4 py-2">Customer</th><th class="px-4 py-2">Due</th><th class="px-4 py-2 text-right">Days overdue</th><th class="px-4 py-2 text-right">Outstanding</th></tr></thead>
            <tbody class="divide-y divide-default">
              <tr v-for="i in data.outstandingInvoices" :key="i.id" class="hover:bg-elevated/60 cursor-pointer" @click="navigateTo(`/dashboard/invoices/${i.id}`)">
                <td class="px-4 py-2">{{ i.invoiceNumber }}</td>
                <td class="px-4 py-2">{{ i.customerName }}</td>
                <td class="px-4 py-2">{{ formatDate(i.dueDate) }}</td>
                <td class="px-4 py-2 text-right" :class="i.daysOverdue ? 'text-error' : ''">{{ i.daysOverdue || "—" }}</td>
                <td class="px-4 py-2 text-right tabular-nums">{{ formatCurrency(i.outstanding, i.currency) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-sm text-dimmed">Nothing outstanding.</p>
      </div>

      <!-- Expenses by category -->
      <div v-else-if="tab === 'expenses'" class="grid gap-4 md:grid-cols-2">
        <UCard v-for="(v, cur) in data.expensesByCategory" :key="cur">
          <template #header><span class="font-medium">{{ cur }}</span></template>
          <table class="w-full text-sm">
            <tbody class="divide-y divide-default">
              <tr v-for="r in v.rows" :key="r.categoryName"><td class="py-1.5">{{ r.categoryName }} <span class="text-dimmed text-xs">({{ r.count }})</span></td><td class="py-1.5 text-right tabular-nums">{{ formatCurrency(r.amount, String(cur)) }}</td></tr>
              <tr class="font-semibold"><td class="py-1.5">Total</td><td class="py-1.5 text-right tabular-nums">{{ formatCurrency(v.total, String(cur)) }}</td></tr>
            </tbody>
          </table>
        </UCard>
        <p v-if="!Object.keys(data.expensesByCategory).length" class="text-sm text-dimmed">No expenses in this range.</p>
      </div>

      <div v-else-if="tab === 'hours'" class="space-y-6">
        <p v-if="hoursLoading" class="text-sm text-dimmed">Loading hours…</p>
        <p v-else-if="!hoursReport.length" class="text-sm text-dimmed">No agreements yet.</p>
        <div v-for="row in hoursReport" :key="row.agreement.id" class="space-y-2">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <NuxtLink :to="`/dashboard/agreements/${row.agreement.id}`" class="font-medium hover:underline">{{ row.agreement.name }}</NuxtLink>
            <span class="text-sm text-dimmed">{{ row.agreement.customerName }} · {{ statusLabel(row.agreement.status) }}</span>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs uppercase tracking-wide text-dimmed">
                <th class="py-1.5 pr-3">Period</th>
                <th class="py-1.5 pr-3 text-right">Allowed</th>
                <th class="py-1.5 pr-3 text-right">Rolled in</th>
                <th class="py-1.5 pr-3 text-right">Used</th>
                <th class="py-1.5 pr-3 text-right">Remaining</th>
                <th class="py-1.5 pr-3 text-right">Expired</th>
                <th class="py-1.5 pr-3 text-right">Overage</th>
                <th class="py-1.5 text-right">Billed</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-default">
              <tr v-for="p in row.periods" :key="p.id">
                <td class="py-1.5 pr-3">{{ p.label || `${formatDate(p.startsOn)} – ${formatDate(p.endsOn)}` }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ p.hoursAllowed }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ p.hoursRolledIn }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ p.hoursUsed }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ p.hoursRemaining }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ p.hoursExpired }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ p.hoursOverage }}</td>
                <td class="py-1.5 text-right tabular-nums">{{ p.hoursBilled }}</td>
              </tr>
              <tr class="font-medium">
                <td class="py-1.5 pr-3">Total</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.totals.hoursAllowed }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.totals.hoursRolledIn }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.totals.hoursUsed }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.totals.hoursRemaining }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.totals.hoursExpired }}</td>
                <td class="py-1.5 pr-3 text-right tabular-nums">{{ row.totals.hoursOverage }}</td>
                <td class="py-1.5 text-right tabular-nums">{{ row.totals.hoursBilled }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="row.adHocHours" class="text-xs text-dimmed">Ad hoc billable hours for this customer: {{ row.adHocHours.used }} used, {{ row.adHocHours.unbilled }} unbilled, {{ row.adHocHours.billed }} billed.</p>
        </div>
      </div>
    </template>
  </div>
</template>
