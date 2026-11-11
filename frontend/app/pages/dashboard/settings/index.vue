<script setup lang="ts">
import { CURRENCIES, fileToDataUrl } from "~/utils/money";
import type { BankAccount, CompanySettings } from "~/composables/useCompany";

definePageMeta({ layout: "dashboard", middleware: "auth" });

const { activeCompanyId, cpatch } = useCompanyApi();
const { company, refresh, isAdmin } = useCompany();

const form = ref<CompanySettings | null>(null);
const saving = ref(false);
const error = ref("");
const saved = ref("");

function load(c: CompanySettings | null) {
  form.value = c ? JSON.parse(JSON.stringify(c)) : null;
  if (form.value && !form.value.bankAccounts) form.value.bankAccounts = [];
}

watch(activeCompanyId, async (id) => {
  if (!id) return;
  try {
    load(await refresh());
  } catch (e) {
    error.value = errMsg(e);
  }
}, { immediate: true });

function addBank() {
  form.value?.bankAccounts.push({ label: "", currency: form.value.defaultCurrency || "ZAR", details: "" } as BankAccount);
}
function removeBank(i: number) {
  form.value?.bankAccounts.splice(i, 1);
}

async function onLogo(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file || !form.value) return;
  if (file.size > 300 * 1024) {
    error.value = "Logo must be 300 KB or smaller.";
    return;
  }
  form.value.logoDataUrl = await fileToDataUrl(file);
}

function toggleCurrency(c: string, on: boolean) {
  if (!form.value) return;
  const set = new Set(form.value.currencies || []);
  if (on) set.add(c);
  else set.delete(c);
  form.value.currencies = [...set];
}

const examplePreview = computed(() => {
  if (!form.value) return "";
  return `${form.value.invoicePrefix}${String(form.value.invoiceNextNumber || 1).padStart(4, "0")}`;
});

