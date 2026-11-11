<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

type Customer = { id: string; name: string; email?: string; phone?: string; address?: string; taxNumber?: string; currency?: string; notes?: string };

const { activeCompanyId, capi, cpost, cpatch, cdelete, cdownload } = useCompanyApi();
const { currencies, isAdmin, ensure } = useCompany();

const customers = ref<Customer[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const editingId = ref("");
const q = ref("");
const blank = () => ({ name: "", email: "", phone: "", address: "", taxNumber: "", currency: "", notes: "" });
const form = reactive(blank());

const filtered = computed(() => {
  const n = q.value.trim().toLowerCase();
  return n ? customers.value.filter((c) => c.name.toLowerCase().includes(n) || c.email?.toLowerCase().includes(n)) : customers.value;
});

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await ensure();
    customers.value = (await capi<{ customers: Customer[] }>("/customers")).customers;
  } catch (e) {
    error.value = errMsg(e, "Failed to load customers");
  } finally {
    loading.value = false;
  }
}

function edit(c: Customer) {
  editingId.value = c.id;
  Object.assign(form, blank(), c);
}

function reset() {
  editingId.value = "";
  Object.assign(form, blank());
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    if (editingId.value) await cpatch(`/customers/${editingId.value}`, form);
    else await cpost("/customers", form);
    reset();
    await load();
  } catch (e) {
    error.value = errMsg(e, "Failed to save customer");
  } finally {
    saving.value = false;
  }
}

async function remove(c: Customer) {
  if (!confirm(`Delete ${c.name}? Existing invoices keep their copy of the customer details.`)) return;
  try {
    await cdelete(`/customers/${c.id}`);
    await load();
  } catch (e) {
    error.value = errMsg(e);
  }
}

async function downloadStatement(c: Customer) {
  error.value = "";
  try {
    await cdownload(`/customers/${c.id}/statement.pdf`, `${c.name.replace(/[^\w.-]+/g, "-").slice(0, 40)}-statement.pdf`);
  } catch (e) {
    error.value = errMsg(e, "Statement download failed");
  }
}

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">Customers</h1>
      <p class="text-neutral-400 text-sm mt-1">Bill-to contacts. A default currency pre-selects ZAR or USD on new invoices.</p>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UCard>
      <template #header><span class="font-medium">{{ editingId ? "Edit customer" : "Add customer" }}</span></template>
      <form class="grid gap-3 sm:grid-cols-3" @submit.prevent="save">
        <UFormField label="Name" required><UInput v-model="form.name" required class="w-full" /></UFormField>
        <UFormField label="Email"><UInput v-model="form.email" type="email" class="w-full" /></UFormField>
        <UFormField label="Phone"><UInput v-model="form.phone" class="w-full" /></UFormField>
        <UFormField label="Address" class="sm:col-span-2"><UTextarea v-model="form.address" :rows="2" class="w-full" /></UFormField>
        <div class="space-y-3">
          <UFormField label="Tax / VAT number"><UInput v-model="form.taxNumber" class="w-full" /></UFormField>
          <UFormField label="Default currency">
            <NSelect v-model="form.currency" placeholder="Company default" :options="currencies.map((c) => ({ label: c, value: c }))" />
          </UFormField>
        </div>
        <div class="sm:col-span-3 flex gap-2">
          <UButton type="submit" :loading="saving">{{ editingId ? "Save changes" : "Save customer" }}</UButton>
          <UButton v-if="editingId" variant="ghost" color="neutral" @click="reset">Cancel</UButton>
        </div>
      </form>
    </UCard>

    <UInput v-model="q" placeholder="Search customers" icon="i-lucide-search" class="max-w-sm" />

    <div v-if="filtered.length" class="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
      <div v-for="c in filtered" :key="c.id" class="flex flex-wrap items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-[10rem]">
          <p class="font-medium">{{ c.name }} <UBadge v-if="c.currency" size="sm" variant="subtle" color="neutral">{{ c.currency }}</UBadge></p>
          <p class="text-sm text-neutral-500">{{ c.email }}</p>
        </div>
        <UButton size="xs" variant="ghost" :to="`/dashboard/invoices/new?customer=${c.id}`">New invoice</UButton>
        <UButton size="xs" variant="soft" @click="downloadStatement(c)">Statement PDF</UButton>
        <UButton size="xs" variant="soft" color="neutral" @click="edit(c)">Edit</UButton>
        <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" @click="remove(c)" />
      </div>
    </div>
    <p v-else-if="!loading" class="text-neutral-500 text-sm">No customers yet.</p>
  </div>
</template>
