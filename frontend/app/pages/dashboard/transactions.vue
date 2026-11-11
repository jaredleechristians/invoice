<script setup lang="ts">
import { datePresets, formatCurrency, formatDate } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type BankAccount = {
  id: string;
  name: string;
  bank: string;
  currency: string;
  accountLast4: string;
  openingBalance: number;
  openingDate: string;
  balance: number;
  transactionCount: number;
  unreconciledCount: number;
};
type Tx = {
  id: string;
  accountId: string;
  importId: string;
  date: string;
  amount: number;
  currency: string;
  description: string;
  reference: string;
  status: string;
  matchLabel?: string;
  note?: string;
  paymentId?: string;
  invoiceId?: string;
  expenseId?: string;
  transferPairId?: string;
  created?: { type: "payment" | "expense"; id: string } | null;
};
type Mapping = { headerRow: number; date: number; description: number; amount: number; debit: number; credit: number; reference: number; dateFormat: string; invertAmount: boolean };
type Preview = {
  format: "ofx" | "csv";
  headers: string[];
  sample: string[][];
  mapping: Mapping | null;
  skipped: number;
  total: number;
  newCount: number;
  duplicateCount: number;
  from: string;
  to: string;
  warnings: string[];
  transactions: { date: string; amount: number; description: string; reference: string; duplicate: boolean }[];
};
type InvoiceOption = { id: string; invoiceNumber: string; customerName: string; currency: string; total: number; outstanding: number; issueDate: string; exchangeRate: number | null; score: number };
type PaymentOption = { id: string; invoiceNumber: string; customerName: string; amount: number; currency: string; paidAt: string; score: number };
type ExpenseOption = { id: string; date: string; vendor: string; categoryName: string; amount: number; currency: string; score: number };
type TransferOption = { id: string; accountId: string; date: string; amount: number; currency: string; description: string; score: number };
type Suggestions = {
  invoices: InvoiceOption[];
  payments: PaymentOption[];
  expenses: ExpenseOption[];
  transfers: TransferOption[];
  categories: { id: string; name: string }[];
};
type ImportRecord = { id: string; accountId: string; filename: string; format: string; importedCount: number; duplicateCount: number; from: string; to: string; createdAt: string };

const BANK_LABELS: Record<string, string> = { standard_bank: "Standard Bank", wise: "Wise", other: "Other" };
const STATUS_LABELS: Record<string, string> = {
  unreconciled: "Unreconciled",
  processing: "Unreconciled",
  matched: "Matched",
  categorised: "Categorised",
  transfer: "Transfer",
  ignored: "Ignored",
};
const STATUS_COLORS: Record<string, "warning" | "success" | "info" | "neutral"> = {
  unreconciled: "warning",
  processing: "warning",
  matched: "success",
  categorised: "success",
  transfer: "info",
  ignored: "neutral",
};
const STATUS_OPTIONS = ["unreconciled", "matched", "categorised", "transfer", "ignored"].map((s) => ({ label: STATUS_LABELS[s]!, value: s }));

const { activeCompanyId, capi, cpost, cpatch, cdelete } = useCompanyApi();
const { company, currencies, ensure, isAdmin } = useCompany();
const toast = useToast();

const accounts = ref<BankAccount[]>([]);
const txs = ref<Tx[]>([]);
const error = ref("");
const loading = ref(false);
const loaded = ref(false);
const filters = reactive({ accountId: "", status: "", from: "", to: "", q: "" });
const search = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, (v) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => (filters.q = v.trim()), 300);
});
const filterRange = computed({
  get: () => ({ from: filters.from, to: filters.to }),
  set: (v: { from: string; to: string }) => Object.assign(filters, v),
});
const DATE_PRESETS = computed(() => datePresets(undefined, company.value?.taxYearEndMonth));
watch(() => ({ ...filters }), () => loadTransactions(), { deep: true });

const accountById = computed(() => Object.fromEntries(accounts.value.map((a) => [a.id, a])));
const accountOptions = computed(() => accounts.value.map((a) => ({ label: accountLabel(a), value: a.id })));
function accountLabel(a?: BankAccount) {
  if (!a) return "Unknown account";
  return a.accountLast4 ? `${a.name} (${a.accountLast4})` : a.name;
}

async function loadAccounts() {
  const res = await capi<{ accounts: BankAccount[] }>("/bank-accounts");
  accounts.value = res.accounts;
}

async function loadTransactions() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
    const res = await capi<{ transactions: Tx[] }>(`/bank-transactions${params.toString() ? `?${params}` : ""}`);
    txs.value = res.transactions;
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

async function load() {
  if (!activeCompanyId.value) return;
  error.value = "";
  try {
    await ensure();
    await loadAccounts();
    if (filters.accountId && !accountById.value[filters.accountId]) filters.accountId = "";
    await loadTransactions();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loaded.value = true;
  }
}

