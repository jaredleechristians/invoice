const { roundMoney } = require("./money");
const { agingBucket } = require("./status");
const { listInvoices } = require("./invoices");
const { getCustomer } = require("./customers");

async function buildStatement(companyId, customerId, { asOf } = {}) {
  const customer = await getCustomer(companyId, customerId);
  if (!customer) {
    const err = new Error("Customer not found");
    err.status = 404;
    throw err;
  }
  const now = asOf ? new Date(asOf) : new Date();
  const invoices = await listInvoices(companyId, { customerId, limit: 500 });
  const open = invoices.filter((inv) => inv.outstanding > 0 && !inv.draft);

  const aging = { current: 0, "30": 0, "60": 0, "90+": 0 };
  let running = 0;
  const lines = open
    .sort((a, b) => String(a.issueDate).localeCompare(String(b.issueDate)))
    .map((inv) => {
      const bucket = agingBucket(inv.dueDate, now);
      const amount = roundMoney(inv.outstanding);
      aging[bucket] = roundMoney(aging[bucket] + amount);
      running = roundMoney(running + amount);
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        total: inv.total,
        paidAmount: inv.paidAmount,
        outstanding: amount,
        status: inv.status,
        agingBucket: bucket,
        balance: running,
      };
    });

  return {
    generatedAt: now.toISOString(),
    customer,
    lines,
    aging,
    totalOutstanding: running,
  };
}

module.exports = { buildStatement };
