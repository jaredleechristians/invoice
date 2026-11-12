<script setup lang="ts">
definePageMeta({ layout: "dashboard", middleware: "auth" });

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  description: string;
  systemKey: string | null;
  bankAccountId: string | null;
  currency: string;
  active: boolean;
  system: boolean;
  bank: boolean;
  locked: boolean;
};
type AccountType = { value: string; label: string; subtypes: string[] };
type Category = { id: string; name: string; accountId: string };

const { activeCompanyId, capi, cpost, cpatch } = useCompanyApi();
const { isAdmin, company, ensure } = useCompany();
const toast = useToast();

const accounts = ref<LedgerAccount[]>([]);
const types = ref<AccountType[]>([]);
const categories = ref<Category[]>([]);
const error = ref("");
const loading = ref(false);
const showArchived = ref(false);

const SUBTYPE_LABELS: Record<string, string> = {
  bank: "Bank",
  receivable: "Receivable",
  payable: "Payable",
  clearing: "Clearing",
  vat: "VAT",
  current_asset: "Current asset",
  fixed_asset: "Fixed asset",
  other_asset: "Other asset",
  current_liability: "Current liability",
  non_current_liability: "Non-current liability",
  equity: "Equity",
  retained_earnings: "Retained earnings",
  opening_balance: "Opening balance",
  sales: "Sales",
  other_income: "Other income",
  fx: "Exchange differences",
  operating_expense: "Operating expense",
  cost_of_sales: "Cost of sales",
  other_expense: "Other expense",
};
const subtypeLabel = (s: string) => SUBTYPE_LABELS[s] || s;

const grouped = computed(() =>
  types.value.map((t) => ({
    ...t,
    rows: accounts.value.filter((a) => a.type === t.value && (showArchived.value || a.active)),
  }))
);
const expenseOptions = computed(() =>
  accounts.value.filter((a) => a.type === "expense" && a.active).map((a) => ({ label: `${a.code} ${a.name}`, value: a.id }))
);

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await ensure();
    const [a, c] = await Promise.all([
      capi<{ accounts: LedgerAccount[]; types: AccountType[] }>("/accounts"),
      capi<{ categories: Category[] }>("/expense-categories"),
    ]);
    accounts.value = a.accounts;
    types.value = a.types;
    categories.value = c.categories;
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

// ---------- add / edit ----------

const formOpen = ref(false);
const formError = ref("");
const saving = ref(false);
const editing = ref<LedgerAccount | null>(null);
const blank = () => ({ code: "", name: "", type: "expense", subtype: "", description: "" });
const form = reactive(blank());

const typeOptions = computed(() => types.value.map((t) => ({ label: t.label, value: t.value })));
const subtypeOptions = computed(() => (types.value.find((t) => t.value === form.type)?.subtypes || []).map((s) => ({ label: subtypeLabel(s), value: s })));
watch(() => form.type, (t, prev) => {
  if (prev && t !== prev && !subtypeOptions.value.some((o) => o.value === form.subtype)) form.subtype = "";
});

function openNew(type = "expense") {
  editing.value = null;
  formError.value = "";
  Object.assign(form, blank(), { type });
  formOpen.value = true;
}

function edit(a: LedgerAccount) {
  editing.value = a;
  formError.value = "";
  Object.assign(form, { code: a.code, name: a.name, type: a.type, subtype: a.subtype, description: a.description || "" });
  formOpen.value = true;
}