const totals = computed(() => {
  const inn: Record<string, number> = {};
  const out: Record<string, number> = {};
  for (const t of txs.value) {
    const map = t.amount > 0 ? inn : out;
    map[t.currency] = Math.round(((map[t.currency] || 0) + Math.abs(t.amount)) * 100) / 100;
  }
  return { inn, out };
});

// ---------- bank accounts ----------

const accountForm = reactive({
  open: false,
  id: "",
  name: "",
  bank: "standard_bank",
  currency: "ZAR",
  accountLast4: "",
  openingBalance: "" as string | number,
  openingDate: "",
  saving: false,
  error: "",
});
const BANK_OPTIONS = Object.entries(BANK_LABELS).map(([value, label]) => ({ label, value }));

function openAccount(a?: BankAccount) {
  Object.assign(accountForm, {
    open: true,
    id: a?.id || "",
    name: a?.name || "",
    bank: a?.bank || "standard_bank",
    currency: a?.currency || company.value?.defaultCurrency || "ZAR",
    accountLast4: a?.accountLast4 || "",
    openingBalance: a ? a.openingBalance : "",
    openingDate: a?.openingDate || "",
    saving: false,
    error: "",
  });
}

async function saveAccount() {
  accountForm.saving = true;
  accountForm.error = "";
  try {
    const body = {
      name: accountForm.name,
      bank: accountForm.bank,
      currency: accountForm.currency,
      accountLast4: accountForm.accountLast4,
      openingBalance: Number(accountForm.openingBalance) || 0,
      openingDate: accountForm.openingDate,
    };
    if (accountForm.id) await cpatch(`/bank-accounts/${accountForm.id}`, body);
    else await cpost("/bank-accounts", body);
    toast.add({ title: accountForm.id ? "Account updated" : "Account added", description: accountForm.name, color: "success", icon: "i-lucide-check" });
    accountForm.open = false;
    await loadAccounts();
  } catch (e) {
    accountForm.error = errMsg(e);
  } finally {
    accountForm.saving = false;
  }
}

async function deleteAccount() {
  if (!confirm(`Delete ${accountForm.name}?`)) return;
  try {
    await cdelete(`/bank-accounts/${accountForm.id}`);
    accountForm.open = false;
    if (filters.accountId === accountForm.id) filters.accountId = "";
    await loadAccounts();
  } catch (e) {
    accountForm.error = errMsg(e);
  }
}

// ---------- import ----------

const imp = reactive({
  open: false,
  accountId: "",
  file: null as File | null,
  filename: "",
  content: "",
  mapping: null as Mapping | null,
  preview: null as Preview | null,
  loading: false,
  committing: false,
  error: "",
});

function openImport() {
  Object.assign(imp, {
    open: true,
    accountId: filters.accountId || accounts.value[0]?.id || "",
    file: null,
    filename: "",
    content: "",
    mapping: null,
    preview: null,
    loading: false,
    committing: false,
    error: "",
  });
}

watch(
  () => imp.file,
  async (f) => {
    imp.preview = null;
    imp.mapping = null;
    imp.error = "";
    if (!f) {
      imp.content = "";
      return;
    }
    if (f.size > 1_500_000) {
      imp.error = "File is too large (max 1.5 MB). Export a shorter date range.";
      return;
    }
    imp.filename = f.name;
    imp.content = await f.text();
    await runPreview();
  }
);
watch(() => imp.accountId, () => imp.content && runPreview());
watch(() => (imp.mapping ? JSON.stringify(imp.mapping) : ""), (v, old) => {
  if (v && old && imp.content) runPreview();
});

async function runPreview() {
  if (!imp.accountId || !imp.content) return;
  imp.loading = true;
  imp.error = "";
  try {
    const res = await cpost<Preview>("/bank-imports/preview", {
      accountId: imp.accountId,
      content: imp.content,
      filename: imp.filename,
      mapping: imp.mapping || undefined,
    });
    imp.preview = res;
    if (res.mapping && !imp.mapping) imp.mapping = { ...res.mapping };
  } catch (e) {
    imp.preview = null;
    imp.error = errMsg(e);
  } finally {
    imp.loading = false;
  }
}

const columnOptions = computed(() => [
  { label: "None", value: -1 },
  ...(imp.preview?.headers || []).map((h, i) => ({ label: h || `Column ${i + 1}`, value: i })),
]);
const DATE_FORMATS = [
  { label: "Auto (day first)", value: "auto" },
  { label: "DD/MM/YYYY", value: "dmy" },
  { label: "MM/DD/YYYY", value: "mdy" },
  { label: "YYYY-MM-DD", value: "ymd" },
];
const useDebitCredit = computed({
  get: () => Boolean(imp.mapping && imp.mapping.amount < 0),
  set: (v: boolean) => {
    if (!imp.mapping) return;
    if (v) imp.mapping.amount = -1;
    else {
      imp.mapping.debit = -1;
      imp.mapping.credit = -1;
    }
  },
});
const importAccount = computed(() => accountById.value[imp.accountId]);

