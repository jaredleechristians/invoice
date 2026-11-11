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
const formOpen = ref(false);
const formError = ref("");
const toast = useToast();

function openNew() {
  reset();
  formOpen.value = true;
}

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
  formError.value = "";
  Object.assign(form, blank(), c);
  formOpen.value = true;
}

function reset() {
  editingId.value = "";
  formError.value = "";
  Object.assign(form, blank());
}

async function save() {
  saving.value = true;
  formError.value = "";
  try {
    const wasEditing = Boolean(editingId.value);
    if (editingId.value) await cpatch(`/customers/${editingId.value}`, form);
    else await cpost("/customers", form);
    toast.add({ title: wasEditing ? "Customer updated" : "Customer added", description: form.name, color: "success", icon: "i-lucide-check" });
    formOpen.value = false;
    reset();
    await load();
  } catch (e) {
    formError.value = errMsg(e, "Failed to save customer");
  } finally {
    saving.value = false;
  }
}

async function remove(c: Customer) {
  if (!confirm(`Delete ${c.name}? Existing invoices keep their copy of the customer details.`)) return;
  try {
    await cdelete(`/customers/${c.id}`);
    toast.add({ title: "Customer deleted", description: c.name, color: "success", icon: "i-lucide-trash" });
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
    <PageHeader info="Bill-to contacts. A default currency pre-selects ZAR or USD on new invoices.">
      <UButton icon="i-lucide-plus" @click="openNew">Add customer</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <USlideover v-model:open="formOpen" :title="editingId ? 'Edit customer' : 'Add customer'" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <form id="customer-form" class="space-y-4" @submit.prevent="save">
          <UAlert v-if="formError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="formError" />
          <UFormField label="Name" required><UInput v-model="form.name" required autofocus class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Email"><UInput v-model="form.email" type="email" class="w-full" /></UFormField>
            <UFormField label="Phone"><UInput v-model="form.phone" class="w-full" /></UFormField>
          </div>
          <UFormField label="Address"><UTextarea v-model="form.address" :rows="3" class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Tax / VAT number"><UInput v-model="form.taxNumber" class="w-full" /></UFormField>
            <UFormField label="Default currency">
              <AppSelect v-model="form.currency" searchable placeholder="Company default" :options="currencies.map((c) => ({ label: c, value: c }))" />
            </UFormField>
          </div>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="formOpen = false">Cancel</UButton>
          <UButton type="submit" form="customer-form" :loading="saving">{{ editingId ? "Save changes" : "Add customer" }}</UButton>
        </div>
      </template>
    </USlideover>

    <UInput v-model="q" placeholder="Search customers" icon="i-lucide-search" class="max-w-sm" />

    <div v-if="filtered.length" class="divide-y divide-default rounded-lg border border-default">
      <div v-for="c in filtered" :key="c.id" class="flex flex-wrap items-center gap-3 px-4 py-3">
        <div class="flex-1 min-w-[10rem]">
          <p class="font-medium">{{ c.name }} <UBadge v-if="c.currency" size="sm" variant="subtle" color="neutral">{{ c.currency }}</UBadge></p>
          <p class="text-sm text-dimmed">{{ c.email }}</p>
        </div>
        <UButton size="xs" variant="ghost" :to="`/dashboard/invoices/new?customer=${c.id}`">New invoice</UButton>
        <UButton size="xs" variant="soft" @click="downloadStatement(c)">Statement PDF</UButton>
        <UButton size="xs" variant="soft" color="neutral" @click="edit(c)">Edit</UButton>
        <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" @click="remove(c)" />
      </div>
    </div>
    <UCard v-else-if="!loading" class="text-center">
      <div class="py-6 space-y-3">
        <UIcon name="i-lucide-users" class="size-8 text-dimmed" />
        <p class="text-muted text-sm">No customers yet.</p>
        <UButton icon="i-lucide-plus" @click="openNew">Add customer</UButton>
      </div>
    </UCard>
  </div>
</template>
