const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

setupFake();
const companies = require("../lib/companies");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");

const OWNER = ["u1", "u1@example.com", "owner"];
const MEMBER = ["u2", "u2@example.com", "member"];
let co;
let inv;

test.before(async () => {
  co = (await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Co" })).id;
  inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Client",
    currency: "USD",
    dueDate: "2099-01-01",
    items: [
      { description: "Sprint 1", qty: 1, unitPrice: 2000 },
      { description: "Sprint 2", qty: 1, unitPrice: 1000.5 },
    ],
  });
});

test("partial payments accumulate and update status", async () => {
  assert.equal(inv.total, 3000.5);
  const p1 = await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: 1000, paidAt: "2026-11-02", method: "wise", reference: "W-1" });
  assert.equal(p1.payment.currency, "USD", "payment takes the invoice currency");
  assert.equal(p1.payment.method, "wise");
  assert.equal(p1.payment.reference, "W-1");
  assert.equal(p1.invoice.paidAmount, 1000);
  assert.equal(p1.invoice.outstanding, 2000.5);
  assert.equal(p1.invoice.status, "partially_paid");
  const p2 = await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: "2,000.50", paidAt: "2026-11-05" });
  assert.equal(p2.invoice.paidAmount, 3000.5);
  assert.equal(p2.invoice.status, "paid");
  assert.equal(p2.invoice.outstanding, 0);
});

test("overpayment and non-positive amounts are rejected", async () => {
  await assert.rejects(() => payments.recordPayment(co, ...OWNER, { invoiceId: inv.id, amount: 0.01 }), /exceeds/);
  await assert.rejects(() => payments.recordPayment(co, ...OWNER, { invoiceId: inv.id, amount: -5 }), /positive/);
});

test("voiding a payment restores the balance; delete is admin only", async () => {
  const list = await payments.listPayments(co, { invoiceId: inv.id });
  assert.equal(list.length, 2);
  const first = list.find((p) => p.amount === 1000);
  const voided = await payments.voidPayment(co, ...MEMBER, first.id, { reason: "bounced" });
  assert.equal(voided.invoice.paidAmount, 2000.5);
  assert.equal(voided.invoice.status, "partially_paid");
  await assert.rejects(() => payments.voidPayment(co, ...OWNER, first.id), /already void/);

  const second = list.find((p) => p.amount === 2000.5);
  await assert.rejects(() => payments.deletePayment(co, ...MEMBER, second.id), /Forbidden/);
  const del = await payments.deletePayment(co, ...OWNER, second.id);
  assert.equal(del.invoice.paidAmount, 0);
  assert.equal(del.invoice.status, "unpaid");
  assert.equal((await payments.listPayments(co, { invoiceId: inv.id })).length, 1, "voided payment kept for audit");
});

test("sumPayments ignores voided payments and rounds to cents", () => {
  assert.equal(payments.sumPayments([{ amount: 10 }, { amount: 5.555 }, { amount: 100, voided: true }]), 15.56);
});

test("drafts cannot take payments; invoices with payments cannot be voided, deleted, re-currencied or shrunk", async () => {
  const draft = await invoices.createInvoice(co, ...OWNER, { draft: true, customerName: "C", items: [{ description: "x", qty: 1, unitPrice: 10 }] });
  await assert.rejects(() => payments.recordPayment(co, ...OWNER, { invoiceId: draft.id, amount: 5 }), /Finalize/);

  await payments.recordPayment(co, ...OWNER, { invoiceId: inv.id, amount: 50 });
  await assert.rejects(() => invoices.voidInvoice(co, ...OWNER, inv.id), /payments first/);
  await assert.rejects(() => invoices.deleteInvoice(co, ...OWNER, inv.id), /has payments/);
  await assert.rejects(() => invoices.updateInvoice(co, ...OWNER, inv.id, { currency: "ZAR" }), /currency/);
  await assert.rejects(
    () => invoices.updateInvoice(co, ...OWNER, inv.id, { items: [{ description: "tiny", qty: 1, unitPrice: 1 }] }),
    /less than the amount already paid/
  );
});

test("void invoices reject payments", async () => {
  const v = await invoices.createInvoice(co, ...OWNER, { finalize: true, customerName: "V", items: [{ description: "x", qty: 1, unitPrice: 10 }] });
  await invoices.voidInvoice(co, ...OWNER, v.id);
  await assert.rejects(() => payments.recordPayment(co, ...OWNER, { invoiceId: v.id, amount: 5 }), /void/);
});
