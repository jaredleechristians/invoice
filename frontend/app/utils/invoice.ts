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

/** Deep-clone plain invoice data (safe with Vue reactive proxies). */
export function cloneInvoice<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sanitizeItems(items: unknown): LineItem[] | undefined {
  if (!Array.isArray(items)) return undefined
  return items.map((item) => ({
    description: String(item?.description ?? ''),
    note: String(item?.note ?? ''),
    qty: parseNumber(item?.qty ?? 1),
    unitPrice: parseNumber(item?.unitPrice ?? 0),
  }))
}

/**
 * Merge an agent/storage patch onto a base invoice.
 * Omitted fields keep the base value — so live edits are not wiped by defaults
 * or by a partial model response.
 */
export function mergeInvoice(
  base: Invoice,
  patch: Partial<Invoice> | null | undefined,
): Invoice {
  const current = cloneInvoice(base)
  if (!patch || typeof patch !== 'object') return current

  const next: Invoice = { ...current }

  if ('invoiceNumber' in patch && patch.invoiceNumber != null) {
    next.invoiceNumber = String(patch.invoiceNumber)
  }
  if ('issueDate' in patch && patch.issueDate != null) {
    next.issueDate = String(patch.issueDate)
  }
  if ('dueDate' in patch && patch.dueDate != null) {
    next.dueDate = String(patch.dueDate)
  }
  if ('notes' in patch && patch.notes != null) {
    next.notes = String(patch.notes)
  }
  if ('legal' in patch && patch.legal != null) {
    next.legal = String(patch.legal)
  }

  if (patch.billTo && typeof patch.billTo === 'object') {
    next.billTo = {
      name:
        'name' in patch.billTo && patch.billTo.name != null
          ? String(patch.billTo.name)
          : current.billTo.name,
      details:
        'details' in patch.billTo && patch.billTo.details != null
          ? String(patch.billTo.details)
          : current.billTo.details,
    }
  }

  if (patch.billFrom && typeof patch.billFrom === 'object') {
    next.billFrom = {
      name:
        'name' in patch.billFrom && patch.billFrom.name != null
          ? String(patch.billFrom.name)
          : current.billFrom.name,
      details:
        'details' in patch.billFrom && patch.billFrom.details != null
          ? String(patch.billFrom.details)
          : current.billFrom.details,
    }
  }

  if (patch.banking && typeof patch.banking === 'object') {
    next.banking = {
      bank:
        'bank' in patch.banking && patch.banking.bank != null
          ? String(patch.banking.bank)
          : current.banking.bank,
      accountName:
        'accountName' in patch.banking && patch.banking.accountName != null
          ? String(patch.banking.accountName)
          : current.banking.accountName,
      accountNumber:
        'accountNumber' in patch.banking && patch.banking.accountNumber != null
          ? String(patch.banking.accountNumber)
          : current.banking.accountNumber,
      branchCode:
        'branchCode' in patch.banking && patch.banking.branchCode != null
          ? String(patch.banking.branchCode)
          : current.banking.branchCode,
      reference:
        'reference' in patch.banking && patch.banking.reference != null
          ? String(patch.banking.reference)
          : current.banking.reference,
    }
  }

  const items = sanitizeItems(patch.items)
  if (items) next.items = items

  // Keep payment reference aligned when the invoice number changes.
  if ('invoiceNumber' in patch && patch.invoiceNumber != null) {
    next.banking.reference = String(next.invoiceNumber)
  }

  return next
}

