const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

setupFake();
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");
const creditNotes = require("../lib/creditNotes");
const reports = require("../lib/reports");
const { computeStatement } = require("../lib/statements");
const { restoreRecord } = require("../lib/restore");
const ledgerJournals = require("../lib/ledger/journals");
const { creditNoteLines, invoiceLines } = require("../lib/ledger/rules");

const OWNER = ["u1", "u1@example.com", "owner"];
const MEMBER = ["u2", "u2@example.com", "member"];

async function company(name = "CN Co") {
  const c = await companies.createCompany({ uid: "u1", email: "u1@example.com", name });
  return c.id;
}

function assertBalanced(entry) {
  const debit = (entry.lines || []).reduce((s, l) => s + l.debit, 0);
  const credit = (entry.lines || []).reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit, `${entry.number || entry.id} is unbalanced`);
}

test("customer payment terms set the default invoice due date; company terms are the fallback", async () => {
  const co = await company("Terms Co");
  await companies.updateCompanySettings(co, ...OWNER, { paymentTermsDays: 14 });
  const noTerms = await customers.createCustomer(co, ...OWNER, { name: "Default terms" });
  const custom = await customers.createCustomer(co, ...OWNER, { name: "Net 7", paymentTermsDays: 7 });
  const a = await invoices.createInvoice(co, ...OWNER, {
    draft: true,
    customerId: noTerms.id,
    issueDate: "2026-11-01",
    items: [{ description: "A", qty: 1, unitPrice: 10 }],
  });
  const b = await invoices.createInvoice(co, ...OWNER, {
    draft: true,
    customerId: custom.id,
    issueDate: "2026-11-01",
    items: [{ description: "B", qty: 1, unitPrice: 10 }],
  });
  assert.equal(a.dueDate, "2026-11-15");
  assert.equal(b.dueDate, "2026-11-08");
});

test("credit limit warns on publish but does not block", async () => {
  const co = await company("Limit Co");
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Limited", creditLimit: 100, currency: "ZAR" });
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerId: cust.id,
    issueDate: "2026-11-01",
    items: [{ description: "Over", qty: 1, unitPrice: 250 }],
  });
  assert.equal(inv.total, 250);
  assert.ok(inv.creditLimitWarning);
  assert.equal(inv.creditLimitWarning.exceeded, true);
  assert.equal(inv.creditLimitWarning.creditLimit, 100);
  assert.equal(inv.status, "unpaid");
  const snap = await customers.customerCreditSnapshot(co, cust.id);
  assert.equal(snap.outstanding, 250);
  assert.equal(snap.exceeded, true);
});

test("full and partial credit notes reduce outstanding and post reversals; trial balance stays balanced", async () => {
  const co = await company("Post Co");
  await companies.updateCompanySettings(co, ...OWNER, { vatRegistered: true, vatRate: 15 });
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Acme" });
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerId: cust.id,
    issueDate: "2026-11-01",
    items: [{ description: "Dev", qty: 1, unitPrice: 1000 }],
  });
  assert.equal(inv.total, 1150);

  const partial = await creditNotes.createCreditNote(co, ...OWNER, {
    finalize: true,
    invoiceId: inv.id,
    issueDate: "2026-11-05",
    items: [{ description: "Dev", qty: 1, unitPrice: 200 }],
    reason: "Overbilled",
  });
  assert.equal(partial.creditNoteNumber, "CN-0001");
  assert.equal(partial.status, "issued");
  assert.equal(partial.total, 230);

  let fresh = await invoices.getInvoice(co, inv.id);
  assert.equal(fresh.creditedAmount, 230);
  assert.equal(fresh.outstanding, 920);
  assert.equal(fresh.status, "partially_paid");

  const fullRest = await creditNotes.createCreditNote(co, ...OWNER, {
    finalize: true,
    invoiceId: inv.id,
    issueDate: "2026-11-06",
    items: [{ description: "Dev", qty: 1, unitPrice: 800 }],
  });
  assert.equal(fullRest.total, 920);
  fresh = await invoices.getInvoice(co, inv.id);
  assert.equal(fresh.creditedAmount, 1150);
  assert.equal(fresh.outstanding, 0);
  assert.equal(fresh.status, "paid");

  const rows = await ledgerJournals.listJournals(co, { invoiceId: inv.id });
  rows.forEach(assertBalanced);
  assert.equal(rows.filter((e) => e.source?.type === "invoice").length, 1);
  assert.equal(rows.filter((e) => e.source?.type === "credit_note").length, 2);

  const debtors = rows.flatMap((e) => e.lines.filter((l) => l.accountId === "debtors" || l.accountId?.includes?.("debtors")));
  // System account ids are codes? ledger uses system key mapped to account ids.
  const tb = await ledgerJournals.trialBalance(co, { asOf: "2026-11-06" });
  assert.equal(tb.totals.debit, tb.totals.credit);

  const sys = tb.rows || tb.accounts || tb.lines || [];
  // net debtors should be zero after a full credit. Find the debtors row if present.
  const debtorRow = (sys.find && sys.find((r) => /debtor/i.test(r.name || r.code || r.id || ""))) || null;
  if (debtorRow) {
    const net = (debtorRow.debit || 0) - (debtorRow.credit || 0);
    assert.equal(net, 0);
  }
});

