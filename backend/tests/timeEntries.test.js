const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

setupFake();
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const invoices = require("../lib/invoices");
const timeEntries = require("../lib/timeEntries");
const { restoreRecord } = require("../lib/restore");

const OWNER = ["u1", "u1@example.com", "owner"];
const MEMBER = ["u2", "u2@example.com", "member"];

async function company(name = "Time Co") {
  const c = await companies.createCompany({ uid: "u1", email: "u1@example.com", name });
  return c.id;
}

test("internal time is non-billable by default and cannot be invoiced", async () => {
  const co = await company("Internal Co");
  const entry = await timeEntries.createTimeEntry(co, ...MEMBER, {
    date: "2026-11-10",
    hours: 1.5,
    description: "Internal planning",
  });
  assert.equal(entry.minutes, 90);
  assert.equal(entry.hours, 1.5);
  assert.equal(entry.billable, false);
  assert.equal(entry.status, "internal");
  assert.equal(entry.source, "manual");
  await assert.rejects(
    () => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id] }),
    /billable/i
  );
});

test("ad hoc billable hours can be invoiced once and are marked billed", async () => {
  const co = await company("Bill Co");
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Acme" });
  const a = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-10",
    hours: 2,
    description: "Development",
    customerId: cust.id,
    billable: true,
    rate: 800,
  });
  const b = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-11",
    minutes: 30,
    description: "Call",
    customerId: cust.id,
    billable: true,
    rate: 800,
  });
  const inv = await timeEntries.createInvoiceFromTime(co, ...OWNER, {
    entryIds: [a.id, b.id],
    finalize: true,
  });
  assert.equal(inv.draft, false);
  assert.equal(inv.customerId, cust.id);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items[0].timeEntryId, a.id);
  assert.equal(inv.items[0].qty, 2);
  assert.equal(inv.items[1].qty, 0.5);
  assert.equal(inv.subtotal, 2000);
  const billedA = await timeEntries.requireTimeEntry(co, a.id);
  const billedB = await timeEntries.requireTimeEntry(co, b.id);
  assert.equal(billedA.status, "billed");
  assert.equal(billedA.invoiceId, inv.id);
  assert.ok(billedA.billedAt);
  assert.equal(billedB.invoiceId, inv.id);
  const unbilled = await timeEntries.listTimeEntries(co, { unbilled: true });
  assert.equal(unbilled.length, 0);
  await assert.rejects(
    () => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [a.id] }),
    /already on an invoice/i
  );
  await assert.rejects(() => timeEntries.updateTimeEntry(co, ...OWNER, a.id, { hours: 3 }), /already been invoiced/i);
  await assert.rejects(() => timeEntries.deleteTimeEntry(co, ...OWNER, a.id), /invoice first/i);
});

test("a draft invoice reserves hours so they cannot be billed twice; publish then marks billed", async () => {
  const co = await company("Reserve Co");
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Beta" });
  const entry = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-12",
    hours: 1,
    description: "Support",
    customerId: cust.id,
    billable: true,
    rate: 500,
  });
  const draft = await timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id], draft: true });
  assert.equal(draft.draft, true);
  const reserved = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.invoiceId, draft.id);
  assert.equal(reserved.billedAt, null);
  await assert.rejects(
    () => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id], finalize: true }),
    /already on an invoice/i
  );
  const published = await invoices.finalizeInvoice(co, ...OWNER, draft.id);
  assert.equal(published.draft, false);
  const billed = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(billed.status, "billed");
  assert.ok(billed.billedAt);
});

test("voiding or deleting an invoice clears the billed mark; restore sets it again", async () => {
  const co = await company("Clear Co");
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Gamma" });
  const entry = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-12",
    hours: 3,
    description: "Build",
    customerId: cust.id,
    billable: true,
    rate: 1000,
  });
  const inv = await timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id], finalize: true });
  await invoices.voidInvoice(co, ...OWNER, inv.id, { reason: "redo" });
  const afterVoid = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(afterVoid.invoiceId, "");
  assert.equal(afterVoid.billedAt, null);
  assert.equal(afterVoid.status, "unbilled");

  const again = await timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id], finalize: true });
  await invoices.deleteInvoice(co, ...OWNER, again.id);
  const afterDelete = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(afterDelete.status, "unbilled");
  assert.equal(afterDelete.invoiceId, "");

  await restoreRecord(co, ...OWNER, "invoice", again.id);
  const afterRestore = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(afterRestore.status, "billed");
  assert.equal(afterRestore.invoiceId, again.id);
});

test("removing a time line from a draft frees the entry; duplicate does not copy the link", async () => {
  const co = await company("Edit Co");
  const cust = await customers.createCustomer(co, ...OWNER, { name: "Delta" });
  const entry = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-12",
    hours: 1,
    description: "Review",
    customerId: cust.id,
    billable: true,
    rate: 400,
  });
  const draft = await timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id], draft: true });
  await invoices.updateInvoice(co, ...OWNER, draft.id, { items: [{ description: "Other work", qty: 1, unitPrice: 100 }] });
  const freed = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(freed.status, "unbilled");
  assert.equal(freed.invoiceId, "");

  const again = await timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id], finalize: true });
  const copy = await invoices.duplicateInvoice(co, ...OWNER, again.id);
  assert.ok(copy.items.every((i) => !i.timeEntryId));
  const still = await timeEntries.requireTimeEntry(co, entry.id);
  assert.equal(still.invoiceId, again.id);
});

test("members can log time; only owners and admins can delete unbilled entries", async () => {
  const co = await company("Roles Co");
  const entry = await timeEntries.createTimeEntry(co, ...MEMBER, {
    date: "2026-11-12",
    minutes: 45,
    description: "Notes",
    source: "assistant",
  });
  assert.equal(entry.source, "assistant");
  await assert.rejects(() => timeEntries.deleteTimeEntry(co, ...MEMBER, entry.id), /Forbidden/);
  await timeEntries.deleteTimeEntry(co, ...OWNER, entry.id);
  await assert.rejects(() => timeEntries.requireTimeEntry(co, entry.id), /not found/i);
});

test("invoicing requires a customer and a rate, and entries must share one customer", async () => {
  const co = await company("Guard Co");
  const aCust = await customers.createCustomer(co, ...OWNER, { name: "A" });
  const bCust = await customers.createCustomer(co, ...OWNER, { name: "B" });
  const noCustomer = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-12",
    hours: 1,
    description: "Loose",
    billable: true,
    rate: 100,
  });
  await assert.rejects(() => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [noCustomer.id] }), /customer/i);
  const a = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-12",
    hours: 1,
    description: "A work",
    customerId: aCust.id,
    billable: true,
  });
  const b = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-12",
    hours: 1,
    description: "B work",
    customerId: bCust.id,
    billable: true,
    rate: 100,
  });
  await assert.rejects(() => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [a.id] }), /rate/i);
  const priced = await timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [a.id], rate: 250, finalize: true });
  assert.equal(priced.items[0].unitPrice, 250);
  const other = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-11-13",
    hours: 1,
    description: "More A",
    customerId: aCust.id,
    billable: true,
    rate: 250,
  });
  await assert.rejects(() => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [other.id, b.id] }), /single customer/i);
});
