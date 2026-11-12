const test = require("node:test");
const assert = require("node:assert/strict");
const { invoiceLines, paymentLines, expenseLines, toBaseCents, swapLines } = require("../lib/ledger/rules");

const SYS = {
  debtors: "debtors",
  vat: "vat",
  default_income: "default_income",
  undeposited_funds: "undeposited_funds",
  expense_clearing: "expense_clearing",
  default_expense: "default_expense",
  fx: "fx",
};
const zar = { systemAccounts: SYS, baseCurrency: "ZAR" };

function sum(lines, side) {
  return lines.reduce((s, l) => s + l[side], 0);
}

test("ZAR invoice with 15% VAT balances and maps income and VAT", () => {
  const lines = invoiceLines(
    {
      invoiceNumber: "INV-0001",
      currency: "ZAR",
      total: 1150,
      subtotal: 1000,
      taxTotal: 150,
      vatRate: 15,
      customerId: "c1",
      items: [{ description: "Dev", qty: 1, unitPrice: 1000, accountId: "default_income", taxable: true }],
    },
    zar
  );
  assert.equal(sum(lines, "debit"), sum(lines, "credit"));
  assert.equal(sum(lines, "debit"), 115000);
  const by = Object.fromEntries(lines.map((l) => [l.accountId, l]));
  assert.equal(by.debtors.debit, 115000);
  assert.equal(by.debtors.customerId, "c1");
  assert.equal(by.debtors.foreignAmount, 115000);
  assert.equal(by.default_income.credit, 100000);
  assert.equal(by.vat.credit, 15000);
});

test("rounding residual goes to the largest income line", () => {
  const lines = invoiceLines(
    {
      currency: "USD",
      exchangeRate: 18.17,
      total: 66.67,
      subtotal: 66.67,
      taxTotal: 0,
      items: [
        { description: "A", qty: 1, unitPrice: 33.33, accountId: "inc-a", taxable: false },
        { description: "B", qty: 1, unitPrice: 33.34, accountId: "inc-b", taxable: false },
      ],
    },
    zar
  );
  assert.equal(sum(lines, "debit"), sum(lines, "credit"));
  assert.equal(lines.find((l) => l.accountId === "debtors").debit, toBaseCents(66.67, 18.17));
});

test("invoice lines without a product fall back to default income", () => {
  const lines = invoiceLines(
    { currency: "ZAR", total: 50, taxTotal: 0, items: [{ description: "Ad hoc", qty: 1, unitPrice: 50 }] },
    zar
  );
  assert.ok(lines.some((l) => l.accountId === "default_income" && l.credit === 5000));
});

test("payment posts undeposited funds against debtors at the invoice rate", () => {
  const lines = paymentLines(
    { amount: 200, currency: "USD", customerId: "c1", invoiceNumber: "INV-1" },
    { currency: "USD", exchangeRate: 18, invoiceNumber: "INV-1", customerId: "c1" },
    zar
  );
  assert.equal(sum(lines, "debit"), sum(lines, "credit"));
  assert.equal(lines.find((l) => l.accountId === "undeposited_funds").debit, 360000);
  assert.equal(lines.find((l) => l.accountId === "debtors").credit, 360000);
  assert.equal(lines[0].rate, 18);
});

test("expense posts gross to the category account against 2050", () => {
  const lines = expenseLines(
    { amount: 149, currency: "ZAR", accountId: "t5200", vendor: "Afrihost" },
    zar
  );
  assert.equal(sum(lines, "debit"), 14900);
  assert.equal(lines.find((l) => l.accountId === "t5200").debit, 14900);
  assert.equal(lines.find((l) => l.accountId === "expense_clearing").credit, 14900);
});

test("foreign expense uses the document rate; missing rate is refused", () => {
  const lines = expenseLines({ amount: 100, currency: "USD", exchangeRate: 18.25, accountId: "default_expense" }, zar);
  assert.equal(lines[0].debit, toBaseCents(100, 18.25));
  assert.throws(
    () => expenseLines({ amount: 100, currency: "USD", accountId: "default_expense" }, zar),
    /exchange rate is required/
  );
});

test("reversal lines swap debit and credit and negate the foreign amount", () => {
  const lines = invoiceLines(
    { currency: "ZAR", total: 100, taxTotal: 0, items: [{ description: "x", qty: 1, unitPrice: 100, accountId: "default_income" }] },
    zar
  );
  const rev = swapLines(lines);
  assert.equal(sum(rev, "debit"), sum(rev, "credit"));
  assert.equal(rev.find((l) => l.accountId === "debtors").credit, 10000);
  assert.equal(rev.find((l) => l.accountId === "debtors").foreignAmount, -10000);
});
