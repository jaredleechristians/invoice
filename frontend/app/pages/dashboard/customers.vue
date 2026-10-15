<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

type Customer = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
};

const route = useRoute();
const { user, ready } = useAuth();
const { activeCompanyId, apiFetch, apiFetchBlob, downloadBlob } = useTenantApi();

const customers = ref<Customer[]>([]);
const loading = ref(false);
const form = reactive({ name: "", email: "", phone: "", address: "" });
const saving = ref(false);
const error = ref("");

const companyId = computed(
  () => (route.query.company as string) || activeCompanyId.value || ""
);

async function load() {
  if (!companyId.value || !user.value) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await apiFetch<{ customers: Customer[] }>(
      `/companies/${companyId.value}/customers`
    );
    customers.value = data.customers;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to load customers";
  } finally {
    loading.value = false;
  }
}

async function createCustomer() {
  if (!companyId.value) return;
  saving.value = true;
  error.value = "";
  try {
    await apiFetch(`/companies/${companyId.value}/customers`, {
      method: "POST",
      body: JSON.stringify(form),
    });
    form.name = "";
    form.email = "";
    form.phone = "";
    form.address = "";
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed to create customer";
  } finally {
    saving.value = false;
  }
}

async function downloadStatement(customer: Customer) {
  if (!companyId.value) return;
  error.value = "";
  try {
    const blob = await apiFetchBlob(
      `/companies/${companyId.value}/customers/${customer.id}/statement.pdf`
    );
    const safe = customer.name.replace(/[^\w.-]+/g, "-").slice(0, 40);
    downloadBlob(blob, `${safe}-statement.pdf`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Statement download failed";
  }
}

watch([companyId, () => user.value?.uid, ready], () => load(), { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Customers</h1>
        <p class="text-neutral-400 text-sm mt-1">Manage bill-to contacts for your company.</p>
      </div>
      <UButton to="/dashboard" variant="ghost" color="neutral">Dashboard</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UCard v-if="user">
      <template #header>
        <span class="font-medium">Add customer</span>
      </template>
      <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="createCustomer">
        <UFormField label="Name" required>
          <UInput v-model="form.name" required />
        </UFormField>
        <UFormField label="Email">
          <UInput v-model="form.email" type="email" />
        </UFormField>
        <UFormField label="Phone">
          <UInput v-model="form.phone" />
        </UFormField>
        <UFormField label="Address" class="sm:col-span-2">
          <UTextarea v-model="form.address" :rows="2" />
        </UFormField>
        <div class="sm:col-span-2">
          <UButton type="submit" :loading="saving">Save customer</UButton>
        </div>
      </form>
    </UCard>

    <div
      v-if="customers.length"
      class="divide-y divide-neutral-800 rounded-lg border border-neutral-800"
    >
      <div
        v-for="c in customers"
        :key="c.id"
        class="flex flex-wrap items-center gap-3 px-4 py-3"
      >
        <div class="flex-1 min-w-[10rem]">
          <p class="font-medium">{{ c.name }}</p>
          <p class="text-sm text-neutral-500">{{ c.email }}</p>
        </div>
        <UButton size="xs" variant="soft" @click="downloadStatement(c)">Statement PDF</UButton>
      </div>
    </div>
    <p v-else-if="!loading" class="text-neutral-500 text-sm">No customers yet.</p>
  </div>
</template>
