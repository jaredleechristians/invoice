const test = require("node:test");
const assert = require("node:assert/strict");
const { invoiceLines, paymentLines, paymentBankLines, expenseLines, expenseBankLines, transferPairLines, transferInTransitLines, bankOpeningLines, openingBalanceLines, toBaseCents, swapLines } = require("../lib/ledger/rules");

const SYS = {
  debtors: "debtors",
  vat: "vat",
  default_income: "default_income",
  undeposited_funds: "undeposited_funds",
  expense_clearing: "expense_clearing",
  default_expense: "default_expense",
  fx: "fx",
  transfers_in_transit: "transfers_in_transit",
  opening_balance_equity: "opening_balance_equity",
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

test("bank receipt of a foreign invoice into a base-currency account posts FX to 4900", () => {
  const payment = { amount: 2000, currency: "USD", invoiceNumber: "INV-1", receivedAmount: 36500, receivedCurrency: "ZAR" };
  const invoice = { currency: "USD", exchangeRate: 18, invoiceNumber: "INV-1" };
  const ctx = { ...zar, bankLedgerAccountId: "bank_fnb", bankAccountId: "fnb", bankCurrency: "ZAR" };
  const gain = paymentBankLines(payment, invoice, ctx);
  assert.equal(gain.find((l) => l.accountId === "bank_fnb").debit, 3650000);
  assert.equal(gain.find((l) => l.accountId === "undeposited_funds").credit, 3600000);
  assert.equal(gain.find((l) => l.accountId === "fx").credit, 50000);
  const loss = paymentBankLines({ ...payment, receivedAmount: 35000 }, invoice, ctx);
  assert.equal(loss.find((l) => l.accountId === "fx").debit, 100000);
});

test("bank receipt into a same-currency foreign account has no FX", () => {
  const lines = paymentBankLines(
    { amount: 2000, currency: "USD", receivedAmount: 2000, receivedCurrency: "USD" },
    { currency: "USD", exchangeRate: 18 },
    { ...zar, bankLedgerAccountId: "bank_wise", bankAccountId: "wise", bankCurrency: "USD" }
  );
  assert.equal(lines.find((l) => l.accountId === "bank_wise").debit, 3600000);
  assert.ok(!lines.some((l) => l.accountId === "fx"));
});

test("expense bank payment from a base-currency account posts FX when the rate differs", () => {
  const expense = { amount: 100, currency: "USD", exchangeRate: 18, vendor: "AWS" };
  const tx = { amount: -1850, currency: "ZAR" };
  const lines = expenseBankLines(expense, tx, { ...zar, bankLedgerAccountId: "bank_fnb", bankAccountId: "fnb", bankCurrency: "ZAR" });
  assert.equal(lines.find((l) => l.accountId === "expense_clearing").debit, 180000);
  assert.equal(lines.find((l) => l.accountId === "bank_fnb").credit, 185000);
  assert.equal(lines.find((l) => l.accountId === "fx").debit, 5000);
});

test("paired cross-currency transfer posts average-cost FX", () => {
  const lines = transferPairLines({
    sendLedgerAccountId: "bank_wise",
    sendBankAccountId: "wise",
    sendCurrency: "USD",
    sendAmount: -2000,
    sendRate: 18,
    receiveLedgerAccountId: "bank_fnb",
    receiveBankAccountId: "fnb",
    receiveCurrency: "ZAR",
    receiveAmount: 36500,
    systemAccounts: SYS,
    baseCurrency: "ZAR",
  });
  assert.equal(lines.find((l) => l.accountId === "bank_fnb").debit, 3650000);
  assert.equal(lines.find((l) => l.accountId === "bank_wise").credit, 3600000);
  assert.equal(lines.find((l) => l.accountId === "fx").credit, 50000);
});

test("unpaired transfer posts against 1160", () => {
  const out = transferInTransitLines({
    bankLedgerAccountId: "bank_fnb",
    bankAccountId: "fnb",
    currency: "ZAR",
    amount: -5000,
    rate: 1,
    systemAccounts: SYS,
    baseCurrency: "ZAR",
  });
  assert.equal(out.find((l) => l.accountId === "transfers_in_transit").debit, 500000);
  assert.equal(out.find((l) => l.accountId === "bank_fnb").credit, 500000);
});

test("bank opening and company opening balances plug to 3200", () => {
  const bank = bankOpeningLines({
    bankLedgerAccountId: "bank_fnb",
    bankAccountId: "fnb",
    currency: "ZAR",
    openingBalance: 1000,
    rate: 1,
    systemAccounts: SYS,
    baseCurrency: "ZAR",
  });
  assert.equal(bank.find((l) => l.accountId === "bank_fnb").debit, 100000);
  assert.equal(bank.find((l) => l.accountId === "opening_balance_equity").credit, 100000);
  const opening = openingBalanceLines(
    [{ accountId: "share", debit: 0, credit: 10000, description: "Capital" }],
    zar
  );
  assert.equal(opening.find((l) => l.accountId === "share").credit, 10000);
  assert.equal(opening.find((l) => l.accountId === "opening_balance_equity").debit, 10000);
});
