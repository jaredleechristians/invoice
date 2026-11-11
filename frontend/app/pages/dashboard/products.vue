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
  Object.assign(form, { ...p, unitPrice: String(p.unitPrice) });
}

function reset() {
  editingId.value = "";
  Object.assign(form, blank());
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    const body = { ...form, unitPrice: Number(form.unitPrice) };
    if (editingId.value) await cpatch(`/products/${editingId.value}`, body);
    else await cpost("/products", body);
    reset();
    await load();
  } catch (e) {
    error.value = errMsg(e);
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
    <div>
      <h1 class="text-2xl font-semibold">Products &amp; services</h1>
      <p class="text-muted text-sm mt-1">Saved items you can pick on invoice and quote lines. Prices are copied onto the line, so editing a product never changes old invoices.</p>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UCard>
      <template #header><span class="font-medium">{{ editingId ? "Edit item" : "Add item" }}</span></template>
      <form class="grid gap-3 sm:grid-cols-4" @submit.prevent="save">
        <UFormField label="Name" required class="sm:col-span-2"><UInput v-model="form.name" required class="w-full" /></UFormField>
        <UFormField label="Price"><UInput v-model="form.unitPrice" type="number" step="0.01" min="0" class="w-full" /></UFormField>
        <UFormField label="Price currency">
          <NSelect v-model="form.currency" placeholder="Any" :options="currencies.map((c) => ({ label: c, value: c }))" />
        </UFormField>
        <UFormField label="Description (copied to line details)" class="sm:col-span-4"><UTextarea v-model="form.description" :rows="2" class="w-full" /></UFormField>
        <UFormField label="Type">
          <NSelect v-model="form.kind" :options="[{ label: 'Service', value: 'service' }, { label: 'Product', value: 'product' }]" />
        </UFormField>
        <div class="flex items-end gap-4 sm:col-span-3 pb-1.5">
          <UCheckbox v-if="company?.vatRegistered" v-model="form.taxable" label="VAT applies" />
          <UCheckbox v-model="form.active" label="Active (shown in pickers)" />
        </div>
        <div class="sm:col-span-4 flex gap-2">
          <UButton type="submit" :loading="saving">{{ editingId ? "Save changes" : "Add item" }}</UButton>
          <UButton v-if="editingId" variant="ghost" color="neutral" @click="reset">Cancel</UButton>
        </div>
      </form>
    </UCard>

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
