const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

const db = setupFake();
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const products = require("../lib/products");
const invoices = require("../lib/invoices");
const quotes = require("../lib/quotes");
const payments = require("../lib/payments");
const expenses = require("../lib/expenses");
const reports = require("../lib/reports");
const accounts = require("../lib/bankAccounts");
const bank = require("../lib/bankTransactions");
const { buildStatement } = require("../lib/statements");
const { listReceivables } = require("../lib/receivables");
const { runTool } = require("../lib/tenantAssistant");
const { restoreRecord } = require("../lib/restore");

const OWNER = ["d1", "d1@example.com", "owner"];
const raw = async (co, col, id) => (await db.collection("companies").doc(co).collection(col).doc(id).get()).data();
const RANGE = { from: "2026-01-01", to: "2026-12-31" };

let co;
let acme;
let inv;
let pay;

test.before(async () => {
  co = (await companies.createCompany({ uid: "d1", email: "d1@example.com", name: "Soft Co" })).id;
  acme = await customers.createCustomer(co, ...OWNER, { name: "Acme" });
  inv = await invoices.createInvoice(co, ...OWNER, { finalize: true, customerId: acme.id, issueDate: "2026-10-01", dueDate: "2026-10-31", items: [{ description: "Dev", qty: 1, unitPrice: 1000 }] });
  pay = (await payments.recordPayment(co, ...OWNER, { invoiceId: inv.id, amount: 600, paidAt: "2026-10-10" })).payment;
});

test("deleted payment is kept but excluded from balances, lists, reports, statements, receivables and the assistant", async () => {
  await payments.deletePayment(co, ...OWNER, pay.id);
  const doc = await raw(co, "payments", pay.id);
  assert.ok(doc.deletedAt, "document kept with deletedAt");
  assert.equal(doc.deletedBy, "d1");
  assert.equal((await invoices.requireInvoice(co, inv.id)).outstanding, 1000);
  assert.equal((await payments.listPayments(co)).length, 0);
  const r = await reports.companyReports(co, RANGE);
  assert.equal(r.profitAndLoss.ZAR?.income ?? 0, 0);
  const st = await buildStatement(co, acme.id, RANGE);
  assert.equal(st.ledger.ZAR.paid, 0);
  assert.equal(st.ledger.ZAR.closing, 1000);
  assert.equal((await listReceivables(co))[0].outstanding, 1000);
  assert.equal((await runTool(co, "who_owes_money", {})).receivables[0].outstanding, 1000);
  await assert.rejects(() => payments.deletePayment(co, ...OWNER, pay.id), /not found/i);
  const logs = (await db.collection("companies").doc(co).collection("auditLog").get()).docs.map((d) => d.data().action);
  assert.ok(logs.includes("payment.delete"));

  // Restore brings it back everywhere.
  assert.deepEqual(await restoreRecord(co, ...OWNER, "payment", pay.id), { id: pay.id, restored: true });
  assert.equal((await invoices.requireInvoice(co, inv.id)).outstanding, 400);
  assert.equal((await listReceivables(co))[0].outstanding, 400);
});

