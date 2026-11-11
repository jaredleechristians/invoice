<script setup lang="ts">
import { fileToDataUrl, formatCurrency, formatDate, todayIso } from "~/utils/money";

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
const newCategory = ref("");
const showCategories = ref(false);

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
const fileInput = ref<HTMLInputElement | null>(null);

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

async function onFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > MAX_RECEIPT) {
    error.value = "Receipt must be 700 KB or smaller.";
    (ev.target as HTMLInputElement).value = "";
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
  if (fileInput.value) fileInput.value.value = "";
}

function edit(e: Expense) {
  editingId.value = e.id;
  Object.assign(form, { date: e.date, vendor: e.vendor, categoryId: e.categoryId, amount: String(e.amount), currency: e.currency, reference: e.reference || "", notes: e.notes || "" });
  receipt.value = null;
  removeReceipt.value = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function save() {
  saving.value = true;
  error.value = "";
  try {
    const body: Record<string, unknown> = { ...form, amount: Number(form.amount) };
    if (receipt.value) body.receipt = receipt.value;
    else if (removeReceipt.value) body.receipt = null;
    if (editingId.value) await cpatch(`/expenses/${editingId.value}`, body);
    else await cpost("/expenses", body);
    reset();
    await load();
  } catch (e) {
    error.value = errMsg(e);
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
    form.categoryId = c.id;
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function renameCategory(c: Category) {
  const name = prompt("Rename category", c.name);
  if (!name || name === c.name) return;
  try {
    await cpatch(`/expense-categories/${c.id}`, { name });
    await load();
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function deleteCategory(c: Category) {
  if (!confirm(`Delete category ${c.name}?`)) return;
  try {
    await cdelete(`/expense-categories/${c.id}`);
    await load();
  } catch (err) {
    error.value = errMsg(err);
  }
}

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Expenses</h1>
        <p class="text-muted text-sm mt-1">Money out. Amounts stay in the currency you paid in.</p>
      </div>
      <UButton variant="soft" color="neutral" icon="i-lucide-tags" @click="showCategories = !showCategories">Categories</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <UCard v-if="showCategories">
      <template #header><span class="font-medium">Expense categories</span></template>
      <div class="flex flex-wrap gap-2 mb-4">
        <UBadge v-for="c in categories" :key="c.id" variant="subtle" color="neutral" class="gap-1">
          {{ c.name }}
          <template v-if="isAdmin">
            <button class="ml-1 text-muted hover:text-white" title="Rename" @click="renameCategory(c)">✎</button>
            <button class="text-muted hover:text-red-400" title="Delete" @click="deleteCategory(c)">×</button>
          </template>
        </UBadge>
      </div>
      <form class="flex gap-2" @submit.prevent="addCategory">
        <UInput v-model="newCategory" placeholder="New category" />
        <UButton type="submit" variant="soft">Add</UButton>
      </form>
    </UCard>

    <UCard>
      <template #header><span class="font-medium">{{ editingId ? "Edit expense" : "Add expense" }}</span></template>
      <form class="grid gap-3 sm:grid-cols-4" @submit.prevent="save">
        <UFormField label="Date" required><UInput v-model="form.date" type="date" required class="w-full" /></UFormField>
        <UFormField label="Vendor" class="sm:col-span-2"><UInput v-model="form.vendor" class="w-full" placeholder="e.g. Afrihost" /></UFormField>
        <UFormField label="Category">
          <NSelect v-model="form.categoryId" placeholder="Uncategorised" :options="categories.map((c) => ({ label: c.name, value: c.id }))" />
        </UFormField>
        <UFormField label="Amount" required><UInput v-model="form.amount" type="number" step="0.01" min="0.01" required class="w-full" /></UFormField>
        <UFormField label="Currency">
          <NSelect v-model="form.currency" :options="currencies.map((c) => ({ label: c, value: c }))" />
        </UFormField>
        <UFormField label="Reference" class="sm:col-span-2"><UInput v-model="form.reference" class="w-full" /></UFormField>
        <UFormField label="Notes" class="sm:col-span-4"><UTextarea v-model="form.notes" :rows="2" class="w-full" /></UFormField>
        <UFormField label="Receipt (PDF or image, ≤ 700 KB)" class="sm:col-span-4">
          <div class="flex flex-wrap items-center gap-3">
            <input ref="fileInput" type="file" accept="application/pdf,image/*" class="text-sm" @change="onFile" />
            <UCheckbox v-if="editingId && expenses.find((x) => x.id === editingId)?.receipt" v-model="removeReceipt" label="Remove existing receipt" />
          </div>
        </UFormField>
        <div class="sm:col-span-4 flex gap-2">
          <UButton type="submit" :loading="saving">{{ editingId ? "Save changes" : "Add expense" }}</UButton>
          <UButton v-if="editingId" variant="ghost" color="neutral" @click="reset">Cancel</UButton>
        </div>
      </form>
    </UCard>

    <div class="flex flex-wrap gap-2 items-end">
      <UFormField label="From"><UInput v-model="filters.from" type="date" /></UFormField>
      <UFormField label="To"><UInput v-model="filters.to" type="date" /></UFormField>
      <UFormField label="Category" class="w-48"><NSelect v-model="filters.categoryId" placeholder="All" :options="categories.map((c) => ({ label: c.name, value: c.id }))" /></UFormField>
      <UFormField label="Currency" class="w-28"><NSelect v-model="filters.currency" placeholder="All" :options="currencies.map((c) => ({ label: c, value: c }))" /></UFormField>
      <UButton variant="soft" @click="load">Apply</UButton>
      <div class="ml-auto text-right">
        <p class="text-xs text-dimmed">Total shown</p>
        <MoneyList :value="totals" size="sm" />
      </div>
    </div>

    <div v-if="expenses.length" class="overflow-x-auto rounded-lg border border-default">
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase tracking-wide text-dimmed bg-elevated/60">
          <tr><th class="px-4 py-2">Date</th><th class="px-4 py-2">Vendor</th><th class="px-4 py-2">Category</th><th class="px-4 py-2 text-right">Amount</th><th class="px-4 py-2" /></tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="e in expenses" :key="e.id">
            <td class="px-4 py-2.5 whitespace-nowrap">{{ formatDate(e.date) }}</td>
            <td class="px-4 py-2.5">{{ e.vendor || "—" }}<span v-if="e.notes" class="block text-xs text-dimmed line-clamp-1">{{ e.notes }}</span></td>
            <td class="px-4 py-2.5 text-muted">{{ e.categoryName }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums">{{ formatCurrency(e.amount, e.currency) }}</td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <UButton v-if="e.receipt" size="xs" variant="ghost" icon="i-lucide-paperclip" @click="viewReceipt(e)" />
              <UButton size="xs" variant="soft" @click="edit(e)">Edit</UButton>
              <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" @click="remove(e)" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="text-sm text-dimmed">No expenses in this view.</p>
  </div>
</template>
