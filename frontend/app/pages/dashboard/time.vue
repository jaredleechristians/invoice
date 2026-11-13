<script setup lang="ts">
import { formatDate, todayIso, datePresets, STATUS_COLORS, statusLabel } from "~/utils/money";

definePageMeta({ layout: "dashboard", middleware: "auth" });

type TimeEntry = {
  id: string;
  date: string;
  minutes: number;
  hours: number;
  description: string;
  notes?: string;
  customerId?: string;
  customerName?: string;
  personName?: string;
  billable: boolean;
  rate?: number | null;
  currency?: string;
  status: string;
  invoiceId?: string;
  billedAt?: string | null;
  source?: string;
};

type Customer = { id: string; name: string };

const { activeCompanyId, capi, cpost, cpatch, cdelete } = useCompanyApi();
const { company, ensure, isAdmin } = useCompany();
const { user } = useAuth();
const toast = useToast();

const entries = ref<TimeEntry[]>([]);
const customers = ref<Customer[]>([]);
const loading = ref(false);
const saving = ref(false);
const invoicing = ref(false);
const error = ref("");
const formError = ref("");
const formOpen = ref(false);
const editingId = ref("");
const selected = ref<string[]>([]);
const invoiceRate = ref<number | null>(null);
const q = ref("");
const filters = reactive({ from: "", to: "", customerId: "", status: "" });
const filterRange = computed({
  get: () => ({ from: filters.from, to: filters.to }),
  set: (v: { from: string; to: string }) => Object.assign(filters, v),
});
const DATE_PRESETS = computed(() => datePresets(todayIso(), company.value?.taxYearEndMonth));

const blank = () => ({
  date: todayIso(),
  hours: 1 as number | string,
  description: "",
  notes: "",
  customerId: "",
  personName: user.value?.displayName || user.value?.email || "",
  billable: false,
  rate: null as number | null,
});
const form = reactive(blank());

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return entries.value.filter((e) => {
    if (filters.customerId && e.customerId !== filters.customerId) return false;
    if (filters.status === "unbilled" && (e.status !== "unbilled")) return false;
    if (filters.status === "billed" && e.status !== "billed") return false;
    if (filters.status === "internal" && e.status !== "internal") return false;
    if (filters.status === "billable" && !e.billable) return false;
    if (needle && !`${e.description} ${e.notes || ""} ${e.personName || ""} ${e.customerName || ""}`.toLowerCase().includes(needle)) return false;
    return true;
  });
});

const selectedEntries = computed(() => entries.value.filter((e) => selected.value.includes(e.id)));
const canInvoice = computed(() => {
  const rows = selectedEntries.value;
  if (!rows.length || rows.some((e) => !e.billable || e.invoiceId)) return false;
  const ids = [...new Set(rows.map((e) => e.customerId).filter(Boolean))];
  return ids.length === 1;
});

function openNew() {
  Object.assign(form, blank());
  editingId.value = "";
  formError.value = "";
  formOpen.value = true;
}

function edit(e: TimeEntry) {
  editingId.value = e.id;
  formError.value = "";
  Object.assign(form, {
    date: e.date,
    hours: e.hours,
    description: e.description,
    notes: e.notes || "",
    customerId: e.customerId || "",
    personName: e.personName || "",
    billable: e.billable,
    rate: e.rate ?? null,
  });
  formOpen.value = true;
}

