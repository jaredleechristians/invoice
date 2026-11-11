const test = require("node:test");
const assert = require("node:assert/strict");
const { invoiceTotal, roundMoney } = require("../lib/money");
const { invoiceStatus, agingBucket } = require("../lib/status");

test("invoiceTotal sums line items", () => {
  const total = invoiceTotal([
    { qty: 2, unitPrice: 100 },
    { qty: 1, unitPrice: 50.5 },
  ]);
  assert.equal(total, 250.5);
});

test("invoiceStatus marks overdue unpaid", () => {
  const past = new Date();
  past.setDate(past.getDate() - 10);
  const s = invoiceStatus(
    { total: 100, paidAmount: 0, dueDate: past.toISOString().slice(0, 10) },
    new Date()
  );
  assert.equal(s.status, "overdue");
  assert.equal(s.outstanding, 100);
});

test("agingBucket buckets by days past due", () => {
  const past = new Date();
  past.setDate(past.getDate() - 45);
  assert.equal(
    agingBucket(past.toISOString().slice(0, 10), new Date()),
    "31-60"
  );
});

test("roundMoney rounds to cents", () => {
  assert.equal(roundMoney(1.005), 1.01);
});

test("importLocal maps billTo and items", () => {
  const { mapLocalInvoiceToPayload } = require("../lib/importLocal");
  const { body, billToName } = mapLocalInvoiceToPayload({
    billTo: { name: "Acme", details: "Cape Town" },
    items: [{ description: "Work", qty: 1, unitPrice: 100 }],
    issueDate: "2026-01-01",
  });
  assert.equal(billToName, "Acme");
  assert.equal(body.items.length, 1);
  assert.equal(body.billTo, "Acme\nCape Town");
});

test("documentTotals applies VAT only when a rate is set", () => {
  const { documentTotals } = require("../lib/money");
  const items = [
    { qty: 1, unitPrice: 1000 },
    { qty: 2, unitPrice: 50, taxable: false },
  ];
  assert.deepEqual(documentTotals(items, { vatRate: 0 }), { subtotal: 1100, taxTotal: 0, total: 1100 });
  assert.deepEqual(documentTotals(items, { vatRate: 15 }), { subtotal: 1100, taxTotal: 150, total: 1250 });
});

test("toIsoDate normalises editor and ISO dates", () => {
  const { toIsoDate, addDaysIso } = require("../lib/dates");
  assert.equal(toIsoDate("2026-11-01T10:00:00.000Z"), "2026-11-01");
  assert.equal(toIsoDate("27 Jul 2026"), "2026-07-27");
  assert.equal(toIsoDate("On receipt"), "");
  assert.equal(addDaysIso("2026-01-31", 30), "2026-03-02");
});

test("invoiceStatus handles draft and void", () => {
  assert.equal(invoiceStatus({ total: 100, paidAmount: 0, draft: true }).status, "draft");
  const v = invoiceStatus({ total: 100, paidAmount: 0, voided: true });
  assert.equal(v.status, "void");
  assert.equal(v.outstanding, 0);
});
