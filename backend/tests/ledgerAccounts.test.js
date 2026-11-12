const test = require("node:test");
const assert = require("node:assert/strict");
const { setupFake } = require("./helpers/setup");

const fakeDb = setupFake();
const companies = require("../lib/companies");
const ledger = require("../lib/ledger/accounts");
const products = require("../lib/products");
const expenses = require("../lib/expenses");
const bankAccounts = require("../lib/bankAccounts");
const { restoreRecord } = require("../lib/restore");
const { checkApiKeyRequest } = require("../lib/apiKeyScope");

const OWNER = ["u1", "u1@example.com", "owner"];
const MEMBER = ["u2", "u2@example.com", "member"];

let co;
const accountDocs = (companyId) => fakeDb.dump(`companies/${companyId}/accounts/`);

test.before(async () => {
  co = (await companies.createCompany({ uid: "u1", email: "u1@example.com", name: "Ledger Co" })).id;
  await fakeDb.collection("companies").doc(co).collection("members").doc("u2").set({ userId: "u2", role: "member", joinedAt: new Date().toISOString() });
});

// ---------- template ----------

test("new company gets the SA template with system accounts", async () => {
  const rows = await ledger.listLedgerAccounts(co);
  assert.equal(rows.length, ledger.TEMPLATE.length);
  const byKey = Object.fromEntries(rows.filter((r) => r.systemKey).map((r) => [r.systemKey, r]));
  for (const key of ["debtors", "creditors", "vat", "fx", "retained_earnings", "opening_balance_equity", "undeposited_funds", "expense_clearing", "transfers_in_transit", "default_income", "default_expense"]) {
    assert.ok(byKey[key], `missing ${key}`);
    assert.equal(byKey[key].system, true);
  }
  assert.equal(byKey.debtors.code, "1100");
  assert.equal(byKey.expense_clearing.code, "2050");
  assert.equal(byKey.expense_clearing.name, "Expenses awaiting bank match");
  assert.equal(byKey.fx.code, "4900");
  assert.equal(byKey.fx.type, "income");
  assert.ok(rows.every((r) => /^\d{4}$/.test(r.code)));
  // Ordered by type, then code.
  assert.deepEqual([...new Set(rows.map((r) => r.type))], ["asset", "liability", "equity", "income", "expense"]);
  const company = (await fakeDb.collection("companies").doc(co).get()).data();
  assert.equal(company.ledger.chartVersion, ledger.CHART_VERSION);
  assert.equal(company.ledger.systemAccounts.debtors, "debtors");
});

test("seeding is idempotent and keeps edits", async () => {
  await ledger.updateLedgerAccount(co, ...OWNER, "debtors", { name: "Debtors control" });
  const before = accountDocs(co).length;
  await ledger.ensureChart(co, { linkBanks: true });
  await ledger.ensureChart(co);
  assert.equal(accountDocs(co).length, before);
  assert.equal((await ledger.getLedgerAccount(co, "debtors")).name, "Debtors control");
});

test("existing companies (from before 1.4.0) are seeded on first use", async () => {
  const old = "oldco";
  await fakeDb.collection("companies").doc(old).set({ name: "Old Co", defaultCurrency: "ZAR" });
  await fakeDb.collection("companies").doc(old).collection("bankAccounts").doc("b1").set({ name: "FNB Cheque", currency: "ZAR" });
  await fakeDb.collection("companies").doc(old).collection("bankAccounts").doc("b2").set({ name: "Gone", currency: "ZAR", deletedAt: "2026-01-01" });
  const rows = await ledger.listLedgerAccounts(old);
  assert.equal(rows.length, ledger.TEMPLATE.length + 1);
  const bank = rows.find((r) => r.bankAccountId === "b1");
  assert.equal(bank.code, "1001");
  assert.equal(bank.subtype, "bank");
  assert.ok(!rows.some((r) => r.bankAccountId === "b2"));
});

// ---------- editing ----------

