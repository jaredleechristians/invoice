<script setup lang="ts">
import { addDays } from '~/utils/money'

/**
 * Signed-out invoice editor. Same cards, fields and line-item table as the
 * signed-in DocumentForm, bound to the local (browser-only) invoice.
 */
const { invoice } = useInvoice()

/** Invoice number and banking reference stay in sync. */
const invoiceReference = computed({
  get: () => invoice.value.invoiceNumber,
  set: (value: string) => {
    invoice.value.invoiceNumber = value
    invoice.value.banking.reference = value
  },
})
watch(
  () => invoice.value.invoiceNumber,
  (value) => {
    if (invoice.value.banking.reference !== value) invoice.value.banking.reference = value
  },
  { immediate: true },
)

useHead(() => ({ title: `Invoice — ${invoice.value.invoiceNumber || 'Draft'}` }))

/** The local invoice stores display dates ("27 Jul 2026"); the picker works in ISO. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function displayToIso(value: string) {
  const m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/i.exec(value.trim())
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.toLowerCase())
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim()
  return ''
}
function dateModel(key: 'issueDate' | 'dueDate') {
  return computed({
    get: () => displayToIso(invoice.value[key] || ''),
    set: (iso: string) => {
      invoice.value[key] = iso ? formatDate(iso) : ''
    },
  })
}
const issueDateIso = dateModel('issueDate')
const dueDateIso = dateModel('dueDate')
const termPresets = computed(() =>
  issueDateIso.value
    ? [
        { label: 'On issue date', value: issueDateIso.value },
        ...[7, 14, 30, 60].map((d) => ({ label: `${d} days`, value: addDays(issueDateIso.value, d) })),
      ]
    : [],
)

const newLine = () => ({ description: '', note: '', qty: 1, unitPrice: 0 })
</script>

<template>
  <div class="space-y-6">
    <UCard>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Bill to">
          <div class="space-y-2">
            <UInput v-model="invoice.billTo.name" placeholder="Customer name" aria-label="Bill to name" icon="i-lucide-user" class="w-full" />
            <UTextarea v-model="invoice.billTo.details" :rows="3" autoresize placeholder="Address, email, VAT / reg. numbers" aria-label="Bill to details" class="w-full" />
          </div>
        </UFormField>
        <UFormField label="From">
          <div class="space-y-2">
            <UInput v-model="invoice.billFrom.name" placeholder="Your business name" aria-label="Bill from name" icon="i-lucide-building-2" class="w-full" />
            <UTextarea v-model="invoice.billFrom.details" :rows="3" autoresize placeholder="Address, contact, VAT / reg. numbers" aria-label="Bill from details" class="w-full" />
          </div>
        </UFormField>
      </div>
      <div class="mt-4 grid gap-4 sm:grid-cols-4">
        <UFormField label="Invoice number">
          <UInput v-model="invoiceReference" aria-label="Invoice number" class="w-full" />
        </UFormField>
        <UFormField label="Currency">
          <UInput model-value="ZAR" disabled class="w-full" aria-label="Currency" />
        </UFormField>
        <UFormField label="Issue date">
          <DatePicker v-model="issueDateIso" block />
        </UFormField>
        <UFormField label="Due date">
          <DatePicker v-model="dueDateIso" block :presets="termPresets" />
        </UFormField>
      </div>
    </UCard>

    <LineItemsEditor v-model="invoice.items" currency="ZAR" :new-line="newLine" />

    <UCard>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Notes (shown on the document)">
          <UTextarea v-model="invoice.notes" :rows="4" autoresize class="w-full" />
        </UFormField>
        <UFormField label="Footer">
          <UTextarea v-model="invoice.legal" :rows="4" autoresize class="w-full" placeholder="e.g. company registration and VAT numbers" />
        </UFormField>
      </div>
    </UCard>

    <UCard>
      <template #header><span class="font-medium">Banking details</span></template>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <UFormField label="Bank"><UInput v-model="invoice.banking.bank" class="w-full" /></UFormField>
        <UFormField label="Account name"><UInput v-model="invoice.banking.accountName" class="w-full" /></UFormField>
        <UFormField label="Account number"><UInput v-model="invoice.banking.accountNumber" class="w-full" /></UFormField>
        <UFormField label="Branch code"><UInput v-model="invoice.banking.branchCode" class="w-full" /></UFormField>
        <UFormField label="Payment reference" help="Follows the invoice number.">
          <UInput v-model="invoiceReference" class="w-full" aria-label="Payment reference" />
        </UFormField>
      </div>
    </UCard>
  </div>
</template>
