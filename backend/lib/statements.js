const { roundMoney, addTo } = require("./money");
const { agingBucket, AGING_BUCKETS } = require("./status");
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
  const invoices = await listInvoices(companyId, { customerId });
  const open = invoices.filter((inv) => inv.outstanding > 0 && !inv.draft && !inv.voided);

  const aging = {};
  const totals = {};
  const running = {};
  const lines = open
    .sort((a, b) => String(a.issueDateIso).localeCompare(String(b.issueDateIso)))
    .map((inv) => {
      const currency = inv.currency || "ZAR";
      const bucket = agingBucket(inv.dueDate, now);
      const amount = roundMoney(inv.outstanding);
      aging[currency] = aging[currency] || Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
      aging[currency][bucket] = roundMoney(aging[currency][bucket] + amount);
      addTo(totals, currency, amount);
      running[currency] = roundMoney((running[currency] || 0) + amount);
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        issueDate: inv.issueDateIso || inv.issueDate,
        dueDate: inv.dueDateIso || inv.dueDate,
        currency,
        total: inv.total,
        paidAmount: inv.paidAmount,
        outstanding: amount,
        status: inv.status,
        agingBucket: bucket,
        balance: running[currency],
      };
    });

  return {
    generatedAt: now.toISOString(),
    customer,
    lines,
    aging,
    totals,
    // Back-compat: single-currency total when only one currency is open.
    totalOutstanding: Object.keys(totals).length === 1 ? Object.values(totals)[0] : 0,
  };
}

module.exports = { buildStatement };
