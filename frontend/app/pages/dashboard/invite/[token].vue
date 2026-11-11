<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

const route = useRoute();
const { apiFetch, setActiveCompany } = useTenantApi();
const preview = ref<{ companyName: string; role: string; email: string; expired: boolean } | null>(null);
const error = ref("");
const accepting = ref(false);
const token = computed(() => String(route.params.token || ""));

onMounted(async () => {
  try {
    preview.value = await apiFetch(`/invites/${token.value}`);
  } catch (e) {
    error.value = errMsg(e, "Invite not found");
  }
});

async function accept() {
  accepting.value = true;
  error.value = "";
  try {
    const r = await apiFetch<{ companyId: string }>(`/invites/${token.value}/accept`, { method: "POST", body: "{}" });
    setActiveCompany(r.companyId);
    window.location.href = "/dashboard";
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    accepting.value = false;
  }
}
</script>

<template>
  <div class="max-w-md mx-auto mt-10 space-y-4">
    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UCard v-if="preview">
      <h1 class="text-xl font-semibold">Join {{ preview.companyName || "company" }}</h1>
      <p class="text-sm text-neutral-400 mt-2">You've been invited as <strong>{{ preview.role }}</strong>.</p>
      <p v-if="preview.email" class="text-xs text-neutral-500 mt-1">This invite is for {{ preview.email }}.</p>
      <UAlert v-if="preview.expired" class="mt-3" color="warning" variant="subtle" title="This invite has expired. Ask for a new one." />
      <UButton v-else class="mt-4" :loading="accepting" @click="accept">Accept invite</UButton>
    </UCard>
  </div>
</template>
