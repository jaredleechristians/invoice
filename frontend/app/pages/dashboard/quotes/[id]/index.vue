<script setup lang="ts">
import { formatCurrency, formatDate, lineTotal, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

const route = useRoute();
const { activeCompanyId, capi, cpost, cpatch, cdelete, cdownload } = useCompanyApi();
const { isAdmin } = useCompany();

const quote = ref<Record<string, any> | null>(null);
const busy = ref("");
const error = ref("");
const id = computed(() => String(route.params.id));

async function load() {
  if (!activeCompanyId.value) return;
  try {
    quote.value = await capi(`/quotes/${id.value}`);
  } catch (e) {
    error.value = errMsg(e);
  }
}

async function run(label: string, fn: () => Promise<void>) {
  busy.value = label;
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    busy.value = "";
  }
}

const setStatus = (status: string) =>
  run(status, async () => {
    quote.value = await cpatch(`/quotes/${id.value}`, { status });
  });

const convert = () =>
  run("convert", async () => {
    const r = await cpost<{ invoice: { id: string } }>(`/quotes/${id.value}/convert`);
    await navigateTo(`/dashboard/invoices/${r.invoice.id}/edit`);
  });

const duplicate = () =>
  run("duplicate", async () => {
    const q = await cpost<{ id: string }>(`/quotes/${id.value}/duplicate`);
    await navigateTo(`/dashboard/quotes/${q.id}/edit`);
  });

const pdf = () => run("pdf", () => cdownload(`/quotes/${id.value}/pdf`, `${quote.value?.quoteNumber || "quote"}.pdf`));

const remove = () => {
  if (!confirm("Delete this quote?")) return;
  return run("delete", async () => {
    await cdelete(`/quotes/${id.value}`);
    await navigateTo("/dashboard/quotes");
  });
};

watch([activeCompanyId, id], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-semibold">{{ quote?.quoteNumber || "Quote" }}</h1>
          <UBadge v-if="quote" :color="STATUS_COLORS[quote.displayStatus] || 'neutral'" variant="subtle">{{ statusLabel(quote.displayStatus) }}</UBadge>
        </div>
        <p v-if="quote" class="text-neutral-400 text-sm mt-1">
          {{ quote.customerName || "No customer" }} · {{ quote.currency }} · {{ formatDate(quote.issueDateIso) }} · valid until {{ formatDate(quote.expiryDateIso) }}
        </p>
      </div>
      <UButton to="/dashboard/quotes" variant="ghost" color="neutral">Back</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="quote?.convertedInvoiceId" color="primary" variant="subtle" title="Converted to an invoice.">
      <template #description><NuxtLink class="underline" :to="`/dashboard/invoices/${quote.convertedInvoiceId}`">Open invoice</NuxtLink></template>
    </UAlert>

    <div v-if="quote" class="flex flex-wrap gap-2">
      <template v-if="quote.status !== 'converted'">
        <UButton :to="`/dashboard/quotes/${quote.id}/edit`" variant="soft" icon="i-lucide-pencil">Edit</UButton>
        <UButton v-if="quote.status === 'draft'" variant="soft" :loading="busy === 'sent'" @click="setStatus('sent')">Mark sent</UButton>
        <UButton v-if="quote.status !== 'accepted'" variant="soft" color="success" :loading="busy === 'accepted'" @click="setStatus('accepted')">Mark accepted</UButton>
        <UButton v-if="quote.status !== 'declined'" variant="ghost" color="error" :loading="busy === 'declined'" @click="setStatus('declined')">Mark declined</UButton>
        <UButton v-if="quote.status !== 'declined'" icon="i-lucide-arrow-right-left" :loading="busy === 'convert'" @click="convert">Convert to invoice</UButton>
      </template>
      <UButton variant="soft" icon="i-lucide-file-down" :loading="busy === 'pdf'" @click="pdf">PDF</UButton>
      <UButton variant="soft" color="neutral" icon="i-lucide-copy" :loading="busy === 'duplicate'" @click="duplicate">Duplicate</UButton>
      <UButton v-if="isAdmin" variant="ghost" color="error" icon="i-lucide-trash" :loading="busy === 'delete'" @click="remove">Delete</UButton>
    </div>

    <UCard v-if="quote">
      <p class="text-xs uppercase tracking-wide text-neutral-500 mb-1">Prepared for</p>
      <p class="whitespace-pre-wrap text-sm">{{ quote.billTo || quote.customerName }}</p>
      <table class="w-full text-sm mt-6">
        <thead class="text-left text-xs uppercase text-neutral-500">
          <tr><th class="py-1">Description</th><th class="py-1 text-right">Qty</th><th class="py-1 text-right">Unit</th><th class="py-1 text-right">Amount</th></tr>
        </thead>
        <tbody class="divide-y divide-neutral-800">
          <tr v-for="(item, i) in quote.items || []" :key="i">
            <td class="py-2"><p class="font-medium">{{ item.description }}</p><p v-if="item.note" class="text-neutral-500 whitespace-pre-wrap">{{ item.note }}</p></td>
            <td class="py-2 text-right tabular-nums">{{ item.qty }}</td>
            <td class="py-2 text-right tabular-nums">{{ formatCurrency(item.unitPrice, quote.currency) }}</td>
            <td class="py-2 text-right tabular-nums">{{ formatCurrency(lineTotal(item), quote.currency) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="flex justify-end mt-4 text-sm">
        <div class="w-64 space-y-1">
          <div v-if="quote.taxTotal" class="flex justify-between"><span>Subtotal</span><span class="tabular-nums">{{ formatCurrency(quote.subtotal, quote.currency) }}</span></div>
          <div v-if="quote.taxTotal" class="flex justify-between"><span>VAT ({{ quote.vatRate }}%)</span><span class="tabular-nums">{{ formatCurrency(quote.taxTotal, quote.currency) }}</span></div>
          <div class="flex justify-between font-semibold"><span>Total</span><span class="tabular-nums">{{ formatCurrency(quote.total, quote.currency) }}</span></div>
        </div>
      </div>
      <p v-if="quote.notes" class="mt-6 text-sm text-neutral-400 whitespace-pre-wrap">{{ quote.notes }}</p>
    </UCard>
  </div>
</template>
