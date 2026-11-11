const { escapeHtml, formatDate } = require("./html");
const { formatMoney } = require("./money");
const { AGING_BUCKETS } = require("./status");

const BUCKET_LABELS = { current: "Current", "1-30": "1–30 days", "31-60": "31–60 days", "61-90": "61–90 days", "90+": "90+ days" };

function renderStatementHtml(statement, { companyName = "" } = {}) {
  const { customer, lines, aging = {}, totals = {}, generatedAt } = statement;
  const rows = lines
    .map(
      (line) => `
    <tr>
      <td>${escapeHtml(formatDate(line.issueDate))}</td>
      <td>${escapeHtml(line.invoiceNumber)}</td>
      <td>${escapeHtml(formatDate(line.dueDate))}</td>
      <td>${escapeHtml(line.currency)}</td>
      <td class="num">${formatMoney(line.outstanding, line.currency)}</td>
      <td>${escapeHtml(BUCKET_LABELS[line.agingBucket] || line.agingBucket)}</td>
      <td class="num">${formatMoney(line.balance, line.currency)}</td>
    </tr>`
    )
    .join("");

  const summaries = Object.keys(totals)
    .sort()
    .map(
      (c) => `<div class="box">
      <h2>Aging (${escapeHtml(c)})</h2>
      ${AGING_BUCKETS.map((b) => `<p>${BUCKET_LABELS[b]}: ${formatMoney(aging[c]?.[b] || 0, c)}</p>`).join("")}
      <p style="font-size: 18px; font-weight: 700; margin-top: 8px;">Total ${formatMoney(totals[c], c)}</p>
    </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en-ZA">
<head>
  <meta charset="utf-8" />
  <title>Statement — ${escapeHtml(customer.name)}</title>
  <style>
    body { font-family: system-ui, sans-serif; color: #1a1f2e; font-size: 13px; line-height: 1.45; margin: 0; padding: 16mm; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .muted { color: #5c6578; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border-bottom: 1px solid #e2e6ef; padding: 8px 6px; text-align: left; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #5c6578; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .summary { margin-top: 24px; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .box { border: 1px solid #e2e6ef; border-radius: 8px; padding: 12px; }
    .box h2 { font-size: 12px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.06em; color: #5c6578; }
  </style>
</head>
<body>
  <p class="muted">${escapeHtml(companyName)}</p>
  <h1>Account statement</h1>
  <p class="muted">Generated ${escapeHtml(new Date(generatedAt).toLocaleString("en-ZA"))}</p>
  <p><strong>${escapeHtml(customer.name)}</strong><br/>
  ${escapeHtml(customer.email || "")}<br/>
  ${escapeHtml(customer.address || "").replace(/\n/g, "<br/>")}</p>
  <table>
    <thead>
      <tr><th>Issue date</th><th>Invoice</th><th>Due</th><th>Cur.</th><th class="num">Outstanding</th><th>Aging</th><th class="num">Balance</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" class="muted">No open invoices.</td></tr>'}
    </tbody>
  </table>
  <div class="summary">${summaries}</div>
</body>
</html>`;
}

module.exports = { renderStatementHtml };
