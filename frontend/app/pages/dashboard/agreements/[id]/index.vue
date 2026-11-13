<script setup lang="ts">
import { formatCurrency, formatDate, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type InvoiceRef = { id: string; invoiceNumber?: string; draft?: boolean; voided?: boolean; total?: number } | null;
type Period = {
  id: string;
  startsOn: string;
  endsOn: string;
  label?: string;
  prorated: boolean;
  daysInPeriod: number;
  daysInFullPeriod: number;
  hoursAllowed: number;
  hoursRolledIn: number;
  hoursUsed: number;
  hoursRemaining: number;
  hoursExpired: number;
  hoursOverage: number;
  hoursBilled: number;
  fee: number;
  currency?: string;
  status: string;
  recurringInvoiceId?: string;
  invoice?: InvoiceRef;
  overageInvoice?: InvoiceRef;
};
type Agreement = {
  id: string;
  name: string;
  status: string;
  customerId: string;
  customerName?: string;
  serviceId: string;
  startDate: string;
  endDate?: string;
  period: string;
  hours: number;
  fee: number;
  rate?: number | null;
  overageRate?: number | null;
  currency: string;
  autoPublish: boolean;
  rolloverPolicy?: { mode?: string; limitHours?: number | null };
  periods?: Period[];
};

const route = useRoute();
const { capi, cpost, cdelete } = useCompanyApi();
const { isAdmin } = useCompany();
const toast = useToast();

const agreement = ref<Agreement | null>(null);
const report = ref<{ periods: Period[]; totals?: Record<string, number>; adHocHours?: { used: number; billed: number; unbilled: number } } | null>(null);
const loading = ref(false);
const acting = ref("");
const error = ref("");
const id = computed(() => String(route.params.id || ""));

const rolloverLabel = computed(() => {
  const p = agreement.value?.rolloverPolicy;
  if (!p || p.mode !== "rollover") return "Unused hours expire";
  return p.limitHours != null && p.limitHours !== ("" as unknown) ? `Unused hours roll over, capped at ${p.limitHours}h` : "Unused hours roll over, no cap";
});

async function load() {
  if (!id.value) return;
  loading.value = true;
  error.value = "";
  try {
    const [a, r] = await Promise.all([
      capi<Agreement>(`/agreements/${id.value}`),
      capi<{ reports: { periods: Period[]; totals: Record<string, number>; adHocHours: { used: number; billed: number; unbilled: number } }[] }>(`/agreements/${id.value}/hours-report`).catch(() => ({ reports: [] })),
    ]);
    agreement.value = a;
    report.value = r.reports[0] || { periods: a.periods || [] };
  } catch (e) {
    error.value = errMsg(e, "Failed to load the agreement");
  } finally {
    loading.value = false;
  }
}

async function act(path: string, body: Record<string, unknown> = {}, ok: string) {
  acting.value = path;
  error.value = "";
  try {
    await cpost(`/agreements/${id.value}${path}`, body);
    toast.add({ title: ok, color: "success", icon: "i-lucide-check" });
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    acting.value = "";
  }
}

async function remove() {
  if (!agreement.value || !confirm(`Delete agreement “${agreement.value.name}”? Existing invoices are kept.`)) return;
  acting.value = "delete";
  try {
    await cdelete(`/agreements/${id.value}`);
    toast.add({ title: "Agreement deleted", color: "success", icon: "i-lucide-trash" });
    await navigateTo("/dashboard/agreements");
  } catch (e) {
    error.value = errMsg(e);
    acting.value = "";
  }
}

watch([id, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="agreement?.name || 'Agreement'" info="Hours used come from time logged against this agreement. The period fee is invoiced at the start of each calendar period; overage is added to the next invoice.">
      <UButton v-if="agreement" variant="outline" color="neutral" :to="`/dashboard/agreements/${agreement.id}/edit`" icon="i-lucide-pencil">Edit</UButton>
      <UButton
        v-if="agreement?.status === 'draft'"
        :loading="acting === '/activate'"
        @click="act('/activate', {}, 'Agreement activated')"
      >Activate</UButton>
      <UButton
        v-else-if="agreement?.status === 'active'"
        color="neutral"
        variant="outline"
        :loading="acting === '/pause'"
        @click="act('/pause', {}, 'Agreement paused')"
      >Pause</UButton>
      <UButton
        v-else-if="agreement?.status === 'paused'"
        :loading="acting === '/resume'"
        @click="act('/resume', {}, 'Agreement resumed')"
      >Resume</UButton>
      <UButton
        v-if="agreement && agreement.status !== 'ended' && agreement.status !== 'draft'"
        color="neutral"
        variant="outline"
        :loading="acting === '/run'"
        @click="act('/run', {}, 'Recurring invoices updated')"
      >Run now</UButton>
      <UButton
        v-if="agreement && agreement.status !== 'ended' && agreement.status !== 'draft'"
        color="neutral"
        variant="ghost"
        :loading="acting === '/end'"
        @click="act('/end', {}, 'Agreement ended')"
      >End</UButton>
      <UButton v-if="isAdmin && agreement" color="error" variant="ghost" icon="i-lucide-trash" :loading="acting === 'delete'" @click="remove">Delete</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div v-if="agreement" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <UCard>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Status</dt><dd><UBadge :color="STATUS_COLORS[agreement.status] || 'neutral'" variant="subtle">{{ statusLabel(agreement.status) }}</UBadge></dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Customer</dt><dd><NuxtLink :to="`/dashboard/customers`" class="hover:underline">{{ agreement.customerName || "Customer" }}</NuxtLink></dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Period</dt><dd>{{ agreement.period === "quarter" ? "Calendar quarter" : "Calendar month" }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Starts</dt><dd>{{ formatDate(agreement.startDate) }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Ends</dt><dd>{{ agreement.endDate ? formatDate(agreement.endDate) : "Open-ended" }}</dd></div>
        </dl>
      </UCard>
      <UCard>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Included hours</dt><dd class="tabular-nums">{{ agreement.hours }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Period fee</dt><dd class="tabular-nums">{{ formatCurrency(agreement.fee, agreement.currency) }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Standard rate</dt><dd class="tabular-nums">{{ agreement.rate != null ? formatCurrency(agreement.rate, agreement.currency) : "—" }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Overage rate</dt><dd class="tabular-nums">{{ agreement.overageRate != null ? formatCurrency(agreement.overageRate, agreement.currency) : "Standard rate" }}</dd></div>
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Unused hours</dt><dd class="text-right">{{ rolloverLabel }}</dd></div>
        </dl>
      </UCard>
      <UCard>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between gap-3"><dt class="text-dimmed">Recurring invoices</dt><dd>{{ agreement.autoPublish ? "Published automatically" : "Created as drafts" }}</dd></div>
          <div v-if="report?.totals" class="flex justify-between gap-3"><dt class="text-dimmed">Hours used</dt><dd class="tabular-nums">{{ report.totals.hoursUsed }}</dd></div>
          <div v-if="report?.totals" class="flex justify-between gap-3"><dt class="text-dimmed">Overage</dt><dd class="tabular-nums">{{ report.totals.hoursOverage }}</dd></div>
          <div v-if="report?.adHocHours" class="flex justify-between gap-3"><dt class="text-dimmed">Ad hoc hours (same customer)</dt><dd class="tabular-nums">{{ report.adHocHours.used }}</dd></div>
          <div>
            <NuxtLink :to="`/dashboard/time?agreementId=${agreement.id}`" class="text-sm underline">Log time against this agreement</NuxtLink>
          </div>
        </dl>
      </UCard>
    </div>

    <UCard>
      <template #header><span class="font-medium">Hours by period</span></template>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-dimmed">
              <th class="py-2 pr-3">Period</th>
              <th class="py-2 pr-3 text-right">Allowed</th>
              <th class="py-2 pr-3 text-right">Rolled in</th>
              <th class="py-2 pr-3 text-right">Used</th>
              <th class="py-2 pr-3 text-right">Remaining</th>
              <th class="py-2 pr-3 text-right">Expired</th>
              <th class="py-2 pr-3 text-right">Overage</th>
              <th class="py-2 pr-3 text-right">Fee</th>
              <th class="py-2 pr-3">Invoice</th>
              <th class="py-2">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="p in (report?.periods || agreement?.periods || [])" :key="p.id">
              <td class="py-2 pr-3">
                {{ p.label || `${formatDate(p.startsOn)} – ${formatDate(p.endsOn)}` }}
                <span v-if="p.prorated" class="ml-1 text-xs text-dimmed">(prorated {{ p.daysInPeriod }}/{{ p.daysInFullPeriod }} days)</span>
              </td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ p.hoursAllowed }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ p.hoursRolledIn }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ p.hoursUsed }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ p.hoursRemaining }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ p.hoursExpired }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ p.hoursOverage }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ formatCurrency(p.fee, agreement?.currency) }}</td>
              <td class="py-2 pr-3">
                <NuxtLink v-if="p.invoice" :to="`/dashboard/invoices/${p.invoice.id}`" class="hover:underline">{{ p.invoice.invoiceNumber || (p.invoice.draft ? "Draft" : "Invoice") }}</NuxtLink>
                <NuxtLink v-if="p.overageInvoice" :to="`/dashboard/invoices/${p.overageInvoice.id}`" class="ml-1 hover:underline">{{ p.overageInvoice.invoiceNumber || "Overage" }}</NuxtLink>
                <span v-if="!p.invoice && !p.overageInvoice" class="text-dimmed">—</span>
              </td>
              <td class="py-2"><UBadge :color="STATUS_COLORS[p.status] || 'neutral'" variant="subtle">{{ statusLabel(p.status) }}</UBadge></td>
            </tr>
            <tr v-if="!(report?.periods || agreement?.periods || []).length">
              <td colspan="10" class="py-6 text-center text-dimmed">{{ agreement?.status === "draft" ? "Activate the agreement to open its first period." : "No periods yet." }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </div>
</template>
