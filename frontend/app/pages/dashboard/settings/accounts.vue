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

const { activeCompanyId, capi, cpost, cpatch, cput } = useCompanyApi();
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
    await Promise.all([loadOpening(), loadRecentJournals()]);
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


// ---------- opening balances ----------

type OpeningLine = { accountId: string; debit: string; credit: string };
const opening = reactive({
  loading: false,
  saving: false,
  error: "",
  goLiveDate: "" as string | null,
  entryDate: "",
  lines: [] as OpeningLine[],
  entryId: "" as string | null,
});

const openingAccounts = computed(() =>
  accounts.value.filter(
    (a) =>
      a.active &&
      (a.type === "asset" || a.type === "liability" || a.type === "equity") &&
      !a.bank &&
      a.systemKey !== "debtors" &&
      a.systemKey !== "creditors" &&
      a.systemKey !== "undeposited_funds" &&
      a.systemKey !== "expense_clearing" &&
      a.systemKey !== "transfers_in_transit" &&
      a.systemKey !== "opening_balance_equity"
  )
);
const openingOptions = computed(() => openingAccounts.value.map((a) => ({ label: `${a.code} ${a.name}`, value: a.id })));

function moneyFromCents(cents: number) {
  return ((cents || 0) / 100).toFixed(2);
}

async function loadOpening() {
  if (!activeCompanyId.value) return;
  opening.loading = true;
  opening.error = "";
  try {
    const res = await capi<{
      goLiveDate: string | null;
      entry: { id: string; date: string; lines: { accountId: string; debit: number; credit: number; description?: string }[] } | null;
    }>("/ledger/opening-balances");
    opening.goLiveDate = res.goLiveDate;
    opening.entryId = res.entry?.id || null;
    opening.entryDate = res.entry?.date || res.goLiveDate || "";
    const skip = new Set(["opening_balance_equity"]);
    const accountsById = Object.fromEntries(accounts.value.map((a) => [a.id, a]));
    opening.lines = (res.entry?.lines || [])
      .filter((l) => accountsById[l.accountId]?.systemKey !== "opening_balance_equity")
      .map((l) => ({ accountId: l.accountId, debit: l.debit ? moneyFromCents(l.debit) : "", credit: l.credit ? moneyFromCents(l.credit) : "" }));
    if (!opening.lines.length) opening.lines = [{ accountId: "", debit: "", credit: "" }];
  } catch (e) {
    opening.error = errMsg(e);
  } finally {
    opening.loading = false;
  }
}

function addOpeningLine() {
  opening.lines.push({ accountId: "", debit: "", credit: "" });
}

async function saveOpening() {
  opening.saving = true;
  opening.error = "";
  try {
    const lines = opening.lines
      .filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)))
      .map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 }));
    const res = await cput<{ entry: { number?: string } | null }>("/ledger/opening-balances", { date: opening.entryDate || undefined, lines });
    toast.add({ title: res.entry ? "Opening balances saved" : "Opening balances cleared", description: res.entry?.number, color: "success", icon: "i-lucide-check" });
    await loadOpening();
  } catch (e) {
    opening.error = errMsg(e);
  } finally {
    opening.saving = false;
  }
}

// ---------- manual journals ----------

type JournalLine = { accountId: string; debit: string; credit: string; description: string };
const journal = reactive({
  open: false,
  saving: false,
  error: "",
  date: "",
  memo: "",
  lines: [
    { accountId: "", debit: "", credit: "", description: "" },
    { accountId: "", debit: "", credit: "", description: "" },
  ] as JournalLine[],
});
const recentJournals = ref<{ id: string; number: string; date: string; memo: string; totalCents: number; kind: string; reversed?: boolean }[]>([]);

const journalAccounts = computed(() =>
  accounts.value.filter(
    (a) =>
      a.active &&
      a.systemKey !== "debtors" &&
      a.systemKey !== "creditors" &&
      a.systemKey !== "undeposited_funds" &&
      a.systemKey !== "expense_clearing" &&
      a.systemKey !== "transfers_in_transit"
  )
);
const journalOptions = computed(() => journalAccounts.value.map((a) => ({ label: `${a.code} ${a.name}`, value: a.id })));

async function loadRecentJournals() {
  if (!activeCompanyId.value) return;
  try {
    const res = await capi<{ journals: typeof recentJournals.value }>("/journals?sourceType=manual");
    recentJournals.value = (res.journals || []).filter((j) => j.kind === "manual" || j.kind === "reversal").slice().reverse().slice(0, 10);
  } catch {
    recentJournals.value = [];
  }
}

function openJournal() {
  Object.assign(journal, {
    open: true,
    saving: false,
    error: "",
    date: "",
    memo: "",
    lines: [
      { accountId: "", debit: "", credit: "", description: "" },
      { accountId: "", debit: "", credit: "", description: "" },
    ],
  });
}

function addJournalLine() {
  journal.lines.push({ accountId: "", debit: "", credit: "", description: "" });
}

async function saveJournal() {
  journal.saving = true;
  journal.error = "";
  try {
    const lines = journal.lines
      .filter((l) => l.accountId && (Number(l.debit) || Number(l.credit)))
      .map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, description: l.description }));
    const res = await cpost<{ number: string; warning?: string }>("/journals", { date: journal.date || undefined, memo: journal.memo, lines });
    toast.add({ title: "Journal posted", description: res.warning ? `${res.number}. ${res.warning}` : res.number, color: res.warning ? "warning" : "success", icon: "i-lucide-check" });
    journal.open = false;
    await loadRecentJournals();
  } catch (e) {
    journal.error = errMsg(e);
  } finally {
    journal.saving = false;
  }
}

