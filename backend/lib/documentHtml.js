// Server-side HTML for invoice / quote PDFs (rendered by Gotenberg).
const { escapeHtml: e, formatDate } = require("./html");
const { formatMoney, lineAmount, roundMoney } = require("./money");
const { issuerSnapshot } = require("./documents");

const CSS = `
:root { --ink:#1a1f2e; --muted:#5c6578; --line:#e2e6ef; --surface:#f6f7fa; --accent:#0d6e6e; --accent-soft:#e6f4f4; font-size:14px; }
* { box-sizing:border-box; margin:0; padding:0; }
@page { size: A4; margin: 0; }
body { font-family:"DM Sans",system-ui,sans-serif; color:var(--ink); background:#fff; line-height:1.45; }
.inner { padding:14mm 16mm; position:relative; }
.header { display:grid; grid-template-columns:1fr auto; gap:2rem; padding-bottom:1.5rem; border-bottom:1px solid var(--line); }
.logo { max-height:64px; max-width:220px; margin-bottom:0.6rem; display:block; }
.company-name { font-size:1.375rem; font-weight:700; letter-spacing:-0.02em; margin-bottom:0.35rem; }
.meta { font-size:0.8125rem; color:var(--muted); line-height:1.6; white-space:pre-wrap; }
.badge { text-align:right; }
.doc-type { display:inline-block; font-size:0.6875rem; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:var(--accent); background:var(--accent-soft); padding:0.35rem 0.65rem; border-radius:4px; margin-bottom:0.75rem; }
.doc-meta { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:0.75rem; color:var(--muted); line-height:1.8; }
.doc-meta strong { color:var(--ink); font-weight:500; }
.parties { display:grid; grid-template-columns:1fr 1fr; gap:2rem; padding:1.5rem 0; border-bottom:1px solid var(--line); }
.label { font-size:0.6875rem; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:var(--muted); margin-bottom:0.5rem; }
.party-name { font-size:1rem; font-weight:600; margin-bottom:0.35rem; }
.mono { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:0.8125rem; }
table { width:100%; border-collapse:collapse; font-size:0.875rem; margin-top:1.5rem; }
thead th { text-align:left; font-size:0.6875rem; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); padding:0.65rem 0.75rem; background:var(--surface); border-bottom:1px solid var(--line); }
th.num, td.num { text-align:right; }
tbody td { padding:0.85rem 0.75rem; border-bottom:1px solid var(--line); vertical-align:top; }
tbody tr { page-break-inside: avoid; }
.item-desc { font-weight:600; margin-bottom:0.2rem; }
.item-note { font-size:0.75rem; color:var(--muted); white-space:pre-wrap; }
.totals { display:flex; justify-content:flex-end; padding-top:1.25rem; }
.totals-box { width:min(100%,300px); font-size:0.9rem; }
.row { display:flex; justify-content:space-between; gap:2rem; padding:0.3rem 0; }
.row.grand { padding-top:0.75rem; margin-top:0.35rem; border-top:2px solid var(--ink); font-size:1.0625rem; font-weight:700; }
.footer-grid { display:grid; grid-template-columns:1.2fr 1fr; gap:2rem; margin-top:2rem; padding-top:1.5rem; border-top:1px solid var(--line); page-break-inside: avoid; }
.notes { font-size:0.8125rem; color:var(--muted); line-height:1.6; white-space:pre-wrap; }
.bank { background:var(--surface); border-radius:8px; padding:0.9rem 1.1rem; margin-bottom:0.6rem; }
.bank-title { font-weight:600; font-size:0.8125rem; margin-bottom:0.3rem; }
.bank pre { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:0.75rem; white-space:pre-wrap; line-height:1.6; }
.legal { margin-top:2rem; font-size:0.6875rem; color:#8a93a6; text-align:center; line-height:1.5; white-space:pre-wrap; }
.stamp { position:absolute; top:42%; left:50%; transform:translate(-50%,-50%) rotate(-18deg); font-size:7rem; font-weight:800; letter-spacing:0.1em; color:rgba(180,35,24,0.13); pointer-events:none; }
.stamp.paid { color:rgba(13,110,110,0.13); }
`;

