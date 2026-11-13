const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

setupFake();
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const products = require("../lib/products");
const invoices = require("../lib/invoices");
const timeEntries = require("../lib/timeEntries");
const agreements = require("../lib/agreements");
const {
  daysInclusive,
  prorateAmounts,
  closeHours,
  fullCalendarPeriod,
  periodCoveringDate,
  listPeriodWindows,
} = require("../lib/agreementPeriods");
const { restoreRecord } = require("../lib/restore");

const OWNER = ["u1", "u1@example.com", "owner"];

async function seed(name = "Agreements Co") {
  const c = await companies.createCompany({ uid: "u1", email: "u1@example.com", name });
  const customer = await customers.createCustomer(c.id, ...OWNER, { name: "Acme" });
  const service = await products.createProduct(c.id, ...OWNER, { name: "Retainer", unitPrice: 10000, kind: "service" });
  return { co: c.id, customer, service };
}

async function draftAgreement(co, customer, service, extra = {}) {
  return agreements.createAgreement(co, ...OWNER, {
    name: extra.name || "Monthly retainer",
    customerId: customer.id,
    serviceId: service.id,
    startDate: extra.startDate || "2026-01-15",
    endDate: extra.endDate,
    period: extra.period || "month",
    hours: extra.hours ?? 10,
    fee: extra.fee ?? 10000,
    rate: extra.rate ?? 1000,
    overageRate: extra.overageRate,
    currency: "ZAR",
    autoPublish: extra.autoPublish || false,
    rolloverPolicy: extra.rolloverPolicy || { mode: "expire" },
  });
}

test("proration uses inclusive day count: 15–31 Jan is 17/31", () => {
  assert.equal(daysInclusive("2026-01-15", "2026-01-31"), 17);
  const r = prorateAmounts(10, 10000, 17, 31);
  assert.equal(r.prorated, true);
  assert.equal(r.hoursAllowed, 5.48);
  assert.equal(r.fee, 5483.87);
});

test("a full calendar month is not prorated", () => {
  const jan = fullCalendarPeriod("2026-01-01", "month");
  assert.equal(jan.startsOn, "2026-01-01");
  assert.equal(jan.endsOn, "2026-01-31");
  const r = prorateAmounts(10, 10000, 31, 31);
  assert.equal(r.prorated, false);
  assert.equal(r.hoursAllowed, 10);
  assert.equal(r.fee, 10000);
});

test("a mid-quarter start is prorated by days in the quarter", () => {
  // 2026 Q1 is 31+28+31 = 90 days. 15 Feb–31 Mar = 14+31 = 45 days.
  const q = fullCalendarPeriod("2026-02-15", "quarter");
  assert.equal(q.startsOn, "2026-01-01");
  assert.equal(q.endsOn, "2026-03-31");
  assert.equal(daysInclusive("2026-01-01", "2026-03-31"), 90);
  assert.equal(daysInclusive("2026-02-15", "2026-03-31"), 45);
  const r = prorateAmounts(40, 30000, 45, 90);
  assert.equal(r.hoursAllowed, 20);
  assert.equal(r.fee, 15000);
});

test("rollover with no cap carries unused hours; a cap expires the rest; expire carries none", () => {
  const unused = closeHours({ hoursAllowed: 10, hoursRolledIn: 0, hoursUsed: 7, rolloverPolicy: { mode: "rollover" } });
  assert.equal(unused.hoursRemaining, 3);
  assert.equal(unused.hoursRolledOut, 3);
  assert.equal(unused.hoursExpired, 0);
  assert.equal(unused.hoursOverage, 0);

  const capped = closeHours({ hoursAllowed: 10, hoursRolledIn: 0, hoursUsed: 5, rolloverPolicy: { mode: "rollover", limitHours: 2 } });
  assert.equal(capped.hoursRolledOut, 2);
  assert.equal(capped.hoursExpired, 3);

  const expired = closeHours({ hoursAllowed: 10, hoursRolledIn: 2, hoursUsed: 8, rolloverPolicy: { mode: "expire" } });
  assert.equal(expired.hoursAvailable, 12);
  assert.equal(expired.hoursRemaining, 4);
  assert.equal(expired.hoursRolledOut, 0);
  assert.equal(expired.hoursExpired, 4);
});