async function save() {
  if (!form.value) return;
  saving.value = true;
  error.value = "";
  saved.value = "";
  try {
    const f = form.value;
    const updated = await cpatch<CompanySettings>("", {
      name: f.name,
      legalName: f.legalName,
      logoDataUrl: f.logoDataUrl,
      email: f.email,
      phone: f.phone,
      website: f.website,
      address: f.address,
      registrationNumber: f.registrationNumber,
      taxNumber: f.taxNumber,
      vatRegistered: f.vatRegistered,
      vatNumber: f.vatNumber,
      vatRate: Number(f.vatRate),
      invoicePrefix: f.invoicePrefix,
      invoiceNextNumber: Number(f.invoiceNextNumber),
      quotePrefix: f.quotePrefix,
      quoteNextNumber: Number(f.quoteNextNumber),
      defaultCurrency: f.defaultCurrency,
      currencies: f.currencies,
      paymentTermsDays: Number(f.paymentTermsDays),
      quoteValidDays: Number(f.quoteValidDays),
      defaultNotes: f.defaultNotes,
      legal: f.legal,
      footer: f.footer,
      bankAccounts: f.bankAccounts,
    });
    company.value = updated;
    load(updated);
    saved.value = "Settings saved.";
  } catch (e) {
    error.value = errMsg(e, "Save failed");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6 max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-semibold">Company settings</h1>
        <p class="text-muted text-sm mt-1">Shown on invoices and quotes. Finalized invoices keep the details they were issued with.</p>
      </div>
      <UButton to="/dashboard/settings/members" variant="soft" icon="i-lucide-users">Members</UButton>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" :title="error" />
    <UAlert v-if="saved" color="success" variant="subtle" :title="saved" />
    <UAlert v-if="form && !isAdmin" color="warning" variant="subtle" title="Only owners and admins can change settings." />

    <form v-if="form" class="space-y-6" @submit.prevent="save">
      <fieldset :disabled="!isAdmin" class="space-y-6">
        <UCard>
          <template #header><span class="font-medium">Business details</span></template>
          <div class="grid gap-4 sm:grid-cols-2">
            <UFormField label="Trading name" required><UInput v-model="form.name" class="w-full" required /></UFormField>
            <UFormField label="Legal name"><UInput v-model="form.legalName" class="w-full" placeholder="e.g. Ezintsha Holdings (Pty) Ltd" /></UFormField>
            <UFormField label="Email"><UInput v-model="form.email" type="email" class="w-full" /></UFormField>
            <UFormField label="Phone"><UInput v-model="form.phone" class="w-full" /></UFormField>
            <UFormField label="Website"><UInput v-model="form.website" class="w-full" /></UFormField>
            <UFormField label="Registration number"><UInput v-model="form.registrationNumber" class="w-full" /></UFormField>
            <UFormField label="Address" class="sm:col-span-2"><UTextarea v-model="form.address" :rows="3" class="w-full" /></UFormField>
            <UFormField label="Logo (PNG/JPEG/SVG, ≤ 300 KB)" class="sm:col-span-2">
              <div class="flex items-center gap-4">
                <img v-if="form.logoDataUrl" :src="form.logoDataUrl" alt="Logo" class="h-14 max-w-48 object-contain bg-white rounded p-1" />
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" class="text-sm" @change="onLogo" />
                <UButton v-if="form.logoDataUrl" size="xs" variant="ghost" color="error" @click="form.logoDataUrl = ''">Remove</UButton>
              </div>
            </UFormField>
          </div>
        </UCard>

        <UCard>
          <template #header><span class="font-medium">Tax</span></template>
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField label="Income tax number" class="sm:col-span-3"><UInput v-model="form.taxNumber" class="w-full" /></UFormField>
            <div class="sm:col-span-3">
              <UCheckbox v-model="form.vatRegistered" label="VAT registered (adds VAT to taxable invoice lines)" />
            </div>
            <template v-if="form.vatRegistered">
              <UFormField label="VAT number"><UInput v-model="form.vatNumber" class="w-full" /></UFormField>
              <UFormField label="VAT rate (%)"><UInput v-model.number="form.vatRate" type="number" step="0.01" min="0" max="100" class="w-full" /></UFormField>
            </template>
            <p v-else class="text-sm text-dimmed sm:col-span-3">Not VAT registered: invoices show a plain total with no VAT line.</p>
          </div>
        </UCard>

        <UCard>
          <template #header><span class="font-medium">Invoicing defaults</span></template>
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField label="Invoice prefix"><UInput v-model="form.invoicePrefix" class="w-full" /></UFormField>
            <UFormField label="Next invoice number" :hint="examplePreview"><UInput v-model.number="form.invoiceNextNumber" type="number" min="1" class="w-full" /></UFormField>
            <UFormField label="Payment terms (days)"><UInput v-model.number="form.paymentTermsDays" type="number" min="0" max="365" class="w-full" /></UFormField>
            <UFormField label="Quote prefix"><UInput v-model="form.quotePrefix" class="w-full" /></UFormField>
            <UFormField label="Next quote number"><UInput v-model.number="form.quoteNextNumber" type="number" min="1" class="w-full" /></UFormField>
            <UFormField label="Quotes valid for (days)"><UInput v-model.number="form.quoteValidDays" type="number" min="0" max="365" class="w-full" /></UFormField>
            <UFormField label="Default currency">
              <NSelect v-model="form.defaultCurrency" :options="CURRENCIES.map((c) => ({ label: c, value: c }))" />
            </UFormField>
            <UFormField label="Currencies you bill in" class="sm:col-span-2">
              <div class="flex flex-wrap gap-4 pt-1.5">
                <UCheckbox
                  v-for="c in CURRENCIES"
                  :key="c"
                  :label="c"
                  :model-value="form.currencies.includes(c)"
                  @update:model-value="toggleCurrency(c, Boolean($event))"
                />
              </div>
            </UFormField>
            <p class="text-xs text-dimmed sm:col-span-3">Numbers are allocated when an invoice is finalized. If you lower the next number, numbers already used are skipped automatically.</p>
            <UFormField label="Default invoice notes" class="sm:col-span-3"><UTextarea v-model="form.defaultNotes" :rows="2" class="w-full" placeholder="Thank you for your business. Please use the invoice number as reference." /></UFormField>
            <UFormField label="Legal line (small print)" class="sm:col-span-3"><UTextarea v-model="form.legal" :rows="2" class="w-full" /></UFormField>
            <UFormField label="Footer" class="sm:col-span-3"><UInput v-model="form.footer" class="w-full" /></UFormField>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-medium">Bank / payment details</span>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addBank">Add account</UButton>
            </div>
          </template>
          <p class="text-sm text-muted mb-4">Shown on invoices. Accounts tagged with a currency only appear on invoices in that currency; untagged accounts appear on all.</p>
          <div v-if="form.bankAccounts.length" class="space-y-4">
            <div v-for="(acct, i) in form.bankAccounts" :key="acct.id || i" class="grid gap-3 sm:grid-cols-[1fr_8rem_auto] items-start border border-default rounded-lg p-3">
              <UFormField label="Label"><UInput v-model="acct.label" class="w-full" placeholder="ZAR — South African bank" /></UFormField>
              <UFormField label="Currency">
                <NSelect v-model="acct.currency" placeholder="Any" :options="CURRENCIES.map((c) => ({ label: c, value: c }))" />
              </UFormField>
              <UButton class="mt-6" size="xs" color="error" variant="ghost" icon="i-lucide-trash" @click="removeBank(i)" />
              <UFormField label="Details (plain text)" class="sm:col-span-3">
                <UTextarea v-model="acct.details" :rows="4" class="w-full font-mono" placeholder="Bank: …&#10;Account name: …&#10;Account number: …&#10;Branch code: …" />
              </UFormField>
            </div>
          </div>
          <p v-else class="text-sm text-dimmed">No accounts yet. Add your ZAR bank account and your USD Wise details.</p>
        </UCard>
      </fieldset>

      <div v-if="isAdmin" class="flex gap-2">
        <UButton type="submit" :loading="saving">Save settings</UButton>
      </div>
    </form>
  </div>
</template>
