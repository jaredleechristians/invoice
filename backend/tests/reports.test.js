const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../lib/reports");

const invoices = [
  { id: "i1", invoiceNumber: "INV-1", customerId: "c1", customerName: "Acme", currency: "ZAR", issueDate: "2026-09-01", dueDate: "2026-09-30", total: 10000, paidAmount: 5000 },
  { id: "i2", invoiceNumber: "INV-2", customerId: "c2", customerName: "Jason", currency: "USD", issueDate: "2026-10-01", dueDate: "2026-10-15", total: 2000, paidAmount: 2000 },
  { id: "i3", invoiceNumber: "INV-3", customerId: "c1", customerName: "Acme", currency: "ZAR", issueDate: "2026-11-01", dueDate: "2026-12-01", total: 5000 },
  { id: "i4", invoiceNumber: "", draft: true, customerName: "Draft", currency: "ZAR", issueDate: "2026-11-02", total: 999 },
  { id: "i5", invoiceNumber: "INV-5", voided: true, customerName: "Void", currency: "ZAR", issueDate: "2026-11-02", total: 777 },
  // legacy imported invoice: human dates, no currency (defaults to ZAR)
  { id: "i6", invoiceNumber: "INV-6", customerName: "Legacy", issueDate: "27 Jul 2026", dueDate: "26 Aug 2026", total: 1500, paidAmount: 500 },
];

const payments = [
  { id: "p1", invoiceId: "i1", customerId: "c1", customerName: "Acme", currency: "ZAR", amount: 4000, paidAt: "2026-09-15" },
  { id: "p2", invoiceId: "i1", customerId: "c1", customerName: "Acme", currency: "ZAR", amount: 1000, paidAt: "2026-10-20" },
  { id: "p3", invoiceId: "i2", customerId: "c2", customerName: "Jason", currency: "USD", amount: 2000, paidAt: "2026-10-10" },
  { id: "p4", invoiceId: "i1", customerId: "c1", customerName: "Acme", currency: "ZAR", amount: 5000, paidAt: "2026-10-21", voided: true },
  { id: "p5", invoiceId: "i6", customerName: "Legacy", amount: 500, paidAt: "2026-08-01T09:00:00.000Z" },
];

const expenses = [
  { id: "e1", date: "2026-10-03", categoryId: "k1", categoryName: "Hosting", currency: "ZAR", amount: 300 },
  { id: "e2", date: "2026-10-09", categoryId: "k1", categoryName: "Hosting", currency: "ZAR", amount: 200 },
  { id: "e3", date: "2026-10-10", categoryId: "k2", categoryName: "Software", currency: "USD", amount: 20 },
  { id: "e4", date: "2026-12-01", categoryId: "k2", categoryName: "Software", currency: "ZAR", amount: 9999 },
];

const range = { from: "2026-09-01", to: "2026-11-30" };

test("income by month is cash basis, split by currency, ignores void payments, fills empty months", () => {
  const out = r.incomeByMonth(payments, range);
  assert.deepEqual(out.ZAR, [
    { month: "2026-09", amount: 4000 },
    { month: "2026-10", amount: 1000 },
    { month: "2026-11", amount: 0 },
  ]);
  assert.deepEqual(out.USD.map((m) => m.amount), [0, 2000, 0]);
});

test("income by customer reports received and invoiced per currency", () => {
  const out = r.incomeByCustomer(payments, invoices, range);
  const acme = out.ZAR.find((x) => x.customerId === "c1");
  assert.equal(acme.received, 5000);
  assert.equal(acme.invoiced, 15000);
  assert.equal(acme.invoiceCount, 2);
  assert.equal(out.USD[0].received, 2000);
  assert.ok(!out.ZAR.some((x) => x.customerName === "Void" || x.customerName === "Draft"));
});

test("aged receivables as of a date use payments up to that date", () => {
  const aged = r.agedReceivables(invoices, payments, { asOf: "2026-11-11" });
  // i1: 10000-5000=5000, due 30 Sep → 42 days → 31-60; i3 5000 current; i6 1000 due 26 Aug → 77 days → 61-90
  assert.equal(aged.ZAR.totals.total, 11000);
  assert.equal(aged.ZAR.totals["31-60"], 5000);
  assert.equal(aged.ZAR.totals.current, 5000);
  assert.equal(aged.ZAR.totals["61-90"], 1000);
  assert.equal(aged.USD, undefined, "fully paid USD invoice is not outstanding");

  const earlier = r.agedReceivables(invoices, payments, { asOf: "2026-10-01" });
  assert.equal(earlier.ZAR.rows.find((x) => x.customerId === "c1").total, 6000);
  assert.equal(earlier.USD.totals.total, 2000);
});

test("outstanding invoices list excludes drafts, voids and future-dated invoices", () => {
  const list = r.outstandingInvoices(invoices, payments, { asOf: "2026-10-31" });
  assert.deepEqual(list.map((i) => i.id).sort(), ["i1", "i6"]);
  assert.equal(list[0].id, "i6", "most overdue first");
});

test("expenses by category and cash P&L stay per currency", () => {
  const cat = r.expensesByCategory(expenses, range);
  assert.equal(cat.ZAR.total, 500);
  assert.equal(cat.ZAR.rows[0].categoryName, "Hosting");
  assert.equal(cat.USD.total, 20);
  const pl = r.profitAndLoss(payments, expenses, range);
  assert.deepEqual({ income: pl.ZAR.income, expenses: pl.ZAR.expenses, net: pl.ZAR.net }, { income: 5000, expenses: 500, net: 4500 });
  assert.deepEqual({ income: pl.USD.income, expenses: pl.USD.expenses, net: pl.USD.net }, { income: 2000, expenses: 20, net: 1980 });
});

test("dashboard summary: outstanding, overdue and this month per currency", () => {
  const s = r.dashboardSummary(invoices, payments, expenses, new Date("2026-10-15T12:00:00"));
  // uses stored paidAmount (kept in sync by payments.js): i1 5000 (overdue), i3 5000 (not yet due), i6 1000 (overdue)
  assert.equal(s.outstanding.ZAR, 11000);
  assert.equal(s.overdue.ZAR, 6000);
  assert.equal(s.incomeThisMonth.ZAR, 1000);
  assert.equal(s.incomeThisMonth.USD, 2000);
  assert.equal(s.expensesThisMonth.ZAR, 500);
  assert.equal(s.expensesThisMonth.USD, 20);
  assert.equal(s.draftCount, 1);
});

test("monthsBetween spans year boundaries", () => {
  assert.deepEqual(r.monthsBetween("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});

test("fetchAll pages through more than one page (no hard cap)", async () => {
  const { FakeFirestore } = require("./helpers/fakeFirestore");
  const { fetchAll } = require("../lib/db");
  const db = new FakeFirestore();
  for (let i = 0; i < 1234; i++) await db.collection("x").doc(`d${String(i).padStart(5, "0")}`).set({ n: i });
  const rows = await fetchAll(db.collection("x"), { pageSize: 500 });
  assert.equal(rows.length, 1234);
  assert.equal(new Set(rows.map((x) => x.id)).size, 1234);
});
