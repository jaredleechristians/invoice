export type LineItem = {
  description: string
  note: string
  qty: number
  unitPrice: number
}

export type Invoice = {
  invoiceNumber: string
  issueDate: string
  dueDate: string
  billTo: { name: string; details: string }
  billFrom: { name: string; details: string }
  items: LineItem[]
  notes: string
  banking: {
    bank: string
    accountName: string
    accountNumber: string
    branchCode: string
    reference: string
  }
  legal: string
}

export const STORAGE_KEY = 'sa-invoice-data'

export const DEFAULT_INVOICE: Invoice = {
  invoiceNumber: 'INV-2026-0042',
  issueDate: '27 Jul 2026',
  dueDate: '26 Aug 2026',
  billTo: {
    name: 'Naledi Retail Group (Pty) Ltd',
    details:
      'Suite 4, The Pivot, Montecasino Blvd\nFourways, Johannesburg, 2191\naccounts@nalediretail.co.za\nVAT No. 4123456789\nReg. No. 2016/119204/07',
  },
  billFrom: {
    name: 'Harbour & Co. Consulting (Pty) Ltd',
    details:
      '12 Dock Road, V&A Waterfront\nCape Town, 8001, South Africa\n+27 21 555 0180 · accounts@harbourco.co.za\nReg. No. 2019/482731/07\nVAT No. 4876543210\nPayment terms: Net 30 · No VAT charged',
  },
  items: [
    {
      description: 'Brand strategy workshop',
      note: 'Facilitation · Cape Town · 2 days',
      qty: 2,
      unitPrice: 12500,
    },
    {
      description: 'Visual identity system',
      note: 'Logo suite, colour, typography, guidelines',
      qty: 1,
      unitPrice: 48000,
    },
    {
      description: 'Campaign landing page',
      note: 'Design + front-end build (desktop & mobile)',
      qty: 1,
      unitPrice: 28500,
    },
    {
      description: 'Monthly retainer — July 2026',
      note: 'Creative direction & production support',
      qty: 1,
      unitPrice: 18000,
    },
  ],
  notes:
    'Thank you for your business. Please quote the invoice number on your payment. Interest may be charged on overdue amounts in accordance with the National Credit Act.',
  banking: {
    bank: 'Standard Bank',
    accountName: 'Harbour & Co. Consulting',
    accountNumber: '012 345 678 9',
    branchCode: '051001',
    reference: 'INV-2026-0042',
  },
  legal:
    'Harbour & Co. Consulting (Pty) Ltd · VAT No. 4876543210 · Reg. No. 2019/482731/07',
}

export function formatMoney(amount: number) {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
  }).format(Number(amount) || 0)
}

export function parseNumber(value: unknown) {
  if (typeof value === 'number') return value
  const cleaned = String(value ?? '').replace(/[^\d.-]/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

export function normalizeInvoice(raw: Partial<Invoice> | null | undefined): Invoice {
  const base = structuredClone(DEFAULT_INVOICE)
  if (!raw || typeof raw !== 'object') return base

  return {
    ...base,
    ...raw,
    billTo: { ...base.billTo, ...(raw.billTo || {}) },
    billFrom: { ...base.billFrom, ...(raw.billFrom || {}) },
    banking: { ...base.banking, ...(raw.banking || {}) },
    items: Array.isArray(raw.items)
      ? raw.items.map((item) => ({
          description: String(item?.description ?? ''),
          note: String(item?.note ?? ''),
          qty: parseNumber(item?.qty ?? 1),
          unitPrice: parseNumber(item?.unitPrice ?? 0),
        }))
      : base.items,
  }
}

export function lineAmount(item: LineItem) {
  return parseNumber(item.qty) * parseNumber(item.unitPrice)
}

export function invoiceTotal(invoice: Invoice) {
  return (invoice.items || []).reduce((sum, item) => sum + lineAmount(item), 0)
}

export function escapeHtml(str: string) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function parseAssistantPayload(content: string): {
  message: string
  invoice: Invoice | null
} {
  const trimmed = String(content || '').trim()
  if (!trimmed) return { message: '', invoice: null }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] || trimmed).trim()

  try {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('no json')
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return {
      message: String(parsed.message || parsed.reply || '').trim() || 'Updated.',
      invoice: parsed.invoice ? normalizeInvoice(parsed.invoice) : null,
    }
  } catch {
    return { message: trimmed, invoice: null }
  }
}