test("overage is hours used above allowance plus rolled-in hours", () => {
  const r = closeHours({ hoursAllowed: 10, hoursRolledIn: 2, hoursUsed: 15, rolloverPolicy: { mode: "rollover" } });
  assert.equal(r.hoursOverage, 3);
  assert.equal(r.hoursRolledOut, 0);
  assert.equal(r.hoursRemaining, 0);
});

test("activating a mid-month start creates a prorated first period and a draft invoice", async () => {
  const { co, customer, service } = await seed("Prorate Co");
  const a = await draftAgreement(co, customer, service, { startDate: "2026-01-15", hours: 10, fee: 10000 });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-15" });
  const { periods } = await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-01-15" });
  assert.equal(periods.length, 1);
  assert.equal(periods[0].startsOn, "2026-01-15");
  assert.equal(periods[0].endsOn, "2026-01-31");
  assert.equal(periods[0].daysInPeriod, 17);
  assert.equal(periods[0].daysInFullPeriod, 31);
  assert.equal(periods[0].prorated, true);
  assert.equal(periods[0].hoursAllowed, 5.48);
  assert.equal(periods[0].fee, 5483.87);
  const inv = await invoices.requireInvoice(co, periods[0].recurringInvoiceId);
  assert.equal(inv.draft, true);
  assert.equal(inv.agreementId, a.id);
  assert.equal(inv.agreementPeriodId, periods[0].id);
  assert.equal(inv.issueDate, "2026-01-15");
  assert.equal(inv.subtotal, 5483.87);
  assert.equal(inv.items[0].unitPrice, 5483.87);
  assert.match(inv.items[0].description, /15 Jan 2026/);
});

