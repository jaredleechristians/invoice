<script setup lang="ts">
/**
 * The A4 invoice sheet of the signed-out editor. Only used for browser print
 * now (pages/index.vue renders it print-only); the on-screen editor is
 * InvoiceEditor.vue. The PDF export renders buildExportHtml separately.
 */
const {
  invoice,
  addLineItem,
  removeLineItem,
} = useInvoice()

const totalLabel = computed(() => formatMoney(invoiceTotal(invoice.value)))
const headerDetails = computed(() =>
  invoice.value.billFrom.details.split('\n').slice(0, 4).join('\n'),
)

/** Invoice number under the heading and banking reference stay in sync. */
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
    if (invoice.value.banking.reference !== value) {
      invoice.value.banking.reference = value
    }
  },
  { immediate: true },
)

/** The editor stores display dates ("27 Jul 2026"); the picker works in ISO. */
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
</script>

<template>
  <div>
    <article class="invoice" aria-label="Invoice">
      <div class="invoice-inner">
        <header class="header">
          <div>
            <input
              v-model="invoice.billFrom.name"
              class="field company-name"
              type="text"
              aria-label="Company name"
            >
            <div class="company-meta">{{ headerDetails }}</div>
          </div>
          <div class="doc-badge">
            <span class="doc-type">Invoice</span>
            <div class="doc-title">Invoice</div>
            <div class="doc-meta">
              <div class="doc-meta-row">
                <input
                  v-model="invoiceReference"
                  class="field mono"
                  type="text"
                  aria-label="Invoice number"
                  style="text-align:right;font-weight:500;color:var(--ink)"
                >
              </div>
              <div class="doc-meta-row">
                <span>Issue date:</span>
                <DatePicker v-model="issueDateIso">
                  <template #default="{ empty }">
                    <button type="button" class="field mono date-trigger" data-testid="issue-date" aria-label="Issue date">
                      {{ empty ? (invoice.issueDate || 'Pick a date') : invoice.issueDate }}
                    </button>
                  </template>
                </DatePicker>
              </div>
              <div class="doc-meta-row">
                <span>Due date:</span>
                <DatePicker v-model="dueDateIso">
                  <template #default="{ empty }">
                    <button type="button" class="field mono date-trigger" data-testid="due-date" aria-label="Due date">
                      {{ empty ? (invoice.dueDate || 'Pick a date') : invoice.dueDate }}
                    </button>
                  </template>
                </DatePicker>
              </div>
            </div>
          </div>
        </header>

        <section class="parties">
          <div>
            <div class="party-label">Bill to</div>
            <input
              v-model="invoice.billTo.name"
              class="field party-name"
              type="text"
              aria-label="Bill to name"
            >
            <textarea
              v-model="invoice.billTo.details"
              class="field party-details"
              rows="5"
              aria-label="Bill to details"
            />
          </div>
          <div>
            <div class="party-label">From</div>
            <input
              v-model="invoice.billFrom.name"
              class="field party-name"
              type="text"
              aria-label="Bill from name"
            >
            <textarea
              v-model="invoice.billFrom.details"
              class="field party-details"
              rows="4"
              aria-label="Bill from details"
            />
          </div>
        </section>

        <table>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" class="num">Qty</th>
              <th scope="col" class="num">Unit price</th>
              <th scope="col" class="num">Amount</th>
              <th scope="col" class="actions" aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in invoice.items" :key="index">
              <td>
                <input
                  v-model="item.description"
                  class="field item-desc"
                  type="text"
                  aria-label="Description"
                >
                <input
                  v-model="item.note"
                  class="field item-note"
                  type="text"
                  aria-label="Line note"
                  placeholder="Optional note"
                >
              </td>
              <td class="num">
                <input
                  v-model.number="item.qty"
                  class="field num"
                  type="text"
                  inputmode="decimal"
                  aria-label="Quantity"
                >
              </td>
              <td class="num">
                <input
                  v-model.number="item.unitPrice"
                  class="field num"
                  type="text"
                  inputmode="decimal"
                  aria-label="Unit price"
                >
              </td>
              <td class="num amount-cell">
                {{ formatMoney(lineAmount(item)) }}
              </td>
              <td class="actions">
                <button
                  type="button"
                  class="btn-remove"
                  aria-label="Remove line item"
                  @click="removeLineItem(index)"
                >
                  <UIcon name="i-lucide-x" class="size-4" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="line-actions">
          <button type="button" class="btn-add" @click="addLineItem">
            <UIcon name="i-lucide-plus" class="size-4" /> Add line item
          </button>
        </div>

        <div class="totals">
          <div class="totals-box">
            <div class="totals-row grand">
              <span>Total due</span>
              <span class="mono">{{ totalLabel }}</span>
            </div>
          </div>
        </div>

        <div class="footer-grid">
          <div class="footer-block">
            <h3>Notes</h3>
            <textarea
              v-model="invoice.notes"
              class="field notes-field"
              rows="4"
              aria-label="Notes"
            />
          </div>
          <div class="footer-block bank-details">
            <h3>Banking details</h3>
            <dl>
              <dt>Bank</dt>
              <dd>
                <input v-model="invoice.banking.bank" class="field" type="text" aria-label="Bank name">
              </dd>
              <dt>Account name</dt>
              <dd>
                <input
                  v-model="invoice.banking.accountName"
                  class="field"
                  type="text"
                  aria-label="Account name"
                >
              </dd>
              <dt>Account no.</dt>
              <dd>
                <input
                  v-model="invoice.banking.accountNumber"
                  class="field"
                  type="text"
                  aria-label="Account number"
                >
              </dd>
              <dt>Branch code</dt>
              <dd>
                <input
                  v-model="invoice.banking.branchCode"
                  class="field"
                  type="text"
                  aria-label="Branch code"
                >
              </dd>
              <dt>Reference</dt>
              <dd>
                <input
                  v-model="invoiceReference"
                  class="field"
                  type="text"
                  aria-label="Payment reference"
                >
              </dd>
            </dl>
          </div>
        </div>

        <textarea
          v-model="invoice.legal"
          class="field legal"
          rows="2"
          aria-label="Footer"
        />
      </div>
    </article>

  </div>
</template>