async function commitImport() {
  imp.committing = true;
  imp.error = "";
  try {
    const res = await cpost<{ import: { importedCount: number; duplicateCount: number } }>("/bank-imports", {
      accountId: imp.accountId,
      content: imp.content,
      filename: imp.filename,
      mapping: imp.mapping || undefined,
    });
    const { importedCount, duplicateCount } = res.import;
    toast.add({
      title: `Imported ${importedCount} ${importedCount === 1 ? "line" : "lines"}`,
      description: duplicateCount ? `${duplicateCount} already imported, skipped` : undefined,
      color: "success",
      icon: "i-lucide-check",
    });
    imp.open = false;
    filters.accountId = imp.accountId;
    await load();
  } catch (e) {
    imp.error = errMsg(e);
  } finally {
    imp.committing = false;
  }
}

// ---------- import history ----------

const history = reactive({ open: false, rows: [] as ImportRecord[], error: "" });
async function openHistory() {
  history.open = true;
  history.error = "";
  try {
    const res = await capi<{ imports: ImportRecord[] }>(`/bank-imports${filters.accountId ? `?accountId=${filters.accountId}` : ""}`);
    history.rows = res.imports;
  } catch (e) {
    history.error = errMsg(e);
  }
}
async function deleteImport(r: ImportRecord) {
  if (!confirm(`Delete the ${r.importedCount} lines from ${r.filename || "this import"}?`)) return;
  try {
    await cdelete(`/bank-imports/${r.id}`);
    await openHistory();
    await load();
  } catch (e) {
    history.error = errMsg(e);
  }
}

// ---------- reconcile ----------

const rec = reactive({
  open: false,
  tx: null as Tx | null,
  sug: null as Suggestions | null,
  tab: "invoice",
  loading: false,
  saving: false,
  error: "",
  invoiceId: "",
  amount: "" as string | number,
  invoiceRate: "" as string | number,
  paymentId: "",
  categoryId: "",
  vendor: "",
  notes: "",
  expenseId: "",
  pairId: "",
  note: "",
});

const moneyIn = computed(() => (rec.tx?.amount || 0) > 0);
const recTabs = computed(() =>
  moneyIn.value
    ? [
        { label: "Invoice", value: "invoice" },
        { label: "Payment", value: "payment" },
        { label: "Transfer", value: "transfer" },
        { label: "Ignore", value: "ignore" },
      ]
    : [
        { label: "New expense", value: "expense" },
        { label: "Expense", value: "match_expense" },
        { label: "Transfer", value: "transfer" },
        { label: "Ignore", value: "ignore" },
      ]
);

async function openReconcile(t: Tx) {
  Object.assign(rec, {
    open: true,
    tx: t,
    sug: null,
    tab: t.amount > 0 ? "invoice" : "expense",
    loading: true,
    saving: false,
    error: "",
    invoiceId: "",
    amount: "",
    invoiceRate: "",
    paymentId: "",
    categoryId: "",
    vendor: t.description,
    notes: "",
    expenseId: "",
    pairId: "",
    note: "",
  });
  try {
    const s = await capi<Suggestions>(`/bank-transactions/${t.id}/suggestions`);
    rec.sug = s;
    const best = (list: { id: string; score: number }[]) => (list[0] && list[0].score >= 50 ? list[0].id : "");
    rec.invoiceId = best(s.invoices) || (s.invoices[0] && s.invoices[0].score >= 40 ? s.invoices[0].id : "");
    rec.paymentId = best(s.payments);
    rec.expenseId = best(s.expenses);
    rec.pairId = best(s.transfers);
  } catch (e) {
    rec.error = errMsg(e);
  } finally {
    rec.loading = false;
  }
}

const selectedInvoice = computed(() => rec.sug?.invoices.find((i) => i.id === rec.invoiceId) || null);
watch(selectedInvoice, (inv) => {
  if (!inv || !rec.tx) return;
  rec.amount = inv.currency === rec.tx.currency ? Math.min(rec.tx.amount, inv.outstanding) : inv.outstanding;
  rec.invoiceRate = inv.exchangeRate || "";
});
const foreignInvoice = computed(() => Boolean(selectedInvoice.value && rec.tx && selectedInvoice.value.currency !== rec.tx.currency));
const forexPreview = computed(() => {
  const inv = selectedInvoice.value;
  const tx = rec.tx;
  const amount = Number(rec.amount);
  if (!inv || !tx || !foreignInvoice.value || tx.currency !== "ZAR" || !(amount > 0)) return null;
  const receivedRate = tx.amount / amount;
  const rate = Number(rec.invoiceRate);
  if (!(rate > 0)) return { receivedRate, gain: null as number | null, atInvoice: null as number | null };
  const atInvoice = Math.round(amount * rate * 100) / 100;
  return { receivedRate, atInvoice, gain: Math.round((tx.amount - atInvoice) * 100) / 100 };
});