async function save() {
  saving.value = true;
  formError.value = "";
  try {
    const a = editing.value;
    if (a) {
      const body: Record<string, string> = { code: form.code, description: form.description };
      if (!a.bank) body.name = form.name;
      if (!a.locked) Object.assign(body, { type: form.type, subtype: form.subtype });
      await cpatch(`/accounts/${a.id}`, body);
    } else {
      await cpost("/accounts", { ...form });
    }
    toast.add({ title: a ? "Account updated" : "Account added", description: `${form.code} ${form.name}`, color: "success", icon: "i-lucide-check" });
    formOpen.value = false;
    await load();
  } catch (e) {
    formError.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function setArchived(a: LedgerAccount, archived: boolean) {
  if (archived && !confirm(`Archive ${a.code} ${a.name}? It stays in the books but can't be picked for anything new.`)) return;
  try {
    await cpost(`/accounts/${a.id}/${archived ? "archive" : "unarchive"}`);
    toast.add({ title: archived ? "Account archived" : "Account restored", description: `${a.code} ${a.name}`, color: "success", icon: "i-lucide-check" });
    await load();
  } catch (e) {
    toast.add({ title: archived ? "Couldn't archive" : "Couldn't restore", description: errMsg(e), color: "error", icon: "i-lucide-circle-alert" });
  }
}

// ---------- expense category mapping ----------

async function mapCategory(c: Category, accountId: string) {
  if (!accountId || accountId === c.accountId) return;
  try {
    await cpatch(`/expense-categories/${c.id}`, { accountId });
    c.accountId = accountId;
    toast.add({ title: "Category mapped", description: c.name, color: "success", icon: "i-lucide-check" });
  } catch (e) {
    toast.add({ title: "Couldn't map category", description: errMsg(e), color: "error", icon: "i-lucide-circle-alert" });
  }
}

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-4xl space-y-6">
    <PageHeader
      title="Chart of accounts"
      :info="`The accounts your books are kept in, in ${company?.baseCurrency || 'ZAR'}. System accounts are used by the app and can be renamed but not removed. Nothing posts to the ledger yet.`"
    >
      <template #filters>
        <UCheckbox v-model="showArchived" label="Show archived" />
      </template>
      <UButton to="/dashboard/settings" variant="ghost" color="neutral" icon="i-lucide-arrow-left">Settings</UButton>
      <UButton v-if="isAdmin" icon="i-lucide-plus" @click="openNew()">Add account</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="!isAdmin" color="warning" variant="subtle" title="Only owners and admins can change the chart of accounts." />

    <UCard v-for="g in grouped" :key="g.value">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="font-medium">{{ g.label }}</span>
          <UButton v-if="isAdmin" size="xs" variant="ghost" icon="i-lucide-plus" @click="openNew(g.value)">Add</UButton>
        </div>
      </template>
      <div class="divide-y divide-default">
        <div v-for="a in g.rows" :key="a.id" class="flex flex-wrap items-center gap-3 py-2" :class="a.active ? '' : 'opacity-60'">
          <span class="w-12 font-mono text-sm tabular-nums text-muted">{{ a.code }}</span>
          <div class="flex-1 min-w-48">
            <p class="font-medium text-highlighted">
              {{ a.name }}
              <UBadge v-if="a.system" size="sm" variant="subtle" color="primary">System</UBadge>
              <UBadge v-if="a.bank" size="sm" variant="subtle" color="info">Bank · {{ a.currency }}</UBadge>
              <UBadge v-if="!a.active" size="sm" variant="subtle" color="neutral">Archived</UBadge>
            </p>
            <p class="text-xs text-dimmed">{{ subtypeLabel(a.subtype) }}<template v-if="a.description"> · {{ a.description }}</template></p>
          </div>
          <div v-if="isAdmin" class="flex gap-1">
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Edit" @click="edit(a)" />
            <template v-if="!a.locked">
              <UButton v-if="a.active" size="xs" variant="ghost" color="neutral" icon="i-lucide-archive" aria-label="Archive" @click="setArchived(a, true)" />
              <UButton v-else size="xs" variant="ghost" color="neutral" icon="i-lucide-archive-restore" aria-label="Restore" @click="setArchived(a, false)" />
            </template>
          </div>
        </div>
        <p v-if="!g.rows.length" class="py-3 text-sm text-dimmed">{{ loading ? "Loading…" : "No accounts." }}</p>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div>
          <p class="font-medium">Expense categories</p>
          <p class="text-xs text-dimmed">Which expense account each category posts to. Products pick their income account on the product itself.</p>
        </div>
      </template>
      <div class="divide-y divide-default">
        <div v-for="c in categories" :key="c.id" class="flex flex-wrap items-center gap-3 py-2">
          <span class="flex-1 min-w-40">{{ c.name }}</span>
          <div class="w-full sm:w-72">
            <AppSelect
              :model-value="c.accountId"
              :options="expenseOptions"
              searchable
              :disabled="!isAdmin"
              @update:model-value="mapCategory(c, String($event))"
            />
          </div>
        </div>
        <p v-if="!categories.length" class="py-3 text-sm text-dimmed">No categories yet.</p>
      </div>
    </UCard>

    <USlideover v-model:open="formOpen" :title="editing ? 'Edit account' : 'Add account'" :ui="{ content: 'sm:max-w-md' }">
      <template #body>
        <form id="account-form" class="space-y-4" @submit.prevent="save">
          <UAlert v-if="formError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="formError" />
          <UAlert
            v-if="editing?.locked"
            color="info"
            variant="subtle"
            :title="editing.bank ? 'Linked to a bank account. Rename it in Settings > Bank accounts.' : 'System account: you can rename and recode it, but not change its type.'"
          />
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField label="Code" required :help="editing?.bank ? '1001-1099' : '4 digits'">
              <UInput v-model="form.code" inputmode="numeric" maxlength="4" required class="w-full font-mono" />
            </UFormField>
            <UFormField label="Name" required class="sm:col-span-2">
              <UInput v-model="form.name" required :disabled="editing?.bank" autofocus class="w-full" />
            </UFormField>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Type">
              <AppSelect v-model="form.type" :options="typeOptions" :disabled="editing?.locked" />
            </UFormField>
            <UFormField label="Group">
              <AppSelect v-if="!editing?.locked" v-model="form.subtype" placeholder="Default" :options="subtypeOptions" />
              <UInput v-else :model-value="subtypeLabel(form.subtype)" disabled class="w-full" />
            </UFormField>
          </div>
          <UFormField label="Description"><UTextarea v-model="form.description" :rows="2" class="w-full" /></UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="formOpen = false">Cancel</UButton>
          <UButton type="submit" form="account-form" :loading="saving">{{ editing ? "Save changes" : "Add account" }}</UButton>
        </div>
      </template>
    </USlideover>
  </div>
</template>
