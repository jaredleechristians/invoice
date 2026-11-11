const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

setupFake();
const companies = require("../lib/companies");
const invoices = require("../lib/invoices");
const quotes = require("../lib/quotes");

const A = ["u1", "u1@example.com", "owner"];
let co;

test.before(async () => {
  co = (await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Co" })).id;
});

const item = [{ description: "Work", qty: 1, unitPrice: 100 }];

test("finalized invoices get sequential numbers; drafts get none", async () => {
  const d = await invoices.createInvoice(co, ...A, { draft: true, customerName: "X", items: item });
  assert.equal(d.invoiceNumber, "");
  assert.equal(d.status, "draft");
  const i1 = await invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: item });
  const i2 = await invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: item });
  assert.equal(i1.invoiceNumber, "INV-0001");
  assert.equal(i2.invoiceNumber, "INV-0002");
  const f = await invoices.finalizeInvoice(co, ...A, d.id);
  assert.equal(f.invoiceNumber, "INV-0003");
  assert.equal(f.draft, false);
  assert.ok(f.issuer, "issuer snapshot stored on finalize");
});

test("finalizing twice is rejected", async () => {
  const list = await invoices.listInvoices(co);
  const first = list.find((i) => i.invoiceNumber === "INV-0001");
  await assert.rejects(() => invoices.finalizeInvoice(co, ...A, first.id), /already published/);
});

test("prefix and next number come from settings; used numbers are skipped", async () => {
  await companies.updateCompanySettings(co, ...A, { invoicePrefix: "INV-", invoiceNextNumber: 2 });
  const next = await invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: item });
  assert.equal(next.invoiceNumber, "INV-0004", "INV-0002 and INV-0003 already exist");
  await companies.updateCompanySettings(co, ...A, { invoicePrefix: "EZ-2026-", invoiceNextNumber: 7 });
  const ez = await invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: item });
  assert.equal(ez.invoiceNumber, "EZ-2026-0007");
  const settings = await companies.getCompany(co);
  assert.equal(settings.invoiceNextNumber, 8);
});

test("parallel finalizes never share a number", async () => {
  const made = await Promise.all(
    Array.from({ length: 5 }, () => invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: item }))
  );
  const nums = made.map((m) => m.invoiceNumber);
  assert.equal(new Set(nums).size, nums.length);
});

test("finalizing requires a customer and a line", async () => {
  await assert.rejects(() => invoices.createInvoice(co, ...A, { finalize: true, items: item }), /customer/);
  await assert.rejects(() => invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: [] }), /line item/);
});

test("members cannot change numbering settings", async () => {
  await assert.rejects(() => companies.updateCompanySettings(co, "u2", "", "member", { invoiceNextNumber: 1 }), /owners and admins/);
});

test("quotes have their own sequence and convert once into a draft invoice", async () => {
  const q1 = await quotes.createQuote(co, ...A, { customerName: "Y", currency: "USD", items: item });
  const q2 = await quotes.createQuote(co, ...A, { customerName: "Y", items: item });
  assert.equal(q1.quoteNumber, "QUO-0001");
  assert.equal(q2.quoteNumber, "QUO-0002");
  const { invoice, quote } = await quotes.convertQuote(co, ...A, q1.id);
  assert.equal(invoice.draft, true);
  assert.equal(invoice.invoiceNumber, "");
  assert.equal(invoice.currency, "USD");
  assert.equal(invoice.total, 100);
  assert.equal(invoice.sourceQuoteId, q1.id);
  assert.equal(quote.status, "converted");
  assert.equal(quote.convertedInvoiceId, invoice.id);
  await assert.rejects(() => quotes.convertQuote(co, ...A, q1.id), /already converted/);
  await assert.rejects(() => quotes.updateQuote(co, ...A, q1.id, { notes: "x" }), /Converted/);
});

test("duplicate creates an unnumbered draft copy; void blocks edits", async () => {
  const src = (await invoices.listInvoices(co)).find((i) => i.invoiceNumber === "INV-0001");
  const dup = await invoices.duplicateInvoice(co, ...A, src.id);
  assert.equal(dup.draft, true);
  assert.equal(dup.invoiceNumber, "");
  assert.equal(dup.duplicatedFrom, src.id);
  assert.deepEqual(dup.items.map((i) => i.description), ["Work"]);
  const v = await invoices.voidInvoice(co, ...A, src.id, { reason: "test" });
  assert.equal(v.status, "void");
  assert.equal(v.outstanding, 0);
  await assert.rejects(() => invoices.updateInvoice(co, ...A, src.id, { notes: "x" }), /Void/);
});

test("VAT applies only when the company opts in", async () => {
  const plain = await invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: [{ description: "a", qty: 1, unitPrice: 1000 }] });
  assert.equal(plain.taxTotal, 0);
  assert.equal(plain.total, 1000);
  await companies.updateCompanySettings(co, ...A, { vatRegistered: true, vatRate: 15 });
  const vat = await invoices.createInvoice(co, ...A, { finalize: true, customerName: "X", items: [{ description: "a", qty: 1, unitPrice: 1000 }] });
  assert.equal(vat.taxTotal, 150);
  assert.equal(vat.total, 1150);
  await companies.updateCompanySettings(co, ...A, { vatRegistered: false });
});
