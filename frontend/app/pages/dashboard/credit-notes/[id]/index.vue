<script setup lang="ts">
import { formatCurrency, formatDate, lineTotal, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

const route = useRoute();
const { activeCompanyId, capi, cpost, cdelete, cdownload } = useCompanyApi();
const { isAdmin, ensure } = useCompany();
const note = ref<any>(null);
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
    note.value = await capi(`/credit-notes/${id.value}`);
  } catch (e) {
    error.value = errMsg(e, "Failed to load credit note");
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

const finalize = () => run("finalize", async () => { note.value = await cpost(`/credit-notes/${id.value}/finalize`); });
const pdf = () => run("pdf", () => cdownload(`/credit-notes/${id.value}/pdf`, `${note.value?.creditNoteNumber || "draft-credit-note"}.pdf`));
const voidNote = () => {
  const reason = prompt("Void this credit note? The amount will go back onto the invoice. Reason (optional):");
  if (reason === null) return;
  return run("void", async () => { note.value = await cpost(`/credit-notes/${id.value}/void`, { reason }); });
};
const remove = () => {
  if (!confirm(note.value?.draft ? "Delete this draft?" : "Delete this credit note? Its number stays used.")) return;
  return run("delete", async () => {
    await cdelete(`/credit-notes/${id.value}`);
    await navigateTo("/dashboard/credit-notes");
  });
};

watch([activeCompanyId, id, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6">
    <PageHeader :title="note?.creditNoteNumber || 'Draft credit note'">
      <template #filters>
        <UButton to="/dashboard/credit-notes" variant="ghost" color="neutral" icon="i-lucide-arrow-left" aria-label="Back" />
        <p v-if="note" class="flex flex-wrap items-center gap-2 text-muted text-sm">
          <UBadge :color="STATUS_COLORS[note.status] || 'neutral'" variant="subtle">{{ statusLabel(note.status) }}</UBadge>
          {{ note.customerName }} · {{ note.currency }} · issued {{ formatDate(note.issueDateIso) }}
          <template v-if="note.invoiceId">
            · against
            <NuxtLink class="underline" :to="`/dashboard/invoices/${note.invoiceId}`">{{ note.invoiceNumber || "invoice" }}</NuxtLink>
          </template>
        </p>
      </template>
      <template v-if="note">
        <UButton v-if="note.draft" :to="`/dashboard/credit-notes/${note.id}/edit`" variant="soft" icon="i-lucide-pencil">Edit</UButton>
        <UButton v-if="note.draft" icon="i-lucide-check" :loading="busy === 'finalize'" @click="finalize">Publish</UButton>
        <UButton variant="soft" icon="i-lucide-file-down" :loading="busy === 'pdf'" @click="pdf">PDF</UButton>
        <UButton v-if="isAdmin && !note.draft && !note.voided" variant="ghost" color="warning" icon="i-lucide-ban" :loading="busy === 'void'" @click="voidNote">Void</UButton>
        <UButton v-if="isAdmin" variant="ghost" color="error" icon="i-lucide-trash" :loading="busy === 'delete'" @click="remove">Delete</UButton>
      </template>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="note?.voided" color="neutral" variant="subtle" :title="`Void${note.voidReason ? ': ' + note.voidReason : ''}`" />

    <UCard v-if="note">
      <p class="text-sm text-muted">Total credit</p>
      <p class="text-2xl font-semibold tabular-nums">{{ formatCurrency(note.total, note.currency) }}</p>
      <p v-if="note.reason" class="mt-2 text-sm text-muted">{{ note.reason }}</p>
      <table class="w-full text-sm mt-6">
        <thead class="text-left text-xs uppercase text-dimmed">
          <tr><th class="py-1">Description</th><th class="py-1 text-right">Qty</th><th class="py-1 text-right">Unit</th><th class="py-1 text-right">Amount</th></tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="(item, i) in note.items || []" :key="i">
            <td class="py-2"><p class="font-medium">{{ item.description }}</p><p v-if="item.note" class="text-dimmed whitespace-pre-wrap">{{ item.note }}</p></td>
            <td class="py-2 text-right tabular-nums">{{ item.qty }}</td>
            <td class="py-2 text-right tabular-nums">{{ formatCurrency(item.unitPrice, note.currency) }}</td>
            <td class="py-2 text-right tabular-nums">{{ formatCurrency(lineTotal(item), note.currency) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="flex justify-end mt-4 text-sm">
        <div class="w-64 space-y-1">
          <div v-if="note.taxTotal" class="flex justify-between"><span>Subtotal</span><span class="tabular-nums">{{ formatCurrency(note.subtotal, note.currency) }}</span></div>
          <div v-if="note.taxTotal" class="flex justify-between"><span>VAT ({{ note.vatRate }}%)</span><span class="tabular-nums">{{ formatCurrency(note.taxTotal, note.currency) }}</span></div>
          <div class="flex justify-between font-semibold"><span>Total</span><span class="tabular-nums">{{ formatCurrency(note.total, note.currency) }}</span></div>
        </div>
      </div>
      <p v-if="note.notes" class="mt-6 text-sm text-muted whitespace-pre-wrap">{{ note.notes }}</p>
    </UCard>

    <LedgerEntries v-if="note && !note.draft" :invoice-id="note.invoiceId" />
  </div>
</template>