export function normalizeInvoice(raw: Partial<Invoice> | null | undefined): Invoice {
  return mergeInvoice(cloneInvoice(DEFAULT_INVOICE), raw)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/**
 * Drop patch fields that are identical to the invoice we sent the model.
 * When the model echoes a full invoice, unchanged fields (prices, footer, etc.)
 * are not re-applied, so live edits that match the request stay put — and we
 * avoid rewriting fields the model copied without intending to change.
 */
export function diffInvoicePatch(
  patch: Partial<Invoice> | null | undefined,
  sent: Invoice,
): Partial<Invoice> | null {
  if (!patch || typeof patch !== 'object') return null

  const out: Partial<Invoice> = {}
  let any = false

  const scalarKeys = [
    'invoiceNumber',
    'issueDate',
    'dueDate',
    'notes',
    'legal',
  ] as const

  for (const key of scalarKeys) {
    if (!(key in patch) || patch[key] == null) continue
    if (stableStringify(patch[key]) === stableStringify(sent[key])) continue
    ;(out as Record<string, unknown>)[key] = patch[key]
    any = true
  }

  for (const key of ['billTo', 'billFrom', 'banking'] as const) {
    if (!(key in patch) || !patch[key] || typeof patch[key] !== 'object') continue
    if (stableStringify(patch[key]) === stableStringify(sent[key])) continue
    out[key] = patch[key] as never
    any = true
  }

  if ('items' in patch && Array.isArray(patch.items)) {
    if (stableStringify(patch.items) !== stableStringify(sent.items)) {
      out.items = patch.items
      any = true
    }
  }

  return any ? out : null
}

export function describeInvoicePatch(patch: Partial<Invoice> | null | undefined): string {
  if (!patch) return ''
  const parts: string[] = []
  if (patch.billTo) parts.push('bill to')
  if (patch.billFrom) parts.push('bill from')
  if (patch.items) parts.push(`${patch.items.length} line item${patch.items.length === 1 ? '' : 's'}`)
  if (patch.invoiceNumber) parts.push('invoice number')
  if (patch.issueDate || patch.dueDate) parts.push('dates')
  if (patch.notes) parts.push('notes')
  if (patch.banking) parts.push('banking')
  if (patch.legal) parts.push('footer')
  return parts.join(', ')
}

export type InvoiceStepId =
  | 'billTo'
  | 'billFrom'
  | 'items'
  | 'dates'
  | 'banking'

export const INVOICE_CHAT_STEPS: {
  id: InvoiceStepId
  label: string
  hint: string
  starter: string
}[] = [
  {
    id: 'billTo',
    label: '1. Bill to',
    hint: 'Customer name and address',
    starter: 'Set bill to ',
  },
  {
    id: 'billFrom',
    label: '2. Bill from',
    hint: 'Your business details',
    starter: 'Set bill from ',
  },
  {
    id: 'items',
    label: '3. Line items',
    hint: 'Descriptions, qty, and prices',
    starter: 'Replace line items with: ',
  },
  {
    id: 'dates',
    label: '4. Number & dates',
    hint: 'Invoice number, issue and due dates',
    starter: 'Set invoice number to INV-2026- and due date to ',
  },
  {
    id: 'banking',
    label: '5. Banking & notes',
    hint: 'Payment details and notes',
    starter: 'Set banking to bank , account name , account number , branch , and notes to ',
  },
]

/** Suggest the next guided step after a patch (or from current form state). */
export function suggestNextInvoiceStep(
  patch: Partial<Invoice> | null | undefined,
): (typeof INVOICE_CHAT_STEPS)[number] | null {
  const done = new Set<InvoiceStepId>()
  if (patch?.billTo) done.add('billTo')
  if (patch?.billFrom) done.add('billFrom')
  if (patch?.items) done.add('items')
  if (patch?.invoiceNumber || patch?.issueDate || patch?.dueDate) done.add('dates')
  if (patch?.banking || patch?.notes) done.add('banking')

  return INVOICE_CHAT_STEPS.find((step) => !done.has(step.id)) || null
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

function stripFences(text: string) {
  const trimmed = String(text || '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced?.[1] || trimmed).trim()
}

function extractBalanced(text: string, fromIndex = 0) {
  const start = text.indexOf('{', fromIndex)
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{') depth += 1
    if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function escapeControlCharsInStrings(jsonText: string) {
  let out = ''
  let inString = false
  let escape = false

  for (let i = 0; i < jsonText.length; i++) {
    const c = jsonText[i]
    if (inString) {
      if (escape) {
        out += c
        escape = false
        continue
      }
      if (c === '\\') {
        out += c
        escape = true
        continue
      }
      if (c === '"') {
        out += c
        inString = false
        continue
      }
      if (c === '\n') {
        out += '\\n'
        continue
      }
      if (c === '\r') {
        out += '\\r'
        continue
      }
      if (c === '\t') {
        out += '\\t'
        continue
      }
      out += c
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    out += c
  }
  return out
}

function lightRepair(jsonText: string) {
  return escapeControlCharsInStrings(jsonText)
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/^\uFEFF/, '')
}

function tryParse(jsonText: string) {
  for (const attempt of [jsonText, lightRepair(jsonText)]) {
    try {
      return JSON.parse(attempt)
    } catch {
      /* try next */
    }
  }
  return null
}

function looksLikeInvoice(obj: unknown): obj is Partial<Invoice> {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  return (
    typeof o.invoiceNumber === 'string' ||
    Array.isArray(o.items) ||
    !!o.billTo ||
    !!o.billFrom ||
    !!o.banking
  )
}

export function parseAssistantPayload(content: string): {
  message: string
  invoice: Partial<Invoice> | null
} {
  const trimmed = String(content || '').trim()
  if (!trimmed) return { message: '', invoice: null }

  const candidate = stripFences(trimmed)
  const blob = extractBalanced(candidate) || candidate
  const parsed = tryParse(blob)

  if (!parsed) {
    const invoiceKey = candidate.search(/"invoice"\s*:/)
    if (invoiceKey !== -1) {
      const afterColon = candidate.indexOf(':', invoiceKey)
      const invoiceBlob = extractBalanced(candidate, afterColon)
      const invoiceObj = invoiceBlob ? tryParse(invoiceBlob) : null
      if (looksLikeInvoice(invoiceObj)) {
        const msgMatch = candidate.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        return {
          message: msgMatch
            ? JSON.parse(`"${msgMatch[1]}"`)
            : 'Updated.',
          invoice: invoiceObj,
        }
      }
    }
    return { message: trimmed, invoice: null }
  }

  if (looksLikeInvoice(parsed) && !('message' in parsed) && !('invoice' in parsed)) {
    return { message: 'Updated.', invoice: parsed }
  }

  const invoiceRaw = looksLikeInvoice(parsed.invoice)
    ? parsed.invoice
    : looksLikeInvoice(parsed)
      ? parsed
      : null

  return {
    message: String(parsed.message || parsed.reply || '').trim() || 'Updated.',
    invoice: invoiceRaw,
  }
}
