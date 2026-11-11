<script setup lang="ts">
import { fileToDataUrl, formatCurrency, formatDate, todayIso, datePresets } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type Category = { id: string; name: string };
type Expense = {
  id: string;
  date: string;
  vendor: string;
  categoryId: string;
  categoryName: string;
  amount: number;
  currency: string;
  reference?: string;
  notes?: string;
  receipt?: { filename: string; contentType: string; size: number } | null;
};

const MAX_RECEIPT = 700 * 1024;

const { activeCompanyId, capi, cpost, cpatch, cdelete, copen } = useCompanyApi();
const { currencies, company, ensure, isAdmin } = useCompany();

const expenses = ref<Expense[]>([]);
const categories = ref<Category[]>([]);
const error = ref("");
const saving = ref(false);
const editingId = ref("");
const filters = reactive({ from: "", to: "", categoryId: "", currency: "" });
const filterRange = computed({
  get: () => ({ from: filters.from, to: filters.to }),
  set: (v: { from: string; to: string }) => Object.assign(filters, v),
});
const DATE_PRESETS = datePresets();
// Filters apply immediately.
watch(() => ({ ...filters }), () => load(), { deep: true });
const newCategory = ref("");
const showCategories = ref(false);
const formOpen = ref(false);
const formError = ref("");
const toast = useToast();
const renaming = reactive({ open: false, id: "", name: "", saving: false });

function openNew() {
  reset();
  if (!form.currency) form.currency = company.value?.defaultCurrency || "ZAR";
  formOpen.value = true;
}

const blank = () => ({
  date: todayIso(),
  vendor: "",
  categoryId: "",
  amount: "",
  currency: company.value?.defaultCurrency || "ZAR",
  reference: "",
  notes: "",
});
const form = reactive(blank());
const receipt = ref<{ filename: string; contentType: string; dataBase64: string } | null>(null);
const removeReceipt = ref(false);
const receiptFile = ref<File | null>(null);
watch(receiptFile, (f) => onFile(f));

const totals = computed(() => {
  const out: Record<string, number> = {};
  for (const e of expenses.value) out[e.currency] = Math.round(((out[e.currency] || 0) + e.amount) * 100) / 100;
  return out;
});

