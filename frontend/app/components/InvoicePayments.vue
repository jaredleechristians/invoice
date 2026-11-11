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
  if (!confirm(`Delete this ${formatCurrency(p.amount, p.currency)} payment permanently?`)) return;
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
      <UFormField label="Date"><UInput v-model="form.paidAt" type="date" required class="w-full" /></UFormField>
      <UFormField label="Method">
        <NSelect v-model="form.method" :options="methods.map((m) => ({ label: PAYMENT_METHOD_LABELS[m] || m, value: m }))" />
      </UFormField>
      <UFormField label="Reference"><UInput v-model="form.reference" class="w-full" /></UFormField>
      <UFormField label="Note"><UInput v-model="form.note" class="w-full" /></UFormField>
      <div class="flex gap-2">
        <UButton type="submit" :loading="saving">Record</UButton>
        <UButton variant="ghost" size="xs" @click="payInFull">Full</UButton>
      </div>
      <p class="text-xs text-dimmed sm:col-span-6">Payments are recorded in the invoice currency ({{ invoice.currency }}). Outstanding: {{ formatCurrency(invoice.outstanding, invoice.currency) }}.</p>
    </form>

    <table v-if="payments.length" class="w-full text-sm">
      <thead class="text-left text-xs uppercase text-dimmed">
        <tr><th class="py-1">Date</th><th class="py-1">Method</th><th class="py-1">Reference</th><th class="py-1 text-right">Amount</th><th class="py-1" /></tr>
      </thead>
      <tbody class="divide-y divide-default">
        <tr v-for="p in payments" :key="p.id" :class="p.voided ? 'opacity-50' : ''">
          <td class="py-2">{{ formatDate(p.paidAtIso) }}</td>
          <td class="py-2">{{ PAYMENT_METHOD_LABELS[p.method] || p.method }}</td>
          <td class="py-2 text-muted">
            {{ p.reference || "—" }}
            <span v-if="p.note" class="block text-xs text-dimmed">{{ p.note }}</span>
            <span v-if="p.voided" class="block text-xs text-red-400">Void{{ p.voidReason ? `: ${p.voidReason}` : "" }}</span>
          </td>
          <td class="py-2 text-right tabular-nums font-medium" :class="p.voided ? 'line-through' : ''">{{ formatCurrency(p.amount, p.currency) }}</td>
          <td class="py-2 text-right whitespace-nowrap">
            <UButton v-if="!p.voided" size="xs" variant="ghost" color="warning" :loading="busyId === p.id" @click="voidPayment(p)">Void</UButton>
            <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" :loading="busyId === p.id" @click="deletePayment(p)" />
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="text-sm text-dimmed">No payments yet.</p>
  </UCard>
</template>
