<script setup lang="ts">
// Company bank accounts: one list used for bank reconciliation and for the
// payment details printed on invoices, quotes and statements.
import { CURRENCIES } from "~/utils/money";

type Account = {
  id: string;
  name: string;
  bank: string;
  currency: string;
  accountHolder?: string;
  accountNumber?: string;
  accountLast4?: string;
  branchCode?: string;
  swift?: string;
  iban?: string;
  details?: string;
  showOnInvoices?: boolean;
  openingBalance?: number;
  openingDate?: string;
  openingRate?: number | null;
  transactionCount?: number;
};
type BankOption = { value: string; label: string };

const { activeCompanyId, capi, cpost, cpatch, cdelete } = useCompanyApi();
const { company, isAdmin, refresh } = useCompany();
const toast = useToast();

const accounts = ref<Account[]>([]);
const banks = ref<BankOption[]>([{ value: "other", label: "Other" }]);
const bankLabels = computed<Record<string, string>>(() => Object.fromEntries(banks.value.map((b) => [b.value, b.label])));
const loading = ref(false);
const error = ref("");

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const res = await capi<{ accounts: Account[]; banks?: BankOption[] }>("/bank-accounts");
    accounts.value = res.accounts;
    if (Array.isArray(res.banks) && typeof res.banks[0] === "object") banks.value = res.banks;
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}
watch(activeCompanyId, load, { immediate: true });

const blank = () => ({
  open: false,
  id: "",
  name: "",
  bank: "standard_bank",
  currency: "ZAR",
  accountHolder: "",
  accountNumber: "",
  accountLast4: "",
  branchCode: "",
  swift: "",
  iban: "",
  details: "",
  showOnInvoices: true,
  openingBalance: "" as string | number,
  openingDate: "",
  openingRate: "" as string | number,
  saving: false,
  error: "",
});
const form = reactive(blank());

function open(a?: Account) {
  Object.assign(form, blank(), {
    open: true,
    currency: company.value?.defaultCurrency || "ZAR",
    accountHolder: company.value?.legalName || company.value?.name || "",
  });
  if (a) {
    Object.assign(form, {
      id: a.id,
      name: a.name,
      bank: a.bank || "other",
      currency: a.currency,
      accountHolder: a.accountHolder || "",
      accountNumber: a.accountNumber || "",
      accountLast4: a.accountLast4 || "",
      branchCode: a.branchCode || "",
      swift: a.swift || "",
      iban: a.iban || "",
      details: a.details || "",
      showOnInvoices: a.showOnInvoices !== false,
      openingBalance: a.openingBalance ?? "",
      openingDate: a.openingDate || "",
      openingRate: a.openingRate ?? "",
    });
  }
}

async function save() {
  form.saving = true;
  form.error = "";
  try {
    const body = {
      name: form.name,
      bank: form.bank,
      currency: form.currency,
      accountHolder: form.accountHolder,
      accountNumber: form.accountNumber,
      accountLast4: form.accountNumber ? "" : form.accountLast4,
      branchCode: form.branchCode,
      swift: form.swift,
      iban: form.iban,
      details: form.details,
      showOnInvoices: form.showOnInvoices,
      openingBalance: Number(form.openingBalance) || 0,
      openingDate: form.openingDate,
      openingRate: form.openingRate === "" ? null : Number(form.openingRate),
    };
    if (form.id) await cpatch(`/bank-accounts/${form.id}`, body);
    else await cpost("/bank-accounts", body);
    toast.add({ title: form.id ? "Account updated" : "Account added", description: form.name, color: "success", icon: "i-lucide-check" });
    form.open = false;
    await Promise.all([load(), refresh()]);
  } catch (e) {
    form.error = errMsg(e);
  } finally {
    form.saving = false;
  }
}

async function remove() {
  if (!confirm(`Delete ${form.name}?`)) return;
  try {
    await cdelete(`/bank-accounts/${form.id}`);
    form.open = false;
    await Promise.all([load(), refresh()]);
  } catch (e) {
    form.error = errMsg(e);
  }
}
</script>

