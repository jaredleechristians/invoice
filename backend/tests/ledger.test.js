const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

const fakeDb = setupFake();
const companies = require("../lib/companies");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");
const expenses = require("../lib/expenses");
const customers = require("../lib/customers");
const { listReceivables } = require("../lib/receivables");
const { restoreRecord } = require("../lib/restore");
const ledgerAccounts = require("../lib/ledger/accounts");
const ledgerJournals = require("../lib/ledger/journals");
const { catchUpCompany } = require("../lib/ledger/catchup");
const { planPost, sourceKey } = require("../lib/ledger/post");
const { getDb } = require("../lib/firebase");
const { companyRef } = require("../lib/refs");

const OWNER = ["u1", "u1@example.com", "owner"];
const MEMBER = ["u2", "u2@example.com", "member"];

async function company(name = "Ledger Live") {
  const c = await companies.createCompany({ uid: "u1", email: "u1@example.com", name });
  await fakeDb.collection("companies").doc(c.id).collection("members").doc("u2").set({
    userId: "u2",
    role: "member",
    joinedAt: new Date().toISOString(),
  });
  return c.id;
}

async function enableVat(companyId) {
  await companies.updateCompanySettings(companyId, ...OWNER, { vatRegistered: true, vatRate: 15 });
}

function assertBalanced(entry) {
  const debit = (entry.lines || []).reduce((s, l) => s + l.debit, 0);
  const credit = (entry.lines || []).reduce((s, l) => s + l.credit, 0);
  assert.equal(debit, credit, `${entry.number || entry.id} is unbalanced`);
  assert.equal(entry.totalCents, debit);
}

function net(entries, accountId, { customerId, currency } = {}) {
  let debit = 0;
  let credit = 0;
  let foreign = 0;
  for (const e of entries) {
    for (const l of e.lines || []) {
      if (l.accountId !== accountId) continue;
      if (customerId && l.customerId !== customerId) continue;
      if (currency && l.currency !== currency) continue;
      debit += l.debit;
      credit += l.credit;
      foreign += l.foreignAmount || 0;
    }
  }
  return { debit, credit, net: debit - credit, foreign };
}

async function entriesOf(companyId, opts = {}) {
  const rows = await ledgerJournals.listJournals(companyId, opts);
  rows.forEach(assertBalanced);
  return rows;
}

// 1. ZAR invoice with 15% VAT, partial then full payment (bank match is 1.6.0).
test("1: ZAR invoice with VAT, partial then full payment sits in undeposited funds", async () => {
  const co = await company("TB Co");
  await enableVat(co);
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Acme" });
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerId: cust.id,
    issueDate: "2026-11-01",
    items: [{ description: "Dev", qty: 1, unitPrice: 1000 }],
  });
  assert.equal(inv.total, 1150);
  assert.ok(inv.ledger?.entryId);
  let rows = await entriesOf(co);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceKey, `invoice:${inv.id}:v1`);
  assert.equal(net(rows, "debtors").net, 115000);
  assert.equal(net(rows, "default_income").net, -100000);
  assert.equal(net(rows, "vat").net, -15000);

  await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: 500, paidAt: "2026-11-05" });
  await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: 650, paidAt: "2026-11-10" });
  rows = await entriesOf(co);
  assert.equal(rows.length, 3);
  assert.equal(net(rows, "debtors").net, 0);
  assert.equal(net(rows, "undeposited_funds").net, 115000);
  const owed = await listReceivables(co);
  assert.equal(owed.length, 0);
  const tb = await ledgerJournals.trialBalance(co, { asOf: "2026-11-10" });
  assert.equal(tb.totals.debit, tb.totals.credit);
  assert.equal(tb.baseCurrency, "ZAR");
});

