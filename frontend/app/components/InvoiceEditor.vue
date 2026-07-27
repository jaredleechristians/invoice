<script setup lang="ts">
const {
  invoice,
  savedFlash,
  addLineItem,
  removeLineItem,
  saveToStorage,
} = useInvoice()

const pdfBusy = ref(false)

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

useHead(() => ({
  title: `Invoice — ${invoice.value.invoiceNumber || 'Draft'}`,
}))

async function downloadPdf() {
  pdfBusy.value = true
  try {
    const html = buildExportHtml(invoice.value)
    const form = new FormData()
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html')
    form.append('paperWidth', '8.27')
    form.append('paperHeight', '11.7')
    form.append('marginTop', '0')
    form.append('marginBottom', '0')
    form.append('marginLeft', '0')
    form.append('marginRight', '0')
    form.append('printBackground', 'true')
    form.append('preferCssPageSize', 'false')
    form.append('emulatedMediaType', 'print')

    const res = await fetch('/api/pdf', { method: 'POST', body: form })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }

    const blob = await res.blob()
    const filename = `${(invoice.value.invoiceNumber || 'invoice').replace(/[^\w.-]+/g, '_')}.pdf`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    console.error(err)
    alert(
      'PDF export failed. Start the stack with docker compose up, then open the Nuxt app.\n\n' +
        String(err?.message || err),
    )
  } finally {
    pdfBusy.value = false
  }
}
</script>

<template>
  <div>
    <div class="toolbar">
      <div class="toolbar-actions">
        <button type="button" class="btn btn-secondary" @click="saveToStorage">
          {{ savedFlash ? 'Saved' : 'Save' }}
        </button>
        <button type="button" class="btn" :disabled="pdfBusy" @click="downloadPdf">
          {{ pdfBusy ? 'Preparing PDF…' : 'Download PDF' }}
        </button>
      </div>
    </div>

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
                <input
                  v-model="invoice.issueDate"
                  class="field mono"
                  type="text"
                  aria-label="Issue date"
                  style="text-align:right;width:auto;min-width:7rem;color:var(--ink);font-weight:500"
                >
              </div>
              <div class="doc-meta-row">
                <span>Due date:</span>
                <input
                  v-model="invoice.dueDate"
                  class="field mono"
                  type="text"
                  aria-label="Due date"
                  style="text-align:right;width:auto;min-width:7rem;color:var(--ink);font-weight:500"
                >
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
                  ×
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="line-actions">
          <button type="button" class="btn-add" @click="addLineItem">
            + Add line item
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