async function load() {
  if (!activeCompanyId.value) return;
  loading.value = true;
  error.value = "";
  try {
    await ensure();
    const params = new URLSearchParams();
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    const qs = params.toString() ? `?${params}` : "";
    const [t, c] = await Promise.all([
      capi<{ timeEntries: TimeEntry[] }>(`/time-entries${qs}`),
      capi<{ customers: Customer[] }>("/customers"),
    ]);
    entries.value = t.timeEntries;
    customers.value = c.customers;
    selected.value = selected.value.filter((id) => entries.value.some((e) => e.id === id && !e.invoiceId));
  } catch (e) {
    error.value = errMsg(e, "Failed to load time entries");
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  formError.value = "";
  try {
    const payload: Record<string, unknown> = {
      date: form.date,
      hours: form.hours === "" || form.hours == null || Number.isNaN(Number(form.hours)) ? undefined : Number(form.hours),
      description: form.description,
      notes: form.notes,
      customerId: form.customerId || "",
      personName: form.personName,
      billable: form.billable,
      rate: form.billable && form.rate != null && form.rate !== ("" as unknown) && !Number.isNaN(Number(form.rate)) ? Number(form.rate) : null,
    };
    if (editingId.value) await cpatch(`/time-entries/${editingId.value}`, payload);
    else await cpost("/time-entries", payload);
    toast.add({ title: editingId.value ? "Time entry updated" : "Time entry added", color: "success", icon: "i-lucide-check" });
    formOpen.value = false;
    await load();
  } catch (e) {
    formError.value = errMsg(e, "Failed to save time entry");
  } finally {
    saving.value = false;
  }
}

async function remove(e: TimeEntry) {
  if (!confirm(`Delete this time entry (${e.hours}h — ${e.description})?`)) return;
  try {
    await cdelete(`/time-entries/${e.id}`);
    toast.add({ title: "Time entry deleted", color: "success", icon: "i-lucide-trash" });
    await load();
  } catch (err) {
    error.value = errMsg(err);
  }
}

async function invoiceSelected() {
  if (!canInvoice.value) return;
  invoicing.value = true;
  error.value = "";
  try {
    const missingRate = selectedEntries.value.some((e) => e.rate == null);
    if (missingRate && (invoiceRate.value == null || Number.isNaN(Number(invoiceRate.value)))) {
      error.value = "Set a rate on the entries, or enter a rate to use for this invoice.";
      return;
    }
    const inv = await cpost<{ id: string }>("/time-entries/invoice", {
      entryIds: selected.value,
      rate: invoiceRate.value == null || Number.isNaN(Number(invoiceRate.value)) ? undefined : Number(invoiceRate.value),
      draft: true,
    });
    selected.value = [];
    await navigateTo(`/dashboard/invoices/${inv.id}`);
  } catch (e) {
    error.value = errMsg(e, "Could not create the invoice");
  } finally {
    invoicing.value = false;
  }
}

watch([activeCompanyId, useDataVersion()], load, { immediate: true });
watch(() => ({ from: filters.from, to: filters.to }), load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader info="Internal time is not billed. Ad hoc billable hours can be invoiced once, then they are marked billed so they cannot be billed twice.">
      <template #filters>
        <UInput v-model="q" placeholder="Search description or person" class="w-full sm:w-64" icon="i-lucide-search" />
        <DatePicker v-model="filterRange" range :presets="DATE_PRESETS" clearable placeholder="All dates" />
        <div class="w-full sm:w-52">
          <AppSelect v-model="filters.customerId" searchable placeholder="All customers" :options="customers.map((c) => ({ label: c.name, value: c.id }))" />
        </div>
        <div class="w-full sm:w-44">
          <AppSelect
            v-model="filters.status"
            placeholder="All entries"
            :options="[
              { label: 'Unbilled billable', value: 'unbilled' },
              { label: 'Billed', value: 'billed' },
              { label: 'Internal', value: 'internal' },
              { label: 'All billable', value: 'billable' },
            ]"
          />
        </div>
      </template>
      <UButton icon="i-lucide-plus" @click="openNew">Log time</UButton>
    </PageHeader>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />

    <div v-if="selected.length" class="flex flex-wrap items-end gap-3 rounded-lg border border-default p-3">
      <p class="text-sm">{{ selected.length }} selected</p>
      <UFormField v-if="selectedEntries.some((e) => e.rate == null)" label="Rate for this invoice" class="w-40">
        <UInput v-model.number="invoiceRate" type="number" min="0" step="0.01" class="w-full" />
      </UFormField>
      <UButton icon="i-lucide-file-text" :disabled="!canInvoice" :loading="invoicing" @click="invoiceSelected">Create draft invoice</UButton>
      <p v-if="selected.length && !canInvoice" class="text-sm text-muted">Select unbilled billable hours for one customer.</p>
    </div>

    <USlideover v-model:open="formOpen" :title="editingId ? 'Edit time entry' : 'Log time'" :ui="{ content: 'sm:max-w-lg' }">
      <template #body>
        <form class="space-y-4" @submit.prevent="save">
          <UAlert v-if="formError" color="error" variant="subtle" :title="formError" />
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Date" required><UInput v-model="form.date" type="date" class="w-full" /></UFormField>
            <UFormField label="Hours" required><UInput v-model.number="form.hours" type="number" min="0.01" step="0.25" class="w-full" /></UFormField>
          </div>
          <UFormField label="What did you work on?" required><UInput v-model="form.description" class="w-full" /></UFormField>
          <UFormField label="Person"><UInput v-model="form.personName" class="w-full" /></UFormField>
          <UFormField label="Customer">
            <AppSelect v-model="form.customerId" searchable placeholder="No customer" :options="customers.map((c) => ({ label: c.name, value: c.id }))" />
          </UFormField>
          <UCheckbox v-model="form.billable" label="Ad hoc billable hours (can be invoiced later)" />
          <UFormField v-if="form.billable" label="Hourly rate (optional)">
            <UInput v-model.number="form.rate" type="number" min="0" step="0.01" class="w-full" />
          </UFormField>
          <UFormField label="Notes"><UTextarea v-model="form.notes" :rows="3" class="w-full" /></UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="formOpen = false">Cancel</UButton>
          <UButton :loading="saving" :disabled="!form.description || !form.hours" @click="save">{{ editingId ? "Save" : "Add" }}</UButton>
        </div>
      </template>
    </USlideover>

    <UTable
      :data="filtered"
      :columns="[
        { accessorKey: 'select', header: '' },
        { accessorKey: 'date', header: 'Date' },
        { accessorKey: 'personName', header: 'Person' },
        { accessorKey: 'customerName', header: 'Customer' },
        { accessorKey: 'description', header: 'Work' },
        { accessorKey: 'hours', header: 'Hours', meta: { class: { th: 'text-right', td: 'text-right' } } },
        { accessorKey: 'status', header: 'Status' },
        { accessorKey: 'actions', header: '' },
      ]"
      :loading="loading"
      class="rounded-lg border border-default"
      :ui="{ td: 'py-2.5', th: 'text-xs uppercase tracking-wide text-dimmed' }"
    >
      <template #select-cell="{ row }">
        <UCheckbox
          v-if="row.original.billable && !row.original.invoiceId"
          :model-value="selected.includes(row.original.id)"
          @update:model-value="(on: boolean) => { selected = on ? [...selected, row.original.id] : selected.filter((id) => id !== row.original.id) }"
        />
      </template>
      <template #date-cell="{ row }">{{ formatDate(row.original.date) }}</template>
      <template #hours-cell="{ row }"><span class="tabular-nums">{{ row.original.hours }}</span></template>
      <template #status-cell="{ row }">
        <UBadge :color="STATUS_COLORS[row.original.status] || 'neutral'" variant="subtle">{{ statusLabel(row.original.status) }}</UBadge>
        <NuxtLink v-if="row.original.invoiceId" :to="`/dashboard/invoices/${row.original.invoiceId}`" class="ml-2 text-xs underline">Invoice</NuxtLink>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" aria-label="Edit" :disabled="Boolean(row.original.invoiceId)" @click="edit(row.original)" />
          <UButton v-if="isAdmin" size="xs" variant="ghost" color="error" icon="i-lucide-trash" aria-label="Delete" :disabled="Boolean(row.original.invoiceId)" @click="remove(row.original)" />
        </div>
      </template>
      <template #empty><p class="py-6 text-center text-sm text-dimmed">No time entries yet.</p></template>
    </UTable>
  </div>
</template>
