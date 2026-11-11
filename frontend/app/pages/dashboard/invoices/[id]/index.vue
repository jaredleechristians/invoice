<script setup lang="ts">
import { formatCurrency, formatDate, lineTotal, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Invoice = Record<string, any> & {
  id: string;
  invoiceNumber: string;
  currency: string;
  total: number;
  paidAmount: number;
  outstanding: number;
  status: string;
  draft: boolean;
  voided?: boolean;
};

const route = useRoute();
const { activeCompanyId, capi, cpost, cdelete, cdownload } = useCompanyApi();
const { isAdmin, ensure } = useCompany();

const invoice = ref<Invoice | null>(null);
const loading = ref(false);
const busy = ref("");
const error = ref("");
const id = computed(() => String(route.params.id));

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await ensure();
    invoice.value = await capi<Invoice>(`/invoices/${id.value}`);
  } catch (e) {
    error.value = errMsg(e, "Failed to load invoice");
  } finally {
    loading.value = false;
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

const finalize = () =>
  run("finalize", async () => {
    invoice.value = await cpost<Invoice>(`/invoices/${id.value}/finalize`);
  });

const pdf = () =>
  run("pdf", () => cdownload(`/invoices/${id.value}/pdf`, `${invoice.value?.invoiceNumber || "draft-invoice"}.pdf`));

const duplicate = () =>
  run("duplicate", async () => {
    const copy = await cpost<Invoice>(`/invoices/${id.value}/duplicate`);
    await navigateTo(`/dashboard/invoices/${copy.id}/edit`);
  });

const voidInvoice = () => {
  const reason = prompt("Void this invoice? It stays in the list as VOID and is excluded from reports. Reason (optional):");
  if (reason === null) return;
  return run("void", async () => {
    invoice.value = await cpost<Invoice>(`/invoices/${id.value}/void`, { reason });
  });
};

const remove = () => {
  if (!confirm(invoice.value?.draft ? "Delete this draft?" : "Delete this invoice permanently? Prefer Void for issued invoices.")) return;
  return run("delete", async () => {
    await cdelete(`/invoices/${id.value}`);
    await navigateTo("/dashboard/invoices");
  });
};

function onPaymentsChanged(updated: Invoice | null) {
  if (updated) invoice.value = updated;
  else load();
}

watch([activeCompanyId, id], load, { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p v-if="invoice" class="flex flex-wrap items-center gap-2 text-muted text-sm">
          <UBadge :color="STATUS_COLORS[invoice.status] || 'neutral'" variant="subtle">{{ statusLabel(invoice.status) }}</UBadge>
          {{ invoice.customerName || "No customer" }} · {{ invoice.currency }} · issued {{ formatDate(invoice.issueDateIso) }}
          <template v-if="invoice.dueDate"> · due {{ invoice.dueDateIso ? formatDate(invoice.dueDateIso) : invoice.dueDate }}</template>
        </p>
      </div>
      <PageHeader :title="invoice?.invoiceNumber || 'Draft invoice'">
        <UButton to="/dashboard/invoices" variant="ghost" color="neutral" icon="i-lucide-arrow-left">Invoices</UButton>
      </PageHeader>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="invoice?.voided" color="neutral" variant="subtle" :title="`Void${invoice.voidReason ? ': ' + invoice.voidReason : ''}`" />

    <div v-if="invoice" class="flex flex-wrap gap-2">
      <UButton v-if="!invoice.voided" :to="`/dashboard/invoices/${invoice.id}/edit`" variant="soft" icon="i-lucide-pencil">Edit</UButton>
      <UButton v-if="invoice.draft" icon="i-lucide-check" :loading="busy === 'finalize'" @click="finalize">Finalize</UButton>
      <UButton variant="soft" icon="i-lucide-file-down" :loading="busy === 'pdf'" @click="pdf">PDF</UButton>
      <UButton variant="soft" color="neutral" icon="i-lucide-copy" :loading="busy === 'duplicate'" @click="duplicate">Duplicate</UButton>
      <UButton v-if="isAdmin && !invoice.draft && !invoice.voided" variant="ghost" color="warning" icon="i-lucide-ban" :loading="busy === 'void'" @click="voidInvoice">Void</UButton>
      <UButton v-if="isAdmin && (invoice.draft || !invoice.paidAmount)" variant="ghost" color="error" icon="i-lucide-trash" :loading="busy === 'delete'" @click="remove">Delete</UButton>
    </div>

    <div v-if="invoice" class="grid gap-4 md:grid-cols-3">
      <UCard>
        <p class="text-sm text-muted">Total</p>
        <p class="text-2xl font-semibold tabular-nums">{{ formatCurrency(invoice.total, invoice.currency) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-muted">Paid</p>
        <p class="text-2xl font-semibold tabular-nums">{{ formatCurrency(invoice.paidAmount, invoice.currency) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-muted">Outstanding</p>
        <p class="text-2xl font-semibold tabular-nums" :class="invoice.overdue ? 'text-error' : ''">{{ formatCurrency(invoice.outstanding, invoice.currency) }}</p>
        <p v-if="invoice.overdue" class="text-xs text-error mt-1">{{ invoice.daysOverdue }} days overdue</p>
      </UCard>
    </div>

    <InvoicePayments v-if="invoice && !invoice.draft" :invoice="invoice" @changed="onPaymentsChanged" />

    <UCard v-if="invoice">
      <template #header><span class="font-medium">Details</span></template>
      <div class="grid gap-6 md:grid-cols-2 text-sm">
        <div>
          <p class="text-xs uppercase tracking-wide text-dimmed mb-1">Bill to</p>
          <p class="whitespace-pre-wrap">{{ invoice.billTo || invoice.customerName }}</p>
        </div>
        <div>
          <p v-if="invoice.reference" class="text-muted">Reference: {{ invoice.reference }}</p>
          <p v-if="invoice.sourceQuoteId" class="text-muted">
            From <NuxtLink class="underline" :to="`/dashboard/quotes/${invoice.sourceQuoteId}`">quote</NuxtLink>
          </p>
        </div>
      </div>
      <table class="w-full text-sm mt-6">
        <thead class="text-left text-xs uppercase text-dimmed">
          <tr><th class="py-1">Description</th><th class="py-1 text-right">Qty</th><th class="py-1 text-right">Unit</th><th class="py-1 text-right">Amount</th></tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="(item, i) in invoice.items || []" :key="i">
            <td class="py-2"><p class="font-medium">{{ item.description }}</p><p v-if="item.note" class="text-dimmed whitespace-pre-wrap">{{ item.note }}</p></td>
            <td class="py-2 text-right tabular-nums">{{ item.qty }}</td>
            <td class="py-2 text-right tabular-nums">{{ formatCurrency(item.unitPrice, invoice.currency) }}</td>
            <td class="py-2 text-right tabular-nums">{{ formatCurrency(lineTotal(item), invoice.currency) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="flex justify-end mt-4 text-sm">
        <div class="w-64 space-y-1">
          <div v-if="invoice.taxTotal" class="flex justify-between"><span>Subtotal</span><span class="tabular-nums">{{ formatCurrency(invoice.subtotal, invoice.currency) }}</span></div>
          <div v-if="invoice.taxTotal" class="flex justify-between"><span>VAT ({{ invoice.vatRate }}%)</span><span class="tabular-nums">{{ formatCurrency(invoice.taxTotal, invoice.currency) }}</span></div>
          <div class="flex justify-between font-semibold"><span>Total</span><span class="tabular-nums">{{ formatCurrency(invoice.total, invoice.currency) }}</span></div>
        </div>
      </div>
      <p v-if="invoice.notes" class="mt-6 text-sm text-muted whitespace-pre-wrap">{{ invoice.notes }}</p>
    </UCard>
  </div>
</template>