// 4. Published invoice edited, voided, deleted and restored.
test("4: published invoice edit, void, delete and restore re-post with reversals", async () => {
  const co = await company("Edit Co");
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Acme",
    issueDate: "2026-10-01",
    items: [{ description: "A", qty: 1, unitPrice: 100 }],
  });
  const v1 = inv.ledger.entryId;
  const edited = await invoices.updateInvoice(co, ...OWNER, inv.id, {
    issueDate: "2026-10-08",
    items: [{ description: "A", qty: 1, unitPrice: 140 }],
  });
  assert.notEqual(edited.ledger.entryId, v1);
  assert.equal(edited.ledger.version, 2);
  let rows = await entriesOf(co, { sourceType: "invoice", sourceId: inv.id });
  assert.equal(rows.length, 3, "v1 + reversal + v2");
  assert.equal(rows.find((e) => e.id === v1).reversed, true);
  assert.equal(rows.find((e) => e.id === v1).date, "2026-10-01", "edit reverses on the original date");
  assert.equal(rows.find((e) => e.reversesId === v1).date, "2026-10-01");
  assert.equal(rows.find((e) => e.sourceKey === `invoice:${inv.id}:v2`).date, "2026-10-08");
  assert.equal(net(rows, "debtors").net, 14000);

  const notesOnly = await invoices.updateInvoice(co, ...OWNER, inv.id, { notes: "hello" });
  assert.equal(notesOnly.ledger.version, 2, "notes are not ledger-relevant");
  assert.equal((await entriesOf(co, { sourceType: "invoice", sourceId: inv.id })).length, 3);

  const voided = await invoices.voidInvoice(co, ...OWNER, inv.id, { reason: "wrong" });
  assert.equal(voided.status, "void");
  rows = await entriesOf(co, { sourceType: "invoice", sourceId: inv.id });
  assert.ok(rows.some((e) => e.kind === "reversal" && e.source?.event === "void"));
  const voidRev = rows.find((e) => e.reversesId === edited.ledger.entryId);
  assert.match(voidRev.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(net(rows, "debtors").net, 0);

  // Voided invoice: delete should not reverse again; restore stays voided (no new post).
  await invoices.deleteInvoice(co, ...OWNER, inv.id);
  const afterDelete = await entriesOf(co, { sourceType: "invoice", sourceId: inv.id });
  assert.equal(afterDelete.length, rows.length);
  await restoreRecord(co, ...OWNER, "invoice", inv.id);
  const restoredVoid = await invoices.requireInvoice(co, inv.id);
  assert.equal(restoredVoid.voided, true);
  assert.equal((await entriesOf(co, { sourceType: "invoice", sourceId: inv.id })).length, rows.length);

  // Fresh invoice: delete posted invoice on the original date, restore posts v+1.
  const live = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Beta",
    issueDate: "2026-09-01",
    items: [{ description: "B", qty: 1, unitPrice: 50 }],
  });
  await invoices.deleteInvoice(co, ...OWNER, live.id);
  const deletedEntries = await entriesOf(co, { sourceType: "invoice", sourceId: live.id });
  assert.ok(deletedEntries.some((e) => e.source?.event === "delete" && e.date === "2026-09-01"));
  await restoreRecord(co, ...OWNER, "invoice", live.id);
  const back = await invoices.requireInvoice(co, live.id);
  assert.equal(back.ledger.version, 2);
  assert.equal(net(await entriesOf(co, { sourceType: "invoice", sourceId: live.id }), "debtors").net, 5000);
});

// 5. Payment voided, deleted, restored (bank undo is 1.6.0).
test("5: payment void, delete and restore reverse and re-post", async () => {
  const co = await company("Pay Co");
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Acme",
    issueDate: "2026-11-01",
    items: [{ description: "Work", qty: 1, unitPrice: 400 }],
  });
  const rec = await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: 150, paidAt: "2026-11-03" });
  const paymentId = rec.payment.id;
  assert.ok(rec.payment.ledger?.entryId);
  assert.equal(net(await entriesOf(co), "undeposited_funds").net, 15000);

  await payments.voidPayment(co, ...MEMBER, paymentId, { reason: "bounce" });
  const afterVoid = await entriesOf(co, { sourceType: "payment", sourceId: paymentId });
  assert.ok(afterVoid.some((e) => e.source?.event === "void"));
  assert.equal(net(afterVoid, "undeposited_funds").net, 0);
  assert.equal((await invoices.requireInvoice(co, inv.id)).outstanding, 400);

  const rec2 = await payments.recordPayment(co, ...MEMBER, { invoiceId: inv.id, amount: 80, paidAt: "2026-11-04" });
  await payments.deletePayment(co, ...OWNER, rec2.payment.id);
  assert.equal((await invoices.requireInvoice(co, inv.id)).outstanding, 400);
  await restoreRecord(co, ...OWNER, "payment", rec2.payment.id);
  const list = await payments.listPayments(co, { invoiceId: inv.id });
  const restored = list.find((p) => p.id === rec2.payment.id);
  assert.equal(restored.voided, false);
  assert.ok(!restored.deletedAt);
  assert.equal(restored.ledger.version, 2);
  assert.equal((await invoices.requireInvoice(co, inv.id)).outstanding, 320);
  assert.equal(net(await entriesOf(co, { sourceType: "payment", sourceId: rec2.payment.id }), "undeposited_funds").net, 8000);
});

