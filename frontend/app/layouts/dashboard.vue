<script setup lang="ts">
const { user, configured, logout, ready } = useAuth();
const { activeCompanyId, loadMe, bootstrap, restoreActiveCompany, setActiveCompany } = useTenantApi();
const { company, refresh: refreshCompany } = useCompany();

const companies = ref<{ id: string; name: string; role: string }[]>([]);
const loading = ref(false);
const error = ref("");

const nav = [
  { to: "/dashboard", label: "Home", exact: true },
  { to: "/dashboard/invoices", label: "Invoices" },
  { to: "/dashboard/quotes", label: "Quotes" },
  { to: "/dashboard/customers", label: "Customers" },
  { to: "/dashboard/products", label: "Products" },
  { to: "/dashboard/expenses", label: "Expenses" },
  { to: "/dashboard/reports", label: "Reports" },
  { to: "/dashboard/settings", label: "Settings" },
];
const route = useRoute();
function isActive(item: { to: string; exact?: boolean }) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to);
}

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

watch(activeCompanyId, (id) => {
  if (id) refreshCompany().catch(() => {});
}, { immediate: true });

// Keep the company badge in sync after a rename in settings.
watch(() => company.value?.name, (name) => {
  const row = companies.value.find((c) => c.id === company.value?.id);
  if (row && name) row.name = name;
});
</script>

<template>
  <div class="min-h-screen bg-default text-highlighted">
    <header class="border-b border-default px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
      <div class="flex items-center gap-3 flex-wrap">
        <NuxtLink to="/dashboard" class="font-semibold tracking-tight">Invoice</NuxtLink>
        <UBadge v-if="activeCompanyId" color="neutral" variant="subtle">
          {{ companies.find((c) => c.id === activeCompanyId)?.name || "Company" }}
        </UBadge>
        <nav v-if="user && activeCompanyId" class="flex flex-wrap gap-1 text-sm">
          <UButton
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            size="xs"
            :variant="isActive(item) ? 'soft' : 'ghost'"
            color="neutral"
          >
            {{ item.label }}
          </UButton>
        </nav>
      </div>
      <div class="flex items-center gap-2">
        <TenantAssistant />
        <USelectMenu
          v-if="companies.length > 1"
          :model-value="activeCompanyId ?? undefined"
          :items="companies.map((c) => ({ label: c.name, value: c.id }))"
          value-key="value"
          class="min-w-48"
          @update:model-value="setActiveCompany($event as string)"
        />
        <UButton to="/" variant="ghost" color="neutral" size="xs">Anonymous editor</UButton>
        <template v-if="configured && ready">
          <UButton v-if="!user" to="/dashboard/login">Sign in</UButton>
          <template v-else>
            <span class="text-sm text-muted hidden sm:inline">{{ user.email }}</span>
            <UButton variant="ghost" color="neutral" @click="logout">Sign out</UButton>
          </template>
        </template>
      </div>
    </header>

    <UAlert v-if="error" class="m-4" color="error" variant="subtle" :title="error" />

    <main class="p-4 max-w-6xl mx-auto">
      <slot />
    </main>
  </div>
</template>
