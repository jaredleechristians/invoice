const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

const fakeDb = setupFake();
const companies = require("../lib/companies");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");
const expenses = require("../lib/expenses");
const reports = require("../lib/reports");
const accounts = require("../lib/bankAccounts");
const bank = require("../lib/bankTransactions");
const parse = require("../lib/bankParse");

const OWNER = ["u1", "u1@example.com", "owner"];
const MEMBER = ["u2", "u2@example.com", "member"];

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>ZAR
<BANKACCTFROM><BANKID>051001<ACCTID>000123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20261101
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261103120000[+2:SAST]
<TRNAMT>36500.00
<FITID>SB-0001
<NAME>WISE PAYMENTS LTD
<MEMO>INV-0001 ACME
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261104
<TRNAMT>-149.00
<FITID>SB-0002
<NAME>AFRIHOST &amp; CO
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261105
<TRNAMT>-5000.00
<FITID>SB-0003
<NAME>TRANSFER TO SAVINGS
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>31351.00<DTASOF>20261105</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>
<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261102</DTPOSTED><TRNAMT>2000.00</TRNAMT><FITID>W1</FITID><NAME>Client</NAME></STMTTRN></BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

// ---------- parsing ----------

test("OFX SGML: lines, FITIDs, entities, currency and ledger balance", () => {
  const out = parse.parseOfx(OFX_SGML);
  assert.equal(out.transactions.length, 3);
  assert.deepEqual(out.transactions[0], { fitId: "SB-0001", date: "2026-11-03", amount: 36500, description: "WISE PAYMENTS LTD - INV-0001 ACME", reference: "", type: "CREDIT" });
  assert.equal(out.transactions[1].description, "AFRIHOST & CO");
  assert.equal(out.transactions[1].amount, -149);
  assert.equal(out.account.currency, "ZAR");
  assert.equal(out.account.accountLast4, "6789");
  assert.equal(out.account.ledgerBalance, 31351);
});

test("OFX XML (2.x) parses too", () => {
  const out = parse.parseOfx(OFX_XML);
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0].amount, 2000);
  assert.equal(out.account.currency, "USD");
});

test("amount and date parsing handle bank formats", () => {
  assert.equal(parse.parseBankAmount("-1 234,56"), -1234.56);
  assert.equal(parse.parseBankAmount("(12.00)"), -12);
  assert.equal(parse.parseBankAmount("R 1,250.00"), 1250);
  assert.equal(parse.parseBankAmount("99.00 DR"), -99);
  assert.ok(Number.isNaN(parse.parseBankAmount("")));
  assert.equal(parse.parseBankDate("03/11/2026"), "2026-11-03", "day-first by default");
  assert.equal(parse.parseBankDate("11/30/2026"), "2026-11-30");
  assert.equal(parse.parseBankDate("03/11/2026", "mdy"), "2026-03-11");
  assert.equal(parse.parseBankDate("3 Nov 2026"), "2026-11-03");
  assert.equal(parse.parseBankDate("31/02/2026"), "");
});

test("CSV: header guess, quotes, debit/credit columns and preamble rows", () => {
  const csv = 'Account,Business Cheque\r\n\r\nDate,Description,Reference,Debit,Credit\r\n2026/11/03,"WISE, PAYMENT",INV-0001,,"36,500.00"\r\n2026/11/04,AFRIHOST,,149.00,\r\n2026/11/05,"Say ""hi""",,0,\r\n';
  const rows = parse.parseCsvRows(csv);
  const guess = parse.guessMapping(rows);
  assert.equal(guess.headerRow, 1);
  assert.deepEqual([guess.date, guess.description, guess.reference, guess.debit, guess.credit, guess.amount], [0, 1, 2, 3, 4, -1]);
  const out = parse.mapCsv(rows, guess);
  assert.equal(out.transactions.length, 2);
  assert.equal(out.skipped, 1, "zero-amount row skipped");
  assert.deepEqual(out.transactions[0], { fitId: "", date: "2026-11-03", amount: 36500, description: "WISE, PAYMENT", reference: "INV-0001", type: "" });
  assert.equal(out.transactions[1].amount, -149);
});