function legacyBankText(banking) {
  if (!banking || typeof banking !== "object") return "";
  return [
    banking.bank && `Bank: ${banking.bank}`,
    banking.accountName && `Account name: ${banking.accountName}`,
    banking.accountNumber && `Account no.: ${banking.accountNumber}`,
    banking.branchCode && `Branch code: ${banking.branchCode}`,
    banking.reference && `Reference: ${banking.reference}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Resolve the "from" block for a document: frozen issuer snapshot (finalized
 * invoices), the anonymous-editor payload (imports), or live company settings.
 */
function resolveIssuer(doc, company) {
  if (doc.issuer) return doc.issuer;
  if (doc.payload?.billFrom) {
    const bankText = legacyBankText(doc.payload.banking || doc.banking);
    return {
      name: doc.payload.billFrom.name || company.name || "",
      details: doc.payload.billFrom.details || "",
      bankAccounts: bankText ? [{ label: "Banking details", currency: "", details: bankText }] : [],
      legal: doc.payload.legal || "",
      footer: "",
    };
  }
  return issuerSnapshot(company, doc.currency || "ZAR");
}

function renderDocumentHtml({ kind = "invoice", doc, company = {} }) {
  const currency = doc.currency || "ZAR";
  const money = (n) => formatMoney(n, currency);
  const issuer = resolveIssuer(doc, company);
  const isInvoice = kind === "invoice";
  const title = isInvoice ? (doc.draft ? "Draft invoice" : "Invoice") : "Quote";
  const number = isInvoice ? doc.invoiceNumber : doc.quoteNumber;
  const vatRate = Number(doc.vatRate) || 0;
  const subtotal = doc.subtotal ?? doc.total;
  const paid = roundMoney(doc.paidAmount || 0);
  const balance = roundMoney((doc.total || 0) - paid);

  const rows = (doc.items || [])
    .map(
      (item) => `<tr>
        <td><div class="item-desc">${e(item.description)}</div>${item.note ? `<div class="item-note">${e(item.note)}</div>` : ""}</td>
        <td class="num mono">${e(String(item.qty))}</td>
        <td class="num mono">${e(money(item.unitPrice))}</td>
        <td class="num mono">${e(money(lineAmount(item)))}</td>
      </tr>`
    )
    .join("");

  const metaLines = [
    number ? `<div><strong>${e(number)}</strong></div>` : "",
    `<div>${isInvoice ? "Issue date" : "Date"}: <strong>${e(formatDate(doc.issueDate))}</strong></div>`,
    isInvoice && doc.dueDate ? `<div>Due date: <strong>${e(formatDate(doc.dueDate))}</strong></div>` : "",
    !isInvoice && doc.expiryDate ? `<div>Valid until: <strong>${e(formatDate(doc.expiryDate))}</strong></div>` : "",
    doc.reference ? `<div>Reference: <strong>${e(doc.reference)}</strong></div>` : "",
    `<div>Currency: <strong>${e(currency)}</strong></div>`,
  ].join("");

  const totals = [
    vatRate > 0 ? `<div class="row"><span>Subtotal</span><span class="mono">${e(money(subtotal))}</span></div>` : "",
    vatRate > 0 ? `<div class="row"><span>VAT (${e(String(vatRate))}%)</span><span class="mono">${e(money(doc.taxTotal || 0))}</span></div>` : "",
    `<div class="row ${isInvoice && paid > 0 ? "" : "grand"}"><span>${isInvoice ? "Total" : "Quote total"}</span><span class="mono">${e(money(doc.total || 0))}</span></div>`,
    isInvoice && paid > 0 ? `<div class="row"><span>Paid</span><span class="mono">−${e(money(paid))}</span></div>` : "",
    isInvoice && paid > 0 ? `<div class="row grand"><span>Balance due</span><span class="mono">${e(money(Math.max(0, balance)))}</span></div>` : "",
  ].join("");

  const banks = isInvoice
    ? (issuer.bankAccounts || [])
        .map((a) => `<div class="bank">${a.label ? `<div class="bank-title">${e(a.label)}${a.currency ? ` (${e(a.currency)})` : ""}</div>` : ""}<pre>${e(a.details)}</pre></div>`)
        .join("")
    : "";

  const stamp = doc.voided ? `<div class="stamp">VOID</div>` : isInvoice && !doc.draft && balance <= 0 && doc.total > 0 ? `<div class="stamp paid">PAID</div>` : "";
  const logo = company.logoDataUrl ? `<img class="logo" src="${e(company.logoDataUrl)}" alt="" />` : "";
  const legal = [issuer.legal, issuer.footer || doc.footer].filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="en-ZA"><head><meta charset="UTF-8" /><title>${e(number || title)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${CSS}</style></head>
<body><article><div class="inner">${stamp}
  <header class="header">
    <div>${logo}<h1 class="company-name">${e(issuer.name)}</h1><div class="meta">${e(issuer.details)}</div></div>
    <div class="badge"><span class="doc-type">${e(title)}</span><div class="doc-meta">${metaLines}</div></div>
  </header>
  <section class="parties">
    <div><div class="label">${isInvoice ? "Bill to" : "Prepared for"}</div><div class="party-name">${e(doc.customerName || "")}</div>
      <div class="meta">${e(String(doc.billTo || "").split("\n").filter((l, i) => !(i === 0 && l.trim() === String(doc.customerName || "").trim())).join("\n"))}</div></div>
    <div></div>
  </section>
  <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="4" class="meta">No line items</td></tr>`}</tbody></table>
  <div class="totals"><div class="totals-box">${totals}</div></div>
  <div class="footer-grid">
    <div>${doc.notes ? `<div class="label">Notes</div><div class="notes">${e(doc.notes)}</div>` : ""}</div>
    <div>${banks ? `<div class="label">Payment details</div>${banks}` : ""}</div>
  </div>
  ${legal ? `<p class="legal">${e(legal)}</p>` : ""}
</div></article></body></html>`;
}

module.exports = { renderDocumentHtml, resolveIssuer, legacyBankText };
