<script setup lang="ts">
import { formatCurrency } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Line = { description: string; note: string; qty: number; unitPrice: number; taxable?: boolean; accountId?: string };

const route = useRoute();
const { activeCompanyId, capi, cpost } = useCompanyApi();
const invoiceId = computed(() => String(route.query.invoice || ""));
const invoice = ref<any>(null);
const items = ref<Line[]>([]);
const issueDate = ref("");
const reason = ref("");
const notes = ref("");
const loading = ref(false);
const saving = ref("");
const error = ref("");

function newLine(): Line {
  return { description: "", note: "", qty: 1, unitPrice: 0, taxable: true };
}

async function load() {
  if (!activeCompanyId.value || !invoiceId.value) return;
  loading.value = true;
  error.value = "";
  try {
    invoice.value = await capi(`/invoices/${invoiceId.value}`);
    items.value = (invoice.value.items || []).map((i: any) => ({
      description: i.description || "",
      note: i.note || "",
      qty: i.qty ?? 1,
      unitPrice: i.unitPrice ?? 0,
      taxable: i.taxable !== false,
      accountId: i.accountId,
    }));
    issueDate.value = new Date().toISOString().slice(0, 10);
    if (!items.value.length) items.value = [newLine()];
  } catch (e) {
    error.value = errMsg(e, "Failed to load the invoice");
  } finally {
    loading.value = false;
  }
}

async function save(finalize: boolean) {
  saving.value = finalize ? "publish" : "draft";
  error.value = "";
  try {
    const note = await cpost<any>("/credit-notes", {
      invoiceId: invoiceId.value,
      items: items.value,
      issueDate: issueDate.value,
      reason: reason.value,
      notes: notes.value,
      draft: !finalize,
      finalize,
    });
    await navigateTo(`/dashboard/credit-notes/${note.id}`);
  } catch (e) {
    error.value = errMsg(e, "Failed to save credit note");
  } finally {
    saving.value = "";
  }
}

watch([activeCompanyId, invoiceId], load, { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6">
    <PageHeader title="New credit note">
      <template #filters>
        <UButton to="/dashboard/credit-notes" variant="ghost" color="neutral" icon="i-lucide-arrow-left" aria-label="Back" />
        <p v-if="invoice" class="text-sm text-muted">
          Against <NuxtLink class="underline" :to="`/dashboard/invoices/${invoice.id}`">{{ invoice.invoiceNumber }}</NuxtLink>
          · outstanding {{ formatCurrency(invoice.outstanding, invoice.currency) }}
        </p>
      </template>
      <template v-if="invoice">
        <UButton variant="soft" :loading="saving === 'draft'" @click="save(false)">Save draft</UButton>
        <UButton icon="i-lucide-check" :loading="saving === 'publish'" @click="save(true)">Publish</UButton>
      </template>
    </PageHeader>

    <UAlert v-if="!invoiceId" color="warning" variant="subtle" title="Open this page from a published invoice (Credit note)." />
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div v-if="invoice" class="space-y-6">
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Issue date"><UInput v-model="issueDate" type="date" class="w-full" /></UFormField>
        <UFormField label="Reason"><UInput v-model="reason" placeholder="Why this credit is issued" class="w-full" /></UFormField>
      </div>
      <LineItemsEditor v-model="items" :currency="invoice.currency" :vat-rate="invoice.vatRate || 0" :new-line="newLine" />
      <UFormField label="Notes"><UTextarea v-model="notes" :rows="3" class="w-full" /></UFormField>
    </div>
  </div>
</template>