test("deleted invoices, quotes, customers, products and expenses 404 and vanish from lists and reports; numbers are not reused", async () => {
  const doomed = await invoices.createInvoice(co, ...OWNER, { finalize: true, customerId: acme.id, issueDate: "2026-10-02", items: [{ description: "x", qty: 1, unitPrice: 50 }] });
  await invoices.deleteInvoice(co, ...OWNER, doomed.id);
  assert.ok((await raw(co, "invoices", doomed.id)).deletedAt);
  await assert.rejects(() => invoices.requireInvoice(co, doomed.id), /not found/i);
  assert.ok(!(await invoices.listInvoices(co)).some((i) => i.id === doomed.id));
  assert.equal((await reports.companyReports(co, RANGE)).outstandingInvoices.length, 1);
  const next = await invoices.createInvoice(co, ...OWNER, { finalize: true, customerId: acme.id, items: [{ description: "y", qty: 1, unitPrice: 10 }] });
  assert.notEqual(next.invoiceNumber, doomed.invoiceNumber, "deleted number stays used");

  const q = await quotes.createQuote(co, ...OWNER, { customerId: acme.id, items: [{ description: "q", qty: 1, unitPrice: 5 }] });
  await quotes.deleteQuote(co, ...OWNER, q.id);
  await assert.rejects(() => quotes.requireQuote(co, q.id), /not found/i);
  assert.equal((await quotes.listQuotes(co)).length, 0);

  const beta = await customers.createCustomer(co, ...OWNER, { name: "Beta" });
  await customers.deleteCustomer(co, ...OWNER, beta.id);
  assert.equal(await customers.getCustomer(co, beta.id), null);
  assert.deepEqual((await customers.listCustomers(co)).map((c) => c.name), ["Acme"]);
  await assert.rejects(() => buildStatement(co, beta.id, RANGE), /not found/i);

  const prod = await products.createProduct(co, ...OWNER, { name: "Hosting", unitPrice: 150 });
  await products.deleteProduct(co, ...OWNER, prod.id);
  assert.equal((await products.listProducts(co, { includeInactive: true })).length, 0);

  const exp = await expenses.createExpense(co, ...OWNER, { date: "2026-10-05", amount: 99, currency: "ZAR", vendor: "Fuel" });
  assert.equal((await reports.companyReports(co, RANGE)).profitAndLoss.ZAR.expenses, 99);
  await expenses.deleteExpense(co, ...OWNER, exp.id);
  await assert.rejects(() => expenses.getExpense(co, exp.id), /not found/i);
  assert.equal((await expenses.listExpenses(co)).length, 0);
  assert.equal((await reports.companyReports(co, RANGE)).profitAndLoss.ZAR?.expenses ?? 0, 0);
  assert.ok((await raw(co, "expenses", exp.id)).deletedAt);
});

test("bank: deleting a linked expense frees its line; deleted imports hide lines and can be imported again", async () => {
  const acct = await accounts.createAccount(co, ...OWNER, { name: "Cheque", bank: "fnb", currency: "ZAR" });
  const csv = "Date,Description,Amount\n2026-11-05,FUEL,-300.00\n2026-11-06,CLIENT,250.00\n";
  const pre = await bank.previewImport(co, ...OWNER, { accountId: acct.id, content: csv });
  const imp = await bank.commitImport(co, ...OWNER, { accountId: acct.id, content: csv, mapping: pre.mapping });
  let lines = await bank.listTransactions(co, { accountId: acct.id });
  const fuel = lines.find((t) => t.amount < 0);
  const r = await bank.reconcile(co, ...OWNER, fuel.id, { action: "create_expense" });
  const expenseId = r.transaction?.expenseId || (await bank.listTransactions(co)).find((t) => t.id === fuel.id).expenseId;
  await assert.rejects(() => bank.deleteImport(co, ...OWNER, imp.import.id), /reconciled/);
  await expenses.deleteExpense(co, ...OWNER, expenseId);
  assert.equal((await bank.listTransactions(co)).find((t) => t.id === fuel.id).status, "unreconciled");

  await bank.deleteImport(co, ...OWNER, imp.import.id);
  assert.equal((await bank.listTransactions(co, { accountId: acct.id })).length, 0);
  assert.equal((await bank.listImports(co)).length, 0);
  assert.equal((await accounts.listAccounts(co)).find((a) => a.id === acct.id).balance, 0);
  const again = await bank.previewImport(co, ...OWNER, { accountId: acct.id, content: csv, mapping: pre.mapping });
  assert.equal(again.newCount, 2, "deleted lines don't count as duplicates");
  await bank.commitImport(co, ...OWNER, { accountId: acct.id, content: csv, mapping: pre.mapping });
  lines = await bank.listTransactions(co, { accountId: acct.id });
  assert.equal(lines.length, 2);
  assert.ok(lines.every((t) => !t.deletedAt));
});

test("deleted bank accounts drop off invoice payment details", async () => {
  const acct = await accounts.createAccount(co, ...OWNER, { name: "Wise USD", bank: "wise", currency: "USD", accountNumber: "999" });
  assert.ok((await invoices.loadCompany(co)).bankAccounts.some((a) => a.label === "Wise USD"));
  await accounts.deleteAccount(co, ...OWNER, acct.id);
  assert.ok(!(await invoices.loadCompany(co)).bankAccounts.some((a) => a.label === "Wise USD"));
  await assert.rejects(() => accounts.getAccount(co, acct.id), /not found/i);
  await restoreRecord(co, ...OWNER, "bankAccount", acct.id);
  assert.equal((await accounts.getAccount(co, acct.id)).name, "Wise USD");
  await assert.rejects(() => restoreRecord(co, "m1", "m@x", "member", "invoice", inv.id), /Forbidden/);
});