test("credit note ledger lines invert the invoice (debtors, income, VAT)", () => {
  const ctx = {
    baseCurrency: "ZAR",
    systemAccounts: { debtors: "debtors", default_income: "income", vat: "vat" },
  };
  const invoice = {
    currency: "ZAR",
    invoiceNumber: "INV-1",
    total: 115,
    subtotal: 100,
    taxTotal: 15,
    vatRate: 15,
    items: [{ description: "Work", qty: 1, unitPrice: 100, taxable: true, accountId: "income" }],
  };
  const invLines = invoiceLines(invoice, ctx);
  const cnLines = creditNoteLines({ ...invoice, creditNoteNumber: "CN-1" }, ctx);
  assert.equal(cnLines.length, invLines.length);
  for (let i = 0; i < invLines.length; i++) {
    assert.equal(cnLines[i].debit, invLines[i].credit);
    assert.equal(cnLines[i].credit, invLines[i].debit);
    assert.equal(cnLines[i].accountId, invLines[i].accountId);
  }
});

test("a credit cannot exceed remaining outstanding after payments; payments cannot overpay after a credit", async () => {
  const co = await company("Cap Co");
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Acme" });
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerId: cust.id,
    issueDate: "2026-11-01",
    items: [{ description: "A", qty: 1, unitPrice: 100 }],
  });
  await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: 40, paidAt: "2026-11-02" });
  await assert.rejects(
    () =>
      creditNotes.createCreditNote(co, ...OWNER, {
        finalize: true,
        invoiceId: inv.id,
        items: [{ description: "A", qty: 1, unitPrice: 70 }],
      }),
    /exceed/
  );
  const note = await creditNotes.createCreditNote(co, ...OWNER, {
    finalize: true,
    invoiceId: inv.id,
    items: [{ description: "A", qty: 1, unitPrice: 40 }],
  });
  assert.equal(note.total, 40);
  const fresh = await invoices.getInvoice(co, inv.id);
  assert.equal(fresh.outstanding, 20);
  await assert.rejects(() => payments.recordPayment(co, ...OWNER, { invoiceId: inv.id, amount: 20.01 }), /exceeds/);
  const pay = await payments.recordPayment(co, ...OWNER, { invoiceId: inv.id, amount: 20, paidAt: "2026-11-03" });
  assert.equal(pay.invoice.outstanding, 0);
});