test("CSV: single amount column, semicolons, explicit mapping and invert", () => {
  const csv = "Datum;Omskrywing;Bedrag\n01-11-2026;Fee;-12,50\n02-11-2026;Refund;100,00\n";
  const rows = parse.parseCsvRows(csv);
  assert.equal(parse.detectDelimiter(csv), ";");
  const out = parse.mapCsv(rows, { headerRow: 0, date: 0, description: 1, amount: 2 });
  assert.deepEqual(out.transactions.map((t) => [t.date, t.amount]), [["2026-11-01", -12.5], ["2026-11-02", 100]]);
  const inv = parse.mapCsv(rows, { headerRow: 0, date: 0, description: 1, amount: 2, invertAmount: true });
  assert.equal(inv.transactions[0].amount, 12.5);
  assert.throws(() => parse.mapCsv(rows, { headerRow: 0, date: -1, amount: 2 }), /date column/);
});

test("dedupe keys: FITID based, else hash with running index for identical rows", () => {
  const a = parse.dedupeKeys("acc1", [
    { fitId: "X1", date: "2026-11-01", amount: 1, description: "a" },
    { fitId: "", date: "2026-11-01", amount: -10, description: "Fee" },
    { fitId: "", date: "2026-11-01", amount: -10, description: "fee " },
  ]);
  assert.equal(a[0].dedupeKey, "fitid:X1");
  assert.notEqual(a[1].docId, a[2].docId, "identical rows get distinct keys");
  const again = parse.dedupeKeys("acc1", [{ fitId: "", date: "2026-11-01", amount: -10, description: "Fee" }]);
  assert.equal(again[0].docId, a[1].docId, "same row, same key on re-import");
  const other = parse.dedupeKeys("acc2", [{ fitId: "X1", date: "2026-11-01", amount: 1, description: "a" }]);
  assert.notEqual(other[0].docId, a[0].docId, "keys are per account");
});

test("computeForex: gain/loss vs invoice-date rate, flags when unknown", () => {
  const fx = bank.computeForex({ invoiceCurrency: "USD", amount: 2000, receivedCurrency: "ZAR", receivedAmount: 36500, invoiceRate: 18 });
  assert.equal(fx.zarAtInvoiceRate, 36000);
  assert.equal(fx.forexGainZar, 500);
  assert.equal(fx.receivedRate, 18.25);
  const loss = bank.computeForex({ invoiceCurrency: "USD", amount: 2000, receivedCurrency: "ZAR", receivedAmount: 35000, invoiceRate: 18 });
  assert.equal(loss.forexGainZar, -1000);
  assert.equal(bank.computeForex({ invoiceCurrency: "USD", amount: 2000, receivedCurrency: "ZAR", receivedAmount: 35000 }).forexFlag, "missing_invoice_rate");
  assert.equal(bank.computeForex({ invoiceCurrency: "EUR", amount: 10, receivedCurrency: "USD", receivedAmount: 11 }).forexFlag, "non_zar_account");
  const same = bank.computeForex({ invoiceCurrency: "ZAR", amount: 100, receivedCurrency: "ZAR", receivedAmount: 100 });
  assert.equal(same.forexGainZar, null);
  assert.equal(same.zarReceived, 100);
});

// ---------- flows ----------

let co;
let cheque;
let savings;