test("a full-month start is not prorated, and rolled-in hours are not prorated", async () => {
  const { co, customer, service } = await seed("Full Month Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    hours: 10,
    fee: 10000,
    rolloverPolicy: { mode: "rollover" },
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  const jan = (await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-01-01" })).periods[0];
  assert.equal(jan.prorated, false);
  assert.equal(jan.hoursAllowed, 10);
  assert.equal(jan.fee, 10000);
  await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-01-10",
    hours: 7,
    description: "January work",
    agreementId: a.id,
  });
  await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const periods = (await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-02-01" })).periods;
  const january = periods.find((p) => p.startsOn === "2026-01-01");
  const february = periods.find((p) => p.startsOn === "2026-02-01");
  assert.equal(january.status, "closed");
  assert.equal(january.hoursUsed, 7);
  assert.equal(january.hoursRolledOut, 3);
  assert.equal(february.hoursRolledIn, 3);
  assert.equal(february.hoursAllowed, 10);
  assert.equal(february.prorated, false);
});

test("unused hours expire when the policy is expire", async () => {
  const { co, customer, service } = await seed("Expire Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    rolloverPolicy: { mode: "expire" },
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-12", hours: 6, description: "Work", agreementId: a.id });
  await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const periods = (await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-02-01" })).periods;
  const january = periods.find((p) => p.startsOn === "2026-01-01");
  const february = periods.find((p) => p.startsOn === "2026-02-01");
  assert.equal(january.hoursExpired, 4);
  assert.equal(january.hoursRolledOut, 0);
  assert.equal(february.hoursRolledIn, 0);
});

test("a rollover cap expires hours above the cap", async () => {
  const { co, customer, service } = await seed("Cap Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    rolloverPolicy: { mode: "rollover", limitHours: 2 },
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-12", hours: 5, description: "Work", agreementId: a.id });
  await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const periods = (await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-02-01" })).periods;
  const january = periods.find((p) => p.startsOn === "2026-01-01");
  const february = periods.find((p) => p.startsOn === "2026-02-01");
  assert.equal(january.hoursRolledOut, 2);
  assert.equal(january.hoursExpired, 3);
  assert.equal(february.hoursRolledIn, 2);
});

test("overage hours are added as a line on the next recurring invoice at the overage rate", async () => {
  const { co, customer, service } = await seed("Overage Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    hours: 10,
    fee: 10000,
    rate: 1000,
    overageRate: 1500,
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-20", hours: 12, description: "Busy month", agreementId: a.id });
  const janInv = (await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-01-01" })).periods[0];
  const first = await invoices.requireInvoice(co, janInv.recurringInvoiceId);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].unitPrice, 10000);

  const { invoices: created } = await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  assert.equal(created.length, 1);
  const feb = created[0];
  assert.equal(feb.items.length, 2);
  assert.equal(feb.items[0].unitPrice, 10000);
  const overage = feb.items.find((i) => /overage/i.test(i.description));
  assert.ok(overage);
  assert.equal(overage.qty, 2);
  assert.equal(overage.unitPrice, 1500);
  assert.equal(feb.subtotal, 13000);
});

test("overage falls back to the standard rate when no overage rate is set", async () => {
  const { co, customer, service } = await seed("Fallback Rate Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    hours: 10,
    fee: 10000,
    rate: 800,
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-20", hours: 11, description: "One over", agreementId: a.id });
  const { invoices: created } = await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const overage = created[0].items.find((i) => /overage/i.test(i.description));
  assert.equal(overage.qty, 1);
  assert.equal(overage.unitPrice, 800);
});

test("ending an agreement bills remaining overage on a final invoice", async () => {
  const { co, customer, service } = await seed("End Overage Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    hours: 10,
    fee: 10000,
    rate: 1000,
    overageRate: 1200,
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-20", hours: 13, description: "Over", agreementId: a.id });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "ended", { endDate: "2026-01-31", asOf: "2026-01-31" });
  const { periods } = await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-01-31" });
  assert.equal(periods.length, 1);
  assert.ok(periods[0].overageInvoiceId);
  const inv = await invoices.requireInvoice(co, periods[0].overageInvoiceId);
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].qty, 3);
  assert.equal(inv.items[0].unitPrice, 1200);
  assert.equal(inv.overageForPeriodId, periods[0].id);
});

test("recurring invoice generation is idempotent per agreement and period", async () => {
  const { co, customer, service } = await seed("Idempotent Co");
  const a = await draftAgreement(co, customer, service, { startDate: "2026-01-01" });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  const first = await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const second = await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  assert.equal(second.invoices.length, 0);
  const all = await invoices.listInvoices(co, { customerId: customer.id });
  const recurring = all.filter((i) => i.agreementId === a.id && !i.voided);
  assert.equal(recurring.length, first.invoices.length + 1); // January on activate + February
  const keys = recurring.map((i) => i.agreementPeriodId + ":" + (i.overageForPeriodId || ""));
  assert.equal(new Set(keys).size, keys.length);
});

test("autoPublish publishes the recurring invoice and posts to the ledger", async () => {
  const { co, customer, service } = await seed("Auto Publish Co");
  const a = await draftAgreement(co, customer, service, { startDate: "2026-01-01", autoPublish: true });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  const { periods } = await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-01-01" });
  const inv = await invoices.requireInvoice(co, periods[0].recurringInvoiceId);
  assert.equal(inv.draft, false);
  assert.ok(inv.invoiceNumber);
  assert.ok(inv.ledger?.entryId);
});

test("paused agreements do not generate new invoices until resumed", async () => {
  const { co, customer, service } = await seed("Paused Co");
  const a = await draftAgreement(co, customer, service, { startDate: "2026-01-01" });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "paused");
  const paused = await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  assert.equal(paused.invoices.length, 0);
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-02-01" });
  const { periods } = await agreements.listAgreementPeriods(co, a.id, { asOf: "2026-02-01" });
  assert.ok(periods.find((p) => p.startsOn === "2026-02-01")?.recurringInvoiceId);
});

test("agreement-linked time is assigned to the period and cannot be invoiced as ad hoc hours", async () => {
  const { co, customer, service } = await seed("Time Link Co");
  const a = await draftAgreement(co, customer, service, { startDate: "2026-01-01" });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  const entry = await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-01-20",
    hours: 2.5,
    description: "Retainer work",
    agreementId: a.id,
    billable: true,
  });
  assert.equal(entry.billable, false);
  assert.equal(entry.customerId, customer.id);
  assert.ok(entry.periodId);
  assert.equal(entry.agreementId, a.id);
  const report = await agreements.hoursReport(co, { agreementId: a.id, asOf: "2026-01-20" });
  assert.equal(report.reports[0].periods[0].hoursUsed, 2.5);
  await assert.rejects(
    () => timeEntries.createInvoiceFromTime(co, ...OWNER, { entryIds: [entry.id] }),
    /retainer invoice|cannot be invoiced/i
  );
});

test("time cannot be logged against a closed period", async () => {
  const { co, customer, service } = await seed("Closed Period Co");
  const a = await draftAgreement(co, customer, service, { startDate: "2026-01-01" });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  await assert.rejects(
    () => timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-20", hours: 1, description: "Late", agreementId: a.id }),
    /closed/i
  );
});

test("agreements support soft delete and restore", async () => {
  const { co, customer, service } = await seed("Delete Co");
  const a = await draftAgreement(co, customer, service);
  await agreements.deleteAgreement(co, ...OWNER, a.id);
  assert.equal(await agreements.getAgreement(co, a.id), null);
  await restoreRecord(co, ...OWNER, "agreement", a.id);
  const restored = await agreements.requireAgreement(co, a.id);
  assert.equal(restored.name, a.name);
  assert.equal(restored.status, "draft");
});

test("hours report lists allowance, used, rollover, overage and separate ad hoc hours", async () => {
  const { co, customer, service } = await seed("Report Co");
  const a = await draftAgreement(co, customer, service, {
    startDate: "2026-01-01",
    rolloverPolicy: { mode: "rollover" },
  });
  await agreements.setAgreementStatus(co, ...OWNER, a.id, "active", { asOf: "2026-01-01" });
  await timeEntries.createTimeEntry(co, ...OWNER, { date: "2026-01-10", hours: 12, description: "Agreement time", agreementId: a.id });
  await timeEntries.createTimeEntry(co, ...OWNER, {
    date: "2026-01-11",
    hours: 3,
    description: "Extra project",
    customerId: customer.id,
    billable: true,
    rate: 900,
  });
  await agreements.generateDueInvoices(co, ...OWNER, { asOf: "2026-02-01", agreementId: a.id });
  const report = await agreements.hoursReport(co, { agreementId: a.id, asOf: "2026-02-01" });
  const jan = report.reports[0].periods.find((p) => p.startsOn === "2026-01-01");
  assert.equal(jan.hoursAllowed, 10);
  assert.equal(jan.hoursUsed, 12);
  assert.equal(jan.hoursOverage, 2);
  assert.equal(report.reports[0].adHocHours.used, 3);
  assert.equal(report.reports[0].adHocHours.unbilled, 3);
});

test("last-period proration clips to the end date", () => {
  const windows = listPeriodWindows(
    { startDate: "2026-01-01", endDate: "2026-02-10", period: "month", hours: 10, fee: 10000 },
    "2026-02-10"
  );
  assert.equal(windows.length, 2);
  assert.equal(windows[1].startsOn, "2026-02-01");
  assert.equal(windows[1].endsOn, "2026-02-10");
  assert.equal(windows[1].daysInPeriod, 10);
  assert.equal(windows[1].daysInFullPeriod, 28);
  assert.equal(windows[1].hoursAllowed, 3.57);
  assert.equal(windows[1].fee, 3571.43);
});

test("periodCoveringDate returns the clipped first period for a mid-month start", () => {
  const w = periodCoveringDate({ startDate: "2026-01-15", period: "month", hours: 10, fee: 10000 }, "2026-01-20");
  assert.equal(w.startsOn, "2026-01-15");
  assert.equal(w.endsOn, "2026-01-31");
});
