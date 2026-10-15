const { roundMoney } = require("./money");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatZar(amount) {
  return `R ${roundMoney(amount).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function renderStatementHtml(statement, { companyName = "" } = {}) {
  const { customer, lines, aging, totalOutstanding, generatedAt } = statement;
  const rows = lines
    .map(
      (line) => `
    <tr>
      <td>${escapeHtml(line.issueDate)}</td>
      <td>${escapeHtml(line.invoiceNumber)}</td>
      <td>${escapeHtml(line.dueDate)}</td>
      <td class="num">${formatZar(line.outstanding)}</td>
      <td>${escapeHtml(line.agingBucket)}</td>
      <td class="num">${formatZar(line.balance)}</td>
    </tr>`
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
      <tr>
        <th>Issue date</th>
        <th>Invoice</th>
        <th>Due</th>
        <th class="num">Outstanding</th>
        <th>Aging</th>
        <th class="num">Balance</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="6" class="muted">No open invoices.</td></tr>'}
    </tbody>
  </table>
  <div class="summary">
    <div class="box">
      <h2>Aging (ZAR)</h2>
      <p>Current: ${formatZar(aging.current)}</p>
      <p>30 days: ${formatZar(aging["30"])}</p>
      <p>60 days: ${formatZar(aging["60"])}</p>
      <p>90+ days: ${formatZar(aging["90+"])}</p>
    </div>
    <div class="box">
      <h2>Total outstanding</h2>
      <p style="font-size: 22px; font-weight: 700;">${formatZar(totalOutstanding)}</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { renderStatementHtml };