const invoiceOptions = computed(() =>
  (rec.sug?.invoices || []).map((i) => ({
    label: `${i.invoiceNumber || "Invoice"} · ${i.customerName || "No customer"} · ${formatCurrency(i.outstanding, i.currency)} due`,
    value: i.id,
    description: i.score >= 50 ? "Likely match" : undefined,
  }))
);
const paymentOptions = computed(() =>
  (rec.sug?.payments || []).map((p) => ({
    label: `${formatDate(p.paidAt)} · ${formatCurrency(p.amount, p.currency)} · ${p.invoiceNumber || ""} ${p.customerName || ""}`.trim(),
    value: p.id,
    description: p.score >= 50 ? "Likely match" : undefined,
  }))
);
const expenseOptions = computed(() =>
  (rec.sug?.expenses || []).map((e) => ({
    label: `${formatDate(e.date)} · ${e.vendor || "No vendor"} · ${formatCurrency(e.amount, e.currency)}`,
    value: e.id,
    description: e.score >= 50 ? "Likely match" : e.categoryName,
  }))
);
const transferOptions = computed(() =>
  (rec.sug?.transfers || []).map((t) => ({
    label: `${formatDate(t.date)} · ${accountLabel(accountById.value[t.accountId])} · ${formatCurrency(t.amount, t.currency)}`,
    value: t.id,
    description: t.description,
  }))
);

async function submitReconcile() {
  const tx = rec.tx;
  if (!tx) return;
  const bodies: Record<string, Record<string, unknown>> = {
    invoice: { action: "match_invoice", invoiceId: rec.invoiceId, amount: Number(rec.amount), invoiceRate: rec.invoiceRate === "" ? undefined : Number(rec.invoiceRate) },
    payment: { action: "match_payment", paymentId: rec.paymentId },
    expense: { action: "create_expense", categoryId: rec.categoryId, vendor: rec.vendor, notes: rec.notes },
    match_expense: { action: "match_expense", expenseId: rec.expenseId },
    transfer: { action: "transfer", pairTransactionId: rec.pairId || undefined },
    ignore: { action: "ignore", note: rec.note },
  };
  rec.saving = true;
  rec.error = "";
  try {
    await cpost(`/bank-transactions/${tx.id}/reconcile`, bodies[rec.tab]);
    toast.add({ title: "Reconciled", description: `${formatDate(tx.date)} · ${formatCurrency(tx.amount, tx.currency)}`, color: "success", icon: "i-lucide-check" });
    rec.open = false;
    await load();
  } catch (e) {
    rec.error = errMsg(e);
  } finally {
    rec.saving = false;
  }
}

const canSubmit = computed(() => {
  switch (rec.tab) {
    case "invoice":
      return Boolean(rec.invoiceId && Number(rec.amount) > 0);
    case "payment":
      return Boolean(rec.paymentId);
    case "match_expense":
      return Boolean(rec.expenseId);
    default:
      return true;
  }
});

// ---------- undo ----------

const undoState = reactive({ open: false, tx: null as Tx | null, saving: false, error: "" });

async function undo(t: Tx) {
  if (t.created?.id) {
    Object.assign(undoState, { open: true, tx: t, saving: false, error: "" });
    return;
  }
  if (!confirm("Undo this reconciliation?")) return;
  await runUndo(t, undefined);
}