// 6. Expense created, edited, deleted; foreign expense. Bank match is 1.6.0.
test("6: expenses post to 2050, edit and delete reverse, foreign expense needs a rate", async () => {
  const co = await company("Exp Co");
  const cats = await expenses.listCategories(co);
  const hosting = cats.find((c) => c.name === "Hosting & domains");
  const exp = await expenses.createExpense(co, ...MEMBER, {
    date: "2026-11-02",
    vendor: "Afrihost",
    categoryId: hosting.id,
    amount: 149,
    currency: "ZAR",
  });
  assert.equal(exp.accountId, "t5200");
  assert.ok(exp.ledger?.entryId);
  let rows = await entriesOf(co, { sourceType: "expense", sourceId: exp.id });
  assert.equal(net(rows, "t5200").net, 14900);
  assert.equal(net(rows, "expense_clearing").net, -14900);

  const updated = await expenses.updateExpense(co, ...MEMBER, exp.id, { amount: 200, date: "2026-11-04" });
  assert.equal(updated.ledger.version, 2);
  rows = await entriesOf(co, { sourceType: "expense", sourceId: exp.id });
  assert.equal(net(rows, "t5200").net, 20000);
  assert.equal(rows.find((e) => e.sourceKey === `expense:${exp.id}:v1:rev`).date, "2026-11-02");

  await expenses.deleteExpense(co, ...OWNER, exp.id);
  assert.equal(net(await entriesOf(co, { sourceType: "expense", sourceId: exp.id }), "expense_clearing").net, 0);
  await restoreRecord(co, ...OWNER, "expense", exp.id);
  assert.equal((await expenses.getExpense(co, exp.id)).ledger.version, 3);
  assert.equal(net(await entriesOf(co, { sourceType: "expense", sourceId: exp.id }), "t5200").net, 20000);

  await assert.rejects(
    () => expenses.createExpense(co, ...MEMBER, { date: "2026-11-06", vendor: "AWS", amount: 80, currency: "USD" }),
    /exchange rate is required/
  );
  const fx = await expenses.createExpense(co, ...MEMBER, {
    date: "2026-11-06",
    vendor: "AWS",
    amount: 80,
    currency: "USD",
    exchangeRate: 18,
  });
  const fxRows = await entriesOf(co, { sourceType: "expense", sourceId: fx.id });
  assert.equal(net(fxRows, "expense_clearing").net, -144000);
  assert.equal(fxRows[0].lines[0].rate, 18);
});

// 9. Idempotency: replaying the same request posts nothing new.
test("9: replaying the same sourceKey returns the existing entry", async () => {
  const co = await company("Idem Co");
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Acme",
    items: [{ description: "x", qty: 1, unitPrice: 10 }],
  });
  const ctx = await invoices.loadLedgerCtx(co);
  const db = getDb();
  const again = await db.runTransaction((tx) =>
    planPost(tx, co, {
      sourceKey: sourceKey("invoice", inv.id, 1),
      date: inv.issueDate,
      lines: [
        { accountId: "debtors", debit: 1000, credit: 0, currency: "ZAR", foreignAmount: 1000, rate: 1 },
        { accountId: "default_income", debit: 0, credit: 1000, currency: "ZAR", foreignAmount: -1000, rate: 1 },
      ],
      source: { type: "invoice", id: inv.id, event: "post", version: 1 },
      createdBy: "u1",
      baseCurrency: ctx.baseCurrency,
    })
  );
  assert.equal(again.skipped, true);
  assert.equal(again.id, inv.ledger.entryId);
  assert.equal((await entriesOf(co, { sourceType: "invoice", sourceId: inv.id })).filter((e) => e.kind !== "reversal").length, 1);

  const first = await catchUpCompany(co, ...OWNER);
  const second = await catchUpCompany(co, ...OWNER);
  assert.equal(second.posted.length, 0);
  assert.ok(first.goLiveDate);
  const live = (await companyRef(db, co).get()).data();
  assert.equal(live.ledger.goLiveDate, first.goLiveDate);
});