test("non-system accounts: add, edit, archive, unarchive", async () => {
  await assert.rejects(() => ledger.createLedgerAccount(co, ...MEMBER, { code: "5960", name: "X", type: "expense" }), /Forbidden/);
  await assert.rejects(() => ledger.createLedgerAccount(co, ...OWNER, { code: "59", name: "X", type: "expense" }), /4 digits/);
  await assert.rejects(() => ledger.createLedgerAccount(co, ...OWNER, { code: "1050", name: "X", type: "asset" }), /reserved for bank/);
  await assert.rejects(() => ledger.createLedgerAccount(co, ...OWNER, { code: "5100", name: "X", type: "expense" }), /already used by Contractors/);
  await assert.rejects(() => ledger.createLedgerAccount(co, ...OWNER, { code: "5960", name: "X", type: "nope" }), /Type must be/);
  await assert.rejects(() => ledger.createLedgerAccount(co, ...OWNER, { code: "5960", name: "X", type: "expense", subtype: "vat" }), /Subtype/);

  const a = await ledger.createLedgerAccount(co, ...OWNER, { code: "5960", name: "Training", type: "expense" });
  assert.equal(a.subtype, "operating_expense");
  assert.equal(a.system, false);
  const edited = await ledger.updateLedgerAccount(co, ...OWNER, a.id, { name: "Training & courses", type: "asset", code: "1250" });
  assert.equal(edited.type, "asset");
  assert.equal(edited.subtype, "current_asset");
  assert.equal(edited.code, "1250");
  const archived = await ledger.archiveLedgerAccount(co, ...OWNER, a.id);
  assert.equal(archived.active, false);
  assert.ok(!(await ledger.listLedgerAccounts(co, { includeArchived: false })).some((r) => r.id === a.id));
  assert.equal((await ledger.unarchiveLedgerAccount(co, ...OWNER, a.id)).active, true);
});

