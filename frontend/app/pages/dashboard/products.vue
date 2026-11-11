<script setup lang="ts">
import { formatCurrency } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Product = { id: string; name: string; description: string; unitPrice: number; currency: string; kind: string; taxable: boolean; active: boolean };

const { activeCompanyId, capi, cpost, cpatch, cdelete } = useCompanyApi();
const { currencies, isAdmin, company, ensure } = useCompany();

const products = ref<Product[]>([]);
const error = ref("");
const saving = ref(false);
const editingId = ref("");
const showInactive = ref(false);
const blank = () => ({ name: "", description: "", unitPrice: "0", currency: "", kind: "service", taxable: true, active: true });
const form = reactive(blank());
const formOpen = ref(false);
const formError = ref("");
const toast = useToast();

function openNew() {
  reset();
  formOpen.value = true;
}

async function load() {
  if (!activeCompanyId.value) return;
  try {
    await ensure();
    products.value = (await capi<{ products: Product[] }>(`/products${showInactive.value ? "?all=1" : ""}`)).products;
  } catch (e) {
    error.value = errMsg(e);
  }
}

function edit(p: Product) {
  editingId.value = p.id;
  formError.value = "";
  Object.assign(form, { ...p, unitPrice: String(p.unitPrice) });
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
    const body = { ...form, unitPrice: Number(form.unitPrice) };
    if (editingId.value) await cpatch(`/products/${editingId.value}`, body);
    else await cpost("/products", body);
    toast.add({ title: wasEditing ? "Item updated" : "Item added", description: form.name, color: "success", icon: "i-lucide-check" });
    formOpen.value = false;
    reset();
    await load();
  } catch (e) {
    formError.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function remove(p: Product) {
  if (!confirm(`Delete ${p.name}? Existing invoices keep their lines.`)) return;
  try {
    await cdelete(`/products/${p.id}`);
    await load();
  } catch (e) {
    error.value = errMsg(e);
  }
}

watch([activeCompanyId, showInactive], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Products & services" info="Saved items you can pick on invoice and quote lines. Prices are copied onto the line, so editing a product never changes old invoices.">
      <UButton icon="i-lucide-plus" @click="openNew">Add product</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <USlideover v-model:open="formOpen" :title="editingId ? 'Edit item' : 'Add product or service'" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <form id="product-form" class="space-y-4" @submit.prevent="save">
          <UAlert v-if="formError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="formError" />
          <UFormField label="Name" required><UInput v-model="form.name" required autofocus class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Price"><UInput v-model="form.unitPrice" type="number" step="0.01" min="0" class="w-full" /></UFormField>
            <UFormField label="Price currency">
              <AppSelect v-model="form.currency" searchable placeholder="Any" :options="currencies.map((c) => ({ label: c, value: c }))" />
            </UFormField>
          </div>
          <UFormField label="Description (copied to line details)"><UTextarea v-model="form.description" :rows="3" class="w-full" /></UFormField>
          <UFormField label="Type">
            <AppSelect v-model="form.kind" :options="[{ label: 'Service', value: 'service' }, { label: 'Product', value: 'product' }]" />
          </UFormField>
          <div class="flex flex-wrap gap-4">
            <UCheckbox v-if="company?.vatRegistered" v-model="form.taxable" label="VAT applies" />
            <UCheckbox v-model="form.active" label="Active (shown in pickers)" />
          </div>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="formOpen = false">Cancel</UButton>
          <UButton type="submit" form="product-form" :loading="saving">{{ editingId ? "Save changes" : "Add item" }}</UButton>
        </div>
      </template>
    </USlideover>

    <div class="flex justify-end"><UCheckbox v-model="showInactive" label="Show inactive" /></div>

    <div v-if="products.length" class="rounded-lg border border-default divide-y divide-default">
      <div v-for="p in products" :key="p.id" class="flex flex-wrap items-center gap-3 px-4 py-3" :class="p.active ? '' : 'opacity-60'">
        <div class="flex-1 min-w-48">
          <p class="font-medium">{{ p.name }} <UBadge size="sm" variant="subtle" color="neutral">{{ p.kind }}</UBadge></p>
          <p v-if="p.description" class="text-sm text-dimmed line-clamp-1">{{ p.description }}</p>
        </div>
        <p class="tabular-nums">{{ p.currency ? formatCurrency(p.unitPrice, p.currency) : p.unitPrice.toFixed(2) }}</p>
        <UButton size="xs" variant="soft" @click="edit(p)">Edit</UButton>
        <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" @click="remove(p)" />
      </div>
    </div>
    <p v-else class="text-sm text-dimmed">No items yet.</p>
  </div>
</template>