async function load() {
  if (!activeCompanyId.value) return;
  error.value = "";
  try {
    await ensure();
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
    const [c, e] = await Promise.all([
      capi<{ categories: Category[] }>("/expense-categories"),
      capi<{ expenses: Expense[] }>(`/expenses${params.toString() ? `?${params}` : ""}`),
    ]);
    categories.value = c.categories;
    expenses.value = e.expenses;
    if (!editingId.value && !form.currency) form.currency = company.value?.defaultCurrency || "ZAR";
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function onFile(file: File | null | undefined) {
  if (!file) {
    receipt.value = null;
    return;
  }
  if (file.size > MAX_RECEIPT) {
    error.value = "Receipt must be 700 KB or smaller.";
    receiptFile.value = null;
    return;
  }
  const dataUrl = await fileToDataUrl(file);
  receipt.value = { filename: file.name, contentType: file.type || "application/octet-stream", dataBase64: dataUrl.split(",")[1] || "" };
  removeReceipt.value = false;
}

function reset() {
  editingId.value = "";
  Object.assign(form, blank());
  receipt.value = null;
  removeReceipt.value = false;
  receiptFile.value = null;
  formError.value = "";
}

function edit(e: Expense) {
  editingId.value = e.id;
  Object.assign(form, { date: e.date, vendor: e.vendor, categoryId: e.categoryId, amount: String(e.amount), currency: e.currency, reference: e.reference || "", notes: e.notes || "" });
  receipt.value = null;
  removeReceipt.value = false;
  formError.value = "";
  formOpen.value = true;
}

async function save() {
  saving.value = true;
  formError.value = "";
  try {
    const wasEditing = Boolean(editingId.value);
    const body: Record<string, unknown> = { ...form, amount: Number(form.amount) };
    if (receipt.value) body.receipt = receipt.value;
    else if (removeReceipt.value) body.receipt = null;
    if (editingId.value) await cpatch(`/expenses/${editingId.value}`, body);
    else await cpost("/expenses", body);
    toast.add({
      title: wasEditing ? "Expense updated" : "Expense added",
      description: [form.vendor, formatCurrency(Number(form.amount), form.currency)].filter(Boolean).join(" · "),
      color: "success",
      icon: "i-lucide-check",
    });
    formOpen.value = false;
    reset();
    await load();
  } catch (e) {
    formError.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function remove(e: Expense) {
  if (!confirm(`Delete ${e.vendor || "this expense"} (${formatCurrency(e.amount, e.currency)})?`)) return;
  try {
    await cdelete(`/expenses/${e.id}`);
    await load();
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function viewReceipt(e: Expense) {
  try {
    await copen(`/expenses/${e.id}/receipt`);
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function addCategory() {
  if (!newCategory.value.trim()) return;
  try {
    const c = await cpost<Category>("/expense-categories", { name: newCategory.value });
    newCategory.value = "";
    await load();
    if (formOpen.value) form.categoryId = c.id;
    toast.add({ title: "Category added", description: c.name, color: "success", icon: "i-lucide-check" });
  } catch (err) {
    error.value = errMsg(err);
  }
}

function renameCategory(c: Category) {
  Object.assign(renaming, { open: true, id: c.id, name: c.name, saving: false });
}
async function saveRename() {
  const name = renaming.name.trim();
  if (!name) return;
  renaming.saving = true;
  try {
    await cpatch(`/expense-categories/${renaming.id}`, { name });
    renaming.open = false;
    toast.add({ title: "Category renamed", description: name, color: "success", icon: "i-lucide-check" });
    await load();
  } catch (err) {
    error.value = errMsg(err);
  } finally {
    renaming.saving = false;
  }
}

async function deleteCategory(c: Category) {
  if (!confirm(`Delete category ${c.name}?`)) return;
  try {
    await cdelete(`/expense-categories/${c.id}`);
    toast.add({ title: "Category deleted", description: c.name, color: "success", icon: "i-lucide-trash" });
    await load();
  } catch (err) {
    error.value = errMsg(err);
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Money out. Amounts stay in the currency you paid in.">
      <template #filters>
        <DatePicker v-model="filterRange" range :presets="DATE_PRESETS" clearable placeholder="All dates" />
        <div class="w-full sm:w-60"><AppSelect v-model="filters.categoryId" searchable placeholder="All categories" :options="categories.map((c) => ({ label: c.name, value: c.id }))" /></div>
        <div class="w-full sm:w-44"><AppSelect v-model="filters.currency" placeholder="All currencies" :options="currencies.map((c) => ({ label: c, value: c }))" /></div>
      </template>
      <UButton variant="soft" color="neutral" icon="i-lucide-tags" @click="showCategories = true">Categories</UButton>
      <UButton icon="i-lucide-plus" @click="openNew">Add expense</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <USlideover v-model:open="showCategories" title="Expense categories" description="Used to group expenses in reports." :ui="{ content: 'sm:max-w-md' }">
      <template #body>
        <div class="space-y-4">
          <form v-if="isAdmin" class="flex gap-2" @submit.prevent="addCategory">
            <UInput v-model="newCategory" placeholder="New category" class="flex-1" />
            <UButton type="submit" icon="i-lucide-plus" :disabled="!newCategory.trim()">Add</UButton>
          </form>
          <div class="rounded-lg border border-default divide-y divide-default">
            <div v-for="c in categories" :key="c.id" class="flex items-center gap-2 px-3 py-2">
              <span class="flex-1 truncate">{{ c.name }}</span>
              <template v-if="isAdmin">
                <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Rename" @click="renameCategory(c)" />
                <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Delete" @click="deleteCategory(c)" />
              </template>
            </div>
            <p v-if="!categories.length" class="px-3 py-4 text-sm text-dimmed">No categories yet.</p>
          </div>
        </div>
      </template>
    </USlideover>

    <UModal v-model:open="renaming.open" title="Rename category">
      <template #body>
        <form id="rename-category-form" @submit.prevent="saveRename">
          <UFormField label="Name"><UInput v-model="renaming.name" autofocus class="w-full" /></UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="renaming.open = false">Cancel</UButton>
          <UButton type="submit" form="rename-category-form" :loading="renaming.saving">Save</UButton>
        </div>
      </template>
    </UModal>

    <USlideover v-model:open="formOpen" :title="editingId ? 'Edit expense' : 'Add expense'" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <form id="expense-form" class="space-y-4" @submit.prevent="save">
          <UAlert v-if="formError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="formError" />
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Date" required><DatePicker v-model="form.date" block /></UFormField>
            <UFormField label="Category">
              <AppSelect v-model="form.categoryId" searchable placeholder="Uncategorised" :options="categories.map((c) => ({ label: c.name, value: c.id }))" />
            </UFormField>
          </div>
          <UFormField label="Vendor"><UInput v-model="form.vendor" class="w-full" placeholder="e.g. Afrihost" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Amount" required><UInput v-model="form.amount" type="number" step="0.01" min="0.01" required class="w-full" /></UFormField>
            <UFormField label="Currency">
              <AppSelect v-model="form.currency" searchable :options="currencies.map((c) => ({ label: c, value: c }))" />
            </UFormField>
          </div>
          <UFormField label="Reference"><UInput v-model="form.reference" class="w-full" /></UFormField>
          <UFormField label="Notes"><UTextarea v-model="form.notes" :rows="2" class="w-full" /></UFormField>
          <UFormField label="Receipt (PDF or image, ≤ 700 KB)">
            <div class="space-y-2">
              <UFileUpload
                v-model="receiptFile"
                accept="application/pdf,image/*"
                icon="i-lucide-receipt"
                label="Drop a receipt here"
                description="PDF or image, up to 700 KB"
                layout="list"
                class="w-full min-h-28"
              />
              <UCheckbox v-if="editingId && expenses.find((x) => x.id === editingId)?.receipt" v-model="removeReceipt" label="Remove existing receipt" />
            </div>
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="formOpen = false">Cancel</UButton>
          <UButton type="submit" form="expense-form" :loading="saving">{{ editingId ? "Save changes" : "Add expense" }}</UButton>
        </div>
      </template>
    </USlideover>

    <div class="flex flex-wrap items-center gap-2">
      <div class="ml-auto text-right">
        <p class="text-xs text-dimmed">Total shown</p>
        <MoneyList :value="totals" size="sm" />
      </div>
    </div>

    <UTable
      :data="expenses"
      :columns="[
        { accessorKey: 'date', header: 'Date' },
        { accessorKey: 'vendor', header: 'Vendor' },
        { accessorKey: 'categoryName', header: 'Category' },
        { accessorKey: 'amount', header: 'Amount', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { id: 'actions', header: '', meta: { class: { th: 'text-right', td: 'text-right' } } },
      ]"
      class="rounded-lg border border-default" :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #date-cell="{ row }"><span class="whitespace-nowrap">{{ formatDate(row.original.date) }}</span></template>
      <template #vendor-cell="{ row }">
        <span class="text-highlighted">{{ row.original.vendor || "—" }}</span>
        <span v-if="row.original.notes" class="block text-xs text-dimmed line-clamp-1">{{ row.original.notes }}</span>
      </template>
      <template #categoryName-cell="{ row }"><span class="text-muted">{{ row.original.categoryName }}</span></template>
      <template #amount-cell="{ row }"><span class="tabular-nums">{{ formatCurrency(row.original.amount, row.original.currency) }}</span></template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton v-if="row.original.receipt" size="xs" variant="ghost" color="neutral" icon="i-lucide-paperclip" aria-label="Receipt" @click="viewReceipt(row.original)" />
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Edit" @click="edit(row.original)" />
          <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Delete" @click="remove(row.original)" />
        </div>
      </template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No expenses yet.</p></template>
    </UTable>
  </div>
</template>
