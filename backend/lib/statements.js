// Customer statements: opening balance, invoices and payments in a period with
// a running balance per currency, closing balance, and ageing as at the end
// date using only payments made up to that date. Draft/void invoices and void
// payments are excluded.
const { roundMoney, addTo } = require("./money");
const { agingBucket, AGING_BUCKETS } = require("./status");
const { listInvoices } = require("./invoices");
const { listPayments } = require("./payments");
const { getCustomer } = require("./customers");
const { toIsoDate, todayIso } = require("./dates");
const { httpError } = require("./errors");

const PAYMENT_METHOD_LABELS = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  card: "Card",
  paypal: "PayPal",
  wise: "Wise",
  paystack: "Paystack",
  other: "Payment",
};

const blankAging = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));

/**
 * Pure statement calculation (exported for tests).
 * invoices: stored invoices for one customer; payments: payments for those invoices.
 */
function computeStatement({ invoices, payments, from = "", to }) {
  const end = toIsoDate(to) || todayIso();
  const start = toIsoDate(from) || "";
  if (start && start > end) throw httpError(400, "The start date is after the end date");

  const issued = (invoices || [])
    .filter((i) => !i.draft && !i.voided)
    .map((i) => ({ ...i, issueIso: toIsoDate(i.issueDate), dueIso: toIsoDate(i.dueDate), currency: i.currency || "ZAR", total: roundMoney(i.total) }))
    .filter((i) => i.issueIso && i.issueIso <= end);
  const invById = Object.fromEntries(issued.map((i) => [i.id, i]));
  const pays = (payments || [])
    .filter((p) => !p.voided && invById[p.invoiceId])
    .map((p) => ({ ...p, paidIso: toIsoDate(p.paidAt), amount: roundMoney(p.amount), currency: invById[p.invoiceId].currency }))
    .filter((p) => p.paidIso && p.paidIso <= end);

  const ledger = {};
  const section = (c) =>
    (ledger[c] = ledger[c] || { currency: c, opening: 0, invoiced: 0, paid: 0, closing: 0, entries: [] });

  for (const inv of issued) {
    const s = section(inv.currency);
    if (start && inv.issueIso < start) s.opening = roundMoney(s.opening + inv.total);
    else
      s.entries.push({
        date: inv.issueIso,
        type: "invoice",
        invoiceId: inv.id,
        reference: inv.invoiceNumber || "",
        description: `Invoice ${inv.invoiceNumber || ""}`.trim(),
        dueDate: inv.dueIso,
        debit: inv.total,
        credit: 0,
      });
  }
  for (const p of pays) {
    const s = section(p.currency);
    const inv = invById[p.invoiceId];
    if (start && p.paidIso < start) s.opening = roundMoney(s.opening - p.amount);
    else
      s.entries.push({
        date: p.paidIso,
        type: "payment",
        invoiceId: inv.id,
        paymentId: p.id,
        reference: p.reference || "",
        description: `${PAYMENT_METHOD_LABELS[p.method] || "Payment"} - ${inv.invoiceNumber || "invoice"}`,
        dueDate: "",
        debit: 0,
        credit: p.amount,
      });
  }

  for (const s of Object.values(ledger)) {
    // Date order; on the same day invoices come before payments.
    s.entries.sort((a, b) => a.date.localeCompare(b.date) || (a.type === b.type ? 0 : a.type === "invoice" ? -1 : 1) || a.reference.localeCompare(b.reference));
    let bal = s.opening;
    for (const e of s.entries) {
      bal = roundMoney(bal + e.debit - e.credit);
      e.balance = bal;
      s.invoiced = roundMoney(s.invoiced + e.debit);
      s.paid = roundMoney(s.paid + e.credit);
    }
    s.closing = bal;
  }

  // Ageing as at the end date, per invoice, using payments up to that date.
  const paidByInvoice = {};
  for (const p of pays) paidByInvoice[p.invoiceId] = roundMoney((paidByInvoice[p.invoiceId] || 0) + p.amount);
  const asAt = new Date(`${end}T12:00:00Z`);
  const aging = {};
  const totals = {};
  const running = {};
  const open = issued
    .map((inv) => ({ inv, outstanding: roundMoney(inv.total - (paidByInvoice[inv.id] || 0)) }))
    .filter((x) => x.outstanding > 0)
    .sort((a, b) => a.inv.issueIso.localeCompare(b.inv.issueIso));
  const lines = open.map(({ inv, outstanding }) => {
    const c = inv.currency;
    const bucket = agingBucket(inv.dueIso, asAt);
    aging[c] = aging[c] || blankAging();
    aging[c][bucket] = roundMoney(aging[c][bucket] + outstanding);
    addTo(totals, c, outstanding);
    running[c] = roundMoney((running[c] || 0) + outstanding);
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      issueDate: inv.issueIso,
      dueDate: inv.dueIso,
      currency: c,
      total: inv.total,
      paidAmount: paidByInvoice[inv.id] || 0,
      outstanding,
      agingBucket: bucket,
      balance: running[c],
    };
  });
  for (const c of Object.keys(ledger)) aging[c] = aging[c] || blankAging();

  const currencies = Object.keys(ledger).sort();
  return {
    period: { from: start, to: end },
    currencies,
    ledger,
    // Open invoices as at the end date (kept for older callers).
    lines,
    aging,
    totals,
    totalOutstanding: Object.keys(totals).length === 1 ? Object.values(totals)[0] : 0,
  };
}

/**
 * Statement for one customer. `to` defaults to today (`asOf` is accepted as
 * an alias for older callers); no `from` means from the first invoice.
 */
async function buildStatement(companyId, customerId, { from, to, asOf } = {}) {
  const customer = await getCustomer(companyId, customerId);
  if (!customer) throw httpError(404, "Customer not found");
  const invoices = await listInvoices(companyId, { customerId });
  const ids = new Set(invoices.map((i) => i.id));
  const payments = (await listPayments(companyId)).filter((p) => ids.has(p.invoiceId));
  const out = computeStatement({ invoices, payments, from, to: to || asOf });
  return { generatedAt: new Date().toISOString(), customer, ...out };
}

module.exports = { buildStatement, computeStatement };