test("system accounts are protected", async () => {
  await assert.rejects(() => ledger.archiveLedgerAccount(co, ...OWNER, "vat"), /can't be archived/);
  await assert.rejects(() => ledger.updateLedgerAccount(co, ...OWNER, "vat", { type: "asset" }), /can't change type/);
  await assert.rejects(() => ledger.updateLedgerAccount(co, ...MEMBER, "vat", { name: "VAT" }), /Forbidden/);
  const renamed = await ledger.updateLedgerAccount(co, ...OWNER, "vat", { name: "VAT payable", code: "2110" });
  assert.equal(renamed.code, "2110");
  assert.equal(renamed.systemKey, "vat");
});

test("an account with posted entries can't change type", async () => {
  const a = await ledger.createLedgerAccount(co, ...OWNER, { code: "4300", name: "Commission", type: "income" });
  await fakeDb.collection("companies").doc(co).collection("journals").doc("j-test").set({ accountIds: [a.id] });
  await assert.rejects(() => ledger.updateLedgerAccount(co, ...OWNER, a.id, { type: "expense" }), /has entries/);
  await fakeDb.collection("companies").doc(co).collection("journals").doc("j-test").delete();
});

// ---------- bank accounts ----------

test("Settings bank accounts get linked ledger accounts", async () => {
  const wise = await bankAccounts.createAccount(co, ...OWNER, { name: "Wise USD", bank: "wise", currency: "USD" });
  let led = await ledger.getLedgerAccount(co, ledger.bankLedgerId(wise.id));
  assert.equal(led.currency, "USD");
  assert.equal(led.code, "1001");
  assert.equal(led.bank, true);
  await assert.rejects(() => ledger.archiveLedgerAccount(co, ...OWNER, led.id), /Bank accounts/);
  await assert.rejects(() => ledger.updateLedgerAccount(co, ...OWNER, led.id, { name: "Other" }), /Rename bank accounts/);
  await assert.rejects(() => ledger.updateLedgerAccount(co, ...OWNER, led.id, { code: "1200" }), /1001 and 1099/);

  await bankAccounts.updateAccount(co, ...OWNER, wise.id, { name: "Wise US dollar" });
  led = await ledger.getLedgerAccount(co, led.id);
  assert.equal(led.name, "Wise US dollar");

  const fnb = await bankAccounts.createAccount(co, ...OWNER, { name: "FNB Cheque", bank: "fnb", currency: "ZAR" });
  assert.equal((await ledger.getLedgerAccount(co, ledger.bankLedgerId(fnb.id))).code, "1002");

  await bankAccounts.deleteAccount(co, ...OWNER, wise.id);
  assert.equal((await ledger.getLedgerAccount(co, led.id)).active, false);
  await restoreRecord(co, ...OWNER, "bankAccount", wise.id);
  assert.equal((await ledger.getLedgerAccount(co, led.id)).active, true);
});

// ---------- mapping ----------

test("products map to income accounts, defaulting by kind", async () => {
  const svc = await products.createProduct(co, ...MEMBER, { name: "Consulting", unitPrice: 1000 });
  assert.equal(svc.incomeAccountId, "default_income");
  const prod = await products.createProduct(co, ...MEMBER, { name: "Router", unitPrice: 900, kind: "product" });
  assert.equal(prod.incomeAccountId, "t4100");
  await assert.rejects(() => products.createProduct(co, ...MEMBER, { name: "X", incomeAccountId: "t5100" }), /income account/);
  await assert.rejects(() => products.createProduct(co, ...MEMBER, { name: "X", incomeAccountId: "nope" }), /not found/);

  const mapped = await products.updateProduct(co, ...MEMBER, svc.id, { incomeAccountId: "t4800" });
  assert.equal(mapped.incomeAccountId, "t4800");
  assert.equal((await products.updateProduct(co, ...MEMBER, svc.id, { unitPrice: 1200 })).incomeAccountId, "t4800");
  // Mapped accounts can't be archived.
  await assert.rejects(() => ledger.archiveLedgerAccount(co, ...OWNER, "t4800"), /Used by 1 product/);
  // Changing kind without an account moves to the new kind's default.
  assert.equal((await products.updateProduct(co, ...MEMBER, prod.id, { kind: "service" })).incomeAccountId, "default_income");

  // Products from before 1.4.0 show the default.
  await fakeDb.collection("companies").doc(co).collection("products").doc("legacy").set({ name: "Legacy", kind: "product", active: true });
  const listed = await products.listProducts(co);
  assert.equal(listed.find((p) => p.id === "legacy").incomeAccountId, "t4100");
});

test("expense categories map to expense accounts, defaulting by name", async () => {
  const cats = await expenses.listCategories(co);
  const byName = Object.fromEntries(cats.map((c) => [c.name, c]));
  assert.equal(byName["Bank charges"].accountId, "t5050");
  assert.equal(byName["Hosting & domains"].accountId, "t5200");
  assert.equal(byName.Other.accountId, "default_expense");

  const fuel = await expenses.createCategory(co, ...MEMBER, { name: "Fuel" });
  assert.equal(fuel.accountId, "default_expense");
  await assert.rejects(() => expenses.createCategory(co, ...MEMBER, { name: "Bad", accountId: "default_income" }), /expense account/);
  const remapped = await expenses.updateCategory(co, ...OWNER, fuel.id, { accountId: "t5450" });
  assert.equal(remapped.accountId, "t5450");
  assert.equal(remapped.name, "Fuel");
  await assert.rejects(() => expenses.updateCategory(co, ...MEMBER, fuel.id, { accountId: "t5000" }), /Forbidden/);
  await assert.rejects(() => ledger.archiveLedgerAccount(co, ...OWNER, "t5450"), /Used by 2 expense categories/);
});

// ---------- base currency ----------

test("base currency defaults to ZAR, can change, and locks once journals exist", async () => {
  let c = await companies.getCompany(co);
  assert.equal(c.baseCurrency, "ZAR");
  assert.equal(c.baseCurrencyLocked, false);
  assert.equal(c.defaultCurrency, "ZAR");
  await assert.rejects(() => companies.updateCompanySettings(co, ...OWNER, { baseCurrency: "XYZ" }), /Base currency must be/);
  c = await companies.updateCompanySettings(co, ...OWNER, { baseCurrency: "USD" });
  assert.equal(c.baseCurrency, "USD");
  assert.equal(c.defaultCurrency, "ZAR");

  await fakeDb.collection("companies").doc(co).collection("journals").doc("j1").set({ accountIds: ["debtors"] });
  c = await companies.getCompany(co);
  assert.equal(c.baseCurrencyLocked, true);
  await assert.rejects(() => companies.updateCompanySettings(co, ...OWNER, { baseCurrency: "ZAR" }), /can't change once the ledger has entries/);
  // Saving the same value (the whole settings form) is fine.
  c = await companies.updateCompanySettings(co, ...OWNER, { baseCurrency: "USD", name: "Ledger Co Ltd" });
  assert.equal(c.name, "Ledger Co Ltd");
  await fakeDb.collection("companies").doc(co).collection("journals").doc("j1").delete();
});

// ---------- API keys ----------

test("API keys can read the chart but not change it", () => {
  const req = (method, path, scope = "read_write") => ({ method, path, apiKey: { id: "k", scope }, body: {} });
  assert.doesNotThrow(() => checkApiKeyRequest(req("GET", "/accounts", "read")));
  assert.throws(() => checkApiKeyRequest(req("POST", "/accounts")), /chart of accounts/);
  assert.throws(() => checkApiKeyRequest(req("PATCH", "/accounts/vat")), /chart of accounts/);
  assert.throws(() => checkApiKeyRequest(req("POST", "/accounts/t5000/archive")), /chart of accounts/);
});