<template>
  <UCard id="bank-accounts">
    <template #header>
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium">Bank accounts</span>
        <UButton v-if="isAdmin" size="xs" variant="soft" icon="i-lucide-plus" @click="open()">Add account</UButton>
      </div>
    </template>
    <p class="mb-4 text-sm text-muted">Used for bank transactions and as payment details. Invoices show accounts in the invoice currency, or all shown accounts if none match.</p>
    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" class="mb-4" />
    <div v-if="accounts.length" class="divide-y divide-default rounded-lg border border-default">
      <div v-for="a in accounts" :key="a.id" class="flex items-center gap-3 px-3 py-2">
        <UIcon name="i-lucide-landmark" class="size-4 shrink-0 text-dimmed" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-highlighted">{{ a.name }}</p>
          <p class="truncate text-xs text-dimmed">{{ bankLabels[a.bank] || "Other" }}{{ a.accountLast4 ? ` · ${a.accountLast4}` : "" }} · {{ a.currency }}</p>
        </div>
        <UBadge v-if="a.showOnInvoices !== false" color="neutral" variant="subtle" size="sm">On invoices</UBadge>
        <UButton v-if="isAdmin" size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Edit account" @click="open(a)" />
      </div>
    </div>
    <p v-else-if="!loading" class="text-sm text-dimmed">No accounts yet.{{ isAdmin ? " Add your bank accounts here." : "" }}</p>

    <UModal v-model:open="form.open" :title="form.id ? 'Edit bank account' : 'Add bank account'">
      <template #body>
        <form id="bank-account-form" class="space-y-4" @submit.prevent="save">
          <UAlert v-if="form.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="form.error" />
          <UFormField label="Name" required><UInput v-model="form.name" placeholder="e.g. Business cheque" autofocus class="w-full" /></UFormField>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Bank"><AppSelect v-model="form.bank" searchable :options="banks" /></UFormField>
            <UFormField label="Currency"><AppSelect v-model="form.currency" searchable :options="CURRENCIES.map((c) => ({ label: c, value: c }))" /></UFormField>
            <UFormField label="Account holder"><UInput v-model="form.accountHolder" class="w-full" /></UFormField>
            <UFormField label="Account number" :hint="!form.accountNumber && form.accountLast4 ? `Ends ${form.accountLast4}` : undefined"><UInput v-model="form.accountNumber" inputmode="numeric" class="w-full" /></UFormField>
            <UFormField label="Branch code"><UInput v-model="form.branchCode" class="w-full" /></UFormField>
            <UFormField label="SWIFT / BIC"><UInput v-model="form.swift" class="w-full" /></UFormField>
            <UFormField label="IBAN" class="sm:col-span-2"><UInput v-model="form.iban" class="w-full" /></UFormField>
          </div>
          <UFormField label="Other payment details" hint="Optional"><UTextarea v-model="form.details" :rows="2" class="w-full" placeholder="e.g. ACH routing number, reference to use" /></UFormField>
          <UCheckbox v-model="form.showOnInvoices" label="Show on invoices, quotes and statements" />
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Opening balance" hint="Optional"><UInput v-model="form.openingBalance" type="number" step="0.01" class="w-full" /></UFormField>
            <UFormField label="Opening date" hint="Optional"><DatePicker v-model="form.openingDate" block clearable /></UFormField>
            <UFormField
              v-if="form.currency && form.currency !== (company?.baseCurrency || 'ZAR')"
              :label="`${company?.baseCurrency || 'ZAR'} per 1 ${form.currency}`"
              hint="Needed so the opening posts to the ledger."
              class="sm:col-span-2"
            >
              <UInput v-model="form.openingRate" type="number" step="0.0001" min="0" placeholder="e.g. 18.00" class="w-full" />
            </UFormField>
          </div>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full items-center gap-2">
          <UButton v-if="form.id" variant="ghost" color="error" icon="i-lucide-trash" @click="remove">Delete</UButton>
          <div class="ml-auto flex gap-2">
            <UButton variant="ghost" color="neutral" @click="form.open = false">Cancel</UButton>
            <UButton type="submit" form="bank-account-form" :loading="form.saving" :disabled="!form.name.trim()">Save</UButton>
          </div>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
