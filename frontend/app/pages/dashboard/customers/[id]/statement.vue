<script setup lang="ts">
import { datePresets, formatCurrency, todayIso } from "~/utils/money";
import { taxYearRange } from "~/utils/taxYear";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Section = { currency: string; opening: number; invoiced: number; paid: number; closing: number };
type Statement = {
  customer: { id: string; name: string };
  period: { from: string; to: string };
  currencies: string[];
  ledger: Record<string, Section>;
};

const route = useRoute();
const { activeCompanyId, capi, cdownload } = useCompanyApi();
const { apiFetchBlob } = useTenantApi();
const { company, ensure } = useCompany();
const customerId = computed(() => String(route.params.id));

const today = todayIso();
const PRESETS = computed(() => datePresets(today, company.value?.taxYearEndMonth));
const range = reactive({ from: "", to: today });
const rangeModel = computed({
  get: () => ({ from: range.from, to: range.to }),
  set: (v: { from: string; to: string }) => {
    range.from = v?.from || "";
    range.to = v?.to || today;
  },
});

const statement = ref<Statement | null>(null);
const html = ref("");
const loading = ref(false);
const downloading = ref(false);
const error = ref("");
const frame = ref<HTMLIFrameElement | null>(null);
const frameHeight = ref(1123);

function query() {
  const p = new URLSearchParams();
  if (range.from) p.set("from", range.from);
  if (range.to) p.set("to", range.to);
  return p.toString();
}

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const c = await ensure();
    if (!range.from) range.from = taxYearRange(today, c?.taxYearEndMonth).from;
    const qs = query();
    const [st, blob] = await Promise.all([
      capi<Statement>(`/customers/${customerId.value}/statement?${qs}`),
      apiFetchBlob(`/companies/${activeCompanyId.value}/customers/${customerId.value}/statement.pdf?format=html&${qs}`),
    ]);
    statement.value = st;
    html.value = await blob.text();
  } catch (e) {
    error.value = errMsg(e, "Could not load the statement");
  } finally {
    loading.value = false;
  }
}

function fitFrame() {
  const doc = frame.value?.contentDocument;
  if (doc?.documentElement) frameHeight.value = Math.max(600, doc.documentElement.scrollHeight + 4);
}

async function download() {
  downloading.value = true;
  error.value = "";
  try {
    const name = (statement.value?.customer.name || "customer").replace(/[^\w.-]+/g, "-").slice(0, 40);
    await cdownload(`/customers/${customerId.value}/statement.pdf?${query()}`, `${name}-statement-${range.to}.pdf`);
  } catch (e) {
    error.value = errMsg(e, "Download failed");
  } finally {
    downloading.value = false;
  }
}

watch(() => [range.from, range.to], () => statement.value && load());
watch([activeCompanyId, customerId, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="statement ? `Statement: ${statement.customer.name}` : 'Statement'" info="Invoices and payments in the period, with opening and closing balances. Ageing is as at the end date.">
      <template #filters>
        <UButton to="/dashboard/customers" variant="ghost" color="neutral" icon="i-lucide-arrow-left" aria-label="Back to customers" />
        <DatePicker v-model="rangeModel" range :presets="PRESETS" />
      </template>
      <UButton icon="i-lucide-file-down" :loading="downloading" :disabled="!statement" @click="download">Download PDF</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />

    <div v-if="statement && statement.currencies.length" class="flex flex-wrap gap-3">
      <div v-for="c in statement.currencies" :key="c" class="rounded-lg border border-default px-4 py-2">
        <p class="text-xs text-dimmed">{{ statement.ledger[c]!.closing < 0 ? "In credit" : "Balance due" }} ({{ c }})</p>
        <p class="text-lg tabular-nums text-highlighted">{{ formatCurrency(Math.abs(statement.ledger[c]!.closing), c) }}</p>
      </div>
    </div>

    <div class="relative mx-auto w-full max-w-[210mm] overflow-hidden rounded-lg border border-default bg-white shadow-sm">
      <div v-if="loading" class="absolute inset-0 z-10 flex items-center justify-center bg-white/60">
        <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin text-dimmed" />
      </div>
      <iframe
        v-if="html"
        ref="frame"
        :srcdoc="html"
        sandbox="allow-same-origin"
        title="Statement preview"
        class="block w-full border-0"
        :style="{ height: `${frameHeight}px` }"
        @load="fitFrame"
      />
      <div v-else-if="!loading" class="py-24 text-center text-sm text-dimmed">No preview.</div>
    </div>
  </div>
</template>
