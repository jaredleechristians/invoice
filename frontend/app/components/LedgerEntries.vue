<script setup lang="ts">
import { formatCurrency, formatDate } from "~/utils/money";

const props = defineProps<{
  sourceType?: "invoice" | "payment" | "expense";
  sourceId?: string;
  invoiceId?: string;
}>();

type Line = {
  accountId: string;
  debit: number;
  credit: number;
  currency: string;
  foreignAmount: number;
  rate: number;
  description?: string;
};
type Entry = {
  id: string;
  number: string;
  date: string;
  memo: string;
  kind: string;
  source?: { type: string; event?: string; number?: string };
  totalCents: number;
  baseCurrency: string;
  reversed?: boolean;
  reversesId?: string | null;
  lines: Line[];
};
type Account = { id: string; code: string; name: string };

const { capi } = useCompanyApi();
const entries = ref<Entry[]>([]);
const accounts = ref<Record<string, Account>>({});
const loading = ref(false);
const error = ref("");

function accountLabel(id: string) {
  const a = accounts.value[id];
  return a ? `${a.code} ${a.name}` : id;
}

function money(cents: number, currency: string) {
  return formatCurrency((cents || 0) / 100, currency);
}

async function load() {
  if (!props.sourceId && !props.invoiceId) {
    entries.value = [];
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams();
    if (props.invoiceId) params.set("invoiceId", props.invoiceId);
    else {
      if (props.sourceType) params.set("sourceType", props.sourceType);
      if (props.sourceId) params.set("sourceId", props.sourceId);
    }
    const [j, a] = await Promise.all([
      capi<{ journals: Entry[] }>(`/journals?${params}`),
      capi<{ accounts: Account[] }>("/accounts?active=0"),
    ]);
    entries.value = j.journals;
    accounts.value = Object.fromEntries((a.accounts || []).map((x) => [x.id, x]));
  } catch (e) {
    error.value = errMsg(e, "Failed to load ledger entries");
  } finally {
    loading.value = false;
  }
}

watch(() => [props.sourceType, props.sourceId, props.invoiceId, useDataVersion().value], load, { immediate: true });
</script>

<template>
  <UCard>
    <template #header><span class="font-medium">Ledger</span></template>
    <p v-if="loading" class="text-sm text-muted">Loading…</p>
    <UAlert v-else-if="error" color="error" variant="subtle" :title="error" />
    <p v-else-if="!entries.length" class="text-sm text-muted">No journal entries yet. Drafts and unpublished invoices don’t post.</p>
    <div v-else class="space-y-4">
      <div v-for="entry in entries" :key="entry.id" class="text-sm">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="font-medium">
            {{ entry.number }}
            <span class="text-muted font-normal">· {{ formatDate(entry.date) }}</span>
            <UBadge v-if="entry.kind === 'reversal'" color="neutral" variant="subtle" class="ml-2">Reversal</UBadge>
            <UBadge v-else-if="entry.reversed" color="warning" variant="subtle" class="ml-2">Reversed</UBadge>
          </p>
          <p class="tabular-nums text-muted">{{ money(entry.totalCents, entry.baseCurrency) }}</p>
        </div>
        <p v-if="entry.memo" class="text-muted">{{ entry.memo }}</p>
        <table class="w-full mt-2">
          <thead class="text-left text-xs uppercase text-dimmed">
            <tr>
              <th class="py-1">Account</th>
              <th class="py-1 text-right">Debit</th>
              <th class="py-1 text-right">Credit</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="(line, i) in entry.lines" :key="i">
              <td class="py-1.5">
                {{ accountLabel(line.accountId) }}
                <span v-if="line.currency && line.currency !== entry.baseCurrency" class="text-dimmed">
                  · {{ money(Math.abs(line.foreignAmount), line.currency) }} @ {{ line.rate }}
                </span>
              </td>
              <td class="py-1.5 text-right tabular-nums">{{ line.debit ? money(line.debit, entry.baseCurrency) : "" }}</td>
              <td class="py-1.5 text-right tabular-nums">{{ line.credit ? money(line.credit, entry.baseCurrency) : "" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </UCard>
</template>
