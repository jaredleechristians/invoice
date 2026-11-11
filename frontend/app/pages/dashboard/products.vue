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

watch([activeCompanyId, showInactive, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Products & services" info="Saved items you can pick on invoice and quote lines. Prices are copied onto the line, so editing a product never changes old invoices.">
      <template #filters>
        <UCheckbox v-model="showInactive" label="Show inactive" />
      </template>
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


    <UTable
      :data="products"
      :columns="[
        { accessorKey: 'name', header: 'Name' },
        { accessorKey: 'kind', header: 'Type' },
        { accessorKey: 'unitPrice', header: 'Price', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { id: 'actions', header: '', meta: { class: { th: 'text-right', td: 'text-right' } } },
      ]"
      class="rounded-lg border border-default" :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #name-cell="{ row }">
        <div :class="row.original.active ? '' : 'opacity-60'">
          <p class="font-medium text-highlighted">{{ row.original.name }} <UBadge v-if="!row.original.active" size="sm" variant="subtle" color="neutral">Inactive</UBadge></p>
          <p v-if="row.original.description" class="text-xs text-dimmed line-clamp-1 max-w-md">{{ row.original.description }}</p>
        </div>
      </template>
      <template #kind-cell="{ row }"><span class="text-muted capitalize">{{ row.original.kind }}</span></template>
      <template #unitPrice-cell="{ row }">
        <span class="tabular-nums">{{ row.original.currency ? formatCurrency(row.original.unitPrice, row.original.currency) : row.original.unitPrice.toFixed(2) }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Edit" @click="edit(row.original)" />
          <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Delete" @click="remove(row.original)" />
        </div>
      </template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No products yet.</p></template>
    </UTable>
  </div>
</template>
