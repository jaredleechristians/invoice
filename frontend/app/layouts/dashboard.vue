<script setup lang="ts">
const { user, configured, logout, ready } = useAuth();
const { activeCompanyId, apiFetch, loadMe, bootstrap, restoreActiveCompany, setActiveCompany } = useTenantApi();
const toast = useToast();
const { company, refresh: refreshCompany } = useCompany();

const companies = ref<{ id: string; name: string; role: string }[]>([]);
const loading = ref(false);
const error = ref("");

import type { DropdownMenuItem, NavigationMenuItem } from "@nuxt/ui";
import { isPublicDashboardPath } from "~/utils/authRoutes";

const NAV = [
  { to: "/dashboard", label: "Home", icon: "i-lucide-house", exact: true },
  { to: "/dashboard/invoices", label: "Invoices", icon: "i-lucide-file-text" },
  { to: "/dashboard/credit-notes", label: "Credit notes", icon: "i-lucide-file-minus-2" },
  { to: "/dashboard/time", label: "Time", icon: "i-lucide-clock" },
  { to: "/dashboard/quotes", label: "Quotes", icon: "i-lucide-file-pen-line" },
  { to: "/dashboard/customers", label: "Customers", icon: "i-lucide-users" },
  { to: "/dashboard/products", label: "Products", icon: "i-lucide-package" },
  { to: "/dashboard/expenses", label: "Expenses", icon: "i-lucide-wallet" },
  { to: "/dashboard/transactions", label: "Transactions", icon: "i-lucide-landmark" },
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

const ROLE_LABELS: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Detail/edit pages belong to one company; leave them when switching. */
const COMPANY_SCOPED_DETAIL = /^\/dashboard\/(invoices|quotes|credit-notes)\/(?!new$)[^/]+/;

async function switchCompany(id: string) {
  if (id === activeCompanyId.value) return;
  if (COMPANY_SCOPED_DETAIL.test(route.path)) await navigateTo("/dashboard");
  setActiveCompany(id);
  const name = companies.value.find((c) => c.id === id)?.name;
  if (name) toast.add({ title: `Switched to ${name}`, icon: "i-lucide-building-2", color: "neutral" });
}

const companyItems = computed<DropdownMenuItem[][]>(() => [
  [{ type: "label" as const, label: "Companies" }],
  companies.value.map((c) => ({
    label: c.name,
    description: ROLE_LABELS[c.role] || c.role,
    avatar: { text: initials(c.name), size: "2xs" as const },
    type: "checkbox" as const,
    checked: c.id === activeCompanyId.value,
    onSelect: () => switchCompany(c.id),
  })),
  [{ label: "New company", icon: "i-lucide-plus", onSelect: () => openNewCompany() }],
  [
    { label: "Company settings", icon: "i-lucide-settings", to: "/dashboard/settings" },
    { label: "Members", icon: "i-lucide-users", to: "/dashboard/settings/members" },
    { label: "Chart of accounts", icon: "i-lucide-book-open", to: "/dashboard/settings/accounts" },
  ],
]);

// ---------- new company ----------
const newCompany = reactive({ open: false, name: "", saving: false, error: "" });
function openNewCompany() {
  Object.assign(newCompany, { open: true, name: "", saving: false, error: "" });
}
async function createCompany() {
  const name = newCompany.name.trim();
  if (!name || newCompany.saving) return;
  newCompany.saving = true;
  newCompany.error = "";
  try {
    const c = await apiFetch<{ id: string; name: string; role: string }>("/companies", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    companies.value = [...companies.value, { id: c.id, name: c.name, role: c.role || "owner" }];
    newCompany.open = false;
    await switchCompany(c.id);
  } catch (e) {
    newCompany.error = e instanceof Error ? e.message : "Couldn't create the company";
  } finally {
    newCompany.saving = false;
  }
}

const userItems = computed<DropdownMenuItem[][]>(() => [
  [{ type: "label" as const, label: user.value?.displayName || "Signed in", description: user.value?.email || "" }],
  [
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
            <TenantAssistant />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <UAlert v-if="error" class="mb-4" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
        <div class="mx-auto w-full max-w-6xl">
          <!-- Keyed by company: switching remounts the page, so nothing from the previous company lingers. -->
          <div v-if="user || isPublicDashboardPath(route.path)" :key="activeCompanyId || 'none'" class="contents">
            <slot />
          </div>
          <div v-else class="flex justify-center py-16 text-dimmed">
            <UIcon name="i-lucide-loader-circle" class="size-6 animate-spin" />
          </div>
        </div>
      </template>
    </UDashboardPanel>
    <UModal v-model:open="newCompany.open" title="New company" description="You'll be the owner. You can add your logo, address and bank details in settings afterwards." :ui="{ content: 'sm:max-w-md' }">
      <template #body>
        <form id="new-company-form" class="space-y-4" @submit.prevent="createCompany">
          <UAlert v-if="newCompany.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="newCompany.error" />
          <UFormField label="Company name" required>
            <UInput v-model="newCompany.name" placeholder="e.g. Harbour & Co. Consulting" autofocus class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="newCompany.open = false">Cancel</UButton>
          <UButton type="submit" form="new-company-form" icon="i-lucide-plus" :loading="newCompany.saving" :disabled="!newCompany.name.trim()">Create company</UButton>
        </div>
      </template>
    </UModal>
  </UDashboardGroup>
</template>
