const { roundMoney } = require("./money");
const { listInvoices } = require("./invoices");

/** Outstanding per customer, split by currency (never summed across currencies). */
async function listReceivables(companyId) {
  const invoices = await listInvoices(companyId);
  const byKey = new Map();

  for (const inv of invoices) {
    if (inv.draft || inv.voided || inv.outstanding <= 0) continue;
    const currency = inv.currency || "ZAR";
    const key = `${currency}::${inv.customerId || inv.customerName || "unknown"}`;
    const label = inv.customerName || inv.billTo || "Unknown customer";
    const row = byKey.get(key) || {
      customerId: inv.customerId || "",
      customerName: label,
      currency,
      invoiceCount: 0,
      outstanding: 0,
      oldestDueDate: inv.dueDateIso || "",
    };
    row.invoiceCount += 1;
    row.outstanding = roundMoney(row.outstanding + inv.outstanding);
    if (inv.dueDateIso && (!row.oldestDueDate || inv.dueDateIso < row.oldestDueDate)) {
      row.oldestDueDate = inv.dueDateIso;
    }
    byKey.set(key, row);
  }

  return [...byKey.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.outstanding - a.outstanding);
}

module.exports = { listReceivables };