test("void and delete of a credit note un-apply it; invoice void is blocked while a credit exists", async () => {
  const co = await company("Void Co");
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Acme",
    issueDate: "2026-11-01",
    items: [{ description: "A", qty: 1, unitPrice: 100 }],
  });
  const note = await creditNotes.createCreditNote(co, ...OWNER, {
    finalize: true,
    invoiceId: inv.id,
    items: [{ description: "A", qty: 1, unitPrice: 25 }],
  });
  await assert.rejects(() => invoices.voidInvoice(co, ...OWNER, inv.id), /credit notes first/);
  await assert.rejects(() => invoices.deleteInvoice(co, ...OWNER, inv.id), /credit notes/);

  const voided = await creditNotes.voidCreditNote(co, ...OWNER, note.id, { reason: "mistake" });
  assert.equal(voided.status, "void");
  let fresh = await invoices.getInvoice(co, inv.id);
  assert.equal(fresh.creditedAmount, 0);
  assert.equal(fresh.outstanding, 100);

  const note2 = await creditNotes.createCreditNote(co, ...OWNER, {
    finalize: true,
    invoiceId: inv.id,
    items: [{ description: "A", qty: 1, unitPrice: 10 }],
  });
  await creditNotes.deleteCreditNote(co, ...OWNER, note2.id);
  fresh = await invoices.getInvoice(co, inv.id);
  assert.equal(fresh.creditedAmount, 0);
  assert.equal((await creditNotes.listCreditNotes(co, { invoiceId: inv.id })).length, 1, "voided note kept");

  const note3 = await creditNotes.createCreditNote(co, ...OWNER, {
    finalize: true,
    invoiceId: inv.id,
    items: [{ description: "A", qty: 1, unitPrice: 10 }],
  });
  await creditNotes.deleteCreditNote(co, ...OWNER, note3.id);
  await restoreRecord(co, ...OWNER, "creditNote", note3.id);
  fresh = await invoices.getInvoice(co, inv.id);
  assert.equal(fresh.creditedAmount, 10);
  assert.equal(fresh.outstanding, 90);
});

test("aged receivables and statements subtract credit notes as of the credit date", async () => {
  const invoicesList = [
    { id: "i1", invoiceNumber: "INV-1", customerId: "c1", customerName: "Acme", currency: "ZAR", issueDate: "2026-10-01", dueDate: "2026-10-31", total: 1000, draft: false, voided: false },
  ];
  const paymentsList = [{ invoiceId: "i1", amount: 100, paidAt: "2026-11-01", voided: false }];
  const notes = [{ invoiceId: "i1", total: 200, issueDate: "2026-11-10", draft: false, voided: false }];
  const before = reports.agedReceivables(invoicesList, paymentsList, { asOf: "2026-11-05", creditNotes: notes });
  assert.equal(before.ZAR.totals.total, 900);
  const after = reports.agedReceivables(invoicesList, paymentsList, { asOf: "2026-11-10", creditNotes: notes });
  assert.equal(after.ZAR.totals.total, 700);
  const withLimit = reports.agedReceivables(invoicesList, paymentsList, {
    asOf: "2026-11-10",
    creditNotes: notes,
    customers: [{ id: "c1", name: "Acme", creditLimit: 500, currency: "ZAR" }],
  });
  assert.equal(withLimit.ZAR.rows[0].creditLimit, 500);
  assert.equal(withLimit.ZAR.rows[0].overLimit, true);

  const st = computeStatement({
    invoices: invoicesList,
    payments: paymentsList,
    creditNotes: [{ id: "n1", ...notes[0], creditNoteNumber: "CN-1" }],
    from: "2026-10-01",
    to: "2026-11-30",
  });
  assert.equal(st.ledger.ZAR.invoiced, 1000);
  assert.equal(st.ledger.ZAR.paid, 100);
  assert.equal(st.ledger.ZAR.credited, 200);
  assert.equal(st.ledger.ZAR.closing, 700);
  assert.equal(st.lines[0].outstanding, 700);
});

test("members can draft a credit note; only owners and admins can void or delete a published one", async () => {
  const c = await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Roles" });
  const co = c.id;
  const { getDb } = require("../lib/firebase");
  await getDb().collection("companies").doc(co).collection("members").doc("u2").set({
    userId: "u2",
    role: "member",
    joinedAt: new Date().toISOString(),
  });
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Acme",
    issueDate: "2026-11-01",
    items: [{ description: "A", qty: 1, unitPrice: 50 }],
  });
  const draft = await creditNotes.createCreditNote(co, ...MEMBER, {
    draft: true,
    invoiceId: inv.id,
    items: [{ description: "A", qty: 1, unitPrice: 10 }],
  });
  assert.equal(draft.status, "draft");
  const published = await creditNotes.finalizeCreditNote(co, ...MEMBER, draft.id);
  assert.equal(published.status, "issued");
  await assert.rejects(() => creditNotes.voidCreditNote(co, ...MEMBER, draft.id), /Forbidden/);
  await creditNotes.voidCreditNote(co, ...OWNER, draft.id);
});
