<script setup lang="ts">
import { STORAGE_KEY, normalizeInvoice, type Invoice } from "~/utils/invoice";

definePageMeta({ layout: "dashboard", middleware: "auth" });

const { user, ready } = useAuth();
const { activeCompanyId, apiFetch } = useTenantApi();

const preview = ref<Invoice | null>(null);
const error = ref("");
const importing = ref(false);
const success = ref("");

function loadPreview() {
  error.value = "";
  success.value = "";
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      preview.value = null;
      error.value = "No invoice found in browser storage. Create one on the home page first.";
      return;
    }
    preview.value = normalizeInvoice(JSON.parse(raw));
  } catch {
    error.value = "Could not read local invoice data.";
    preview.value = null;
  }
}

async function importToCompany() {
  if (!activeCompanyId.value || !preview.value || !user.value) return;
  importing.value = true;
  error.value = "";
  success.value = "";
  try {
    const invoice = await apiFetch<{ id: string; invoiceNumber: string }>(
      `/companies/${activeCompanyId.value}/invoices/import-local`,
      {
        method: "POST",
        body: JSON.stringify({ invoice: preview.value }),
      }
    );
    success.value = `Imported as ${invoice.invoiceNumber}.`;
    await navigateTo(`/dashboard/invoices/${invoice.id}`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Import failed";
  } finally {
    importing.value = false;
  }
}

onMounted(() => loadPreview());
watch([activeCompanyId, () => user.value?.uid, ready], () => loadPreview());
</script>

<template>
  <div class="space-y-6 max-w-2xl">
    <div>
      <h1 class="text-2xl font-semibold">Import local invoice</h1>
      <p class="text-neutral-400 text-sm mt-1">
        Copy your anonymous editor invoice into the active company (assigns a new invoice number).
      </p>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="success" color="success" variant="subtle" :title="success" />

    <UCard v-if="preview">
      <p class="font-medium">{{ preview.billTo.name }}</p>
      <p class="text-sm text-neutral-400 mt-1">{{ preview.items.length }} line items</p>
      <p class="text-sm text-neutral-500 mt-2">Local number: {{ preview.invoiceNumber }}</p>
      <div class="mt-4 flex gap-2">
        <UButton :loading="importing" :disabled="!activeCompanyId" @click="importToCompany">
          Import to company
        </UButton>
        <UButton to="/" variant="ghost" color="neutral">Edit locally</UButton>
      </div>
    </UCard>

    <UButton to="/dashboard" variant="ghost" color="neutral">Dashboard</UButton>
  </div>
</template>
