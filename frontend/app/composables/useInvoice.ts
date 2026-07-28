import {
  DEFAULT_INVOICE,
  STORAGE_KEY,
  cloneInvoice,
  mergeInvoice,
  diffInvoicePatch,
  normalizeInvoice,
  type Invoice,
} from '~/utils/invoice'

export function useInvoice() {
  const invoice = useState<Invoice>('invoice', () => cloneInvoice(DEFAULT_INVOICE))
  const hydrated = useState('invoice-hydrated', () => false)
  const savedFlash = useState('invoice-saved-flash', () => false)

  function loadFromStorage() {
    if (!import.meta.client) return
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) invoice.value = normalizeInvoice(JSON.parse(raw))
    } catch {
      invoice.value = cloneInvoice(DEFAULT_INVOICE)
    } finally {
      hydrated.value = true
    }
  }

  function saveToStorage() {
    if (!import.meta.client) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(invoice.value, null, 2))
    savedFlash.value = true
    setTimeout(() => {
      savedFlash.value = false
    }, 1500)
  }

  function applyInvoice(patch: Partial<Invoice>, sent?: Invoice) {
    const effective = sent ? diffInvoicePatch(patch, sent) : patch
    if (!effective) return
    // Merge onto the live form so omitted agent fields don't reset unsaved edits.
    invoice.value = mergeInvoice(invoice.value, effective)
  }

  function addLineItem() {
    invoice.value.items.push({
      description: 'New line item',
      note: '',
      qty: 1,
      unitPrice: 0,
    })
  }

  function removeLineItem(index: number) {
    invoice.value.items.splice(index, 1)
    if (!invoice.value.items.length) {
      invoice.value.items.push({
        description: '',
        note: '',
        qty: 1,
        unitPrice: 0,
      })
    }
  }

  return {
    invoice,
    hydrated,
    savedFlash,
    loadFromStorage,
    saveToStorage,
    applyInvoice,
    addLineItem,
    removeLineItem,
  }
}
