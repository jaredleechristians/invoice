<script setup lang="ts">
import { notifyCreditLimitWarning } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

const { activeCompanyId, cpost } = useCompanyApi();
const saving = ref(false);
const error = ref("");

async function onSubmit({ body, finalize }: { body: Record<string, unknown>; finalize: boolean }) {
  saving.value = true;
  error.value = "";
  try {
    const inv = await cpost<{ id: string; creditLimitWarning?: { message?: string } }>("/invoices", { ...body, draft: !finalize, finalize });
    notifyCreditLimitWarning(inv);
    await navigateTo(`/dashboard/invoices/${inv.id}`);
  } catch (e) {
    error.value = errMsg(e, "Could not save invoice");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6">
    <PageHeader title="New invoice">
      <UButton to="/dashboard/invoices" variant="ghost" color="neutral">Cancel</UButton>
    </PageHeader>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <DocumentForm v-if="activeCompanyId" :key="activeCompanyId" kind="invoice" :saving="saving" @submit="onSubmit" />
  </div>
</template>
