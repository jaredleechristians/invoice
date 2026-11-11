<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

const route = useRoute();
const { activeCompanyId, capi, cpatch } = useCompanyApi();
const quote = ref<Record<string, any> | null>(null);
const saving = ref(false);
const error = ref("");
const id = computed(() => String(route.params.id));

watch(activeCompanyId, async (cid) => {
  if (!cid) return;
  try {
    quote.value = await capi(`/quotes/${id.value}`);
  } catch (e) {
    error.value = errMsg(e);
  }
}, { immediate: true });

async function onSubmit({ body }: { body: Record<string, unknown> }) {
  saving.value = true;
  error.value = "";
  try {
    await cpatch(`/quotes/${id.value}`, body);
    await navigateTo(`/dashboard/quotes/${id.value}`);
  } catch (e) {
    error.value = errMsg(e, "Could not save quote");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl font-semibold">Edit {{ quote?.quoteNumber || "quote" }}</h1>
      <UButton :to="`/dashboard/quotes/${id}`" variant="ghost" color="neutral">Cancel</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <DocumentForm v-if="quote && quote.status !== 'converted'" kind="quote" :initial="quote" :saving="saving" @submit="onSubmit" />
  </div>
</template>
