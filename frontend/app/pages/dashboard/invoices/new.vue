<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

const { activeCompanyId, cpost } = useCompanyApi();
const saving = ref(false);
const error = ref("");

async function onSubmit({ body, finalize }: { body: Record<string, unknown>; finalize: boolean }) {
  saving.value = true;
  error.value = "";
  try {
    const inv = await cpost<{ id: string }>("/invoices", { ...body, draft: !finalize, finalize });
    await navigateTo(`/dashboard/invoices/${inv.id}`);
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
      <h1 class="text-2xl font-semibold">New invoice</h1>
      <UButton to="/dashboard/invoices" variant="ghost" color="neutral">Cancel</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <DocumentForm v-if="activeCompanyId" :key="activeCompanyId" kind="invoice" :saving="saving" @submit="onSubmit" />
  </div>
</template>