// 10. Failure atomicity: a posting error leaves the document unchanged.
test("10: a posting error leaves the invoice unpublished", async () => {
  const co = await company("Atom Co");
  const custom = await ledgerAccounts.createLedgerAccount(co, ...OWNER, {
    code: "4015",
    name: "Custom income",
    type: "income",
  });
  await ledgerAccounts.archiveLedgerAccount(co, ...OWNER, custom.id);
  await assert.rejects(
    () =>
      invoices.createInvoice(co, ...OWNER, {
        finalize: true,
        customerName: "Acme",
        items: [{ description: "Special", qty: 1, unitPrice: 80, accountId: custom.id }],
      }),
    /archived/
  );
  assert.equal((await invoices.listInvoices(co)).length, 0);
  assert.equal((await entriesOf(co)).length, 0);

  const draft = await invoices.createInvoice(co, ...OWNER, {
    draft: true,
    customerName: "Acme",
    items: [{ description: "Special", qty: 1, unitPrice: 80, accountId: custom.id }],
  });
  await assert.rejects(() => invoices.finalizeInvoice(co, ...OWNER, draft.id), /archived/);
  const still = await invoices.requireInvoice(co, draft.id);
  assert.equal(still.draft, true);
  assert.equal(still.ledger?.entryId, undefined);
});

// 11. Non-ZAR base: foreign invoice needs a rate; FX is in the base; base currency locks.
test("11: non-ZAR base posts at the document rate and locks the base currency", async () => {
  const co = await company("USD Base");
  await companies.updateCompanySettings(co, ...OWNER, { baseCurrency: "USD" });
  await assert.rejects(
    () =>
      invoices.createInvoice(co, ...OWNER, {
        finalize: true,
        customerName: "Local",
        currency: "ZAR",
        items: [{ description: "Work", qty: 1, unitPrice: 1800 }],
      }),
    /exchange rate is required/
  );
  const inv = await invoices.createInvoice(co, ...OWNER, {
    finalize: true,
    customerName: "Local",
    currency: "ZAR",
    exchangeRate: 0.055, // USD per 1 ZAR
    items: [{ description: "Work", qty: 1, unitPrice: 1800 }],
  });
  const rows = await entriesOf(co, { sourceType: "invoice", sourceId: inv.id });
  assert.equal(rows[0].baseCurrency, "USD");
  assert.equal(net(rows, "debtors").net, Math.round(1800 * 0.055 * 100));
  assert.equal(rows[0].lines[0].currency, "ZAR");
  const c = await companies.getCompany(co);
  assert.equal(c.baseCurrency, "USD");
  assert.equal(c.baseCurrencyLocked, true);
  await assert.rejects(() => companies.updateCompanySettings(co, ...OWNER, { baseCurrency: "ZAR" }), /can't change once the ledger has entries/);
});

test("catch-up posts previously unposted live documents and lists foreign invoices that need a rate", async () => {
  const co = await company("Catch Co");
  const cref = companyRef(getDb(), co);
  await cref.collection("invoices").doc("old-zar").set({
    invoiceNumber: "INV-0099",
    draft: false,
    voided: false,
    customerName: "Legacy",
    currency: "ZAR",
    issueDate: "2026-10-01",
    items: [{ description: "Old", qty: 1, unitPrice: 200, accountId: "default_income" }],
    subtotal: 200,
    taxTotal: 0,
    total: 200,
    paidAmount: 0,
    createdAt: new Date().toISOString(),
  });
  await cref.collection("invoices").doc("old-usd").set({
    invoiceNumber: "INV-0100",
    draft: false,
    voided: false,
    customerName: "USD Legacy",
    currency: "USD",
    issueDate: "2026-10-02",
    items: [{ description: "Old", qty: 1, unitPrice: 50, accountId: "default_income" }],
    subtotal: 50,
    taxTotal: 0,
    total: 50,
    paidAmount: 0,
    createdAt: new Date().toISOString(),
  });
  const result = await catchUpCompany(co, ...OWNER);
  assert.equal(result.posted.length, 1);
  assert.equal(result.posted[0].id, "old-zar");
  assert.deepEqual(result.needsRate.map((r) => r.id), ["old-usd"]);
  const posted = await invoices.requireInvoice(co, "old-zar");
  assert.ok(posted.ledger.entryId);
  const again = await catchUpCompany(co, ...OWNER);
  assert.equal(again.posted.length, 0);
  assert.deepEqual(again.needsRate.map((r) => r.id), ["old-usd"]);
});
