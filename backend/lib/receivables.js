const { roundMoney } = require("./money");
const { listInvoices } = require("./invoices");

async function listReceivables(companyId) {
  const invoices = await listInvoices(companyId, { limit: 500 });
  const byKey = new Map();

  for (const inv of invoices) {
    if (inv.draft || inv.outstanding <= 0) continue;
    const key = inv.customerId || inv.customerName || "unknown";
    const label = inv.customerName || inv.billTo || "Unknown customer";
    const row = byKey.get(key) || {
      customerId: inv.customerId || "",
      customerName: label,
      invoiceCount: 0,
      outstanding: 0,
      oldestDueDate: inv.dueDate || "",
    };
    row.invoiceCount += 1;
    row.outstanding = roundMoney(row.outstanding + inv.outstanding);
    if (inv.dueDate && (!row.oldestDueDate || inv.dueDate < row.oldestDueDate)) {
      row.oldestDueDate = inv.dueDate;
    }
    byKey.set(key, row);
  }

  return [...byKey.values()].sort((a, b) => b.outstanding - a.outstanding);
}

module.exports = { listReceivables };
