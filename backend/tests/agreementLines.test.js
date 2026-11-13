const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

const db = setupFake();
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const products = require("../lib/products");
const invoices = require("../lib/invoices");
const timeEntries = require("../lib/timeEntries");
const agreements = require("../lib/agreements");
const {
  periodValue,
  lineTotal,
  legacyToLines,
  linesFromBody,
  derivedFields,
  prorateLines,
} = require("../lib/agreementLines");

const OWNER = ["u1", "u1@example.com", "owner"];

async function seed(name) {
  const c = await companies.createCompany({ uid: "u1", email: "u1@example.com", name });
  const customer = await customers.createCustomer(c.id, ...OWNER, { name: "Acme" });
  const support = await products.createProduct(c.id, ...OWNER, { name: "Support hours", unitPrice: 500, kind: "service" });
  const hosting = await products.createProduct(c.id, ...OWNER, { name: "Hosting", unitPrice: 1500, kind: "service" });
  const licence = await products.createProduct(c.id, ...OWNER, { name: "Licence", unitPrice: 250, kind: "service" });
  return { co: c.id, customer, support, hosting, licence };
}

function multiLine(s, extra = {}) {
  return agreements.createAgreement(s.co, ...OWNER, {
    name: extra.name || "Managed services",
    customerId: s.customer.id,
    startDate: extra.startDate || "2026-01-01",
    endDate: extra.endDate,
    period: "month",
    currency: "ZAR",
    rolloverPolicy: extra.rolloverPolicy || { mode: "expire" },
    autoPublish: extra.autoPublish || false,
    lines: extra.lines || [
      { serviceId: s.support.id, qty: 20, tracksTime: true, ...(extra.supportLine || {}) },
      { serviceId: s.hosting.id, qty: 1, tracksTime: false },
      { serviceId: s.licence.id, qty: 0, tracksTime: false },
    ],
  });
}

// ---------- pure helpers ----------

test("period value is the sum of qty × rate across lines", () => {
  const lines = [
    { qty: 20, rate: 500 },
    { qty: 1, rate: 1500 },
    { qty: 2.5, rate: 99.99 },
    { qty: 0, rate: 250 },
  ];
  assert.equal(lineTotal(lines[2]), 249.98);
  assert.equal(periodValue(lines), 11749.98);
});

test("legacy single-service fields convert to one tracked line", () => {
  const [line] = legacyToLines({ serviceId: "svc", hours: 10, fee: 10000, rate: 800 });
  assert.equal(line.serviceId, "svc");
  assert.equal(line.qty, 1);
  assert.equal(line.rate, 10000);
  assert.equal(line.includedQty, 10);
  assert.equal(line.overageRate, 800); // overage falls back to the old standard rate
  assert.equal(line.tracksTime, true);
  const [noRate] = legacyToLines({ serviceId: "svc", hours: 20, fee: 10000 });
  assert.equal(noRate.overageRate, 500); // fee / hours, as in 1.9
  assert.deepEqual(derivedFields([line]), { serviceId: "svc", hours: 10, fee: 10000, rate: 10000, overageRate: 800 });
});

test("line validation: one time-tracked line, first line by default, no negatives", () => {
  const defaulted = linesFromBody({ lines: [{ serviceId: "a", qty: 5, rate: 10 }, { serviceId: "b", qty: 1, rate: 1, includedQty: 3 }] });
  assert.equal(defaulted[0].tracksTime, true);
  assert.equal(defaulted[1].tracksTime, false);
  assert.equal(defaulted[1].includedQty, null, "included qty only applies to the time-tracked line");
  const none = linesFromBody({ lines: [{ serviceId: "a", qty: 1, rate: 10, tracksTime: false }] });
  assert.equal(none[0].tracksTime, false);
  assert.throws(() => linesFromBody({ lines: [] }), /at least one line/);
  assert.throws(() => linesFromBody({ lines: [{ qty: 1 }] }), /pick a billable service/);
  assert.throws(() => linesFromBody({ lines: [{ serviceId: "a", qty: -1 }] }), /qty cannot be negative/);
  assert.throws(() => linesFromBody({ lines: [{ serviceId: "a", rate: -5 }] }), /rate cannot be negative/);
  assert.throws(
    () => linesFromBody({ lines: [{ serviceId: "a", tracksTime: true }, { serviceId: "b", tracksTime: true }] }),
    /Only one line/
  );
});

