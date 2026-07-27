import { escapeHtml, formatMoney, invoiceTotal, lineAmount, type Invoice } from '~/utils/invoice'

const EXPORT_CSS = `
:root {
  --ink: #1a1f2e;
  --muted: #5c6578;
  --line: #e2e6ef;
  --surface: #f6f7fa;
  --accent: #0d6e6e;
  --accent-soft: #e6f4f4;
  --white: #ffffff;
  font-size: 14px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "DM Sans", system-ui, sans-serif;
  color: var(--ink);
  background: #fff;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
.invoice-inner { padding: 14mm 16mm; }
.header {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2rem;
  padding-bottom: 2rem;
  border-bottom: 1px solid var(--line);
}
.company-name { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.35rem; }
.company-meta { font-size: 0.8125rem; color: var(--muted); line-height: 1.6; white-space: pre-wrap; }
.doc-badge { text-align: right; }
.doc-type {
  display: inline-block;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  margin-bottom: 0.75rem;
}
.doc-title { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 0.5rem; }
.doc-meta { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.75rem; color: var(--muted); line-height: 1.7; }
.doc-meta strong { color: var(--ink); font-weight: 500; }
.parties {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2rem;
  padding: 1.75rem 0;
  border-bottom: 1px solid var(--line);
}
.party-label {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 0.5rem;
}
.party-name { font-size: 1rem; font-weight: 600; margin-bottom: 0.35rem; }
.party-details { font-size: 0.8125rem; color: var(--muted); line-height: 1.6; white-space: pre-wrap; }
.mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.8125rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; margin-top: 1.75rem; }
thead th {
  text-align: left;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 0.65rem 0.75rem;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}
thead th:first-child { border-radius: 6px 0 0 6px; padding-left: 1rem; }
thead th:last-child { border-radius: 0 6px 6px 0; padding-right: 1rem; }
thead th.num, tbody td.num { text-align: right; }
tbody td {
  padding: 1rem 0.75rem;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
tbody td:first-child { padding-left: 1rem; }
tbody td:last-child { padding-right: 1rem; }
.item-desc { font-weight: 600; margin-bottom: 0.2rem; }
.item-note { font-size: 0.75rem; color: var(--muted); }
.totals { display: flex; justify-content: flex-end; padding-top: 1.5rem; }
.totals-box { width: min(100%, 280px); }
.totals-row {
  display: flex;
  justify-content: space-between;
  gap: 2rem;
  padding-top: 0.75rem;
  border-top: 2px solid var(--ink);
  font-size: 1.0625rem;
  font-weight: 700;
}
.footer-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 2rem;
  margin-top: 2.5rem;
  padding-top: 1.75rem;
  border-top: 1px solid var(--line);
}
.footer-block h3 {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 0.5rem;
}
.notes { font-size: 0.8125rem; color: var(--muted); line-height: 1.6; white-space: pre-wrap; }
.bank-details { background: var(--surface); border-radius: 8px; padding: 1rem 1.15rem; }
.bank-details dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.35rem 1rem;
  font-size: 0.8125rem;
}
.bank-details dt { color: var(--muted); }
.bank-details dd { font-weight: 500; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.75rem; }
.legal {
  margin-top: 1.75rem;
  font-size: 0.6875rem;
  color: #8a93a6;
  text-align: center;
  line-height: 1.5;
  white-space: pre-wrap;
}
`

export function buildExportHtml(invoice: Invoice) {
  const headerDetails = invoice.billFrom.details.split('\n').slice(0, 4).join('\n')
  const rows = invoice.items
    .map((item) => {
      const amount = lineAmount(item)
      return `<tr>
        <td>
          <div class="item-desc">${escapeHtml(item.description)}</div>
          ${item.note ? `<div class="item-note">${escapeHtml(item.note)}</div>` : ''}
        </td>
        <td class="num mono">${escapeHtml(String(item.qty))}</td>
        <td class="num mono">${escapeHtml(formatMoney(item.unitPrice))}</td>
        <td class="num mono">${escapeHtml(formatMoney(amount))}</td>
      </tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en-ZA">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(invoice.invoiceNumber || 'Invoice')}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>${EXPORT_CSS}</style>
</head>
<body>
  <article class="invoice">
    <div class="invoice-inner">
      <header class="header">
        <div>
          <h1 class="company-name">${escapeHtml(invoice.billFrom.name)}</h1>
          <div class="company-meta">${escapeHtml(headerDetails)}</div>
        </div>
        <div class="doc-badge">
          <span class="doc-type">Invoice</span>
          <div class="doc-title">Invoice</div>
          <div class="doc-meta">
            <div><strong>${escapeHtml(invoice.invoiceNumber)}</strong></div>
            <div>Issue date: <strong>${escapeHtml(invoice.issueDate)}</strong></div>
            <div>Due date: <strong>${escapeHtml(invoice.dueDate)}</strong></div>
          </div>
        </div>
      </header>

      <section class="parties">
        <div>
          <div class="party-label">Bill to</div>
          <div class="party-name">${escapeHtml(invoice.billTo.name)}</div>
          <div class="party-details">${escapeHtml(invoice.billTo.details)}</div>
        </div>
        <div>
          <div class="party-label">From</div>
          <div class="party-name">${escapeHtml(invoice.billFrom.name)}</div>
          <div class="party-details">${escapeHtml(invoice.billFrom.details)}</div>
        </div>
      </section>

      <table>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col" class="num">Qty</th>
            <th scope="col" class="num">Unit price</th>
            <th scope="col" class="num">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="totals">
        <div class="totals-box">
          <div class="totals-row">
            <span>Total due</span>
            <span class="mono">${escapeHtml(formatMoney(invoiceTotal(invoice)))}</span>
          </div>
        </div>
      </div>

      <div class="footer-grid">
        <div class="footer-block">
          <h3>Notes</h3>
          <div class="notes">${escapeHtml(invoice.notes)}</div>
        </div>
        <div class="footer-block bank-details">
          <h3>Banking details</h3>
          <dl>
            <dt>Bank</dt><dd>${escapeHtml(invoice.banking.bank)}</dd>
            <dt>Account name</dt><dd>${escapeHtml(invoice.banking.accountName)}</dd>
            <dt>Account no.</dt><dd>${escapeHtml(invoice.banking.accountNumber)}</dd>
            <dt>Branch code</dt><dd>${escapeHtml(invoice.banking.branchCode)}</dd>
            <dt>Reference</dt><dd>${escapeHtml(invoice.banking.reference)}</dd>
          </dl>
        </div>
      </div>

      <p class="legal">${escapeHtml(invoice.legal)}</p>
    </div>
  </article>
</body>
</html>`
}
