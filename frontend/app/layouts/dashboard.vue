<script setup lang="ts">
const { user, configured, logout, ready } = useAuth();
const { activeCompanyId, loadMe, bootstrap, restoreActiveCompany, setActiveCompany } = useTenantApi();
const { company, refresh: refreshCompany } = useCompany();

const companies = ref<{ id: string; name: string; role: string }[]>([]);
const loading = ref(false);
const error = ref("");

import type { DropdownMenuItem, NavigationMenuItem } from "@nuxt/ui";

const NAV = [
  { to: "/dashboard", label: "Home", icon: "i-lucide-house", exact: true },
  { to: "/dashboard/invoices", label: "Invoices", icon: "i-lucide-file-text" },
  { to: "/dashboard/quotes", label: "Quotes", icon: "i-lucide-file-pen-line" },
  { to: "/dashboard/customers", label: "Customers", icon: "i-lucide-users" },
  { to: "/dashboard/products", label: "Products", icon: "i-lucide-package" },
  { to: "/dashboard/expenses", label: "Expenses", icon: "i-lucide-wallet" },
  { to: "/dashboard/reports", label: "Reports", icon: "i-lucide-chart-column" },
  { to: "/dashboard/settings", label: "Settings", icon: "i-lucide-settings" },
];
const route = useRoute();
const sidebarOpen = ref(false);
const colorMode = useColorMode();

function isActive(item: { to: string; exact?: boolean }) {
  return item.exact ? route.path === item.to : route.path.startsWith(item.to);
}

const navItems = computed<NavigationMenuItem[]>(() =>
  user.value && activeCompanyId.value
    ? NAV.map((n) => ({ label: n.label, icon: n.icon, to: n.to, active: isActive(n), onSelect: () => (sidebarOpen.value = false) }))
    : []
);

const header = usePageHeader();
const pageTitle = computed(() => {
  if (header.value.title) return header.value.title;
  const hit = [...NAV].reverse().find((n) => isActive(n));
  return hit?.label || "Dashboard";
});

const activeCompany = computed(() => companies.value.find((c) => c.id === activeCompanyId.value));

function initials(name?: string | null) {
  return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

const companyItems = computed<DropdownMenuItem[][]>(() => [
  companies.value.map((c) => ({
    label: c.name,
    avatar: { text: initials(c.name), size: "2xs" as const },
    type: "checkbox" as const,
    checked: c.id === activeCompanyId.value,
    onSelect: () => setActiveCompany(c.id),
  })),
  [
    { label: "Company settings", icon: "i-lucide-settings", to: "/dashboard/settings" },
    { label: "Members", icon: "i-lucide-users", to: "/dashboard/settings/members" },
  ],
]);

const userItems = computed<DropdownMenuItem[][]>(() => [
  [{ type: "label" as const, label: user.value?.displayName || "Signed in", description: user.value?.email || "" }],
  [
    { label: "Anonymous editor", icon: "i-lucide-file-pen", to: "/" },
    {
      label: colorMode.value === "dark" ? "Light mode" : "Dark mode",
      icon: colorMode.value === "dark" ? "i-lucide-sun" : "i-lucide-moon",
      onSelect: (e: Event) => {
        e.preventDefault();
        colorMode.preference = colorMode.value === "dark" ? "light" : "dark";
      },
    },
  ],
  [{ label: "Sign out", icon: "i-lucide-log-out", color: "error" as const, onSelect: () => logout() }],
]);

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
  <UDashboardGroup unit="rem" storage="local" storage-key="invoice-dashboard">
    <UDashboardSidebar
      v-model:open="sidebarOpen"
      collapsible
      resizable
      :min-size="14"
      :default-size="16"
      :max-size="22"
      :collapsed-size="4"
      class="bg-elevated/40"
      :ui="{ footer: 'border-t border-default' }"
    >
      <template #header="{ collapsed }">
        <UDropdownMenu
          v-if="user && companies.length"
          :items="companyItems"
          :content="{ align: 'start', collisionPadding: 12 }"
          :ui="{ content: collapsed ? 'w-56' : 'w-(--reka-dropdown-menu-trigger-width)' }"
        >
          <UButton
            color="neutral"
            variant="ghost"
            block
            :square="collapsed"
            class="data-[state=open]:bg-elevated"
            :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
            :ui="{ trailingIcon: 'text-dimmed' }"
          >
            <UAvatar
              :src="company?.id === activeCompanyId && company?.logoDataUrl ? company.logoDataUrl : undefined"
              :text="initials(activeCompany?.name)"
              size="xs"
              class="rounded-md"
            />
            <span v-if="!collapsed" class="truncate font-semibold text-highlighted">
              {{ activeCompany?.name || "Select company" }}
            </span>
          </UButton>
        </UDropdownMenu>
        <NuxtLink v-else to="/dashboard" class="flex items-center gap-2 px-2 font-semibold text-highlighted">
          <UIcon name="i-lucide-receipt-text" class="size-5 text-primary" />
          <span v-if="!collapsed">Invoice</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu :collapsed="collapsed" :items="navItems" orientation="vertical" tooltip popover />
      </template>

      <template #footer="{ collapsed }">
        <UDropdownMenu
          v-if="user"
          :items="userItems"
          :content="{ align: 'center', collisionPadding: 12 }"
          :ui="{ content: collapsed ? 'w-60' : 'w-(--reka-dropdown-menu-trigger-width)' }"
        >
          <UButton
            color="neutral"
            variant="ghost"
            block
            :square="collapsed"
            class="data-[state=open]:bg-elevated"
            :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
            :ui="{ trailingIcon: 'text-dimmed' }"
          >
            <UAvatar :src="user.photoURL || undefined" :alt="user.displayName || user.email || 'User'" size="xs" />
            <span v-if="!collapsed" class="truncate text-sm">{{ user.email }}</span>
          </UButton>
        </UDropdownMenu>
        <UButton
          v-else-if="configured && ready"
          to="/dashboard/login"
          block
          :square="collapsed"
          icon="i-lucide-log-in"
          :label="collapsed ? undefined : 'Sign in'"
        />
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="main">
      <template #header>
        <UDashboardNavbar :title="pageTitle">
          <template #leading>
            <UDashboardSidebarCollapse />
          </template>
          <template #trailing>
            <UTooltip
              v-if="header.info"
              :text="header.info"
              :content="{ side: 'bottom', align: 'start' }"
              :ui="{ content: 'max-w-sm h-auto py-1.5', text: 'whitespace-normal' }"
            >
              <UButton icon="i-lucide-info" color="neutral" variant="link" size="sm" class="text-dimmed hover:text-muted p-0.5" :aria-label="header.info" />
            </UTooltip>
          </template>
          <template #right>
            <div id="dashboard-navbar-actions" class="flex items-center gap-2" />
            <TenantAssistant />
            <UColorModeButton />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UAlert v-if="error" class="mb-4" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
        <div class="mx-auto w-full max-w-6xl">
          <slot />
        </div>
      </template>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