test("prorated line amounts always add up to the period fee", () => {
  const lines = [{ qty: 1, rate: 100 }, { qty: 1, rate: 100 }, { qty: 1, rate: 100 }, { qty: 0, rate: 50 }];
  // 300 × 29/90 = 96.67, but each line rounds to 32.22 (96.66): the cent goes on the last line.
  const split = prorateLines(lines, 96.67, 29 / 90);
  const sum = Math.round(split.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  assert.equal(sum, 96.67);
  assert.equal(split[2].amount, 32.23);
  assert.equal(split[3].amount, 0);
});

// ---------- API + invoice generation ----------

test("creating with lines fills description and rate from the service and derives the period fee", async () => {
  const s = await seed("Lines Co");
  const a = await multiLine(s);
  assert.equal(a.lines.length, 3);
  assert.equal(a.lines[0].description, "Support hours");
  assert.equal(a.lines[0].rate, 500);
  assert.equal(a.lines[1].rate, 1500);
  assert.equal(a.fee, 11500);
  assert.equal(a.hours, 20, "included qty defaults to the line qty");
  assert.equal(a.serviceId, s.support.id);
  const listed = (await agreements.listAgreements(s.co)).find((x) => x.id === a.id);
  assert.equal(listed.lines.length, 3);
});

test("a full period invoice has one line per agreement line (zero-qty lines skipped)", async () => {
  const s = await seed("Full Lines Co");
  const a = await multiLine(s);
  await agreements.setAgreementStatus(s.co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  const { periods } = await agreements.listAgreementPeriods(s.co, a.id, { asOf: "2026-01-01" });
  assert.equal(periods[0].fee, 11500);
  const inv = await invoices.requireInvoice(s.co, periods[0].recurringInvoiceId);
  assert.equal(inv.draft, true);
  assert.equal(inv.items.length, 2);
  assert.equal(inv.items[0].qty, 20);
  assert.equal(inv.items[0].unitPrice, 500);
  assert.match(inv.items[0].description, /^Support hours — 1 Jan 2026/);
  assert.equal(inv.items[1].qty, 1);
  assert.equal(inv.items[1].unitPrice, 1500);
  assert.equal(inv.items[1].productId, s.hosting.id);
  assert.equal(inv.subtotal, 11500);
});

test("a partial first period prorates every line and the lines add up to the period fee", async () => {
  const s = await seed("Prorated Lines Co");
  const a = await multiLine(s, { startDate: "2026-01-15" });
  await agreements.setAgreementStatus(s.co, ...OWNER, a.id, "active", { asOf: "2026-01-15" });
  const { periods } = await agreements.listAgreementPeriods(s.co, a.id, { asOf: "2026-01-15" });
  assert.equal(periods[0].fee, 6306.45); // 11500 × 17/31
  assert.equal(periods[0].hoursAllowed, 10.97); // 20 × 17/31
  const inv = await invoices.requireInvoice(s.co, periods[0].recurringInvoiceId);
  assert.equal(inv.items.length, 2);
  assert.ok(inv.items.every((i) => i.qty === 1));
  assert.match(inv.items[0].note, /Prorated 17 of 31 days of 20 × 500\.00/);
  assert.equal(inv.subtotal, 6306.45);
});

test("overage is billed on the time-tracked line at its overage rate, after rollover", async () => {
  const s = await seed("Overage Lines Co");
  const a = await multiLine(s, {
    supportLine: { includedQty: 10, overageRate: 650 },
    rolloverPolicy: { mode: "rollover" },
  });
  assert.equal(a.hours, 10);
  await agreements.setAgreementStatus(s.co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  // January: 7 of 10 hours used, 3 roll over.
  await timeEntries.createTimeEntry(s.co, ...OWNER, { date: "2026-01-10", hours: 7, description: "Jan", agreementId: a.id });
  const feb = (await agreements.generateDueInvoices(s.co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id })).invoices[0];
  assert.ok(!feb.items.some((i) => /overage/i.test(i.description)));
  // February: 15 used against 10 + 3 rolled in = 2 overage.
  await timeEntries.createTimeEntry(s.co, ...OWNER, { date: "2026-02-10", hours: 15, description: "Feb", agreementId: a.id });
  const mar = (await agreements.generateDueInvoices(s.co, ...OWNER, { asOf: "2026-03-01", agreementId: a.id })).invoices[0];
  const overage = mar.items.find((i) => /overage/i.test(i.description));
  assert.ok(overage);
  assert.match(overage.description, /^Overage: Support hours — 1 Feb 2026/);
  assert.equal(overage.qty, 2);
  assert.equal(overage.unitPrice, 650);
  assert.equal(overage.productId, s.support.id);
  assert.equal(mar.subtotal, 11500 + 1300);
});

test("overage falls back to the line rate when no overage rate is set", async () => {
  const s = await seed("Line Rate Co");
  const a = await multiLine(s, { supportLine: { includedQty: 10, rate: 550 } });
  await agreements.setAgreementStatus(s.co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(s.co, ...OWNER, { date: "2026-01-10", hours: 11, description: "Over", agreementId: a.id });
  const feb = (await agreements.generateDueInvoices(s.co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id })).invoices[0];
  const overage = feb.items.find((i) => /overage/i.test(i.description));
  assert.equal(overage.qty, 1);
  assert.equal(overage.unitPrice, 550);
});

test("without a time-tracked line, logged time is not billed as overage", async () => {
  const s = await seed("No Hours Line Co");
  const a = await multiLine(s, { lines: [{ serviceId: s.hosting.id, qty: 1, tracksTime: false }] });
  assert.equal(a.hours, 0);
  await agreements.setAgreementStatus(s.co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(s.co, ...OWNER, { date: "2026-01-10", hours: 3, description: "Ops", agreementId: a.id });
  const feb = (await agreements.generateDueInvoices(s.co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id })).invoices[0];
  assert.equal(feb.items.length, 1);
  assert.equal(feb.subtotal, 1500);
});

test("generation stays idempotent and auto-publish still posts to the ledger with lines", async () => {
  const s = await seed("Idem Lines Co");
  const a = await multiLine(s, { autoPublish: true });
  await agreements.setAgreementStatus(s.co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await agreements.generateDueInvoices(s.co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const again = await agreements.generateDueInvoices(s.co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  assert.equal(again.invoices.length, 0);
  const all = (await invoices.listInvoices(s.co, { customerId: s.customer.id })).filter((i) => i.agreementId === a.id);
  assert.equal(all.length, 2);
  assert.ok(all.every((i) => i.draft === false && i.ledger?.entryId));
});

test("a legacy payload is converted to one line; a stored pre-1.10 agreement reads as one line", async () => {
  const s = await seed("Legacy Co");
  const a = await agreements.createAgreement(s.co, ...OWNER, {
    name: "Old style",
    customerId: s.customer.id,
    serviceId: s.support.id,
    startDate: "2026-01-01",
    hours: 20,
    fee: 10000,
    rate: 500,
    overageRate: 600,
  });
  assert.equal(a.lines.length, 1);
  assert.equal(a.lines[0].qty, 1);
  assert.equal(a.lines[0].rate, 10000);
  assert.equal(a.lines[0].includedQty, 20);
  assert.equal(a.lines[0].overageRate, 600);
  assert.equal(a.lines[0].description, "Support hours");

  // Write a 1.9-shaped document with no lines, as production would have.
  const { companyRef } = require("../lib/refs");
  await companyRef(db, s.co).collection("agreements").doc("legacy1").set({
    name: "Stored 1.9",
    customerId: s.customer.id,
    customerName: "Acme",
    serviceId: s.hosting.id,
    startDate: "2026-01-01",
    endDate: "",
    period: "month",
    hours: 5,
    fee: 4000,
    rate: 800,
    overageRate: null,
    currency: "ZAR",
    status: "draft",
  });
  const stored = await agreements.requireAgreement(s.co, "legacy1");
  assert.equal(stored.lines.length, 1);
  assert.equal(stored.lines[0].serviceId, s.hosting.id);
  assert.equal(stored.lines[0].overageRate, 800);
  assert.equal(stored.fee, 4000);
  assert.equal(agreements.effectiveOverageRate(stored), 800);

  // Editing it with lines replaces the single line.
  const updated = await agreements.updateAgreement(s.co, ...OWNER, "legacy1", {
    lines: [
      { serviceId: s.support.id, qty: 8, rate: 500, tracksTime: true },
      { serviceId: s.hosting.id, qty: 1, tracksTime: false },
    ],
  });
  assert.equal(updated.lines.length, 2);
  assert.equal(updated.fee, 5500);
  assert.equal(updated.hours, 8);
  // A name-only edit keeps the lines.
  const renamed = await agreements.updateAgreement(s.co, ...OWNER, "legacy1", { name: "Renamed" });
  assert.equal(renamed.lines.length, 2);
  assert.equal(renamed.fee, 5500);
});
