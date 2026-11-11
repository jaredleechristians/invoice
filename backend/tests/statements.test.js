const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

setupFake();
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");
const { buildStatement, computeStatement } = require("../lib/statements");
const { renderStatementHtml } = require("../lib/statementHtml");

const OWNER = ["s1", "s1@example.com", "owner"];

const inv = (id, issueDate, total, extra = {}) => ({ id, invoiceNumber: `INV-${id}`, issueDate, dueDate: extra.dueDate || issueDate, total, currency: "ZAR", draft: false, voided: false, ...extra });
const pay = (id, invoiceId, paidAt, amount, extra = {}) => ({ id, invoiceId, paidAt, amount, method: "bank_transfer", reference: "", voided: false, ...extra });

test("opening balance, period lines in date order, running and closing balance", () => {
  const st = computeStatement({
    invoices: [inv("1", "2026-01-10", 1000), inv("2", "2026-02-05", 500), inv("3", "2026-03-15", 300), inv("D", "2026-02-01", 999, { draft: true }), inv("V", "2026-02-01", 999, { voided: true })],
    payments: [pay("a", "1", "2026-01-20", 400), pay("b", "1", "2026-02-10", 600), pay("c", "2", "2026-02-05", 200), pay("x", "2", "2026-02-20", 300, { voided: true }), pay("d", "3", "2026-04-01", 300)],
    from: "2026-02-01",
    to: "2026-03-31",
  });
  const s = st.ledger.ZAR;
  assert.equal(s.opening, 600, "1000 invoiced - 400 paid before Feb");
  assert.deepEqual(s.entries.map((e) => [e.date, e.type, e.debit || -e.credit, e.balance]), [
    ["2026-02-05", "invoice", 500, 1100],
    ["2026-02-05", "payment", -200, 900],
    ["2026-02-10", "payment", -600, 300],
    ["2026-03-15", "invoice", 300, 600],
  ]);
  assert.equal(s.invoiced, 800);
  assert.equal(s.paid, 800);
  assert.equal(s.closing, 600);
  assert.equal(st.period.from, "2026-02-01");
  assert.ok(!s.entries.some((e) => e.paymentId === "d"), "payments after the end date are left out");
});

test("ageing is as at the end date using payments up to then", () => {
  const data = {
    invoices: [inv("1", "2026-01-01", 1000, { dueDate: "2026-01-31" }), inv("2", "2026-03-01", 200, { dueDate: "2026-03-31" })],
    payments: [pay("a", "1", "2026-04-15", 1000)],
  };
  const atMarch = computeStatement({ ...data, to: "2026-03-31" });
  assert.deepEqual(atMarch.aging.ZAR, { current: 200, "1-30": 0, "31-60": 1000, "61-90": 0, "90+": 0 });
  assert.equal(atMarch.totals.ZAR, 1200);
  assert.equal(atMarch.ledger.ZAR.closing, 1200);
  assert.deepEqual(atMarch.lines.map((l) => [l.invoiceNumber, l.outstanding]), [["INV-1", 1000], ["INV-2", 200]]);
  const atMay = computeStatement({ ...data, to: "2026-05-31" });
  assert.deepEqual(atMay.aging.ZAR, { current: 0, "1-30": 0, "31-60": 0, "61-90": 200, "90+": 0 });
  assert.equal(atMay.ledger.ZAR.closing, 200);
});

test("currencies are kept apart; no from date means from the start; bad range rejected", () => {
  const st = computeStatement({
    invoices: [inv("1", "2026-01-01", 100), inv("2", "2026-01-02", 50, { currency: "USD" })],
    payments: [pay("a", "2", "2026-01-03", 20)],
    to: "2026-12-31",
  });
  assert.deepEqual(st.currencies, ["USD", "ZAR"]);
  assert.equal(st.ledger.ZAR.opening, 0);
  assert.equal(st.ledger.ZAR.closing, 100);
  assert.equal(st.ledger.USD.closing, 30);
  assert.equal(st.totalOutstanding, 0, "multi-currency has no single total");
  assert.throws(() => computeStatement({ invoices: [], payments: [], from: "2026-02-01", to: "2026-01-01" }), /start date/);
});

test("buildStatement end to end, JSON stays compatible, HTML matches the invoice design", async () => {
  const co = (await companies.createCompany({ uid: "s1", email: "s1@example.com", name: "Robot Web" })).id;
  await companies.updateCompanySettings(co, ...OWNER, { vatNumber: "4123456789", vatRegistered: false, bankAccounts: [{ label: "FNB", currency: "ZAR", details: "Acc 123" }] });
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Acme Pty Ltd", email: "ap@acme.test", address: "1 Long St\nCape Town" });
  const a = await invoices.createInvoice(co, ...OWNER, { finalize: true, customerId: cust.id, issueDate: "2026-10-01", dueDate: "2026-10-31", items: [{ description: "Dev", qty: 10, unitPrice: 100 }] });
  await invoices.createInvoice(co, ...OWNER, { finalize: true, customerId: cust.id, issueDate: "2026-11-01", dueDate: "2026-11-30", items: [{ description: "Dev", qty: 5, unitPrice: 100 }] });
  await payments.recordPayment(co, ...OWNER, { invoiceId: a.id, amount: 600, paidAt: "2026-10-20", reference: "ACME-EFT" });

  const st = await buildStatement(co, cust.id, { from: "2026-10-15", to: "2026-11-30" });
  assert.equal(st.ledger.ZAR.opening, 1000);
  assert.equal(st.ledger.ZAR.paid, 600);
  assert.equal(st.ledger.ZAR.closing, 900);
  assert.equal(st.customer.name, "Acme Pty Ltd");
  assert.ok(Array.isArray(st.lines) && st.aging.ZAR && st.totals.ZAR === 900 && st.totalOutstanding === 900, "older fields still there");
  const legacy = await buildStatement(co, cust.id, { asOf: "2026-10-25" });
  assert.equal(legacy.period.to, "2026-10-25");
  assert.equal(legacy.ledger.ZAR.closing, 400);

  const company = await invoices.loadCompany(co);
  let html = renderStatementHtml(st, { company });
  assert.match(html, /Statement/);
  assert.match(html, /Acme Pty Ltd/);
  assert.match(html, /ACME-EFT/);
  assert.match(html, /Acc 123/);
  assert.match(html, /15 Oct 2026 to 30 Nov 2026/);
  assert.doesNotMatch(html, /VAT No\./, "no VAT number when not VAT registered");
  assert.doesNotMatch(html, /tax invoice/i);
  await companies.updateCompanySettings(co, ...OWNER, { vatRegistered: true });
  html = renderStatementHtml(st, { company: await invoices.loadCompany(co) });
  assert.match(html, /VAT No\. 4123456789/);
  assert.doesNotMatch(html, /tax invoice/i);
  await assert.rejects(() => buildStatement(co, "nope", {}), /Customer not found/);
});
