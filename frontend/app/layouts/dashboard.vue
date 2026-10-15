<script setup lang="ts">
const { user, configured, logout, ready } = useAuth();
const { activeCompanyId, loadMe, bootstrap, restoreActiveCompany, setActiveCompany } =
  useTenantApi();

const companies = ref<{ id: string; name: string; role: string }[]>([]);
const loading = ref(false);
const error = ref("");

async function refreshSession() {
  if (!user.value) return;
  loading.value = true;
  error.value = "";
  try {
    let data = await loadMe();
    if (!data.companies.length) {
      const boot = await bootstrap();
      data = { ...data, companies: boot.companies };
    }
    companies.value = data.companies;
    restoreActiveCompany(data.companies);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load account";
  } finally {
    loading.value = false;
  }
}

watch(
  () => user.value?.uid,
  (uid) => {
    if (uid) refreshSession();
    else {
      companies.value = [];
      setActiveCompany(null);
    }
  },
  { immediate: true }
);
</script>

<template>
  <div class="min-h-screen bg-neutral-950 text-neutral-100">
    <header
      class="border-b border-neutral-800 px-4 py-3 flex flex-wrap items-center gap-3 justify-between"
    >
      <div class="flex items-center gap-3 flex-wrap">
        <NuxtLink to="/" class="font-semibold tracking-tight">Invoice</NuxtLink>
        <UBadge v-if="activeCompanyId" color="neutral" variant="subtle">
          {{ companies.find((c) => c.id === activeCompanyId)?.name || "Company" }}
        </UBadge>
        <nav v-if="user && activeCompanyId" class="flex gap-1 text-sm">
          <UButton to="/dashboard" size="xs" variant="ghost" color="neutral">Dashboard</UButton>
          <UButton to="/dashboard/customers" size="xs" variant="ghost" color="neutral">Customers</UButton>
          <UButton to="/dashboard/invoices" size="xs" variant="ghost" color="neutral">Invoices</UButton>
          <UButton to="/dashboard/import" size="xs" variant="ghost" color="neutral">Import</UButton>
        </nav>
      </div>
      <div class="flex items-center gap-2">
        <TenantAssistant />
        <USelectMenu
          v-if="companies.length > 1"
          :model-value="activeCompanyId"
          :items="companies.map((c) => ({ label: c.name, value: c.id }))"
          value-key="value"
          class="min-w-48"
          @update:model-value="setActiveCompany($event as string)"
        />
        <UButton v-if="!configured" to="/" variant="ghost" color="neutral">
          Anonymous editor
        </UButton>
        <template v-else-if="ready">
          <UButton v-if="!user" to="/dashboard/login">Sign in</UButton>
          <template v-else>
            <span class="text-sm text-neutral-400 hidden sm:inline">{{ user.email }}</span>
            <UButton variant="ghost" color="neutral" @click="logout">Sign out</UButton>
          </template>
        </template>
      </div>
    </header>

    <UAlert
      v-if="error"
      class="m-4"
      color="error"
      variant="subtle"
      :title="error"
    />

    <main class="p-4 max-w-6xl mx-auto">
      <slot />
    </main>
  </div>
</template>
