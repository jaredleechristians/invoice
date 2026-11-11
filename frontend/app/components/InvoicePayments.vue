<script setup lang="ts">
import { formatCurrency, formatDate, PAYMENT_METHOD_LABELS, todayIso } from "~/utils/money";

const props = defineProps<{ invoice: { id: string; currency: string; outstanding: number; voided?: boolean } }>();
const emit = defineEmits<{ changed: [invoice: any] }>();
const { capi, cpost, cdelete } = useCompanyApi();
const { isAdmin } = useCompany();

type Payment = {
  id: string;
  amount: number;
  paidAtIso: string;
  currency: string;
  method: string;
  reference?: string;
  note?: string;
  voided?: boolean;
  voidReason?: string;
};

const payments = ref<Payment[]>([]);
const methods = ref<string[]>(Object.keys(PAYMENT_METHOD_LABELS));
const form = reactive({ amount: "", paidAt: todayIso(), method: "bank_transfer", reference: "", note: "" });
const error = ref("");
const saving = ref(false);
const busyId = ref("");

async function load() {
  try {
    const r = await capi<{ payments: Payment[]; methods: string[] }>(`/payments?invoiceId=${props.invoice.id}`);
    payments.value = r.payments;
    if (r.methods?.length) methods.value = r.methods;
  } catch (e) {
    error.value = errMsg(e);
  }
}

function payInFull() {
  form.amount = String(props.invoice.outstanding);
}

async function record() {
  saving.value = true;
  error.value = "";
  try {
    const r = await cpost<{ invoice: any }>("/payments", {
      invoiceId: props.invoice.id,
      amount: Number(form.amount),
      paidAt: form.paidAt,
      method: form.method,
      reference: form.reference,
      note: form.note,
    });
    Object.assign(form, { amount: "", reference: "", note: "" });
    emit("changed", r.invoice);
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function voidPayment(p: Payment) {
  const reason = prompt(`Void this ${formatCurrency(p.amount, p.currency)} payment? It stays listed as void. Reason (optional):`);
  if (reason === null) return;
  busyId.value = p.id;
  try {
    const r = await cpost<{ invoice: any }>(`/payments/${p.id}/void`, { reason });
    emit("changed", r.invoice);
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    busyId.value = "";
  }
}

async function deletePayment(p: Payment) {
  if (!confirm(`Delete this ${formatCurrency(p.amount, p.currency)} payment?`)) return;
  busyId.value = p.id;
  try {
    const r = await cdelete<{ invoice: any }>(`/payments/${p.id}`);
    emit("changed", r.invoice);
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    busyId.value = "";
  }
}

watch(() => props.invoice.id, load, { immediate: true });
</script>

<template>
  <UCard>
    <template #header><span class="font-medium">Payments</span></template>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-3" />

    <form v-if="invoice.outstanding > 0 && !invoice.voided" class="grid gap-3 sm:grid-cols-6 items-end mb-5" @submit.prevent="record">
      <UFormField :label="`Amount (${invoice.currency})`" class="sm:col-span-1">
        <UInput v-model="form.amount" type="number" step="0.01" min="0.01" :max="invoice.outstanding" required class="w-full" />
      </UFormField>
      <UFormField label="Date"><DatePicker v-model="form.paidAt" block /></UFormField>
      <UFormField label="Method">
        <AppSelect v-model="form.method" :options="methods.map((m) => ({ label: PAYMENT_METHOD_LABELS[m] || m, value: m }))" />
      </UFormField>
      <UFormField label="Reference"><UInput v-model="form.reference" class="w-full" /></UFormField>
      <UFormField label="Note"><UInput v-model="form.note" class="w-full" /></UFormField>
      <div class="flex gap-2">
        <UButton type="submit" :loading="saving">Record</UButton>
        <UButton variant="ghost" size="xs" @click="payInFull">Full</UButton>
      </div>
      <p class="text-xs text-dimmed sm:col-span-6">Payments are recorded in the invoice currency ({{ invoice.currency }}). Outstanding: {{ formatCurrency(invoice.outstanding, invoice.currency) }}.</p>
    </form>

    <UTable
      :data="payments"
      :columns="[
        { accessorKey: 'paidAtIso', header: 'Date' },
        { accessorKey: 'method', header: 'Method' },
        { accessorKey: 'reference', header: 'Reference' },
        { accessorKey: 'amount', header: 'Amount', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { id: 'actions', header: '', meta: { class: { th: 'text-right', td: 'text-right' } } },
      ]"
      class="rounded-lg border border-default" :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #paidAtIso-cell="{ row }"><span :class="row.original.voided ? 'opacity-50' : ''">{{ formatDate(row.original.paidAtIso) }}</span></template>
      <template #method-cell="{ row }"><span :class="row.original.voided ? 'opacity-50' : ''">{{ PAYMENT_METHOD_LABELS[row.original.method] || row.original.method }}</span></template>
      <template #reference-cell="{ row }">
        <div class="text-muted" :class="row.original.voided ? 'opacity-50' : ''">
          {{ row.original.reference || "—" }}
          <span v-if="row.original.note" class="block text-xs text-dimmed">{{ row.original.note }}</span>
          <span v-if="row.original.voided" class="block text-xs text-error">Void{{ row.original.voidReason ? `: ${row.original.voidReason}` : "" }}</span>
        </div>
      </template>
      <template #amount-cell="{ row }">
        <span class="tabular-nums font-medium" :class="row.original.voided ? 'line-through opacity-50' : ''">{{ formatCurrency(row.original.amount, row.original.currency) }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton v-if="!row.original.voided" size="xs" variant="ghost" color="warning" :loading="busyId === row.original.id" @click="voidPayment(row.original)">Void</UButton>
          <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Delete" :loading="busyId === row.original.id" @click="deletePayment(row.original)" />
        </div>
      </template>
      <template #empty><p class="py-4 text-center text-sm text-dimmed">No payments yet.</p></template>
    </UTable>
  </UCard>
</template>
