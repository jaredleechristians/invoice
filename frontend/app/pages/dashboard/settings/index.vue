<script setup lang="ts">
import { CURRENCIES, fileToDataUrl } from "~/utils/money";
import { DEFAULT_TAX_YEAR_END_MONTH, MONTH_FULL_NAMES, normalizeTaxYearEndMonth, taxYearLabel, taxYearRange } from "~/utils/taxYear";
import type { CompanySettings } from "~/composables/useCompany";

definePageMeta({ layout: "dashboard", middleware: "auth" });

const { activeCompanyId, cpatch } = useCompanyApi();
const { company, refresh, isAdmin } = useCompany();

const form = ref<CompanySettings | null>(null);
const saving = ref(false);
const error = ref("");
const saved = ref("");

const TAX_YEAR_MONTHS = MONTH_FULL_NAMES.map((label, i) => ({ label: `End of ${label}`, value: i + 1 }));
const taxYearHint = computed(() => (form.value ? taxYearLabel(taxYearRange(new Date().toISOString().slice(0, 10), form.value.taxYearEndMonth)) : ""));
const vatRateError = computed(() => {
  const r = form.value?.vatRate as unknown;
  if (!form.value?.vatRegistered || r === "" || r === null || r === undefined) return undefined;
  const n = Number(r);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? undefined : "Enter 0 to 100";
});

function load(c: CompanySettings | null) {
  form.value = c ? JSON.parse(JSON.stringify(c)) : null;
  if (form.value) form.value.taxYearEndMonth = normalizeTaxYearEndMonth(form.value.taxYearEndMonth);
}

watch(activeCompanyId, async (id) => {
  if (!id) return;
  try {
    load(await refresh());
  } catch (e) {
    error.value = errMsg(e);
  }
}, { immediate: true });

const logoFile = ref<File | null>(null);
watch(logoFile, (f) => onLogo(f));

async function onLogo(file: File | null | undefined) {
  if (!file || !form.value) return;
  if (file.size > 300 * 1024) {
    error.value = "Logo must be 300 KB or smaller.";
    logoFile.value = null;
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
  if (vatRateError.value) {
    error.value = "VAT rate must be between 0 and 100";
    return;
  }
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
      vatRate: (f.vatRate as unknown) === "" || f.vatRate == null ? 15 : Number(f.vatRate),
      taxYearEndMonth: Number(f.taxYearEndMonth) || DEFAULT_TAX_YEAR_END_MONTH,
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
  <div class="mx-auto w-full max-w-4xl space-y-6">
    <PageHeader title="Company settings" info="Shown on invoices and quotes. Published invoices keep the details they were issued with.">
      <UButton to="/dashboard/settings/members" variant="soft" icon="i-lucide-users">Members</UButton>
    </PageHeader>

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
                <img v-if="form.logoDataUrl" :src="form.logoDataUrl" alt="Logo" class="h-14 max-w-48 object-contain bg-white rounded-md p-1 ring-1 ring-default" />
                <UFileUpload
                  v-model="logoFile"
                  accept="image/png,image/jpeg,image/svg+xml,image/webp"
                  icon="i-lucide-image-up"
                  label="Upload logo"
                  description="PNG, JPEG, SVG or WebP"
                  :preview="false"
                  class="w-64 min-h-24"
                />
                <UButton v-if="form.logoDataUrl" size="xs" variant="ghost" color="error" @click="form.logoDataUrl = ''; logoFile = null">Remove</UButton>
              </div>
            </UFormField>
          </div>
        </UCard>

        <UCard>
          <template #header><span class="font-medium">Tax</span></template>
          <div class="grid gap-4 sm:grid-cols-3">
            <UFormField label="Income tax number" class="sm:col-span-2"><UInput v-model="form.taxNumber" class="w-full" /></UFormField>
            <UFormField label="Tax year end" :hint="taxYearHint">
              <AppSelect v-model="form.taxYearEndMonth" :options="TAX_YEAR_MONTHS" />
            </UFormField>
            <div class="sm:col-span-3">
              <UCheckbox v-model="form.vatRegistered" label="VAT registered (adds VAT to taxable invoice lines)" />
            </div>
            <template v-if="form.vatRegistered">
              <UFormField label="VAT number"><UInput v-model="form.vatNumber" class="w-full" /></UFormField>
              <UFormField label="VAT rate (%)" help="Default for new invoices and quotes. Existing ones keep their rate." :error="vatRateError">
                <UInput v-model.number="form.vatRate" type="number" step="0.01" min="0" max="100" placeholder="15" class="w-full" />
              </UFormField>
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
              <AppSelect v-model="form.defaultCurrency" searchable :options="CURRENCIES.map((c) => ({ label: c, value: c }))" />
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
            <p class="text-xs text-dimmed sm:col-span-3">Numbers are allocated when an invoice is published. If you lower the next number, numbers already used are skipped automatically.</p>
            <UFormField label="Default invoice notes" class="sm:col-span-3"><UTextarea v-model="form.defaultNotes" :rows="2" class="w-full" placeholder="Thank you for your business. Please use the invoice number as reference." /></UFormField>
            <UFormField label="Legal line (small print)" class="sm:col-span-3"><UTextarea v-model="form.legal" :rows="2" class="w-full" /></UFormField>
            <UFormField label="Footer" class="sm:col-span-3"><UInput v-model="form.footer" class="w-full" /></UFormField>
          </div>
        </UCard>

      </fieldset>

      <div v-if="isAdmin" class="flex gap-2">
        <UButton type="submit" :loading="saving">Save settings</UButton>
      </div>
    </form>

    <BankAccountsCard v-if="form" />
    <ApiKeysCard v-if="form" />
  </div>
</template>
