// Customer statement HTML (Gotenberg PDF and the in-app preview). Uses the
// invoice PDF styles so both documents look the same. A statement is not a
// tax invoice, so it is never labelled as one.
const { escapeHtml: e, formatDate } = require("./html");
const { formatMoney } = require("./money");
const { AGING_BUCKETS } = require("./status");
const { CSS } = require("./documentHtml");
const { issuerSnapshot } = require("./documents");

const BUCKET_LABELS = { current: "Current", "1-30": "1-30 days", "31-60": "31-60 days", "61-90": "61-90 days", "90+": "90+ days" };

const EXTRA_CSS = `
.summary { display:grid; grid-template-columns:repeat(4,1fr); gap:0.75rem; margin-top:1.5rem; }
.summary .cell { background:var(--surface); border-radius:8px; padding:0.7rem 0.9rem; }
.summary .k { font-size:0.6875rem; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--muted); margin-bottom:0.25rem; }
.summary .v { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:0.9rem; }
.summary .cell.due { background:var(--accent-soft); }
.summary .cell.due .v { font-weight:600; color:var(--ink); }
h2.cur { font-size:0.8125rem; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--accent); margin-top:2rem; }
table.ledger tbody td { padding:0.55rem 0.75rem; }
tr.opening td, tr.closing td { background:var(--surface); font-weight:600; }
table.aging { margin-top:1rem; }
table.aging td, table.aging th { text-align:right; }
table.aging td:first-child, table.aging th:first-child { text-align:left; }
.sub { font-size:0.75rem; color:var(--muted); }
`;

function customerBlock(customer) {
  const lines = [customer.address, customer.email, customer.phone, customer.taxNumber ? `Tax no. ${customer.taxNumber}` : ""].filter(Boolean).join("\n");
  return `<div class="party-name">${e(customer.name || "")}</div><div class="meta">${e(lines)}</div>`;
}

function sectionHtml(s, aging, multi) {
  const money = (n) => formatMoney(n, s.currency);
  const rows = s.entries
    .map(
      (x) => `<tr>
      <td class="mono">${e(formatDate(x.date))}</td>
      <td><div class="item-desc">${e(x.description)}</div>${x.type === "invoice" && x.dueDate ? `<div class="sub">Due ${e(formatDate(x.dueDate))}</div>` : ""}${x.type === "payment" && x.reference ? `<div class="sub">Ref ${e(x.reference)}</div>` : ""}</td>
      <td class="num mono">${x.debit ? e(money(x.debit)) : ""}</td>
      <td class="num mono">${x.credit ? e(money(x.credit)) : ""}</td>
      <td class="num mono">${e(money(x.balance))}</td>
    </tr>`
    )
    .join("");
  const agingRow = AGING_BUCKETS.map((b) => `<td class="mono">${e(money(aging?.[b] || 0))}</td>`).join("");
  return `
  ${multi ? `<h2 class="cur">${e(s.currency)}</h2>` : ""}
  <div class="summary">
    <div class="cell"><div class="k">Opening balance</div><div class="v">${e(money(s.opening))}</div></div>
    <div class="cell"><div class="k">Invoiced</div><div class="v">${e(money(s.invoiced))}</div></div>
    <div class="cell"><div class="k">Paid</div><div class="v">${e(money(s.paid))}</div></div>
    <div class="cell due"><div class="k">${s.closing < 0 ? "In credit" : "Balance due"}</div><div class="v">${e(money(Math.abs(s.closing)))}</div></div>
  </div>
  <table class="ledger"><thead><tr><th>Date</th><th>Details</th><th class="num">Invoiced</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead>
  <tbody>
    <tr class="opening"><td></td><td>Opening balance</td><td></td><td></td><td class="num mono">${e(money(s.opening))}</td></tr>
    ${rows || `<tr><td></td><td class="meta" colspan="4">No invoices or payments in this period</td></tr>`}
    <tr class="closing"><td></td><td>Closing balance</td><td></td><td></td><td class="num mono">${e(money(s.closing))}</td></tr>
  </tbody></table>
  <table class="aging"><thead><tr><th>Ageing</th>${AGING_BUCKETS.map((b) => `<th>${e(BUCKET_LABELS[b])}</th>`).join("")}</tr></thead>
  <tbody><tr><td class="meta">Outstanding</td>${agingRow}</tr></tbody></table>`;
}

function renderStatementHtml(statement, { company = {}, companyName } = {}) {
  const { customer = {}, period = {}, currencies = [], ledger = {}, aging = {} } = statement;
  const primary = currencies[0] || customer.currency || company.defaultCurrency || "ZAR";
  const issuer = issuerSnapshot({ ...company, name: company.name || companyName || "" }, primary);
  // Payment details for every currency on the statement, without repeats.
  const seen = new Set();
  const banks = (currencies.length ? currencies : [primary])
    .flatMap((c) => issuerSnapshot(company, c).bankAccounts)
    .filter((a) => {
      const k = `${a.label}|${a.details}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((a) => `<div class="bank">${a.label ? `<div class="bank-title">${e(a.label)}${a.currency ? ` (${e(a.currency)})` : ""}</div>` : ""}<pre>${e(a.details)}</pre></div>`)
    .join("");
  const logo = company.logoDataUrl ? `<img class="logo" src="${e(company.logoDataUrl)}" alt="" />` : "";
  const multi = currencies.length > 1;
  const sections = currencies.length
    ? currencies.map((c) => sectionHtml(ledger[c], aging[c], multi)).join("")
    : `<p class="meta" style="margin-top:1.5rem">No invoices for this customer up to ${e(formatDate(period.to))}.</p>`;
  const legal = [issuer.legal, issuer.footer].filter(Boolean).join("\n");
  const periodText = period.from ? `${formatDate(period.from)} to ${formatDate(period.to)}` : `Up to ${formatDate(period.to)}`;
  const dueLine = currencies.map((c) => formatMoney(ledger[c].closing, c)).join(" / ");

  return `<!DOCTYPE html>
<html lang="en-ZA"><head><meta charset="UTF-8" /><title>Statement - ${e(customer.name || "")}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>${CSS}${EXTRA_CSS}</style></head>
<body><article><div class="inner">
  <header class="header">
    <div>${logo}<h1 class="company-name">${e(issuer.name)}</h1><div class="meta">${e(issuer.details)}</div></div>
    <div class="badge"><span class="doc-type">Statement</span><div class="doc-meta">
      <div>Period: <strong>${e(periodText)}</strong></div>
      <div>Date: <strong>${e(formatDate(period.to))}</strong></div>
      ${dueLine ? `<div>Balance: <strong>${e(dueLine)}</strong></div>` : ""}
    </div></div>
  </header>
  <section class="parties">
    <div><div class="label">Statement for</div>${customerBlock(customer)}</div>
    <div></div>
  </section>
  ${sections}
  <div class="footer-grid">
    <div><div class="notes">Please use the invoice number as your payment reference.</div></div>
    <div>${banks ? `<div class="label">Payment details</div>${banks}` : ""}</div>
  </div>
  ${legal ? `<p class="legal">${e(legal)}</p>` : ""}
</div></article></body></html>`;
}

module.exports = { renderStatementHtml };
