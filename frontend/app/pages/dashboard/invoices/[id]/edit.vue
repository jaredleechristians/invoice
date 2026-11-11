<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

const route = useRoute();
const { activeCompanyId, capi, cpatch } = useCompanyApi();
const invoice = ref<Record<string, any> | null>(null);
const saving = ref(false);
const error = ref("");
const id = computed(() => String(route.params.id));

watch(activeCompanyId, async (cid) => {
  if (!cid) return;
  try {
    invoice.value = await capi(`/invoices/${id.value}`);
    if (invoice.value?.voided) error.value = "Void invoices cannot be edited.";
  } catch (e) {
    error.value = errMsg(e);
  }
}, { immediate: true });

async function onSubmit({ body, finalize }: { body: Record<string, unknown>; finalize: boolean }) {
  saving.value = true;
  error.value = "";
  try {
    await cpatch(`/invoices/${id.value}`, { ...body, finalize });
    await navigateTo(`/dashboard/invoices/${id.value}`);
  } catch (e) {
    error.value = errMsg(e, "Could not save invoice");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">Edit {{ invoice?.invoiceNumber || "draft invoice" }}</h1>
      <UButton :to="`/dashboard/invoices/${id}`" variant="ghost" color="neutral">Cancel</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert
      v-if="invoice && !invoice.draft && !invoice.voided"
      color="warning"
      variant="subtle"
      title="This invoice is finalized. Changes apply to the issued invoice; the number stays the same."
    />
    <DocumentForm v-if="invoice && !invoice.voided" kind="invoice" :initial="invoice" :saving="saving" @submit="onSubmit" />
  </div>
</template>
