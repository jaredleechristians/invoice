<script setup lang="ts">
import { buildExportHtml } from "~/utils/exportHtml";
import { normalizeInvoice, type Invoice } from "~/utils/invoice";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  customerName?: string;
  issueDate: string;
  dueDate?: string;
  total: number;
  paidAmount: number;
  outstanding: number;
  status: string;
  items?: { description: string; qty: number; unitPrice: number }[];
  payload?: Invoice | null;
};

type PaymentRow = {
  id: string;
  amount: number;
  paidAt: string;
  note?: string;
};

const route = useRoute();
const { user, ready } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();

const invoice = ref<InvoiceDetail | null>(null);
const payments = ref<PaymentRow[]>([]);
const loading = ref(false);
const error = ref("");
const payAmount = ref("");
const payNote = ref("");
const paying = ref(false);
const pdfLoading = ref(false);

const invoiceId = computed(() => route.params.id as string);
const companyId = computed(() => activeCompanyId.value || "");

function formatZar(n: number) {
  return `R ${Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function load() {
  if (!companyId.value || !user.value) return;
  loading.value = true;
  error.value = "";
  try {
    invoice.value = await apiFetch<InvoiceDetail>(
      `/companies/${companyId.value}/invoices/${invoiceId.value}`
    );
    const payData = await apiFetch<{ payments: PaymentRow[] }>(
      `/companies/${companyId.value}/payments?invoiceId=${invoiceId.value}`
    );
    payments.value = payData.payments;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load invoice";
  } finally {
    loading.value = false;
  }
}

async function recordPayment() {
  if (!companyId.value || !invoice.value) return;
  const amount = Number(payAmount.value);
  if (!amount || amount <= 0) return;
  paying.value = true;
  error.value = "";
  try {
    const result = await apiFetch<{ invoice: InvoiceDetail }>(
      `/companies/${companyId.value}/payments`,
      {
        method: "POST",
        body: JSON.stringify({
          invoiceId: invoiceId.value,
          amount,
          note: payNote.value,
        }),
      }
    );
    invoice.value = result.invoice;
    payAmount.value = "";
    payNote.value = "";
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Payment failed";
  } finally {
    paying.value = false;
  }
}

async function downloadPdf() {
  if (!invoice.value?.payload) {
    error.value = "No stored invoice layout for PDF. Re-import from the editor or update the invoice.";
    return;
  }
  pdfLoading.value = true;
  try {
    const html = buildExportHtml(normalizeInvoice(invoice.value.payload));
    const blob = new Blob([html], { type: "text/html" });
    const form = new FormData();
    form.append("files", blob, "index.html");
    form.append("printBackground", "true");
    form.append("preferCssPageSize", "true");
    const res = await fetch("/api/pdf", { method: "POST", body: form });
    if (!res.ok) throw new Error(`PDF failed (${res.status})`);
    const pdf = await res.blob();
    const url = URL.createObjectURL(pdf);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${invoice.value.invoiceNumber || "invoice"}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "PDF download failed";
  } finally {
    pdfLoading.value = false;
  }
}

watch([companyId, invoiceId, () => user.value?.uid, ready], () => load(), { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">{{ invoice?.invoiceNumber || "Invoice" }}</h1>
        <p v-if="invoice" class="text-neutral-400 text-sm mt-1">
          {{ invoice.customerName }} · {{ invoice.status.replace("_", " ") }}
        </p>
      </div>
      <UButton to="/dashboard/invoices" variant="ghost" color="neutral">Back</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div v-if="invoice" class="grid gap-4 md:grid-cols-3">
      <UCard>
        <p class="text-sm text-neutral-400">Total</p>
        <p class="text-2xl font-semibold">{{ formatZar(invoice.total) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-neutral-400">Paid</p>
        <p class="text-2xl font-semibold">{{ formatZar(invoice.paidAmount) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-neutral-400">Outstanding</p>
        <p class="text-2xl font-semibold">{{ formatZar(invoice.outstanding) }}</p>
      </UCard>
    </div>

    <div v-if="invoice" class="flex flex-wrap gap-2">
      <UButton :loading="pdfLoading" variant="soft" @click="downloadPdf">Download PDF</UButton>
    </div>

    <UCard v-if="invoice && invoice.outstanding > 0">
      <template #header>
        <span class="font-medium">Record payment</span>
      </template>
      <form class="flex flex-wrap gap-3 items-end" @submit.prevent="recordPayment">
        <UFormField label="Amount (ZAR)">
          <UInput v-model="payAmount" type="number" step="0.01" min="0" required />
        </UFormField>
        <UFormField label="Note" class="min-w-48">
          <UInput v-model="payNote" />
        </UFormField>
        <UButton type="submit" :loading="paying">Record</UButton>
      </form>
    </UCard>

    <UCard v-if="payments.length">
      <template #header>
        <span class="font-medium">Payments</span>
      </template>
      <ul class="space-y-2 text-sm">
        <li v-for="p in payments" :key="p.id" class="flex justify-between gap-3">
          <span>{{ new Date(p.paidAt).toLocaleString("en-ZA") }}</span>
          <span class="tabular-nums font-medium">{{ formatZar(p.amount) }}</span>
        </li>
      </ul>
    </UCard>
  </div>
</template>
