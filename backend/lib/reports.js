// Report calculations. All figures are split by currency; there is no FX conversion.
// Pure functions take plain arrays so they are easy to unit test.
const { roundMoney, addTo } = require("./money");
const { toIsoDate, todayIso, monthKey, inRange, startOfMonthIso, endOfMonthIso, daysBetween } = require("./dates");
const { agingBucket, AGING_BUCKETS } = require("./status");
const { getDb } = require("./firebase");
const { companyRef } = require("./refs");
const { fetchAll } = require("./db");
const { withComputed } = require("./invoices");

const activePayments = (payments) => (payments || []).filter((p) => !p.voided);
const issuedInvoices = (invoices) => (invoices || []).filter((i) => !i.draft && !i.voided);
const cur = (x) => x.currency || "ZAR";
const customerKey = (x) => x.customerId || x.customerName || "unknown";
const customerLabel = (x) => x.customerName || "Unknown customer";

function monthsBetween(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const end = to.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Cash received per month per currency (payment date basis). */
function incomeByMonth(payments, { from, to } = {}) {
  const out = {};
  for (const p of activePayments(payments)) {
    if (!inRange(p.paidAt, from, to)) continue;
    const c = cur(p);
    const month = monthKey(p.paidAt);
    out[c] = out[c] || {};
    out[c][month] = roundMoney((out[c][month] || 0) + roundMoney(p.amount));
  }
  const months = from && to ? monthsBetween(from, to) : null;
  const result = {};
  for (const [c, byMonth] of Object.entries(out)) {
    const keys = months || Object.keys(byMonth).sort();
    result[c] = keys.map((month) => ({ month, amount: byMonth[month] || 0 }));
  }
  return result;
}

/** Invoiced (accrual) amounts per month per currency, by issue date. */
function invoicedByMonth(invoices, { from, to } = {}) {
  const out = {};
  for (const inv of issuedInvoices(invoices)) {
    if (!inRange(inv.issueDate, from, to)) continue;
    const c = cur(inv);
    const month = monthKey(inv.issueDate);
    out[c] = out[c] || {};
    out[c][month] = roundMoney((out[c][month] || 0) + roundMoney(inv.total));
  }
  const months = from && to ? monthsBetween(from, to) : null;
  const result = {};
  for (const [c, byMonth] of Object.entries(out)) {
    const keys = months || Object.keys(byMonth).sort();
    result[c] = keys.map((month) => ({ month, amount: byMonth[month] || 0 }));
  }
  return result;
}

/** Cash received per customer per currency, plus invoiced in range. */
function incomeByCustomer(payments, invoices, { from, to } = {}) {
  const rows = new Map();
  const row = (c, key, name) => {
    const k = `${c}::${key}`;
    if (!rows.has(k)) rows.set(k, { currency: c, customerId: key === "unknown" ? "" : key, customerName: name, received: 0, invoiced: 0, invoiceCount: 0 });
    return rows.get(k);
  };
  for (const p of activePayments(payments)) {
    if (!inRange(p.paidAt, from, to)) continue;
    const r = row(cur(p), customerKey(p), customerLabel(p));
    r.received = roundMoney(r.received + roundMoney(p.amount));
  }
  for (const inv of issuedInvoices(invoices)) {
    if (!inRange(inv.issueDate, from, to)) continue;
    const r = row(cur(inv), customerKey(inv), customerLabel(inv));
    r.invoiced = roundMoney(r.invoiced + roundMoney(inv.total));
    r.invoiceCount += 1;
  }
  const grouped = {};
  for (const r of rows.values()) (grouped[r.currency] = grouped[r.currency] || []).push(r);
  for (const list of Object.values(grouped)) list.sort((a, b) => b.received - a.received || b.invoiced - a.invoiced);
  return grouped;
}

/** Outstanding on an invoice as at a date, using payments and credit notes up to that date. */
function outstandingAsOf(invoice, paymentsByInvoice, asOf, creditsByInvoice = new Map()) {
  const paid = (paymentsByInvoice.get(invoice.id) || [])
    .filter((p) => !p.voided && !p.deletedAt && (!asOf || toIsoDate(p.paidAt) <= asOf))
    .reduce((s, p) => s + roundMoney(p.amount), 0);
  const credited = (creditsByInvoice.get(invoice.id) || [])
    .filter((n) => !n.voided && !n.deletedAt && !n.draft && (!asOf || toIsoDate(n.issueDate) <= asOf))
    .reduce((s, n) => s + roundMoney(n.total), 0);
  return roundMoney(roundMoney(invoice.total) - paid - credited);
}

function groupByInvoice(rows, idField = "invoiceId") {
  const map = new Map();
  for (const p of rows || []) {
    const id = p[idField];
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(p);
  }
  return map;
}

function groupPayments(payments) {
  return groupByInvoice(payments);
}

/** Open invoices as at `asOf` (issued on/before asOf, balance > 0). */
function outstandingInvoices(invoices, payments, { asOf = todayIso(), creditNotes = [] } = {}) {
  const byInv = groupPayments(payments);
  const byCredit = groupByInvoice(creditNotes);
  const out = [];
  for (const inv of issuedInvoices(invoices)) {
    const issue = toIsoDate(inv.issueDate);
    if (issue && issue > asOf) continue;
    const outstanding = outstandingAsOf(inv, byInv, asOf, byCredit);
    if (outstanding <= 0) continue;
    const due = toIsoDate(inv.dueDate);
    const daysOverdue = due && due < asOf ? daysBetween(due, asOf) : 0;
    out.push({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customerId: inv.customerId || "",
      customerName: customerLabel(inv),
      currency: cur(inv),
      issueDate: issue,
      dueDate: due || inv.dueDate || "",
      total: roundMoney(inv.total),
      outstanding,
      daysOverdue,
      bucket: agingBucket(inv.dueDate, new Date(`${asOf}T12:00:00`)),
    });
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue || String(a.dueDate).localeCompare(String(b.dueDate)));
}

function emptyBuckets() {
  return Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
}

/** Aged receivables per currency: rows per customer + totals. */
function agedReceivables(invoices, payments, { asOf = todayIso(), creditNotes = [], customers = [] } = {}) {
  const open = outstandingInvoices(invoices, payments, { asOf, creditNotes });
  const customersById = new Map((customers || []).map((c) => [c.id, c]));
  const result = {};
  for (const inv of open) {
    const c = inv.currency;
    result[c] = result[c] || { rows: new Map(), totals: { ...emptyBuckets(), total: 0 } };
    const key = inv.customerId || inv.customerName;
    const rows = result[c].rows;
    if (!rows.has(key)) rows.set(key, { customerId: inv.customerId, customerName: inv.customerName, ...emptyBuckets(), total: 0, invoiceCount: 0 });
    const r = rows.get(key);
    r[inv.bucket] = roundMoney(r[inv.bucket] + inv.outstanding);
    r.total = roundMoney(r.total + inv.outstanding);
    r.invoiceCount += 1;
    result[c].totals[inv.bucket] = roundMoney(result[c].totals[inv.bucket] + inv.outstanding);
    result[c].totals.total = roundMoney(result[c].totals.total + inv.outstanding);
  }
  const out = {};
  for (const [c, v] of Object.entries(result)) {
    const rows = [...v.rows.values()].sort((a, b) => b.total - a.total).map((r) => {
      const cust = customersById.get(r.customerId);
      if (!cust || cust.creditLimit == null) return r;
      const limitCurrency = cust.currency || c;
      if (limitCurrency !== c) return { ...r, creditLimit: cust.creditLimit, creditLimitCurrency: limitCurrency };
      return {
        ...r,
        creditLimit: cust.creditLimit,
        creditLimitCurrency: c,
        available: roundMoney(cust.creditLimit - r.total),
        overLimit: r.total > cust.creditLimit + 0.001,
      };
    });
    out[c] = { rows, totals: v.totals };
  }
  return out;
}

/** Expenses per category per currency in range. */
function expensesByCategory(expenses, { from, to } = {}) {
  const out = {};
  for (const e of expenses || []) {
    if (!inRange(e.date, from, to)) continue;
    const c = cur(e);
    out[c] = out[c] || { rows: new Map(), total: 0 };
    const key = e.categoryId || e.categoryName || "uncategorised";
    if (!out[c].rows.has(key)) out[c].rows.set(key, { categoryId: e.categoryId || "", categoryName: e.categoryName || "Uncategorised", amount: 0, count: 0 });
    const r = out[c].rows.get(key);
    r.amount = roundMoney(r.amount + roundMoney(e.amount));
    r.count += 1;
    out[c].total = roundMoney(out[c].total + roundMoney(e.amount));
  }
  const result = {};
  for (const [c, v] of Object.entries(out)) result[c] = { rows: [...v.rows.values()].sort((a, b) => b.amount - a.amount), total: v.total };
  return result;
}

/** Cash-basis profit & loss per currency: payments received minus expenses. */
function profitAndLoss(payments, expenses, { from, to } = {}) {
  const income = {};
  const spend = {};
  for (const p of activePayments(payments)) if (inRange(p.paidAt, from, to)) addTo(income, cur(p), p.amount);
  for (const e of expenses || []) if (inRange(e.date, from, to)) addTo(spend, cur(e), e.amount);
  const byCat = expensesByCategory(expenses, { from, to });
  const currencies = [...new Set([...Object.keys(income), ...Object.keys(spend)])].sort();
  const out = {};
  for (const c of currencies) {
    const inc = income[c] || 0;
    const exp = spend[c] || 0;
    out[c] = { income: inc, expenses: exp, net: roundMoney(inc - exp), expenseLines: byCat[c]?.rows || [] };
  }
  return out;
}

/** Headline numbers for the dashboard home. */
function dashboardSummary(invoices, payments, expenses, now = new Date()) {
  const today = todayIso(now);
  const monthFrom = startOfMonthIso(now);
  const monthTo = endOfMonthIso(now);
  const outstanding = {};
  const overdue = {};
  let openCount = 0;
  let overdueCount = 0;
  let draftCount = 0;
  for (const raw of invoices || []) {
    const inv = withComputed(raw, now);
    if (inv.status === "draft") draftCount += 1;
    if (inv.outstanding > 0) {
      openCount += 1;
      addTo(outstanding, cur(inv), inv.outstanding);
      if (inv.overdue) {
        overdueCount += 1;
        addTo(overdue, cur(inv), inv.outstanding);
      }
    }
  }
  const incomeThisMonth = {};
  for (const p of activePayments(payments)) if (inRange(p.paidAt, monthFrom, monthTo)) addTo(incomeThisMonth, cur(p), p.amount);
  const expensesThisMonth = {};
  for (const e of expenses || []) if (inRange(e.date, monthFrom, monthTo)) addTo(expensesThisMonth, cur(e), e.amount);
  return {
    today,
    month: { from: monthFrom, to: monthTo },
    outstanding,
    overdue,
    openCount,
    overdueCount,
    draftCount,
    incomeThisMonth,
    expensesThisMonth,
  };
}

function defaultRange(now = new Date()) {
  const today = todayIso(now);
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

function buildReports({ invoices, payments, expenses, creditNotes = [], customers = [] }, { from, to, asOf } = {}) {
  const range = { from, to };
  const asOfDate = asOf || to || todayIso();
  return {
    range: { from, to, asOf: asOfDate },
    incomeByMonth: incomeByMonth(payments, range),
    invoicedByMonth: invoicedByMonth(invoices, range),
    incomeByCustomer: incomeByCustomer(payments, invoices, range),
    agedReceivables: agedReceivables(invoices, payments, { asOf: asOfDate, creditNotes, customers }),
    outstandingInvoices: outstandingInvoices(invoices, payments, { asOf: asOfDate, creditNotes }),
    expensesByCategory: expensesByCategory(expenses, range),
    profitAndLoss: profitAndLoss(payments, expenses, range),
  };
}

/** Load all company money records in pages (no hard row cap). */
async function loadLedger(companyId) {
  const cref = companyRef(getDb(), companyId);
  const [invoices, payments, expenses, creditNotes, customers] = await Promise.all([
    fetchAll(cref.collection("invoices")),
    fetchAll(cref.collection("payments")),
    fetchAll(cref.collection("expenses")),
    fetchAll(cref.collection("creditNotes")),
    fetchAll(cref.collection("customers")),
  ]);
  return { invoices, payments, expenses, creditNotes, customers };
}

async function companyReports(companyId, { from, to, asOf } = {}) {
  const range = defaultRange();
  const f = toIsoDate(from) || range.from;
  const t = toIsoDate(to) || range.to;
  if (f > t) {
    const err = new Error("'from' must be on or before 'to'");
    err.status = 400;
    throw err;
  }
  return buildReports(await loadLedger(companyId), { from: f, to: t, asOf: toIsoDate(asOf) || t });
}

async function companySummary(companyId) {
  const ledger = await loadLedger(companyId);
  const summary = dashboardSummary(ledger.invoices, ledger.payments, ledger.expenses);
  const recentInvoices = ledger.invoices
    .map((i) => withComputed(i))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, 6)
    .map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, customerName: i.customerName, currency: i.currency, total: i.total, outstanding: i.outstanding, status: i.status, dueDate: i.dueDate }));
  const topOverdue = outstandingInvoices(ledger.invoices, ledger.payments, { creditNotes: ledger.creditNotes }).filter((i) => i.daysOverdue > 0).slice(0, 6);
  return { ...summary, recentInvoices, topOverdue };
}

module.exports = {
  monthsBetween,
  incomeByMonth,
  invoicedByMonth,
  incomeByCustomer,
  outstandingInvoices,
  agedReceivables,
  expensesByCategory,
  profitAndLoss,
  dashboardSummary,
  buildReports,
  loadLedger,
  companyReports,
  companySummary,
};