async function reverseJournal(id: string, number: string) {
  if (!confirm(`Reverse ${number}? Journals cannot be edited.`)) return;
  try {
    await cpost(`/journals/${id}/reverse`);
    toast.add({ title: "Journal reversed", description: number, color: "success", icon: "i-lucide-check" });
    await loadRecentJournals();
  } catch (e) {
    toast.add({ title: "Couldn't reverse", description: errMsg(e), color: "error", icon: "i-lucide-circle-alert" });
  }
}

watch(activeCompanyId, load, { immediate: true });
</script>

<template>
  <div class="mx-auto w-full max-w-4xl space-y-6">
    <PageHeader
      title="Chart of accounts"
      :info="`The accounts your books are kept in, in ${company?.baseCurrency || 'ZAR'}. System accounts are used by the app and can be renamed but not removed.`"
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

    <UCard>
      <template #header>
        <div>
          <p class="font-medium">Opening balances</p>
          <p class="text-xs text-dimmed">
            Optional balances as at {{ opening.goLiveDate || "the ledger go-live date" }}, in {{ company?.baseCurrency || "ZAR" }}.
            Bank openings are set on each bank account. The difference posts to Opening balance equity.
          </p>
        </div>
      </template>
      <UAlert v-if="opening.error" color="error" variant="subtle" :title="opening.error" class="mb-3" />
      <div class="space-y-3">
        <UFormField label="Date">
          <DatePicker v-model="opening.entryDate" block :disabled="!isAdmin" />
        </UFormField>
        <div v-for="(line, i) in opening.lines" :key="i" class="grid gap-2 sm:grid-cols-5 items-end">
          <UFormField label="Account" class="sm:col-span-3">
            <AppSelect v-model="line.accountId" searchable placeholder="Account" :options="openingOptions" :disabled="!isAdmin" />
          </UFormField>
          <UFormField label="Debit"><UInput v-model="line.debit" type="number" step="0.01" min="0" :disabled="!isAdmin" class="w-full" @update:model-value="line.credit = ''" /></UFormField>
          <UFormField label="Credit"><UInput v-model="line.credit" type="number" step="0.01" min="0" :disabled="!isAdmin" class="w-full" @update:model-value="line.debit = ''" /></UFormField>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton v-if="isAdmin" size="xs" variant="ghost" icon="i-lucide-plus" @click="addOpeningLine">Add line</UButton>
          <UButton v-if="isAdmin" :loading="opening.saving" @click="saveOpening">Save opening balances</UButton>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <div>
            <p class="font-medium">Manual journals</p>
            <p class="text-xs text-dimmed">Owner or admin only. Journals must balance in {{ company?.baseCurrency || "ZAR" }} and cannot be edited — reverse them instead.</p>
          </div>
          <UButton v-if="isAdmin" size="xs" icon="i-lucide-plus" @click="openJournal">New journal</UButton>
        </div>
      </template>
      <div v-if="recentJournals.length" class="divide-y divide-default">
        <div v-for="j in recentJournals" :key="j.id" class="flex flex-wrap items-center gap-3 py-2">
          <div class="flex-1 min-w-40">
            <p class="font-medium">{{ j.number }} <span class="text-muted font-normal">· {{ j.date }}</span></p>
            <p class="text-xs text-dimmed">{{ j.memo || (j.kind === "reversal" ? "Reversal" : "Manual journal") }}</p>
          </div>
          <UBadge v-if="j.kind === 'reversal' || j.reversed" size="sm" variant="subtle" color="neutral">{{ j.reversed ? "Reversed" : "Reversal" }}</UBadge>
          <UButton v-if="isAdmin && j.kind === 'manual' && !j.reversed" size="xs" variant="ghost" @click="reverseJournal(j.id, j.number)">Reverse</UButton>
        </div>
      </div>
      <p v-else class="text-sm text-dimmed">No manual journals yet.</p>
    </UCard>

    <USlideover v-model:open="journal.open" title="New journal" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <form id="journal-form" class="space-y-4" @submit.prevent="saveJournal">
          <UAlert v-if="journal.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="journal.error" />
          <UFormField label="Date"><DatePicker v-model="journal.date" block /></UFormField>
          <UFormField label="Memo" hint="Optional"><UInput v-model="journal.memo" class="w-full" /></UFormField>
          <div v-for="(line, i) in journal.lines" :key="i" class="space-y-2 rounded-lg border border-default p-3">
            <UFormField :label="`Line ${i + 1}`"><AppSelect v-model="line.accountId" searchable placeholder="Account" :options="journalOptions" /></UFormField>
            <div class="grid gap-2 sm:grid-cols-2">
              <UFormField label="Debit"><UInput v-model="line.debit" type="number" step="0.01" min="0" class="w-full" @update:model-value="line.credit = ''" /></UFormField>
              <UFormField label="Credit"><UInput v-model="line.credit" type="number" step="0.01" min="0" class="w-full" @update:model-value="line.debit = ''" /></UFormField>
            </div>
            <UFormField label="Description" hint="Optional"><UInput v-model="line.description" class="w-full" /></UFormField>
          </div>
          <UButton type="button" size="xs" variant="ghost" icon="i-lucide-plus" @click="addJournalLine">Add line</UButton>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="journal.open = false">Cancel</UButton>
          <UButton type="submit" form="journal-form" :loading="journal.saving">Post journal</UButton>
        </div>
      </template>
    </USlideover>

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