async function runUndo(t: Tx, deleteCreated: boolean | undefined) {
  undoState.saving = true;
  undoState.error = "";
  try {
    await cpost(`/bank-transactions/${t.id}/undo`, deleteCreated === undefined ? {} : { deleteCreated });
    toast.add({ title: "Undone", color: "neutral", icon: "i-lucide-undo-2" });
    undoState.open = false;
    await load();
  } catch (e) {
    if (undoState.open) undoState.error = errMsg(e);
    else error.value = errMsg(e);
  } finally {
    undoState.saving = false;
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Bank lines to reconcile. Income and expenses still come from payments and expenses, so transfers never count as income.">
      <template v-if="accounts.length" #filters>
        <div class="w-full sm:w-48"><AppSelect v-model="filters.accountId" placeholder="All accounts" :options="accountOptions" /></div>
        <div class="w-full sm:w-36"><AppSelect v-model="filters.status" placeholder="Any status" :options="STATUS_OPTIONS" /></div>
        <DatePicker v-model="filterRange" range :presets="DATE_PRESETS" clearable placeholder="All dates" />
        <UInput v-model="search" icon="i-lucide-search" placeholder="Search" class="w-full sm:w-44" />
      </template>
      <template v-if="accounts.length" #default>
        <UTooltip text="Import history">
          <UButton variant="ghost" color="neutral" icon="i-lucide-history" aria-label="Import history" @click="openHistory" />
        </UTooltip>
        <UButton v-if="isAdmin" variant="soft" color="neutral" icon="i-lucide-plus" @click="openAccount()">Add bank account</UButton>
        <UButton icon="i-lucide-upload" @click="openImport">Import</UButton>
      </template>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />

    <UCard v-if="loaded && !error && !accounts.length" class="mx-auto max-w-lg text-center" :ui="{ body: 'py-10 space-y-4' }">
      <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
        <UIcon name="i-lucide-landmark" class="size-6 text-primary" />
      </div>
      <div class="space-y-1">
        <p class="font-medium text-highlighted">Add your first bank account</p>
        <p class="text-sm text-muted">Then import a statement (OFX or CSV) and match each line to invoices, payments or expenses.</p>
      </div>
      <UButton v-if="isAdmin" icon="i-lucide-plus" @click="openAccount()">Add bank account</UButton>
      <p v-else class="text-sm text-dimmed">Ask an owner or admin to add one.</p>
    </UCard>

    <div v-else-if="accounts.length" class="flex gap-3 overflow-x-auto pb-1">
      <button
        v-for="a in accounts"
        :key="a.id"
        type="button"
        class="group w-56 shrink-0 rounded-lg border px-3 py-2 text-left transition hover:bg-elevated/50"
        :class="filters.accountId === a.id ? 'border-primary bg-primary/5' : 'border-default'"
        @click="filters.accountId = filters.accountId === a.id ? '' : a.id"
      >
        <div class="flex items-center gap-1">
          <p class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ a.name }}</p>
          <UButton v-if="isAdmin" size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Edit account" class="opacity-0 group-hover:opacity-100 focus:opacity-100" @click.stop="openAccount(a)" />
        </div>
        <p class="truncate text-xs text-dimmed">{{ BANK_LABELS[a.bank] || "Other" }}{{ a.accountLast4 ? ` · ${a.accountLast4}` : "" }} · {{ a.currency }}</p>
        <div class="mt-1 flex items-center justify-between gap-2">
          <span class="tabular-nums text-highlighted">{{ formatCurrency(a.balance, a.currency) }}</span>
          <UBadge v-if="a.unreconciledCount" color="warning" variant="subtle" size="sm">{{ a.unreconciledCount }} to do</UBadge>
          <UIcon v-else-if="a.transactionCount" name="i-lucide-circle-check" class="size-4 text-success" />
        </div>
      </button>
    </div>

    <div v-if="txs.length" class="flex flex-wrap items-center justify-end gap-6 text-right">
      <div>
        <p class="text-xs text-dimmed">Money in</p>
        <MoneyList :value="totals.inn" size="sm" />
      </div>
      <div>
        <p class="text-xs text-dimmed">Money out</p>
        <MoneyList :value="totals.out" size="sm" />
      </div>
    </div>

    <UTable
      v-if="accounts.length"
      :data="txs"
      :loading="loading"
      :columns="[
        { accessorKey: 'date', header: 'Date' },
        { accessorKey: 'description', header: 'Description' },
        ...(filters.accountId ? [] : [{ accessorKey: 'accountId', header: 'Account' }]),
        { accessorKey: 'amount', header: 'Amount', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'status', header: 'Status' },
        { id: 'actions', header: '', meta: { class: { th: 'text-right', td: 'text-right' } } },
      ]"
      class="rounded-lg border border-default"
      :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #date-cell="{ row }"><span class="whitespace-nowrap">{{ formatDate(row.original.date) }}</span></template>
      <template #description-cell="{ row }">
        <span class="text-highlighted line-clamp-1">{{ row.original.description || "-" }}</span>
        <span v-if="row.original.reference" class="block text-xs text-dimmed line-clamp-1">{{ row.original.reference }}</span>
        <span v-if="row.original.matchLabel && row.original.status !== 'unreconciled'" class="block text-xs text-muted line-clamp-1">{{ row.original.matchLabel }}</span>
      </template>
      <template #accountId-cell="{ row }"><span class="text-muted whitespace-nowrap">{{ accountById[row.original.accountId]?.name || "-" }}</span></template>
      <template #amount-cell="{ row }">
        <span class="tabular-nums whitespace-nowrap" :class="row.original.amount > 0 ? 'text-success' : ''">{{ formatCurrency(row.original.amount, row.original.currency) }}</span>
      </template>
      <template #status-cell="{ row }">
        <UBadge :color="STATUS_COLORS[row.original.status] || 'neutral'" variant="subtle" size="sm">{{ STATUS_LABELS[row.original.status] || row.original.status }}</UBadge>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton v-if="row.original.status === 'unreconciled'" size="xs" variant="soft" @click="openReconcile(row.original)">Reconcile</UButton>
          <UButton v-else size="xs" variant="ghost" color="neutral" icon="i-lucide-undo-2" @click="undo(row.original)">Undo</UButton>
        </div>
      </template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No transactions. Import a statement to start.</p></template>
    </UTable>

    <!-- Bank account -->
    <UModal v-model:open="accountForm.open" :title="accountForm.id ? 'Edit bank account' : 'Add bank account'">
      <template #body>
        <form id="bank-account-form" class="space-y-4" @submit.prevent="saveAccount">
          <UAlert v-if="accountForm.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="accountForm.error" />
          <UFormField label="Name" required><UInput v-model="accountForm.name" placeholder="e.g. Business cheque" autofocus class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Bank"><AppSelect v-model="accountForm.bank" :options="BANK_OPTIONS" /></UFormField>
            <UFormField label="Currency"><AppSelect v-model="accountForm.currency" :options="currencies.map((c) => ({ label: c, value: c }))" /></UFormField>
          </div>
          <UFormField label="Last 4 digits" hint="Optional"><UInput v-model="accountForm.accountLast4" maxlength="4" inputmode="numeric" class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Opening balance" hint="Optional"><UInput v-model="accountForm.openingBalance" type="number" step="0.01" class="w-full" /></UFormField>
            <UFormField label="Opening date" hint="Optional"><DatePicker v-model="accountForm.openingDate" block clearable /></UFormField>
          </div>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full items-center gap-2">
          <UButton v-if="accountForm.id" variant="ghost" color="error" icon="i-lucide-trash" @click="deleteAccount">Delete</UButton>
          <div class="ml-auto flex gap-2">
            <UButton variant="ghost" color="neutral" @click="accountForm.open = false">Cancel</UButton>
            <UButton type="submit" form="bank-account-form" :loading="accountForm.saving" :disabled="!accountForm.name.trim()">Save</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Import -->
    <USlideover v-model:open="imp.open" title="Import statement" description="OFX, QFX, QBO or CSV. Lines already imported are skipped." :ui="{ content: 'sm:max-w-3xl' }">
      <template #body>
        <div class="space-y-4">
          <UAlert v-if="imp.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="imp.error" />
          <UFormField label="Account"><AppSelect v-model="imp.accountId" :options="accountOptions" /></UFormField>
          <UFileUpload
            v-model="imp.file"
            accept=".ofx,.qfx,.qbo,.csv,.txt,text/csv,application/x-ofx"
            icon="i-lucide-file-spreadsheet"
            label="Drop a statement here"
            description="Standard Bank: OFX preferred, or the CSV export"
            layout="list"
            class="w-full min-h-28"
          />

          <div v-if="imp.preview?.format === 'csv' && imp.mapping" class="space-y-3 rounded-lg border border-default p-3">
            <p class="text-sm font-medium">Columns</p>
            <div class="grid gap-3 sm:grid-cols-3">
              <UFormField label="Date"><AppSelect v-model="imp.mapping.date" :options="columnOptions" /></UFormField>
              <UFormField label="Description"><AppSelect v-model="imp.mapping.description" :options="columnOptions" /></UFormField>
              <UFormField label="Reference"><AppSelect v-model="imp.mapping.reference" :options="columnOptions" /></UFormField>
              <template v-if="!useDebitCredit">
                <UFormField label="Amount"><AppSelect v-model="imp.mapping.amount" :options="columnOptions" /></UFormField>
              </template>
              <template v-else>
                <UFormField label="Money out (debit)"><AppSelect v-model="imp.mapping.debit" :options="columnOptions" /></UFormField>
                <UFormField label="Money in (credit)"><AppSelect v-model="imp.mapping.credit" :options="columnOptions" /></UFormField>
              </template>
              <UFormField label="Date format"><AppSelect v-model="imp.mapping.dateFormat" :options="DATE_FORMATS" /></UFormField>
            </div>
            <div class="flex flex-wrap gap-4">
              <UCheckbox v-model="useDebitCredit" label="Separate debit and credit columns" />
              <UCheckbox v-if="!useDebitCredit" v-model="imp.mapping.invertAmount" label="Money out is positive" />
            </div>
          </div>

          <div v-if="imp.preview" class="space-y-3">
            <UAlert v-for="w in imp.preview.warnings" :key="w" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="w" />
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <UBadge color="success" variant="subtle">{{ imp.preview.newCount }} new</UBadge>
              <UBadge color="neutral" variant="subtle">{{ imp.preview.duplicateCount }} already imported</UBadge>
              <UBadge v-if="imp.preview.skipped" color="warning" variant="subtle">{{ imp.preview.skipped }} rows skipped</UBadge>
              <span v-if="imp.preview.from" class="text-dimmed">{{ formatDate(imp.preview.from) }} to {{ formatDate(imp.preview.to) }}</span>
            </div>
            <div class="max-h-96 overflow-auto rounded-lg border border-default">
              <table class="w-full text-sm">
                <thead class="sticky top-0 bg-default text-xs uppercase tracking-wide text-dimmed">
                  <tr>
                    <th class="px-3 py-2 text-left">Date</th>
                    <th class="px-3 py-2 text-left">Description</th>
                    <th class="px-3 py-2 text-right">Amount</th>
                    <th class="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-default">
                  <tr v-for="(t, i) in imp.preview.transactions" :key="i" :class="t.duplicate ? 'text-dimmed' : ''">
                    <td class="px-3 py-1.5 whitespace-nowrap">{{ formatDate(t.date) }}</td>
                    <td class="px-3 py-1.5"><span class="line-clamp-1">{{ t.description || "-" }}</span></td>
                    <td class="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{{ formatCurrency(t.amount, importAccount?.currency || "ZAR") }}</td>
                    <td class="px-3 py-1.5 text-right"><span v-if="t.duplicate" class="text-xs">Duplicate</span></td>
                  </tr>
                  <tr v-if="!imp.preview.transactions.length"><td colspan="4" class="px-3 py-4 text-center text-dimmed">No lines found. Check the columns.</td></tr>
                </tbody>
              </table>
            </div>
            <p v-if="imp.preview.total > imp.preview.transactions.length" class="text-xs text-dimmed">Showing the first {{ imp.preview.transactions.length }} of {{ imp.preview.total }}.</p>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="imp.open = false">Cancel</UButton>
          <UButton icon="i-lucide-upload" :loading="imp.committing || imp.loading" :disabled="!imp.preview || !imp.preview.newCount" @click="commitImport">
            Import {{ imp.preview?.newCount || "" }} {{ imp.preview?.newCount === 1 ? "line" : "lines" }}
          </UButton>
        </div>
      </template>
    </USlideover>

    <!-- Import history -->
    <USlideover v-model:open="history.open" title="Imports" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="history.error" color="error" variant="subtle" :title="history.error" />
          <div class="rounded-lg border border-default divide-y divide-default">
            <div v-for="r in history.rows" :key="r.id" class="flex items-center gap-2 px-3 py-2">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-highlighted">{{ r.filename || r.format.toUpperCase() }}</p>
                <p class="text-xs text-dimmed">
                  {{ accountById[r.accountId]?.name || "-" }} · {{ r.importedCount }} new, {{ r.duplicateCount }} skipped
                  <template v-if="r.from"> · {{ formatDate(r.from) }} to {{ formatDate(r.to) }}</template>
                </p>
              </div>
              <UButton v-if="isAdmin && r.importedCount" size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Delete import" @click="deleteImport(r)" />
            </div>
            <p v-if="!history.rows.length" class="px-3 py-4 text-sm text-dimmed">No imports yet.</p>
          </div>
        </div>
      </template>
    </USlideover>

    <!-- Reconcile -->
    <USlideover v-model:open="rec.open" title="Reconcile" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <div v-if="rec.tx" class="space-y-4">
          <div class="rounded-lg border border-default p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-highlighted">{{ rec.tx.description || "-" }}</p>
                <p class="text-xs text-dimmed">{{ formatDate(rec.tx.date) }} · {{ accountLabel(accountById[rec.tx.accountId]) }}<template v-if="rec.tx.reference"> · {{ rec.tx.reference }}</template></p>
              </div>
              <span class="text-lg tabular-nums whitespace-nowrap" :class="moneyIn ? 'text-success' : ''">{{ formatCurrency(rec.tx.amount, rec.tx.currency) }}</span>
            </div>
          </div>

          <UAlert v-if="rec.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="rec.error" />
          <UTabs v-model="rec.tab" :items="recTabs" :content="false" class="w-full" />

          <div v-if="rec.loading" class="py-6 text-center text-sm text-dimmed">Loading...</div>
          <template v-else-if="rec.sug">
            <div v-if="rec.tab === 'invoice'" class="space-y-4">
              <UFormField label="Invoice"><AppSelect v-model="rec.invoiceId" searchable placeholder="Pick an open invoice" :options="invoiceOptions" /></UFormField>
              <p v-if="!rec.sug.invoices.length" class="text-sm text-dimmed">No open invoices.</p>
              <template v-if="selectedInvoice">
                <UFormField :label="`Amount paid (${selectedInvoice.currency})`" :help="foreignInvoice ? `${formatCurrency(rec.tx.amount, rec.tx.currency)} received for this.` : undefined">
                  <UInput v-model="rec.amount" type="number" step="0.01" min="0.01" class="w-full" />
                </UFormField>
                <template v-if="foreignInvoice && rec.tx.currency === 'ZAR'">
                  <UFormField :label="`ZAR per ${selectedInvoice.currency} on invoice date`" :help="selectedInvoice.exchangeRate ? 'From the invoice.' : 'Saved on the invoice. Leave empty to skip forex.'">
                    <UInput v-model="rec.invoiceRate" type="number" step="0.0001" min="0" placeholder="e.g. 18.25" class="w-full" />
                  </UFormField>
                  <div v-if="forexPreview" class="rounded-lg bg-elevated/50 p-3 text-sm space-y-1">
                    <p class="text-muted">Rate received: {{ forexPreview.receivedRate.toFixed(4) }}</p>
                    <template v-if="forexPreview.gain !== null">
                      <p class="text-muted">At invoice rate: {{ formatCurrency(forexPreview.atInvoice, "ZAR") }}</p>
                      <p :class="forexPreview.gain >= 0 ? 'text-success' : 'text-error'">Forex {{ forexPreview.gain >= 0 ? "gain" : "loss" }}: {{ formatCurrency(Math.abs(forexPreview.gain), "ZAR") }}</p>
                    </template>
                    <p v-else class="text-warning">No invoice-date rate, so no forex gain or loss is worked out.</p>
                  </div>
                </template>
                <p v-else-if="foreignInvoice" class="text-sm text-warning">This account is not ZAR, so no forex gain or loss is worked out.</p>
              </template>
            </div>

            <div v-else-if="rec.tab === 'payment'" class="space-y-2">
              <UFormField label="Payment" help="Payments already recorded and not linked to a bank line."><AppSelect v-model="rec.paymentId" searchable placeholder="Pick a payment" :options="paymentOptions" /></UFormField>
              <p v-if="!rec.sug.payments.length" class="text-sm text-dimmed">No unlinked payments.</p>
            </div>

            <div v-else-if="rec.tab === 'expense'" class="space-y-4">
              <UFormField label="Category"><AppSelect v-model="rec.categoryId" searchable placeholder="Uncategorised" :options="rec.sug.categories.map((c) => ({ label: c.name, value: c.id }))" /></UFormField>
              <UFormField label="Vendor"><UInput v-model="rec.vendor" class="w-full" /></UFormField>
              <UFormField label="Description" hint="Optional"><UInput v-model="rec.notes" class="w-full" :placeholder="rec.tx.description" /></UFormField>
            </div>

            <div v-else-if="rec.tab === 'match_expense'" class="space-y-2">
              <UFormField label="Expense" help="Expenses not linked to a bank line."><AppSelect v-model="rec.expenseId" searchable placeholder="Pick an expense" :options="expenseOptions" /></UFormField>
              <p v-if="!rec.sug.expenses.length" class="text-sm text-dimmed">No unlinked expenses.</p>
            </div>

            <div v-else-if="rec.tab === 'transfer'" class="space-y-2">
              <p class="text-sm text-muted">Money moved between your own accounts. Not income or an expense.</p>
              <UFormField label="Other side" hint="Optional"><AppSelect v-model="rec.pairId" searchable placeholder="Not imported" :options="transferOptions" /></UFormField>
            </div>

            <div v-else-if="rec.tab === 'ignore'" class="space-y-2">
              <p class="text-sm text-muted">Leave this line out of reconciliation.</p>
              <UFormField label="Note" hint="Optional"><UInput v-model="rec.note" class="w-full" /></UFormField>
            </div>
          </template>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="rec.open = false">Cancel</UButton>
          <UButton :loading="rec.saving" :disabled="rec.loading || !canSubmit" @click="submitReconcile">Save</UButton>
        </div>
      </template>
    </USlideover>

    <!-- Undo with a created record -->
    <UModal v-model:open="undoState.open" title="Undo reconciliation">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="undoState.error" color="error" variant="subtle" :title="undoState.error" />
          <p class="text-sm">Reconciling this line created {{ undoState.tx?.created?.type === "payment" ? "a payment" : "an expense" }}. Delete it too?</p>
          <p v-if="!isAdmin" class="text-xs text-dimmed">Only admins can delete it.</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="undoState.open = false">Cancel</UButton>
          <UButton variant="soft" color="neutral" :loading="undoState.saving" @click="undoState.tx && runUndo(undoState.tx, false)">Keep it</UButton>
          <UButton v-if="isAdmin" color="error" :loading="undoState.saving" @click="undoState.tx && runUndo(undoState.tx, true)">Delete it</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