test.before(async () => {
  co = (await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Bank Co" })).id;
  cheque = await accounts.createAccount(co, ...OWNER, { name: "Business cheque", bank: "standard_bank", currency: "ZAR", accountLast4: "6789", openingBalance: 1000, openingDate: "2026-11-01" });
  savings = await accounts.createAccount(co, ...OWNER, { name: "Savings", bank: "standard_bank", currency: "ZAR" });
});

const lines = async (accountId) => bank.listTransactions(co, { accountId });

test("bank accounts: admin only to manage, members can list", async () => {
  await assert.rejects(() => accounts.createAccount(co, ...MEMBER, { name: "X" }), /Forbidden/);
  await assert.rejects(() => accounts.createAccount(co, ...OWNER, {}), /name is required/);
  const list = await accounts.listAccounts(co);
  assert.deepEqual(list.map((a) => a.name), ["Business cheque", "Savings"]);
});

test("import: preview counts new vs duplicate, commit stores lines and a batch record", async () => {
  const pre = await bank.previewImport(co, ...MEMBER, { accountId: cheque.id, content: OFX_SGML });
  assert.equal(pre.format, "ofx");
  assert.equal(pre.newCount, 3);
  assert.equal(pre.duplicateCount, 0);
  assert.deepEqual(pre.warnings, []);
  const res = await bank.commitImport(co, ...MEMBER, { accountId: cheque.id, content: OFX_SGML, filename: "nov.ofx" });
  assert.equal(res.import.importedCount, 3);
  const again = await bank.previewImport(co, ...MEMBER, { accountId: cheque.id, content: OFX_SGML });
  assert.equal(again.newCount, 0);
  assert.equal(again.duplicateCount, 3);
  const second = await bank.commitImport(co, ...MEMBER, { accountId: cheque.id, content: OFX_SGML });
  assert.equal(second.import.importedCount, 0);
  assert.equal((await lines(cheque.id)).length, 3);
  assert.equal((await bank.listImports(co)).length, 2);
  const usd = await bank.previewImport(co, ...MEMBER, { accountId: cheque.id, content: OFX_XML });
  assert.match(usd.warnings[0], /USD/);
  const [acc] = (await accounts.listAccounts(co)).filter((a) => a.id === cheque.id);
  assert.equal(acc.balance, 1000 + 36500 - 149 - 5000);
  assert.equal(acc.unreconciledCount, 3);
});

test("CSV import with mapping dedupes on re-import", async () => {
  const csv = "Date,Description,Amount\n2026-11-05,FROM CHEQUE,5000.00\n2026-11-06,Interest,1.20\n2026-11-06,Interest,1.20\n";
  const pre = await bank.previewImport(co, ...MEMBER, { accountId: savings.id, content: csv });
  assert.equal(pre.format, "csv");
  assert.deepEqual(pre.headers, ["Date", "Description", "Amount"]);
  assert.equal(pre.newCount, 3);
  await bank.commitImport(co, ...MEMBER, { accountId: savings.id, content: csv, mapping: pre.mapping });
  const again = await bank.previewImport(co, ...MEMBER, { accountId: savings.id, content: csv, mapping: pre.mapping });
  assert.equal(again.duplicateCount, 3);
});

test("money in: match a USD invoice from a ZAR account records ZAR received and forex gain", async () => {
  const inv = await invoices.createInvoice(co, ...OWNER, { finalize: true, customerName: "Acme", currency: "USD", exchangeRate: 18, items: [{ description: "Sprint", qty: 1, unitPrice: 2000 }] });
  const tx = (await lines(cheque.id)).find((t) => t.amount === 36500);
  const sug = await bank.suggestions(co, tx.id);
  assert.equal(sug.invoices[0].id, inv.id, "invoice number + customer in the description ranks it first");
  await assert.rejects(() => bank.reconcile(co, ...MEMBER, tx.id, { action: "match_invoice", invoiceId: inv.id }), /USD amount/);
  assert.equal((await lines(cheque.id)).find((t) => t.id === tx.id).status, "unreconciled", "failed reconcile releases the line");
  const res = await bank.reconcile(co, ...MEMBER, tx.id, { action: "match_invoice", invoiceId: inv.id, amount: 2000, invoiceRate: 18 });
  assert.equal(res.transaction.status, "matched");
  assert.equal(res.payment.amount, 2000);
  assert.equal(res.payment.currency, "USD");
  assert.equal(res.payment.zarReceived, 36500);
  assert.equal(res.payment.forexGainZar, 500);
  assert.equal(res.payment.transactionId, tx.id);
  assert.equal((await invoices.getInvoice(co, inv.id)).exchangeRate, 18, "rate saved on the invoice");
  assert.equal((await invoices.getInvoice(co, inv.id)).status, "paid");
  await assert.rejects(() => bank.reconcile(co, ...MEMBER, tx.id, { action: "ignore" }), /already reconciled/);

  // Undo must ask about the payment it created; members cannot delete it.
  await assert.rejects(() => bank.undo(co, ...MEMBER, tx.id, {}), /deleteCreated/);
  await assert.rejects(() => bank.undo(co, ...MEMBER, tx.id, { deleteCreated: true }), /Only admins/);
  const kept = await bank.undo(co, ...MEMBER, tx.id, { deleteCreated: false });
  assert.equal(kept.deleted, null);
  const pay = (await payments.listPayments(co, { invoiceId: inv.id }))[0];
  assert.equal(pay.transactionId, "", "payment kept but unlinked");
  assert.equal(pay.forexGainZar, null);

  // Match the existing (now unlinked) payment instead.
  const sug2 = await bank.suggestions(co, tx.id);
  assert.equal(sug2.payments[0].id, pay.id);
  const m = await bank.reconcile(co, ...MEMBER, tx.id, { action: "match_payment", paymentId: pay.id });
  assert.equal(m.forex.forexGainZar, 500, "uses the rate stored on the invoice");
  assert.equal(m.transaction.created, null);
  await bank.undo(co, ...MEMBER, tx.id, {});

  // Re-match creating a payment, then undo deleting it (admin).
  await payments.deletePayment(co, ...OWNER, pay.id);
  await bank.reconcile(co, ...MEMBER, tx.id, { action: "match_invoice", invoiceId: inv.id, amount: 2000 });
  const del = await bank.undo(co, ...OWNER, tx.id, { deleteCreated: true });
  assert.equal(del.deleted.type, "payment");
  assert.equal((await payments.listPayments(co, { invoiceId: inv.id })).length, 0);
  assert.equal((await invoices.getInvoice(co, inv.id)).status, "unpaid");
});

test("a foreign-currency invoice cannot be published without an exchange rate", async () => {
  await assert.rejects(
    () => invoices.createInvoice(co, ...OWNER, { finalize: true, customerName: "NoRate", currency: "USD", items: [{ description: "x", qty: 1, unitPrice: 2000 }] }),
    /exchange rate is required/
  );
  const draft = await invoices.createInvoice(co, ...OWNER, { draft: true, customerName: "NoRate", currency: "USD", items: [{ description: "x", qty: 1, unitPrice: 2000 }] });
  await assert.rejects(() => invoices.finalizeInvoice(co, ...OWNER, draft.id), /exchange rate is required/);
  assert.equal((await invoices.requireInvoice(co, draft.id)).draft, true);
});

test("money out: create expense, undo keeps or deletes it, match existing expense", async () => {
  const tx = (await lines(cheque.id)).find((t) => t.amount === -149);
  const cats = await expenses.listCategories(co);
  const hosting = cats.find((c) => c.name === "Hosting & domains");
  await assert.rejects(() => bank.reconcile(co, ...MEMBER, tx.id, { action: "match_invoice", invoiceId: "x" }), /Only money in/);
  const res = await bank.reconcile(co, ...MEMBER, tx.id, { action: "create_expense", categoryId: hosting.id, vendor: "Afrihost" });
  assert.equal(res.transaction.status, "categorised");
  assert.equal(res.expense.amount, 149);
  assert.equal(res.expense.currency, "ZAR");
  assert.equal(res.expense.date, "2026-11-04");
  assert.equal(res.expense.categoryName, "Hosting & domains");
  await bank.undo(co, ...MEMBER, tx.id, { deleteCreated: false });
  const exp = (await expenses.listExpenses(co)).find((e) => e.id === res.expense.id);
  assert.equal(exp.transactionId, "");
  const sug = await bank.suggestions(co, tx.id);
  assert.equal(sug.expenses[0].id, exp.id);
  await bank.reconcile(co, ...MEMBER, tx.id, { action: "match_expense", expenseId: exp.id });
  await bank.undo(co, ...MEMBER, tx.id, {});
  await bank.reconcile(co, ...MEMBER, tx.id, { action: "create_expense", vendor: "Afrihost" });
  const before = (await expenses.listExpenses(co)).length;
  await bank.undo(co, ...OWNER, tx.id, { deleteCreated: true });
  assert.equal((await expenses.listExpenses(co)).length, before - 1);
  // Deleting a linked expense elsewhere releases the line.
  const again = await bank.reconcile(co, ...MEMBER, tx.id, { action: "create_expense", vendor: "Afrihost" });
  await expenses.deleteExpense(co, ...OWNER, again.expense.id);
  assert.equal((await lines(cheque.id)).find((t) => t.id === tx.id).status, "unreconciled");
});

test("transfer pairs both sides, is not income, and undo unpairs both", async () => {
  const out = (await lines(cheque.id)).find((t) => t.amount === -5000);
  const into = (await lines(savings.id)).find((t) => t.amount === 5000);
  const sug = await bank.suggestions(co, out.id);
  assert.equal(sug.transfers[0].id, into.id);
  await assert.rejects(() => bank.reconcile(co, ...MEMBER, out.id, { action: "transfer", pairTransactionId: out.id }), /another account/);
  const res = await bank.reconcile(co, ...MEMBER, out.id, { action: "transfer", pairTransactionId: into.id });
  assert.equal(res.transaction.status, "transfer");
  assert.equal(res.pair.transferPairId, out.id);
  assert.equal((await lines(savings.id)).find((t) => t.id === into.id).status, "transfer");
  await assert.rejects(() => bank.reconcile(co, ...MEMBER, into.id, { action: "ignore" }), /already reconciled/);
  const rep = await reports.companyReports(co, { from: "2026-11-01", to: "2026-11-30" });
  assert.ok(!JSON.stringify(rep).includes("5000"), "transfers never reach reports");
  await bank.undo(co, ...MEMBER, into.id, {});
  assert.equal((await lines(cheque.id)).find((t) => t.id === out.id).status, "unreconciled");
  assert.equal((await lines(savings.id)).find((t) => t.id === into.id).status, "unreconciled");
});

test("ignore, filters, and deleting an import", async () => {
  const interest = (await lines(savings.id)).filter((t) => t.amount === 1.2);
  await bank.reconcile(co, ...MEMBER, interest[0].id, { action: "ignore", note: "tiny" });
  assert.equal((await bank.listTransactions(co, { status: "ignored" })).length, 1);
  assert.equal((await bank.listTransactions(co, { q: "interest" })).length, 2);
  assert.equal((await bank.listTransactions(co, { from: "2026-11-06", to: "2026-11-06" })).length, 2);
  const imp = (await bank.listImports(co, { accountId: savings.id }))[0];
  await assert.rejects(() => bank.deleteImport(co, ...OWNER, imp.id), /Undo the reconciled/);
  await bank.undo(co, ...MEMBER, interest[0].id, {});
  await assert.rejects(() => bank.deleteImport(co, ...MEMBER, imp.id), /Forbidden/);
  const res = await bank.deleteImport(co, ...OWNER, imp.id);
  assert.equal(res.deleted, 3);
  await assert.rejects(() => accounts.deleteAccount(co, ...OWNER, cheque.id), /has transactions/);
  await accounts.deleteAccount(co, ...OWNER, savings.id);
});

test("bank list: SA banks alphabetical, Wise/PayPal/Other last; legacy values map to stable keys", async () => {
  const labels = accounts.BANK_OPTIONS.map((b) => b.label);
  const tail = labels.slice(-3);
  assert.deepEqual(tail, ["Wise", "PayPal", "Other"]);
  const sa = labels.slice(0, -3);
  assert.deepEqual(sa, [...sa].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
  assert.equal(new Set(accounts.BANKS).size, accounts.BANKS.length, "keys are unique");
  for (const k of ["absa", "fnb", "capitec_business", "tymebank", "standard_bank", "paypal"]) assert.ok(accounts.BANKS.includes(k));
  assert.equal(accounts.normalizeBank("standard-bank"), "standard_bank");
  assert.equal(accounts.normalizeBank("Standard Bank"), "standard_bank");
  assert.equal(accounts.normalizeBank("mercantile"), "capitec_business");
  assert.equal(accounts.normalizeBank("nope"), "other");
  const a = await accounts.createAccount(co, ...OWNER, { name: "FNB biz", bank: "fnb", currency: "ZAR" });
  assert.equal(a.bank, "fnb");
  await accounts.deleteAccount(co, ...OWNER, a.id);
});

test("migration is idempotent even if the done flag is lost, and skips empty rows", async () => {
  const c2 = (await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Legacy Co" })).id;
  await fakeDb.doc(`companies/${c2}`).set({ bankAccounts: [{ label: "Main", currency: "ZAR", details: "Bank: Standard Bank\nAccount number: 123456789" }, { label: "", details: "" }, { label: "No id", details: "Pay via EFT" }] }, { merge: true });
  assert.equal(await accounts.migrateLegacyAccounts(c2), 2);
  await fakeDb.doc(`companies/${c2}`).set({ bankAccountsMigratedAt: null }, { merge: true });
  assert.equal(await accounts.migrateLegacyAccounts(c2), 0, "fixed ids: no duplicates");
  const list = await accounts.listAccounts(c2);
  assert.equal(list.length, 2);
  assert.equal(list.find((a) => a.name === "Main").bank, "standard_bank");
});

test("payment details: text from fields, matching currency first, hidden accounts left out", async () => {
  const { issuerSnapshot } = require("../lib/documents");
  assert.equal(
    accounts.paymentDetailsText({ bank: "fnb", accountHolder: "Robot Web", accountNumber: "62000000000", branchCode: "250655", swift: "FIRNZAJJ", details: "Use the invoice number" }),
    "Bank: FNB (First National Bank)\nAccount name: Robot Web\nAccount number: 62000000000\nBranch code: 250655\nSWIFT: FIRNZAJJ\nUse the invoice number"
  );
  const c3 = (await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Pay Co" })).id;
  await accounts.createAccount(c3, ...OWNER, { name: "ZAR cheque", bank: "fnb", currency: "ZAR", accountNumber: "1111" });
  await accounts.createAccount(c3, ...OWNER, { name: "USD Wise", bank: "wise", currency: "USD", accountNumber: "2222" });
  await accounts.createAccount(c3, ...OWNER, { name: "Savings", bank: "fnb", currency: "ZAR", showOnInvoices: false });
  const company = await invoices.loadCompany(c3);
  assert.deepEqual(company.bankAccounts.map((a) => a.label), ["USD Wise", "ZAR cheque"], "hidden accounts are not payment details");
  assert.deepEqual(issuerSnapshot(company, "USD").bankAccounts.map((a) => a.label), ["USD Wise"]);
  assert.deepEqual(issuerSnapshot(company, "ZAR").bankAccounts.map((a) => a.label), ["ZAR cheque"]);
  assert.deepEqual(issuerSnapshot(company, "EUR").bankAccounts.map((a) => a.label), ["USD Wise", "ZAR cheque"], "no match: show all");
  const got = await accounts.getAccount(c3, (await accounts.listAccounts(c3)).find((a) => a.name === "ZAR cheque").id);
  assert.equal(got.accountLast4, "1111", "last 4 derived from the account number");
});
