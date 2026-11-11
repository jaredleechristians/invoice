<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

const { activeCompanyId, cpost } = useCompanyApi();
const saving = ref(false);
const error = ref("");

async function onSubmit({ body }: { body: Record<string, unknown> }) {
  saving.value = true;
  error.value = "";
  try {
    const q = await cpost<{ id: string }>("/quotes", body);
    await navigateTo(`/dashboard/quotes/${q.id}`);
  } catch (e) {
    error.value = errMsg(e, "Could not save quote");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-5xl space-y-6">
    <PageHeader title="New quote">
      <UButton to="/dashboard/quotes" variant="ghost" color="neutral">Cancel</UButton>
    </PageHeader>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <DocumentForm v-if="activeCompanyId" :key="activeCompanyId" kind="quote" :saving="saving" @submit="onSubmit" />
  </div>
</template>
